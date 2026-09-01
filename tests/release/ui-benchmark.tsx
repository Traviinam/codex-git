import { performance } from 'node:perf_hooks';

import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { App } from '../../apps/ui/src/overview.js';
import { createOverviewFixture } from '../../apps/ui/src/overview-fixtures.js';
import { createProtocolRepositorySource } from '../../apps/ui/src/protocol-repository-source.js';
import { createRepositoryStore } from '../../apps/ui/src/repository-store.js';
import { createSupportedScaleFixture } from './supported-scale-fixture.js';

export interface ReleaseUiMeasurements {
  readonly loadedInteraction: number;
  readonly selectedWorktreeRender: number;
  readonly shell: number;
}

export interface ProtocolReleaseUiMeasurements extends ReleaseUiMeasurements {
  readonly fullSnapshot: number;
  readonly externalChange: number;
}

export async function measureProtocolReleaseUi(options: {
  readonly externalDisplayPath: string;
  readonly mutateExternal: () => Promise<void>;
  readonly projectPath: string;
  readonly sessionUrl: URL;
  readonly surfaceUrl: URL;
}): Promise<ProtocolReleaseUiMeasurements> {
  await prepareProtocolReleaseSurface(options.surfaceUrl);
  const overallStartedAt = performance.now();

  return withBrowserDom(async () => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = false;
    let firstSnapshotDuration: number | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      headers.set('origin', options.surfaceUrl.origin);
      const startedAt = performance.now();
      const response = await fetch(input, { ...init, headers });
      if (!url.endsWith('/snapshot') || firstSnapshotDuration !== undefined) {
        return response;
      }
      const body = await response.arrayBuffer();
      firstSnapshotDuration = performance.now() - startedAt;
      return new Response(body, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    };
    const source = createProtocolRepositorySource({
      createEventSource: (url) =>
        new FetchEventSource(url, options.surfaceUrl.origin),
      fetch: fetcher,
      projectPath: options.projectPath,
      sessionUrl: options.sessionUrl.href,
    });
    const store = createRepositoryStore(source);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      flushSync(() => root.render(createElement(App, { store })));
      if (!container.textContent?.includes('Codex Git')) {
        throw new Error('The application shell did not become visible.');
      }
      const shell = performance.now() - overallStartedAt;

      await waitForCondition(
        () =>
          store.getSnapshot().source.kind === 'repository' &&
          container.querySelector('#worktree-title') !== null,
        'The selected Worktree did not become visible.',
      );
      const selectedWorktree = performance.now() - overallStartedAt;
      if (firstSnapshotDuration === undefined) {
        throw new Error('The production snapshot request was not measured.');
      }

      const target = container.querySelectorAll<HTMLButtonElement>(
        '[aria-label^="Select "]',
      )[23];
      if (target === undefined) throw new Error('Expected a Worktree target.');
      const targetName = target.querySelector('span')?.textContent;
      const interactionStartedAt = performance.now();
      flushSync(() => target.click());
      const loadedInteraction = performance.now() - interactionStartedAt;
      if (
        targetName === undefined ||
        container.querySelector('#worktree-title')?.textContent !== targetName
      ) {
        throw new Error('The selected Worktree interaction was not visible.');
      }

      const main = container.querySelector<HTMLButtonElement>(
        '[aria-label^="Select "]',
      );
      if (main === null) throw new Error('Expected the Main Worktree target.');
      flushSync(() => main.click());
      const externalStartedAt = performance.now();
      await options.mutateExternal();
      await waitForCondition(
        () =>
          container.textContent?.includes(options.externalDisplayPath) === true,
        'The external selected-Worktree change did not become visible.',
      );
      const externalChange = performance.now() - externalStartedAt;

      return {
        externalChange,
        fullSnapshot: firstSnapshotDuration,
        loadedInteraction,
        selectedWorktreeRender: selectedWorktree - shell,
        shell,
      };
    } finally {
      flushSync(() => root.unmount());
      store.dispose();
      container.remove();
    }
  });
}

