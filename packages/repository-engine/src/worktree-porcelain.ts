export interface WorktreePorcelainRecord {
  readonly pathBytes: Uint8Array;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly lockedReason: string | null;
  readonly prunable: boolean;
  readonly prunableReason: string | null;
}

interface MutableWorktreeRecord {
  pathBytes?: Uint8Array;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockedReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** Parses the NUL form emitted by `git worktree list --porcelain -z`. */
export function parseWorktreeListPorcelain(
  output: Uint8Array,
): readonly WorktreePorcelainRecord[] {
  const fields = splitNulFields(output);
  const records: WorktreePorcelainRecord[] = [];
  let record: MutableWorktreeRecord | undefined;

  const finishRecord = () => {
    if (record === undefined) {
      return;
    }

    if (record.pathBytes === undefined) {
      throw new Error('Worktree porcelain record is missing its path.');
    }
    if (record.branch !== undefined && record.detached) {
      throw new Error(
        'Worktree porcelain record cannot be both attached and detached.',
      );
    }

    records.push({
      pathBytes: record.pathBytes,
      head: record.head ?? null,
      branch: record.branch ?? null,
      detached: record.detached,
      bare: record.bare,
      locked: record.locked,
      lockedReason: record.lockedReason,
      prunable: record.prunable,
      prunableReason: record.prunableReason,
    });
    record = undefined;
  };

  for (const field of fields) {
    if (field.length === 0) {
      finishRecord();
      continue;
    }

    const separator = field.indexOf(0x20);
    const keyBytes = separator === -1 ? field : field.subarray(0, separator);
    const valueBytes =
      separator === -1 ? new Uint8Array() : field.subarray(separator + 1);
    const key = decodeUtf8(keyBytes);

    if (key === 'worktree') {
      if (record !== undefined) {
        throw new Error(
          'Worktree porcelain record started before the previous record ended.',
        );
      }
      if (valueBytes.length === 0) {
        throw new Error('Worktree porcelain path cannot be empty.');
      }
      record = {
        pathBytes: valueBytes.slice(),
        detached: false,
        bare: false,
        locked: false,
        lockedReason: null,
        prunable: false,
        prunableReason: null,
      };
      continue;
    }

    if (record === undefined) {
      throw new Error(
        `Worktree porcelain field "${key}" appeared before a worktree path.`,
      );
    }

    switch (key) {
      case 'HEAD':
        record.head = decodeForDisplay(valueBytes);
        break;
      case 'branch':
        record.branch = decodeForDisplay(valueBytes);
        break;
      case 'detached':
        record.detached = true;
        break;
      case 'bare':
        record.bare = true;
        break;
      case 'locked':
        record.locked = true;
        record.lockedReason =
          valueBytes.length === 0 ? null : decodeForDisplay(valueBytes);
        break;
      case 'prunable':
        record.prunable = true;
        record.prunableReason =
          valueBytes.length === 0 ? null : decodeForDisplay(valueBytes);
        break;
      default:
        // Porcelain may grow additive fields; inventory remains usable when it does.
        break;
    }
  }

  finishRecord();
  return records;
}

function splitNulFields(output: Uint8Array): readonly Uint8Array[] {
  const fields: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] === 0) {
      fields.push(output.subarray(start, index));
      start = index + 1;
    }
  }
  fields.push(output.subarray(start));
  return fields;
}

export function decodeForDisplay(bytes: Uint8Array): string {
  try {
    return decodeUtf8(bytes);
  } catch {
    return Array.from(bytes, (byte) =>
      byte >= 0x20 && byte <= 0x7e && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, '0')}`,
    ).join('');
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}
