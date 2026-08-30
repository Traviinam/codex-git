import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AbsolutePath } from '@codex-git/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRepositoryEngine,
  type RepositoryOpenResult,
  type RepositorySession,
  type RepositorySnapshot,
} from '@codex-git/repository-engine';

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

describe('Repository Fetch', () => {
  it('fetches one opaque Remote without changing the Working Tree or Index', async () => {
    const { repository, remotePath, branch } = await remoteFixture();
    const producer = await createTemporaryGitRepository();
    repositories.push(producer);
    await configureIdentity(producer);
    await producer.git('remote', 'add', 'origin', remotePath);
    await producer.git('fetch', '--quiet', 'origin');
    await producer.git('switch', '--quiet', '-c', branch, `origin/${branch}`);
    await writeFile(join(producer.path, 'remote.txt'), 'remote change\n');
    await producer.git('add', '--', 'remote.txt');
    await producer.git('commit', '--quiet', '-m', 'Advance remote');
    const remoteObjectId = (
      await producer.git('rev-parse', 'HEAD')
    ).stdout.trim();
    await producer.git('push', '--quiet', 'origin', branch);

    await writeFile(join(repository.path, 'local.txt'), 'local bytes\n');
    const workingTreeBefore = await readFile(
      join(repository.path, 'local.txt'),
    );
    const indexBefore = (await repository.git('write-tree')).stdout.trim();
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    await repository.git(
      'update-ref',
      'refs/remotes/origin/retained-without-prune',
      'HEAD',
    );
    const before = await snapshotRepository(session);
    const remote = before.remotes[0];
    if (remote === undefined) throw new Error('Expected fixture Remote.');

    const admission = await session.fetch({
      repositoryId: before.repositoryId,
      remoteId: remote.remoteId,
      expectedRefsRevision: before.refsRevision,
    });
    expect(admission.kind).toBe('accepted');
    if (admission.kind !== 'accepted') {
      throw new Error('Expected Fetch admission.');
    }
    const result = await session.recoverOperation(
      admission.operation.operationId,
    );

    expect(result).toMatchObject({
      kind: 'succeeded',
      result: { kind: 'remote', summary: 'Fetched origin.' },
    });
    const after = await snapshotRepository(session);
    expect(
      after.refs.find(
        ({ fullName }) => fullName === `refs/remotes/origin/${branch}`,
      )?.objectId,
    ).toBe(remoteObjectId);
    expect(
      after.refs.some(
        ({ fullName }) =>
          fullName === 'refs/remotes/origin/retained-without-prune',
      ),
    ).toBe(true);
    expect(after.fetch).toMatchObject({
      kind: 'current',
      fetchedAt: expect.any(String),
    });
    expect(after.remoteFetches).toEqual([
      { remoteId: remote.remoteId, fetchedAt: expect.any(String) },
    ]);
    expect(await readFile(join(repository.path, 'local.txt'))).toEqual(
      workingTreeBefore,
    );
    expect((await repository.git('write-tree')).stdout.trim()).toBe(
      indexBefore,
    );
    await session.close();
  });

  it('Fetch all preserves successful updates and attributes every Remote result', async () => {
    const { repository, remotePath, branch } = await remoteFixture();
    const producer = await createTemporaryGitRepository();
    repositories.push(producer);
    await configureIdentity(producer);
    await producer.git('remote', 'add', 'origin', remotePath);
    await producer.git('fetch', '--quiet', 'origin');
    await producer.git('switch', '--quiet', '-c', branch, `origin/${branch}`);
    await writeFile(join(producer.path, 'second.txt'), 'second\n');
    await producer.git('add', '--', 'second.txt');
    await producer.git('commit', '--quiet', '-m', 'Second remote commit');
    const fetchedObjectId = (
      await producer.git('rev-parse', 'HEAD')
    ).stdout.trim();
    await producer.git('push', '--quiet', 'origin', branch);
    const missingRemotePath = join(remotePath, 'missing.git');
    await repository.git('remote', 'add', 'broken', missingRemotePath);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const before = await snapshotRepository(session);

    const admission = await session.fetch({
      repositoryId: before.repositoryId,
      remoteId: null,
      expectedRefsRevision: before.refsRevision,
    });
    if (admission.kind !== 'accepted') {
      throw new Error('Expected Fetch-all admission.');
    }
    const result = await session.recoverOperation(
      admission.operation.operationId,
    );

    expect(result).toMatchObject({
      kind: 'partial_success',
      message: 'Some Remotes were fetched.',
      effects: [
        {
          kind: 'failed_known',
          label: 'broken',
          code: 'invalid_remote',
          message: 'The configured Remote is invalid.',
        },
        { kind: 'succeeded', label: 'origin' },
      ],
    });
    const after = await snapshotRepository(session);
    expect(
      after.refs.find(
        ({ fullName }) => fullName === `refs/remotes/origin/${branch}`,
      )?.objectId,
    ).toBe(fetchedObjectId);
    expect(after.fetch).toMatchObject({
      kind: 'stale',
      fetchedAt: expect.any(String),
      message: 'Some Remotes could not be fetched.',
    });
    await session.close();
  });

  it('classifies an unreachable credentialed URL without exposing secrets', async () => {
    const repository = await createTemporaryGitRepository();
    repositories.push(repository);
    await configureIdentity(repository);
    await writeFile(join(repository.path, 'README.md'), 'fixture\n');
    await repository.git('add', '--', 'README.md');
    await repository.git('commit', '--quiet', '-m', 'Create fixture');
    await repository.git(
      'remote',
      'add',
      'origin',
      'https://user:super-secret@127.0.0.1:1/repository.git?token=private',
    );
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const snapshot = await snapshotRepository(session);
    const remote = snapshot.remotes[0];
    if (remote === undefined) throw new Error('Expected fixture Remote.');

    const admission = await session.fetch({
      repositoryId: snapshot.repositoryId,
      remoteId: remote.remoteId,
      expectedRefsRevision: snapshot.refsRevision,
    });
    if (admission.kind !== 'accepted') {
      throw new Error('Expected Fetch admission.');
    }
    const result = await session.recoverOperation(
      admission.operation.operationId,
    );

    expect(result).toMatchObject({
      kind: 'failed_known',
      code: 'offline',
      message: 'The Remote could not be reached.',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /super-secret|token=private|user@|https:/u,
    );
    const after = await snapshotRepository(session);
    expect(after.fetch).toEqual({
      kind: 'failed',
      fetchedAt: null,
      message: 'The Remote could not be reached.',
    });
    await session.close();
  });

  it('rejects stale Remote authority before contacting a Remote', async () => {
    const { repository, remotePath } = await remoteFixture();
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const snapshot = await snapshotRepository(session);
    const remote = snapshot.remotes[0];
    if (remote === undefined) throw new Error('Expected fixture Remote.');
    await repository.git(
      'remote',
      'set-url',
      'origin',
      join(remotePath, 'missing-after-observation.git'),
    );
    const changed = await snapshotRepository(session);
    expect(changed.refsRevision).toBeGreaterThan(snapshot.refsRevision);

    const admission = await session.fetch({
      repositoryId: snapshot.repositoryId,
      remoteId: remote.remoteId,
      expectedRefsRevision: snapshot.refsRevision,
    });
    if (admission.kind !== 'accepted') {
      throw new Error('Expected Fetch admission.');
    }
    const result = await session.recoverOperation(
      admission.operation.operationId,
    );

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'stale',
      message: 'Repository refs or Remote configuration changed.',
    });
    await session.close();
  });
});

