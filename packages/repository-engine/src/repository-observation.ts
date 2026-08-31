import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, readlink } from 'node:fs/promises';

import type {
  OpaqueIdAuthority,
  RemoteId,
  WorktreeId,
} from '@codex-git/protocol';

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
import { decodeForDisplay } from './worktree-porcelain.js';

const DEFAULT_GIT_READ_CONCURRENCY = 4;
const CHANGE_FINGERPRINT_CONCURRENCY = 4;
const WORKING_FILE_HASH_LIMIT_BYTES = 4 * 1_024 * 1_024;
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
  readonly inProgressOperation?: InProgressGitOperation;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
}

export type ChangedFileObservation =
  | ChangedFileObservationBase<'conflict', 'conflict'>
  | ChangedFileObservationBase<'staged_change', 'head_to_index'>
  | ChangedFileObservationBase<'change', 'index_to_working_tree'>
  | ChangedFileObservationBase<'untracked', 'empty_to_working_tree'>;

interface ChangedFileObservationBase<
  Kind extends string,
  Baseline extends string,
> {
  readonly kind: Kind;
  readonly baseline: Baseline;
  readonly displayPath: string;
  readonly pathBytes: Uint8Array;
  readonly previousDisplayPath: string | null;
  readonly previousPathBytes: Uint8Array | null;
  readonly workingFilePresent: boolean;
  readonly baselineFingerprint?: string;
}

export type InProgressGitOperation =
  'bisect' | 'cherry-pick' | 'merge' | 'rebase' | 'revert';

export type UpstreamSnapshot =
  | {
      readonly kind: 'tracking';
      readonly remoteId: RemoteId;
      readonly displayName: string;
      readonly ref: {
        readonly kind: 'remote_tracking';
        readonly fullName: string;
        readonly objectId: string | null;
      };
      readonly aheadBehind:
        | {
            readonly kind: 'cached';
            readonly ahead: number;
            readonly behind: number;
          }
        | { readonly kind: 'unavailable' };
    }
  | { readonly kind: 'unpublished' }
  | {
      readonly kind: 'not_applicable';
      readonly reason: 'detached_head' | 'unsupported_upstream';
    }
  | { readonly kind: 'unavailable' };

export interface WorktreeObservationError {
  readonly code: 'git_read_failed' | 'git_output_too_large' | 'not_observed';
  readonly message: string;
}

export type WorktreeObservation =
  | {
      readonly kind: 'fresh';
      readonly worktreeId: DiscoveredWorktree['worktreeId'];
      readonly head: DiscoveredHead;
      readonly index: IndexSnapshot;
      readonly status: WorktreeStatusSummary;
      readonly changes: readonly ChangedFileObservation[];
      readonly upstream: UpstreamSnapshot;
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
  readonly complete?: boolean;
}

export type GitReader = (
  args: readonly string[],
  allowLargeOutput: boolean,
  acceptedEmptyExitCode?: 1,
  signal?: AbortSignal,
  maximumOutputBytes?: number,
) => Promise<Uint8Array>;

export interface RepositoryObserver {
  observe(
    discovery: RepositoryDiscovery,
    signal?: AbortSignal,
    worktreeIds?: ReadonlySet<WorktreeId>,
  ): Promise<RepositoryObservation>;
}

