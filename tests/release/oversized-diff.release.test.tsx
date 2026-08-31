// @vitest-environment jsdom

import { performance } from 'node:perf_hooks';

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../apps/ui/src/overview.js';
import { createRepositoryStore } from '../../apps/ui/src/repository-store.js';
import { createSupportedScaleFixture } from './supported-scale-fixture.js';

describe('oversized Diff release envelope', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('degrades a 2 MiB and 20,001-line Diff without freezing the loaded UI', async () => {
    const fixture = createSupportedScaleFixture();
    const store = createRepositoryStore(fixture.source);
    await act(async () => root.render(<App store={store} />));
    const review = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Review staged"]',
    );
    if (review === null)
      throw new Error('Expected a Changed File review action');

    const startedAt = performance.now();
    await act(async () => review.click());
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(elapsedMilliseconds).toBeLessThanOrEqual(100);
    expect(container.textContent).toContain(
      'Diff is too large to display · 2,097,153 bytes · 20001 lines',
    );
    expect(container.querySelector('pre')).toBeNull();
    store.dispose();
  });
});
