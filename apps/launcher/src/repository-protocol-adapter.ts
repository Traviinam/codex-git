import { basename, isAbsolute } from 'node:path';

import type {
  RepositoryOpenResult,
  PublishedWorktreeSnapshot,
  RefreshState,
} from '@codex-git/repository-engine';
import {
  repositorySnapshotSchema,
  type RepositorySnapshotResult,
} from '@codex-git/protocol';

export interface HostNavigationContext {
  readonly canonicalProjectPath: string | null;
  readonly openCodexContext: boolean;
  readonly openFileInCodex: boolean;
  readonly taskId: string | null;
}

const noHostNavigation: HostNavigationContext = {
  canonicalProjectPath: null,
  openCodexContext: false,
  openFileInCodex: false,
  taskId: null,
};

export function toProtocolRepositorySnapshot(
  result: RepositoryOpenResult,
  projectPath: string,
  hostNavigation: HostNavigationContext = noHostNavigation,
): RepositorySnapshotResult {
  if (result.kind === 'not_repository') {
    return {
      kind: 'non_repository',
      projectPath,
      message: 'The Current Project is not inside a Git Repository.',
    };
  }
  if (result.kind === 'failed') {
    return {
      kind: 'failed',
      projectPath,
      message: result.refresh.error.message,
    };
  }
  const source = result.repository;
  const main =
    source.worktrees.find(({ role }) => role === 'main') ?? source.worktrees[0];
  const repositoryPath =
    main?.canonicalPath ?? main?.displayPath ?? projectPath;
  const remoteFetches = new Map(
    source.remoteFetches?.map(({ remoteId, fetchedAt }) => [
      remoteId,
      fetchedAt,
    ]),
  );
  return repositorySnapshotSchema.parse({
    kind: 'repository',
    repositoryId: source.repositoryId,
    repositoryRevision: source.repositoryRevision,
    topologyRevision: source.topologyRevision,
    refsRevision: source.refsRevision,
    displayName: displayName(repositoryPath),
    path: repositoryPath,
    refresh: refresh(source.refresh),
    fetch: source.fetch,
    fetchAvailable: source.remotes.length > 0,
    worktrees: source.worktrees.map((candidate) =>
      worktree(
        candidate,
        candidate.upstream.kind === 'tracking'
          ? (remoteFetches.get(candidate.upstream.remoteId) ?? null)
          : lastSuccessfulFetchAt(source.fetch),
        hostNavigation,
      ),
    ),
    remotes: source.remotes.map(({ remoteId, displayName, host }) => ({
      remoteId,
      displayName,
      host,
    })),
    operations: source.operations.map((operation) => ({
      operationId: operation.operationId,
      category: operation.category,
      phase: operation.phase,
      progress: operation.progress,
    })),
  });
}

function worktree(
  source: PublishedWorktreeSnapshot,
  fetchedAt: string | null,
  hostNavigation: HostNavigationContext,
) {
  const path = source.canonicalPath ?? source.displayPath;
  return {
    worktreeId: source.worktreeId,
    worktreeRevision: source.worktreeRevision,
    generation: source.generation,
    role: source.role,
    displayName: displayName(path),
    path,
    availability:
      source.availability.kind === 'available'
        ? source.availability
        : {
            kind: source.availability.kind,
            reason: source.availability.reason,
          },
    freshness: worktreeFreshness(source),
    head:
      source.head.kind === 'detached'
        ? source.head
        : source.head.objectId === null
          ? { kind: 'initial' as const }
          : {
              kind: 'local_branch' as const,
              displayName: source.head.displayName,
              objectId: source.head.objectId,
            },
    indexTree: null,
    status: worktreeStatus(source),
    provenance:
      source.provenance.kind === 'codex_task'
        ? {
            kind: source.provenance.kind,
            title: source.provenance.task.title,
            status: source.provenance.task.status,
          }
        : source.provenance,
    upstream: upstream(source, fetchedAt),
    changes: source.changes.map(
      ({
        fileId,
        kind,
        baseline,
        displayPath,
        previousDisplayPath,
        nativeTargetId,
      }) => ({
        fileId,
        kind,
        baseline,
        displayPath,
        previousDisplayPath,
        nativeTargets: [
          nativeFileTarget(source, nativeTargetId, fileId, hostNavigation),
        ],
      }),
    ),
    nativeTargets:
      source.nativeTargetId === null
        ? []
        : [
            {
              targetId: source.nativeTargetId,
              actions: worktreeNativeActions(source, hostNavigation),
            },
          ],
  };
}

function nativeFileTarget(
  worktree: PublishedWorktreeSnapshot,
  targetId: PublishedWorktreeSnapshot['changes'][number]['nativeTargetId'],
  fileId: PublishedWorktreeSnapshot['changes'][number]['fileId'],
  hostNavigation: HostNavigationContext,
) {
  const change = worktree.changes.find(
    (candidate) => candidate.fileId === fileId,
  )!;
  let pathIsUtf8 = true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(change.pathBytes);
  } catch {
    pathIsUtf8 = false;
  }
  return {
    targetId,
    actions: fileNativeActions(
      worktree,
      pathIsUtf8,
      change.workingFilePresent,
      hostNavigation,
    ),
  };
}

