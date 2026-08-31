import type {
  HostConnection,
  HostContext,
  NativeActionResult,
  NativeHostAction,
  SurfaceDescriptor,
} from '@codex-git/host-adapter';
import { isNativeHostAction } from '@codex-git/host-adapter';

import type { CompatibleCodexAnchors } from './compatibility.js';
import type { CodexRenderer, CspBypassLease } from './renderer.js';

interface ActiveFrame {
  readonly capability: string;
  readonly challenge: string;
  readonly frame: HTMLIFrameElement;
  readonly generation: number;
}

export class CodexHostConnection implements HostConnection {
  private closed = false;
  private closeAttempt: Promise<void> | null = null;
  private closeNotified = false;
  private activeFrame: ActiveFrame | null = null;
  private context: HostContext;
  private readonly contextClosers = new Set<() => void>();
  private readonly contextSubscribers = new Set<
    (context: HostContext) => void
  >();
  private readonly gitEntry: HTMLButtonElement;
  private readonly gitEntryHost: HTMLElement | null;
  private frameGeneration = 0;
  private readonly mainSurface: HTMLElement;
  private mountedSurface: HTMLElement | null = null;
  private readonly originalMainHidden: boolean;
  private readonly sidebar: HTMLElement;
  private unsubscribeContext: () => void = () => undefined;

  constructor(
    private readonly renderer: CodexRenderer,
    private cspBypass: CspBypassLease | null,
    anchors: CompatibleCodexAnchors,
    private readonly surface: SurfaceDescriptor,
    private readonly createSecret: () => string,
    private readonly onClose: () => void,
  ) {
    const { document } = renderer;
    this.sidebar = anchors.sidebar;
    this.mainSurface = anchors.mainSurface;
    this.originalMainHidden = anchors.mainSurface.hidden;
    this.context = renderer.currentContext();
    if (
      !anchors.sidebar.isConnected ||
      !anchors.mainSurface.isConnected ||
      anchors.sidebar.ownerDocument !== document ||
      anchors.mainSurface.ownerDocument !== document
    ) {
      throw new Error('Compatible Codex anchors disappeared before attachment');
    }

    this.gitEntry = document.createElement('button');
    this.gitEntry.dataset.codexGitSidebarEntry = '';
    this.gitEntry.type = 'button';
    this.gitEntry.textContent = 'Git';
    this.gitEntry.setAttribute('aria-label', 'Open Codex Git');
    this.gitEntry.className = anchors.nativeEntry.className;
    this.gitEntryHost =
      anchors.entryInsertionAnchor === null
        ? null
        : document.createElement(
            anchors.entryInsertionAnchor.tagName.toLowerCase(),
          );
    if (this.gitEntryHost !== null && anchors.entryInsertionAnchor !== null) {
      this.gitEntryHost.dataset.codexGitSidebarEntryHost = '';
      this.gitEntryHost.className = anchors.entryInsertionAnchor.className;
      this.gitEntryHost.append(this.gitEntry);
    }
    try {
      this.unsubscribeContext = renderer.subscribeContext(this.handleContext);
      this.gitEntry.addEventListener('click', this.openGitSurface);
      this.sidebar.addEventListener(
        'click',
        this.handleSidebarNavigation,
        true,
      );
      renderer.window.addEventListener('message', this.handleFrameMessage);
      if (this.gitEntryHost !== null && anchors.entryInsertionAnchor !== null) {
        anchors.entryInsertionAnchor.before(this.gitEntryHost);
      } else {
        this.sidebar.append(this.gitEntry);
      }
    } catch (error) {
      this.unsubscribeContext();
      this.gitEntry.removeEventListener('click', this.openGitSurface);
      this.sidebar.removeEventListener(
        'click',
        this.handleSidebarNavigation,
        true,
      );
      renderer.window.removeEventListener('message', this.handleFrameMessage);
      (this.gitEntryHost ?? this.gitEntry).remove();
      throw error;
    }
  }

  currentContext(): HostContext {
    return this.context;
  }

  capabilities() {
    return { openCodexContext: true, openFileInCodex: false } as const;
  }

