import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AbsolutePath,
  ClientCommandId,
  ProductCommand,
} from '@codex-git/protocol';
import {
  createRepositoryEngine,
  type RepositorySession,
  type RepositorySnapshot,
} from '@codex-git/repository-engine';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTemporaryGitRepository,
  type TemporaryGitRepository,
} from '../fixtures/temporary-git-repository.js';

const repositories: TemporaryGitRepository[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((repository) => repository.dispose()),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Repository Pull, Push, and Publish', () => {
  it('Pull targets branch.<local>.merge when the fetch refspec maps to a different tracking name', async () => {
    const fixture = await customMappingFixture();
    const producer = await cloneRemoteBranch(fixture.remotePath, 'source');
    await writeFile(
      join(producer.path, 'remote.txt'),
      'mapped remote change\n',
    );
    await producer.git('add', '--', 'remote.txt');
    await producer.git('commit', '--quiet', '-m', 'Advance mapped source');
    const expectedHead = (
      await producer.git('rev-parse', 'HEAD')
    ).stdout.trim();
    await producer.git('push', '--quiet', 'origin', 'HEAD:refs/heads/source');
    await fixture.repository.git('fetch', '--quiet', 'origin');
    const session = await createRepositoryEngine().open(
      fixture.repository.path as AbsolutePath,
    );
    const before = await snapshot(session);
    const worktree = before.worktrees[0]!;
    expect(worktree.upstream).toMatchObject({
      kind: 'tracking',
      displayName: 'origin/alias',
      aheadBehind: { kind: 'cached', ahead: 0, behind: 1 },
    });

    const result = await dispatchAndRecover(session, {
      kind: 'pull',
      worktreeId: worktree.worktreeId,
      expectedWorktreeRevision: worktree.worktreeRevision,
      expectedRefsRevision: before.refsRevision,
    });

    expect(result).toMatchObject({ kind: 'succeeded' });
    expect(
      (await fixture.repository.git('rev-parse', 'HEAD')).stdout.trim(),
    ).toBe(expectedHead);
    expect(
      (
        await fixture.repository.git(
          '--git-dir',
          fixture.remotePath,
          'show-ref',
          '--verify',
          'refs/heads/source',
        )
      ).stdout.trim(),
    ).toContain(expectedHead);
    await session.close();
  });

  it('Push targets branch.<local>.merge instead of the Remote-tracking alias', async () => {
    const fixture = await customMappingFixture();
    await writeFile(
      join(fixture.repository.path, 'local.txt'),
      'mapped local change\n',
    );
    await fixture.repository.git('add', '--', 'local.txt');
    await fixture.repository.git(
      'commit',
      '--quiet',
      '-m',
      'Advance mapped local',
    );
    const expectedHead = (
      await fixture.repository.git('rev-parse', 'HEAD')
    ).stdout.trim();
    const session = await createRepositoryEngine().open(
      fixture.repository.path as AbsolutePath,
    );
    const before = await snapshot(session);
    const worktree = before.worktrees[0]!;

    const result = await dispatchAndRecover(session, {
      kind: 'push',
      worktreeId: worktree.worktreeId,
      expectedWorktreeRevision: worktree.worktreeRevision,
      expectedRefsRevision: before.refsRevision,
    });

    expect(result).toMatchObject({ kind: 'succeeded' });
    expect(
      (
        await fixture.repository.git(
          '--git-dir',
          fixture.remotePath,
          'rev-parse',
          'refs/heads/source',
        )
      ).stdout.trim(),
    ).toBe(expectedHead);
    await expect(
      fixture.repository.git(
        '--git-dir',
        fixture.remotePath,
        'show-ref',
        '--verify',
        'refs/heads/alias',
      ),
    ).rejects.toThrow();
    await session.close();
  });

  it('Pull fast-forwards a clean behind Local Branch from its exact Upstream', async () => {
    const fixture = await trackingFixture();
    const producer = await cloneRemote(fixture.remotePath);
    await writeFile(join(producer.path, 'remote.txt'), 'remote change\n');
    await producer.git('add', '--', 'remote.txt');
    await producer.git('commit', '--quiet', '-m', 'Advance Remote');
    const expectedHead = (
      await producer.git('rev-parse', 'HEAD')
    ).stdout.trim();
    await producer.git('push', '--quiet', 'origin', fixture.branch);
    await fixture.repository.git('fetch', '--quiet', 'origin');
    const session = await createRepositoryEngine().open(
      fixture.repository.path as AbsolutePath,
    );
    const before = await snapshot(session);
    const worktree = before.worktrees[0]!;
    expect(worktree.upstream).toMatchObject({
      kind: 'tracking',
      aheadBehind: { kind: 'cached', ahead: 0, behind: 1 },
    });

    const result = await dispatchAndRecover(session, {
      kind: 'pull',
      worktreeId: worktree.worktreeId,
      expectedWorktreeRevision: worktree.worktreeRevision,
      expectedRefsRevision: before.refsRevision,
    });

    expect(result).toMatchObject({
      kind: 'succeeded',
      result: { kind: 'remote', summary: `Pulled ${fixture.branch}.` },
    });
    expect(
      (await fixture.repository.git('rev-parse', 'HEAD')).stdout.trim(),
    ).toBe(expectedHead);
    expect(await readStatus(fixture.repository)).toBe('');
    await session.close();
  });

  it('Pull is a no-op when the Local Branch is ahead', async () => {
    const fixture = await trackingFixture();
    await writeFile(join(fixture.repository.path, 'ahead.txt'), 'ahead\n');
    await fixture.repository.git('add', '--', 'ahead.txt');
    await fixture.repository.git('commit', '--quiet', '-m', 'Ahead Commit');
    const headBefore = (
      await fixture.repository.git('rev-parse', 'HEAD')
    ).stdout.trim();
    const session = await createRepositoryEngine().open(
      fixture.repository.path as AbsolutePath,
    );
    const before = await snapshot(session);
    const worktree = before.worktrees[0]!;

    const result = await dispatchAndRecover(session, {
      kind: 'pull',
      worktreeId: worktree.worktreeId,
      expectedWorktreeRevision: worktree.worktreeRevision,
      expectedRefsRevision: before.refsRevision,
    });

    expect(result).toMatchObject({
      kind: 'succeeded',
      result: { kind: 'no_change' },
    });
    expect(
      (await fixture.repository.git('rev-parse', 'HEAD')).stdout.trim(),
    ).toBe(headBefore);
    await session.close();
  });

  it('Pull blocks divergence without changing files or refs', async () => {
    const fixture = await trackingFixture();
    const producer = await cloneRemote(fixture.remotePath);
    await writeFile(join(producer.path, 'remote.txt'), 'remote\n');
    await producer.git('add', '--', 'remote.txt');
    await producer.git('commit', '--quiet', '-m', 'Remote Commit');
    await producer.git('push', '--quiet', 'origin', fixture.branch);
    await writeFile(join(fixture.repository.path, 'local.txt'), 'local\n');
    await fixture.repository.git('add', '--', 'local.txt');
    await fixture.repository.git('commit', '--quiet', '-m', 'Local Commit');
    await fixture.repository.git('fetch', '--quiet', 'origin');
    const headBefore = (
      await fixture.repository.git('rev-parse', 'HEAD')
    ).stdout.trim();
    const refsBefore = (await fixture.repository.git('show-ref')).stdout;
    const session = await createRepositoryEngine().open(
      fixture.repository.path as AbsolutePath,
    );
    const before = await snapshot(session);
    const worktree = before.worktrees[0]!;

    const result = await dispatchAndRecover(session, {
      kind: 'pull',
      worktreeId: worktree.worktreeId,
      expectedWorktreeRevision: worktree.worktreeRevision,
      expectedRefsRevision: before.refsRevision,
    });

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'precondition_failed',
      message: expect.stringContaining('Merge or Rebase explicitly'),
    });
    expect(
      (await fixture.repository.git('rev-parse', 'HEAD')).stdout.trim(),
    ).toBe(headBefore);
    expect((await fixture.repository.git('show-ref')).stdout).toBe(refsBefore);
    await session.close();
  });

  it('Push transfers committed history and leaves uncommitted content local', async () => {
    const fixture = await trackingFixture();
    await writeFile(
      join(fixture.repository.path, 'committed.txt'),
      'committed\n',
    );
    await fixture.repository.git('add', '--', 'committed.txt');
    await fixture.repository.git('commit', '--quiet', '-m', 'Local Commit');
    const expectedRemoteHead = (
      await fixture.repository.git('rev-parse', 'HEAD')
    ).stdout.trim();
    await writeFile(
      join(fixture.repository.path, 'uncommitted.txt'),
      'local only\n',
    );
    const session = await createRepositoryEngine().open(
      fixture.repository.path as AbsolutePath,
    );
    const before = await snapshot(session);
    const worktree = before.worktrees[0]!;

    const result = await dispatchAndRecover(session, {
      kind: 'push',
      worktreeId: worktree.worktreeId,
      expectedWorktreeRevision: worktree.worktreeRevision,
      expectedRefsRevision: before.refsRevision,
    });

    expect(result).toMatchObject({
      kind: 'succeeded',
      result: { kind: 'remote', summary: `Pushed ${fixture.branch}.` },
    });
    expect(
      (
        await fixture.repository.git(
          '--git-dir',
          fixture.remotePath,
          'rev-parse',
          `refs/heads/${fixture.branch}`,
        )
      ).stdout.trim(),
    ).toBe(expectedRemoteHead);
    expect(await readStatus(fixture.repository)).toContain('uncommitted.txt');
    await session.close();
  });

  it('Push blocks a known behind Local Branch', async () => {
    const fixture = await trackingFixture();
    const producer = await cloneRemote(fixture.remotePath);
    await writeFile(join(producer.path, 'remote.txt'), 'remote\n');
    await producer.git('add', '--', 'remote.txt');
    await producer.git('commit', '--quiet', '-m', 'Remote Commit');
    await producer.git('push', '--quiet', 'origin', fixture.branch);
    await fixture.repository.git('fetch', '--quiet', 'origin');
    const remoteHead = (
      await fixture.repository.git(
        '--git-dir',
        fixture.remotePath,
        'rev-parse',
        `refs/heads/${fixture.branch}`,
      )
    ).stdout.trim();
    const session = await createRepositoryEngine().open(
      fixture.repository.path as AbsolutePath,
    );
    const before = await snapshot(session);
    const worktree = before.worktrees[0]!;

    const result = await dispatchAndRecover(session, {
      kind: 'push',
      worktreeId: worktree.worktreeId,
      expectedWorktreeRevision: worktree.worktreeRevision,
      expectedRefsRevision: before.refsRevision,
    });

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'precondition_failed',
      message: expect.stringContaining('behind or diverged'),
    });
    expect(
      (
        await fixture.repository.git(
          '--git-dir',
          fixture.remotePath,
          'rev-parse',
          `refs/heads/${fixture.branch}`,
        )
      ).stdout.trim(),
    ).toBe(remoteHead);
    await session.close();
  });

  it('Push reports a protected-Branch policy rejection without retrying', async () => {
    const fixture = await trackingFixture();
    await writeFile(join(fixture.repository.path, 'local.txt'), 'local\n');
    await fixture.repository.git('add', '--', 'local.txt');
    await fixture.repository.git('commit', '--quiet', '-m', 'Local Commit');
    const hook = join(fixture.remotePath, 'hooks', 'pre-receive');
    await writeFile(
      hook,
      '#!/bin/sh\necho "protected branch update rejected" >&2\nexit 1\n',
    );
    await chmod(hook, 0o755);
    const session = await createRepositoryEngine().open(
      fixture.repository.path as AbsolutePath,
    );
    const before = await snapshot(session);
    const worktree = before.worktrees[0]!;

    const result = await dispatchAndRecover(session, {
      kind: 'push',
      worktreeId: worktree.worktreeId,
      expectedWorktreeRevision: worktree.worktreeRevision,
      expectedRefsRevision: before.refsRevision,
    });

    expect(result).toMatchObject({
      kind: 'failed_known',
      code: 'policy',
      message: 'The policy for the Branch in the Remote rejected the update.',
    });
    expect(JSON.stringify(result)).not.toContain(fixture.remotePath);
    await session.close();
  });

  it('Push reports a non-fast-forward race and never retries with force', async () => {
    const fixture = await trackingFixture();
    const producer = await cloneRemote(fixture.remotePath);
    await writeFile(join(fixture.repository.path, 'local.txt'), 'local\n');
    await fixture.repository.git('add', '--', 'local.txt');
    await fixture.repository.git('commit', '--quiet', '-m', 'Local Commit');
    const session = await createRepositoryEngine().open(
      fixture.repository.path as AbsolutePath,
    );
    const before = await snapshot(session);
    const worktree = before.worktrees[0]!;
    await writeFile(join(producer.path, 'remote.txt'), 'remote\n');
    await producer.git('add', '--', 'remote.txt');
    await producer.git('commit', '--quiet', '-m', 'Remote race');
    await producer.git('push', '--quiet', 'origin', fixture.branch);

    const result = await dispatchAndRecover(session, {
      kind: 'push',
      worktreeId: worktree.worktreeId,
      expectedWorktreeRevision: worktree.worktreeRevision,
      expectedRefsRevision: before.refsRevision,
    });

    expect(result).toMatchObject({
      kind: 'failed_known',
      code: 'non_fast_forward',
      message: 'The Remote rejected a non-fast-forward update.',
    });
    expect(
      (
        await fixture.repository.git(
          '--git-dir',
          fixture.remotePath,
          'rev-parse',
          `refs/heads/${fixture.branch}`,
        )
      ).stdout.trim(),
    ).toBe((await producer.git('rev-parse', 'HEAD')).stdout.trim());
    await session.close();
  });

  it('Publish creates only the same-name Branch in the Remote and configures Upstream after success', async () => {
    const repository = await createRepository();
    await writeFile(join(repository.path, 'README.md'), 'unpublished\n');
    await repository.git('add', '--', 'README.md');
    await repository.git('commit', '--quiet', '-m', 'Unpublished Commit');
    await repository.git('switch', '--quiet', '-c', 'feature/same-name');
    const localObjectId = (
      await repository.git('rev-parse', 'HEAD')
    ).stdout.trim();
    const remotePath = await mkdtemp(
      join(tmpdir(), 'codex-git-publish-remote-'),
    );
    temporaryDirectories.push(remotePath);
    await repository.git('init', '--quiet', '--bare', remotePath);
    await repository.git('remote', 'add', 'origin', remotePath);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const before = await snapshot(session);
    const worktree = before.worktrees[0]!;
    const remote = before.remotes[0]!;
    expect(worktree.upstream).toEqual({ kind: 'unpublished' });

    const result = await dispatchAndRecover(session, {
      kind: 'publish',
      worktreeId: worktree.worktreeId,
      remoteId: remote.remoteId,
      expectedWorktreeRevision: worktree.worktreeRevision,
      expectedRefsRevision: before.refsRevision,
    });

    expect(result).toMatchObject({
      kind: 'succeeded',
      result: {
        kind: 'remote',
        summary: 'Published feature/same-name to origin.',
      },
    });
    expect(
      (
        await repository.git(
          '--git-dir',
          remotePath,
          'rev-parse',
          'refs/heads/feature/same-name',
        )
      ).stdout.trim(),
    ).toBe(localObjectId);
    expect(
      (
        await repository.git(
          'for-each-ref',
          '--format=%(upstream)',
          'refs/heads/feature/same-name',
        )
      ).stdout.trim(),
    ).toBe('refs/remotes/origin/feature/same-name');
    await session.close();
  });

  it('Publish reports Partial Success when the Branch in the Remote succeeds but Upstream configuration fails', async () => {
    const repository = await createRepository();
    await writeFile(join(repository.path, 'README.md'), 'partial\n');
    await repository.git('add', '--', 'README.md');
    await repository.git('commit', '--quiet', '-m', 'Partial fixture');
    await repository.git('switch', '--quiet', '-c', 'partial-publish');
    const remotePath = await mkdtemp(
      join(tmpdir(), 'codex-git-partial-remote-'),
    );
    temporaryDirectories.push(remotePath);
    await repository.git('init', '--quiet', '--bare', remotePath);
    await repository.git('remote', 'add', 'origin', remotePath);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const before = await snapshot(session);
    const worktree = before.worktrees[0]!;
    const remote = before.remotes[0]!;
    await writeFile(join(repository.path, '.git', 'config.lock'), 'occupied\n');

    const result = await dispatchAndRecover(session, {
      kind: 'publish',
      worktreeId: worktree.worktreeId,
      remoteId: remote.remoteId,
      expectedWorktreeRevision: worktree.worktreeRevision,
      expectedRefsRevision: before.refsRevision,
    });

    expect(result).toMatchObject({
      kind: 'partial_success',
      message: 'The Branch was published, but its Upstream was not configured.',
      effects: [
        { kind: 'succeeded', label: 'Published partial-publish' },
        {
          kind: 'failed_known',
          label: 'Configure Upstream',
          code: 'process_failed',
        },
      ],
    });
    expect(
      (
        await repository.git(
          '--git-dir',
          remotePath,
          'rev-parse',
          'refs/heads/partial-publish',
        )
      ).stdout.trim(),
    ).toMatch(/^[0-9a-f]{40}$/u);
    expect(
      (
        await repository.git(
          'for-each-ref',
          '--format=%(upstream)',
          'refs/heads/partial-publish',
        )
      ).stdout.trim(),
    ).toBe('');
    await session.close();
  });
});

