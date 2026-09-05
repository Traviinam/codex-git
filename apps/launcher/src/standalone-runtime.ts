import { execFile } from 'node:child_process';
import { lstat, realpath, readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { HostConnection } from '@codex-git/host-adapter';
import {
  createRepositoryEngine,
  type CodexMetadataAdapter,
  type RepositorySession,
} from '@codex-git/repository-engine';
import type {
  AbsolutePath,
  CommandEnvelope,
  NativeActionRequest,
  NativeActionResult,
  OperationReceipt,
  RepositoryId,
} from '@codex-git/protocol';
import { startLoopbackServer, type LoopbackServer } from '@codex-git/server';
import { StandaloneHostAdapter } from '@codex-git/host-adapter-standalone';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

import { embeddedAssetsPlugin } from './embedded-assets.js';
import { protocolBootstrapPlugin } from './protocol-bootstrap.js';
import { toProtocolRepositorySnapshot } from './repository-protocol-adapter.js';

const loopbackHost = '127.0.0.1';
const execFileAsync = promisify(execFile);
const uiConfigPath = fileURLToPath(
  new URL('../../ui/vite.config.ts', import.meta.url),
);

export interface StandaloneRuntimeOptions {
  readonly metadata?: CodexMetadataAdapter;
  readonly nativeHostConnection?: () => HostConnection | null;
  readonly projectPath?: string;
  readonly surfacePort?: number;
}

export interface StandaloneRuntime {
  readonly healthUrl: URL;
  readonly sessionUrl: URL;
  readonly surfaceUrl: URL;
  loadEmbeddedDocument(): Promise<string>;
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
      closeSurfaceServer(surfaceServer),
      protocolServer?.close(),
    ]);
    await invalidationPump;
  }

  try {
    if (options.projectPath !== undefined) {
      repositorySession = await createRepositoryEngine({
        metadata: options.metadata,
      }).open(options.projectPath as AbsolutePath);
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
                performNativeAction(
                  repositorySession!,
                  request,
                  options.nativeHostConnection,
                ),
              branchSearch: (request) =>
                repositorySession!.searchBranches(request),
              commitDrafts: (request) =>
                repositorySession!.updateDraft(request),
              snapshot: async () => {
                const result = await repositorySession!.requestRefresh();
                return toProtocolRepositorySnapshot(
                  result,
                  options.projectPath!,
                  await hostNavigationContext(
                    options.nativeHostConnection?.() ?? null,
                  ),
                );
              },
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
        embeddedAssetsPlugin(),
        protocolBootstrapPlugin(protocolServer.sessionUrl, options.projectPath),
      ],
      server: {
        host: loopbackHost,
        port: options.surfacePort ?? 5173,
        strictPort: true,
        cors: false,
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
      async loadEmbeddedDocument() {
        if (closed) throw new Error('The surface is closed.');
        const source = await readFile(
          new URL('../../ui/index.html', import.meta.url),
          'utf8',
        );
        const html = await surfaceServer!.transformIndexHtml(
          surfaceUrl.href,
          source,
        );
        return html.replace('<head>', `<head><base href="${surfaceUrl.href}">`);
      },
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

async function closeSurfaceServer(
  server: ViteDevServer | undefined,
): Promise<void> {
  if (server === undefined) return;
  await server.environments.client?.waitForRequestsIdle();
  await server.close();
}

async function dispatchRepositoryCommand(
  session: RepositorySession,
  request: CommandEnvelope,
): Promise<OperationReceipt> {
  if (
    request.command.kind === 'stage' ||
    request.command.kind === 'unstage' ||
    request.command.kind === 'commit' ||
    request.command.kind === 'cancel_operation' ||
    request.command.kind === 'switch_branch' ||
    request.command.kind === 'pull' ||
    request.command.kind === 'push' ||
    request.command.kind === 'publish'
  ) {
    return session.dispatch(request);
  }
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

async function performNativeAction(
  session: RepositorySession,
  request: NativeActionRequest,
  nativeHostConnection?: () => HostConnection | null,
): Promise<NativeActionResult> {
  if (request.kind === 'open_terminal') {
    try {
      const target = await session.resolveWorktreeNativeTarget(
        request.targetId,
      );
      const resolvedWorktree = await revalidateWorktreePath(target);
      await execFileAsync(
        '/usr/bin/open',
        ['-a', 'Terminal', '--', resolvedWorktree],
        {
          timeout: 10_000,
          windowsHide: true,
        },
      );
      return { kind: 'performed' };
    } catch {
      return {
        kind: 'unavailable',
        message: 'The Worktree is no longer available. Refresh and try again.',
      };
    }
  }
  try {
    if (request.kind === 'copy_relative_path') {
      const target = await session.resolveFileNativeTarget(request.targetId);
      return { kind: 'copy_text', text: target.relativePath };
    }
    if (request.kind === 'copy_branch_or_sha') {
      const target = await session.resolveWorktreeNativeTarget(
        request.targetId,
      );
      return { kind: 'copy_text', text: target.branchOrSha };
    }
    if (request.kind === 'copy_absolute_path') {
      const target = await resolvePathTarget(session, request.targetId);
      if (target.kind === 'worktree') {
        await revalidateWorktreePath(target);
      }
      return { kind: 'copy_text', text: target.absolutePath };
    }
    if (
      request.kind === 'open_codex_context' ||
      request.kind === 'open_file_in_codex'
    ) {
      const host = nativeHostConnection?.() ?? null;
      if (host === null) throw new Error('The Codex host is unavailable.');
      const capabilities = host.capabilities();
      const target =
        request.kind === 'open_codex_context'
          ? await session.resolveWorktreeNativeTarget(request.targetId)
          : await session.resolveFileNativeTarget(request.targetId);
      if (
        (request.kind === 'open_codex_context'
          ? !capabilities.openCodexContext
          : !capabilities.openFileInCodex) ||
        !(await hostContextMatches(
          host,
          target.worktreePath,
          target.provenance,
        ))
      ) {
        throw new Error('The Codex host cannot prove the exact target.');
      }
      const hostResult = await host.perform({
        kind:
          request.kind === 'open_codex_context'
            ? 'open-codex-context'
            : 'open-file-in-codex',
        targetId: request.targetId,
      });
      if (hostResult.status !== 'succeeded') {
        throw new Error('The Codex host rejected the exact target.');
      }
      return { kind: 'performed' };
    }
    const target = await resolvePathTarget(session, request.targetId);
    if (!target.canLaunch) {
      throw new Error('The target cannot be opened from its current state.');
    }
    if (target.kind === 'worktree') {
      const path = await revalidateWorktreePath(target);
      await execFileAsync('/usr/bin/open', ['-R', '--', path], {
        timeout: 10_000,
        windowsHide: true,
      });
      return { kind: 'performed' };
    }
    const metadata = await lstat(target.absolutePath);
    if (request.kind === 'open_default_app' && metadata.isSymbolicLink()) {
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
    await execFileAsync(
      '/usr/bin/open',
      request.kind === 'reveal_in_finder'
        ? ['-R', '--', target.absolutePath]
        : ['--', resolvedFile],
      {
        timeout: 10_000,
        windowsHide: true,
      },
    );
    return { kind: 'performed' };
  } catch {
    return {
      kind: 'unavailable',
      message:
        'The exact target is no longer available. Refresh or use a safe copy action.',
    };
  }
}

async function hostNavigationContext(host: HostConnection | null) {
  if (host === null) {
    return {
      canonicalProjectPath: null,
      openCodexContext: false,
      openFileInCodex: false,
      taskId: null,
    } as const;
  }
  const context = host.currentContext();
  return {
    ...host.capabilities(),
    canonicalProjectPath:
      context.projectPath === null
        ? null
        : await realpath(context.projectPath).catch(() => null),
    taskId: context.task?.id ?? null,
  };
}

async function hostContextMatches(
  host: HostConnection,
  worktreePath: string,
  provenance: import('@codex-git/repository-engine').WorktreeProvenance,
): Promise<boolean> {
  const before = host.currentContext();
  const canonicalProjectPath =
    before.projectPath === null
      ? null
      : await realpath(before.projectPath).catch(() => null);
  const current = host.currentContext();
  if (
    current.projectPath !== before.projectPath ||
    current.task?.id !== before.task?.id
  ) {
    return false;
  }
  return (
    (provenance.kind === 'codex_task' &&
      provenance.task.id === current.task?.id) ||
    canonicalProjectPath === worktreePath
  );
}

type ResolvedPathTarget =
  | {
      readonly kind: 'file';
      readonly absolutePath: string;
      readonly canLaunch: boolean;
      readonly worktreePath: string;
    }
  | {
      readonly kind: 'worktree';
      readonly absolutePath: string;
      readonly canLaunch: boolean;
      readonly worktreePath: string;
    };

async function resolvePathTarget(
  session: RepositorySession,
  targetId: NativeActionRequest['targetId'],
): Promise<ResolvedPathTarget> {
  try {
    const file = await session.resolveFileNativeTarget(targetId);
    if (file.absolutePath === null) throw new Error('No file path.');
    return {
      kind: 'file',
      absolutePath: file.absolutePath,
      canLaunch: file.canOpen,
      worktreePath: file.worktreePath,
    };
  } catch {
    const worktree = await session.resolveWorktreeNativeTarget(targetId);
    return {
      kind: 'worktree',
      absolutePath: worktree.absolutePath,
      canLaunch: worktree.canLaunch,
      worktreePath: worktree.worktreePath,
    };
  }
}

async function revalidateWorktreePath(
  target: Pick<ResolvedPathTarget, 'canLaunch' | 'worktreePath'>,
): Promise<string> {
  if (!target.canLaunch) throw new Error('The Worktree is unavailable.');
  const resolved = await realpath(target.worktreePath);
  if (resolved !== target.worktreePath) {
    throw new Error('The Worktree moved before navigation.');
  }
  return resolved;
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
