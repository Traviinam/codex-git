import { randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  PROTOCOL_LIMITS,
  redactDiagnostic,
  sseInvalidationSchema,
  type HealthResponse,
  type ProtocolError,
} from '@codex-git/protocol';

import {
  createProtocolDispatcher,
  type ProtocolDispatcher,
  type ProtocolHandlers,
} from './protocol-dispatch.js';

const healthResponse = {
  product: 'codex-git',
  status: 'ok',
} satisfies HealthResponse;

const loopbackHost = '127.0.0.1' as const;
const endpointMethods = new Map<string, string>([
  ['branches', 'POST'],
  ['commands', 'POST'],
  ['diff', 'POST'],
  ['draft', 'PUT'],
  ['events', 'GET'],
  ['native-actions', 'POST'],
  ['operations', 'POST'],
  ['session', 'GET'],
  ['snapshot', 'GET'],
]);
export interface LoopbackAddress {
  readonly host: typeof loopbackHost;
  readonly port: number;
}

export interface LoopbackServer {
  readonly address: LoopbackAddress;
  readonly eventsUrl: URL;
  readonly healthUrl: URL;
  readonly sessionUrl: URL;
  allowOrigin(origin: string): void;
  publish(event: unknown): boolean;
  close(): Promise<void>;
}

export interface LoopbackServerOptions {
  readonly allowedOrigins?: readonly string[];
  readonly handlers?: ProtocolHandlers;
  readonly randomBytes?: (length: number) => Uint8Array;
}

