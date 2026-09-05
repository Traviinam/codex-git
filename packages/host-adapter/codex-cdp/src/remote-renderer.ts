import { randomUUID } from 'node:crypto';
import { loadFrameDocument } from './frame-document.js';

import type {
  HostContext,
  NativeActionResult,
  NativeHostAction,
} from '@codex-git/host-adapter';

import {
  connectCdpSession,
  type CdpEvent,
  type CdpSession,
} from './cdp-session.js';
import { acquireDedicatedRendererCspBypass } from './csp-bypass.js';
import {
  findCodexCompatibilityProfile,
  type CodexCompatibilityProfile,
} from './compatibility-profile.js';
import type {
  ConnectDedicatedRendererRequest,
  DedicatedProjectIdentity,
  DedicatedRendererConnection,
  DedicatedRendererEvent,
} from './dedicated-adapter.js';
import type { CspBypassLease } from './renderer.js';

export interface ConnectDedicatedCodexRendererOptions {
  readonly loadDocument?: () => Promise<string>;
  readonly connect?: (url: string) => Promise<CdpSession>;
  readonly createBindingName?: () => string;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export async function connectDedicatedCodexRenderer(
  request: ConnectDedicatedRendererRequest,
  options: ConnectDedicatedCodexRendererOptions = {},
): Promise<DedicatedRendererConnection> {
  const profile = findCodexCompatibilityProfile(request.version, request.build);
  if (profile === null) {
    throw new Error('Unsupported Codex Desktop version');
  }
  if (profile.documentInjection && options.loadDocument === undefined) {
    throw new Error('The embedded document loader is unavailable');
  }
  const session = await (options.connect ?? connectCdpSession)(
    request.target.webSocketUrl,
  );
  let lease: CspBypassLease | null = null;
  try {
    const browser = await session.send('Browser.getVersion');
    if (!isRecord(browser) || browser.product !== profile.chromiumProduct) {
      throw new Error('Unsupported Codex Desktop Chromium version');
    }
    await session.send('Runtime.enable');
    const bindingName =
      options.createBindingName?.() ??
      `__codexGitNotify_${randomUUID().replaceAll('-', '')}`;
    await session.send('Runtime.addBinding', { name: bindingName });
    lease = await acquireDedicatedRendererCspBypass(
      {
        send: (_rendererId, method, params) =>
          session.send(method, params).then(),
      },
      request.target.id,
      cspOwnershipScope(request),
    );
    let installation = await install(session, request, profile, bindingName, 1);
    for (
      let attempt = 0;
      installation.status === 'not-ready' && attempt < 100;
      attempt++
    ) {
      await (options.wait ?? wait)(100);
      installation = await install(session, request, profile, bindingName, 1);
    }
    if (installation.status !== 'attached') {
      throw new Error(
        installation.status === 'project-mismatch'
          ? 'The selected project does not match the launcher binding'
          : 'The dedicated Codex renderer is incompatible',
      );
    }
    const connection = new RemoteDedicatedRendererConnection(
      session,
      lease,
      request,
      profile,
      bindingName,
      installation,
      options.loadDocument,
    );
    lease = null;
    return connection;
  } catch (error) {
    await lease?.release().catch(() => undefined);
    await session.close().catch(() => undefined);
    throw error;
  }
}

interface AttachedInstallation {
  readonly context: HostContext;
  readonly open: boolean;
  readonly project: DedicatedProjectIdentity;
  readonly status: 'attached';
}

type Installation =
  | AttachedInstallation
  | { readonly status: 'incompatible' | 'not-ready' | 'project-mismatch' };

class RemoteDedicatedRendererConnection implements DedicatedRendererConnection {
  private closed = false;
  private closeAttempt: Promise<void> | null = null;
  private context: HostContext;
  private generation = 1;
  private readonly listeners = new Set<
    (event: DedicatedRendererEvent) => void
  >();
  private open: boolean;
  private refresh = Promise.resolve();
  private readonly project: DedicatedProjectIdentity;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly session: CdpSession,
    private cspLease: CspBypassLease | null,
    private readonly request: ConnectDedicatedRendererRequest,
    private readonly profile: CodexCompatibilityProfile,
    private readonly bindingName: string,
    installation: AttachedInstallation,
    private readonly loadDocument?: () => Promise<string>,
  ) {
    this.context = installation.context;
    this.open = installation.open;
    this.project = installation.project;
    this.unsubscribe = session.subscribe(this.handleCdpEvent);
    if (this.open) this.queueDocument();
  }

