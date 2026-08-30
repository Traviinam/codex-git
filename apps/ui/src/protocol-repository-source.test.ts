import { describe, expect, it } from 'vitest';

import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  remoteIdSchema,
} from '@codex-git/protocol';

import { createProtocolRepositorySource } from './protocol-repository-source.js';

describe('ProtocolRepositorySource', () => {
  it('negotiates the protocol and publishes the authoritative snapshot', async () => {
    const requests: Array<{
      readonly url: string;
      readonly version: string | null;
    }> = [];
    const sessionUrl =
      'http://127.0.0.1:4173/instance/fixture-token/v1/session';
    const source = createProtocolRepositorySource({
      projectPath: '/projects/codex-git',
      sessionUrl,
      createEventSource: () => new FakeEventSource(),
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          version: new Headers(init?.headers).get(PROTOCOL_VERSION_HEADER),
        });
        return jsonResponse(
          url.endsWith('/session') ? sessionMetadata : repositorySnapshot,
        );
      },
    });

    expect(source.getSnapshot()).toEqual({
      kind: 'loading',
      message: 'Resolving the Current Project…',
    });
    await until(() => source.getSnapshot().kind === 'repository');

    expect(source.getSnapshot()).toMatchObject({
      kind: 'repository',
      snapshot: {
        displayName: 'codex-git',
        path: '/projects/codex-git',
        refresh: { kind: 'current' },
        worktrees: [
          {
            displayName: 'codex-git',
            path: '/projects/codex-git',
            role: 'main',
            status: { kind: 'clean' },
            upstream: { kind: 'unpublished' },
          },
        ],
      },
    });
    expect(requests).toEqual([
      { url: sessionUrl, version: String(PROTOCOL_VERSION) },
      {
        url: sessionUrl.replace(/\/session$/u, '/snapshot'),
        version: String(PROTOCOL_VERSION),
      },
    ]);
  });

  it('refetches for a newer Repository invalidation and ignores stale revisions', async () => {
    const events = new FakeEventSource();
    let snapshotRequests = 0;
    const sessionUrl =
      'http://127.0.0.1:4173/instance/fixture-token/v1/session';
    const source = createProtocolRepositorySource({
      projectPath: '/projects/codex-git',
      sessionUrl,
      createEventSource: () => events,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith('/session')) return jsonResponse(sessionMetadata);
        snapshotRequests += 1;
        return jsonResponse({
          ...repositorySnapshot,
          repositoryRevision: snapshotRequests,
        });
      },
    });
    const unsubscribe = source.subscribe(() => undefined);
    await until(
      () =>
        source.getSnapshot().kind === 'repository' && snapshotRequests === 1,
    );

    events.emit({
      kind: 'repository_revision',
      repositoryId: repositorySnapshot.repositoryId,
      repositoryRevision: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(snapshotRequests).toBe(1);

    events.emit({
      kind: 'repository_revision',
      repositoryId: repositorySnapshot.repositoryId,
      repositoryRevision: 2,
    });
    await until(() => {
      const state = source.getSnapshot();
      return (
        state.kind === 'repository' && state.snapshot.repositoryRevision === 2
      );
    });
    expect(source.getSnapshot()).toMatchObject({
      kind: 'repository',
      snapshot: { repositoryRevision: 2 },
    });
    unsubscribe();
    expect(events.closed).toBe(true);
  });

  it('keeps the last good snapshot when a manual refresh fails', async () => {
    let snapshotRequests = 0;
    const source = createProtocolRepositorySource({
      projectPath: '/projects/codex-git',
      sessionUrl: 'http://127.0.0.1:4173/instance/fixture-token/v1/session',
      createEventSource: () => new FakeEventSource(),
      fetch: async (input) => {
        if (String(input).endsWith('/session')) {
          return jsonResponse(sessionMetadata);
        }
        snapshotRequests += 1;
        return snapshotRequests === 1
          ? jsonResponse(repositorySnapshot)
          : new Response(null, { status: 503 });
      },
    });
    await until(() => source.getSnapshot().kind === 'repository');

    source.requestRefresh();
    await until(() => {
      const state = source.getSnapshot();
      return (
        state.kind === 'repository' && state.snapshot.refresh.kind === 'failed'
      );
    });

    expect(source.getSnapshot()).toMatchObject({
      kind: 'repository',
      snapshot: {
        repositoryId: repositorySnapshot.repositoryId,
        refresh: {
          kind: 'failed',
          message: 'The Repository snapshot could not be loaded.',
        },
      },
    });
  });

  it('submits an explicit Fetch intent with opaque snapshot authority', async () => {
    const commands: unknown[] = [];
    const operations: unknown[] = [];
    const source = createProtocolRepositorySource({
      projectPath: '/projects/codex-git',
      sessionUrl: 'http://127.0.0.1:4173/instance/fixture-token/v1/session',
      createEventSource: () => new FakeEventSource(),
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/session')) {
          return jsonResponse({
            ...sessionMetadata,
            capabilities: {
              ...sessionMetadata.capabilities,
              commands: true,
              operationRecovery: true,
            },
          });
        }
        if (url.endsWith('/snapshot')) {
          return jsonResponse({
            ...repositorySnapshot,
            fetchAvailable: true,
            remotes: [
              {
                remoteId: 'remote_0123456789abcdef0123456789abcdef',
                displayName: 'origin',
                host: 'example.test',
              },
            ],
          });
        }
        if (url.endsWith('/operations')) {
          operations.push(JSON.parse(String(init?.body)));
          return jsonResponse({
            kind: 'succeeded',
            operationId: 'operation_0123456789abcdef0123456789abcdef',
            result: { kind: 'remote', summary: 'Fetched origin.' },
          });
        }
        const command = JSON.parse(String(init?.body)) as {
          readonly clientCommandId: string;
        };
        commands.push({
          body: command,
          contentType: new Headers(init?.headers).get('content-type'),
          method: init?.method,
          url,
          version: new Headers(init?.headers).get(PROTOCOL_VERSION_HEADER),
        });
        return jsonResponse({
          operationId: 'operation_0123456789abcdef0123456789abcdef',
          clientCommandId: command.clientCommandId,
          disposition: 'accepted',
        });
      },
    });
    await until(() => source.getSnapshot().kind === 'repository');

    source.requestFetch(
      remoteIdSchema.parse('remote_0123456789abcdef0123456789abcdef'),
    );
    await until(() => commands.length === 1);
    await until(() => operations.length === 1);

    expect(commands).toEqual([
      {
        body: {
          clientCommandId: expect.stringMatching(/^command_[0-9a-f]{32}$/u),
          command: {
            kind: 'fetch_remote',
            repositoryId: repositorySnapshot.repositoryId,
            remoteId: 'remote_0123456789abcdef0123456789abcdef',
            expectedRefsRevision: repositorySnapshot.refsRevision,
          },
        },
        contentType: 'application/json',
        method: 'POST',
        url: 'http://127.0.0.1:4173/instance/fixture-token/v1/commands',
        version: String(PROTOCOL_VERSION),
      },
    ]);
    expect(operations).toEqual([
      { operationId: 'operation_0123456789abcdef0123456789abcdef' },
    ]);
    expect(source.getSnapshot()).toMatchObject({
      kind: 'repository',
      snapshot: {
        fetchResult: {
          kind: 'succeeded',
          result: { kind: 'remote', summary: 'Fetched origin.' },
        },
      },
    });
  });

  it('refetches when a newer invalidation arrives during an in-flight snapshot', async () => {
    const events = new FakeEventSource();
    const inFlight = deferred<Response>();
    let snapshotRequests = 0;
    const source = createProtocolRepositorySource({
      projectPath: '/projects/codex-git',
      sessionUrl: 'http://127.0.0.1:4173/instance/fixture-token/v1/session',
      createEventSource: () => events,
      fetch: async (input) => {
        if (String(input).endsWith('/session')) {
          return jsonResponse(sessionMetadata);
        }
        snapshotRequests += 1;
        if (snapshotRequests === 1) return jsonResponse(repositorySnapshot);
        if (snapshotRequests === 2) return inFlight.promise;
        return jsonResponse({
          ...repositorySnapshot,
          repositoryRevision: 3,
        });
      },
    });
    await until(() => source.getSnapshot().kind === 'repository');

    source.requestRefresh();
    await until(() => snapshotRequests === 2);
    events.emit({
      kind: 'repository_revision',
      repositoryId: repositorySnapshot.repositoryId,
      repositoryRevision: 3,
    });
    inFlight.resolve(
      jsonResponse({ ...repositorySnapshot, repositoryRevision: 2 }),
    );

    await until(() => {
      const state = source.getSnapshot();
      return (
        snapshotRequests === 3 &&
        state.kind === 'repository' &&
        state.snapshot.repositoryRevision === 3
      );
    });
  });
});

