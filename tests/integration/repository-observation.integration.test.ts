import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AbsolutePath } from '@codex-git/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRepositoryEngine,
  type RepositorySession,
  type RepositorySnapshot,
} from '@codex-git/repository-engine';

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

describe('Repository observation', () => {
  it('publishes independent Changed Files for every observed Diff Baseline', async () => {
    const repository = await createRepositoryWithCommit();
    await writeFile(join(repository.path, 'README.md'), 'staged\n');
    await repository.git('add', '--', 'README.md');
    await writeFile(join(repository.path, 'README.md'), 'unstaged\n');
    await writeFile(join(repository.path, 'untracked.txt'), 'untracked\n');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );

    const snapshot = await snapshotRepository(session);
    const changes = snapshot.worktrees[0]?.changes ?? [];
    const readme = changes.filter(
      ({ displayPath }) => displayPath === 'README.md',
    );

    expect(readme).toEqual([
      expect.objectContaining({
        fileId: expect.stringMatching(/^file_[0-9a-f]{32}$/u),
        kind: 'staged_change',
        baseline: 'head_to_index',
      }),
      expect.objectContaining({
        fileId: expect.stringMatching(/^file_[0-9a-f]{32}$/u),
        kind: 'change',
        baseline: 'index_to_working_tree',
      }),
    ]);
    expect(readme[0]?.fileId).not.toBe(readme[1]?.fileId);
    expect(changes).toContainEqual(
      expect.objectContaining({
        fileId: expect.stringMatching(/^file_[0-9a-f]{32}$/u),
        kind: 'untracked',
        baseline: 'empty_to_working_tree',
        displayPath: 'untracked.txt',
      }),
    );
    await session.close();
  });

  it('reads staged, unstaged, and Untracked diffs through opaque File IDs', async () => {
    const repository = await createRepositoryWithCommit();
    await writeFile(join(repository.path, 'README.md'), 'staged\n');
    await repository.git('add', '--', 'README.md');
    await writeFile(join(repository.path, 'README.md'), 'unstaged\n');
    await writeFile(join(repository.path, 'untracked.txt'), 'untracked\n');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const snapshot = await snapshotRepository(session);
    const changes = snapshot.worktrees[0]?.changes ?? [];
    const staged = changes.find(({ kind }) => kind === 'staged_change')!;
    const unstaged = changes.find(({ kind }) => kind === 'change')!;
    const untracked = changes.find(({ kind }) => kind === 'untracked')!;

    const [stagedDiff, unstagedDiff, untrackedDiff] = await Promise.all([
      session.diff(staged.fileId),
      session.diff(unstaged.fileId),
      session.diff(untracked.fileId),
    ]);

    expect(stagedDiff).toMatchObject({
      kind: 'text',
      fileId: staged.fileId,
      baseline: 'head_to_index',
    });
    expect(stagedDiff.kind === 'text' ? stagedDiff.content : '').toContain(
      '+staged',
    );
    expect(stagedDiff.kind === 'text' ? stagedDiff.content : '').not.toContain(
      'unstaged',
    );
    expect(unstagedDiff).toMatchObject({
      kind: 'text',
      fileId: unstaged.fileId,
      baseline: 'index_to_working_tree',
    });
    expect(unstagedDiff.kind === 'text' ? unstagedDiff.content : '').toContain(
      '+unstaged',
    );
    expect(untrackedDiff).toMatchObject({
      kind: 'text',
      fileId: untracked.fileId,
      baseline: 'empty_to_working_tree',
    });
    expect(
      untrackedDiff.kind === 'text' ? untrackedDiff.content : '',
    ).toContain('+untracked');
    await session.close();
  });

  it('keeps File IDs stable only while their Worktree revision is unchanged', async () => {
    const repository = await createRepositoryWithCommit();
    await writeFile(join(repository.path, 'README.md'), 'first change\n');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );

    const initial = await snapshotRepository(session);
    const initialWorktree = initial.worktrees[0]!;
    const initialFileId = initialWorktree.changes[0]!.fileId;
    const unchanged = await snapshotRepository(session);

    expect(unchanged.worktrees[0]?.worktreeRevision).toBe(
      initialWorktree.worktreeRevision,
    );
    expect(unchanged.worktrees[0]?.changes[0]?.fileId).toBe(initialFileId);

    await writeFile(join(repository.path, 'untracked.txt'), 'new file\n');
    const changed = await snapshotRepository(session);
    const changedWorktree = changed.worktrees[0]!;

    expect(changedWorktree.worktreeRevision).toBe(
      initialWorktree.worktreeRevision + 1,
    );
    expect(changedWorktree.changes[0]?.fileId).not.toBe(initialFileId);
    await expect(session.diff(initialFileId)).rejects.toThrow(
      'stale or unavailable',
    );
    await session.close();
  });

  it('preserves rename origins and keeps staged deletions reviewable', async () => {
    const repository = await createRepositoryWithCommit();
    await writeFile(join(repository.path, 'rename-old.txt'), 'rename\n');
    await writeFile(join(repository.path, 'deleted.txt'), 'deleted\n');
    await repository.git('add', '--', 'rename-old.txt', 'deleted.txt');
    await repository.git('commit', '--quiet', '-m', 'Add rename fixtures');
    await repository.git('mv', '--', 'rename-old.txt', 'rename-new.txt');
    await writeFile(
      join(repository.path, 'rename-new.txt'),
      'rename\nmodified\n',
    );
    await repository.git('rm', '--quiet', '--', 'deleted.txt');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );

    const snapshot = await snapshotRepository(session);
    const staged = snapshot.worktrees[0]?.changes.filter(
      ({ kind }) => kind === 'staged_change',
    );

    expect(staged).toEqual([
      expect.objectContaining({
        displayPath: 'deleted.txt',
        previousDisplayPath: null,
      }),
      expect.objectContaining({
        displayPath: 'rename-new.txt',
        previousDisplayPath: 'rename-old.txt',
      }),
    ]);
    expect(
      snapshot.worktrees[0]?.changes.find(
        ({ kind, displayPath }) =>
          kind === 'change' && displayPath === 'rename-new.txt',
      ),
    ).toMatchObject({ previousDisplayPath: null });
    const deletion = staged?.find(
      ({ displayPath }) => displayPath === 'deleted.txt',
    );
    const rename = staged?.find(
      ({ displayPath }) => displayPath === 'rename-new.txt',
    );
    if (deletion === undefined || rename === undefined) {
      throw new Error('Rename or deletion is absent.');
    }
    const [deletionDiff, renameDiff] = await Promise.all([
      session.diff(deletion.fileId),
      session.diff(rename.fileId),
    ]);
    expect(deletionDiff.kind === 'text' ? deletionDiff.content : '').toContain(
      '-deleted',
    );
    expect(renameDiff.kind === 'text' ? renameDiff.content : '').toContain(
      'rename from rename-old.txt',
    );
    await expect(
      session.resolveFileNativeTarget(deletion.nativeTargetId),
    ).resolves.toMatchObject({
      absolutePath: join(await realpath(repository.path), 'deleted.txt'),
      canOpen: false,
      relativePath: 'deleted.txt',
    });
    await session.close();
  });

  it('publishes and reviews Conflict content without implying resolution', async () => {
    const repository = await createRepositoryWithCommit();
    const baseBranch = (
      await repository.git('branch', '--show-current')
    ).stdout.trim();
    await repository.git('switch', '--quiet', '-c', 'conflict-side');
    await writeFile(join(repository.path, 'README.md'), 'side\n');
    await repository.git('add', '--', 'README.md');
    await repository.git('commit', '--quiet', '-m', 'Change side');
    await repository.git('switch', '--quiet', baseBranch);
    await writeFile(join(repository.path, 'README.md'), 'base\n');
    await repository.git('add', '--', 'README.md');
    await repository.git('commit', '--quiet', '-m', 'Change base');
    await expect(
      repository.git('merge', '--no-edit', 'conflict-side'),
    ).rejects.toBeDefined();
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );

    const snapshot = await snapshotRepository(session);
    const conflict = snapshot.worktrees[0]?.changes.find(
      ({ kind }) => kind === 'conflict',
    );
    if (conflict === undefined) throw new Error('Conflict is absent.');
    const diff = await session.diff(conflict.fileId);

    expect(conflict).toMatchObject({
      baseline: 'conflict',
      displayPath: 'README.md',
      previousDisplayPath: null,
    });
    expect(diff).toMatchObject({
      kind: 'text',
      fileId: conflict.fileId,
      baseline: 'conflict',
    });
    expect(diff.kind === 'text' ? diff.content : '').toContain('<<<<<<<');
    expect(diff.kind === 'text' ? diff.content : '').toContain(
      'Conflict index stages: base=present; ours=present; theirs=present.',
    );
    expect(diff.kind === 'text' ? diff.content : '').toContain('@@ -0,0');
    expect(diff.kind === 'text' ? diff.content : '').not.toContain('@@@');
    await session.close();
  });

  it('degrades binary, undecodable, oversized, and excessively long Diffs to metadata', async () => {
    const repository = await createRepositoryWithCommit();
    await writeFile(
      join(repository.path, 'binary.dat'),
      Uint8Array.of(0, 1, 2),
    );
    await writeFile(
      join(repository.path, 'undecodable.txt'),
      Uint8Array.of(0xff, 0xfe),
    );
    await writeFile(
      join(repository.path, 'oversized.txt'),
      `x${'a'.repeat(2 * 1_024 * 1_024)}\n`,
    );
    await writeFile(
      join(repository.path, 'many-lines.txt'),
      'line\n'.repeat(20_001),
    );
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const snapshot = await snapshotRepository(session);
    const changes = snapshot.worktrees[0]!.changes;
    const byPath = new Map(
      changes.map((change) => [change.displayPath, change]),
    );

    const [binary, undecodable, oversized, manyLines] = await Promise.all(
      ['binary.dat', 'undecodable.txt', 'oversized.txt', 'many-lines.txt'].map(
        async (path) => session.diff(byPath.get(path)!.fileId),
      ),
    );

    expect(binary).toMatchObject({
      kind: 'binary',
      byteCount: expect.any(Number),
    });
    expect(undecodable).toMatchObject({
      kind: 'undecodable',
      byteCount: expect.any(Number),
    });
    expect(oversized).toMatchObject({
      kind: 'too_large',
      byteCount: expect.any(Number),
    });
    expect(manyLines).toMatchObject({
      kind: 'too_large',
      lineCount: expect.any(Number),
    });
    await session.close();
  });

  it('reviews unusual literal paths without treating them as Git options', async () => {
    const repository = await createRepositoryWithCommit();
    const unusualPath = '-leading [bracket]\nname.txt';
    await writeFile(join(repository.path, unusualPath), 'unusual\n');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const snapshot = await snapshotRepository(session);
    const change = snapshot.worktrees[0]!.changes.find(
      ({ displayPath }) => displayPath === unusualPath,
    );
    if (change === undefined) throw new Error('Unusual path is absent.');

    const diff = await session.diff(change.fileId);

    expect(diff).toMatchObject({
      kind: 'text',
      fileId: change.fileId,
      baseline: 'empty_to_working_tree',
    });
    expect(diff.kind === 'text' ? diff.content : '').toContain('+unusual');
    await session.close();
  });

  it('publishes coherent local refs, sanitized Remotes, Index, and status facts', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git(
      'remote',
      'add',
      'origin',
      'https://user:secret@example.test/team/repository.git?token=private',
    );
    const branch = (
      await repository.git('branch', '--show-current')
    ).stdout.trim();
    const head = (await repository.git('rev-parse', 'HEAD')).stdout.trim();
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );

    const snapshot = await snapshotRepository(session);

    expect(snapshot.refs).toContainEqual({
      kind: 'local',
      fullName: `refs/heads/${branch}`,
      objectId: head,
    });
    expect(snapshot.remotes).toEqual([
      {
        configurationEvidence: expect.stringMatching(/^[0-9a-f]{64}$/u),
        remoteId: expect.stringMatching(/^remote_[0-9a-f]{32}$/u),
        displayName: 'origin',
        host: 'example.test',
      },
    ]);
    expect(snapshot.worktrees[0]).toMatchObject({
      freshness: { kind: 'fresh' },
      index: { entryCount: 1, locked: false },
      status: {
        clean: true,
        conflicted: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
      },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|token=|https:/u);
    await session.close();
  });

  it('keeps Remote identity across configuration changes and replaces it after removal', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git(
      'remote',
      'add',
      'origin',
      'https://first:secret@example.test/team/one.git',
    );
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const initial = await snapshotRepository(session);
    const initialRemote = initial.remotes[0]!;

    await repository.git(
      'remote',
      'set-url',
      'origin',
      'https://second:private@example.test/team/two.git',
    );
    const reconfigured = await snapshotRepository(session);
    expect(reconfigured.remotes).toEqual([
      {
        configurationEvidence: expect.stringMatching(/^[0-9a-f]{64}$/u),
        remoteId: initialRemote.remoteId,
        displayName: 'origin',
        host: 'example.test',
      },
    ]);
    expect(reconfigured.refsRevision).toBe(initial.refsRevision + 1);
    expect(reconfigured.repositoryRevision).toBe(
      initial.repositoryRevision + 1,
    );
    await repository.git('config', 'remote.origin.customSecret', 'do-not-read');
    const ignoredCustomValue = await snapshotRepository(session);
    expect(ignoredCustomValue.refsRevision).toBe(reconfigured.refsRevision);
    expect(ignoredCustomValue.repositoryRevision).toBe(
      reconfigured.repositoryRevision,
    );

    await repository.git('remote', 'remove', 'origin');
    const removed = await snapshotRepository(session);
    expect(removed.remotes).toEqual([]);
    await repository.git(
      'remote',
      'add',
      'origin',
      'ssh://git@example.test/team/three.git',
    );
    const recreated = await snapshotRepository(session);
    expect(recreated.remotes[0]).toMatchObject({
      displayName: 'origin',
      host: 'example.test',
    });
    expect(recreated.remotes[0]?.remoteId).not.toBe(initialRemote.remoteId);
    await session.close();
  });

  it('never publishes a Remote host outside the protocol length limit', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git(
      'remote',
      'add',
      'oversized',
      `ssh://git@${'a'.repeat(1_025)}/repository.git`,
    );
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const snapshot = await snapshotRepository(session);
    expect(snapshot.remotes[0]?.host).toBe('unknown');
    await session.close();
  });

  it('keeps a Remote with only excluded custom configuration observable', async () => {
    const repository = await createRepositoryWithCommit();
    await repository.git(
      'config',
      'remote.custom.customSecret',
      'do-not-collect',
    );
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const snapshot = await snapshotRepository(session);
    expect(snapshot.remotes).toEqual([
      {
        configurationEvidence: expect.stringMatching(/^[0-9a-f]{64}$/u),
        remoteId: expect.stringMatching(/^remote_[0-9a-f]{32}$/u),
        displayName: 'custom',
        host: 'local',
      },
    ]);
    await session.close();
  });

  it('advances only shared refs axes for external Local and Remote-tracking ref changes', async () => {
    const repository = await createRepositoryWithCommit();
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const initial = await snapshotRepository(session);
    const head = (await repository.git('rev-parse', 'HEAD')).stdout.trim();

    await repository.git('branch', 'observed-local');
    await repository.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const changed = await snapshotRepository(session);

    expect(changed.refs).toEqual(
      expect.arrayContaining([
        {
          kind: 'local',
          fullName: 'refs/heads/observed-local',
          objectId: head,
        },
        {
          kind: 'remote_tracking',
          fullName: 'refs/remotes/origin/main',
          objectId: head,
        },
      ]),
    );
    expect(changed.repositoryRevision).toBe(initial.repositoryRevision + 1);
    expect(changed.refsRevision).toBe(initial.refsRevision + 1);
    expect(changed.topologyRevision).toBe(initial.topologyRevision);
    expect(
      changed.worktrees.map(({ worktreeRevision }) => worktreeRevision),
    ).toEqual(
      initial.worktrees.map(({ worktreeRevision }) => worktreeRevision),
    );
    await session.close();
  });

  it('publishes an effective Upstream with opaque Remote and cached divergence evidence', async () => {
    const repository = await createRepositoryWithCommit();
    const branch = (
      await repository.git('branch', '--show-current')
    ).stdout.trim();
    await repository.git(
      'remote',
      'add',
      'origin',
      'https://user:secret@example.test/team/repository.git',
    );
    await repository.git('branch', 'upstream-fixture');
    await repository.git('switch', '--quiet', 'upstream-fixture');
    await writeFile(join(repository.path, 'upstream.txt'), 'upstream\n');
    await repository.git('add', '--', 'upstream.txt');
    await repository.git('commit', '--quiet', '-m', 'Advance Upstream fixture');
    const upstreamObjectId = (
      await repository.git('rev-parse', 'HEAD')
    ).stdout.trim();
    await repository.git('switch', '--quiet', branch);
    await writeFile(join(repository.path, 'local.txt'), 'local\n');
    await repository.git('add', '--', 'local.txt');
    await repository.git('commit', '--quiet', '-m', 'Advance Local fixture');
    await repository.git(
      'update-ref',
      `refs/remotes/origin/${branch}`,
      upstreamObjectId,
    );
    await repository.git('config', `branch.${branch}.remote`, 'origin');
    await repository.git(
      'config',
      `branch.${branch}.merge`,
      `refs/heads/${branch}`,
    );
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );

    const snapshot = await snapshotRepository(session);
    const remote = snapshot.remotes[0]!;

    expect(snapshot.worktrees[0]?.upstream).toEqual({
      kind: 'tracking',
      remoteId: remote.remoteId,
      displayName: `origin/${branch}`,
      ref: {
        kind: 'remote_tracking',
        fullName: `refs/remotes/origin/${branch}`,
        objectId: upstreamObjectId,
      },
      aheadBehind: { kind: 'cached', ahead: 1, behind: 1 },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|https:/u);
    await session.close();
  });

  it('resolves the effective Upstream of an attached unborn Branch', async () => {
    const repository = await createTemporaryGitRepository();
    repositories.push(repository);
    const branch = (
      await repository.git('symbolic-ref', '--short', 'HEAD')
    ).stdout.trim();
    await repository.git(
      'remote',
      'add',
      'origin',
      'ssh://git@example.test/team/repository.git',
    );
    await repository.git('config', `branch.${branch}.remote`, 'origin');
    await repository.git(
      'config',
      `branch.${branch}.merge`,
      `refs/heads/${branch}`,
    );
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );

    const snapshot = await snapshotRepository(session);
    const worktree = snapshot.worktrees[0]!;

    expect(worktree.head).toMatchObject({
      kind: 'local_branch',
      displayName: branch,
      objectId: null,
    });
    expect(worktree.upstream).toEqual({
      kind: 'tracking',
      remoteId: snapshot.remotes[0]!.remoteId,
      displayName: `origin/${branch}`,
      ref: {
        kind: 'remote_tracking',
        fullName: `refs/remotes/origin/${branch}`,
        objectId: null,
      },
      aheadBehind: { kind: 'unavailable' },
    });
    await session.close();
  });

  it('does not treat an unrelated detached Worktree topology change as Upstream evidence', async () => {
    const repository = await createRepositoryWithCommit();
    const linkedPath = `${repository.path}-detached-upstream-evidence`;
    externalPaths.push(linkedPath);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const initial = await snapshotRepository(session);
    const initialMain = initial.worktrees.find(({ role }) => role === 'main')!;

    await repository.git('worktree', 'add', '--quiet', '--detach', linkedPath);
    const changed = await snapshotRepository(session);
    const changedMain = changed.worktrees.find(({ role }) => role === 'main')!;

    expect(changed.repositoryRevision).toBe(initial.repositoryRevision + 1);
    expect(changed.topologyRevision).toBe(initial.topologyRevision + 1);
    expect(changed.refsRevision).toBe(initial.refsRevision);
    expect(changedMain.worktreeRevision).toBe(initialMain.worktreeRevision);
    expect(
      changed.worktrees.find(({ role }) => role === 'linked')?.upstream,
    ).toEqual({ kind: 'not_applicable', reason: 'detached_head' });
    await session.close();
  });

  it('publishes external Upstream configuration changes only on shared revision axes', async () => {
    const repository = await createRepositoryWithCommit();
    const branch = (
      await repository.git('branch', '--show-current')
    ).stdout.trim();
    await repository.git(
      'remote',
      'add',
      'origin',
      'https://example.test/team/repository.git',
    );
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const initial = await snapshotRepository(session);
    const events = session.subscribe()[Symbol.asyncIterator]();
    expect(initial.worktrees[0]?.upstream).toEqual({ kind: 'unpublished' });

    await repository.git('config', `branch.${branch}.remote`, 'origin');
    await repository.git(
      'config',
      `branch.${branch}.merge`,
      `refs/heads/${branch}`,
    );
    const changed = await snapshotRepository(session);

    expect(changed.worktrees[0]?.upstream).toMatchObject({
      kind: 'tracking',
      remoteId: initial.remotes[0]!.remoteId,
      displayName: `origin/${branch}`,
    });
    expect(changed.repositoryRevision).toBe(initial.repositoryRevision + 1);
    expect(changed.refsRevision).toBe(initial.refsRevision + 1);
    expect(changed.topologyRevision).toBe(initial.topologyRevision);
    expect(changed.worktrees[0]?.worktreeRevision).toBe(
      initial.worktrees[0]?.worktreeRevision,
    );
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: {
        kind: 'repository',
        repositoryRevision: changed.repositoryRevision,
        refresh: { kind: 'fresh' },
      },
    });
    await session.close();
  });

  it('versions external Index, status, HEAD, and attached ref changes on their owning axes', async () => {
    const repository = await createRepositoryWithCommit();
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const initial = await snapshotRepository(session);
    const initialWorktree = initial.worktrees[0]!;

    await writeFile(join(repository.path, 'README.md'), 'staged change\n');
    await repository.git('add', '--', 'README.md');
    const staged = await snapshotRepository(session);
    expect(staged.worktrees[0]).toMatchObject({
      worktreeRevision: initialWorktree.worktreeRevision + 1,
      status: { clean: false, staged: 1, unstaged: 0 },
    });
    expect(staged.worktrees[0]?.index).not.toEqual(initialWorktree.index);
    expect(staged.refsRevision).toBe(initial.refsRevision);
    expect(staged.topologyRevision).toBe(initial.topologyRevision);

    await repository.git('commit', '--quiet', '-m', 'Advance observed HEAD');
    const committed = await snapshotRepository(session);
    const committedHead = (
      await repository.git('rev-parse', 'HEAD')
    ).stdout.trim();
    expect(committed.worktrees[0]).toMatchObject({
      worktreeRevision: staged.worktrees[0]!.worktreeRevision + 1,
      head: { kind: 'local_branch', objectId: committedHead },
      status: { clean: true, staged: 0, unstaged: 0 },
    });
    expect(committed.refsRevision).toBe(staged.refsRevision + 1);
    expect(committed.topologyRevision).toBe(staged.topologyRevision);
    await session.close();
  });

  it('observes effective global, include, includeIf, and Worktree Remote configuration', async () => {
    const repository = await createRepositoryWithCommit();
    const home = await mkdtemp(join(tmpdir(), 'codex-git-remote-home-'));
    externalPaths.push(home);
    const included = join(home, 'included.config');
    const conditional = join(home, 'conditional.config');
    const gitDirectory = await realpath(join(repository.path, '.git'));
    await writeFile(
      included,
      '[remote "included"]\n\turl = ssh://git@included.example/team/repo.git\n',
    );
    await writeFile(
      conditional,
      '[remote "conditional"]\n\turl = https://conditional.example/team/repo.git\n',
    );
    await writeFile(
      join(home, '.gitconfig'),
      [
        '[remote "global"]',
        '\turl = team:repo.git',
        '[url "ssh://git@global.example/"]',
        '\tinsteadOf = team:',
        '[include]',
        `\tpath = ${included}`,
        `[includeIf "gitdir:${gitDirectory}"]`,
        `\tpath = ${conditional}`,
        '',
      ].join('\n'),
    );
    await repository.git('config', 'extensions.worktreeConfig', 'true');
    await repository.git(
      'config',
      '--worktree',
      'remote.worktree.url',
      'file:///tmp/effective-repository.git',
    );
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    try {
      const snapshot = await snapshotRepository(session);
      expect(
        snapshot.remotes.map(({ displayName, host }) => ({
          displayName,
          host,
        })),
      ).toEqual([
        { displayName: 'conditional', host: 'conditional.example' },
        { displayName: 'global', host: 'global.example' },
        { displayName: 'included', host: 'included.example' },
        { displayName: 'worktree', host: 'local' },
      ]);
    } finally {
      await session.close();
      restoreEnvironment('HOME', previousHome);
    }
  });

  it('retains only a failed Worktree while publishing fresh unaffected observations', async () => {
    const repository = await createRepositoryWithCommit();
    const linkedPath = `${repository.path}-partial-failure`;
    externalPaths.push(linkedPath);
    await repository.git('worktree', 'add', '--quiet', '--detach', linkedPath);
    const canonicalLinkedPath = await realpath(linkedPath);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const initial = await snapshotRepository(session);
    const initialMain = initial.worktrees.find(({ role }) => role === 'main')!;
    const initialLinked = initial.worktrees.find(
      ({ canonicalPath }) => canonicalPath === canonicalLinkedPath,
    )!;
    await writeFile(join(repository.path, 'main-change.txt'), 'main\n');
    await writeFile(join(linkedPath, 'linked-change.txt'), 'linked\n');

    const wrapperDirectory = await createFailingWorktreeWrapper();
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}:${previousPath ?? ''}`;
    process.env.CODEX_GIT_FAIL_WORKTREE = canonicalLinkedPath;
    try {
      const partial = await snapshotRepository(session);
      const partialMain = partial.worktrees.find(
        ({ role }) => role === 'main',
      )!;
      const partialLinked = partial.worktrees.find(
        ({ canonicalPath }) => canonicalPath === canonicalLinkedPath,
      )!;
      expect(partial.refresh).toEqual({ kind: 'fresh' });
      expect(partialMain).toMatchObject({
        freshness: { kind: 'fresh' },
        status: { untracked: 1 },
      });
      expect(partialMain.worktreeRevision).toBe(
        initialMain.worktreeRevision + 1,
      );
      expect(partialLinked.freshness).toEqual({
        kind: 'stale',
        error: {
          code: 'git_read_failed',
          message: 'Git could not observe this Worktree.',
        },
      });
      expect(partialLinked.status).toEqual(initialLinked.status);
      expect(partialLinked.index).toEqual(initialLinked.index);
      expect(partialLinked.worktreeRevision).toBe(
        initialLinked.worktreeRevision + 1,
      );
      expect(partial.topologyRevision).toBe(initial.topologyRevision);
      expect(partial.refsRevision).toBe(initial.refsRevision);
    } finally {
      restoreEnvironment('PATH', previousPath);
      delete process.env.CODEX_GIT_FAIL_WORKTREE;
      await session.close();
    }
  });

  it('publishes an unavailable first-read Worktree without false status data', async () => {
    const repository = await createRepositoryWithCommit();
    const linkedPath = `${repository.path}-unavailable`;
    externalPaths.push(linkedPath);
    await repository.git('worktree', 'add', '--quiet', '--detach', linkedPath);
    await repository.git(
      'worktree',
      'lock',
      '--reason',
      'fixture unavailable',
      linkedPath,
    );
    await rm(linkedPath, { recursive: true });

    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const snapshot = await snapshotRepository(session);
    const unavailable = snapshot.worktrees.find(
      ({ role }) => role === 'linked',
    )!;
    expect(unavailable.availability.kind).toBe('unavailable');
    expect(unavailable.freshness).toEqual({ kind: 'unavailable' });
    expect(unavailable.index).toBeNull();
    expect(unavailable.status).toBeNull();
    await session.close();
  });
});

async function createFailingWorktreeWrapper(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), 'codex-git-observation-failure-'),
  );
  externalPaths.push(directory);
  const wrapper = join(directory, 'git');
  await writeFile(
    wrapper,
    [
      '#!/bin/sh',
      'if [ "$1" = "-C" ] && [ "$2" = "$CODEX_GIT_FAIL_WORKTREE" ] && [ "$3" = "status" ]; then',
      '  exit 42',
      'fi',
      'exec /usr/bin/git "$@"',
      '',
    ].join('\n'),
  );
  await chmod(wrapper, 0o755);
  return directory;
}

async function createRepositoryWithCommit(): Promise<TemporaryGitRepository> {
  const repository = await createTemporaryGitRepository();
  repositories.push(repository);
  await repository.git('config', 'user.name', 'Codex Git Tests');
  await repository.git('config', 'user.email', 'codex-git@example.test');
  await writeFile(join(repository.path, 'README.md'), 'fixture\n');
  await repository.git('add', '--', 'README.md');
  await repository.git('commit', '--quiet', '-m', 'Create fixture');
  return repository;
}

async function snapshotRepository(
  session: RepositorySession,
): Promise<RepositorySnapshot> {
  const result = await session.snapshot();
  if (result.kind !== 'repository') {
    throw new Error('Expected a Repository snapshot.');
  }
  return result.repository;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
