import { describe, expect, it } from 'vitest';

import type {
  AbsolutePath,
  ClientCommandId,
  NativeTargetId,
} from '@codex-git/protocol';

import type { ScopedRepositoryPublicationSession } from './repository-publication.js';
import { createRepositorySession } from './repository-session.js';

describe('Repository File native targets', () => {
  it('keeps undecodable paths copyable without creating an OS file path', async () => {
    const targetId =
      'native_00000000000000000000000000000001' as NativeTargetId;
    const repository = {
      kind: 'repository' as const,
      repository: {
        repositoryId: 'repository_fixture',
        repositoryRevision: 1,
        topologyRevision: 1,
        refsRevision: 1,
        refresh: { kind: 'fresh' },
        remotes: [],
        operations: [],
        worktrees: [
          {
            canonicalPath: '/projects/repository',
            changes: [
              {
                nativeTargetId: targetId,
                pathBytes: Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74),
                workingFilePresent: true,
              },
            ],
          },
        ],
      },
    };
    const delegate = {
      snapshot: async () => repository,
      requestRefresh: async () => repository,
      requestScopedRefresh: async () => repository,
      close: async () => undefined,
    } as unknown as ScopedRepositoryPublicationSession;
    const session = createRepositorySession(delegate);

    await expect(session.resolveFileNativeTarget(targetId)).resolves.toEqual({
      absolutePath: null,
      canOpen: false,
      relativePath: '\\xff.txt',
      worktreePath: '/projects/repository',
    });

    await session.close();
  });
});

describe('Repository Worktree native targets', () => {
  it('resolves only the exact fresh and available Worktree target', async () => {
    const targetId =
      'native_00000000000000000000000000000002' as NativeTargetId;
    const repository = {
      kind: 'repository' as const,
      repository: {
        repositoryId: 'repository_fixture',
        repositoryRevision: 1,
        topologyRevision: 1,
        refsRevision: 1,
        refresh: { kind: 'fresh' },
        remotes: [],
        operations: [],
        worktrees: [
          {
            nativeTargetId: targetId,
            canonicalPath: '/projects/selected-worktree',
            availability: { kind: 'available' },
            freshness: { kind: 'fresh' },
            changes: [],
          },
        ],
      },
    };
    const delegate = {
      snapshot: async () => repository,
      requestRefresh: async () => repository,
      requestScopedRefresh: async () => repository,
      close: async () => undefined,
    } as unknown as ScopedRepositoryPublicationSession;
    const session = createRepositorySession(delegate);

    await expect(
      session.resolveWorktreeNativeTarget(targetId),
    ).resolves.toEqual({
      worktreePath: '/projects/selected-worktree',
    });

    await session.close();
  });
});

