import type {
  BranchSearchResult,
  DiffResult,
  FileId,
  NativeActionRequest,
  NativeActionResult,
  OperationResult,
  RefId,
  RemoteId,
  WorktreeId,
} from '@codex-git/protocol';

export type DiffLoadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly fileId: FileId }
  | { readonly kind: 'loaded'; readonly result: DiffResult }
  | {
      readonly kind: 'failed';
      readonly fileId: FileId;
      readonly message: string;
    };

export type BranchPickerState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'loading'; readonly query: string }
  | {
      readonly kind: 'ready';
      readonly query: string;
      readonly refsRevision: number;
      readonly candidates: BranchSearchResult['candidates'];
      readonly switchingRefId: RefId | null;
      readonly message: string | null;
    }
  | {
      readonly kind: 'failed';
      readonly query: string;
      readonly message: string;
    };

export type RemoteOperationState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly operation: 'pull' | 'push' | 'publish';
    }
  | {
      readonly kind: 'result';
      readonly result: import('@codex-git/protocol').OperationResult;
    }
  | { readonly kind: 'failed'; readonly message: string };

export type CommitOperationState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly operationId: import('@codex-git/protocol').OperationId | null;
      readonly cancellationRequested: boolean;
    }
  | { readonly kind: 'result'; readonly result: OperationResult }
  | { readonly kind: 'failed'; readonly message: string };

import type {
  RepositoryOverviewSnapshot,
  RepositoryOverviewSource,
  RepositoryOverviewSourceState,
  WorktreeOverviewSnapshot,
} from './repository-overview-model.js';

export interface RepositoryStoreSnapshot {
  readonly source: RepositoryOverviewSourceState;
  readonly selectedWorktreeId: WorktreeId | null;
  readonly searchQuery: string;
  readonly commitDrafts: Readonly<Partial<Record<WorktreeId, string>>>;
  readonly selectedFileId: FileId | null;
  readonly diff: DiffLoadState;
  readonly selectionNotice: string | null;
  readonly focusRecoveryRevision: number;
  readonly branchPicker: BranchPickerState;
  readonly remoteOperation: RemoteOperationState;
  readonly fileMutationResult: OperationResult | null;
  readonly commitOperations: Readonly<
    Partial<Record<WorktreeId, CommitOperationState>>
  >;
}

export interface RepositoryStore {
  getSnapshot(): RepositoryStoreSnapshot;
  subscribe(listener: () => void): () => void;
  /** Releases the source subscription. The caller that creates a store owns this idempotent lifecycle. */
  dispose(): void;
  selectWorktree(worktreeId: WorktreeId): void;
  setSearchQuery(query: string): void;
  setCommitDraft(worktreeId: WorktreeId, draft: string): void;
  clearCommitDraft(worktreeId: WorktreeId): void;
  commit(confirmDetachedHead: boolean): void;
  cancelCommit(worktreeId: WorktreeId): void;
  recoverCommit(worktreeId: WorktreeId): void;
  selectFile(fileId: FileId | null): void;
  requestRefresh(): void;
  requestFetch(
    remoteId: RepositoryOverviewSnapshot['remotes'][number]['remoteId'] | null,
  ): void;
  requestNativeAction(
    request: NativeActionRequest,
  ): Promise<NativeActionResult>;
  mutateFiles(kind: 'stage' | 'unstage', fileIds: readonly FileId[]): void;
  openBranchPicker(): void;
  closeBranchPicker(): void;
  setBranchQuery(query: string): void;
  switchBranch(refId: RefId): void;
  pull(): void;
  push(): void;
  publish(remoteId: RemoteId): void;
}

