import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DedicatedCodexInstance,
  DedicatedCodexTarget,
  DedicatedRendererConnection,
} from '@codex-git/host-adapter-codex-cdp';
import type { HostContext, NativeHostAction } from '@codex-git/host-adapter';
import { startCodexRuntime, type CodexRuntime } from '@codex-git/launcher';
import {
  PROTOCOL_VERSION_HEADER,
  repositorySnapshotSchema,
} from '@codex-git/protocol';

import {
  createTemporaryGitRepository,
  type TemporaryGitRepository,
} from '../fixtures/temporary-git-repository.js';

const runtimes: CodexRuntime[] = [];
const repositories: TemporaryGitRepository[] = [];

afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).map((runtime) => runtime.close().catch(() => undefined)),
  );
  await Promise.all(
    repositories.splice(0).map((repository) => repository.dispose()),
  );
});

describe('Codex runtime composition', () => {
  it('closes the dedicated instance and remains standalone when ownership fails', async () => {
    const instance = new FixtureInstance(null);
    const runtime = await startCodexRuntime({
      launchInstance: async () => instance,
      projectPath: '/Users/example/codex-git',
      surfacePort: 0,
    });
    runtimes.push(runtime);

    expect(runtime.currentHost()).toBe('standalone');
    expect(instance.closed).toBe(true);
  });

  it('preserves the dedicated window after a safely cleaned-up fallback until explicit shutdown', async () => {
    const instance = new FixtureInstance(ownedTarget);
    const renderer = new FailingRenderer();
    renderer.close = async () => undefined;
    const runtime = await startCodexRuntime({
      connectRenderer: async () => renderer,
      launchInstance: async () => instance,
      projectPath: '/Users/example/codex-git',
      surfacePort: 0,
    });
    runtimes.push(runtime);
    renderer.publishStandalone();
    await vi.waitFor(() => expect(runtime.currentHost()).toBe('standalone'));
    expect(instance.closed).toBe(false);
    await runtime.close();
    expect(instance.closed).toBe(true);
  });

  it('closes the dedicated instance when renderer teardown fails during fallback', async () => {
    const instance = new FixtureInstance(ownedTarget);
    const renderer = new FailingRenderer();
    const runtime = await startCodexRuntime({
      connectRenderer: async () => renderer,
      launchInstance: async () => instance,
      projectPath: '/Users/example/codex-git',
      surfacePort: 0,
    });
    runtimes.push(runtime);

    renderer.publishStandalone();
    await vi.waitFor(() => expect(instance.closed).toBe(true));
    expect(runtime.currentHost()).toBe('standalone');
  });

  it('advertises and routes only an exact proven current Codex context', async () => {
    const repository = await createTemporaryGitRepository();
    repositories.push(repository);
    await repository.git('config', 'user.name', 'Codex Git Tests');
    await repository.git('config', 'user.email', 'codex-git@example.test');
    await writeFile(join(repository.path, 'README.md'), 'fixture\n');
    await repository.git('add', '--', 'README.md');
    await repository.git('commit', '--quiet', '-m', 'Create fixture');
    await writeFile(join(repository.path, 'README.md'), 'changed\n');
    const canonicalCwd = await realpath(repository.path);
    const renderer = new RoutableRenderer({
      projectPath: canonicalCwd,
      task: { id: 'task-15', title: 'Exact navigation' },
      theme: 'dark',
    });
    const runtime = await startCodexRuntime({
      connectRenderer: async () => renderer,
      launchInstance: async () => new FixtureInstance(ownedTarget),
      metadata: {
        async read() {
          return [
            {
              canonicalCwd,
              kind: 'codex_task',
              stable: true,
              task: {
                id: 'task-15',
                status: 'active',
                title: 'Exact navigation',
              },
            },
          ];
        },
      },
      projectPath: repository.path,
      surfacePort: 0,
    });
    runtimes.push(runtime);
    const snapshot = repositorySnapshotSchema.parse(
      await (await protocolRequest(runtime, 'snapshot')).json(),
    );
    const target = snapshot.worktrees[0]?.nativeTargets.find(({ actions }) =>
      actions.includes('open_codex_context'),
    );
    if (target === undefined) {
      throw new Error('Expected a proven Codex context target.');
    }

    const response = await protocolRequest(runtime, 'native-actions', {
      kind: 'open_codex_context',
      targetId: target.targetId,
    });

    expect(await response.json()).toEqual({ kind: 'performed' });
    expect(renderer.actions).toEqual([
      { kind: 'open-codex-context', targetId: target.targetId },
    ]);
    expect(
      snapshot.worktrees[0]?.changes.some(({ nativeTargets }) =>
        nativeTargets.some(({ actions }) =>
          actions.includes('open_file_in_codex'),
        ),
      ),
    ).toBe(false);

    renderer.setContext({
      projectPath: '/private/tmp/another-project',
      task: { id: 'task-other', title: 'Another task' },
      theme: 'dark',
    });
    const staleContext = await protocolRequest(runtime, 'native-actions', {
      kind: 'open_codex_context',
      targetId: target.targetId,
    });
    expect(await staleContext.json()).toMatchObject({ kind: 'unavailable' });
    expect(renderer.actions).toHaveLength(1);
  });
});