describe('Repository Remote operation outcomes', () => {
  it('reports Push success when exact refreshed state proves the effect despite an earlier failure diagnostic', async () => {
    const beforePush = remoteRepositoryFixture();
    const afterPush = pushedRepositoryFixture();
    let pushed = false;
    const delegate = {
      snapshot: async () => (pushed ? afterPush : beforePush),
      requestRefresh: async () => (pushed ? afterPush : beforePush),
      requestScopedRefresh: async () => (pushed ? afterPush : beforePush),
      close: async () => undefined,
    } as unknown as ScopedRepositoryPublicationSession;
    const session = createRepositorySession(delegate, {
      runGit: async () => new TextEncoder().encode('origin\0refs/heads/main\n'),
      executeRemoteOperation: async (request) => {
        if (request.kind === 'push') {
          return {
            kind: 'failed_known',
            code: 'offline',
            message: 'The Remote could not be reached.',
          };
        }
        pushed = true;
        return { kind: 'completed' };
      },
    });
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository.');
    const worktree = opened.repository.worktrees[0]!;

    const receipt = await session.dispatch({
      clientCommandId:
        'command_00000000000000000000000000000003' as ClientCommandId,
      command: {
        kind: 'push',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        expectedRefsRevision: opened.repository.refsRevision,
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'succeeded',
      result: { kind: 'remote', summary: 'Pushed main.' },
    });
    await session.close();
  });

  it('keeps matching offline diagnostics unknown without refreshed-state proof', async () => {
    const repository = remoteRepositoryFixture();
    const delegate = {
      snapshot: async () => repository,
      requestRefresh: async () => repository,
      requestScopedRefresh: async () => repository,
      close: async () => undefined,
    } as unknown as ScopedRepositoryPublicationSession;
    const session = createRepositorySession(delegate, {
      runGit: async () => new TextEncoder().encode('origin\0refs/heads/main\n'),
      executeRemoteOperation: async () => ({
        kind: 'failed_known',
        code: 'offline',
        message: 'The Remote could not be reached.',
      }),
    });
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository.');
    const worktree = opened.repository.worktrees[0]!;

    const receipt = await session.dispatch({
      clientCommandId:
        'command_00000000000000000000000000000004' as ClientCommandId,
      command: {
        kind: 'push',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        expectedRefsRevision: opened.repository.refsRevision,
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'unknown_outcome',
      code: 'reconciliation_incomplete',
      recoveryAvailable: true,
    });
    await session.close();
  });

  it('keeps an ambiguous Push unknown when exact Remote reconciliation also cannot complete', async () => {
    const repository = remoteRepositoryFixture();
    const delegate = {
      snapshot: async () => repository,
      requestRefresh: async () => repository,
      requestScopedRefresh: async () => repository,
      close: async () => undefined,
    } as unknown as ScopedRepositoryPublicationSession;
    const session = createRepositorySession(delegate, {
      runGit: async () => new TextEncoder().encode('origin\0refs/heads/main\n'),
      executeRemoteOperation: async () => ({
        kind: 'unknown',
        message: 'Git did not report an unambiguous Remote Operation outcome.',
      }),
    });
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository.');
    const worktree = opened.repository.worktrees[0]!;

    const receipt = await session.dispatch({
      clientCommandId:
        'command_00000000000000000000000000000001' as ClientCommandId,
      command: {
        kind: 'push',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        expectedRefsRevision: opened.repository.refsRevision,
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'unknown_outcome',
      code: 'reconciliation_incomplete',
      recoveryAvailable: true,
    });
    await session.close();
  });

  it('reconciles exact Remote state after an executor throws', async () => {
    const repository = remoteRepositoryFixture();
    const delegate = {
      snapshot: async () => repository,
      requestRefresh: async () => repository,
      requestScopedRefresh: async () => repository,
      close: async () => undefined,
    } as unknown as ScopedRepositoryPublicationSession;
    const requests: string[] = [];
    const session = createRepositorySession(delegate, {
      runGit: async () => new TextEncoder().encode('origin\0refs/heads/main\n'),
      executeRemoteOperation: async (request) => {
        requests.push(request.kind);
        if (request.kind === 'push') throw new Error('ambiguous process loss');
        return { kind: 'completed' };
      },
    });
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository.');
    const worktree = opened.repository.worktrees[0]!;

    const receipt = await session.dispatch({
      clientCommandId:
        'command_00000000000000000000000000000002' as ClientCommandId,
      command: {
        kind: 'push',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        expectedRefsRevision: opened.repository.refsRevision,
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(requests[0]).toBe('push');
    expect(requests.slice(1)).not.toHaveLength(0);
    expect(requests.slice(1)).toEqual(
      requests.slice(1).map(() => 'refresh_tracking'),
    );
    expect(result).toMatchObject({
      kind: 'unknown_outcome',
      code: 'reconciliation_incomplete',
    });
    await session.close();
  });
});

function remoteRepositoryFixture() {
  const repositoryId = 'repository_00000000000000000000000000000001' as const;
  const worktreeId = 'worktree_00000000000000000000000000000001' as const;
  const generation = 'generation_00000000000000000000000000000001' as const;
  const remoteId = 'remote_00000000000000000000000000000001' as const;
  const objectId = '0123456789abcdef0123456789abcdef01234567';
  return {
    kind: 'repository' as const,
    repository: {
      repositoryId,
      repositoryRevision: 1,
      topologyRevision: 1,
      refsRevision: 1,
      refresh: { kind: 'fresh' as const },
      fetch: { kind: 'never' as const },
      operations: [],
      commonGitDirectory: '/projects/repository/.git' as AbsolutePath,
      selectedWorktreeId: worktreeId,
      refs: [
        { kind: 'local' as const, fullName: 'refs/heads/main', objectId },
        {
          kind: 'remote_tracking' as const,
          fullName: 'refs/remotes/origin/main',
          objectId: '1123456789abcdef0123456789abcdef01234567',
        },
      ],
      remotes: [
        {
          remoteId,
          displayName: 'origin',
          host: 'example.test',
          configurationEvidence: 'configured-origin',
        },
      ],
      worktrees: [
        {
          worktreeId,
          worktreeRevision: 1,
          generation,
          displayPath: '/projects/repository',
          canonicalPath: '/projects/repository' as AbsolutePath,
          role: 'main' as const,
          head: {
            kind: 'local_branch' as const,
            fullName: 'refs/heads/main',
            displayName: 'main',
            objectId,
          },
          gitLock: { kind: 'unlocked' as const },
          availability: { kind: 'available' as const },
          freshness: { kind: 'fresh' as const },
          index: { entryCount: 1, fingerprint: 'index', locked: false },
          status: {
            clean: true,
            conflicted: 0,
            staged: 0,
            unstaged: 0,
            untracked: 0,
          },
          changes: [],
          upstream: {
            kind: 'tracking' as const,
            remoteId,
            displayName: 'origin/main',
            ref: {
              kind: 'remote_tracking' as const,
              fullName: 'refs/remotes/origin/main',
              objectId: '1123456789abcdef0123456789abcdef01234567',
            },
            aheadBehind: { kind: 'cached' as const, ahead: 1, behind: 0 },
          },
        },
      ],
    },
  };
}

function pushedRepositoryFixture() {
  const fixture = remoteRepositoryFixture();
  const localObjectId = fixture.repository.worktrees[0]!.head.objectId!;
  return {
    ...fixture,
    repository: {
      ...fixture.repository,
      repositoryRevision: fixture.repository.repositoryRevision + 1,
      refsRevision: fixture.repository.refsRevision + 1,
      refs: fixture.repository.refs.map((ref) =>
        ref.kind === 'remote_tracking'
          ? { ...ref, objectId: localObjectId }
          : ref,
      ),
      worktrees: fixture.repository.worktrees.map((worktree) => ({
        ...worktree,
        worktreeRevision: worktree.worktreeRevision + 1,
        upstream: {
          ...worktree.upstream,
          ref: { ...worktree.upstream.ref, objectId: localObjectId },
          aheadBehind: { kind: 'cached' as const, ahead: 0, behind: 0 },
        },
      })),
    },
  };
}