class FakeEventSource {
  closed = false;
  #listener?: (event: MessageEvent<string>) => void;

  addEventListener(
    _type: 'invalidation',
    listener: (event: MessageEvent<string>) => void,
  ) {
    this.#listener = listener;
  }

  close() {
    this.closed = true;
  }

  emit(value: unknown) {
    this.#listener?.({ data: JSON.stringify(value) } as MessageEvent<string>);
  }
}

const sessionMetadata = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    branchSearch: false,
    commands: false,
    commitDrafts: false,
    diff: false,
    events: true,
    nativeActions: false,
    operationRecovery: false,
  },
  limits: {
    diffOutputBytes: 2_097_152,
    draftBytes: 65_536,
    requestBodyBytes: 262_144,
  },
};

const repositorySnapshot = {
  kind: 'repository',
  repositoryId: 'repository_0123456789abcdef0123456789abcdef',
  repositoryRevision: 1,
  topologyRevision: 1,
  refsRevision: 1,
  displayName: 'codex-git',
  path: '/projects/codex-git',
  refresh: { kind: 'current' },
  fetch: { kind: 'never' },
  fetchAvailable: false,
  worktrees: [
    {
      worktreeId: 'worktree_0123456789abcdef0123456789abcdef',
      worktreeRevision: 1,
      generation: 'generation_0123456789abcdef0123456789abcdef',
      role: 'main',
      displayName: 'codex-git',
      path: '/projects/codex-git',
      availability: { kind: 'available' },
      freshness: { kind: 'current' },
      head: {
        kind: 'local_branch',
        displayName: 'dev',
        objectId: '0123456789abcdef0123456789abcdef01234567',
      },
      indexTree: null,
      status: { kind: 'clean' },
      upstream: { kind: 'unpublished', remoteName: null, fetchedAt: null },
      changes: [],
      nativeTargets: [],
    },
  ],
  remotes: [],
  operations: [],
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for ProtocolRepositorySource state.');
}
