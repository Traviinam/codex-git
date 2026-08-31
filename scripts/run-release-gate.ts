import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { writeReleaseArtifacts } from '../tests/release/release-artifacts.js';
import { collectReleaseEnvironment } from '../tests/release/release-environment.js';
import {
  createReleaseReport,
  type VitestJsonReport,
} from '../tests/release/release-report.js';
import { runReferenceBenchmark } from '../tests/release/reference-benchmark.js';
import {
  collectProductSourceRevision,
  readManualEvidence,
} from '../tests/release/manual-evidence.js';

const executeFile = promisify(execFile);
const root = process.cwd();
const artifactDirectory = resolve(
  root,
  process.env.CODEX_GIT_RELEASE_ARTIFACTS ?? 'artifacts/release-gate',
);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'codex-git-release-gate-'),
);
const rawReportPath = join(temporaryDirectory, 'vitest.json');
const manualEvidencePath = resolve(
  root,
  process.env.CODEX_GIT_MANUAL_EVIDENCE ?? 'docs/release/manual-evidence.json',
);
let testProcessPassed = true;

try {
  try {
    await executeFile(
      process.execPath,
      [
        resolve(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--reporter=json',
        `--outputFile=${rawReportPath}`,
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1_024 * 1_024 },
    );
  } catch {
    testProcessPassed = false;
  }

  const vitest = JSON.parse(
    await readFile(rawReportPath, 'utf8'),
  ) as VitestJsonReport;
  const report = await createReleaseReport(
    root,
    vitest,
    await collectReleaseEnvironment(),
    await runReferenceBenchmark(),
    await readManualEvidence(manualEvidencePath),
    await collectProductSourceRevision(root),
  );
  const artifacts = await writeReleaseArtifacts(artifactDirectory, report);

  console.log(`Release gate: ${report.status}`);
  console.log(`Acceptance matrix: ${artifacts.markdown}`);
  console.log(`Machine evidence: ${artifacts.json}`);
  if (!testProcessPassed || report.status !== 'passed') process.exitCode = 1;
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
