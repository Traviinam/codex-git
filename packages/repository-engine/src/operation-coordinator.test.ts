import { describe, expect, it } from 'vitest';

import {
  operationIdSchema,
  operationSuccessResultSchema,
  remoteIdSchema,
  worktreeGenerationSchema,
} from '@codex-git/protocol';

import {
  createOperationCoordinator,
  type CoordinatedOperation,
  type OperationAdmission,
  type ReconciledOperationResult,
} from './operation-coordinator.js';

const generation = (digit: string) =>
  worktreeGenerationSchema.parse(`generation_${digit.repeat(32)}`);
const remote = (digit: string) =>
  remoteIdSchema.parse(`remote_${digit.repeat(32)}`);
const succeeded = {
  kind: 'succeeded',
  result: operationSuccessResultSchema.parse({ kind: 'no_change' }),
} as const;

describe('operation coordinator admission', () => {
  it('derives Local lanes and returns reconciled Busy without queueing', async () => {
    const firstExecution = deferred<string>();
    const otherExecution = deferred<string>();
    const busyReconciliation = deferred<void>();
    const coordinator = createOperationCoordinator();
    const firstGeneration = generation('1');
    let blockedExecutions = 0;

    const first = await coordinator.dispatch(
      stageOperation(firstGeneration, firstExecution.promise),
    );
    const other = await coordinator.dispatch(
      stageOperation(generation('2'), otherExecution.promise),
    );
    const busyPromise = coordinator.dispatch({
      ...commitOperation(firstGeneration, 'refs/heads/topic', 'blocked'),
      execute: async () => {
        blockedExecutions += 1;
        return 'must not run';
      },
      reconcileBusy: () => busyReconciliation.promise,
    });

    await Promise.resolve();
    expect(blockedExecutions).toBe(0);
    busyReconciliation.resolve();
    const busy = await busyPromise;
    expect(busy).toMatchObject({
      kind: 'rejected',
      result: { kind: 'rejected', code: 'busy' },
      conflicts: [{ category: 'stage' }],
    });
    expect(blockedExecutions).toBe(0);
    expect(first.kind).toBe('accepted');
    expect(other.kind).toBe('accepted');
    const firstId = acceptedId(first);
    const otherId = acceptedId(other);
    expect(operationIdSchema.safeParse(firstId).success).toBe(true);
    expect(firstId).not.toBe(otherId);

    firstExecution.resolve('first evidence');
    otherExecution.resolve('other evidence');
    await Promise.all([
      coordinator.recover(firstId),
      coordinator.recover(otherId),
    ]);
  });

  it('rejects caller-selected coordination and incomplete kind targets at runtime', async () => {
    const coordinator = createOperationCoordinator();
    const bypass = {
      ...commitOperation(generation('3'), 'refs/heads/topic', 'unused'),
      lane: { kind: 'remote' },
    } as unknown as CoordinatedOperation<string>;
    const incomplete = {
      ...commitOperation(generation('3'), null, 'unused'),
      attachedRef: undefined,
    } as unknown as CoordinatedOperation<string>;

    await expect(coordinator.dispatch(bypass)).rejects.toThrow(
      'Coordination is derived from the operation kind',
    );
    await expect(coordinator.dispatch(incomplete)).rejects.toThrow(
      'attachedRef',
    );
  });

  it('derives Repository lanes and mandatory cross-lane claims', async () => {
    const commitExecution = deferred<string>();
    const branchExecution = deferred<string>();
    const fetchExecution = deferred<string>();
    const coordinator = createOperationCoordinator();
    const commitGeneration = generation('4');
    const branchGeneration = generation('5');

    const commit = await coordinator.dispatch(
      commitOperation(
        commitGeneration,
        'refs/heads/topic',
        commitExecution.promise,
      ),
    );
    const sameWorktree = await coordinator.dispatch(
      branchOperation(
        commitGeneration,
        localTarget('refs/heads/other'),
        'blocked',
      ),
    );
    const sameRef = await coordinator.dispatch(
      branchOperation(
        branchGeneration,
        localTarget('refs/heads/topic'),
        'blocked',
      ),
    );
    expect([sameWorktree, sameRef]).toEqual([
      expect.objectContaining({
        kind: 'rejected',
        result: expect.objectContaining({ code: 'busy' }),
      }),
      expect.objectContaining({
        kind: 'rejected',
        result: expect.objectContaining({ code: 'busy' }),
      }),
    ]);

    const branch = await coordinator.dispatch(
      branchOperation(
        branchGeneration,
        localTarget('refs/heads/shared'),
        branchExecution.promise,
      ),
    );
    const fetch = await coordinator.dispatch(
      fetchOperation([remote('1')], fetchExecution.promise),
    );
    expect(branch.kind).toBe('accepted');
    expect(fetch.kind).toBe('accepted');
    fetchExecution.resolve('fetch evidence');
    await coordinator.recover(acceptedId(fetch));

    const pull = await coordinator.dispatch(
      pullOperation(
        generation('6'),
        'refs/heads/shared',
        'refs/remotes/origin/shared',
      ),
    );
    expect(pull).toMatchObject({
      kind: 'rejected',
      result: { code: 'busy' },
      conflicts: [{ category: 'branch_switch' }],
    });

    commitExecution.resolve('commit evidence');
    branchExecution.resolve('branch evidence');
    await Promise.all([
      coordinator.recover(acceptedId(commit)),
      coordinator.recover(acceptedId(branch)),
    ]);
  });

  it('makes a Remote-tracking Branch conflict with Fetch for its exact Remote', async () => {
    const branchExecution = deferred<string>();
    const coordinator = createOperationCoordinator();
    const remoteId = remote('2');
    const branch = await coordinator.dispatch(
      branchOperation(
        generation('7'),
        {
          kind: 'remote_tracking',
          fullName: 'refs/remotes/origin/topic',
          remoteId,
        },
        branchExecution.promise,
      ),
    );

    const fetch = await coordinator.dispatch(
      fetchOperation([remoteId], 'blocked'),
    );

    expect(fetch).toMatchObject({
      kind: 'rejected',
      result: { code: 'busy' },
      conflicts: [{ category: 'branch_switch' }],
    });
    branchExecution.resolve('branch evidence');
    await coordinator.recover(acceptedId(branch));
  });

  it('deduplicates automatic reconciliation of an Unknown conflicting lease', async () => {
    const recovered = deferred<ReconciledOperationResult>();
    const coordinator = createOperationCoordinator();
    const worktreeGeneration = generation('8');
    let reconciliations = 0;
    const first = await coordinator.dispatch({
      ...commitOperation(worktreeGeneration, 'refs/heads/topic', 'attempted'),
      reconcile: async () => {
        reconciliations += 1;
        return reconciliations === 1
          ? unknownOutcome('Initial evidence is incomplete.')
          : recovered.promise;
      },
    });
    await expect(coordinator.recover(acceptedId(first))).resolves.toMatchObject(
      {
        kind: 'unknown_outcome',
      },
    );

    const next = coordinator.dispatch(
      stageOperation(worktreeGeneration, 'next'),
    );
    const concurrent = coordinator.dispatch(
      stageOperation(worktreeGeneration, 'concurrent'),
    );
    await Promise.resolve();
    expect(reconciliations).toBe(2);
    recovered.resolve(succeeded);

    const admissions = await Promise.all([next, concurrent]);
    expect(admissions.filter(({ kind }) => kind === 'accepted')).toHaveLength(
      1,
    );
    expect(admissions.filter(({ kind }) => kind === 'rejected')).toHaveLength(
      1,
    );
    const accepted = admissions.find(({ kind }) => kind === 'accepted');
    if (accepted !== undefined) await coordinator.recover(acceptedId(accepted));
  });

  it('derives the terminal result from reconciliation rather than process state', async () => {
    const coordinator = createOperationCoordinator();
    const admission = await coordinator.dispatch({
      ...stageOperation(generation('9'), 'exit zero'),
      reconcile: async () => ({
        kind: 'failed_known',
        code: 'process_failed',
        message: 'Fresh evidence proves the requested effect is absent.',
      }),
    });

    await expect(
      coordinator.recover(acceptedId(admission)),
    ).resolves.toMatchObject({
      kind: 'failed_known',
      code: 'process_failed',
    });
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
  target: Extract<
    CoordinatedOperation<string>,
    { kind: 'branch_switch' }
  >['target'],
  execution: Promise<string> | string,
): CoordinatedOperation<string> {
  return {
    ...hooks(execution),
    kind: 'branch_switch',
    worktreeGeneration,
    currentRef: null,
    target,
  };
}

function fetchOperation(
  remoteIds: readonly [
    ReturnType<typeof remote>,
    ...ReturnType<typeof remote>[],
  ],
  execution: Promise<string> | string,
): CoordinatedOperation<string> {
  return { ...hooks(execution), kind: 'fetch', remoteIds };
}

function pullOperation(
  worktreeGeneration: ReturnType<typeof generation>,
  localBranchRef: string,
  upstreamRef: string,
): CoordinatedOperation<string> {
  return {
    ...hooks('blocked'),
    kind: 'pull',
    worktreeGeneration,
    localBranchRef,
    upstreamRef,
    remoteId: remote('3'),
  };
}

function hooks(execution: Promise<string> | string) {
  return {
    reconcileBusy: async () => undefined,
    execute: async () => execution,
    reconcile: async (): Promise<ReconciledOperationResult> => succeeded,
  };
}

function localTarget(fullName: string) {
  return { kind: 'local', fullName } as const;
}

function acceptedId(admission: OperationAdmission) {
  if (admission.kind !== 'accepted') throw new Error('Expected accepted');
  return admission.operation.operationId;
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
