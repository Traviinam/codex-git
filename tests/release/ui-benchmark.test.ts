import { describe, expect, it } from 'vitest';

import { prepareProtocolReleaseSurface } from './ui-benchmark.js';

describe('release UI benchmark preparation', () => {
  it('finishes the Vite entry request before the measured UI path begins', async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      requests.push(String(input));
      return new Response(
        requests.length === 1
          ? '<script type="module" src="/src/main.tsx"></script>'
          : 'export {};',
      );
    };

    await prepareProtocolReleaseSurface(
      new URL('http://127.0.0.1:4173/'),
      fetcher,
    );

    expect(requests).toEqual([
      'http://127.0.0.1:4173/',
      'http://127.0.0.1:4173/src/main.tsx',
    ]);
  });
});
