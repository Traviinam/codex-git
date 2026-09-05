import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeReleaseArtifacts } from './release-artifacts.js';
import type { ReleaseReport } from './release-report.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe('release gate artifacts', () => {
  it('writes the sanitized JSON matrix and human-readable checklist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-git-release-'));
    temporaryDirectories.push(directory);
    const report = fixtureReport();

    const artifacts = await writeReleaseArtifacts(directory, report);

    expect(artifacts).toEqual({
      json: join(directory, 'acceptance-matrix.json'),
      markdown: join(directory, 'acceptance-matrix.md'),
    });
    expect(await readFile(artifacts.json, 'utf8')).toContain(
      '"status": "passed"',
    );
    expect(await readFile(artifacts.json, 'utf8')).not.toContain('markdown');
    expect(await readFile(artifacts.json, 'utf8')).not.toContain(
      'fixture-npm-secret',
    );
    expect(await readFile(artifacts.markdown, 'utf8')).toContain(
      '# Codex Git MVP release gate evidence',
    );
    expect(
      await readFile(join(directory, 'manual', 'codex-host-smoke.md'), 'utf8'),
    ).toContain('# Codex Host Adapter compatibility');
  });

  it('does not archive a manually declared record that validation rejected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-git-release-'));
    temporaryDirectories.push(directory);
    const fixture = fixtureReport();
    const report: ReleaseReport = {
      ...fixture,
      criteria: fixture.criteria.map((criterion) => ({
        ...criterion,
        evidence: criterion.evidence.map((evidence) =>
          evidence.kind === 'manual'
            ? { ...evidence, status: 'failed' as const }
            : evidence,
        ),
        status: 'failed',
      })),
      status: 'failed',
    };

    await writeReleaseArtifacts(directory, report);

    await expect(
      readFile(join(directory, 'manual', 'codex-host-smoke.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function fixtureReport(): ReleaseReport {
  return {
    criteria: [
      {
        evidence: [
          {
            kind: 'automated',
            reference: 'tests/example.test.ts::passes safely',
            status: 'passed',
          },
          {
            checkId: 'codex-host-smoke',
            kind: 'manual',
            reference:
              'docs/host-integration/codex-compatibility.md#manual-smoke-matrix',
            status: 'passed',
          },
        ],
        id: 'AC-01',
        status: 'passed',
        title: 'Resolve the Current Project',
      },
    ],
    environment: {
      architecture: 'arm64',
      codex: '26.820.60940 NPM_TOKEN=fixture-npm-secret',
      cpu: 'Test CPU',
      git: 'git version 2.50.1',
      memoryBytes: 1,
      node: 'v22.12.0',
      operatingSystem: 'macOS 15.6',
      referenceProfile: 'local-macos-release',
    },
    environmentFailures: [],
    generatedAt: '2026-09-01T00:00:00.000Z',
    markdown: '# Codex Git MVP release gate evidence\n',
    manualEvidence: {
      checks: [
        {
          codexVersion: '26.901.41600 (build 7982)',
          environment: 'Codex Desktop 26.820.60940',
          id: 'codex-host-smoke',
          performedAt: '2026-08-29T00:00:00.000Z',
          record:
            'docs/host-integration/codex-compatibility.md#manual-smoke-matrix',
          sourceRevision: 'sha256:fixture',
          status: 'passed',
          validUntil: '2026-09-29T00:00:00.000Z',
        },
      ],
      schemaVersion: 1,
    },
    performance: null,
    staticIssues: [],
    status: 'passed',
  };
}
