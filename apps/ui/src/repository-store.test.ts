import { describe, expect, it, vi } from 'vitest';

import { createOverviewFixture } from './overview-fixtures.js';
import type { RepositoryOverviewSource } from './repository-overview-model.js';
import { createRepositoryStore } from './repository-store.js';

describe('RepositoryStore lifecycle', () => {
  it('ignores a late Diff after a newer file is selected', async () => {
    const fixture = createOverviewFixture('changed-worktree');
    const pending = new Map<string, (value: never) => void>();
    const source: RepositoryOverviewSource = {
      ...fixture.source,
      requestDiff(fileId) {
        return new Promise((resolve) => pending.set(fileId, resolve));
      },
    };
    const store = createRepositoryStore(source);
    const current = source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    const [first, second] = current.snapshot.worktrees[0]!.changes;

    store.selectFile(first!.fileId);
    store.selectFile(second!.fileId);
    pending.get(first!.fileId)?.({
      kind: 'binary',
      fileId: first!.fileId,
      baseline: first!.baseline,
      byteCount: 12,
    } as never);
    await Promise.resolve();

    expect(store.getSnapshot().selectedFileId).toBe(second!.fileId);
    expect(store.getSnapshot().diff).toEqual({
      kind: 'loading',
      fileId: second!.fileId,
    });
  });

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
