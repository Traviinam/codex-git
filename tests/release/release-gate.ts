import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

export const RELEASE_ENVELOPE_CATEGORIES = [
  'performance',
  'accessibility',
  'compatibility',
  'security',
] as const;

type ReleaseEnvelopeCategory = (typeof RELEASE_ENVELOPE_CATEGORIES)[number];

export interface AutomatedEvidence {
  readonly categories?: readonly ReleaseEnvelopeCategory[];
  readonly kind: 'automated';
  readonly file: string;
  readonly test: string;
}

export interface ManualEvidence {
  readonly categories?: readonly ReleaseEnvelopeCategory[];
  readonly checkId: string;
  readonly kind: 'manual';
  readonly file: string;
  readonly marker: string;
  readonly reason: string;
}

export type AcceptanceEvidence = AutomatedEvidence | ManualEvidence;

export interface AcceptanceCriterion {
  readonly id: `AC-${string}`;
  readonly title: string;
  readonly evidence: readonly AcceptanceEvidence[];
  readonly categories?: readonly ReleaseEnvelopeCategory[];
}

const automated = (
  file: string,
  test: string,
  categories?: readonly ReleaseEnvelopeCategory[],
): AutomatedEvidence => ({
  categories,
  kind: 'automated',
  file,
  test,
});

const manual = (
  checkId: string,
  file: string,
  marker: string,
  reason: string,
  categories?: readonly ReleaseEnvelopeCategory[],
): ManualEvidence => ({
  categories,
  checkId,
  kind: 'manual',
  file,
  marker,
  reason,
});

