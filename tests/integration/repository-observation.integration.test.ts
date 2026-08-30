import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AbsolutePath } from '@codex-git/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRepositoryEngine,
  type RepositorySession,
  type RepositorySnapshot,
} from '@codex-git/repository-engine';

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
    externalPaths
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe('Repository observation', () => {
  it('publishes coherent local refs, sanitized Remotes, Index, and status facts', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git(
      'remote',
      'add',
      'origin',
      'https://user:secret@example.test/team/repository.git?token=private',
    );
    const branch = (
      await repository.git('branch', '--show-current')
    ).stdout.trim();
    const head = (await repository.git('rev-parse', 'HEAD')).stdout.trim();
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );

    const snapshot = await snapshotRepository(session);

    expect(snapshot.refs).toContainEqual({
      kind: 'local',
      fullName: `refs/heads/${branch}`,
      objectId: head,
    });
    expect(snapshot.remotes).toEqual([
      {
        remoteId: expect.stringMatching(/^remote_[0-9a-f]{32}$/u),
        displayName: 'origin',
        host: 'example.test',
      },
    ]);
    expect(snapshot.worktrees[0]).toMatchObject({
      freshness: { kind: 'fresh' },
      index: { entryCount: 1, locked: false },
      status: {
        clean: true,
        conflicted: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
      },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|token=|https:/u);
    await session.close();
  });

  it('keeps Remote identity across configuration changes and replaces it after removal', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git(
      'remote',
      'add',
      'origin',
      'https://first:secret@example.test/team/one.git',
    );
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const initial = await snapshotRepository(session);
    const initialRemote = initial.remotes[0]!;

    await repository.git(
      'remote',
      'set-url',
      'origin',
      'https://second:private@example.test/team/two.git',
    );
    const reconfigured = await snapshotRepository(session);
    expect(reconfigured.remotes).toEqual([
      {
        remoteId: initialRemote.remoteId,
        displayName: 'origin',
        host: 'example.test',
      },
    ]);
    expect(reconfigured.refsRevision).toBe(initial.refsRevision + 1);
    expect(reconfigured.repositoryRevision).toBe(
      initial.repositoryRevision + 1,
    );

    await repository.git('remote', 'remove', 'origin');
    const removed = await snapshotRepository(session);
    expect(removed.remotes).toEqual([]);
    await repository.git(
      'remote',
      'add',
      'origin',
      'ssh://git@example.test/team/three.git',
    );
    const recreated = await snapshotRepository(session);
    expect(recreated.remotes[0]).toMatchObject({
      displayName: 'origin',
      host: 'example.test',
    });
    expect(recreated.remotes[0]?.remoteId).not.toBe(initialRemote.remoteId);
    await session.close();
  });

  it('advances only shared refs axes for external Local and Remote-tracking ref changes', async () => {
    const repository = await createRepositoryWithCommit();
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const initial = await snapshotRepository(session);
    const head = (await repository.git('rev-parse', 'HEAD')).stdout.trim();

    await repository.git('branch', 'observed-local');
    await repository.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const changed = await snapshotRepository(session);

    expect(changed.refs).toEqual(
      expect.arrayContaining([
        {
          kind: 'local',
          fullName: 'refs/heads/observed-local',
          objectId: head,
        },
        {
          kind: 'remote_tracking',
          fullName: 'refs/remotes/origin/main',
          objectId: head,
        },
      ]),
    );
    expect(changed.repositoryRevision).toBe(initial.repositoryRevision + 1);
    expect(changed.refsRevision).toBe(initial.refsRevision + 1);
    expect(changed.topologyRevision).toBe(initial.topologyRevision);
    expect(
      changed.worktrees.map(({ worktreeRevision }) => worktreeRevision),
    ).toEqual(
      initial.worktrees.map(({ worktreeRevision }) => worktreeRevision),
    );
    await session.close();
  });

  it('versions external Index, status, HEAD, and attached ref changes on their owning axes', async () => {
    const repository = await createRepositoryWithCommit();
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const initial = await snapshotRepository(session);
    const initialWorktree = initial.worktrees[0]!;

    await writeFile(join(repository.path, 'README.md'), 'staged change\n');
    await repository.git('add', '--', 'README.md');
    const staged = await snapshotRepository(session);
    expect(staged.worktrees[0]).toMatchObject({
      worktreeRevision: initialWorktree.worktreeRevision + 1,
      status: { clean: false, staged: 1, unstaged: 0 },
    });
    expect(staged.worktrees[0]?.index).not.toEqual(initialWorktree.index);
    expect(staged.refsRevision).toBe(initial.refsRevision);
    expect(staged.topologyRevision).toBe(initial.topologyRevision);

    await repository.git('commit', '--quiet', '-m', 'Advance observed HEAD');
    const committed = await snapshotRepository(session);
    const committedHead = (
      await repository.git('rev-parse', 'HEAD')
    ).stdout.trim();
    expect(committed.worktrees[0]).toMatchObject({
      worktreeRevision: staged.worktrees[0]!.worktreeRevision + 1,
      head: { kind: 'local_branch', objectId: committedHead },
      status: { clean: true, staged: 0, unstaged: 0 },
    });
    expect(committed.refsRevision).toBe(staged.refsRevision + 1);
    expect(committed.topologyRevision).toBe(staged.topologyRevision);
    await session.close();
  });

  it('observes effective global, include, includeIf, and Worktree Remote configuration', async () => {
    const repository = await createRepositoryWithCommit();
    const home = await mkdtemp(join(tmpdir(), 'codex-git-remote-home-'));
    externalPaths.push(home);
    const included = join(home, 'included.config');
    const conditional = join(home, 'conditional.config');
    const gitDirectory = await realpath(join(repository.path, '.git'));
    await writeFile(
      included,
      '[remote "included"]\n\turl = ssh://git@included.example/team/repo.git\n',
    );
    await writeFile(
      conditional,
      '[remote "conditional"]\n\turl = https://conditional.example/team/repo.git\n',
    );
    await writeFile(
      join(home, '.gitconfig'),
      [
        '[remote "global"]',
        '\turl = team:repo.git',
        '[url "ssh://git@global.example/"]',
        '\tinsteadOf = team:',
        '[include]',
        `\tpath = ${included}`,
        `[includeIf "gitdir:${gitDirectory}"]`,
        `\tpath = ${conditional}`,
        '',
      ].join('\n'),
    );
    await repository.git('config', 'extensions.worktreeConfig', 'true');
    await repository.git(
      'config',
      '--worktree',
      'remote.worktree.url',
      'file:///tmp/effective-repository.git',
    );
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    try {
      const snapshot = await snapshotRepository(session);
      expect(
        snapshot.remotes.map(({ displayName, host }) => ({
          displayName,
          host,
        })),
      ).toEqual([
        { displayName: 'conditional', host: 'conditional.example' },
        { displayName: 'global', host: 'global.example' },
        { displayName: 'included', host: 'included.example' },
        { displayName: 'worktree', host: 'local' },
      ]);
    } finally {
      await session.close();
      restoreEnvironment('HOME', previousHome);
    }
  });

  it('retains only a failed Worktree while publishing fresh unaffected observations', async () => {
    const repository = await createRepositoryWithCommit();
    const linkedPath = `${repository.path}-partial-failure`;
    externalPaths.push(linkedPath);
    await repository.git('worktree', 'add', '--quiet', '--detach', linkedPath);
    const canonicalLinkedPath = await realpath(linkedPath);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const initial = await snapshotRepository(session);
    const initialMain = initial.worktrees.find(({ role }) => role === 'main')!;
    const initialLinked = initial.worktrees.find(
      ({ canonicalPath }) => canonicalPath === canonicalLinkedPath,
    )!;
    await writeFile(join(repository.path, 'main-change.txt'), 'main\n');
    await writeFile(join(linkedPath, 'linked-change.txt'), 'linked\n');

    const wrapperDirectory = await createFailingWorktreeWrapper();
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}:${previousPath ?? ''}`;
    process.env.CODEX_GIT_FAIL_WORKTREE = canonicalLinkedPath;
    try {
      const partial = await snapshotRepository(session);
      const partialMain = partial.worktrees.find(
        ({ role }) => role === 'main',
      )!;
      const partialLinked = partial.worktrees.find(
        ({ canonicalPath }) => canonicalPath === canonicalLinkedPath,
      )!;
      expect(partial.refresh).toEqual({ kind: 'fresh' });
      expect(partialMain).toMatchObject({
        freshness: { kind: 'fresh' },
        status: { untracked: 1 },
      });
      expect(partialMain.worktreeRevision).toBe(
        initialMain.worktreeRevision + 1,
      );
      expect(partialLinked.freshness).toEqual({
        kind: 'stale',
        error: {
          code: 'git_read_failed',
          message: 'Git could not observe this Worktree.',
        },
      });
      expect(partialLinked.status).toEqual(initialLinked.status);
      expect(partialLinked.index).toEqual(initialLinked.index);
      expect(partialLinked.worktreeRevision).toBe(
        initialLinked.worktreeRevision + 1,
      );
      expect(partial.topologyRevision).toBe(initial.topologyRevision);
      expect(partial.refsRevision).toBe(initial.refsRevision);
    } finally {
      restoreEnvironment('PATH', previousPath);
      delete process.env.CODEX_GIT_FAIL_WORKTREE;
      await session.close();
    }
  });

  it('publishes an unavailable first-read Worktree without false status data', async () => {
    const repository = await createRepositoryWithCommit();
    const linkedPath = `${repository.path}-unavailable`;
    externalPaths.push(linkedPath);
    await repository.git('worktree', 'add', '--quiet', '--detach', linkedPath);
    await repository.git(
      'worktree',
      'lock',
      '--reason',
      'fixture unavailable',
      linkedPath,
    );
    await rm(linkedPath, { recursive: true });

    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const snapshot = await snapshotRepository(session);
    const unavailable = snapshot.worktrees.find(
      ({ role }) => role === 'linked',
    )!;
    expect(unavailable.availability.kind).toBe('unavailable');
    expect(unavailable.freshness).toEqual({ kind: 'unavailable' });
    expect(unavailable.index).toBeNull();
    expect(unavailable.status).toBeNull();
    await session.close();
  });
});

async function createFailingWorktreeWrapper(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), 'codex-git-observation-failure-'),
  );
  externalPaths.push(directory);
  const wrapper = join(directory, 'git');
  await writeFile(
    wrapper,
    [
      '#!/bin/sh',
      'if [ "$1" = "-C" ] && [ "$2" = "$CODEX_GIT_FAIL_WORKTREE" ] && [ "$3" = "status" ]; then',
      '  exit 42',
      'fi',
      'exec /usr/bin/git "$@"',
      '',
    ].join('\n'),
  );
  await chmod(wrapper, 0o755);
  return directory;
}

async function createRepositoryWithCommit(): Promise<TemporaryGitRepository> {
  const repository = await createTemporaryGitRepository();
  repositories.push(repository);
  await repository.git('config', 'user.name', 'Codex Git Tests');
  await repository.git('config', 'user.email', 'codex-git@example.test');
  await writeFile(join(repository.path, 'README.md'), 'fixture\n');
  await repository.git('add', '--', 'README.md');
  await repository.git('commit', '--quiet', '-m', 'Create fixture');
  return repository;
}

async function snapshotRepository(
  session: RepositorySession,
): Promise<RepositorySnapshot> {
  const result = await session.snapshot();
  if (result.kind !== 'repository') {
    throw new Error('Expected a Repository snapshot.');
  }
  return result.repository;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
