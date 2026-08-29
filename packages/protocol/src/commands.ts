import { z } from 'zod';

import {
  fileIdSchema,
  operationIdSchema,
  refIdSchema,
  remoteIdSchema,
  repositoryIdSchema,
  revisionSchema,
  worktreeIdSchema,
} from './schemas.js';

export const clientCommandIdSchema = z
  .string()
  .regex(/^command_[0-9a-f]{32}$/u)
  .brand<'ClientCommandId'>();

const worktreeCommandBase = {
  worktreeId: worktreeIdSchema,
  expectedWorktreeRevision: revisionSchema,
} as const;

const fileCommandBase = {
  ...worktreeCommandBase,
  fileIds: z.array(fileIdSchema).min(1).max(2_000).readonly(),
} as const;

export const productCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('stage'), ...fileCommandBase }),
  z.strictObject({ kind: z.literal('unstage'), ...fileCommandBase }),
  z.strictObject({
    kind: z.literal('commit'),
    ...worktreeCommandBase,
    draftRevision: revisionSchema,
  }),
  z.strictObject({
    kind: z.literal('switch_branch'),
    ...worktreeCommandBase,
    refId: refIdSchema,
    expectedRefsRevision: revisionSchema,
  }),
  z.strictObject({
    kind: z.literal('fetch_remote'),
    repositoryId: repositoryIdSchema,
    remoteId: remoteIdSchema,
    expectedRefsRevision: revisionSchema,
  }),
  z.strictObject({
    kind: z.literal('fetch_all'),
    repositoryId: repositoryIdSchema,
    expectedRefsRevision: revisionSchema,
  }),
  z.strictObject({ kind: z.literal('pull'), ...worktreeCommandBase }),
  z.strictObject({ kind: z.literal('push'), ...worktreeCommandBase }),
  z.strictObject({
    kind: z.literal('publish'),
    ...worktreeCommandBase,
    remoteId: remoteIdSchema,
  }),
  z.strictObject({
    kind: z.literal('cancel_operation'),
    operationId: operationIdSchema,
  }),
  z.strictObject({
    kind: z.literal('refresh'),
    repositoryId: repositoryIdSchema,
  }),
]);

export const commandEnvelopeSchema = z.strictObject({
  clientCommandId: clientCommandIdSchema,
  command: productCommandSchema,
});

export type ClientCommandId = z.infer<typeof clientCommandIdSchema>;
export type ProductCommand = z.infer<typeof productCommandSchema>;
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
