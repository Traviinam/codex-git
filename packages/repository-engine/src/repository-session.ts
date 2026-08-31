import { resolve, sep } from 'node:path';

import {
  createOpaqueIdAuthority,
  type AbsolutePath,
  type BranchSearchRequest,
  type BranchSearchResult,
  type CommandEnvelope,
  type DiffResult,
  type FileId,
  type NativeTargetId,
  type OperationFailureCode,
  type OperationReceipt,
  type OperationId,
  type OperationResult,
  type RefId,
  type RemoteId,
  type RepositoryId,
} from '@codex-git/protocol';

import { InvalidationStream } from './invalidation-stream.js';
import {
  createOperationSession,
  type OperationSessionAdmission,
  type OperationSessionSummary,
} from './operation-session.js';
import type { RemoteOperationResult } from './remote-operation.js';
import type { FileMutationInspector } from './file-mutation-inspection.js';
import type {
  RepositoryInvalidation,
  RepositoryOpenResult,
  RepositoryPublicationSession,
  RepositoryRefreshScope,
  RepositorySnapshot,
  ScopedRepositoryPublicationSession,
} from './repository-publication.js';
import type { WorktreeProvenance } from './worktree-provenance.js';
import { privateWorktreeIdentityEvidence } from './observation-publication.js';

const OPERATION_TIMEOUT_MILLISECONDS = 30_000;

export interface RepositorySession extends RepositoryPublicationSession {
  fetch(request: RepositoryFetchRequest): Promise<OperationSessionAdmission>;
  diff(fileId: FileId): Promise<DiffResult>;
  resolveFileNativeTarget(targetId: NativeTargetId): Promise<FileNativeTarget>;
  resolveWorktreeNativeTarget(
    targetId: NativeTargetId,
  ): Promise<WorktreeNativeTarget>;
  searchBranches(request: BranchSearchRequest): Promise<BranchSearchResult>;
  dispatch(request: CommandEnvelope): Promise<OperationReceipt>;
  cancelOperation(operationId: OperationId): Promise<OperationResult>;
  recoverOperation(operationId: OperationId): Promise<OperationResult>;
}

export interface RepositoryFetchRequest {
  readonly repositoryId: RepositoryId;
  readonly remoteId: RemoteId | null;
  readonly expectedRefsRevision: number;
}

export type RemoteFetchResult =
  | { readonly kind: 'completed' }
  | {
      readonly kind: 'failed_known';
      readonly code: OperationFailureCode;
      readonly message: string;
    };

export interface RepositorySessionOptions {
  readonly fetchRemote?: (
    remoteName: string,
    signal: AbortSignal,
  ) => Promise<RemoteFetchResult>;
  readonly now?: () => Date;
  readonly runGit?: GitProcessRunner;
  readonly executeRemoteOperation?: (
    request: import('./remote-operation.js').RemoteOperationRequest,
    signal: AbortSignal,
  ) => Promise<import('./remote-operation.js').RemoteOperationResult>;
  readonly inspectFileMutationTargets?: FileMutationInspector;
  readonly diff?: (
    worktree: RepositorySnapshot['worktrees'][number],
    fileId: FileId,
  ) => Promise<DiffResult>;
}

type FetchEffect =
  | {
      readonly kind: 'completed';
      readonly remoteId: RemoteId;
      readonly label: string;
      readonly fetchedAt: string;
      readonly configurationEvidence: string;
    }
  | {
      readonly kind: 'failed_known';
      readonly remoteId: RemoteId;
      readonly label: string;
      readonly code: OperationFailureCode;
      readonly message: string;
      readonly configurationEvidence: string;
    };

class RemoteFetchInterrupted extends Error {
  constructor(readonly effects: readonly FetchEffect[]) {
    super('Remote Fetch execution was interrupted.');
    this.name = 'RemoteFetchInterrupted';
  }
}

export interface FileNativeTarget {
  readonly absolutePath: string | null;
  readonly canOpen: boolean;
  readonly relativePath: string;
  readonly provenance: WorktreeProvenance;
  readonly worktreePath: string;
}

export interface WorktreeNativeTarget {
  readonly absolutePath: string;
  readonly branchOrSha: string;
  readonly canLaunch: boolean;
  readonly provenance: WorktreeProvenance;
  readonly worktreePath: string;
}

export interface WorktreeNativeTarget {
  readonly worktreePath: string;
}

export interface InternalRepositorySession
  extends RepositorySession, ScopedRepositoryPublicationSession {}

export class RepositoryTargetFailure extends Error {
  readonly code = 'stale_target';

  constructor() {
    super('The Changed File target is stale or unavailable.');
    this.name = 'RepositoryTargetFailure';
  }
}

type GitProcessRunner = (
  args: readonly string[],
  allowLargeOutput: boolean,
  acceptedEmptyExitCode?: 1,
  signal?: AbortSignal,
  maximumOutputBytes?: number,
  input?: Uint8Array,
) => Promise<Uint8Array>;

interface BranchBinding {
  readonly fullName: string;
  readonly kind: 'local' | 'remote_tracking';
  readonly objectId: string;
  readonly occupiedBy: BranchSearchResult['candidates'][number]['occupiedBy'];
  readonly remoteId: RemoteId | null;
  readonly refsRevision: number;
}

type BranchSwitchEvidence =
  | {
      readonly kind: 'rejected';
      readonly result: Omit<
        Extract<OperationResult, { readonly kind: 'rejected' }>,
        'operationId'
      >;
    }
  | { readonly kind: 'attempted'; readonly displayName: string };

type RemoteCommand = Extract<
  CommandEnvelope['command'],
  { readonly kind: 'pull' | 'push' | 'publish' }
>;

type RemoteOperationEvidence =
  | {
      readonly kind: 'rejected';
      readonly result: Omit<
        Extract<OperationResult, { readonly kind: 'rejected' }>,
        'operationId'
      >;
    }
  | { readonly kind: 'no_change' }
  | {
      readonly kind: 'completed';
      readonly branchName: string;
      readonly localObjectId: string;
      readonly upstreamDisplayName: string;
    }
  | {
      readonly kind: 'failed_known';
      readonly code: OperationFailureCode;
      readonly message: string;
    }
  | {
      readonly kind: 'unknown';
      readonly branchName: string;
      readonly localObjectId: string;
      readonly upstreamDisplayName: string;
    }
  | {
      readonly kind: 'publish_unconfigured';
      readonly branchName: string;
      readonly localObjectId: string;
      readonly remoteName: string;
      readonly trackingRef: string;
    };