async function trackingFixture() {
  const repository = await createRepository();
  await writeFile(join(repository.path, 'README.md'), 'fixture\n');
  await repository.git('add', '--', 'README.md');
  await repository.git('commit', '--quiet', '-m', 'Create fixture');
  const branch = (
    await repository.git('branch', '--show-current')
  ).stdout.trim();
  const remotePath = await mkdtemp(join(tmpdir(), 'codex-git-sync-remote-'));
  temporaryDirectories.push(remotePath);
  await repository.git('init', '--quiet', '--bare', remotePath);
  await repository.git('remote', 'add', 'origin', remotePath);
  await repository.git('push', '--quiet', '-u', 'origin', branch);
  return { branch, remotePath, repository };
}

async function customMappingFixture() {
  const repository = await createRepository();
  await writeFile(join(repository.path, 'README.md'), 'fixture\n');
  await repository.git('add', '--', 'README.md');
  await repository.git('commit', '--quiet', '-m', 'Create fixture');
  const branch = (
    await repository.git('branch', '--show-current')
  ).stdout.trim();
  const remotePath = await mkdtemp(join(tmpdir(), 'codex-git-mapped-remote-'));
  temporaryDirectories.push(remotePath);
  await repository.git('init', '--quiet', '--bare', remotePath);
  await repository.git('remote', 'add', 'origin', remotePath);
  await repository.git('push', '--quiet', 'origin', 'HEAD:refs/heads/source');
  await repository.git(
    'config',
    'remote.origin.fetch',
    '+refs/heads/source:refs/remotes/origin/alias',
  );
  await repository.git('fetch', '--quiet', 'origin');
  await repository.git('config', `branch.${branch}.remote`, 'origin');
  await repository.git('config', `branch.${branch}.merge`, 'refs/heads/source');
  return { branch, remotePath, repository };
}

