import { z } from 'zod';

import { clientCommandIdSchema } from './commands.js';
import { operationIdSchema } from './schemas.js';

const messageSchema = z.string().min(1).max(8_192);

export const operationReceiptSchema = z.strictObject({
  operationId: operationIdSchema,
  clientCommandId: clientCommandIdSchema,
  disposition: z.enum(['accepted', 'duplicate']),
});

export const operationRecoveryRequestSchema = z.strictObject({
  operationId: operationIdSchema,
});

export const operationResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('succeeded'),
    operationId: operationIdSchema,
  }),
  z.strictObject({
    kind: z.literal('rejected'),
    operationId: operationIdSchema,
    code: z.enum(['busy', 'stale', 'precondition_failed', 'unsupported_state']),
    message: messageSchema,
  }),
  z.strictObject({
    kind: z.literal('failed_known'),
    operationId: operationIdSchema,
    code: z.enum([
      'authentication',
      'conflict',
      'hook_rejected',
      'offline',
      'permission',
      'policy',
      'process_failed',
      'timeout',
    ]),
    message: messageSchema,
  }),
  z.strictObject({
    kind: z.literal('partial_success'),
    operationId: operationIdSchema,
    message: messageSchema,
    effects: z
      .array(
        z.strictObject({
          label: z.string().min(1).max(256),
          kind: z.enum(['succeeded', 'failed_known']),
          message: messageSchema.optional(),
        }),
      )
      .min(2)
      .max(1_000)
      .readonly(),
  }),
  z.strictObject({
    kind: z.literal('unknown_outcome'),
    operationId: operationIdSchema,
    code: z.literal('reconciliation_incomplete'),
    message: messageSchema,
    recoveryAvailable: z.literal(true),
  }),
]);

export type OperationReceipt = z.infer<typeof operationReceiptSchema>;
export type OperationRecoveryRequest = z.infer<
  typeof operationRecoveryRequestSchema
>;
export type OperationResult = z.infer<typeof operationResultSchema>;
