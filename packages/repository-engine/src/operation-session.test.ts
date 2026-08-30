import { describe, expect, it } from 'vitest';

import {
  operationSuccessResultSchema,
  worktreeGenerationSchema,
} from '@codex-git/protocol';

import type {
  CoordinatedOperation,
  OperationReconciliationContext,
  ReconciledOperationResult,
} from './operation-coordinator.js';
import {
  createOperationSession,
  type OperationSessionAdmission,
  type OperationSessionSummary,
} from './operation-session.js';

const succeeded = {
  kind: 'succeeded',
  result: operationSuccessResultSchema.parse({ kind: 'no_change' }),
} as const;

describe('operation session', () => {
  it('publishes execution and reconciliation through one lifecycle seam', async () => {
    const execution = deferred<string>();
    const contexts: OperationReconciliationContext<string>[] = [];
    const published: OperationSessionSummary[] = [];
    const session = createOperationSession({
      publish: (summary) => published.push(summary),
    });

    const admission = await session.dispatch({
      ...stageOperation(generation('1'), execution.promise),
      reconcile: async (context) => {
        contexts.push(context);
        return succeeded;
      },
    });
    expect(admission.kind).toBe('accepted');
    expect(published.map(({ phase }) => phase)).toEqual([
      'accepted',
      'running',
    ]);

    execution.resolve('verified process evidence');
    const result = await session.recover(acceptedId(admission));

    expect(result).toMatchObject({ kind: 'succeeded' });
    expect(contexts).toEqual([
      {
        cancellationRequested: false,
        execution: {
          kind: 'returned',
          evidence: 'verified process evidence',
        },
        timedOut: false,
      },
    ]);
    expect(published.map(({ phase }) => phase)).toEqual([
      'accepted',
      'running',
      'reconciling',
      'terminal',
    ]);
    expect(published.map(({ retryAllowed }) => retryAllowed)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('preserves no-queue admission across canonical lanes and claims', async () => {
    const firstExecution = deferred<string>();
    const independentExecution = deferred<string>();
    const busyPublication = deferred<void>();
    const session = createOperationSession();
    let blockedExecutions = 0;

    const first = await session.dispatch(
      commitOperation(
        generation('1'),
        'refs/heads/topic',
        firstExecution.promise,
      ),
    );
    const independent = await session.dispatch(
      stageOperation(generation('2'), independentExecution.promise),
    );
    const busyPromise = session.dispatch({
      ...branchOperation(generation('3'), 'refs/heads/topic', 'must not run'),
      execute: async () => {
        blockedExecutions += 1;
        return 'must not run';
      },
      reconcileBusy: () => busyPublication.promise,
    });

    let busyCompleted = false;
    void busyPromise.then(() => {
      busyCompleted = true;
    });
    await Promise.resolve();
    expect(busyCompleted).toBe(false);
    expect(blockedExecutions).toBe(0);
    busyPublication.resolve();

    await expect(busyPromise).resolves.toMatchObject({
      kind: 'rejected',
      result: { kind: 'rejected', code: 'busy' },
      conflicts: [{ category: 'commit' }],
    });
    expect(blockedExecutions).toBe(0);
    expect(first.kind).toBe('accepted');
    expect(independent.kind).toBe('accepted');

    firstExecution.resolve('first evidence');
    independentExecution.resolve('independent evidence');
    await Promise.all([
      session.recover(acceptedId(first)),
      session.recover(acceptedId(independent)),
    ]);
  });

  it('keeps Unknown leases while starting deduplicated recovery in the background', async () => {
    const recovery = deferred<ReconciledOperationResult>();
    const worktreeGeneration = generation('4');
    const session = createOperationSession();
    let blockedExecutions = 0;
    let reconciliations = 0;
    const first = await session.dispatch({
      ...stageOperation(worktreeGeneration, 'initial evidence'),
      reconcile: async () => {
        reconciliations += 1;
        return reconciliations === 1
          ? unknownOutcome('Fresh evidence is incomplete.')
          : recovery.promise;
      },
    });
    const firstId = acceptedId(first);

    await expect(session.recover(firstId)).resolves.toMatchObject({
      kind: 'unknown_outcome',
    });
    const busy = await session.dispatch({
      ...stageOperation(worktreeGeneration, 'must not run'),
      execute: async () => {
        blockedExecutions += 1;
        return 'must not run';
      },
    });

    expect(busy).toMatchObject({
      kind: 'rejected',
      result: { code: 'busy' },
    });
    expect(blockedExecutions).toBe(0);
    await Promise.resolve();
    expect(reconciliations).toBe(2);
    const recovering = session.recover(firstId);
    expect(session.recover(firstId)).toBe(recovering);

    recovery.resolve(succeeded);
    await expect(recovering).resolves.toMatchObject({ kind: 'succeeded' });
    const retry = await session.dispatch(
      stageOperation(worktreeGeneration, 'retry evidence'),
    );
    expect(retry.kind).toBe('accepted');
    await session.recover(acceptedId(retry));
  });

  it('cancels by intent and reconciles before enabling retry', async () => {
    const contexts: OperationReconciliationContext<string>[] = [];
    const published: OperationSessionSummary[] = [];
    const session = createOperationSession({
      publish: (summary) => published.push(summary),
    });
    let executionSignal: AbortSignal | undefined;
    const admission = await session.dispatch({
      ...stageOperation(generation('5'), 'unused'),
      execute: ({ signal }) => {
        executionSignal = signal;
        return new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => resolve('interrupted'), {
            once: true,
          });
        });
      },
      reconcile: async (context) => {
        contexts.push(context);
        return {
          kind: 'failed_known',
          code: 'process_failed',
          message: 'Cancellation was reconciled from fresh state.',
        };
      },
    });
    const operationId = acceptedId(admission);

    const cancellation = session.cancel(operationId);
    expect(session.cancel(operationId)).toBe(cancellation);
    expect(executionSignal?.aborted).toBe(true);
    expect(published.at(-1)).toMatchObject({
      cancellationRequested: true,
      phase: 'running',
      retryAllowed: false,
    });

    await expect(cancellation).resolves.toMatchObject({
      kind: 'failed_known',
      code: 'process_failed',
    });
    expect(contexts).toEqual([
      {
        cancellationRequested: true,
        execution: { kind: 'returned', evidence: 'interrupted' },
        timedOut: false,
      },
    ]);
    expect(published.at(-1)).toMatchObject({
      cancellationRequested: true,
      phase: 'terminal',
      retryAllowed: true,
    });
  });

  it('drains on close despite publication failure and reentrancy', async () => {
    let reentrantClose:
      | ReturnType<ReturnType<typeof createOperationSession>['close']>
      | undefined;
    const session = createOperationSession({
      publish: (summary) => {
        if (summary.cancellationRequested && reentrantClose === undefined) {
          reentrantClose = session.close();
          throw new Error('Observer failure');
        }
      },
    });
    let lateExecutions = 0;
    const admission = await session.dispatch({
      ...stageOperation(generation('6'), 'unused'),
      execute: ({ signal }) =>
        new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => resolve('interrupted'), {
            once: true,
          });
        }),
    });

    const close = session.close();
    expect(reentrantClose).toBe(close);
    await expect(close).resolves.toEqual({ kind: 'drained' });
    await expect(session.recover(acceptedId(admission))).resolves.toMatchObject(
      { kind: 'succeeded' },
    );

    const late = await session.dispatch({
      ...stageOperation(generation('7'), 'late'),
      execute: async () => {
        lateExecutions += 1;
        return 'late';
      },
    });
    expect(late).toEqual({ kind: 'closed' });
    expect(lateExecutions).toBe(0);
  });

  it('settles an activation interrupted by reentrant close without executing', async () => {
    const timeout = controlledTimeout();
    const published: OperationSessionSummary[] = [];
    let closeFromObserver:
      | ReturnType<ReturnType<typeof createOperationSession>['close']>
      | undefined;
    const session = createOperationSession({
      closeTimeoutMilliseconds: 250,
      publish: (summary) => {
        published.push(summary);
        if (summary.phase === 'accepted' && closeFromObserver === undefined) {
          closeFromObserver = session.close();
        }
      },
      timeoutScheduler: timeout.scheduler,
    });
    let executions = 0;

    const admission = await session.dispatch({
      ...stageOperation(generation('8'), 'must not run'),
      execute: async () => {
        executions += 1;
        return 'must not run';
      },
    });
    expect(admission).toEqual({ kind: 'closed' });
    expect(executions).toBe(0);
    let closeResult: Awaited<NonNullable<typeof closeFromObserver>> | undefined;
    void closeFromObserver?.then((result) => {
      closeResult = result;
    });
    await until(() => closeResult !== undefined);

    expect(closeResult).toEqual({ kind: 'drained' });
    expect(timeout.cancellations).toBe(1);
    timeout.trigger();
    expect(published.at(-1)).toMatchObject({
      cancellationRequested: true,
      phase: 'terminal',
      retryAllowed: true,
    });
  });

  it('reconciles late execution with timeout intent without late publication', async () => {
    const timeout = controlledTimeout();
    const execution = deferred<string>();
    const reconciled = deferred<void>();
    const contexts: OperationReconciliationContext<string>[] = [];
    const published: OperationSessionSummary[] = [];
    const session = createOperationSession({
      closeTimeoutMilliseconds: 250,
      publish: (summary) => published.push(summary),
      timeoutScheduler: timeout.scheduler,
    });
    const admission = await session.dispatch({
      ...stageOperation(generation('9'), execution.promise),
      reconcile: async (context) => {
        contexts.push(context);
        reconciled.resolve();
        return succeeded;
      },
    });
    const operationId = acceptedId(admission);

    const close = session.close();
    timeout.trigger();
    await expect(close).resolves.toEqual({
      kind: 'timed_out',
      pendingOperationIds: [operationId],
    });
    expect(published.at(-1)).toMatchObject({
      cancellationRequested: true,
      phase: 'running',
      retryAllowed: false,
      timedOut: true,
    });
    const publicationsAtClose = published.length;

    execution.resolve('late evidence');
    await reconciled.promise;
    await expect(session.recover(operationId)).resolves.toMatchObject({
      kind: 'succeeded',
    });
    expect(contexts).toEqual([
      {
        cancellationRequested: true,
        execution: { kind: 'returned', evidence: 'late evidence' },
        timedOut: true,
      },
    ]);
    expect(published).toHaveLength(publicationsAtClose);
  });
});

