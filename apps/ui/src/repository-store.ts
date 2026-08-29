import type { FileId, WorktreeId } from '@codex-git/protocol';

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
  readonly selectionNotice: string | null;
  readonly shouldRecoverWorktreeFocus: boolean;
}

export interface RepositoryStore {
  getSnapshot(): RepositoryStoreSnapshot;
  subscribe(listener: () => void): () => void;
  selectWorktree(worktreeId: WorktreeId): void;
  setSearchQuery(query: string): void;
  setCommitDraft(worktreeId: WorktreeId, draft: string): void;
  selectFile(fileId: FileId | null): void;
  requestRefresh(): void;
  requestFetch(
    remoteId: RepositoryOverviewSnapshot['remotes'][number]['remoteId'] | null,
  ): void;
}

export function createRepositoryStore(
  source: RepositoryOverviewSource,
): RepositoryStore {
  const listeners = new Set<() => void>();
  let sourceState = source.getSnapshot();
  const initialWorktree = selectInitialWorktree(sourceState);
  let selectedWorktreeId = initialWorktree?.worktreeId ?? null;
  let selectedGeneration = initialWorktree?.generation ?? null;
  let selectedHeadKey = headKey(initialWorktree);
  let searchQuery = '';
  let commitDrafts: Readonly<Record<string, string>> = {};
  let selectedFileId: FileId | null = null;
  let selectionNotice: string | null = null;
  let shouldRecoverWorktreeFocus = false;
  let storeSnapshot = buildSnapshot();

  source.subscribe(() => {
    const nextSource = source.getSnapshot();
    const selected = findWorktree(nextSource, selectedWorktreeId);
    const identityChanged =
      selected === null || selected.generation !== selectedGeneration;
    const branchChanged =
      selected !== null && headKey(selected) !== selectedHeadKey;

    sourceState = nextSource;
    if (identityChanged) {
      const replacement = selectInitialWorktree(nextSource);
      const previousSelection = selectedWorktreeId;
      selectedWorktreeId = replacement?.worktreeId ?? null;
      selectedGeneration = replacement?.generation ?? null;
      selectedHeadKey = headKey(replacement);
      selectedFileId = null;
      selectionNotice =
        previousSelection === null
          ? null
          : replacement === undefined
            ? 'The selected Worktree is no longer available.'
            : `The selected Worktree changed. ${replacement.displayName} is now selected.`;
      shouldRecoverWorktreeFocus = replacement !== undefined;
    } else if (branchChanged) {
      selectedHeadKey = headKey(selected);
      selectedFileId = null;
      selectionNotice =
        'Branch or HEAD changed; the previous file selection was cleared.';
      shouldRecoverWorktreeFocus = false;
    } else {
      selectionNotice = null;
      shouldRecoverWorktreeFocus = false;
    }
    emit();
  });

  return {
    getSnapshot: () => storeSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    selectWorktree(worktreeId) {
      const worktree = findWorktree(sourceState, worktreeId);
      if (worktree === null || worktree.worktreeId === selectedWorktreeId) {
        return;
      }
      selectedWorktreeId = worktree.worktreeId;
      selectedGeneration = worktree.generation;
      selectedHeadKey = headKey(worktree);
      selectedFileId = null;
      selectionNotice = null;
      shouldRecoverWorktreeFocus = false;
      emit();
    },
    setSearchQuery(query) {
      if (query === searchQuery) return;
      searchQuery = query;
      emit();
    },
    setCommitDraft(worktreeId, draft) {
      if (commitDrafts[worktreeId] === draft) return;
      commitDrafts = { ...commitDrafts, [worktreeId]: draft };
      emit();
    },
    selectFile(fileId) {
      if (selectedFileId === fileId) return;
      selectedFileId = fileId;
      emit();
    },
    requestRefresh: () => source.requestRefresh(),
    requestFetch: (remoteId) => source.requestFetch(remoteId),
  };

  function buildSnapshot(): RepositoryStoreSnapshot {
    return {
      source: sourceState,
      selectedWorktreeId,
      searchQuery,
      commitDrafts,
      selectedFileId,
      selectionNotice,
      shouldRecoverWorktreeFocus,
    };
  }

  function emit() {
    storeSnapshot = buildSnapshot();
    listeners.forEach((listener) => listener());
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

function headKey(worktree: WorktreeOverviewSnapshot | null | undefined) {
  if (worktree === null || worktree === undefined) return null;
  if (worktree.head.kind === 'initial') return 'initial';
  if (worktree.head.kind === 'detached') {
    return `detached:${worktree.head.objectId}`;
  }
  return `local_branch:${worktree.head.displayName}:${worktree.head.objectId}`;
}