export function createRepositoryObserver(
  readGit: GitReader,
  ids: OpaqueIdAuthority,
  remoteIdentity: RemoteIdentityState,
  maximumConcurrency = DEFAULT_GIT_READ_CONCURRENCY,
  readPolicy?: GitReadPolicy,
  readNamespace = '',
): RepositoryObserver {
  const reads = readPolicy ?? new GitReadPolicy(maximumConcurrency);
  let observationGeneration = 0;

  return {
    async observe(discovery, signal, worktreeIds) {
      const readKeyPrefix = `${readNamespace}:${(observationGeneration += 1)}:`;
      let sharedBefore = await observeShared(
        discovery,
        reads,
        readGit,
        ids,
        remoteIdentity,
        readKeyPrefix,
        signal,
      );
      for (let attempt = 0; attempt < MAX_COHERENCE_ATTEMPTS; attempt += 1) {
        const selectedWorktrees =
          worktreeIds === undefined
            ? discovery.worktrees
            : discovery.worktrees.filter(({ worktreeId }) =>
                worktreeIds.has(worktreeId),
              );
        const worktrees = await runSelectedFirst(
          selectedWorktrees,
          ({ worktreeId }) => worktreeId === discovery.selectedWorktreeId,
          (worktree) =>
            observeWorktree(
              worktree,
              sharedBefore,
              reads,
              readGit,
              readKeyPrefix,
              signal,
            ),
        );
        const sharedAfter = await observeShared(
          discovery,
          reads,
          readGit,
          ids,
          remoteIdentity,
          readKeyPrefix,
          signal,
        );
        if (sameSharedObservation(sharedBefore, sharedAfter)) {
          return {
            shared: sharedAfter,
            worktrees,
            complete: worktreeIds === undefined,
          };
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
  readKeyPrefix: string,
  signal?: AbortSignal,
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
      undefined,
      readKeyPrefix,
      signal,
    ),
    observeRemotes(
      contextArgs,
      (args, allowLargeOutput, acceptedEmptyExitCode) =>
        runRead(
          reads,
          readGit,
          args,
          allowLargeOutput,
          acceptedEmptyExitCode,
          readKeyPrefix,
          signal,
        ),
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
  shared: SharedRepositoryObservation,
  reads: GitReadPolicy,
  readGit: GitReader,
  readKeyPrefix: string,
  signal?: AbortSignal,
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
      readKeyPrefix,
      signal,
    );
    const [indexPathOutput, operationPathsOutput] = await Promise.all([
      runRead(
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
        undefined,
        readKeyPrefix,
        signal,
      ),
      runRead(
        reads,
        readGit,
        [
          '-C',
          worktree.canonicalPath,
          'rev-parse',
          '--path-format=absolute',
          ...inProgressMarkers.flatMap(({ path }) => ['--git-path', path]),
        ],
        false,
        undefined,
        readKeyPrefix,
        signal,
      ),
    ]);
    const observed = summarizeStatus(statusOutput, worktree.head);
    const indexPath = decodeLine(indexPathOutput);
    const inProgressOperation =
      await detectInProgressOperation(operationPathsOutput);
    const changes = await fingerprintChangedFiles(
      worktree.canonicalPath,
      observed.head,
      indexOutput,
      observed.changes,
    );
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
      status:
        inProgressOperation === null
          ? observed.status
          : {
              ...observed.status,
              inProgressOperation,
            },
      changes,
      upstream: resolveUpstream(observed.upstream, shared),
    };
  } catch (error) {
    return {
      kind: 'failed',
      worktreeId: worktree.worktreeId,
      error: classifyWorktreeError(error),
    };
  }
}

const inProgressMarkers = [
  { path: 'rebase-merge', operation: 'rebase' },
  { path: 'rebase-apply', operation: 'rebase' },
  { path: 'MERGE_HEAD', operation: 'merge' },
  { path: 'CHERRY_PICK_HEAD', operation: 'cherry-pick' },
  { path: 'REVERT_HEAD', operation: 'revert' },
  { path: 'BISECT_LOG', operation: 'bisect' },
] as const;

async function detectInProgressOperation(
  pathsOutput: Uint8Array,
): Promise<InProgressGitOperation | null> {
  const paths = decode(pathsOutput)
    .replace(/\r?\n$/u, '')
    .split(/\r?\n/u);
  for (let index = 0; index < inProgressMarkers.length; index += 1) {
    const marker = inProgressMarkers[index];
    const path = paths[index];
    if (
      marker !== undefined &&
      path !== undefined &&
      (await pathExists(path))
    ) {
      return marker.operation;
    }
  }
  return null;
}

async function readCoherentWorktree(
  canonicalPath: NonNullable<DiscoveredWorktree['canonicalPath']>,
  reads: GitReadPolicy,
  readGit: GitReader,
  readKeyPrefix: string,
  signal?: AbortSignal,
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
      undefined,
      readKeyPrefix,
      signal,
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
        '--untracked-files=all',
      ],
      true,
      undefined,
      readKeyPrefix,
      signal,
    );
    const indexAfter = await runRead(
      reads,
      readGit,
      ['-C', canonicalPath, 'ls-files', '--stage', '-z'],
      true,
      undefined,
      readKeyPrefix,
      signal,
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
  acceptedEmptyExitCode?: 1,
  readKeyPrefix = '',
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return policy.run(
    `${readKeyPrefix}${JSON.stringify([
      allowLargeOutput,
      acceptedEmptyExitCode,
      args,
    ])}`,
    async () => readGit(args, allowLargeOutput, acceptedEmptyExitCode, signal),
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
): {
  readonly head: DiscoveredHead;
  readonly status: WorktreeStatusSummary;
  readonly changes: readonly ChangedFileObservation[];
  readonly upstream: ObservedUpstream;
} {
  let branchHead: string | undefined;
  let branchObjectId: string | undefined;
  let branchUpstream: string | undefined;
  let branchAheadBehind:
    { readonly ahead: number; readonly behind: number } | undefined;
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
      } else if (header.startsWith('# branch.upstream ')) {
        branchUpstream = header.slice('# branch.upstream '.length);
      } else if (header.startsWith('# branch.ab ')) {
        const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(header);
        if (match === null) {
          throw new Error('Git status returned invalid Upstream divergence.');
        }
        branchAheadBehind = {
          ahead: Number(match[1]),
          behind: Number(match[2]),
        };
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
    changes: parseChangedFiles(output),
    upstream:
      branchHead === '(detached)'
        ? { kind: 'detached' }
        : branchUpstream === undefined
          ? { kind: 'unpublished' }
          : {
              kind: 'configured',
              displayName: branchUpstream,
              aheadBehind: branchAheadBehind,
            },
  };
}