async function cloneRemote(remotePath: string) {
  const producer = await createTemporaryGitRepository();
  repositories.push(producer);
  await configureIdentity(producer);
  await producer.git('remote', 'add', 'origin', remotePath);
  await producer.git('fetch', '--quiet', 'origin');
  const branch = (
    await producer.git(
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/remotes/origin',
    )
  ).stdout
    .split('\n')
    .find((name) => name.startsWith('origin/') && name !== 'origin/HEAD')!
    .slice('origin/'.length);
  await producer.git('switch', '--quiet', '-c', branch, `origin/${branch}`);
  return producer;
}

async function cloneRemoteBranch(remotePath: string, branch: string) {
  const producer = await createTemporaryGitRepository();
  repositories.push(producer);
  await configureIdentity(producer);
  await producer.git('remote', 'add', 'origin', remotePath);
  await producer.git('fetch', '--quiet', 'origin', branch);
  await producer.git('switch', '--quiet', '-c', branch, 'FETCH_HEAD');
  return producer;
}

async function createRepository() {
  const repository = await createTemporaryGitRepository();
  repositories.push(repository);
  await configureIdentity(repository);
  return repository;
}

async function configureIdentity(repository: TemporaryGitRepository) {
  await repository.git('config', 'user.name', 'Codex Git Tests');
  await repository.git('config', 'user.email', 'codex-git@example.test');
}

async function snapshot(
  session: RepositorySession,
): Promise<RepositorySnapshot> {
  const result = await session.requestRefresh();
  if (result.kind !== 'repository') throw new Error('Expected Repository.');
  return result.repository;
}

let commandSequence = 0;
async function dispatchAndRecover(
  session: RepositorySession,
  command: ProductCommand,
) {
  commandSequence += 1;
  const clientCommandId = `command_${commandSequence
    .toString(16)
    .padStart(32, '0')}` as ClientCommandId;
  const receipt = await session.dispatch({ clientCommandId, command });
  return session.recoverOperation(receipt.operationId);
}

async function readStatus(repository: TemporaryGitRepository) {
  return (await repository.git('status', '--porcelain')).stdout;
}
