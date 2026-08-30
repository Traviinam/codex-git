export interface UrlRewriteRule {
  readonly kind: 'instead_of' | 'push_instead_of';
  readonly prefix: string;
  readonly base: string;
}

export interface RemoteUrlConfigEntry {
  readonly key: string;
  readonly value: string;
}

export type EffectiveRemoteUrlReader = (
  args: readonly string[],
  allowLargeOutput: boolean,
  acceptedEmptyExitCode?: 1,
) => Promise<Uint8Array>;

export const URL_REWRITE_CONFIG_PATTERN =
  '^url\\..+\\.(insteadof|pushinsteadof)$';

const textDecoder = new TextDecoder('utf-8', { fatal: true });

export async function observeEffectivePushUrls(
  contextArgs: readonly string[],
  remoteNames: readonly string[],
  configured: readonly RemoteUrlConfigEntry[],
  readGit: EffectiveRemoteUrlReader,
): Promise<ReadonlyMap<string, readonly string[]>> {
  if (remoteNames.length === 0) {
    return new Map();
  }
  const rules = parseUrlRewriteRules(
    textDecoder.decode(
      await readGit(
        [
          ...contextArgs,
          'config',
          '--includes',
          '--null',
          '--get-regexp',
          URL_REWRITE_CONFIG_PATTERN,
        ],
        true,
        1,
      ),
    ),
  );
  return new Map(
    remoteNames.map((name) => [
      name,
      resolveEffectivePushUrls(
        valuesFor(configured, `remote.${name}.url`),
        valuesFor(configured, `remote.${name}.pushurl`),
        rules,
      ),
    ]),
  );
}

export function parseUrlRewriteRules(
  output: string,
): readonly UrlRewriteRule[] {
  const rules: UrlRewriteRule[] = [];
  for (const record of output.split('\0')) {
    if (record.length === 0) {
      continue;
    }
    const separator = record.indexOf('\n');
    const match = /^url\.(.+)\.(insteadof|pushinsteadof)$/u.exec(
      record.slice(0, separator),
    );
    if (separator < 0 || match === null) {
      throw new Error('Git returned malformed URL rewrite configuration.');
    }
    rules.push({
      kind: match[2] === 'pushinsteadof' ? 'push_instead_of' : 'instead_of',
      base: match[1] ?? '',
      prefix: record.slice(separator + 1),
    });
  }
  return rules;
}

export function resolveEffectivePushUrls(
  fetchUrls: readonly string[],
  pushUrls: readonly string[],
  rules: readonly UrlRewriteRule[],
): readonly string[] {
  if (pushUrls.length > 0) {
    return pushUrls.map((url) => rewrite(url, rules, 'instead_of'));
  }
  return fetchUrls.map((url) => {
    const pushed = matchingRule(url, rules, 'push_instead_of');
    return pushed === undefined
      ? rewrite(url, rules, 'instead_of')
      : applyRule(url, pushed);
  });
}

function rewrite(
  url: string,
  rules: readonly UrlRewriteRule[],
  kind: UrlRewriteRule['kind'],
): string {
  const matched = matchingRule(url, rules, kind);
  return matched === undefined ? url : applyRule(url, matched);
}

function matchingRule(
  url: string,
  rules: readonly UrlRewriteRule[],
  kind: UrlRewriteRule['kind'],
): UrlRewriteRule | undefined {
  let matched: UrlRewriteRule | undefined;
  for (const rule of rules) {
    if (
      rule.kind === kind &&
      url.startsWith(rule.prefix) &&
      (matched === undefined || rule.prefix.length > matched.prefix.length)
    ) {
      matched = rule;
    }
  }
  return matched;
}

function applyRule(url: string, rule: UrlRewriteRule): string {
  return `${rule.base}${url.slice(rule.prefix.length)}`;
}

function valuesFor(
  configured: readonly RemoteUrlConfigEntry[],
  key: string,
): readonly string[] {
  return configured
    .filter((entry) => entry.key === key)
    .map((entry) => entry.value);
}
