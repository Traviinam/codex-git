import { describe, expect, it, vi } from 'vitest';

import type {
  AbsolutePath,
  ClientCommandId,
  WorktreeGeneration,
  WorktreeId,
} from '@codex-git/protocol';

import { privateWorktreeIdentityEvidence } from './observation-publication.js';
import type { ScopedRepositoryPublicationSession } from './repository-publication.js';
import {
  createRepositorySession,
  type CommitTargetInspection,
} from './repository-session.js';

const worktreePath = '/worktree' as AbsolutePath;
const parentObjectId = '1'.repeat(40);
const committedObjectId = '2'.repeat(40);
const indexTree = '3'.repeat(40);

describe('Repository Commit execution boundary', () => {
  it('passes the exact multiline draft through stdin with the hook-preserving Git recipe', async () => {
    const harness = createCommitHarness();
    const draftText = 'Exact title\n\nExact body\n';
    const draft = await harness.setDraft(draftText);
    harness.onCommit = () => {
      harness.headObjectId = committedObjectId;
    };

    const result = await harness.commit(draft.revision);

    expect(result).toMatchObject({ kind: 'succeeded' });
    const invocation = harness.calls.find(({ args }) => args[2] === 'commit');
    expect(invocation?.args).toEqual([
      '-C',
      worktreePath,
      'commit',
      '--file=-',
    ]);
    expect(new TextDecoder().decode(invocation?.input)).toBe(draftText);
    expect(invocation?.environment).toEqual({
      GIT_INDEX_FILE: '/worktree/.git/index.codex-commit-private',
    });
    const commitIndex = harness.calls.findIndex(
      ({ args }) => args[2] === 'commit',
    );
    expect(harness.calls[commitIndex + 1]?.args).toEqual([
      '-C',
      worktreePath,
      'rev-list',
      '--parents',
      '-n',
      '1',
      `${committedObjectId.slice(0, 7)}^{commit}`,
    ]);
    await harness.session.close();
  });

  it('does not attribute an external same-tree Commit to a failed Git process', async () => {
    const harness = createCommitHarness();
    const draft = await harness.setDraft('Requested message');
    harness.onCommit = () => {
      harness.headObjectId = committedObjectId;
      harness.committedMessage = 'External message';
      throw knownGitFailure();
    };

    const result = await harness.commit(draft.revision);

    expect(result).toMatchObject({
      kind: 'failed_known',
      code: 'process_failed',
    });
    expect(harness.calls.some(({ args }) => args[2] === 'rev-list')).toBe(
      false,
    );
    await expect(
      harness.session.updateDraft({
        kind: 'get',
        worktreeId: harness.worktreeId,
      }),
    ).resolves.toEqual(draft);
    await harness.session.close();
  });

  it('keeps success Unknown when the exact post-process HEAD candidate cannot be read', async () => {
    const harness = createCommitHarness();
    const draft = await harness.setDraft('Candidate read failure');
    harness.onCommit = () => {
      harness.headObjectId = committedObjectId;
      harness.failHeadRead = true;
    };

    const result = await harness.commit(draft.revision);

    expect(result).toMatchObject({ kind: 'unknown_outcome' });
    await expect(
      harness.session.updateDraft({
        kind: 'get',
        worktreeId: harness.worktreeId,
      }),
    ).resolves.toEqual(draft);
    await harness.session.close();
  });

  it.each([
    ['Index lock', { indexLocked: true }, 'index_locked'],
    ['HEAD replacement', { headObjectId: '4'.repeat(40) }, 'stale'],
    ['Index replacement', { indexTree: '5'.repeat(40) }, 'stale'],
    ['Worktree replacement', { worktreePath: '/replacement' }, 'stale'],
  ] as const)(
    'rejects a raced %s during the final pre-execution inspection',
    async (_label, change, expectedCode) => {
      const harness = createCommitHarness(change);
      const draft = await harness.setDraft('Race-safe Commit');

      const result = await harness.commit(draft.revision);

      expect(result).toMatchObject({ kind: 'rejected', code: expectedCode });
      expect(harness.calls.some(({ args }) => args[2] === 'commit')).toBe(
        false,
      );
      await harness.session.close();
    },
  );

  it('recovers a timed-out Commit after the process returns success and its captured HEAD remains selected', async () => {
    const release = deferred<void>();
    const harness = createCommitHarness({}, 10);
    const draft = await harness.setDraft('Recovered timeout');
    harness.onCommit = async () => {
      await release.promise;
      harness.headObjectId = committedObjectId;
    };

    const receipt = await harness.dispatch(draft.revision);
    await expect(
      harness.session.recoverOperation(receipt.operationId),
    ).resolves.toMatchObject({ kind: 'unknown_outcome' });

    release.resolve();
    await expect
      .poll(() => harness.session.recoverOperation(receipt.operationId))
      .toMatchObject({ kind: 'succeeded' });
    await harness.session.close();
  });

  it('keeps timeout recovery Unknown when an external same-intent Commit has a different identity', async () => {
    const externalObjectId = '6'.repeat(40);
    const harness = createCommitHarness({}, 10);
    const draft = await harness.setDraft('Same parent tree and message');
    harness.onCommit = async (signal) => {
      await aborted(signal);
      harness.headObjectId = externalObjectId;
      throw new Error('The requested Git process did not return success.');
    };

    const receipt = await harness.dispatch(draft.revision);
    await expect(
      harness.session.recoverOperation(receipt.operationId),
    ).resolves.toMatchObject({ kind: 'unknown_outcome' });
    await expect(
      harness.session.recoverOperation(receipt.operationId),
    ).resolves.toMatchObject({ kind: 'unknown_outcome' });
    expect(harness.calls.some(({ args }) => args[2] === 'rev-list')).toBe(
      false,
    );
    await harness.session.close();
  });

  it('reconciles cancellation to success when Git created the exact Commit before aborting', async () => {
    const harness = createCommitHarness();
    const draft = await harness.setDraft('Cancelled after creation');
    harness.onCommit = async (signal) => {
      harness.headObjectId = committedObjectId;
      await aborted(signal);
    };

    const receipt = await harness.dispatch(draft.revision);
    const cancellation = await harness.session.dispatch({
      clientCommandId:
        'command_00000000000000000000000000000002' as ClientCommandId,
      command: {
        kind: 'cancel_operation',
        operationId: receipt.operationId,
      },
    });
    const result = await harness.session.recoverOperation(
      cancellation.operationId,
    );

    expect(result).toMatchObject({ kind: 'succeeded' });
    await harness.session.close();
  });

  it('rejects a stage race captured after the real Index sentinel is acquired', async () => {
    const harness = createCommitHarness();
    const draft = await harness.setDraft('Index raced before sentinel');
    harness.onBeginTransaction = () => {
      harness.transactionIndexTree = '5'.repeat(40);
    };

    const result = await harness.commit(draft.revision);

    expect(result).toMatchObject({ kind: 'rejected', code: 'stale' });
    expect(harness.calls.some(({ args }) => args[2] === 'commit')).toBe(false);
    expect(harness.cleanupCalls).toBe(1);
    await harness.session.close();
  });

  it('rejects a HEAD race captured after the real Index sentinel is acquired', async () => {
    const harness = createCommitHarness();
    const draft = await harness.setDraft('HEAD raced before spawn');
    harness.onBeginTransaction = () => {
      harness.headObjectId = '4'.repeat(40);
    };

    const result = await harness.commit(draft.revision);

    expect(result).toMatchObject({ kind: 'rejected', code: 'stale' });
    expect(harness.calls.some(({ args }) => args[2] === 'commit')).toBe(false);
    expect(harness.cleanupCalls).toBe(1);
    await harness.session.close();
  });

  it('does not reconcile a successful process candidate with the wrong parent', async () => {
    const harness = createCommitHarness();
    const draft = await harness.setDraft('Wrong parent candidate');
    harness.onCommit = () => {
      harness.headObjectId = committedObjectId;
      harness.committedParentObjectIds = ['7'.repeat(40)];
    };

    const result = await harness.commit(draft.revision);

    expect(result).toMatchObject({ kind: 'unknown_outcome' });
    await expect(
      harness.session.updateDraft({
        kind: 'get',
        worktreeId: harness.worktreeId,
      }),
    ).resolves.toEqual(draft);
    await harness.session.close();
  });
});

