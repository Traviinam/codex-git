import { describe, expect, it } from 'vitest';

import {
  PERFORMANCE_BUDGET_MILLISECONDS,
  evaluatePerformanceBudget,
  type PerformanceMeasurements,
} from './performance-budget.js';

describe('release performance budget', () => {
  it('encodes every documented timing target', () => {
    expect(PERFORMANCE_BUDGET_MILLISECONDS).toEqual({
      externalChange: 2_000,
      fullSnapshot: 5_000,
      loadedInteraction: 100,
      selectedWorktree: 2_000,
      shell: 1_000,
    });
    expect(evaluatePerformanceBudget(PERFORMANCE_BUDGET_MILLISECONDS)).toEqual(
      [],
    );
  });

  it('rejects each measurement that exceeds its target', () => {
    const measurements: PerformanceMeasurements = {
      ...PERFORMANCE_BUDGET_MILLISECONDS,
      externalChange: 2_001,
      loadedInteraction: 101,
    };

    expect(evaluatePerformanceBudget(measurements)).toEqual([
      'externalChange took 2001 ms; budget is 2000 ms.',
      'loadedInteraction took 101 ms; budget is 100 ms.',
    ]);
  });
});
