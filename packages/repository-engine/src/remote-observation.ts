import { createHmac, randomBytes } from 'node:crypto';

import type { OpaqueIdAuthority, RemoteId } from '@codex-git/protocol';

export interface RemoteSnapshot {
  readonly remoteId: RemoteId;
  readonly displayName: string;
  readonly host: string;
  readonly configurationEvidence: string;
}

export interface RemoteIdentityState {
  readonly evidenceKey: Uint8Array;
  identities: Map<string, RemoteId>;
}

export interface RemoteObservation {
  readonly evidence: string;
  readonly remotes: readonly RemoteSnapshot[];
}

export type RemoteGitReader = (
  args: readonly string[],
  allowLargeOutput: boolean,
  acceptedEmptyExitCode?: 1,
) => Promise<Uint8Array>;

const textDecoder = new TextDecoder('utf-8', { fatal: true });
const remoteConfigPattern =
  '^remote\\..+\\.(url|pushurl|fetch|push|mirror|prune|prunetags|tagopt|skipdefaultupdate|skipfetchall)$';
const validHost =
  /^(?:\[[\da-f:.]+\]|[\da-z](?:[\da-z.-]*[\da-z])?)(?::\d{1,5})?$/iu;

export function createRemoteIdentityState(): RemoteIdentityState {
  return { evidenceKey: randomBytes(32), identities: new Map() };
}

export function cloneRemoteIdentityState(
  state: RemoteIdentityState,
): RemoteIdentityState {
  return {
    evidenceKey: state.evidenceKey,
    identities: new Map(state.identities),
  };
}

export async function observeRemotes(
  contextArgs: readonly string[],
  readGit: RemoteGitReader,
  identity: RemoteIdentityState,
  ids: OpaqueIdAuthority,
): Promise<RemoteObservation> {
  const names = parseRemoteNames(
    await readGit([...contextArgs, 'remote'], false),
  );
  const configured =
    names.length === 0
      ? []
      : parseRemoteConfig(
          await readGit(
            [
              ...contextArgs,
              'config',
              '--includes',
              '--null',
              '--get-regexp',
              remoteConfigPattern,
            ],
            true,
            1,
          ),
        );
  const resolved = await Promise.all(
    names.map(async (displayName) => {
      const fetchEndpoint = decodeLine(
        await readGit(
          [...contextArgs, 'ls-remote', '--get-url', '--', displayName],
          true,
        ),
      );
      const configuredPushEndpoints = configured
        .filter(({ key }) => key === `remote.${displayName}.pushurl`)
        .map(({ value }) => value);
      const pushEndpoints =
        configuredPushEndpoints.length === 0
          ? [fetchEndpoint]
          : await Promise.all(
              configuredPushEndpoints.map(async (endpoint) =>
                decodeLine(
                  await readGit(
                    [...contextArgs, 'ls-remote', '--get-url', '--', endpoint],
                    true,
                  ),
                ),
              ),
            );
      return { displayName, fetchEndpoint, pushEndpoints };
    }),
  );

  const retained = new Map<string, RemoteId>();
  const remotes = resolved.map(
    ({ displayName, fetchEndpoint, pushEndpoints }) => {
      const remoteId =
        identity.identities.get(displayName) ?? ids.issue('remote');
      retained.set(displayName, remoteId);
      return {
        remoteId,
        displayName,
        host: sanitizeRemoteHost(fetchEndpoint),
        configurationEvidence: keyedEvidence(identity.evidenceKey, {
          config: configured.filter(({ key }) =>
            key.startsWith(`remote.${displayName}.`),
          ),
          fetchEndpoint,
          pushEndpoints,
        }),
      };
    },
  );
  identity.identities = retained;

  return {
    remotes,
    evidence: keyedEvidence(identity.evidenceKey, {
      config: configured,
      resolved,
    }),
  };
}

function parseRemoteNames(output: Uint8Array): readonly string[] {
  const names = decode(output)
    .split(/\r?\n/u)
    .filter((name) => name.length > 0);
  if (
    names.some(
      (name) => name.length > 256 || name.includes('\0') || name.includes('\n'),
    )
  ) {
    throw new Error('Git returned an invalid Remote name.');
  }
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

interface ConfigEntry {
  readonly key: string;
  readonly value: string;
}

function parseRemoteConfig(output: Uint8Array): readonly ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  for (const record of decode(output).split('\0')) {
    if (record.length === 0) {
      continue;
    }
    const separator = record.indexOf('\n');
    if (separator < 0) {
      throw new Error('Git returned malformed Remote configuration.');
    }
    const key = record.slice(0, separator);
    if (!new RegExp(remoteConfigPattern, 'u').test(key)) {
      throw new Error('Git returned configuration outside the Remote scope.');
    }
    entries.push({ key, value: record.slice(separator + 1) });
  }
  return entries.sort((left, right) =>
    `${left.key}\0${left.value}`.localeCompare(`${right.key}\0${right.value}`),
  );
}

function sanitizeRemoteHost(endpoint: string | undefined): string {
  if (endpoint === undefined) {
    return 'unknown';
  }
  try {
    const url = new URL(endpoint);
    if (url.protocol === 'file:') {
      return 'local';
    }
    const host = url.host.toLowerCase();
    return host.length <= 1_024 && validHost.test(host) ? host : 'unknown';
  } catch {
    // Git's scp-like syntax is not a URL. Strip user and path before validation.
    const match = /^(?:[^@/:\s]+@)?(\[[\da-fA-F:.]+\]|[^/:\s]+):/u.exec(
      endpoint,
    );
    if (match !== null) {
      const host = (match[1] ?? '').toLowerCase();
      return host.length <= 1_024 && validHost.test(host) ? host : 'unknown';
    }
    return 'local';
  }
}

function keyedEvidence(key: Uint8Array, value: unknown): string {
  return createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
}

function decodeLine(output: Uint8Array): string {
  return decode(output).replace(/\r?\n$/u, '');
}

function decode(output: Uint8Array): string {
  return textDecoder.decode(output);
}
