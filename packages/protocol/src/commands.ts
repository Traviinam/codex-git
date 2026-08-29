import { z } from 'zod';

import { revisionSchema } from './schemas.js';
import {
  clientCommandIdSchema,
  fileIdSchema,
  operationIdSchema,
  refIdSchema,
  remoteIdSchema,
  repositoryIdSchema,
  worktreeIdSchema,
} from './identifiers.js';

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
  z.strictObject({
    kind: z.literal('pull'),
    ...worktreeCommandBase,
    expectedRefsRevision: revisionSchema,
  }),
  z.strictObject({
    kind: z.literal('push'),
    ...worktreeCommandBase,
    expectedRefsRevision: revisionSchema,
  }),
  z.strictObject({
    kind: z.literal('publish'),
    ...worktreeCommandBase,
    remoteId: remoteIdSchema,
    expectedRefsRevision: revisionSchema,
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

export type ProductCommand = z.infer<typeof productCommandSchema>;
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
