import type {
  HostAdapter,
  HostConnection,
  HostContext,
  NativeActionResult,
  SurfaceDescriptor,
} from '@codex-git/host-adapter';

const standaloneContext = {
  projectPath: null,
  theme: 'system',
} satisfies HostContext;

class StandaloneHostConnection implements HostConnection {
  async *contexts(): AsyncIterable<HostContext> {
    yield standaloneContext;
  }

  async perform(): Promise<NativeActionResult> {
    return { status: 'unsupported' };
  }

  async dispose(): Promise<void> {}
}

export class StandaloneHostAdapter implements HostAdapter {
  async attach(surface: SurfaceDescriptor): Promise<HostConnection> {
    void surface;
    return new StandaloneHostConnection();
  }
}
