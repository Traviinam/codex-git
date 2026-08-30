import { resolve, sep } from 'node:path';

import type {
  DiffResult,
  FileId,
  NativeTargetId,
  OperationId,
  OperationResult,
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
  diff(fileId: FileId): Promise<DiffResult>;
  resolveFileNativeTarget(targetId: NativeTargetId): Promise<FileNativeTarget>;
  cancelOperation(operationId: OperationId): Promise<OperationResult>;
  recoverOperation(operationId: OperationId): Promise<OperationResult>;
}

export interface FileNativeTarget {
  readonly absolutePath: string | null;
  readonly canOpen: boolean;
  readonly relativePath: string;
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

export function createRepositorySession(
  delegate: ScopedRepositoryPublicationSession,
  options: {
    readonly diff?: (
      worktree: RepositorySnapshot['worktrees'][number],
      fileId: FileId,
    ) => Promise<DiffResult>;
  } = {},
): InternalRepositorySession {
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
            worktreePath: worktree.canonicalPath,
          };
        }
        throw new RepositoryTargetFailure();
      }
      throw new RepositoryTargetFailure();
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
      invalidations.close();
    },
  };
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

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
