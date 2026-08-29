import { request as httpRequest } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION_HEADER } from '@codex-git/protocol';

import { startLoopbackServer, type LoopbackServer } from './server.js';

const servers: LoopbackServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('loopback server lifecycle', () => {
  it('binds an ephemeral loopback listener behind a 256-bit token path', async () => {
    const randomByteRequests: number[] = [];
    const server = await startLoopbackServer({
      randomBytes: (length) => {
        randomByteRequests.push(length);
        return new Uint8Array(length).fill(0xab);
      },
    });
    servers.push(server);

    const token = server.sessionUrl.pathname.split('/')[2];
    expect({
      host: server.address.host,
      portIsEphemeral: server.address.port > 0,
      randomByteRequests,
      tokenIsHex: token !== undefined && /^[0-9a-f]+$/u.test(token),
      tokenLength: token?.length,
    }).toEqual({
      host: '127.0.0.1',
      portIsEphemeral: true,
      randomByteRequests: [32],
      tokenIsHex: true,
      tokenLength: 64,
    });
  });

  it('serves session negotiation after token, version, and opaque Origin validation', async () => {
    const server = await startLoopbackServer({ allowedOrigins: ['null'] });
    servers.push(server);

    const response = await fetch(server.sessionUrl, {
      headers: {
        origin: 'null',
        [PROTOCOL_VERSION_HEADER]: '1',
      },
    });

    expect({
      allowOrigin: response.headers.get('access-control-allow-origin'),
      body: await response.json(),
      status: response.status,
    }).toEqual({
      allowOrigin: 'null',
      body: {
        protocolVersion: 1,
        capabilities: {
          branchSearch: false,
          commands: false,
          commitDrafts: false,
          diff: false,
          events: true,
          nativeActions: false,
          operationRecovery: false,
        },
        limits: {
          diffOutputBytes: 2_097_152,
          draftBytes: 65_536,
          requestBodyBytes: 262_144,
        },
      },
      status: 200,
    });
  });

  it('answers a token-bound CORS preflight with only allow-listed protocol headers', async () => {
    const server = await startLoopbackServer({ allowedOrigins: ['null'] });
    servers.push(server);

    const response = await fetch(server.sessionUrl, {
      method: 'OPTIONS',
      headers: {
        origin: 'null',
        'access-control-request-method': 'GET',
        'access-control-request-headers': PROTOCOL_VERSION_HEADER,
      },
    });

    expect({
      allowHeaders: response.headers.get('access-control-allow-headers'),
      allowMethods: response.headers.get('access-control-allow-methods'),
      allowOrigin: response.headers.get('access-control-allow-origin'),
      status: response.status,
    }).toEqual({
      allowHeaders: PROTOCOL_VERSION_HEADER,
      allowMethods: 'GET',
      allowOrigin: 'null',
      status: 204,
    });
  });

  it('validates token and version before evaluating the browser Origin', async () => {
    const server = await startLoopbackServer({ allowedOrigins: ['null'] });
    servers.push(server);
    const staleUrl = new URL(server.sessionUrl);
    staleUrl.pathname = staleUrl.pathname.replace(
      /\/instance\/[^/]+/u,
      `/instance/${'00'.repeat(32)}`,
    );

    const [staleToken, wrongVersion, wrongOrigin] = await Promise.all([
      fetch(staleUrl, {
        headers: {
          origin: 'https://attacker.example',
          [PROTOCOL_VERSION_HEADER]: '1',
        },
      }),
      fetch(server.sessionUrl, {
        headers: {
          origin: 'https://attacker.example',
          [PROTOCOL_VERSION_HEADER]: '99',
        },
      }),
      fetch(server.sessionUrl, {
        headers: {
          origin: 'https://attacker.example',
          [PROTOCOL_VERSION_HEADER]: '1',
        },
      }),
    ]);

    const results = await Promise.all(
      [staleToken, wrongVersion, wrongOrigin].map(async (response) => ({
        body: await response.json(),
        status: response.status,
      })),
    );

    expect(results).toEqual([
      {
        body: {
          error: {
            code: 'unauthorized',
            message: 'The instance capability is invalid or expired.',
          },
        },
        status: 401,
      },
      {
        body: {
          error: {
            code: 'unsupported_protocol_version',
            details: { received: '99', supported: [1] },
            message: 'The requested protocol version is not supported.',
          },
        },
        status: 426,
      },
      {
        body: {
          error: {
            code: 'unexpected_origin',
            message: 'The browser Origin is not allowed.',
          },
        },
        status: 403,
      },
    ]);
    expect(JSON.stringify(results)).not.toContain(
      server.sessionUrl.pathname.split('/')[2],
    );
  });

  it('redacts secret-shaped protocol versions from structured errors', async () => {
    const server = await startLoopbackServer({ allowedOrigins: ['null'] });
    servers.push(server);

    const response = await fetch(server.sessionUrl, {
      headers: {
        origin: 'null',
        [PROTOCOL_VERSION_HEADER]: 'token=fixture-version-secret',
      },
    });
    const body = JSON.stringify(await response.json());

    expect(body).not.toContain('fixture-version-secret');
    expect(body).toContain('token=[REDACTED]');
  });

  it('enforces method, media type, and request-body limits before routing', async () => {
    const server = await startLoopbackServer({ allowedOrigins: ['null'] });
    servers.push(server);
    const commandsUrl = new URL(server.sessionUrl);
    commandsUrl.pathname = commandsUrl.pathname.replace(
      /\/session$/u,
      '/commands',
    );
    const headers = {
      origin: 'null',
      [PROTOCOL_VERSION_HEADER]: '1',
    };

    const [wrongMethod, wrongMediaType, oversized] = await Promise.all([
      fetch(server.sessionUrl, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
      }),
      fetch(commandsUrl, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'text/plain' },
        body: '{}',
      }),
      fetch(commandsUrl, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: 'x'.repeat(262_145),
      }),
    ]);

    expect(
      await Promise.all(
        [wrongMethod, wrongMediaType, oversized].map(async (response) => ({
          code: ((await response.json()) as { error: { code: string } }).error
            .code,
          status: response.status,
        })),
      ),
    ).toEqual([
      { code: 'method_not_allowed', status: 405 },
      { code: 'unsupported_media_type', status: 415 },
      { code: 'body_too_large', status: 413 },
    ]);
  });

  it('streams only validated invalidations and replays them after reconnect', async () => {
    const server = await startLoopbackServer({ allowedOrigins: ['null'] });
    servers.push(server);
    const headers = { origin: 'null' };
    const firstResponse = await fetch(server.eventsUrl, { headers });

    expect(
      server.publish({
        kind: 'repository_revision',
        repositoryId: 'repository_0123456789abcdef0123456789abcdef',
        repositoryRevision: 8,
        snapshot: { forbidden: 'authoritative patch' },
      }),
    ).toBe(false);
    expect(
      server.publish({
        kind: 'repository_revision',
        repositoryId: 'repository_0123456789abcdef0123456789abcdef',
        repositoryRevision: 8,
      }),
    ).toBe(true);

    expect(await readSseEvent(firstResponse)).toBe(
      [
        'id: 1',
        'event: invalidation',
        'data: {"kind":"repository_revision","repositoryId":"repository_0123456789abcdef0123456789abcdef","repositoryRevision":8}',
        '',
        '',
      ].join('\n'),
    );

    const replayResponse = await fetch(server.eventsUrl, {
      headers: { ...headers, 'last-event-id': '0' },
    });
    expect(await readSseEvent(replayResponse)).toContain('id: 1\n');
  });

  it('expires the launch capability and closes SSE clients during restart', async () => {
    const first = await startLoopbackServer({
      allowedOrigins: ['null'],
      randomBytes: (length) => new Uint8Array(length).fill(0xaa),
    });
    servers.push(first);
    const stream = await fetch(first.eventsUrl, {
      headers: {
        origin: 'null',
        [PROTOCOL_VERSION_HEADER]: '1',
      },
    });
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error('SSE response has no body.');

    await first.close();

    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(
      first.publish({
        kind: 'repository_revision',
        repositoryId: 'repository_0123456789abcdef0123456789abcdef',
        repositoryRevision: 9,
      }),
    ).toBe(false);

    const restarted = await startLoopbackServer({
      allowedOrigins: ['null'],
      randomBytes: (length) => new Uint8Array(length).fill(0xbb),
    });
    servers.push(restarted);
    expect(restarted.sessionUrl.pathname === first.sessionUrl.pathname).toBe(
      false,
    );
  });

  it('forces an incomplete authenticated request to close during shutdown', async () => {
    const server = await startLoopbackServer({ allowedOrigins: ['null'] });
    servers.push(server);
    const commandsUrl = new URL(server.sessionUrl);
    commandsUrl.pathname = commandsUrl.pathname.replace(
      /\/session$/u,
      '/commands',
    );
    const request = httpRequest(commandsUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '100',
        origin: 'null',
        [PROTOCOL_VERSION_HEADER]: '1',
      },
    });
    await new Promise<void>((resolve, reject) => {
      request.once('error', reject);
      request.write('{', (error) => (error ? reject(error) : resolve()));
    });

    const closing = server.close();
    const completedPromptly = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    request.destroy();
    await closing;

    expect(completedPromptly).toBe(true);
  });
});

async function readSseEvent(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('SSE response has no body.');
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  return text;
}