  async *contexts(): AsyncIterable<HostContext> {
    const queue = [this.currentContext()];
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

  async *transitions(): AsyncIterable<never> {}

  async perform(action: NativeHostAction): Promise<NativeActionResult> {
    if (this.closed) {
      return { status: 'rejected' };
    }

    switch (action.kind) {
      case 'restore-native-surface':
        this.restoreNativeSurface();
        return { status: 'succeeded' };
      case 'open-codex-context':
        this.restoreNativeSurface();
        return { status: 'succeeded' };
      case 'open-file-in-codex':
        return { status: 'unsupported' };
    }
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

  private async closeOnce(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.unsubscribeContext();
      this.contextClosers.forEach((close) => close());
      this.contextClosers.clear();
      this.contextSubscribers.clear();
      this.gitEntry.removeEventListener('click', this.openGitSurface);
      this.sidebar.removeEventListener(
        'click',
        this.handleSidebarNavigation,
        true,
      );
      this.renderer.window.removeEventListener(
        'message',
        this.handleFrameMessage,
      );
      (this.gitEntryHost ?? this.gitEntry).remove();
      this.removeMountedSurface();
      this.mainSurface.hidden = this.originalMainHidden;
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

  isGitSurfaceOpen(): boolean {
    return this.activeFrame !== null;
  }

  showGitSurface(): void {
    if (this.closed) {
      return;
    }

    this.restoreNativeSurface();
    const { document } = this.renderer;
    const host = document.createElement('main');
    host.dataset.codexGitSurface = '';
    host.setAttribute('aria-label', this.surface.title);
    Object.assign(host.style, {
      display: 'flex',
      flex: '1 1 auto',
      minHeight: '0',
      minWidth: '0',
      overflow: 'hidden',
    });

    const frame = document.createElement('iframe');
    frame.src = this.surface.url.href;
    frame.title = this.surface.title;
    frame.setAttribute('sandbox', 'allow-scripts');
    Object.assign(frame.style, {
      border: '0',
      height: '100%',
      width: '100%',
    });
    const activeFrame = {
      capability: this.createSecret(),
      challenge: this.createSecret(),
      frame,
      generation: ++this.frameGeneration,
    };
    frame.addEventListener('load', this.publishHostContext);
    try {
      host.append(frame);
      this.mainSurface.after(host);
      this.activeFrame = activeFrame;
      this.mountedSurface = host;
      this.mainSurface.hidden = true;
      this.gitEntry.setAttribute('aria-current', 'page');
    } catch (error) {
      frame.removeEventListener('load', this.publishHostContext);
      host.remove();
      this.mainSurface.hidden = this.originalMainHidden;
      throw error;
    }
  }

  private readonly openGitSurface = () => {
    this.showGitSurface();
  };

  private readonly handleSidebarNavigation = (event: Event) => {
    const target = event.target;
    if (
      target instanceof this.renderer.window.Node &&
      this.gitEntry.contains(target)
    ) {
      return;
    }

    this.restoreNativeSurface();
  };

  private readonly handleFrameMessage = (event: MessageEvent) => {
    const activeFrame = this.activeFrame;
    if (
      activeFrame === null ||
      event.source !== activeFrame.frame.contentWindow ||
      !isHostActionMessage(event.data) ||
      event.data.capability !== activeFrame.capability ||
      event.data.challenge !== activeFrame.challenge ||
      event.data.generation !== activeFrame.generation
    ) {
      return;
    }

    void this.perform(event.data.action);
  };

  private readonly handleContext = (context: HostContext) => {
    if (this.closed) {
      return;
    }

    this.context = context;
    this.contextSubscribers.forEach((publish) => publish(context));
    this.publishHostContext();
  };

  private readonly publishHostContext = () => {
    const activeFrame = this.activeFrame;
    activeFrame?.frame.contentWindow?.postMessage(
      {
        capability: activeFrame.capability,
        challenge: activeFrame.challenge,
        context: this.currentContext(),
        generation: activeFrame.generation,
        type: 'codex-git:host-context',
      },
      '*',
    );
  };

  private restoreNativeSurface(): void {
    this.removeMountedSurface();
    this.mainSurface.hidden = this.originalMainHidden;
    this.gitEntry.removeAttribute('aria-current');
  }

  private removeMountedSurface(): void {
    this.activeFrame?.frame.removeEventListener(
      'load',
      this.publishHostContext,
    );
    this.activeFrame = null;
    this.mountedSurface?.remove();
    this.mountedSurface = null;
  }
}

function isHostActionMessage(value: unknown): value is {
  readonly action: NativeHostAction;
  readonly capability: string;
  readonly challenge: string;
  readonly generation: number;
  readonly type: 'codex-git:host-action';
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const action = candidate.action;
  return (
    candidate.type === 'codex-git:host-action' &&
    typeof candidate.capability === 'string' &&
    typeof candidate.challenge === 'string' &&
    Number.isSafeInteger(candidate.generation) &&
    isNativeHostAction(action) &&
    action.kind === 'restore-native-surface'
  );
}
