import { describe, expect, it } from 'vitest';

import {
  parseUrlRewriteRules,
  resolveEffectivePushUrls,
  type UrlRewriteRule,
} from './effective-remote-urls.js';

describe('effective Remote push URLs', () => {
  it('keeps only fetch URLs with a pushInsteadOf match when any URL matches', () => {
    const rules: readonly UrlRewriteRule[] = [
      rule('instead_of', 'alias:', 'ssh://fetch.example/'),
      rule('push_instead_of', 'alias:', 'ssh://push.example/general/'),
      rule('push_instead_of', 'alias:team/', 'ssh://push.example/team/'),
      rule('instead_of', 'other:', 'ssh://other.example/'),
    ];

    expect(
      resolveEffectivePushUrls(
        ['alias:team/one.git', 'other:two.git'],
        [],
        rules,
      ),
    ).toEqual(['ssh://push.example/team/one.git']);
  });

  it('falls back to insteadOf for every fetch URL when none match pushInsteadOf', () => {
    const rules: readonly UrlRewriteRule[] = [
      rule('instead_of', 'one:', 'ssh://one.example/'),
      rule('instead_of', 'two:', 'ssh://two.example/'),
      rule('push_instead_of', 'unused:', 'ssh://unused.example/'),
    ];

    expect(
      resolveEffectivePushUrls(['one:a.git', 'two:b.git'], [], rules),
    ).toEqual(['ssh://one.example/a.git', 'ssh://two.example/b.git']);
  });

  it('rewrites every explicit pushurl with insteadOf and ignores pushInsteadOf', () => {
    const rules: readonly UrlRewriteRule[] = [
      rule('instead_of', 'publish:', 'ssh://explicit.example/general/'),
      rule('instead_of', 'publish:team/', 'ssh://explicit.example/team/'),
      rule('push_instead_of', 'publish:', 'ssh://ignored.example/'),
    ];

    expect(
      resolveEffectivePushUrls(
        ['fetch:repository.git'],
        ['publish:team/one.git', 'publish:two.git'],
        rules,
      ),
    ).toEqual([
      'ssh://explicit.example/team/one.git',
      'ssh://explicit.example/general/two.git',
    ]);
  });

  it('uses the first effective rule when equally long prefixes match', () => {
    const rules: readonly UrlRewriteRule[] = [
      rule('push_instead_of', 'alias:', 'ssh://first.example/'),
      rule('push_instead_of', 'alias:', 'ssh://second.example/'),
    ];

    expect(
      resolveEffectivePushUrls(['alias:repository.git'], [], rules),
    ).toEqual(['ssh://first.example/repository.git']);
  });

  it('parses and applies an empty URL base', () => {
    const rules = parseUrlRewriteRules('url..pushinsteadof\nalias:\0');

    expect(
      resolveEffectivePushUrls(['alias:repository.git'], [], rules),
    ).toEqual(['repository.git']);
  });
});

function rule(
  kind: UrlRewriteRule['kind'],
  prefix: string,
  base: string,
): UrlRewriteRule {
  return { kind, prefix, base };
}
