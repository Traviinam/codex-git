import { describe, expect, it, vi } from 'vitest';
import { loadFrameDocument } from './frame-document.js';
import type { CdpSession } from './cdp-session.js';

const name = 'codex-git-12345678-1234-1234-1234-123456789abc';
function fixture(url = 'about:blank') {
  let current: string | null = name;
  let loaded = false;
  const send = vi.fn(
    async (method: string, params?: unknown): Promise<unknown> => {
      const expression = (params as { expression?: string })?.expression ?? '';
      if (expression.includes('frameName()'))
        return { result: { value: current } };
      if (expression.includes('documentReady('))
        return { result: { value: loaded } };
      if (method === 'Page.setDocumentContent') loaded = true;
      if (method === 'Page.getFrameTree')
        return {
          frameTree: {
            childFrames: [{ frame: { id: 'owned-frame', name, url } }],
          },
        };
      return {};
    },
  );
  const session: CdpSession = {
    send,
    subscribe: () => () => undefined,
    close: async () => undefined,
  };
  return {
    session,
    send,
    remove: () => {
      current = null;
    },
  };
}

describe('owned embedded document delivery', () => {
  it('writes only the launcher document into the identified blank frame and waits for readiness', async () => {
    const { session, send } = fixture();
    await loadFrameDocument(
      session,
      async () =>
        '<html><head></head><body><div id="root"></div></body></html>',
      () => false,
    );
    expect(send).toHaveBeenCalledWith('Page.setDocumentContent', {
      frameId: 'owned-frame',
      html: expect.stringContaining('codex-git:document-ready'),
    });
    expect(send).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({
        expression: expect.stringContaining('documentReady('),
      }),
    );
  });
  it('does not overwrite an already loaded frame when reload events repeat', async () => {
    const { session, send } = fixture();
    const load = async () => '<head></head>';
    await loadFrameDocument(session, load, () => false);
    await loadFrameDocument(session, load, () => false);
    expect(
      send.mock.calls.filter(
        ([method]) => method === 'Page.setDocumentContent',
      ),
    ).toHaveLength(1);
  });

  it('never injects into a frame that navigated away from the blank document', async () => {
    const { session, send } = fixture('https://untrusted.example');
    await expect(
      loadFrameDocument(
        session,
        async () => '<head></head>',
        () => false,
      ),
    ).rejects.toThrow('navigated');
    expect(
      send.mock.calls.some(([method]) => method === 'Page.setDocumentContent'),
    ).toBe(false);
  });
  it('cancels delivery when navigation removes the frame while HTML is loading', async () => {
    const { session, send, remove } = fixture();
    await loadFrameDocument(
      session,
      async () => {
        remove();
        return '<head></head>';
      },
      () => false,
    );
    expect(
      send.mock.calls.some(([method]) => method === 'Page.setDocumentContent'),
    ).toBe(false);
  });
  it('propagates launcher failures without writing a document', async () => {
    const { session, send } = fixture();
    await expect(
      loadFrameDocument(
        session,
        async () => {
          throw new Error('closed launcher');
        },
        () => false,
      ),
    ).rejects.toThrow('closed launcher');
    expect(
      send.mock.calls.some(([method]) => method === 'Page.setDocumentContent'),
    ).toBe(false);
  });
});
