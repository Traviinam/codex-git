import { describe, expect, it } from 'vitest';
import { startStandaloneRuntime } from './standalone-runtime.js';

describe('embedded asset CORS boundary', () => {
  it('allows opaque-origin modules but never exposes bootstrap HTML or fallback HTML', async () => {
    const runtime = await startStandaloneRuntime({ surfacePort: 0 });
    try {
      for (const path of ['/', '/index.html', '/unknown-route']) {
        const response = await fetch(new URL(path, runtime.surfaceUrl), {
          headers: { origin: 'null', accept: 'text/html' },
        });
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      }
      const module = await fetch(new URL('/src/main.tsx', runtime.surfaceUrl), {
        headers: { origin: 'null' },
      });
      expect(module.headers.get('access-control-allow-origin')).toBe('null');
      expect(await module.text()).not.toContain(runtime.sessionUrl.pathname);
      const html = await runtime.loadEmbeddedDocument();
      expect(html).toContain(runtime.sessionUrl.href);
      expect(html).toContain('<base href=');
    } finally {
      await runtime.close();
    }
  });
});
