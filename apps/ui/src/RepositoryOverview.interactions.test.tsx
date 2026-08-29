// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './overview.js';
import { createOverviewFixture } from './overview-fixtures.js';
import { createRepositoryStore } from './repository-store.js';

describe('Repository overview interactions', () => {
  let container: HTMLDivElement;
  let root: Root;

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

  it('moves through the stable Worktree navigator with arrow keys', () => {
    const fixture = createOverviewFixture('many-worktrees');
    const store = createRepositoryStore(fixture.source);
    act(() => root.render(<App store={store} />));

    const main = button(
      'Select codex-git Worktree at /Users/leyoonafr/Projects/codex-git',
    );
    main.focus();
    act(() => {
      main.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }),
      );
    });

    const alpha = button(
      'Select agent-alpha Worktree at /private/tmp/codex-git-agent-alpha',
    );
    expect(document.activeElement).toBe(alpha);
    expect(container.querySelector('#worktree-title')?.textContent).toBe(
      'agent-alpha',
    );
    expect(alpha.tabIndex).toBe(0);
    expect(main.tabIndex).toBe(-1);
  });

  it('keeps filtered results keyboard reachable without replacing the selected detail', () => {
    const fixture = createOverviewFixture('many-worktrees');
    const store = createRepositoryStore(fixture.source);
    act(() => root.render(<App store={store} />));
    const search = container.querySelector('input[type="search"]');
    if (!(search instanceof HTMLInputElement))
      throw new Error('Missing search');

    setInput(search, 'agent-alpha');
    const alpha = button(
      'Select agent-alpha Worktree at /private/tmp/codex-git-agent-alpha',
    );
    expect(alpha.tabIndex).toBe(0);
    expect(container.querySelector('#worktree-title')?.textContent).toBe(
      'codex-git',
    );

    act(() => alpha.click());
    setInput(search, 'worktree-');
    const firstVisible = button(
      'Select worktree-04 Worktree at /private/tmp/codex-git-worktree-04',
    );
    expect(firstVisible.tabIndex).toBe(0);
    search.focus();

    const source = fixture.source.getSnapshot();
    if (source.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    act(() => {
      fixture.publish({
        kind: 'repository',
        snapshot: {
          ...source.snapshot,
          repositoryRevision: source.snapshot.repositoryRevision + 1,
          topologyRevision: source.snapshot.topologyRevision + 1,
          worktrees: source.snapshot.worktrees.filter(
            (worktree) => worktree.displayName !== 'agent-alpha',
          ),
        },
      });
    });

    expect(document.activeElement).toBe(firstVisible);
    expect(container.querySelector('#worktree-title')?.textContent).toBe(
      'codex-git',
    );

    search.focus();
    setInput(search, 'worktree-2');
    expect(document.activeElement).toBe(search);
  });

  it('recovers focus to detail when Worktree removal collapses the navigator', () => {
    const fixture = createOverviewFixture('unavailable-worktree');
    const store = createRepositoryStore(fixture.source);
    act(() => root.render(<App store={store} />));
    const missing = button(
      'Select missing-worktree Worktree at /private/tmp/missing-worktree',
    );
    act(() => missing.click());
    missing.focus();

    const source = fixture.source.getSnapshot();
    if (source.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    act(() => {
      fixture.publish({
        kind: 'repository',
        snapshot: {
          ...source.snapshot,
          repositoryRevision: source.snapshot.repositoryRevision + 1,
          topologyRevision: source.snapshot.topologyRevision + 1,
          worktrees: source.snapshot.worktrees.filter(
            (worktree) => worktree.displayName !== 'missing-worktree',
          ),
        },
      });
    });

    const detailTitle = container.querySelector('#worktree-title');
    expect(detailTitle?.textContent).toBe('codex-git');
    expect(document.activeElement).toBe(detailTitle);
  });

  it('recovers focus to the empty state when the final Worktree disappears', () => {
    const fixture = createOverviewFixture('one-worktree');
    const store = createRepositoryStore(fixture.source);
    act(() => root.render(<App store={store} />));
    const selectedTitle = container.querySelector('#worktree-title');
    if (!(selectedTitle instanceof HTMLHeadingElement))
      throw new Error('Missing selected Worktree title');
    selectedTitle.focus();

    const source = fixture.source.getSnapshot();
    if (source.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    act(() => {
      fixture.publish({
        kind: 'repository',
        snapshot: {
          ...source.snapshot,
          repositoryRevision: source.snapshot.repositoryRevision + 1,
          topologyRevision: source.snapshot.topologyRevision + 1,
          worktrees: [],
        },
      });
    });

    const emptyTitle = container.querySelector('#worktree-title');
    expect(emptyTitle?.textContent).toBe('No Worktrees available');
    expect(document.activeElement).toBe(emptyTitle);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'no longer available',
    );
  });

  it.each([
    [
      'loading',
      { kind: 'loading', message: 'Resolving another Current Project…' },
      'Codex Git',
    ],
    [
      'non-repository',
      {
        kind: 'non-repository',
        projectPath: '/Users/leyoonafr/Downloads/notes',
        message: 'The Current Project is not inside a Git Repository.',
      },
      'No Git Repository',
    ],
  ] as const)(
    'recovers focus when the Repository becomes %s',
    (_label, nextState, expectedTitle) => {
      const fixture = createOverviewFixture('one-worktree');
      const store = createRepositoryStore(fixture.source);
      act(() => root.render(<App store={store} />));
      const selectedTitle = container.querySelector('#worktree-title');
      if (!(selectedTitle instanceof HTMLHeadingElement))
        throw new Error('Missing selected Worktree title');
      selectedTitle.focus();

      act(() => fixture.publish(nextState));

      const fallbackTitle = container.querySelector('h1');
      expect(fallbackTitle?.textContent).toBe(expectedTitle);
      expect(document.activeElement).toBe(fallbackTitle);
      expect(container.textContent).toContain(
        'The selected Worktree is no longer available.',
      );
    },
  );

  it('preserves selection on harmless refresh and recovers focus when that generation disappears', () => {
    const fixture = createOverviewFixture('many-worktrees');
    const store = createRepositoryStore(fixture.source);
    act(() => root.render(<App store={store} />));

    const alphaName =
      'Select agent-alpha Worktree at /private/tmp/codex-git-agent-alpha';
    const alpha = button(alphaName);
    act(() => alpha.click());
    alpha.focus();

    const original = fixture.source.getSnapshot();
    if (original.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    act(() => {
      fixture.publish({
        kind: 'repository',
        snapshot: {
          ...original.snapshot,
          repositoryRevision: original.snapshot.repositoryRevision + 1,
          worktrees: original.snapshot.worktrees.map((worktree) =>
            worktree.displayName === 'agent-alpha'
              ? {
                  ...worktree,
                  status: {
                    kind: 'changed',
                    conflictCount: 0,
                    stagedCount: 0,
                    trackedChangeCount: 1,
                    untrackedCount: 0,
                  },
                }
              : worktree,
          ),
        },
      });
    });

    expect(container.querySelector('#worktree-title')?.textContent).toBe(
      'agent-alpha',
    );
    expect(document.activeElement).toBe(button(alphaName));

    const refreshed = fixture.source.getSnapshot();
    if (refreshed.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    act(() => {
      fixture.publish({
        kind: 'repository',
        snapshot: {
          ...refreshed.snapshot,
          repositoryRevision: refreshed.snapshot.repositoryRevision + 1,
          topologyRevision: refreshed.snapshot.topologyRevision + 1,
          worktrees: refreshed.snapshot.worktrees.filter(
            (worktree) => worktree.displayName !== 'agent-alpha',
          ),
        },
      });
    });

    const main = button(
      'Select codex-git Worktree at /Users/leyoonafr/Projects/codex-git',
    );
    expect(container.querySelector('#worktree-title')?.textContent).toBe(
      'codex-git',
    );
    expect(document.activeElement).toBe(main);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'codex-git is now selected',
    );
  });

  it('searches all documented Worktree fields and keeps Commit Drafts independent', () => {
    const fixture = createOverviewFixture('many-worktrees');
    const store = createRepositoryStore(fixture.source);
    act(() => root.render(<App store={store} />));

    const search = container.querySelector('input[type="search"]');
    if (!(search instanceof HTMLInputElement))
      throw new Error('Missing search');
    setInput(search, 'adaptive overview');
    expect(
      button('Select agent-beta Worktree at /private/tmp/codex-git-agent-beta')
        .textContent,
    ).toContain('agent-beta');
    expect(
      container.querySelector(
        'button[aria-label="Select agent-alpha Worktree at /private/tmp/codex-git-agent-alpha"]',
      ),
    ).toBeNull();

    setInput(search, 'feat/agent-alpha');
    const alpha = button(
      'Select agent-alpha Worktree at /private/tmp/codex-git-agent-alpha',
    );
    act(() => alpha.click());
    const draft = container.querySelector('textarea');
    if (!(draft instanceof HTMLTextAreaElement))
      throw new Error('Missing draft');
    setInput(draft, 'Keep this Worktree draft');

    setInput(search, 'agent-beta');
    act(() =>
      button(
        'Select agent-beta Worktree at /private/tmp/codex-git-agent-beta',
      ).click(),
    );
    expect(
      (container.querySelector('textarea') as HTMLTextAreaElement).value,
    ).toBe('');

    setInput(search, 'agent-alpha');
    act(() =>
      button(
        'Select agent-alpha Worktree at /private/tmp/codex-git-agent-alpha',
      ).click(),
    );
    expect(
      (container.querySelector('textarea') as HTMLTextAreaElement).value,
    ).toBe('Keep this Worktree draft');
  });

  it('routes explicit Refresh and Fetch entry points through the injected source', () => {
    const fixture = createOverviewFixture('many-worktrees');
    const store = createRepositoryStore(fixture.source);
    act(() => root.render(<App store={store} />));

    act(() => button('Refresh codex-git locally').click());
    act(() => button('Fetch origin for codex-git').click());
    act(() => button('Fetch all Remotes for codex-git').click());

    expect(fixture.requests.refresh).toBe(1);
    expect(fixture.requests.fetch).toHaveLength(2);
    expect(fixture.requests.fetch[1]).toBeNull();
  });

  it('announces a Branch change without stealing focus from the Commit Draft', () => {
    const fixture = createOverviewFixture('many-worktrees');
    const store = createRepositoryStore(fixture.source);
    act(() => root.render(<App store={store} />));
    act(() =>
      button(
        'Select agent-alpha Worktree at /private/tmp/codex-git-agent-alpha',
      ).click(),
    );
    const draft = container.querySelector('textarea');
    if (!(draft instanceof HTMLTextAreaElement))
      throw new Error('Missing draft');
    draft.focus();

    const state = fixture.source.getSnapshot();
    if (state.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    act(() => {
      fixture.publish({
        kind: 'repository',
        snapshot: {
          ...state.snapshot,
          repositoryRevision: state.snapshot.repositoryRevision + 1,
          worktrees: state.snapshot.worktrees.map((worktree) =>
            worktree.displayName === 'agent-alpha' &&
            worktree.head.kind === 'local_branch'
              ? {
                  ...worktree,
                  head: { ...worktree.head, displayName: 'feat/renamed-alpha' },
                }
              : worktree,
          ),
        },
      });
    });

    expect(document.activeElement).toBe(draft);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Branch or HEAD changed',
    );
  });

  it('does not dispose a caller-owned store when the overview unmounts', () => {
    const fixture = createOverviewFixture('one-worktree');
    const store = createRepositoryStore(fixture.source);
    const dispose = vi.spyOn(store, 'dispose');
    act(() => root.render(<App store={store} />));

    act(() => root.unmount());

    expect(dispose).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  function button(accessibleName: string): HTMLButtonElement {
    const element = container.querySelector(
      `button[aria-label="${accessibleName}"]`,
    );
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error(`Missing button: ${accessibleName}`);
    }
    return element;
  }

  function setInput(
    element: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
});
