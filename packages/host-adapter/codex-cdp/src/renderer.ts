import type { HostContext } from '@codex-git/host-adapter';

export interface CspBypassLease {
  release(): Promise<void>;
}

export interface CodexRenderer {
  readonly document: Document;
  readonly id: string;
  readonly ownership: 'codex-git-dedicated';
  readonly version: string;
  readonly window: Window & typeof globalThis;
  acquireCspBypass(): Promise<CspBypassLease>;
  currentContext(): HostContext;
  subscribeContext(listener: (context: HostContext) => void): () => void;
}

export type CodexRendererSubscription = (
  renderer: CodexRenderer | null,
) => void;

export interface CodexRendererSource {
  current(): Promise<CodexRenderer | null>;
  subscribe(listener: CodexRendererSubscription): () => void;
}
