import { describe, expect, it } from 'vitest';

import type { HostContext } from '@codex-git/host-adapter';

import {
  connectDedicatedCodexRenderer,
  type CdpEvent,
  type CdpSession,
  type ConnectDedicatedRendererRequest,
} from './index.js';

describe('dedicated Codex remote renderer', () => {
  it('binds the trusted path to the startup-observed project and scopes CSP', async () => {
    const session = new FixtureCdpSession([
      { status: 'not-ready' },
      {
        context: expectedContext,
        project: { id: 'project-42', label: 'codex-git' },
        status: 'attached',
      },
      {
        context: expectedContext,
        project: { id: 'project-42', label: 'codex-git' },
        status: 'attached',
      },
    ]);
    const connection = await connectDedicatedCodexRenderer(request, {
      connect: async () => session,
      createBindingName: () => '__codexGitNotify_fixture',
      wait: async () => undefined,
    });

    expect(connection.currentContext()).toEqual(expectedContext);
    expect(connection.projectIdentity()).toEqual({
      id: 'project-42',
      label: 'codex-git',
    });
    expect(session.commands.map(({ method }) => method)).toEqual([
      'Browser.getVersion',
      'Runtime.enable',
      'Runtime.addBinding',
      'Page.setBypassCSP',
      'Runtime.evaluate',
      'Runtime.evaluate',
    ]);

    const reinstalled = new Promise<void>((resolve) => {
      connection.subscribe((event) => {
        if (event.kind === 'context') resolve();
      });
    });
    session.publish({ method: 'Runtime.executionContextsCleared' });
    await reinstalled;

    const degraded = new Promise<void>((resolve) => {
      connection.subscribe((event) => {
        if (event.kind === 'standalone-required') resolve();
      });
    });
    session.publish({ method: 'CodexGit.sessionClosed' });
    await degraded;

    await connection.close();
    expect(session.commands.slice(-2).map(({ method }) => method)).toEqual([
      'Runtime.evaluate',
      'Page.setBypassCSP',
    ]);
    expect(session.closed).toBe(true);
  });

  it('fails closed when the selected project differs from the bound identity', async () => {
    const session = new FixtureCdpSession({ status: 'project-mismatch' });

    await expect(
      connectDedicatedCodexRenderer(
        {
          ...request,
          expectedProject: { id: 'project-previous', label: 'codex-git' },
        },
        { connect: async () => session },
      ),
    ).rejects.toThrow('selected project does not match');
    expect(session.closed).toBe(true);
  });

  it('rejects an unverified Chromium build before changing CSP', async () => {
    const session = new FixtureCdpSession(
      { status: 'not-ready' },
      'Chrome/151.0.7922.171',
    );

    await expect(
      connectDedicatedCodexRenderer(request, {
        connect: async () => session,
      }),
    ).rejects.toThrow('Unsupported Codex Desktop Chromium version');
    expect(session.commands.map(({ method }) => method)).toEqual([
      'Browser.getVersion',
    ]);
  });
});

const expectedContext = {
  projectPath: '/Users/example/codex-git',
  task: { id: 'task-42', title: 'Implement CDP transport' },
  theme: 'dark',
} satisfies HostContext;

const request = {
  build: '7119',
  expectedProject: null,
  openSurface: false,
  ownership: {
    endpoint: 'http://127.0.0.1:43117/',
    instanceId: 'instance-42',
    processId: 4242,
    profilePath: '/private/tmp/codex-git-profile-42',
  },
  projectPath: '/Users/example/codex-git',
  surface: {
    title: 'Codex Git',
    url: new URL('http://127.0.0.1:4173'),
  },
  target: {
    id: 'renderer-42',
    webSocketUrl: 'ws://127.0.0.1:43117/devtools/page/renderer-42',
  },
  version: '26.820.60940',
} satisfies ConnectDedicatedRendererRequest;

class FixtureCdpSession implements CdpSession {
  readonly commands: Array<{ method: string; params?: unknown }> = [];
  closed = false;
  private listener: ((event: CdpEvent) => void) | null = null;

  constructor(
    private readonly installation: unknown | unknown[],
    private readonly product = 'Chrome/151.0.7922.170',
  ) {}

  async send(method: string, params?: unknown): Promise<unknown> {
    this.commands.push(params === undefined ? { method } : { method, params });
    if (method === 'Browser.getVersion') {
      return { product: this.product };
    }
    if (method === 'Runtime.evaluate') {
      const value = Array.isArray(this.installation)
        ? this.installation.shift()
        : this.installation;
      return { result: { value } };
    }
    return {};
  }

  subscribe(listener: (event: CdpEvent) => void): () => void {
    this.listener = listener;
    return () => (this.listener = null);
  }

  publish(event: CdpEvent): void {
    this.listener?.(event);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
