import { z } from 'zod';

export const revisionSchema = z.number().int().nonnegative();
const objectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

function opaqueIdSchema<const Prefix extends string>(prefix: Prefix) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9a-f]{32}$`, 'u'))
    .brand<`${Prefix}Id`>();
}

export const repositoryIdSchema = opaqueIdSchema('repository');
export const worktreeIdSchema = opaqueIdSchema('worktree');
export const worktreeGenerationSchema = opaqueIdSchema('generation');
export const fileIdSchema = opaqueIdSchema('file');
export const refIdSchema = opaqueIdSchema('ref');
export const remoteIdSchema = opaqueIdSchema('remote');
export const operationIdSchema = opaqueIdSchema('operation');

export const diffRequestSchema = z.strictObject({
  fileId: fileIdSchema,
});

export const diffBaselineSchema = z.enum([
  'head_to_index',
  'index_to_working_tree',
  'empty_to_working_tree',
  'conflict',
]);

export const diffResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    fileId: fileIdSchema,
    baseline: diffBaselineSchema,
    content: z.string().max(2_097_152),
    lineCount: z.number().int().nonnegative().max(20_000),
  }),
  z.strictObject({
    kind: z.literal('too_large'),
    fileId: fileIdSchema,
    baseline: diffBaselineSchema,
    byteCount: z.number().int().nonnegative(),
    lineCount: z.number().int().nonnegative().nullable(),
  }),
  z.strictObject({
    kind: z.literal('binary'),
    fileId: fileIdSchema,
    baseline: diffBaselineSchema,
    byteCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('undecodable'),
    fileId: fileIdSchema,
    baseline: diffBaselineSchema,
    byteCount: z.number().int().nonnegative(),
  }),
]);

export const branchSearchRequestSchema = z.strictObject({
  worktreeId: worktreeIdSchema,
  query: z.string().max(256),
});

export const branchSearchResultSchema = z.strictObject({
  refsRevision: revisionSchema,
  candidates: z
    .array(
      z.strictObject({
        refId: refIdSchema,
        kind: z.enum(['local', 'remote_tracking']),
        displayName: z.string().min(1).max(1_024),
        occupiedBy: worktreeIdSchema.nullable(),
      }),
    )
    .max(5_000)
    .readonly(),
});

export const commitDraftUpdateSchema = z.strictObject({
  worktreeId: worktreeIdSchema,
  expectedRevision: revisionSchema,
  update: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('clear') }),
    z.strictObject({
      kind: z.literal('set'),
      text: z.string().max(65_536),
    }),
  ]),
});

export const commitDraftSchema = z.strictObject({
  worktreeId: worktreeIdSchema,
  revision: revisionSchema,
  text: z.string().max(65_536),
});

export const refreshStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('current') }),
  z.strictObject({ kind: z.literal('refreshing') }),
  z.strictObject({
    kind: z.literal('stale'),
    message: z.string().min(1).max(512),
  }),
  z.strictObject({
    kind: z.literal('failed'),
    message: z.string().min(1).max(512),
  }),
]);

export const headStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('initial') }),
  z.strictObject({
    kind: z.literal('detached'),
    objectId: objectIdSchema,
  }),
  z.strictObject({
    kind: z.literal('local_branch'),
    displayName: z.string().min(1).max(1_024),
    objectId: objectIdSchema,
  }),
]);

export const worktreeStatusSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('clean') }),
  z.strictObject({
    kind: z.literal('changed'),
    conflictCount: z.number().int().nonnegative(),
    stagedCount: z.number().int().nonnegative(),
    trackedChangeCount: z.number().int().nonnegative(),
    untrackedCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('in_progress'),
    operation: z.string().min(1).max(128),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: z.string().min(1).max(512),
  }),
]);

export const operationSummarySchema = z.strictObject({
  operationId: operationIdSchema,
  category: z.enum([
    'branch_switch',
    'commit',
    'fetch',
    'pull',
    'push',
    'publish',
    'stage',
    'unstage',
  ]),
  phase: z.enum(['accepted', 'running', 'reconciling', 'terminal']),
  progress: z.number().min(0).max(1).nullable(),
});

export const worktreeSnapshotSchema = z.strictObject({
  worktreeId: worktreeIdSchema,
  worktreeRevision: revisionSchema,
  generation: worktreeGenerationSchema,
  head: headStateSchema,
  indexTree: objectIdSchema.nullable(),
  status: worktreeStatusSchema,
});

export const repositorySnapshotSchema = z.strictObject({
  repositoryId: repositoryIdSchema,
  repositoryRevision: revisionSchema,
  topologyRevision: revisionSchema,
  refsRevision: revisionSchema,
  refresh: refreshStateSchema,
  worktrees: z.array(worktreeSnapshotSchema).readonly(),
  operations: z.array(operationSummarySchema).readonly(),
});

export type RepositoryId = z.infer<typeof repositoryIdSchema>;
export type WorktreeId = z.infer<typeof worktreeIdSchema>;
export type WorktreeGeneration = z.infer<typeof worktreeGenerationSchema>;
export type FileId = z.infer<typeof fileIdSchema>;
export type RefId = z.infer<typeof refIdSchema>;
export type RemoteId = z.infer<typeof remoteIdSchema>;
export type OperationId = z.infer<typeof operationIdSchema>;
export type DiffRequest = z.infer<typeof diffRequestSchema>;
export type DiffResult = z.infer<typeof diffResultSchema>;
export type BranchSearchRequest = z.infer<typeof branchSearchRequestSchema>;
export type BranchSearchResult = z.infer<typeof branchSearchResultSchema>;
export type CommitDraftUpdate = z.infer<typeof commitDraftUpdateSchema>;
export type CommitDraft = z.infer<typeof commitDraftSchema>;
export type RepositorySnapshot = z.infer<typeof repositorySnapshotSchema>;
export type WorktreeSnapshot = z.infer<typeof worktreeSnapshotSchema>;
