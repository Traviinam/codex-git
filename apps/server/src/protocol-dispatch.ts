import { createHash } from 'node:crypto';

import {
  branchSearchRequestSchema,
  branchSearchResultSchema,
  commitDraftSchema,
  commitDraftUpdateSchema,
  commandEnvelopeSchema,
  diffRequestSchema,
  diffResultSchema,
  operationReceiptSchema,
  operationRecoveryRequestSchema,
  operationResultSchema,
  nativeActionRequestSchema,
  nativeActionResultSchema,
  parseProtocolPayload,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  type DiffRequest,
  type DiffResult,
  type FileId,
  type BranchSearchRequest,
  type BranchSearchResult,
  type CommitDraft,
  type CommitDraftUpdate,
  type CommandEnvelope,
  type RepositorySnapshot,
  type OperationReceipt,
  type OperationId,
  type OperationResult,
  type NativeActionKind,
  type NativeActionRequest,
  type NativeActionResult,
  type NativeTargetId,
  repositorySnapshotSchema,
  type SessionMetadata,
  type WorktreeId,
} from '@codex-git/protocol';

type Awaitable<T> = Promise<T> | T;

export interface NativeActionHandler {
  actionsForTarget(
    targetId: NativeTargetId,
  ): Awaitable<readonly NativeActionKind[] | undefined>;
  perform(request: NativeActionRequest): Awaitable<NativeActionResult>;
}

export interface ProtocolHandlers {
  readonly branchSearch?: (
    request: BranchSearchRequest,
  ) => Awaitable<BranchSearchResult>;
  readonly commitDrafts?: (
    request: CommitDraftUpdate,
  ) => Awaitable<CommitDraft>;
  readonly commands?: (request: CommandEnvelope) => Awaitable<OperationReceipt>;
  readonly operationRecovery?: (
    operationId: OperationId,
  ) => Awaitable<OperationResult>;
  readonly nativeActions?: NativeActionHandler;
  readonly diff?: (request: DiffRequest) => Awaitable<DiffResult>;
  readonly snapshot?: () => Awaitable<RepositorySnapshot>;
}

export interface ProtocolDispatchResponse {
  readonly status: number;
  readonly value: unknown;
}

export interface ProtocolDispatcher {
  readonly sessionMetadata: SessionMetadata;
  dispatch(
    endpoint: string,
    body?: Uint8Array,
  ): Promise<ProtocolDispatchResponse | undefined>;
}

export function createProtocolDispatcher(
  handlers: ProtocolHandlers = {},
): ProtocolDispatcher {
  const commandRecords = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly response: Promise<ProtocolDispatchResponse>;
    }
  >();

  return {
    sessionMetadata: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        branchSearch: handlers.branchSearch !== undefined,
        commands: handlers.commands !== undefined,
        commitDrafts: handlers.commitDrafts !== undefined,
        diff: handlers.diff !== undefined,
        events: true,
        nativeActions: handlers.nativeActions !== undefined,
        operationRecovery: handlers.operationRecovery !== undefined,
      },
      limits: PROTOCOL_LIMITS,
    },
    async dispatch(endpoint, body) {
      if (endpoint === 'snapshot' && handlers.snapshot !== undefined) {
        return validatedResponse(
          repositorySnapshotSchema,
          await handlers.snapshot(),
        );
      }
      if (endpoint === 'diff' && handlers.diff !== undefined) {
        const input = parseJsonBody(body);
        if (!input.ok) return input.response;
        const request = parseProtocolPayload(diffRequestSchema, input.value);
        if (!request.ok) {
          return { status: 400, value: { error: request.error } };
        }
        return diffResponse(
          request.value.fileId,
          await handlers.diff(request.value),
        );
      }
      if (endpoint === 'branches' && handlers.branchSearch !== undefined) {
        const input = parseJsonBody(body);
        if (!input.ok) return input.response;
        const request = parseProtocolPayload(
          branchSearchRequestSchema,
          input.value,
        );
        if (!request.ok) {
          return { status: 400, value: { error: request.error } };
        }
        return validatedResponse(
          branchSearchResultSchema,
          await handlers.branchSearch(request.value),
        );
      }
      if (endpoint === 'draft' && handlers.commitDrafts !== undefined) {
        const input = parseJsonBody(body);
        if (!input.ok) return input.response;
        const request = parseProtocolPayload(
          commitDraftUpdateSchema,
          input.value,
        );
        if (!request.ok) {
          return { status: 400, value: { error: request.error } };
        }
        return commitDraftResponse(
          request.value.worktreeId,
          await handlers.commitDrafts(request.value),
        );
      }
      if (endpoint === 'commands' && handlers.commands !== undefined) {
        const input = parseJsonBody(body);
        if (!input.ok) return input.response;
        const request = parseProtocolPayload(
          commandEnvelopeSchema,
          input.value,
        );
        if (!request.ok) {
          return { status: 400, value: { error: request.error } };
        }
        const fingerprint = fingerprintCommand(request.value.command);
        const existing = commandRecords.get(request.value.clientCommandId);
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            return commandCollisionResponse();
          }
          let response: ProtocolDispatchResponse;
          try {
            response = await existing.response;
          } catch {
            return duplicateCommandResponse();
          }
          const receipt = operationReceiptSchema.safeParse(response.value);
          if (response.status !== 200 || !receipt.success) {
            return duplicateCommandResponse();
          }
          return {
            status: 200,
            value: { ...receipt.data, disposition: 'duplicate' },
          };
        }
        const dispatchCommand = handlers.commands;
        const response = Promise.resolve()
          .then(() => dispatchCommand(request.value))
          .then((value) => acceptedCommandResponse(request.value, value));
        commandRecords.set(request.value.clientCommandId, {
          fingerprint,
          response,
        });
        return response;
      }
      if (
        endpoint === 'operations' &&
        handlers.operationRecovery !== undefined
      ) {
        const input = parseJsonBody(body);
        if (!input.ok) return input.response;
        const request = parseProtocolPayload(
          operationRecoveryRequestSchema,
          input.value,
        );
        if (!request.ok) {
          return { status: 400, value: { error: request.error } };
        }
        return operationRecoveryResponse(
          request.value.operationId,
          await handlers.operationRecovery(request.value.operationId),
        );
      }
      if (
        endpoint === 'native-actions' &&
        handlers.nativeActions !== undefined
      ) {
        const input = parseJsonBody(body);
        if (!input.ok) return input.response;
        const request = parseProtocolPayload(
          nativeActionRequestSchema,
          input.value,
        );
        if (!request.ok) {
          return { status: 400, value: { error: request.error } };
        }
        const allowed = await handlers.nativeActions.actionsForTarget(
          request.value.targetId,
        );
        if (allowed === undefined || !allowed.includes(request.value.kind)) {
          return staleNativeTargetResponse();
        }
        return validatedResponse(
          nativeActionResultSchema,
          await handlers.nativeActions.perform(request.value),
        );
      }
      return undefined;
    },
  };
}

