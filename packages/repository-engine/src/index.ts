import type {
  AbsolutePath,
  CommandEnvelope,
  OperationReceipt,
  RepositoryRevision,
  RepositorySnapshot,
} from '@codex-git/protocol';

export interface RepositoryEngine {
  open(anchor: AbsolutePath): Promise<RepositorySession>;
}

export interface RepositorySession {
  snapshot(): Promise<RepositorySnapshot>;
  subscribe(): AsyncIterable<RepositoryRevision>;
  dispatch(command: CommandEnvelope): Promise<OperationReceipt>;
  close(): Promise<void>;
}
