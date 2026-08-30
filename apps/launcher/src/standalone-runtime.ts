import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import type { Server } from 'node:http';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { HostConnection } from '@codex-git/host-adapter';
import {
  createRepositoryEngine,
  type RepositorySession,
} from '@codex-git/repository-engine';
import type {
  AbsolutePath,
  NativeActionRequest,
  NativeActionResult,
  RepositoryId,
} from '@codex-git/protocol';
import { startLoopbackServer, type LoopbackServer } from '@codex-git/server';
import { StandaloneHostAdapter } from '@codex-git/host-adapter-standalone';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

import { protocolBootstrapPlugin } from './protocol-bootstrap.js';
import { toProtocolRepositorySnapshot } from './repository-protocol-adapter.js';

const loopbackHost = '127.0.0.1';
const execFileAsync = promisify(execFile);
const uiConfigPath = fileURLToPath(
  new URL('../../ui/vite.config.ts', import.meta.url),
);

export interface StandaloneRuntimeOptions {
  readonly projectPath?: string;
  readonly surfacePort?: number;
}

export interface StandaloneRuntime {
  readonly healthUrl: URL;
  readonly sessionUrl: URL;
  readonly surfaceUrl: URL;
  close(): Promise<void>;
}

export async function startStandaloneRuntime(
  options: StandaloneRuntimeOptions = {},
): Promise<StandaloneRuntime> {
  let protocolServer: LoopbackServer | undefined;
  let surfaceServer: ViteDevServer | undefined;
  let hostConnection: HostConnection | null = null;
  let repositorySession: RepositorySession | undefined;
  let openedRepositoryId: RepositoryId | undefined;
  let invalidationPump = Promise.resolve();

  async function closeResources(): Promise<void> {
    await Promise.all([
      hostConnection?.close(),
      repositorySession?.close(),
      surfaceServer?.close(),
      protocolServer?.close(),
    ]);
    await invalidationPump;
  }

  try {
    if (options.projectPath !== undefined) {
      repositorySession = await createRepositoryEngine().open(
        options.projectPath as AbsolutePath,
      );
      const opened = await repositorySession.requestRefresh();
      if (opened.kind === 'repository') {
        openedRepositoryId = opened.repository.repositoryId;
      }
    }
    protocolServer = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers:
        repositorySession === undefined || options.projectPath === undefined
          ? undefined
          : {
              diff: ({ fileId }) => repositorySession!.diff(fileId),
              nativeActions: (request) =>
                performFileNativeAction(repositorySession!, request),
              branchSearch: (request) =>
                repositorySession!.searchBranches(request),
              commands: (request) => repositorySession!.dispatch(request),
              operationRecovery: (operationId) =>
                repositorySession!.recoverOperation(operationId),
              snapshot: async () =>
                toProtocolRepositorySnapshot(
                  await repositorySession!.requestRefresh(),
                  options.projectPath!,
                ),
            },
    });
    if (repositorySession !== undefined && openedRepositoryId !== undefined) {
      invalidationPump = forwardRepositoryInvalidations(
        repositorySession,
        protocolServer,
        openedRepositoryId,
      );
    }
    surfaceServer = await createViteServer({
      configFile: uiConfigPath,
      plugins: [
        protocolBootstrapPlugin(protocolServer.sessionUrl, options.projectPath),
      ],
      server: {
        host: loopbackHost,
        port: options.surfacePort ?? 5173,
        strictPort: true,
      },
    });
    await surfaceServer.listen();

    const surfaceUrl = serverUrl(surfaceServer.httpServer, '/');
    protocolServer.allowOrigin(surfaceUrl.origin);
    const hostResult = await new StandaloneHostAdapter().attach({
      title: 'Codex Git',
      url: surfaceUrl,
    });
    hostConnection = hostResult.connection;

    let closed = false;

    return {
      healthUrl: protocolServer.healthUrl,
      sessionUrl: protocolServer.sessionUrl,
      surfaceUrl,
      async close() {
        if (closed) {
          return;
        }

        closed = true;
        await closeResources();
      },
    };
  } catch (error) {
    await closeResources();
    throw error;
  }
}

async function performFileNativeAction(
  session: RepositorySession,
  request: NativeActionRequest,
): Promise<NativeActionResult> {
  try {
    const target = await session.resolveFileNativeTarget(request.targetId);
    if (request.kind === 'copy_relative_path') {
      return { kind: 'copy_text', text: target.relativePath };
    }
    if (request.kind !== 'open_default_app') {
      return {
        kind: 'unavailable',
        message: 'This file action is not available yet.',
      };
    }
    if (!target.canOpen || target.absolutePath === null) {
      throw new Error('The file cannot be opened from this change state.');
    }
    const metadata = await lstat(target.absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error('Symbolic links cannot be opened from change review.');
    }
    const [resolvedWorktree, resolvedFile] = await Promise.all([
      realpath(target.worktreePath),
      realpath(target.absolutePath),
    ]);
    const relativeResolvedPath = relative(resolvedWorktree, resolvedFile);
    if (
      relativeResolvedPath === '' ||
      relativeResolvedPath === '..' ||
      relativeResolvedPath.startsWith(
        `..${process.platform === 'win32' ? '\\' : '/'}`,
      ) ||
      isAbsolute(relativeResolvedPath)
    ) {
      throw new Error('The file resolves outside its Worktree.');
    }
    await execFileAsync('/usr/bin/open', ['--', resolvedFile], {
      timeout: 10_000,
      windowsHide: true,
    });
    return { kind: 'performed' };
  } catch {
    return {
      kind: 'unavailable',
      message: 'The file is no longer available. Refresh and try again.',
    };
  }
}

async function forwardRepositoryInvalidations(
  session: RepositorySession,
  server: Pick<LoopbackServer, 'publish'>,
  repositoryId: RepositoryId,
): Promise<void> {
  for await (const invalidation of session.subscribe()) {
    server.publish(
      invalidation.kind === 'operation'
        ? {
            kind: 'operation_progress',
            operationId: invalidation.operation.operationId,
            phase: invalidation.operation.phase,
            progress: invalidation.operation.progress,
          }
        : {
            kind: 'repository_revision',
            repositoryId,
            repositoryRevision: invalidation.repositoryRevision,
          },
    );
  }
}

function serverUrl(
  server: Pick<Server, 'address'> | null,
  pathname: string,
): URL {
  const address = server?.address();

  if (
    address === undefined ||
    address === null ||
    typeof address === 'string'
  ) {
    throw new Error('Standalone runtime server has no TCP address');
  }

  return new URL(pathname, `http://${loopbackHost}:${address.port}`);
}
