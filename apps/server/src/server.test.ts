import { afterEach, describe, expect, it } from 'vitest';

import { startLoopbackServer, type LoopbackServer } from './server.js';

const servers: LoopbackServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('loopback server', () => {
  it('reports that the initial runtime is healthy', async () => {
    const server = await startLoopbackServer();
    servers.push(server);

    const response = await fetch(server.healthUrl);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      product: 'codex-git',
      status: 'ok',
    });
  });
});
