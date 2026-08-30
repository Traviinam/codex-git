import {
  clientCommandIdSchema,
  commandEnvelopeSchema,
  operationReceiptSchema,
  operationRecoveryRequestSchema,
  operationResultSchema,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  repositorySnapshotResultSchema,
  sessionMetadataSchema,
  sseInvalidationSchema,
} from '@codex-git/protocol';

import type {
  RepositoryOverviewSource,
  RepositoryOverviewSourceState,
} from './repository-overview-model.js';

interface EventSourceLike {
  addEventListener(
    type: 'invalidation',
    listener: (event: MessageEvent<string>) => void,
  ): void;
  close(): void;
}

export interface ProtocolRepositorySourceOptions {
  readonly projectPath: string;
  readonly sessionUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly createEventSource?: (url: string) => EventSourceLike;
}

export function createProtocolRepositorySource(
  options: ProtocolRepositorySourceOptions,
): RepositoryOverviewSource {
  const listeners = new Set<() => void>();
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const createEventSource =
    options.createEventSource ?? ((url: string) => new EventSource(url));
  let state: RepositoryOverviewSourceState = {
    kind: 'loading',
    message: 'Resolving the Current Project…',
  };
  let events: EventSourceLike | undefined;
  let active = true;
  let refresh: Promise<void> | undefined;
  let snapshotInvalidated = false;
  let commandsAvailable = false;
  let operationRecoveryAvailable = false;
  let latestFetchResult:
    import('@codex-git/protocol').OperationResult | undefined;

  const publish = (next: RepositoryOverviewSourceState) => {
    if (!active) return;
    state = next;
    listeners.forEach((listener) => listener());
  };

  const requestSnapshot = () => {
    if (refresh !== undefined) return refresh;
    refresh = fetchSnapshot(fetcher, options.sessionUrl)
      .then((snapshot) => {
        if (snapshot.kind === 'repository') {
          publish({
            kind: 'repository',
            snapshot: {
              ...snapshot,
              fetchAvailable: snapshot.fetchAvailable && commandsAvailable,
              fetchResult: latestFetchResult,
            },
          });
          return;
        }
        publish({
          kind:
            snapshot.kind === 'non_repository' ? 'non-repository' : 'failed',
          projectPath: snapshot.projectPath,
          message: snapshot.message,
        });
      })
      .catch(() => {
        const message = 'The Repository snapshot could not be loaded.';
        publish(
          state.kind === 'repository'
            ? {
                kind: 'repository',
                snapshot: {
                  ...state.snapshot,
                  refresh: { kind: 'failed', message },
                },
              }
            : { kind: 'failed', projectPath: options.projectPath, message },
        );
      })
      .finally(() => {
        refresh = undefined;
        if (snapshotInvalidated) {
          snapshotInvalidated = false;
          void requestSnapshot();
        }
      });
    return refresh;
  };

  void negotiate(fetcher, options.sessionUrl)
    .then((metadata) => {
      if (!active) return;
      commandsAvailable = metadata.capabilities.commands;
      operationRecoveryAvailable = metadata.capabilities.operationRecovery;
      if (metadata.capabilities.events) {
        events = createEventSource(endpointUrl(options.sessionUrl, 'events'));
        events.addEventListener('invalidation', (event) => {
          if (!requiresSnapshot(state, event.data)) return;
          if (refresh === undefined) {
            void requestSnapshot();
          } else {
            snapshotInvalidated = true;
          }
        });
      }
      return requestSnapshot();
    })
    .catch(() => {
      publish({
        kind: 'failed',
        projectPath: options.projectPath,
        message: 'The local Git protocol could not be negotiated.',
      });
    });

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      if (!active) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          active = false;
          events?.close();
        }
      };
    },
    requestRefresh() {
      void requestSnapshot();
    },
    requestFetch(remoteId) {
      if (
        !commandsAvailable ||
        state.kind !== 'repository' ||
        state.snapshot.fetchAvailable === false
      ) {
        return;
      }
      const snapshot = state.snapshot;
      const envelope = commandEnvelopeSchema.parse({
        clientCommandId: createClientCommandId(),
        command:
          remoteId === null
            ? {
                kind: 'fetch_all',
                repositoryId: snapshot.repositoryId,
                expectedRefsRevision: snapshot.refsRevision,
              }
            : {
                kind: 'fetch_remote',
                repositoryId: snapshot.repositoryId,
                remoteId,
                expectedRefsRevision: snapshot.refsRevision,
              },
      });
      void submitCommand(fetcher, options.sessionUrl, envelope)
        .then((receipt) =>
          operationRecoveryAvailable
            ? recoverOperation(fetcher, options.sessionUrl, receipt.operationId)
            : undefined,
        )
        .then((result) => {
          if (result === undefined || state.kind !== 'repository') return;
          latestFetchResult = result;
          publish({
            kind: 'repository',
            snapshot: { ...state.snapshot, fetchResult: result },
          });
        })
        .catch(() => {
          if (state.kind !== 'repository') return;
          const fetchedAt =
            state.snapshot.fetch.kind === 'never'
              ? null
              : state.snapshot.fetch.fetchedAt;
          publish({
            kind: 'repository',
            snapshot: {
              ...state.snapshot,
              fetchResult: latestFetchResult,
              fetch: {
                kind: 'failed',
                fetchedAt,
                message: 'The Fetch command could not be submitted.',
              },
            },
          });
        });
    },
  };
}

