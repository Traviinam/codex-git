import { describe, expect, it } from 'vitest';

import { GitReadPolicy, runSelectedFirst } from './git-read-policy.js';

describe('Git read policy', () => {
  it('deduplicates equivalent pending reads', async () => {
    const policy = new GitReadPolicy(2);
    let executions = 0;
    const read = async () => {
      executions += 1;
      return 'observation';
    };

    const [first, second] = await Promise.all([
      policy.run('same-recipe', read),
      policy.run('same-recipe', read),
    ]);

    expect([first, second]).toEqual(['observation', 'observation']);
    expect(executions).toBe(1);
  });

  it('bounds concurrent reads', async () => {
    const policy = new GitReadPolicy(2);
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const reads = Array.from({ length: 5 }, (_, index) =>
      policy.run(`recipe-${index}`, async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      }),
    );

    await waitFor(() => releases.length === 2);
    while (releases.length > 0 || active > 0) {
      releases.shift()?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(reads);

    expect(maximumActive).toBe(2);
  });

  it('completes the selected observation before admitting another Worktree', async () => {
    const events: string[] = [];
    let releaseSelected!: () => void;
    const selectedGate = new Promise<void>((resolve) => {
      releaseSelected = resolve;
    });
    const observing = runSelectedFirst(
      ['other', 'selected'],
      (item) => item === 'selected',
      async (item) => {
        events.push(`${item}:start`);
        if (item === 'selected') {
          await selectedGate;
        }
        events.push(`${item}:complete`);
        return item;
      },
    );

    await waitFor(() => events.length === 1);
    expect(events).toEqual(['selected:start']);
    releaseSelected();
    await observing;
    expect(events).toEqual([
      'selected:start',
      'selected:complete',
      'other:start',
      'other:complete',
    ]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for the test condition.');
}
