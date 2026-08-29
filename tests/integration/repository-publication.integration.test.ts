import {
  access,
  chmod,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AbsolutePath } from '@codex-git/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRepositoryEngine,
  RepositorySessionFailure,
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

describe('Repository snapshot publication', () => {
  it('publishes a deeply immutable versioned view without authority bytes', async () => {
    const repository = await createRepositoryWithCommit();
    const session = await createRepositoryEngine().open(
      asAbsolutePath(repository.path),
    );

    const published = await snapshotRepository(session);

    expect(published).toMatchObject({
      repositoryRevision: 1,
      topologyRevision: 1,
      refsRevision: 1,
      refresh: { kind: 'fresh' },
    });
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.refresh)).toBe(true);
    expect(Object.isFrozen(published.worktrees)).toBe(true);
    expect(Object.isFrozen(published.worktrees[0])).toBe(true);
    expect(Object.isFrozen(published.worktrees[0]?.head)).toBe(true);
    expect(Object.isFrozen(published.worktrees[0]?.availability)).toBe(true);
    expect('canonicalPathBytes' in published.worktrees[0]!).toBe(false);

    const events = session.subscribe()[Symbol.asyncIterator]();
    const repeated = await snapshotRepository(session);
    expect(repeated.repositoryRevision).toBe(published.repositoryRevision);
    expect(repeated.topologyRevision).toBe(published.topologyRevision);
    expect(repeated.refsRevision).toBe(published.refsRevision);
    await expect(noEvent(events)).resolves.toBe(true);
    await session.close();
  });

  it('advances only Worktree and Repository revisions for Git lock changes', async () => {
    const repository = await createRepositoryWithCommit();
    const linkedPath = `${repository.path}-locked`;
    externalPaths.push(linkedPath);
    await repository.git('worktree', 'add', '--quiet', '--detach', linkedPath);
    const canonicalLinkedPath = await realpath(linkedPath);
    const session = await createRepositoryEngine().open(
      asAbsolutePath(repository.path),
    );
    const initial = await snapshotRepository(session);
    const initialMain = initial.worktrees.find(({ role }) => role === 'main')!;
    const initialLinked = initial.worktrees.find(
      ({ canonicalPath }) => canonicalPath === canonicalLinkedPath,
    )!;

    await repository.git(
      'worktree',
      'lock',
      '--reason',
      'review fixture',
      linkedPath,
    );
    const locked = await snapshotRepository(session);
    const lockedMain = locked.worktrees.find(({ role }) => role === 'main')!;
    const lockedLinked = locked.worktrees.find(
      ({ canonicalPath }) => canonicalPath === canonicalLinkedPath,
    )!;

    expect(locked.repositoryRevision).toBe(initial.repositoryRevision + 1);
    expect(locked.topologyRevision).toBe(initial.topologyRevision);
    expect(lockedMain.worktreeRevision).toBe(initialMain.worktreeRevision);
    expect(lockedLinked.worktreeRevision).toBe(
      initialLinked.worktreeRevision + 1,
    );
    expect(lockedLinked.gitLock).toEqual({
      kind: 'locked',
      reason: 'review fixture',
    });

    await repository.git('worktree', 'unlock', linkedPath);
    const unlocked = await snapshotRepository(session);
    const unlockedLinked = unlocked.worktrees.find(
      ({ canonicalPath }) => canonicalPath === canonicalLinkedPath,
    )!;
    expect(unlocked.repositoryRevision).toBe(locked.repositoryRevision + 1);
    expect(unlocked.topologyRevision).toBe(locked.topologyRevision);
    expect(unlockedLinked.worktreeRevision).toBe(
      lockedLinked.worktreeRevision + 1,
    );
    expect(unlockedLinked.gitLock).toEqual({ kind: 'unlocked' });
    await session.close();
  });

  it('does not publish or notify a superseded snapshot that completes late', async () => {
    const repository = await createRepositoryWithCommit();
    const session = await createRepositoryEngine().open(
      asAbsolutePath(repository.path),
    );
    const initial = await snapshotRepository(session);
    const events = session.subscribe()[Symbol.asyncIterator]();
    const wrapperDirectory = await createDelayedWorktreeListWrapper();
    const marker = join(wrapperDirectory, 'started');
    const release = join(wrapperDirectory, 'release');
    const output = join(wrapperDirectory, 'inventory');
    const linkedPath = `${repository.path}-newer`;
    externalPaths.push(linkedPath);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}:${previousPath ?? ''}`;
    process.env.CODEX_GIT_PUBLICATION_MARKER = marker;
    process.env.CODEX_GIT_PUBLICATION_RELEASE = release;
    process.env.CODEX_GIT_PUBLICATION_OUTPUT = output;

    try {
      const older = session.snapshot();
      await waitForPath(marker);
      await repository.git(
        'worktree',
        'add',
        '--quiet',
        '--detach',
        linkedPath,
      );
      const newer = await snapshotRepository(session);
      expect(newer.repositoryRevision).toBe(initial.repositoryRevision + 1);
      expect(newer.worktrees).toHaveLength(2);
      await expect(events.next()).resolves.toEqual({
        done: false,
        value: {
          kind: 'repository',
          repositoryRevision: newer.repositoryRevision,
          refresh: { kind: 'fresh' },
        },
      });

      await writeFile(release, 'continue\n');
      const late = await older;
      expect(late).toEqual({ kind: 'repository', repository: newer });
      await expect(noEvent(events)).resolves.toBe(true);
    } finally {
      await writeFile(release, 'continue\n');
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      delete process.env.CODEX_GIT_PUBLICATION_MARKER;
      delete process.env.CODEX_GIT_PUBLICATION_RELEASE;
      delete process.env.CODEX_GIT_PUBLICATION_OUTPUT;
      await session.close();
    }
  });

  it('closes subscriptions and rejects an in-flight read without late publication', async () => {
    const repository = await createRepositoryWithCommit();
    const session = await createRepositoryEngine().open(
      asAbsolutePath(repository.path),
    );
    const events = session.subscribe()[Symbol.asyncIterator]();
    const wrapperDirectory = await createDelayedWorktreeListWrapper();
    const marker = join(wrapperDirectory, 'started');
    const release = join(wrapperDirectory, 'release');
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}:${previousPath ?? ''}`;
    process.env.CODEX_GIT_PUBLICATION_MARKER = marker;
    process.env.CODEX_GIT_PUBLICATION_RELEASE = release;
    process.env.CODEX_GIT_PUBLICATION_OUTPUT = join(
      wrapperDirectory,
      'inventory',
    );

    try {
      const inFlight = session.snapshot();
      await waitForPath(marker);
      await session.close();
      await expect(events.next()).resolves.toEqual({
        done: true,
        value: undefined,
      });
      await writeFile(release, 'continue\n');
      const failure: unknown = await inFlight.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RepositorySessionFailure);
      expect(failure).toMatchObject({
        code: 'closed',
        message: 'Repository Session is closed.',
      });
    } finally {
      await writeFile(release, 'continue\n');
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      delete process.env.CODEX_GIT_PUBLICATION_MARKER;
      delete process.env.CODEX_GIT_PUBLICATION_RELEASE;
      delete process.env.CODEX_GIT_PUBLICATION_OUTPUT;
    }
  });

  it('retains last-good data with a typed output-too-large refresh failure', async () => {
    const repository = await createRepositoryWithCommit();
    const session = await createRepositoryEngine().open(
      asAbsolutePath(repository.path),
    );
    const lastGood = await snapshotRepository(session);
    const wrapperDirectory = await mkdtemp(
      join(tmpdir(), 'codex-git-publication-output-limit-'),
    );
    externalPaths.push(wrapperDirectory);
    await writeFile(
      join(wrapperDirectory, 'git'),
      [
        '#!/bin/sh',
        'if [ "$1" = "--git-dir" ] && [ "$3" = "worktree" ]; then',
        '  dd if=/dev/zero bs=1048576 count=5 2>/dev/null',
        '  exit 0',
        'fi',
        'exec /usr/bin/git "$@"',
        '',
      ].join('\n'),
    );
    await chmod(join(wrapperDirectory, 'git'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}:${previousPath ?? ''}`;

    try {
      const staleEvents = session.subscribe()[Symbol.asyncIterator]();
      const failed = await snapshotRepository(session);

      expect(failed.refresh).toEqual({
        kind: 'stale',
        error: {
          code: 'git_output_too_large',
          message: 'Git output exceeded the local observation limit.',
        },
      });
      expect(failed.repositoryRevision).toBe(lastGood.repositoryRevision + 1);
      expect(failed.topologyRevision).toBe(lastGood.topologyRevision);
      expect(failed.refsRevision).toBe(lastGood.refsRevision);
      expect(failed.worktrees).toEqual(lastGood.worktrees);
      await expect(staleEvents.next()).resolves.toEqual({
        done: false,
        value: {
          kind: 'repository',
          repositoryRevision: failed.repositoryRevision,
          refresh: failed.refresh,
        },
      });

      const repeatedEvents = session.subscribe()[Symbol.asyncIterator]();
      const repeated = await snapshotRepository(session);
      expect(repeated.repositoryRevision).toBe(failed.repositoryRevision);
      expect(repeated.refresh).toEqual(failed.refresh);
      await expect(noEvent(repeatedEvents)).resolves.toBe(true);

      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      const recovered = await snapshotRepository(session);
      expect(recovered.refresh).toEqual({ kind: 'fresh' });
      expect(recovered.repositoryRevision).toBe(failed.repositoryRevision + 1);
      expect(recovered.topologyRevision).toBe(lastGood.topologyRevision);
      expect(recovered.refsRevision).toBe(lastGood.refsRevision);
      expect(recovered.worktrees).toEqual(lastGood.worktrees);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      await session.close();
    }
  });

  it('reports a bounded Git command failure without inventing Repository data', async () => {
    const repository = await createRepositoryWithCommit();
    const session = await createRepositoryEngine().open(
      asAbsolutePath(repository.path),
    );
    const wrapperDirectory = await mkdtemp(
      join(tmpdir(), 'codex-git-publication-command-failure-'),
    );
    externalPaths.push(wrapperDirectory);
    await writeFile(
      join(wrapperDirectory, 'git'),
      [
        '#!/bin/sh',
        'if [ "$1" = "--git-dir" ] && [ "$3" = "worktree" ]; then',
        '  exit 42',
        'fi',
        'exec /usr/bin/git "$@"',
        '',
      ].join('\n'),
    );
    await chmod(join(wrapperDirectory, 'git'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}:${previousPath ?? ''}`;

    try {
      await expect(session.snapshot()).resolves.toEqual({
        kind: 'failed',
        refresh: {
          kind: 'failed',
          error: {
            code: 'git_read_failed',
            message: 'Git could not produce a local observation.',
          },
        },
      });
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      await session.close();
    }
  });
});

async function createDelayedWorktreeListWrapper(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), 'codex-git-publication-delay-'),
  );
  externalPaths.push(directory);
  const wrapper = join(directory, 'git');
  await writeFile(
    wrapper,
    [
      '#!/bin/sh',
      'if [ "$1" = "--git-dir" ] && [ "$3" = "worktree" ] && [ ! -e "$CODEX_GIT_PUBLICATION_MARKER" ]; then',
      '  /usr/bin/git "$@" > "$CODEX_GIT_PUBLICATION_OUTPUT"',
      '  git_status=$?',
      '  : > "$CODEX_GIT_PUBLICATION_MARKER"',
      '  while [ ! -e "$CODEX_GIT_PUBLICATION_RELEASE" ]; do sleep 0.01; done',
      '  cat "$CODEX_GIT_PUBLICATION_OUTPUT"',
      '  exit "$git_status"',
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

function asAbsolutePath(path: string): AbsolutePath {
  return path as AbsolutePath;
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(path)}.`);
}

async function noEvent(events: AsyncIterator<unknown>): Promise<boolean> {
  const empty = await Promise.race([
    events.next().then(() => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), 50)),
  ]);
  if (empty) {
    await events.return?.();
  }
  return empty;
}
