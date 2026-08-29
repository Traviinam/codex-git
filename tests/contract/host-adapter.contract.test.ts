import { describe, expect, it } from 'vitest';

import { StandaloneHostAdapter } from '@codex-git/host-adapter-standalone';

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

    await result.connection.close();
  });
});
