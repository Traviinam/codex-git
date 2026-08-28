import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export interface GitResult {
  readonly stderr: string;
  readonly stdout: string;
}

export interface TemporaryGitRepository {
  readonly path: string;
  dispose(): Promise<void>;
  git(...args: readonly string[]): Promise<GitResult>;
}

export async function createTemporaryGitRepository(): Promise<TemporaryGitRepository> {
  const path = await mkdtemp(join(tmpdir(), 'codex-git-repository-'));

  const repository: TemporaryGitRepository = {
    path,
    async dispose() {
      await rm(path, { force: true, recursive: true });
    },
    async git(...args) {
      const { stderr, stdout } = await executeFile(
        'git',
        ['-C', path, ...args],
        { encoding: 'utf8' },
      );

      return { stderr, stdout };
    },
  };

  try {
    await repository.git('init', '--quiet');
    return repository;
  } catch (error) {
    await repository.dispose();
    throw error;
  }
}
