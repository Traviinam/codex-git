// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  operationIdSchema,
  refIdSchema,
  worktreeIdSchema,
  worktreeGenerationSchema,
} from '@codex-git/protocol';

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

  it('preserves row and search focus across renewed unavailable identities', () => {
    const fixture = createOverviewFixture('unavailable-worktree');
    const store = createRepositoryStore(fixture.source);
    act(() => root.render(<App store={store} />));
    const missing = button(
      'Select missing-worktree Worktree at /private/tmp/missing-worktree',
    );
    act(() => missing.click());
    missing.focus();
    const source = fixture.source.getSnapshot();
    if (source.kind !== 'repository') throw new Error('Expected Repository');
    const renew = (digit: string) =>
      act(() =>
        fixture.publish({
          ...source,
          snapshot: {
            ...source.snapshot,
            worktrees: source.snapshot.worktrees.map((w) =>
              w.status.kind !== 'unavailable'
                ? w
                : {
                    ...w,
                    worktreeId: worktreeIdSchema.parse(
                      `worktree_${digit.repeat(32)}`,
                    ),
                    generation: worktreeGenerationSchema.parse(
                      `generation_${digit.repeat(32)}`,
                    ),
                  },
            ),
          },
        }),
      );
    renew('a');
    expect(document.activeElement).toBe(
      button(
        'Select missing-worktree Worktree at /private/tmp/missing-worktree',
      ),
    );
    act(() =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      ),
    );
    expect(store.getSnapshot().selectedWorktreeId).toBe(
      source.snapshot.worktrees[0]!.worktreeId,
    );
    act(() => missing.click());
    const search = container.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    search.focus();
    renew('b');
    expect(document.activeElement).toBe(search);
    expect(store.getSnapshot().selectedWorktreeId).toBe(
      worktreeIdSchema.parse(`worktree_${'b'.repeat(32)}`),
    );
  });

  it('confirms the exact Remote and same-name target before Publish', async () => {
    const fixture = createOverviewFixture('one-worktree');
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    fixture.publish({
      kind: 'repository',
      snapshot: {
        ...current.snapshot,
        worktrees: current.snapshot.worktrees.map((worktree) => ({
          ...worktree,
          upstream: {
            kind: 'unpublished' as const,
            remoteName: null,
            fetchedAt: null,
          },
        })),
      },
    });
    const requestRemoteOperation = vi.fn(async () => ({
      kind: 'succeeded' as const,
      operationId: operationIdSchema.parse(
        'operation_00000000000000000000000000000002',
      ),
      result: {
        kind: 'remote' as const,
        summary: 'Published main to origin.',
      },
    }));
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const store = createRepositoryStore({
      ...fixture.source,
      requestRemoteOperation,
    });
    act(() => root.render(<App store={store} />));

    await act(async () => button('Publish main to origin/main').click());

    expect(confirm).toHaveBeenCalledWith(
      'Publish Local Branch main to exact target origin/main?',
    );
    expect(requestRemoteOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'publish',
        remoteId: current.snapshot.remotes[0]!.remoteId,
      }),
    );
    expect(container.textContent).toContain('Published main to origin.');
  });

  it('routes a diverged Upstream to the exact selected Worktree Terminal target', async () => {
    const fixture = createOverviewFixture('one-worktree');
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    fixture.publish({
      kind: 'repository',
      snapshot: {
        ...current.snapshot,
        worktrees: current.snapshot.worktrees.map((worktree) => ({
          ...worktree,
          upstream:
            worktree.upstream.kind === 'tracking'
              ? { ...worktree.upstream, ahead: 1, behind: 1 }
              : worktree.upstream,
        })),
      },
    });
    const requestNativeAction = vi.fn(async () => ({
      kind: 'performed' as const,
    }));
    const store = createRepositoryStore({
      ...fixture.source,
      requestNativeAction,
    });
    act(() => root.render(<App store={store} />));

    expect(container.textContent).toContain(
      'Open the exact selected Worktree in Terminal to Merge or Rebase explicitly.',
    );
    await act(async () => button('Open codex-git in Terminal').click());

    expect(requestNativeAction).toHaveBeenCalledWith({
      kind: 'open_terminal',
      targetId: 'native_00000000000000000000000000000010',
    });
  });

  it('reviews Changed Files by group and navigates the current Worktree', async () => {
    const fixture = createOverviewFixture('changed-worktree');
    const store = createRepositoryStore(fixture.source);
    act(() => root.render(<App store={store} />));

    expect(container.textContent).toContain('Staged Changes');
    expect(container.textContent).toContain('Changes');
    expect(container.textContent).toContain('Untracked Files');
    const staged = button('Review staged README.md');
    await act(async () => staged.click());

    expect(fixture.requests.diff).toEqual([
      'file_00000000000000000000000000000001',
    ]);
    expect(container.textContent).toContain('Side-by-side');
    expect(container.textContent).toContain('new staged line');

    expect(button('Next Changed File').disabled).toBe(true);
    await act(async () => button('Review changed src/app.ts').click());
    await act(async () => button('Next Changed File').click());
    expect(fixture.requests.diff).toEqual([
      'file_00000000000000000000000000000001',
      'file_00000000000000000000000000000002',
      'file_00000000000000000000000000000003',
    ]);
    expect(container.textContent).toContain('src/utils.ts');

    act(() => button('Show unified diff').click());
    expect(container.textContent).toContain('Unified');
  });

  it('offers file and group Stage and Unstage actions', async () => {
    const fixture = createOverviewFixture('changed-worktree');
    const mutations: unknown[] = [];
    const store = createRepositoryStore({
      ...fixture.source,
      async mutateFiles(request: unknown) {
        mutations.push(request);
        return {
          kind: 'succeeded' as const,
          operationId: operationIdSchema.parse(
            'operation_00000000000000000000000000000002',
          ),
          result: { kind: 'files' as const, affectedCount: 2 },
        };
      },
    });
    act(() => root.render(<App store={store} />));

    expect(button('Unstage README.md')).toBeDefined();
    expect(button('Stage src/app.ts')).toBeDefined();
    expect(button('Stage notes.txt')).toBeDefined();
    expect(button('Unstage all Staged Changes')).toBeDefined();
    expect(button('Stage all Changes')).toBeDefined();
    expect(button('Stage all Untracked Files')).toBeDefined();

    await act(async () => button('Stage all Changes').click());

    const source = fixture.source.getSnapshot();
    if (source.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = source.snapshot.worktrees[0]!;
    expect(mutations).toEqual([
      {
        kind: 'stage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: worktree.changes
          .filter(({ kind }) => kind === 'change')
          .map(({ fileId }) => fileId),
      },
    ]);
  });

  it('shows truthful metadata when Diff content cannot be rendered', async () => {
    const fixture = createOverviewFixture('changed-worktree');
    const store = createRepositoryStore({
      ...fixture.source,
      async requestDiff(fileId) {
        return {
          kind: 'binary',
          fileId,
          baseline: 'head_to_index',
          byteCount: 4096,
        };
      },
      async requestNativeAction(request) {
        return request.kind === 'copy_relative_path'
          ? { kind: 'copy_text', text: 'README.md' }
          : { kind: 'performed' };
      },
    });
    act(() => root.render(<App store={store} />));

    await act(async () => button('Review staged README.md').click());

    expect(container.textContent).toContain('Binary file · 4,096 bytes');
    expect(container.querySelector('pre')).toBeNull();
    expect(button('Open in Default App')).toBeDefined();
    expect(button('Reveal in Finder')).toBeDefined();
    expect(button('Copy Absolute Path')).toBeDefined();
    await act(async () => button('Copy Relative Path').click());
    expect(container.textContent).toContain('Relative path: README.md');
  });

  it('reports exact Worktree copy results and safe navigation fallback', async () => {
    const fixture = createOverviewFixture('one-worktree');
    const store = createRepositoryStore({
      ...fixture.source,
      async requestNativeAction(request) {
        return request.kind === 'copy_absolute_path'
          ? {
              kind: 'copy_text',
              text: '/Users/leyoonafr/Projects/codex-git',
            }
          : {
              kind: 'unavailable',
              message:
                'The exact target is no longer available. Refresh or use a safe copy action.',
            };
      },
    });
    act(() => root.render(<App store={store} />));

    await act(async () => button('Copy Absolute Path for codex-git').click());
    expect(container.textContent).toContain(
      'Value: /Users/leyoonafr/Projects/codex-git',
    );

    await act(async () => button('Reveal codex-git in Finder').click());
    expect(container.textContent).toContain(
      'The exact target is no longer available. Refresh or use a safe copy action.',
    );
  });

  it('shows Conflict index stages in the default side-by-side review', async () => {
    const fixture = createOverviewFixture('changed-worktree');
    const store = createRepositoryStore({
      ...fixture.source,
      async requestDiff(fileId) {
        return {
          kind: 'text',
          fileId,
          baseline: 'conflict',
          content:
            'Conflict index stages: base=present; ours=present; theirs=present.\n@@ -0,0 +1 @@\n+<<<<<<< HEAD\n',
          lineCount: 3,
        };
      },
    });
    act(() => root.render(<App store={store} />));

    await act(async () => button('Review staged README.md').click());

    expect(
      container.querySelector('[aria-label="Conflict Index Stages"]')
        ?.textContent,
    ).toBe(
      'Conflict index stages: base=present; ours=present; theirs=present.',
    );
    expect(container.textContent).toContain('<<<<<<< HEAD');
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

  it('separates Branch groups, disables occupied Local Branches, and navigates to their Worktree', async () => {
    const fixture = createOverviewFixture('many-worktrees');
    const fixtureState = fixture.source.getSnapshot();
    const occupiedWorktree =
      fixtureState.kind === 'repository'
        ? fixtureState.snapshot.worktrees.find(
            ({ displayName }) => displayName === 'agent-alpha',
          )
        : undefined;
    if (occupiedWorktree === undefined) throw new Error('Missing Worktree');
    const source = {
      ...fixture.source,
      async searchBranches() {
        return {
          refsRevision: 2,
          candidates: [
            {
              refId: refIdSchema.parse('ref_0123456789abcdef0123456789abcdef'),
              kind: 'local' as const,
              displayName: 'available',
              occupiedBy: null,
            },
            {
              refId: refIdSchema.parse('ref_1123456789abcdef0123456789abcdef'),
              kind: 'local' as const,
              displayName: 'feat/agent-alpha',
              occupiedBy: occupiedWorktree.worktreeId,
            },
            {
              refId: refIdSchema.parse('ref_2123456789abcdef0123456789abcdef'),
              kind: 'remote_tracking' as const,
              displayName: 'origin/review-ready',
              occupiedBy: null,
            },
          ],
        };
      },
    };
    const store = createRepositoryStore(source);
    act(() => root.render(<App store={store} />));

    await act(async () => button('Switch Branch for codex-git').click());

    expect(container.textContent).toContain('Local Branches');
    expect(container.textContent).toContain('Remote-tracking Branches');
    expect(button('Switch codex-git to feat/agent-alpha').disabled).toBe(true);
    act(() => button('Go to Worktree occupying feat/agent-alpha').click());
    expect(container.querySelector('#worktree-title')?.textContent).toBe(
      'agent-alpha',
    );
  });

  it('submits an exact Branch target and clears the picker after reconciled success', async () => {
    const fixture = createOverviewFixture('one-worktree');
    const targetRefId = refIdSchema.parse(
      'ref_3123456789abcdef0123456789abcdef',
    );
    const switchBranch = vi.fn(async () => {
      const current = fixture.source.getSnapshot();
      if (current.kind !== 'repository') throw new Error('Expected Repository');
      fixture.publish({
        kind: 'repository',
        snapshot: {
          ...current.snapshot,
          repositoryRevision: current.snapshot.repositoryRevision + 1,
          refsRevision: current.snapshot.refsRevision + 1,
          worktrees: current.snapshot.worktrees.map((worktree) => ({
            ...worktree,
            worktreeRevision: worktree.worktreeRevision + 1,
            head: {
              kind: 'local_branch' as const,
              displayName: 'review-ready',
              objectId: '1123456789abcdef0123456789abcdef01234567',
            },
          })),
        },
      });
      return {
        kind: 'succeeded' as const,
        operationId: operationIdSchema.parse(
          'operation_0123456789abcdef0123456789abcdef',
        ),
        result: {
          kind: 'branch_switch' as const,
          displayName: 'review-ready',
        },
      };
    });
    const source = {
      ...fixture.source,
      async searchBranches() {
        return {
          refsRevision: 1,
          candidates: [
            {
              refId: targetRefId,
              kind: 'local' as const,
              displayName: 'review-ready',
              occupiedBy: null,
            },
          ],
        };
      },
      switchBranch,
    };
    const store = createRepositoryStore(source);
    act(() => root.render(<App store={store} />));
    await act(async () => button('Switch Branch for codex-git').click());

    await act(async () => button('Switch codex-git to review-ready').click());

    expect(switchBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRefsRevision: 1,
        expectedWorktreeRevision: 1,
        refId: targetRefId,
      }),
    );
    expect(container.querySelector('#worktree-title')?.textContent).toBe(
      'codex-git',
    );
    expect(container.textContent).toContain('Local Branch review-ready');
    expect(container.textContent).not.toContain('Search cached Branches');
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

  it('shows the exact Commit target and submits a synchronized multiline draft', async () => {
    const fixture = createOverviewFixture('changed-worktree');
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = current.snapshot.worktrees[0]!;
    const updateCommitDraft = vi.fn(
      async (
        request: Parameters<typeof fixture.source.updateCommitDraft>[0],
      ) => ({
        worktreeId: request.worktreeId,
        revision: request.expectedRevision + 1,
        text: request.update.kind === 'set' ? request.update.text : '',
      }),
    );
    const commit = vi.fn(async () => ({
      kind: 'succeeded' as const,
      operationId: operationIdSchema.parse(
        'operation_00000000000000000000000000000003',
      ),
      result: {
        kind: 'commit' as const,
        shortObjectId: 'abcdef1',
        summary: 'Commit title',
      },
    }));
    const store = createRepositoryStore({
      ...fixture.source,
      updateCommitDraft,
      commit,
    });
    act(() => root.render(<App store={store} />));

    expect(container.textContent).toContain(worktree.path);
    expect(container.textContent).toContain('Local Branch main');
    expect(container.textContent).toContain('1 staged change');
    const submit = button('Commit staged changes in codex-git');
    expect(submit.disabled).toBe(true);
    const draft = container.querySelector('textarea');
    if (!(draft instanceof HTMLTextAreaElement)) {
      throw new Error('Missing Commit Draft');
    }
    setInput(draft, 'Commit title\n\nCommit body');
    expect(submit.disabled).toBe(false);

    await act(async () => submit.click());

    expect(updateCommitDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: worktree.worktreeId,
        update: { kind: 'set', text: 'Commit title\n\nCommit body' },
      }),
    );
    expect(commit).toHaveBeenCalledWith(
      {
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: 1,
        confirmDetachedHead: false,
      },
      expect.any(Function),
    );
    expect(draft.value).toBe('');
    expect(container.textContent).toContain('Committed abcdef1: Commit title');
  });

  it('explicitly clears only the selected Worktree Commit Draft', async () => {
    const fixture = createOverviewFixture('many-worktrees');
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    const main = current.snapshot.worktrees.find(({ role }) => role === 'main');
    const linked = current.snapshot.worktrees.find(
      ({ role }) => role === 'linked',
    );
    if (main === undefined || linked === undefined) {
      throw new Error('Expected Main and Linked Worktrees');
    }
    const store = createRepositoryStore(fixture.source);
    act(() => root.render(<App store={store} />));
    const mainDraft = container.querySelector('textarea');
    if (!(mainDraft instanceof HTMLTextAreaElement)) {
      throw new Error('Missing Main Commit Draft');
    }
    setInput(mainDraft, 'Clear this draft');
    act(() =>
      button(`Select ${linked.displayName} Worktree at ${linked.path}`).click(),
    );
    const linkedDraft = container.querySelector('textarea');
    if (!(linkedDraft instanceof HTMLTextAreaElement)) {
      throw new Error('Missing Linked Commit Draft');
    }
    setInput(linkedDraft, 'Keep this draft');
    act(() =>
      button(`Select ${main.displayName} Worktree at ${main.path}`).click(),
    );

    act(() => button(`Clear Commit Draft for ${main.displayName}`).click());

    expect(
      (container.querySelector('textarea') as HTMLTextAreaElement).value,
    ).toBe('');
    act(() =>
      button(`Select ${linked.displayName} Worktree at ${linked.path}`).click(),
    );
    expect(
      (container.querySelector('textarea') as HTMLTextAreaElement).value,
    ).toBe('Keep this draft');
  });

  it('does not reuse Detached HEAD confirmation across Worktrees at the same OID', () => {
    const fixture = createOverviewFixture('many-worktrees');
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    const main = current.snapshot.worktrees.find(({ role }) => role === 'main');
    const linked = current.snapshot.worktrees.find(
      ({ role }) => role === 'linked',
    );
    if (main === undefined || linked === undefined) {
      throw new Error('Expected Main and Linked Worktrees');
    }
    const sharedObjectId = 'a'.repeat(40);
    fixture.publish({
      kind: 'repository',
      snapshot: {
        ...current.snapshot,
        worktrees: current.snapshot.worktrees.map((worktree) =>
          worktree.worktreeId === main.worktreeId ||
          worktree.worktreeId === linked.worktreeId
            ? {
                ...worktree,
                head: { kind: 'detached' as const, objectId: sharedObjectId },
                status: {
                  kind: 'changed' as const,
                  conflictCount: 0,
                  stagedCount: 1,
                  trackedChangeCount: 0,
                  untrackedCount: 0,
                },
              }
            : worktree,
        ),
      },
    });
    const store = createRepositoryStore(fixture.source);
    act(() => root.render(<App store={store} />));
    const confirmation = container.querySelector('input[type="checkbox"]');
    if (!(confirmation instanceof HTMLInputElement)) {
      throw new Error('Missing Detached HEAD confirmation');
    }

    act(() => confirmation.click());
    expect(confirmation.checked).toBe(true);
    act(() =>
      button(`Select ${linked.displayName} Worktree at ${linked.path}`).click(),
    );

    const linkedConfirmation = container.querySelector(
      'input[type="checkbox"]',
    );
    expect(linkedConfirmation).toBeInstanceOf(HTMLInputElement);
    expect((linkedConfirmation as HTMLInputElement).checked).toBe(false);
  });

  it('allows a second Worktree Commit while the first Worktree Commit is running', async () => {
    const fixture = createOverviewFixture('many-worktrees');
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    const main = current.snapshot.worktrees.find(({ role }) => role === 'main');
    const linked = current.snapshot.worktrees.find(
      ({ role }) => role === 'linked',
    );
    if (main === undefined || linked === undefined) {
      throw new Error('Expected Main and Linked Worktrees');
    }
    fixture.publish({
      kind: 'repository',
      snapshot: {
        ...current.snapshot,
        worktrees: current.snapshot.worktrees.map((worktree) => ({
          ...worktree,
          status: {
            kind: 'changed' as const,
            conflictCount: 0,
            stagedCount: 1,
            trackedChangeCount: 0,
            untrackedCount: 0,
          },
        })),
      },
    });
    const commit = vi.fn(
      (request: Parameters<typeof fixture.source.commit>[0]) => {
        void request;
        return new Promise<never>(() => undefined);
      },
    );
    const store = createRepositoryStore({ ...fixture.source, commit });
    act(() => root.render(<App store={store} />));
    const mainDraft = container.querySelector('textarea');
    if (!(mainDraft instanceof HTMLTextAreaElement)) {
      throw new Error('Missing Main Commit Draft');
    }
    setInput(mainDraft, 'Main running Commit');
    await act(async () =>
      button(`Commit staged changes in ${main.displayName}`).click(),
    );
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));

    act(() =>
      button(`Select ${linked.displayName} Worktree at ${linked.path}`).click(),
    );
    const linkedDraft = container.querySelector('textarea');
    if (!(linkedDraft instanceof HTMLTextAreaElement)) {
      throw new Error('Missing Linked Commit Draft');
    }
    setInput(linkedDraft, 'Linked concurrent Commit');
    const linkedSubmit = button(
      `Commit staged changes in ${linked.displayName}`,
    );
    expect(linkedSubmit.disabled).toBe(false);
    await act(async () => linkedSubmit.click());

    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    expect(commit.mock.calls.map(([request]) => request.worktreeId)).toEqual([
      main.worktreeId,
      linked.worktreeId,
    ]);
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