function createCommitHarness(
  inspectionChange: Partial<CommitTargetInspection> = {},
  timeout?: number,
) {
  const worktreeId = 'worktree_00000000000000000000000000000001' as WorktreeId;
  const harness = {
    headObjectId: parentObjectId,
    committedMessage: 'Requested message',
    committedParentObjectIds: [parentObjectId] as string[],
    transactionIndexTree: indexTree,
    failHeadRead: false,
    cleanupCalls: 0,
    onCommit: undefined as
      ((signal: AbortSignal) => Promise<void> | void) | undefined,
    onBeginTransaction: undefined as (() => void) | undefined,
    calls: [] as Array<{
      readonly args: readonly string[];
      readonly input: Uint8Array | undefined;
      readonly environment: Readonly<Record<string, string>> | undefined;
    }>,
  };
  const repository = () => ({
    kind: 'repository' as const,
    repository: fakeRepository(worktreeId, harness.headObjectId),
  });
  const delegate = {
    snapshot: async () => repository(),
    requestRefresh: async () => repository(),
    requestScopedRefresh: async () => repository(),
    async *subscribe() {},
    close: async () => undefined,
  } as unknown as ScopedRepositoryPublicationSession;
  const runGit = vi.fn(
    async (
      args: readonly string[],
      _allowLargeOutput: boolean,
      _acceptedEmptyExitCode?: 1,
      signal: AbortSignal = new AbortController().signal,
      _maximumOutputBytes?: number,
      input?: Uint8Array,
      environment?: Readonly<Record<string, string>>,
    ) => {
      harness.calls.push({ args, input, environment });
      if (args[2] === 'var') return bytes('Identity <identity@example.test>\n');
      if (args[2] === 'write-tree') {
        return bytes(
          `${environment === undefined ? indexTree : harness.transactionIndexTree}\n`,
        );
      }
      if (args[2] === 'rev-parse' && args.at(-1) === 'HEAD') {
        return bytes(`${harness.headObjectId}\n`);
      }
      if (args[2] === 'rev-list') {
        if (harness.failHeadRead) throw knownGitFailure();
        return bytes(
          [harness.headObjectId, ...harness.committedParentObjectIds].join(
            ' ',
          ) + '\n',
        );
      }
      if (args[2] === 'commit') {
        harness.committedMessage = new TextDecoder().decode(input);
        await harness.onCommit?.(signal);
        return bytes(
          `[main ${harness.headObjectId.slice(0, 7)}] ${firstLine(harness.committedMessage)}\n`,
        );
      }
      throw new Error(`Unexpected Git invocation: ${args.join(' ')}`);
    },
  );
  const session = createRepositorySession(delegate, {
    operationTimeoutMilliseconds: timeout,
    runGit,
    inspectCommitTarget: async () => ({
      commonGitDirectory: '/common.git',
      worktreePath,
      headObjectId: parentObjectId,
      indexTree,
      indexPath: '/worktree/.git/index',
      indexLocked: false,
      ...inspectionChange,
    }),
    beginCommitIndexTransaction: async () => {
      harness.onBeginTransaction?.();
      return {
        environment: {
          GIT_INDEX_FILE: '/worktree/.git/index.codex-commit-private',
        },
        promote: async () => undefined,
        cleanupKnownFailure: async () => {
          harness.cleanupCalls += 1;
        },
      };
    },
  });
  return Object.assign(harness, {
    session,
    worktreeId,
    async setDraft(text: string) {
      harness.committedMessage = text;
      await session.snapshot();
      return session.updateDraft({
        worktreeId,
        expectedRevision: 0,
        update: { kind: 'set', text },
      });
    },
    dispatch(draftRevision: number) {
      return session.dispatch({
        clientCommandId:
          'command_00000000000000000000000000000001' as ClientCommandId,
        command: {
          kind: 'commit',
          worktreeId,
          expectedWorktreeRevision: 1,
          draftRevision,
          confirmDetachedHead: false,
        },
      });
    },
    async commit(draftRevision: number) {
      const receipt = await this.dispatch(draftRevision);
      return session.recoverOperation(receipt.operationId);
    },
  });
}