export const MVP_ACCEPTANCE_CRITERIA: readonly AcceptanceCriterion[] = [
  {
    id: 'AC-01',
    title: 'Resolve the Current Project',
    evidence: [
      automated(
        'tests/integration/repository-discovery.integration.test.ts',
        'returns a safe non-repository result for an ordinary directory',
      ),
      automated(
        'tests/integration/repository-discovery.integration.test.ts',
        'resolves anchors in Main and Linked Worktrees to one canonical Repository',
      ),
    ],
  },
  {
    id: 'AC-02',
    title: 'Present the Repository and stable Worktree navigator',
    evidence: [
      automated(
        'apps/ui/src/RepositoryOverview.test.tsx',
        'keeps Main first and the remaining Worktrees stable when status changes',
      ),
      automated(
        'apps/ui/src/RepositoryOverview.interactions.test.tsx',
        'searches all documented Worktree fields and keeps Commit Drafts independent',
      ),
    ],
  },
  {
    id: 'AC-03',
    title: 'Include every registered Worktree exactly once',
    evidence: [
      automated(
        'tests/integration/repository-discovery.integration.test.ts',
        'discovers every registered Worktree without path or Branch conventions',
      ),
      automated(
        'tests/integration/worktree-provenance.integration.test.ts',
        'keeps every Git Worktree Unclassified when metadata is unavailable',
      ),
    ],
  },
  {
    id: 'AC-04',
    title: 'Degrade unavailable registrations safely',
    evidence: [
      automated(
        'tests/integration/repository-discovery.integration.test.ts',
        'marks a registered Worktree unavailable when its Git file is broken',
      ),
      automated(
        'tests/integration/repository-discovery.integration.test.ts',
        'does not revive an unavailable identity after prune and same-path recreation',
      ),
    ],
  },
  {
    id: 'AC-05',
    title: 'Classify changes truthfully',
    evidence: [
      automated(
        'tests/integration/repository-observation.integration.test.ts',
        'publishes independent Changed Files for every observed Diff Baseline',
      ),
      automated(
        'tests/integration/repository-observation.integration.test.ts',
        'preserves rename origins and keeps staged deletions reviewable',
      ),
    ],
  },
  {
    id: 'AC-06',
    title: 'Review every supported diff kind safely',
    evidence: [
      automated(
        'tests/integration/repository-observation.integration.test.ts',
        'reads staged, unstaged, and Untracked diffs through opaque File IDs',
      ),
      automated(
        'tests/integration/repository-observation.integration.test.ts',
        'degrades binary, undecodable, oversized, and excessively long Diffs to metadata',
      ),
    ],
  },
  {
    id: 'AC-07',
    title: 'Stage and Unstage only the selected target',
    evidence: [
      automated(
        'tests/integration/repository-stage-unstage.integration.test.ts',
        'stages a Changed File in only the selected Worktree Index',
      ),
      automated(
        'tests/integration/repository-stage-unstage.integration.test.ts',
        'passes unusual paths literally through group Stage',
      ),
    ],
  },
  {
    id: 'AC-08',
    title: 'Reject stale Index and file evidence',
    evidence: [
      automated(
        'tests/integration/repository-stage-unstage.integration.test.ts',
        'rejects stale file evidence and returns current Worktree state',
      ),
      automated(
        'tests/integration/repository-stage-unstage.integration.test.ts',
        'reports per-path Partial Success without rollback claims',
      ),
    ],
  },
  {
    id: 'AC-09',
    title: 'Commit staged content in Local, Initial, and detached states',
    evidence: [
      automated(
        'tests/integration/repository-commit.integration.test.ts',
        'commits exactly staged content, preserves unstaged bytes, and clears only the successful Worktree draft',
      ),
      automated(
        'tests/integration/repository-commit.integration.test.ts',
        'requires explicit confirmation before committing on Detached HEAD',
      ),
    ],
  },
  {
    id: 'AC-10',
    title: 'Recover Commit outcomes without losing the draft',
    evidence: [
      automated(
        'tests/integration/repository-commit.integration.test.ts',
        'reports a timed-out Commit as Unknown Outcome and blocks a duplicate retry',
      ),
      automated(
        'tests/integration/repository-commit.integration.test.ts',
        'classifies configured signing failure without exposing raw diagnostics',
      ),
    ],
  },
  {
    id: 'AC-11',
    title: 'Switch only a Clean Worktree',
    evidence: [
      automated(
        'tests/integration/branch-switching.integration.test.ts',
        'switches a clean Worktree to an unoccupied Local Branch',
      ),
      automated(
        'tests/integration/branch-switching.integration.test.ts',
        'blocks a dirty Worktree without carrying or discarding changes',
      ),
    ],
  },
  {
    id: 'AC-12',
    title: 'Enforce Branch Occupancy Repository-wide',
    evidence: [
      automated(
        'tests/integration/branch-switching.integration.test.ts',
        'discovers cached Local Branches with Repository-wide occupancy',
      ),
      automated(
        'tests/integration/branch-switching.integration.test.ts',
        'rejects stale Branch Occupancy after an external Worktree claims the target',
      ),
    ],
  },
  {
    id: 'AC-13',
    title: 'Limit Remote-tracking Branch selection',
    evidence: [
      automated(
        'tests/integration/branch-switching.integration.test.ts',
        'creates only the same-name Local tracking Branch for a cached Remote-tracking target',
      ),
    ],
  },
  {
    id: 'AC-14',
    title: 'Fetch without changing Worktree content',
    evidence: [
      automated(
        'tests/integration/repository-fetch.integration.test.ts',
        'fetches one opaque Remote without changing the Working Tree or Index',
      ),
      automated(
        'tests/integration/repository-fetch.integration.test.ts',
        'Fetch all preserves successful updates and attributes every Remote result',
      ),
    ],
  },
  {
    id: 'AC-15',
    title: 'Pull only by fast-forward',
    evidence: [
      automated(
        'tests/integration/repository-sync.integration.test.ts',
        'Pull fast-forwards a clean behind Local Branch from its exact Upstream',
      ),
      automated(
        'tests/integration/repository-sync.integration.test.ts',
        'Pull blocks divergence without changing files or refs',
      ),
    ],
  },
  {
    id: 'AC-16',
    title: 'Push only committed history to the exact Upstream',
    evidence: [
      automated(
        'tests/integration/repository-sync.integration.test.ts',
        'Push transfers committed history and leaves uncommitted content local',
      ),
      automated(
        'packages/repository-engine/src/remote-operation.test.ts',
        'Push uses one exact full-ref refspec without force, tags, deletion, or matching refs',
      ),
    ],
  },
  {
    id: 'AC-17',
    title: 'Publish an Unpublished Branch explicitly',
    evidence: [
      automated(
        'tests/integration/repository-sync.integration.test.ts',
        'Publish creates only the same-name Branch in the Remote and configures Upstream after success',
      ),
      automated(
        'apps/ui/src/RepositoryOverview.interactions.test.tsx',
        'confirms the exact Remote and same-name target before Publish',
      ),
    ],
  },
  {
    id: 'AC-18',
    title: 'Distinguish Remote and credential failures',
    evidence: [
      automated(
        'tests/integration/repository-fetch.integration.test.ts',
        'classifies an unreachable credentialed URL without exposing secrets',
      ),
      automated(
        'tests/integration/repository-sync.integration.test.ts',
        'Push reports a protected-Branch policy rejection without retrying',
      ),
    ],
  },
  {
    id: 'AC-19',
    title: 'Coordinate independent Worktree local mutations',
    evidence: [
      automated(
        'tests/integration/repository-commit.integration.test.ts',
        'runs Commits concurrently in different Worktrees without crossing HEAD or Index',
      ),
      automated(
        'packages/repository-engine/src/operation-coordinator.test.ts',
        'derives Local lanes and returns reconciled Busy without queueing',
      ),
    ],
  },
  {
    id: 'AC-20',
    title: 'Coordinate Repository-wide Branch and Remote operations',
    evidence: [
      automated(
        'packages/repository-engine/src/operation-coordinator.test.ts',
        'derives Repository lanes and mandatory cross-lane claims',
      ),
      automated(
        'packages/repository-engine/src/operation-coordinator.test.ts',
        'makes a Remote-tracking Branch conflict with Fetch for its exact Remote',
      ),
    ],
  },
  {
    id: 'AC-21',
    title: 'Reconcile every attempted mutation',
    evidence: [
      automated(
        'packages/repository-engine/src/operation-coordinator.test.ts',
        'derives the terminal result from reconciliation rather than process state',
      ),
      automated(
        'packages/repository-engine/src/operation-lifecycle.test.ts',
        'drains only active, reconciling, and Unknown records during close',
      ),
    ],
  },
  {
    id: 'AC-22',
    title: 'Reject stale topology, identity, and navigation targets',
    evidence: [
      automated(
        'tests/integration/repository-discovery.integration.test.ts',
        'keeps continuous identities and invalidates removed or moved generations',
      ),
      automated(
        'tests/integration/repository-stage-unstage.integration.test.ts',
        'rejects a removed and recreated Worktree generation before mutation',
      ),
    ],
  },
  {
    id: 'AC-23',
    title: 'Navigate to exact targets and preserve provenance optionality',
    evidence: [
      automated(
        'tests/e2e/protocol-runtime.e2e.test.ts',
        'targets the new path for renames and rejects a file that disappears before launch',
      ),
      automated(
        'tests/integration/worktree-provenance.integration.test.ts',
        'does not invalidate Git file targets when optional metadata disappears',
      ),
    ],
  },
  {
    id: 'AC-24',
    title: 'Pass the supported release envelope',
    categories: RELEASE_ENVELOPE_CATEGORIES,
    evidence: [
      automated(
        'tests/release/supported-scale.test.ts',
        'contains 25 Available Worktrees, 2,000 Changed Files, 5,000 refs, and unavailable diagnostics',
        ['performance'],
      ),
      automated(
        'tests/release/supported-scale.test.ts',
        'keeps loaded UI interactions within 100 milliseconds',
        ['performance'],
      ),
      automated(
        'tests/release/oversized-diff.release.test.tsx',
        'degrades a 2 MiB and 20,001-line Diff without freezing the loaded UI',
        ['performance'],
      ),
      automated(
        'apps/ui/src/RepositoryOverview.test.tsx',
        'keeps Main first and the remaining Worktrees stable when status changes',
        ['accessibility'],
      ),
      automated(
        'apps/ui/src/RepositoryOverview.interactions.test.tsx',
        'moves through the stable Worktree navigator with arrow keys',
        ['accessibility'],
      ),
      automated(
        'apps/ui/src/RepositoryOverview.interactions.test.tsx',
        'recovers focus to detail when Worktree removal collapses the navigator',
        ['accessibility'],
      ),
      automated(
        'apps/ui/src/RepositoryOverview.interactions.test.tsx',
        'preserves selection on harmless refresh and recovers focus when that generation disappears',
        ['accessibility'],
      ),
      automated(
        'apps/ui/src/RepositoryOverview.interactions.test.tsx',
        'announces a Branch change without stealing focus from the Commit Draft',
        ['accessibility'],
      ),
      automated(
        'tests/release/accessibility.release.test.tsx',
        'keeps controls keyboard operable, target named, visibly focused, announced, and non-color-only',
        ['accessibility'],
      ),
      automated(
        'tests/contract/standalone-host-adapter.contract.test.ts',
        'publishes the standalone Host Context after attaching a surface',
        ['compatibility'],
      ),
      automated(
        'tests/e2e/standalone-runtime.e2e.test.ts',
        'serves the health endpoint and placeholder Git Surface',
        ['compatibility'],
      ),
      automated(
        'tests/e2e/host-product-parity.e2e.test.ts',
        'exposes the same Repository snapshot and Diff behavior through standalone and Codex hosts',
        ['compatibility'],
      ),
      automated(
        'packages/host-adapter/codex-cdp/src/adapter.test.ts',
        'fails closed without changing an incompatible renderer',
        ['compatibility'],
      ),
      automated(
        'packages/host-adapter/codex-cdp/src/adapter.test.ts',
        'mounts one opaque Git surface and restores native navigation',
        ['compatibility'],
      ),
      automated(
        'packages/host-adapter/codex-cdp/src/adapter.test.ts',
        'accepts actions only from the current frame capability and challenge',
        ['compatibility', 'security'],
      ),
      automated(
        'packages/host-adapter/codex-cdp/src/dedicated-adapter.test.ts',
        'publishes one standalone transition when replacement cannot reacquire CSP',
        ['compatibility'],
      ),
      automated(
        'tests/e2e/codex-runtime.e2e.test.ts',
        'closes the dedicated instance and remains standalone when ownership fails',
        ['compatibility'],
      ),
      automated(
        'apps/server/src/loopback-server.test.ts',
        'binds an ephemeral loopback listener behind a 256-bit token path',
        ['security'],
      ),
      automated(
        'apps/server/src/loopback-server.test.ts',
        'validates token and version before evaluating the browser Origin',
        ['security'],
      ),
      automated(
        'apps/server/src/protocol-dispatch.test.ts',
        'rejects a fabricated native target that was not issued by the snapshot',
        ['security'],
      ),
      automated(
        'tests/integration/repository-stage-unstage.integration.test.ts',
        'passes unusual paths literally through group Stage',
        ['security'],
      ),
      automated(
        'packages/repository-engine/src/remote-operation.test.ts',
        'Push uses one exact full-ref refspec without force, tags, deletion, or matching refs',
        ['security'],
      ),
      automated(
        'packages/repository-engine/src/git-environment.test.ts',
        'removes inherited Git authority while preserving ordinary process context',
        ['security'],
      ),
      automated(
        'tests/contract/protocol.contract.test.ts',
        'removes URL userinfo, authorization, tokens, and launch secrets',
        ['security'],
      ),
      automated(
        'tests/release/release-artifacts.test.ts',
        'writes the sanitized JSON matrix and human-readable checklist',
        ['security'],
      ),
      automated(
        'packages/repository-engine/src/operation-coordinator.test.ts',
        'derives Local lanes and returns reconciled Busy without queueing',
      ),
      automated(
        'tests/integration/repository-commit.integration.test.ts',
        'rejects stale Index evidence and an unresolved external Index lock before Commit',
      ),
      automated(
        'tests/integration/repository-commit.integration.test.ts',
        'owns the native Index lock transaction and rejects post-launch external staging',
      ),
      automated(
        'tests/integration/repository-commit.integration.test.ts',
        'lets native Git expected-old ref CAS reject a post-launch HEAD mutation',
      ),
      automated(
        'tests/e2e/protocol-runtime.e2e.test.ts',
        'targets the new path for renames and rejects a file that disappears before launch',
      ),
      automated(
        'tests/integration/repository-discovery.integration.test.ts',
        'does not revive an unavailable identity after prune and same-path recreation',
      ),
      automated(
        'tests/integration/repository-commit.integration.test.ts',
        'reports a timed-out Commit as Unknown Outcome and blocks a duplicate retry',
      ),
      manual(
        'codex-host-smoke',
        'docs/host-integration/codex-compatibility.md',
        'Manual smoke matrix',
        'Codex Desktop attachment and native UI restoration require the named macOS host build.',
        ['compatibility'],
      ),
      manual(
        'voiceover-keyboard-smoke',
        'docs/release/mvp-release-gate.md',
        'VoiceOver and keyboard smoke record',
        'Assistive-technology announcements and navigation require a human macOS check.',
        ['accessibility'],
      ),
    ],
  },
] as const;

