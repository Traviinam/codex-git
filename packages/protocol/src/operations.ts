import { z } from 'zod';

import { clientCommandIdSchema, operationIdSchema } from './identifiers.js';

const messageSchema = z.string().min(1).max(8_192);

export const operationFailureCodeSchema = z.enum([
  'authentication',
  'conflict',
  'hook_rejected',
  'invalid_remote',
  'non_fast_forward',
  'offline',
  'permission',
  'policy',
  'process_failed',
  'signing_failed',
  'timeout',
]);

export const operationSuccessResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('no_change') }),
  z.strictObject({
    kind: z.literal('commit'),
    shortObjectId: z.string().regex(/^[0-9a-f]{7,64}$/u),
    summary: z.string().min(1).max(512),
  }),
  z.strictObject({
    kind: z.literal('files'),
    affectedCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('branch_switch'),
    displayName: z.string().min(1).max(1_024),
  }),
  z.strictObject({
    kind: z.literal('remote'),
    summary: z.string().min(1).max(512),
  }),
]);

export const operationReceiptSchema = z.strictObject({
  operationId: operationIdSchema,
  clientCommandId: clientCommandIdSchema,
  disposition: z.enum(['accepted', 'duplicate']),
});

export const operationRecoveryRequestSchema = z.strictObject({
  operationId: operationIdSchema,
});

const operationFailureEffectSchema = z.strictObject({
  label: z.string().min(1).max(256),
  kind: z.literal('failed_known'),
  code: operationFailureCodeSchema,
  message: messageSchema,
});

export const operationResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('succeeded'),
    operationId: operationIdSchema,
    result: operationSuccessResultSchema,
  }),
  z.strictObject({
    kind: z.literal('rejected'),
    operationId: operationIdSchema,
    code: z.enum([
      'busy',
      'index_locked',
      'missing_identity',
      'stale',
      'precondition_failed',
      'unsupported_state',
    ]),
    message: messageSchema,
  }),
  z.strictObject({
    kind: z.literal('failed_known'),
    operationId: operationIdSchema,
    code: operationFailureCodeSchema,
    message: messageSchema,
    effects: z
      .array(operationFailureEffectSchema)
      .min(2)
      .max(1_000)
      .readonly()
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('partial_success'),
    operationId: operationIdSchema,
    message: messageSchema,
    effects: z
      .array(
        z.discriminatedUnion('kind', [
          z.strictObject({
            label: z.string().min(1).max(256),
            kind: z.literal('succeeded'),
          }),
          operationFailureEffectSchema,
        ]),
      )
      .min(2)
      .max(1_000)
      .refine(
        (effects) =>
          effects.some(({ kind }) => kind === 'succeeded') &&
          effects.some(({ kind }) => kind === 'failed_known'),
        {
          message: 'Partial Success requires both success and failure effects.',
        },
      )
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
export type OperationFailureCode = z.infer<typeof operationFailureCodeSchema>;
export type OperationRecoveryRequest = z.infer<
  typeof operationRecoveryRequestSchema
>;
export type OperationResult = z.infer<typeof operationResultSchema>;
