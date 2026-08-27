export const PROTOCOL_VERSION = 1 as const;

export interface HealthResponse {
  readonly product: 'codex-git';
  readonly status: 'ok';
}

declare const repositoryIdBrand: unique symbol;
declare const worktreeIdBrand: unique symbol;
declare const absolutePathBrand: unique symbol;
declare const operationIdBrand: unique symbol;

export type RepositoryId = string & { readonly [repositoryIdBrand]: true };
export type WorktreeId = string & { readonly [worktreeIdBrand]: true };
export type AbsolutePath = string & { readonly [absolutePathBrand]: true };
export type OperationId = string & { readonly [operationIdBrand]: true };

export interface RepositorySnapshot {
  readonly repositoryId: RepositoryId;
  readonly repositoryRevision: number;
}

export interface RepositoryRevision {
  readonly repositoryRevision: number;
}

export type CommandEnvelope = never;

export interface OperationReceipt {
  readonly operationId: OperationId;
}
