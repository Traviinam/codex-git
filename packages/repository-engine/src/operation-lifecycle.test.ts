import { describe, expect, it } from 'vitest';

import {
  operationIdSchema,
  operationSuccessResultSchema,
  type OperationId,
  type OperationResult,
} from '@codex-git/protocol';

import {
  createOperationLifecycleStore,
  type ManagedOperationRecord,
} from './operation-lifecycle.js';

interface TestRecord extends ManagedOperationRecord {
  label: string;
}

interface TestSummary {
  readonly label: string;
}

describe('operation lifecycle store', () => {
  it('serializes reentrant publication and isolates observer failures', async () => {
    const first = knownRecord('1', 'first');
    const second = knownRecord('2', 'second');
    const third = knownRecord('3', 'third');
    const afterClose = knownRecord('4', 'after close');
    const observed: string[] = [];
    let callbackDepth = 0;
    let maximumDepth = 0;
    let closeFromObserver: Promise<unknown> | undefined;
    const store = createOperationLifecycleStore<TestRecord, TestSummary>({
      publish: ({ label }) => {
        callbackDepth += 1;
        maximumDepth = Math.max(maximumDepth, callbackDepth);
        observed.push(label);
        try {
          if (label === 'first') {
            expect(store.publish(second)).toBe(true);
            second.label = 'mutated after enqueue';
            throw new Error('Observer failure');
          }
          if (label === 'second') expect(store.publish(third)).toBe(true);
          if (label === 'third') {
            closeFromObserver = store.close({
              drain: async () => undefined,
            });
            expect(store.add(afterClose)).toBe(false);
          }
        } finally {
          callbackDepth -= 1;
        }
      },
      summarize: ({ label }) => ({ label }),
    });
    for (const record of [first, second, third]) {
      expect(store.add(record)).toBe(true);
    }

    expect(store.publish(first)).toBe(true);

    expect(observed).toEqual(['first', 'second', 'third']);
    expect(maximumDepth).toBe(1);
    await expect(closeFromObserver).resolves.toEqual({ kind: 'drained' });
    expect(store.publish(afterClose)).toBe(false);

    const brokenSummary = createOperationLifecycleStore<
      TestRecord,
      TestSummary
    >({
      summarize: () => {
        throw new Error('Summary failure');
      },
    });
    expect(brokenSummary.add(afterClose)).toBe(true);
    expect(brokenSummary.publish(afterClose)).toBe(false);
  });

  it('bounds known terminal retention without evicting live or Unknown leases', () => {
    const store = createStore({ terminalRetention: 2 });
    const live = liveRecord('1', 'live', 'running');
    const unknown = unknownRecord('2', 'unknown');
    const first = knownRecord('3', 'first');
    const second = knownRecord('4', 'second');
    const third = knownRecord('5', 'third');
    for (const record of [live, unknown, first, second, third]) {
      expect(store.add(record)).toBe(true);
      store.retainTerminal(record);
    }

    expect(store.get(first.id)).toBeUndefined();
    expect(store.get(second.id)).toBe(second);
    expect(store.get(third.id)).toBe(third);
    expect(store.get(live.id)).toBe(live);
    expect(store.get(unknown.id)).toBe(unknown);
    expect(store.records()).toHaveLength(4);

    unknown.result = success(unknown.id);
    unknown.lease = false;
    store.retainTerminal(unknown);
    expect(store.get(second.id)).toBeUndefined();
    expect(store.get(unknown.id)).toBe(unknown);

    const zeroCapacity = createStore({ terminalRetention: 0 });
    const zeroKnown = knownRecord('6', 'zero known');
    const zeroLive = liveRecord('7', 'zero live', 'accepted');
    const zeroUnknown = unknownRecord('8', 'zero unknown');
    for (const record of [zeroKnown, zeroLive, zeroUnknown]) {
      expect(zeroCapacity.add(record)).toBe(true);
      zeroCapacity.retainTerminal(record);
    }
    expect(zeroCapacity.get(zeroKnown.id)).toBeUndefined();
    expect(zeroCapacity.get(zeroLive.id)).toBe(zeroLive);
    expect(zeroCapacity.get(zeroUnknown.id)).toBe(zeroUnknown);
  });

  it('drains only active, reconciling, and Unknown records during close', async () => {
    const timeout = controlledTimeout();
    const store = createStore({
      closeTimeoutMilliseconds: 1_000,
      timeoutScheduler: timeout.scheduler,
    });
    const known = knownRecord('1', 'known');
    const active = liveRecord('2', 'active', 'running');
    const reconciling = liveRecord('3', 'reconciling', 'reconciling');
    const unknown = unknownRecord('4', 'unknown');
    const completions = new Map<OperationId, ReturnType<typeof deferred>>();
    const drained: OperationId[] = [];
    for (const record of [known, active, reconciling, unknown]) {
      expect(store.add(record)).toBe(true);
      completions.set(record.id, deferred());
    }

    let reentrantClose: Promise<unknown> | undefined;
    const close = store.close({
      drain: (record) => {
        drained.push(record.id);
        if (reentrantClose === undefined) {
          reentrantClose = store.close({ drain: async () => undefined });
        }
        return completions.get(record.id)!.promise;
      },
    });
    expect(reentrantClose).toBe(close);
    expect(store.close({ drain: async () => undefined })).toBe(close);
    expect(store.open).toBe(false);
    expect(store.add(knownRecord('5', 'late'))).toBe(false);
    expect(drained).toEqual([active.id, reconciling.id, unknown.id]);

    completions.get(reconciling.id)!.resolve();
    completions.get(unknown.id)!.resolve();
    await Promise.resolve();
    let completed = false;
    void close.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    completions.get(active.id)!.resolve();

    await expect(close).resolves.toEqual({ kind: 'drained' });
    expect(timeout.cancellations).toBe(1);
  });

  it('returns the exact pending records when bounded close times out', async () => {
    const timeout = controlledTimeout();
    const store = createStore({
      closeTimeoutMilliseconds: 50,
      timeoutScheduler: timeout.scheduler,
    });
    const completed = liveRecord('1', 'completed', 'running');
    const pending = liveRecord('2', 'pending', 'reconciling');
    const never = deferred();
    expect(store.add(completed)).toBe(true);
    expect(store.add(pending)).toBe(true);

    const close = store.close({
      drain: (record) =>
        record.id === completed.id ? Promise.resolve() : never.promise,
    });
    let result: Awaited<typeof close> | undefined;
    void close.then((value) => {
      result = value;
    });
    await Promise.resolve();
    expect(timeout.delay).toBe(50);
    timeout.trigger();
    await until(() => result !== undefined);

    expect(result).toEqual({
      kind: 'timed_out',
      pendingOperationIds: [pending.id],
    });
    expect(store.open).toBe(false);
    expect(store.records()).toEqual([completed, pending]);
  });

  it('rejects invalid capacity and duplicate live identities', () => {
    expect(() => createStore({ terminalRetention: -1 })).toThrow(
      'terminalRetention',
    );
    expect(() => createStore({ closeTimeoutMilliseconds: 1.5 })).toThrow(
      'closeTimeoutMilliseconds',
    );
    expect(() =>
      createStore({ closeTimeoutMilliseconds: 2_147_483_648 }),
    ).toThrow('timer range');

    const store = createStore();
    const record = liveRecord('1', 'live', 'running');
    expect(store.add(record)).toBe(true);
    expect(() => store.add({ ...record })).toThrow('already registered');

    let summaries = 0;
    let publications = 0;
    const ownership = createOperationLifecycleStore<TestRecord, TestSummary>({
      publish: () => {
        publications += 1;
      },
      summarize: ({ label }) => {
        summaries += 1;
        return { label };
      },
    });
    const owned = liveRecord('2', 'owned', 'running');
    expect(ownership.add(owned)).toBe(true);
    const foreignSameId = { ...owned, label: 'foreign' };
    expect(() => ownership.publish(foreignSameId)).toThrow('not registered');
    expect(summaries).toBe(0);
    expect(publications).toBe(0);
  });
});

