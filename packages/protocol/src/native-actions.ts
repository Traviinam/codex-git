import { z } from 'zod';

import { nativeTargetIdSchema } from './identifiers.js';

export const nativeActionKindSchema = z.enum([
  'open_terminal',
  'reveal_in_finder',
  'copy_absolute_path',
  'copy_branch_or_sha',
  'open_codex_context',
  'open_file_in_codex',
  'copy_relative_path',
  'open_default_app',
]);

const target = { targetId: nativeTargetIdSchema } as const;

export const nativeActionRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('open_terminal'), ...target }),
  z.strictObject({ kind: z.literal('reveal_in_finder'), ...target }),
  z.strictObject({ kind: z.literal('copy_absolute_path'), ...target }),
  z.strictObject({ kind: z.literal('copy_branch_or_sha'), ...target }),
  z.strictObject({ kind: z.literal('open_codex_context'), ...target }),
  z.strictObject({ kind: z.literal('open_file_in_codex'), ...target }),
  z.strictObject({ kind: z.literal('copy_relative_path'), ...target }),
  z.strictObject({ kind: z.literal('open_default_app'), ...target }),
]);

export const nativeActionResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('performed') }),
  z.strictObject({
    kind: z.literal('copy_text'),
    text: z.string().max(8_192),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    message: z.string().min(1).max(512),
  }),
]);

export type NativeActionKind = z.infer<typeof nativeActionKindSchema>;
export type NativeActionRequest = z.infer<typeof nativeActionRequestSchema>;
export type NativeActionResult = z.infer<typeof nativeActionResultSchema>;
