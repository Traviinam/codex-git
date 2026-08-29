import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DedicatedCodexInstance,
  DedicatedCodexTarget,
  DedicatedRendererConnection,
} from '@codex-git/host-adapter-codex-cdp';
import type { HostContext } from '@codex-git/host-adapter';
import { startCodexRuntime, type CodexRuntime } from '@codex-git/launcher';

const runtimes: CodexRuntime[] = [];

afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).map((runtime) => runtime.close().catch(() => undefined)),
  );
});

describe('Codex runtime composition', () => {
  it('closes the dedicated instance and remains standalone when ownership fails', async () => {
    const instance = new FixtureInstance(null);
    const runtime = await startCodexRuntime({
      healthPort: 0,
      launchInstance: async () => instance,
      projectPath: '/Users/example/codex-git',
      surfacePort: 0,
    });
    runtimes.push(runtime);

    expect(runtime.currentHost()).toBe('standalone');
    expect(instance.closed).toBe(true);
  });

  it('closes the dedicated instance when renderer teardown fails during fallback', async () => {
    const instance = new FixtureInstance(ownedTarget);
    const renderer = new FailingRenderer();
    const runtime = await startCodexRuntime({
      connectRenderer: async () => renderer,
      healthPort: 0,
      launchInstance: async () => instance,
      projectPath: '/Users/example/codex-git',
      surfacePort: 0,
    });
    runtimes.push(runtime);

    renderer.publishStandalone();
    await vi.waitFor(() => expect(instance.closed).toBe(true));
    expect(runtime.currentHost()).toBe('standalone');
  });
});

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
