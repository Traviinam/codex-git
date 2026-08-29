import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { HostConnection } from '@codex-git/host-adapter';
import { startLoopbackServer, type LoopbackServer } from '@codex-git/server';
import { StandaloneHostAdapter } from '@codex-git/host-adapter-standalone';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

const loopbackHost = '127.0.0.1';
const uiConfigPath = fileURLToPath(
  new URL('../../ui/vite.config.ts', import.meta.url),
);

export interface StandaloneRuntimeOptions {
  readonly healthPort?: 0;
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

  async function closeResources(): Promise<void> {
    await Promise.all([
      hostConnection?.close(),
      surfaceServer?.close(),
      protocolServer?.close(),
    ]);
  }

  try {
    surfaceServer = await createViteServer({
      configFile: uiConfigPath,
      server: {
        host: loopbackHost,
        port: options.surfacePort ?? 5173,
        strictPort: true,
      },
    });
    await surfaceServer.listen();

    const surfaceUrl = serverUrl(surfaceServer.httpServer, '/');
    protocolServer = await startLoopbackServer({
      allowedOrigins: ['null', surfaceUrl.origin],
    });
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
