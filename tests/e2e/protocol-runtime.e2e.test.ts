import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  startStandaloneRuntime,
  type StandaloneRuntime,
} from '@codex-git/launcher';
import {
  PROTOCOL_VERSION_HEADER,
  repositorySnapshotSchema,
} from '@codex-git/protocol';

import {
  createTemporaryGitRepository,
  type TemporaryGitRepository,
} from '../fixtures/temporary-git-repository.js';

const runtimes: StandaloneRuntime[] = [];
const repositories: TemporaryGitRepository[] = [];
const temporaryDirectories: string[] = [];
const runtimeCleanupTimeoutMilliseconds = 30_000;

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    repositories.splice(0).map((repository) => repository.dispose()),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}, runtimeCleanupTimeoutMilliseconds);

describe('protocol runtime composition', () => {
  it('negotiates the shared protocol from the standalone surface Origin', async () => {
    const runtime = await startStandaloneRuntime({
      surfacePort: 0,
    });
    runtimes.push(runtime);

    const surface = await (await fetch(runtime.surfaceUrl)).text();
    const bootstrapMatch = surface.match(
      /globalThis\.__CODEX_GIT_PROTOCOL__ = (\{.*?\});/u,
    );
    expect(bootstrapMatch !== null).toBe(true);
    if (bootstrapMatch === null)
      throw new Error('Protocol bootstrap is absent.');
    const bootstrap = JSON.parse(bootstrapMatch[1] ?? '{}') as {
      sessionUrl?: string;
    };
    if (bootstrap.sessionUrl === undefined) {
      throw new Error('Protocol bootstrap has no session URL.');
    }
    const sessionUrl = new URL(bootstrap.sessionUrl);
    const token = sessionUrl.pathname.split('/')[2];

    const response = await fetch(sessionUrl, {
      headers: {
        origin: runtime.surfaceUrl.origin,
        [PROTOCOL_VERSION_HEADER]: '1',
      },
    });

    expect({
      body: await response.json(),
      status: response.status,
      tokenIsOpaque: token?.length === 64,
    }).toEqual({
      body: expect.objectContaining({ protocolVersion: 1 }),
      status: 200,
      tokenIsOpaque: true,
    });
  });

  it('streams Repository invalidations after an external selected Worktree change', async () => {
    const repository = await createTemporaryGitRepository();
    repositories.push(repository);
    await repository.git('config', 'user.name', 'Codex Git Tests');
    await repository.git('config', 'user.email', 'codex-git@example.test');
    await writeFile(join(repository.path, 'README.md'), 'fixture\n');
    await repository.git('add', '--', 'README.md');
    await repository.git('commit', '--quiet', '-m', 'Create fixture');
    const runtime = await startStandaloneRuntime({
      projectPath: repository.path,
      surfacePort: 0,
    });
    runtimes.push(runtime);
    const eventsUrl = new URL(
      runtime.sessionUrl.pathname.replace(/\/session$/u, '/events'),
      runtime.sessionUrl,
    );
    const response = await fetch(eventsUrl, {
      headers: { origin: runtime.surfaceUrl.origin },
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('SSE response body is absent.');

    await writeFile(join(repository.path, 'external.txt'), 'changed\n');
    const frame = await readFrameWithin(reader, 2_000);

    expect(frame).toContain('event: invalidation');
    expect(frame).toMatch(/"kind":"repository_revision"/u);
    await reader.cancel();
  });

  it('serves an authoritative Repository overview snapshot', async () => {
    const repository = await createRepositoryWithCommit();
    const runtime = await startStandaloneRuntime({
      projectPath: repository.path,
      surfacePort: 0,
    });
    runtimes.push(runtime);
    const surface = await (await fetch(runtime.surfaceUrl)).text();
    expect(protocolBootstrap(surface)).toMatchObject({
      projectPath: repository.path,
      sessionUrl: runtime.sessionUrl.href,
    });
    const snapshotUrl = new URL(
      runtime.sessionUrl.pathname.replace(/\/session$/u, '/snapshot'),
      runtime.sessionUrl,
    );

    const response = await fetch(snapshotUrl, {
      headers: {
        origin: runtime.surfaceUrl.origin,
        [PROTOCOL_VERSION_HEADER]: '1',
      },
    });
    const body = await response.json();
    const canonicalPath = await realpath(repository.path);
    const branchName = (
      await repository.git('branch', '--show-current')
    ).stdout.trim();

    expect(response.status).toBe(200);
    expect(repositorySnapshotSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      displayName: repository.path.split('/').at(-1),
      path: canonicalPath,
      refresh: { kind: 'current' },
      fetch: { kind: 'never' },
      fetchAvailable: false,
      worktrees: [
        {
          role: 'main',
          displayName: repository.path.split('/').at(-1),
          path: canonicalPath,
          availability: { kind: 'available' },
          freshness: { kind: 'current' },
          head: { kind: 'local_branch', displayName: branchName },
          status: { kind: 'clean' },
          upstream: { kind: 'unpublished' },
        },
      ],
    });
  });

  it('publishes classified Changed Files through the protocol snapshot', async () => {
    const repository = await createRepositoryWithCommit();
    await writeFile(join(repository.path, 'README.md'), 'staged\n');
    await repository.git('add', '--', 'README.md');
    await writeFile(join(repository.path, 'README.md'), 'unstaged\n');
    await writeFile(join(repository.path, 'untracked.txt'), 'untracked\n');
    const runtime = await startStandaloneRuntime({
      projectPath: repository.path,
      surfacePort: 0,
    });
    runtimes.push(runtime);
    const snapshotUrl = new URL(
      runtime.sessionUrl.pathname.replace(/\/session$/u, '/snapshot'),
      runtime.sessionUrl,
    );

    const response = await fetch(snapshotUrl, {
      headers: {
        origin: runtime.surfaceUrl.origin,
        [PROTOCOL_VERSION_HEADER]: '1',
      },
    });
    const body = repositorySnapshotSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.worktrees[0]?.changes).toEqual([
      expect.objectContaining({
        kind: 'staged_change',
        baseline: 'head_to_index',
        displayPath: 'README.md',
        previousDisplayPath: null,
      }),
      expect.objectContaining({
        kind: 'change',
        baseline: 'index_to_working_tree',
        displayPath: 'README.md',
        previousDisplayPath: null,
      }),
      expect.objectContaining({
        kind: 'untracked',
        baseline: 'empty_to_working_tree',
        displayPath: 'untracked.txt',
        previousDisplayPath: null,
      }),
    ]);
    const stagedFileId = body.worktrees[0]?.changes.find(
      ({ kind }) => kind === 'staged_change',
    )?.fileId;
    if (stagedFileId === undefined) {
      throw new Error('The staged Changed File is absent.');
    }
    const diffResponse = await fetch(
      new URL(
        runtime.sessionUrl.pathname.replace(/\/session$/u, '/diff'),
        runtime.sessionUrl,
      ),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: runtime.surfaceUrl.origin,
          [PROTOCOL_VERSION_HEADER]: '1',
        },
        body: JSON.stringify({ fileId: stagedFileId }),
      },
    );

    expect({
      body: await diffResponse.json(),
      status: diffResponse.status,
    }).toMatchObject({
      body: {
        kind: 'text',
        fileId: stagedFileId,
        baseline: 'head_to_index',
        content: expect.stringContaining('+staged'),
      },
      status: 200,
    });
    const copyTarget = body.worktrees[0]?.changes
      .find(({ fileId }) => fileId === stagedFileId)
      ?.nativeTargets.find(({ actions }) =>
        actions.includes('copy_relative_path'),
      );
    if (copyTarget === undefined) {
      throw new Error('The safe Changed File action is absent.');
    }
    const actionResponse = await fetch(
      new URL(
        runtime.sessionUrl.pathname.replace(/\/session$/u, '/native-actions'),
        runtime.sessionUrl,
      ),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: runtime.surfaceUrl.origin,
          [PROTOCOL_VERSION_HEADER]: '1',
        },
        body: JSON.stringify({
          kind: 'copy_relative_path',
          targetId: copyTarget.targetId,
        }),
      },
    );
    expect({
      body: await actionResponse.json(),
      status: actionResponse.status,
    }).toEqual({
      body: { kind: 'copy_text', text: 'README.md' },
      status: 200,
    });
  });

  it('does not advertise deleted files as openable and rejects symbolic-link opens', async () => {
    const repository = await createRepositoryWithCommit();
    await writeFile(join(repository.path, 'deleted.txt'), 'deleted\n');
    await repository.git('add', '--', 'deleted.txt');
    await repository.git('commit', '--quiet', '-m', 'Add deletion fixture');
    await repository.git('rm', '--quiet', '--', 'deleted.txt');
    await symlink('/tmp', join(repository.path, 'outside-link'));
    const runtime = await startStandaloneRuntime({
      projectPath: repository.path,
      surfacePort: 0,
    });
    runtimes.push(runtime);
    const response = await fetch(
      new URL(
        runtime.sessionUrl.pathname.replace(/\/session$/u, '/snapshot'),
        runtime.sessionUrl,
      ),
      {
        headers: {
          origin: runtime.surfaceUrl.origin,
          [PROTOCOL_VERSION_HEADER]: '1',
        },
      },
    );
    const snapshot = repositorySnapshotSchema.parse(await response.json());
    const deletion = snapshot.worktrees[0]?.changes.find(
      ({ displayPath }) => displayPath === 'deleted.txt',
    );
    const link = snapshot.worktrees[0]?.changes.find(
      ({ displayPath }) => displayPath === 'outside-link',
    );

    expect(deletion?.nativeTargets[0]?.actions).toEqual(['copy_relative_path']);
    expect(link?.nativeTargets[0]?.actions).toContain('open_default_app');
    if (link?.nativeTargets[0] === undefined) {
      throw new Error('The symbolic-link target is absent.');
    }
    const actionResponse = await fetch(
      new URL(
        runtime.sessionUrl.pathname.replace(/\/session$/u, '/native-actions'),
        runtime.sessionUrl,
      ),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: runtime.surfaceUrl.origin,
          [PROTOCOL_VERSION_HEADER]: '1',
        },
        body: JSON.stringify({
          kind: 'open_default_app',
          targetId: link.nativeTargets[0].targetId,
        }),
      },
    );

    expect(await actionResponse.json()).toMatchObject({ kind: 'unavailable' });
  });

  it('serves a typed non-Repository result for the Current Project', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'codex-git-project-'));
    temporaryDirectories.push(projectPath);
    const runtime = await startStandaloneRuntime({
      projectPath,
      surfacePort: 0,
    });
    runtimes.push(runtime);
    const snapshotUrl = new URL(
      runtime.sessionUrl.pathname.replace(/\/session$/u, '/snapshot'),
      runtime.sessionUrl,
    );

    const response = await fetch(snapshotUrl, {
      headers: {
        origin: runtime.surfaceUrl.origin,
        [PROTOCOL_VERSION_HEADER]: '1',
      },
    });

    expect({ body: await response.json(), status: response.status }).toEqual({
      body: {
        kind: 'non_repository',
        projectPath,
        message: 'The Current Project is not inside a Git Repository.',
      },
      status: 200,
    });
  });
});

function protocolBootstrap(surface: string): unknown {
  const match = surface.match(
    /globalThis\.__CODEX_GIT_PROTOCOL__ = (\{.*?\});/u,
  );
  if (match === null) throw new Error('Protocol bootstrap is absent.');
  return JSON.parse(match[1] ?? '{}');
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

async function readFrameWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  milliseconds: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let content = '';
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error('Timed out waiting for an SSE invalidation.')),
      milliseconds,
    ),
  );
  while (!content.includes('\n\n')) {
    const next = await Promise.race([reader.read(), deadline]);
    if (next.done) throw new Error('SSE stream closed before invalidation.');
    content += decoder.decode(next.value, { stream: true });
  }
  return content;
}
