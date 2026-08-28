import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import type { HostContext } from '@codex-git/host-adapter';

import {
  CodexCdpHostAdapter,
  type CodexRenderer,
  type CodexRendererSource,
} from './index.js';

describe('CodexCdpHostAdapter', () => {
  it('fails closed without changing an incompatible renderer', async () => {
    const dom = new JSDOM('<div id="unrelated-native-ui">Codex</div>');
    const renderer = fixtureRenderer(dom, '26.820.60940');
    const before = dom.window.document.documentElement.outerHTML;

    const result = await new CodexCdpHostAdapter({
      rendererSource: new FixtureRendererSource(renderer),
    }).attach({
      title: 'Codex Git',
      url: new URL('http://127.0.0.1:4173'),
    });

    expect(result).toEqual({
      kind: 'standalone-required',
      reason: {
        code: 'incompatible-host',
        message:
          'Codex Desktop 26.820.60940 did not match the tested host structure; use the standalone surface.',
      },
    });
    expect(dom.window.document.documentElement.outerHTML).toBe(before);
  });

  it('mounts one opaque Git surface and restores native navigation', async () => {
    const dom = compatibleDom();
    const result = await new CodexCdpHostAdapter({
      rendererSource: new FixtureRendererSource(
        fixtureRenderer(dom, '26.820.60940'),
      ),
    }).attach({
      title: 'Codex Git',
      url: new URL('http://127.0.0.1:4173'),
    });

    expect(result.kind).toBe('attached');
    if (result.kind !== 'attached') {
      throw new Error('Expected the compatible Codex renderer to attach');
    }

    const document = dom.window.document;
    const gitEntry = document.querySelector<HTMLButtonElement>(
      '[data-codex-git-sidebar-entry]',
    );
    expect(gitEntry?.textContent).toBe('Git');
    expect(document.querySelector('[data-codex-git-surface]')).toBeNull();

    gitEntry?.click();

    const frame = document.querySelector<HTMLIFrameElement>(
      '[data-codex-git-surface] iframe',
    );
    const nativeSurface = document.querySelector<HTMLElement>(
      '[data-app-shell-main-surface="default"]',
    );
    expect({
      frameCount: document.querySelectorAll('[data-codex-git-surface]').length,
      nativeHidden: nativeSurface?.hidden,
      sandbox: frame?.getAttribute('sandbox'),
      source: frame?.src,
    }).toEqual({
      frameCount: 1,
      nativeHidden: true,
      sandbox: 'allow-scripts',
      source: 'http://127.0.0.1:4173/',
    });

    document.querySelector<HTMLButtonElement>('[data-native-entry]')?.click();
    expect({
      nativeHidden: nativeSurface?.hidden,
      surface: document.querySelector('[data-codex-git-surface]'),
    }).toEqual({ nativeHidden: false, surface: null });

    await result.connection.close();
    expect(document.querySelector('[data-codex-git-sidebar-entry]')).toBeNull();
    expect(nativeSurface?.hidden).toBe(false);
  });

  it('keeps exactly one entry when the adapter attaches repeatedly', async () => {
    const dom = compatibleDom();
    const adapter = new CodexCdpHostAdapter({
      rendererSource: new FixtureRendererSource(
        fixtureRenderer(dom, '26.820.60940'),
      ),
    });
    const surface = {
      title: 'Codex Git',
      url: new URL('http://127.0.0.1:4173'),
    };

    const first = await adapter.attach(surface);
    documentEntry(dom)?.click();
    const second = await adapter.attach(surface);

    expect({
      entries: dom.window.document.querySelectorAll(
        '[data-codex-git-sidebar-entry]',
      ).length,
      surfaces: dom.window.document.querySelectorAll('[data-codex-git-surface]')
        .length,
    }).toEqual({ entries: 1, surfaces: 0 });

    if (first.kind === 'attached') {
      await first.connection.close();
    }
    expect(documentEntry(dom)).not.toBeNull();

    if (second.kind === 'attached') {
      await second.connection.close();
    }
  });

  it('accepts actions only from the current frame capability and challenge', async () => {
    const dom = compatibleDom();
    const secrets = [
      'capability-1',
      'challenge-1',
      'capability-2',
      'challenge-2',
    ];
    const result = await new CodexCdpHostAdapter({
      createSecret: () => secrets.shift() ?? 'unexpected-secret',
      rendererSource: new FixtureRendererSource(
        fixtureRenderer(dom, '26.820.60940'),
      ),
    }).attach({
      title: 'Codex Git',
      url: new URL('http://127.0.0.1:4173'),
    });
    if (result.kind !== 'attached') {
      throw new Error('Expected the compatible Codex renderer to attach');
    }

    documentEntry(dom)?.click();
    const firstFrame = documentFrame(dom);
    const hostContext = await captureHostContext(dom, firstFrame);
    expect(hostContext).toEqual({
      capability: 'capability-1',
      challenge: 'challenge-1',
      context: {
        projectPath: null,
        task: null,
        theme: 'system',
      },
      generation: 1,
      type: 'codex-git:host-context',
    });

    dispatchHostAction(dom, firstFrame, {
      ...hostContext,
      capability: 'wrong-capability',
      action: { kind: 'restore-native-surface' },
      type: 'codex-git:host-action',
    });
    expect(documentFrame(dom)).toBe(firstFrame);

    dispatchHostAction(dom, firstFrame, {
      ...hostContext,
      action: { kind: 'restore-native-surface' },
      type: 'codex-git:host-action',
    });
    expect(documentFrame(dom)).toBeNull();

    documentEntry(dom)?.click();
    const secondFrame = documentFrame(dom);
    const secondContext = await captureHostContext(dom, secondFrame);
    expect(secondContext).toMatchObject({
      capability: 'capability-2',
      challenge: 'challenge-2',
      generation: 2,
    });

    dispatchHostAction(dom, firstFrame, {
      ...hostContext,
      action: { kind: 'restore-native-surface' },
      type: 'codex-git:host-action',
    });
    expect(documentFrame(dom)).toBe(secondFrame);

    await result.connection.close();
  });

  it('forwards Current Project, theme, and current task context changes', async () => {
    const dom = compatibleDom();
    const renderer = new FixtureRenderer(dom, '26.820.60940', {
      projectPath: '/Users/example/codex-git',
      task: { id: 'task-1', title: 'Implement Host Adapter' },
      theme: 'dark',
    });
    const result = await new CodexCdpHostAdapter({
      rendererSource: new FixtureRendererSource(renderer),
    }).attach({
      title: 'Codex Git',
      url: new URL('http://127.0.0.1:4173'),
    });
    if (result.kind !== 'attached') {
      throw new Error('Expected the compatible Codex renderer to attach');
    }

    const contexts = result.connection.contexts()[Symbol.asyncIterator]();
    expect(await contexts.next()).toEqual({
      done: false,
      value: {
        projectPath: '/Users/example/codex-git',
        task: { id: 'task-1', title: 'Implement Host Adapter' },
        theme: 'dark',
      },
    });

    documentEntry(dom)?.click();
    const frame = documentFrame(dom);
    await captureHostContext(dom, frame);
    const nextFrameContext = captureNextFrameMessage(frame);
    renderer.publishContext({
      projectPath: '/Users/example/another-project',
      task: { id: 'task-2', title: 'Review changes' },
      theme: 'light',
    });

    expect(await contexts.next()).toEqual({
      done: false,
      value: {
        projectPath: '/Users/example/another-project',
        task: { id: 'task-2', title: 'Review changes' },
        theme: 'light',
      },
    });
    expect(await nextFrameContext).toMatchObject({
      context: {
        projectPath: '/Users/example/another-project',
        task: { id: 'task-2', title: 'Review changes' },
        theme: 'light',
      },
      type: 'codex-git:host-context',
    });

    await result.connection.close();
    await expect(contexts.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('reattaches after a compatible renderer replacement', async () => {
    const firstDom = compatibleDom();
    const secondDom = compatibleDom();
    const source = new FixtureRendererSource(
      fixtureRenderer(firstDom, '26.820.60940'),
    );
    const result = await new CodexCdpHostAdapter({
      rendererSource: source,
    }).attach({
      title: 'Codex Git',
      url: new URL('http://127.0.0.1:4173'),
    });
    if (result.kind !== 'attached') {
      throw new Error('Expected the compatible Codex renderer to attach');
    }
    documentEntry(firstDom)?.click();

    source.publish(fixtureRenderer(secondDom, '26.820.60940'));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect({
      oldEntry: documentEntry(firstDom) !== null,
      oldSurface: documentFrame(firstDom) !== null,
      oldSurfaceHidden: nativeSurface(firstDom)?.hidden,
      replacementEntries: secondDom.window.document.querySelectorAll(
        '[data-codex-git-sidebar-entry]',
      ).length,
      replacementSurface: documentFrame(secondDom) !== null,
    }).toEqual({
      oldEntry: false,
      oldSurface: false,
      oldSurfaceHidden: false,
      replacementEntries: 1,
      replacementSurface: true,
    });

    await result.connection.close();
    expect(documentEntry(secondDom)).toBeNull();
    expect(nativeSurface(secondDom)?.hidden).toBe(false);
  });

  it('scopes CSP bypass to a dedicated renderer lease', async () => {
    const dom = compatibleDom();
    const leaseEvents: string[] = [];
    const renderer = new FixtureRenderer(
      dom,
      '26.820.60940',
      {
        projectPath: null,
        task: null,
        theme: 'system',
      },
      leaseEvents,
    );
    const result = await new CodexCdpHostAdapter({
      rendererSource: new FixtureRendererSource(renderer),
    }).attach({
      title: 'Codex Git',
      url: new URL('http://127.0.0.1:4173'),
    });

    expect(leaseEvents).toEqual(['acquire:renderer-fixture']);
    if (result.kind !== 'attached') {
      throw new Error('Expected the dedicated Codex renderer to attach');
    }

    await result.connection.close();
    expect(leaseEvents).toEqual([
      'acquire:renderer-fixture',
      'release:renderer-fixture',
    ]);
  });

  it('retries CSP restoration when connection close is called again', async () => {
    const dom = compatibleDom();
    const leaseEvents: string[] = [];
    const renderer = new FixtureRenderer(
      dom,
      '26.820.60940',
      { projectPath: null, task: null, theme: 'system' },
      leaseEvents,
    );
    renderer.failNextCspRelease();
    const result = await new CodexCdpHostAdapter({
      rendererSource: new FixtureRendererSource(renderer),
    }).attach({
      title: 'Codex Git',
      url: new URL('http://127.0.0.1:4173'),
    });
    if (result.kind !== 'attached') {
      throw new Error('Expected the dedicated Codex renderer to attach');
    }

    await expect(result.connection.close()).rejects.toThrow(
      'CSP restoration failed',
    );
    await expect(result.connection.close()).resolves.toBeUndefined();
    expect(leaseEvents).toEqual([
      'acquire:renderer-fixture',
      'release:renderer-fixture',
      'release:renderer-fixture',
    ]);
  });
});

class FixtureRendererSource implements CodexRendererSource {
  private readonly listeners = new Set<
    (renderer: CodexRenderer | null) => void
  >();

  constructor(private renderer: CodexRenderer | null) {}

  async current(): Promise<CodexRenderer | null> {
    return this.renderer;
  }

  publish(renderer: CodexRenderer | null): void {
    this.renderer = renderer;
    this.listeners.forEach((listener) => listener(renderer));
  }

  subscribe(listener: (renderer: CodexRenderer | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function compatibleDom(): JSDOM {
  return new JSDOM(`
    <div id="root">
      <aside id="app-shell-sidebar">
        <button data-native-entry type="button">Tasks</button>
      </aside>
      <main data-app-shell-main-surface="default">Native task</main>
    </div>
  `);
}

function documentEntry(dom: JSDOM): HTMLButtonElement | null {
  return dom.window.document.querySelector('[data-codex-git-sidebar-entry]');
}

function documentFrame(dom: JSDOM): HTMLIFrameElement | null {
  return dom.window.document.querySelector('[data-codex-git-surface] iframe');
}

function nativeSurface(dom: JSDOM): HTMLElement | null {
  return dom.window.document.querySelector(
    '[data-app-shell-main-surface="default"]',
  );
}

async function captureHostContext(
  dom: JSDOM,
  frame: HTMLIFrameElement | null,
): Promise<Record<string, unknown>> {
  if (frame?.contentWindow === null || frame?.contentWindow === undefined) {
    throw new Error('Expected the Git iframe to have a content window');
  }

  const message = new Promise<Record<string, unknown>>((resolve, reject) => {
    frame.contentWindow?.addEventListener(
      'message',
      (event) => {
        if (isRecord(event.data)) {
          resolve(event.data);
        } else {
          reject(new Error('Expected a typed Host Context message'));
        }
      },
      { once: true },
    );
  });
  frame.dispatchEvent(new dom.window.Event('load'));
  return message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function dispatchHostAction(
  dom: JSDOM,
  frame: HTMLIFrameElement | null,
  data: unknown,
): void {
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data,
      source: frame?.contentWindow ?? null,
    }),
  );
}

function captureNextFrameMessage(
  frame: HTMLIFrameElement | null,
): Promise<Record<string, unknown>> {
  if (frame?.contentWindow === null || frame?.contentWindow === undefined) {
    throw new Error('Expected the Git iframe to have a content window');
  }

  return new Promise((resolve, reject) => {
    frame.contentWindow?.addEventListener(
      'message',
      (event) => {
        if (isRecord(event.data)) {
          resolve(event.data);
        } else {
          reject(new Error('Expected a typed Host Context message'));
        }
      },
      { once: true },
    );
  });
}

function fixtureRenderer(dom: JSDOM, version: string): CodexRenderer {
  return new FixtureRenderer(dom, version, {
    projectPath: null,
    task: null,
    theme: 'system',
  });
}

class FixtureRenderer implements CodexRenderer {
  readonly document: Document;
  readonly id = 'renderer-fixture';
  readonly ownership = 'codex-git-dedicated' as const;
  readonly window: Window & typeof globalThis;
  private readonly listeners = new Set<(context: HostContext) => void>();
  private releaseFailures = 0;

  constructor(
    dom: JSDOM,
    readonly version: string,
    private context: HostContext,
    private readonly leaseEvents: string[] = [],
  ) {
    this.document = dom.window.document;
    this.window = dom.window as unknown as Window & typeof globalThis;
  }

  currentContext(): HostContext {
    return this.context;
  }

  publishContext(context: HostContext): void {
    this.context = context;
    this.listeners.forEach((listener) => listener(context));
  }

  failNextCspRelease(): void {
    this.releaseFailures++;
  }

  subscribeContext(listener: (context: HostContext) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async acquireCspBypass(): Promise<{ release(): Promise<void> }> {
    this.leaseEvents.push(`acquire:${this.id}`);
    return {
      release: async () => {
        this.leaseEvents.push(`release:${this.id}`);
        if (this.releaseFailures > 0) {
          this.releaseFailures--;
          throw new Error('CSP restoration failed');
        }
      },
    };
  }
}