export function createRepositorySession(
  delegate: ScopedRepositoryPublicationSession,
  options: RepositorySessionOptions = {},
): InternalRepositorySession {
  const branchIds = createOpaqueIdAuthority();
  const branchBindings = new Map<RefId, BranchBinding>();
  const invalidations = new InvalidationStream<RepositoryInvalidation>();
  const operationSummaries = new Map<OperationId, OperationSessionSummary>();
  let closed = false;
  let latestBase: RepositorySnapshot | undefined;
  let latestBaseRevision = 0;
  let latest: RepositorySnapshot | undefined;
  let repositoryRevision = 0;
  let operationEvidence = '[]';
  let postOperationRefresh: Promise<void> | undefined;
  let latestSuccessfulFetchAt: string | null = null;
  const remoteFetches = new Map<RemoteId, string>();
  let fetch = latest?.fetch ?? ({ kind: 'never' } as const);

  const publishCurrent = (base: RepositorySnapshot): RepositorySnapshot => {
    const operations = [...operationSummaries.values()];
    const nextOperationEvidence = JSON.stringify(operations);
    const changed =
      latest === undefined ||
      base.repositoryRevision !== latestBaseRevision ||
      nextOperationEvidence !== operationEvidence;
    if (!changed) return latest as RepositorySnapshot;
    repositoryRevision = latest === undefined ? 1 : repositoryRevision + 1;
    latestBaseRevision = base.repositoryRevision;
    operationEvidence = nextOperationEvidence;
    latest = deepFreeze({
      ...base,
      repositoryRevision,
      fetch,
      remoteFetches: base.remotes.flatMap(({ remoteId }) => {
        const fetchedAt = remoteFetches.get(remoteId);
        return fetchedAt === undefined ? [] : [{ remoteId, fetchedAt }];
      }),
      operations,
    });
    invalidations.publish({
      kind: 'repository',
      repositoryRevision,
      refresh: latest.refresh,
    });
    return latest;
  };

  const observe = async (
    request: () => Promise<RepositoryOpenResult>,
  ): Promise<RepositoryOpenResult> => {
    const result = await request();
    if (result.kind !== 'repository') return result;
    latestBase = result.repository;
    return { kind: 'repository', repository: publishCurrent(latestBase) };
  };

  const schedulePostOperationRefresh = () => {
    if (closed || postOperationRefresh !== undefined) return;
    postOperationRefresh = observe(() => delegate.requestRefresh())
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        postOperationRefresh = undefined;
      });
  };

  const operations = createOperationSession({
    operationTimeoutMilliseconds: OPERATION_TIMEOUT_MILLISECONDS,
    publish(summary) {
      invalidations.publish({ kind: 'operation', operation: summary });
      operationSummaries.set(summary.operationId, summary);
      if (latestBase !== undefined) publishCurrent(latestBase);
      if (summary.phase === 'terminal') schedulePostOperationRefresh();
    },
  });

  const reconcileRemoteTracking = async (request: {
    readonly worktreePath: AbsolutePath;
    readonly remoteName: string;
    readonly remoteBranchRef: string;
    readonly trackingRef: string;
  }): Promise<RemoteOperationResult> => {
    if (options.executeRemoteOperation === undefined) {
      return unknownRemoteReconciliation();
    }
    try {
      return await options.executeRemoteOperation(
        { kind: 'refresh_tracking', ...request },
        AbortSignal.timeout(10_000),
      );
    } catch {
      return unknownRemoteReconciliation();
    }
  };

  const dispatchRemoteCommand = async (
    command: RemoteCommand,
  ): Promise<OperationSessionAdmission> => {
    const initial = latestBase?.worktrees.find(
      ({ worktreeId }) => worktreeId === command.worktreeId,
    );
    if (initial === undefined) {
      throw new Error('Remote operations require a current Worktree snapshot.');
    }
    if (command.kind === 'publish') {
      if (
        initial.head.kind !== 'local_branch' ||
        initial.head.objectId === null ||
        initial.upstream.kind !== 'unpublished'
      ) {
        throw new Error('Publish requires an Unpublished Local Branch.');
      }
      const initialHead = initial.head;
      const initialObjectId = initialHead.objectId;
      if (initialObjectId === null) {
        throw new Error('Publish requires a committed Local Branch.');
      }
      const initialRemote = latestBase?.remotes.find(
        ({ remoteId }) => remoteId === command.remoteId,
      );
      if (initialRemote === undefined) {
        throw new Error('Publish requires an exact configured Remote.');
      }
      const destinationRef = initialHead.fullName;
      const trackingRef = `refs/remotes/${initialRemote.displayName}/${initialHead.displayName}`;
      return operations.dispatch({
        kind: 'publish',
        worktreeGeneration: initial.generation,
        localBranchRef: initialHead.fullName,
        destinationRef,
        remoteId: initialRemote.remoteId,
        async reconcileBusy() {
          await observe(() => delegate.requestRefresh()).catch(() => undefined);
        },
        async execute({ signal }): Promise<RemoteOperationEvidence> {
          const current = await observe(() => delegate.requestRefresh()).catch(
            () => undefined,
          );
          if (current?.kind !== 'repository') {
            return reject('stale', 'The Repository is no longer available.');
          }
          const repository = current.repository;
          const worktree = repository.worktrees.find(
            ({ worktreeId }) => worktreeId === command.worktreeId,
          );
          const remote = repository.remotes.find(
            ({ remoteId }) => remoteId === command.remoteId,
          );
          if (
            repository.refsRevision !== command.expectedRefsRevision ||
            worktree === undefined ||
            worktree.worktreeRevision !== command.expectedWorktreeRevision ||
            worktree.head.kind !== 'local_branch' ||
            worktree.head.fullName !== initialHead.fullName ||
            worktree.head.objectId !== initialHead.objectId ||
            worktree.upstream.kind !== 'unpublished' ||
            remote?.displayName !== initialRemote.displayName
          ) {
            return reject(
              'stale',
              'Worktree, Branch, Remote, or publication state changed; refresh and confirm again.',
            );
          }
          if (
            worktree.availability.kind !== 'available' ||
            worktree.canonicalPath === null ||
            worktree.freshness.kind !== 'fresh' ||
            worktree.status === null ||
            worktree.status.conflicted !== 0 ||
            worktree.status.inProgressOperation !== undefined ||
            worktree.gitLock.kind !== 'unlocked'
          ) {
            return reject(
              'precondition_failed',
              'Publish requires an available Local Branch with no Conflict or Git operation.',
            );
          }
          if (options.executeRemoteOperation === undefined) {
            return reject(
              'unsupported_state',
              'Publish is unavailable in this Repository Session.',
            );
          }
          const pushed = await options.executeRemoteOperation(
            {
              kind: 'push',
              worktreePath: worktree.canonicalPath,
              remoteName: remote.displayName,
              localBranchRef: initialHead.fullName,
              destinationRef,
            },
            signal,
          );
          if (pushed.kind === 'failed_known') return pushed;
          const unknownEvidence: Extract<
            RemoteOperationEvidence,
            { readonly kind: 'unknown' }
          > = {
            kind: 'unknown',
            branchName: initialHead.displayName,
            localObjectId: initialObjectId,
            upstreamDisplayName: `${remote.displayName}/${initialHead.displayName}`,
          };
          const publicationEvidence: Extract<
            RemoteOperationEvidence,
            { readonly kind: 'publish_unconfigured' }
          > = {
            kind: 'publish_unconfigured',
            branchName: initialHead.displayName,
            localObjectId: initialObjectId,
            remoteName: remote.displayName,
            trackingRef,
          };
          const trackingReconciliation = await reconcileRemoteTracking({
            worktreePath: worktree.canonicalPath,
            remoteName: remote.displayName,
            remoteBranchRef: destinationRef,
            trackingRef,
          });
          if (trackingReconciliation.kind !== 'completed') {
            return unknownEvidence;
          }
          const pushedState = await observe(() =>
            delegate.requestRefresh(),
          ).catch(() => undefined);
          if (
            pushedState?.kind !== 'repository' ||
            pushedState.repository.refs.find(
              ({ fullName }) => fullName === trackingRef,
            )?.objectId !== initialHead.objectId
          ) {
            return publicationEvidence;
          }
          if (options.runGit === undefined) return publicationEvidence;
          try {
            await options.runGit(
              [
                '-C',
                worktree.canonicalPath,
                'branch',
                `--set-upstream-to=${trackingRef}`,
                '--',
                initialHead.displayName,
              ],
              false,
              undefined,
              signal,
            );
          } catch {
            return publicationEvidence;
          }
          return {
            kind: 'completed',
            branchName: initialHead.displayName,
            localObjectId: initialObjectId,
            upstreamDisplayName: `${remote.displayName}/${initialHead.displayName}`,
          };
        },
        async reconcile(context) {
          const evidence =
            context.execution.kind === 'returned'
              ? (context.execution.evidence as RemoteOperationEvidence)
              : undefined;
          if (evidence?.kind === 'rejected') return evidence.result;
          const trackingReconciliation =
            evidence?.kind === 'no_change'
              ? null
              : await reconcileRemoteTracking({
                  worktreePath: initial.canonicalPath!,
                  remoteName: initialRemote.displayName,
                  remoteBranchRef: destinationRef,
                  trackingRef,
                });
          if (
            trackingReconciliation !== null &&
            trackingReconciliation.kind !== 'completed'
          ) {
            return unknownRemoteOutcome();
          }
          const reconciled = await observe(() =>
            delegate.requestRefresh(),
          ).catch(() => undefined);
          if (
            reconciled?.kind !== 'repository' ||
            reconciled.repository.refresh.kind !== 'fresh'
          ) {
            return unknownRemoteOutcome();
          }
          if (evidence?.kind === 'no_change') {
            return { kind: 'succeeded', result: { kind: 'no_change' } };
          }
          const worktree = reconciled.repository.worktrees.find(
            ({ worktreeId }) => worktreeId === command.worktreeId,
          );
          const branchName = initialHead.displayName;
          const localObjectId = initialObjectId;
          const remoteName =
            evidence?.kind === 'publish_unconfigured'
              ? evidence.remoteName
              : initialRemote.displayName;
          const observedTrackingRef =
            evidence?.kind === 'publish_unconfigured'
              ? evidence.trackingRef
              : trackingRef;
          const remotePublished =
            reconciled.repository.refs.find(
              ({ fullName }) => fullName === observedTrackingRef,
            )?.objectId === localObjectId;
          if (
            remotePublished &&
            worktree?.head.kind === 'local_branch' &&
            worktree.head.fullName === initialHead.fullName &&
            worktree.head.objectId === localObjectId &&
            worktree.upstream.kind === 'tracking' &&
            worktree.upstream.remoteId === initialRemote.remoteId &&
            worktree.upstream.ref.fullName === observedTrackingRef &&
            worktree.upstream.ref.objectId === localObjectId
          ) {
            return {
              kind: 'succeeded',
              result: {
                kind: 'remote',
                summary: `Published ${branchName} to ${remoteName}.`,
              },
            };
          }
          if (remotePublished) {
            return {
              kind: 'partial_success',
              message:
                'The Branch was published, but its Upstream was not configured.',
              effects: [
                { kind: 'succeeded', label: `Published ${branchName}` },
                {
                  kind: 'failed_known',
                  label: 'Configure Upstream',
                  code: 'process_failed',
                  message: 'Git could not configure the Local Branch Upstream.',
                },
              ],
            };
          }
          if (evidence?.kind === 'failed_known') return evidence;
          if (context.execution.kind !== 'returned' || evidence === undefined) {
            return unknownRemoteOutcome();
          }
          return unknownRemoteOutcome();
        },
      });
    }
    if (command.kind === 'push') {
      if (
        initial.head.kind !== 'local_branch' ||
        initial.upstream.kind !== 'tracking'
      ) {
        throw new Error('Push requires a Local Branch with an exact Upstream.');
      }
      const initialHead = initial.head;
      const expectedUpstream = initial.upstream;
      const configuredUpstream = await readConfiguredUpstreamTarget(
        initial,
        options.runGit,
      );
      const initialRemote = latestBase?.remotes.find(
        ({ remoteId, displayName }) =>
          remoteId === expectedUpstream.remoteId &&
          displayName === configuredUpstream?.remoteName,
      );
      const destinationRef = configuredUpstream?.mergeRef ?? null;
      if (initialRemote === undefined || destinationRef === null) {
        throw new Error(
          'Push requires an exact configured Remote destination.',
        );
      }
      return operations.dispatch({
        kind: 'push',
        worktreeGeneration: initial.generation,
        localBranchRef: initialHead.fullName,
        destinationRef,
        remoteId: expectedUpstream.remoteId,
        async reconcileBusy() {
          await observe(() => delegate.requestRefresh()).catch(() => undefined);
        },
        async execute({ signal }): Promise<RemoteOperationEvidence> {
          const current = await observe(() => delegate.requestRefresh()).catch(
            () => undefined,
          );
          if (current?.kind !== 'repository') {
            return reject('stale', 'The Repository is no longer available.');
          }
          const repository = current.repository;
          const worktree = repository.worktrees.find(
            ({ worktreeId }) => worktreeId === command.worktreeId,
          );
          const remote = repository.remotes.find(
            ({ remoteId }) => remoteId === expectedUpstream.remoteId,
          );
          if (
            repository.refsRevision !== command.expectedRefsRevision ||
            worktree === undefined ||
            worktree.worktreeRevision !== command.expectedWorktreeRevision ||
            worktree.head.kind !== 'local_branch' ||
            worktree.head.fullName !== initialHead.fullName ||
            worktree.head.objectId !== initialHead.objectId ||
            worktree.upstream.kind !== 'tracking' ||
            worktree.upstream.remoteId !== expectedUpstream.remoteId ||
            worktree.upstream.ref.fullName !== expectedUpstream.ref.fullName ||
            worktree.upstream.ref.objectId !== expectedUpstream.ref.objectId ||
            remote?.displayName !== initialRemote.displayName
          ) {
            return reject(
              'stale',
              'Worktree, Branch, or Upstream state changed; refresh and try again.',
            );
          }
          const currentConfiguredUpstream = await readConfiguredUpstreamTarget(
            worktree,
            options.runGit,
          ).catch(() => null);
          if (
            currentConfiguredUpstream?.remoteName !==
              configuredUpstream?.remoteName ||
            currentConfiguredUpstream?.mergeRef !== configuredUpstream?.mergeRef
          ) {
            return reject(
              'stale',
              'The configured Upstream target changed; refresh and try again.',
            );
          }
          if (
            worktree.availability.kind !== 'available' ||
            worktree.canonicalPath === null ||
            worktree.freshness.kind !== 'fresh' ||
            worktree.status === null ||
            worktree.status.conflicted !== 0 ||
            worktree.status.inProgressOperation !== undefined ||
            worktree.gitLock.kind !== 'unlocked'
          ) {
            return reject(
              'precondition_failed',
              'Push requires an available Local Branch with no Conflict or Git operation.',
            );
          }
          if (worktree.upstream.aheadBehind.kind !== 'cached') {
            return reject(
              'precondition_failed',
              'Push requires current cached Upstream divergence.',
            );
          }
          if (worktree.upstream.aheadBehind.behind > 0) {
            return reject(
              'precondition_failed',
              'The Local Branch is behind or diverged from its Upstream. Pull or reconcile it first.',
            );
          }
          if (worktree.upstream.aheadBehind.ahead === 0) {
            return { kind: 'no_change' };
          }
          if (options.executeRemoteOperation === undefined) {
            return reject(
              'unsupported_state',
              'Push is unavailable in this Repository Session.',
            );
          }
          const result = await options.executeRemoteOperation(
            {
              kind: 'push',
              worktreePath: worktree.canonicalPath,
              remoteName: remote.displayName,
              localBranchRef: initialHead.fullName,
              destinationRef,
            },
            signal,
          );
          return result.kind === 'completed'
            ? {
                kind: 'completed',
                branchName: initialHead.displayName,
                localObjectId: initialHead.objectId!,
                upstreamDisplayName: expectedUpstream.displayName,
              }
            : result.kind === 'failed_known'
              ? result
              : {
                  kind: 'unknown',
                  branchName: initialHead.displayName,
                  localObjectId: initialHead.objectId!,
                  upstreamDisplayName: expectedUpstream.displayName,
                };
        },
        async reconcile(context) {
          const evidence =
            context.execution.kind === 'returned'
              ? (context.execution.evidence as RemoteOperationEvidence)
              : undefined;
          if (evidence?.kind === 'rejected') return evidence.result;
          const trackingReconciliation =
            evidence?.kind === 'no_change'
              ? null
              : await reconcileRemoteTracking({
                  worktreePath: initial.canonicalPath!,
                  remoteName: initialRemote.displayName,
                  remoteBranchRef: destinationRef,
                  trackingRef: expectedUpstream.ref.fullName,
                });
          if (
            trackingReconciliation !== null &&
            trackingReconciliation.kind !== 'completed'
          ) {
            return unknownRemoteOutcome();
          }
          const reconciled = await observe(() =>
            delegate.requestRefresh(),
          ).catch(() => undefined);
          if (
            reconciled?.kind !== 'repository' ||
            reconciled.repository.refresh.kind !== 'fresh'
          ) {
            return unknownRemoteOutcome();
          }
          if (evidence?.kind === 'no_change') {
            return { kind: 'succeeded', result: { kind: 'no_change' } };
          }
          const worktree = reconciled.repository.worktrees.find(
            ({ worktreeId }) => worktreeId === command.worktreeId,
          );
          if (
            worktree?.head.kind === 'local_branch' &&
            worktree.head.fullName === initialHead.fullName &&
            worktree.head.objectId === initialHead.objectId &&
            worktree.upstream.kind === 'tracking' &&
            worktree.upstream.displayName === expectedUpstream.displayName &&
            worktree.upstream.ref.objectId === initialHead.objectId &&
            worktree.upstream.aheadBehind.kind === 'cached' &&
            worktree.upstream.aheadBehind.ahead === 0 &&
            worktree.upstream.aheadBehind.behind === 0
          ) {
            return {
              kind: 'succeeded',
              result: {
                kind: 'remote',
                summary: `Pushed ${initialHead.displayName}.`,
              },
            };
          }
          if (evidence?.kind === 'failed_known') return evidence;
          return unknownRemoteOutcome();
        },
      });
    }
    if (command.kind !== 'pull') throw new Error('Unsupported Remote command.');
    if (initial.head.kind !== 'local_branch') {
      throw new Error('Pull requires a Local Branch.');
    }
    const initialHead = initial.head;
    if (initial.upstream.kind !== 'tracking') {
      throw new Error('Pull requires an exact configured Upstream.');
    }
    const expectedUpstream = initial.upstream;
    const configuredUpstream = await readConfiguredUpstreamTarget(
      initial,
      options.runGit,
    );
    const initialRemote = latestBase?.remotes.find(
      ({ remoteId, displayName }) =>
        remoteId === expectedUpstream.remoteId &&
        displayName === configuredUpstream?.remoteName,
    );
    if (configuredUpstream === null || initialRemote === undefined) {
      throw new Error('Pull requires an exact configured Upstream target.');
    }
    return operations.dispatch({
      kind: 'pull',
      worktreeGeneration: initial.generation,
      localBranchRef: initialHead.fullName,
      upstreamRef: configuredUpstream.mergeRef,
      remoteId: expectedUpstream.remoteId,
      async reconcileBusy() {
        await observe(() => delegate.requestRefresh()).catch(() => undefined);
      },
      async execute({ signal }): Promise<RemoteOperationEvidence> {
        const current = await observe(() => delegate.requestRefresh()).catch(
          () => undefined,
        );
        if (current?.kind !== 'repository') {
          return reject('stale', 'The Repository is no longer available.');
        }
        const repository = current.repository;
        const worktree = repository.worktrees.find(
          ({ worktreeId }) => worktreeId === command.worktreeId,
        );
        if (
          repository.refsRevision !== command.expectedRefsRevision ||
          worktree === undefined ||
          worktree.worktreeRevision !== command.expectedWorktreeRevision ||
          worktree.head.kind !== 'local_branch' ||
          worktree.head.fullName !== initialHead.fullName ||
          worktree.head.objectId !== initialHead.objectId ||
          worktree.upstream.kind !== 'tracking' ||
          worktree.upstream.remoteId !== expectedUpstream.remoteId ||
          worktree.upstream.ref.fullName !== expectedUpstream.ref.fullName ||
          worktree.upstream.ref.objectId !== expectedUpstream.ref.objectId
        ) {
          return reject(
            'stale',
            'Worktree, Branch, or Upstream state changed; refresh and try again.',
          );
        }
        const currentConfiguredUpstream = await readConfiguredUpstreamTarget(
          worktree,
          options.runGit,
        ).catch(() => null);
        if (
          currentConfiguredUpstream?.remoteName !==
            configuredUpstream.remoteName ||
          currentConfiguredUpstream?.mergeRef !== configuredUpstream.mergeRef
        ) {
          return reject(
            'stale',
            'The configured Upstream target changed; refresh and try again.',
          );
        }
        if (
          worktree.availability.kind !== 'available' ||
          worktree.canonicalPath === null ||
          worktree.freshness.kind !== 'fresh' ||
          worktree.status?.clean !== true ||
          worktree.status.conflicted !== 0 ||
          worktree.status.inProgressOperation !== undefined ||
          worktree.index?.locked !== false ||
          worktree.gitLock.kind !== 'unlocked'
        ) {
          return reject(
            'precondition_failed',
            'Pull requires a clean, available Worktree with no Git operation or lock.',
          );
        }
        if (worktree.upstream.aheadBehind.kind !== 'cached') {
          return reject(
            'precondition_failed',
            'Pull requires current cached Upstream divergence.',
          );
        }
        const { ahead, behind } = worktree.upstream.aheadBehind;
        if (ahead > 0 && behind > 0) {
          return reject(
            'precondition_failed',
            'The Local Branch and Upstream diverged. Open Terminal to Merge or Rebase explicitly.',
          );
        }
        if (behind === 0) return { kind: 'no_change' };
        const currentUpstream = worktree.upstream;
        const remote = repository.remotes.find(
          ({ remoteId, displayName }) =>
            remoteId === currentUpstream.remoteId &&
            displayName === configuredUpstream.remoteName,
        );
        const remoteBranchRef = configuredUpstream.mergeRef;
        if (
          remote === undefined ||
          remoteBranchRef === null ||
          options.executeRemoteOperation === undefined
        ) {
          return reject(
            'unsupported_state',
            'The exact Pull target is unavailable in this Repository Session.',
          );
        }
        const result = await options.executeRemoteOperation(
          {
            kind: 'pull',
            worktreePath: worktree.canonicalPath,
            remoteName: remote.displayName,
            remoteBranchRef,
          },
          signal,
        );
        return result.kind === 'completed'
          ? {
              kind: 'completed',
              branchName: worktree.head.displayName,
              localObjectId: worktree.head.objectId!,
              upstreamDisplayName: currentUpstream.displayName,
            }
          : result.kind === 'failed_known'
            ? result
            : {
                kind: 'unknown',
                branchName: worktree.head.displayName,
                localObjectId: worktree.head.objectId!,
                upstreamDisplayName: currentUpstream.displayName,
              };
      },
      async reconcile(context) {
        const evidence =
          context.execution.kind === 'returned'
            ? (context.execution.evidence as RemoteOperationEvidence)
            : undefined;
        if (evidence?.kind === 'rejected') return evidence.result;
        if (evidence?.kind === 'no_change') {
          await observe(() => delegate.requestRefresh()).catch(() => undefined);
          return { kind: 'succeeded', result: { kind: 'no_change' } };
        }
        const trackingReconciliation = await reconcileRemoteTracking({
          worktreePath: initial.canonicalPath!,
          remoteName: initialRemote.displayName,
          remoteBranchRef: configuredUpstream.mergeRef,
          trackingRef: expectedUpstream.ref.fullName,
        });
        if (trackingReconciliation.kind !== 'completed') {
          return unknownRemoteOutcome();
        }
        const reconciled = await observe(() => delegate.requestRefresh()).catch(
          () => undefined,
        );
        if (
          reconciled?.kind !== 'repository' ||
          reconciled.repository.refresh.kind !== 'fresh'
        ) {
          return unknownRemoteOutcome();
        }
        const worktree = reconciled.repository.worktrees.find(
          ({ worktreeId }) => worktreeId === command.worktreeId,
        );
        if (
          worktree?.head.kind === 'local_branch' &&
          worktree.head.fullName === initialHead.fullName &&
          worktree.upstream.kind === 'tracking' &&
          worktree.upstream.displayName === expectedUpstream.displayName &&
          worktree.head.objectId === worktree.upstream.ref.objectId &&
          worktree.upstream.aheadBehind.kind === 'cached' &&
          worktree.upstream.aheadBehind.ahead === 0 &&
          worktree.upstream.aheadBehind.behind === 0
        ) {
          return {
            kind: 'succeeded',
            result: {
              kind: 'remote',
              summary: `Pulled ${initialHead.displayName}.`,
            },
          };
        }
        if (evidence?.kind === 'failed_known') return evidence;
        return unknownRemoteOutcome();
      },
    });
  };

  return {
    snapshot: () => observe(() => delegate.snapshot()),
    requestRefresh: () => observe(() => delegate.requestRefresh()),
    requestScopedRefresh: (scope: RepositoryRefreshScope) =>
      observe(() => delegate.requestScopedRefresh(scope)),
    subscribe: () => invalidations.subscribe(),
    async fetch(request) {
      const remoteIds =
        request.remoteId === null
          ? latestBase?.remotes.map(({ remoteId }) => remoteId)
          : [request.remoteId];
      if (remoteIds === undefined || remoteIds.length === 0) {
        throw new Error('Fetch requires at least one configured Remote.');
      }
      const firstRemoteId = remoteIds[0];
      if (firstRemoteId === undefined) {
        throw new Error('Fetch requires at least one configured Remote.');
      }
      return operations.dispatch({
        kind: 'fetch',
        remoteIds: [firstRemoteId, ...remoteIds.slice(1)],
        async reconcileBusy() {
          await observe(() => delegate.requestRefresh());
        },
        async execute({ signal }) {
          const observed = await observe(() => delegate.requestRefresh());
          if (observed.kind !== 'repository') {
            return {
              kind: 'rejected' as const,
              message: 'The Repository is no longer available.',
            };
          }
          if (
            observed.repository.repositoryId !== request.repositoryId ||
            observed.repository.refsRevision !== request.expectedRefsRevision
          ) {
            return {
              kind: 'rejected' as const,
              message: 'Repository refs or Remote configuration changed.',
            };
          }
          const selected = remoteIds.map((remoteId) => ({
            remoteId,
            remote: observed.repository.remotes.find(
              (candidate) => candidate.remoteId === remoteId,
            ),
          }));
          if (selected.some(({ remote }) => remote === undefined)) {
            return {
              kind: 'rejected' as const,
              message: 'The selected Remote is no longer configured.',
            };
          }
          if (options.fetchRemote === undefined) {
            return {
              kind: 'rejected' as const,
              message: 'Fetch is unavailable in this Repository Session.',
            };
          }
          const effects: FetchEffect[] = [];
          for (const { remote } of selected) {
            try {
              const result = await options.fetchRemote(
                remote!.displayName,
                signal,
              );
              effects.push(
                result.kind === 'completed'
                  ? {
                      kind: result.kind,
                      remoteId: remote!.remoteId,
                      label: remote!.displayName,
                      configurationEvidence: remote!.configurationEvidence,
                      fetchedAt: (
                        options.now ?? (() => new Date())
                      )().toISOString(),
                    }
                  : {
                      ...result,
                      remoteId: remote!.remoteId,
                      label: remote!.displayName,
                      configurationEvidence: remote!.configurationEvidence,
                    },
              );
            } catch {
              if (signal.aborted) {
                throw new RemoteFetchInterrupted(effects);
              }
              effects.push({
                kind: 'failed_known',
                remoteId: remote!.remoteId,
                label: remote!.displayName,
                configurationEvidence: remote!.configurationEvidence,
                code: 'process_failed',
                message: 'Git could not Fetch the Remote.',
              });
            }
          }
          return { kind: 'attempted' as const, effects };
        },
        async reconcile(context) {
          const reconciled = await observe(() => delegate.requestRefresh());
          if (
            reconciled.kind !== 'repository' ||
            reconciled.repository.refresh.kind !== 'fresh'
          ) {
            return {
              kind: 'unknown_outcome',
              code: 'reconciliation_incomplete',
              message: 'Fresh Repository state could not be established.',
              recoveryAvailable: true,
            };
          }
          const effects =
            context.execution.kind === 'returned' &&
            context.execution.evidence.kind === 'attempted'
              ? context.execution.evidence.effects
              : context.execution.kind === 'threw' &&
                  context.execution.error instanceof RemoteFetchInterrupted
                ? context.execution.error.effects
                : [];
          const completed = effects.filter(
            (effect): effect is Extract<FetchEffect, { kind: 'completed' }> =>
              effect.kind === 'completed',
          );
          if (
            effects.some(
              (effect) =>
                !reconciled.repository.remotes.some(
                  (remote) =>
                    remote.remoteId === effect.remoteId &&
                    remote.displayName === effect.label &&
                    remote.configurationEvidence ===
                      effect.configurationEvidence,
                ),
            )
          ) {
            return {
              kind: 'unknown_outcome',
              code: 'reconciliation_incomplete',
              message: 'Remote configuration changed during Fetch.',
              recoveryAvailable: true,
            };
          }
          for (const effect of completed) {
            remoteFetches.set(effect.remoteId, effect.fetchedAt);
          }
          if (completed.length > 0) {
            latestSuccessfulFetchAt = completed
              .map(({ fetchedAt }) => fetchedAt)
              .sort()
              .at(-1)!;
          }
          if (context.execution.kind === 'threw') {
            fetch = {
              kind: completed.length === 0 ? 'failed' : 'stale',
              fetchedAt: latestSuccessfulFetchAt,
              message:
                completed.length === 0
                  ? 'Fetch could not be completed.'
                  : 'Fetch was interrupted after updating some Remotes.',
            };
            publishCurrent(reconciled.repository);
            if (context.execution.error instanceof RemoteFetchInterrupted) {
              return {
                kind: 'unknown_outcome',
                code: 'reconciliation_incomplete',
                message:
                  'Interrupted Fetch effects could not be fully established.',
                recoveryAvailable: true,
              };
            }
            return {
              kind: 'failed_known',
              code: 'process_failed',
              message: 'Fetch could not be completed.',
            };
          }
          if (context.execution.kind !== 'returned') {
            return {
              kind: 'unknown_outcome',
              code: 'reconciliation_incomplete',
              message: 'Fetch completion could not be established.',
              recoveryAvailable: true,
            };
          }
          const evidence = context.execution.evidence;
          if (evidence.kind === 'rejected') {
            return {
              kind: 'rejected',
              code: 'stale',
              message: evidence.message,
            };
          }
          const successful = evidence.effects.filter(
            ({ kind }) => kind === 'completed',
          );
          const failures = evidence.effects.filter(
            (
              effect,
            ): effect is Extract<
              (typeof evidence.effects)[number],
              { kind: 'failed_known' }
            > => effect.kind === 'failed_known',
          );
          fetch =
            failures.length === 0
              ? {
                  kind: 'current',
                  fetchedAt: latestSuccessfulFetchAt!,
                }
              : successful.length === 0
                ? {
                    kind: 'failed',
                    fetchedAt: latestSuccessfulFetchAt,
                    message:
                      failures.length === 1
                        ? failures[0]!.message
                        : 'Every Remote Fetch failed.',
                  }
                : {
                    kind: 'stale',
                    fetchedAt: latestSuccessfulFetchAt,
                    message: 'Some Remotes could not be fetched.',
                  };
          publishCurrent(reconciled.repository);
          if (failures.length === 0) {
            return {
              kind: 'succeeded',
              result: {
                kind: 'remote',
                summary:
                  successful.length === 1
                    ? `Fetched ${successful[0]!.label}.`
                    : `Fetched ${successful.length} Remotes.`,
              },
            };
          }
          if (successful.length === 0) {
            const first = failures[0]!;
            return {
              kind: 'failed_known',
              code: first.code,
              message: first.message,
              effects:
                failures.length > 1
                  ? failures.map((effect) => ({
                      kind: effect.kind,
                      label: effect.label,
                      code: effect.code,
                      message: effect.message,
                    }))
                  : undefined,
            };
          }
          return {
            kind: 'partial_success',
            message: 'Some Remotes were fetched.',
            effects: evidence.effects.map((effect) =>
              effect.kind === 'completed'
                ? { kind: 'succeeded' as const, label: effect.label }
                : {
                    kind: effect.kind,
                    label: effect.label,
                    code: effect.code,
                    message: effect.message,
                  },
            ),
          };
        },
      });
    },
    async diff(fileId) {
      const result = await observe(() => delegate.requestRefresh());
      if (result.kind !== 'repository' || options.diff === undefined) {
        throw new RepositoryTargetFailure();
      }
      const worktree = result.repository.worktrees.find(({ changes }) =>
        changes.some((change) => change.fileId === fileId),
      );
      if (worktree === undefined) {
        throw new RepositoryTargetFailure();
      }
      return options.diff(worktree, fileId);
    },
    async resolveFileNativeTarget(targetId) {
      const result = await observe(() => delegate.requestRefresh());
      if (result.kind !== 'repository') throw new RepositoryTargetFailure();
      for (const worktree of result.repository.worktrees) {
        const change = worktree.changes.find(
          (candidate) => candidate.nativeTargetId === targetId,
        );
        if (change === undefined || worktree.canonicalPath === null) continue;
        let relativePath: string;
        try {
          relativePath = new TextDecoder('utf-8', { fatal: true }).decode(
            change.pathBytes,
          );
        } catch {
          return {
            absolutePath: null,
            canOpen: false,
            relativePath: escapedBytePath(change.pathBytes),
            provenance: worktree.provenance,
            worktreePath: worktree.canonicalPath,
          };
        }
        const absolutePath = resolve(worktree.canonicalPath, relativePath);
        if (
          absolutePath !== worktree.canonicalPath &&
          absolutePath.startsWith(`${worktree.canonicalPath}${sep}`)
        ) {
          return {
            absolutePath,
            canOpen: change.workingFilePresent,
            relativePath,
            provenance: worktree.provenance,
            worktreePath: worktree.canonicalPath,
          };
        }
        throw new RepositoryTargetFailure();
      }
      throw new RepositoryTargetFailure();
    },
    async resolveWorktreeNativeTarget(targetId) {
      const result = await observe(() => delegate.requestRefresh());
      if (result.kind !== 'repository') throw new RepositoryTargetFailure();
      const worktree = result.repository.worktrees.find(
        (candidate) => candidate.nativeTargetId === targetId,
      );
      if (worktree === undefined) throw new RepositoryTargetFailure();
      const branchOrSha =
        worktree.head.kind === 'local_branch'
          ? worktree.head.displayName
          : worktree.head.objectId;
      const worktreePath = worktree.canonicalPath ?? worktree.displayPath;
      return {
        absolutePath: worktreePath,
        branchOrSha,
        canLaunch:
          worktree.canonicalPath !== null &&
          worktree.availability.kind === 'available',
        provenance: worktree.provenance,
        worktreePath,
      };
    },
    async searchBranches(request) {
      const observed = await observe(() => delegate.requestRefresh());
      if (observed.kind !== 'repository') {
        throw new Error('Branch search requires an open Repository.');
      }
      const repository = observed.repository;
      if (
        !repository.worktrees.some(
          ({ worktreeId }) => worktreeId === request.worktreeId,
        )
      ) {
        throw new Error('Branch search named a stale Worktree.');
      }
      const occupancy = new Map(
        repository.worktrees.flatMap((worktree) =>
          worktree.head.kind === 'local_branch'
            ? [[worktree.head.fullName, worktree.worktreeId] as const]
            : [],
        ),
      );
      const query = request.query.trim().toLocaleLowerCase();
      const selectedWorktree = repository.worktrees.find(
        ({ worktreeId }) => worktreeId === request.worktreeId,
      );
      const warning = await detachedHeadWarning(
        selectedWorktree,
        options.runGit,
      );
      branchBindings.clear();
      return {
        refsRevision: repository.refsRevision,
        candidates: repository.refs
          .map((ref) => {
            const refId = branchIds.issue('ref');
            const remote =
              ref.kind === 'remote_tracking'
                ? repository.remotes
                    .toSorted(
                      (left, right) =>
                        right.displayName.length - left.displayName.length,
                    )
                    .find(({ displayName }) =>
                      ref.fullName.startsWith(`refs/remotes/${displayName}/`),
                    )
                : undefined;
            const occupiedBy =
              ref.kind === 'local'
                ? (occupancy.get(ref.fullName) ?? null)
                : null;
            branchBindings.set(refId, {
              ...ref,
              occupiedBy,
              remoteId: remote?.remoteId ?? null,
              refsRevision: repository.refsRevision,
            });
            return {
              refId,
              kind: ref.kind,
              displayName:
                ref.kind === 'local'
                  ? ref.fullName.slice('refs/heads/'.length)
                  : ref.fullName.slice('refs/remotes/'.length),
              occupiedBy,
              warning,
            };
          })
          .filter(
            ({ refId, kind }) =>
              kind === 'local' || branchBindings.get(refId)?.remoteId !== null,
          )
          .filter(
            ({ displayName }) =>
              query.length === 0 ||
              displayName.toLocaleLowerCase().includes(query),
          )
          .slice(0, 5_000),
      };
    },
    async dispatch(request) {
      if (
        request.command.kind === 'pull' ||
        request.command.kind === 'push' ||
        request.command.kind === 'publish'
      ) {
        const admission = await dispatchRemoteCommand(request.command);
        if (admission.kind === 'closed') {
          throw new Error('The Repository Session is closed.');
        }
        return {
          operationId:
            admission.kind === 'accepted'
              ? admission.operation.operationId
              : admission.result.operationId,
          clientCommandId: request.clientCommandId,
          disposition: 'accepted',
        };
      }
      if (
        request.command.kind === 'stage' ||
        request.command.kind === 'unstage'
      ) {
        const command = request.command;
        const initial = latestBase?.worktrees.find(
          ({ worktreeId }) => worktreeId === command.worktreeId,
        );
        if (initial === undefined) {
          throw new Error(
            'Stage and Unstage require a current Worktree snapshot.',
          );
        }
        const initialRepositoryId = latestBase?.repositoryId;
        const initialCommonGitDirectory = latestBase?.commonGitDirectory;
        const initialGeneration = initial.generation;
        const initialCanonicalPath = initial.canonicalPath;
        const admission = await operations.dispatch({
          kind: command.kind,
          worktreeGeneration: initial.generation,
          async reconcileBusy() {
            await observe(() => delegate.requestRefresh()).catch(
              () => undefined,
            );
          },
          async execute({ signal }) {
            const current = await observe(() =>
              delegate.requestRefresh(),
            ).catch(() => undefined);
            const worktree =
              current?.kind === 'repository'
                ? current.repository.worktrees.find(
                    ({ worktreeId }) => worktreeId === command.worktreeId,
                  )
                : undefined;
            if (
              current?.kind !== 'repository' ||
              current.repository.repositoryId !== initialRepositoryId ||
              current.repository.commonGitDirectory !==
                initialCommonGitDirectory ||
              worktree === undefined ||
              worktree.generation !== initialGeneration ||
              worktree.canonicalPath !== initialCanonicalPath ||
              worktree.worktreeRevision !== command.expectedWorktreeRevision
            ) {
              return reject(
                'stale',
                'Worktree or Changed File state changed; refresh and choose again.',
              );
            }
            const changes = command.fileIds.map((fileId) =>
              worktree.changes.find((change) => change.fileId === fileId),
            );
            if (changes.some((change) => change === undefined)) {
              return reject(
                'stale',
                'A Changed File target changed; refresh and choose again.',
              );
            }
            const resolvedChanges = changes.filter(
              (change): change is NonNullable<typeof change> =>
                change !== undefined,
            );
            if (
              command.kind === 'stage' &&
              resolvedChanges.some((change) => change.kind === 'conflict')
            ) {
              return reject(
                'unsupported_state',
                'Conflict entries cannot be staged.',
              );
            }
            const targetKindsMatch = resolvedChanges.every((change) =>
              command.kind === 'stage'
                ? change.kind === 'change' || change.kind === 'untracked'
                : change.kind === 'staged_change',
            );
            if (
              !targetKindsMatch ||
              worktree.availability.kind !== 'available' ||
              worktree.canonicalPath === null ||
              worktree.freshness.kind !== 'fresh' ||
              worktree.status?.inProgressOperation !== undefined ||
              worktree.index?.locked !== false ||
              worktree.gitLock.kind !== 'unlocked'
            ) {
              return reject(
                'precondition_failed',
                `${command.kind === 'stage' ? 'Stage' : 'Unstage'} requires current Changed Files in an available Worktree with no Git lock.`,
              );
            }
            if (options.runGit === undefined) {
              return reject(
                'unsupported_state',
                `${command.kind === 'stage' ? 'Stage' : 'Unstage'} is unavailable in this Repository Session.`,
              );
            }
            if (options.inspectFileMutationTargets === undefined) {
              return reject(
                'unsupported_state',
                `${command.kind === 'stage' ? 'Stage' : 'Unstage'} target inspection is unavailable in this Repository Session.`,
              );
            }
            const baselineInspection = await options.inspectFileMutationTargets(
              worktree,
              resolvedChanges,
              signal,
            );
            if (
              baselineInspection.topologyEvidence !==
                worktree[privateWorktreeIdentityEvidence] ||
              baselineInspection.commonGitDirectory !==
                initialCommonGitDirectory ||
              baselineInspection.worktreePath !== initialCanonicalPath ||
              baselineInspection.targetFingerprints.length !==
                resolvedChanges.length ||
              baselineInspection.targetFingerprints.some(
                (fingerprint, index) =>
                  fingerprint !== resolvedChanges[index]?.baselineFingerprint,
              )
            ) {
              return reject(
                'stale',
                'Repository, Worktree, or Changed File state changed before inspection.',
              );
            }
            if (baselineInspection.blockedBy !== null) {
              return reject(
                baselineInspection.blockedBy === 'index_lock'
                  ? 'index_locked'
                  : 'precondition_failed',
                'A Git operation or lock blocks this file mutation.',
              );
            }
            const effects = [];
            for (let index = 0; index < resolvedChanges.length; index += 1) {
              const target = resolvedChanges[index]!;
              const inspection = await options.inspectFileMutationTargets(
                worktree,
                [target],
                signal,
              );
              if (
                inspection.commonGitDirectory !== initialCommonGitDirectory ||
                inspection.worktreePath !== initialCanonicalPath ||
                inspection.topologyEvidence !==
                  baselineInspection.topologyEvidence ||
                inspection.targetFingerprints[0] !== target.baselineFingerprint
              ) {
                if (effects.length === 0) {
                  return reject(
                    'stale',
                    'Repository or Worktree identity changed; refresh and choose again.',
                  );
                }
                effects.push(staleFileEffect(target));
                continue;
              }
              if (inspection.blockedBy !== null) {
                const code =
                  inspection.blockedBy === 'index_lock'
                    ? ('index_locked' as const)
                    : ('precondition_failed' as const);
                if (effects.length === 0) {
                  return reject(
                    code,
                    'A Git operation or lock blocks this file mutation.',
                  );
                }
                effects.push(blockedFileEffect(target, code));
                continue;
              }
              const change = target;
              const paths = [change.pathBytes];
              if (change.previousPathBytes !== null) {
                paths.push(change.previousPathBytes);
              }
              try {
                await options.runGit(
                  fileMutationArguments(
                    command.kind,
                    worktree.canonicalPath,
                    worktree.head.objectId === null,
                  ),
                  false,
                  undefined,
                  signal,
                  undefined,
                  nulDelimitedPaths(paths),
                );
                effects.push({
                  kind: 'completed' as const,
                  label: effectLabel(change.displayPath),
                  pathBytes: change.pathBytes,
                  sourceKind: change.kind,
                });
              } catch (error) {
                if (signal.aborted) throw error;
                if (!isKnownGitFailure(error)) throw error;
                effects.push({
                  kind: 'failed_known' as const,
                  label: effectLabel(change.displayPath),
                  pathBytes: change.pathBytes,
                  sourceKind: change.kind,
                  code: 'process_failed' as const,
                  message: `Git could not ${command.kind} ${effectLabel(change.displayPath)}.`,
                });
              }
            }
            return {
              kind: 'attempted' as const,
              effects,
            };
          },
          async reconcile(context) {
            const evidence =
              context.execution.kind === 'returned'
                ? context.execution.evidence
                : undefined;
            const reconciled = await observe(() =>
              delegate.requestRefresh(),
            ).catch(() => undefined);
            if (
              reconciled?.kind !== 'repository' ||
              reconciled.repository.refresh.kind !== 'fresh'
            ) {
              return unknownFileMutation();
            }
            if (evidence?.kind === 'rejected') return evidence.result;
            if (context.execution.kind !== 'returned') {
              return unknownFileMutation();
            }
            if (
              evidence?.kind === 'attempted' &&
              reconciled.kind === 'repository'
            ) {
              const worktree = reconciled.repository.worktrees.find(
                ({ worktreeId }) => worktreeId === command.worktreeId,
              );
              if (
                reconciled.repository.repositoryId !== initialRepositoryId ||
                reconciled.repository.commonGitDirectory !==
                  initialCommonGitDirectory ||
                worktree === undefined ||
                worktree.generation !== initialGeneration ||
                worktree.canonicalPath !== initialCanonicalPath ||
                worktree.freshness.kind !== 'fresh'
              ) {
                return {
                  kind: 'unknown_outcome',
                  code: 'reconciliation_incomplete',
                  message: 'Fresh Worktree state could not be established.',
                  recoveryAvailable: true,
                };
              }
              const effects = evidence.effects.map((effect) => {
                if (
                  effect.kind === 'failed_known' &&
                  (effect.code === 'stale' ||
                    effect.code === 'index_locked' ||
                    effect.code === 'precondition_failed')
                ) {
                  return {
                    kind: effect.kind,
                    label: effect.label,
                    code: effect.code,
                    message: effect.message,
                  };
                }
                const currentChanges = worktree.changes.filter((change) =>
                  Buffer.from(change.pathBytes).equals(
                    Buffer.from(effect.pathBytes),
                  ),
                );
                const desiredState =
                  command.kind === 'stage' && effect.sourceKind === 'untracked'
                    ? currentChanges.some(
                        ({ kind }) => kind === 'staged_change',
                      )
                    : !currentChanges.some(({ kind }) =>
                        command.kind === 'stage'
                          ? kind === 'change' || kind === 'untracked'
                          : kind === 'staged_change',
                      );
                return desiredState
                  ? { kind: 'succeeded' as const, label: effect.label }
                  : effect.kind === 'failed_known'
                    ? {
                        kind: effect.kind,
                        label: effect.label,
                        code: effect.code,
                        message: effect.message,
                      }
                    : {
                        kind: 'failed_known' as const,
                        label: effect.label,
                        code: 'process_failed' as const,
                        message: `Git did not ${command.kind} ${effect.label}.`,
                      };
              });
              const succeeded = effects.filter(
                (
                  effect,
                ): effect is Extract<
                  (typeof effects)[number],
                  { kind: 'succeeded' }
                > => effect.kind === 'succeeded',
              );
              const failed = effects.filter(
                (
                  effect,
                ): effect is Extract<
                  (typeof effects)[number],
                  { kind: 'failed_known' }
                > => effect.kind === 'failed_known',
              );
              if (failed.length === 0) {
                return {
                  kind: 'succeeded',
                  result: {
                    kind: 'files',
                    affectedCount: succeeded.length,
                  },
                };
              }
              if (succeeded.length > 0) {
                return {
                  kind: 'partial_success',
                  message: `Some Changed Files could not be ${command.kind === 'stage' ? 'staged' : 'unstaged'}.`,
                  effects,
                };
              }
              const firstFailure = failed[0]!;
              if (failed.every(({ code }) => code === 'stale')) {
                return {
                  kind: 'rejected',
                  code: 'stale',
                  message: 'Changed File targets changed before execution.',
                };
              }
              return {
                kind: 'failed_known',
                code:
                  firstFailure.code === 'stale' ||
                  firstFailure.code === 'index_locked' ||
                  firstFailure.code === 'precondition_failed'
                    ? 'process_failed'
                    : firstFailure.code,
                message:
                  failed.length === 1
                    ? firstFailure.message
                    : `No Changed Files could be ${command.kind === 'stage' ? 'staged' : 'unstaged'}.`,
                effects: failed.length > 1 ? failed : undefined,
              };
            }
            return unknownFileMutation();
          },
        });
        if (admission.kind === 'closed') {
          throw new Error('The Repository Session is closed.');
        }
        return {
          operationId:
            admission.kind === 'accepted'
              ? admission.operation.operationId
              : admission.result.operationId,
          clientCommandId: request.clientCommandId,
          disposition: 'accepted',
        };
      }
      if (request.command.kind !== 'switch_branch') {
        throw new Error(
          'This Repository Session does not support that command.',
        );
      }
      const command = request.command;
      const binding = branchBindings.get(command.refId);
      const target = binding ?? {
        fullName: 'refs/heads/stale',
        kind: 'local' as const,
        objectId: '',
        occupiedBy: null,
        remoteId: null,
        refsRevision: command.expectedRefsRevision,
      };
      const initial = latestBase?.worktrees.find(
        ({ worktreeId }) => worktreeId === command.worktreeId,
      );
      if (initial === undefined) {
        throw new Error(
          'Branch switching requires a current Worktree snapshot.',
        );
      }
      const admission = await operations.dispatch({
        kind: 'branch_switch',
        worktreeGeneration: initial.generation,
        currentRef:
          initial?.head.kind === 'local_branch' ? initial.head.fullName : null,
        target:
          target.kind === 'remote_tracking' && target.remoteId !== null
            ? {
                kind: 'remote_tracking',
                fullName: target.fullName,
                remoteId: target.remoteId,
              }
            : { kind: 'local', fullName: target.fullName },
        async reconcileBusy() {
          await observe(() => delegate.requestRefresh()).catch(() => undefined);
        },
        async execute({ signal }) {
          const current = await observe(() => delegate.requestRefresh()).catch(
            () => undefined,
          );
          if (current === undefined) {
            return reject(
              'stale',
              'Branch state could not be revalidated; refresh and choose again.',
            );
          }
          if (current.kind !== 'repository') {
            return reject('stale', 'The Repository is no longer available.');
          }
          const repository = current.repository;
          const worktree = repository.worktrees.find(
            ({ worktreeId }) => worktreeId === command.worktreeId,
          );
          if (
            binding === undefined ||
            binding.refsRevision !== command.expectedRefsRevision ||
            repository.refsRevision !== command.expectedRefsRevision ||
            worktree === undefined ||
            worktree.worktreeRevision !== command.expectedWorktreeRevision
          ) {
            return reject(
              'stale',
              'Branch or Worktree state changed; refresh and choose again.',
            );
          }
          const currentRef = repository.refs.find(
            ({ fullName }) => fullName === binding.fullName,
          );
          const occupiedBy = repository.worktrees.find(
            ({ head }) =>
              head.kind === 'local_branch' &&
              head.fullName === binding.fullName,
          )?.worktreeId;
          if (
            currentRef?.objectId !== binding.objectId ||
            (binding.kind === 'local' &&
              (occupiedBy ?? null) !== binding.occupiedBy)
          ) {
            return reject(
              'stale',
              'Branch Occupancy or target ref changed; refresh and choose again.',
            );
          }
          const localTargetName =
            binding.kind === 'local'
              ? localDisplayName(binding.fullName)
              : remoteTrackingLocalName(binding.fullName, repository, binding);
          if (localTargetName === null) {
            return reject(
              'precondition_failed',
              'The Remote-tracking Branch no longer maps to a configured Remote.',
            );
          }
          if (
            binding.kind === 'remote_tracking' &&
            repository.refs.some(
              ({ kind, fullName }) =>
                kind === 'local' &&
                fullName === `refs/heads/${localTargetName}`,
            )
          ) {
            return reject(
              'precondition_failed',
              'A same-name Local Branch already exists.',
            );
          }
          if (
            worktree.availability.kind !== 'available' ||
            worktree.canonicalPath === null ||
            worktree.freshness.kind !== 'fresh' ||
            worktree.status?.clean !== true ||
            worktree.status.conflicted !== 0 ||
            worktree.status.inProgressOperation !== undefined ||
            worktree.index?.locked !== false ||
            worktree.gitLock.kind !== 'unlocked'
          ) {
            return reject(
              'precondition_failed',
              'Branch switching requires a clean, available Worktree with no Git lock.',
            );
          }
          if (
            binding.kind === 'local' &&
            binding.occupiedBy !== null &&
            binding.occupiedBy !== worktree.worktreeId
          ) {
            return reject(
              'precondition_failed',
              'The Local Branch is occupied by another Worktree.',
            );
          }
          if (options.runGit === undefined) {
            return reject(
              'unsupported_state',
              'Branch switching is unavailable in this Repository Session.',
            );
          }
          await options.runGit(
            binding.kind === 'local'
              ? [
                  '-C',
                  worktree.canonicalPath,
                  'switch',
                  '--no-guess',
                  '--',
                  localTargetName,
                ]
              : [
                  '-C',
                  worktree.canonicalPath,
                  'switch',
                  '--no-guess',
                  '--track=direct',
                  '-c',
                  localTargetName,
                  binding.fullName,
                ],
            false,
            undefined,
            signal,
          );
          return { kind: 'attempted' as const, displayName: localTargetName };
        },
        async reconcile(context) {
          const evidence =
            context.execution.kind === 'returned'
              ? (context.execution.evidence as BranchSwitchEvidence)
              : undefined;
          if (evidence?.kind === 'rejected') {
            await observe(() => delegate.requestRefresh()).catch(
              () => undefined,
            );
            return evidence.result;
          }
          const reconciled = await observe(() =>
            delegate.requestRefresh(),
          ).catch(() => undefined);
          if (reconciled === undefined) {
            return {
              kind: 'unknown_outcome',
              code: 'reconciliation_incomplete',
              message:
                'The Branch switch could not be reconciled to authoritative state.',
              recoveryAvailable: true,
            };
          }
          const worktree =
            reconciled.kind === 'repository'
              ? reconciled.repository.worktrees.find(
                  ({ worktreeId }) => worktreeId === command.worktreeId,
                )
              : undefined;
          if (
            evidence?.kind === 'attempted' &&
            worktree?.head.kind === 'local_branch' &&
            worktree.head.fullName ===
              (binding?.kind === 'local'
                ? binding.fullName
                : `refs/heads/${evidence.displayName}`)
          ) {
            return {
              kind: 'succeeded',
              result: {
                kind: 'branch_switch',
                displayName: evidence.displayName,
              },
            };
          }
          return {
            kind: 'failed_known',
            code: 'process_failed',
            message: 'Git did not complete the Branch switch.',
          };
        },
      });
      if (admission.kind === 'closed') {
        throw new Error('The Repository Session is closed.');
      }
      const operationId =
        admission.kind === 'accepted'
          ? admission.operation.operationId
          : admission.result.operationId;
      return {
        operationId,
        clientCommandId: request.clientCommandId,
        disposition: 'accepted',
      };
    },
    async cancelOperation(operationId) {
      const result = await operations.cancel(operationId);
      await observe(() => delegate.requestRefresh()).catch(() => undefined);
      return result;
    },
    async recoverOperation(operationId) {
      const result = await operations.recover(operationId);
      await observe(() => delegate.requestRefresh()).catch(() => undefined);
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      await operations.close();
      await delegate.close();
      branchIds.revokeAll();
      invalidations.close();
    },
  };
}

