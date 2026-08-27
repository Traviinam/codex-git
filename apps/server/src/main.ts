import type { AddressInfo } from 'node:net';

import { createAppServer } from './server.js';

const host = '127.0.0.1';
const requestedPort = Number.parseInt(process.env.CODEX_GIT_PORT ?? '0', 10);
const server = createAppServer();

server.listen(requestedPort, host, () => {
  const address = server.address() as AddressInfo;
  console.log(
    `Codex Git server scaffold listening at http://${host}:${address.port}`,
  );
});

function stop(): void {
  server.close(() => process.exit(0));
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
