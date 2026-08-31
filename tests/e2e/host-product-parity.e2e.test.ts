import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { HostContext } from '@codex-git/host-adapter';
import type {
  DedicatedCodexInstance,
  DedicatedCodexTarget,
  DedicatedRendererConnection,
} from '@codex-git/host-adapter-codex-cdp';
import {
  startCodexRuntime,
  startStandaloneRuntime,
  type StandaloneRuntime,
} from '@codex-git/launcher';
import {
  PROTOCOL_VERSION_HEADER,
  diffResultSchema,
  repositorySnapshotSchema,
} from '@codex-git/protocol';

import {
  createTemporaryGitRepository,
  type TemporaryGitRepository,
} from '../fixtures/temporary-git-repository.js';

const repositories: TemporaryGitRepository[] = [];
const runtimes: StandaloneRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    repositories.splice(0).map((repository) => repository.dispose()),
  );
});

describe('Git Surface host parity', () => {
  it('exposes the same Repository snapshot and Diff behavior through standalone and Codex hosts', async () => {
    const standaloneRepository = await productFixture();
    const codexRepository = await productFixture();
    const standalone = await startStandaloneRuntime({
      projectPath: standaloneRepository.path,
      surfacePort: 0,
    });
    runtimes.push(standalone);
    const codex = await startCodexRuntime({
      connectRenderer: async () => new CompatibleRenderer(),
      launchInstance: async () => new FixtureInstance(),
      projectPath: codexRepository.path,
      surfacePort: 0,
    });
    runtimes.push(codex);

    expect(codex.currentHost()).toBe('codex');
    await expect(productBehavior(standalone)).resolves.toEqual(
      await productBehavior(codex),
    );
  });
});

async function productFixture(): Promise<TemporaryGitRepository> {
  const repository = await createTemporaryGitRepository();
  repositories.push(repository);
  await repository.git('config', 'user.name', 'Codex Git Tests');
  await repository.git('config', 'user.email', 'codex-git@example.test');
  await writeFile(join(repository.path, 'README.md'), 'fixture\n');
  await repository.git('add', '--', 'README.md');
  await repository.git('commit', '--quiet', '-m', 'Create fixture');
  await writeFile(join(repository.path, 'README.md'), 'changed\n');
  await writeFile(join(repository.path, 'untracked.txt'), 'untracked\n');
  return repository;
}

async function productBehavior(runtime: StandaloneRuntime): Promise<unknown> {
  const surface = await (await fetch(runtime.surfaceUrl)).text();
  const snapshot = repositorySnapshotSchema.parse(
    await (await protocolRequest(runtime, 'snapshot')).json(),
  );
  const worktree = snapshot.worktrees[0];
  const changed = worktree?.changes.find(
    ({ displayPath }) => displayPath === 'README.md',
  );
  if (worktree === undefined || changed === undefined) {
    throw new Error('Expected the shared Changed File fixture.');
  }
  const diff = diffResultSchema.parse(
    await (
      await protocolRequest(runtime, 'diff', { fileId: changed.fileId })
    ).json(),
  );

  return {
    changes: worktree.changes.map(
      ({ baseline, displayPath, kind, previousDisplayPath }) => ({
        baseline,
        displayPath,
        kind,
        previousDisplayPath,
      }),
    ),
    diff:
      diff.kind === 'text'
        ? { baseline: diff.baseline, content: diff.content, kind: diff.kind }
        : diff,
    head: worktree.head.kind,
    role: worktree.role,
    surfaceEntry: surface.includes('src="/src/main.tsx"'),
  };
}

function protocolRequest(
  runtime: StandaloneRuntime,
  endpoint: 'diff' | 'snapshot',
  body?: unknown,
): Promise<Response> {
  const url = new URL(
    runtime.sessionUrl.pathname.replace(/\/session$/u, `/${endpoint}`),
    runtime.sessionUrl,
  );
  return fetch(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      origin: runtime.surfaceUrl.origin,
      [PROTOCOL_VERSION_HEADER]: '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    method: body === undefined ? 'GET' : 'POST',
  });
}

const ownedTarget = {
  id: 'renderer-parity',
  webSocketUrl: 'ws://127.0.0.1:43117/devtools/page/renderer-parity',
} satisfies DedicatedCodexTarget;

class FixtureInstance implements DedicatedCodexInstance {
  readonly build = '7119';
  readonly ownership = {
    endpoint: 'http://127.0.0.1:43117/',
    instanceId: 'instance-parity',
    processId: 4242,
    profilePath: '/private/tmp/codex-git-parity-profile',
  };
  readonly version = '26.820.60940';

  async currentTarget(): Promise<DedicatedCodexTarget> {
    return ownedTarget;
  }
  subscribe(): () => void {
    return () => undefined;
  }
  async close(): Promise<void> {}
}

class CompatibleRenderer implements DedicatedRendererConnection {
  currentContext(): HostContext {
    return { projectPath: null, task: null, theme: 'system' };
  }
  isSurfaceOpen(): boolean {
    return true;
  }
  projectIdentity(): { readonly id: string; readonly label: string } {
    return { id: 'project-parity', label: 'codex-git' };
  }
  subscribe(): () => void {
    return () => undefined;
  }
  async perform(): Promise<{ readonly status: 'unsupported' }> {
    return { status: 'unsupported' };
  }
  async close(): Promise<void> {}
}
