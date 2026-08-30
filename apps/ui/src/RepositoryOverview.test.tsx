import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fileIdSchema, operationIdSchema } from '@codex-git/protocol';

import { App } from './overview.js';
import { createOverviewFixture } from './overview-fixtures.js';
import { createRepositoryStore } from './repository-store.js';

describe('Repository overview', () => {
  it('opens one clean Main Worktree directly into useful Repository state', () => {
    const fixture = createOverviewFixture('one-worktree');
    const store = createRepositoryStore(fixture.source);

    const markup = renderToStaticMarkup(<App store={store} />);

    expect(markup).toContain('codex-git');
    expect(markup).toContain('/Users/leyoonafr/Projects/codex-git');
    expect(markup).toContain('Main Worktree');
    expect(markup).toContain('Local Branch main');
    expect(markup).toContain('<dt>Upstream</dt><dd>origin/main');
    expect(markup).toContain('<dt>Upstream freshness</dt>');
    expect(markup).toContain('Cached from Fetch Aug 29, 2026, 2:03 PM');
    expect(markup).toContain('Clean');
    expect(markup).toContain('Refresh codex-git locally');
    expect(markup).toContain('Fetch origin for codex-git');
    expect(markup).not.toContain('Search Worktrees');
  });

  it('keeps Main first and the remaining Worktrees stable when status changes', () => {
    const fixture = createOverviewFixture('many-worktrees');
    const store = createRepositoryStore(fixture.source);

    const initialMarkup = renderToStaticMarkup(<App store={store} />);
    const mainPosition = initialMarkup.indexOf('codex-git</span>');
    const alphaPosition = initialMarkup.indexOf('agent-alpha</span>');
    const betaPosition = initialMarkup.indexOf('agent-beta</span>');

    expect(initialMarkup).toContain('Search Worktrees');
    expect(mainPosition).toBeGreaterThan(-1);
    expect(alphaPosition).toBeGreaterThan(mainPosition);
    expect(betaPosition).toBeGreaterThan(alphaPosition);

    const state = fixture.source.getSnapshot();
    if (state.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    fixture.publish({
      kind: 'repository',
      snapshot: {
        ...state.snapshot,
        repositoryRevision: state.snapshot.repositoryRevision + 1,
        worktrees: state.snapshot.worktrees.map((worktree) =>
          worktree.displayName === 'agent-beta'
            ? { ...worktree, status: { kind: 'clean' } }
            : worktree,
        ),
      },
    });

    const refreshedMarkup = renderToStaticMarkup(<App store={store} />);
    expect(refreshedMarkup.indexOf('agent-alpha</span>')).toBeLessThan(
      refreshedMarkup.indexOf('agent-beta</span>'),
    );
  });

  it('keeps stale data visible and explains an unavailable Worktree without enabling actions', () => {
    const fixture = createOverviewFixture('unavailable-worktree');
    const store = createRepositoryStore(fixture.source);
    const source = fixture.source.getSnapshot();
    if (source.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    const unavailable = source.snapshot.worktrees.find(
      (worktree) => worktree.status.kind === 'unavailable',
    );
    if (unavailable === undefined)
      throw new Error('Missing unavailable Worktree');
    store.selectWorktree(unavailable.worktreeId);

    const markup = renderToStaticMarkup(<App store={store} />);

    expect(markup).toContain('<dt>Unavailable</dt><dd>1</dd>');
    expect(markup).toContain(
      'Refresh failed — The Working Tree scan timed out.',
    );
    expect(markup).toContain(
      'Fetch failed — Aug 29, 2026, 1:40 PM. Network offline.',
    );
    expect(markup).toContain('Fetch running · 40%');
    expect(markup).toContain('Unavailable — Working Tree path is missing.');
    expect(markup).toContain(
      'Worktree observation</dt><dd>Stale — Last successful observation retained.',
    );
    expect(markup).toContain('aria-label="Switch Branch for missing-worktree"');
    expect(markup).toContain('disabled=""');
  });

  it('renders loading and non-repository states without inventing Git state', () => {
    const loading = createRepositoryStore(
      createOverviewFixture('loading').source,
    );
    const nonRepository = createRepositoryStore(
      createOverviewFixture('non-repository').source,
    );

    expect(renderToStaticMarkup(<App store={loading} />)).toContain(
      'Resolving the Current Project…',
    );
    const emptyMarkup = renderToStaticMarkup(<App store={nonRepository} />);
    expect(emptyMarkup).toContain('No Git Repository');
    expect(emptyMarkup).toContain('/Users/leyoonafr/Downloads/notes');
    expect(emptyMarkup).not.toContain('Fetch');
  });

  it('disables Fetch entry points when the runtime has no Fetch capability', () => {
    const fixture = createOverviewFixture('one-worktree');
    const source = fixture.source.getSnapshot();
    if (source.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    fixture.publish({
      kind: 'repository',
      snapshot: { ...source.snapshot, fetchAvailable: false },
    });

    const markup = renderToStaticMarkup(
      <App store={createRepositoryStore(fixture.source)} />,
    );

    expect(markup).toContain(
      'Fetch actions are not available in this version.',
    );
    expect(markup).toMatch(
      /aria-label="Fetch origin for codex-git"[^>]*disabled=""/u,
    );
  });

  it('lists every Remote result after a Partial Success Fetch-all', () => {
    const fixture = createOverviewFixture('one-worktree');
    const source = fixture.source.getSnapshot();
    if (source.kind !== 'repository') {
      throw new Error('Expected Repository fixture');
    }
    fixture.publish({
      kind: 'repository',
      snapshot: {
        ...source.snapshot,
        fetchResult: {
          kind: 'partial_success',
          operationId: operationIdSchema.parse(
            'operation_00000000000000000000000000000001',
          ),
          message: 'Some Remotes were fetched.',
          effects: [
            { kind: 'succeeded', label: 'origin' },
            {
              kind: 'failed_known',
              label: 'backup',
              code: 'offline',
              message: 'The Remote could not be reached.',
            },
          ],
        },
      },
    });

    const markup = renderToStaticMarkup(
      <App store={createRepositoryStore(fixture.source)} />,
    );

    expect(markup).toContain('Fetch-all result');
    expect(markup).toContain('origin — Succeeded');
    expect(markup).toContain(
      'backup — Failed: The Remote could not be reached.',
    );
  });

  it('counts Worktree availability independently from status freshness', () => {
    const fixture = createOverviewFixture('one-worktree');
    const source = fixture.source.getSnapshot();
    if (source.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    fixture.publish({
      kind: 'repository',
      snapshot: {
        ...source.snapshot,
        worktrees: source.snapshot.worktrees.map((worktree) => ({
          ...worktree,
          availability: { kind: 'available' },
          status: {
            kind: 'unavailable',
            reason: 'Status observation failed.',
          },
        })),
      },
    });

    const markup = renderToStaticMarkup(
      <App store={createRepositoryStore(fixture.source)} />,
    );

    expect(markup).toContain('<dt>Available</dt><dd>1</dd>');
    expect(markup).toContain('<dt>Unavailable</dt><dd>0</dd>');
  });

  it('clears a stale file selection when the selected Branch changes', () => {
    const fixture = createOverviewFixture('one-worktree');
    const store = createRepositoryStore(fixture.source);
    const fileId = fileIdSchema.parse('file_00000000000000000000000000000001');
    store.selectFile(fileId);
    const state = fixture.source.getSnapshot();
    if (state.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    fixture.publish({
      kind: 'repository',
      snapshot: {
        ...state.snapshot,
        repositoryRevision: state.snapshot.repositoryRevision + 1,
        worktrees: state.snapshot.worktrees.map((worktree) => ({
          ...worktree,
          head:
            worktree.head.kind === 'local_branch'
              ? { ...worktree.head, displayName: 'dev' }
              : worktree.head,
        })),
      },
    });

    expect(store.getSnapshot().selectedFileId).toBeNull();
    expect(store.getSnapshot().selectionNotice).toContain(
      'Branch or HEAD changed',
    );
  });

  it('retains file selection when the selected Local Branch advances', () => {
    const fixture = createOverviewFixture('one-worktree');
    const store = createRepositoryStore(fixture.source);
    const fileId = fileIdSchema.parse('file_00000000000000000000000000000002');
    store.selectFile(fileId);
    const state = fixture.source.getSnapshot();
    if (state.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    fixture.publish({
      kind: 'repository',
      snapshot: {
        ...state.snapshot,
        repositoryRevision: state.snapshot.repositoryRevision + 1,
        worktrees: state.snapshot.worktrees.map((worktree) => ({
          ...worktree,
          head:
            worktree.head.kind === 'local_branch'
              ? {
                  ...worktree.head,
                  objectId: 'abcdef0123456789abcdef0123456789abcdef01',
                }
              : worktree.head,
        })),
      },
    });

    expect(store.getSnapshot().selectedFileId).toBe(fileId);
    expect(store.getSnapshot().selectionNotice).toBeNull();
  });

  it('shows a Worktree transition with truthful progress in navigator and detail', () => {
    const fixture = createOverviewFixture('many-worktrees');
    const source = fixture.source.getSnapshot();
    if (source.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    fixture.publish({
      kind: 'repository',
      snapshot: {
        ...source.snapshot,
        worktrees: source.snapshot.worktrees.map((worktree) =>
          worktree.displayName === 'agent-beta'
            ? {
                ...worktree,
                transition: { label: 'Switching Branch', progress: 0.5 },
              }
            : worktree,
        ),
      },
    });
    const store = createRepositoryStore(fixture.source);
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    const transitioning = current.snapshot.worktrees.find(
      (worktree) => worktree.displayName === 'agent-beta',
    );
    if (transitioning === undefined)
      throw new Error('Missing transitioning Worktree');
    store.selectWorktree(transitioning.worktreeId);

    const markup = renderToStaticMarkup(<App store={store} />);

    expect(markup).toContain('<small>Switching Branch · 50%</small>');
    expect(markup).not.toContain(
      '<small aria-live="polite">Switching Branch · 50%</small>',
    );
    expect(markup).toContain(
      '<dt>Transition</dt><dd aria-live="polite">Switching Branch · 50%</dd>',
    );
  });
});
