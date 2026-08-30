import type { OperationId, OperationResult } from '@codex-git/protocol';

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
  cancelOperation(operationId: OperationId): Promise<OperationResult>;
  recoverOperation(operationId: OperationId): Promise<OperationResult>;
}

export interface InternalRepositorySession
  extends RepositorySession, ScopedRepositoryPublicationSession {}

export function createRepositorySession(
  delegate: ScopedRepositoryPublicationSession,
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

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
