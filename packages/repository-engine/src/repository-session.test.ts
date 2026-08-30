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