function parseChangedFiles(
  output: Uint8Array,
): readonly ChangedFileObservation[] {
  const groups: ChangedFileObservation[][] = [[], [], [], []];
  const fields = splitNul(output);
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const recordKind = String.fromCharCode(field[0] ?? 0);
    if (recordKind === '?') {
      groups[3]!.push(
        changedFile(
          'untracked',
          'empty_to_working_tree',
          field.subarray(2),
          null,
          true,
        ),
      );
      continue;
    }
    if (recordKind === 'u') {
      groups[0]!.push(
        changedFile(
          'conflict',
          'conflict',
          pathAfterFields(field, 10),
          null,
          true,
        ),
      );
      continue;
    }
    if (recordKind !== '1' && recordKind !== '2') continue;
    const path = pathAfterFields(field, recordKind === '1' ? 8 : 9);
    const previousPath =
      recordKind === '2' ? (fields[(index += 1)] ?? null) : null;
    const indexStatus = String.fromCharCode(field[2] ?? 0x2e);
    const worktreeStatus = String.fromCharCode(field[3] ?? 0x2e);
    if (indexStatus !== '.') {
      groups[1]!.push(
        changedFile(
          'staged_change',
          'head_to_index',
          path,
          isRenameOrCopy(indexStatus) ? previousPath : null,
          indexStatus !== 'D' || worktreeStatus !== '.',
        ),
      );
    }
    if (worktreeStatus !== '.') {
      groups[2]!.push(
        changedFile(
          'change',
          'index_to_working_tree',
          path,
          isRenameOrCopy(worktreeStatus) ? previousPath : null,
          worktreeStatus !== 'D',
        ),
      );
    }
  }
  return groups.flat();
}