function requiresSnapshot(
  state: RepositoryOverviewSourceState,
  data: string,
): boolean {
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch {
    return false;
  }
  const parsed = sseInvalidationSchema.safeParse(decoded);
  if (!parsed.success || state.kind !== 'repository') return false;
  const invalidation = parsed.data;
  if (invalidation.kind === 'operation_progress') return true;
  if (invalidation.repositoryId !== state.snapshot.repositoryId) return false;
  if (invalidation.kind === 'repository_revision') {
    return invalidation.repositoryRevision > state.snapshot.repositoryRevision;
  }
  const worktree = state.snapshot.worktrees.find(
    ({ worktreeId }) => worktreeId === invalidation.worktreeId,
  );
  return (
    invalidation.repositoryRevision > state.snapshot.repositoryRevision ||
    worktree === undefined ||
    invalidation.worktreeRevision > worktree.worktreeRevision
  );
}

async function negotiate(fetcher: typeof fetch, sessionUrl: string) {
  const response = await protocolFetch(fetcher, sessionUrl);
  if (!response.ok) throw new Error('Protocol negotiation failed.');
  return sessionMetadataSchema.parse(await response.json());
}

async function fetchSnapshot(fetcher: typeof fetch, sessionUrl: string) {
  const response = await protocolFetch(
    fetcher,
    endpointUrl(sessionUrl, 'snapshot'),
  );
  if (!response.ok) throw new Error('Repository snapshot failed.');
  return repositorySnapshotResultSchema.parse(await response.json());
}

async function submitCommand(
  fetcher: typeof fetch,
  sessionUrl: string,
  envelope: unknown,
) {
  const response = await protocolFetch(
    fetcher,
    endpointUrl(sessionUrl, 'commands'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    },
  );
  if (!response.ok) throw new Error('Fetch command submission failed.');
  return operationReceiptSchema.parse(await response.json());
}

async function recoverOperation(
  fetcher: typeof fetch,
  sessionUrl: string,
  operationId: import('@codex-git/protocol').OperationId,
) {
  const request = operationRecoveryRequestSchema.parse({ operationId });
  const response = await protocolFetch(
    fetcher,
    endpointUrl(sessionUrl, 'operations'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    },
  );
  if (!response.ok) throw new Error('Fetch operation recovery failed.');
  return operationResultSchema.parse(await response.json());
}

function protocolFetch(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit = {},
) {
  return fetcher(url, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION),
    },
  });
}

function endpointUrl(
  sessionUrl: string,
  endpoint: 'commands' | 'events' | 'operations' | 'snapshot',
) {
  return sessionUrl.replace(/\/session$/u, `/${endpoint}`);
}

function createClientCommandId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const value = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return clientCommandIdSchema.parse(`command_${value}`);
}
