import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { HostConnection } from '@codex-git/host-adapter';
import {
  createRepositoryEngine,
  type RepositorySession,
} from '@codex-git/repository-engine';
import type {
  AbsolutePath,
  CommandEnvelope,
  OperationReceipt,
  RepositoryId,
} from '@codex-git/protocol';
import { startLoopbackServer, type LoopbackServer } from '@codex-git/server';
import { StandaloneHostAdapter } from '@codex-git/host-adapter-standalone';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

import { protocolBootstrapPlugin } from './protocol-bootstrap.js';
import { toProtocolRepositorySnapshot } from './repository-protocol-adapter.js';

const loopbackHost = '127.0.0.1';
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
              snapshot: async () =>
                toProtocolRepositorySnapshot(
                  await repositorySession!.requestRefresh(),
                  options.projectPath!,
                ),
              commands: (request) =>
                dispatchRepositoryCommand(repositorySession!, request),
              operationRecovery: (operationId) =>
                repositorySession!.recoverOperation(operationId),
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

async function dispatchRepositoryCommand(
  session: RepositorySession,
  request: CommandEnvelope,
): Promise<OperationReceipt> {
  if (
    request.command.kind !== 'fetch_remote' &&
    request.command.kind !== 'fetch_all'
  ) {
    throw new Error('The Product Command is not implemented.');
  }
  const admission = await session.fetch({
    repositoryId: request.command.repositoryId,
    remoteId:
      request.command.kind === 'fetch_remote' ? request.command.remoteId : null,
    expectedRefsRevision: request.command.expectedRefsRevision,
  });
  if (admission.kind === 'closed') {
    throw new Error('The Repository Session is closed.');
  }
  return {
    clientCommandId: request.clientCommandId,
    operationId:
      admission.kind === 'accepted'
        ? admission.operation.operationId
        : admission.result.operationId,
    disposition: 'accepted',
  };
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
