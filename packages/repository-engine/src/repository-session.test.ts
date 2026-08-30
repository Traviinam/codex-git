import { describe, expect, it } from 'vitest';

import type { NativeTargetId } from '@codex-git/protocol';

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
            provenance: { kind: 'unclassified' },
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
      provenance: { kind: 'unclassified' },
      worktreePath: '/projects/repository',
    });

    await session.close();
  });
});

describe('Repository Worktree native targets', () => {
  it('resolves an exact opaque Worktree target with current generation facts', async () => {
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
            worktreeId: 'worktree_fixture',
            generation: 'generation_fixture',
            canonicalPath: '/projects/exact-worktree',
            displayPath: '/projects/exact-worktree',
            availability: { kind: 'available' },
            provenance: { kind: 'unclassified' },
            head: {
              kind: 'local_branch',
              displayName: 'feat/exact-target',
              fullName: 'refs/heads/feat/exact-target',
              objectId: '1'.repeat(40),
            },
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
      absolutePath: '/projects/exact-worktree',
      branchOrSha: 'feat/exact-target',
      canLaunch: true,
      provenance: { kind: 'unclassified' },
      worktreePath: '/projects/exact-worktree',
    });

    await session.close();
  });
});
