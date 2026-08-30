import {
  remoteIdSchema,
  worktreeGenerationSchema,
  type OperationResult,
  type RemoteId,
  type RepositorySnapshot,
  type WorktreeGeneration,
} from '@codex-git/protocol';

type OperationSummary = RepositorySnapshot['operations'][number];
type WithoutId<Result> = Result extends OperationResult
  ? Omit<Result, 'operationId'>
  : never;
type NonEmpty<Value> = readonly [Value, ...Value[]];

export type ReconciledOperationResult = WithoutId<OperationResult>;

export type OperationExecution<Evidence> =
  | { readonly kind: 'returned'; readonly evidence: Evidence }
  | { readonly kind: 'threw'; readonly error: unknown }
  | { readonly kind: 'timed_out' };

export interface CoordinatedOperationSummary extends OperationSummary {
  readonly retryAllowed: boolean;
}

export interface OperationReconciliationContext<Evidence> {
  readonly cancellationRequested: boolean;
  readonly execution: OperationExecution<Evidence>;
  readonly timedOut: boolean;
}

interface Hooks<Evidence> {
  reconcileBusy(context: {
    readonly conflicts: readonly CoordinatedOperationSummary[];
  }): Promise<void>;
  execute(context: { readonly signal: AbortSignal }): Promise<Evidence>;
  reconcile(
    context: OperationReconciliationContext<Evidence>,
  ): Promise<ReconciledOperationResult>;
}

export type BranchTarget =
  | { readonly kind: 'local'; readonly fullName: string }
  | {
      readonly kind: 'remote_tracking';
      readonly fullName: string;
      readonly remoteId: RemoteId;
    };

type Target =
  | {
      readonly kind: 'stage' | 'unstage';
      readonly worktreeGeneration: WorktreeGeneration;
    }
  | {
      readonly kind: 'commit';
      readonly worktreeGeneration: WorktreeGeneration;
      readonly attachedRef: string | null;
    }
  | {
      readonly kind: 'branch_switch';
      readonly worktreeGeneration: WorktreeGeneration;
      readonly currentRef: string | null;
      readonly target: BranchTarget;
    }
  | { readonly kind: 'fetch'; readonly remoteIds: NonEmpty<RemoteId> }
  | {
      readonly kind: 'pull';
      readonly worktreeGeneration: WorktreeGeneration;
      readonly localBranchRef: string;
      readonly upstreamRef: string;
      readonly remoteId: RemoteId;
    }
  | {
      readonly kind: 'push' | 'publish';
      readonly worktreeGeneration: WorktreeGeneration;
      readonly localBranchRef: string;
      readonly destinationRef: string;
      readonly remoteId: RemoteId;
    };

export type CoordinatedOperation<Evidence = unknown> = Target & Hooks<Evidence>;

export interface OperationCoordination {
  readonly category: OperationSummary['category'];
  readonly claims: ReadonlySet<string>;
  readonly lane: string;
}

export function coordinateOperation(
  operation: CoordinatedOperation<unknown>,
): OperationCoordination {
  const coordination = derive(operation);
  assertHooks(operation);
  return coordination;
}

export function operationCoordinationConflicts(
  left: OperationCoordination,
  right: OperationCoordination,
) {
  return left.lane === right.lane || overlaps(left.claims, right.claims);
}

