import type { OperationId, OperationResult } from '@codex-git/protocol';

import {
  createOperationLifecycleStore,
  systemTimeoutScheduler,
  validateTimeoutMilliseconds,
  type LifecycleCloseResult,
  type ManagedOperationRecord,
  type OperationLifecycleStore,
  type TimeoutScheduler,
} from './operation-lifecycle.js';

export interface CoordinatorLifecycleRecord extends ManagedOperationRecord {
  readonly abort: AbortController;
  readonly settle: (result: OperationResult) => void;
  readonly settled: Promise<OperationResult>;
  onTimeout?: () => void;
  cancellationRequested: boolean;
  operationTimeout?: { cancel(): void };
  reconciling?: Promise<OperationResult>;
  timedOut: boolean;
}

export interface CoordinatorLifecycleOptions<
  Record extends CoordinatorLifecycleRecord,
  Summary,
> {
  readonly closeTimeoutMilliseconds?: number;
  readonly operationTimeoutMilliseconds?: number;
  readonly publish?: (summary: Summary) => void;
  readonly summarize: (record: Record) => Summary;
  readonly terminalRetention?: number;
  readonly timeoutScheduler?: TimeoutScheduler;
}

export interface CoordinatorLifecycle<
  Record extends CoordinatorLifecycleRecord,
> {
  readonly open: boolean;
  activate(record: Record): 'closed' | 'interrupted' | 'running';
  addTerminal(record: Record): boolean;
  cancel(
    operationId: OperationId,
    reconcile: (record: Record) => Promise<OperationResult>,
  ): Promise<OperationResult>;
  close(
    reconcile: (record: Record) => Promise<OperationResult>,
  ): Promise<LifecycleCloseResult>;
  get(operationId: OperationId): Record;
  publish(record: Record): void;
  reconcile(
    record: Record,
    attempt: () => Promise<OperationResult>,
  ): Promise<OperationResult>;
  records(): readonly Record[];
  settle(record: Record, result: OperationResult): OperationResult;
}

class LifecycleAdapter<
  Record extends CoordinatorLifecycleRecord,
  Summary,