export function createRepositoryStore(
  source: RepositoryOverviewSource,
): RepositoryStore {
  const listeners = new Set<() => void>();
  let sourceState = source.getSnapshot();
  const initialWorktree = selectInitialWorktree(sourceState);
  let selectedWorktreeId = initialWorktree?.worktreeId ?? null;
  let selectedGeneration = initialWorktree?.generation ?? null;
  let selectedHeadKey = headSelectionKey(initialWorktree);
  let searchQuery = '';
  let commitDrafts: Readonly<Partial<Record<WorktreeId, string>>> = {};
  const draftRevisions = new Map<WorktreeId, number>();
  const draftTouched = new Set<WorktreeId>();
  const draftLoads = new Map<WorktreeId, Promise<void>>();
  const draftWrites = new Map<WorktreeId, Promise<void>>();
  const draftWriteFailures = new Set<WorktreeId>();
  const commitSubmissions = new Map<
    WorktreeId,
    { readonly revision: number; readonly text: string }
  >();
  let selectedFileId: FileId | null = null;
  let diff: DiffLoadState = { kind: 'idle' };
  let diffRequestGeneration = 0;
  let selectionNotice: string | null = null;
  let focusRecoveryRevision = 0;
  let branchPicker: BranchPickerState = { kind: 'closed' };
  let branchRequestGeneration = 0;
  let remoteOperation: RemoteOperationState = { kind: 'idle' };
  let fileMutationResult: OperationResult | null = null;
  let commitOperations: Readonly<
    Partial<Record<WorktreeId, CommitOperationState>>
  > = {};
  let fileFollow:
    | { readonly displayPath: string; readonly kind: 'stage' | 'unstage' }
    | undefined;
  let storeSnapshot = buildSnapshot();
  let disposed = false;

  loadVisibleDrafts(sourceState);

  const unsubscribeSource = source.subscribe(() => {
    if (disposed) return;
    const nextSource = source.getSnapshot();
    const selected = findWorktree(nextSource, selectedWorktreeId);
    const identityChanged =
      selected === null || selected.generation !== selectedGeneration;
    const branchChanged =
      selected !== null && headSelectionKey(selected) !== selectedHeadKey;

    const inspectionReplacement = identityChanged
      ? refreshedUnavailableInspection(
          sourceState,
          nextSource,
          selectedWorktreeId,
        )
      : undefined;
    sourceState = nextSource;
    loadVisibleDrafts(nextSource);
    if (identityChanged) {
      const replacement =
        inspectionReplacement ?? selectInitialWorktree(nextSource);
      const previousSelection = selectedWorktreeId;
      selectedWorktreeId = replacement?.worktreeId ?? null;
      selectedGeneration = replacement?.generation ?? null;
      selectedHeadKey = headSelectionKey(replacement);
      selectedFileId = null;
      clearDiff();
      selectionNotice =
        previousSelection === null || inspectionReplacement !== undefined
          ? null
          : replacement === undefined
            ? 'The selected Worktree is no longer available.'
            : `The selected Worktree changed. ${replacement.displayName} is now selected.`;
      if (previousSelection !== null && inspectionReplacement === undefined)
        focusRecoveryRevision += 1;
      closeBranches();
    } else if (branchChanged) {
      selectedHeadKey = headSelectionKey(selected);
      selectedFileId = null;
      clearDiff();
      selectionNotice =
        'Branch or HEAD changed; the previous file selection was cleared.';
      closeBranches();
    } else if (
      selectedFileId !== null &&
      !selected.changes.some(({ fileId }) => fileId === selectedFileId)
    ) {
      const followed =
        fileFollow === undefined
          ? undefined
          : selected.changes.find(
              ({ displayPath, kind }) =>
                displayPath === fileFollow?.displayPath &&
                (fileFollow.kind === 'stage'
                  ? kind === 'staged_change'
                  : kind === 'change' || kind === 'untracked'),
            );
      selectedFileId = followed?.fileId ?? null;
      clearDiff();
      selectionNotice = followed
        ? `${followed.displayPath} moved to its new Change Group.`
        : 'Changed Files were refreshed; the previous file selection was cleared.';
      fileFollow = undefined;
    } else {
      selectionNotice = null;
    }
    emit();
  });

  return {
    getSnapshot: () => storeSnapshot,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      unsubscribeSource();
    },
    selectWorktree(worktreeId) {
      if (disposed) return;
      const worktree = findWorktree(sourceState, worktreeId);
      if (worktree === null || worktree.worktreeId === selectedWorktreeId) {
        return;
      }
      selectedWorktreeId = worktree.worktreeId;
      selectedGeneration = worktree.generation;
      selectedHeadKey = headSelectionKey(worktree);
      selectedFileId = null;
      clearDiff();
      selectionNotice = null;
      closeBranches();
      emit();
    },
    setSearchQuery(query) {
      if (disposed) return;
      if (query === searchQuery) return;
      searchQuery = query;
      emit();
    },
    setCommitDraft(worktreeId, draft) {
      if (disposed) return;
      if (commitDrafts[worktreeId] === draft) return;
      commitDrafts = { ...commitDrafts, [worktreeId]: draft };
      draftTouched.add(worktreeId);
      emit();
      queueDraftWrite(worktreeId);
    },
    clearCommitDraft(worktreeId) {
      if (disposed) return;
      commitDrafts = { ...commitDrafts, [worktreeId]: '' };
      draftTouched.add(worktreeId);
      emit();
      queueDraftWrite(worktreeId, true);
    },
    commit(confirmDetachedHead) {
      if (disposed || selectedWorktreeId === null) {
        return;
      }
      const worktree = findWorktree(sourceState, selectedWorktreeId);
      if (
        worktree === null ||
        commitOperations[worktree.worktreeId]?.kind === 'running'
      ) {
        return;
      }
      commitOperations = {
        ...commitOperations,
        [worktree.worktreeId]: {
          kind: 'running',
          operationId: null,
          cancellationRequested: false,
        },
      };
      emit();
      void (draftWrites.get(worktree.worktreeId) ?? Promise.resolve())
        .then(() => {
          if (draftWriteFailures.has(worktree.worktreeId)) {
            throw new Error('The Commit Draft could not be synchronized.');
          }
          const draftRevision = draftRevisions.get(worktree.worktreeId);
          if (draftRevision === undefined) {
            throw new Error('The Commit Draft is not synchronized.');
          }
          const submittedText = commitDrafts[worktree.worktreeId] ?? '';
          commitSubmissions.set(worktree.worktreeId, {
            revision: draftRevision,
            text: submittedText,
          });
          return source
            .commit(
              {
                worktreeId: worktree.worktreeId,
                expectedWorktreeRevision: worktree.worktreeRevision,
                draftRevision,
                confirmDetachedHead,
              },
              (operationId) => {
                if (
                  disposed ||
                  commitOperations[worktree.worktreeId]?.kind !== 'running'
                ) {
                  return;
                }
                commitOperations = {
                  ...commitOperations,
                  [worktree.worktreeId]: {
                    kind: 'running',
                    operationId,
                    cancellationRequested: false,
                  },
                };
                emit();
              },
            )
            .then((result) => ({
              result,
              submittedDraft: { revision: draftRevision, text: submittedText },
            }));
        })
        .then(({ result, submittedDraft }) => {
          if (disposed) return;
          commitOperations = {
            ...commitOperations,
            [worktree.worktreeId]: { kind: 'result', result },
          };
          if (
            result.kind === 'succeeded' &&
            draftRevisions.get(worktree.worktreeId) ===
              submittedDraft.revision &&
            (commitDrafts[worktree.worktreeId] ?? '') === submittedDraft.text
          ) {
            commitDrafts = { ...commitDrafts, [worktree.worktreeId]: '' };
            draftRevisions.set(
              worktree.worktreeId,
              submittedDraft.revision + 1,
            );
          }
          if (result.kind !== 'unknown_outcome') {
            commitSubmissions.delete(worktree.worktreeId);
          }
          emit();
        })
        .catch(() => {
          if (disposed) return;
          commitOperations = {
            ...commitOperations,
            [worktree.worktreeId]: {
              kind: 'failed',
              message: 'The Commit could not be submitted.',
            },
          };
          emit();
        });
    },
    cancelCommit(worktreeId) {
      const operation = commitOperations[worktreeId];
      if (
        disposed ||
        operation?.kind !== 'running' ||
        operation.operationId === null ||
        operation.cancellationRequested
      ) {
        return;
      }
      commitOperations = {
        ...commitOperations,
        [worktreeId]: { ...operation, cancellationRequested: true },
      };
      emit();
      void source.cancelOperation(operation.operationId).catch(() => {
        if (disposed) return;
        const current = commitOperations[worktreeId];
        if (current?.kind !== 'running') return;
        commitOperations = {
          ...commitOperations,
          [worktreeId]: { ...current, cancellationRequested: false },
        };
        emit();
      });
    },
    recoverCommit(worktreeId) {
      const operation = commitOperations[worktreeId];
      if (
        disposed ||
        operation?.kind !== 'result' ||
        operation.result.kind !== 'unknown_outcome'
      ) {
        return;
      }
      commitOperations = {
        ...commitOperations,
        [worktreeId]: {
          kind: 'running',
          operationId: null,
          cancellationRequested: false,
        },
      };
      emit();
      void source
        .recoverOperation(operation.result.operationId)
        .then(async (result) => {
          if (disposed) return;
          if (result.kind === 'succeeded' && result.result.kind === 'commit') {
            const submitted = commitSubmissions.get(worktreeId);
            if (submitted !== undefined) {
              await reconcileRecoveredDraft(worktreeId, submitted).catch(() => {
                selectionNotice =
                  'The Commit succeeded, but its Commit Draft could not be reloaded. Refresh and verify before editing.';
              });
            }
          }
          if (result.kind !== 'unknown_outcome') {
            commitSubmissions.delete(worktreeId);
          }
          commitOperations = {
            ...commitOperations,
            [worktreeId]: { kind: 'result', result },
          };
          emit();
        })
        .catch(() => {
          if (disposed) return;
          commitOperations = {
            ...commitOperations,
            [worktreeId]: {
              kind: 'failed',
              message: 'Commit recovery could not refresh the outcome.',
            },
          };
          emit();
        });
    },
    selectFile(fileId) {
      if (disposed) return;
      if (selectedFileId === fileId) return;
      selectedFileId = fileId;
      diffRequestGeneration += 1;
      const ownGeneration = diffRequestGeneration;
      if (fileId === null) {
        diff = { kind: 'idle' };
        emit();
        return;
      }
      diff = { kind: 'loading', fileId };
      emit();
      void source
        .requestDiff(fileId)
        .then((result) => {
          if (
            disposed ||
            ownGeneration !== diffRequestGeneration ||
            selectedFileId !== fileId
          ) {
            return;
          }
          diff = { kind: 'loaded', result };
          emit();
        })
        .catch(() => {
          if (
            disposed ||
            ownGeneration !== diffRequestGeneration ||
            selectedFileId !== fileId
          ) {
            return;
          }
          diff = {
            kind: 'failed',
            fileId,
            message: 'The Diff could not be loaded. Refresh and try again.',
          };
          emit();
        });
    },
    requestRefresh: () => {
      if (!disposed) source.requestRefresh();
    },
    requestFetch: (remoteId) => {
      if (!disposed) source.requestFetch(remoteId);
    },
    requestNativeAction: (request) =>
      disposed
        ? Promise.resolve({
            kind: 'unavailable',
            message: 'The Repository view is no longer active.',
          })
        : source.requestNativeAction(request),
    mutateFiles(kind, fileIds) {
      if (disposed || fileIds.length === 0 || selectedWorktreeId === null) {
        return;
      }
      const worktree = findWorktree(sourceState, selectedWorktreeId);
      if (worktree === null) return;
      const selectedChange = worktree.changes.find(
        ({ fileId }) => fileId === selectedFileId && fileIds.includes(fileId),
      );
      fileFollow =
        selectedChange === undefined
          ? undefined
          : { displayPath: selectedChange.displayPath, kind };
      void source
        .mutateFiles({
          kind,
          worktreeId: worktree.worktreeId,
          expectedWorktreeRevision: worktree.worktreeRevision,
          fileIds,
        })
        .then((result) => {
          if (disposed) return;
          fileMutationResult = result;
          emit();
        })
        .catch(() => {
          if (disposed) return;
          selectionNotice = 'The file mutation could not be submitted.';
          emit();
        })
        .finally(() => {
          fileFollow = undefined;
        });
    },
    openBranchPicker() {
      if (disposed || selectedWorktreeId === null) return;
      void loadBranches('');
    },
    closeBranchPicker() {
      if (disposed) return;
      closeBranches();
      emit();
    },
    setBranchQuery(query) {
      if (disposed || selectedWorktreeId === null) return;
      void loadBranches(query);
    },
    switchBranch(refId) {
      if (
        disposed ||
        selectedWorktreeId === null ||
        branchPicker.kind !== 'ready' ||
        branchPicker.switchingRefId !== null
      ) {
        return;
      }
      const worktree = findWorktree(sourceState, selectedWorktreeId);
      const candidate = branchPicker.candidates.find(
        (branch) => branch.refId === refId,
      );
      if (
        worktree === null ||
        candidate === undefined ||
        (candidate.occupiedBy !== null &&
          candidate.occupiedBy !== worktree.worktreeId)
      ) {
        return;
      }
      const currentPicker = branchPicker;
      branchPicker = { ...currentPicker, switchingRefId: refId, message: null };
      emit();
      void source
        .switchBranch({
          worktreeId: worktree.worktreeId,
          expectedWorktreeRevision: worktree.worktreeRevision,
          expectedRefsRevision: currentPicker.refsRevision,
          refId,
        })
        .then((result) => {
          if (disposed) return;
          if (result.kind === 'succeeded') {
            closeBranches();
            emit();
            return;
          }
          const message =
            'message' in result
              ? result.message
              : 'The Branch switch did not complete.';
          branchPicker = {
            ...currentPicker,
            switchingRefId: null,
            message,
          };
          emit();
          void loadBranches(currentPicker.query);
        })
        .catch(() => {
          if (disposed) return;
          branchPicker = {
            ...currentPicker,
            switchingRefId: null,
            message: 'The Branch switch could not be submitted.',
          };
          emit();
        });
    },
    pull() {
      void runRemoteOperation('pull');
    },
    push() {
      void runRemoteOperation('push');
    },
    publish(remoteId) {
      void runRemoteOperation('publish', remoteId);
    },
  };

  async function runRemoteOperation(
    kind: 'pull' | 'push' | 'publish',
    remoteId?: RemoteId,
  ) {
    if (
      disposed ||
      remoteOperation.kind === 'running' ||
      sourceState.kind !== 'repository' ||
      selectedWorktreeId === null
    ) {
      return;
    }
    const worktree = sourceState.snapshot.worktrees.find(
      (candidate) => candidate.worktreeId === selectedWorktreeId,
    );
    if (
      worktree === undefined ||
      (kind === 'publish' && remoteId === undefined)
    ) {
      return;
    }
    remoteOperation = { kind: 'running', operation: kind };
    emit();
    try {
      const result = await source.requestRemoteOperation({
        kind,
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        expectedRefsRevision: sourceState.snapshot.refsRevision,
        remoteId,
      });
      if (disposed) return;
      remoteOperation = { kind: 'result', result };
      emit();
    } catch {
      if (disposed) return;
      remoteOperation = {
        kind: 'failed',
        message: 'The Remote operation could not be submitted.',
      };
      emit();
    }
  }

  async function loadBranches(query: string) {
    const worktreeId = selectedWorktreeId;
    if (worktreeId === null) return;
    const ownGeneration = ++branchRequestGeneration;
    branchPicker = { kind: 'loading', query };
    emit();
    try {
      const result = await source.searchBranches(worktreeId, query);
      if (
        disposed ||
        ownGeneration !== branchRequestGeneration ||
        selectedWorktreeId !== worktreeId
      ) {
        return;
      }
      branchPicker = {
        kind: 'ready',
        query,
        refsRevision: result.refsRevision,
        candidates: result.candidates,
        switchingRefId: null,
        message: null,
      };
      emit();
    } catch {
      if (disposed || ownGeneration !== branchRequestGeneration) return;
      branchPicker = {
        kind: 'failed',
        query,
        message: 'Cached Branches could not be loaded.',
      };
      emit();
    }
  }

  function closeBranches() {
    branchRequestGeneration += 1;
    branchPicker = { kind: 'closed' };
  }

  function buildSnapshot(): RepositoryStoreSnapshot {
    return {
      source: sourceState,
      selectedWorktreeId,
      searchQuery,
      commitDrafts,
      selectedFileId,
      diff,
      selectionNotice,
      focusRecoveryRevision,
      branchPicker,
      remoteOperation,
      fileMutationResult,
      commitOperations,
    };
  }

  function emit() {
    storeSnapshot = buildSnapshot();
    listeners.forEach((listener) => listener());
  }

  function clearDiff() {
    diffRequestGeneration += 1;
    diff = { kind: 'idle' };
  }

  function loadVisibleDrafts(next: RepositoryOverviewSourceState) {
    if (next.kind !== 'repository') return;
    for (const worktree of next.snapshot.worktrees) {
      if (draftRevisions.has(worktree.worktreeId)) continue;
      if (draftLoads.has(worktree.worktreeId)) continue;
      const load = source
        .getCommitDraft(worktree.worktreeId)
        .then((draft) => {
          if (disposed) return;
          draftRevisions.set(worktree.worktreeId, draft.revision);
          if (!draftTouched.has(worktree.worktreeId)) {
            commitDrafts = {
              ...commitDrafts,
              [worktree.worktreeId]: draft.text,
            };
            emit();
          }
          if (draftTouched.has(worktree.worktreeId)) {
            queueDraftWrite(worktree.worktreeId);
          }
        })
        .catch(() => {
          draftWriteFailures.add(worktree.worktreeId);
        })
        .finally(() => draftLoads.delete(worktree.worktreeId));
      draftLoads.set(worktree.worktreeId, load);
    }
  }

  function queueDraftWrite(worktreeId: WorktreeId, clear = false) {
    if (draftWrites.has(worktreeId)) return;
    const write = async () => {
      await draftLoads.get(worktreeId);
      while (!disposed) {
        const expectedRevision = draftRevisions.get(worktreeId);
        if (expectedRevision === undefined) {
          throw new Error('The Commit Draft revision is unavailable.');
        }
        const text = commitDrafts[worktreeId] ?? '';
        let draft;
        try {
          draft = await source.updateCommitDraft({
            worktreeId,
            expectedRevision,
            update:
              clear && text.length === 0
                ? { kind: 'clear' }
                : { kind: 'set', text },
          });
        } catch {
          const current = await source.getCommitDraft(worktreeId);
          draftRevisions.set(worktreeId, current.revision);
          draft = await source.updateCommitDraft({
            worktreeId,
            expectedRevision: current.revision,
            update:
              clear && text.length === 0
                ? { kind: 'clear' }
                : { kind: 'set', text },
          });
        }
        draftRevisions.set(worktreeId, draft.revision);
        draftWriteFailures.delete(worktreeId);
        if ((commitDrafts[worktreeId] ?? '') === draft.text) return;
        clear = false;
      }
    };
    const pending = write()
      .catch(() => {
        draftWriteFailures.add(worktreeId);
        selectionNotice =
          'The Commit Draft could not be synchronized. Commit remains unavailable.';
        emit();
      })
      .finally(() => draftWrites.delete(worktreeId));
    draftWrites.set(worktreeId, pending);
  }

  async function reconcileRecoveredDraft(
    worktreeId: WorktreeId,
    submitted: { readonly revision: number; readonly text: string },
  ) {
    await draftWrites.get(worktreeId);
    const backend = await source.getCommitDraft(worktreeId);
    if (disposed) return;
    const localText = commitDrafts[worktreeId] ?? '';
    const unchanged =
      draftRevisions.get(worktreeId) === submitted.revision &&
      localText === submitted.text;
    draftRevisions.set(worktreeId, backend.revision);
    if (unchanged) {
      commitDrafts = { ...commitDrafts, [worktreeId]: backend.text };
      return;
    }
    if (backend.text !== localText) {
      draftTouched.add(worktreeId);
      queueDraftWrite(worktreeId);
    }
  }
}

