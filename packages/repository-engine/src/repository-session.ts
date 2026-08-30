import {
  createOpaqueIdAuthority,
  type BranchSearchRequest,
  type BranchSearchResult,
  type CommandEnvelope,
  type OperationReceipt,
  type OperationId,
  type OperationResult,
  type RefId,
  type RemoteId,
} from '@codex-git/protocol';

import { InvalidationStream } from './invalidation-stream.js';
import {
  createOperationSession,
  type OperationSessionSummary,
} from './operation-session.js';
import type {
  RepositoryInvalidation,
  RepositoryOpenResult,
  RepositoryPublicationSession,
  RepositoryRefreshScope,
  RepositorySnapshot,
  ScopedRepositoryPublicationSession,
} from './repository-publication.js';

const OPERATION_TIMEOUT_MILLISECONDS = 30_000;

export interface RepositorySession extends RepositoryPublicationSession {
  searchBranches(request: BranchSearchRequest): Promise<BranchSearchResult>;
  dispatch(request: CommandEnvelope): Promise<OperationReceipt>;
  cancelOperation(operationId: OperationId): Promise<OperationResult>;
  recoverOperation(operationId: OperationId): Promise<OperationResult>;
}

export interface InternalRepositorySession
  extends RepositorySession, ScopedRepositoryPublicationSession {}

type GitProcessRunner = (
  args: readonly string[],
  allowLargeOutput: boolean,
  acceptedEmptyExitCode?: 1,
  signal?: AbortSignal,
) => Promise<Uint8Array>;

interface RepositorySessionOptions {
  readonly runGit?: GitProcessRunner;
}

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

  return {
    snapshot: () => observe(() => delegate.snapshot()),
    requestRefresh: () => observe(() => delegate.requestRefresh()),
    requestScopedRefresh: (scope: RepositoryRefreshScope) =>
      observe(() => delegate.requestScopedRefresh(scope)),
    subscribe: () => invalidations.subscribe(),
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
      await observe(() => delegate.requestRefresh());
      return result;
    },
    async recoverOperation(operationId) {
      const result = await operations.recover(operationId);
      await observe(() => delegate.requestRefresh());
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
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
