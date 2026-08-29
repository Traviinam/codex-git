import type { CspBypassLease } from './renderer.js';

export interface CodexCdpCommandTransport {
  send(
    rendererId: string,
    method: 'Page.setBypassCSP',
    params: { readonly enabled: boolean },
  ): Promise<void>;
}

interface ActiveBypass {
  count: number;
  disabling: Promise<void> | null;
}

const activeByTransport = new WeakMap<
  CodexCdpCommandTransport,
  Map<string, ActiveBypass>
>();
const activeByOwnershipScope = new Map<string, ActiveBypass>();

export async function acquireDedicatedRendererCspBypass(
  transport: CodexCdpCommandTransport,
  rendererId: string,
  ownershipScope?: string,
): Promise<CspBypassLease> {
  if (rendererId.length === 0) {
    throw new Error('A stable renderer ID is required for CSP bypass');
  }

  let renderers: Map<string, ActiveBypass>;
  let key: string;
  if (ownershipScope === undefined) {
    renderers = activeByTransport.get(transport) ?? new Map();
    activeByTransport.set(transport, renderers);
    key = rendererId;
  } else {
    renderers = activeByOwnershipScope;
    key = ownershipScope;
  }
  const existing = renderers.get(key);
  if (existing?.disabling !== null && existing?.disabling !== undefined) {
    await existing.disabling;
    return acquireDedicatedRendererCspBypass(
      transport,
      rendererId,
      ownershipScope,
    );
  }
  const active = existing ?? { count: 0, disabling: null };
  if (existing === undefined) {
    renderers.set(key, active);
    try {
      await transport.send(rendererId, 'Page.setBypassCSP', { enabled: true });
    } catch (error) {
      renderers.delete(key);
      throw error;
    }
  }
  active.count++;
  let releaseAttempt: Promise<void> | null = null;
  let released = false;

  return {
    release() {
      if (released) {
        return Promise.resolve();
      }
      if (releaseAttempt === null) {
        if (active.count > 1) {
          active.count--;
          released = true;
          return Promise.resolve();
        }
        releaseAttempt = transport.send(rendererId, 'Page.setBypassCSP', {
          enabled: false,
        });
        active.disabling = releaseAttempt;
        releaseAttempt = releaseAttempt.then(
          () => {
            active.count = 0;
            active.disabling = null;
            released = true;
            renderers.delete(key);
          },
          (error: unknown) => {
            active.disabling = null;
            releaseAttempt = null;
            throw error;
          },
        );
      }
      return releaseAttempt;
    },
  };
}
