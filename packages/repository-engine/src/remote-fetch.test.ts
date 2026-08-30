import { describe, expect, it, vi } from 'vitest';

import type { AbsolutePath } from '@codex-git/protocol';

import { createRemoteFetcher, type RemoteFetchRecipe } from './remote-fetch.js';

describe('Remote Fetch recipe', () => {
  it('uses an exact non-pruning argv and sanitized Git environment', async () => {
    const execute = vi.fn(async () => ({
      kind: 'exited' as const,
      exitCode: 0,
      stderr: '',
    }));
    const fetchRemote = createRemoteFetcher({
      execute,
      sourceEnvironment: {
        PATH: '/fixture/bin',
        HOME: '/fixture/home',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: 'exfiltrate',
      },
    });
    const signal = new AbortController().signal;

    await expect(
      fetchRemote('/worktrees/selected' as AbsolutePath, '-origin', signal),
    ).resolves.toEqual({ kind: 'completed' });
    expect(execute).toHaveBeenCalledWith(
      {
        args: [
          '-C',
          '/worktrees/selected',
          'fetch',
          '--no-prune',
          '--',
          '-origin',
        ],
        environment: {
          PATH: '/fixture/bin',
          HOME: '/fixture/home',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
        },
        maximumOutputBytes: 4 * 1_024 * 1_024,
      },
      signal,
    );
  });

  it.each([
    ['/worktrees/with space', 'team remote'],
    ['/worktrees/仓库', '源'],
    ['/worktrees/line\nbreak', 'origin'],
  ] as const)(
    'passes unusual path and Remote text literally (%s, %s)',
    async (worktreePath, remoteName) => {
      const recipes: RemoteFetchRecipe[] = [];
      const execute = vi.fn(async (recipe: RemoteFetchRecipe) => {
        recipes.push(recipe);
        return { kind: 'exited' as const, exitCode: 0, stderr: '' };
      });
      const fetchRemote = createRemoteFetcher({ execute });

      await fetchRemote(
        worktreePath as AbsolutePath,
        remoteName,
        new AbortController().signal,
      );

      expect(recipes[0]?.args).toEqual([
        '-C',
        worktreePath,
        'fetch',
        '--no-prune',
        '--',
        remoteName,
      ]);
    },
  );

  it.each([
    [
      "fatal: Authentication failed for 'https://user:secret@example.test/repository.git'",
      'authentication',
      'Authentication with the Remote failed.',
    ],
    [
      'fatal: Permission denied while accessing the repository',
      'permission',
      'The Remote denied permission.',
    ],
    [
      'fatal: unable to access repository: Could not resolve host',
      'offline',
      'The Remote could not be reached.',
    ],
    [
      "fatal: '/missing/repository.git' does not appear to be a git repository",
      'invalid_remote',
      'The configured Remote is invalid.',
    ],
    [
      'fatal: credential_token=super-secret unexpected transport failure',
      'process_failed',
      'Git could not Fetch the Remote.',
    ],
  ] as const)(
    'classifies and redacts a known process failure (%s)',
    async (stderr, code, message) => {
      const fetchRemote = createRemoteFetcher({
        execute: async () => ({ kind: 'exited', exitCode: 128, stderr }),
      });

      const result = await fetchRemote(
        '/worktrees/selected' as AbsolutePath,
        'origin',
        new AbortController().signal,
      );

      expect(result).toEqual({ kind: 'failed_known', code, message });
      expect(JSON.stringify(result)).not.toMatch(
        /super-secret|user:secret|credential_token/u,
      );
    },
  );
});
