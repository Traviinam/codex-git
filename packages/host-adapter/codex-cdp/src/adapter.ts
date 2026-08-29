import { randomBytes } from 'node:crypto';

import type {
  HostAdapter,
  HostAttachResult,
  SurfaceDescriptor,
} from '@codex-git/host-adapter';

import type { CodexRendererSource, CspBypassLease } from './renderer.js';
import { findCompatibleCodexAnchors } from './compatibility.js';
import { CodexHostConnection } from './connection.js';

const activeConnections = new WeakMap<Document, CodexHostConnection>();

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

    const anchors = findCompatibleCodexAnchors(renderer);
    if (anchors === null) {
      return standaloneRequired(
        'incompatible-host',
        `Codex Desktop ${safeVersion(renderer.version)} did not match the tested host structure; use the standalone surface.`,
      );
    }

    let cspBypass: CspBypassLease | null = null;
    try {
      await activeConnections.get(renderer.document)?.close();
      cspBypass = await renderer.acquireCspBypass();
      const connection = new CodexHostConnection(
        renderer,
        cspBypass,
        anchors,
        surface,
        this.options.createSecret ?? createSecret,
        () => {
          if (activeConnections.get(renderer.document) === connection) {
            activeConnections.delete(renderer.document);
          }
        },
      );
      cspBypass = null;
      activeConnections.set(renderer.document, connection);
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

function standaloneRequired(
  code: 'attach-failed' | 'host-unavailable' | 'incompatible-host',
  message: string,
): HostAttachResult {
  return {
    kind: 'standalone-required',
    reason: { code, message },
  };
}
