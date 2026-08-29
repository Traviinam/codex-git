import { describe, expect, it } from 'vitest';

import {
  launchDedicatedCodexInstance,
  type DedicatedCodexPlatform,
  type DedicatedCodexProcess,
} from './index.js';

describe('dedicated Codex instance discovery', () => {
  it('binds discovery to the launched profile, process, endpoint, and exact target', async () => {
    const platform = new FixturePlatform(
      [
        {
          id: 'foreign-target',
          type: 'page',
          url: 'app://-/index.html',
          webSocketDebuggerUrl:
            'ws://127.0.0.1:65530/devtools/page/foreign-target',
        },
        {
          id: 'owned-target',
          type: 'page',
          url: 'app://-/index.html',
          webSocketDebuggerUrl:
            'ws://127.0.0.1:43117/devtools/page/owned-target',
        },
      ],
      2,
    );

    const instance = await launchDedicatedCodexInstance({
      appPath: '/Applications/ChatGPT.app',
      createInstanceId: () => 'instance-42',
      platform,
    });

    expect(platform.launch).toEqual({
      args: [
        '--user-data-dir=/private/tmp/codex-git-profile-42',
        '--remote-debugging-port=0',
        '--no-first-run',
      ],
      executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    });
    expect(instance.ownership).toEqual({
      endpoint: 'http://127.0.0.1:43117/',
      instanceId: 'instance-42',
      processId: 4242,
      profilePath: '/private/tmp/codex-git-profile-42',
    });
    await expect(instance.currentTarget()).resolves.toEqual({
      id: 'owned-target',
      webSocketUrl: 'ws://127.0.0.1:43117/devtools/page/owned-target',
    });

    await instance.close();
    expect(platform.process.terminated).toBe(true);
    expect(platform.removedProfiles).toEqual([
      '/private/tmp/codex-git-profile-42',
    ]);
  });

  it('rejects discovery when no target is bound to the owned endpoint', async () => {
    const platform = new FixturePlatform([
      {
        id: 'foreign-target',
        type: 'page',
        url: 'app://-/index.html',
        webSocketDebuggerUrl:
          'ws://127.0.0.1:65530/devtools/page/foreign-target',
      },
    ]);
    await expect(
      launchDedicatedCodexInstance({
        appPath: '/Applications/ChatGPT.app',
        createInstanceId: () => 'instance-42',
        platform,
        startupTimeoutMs: 1,
      }),
    ).rejects.toThrow('renderer target did not become available');
  });
});

// prettier-ignore
class FixtureProcess implements DedicatedCodexProcess {
  readonly exited = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });
  readonly pid = 4242;
  terminated = false;
  private resolveExit: () => void = () => undefined;

  terminate(): void { this.terminated = true; this.resolveExit(); }
}

// prettier-ignore
class FixturePlatform implements DedicatedCodexPlatform {
  readonly process = new FixtureProcess();
  launch: { readonly args: readonly string[]; readonly executable: string } | null = null;
  readonly removedProfiles: string[] = [];

  constructor(private readonly targets: unknown, private emptyFetches = 0) {}
  async createProfile(): Promise<string> { return '/private/tmp/codex-git-profile-42'; }
  async readAppVersion(): Promise<string> { return '26.820.60940'; }
  spawn(executable: string, args: readonly string[]): DedicatedCodexProcess {
    this.launch = { args, executable };
    return this.process;
  }

  async readFile(): Promise<string> { return '43117\n/devtools/browser/browser-42\n'; }
  async fetchJson(): Promise<unknown> { return this.emptyFetches-- > 0 ? [] : this.targets; }
  async removeProfile(profilePath: string): Promise<void> {
    this.removedProfiles.push(profilePath);
  }

  async wait(): Promise<void> {}
}
