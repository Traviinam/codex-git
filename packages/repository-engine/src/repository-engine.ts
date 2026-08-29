import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import {
  createOpaqueIdAuthority,
  type AbsolutePath,
  type OpaqueIdAuthority,
  type RepositoryId,
  type WorktreeGeneration,
  type WorktreeId,
} from '@codex-git/protocol';

import {
  decodeForDisplay,
  parseWorktreeListPorcelain,
  type WorktreePorcelainRecord,
} from './worktree-porcelain.js';
import {
  createRepositoryPublicationSession,
  type RepositorySession,
} from './repository-publication.js';

const GIT_OUTPUT_LIMIT_BYTES = 4 * 1_024 * 1_024;
const GIT_TIMEOUT_MILLISECONDS = 10_000;
const ZERO_OBJECT_ID = /^(?:0{40}|0{64})$/u;

export interface RepositoryDiscovery {
  readonly repositoryId: RepositoryId;
  readonly commonGitDirectory: AbsolutePath;
  readonly selectedWorktreeId: WorktreeId | null;
  readonly worktrees: readonly DiscoveredWorktree[];
}

export interface DiscoveredWorktree {
  readonly worktreeId: WorktreeId;
  readonly generation: WorktreeGeneration;
  readonly displayPath: string;
  readonly canonicalPath: AbsolutePath | null;
  readonly canonicalPathBytes: Uint8Array;
  readonly role: 'main' | 'linked';
  readonly head: DiscoveredHead;
  readonly gitLock: GitLockState;
  readonly availability: WorktreeAvailability;
}

export type DiscoveredHead =
  | {
      readonly kind: 'local_branch';
      readonly fullName: string;
      readonly displayName: string;
      readonly objectId: string | null;
    }
  | { readonly kind: 'detached'; readonly objectId: string };

export type GitLockState =
  | { readonly kind: 'unlocked' }
  | { readonly kind: 'locked'; readonly reason: string | null };

export type WorktreeAvailability =
  | { readonly kind: 'available' }
  | {
      readonly kind: 'unavailable';
      readonly reason: string;
      readonly prunable: boolean;
    };

export interface RepositoryEngine {
  open(anchor: AbsolutePath): Promise<RepositorySession>;
}

/**
 * The #6 session publishes discovery facts only. Revisioned refresh,
 * subscriptions, and product operations are added by their owning issues.
 */
interface RepositoryIdentityState {
  readonly evidence: string;
  readonly repositoryId: RepositoryId;
  generations: Map<string, WorktreeIdentityState>;
}

interface SessionState {
  generation: number;
  status: 'open' | 'closed' | 'invalid';
}

interface WorktreeIdentityState {
  readonly evidence: string;
  readonly generation: WorktreeGeneration;
  readonly worktreeId: WorktreeId;
}

interface ResolvedAnchor {
  readonly commonGitDirectory: AbsolutePath;
  readonly repositoryEvidence: string;
  readonly selectedWorktreePath: AbsolutePath;
}

interface CanonicalRegistration {
  readonly adminIdentity: string | null;
  readonly canonicalPath: AbsolutePath | null;
  readonly canonicalPathBytes: Uint8Array;
  readonly pathKey: string;
  readonly evidence: string;
  readonly record: WorktreePorcelainRecord;
  readonly unavailableReason: string | null;
}

export function createRepositoryEngine(): RepositoryEngine {
  return {
    async open(anchor) {
      const resolved = await resolveAnchor(anchor);
      const ids = createOpaqueIdAuthority();
      const state: SessionState = { generation: 0, status: 'open' };

      if (resolved === null) {
        return {
          async snapshot() {
            beginSnapshot(state);
            return { kind: 'not_repository' };
          },
          async *subscribe() {},
          async close() {
            closeSession(state);
            ids.revokeAll();
          },
        };
      }

      const identity: RepositoryIdentityState = {
        evidence: resolved.repositoryEvidence,
        repositoryId: ids.issue('repository'),
        generations: new Map(),
      };
      return createRepositoryPublicationSession({
        async read() {
          const sessionGeneration = beginSnapshot(state);
          const candidateIdentity: RepositoryIdentityState = {
            ...identity,
            generations: new Map(identity.generations),
          };
          const result = await discoverRepository(
            resolved,
            candidateIdentity,
            ids,
            state,
            sessionGeneration,
          );
          assertSessionGeneration(state, sessionGeneration);
          return {
            discovery: result.repository,
            commit() {
              identity.generations = candidateIdentity.generations;
            },
          };
        },
        canRetainFailure() {
          return state.status === 'open';
        },
        close() {
          closeSession(state);
          identity.generations.clear();
          ids.revokeAll();
        },
      });
    },
  };
}

