import { describe, expect, it } from 'vitest';

import { findCodexCompatibilityProfile } from './compatibility-profile.js';

describe('Codex compatibility profiles', () => {
  it('fails closed for build 7377 after live CSP validation failed', () => {
    expect(findCodexCompatibilityProfile('26.825.51511', '7377')).toBeNull();
    expect(findCodexCompatibilityProfile('26.825.51511', '7119')).toBeNull();
    expect(findCodexCompatibilityProfile('26.820.60940', '7377')).toBeNull();
  });
});
