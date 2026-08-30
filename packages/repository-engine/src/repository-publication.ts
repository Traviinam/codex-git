import type { RepositoryDiscovery } from './repository-engine.js';
import { InvalidationStream } from './invalidation-stream.js';
import {
  publishObservedFacts,
  type PrivateRefsEvidence,
  type PublishedObservationWorktree,
  type PublishedRepositoryObservation,
  type WorktreeFreshness,
} from './observation-publication.js';
import type { RepositoryObservation } from './repository-observation.js';
import type { RemoteId, WorktreeId } from '@codex-git/protocol';
import type { OperationSessionSummary } from './operation-session.js';

export interface RepositorySnapshot
  extends
    Omit<RepositoryDiscovery, 'worktrees'>,
    PublishedRepositoryObservation {
  readonly repositoryRevision: number;
  readonly topologyRevision: number;
  readonly refsRevision: number;
  readonly refresh: RefreshState;
  readonly fetch: FetchState;
  readonly remoteFetches?: readonly {
    readonly remoteId: RemoteId;
    readonly fetchedAt: string;
  }[];
  readonly operations: readonly OperationSessionSummary[];
}

export type PublishedWorktreeSnapshot = PublishedObservationWorktree;
export type { WorktreeFreshness };

export type RefreshState =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'stale'; readonly error: RefreshError }
  | { readonly kind: 'failed'; readonly error: RefreshError };

export type FetchState =
  | { readonly kind: 'never' }
  | { readonly kind: 'current'; readonly fetchedAt: string }
  | {
      readonly kind: 'stale' | 'failed';
      readonly fetchedAt: string | null;
      readonly message: string;
    };

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

export interface RepositoryPublicationSession {
  snapshot(): Promise<RepositoryOpenResult>;
  requestRefresh(): Promise<RepositoryOpenResult>;
  subscribe(): AsyncIterable<RepositoryInvalidation>;
  close(): Promise<void>;
}

export type RepositoryRefreshScope =
  | { readonly kind: 'all' }
  | {
      readonly kind: 'worktrees';
      readonly worktreeIds: readonly WorktreeId[];
    };

export interface ScopedRepositoryPublicationSession extends RepositoryPublicationSession {
  requestScopedRefresh(
    scope: RepositoryRefreshScope,
  ): Promise<RepositoryOpenResult>;
}

export type RepositoryInvalidation =
  | {
      readonly kind: 'repository';
      readonly repositoryRevision: number;
      readonly refresh: RefreshState;
    }
  | {
      readonly kind: 'operation';
      readonly operation: OperationSessionSummary;
    };

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
  readonly observation: RepositoryObservation;
  commit(): void;
}

interface PublicationSessionOptions {
  read(
    signal: AbortSignal,
    refreshGeneration: number,
    scope: RepositoryRefreshScope,
  ): Promise<PublicationCandidate>;
  canRetainFailure(error: unknown): boolean;
  close(): void;
}

export function createRepositoryPublicationSession(
  options: PublicationSessionOptions,
): ScopedRepositoryPublicationSession {
  const invalidations = new InvalidationStream<RepositoryInvalidation>();
  let closed = false;
  let generation = 0;
  let published: RepositorySnapshot | undefined;
  let privateRefsEvidence: PrivateRefsEvidence | undefined;
  const activeReads = new Map<number, AbortController>();

  const readSnapshot = async (
    scope: RepositoryRefreshScope,
  ): Promise<RepositoryOpenResult> => {
    if (closed) {
      throw new RepositorySessionFailure('closed');
    }
    const ownGeneration = ++generation;
    const controller = new AbortController();
    activeReads.set(ownGeneration, controller);
    let candidate: PublicationCandidate;
    try {
      candidate = await options.read(controller.signal, ownGeneration, scope);
    } catch (error) {
      activeReads.delete(ownGeneration);
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
    activeReads.delete(ownGeneration);
    if (closed) {
      throw new RepositorySessionFailure('closed');
    }
    if (ownGeneration !== generation) {
      if (published === undefined) {
        throw new RepositorySessionFailure('superseded');
      }
      return { kind: 'repository', repository: published };
    }
    const nextCandidate = publishCandidate(
      candidate.discovery,
      published,
      candidate.observation,
      privateRefsEvidence,
    );
    const next = nextCandidate.snapshot;
    candidate.commit();
    abortSupersededReads(activeReads, ownGeneration);
    if (published !== undefined && sameExternalState(published, next)) {
      return { kind: 'repository', repository: published };
    }
    published = next;
    privateRefsEvidence = nextCandidate.privateRefsEvidence;
    invalidations.publish({
      kind: 'repository',
      repositoryRevision: next.repositoryRevision,
      refresh: next.refresh,
    });
    return { kind: 'repository', repository: next };
  };

  return {
    snapshot: () => readSnapshot({ kind: 'all' }),
    requestRefresh() {
      return readSnapshot({ kind: 'all' });
    },
    requestScopedRefresh(scope) {
      return readSnapshot(scope);
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
      for (const controller of activeReads.values()) controller.abort();
      activeReads.clear();
      options.close();
      invalidations.close();
    },
  };
}

function abortSupersededReads(
  activeReads: Map<number, AbortController>,
  publishedGeneration: number,
): void {
  for (const [readGeneration, controller] of activeReads) {
    if (readGeneration < publishedGeneration) {
      controller.abort();
      activeReads.delete(readGeneration);
    }
  }
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
  observation?: RepositoryObservation,
): RepositorySnapshot {
  return publishCandidate(discovery, previous, observation).snapshot;
}

function publishCandidate(
  discovery: RepositoryDiscovery,
  previous?: RepositorySnapshot,
  observation?: RepositoryObservation,
  previousPrivateRefsEvidence?: PrivateRefsEvidence,
): {
  readonly snapshot: RepositorySnapshot;
  readonly privateRefsEvidence: PrivateRefsEvidence;
} {
  const {
    refsChanged,
    worktreeChanged,
    privateRefsEvidence,
    ...publishedObservation
  } = publishObservedFacts(
    discovery,
    previous,
    observation,
    previousPrivateRefsEvidence,
  );
  const topologyChanged =
    previous === undefined ||
    topologyEvidence(discovery) !== topologyEvidence(previous);
  const selectionChanged =
    previous === undefined ||
    discovery.selectedWorktreeId !== previous.selectedWorktreeId;
  const recovered = previous !== undefined && previous.refresh.kind !== 'fresh';

  return {
    privateRefsEvidence,
    snapshot: deepFreeze({
      repositoryId: discovery.repositoryId,
      commonGitDirectory: discovery.commonGitDirectory,
      selectedWorktreeId: discovery.selectedWorktreeId,
      repositoryRevision:
        previous === undefined
          ? 1
          : previous.repositoryRevision +
            (topologyChanged ||
            refsChanged ||
            worktreeChanged ||
            selectionChanged ||
            recovered
              ? 1
              : 0),
      topologyRevision:
        previous === undefined
          ? 1
          : previous.topologyRevision + (topologyChanged ? 1 : 0),
      refsRevision:
        previous === undefined
          ? 1
          : previous.refsRevision + (refsChanged ? 1 : 0),
      refresh: { kind: 'fresh' },
      fetch: previous?.fetch ?? { kind: 'never' },
      remoteFetches: previous?.remoteFetches ?? [],
      operations: previous?.operations ?? [],
      ...publishedObservation,
    }),
  };
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
