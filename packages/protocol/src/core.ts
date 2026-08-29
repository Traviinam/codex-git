export const PROTOCOL_VERSION = 1 as const;

export interface HealthResponse {
  readonly product: 'codex-git';
  readonly status: 'ok';
}

declare const absolutePathBrand: unique symbol;
export type AbsolutePath = string & { readonly [absolutePathBrand]: true };

export interface RepositoryRevision {
  readonly repositoryRevision: number;
}
