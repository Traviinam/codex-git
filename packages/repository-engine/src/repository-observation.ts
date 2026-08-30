import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';

import type { OpaqueIdAuthority } from '@codex-git/protocol';

import { GitReadPolicy, runSelectedFirst } from './git-read-policy.js';
import type {
  DiscoveredHead,
  DiscoveredWorktree,
  RepositoryDiscovery,
} from './repository-engine.js';
import {
  observeRemotes,
  type RemoteIdentityState,
  type RemoteSnapshot,
} from './remote-observation.js';

const DEFAULT_GIT_READ_CONCURRENCY = 4;
const MAX_COHERENCE_ATTEMPTS = 3;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export interface RefSnapshot {
  readonly kind: 'local' | 'remote_tracking';
  readonly fullName: string;
  readonly objectId: string;
}

export interface SharedRepositoryObservation {
  readonly refs: readonly RefSnapshot[];
  readonly remotes: readonly RemoteSnapshot[];
  readonly privateRefsEvidence: string;
}

export interface IndexSnapshot {
  readonly entryCount: number;
  readonly fingerprint: string;
  readonly locked: boolean;
}

export interface WorktreeStatusSummary {
  readonly clean: boolean;
  readonly conflicted: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
}

export interface WorktreeObservationError {
  readonly code: 'git_read_failed' | 'git_output_too_large';
  readonly message: string;
}

export type WorktreeObservation =
  | {
      readonly kind: 'fresh';
      readonly worktreeId: DiscoveredWorktree['worktreeId'];
      readonly head: DiscoveredHead;
      readonly index: IndexSnapshot;
      readonly status: WorktreeStatusSummary;
    }
  | {
      readonly kind: 'unavailable';
      readonly worktreeId: DiscoveredWorktree['worktreeId'];
    }
  | {
      readonly kind: 'failed';
      readonly worktreeId: DiscoveredWorktree['worktreeId'];
      readonly error: WorktreeObservationError;
    };

export interface RepositoryObservation {
  readonly shared: SharedRepositoryObservation;
  readonly worktrees: readonly WorktreeObservation[];
}

export type GitReader = (
  args: readonly string[],
  allowLargeOutput: boolean,
) => Promise<Uint8Array>;

export interface RepositoryObserver {
  observe(discovery: RepositoryDiscovery): Promise<RepositoryObservation>;
}

export function createRepositoryObserver(
  readGit: GitReader,
  ids: OpaqueIdAuthority,
  remoteIdentity: RemoteIdentityState,
  maximumConcurrency = DEFAULT_GIT_READ_CONCURRENCY,
): RepositoryObserver {
  const reads = new GitReadPolicy(maximumConcurrency);

  return {
    async observe(discovery) {
      let sharedBefore = await observeShared(
        discovery,
        reads,
        readGit,
        ids,
        remoteIdentity,
      );
      for (let attempt = 0; attempt < MAX_COHERENCE_ATTEMPTS; attempt += 1) {
        const worktrees = await runSelectedFirst(
          discovery.worktrees,
          ({ worktreeId }) => worktreeId === discovery.selectedWorktreeId,
          (worktree) => observeWorktree(worktree, reads, readGit),
        );
        const sharedAfter = await observeShared(
          discovery,
          reads,
          readGit,
          ids,
          remoteIdentity,
        );
        if (sameSharedObservation(sharedBefore, sharedAfter)) {
          return { shared: sharedAfter, worktrees };
        }
        sharedBefore = sharedAfter;
      }
      throw new Error(
        'Git refs or Remote configuration changed during observation.',
      );
    },
  };
}

async function observeShared(
  discovery: RepositoryDiscovery,
  reads: GitReadPolicy,
  readGit: GitReader,
  ids: OpaqueIdAuthority,
  remoteIdentity: RemoteIdentityState,
): Promise<SharedRepositoryObservation> {
  const contextArgs = remoteContext(discovery);
  const [refsOutput, remoteObservation] = await Promise.all([
    runRead(
      reads,
      readGit,
      [
        '--git-dir',
        discovery.commonGitDirectory,
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(symref)',
        'refs/heads',
        'refs/remotes',
      ],
      true,
    ),
    observeRemotes(
      contextArgs,
      (args, allowLargeOutput) =>
        runRead(reads, readGit, args, allowLargeOutput),
      remoteIdentity,
      ids,
    ),
  ]);
  const refs = parseRefs(refsOutput);
  return {
    refs,
    remotes: remoteObservation.remotes,
    privateRefsEvidence: JSON.stringify({
      refs,
      remotes: remoteObservation.evidence,
    }),
  };
}