export async function startLoopbackServer(
  options: LoopbackServerOptions = {},
): Promise<LoopbackServer> {
  const tokenBytes = (options.randomBytes ?? nodeRandomBytes)(32);
  if (tokenBytes.length !== 32) {
    throw new Error('Instance token randomness must contain exactly 32 bytes.');
  }
  const token = Buffer.from(tokenBytes).toString('hex');
  const instancePrefix = `/instance/${token}/v1`;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const dispatcher = createProtocolDispatcher(options.handlers);
  const events = createEventBroker();
  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      token,
      instancePrefix,
      allowedOrigins,
      dispatcher,
      events,
    ).catch(() => {
      if (!response.headersSent) {
        sendProtocolError(response, 500, {
          code: 'internal_error',
          message: 'The protocol request could not be completed.',
        });
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, loopbackHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const baseUrl = new URL(`http://${loopbackHost}:${address.port}`);
  let closePromise: Promise<void> | undefined;

  return {
    address: { host: loopbackHost, port: address.port },
    eventsUrl: new URL(`${instancePrefix}/events`, baseUrl),
    healthUrl: new URL('/health', baseUrl),
    sessionUrl: new URL(`${instancePrefix}/session`, baseUrl),
    allowOrigin(origin) {
      allowedOrigins.add(origin);
    },
    publish: events.publish,
    close() {
      if (closePromise !== undefined) return closePromise;
      events.closeAll();
      closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      return closePromise;
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  instancePrefix: string,
  allowedOrigins: ReadonlySet<string>,
  dispatcher: ProtocolDispatcher,
  events: EventBroker,
): Promise<void> {
  if (request.socket.remoteAddress !== loopbackHost) {
    sendProtocolError(response, 403, {
      code: 'non_loopback_peer',
      message: 'The peer is not a loopback client.',
    });
    return;
  }

  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, healthResponse);
    return;
  }

  const pathname = new URL(request.url ?? '/', 'http://loopback').pathname;
  const pathSegments = pathname.split('/');
  const providedToken =
    pathSegments[1] === 'instance' ? pathSegments[2] : undefined;
  const requestedPathVersion = pathSegments[3];
  const version = request.headers[PROTOCOL_VERSION_HEADER];
  const origin = request.headers.origin;

  if (!matchesToken(providedToken, token)) {
    sendProtocolError(response, 401, {
      code: 'unauthorized',
      message: 'The instance capability is invalid or expired.',
    });
    return;
  }
  if (requestedPathVersion !== `v${PROTOCOL_VERSION}`) {
    sendProtocolError(response, 426, {
      code: 'unsupported_protocol_version',
      details: {
        received:
          requestedPathVersion === undefined
            ? null
            : redactDiagnostic(requestedPathVersion),
        supported: [PROTOCOL_VERSION],
      },
      message: 'The requested protocol version is not supported.',
    });
    return;
  }

  const endpoint = pathname.startsWith(`${instancePrefix}/`)
    ? pathname.slice(instancePrefix.length + 1)
    : '';
  const expectedMethod = endpointMethods.get(endpoint);
  if (request.method === 'OPTIONS') {
    handlePreflight(request, response, origin, expectedMethod, allowedOrigins);
    return;
  }

  if (endpoint !== 'events' && version !== String(PROTOCOL_VERSION)) {
    sendProtocolError(response, 426, {
      code: 'unsupported_protocol_version',
      details: {
        received:
          typeof version === 'string' ? redactDiagnostic(version) : null,
        supported: [PROTOCOL_VERSION],
      },
      message: 'The requested protocol version is not supported.',
    });
    return;
  }
  if (origin === undefined || !allowedOrigins.has(origin)) {
    sendProtocolError(response, 403, {
      code: 'unexpected_origin',
      message: 'The browser Origin is not allowed.',
    });
    return;
  }

  if (expectedMethod === undefined) {
    sendProtocolError(
      response,
      404,
      { code: 'not_found', message: 'The protocol endpoint does not exist.' },
      origin,
    );
    return;
  }
  if (request.method !== expectedMethod) {
    sendProtocolError(
      response,
      405,
      {
        code: 'method_not_allowed',
        message: 'The HTTP method is not allowed for this endpoint.',
      },
      origin,
    );
    return;
  }

  let body: Buffer | undefined;
  if (expectedMethod === 'POST' || expectedMethod === 'PUT') {
    const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim();
    if (mediaType !== 'application/json') {
      request.resume();
      sendProtocolError(
        response,
        415,
        {
          code: 'unsupported_media_type',
          message: 'The request body must use application/json.',
        },
        origin,
      );
      return;
    }
    const requestBody = await readBoundedBody(
      request,
      dispatcher.sessionMetadata.limits.requestBodyBytes,
    );
    if (requestBody === null) {
      sendProtocolError(
        response,
        413,
        {
          code: 'body_too_large',
          details: {
            limitBytes: dispatcher.sessionMetadata.limits.requestBodyBytes,
          },
          message: 'The request body exceeds the configured limit.',
        },
        origin,
      );
      return;
    }
    body = requestBody;
  }

  if (endpoint === 'events') {
    events.open(request, response, origin);
    return;
  }

  if (endpoint === 'session') {
    sendJson(response, 200, dispatcher.sessionMetadata, origin);
    return;
  }

  try {
    const dispatched = await dispatcher.dispatch(endpoint, body);
    if (dispatched !== undefined) {
      sendJson(response, dispatched.status, dispatched.value, origin);
      return;
    }
  } catch {
    sendProtocolError(
      response,
      500,
      {
        code: 'internal_error',
        message: 'The protocol request could not be completed.',
      },
      origin,
    );
    return;
  }

  sendProtocolError(
    response,
    404,
    { code: 'not_found', message: 'The protocol endpoint is not implemented.' },
    origin,
  );
}

function handlePreflight(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  expectedMethod: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): void {
  if (origin === undefined || !allowedOrigins.has(origin)) {
    sendProtocolError(response, 403, {
      code: 'unexpected_origin',
      message: 'The browser Origin is not allowed.',
    });
    return;
  }
  if (expectedMethod === undefined) {
    sendProtocolError(
      response,
      404,
      { code: 'not_found', message: 'The protocol endpoint does not exist.' },
      origin,
    );
    return;
  }
  if (request.headers['access-control-request-method'] !== expectedMethod) {
    sendProtocolError(
      response,
      405,
      {
        code: 'method_not_allowed',
        message: 'The requested CORS method is not allowed.',
      },
      origin,
    );
    return;
  }

  const requestedHeaders = (
    request.headers['access-control-request-headers'] ?? ''
  )
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header.length > 0);
  const allowedHeaders = new Set([
    'content-type',
    'last-event-id',
    PROTOCOL_VERSION_HEADER.toLowerCase(),
  ]);
  if (requestedHeaders.some((header) => !allowedHeaders.has(header))) {
    sendProtocolError(
      response,
      403,
      {
        code: 'invalid_payload',
        message: 'The requested CORS headers are not allowed.',
      },
      origin,
    );
    return;
  }

  response.writeHead(204, {
    'access-control-allow-headers': requestedHeaders.join(', '),
    'access-control-allow-methods': expectedMethod,
    'access-control-allow-origin': origin,
    'access-control-max-age': '600',
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  });
  response.end();
}

interface EventBroker {
  readonly publish: (event: unknown) => boolean;
  open(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string,
  ): void;
  closeAll(): void;
}

interface StoredEvent {
  readonly id: number;
  readonly frame: string;
}

function createEventBroker(): EventBroker {
  const clients = new Set<ServerResponse>();
  const history: StoredEvent[] = [];
  let nextId = 1;
  let closed = false;

  return {
    publish(event) {
      if (closed) return false;
      const parsed = sseInvalidationSchema.safeParse(event);
      if (!parsed.success) return false;
      const stored = {
        id: nextId,
        frame: [
          `id: ${nextId}`,
          'event: invalidation',
          `data: ${JSON.stringify(parsed.data)}`,
          '',
          '',
        ].join('\n'),
      } satisfies StoredEvent;
      nextId += 1;
      history.push(stored);
      if (history.length > 100) history.shift();
      for (const client of clients) {
        if (!client.write(stored.frame)) {
          clients.delete(client);
          client.destroy();
        }
      }
      return true;
    },
    open(request, response, origin) {
      const lastEventIdHeader = request.headers['last-event-id'];
      const lastEventId = Array.isArray(lastEventIdHeader)
        ? null
        : parseLastEventId(lastEventIdHeader);
      if (lastEventId === null) {
        sendProtocolError(
          response,
          400,
          {
            code: 'invalid_payload',
            message: 'Last-Event-ID must be a non-negative integer.',
          },
          origin,
        );
        return;
      }
      response.writeHead(200, {
        'access-control-allow-origin': origin,
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
        vary: 'Origin',
      });
      response.flushHeaders();
      clients.add(response);
      response.once('close', () => clients.delete(response));
      if (lastEventId !== undefined) {
        for (const event of history) {
          if (event.id > lastEventId && !response.write(event.frame)) {
            clients.delete(response);
            response.destroy();
            return;
          }
        }
      }
    },
    closeAll() {
      closed = true;
      for (const client of clients) client.end();
      clients.clear();
      history.splice(0);
    },
  };
}

function parseLastEventId(
  value: string | undefined,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readBoundedBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<Buffer | null> {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    request.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limitBytes) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function matchesToken(provided: string | undefined, expected: string): boolean {
  if (provided === undefined || provided.length !== expected.length)
    return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return (
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes)
  );
}

function sendProtocolError(
  response: ServerResponse,
  status: number,
  error: ProtocolError,
  origin?: string,
): void {
  sendJson(response, status, { error }, origin);
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  origin?: string,
): void {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > PROTOCOL_LIMITS.diffOutputBytes) {
    response.writeHead(507, {
      ...(origin === undefined
        ? {}
        : { 'access-control-allow-origin': origin, vary: 'Origin' }),
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(
      JSON.stringify({
        error: {
          code: 'output_too_large',
          details: { limitBytes: PROTOCOL_LIMITS.diffOutputBytes },
          message: 'The protocol response exceeds the configured limit.',
        },
      }),
    );
    return;
  }
  response.writeHead(status, {
    ...(origin === undefined
      ? {}
      : { 'access-control-allow-origin': origin, vary: 'Origin' }),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}
