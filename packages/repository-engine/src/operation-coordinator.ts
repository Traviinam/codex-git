import {
  createOpaqueIdAuthority,
  operationResultSchema,
  remoteIdSchema,
  worktreeGenerationSchema,
  type OperationId,
  type OperationResult,
  type RemoteId,
  type RepositorySnapshot,
  type WorktreeGeneration,
} from '@codex-git/protocol';

type OperationSummary = RepositorySnapshot['operations'][number];
type RejectedResult = Extract<OperationResult, { kind: 'rejected' }>;
type WithoutId<Result> = Result extends OperationResult
  ? Omit<Result, 'operationId'>
  : never;
type NonEmpty<Value> = readonly [Value, ...Value[]];

export type ReconciledOperationResult = WithoutId<OperationResult>;

export type OperationExecution<Evidence> =
  | { readonly kind: 'returned'; readonly evidence: Evidence }
  | { readonly kind: 'threw'; readonly error: unknown };

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

export type OperationAdmission =
  | {
      readonly kind: 'accepted';
      readonly operation: CoordinatedOperationSummary;
    }
  | {
      readonly kind: 'rejected';
      readonly result: RejectedResult;
      readonly conflicts: readonly CoordinatedOperationSummary[];
    };

export interface OperationCoordinator {
  dispatch<Evidence>(
    operation: CoordinatedOperation<Evidence>,
  ): Promise<OperationAdmission>;
  recover(operationId: OperationId): Promise<OperationResult>;
}

export interface OperationCoordination {
  readonly category: OperationSummary['category'];
  readonly claims: ReadonlySet<string>;
  readonly lane: string;
}

interface RecordState extends OperationCoordination {
  readonly execute: (context: { signal: AbortSignal }) => Promise<unknown>;
  readonly id: OperationId;
  readonly reconcile: (
    context: OperationReconciliationContext<unknown>,
  ) => Promise<ReconciledOperationResult>;
  readonly settled: Promise<OperationResult>;
  readonly settle: (result: OperationResult) => void;
  execution?: OperationExecution<unknown>;
  lease: boolean;
  phase: OperationSummary['phase'];
  reconciling?: Promise<OperationResult>;
  result?: OperationResult;
}

class Coordinator implements OperationCoordinator {
  readonly #ids = createOpaqueIdAuthority();
  readonly #operations = new Map<OperationId, RecordState>();

  async dispatch<Evidence>(
    operation: CoordinatedOperation<Evidence>,
  ): Promise<OperationAdmission> {
    const coordination = coordinateOperation(operation);
    const conflicts = this.#conflicts(coordination);

    const unknown = conflicts.filter(
      (record) => record.result?.kind === 'unknown_outcome',
    );
    for (const record of unknown) void this.#reconcile(record);

    if (conflicts.length > 0) {
      return this.#rejectBusy(operation, coordination, conflicts);
    }
    return this.#admit(operation, coordination);
  }

  recover(operationId: OperationId): Promise<OperationResult> {
    const record = this.#operations.get(operationId);
    if (record === undefined) {
      throw new Error(
        'Operation result is not retained by this Repository Session.',
      );
    }
    if (record.result?.kind === 'unknown_outcome') {
      return this.#reconcile(record);
    }
    return record.result === undefined
      ? record.settled
      : Promise.resolve(record.result);
  }

  #admit<Evidence>(
    operation: CoordinatedOperation<Evidence>,
    coordination: OperationCoordination,
  ): OperationAdmission {
    const record = this.#record(operation, coordination, true, 'running');
    this.#operations.set(record.id, record);
    void this.#run(record);
    return { kind: 'accepted', operation: summary(record) };
  }

  async #rejectBusy<Evidence>(
    operation: CoordinatedOperation<Evidence>,
    coordination: OperationCoordination,
    conflicts: readonly RecordState[],
  ): Promise<OperationAdmission> {
    const conflictSummaries = conflicts.map(summary);
    await operation.reconcileBusy({ conflicts: conflictSummaries });

    const record = this.#record(operation, coordination, false, 'terminal');
    const result = withId(record.id, {
      kind: 'rejected',
      code: 'busy',
      message: 'A conflicting operation is active.',
    }) as RejectedResult;
    record.result = result;
    record.settle(result);
    this.#operations.set(record.id, record);
    return { kind: 'rejected', result, conflicts: conflictSummaries };
  }

  async #run(record: RecordState) {
    try {
      record.execution = {
        kind: 'returned',
        evidence: await record.execute({
          signal: new AbortController().signal,
        }),
      };
    } catch (error) {
      record.execution = { kind: 'threw', error };
    }
    await this.#reconcile(record);
  }

  #reconcile(record: RecordState): Promise<OperationResult> {
    if (record.reconciling !== undefined) return record.reconciling;
    if (record.execution === undefined) return record.settled;

    record.phase = 'reconciling';
    const promise = Promise.resolve()
      .then(() =>
        record.reconcile({
          cancellationRequested: false,
          execution: record.execution as OperationExecution<unknown>,
          timedOut: false,
        }),
      )
      .then((outcome) => this.#settle(record, outcome))
      .catch(() => this.#settle(record, unknownOutcome()));
    record.reconciling = promise;
    void promise.then(() => {
      if (record.reconciling === promise) record.reconciling = undefined;
    });
    return promise;
  }

  #settle(record: RecordState, outcome: ReconciledOperationResult) {
    const result = withId(record.id, outcome);
    record.phase = 'terminal';
    record.result = result;
    record.lease = result.kind === 'unknown_outcome';
    record.settle(result);
    return result;
  }

  #record<Evidence>(
    operation: CoordinatedOperation<Evidence>,
    coordination: OperationCoordination,
    lease: boolean,
    phase: OperationSummary['phase'],
  ): RecordState {
    const done = deferred<OperationResult>();
    return {
      ...coordination,
      execute: (context) => operation.execute(context),
      id: this.#ids.issue('operation'),
      lease,
      phase,
      reconcile: (context) =>
        operation.reconcile(
          context as OperationReconciliationContext<Evidence>,
        ),
      settle: done.resolve,
      settled: done.promise,
    };
  }

  #conflicts(candidate: OperationCoordination) {
    return [...this.#operations.values()].filter(
      (record) =>
        record.lease && operationCoordinationConflicts(record, candidate),
    );
  }
}

export function createOperationCoordinator(): OperationCoordinator {
  return new Coordinator();
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

function summary(record: RecordState): CoordinatedOperationSummary {
  return {
    operationId: record.id,
    category: record.category,
    phase: record.phase,
    progress: null,
    retryAllowed:
      record.phase === 'terminal' &&
      record.result !== undefined &&
      record.result.kind !== 'unknown_outcome',
  };
}

function withId(id: OperationId, outcome: ReconciledOperationResult) {
  return operationResultSchema.parse({ ...outcome, operationId: id });
}

function unknownOutcome(): ReconciledOperationResult {
  return {
    kind: 'unknown_outcome',
    code: 'reconciliation_incomplete',
    message: 'Reconciliation could not establish the operation outcome.',
    recoveryAvailable: true,
  };
}

function key(...parts: readonly string[]) {
  return JSON.stringify(parts);
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
