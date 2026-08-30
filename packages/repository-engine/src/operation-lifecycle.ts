import type {
  OperationId,
  OperationResult,
  RepositorySnapshot,
} from '@codex-git/protocol';

type OperationPhase = RepositorySnapshot['operations'][number]['phase'];

export interface TimeoutScheduler {
  schedule(
    milliseconds: number,
    onTimeout: () => void,
  ): {
    cancel(): void;
  };
}

export interface ManagedOperationRecord {
  readonly id: OperationId;
  lease: boolean;
  phase: OperationPhase;
  result?: OperationResult;
}

export type LifecycleCloseResult =
  | { readonly kind: 'drained' }
  | {
      readonly kind: 'timed_out';
      readonly pendingOperationIds: readonly OperationId[];
    };

export interface LifecycleCloseHooks<Record extends ManagedOperationRecord> {
  drain(record: Record): Promise<unknown>;
  finalize?(result: LifecycleCloseResult): void;
}

export interface OperationLifecycleStoreOptions<
  Record extends ManagedOperationRecord,
  Summary,
> {
  readonly closeTimeoutMilliseconds?: number;
  readonly publish?: (summary: Summary) => void;
  readonly summarize: (record: Record) => Summary;
  readonly terminalRetention?: number;
  readonly timeoutScheduler?: TimeoutScheduler;
}

export interface OperationLifecycleStore<
  Record extends ManagedOperationRecord,
> {
  readonly open: boolean;
  add(record: Record): boolean;
  close(hooks: LifecycleCloseHooks<Record>): Promise<LifecycleCloseResult>;
  get(operationId: OperationId): Record | undefined;
  publish(record: Record): boolean;
  records(): readonly Record[];
  retainTerminal(record: Record): void;
}

interface TrackedDrain<Record extends ManagedOperationRecord> {
  readonly operation: Record;
  settled: Promise<void>;
  complete: boolean;
}

class LifecycleStore<
  Record extends ManagedOperationRecord,
  Summary,
