import { z } from 'zod';

import {
  fileIdSchema,
  nativeTargetIdSchema,
  operationIdSchema,
  refIdSchema,
  remoteIdSchema,
  repositoryIdSchema,
  worktreeGenerationSchema,
  worktreeIdSchema,
} from './identifiers.js';
import { nativeActionKindSchema } from './native-actions.js';
import { PROTOCOL_LIMITS } from './session.js';

export const revisionSchema = z.number().int().nonnegative();
const objectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

const utf8ByteLength = (value: string) =>
  new TextEncoder().encode(value).length;
const utf8StringAtMost = (bytes: number) =>
  z.string().refine((value) => utf8ByteLength(value) <= bytes, {
    message: `String must contain at most ${bytes} UTF-8 bytes.`,
  });

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
    content: utf8StringAtMost(PROTOCOL_LIMITS.diffOutputBytes),
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
      text: utf8StringAtMost(PROTOCOL_LIMITS.draftBytes),
    }),
  ]),
});

export const commitDraftSchema = z.strictObject({
  worktreeId: worktreeIdSchema,
  revision: revisionSchema,
  text: utf8StringAtMost(PROTOCOL_LIMITS.draftBytes),
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

export const fetchFreshnessSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('never') }),
  z.strictObject({
    kind: z.literal('current'),
    fetchedAt: z.string().datetime(),
  }),
  z.strictObject({
    kind: z.enum(['stale', 'failed']),
    fetchedAt: z.string().datetime().nullable(),
    message: z.string().min(1).max(512),
  }),
]);

export const upstreamOverviewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('tracking'),
    displayName: z.string().min(1).max(1_024),
    ahead: z.number().int().nonnegative().nullable(),
    behind: z.number().int().nonnegative().nullable(),
    fetchedAt: z.string().datetime().nullable(),
  }),
  z.strictObject({
    kind: z.literal('unpublished'),
    remoteName: z.string().min(1).max(256).nullable(),
    fetchedAt: z.string().datetime().nullable(),
  }),
  z.strictObject({
    kind: z.literal('not-applicable'),
    reason: z.string().min(1).max(512),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: z.string().min(1).max(512),
  }),
]);

export const worktreeAvailabilitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('available') }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: z.string().min(1).max(512),
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

export const nativeTargetDescriptorSchema = z.strictObject({
  targetId: nativeTargetIdSchema,
  actions: z.array(nativeActionKindSchema).min(1).readonly(),
});

const changedFileBase = {
  fileId: fileIdSchema,
  displayPath: z.string().min(1).max(4_096),
  previousDisplayPath: z.string().min(1).max(4_096).nullable(),
  nativeTargets: z.array(nativeTargetDescriptorSchema).readonly(),
} as const;

export const changedFileSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...changedFileBase,
    kind: z.literal('conflict'),
    baseline: z.literal('conflict'),
  }),
  z.strictObject({
    ...changedFileBase,
    kind: z.literal('staged_change'),
    baseline: z.literal('head_to_index'),
  }),
  z.strictObject({
    ...changedFileBase,
    kind: z.literal('change'),
    baseline: z.literal('index_to_working_tree'),
  }),
  z.strictObject({
    ...changedFileBase,
    kind: z.literal('untracked'),
    baseline: z.literal('empty_to_working_tree'),
  }),
]);

const sanitizedRemoteHostPattern =
  /^(?:\[[\da-f:.]+\]|[\da-z](?:[\da-z.-]*[\da-z])?)(?::\d{1,5})?$/iu;

export const remoteSummarySchema = z.strictObject({
  remoteId: remoteIdSchema,
  displayName: z.string().min(1).max(256),
  host: z.string().min(1).max(1_024).regex(sanitizedRemoteHostPattern),
});

export const worktreeSnapshotSchema = z.strictObject({
  worktreeId: worktreeIdSchema,
  worktreeRevision: revisionSchema,
  generation: worktreeGenerationSchema,
  role: z.enum(['main', 'linked']),
  displayName: z.string().min(1).max(1_024),
  path: z.string().min(1).max(4_096),
  availability: worktreeAvailabilitySchema,
  freshness: refreshStateSchema,
  head: headStateSchema,
  indexTree: objectIdSchema.nullable(),
  status: worktreeStatusSchema,
  upstream: upstreamOverviewSchema,
  changes: z.array(changedFileSchema).max(2_000).readonly(),
  nativeTargets: z.array(nativeTargetDescriptorSchema).readonly(),
});

export const repositorySnapshotSchema = z.strictObject({
  kind: z.literal('repository'),
  repositoryId: repositoryIdSchema,
  repositoryRevision: revisionSchema,
  topologyRevision: revisionSchema,
  refsRevision: revisionSchema,
  displayName: z.string().min(1).max(1_024),
  path: z.string().min(1).max(4_096),
  refresh: refreshStateSchema,
  fetch: fetchFreshnessSchema,
  fetchAvailable: z.boolean(),
  worktrees: z.array(worktreeSnapshotSchema).readonly(),
  remotes: z.array(remoteSummarySchema).readonly(),
  operations: z.array(operationSummarySchema).readonly(),
});

export const repositorySnapshotResultSchema = z.union([
  repositorySnapshotSchema,
  z.strictObject({
    kind: z.literal('non_repository'),
    projectPath: z.string().min(1).max(4_096),
    message: z.string().min(1).max(512),
  }),
  z.strictObject({
    kind: z.literal('failed'),
    projectPath: z.string().min(1).max(4_096),
    message: z.string().min(1).max(512),
  }),
]);

export type DiffRequest = z.infer<typeof diffRequestSchema>;
export type DiffResult = z.infer<typeof diffResultSchema>;
export type BranchSearchRequest = z.infer<typeof branchSearchRequestSchema>;
export type BranchSearchResult = z.infer<typeof branchSearchResultSchema>;
export type CommitDraftUpdate = z.infer<typeof commitDraftUpdateSchema>;
export type CommitDraft = z.infer<typeof commitDraftSchema>;
export type RepositorySnapshot = z.infer<typeof repositorySnapshotSchema>;
export type RepositorySnapshotResult = z.infer<
  typeof repositorySnapshotResultSchema
>;
export type WorktreeSnapshot = z.infer<typeof worktreeSnapshotSchema>;
