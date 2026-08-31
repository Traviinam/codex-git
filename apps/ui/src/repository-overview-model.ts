import type {
  DiffResult,
  CommitDraft,
  FileId,
  NativeActionRequest,
  NativeActionResult,
  BranchSearchResult,
  OperationResult,
  OperationId,
  RefId,
  RemoteId,
  RepositorySnapshot,
} from '@codex-git/protocol';

type ProtocolWorktree = RepositorySnapshot['worktrees'][number];
type ProtocolOperation = RepositorySnapshot['operations'][number];
type ProtocolRemote = RepositorySnapshot['remotes'][number];

export type FetchFreshness =
  | { readonly kind: 'never' }
  | { readonly kind: 'current'; readonly fetchedAt: string }
  | {
      readonly kind: 'stale';
      readonly fetchedAt: string | null;
      readonly message: string;
    }
  | {
      readonly kind: 'failed';
      readonly fetchedAt: string | null;
      readonly message: string;
    };

export type UpstreamOverview =
  | {
      readonly kind: 'tracking';
      readonly displayName: string;
      readonly ahead: number | null;
      readonly behind: number | null;
      readonly fetchedAt: string | null;
    }
  | {
      readonly kind: 'unpublished';
      readonly remoteName: string | null;
      readonly fetchedAt: string | null;
    }
  | { readonly kind: 'not-applicable'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface WorktreeOverviewSnapshot {
  readonly worktreeId: ProtocolWorktree['worktreeId'];
  readonly worktreeRevision: ProtocolWorktree['worktreeRevision'];
  readonly generation: ProtocolWorktree['generation'];
  readonly role: 'main' | 'linked';
  readonly displayName: string;
  readonly path: string;
  readonly availability?: ProtocolWorktree['availability'];
  readonly provenance: ProtocolWorktree['provenance'];
  readonly freshness: ProtocolWorktree['freshness'];
  readonly head: ProtocolWorktree['head'];
  readonly status: ProtocolWorktree['status'];
  readonly changes: ProtocolWorktree['changes'];
  readonly nativeTargets: ProtocolWorktree['nativeTargets'];
  readonly upstream: UpstreamOverview;
  readonly transition?: {
    readonly label: string;
    readonly progress: number | null;
  };
}

export interface RepositoryOverviewSnapshot {
  readonly repositoryId: RepositorySnapshot['repositoryId'];
  readonly repositoryRevision: RepositorySnapshot['repositoryRevision'];
  readonly topologyRevision: RepositorySnapshot['topologyRevision'];
  readonly refsRevision: RepositorySnapshot['refsRevision'];
  readonly displayName: string;
  readonly path: string;
  readonly refresh: RepositorySnapshot['refresh'];
  readonly fetch: FetchFreshness;
  readonly fetchAvailable?: boolean;
  readonly remotes: readonly ProtocolRemote[];
  readonly operations: readonly ProtocolOperation[];
  readonly fetchResult?: OperationResult;
  readonly worktrees: readonly WorktreeOverviewSnapshot[];
}

export type RepositoryOverviewSourceState =
  | { readonly kind: 'loading'; readonly message: string }
  | {
      readonly kind: 'non-repository';
      readonly projectPath: string;
      readonly message: string;
    }
  | {
      readonly kind: 'failed';
      readonly projectPath: string;
      readonly message: string;
    }
  | {
      readonly kind: 'repository';
      readonly snapshot: RepositoryOverviewSnapshot;
    };

export interface RepositoryOverviewSource {
  getSnapshot(): RepositoryOverviewSourceState;
  subscribe(listener: () => void): () => void;
  requestRefresh(): void;
  requestFetch(remoteId: ProtocolRemote['remoteId'] | null): void;
  requestDiff(fileId: FileId): Promise<DiffResult>;
  requestNativeAction(
    request: NativeActionRequest,
  ): Promise<NativeActionResult>;
  mutateFiles(request: {
    readonly kind: 'stage' | 'unstage';
    readonly worktreeId: ProtocolWorktree['worktreeId'];
    readonly expectedWorktreeRevision: number;
    readonly fileIds: readonly FileId[];
  }): Promise<OperationResult>;
  getCommitDraft(
    worktreeId: ProtocolWorktree['worktreeId'],
  ): Promise<CommitDraft>;
  updateCommitDraft(request: {
    readonly worktreeId: ProtocolWorktree['worktreeId'];
    readonly expectedRevision: number;
    readonly update:
      | { readonly kind: 'set'; readonly text: string }
      | { readonly kind: 'clear' };
  }): Promise<CommitDraft>;
  commit(
    request: {
      readonly worktreeId: ProtocolWorktree['worktreeId'];
      readonly expectedWorktreeRevision: number;
      readonly draftRevision: number;
      readonly confirmDetachedHead: boolean;
    },
    onAccepted?: (operationId: OperationId) => void,
  ): Promise<OperationResult>;
  cancelOperation(operationId: OperationId): Promise<OperationResult>;
  recoverOperation(operationId: OperationId): Promise<OperationResult>;
  searchBranches(
    worktreeId: ProtocolWorktree['worktreeId'],
    query: string,
  ): Promise<BranchSearchResult>;
  switchBranch(request: {
    readonly worktreeId: ProtocolWorktree['worktreeId'];
    readonly expectedWorktreeRevision: number;
    readonly expectedRefsRevision: number;
    readonly refId: RefId;
  }): Promise<OperationResult>;
  requestRemoteOperation(request: {
    readonly kind: 'pull' | 'push' | 'publish';
    readonly worktreeId: ProtocolWorktree['worktreeId'];
    readonly expectedWorktreeRevision: number;
    readonly expectedRefsRevision: number;
    readonly remoteId?: RemoteId;
  }): Promise<OperationResult>;
}
