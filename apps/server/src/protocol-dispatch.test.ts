import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  branchSearchResultSchema,
  commitDraftSchema,
  PROTOCOL_VERSION_HEADER,
  diffResultSchema,
  operationReceiptSchema,
  operationResultSchema,
  repositorySnapshotSchema,
} from '@codex-git/protocol';

import { startLoopbackServer, type LoopbackServer } from './server.js';

const servers: LoopbackServer[] = [];
const headers = {
  origin: 'null',
  [PROTOCOL_VERSION_HEADER]: '1',
} as const;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('protocol HTTP dispatch', () => {
  it('routes snapshots through an installed handler without advertising absent handlers', async () => {
    const snapshot = repositorySnapshotSchema.parse({
      repositoryId: 'repository_0123456789abcdef0123456789abcdef',
      repositoryRevision: 4,
      topologyRevision: 2,
      refsRevision: 3,
      refresh: { kind: 'current' },
      worktrees: [],
      remotes: [],
      operations: [],
    });
    const handleSnapshot = vi.fn(() => snapshot);
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: { snapshot: handleSnapshot },
    });
    servers.push(server);

    const [sessionResponse, snapshotResponse] = await Promise.all([
      fetch(server.sessionUrl, { headers }),
      fetch(endpointUrl(server, 'snapshot'), { headers }),
    ]);

    expect({
      capabilities: (
        (await sessionResponse.json()) as {
          capabilities: Record<string, boolean>;
        }
      ).capabilities,
      snapshot: await snapshotResponse.json(),
      snapshotStatus: snapshotResponse.status,
    }).toEqual({
      capabilities: {
        branchSearch: false,
        commands: false,
        commitDrafts: false,
        diff: false,
        events: true,
        nativeActions: false,
        operationRecovery: false,
      },
      snapshot,
      snapshotStatus: 200,
    });
    expect(handleSnapshot).toHaveBeenCalledOnce();
  });

  it('rejects malformed diff requests before calling the installed handler', async () => {
    const handleDiff = vi.fn(() =>
      diffResultSchema.parse({
        kind: 'binary' as const,
        fileId: 'file_0123456789abcdef0123456789abcdef',
        baseline: 'index_to_working_tree' as const,
        byteCount: 42,
      }),
    );
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: { diff: handleDiff },
    });
    servers.push(server);

    const response = await fetch(endpointUrl(server, 'diff'), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        fileId: 'file_0123456789abcdef0123456789abcdef',
        path: '/Users/example/repository/private.txt',
      }),
    });
    const session = (await (
      await fetch(server.sessionUrl, { headers })
    ).json()) as { capabilities: { diff: boolean } };

    expect({
      capability: session.capabilities.diff,
      response: await response.json(),
      status: response.status,
    }).toEqual({
      capability: true,
      response: {
        error: {
          code: 'invalid_payload',
          details: expect.objectContaining({ issues: expect.any(Array) }),
          message: 'The protocol payload is invalid.',
        },
      },
      status: 400,
    });
    expect(handleDiff).not.toHaveBeenCalled();
  });

  it('does not serialize a handler response that fails runtime validation', async () => {
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: {
        diff: async () =>
          ({
            kind: 'text',
            fileId: 'file_0123456789abcdef0123456789abcdef',
            baseline: 'head_to_index',
            content: 'token=fixture-handler-secret',
            lineCount: 20_001,
          }) as never,
      },
    });
    servers.push(server);

    const response = await fetch(endpointUrl(server, 'diff'), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        fileId: 'file_0123456789abcdef0123456789abcdef',
      }),
    });
    const body = JSON.stringify(await response.json());

    expect({ body: JSON.parse(body), status: response.status }).toEqual({
      body: {
        error: {
          code: 'internal_error',
          message: 'The protocol handler returned an invalid response.',
        },
      },
      status: 500,
    });
    expect(body).not.toContain('fixture-handler-secret');
  });

  it('rejects a valid diff response for a different opaque File ID', async () => {
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: {
        diff: async () =>
          diffResultSchema.parse({
            kind: 'binary',
            fileId: 'file_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            baseline: 'head_to_index',
            byteCount: 24,
          }),
      },
    });
    servers.push(server);

    const response = await postJson(server, 'diff', {
      fileId: 'file_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    expect({ body: await response.json(), status: response.status }).toEqual({
      body: {
        error: {
          code: 'internal_error',
          message: 'The protocol handler returned an invalid response.',
        },
      },
      status: 500,
    });
  });

  it('dispatches branch search with validated opaque targets', async () => {
    const result = branchSearchResultSchema.parse({
      refsRevision: 7,
      candidates: [
        {
          refId: 'ref_0123456789abcdef0123456789abcdef',
          kind: 'local',
          displayName: 'feature/protocol',
          occupiedBy: null,
        },
      ],
    });
    const searchBranches = vi.fn(() => result);
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: { branchSearch: searchBranches },
    });
    servers.push(server);

    const response = await fetch(endpointUrl(server, 'branches'), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        worktreeId: 'worktree_0123456789abcdef0123456789abcdef',
        query: 'feature',
      }),
    });
    const session = (await (
      await fetch(server.sessionUrl, { headers })
    ).json()) as { capabilities: { branchSearch: boolean } };

    expect({
      capability: session.capabilities.branchSearch,
      result: await response.json(),
      status: response.status,
    }).toEqual({ capability: true, result, status: 200 });
    expect(searchBranches).toHaveBeenCalledWith({
      worktreeId: 'worktree_0123456789abcdef0123456789abcdef',
      query: 'feature',
    });
  });

  it('dispatches a validated Commit Draft update through the installed handler', async () => {
    const draft = commitDraftSchema.parse({
      worktreeId: 'worktree_0123456789abcdef0123456789abcdef',
      revision: 9,
      text: 'Describe the protocol change',
    });
    const updateDraft = vi.fn(() => draft);
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: { commitDrafts: updateDraft },
    });
    servers.push(server);
    const request = {
      worktreeId: 'worktree_0123456789abcdef0123456789abcdef',
      expectedRevision: 8,
      update: { kind: 'set', text: 'Describe the protocol change' },
    } as const;

    const response = await fetch(endpointUrl(server, 'draft'), {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const session = (await (
      await fetch(server.sessionUrl, { headers })
    ).json()) as { capabilities: { commitDrafts: boolean } };

    expect({
      capability: session.capabilities.commitDrafts,
      result: await response.json(),
      status: response.status,
    }).toEqual({ capability: true, result: draft, status: 200 });
    expect(updateDraft).toHaveBeenCalledWith(request);
  });

  it('rejects a Commit Draft response for a different opaque Worktree ID', async () => {
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: {
        commitDrafts: async () =>
          commitDraftSchema.parse({
            worktreeId: 'worktree_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            revision: 3,
            text: 'Wrong Worktree draft',
          }),
      },
    });
    servers.push(server);

    const response = await fetch(endpointUrl(server, 'draft'), {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        worktreeId: 'worktree_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        expectedRevision: 2,
        update: { kind: 'set', text: 'Expected Worktree draft' },
      }),
    });

    expect({ body: await response.json(), status: response.status }).toEqual({
      body: {
        error: {
          code: 'internal_error',
          message: 'The protocol handler returned an invalid response.',
        },
      },
      status: 500,
    });
  });

  it('dispatches one validated Product Command and returns its receipt', async () => {
    const request = {
      clientCommandId: 'command_0123456789abcdef0123456789abcdef',
      command: {
        kind: 'refresh',
        repositoryId: 'repository_0123456789abcdef0123456789abcdef',
      },
    } as const;
    const receipt = operationReceiptSchema.parse({
      operationId: 'operation_0123456789abcdef0123456789abcdef',
      clientCommandId: request.clientCommandId,
      disposition: 'accepted',
    });
    const dispatchCommand = vi.fn(() => receipt);
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: { commands: dispatchCommand },
    });
    servers.push(server);

    const response = await postJson(server, 'commands', request);
    const session = (await (
      await fetch(server.sessionUrl, { headers })
    ).json()) as { capabilities: { commands: boolean } };

    expect({
      capability: session.capabilities.commands,
      receipt: await response.json(),
      status: response.status,
    }).toEqual({ capability: true, receipt, status: 200 });
    expect(dispatchCommand).toHaveBeenCalledWith(request);
  });

  it('returns one operation for concurrent exact command retries', async () => {
    const request = {
      clientCommandId: 'command_11111111111111111111111111111111',
      command: {
        kind: 'refresh',
        repositoryId: 'repository_0123456789abcdef0123456789abcdef',
      },
    } as const;
    const receipt = operationReceiptSchema.parse({
      operationId: 'operation_11111111111111111111111111111111',
      clientCommandId: request.clientCommandId,
      disposition: 'accepted',
    });
    const dispatchCommand = vi.fn(async () => receipt);
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: { commands: dispatchCommand },
    });
    servers.push(server);

    const responses = await Promise.all([
      postJson(server, 'commands', request),
      postJson(server, 'commands', {
        clientCommandId: request.clientCommandId,
        command: {
          repositoryId: request.command.repositoryId,
          kind: request.command.kind,
        },
      }),
    ]);
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );

    expect(bodies).toEqual([receipt, { ...receipt, disposition: 'duplicate' }]);
    expect(dispatchCommand).toHaveBeenCalledOnce();
  });

  it('rejects a command ID reused for a different validated intent', async () => {
    const clientCommandId = 'command_22222222222222222222222222222222';
    const receipt = operationReceiptSchema.parse({
      operationId: 'operation_22222222222222222222222222222222',
      clientCommandId,
      disposition: 'accepted',
    });
    const dispatchCommand = vi.fn(() => receipt);
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: { commands: dispatchCommand },
    });
    servers.push(server);

    await postJson(server, 'commands', {
      clientCommandId,
      command: {
        kind: 'refresh',
        repositoryId: 'repository_11111111111111111111111111111111',
      },
    });
    const collision = await postJson(server, 'commands', {
      clientCommandId,
      command: {
        kind: 'refresh',
        repositoryId: 'repository_22222222222222222222222222222222',
      },
    });

    expect({ body: await collision.json(), status: collision.status }).toEqual({
      body: {
        error: {
          code: 'command_id_collision',
          message:
            'The client command ID was already used for another command.',
        },
      },
      status: 409,
    });
    expect(dispatchCommand).toHaveBeenCalledOnce();
  });

  it('records a command before a synchronously failing handler can be retried', async () => {
    const request = {
      clientCommandId: 'command_77777777777777777777777777777777',
      command: {
        kind: 'refresh',
        repositoryId: 'repository_77777777777777777777777777777777',
      },
    } as const;
    const dispatchCommand = vi.fn(() => {
      throw new Error('fixture handler failure');
    });
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: { commands: dispatchCommand },
    });
    servers.push(server);

    const first = await postJson(server, 'commands', request);
    const retry = await postJson(server, 'commands', request);

    expect({
      allowOrigin: first.headers.get('access-control-allow-origin'),
      first: await first.json(),
      firstStatus: first.status,
      retry: await retry.json(),
      retryStatus: retry.status,
    }).toEqual({
      allowOrigin: 'null',
      first: {
        error: {
          code: 'internal_error',
          message: 'The protocol request could not be completed.',
        },
      },
      firstStatus: 500,
      retry: {
        error: {
          code: 'duplicate_command',
          message: 'The duplicate command cannot be replayed safely.',
        },
      },
      retryStatus: 409,
    });
    expect(dispatchCommand).toHaveBeenCalledOnce();
  });

  it('routes operation recovery by opaque Operation ID', async () => {
    const operationId = 'operation_33333333333333333333333333333333';
    const result = operationResultSchema.parse({
      kind: 'unknown_outcome',
      operationId,
      code: 'reconciliation_incomplete',
      message: 'Repository state is still being reconciled.',
      recoveryAvailable: true,
    });
    const recoverOperation = vi.fn(() => result);
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: { operationRecovery: recoverOperation },
    });
    servers.push(server);

    const response = await postJson(server, 'operations', { operationId });
    const session = (await (
      await fetch(server.sessionUrl, { headers })
    ).json()) as { capabilities: { operationRecovery: boolean } };

    expect({
      capability: session.capabilities.operationRecovery,
      result: await response.json(),
      status: response.status,
    }).toEqual({ capability: true, result, status: 200 });
    expect(recoverOperation).toHaveBeenCalledWith(operationId);
  });

  it('rejects a recovery result for a different Operation ID', async () => {
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: {
        operationRecovery: async () =>
          operationResultSchema.parse({
            kind: 'succeeded',
            operationId: 'operation_55555555555555555555555555555555',
            result: { kind: 'no_change' },
          }),
      },
    });
    servers.push(server);

    const response = await postJson(server, 'operations', {
      operationId: 'operation_44444444444444444444444444444444',
    });

    expect({ body: await response.json(), status: response.status }).toEqual({
      body: {
        error: {
          code: 'internal_error',
          message: 'The protocol handler returned an invalid response.',
        },
      },
      status: 500,
    });
  });

  it('rejects a native action outside the server-issued target allow-list', async () => {
    const targetId = 'native_66666666666666666666666666666666';
    const actionsForTarget = vi.fn((candidate: string) =>
      candidate === targetId ? (['copy_relative_path'] as const) : undefined,
    );
    const perform = vi.fn(() => ({ kind: 'performed' as const }));
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: { nativeActions: { actionsForTarget, perform } },
    });
    servers.push(server);

    const response = await postJson(server, 'native-actions', {
      kind: 'open_default_app',
      targetId,
    });
    const unissued = await postJson(server, 'native-actions', {
      kind: 'copy_relative_path',
      targetId: 'native_99999999999999999999999999999999',
    });
    const session = (await (
      await fetch(server.sessionUrl, { headers })
    ).json()) as { capabilities: { nativeActions: boolean } };

    expect({
      capability: session.capabilities.nativeActions,
      result: await response.json(),
      status: response.status,
      unissued: await unissued.json(),
      unissuedStatus: unissued.status,
    }).toEqual({
      capability: true,
      result: {
        error: {
          code: 'stale_target',
          message: 'The native target is stale or does not allow this action.',
        },
      },
      status: 409,
      unissued: {
        error: {
          code: 'stale_target',
          message: 'The native target is stale or does not allow this action.',
        },
      },
      unissuedStatus: 409,
    });
    expect(actionsForTarget).toHaveBeenCalledTimes(2);
    expect(perform).not.toHaveBeenCalled();
  });

  it('performs an allow-listed native action against its exact opaque target', async () => {
    const targetId = 'native_88888888888888888888888888888888';
    const perform = vi.fn(() => ({
      kind: 'copy_text' as const,
      text: 'src/protocol-dispatch.ts',
    }));
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: {
        nativeActions: {
          actionsForTarget: () => ['copy_relative_path'],
          perform,
        },
      },
    });
    servers.push(server);
    const request = { kind: 'copy_relative_path', targetId } as const;

    const response = await postJson(server, 'native-actions', request);

    expect({ result: await response.json(), status: response.status }).toEqual({
      result: { kind: 'copy_text', text: 'src/protocol-dispatch.ts' },
      status: 200,
    });
    expect(perform).toHaveBeenCalledWith(request);
  });
});

function endpointUrl(server: LoopbackServer, endpoint: string): URL {
  const url = new URL(server.sessionUrl);
  url.pathname = url.pathname.replace(/\/session$/u, `/${endpoint}`);
  return url;
}

function postJson(
  server: LoopbackServer,
  endpoint: string,
  value: unknown,
): Promise<Response> {
  return fetch(endpointUrl(server, endpoint), {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}
