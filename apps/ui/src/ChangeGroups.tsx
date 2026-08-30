import type { FileId } from '@codex-git/protocol';

import type { WorktreeOverviewSnapshot } from './repository-overview-model.js';

const groups = [
  { kind: 'conflict', label: 'Conflicts', action: 'conflict' },
  { kind: 'staged_change', label: 'Staged Changes', action: 'staged' },
  { kind: 'change', label: 'Changes', action: 'changed' },
  { kind: 'untracked', label: 'Untracked Files', action: 'untracked' },
] as const;

export function ChangeGroups({
  worktree,
  selectedFileId,
  onSelect,
}: {
  readonly worktree: WorktreeOverviewSnapshot;
  readonly selectedFileId: FileId | null;
  readonly onSelect: (fileId: FileId) => void;
}) {
  if (worktree.changes.length === 0) {
    return <p>No Changed Files in this Worktree.</p>;
  }
  return (
    <div className="change-groups">
      {groups.map((group) => {
        const changes = worktree.changes.filter(
          ({ kind }) => kind === group.kind,
        );
        if (changes.length === 0) return null;
        return (
          <section key={group.kind}>
            <h4>
              {group.label} <span>{changes.length}</span>
            </h4>
            <ul>
              {changes.map((change) => (
                <li key={change.fileId}>
                  <button
                    aria-label={`Review ${group.action} ${change.displayPath}`}
                    aria-pressed={change.fileId === selectedFileId}
                    type="button"
                    onClick={() => onSelect(change.fileId)}
                  >
                    <span>{change.displayPath}</span>
                    {change.previousDisplayPath === null ? null : (
                      <small>renamed from {change.previousDisplayPath}</small>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
