import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
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

describe('Repository Commit', () => {
  it('commits exactly staged content, preserves unstaged bytes, and clears only the successful Worktree draft', async () => {
    const repository = await repositoryWithCommit();
    await repository.git('branch', 'linked-draft');
    const linkedPath = `${repository.path}-successful-draft-linked`;
    externalPaths.push(linkedPath);
    await repository.git(
      'worktree',
      'add',
      '--quiet',
      linkedPath,
      'linked-draft',
    );
    await writeFile(join(repository.path, 'README.md'), 'staged version\n');
    await repository.git('add', 'README.md');
    await writeFile(join(repository.path, 'README.md'), 'unstaged version\n');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const linked = opened.repository.worktrees.find(
      ({ role }) => role === 'linked',
    )!;
    const draft = await session.updateDraft({
      worktreeId: worktree.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Commit title\n\nCommit body' },
    });
    const linkedDraft = await session.updateDraft({
      worktreeId: linked.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Keep linked draft' },
    });

    const receipt = await session.dispatch({
      clientCommandId: commandId(1),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });
    const result = await session.recoverOperation(receipt.operationId);

    expect(result).toMatchObject({
      kind: 'succeeded',
      result: { kind: 'commit', summary: 'Commit title' },
    });
    expect((await repository.git('show', 'HEAD:README.md')).stdout).toBe(
      'staged version\n',
    );
    expect(await readFile(join(repository.path, 'README.md'), 'utf8')).toBe(
      'unstaged version\n',
    );
    await expect(
      session.updateDraft({ kind: 'get', worktreeId: worktree.worktreeId }),
    ).resolves.toMatchObject({ revision: draft.revision + 1, text: '' });
    await expect(
      session.updateDraft({ kind: 'get', worktreeId: linked.worktreeId }),
    ).resolves.toEqual(linkedDraft);
    await session.close();
  });

  it('supports the Initial Commit and preserves a draft after missing identity rejection', async () => {
    const repository = await createTemporaryGitRepository();
    repositories.push(repository);
    await repository.git('config', 'user.name', '');
    await repository.git('config', 'user.email', '');
    await writeFile(join(repository.path, 'initial.txt'), 'initial\n');
    await repository.git('add', 'initial.txt');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const draft = await session.updateDraft({
      worktreeId: worktree.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Initial commit' },
    });

    const rejectedReceipt = await session.dispatch({
      clientCommandId: commandId(2),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });
    expect(
      await session.recoverOperation(rejectedReceipt.operationId),
    ).toMatchObject({ kind: 'rejected', code: 'missing_identity' });
    await expect(
      session.updateDraft({ kind: 'get', worktreeId: worktree.worktreeId }),
    ).resolves.toEqual(draft);
    await expect(
      readFile(join(repository.path, '.git', 'index.lock')),
    ).rejects.toThrow();

    await repository.git('config', 'user.email', 'codex-git@example.invalid');
    await repository.git('config', 'user.name', 'Codex Git');
    const refreshed = await session.requestRefresh();
    if (refreshed.kind !== 'repository') throw new Error('Expected Repository');
    const current = refreshed.repository.worktrees[0]!;
    const successReceipt = await session.dispatch({
      clientCommandId: commandId(3),
      command: {
        kind: 'commit',
        worktreeId: current.worktreeId,
        expectedWorktreeRevision: current.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });

    expect(
      await session.recoverOperation(successReceipt.operationId),
    ).toMatchObject({ kind: 'succeeded', result: { kind: 'commit' } });
    expect(
      (await repository.git('log', '-1', '--format=%s')).stdout.trim(),
    ).toBe('Initial commit');
    await session.close();
  });

  it('requires explicit confirmation before committing on Detached HEAD', async () => {
    const repository = await repositoryWithCommit();
    await repository.git('switch', '--detach', '--quiet');
    await writeFile(join(repository.path, 'README.md'), 'detached change\n');
    await repository.git('add', 'README.md');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const draft = await session.updateDraft({
      worktreeId: worktree.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Detached commit' },
    });
    const rejected = await session.dispatch({
      clientCommandId: commandId(4),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });

    expect(await session.recoverOperation(rejected.operationId)).toMatchObject({
      kind: 'rejected',
      code: 'precondition_failed',
    });
    expect((await repository.git('rev-parse', 'HEAD')).stdout.trim()).toBe(
      worktree.head.kind === 'detached' ? worktree.head.objectId : '',
    );
    const confirmed = await session.dispatch({
      clientCommandId: commandId(16),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: true,
      },
    });
    expect(await session.recoverOperation(confirmed.operationId)).toMatchObject(
      {
        kind: 'succeeded',
        result: { kind: 'commit', summary: 'Detached commit' },
      },
    );
    expect((await repository.git('rev-parse', 'HEAD')).stdout.trim()).not.toBe(
      worktree.head.kind === 'detached' ? worktree.head.objectId : '',
    );
    await session.close();
  });

  it('truthfully reports a silent hook rejection as an unclassified process failure', async () => {
    const repository = await repositoryWithCommit();
    await writeFile(join(repository.path, 'README.md'), 'hooked\n');
    await repository.git('add', 'README.md');
    const indexSignalPath = `${repository.path}-silent-hook-index`;
    externalPaths.push(indexSignalPath);
    const hook = join(repository.path, '.git', 'hooks', 'pre-commit');
    await writeFile(
      hook,
      `#!/bin/sh\nprintf "%s" "$GIT_INDEX_FILE" > "${indexSignalPath}"\ncp "$GIT_INDEX_FILE" "$GIT_INDEX_FILE.replacement"\nmv "$GIT_INDEX_FILE.replacement" "$GIT_INDEX_FILE"\nexit 1\n`,
    );
    await chmod(hook, 0o700);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const draft = await session.updateDraft({
      worktreeId: worktree.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Rejected by hook' },
    });

    const receipt = await session.dispatch({
      clientCommandId: commandId(5),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });

    expect(await session.recoverOperation(receipt.operationId)).toMatchObject({
      kind: 'failed_known',
      code: 'process_failed',
      message: 'Git could not create the Commit.',
    });
    await expect(
      session.updateDraft({ kind: 'get', worktreeId: worktree.worktreeId }),
    ).resolves.toEqual(draft);
    await expect(
      readFile(await readFile(indexSignalPath, 'utf8')),
    ).rejects.toThrow();
    await expect(
      readFile(join(repository.path, '.git', 'index.lock')),
    ).rejects.toThrow();
    await session.close();
  });

  it('classifies an observed hook diagnostic and preserves the draft', async () => {
    const repository = await repositoryWithCommit();
    await writeFile(join(repository.path, 'README.md'), 'hooked\n');
    await repository.git('add', 'README.md');
    const hook = join(repository.path, '.git', 'hooks', 'pre-commit');
    await writeFile(
      hook,
      '#!/bin/sh\necho "pre-commit hook failed" >&2\nexit 1\n',
    );
    await chmod(hook, 0o700);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const draft = await session.updateDraft({
      worktreeId: worktree.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Observed hook rejection' },
    });
    const receipt = await session.dispatch({
      clientCommandId: commandId(17),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });

    expect(await session.recoverOperation(receipt.operationId)).toMatchObject({
      kind: 'failed_known',
      code: 'hook_rejected',
    });
    await expect(
      session.updateDraft({ kind: 'get', worktreeId: worktree.worktreeId }),
    ).resolves.toEqual(draft);
    await session.close();
  });

  it('accepts the exact successful Commit OID when hooks modify the Index and message', async () => {
    const repository = await repositoryWithCommit();
    await writeFile(join(repository.path, 'README.md'), 'hook mutation\n');
    await repository.git('add', 'README.md');
    const preCommit = join(repository.path, '.git', 'hooks', 'pre-commit');
    const commitMessage = join(repository.path, '.git', 'hooks', 'commit-msg');
    await writeFile(
      preCommit,
      '#!/bin/sh\nprintf "hook staged\\n" > hook-added.txt\ngit add hook-added.txt\n',
    );
    await writeFile(
      commitMessage,
      '#!/bin/sh\nprintf "\\nHook-added trailer\\n" >> "$1"\n',
    );
    await chmod(preCommit, 0o700);
    await chmod(commitMessage, 0o700);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const draft = await session.updateDraft({
      worktreeId: worktree.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Hook mutation' },
    });
    const receipt = await session.dispatch({
      clientCommandId: commandId(18),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });

    expect(await session.recoverOperation(receipt.operationId)).toMatchObject({
      kind: 'succeeded',
      result: { kind: 'commit' },
    });
    expect((await repository.git('show', 'HEAD:hook-added.txt')).stdout).toBe(
      'hook staged\n',
    );
    expect((await repository.git('log', '-1', '--format=%B')).stdout).toContain(
      'Hook-added trailer',
    );
    await session.close();
  });

  it('rejects stale Index evidence and an unresolved external Index lock before Commit', async () => {
    const repository = await repositoryWithCommit();
    await writeFile(join(repository.path, 'README.md'), 'reviewed\n');
    await repository.git('add', 'README.md');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const draft = await session.updateDraft({
      worktreeId: worktree.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Stale commit' },
    });
    await writeFile(join(repository.path, 'extra.txt'), 'external\n');
    await repository.git('add', 'extra.txt');
    const staleReceipt = await session.dispatch({
      clientCommandId: commandId(6),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });
    expect(
      await session.recoverOperation(staleReceipt.operationId),
    ).toMatchObject({ kind: 'rejected', code: 'stale' });

    const refreshed = await session.requestRefresh();
    if (refreshed.kind !== 'repository') throw new Error('Expected Repository');
    const current = refreshed.repository.worktrees[0]!;
    await writeFile(
      join(repository.path, '.git', 'index.lock'),
      'external lock',
    );
    const lockedReceipt = await session.dispatch({
      clientCommandId: commandId(7),
      command: {
        kind: 'commit',
        worktreeId: current.worktreeId,
        expectedWorktreeRevision: current.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });
    expect(
      await session.recoverOperation(lockedReceipt.operationId),
    ).toMatchObject({ kind: 'rejected', code: 'index_locked' });
    await session.close();
  });

  it('keeps drafts through Refresh and Branch changes and clears only the explicit Worktree', async () => {
    const repository = await repositoryWithCommit();
    await repository.git('branch', 'other');
    const linkedPath = `${repository.path}-draft-linked`;
    externalPaths.push(linkedPath);
    await repository.git('worktree', 'add', '--quiet', linkedPath, 'other');
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const [main, linked] = opened.repository.worktrees;
    if (main === undefined || linked === undefined) {
      throw new Error('Expected two Worktrees');
    }
    const mainDraft = await session.updateDraft({
      worktreeId: main.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Main draft' },
    });
    const linkedDraft = await session.updateDraft({
      worktreeId: linked.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Linked draft\n\nBody' },
    });

    await session.requestRefresh();
    await repository.git('switch', '--quiet', '-c', 'changed-branch');
    await session.requestRefresh();

    await expect(
      session.updateDraft({ kind: 'get', worktreeId: main.worktreeId }),
    ).resolves.toEqual(mainDraft);
    await expect(
      session.updateDraft({ kind: 'get', worktreeId: linked.worktreeId }),
    ).resolves.toEqual(linkedDraft);
    await expect(
      session.updateDraft({
        worktreeId: main.worktreeId,
        expectedRevision: mainDraft.revision,
        update: { kind: 'clear' },
      }),
    ).resolves.toMatchObject({ text: '' });
    await expect(
      session.updateDraft({ kind: 'get', worktreeId: linked.worktreeId }),
    ).resolves.toEqual(linkedDraft);
    await session.close();
  });

  it('runs Commits concurrently in different Worktrees without crossing HEAD or Index', async () => {
    const repository = await repositoryWithCommit();
    const mainBranch = (
      await repository.git('branch', '--show-current')
    ).stdout.trim();
    await repository.git('branch', 'linked');
    const linkedPath = `${repository.path}-concurrent-linked`;
    externalPaths.push(linkedPath);
    await repository.git('worktree', 'add', '--quiet', linkedPath, 'linked');
    await writeFile(join(repository.path, 'main.txt'), 'main\n');
    await repository.git('add', 'main.txt');
    await writeFile(join(linkedPath, 'linked.txt'), 'linked\n');
    await repository.git('-C', linkedPath, 'add', 'linked.txt');
    const signalPath = `${repository.path}-commit-signal`;
    const releasePath = `${repository.path}-commit-release`;
    externalPaths.push(signalPath, releasePath);
    const hook = join(repository.path, '.git', 'hooks', 'pre-commit');
    await writeFile(
      hook,
      `#!/bin/sh\nif [ -f main.txt ]; then printf signal > "${signalPath}"; while [ ! -f "${releasePath}" ]; do sleep 0.01; done; fi\n`,
    );
    await chmod(hook, 0o700);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const main = opened.repository.worktrees.find(
      ({ role }) => role === 'main',
    )!;
    const linked = opened.repository.worktrees.find(
      ({ role }) => role === 'linked',
    )!;
    const mainDraft = await session.updateDraft({
      worktreeId: main.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Main concurrent Commit' },
    });
    const linkedDraft = await session.updateDraft({
      worktreeId: linked.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Linked concurrent Commit' },
    });
    const mainReceipt = await session.dispatch({
      clientCommandId: commandId(8),
      command: {
        kind: 'commit',
        worktreeId: main.worktreeId,
        expectedWorktreeRevision: main.worktreeRevision,
        draftRevision: mainDraft.revision,
        confirmDetachedHead: false,
      },
    });
    await waitForPath(signalPath);
    const linkedReceipt = await session.dispatch({
      clientCommandId: commandId(9),
      command: {
        kind: 'commit',
        worktreeId: linked.worktreeId,
        expectedWorktreeRevision: linked.worktreeRevision,
        draftRevision: linkedDraft.revision,
        confirmDetachedHead: false,
      },
    });

    const linkedResult = await session.recoverOperation(
      linkedReceipt.operationId,
    );
    expect(linkedResult).toMatchObject({ kind: 'succeeded' });
    await writeFile(releasePath, 'continue');
    expect(
      await session.recoverOperation(mainReceipt.operationId),
    ).toMatchObject({
      kind: 'succeeded',
    });
    expect(
      (await repository.git('show', `${mainBranch}:main.txt`)).stdout,
    ).toBe('main\n');
    expect((await repository.git('show', 'linked:linked.txt')).stdout).toBe(
      'linked\n',
    );
    await session.close();
  });

  it('owns the native Index lock transaction and rejects post-launch external staging', async () => {
    const repository = await repositoryWithCommit();
    await writeFile(join(repository.path, 'README.md'), 'native lock\n');
    await writeFile(join(repository.path, 'later.txt'), 'later\n');
    await repository.git('add', 'README.md');
    const signalPath = `${repository.path}-index-lock-signal`;
    const releasePath = `${repository.path}-index-lock-release`;
    externalPaths.push(signalPath, releasePath);
    const hook = join(repository.path, '.git', 'hooks', 'pre-commit');
    await writeFile(
      hook,
      `#!/bin/sh\nprintf "%s" "$GIT_INDEX_FILE" > "${signalPath}"\nwhile [ ! -f "${releasePath}" ]; do sleep 0.01; done\n`,
    );
    await chmod(hook, 0o700);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const draft = await session.updateDraft({
      worktreeId: worktree.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Native Index lock' },
    });
    const receipt = await session.dispatch({
      clientCommandId: commandId(19),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });
    await waitForPath(signalPath);

    const privateIndexPath = await readFile(signalPath, 'utf8');
    expect(privateIndexPath).toMatch(/index\.codex-commit-[0-9a-f-]+$/u);
    expect(privateIndexPath).not.toBe(
      join(repository.path, '.git', 'index.lock'),
    );
    await expect(
      readFile(join(repository.path, '.git', 'index.lock'), 'utf8'),
    ).resolves.toBe('');
    await expect(repository.git('add', 'later.txt')).rejects.toThrow();
    await writeFile(releasePath, 'continue');
    expect(await session.recoverOperation(receipt.operationId)).toMatchObject({
      kind: 'succeeded',
    });
    await expect(readFile(privateIndexPath)).rejects.toThrow();
    await expect(
      readFile(join(repository.path, '.git', 'index.lock')),
    ).rejects.toThrow();
    await expect(repository.git('show', 'HEAD:later.txt')).rejects.toThrow();
    expect(
      (await repository.git('status', '--short', '--', 'later.txt')).stdout,
    ).toBe('?? later.txt\n');
    await session.close();
  });

  it('lets native Git expected-old ref CAS reject a post-launch HEAD mutation', async () => {
    const repository = await repositoryWithCommit();
    const attachedRef = (
      await repository.git('symbolic-ref', 'HEAD')
    ).stdout.trim();
    await writeFile(join(repository.path, 'README.md'), 'ref race\n');
    await repository.git('add', 'README.md');
    const parent = (await repository.git('rev-parse', 'HEAD')).stdout.trim();
    const tree = (await repository.git('write-tree')).stdout.trim();
    const signalPath = `${repository.path}-ref-cas-signal`;
    const releasePath = `${repository.path}-ref-cas-release`;
    externalPaths.push(signalPath, releasePath);
    const hook = join(repository.path, '.git', 'hooks', 'pre-commit');
    await writeFile(
      hook,
      `#!/bin/sh\nprintf signal > "${signalPath}"\nwhile [ ! -f "${releasePath}" ]; do sleep 0.01; done\n`,
    );
    await chmod(hook, 0o700);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const draft = await session.updateDraft({
      worktreeId: worktree.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Ref CAS race' },
    });
    const receipt = await session.dispatch({
      clientCommandId: commandId(20),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });
    await waitForPath(signalPath);
    const externalCommit = (
      await repository.git('commit-tree', tree, '-p', parent, '-m', 'External')
    ).stdout.trim();
    await repository.git('update-ref', attachedRef, externalCommit, parent);
    await writeFile(releasePath, 'continue');

    expect(await session.recoverOperation(receipt.operationId)).toMatchObject({
      kind: 'failed_known',
      code: 'process_failed',
    });
    expect((await repository.git('rev-parse', 'HEAD')).stdout.trim()).toBe(
      externalCommit,
    );
    await expect(
      session.updateDraft({ kind: 'get', worktreeId: worktree.worktreeId }),
    ).resolves.toEqual(draft);
    await session.close();
  });

  it('classifies configured signing failure without exposing raw diagnostics', async () => {
    const repository = await repositoryWithCommit();
    await writeFile(join(repository.path, 'README.md'), 'signed\n');
    await repository.git('add', 'README.md');
    const signer = `${repository.path}-failing-signer`;
    externalPaths.push(signer);
    await writeFile(
      signer,
      '#!/bin/sh\necho "signing failed with secret-token" >&2\nexit 1\n',
    );
    await chmod(signer, 0o700);
    await repository.git('config', 'commit.gpgsign', 'true');
    await repository.git('config', 'gpg.program', signer);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const draft = await session.updateDraft({
      worktreeId: worktree.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Signed Commit' },
    });
    const receipt = await session.dispatch({
      clientCommandId: commandId(10),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });

    const result = await session.recoverOperation(receipt.operationId);
    expect(result).toMatchObject({
      kind: 'failed_known',
      code: 'signing_failed',
      message:
        'Git could not sign the Commit with the configured signing setup.',
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
    await session.close();
  });

  it('blocks Commit with an empty Index or an In-progress Git Operation', async () => {
    const repository = await repositoryWithCommit();
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const draft = await session.updateDraft({
      worktreeId: worktree.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Blocked Commit' },
    });
    const emptyReceipt = await session.dispatch({
      clientCommandId: commandId(11),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });
    expect(
      await session.recoverOperation(emptyReceipt.operationId),
    ).toMatchObject({ kind: 'rejected', code: 'precondition_failed' });

    await writeFile(
      join(repository.path, 'README.md'),
      'staged while bisecting\n',
    );
    await repository.git('add', 'README.md');
    await writeFile(
      join(repository.path, '.git', 'BISECT_LOG'),
      'in progress\n',
    );
    const refreshed = await session.requestRefresh();
    if (refreshed.kind !== 'repository') throw new Error('Expected Repository');
    const inProgress = refreshed.repository.worktrees[0]!;
    const blockedReceipt = await session.dispatch({
      clientCommandId: commandId(12),
      command: {
        kind: 'commit',
        worktreeId: inProgress.worktreeId,
        expectedWorktreeRevision: inProgress.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });
    expect(
      await session.recoverOperation(blockedReceipt.operationId),
    ).toMatchObject({ kind: 'rejected', code: 'precondition_failed' });
    await session.close();
  });

  it('blocks Commit while the Index contains Conflict entries', async () => {
    const repository = await repositoryWithCommit();
    await repository.git('switch', '--quiet', '-c', 'conflicting');
    await writeFile(join(repository.path, 'README.md'), 'other\n');
    await repository.git('commit', '--quiet', '-am', 'Other');
    await repository.git('switch', '--quiet', '-');
    await writeFile(join(repository.path, 'README.md'), 'current\n');
    await repository.git('commit', '--quiet', '-am', 'Current');
    await expect(repository.git('merge', 'conflicting')).rejects.toThrow();
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const draft = await session.updateDraft({
      worktreeId: worktree.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Conflict Commit' },
    });
    const receipt = await session.dispatch({
      clientCommandId: commandId(15),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });

    expect(await session.recoverOperation(receipt.operationId)).toMatchObject({
      kind: 'rejected',
      code: 'precondition_failed',
    });
    await session.close();
  });

  it('reports a timed-out Commit as Unknown Outcome and blocks a duplicate retry', async () => {
    const repository = await repositoryWithCommit();
    await writeFile(join(repository.path, 'README.md'), 'timeout\n');
    await repository.git('add', 'README.md');
    const signalPath = `${repository.path}-timeout-signal`;
    externalPaths.push(signalPath);
    const hook = join(repository.path, '.git', 'hooks', 'pre-commit');
    await writeFile(
      hook,
      `#!/bin/sh\nprintf signal > "${signalPath}"\nwhile true; do sleep 0.05; done\n`,
    );
    await chmod(hook, 0o700);
    const session = await createRepositoryEngine({
      operationTimeoutMilliseconds: 75,
    }).open(repository.path as AbsolutePath);
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const draft = await session.updateDraft({
      worktreeId: worktree.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Timed out Commit' },
    });
    const receipt = await session.dispatch({
      clientCommandId: commandId(13),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });
    expect(await session.recoverOperation(receipt.operationId)).toMatchObject({
      kind: 'unknown_outcome',
      recoveryAvailable: true,
    });
    await expect(
      session.updateDraft({ kind: 'get', worktreeId: worktree.worktreeId }),
    ).resolves.toEqual(draft);
    const retry = await session.dispatch({
      clientCommandId: commandId(14),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });
    expect(await session.recoverOperation(retry.operationId)).toMatchObject({
      kind: 'rejected',
      code: 'busy',
    });
    await session.close();
  });

  it('cancels a running Git process through the Product Command and preserves Unknown recovery', async () => {
    const repository = await repositoryWithCommit();
    await writeFile(join(repository.path, 'README.md'), 'cancelled\n');
    await repository.git('add', 'README.md');
    const signalPath = `${repository.path}-cancel-signal`;
    externalPaths.push(signalPath);
    const hook = join(repository.path, '.git', 'hooks', 'pre-commit');
    await writeFile(
      hook,
      `#!/bin/sh\nprintf signal > "${signalPath}"\nwhile true; do sleep 0.05; done\n`,
    );
    await chmod(hook, 0o700);
    const session = await createRepositoryEngine().open(
      repository.path as AbsolutePath,
    );
    const opened = await session.requestRefresh();
    if (opened.kind !== 'repository') throw new Error('Expected Repository');
    const worktree = opened.repository.worktrees[0]!;
    const draft = await session.updateDraft({
      worktreeId: worktree.worktreeId,
      expectedRevision: 0,
      update: { kind: 'set', text: 'Cancelled Commit' },
    });
    const receipt = await session.dispatch({
      clientCommandId: commandId(21),
      command: {
        kind: 'commit',
        worktreeId: worktree.worktreeId,
        expectedWorktreeRevision: worktree.worktreeRevision,
        draftRevision: draft.revision,
        confirmDetachedHead: false,
      },
    });
    await waitForPath(signalPath);
    const cancellation = await session.dispatch({
      clientCommandId: commandId(22),
      command: {
        kind: 'cancel_operation',
        operationId: receipt.operationId,
      },
    });

    expect(
      await session.recoverOperation(cancellation.operationId),
    ).toMatchObject({ kind: 'unknown_outcome', recoveryAvailable: true });
    await expect(
      session.updateDraft({ kind: 'get', worktreeId: worktree.worktreeId }),
    ).resolves.toEqual(draft);
    await session.close();
  });
});

async function repositoryWithCommit() {
  const repository = await createTemporaryGitRepository();
  repositories.push(repository);
  await repository.git('config', 'user.email', 'codex-git@example.invalid');
  await repository.git('config', 'user.name', 'Codex Git');
  await writeFile(join(repository.path, 'README.md'), 'initial\n');
  await repository.git('add', 'README.md');
  await repository.git('commit', '--quiet', '-m', 'Initial fixture');
  return repository;
}

function commandId(index: number): ClientCommandId {
  return `command_${index.toString(16).padStart(32, '0')}` as ClientCommandId;
}

async function waitForPath(path: string) {
  await expect
    .poll(() => readFile(path, 'utf8').catch(() => ''), { timeout: 5_000 })
    .not.toBe('');
}