function isRenameOrCopy(status: string): boolean {
  return status === 'R' || status === 'C';
}

function changedFile<Kind extends ChangedFileObservation['kind']>(
  kind: Kind,
  baseline: Extract<ChangedFileObservation, { kind: Kind }>['baseline'],
  pathBytes: Uint8Array,
  previousPathBytes: Uint8Array | null = null,
  workingFilePresent = true,
): Extract<ChangedFileObservation, { kind: Kind }> {
  return {
    kind,
    baseline,
    displayPath: decodeForDisplay(pathBytes),
    pathBytes: pathBytes.slice(),
    previousDisplayPath:
      previousPathBytes === null ? null : decodeForDisplay(previousPathBytes),
    previousPathBytes: previousPathBytes?.slice() ?? null,
    workingFilePresent,
  } as Extract<ChangedFileObservation, { kind: Kind }>;
}

async function fingerprintChangedFiles(
  worktreePath: string,
  head: DiscoveredHead,
  indexOutput: Uint8Array,
  changes: readonly ChangedFileObservation[],
): Promise<readonly ChangedFileObservation[]> {
  return mapWithConcurrency(
    changes,
    CHANGE_FINGERPRINT_CONCURRENCY,
    async (change) => {
      const paths = [change.pathBytes, change.previousPathBytes].filter(
        (path): path is Uint8Array => path !== null,
      );
      return withBaselineFingerprint(
        { ...change },
        await fingerprintChangedFileTarget(
          worktreePath,
          head.objectId,
          change,
          paths.map((path) => indexPathEvidence(indexOutput, path)),
        ),
      );
    },
  );
}

export async function fingerprintChangedFileTarget(
  worktreePath: string,
  headObjectId: string | null,
  change: Pick<
    ChangedFileObservation,
    'kind' | 'pathBytes' | 'previousPathBytes'
  >,
  indexEvidence: readonly string[],
): Promise<string> {
  const paths = [change.pathBytes, change.previousPathBytes].filter(
    (path): path is Uint8Array => path !== null,
  );
  const workingEvidence: string[] = [];
  for (const path of paths) {
    workingEvidence.push(await fingerprintWorkingPath(worktreePath, path));
  }
  return createHash('sha256')
    .update(change.kind)
    .update('\0')
    .update(headObjectId ?? 'initial')
    .update('\0')
    .update(fingerprintIndexEvidence(indexEvidence))
    .update('\0')
    .update(workingEvidence.join('\0'))
    .digest('hex');
}

