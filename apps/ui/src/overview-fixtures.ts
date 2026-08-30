import {
  fileIdSchema,
  nativeTargetIdSchema,
  operationIdSchema,
  remoteIdSchema,
  repositoryIdSchema,
  worktreeGenerationSchema,
  worktreeIdSchema,
} from '@codex-git/protocol';

import type {
  RepositoryOverviewSnapshot,
  RepositoryOverviewSource,
  RepositoryOverviewSourceState,
} from './repository-overview-model.js';

export interface OverviewFixture {
  readonly source: RepositoryOverviewSource;
  publish(state: RepositoryOverviewSourceState): void;
  readonly requests: {
    readonly refresh: number;
    readonly fetch: readonly (string | null)[];
    readonly diff: readonly string[];
  };
}

export function createOverviewFixture(
  name:
    | 'loading'
    | 'changed-worktree'
    | 'many-worktrees'
    | 'non-repository'
    | 'one-worktree'
    | 'unavailable-worktree',
): OverviewFixture {
  if (name === 'loading') {
    return createMutableFixture({
      kind: 'loading',
      message: 'Resolving the Current Project…',
    });
  }
  if (name === 'non-repository') {
    return createMutableFixture({
      kind: 'non-repository',
      projectPath: '/Users/leyoonafr/Downloads/notes',
      message: 'The Current Project is not inside a Git Repository.',
    });
  }
  return createMutableFixture({
    kind: 'repository',
    snapshot:
      name === 'changed-worktree'
        ? changedWorktree
        : name === 'one-worktree'
          ? oneWorktree
          : name === 'many-worktrees'
            ? manyWorktrees
            : unavailableWorktree,
  });
}

function createMutableFixture(
  initial: RepositoryOverviewSourceState,
): OverviewFixture {
  let state = initial;
  let refresh = 0;
  const fetch: (string | null)[] = [];
  const diff: string[] = [];
  const listeners = new Set<() => void>();

  return {
    source: {
      getSnapshot: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      requestRefresh() {
        refresh += 1;
      },
      requestFetch(remoteId) {
        fetch.push(remoteId);
      },
      async requestDiff(fileId) {
        diff.push(fileId);
        return {
          kind: 'text',
          fileId,
          baseline:
            changedWorktree.worktrees[0]!.changes.find(
              (change) => change.fileId === fileId,
            )?.baseline ?? 'index_to_working_tree',
          content:
            fileId === changedFileIds[0]
              ? '@@ -1 +1,2 @@\n old line\n+new staged line\n'
              : '@@ -1 +1 @@\n-old value\n+new value\n',
          lineCount: 3,
        };
      },
      async requestNativeAction() {
        return {
          kind: 'unavailable',
          message: 'Native actions are not installed in this fixture.',
        };
      },
      async searchBranches() {
        return { refsRevision: 0, candidates: [] };
      },
      async switchBranch() {
        throw new Error('Branch switching is not configured for this fixture.');
      },
    },
    publish(nextState) {
      state = nextState;
      listeners.forEach((listener) => listener());
    },
    get requests() {
      return { refresh, fetch, diff };
    },
  };
}

const repositoryId = repositoryIdSchema.parse(
  'repository_00000000000000000000000000000001',
);
const mainWorktreeId = worktreeIdSchema.parse(
  'worktree_00000000000000000000000000000001',
);
const mainGeneration = worktreeGenerationSchema.parse(
  'generation_00000000000000000000000000000001',
);
const originId = remoteIdSchema.parse(
  'remote_00000000000000000000000000000001',
);
const backupRemoteId = remoteIdSchema.parse(
  'remote_00000000000000000000000000000002',
);
const changedFileIds = [1, 2, 3, 4].map((index) =>
  fileIdSchema.parse(`file_${index.toString(16).padStart(32, '0')}`),
);
const changedNativeTargetIds = [1, 2, 3, 4].map((index) =>
  nativeTargetIdSchema.parse(`native_${index.toString(16).padStart(32, '0')}`),
);

export const oneWorktree: RepositoryOverviewSnapshot = {
  repositoryId,
  repositoryRevision: 1,
  topologyRevision: 1,
  refsRevision: 1,
  displayName: 'codex-git',
  path: '/Users/leyoonafr/Projects/codex-git',
  refresh: { kind: 'current' },
  fetch: { kind: 'current', fetchedAt: '2026-08-29T14:03:00.000Z' },
  remotes: [{ remoteId: originId, displayName: 'origin', host: 'github.com' }],
  operations: [],
  worktrees: [
    {
      worktreeId: mainWorktreeId,
      worktreeRevision: 1,
      generation: mainGeneration,
      role: 'main',
      displayName: 'codex-git',
      path: '/Users/leyoonafr/Projects/codex-git',
      freshness: { kind: 'current' },
      head: {
        kind: 'local_branch',
        displayName: 'main',
        objectId: '0123456789abcdef0123456789abcdef01234567',
      },
      status: { kind: 'clean' },
      changes: [],
      upstream: {
        kind: 'tracking',
        displayName: 'origin/main',
        ahead: 0,
        behind: 0,
        fetchedAt: '2026-08-29T14:03:00.000Z',
      },
    },
  ],
};

