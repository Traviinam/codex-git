import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { PROTOCOL_LIMITS, type DiffResult } from '@codex-git/protocol';

import type { PublishedWorktreeSnapshot } from './repository-publication.js';
import type { GitReader } from './repository-observation.js';

const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
const DIFF_PROCESS_OUTPUT_LIMIT_BYTES = PROTOCOL_LIMITS.diffOutputBytes - 1;

export async function readChangedFileDiff(
  worktree: PublishedWorktreeSnapshot,
  fileId: PublishedWorktreeSnapshot['changes'][number]['fileId'],
  readGit: GitReader,
): Promise<DiffResult> {
  const change = worktree.changes.find(
    (candidate) => candidate.fileId === fileId,
  );
  if (change === undefined || worktree.canonicalPath === null) {
    throw new Error('The Changed File target is stale or unavailable.');
  }
  if (change.baseline === 'conflict') {
    return readBytePathDiff(worktree, change, readGit);
  }
  const relativePath = decodePath(change.pathBytes);
  const previousRelativePath =
    change.previousPathBytes === null
      ? null
      : decodePath(change.previousPathBytes);
  if (
    relativePath === null ||
    (change.previousPathBytes !== null && previousRelativePath === null)
  ) {
    return readBytePathDiff(worktree, change, readGit);
  }
  const args = diffArguments(
    worktree.canonicalPath,
    relativePath,
    change.baseline,
    previousRelativePath,
  );
  let output: Uint8Array;
  try {
    output = await readGit(
      args,
      true,
      change.baseline === 'empty_to_working_tree' ? 1 : undefined,
      undefined,
      DIFF_PROCESS_OUTPUT_LIMIT_BYTES,
    );
  } catch (error) {
    if (!isOutputLimitFailure(error)) throw error;
    return {
      kind: 'too_large',
      fileId,
      baseline: change.baseline,
      byteCount: PROTOCOL_LIMITS.diffOutputBytes,
      lineCount: null,
    };
  }
  return classifyDiff(output, fileId, change.baseline);
}

function classifyDiff(
  output: Uint8Array,
  fileId: DiffResult['fileId'],
  baseline: DiffResult['baseline'],
): DiffResult {
  if (output.byteLength > PROTOCOL_LIMITS.diffOutputBytes) {
    return {
      kind: 'too_large',
      fileId,
      baseline,
      byteCount: output.byteLength,
      lineCount: lineCount(output),
    };
  }
  let content: string;
  try {
    content = fatalUtf8Decoder.decode(output);
  } catch {
    return {
      kind: 'undecodable',
      fileId,
      baseline,
      byteCount: output.byteLength,
    };
  }
  const lines = textLineCount(content);
  if (lines > 20_000) {
    return {
      kind: 'too_large',
      fileId,
      baseline,
      byteCount: output.byteLength,
      lineCount: lines,
    };
  }
  if (/^Binary files .* differ$/mu.test(content)) {
    return {
      kind: 'binary',
      fileId,
      baseline,
      byteCount: output.byteLength,
    };
  }
  return {
    kind: 'text',
    fileId,
    baseline,
    content,
    lineCount: lines,
  };
}

