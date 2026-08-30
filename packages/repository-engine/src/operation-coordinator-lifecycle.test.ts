import { describe, expect, it } from 'vitest';

import {
  operationIdSchema,
  operationSuccessResultSchema,
  type OperationId,
  type OperationResult,
} from '@codex-git/protocol';

import {
  createCoordinatorLifecycle,
  type CoordinatorLifecycleRecord,
} from './operation-coordinator-lifecycle.js';

interface TestRecord extends CoordinatorLifecycleRecord {
  readonly label: string;
}

interface TestSummary {
  readonly cancellationRequested: boolean;
  readonly label: string;
  readonly phase: TestRecord['phase'];
  readonly resultKind: OperationResult['kind'] | null;
  readonly timedOut: boolean;
}

describe('coordinator lifecycle adapter', () => {
  it('interrupts activation when publication reentrantly starts close', async () => {
    const observed: TestSummary[] = [];
    let reentrantClose:
      ReturnType<ReturnType<typeof createLifecycle>['close']> | undefined;
    let repeatedClose:
      ReturnType<ReturnType<typeof createLifecycle>['close']> | undefined;
    const lifecycle = createLifecycle({
      publish: (summary) => {
        observed.push(summary);
        if (summary.phase === 'accepted' && reentrantClose === undefined) {
          reentrantClose = lifecycle.close(async (record) => record.settled);
          throw new Error('Observer failure');
        }
        if (summary.cancellationRequested && repeatedClose === undefined) {
          repeatedClose = lifecycle.close(async (record) => record.settled);
        }
      },
    });
    const active = activeRecord('1', 'active');

    expect(lifecycle.activate(active)).toBe('interrupted');
    expect(active.cancellationRequested).toBe(true);
    expect(active.abort.signal.aborted).toBe(true);
    expect(observed.map(({ phase }) => phase)).toEqual([
      'accepted',
      'accepted',
    ]);
    expect(repeatedClose).toBe(reentrantClose);
    lifecycle.settle(active, rejected(active.id));
    await expect(reentrantClose).resolves.toEqual({ kind: 'drained' });
    expect(lifecycle.activate(activeRecord('2', 'late'))).toBe('closed');
  });

  it('records cancellation intent without inventing the outcome', async () => {
    const lifecycle = createLifecycle();
    const active = activeRecord('1', 'active');
    expect(lifecycle.activate(active)).toBe('running');

    const cancellation = lifecycle.cancel(active.id, async () => {
      throw new Error('Running cancellation must await ordinary settlement.');
    });
    expect(
      lifecycle.cancel(active.id, async () => {
        throw new Error('Repeated cancellation must stay idempotent.');
      }),
    ).toBe(cancellation);
    expect(active.cancellationRequested).toBe(true);
    expect(active.abort.signal.aborted).toBe(true);
    expect(active.result).toBeUndefined();

    const result = success(active.id);
    lifecycle.settle(active, result);
    await expect(cancellation).resolves.toBe(result);

    const unknown = activeRecord('2', 'unknown');
    expect(lifecycle.addTerminal(unknown)).toBe(true);
    lifecycle.settle(unknown, unknownOutcome(unknown.id));
    let recoveries = 0;
    const recovered = lifecycle.cancel(unknown.id, async (record) => {
      recoveries += 1;
      return success(record.id);
    });
    await expect(recovered).resolves.toMatchObject({ kind: 'succeeded' });
    expect(recoveries).toBe(1);
  });

  it('deduplicates reconciliation and settles only from its returned result', async () => {
    const observed: TestSummary[] = [];
    const lifecycle = createLifecycle({
      publish: (summary) => observed.push(summary),
    });
    const unknown = activeRecord('1', 'unknown');
    expect(lifecycle.addTerminal(unknown)).toBe(true);
    lifecycle.settle(unknown, unknownOutcome(unknown.id));
    const evidence = deferred<OperationResult>();
    let attempts = 0;

    const first = lifecycle.reconcile(unknown, () => {
      attempts += 1;
      return evidence.promise;
    });
    const duplicate = lifecycle.reconcile(unknown, () => {
      attempts += 1;
      return Promise.resolve(rejected(unknown.id));
    });
    expect(duplicate).toBe(first);
    expect(attempts).toBe(0);
    await Promise.resolve();
    expect(attempts).toBe(1);
    expect(observed.at(-1)).toMatchObject({ phase: 'reconciling' });
    expect(unknown.result?.kind).toBe('unknown_outcome');

    evidence.resolve(success(unknown.id));
    await expect(first).resolves.toMatchObject({ kind: 'succeeded' });
    expect(unknown.phase).toBe('terminal');
    expect(unknown.result?.kind).toBe('succeeded');
    expect(unknown.reconciling).toBeUndefined();
  });

  it('drains live, reconciling, and Unknown records but skips known terminals', async () => {
    const timeout = controlledTimeout();
    const lifecycle = createLifecycle({
      closeTimeoutMilliseconds: 1_000,
      timeoutScheduler: timeout.scheduler,
    });
    const active = activeRecord('1', 'active');
    const reconciling = activeRecord('2', 'reconciling');
    const unknown = activeRecord('3', 'unknown');
    const known = activeRecord('4', 'known');
    expect(lifecycle.activate(active)).toBe('running');
    expect(lifecycle.activate(reconciling)).toBe('running');
    reconciling.phase = 'reconciling';
    lifecycle.publish(reconciling);
    expect(lifecycle.addTerminal(unknown)).toBe(true);
    lifecycle.settle(unknown, unknownOutcome(unknown.id));
    expect(lifecycle.addTerminal(known)).toBe(true);
    lifecycle.settle(known, success(known.id));
    const recovery = deferred<OperationResult>();
    const recovered: OperationId[] = [];

    const close = lifecycle.close((record) => {
      recovered.push(record.id);
      return recovery.promise;
    });
    expect(active.cancellationRequested).toBe(true);
    expect(reconciling.cancellationRequested).toBe(true);
    expect(known.cancellationRequested).toBe(false);
    await Promise.resolve();
    expect(recovered).toEqual([unknown.id]);
    lifecycle.settle(active, success(active.id));
    lifecycle.settle(reconciling, success(reconciling.id));
    recovery.resolve(success(unknown.id));

    await expect(close).resolves.toEqual({ kind: 'drained' });
    expect(timeout.cancellations).toBe(1);
  });

  it('marks only pending records when bounded close times out', async () => {
    const timeout = controlledTimeout();
    const lifecycle = createLifecycle({
      closeTimeoutMilliseconds: 250,
      timeoutScheduler: timeout.scheduler,
    });
    const completed = activeRecord('1', 'completed');
    const pending = activeRecord('2', 'pending');
    expect(lifecycle.activate(completed)).toBe('running');
    expect(lifecycle.activate(pending)).toBe('running');

    const close = lifecycle.close(async () => {
      throw new Error('No Unknown recovery is expected.');
    });
    lifecycle.settle(completed, success(completed.id));
    expect(timeout.delay).toBe(250);
    timeout.trigger();

    await expect(close).resolves.toEqual({
      kind: 'timed_out',
      pendingOperationIds: [pending.id],
    });
    expect(completed.timedOut).toBe(false);
    expect(pending.timedOut).toBe(true);
    expect(pending.cancellationRequested).toBe(true);
    lifecycle.settle(pending, success(pending.id));
    expect(lifecycle.get(pending.id).result).toMatchObject({
      kind: 'succeeded',
    });
  });

  it('publishes completed state before bounded terminal compaction', () => {
    const terminalPublications: string[] = [];
    const lifecycle = createLifecycle({
      publish: (summary) => {
        if (summary.phase !== 'terminal') return;
        const record = lifecycle.get(operationId(summary.label));
        expect(record.result?.kind).toBe(summary.resultKind);
        terminalPublications.push(summary.label);
      },
      terminalRetention: 2,
    });
    const live = activeRecord('1', '1');
    const unknown = activeRecord('2', '2');
    expect(lifecycle.activate(live)).toBe('running');
    expect(lifecycle.addTerminal(unknown)).toBe(true);
    lifecycle.settle(unknown, unknownOutcome(unknown.id));

    const known = ['3', '4', '5'].map((digit) => activeRecord(digit, digit));
    for (const record of known) {
      expect(lifecycle.addTerminal(record)).toBe(true);
      lifecycle.settle(record, success(record.id));
    }

    expect(terminalPublications).toEqual(['2', '3', '4', '5']);
    expect(() => lifecycle.get(known[0]!.id)).toThrow('not retained');
    expect(lifecycle.get(known[2]!.id)).toBe(known[2]);
    expect(lifecycle.get(live.id)).toBe(live);
    expect(lifecycle.get(unknown.id)).toBe(unknown);

    const zeroPublications: string[] = [];
    const zero = createLifecycle({
      publish: ({ label }) => zeroPublications.push(label),
      terminalRetention: 0,
    });
    const evicted = activeRecord('6', '6');
    expect(zero.addTerminal(evicted)).toBe(true);
    zero.settle(evicted, success(evicted.id));
    expect(zeroPublications).toEqual(['6']);
    expect(() => zero.get(evicted.id)).toThrow('not retained');
  });

  it('rejects foreign records before changing adapter-owned state', () => {
    const lifecycle = createLifecycle();
    const owned = activeRecord('1', 'owned');
    expect(lifecycle.activate(owned)).toBe('running');
    const foreign = { ...owned, label: 'foreign' };

    expect(() => lifecycle.settle(foreign, success(foreign.id))).toThrow(
      'not registered',
    );
    expect(owned.result).toBeUndefined();
  });
});

