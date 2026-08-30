import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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

describe('effective push destination evidence', () => {
  it('observes every effective global, include, includeIf, and Worktree push rewrite', async () => {
    const repository = await createRepositoryWithCommit();
    const home = await temporaryHome();
    const included = join(home, 'included.config');
    const conditional = join(home, 'conditional.config');
    const gitDirectory = await realpath(join(repository.path, '.git'));
    await writeFile(included, includedConfig('v1'));
    await writeFile(conditional, conditionalConfig('v1'));
    await writeFile(
      join(home, '.gitconfig'),
      [
        '[remote "origin"]',
        '\turl = alias:team/one.git',
        '[url "ssh://global-push.example/"]',
        '\tpushInsteadOf = alias:',
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
      '--add',
      'remote.origin.url',
      'worktree:four.git',
    );
    await repository.git(
      'config',
      '--worktree',
      'url.ssh://worktree-v1.example/.pushInsteadOf',
      'worktree:',
    );

    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    try {
      const initial = await snapshotRepository(session);
      expect(initial.remotes).toHaveLength(1);
      expect(initial.remotes[0]).toMatchObject({
        displayName: 'origin',
        host: expect.any(String),
      });
      expect(JSON.stringify(initial)).not.toMatch(
        /source-secret|push\.example/u,
      );

      await writeFile(included, includedConfig('v2'));
      const includedChanged = await snapshotRepository(session);
      expect(includedChanged.refsRevision).toBe(initial.refsRevision + 1);
      expect(includedChanged.remotes).toEqual(initial.remotes);

      await writeFile(conditional, conditionalConfig('v2'));
      const conditionalChanged = await snapshotRepository(session);
      expect(conditionalChanged.refsRevision).toBe(
        includedChanged.refsRevision + 1,
      );

      await repository.git(
        'config',
        '--worktree',
        '--unset-all',
        'url.ssh://worktree-v1.example/.pushInsteadOf',
      );
      await repository.git(
        'config',
        '--worktree',
        'url.ssh://worktree-v2.example/.pushInsteadOf',
        'worktree:',
      );
      const worktreeChanged = await snapshotRepository(session);
      expect(worktreeChanged.refsRevision).toBe(
        conditionalChanged.refsRevision + 1,
      );

      await repository.git(
        'config',
        '--worktree',
        'url.ssh://unused.example/.pushInsteadOf',
        'unused:',
      );
      const irrelevantChanged = await snapshotRepository(session);
      expect(irrelevantChanged.refsRevision).toBe(worktreeChanged.refsRevision);
      expect(irrelevantChanged.repositoryRevision).toBe(
        worktreeChanged.repositoryRevision,
      );
    } finally {
      await session.close();
      restoreEnvironment('HOME', previousHome);
    }
  });

  it('uses insteadOf for every explicit pushurl and ignores pushInsteadOf', async () => {
    const repository = await createRepositoryWithCommit();
    const home = await temporaryHome();
    await repository.git(
      'remote',
      'add',
      'origin',
      'https://fetch.example/repository.git',
    );
    await repository.git(
      'config',
      '--add',
      'remote.origin.pushurl',
      'publish:one.git',
    );
    await repository.git(
      'config',
      '--add',
      'remote.origin.pushurl',
      'publish:two.git',
    );
    await writeFile(
      join(home, '.gitconfig'),
      explicitRewriteConfig('v1', 'v1'),
    );

    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    try {
      const initial = await snapshotRepository(session);
      await writeFile(
        join(home, '.gitconfig'),
        explicitRewriteConfig('v1', 'v2'),
      );
      const ignoredPushRewrite = await snapshotRepository(session);
      expect(ignoredPushRewrite.refsRevision).toBe(initial.refsRevision);
      expect(ignoredPushRewrite.repositoryRevision).toBe(
        initial.repositoryRevision,
      );

      await writeFile(
        join(home, '.gitconfig'),
        explicitRewriteConfig('v2', 'v2'),
      );
      const effectiveRewrite = await snapshotRepository(session);
      expect(effectiveRewrite.refsRevision).toBe(initial.refsRevision + 1);
      expect(effectiveRewrite.remotes).toEqual(initial.remotes);
    } finally {
      await session.close();
      restoreEnvironment('HOME', previousHome);
    }
  });
});

function includedConfig(version: string): string {
  return [
    '[remote "origin"]',
    '\turl = included:two.git',
    `[url "ssh://user:source-secret@included-${version}.example/"]`,
    '\tpushInsteadOf = included:',
    `[url "ssh://team-${version}.example/"]`,
    '\tpushInsteadOf = alias:team/',
    '',
  ].join('\n');
}

function conditionalConfig(version: string): string {
  return [
    '[remote "origin"]',
    '\turl = conditional:three.git',
    `[url "ssh://conditional-${version}.example/"]`,
    '\tinsteadOf = conditional:',
    '',
  ].join('\n');
}

function explicitRewriteConfig(
  insteadVersion: string,
  pushVersion: string,
): string {
  return [
    `[url "ssh://explicit-${insteadVersion}.example/"]`,
    '\tinsteadOf = publish:',
    `[url "ssh://ignored-${pushVersion}.example/"]`,
    '\tpushInsteadOf = publish:',
    '',
  ].join('\n');
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codex-git-push-evidence-'));
  externalPaths.push(home);
  return home;
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