> implements CoordinatorLifecycle<Record> {
  readonly #operationTimeout: number | undefined;
  readonly #store: OperationLifecycleStore<Record>;
  readonly #timeoutScheduler: TimeoutScheduler;
  #closePromise?: Promise<LifecycleCloseResult>;

  constructor(options: CoordinatorLifecycleOptions<Record, Summary>) {
    this.#operationTimeout =
      options.operationTimeoutMilliseconds === undefined
        ? undefined
        : validateTimeoutMilliseconds(
            options.operationTimeoutMilliseconds,
            'operationTimeoutMilliseconds',
          );
    this.#timeoutScheduler = options.timeoutScheduler ?? systemTimeoutScheduler;
    this.#store = createOperationLifecycleStore({
      closeTimeoutMilliseconds: options.closeTimeoutMilliseconds,
      publish: options.publish,
      summarize: options.summarize,
      terminalRetention: options.terminalRetention,
      timeoutScheduler: options.timeoutScheduler,
    });
  }

  get open() {
    return this.#store.open;
  }

  activate(record: Record) {
    record.phase = 'accepted';
    if (!this.#store.add(record)) return 'closed' as const;
    this.#store.publish(record);
    if (!this.open) return 'interrupted' as const;
    record.phase = 'running';
    this.#armOperationTimeout(record);
    this.#store.publish(record);
    return this.open ? ('running' as const) : ('interrupted' as const);
  }

  addTerminal(record: Record) {
    record.phase = 'terminal';
    return this.#store.add(record);
  }

  get(operationId: OperationId) {
    const record = this.#store.get(operationId);
    if (record === undefined) {
      throw new Error(
        'Operation result is not retained by this Repository Session.',
      );
    }
    return record;
  }

  records() {
    return this.#store.records();
  }

  publish(record: Record) {
    this.#store.publish(record);
  }

  reconcile(record: Record, attempt: () => Promise<OperationResult>) {
    this.#assertOwned(record);
    if (record.reconciling !== undefined) return record.reconciling;
    record.phase = 'reconciling';
    const promise = Promise.resolve()
      .then(attempt)
      .then(
        (result) => {
          if (record.reconciling === promise) record.reconciling = undefined;
          return this.settle(record, result);
        },
        () => {
          if (record.reconciling === promise) record.reconciling = undefined;
          return this.settle(record, reconciliationIncomplete(record.id));
        },
      );
    record.reconciling = promise;
    this.#store.publish(record);
    return promise;
  }

  cancel(
    operationId: OperationId,
    reconcile: (record: Record) => Promise<OperationResult>,
  ) {
    const record = this.get(operationId);
    if (record.result?.kind === 'unknown_outcome') {
      return this.reconcile(record, () => reconcile(record));
    }
    if (record.result !== undefined) return Promise.resolve(record.result);
    this.#requestCancellation(record);
    return record.settled;
  }

  close(reconcile: (record: Record) => Promise<OperationResult>) {
    if (this.#closePromise !== undefined) return this.#closePromise;
    const done = deferred<LifecycleCloseResult>();
    this.#closePromise = done.promise;
    void this.#finishClose(reconcile).then(done.resolve);
    return this.#closePromise;
  }

  async #finishClose(reconcile: (record: Record) => Promise<OperationResult>) {
    return this.#store.close({
      drain: (record) => {
        if (record.result?.kind === 'unknown_outcome') {
          return this.reconcile(record, () => reconcile(record));
        }
        this.#requestCancellation(record);
        return record.settled;
      },
      finalize: (result) => {
        if (result.kind !== 'timed_out') return;
        for (const operationId of result.pendingOperationIds) {
          const record = this.#store.get(operationId);
          if (record === undefined) continue;
          const cancellationAlreadyRequested = record.cancellationRequested;
          record.timedOut = true;
          this.#requestCancellation(record);
          if (cancellationAlreadyRequested) this.#store.publish(record);
        }
      },
    });
  }

  settle(record: Record, result: OperationResult) {
    this.#assertOwned(record);
    record.operationTimeout?.cancel();
    record.operationTimeout = undefined;
    record.phase = 'terminal';
    record.result = result;
    record.lease = result.kind === 'unknown_outcome';
    record.settle(result);
    this.#store.publish(record);
    this.#store.retainTerminal(record);
    return result;
  }

  #requestCancellation(record: Record) {
    this.#assertOwned(record);
    if (record.cancellationRequested) return;
    record.cancellationRequested = true;
    record.abort.abort();
    this.#store.publish(record);
  }

  #armOperationTimeout(record: Record) {
    if (this.#operationTimeout === undefined) return;
    let fired = false;
    const timeout = this.#timeoutScheduler.schedule(
      this.#operationTimeout,
      () => {
        fired = true;
        record.operationTimeout = undefined;
        if (record.result !== undefined) return;
        record.timedOut = true;
        this.#requestCancellation(record);
        record.onTimeout?.();
      },
    );
    record.operationTimeout = timeout;
    if (fired || record.result !== undefined) {
      timeout.cancel();
      record.operationTimeout = undefined;
    }
  }

  #assertOwned(record: Record) {
    if (this.#store.get(record.id) !== record) {
      throw new Error('Operation record is not registered by this adapter.');
    }
  }
}

export function createCoordinatorLifecycle<
  Record extends CoordinatorLifecycleRecord,
  Summary,
>(
  options: CoordinatorLifecycleOptions<Record, Summary>,
): CoordinatorLifecycle<Record> {
  return new LifecycleAdapter(options);
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function reconciliationIncomplete(operationId: OperationId): OperationResult {
  return {
    kind: 'unknown_outcome',
    operationId,
    code: 'reconciliation_incomplete',
    message: 'Reconciliation could not establish the operation outcome.',
    recoveryAvailable: true,
  };
}