function worktreeNativeActions(
  worktree: PublishedWorktreeSnapshot,
  hostNavigation: HostNavigationContext,
) {
  const path = worktree.canonicalPath ?? worktree.displayPath;
  const copyActions = [
    ...(isAbsolute(path) ? (['copy_absolute_path'] as const) : []),
    'copy_branch_or_sha' as const,
  ];
  const hostActions =
    hostNavigation.openCodexContext &&
    hostContextMatches(worktree, hostNavigation)
      ? (['open_codex_context'] as const)
      : [];
  return worktree.canonicalPath !== null &&
    worktree.availability.kind === 'available'
    ? ([
        'open_terminal',
        'reveal_in_finder',
        ...hostActions,
        ...copyActions,
      ] as const)
    : [...hostActions, ...copyActions];
}

function fileNativeActions(
  worktree: PublishedWorktreeSnapshot,
  pathIsUtf8: boolean,
  workingFilePresent: boolean,
  hostNavigation: HostNavigationContext,
) {
  if (!pathIsUtf8) return ['copy_relative_path'] as const;
  const copyActions = [
    'copy_relative_path' as const,
    ...(worktree.canonicalPath === null
      ? []
      : (['copy_absolute_path'] as const)),
  ];
  return workingFilePresent && worktree.canonicalPath !== null
    ? ([
        'open_default_app',
        'reveal_in_finder',
        ...(hostNavigation.openFileInCodex &&
        hostContextMatches(worktree, hostNavigation)
          ? (['open_file_in_codex'] as const)
          : []),
        ...copyActions,
      ] as const)
    : copyActions;
}

function hostContextMatches(
  worktree: PublishedWorktreeSnapshot,
  hostNavigation: HostNavigationContext,
): boolean {
  return (
    (worktree.provenance.kind === 'codex_task' &&
      worktree.provenance.task.id === hostNavigation.taskId) ||
    (worktree.canonicalPath !== null &&
      worktree.canonicalPath === hostNavigation.canonicalProjectPath)
  );
}

function refresh(source: RefreshState) {
  if (source.kind === 'fresh') return { kind: 'current' as const };
  return { kind: source.kind, message: source.error.message } as const;
}

function worktreeFreshness(source: PublishedWorktreeSnapshot) {
  switch (source.freshness.kind) {
    case 'fresh':
      return { kind: 'current' as const };
    case 'stale':
    case 'failed':
      return {
        kind: source.freshness.kind,
        message: source.freshness.error.message,
      } as const;
    case 'unavailable':
      return {
        kind: 'failed' as const,
        message:
          source.availability.kind === 'unavailable'
            ? source.availability.reason
            : 'The Worktree is unavailable.',
      };
  }
}

function worktreeStatus(source: PublishedWorktreeSnapshot) {
  if (source.status === null) {
    return {
      kind: 'unavailable' as const,
      reason:
        source.availability.kind === 'unavailable'
          ? source.availability.reason
          : 'The Worktree status is unavailable.',
    };
  }
  if (source.status.inProgressOperation !== undefined) {
    return {
      kind: 'in_progress' as const,
      operation: source.status.inProgressOperation,
    };
  }
  if (source.status.clean) return { kind: 'clean' as const };
  return {
    kind: 'changed' as const,
    conflictCount: source.status.conflicted,
    stagedCount: source.status.staged,
    trackedChangeCount: source.status.unstaged,
    untrackedCount: source.status.untracked,
  };
}

function upstream(source: PublishedWorktreeSnapshot, fetchedAt: string | null) {
  switch (source.upstream.kind) {
    case 'tracking':
      return {
        kind: 'tracking' as const,
        displayName: source.upstream.displayName,
        ahead:
          source.upstream.aheadBehind.kind === 'cached'
            ? source.upstream.aheadBehind.ahead
            : null,
        behind:
          source.upstream.aheadBehind.kind === 'cached'
            ? source.upstream.aheadBehind.behind
            : null,
        fetchedAt,
      };
    case 'unpublished':
      return {
        kind: 'unpublished' as const,
        remoteName: null,
        fetchedAt,
      };
    case 'not_applicable':
      return {
        kind: 'not-applicable' as const,
        reason:
          source.upstream.reason === 'detached_head'
            ? 'Detached HEAD has no Upstream.'
            : 'The configured Upstream is unsupported.',
      };
    case 'unavailable':
      return {
        kind: 'unavailable' as const,
        reason: 'The Upstream is temporarily unavailable.',
      };
  }
}

function lastSuccessfulFetchAt(
  fetch: import('@codex-git/repository-engine').FetchState,
): string | null {
  return fetch.kind === 'never' ? null : fetch.fetchedAt;
}

function displayName(path: string): string {
  return basename(path) || path;
}
