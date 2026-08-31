export interface PerformanceMeasurements {
  readonly externalChange: number;
  readonly fullSnapshot: number;
  readonly loadedInteraction: number;
  readonly selectedWorktree: number;
  readonly shell: number;
}

export const PERFORMANCE_BUDGET_MILLISECONDS = {
  externalChange: 2_000,
  fullSnapshot: 5_000,
  loadedInteraction: 100,
  selectedWorktree: 2_000,
  shell: 1_000,
} as const satisfies PerformanceMeasurements;

const MEASUREMENT_ORDER = [
  'shell',
  'selectedWorktree',
  'fullSnapshot',
  'externalChange',
  'loadedInteraction',
] as const;

export function evaluatePerformanceBudget(
  measurements: PerformanceMeasurements,
): string[] {
  return MEASUREMENT_ORDER.flatMap((measurement) => {
    const duration = measurements[measurement];
    const budget = PERFORMANCE_BUDGET_MILLISECONDS[measurement];
    return duration <= budget
      ? []
      : [`${measurement} took ${duration} ms; budget is ${budget} ms.`];
  });
}
