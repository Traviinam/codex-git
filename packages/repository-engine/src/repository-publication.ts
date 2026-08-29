import type {
  DiscoveredWorktree,
  RepositoryDiscovery,
} from './repository-engine.js';
import { InvalidationStream } from './invalidation-stream.js';

export interface RepositorySnapshot extends Omit<
  RepositoryDiscovery,
  'worktrees'
> {
  readonly repositoryRevision: number;
  readonly topologyRevision: number;
  readonly refsRevision: number;
  readonly refresh: RefreshState;
  readonly worktrees: readonly PublishedWorktreeSnapshot[];
}

export interface PublishedWorktreeSnapshot extends Omit<
  DiscoveredWorktree,
  'canonicalPathBytes'
> {
  readonly worktreeRevision: number;
}

export type RefreshState =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'stale'; readonly error: RefreshError }
  | { readonly kind: 'failed'; readonly error: RefreshError };

export interface RefreshError {
  readonly code: 'git_read_failed' | 'git_output_too_large';
  readonly message: string;
}

export type RepositoryOpenResult =
  | { readonly kind: 'not_repository' }
  | {
      readonly kind: 'failed';
      readonly refresh: Extract<RefreshState, { readonly kind: 'failed' }>;
    }
  | {
      readonly kind: 'repository';
      readonly repository: RepositorySnapshot;
    };

export interface RepositorySession {
  snapshot(): Promise<RepositoryOpenResult>;
  subscribe(): AsyncIterable<RepositoryInvalidation>;
  close(): Promise<void>;
}

export interface RepositoryInvalidation {
  readonly kind: 'repository';
  readonly repositoryRevision: number;
  readonly refresh: RefreshState;
}

export class RepositorySessionFailure extends Error {
  constructor(readonly code: 'closed' | 'superseded') {
    super(
      code === 'closed'
        ? 'Repository Session is closed.'
        : 'Repository snapshot was superseded by a newer read.',
    );
    this.name = 'RepositorySessionFailure';
  }
}

interface PublicationCandidate {
  readonly discovery: RepositoryDiscovery;
  commit(): void;
}

interface PublicationSessionOptions {
  read(): Promise<PublicationCandidate>;
  canRetainFailure(error: unknown): boolean;
  close(): void;
}

export function createRepositoryPublicationSession(
  options: PublicationSessionOptions,
): RepositorySession {
  const invalidations = new InvalidationStream<RepositoryInvalidation>();
  let closed = false;
  let generation = 0;
  let published: RepositorySnapshot | undefined;

  return {
    async snapshot() {
      if (closed) {
        throw new RepositorySessionFailure('closed');
      }
      const ownGeneration = ++generation;
      let candidate: PublicationCandidate;
      try {
        candidate = await options.read();
      } catch (error) {
        if (closed) {
          throw new RepositorySessionFailure('closed');
        }
        if (ownGeneration !== generation) {
          if (published === undefined) {
            throw new RepositorySessionFailure('superseded');
          }
          return { kind: 'repository', repository: published };
        }
        if (!options.canRetainFailure(error)) {
          throw error;
        }
        const refreshError = classifyRefreshError(error);
        if (published === undefined) {
          return {
            kind: 'failed',
            refresh: deepFreeze({ kind: 'failed', error: refreshError }),
          };
        }
        const staleRefresh = deepFreeze({
          kind: 'stale',
          error: refreshError,
        } satisfies RefreshState);
        if (sameExternalState(published.refresh, staleRefresh)) {
          return { kind: 'repository', repository: published };
        }
        const stale = deepFreeze({
          ...published,
          repositoryRevision: published.repositoryRevision + 1,
          refresh: staleRefresh,
        } satisfies RepositorySnapshot);
        published = stale;
        invalidations.publish({
          kind: 'repository',
          repositoryRevision: stale.repositoryRevision,
          refresh: stale.refresh,
        });
        return { kind: 'repository', repository: stale };
      }
      if (closed) {
        throw new RepositorySessionFailure('closed');
      }
      if (ownGeneration !== generation) {
        if (published === undefined) {
          throw new RepositorySessionFailure('superseded');
        }
        return { kind: 'repository', repository: published };
      }
      const next = publishDiscovery(candidate.discovery, published);
      candidate.commit();
      if (published !== undefined && sameExternalState(published, next)) {
        return { kind: 'repository', repository: published };
      }
      published = next;
      invalidations.publish({
        kind: 'repository',
        repositoryRevision: next.repositoryRevision,
        refresh: next.refresh,
      });
      return { kind: 'repository', repository: next };
    },
    subscribe() {
      return invalidations.subscribe();
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      generation += 1;
      options.close();
      invalidations.close();
    },
  };
}