function nulDelimitedPaths(paths: readonly Uint8Array[]): Uint8Array {
  const length = paths.reduce((total, path) => total + path.length + 1, 0);
  const input = new Uint8Array(length);
  let offset = 0;
  for (const path of paths) {
    input.set(path, offset);
    offset += path.length + 1;
  }
  return input;
}

type ChangedFileTarget =
  RepositorySnapshot['worktrees'][number]['changes'][number];

function staleFileEffect(change: ChangedFileTarget) {
  return {
    kind: 'failed_known' as const,
    label: effectLabel(change.displayPath),
    pathBytes: change.pathBytes,
    sourceKind: change.kind,
    code: 'stale' as const,
    message: `${effectLabel(change.displayPath)} changed before execution.`,
  };
}

function blockedFileEffect(
  change: ChangedFileTarget,
  code: 'index_locked' | 'precondition_failed',
) {
  return {
    kind: 'failed_known' as const,
    label: effectLabel(change.displayPath),
    pathBytes: change.pathBytes,
    sourceKind: change.kind,
    code,
    message: `${effectLabel(change.displayPath)} is blocked by a Git operation or lock.`,
  };
}

function isKnownGitFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    'failure' in error &&
    error.failure === 'command_failed' &&
    'exitCode' in error &&
    typeof error.exitCode === 'number'
  );
}