export async function validateReleaseGate(root: string): Promise<string[]> {
  const issues = validateManualCheckIds(MVP_ACCEPTANCE_CRITERIA);
  const seenEvidence = new Set<string>();
  const expectedRoot = resolve(root);

  for (const criterion of MVP_ACCEPTANCE_CRITERIA) {
    if (criterion.evidence.length === 0) {
      issues.push(`${criterion.id} has no evidence.`);
      continue;
    }
    if (!criterion.evidence.some((evidence) => evidence.kind === 'automated')) {
      issues.push(`${criterion.id} has no automated evidence.`);
    }
    for (const category of criterion.categories ?? []) {
      if (
        !criterion.evidence.some(
          (evidence) =>
            evidence.kind === 'automated' &&
            evidence.categories?.includes(category) === true,
        )
      ) {
        issues.push(`${criterion.id} has no automated ${category} evidence.`);
      }
    }

    for (const evidence of criterion.evidence) {
      const evidenceKey =
        evidence.kind === 'automated'
          ? `${evidence.file}::${evidence.test}`
          : `${evidence.file}::${evidence.marker}`;
      if (seenEvidence.has(`${criterion.id}::${evidenceKey}`)) {
        issues.push(`${criterion.id} repeats evidence ${evidenceKey}.`);
      }
      seenEvidence.add(`${criterion.id}::${evidenceKey}`);

      const path = resolve(expectedRoot, evidence.file);
      if (
        isAbsolute(evidence.file) ||
        (path !== expectedRoot && !path.startsWith(`${expectedRoot}${sep}`))
      ) {
        issues.push(
          `${criterion.id} references an unsafe path: ${evidence.file}.`,
        );
        continue;
      }

      let source: string;
      try {
        source = await readFile(path, 'utf8');
      } catch {
        issues.push(
          `${criterion.id} evidence file is missing: ${evidence.file}.`,
        );
        continue;
      }

      const marker =
        evidence.kind === 'automated' ? evidence.test : evidence.marker;
      if (!source.includes(marker)) {
        issues.push(
          `${criterion.id} evidence marker is missing from ${evidence.file}: ${marker}.`,
        );
      }
      if (evidence.kind === 'manual' && evidence.reason.trim().length === 0) {
        issues.push(`${criterion.id} manual evidence requires a reason.`);
      }
    }
  }

  return issues;
}

export function validateManualCheckIds(
  criteria: readonly Pick<AcceptanceCriterion, 'evidence' | 'id'>[],
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const criterion of criteria) {
    for (const evidence of criterion.evidence) {
      if (evidence.kind !== 'manual') continue;
      if (seen.has(evidence.checkId)) {
        issues.push(
          `${criterion.id} reuses manual check ID ${evidence.checkId}.`,
        );
      }
      seen.add(evidence.checkId);
    }
  }
  return issues;
}
