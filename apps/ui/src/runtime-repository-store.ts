import { createProtocolRepositorySource } from './protocol-repository-source.js';
import {
  createRepositoryStore,
  type RepositoryStore,
} from './repository-store.js';

export interface ProtocolBootstrap {
  readonly projectPath: string;
  readonly sessionUrl: string;
}

export function createRuntimeRepositoryStore(
  bootstrap: ProtocolBootstrap,
): RepositoryStore {
  return createRepositoryStore(createProtocolRepositorySource(bootstrap));
}

export function readProtocolBootstrap(): ProtocolBootstrap | undefined {
  const value: unknown = globalThis.__CODEX_GIT_PROTOCOL__;
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('projectPath' in value) || !('sessionUrl' in value)) return undefined;
  return typeof value.projectPath === 'string' &&
    value.projectPath.length > 0 &&
    typeof value.sessionUrl === 'string' &&
    value.sessionUrl.length > 0
    ? { projectPath: value.projectPath, sessionUrl: value.sessionUrl }
    : undefined;
}

declare global {
  // The standalone runtime injects this value before the UI module loads.
  var __CODEX_GIT_PROTOCOL__: unknown;
}