export async function prepareProtocolReleaseSurface(
  surfaceUrl: URL,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const surface = await (await fetcher(surfaceUrl)).text();
  if (!surface.includes('src="/src/main.tsx"')) {
    throw new Error('The production Git Surface entry point was not served.');
  }
  const entry = await fetcher(new URL('/src/main.tsx', surfaceUrl));
  if (!entry.ok) {
    throw new Error('The production Git Surface entry point did not load.');
  }
  await entry.arrayBuffer();
}

export async function measureReleaseUi(): Promise<ReleaseUiMeasurements> {
  return withBrowserDom(async () => {
    const shell = await measureShell();
    const fixture = createSupportedScaleFixture();
    const store = createRepositoryStore(fixture.source);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    const selectedStartedAt = performance.now();
    await act(async () =>
      flushSync(() => root.render(createElement(App, { store }))),
    );
    const selectedWorktreeRender = performance.now() - selectedStartedAt;
    const target = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label^="Select "]',
    )[23];
    if (target === undefined) throw new Error('Expected a Worktree target.');
    const targetName = target.querySelector('span')?.textContent;

    const interactionStartedAt = performance.now();
    await act(async () => flushSync(() => target.click()));
    const loadedInteraction = performance.now() - interactionStartedAt;
    if (
      targetName === undefined ||
      container.querySelector('#worktree-title')?.textContent !== targetName
    ) {
      throw new Error('The selected Worktree did not become visible.');
    }

    await act(async () => flushSync(() => root.unmount()));
    store.dispose();
    container.remove();
    return { loadedInteraction, selectedWorktreeRender, shell };
  });
}

async function measureShell(): Promise<number> {
  const fixture = createOverviewFixture('loading');
  const store = createRepositoryStore(fixture.source);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const startedAt = performance.now();
  await act(async () =>
    flushSync(() => root.render(createElement(App, { store }))),
  );
  const duration = performance.now() - startedAt;
  if (!container.textContent?.includes('Codex Git')) {
    throw new Error('The application shell did not become visible.');
  }
  await act(async () => flushSync(() => root.unmount()));
  store.dispose();
  container.remove();
  return duration;
}

async function withBrowserDom<T>(run: () => Promise<T>): Promise<T> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const globals = [
    'document',
    'Event',
    'HTMLElement',
    'HTMLInputElement',
    'MouseEvent',
    'MessageEvent',
    'navigator',
    'Node',
    'window',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;
  const previous = new Map(
    globals.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const name of globals) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[name],
      writable: true,
    });
  }
  try {
    const result = await run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return result;
  } finally {
    for (const name of globals) {
      const descriptor = previous.get(name);
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, name);
      } else {
        Object.defineProperty(globalThis, name, descriptor);
      }
    }
    dom.window.close();
  }
}

class FetchEventSource {
  private readonly abort = new AbortController();
  private listener: ((event: MessageEvent<string>) => void) | undefined;

  constructor(url: string, origin: string) {
    void this.read(url, origin);
  }

  addEventListener(
    _type: 'invalidation',
    listener: (event: MessageEvent<string>) => void,
  ): void {
    this.listener = listener;
  }

  close(): void {
    this.abort.abort();
  }

  private async read(url: string, origin: string): Promise<void> {
    try {
      const response = await fetch(url, {
        headers: { origin },
        signal: this.abort.signal,
      });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error('SSE response body is absent.');
      const decoder = new TextDecoder();
      let buffer = '';
      while (!this.abort.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const type = frame.match(/^event: (.+)$/mu)?.[1];
          const data = frame.match(/^data: (.+)$/mu)?.[1];
          if (type === 'invalidation' && data !== undefined) {
            this.listener?.(new MessageEvent('invalidation', { data }));
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (!this.abort.signal.aborted) throw error;
    }
  }
}

async function waitForCondition(
  condition: () => boolean,
  message: string,
): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
