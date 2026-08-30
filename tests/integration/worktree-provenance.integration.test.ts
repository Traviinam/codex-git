import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRepositoryEngine,
  type CodexMetadataAdapter,
  type RepositorySession,
} from '@codex-git/repository-engine';
import type { AbsolutePath } from '@codex-git/protocol';

import {
  createTemporaryGitRepository,
  type TemporaryGitRepository,
} from '../fixtures/temporary-git-repository.js';

const repositories: TemporaryGitRepository[] = [];

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((repository) => repository.dispose()),
  );
});

describe('optional Codex Worktree provenance', () => {
  it('joins stable Codex metadata only to its exact canonical cwd', async () => {
    const repository = await createRepository();
    const canonicalCwd = await realpath(repository.path);
    const metadata: CodexMetadataAdapter = {
      async read() {
        return [
          {
            canonicalCwd,
            kind: 'codex_task',
            stable: true,
            task: {
              id: 'task-15',
              status: 'active',
              title: 'Add exact-target navigation',
            },
          },
          {
            canonicalCwd: `${canonicalCwd}-same-name`,
            kind: 'external',
            stable: true,
          },
        ];
      },
    };
    const session = await createRepositoryEngine({ metadata }).open(
      repository.path as AbsolutePath,
    );

    const worktree = await onlyWorktree(session);

    expect(worktree.provenance).toEqual({
      kind: 'codex_task',
      task: {
        id: 'task-15',
        status: 'active',
        title: 'Add exact-target navigation',
      },
    });
  });

  it('keeps every Git Worktree Unclassified when metadata is unavailable', async () => {
    const repository = await createRepository();
    const session = await createRepositoryEngine({
      metadata: {
        async read() {
          throw new Error('Codex metadata is unavailable.');
        },
      },
    }).open(repository.path as AbsolutePath);

    const result = await session.snapshot();

    expect(result.kind).toBe('repository');
    if (result.kind !== 'repository') return;
    expect(result.repository.worktrees).toHaveLength(1);
    expect(result.repository.worktrees[0]?.provenance).toEqual({
      kind: 'unclassified',
    });
  });

  it('does not invalidate Git file targets when optional metadata disappears', async () => {
    const repository = await createRepository();
    await writeFile(join(repository.path, 'README.md'), 'changed\n');
    const canonicalCwd = await realpath(repository.path);
    let metadata = [
      {
        canonicalCwd,
        kind: 'codex_task' as const,
        stable: true,
        task: {
          id: 'task-optional',
          status: 'active',
          title: 'Optional metadata',
        },
      },
    ];
    const session = await createRepositoryEngine({
      metadata: {
        async read() {
          return metadata;
        },
      },
    }).open(repository.path as AbsolutePath);
    const initial = await onlyWorktree(session);
    metadata = [];

    const withoutMetadata = await onlyWorktree(session);

    expect(withoutMetadata.provenance).toEqual({ kind: 'unclassified' });
    expect(withoutMetadata.worktreeRevision).toBe(initial.worktreeRevision + 1);
    expect(withoutMetadata.changes[0]?.fileId).toBe(initial.changes[0]?.fileId);
    expect(withoutMetadata.changes[0]?.nativeTargetId).toBe(
      initial.changes[0]?.nativeTargetId,
    );
  });
});

async function createRepository(): Promise<TemporaryGitRepository> {
  const repository = await createTemporaryGitRepository();
  repositories.push(repository);
  await repository.git('config', 'user.name', 'Codex Git Tests');
  await repository.git('config', 'user.email', 'codex-git@example.test');
  await writeFile(join(repository.path, 'README.md'), 'fixture\n');
  await repository.git('add', '--', 'README.md');
  await repository.git('commit', '--quiet', '-m', 'Create fixture');
  return repository;
}

async function onlyWorktree(session: RepositorySession) {
  const result = await session.snapshot();
  if (
    result.kind !== 'repository' ||
    result.repository.worktrees[0] === undefined
  ) {
    throw new Error('Expected one Repository Worktree.');
  }
  return result.repository.worktrees[0];
}
