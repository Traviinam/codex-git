import {
  fileIdSchema,
  refIdSchema,
  worktreeGenerationSchema,
  worktreeIdSchema,
  type BranchSearchResult,
} from '@codex-git/protocol';

import { manyWorktrees } from '../../apps/ui/src/overview-fixtures.js';
import type {
  RepositoryOverviewSnapshot,
  RepositoryOverviewSource,
  RepositoryOverviewSourceState,
  WorktreeOverviewSnapshot,
} from '../../apps/ui/src/repository-overview-model.js';
import { SUPPORTED_SCALE } from './release-envelope.js';

export interface SupportedScaleFixture {
  readonly branchSearch: BranchSearchResult;
  readonly source: RepositoryOverviewSource;
}

export function createSupportedScaleFixture(): SupportedScaleFixture {
  const snapshot = createSnapshot();
  const branchSearch = createBranchSearch(snapshot);
  const state: RepositoryOverviewSourceState = {
    kind: 'repository',
    snapshot,
  };
  const listeners = new Set<() => void>();

  const source: RepositoryOverviewSource = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestRefresh() {},
    requestFetch() {},
    async requestDiff(fileId) {
      return {
        kind: 'too_large',
        fileId,
        baseline: 'index_to_working_tree',
        byteCount: 2 * 1_024 * 1_024 + 1,
        lineCount: 20_001,
      };
    },
    async requestNativeAction() {
      return {
        kind: 'unavailable',
        message: 'Native actions are disabled in the supported-scale fixture.',
      };
    },
    async mutateFiles() {
      throw new Error('Mutations are disabled in the supported-scale fixture.');
    },
    async getCommitDraft(worktreeId) {
      return { worktreeId, revision: 0, text: '' };
    },
    async updateCommitDraft(request) {
      return {
        worktreeId: request.worktreeId,
        revision: request.expectedRevision + 1,
        text: request.update.kind === 'set' ? request.update.text : '',
      };
    },
    async commit() {
      throw new Error('Commit is disabled in the supported-scale fixture.');
    },
    async cancelOperation() {
      throw new Error(
        'Operation cancellation is disabled in the supported-scale fixture.',
      );
    },
    async recoverOperation() {
      throw new Error(
        'Operation recovery is disabled in the supported-scale fixture.',
      );
    },
    async searchBranches(_worktreeId, query) {
      const normalizedQuery = query.trim().toLocaleLowerCase();
      return {
        ...branchSearch,
        candidates:
          normalizedQuery.length === 0
            ? branchSearch.candidates
            : branchSearch.candidates.filter((candidate) =>
                candidate.displayName
                  .toLocaleLowerCase()
                  .includes(normalizedQuery),
              ),
      };
    },
    async switchBranch() {
      throw new Error(
        'Branch switching is disabled in the supported-scale fixture.',
      );
    },
    async requestRemoteOperation() {
      throw new Error(
        'Remote operations are disabled in the supported-scale fixture.',
      );
    },
  };

  return { branchSearch, source };
}

function createSnapshot(): RepositoryOverviewSnapshot {
  if (manyWorktrees.worktrees.length !== SUPPORTED_SCALE.availableWorktrees) {
    throw new Error(
      'The base overview fixture no longer contains 25 Worktrees.',
    );
  }

  let nextFile = 1;
  const filesPerWorktree =
    SUPPORTED_SCALE.changedFiles / SUPPORTED_SCALE.availableWorktrees;
  const availableWorktrees = manyWorktrees.worktrees.map(
    (worktree, worktreeIndex) => {
      const changes = Array.from({ length: filesPerWorktree }, (_, offset) => {
        const fileIndex = nextFile;
        nextFile += 1;
        return createChangedFile(fileIndex, worktreeIndex, offset);
      });

      return {
        ...worktree,
        worktreeRevision: 24,
        freshness: { kind: 'current' as const },
        status: {
          kind: 'changed' as const,
          conflictCount: filesPerWorktree / 4,
          stagedCount: filesPerWorktree / 4,
          trackedChangeCount: filesPerWorktree / 2,
          untrackedCount: filesPerWorktree / 4,
        },
        changes,
      };
    },
  );
  return {
    ...manyWorktrees,
    repositoryRevision: 24,
    topologyRevision: 24,
    refsRevision: 24,
    worktrees: [
      ...availableWorktrees,
      {
        ...availableWorktrees.at(-1)!,
        worktreeId: worktreeIdSchema.parse(
          'worktree_ffffffffffffffffffffffffffffffff',
        ),
        generation: worktreeGenerationSchema.parse(
          'generation_ffffffffffffffffffffffffffffffff',
        ),
        worktreeRevision: 1,
        displayName: 'unavailable-registration',
        path: '/private/tmp/codex-git-unavailable-registration',
        freshness: {
          kind: 'stale',
          message: 'Last successful observation retained.',
        },
        status: {
          kind: 'unavailable',
          reason: 'Working Tree path is temporarily unavailable.',
        },
        changes: [],
        nativeTargets: [],
        upstream: {
          kind: 'unavailable',
          reason: 'Upstream is unavailable with the Working Tree.',
        },
      },
    ],
  };
}

function createChangedFile(
  fileIndex: number,
  worktreeIndex: number,
  offset: number,
): WorktreeOverviewSnapshot['changes'][number] {
  const common = {
    fileId: fileIdSchema.parse(
      `file_${fileIndex.toString(16).padStart(32, '0')}`,
    ),
    displayPath: `src/worktree-${String(worktreeIndex + 1).padStart(2, '0')}/file-${String(offset + 1).padStart(4, '0')}.ts`,
    previousDisplayPath: null,
    nativeTargets: [],
  };

  switch (offset % 4) {
    case 0:
      return {
        ...common,
        kind: 'staged_change',
        baseline: 'head_to_index',
      };
    case 1:
      return {
        ...common,
        kind: 'change',
        baseline: 'index_to_working_tree',
      };
    case 2:
      return {
        ...common,
        kind: 'untracked',
        baseline: 'empty_to_working_tree',
      };
    default:
      return { ...common, kind: 'conflict', baseline: 'conflict' };
  }
}

function createBranchSearch(
  snapshot: RepositoryOverviewSnapshot,
): BranchSearchResult {
  return {
    refsRevision: snapshot.refsRevision,
    candidates: Array.from({ length: SUPPORTED_SCALE.refs }, (_, offset) => {
      const index = offset + 1;
      const local = index <= SUPPORTED_SCALE.refs / 2;
      return {
        refId: refIdSchema.parse(`ref_${index.toString(16).padStart(32, '0')}`),
        kind: local ? ('local' as const) : ('remote_tracking' as const),
        displayName: local
          ? `feature/release-${String(index).padStart(4, '0')}`
          : `origin/feature/release-${String(index - SUPPORTED_SCALE.refs / 2).padStart(4, '0')}`,
        occupiedBy:
          local && index <= snapshot.worktrees.length
            ? snapshot.worktrees[index - 1]!.worktreeId
            : null,
      };
    }),
  };
}
