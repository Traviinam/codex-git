export interface CodexCompatibilityProfile {
  readonly build: string;
  readonly chromiumProduct: string;
  readonly mainSurfaceSelector: string;
  readonly sidebarSelector: string;
  readonly version: string;
}

const profiles = [
  {
    build: '7119',
    chromiumProduct: 'Chrome/151.0.7922.170',
    mainSurfaceSelector: '[data-app-shell-main-surface="default"]',
    sidebarSelector: '#app-shell-sidebar',
    version: '26.820.60940',
  },
  {
    build: '6962',
    chromiumProduct: 'Chrome/151.0.7922.170',
    mainSurfaceSelector: '[data-app-shell-main-surface="default"]',
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
