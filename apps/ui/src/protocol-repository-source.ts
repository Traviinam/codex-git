import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  diffResultSchema,
  nativeActionResultSchema,
  branchSearchResultSchema,
  operationReceiptSchema,
  operationResultSchema,
  repositorySnapshotResultSchema,
  sessionMetadataSchema,
  sseInvalidationSchema,
} from '@codex-git/protocol';
import type { BranchSearchRequest, ProductCommand } from '@codex-git/protocol';

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
          publish({ kind: 'repository', snapshot });
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
    requestFetch() {
      // Fetch is enabled by Issue #13. The overview remains truthful until then.
    },
    async requestDiff(fileId) {
      const response = await protocolFetch(
        fetcher,
        endpointUrl(options.sessionUrl, 'diff'),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileId }),
        },
      );
      if (!response.ok) throw new Error('Diff request failed.');
      return diffResultSchema.parse(await response.json());
    },
    async requestNativeAction(request) {
      const response = await protocolFetch(
        fetcher,
        endpointUrl(options.sessionUrl, 'native-actions'),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        },
      );
      if (!response.ok) throw new Error('Native action request failed.');
      return nativeActionResultSchema.parse(await response.json());
    },
    async searchBranches(worktreeId, query) {
      const response = await protocolPost(
        fetcher,
        endpointUrl(options.sessionUrl, 'branches'),
        { worktreeId, query } satisfies BranchSearchRequest,
      );
      if (!response.ok) throw new Error('Branch search failed.');
      return branchSearchResultSchema.parse(await response.json());
    },
    async switchBranch(request) {
      const clientCommandId = createClientCommandId();
      const command = {
        kind: 'switch_branch',
        ...request,
      } satisfies ProductCommand;
      const submitted = await protocolPost(
        fetcher,
        endpointUrl(options.sessionUrl, 'commands'),
        { clientCommandId, command },
      );
      if (!submitted.ok) throw new Error('Branch switch submission failed.');
      const receipt = operationReceiptSchema.parse(await submitted.json());
      const recovery = await protocolPost(
        fetcher,
        endpointUrl(options.sessionUrl, 'operations'),
        { operationId: receipt.operationId },
      );
      if (!recovery.ok) throw new Error('Branch switch recovery failed.');
      const result = operationResultSchema.parse(await recovery.json());
      await requestSnapshot();
      return result;
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

function protocolPost(fetcher: typeof fetch, url: string, body: unknown) {
  return fetcher(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION),
    },
    body: JSON.stringify(body),
  });
}

function endpointUrl(
  sessionUrl: string,
  endpoint:
    | 'branches'
    | 'commands'
    | 'diff'
    | 'events'
    | 'native-actions'
    | 'operations'
    | 'snapshot',
) {
  return sessionUrl.replace(/\/session$/u, `/${endpoint}`);
}

function createClientCommandId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `command_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}` as const;
}
