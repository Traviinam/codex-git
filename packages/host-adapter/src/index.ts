export interface SurfaceDescriptor {
  readonly title: string;
  readonly url: URL;
}

export interface HostContext {
  readonly projectPath: string | null;
  readonly task: HostTaskContext | null;
  readonly theme: 'dark' | 'light' | 'system';
}

export interface HostTaskContext {
  readonly id: string;
  readonly title: string;
}

export type NativeHostAction =
  | { readonly kind: 'restore-native-surface' }
  | {
      readonly kind: 'open-codex-context' | 'open-file-in-codex';
      readonly targetId: string;
    };

const nativeTargetPattern = /^native_[0-9a-f]{32}$/u;

export function isNativeHostAction(value: unknown): value is NativeHostAction {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'restore-native-surface') {
    return Object.keys(candidate).length === 1;
  }
  return (
    (candidate.kind === 'open-codex-context' ||
      candidate.kind === 'open-file-in-codex') &&
    typeof candidate.targetId === 'string' &&
    nativeTargetPattern.test(candidate.targetId) &&
    Object.keys(candidate).length === 2
  );
}

export interface NativeActionResult {
  readonly status: 'succeeded' | 'rejected' | 'unsupported';
}

export interface HostCapabilities {
  readonly openCodexContext: boolean;
  readonly openFileInCodex: boolean;
}

export interface SanitizedDiagnostic {
  readonly code: 'attach-failed' | 'host-unavailable' | 'incompatible-host';
  readonly message: string;
}

export interface HostAdapter {
  attach(surface: SurfaceDescriptor): Promise<HostAttachResult>;
}

export type HostAttachResult =
  | { readonly kind: 'attached'; readonly connection: HostConnection }
  | {
      readonly kind: 'standalone-required';
      readonly reason: SanitizedDiagnostic;
    };

export interface HostConnection {
  capabilities(): HostCapabilities;
  currentContext(): HostContext;
  contexts(): AsyncIterable<HostContext>;
  transitions(): AsyncIterable<HostTransition>;
  perform(action: NativeHostAction): Promise<NativeActionResult>;
  close(): Promise<void>;
}

export type HostTransition = {
  readonly kind: 'standalone-required';
  readonly reason: SanitizedDiagnostic;
};