  currentContext(): HostContext {
    return this.context;
  }

  isSurfaceOpen(): boolean {
    return this.open;
  }

  projectIdentity(): DedicatedProjectIdentity {
    return this.project;
  }

  subscribe(listener: (event: DedicatedRendererEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async perform(action: NativeHostAction): Promise<NativeActionResult> {
    if (this.closed) {
      return { status: 'rejected' };
    }
    if (
      action.kind === 'open-codex-context' &&
      this.context.projectPath !== this.request.projectPath
    ) {
      return { status: 'rejected' };
    }
    if (
      action.kind === 'restore-native-surface' ||
      action.kind === 'open-codex-context'
    ) {
      await evaluate(this.session, 'globalThis.__codexGitBridge?.restore()');
      this.open = false;
      return { status: 'succeeded' };
    }
    return { status: 'unsupported' };
  }

  close(): Promise<void> {
    this.closeAttempt ??= this.closeOnce().catch((error: unknown) => {
      this.closeAttempt = null;
      throw error;
    });
    return this.closeAttempt;
  }

  private readonly handleCdpEvent = (event: CdpEvent) => {
    if (this.closed) {
      return;
    }
    if (event.method === 'Runtime.bindingCalled') {
      const params = isRecord(event.params) ? event.params : null;
      if (
        params?.name !== this.bindingName ||
        typeof params.payload !== 'string'
      ) {
        return;
      }
      const message = parseBridgeEvent(params.payload);
      if (message?.kind === 'context') {
        this.context = message.context;
        this.listeners.forEach((listener) => listener(message));
      } else if (message?.kind === 'surface') {
        this.open = message.open;
        if (this.open) this.queueDocument();
      } else if (message?.kind === 'standalone-required') {
        this.listeners.forEach((listener) => listener(message));
      }
      return;
    }
    if (event.method === 'Runtime.executionContextsCleared') {
      const reopen = this.open;
      this.refresh = this.refresh.then(() => this.reinstall(reopen));
      return;
    }
    if (event.method === 'CodexGit.sessionClosed') {
      this.listeners.forEach((listener) =>
        listener({ kind: 'standalone-required' }),
      );
    }
  };

  private queueDocument(): void {
    if (!this.profile.documentInjection || this.loadDocument === undefined)
      return;
    this.refresh = this.refresh.then(async () => {
      if (this.closed) return;
      try {
        await loadFrameDocument(
          this.session,
          this.loadDocument!,
          () => this.closed,
        );
      } catch {
        if (!this.closed)
          this.listeners.forEach((listener) =>
            listener({ kind: 'standalone-required' }),
          );
      }
    });
  }

  private async reinstall(reopen: boolean): Promise<void> {
    if (this.closed) {
      return;
    }
    const replacementRequest = {
      ...this.request,
      expectedProject: this.project,
      openSurface: reopen,
    };
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        await this.session.send('Page.setBypassCSP', { enabled: true });
        const installation = await install(
          this.session,
          replacementRequest,
          this.profile,
          this.bindingName,
          ++this.generation,
        );
        if (installation.status === 'attached') {
          this.context = installation.context;
          this.open = installation.open;
          if (this.open) this.queueDocument();
          this.listeners.forEach((listener) =>
            listener({ kind: 'context', context: this.context }),
          );
          return;
        }
        if (installation.status !== 'not-ready') break;
        await wait(100);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    this.listeners.forEach((listener) =>
      listener({ kind: 'standalone-required' }),
    );
  }

  private async closeOnce(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.unsubscribe();
      this.listeners.clear();
      await this.refresh;
    }
    let nativeCleanupFailed: boolean;
    try {
      const response = await evaluate(
        this.session,
        'globalThis.__codexGitBridge?.close()',
      );
      nativeCleanupFailed =
        isRecord(response) && response.exceptionDetails !== undefined;
    } catch {
      nativeCleanupFailed = true;
    }
    if (this.cspLease !== null) {
      await this.cspLease.release();
      this.cspLease = null;
    }
    if (nativeCleanupFailed)
      throw new Error('The native Codex surface could not be restored');
    await this.session.close();
  }
}

async function install(
  session: CdpSession,
  request: ConnectDedicatedRendererRequest,
  profile: CodexCompatibilityProfile,
  bindingName: string,
  generation: number,
): Promise<Installation> {
  const input: BridgeInput = {
    bindingName,
    documentInjection: profile.documentInjection === true,
    entryInsertionSelector: profile.entryInsertionSelector,
    expectedProject: request.expectedProject,
    generation,
    mainSurfaceSelector: profile.mainSurfaceSelector,
    nativeEntrySelector: profile.nativeEntrySelector,
    openSurface: request.openSurface,
    projectPath: request.projectPath,
    surfaceTitle: request.surface.title,
    surfaceUrl: request.surface.url.href,
    sidebarSelector: profile.sidebarSelector,
  };
  const response = await evaluate(
    session,
    `((__name)=>(${installDomBridge.toString()})(${JSON.stringify(input)}))((target)=>target)`,
  );
  if (isRecord(response) && isRecord(response.exceptionDetails)) {
    const exception = response.exceptionDetails.exception;
    throw new Error(
      isRecord(exception) && typeof exception.description === 'string'
        ? exception.description
        : typeof response.exceptionDetails.text === 'string'
          ? response.exceptionDetails.text
          : 'Dedicated Codex DOM bridge evaluation failed',
    );
  }
  const value =
    isRecord(response) && isRecord(response.result)
      ? response.result.value
      : null;
  return parseInstallation(value);
}

function evaluate(session: CdpSession, expression: string): Promise<unknown> {
  return session.send('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
}

function parseInstallation(value: unknown): Installation {
  if (!isRecord(value) || typeof value.status !== 'string') {
    return { status: 'incompatible' };
  }
  if (value.status === 'project-mismatch') {
    return { status: 'project-mismatch' };
  }
  if (value.status === 'not-ready') {
    return { status: 'not-ready' };
  }
  const context = parseHostContext(value.context);
  const project = parseProject(value.project);
  return value.status === 'attached' && context !== null && project !== null
    ? { context, open: value.open === true, project, status: 'attached' }
    : { status: 'incompatible' };
}

function parseBridgeEvent(
  payload: string,
):
  | DedicatedRendererEvent
  | { readonly kind: 'surface'; readonly open: boolean }
  | null {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return null;
  }
  if (value.kind === 'context') {
    const context = parseHostContext(value.context);
    return context === null ? null : { kind: 'context', context };
  }
  if (value.kind === 'surface') {
    return typeof value.open === 'boolean'
      ? { kind: 'surface', open: value.open }
      : null;
  }
  return value.kind === 'standalone-required'
    ? { kind: 'standalone-required' }
    : null;
}

function parseProject(value: unknown): DedicatedProjectIdentity | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0
  ) {
    return null;
  }
  return typeof value.label === 'string' && value.label.length > 0
    ? { id: value.id, label: value.label }
    : null;
}

