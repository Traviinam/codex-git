import type { CodexRenderer } from './renderer.js';
import { findCodexCompatibilityProfile } from './compatibility-profile.js';

export interface CompatibleCodexAnchors {
  readonly entryInsertionAnchor: HTMLElement | null;
  readonly mainSurface: HTMLElement;
  readonly nativeEntry: HTMLButtonElement;
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
    profile.documentInjection === true ||
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
  const nativeEntry = sidebar?.querySelector(profile.nativeEntrySelector);
  const entryInsertionAnchors =
    profile.entryInsertionSelector === null
      ? null
      : sidebar?.querySelectorAll(profile.entryInsertionSelector);
  const entryInsertionAnchor = entryInsertionAnchors?.item(0) ?? null;
  const compatibleEntryInsertionAnchor =
    entryInsertionAnchor instanceof renderer.window.HTMLElement
      ? entryInsertionAnchor
      : null;

  return sidebars.length === 1 &&
    mainSurfaces.length === 1 &&
    sidebar instanceof renderer.window.HTMLElement &&
    mainSurface instanceof renderer.window.HTMLElement &&
    nativeEntry instanceof renderer.window.HTMLButtonElement &&
    (entryInsertionAnchors === null ||
      (entryInsertionAnchors.length === 1 &&
        compatibleEntryInsertionAnchor !== null))
    ? {
        entryInsertionAnchor: compatibleEntryInsertionAnchor,
        mainSurface,
        nativeEntry,
        sidebar,
      }
    : null;
}
