import { useEffect, useRef, useSyncExternalStore } from 'react';

import type {
  RepositoryOverviewSnapshot,
  WorktreeOverviewSnapshot,
} from './repository-overview-model.js';
import type { RepositoryStore } from './repository-store.js';

export function RepositoryOverview({
  store,
}: {
  readonly store: RepositoryStore;
}) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const worktreeButtons = useRef(new Map<string, HTMLButtonElement>());
  const searchInput = useRef<HTMLInputElement>(null);
  const worktreeTitle = useRef<HTMLHeadingElement>(null);
  const handledFocusRecovery = useRef(0);
  const orderedWorktrees =
    state.source.kind === 'repository'
      ? [...state.source.snapshot.worktrees].sort(compareWorktrees)
      : [];
  const normalizedQuery = state.searchQuery.trim().toLocaleLowerCase();
  const visibleWorktrees = orderedWorktrees.filter((worktree) =>
    matchesSearch(worktree, normalizedQuery),
  );
  const rovingWorktreeId =
    visibleWorktrees.find(
      (worktree) => worktree.worktreeId === state.selectedWorktreeId,
    )?.worktreeId ??
    visibleWorktrees[0]?.worktreeId ??
    null;

  useEffect(() => {
    if (handledFocusRecovery.current === state.focusRecoveryRevision) return;
    handledFocusRecovery.current = state.focusRecoveryRevision;
    const visibleButton =
      rovingWorktreeId === null
        ? undefined
        : worktreeButtons.current.get(rovingWorktreeId);
    if (visibleButton !== undefined) {
      visibleButton.focus();
      return;
    }
    if (searchInput.current !== null) {
      searchInput.current.focus();
      return;
    }
    worktreeTitle.current?.focus();
  }, [rovingWorktreeId, state.focusRecoveryRevision]);

  if (state.source.kind === 'loading') {
    return (
      <main className="repository-overview repository-empty-state">
        <p className="eyebrow">Git workspace</p>
        <h1 ref={worktreeTitle} tabIndex={-1}>
          Codex Git
        </h1>
        {state.selectionNotice === null ? (
          <p aria-live="polite" role="status">
            {state.source.message}
          </p>
        ) : (
          <>
            <p>{state.source.message}</p>
            <p aria-live="polite" role="status">
              {state.selectionNotice}
            </p>
          </>
        )}
      </main>
    );
  }

  if (
    state.source.kind === 'non-repository' ||
    state.source.kind === 'failed'
  ) {
    return (
      <main className="repository-overview repository-empty-state">
        <p className="eyebrow">Current Project</p>
        <h1 ref={worktreeTitle} tabIndex={-1}>
          {state.source.kind === 'non-repository'
            ? 'No Git Repository'
            : 'Repository unavailable'}
        </h1>
        <p>{state.source.message}</p>
        <code>{state.source.projectPath}</code>
        {state.selectionNotice === null ? null : (
          <p aria-live="polite" role="status">
            {state.selectionNotice}
          </p>
        )}
      </main>
    );
  }

  const { snapshot } = state.source;
  const selected = snapshot.worktrees.find(
    (worktree) => worktree.worktreeId === state.selectedWorktreeId,
  );
  const unavailableCount = snapshot.worktrees.filter(
    (worktree) =>
      worktree.availability?.kind === 'unavailable' ||
      (worktree.availability === undefined &&
        worktree.status.kind === 'unavailable'),
  ).length;
  const fetchAvailable = snapshot.fetchAvailable !== false;
  const fetchResultEffects =
    snapshot.fetchResult?.kind === 'partial_success'
      ? snapshot.fetchResult.effects
      : snapshot.fetchResult?.kind === 'failed_known'
        ? snapshot.fetchResult.effects
        : undefined;

  return (
    <main className="repository-overview">
      {state.selectionNotice === null ? null : (
        <p aria-live="polite" className="selection-notice" role="status">
          {state.selectionNotice}
        </p>
      )}
      <header className="repository-header">
        <div>
          <p className="eyebrow">Repository</p>
          <h1>{snapshot.displayName}</h1>
          <p>{snapshot.path}</p>
        </div>
        <dl>
          <div>
            <dt>Available</dt>
            <dd>{snapshot.worktrees.length - unavailableCount}</dd>
          </div>
          <div>
            <dt>Unavailable</dt>
            <dd>{unavailableCount}</dd>
          </div>
          <div>
            <dt>Local Refresh</dt>
            <dd aria-live="polite">{refreshLabel(snapshot.refresh)}</dd>
          </div>
          <div>
            <dt>Fetch freshness</dt>
            <dd>{fetchLabel(snapshot.fetch)}</dd>
          </div>
          <div>
            <dt>Operations</dt>
            <dd aria-live="polite">{operationLabel(snapshot.operations)}</dd>
          </div>
        </dl>
        <div>
          <button
            aria-label={`Refresh ${snapshot.displayName} locally`}
            type="button"
            onClick={() => store.requestRefresh()}
          >
            Refresh
          </button>
          {snapshot.remotes.map((remote) => (
            <button
              aria-label={`Fetch ${remote.displayName} for ${snapshot.displayName}`}
              disabled={!fetchAvailable}
              key={remote.remoteId}
              title={
                fetchAvailable
                  ? undefined
                  : 'Fetch actions are not available in this version.'
              }
              type="button"
              onClick={() => store.requestFetch(remote.remoteId)}
            >
              Fetch {remote.displayName}
            </button>
          ))}
          {snapshot.remotes.length > 1 ? (
            <button
              aria-label={`Fetch all Remotes for ${snapshot.displayName}`}
              disabled={!fetchAvailable}
              title={
                fetchAvailable
                  ? undefined
                  : 'Fetch actions are not available in this version.'
              }
              type="button"
              onClick={() => store.requestFetch(null)}
            >
              Fetch all
            </button>
          ) : null}
          {!fetchAvailable && snapshot.remotes.length > 0 ? (
            <p>Fetch actions are not available in this version.</p>
          ) : null}
        </div>
      </header>

      {snapshot.fetchResult === undefined ? null : (
        <section aria-live="polite" className="fetch-result" role="status">
          <h2>
            {fetchResultEffects !== undefined
              ? 'Fetch-all result'
              : 'Fetch result'}
          </h2>
          {fetchResultEffects !== undefined ? (
            <>
              <p>{fetchResultLabel(snapshot.fetchResult)}</p>
              <ul>
                {fetchResultEffects.map((effect) => (
                  <li key={effect.label}>
                    {effect.label} —{' '}
                    {effect.kind === 'succeeded'
                      ? 'Succeeded'
                      : `Failed: ${effect.message}`}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>{fetchResultLabel(snapshot.fetchResult)}</p>
          )}
        </section>
      )}

      <div
        className={
          snapshot.worktrees.length === 1
            ? 'overview-layout overview-layout--single'
            : 'overview-layout'
        }
      >
        {snapshot.worktrees.length > 1 ? (
          <nav aria-label="Worktrees" className="worktree-navigator">
            <label>
              Search Worktrees
              <input
                ref={searchInput}
                type="search"
                value={state.searchQuery}
                onChange={(event) =>
                  store.setSearchQuery(event.currentTarget.value)
                }
              />
            </label>
            <ul>
              {visibleWorktrees.map((worktree) => (
                <li key={worktree.worktreeId}>
                  <button
                    aria-current={
                      worktree.worktreeId === state.selectedWorktreeId
                        ? 'true'
                        : undefined
                    }
                    aria-label={`Select ${worktree.displayName} Worktree at ${worktree.path}`}
                    ref={(element) => {
                      if (element === null) {
                        worktreeButtons.current.delete(worktree.worktreeId);
                      } else {
                        worktreeButtons.current.set(
                          worktree.worktreeId,
                          element,
                        );
                      }
                    }}
                    tabIndex={worktree.worktreeId === rovingWorktreeId ? 0 : -1}
                    type="button"
                    onClick={() => store.selectWorktree(worktree.worktreeId)}
                    onKeyDown={(event) => {
                      const currentIndex = visibleWorktrees.findIndex(
                        (candidate) =>
                          candidate.worktreeId === worktree.worktreeId,
                      );
                      const targetIndex = keyboardTargetIndex(
                        event.key,
                        currentIndex,
                        visibleWorktrees.length,
                      );
                      if (targetIndex === null) return;
                      event.preventDefault();
                      const target = visibleWorktrees[targetIndex];
                      if (target === undefined) return;
                      worktreeButtons.current.get(target.worktreeId)?.focus();
                      store.selectWorktree(target.worktreeId);
                    }}
                  >
                    <span>{worktree.displayName}</span>
                    <small>{worktree.path}</small>
                    <small>{headLabel(worktree.head)}</small>
                    <small>{statusLabel(worktree.status)}</small>
                    <small>{upstreamLabel(worktree.upstream)}</small>
                    {worktree.transition === undefined ? null : (
                      <small>{transitionLabel(worktree.transition)}</small>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {visibleWorktrees.length === 0 ? (
              <p>No Worktrees match this search.</p>
            ) : null}
          </nav>
        ) : null}

        {selected === undefined ? (
          <section className="worktree-detail">
            <h2 id="worktree-title" ref={worktreeTitle} tabIndex={-1}>
              No Worktrees available
            </h2>
          </section>
        ) : (
          <section aria-labelledby="worktree-title" className="worktree-detail">
            <p>
              {selected.role === 'main' ? 'Main Worktree' : 'Linked Worktree'}
            </p>
            <h2 id="worktree-title" ref={worktreeTitle} tabIndex={-1}>
              {selected.displayName}
            </h2>
            <p>{selected.path}</p>
            <dl>
              <div>
                <dt>HEAD</dt>
                <dd>{headLabel(selected.head)}</dd>
              </div>
              <div>
                <dt>Upstream</dt>
                <dd>{upstreamLabel(selected.upstream)}</dd>
              </div>
              <div>
                <dt>Upstream freshness</dt>
                <dd aria-live="polite">
                  {upstreamFreshnessLabel(selected.upstream)}
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{statusLabel(selected.status)}</dd>
              </div>
              <div>
                <dt>Worktree observation</dt>
                <dd>{refreshLabel(selected.freshness)}</dd>
              </div>
              {selected.transition === undefined ? null : (
                <div>
                  <dt>Transition</dt>
                  <dd aria-live="polite">
                    {transitionLabel(selected.transition)}
                  </dd>
                </div>
              )}
            </dl>
            <div>
              <button
                aria-label={`Switch Branch for ${selected.displayName}`}
                type="button"
                disabled
              >
                Switch Branch
              </button>
              <button
                aria-label={`Upstream actions for ${selected.displayName}`}
                type="button"
                disabled
              >
                Upstream actions
              </button>
            </div>
            <label>
              Commit Draft for {selected.displayName}
              <textarea
                value={state.commitDrafts[selected.worktreeId] ?? ''}
                onChange={(event) =>
                  store.setCommitDraft(
                    selected.worktreeId,
                    event.currentTarget.value,
                  )
                }
              />
            </label>
            <section>
              <h3>Change Groups</h3>
              <p>Change review is not available yet.</p>
            </section>
            <section>
              <h3>Diff</h3>
              <p>Select a Changed File when review is available.</p>
            </section>
          </section>
        )}
      </div>
    </main>
  );
}

function compareWorktrees(
  left: WorktreeOverviewSnapshot,
  right: WorktreeOverviewSnapshot,
): number {
  if (left.role !== right.role) return left.role === 'main' ? -1 : 1;
  const byName = left.displayName.localeCompare(right.displayName, 'en');
  if (byName !== 0) return byName;
  const byPath = left.path.localeCompare(right.path, 'en');
  if (byPath !== 0) return byPath;
  return left.worktreeId.localeCompare(right.worktreeId, 'en');
}

function keyboardTargetIndex(
  key: string,
  currentIndex: number,
  length: number,
): number | null {
  if (length === 0 || currentIndex < 0) return null;
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return (currentIndex + 1) % length;
    case 'ArrowUp':
    case 'ArrowLeft':
      return (currentIndex - 1 + length) % length;
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return null;
  }
}

function matchesSearch(
  worktree: WorktreeOverviewSnapshot,
  normalizedQuery: string,
): boolean {
  if (normalizedQuery.length === 0) return true;
  const branch =
    worktree.head.kind === 'local_branch' ? worktree.head.displayName : '';
  return [
    worktree.displayName,
    worktree.path,
    branch,
    worktree.codexTitle ?? '',
  ]
    .join('\n')
    .toLocaleLowerCase()
    .includes(normalizedQuery);
}

function headLabel(head: WorktreeOverviewSnapshot['head']): string {
  if (head.kind === 'initial') return 'Initial Repository State';
  if (head.kind === 'detached')
    return `Detached HEAD ${head.objectId.slice(0, 8)}`;
  return `Local Branch ${head.displayName}`;
}

function refreshLabel(refresh: RepositoryOverviewSnapshot['refresh']): string {
  switch (refresh.kind) {
    case 'current':
      return 'Current';
    case 'refreshing':
      return 'Refreshing';
    case 'stale':
      return `Stale — ${refresh.message}`;
    case 'failed':
      return `Refresh failed — ${refresh.message}`;
  }
}

function fetchLabel(
  fetch: import('./repository-overview-model.js').FetchFreshness,
): string {
  if (fetch.kind === 'never') return 'Never fetched';
  const time =
    fetch.fetchedAt === null
      ? 'No successful Fetch'
      : formatTime(fetch.fetchedAt);
  if (fetch.kind === 'current') return `Fetched ${time}`;
  return `${fetch.kind === 'stale' ? 'Stale' : 'Fetch failed'} — ${time}. ${fetch.message}`;
}

function fetchResultLabel(
  result: import('@codex-git/protocol').OperationResult,
): string {
  switch (result.kind) {
    case 'succeeded':
      return result.result.kind === 'remote'
        ? result.result.summary
        : 'Fetch succeeded.';
    case 'rejected':
    case 'failed_known':
    case 'unknown_outcome':
      return result.message;
    case 'partial_success':
      return result.message;
  }
}

function upstreamLabel(
  upstream: import('./repository-overview-model.js').UpstreamOverview,
): string {
  if (upstream.kind === 'tracking') {
    return upstream.ahead === null || upstream.behind === null
      ? `${upstream.displayName} · comparison unavailable`
      : `${upstream.displayName} · ${upstream.ahead} ahead, ${upstream.behind} behind (cached)`;
  }
  if (upstream.kind === 'unpublished') return 'Unpublished';
  return upstream.reason;
}

function upstreamFreshnessLabel(
  upstream: import('./repository-overview-model.js').UpstreamOverview,
): string {
  if (upstream.kind === 'not-applicable' || upstream.kind === 'unavailable') {
    return upstream.reason;
  }
  return upstream.fetchedAt === null
    ? 'No successful Fetch recorded'
    : `Cached from Fetch ${formatTime(upstream.fetchedAt)}`;
}

function statusLabel(status: WorktreeOverviewSnapshot['status']): string {
  switch (status.kind) {
    case 'clean':
      return 'Clean';
    case 'changed':
      return `${status.conflictCount} conflicts, ${status.stagedCount} staged, ${status.trackedChangeCount} changed, ${status.untrackedCount} untracked`;
    case 'in_progress':
      return `In-progress Git operation: ${status.operation}`;
    case 'unavailable':
      return `Unavailable — ${status.reason}`;
  }
}

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}

function operationLabel(
  operations: RepositoryOverviewSnapshot['operations'],
): string {
  if (operations.length === 0) return 'No active operations';
  return operations
    .map((operation) => {
      const category = operation.category.replace('_', ' ');
      const label = `${category[0]?.toLocaleUpperCase() ?? ''}${category.slice(1)}`;
      return `${label} ${operation.phase}${progressLabel(operation.progress)}`;
    })
    .join(', ');
}

function transitionLabel(
  transition: NonNullable<WorktreeOverviewSnapshot['transition']>,
): string {
  return `${transition.label}${progressLabel(transition.progress)}`;
}

function progressLabel(progress: number | null): string {
  return progress === null ? '' : ` · ${Math.round(progress * 100)}%`;
}