function derive(
  operation: CoordinatedOperation<unknown>,
): OperationCoordination {
  if ('lane' in operation || 'claims' in operation || 'category' in operation) {
    throw new Error('Coordination is derived from the operation kind.');
  }

  const claims = new Set<string>();
  switch (operation.kind) {
    case 'stage':
    case 'unstage':
      claimWorktree(
        claims,
        operation.worktreeGeneration,
        'availability',
        'status',
        'index',
      );
      return local(operation.kind, operation.worktreeGeneration, claims);
    case 'commit':
      claimWorktree(
        claims,
        operation.worktreeGeneration,
        'availability',
        'status',
        'head',
        'index',
      );
      claimRef(claims, operation.attachedRef, 'attachedRef');
      return local('commit', operation.worktreeGeneration, claims);
    case 'branch_switch':
      claimWorktree(
        claims,
        operation.worktreeGeneration,
        'availability',
        'status',
        'head',
        'index',
      );
      claims.add(key('repository', 'branch_occupancy'));
      claimRef(claims, operation.currentRef, 'currentRef');
      if (
        operation.target?.kind !== 'local' &&
        operation.target?.kind !== 'remote_tracking'
      ) {
        throw new Error(
          'target must identify a Local or Remote-tracking Branch.',
        );
      }
      if (operation.target.kind === 'local') {
        claimBranchRef(claims, operation.target.fullName, 'refs/heads/');
      } else {
        claimBranchRef(claims, operation.target.fullName, 'refs/remotes/');
        claimRemote(claims, operation.target.remoteId, 'target.remoteId');
      }
      return { category: 'branch_switch', claims, lane: 'branch' };
    case 'fetch':
      if (
        !Array.isArray(operation.remoteIds) ||
        operation.remoteIds.length === 0
      ) {
        throw new Error(
          'remoteIds must contain at least one opaque Remote ID.',
        );
      }
      for (const remoteId of operation.remoteIds) {
        claimRemote(claims, remoteId, 'remoteIds');
      }
      return { category: 'fetch', claims, lane: 'remote' };
    case 'pull':
      claimWorktree(
        claims,
        operation.worktreeGeneration,
        'availability',
        'status',
        'head',
        'index',
        'upstream',
      );
      claimRef(claims, operation.localBranchRef, 'localBranchRef');
      claimRef(claims, operation.upstreamRef, 'upstreamRef');
      claimRemote(claims, operation.remoteId, 'remoteId');
      return { category: 'pull', claims, lane: 'remote' };
    case 'push':
    case 'publish':
      claimWorktree(
        claims,
        operation.worktreeGeneration,
        'availability',
        'head',
        'upstream',
      );
      claimRef(claims, operation.localBranchRef, 'localBranchRef');
      claimRef(claims, operation.destinationRef, 'destinationRef');
      claimRemote(claims, operation.remoteId, 'remoteId');
      claims.add(
        key('remote_destination', operation.remoteId, operation.destinationRef),
      );
      return { category: operation.kind, claims, lane: 'remote' };
    default:
      throw new Error('Unsupported operation kind.');
  }
}

function local(
  category: 'commit' | 'stage' | 'unstage',
  generation: WorktreeGeneration,
  claims: ReadonlySet<string>,
): OperationCoordination {
  return { category, claims, lane: key('local', generation) };
}

function claimWorktree(
  claims: Set<string>,
  generation: WorktreeGeneration,
  ...facts: readonly string[]
) {
  if (!worktreeGenerationSchema.safeParse(generation).success) {
    throw new Error(
      'worktreeGeneration must be an opaque Worktree Generation.',
    );
  }
  for (const fact of facts) claims.add(key('worktree', generation, fact));
}

function claimRef(claims: Set<string>, value: string | null, field: string) {
  if (value === null) return;
  if (
    typeof value !== 'string' ||
    !value.startsWith('refs/') ||
    value.includes('\0')
  ) {
    throw new Error(`${field} must be a full ref name or null.`);
  }
  claims.add(key('ref', value));
}

function claimRemote(claims: Set<string>, value: RemoteId, field: string) {
  if (!remoteIdSchema.safeParse(value).success) {
    throw new Error(`${field} must be an opaque Remote ID.`);
  }
  claims.add(key('remote', value));
}

function claimBranchRef(
  claims: Set<string>,
  value: string,
  namespace: 'refs/heads/' | 'refs/remotes/',
) {
  if (typeof value !== 'string' || !value.startsWith(namespace)) {
    throw new Error(`target.fullName must be in ${namespace}.`);
  }
  claimRef(claims, value, 'target.fullName');
}

function assertHooks(operation: CoordinatedOperation<unknown>) {
  if (
    typeof operation.reconcileBusy !== 'function' ||
    typeof operation.execute !== 'function' ||
    typeof operation.reconcile !== 'function'
  ) {
    throw new Error('Operation lifecycle hooks are required.');
  }
}

function overlaps(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  for (const claim of right) if (left.has(claim)) return true;
  return false;
}

function key(...parts: readonly string[]) {
  return JSON.stringify(parts);
}
