import type { CspBypassLease } from './renderer.js';

export interface CodexCdpCommandTransport {
  send(
    rendererId: string,
    method: 'Page.setBypassCSP',
    params: { readonly enabled: boolean },
  ): Promise<void>;
}

export async function acquireDedicatedRendererCspBypass(
  transport: CodexCdpCommandTransport,
  rendererId: string,
): Promise<CspBypassLease> {
  if (rendererId.length === 0) {
    throw new Error('A stable renderer ID is required for CSP bypass');
  }

  await transport.send(rendererId, 'Page.setBypassCSP', { enabled: true });
  let releaseAttempt: Promise<void> | null = null;

  return {
    release() {
      if (releaseAttempt === null) {
        releaseAttempt = transport
          .send(rendererId, 'Page.setBypassCSP', { enabled: false })
          .catch((error: unknown) => {
            releaseAttempt = null;
            throw error;
          });
      }
      return releaseAttempt;
    },
  };
}
