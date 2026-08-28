import { afterEach, describe, expect, it } from 'vitest';

import {
  startStandaloneRuntime,
  type StandaloneRuntime,
} from '@codex-git/launcher';

const runtimes: StandaloneRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe('standalone runtime', () => {
  it('serves the health endpoint and placeholder Git Surface', async () => {
    const runtime = await startStandaloneRuntime({
      healthPort: 0,
      surfacePort: 0,
    });
    runtimes.push(runtime);

    const [healthResponse, surfaceResponse] = await Promise.all([
      fetch(runtime.healthUrl),
      fetch(runtime.surfaceUrl),
    ]);

    expect({
      health: await healthResponse.json(),
      healthStatus: healthResponse.status,
      surface: await surfaceResponse.text(),
      surfaceStatus: surfaceResponse.status,
    }).toEqual({
      health: {
        product: 'codex-git',
        status: 'ok',
      },
      healthStatus: 200,
      surface: expect.stringContaining('Codex Git'),
      surfaceStatus: 200,
    });
  });
});
