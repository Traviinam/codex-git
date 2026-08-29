import { describe, expect, it } from 'vitest';

import { parseWorktreeListPorcelain } from './worktree-porcelain.js';

describe('parseWorktreeListPorcelain', () => {
  it('preserves NUL-delimited paths and classifies Git registration fields', () => {
    const output = Buffer.from(
      [
        'worktree /tmp/main tree',
        `HEAD ${'1'.repeat(40)}`,
        'branch refs/heads/main',
        '',
        'worktree /tmp/-linked\n工作树',
        `HEAD ${'2'.repeat(40)}`,
        'detached',
        'locked maintenance lock',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\0'),
    );

    expect(parseWorktreeListPorcelain(output)).toEqual([
      {
        pathBytes: Buffer.from('/tmp/main tree'),
        head: '1'.repeat(40),
        branch: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        lockedReason: null,
        prunable: false,
        prunableReason: null,
      },
      {
        pathBytes: Buffer.from('/tmp/-linked\n工作树'),
        head: '2'.repeat(40),
        branch: null,
        detached: true,
        bare: false,
        locked: true,
        lockedReason: 'maintenance lock',
        prunable: true,
        prunableReason: 'gitdir file points to non-existent location',
      },
    ]);
  });

  it('retains lock and prunable markers when Git supplies no reason', () => {
    const output = Buffer.from(
      [
        'worktree /tmp/unavailable',
        `HEAD ${'3'.repeat(40)}`,
        'branch refs/heads/topic',
        'locked',
        'prunable',
        '',
      ].join('\0'),
    );

    expect(parseWorktreeListPorcelain(output)[0]).toMatchObject({
      locked: true,
      lockedReason: null,
      prunable: true,
      prunableReason: null,
    });
  });

  it('preserves non-UTF-8 path bytes without decoding the full stream', () => {
    const path = Buffer.concat([
      Buffer.from('/tmp/non-utf8-'),
      Buffer.from([0xff, 0xfe]),
    ]);
    const output = Buffer.concat([
      Buffer.from('worktree '),
      path,
      Buffer.from(`\0HEAD ${'4'.repeat(40)}\0detached\0\0`),
    ]);

    const record = parseWorktreeListPorcelain(output)[0];

    expect(record?.pathBytes).toEqual(path);
  });
});