async function readBytePathDiff(
  worktree: PublishedWorktreeSnapshot,
  change: PublishedWorktreeSnapshot['changes'][number],
  readGit: GitReader,
): Promise<DiffResult> {
  const worktreePath = worktree.canonicalPath;
  if (worktreePath === null) {
    throw new Error('The Changed File target is stale or unavailable.');
  }
  const previousPath = change.previousPathBytes ?? change.pathBytes;
  let conflictMetadata: Uint8Array = new Uint8Array();
  let before: BoundedContent;
  let after: BoundedContent;
  if (change.baseline === 'head_to_index') {
    before = await readHeadContent(worktree, previousPath, readGit);
    after = await readIndexContent(worktreePath, change.pathBytes, readGit);
  } else if (change.baseline === 'index_to_working_tree') {
    before = await readIndexContent(worktreePath, previousPath, readGit);
    after = await readWorkingContent(worktreePath, change.pathBytes);
  } else if (change.baseline === 'conflict') {
    conflictMetadata = await readConflictStageMetadata(
      worktreePath,
      change.pathBytes,
      readGit,
    );
    before = { kind: 'content', bytes: new Uint8Array() };
    after = await readWorkingContent(worktreePath, change.pathBytes);
  } else {
    before = { kind: 'content', bytes: new Uint8Array() };
    after = await readWorkingContent(worktreePath, change.pathBytes);
  }
  if (before.kind === 'too_large') {
    return {
      kind: 'too_large',
      fileId: change.fileId,
      baseline: change.baseline,
      byteCount: before.byteCount,
      lineCount: null,
    };
  }
  if (after.kind === 'too_large') {
    return {
      kind: 'too_large',
      fileId: change.fileId,
      baseline: change.baseline,
      byteCount: after.byteCount,
      lineCount: null,
    };
  }
  const directory = await mkdtemp(join(tmpdir(), 'codex-git-diff-'));
  const beforePath = join(directory, 'before');
  const afterPath = join(directory, 'after');
  try {
    await Promise.all([
      writeFile(beforePath, before.bytes),
      writeFile(afterPath, after.bytes),
    ]);
    const output = await readBoundedDiff(
      readGit,
      [
        'diff',
        '--no-index',
        '--no-ext-diff',
        '--no-textconv',
        '--',
        beforePath,
        afterPath,
      ],
      true,
    );
    if (output === null) {
      return {
        kind: 'too_large',
        fileId: change.fileId,
        baseline: change.baseline,
        byteCount: PROTOCOL_LIMITS.diffOutputBytes,
        lineCount: null,
      };
    }
    const rewritten = rewriteTemporaryPaths(
      output,
      beforePath,
      afterPath,
      change.displayPath,
    );
    return classifyDiff(
      concatenateBytes(conflictMetadata, rewritten),
      change.fileId,
      change.baseline,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function readConflictStageMetadata(
  worktreePath: string,
  pathBytes: Uint8Array,
  readGit: GitReader,
): Promise<Uint8Array> {
  const index = await readGit(
    ['-C', worktreePath, 'ls-files', '--stage', '-z'],
    true,
  );
  const stages = new Set<number>();
  for (const record of splitNul(index)) {
    const separator = record.indexOf(0x09);
    if (
      separator < 0 ||
      !equalBytes(record.subarray(separator + 1), pathBytes)
    ) {
      continue;
    }
    const header = new TextDecoder().decode(record.subarray(0, separator));
    const match = /^\d+ [0-9a-f]{40,64} ([123])$/u.exec(header);
    if (match !== null) stages.add(Number(match[1]));
  }
  const present = (stage: number) => (stages.has(stage) ? 'present' : 'absent');
  return new TextEncoder().encode(
    `Conflict index stages: base=${present(1)}; ours=${present(2)}; theirs=${present(3)}.\n`,
  );
}

function concatenateBytes(prefix: Uint8Array, content: Uint8Array): Uint8Array {
  if (prefix.byteLength === 0) return content;
  const combined = new Uint8Array(prefix.byteLength + content.byteLength);
  combined.set(prefix);
  combined.set(content, prefix.byteLength);
  return combined;
}

type BoundedContent =
  | { readonly kind: 'content'; readonly bytes: Uint8Array }
  | { readonly kind: 'too_large'; readonly byteCount: number };

async function readHeadContent(
  worktree: PublishedWorktreeSnapshot,
  pathBytes: Uint8Array,
  readGit: GitReader,
): Promise<BoundedContent> {
  if (worktree.canonicalPath === null || worktree.head.objectId === null) {
    return { kind: 'content', bytes: new Uint8Array() };
  }
  const tree = await readGit(
    [
      '-C',
      worktree.canonicalPath,
      'ls-tree',
      '-r',
      '-z',
      worktree.head.objectId,
    ],
    true,
  );
  return readBlob(
    worktree.canonicalPath,
    findTreeBlob(tree, pathBytes),
    readGit,
  );
}

async function readIndexContent(
  worktreePath: string,
  pathBytes: Uint8Array,
  readGit: GitReader,
): Promise<BoundedContent> {
  const index = await readGit(
    ['-C', worktreePath, 'ls-files', '--stage', '-z'],
    true,
  );
  return readBlob(worktreePath, findIndexBlob(index, pathBytes), readGit);
}

async function readBlob(
  worktreePath: string,
  objectId: string | null,
  readGit: GitReader,
): Promise<BoundedContent> {
  if (objectId === null) return { kind: 'content', bytes: new Uint8Array() };
  try {
    return {
      kind: 'content',
      bytes: await readGit(
        ['-C', worktreePath, 'cat-file', 'blob', objectId],
        true,
        undefined,
        undefined,
        DIFF_PROCESS_OUTPUT_LIMIT_BYTES,
      ),
    };
  } catch (error) {
    if (!isOutputLimitFailure(error)) throw error;
    return {
      kind: 'too_large',
      byteCount: PROTOCOL_LIMITS.diffOutputBytes,
    };
  }
}

async function readWorkingContent(
  worktreePath: string,
  pathBytes: Uint8Array,
): Promise<BoundedContent> {
  const path = exactWorkingPath(worktreePath, pathBytes);
  try {
    const metadata = await lstat(path);
    if (metadata.size >= DIFF_PROCESS_OUTPUT_LIMIT_BYTES) {
      return { kind: 'too_large', byteCount: metadata.size };
    }
    return {
      kind: 'content',
      bytes: metadata.isSymbolicLink()
        ? await readlink(path, { encoding: 'buffer' })
        : await readFile(path),
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'content', bytes: new Uint8Array() };
    }
    throw error;
  }
}

function exactWorkingPath(worktreePath: string, pathBytes: Uint8Array): Buffer {
  const segments = splitBytePath(pathBytes);
  if (
    pathBytes.length === 0 ||
    pathBytes[0] === 0x2f ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        (segment.length === 1 && segment[0] === 0x2e) ||
        (segment.length === 2 && segment[0] === 0x2e && segment[1] === 0x2e),
    )
  ) {
    throw new Error('The Changed File path escapes its Worktree.');
  }
  return Buffer.concat([
    Buffer.from(worktreePath),
    Buffer.from(sep),
    Buffer.from(pathBytes),
  ]);
}

function splitBytePath(path: Uint8Array): readonly Uint8Array[] {
  const segments: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index <= path.length; index += 1) {
    if (index === path.length || path[index] === 0x2f) {
      segments.push(path.subarray(start, index));
      start = index + 1;
    }
  }
  return segments;
}