async function discoverRepository(
  resolved: ResolvedAnchor,
  identity: RepositoryIdentityState,
  ids: OpaqueIdAuthority,
  state: SessionState,
  sessionGeneration: number,
): Promise<{
  readonly kind: 'repository';
  readonly repository: RepositoryDiscovery;
}> {
  await assertRepositoryContinuity(
    resolved,
    identity,
    ids,
    state,
    sessionGeneration,
  );
  const inventory = await runGit(
    [
      '--git-dir',
      resolved.commonGitDirectory,
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ],
    true,
  );
  assertSessionGeneration(state, sessionGeneration);
  const records = parseWorktreeListPorcelain(inventory);
  const resolvedRegistrations = await Promise.all(
    records.map((record) =>
      canonicalizeRegistration(record, resolved.commonGitDirectory),
    ),
  );
  assertSessionGeneration(state, sessionGeneration);
  await assertRepositoryContinuity(
    resolved,
    identity,
    ids,
    state,
    sessionGeneration,
  );
  const registrations = rejectDuplicateAdminIdentities(resolvedRegistrations);
  const nextGenerations = new Map<string, WorktreeIdentityState>();
  const seenPaths = new Set<string>();

  const worktrees = registrations.map((registration, index) => {
    if (seenPaths.has(registration.pathKey)) {
      throw new Error(
        `Git returned a duplicate Worktree registration for ${JSON.stringify(decodeForDisplay(registration.canonicalPathBytes))}.`,
      );
    }
    seenPaths.add(registration.pathKey);

    const previous = identity.generations.get(registration.pathKey);
    // Porcelain exposes no registration/admin identity for a missing path. Without
    // inspecting Git's private layout, continuity is unprovable, so stale opaque
    // targets are safer to invalidate than to bind to a deterministic fingerprint.
    const retainsContinuousEvidence =
      registration.unavailableReason === null && !registration.record.prunable;
    const worktreeIdentity =
      retainsContinuousEvidence && previous?.evidence === registration.evidence
        ? previous
        : issueWorktreeIdentity(ids, registration.evidence);
    nextGenerations.set(registration.pathKey, worktreeIdentity);

    return toDiscoveredWorktree(
      registration,
      worktreeIdentity,
      index === 0 ? 'main' : 'linked',
    );
  });

  identity.generations = nextGenerations;
  const selectedWorktreeId =
    worktrees.find(
      ({ canonicalPath }) => canonicalPath === resolved.selectedWorktreePath,
    )?.worktreeId ?? null;

  return {
    kind: 'repository',
    repository: {
      repositoryId: identity.repositoryId,
      commonGitDirectory: resolved.commonGitDirectory,
      selectedWorktreeId,
      worktrees,
    },
  };
}

async function assertRepositoryContinuity(
  resolved: ResolvedAnchor,
  identity: RepositoryIdentityState,
  ids: OpaqueIdAuthority,
  state: SessionState,
  sessionGeneration: number,
): Promise<void> {
  const evidence = fileIdentity(await stat(resolved.commonGitDirectory));
  assertSessionGeneration(state, sessionGeneration);
  if (evidence === identity.evidence) {
    return;
  }

  state.status = 'invalid';
  state.generation += 1;
  identity.generations.clear();
  ids.revokeAll();
  throw new Error(
    'Repository Session is invalid because the Repository was replaced.',
  );
}

async function resolveAnchor(
  anchor: AbsolutePath,
): Promise<ResolvedAnchor | null> {
  if (!isAbsolute(anchor)) {
    throw new Error('The Current Project anchor must be an absolute path.');
  }

  let commonGitDirectoryOutput: Uint8Array;
  try {
    commonGitDirectoryOutput = await runGit(
      ['-C', anchor, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      false,
    );
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 128) {
      return null;
    }
    throw error;
  }

  const commonGitDirectory = asAbsolutePath(
    await realpath(decodeLine(commonGitDirectoryOutput)),
  );
  const selectedWorktreePath = asAbsolutePath(
    await realpath(
      decodeLine(
        await runGit(
          [
            '-C',
            anchor,
            'rev-parse',
            '--path-format=absolute',
            '--show-toplevel',
          ],
          false,
        ),
      ),
    ),
  );
  const commonDirectoryStat = await stat(commonGitDirectory);

  return {
    commonGitDirectory,
    repositoryEvidence: fileIdentity(commonDirectoryStat),
    selectedWorktreePath,
  };
}