async function fingerprintWorkingPath(
  worktreePath: string,
  relativePath: Uint8Array,
): Promise<string> {
  const path = Buffer.concat([
    Buffer.from(worktreePath),
    Buffer.from('/'),
    Buffer.from(relativePath),
  ]);
  let identity = 'unresolved';
  try {
    const metadata = await lstat(path);
    identity = `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}:${metadata.mode}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
    if (metadata.isSymbolicLink()) {
      try {
        const target = await readlink(path, { encoding: 'buffer' });
        return createHash('sha256')
          .update(`symlink\0${identity}\0`)
          .update(target)
          .digest('hex');
      } catch (error) {
        return `symlink-unreadable:${identity}:${errorCode(error)}`;
      }
    }
    if (metadata.isFile()) {
      return fingerprintRegularFile(path, identity);
    }
    return `non-file:${identity}`;
  } catch (error) {
    if (isMissingPath(error)) return 'missing';
    return `unreadable:${identity}:${errorCode(error)}`;
  }
}

async function fingerprintRegularFile(
  path: Buffer,
  identity: string,
): Promise<string> {
  const hash = createHash('sha256').update(`file\0${identity}\0`);
  let bytesRead = 0;
  try {
    for await (const value of createReadStream(path, {
      highWaterMark: 64 * 1_024,
    })) {
      const chunk = Buffer.from(value);
      const remaining = WORKING_FILE_HASH_LIMIT_BYTES - bytesRead;
      if (remaining <= 0) break;
      const accepted = chunk.subarray(0, remaining);
      hash.update(accepted);
      bytesRead += accepted.length;
      if (accepted.length < chunk.length) break;
    }
    return hash.update(`\0sampled:${bytesRead}`).digest('hex');
  } catch (error) {
    return `file-unreadable:${identity}:${errorCode(error)}`;
  }
}

function indexPathEvidence(indexOutput: Uint8Array, path: Uint8Array): string {
  const entries: string[] = [];
  for (const record of splitNul(indexOutput)) {
    const tab = record.indexOf(0x09);
    if (tab < 0) continue;
    const recordPath = record.subarray(tab + 1);
    if (!Buffer.from(path).equals(Buffer.from(recordPath))) continue;
    const firstSpace = record.indexOf(0x20);
    const secondSpace = record.indexOf(0x20, firstSpace + 1);
    if (firstSpace < 0 || secondSpace < 0) continue;
    entries.push(Buffer.from(record.subarray(firstSpace + 1, tab)).toString());
  }
  return entries.length === 0 ? 'missing' : entries.join(',');
}

function fingerprintIndexEvidence(evidence: readonly string[]): string {
  const hash = createHash('sha256');
  for (const value of evidence) hash.update(value).update('\0');
  return hash.digest('hex');
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const results = new Array<Output>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await map(values[index]!);
      }
    }),
  );
  return results;
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error
    ? String(error.code)
    : 'unknown';
}

function withBaselineFingerprint(
  change: ChangedFileObservation,
  baselineFingerprint: string,
): ChangedFileObservation {
  Object.defineProperty(change, 'baselineFingerprint', {
    configurable: false,
    enumerable: false,
    value: baselineFingerprint,
    writable: false,
  });
  return change;
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function pathAfterFields(
  record: Uint8Array,
  separatorCount: number,
): Uint8Array {
  let seen = 0;
  for (let index = 0; index < record.length; index += 1) {
    if (record[index] !== 0x20) continue;
    seen += 1;
    if (seen === separatorCount) return record.subarray(index + 1);
  }
  throw new Error('Git status returned a malformed Changed File record.');
}

type ObservedUpstream =
  | { readonly kind: 'detached' }
  | { readonly kind: 'unpublished' }
  | {
      readonly kind: 'configured';
      readonly displayName: string;
      readonly aheadBehind?: {
        readonly ahead: number;
        readonly behind: number;
      };
    };

function resolveUpstream(
  observed: ObservedUpstream,
  shared: SharedRepositoryObservation,
): UpstreamSnapshot {
  if (observed.kind === 'detached') {
    return { kind: 'not_applicable', reason: 'detached_head' };
  }
  if (observed.kind === 'unpublished') {
    return { kind: 'unpublished' };
  }
  const remote = [...shared.remotes]
    .sort((left, right) => right.displayName.length - left.displayName.length)
    .find(({ displayName }) =>
      observed.displayName.startsWith(`${displayName}/`),
    );
  if (remote === undefined) {
    return { kind: 'not_applicable', reason: 'unsupported_upstream' };
  }
  const fullName = `refs/remotes/${observed.displayName}`;
  const ref = shared.refs.find(
    (candidate) =>
      candidate.kind === 'remote_tracking' && candidate.fullName === fullName,
  );
  return {
    kind: 'tracking',
    remoteId: remote.remoteId,
    displayName: observed.displayName,
    ref: {
      kind: 'remote_tracking',
      fullName,
      objectId: ref?.objectId ?? null,
    },
    aheadBehind:
      observed.aheadBehind === undefined
        ? { kind: 'unavailable' }
        : { kind: 'cached', ...observed.aheadBehind },
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
