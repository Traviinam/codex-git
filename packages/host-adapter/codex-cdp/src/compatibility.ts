import type { CodexRenderer } from './renderer.js';
import { findCodexCompatibilityProfile } from './compatibility-profile.js';

export interface CompatibleCodexAnchors {
  readonly mainSurface: HTMLElement;
  readonly sidebar: HTMLElement;
}

export function findCompatibleCodexAnchors(
  renderer: CodexRenderer,
): CompatibleCodexAnchors | null {
  const profile = findCodexCompatibilityProfile(
    renderer.version,
    renderer.build,
  );
  if (
    profile === null ||
    renderer.ownership !== 'codex-git-dedicated' ||
    renderer.id.length === 0
  ) {
    return null;
  }

  const sidebars = renderer.document.querySelectorAll(profile.sidebarSelector);
  const mainSurfaces = renderer.document.querySelectorAll(
    profile.mainSurfaceSelector,
  );
  const sidebar = sidebars.item(0);
  const mainSurface = mainSurfaces.item(0);

  return sidebars.length === 1 &&
    mainSurfaces.length === 1 &&
    sidebar instanceof renderer.window.HTMLElement &&
    mainSurface instanceof renderer.window.HTMLElement
    ? { mainSurface, sidebar }
    : null;
}
