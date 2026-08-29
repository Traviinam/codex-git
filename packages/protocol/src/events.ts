import { z } from 'zod';

import {
  operationIdSchema,
  repositoryIdSchema,
  worktreeIdSchema,
} from './identifiers.js';
import { revisionSchema } from './schemas.js';

export const sseInvalidationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('repository_revision'),
    repositoryId: repositoryIdSchema,
    repositoryRevision: revisionSchema,
  }),
  z.strictObject({
    kind: z.literal('worktree_revision'),
    repositoryId: repositoryIdSchema,
    repositoryRevision: revisionSchema,
    worktreeId: worktreeIdSchema,
    worktreeRevision: revisionSchema,
  }),
  z.strictObject({
    kind: z.literal('operation_progress'),
    operationId: operationIdSchema,
    phase: z.enum(['accepted', 'running', 'reconciling', 'terminal']),
    progress: z.number().min(0).max(1).nullable(),
  }),
]);

export type SseInvalidation = z.infer<typeof sseInvalidationSchema>;
