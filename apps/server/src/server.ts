import { createServer, type Server } from 'node:http';

import type { HealthResponse } from '@codex-git/protocol';

const healthResponse = {
  product: 'codex-git',
  status: 'ok',
} satisfies HealthResponse;

export function createAppServer(): Server {
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify(healthResponse));
      return;
    }

    response.writeHead(404, {
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
}