function stageOperation(
  worktreeGeneration: ReturnType<typeof generation>,
  execution: Promise<string> | string,
): CoordinatedOperation<string> {
  return { ...hooks(execution), kind: 'stage', worktreeGeneration };
}

function commitOperation(
  worktreeGeneration: ReturnType<typeof generation>,
  attachedRef: string | null,
  execution: Promise<string> | string,
): CoordinatedOperation<string> {
  return {
    ...hooks(execution),
    kind: 'commit',
    worktreeGeneration,
    attachedRef,
  };
}

function branchOperation(
  worktreeGeneration: ReturnType<typeof generation>,
  targetRef: string,
  execution: Promise<string> | string,
): CoordinatedOperation<string> {
  return {
    ...hooks(execution),
    kind: 'branch_switch',
    worktreeGeneration,
    currentRef: null,
    target: { kind: 'local', fullName: targetRef },
  };
}

function hooks(execution: Promise<string> | string) {
  return {
    reconcileBusy: async () => undefined,
    execute: async () => execution,
    reconcile: async (): Promise<ReconciledOperationResult> => succeeded,
  };
}

function acceptedId(admission: OperationSessionAdmission) {
  if (admission.kind !== 'accepted') throw new Error('Expected accepted');
  return admission.operation.operationId;
}

function generation(digit: string) {
  return worktreeGenerationSchema.parse(`generation_${digit.repeat(32)}`);
}

function unknownOutcome(message: string): ReconciledOperationResult {
  return {
    kind: 'unknown_outcome',
    code: 'reconciliation_incomplete',
    message,
    recoveryAvailable: true,
  };
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
  return {
    get cancellations() {
      return cancellations;
    },
    scheduler: {
      schedule(_milliseconds: number, onTimeout: () => void) {
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

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition was not reached.');
}
