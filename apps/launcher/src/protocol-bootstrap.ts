import type { Plugin } from 'vite';

export function protocolBootstrapPlugin(sessionUrl: URL): Plugin {
  const bootstrap = JSON.stringify({ sessionUrl: sessionUrl.href }).replaceAll(
    '<',
    '\\u003c',
  );

  return {
    name: 'codex-git-protocol-bootstrap',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n<script>globalThis.__CODEX_GIT_PROTOCOL__ = ${bootstrap};</script>`,
      );
    },
  };
}
