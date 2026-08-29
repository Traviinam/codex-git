import { describe, expect, it } from 'vitest';

import type { HostContext, NativeActionResult } from '@codex-git/host-adapter';

import {
  DedicatedCodexHostAdapter,
  type ConnectDedicatedRenderer,
  type DedicatedCodexInstance,
  type DedicatedCodexOwnership,
  type DedicatedCodexTarget,
  type DedicatedRendererConnection,
} from './index.js';

const surface = {
  title: 'Codex Git',
  url: new URL('http://127.0.0.1:4173'),
};

describe('DedicatedCodexHostAdapter', () => {
  it('rejects a target whose websocket is not bound to the launched endpoint', async () => {
    const instance = new FixtureInstance({
      id: 'foreign-target',
      webSocketUrl: 'ws://127.0.0.1:65530/devtools/page/foreign-target',
    });
    let connections = 0;
    const result = await new DedicatedCodexHostAdapter({
      connectRenderer: async () => {
        connections++;
        return new FixtureRendererConnection(defaultContext);
      },
      instance,
      projectPath: '/Users/example/codex-git',
    }).attach(surface);

    expect(result).toMatchObject({
      kind: 'standalone-required',
      reason: { code: 'host-unavailable' },
    });
    expect(connections).toBe(0);
  });

  it('remounts an open surface on an owned replacement target', async () => {
    const instance = new FixtureInstance(ownedTarget('renderer-1'));
    const sessions: FixtureRendererConnection[] = [];
    const requests: Array<{ openSurface: boolean; targetId: string }> = [];
    const connectRenderer: ConnectDedicatedRenderer = async (request) => {
      requests.push({
        openSurface: request.openSurface,
        targetId: request.target.id,
      });
      const session = new FixtureRendererConnection(
        sessions.length === 0
          ? defaultContext
          : { ...defaultContext, theme: 'light' },
        true,
      );
      sessions.push(session);
      return session;
    };
    const result = await new DedicatedCodexHostAdapter({
      connectRenderer,
      instance,
      projectPath: '/Users/example/codex-git',
    }).attach(surface);
    if (result.kind !== 'attached') {
      throw new Error('Expected the owned renderer to attach');
    }
    const contexts = result.connection.contexts()[Symbol.asyncIterator]();
    await contexts.next();

    instance.publish(ownedTarget('renderer-2'));
    await expect(contexts.next()).resolves.toEqual({
      done: false,
      value: { ...defaultContext, theme: 'light' },
    });
    expect(requests).toEqual([
      { openSurface: false, targetId: 'renderer-1' },
      { openSurface: true, targetId: 'renderer-2' },
    ]);
    expect(sessions[0]?.closed).toBe(true);

    await result.connection.close();
  });

  it('publishes one standalone transition when replacement cannot reacquire CSP', async () => {
    const instance = new FixtureInstance(ownedTarget('renderer-1'));
    let connectionCount = 0;
    const result = await new DedicatedCodexHostAdapter({
      connectRenderer: async () => {
        if (++connectionCount > 1) {
          throw new Error('CSP reacquisition failed');
        }
        return new FixtureRendererConnection(defaultContext, true);
      },
      instance,
      projectPath: '/Users/example/codex-git',
    }).attach(surface);
    if (result.kind !== 'attached') {
      throw new Error('Expected the owned renderer to attach');
    }
    const transitions = result.connection.transitions()[Symbol.asyncIterator]();

    instance.publish(ownedTarget('renderer-2'));
    await expect(transitions.next()).resolves.toMatchObject({
      done: false,
      value: {
        kind: 'standalone-required',
        reason: { code: 'attach-failed' },
      },
    });

    await result.connection.close();
    await expect(transitions.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});

const defaultContext = {
  projectPath: '/Users/example/codex-git',
  task: { id: 'task-1', title: 'Implement dedicated renderer' },
  theme: 'dark',
} satisfies HostContext;

const ownership = {
  endpoint: 'http://127.0.0.1:43117/',
  instanceId: 'instance-42',
  processId: 4242,
  profilePath: '/private/tmp/codex-git-profile-42',
} satisfies DedicatedCodexOwnership;

function ownedTarget(id: string): DedicatedCodexTarget {
  return {
    id,
    webSocketUrl: `ws://127.0.0.1:43117/devtools/page/${id}`,
  };
}

// prettier-ignore
class FixtureInstance implements DedicatedCodexInstance {
  readonly ownership = ownership;
  readonly version = '26.820.60940';
  private readonly listeners = new Set<(target: DedicatedCodexTarget | null) => void>();
  constructor(private target: DedicatedCodexTarget | null) {}
  async currentTarget(): Promise<DedicatedCodexTarget | null> { return this.target; }
  subscribe(listener: (target: DedicatedCodexTarget | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(target: DedicatedCodexTarget | null): void {
    this.target = target;
    this.listeners.forEach((listener) => listener(target));
  }
  async close(): Promise<void> {}
}

// prettier-ignore
class FixtureRendererConnection implements DedicatedRendererConnection {
  closed = false;

  constructor(private context: HostContext, private readonly surfaceOpen = false) {}
  currentContext(): HostContext { return this.context; }
  isSurfaceOpen(): boolean { return this.surfaceOpen; }
  projectIdentity(): { readonly id: string; readonly label: string } { return { id: 'project-42', label: 'codex-git' }; }
  subscribe(): () => void { return () => undefined; }
  async perform(): Promise<NativeActionResult> { return { status: 'succeeded' }; }
  async close(): Promise<void> { this.closed = true; }
}
