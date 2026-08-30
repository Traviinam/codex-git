import { execFile } from 'node:child_process';

import type { AbsolutePath } from '@codex-git/protocol';

import { createGitEnvironment } from './git-environment.js';
import type { RemoteFetchResult } from './repository-session.js';

const GIT_OUTPUT_LIMIT_BYTES = 4 * 1_024 * 1_024;

export interface RemoteFetchRecipe {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly maximumOutputBytes: number;
}

export interface RemoteFetchExecution {
  readonly kind: 'exited';
  readonly exitCode: number;
  readonly stderr: string;
}

export type RemoteFetchExecutor = (
  recipe: RemoteFetchRecipe,
  signal: AbortSignal,
) => Promise<RemoteFetchExecution>;

export interface RemoteFetcherOptions {
  readonly execute?: RemoteFetchExecutor;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
}

export function createRemoteFetcher(options: RemoteFetcherOptions = {}) {
  const execute = options.execute ?? executeSystemGit;
  const environment = createGitEnvironment(options.sourceEnvironment);

  return async (
    worktreePath: AbsolutePath,
    remoteName: string,
    signal: AbortSignal,
  ): Promise<RemoteFetchResult> => {
    const execution = await execute(
      {
        args: ['-C', worktreePath, 'fetch', '--no-prune', '--', remoteName],
        environment,
        maximumOutputBytes: GIT_OUTPUT_LIMIT_BYTES,
      },
      signal,
    );
    return execution.exitCode === 0
      ? { kind: 'completed' }
      : classifyRemoteFetchFailure(execution.stderr);
  };
}

const executeSystemGit: RemoteFetchExecutor = (recipe, signal) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      [...recipe.args],
      {
        encoding: 'utf8',
        env: recipe.environment,
        maxBuffer: recipe.maximumOutputBytes,
        signal,
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolvePromise({ kind: 'exited', exitCode: 0, stderr });
          return;
        }
        if (signal.aborted) {
          reject(error);
          return;
        }
        resolvePromise({
          kind: 'exited',
          exitCode: typeof error.code === 'number' ? error.code : 1,
          stderr,
        });
      },
    );
  });

function classifyRemoteFetchFailure(stderr: string): RemoteFetchResult {
  const diagnostic = stderr.toLowerCase();
  if (
    /authentication failed|could not read username|publickey|terminal prompts disabled/u.test(
      diagnostic,
    )
  ) {
    return {
      kind: 'failed_known',
      code: 'authentication',
      message: 'Authentication with the Remote failed.',
    };
  }
  if (/permission denied|not permitted|access denied/u.test(diagnostic)) {
    return {
      kind: 'failed_known',
      code: 'permission',
      message: 'The Remote denied permission.',
    };
  }
  if (
    /could not resolve host|connection refused|network is unreachable|failed to connect|unable to access/u.test(
      diagnostic,
    )
  ) {
    return {
      kind: 'failed_known',
      code: 'offline',
      message: 'The Remote could not be reached.',
    };
  }
  if (
    /does not appear to be a git repository|no such remote/u.test(diagnostic)
  ) {
    return {
      kind: 'failed_known',
      code: 'invalid_remote',
      message: 'The configured Remote is invalid.',
    };
  }
  return {
    kind: 'failed_known',
    code: 'process_failed',
    message: 'Git could not Fetch the Remote.',
  };
}
