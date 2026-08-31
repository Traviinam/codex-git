export interface CodexCompatibilityProfile {
  readonly build: string;
  readonly chromiumProduct: string;
  readonly entryInsertionSelector: string | null;
  readonly mainSurfaceSelector: string;
  readonly nativeEntrySelector: string;
  readonly sidebarSelector: string;
  readonly version: string;
}

const profiles = [
  {
    build: '7119',
    chromiumProduct: 'Chrome/151.0.7922.170',
    entryInsertionSelector: null,
    mainSurfaceSelector: '[data-app-shell-main-surface="default"]',
    nativeEntrySelector: 'button',
    sidebarSelector: '#app-shell-sidebar',
    version: '26.820.60940',
  },
  {
    build: '6962',
    chromiumProduct: 'Chrome/151.0.7922.170',
    entryInsertionSelector:
      'section:has([data-app-action-sidebar-project-row][aria-current="page"])',
    mainSurfaceSelector: '[data-app-shell-main-surface="default"]',
    nativeEntrySelector: 'button.sidebar-item.w-full',
    sidebarSelector: '.app-shell-left-panel',
    version: '26.818.41509',
  },
] as const satisfies readonly CodexCompatibilityProfile[];

export function findCodexCompatibilityProfile(
  version: string,
  build: string,
): CodexCompatibilityProfile | null {
  return (
    profiles.find(
      (profile) => profile.version === version && profile.build === build,
    ) ?? null
  );
}
