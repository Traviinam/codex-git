import {
  fileIdSchema,
  operationIdSchema,
  worktreeIdSchema,
  worktreeGenerationSchema,
} from '@codex-git/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createOverviewFixture } from './overview-fixtures.js';
import type { RepositoryOverviewSource } from './repository-overview-model.js';
import { createRepositoryStore } from './repository-store.js';

describe('RepositoryStore lifecycle', () => {
  it('keeps inspecting an unavailable path across renewed opaque identities', () => {
    const fixture = createOverviewFixture('unavailable-worktree');
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    const missing = current.snapshot.worktrees.find(
      (w) => w.status.kind === 'unavailable',
    )!;
    const store = createRepositoryStore(fixture.source);
    store.selectWorktree(missing.worktreeId);
    const renewed = {
      ...missing,
      worktreeId: worktreeIdSchema.parse(
        'worktree_11111111111111111111111111111111',
      ),
      generation: worktreeGenerationSchema.parse(
        'generation_11111111111111111111111111111111',
      ),
    };
    const publish = (replacement: typeof missing) =>
      fixture.publish({
        ...current,
        snapshot: {
          ...current.snapshot,
          worktrees: current.snapshot.worktrees.map((w) =>
            w === missing ? replacement : w,
          ),
        },
      });
    publish(renewed);
    expect(store.getSnapshot().selectedWorktreeId).toBe(renewed.worktreeId);
    expect(store.getSnapshot().focusRecoveryRevision).toBe(0);
    expect(store.getSnapshot().selectedFileId).toBeNull();
    publish({
      ...renewed,
      status: { kind: 'clean' },
      availability: { kind: 'available' },
      worktreeId: worktreeIdSchema.parse(
        'worktree_22222222222222222222222222222222',
      ),
      generation: worktreeGenerationSchema.parse(
        'generation_22222222222222222222222222222222',
      ),
    });
    expect(store.getSnapshot().selectedWorktreeId).toBe(
      current.snapshot.worktrees[0]!.worktreeId,
    );
    store.dispose();
  });

  it('waits for the backend draft revision before persisting text typed during initial load', async () => {
    const fixture = createOverviewFixture('changed-worktree');
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = current.snapshot.worktrees[0]!;
    let resolveDraft!: (draft: {
      worktreeId: typeof worktree.worktreeId;
      revision: number;
      text: string;
    }) => void;
    const updateCommitDraft = vi.fn(
      async (
        request: Parameters<RepositoryOverviewSource['updateCommitDraft']>[0],
      ) => ({
        worktreeId: request.worktreeId,
        revision: request.expectedRevision + 1,
        text: request.update.kind === 'set' ? request.update.text : '',
      }),
    );
    const source: RepositoryOverviewSource = {
      ...fixture.source,
      getCommitDraft: () => new Promise((resolve) => (resolveDraft = resolve)),
      updateCommitDraft,
    };
    const store = createRepositoryStore(source);

    store.setCommitDraft(worktree.worktreeId, 'Locally typed draft');
    expect(updateCommitDraft).not.toHaveBeenCalled();
    resolveDraft({
      worktreeId: worktree.worktreeId,
      revision: 4,
      text: 'Older backend draft',
    });

    await vi.waitFor(() => expect(updateCommitDraft).toHaveBeenCalled());
    expect(updateCommitDraft).toHaveBeenCalledWith({
      worktreeId: worktree.worktreeId,
      expectedRevision: 4,
      update: { kind: 'set', text: 'Locally typed draft' },
    });
    expect(store.getSnapshot().commitDrafts[worktree.worktreeId]).toBe(
      'Locally typed draft',
    );
  });

  it('submits Push with the selected Worktree and observed revisions', async () => {
    const fixture = createOverviewFixture('one-worktree');
    const requestRemoteOperation = vi.fn(async () => ({
      kind: 'succeeded' as const,
      operationId: operationIdSchema.parse(
        'operation_00000000000000000000000000000001',
      ),
      result: { kind: 'no_change' as const },
    }));
    const store = createRepositoryStore({
      ...fixture.source,
      requestRemoteOperation,
    });
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = current.snapshot.worktrees[0]!;

    store.push();
    await vi.waitFor(() => expect(requestRemoteOperation).toHaveBeenCalled());

    expect(requestRemoteOperation).toHaveBeenCalledWith({
      kind: 'push',
      worktreeId: worktree.worktreeId,
      expectedWorktreeRevision: worktree.worktreeRevision,
      expectedRefsRevision: current.snapshot.refsRevision,
      remoteId: undefined,
    });
    expect(store.getSnapshot().remoteOperation).toMatchObject({
      kind: 'result',
      result: { kind: 'succeeded', result: { kind: 'no_change' } },
    });
  });

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

  it('follows a successful file mutation into its new Change Group', async () => {
    const fixture = createOverviewFixture('changed-worktree');
    const before = fixture.source.getSnapshot();
    if (before.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = before.snapshot.worktrees[0]!;
    const changed = worktree.changes.find(({ kind }) => kind === 'change')!;
    const stagedFileId = fileIdSchema.parse(
      'file_0000000000000000000000000000000a',
    );
    const source: RepositoryOverviewSource = {
      ...fixture.source,
      async mutateFiles() {
        fixture.publish({
          kind: 'repository',
          snapshot: {
            ...before.snapshot,
            repositoryRevision: before.snapshot.repositoryRevision + 1,
            worktrees: [
              {
                ...worktree,
                worktreeRevision: worktree.worktreeRevision + 1,
                changes: worktree.changes.map((change) =>
                  change.fileId === changed.fileId
                    ? {
                        ...change,
                        fileId: stagedFileId,
                        kind: 'staged_change' as const,
                        baseline: 'head_to_index' as const,
                      }
                    : change,
                ),
              },
            ],
          },
        });
        return {
          kind: 'succeeded',
          operationId: operationIdSchema.parse(
            'operation_00000000000000000000000000000003',
          ),
          result: { kind: 'files', affectedCount: 1 },
        };
      },
    };
    const store = createRepositoryStore(source);
    store.selectFile(changed.fileId);

    store.mutateFiles('stage', [changed.fileId]);
    await Promise.resolve();

    expect(store.getSnapshot().selectedFileId).toBe(stagedFileId);
  });

  it('preserves a newer synchronized draft typed while Commit is running', async () => {
    const fixture = createOverviewFixture('changed-worktree');
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = current.snapshot.worktrees[0]!;
    const pendingCommit =
      deferred<Awaited<ReturnType<RepositoryOverviewSource['commit']>>>();
    const commit = vi.fn(() => pendingCommit.promise);
    const store = createRepositoryStore({ ...fixture.source, commit });
    await vi.waitFor(() =>
      expect(store.getSnapshot().commitDrafts[worktree.worktreeId]).toBe(''),
    );
    store.setCommitDraft(worktree.worktreeId, 'Submitted draft');
    await vi.waitFor(() =>
      expect(store.getSnapshot().commitDrafts[worktree.worktreeId]).toBe(
        'Submitted draft',
      ),
    );
    store.commit(false);
    await vi.waitFor(() => expect(commit).toHaveBeenCalled());

    store.setCommitDraft(worktree.worktreeId, 'New draft during Commit');
    pendingCommit.resolve({
      kind: 'succeeded',
      operationId: operationIdSchema.parse(
        'operation_00000000000000000000000000000004',
      ),
      result: {
        kind: 'commit',
        shortObjectId: 'abcdef1',
        summary: 'Submitted draft',
      },
    });

    await vi.waitFor(() =>
      expect(
        store.getSnapshot().commitOperations[worktree.worktreeId],
      ).toMatchObject({ kind: 'result', result: { kind: 'succeeded' } }),
    );
    expect(store.getSnapshot().commitDrafts[worktree.worktreeId]).toBe(
      'New draft during Commit',
    );
  });

  it('tracks independent running Commits per Worktree', async () => {
    const fixture = createOverviewFixture('many-worktrees');
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    const first = current.snapshot.worktrees.find(
      ({ role }) => role === 'main',
    );
    const second = current.snapshot.worktrees.find(
      ({ role }) => role === 'linked',
    );
    if (first === undefined || second === undefined) {
      throw new Error('Expected two Worktrees');
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
    const pending = new Map<string, ReturnType<typeof deferred<never>>>();
    const commit = vi.fn(
      (request: Parameters<RepositoryOverviewSource['commit']>[0]) => {
        const operation = deferred<never>();
        pending.set(request.worktreeId, operation);
        return operation.promise;
      },
    );
    const store = createRepositoryStore({ ...fixture.source, commit });
    store.setCommitDraft(first.worktreeId, 'First Commit');
    store.setCommitDraft(second.worktreeId, 'Second Commit');
    store.commit(false);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));

    store.selectWorktree(second.worktreeId);
    store.commit(false);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));

    expect(store.getSnapshot().commitOperations[first.worktreeId]).toEqual({
      kind: 'running',
      operationId: null,
      cancellationRequested: false,
    });
    expect(store.getSnapshot().commitOperations[second.worktreeId]).toEqual({
      kind: 'running',
      operationId: null,
      cancellationRequested: false,
    });
    expect(pending.size).toBe(2);
  });

  it('re-queries an Unknown Commit outcome and publishes later recovery', async () => {
    const fixture = createOverviewFixture('changed-worktree');
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = current.snapshot.worktrees[0]!;
    const operationId = operationIdSchema.parse(
      'operation_00000000000000000000000000000005',
    );
    let backendDraft = { revision: 0, text: '' };
    const updateCommitDraft = vi.fn(
      async (
        request: Parameters<RepositoryOverviewSource['updateCommitDraft']>[0],
      ) => {
        expect(request.expectedRevision).toBe(backendDraft.revision);
        backendDraft = {
          revision: backendDraft.revision + 1,
          text: request.update.kind === 'set' ? request.update.text : '',
        };
        return { worktreeId: request.worktreeId, ...backendDraft };
      },
    );
    const recoverOperation = vi.fn(async () => {
      backendDraft = { revision: backendDraft.revision + 1, text: '' };
      return {
        kind: 'succeeded' as const,
        operationId,
        result: {
          kind: 'commit' as const,
          shortObjectId: '1234567',
          summary: 'Recovered Commit',
        },
      };
    });
    const store = createRepositoryStore({
      ...fixture.source,
      getCommitDraft: async (worktreeId) => ({ worktreeId, ...backendDraft }),
      updateCommitDraft,
      async commit() {
        return {
          kind: 'unknown_outcome',
          operationId,
          code: 'reconciliation_incomplete',
          message: 'Reconciliation is incomplete.',
          recoveryAvailable: true,
        };
      },
      recoverOperation,
    });
    store.setCommitDraft(worktree.worktreeId, 'Recover me');
    store.commit(false);
    await vi.waitFor(() =>
      expect(
        store.getSnapshot().commitOperations[worktree.worktreeId],
      ).toMatchObject({ kind: 'result', result: { kind: 'unknown_outcome' } }),
    );

    store.recoverCommit(worktree.worktreeId);

    await vi.waitFor(() =>
      expect(
        store.getSnapshot().commitOperations[worktree.worktreeId],
      ).toMatchObject({ kind: 'result', result: { kind: 'succeeded' } }),
    );
    expect(recoverOperation).toHaveBeenCalledWith(operationId);
    expect(store.getSnapshot().commitDrafts[worktree.worktreeId]).toBe('');
    store.setCommitDraft(worktree.worktreeId, 'After recovery');
    await vi.waitFor(() =>
      expect(updateCommitDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedRevision: 2 }),
      ),
    );
  });

  it('preserves and reloads a later draft when Unknown Commit recovery succeeds', async () => {
    const fixture = createOverviewFixture('changed-worktree');
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = current.snapshot.worktrees[0]!;
    const operationId = operationIdSchema.parse(
      'operation_00000000000000000000000000000007',
    );
    let backendDraft = { revision: 0, text: '' };
    const source: RepositoryOverviewSource = {
      ...fixture.source,
      async getCommitDraft(worktreeId) {
        return { worktreeId, ...backendDraft };
      },
      async updateCommitDraft(request) {
        if (request.expectedRevision !== backendDraft.revision) {
          throw new Error('Stale draft');
        }
        backendDraft = {
          revision: backendDraft.revision + 1,
          text: request.update.kind === 'set' ? request.update.text : '',
        };
        return { worktreeId: request.worktreeId, ...backendDraft };
      },
      async commit() {
        return {
          kind: 'unknown_outcome',
          operationId,
          code: 'reconciliation_incomplete',
          message: 'Reconciliation is incomplete.',
          recoveryAvailable: true,
        };
      },
      async recoverOperation() {
        return {
          kind: 'succeeded',
          operationId,
          result: {
            kind: 'commit',
            shortObjectId: '7654321',
            summary: 'Original draft',
          },
        };
      },
    };
    const store = createRepositoryStore(source);
    store.setCommitDraft(worktree.worktreeId, 'Original draft');
    store.commit(false);
    await vi.waitFor(() =>
      expect(
        store.getSnapshot().commitOperations[worktree.worktreeId],
      ).toMatchObject({ kind: 'result', result: { kind: 'unknown_outcome' } }),
    );
    store.setCommitDraft(worktree.worktreeId, 'Later draft');
    await vi.waitFor(() => expect(backendDraft.text).toBe('Later draft'));

    store.recoverCommit(worktree.worktreeId);

    await vi.waitFor(() =>
      expect(
        store.getSnapshot().commitOperations[worktree.worktreeId],
      ).toMatchObject({ kind: 'result', result: { kind: 'succeeded' } }),
    );
    expect(store.getSnapshot().commitDrafts[worktree.worktreeId]).toBe(
      'Later draft',
    );
    expect(backendDraft).toEqual({ revision: 2, text: 'Later draft' });
  });

  it('cancels an accepted Commit by its exact Operation ID and shows reconciliation', async () => {
    const fixture = createOverviewFixture('changed-worktree');
    const current = fixture.source.getSnapshot();
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = current.snapshot.worktrees[0]!;
    const operationId = operationIdSchema.parse(
      'operation_00000000000000000000000000000006',
    );
    const cancelOperation = vi.fn(async () => ({
      kind: 'unknown_outcome' as const,
      operationId,
      code: 'reconciliation_incomplete' as const,
      message: 'Cancellation is reconciling.',
      recoveryAvailable: true as const,
    }));
    const store = createRepositoryStore({
      ...fixture.source,
      commit(_request, onAccepted) {
        onAccepted?.(operationId);
        return new Promise<never>(() => undefined);
      },
      cancelOperation,
    });
    store.setCommitDraft(worktree.worktreeId, 'Cancel me');
    store.commit(false);
    await vi.waitFor(() =>
      expect(store.getSnapshot().commitOperations[worktree.worktreeId]).toEqual(
        {
          kind: 'running',
          operationId,
          cancellationRequested: false,
        },
      ),
    );

    store.cancelCommit(worktree.worktreeId);

    expect(cancelOperation).toHaveBeenCalledWith(operationId);
    expect(store.getSnapshot().commitOperations[worktree.worktreeId]).toEqual({
      kind: 'running',
      operationId,
      cancellationRequested: true,
    });
  });
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
