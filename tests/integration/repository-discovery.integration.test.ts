import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

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

describe('Repository Engine discovery', () => {
  it('returns a safe non-repository result for an ordinary directory', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'codex-git-non-repository-'),
    );
    externalPaths.push(directory);

    const session = await createRepositoryEngine().open(
      asAbsolutePath(directory),
    );
    const result = await session.snapshot();

    expect(result).toEqual({ kind: 'not_repository' });
  });

  it('represents an Initial Repository without inventing a Commit', async () => {
    const repository = await createTemporaryGitRepository();
    repositories.push(repository);

    const result = await openRepository(
      createRepositoryEngine(),
      repository.path,
    );

    expect(result.worktrees[0]?.head).toMatchObject({
      kind: 'local_branch',
      fullName: expect.stringMatching(/^refs\/heads\//u),
      objectId: null,
    });
  });

  it('invalidates the session when the Repository is replaced at the same path', async () => {
    const repository = await createRepositoryWithCommit();
    const engine = createRepositoryEngine();
    const session = await engine.open(asAbsolutePath(repository.path));
    const original = await snapshotRepository(session);
    await rename(
      join(repository.path, '.git'),
      join(repository.path, '.git-replaced'),
    );
    await repository.git('init', '--quiet');

    await expect(session.snapshot()).rejects.toThrow(
      'Repository Session is invalid because the Repository was replaced.',
    );

    const replacement = await openRepository(engine, repository.path);
    expect(replacement.repositoryId).not.toBe(original.repositoryId);
  });

  it('does not publish an in-flight snapshot after the session closes', async () => {
    const repository = await createRepositoryWithCommit();
    const session = await createRepositoryEngine().open(
      asAbsolutePath(repository.path),
    );
    const wrapperDirectory = await mkdtemp(
      join(tmpdir(), 'codex-git-delayed-git-'),
    );
    externalPaths.push(wrapperDirectory);
    const wrapper = join(wrapperDirectory, 'git');
    const marker = join(wrapperDirectory, 'started');
    const release = join(wrapperDirectory, 'release');
    await writeFile(
      wrapper,
      [
        '#!/bin/sh',
        'if [ "$1" = "--git-dir" ]; then',
        '  : > "$CODEX_GIT_TEST_MARKER"',
        '  while [ ! -e "$CODEX_GIT_TEST_RELEASE" ]; do sleep 0.01; done',
        'fi',
        'exec /usr/bin/git "$@"',
        '',
      ].join('\n'),
    );
    await chmod(wrapper, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}:${previousPath ?? ''}`;
    process.env.CODEX_GIT_TEST_MARKER = marker;
    process.env.CODEX_GIT_TEST_RELEASE = release;

    try {
      const snapshot = session.snapshot();
      const rejectedSnapshot = expect(snapshot).rejects.toThrow(
        'Repository Session is closed.',
      );
      await waitForPath(marker);
      await session.close();
      await writeFile(release, 'continue\n');

      await rejectedSnapshot;
      await expect(session.snapshot()).rejects.toThrow(
        'Repository Session is closed.',
      );
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      delete process.env.CODEX_GIT_TEST_MARKER;
      delete process.env.CODEX_GIT_TEST_RELEASE;
      await writeFile(release, 'continue\n');
    }
  });

  it('resolves the anchor independently of inherited Git directory overrides', async () => {
    const repository = await createRepositoryWithCommit();
    const unrelated = await createRepositoryWithCommit();
    const previousGitDirectory = process.env.GIT_DIR;
    process.env.GIT_DIR = join(unrelated.path, '.git');

    try {
      const result = await openRepository(
        createRepositoryEngine(),
        repository.path,
      );

      expect(result.commonGitDirectory).toBe(
        await realpath(join(repository.path, '.git')),
      );
    } finally {
      if (previousGitDirectory === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previousGitDirectory;
      }
    }
  });

  it('ignores inherited Git discovery ceilings', async () => {
    const repository = await createRepositoryWithCommit();
    const nested = join(repository.path, 'nested');
    await mkdir(nested);
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = repository.path;

    try {
      const result = await openRepository(createRepositoryEngine(), nested);

      expect(result.commonGitDirectory).toBe(
        await realpath(join(repository.path, '.git')),
      );
    } finally {
      if (previousCeiling === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      }
    }
  });

  it('resolves anchors in Main and Linked Worktrees to one canonical Repository', async () => {
    const repository = await createRepositoryWithCommit();
    const linkedPath = join(
      dirname(repository.path),
      `-${basename(repository.path)} linked 工作树`,
    );
    externalPaths.push(linkedPath);
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature/linked',
      linkedPath,
    );
    const linkedSubdirectory = join(linkedPath, 'nested');
    await mkdir(linkedSubdirectory);

    const engine = createRepositoryEngine();
    const mainSession = await engine.open(asAbsolutePath(repository.path));
    const linkedSession = await engine.open(asAbsolutePath(linkedSubdirectory));
    const mainResult = await mainSession.snapshot();
    const linkedResult = await linkedSession.snapshot();

    expect(mainResult.kind).toBe('repository');
    expect(linkedResult.kind).toBe('repository');
    if (
      mainResult.kind !== 'repository' ||
      linkedResult.kind !== 'repository'
    ) {
      return;
    }

    expect(linkedResult.repository.commonGitDirectory).toBe(
      mainResult.repository.commonGitDirectory,
    );
    expect(mainResult.repository.commonGitDirectory).toBe(
      await realpath(join(repository.path, '.git')),
    );
    expect(mainResult.repository.worktrees).toHaveLength(2);
    expect(mainResult.repository.worktrees.map(({ role }) => role)).toEqual([
      'main',
      'linked',
    ]);
    expect(mainResult.repository.selectedWorktreeId).toBe(
      mainResult.repository.worktrees[0]?.worktreeId,
    );
    expect(linkedResult.repository.selectedWorktreeId).toBe(
      linkedResult.repository.worktrees[1]?.worktreeId,
    );
    expect(linkedResult.repository.worktrees[1]?.canonicalPath).toBe(
      await realpath(linkedPath),
    );
    expect(linkedResult.repository.worktrees[1]?.head).toEqual({
      kind: 'local_branch',
      fullName: 'refs/heads/feature/linked',
      displayName: 'feature/linked',
      objectId: expect.stringMatching(/^[0-9a-f]{40}$/u),
    });
  });

  it('keeps inventory available when the selected Linked Worktree disappears', async () => {
    const repository = await createRepositoryWithCommit();
    const linkedPath = join(
      dirname(repository.path),
      `${basename(repository.path)}-disappearing`,
    );
    externalPaths.push(linkedPath);
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature/disappearing',
      linkedPath,
    );
    const session = await createRepositoryEngine().open(
      asAbsolutePath(linkedPath),
    );
    await rm(linkedPath, { recursive: true });

    const result = await session.snapshot();

    expect(result.kind).toBe('repository');
    if (result.kind !== 'repository') {
      return;
    }
    expect(result.repository.worktrees).toHaveLength(2);
    expect(
      result.repository.worktrees.find(({ displayPath }) =>
        displayPath.endsWith('-disappearing'),
      )?.availability,
    ).toMatchObject({ kind: 'unavailable', prunable: true });
  });

  it('marks a registered Worktree unavailable when its Git file is broken', async () => {
    const repository = await createRepositoryWithCommit();
    const linkedPath = join(
      dirname(repository.path),
      `${basename(repository.path)}-broken-git-file`,
    );
    externalPaths.push(linkedPath);
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature/broken-git-file',
      linkedPath,
    );
    const session = await createRepositoryEngine().open(
      asAbsolutePath(repository.path),
    );
    await writeFile(
      join(linkedPath, '.git'),
      'gitdir: /definitely/missing/codex-git-admin\n',
    );

    const result = await snapshotRepository(session);
    const broken = findWorktree(result, await realpath(linkedPath));

    expect(broken.availability).toEqual({
      kind: 'unavailable',
      reason:
        'The registered Working Tree cannot be resolved as its Git registration.',
      prunable: false,
    });
  });

  it('marks a registration unavailable when its Git file targets another Repository', async () => {
    const repository = await createRepositoryWithCommit();
    const unrelated = await createRepositoryWithCommit();
    const linkedPath = join(
      dirname(repository.path),
      `${basename(repository.path)}-redirected-git-file`,
    );
    externalPaths.push(linkedPath);
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature/redirected-git-file',
      linkedPath,
    );
    const session = await createRepositoryEngine().open(
      asAbsolutePath(repository.path),
    );
    await writeFile(
      join(linkedPath, '.git'),
      `gitdir: ${join(unrelated.path, '.git')}\n`,
    );

    const redirected = findWorktree(
      await snapshotRepository(session),
      await realpath(linkedPath),
    );

    expect(redirected.availability).toMatchObject({
      kind: 'unavailable',
      prunable: false,
    });
  });

  it('rejects same-Repository registrations that resolve to one admin directory', async () => {
    const repository = await createRepositoryWithCommit();
    const worktreeRoot = await mkdtemp(
      join(tmpdir(), 'codex-git-duplicate-admin-'),
    );
    externalPaths.push(worktreeRoot);
    const firstPath = join(worktreeRoot, 'first');
    const secondPath = join(worktreeRoot, 'second');
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature/first-admin',
      firstPath,
    );
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature/second-admin',
      secondPath,
    );
    await writeFile(
      join(firstPath, '.git'),
      await readFile(join(secondPath, '.git')),
    );

    const result = await openRepository(
      createRepositoryEngine(),
      repository.path,
    );
    const first = findWorktree(result, await realpath(firstPath));
    const second = findWorktree(result, await realpath(secondPath));

    expect(first.availability).toEqual({
      kind: 'unavailable',
      reason:
        'The registered Working Tree cannot be resolved as its Git registration.',
      prunable: false,
    });
    expect(second.availability.kind).toBe('available');
  });

  it('rejects a registration redirected to a prunable sibling admin directory', async () => {
    const repository = await createRepositoryWithCommit();
    const worktreeRoot = await mkdtemp(
      join(tmpdir(), 'codex-git-prunable-admin-'),
    );
    externalPaths.push(worktreeRoot);
    const firstPath = join(worktreeRoot, 'first');
    const secondPath = join(worktreeRoot, 'second');
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature/prunable-first',
      firstPath,
    );
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature/prunable-second',
      secondPath,
    );
    const secondControlFile = await readFile(join(secondPath, '.git'));
    await rm(secondPath, { recursive: true });
    await writeFile(join(firstPath, '.git'), secondControlFile);

    const result = await openRepository(
      createRepositoryEngine(),
      repository.path,
    );
    const first = findWorktree(result, await realpath(firstPath));
    const missingSecond = findWorktree(
      result,
      join(await realpath(worktreeRoot), 'second'),
    );

    expect(first.availability.kind).toBe('unavailable');
    expect(missingSecond.availability).toMatchObject({
      kind: 'unavailable',
      prunable: true,
    });
  });

  it('discovers every registered Worktree without path or Branch conventions', async () => {
    const repository = await createRepositoryWithCommit();
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'codex-git-worktrees-'));
    externalPaths.push(worktreeRoot);
    const registered = [
      ['manual', 'manual/topic'],
      ['codex-style', 'codex/task-123'],
      ['scheduled-style', 'scheduled/nightly'],
      ['permanent-style', 'permanent/docs'],
      ['custom-root', 'feature/custom-root'],
      ['-unknown\n工作树 with spaces', 'misc/unknown'],
    ] as const;

    for (const [directory, branch] of registered) {
      await repository.git(
        'worktree',
        'add',
        '--quiet',
        '-b',
        branch,
        join(worktreeRoot, directory),
      );
    }

    const detachedPath = join(worktreeRoot, 'detached');
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      '--detach',
      detachedPath,
      'HEAD',
    );
    const lockedPath = join(worktreeRoot, 'scheduled-style');
    await repository.git(
      'worktree',
      'lock',
      '--reason',
      'scheduled maintenance',
      lockedPath,
    );
    const missingPath = join(worktreeRoot, 'missing-prunable');
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      '-b',
      'missing/registration',
      missingPath,
    );
    await rm(missingPath, { recursive: true });

    const result = await openRepository(
      createRepositoryEngine(),
      repository.path,
    );

    const canonicalWorktreeRoot = await realpath(worktreeRoot);
    const canonicalDetachedPath = await realpath(detachedPath);
    const canonicalLockedPath = await realpath(lockedPath);
    const canonicalMissingPath = join(
      canonicalWorktreeRoot,
      'missing-prunable',
    );

    expect(result.worktrees).toHaveLength(9);
    expect(
      new Set(result.worktrees.map(({ canonicalPath }) => canonicalPath)).size,
    ).toBe(9);
    expect(result.worktrees.map(({ displayPath }) => displayPath)).toEqual(
      expect.arrayContaining([
        await realpath(repository.path),
        ...(await Promise.all(
          registered.map(([directory]) =>
            realpath(join(worktreeRoot, directory)),
          ),
        )),
        canonicalDetachedPath,
        canonicalMissingPath,
      ]),
    );
    expect(result.worktrees[0]?.displayPath).toBe(
      await realpath(repository.path),
    );
    expect(
      result.worktrees.every(
        ({ worktreeId, generation }) =>
          /^worktree_[0-9a-f]{32}$/u.test(worktreeId) &&
          /^generation_[0-9a-f]{32}$/u.test(generation),
      ),
    ).toBe(true);
    expect(
      result.worktrees.find(
        ({ canonicalPath }) => canonicalPath === canonicalDetachedPath,
      )?.head,
    ).toEqual({
      kind: 'detached',
      objectId: expect.stringMatching(/^[0-9a-f]{40}$/u),
    });
    expect(
      result.worktrees.find(
        ({ canonicalPath }) => canonicalPath === canonicalLockedPath,
      )?.gitLock,
    ).toEqual({ kind: 'locked', reason: 'scheduled maintenance' });
    expect(
      result.worktrees.find(
        ({ canonicalPath }) => canonicalPath === canonicalMissingPath,
      )?.availability,
    ).toEqual({
      kind: 'unavailable',
      reason: expect.stringContaining('non-existent'),
      prunable: true,
    });
  });

  it('keeps continuous identities and invalidates removed or moved generations', async () => {
    const repository = await createRepositoryWithCommit();
    const worktreeRoot = await mkdtemp(
      join(tmpdir(), 'codex-git-generations-'),
    );
    externalPaths.push(worktreeRoot);
    const linkedPath = join(worktreeRoot, 'reused');
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature/generation',
      linkedPath,
    );
    const engine = createRepositoryEngine();
    const session = await engine.open(asAbsolutePath(repository.path));

    const first = await snapshotRepository(session);
    const unchanged = await snapshotRepository(session);
    const firstLinked = findWorktree(first, await realpath(linkedPath));
    const unchangedLinked = findWorktree(unchanged, await realpath(linkedPath));

    expect(unchangedLinked.worktreeId).toBe(firstLinked.worktreeId);
    expect(unchangedLinked.generation).toBe(firstLinked.generation);

    await repository.git('worktree', 'remove', '--force', linkedPath);
    const withoutLinked = await snapshotRepository(session);
    expect(
      withoutLinked.worktrees.some(
        ({ worktreeId }) => worktreeId === firstLinked.worktreeId,
      ),
    ).toBe(false);

    await repository.git(
      'worktree',
      'add',
      '--quiet',
      linkedPath,
      'feature/generation',
    );
    const recreated = await snapshotRepository(session);
    const recreatedLinked = findWorktree(recreated, await realpath(linkedPath));
    expect(recreatedLinked.worktreeId).not.toBe(firstLinked.worktreeId);
    expect(recreatedLinked.generation).not.toBe(firstLinked.generation);

    const movedPath = join(worktreeRoot, 'moved');
    await repository.git('worktree', 'move', linkedPath, movedPath);
    const moved = await snapshotRepository(session);
    const movedLinked = findWorktree(moved, await realpath(movedPath));
    expect(movedLinked.worktreeId).not.toBe(recreatedLinked.worktreeId);
    expect(movedLinked.generation).not.toBe(recreatedLinked.generation);
  });

  it('invalidates identity when a retained empty root gets a new registration', async () => {
    const repository = await createRepositoryWithCommit();
    const worktreeRoot = await mkdtemp(
      join(tmpdir(), 'codex-git-registration-generation-'),
    );
    externalPaths.push(worktreeRoot);
    const linkedPath = join(worktreeRoot, 'retained-root');
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature/registration-generation',
      linkedPath,
    );
    const session = await createRepositoryEngine().open(
      asAbsolutePath(repository.path),
    );
    const original = findWorktree(
      await snapshotRepository(session),
      await realpath(linkedPath),
    );

    await rm(join(linkedPath, '.git'));
    await rm(join(linkedPath, 'README.md'));
    await repository.git('worktree', 'prune', '--expire', 'now');
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      linkedPath,
      'feature/registration-generation',
    );
    const recreated = findWorktree(
      await snapshotRepository(session),
      await realpath(linkedPath),
    );

    expect(recreated.worktreeId).not.toBe(original.worktreeId);
    expect(recreated.generation).not.toBe(original.generation);
  });

  it('does not revive an unavailable identity after prune and same-path recreation', async () => {
    const repository = await createRepositoryWithCommit();
    const worktreeRoot = await mkdtemp(
      join(tmpdir(), 'codex-git-unavailable-generation-'),
    );
    externalPaths.push(worktreeRoot);
    const linkedPath = join(worktreeRoot, 'reused');
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature/unavailable-generation',
      linkedPath,
    );
    const session = await createRepositoryEngine().open(
      asAbsolutePath(repository.path),
    );
    await rm(linkedPath, { recursive: true });
    const missing = findWorktree(
      await snapshotRepository(session),
      join(await realpath(worktreeRoot), 'reused'),
    );

    await repository.git('worktree', 'prune', '--expire', 'now');
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      linkedPath,
      'feature/unavailable-generation',
    );
    await rm(linkedPath, { recursive: true });
    const recreatedMissing = findWorktree(
      await snapshotRepository(session),
      join(await realpath(worktreeRoot), 'reused'),
    );

    expect(recreatedMissing.worktreeId).not.toBe(missing.worktreeId);
    expect(recreatedMissing.generation).not.toBe(missing.generation);
  });

  it('uses a fresh generation when an unavailable registration cannot prove continuity', async () => {
    const repository = await createRepositoryWithCommit();
    const worktreeRoot = await mkdtemp(
      join(tmpdir(), 'codex-git-unavailable-continuity-'),
    );
    externalPaths.push(worktreeRoot);
    const linkedPath = join(worktreeRoot, 'missing');
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature/unavailable-continuity',
      linkedPath,
    );
    const session = await createRepositoryEngine().open(
      asAbsolutePath(repository.path),
    );
    await rm(linkedPath, { recursive: true });
    const canonicalMissingPath = join(await realpath(worktreeRoot), 'missing');

    const first = findWorktree(
      await snapshotRepository(session),
      canonicalMissingPath,
    );
    const second = findWorktree(
      await snapshotRepository(session),
      canonicalMissingPath,
    );

    expect(second.availability.kind).toBe('unavailable');
    expect(second.worktreeId).not.toBe(first.worktreeId);
    expect(second.generation).not.toBe(first.generation);
  });
});

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

function asAbsolutePath(path: string): AbsolutePath {
  return path as AbsolutePath;
}

async function openRepository(
  engine: ReturnType<typeof createRepositoryEngine>,
  anchor: string,
): Promise<RepositorySnapshot> {
  const session = await engine.open(asAbsolutePath(anchor));
  return snapshotRepository(session);
}

async function snapshotRepository(
  session: RepositorySession,
): Promise<RepositorySnapshot> {
  const result = await session.snapshot();
  if (result.kind !== 'repository') {
    throw new Error('Expected the fixture to resolve to a Repository.');
  }
  return result.repository;
}

function findWorktree(repository: RepositorySnapshot, canonicalPath: string) {
  const worktree = repository.worktrees.find(
    (candidate) => candidate.canonicalPath === canonicalPath,
  );
  if (worktree === undefined) {
    throw new Error(`Expected Worktree ${JSON.stringify(canonicalPath)}.`);
  }
  return worktree;
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
