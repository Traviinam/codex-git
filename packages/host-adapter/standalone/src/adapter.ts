import type {
  HostAdapter,
  HostConnection,
  HostContext,
  NativeActionResult,
  SurfaceDescriptor,
} from '@codex-git/host-adapter';

const standaloneContext = {
  projectPath: null,
  task: null,
  theme: 'system',
} satisfies HostContext;

class StandaloneHostConnection implements HostConnection {
  currentContext(): HostContext {
    return standaloneContext;
  }

  async *contexts(): AsyncIterable<HostContext> {
    yield standaloneContext;
  }

  async perform(): Promise<NativeActionResult> {
    return { status: 'unsupported' };
  }

  async close(): Promise<void> {}
}

export class StandaloneHostAdapter implements HostAdapter {
  async attach(surface: SurfaceDescriptor) {
    void surface;
    return {
      kind: 'attached' as const,
      connection: new StandaloneHostConnection(),
    };
  }
}