> implements OperationLifecycleStore<Record> {
  readonly #closeTimeout: number;
  readonly #knownTerminals: OperationId[] = [];
  readonly #operations = new Map<OperationId, Record>();
  readonly #observer: (summary: Summary) => void;
  readonly #publicationQueue: Summary[] = [];
  readonly #retained = new Set<OperationId>();
  readonly #retention: number;
  readonly #summarize: (record: Record) => Summary;
  readonly #timeoutScheduler: TimeoutScheduler;
  #closePromise?: Promise<LifecycleCloseResult>;
  #publishing = false;
  #state: 'open' | 'closing' | 'closed' = 'open';

  constructor(options: OperationLifecycleStoreOptions<Record, Summary>) {
    this.#closeTimeout = validateTimeoutMilliseconds(
      options.closeTimeoutMilliseconds ?? 250,
      'closeTimeoutMilliseconds',
    );
    this.#retention = nonnegative(
      options.terminalRetention ?? 100,
      'terminalRetention',
    );
    this.#observer = options.publish ?? (() => undefined);
    this.#summarize = options.summarize;
    this.#timeoutScheduler = options.timeoutScheduler ?? systemTimeoutScheduler;
  }

  get open() {
    return this.#state === 'open';
  }

  add(record: Record) {
    if (!this.open) return false;
    if (this.#operations.has(record.id)) {
      throw new Error('Operation identity is already registered.');
    }
    this.#operations.set(record.id, record);
    return true;
  }

  get(operationId: OperationId) {
    return this.#operations.get(operationId);
  }

  records() {
    return [...this.#operations.values()];
  }

  publish(record: Record) {
    if (this.#isClosed()) return false;
    this.#assertRegistered(record);
    let summary: Summary;
    try {
      summary = this.#summarize(record);
    } catch {
      return false;
    }
    this.#publicationQueue.push(summary);
    if (this.#publishing) return true;

    this.#publishing = true;
    try {
      while (this.#publicationQueue.length > 0 && !this.#isClosed()) {
        const next = this.#publicationQueue.shift() as Summary;
        try {
          this.#observer(next);
        } catch {
          // An observer cannot interrupt lifecycle state or later publication.
        }
      }
    } finally {
      this.#publishing = false;
      if (this.#isClosed()) this.#publicationQueue.length = 0;
    }
    return true;
  }

  retainTerminal(record: Record) {
    this.#assertRegistered(record);
    if (!knownTerminal(record) || this.#retained.has(record.id)) return;

    this.#retained.add(record.id);
    this.#knownTerminals.push(record.id);
    while (this.#knownTerminals.length > this.#retention) {
      const expired = this.#knownTerminals.shift();
      if (expired === undefined) break;
      this.#retained.delete(expired);
      const candidate = this.#operations.get(expired);
      if (candidate !== undefined && knownTerminal(candidate)) {
        this.#operations.delete(expired);
      }
    }
  }

  close(hooks: LifecycleCloseHooks<Record>): Promise<LifecycleCloseResult> {
    if (this.#closePromise !== undefined) return this.#closePromise;

    this.#state = 'closing';
    const done = deferred<LifecycleCloseResult>();
    this.#closePromise = done.promise;
    const tracked = this.records()
      .filter(needsDrain)
      .map((record) => trackDrain(record, hooks));
    void this.#finishClose(tracked, hooks).then(done.resolve);
    return this.#closePromise;
  }

  async #finishClose(
    tracked: readonly TrackedDrain<Record>[],
    hooks: LifecycleCloseHooks<Record>,
  ) {
    const completed = await waitBounded(
      Promise.all(tracked.map(({ settled }) => settled)),
      this.#closeTimeout,
      this.#timeoutScheduler,
    );
    const result: LifecycleCloseResult = completed
      ? { kind: 'drained' }
      : {
          kind: 'timed_out',
          pendingOperationIds: tracked
            .filter(({ complete }) => !complete)
            .map(({ operation }) => operation.id),
        };
    try {
      hooks.finalize?.(result);
    } catch {
      // Finalization cannot prevent the store from closing.
    }
    this.#state = 'closed';
    this.#publicationQueue.length = 0;
    return result;
  }

  #isClosed() {
    return this.#state === 'closed';
  }

  #assertRegistered(record: Record) {
    if (this.#operations.get(record.id) !== record) {
      throw new Error('Operation record is not registered by this store.');
    }
  }
}

export function createOperationLifecycleStore<
  Record extends ManagedOperationRecord,
  Summary,
>(
  options: OperationLifecycleStoreOptions<Record, Summary>,
): OperationLifecycleStore<Record> {
  return new LifecycleStore(options);
}

function knownTerminal(record: ManagedOperationRecord) {
  return (
    record.phase === 'terminal' &&
    !record.lease &&
    record.result !== undefined &&
    record.result.kind !== 'unknown_outcome'
  );
}

function needsDrain(record: ManagedOperationRecord) {
  return !knownTerminal(record);
}

function trackDrain<Record extends ManagedOperationRecord>(
  record: Record,
  hooks: LifecycleCloseHooks<Record>,
): TrackedDrain<Record> {
  const tracked: TrackedDrain<Record> = {
    complete: false,
    operation: record,
    settled: Promise.resolve(),
  };
  let drain: Promise<unknown>;
  try {
    drain = hooks.drain(record);
  } catch (error) {
    drain = Promise.reject(error);
  }
  tracked.settled = Promise.resolve(drain).then(
    () => {
      tracked.complete = true;
    },
    () => {
      tracked.complete = true;
    },
  );
  return tracked;
}

function nonnegative(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

export function validateTimeoutMilliseconds(value: number, name: string) {
  const validated = nonnegative(value, name);
  if (validated > 2_147_483_647) {
    throw new Error(`${name} exceeds the supported timer range.`);
  }
  return validated;
}

function waitBounded(
  pending: Promise<unknown>,
  timeout: number,
  scheduler: TimeoutScheduler,
) {
  return new Promise<boolean>((resolve) => {
    let complete = false;
    let cancelAfterSchedule = false;
    let cancelTimer = () => {
      cancelAfterSchedule = true;
    };
    const finish = (result: boolean) => {
      if (complete) return;
      complete = true;
      cancelTimer();
      resolve(result);
    };
    const timer = scheduler.schedule(timeout, () => finish(false));
    cancelTimer = () => timer.cancel();
    if (cancelAfterSchedule) timer.cancel();
    void pending.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

export const systemTimeoutScheduler: TimeoutScheduler = {
  schedule(milliseconds, onTimeout) {
    const timer = setTimeout(onTimeout, milliseconds);
    return { cancel: () => clearTimeout(timer) };
  },
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