function remoteContext(discovery: RepositoryDiscovery): readonly string[] {
  const selected = discovery.worktrees.find(
    ({ worktreeId, canonicalPath, availability }) =>
      worktreeId === discovery.selectedWorktreeId &&
      canonicalPath !== null &&
      availability.kind === 'available',
  );
  const available =
    selected ??
    discovery.worktrees.find(
      ({ canonicalPath, availability }) =>
        canonicalPath !== null && availability.kind === 'available',
    );
  return available?.canonicalPath === null || available === undefined
    ? ['--git-dir', discovery.commonGitDirectory]
    : ['-C', available.canonicalPath];
}

async function observeWorktree(
  worktree: DiscoveredWorktree,
  reads: GitReadPolicy,
  readGit: GitReader,
): Promise<WorktreeObservation> {
  if (
    worktree.availability.kind === 'unavailable' ||
    worktree.canonicalPath === null
  ) {
    return { kind: 'unavailable', worktreeId: worktree.worktreeId };
  }

  try {
    const { indexOutput, statusOutput } = await readCoherentWorktree(
      worktree.canonicalPath,
      reads,
      readGit,
    );
    const indexPathOutput = await runRead(
      reads,
      readGit,
      [
        '-C',
        worktree.canonicalPath,
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'index',
      ],
      false,
    );
    const observed = summarizeStatus(statusOutput, worktree.head);
    const indexPath = decodeLine(indexPathOutput);
    return {
      kind: 'fresh',
      worktreeId: worktree.worktreeId,
      head: observed.head,
      index: {
        entryCount: splitNul(indexOutput).filter((entry) => entry.length > 0)
          .length,
        fingerprint: fingerprintBytes(indexOutput),
        locked: await pathExists(`${indexPath}.lock`),
      },
      status: observed.status,
    };
  } catch (error) {
    return {
      kind: 'failed',
      worktreeId: worktree.worktreeId,
      error: classifyWorktreeError(error),
    };
  }
}

async function readCoherentWorktree(
  canonicalPath: NonNullable<DiscoveredWorktree['canonicalPath']>,
  reads: GitReadPolicy,
  readGit: GitReader,
): Promise<{
  readonly indexOutput: Uint8Array;
  readonly statusOutput: Uint8Array;
}> {
  for (let attempt = 0; attempt < MAX_COHERENCE_ATTEMPTS; attempt += 1) {
    const indexBefore = await runRead(
      reads,
      readGit,
      ['-C', canonicalPath, 'ls-files', '--stage', '-z'],
      true,
    );
    const statusOutput = await runRead(
      reads,
      readGit,
      [
        '-C',
        canonicalPath,
        'status',
        '--porcelain=v2',
        '-z',
        '--branch',
        '--no-renames',
        '--untracked-files=all',
      ],
      true,
    );
    const indexAfter = await runRead(
      reads,
      readGit,
      ['-C', canonicalPath, 'ls-files', '--stage', '-z'],
      true,
    );
    if (Buffer.from(indexBefore).equals(Buffer.from(indexAfter))) {
      return { indexOutput: indexAfter, statusOutput };
    }
  }
  throw new Error('Git Index changed during observation.');
}

function runRead(
  policy: GitReadPolicy,
  readGit: GitReader,
  args: readonly string[],
  allowLargeOutput: boolean,
): Promise<Uint8Array> {
  return policy.run(JSON.stringify([allowLargeOutput, args]), async () =>
    readGit(args, allowLargeOutput),
  );
}

