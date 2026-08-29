import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  branchSearchResultSchema,
  commitDraftSchema,
  PROTOCOL_LIMITS,
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
const staleTargetResponse = {
  error: {
    code: 'stale_target',
    message: 'The native target is stale or does not allow this action.',
  },
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('protocol HTTP dispatch', () => {
  it('routes snapshots with redacted diagnostics without advertising absent handlers', async () => {
    const snapshot = repositorySnapshotSchema.parse({
      repositoryId: 'repository_0123456789abcdef0123456789abcdef',
      repositoryRevision: 4,
      topologyRevision: 2,
      refsRevision: 3,
      refresh: {
        kind: 'stale',
        message: 'Authorization: Bearer fixture-snapshot-token',
      },
      worktrees: [
        {
          worktreeId: 'worktree_0123456789abcdef0123456789abcdef',
          worktreeRevision: 1,
          generation: 'generation_0123456789abcdef0123456789abcdef',
          freshness: {
            kind: 'failed',
            message:
              'remote=https://alice:fixture-password@example.com/repo.git',
          },
          head: { kind: 'initial' },
          indexTree: null,
          status: {
            kind: 'unavailable',
            reason: 'token=fixture-unavailable-secret',
          },
          changes: Array.from({ length: 2_000 }, (_, index) => ({
            baseline: 'index_to_working_tree',
            displayPath: 'x'.repeat(4_096),
            fileId: `file_${index.toString(16).padStart(32, '0')}`,
            kind: 'change',
            nativeTargets: [],
          })),
          nativeTargets: [],
        },
      ],
      remotes: ['a.co', 'a.co:1', '1.1.1.1', '[::1]'].map((host, index) => ({
        remoteId: `remote_${index.toString(16).padStart(32, '0')}`,
        displayName: host,
        host,
      })),
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

    const snapshotBody = await snapshotResponse.json();
    expect(await sessionResponse.json()).toMatchObject({
      capabilities: {
        branchSearch: false,
        commands: false,
        commitDrafts: false,
        diff: false,
        events: true,
        nativeActions: false,
        operationRecovery: false,
      },
    });
    expect(repositorySnapshotSchema.safeParse(snapshotBody).success).toBe(true);
    expect(snapshotResponse.status).toBe(200);
    expect(snapshotBody).toMatchObject({
      refresh: { message: 'Authorization: [REDACTED]' },
      worktrees: [
        {
          freshness: {
            message: 'remote=https://[REDACTED]@example.com/repo.git',
          },
          status: { reason: 'token=[REDACTED]' },
        },
      ],
    });
    expect(JSON.stringify(snapshotBody)).not.toMatch(
      /fixture-(?:snapshot-token|password|unavailable-secret)/u,
    );

    handleSnapshot.mockReturnValueOnce({
      ...snapshot,
      remotes: [
        { ...snapshot.remotes[0]!, host: 'https://a:fixture@example.com' },
      ],
    });
    const invalidHostResponse = await fetch(endpointUrl(server, 'snapshot'), {
      headers,
    });
    const invalidHostBody =
      await expectInvalidHandlerResponse(invalidHostResponse);
    expect(JSON.stringify(invalidHostBody)).not.toContain('a:fixture');
    expect(handleSnapshot).toHaveBeenCalledTimes(2);
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

  it('rejects malformed UTF-8 JSON bytes before calling a handler', async () => {
    const searchBranches = vi.fn(() =>
      branchSearchResultSchema.parse({ refsRevision: 1, candidates: [] }),
    );
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: { branchSearch: searchBranches },
    });
    servers.push(server);
    const prefix = new TextEncoder().encode(
      `{"worktreeId":"worktree_0123456789abcdef0123456789abcdef","query":"`,
    );
    const suffix = new TextEncoder().encode('"}');
    const body = Uint8Array.from([...prefix, 0xc3, 0x28, ...suffix]);

    const response = await fetch(endpointUrl(server, 'branches'), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    });

    expect({ body: await response.json(), status: response.status }).toEqual({
      body: {
        error: {
          code: 'invalid_payload',
          message: 'The protocol request body is not valid JSON.',
        },
      },
      status: 400,
    });
    expect(searchBranches).not.toHaveBeenCalled();
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
    const body = JSON.stringify(await expectInvalidHandlerResponse(response));
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

    await expectInvalidHandlerResponse(response);
  });

  it('returns a diff at the exact negotiated content limit', async () => {
    const fileId = 'file_cccccccccccccccccccccccccccccccc';
    const content = 'x'.repeat(PROTOCOL_LIMITS.diffOutputBytes);
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: {
        diff: () =>
          diffResultSchema.parse({
            kind: 'text',
            fileId,
            baseline: 'head_to_index',
            content,
            lineCount: 1,
          }),
      },
    });
    servers.push(server);

    const response = await postJson(server, 'diff', { fileId });
    const body = (await response.json()) as { content?: string };

    expect({
      contentBytes: body.content?.length,
      status: response.status,
    }).toEqual({
      contentBytes: PROTOCOL_LIMITS.diffOutputBytes,
      status: 200,
    });
  });

  it('dispatches branch search with validated opaque targets', async () => {
    const result = branchSearchResultSchema.parse({
      refsRevision: 7,
      candidates: Array.from({ length: 5_000 }, (_, index) => ({
        refId: `ref_${index.toString(16).padStart(32, '0')}`,
        kind: 'local' as const,
        displayName: 'x'.repeat(1_024),
        occupiedBy: null,
      })),
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

    expect(session.capabilities.branchSearch).toBe(true);
    expect(await response.json()).toEqual(result);
    expect(response.status).toBe(200);
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

    await expectInvalidHandlerResponse(response);
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
    const launchToken = 'ab'.repeat(32);
    const result = operationResultSchema.parse({
      kind: 'partial_success',
      operationId,
      message: `Recovery retained ${launchToken}`,
      effects: [
        { kind: 'succeeded', label: 'origin' },
        {
          kind: 'failed_known',
          label: 'backup',
          code: 'authentication',
          message: 'Authorization: Bearer fixture-operation-token',
        },
      ],
    });
    const recoverOperation = vi.fn(() => result);
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      randomBytes: (length) => new Uint8Array(length).fill(0xab),
      handlers: { operationRecovery: recoverOperation },
    });
    servers.push(server);

    const response = await postJson(server, 'operations', { operationId });
    const session = (await (
      await fetch(server.sessionUrl, { headers })
    ).json()) as { capabilities: { operationRecovery: boolean } };

    const responseBody = await response.json();
    expect({
      capability: session.capabilities.operationRecovery,
      resultIsValid: operationResultSchema.safeParse(responseBody).success,
      status: response.status,
    }).toEqual({ capability: true, resultIsValid: true, status: 200 });
    expect(responseBody).toMatchObject({
      message: 'Recovery retained [REDACTED]',
      effects: [
        { kind: 'succeeded' },
        { message: 'Authorization: [REDACTED]' },
      ],
    });
    expect(JSON.stringify(responseBody)).not.toContain(launchToken);
    expect(JSON.stringify(responseBody)).not.toContain(
      'fixture-operation-token',
    );
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

    await expectInvalidHandlerResponse(response);
  });

  it('rejects a fabricated native target that was not issued by the snapshot', async () => {
    const issuedTargetId = 'native_66666666666666666666666666666666';
    const perform = vi.fn(() => ({ kind: 'performed' as const }));
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: {
        snapshot: () => nativeSnapshot(issuedTargetId, ['copy_relative_path']),
        nativeActions: perform,
      },
    });
    servers.push(server);

    await fetch(endpointUrl(server, 'snapshot'), { headers });
    const response = await postJson(server, 'native-actions', {
      kind: 'copy_relative_path',
      targetId: 'native_99999999999999999999999999999999',
    });

    expect({ result: await response.json(), status: response.status }).toEqual({
      result: staleTargetResponse,
      status: 409,
    });
    expect(perform).not.toHaveBeenCalled();
  });

  it('rejects an action that was not issued for the native target', async () => {
    const targetId = 'native_77777777777777777777777777777777';
    let duplicate = false;
    const perform = vi.fn(() => ({ kind: 'performed' as const }));
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: {
        snapshot: () =>
          nativeSnapshot(targetId, ['copy_relative_path'], duplicate),
        nativeActions: perform,
      },
    });
    servers.push(server);

    await fetch(endpointUrl(server, 'snapshot'), { headers });
    const response = await postJson(server, 'native-actions', {
      kind: 'open_default_app',
      targetId,
    });

    expect({ result: await response.json(), status: response.status }).toEqual({
      result: staleTargetResponse,
      status: 409,
    });
    expect(perform).not.toHaveBeenCalled();

    duplicate = true;
    const duplicateResponse = await fetch(endpointUrl(server, 'snapshot'), {
      headers,
    });
    await expectInvalidHandlerResponse(duplicateResponse);
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
        snapshot: () => nativeSnapshot(targetId, ['copy_relative_path']),
        nativeActions: perform,
      },
    });
    servers.push(server);
    const request = { kind: 'copy_relative_path', targetId } as const;

    await fetch(endpointUrl(server, 'snapshot'), { headers });
    const response = await postJson(server, 'native-actions', request);

    expect({ result: await response.json(), status: response.status }).toEqual({
      result: { kind: 'copy_text', text: 'src/protocol-dispatch.ts' },
      status: 200,
    });
    expect(perform).toHaveBeenCalledWith(request);
  });

  it('leaves current-state validation and execution in one native handler call', async () => {
    const targetId = 'native_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    let targetExists = true;
    const perform = vi.fn(() =>
      targetExists
        ? ({ kind: 'performed' } as const)
        : ({
            kind: 'unavailable',
            message: 'The target no longer exists.',
          } as const),
    );
    const server = await startLoopbackServer({
      allowedOrigins: ['null'],
      handlers: {
        snapshot: () => nativeSnapshot(targetId, ['reveal_in_finder']),
        nativeActions: perform,
      },
    });
    servers.push(server);

    await fetch(endpointUrl(server, 'snapshot'), { headers });
    targetExists = false;
    const response = await postJson(server, 'native-actions', {
      kind: 'reveal_in_finder',
      targetId,
    });

    expect({ result: await response.json(), status: response.status }).toEqual({
      result: { kind: 'unavailable', message: 'The target no longer exists.' },
      status: 200,
    });
    expect(perform).toHaveBeenCalledOnce();
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

async function expectInvalidHandlerResponse(response: Response) {
  const body = await response.json();
  expect({ body, status: response.status }).toEqual({
    body: {
      error: {
        code: 'internal_error',
        message: 'The protocol handler returned an invalid response.',
      },
    },
    status: 500,
  });
  return body;
}

function nativeSnapshot(
  targetId: string,
  actions: readonly string[],
  duplicate = false,
): ReturnType<typeof repositorySnapshotSchema.parse> {
  return repositorySnapshotSchema.parse({
    repositoryId: 'repository_99999999999999999999999999999999',
    repositoryRevision: 1,
    topologyRevision: 1,
    refsRevision: 1,
    refresh: { kind: 'current' },
    worktrees: [
      {
        worktreeId: 'worktree_99999999999999999999999999999999',
        worktreeRevision: 1,
        generation: 'generation_99999999999999999999999999999999',
        freshness: { kind: 'current' },
        head: { kind: 'initial' },
        indexTree: null,
        status: { kind: 'clean' },
        changes: [],
        nativeTargets: [
          { targetId, actions },
          ...(duplicate ? [{ targetId, actions }] : []),
        ],
      },
    ],
    remotes: [],
    operations: [],
  });
}
