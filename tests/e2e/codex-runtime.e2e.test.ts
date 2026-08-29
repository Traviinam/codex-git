import { afterEach, describe, expect, it } from 'vitest';

import type {
  DedicatedCodexInstance,
  DedicatedCodexTarget,
} from '@codex-git/host-adapter-codex-cdp';
import { startCodexRuntime, type CodexRuntime } from '@codex-git/launcher';

const runtimes: CodexRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe('Codex runtime composition', () => {
  it('closes the dedicated instance and remains standalone when ownership fails', async () => {
    const instance = new FixtureInstance(null);
    const runtime = await startCodexRuntime({
      healthPort: 0,
      launchInstance: async () => instance,
      projectPath: '/Users/example/codex-git',
      surfacePort: 0,
    });
    runtimes.push(runtime);

    expect(runtime.currentHost()).toBe('standalone');
    expect(instance.closed).toBe(true);
  });
});

class FixtureInstance implements DedicatedCodexInstance {
  readonly build = '7119';
  closed = false;
  readonly ownership = {
    endpoint: 'http://127.0.0.1:43117/',
    instanceId: 'instance-42',
    processId: 4242,
    profilePath: '/private/tmp/codex-git-profile-42',
  };
  readonly version = '26.820.60940';

  constructor(private readonly target: DedicatedCodexTarget | null) {}

  async currentTarget(): Promise<DedicatedCodexTarget | null> {
    return this.target;
  }

  subscribe(): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
