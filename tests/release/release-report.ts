import { relative, sep } from 'node:path';

import {
  MVP_ACCEPTANCE_CRITERIA,
  validateReleaseGate,
  type AcceptanceEvidence,
} from './release-gate.js';
import { PERFORMANCE_BUDGET_MILLISECONDS } from './performance-budget.js';
import type { ReferenceBenchmarkResult } from './reference-benchmark.js';
import {
  manualEvidenceCheckPasses,
  type ManualEvidenceRecord,
} from './manual-evidence.js';
import { validateReleaseEnvironment } from './release-environment.js';

export interface VitestAssertionResult {
  failureMessages?: string[];
  status: string;
  title: string;
}

export interface VitestJsonReport {
  readonly success: boolean;
  readonly testResults: {
    readonly assertionResults: VitestAssertionResult[];
    readonly name: string;
  }[];
}

export interface ReleaseEnvironment {
  readonly architecture: string;
  readonly codex: string;
  readonly cpu: string;
  readonly git: string;
  readonly memoryBytes: number;
  readonly node: string;
  readonly operatingSystem: string;
  readonly referenceProfile: string;
}

export interface ReleaseEvidenceResult {
  readonly checkId?: string;
  readonly kind: AcceptanceEvidence['kind'] | 'environment' | 'performance';
  readonly reference: string;
  readonly status: 'failed' | 'passed';
}

export interface ReleaseCriterionResult {
  readonly evidence: readonly ReleaseEvidenceResult[];
  readonly id: string;
  readonly status: 'failed' | 'passed';
  readonly title: string;
}

export interface ReleaseReport {
  readonly criteria: readonly ReleaseCriterionResult[];
  readonly environment: ReleaseEnvironment;
  readonly environmentFailures: readonly string[];
  readonly generatedAt: string;
  readonly markdown: string;
  readonly manualEvidence: ManualEvidenceRecord;
  readonly performance: ReferenceBenchmarkResult | null;
  readonly status: 'failed' | 'passed';
  readonly staticIssues: readonly string[];
}

export async function createReleaseReport(
  root: string,
  vitest: VitestJsonReport,
  environment: ReleaseEnvironment,
  performance: ReferenceBenchmarkResult | null = null,
  manualEvidence: ManualEvidenceRecord = { checks: [], schemaVersion: 1 },
  sourceRevision = 'unrecorded',
  generatedAt = new Date(),
): Promise<ReleaseReport> {
  const staticIssues = await validateReleaseGate(root);
  const testResults = indexTestResults(root, vitest);
  const environmentFailures = validateReleaseEnvironment(environment);
  const criteria = await Promise.all(
    MVP_ACCEPTANCE_CRITERIA.map(async (criterion) => {
      const evidence = await Promise.all(
        criterion.evidence.map(async (item): Promise<ReleaseEvidenceResult> => {
          if (item.kind === 'manual') {
            const check = manualEvidence.checks.find(
              (candidate) => candidate.id === item.checkId,
            );
            return {
              checkId: item.checkId,
              kind: item.kind,
              reference:
                check?.record ??
                `${item.file}#${item.marker} (${item.checkId})`,
              status: (await manualEvidenceCheckPasses(
                root,
                check,
                sourceRevision,
                generatedAt,
                environment.codex,
              ))
                ? 'passed'
                : 'failed',
            };
          }

          return {
            kind: item.kind,
            reference: `${item.file}::${item.test}`,
            status:
              testResults.get(`${item.file}::${item.test}`) === 'passed'
                ? 'passed'
                : 'failed',
          };
        }),
      );
      if (criterion.id === 'AC-24') {
        evidence.push(
          {
            kind: 'performance',
            reference: 'reference benchmark performance budgets',
            status:
              performance !== null && performance.budgetFailures.length === 0
                ? 'passed'
                : 'failed',
          },
          {
            kind: 'environment',
            reference: 'approved macOS and Codex reference profile',
            status: environmentFailures.length === 0 ? 'passed' : 'failed',
          },
        );
      }
      const hasStaticIssue = staticIssues.some((issue) =>
        issue.startsWith(`${criterion.id} `),
      );
      return {
        evidence,
        id: criterion.id,
        status:
          !hasStaticIssue && evidence.every(({ status }) => status !== 'failed')
            ? ('passed' as const)
            : ('failed' as const),
        title: criterion.title,
      };
    }),
  );
  const status =
    vitest.success &&
    staticIssues.length === 0 &&
    performance !== null &&
    performance.budgetFailures.length === 0 &&
    criteria.every((criterion) => criterion.status === 'passed')
      ? ('passed' as const)
      : ('failed' as const);
  const reportWithoutMarkdown = {
    criteria,
    environment,
    environmentFailures,
    generatedAt: generatedAt.toISOString(),
    manualEvidence,
    performance,
    status,
    staticIssues,
  };

  return {
    ...reportWithoutMarkdown,
    markdown: renderReleaseReport(reportWithoutMarkdown),
  };
}

