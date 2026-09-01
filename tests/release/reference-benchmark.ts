import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { AbsolutePath } from '@codex-git/protocol';
import {
  startStandaloneRuntime,
  type StandaloneRuntime,
} from '@codex-git/launcher';
import { createRepositoryEngine } from '@codex-git/repository-engine';

import {
  evaluatePerformanceBudget,
  type PerformanceMeasurements,
} from './performance-budget.js';
import { SUPPORTED_SCALE } from './release-envelope.js';
import { measureProtocolReleaseUi } from './ui-benchmark.js';

const executeFile = promisify(execFile);
export interface ReferenceBenchmarkResult {
  readonly budgetFailures: readonly string[];
  readonly fixture: {
    readonly availableWorktrees: number;
    readonly changedFiles: number;
    readonly refs: number;
    readonly unavailableRegistrations: number;
  };
  readonly measurements: PerformanceMeasurements;
}

export async function runReferenceBenchmark(): Promise<ReferenceBenchmarkResult> {
  const samples: ReferenceBenchmarkResult[] = [];
  for (let index = 0; index < 3; index += 1) {
    samples.push(await runReferenceBenchmarkSample());
  }
  return aggregateReferenceBenchmarkSamples(samples);
}

export function aggregateReferenceBenchmarkSamples(
  samples: readonly ReferenceBenchmarkResult[],
): ReferenceBenchmarkResult {
  const first = samples[0];
  if (first === undefined || samples.length % 2 === 0) {
    throw new Error('Reference benchmark requires an odd number of samples.');
  }
  const fixture = JSON.stringify(first.fixture);
  if (samples.some((sample) => JSON.stringify(sample.fixture) !== fixture)) {
    throw new Error('Reference benchmark sample fixtures do not match.');
  }
  const measurementNames = [
    'externalChange',
    'fullSnapshot',
    'loadedInteraction',
    'selectedWorktree',
    'shell',
  ] as const;
  const measurements = roundMeasurements(
    Object.fromEntries(
      measurementNames.map((name) => {
        const values = samples
          .map((sample) => sample.measurements[name])
          .toSorted((left, right) => left - right);
        return [name, values[Math.floor(values.length / 2)]];
      }),
    ) as unknown as PerformanceMeasurements,
  );
  return {
    budgetFailures: evaluatePerformanceBudget(measurements),
    fixture: first.fixture,
    measurements,
  };
}

async function runReferenceBenchmarkSample(): Promise<ReferenceBenchmarkResult> {
  const root = await mkdtemp(join(tmpdir(), 'codex-git-reference-'));
  const main = join(root, 'main');
  let session: Awaited<
    ReturnType<ReturnType<typeof createRepositoryEngine>['open']>
  > | null = null;
  let runtime: StandaloneRuntime | null = null;

  try {
    await createGitFixture(root, main);
    const engine = createRepositoryEngine();
    session = await engine.open(main as AbsolutePath);
    const opened = await session.snapshot();
    if (opened.kind !== 'repository') {
      throw new Error('The reference fixture did not open as a Repository.');
    }

    const availableWorktrees = opened.repository.worktrees.filter(
      (worktree) => worktree.availability.kind === 'available',
    ).length;
    const unavailableRegistrations =
      opened.repository.worktrees.length - availableWorktrees;
    const changedFiles = opened.repository.worktrees.reduce(
      (total, worktree) => total + worktree.changes.length,
      0,
    );
    const selected = opened.repository.selectedWorktreeId;
    if (selected === null)
      throw new Error('The reference fixture was not selected.');
    const branches = await session.searchBranches({
      query: '',
      worktreeId: selected,
    });
    await session.close();
    session = null;
    runtime = await startStandaloneRuntime({
      projectPath: main,
      surfacePort: 0,
    });
    const ui = await measureProtocolReleaseUi({
      externalDisplayPath: 'external-visible-change.txt',
      mutateExternal: () =>
        writeFile(
          join(main, 'external-visible-change.txt'),
          'external change\n',
          'utf8',
        ),
      projectPath: main,
      sessionUrl: runtime.sessionUrl,
      surfaceUrl: runtime.surfaceUrl,
    });
    const measurements = roundMeasurements({
      externalChange: ui.externalChange,
      fullSnapshot: ui.fullSnapshot,
      loadedInteraction: ui.loadedInteraction,
      selectedWorktree: ui.shell + ui.selectedWorktreeRender,
      shell: ui.shell,
    });
    const fixture = {
      availableWorktrees,
      changedFiles,
      refs: branches.candidates.length,
      unavailableRegistrations,
    };
    if (
      fixture.availableWorktrees !== SUPPORTED_SCALE.availableWorktrees ||
      fixture.changedFiles !== SUPPORTED_SCALE.changedFiles ||
      fixture.refs !== SUPPORTED_SCALE.refs ||
      fixture.unavailableRegistrations !==
        SUPPORTED_SCALE.unavailableRegistrations
    ) {
      throw new Error(
        `Reference fixture cardinality mismatch: ${JSON.stringify(fixture)}`,
      );
    }

    return {
      budgetFailures: evaluatePerformanceBudget(measurements),
      fixture,
      measurements,
    };
  } finally {
    await runtime?.close();
    await session?.close();
    await rm(root, { force: true, recursive: true });
  }
}

