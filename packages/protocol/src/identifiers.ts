import { z } from 'zod';

function prefixedOpaqueIdSchema<const Prefix extends string>(prefix: Prefix) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9a-f]{32}$`, 'u'))
    .brand<`${Prefix}Id`>();
}

export const repositoryIdSchema = prefixedOpaqueIdSchema('repository');
export const worktreeIdSchema = prefixedOpaqueIdSchema('worktree');
export const worktreeGenerationSchema = prefixedOpaqueIdSchema('generation');
export const fileIdSchema = prefixedOpaqueIdSchema('file');
export const refIdSchema = prefixedOpaqueIdSchema('ref');
export const remoteIdSchema = prefixedOpaqueIdSchema('remote');
export const operationIdSchema = prefixedOpaqueIdSchema('operation');
export const nativeTargetIdSchema = prefixedOpaqueIdSchema('native');
export const clientCommandIdSchema = prefixedOpaqueIdSchema('command');

export type RepositoryId = z.infer<typeof repositoryIdSchema>;
export type WorktreeId = z.infer<typeof worktreeIdSchema>;
export type WorktreeGeneration = z.infer<typeof worktreeGenerationSchema>;
export type FileId = z.infer<typeof fileIdSchema>;
export type RefId = z.infer<typeof refIdSchema>;
export type RemoteId = z.infer<typeof remoteIdSchema>;
export type OperationId = z.infer<typeof operationIdSchema>;
export type NativeTargetId = z.infer<typeof nativeTargetIdSchema>;
export type ClientCommandId = z.infer<typeof clientCommandIdSchema>;
