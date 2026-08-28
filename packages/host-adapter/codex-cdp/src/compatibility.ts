import type { CodexRenderer } from './renderer.js';

const supportedCodexVersion = '26.820.60940';
const sidebarSelector = '#app-shell-sidebar';
const mainSurfaceSelector = '[data-app-shell-main-surface="default"]';

export interface CompatibleCodexAnchors {
  readonly mainSurface: HTMLElement;
  readonly sidebar: HTMLElement;
}

export function findCompatibleCodexAnchors(
  renderer: CodexRenderer,
): CompatibleCodexAnchors | null {
  if (
    renderer.version !== supportedCodexVersion ||
    renderer.ownership !== 'codex-git-dedicated' ||
    renderer.id.length === 0
  ) {
    return null;
  }

  const sidebar = renderer.document.querySelector(sidebarSelector);
  const mainSurface = renderer.document.querySelector(mainSurfaceSelector);

  return sidebar instanceof renderer.window.HTMLElement &&
    mainSurface instanceof renderer.window.HTMLElement
    ? { mainSurface, sidebar }
    : null;
}
