import { describe, expect, it, vi } from 'vitest';

import {
  fileIdSchema,
  nativeTargetIdSchema,
  PROTOCOL_LIMITS,
} from '@codex-git/protocol';

import { readChangedFileDiff } from './change-review.js';
import type { PublishedWorktreeSnapshot } from './repository-publication.js';

describe('Changed File review', () => {
  it('uses literal Git pathspecs and the selected baseline only', async () => {
    const readGit = vi.fn(async () => new TextEncoder().encode('+changed\n'));
    const worktree = fixtureWorktree({
      kind: 'change',
      baseline: 'index_to_working_tree',
      displayPath: '-leading[name].txt',
      pathBytes: new TextEncoder().encode('-leading[name].txt'),
    });

    await readChangedFileDiff(worktree, worktree.changes[0]!.fileId, readGit);

    expect(readGit).toHaveBeenCalledWith(
      [
        '-C',
        '/projects/repository',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--',
        ':(literal)-leading[name].txt',
      ],
      true,
      undefined,
      undefined,
      PROTOCOL_LIMITS.diffOutputBytes - 1,
    );
  });

  it('reviews an Untracked File from empty input and accepts Git diff exit 1', async () => {
    const readGit = vi.fn(async () => new TextEncoder().encode('+new\n'));
    const worktree = fixtureWorktree({
      kind: 'untracked',
      baseline: 'empty_to_working_tree',
      displayPath: 'new.txt',
      pathBytes: new TextEncoder().encode('new.txt'),
    });

    await readChangedFileDiff(worktree, worktree.changes[0]!.fileId, readGit);

    expect(readGit).toHaveBeenCalledWith(
      expect.arrayContaining([
        '--no-index',
        '/dev/null',
        '/projects/repository/new.txt',
      ]),
      true,
      1,
      undefined,
      PROTOCOL_LIMITS.diffOutputBytes - 1,
    );
  });

  it('rejects an Untracked path that would escape its Worktree', async () => {
    const worktree = fixtureWorktree({
      kind: 'untracked',
      baseline: 'empty_to_working_tree',
      displayPath: '../outside.txt',
      pathBytes: new TextEncoder().encode('../outside.txt'),
    });

    await expect(
      readChangedFileDiff(
        worktree,
        worktree.changes[0]!.fileId,
        async () => new Uint8Array(),
      ),
    ).rejects.toThrow('escapes its Worktree');
  });

  it('resolves an undecodable path from byte inventories without passing it in argv', async () => {
    const invalidPath = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
    const objectId = 'a'.repeat(40);
    const readGit = vi.fn(async (args: readonly string[]) => {
      if (args.includes('ls-files')) {
        return Uint8Array.from([
          ...new TextEncoder().encode(`100644 ${objectId} 0\t`),
          ...invalidPath,
          0,
        ]);
      }
      if (args.includes('cat-file')) {
        return new TextEncoder().encode('reviewed\n');
      }
      return new TextEncoder().encode('@@ -0,0 +1 @@\n+reviewed\n');
    });
    const worktree = fixtureWorktree({
      kind: 'change',
      baseline: 'index_to_working_tree',
      displayPath: '�.txt',
      pathBytes: invalidPath,
    });

    await expect(
      readChangedFileDiff(worktree, worktree.changes[0]!.fileId, readGit),
    ).resolves.toMatchObject({
      kind: 'text',
      content: expect.stringContaining('reviewed'),
    });
    expect(
      readGit.mock.calls
        .flatMap(([args]) => args)
        .every((arg) => !arg.includes('�')),
    ).toBe(true);
  });

  it.each([
    {
      label: 'binary',
      output: new TextEncoder().encode('Binary files a and b differ\n'),
      expected: { kind: 'binary' },
    },
    {
      label: 'undecodable',
      output: Uint8Array.of(0xff),
      expected: { kind: 'undecodable' },
    },
    {
      label: 'oversized',
      output: new Uint8Array(PROTOCOL_LIMITS.diffOutputBytes + 1),
      expected: { kind: 'too_large' },
    },
  ])(
    'returns truthful $label metadata instead of display text',
    async ({ output, expected }) => {
      const worktree = fixtureWorktree({
        kind: 'staged_change',
        baseline: 'head_to_index',
        displayPath: 'asset.bin',
        pathBytes: new TextEncoder().encode('asset.bin'),
      });

      const result = await readChangedFileDiff(
        worktree,
        worktree.changes[0]!.fileId,
        async () => output,
      );

      expect(result).toMatchObject(expected);
      expect(result).not.toHaveProperty('content');
    },
  );

  it('classifies the stricter process-output cutoff without buffering it for rendering', async () => {
    const worktree = fixtureWorktree({
      kind: 'staged_change',
      baseline: 'head_to_index',
      displayPath: 'large.txt',
      pathBytes: new TextEncoder().encode('large.txt'),
    });
    const error = Object.assign(new Error('bounded'), {
      failure: 'output_too_large',
    });

    await expect(
      readChangedFileDiff(worktree, worktree.changes[0]!.fileId, async () =>
        Promise.reject(error),
      ),
    ).resolves.toMatchObject({
      kind: 'too_large',
      byteCount: PROTOCOL_LIMITS.diffOutputBytes,
      lineCount: null,
    });
  });
});

function fixtureWorktree(
  change: Omit<
    PublishedWorktreeSnapshot['changes'][number],
    | 'fileId'
    | 'nativeTargetId'
    | 'previousDisplayPath'
    | 'previousPathBytes'
    | 'workingFilePresent'
  > & { readonly workingFilePresent?: boolean },
): PublishedWorktreeSnapshot {
  return {
    worktreeId: 'worktree_00000000000000000000000000000001',
    generation: 'generation_00000000000000000000000000000001',
    worktreeRevision: 1,
    displayPath: '/projects/repository',
    canonicalPath: '/projects/repository',
    role: 'main',
    head: {
      kind: 'local_branch',
      fullName: 'refs/heads/main',
      displayName: 'main',
      objectId: '0123456789abcdef0123456789abcdef01234567',
    },
    gitLock: { kind: 'none' },
    availability: { kind: 'available' },
    freshness: { kind: 'fresh' },
    index: null,
    status: null,
    upstream: { kind: 'unpublished' },
    changes: [
      {
        ...change,
        workingFilePresent: change.workingFilePresent ?? true,
        fileId: fileIdSchema.parse('file_00000000000000000000000000000001'),
        nativeTargetId: nativeTargetIdSchema.parse(
          'native_00000000000000000000000000000001',
        ),
        previousDisplayPath: null,
        previousPathBytes: null,
      } as PublishedWorktreeSnapshot['changes'][number],
    ],
  } as unknown as PublishedWorktreeSnapshot;
}
