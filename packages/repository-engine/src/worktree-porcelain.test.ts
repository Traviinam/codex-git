import { describe, expect, it } from 'vitest';

import { parseWorktreeListPorcelain } from './index.js';

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
        path: '/tmp/main tree',
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
        path: '/tmp/-linked\n工作树',
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
});
