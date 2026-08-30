import type {
  BranchSearchResult,
  DiffResult,
  FileId,
  NativeActionRequest,
  NativeActionResult,
  RefId,
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
  readonly commitDrafts: Readonly<Record<string, string>>;
  readonly selectedFileId: FileId | null;
  readonly diff: DiffLoadState;
  readonly selectionNotice: string | null;
  readonly focusRecoveryRevision: number;
  readonly branchPicker: BranchPickerState;
}

export interface RepositoryStore {
  getSnapshot(): RepositoryStoreSnapshot;
  subscribe(listener: () => void): () => void;
  /** Releases the source subscription. The caller that creates a store owns this idempotent lifecycle. */
  dispose(): void;
  selectWorktree(worktreeId: WorktreeId): void;
  setSearchQuery(query: string): void;
  setCommitDraft(worktreeId: WorktreeId, draft: string): void;
  selectFile(fileId: FileId | null): void;
  requestRefresh(): void;
  requestFetch(
    remoteId: RepositoryOverviewSnapshot['remotes'][number]['remoteId'] | null,
  ): void;
  requestNativeAction(
    request: NativeActionRequest,
  ): Promise<NativeActionResult>;
  openBranchPicker(): void;
  closeBranchPicker(): void;
  setBranchQuery(query: string): void;
  switchBranch(refId: RefId): void;
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
  let commitDrafts: Readonly<Record<string, string>> = {};
  let selectedFileId: FileId | null = null;
  let diff: DiffLoadState = { kind: 'idle' };
  let diffRequestGeneration = 0;
  let selectionNotice: string | null = null;
  let focusRecoveryRevision = 0;
  let branchPicker: BranchPickerState = { kind: 'closed' };
  let branchRequestGeneration = 0;
  let storeSnapshot = buildSnapshot();
  let disposed = false;

  const unsubscribeSource = source.subscribe(() => {
    if (disposed) return;
    const nextSource = source.getSnapshot();
    const selected = findWorktree(nextSource, selectedWorktreeId);
    const identityChanged =
      selected === null || selected.generation !== selectedGeneration;
    const branchChanged =
      selected !== null && headSelectionKey(selected) !== selectedHeadKey;

    sourceState = nextSource;
    if (identityChanged) {
      const replacement = selectInitialWorktree(nextSource);
      const previousSelection = selectedWorktreeId;
      selectedWorktreeId = replacement?.worktreeId ?? null;
      selectedGeneration = replacement?.generation ?? null;
      selectedHeadKey = headSelectionKey(replacement);
      selectedFileId = null;
      clearDiff();
      selectionNotice =
        previousSelection === null
          ? null
          : replacement === undefined
            ? 'The selected Worktree is no longer available.'
            : `The selected Worktree changed. ${replacement.displayName} is now selected.`;
      if (previousSelection !== null) focusRecoveryRevision += 1;
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
      selectedFileId = null;
      clearDiff();
      selectionNotice =
        'Changed Files were refreshed; the previous file selection was cleared.';
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
      emit();
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
  };

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
