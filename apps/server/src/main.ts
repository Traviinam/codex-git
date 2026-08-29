import { startLoopbackServer } from './server.js';

const server = await startLoopbackServer({ allowedOrigins: ['null'] });
console.log(
  `Codex Git server listening at http://${server.address.host}:${server.address.port}`,
);

function stop(): void {
  void server.close().then(() => process.exit(0));
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