function createStore(
  options: {
    readonly closeTimeoutMilliseconds?: number;
    readonly terminalRetention?: number;
    readonly timeoutScheduler?: ReturnType<
      typeof controlledTimeout
    >['scheduler'];
  } = {},
) {
  return createOperationLifecycleStore<TestRecord, TestSummary>({
    ...options,
    summarize: ({ label }) => ({ label }),
  });
}

function knownRecord(digit: string, label: string): TestRecord {
  const id = operationId(digit);
  return {
    id,
    label,
    lease: false,
    phase: 'terminal',
    result: success(id),
  };
}

function liveRecord(
  digit: string,
  label: string,
  phase: 'accepted' | 'running' | 'reconciling',
): TestRecord {
  return { id: operationId(digit), label, lease: true, phase };
}

function unknownRecord(digit: string, label: string): TestRecord {
  const id = operationId(digit);
  return {
    id,
    label,
    lease: true,
    phase: 'terminal',
    result: {
      kind: 'unknown_outcome',
      operationId: id,
      code: 'reconciliation_incomplete',
      message: 'Fresh evidence is incomplete.',
      recoveryAvailable: true,
    },
  };
}

function success(operationId: OperationId): OperationResult {
  return {
    kind: 'succeeded',
    operationId,
    result: operationSuccessResultSchema.parse({ kind: 'no_change' }),
  };
}

function operationId(digit: string) {
  return operationIdSchema.parse(`operation_${digit.repeat(32)}`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition was not reached.');
}

function controlledTimeout() {
  let callback: (() => void) | undefined;
  let cancellations = 0;
  let delay: number | undefined;
  return {
    get cancellations() {
      return cancellations;
    },
    get delay() {
      return delay;
    },
    scheduler: {
      schedule(milliseconds: number, onTimeout: () => void) {
        delay = milliseconds;
        callback = onTimeout;
        return {
          cancel() {
            cancellations += 1;
            callback = undefined;
          },
        };
      },
    },
    trigger() {
      const scheduled = callback;
      callback = undefined;
      scheduled?.();
    },
  };
}