function findIndexBlob(
  output: Uint8Array,
  pathBytes: Uint8Array,
): string | null {
  for (const record of splitNul(output)) {
    const separator = record.indexOf(0x09);
    if (
      separator < 0 ||
      !equalBytes(record.subarray(separator + 1), pathBytes)
    ) {
      continue;
    }
    const header = new TextDecoder().decode(record.subarray(0, separator));
    const match = /^\d+ ([0-9a-f]{40}|[0-9a-f]{64}) 0$/u.exec(header);
    if (match !== null) return match[1]!;
  }
  return null;
}

function findTreeBlob(
  output: Uint8Array,
  pathBytes: Uint8Array,
): string | null {
  for (const record of splitNul(output)) {
    const separator = record.indexOf(0x09);
    if (
      separator < 0 ||
      !equalBytes(record.subarray(separator + 1), pathBytes)
    ) {
      continue;
    }
    const header = new TextDecoder().decode(record.subarray(0, separator));
    const match = /^\d+ blob ([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(header);
    if (match !== null) return match[1]!;
  }
  return null;
}

function splitNul(output: Uint8Array): readonly Uint8Array[] {
  const records: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    records.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start < output.length) records.push(output.subarray(start));
  return records;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

async function readBoundedDiff(
  readGit: GitReader,
  args: readonly string[],
  acceptsDifference: boolean,
): Promise<Uint8Array | null> {
  try {
    return await readGit(
      args,
      true,
      acceptsDifference ? 1 : undefined,
      undefined,
      DIFF_PROCESS_OUTPUT_LIMIT_BYTES,
    );
  } catch (error) {
    if (isOutputLimitFailure(error)) return null;
    throw error;
  }
}

function rewriteTemporaryPaths(
  output: Uint8Array,
  beforePath: string,
  afterPath: string,
  displayPath: string,
): Uint8Array {
  let content: string;
  try {
    content = fatalUtf8Decoder.decode(output);
  } catch {
    return output;
  }
  const label = JSON.stringify(displayPath);
  return new TextEncoder().encode(
    content
      .replaceAll(beforePath, `a/${label}`)
      .replaceAll(afterPath, `b/${label}`),
  );
}

function isOutputLimitFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    'failure' in error &&
    error.failure === 'output_too_large'
  );
}

function diffArguments(
  worktreePath: string,
  relativePath: string,
  baseline: PublishedWorktreeSnapshot['changes'][number]['baseline'],
  previousRelativePath: string | null,
): readonly string[] {
  const literalPath = `:(literal)${relativePath}`;
  const pathspecs =
    previousRelativePath === null
      ? [literalPath]
      : [`:(literal)${previousRelativePath}`, literalPath];
  if (baseline === 'head_to_index') {
    return [
      '-C',
      worktreePath,
      'diff',
      '--cached',
      '--no-ext-diff',
      '--no-textconv',
      '--',
      ...pathspecs,
    ];
  }
  if (baseline === 'index_to_working_tree') {
    return [
      '-C',
      worktreePath,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--',
      ...pathspecs,
    ];
  }
  if (baseline === 'conflict') {
    return [
      '-C',
      worktreePath,
      'diff',
      '--cc',
      '--no-ext-diff',
      '--no-textconv',
      '--',
      ...pathspecs,
    ];
  }
  const absolutePath = resolve(worktreePath, relativePath);
  if (
    absolutePath !== worktreePath &&
    !absolutePath.startsWith(`${worktreePath}${sep}`)
  ) {
    throw new Error('The Changed File path escapes its Worktree.');
  }
  return [
    '-C',
    worktreePath,
    'diff',
    '--no-index',
    '--no-ext-diff',
    '--no-textconv',
    '--',
    '/dev/null',
    absolutePath,
  ];
}

function decodePath(path: Uint8Array): string | null {
  try {
    return fatalUtf8Decoder.decode(path);
  } catch {
    return null;
  }
}

function lineCount(output: Uint8Array): number | null {
  try {
    return textLineCount(fatalUtf8Decoder.decode(output));
  } catch {
    return null;
  }
}

function textLineCount(value: string): number {
  if (value.length === 0) return 0;
  const breaks = value.match(/\n/gu)?.length ?? 0;
  return value.endsWith('\n') ? breaks : breaks + 1;
}
