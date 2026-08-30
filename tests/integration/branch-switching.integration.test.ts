import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AbsolutePath, ClientCommandId } from '@codex-git/protocol';
import { createRepositoryEngine } from '@codex-git/repository-engine';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTemporaryGitRepository,
  type TemporaryGitRepository,
} from '../fixtures/temporary-git-repository.js';

const repositories: TemporaryGitRepository[] = [];
const externalPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((repository) => repository.dispose()),
  );
  await Promise.all(
    externalPaths.splice(0).map((path) =>
      rm(path, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe('Repository Branch switching', () => {
  it('discovers cached Local Branches with Repository-wide occupancy', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git('branch', 'available');
    await repository.git('branch', 'occupied');
    const linkedPath = `${repository.path}-occupied`;
    externalPaths.push(linkedPath);
    await repository.git('worktree', 'add', '--quiet', linkedPath, 'occupied');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const selectedWorktreeId = opened.repository.selectedWorktreeId;
    if (selectedWorktreeId === null) throw new Error('Expected Worktree');
    const occupiedWorktree = opened.repository.worktrees.find(
      ({ role }) => role === 'linked',
    );

    const result = await session.searchBranches({
      worktreeId: selectedWorktreeId,
      query: '',
    });

    expect(result.refsRevision).toBe(opened.repository.refsRevision);
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'local',
          displayName: 'available',
          occupiedBy: null,
        }),
        expect.objectContaining({
          kind: 'local',
          displayName: 'occupied',
          occupiedBy: occupiedWorktree?.worktreeId,
        }),
      ]),
    );
    expect(
      result.candidates.every(({ refId }) => refId.startsWith('ref_')),
    ).toBe(true);
    await session.close();
  });

  it('switches a clean Worktree to an unoccupied Local Branch', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git('branch', 'available');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0];
    if (worktree === undefined) throw new Error('Expected Worktree');
    const branches = await session.searchBranches({
      worktreeId: worktree.worktreeId,
      query: 'available',
    });
    const target = branches.candidates.find(
      ({ displayName }) => displayName === 'available',
    );
    if (target === undefined) throw new Error('Expected target Branch');
    const receipt = await session.dispatch({
      clientCommandId:
        'command_0123456789abcdef0123456789abcdef' as ClientCommandId,
      command: {
        kind: 'switch_branch',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        refId: target.refId,
        expectedRefsRevision: branches.refsRevision,
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'succeeded',
      result: { kind: 'branch_switch', displayName: 'available' },
    });
    const refreshed = await session.requestRefresh();
    expect(refreshed).toMatchObject({
      kind: 'repository',
      repository: {
        worktrees: [
          expect.objectContaining({
            head: expect.objectContaining({
              kind: 'local_branch',
              displayName: 'available',
            }),
            status: expect.objectContaining({ clean: true }),
          }),
        ],
      },
    });
    await session.close();
  });

  it('blocks a dirty Worktree without carrying or discarding changes', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git('branch', 'available');
    await writeFile(join(repository.path, 'dirty.txt'), 'keep me\n');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const branches = await session.searchBranches({
      worktreeId: worktree.worktreeId,
      query: 'available',
    });
    const target = branches.candidates[0]!;

    const receipt = await session.dispatch({
      clientCommandId:
        'command_1123456789abcdef0123456789abcdef' as ClientCommandId,
      command: {
        kind: 'switch_branch',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        refId: target.refId,
        expectedRefsRevision: branches.refsRevision,
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'precondition_failed',
    });
    expect((await repository.git('status', '--short')).stdout).toContain(
      'dirty.txt',
    );
    expect(
      (await repository.git('branch', '--show-current')).stdout.trim(),
    ).not.toBe('available');
    await session.close();
  });

  it('creates only the same-name Local tracking Branch for a cached Remote-tracking target', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git('remote', 'add', 'origin', repository.path);
    await repository.git(
      'update-ref',
      'refs/remotes/origin/team/remote-only',
      'HEAD',
    );
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const branches = await session.searchBranches({
      worktreeId: worktree.worktreeId,
      query: 'remote-only',
    });
    const target = branches.candidates.find(
      ({ kind }) => kind === 'remote_tracking',
    );
    if (target === undefined)
      throw new Error('Expected Remote-tracking Branch');

    const receipt = await session.dispatch({
      clientCommandId:
        'command_2123456789abcdef0123456789abcdef' as ClientCommandId,
      command: {
        kind: 'switch_branch',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        refId: target.refId,
        expectedRefsRevision: branches.refsRevision,
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'succeeded',
      result: { kind: 'branch_switch', displayName: 'team/remote-only' },
    });
    expect(
      (await repository.git('branch', '--show-current')).stdout.trim(),
    ).toBe('team/remote-only');
    expect(
      (
        await repository.git(
          'for-each-ref',
          '--format=%(upstream)',
          'refs/heads/team/remote-only',
        )
      ).stdout.trim(),
    ).toBe('refs/remotes/origin/team/remote-only');
    await session.close();
  });

  it('warns before leaving a detached Commit unreachable from another named ref', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git('switch', '--quiet', '-c', 'temporary');
    await writeFile(join(repository.path, 'detached.txt'), 'detached\n');
    await repository.git('add', 'detached.txt');
    await repository.git('commit', '--quiet', '-m', 'Detached fixture');
    const detachedCommit = (
      await repository.git('rev-parse', 'HEAD')
    ).stdout.trim();
    await repository.git('switch', '--quiet', '-');
    await repository.git('branch', '-D', 'temporary');
    await repository.git('switch', '--quiet', '--detach', detachedCommit);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;

    const result = await session.searchBranches({
      worktreeId: worktree.worktreeId,
      query: '',
    });

    expect(result.candidates[0]?.warning).toContain(
      'not reachable from another named ref',
    );
    await session.close();
  });

  it('rejects stale Branch Occupancy after an external Worktree claims the target', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git('branch', 'available');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const branches = await session.searchBranches({
      worktreeId: worktree.worktreeId,
      query: 'available',
    });
    const target = branches.candidates[0]!;
    const linkedPath = `${repository.path}-late-occupancy`;
    externalPaths.push(linkedPath);
    await repository.git('worktree', 'add', '--quiet', linkedPath, 'available');

    const receipt = await session.dispatch({
      clientCommandId:
        'command_3123456789abcdef0123456789abcdef' as ClientCommandId,
      command: {
        kind: 'switch_branch',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        refId: target.refId,
        expectedRefsRevision: branches.refsRevision,
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({ kind: 'rejected', code: 'stale' });
    const refreshed = await session.searchBranches({
      worktreeId: worktree.worktreeId,
      query: 'available',
    });
    expect(refreshed.candidates[0]?.occupiedBy).not.toBeNull();
    await session.close();
  });

  it('blocks a clean Worktree with an In-progress Git Operation', async () => {
    const repository = await createRepositoryWithCommit();
    await writeFile(join(repository.path, 'second.txt'), 'second\n');
    await repository.git('add', 'second.txt');
    await repository.git('commit', '--quiet', '-m', 'Second fixture');
    await repository.git('branch', 'available');
    await repository.git('bisect', 'start', 'HEAD', 'HEAD~1');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    expect(worktree.status).toMatchObject({
      clean: true,
      inProgressOperation: 'bisect',
    });
    const branches = await session.searchBranches({
      worktreeId: worktree.worktreeId,
      query: 'available',
    });

    const receipt = await session.dispatch({
      clientCommandId:
        'command_4123456789abcdef0123456789abcdef' as ClientCommandId,
      command: {
        kind: 'switch_branch',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        refId: branches.candidates[0]!.refId,
        expectedRefsRevision: branches.refsRevision,
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'precondition_failed',
    });
    await repository.git('bisect', 'reset');
    await session.close();
  });

  it('blocks a clean Worktree while its Index is locked', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git('branch', 'available');
    const indexPath = (
      await repository.git(
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'index',
      )
    ).stdout.trim();
    await writeFile(`${indexPath}.lock`, 'locked\n');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const branches = await session.searchBranches({
      worktreeId: worktree.worktreeId,
      query: 'available',
    });

    const receipt = await session.dispatch({
      clientCommandId:
        'command_5123456789abcdef0123456789abcdef' as ClientCommandId,
      command: {
        kind: 'switch_branch',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        refId: branches.candidates[0]!.refId,
        expectedRefsRevision: branches.refsRevision,
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'precondition_failed',
    });
    await rm(`${indexPath}.lock`, { force: true });
    await session.close();
  });
});

async function createRepositoryWithCommit() {
  const repository = await createTemporaryGitRepository();
  repositories.push(repository);
  await repository.git('config', 'user.email', 'codex-git@example.invalid');
  await repository.git('config', 'user.name', 'Codex Git');
  await writeFile(join(repository.path, 'README.md'), 'fixture\n');
  await repository.git('add', 'README.md');
  await repository.git('commit', '--quiet', '-m', 'Initial fixture');
  return repository;
}
