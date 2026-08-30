import { watch, type FSWatcher } from 'node:fs';

import type { WorktreeId } from '@codex-git/protocol';

import {
  type RepositoryOpenResult,
  type RepositoryRefreshScope,
} from './repository-publication.js';
import type {
  InternalRepositorySession,
  RepositorySession,
} from './repository-session.js';

const FILESYSTEM_DEBOUNCE_MILLISECONDS = 75;
const SELECTED_WORKTREE_POLL_MILLISECONDS = 1_000;
const NON_SELECTED_WORKTREE_POLL_MILLISECONDS = 5_000;
const DISCOVERY_FALLBACK_POLL_MILLISECONDS = 30_000;

export function createRefreshingRepositorySession(
  delegate: InternalRepositorySession,
): RepositorySession {
  let closed = false;
  let debounceTimer: NodeJS.Timeout | undefined;
  let backgroundRefresh: Promise<void> | undefined;
  let pendingScope: RepositoryRefreshScope | undefined;
  let requestedRefresh: Promise<RepositoryOpenResult> | undefined;
  let watchedTopology = '';
  let selectedWorktreeId: WorktreeId | null = null;
  let nonSelectedWorktreeIds: readonly WorktreeId[] = [];
  let nonSelectedCursor = 0;
  let foregroundRefreshes = 0;
  const watchers: FSWatcher[] = [];
  const pollTimers: NodeJS.Timeout[] = [];

  const observeResult = async (
    read: () => Promise<RepositoryOpenResult>,
  ): Promise<RepositoryOpenResult> => {
    const result = await read();
    if (!closed && result.kind === 'repository') configureObservation(result);
    return result;
  };

  const startPendingBackgroundRefresh = () => {
    if (foregroundRefreshes !== 0 || pendingScope === undefined) return;
    const scope = pendingScope;
    pendingScope = undefined;
    startBackgroundRefresh(scope);
  };

  const startBackgroundRefresh = (scope: RepositoryRefreshScope) => {
    if (closed) return;
    if (backgroundRefresh !== undefined || foregroundRefreshes > 0) {
      pendingScope = mergeScopes(pendingScope, scope);
      return;
    }
    backgroundRefresh = observeResult(() =>
      delegate.requestScopedRefresh(scope),
    )
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        backgroundRefresh = undefined;
        startPendingBackgroundRefresh();
      });
  };

  const scheduleFilesystemRefresh = (scope: RepositoryRefreshScope) => {
    if (closed) return;
    pendingScope = mergeScopes(pendingScope, scope);
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      const next = pendingScope ?? { kind: 'all' };
      pendingScope = undefined;
      startBackgroundRefresh(next);
    }, FILESYSTEM_DEBOUNCE_MILLISECONDS);
    debounceTimer.unref();
  };

  const configureObservation = (
    result: Extract<RepositoryOpenResult, { readonly kind: 'repository' }>,
  ) => {
    selectedWorktreeId = result.repository.selectedWorktreeId;
    nonSelectedWorktreeIds = result.repository.worktrees
      .filter(({ worktreeId }) => worktreeId !== selectedWorktreeId)
      .map(({ worktreeId }) => worktreeId);
    if (nonSelectedCursor >= nonSelectedWorktreeIds.length) {
      nonSelectedCursor = 0;
    }

    const paths: Array<{
      readonly path: string;
      readonly scope: RepositoryRefreshScope;
    }> = [
      {
        path: result.repository.commonGitDirectory,
        scope: { kind: 'all' },
      },
      ...result.repository.worktrees
        .filter(
          ({ availability, canonicalPath }) =>
            availability.kind === 'available' && canonicalPath !== null,
        )
        .map(({ canonicalPath, worktreeId }) => ({
          path: canonicalPath as string,
          scope: { kind: 'worktrees', worktreeIds: [worktreeId] } as const,
        })),
    ];
    const topology = JSON.stringify(
      paths
        .map(({ path, scope }) => ({ path, scope }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    );
    if (topology !== watchedTopology) {
      watchedTopology = topology;
      for (const watcher of watchers.splice(0)) watcher.close();
      for (const { path, scope } of paths) {
        try {
          const watcher = watch(
            path,
            {
              persistent: false,
              recursive: process.platform === 'darwin',
            },
            () => scheduleFilesystemRefresh(scope),
          );
          watcher.on('error', () => watcher.close());
          watchers.push(watcher);
        } catch {
          // Polling remains the correctness fallback for an unsupported path.
        }
      }
    }
    if (pollTimers.length === 0) configurePolling();
  };

  const configurePolling = () => {
    const selected = setInterval(() => {
      if (selectedWorktreeId !== null) {
        startBackgroundRefresh({
          kind: 'worktrees',
          worktreeIds: [selectedWorktreeId],
        });
      }
    }, SELECTED_WORKTREE_POLL_MILLISECONDS);
    const nonSelected = setInterval(() => {
      const worktreeId = nonSelectedWorktreeIds[nonSelectedCursor];
      if (worktreeId !== undefined) {
        nonSelectedCursor =
          (nonSelectedCursor + 1) % nonSelectedWorktreeIds.length;
        startBackgroundRefresh({
          kind: 'worktrees',
          worktreeIds: [worktreeId],
        });
      }
    }, NON_SELECTED_WORKTREE_POLL_MILLISECONDS);
    const discovery = setInterval(
      () => startBackgroundRefresh({ kind: 'all' }),
      DISCOVERY_FALLBACK_POLL_MILLISECONDS,
    );
    for (const timer of [selected, nonSelected, discovery]) {
      timer.unref();
      pollTimers.push(timer);
    }
  };

  const foreground = async (
    read: () => Promise<RepositoryOpenResult>,
  ): Promise<RepositoryOpenResult> => {
    foregroundRefreshes += 1;
    try {
      return await observeResult(read);
    } finally {
      foregroundRefreshes -= 1;
      startPendingBackgroundRefresh();
    }
  };

  return {
    snapshot: () => foreground(() => delegate.snapshot()),
    requestRefresh() {
      if (requestedRefresh !== undefined) return requestedRefresh;
      requestedRefresh = foreground(() => delegate.requestRefresh()).finally(
        () => {
          requestedRefresh = undefined;
        },
      );
      return requestedRefresh;
    },
    subscribe: () => delegate.subscribe(),
    fetch: (request) => delegate.fetch(request),
    cancelOperation: (operationId) => delegate.cancelOperation(operationId),
    recoverOperation: (operationId) => delegate.recoverOperation(operationId),
    async close() {
      if (closed) return;
      closed = true;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      for (const timer of pollTimers.splice(0)) clearInterval(timer);
      for (const watcher of watchers.splice(0)) watcher.close();
      await delegate.close();
    },
  };
}

function mergeScopes(
  left: RepositoryRefreshScope | undefined,
  right: RepositoryRefreshScope,
): RepositoryRefreshScope {
  if (left === undefined) return right;
  if (left.kind === 'all' || right.kind === 'all') return { kind: 'all' };
  return {
    kind: 'worktrees',
    worktreeIds: [...new Set([...left.worktreeIds, ...right.worktreeIds])],
  };
}