function unknownFileMutation() {
  return {
    kind: 'unknown_outcome' as const,
    code: 'reconciliation_incomplete' as const,
    message: 'The file mutation could not be reconciled to fresh state.',
    recoveryAvailable: true as const,
  };
}

function fileMutationArguments(
  kind: 'stage' | 'unstage',
  worktreePath: string,
  initialState: boolean,
): readonly string[] {
  if (kind === 'stage') {
    return [
      '--literal-pathspecs',
      '-C',
      worktreePath,
      'add',
      '-A',
      '--pathspec-from-file=-',
      '--pathspec-file-nul',
    ];
  }
  if (initialState) {
    return [
      '--literal-pathspecs',
      '-C',
      worktreePath,
      'rm',
      '--cached',
      '--force',
      '--quiet',
      '--ignore-unmatch',
      '--pathspec-from-file=-',
      '--pathspec-file-nul',
    ];
  }
  return [
    '--literal-pathspecs',
    '-C',
    worktreePath,
    'reset',
    '--quiet',
    'HEAD',
    '--pathspec-from-file=-',
    '--pathspec-file-nul',
  ];
}

function effectLabel(displayPath: string): string {
  return displayPath.length <= 256
    ? displayPath
    : `${displayPath.slice(0, 253)}...`;
}

