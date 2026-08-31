import { describe, expect, it } from 'vitest';

import { resolveWorktreeProvenance } from './worktree-provenance.js';

describe('Worktree provenance resolver', () => {
  it('classifies conflicting stable Codex evidence as Unclassified', () => {
    const result = resolveWorktreeProvenance('/private/tmp/exact-worktree', [
      {
        canonicalCwd: '/private/tmp/exact-worktree',
        kind: 'codex_task',
        stable: true,
        task: {
          id: 'task-17',
          status: 'active',
          title: 'Implement exact navigation',
        },
      },
      {
        canonicalCwd: '/private/tmp/exact-worktree',
        kind: 'scheduled',
        stable: true,
      },
    ]);

    expect(result).toEqual({ kind: 'unclassified' });
  });

  it('fails closed on malformed or unstable metadata', () => {
    expect(
      resolveWorktreeProvenance('/private/tmp/exact-worktree', [
        {
          canonicalCwd: '/private/tmp/exact-worktree',
          kind: 'codex_task',
          stable: true,
          task: {
            id: 'task-unsafe',
            status: 'active',
            title: 'x'.repeat(1_025),
          },
        },
        {
          canonicalCwd: '/private/tmp/exact-worktree',
          kind: 'scheduled',
          stable: false,
        },
      ]),
    ).toEqual({ kind: 'unclassified' });
  });

  it.each([
    [
      'unstable conflicting evidence',
      {
        canonicalCwd: '/private/tmp/exact-worktree',
        kind: 'scheduled',
        stable: false,
      },
    ],
    [
      'malformed conflicting evidence',
      {
        canonicalCwd: '/private/tmp/exact-worktree',
        kind: 'codex_task',
        stable: true,
      },
    ],
  ] as const)(
    'fails closed on %s beside stable evidence',
    (_label, conflict) => {
      const stable = {
        canonicalCwd: '/private/tmp/exact-worktree',
        kind: 'codex_task' as const,
        stable: true,
        task: {
          id: 'task-stable',
          status: 'active',
          title: 'Stable task',
        },
      };

      expect(
        resolveWorktreeProvenance('/private/tmp/exact-worktree', [
          stable,
          conflict as typeof stable,
        ]),
      ).toEqual({ kind: 'unclassified' });
    },
  );
});
