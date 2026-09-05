import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

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

  it('rejects document injection without a launcher-owned loader before CDP', async () => {
    const session = new FixtureCdpSession({ status: 'attached' });
    await expect(
      connectDedicatedCodexRenderer(
        { ...request, build: '7982', version: '26.901.41600' },
        { connect: async () => session },
      ),
    ).rejects.toThrow('document loader');
    expect(session.commands).toEqual([]);
  });

  it('keeps the Git entry and connection when native navigation clears project selection', async () => {
    const dom = new JSDOM(
      `<aside id="app-shell-sidebar"><button>New chat</button><div data-app-action-sidebar-project-row aria-current="page" data-app-action-sidebar-project-id="project-42" data-app-action-sidebar-project-label="codex-git"></div><div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-selected="true" data-app-action-sidebar-thread-id="task-42" data-app-action-sidebar-thread-title="Native task"></div></aside><main data-app-shell-main-surface="default"></main>`,
      { runScripts: 'outside-only', url: 'https://codex.invalid' },
    );
    const session = new FixtureCdpSession({}, 'Chrome/151.0.7922.170', dom);
    const binding = '__codexGitNotify_navigation';
    Object.assign(dom.window, {
      [binding]: (payload: string) =>
        session.publish({
          method: 'Runtime.bindingCalled',
          params: { name: binding, payload },
        }),
    });
    const connection = await connectDedicatedCodexRenderer(request, {
      connect: async () => session,
      createBindingName: () => binding,
    });
    const events: string[] = [];
    connection.subscribe((event) => events.push(event.kind));
    dom.window.document
      .querySelector('[data-app-action-sidebar-project-row]')!
      .removeAttribute('aria-current');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).not.toContain('standalone-required');
    expect(
      dom.window.document.querySelectorAll('[data-codex-git-sidebar-entry]'),
    ).toHaveLength(1);
    expect(connection.currentContext().task).toBeNull();
    expect(connection.currentContext().projectPath).toBeNull();
    expect(
      await connection.perform({
        kind: 'open-codex-context',
        targetId: 'unproven',
      }),
    ).toEqual({ status: 'rejected' });
    const contextsBefore = events.filter((kind) => kind === 'context').length;
    session.publish({ method: 'Runtime.executionContextsCleared' });
    await vi.waitFor(() =>
      expect(
        events.filter((kind) => kind === 'context').length,
      ).toBeGreaterThan(contextsBefore),
    );
    expect(
      dom.window.document.querySelectorAll('[data-codex-git-sidebar-entry]'),
    ).toHaveLength(1);
    const gitEntry = dom.window.document.querySelector<HTMLButtonElement>(
      '[data-codex-git-sidebar-entry]',
    )!;
    gitEntry.click();
    expect(gitEntry.getAttribute('aria-current')).toBe('page');
    expect(gitEntry.style.backgroundColor).not.toBe('');
    await connection.perform({ kind: 'restore-native-surface' });
    expect(gitEntry.hasAttribute('aria-current')).toBe(false);
    expect(gitEntry.style.backgroundColor).toBe('');
    const projectRow = dom.window.document.querySelector(
      '[data-app-action-sidebar-project-row]',
    )!;
    const entry = dom.window.document.querySelector<HTMLButtonElement>(
      '[data-codex-git-sidebar-entry]',
    )!;
    projectRow.setAttribute('aria-current', 'page');
    projectRow.setAttribute(
      'data-app-action-sidebar-project-id',
      'another-project',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(entry.disabled).toBe(true);
    expect(connection.currentContext().task).toBeNull();
    projectRow.setAttribute('data-app-action-sidebar-project-id', 'project-42');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(entry.disabled).toBe(false);
    expect(events).not.toContain('standalone-required');
    await connection.close();
    dom.window.close();
  });

  it('reports native cleanup failure after still releasing CSP', async () => {
    const session = new FixtureCdpSession({
      context: expectedContext,
      project: { id: 'project-42', label: 'codex-git' },
      status: 'attached',
    });
    const connection = await connectDedicatedCodexRenderer(request, {
      connect: async () => session,
    });
    const send = session.send.bind(session);
    session.send = async (method, params) => {
      if (method === 'Runtime.evaluate')
        return { exceptionDetails: { text: 'Native cleanup failed' } };
      return send(method, params);
    };
    await expect(connection.close()).rejects.toThrow('native Codex surface');
    expect(session.commands).toContainEqual({
      method: 'Page.setBypassCSP',
      params: { enabled: false },
    });
    session.send = send;
    await connection.close();
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

  it.each([{ build: '6962', version: '26.818.41509' }])(
    'rejects build $build before CDP because its live CSP blocks the surface frame',
    async (profile) => {
      const session = new FixtureCdpSession({
        context: expectedContext,
        project: { id: 'project-42', label: 'codex-git' },
        status: 'attached',
      });

      await expect(
        connectDedicatedCodexRenderer(
          { ...request, ...profile },
          { connect: async () => session },
        ),
      ).rejects.toThrow('Unsupported Codex Desktop version');
      expect(session.commands).toEqual([]);
    },
  );

  it('rejects a version and build from different tested profiles before CDP', async () => {
    const session = new FixtureCdpSession({ status: 'attached' });

    await expect(
      connectDedicatedCodexRenderer(
        { ...request, build: '6962' },
        { connect: async () => session },
      ),
    ).rejects.toThrow('Unsupported Codex Desktop version');
    expect(session.commands).toEqual([]);
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
    private readonly dom?: JSDOM,
  ) {}

  async send(method: string, params?: unknown): Promise<unknown> {
    this.commands.push(params === undefined ? { method } : { method, params });
    if (method === 'Browser.getVersion') {
      return { product: this.product };
    }
    if (method === 'Runtime.evaluate') {
      if (this.dom !== undefined) {
        const expression = isRecord(params) ? params.expression : null;
        if (typeof expression !== 'string') {
          throw new Error('Expected a Runtime.evaluate expression');
        }
        try {
          return { result: { value: this.dom.window.eval(expression) } };
        } catch (error) {
          return {
            exceptionDetails: {
              exception: {
                description:
                  error instanceof Error ? error.message : String(error),
              },
            },
          };
        }
      }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