function escapedBytePath(path: Uint8Array): string {
  return [...path]
    .map((byte) =>
      byte >= 0x20 && byte <= 0x7e && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, '0')}`,
    )
    .join('');
}

function localDisplayName(fullName: string): string {
  return fullName.slice('refs/heads/'.length);
}

function remoteTrackingLocalName(
  fullName: string,
  repository: RepositorySnapshot,
  binding: BranchBinding,
): string | null {
  const remote = repository.remotes.find(
    ({ remoteId }) => remoteId === binding.remoteId,
  );
  if (remote === undefined) return null;
  const prefix = `refs/remotes/${remote.displayName}/`;
  return fullName.startsWith(prefix) ? fullName.slice(prefix.length) : null;
}

interface ConfiguredUpstreamTarget {
  readonly remoteName: string;
  readonly mergeRef: string;
}

async function readConfiguredUpstreamTarget(
  worktree: RepositorySnapshot['worktrees'][number],
  runGit: GitProcessRunner | undefined,
): Promise<ConfiguredUpstreamTarget | null> {
  if (
    worktree.head.kind !== 'local_branch' ||
    worktree.canonicalPath === null ||
    runGit === undefined
  ) {
    return null;
  }
  const output = await runGit(
    [
      '-C',
      worktree.canonicalPath,
      'for-each-ref',
      '--format=%(upstream:remotename)%00%(upstream:remoteref)',
      worktree.head.fullName,
    ],
    false,
  );
  const [remoteName = '', mergeRefWithNewline = '', extra] = new TextDecoder(
    'utf-8',
    { fatal: true },
  )
    .decode(output)
    .split('\0');
  const mergeRef = mergeRefWithNewline.replace(/\r?\n$/u, '');
  if (
    extra !== undefined ||
    remoteName.length === 0 ||
    remoteName.includes('\n') ||
    !mergeRef.startsWith('refs/heads/') ||
    mergeRef.includes('\n')
  ) {
    return null;
  }
  return { remoteName, mergeRef };
}

function unknownRemoteOutcome() {
  return {
    kind: 'unknown_outcome' as const,
    code: 'reconciliation_incomplete' as const,
    message: 'The Remote Operation could not be reconciled to fresh Git state.',
    recoveryAvailable: true as const,
  };
}

function unknownRemoteReconciliation(): RemoteOperationResult {
  return {
    kind: 'unknown',
    message: 'The exact Remote state could not be refreshed safely.',
  };
}

async function detachedHeadWarning(
  worktree: RepositorySnapshot['worktrees'][number] | undefined,
  runGit: GitProcessRunner | undefined,
): Promise<string | null> {
  if (
    worktree?.head.kind !== 'detached' ||
    worktree.canonicalPath === null ||
    runGit === undefined
  ) {
    return null;
  }
  const output = await runGit(
    [
      '-C',
      worktree.canonicalPath,
      'for-each-ref',
      '--format=%(refname)',
      '--contains',
      worktree.head.objectId,
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ],
    true,
  );
  return new TextDecoder('utf-8', { fatal: true }).decode(output).trim()
    .length > 0
    ? null
    : 'This detached Commit is not reachable from another named ref and may become difficult to recover after switching.';
}

function reject(
  code: Extract<OperationResult, { kind: 'rejected' }>['code'],
  message: string,
) {
  return {
    kind: 'rejected' as const,
    result: { kind: 'rejected' as const, code, message },
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