function indexTestResults(
  root: string,
  vitest: VitestJsonReport,
): ReadonlyMap<string, string> {
  const results = new Map<string, string>();
  for (const testFile of vitest.testResults) {
    const file = relative(root, testFile.name).split(sep).join('/');
    for (const assertion of testFile.assertionResults) {
      results.set(`${file}::${assertion.title}`, assertion.status);
    }
  }
  return results;
}

function renderReleaseReport(report: {
  readonly criteria: readonly ReleaseCriterionResult[];
  readonly environment: ReleaseEnvironment;
  readonly environmentFailures: readonly string[];
  readonly generatedAt: string;
  readonly manualEvidence: ManualEvidenceRecord;
  readonly performance: ReferenceBenchmarkResult | null;
  readonly status: 'failed' | 'passed';
  readonly staticIssues: readonly string[];
}): string {
  const criteria = report.criteria
    .map(
      ({ id, status, title }) => `| ${id} | ${escapeCell(title)} | ${status} |`,
    )
    .join('\n');
  const evidence = report.criteria
    .flatMap((criterion) =>
      criterion.evidence.map(
        (item) =>
          `| ${criterion.id} | ${item.kind} | ${escapeCell(item.reference)} | ${item.status} |`,
      ),
    )
    .join('\n');
  const staticIssues =
    report.staticIssues.length === 0
      ? 'None.'
      : report.staticIssues.map((issue) => `- ${issue}`).join('\n');
  const performance = renderPerformance(report.performance);

  return `# Codex Git MVP release gate evidence

- Generated: ${report.generatedAt}
- Overall status: **${report.status}**

## Reference environment

| Field | Value |
| --- | --- |
| CPU | ${escapeCell(report.environment.cpu)} |
| Architecture | ${escapeCell(report.environment.architecture)} |
| Memory bytes | ${report.environment.memoryBytes} |
| Operating system | ${escapeCell(report.environment.operatingSystem)} |
| Git | ${escapeCell(report.environment.git)} |
| Node | ${escapeCell(report.environment.node)} |
| Codex | ${escapeCell(report.environment.codex)} |
| Reference profile | ${escapeCell(report.environment.referenceProfile)} |

## Environment validation

${report.environmentFailures.length === 0 ? 'Passed.' : report.environmentFailures.map((failure) => `- ${failure}`).join('\n')}

## Performance and capacity

${performance}

## Acceptance matrix

| Criterion | Scenario | Status |
| --- | --- | --- |
${criteria}

## Evidence

| Criterion | Kind | Reference | Status |
| --- | --- | --- | --- |
${evidence}

## Static validation issues

${staticIssues}
`;
}

function renderPerformance(
  performance: ReferenceBenchmarkResult | null,
): string {
  if (performance === null) return 'Reference benchmark was not recorded.';
  const labels = {
    externalChange: 'Visible external change',
    fullSnapshot: 'Full snapshot',
    loadedInteraction: 'Loaded interaction',
    selectedWorktree: 'Selected Worktree',
    shell: 'Application shell',
  } as const;
  const measurements = (Object.keys(labels) as (keyof typeof labels)[])
    .map((name) => {
      const measured = performance.measurements[name];
      const budget = PERFORMANCE_BUDGET_MILLISECONDS[name];
      return `| ${labels[name]} | ${measured} ms | ${budget} ms | ${measured <= budget ? 'passed' : 'failed'} |`;
    })
    .join('\n');

  return `- Available Worktrees: ${performance.fixture.availableWorktrees}
- Unavailable registrations: ${performance.fixture.unavailableRegistrations}
- Changed Files: ${performance.fixture.changedFiles}
- Local and Remote-tracking refs: ${performance.fixture.refs}

| Measurement | Observed | Budget | Status |
| --- | --- | --- | --- |
${measurements}`;
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
