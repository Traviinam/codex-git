import { z } from 'zod';

import { PROTOCOL_VERSION } from './core.js';

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
