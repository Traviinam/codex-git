import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  startStandaloneRuntime,
  type StandaloneRuntime,
} from '@codex-git/launcher';
import {
  clientCommandIdSchema,
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

  it('dispatches Fetch through command and operation endpoints', async () => {
    const repository = await createRepositoryWithCommit();
    const remotePath = await mkdtemp(join(tmpdir(), 'codex-git-remote-'));
    temporaryDirectories.push(remotePath);
    await repository.git('init', '--quiet', '--bare', remotePath);
    const branchName = (
      await repository.git('branch', '--show-current')
    ).stdout.trim();
    await repository.git('remote', 'add', 'origin', remotePath);
    await repository.git('push', '--quiet', '-u', 'origin', branchName);
    const runtime = await startStandaloneRuntime({
      projectPath: repository.path,
      surfacePort: 0,
    });
    runtimes.push(runtime);
    const snapshotResponse = await protocolRequest(runtime, 'snapshot');
    const snapshot = repositorySnapshotSchema.parse(
      await snapshotResponse.json(),
    );
    const remote = snapshot.remotes[0];
    if (remote === undefined) throw new Error('Expected fixture Remote.');

    const commandResponse = await protocolRequest(runtime, 'commands', {
      clientCommandId: clientCommandIdSchema.parse(
        'command_00000000000000000000000000000001',
      ),
      command: {
        kind: 'fetch_remote',
        repositoryId: snapshot.repositoryId,
        remoteId: remote.remoteId,
        expectedRefsRevision: snapshot.refsRevision,
      },
    });
    const receipt = (await commandResponse.json()) as {
      readonly operationId: string;
    };

    expect(commandResponse.status).toBe(200);
    expect(receipt).toMatchObject({
      clientCommandId: 'command_00000000000000000000000000000001',
      disposition: 'accepted',
      operationId: expect.stringMatching(/^operation_[0-9a-f]{32}$/u),
    });
    const operationResponse = await protocolRequest(runtime, 'operations', {
      operationId: receipt.operationId,
    });
    expect(await operationResponse.json()).toMatchObject({
      kind: 'succeeded',
      operationId: receipt.operationId,
      result: { kind: 'remote', summary: 'Fetched origin.' },
    });
    const fetched = repositorySnapshotSchema.parse(
      await (await protocolRequest(runtime, 'snapshot')).json(),
    );
    expect(fetched).toMatchObject({
      fetchAvailable: true,
      fetch: { kind: 'current', fetchedAt: expect.any(String) },
      worktrees: [
        {
          upstream: {
            kind: 'tracking',
            fetchedAt:
              fetched.fetch.kind === 'current'
                ? fetched.fetch.fetchedAt
                : undefined,
          },
        },
      ],
    });
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

function protocolRequest(
  runtime: StandaloneRuntime,
  endpoint: 'commands' | 'operations' | 'snapshot',
  body?: unknown,
): Promise<Response> {
  const url = new URL(
    runtime.sessionUrl.pathname.replace(/\/session$/u, `/${endpoint}`),
    runtime.sessionUrl,
  );
  return fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin: runtime.surfaceUrl.origin,
      [PROTOCOL_VERSION_HEADER]: '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

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
