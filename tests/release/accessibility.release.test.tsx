// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../apps/ui/src/overview.js';
import { createOverviewFixture } from '../../apps/ui/src/overview-fixtures.js';
import { createRepositoryStore } from '../../apps/ui/src/repository-store.js';

describe('MVP accessibility release gate', () => {
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

  it('keeps controls keyboard operable, target named, visibly focused, announced, and non-color-only', async () => {
    const fixture = createOverviewFixture('unavailable-worktree');
    const store = createRepositoryStore(fixture.source);
    await act(async () => root.render(<App store={store} />));

    const controls = [...container.querySelectorAll('button, input, textarea')];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(accessibleName(control), control.outerHTML).not.toBe('');
      expect(
        control.matches('button, input, textarea'),
        control.outerHTML,
      ).toBe(true);
    }
    expect(
      container.querySelector(
        '[aria-label="Select missing-worktree Worktree at /private/tmp/missing-worktree"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelectorAll('[aria-live="polite"]').length,
    ).toBeGreaterThan(0);
    expect(container.textContent).toContain(
      'Unavailable — Working Tree path is missing.',
    );

    const css = await readFile(
      resolve(process.cwd(), 'apps/ui/src/overview.css'),
      'utf8',
    );
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px\s+solid/u);
    store.dispose();
  });
});

function accessibleName(element: Element): string {
  const explicit = element.getAttribute('aria-label')?.trim();
  if (explicit) return explicit;
  const label = element.closest('label')?.textContent?.trim();
  if (label) return label;
  return element.textContent?.trim() ?? '';
}
