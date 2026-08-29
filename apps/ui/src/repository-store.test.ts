import { describe, expect, it, vi } from 'vitest';

import { createOverviewFixture } from './overview-fixtures.js';
import type { RepositoryOverviewSource } from './repository-overview-model.js';
import { createRepositoryStore } from './repository-store.js';

describe('RepositoryStore lifecycle', () => {
  it('disposes its source subscription exactly once and ignores abandoned updates', () => {
    const fixture = createOverviewFixture('one-worktree');
    const unsubscribe = vi.fn();
    let sourceListener: (() => void) | undefined;
    const source: RepositoryOverviewSource = {
      ...fixture.source,
      subscribe(listener) {
        sourceListener = listener;
        const stopFixtureSubscription = fixture.source.subscribe(listener);
        return () => {
          unsubscribe();
          stopFixtureSubscription();
        };
      },
    };
    const store = createRepositoryStore(source);
    const initial = store.getSnapshot();
    if (initial.source.kind !== 'repository')
      throw new Error('Expected Repository fixture');

    store.dispose();
    store.dispose();
    const next = fixture.source.getSnapshot();
    if (next.kind !== 'repository')
      throw new Error('Expected Repository fixture');
    fixture.publish({
      kind: 'repository',
      snapshot: {
        ...next.snapshot,
        repositoryRevision: next.snapshot.repositoryRevision + 1,
      },
    });
    sourceListener?.();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    const abandoned = store.getSnapshot();
    expect(abandoned.source.kind).toBe('repository');
    if (abandoned.source.kind === 'repository') {
      expect(abandoned.source.snapshot.repositoryRevision).toBe(
        initial.source.snapshot.repositoryRevision,
      );
    }
  });
});
