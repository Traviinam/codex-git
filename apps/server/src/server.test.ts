import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppServer } from './server.js';

const servers: ReturnType<typeof createAppServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe('loopback server', () => {
  it('reports that the initial runtime is healthy', async () => {
    const server = createAppServer();
    servers.push(server);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      product: 'codex-git',
      status: 'ok',
    });
  });
});
