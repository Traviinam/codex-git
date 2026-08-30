export interface SideBySideDiff {
  readonly before: string;
  readonly after: string;
}

export function presentSideBySide(content: string): SideBySideDiff {
  const before: string[] = [];
  const after: string[] = [];
  let deletions: string[] = [];
  let additions: string[] = [];
  let insideHunk = false;

  const flushChange = () => {
    const rows = Math.max(deletions.length, additions.length);
    for (let index = 0; index < rows; index += 1) {
      before.push(deletions[index] ?? '');
      after.push(additions[index] ?? '');
    }
    deletions = [];
    additions = [];
  };

  for (const line of content.split('\n')) {
    if (line.startsWith('@@')) {
      flushChange();
      if (insideHunk) {
        before.push('⋯');
        after.push('⋯');
      }
      insideHunk = true;
      continue;
    }
    if (!insideHunk) continue;
    if (line.startsWith('-')) {
      deletions.push(line.slice(1));
      continue;
    }
    if (line.startsWith('+')) {
      additions.push(line.slice(1));
      continue;
    }
    flushChange();
    if (line.startsWith(' ')) {
      const context = line.slice(1);
      before.push(context);
      after.push(context);
    } else if (line.startsWith('\\ No newline')) {
      before.push(line);
      after.push(line);
    }
  }
  flushChange();
  return { before: before.join('\n'), after: after.join('\n') };
}
