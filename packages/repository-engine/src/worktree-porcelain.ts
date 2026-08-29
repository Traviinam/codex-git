export interface WorktreePorcelainRecord {
  readonly path: string;
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
  path?: string;
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
  const fields = utf8Decoder.decode(output).split('\0');
  const records: WorktreePorcelainRecord[] = [];
  let record: MutableWorktreeRecord | undefined;

  const finishRecord = () => {
    if (record === undefined) {
      return;
    }

    if (record.path === undefined) {
      throw new Error('Worktree porcelain record is missing its path.');
    }
    if (record.branch !== undefined && record.detached) {
      throw new Error(
        'Worktree porcelain record cannot be both attached and detached.',
      );
    }

    records.push({
      path: record.path,
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

    const separator = field.indexOf(' ');
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? '' : field.slice(separator + 1);

    if (key === 'worktree') {
      if (record !== undefined) {
        throw new Error(
          'Worktree porcelain record started before the previous record ended.',
        );
      }
      if (value.length === 0) {
        throw new Error('Worktree porcelain path cannot be empty.');
      }
      record = {
        path: value,
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
        record.head = value;
        break;
      case 'branch':
        record.branch = value;
        break;
      case 'detached':
        record.detached = true;
        break;
      case 'bare':
        record.bare = true;
        break;
      case 'locked':
        record.locked = true;
        record.lockedReason = value.length === 0 ? null : value;
        break;
      case 'prunable':
        record.prunable = true;
        record.prunableReason = value.length === 0 ? null : value;
        break;
      default:
        // Porcelain may grow additive fields; inventory remains usable when it does.
        break;
    }
  }

  finishRecord();
  return records;
}
