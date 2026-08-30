import { describe, expect, it } from 'vitest';

import {
  branchSearchRequestSchema,
  branchSearchResultSchema,
  changedFileSchema,
  createOpaqueIdAuthority,
  createDiagnosticRedactor,
  commitDraftUpdateSchema,
  commandEnvelopeSchema,
  operationResultSchema,
  nativeActionRequestSchema,
  sseInvalidationSchema,
  diffRequestSchema,
  diffResultSchema,
  parseProtocolPayload,
  PROTOCOL_VERSION,
  protocolErrorResponseSchema,
  repositorySnapshotSchema,
  sessionMetadataSchema,
} from '@codex-git/protocol';

describe('protocol runtime schemas', () => {
  it('accepts compatible session metadata', () => {
    const result = sessionMetadataSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        branchSearch: true,
        commands: true,
        commitDrafts: true,
        diff: true,
        events: true,
        nativeActions: true,
        operationRecovery: true,
      },
      limits: {
        diffOutputBytes: 2_097_152,
        draftBytes: 65_536,
        requestBodyBytes: 262_144,
      },
    });

    expect(result.success).toBe(true);
  });

  it('returns a structured error for a cross-version payload', () => {
    const result = parseProtocolPayload(sessionMetadataSchema, {
      protocolVersion: 2,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'unsupported_protocol_version',
        details: {
          received: 2,
          supported: [PROTOCOL_VERSION],
        },
        message: 'The requested protocol version is not supported.',
      },
    });
  });

  it('does not reflect a secret-bearing cross-version value', () => {
    const result = parseProtocolPayload(sessionMetadataSchema, {
      protocolVersion: 'token=fixture-cross-version-secret',
    });

    expect(JSON.stringify(result)).not.toContain(
      'fixture-cross-version-secret',
    );
  });

  it('does not reflect secret-shaped attacker input in validation errors', () => {
    const result = parseProtocolPayload(sessionMetadataSchema, {
      protocolVersion: PROTOCOL_VERSION,
      'token=fixture-reflected-secret': true,
    });

    expect(JSON.stringify(result)).not.toContain('fixture-reflected-secret');
  });

  it('accepts a stable structured protocol error response', () => {
    const result = protocolErrorResponseSchema.safeParse({
      error: {
        code: 'body_too_large',
        message: 'The request body exceeds the configured limit.',
        details: { limitBytes: 262_144 },
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts a coherent repository snapshot made only of opaque authority', () => {
    const result = repositorySnapshotSchema.safeParse({
      kind: 'repository',
      repositoryId: 'repository_0123456789abcdef0123456789abcdef',
      repositoryRevision: 4,
      topologyRevision: 2,
      refsRevision: 3,
      displayName: 'repository',
      path: '/workspace/repository',
      refresh: { kind: 'current' },
      fetch: { kind: 'never' },
      fetchAvailable: true,
      worktrees: [
        {
          worktreeId: 'worktree_0123456789abcdef0123456789abcdef',
          worktreeRevision: 7,
          generation: 'generation_0123456789abcdef0123456789abcdef',
          role: 'main',
          displayName: 'repository',
          path: '/workspace/repository',
          availability: { kind: 'available' },
          freshness: { kind: 'current' },
          head: { kind: 'initial' },
          indexTree: null,
          status: { kind: 'clean' },
          upstream: {
            kind: 'not-applicable',
            reason: 'The branch has no configured Upstream.',
          },
          changes: [
            {
              fileId: 'file_0123456789abcdef0123456789abcdef',
              kind: 'change',
              baseline: 'index_to_working_tree',
              displayPath: 'src/example.ts',
              nativeTargets: [
                {
                  targetId: 'native_0123456789abcdef0123456789abcdef',
                  actions: ['open_file_in_codex', 'copy_relative_path'],
                },
              ],
            },
          ],
          nativeTargets: [],
        },
      ],
      remotes: [
        {
          remoteId: 'remote_0123456789abcdef0123456789abcdef',
          displayName: 'origin',
          host: 'github.com',
        },
      ],
      operations: [],
    });

    expect(result.success).toBe(true);
  });

  it('rejects an absolute path added to an on-demand diff request', () => {
    const result = diffRequestSchema.safeParse({
      fileId: 'file_0123456789abcdef0123456789abcdef',
      path: '/Users/example/repository/secret.txt',
    });

    expect(result.success).toBe(false);
  });

  it('accepts bounded display content for an on-demand diff result', () => {
    const result = diffResultSchema.safeParse({
      kind: 'text',
      fileId: 'file_0123456789abcdef0123456789abcdef',
      baseline: 'index_to_working_tree',
      content: '@@ -1 +1 @@\n-old\n+new\n',
      lineCount: 3,
    });

    expect(result.success).toBe(true);
  });

  it('accepts metadata instead of truncated content for an oversized diff', () => {
    const result = diffResultSchema.safeParse({
      kind: 'too_large',
      fileId: 'file_0123456789abcdef0123456789abcdef',
      baseline: 'head_to_index',
      byteCount: 2_097_153,
      lineCount: null,
    });

    expect(result.success).toBe(true);
  });

  it('accepts metadata instead of display content for a binary diff', () => {
    const result = diffResultSchema.safeParse({
      kind: 'binary',
      fileId: 'file_0123456789abcdef0123456789abcdef',
      baseline: 'head_to_index',
      byteCount: 512,
    });

    expect(result.success).toBe(true);
  });

  it('accepts metadata instead of replacement characters for an undecodable diff', () => {
    const result = diffResultSchema.safeParse({
      kind: 'undecodable',
      fileId: 'file_0123456789abcdef0123456789abcdef',
      baseline: 'index_to_working_tree',
      byteCount: 128,
    });

    expect(result.success).toBe(true);
  });

  it('rejects an incoherent Changed File kind and Diff Baseline', () => {
    const result = changedFileSchema.safeParse({
      fileId: 'file_0123456789abcdef0123456789abcdef',
      kind: 'untracked',
      baseline: 'head_to_index',
      displayPath: 'new-file.ts',
      nativeTargets: [],
    });

    expect(result.success).toBe(false);
  });

  it('accepts branch search results whose targets are opaque Ref IDs', () => {
    const request = branchSearchRequestSchema.safeParse({
      worktreeId: 'worktree_0123456789abcdef0123456789abcdef',
      query: 'feature',
    });
    const response = branchSearchResultSchema.safeParse({
      refsRevision: 3,
      candidates: [
        {
          refId: 'ref_0123456789abcdef0123456789abcdef',
          kind: 'local',
          displayName: 'feature/example',
          occupiedBy: null,
        },
      ],
    });

    expect([request.success, response.success]).toEqual([true, true]);
  });

  it('rejects a Commit Draft above the negotiated size limit', () => {
    const result = commitDraftUpdateSchema.safeParse({
      worktreeId: 'worktree_0123456789abcdef0123456789abcdef',
      expectedRevision: 2,
      update: { kind: 'set', text: 'x'.repeat(65_537) },
    });

    expect(result.success).toBe(false);
  });

  it('measures Commit Draft limits in UTF-8 bytes', () => {
    const result = commitDraftUpdateSchema.safeParse({
      worktreeId: 'worktree_0123456789abcdef0123456789abcdef',
      expectedRevision: 2,
      update: { kind: 'set', text: '€'.repeat(21_846) },
    });

    expect(result.success).toBe(false);
  });

  it('rejects executable names and Git arguments in a command request', () => {
    const result = commandEnvelopeSchema.safeParse({
      clientCommandId: 'command_0123456789abcdef0123456789abcdef',
      command: {
        kind: 'stage',
        worktreeId: 'worktree_0123456789abcdef0123456789abcdef',
        fileIds: ['file_0123456789abcdef0123456789abcdef'],
        expectedWorktreeRevision: 4,
        executable: 'git',
        arguments: ['add', '--all'],
      },
    });

    expect(result.success).toBe(false);
  });

  it('requires Pull to carry the observed refs revision', () => {
    const result = commandEnvelopeSchema.safeParse({
      clientCommandId: 'command_0123456789abcdef0123456789abcdef',
      command: {
        kind: 'pull',
        worktreeId: 'worktree_0123456789abcdef0123456789abcdef',
        expectedWorktreeRevision: 4,
      },
    });

    expect(result.success).toBe(false);
  });

  it('accepts an Unknown Outcome that remains recoverable', () => {
    const result = operationResultSchema.safeParse({
      kind: 'unknown_outcome',
      operationId: 'operation_0123456789abcdef0123456789abcdef',
      code: 'reconciliation_incomplete',
      message: 'The current Repository state cannot prove the outcome.',
      recoveryAvailable: true,
    });

    expect(result.success).toBe(true);
  });

  it('accepts typed Commit evidence for a Succeeded outcome', () => {
    const result = operationResultSchema.safeParse({
      kind: 'succeeded',
      operationId: 'operation_0123456789abcdef0123456789abcdef',
      result: {
        kind: 'commit',
        shortObjectId: '0123456789ab',
        summary: 'Commit created',
      },
    });

    expect(result.success).toBe(true);
  });

  it('requires a typed failure code for failed Partial Success effects', () => {
    const result = operationResultSchema.safeParse({
      kind: 'partial_success',
      operationId: 'operation_0123456789abcdef0123456789abcdef',
      message: 'Some Remotes were fetched.',
      effects: [
        { kind: 'succeeded', label: 'origin' },
        {
          kind: 'failed_known',
          label: 'backup',
          code: 'offline',
          message: 'The Remote is offline.',
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('rejects Partial Success without both success and failure effects', () => {
    const result = operationResultSchema.safeParse({
      kind: 'partial_success',
      operationId: 'operation_0123456789abcdef0123456789abcdef',
      message: 'Everything succeeded.',
      effects: [
        { kind: 'succeeded', label: 'origin' },
        { kind: 'succeeded', label: 'backup' },
      ],
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ['rejected', 'missing_identity'],
    ['rejected', 'index_locked'],
    ['failed_known', 'signing_failed'],
  ] as const)('accepts distinct %s outcome code %s', (kind, code) => {
    const result = operationResultSchema.safeParse({
      kind,
      operationId: 'operation_0123456789abcdef0123456789abcdef',
      code,
      message: 'The Commit could not proceed.',
    });

    expect(result.success).toBe(true);
  });

  it('rejects an arbitrary URL as a native action', () => {
    const result = nativeActionRequestSchema.safeParse({
      kind: 'open_url',
      targetId: 'native_0123456789abcdef0123456789abcdef',
      url: 'https://example.com/steal-token',
    });

    expect(result.success).toBe(false);
  });

  it('accepts an SSE revision invalidation without authoritative Git state', () => {
    const result = sseInvalidationSchema.safeParse({
      kind: 'repository_revision',
      repositoryId: 'repository_0123456789abcdef0123456789abcdef',
      repositoryRevision: 5,
    });

    expect(result.success).toBe(true);
  });
});

describe('opaque ID authority', () => {
  it('recognizes only IDs issued for the matching target kind', () => {
    const authority = createOpaqueIdAuthority({
      randomBytes: (length) => new Uint8Array(length).fill(0xab),
    });
    const fileId = authority.issue('file');

    expect({
      fileId,
      matchingKind: authority.owns('file', fileId),
      wrongKind: authority.owns('ref', fileId),
    }).toEqual({
      fileId: `file_${'ab'.repeat(16)}`,
      matchingKind: true,
      wrongKind: false,
    });
  });
});

describe('diagnostic redaction', () => {
  it('removes URL userinfo, authorization, tokens, and launch secrets', () => {
    const redact = createDiagnosticRedactor({
      secrets: ['fixture-launch-secret'],
    });

    expect(
      redact(
        [
          'remote=https://alice:fixture-password@example.com/repo.git',
          'Authorization: Bearer fixture-bearer-token',
          'token=fixture-query-token',
          'launch=fixture-launch-secret',
        ].join('\n'),
      ),
    ).toBe(
      [
        'remote=https://[REDACTED]@example.com/repo.git',
        'Authorization: [REDACTED]',
        'token=[REDACTED]',
        'launch=[REDACTED]',
      ].join('\n'),
    );
  });

  it('removes common environment-style secret values', () => {
    expect(
      createDiagnosticRedactor()(
        'NPM_TOKEN=fixture-npm GITHUB_TOKEN=fixture-github AWS_SECRET_ACCESS_KEY=fixture-aws',
      ),
    ).toBe(
      'NPM_TOKEN=[REDACTED] GITHUB_TOKEN=[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED]',
    );
  });
});