async function createGitFixture(root: string, main: string): Promise<string[]> {
  await mkdir(main, { recursive: true });
  await git(main, ['init', '--quiet']);
  await git(main, ['config', 'user.name', 'Codex Git Release Gate']);
  await git(main, ['config', 'user.email', 'release-gate@example.test']);
  await git(main, ['remote', 'add', 'origin', join(root, 'remote.git')]);
  await writeFile(join(main, 'README.md'), 'release fixture\n', 'utf8');
  await git(main, ['add', '--', 'README.md']);
  await git(main, ['commit', '--quiet', '-m', 'Create release fixture']);

  const availableWorktreePaths = [main];
  for (let index = 1; index < SUPPORTED_SCALE.availableWorktrees; index += 1) {
    const branch = `release-worktree-${String(index).padStart(2, '0')}`;
    const path = join(root, `worktree-${String(index).padStart(2, '0')}`);
    await git(main, ['branch', branch]);
    await git(main, ['worktree', 'add', '--quiet', path, branch]);
    availableWorktreePaths.push(path);
  }

  const unavailablePath = join(root, 'unavailable-registration');
  await git(main, ['branch', 'release-unavailable']);
  await git(main, [
    'worktree',
    'add',
    '--quiet',
    unavailablePath,
    'release-unavailable',
  ]);
  await rm(unavailablePath, { force: true, recursive: true });

  const filesPerWorktree =
    SUPPORTED_SCALE.changedFiles / SUPPORTED_SCALE.availableWorktrees;
  for (const [worktreeIndex, path] of availableWorktreePaths.entries()) {
    const directory = join(path, 'src', `worktree-${worktreeIndex}`);
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: filesPerWorktree }, (_, fileIndex) =>
        writeFile(
          join(directory, `changed-${String(fileIndex).padStart(4, '0')}.txt`),
          `worktree ${worktreeIndex}, file ${fileIndex}\n`,
          'utf8',
        ),
      ),
    );
  }

  const objectId = (await git(main, ['rev-parse', 'HEAD'])).trim();
  const existingLocalRefs = SUPPORTED_SCALE.availableWorktrees + 1;
  const additionalLocalRefs = SUPPORTED_SCALE.refs / 2 - existingLocalRefs;
  const commands = [
    ...Array.from(
      { length: additionalLocalRefs },
      (_, index) =>
        `create refs/heads/release-local-${String(index + 1).padStart(4, '0')} ${objectId}`,
    ),
    ...Array.from(
      { length: SUPPORTED_SCALE.refs / 2 },
      (_, index) =>
        `create refs/remotes/origin/release-remote-${String(index + 1).padStart(4, '0')} ${objectId}`,
    ),
  ];
  await git(main, ['update-ref', '--stdin'], `${commands.join('\n')}\n`);
  return availableWorktreePaths;
}

async function git(
  path: string,
  args: readonly string[],
  input?: string,
): Promise<string> {
  if (input !== undefined) {
    return new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn('git', ['-C', path, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', rejectPromise);
      child.on('close', (code) => {
        if (code === 0) {
          resolvePromise(Buffer.concat(stdout).toString('utf8'));
          return;
        }
        rejectPromise(
          new Error(
            `Git fixture command failed with code ${String(code)}: ${Buffer.concat(stderr).toString('utf8')}`,
          ),
        );
      });
      child.stdin.end(input);
    });
  }
  const result = await executeFile('git', ['-C', path, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1_024 * 1_024,
  });
  return result.stdout;
}

function roundMeasurements(
  measurements: PerformanceMeasurements,
): PerformanceMeasurements {
  return Object.fromEntries(
    Object.entries(measurements).map(([name, value]) => [
      name,
      Math.round(value * 1_000) / 1_000,
    ]),
  ) as unknown as PerformanceMeasurements;
}
