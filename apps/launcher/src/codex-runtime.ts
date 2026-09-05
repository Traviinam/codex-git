import type { HostConnection } from '@codex-git/host-adapter';
import {
  connectDedicatedCodexRenderer,
  DedicatedCodexHostAdapter,
  launchDedicatedCodexInstance,
  type ConnectDedicatedRenderer,
  type DedicatedCodexInstance,
  type LaunchDedicatedCodexOptions,
} from '@codex-git/host-adapter-codex-cdp';

import {
  startStandaloneRuntime,
  type StandaloneRuntime,
  type StandaloneRuntimeOptions,
} from './standalone-runtime.js';

export interface CodexRuntimeOptions extends StandaloneRuntimeOptions {
  readonly connectRenderer?: ConnectDedicatedRenderer;
  readonly dedicatedInstance?: LaunchDedicatedCodexOptions;
  readonly launchInstance?: (
    options?: LaunchDedicatedCodexOptions,
  ) => Promise<DedicatedCodexInstance>;
  readonly projectPath: string;
}

export interface CodexRuntime extends StandaloneRuntime {
  currentHost(): 'codex' | 'standalone';
}

export async function startCodexRuntime(
  options: CodexRuntimeOptions,
): Promise<CodexRuntime> {
  let instance: DedicatedCodexInstance | null = null;
  let connection: HostConnection | null = null;
  const standalone = await startStandaloneRuntime({
    ...options,
    nativeHostConnection: () => connection,
  });
  let host: 'codex' | 'standalone' = 'standalone';
  let closing = false;
  let monitor = Promise.resolve();

  try {
    instance = await (options.launchInstance ?? launchDedicatedCodexInstance)(
      options.dedicatedInstance,
    );
    const result = await new DedicatedCodexHostAdapter({
      connectRenderer:
        options.connectRenderer ??
        ((request) =>
          connectDedicatedCodexRenderer(request, {
            loadDocument: () => standalone.loadEmbeddedDocument(),
          })),
      instance,
      projectPath: options.projectPath,
    }).attach({
      title: 'Codex Git',
      url: standalone.surfaceUrl,
    });
    if (result.kind === 'standalone-required') {
      await instance.close();
      instance = null;
    } else {
      connection = result.connection;
      host = 'codex';
      monitor = monitorTransitions(connection, async () => {
        if (closing) {
          return;
        }
        host = 'standalone';
        const attachedConnection = connection;
        const dedicatedInstance = instance;
        connection = null;
        try {
          await attachedConnection?.close();
        } catch {
          // Terminate only when native state/CSP could not be restored safely.
          instance = null;
          await dedicatedInstance?.close();
        }
      });
    }
  } catch {
    await instance?.close().catch(() => undefined);
    instance = null;
  }

  return {
    healthUrl: standalone.healthUrl,
    sessionUrl: standalone.sessionUrl,
    surfaceUrl: standalone.surfaceUrl,
    loadEmbeddedDocument: () => standalone.loadEmbeddedDocument(),
    currentHost: () => host,
    async close() {
      if (closing) {
        return;
      }
      closing = true;
      const results = await Promise.allSettled([connection?.close()]);
      results.push(
        ...(await Promise.allSettled([
          instance?.close(),
          monitor,
          standalone.close(),
        ])),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      if (failure !== undefined) {
        throw failure.reason;
      }
    },
  };
}

async function monitorTransitions(
  connection: HostConnection,
  fallback: () => Promise<void>,
): Promise<void> {
  for await (const transition of connection.transitions()) {
    if (transition.kind === 'standalone-required') {
      await fallback();
      return;
    }
  }
}
