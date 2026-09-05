import type { OutgoingHttpHeaders, OutgoingHttpHeader } from 'node:http';
import type { Plugin } from 'vite';

// Only public JavaScript/CSS may be read by sandboxed frames. HTML contains
// the protocol capability and must never receive opaque-origin CORS headers.
export function embeddedAssetsPlugin(): Plugin {
  return {
    name: 'codex-git-embedded-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.headers.origin === 'null') {
          const original = response.writeHead;
          response.writeHead = function (
            statusCode: number,
            statusMessageOrHeaders?:
              string | OutgoingHttpHeaders | OutgoingHttpHeader[],
            extraHeaders?: OutgoingHttpHeaders | OutgoingHttpHeader[],
          ) {
            const headers =
              typeof statusMessageOrHeaders === 'string'
                ? extraHeaders
                : statusMessageOrHeaders;
            const args =
              typeof statusMessageOrHeaders === 'string'
                ? [statusCode, statusMessageOrHeaders, extraHeaders]
                : [statusCode, headers];
            const explicitType =
              headers !== undefined &&
              typeof headers === 'object' &&
              !Array.isArray(headers)
                ? (headers['content-type'] ?? headers['Content-Type'])
                : undefined;
            const type = Array.isArray(headers)
              ? ''
              : String(
                  explicitType ?? response.getHeader('content-type') ?? '',
                ).split(';')[0];
            if (
              type === 'text/javascript' ||
              type === 'application/javascript' ||
              type === 'text/css'
            ) {
              response.setHeader('access-control-allow-origin', 'null');
              response.setHeader('vary', 'Origin');
            }
            return Reflect.apply(original, response, args);
          };
        }
        next();
      });
    },
  };
}
