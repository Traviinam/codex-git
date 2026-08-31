import { describe, expect, it } from 'vitest';

import { createSupportedScaleFixture } from './supported-scale-fixture.js';
import { SUPPORTED_SCALE } from './release-envelope.js';
import { measureReleaseUi } from './ui-benchmark.js';

describe('supported release scale', () => {
  it('contains 25 Available Worktrees, 2,000 Changed Files, 5,000 refs, and unavailable diagnostics', () => {
    const fixture = createSupportedScaleFixture();
    const state = fixture.source.getSnapshot();
    if (state.kind !== 'repository') throw new Error('Expected Repository');

    expect(
      state.snapshot.worktrees.filter(
        (worktree) => worktree.status.kind !== 'unavailable',
      ),
    ).toHaveLength(SUPPORTED_SCALE.availableWorktrees);
    expect(
      state.snapshot.worktrees.reduce(
        (total, worktree) => total + worktree.changes.length,
        0,
      ),
    ).toBe(SUPPORTED_SCALE.changedFiles);
    expect(fixture.branchSearch.candidates).toHaveLength(SUPPORTED_SCALE.refs);
    expect(
      state.snapshot.worktrees.filter(
        (worktree) => worktree.status.kind === 'unavailable',
      ),
    ).toHaveLength(SUPPORTED_SCALE.unavailableRegistrations);
  });

  it('keeps loaded UI interactions within 100 milliseconds', async () => {
    expect((await measureReleaseUi()).loadedInteraction).toBeLessThanOrEqual(
      100,
    );
  });
});