async function canonicalizeRegistration(
  record: WorktreePorcelainRecord,
  commonGitDirectory: AbsolutePath,
): Promise<CanonicalRegistration> {
  let canonicalPathBytes: Uint8Array;
  let adminIdentity: string | null = null;
  let unavailableReason: string | null = null;
  const registeredPath = Buffer.from(record.pathBytes);

  try {
    canonicalPathBytes = await realpath(registeredPath, {
      encoding: 'buffer',
    });
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    canonicalPathBytes = record.pathBytes.slice();
    unavailableReason =
      record.prunableReason ??
      'The registered Working Tree path is unavailable.';
  }

  const pathKey = Buffer.from(canonicalPathBytes).toString('base64');
  const canonicalPath = decodeAbsolutePath(canonicalPathBytes);
  let evidence: string;
  if (unavailableReason === null) {
    if (canonicalPath === null) {
      unavailableReason =
        'The registered Working Tree path cannot be addressed safely by the Git process runner.';
      evidence = unavailableEvidence(record, pathKey);
    } else {
      try {
        const workingTreeEvidence = fileIdentity(
          await stat(Buffer.from(canonicalPathBytes)),
        );
        const gitDirectory = await realpath(
          decodeLine(
            await runGit(
              [
                '-C',
                canonicalPath,
                'rev-parse',
                '--path-format=absolute',
                '--git-dir',
              ],
              false,
            ),
          ),
        );
        const resolvedCommonGitDirectory = await realpath(
          decodeLine(
            await runGit(
              [
                '-C',
                canonicalPath,
                'rev-parse',
                '--path-format=absolute',
                '--git-common-dir',
              ],
              false,
            ),
          ),
        );
        if (resolvedCommonGitDirectory !== commonGitDirectory) {
          throw new WorktreeRegistrationMismatchError();
        }
        if (gitDirectory !== commonGitDirectory) {
          await assertWorktreeAdminBacklink(canonicalPathBytes, gitDirectory);
        }
        const gitDirectoryEvidence = fileIdentity(await stat(gitDirectory));
        adminIdentity = `${gitDirectory}\0${gitDirectoryEvidence}`;
        evidence = `${pathKey}\0${workingTreeEvidence}\0${adminIdentity}`;
      } catch (error) {
        if (!isUnresolvableWorktreeError(error)) {
          throw error;
        }
        unavailableReason =
          record.prunableReason ??
          'The registered Working Tree cannot be resolved as its Git registration.';
        evidence = unavailableEvidence(record, pathKey);
      }
    }
  } else {
    evidence = unavailableEvidence(record, pathKey);
  }

  return {
    adminIdentity,
    canonicalPath,
    canonicalPathBytes,
    pathKey,
    evidence,
    record,
    unavailableReason,
  };
}

async function assertWorktreeAdminBacklink(
  canonicalPathBytes: Uint8Array,
  gitDirectory: string,
): Promise<void> {
  const adminControlPath = decodeLine(
    await runGit(
      [
        '--git-dir',
        gitDirectory,
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'gitdir',
      ],
      false,
    ),
  );
  const backlinkTarget = stripLineEnding(await readFile(adminControlPath));
  const candidateControlPath = Buffer.concat([
    Buffer.from(canonicalPathBytes),
    Buffer.from('/.git'),
  ]);
  const [canonicalBacklinkTarget, canonicalCandidateControlPath] =
    await Promise.all([
      realpath(backlinkTarget, { encoding: 'buffer' }),
      realpath(candidateControlPath, { encoding: 'buffer' }),
    ]);
  if (!canonicalBacklinkTarget.equals(canonicalCandidateControlPath)) {
    throw new WorktreeRegistrationMismatchError();
  }
}

function stripLineEnding(value: Buffer): Buffer {
  let end = value.length;
  if (value[end - 1] === 0x0a) {
    end -= 1;
  }
  if (value[end - 1] === 0x0d) {
    end -= 1;
  }
  return value.subarray(0, end);
}

function rejectDuplicateAdminIdentities(
  registrations: readonly CanonicalRegistration[],
): readonly CanonicalRegistration[] {
  const counts = new Map<string, number>();
  for (const { adminIdentity } of registrations) {
    if (adminIdentity !== null) {
      counts.set(adminIdentity, (counts.get(adminIdentity) ?? 0) + 1);
    }
  }

  return registrations.map((registration) => {
    if (
      registration.adminIdentity === null ||
      counts.get(registration.adminIdentity) === 1
    ) {
      return registration;
    }
    return {
      ...registration,
      adminIdentity: null,
      evidence: unavailableEvidence(registration.record, registration.pathKey),
      unavailableReason:
        'The registered Working Tree resolves to a Git admin directory shared by another registration.',
    };
  });
}

