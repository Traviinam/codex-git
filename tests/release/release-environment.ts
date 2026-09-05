import { execFile } from 'node:child_process';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { promisify } from 'node:util';

import type { ReleaseEnvironment } from './release-report.js';

const executeFile = promisify(execFile);

export interface ReleaseEnvironmentSource {
  readonly architecture: string;
  readonly codexVersion: string;
  readonly cpu: string;
  readonly memoryBytes: number;
  readonly nodeVersion: string;
  readonly operatingSystem: NodeJS.Platform;
  readonly operatingSystemRelease: string;
  readonly referenceProfile: string;
  run(command: string, args: readonly string[]): Promise<string>;
}

export async function collectReleaseEnvironment(
  source: ReleaseEnvironmentSource = systemEnvironmentSource(),
): Promise<ReleaseEnvironment> {
  const git = (await source.run('git', ['--version'])).trim();
  const operatingSystem =
    source.operatingSystem === 'darwin'
      ? `macOS ${(await source.run('sw_vers', ['-productVersion'])).trim()} (Darwin ${source.operatingSystemRelease})`
      : `${source.operatingSystem} ${source.operatingSystemRelease}`;

  return {
    architecture: source.architecture,
    codex: source.codexVersion,
    cpu: source.cpu,
    git,
    memoryBytes: source.memoryBytes,
    node: source.nodeVersion,
    operatingSystem,
    referenceProfile: source.referenceProfile,
  };
}

export const SUPPORTED_CODEX_RELEASE_VERSION =
  '26.901.41600 (build 7982)' as const;

export function validateReleaseEnvironment(
  environment: ReleaseEnvironment,
): string[] {
  const failures: string[] = [];
  if (!environment.operatingSystem.startsWith('macOS ')) {
    failures.push('The release benchmark must run on macOS.');
  }
  if (
    environment.referenceProfile !== 'github-actions-macos-15' &&
    environment.referenceProfile !== 'local-macos-release'
  ) {
    failures.push(
      'The release benchmark requires an approved reference profile.',
    );
  }
  if (environment.codex !== SUPPORTED_CODEX_RELEASE_VERSION) {
    failures.push(
      `The release benchmark requires Codex Desktop ${SUPPORTED_CODEX_RELEASE_VERSION}.`,
    );
  }
  return failures;
}

function systemEnvironmentSource(): ReleaseEnvironmentSource {
  return {
    architecture: arch(),
    codexVersion: process.env.CODEX_DESKTOP_VERSION ?? 'not recorded',
    cpu: cpus()[0]?.model ?? 'unknown',
    memoryBytes: totalmem(),
    nodeVersion: process.version,
    operatingSystem: platform(),
    operatingSystemRelease: release(),
    referenceProfile: process.env.CODEX_GIT_REFERENCE_PROFILE ?? 'unapproved',
    async run(command, args) {
      const result = await executeFile(command, [...args], {
        encoding: 'utf8',
      });
      return result.stdout;
    },
  };
}
