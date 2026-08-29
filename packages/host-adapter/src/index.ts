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

export type NativeHostAction = { readonly kind: 'restore-native-surface' };

export interface NativeActionResult {
  readonly status: 'succeeded' | 'rejected' | 'unsupported';
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
