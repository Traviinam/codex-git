import { describe, expect, it } from 'vitest';

import { StandaloneHostAdapter } from '@codex-git/host-adapter-standalone';
import { isNativeHostAction } from '@codex-git/host-adapter';

describe('HostAdapter contract', () => {
  it('attaches the standalone surface with a current typed Host Context', async () => {
    const result = await new StandaloneHostAdapter().attach({
      title: 'Codex Git',
      url: new URL('http://127.0.0.1:4173'),
    });

    expect(result.kind).toBe('attached');
    if (result.kind !== 'attached') {
      throw new Error('Expected the standalone Host Adapter to attach');
    }

    expect(result.connection.currentContext()).toEqual({
      projectPath: null,
      task: null,
      theme: 'system',
    });
    expect(result.connection.capabilities()).toEqual({
      openCodexContext: false,
      openFileInCodex: false,
    });

    await result.connection.close();
  });
});

describe('Host native action contract', () => {
  it('accepts only named actions with exact opaque targets', () => {
    expect(
      isNativeHostAction({
        kind: 'open-file-in-codex',
        targetId: 'native_0123456789abcdef0123456789abcdef',
      }),
    ).toBe(true);
    expect(
      isNativeHostAction({
        kind: 'open-file-in-codex',
        absolutePath: '/tmp/user-supplied.ts',
      }),
    ).toBe(false);
    expect(
      isNativeHostAction({
        kind: 'run-host-command',
        targetId: 'native_0123456789abcdef0123456789abcdef',
      }),
    ).toBe(false);
  });
});