// Preserve only the inspection location, never an opaque operation identity.
function refreshedUnavailableInspection(
  previous: RepositoryOverviewSourceState,
  next: RepositoryOverviewSourceState,
  selectedId: WorktreeId | null,
): WorktreeOverviewSnapshot | undefined {
  if (
    previous.kind !== 'repository' ||
    next.kind !== 'repository' ||
    previous.snapshot.repositoryId !== next.snapshot.repositoryId
  )
    return undefined;
  const prior = findWorktree(previous, selectedId);
  const unavailable = (worktree: WorktreeOverviewSnapshot) =>
    worktree.availability === undefined
      ? worktree.status.kind === 'unavailable'
      : worktree.availability.kind === 'unavailable';
  if (prior === null || !unavailable(prior)) return undefined;
  const candidates = next.snapshot.worktrees.filter(
    (worktree) =>
      worktree.path === prior.path &&
      worktree.role === prior.role &&
      unavailable(worktree),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function findWorktree(
  source: RepositoryOverviewSourceState,
  worktreeId: WorktreeId | null,
): WorktreeOverviewSnapshot | null {
  if (source.kind !== 'repository' || worktreeId === null) return null;
  return (
    source.snapshot.worktrees.find(
      (worktree) => worktree.worktreeId === worktreeId,
    ) ?? null
  );
}

function selectInitialWorktree(
  source: RepositoryOverviewSourceState,
): WorktreeOverviewSnapshot | undefined {
  if (source.kind !== 'repository') return undefined;
  return (
    source.snapshot.worktrees.find((worktree) => worktree.role === 'main') ??
    source.snapshot.worktrees[0]
  );
}

function headSelectionKey(
  worktree: WorktreeOverviewSnapshot | null | undefined,
) {
  if (worktree === null || worktree === undefined) return null;
  if (worktree.head.kind === 'initial') return 'initial';
  if (worktree.head.kind === 'detached') {
    return `detached:${worktree.head.objectId}`;
  }
  return `local_branch:${worktree.head.displayName}`;
}