function parseHostContext(value: unknown): HostContext | null {
  if (
    !isRecord(value) ||
    (value.projectPath !== null && typeof value.projectPath !== 'string')
  ) {
    return null;
  }
  if (
    value.theme !== 'dark' &&
    value.theme !== 'light' &&
    value.theme !== 'system'
  ) {
    return null;
  }
  const task = value.task;
  if (task === null) {
    return { projectPath: value.projectPath, task: null, theme: value.theme };
  }
  if (
    !isRecord(task) ||
    typeof task.id !== 'string' ||
    typeof task.title !== 'string'
  ) {
    return null;
  }
  return {
    projectPath: value.projectPath,
    task: { id: task.id, title: task.title },
    theme: value.theme,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function cspOwnershipScope(request: ConnectDedicatedRendererRequest): string {
  const { endpoint, instanceId, processId, profilePath } = request.ownership;
  return JSON.stringify([
    endpoint,
    instanceId,
    processId,
    profilePath,
    request.target.id,
  ]);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface BridgeInput {
  readonly documentInjection: boolean;
  readonly bindingName: string;
  readonly entryInsertionSelector: string | null;
  readonly expectedProject: DedicatedProjectIdentity | null;
  readonly generation: number;
  readonly mainSurfaceSelector: string;
  readonly nativeEntrySelector: string;
  readonly openSurface: boolean;
  readonly projectPath: string;
  readonly surfaceTitle: string;
  readonly surfaceUrl: string;
  readonly sidebarSelector: string;
}

// Kept self-contained because CDP serializes this function into the renderer.
// prettier-ignore
function installDomBridge(input: BridgeInput): unknown {
  const root = globalThis as typeof globalThis & { __codexGitBridge?: { close(): void; restore(): void; frameName(): string | null; expectDocument(name: string, nonce: string): void; documentReady(name: string): boolean } };
  root.__codexGitBridge?.close();
  const sidebars = document.querySelectorAll(input.sidebarSelector);
  const mainSurfaces = document.querySelectorAll(input.mainSurfaceSelector);
  const sidebar = sidebars.item(0);
  const main = mainSurfaces.item(0);
  const selectedProject = document.querySelector('[data-app-action-sidebar-project-row][aria-current="page"]');
  const boundRows = Array.from(document.querySelectorAll('[data-app-action-sidebar-project-row]')).filter((row) => row instanceof HTMLElement && row.dataset.appActionSidebarProjectId === input.expectedProject?.id && row.dataset.appActionSidebarProjectLabel === input.expectedProject?.label);
  const verifiedProject = selectedProject ?? (input.expectedProject !== null && boundRows.length === 1 ? boundRows[0] : null);
  const nativeEntry = sidebar?.querySelector(input.nativeEntrySelector);
  const entryInsertionAnchors = input.entryInsertionSelector === null ? null :
    sidebar?.querySelectorAll(input.entryInsertionSelector);
  const entryInsertionAnchor = entryInsertionAnchors?.item(0) ?? null;
  if (sidebars.length !== 1 || mainSurfaces.length !== 1 ||
      !(sidebar instanceof HTMLElement) || !(main instanceof HTMLElement) ||
      !(verifiedProject instanceof HTMLElement) ||
      !(nativeEntry instanceof HTMLButtonElement) ||
      (entryInsertionAnchors !== null && (entryInsertionAnchors.length !== 1 ||
        !(entryInsertionAnchor instanceof HTMLElement)))) {
    return { status: 'not-ready' };
  }
  const project = { id: verifiedProject.dataset.appActionSidebarProjectId ?? '',
    label: verifiedProject.dataset.appActionSidebarProjectLabel ?? '' };
  if (project.id.length === 0 || project.label.length === 0) return { status: 'incompatible' };
  if (input.expectedProject !== null && (project.id !== input.expectedProject.id ||
      project.label !== input.expectedProject.label)) {
    return { status: 'project-mismatch' };
  }
  const notify = (value: unknown) => {
    const binding = (root as Record<string, unknown>)[input.bindingName];
    if (typeof binding === 'function') (binding as (payload: string) => void)(JSON.stringify(value));
  };
  const secret = () => crypto.randomUUID();
  const entry = document.createElement('button');
  entry.type = 'button'; entry.dataset.codexGitSidebarEntry = ''; entry.textContent = 'Git';
  entry.setAttribute('aria-label', 'Open Codex Git');
  entry.className = nativeEntry.className;
  const entryHost = entryInsertionAnchor === null ? null :
    document.createElement(entryInsertionAnchor.tagName.toLowerCase());
  if (entryHost !== null && entryInsertionAnchor !== null) {
    entryHost.dataset.codexGitSidebarEntryHost = '';
    entryHost.className = entryInsertionAnchor.className;
    entryHost.append(entry);
  }
  let host: HTMLElement | null = null;
  let frame: HTMLIFrameElement | null = null;
  let capability = '', challenge = '', lastContext = '';
  let documentNonce = '', documentLoaded = false;
  const originalMainHidden = main.hidden;
  const context = () => {
    const selected = document.querySelector('[data-app-action-sidebar-project-row][aria-current="page"]');
    const projectMatches = selected instanceof HTMLElement && selected.dataset.appActionSidebarProjectId === project.id && selected.dataset.appActionSidebarProjectLabel === project.label;
    const taskRow = document.querySelector('[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-selected="true"], [data-app-action-sidebar-thread-row][aria-current="page"]');
    const task =
      projectMatches && taskRow instanceof HTMLElement &&
      typeof taskRow.dataset.appActionSidebarThreadId === 'string' &&
      typeof taskRow.dataset.appActionSidebarThreadTitle === 'string'
        ? { id: taskRow.dataset.appActionSidebarThreadId,
          title: taskRow.dataset.appActionSidebarThreadTitle } : null;
    const classes = document.documentElement.classList;
    const theme = classes.contains('electron-dark') ? 'dark' :
      classes.contains('electron-light') ? 'light' : 'system';
    return { projectPath: projectMatches ? input.projectPath : null, task, theme };
  };
  const publishContext = () => {
    const next = context();
    const serialized = JSON.stringify(next);
    if (serialized !== lastContext) { lastContext = serialized;
      notify({ kind: 'context', context: next }); }
    frame?.contentWindow?.postMessage({
      capability, challenge, context: next,
      generation: input.generation,
      type: 'codex-git:host-context',
    }, '*');
  };
  const restore = () => {
    frame = null; documentNonce = ''; documentLoaded = false; host?.remove(); host = null; main.hidden = originalMainHidden;
    entry.removeAttribute('aria-current');
    entry.style.removeProperty('background-color');
    notify({ kind: 'surface', open: false });
  };
  const open = () => {
    if (entry.disabled) return;
    restore();
    host = document.createElement('main');
    host.dataset.codexGitSurface = '';
    host.setAttribute('aria-label', input.surfaceTitle);
    host.style.cssText = 'display:flex;flex:1 1 auto;min-height:0;min-width:0;overflow:hidden';
    frame = document.createElement('iframe');
    frame.name = `codex-git-${secret()}`;
    frame.src = input.documentInjection ? 'about:blank' : input.surfaceUrl; frame.title = input.surfaceTitle;
    frame.setAttribute('sandbox', 'allow-scripts');
    Object.assign(frame.style, { border: '0', height: '100%', width: '100%' });
    capability = secret(); challenge = secret();
    frame.addEventListener('load', publishContext);
    host.append(frame);
    main.after(host);
    main.hidden = true; entry.setAttribute('aria-current', 'page');
    entry.style.backgroundColor = 'var(--color-primary-ghost-hover, rgba(127, 127, 127, 0.18))';
    notify({ kind: 'surface', open: true });
  };
  const handleSidebar = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && !entry.contains(target)) restore();
  };
  const handleMessage = (event: MessageEvent) => {
    const value = event.data;
    if (frame === null || event.source !== frame.contentWindow ||
        typeof value !== 'object' || value === null) return;
    const message = value as Record<string, unknown>;
    if (message.type === 'codex-git:document-ready' && documentNonce !== '' && message.nonce === documentNonce) { documentLoaded = true; publishContext(); return; }
    const action = message.action;
    if (message.type === 'codex-git:host-action' && message.capability === capability &&
        message.challenge === challenge && message.generation === input.generation &&
        typeof action === 'object' && action !== null &&
        (action as Record<string, unknown>).kind === 'restore-native-surface') restore();
  };
  const observer = new MutationObserver(() => {
    const currentProject = document.querySelector('[data-app-action-sidebar-project-row][aria-current="page"]');
    if (!sidebar.isConnected || !main.isConnected || !entry.isConnected ||
        (entryHost !== null && !entryHost.isConnected)) {
      notify({ kind: 'standalone-required' });
      return;
    }
    // Native task pages need not mark a project row as selected. Keep the
    // launcher's repository binding, but never attribute an unproven task.
    const differentProject = currentProject instanceof HTMLElement &&
      (currentProject.dataset.appActionSidebarProjectId !== project.id ||
       currentProject.dataset.appActionSidebarProjectLabel !== project.label);
    if (entry.disabled !== differentProject) entry.disabled = differentProject;
    if (differentProject && host !== null) restore();
    publishContext();
  });
  const close = () => {
    observer.disconnect(); sidebar.removeEventListener('click', handleSidebar, true);
    globalThis.removeEventListener('message', handleMessage); restore();
    (entryHost ?? entry).remove();
    delete root.__codexGitBridge;
  };
  root.__codexGitBridge = { close, restore,
    frameName: () => frame?.name ?? null,
    expectDocument: (name, nonce) => { if (frame?.name === name) { documentNonce = nonce; documentLoaded = false; } },
    documentReady: (name) => frame?.name === name && documentLoaded,
  };
  entry.addEventListener('click', open);
  sidebar.addEventListener('click', handleSidebar, true);
  globalThis.addEventListener('message', handleMessage);
  if (entryHost !== null && entryInsertionAnchor !== null) entryInsertionAnchor.before(entryHost);
  else sidebar.append(entry);
  observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
  if (input.openSurface) open();
  const initialContext = context();
  lastContext = JSON.stringify(initialContext);
  return { context: initialContext, open: input.openSurface, project, status: 'attached' };
}
