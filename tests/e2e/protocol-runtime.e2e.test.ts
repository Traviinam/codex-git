import { afterEach, describe, expect, it } from 'vitest';

import {
  startStandaloneRuntime,
  type StandaloneRuntime,
} from '@codex-git/launcher';
import { PROTOCOL_VERSION_HEADER } from '@codex-git/protocol';

const runtimes: StandaloneRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe('protocol runtime composition', () => {
  it('negotiates the shared protocol from the standalone surface Origin', async () => {
    const runtime = await startStandaloneRuntime({
      surfacePort: 0,
    });
    runtimes.push(runtime);

    const surface = await (await fetch(runtime.surfaceUrl)).text();
    const bootstrapMatch = surface.match(
      /globalThis\.__CODEX_GIT_PROTOCOL__ = (\{.*?\});/u,
    );
    expect(bootstrapMatch !== null).toBe(true);
    if (bootstrapMatch === null)
      throw new Error('Protocol bootstrap is absent.');
    const bootstrap = JSON.parse(bootstrapMatch[1] ?? '{}') as {
      sessionUrl?: string;
    };
    if (bootstrap.sessionUrl === undefined) {
      throw new Error('Protocol bootstrap has no session URL.');
    }
    const sessionUrl = new URL(bootstrap.sessionUrl);
    const token = sessionUrl.pathname.split('/')[2];

    const response = await fetch(sessionUrl, {
      headers: {
        origin: runtime.surfaceUrl.origin,
        [PROTOCOL_VERSION_HEADER]: '1',
      },
    });

    expect({
      body: await response.json(),
      status: response.status,
      tokenIsOpaque: token?.length === 64,
    }).toEqual({
      body: expect.objectContaining({ protocolVersion: 1 }),
      status: 200,
      tokenIsOpaque: true,
    });
  });
});
