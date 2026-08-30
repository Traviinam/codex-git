import { useState } from 'react';

import type {
  FileId,
  NativeActionRequest,
  NativeActionResult,
} from '@codex-git/protocol';

import type { WorktreeOverviewSnapshot } from './repository-overview-model.js';
import type { DiffLoadState } from './repository-store.js';
import { presentSideBySide } from './diff-presentation.js';

export function DiffReview({
  worktree,
  selectedFileId,
  diff,
  onSelect,
  onNativeAction,
}: {
  readonly worktree: WorktreeOverviewSnapshot;
  readonly selectedFileId: FileId | null;
  readonly diff: DiffLoadState;
  readonly onSelect: (fileId: FileId) => void;
  readonly onNativeAction: (
    request: NativeActionRequest,
  ) => Promise<NativeActionResult>;
}) {
  const [layout, setLayout] = useState<'side-by-side' | 'unified'>(
    'side-by-side',
  );
  const [actionStatus, setActionStatus] = useState<{
    readonly fileId: FileId;
    readonly message: string;
  } | null>(null);
  if (selectedFileId === null) {
    return <p>Select a Changed File to review its Diff.</p>;
  }
  const selected = worktree.changes.find(
    ({ fileId }) => fileId === selectedFileId,
  );
  if (selected === undefined) {
    return <p>The selected Changed File is no longer available.</p>;
  }
  const navigation = worktree.changes.filter(
    ({ kind }) => kind === selected.kind,
  );
  const index = navigation.findIndex(({ fileId }) => fileId === selectedFileId);
  const previous = navigation[index - 1];
  const next = navigation[index + 1];
  return (
    <div className="diff-review">
      <header>
        <div>
          <strong>{selected.displayPath}</strong>
          <span>
            {index + 1} / {navigation.length}
          </span>
        </div>
        <div>
          <button
            aria-label="Previous Changed File"
            disabled={previous === undefined}
            type="button"
            onClick={() => previous !== undefined && onSelect(previous.fileId)}
          >
            Previous
          </button>
          <button
            aria-label="Next Changed File"
            disabled={next === undefined}
            type="button"
            onClick={() => next !== undefined && onSelect(next.fileId)}
          >
            Next
          </button>
          <button
            aria-label={
              layout === 'side-by-side'
                ? 'Show unified diff'
                : 'Show side-by-side diff'
            }
            type="button"
            onClick={() =>
              setLayout((current) =>
                current === 'side-by-side' ? 'unified' : 'side-by-side',
              )
            }
          >
            {layout === 'side-by-side' ? 'Side-by-side' : 'Unified'}
          </button>
        </div>
      </header>
      <DiffContent diff={diff} layout={layout} />
      <div className="diff-native-actions">
        {selected.nativeTargets.flatMap((target) =>
          target.actions
            .filter(
              (kind) =>
                kind === 'open_default_app' || kind === 'copy_relative_path',
            )
            .map((kind) => (
              <button
                aria-label={
                  kind === 'open_default_app'
                    ? 'Open in Default App'
                    : 'Copy Relative Path'
                }
                key={`${target.targetId}:${kind}`}
                type="button"
                onClick={() =>
                  void performNativeAction(
                    { kind, targetId: target.targetId },
                    onNativeAction,
                    (message) =>
                      setActionStatus({ fileId: selectedFileId, message }),
                  )
                }
              >
                {kind === 'open_default_app'
                  ? 'Open in Default App'
                  : 'Copy Relative Path'}
              </button>
            )),
        )}
      </div>
      {actionStatus?.fileId !== selectedFileId ? null : (
        <p role="status">{actionStatus.message}</p>
      )}
    </div>
  );
}

async function performNativeAction(
  request: NativeActionRequest,
  run: (request: NativeActionRequest) => Promise<NativeActionResult>,
  publish: (message: string) => void,
): Promise<void> {
  try {
    const result = await run(request);
    if (result.kind === 'unavailable') {
      publish(result.message);
      return;
    }
    if (result.kind === 'performed') {
      publish('Opened the current Changed File.');
      return;
    }
    if (globalThis.navigator.clipboard === undefined) {
      publish(`Relative path: ${result.text}`);
      return;
    }
    await globalThis.navigator.clipboard.writeText(result.text);
    publish('Copied the relative path.');
  } catch {
    publish('The file action could not be completed. Refresh and try again.');
  }
}

function DiffContent({
  diff,
  layout,
}: {
  readonly diff: DiffLoadState;
  readonly layout: 'side-by-side' | 'unified';
}) {
  if (diff.kind === 'idle' || diff.kind === 'loading') {
    return <p role="status">Loading Diff…</p>;
  }
  if (diff.kind === 'failed') return <p role="alert">{diff.message}</p>;
  const result = diff.result;
  if (result.kind === 'binary') {
    return <p>Binary file · {formatBytes(result.byteCount)}</p>;
  }
  if (result.kind === 'undecodable') {
    return (
      <p>
        Text encoding could not be decoded · {formatBytes(result.byteCount)}
      </p>
    );
  }
  if (result.kind === 'too_large') {
    return (
      <p>
        Diff is too large to display · {formatBytes(result.byteCount)}
        {result.lineCount === null ? '' : ` · ${result.lineCount} lines`}
      </p>
    );
  }
  const conflictMetadataPrefix = 'Conflict index stages: ';
  const firstLineBreak = result.content.indexOf('\n');
  const conflictMetadata =
    result.baseline === 'conflict' &&
    result.content.startsWith(conflictMetadataPrefix)
      ? result.content.slice(
          0,
          firstLineBreak === -1 ? undefined : firstLineBreak,
        )
      : null;
  const content =
    conflictMetadata === null || firstLineBreak === -1
      ? result.content
      : result.content.slice(firstLineBreak + 1);
  if (layout === 'unified') {
    return (
      <>
        {conflictMetadata === null ? null : (
          <p aria-label="Conflict Index Stages">{conflictMetadata}</p>
        )}
        <pre aria-label="Unified Diff">{content}</pre>
      </>
    );
  }
  const { before, after } = presentSideBySide(content);
  return (
    <>
      {conflictMetadata === null ? null : (
        <p aria-label="Conflict Index Stages">{conflictMetadata}</p>
      )}
      <div aria-label="Side-by-side Diff" className="diff-columns">
        <pre aria-label="Before">{before}</pre>
        <pre aria-label="After">{after}</pre>
      </div>
    </>
  );
}

function formatBytes(byteCount: number): string {
  return `${new Intl.NumberFormat('en').format(byteCount)} bytes`;
}
