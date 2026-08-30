import {
  chmod,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import type { AbsolutePath, ClientCommandId } from '@codex-git/protocol';
import { createRepositoryEngine } from '@codex-git/repository-engine';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTemporaryGitRepository,
  type TemporaryGitRepository,
} from '../fixtures/temporary-git-repository.js';

const repositories: TemporaryGitRepository[] = [];
const externalPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((repository) => repository.dispose()),
  );
  await Promise.all(
    externalPaths
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe('Repository Stage and Unstage', () => {
  it('stages a Changed File in only the selected Worktree Index', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git('branch', 'linked');
    const linkedPath = `${repository.path}-linked`;
    externalPaths.push(linkedPath);
    await repository.git('worktree', 'add', '--quiet', linkedPath, 'linked');
    await writeFile(join(repository.path, 'README.md'), 'main change\n');
    await writeFile(join(linkedPath, 'README.md'), 'linked change\n');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const main = opened.repository.worktrees.find(
      ({ role }) => role === 'main',
    );
    if (main === undefined) throw new Error('Expected Main Worktree');
    const changed = main.changes.find(({ kind }) => kind === 'change');
    if (changed === undefined) throw new Error('Expected Change');

    const receipt = await session.dispatch({
      clientCommandId: commandId(1),
      command: {
        kind: 'stage',
        worktreeId: main.worktreeId,
        expectedWorktreeRevision: main.worktreeRevision,
        fileIds: [changed.fileId],
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'succeeded',
      result: { kind: 'files', affectedCount: 1 },
    });
    expect(
      (await repository.git('diff', '--cached', '--', 'README.md')).stdout,
    ).toContain('+main change');
    expect(
      (
        await repository.git(
          '-C',
          linkedPath,
          'diff',
          '--cached',
          '--',
          'README.md',
        )
      ).stdout,
    ).toBe('');
    await session.close();
  });

  it('unstages a Staged Change without modifying Working Tree bytes', async () => {
    const repository = await createRepositoryWithCommit();
    const workingBytes = Buffer.from('staged content\nworking content\n');
    await writeFile(join(repository.path, 'README.md'), 'staged content\n');
    await repository.git('add', 'README.md');
    await writeFile(join(repository.path, 'README.md'), workingBytes);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0];
    if (worktree === undefined) throw new Error('Expected Worktree');
    const staged = worktree.changes.find(
      ({ kind }) => kind === 'staged_change',
    );
    if (staged === undefined) throw new Error('Expected Staged Change');

    const receipt = await session.dispatch({
      clientCommandId: commandId(2),
      command: {
        kind: 'unstage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: [staged.fileId],
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'succeeded',
      result: { kind: 'files', affectedCount: 1 },
    });
    expect(
      (await repository.git('diff', '--cached', '--', 'README.md')).stdout,
    ).toBe('');
    expect(await readFile(join(repository.path, 'README.md'))).toEqual(
      workingBytes,
    );
    await session.close();
  });

  it('unstages safely before the Initial Commit', async () => {
    const repository = await createTemporaryGitRepository();
    repositories.push(repository);
    const workingBytes = Buffer.from('initial content\n');
    await writeFile(join(repository.path, 'new file.txt'), workingBytes);
    await repository.git('add', 'new file.txt');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0];
    if (worktree === undefined) throw new Error('Expected Worktree');
    const staged = worktree.changes.find(
      ({ kind }) => kind === 'staged_change',
    );
    if (staged === undefined) throw new Error('Expected Staged Change');

    const receipt = await session.dispatch({
      clientCommandId: commandId(3),
      command: {
        kind: 'unstage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: [staged.fileId],
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'succeeded',
      result: { kind: 'files', affectedCount: 1 },
    });
    expect(
      (await repository.git('diff', '--cached', '--', 'new file.txt')).stdout,
    ).toBe('');
    expect((await repository.git('status', '--short', '-z')).stdout).toContain(
      '?? new file.txt',
    );
    expect(await readFile(join(repository.path, 'new file.txt'))).toEqual(
      workingBytes,
    );
    await session.close();
  });

  it('rejects stale file evidence and returns current Worktree state', async () => {
    const repository = await createRepositoryWithCommit();
    await writeFile(join(repository.path, 'README.md'), 'reviewed change\n');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0];
    const reviewed = worktree?.changes.find(({ kind }) => kind === 'change');
    if (worktree === undefined || reviewed === undefined) {
      throw new Error('Expected reviewed Change');
    }
    await writeFile(join(repository.path, 'README.md'), 'external change\n');

    const receipt = await session.dispatch({
      clientCommandId: commandId(4),
      command: {
        kind: 'stage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: [reviewed.fileId],
      },
    });
    const result = await session.recoverOperation(receipt.operationId);
    const current = await session.requestRefresh();

    expect(result).toMatchObject({ kind: 'rejected', code: 'stale' });
    expect(
      (await repository.git('diff', '--cached', '--', 'README.md')).stdout,
    ).toBe('');
    expect(current).toMatchObject({
      kind: 'repository',
      repository: {
        worktrees: [
          expect.objectContaining({
            changes: [
              expect.objectContaining({
                kind: 'change',
                displayPath: 'README.md',
              }),
            ],
          }),
        ],
      },
    });
    if (current.kind !== 'repository') throw new Error('Expected Repository');
    expect(current.repository.worktrees[0]?.changes[0]?.fileId).not.toBe(
      reviewed.fileId,
    );
    await session.close();
  });

  it('reports per-path Partial Success without rollback claims', async () => {
    const repository = await createTemporaryGitRepository();
    repositories.push(repository);
    await repository.git('config', 'user.email', 'codex-git@example.invalid');
    await repository.git('config', 'user.name', 'Codex Git');
    await writeFile(
      join(repository.path, '.gitattributes'),
      'gate.txt filter=gate\nbad.txt filter=reject\n',
    );
    await writeFile(join(repository.path, 'good.txt'), 'initial good\n');
    await writeFile(join(repository.path, 'bad.txt'), 'initial bad\n');
    await writeFile(join(repository.path, 'gate.txt'), 'initial gate\n');
    await repository.git(
      'add',
      '.gitattributes',
      'good.txt',
      'bad.txt',
      'gate.txt',
    );
    await repository.git('commit', '--quiet', '-m', 'Initial fixture');
    const gatePath = join(repository.path, '..', 'codex-git-gate-filter');
    const signalPath = join(repository.path, '..', 'codex-git-gate-signal');
    const releasePath = join(repository.path, '..', 'codex-git-gate-release');
    const rejectPath = join(repository.path, '..', 'codex-git-reject-filter');
    const rejectCountPath = join(
      repository.path,
      '..',
      'codex-git-reject-count',
    );
    externalPaths.push(
      gatePath,
      signalPath,
      releasePath,
      rejectPath,
      rejectCountPath,
    );
    await writeFile(
      gatePath,
      '#!/bin/sh\ntouch "$1"\nwhile [ ! -f "$2" ]; do sleep 0.01; done\ncat\n',
    );
    await chmod(gatePath, 0o700);
    await writeFile(
      rejectPath,
      '#!/bin/sh\ncount=$(cat "$1")\ncount=$((count + 1))\nprintf "%s" "$count" > "$1"\nif [ "$count" -eq 1 ]; then exit 1; fi\ncat\n',
    );
    await chmod(rejectPath, 0o700);
    await writeFile(rejectCountPath, '0');
    await writeFile(join(repository.path, 'good.txt'), 'changed good\n');
    await writeFile(join(repository.path, 'bad.txt'), 'changed bad\n');
    await writeFile(join(repository.path, 'gate.txt'), 'changed gate\n');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0];
    if (worktree === undefined) throw new Error('Expected Worktree');
    const good = worktree.changes.find(
      ({ displayPath }) => displayPath === 'good.txt',
    );
    const bad = worktree.changes.find(
      ({ displayPath }) => displayPath === 'bad.txt',
    );
    if (good === undefined || bad === undefined) {
      throw new Error('Expected two Changes');
    }
    await repository.git(
      'config',
      'filter.gate.clean',
      `${gatePath} ${signalPath} ${releasePath}`,
    );

    const receipt = await session.dispatch({
      clientCommandId: commandId(5),
      command: {
        kind: 'stage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: [good.fileId, bad.fileId],
      },
    });
    await waitForPath(signalPath);
    await repository.git(
      'config',
      'filter.reject.clean',
      `${rejectPath} ${rejectCountPath}`,
    );
    await repository.git('config', 'filter.reject.required', 'true');
    await writeFile(releasePath, 'continue');
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'partial_success',
      effects: [
        {
          label: 'good.txt',
          kind: 'failed_known',
          code: 'process_failed',
        },
        { label: 'bad.txt', kind: 'succeeded' },
      ],
    });
    expect(
      (await repository.git('diff', '--cached', '--', 'good.txt')).stdout,
    ).toBe('');
    expect(
      (await repository.git('diff', '--cached', '--', 'bad.txt')).stdout,
    ).toContain('+changed bad');
    await session.close();
  });

  it('passes unusual paths literally through group Stage', async () => {
    const repository = await createRepositoryWithCommit();
    const paths = [
      '-leading.txt',
      'space name.txt',
      'unicodé.txt',
      'line\nbreak.txt',
    ];
    await Promise.all(
      paths.map((path) =>
        writeFile(join(repository.path, path), `content for ${path}\n`),
      ),
    );
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0];
    if (worktree === undefined) throw new Error('Expected Worktree');
    const untracked = worktree.changes.filter(
      ({ kind }) => kind === 'untracked',
    );

    const receipt = await session.dispatch({
      clientCommandId: commandId(6),
      command: {
        kind: 'stage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: untracked.map(({ fileId }) => fileId),
      },
    });
    const result = await session.recoverOperation(receipt.operationId);
    const stagedPaths = (await repository.git('ls-files', '-z')).stdout
      .split('\0')
      .filter(Boolean);

    expect(result).toMatchObject({
      kind: 'succeeded',
      result: { kind: 'files', affectedCount: 4 },
    });
    expect(stagedPaths).toEqual(expect.arrayContaining(paths));
    await session.close();
  });

  it('rejects Conflict entries without mutating the Index', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git('switch', '--quiet', '-c', 'other');
    await writeFile(join(repository.path, 'README.md'), 'other\n');
    await repository.git('commit', '--quiet', '-am', 'Other change');
    await repository.git('switch', '--quiet', '-');
    await writeFile(join(repository.path, 'README.md'), 'current\n');
    await repository.git('commit', '--quiet', '-am', 'Current change');
    await expect(repository.git('merge', 'other')).rejects.toThrow();
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0];
    const conflict = worktree?.changes.find(({ kind }) => kind === 'conflict');
    if (worktree === undefined || conflict === undefined) {
      throw new Error('Expected Conflict');
    }
    const indexBefore = (await repository.git('ls-files', '--stage', '-z'))
      .stdout;

    const receipt = await session.dispatch({
      clientCommandId: commandId(7),
      command: {
        kind: 'stage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: [conflict.fileId],
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'rejected',
      code: 'unsupported_state',
    });
    expect((await repository.git('ls-files', '--stage', '-z')).stdout).toBe(
      indexBefore,
    );
    await session.close();
  });

  it('stages renames and deletions from their opaque Changed File targets', async () => {
    const repository = await createRepositoryWithCommit();
    await writeFile(join(repository.path, 'old.txt'), 'rename me\n');
    await writeFile(join(repository.path, 'delete.txt'), 'delete me\n');
    await repository.git('add', 'old.txt', 'delete.txt');
    await repository.git('commit', '--quiet', '-m', 'Path fixtures');
    await rename(
      join(repository.path, 'old.txt'),
      join(repository.path, 'new.txt'),
    );
    await unlink(join(repository.path, 'delete.txt'));
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0];
    if (worktree === undefined) throw new Error('Expected Worktree');

    const receipt = await session.dispatch({
      clientCommandId: commandId(8),
      command: {
        kind: 'stage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: worktree.changes
          .filter(({ kind }) => kind === 'change' || kind === 'untracked')
          .map(({ fileId }) => fileId),
      },
    });
    const result = await session.recoverOperation(receipt.operationId);
    const staged = (
      await repository.git('diff', '--cached', '--name-status', '-M')
    ).stdout;

    expect(result).toMatchObject({ kind: 'succeeded' });
    expect(staged).toContain('delete.txt');
    expect(staged).toContain('old.txt');
    expect(staged).toContain('new.txt');
    await session.close();
  });

  it('rejects a removed and recreated Worktree generation before mutation', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git('branch', 'linked');
    const linkedPath = `${repository.path}-recreated`;
    externalPaths.push(linkedPath);
    await repository.git('worktree', 'add', '--quiet', linkedPath, 'linked');
    await writeFile(join(linkedPath, 'README.md'), 'reviewed linked change\n');
    const session = await createRepositoryEngine().open(
      linkedPath as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const linked = opened.repository.worktrees.find(
      ({ role }) => role === 'linked',
    );
    const change = linked?.changes.find(({ kind }) => kind === 'change');
    if (linked === undefined || change === undefined) {
      throw new Error('Expected linked Change');
    }
    await repository.git('worktree', 'remove', '--force', linkedPath);
    await repository.git('worktree', 'add', '--quiet', linkedPath, 'linked');
    await writeFile(join(linkedPath, 'README.md'), 'replacement change\n');

    const receipt = await session.dispatch({
      clientCommandId: commandId(9),
      command: {
        kind: 'stage',
        worktreeId: linked.worktreeId,
        expectedWorktreeRevision: linked.worktreeRevision,
        fileIds: [change.fileId],
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({ kind: 'rejected', code: 'stale' });
    expect(
      (await repository.git('-C', linkedPath, 'diff', '--cached')).stdout,
    ).toBe('');
    await session.close();
  });

  it('treats pathspec-magic filenames as literal paths', async () => {
    const repository = await createRepositoryWithCommit();
    const magicPath = ':(glob)*.txt';
    await writeFile(join(repository.path, magicPath), 'literal magic path\n');
    await writeFile(
      join(repository.path, 'other.txt'),
      'must stay untracked\n',
    );
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const magic = worktree.changes.find(
      ({ displayPath }) => displayPath === magicPath,
    );
    if (magic === undefined) throw new Error('Expected magic-path file');

    const receipt = await session.dispatch({
      clientCommandId: commandId(10),
      command: {
        kind: 'stage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: [magic.fileId],
      },
    });
    const result = await session.recoverOperation(receipt.operationId);
    const staged = (await repository.git('ls-files', '-z')).stdout.split('\0');

    expect(result).toMatchObject({ kind: 'succeeded' });
    expect(staged).toContain(magicPath);
    expect(staged).not.toContain('other.txt');
    await session.close();
  });

  it('force-removes an Initial Commit Index entry after another Working Tree edit', async () => {
    const repository = await createTemporaryGitRepository();
    repositories.push(repository);
    const path = join(repository.path, 'new.txt');
    await writeFile(path, 'staged version\n');
    await repository.git('add', 'new.txt');
    const workingBytes = Buffer.from('edited after Stage\n');
    await writeFile(path, workingBytes);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const staged = worktree.changes.find(
      ({ kind }) => kind === 'staged_change',
    );
    if (staged === undefined) throw new Error('Expected Staged Change');

    const receipt = await session.dispatch({
      clientCommandId: commandId(11),
      command: {
        kind: 'unstage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: [staged.fileId],
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({ kind: 'succeeded' });
    expect((await repository.git('ls-files', '-z')).stdout).toBe('');
    expect(await readFile(path)).toEqual(workingBytes);
    await session.close();
  });

  it('revalidates every bulk target immediately before its Git command', async () => {
    const repository = await createTemporaryGitRepository();
    repositories.push(repository);
    await repository.git('config', 'user.email', 'codex-git@example.invalid');
    await repository.git('config', 'user.name', 'Codex Git');
    await writeFile(
      join(repository.path, '.gitattributes'),
      'gate.txt filter=gate\nfirst.txt filter=mutate-later\n',
    );
    await writeFile(join(repository.path, 'gate.txt'), 'initial gate\n');
    await writeFile(join(repository.path, 'first.txt'), 'initial first\n');
    await writeFile(join(repository.path, 'later.txt'), 'initial later\n');
    await repository.git(
      'add',
      '.gitattributes',
      'gate.txt',
      'first.txt',
      'later.txt',
    );
    await repository.git('commit', '--quiet', '-m', 'Bulk fixture');
    await writeFile(join(repository.path, 'gate.txt'), 'changed gate\n');
    await writeFile(join(repository.path, 'first.txt'), 'changed first\n');
    await writeFile(join(repository.path, 'later.txt'), 'reviewed later\n');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const first = worktree.changes.find(
      ({ displayPath }) => displayPath === 'first.txt',
    );
    const later = worktree.changes.find(
      ({ displayPath }) => displayPath === 'later.txt',
    );
    if (first === undefined || later === undefined) {
      throw new Error('Expected bulk targets');
    }
    const gateScript = `${repository.path}-bulk-gate`;
    const gateSignal = `${repository.path}-bulk-signal`;
    const gateRelease = `${repository.path}-bulk-release`;
    const mutateScript = `${repository.path}-mutate-later`;
    externalPaths.push(gateScript, gateSignal, gateRelease, mutateScript);
    await writeFile(
      gateScript,
      '#!/bin/sh\ntouch "$1"\nwhile [ ! -f "$2" ]; do sleep 0.01; done\ncat\n',
    );
    await chmod(gateScript, 0o700);
    await writeFile(
      mutateScript,
      '#!/bin/sh\nprintf "external later\\n" > "$1"\ncat\n',
    );
    await chmod(mutateScript, 0o700);
    await repository.git(
      'config',
      'filter.gate.clean',
      `${gateScript} ${gateSignal} ${gateRelease}`,
    );

    const receipt = await session.dispatch({
      clientCommandId: commandId(12),
      command: {
        kind: 'stage',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        fileIds: [first.fileId, later.fileId],
      },
    });
    await waitForPath(gateSignal);
    await repository.git(
      'config',
      'filter.mutate-later.clean',
      `${mutateScript} ${join(repository.path, 'later.txt')}`,
    );
    await writeFile(gateRelease, 'continue');
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'partial_success',
      effects: [
        { kind: 'succeeded', label: 'first.txt' },
        { kind: 'failed_known', label: 'later.txt', code: 'stale' },
      ],
    });
    expect(
      (await repository.git('diff', '--cached', '--', 'first.txt')).stdout,
    ).toContain('+changed first');
    expect(
      (await repository.git('diff', '--cached', '--', 'later.txt')).stdout,
    ).toBe('');
    await session.close();
  });

  it('keeps large and unreadable Changed Files observable with bounded evidence', async () => {
    const repository = await createRepositoryWithCommit();
    const largePath = join(repository.path, 'large.bin');
    const unreadablePath = join(repository.path, 'unreadable.txt');
    await writeFile(largePath, Buffer.alloc(5 * 1_024 * 1_024, 0x61));
    await writeFile(unreadablePath, 'unreadable evidence\n');
    await chmod(unreadablePath, 0o000);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );

    const opened = await session.requestRefresh();

    expect(opened).toMatchObject({
      kind: 'repository',
      repository: {
        refresh: { kind: 'fresh' },
        worktrees: [
          expect.objectContaining({
            freshness: { kind: 'fresh' },
            changes: expect.arrayContaining([
              expect.objectContaining({ displayPath: 'large.bin' }),
              expect.objectContaining({ displayPath: 'unreadable.txt' }),
            ]),
          }),
        ],
      },
    });
    await chmod(unreadablePath, 0o600);
    await session.close();
  });
});

async function createRepositoryWithCommit() {
  const repository = await createTemporaryGitRepository();
  repositories.push(repository);
  await repository.git('config', 'user.email', 'codex-git@example.invalid');
  await repository.git('config', 'user.name', 'Codex Git');
  await writeFile(join(repository.path, 'README.md'), 'fixture\n');
  await repository.git('add', 'README.md');
  await repository.git('commit', '--quiet', '-m', 'Initial fixture');
  return repository;
}

function commandId(value: number) {
  return `command_${value.toString(16).padStart(32, '0')}` as ClientCommandId;
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('Timed out waiting for the Git filter fixture.');
}