function createLifecycle(
  options: {
    readonly closeTimeoutMilliseconds?: number;
    readonly publish?: (summary: TestSummary) => void;
    readonly terminalRetention?: number;
    readonly timeoutScheduler?: ReturnType<
      typeof controlledTimeout
    >['scheduler'];
  } = {},
) {
  return createCoordinatorLifecycle<TestRecord, TestSummary>({
    ...options,
    summarize: (record) => ({
      cancellationRequested: record.cancellationRequested,
      label: record.label,
      phase: record.phase,
      resultKind: record.result?.kind ?? null,
      timedOut: record.timedOut,
    }),
  });
}

function activeRecord(digit: string, label: string): TestRecord {
  const done = deferred<OperationResult>();
  return {
    abort: new AbortController(),
    cancellationRequested: false,
    id: operationId(digit),
    label,
    lease: true,
    phase: 'accepted',
    settle: done.resolve,
    settled: done.promise,
    timedOut: false,
  };
}

function success(operationId: OperationId): OperationResult {
  return {
    kind: 'succeeded',
    operationId,
    result: operationSuccessResultSchema.parse({ kind: 'no_change' }),
  };
}

function rejected(operationId: OperationId): OperationResult {
  return {
    kind: 'rejected',
    operationId,
    code: 'unsupported_state',
    message: 'The Repository Session is closing.',
  };
}

function unknownOutcome(operationId: OperationId): OperationResult {
  return {
    kind: 'unknown_outcome',
    operationId,
    code: 'reconciliation_incomplete',
    message: 'Fresh evidence is incomplete.',
    recoveryAvailable: true,
  };
}

function operationId(digit: string) {
  return operationIdSchema.parse(`operation_${digit.repeat(32)}`);
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
