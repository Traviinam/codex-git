import { describe, expect, it } from 'vitest';

import type {
  ClientCommandId,
  FileId,
  NativeTargetId,
  WorktreeGeneration,
  WorktreeId,
} from '@codex-git/protocol';

import type { FileMutationInspector } from './file-mutation-inspection.js';
import { privateWorktreeIdentityEvidence } from './observation-publication.js';
import type { ScopedRepositoryPublicationSession } from './repository-publication.js';
import { createRepositorySession } from './repository-session.js';

describe('Repository file mutation lanes', () => {
  it('executes independent Worktree mutations concurrently', async () => {
    const mutated = new Set<string>();
    const releases = new Map(
      ['/worktree-one', '/worktree-two'].map((path) => [
        path,
        deferred<void>(),
      ]),
    );
    const bothStarted = deferred<void>();
    const started = new Set<string>();
    const repository = () => ({
      kind: 'repository' as const,
      repository: fakeRepository(mutated),
    });
    const delegate = {
      snapshot: async () => repository(),
      requestRefresh: async () => repository(),
      requestScopedRefresh: async () => repository(),
      async *subscribe() {},
      close: async () => undefined,
    } as unknown as ScopedRepositoryPublicationSession;
    const session = createRepositorySession(delegate, {
      inspectFileMutationTargets: fakeInspection,
      async runGit(args) {
        const worktreePath = args[2]!;
        started.add(worktreePath);
        if (started.size === 2) bothStarted.resolve();
        await releases.get(worktreePath)!.promise;
        mutated.add(worktreePath);
        return new Uint8Array();
      },
    });
    const opened = await session.snapshot();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const [first, second] = opened.repository.worktrees;

    const firstReceipt = await session.dispatch({
      clientCommandId: commandId(1),
      command: {
        kind: 'stage',
        worktreeId: first!.worktreeId,
        expectedWorktreeRevision: first!.worktreeRevision,
        fileIds: [first!.changes[0]!.fileId],
      },
    });
    const secondReceipt = await session.dispatch({
      clientCommandId: commandId(2),
      command: {
        kind: 'stage',
        worktreeId: second!.worktreeId,
        expectedWorktreeRevision: second!.worktreeRevision,
        fileIds: [second!.changes[0]!.fileId],
      },
    });

    await Promise.race([
      bothStarted.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Mutations were serialized.')), 500),
      ),
    ]);
    releases.forEach(({ resolve }) => resolve());

    await expect(
      session.recoverOperation(firstReceipt.operationId),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    await expect(
      session.recoverOperation(secondReceipt.operationId),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    await session.close();
  });

  it('reports Unknown Outcome when Git execution throws ambiguously', async () => {
    const repository = () => ({
      kind: 'repository' as const,
      repository: fakeRepository(new Set()),
    });
    const delegate = fakeDelegate(repository);
    const session = createRepositorySession(delegate, {
      inspectFileMutationTargets: fakeInspection,
      async runGit() {
        throw new Error('Process transport disappeared.');
      },
    });
    const opened = await session.snapshot();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;

    const receipt = await session.dispatch({
      clientCommandId: commandId(3),
      command: {
        kind: 'stage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: [worktree.changes[0]!.fileId],
      },
    });

    await expect(
      session.recoverOperation(receipt.operationId),
    ).resolves.toMatchObject({
      kind: 'unknown_outcome',
      code: 'reconciliation_incomplete',
    });
    await session.close();
  });

  it('reports Unknown Outcome when post-mutation reconciliation fails', async () => {
    const mutated = new Set<string>();
    const repository = () => ({
      kind: 'repository' as const,
      repository: fakeRepository(mutated),
    });
    let refreshes = 0;
    const delegate = fakeDelegate(repository, async () => {
      refreshes += 1;
      if (refreshes > 1) throw new Error('Refresh failed.');
      return repository();
    });
    const session = createRepositorySession(delegate, {
      inspectFileMutationTargets: fakeInspection,
      async runGit(args) {
        mutated.add(args[2]!);
        return new Uint8Array();
      },
    });
    const opened = await session.snapshot();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;

    const receipt = await session.dispatch({
      clientCommandId: commandId(4),
      command: {
        kind: 'stage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: [worktree.changes[0]!.fileId],
      },
    });

    await expect(
      session.recoverOperation(receipt.operationId),
    ).resolves.toMatchObject({
      kind: 'unknown_outcome',
      code: 'reconciliation_incomplete',
    });
    await session.close();
  });

  it('uses one bulk inspection and one bounded inspection per target', async () => {
    const mutated = new Set<string>();
    const repository = () => ({
      kind: 'repository' as const,
      repository: fakeRepository(mutated, 3),
    });
    let refreshes = 0;
    const delegate = fakeDelegate(repository, async () => {
      refreshes += 1;
      return repository();
    });
    const inspectionSizes: number[] = [];
    const refreshesAtMutation: number[] = [];
    const session = createRepositorySession(delegate, {
      async inspectFileMutationTargets(worktree, targets, signal) {
        inspectionSizes.push(targets.length);
        return fakeInspection(worktree, targets, signal);
      },
      async runGit(args) {
        refreshesAtMutation.push(refreshes);
        mutated.add(args[2]!);
        return new Uint8Array();
      },
    });
    const opened = await session.snapshot();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;

    const receipt = await session.dispatch({
      clientCommandId: commandId(5),
      command: {
        kind: 'stage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: worktree.changes.map(({ fileId }) => fileId),
      },
    });

    await expect(
      session.recoverOperation(receipt.operationId),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    expect(inspectionSizes).toEqual([3, 1, 1, 1]);
    expect(refreshesAtMutation).toEqual([1, 1, 1]);
    await session.close();
  });

  it('rejects same-path Worktree replacement between refresh and baseline inspection', async () => {
    const repository = () => ({
      kind: 'repository' as const,
      repository: fakeRepository(new Set()),
    });
    let mutations = 0;
    const session = createRepositorySession(fakeDelegate(repository), {
      async inspectFileMutationTargets(worktree, targets, signal) {
        const inspection = await fakeInspection(worktree, targets, signal);
        return {
          ...inspection,
          topologyEvidence: 'replacement-with-identical-visible-state',
        };
      },
      async runGit() {
        mutations += 1;
        return new Uint8Array();
      },
    });
    const opened = await session.snapshot();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;

    const receipt = await session.dispatch({
      clientCommandId: commandId(8),
      command: {
        kind: 'stage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: [worktree.changes[0]!.fileId],
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({ kind: 'rejected', code: 'stale' });
    expect(mutations).toBe(0);
    await session.close();
  });

  it('preserves a stale bulk effect when final state becomes desired externally', async () => {
    const mutated = new Set<string>();
    const repository = () => ({
      kind: 'repository' as const,
      repository: fakeRepository(mutated, 2),
    });
    let inspections = 0;
    const session = createRepositorySession(fakeDelegate(repository), {
      async inspectFileMutationTargets(worktree, targets, signal) {
        inspections += 1;
        const inspection = await fakeInspection(worktree, targets, signal);
        return inspections === 3
          ? { ...inspection, targetFingerprints: ['externally-changed'] }
          : inspection;
      },
      async runGit(args) {
        mutated.add(args[2]!);
        return new Uint8Array();
      },
    });
    const opened = await session.snapshot();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;

    const receipt = await session.dispatch({
      clientCommandId: commandId(6),
      command: {
        kind: 'stage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: worktree.changes.map(({ fileId }) => fileId),
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'partial_success',
      effects: [
        { kind: 'succeeded', label: 'file-1-0.txt' },
        { kind: 'failed_known', label: 'file-1-1.txt', code: 'stale' },
      ],
    });
    await session.close();
  });

  it('blocks a later bulk target when a Git operation starts mid-bulk', async () => {
    const mutated = new Set<string>();
    const repository = () => ({
      kind: 'repository' as const,
      repository: fakeRepository(mutated, 2),
    });
    let inspections = 0;
    let mutations = 0;
    const session = createRepositorySession(fakeDelegate(repository), {
      async inspectFileMutationTargets(worktree, targets, signal) {
        inspections += 1;
        const inspection = await fakeInspection(worktree, targets, signal);
        return inspections === 3
          ? { ...inspection, blockedBy: 'operation' }
          : inspection;
      },
      async runGit(args) {
        mutations += 1;
        mutated.add(args[2]!);
        return new Uint8Array();
      },
    });
    const opened = await session.snapshot();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;

    const receipt = await session.dispatch({
      clientCommandId: commandId(7),
      command: {
        kind: 'stage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: worktree.changes.map(({ fileId }) => fileId),
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(mutations).toBe(1);
    expect(result).toMatchObject({
      kind: 'partial_success',
      effects: [
        { kind: 'succeeded', label: 'file-1-0.txt' },
        {
          kind: 'failed_known',
          label: 'file-1-1.txt',
          code: 'precondition_failed',
        },
      ],
    });
    await session.close();
  });
});

type FakeRepositoryResult = {
  kind: 'repository';
  repository: ReturnType<typeof fakeRepository>;
};

const fakeInspection: FileMutationInspector = async (worktree, targets) => {
  if (worktree.canonicalPath === null)
    throw new Error('Expected Worktree path');
  return {
    commonGitDirectory: '/common.git',
    worktreePath: worktree.canonicalPath,
    topologyEvidence: `topology:${worktree.canonicalPath}`,
    blockedBy: null,
    targetFingerprints: targets.map(({ baselineFingerprint }) =>
      String(baselineFingerprint),
    ),
  } as const;
};

function fakeDelegate(
  repository: () => FakeRepositoryResult,
  requestRefresh: () => Promise<FakeRepositoryResult> = async () =>
    repository(),
) {
  return {
    snapshot: async () => repository(),
    requestRefresh,
    requestScopedRefresh: requestRefresh,
    async *subscribe() {},
    close: async () => undefined,
  } as unknown as ScopedRepositoryPublicationSession;
}

function fakeRepository(mutated: ReadonlySet<string>, fileCount = 1) {
  return {
    repositoryId: 'repository_00000000000000000000000000000001',
    commonGitDirectory: '/common.git',
    selectedWorktreeId:
      'worktree_00000000000000000000000000000001' as WorktreeId,
    repositoryRevision: mutated.size + 1,
    topologyRevision: 1,
    refsRevision: 1,
    refresh: { kind: 'fresh' as const },
    fetch: { kind: 'never' as const },
    remotes: [],
    refs: [],
    operations: [],
    worktrees: [
      fakeWorktree(1, '/worktree-one', mutated.has('/worktree-one'), fileCount),
      fakeWorktree(2, '/worktree-two', mutated.has('/worktree-two')),
    ],
  };
}

function fakeWorktree(
  index: number,
  path: string,
  staged: boolean,
  fileCount = 1,
) {
  const suffix = index.toString(16).padStart(32, '0');
  return {
    worktreeId: `worktree_${suffix}` as WorktreeId,
    worktreeRevision: staged ? 2 : 1,
    generation: `generation_${suffix}` as WorktreeGeneration,
    [privateWorktreeIdentityEvidence]: `topology:${path}`,
    displayPath: path,
    canonicalPath: path,
    role: index === 1 ? ('main' as const) : ('linked' as const),
    head: {
      kind: 'local_branch' as const,
      fullName: `refs/heads/worktree-${index}`,
      displayName: `worktree-${index}`,
      objectId: '0123456789abcdef0123456789abcdef01234567',
    },
    gitLock: { kind: 'unlocked' as const },
    availability: { kind: 'available' as const },
    freshness: { kind: 'fresh' as const },
    index: {
      entryCount: staged ? 1 : 0,
      fingerprint: String(index),
      locked: false,
    },
    status: {
      clean: false,
      conflicted: 0,
      staged: staged ? 1 : 0,
      unstaged: staged ? 0 : 1,
      untracked: 0,
    },
    changes: Array.from({ length: fileCount }, (_, fileIndex) => {
      const fileSuffix = (index * 1_000 + fileIndex)
        .toString(16)
        .padStart(32, '0');
      return {
        fileId: `file_${fileSuffix}` as FileId,
        nativeTargetId: `native_${fileSuffix}` as NativeTargetId,
        kind: staged ? ('staged_change' as const) : ('change' as const),
        baseline: staged
          ? ('head_to_index' as const)
          : ('index_to_working_tree' as const),
        baselineFingerprint: staged
          ? `staged-${index}-${fileIndex}`
          : `changed-${index}-${fileIndex}`,
        displayPath: `file-${index}-${fileIndex}.txt`,
        pathBytes: new TextEncoder().encode(`file-${index}-${fileIndex}.txt`),
        previousDisplayPath: null,
        previousPathBytes: null,
        workingFilePresent: true,
      };
    }),
    upstream: { kind: 'unpublished' as const },
  };
}

function commandId(index: number) {
  return `command_${index.toString(16).padStart(32, '0')}` as ClientCommandId;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
