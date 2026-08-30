import type { AbsolutePath } from '@codex-git/protocol';

export type WorktreeProvenance =
  | {
      readonly kind: 'codex_task';
      readonly task: CodexTaskMetadata;
    }
  | { readonly kind: 'scheduled' }
  | { readonly kind: 'permanent' }
  | { readonly kind: 'external' }
  | { readonly kind: 'unclassified' };

export interface CodexTaskMetadata {
  readonly id: string;
  readonly status: string;
  readonly title: string;
}

export type CodexWorktreeMetadata =
  | {
      readonly canonicalCwd: AbsolutePath | string;
      readonly kind: 'codex_task';
      readonly stable: boolean;
      readonly task: CodexTaskMetadata;
    }
  | {
      readonly canonicalCwd: AbsolutePath | string;
      readonly kind: 'scheduled' | 'permanent' | 'external';
      readonly stable: boolean;
    };

export interface CodexMetadataAdapter {
  read(signal?: AbortSignal): Promise<readonly CodexWorktreeMetadata[]>;
}

export function resolveWorktreeProvenance(
  canonicalCwd: AbsolutePath | string,
  metadata: readonly CodexWorktreeMetadata[],
): WorktreeProvenance {
  const exactCwdCandidates = metadata.filter(
    (candidate) => candidate.canonicalCwd === canonicalCwd,
  );
  if (
    exactCwdCandidates.length === 0 ||
    exactCwdCandidates.some((candidate) => !isStableMetadata(candidate))
  ) {
    return { kind: 'unclassified' };
  }
  const stableCandidates =
    exactCwdCandidates as readonly (CodexWorktreeMetadata & {
      readonly stable: true;
    })[];
  const first = stableCandidates[0]!;
  if (
    stableCandidates.some(
      (candidate) => JSON.stringify(candidate) !== JSON.stringify(first),
    )
  ) {
    return { kind: 'unclassified' };
  }
  return first.kind === 'codex_task'
    ? { kind: first.kind, task: first.task }
    : { kind: first.kind };
}

function isStableMetadata(
  candidate: CodexWorktreeMetadata,
): candidate is CodexWorktreeMetadata & { readonly stable: true } {
  if (!candidate.stable) return false;
  if (
    candidate.kind !== 'codex_task' &&
    candidate.kind !== 'scheduled' &&
    candidate.kind !== 'permanent' &&
    candidate.kind !== 'external'
  ) {
    return false;
  }
  if (candidate.kind !== 'codex_task') return true;
  const task: unknown = candidate.task;
  if (typeof task !== 'object' || task === null) return false;
  const fields = task as Record<string, unknown>;
  return (
    boundedText(fields.id, 1_024) &&
    boundedText(fields.status, 128) &&
    boundedText(fields.title, 1_024)
  );
}

function boundedText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximumLength
  );
}
