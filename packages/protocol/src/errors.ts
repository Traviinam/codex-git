import { z } from 'zod';

import { PROTOCOL_VERSION } from './core.js';
import { redactDiagnostic } from './redaction.js';

export const protocolErrorCodeSchema = z.enum([
  'body_too_large',
  'command_id_collision',
  'duplicate_command',
  'internal_error',
  'invalid_payload',
  'method_not_allowed',
  'non_loopback_peer',
  'not_found',
  'output_too_large',
  'stale_target',
  'unauthorized',
  'unexpected_origin',
  'unsupported_media_type',
  'unsupported_protocol_version',
]);

type JsonValue =
  boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const protocolErrorSchema = z.strictObject({
  code: protocolErrorCodeSchema,
  details: z.record(z.string(), jsonValueSchema).optional(),
  message: z.string().min(1).max(1_024),
});
export const protocolErrorResponseSchema = z.strictObject({
  error: protocolErrorSchema,
});

export type ProtocolError = z.infer<typeof protocolErrorSchema>;
export type ProtocolErrorResponse = z.infer<typeof protocolErrorResponseSchema>;
export type ProtocolParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: ProtocolError; readonly ok: false };

export function parseProtocolPayload<T>(
  schema: z.ZodType<T>,
  input: unknown,
): ProtocolParseResult<T> {
  if (
    typeof input === 'object' &&
    input !== null &&
    'protocolVersion' in input &&
    input.protocolVersion !== PROTOCOL_VERSION
  ) {
    return {
      ok: false,
      error: {
        code: 'unsupported_protocol_version',
        details: {
          received:
            typeof input.protocolVersion === 'number'
              ? input.protocolVersion
              : typeof input.protocolVersion === 'string'
                ? redactDiagnostic(input.protocolVersion)
                : null,
          supported: [PROTOCOL_VERSION],
        },
        message: 'The requested protocol version is not supported.',
      },
    };
  }
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: {
      code: 'invalid_payload',
      details: {
        issues: parsed.error.issues.map(({ code, message, path }) => ({
          code,
          message: redactDiagnostic(message),
          path: path.map((segment) => redactDiagnostic(String(segment))),
        })),
      },
      message: 'The protocol payload is invalid.',
    },
  };
}
