export interface SurfaceDescriptor {
  readonly title: string;
  readonly url: URL;
}

export interface HostContext {
  readonly projectPath: string | null;
  readonly theme: 'dark' | 'light' | 'system';
}

export type NativeHostAction = never;

export interface NativeActionResult {
  readonly status: 'completed' | 'unsupported';
}

export interface HostAdapter {
  attach(surface: SurfaceDescriptor): Promise<HostConnection>;
}

export interface HostConnection {
  contexts(): AsyncIterable<HostContext>;
  perform(action: NativeHostAction): Promise<NativeActionResult>;
  dispose(): Promise<void>;
}
