import { describe, expect, it, vi } from 'vitest';

import type { AbsolutePath } from '@codex-git/protocol';

import { createRemoteOperationExecutor } from './remote-operation.js';

describe('Remote Operation recipes', () => {
  it('Pull uses only explicit fast-forward integration from the exact Branch in the Remote', async () => {
    const execute = vi.fn(async () => ({
      kind: 'exited' as const,
      exitCode: 0,
      stderr: '',
    }));
    const executeRemoteOperation = createRemoteOperationExecutor(execute, {
      PATH: '/fixture/bin',
      HOME: '/fixture/home',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: 'exfiltrate',
    });
    const signal = new AbortController().signal;

    await executeRemoteOperation(
      {
        kind: 'pull',
        worktreePath: '/worktrees/selected' as AbsolutePath,
        remoteName: '-origin',
        remoteBranchRef: 'refs/heads/team/feature',
      },
      signal,
    );

    expect(execute).toHaveBeenCalledWith(
      {
        args: [
          '-C',
          '/worktrees/selected',
          'pull',
          '--ff-only',
          '--no-rebase',
          '--no-tags',
          '--',
          '-origin',
          'refs/heads/team/feature',
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

  it('Push uses one exact full-ref refspec without force, tags, deletion, or matching refs', async () => {
    let args: readonly string[] | undefined;
    const execute = vi.fn(
      async (recipe: { readonly args: readonly string[] }) => {
        args = recipe.args;
        return { kind: 'exited' as const, exitCode: 0, stderr: '' };
      },
    );
    const executeRemoteOperation = createRemoteOperationExecutor(execute);
    const signal = new AbortController().signal;

    await executeRemoteOperation(
      {
        kind: 'push',
        worktreePath: '/worktrees/selected' as AbsolutePath,
        remoteName: 'origin',
        localBranchRef: 'refs/heads/local',
        destinationRef: 'refs/heads/exact-target',
      },
      signal,
    );

    expect(args).toEqual([
      '-C',
      '/worktrees/selected',
      'push',
      '--porcelain',
      '--',
      'origin',
      'refs/heads/local:refs/heads/exact-target',
    ]);
    expect(args?.join(' ')).not.toMatch(/force|tags|delete/u);
  });

  it('refreshes only the exact configured Remote-tracking mapping for reconciliation', async () => {
    let args: readonly string[] | undefined;
    const executeRemoteOperation = createRemoteOperationExecutor(
      async (recipe) => {
        args = recipe.args;
        return { kind: 'exited', exitCode: 0, stderr: '' };
      },
    );

    await executeRemoteOperation(
      {
        kind: 'refresh_tracking',
        worktreePath: '/worktrees/selected' as AbsolutePath,
        remoteName: 'origin',
        remoteBranchRef: 'refs/heads/source',
        trackingRef: 'refs/remotes/origin/alias',
      },
      new AbortController().signal,
    );

    expect(args).toEqual([
      '-C',
      '/worktrees/selected',
      'fetch',
      '--no-tags',
      '--no-prune',
      '--',
      'origin',
      'refs/heads/source:refs/remotes/origin/alias',
    ]);
    expect(args?.join(' ')).not.toContain('+');
  });

  it.each(['output_limit', 'process_error'] as const)(
    'keeps an ambiguous executor %s outcome unknown',
    async (reason) => {
      const executeRemoteOperation = createRemoteOperationExecutor(
        async () => ({
          kind: 'ambiguous',
          reason,
        }),
      );

      const result = await executeRemoteOperation(
        {
          kind: 'push',
          worktreePath: '/worktrees/selected' as AbsolutePath,
          remoteName: 'origin',
          localBranchRef: 'refs/heads/main',
          destinationRef: 'refs/heads/main',
        },
        new AbortController().signal,
      );

      expect(result).toEqual({
        kind: 'unknown',
        message: 'Git did not report an unambiguous Remote Operation outcome.',
      });
    },
  );

  it.each([
    ['fatal: Authentication failed for user:secret', 'authentication'],
    ['remote: error: GH006: Protected branch update failed', 'policy'],
    ['fatal: Permission denied (publickey)', 'authentication'],
    ['remote: permission denied by repository owner', 'permission'],
    ['! [rejected] main -> main (non-fast-forward)', 'non_fast_forward'],
    ['fatal: unable to access URL: Could not resolve host', 'offline'],
  ] as const)(
    'classifies and sanitizes Remote failure %s',
    async (stderr, code) => {
      const executeRemoteOperation = createRemoteOperationExecutor(
        async () => ({
          kind: 'exited',
          exitCode: 1,
          stderr,
        }),
      );

      const result = await executeRemoteOperation(
        {
          kind: 'push',
          worktreePath: '/worktrees/selected' as AbsolutePath,
          remoteName: 'origin',
          localBranchRef: 'refs/heads/main',
          destinationRef: 'refs/heads/main',
        },
        new AbortController().signal,
      );

      expect(result).toMatchObject({ kind: 'failed_known', code });
      expect(JSON.stringify(result)).not.toMatch(/secret|private|user:/u);
    },
  );

  it('keeps an unclassified transport failure unknown and sanitized', async () => {
    const executeRemoteOperation = createRemoteOperationExecutor(async () => ({
      kind: 'exited',
      exitCode: 1,
      stderr: 'fatal: secret_token=private unexpected transport failure',
    }));

    const result = await executeRemoteOperation(
      {
        kind: 'push',
        worktreePath: '/worktrees/selected' as AbsolutePath,
        remoteName: 'origin',
        localBranchRef: 'refs/heads/main',
        destinationRef: 'refs/heads/main',
      },
      new AbortController().signal,
    );

    expect(result).toEqual({
      kind: 'unknown',
      message: 'Git did not report an unambiguous Remote Operation outcome.',
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private/u);
  });
});
