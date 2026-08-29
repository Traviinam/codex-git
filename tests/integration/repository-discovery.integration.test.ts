import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { AbsolutePath } from '@codex-git/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createRepositoryEngine } from '@codex-git/repository-engine';

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

    const result = await createRepositoryEngine().open(
      asAbsolutePath(directory),
    );

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
    const mainResult = await engine.open(asAbsolutePath(repository.path));
    const linkedResult = await engine.open(asAbsolutePath(linkedSubdirectory));

    expect(mainResult.kind).toBe('repository');
    expect(linkedResult.kind).toBe('repository');
    if (
      mainResult.kind !== 'repository' ||
      linkedResult.kind !== 'repository'
    ) {
      return;
    }

    expect(linkedResult.repository.repositoryId).toBe(
      mainResult.repository.repositoryId,
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

    const result = await createRepositoryEngine().open(
      asAbsolutePath(repository.path),
    );

    expect(result.kind).toBe('repository');
    if (result.kind !== 'repository') {
      return;
    }
    const canonicalWorktreeRoot = await realpath(worktreeRoot);
    const canonicalDetachedPath = await realpath(detachedPath);
    const canonicalLockedPath = await realpath(lockedPath);
    const canonicalMissingPath = join(
      canonicalWorktreeRoot,
      'missing-prunable',
    );

    expect(result.repository.worktrees).toHaveLength(9);
    expect(
      new Set(
        result.repository.worktrees.map(({ canonicalPath }) => canonicalPath),
      ).size,
    ).toBe(9);
    expect(
      result.repository.worktrees.map(({ displayPath }) => displayPath),
    ).toEqual(
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
    expect(result.repository.worktrees[0]?.displayPath).toBe(
      await realpath(repository.path),
    );
    expect(
      result.repository.worktrees.every(
        ({ worktreeId, generation }) =>
          /^worktree_[0-9a-f]{32}$/u.test(worktreeId) &&
          /^generation_[0-9a-f]{32}$/u.test(generation),
      ),
    ).toBe(true);
    expect(
      result.repository.worktrees.find(
        ({ canonicalPath }) => canonicalPath === canonicalDetachedPath,
      )?.head,
    ).toEqual({
      kind: 'detached',
      objectId: expect.stringMatching(/^[0-9a-f]{40}$/u),
    });
    expect(
      result.repository.worktrees.find(
        ({ canonicalPath }) => canonicalPath === canonicalLockedPath,
      )?.gitLock,
    ).toEqual({ kind: 'locked', reason: 'scheduled maintenance' });
    expect(
      result.repository.worktrees.find(
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

    const first = await openRepository(engine, repository.path);
    const unchanged = await openRepository(engine, repository.path);
    const firstLinked = findWorktree(first, await realpath(linkedPath));
    const unchangedLinked = findWorktree(unchanged, await realpath(linkedPath));

    expect(unchangedLinked.worktreeId).toBe(firstLinked.worktreeId);
    expect(unchangedLinked.generation).toBe(firstLinked.generation);

    await repository.git('worktree', 'remove', '--force', linkedPath);
    const withoutLinked = await openRepository(engine, repository.path);
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
    const recreated = await openRepository(engine, repository.path);
    const recreatedLinked = findWorktree(recreated, await realpath(linkedPath));
    expect(recreatedLinked.worktreeId).not.toBe(firstLinked.worktreeId);
    expect(recreatedLinked.generation).not.toBe(firstLinked.generation);

    const movedPath = join(worktreeRoot, 'moved');
    await repository.git('worktree', 'move', linkedPath, movedPath);
    const moved = await openRepository(engine, repository.path);
    const movedLinked = findWorktree(moved, await realpath(movedPath));
    expect(movedLinked.worktreeId).not.toBe(recreatedLinked.worktreeId);
    expect(movedLinked.generation).not.toBe(recreatedLinked.generation);
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

type RepositoryDiscovery = Extract<
  Awaited<ReturnType<ReturnType<typeof createRepositoryEngine>['open']>>,
  { kind: 'repository' }
>['repository'];

async function openRepository(
  engine: ReturnType<typeof createRepositoryEngine>,
  anchor: string,
): Promise<RepositoryDiscovery> {
  const result = await engine.open(asAbsolutePath(anchor));
  if (result.kind !== 'repository') {
    throw new Error('Expected the fixture to resolve to a Repository.');
  }
  return result.repository;
}

function findWorktree(repository: RepositoryDiscovery, canonicalPath: string) {
  const worktree = repository.worktrees.find(
    (candidate) => candidate.canonicalPath === canonicalPath,
  );
  if (worktree === undefined) {
    throw new Error(`Expected Worktree ${JSON.stringify(canonicalPath)}.`);
  }
  return worktree;
}
