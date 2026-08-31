import { describe, expect, it } from 'vitest';

import {
  MVP_ACCEPTANCE_CRITERIA,
  RELEASE_ENVELOPE_CATEGORIES,
  validateManualCheckIds,
  validateReleaseGate,
} from './release-gate.js';

describe('MVP release gate', () => {
  it('maps exactly AC-01 through AC-24 to maintained evidence', async () => {
    const expectedIds = Array.from(
      { length: 24 },
      (_, index) => `AC-${String(index + 1).padStart(2, '0')}`,
    );

    expect(MVP_ACCEPTANCE_CRITERIA.map((criterion) => criterion.id)).toEqual(
      expectedIds,
    );
    await expect(validateReleaseGate(process.cwd())).resolves.toEqual([]);
  });

  it('covers every performance, accessibility, compatibility, and security gate', () => {
    const releaseEnvelope = MVP_ACCEPTANCE_CRITERIA.find(
      (criterion) => criterion.id === 'AC-24',
    );

    for (const category of RELEASE_ENVELOPE_CATEGORIES) {
      expect(
        releaseEnvelope?.evidence.some(
          (evidence) =>
            evidence.kind === 'automated' &&
            evidence.categories?.includes(category) === true,
        ),
      ).toBe(true);
    }
  });

  it('rejects a manual check ID reused by another acceptance row', () => {
    const manual = {
      checkId: 'shared-smoke',
      file: 'docs/release/mvp-release-gate.md',
      kind: 'manual' as const,
      marker: 'VoiceOver and keyboard smoke record',
      reason: 'Requires a human check.',
    };

    expect(
      validateManualCheckIds([
        { evidence: [manual], id: 'AC-23' },
        { evidence: [manual], id: 'AC-24' },
      ]),
    ).toEqual(['AC-24 reuses manual check ID shared-smoke.']);
  });
});
