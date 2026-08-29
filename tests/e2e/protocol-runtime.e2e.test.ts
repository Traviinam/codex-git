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
      healthPort: 0,
      surfacePort: 0,
    });
    runtimes.push(runtime);

    const response = await fetch(runtime.sessionUrl, {
      headers: {
        origin: runtime.surfaceUrl.origin,
        [PROTOCOL_VERSION_HEADER]: '1',
      },
    });

    expect({ body: await response.json(), status: response.status }).toEqual({
      body: expect.objectContaining({ protocolVersion: 1 }),
      status: 200,
    });
  });
});
