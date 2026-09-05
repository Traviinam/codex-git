# MVP release gate

Issue #16 is enforced by one source-mode gate:

```sh
npm run release:gate
```

The command runs the complete Vitest suite, validates the AC-01 through AC-24
traceability matrix, builds the supported-scale Git fixture, enforces every
timing budget, records the reference environment, and writes only sanitized
evidence to `artifacts/release-gate/`:

- `acceptance-matrix.json` is the machine-readable gate result.
- `acceptance-matrix.md` is the human-readable release checklist.
- `manual/` contains redacted copies of every passing human checklist.

Raw Vitest JSON is created in a temporary directory and removed after the
sanitized report is written. Failure messages are deliberately excluded from
the archived evidence so credential and redaction fixtures cannot leak into CI
artifacts.

Required human checks are read from `docs/release/manual-evidence.json`. A
missing or `pending` check fails its acceptance criterion and the overall gate;
the presence of a procedure alone is not passing evidence. Passed checks must
have a unique ID, an existing Repository-relative record, a future validity
date, and the current product-source SHA-256 revision. A change to production
files under `apps/` or `packages/` invalidates the record automatically. Set
`CODEX_GIT_MANUAL_EVIDENCE` to use a run-specific record outside the source
tree.

## Supported reference fixture

The benchmark constructs a disposable local Git Repository with:

- 25 Available Worktrees and one unavailable registration;
- 2,000 Changed Files across the available Worktrees;
- 2,500 Local and 2,500 Remote-tracking refs.

The gate fails when the fixture cardinality changes or when any measurement
exceeds its budget:

| Measurement                               |   Budget |
| ----------------------------------------- | -------: |
| Application shell                         | 1,000 ms |
| Selected ordinary Worktree                | 2,000 ms |
| Full supported Repository snapshot        | 5,000 ms |
| Visible external selected-Worktree change | 2,000 ms |
| Loaded UI interaction                     |   100 ms |

The macOS benchmark takes the median of three independent disposable fixtures.
Each sample starts the production Vite surface and loopback protocol, waits for
Vite to finish preparing the served entry, then drives the real protocol source,
Repository Store, React DOM, and SSE invalidation path. The preparation step is
outside the product timing so dependency optimization cannot contend with the
Node/JSDOM measurement. Shell timing includes the first DOM commit.
Selected-Worktree timing ends when the authoritative snapshot is visible.
External-change timing starts before the filesystem write and ends only after
SSE-triggered refresh makes the new Changed File visible in the DOM.

The approved CI reference profile is `github-actions-macos-15`, paired with the
tested Codex compatibility profile `26.901.41600 (build 7982)`. The JSON and
Markdown artifacts record the actual CPU, architecture, memory, macOS, Git,
Node.js, reference profile, and Codex compatibility version. A local release
run must explicitly set `CODEX_GIT_REFERENCE_PROFILE=local-macos-release` and
`CODEX_DESKTOP_VERSION='26.901.41600 (build 7982)'`; an unapproved platform,
profile, or missing/mismatched Codex version fails AC-24.

## VoiceOver and keyboard smoke record

Automated UI coverage verifies native keyboard controls, target-specific names,
live regions, focus recovery, visible `:focus-visible` styling, and textual
status that does not depend on color. Before a release candidate is approved, a
human must also run this macOS assistive-technology check and attach the completed
record beside the generated matrix:

- Record the macOS, VoiceOver, browser/WebView, and Codex Desktop versions.
- Complete Refresh, review, Stage/Unstage, Commit, Branch switch, Fetch, Pull,
  Push, Publish, and exact-target navigation without a pointer.
- Confirm that focus is always visible and follows removal or invalidation to the
  nearest safe context.
- Confirm that status and operation changes are announced without moving focus.
- Confirm that repeated controls announce the exact Worktree, file, Branch, or
  Remote target.
- Confirm that Clean, changed, conflicted, unavailable, stale, and transitioning
  state remains understandable without color.

The completed record must include its execution time, expiry, environment,
current product-source revision, and the exact checklist path. Commit the
durable source record under `docs/release/evidence/`; the gate copies a redacted
version into `artifacts/release-gate/manual/`.

Codex host attachment and native UI restoration use the separately maintained
[exact-build smoke matrix](../host-integration/codex-compatibility.md#manual-smoke-matrix).

## Package parity

Issue #17 must run this same gate against the signed/notarized package. Packaging
must not substitute a second behavior suite or waive a source-mode acceptance
criterion.
