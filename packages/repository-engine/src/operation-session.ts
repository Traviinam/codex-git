import {
  createOpaqueIdAuthority,
  operationResultSchema,
  type OperationId,
  type OperationResult,
} from '@codex-git/protocol';

import {
  coordinateOperation,
  operationCoordinationConflicts,
  type CoordinatedOperation,
  type CoordinatedOperationSummary,
  type OperationCoordination,
  type OperationExecution,
  type OperationReconciliationContext,
  type ReconciledOperationResult,
} from './operation-coordinator.js';
import {
  createCoordinatorLifecycle,
  type CoordinatorLifecycle,
  type CoordinatorLifecycleOptions,
  type CoordinatorLifecycleRecord,
} from './operation-coordinator-lifecycle.js';
import type { LifecycleCloseResult } from './operation-lifecycle.js';

export interface OperationSessionSummary extends CoordinatedOperationSummary {
  readonly cancellationRequested: boolean;
  readonly timedOut: boolean;
}

export type OperationSessionAdmission =
  | {
      readonly kind: 'accepted';
      readonly operation: OperationSessionSummary;
    }
  | {
      readonly kind: 'rejected';
      readonly result: Extract<OperationResult, { kind: 'rejected' }>;
      readonly conflicts: readonly OperationSessionSummary[];
    }
  | {
      readonly kind: 'unknown_outcome';
      readonly result: Extract<OperationResult, { kind: 'unknown_outcome' }>;
      readonly conflicts: readonly OperationSessionSummary[];
    }
  | { readonly kind: 'closed' };

export type OperationSessionOptions = Omit<
  CoordinatorLifecycleOptions<
    CoordinatorLifecycleRecord,
    OperationSessionSummary
  >,
  'summarize'
>;

export interface OperationSession {
  dispatch<Evidence>(
    operation: CoordinatedOperation<Evidence>,
  ): Promise<OperationSessionAdmission>;
  cancel(operationId: OperationId): Promise<OperationResult>;
  close(): Promise<LifecycleCloseResult>;
  recover(operationId: OperationId): Promise<OperationResult>;
}

interface SessionRecord
  extends OperationCoordination, CoordinatorLifecycleRecord {
  readonly reconcileBusy: (context: {
    readonly conflicts: readonly OperationSessionSummary[];
  }) => Promise<void>;
  readonly execute: (context: { signal: AbortSignal }) => Promise<unknown>;
  readonly reconcile: (
    context: OperationReconciliationContext<unknown>,
  ) => Promise<ReconciledOperationResult>;
  busyConflicts?: readonly OperationSessionSummary[];
  execution?: OperationExecution<unknown>;
}

class Session implements OperationSession {
  readonly #ids = createOpaqueIdAuthority();
  readonly #lifecycle: CoordinatorLifecycle<SessionRecord>;