class RoutableRenderer implements DedicatedRendererConnection {
  readonly actions: NativeHostAction[] = [];
  private listener: Parameters<DedicatedRendererConnection['subscribe']>[0] =
    () => undefined;

  constructor(private context: HostContext) {}

  setContext(context: HostContext): void {
    this.context = context;
    this.listener({ kind: 'context', context });
  }

  currentContext(): HostContext {
    return this.context;
  }
  isSurfaceOpen(): boolean {
    return false;
  }
  projectIdentity(): { readonly id: string; readonly label: string } {
    return { id: 'project-routable', label: 'codex-git' };
  }
  subscribe(listener: typeof this.listener): () => void {
    this.listener = listener;
    return () => {
      this.listener = () => undefined;
    };
  }
  async perform(action: NativeHostAction) {
    this.actions.push(action);
    return action.kind === 'open-codex-context'
      ? ({ status: 'succeeded' } as const)
      : ({ status: 'unsupported' } as const);
  }
  async close(): Promise<void> {}
}

const ownedTarget = {
  id: 'renderer-42',
  webSocketUrl: 'ws://127.0.0.1:43117/devtools/page/renderer-42',
} satisfies DedicatedCodexTarget;

class FixtureInstance implements DedicatedCodexInstance {
  readonly build = '7119';
  closed = false;
  readonly ownership = {
    endpoint: 'http://127.0.0.1:43117/',
    instanceId: 'instance-42',
    processId: 4242,
    profilePath: '/private/tmp/codex-git-profile-42',
  };
  readonly version = '26.820.60940';

  constructor(private readonly target: DedicatedCodexTarget | null) {}

  async currentTarget(): Promise<DedicatedCodexTarget | null> {
    return this.target;
  }

  subscribe(): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FailingRenderer implements DedicatedRendererConnection {
  private listener: Parameters<DedicatedRendererConnection['subscribe']>[0] =
    () => undefined;

  currentContext(): HostContext {
    return {
      projectPath: '/Users/example/codex-git',
      task: null,
      theme: 'dark',
    };
  }
  isSurfaceOpen(): boolean {
    return false;
  }
  projectIdentity(): { readonly id: string; readonly label: string } {
    return { id: 'project-42', label: 'codex-git' };
  }
  subscribe(listener: typeof this.listener): () => void {
    this.listener = listener;
    return () => undefined;
  }
  publishStandalone(): void {
    this.listener({ kind: 'standalone-required' });
  }
  async perform(): Promise<{ readonly status: 'rejected' }> {
    return { status: 'rejected' };
  }
  async close(): Promise<void> {
    throw new Error('Closed CDP socket cannot restore CSP');
  }
}

function protocolRequest(
  runtime: CodexRuntime,
  endpoint: 'native-actions' | 'snapshot',
  body?: unknown,
): Promise<Response> {
  const url = new URL(
    runtime.sessionUrl.pathname.replace(/\/session$/u, `/${endpoint}`),
    runtime.sessionUrl,
  );
  return fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin: runtime.surfaceUrl.origin,
      [PROTOCOL_VERSION_HEADER]: '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