function fakeRepository(worktreeId: WorktreeId, headObjectId: string) {
  return {
    repositoryId: 'repository_00000000000000000000000000000001',
    commonGitDirectory: '/common.git',
    selectedWorktreeId: worktreeId,
    repositoryRevision: headObjectId === parentObjectId ? 1 : 2,
    topologyRevision: 1,
    refsRevision: 1,
    refresh: { kind: 'fresh' as const },
    fetch: { kind: 'never' as const },
    remotes: [],
    refs: [],
    operations: [],
    worktrees: [
      {
        worktreeId,
        worktreeRevision: 1,
        generation:
          'generation_00000000000000000000000000000001' as WorktreeGeneration,
        [privateWorktreeIdentityEvidence]: 'topology:/worktree',
        displayPath: worktreePath,
        canonicalPath: worktreePath,
        role: 'main' as const,
        head: {
          kind: 'local_branch' as const,
          fullName: 'refs/heads/main',
          displayName: 'main',
          objectId: headObjectId,
        },
        gitLock: { kind: 'unlocked' as const },
        availability: { kind: 'available' as const },
        freshness: { kind: 'fresh' as const },
        index: { entryCount: 1, fingerprint: 'index-one', locked: false },
        status: {
          clean: false,
          conflicted: 0,
          staged: 1,
          unstaged: 0,
          untracked: 0,
        },
        changes: [],
        upstream: { kind: 'unpublished' as const },
      },
    ],
  };
}

function knownGitFailure() {
  return Object.assign(new Error('Sensitive Git diagnostic.'), {
    failure: 'command_failed',
    exitCode: 1,
    gitFailureCode: 'unclassified',
  });
}

function bytes(value: string) {
  return new TextEncoder().encode(value);
}

function firstLine(value: string) {
  return value.split(/\r?\n/u, 1)[0] ?? '';
}

function aborted(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
