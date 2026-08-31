import { access, realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';

import type { RepositorySnapshot } from './repository-publication.js';
import { fingerprintChangedFileTarget } from './repository-observation.js';
import { parseWorktreeListPorcelain } from './worktree-porcelain.js';

export type FileMutationTarget =
  RepositorySnapshot['worktrees'][number]['changes'][number];

export interface FileMutationInspection {
  readonly commonGitDirectory: string;
  readonly worktreePath: string;
  readonly topologyEvidence: string;
  readonly blockedBy: 'git_lock' | 'index_lock' | 'operation' | null;
  readonly targetFingerprints: readonly string[];
}

export type FileMutationInspector = (
  worktree: RepositorySnapshot['worktrees'][number],
  targets: readonly FileMutationTarget[],
  signal: AbortSignal,
) => Promise<FileMutationInspection>;

type GitRunner = (
  args: readonly string[],
  allowLargeOutput: boolean,
  acceptedEmptyExitCode?: 1,
  signal?: AbortSignal,
  maximumOutputBytes?: number,
  input?: Uint8Array,
) => Promise<Uint8Array>;

const operationMarkers = [
  'rebase-merge',
  'rebase-apply',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
] as const;

export function createFileMutationInspector(
  runGit: GitRunner,
): FileMutationInspector {
  return async (worktree, targets, signal) => {
    if (worktree.canonicalPath === null) {
      throw new Error('Cannot inspect an unavailable Worktree.');
    }
    const path = worktree.canonicalPath;
    const paths = targets.flatMap((target) =>
      target.previousPathBytes === null
        ? [target.pathBytes]
        : [target.pathBytes, target.previousPathBytes],
    );
    const [identityOutput, gitPathsOutput, registrationsOutput, headOutput] =
      await Promise.all([
        runGit(
          [
            '-C',
            path,
            'rev-parse',
            '--path-format=absolute',
            '--git-common-dir',
            '--show-toplevel',
            '--git-dir',
          ],
          false,
          undefined,
          signal,
        ),
        runGit(
          [
            '-C',
            path,
            'rev-parse',
            '--path-format=absolute',
            '--git-path',
            'index',
            ...operationMarkers.flatMap((marker) => ['--git-path', marker]),
          ],
          false,
          undefined,
          signal,
        ),
        runGit(
          ['-C', path, 'worktree', 'list', '--porcelain', '-z'],
          false,
          undefined,
          signal,
        ),
        runGit(
          ['-C', path, 'rev-parse', '--verify', '--quiet', 'HEAD'],
          false,
          1,
          signal,
        ),
      ]);
    const [commonPath, worktreePath, gitDirectory] = lines(identityOutput);
    const [indexPath, ...markerPaths] = lines(gitPathsOutput);
    if (
      commonPath === undefined ||
      worktreePath === undefined ||
      gitDirectory === undefined ||
      indexPath === undefined ||
      markerPaths.length !== operationMarkers.length
    ) {
      throw new Error('Git returned incomplete mutation inspection paths.');
    }
    const [canonicalCommon, canonicalWorktree, canonicalGitDirectory] =
      await Promise.all([
        realpath(commonPath),
        realpath(worktreePath),
        realpath(gitDirectory),
      ]);
    const registration = parseWorktreeListPorcelain(registrationsOutput).find(
      ({ pathBytes }) =>
        Buffer.from(pathBytes).equals(Buffer.from(canonicalWorktree)),
    );
    if (registration === undefined) {
      throw new Error('The Worktree registration disappeared.');
    }
    const [
      commonMetadata,
      worktreeMetadata,
      gitMetadata,
      indexLocked,
      markers,
    ] = await Promise.all([
      stat(canonicalCommon),
      stat(canonicalWorktree),
      stat(canonicalGitDirectory),
      pathExists(`${indexPath}.lock`),
      Promise.all(markerPaths.map((markerPath) => pathExists(markerPath))),
    ]);
    const indexEvidence = await readIndexEvidence(runGit, path, paths, signal);
    let evidenceIndex = 0;
    const headObjectId = decodeLine(headOutput) || null;
    const targetFingerprints: string[] = [];
    for (const target of targets) {
      const targetPathCount = target.previousPathBytes === null ? 1 : 2;
      targetFingerprints.push(
        await fingerprintChangedFileTarget(
          canonicalWorktree,
          headObjectId,
          target,
          indexEvidence.slice(evidenceIndex, evidenceIndex + targetPathCount),
        ),
      );
      evidenceIndex += targetPathCount;
    }
    return {
      commonGitDirectory: canonicalCommon,
      worktreePath: canonicalWorktree,
      topologyEvidence: [
        fileIdentity(commonMetadata),
        Buffer.from(canonicalWorktree).toString('base64'),
        fileIdentity(worktreeMetadata),
        canonicalGitDirectory,
        fileIdentity(gitMetadata),
      ].join('\0'),
      blockedBy: registration.locked
        ? 'git_lock'
        : indexLocked
          ? 'index_lock'
          : markers.some(Boolean)
            ? 'operation'
            : null,
      targetFingerprints,
    };
  };
}

async function readIndexEvidence(
  runGit: GitRunner,
  worktreePath: string,
  paths: readonly Uint8Array[],
  signal: AbortSignal,
): Promise<readonly string[]> {
  if (paths.length === 0) return [];
  const input = Buffer.concat(
    paths.flatMap((path) => [
      Buffer.from(':'),
      Buffer.from(path),
      Buffer.from([0]),
    ]),
  );
  const output = await runGit(
    ['-C', worktreePath, 'cat-file', '--batch-check=%(objectname)', '-Z'],
    false,
    undefined,
    signal,
    undefined,
    input,
  );
  const records = splitNul(output);
  if (records.length !== paths.length) {
    throw new Error('Git returned incomplete Index evidence.');
  }
  return records.map((record) => {
    const value = Buffer.from(record).toString();
    return /^[0-9a-f]{40,64}$/u.test(value) ? `${value} 0` : 'missing';
  });
}

function lines(output: Uint8Array): readonly string[] {
  return Buffer.from(output)
    .toString()
    .replace(/\r?\n$/u, '')
    .split(/\r?\n/u);
}

function decodeLine(output: Uint8Array): string {
  return Buffer.from(output)
    .toString()
    .replace(/\r?\n$/u, '');
}

function splitNul(output: Uint8Array): readonly Uint8Array[] {
  const records: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    records.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start < output.length) records.push(output.subarray(start));
  return records;
}

function fileIdentity(metadata: Stats): string {
  return `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
