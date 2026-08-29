import type { NativeTargetId } from './native-actions.js';
import type {
  FileId,
  OperationId,
  RefId,
  RemoteId,
  RepositoryId,
  WorktreeGeneration,
  WorktreeId,
} from './schemas.js';

export type OpaqueIdKind =
  | 'file'
  | 'generation'
  | 'native'
  | 'operation'
  | 'ref'
  | 'remote'
  | 'repository'
  | 'worktree';

export interface OpaqueIdByKind {
  readonly file: FileId;
  readonly generation: WorktreeGeneration;
  readonly native: NativeTargetId;
  readonly operation: OperationId;
  readonly ref: RefId;
  readonly remote: RemoteId;
  readonly repository: RepositoryId;
  readonly worktree: WorktreeId;
}

export interface OpaqueIdAuthority {
  issue<Kind extends OpaqueIdKind>(kind: Kind): OpaqueIdByKind[Kind];
  owns<Kind extends OpaqueIdKind>(
    kind: Kind,
    value: unknown,
  ): value is OpaqueIdByKind[Kind];
  revokeAll(): void;
}

export interface OpaqueIdAuthorityOptions {
  readonly randomBytes?: (length: number) => Uint8Array;
}

export function createOpaqueIdAuthority(
  options: OpaqueIdAuthorityOptions = {},
): OpaqueIdAuthority {
  const issued = new Map<OpaqueIdKind, Set<string>>();
  const randomBytes = options.randomBytes ?? secureRandomBytes;

  return {
    issue(kind) {
      const values = issued.get(kind) ?? new Set<string>();
      issued.set(kind, values);

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const bytes = randomBytes(16);
        if (bytes.length !== 16) {
          throw new Error(
            'Opaque ID randomness must contain exactly 16 bytes.',
          );
        }

        const candidate = `${kind}_${toHex(bytes)}`;
        if (!values.has(candidate)) {
          values.add(candidate);
          return candidate as OpaqueIdByKind[typeof kind];
        }
      }

      throw new Error('Unable to issue a unique opaque ID.');
    },
    owns(kind, value): value is OpaqueIdByKind[typeof kind] {
      return typeof value === 'string' && issued.get(kind)?.has(value) === true;
    },
    revokeAll() {
      issued.clear();
    },
  };
}

function secureRandomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
