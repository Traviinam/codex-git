import { describe, expect, it } from 'vitest';

import { StandaloneHostAdapter } from '@codex-git/host-adapter-standalone';

describe('StandaloneHostAdapter contract', () => {
  it('publishes the standalone Host Context after attaching a surface', async () => {
    const adapter = new StandaloneHostAdapter();
    const result = await adapter.attach({
      title: 'Codex Git',
      url: new URL('http://127.0.0.1:4173'),
    });
    if (result.kind !== 'attached') {
      throw new Error('Expected the standalone Host Adapter to attach');
    }
    const { connection } = result;

    const contexts = connection.contexts()[Symbol.asyncIterator]();

    expect(await contexts.next()).toEqual({
      done: false,
      value: {
        projectPath: null,
        task: null,
        theme: 'system',
      },
    });

    await connection.close();
  });
});
