import { describe, expect, it } from 'vitest';

import {
  acquireDedicatedRendererCspBypass,
  type CodexCdpCommandTransport,
} from './index.js';

describe('dedicated renderer CSP bypass', () => {
  it('enables one exact renderer target and restores it idempotently', async () => {
    const commands: Array<{
      method: string;
      params: unknown;
      rendererId: string;
    }> = [];
    const transport: CodexCdpCommandTransport = {
      async send(rendererId, method, params) {
        commands.push({ method, params, rendererId });
      },
    };

    const lease = await acquireDedicatedRendererCspBypass(
      transport,
      'renderer-target-42',
    );
    await lease.release();
    await lease.release();

    expect(commands).toEqual([
      {
        method: 'Page.setBypassCSP',
        params: { enabled: true },
        rendererId: 'renderer-target-42',
      },
      {
        method: 'Page.setBypassCSP',
        params: { enabled: false },
        rendererId: 'renderer-target-42',
      },
    ]);
  });

  it('allows restoration to be retried after a CDP failure', async () => {
    let disableAttempts = 0;
    const transport: CodexCdpCommandTransport = {
      async send(_rendererId, _method, params) {
        if (!params.enabled && ++disableAttempts === 1) {
          throw new Error('renderer temporarily unavailable');
        }
      },
    };
    const lease = await acquireDedicatedRendererCspBypass(
      transport,
      'renderer-target-42',
    );

    await expect(lease.release()).rejects.toThrow(
      'renderer temporarily unavailable',
    );
    await expect(lease.release()).resolves.toBeUndefined();
    expect(disableAttempts).toBe(2);
  });

  it('reference-counts concurrent leases for the same renderer', async () => {
    const enabled: boolean[] = [];
    const transport: CodexCdpCommandTransport = {
      async send(_rendererId, _method, params) {
        enabled.push(params.enabled);
      },
    };

    const first = await acquireDedicatedRendererCspBypass(
      transport,
      'renderer-target-42',
    );
    const second = await acquireDedicatedRendererCspBypass(
      transport,
      'renderer-target-42',
    );
    await first.release();
    expect(enabled).toEqual([true]);
    await second.release();
    expect(enabled).toEqual([true, false]);
  });
});
