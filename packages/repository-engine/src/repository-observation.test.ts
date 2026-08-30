import { createOpaqueIdAuthority } from '@codex-git/protocol';
import { describe, expect, it } from 'vitest';

import type {
  DiscoveredWorktree,
  RepositoryDiscovery,
} from './repository-engine.js';
import {
  createRepositoryObserver,
  type GitReader,
} from './repository-observation.js';
import { createRemoteIdentityState } from './remote-observation.js';

const objectId = '1'.repeat(40);

describe('Repository observation Git recipes', () => {
  it('uses exact local-only argv and output policies for an unusual Worktree path', async () => {
    const calls: Array<{
      args: readonly string[];
      allowLargeOutput: boolean;
      acceptedEmptyExitCode?: 1;
    }> = [];
    const read: GitReader = async (
      args,
      allowLargeOutput,
      acceptedEmptyExitCode,
    ) => {
      calls.push({ args, allowLargeOutput, acceptedEmptyExitCode });
      if (args.includes('for-each-ref')) {
        return Buffer.from(`refs/heads/main\0${objectId}\0\n`);
      }
      if (args.at(-1) === 'remote') {
        return Buffer.from('origin\n');
      }
      if (args.includes('config')) {
        if (args.at(-1)?.startsWith('^url\\.') === true) {
          return Buffer.alloc(0);
        }
        return Buffer.from(
          [
            'remote.origin.url\nhttps://user:secret@example.test/repository.git',
            'remote.origin.pushurl\npush-alias:repository.git',
            '',
          ].join('\0'),
        );
      }
      if (args.includes('ls-remote')) {
        return Buffer.from(
          args.at(-1) === 'origin'
            ? 'https://user:secret@example.test/repository.git\n'
            : 'ssh://git@push.example/repository.git\n',
        );
      }
      if (args.includes('status')) {
        return Buffer.from(`# branch.oid ${objectId}\0# branch.head main\0`);
      }
      if (args.includes('--git-path')) {
        return Buffer.from('/fixture/missing-index\n');
      }
      return Buffer.alloc(0);
    };
    const path = '/fixture/- odd/雪\nline';
    const common = '/fixture/.git';
    const worktree = fixtureWorktree(path, 'selected');

    const observation = await observer(read).observe({
      repositoryId: 'repository_fixture' as RepositoryDiscovery['repositoryId'],
      commonGitDirectory: common as RepositoryDiscovery['commonGitDirectory'],
      selectedWorktreeId: worktree.worktreeId,
      worktrees: [worktree],
    });

    const sharedRecipes = [
      recipe(
        [
          '--git-dir',
          common,
          'for-each-ref',
          '--format=%(refname)%00%(objectname)%00%(symref)',
          'refs/heads',
          'refs/remotes',
        ],
        true,
      ),
      recipe(['-C', path, 'remote'], false),
      recipe(
        [
          '-C',
          path,
          'config',
          '--includes',
          '--null',
          '--get-regexp',
          '^remote\\..+\\.(url|pushurl|fetch|push|mirror|prune|prunetags|tagopt|skipdefaultupdate|skipfetchall)$',
        ],
        true,
        1,
      ),
      recipe(
        [
          '-C',
          path,
          'config',
          '--includes',
          '--null',
          '--get-regexp',
          '^url\\..+\\.(insteadof|pushinsteadof)$',
        ],
        true,
        1,
      ),
      recipe(['-C', path, 'ls-remote', '--get-url', '--', 'origin'], true),
    ];
    expect(calls).toEqual([
      ...sharedRecipes,
      recipe(['-C', path, 'ls-files', '--stage', '-z'], true),
      recipe(
        [
          '-C',
          path,
          'status',
          '--porcelain=v2',
          '-z',
          '--branch',
          '--no-renames',
          '--untracked-files=all',
        ],
        true,
      ),
      recipe(['-C', path, 'ls-files', '--stage', '-z'], true),
      recipe(
        [
          '-C',
          path,
          'rev-parse',
          '--path-format=absolute',
          '--git-path',
          'index',
        ],
        false,
      ),
      ...sharedRecipes,
    ]);
    expect(observation.shared.remotes[0]).toMatchObject({
      displayName: 'origin',
      host: 'example.test',
    });
    expect(
      calls.some(({ args }) =>
        args.some((argument) => ['fetch', 'pull', 'push'].includes(argument)),
      ),
    ).toBe(false);
    expect(
      calls
        .filter(({ args }) => args.includes('ls-remote'))
        .every(({ args }) => args.includes('--get-url')),
    ).toBe(true);
  });

  it('finishes the selected Worktree recipe before starting another Worktree', async () => {
    const selectedPath = '/fixture/selected';
    const otherPath = '/fixture/other';
    const selected = fixtureWorktree(selectedPath, 'selected');
    const other = fixtureWorktree(otherPath, 'other');
    const startedPaths: string[] = [];
    let releaseSelected!: () => void;
    const selectedGate = new Promise<void>((resolve) => {
      releaseSelected = resolve;
    });
    const read: GitReader = async (args) => {
      const context = args[0] === '-C' ? args[1] : undefined;
      if (context === selectedPath && args.includes('--git-path')) {
        await selectedGate;
      }
      if (
        context !== undefined &&
        (args.includes('ls-files') || args.includes('status')) &&
        !startedPaths.includes(context)
      ) {
        startedPaths.push(context);
      }
      if (args.includes('for-each-ref')) {
        return Buffer.from(`refs/heads/main\0${objectId}\0\n`);
      }
      if (args.includes('status')) {
        return Buffer.from(`# branch.oid ${objectId}\0# branch.head main\0`);
      }
      if (args.includes('--git-path')) {
        return Buffer.from('/fixture/missing-index\n');
      }
      return Buffer.alloc(0);
    };

    const observing = observer(read).observe({
      repositoryId: 'repository_fixture' as RepositoryDiscovery['repositoryId'],
      commonGitDirectory:
        '/fixture/.git' as RepositoryDiscovery['commonGitDirectory'],
      selectedWorktreeId: selected.worktreeId,
      worktrees: [other, selected],
    });
    await waitFor(() => startedPaths.length === 1);
    expect(startedPaths).toEqual([selectedPath]);
    releaseSelected();
    await observing;
    expect(startedPaths).toEqual([selectedPath, otherPath]);
  });
});

function observer(read: GitReader) {
  let issued = 0;
  const ids = createOpaqueIdAuthority({
    randomBytes: () => new Uint8Array(16).fill((issued += 1)),
  });
  return createRepositoryObserver(read, ids, createRemoteIdentityState());
}

function recipe(
  args: readonly string[],
  allowLargeOutput: boolean,
  acceptedEmptyExitCode?: 1,
) {
  return { args, allowLargeOutput, acceptedEmptyExitCode };
}

function fixtureWorktree(path: string, id: string): DiscoveredWorktree {
  return {
    worktreeId: `worktree_${id}` as DiscoveredWorktree['worktreeId'],
    generation: `generation_${id}` as DiscoveredWorktree['generation'],
    displayPath: path,
    canonicalPath: path as DiscoveredWorktree['canonicalPath'],
    canonicalPathBytes: Buffer.from(path),
    role: id === 'selected' ? 'main' : 'linked',
    head: {
      kind: 'local_branch',
      fullName: 'refs/heads/main',
      displayName: 'main',
      objectId,
    },
    gitLock: { kind: 'unlocked' },
    availability: { kind: 'available' },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for the test condition.');
}
