import { describe, expect, it } from 'vitest';

import { parseManualEvidence } from './manual-evidence.js';

describe('manual release evidence', () => {
  it('accepts a complete passed check and an explicit pending check', () => {
    expect(
      parseManualEvidence({
        checks: [
          {
            codexVersion: '26.820.60940 (build 7119)',
            environment: 'Codex Desktop 26.820.60940 (build 7119)',
            id: 'codex-host-smoke',
            performedAt: '2026-08-29T00:00:00.000Z',
            record:
              'docs/host-integration/codex-compatibility.md#manual-smoke-matrix',
            sourceRevision: 'sha256:fixture',
            status: 'passed',
            validUntil: '2026-09-29T00:00:00.000Z',
          },
          {
            codexVersion: null,
            environment: null,
            id: 'voiceover-keyboard-smoke',
            performedAt: null,
            record: null,
            sourceRevision: null,
            status: 'pending',
            validUntil: null,
          },
        ],
        schemaVersion: 1,
      }),
    ).toMatchObject({ schemaVersion: 1 });
  });

  it('rejects a passed check without its environment and record', () => {
    expect(() =>
      parseManualEvidence({
        checks: [
          {
            codexVersion: null,
            environment: null,
            id: 'voiceover-keyboard-smoke',
            performedAt: null,
            record: null,
            sourceRevision: null,
            status: 'passed',
            validUntil: null,
          },
        ],
        schemaVersion: 1,
      }),
    ).toThrow(
      'requires codexVersion, environment, performedAt, record, sourceRevision',
    );
  });

  it('rejects duplicate check IDs', () => {
    expect(() =>
      parseManualEvidence({
        checks: [
          {
            codexVersion: null,
            environment: null,
            id: 'voiceover-keyboard-smoke',
            performedAt: null,
            record: null,
            sourceRevision: null,
            status: 'pending',
            validUntil: null,
          },
          {
            codexVersion: null,
            environment: null,
            id: 'voiceover-keyboard-smoke',
            performedAt: null,
            record: null,
            sourceRevision: null,
            status: 'pending',
            validUntil: null,
          },
        ],
        schemaVersion: 1,
      }),
    ).toThrow('is duplicated');
  });
});
