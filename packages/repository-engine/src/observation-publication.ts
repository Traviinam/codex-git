import type {
  DiscoveredWorktree,
  RepositoryDiscovery,
} from './repository-engine.js';
import type {
  IndexSnapshot,
  RefSnapshot,
  RepositoryObservation,
  UpstreamSnapshot,
  WorktreeObservation,
  WorktreeObservationError,
  WorktreeStatusSummary,
} from './repository-observation.js';
import type { RemoteSnapshot } from './remote-observation.js';

export interface PublishedRepositoryObservation {
  readonly refs: readonly RefSnapshot[];
  readonly remotes: readonly RemoteSnapshot[];
  readonly worktrees: readonly PublishedObservationWorktree[];
}

export interface PublishedObservationWorktree extends Omit<
  DiscoveredWorktree,
  'canonicalPathBytes'
> {
  readonly worktreeRevision: number;
  readonly freshness: WorktreeFreshness;
  readonly index: IndexSnapshot | null;
  readonly status: WorktreeStatusSummary | null;
  readonly upstream: UpstreamSnapshot;
}

export type WorktreeFreshness =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'stale'; readonly error: WorktreeObservationError }
  | { readonly kind: 'failed'; readonly error: WorktreeObservationError };

export interface PublishedObservationResult extends PublishedRepositoryObservation {
  readonly privateRefsEvidence: PrivateRefsEvidence;
  readonly refsChanged: boolean;
  readonly worktreeChanged: boolean;
}

export interface PrivateRefsEvidence {
  readonly shared: string;
  readonly upstreams: string;
}

export function publishObservedFacts(
  discovery: RepositoryDiscovery,
  previous?: PublishedRepositoryObservation,
  observation?: RepositoryObservation,
  previousPrivateRefsEvidence?: PrivateRefsEvidence,
): PublishedObservationResult {
  const shared = observation?.shared ?? {
    refs: previous?.refs ?? [],
    remotes: previous?.remotes ?? [],
    privateRefsEvidence: previousPrivateRefsEvidence?.shared ?? '',
  };
  const previousWorktrees = new Map(
    previous?.worktrees.map((worktree) => [worktree.worktreeId, worktree]),
  );
  const observations = new Map(
    observation?.worktrees.map((worktree) => [worktree.worktreeId, worktree]),
  );
  const sharedRefsChanged =
    observation !== undefined &&
    shared.privateRefsEvidence !== previousPrivateRefsEvidence?.shared;
  let worktreeChanged = previous === undefined;
  const worktrees = discovery.worktrees.map((worktree) => {
    const prior = previousWorktrees.get(worktree.worktreeId);
    const observed = observations.get(worktree.worktreeId);
    if (
      observation !== undefined &&
      observation.complete !== false &&
      observed === undefined
    ) {
      throw new Error('Repository observation omitted a registered Worktree.');
    }
    const observedFacts =
      observation?.complete === false &&
      observed === undefined &&
      prior !== undefined
        ? retainWorktreeObservation(prior, sharedRefsChanged)
        : publishWorktreeObservation(worktree, observed, prior);
    const published: Omit<PublishedObservationWorktree, 'worktreeRevision'> = {
      worktreeId: worktree.worktreeId,
      generation: worktree.generation,
      displayPath: worktree.displayPath,
      canonicalPath: worktree.canonicalPath,
      role: worktree.role,
      head: observedFacts.head,
      gitLock: worktree.gitLock,
      availability: worktree.availability,
      freshness: observedFacts.freshness,
      index: observedFacts.index,
      status: observedFacts.status,
      upstream: observedFacts.upstream,
    };
    const changed =
      prior === undefined ||
      worktreeEvidence(published) !== worktreeEvidence(prior);
    worktreeChanged ||= changed;
    return {
      ...published,
      worktreeRevision:
        prior === undefined ? 1 : prior.worktreeRevision + (changed ? 1 : 0),
    };
  });
  worktreeChanged ||= previousWorktrees.size !== worktrees.length;
  const privateRefsEvidence: PrivateRefsEvidence =
    observation === undefined
      ? (previousPrivateRefsEvidence ?? { shared: '', upstreams: '[]' })
      : {
          shared: shared.privateRefsEvidence,
          upstreams: JSON.stringify(
            worktrees.map(({ worktreeId, upstream }) => ({
              worktreeId,
              upstream,
            })),
          ),
        };
  const upstreamChanged = worktrees.some((worktree) => {
    const prior = previousWorktrees.get(worktree.worktreeId);
    return (
      prior !== undefined &&
      JSON.stringify(worktree.upstream) !== JSON.stringify(prior.upstream)
    );
  });
  return {
    refs: shared.refs,
    remotes: shared.remotes,
    worktrees,
    privateRefsEvidence,
    refsChanged:
      previous === undefined ||
      (observation !== undefined && (sharedRefsChanged || upstreamChanged)),
    worktreeChanged,
  };
}

function retainWorktreeObservation(
  previous: PublishedObservationWorktree,
  sharedRefsChanged: boolean,
): Pick<
  PublishedObservationWorktree,
  'freshness' | 'head' | 'index' | 'status' | 'upstream'
> {
  return {
    freshness: sharedRefsChanged
      ? {
          kind: 'stale',
          error: {
            code: 'not_observed',
            message: 'Shared refs changed before this Worktree was observed.',
          },
        }
      : previous.freshness,
    head: previous.head,
    index: previous.index,
    status: previous.status,
    upstream: previous.upstream,
  };
}

function publishWorktreeObservation(
  worktree: DiscoveredWorktree,
  observed: WorktreeObservation | undefined,
  previous: PublishedObservationWorktree | undefined,
): Pick<
  PublishedObservationWorktree,
  'freshness' | 'head' | 'index' | 'status' | 'upstream'
> {
  if (observed?.kind === 'fresh') {
    return {
      freshness: { kind: 'fresh' },
      head: observed.head,
      index: observed.index,
      status: observed.status,
      upstream: observed.upstream,
    };
  }
  if (
    observed?.kind === 'unavailable' ||
    (observed === undefined && worktree.availability.kind === 'unavailable')
  ) {
    return {
      freshness: { kind: 'unavailable' },
      head: worktree.head,
      index: null,
      status: null,
      upstream: previous?.upstream ?? { kind: 'unavailable' },
    };
  }
  if (observed?.kind === 'failed') {
    if (
      previous !== undefined &&
      (previous.freshness.kind === 'fresh' ||
        previous.freshness.kind === 'stale')
    ) {
      return {
        freshness: { kind: 'stale', error: observed.error },
        head: previous.head,
        index: previous.index,
        status: previous.status,
        upstream: previous.upstream,
      };
    }
    return {
      freshness: { kind: 'failed', error: observed.error },
      head: worktree.head,
      index: null,
      status: null,
      upstream: { kind: 'unavailable' },
    };
  }
  return {
    freshness: { kind: 'fresh' },
    head: worktree.head,
    index: null,
    status: null,
    upstream:
      worktree.head.kind === 'detached'
        ? { kind: 'not_applicable', reason: 'detached_head' }
        : { kind: 'unavailable' },
  };
}

function worktreeEvidence(
  worktree: Pick<
    PublishedObservationWorktree,
    'freshness' | 'gitLock' | 'head' | 'index' | 'status'
  >,
): string {
  return JSON.stringify({
    head: worktree.head,
    gitLock: worktree.gitLock,
    freshness: worktree.freshness,
    index: worktree.index,
    status: worktree.status,
  });
}
