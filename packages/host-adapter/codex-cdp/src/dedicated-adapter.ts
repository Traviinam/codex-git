import type {
  HostAdapter,
  HostAttachResult,
  HostConnection,
  HostContext,
  HostTransition,
  NativeActionResult,
  NativeHostAction,
  SurfaceDescriptor,
} from '@codex-git/host-adapter';

import { AsyncStream } from './async-stream.js';
import {
  isDedicatedCodexTargetBoundToEndpoint,
  type DedicatedCodexInstance,
  type DedicatedCodexOwnership,
  type DedicatedCodexTarget,
} from './dedicated-instance.js';

export type DedicatedRendererEvent =
  | { readonly kind: 'context'; readonly context: HostContext }
  | { readonly kind: 'standalone-required' };

export interface DedicatedProjectIdentity {
  readonly id: string;
  readonly label: string;
}

export interface DedicatedRendererConnection {
  currentContext(): HostContext;
  isSurfaceOpen(): boolean;
  projectIdentity(): DedicatedProjectIdentity;
  subscribe(listener: (event: DedicatedRendererEvent) => void): () => void;
  perform(action: NativeHostAction): Promise<NativeActionResult>;
  close(): Promise<void>;
}

export interface ConnectDedicatedRendererRequest {
  readonly build: string;
  readonly expectedProject: DedicatedProjectIdentity | null;
  readonly openSurface: boolean;
  readonly ownership: DedicatedCodexOwnership;
  readonly projectPath: string;
  readonly surface: SurfaceDescriptor;
  readonly target: DedicatedCodexTarget;
  readonly version: string;
}

export type ConnectDedicatedRenderer = (
  request: ConnectDedicatedRendererRequest,
) => Promise<DedicatedRendererConnection>;

export interface DedicatedCodexHostAdapterOptions {
  readonly connectRenderer: ConnectDedicatedRenderer;
  readonly instance: DedicatedCodexInstance;
  readonly projectPath: string;
}

export class DedicatedCodexHostAdapter implements HostAdapter {
  constructor(private readonly options: DedicatedCodexHostAdapterOptions) {}

  async attach(surface: SurfaceDescriptor): Promise<HostAttachResult> {
    const target = await this.options.instance.currentTarget();
    if (
      target === null ||
      !isDedicatedCodexTargetBoundToEndpoint(
        target,
        this.options.instance.ownership.endpoint,
      )
    ) {
      return standaloneRequired(
        'host-unavailable',
        'The dedicated Codex renderer was unavailable; use the standalone surface.',
      );
    }

    try {
      const renderer = await this.options.connectRenderer({
        build: this.options.instance.build,
        expectedProject: null,
        openSurface: false,
        ownership: this.options.instance.ownership,
        projectPath: this.options.projectPath,
        surface,
        target,
        version: this.options.instance.version,
      });
      return {
        kind: 'attached',
        connection: new ManagedDedicatedConnection(
          renderer,
          surface,
          this.options,
        ),
      };
    } catch {
      return standaloneRequired(
        'attach-failed',
        'The dedicated Codex renderer could not be attached; use the standalone surface.',
      );
    }
  }
}

class ManagedDedicatedConnection implements HostConnection {
  private closed = false;
  private closeAttempt: Promise<void> | null = null;
  private context: HostContext;
  private readonly contextStream = new AsyncStream<HostContext>();
  private degraded = false;
  private readonly project: DedicatedProjectIdentity;
  private renderer: DedicatedRendererConnection;
  private rendererSubscription: () => void;
  private replacement = Promise.resolve();
  private readonly sourceSubscription: () => void;
  private readonly transitionStream = new AsyncStream<HostTransition>();

  constructor(
    renderer: DedicatedRendererConnection,
    private readonly surface: SurfaceDescriptor,
    private readonly options: DedicatedCodexHostAdapterOptions,
  ) {
    this.renderer = renderer;
    this.project = renderer.projectIdentity();
    this.context = renderer.currentContext();
    this.rendererSubscription = renderer.subscribe(this.handleRendererEvent);
    this.sourceSubscription = options.instance.subscribe((target) => {
      this.replacement = this.replacement.then(() => this.replace(target));
    });
  }

  currentContext(): HostContext {
    return this.context;
  }

  contexts(): AsyncIterable<HostContext> {
    return this.contextStream.read(this.context);
  }

  transitions(): AsyncIterable<HostTransition> {
    return this.transitionStream.read();
  }

  perform(action: NativeHostAction): Promise<NativeActionResult> {
    if (this.closed || this.degraded) {
      return Promise.resolve({ status: 'rejected' });
    }
    return this.renderer.perform(action);
  }

  close(): Promise<void> {
    this.closeAttempt ??= this.closeOnce().catch((error: unknown) => {
      this.closeAttempt = null;
      throw error;
    });
    return this.closeAttempt;
  }

  private async replace(target: DedicatedCodexTarget | null): Promise<void> {
    if (this.closed || this.degraded) {
      return;
    }
    if (
      target === null ||
      !isDedicatedCodexTargetBoundToEndpoint(
        target,
        this.options.instance.ownership.endpoint,
      )
    ) {
      await this.degrade('host-unavailable');
      return;
    }

    const reopen = this.renderer.isSurfaceOpen();
    this.rendererSubscription();
    await this.renderer.close().catch(() => undefined);
    try {
      const renderer = await this.options.connectRenderer({
        build: this.options.instance.build,
        expectedProject: this.project,
        openSurface: reopen,
        ownership: this.options.instance.ownership,
        projectPath: this.options.projectPath,
        surface: this.surface,
        target,
        version: this.options.instance.version,
      });
      this.renderer = renderer;
      this.context = renderer.currentContext();
      this.rendererSubscription = renderer.subscribe(this.handleRendererEvent);
      this.contextStream.publish(this.context);
    } catch {
      await this.degrade('attach-failed');
    }
  }

  private readonly handleRendererEvent = (event: DedicatedRendererEvent) => {
    if (this.closed || this.degraded) {
      return;
    }
    if (event.kind === 'context') {
      this.context = event.context;
      this.contextStream.publish(event.context);
      return;
    }
    void this.degrade('incompatible-host');
  };

  private async degrade(
    code: 'attach-failed' | 'host-unavailable' | 'incompatible-host',
  ): Promise<void> {
    if (this.degraded || this.closed) {
      return;
    }
    this.degraded = true;
    this.sourceSubscription();
    this.rendererSubscription();
    await this.renderer.close().catch(() => undefined);
    this.transitionStream.publish({
      kind: 'standalone-required',
      reason: {
        code,
        message:
          'The dedicated Codex renderer became unavailable; use the standalone surface.',
      },
    });
  }

  private async closeOnce(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.sourceSubscription();
      this.rendererSubscription();
      await this.replacement;
    }
    await this.renderer.close();
    this.contextStream.close();
    this.transitionStream.close();
  }
}

function standaloneRequired(
  code: 'attach-failed' | 'host-unavailable',
  message: string,
): HostAttachResult {
  return {
    kind: 'standalone-required',
    reason: { code, message },
  };
}