function fingerprintCommand(command: CommandEnvelope['command']): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

function diffResponse(
  fileId: FileId,
  value: unknown,
): ProtocolDispatchResponse {
  const result = diffResultSchema.safeParse(value);
  if (!result.success || result.data.fileId !== fileId) {
    return invalidHandlerResponse();
  }
  return { status: 200, value: result.data };
}

function commitDraftResponse(
  worktreeId: WorktreeId,
  value: unknown,
): ProtocolDispatchResponse {
  const draft = commitDraftSchema.safeParse(value);
  if (!draft.success || draft.data.worktreeId !== worktreeId) {
    return invalidHandlerResponse();
  }
  return { status: 200, value: draft.data };
}

function staleNativeTargetResponse(): ProtocolDispatchResponse {
  return {
    status: 409,
    value: {
      error: {
        code: 'stale_target',
        message: 'The native target is stale or does not allow this action.',
      },
    },
  };
}

function operationRecoveryResponse(
  operationId: OperationId,
  value: unknown,
): ProtocolDispatchResponse {
  const result = operationResultSchema.safeParse(value);
  if (!result.success || result.data.operationId !== operationId) {
    return invalidHandlerResponse();
  }
  return { status: 200, value: result.data };
}

function acceptedCommandResponse(
  request: CommandEnvelope,
  value: unknown,
): ProtocolDispatchResponse {
  const receipt = operationReceiptSchema.safeParse(value);
  if (
    !receipt.success ||
    receipt.data.clientCommandId !== request.clientCommandId ||
    receipt.data.disposition !== 'accepted'
  ) {
    return invalidHandlerResponse();
  }
  return { status: 200, value: receipt.data };
}

function commandCollisionResponse(): ProtocolDispatchResponse {
  return {
    status: 409,
    value: {
      error: {
        code: 'command_id_collision',
        message: 'The client command ID was already used for another command.',
      },
    },
  };
}

function duplicateCommandResponse(): ProtocolDispatchResponse {
  return {
    status: 409,
    value: {
      error: {
        code: 'duplicate_command',
        message: 'The duplicate command cannot be replayed safely.',
      },
    },
  };
}

interface RuntimeSchema<T> {
  safeParse(
    input: unknown,
  ): { readonly data: T; readonly success: true } | { readonly success: false };
}

function validatedResponse<T>(
  schema: RuntimeSchema<T>,
  value: unknown,
): ProtocolDispatchResponse {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { status: 200, value: parsed.data };
  return invalidHandlerResponse();
}

function invalidHandlerResponse(): ProtocolDispatchResponse {
  return {
    status: 500,
    value: {
      error: {
        code: 'internal_error',
        message: 'The protocol handler returned an invalid response.',
      },
    },
  };
}

type JsonBodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: ProtocolDispatchResponse };

function parseJsonBody(body: Uint8Array | undefined): JsonBodyResult {
  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder().decode(body)) as unknown,
    };
  } catch {
    return {
      ok: false,
      response: {
        status: 400,
        value: {
          error: {
            code: 'invalid_payload',
            message: 'The protocol request body is not valid JSON.',
          },
        },
      },
    };
  }
}
