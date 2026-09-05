import { describe, expect, it } from 'vitest';

import { findCodexCompatibilityProfile } from './compatibility-profile.js';

describe('Codex compatibility profiles', () => {
  it('requires document injection for the exact verified build 7982', () => {
    expect(findCodexCompatibilityProfile('26.901.41600', '7982')).toMatchObject(
      { documentInjection: true, chromiumProduct: 'Chrome/152.0.7977.64' },
    );
    expect(findCodexCompatibilityProfile('26.901.41600', '7119')).toBeNull();
    expect(findCodexCompatibilityProfile('26.820.60940', '7982')).toBeNull();
  });

  it('fails closed for build 7377 after live CSP validation failed', () => {
    expect(findCodexCompatibilityProfile('26.825.51511', '7377')).toBeNull();
    expect(findCodexCompatibilityProfile('26.825.51511', '7119')).toBeNull();
    expect(findCodexCompatibilityProfile('26.820.60940', '7377')).toBeNull();
  });
});
