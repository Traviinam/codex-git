import { describe, expect, it } from 'vitest';

import { MVP_ACCEPTANCE_CRITERIA } from './release-gate.js';
import {
  createReleaseReport,
  type ReleaseEnvironment,
  type VitestJsonReport,
} from './release-report.js';
import type { ReferenceBenchmarkResult } from './reference-benchmark.js';
import type { ManualEvidenceRecord } from './manual-evidence.js';

const environment: ReleaseEnvironment = {
  architecture: 'arm64',
  codex: '26.901.41600 (build 7982)',
  cpu: 'Test CPU',
  git: 'git version 2.50.1',
  memoryBytes: 16 * 1_024 ** 3,
  node: 'v22.12.0',
  operatingSystem: 'macOS 15.6',
  referenceProfile: 'local-macos-release',
};
const sourceRevision = 'sha256:fixture-product-source';
const generatedAt = new Date('2026-09-01T00:00:00.000Z');
const performance: ReferenceBenchmarkResult = {
  budgetFailures: [],
  fixture: {
    availableWorktrees: 25,
    changedFiles: 2_000,
    refs: 5_000,
    unavailableRegistrations: 1,
  },
  measurements: {
    externalChange: 800,
    fullSnapshot: 900,
    loadedInteraction: 1,
    selectedWorktree: 900,
    shell: 3,
  },
};
const manualEvidence: ManualEvidenceRecord = {
  checks: [
    {
      codexVersion: '26.901.41600 (build 7982)',
      environment: 'Codex Desktop 26.901.41600 (build 7982)',
      id: 'codex-host-smoke',
      performedAt: '2026-08-29T00:00:00.000Z',
      record:
        'docs/host-integration/codex-compatibility.md#manual-smoke-matrix',
      sourceRevision,
      status: 'passed',
      validUntil: '2026-09-29T00:00:00.000Z',
    },
    {
      codexVersion: '26.901.41600 (build 7982)',
      environment:
        'macOS 15.6; VoiceOver 10; Codex Desktop 26.901.41600 (build 7982)',
      id: 'voiceover-keyboard-smoke',
      performedAt: '2026-09-01T00:00:00.000Z',
      record:
        'docs/release/mvp-release-gate.md#voiceover-and-keyboard-smoke-record',
      sourceRevision,
      status: 'passed',
      validUntil: '2026-09-29T00:00:00.000Z',
    },
  ],
  schemaVersion: 1,
};

describe('release evidence report', () => {
  it('passes only when every automated acceptance reference passed', async () => {
    const report = await createReleaseReport(
      process.cwd(),
      passingVitestReport(),
      environment,
      performance,
      manualEvidence,
      sourceRevision,
      generatedAt,
    );

    expect(report.status).toBe('passed');
    expect(report.criteria).toHaveLength(24);
    expect(report.markdown).toContain(
      '| AC-24 | Pass the supported release envelope | passed |',
    );
    expect(report.markdown).toContain('Codex | 26.901.41600 (build 7982)');
    expect(report.markdown).toContain(
      '| Full snapshot | 900 ms | 5000 ms | passed |',
    );
  });

  it('fails the owning criterion without archiving raw test failure text', async () => {
    const vitest = passingVitestReport();
    const firstResult = vitest.testResults[0]?.assertionResults[0];
    if (firstResult === undefined) throw new Error('Expected test evidence');
    firstResult.status = 'failed';
    firstResult.failureMessages = ['credential_token=do-not-archive'];

    const report = await createReleaseReport(
      process.cwd(),
      vitest,
      environment,
      performance,
      manualEvidence,
      sourceRevision,
      generatedAt,
    );

    expect(report.status).toBe('failed');
    expect(report.criteria.find(({ id }) => id === 'AC-01')?.status).toBe(
      'failed',
    );
    expect(JSON.stringify(report)).not.toContain('do-not-archive');
  });

  it('blocks AC-24 while a required manual check is pending', async () => {
    const pending: ManualEvidenceRecord = {
      ...manualEvidence,
      checks: manualEvidence.checks.map((check) =>
        check.id === 'voiceover-keyboard-smoke'
          ? {
              codexVersion: null,
              environment: null,
              id: check.id,
              performedAt: null,
              record: null,
              sourceRevision: null,
              status: 'pending' as const,
              validUntil: null,
            }
          : check,
      ),
    };

    const report = await createReleaseReport(
      process.cwd(),
      passingVitestReport(),
      environment,
      performance,
      pending,
      sourceRevision,
      generatedAt,
    );

    expect(report.status).toBe('failed');
    expect(report.criteria.find(({ id }) => id === 'AC-24')?.status).toBe(
      'failed',
    );
  });

  it('blocks AC-24 for stale or missing manual evidence', async () => {
    const invalid: ManualEvidenceRecord = {
      ...manualEvidence,
      checks: manualEvidence.checks.map((check) =>
        check.id === 'voiceover-keyboard-smoke'
          ? {
              ...check,
              record: 'docs/release/missing-voiceover-record.md',
              sourceRevision: 'sha256:stale-product-source',
            }
          : check,
      ),
    };

    const report = await createReleaseReport(
      process.cwd(),
      passingVitestReport(),
      environment,
      performance,
      invalid,
      sourceRevision,
      generatedAt,
    );

    expect(report.criteria.find(({ id }) => id === 'AC-24')?.status).toBe(
      'failed',
    );
  });

  it('blocks manual evidence recorded against a different Codex build', async () => {
    const mismatched: ManualEvidenceRecord = {
      ...manualEvidence,
      checks: manualEvidence.checks.map((check) => ({
        ...check,
        codexVersion: '26.818.41509 (build 6962)',
      })),
    };

    const report = await createReleaseReport(
      process.cwd(),
      passingVitestReport(),
      environment,
      performance,
      mismatched,
      sourceRevision,
      generatedAt,
    );

    expect(report.criteria.find(({ id }) => id === 'AC-24')?.status).toBe(
      'failed',
    );
  });

  it('fails AC-24 when a performance budget or environment requirement fails', async () => {
    const report = await createReleaseReport(
      process.cwd(),
      passingVitestReport(),
      { ...environment, referenceProfile: 'unapproved' },
      { ...performance, budgetFailures: ['shell exceeded its budget'] },
      manualEvidence,
      sourceRevision,
      generatedAt,
    );

    const releaseEnvelope = report.criteria.find(({ id }) => id === 'AC-24');
    expect(releaseEnvelope?.status).toBe('failed');
    expect(releaseEnvelope?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'performance', status: 'failed' }),
        expect.objectContaining({ kind: 'environment', status: 'failed' }),
      ]),
    );
  });
});

function passingVitestReport(): VitestJsonReport {
  const byFile = new Map<
    string,
    VitestJsonReport['testResults'][number]['assertionResults']
  >();
  for (const criterion of MVP_ACCEPTANCE_CRITERIA) {
    for (const evidence of criterion.evidence) {
      if (evidence.kind !== 'automated') continue;
      const assertionResults = byFile.get(evidence.file) ?? [];
      if (!assertionResults.some(({ title }) => title === evidence.test)) {
        assertionResults.push({
          failureMessages: [],
          status: 'passed',
          title: evidence.test,
        });
      }
      byFile.set(evidence.file, assertionResults);
    }
  }

  return {
    success: true,
    testResults: [...byFile].map(([file, assertionResults]) => ({
      assertionResults,
      name: `${process.cwd()}/${file}`,
    })),
  };
}
