import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { redactDiagnostic } from '@codex-git/protocol';

import type { ReleaseReport } from './release-report.js';

export interface ReleaseArtifactPaths {
  readonly json: string;
  readonly markdown: string;
}

export async function writeReleaseArtifacts(
  directory: string,
  report: ReleaseReport,
  root = process.cwd(),
): Promise<ReleaseArtifactPaths> {
  await mkdir(directory, { recursive: true });
  const paths = {
    json: join(directory, 'acceptance-matrix.json'),
    markdown: join(directory, 'acceptance-matrix.md'),
  };
  const json = {
    criteria: report.criteria,
    environment: report.environment,
    environmentFailures: report.environmentFailures,
    generatedAt: report.generatedAt,
    manualEvidence: report.manualEvidence,
    performance: report.performance,
    staticIssues: report.staticIssues,
    status: report.status,
  };

  const sanitize = (_key: string, value: unknown) =>
    typeof value === 'string' ? redactDiagnostic(value) : value;
  await Promise.all([
    writeFile(paths.json, `${JSON.stringify(json, sanitize, 2)}\n`, 'utf8'),
    writeFile(paths.markdown, redactDiagnostic(report.markdown), 'utf8'),
    archiveManualRecords(directory, root, report),
  ]);
  return paths;
}

async function archiveManualRecords(
  directory: string,
  root: string,
  report: ReleaseReport,
): Promise<void> {
  const manualDirectory = join(directory, 'manual');
  const expectedRoot = resolve(root);
  const validatedCheckIds = new Set(
    report.criteria.flatMap((criterion) =>
      criterion.evidence.flatMap((evidence) =>
        evidence.kind === 'manual' &&
        evidence.status === 'passed' &&
        evidence.checkId !== undefined
          ? [evidence.checkId]
          : [],
      ),
    ),
  );
  const records = report.manualEvidence.checks.filter(
    (check) =>
      check.status === 'passed' &&
      check.record !== null &&
      validatedCheckIds.has(check.id),
  );
  if (records.length === 0) return;
  await mkdir(manualDirectory, { recursive: true });
  await Promise.all(
    records.map(async (check) => {
      const record = check.record!.split('#', 1)[0]!;
      const source = resolve(expectedRoot, record);
      if (
        isAbsolute(record) ||
        (source !== expectedRoot && !source.startsWith(`${expectedRoot}${sep}`))
      ) {
        throw new Error(`Manual evidence path is unsafe: ${record}.`);
      }
      const content = redactDiagnostic(await readFile(source, 'utf8'));
      await writeFile(join(manualDirectory, `${check.id}.md`), content, 'utf8');
    }),
  );
}
