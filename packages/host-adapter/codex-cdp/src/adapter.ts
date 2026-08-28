import { randomBytes } from 'node:crypto';

import type {
  HostAdapter,
  HostAttachResult,
  SurfaceDescriptor,
} from '@codex-git/host-adapter';

import type {
  CodexRenderer,
  CodexRendererSource,
  CspBypassLease,
} from './renderer.js';
import { ManagedCodexHostConnection } from './managed-connection.js';

const supportedCodexVersion = '26.820.60940';
const sidebarSelector = '#app-shell-sidebar';
const mainSurfaceSelector = '[data-app-shell-main-surface="default"]';
const activeConnections = new WeakMap<
  CodexRendererSource,
  ManagedCodexHostConnection
>();

export interface CodexCdpHostAdapterOptions {
  readonly createSecret?: () => string;
  readonly rendererSource: CodexRendererSource;
}

export class CodexCdpHostAdapter implements HostAdapter {
  constructor(private readonly options: CodexCdpHostAdapterOptions) {}

  async attach(surface: SurfaceDescriptor): Promise<HostAttachResult> {
    const renderer = await this.options.rendererSource.current();

    if (renderer === null) {
      return standaloneRequired(
        'host-unavailable',
        'No explicitly selected Codex renderer was available; use the standalone surface.',
      );
    }

    if (!isCompatible(renderer)) {
      return standaloneRequired(
        'incompatible-host',
        `Codex Desktop ${safeVersion(renderer.version)} did not match the tested host structure; use the standalone surface.`,
      );
    }

    let cspBypass: CspBypassLease | null = null;
    try {
      await activeConnections.get(this.options.rendererSource)?.close();
      cspBypass = await renderer.acquireCspBypass();
      const connection = new ManagedCodexHostConnection(
        renderer,
        cspBypass,
        this.options.rendererSource,
        surface,
        this.options.createSecret ?? createSecret,
        isCompatible,
        () => {
          if (
            activeConnections.get(this.options.rendererSource) === connection
          ) {
            activeConnections.delete(this.options.rendererSource);
          }
        },
      );
      cspBypass = null;
      activeConnections.set(this.options.rendererSource, connection);
      return {
        kind: 'attached',
        connection,
      };
    } catch {
      await cspBypass?.release();
      return standaloneRequired(
        'attach-failed',
        'The compatible Codex renderer could not be attached; use the standalone surface.',
      );
    }
  }
}

function safeVersion(version: string): string {
  return /^\d+(?:\.\d+){1,3}$/.test(version)
    ? version
    : 'with an unknown version';
}

function createSecret(): string {
  return randomBytes(32).toString('base64url');
}

function isCompatible(renderer: CodexRenderer): boolean {
  if (
    renderer.version !== supportedCodexVersion ||
    renderer.ownership !== 'codex-git-dedicated' ||
    renderer.id.length === 0
  ) {
    return false;
  }

  const sidebar = renderer.document.querySelector(sidebarSelector);
  const mainSurface = renderer.document.querySelector(mainSurfaceSelector);

  return (
    sidebar instanceof renderer.window.HTMLElement &&
    mainSurface instanceof renderer.window.HTMLElement
  );
}

function standaloneRequired(
  code: 'attach-failed' | 'host-unavailable' | 'incompatible-host',
  message: string,
): HostAttachResult {
  return {
    kind: 'standalone-required',
    reason: { code, message },
  };
}