export const changedWorktree: RepositoryOverviewSnapshot = {
  ...oneWorktree,
  repositoryRevision: 2,
  worktrees: [
    {
      ...oneWorktree.worktrees[0]!,
      worktreeRevision: 2,
      status: {
        kind: 'changed',
        conflictCount: 0,
        stagedCount: 1,
        trackedChangeCount: 2,
        untrackedCount: 1,
      },
      changes: [
        {
          fileId: changedFileIds[0]!,
          kind: 'staged_change',
          baseline: 'head_to_index',
          displayPath: 'README.md',
          previousDisplayPath: null,
          nativeTargets: [nativeFileTarget(0)],
        },
        {
          fileId: changedFileIds[1]!,
          kind: 'change',
          baseline: 'index_to_working_tree',
          displayPath: 'src/app.ts',
          previousDisplayPath: null,
          nativeTargets: [nativeFileTarget(1)],
        },
        {
          fileId: changedFileIds[2]!,
          kind: 'change',
          baseline: 'index_to_working_tree',
          displayPath: 'src/utils.ts',
          previousDisplayPath: null,
          nativeTargets: [nativeFileTarget(2)],
        },
        {
          fileId: changedFileIds[3]!,
          kind: 'untracked',
          baseline: 'empty_to_working_tree',
          displayPath: 'notes.txt',
          previousDisplayPath: null,
          nativeTargets: [nativeFileTarget(3)],
        },
      ],
    },
  ],
};

function nativeFileTarget(index: number) {
  return {
    targetId: changedNativeTargetIds[index]!,
    actions: ['open_default_app', 'copy_relative_path'] as const,
  };
}

const linkedWorktrees: RepositoryOverviewSnapshot['worktrees'] = Array.from(
  { length: 24 },
  (_, offset) => {
    const index = offset + 2;
    const displayName =
      index === 2
        ? 'agent-beta'
        : index === 3
          ? 'agent-alpha'
          : `worktree-${String(index).padStart(2, '0')}`;
    return {
      worktreeId: worktreeIdSchema.parse(
        `worktree_${index.toString(16).padStart(32, '0')}`,
      ),
      worktreeRevision: 1,
      generation: worktreeGenerationSchema.parse(
        `generation_${index.toString(16).padStart(32, '0')}`,
      ),
      role: 'linked' as const,
      displayName,
      path: `/private/tmp/codex-git-${displayName}`,
      codexTitle: index === 2 ? 'Build the adaptive overview' : undefined,
      freshness: { kind: 'current' as const },
      head: {
        kind: 'local_branch' as const,
        displayName: `feat/${displayName}`,
        objectId: index.toString(16).padStart(40, '0'),
      },
      status:
        index === 2
          ? {
              kind: 'changed' as const,
              conflictCount: 0,
              stagedCount: 1,
              trackedChangeCount: 2,
              untrackedCount: 1,
            }
          : { kind: 'clean' as const },
      changes: [],
      upstream: {
        kind: 'tracking' as const,
        displayName: `origin/feat/${displayName}`,
        ahead: index === 2 ? 2 : 0,
        behind: 0,
        fetchedAt: '2026-08-29T14:03:00.000Z',
      },
    };
  },
);

export const manyWorktrees: RepositoryOverviewSnapshot = {
  ...oneWorktree,
  repositoryRevision: 2,
  topologyRevision: 2,
  remotes: [
    ...oneWorktree.remotes,
    {
      remoteId: backupRemoteId,
      displayName: 'backup',
      host: 'git.example.com',
    },
  ],
  worktrees: [
    linkedWorktrees[0]!,
    oneWorktree.worktrees[0]!,
    ...linkedWorktrees.slice(1),
  ],
};

export const unavailableWorktree: RepositoryOverviewSnapshot = {
  ...oneWorktree,
  repositoryRevision: 3,
  topologyRevision: 2,
  refresh: { kind: 'failed', message: 'The Working Tree scan timed out.' },
  fetch: {
    kind: 'failed',
    fetchedAt: '2026-08-29T13:40:00.000Z',
    message: 'Network offline.',
  },
  operations: [
    {
      operationId: operationIdSchema.parse(
        'operation_00000000000000000000000000000001',
      ),
      category: 'fetch',
      phase: 'running',
      progress: 0.4,
    },
  ],
  worktrees: [
    oneWorktree.worktrees[0]!,
    {
      ...linkedWorktrees[0]!,
      displayName: 'missing-worktree',
      path: '/private/tmp/missing-worktree',
      freshness: {
        kind: 'stale',
        message: 'Last successful observation retained.',
      },
      status: { kind: 'unavailable', reason: 'Working Tree path is missing.' },
      upstream: {
        kind: 'not-applicable',
        reason: 'Upstream unavailable while the Working Tree is missing.',
      },
    },
  ],
};