function classifyRefreshError(error: unknown): RefreshError {
  if (
    error instanceof Error &&
    'failure' in error &&
    error.failure === 'output_too_large'
  ) {
    return {
      code: 'git_output_too_large',
      message: 'Git output exceeded the local observation limit.',
    };
  }
  return {
    code: 'git_read_failed',
    message: 'Git could not produce a local observation.',
  };
}

export function publishDiscovery(
  discovery: RepositoryDiscovery,
  previous?: RepositorySnapshot,
): RepositorySnapshot {
  const previousWorktrees = new Map(
    previous?.worktrees.map((worktree) => [worktree.worktreeId, worktree]),
  );
  let worktreeChanged = previous === undefined;
  const worktrees = discovery.worktrees.map((worktree) => {
    const prior = previousWorktrees.get(worktree.worktreeId);
    const changed =
      prior === undefined ||
      worktreeEvidence(worktree) !== worktreeEvidence(prior);
    worktreeChanged ||= changed;
    const published: Omit<DiscoveredWorktree, 'canonicalPathBytes'> = {
      worktreeId: worktree.worktreeId,
      generation: worktree.generation,
      displayPath: worktree.displayPath,
      canonicalPath: worktree.canonicalPath,
      role: worktree.role,
      head: worktree.head,
      gitLock: worktree.gitLock,
      availability: worktree.availability,
    };
    return {
      ...published,
      worktreeRevision:
        prior === undefined ? 1 : prior.worktreeRevision + (changed ? 1 : 0),
    };
  });
  worktreeChanged ||= previousWorktrees.size !== worktrees.length;
  const topologyChanged =
    previous === undefined ||
    topologyEvidence(discovery) !== topologyEvidence(previous);
  const selectionChanged =
    previous === undefined ||
    discovery.selectedWorktreeId !== previous.selectedWorktreeId;
  const recovered = previous !== undefined && previous.refresh.kind !== 'fresh';

  return deepFreeze({
    repositoryId: discovery.repositoryId,
    commonGitDirectory: discovery.commonGitDirectory,
    selectedWorktreeId: discovery.selectedWorktreeId,
    repositoryRevision:
      previous === undefined
        ? 1
        : previous.repositoryRevision +
          (topologyChanged || worktreeChanged || selectionChanged || recovered
            ? 1
            : 0),
    topologyRevision:
      previous === undefined
        ? 1
        : previous.topologyRevision + (topologyChanged ? 1 : 0),
    refsRevision: previous?.refsRevision ?? 1,
    refresh: { kind: 'fresh' },
    worktrees,
  });
}

function topologyEvidence(repository: {
  readonly repositoryId: RepositoryDiscovery['repositoryId'];
  readonly worktrees: readonly Pick<
    PublishedWorktreeSnapshot,
    | 'availability'
    | 'canonicalPath'
    | 'displayPath'
    | 'generation'
    | 'role'
    | 'worktreeId'
  >[];
}): string {
  return JSON.stringify({
    repositoryId: repository.repositoryId,
    worktrees: repository.worktrees.map((worktree) => ({
      availability: worktree.availability,
      canonicalPath: worktree.canonicalPath,
      displayPath: worktree.displayPath,
      generation: worktree.generation,
      role: worktree.role,
      worktreeId: worktree.worktreeId,
    })),
  });
}

function worktreeEvidence(
  worktree: Pick<PublishedWorktreeSnapshot, 'gitLock' | 'head'>,
): string {
  return JSON.stringify({ head: worktree.head, gitLock: worktree.gitLock });
}

function sameExternalState(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
