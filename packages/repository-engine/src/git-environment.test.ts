import { describe, expect, it } from 'vitest';

import { createGitEnvironment } from './git-environment.js';

describe('Git process environment', () => {
  it('removes inherited Git authority while preserving ordinary process context', () => {
    const environment = createGitEnvironment({
      PATH: '/fixture/bin',
      HOME: '/fixture/home',
      GIT_DIR: '/attacker/repository',
      GIT_WORK_TREE: '/attacker/worktree',
      GIT_CONFIG_GLOBAL: '/attacker/config',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: 'exfiltrate',
      GIT_OPTIONAL_LOCKS: '1',
      LC_ALL: 'unsafe-locale',
    });

    expect(environment).toEqual({
      PATH: '/fixture/bin',
      HOME: '/fixture/home',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    });
  });
});
