import type {
  HostConnection,
  HostContext,
  NativeActionResult,
  NativeHostAction,
  SurfaceDescriptor,
} from '@codex-git/host-adapter';

import { CodexHostConnection } from './connection.js';
import type {
  CodexRenderer,
  CodexRendererSource,
  CspBypassLease,
} from './renderer.js';

export class ManagedCodexHostConnection implements HostConnection {
  private closed = false;
  private closeAttempt: Promise<void> | null = null;
  private closeNotified = false;
  private context: HostContext;
  private readonly contextClosers = new Set<() => void>();
  private readonly contextSubscribers = new Set<
    (context: HostContext) => void
  >();
  private frameGeneration = 0;
  private mounted: CodexHostConnection | null;
  private cspBypass: CspBypassLease | null;
  private rendererContextSubscription: () => void;
  private replacement = Promise.resolve();
  private readonly sourceSubscription: () => void;

  constructor(
    renderer: CodexRenderer,
    cspBypass: CspBypassLease,
    source: CodexRendererSource,
    private readonly surface: SurfaceDescriptor,
    private readonly createSecret: () => string,
    private readonly compatible: (renderer: CodexRenderer) => boolean,
    private readonly onClose: () => void,
  ) {
    this.cspBypass = cspBypass;
    this.context = renderer.currentContext();
    this.rendererContextSubscription = renderer.subscribeContext(
      this.handleContext,
    );
    this.mounted = this.mount(renderer);
    this.sourceSubscription = source.subscribe((replacement) => {
      this.replacement = this.replacement
        .catch(() => undefined)
        .then(() => this.replaceRenderer(replacement));
    });
  }

  currentContext(): HostContext {
    return this.context;
  }

  async *contexts(): AsyncIterable<HostContext> {
    const queue = [this.context];
    let closed = this.closed;
    let wake: (() => void) | null = null;
    const publish = (context: HostContext) => {
      queue.push(context);
      wake?.();
    };
    const close = () => {
      closed = true;
      wake?.();
    };
    this.contextSubscribers.add(publish);
    this.contextClosers.add(close);

    try {
      while (!closed) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    } finally {
      this.contextSubscribers.delete(publish);
      this.contextClosers.delete(close);
    }
  }

  async perform(action: NativeHostAction): Promise<NativeActionResult> {
    if (this.closed || this.mounted === null) {
      return { status: 'rejected' };
    }
    return this.mounted.perform(action);
  }

  close(): Promise<void> {
    if (this.closeAttempt === null) {
      this.closeAttempt = this.closeOnce().catch((error: unknown) => {
        this.closeAttempt = null;
        throw error;
      });
    }
    return this.closeAttempt;
  }

  private readonly handleContext = (context: HostContext) => {
    if (this.closed) {
      return;
    }
    this.context = context;
    this.contextSubscribers.forEach((publish) => publish(context));
  };

  private mount(renderer: CodexRenderer): CodexHostConnection {
    return new CodexHostConnection(
      renderer,
      this.surface,
      this.createSecret,
      () => ++this.frameGeneration,
      () => undefined,
    );
  }

  private async closeOnce(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.sourceSubscription();
      this.rendererContextSubscription();
      this.contextClosers.forEach((close) => close());
      this.contextClosers.clear();
      this.contextSubscribers.clear();
      await this.replacement.catch(() => undefined);
      await this.mounted?.close();
      this.mounted = null;
    }

    if (this.cspBypass !== null) {
      await this.cspBypass.release();
      this.cspBypass = null;
    }
    if (!this.closeNotified) {
      this.closeNotified = true;
      this.onClose();
    }
  }

  private async replaceRenderer(renderer: CodexRenderer | null): Promise<void> {
    if (this.closed) {
      return;
    }

    const reopen = this.mounted?.isGitSurfaceOpen() ?? false;
    this.rendererContextSubscription();
    await this.mounted?.close();
    this.mounted = null;
    await this.cspBypass?.release();
    this.cspBypass = null;

    if (renderer === null || !this.compatible(renderer) || this.closed) {
      return;
    }

    try {
      this.cspBypass = await renderer.acquireCspBypass();
    } catch {
      return;
    }
    if (this.closed) {
      await this.cspBypass.release();
      this.cspBypass = null;
      return;
    }

    this.context = renderer.currentContext();
    this.contextSubscribers.forEach((publish) => publish(this.context));
    this.rendererContextSubscription = renderer.subscribeContext(
      this.handleContext,
    );
    this.mounted = this.mount(renderer);
    if (reopen) {
      this.mounted.showGitSurface();
    }
  }
}