  constructor(options: OperationSessionOptions) {
    this.#lifecycle = createCoordinatorLifecycle({
      ...options,
      summarize,
    });
  }

  async dispatch<Evidence>(operation: CoordinatedOperation<Evidence>) {
    const coordination = coordinateOperation(operation);
    if (!this.#lifecycle.open) return { kind: 'closed' } as const;
    const conflicts = this.#conflicts(coordination);
    for (const record of conflicts) {
      if (record.result?.kind === 'unknown_outcome') {
        void this.#reconcile(record);
      }
    }
    if (conflicts.length > 0) {
      return this.#rejectBusy(operation, coordination, conflicts);
    }
    return this.#admit(operation, coordination);
  }

  cancel(operationId: OperationId) {
    return this.#lifecycle.cancel(operationId, (record) =>
      this.#attempt(record),
    );
  }

  close() {
    return this.#lifecycle.close((record) => this.#attempt(record));
  }

  recover(operationId: OperationId) {
    const record = this.#lifecycle.get(operationId);
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
  ): OperationSessionAdmission {
    const record = this.#record(operation, coordination, true);
    const activation = this.#lifecycle.activate(record);
    if (activation === 'closed') return { kind: 'closed' };
    if (activation === 'interrupted') {
      this.#lifecycle.settle(record, withId(record.id, unsupportedState()));
      return { kind: 'closed' };
    }
    void this.#run(record);
    return { kind: 'accepted', operation: summarize(record) };
  }

  async #rejectBusy<Evidence>(
    operation: CoordinatedOperation<Evidence>,
    coordination: OperationCoordination,
    conflicts: readonly SessionRecord[],
  ): Promise<OperationSessionAdmission> {
    const conflictSummaries = conflicts.map(summarize);
    const record = this.#record(operation, coordination, true);
    record.busyConflicts = conflictSummaries;
    if (!this.#lifecycle.addTerminal(record)) return { kind: 'closed' };
    const result = await this.#lifecycle.reconcile(record, () =>
      this.#attempt(record),
    );
    if (result.kind === 'rejected') {
      return { kind: 'rejected', result, conflicts: conflictSummaries };
    }
    if (result.kind === 'unknown_outcome') {
      return {
        kind: 'unknown_outcome',
        result,
        conflicts: conflictSummaries,
      };
    }
    throw new Error('BUSY reconciliation produced an invalid outcome.');
  }

  async #run(record: SessionRecord) {
    try {
      const evidence = await record.execute({ signal: record.abort.signal });
      if (
        record.execution === undefined ||
        record.execution.kind === 'timed_out'
      ) {
        record.execution = { kind: 'returned', evidence };
      }
    } catch (error) {
      if (
        record.execution === undefined ||
        record.execution.kind === 'timed_out'
      ) {
        record.execution = { kind: 'threw', error };
      }
    }
    await this.#reconcile(record);
    if (record.result?.kind === 'unknown_outcome') {
      await this.#reconcile(record);
    }
  }

  #reconcile(record: SessionRecord) {
    if (
      record.result !== undefined &&
      record.result.kind !== 'unknown_outcome'
    ) {
      return Promise.resolve(record.result);
    }
    if (record.execution === undefined && record.busyConflicts === undefined) {
      return record.settled;
    }
    return this.#lifecycle.reconcile(record, () => this.#attempt(record));
  }

  async #attempt(record: SessionRecord) {
    if (record.busyConflicts !== undefined) {
      await record.reconcileBusy({ conflicts: record.busyConflicts });
      return withId(record.id, {
        kind: 'rejected',
        code: 'busy',
        message: 'A conflicting operation is active.',
      });
    }
    const execution = record.execution as OperationExecution<unknown>;
    const outcome = await record.reconcile({
      cancellationRequested: record.cancellationRequested,
      execution,
      timedOut: record.timedOut,
    });
    if (execution.kind === 'timed_out') {
      return withId(record.id, {
        kind: 'unknown_outcome',
        code: 'reconciliation_incomplete',
        message: 'The timed-out process has not confirmed termination.',
        recoveryAvailable: true,
      });
    }
    return withId(record.id, outcome);
  }

  #record<Evidence>(
    operation: CoordinatedOperation<Evidence>,
    coordination: OperationCoordination,
    lease: boolean,
  ): SessionRecord {
    const done = deferred<OperationResult>();
    const record: SessionRecord = {
      ...coordination,
      abort: new AbortController(),
      cancellationRequested: false,
      execute: (context) => operation.execute(context),
      id: this.#ids.issue('operation'),
      lease,
      phase: 'accepted',
      reconcileBusy: (context) => operation.reconcileBusy(context),
      reconcile: (context) =>
        operation.reconcile(
          context as OperationReconciliationContext<Evidence>,
        ),
      settle: done.resolve,
      settled: done.promise,
      timedOut: false,
    };
    record.onTimeout = () => {
      if (record.execution !== undefined) return;
      record.execution = { kind: 'timed_out' };
      void this.#reconcile(record);
    };
    return record;
  }

  #conflicts(candidate: OperationCoordination) {
    return this.#lifecycle
      .records()
      .filter(
        (record) =>
          record.lease && operationCoordinationConflicts(record, candidate),
      );
  }
}

export function createOperationSession(
  options: OperationSessionOptions = {},
): OperationSession {
  return new Session(options);
}

function summarize(record: SessionRecord): OperationSessionSummary {
  return {
    operationId: record.id,
    category: record.category,
    phase: record.phase,
    progress: null,
    cancellationRequested: record.cancellationRequested,
    retryAllowed:
      record.phase === 'terminal' &&
      record.result !== undefined &&
      record.result.kind !== 'unknown_outcome' &&
      record.reconciling === undefined,
    timedOut: record.timedOut,
  };
}

function withId(
  operationId: OperationId,
  outcome: ReconciledOperationResult,
): OperationResult {
  return operationResultSchema.parse({ ...outcome, operationId });
}

function unsupportedState(): ReconciledOperationResult {
  return {
    kind: 'rejected',
    code: 'unsupported_state',
    message: 'The Repository Session is closing.',
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