function parseRefs(output: Uint8Array): readonly RefSnapshot[] {
  const refs: RefSnapshot[] = [];
  for (const line of decode(output).split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const [fullName = '', objectId = '', symbolicTarget = ''] =
      line.split('\0');
    const kind = fullName.startsWith('refs/heads/')
      ? 'local'
      : fullName.startsWith('refs/remotes/')
        ? 'remote_tracking'
        : null;
    if (kind !== null && symbolicTarget.length === 0 && isObjectId(objectId)) {
      refs.push({ kind, fullName, objectId });
    }
  }
  return refs;
}

function summarizeStatus(
  output: Uint8Array,
  fallbackHead: DiscoveredHead,
): { readonly head: DiscoveredHead; readonly status: WorktreeStatusSummary } {
  let branchHead: string | undefined;
  let branchObjectId: string | undefined;
  let conflicted = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const field of splitNul(output)) {
    if (field.length < 2) {
      continue;
    }
    const kind = String.fromCharCode(field[0] ?? 0);
    if (kind === '#') {
      const header = decode(field);
      if (header.startsWith('# branch.head ')) {
        branchHead = header.slice('# branch.head '.length);
      } else if (header.startsWith('# branch.oid ')) {
        branchObjectId = header.slice('# branch.oid '.length);
      }
      continue;
    }
    if (kind === '?') {
      untracked += 1;
      continue;
    }
    if (kind === 'u') {
      conflicted += 1;
      continue;
    }
    if (kind !== '1' && kind !== '2') {
      continue;
    }
    if (String.fromCharCode(field[2] ?? 0x2e) !== '.') {
      staged += 1;
    }
    if (String.fromCharCode(field[3] ?? 0x2e) !== '.') {
      unstaged += 1;
    }
  }

  return {
    head: observedHead(branchHead, branchObjectId, fallbackHead),
    status: {
      clean: conflicted + staged + unstaged + untracked === 0,
      conflicted,
      staged,
      unstaged,
      untracked,
    },
  };
}

function observedHead(
  branchHead: string | undefined,
  branchObjectId: string | undefined,
  fallback: DiscoveredHead,
): DiscoveredHead {
  if (branchHead === undefined || branchObjectId === undefined) {
    throw new Error('Git status did not identify the Worktree HEAD.');
  }
  const objectId =
    branchObjectId === '(initial)'
      ? null
      : isObjectId(branchObjectId)
        ? branchObjectId
        : undefined;
  if (objectId === undefined) {
    throw new Error('Git status returned an invalid HEAD object ID.');
  }
  if (branchHead === '(detached)') {
    if (objectId === null) {
      throw new Error('A detached Worktree must identify a Commit.');
    }
    return { kind: 'detached', objectId };
  }
  if (branchHead.startsWith('(')) {
    throw new Error('Git status returned an unsupported HEAD state.');
  }
  return {
    kind: 'local_branch',
    fullName:
      fallback.kind === 'local_branch' && fallback.displayName === branchHead
        ? fallback.fullName
        : `refs/heads/${branchHead}`,
    displayName: branchHead,
    objectId,
  };
}

function classifyWorktreeError(error: unknown): WorktreeObservationError {
  if (
    error instanceof Error &&
    'failure' in error &&
    error.failure === 'output_too_large'
  ) {
    return {
      code: 'git_output_too_large',
      message: 'Git output exceeded this Worktree observation limit.',
    };
  }
  return {
    code: 'git_read_failed',
    message: 'Git could not observe this Worktree.',
  };
}

function splitNul(output: Uint8Array): readonly Uint8Array[] {
  const fields: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] === 0) {
      fields.push(output.subarray(start, index));
      start = index + 1;
    }
  }
  fields.push(output.subarray(start));
  return fields;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false;
    }
    throw error;
  }
}

function sameSharedObservation(
  left: SharedRepositoryObservation,
  right: SharedRepositoryObservation,
): boolean {
  return left.privateRefsEvidence === right.privateRefsEvidence;
}

function fingerprintBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value);
}

function decodeLine(output: Uint8Array): string {
  return decode(output).replace(/\r?\n$/u, '');
}

function decode(output: Uint8Array): string {
  return textDecoder.decode(output);
}
