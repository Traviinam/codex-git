import type { OperationId, OperationResult } from '@codex-git/protocol';

import {
  createOperationLifecycleStore,
  type LifecycleCloseResult,
  type ManagedOperationRecord,
  type OperationLifecycleStore,
} from './operation-lifecycle.js';

interface TimeoutScheduler {
  schedule(
    milliseconds: number,
    onTimeout: () => void,
  ): {
    cancel(): void;
  };
}

export interface CoordinatorLifecycleRecord extends ManagedOperationRecord {
  readonly abort: AbortController;
  readonly settle: (result: OperationResult) => void;
  readonly settled: Promise<OperationResult>;
  cancellationRequested: boolean;
  reconciling?: Promise<OperationResult>;
  timedOut: boolean;
}

export interface CoordinatorLifecycleOptions<
  Record extends CoordinatorLifecycleRecord,
  Summary,
> {
  readonly closeTimeoutMilliseconds?: number;
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
  readonly #store: OperationLifecycleStore<Record>;
  #closePromise?: Promise<LifecycleCloseResult>;

  constructor(options: CoordinatorLifecycleOptions<Record, Summary>) {
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
        (error: unknown) => {
          if (record.reconciling === promise) record.reconciling = undefined;
          throw error;
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
    const result = await this.#store.close({
      drain: (record) => {
        if (record.result?.kind === 'unknown_outcome') {
          return this.reconcile(record, () => reconcile(record));
        }
        this.#requestCancellation(record);
        return record.settled;
      },
    });
    if (result.kind === 'timed_out') {
      for (const operationId of result.pendingOperationIds) {
        const record = this.#store.get(operationId);
        if (record === undefined) continue;
        record.timedOut = true;
        this.#requestCancellation(record);
      }
    }
    return result;
  }

  settle(record: Record, result: OperationResult) {
    this.#assertOwned(record);
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
