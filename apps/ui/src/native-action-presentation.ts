import type {
  NativeActionRequest,
  NativeActionResult,
} from '@codex-git/protocol';

export function nativeActionLabel(kind: NativeActionRequest['kind']): string {
  switch (kind) {
    case 'open_terminal':
      return 'Open in Terminal';
    case 'reveal_in_finder':
      return 'Reveal in Finder';
    case 'copy_absolute_path':
      return 'Copy Absolute Path';
    case 'copy_branch_or_sha':
      return 'Copy Branch or SHA';
    case 'open_codex_context':
      return 'Open Codex Context';
    case 'open_file_in_codex':
      return 'Open File in Codex';
    case 'copy_relative_path':
      return 'Copy Relative Path';
    case 'open_default_app':
      return 'Open in Default App';
  }
}

export function worktreeNativeActionLabel(
  kind: NativeActionRequest['kind'],
  worktreeName: string,
): string {
  if (kind === 'open_terminal') return `Open ${worktreeName} in Terminal`;
  if (kind === 'reveal_in_finder') return `Reveal ${worktreeName} in Finder`;
  return `${nativeActionLabel(kind)} for ${worktreeName}`;
}

export interface NativeActionPresentation {
  copied(request: NativeActionRequest): string;
  copyFallback(request: NativeActionRequest, text: string): string;
  failed: string;
  performed(request: NativeActionRequest): string;
}

export async function performPresentedNativeAction(
  request: NativeActionRequest,
  run: (request: NativeActionRequest) => Promise<NativeActionResult>,
  publish: (message: string) => void,
  presentation: NativeActionPresentation,
): Promise<void> {
  try {
    const result = await run(request);
    if (result.kind === 'unavailable') {
      publish(result.message);
      return;
    }
    if (result.kind === 'performed') {
      publish(presentation.performed(request));
      return;
    }
    if (globalThis.navigator.clipboard === undefined) {
      publish(presentation.copyFallback(request, result.text));
      return;
    }
    await globalThis.navigator.clipboard.writeText(result.text);
    publish(presentation.copied(request));
  } catch {
    publish(presentation.failed);
  }
}
