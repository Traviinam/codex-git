import { describe, expect, it } from 'vitest';

import {
  aggregateReferenceBenchmarkSamples,
  type ReferenceBenchmarkResult,
} from './reference-benchmark.js';

describe('reference benchmark sampling', () => {
  it('uses the median so one runner spike does not change the verdict', () => {
    const result = aggregateReferenceBenchmarkSamples([
      sample(1_900),
      sample(2_500),
      sample(1_950),
    ]);

    expect(result.measurements.selectedWorktree).toBe(1_950);
    expect(result.budgetFailures).toEqual([]);
  });

  it('still fails when most independent samples exceed the budget', () => {
    const result = aggregateReferenceBenchmarkSamples([
      sample(2_100),
      sample(1_900),
      sample(2_200),
    ]);

    expect(result.measurements.selectedWorktree).toBe(2_100);
    expect(result.budgetFailures).toEqual([
      'selectedWorktree took 2100 ms; budget is 2000 ms.',
    ]);
  });
});

function sample(selectedWorktree: number): ReferenceBenchmarkResult {
  return {
    budgetFailures: [],
    fixture: {
      availableWorktrees: 25,
      changedFiles: 2_000,
      refs: 5_000,
      unavailableRegistrations: 1,
    },
    measurements: {
      externalChange: 1_000,
      fullSnapshot: 1_000,
      loadedInteraction: 10,
      selectedWorktree,
      shell: 100,
    },
  };
}
