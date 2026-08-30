import { describe, expect, it } from 'vitest';

import { presentSideBySide } from './diff-presentation.js';

describe('side-by-side Diff presentation', () => {
  it('aligns replacement blocks and omits patch transport metadata', () => {
    const result = presentSideBySide(
      [
        'diff --git a/file.txt b/file.txt',
        'index 1111111..2222222 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,4 +1,4 @@',
        ' context',
        '-old one',
        '-old two',
        '+new one',
        ' tail',
        '@@ -10 +10 @@',
        '-last old',
        '+last new',
      ].join('\n'),
    );

    expect(result.before.split('\n')).toEqual([
      'context',
      'old one',
      'old two',
      'tail',
      '⋯',
      'last old',
    ]);
    expect(result.after.split('\n')).toEqual([
      'context',
      'new one',
      '',
      'tail',
      '⋯',
      'last new',
    ]);
    expect(JSON.stringify(result)).not.toContain('diff --git');
  });
});
