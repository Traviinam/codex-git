import { randomUUID } from 'node:crypto';

import type { CdpSession } from './cdp-session.js';

// HTML comes directly from the launcher-owned renderer, never from a frame URL.
export async function loadFrameDocument(
  session: CdpSession,
  loadDocument: () => Promise<string>,
  isClosed: () => boolean,
): Promise<void> {
  const readFrame = async () => {
    const response = await session.send('Runtime.evaluate', {
      expression: 'globalThis.__codexGitBridge?.frameName() ?? null',
      returnByValue: true,
    });
    return (response as { result?: { value?: unknown } }).result?.value;
  };
  const name = await readFrame();
  if (name === null || name === undefined || isClosed()) return;
  if (typeof name !== 'string' || !/^codex-git-[a-f0-9-]{36}$/u.test(name)) {
    throw new Error('Invalid embedded frame identity');
  }
  const readiness = (await session.send('Runtime.evaluate', {
    expression: `globalThis.__codexGitBridge?.documentReady(${JSON.stringify(name)})`,
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  if (readiness.result?.value === true) return;
  const html = await loadDocument();
  if (!html.includes('<head>') || html.length > 4 * 1024 * 1024) {
    throw new Error('Invalid embedded document');
  }
  const nonce = randomUUID();
  const readyScript = `<script>(()=>{const observer=new MutationObserver(()=>{if(document.querySelector('#root')?.childElementCount){observer.disconnect();parent.postMessage({type:'codex-git:document-ready',nonce:${JSON.stringify(nonce)}},'*')}});observer.observe(document,{childList:true,subtree:true})})()</script>`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (isClosed() || (await readFrame()) !== name) return;
    const tree = (await session.send('Page.getFrameTree')) as {
      frameTree?: {
        childFrames?: Array<{
          frame: { id: string; name?: string; url?: string };
        }>;
      };
    };
    const frame = tree.frameTree?.childFrames?.find(
      (child) => child.frame.name === name,
    )?.frame;
    if (frame !== undefined) {
      if (frame.url !== 'about:blank')
        throw new Error('Embedded frame navigated unexpectedly');
      if (isClosed() || (await readFrame()) !== name) return;
      await session.send('Runtime.evaluate', {
        expression: `globalThis.__codexGitBridge?.expectDocument(${JSON.stringify(name)},${JSON.stringify(nonce)})`,
      });
      await session.send('Page.setDocumentContent', {
        frameId: frame.id,
        html: html.replace('<head>', `<head>${readyScript}`),
      });
      while (Date.now() < deadline) {
        if (isClosed() || (await readFrame()) !== name) return;
        const response = (await session.send('Runtime.evaluate', {
          expression: `globalThis.__codexGitBridge?.documentReady(${JSON.stringify(name)})`,
          returnByValue: true,
        })) as { result?: { value?: unknown } };
        if (response.result?.value === true) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Embedded Git document did not become ready');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Embedded Git frame did not appear');
}