async function remoteFixture(): Promise<{
  readonly branch: string;
  readonly remotePath: string;
  readonly repository: TemporaryGitRepository;
}> {
  const repository = await createTemporaryGitRepository();
  repositories.push(repository);
  await configureIdentity(repository);
  await writeFile(join(repository.path, 'README.md'), 'fixture\n');
  await repository.git('add', '--', 'README.md');
  await repository.git('commit', '--quiet', '-m', 'Create fixture');
  const branch = (
    await repository.git('branch', '--show-current')
  ).stdout.trim();
  const remotePath = await mkdtemp(join(tmpdir(), 'codex-git-remote-'));
  temporaryDirectories.push(remotePath);
  await repository.git('init', '--quiet', '--bare', remotePath);
  await repository.git('remote', 'add', 'origin', remotePath);
  await repository.git('push', '--quiet', '-u', 'origin', branch);
  return { branch, remotePath, repository };
}

async function configureIdentity(repository: TemporaryGitRepository) {
  await repository.git('config', 'user.name', 'Codex Git Tests');
  await repository.git('config', 'user.email', 'codex-git@example.test');
}

async function snapshotRepository(
  session: RepositorySession,
): Promise<RepositorySnapshot> {
  const result: RepositoryOpenResult = await session.requestRefresh();
  if (result.kind !== 'repository') {
    throw new Error('Expected Repository snapshot.');
  }
  return result.repository;
}
