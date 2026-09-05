import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  collectReleaseEnvironment,
  SUPPORTED_CODEX_RELEASE_VERSION,
  validateReleaseEnvironment,
} from './release-environment.js';

describe('release environment evidence', () => {
  it('records the required hardware, macOS, Git, Node, and Codex versions', async () => {
    const environment = await collectReleaseEnvironment({
      architecture: 'arm64',
      codexVersion: '26.901.41600 (build 7982)',
      cpu: 'Apple Test CPU',
      memoryBytes: 16 * 1_024 ** 3,
      nodeVersion: 'v22.12.0',
      operatingSystem: 'darwin',
      operatingSystemRelease: '24.6.0',
      referenceProfile: 'github-actions-macos-15',
      async run(command, args) {
        if (command === 'git') return 'git version 2.50.1\n';
        if (command === 'sw_vers' && args[0] === '-productVersion') {
          return '15.6\n';
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    });

    expect(environment).toEqual({
      architecture: 'arm64',
      codex: '26.901.41600 (build 7982)',
      cpu: 'Apple Test CPU',
      git: 'git version 2.50.1',
      memoryBytes: 16 * 1_024 ** 3,
      node: 'v22.12.0',
      operatingSystem: 'macOS 15.6 (Darwin 24.6.0)',
      referenceProfile: 'github-actions-macos-15',
    });
    expect(validateReleaseEnvironment(environment)).toEqual([]);
  });

  it('rejects an unapproved or incomplete benchmark host', () => {
    expect(
      validateReleaseEnvironment({
        architecture: 'x64',
        codex: 'not recorded',
        cpu: 'Test CPU',
        git: 'git version 2.50.1',
        memoryBytes: 1,
        node: 'v22.12.0',
        operatingSystem: 'linux 6.0',
        referenceProfile: 'unapproved',
      }),
    ).toHaveLength(3);
  });

  it('keeps the macOS CI profile aligned with the supported Codex build', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain(
      `CODEX_DESKTOP_VERSION: ${SUPPORTED_CODEX_RELEASE_VERSION}`,
    );
  });
});
