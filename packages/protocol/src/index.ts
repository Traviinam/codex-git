import { z } from 'zod';

export * from './commands.js';
export * from './events.js';
export * from './native-actions.js';
export * from './opaque-ids.js';
export * from './operations.js';
export * from './redaction.js';
export * from './schemas.js';

export const PROTOCOL_VERSION = 1 as const;

export const sessionMetadataSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  capabilities: z.strictObject({
    branchSearch: z.boolean(),
    commands: z.boolean(),
    commitDrafts: z.boolean(),
    diff: z.boolean(),
    events: z.boolean(),
    nativeActions: z.boolean(),
    operationRecovery: z.boolean(),
  }),
  limits: z.strictObject({
    diffOutputBytes: z.number().int().positive(),
    draftBytes: z.number().int().positive(),
    requestBodyBytes: z.number().int().positive(),
  }),
});

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

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
            typeof input.protocolVersion === 'number' ||
            typeof input.protocolVersion === 'string'
              ? input.protocolVersion
              : null,
          supported: [PROTOCOL_VERSION],
        },
        message: 'The requested protocol version is not supported.',
      },
    };
  }

  const parsed = schema.safeParse(input);

  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }

  return {
    ok: false,
    error: {
      code: 'invalid_payload',
      details: {
        issues: parsed.error.issues.map(({ code, message, path }) => ({
          code,
          message,
          path: path.map(String),
        })),
      },
      message: 'The protocol payload is invalid.',
    },
  };
}

export interface HealthResponse {
  readonly product: 'codex-git';
  readonly status: 'ok';
}

declare const absolutePathBrand: unique symbol;
export type AbsolutePath = string & { readonly [absolutePathBrand]: true };

export interface RepositoryRevision {
  readonly repositoryRevision: number;
}
