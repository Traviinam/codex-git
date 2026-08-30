import type {
  DiscoveredWorktree,
  RepositoryDiscovery,
} from './repository-engine.js';
import type {
  ChangedFileObservation,
  IndexSnapshot,
  RefSnapshot,
  RepositoryObservation,
  UpstreamSnapshot,
  WorktreeObservation,
  WorktreeObservationError,
  WorktreeStatusSummary,
} from './repository-observation.js';
import type { FileId, NativeTargetId } from '@codex-git/protocol';
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
  readonly changes: readonly PublishedChangedFile[];
  readonly upstream: UpstreamSnapshot;
}

export type PublishedChangedFile = ChangedFileObservation & {
  readonly fileId: FileId;
  readonly nativeTargetId: NativeTargetId;
};

export type WorktreeFreshness =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'stale'; readonly error: WorktreeObservationError }
  | { readonly kind: 'failed'; readonly error: WorktreeObservationError };

type ObservedWorktreeFacts = Omit<
  Pick<
    PublishedObservationWorktree,
    'freshness' | 'head' | 'index' | 'status' | 'changes' | 'upstream'
  >,
  'changes'
> & {
  readonly changes: readonly ChangedFileObservation[];
};

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
  issueFileId?: () => FileId,
  issueNativeTargetId?: () => NativeTargetId,
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
    const candidate: Omit<
      PublishedObservationWorktree,
      'worktreeRevision' | 'changes'
    > & { readonly changes: readonly ChangedFileObservation[] } = {
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
      changes: observedFacts.changes,
      upstream: observedFacts.upstream,
    };
    const changed =
      prior === undefined ||
      worktreeEvidence(candidate) !== worktreeEvidence(prior);
    worktreeChanged ||= changed;
    const changes =
      !changed && prior !== undefined
        ? prior.changes
        : observedFacts.changes.map((change) => ({
            ...change,
            fileId: requireFileIdIssuer(issueFileId)(),
            nativeTargetId: requireNativeTargetIdIssuer(issueNativeTargetId)(),
          }));
    return {
      ...candidate,
      changes,
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
): ObservedWorktreeFacts {
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
    changes: previous.changes.map(toObservedChange),
    upstream: previous.upstream,
  };
}

function publishWorktreeObservation(
  worktree: DiscoveredWorktree,
  observed: WorktreeObservation | undefined,
  previous: PublishedObservationWorktree | undefined,
): ObservedWorktreeFacts {
  if (observed?.kind === 'fresh') {
    return {
      freshness: { kind: 'fresh' },
      head: observed.head,
      index: observed.index,
      status: observed.status,
      changes: observed.changes,
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
      changes: [],
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
        changes: previous.changes.map(toObservedChange),
        upstream: previous.upstream,
      };
    }
    return {
      freshness: { kind: 'failed', error: observed.error },
      head: worktree.head,
      index: null,
      status: null,
      changes: [],
      upstream: { kind: 'unavailable' },
    };
  }
  return {
    freshness: { kind: 'fresh' },
    head: worktree.head,
    index: null,
    status: null,
    changes: [],
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
  > & {
    readonly changes: readonly (
      ChangedFileObservation | PublishedChangedFile
    )[];
  },
): string {
  return JSON.stringify({
    head: worktree.head,
    gitLock: worktree.gitLock,
    freshness: worktree.freshness,
    index: worktree.index,
    status: worktree.status,
    changes: worktree.changes.map((change) => {
      if ('fileId' in change) {
        return toObservedChange(change);
      }
      return change;
    }),
  });
}

function toObservedChange(
  change: PublishedChangedFile,
): ChangedFileObservation {
  return {
    kind: change.kind,
    baseline: change.baseline,
    displayPath: change.displayPath,
    pathBytes: change.pathBytes,
    previousDisplayPath: change.previousDisplayPath,
    previousPathBytes: change.previousPathBytes,
    workingFilePresent: change.workingFilePresent,
  } as ChangedFileObservation;
}

function requireFileIdIssuer(
  issueFileId: (() => FileId) | undefined,
): () => FileId {
  if (issueFileId === undefined) {
    throw new Error('Changed Files require a File ID issuer at publication.');
  }
  return issueFileId;
}

function requireNativeTargetIdIssuer(
  issueNativeTargetId: (() => NativeTargetId) | undefined,
): () => NativeTargetId {
  if (issueNativeTargetId === undefined) {
    throw new Error('Changed Files require a Native Target ID issuer.');
  }
  return issueNativeTargetId;
}