function toDiscoveredWorktree(
  registration: CanonicalRegistration,
  identity: WorktreeIdentityState,
  role: 'main' | 'linked',
): DiscoveredWorktree {
  const { record } = registration;
  return {
    worktreeId: identity.worktreeId,
    generation: identity.generation,
    displayPath: decodeForDisplay(record.pathBytes),
    canonicalPath: registration.canonicalPath,
    canonicalPathBytes: registration.canonicalPathBytes.slice(),
    role,
    head: toHead(record),
    gitLock: record.locked
      ? { kind: 'locked', reason: record.lockedReason }
      : { kind: 'unlocked' },
    availability:
      registration.unavailableReason === null && !record.prunable
        ? { kind: 'available' }
        : {
            kind: 'unavailable',
            reason:
              record.prunableReason ??
              registration.unavailableReason ??
              'The registered Working Tree is unavailable.',
            prunable: record.prunable,
          },
  };
}

function toHead(record: WorktreePorcelainRecord): DiscoveredHead {
  if (record.detached) {
    if (record.head === null || ZERO_OBJECT_ID.test(record.head)) {
      throw new Error('A detached Worktree must identify a Commit.');
    }
    return { kind: 'detached', objectId: record.head };
  }
  if (record.branch === null) {
    throw new Error('An attached Worktree must identify a Local Branch.');
  }
  return {
    kind: 'local_branch',
    fullName: record.branch,
    displayName: record.branch.startsWith('refs/heads/')
      ? record.branch.slice('refs/heads/'.length)
      : record.branch,
    objectId:
      record.head === null || ZERO_OBJECT_ID.test(record.head)
        ? null
        : record.head,
  };
}

function issueWorktreeIdentity(
  ids: OpaqueIdAuthority,
  evidence: string,
): WorktreeIdentityState {
  return {
    evidence,
    generation: ids.issue('generation'),
    worktreeId: ids.issue('worktree'),
  };
}

function unavailableEvidence(
  record: WorktreePorcelainRecord,
  pathKey: string,
): string {
  return [
    pathKey,
    record.head ?? '',
    record.branch ?? '',
    record.detached ? 'detached' : 'attached',
    record.prunable ? 'prunable' : 'registered',
    record.prunableReason ?? '',
  ].join('\0');
}

function decodeAbsolutePath(pathBytes: Uint8Array): AbsolutePath | null {
  try {
    const path = new TextDecoder('utf-8', { fatal: true }).decode(pathBytes);
    return isAbsolute(path) ? asAbsolutePath(path) : null;
  } catch {
    return null;
  }
}

function fileIdentity(value: {
  readonly birthtimeMs: number;
  readonly dev: number;
  readonly ino: number;
}): string {
  return `${value.dev}:${value.ino}:${value.birthtimeMs}`;
}

function decodeLine(output: Uint8Array): string {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(output);
  return value.endsWith('\r\n')
    ? value.slice(0, -2)
    : value.endsWith('\n')
      ? value.slice(0, -1)
      : value;
}

function runGit(
  args: readonly string[],
  allowLargeOutput: boolean,
): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      [...args],
      {
        encoding: 'buffer',
        env: gitEnvironment(),
        maxBuffer: allowLargeOutput ? GIT_OUTPUT_LIMIT_BYTES : 64 * 1_024,
        timeout: GIT_TIMEOUT_MILLISECONDS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(
            new GitCommandError(
              typeof error.code === 'number' ? error.code : null,
              error.message,
              error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                ? 'output_too_large'
                : 'command_failed',
            ),
          );
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) {
      delete environment[key];
    }
  }
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.LC_ALL = 'C';
  return environment;
}

function beginSnapshot(state: SessionState): number {
  if (state.status === 'invalid') {
    throw new Error(
      'Repository Session is invalid because the Repository was replaced.',
    );
  }
  if (state.status === 'closed') {
    throw new Error('Repository Session is closed.');
  }
  return state.generation;
}

function assertSessionGeneration(
  state: SessionState,
  generation: number,
): void {
  if (state.generation !== generation || state.status !== 'open') {
    beginSnapshot(state);
    throw new Error('Repository Session generation changed.');
  }
}

function closeSession(state: SessionState): void {
  if (state.status === 'open') {
    // Issue #7 owns child-process cancellation and reconciliation. This issue
    // invalidates the generation immediately so a completed read cannot publish.
    state.status = 'closed';
    state.generation += 1;
  }
}

class GitCommandError extends Error {
  constructor(
    readonly exitCode: number | null,
    message: string,
    readonly failure: 'command_failed' | 'output_too_large',
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

class WorktreeRegistrationMismatchError extends Error {}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function isUnresolvableWorktreeError(error: unknown): boolean {
  return (
    isMissingPathError(error) ||
    error instanceof WorktreeRegistrationMismatchError ||
    (error instanceof GitCommandError && error.exitCode === 128)
  );
}

function asAbsolutePath(path: string): AbsolutePath {
  return path as AbsolutePath;
}
