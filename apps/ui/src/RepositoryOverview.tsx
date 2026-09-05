import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type {
  NativeActionRequest,
  NativeActionResult,
} from '@codex-git/protocol';

import type {
  RepositoryOverviewSnapshot,
  WorktreeOverviewSnapshot,
} from './repository-overview-model.js';
import type {
  RemoteOperationState,
  RepositoryStore,
} from './repository-store.js';
import { ChangeGroups } from './ChangeGroups.js';
import { DiffReview } from './DiffReview.js';
import {
  nativeActionLabel,
  performPresentedNativeAction,
  worktreeNativeActionLabel,
} from './native-action-presentation.js';

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
  const branchPicker = state.branchPicker;
  const worktreeButtons = useRef(new Map<string, HTMLButtonElement>());
  const searchInput = useRef<HTMLInputElement>(null);
  const worktreeTitle = useRef<HTMLHeadingElement>(null);
  const handledFocusRecovery = useRef(0);
  const [nativeActionStatus, setNativeActionStatus] = useState<{
    readonly worktreeId: string;
    readonly message: string;
  } | null>(null);
  const [detachedCommitConfirmation, setDetachedCommitConfirmation] = useState({
    key: '',
    confirmed: false,
  });
  const detachedCommitConfirmationKey = selectedHeadKeyForConfirmation(state);
  const detachedCommitConfirmed =
    detachedCommitConfirmation.key === detachedCommitConfirmationKey &&
    detachedCommitConfirmation.confirmed;
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
  const selectedCommitOperation =
    selected === undefined
      ? ({ kind: 'idle' } as const)
      : (state.commitOperations[selected.worktreeId] ??
        ({ kind: 'idle' } as const));
  const selectedBranchName =
    selected?.head.kind === 'local_branch' ? selected.head.displayName : null;
  const selectedTerminalTarget = selected?.nativeTargets.find(({ actions }) =>
    actions.includes('open_terminal'),
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
                <li
                  key={
                    (
                      worktree.availability === undefined
                        ? worktree.status.kind === 'unavailable'
                        : worktree.availability.kind === 'unavailable'
                    )
                      ? JSON.stringify([
                          snapshot.repositoryId,
                          worktree.role,
                          worktree.path,
                          'unavailable',
                        ])
                      : worktree.worktreeId
                  }
                >
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
                <dt>Provenance</dt>
                <dd>{provenanceLabel(selected.provenance)}</dd>
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
              {selected.nativeTargets.flatMap((target) =>
                target.actions.map((kind) => (
                  <button
                    aria-label={worktreeNativeActionLabel(
                      kind,
                      selected.displayName,
                    )}
                    key={`${target.targetId}:${kind}`}
                    type="button"
                    onClick={() =>
                      void performWorktreeNativeAction(
                        { kind, targetId: target.targetId },
                        store.requestNativeAction,
                        (message) =>
                          setNativeActionStatus({
                            worktreeId: selected.worktreeId,
                            message,
                          }),
                      )
                    }
                  >
                    {nativeActionLabel(kind)}
                  </button>
                )),
              )}
              <button
                aria-label={`Switch Branch for ${selected.displayName}`}
                type="button"
                disabled={!branchSwitchAllowed(selected, snapshot.operations)}
                onClick={() => store.openBranchPicker()}
              >
                Switch Branch
              </button>
              {selected.upstream.kind === 'tracking' ? (
                <>
                  <button
                    aria-label={`Pull ${selected.upstream.displayName} into ${selected.displayName}`}
                    type="button"
                    disabled={
                      !pullAllowed(selected, snapshot.operations) ||
                      state.remoteOperation.kind === 'running'
                    }
                    onClick={() => store.pull()}
                  >
                    Pull {selected.upstream.displayName}
                  </button>
                  <button
                    aria-label={`Push ${selected.displayName} to ${selected.upstream.displayName}`}
                    type="button"
                    disabled={
                      !pushAllowed(selected, snapshot.operations) ||
                      state.remoteOperation.kind === 'running'
                    }
                    title={
                      selected.status.kind === 'changed'
                        ? 'Only committed history is pushed; uncommitted content stays local.'
                        : undefined
                    }
                    onClick={() => store.push()}
                  >
                    Push {selected.upstream.displayName}
                  </button>
                  {selected.status.kind === 'changed' ? (
                    <small>
                      Uncommitted content stays local and is not included in
                      Push.
                    </small>
                  ) : null}
                </>
              ) : selected.upstream.kind === 'unpublished' &&
                selectedBranchName !== null ? (
                snapshot.remotes.map((remote) => {
                  const target = `${remote.displayName}/${selectedBranchName}`;
                  return (
                    <button
                      aria-label={`Publish ${selectedBranchName} to ${target}`}
                      type="button"
                      key={remote.remoteId}
                      disabled={
                        !publishAllowed(selected, snapshot.operations) ||
                        state.remoteOperation.kind === 'running'
                      }
                      onClick={() => {
                        if (
                          globalThis.confirm(
                            `Publish Local Branch ${selectedBranchName} to exact target ${target}?`,
                          )
                        ) {
                          store.publish(remote.remoteId);
                        }
                      }}
                    >
                      Publish to {target}
                    </button>
                  );
                })
              ) : null}
            </div>
            {nativeActionStatus?.worktreeId !== selected.worktreeId ? null : (
              <p aria-live="polite" role="status">
                {nativeActionStatus.message}
              </p>
            )}
            {selected.upstream.kind === 'tracking' &&
            (selected.upstream.ahead ?? 0) > 0 &&
            (selected.upstream.behind ?? 0) > 0 ? (
              <section aria-label="Diverged Upstream guidance">
                <p>
                  This Local Branch and its Upstream diverged. Open the exact
                  selected Worktree in Terminal to Merge or Rebase explicitly.
                </p>
                {selectedTerminalTarget === undefined ? null : (
                  <button
                    aria-label={`Open ${selected.displayName} in Terminal`}
                    type="button"
                    onClick={() => {
                      void store.requestNativeAction({
                        kind: 'open_terminal',
                        targetId: selectedTerminalTarget.targetId,
                      });
                    }}
                  >
                    Open {selected.displayName} in Terminal
                  </button>
                )}
              </section>
            ) : null}
            {state.remoteOperation.kind === 'idle' ? null : (
              <p aria-live="polite" role="status">
                {remoteOperationLabel(state.remoteOperation)}
              </p>
            )}
            {branchPicker.kind === 'closed' ? null : (
              <section aria-label={`Switch Branch for ${selected.displayName}`}>
                <h3>Switch Branch</h3>
                <label>
                  Search cached Branches
                  <input
                    type="search"
                    value={branchPicker.query}
                    onChange={(event) =>
                      store.setBranchQuery(event.currentTarget.value)
                    }
                  />
                </label>
                <button type="button" onClick={() => store.closeBranchPicker()}>
                  Close
                </button>
                {branchPicker.kind === 'loading' ? (
                  <p role="status">Loading cached Branches…</p>
                ) : branchPicker.kind === 'failed' ? (
                  <p role="alert">{branchPicker.message}</p>
                ) : (
                  <>
                    {branchPicker.message === null ? null : (
                      <p role="alert">{branchPicker.message}</p>
                    )}
                    {(['local', 'remote_tracking'] as const).map((kind) => {
                      const branches = branchPicker.candidates.filter(
                        (candidate) => candidate.kind === kind,
                      );
                      return (
                        <section key={kind}>
                          <h4>
                            {kind === 'local'
                              ? 'Local Branches'
                              : 'Remote-tracking Branches'}
                          </h4>
                          {branches.length === 0 ? (
                            <p>No matching Branches.</p>
                          ) : (
                            <ul>
                              {branches.map((branch) => {
                                const occupiedElsewhere =
                                  branch.occupiedBy !== null &&
                                  branch.occupiedBy !== selected.worktreeId;
                                const occupyingWorktree =
                                  branch.occupiedBy === null
                                    ? undefined
                                    : snapshot.worktrees.find(
                                        ({ worktreeId }) =>
                                          worktreeId === branch.occupiedBy,
                                      );
                                return (
                                  <li key={branch.refId}>
                                    <button
                                      aria-label={`Switch ${selected.displayName} to ${branch.displayName}`}
                                      disabled={
                                        occupiedElsewhere ||
                                        branchPicker.switchingRefId !== null
                                      }
                                      type="button"
                                      onClick={() =>
                                        store.switchBranch(branch.refId)
                                      }
                                    >
                                      {branch.displayName}
                                    </button>
                                    {branch.warning == null ? null : (
                                      <span role="note">{branch.warning}</span>
                                    )}
                                    {!occupiedElsewhere ? null : (
                                      <>
                                        <span>
                                          Occupied by{' '}
                                          {occupyingWorktree?.displayName ??
                                            'another Worktree'}
                                        </span>
                                        <button
                                          aria-label={`Go to Worktree occupying ${branch.displayName}`}
                                          type="button"
                                          onClick={() => {
                                            if (branch.occupiedBy !== null) {
                                              store.selectWorktree(
                                                branch.occupiedBy,
                                              );
                                            }
                                          }}
                                        >
                                          Go to Worktree
                                        </button>
                                      </>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </section>
                      );
                    })}
                  </>
                )}
              </section>
            )}
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
            <section
              aria-label={`Commit staged changes in ${selected.displayName}`}
            >
              <h3>Commit staged changes</h3>
              <dl>
                <div>
                  <dt>Worktree</dt>
                  <dd>{selected.path}</dd>
                </div>
                <div>
                  <dt>HEAD</dt>
                  <dd>{commitHeadLabel(selected)}</dd>
                </div>
                <div>
                  <dt>Staged Changes</dt>
                  <dd>{stagedCount(selected)}</dd>
                </div>
              </dl>
              <button
                aria-label={`Clear Commit Draft for ${selected.displayName}`}
                type="button"
                onClick={() => store.clearCommitDraft(selected.worktreeId)}
              >
                Clear Commit Draft
              </button>
              {selected.head.kind !== 'detached' ? null : (
                <label role="alert">
                  <input
                    type="checkbox"
                    checked={detachedCommitConfirmed}
                    onChange={(event) =>
                      setDetachedCommitConfirmation({
                        key: detachedCommitConfirmationKey,
                        confirmed: event.currentTarget.checked,
                      })
                    }
                  />
                  I understand this Commit will be created on Detached HEAD and
                  may not be reachable from a Branch.
                </label>
              )}
              <button
                aria-label={`Commit staged changes in ${selected.displayName}`}
                type="button"
                disabled={
                  !commitAllowed(
                    selected,
                    state.commitDrafts[selected.worktreeId] ?? '',
                    selectedCommitOperation,
                    detachedCommitConfirmed,
                  )
                }
                onClick={() => store.commit(detachedCommitConfirmed)}
              >
                Commit {stagedCount(selected)} staged{' '}
                {stagedCount(selected) === 1 ? 'change' : 'changes'}
              </button>
              {selectedCommitOperation.kind === 'idle' ? null : (
                <p aria-live="polite" role="status">
                  {commitOperationLabel(selectedCommitOperation)}
                </p>
              )}
              {selectedCommitOperation.kind === 'running' &&
              selectedCommitOperation.operationId !== null ? (
                <button
                  aria-label={`Cancel Commit in ${selected.displayName}`}
                  disabled={selectedCommitOperation.cancellationRequested}
                  type="button"
                  onClick={() => store.cancelCommit(selected.worktreeId)}
                >
                  {selectedCommitOperation.cancellationRequested
                    ? 'Cancelling Commit…'
                    : 'Cancel Commit'}
                </button>
              ) : null}
              {selectedCommitOperation.kind === 'result' &&
              selectedCommitOperation.result.kind === 'unknown_outcome' ? (
                <button
                  aria-label={`Recover Commit outcome for ${selected.displayName}`}
                  type="button"
                  onClick={() => store.recoverCommit(selected.worktreeId)}
                >
                  Re-check Commit outcome
                </button>
              ) : null}
            </section>
            <section>
              <h3>Change Groups</h3>
              <ChangeGroups
                worktree={selected}
                selectedFileId={state.selectedFileId}
                onSelect={(fileId) => store.selectFile(fileId)}
                onMutate={(kind, fileIds) => store.mutateFiles(kind, fileIds)}
              />
              {state.fileMutationResult === null ? null : (
                <section aria-live="polite" role="status">
                  <h4>File operation result</h4>
                  {'message' in state.fileMutationResult ? (
                    <p>{state.fileMutationResult.message}</p>
                  ) : (
                    <p>Changed Files updated.</p>
                  )}
                  {'effects' in state.fileMutationResult &&
                  state.fileMutationResult.effects !== undefined ? (
                    <ul>
                      {state.fileMutationResult.effects.map((effect) => (
                        <li key={effect.label}>
                          {effect.label} —{' '}
                          {effect.kind === 'succeeded'
                            ? 'Succeeded'
                            : `Failed: ${effect.message}`}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              )}
            </section>
            <section>
              <h3>Diff</h3>
              <DiffReview
                worktree={selected}
                selectedFileId={state.selectedFileId}
                diff={state.diff}
                onSelect={(fileId) => store.selectFile(fileId)}
                onNativeAction={(request) => store.requestNativeAction(request)}
              />
            </section>
          </section>
        )}
      </div>
    </main>
  );
}

function branchSwitchAllowed(
  worktree: WorktreeOverviewSnapshot,
  operations: RepositoryOverviewSnapshot['operations'],
): boolean {
  return (
    (worktree.availability === undefined ||
      worktree.availability.kind === 'available') &&
    worktree.freshness.kind === 'current' &&
    worktree.status.kind === 'clean' &&
    !operations.some(
      ({ category, phase }) =>
        category === 'branch_switch' && phase !== 'terminal',
    )
  );
}

function stagedCount(worktree: WorktreeOverviewSnapshot): number {
  return worktree.status.kind === 'changed' ? worktree.status.stagedCount : 0;
}

function commitHeadLabel(worktree: WorktreeOverviewSnapshot): string {
  if (worktree.head.kind === 'initial') return 'Initial Repository State';
  if (worktree.head.kind === 'detached') {
    return `Detached HEAD at ${worktree.head.objectId.slice(0, 7)}`;
  }
  return `Local Branch ${worktree.head.displayName}`;
}

function commitAllowed(
  worktree: WorktreeOverviewSnapshot,
  draft: string,
  state: import('./repository-store.js').CommitOperationState,
  detachedConfirmed: boolean,
): boolean {
  return (
    worktree.availability?.kind !== 'unavailable' &&
    worktree.freshness.kind === 'current' &&
    worktree.status.kind === 'changed' &&
    worktree.status.conflictCount === 0 &&
    worktree.status.stagedCount > 0 &&
    draft.trim().length > 0 &&
    state.kind !== 'running' &&
    !(state.kind === 'result' && state.result.kind === 'unknown_outcome') &&
    (worktree.head.kind !== 'detached' || detachedConfirmed)
  );
}

function commitOperationLabel(
  state: import('./repository-store.js').CommitOperationState,
): string {
  if (state.kind === 'idle') return '';
  if (state.kind === 'running') {
    return state.cancellationRequested
      ? 'Cancelling Commit and reconciling Git state…'
      : 'Creating Commit…';
  }
  if (state.kind === 'failed') return state.message;
  if (
    state.result.kind === 'succeeded' &&
    state.result.result.kind === 'commit'
  ) {
    return `Committed ${state.result.result.shortObjectId}: ${state.result.result.summary}`;
  }
  return 'message' in state.result
    ? state.result.message
    : 'The Commit operation finished.';
}

function selectedHeadKeyForConfirmation(
  state: import('./repository-store.js').RepositoryStoreSnapshot,
): string {
  if (state.source.kind !== 'repository') return '';
  const selected = state.source.snapshot.worktrees.find(
    ({ worktreeId }) => worktreeId === state.selectedWorktreeId,
  );
  if (selected?.head.kind !== 'detached') return selected?.head.kind ?? '';
  return `${selected.worktreeId}:${selected.generation}:${selected.head.objectId}`;
}

function pullAllowed(
  worktree: WorktreeOverviewSnapshot,
  operations: RepositoryOverviewSnapshot['operations'],
): boolean {
  return (
    worktree.head.kind === 'local_branch' &&
    worktree.upstream.kind === 'tracking' &&
    worktree.upstream.ahead === 0 &&
    (worktree.upstream.behind ?? 0) > 0 &&
    worktree.status.kind === 'clean' &&
    worktree.freshness.kind === 'current' &&
    !remoteOperationActive(operations)
  );
}

function pushAllowed(
  worktree: WorktreeOverviewSnapshot,
  operations: RepositoryOverviewSnapshot['operations'],
): boolean {
  return (
    worktree.head.kind === 'local_branch' &&
    worktree.upstream.kind === 'tracking' &&
    worktree.upstream.behind === 0 &&
    worktree.upstream.ahead !== null &&
    worktree.freshness.kind === 'current' &&
    statusAllowsRemoteWrite(worktree.status) &&
    !remoteOperationActive(operations)
  );
}

function publishAllowed(
  worktree: WorktreeOverviewSnapshot,
  operations: RepositoryOverviewSnapshot['operations'],
): boolean {
  return (
    worktree.head.kind === 'local_branch' &&
    worktree.upstream.kind === 'unpublished' &&
    worktree.freshness.kind === 'current' &&
    statusAllowsRemoteWrite(worktree.status) &&
    !remoteOperationActive(operations)
  );
}

function statusAllowsRemoteWrite(status: WorktreeOverviewSnapshot['status']) {
  return (
    status.kind === 'clean' ||
    (status.kind === 'changed' && status.conflictCount === 0)
  );
}

function remoteOperationActive(
  operations: RepositoryOverviewSnapshot['operations'],
) {
  return operations.some(
    ({ category, phase }) =>
      phase !== 'terminal' &&
      (category === 'fetch' ||
        category === 'pull' ||
        category === 'push' ||
        category === 'publish'),
  );
}

function remoteOperationLabel(state: RemoteOperationState): string {
  if (state.kind === 'idle') return '';
  if (state.kind === 'running') {
    return `${state.operation[0]!.toLocaleUpperCase()}${state.operation.slice(1)} in progress…`;
  }
  if (state.kind === 'failed') return state.message;
  const result = state.result;
  if (result.kind === 'succeeded') {
    return result.result.kind === 'remote'
      ? result.result.summary
      : 'The Remote is already up to date.';
  }
  return result.message;
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
    worktree.provenance.kind === 'codex_task' ? worktree.provenance.title : '',
  ]
    .join('\n')
    .toLocaleLowerCase()
    .includes(normalizedQuery);
}

function provenanceLabel(
  provenance: WorktreeOverviewSnapshot['provenance'],
): string {
  switch (provenance.kind) {
    case 'codex_task':
      return `Codex Task Worktree — ${provenance.title} (${provenance.status})`;
    case 'scheduled':
      return 'Scheduled Worktree';
    case 'permanent':
      return 'Permanent Worktree';
    case 'external':
      return 'External Worktree';
    case 'unclassified':
      return 'Unclassified Worktree';
  }
}

async function performWorktreeNativeAction(
  request: NativeActionRequest,
  run: (request: NativeActionRequest) => Promise<NativeActionResult>,
  publish: (message: string) => void,
): Promise<void> {
  return performPresentedNativeAction(request, run, publish, {
    performed: () => 'Opened the exact Worktree target.',
    copyFallback: (_current, text) => `Value: ${text}`,
    copied: () => 'Copied the exact Worktree value.',
    failed: 'The exact target is unavailable. Refresh and try again.',
  });
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
