import { execFile } from 'node:child_process';

import type { AbsolutePath, OperationFailureCode } from '@codex-git/protocol';

import { createGitEnvironment } from './git-environment.js';

const GIT_OUTPUT_LIMIT_BYTES = 4 * 1_024 * 1_024;

export type RemoteOperationRequest =
  | {
      readonly kind: 'pull';
      readonly worktreePath: AbsolutePath;
      readonly remoteName: string;
      readonly remoteBranchRef: string;
    }
  | {
      readonly kind: 'push';
      readonly worktreePath: AbsolutePath;
      readonly remoteName: string;
      readonly localBranchRef: string;
      readonly destinationRef: string;
    }
  | {
      readonly kind: 'refresh_tracking';
      readonly worktreePath: AbsolutePath;
      readonly remoteName: string;
      readonly remoteBranchRef: string;
      readonly trackingRef: string;
    };

export type RemoteOperationResult =
  | { readonly kind: 'completed' }
  | {
      readonly kind: 'failed_known';
      readonly code: OperationFailureCode;
      readonly message: string;
    }
  | {
      readonly kind: 'unknown';
      readonly message: string;
    };

export interface RemoteOperationRecipe {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly maximumOutputBytes: number;
}

export type RemoteOperationExecution =
  | {
      readonly kind: 'exited';
      readonly exitCode: number;
      readonly stderr: string;
    }
  | {
      readonly kind: 'ambiguous';
      readonly reason: 'output_limit' | 'process_error';
    };

export type RemoteOperationProcessExecutor = (
  recipe: RemoteOperationRecipe,
  signal: AbortSignal,
) => Promise<RemoteOperationExecution>;

export function createRemoteOperationExecutor(
  execute: RemoteOperationProcessExecutor = executeSystemGit,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
) {
  const environment = createGitEnvironment(sourceEnvironment);
  return async (
    request: RemoteOperationRequest,
    signal: AbortSignal,
  ): Promise<RemoteOperationResult> => {
    const args =
      request.kind === 'pull'
        ? [
            '-C',
            request.worktreePath,
            'pull',
            '--ff-only',
            '--no-rebase',
            '--no-tags',
            '--',
            request.remoteName,
            request.remoteBranchRef,
          ]
        : request.kind === 'push'
          ? [
              '-C',
              request.worktreePath,
              'push',
              '--porcelain',
              '--',
              request.remoteName,
              `${request.localBranchRef}:${request.destinationRef}`,
            ]
          : [
              '-C',
              request.worktreePath,
              'fetch',
              '--no-tags',
              '--no-prune',
              '--',
              request.remoteName,
              `${request.remoteBranchRef}:${request.trackingRef}`,
            ];
    const execution = await execute(
      { args, environment, maximumOutputBytes: GIT_OUTPUT_LIMIT_BYTES },
      signal,
    );
    if (execution.kind === 'ambiguous') {
      return {
        kind: 'unknown',
        message: 'Git did not report an unambiguous Remote Operation outcome.',
      };
    }
    return execution.exitCode === 0
      ? { kind: 'completed' }
      : classifyRemoteOperationFailure(execution.stderr);
  };
}

const executeSystemGit: RemoteOperationProcessExecutor = (recipe, signal) =>
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
        if (typeof error.code === 'number') {
          resolvePromise({ kind: 'exited', exitCode: error.code, stderr });
          return;
        }
        resolvePromise({
          kind: 'ambiguous',
          reason:
            error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? 'output_limit'
              : 'process_error',
        });
      },
    );
  });

function classifyRemoteOperationFailure(stderr: string): RemoteOperationResult {
  const diagnostic = stderr.toLowerCase();
  if (
    /authentication failed|could not read username|publickey|terminal prompts disabled/u.test(
      diagnostic,
    )
  ) {
    return failure('authentication', 'Authentication with the Remote failed.');
  }
  if (
    /protected branch|pre-receive hook declined|repository rule/u.test(
      diagnostic,
    )
  ) {
    return failure(
      'policy',
      'The policy for the Branch in the Remote rejected the update.',
    );
  }
  if (/permission denied|not permitted|access denied/u.test(diagnostic)) {
    return failure('permission', 'The Remote denied permission.');
  }
  if (
    /non-fast-forward|fetch first|failed to push some refs|not possible to fast-forward/u.test(
      diagnostic,
    )
  ) {
    return failure(
      'non_fast_forward',
      'The Remote rejected a non-fast-forward update.',
    );
  }
  if (
    /could not resolve host|connection refused|network is unreachable|failed to connect|unable to access/u.test(
      diagnostic,
    )
  ) {
    return failure('offline', 'The Remote could not be reached.');
  }
  if (
    /does not appear to be a git repository|no such remote/u.test(diagnostic)
  ) {
    return failure('invalid_remote', 'The configured Remote is invalid.');
  }
  return {
    kind: 'unknown',
    message: 'Git did not report an unambiguous Remote Operation outcome.',
  };
}

function failure(
  code: OperationFailureCode,
  message: string,
): RemoteOperationResult {
  return { kind: 'failed_known', code, message };
}
