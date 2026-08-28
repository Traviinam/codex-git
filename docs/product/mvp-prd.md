# Codex Git macOS MVP product requirements

## Status and authority

This document defines the release-blocking macOS MVP tracked by
[issue #1](https://github.com/codeacme17/codex-git/issues/1). The canonical
domain terms are defined in [`CONTEXT.md`](../../CONTEXT.md). The
[technical architecture](../architecture/mvp-technical-architecture.md) defines
how the product preserves these requirements; it does not add product behavior.

Every requirement in this document applies equally to a Repository with one
Worktree and to a Repository containing manual, Permanent, Codex-managed,
Scheduled, detached, custom-root, or Unclassified Worktrees.

## Product objective

Deliver a top-level `Git` page for the Current Project that shows the Repository
and every registered Worktree, then supports the ordinary review, Stage, Commit,
Branch switch, Fetch, fast-forward Pull, normal Push, and Publish Branch loop.

The product must make the selected Worktree and exact Git target obvious, remain
truthful while external Git processes and Codex tasks change the Repository, and
refuse mutations when fresh evidence cannot prove that the requested target and
preconditions still hold.

## Product principles

1. **All registered Worktrees are first-class.** Provenance, location, Branch
   naming, and creator never filter the Git inventory or capabilities.
2. **The selected Worktree is the unit of local work.** Its Working Tree, Index,
   HEAD, Commit Draft, Changed Files, and local mutations are never blended with
   another Worktree.
3. **Observed state is not authority.** Displayed state may become stale; every
   mutation requires fresh server-side target and precondition checks.
4. **Outcomes describe evidence.** The product reports what reconciliation can
   prove, including Partial Success and Unknown Outcome, without implying rollback
   or success.
5. **Ordinary Git stays ordinary.** Existing Git hooks, signing, credentials,
   configuration, locks, and safety rules remain in force.
6. **Host integration is optional.** Codex-hosted and standalone surfaces expose
   the same Git behavior; loss of unsupported host compatibility cannot remove the
   standalone path.

## Users

### Single-Worktree developer

A developer using the Main Worktree expects the page to open directly into useful
Repository and Worktree state without configuring a multi-Worktree workflow.

### Multi-Worktree developer

A developer coordinating multiple Worktrees expects each registered Worktree to
appear exactly once, keep an independent Index and Commit Draft, and identify
Branch Occupancy and mutation targets unambiguously.

### Codex task coordinator

A developer may benefit from a proven association between a Worktree and a Codex
task, but missing or conflicting Codex metadata must not hide or disable Git
behavior.

## MVP scope

- One top-level Codex sidebar `Git` entry when the supported host adapter is
  compatible.
- One standalone surface with the same Git product behavior.
- One adaptive, full-page Repository/Worktree master-detail experience.
- The Current Project's local macOS Repository only.
- The Main Worktree and every valid Worktree registered with that Repository.
- Optional provenance labels only when stable Codex-owned metadata proves them.
- Repository and Worktree summaries, truthful Change Groups, and on-demand file
  diffs.
- File-level and selected-group Stage and Unstage.
- Worktree-scoped Commit Drafts and Commit.
- Switching to existing Local Branches and the narrow same-name local tracking
  Branch case for a cached Remote-tracking Branch.
- Explicit Fetch, fast-forward-only Pull, normal Push, and Publish Branch.
- Automatic and manual local Refresh, stale-state rejection, operation lanes,
  typed outcomes, post-operation reconciliation, and safe supporting navigation.
- A release fixture with 25 active Worktrees, 2,000 Changed Files, and 5,000 Local
  and Remote-tracking references.

## Non-goals

- Windows, Linux, remote Git execution environments, or multiple simultaneous
  Current Projects.
- Worktree or general Branch create, delete, rename, move, repair, or prune
  workflows.
- Hunk or line staging; discard; stash; reset; clean; merge; rebase; cherry-pick;
  conflict resolution; graph; blame; history; or generalized undo.
- Force push, tags, Remote Branch deletion, arbitrary refspecs, pull requests,
  checks, GitHub APIs, or provider-specific repository features.
- Credential setup, submodule workflows, or Git LFS management.
- Modifying the Codex task list, Codex application files, or undocumented private
  Codex application state.
- Guaranteed syntax highlighting, a merge editor, auto-update, telemetry, cloud
  accounts, or a remote backend.

## Information architecture

### Repository header

The header shows the Repository name and path, active and unavailable Worktree
counts, local Refresh freshness, Fetch freshness, active operation status, a
manual Refresh action, and explicit Fetch entry points.

Local Refresh and Fetch are visually and semantically distinct. Refresh never
contacts a Remote. Ahead/behind information is labeled as cached and tied to the
latest successful Fetch.

### Worktree navigator

The navigator is stably ordered with the Main Worktree first. Each row identifies
the Worktree by a disambiguated name/path, Local Branch or Detached HEAD Commit,
Clean/change/conflict counts, cached ahead/behind or Unpublished state, and any
unavailable or transitioning status.

Search matches Worktree name, path, Branch, and proven associated Codex title.
Status changes do not reorder rows. With one Worktree, the navigator collapses
automatically without hiding Repository or Worktree actions.

### Worktree detail

The selected Worktree detail shows its exact identity and path, Local Branch or
Detached HEAD, Upstream and freshness, applicable Git and navigation actions, its
Commit Draft, ordered Change Groups, and the selected file diff.

Selection survives a harmless Refresh while its opaque identity remains valid.
Worktree generation or Branch changes clear stale file and diff selections.

### Change Groups and diff

Non-empty groups appear in this order:

1. Conflicts
2. Staged Changes
3. Changes
4. Untracked

A path with both staged and unstaged content appears in two groups because it has
two independent Diff Baselines. Diff review defaults to side-by-side, offers a
Unified toggle, and supports Previous/Next navigation with an `N of M` position
within the current Worktree group and filter.

Binary, undecodable, oversized, or excessively long content receives truthful
metadata and safe open actions rather than a fake text diff. The degradation
threshold is more than 2 MiB or more than 20,000 lines.

## Functional requirements

### FR1 — Repository and Worktree discovery

- Resolve the Current Project to one canonical Repository or a safe
  non-repository result.
- Treat Git's registered Worktree inventory as authoritative.
- Include the Main Worktree and every valid Linked Worktree exactly once,
  independent of location, Branch name, creator, provenance, or Detached HEAD.
- Distinguish an available Worktree, a Git-locked Worktree, and a missing or
  prunable registration without mutating or repairing any of them.
- Treat a removed, restored, recreated, or moved Worktree as a new generation
  when its continuous identity cannot be proven.

### FR2 — Repository and Worktree overview

- Present the adaptive Repository header, stable Worktree navigator, and selected
  Worktree detail defined above.
- Keep every Worktree's status, Index, Commit Draft, operation state, and actions
  independent.
- Communicate Clean, changed, conflicted, unavailable, stale, and transitioning
  state with text or icons as well as color.
- Preserve only selections that remain valid in the latest authoritative
  snapshot.
- Show optional provenance only when stable metadata explicitly proves it;
  otherwise show `Unclassified`.

### FR3 — Change classification and diff review

- Classify Conflict, Staged Change, Change, and Untracked File observations
  without collapsing distinct baselines for the same path.
- Review Staged Changes from HEAD to Index, Changes from Index to Working Tree,
  and Untracked Files from empty content to the file.
- Represent Conflict content truthfully without implying an MVP conflict editor.
- Preserve rename old/new paths and keep deletions reviewable.
- Bind every Changed File observation to one Worktree generation, revision, path,
  and Diff Baseline.
- Disable external diff drivers and text conversion, bound output, and degrade
  safely for binary, undecodable, oversized, or excessively long content.

### FR4 — Stage and Unstage

- Provide file actions, `Stage all` for Changes and Untracked Files, and
  `Unstage all` for Staged Changes.
- Reject Stage for Conflict entries.
- Change only the selected Worktree's Index and never infer a path from client
  text.
- Revalidate file identity, current status, and the expected Diff Baseline before
  execution.
- Make Unstage safe before the Initial Commit and preserve Working Tree bytes.
- Report bulk results per path as Succeeded, Failed Known, or Partial Success;
  never claim transactional rollback.

### FR5 — Commit

- Maintain one multiline Commit Draft per Repository and Worktree for the current
  backend session.
- Preserve a draft across navigation, Refresh, Branch switch, and failed or
  uncertain Commit; clear it only after verified success or an explicit user
  clear action.
- Enable Commit only when staged content exists and show the target Worktree path,
  Branch or Detached HEAD, and staged-file count.
- Support an Initial Commit and require prominent confirmation for a Detached HEAD
  Commit.
- Block ordinary Commit during Conflict, an In-progress Git Operation, missing
  identity, an unresolved Index lock, or an empty Index.
- Preserve configured hooks and signing, pass the Commit message without shell
  interpolation, and reconcile HEAD and Index after every attempt.
- Include exactly the selected Worktree's staged content and leave its unstaged
  content unchanged.

### FR6 — Branch discovery and switching

- Search cached Local Branches separately from cached Remote-tracking Branches;
  exclude tags and Remote symbolic HEAD aliases.
- Show Remote-qualified names and use exact, opaque Branch targets.
- Compute Branch Occupancy across every registered Worktree and identify the
  occupying Worktree.
- Allow switching only when the selected Worktree is Clean, has no Conflict, and
  has no In-progress Git Operation.
- Allow a Clean Detached HEAD to switch, warning before leaving a Commit not
  reachable from another named reference.
- Disable an occupied Local Branch and offer navigation to its Worktree.
- For a Remote-tracking Branch, permit only creation of a same-name Local tracking
  Branch after target, name, collision, Upstream, and occupancy checks all pass.
- Never Fetch implicitly or carry, stash, discard, or overwrite local changes.

### FR7 — Remotes, Fetch, Pull, Push, and Publish

- Discover configured Remotes and show each name with a sanitized host.
- Resolve Local Branch Upstreams and cached ahead/behind or Unpublished state with
  the last successful Fetch time.
- Provide explicit `Fetch <remote>` and `Fetch all`; Fetch all reports each Remote
  independently and preserves successful updates.
- Do not prune by default, modify Working Tree files during Fetch, or contact a
  Remote during local Refresh or Branch search.
- Pull only from the displayed Upstream, only into a Clean Worktree, and only with
  explicit fast-forward-only integration. Ahead is a no-op; divergence is blocked.
- Push only the current Local Branch to its exact configured Upstream. Uncommitted
  content may remain present but is explicitly excluded from the Push.
- Block a known behind or diverged Push and never retry with force.
- Publish only an Unpublished Branch to a confirmed Remote and same-name target;
  set Upstream only after verified success.
- Use existing credential helpers and SSH while distinguishing offline,
  authentication, permission, policy, non-fast-forward, Partial Success, and
  Unknown Outcome results.

### FR8 — Refresh, coordination, and recovery

- Produce coherent versioned Repository and Worktree snapshots and preserve the
  last successful snapshot with explicit stale/error state when Refresh fails.
- Refresh on open, focus, Current Project change, relevant filesystem or Git
  metadata invalidation, manual request, and every operation outcome.
- Observe the selected Worktree first; debounce, bound, and deduplicate reads; use
  staggered non-selected polling and full-discovery fallback polling.
- Discard late results from superseded Refresh generations.
- Permit independent local mutations in different Worktrees while serializing
  each Worktree's local mutations, all Repository Branch switches, and all
  Repository remote operations in their respective lanes.
- Return Busy rather than silently queueing a conflicting mutation.
- Track operation identity, cancellation, duplicate submission, typed outcomes,
  and reconciliation. Disable retry while an outcome remains unknown.
- Never remove external Git locks or contact a Remote as part of local Refresh.

### FR9 — Exact-target navigation and host context

- Provide Worktree actions to Open in Terminal, Reveal in Finder, Copy Absolute
  Path, Copy Branch/SHA, and open an exact Codex task/project where proven and
  available.
- Provide Changed File actions to Open File in Codex, copy its relative or
  absolute path, Reveal in Finder, and Open in Default App.
- Resolve targets from server-issued identity, revalidate existence and generation
  immediately before launch, and allow only named product actions.
- Do not open deleted files; target the new path for a rename; permit external
  opening of a Conflict without implying conflict editing.
- Cancel a missing or moved target with an explanation and safe copy/Refresh
  fallback.
- Treat Codex Current Project, theme, task context, navigation, and mounting as
  adapter capabilities rather than Git correctness dependencies.

## Capability matrix

`Yes` means the capability may be offered after all target-specific fresh
preconditions pass. `No` means the MVP must not offer it in that state.

| Worktree state            | Review             | Stage/Unstage            | Commit                  | Switch Branch | Pull        | Push              | Publish        |
| ------------------------- | ------------------ | ------------------------ | ----------------------- | ------------- | ----------- | ----------------- | -------------- |
| Clean Local Branch        | Yes                | No content               | No staged content       | Yes           | If Upstream | If Upstream       | If Unpublished |
| Changed, no Conflict      | Yes                | Yes                      | If staged               | No            | No          | If exact Upstream | If Unpublished |
| Conflict                  | Yes                | Unstage only where valid | No                      | No            | No          | No                | No             |
| Detached HEAD, Clean      | Yes                | No content               | No staged content       | Yes           | No          | No                | No             |
| Detached HEAD, Changed    | Yes                | Yes                      | If staged and confirmed | No            | No          | No                | No             |
| Initial Repository State  | Yes                | Yes                      | If staged               | No            | No          | No                | No             |
| In-progress Git Operation | Yes where readable | No                       | No                      | No            | No          | No                | No             |
| Unavailable               | Diagnostics only   | No                       | No                      | No            | No          | No                | No             |

Additional rules override the table:

- Stage never accepts a Conflict entry.
- Pull requires a Clean Worktree and a fast-forward result.
- A known behind/diverged Push is blocked even when an exact Upstream exists.
- An occupied Local Branch cannot be selected in another Worktree.
- Any stale, missing, ambiguous, or mismatched target disables mutation.

## Safety contract

### Target integrity

- Client-visible paths, Branch names, Remote names, and displayed snapshots are
  descriptive, not authority.
- Every mutation and native action identifies server-issued opaque targets.
- The local authority resolves the target and validates Worktree generation,
  relevant revisions, Git state, and operation-lane availability immediately
  before execution.
- A Current Project, path, Worktree, Branch, Upstream, or file mismatch produces a
  Rejected outcome and refreshed state.

### Git process safety

- The browser does not execute a shell, construct Git arguments, choose executable
  names, or submit arbitrary paths, refs, refspecs, URLs, or native actions.
- Git paths are passed literally with NUL-delimited input when supported. Commit
  messages use stdin or a file descriptor.
- No MVP command force-pushes, rewrites history, deletes a ref, removes a lock,
  auto-stashes, prunes by default, or bypasses hooks/signing.
- Output, execution time, request bodies, and rendered diff size are bounded.
- Secrets, credential material, URL userinfo, tokens, and authorization data are
  redacted from UI, logs, errors, and diagnostic artifacts.

### Mutation lifecycle

1. Accept a typed intent against opaque targets and observed revisions.
2. Reject malformed, unauthorized, stale, Busy, or command-ID collision requests.
3. Resolve exact Git targets and re-read every relevant precondition.
4. Execute in the narrowest applicable operation lane.
5. On success, failure, cancellation, interruption, or timeout, reconcile the
   affected HEAD, Index, refs, Upstream, status, and topology.
6. Report Succeeded, Rejected, Failed Known, Partial Success, or Unknown Outcome
   from evidence. Never synthesize success from process exit alone.

An idempotent retry repeats the same client command ID and the same validated
intent; it returns the existing receipt or result without invoking another product
operation. Reusing that ID with any different intent, target, revision, or payload
is a command-ID collision and is rejected without execution.

## Error and recovery behavior

- A failed local Refresh keeps the last successful data visible and marked stale;
  it never renders a false Clean or empty state.
- Rejected operations explain the precondition that changed and present refreshed
  state when available.
- Failed Known outcomes preserve unaffected user work and include sanitized,
  actionable diagnostics.
- Partial Success identifies every independently attempted target and its result.
- Unknown Outcome disables blind retry until reconciliation proves the state or
  routes the user to safe manual inspection.
- Disappearing Worktrees and navigation targets fail closed without mutation.
- External locks remain owned by the external process; the product waits, reports,
  or routes to Terminal guidance but never removes them.

## Non-functional requirements

### Performance and capacity

On the documented supported reference machine and release fixture:

- The application shell appears within 1 second.
- The selected ordinary Worktree state appears within 2 seconds.
- A full supported Repository snapshot completes within 5 seconds.
- A visible external change in the selected Worktree appears within 2 seconds.
- Loaded UI interactions respond within 100 milliseconds.
- Twenty-five active Worktrees, 2,000 Changed Files, and 5,000 Local and
  Remote-tracking refs remain usable.
- A binary, undecodable, over-2-MiB, or over-20,000-line file degrades without
  freezing or crashing the page.

Measurements record hardware, macOS, Git, Node.js, and Codex versions.

### Accessibility

- All workflows are keyboard operable with visible focus.
- Accessible names include the exact target when repeated controls would otherwise
  be ambiguous.
- Status changes and operation progress use appropriate live announcements without
  stealing focus.
- State never relies on color alone.
- Harmless Refresh preserves logical focus; removal or invalidation moves focus to
  the nearest safe context and explains the change.
- The supported release gate includes assistive-technology checks on macOS.

### Compatibility and availability

- Standalone and supported Codex-hosted surfaces expose the same Git behavior.
- The Codex compatibility matrix names exact tested builds.
- An incompatible or changed Codex host fails closed and leaves native UI
  unmodified before directing the user to standalone mode.
- Server restart, renderer replacement, Worktree disappearance, network outage,
  and interrupted processes have explicit recovery paths.

### Security and privacy

- The local protocol binds only to loopback on an ephemeral port and requires a
  per-launch secret plus protocol and origin validation.
- The Codex-hosted iframe remains opaque and lacks same-origin, popup, or
  top-navigation authority.
- Only allow-listed native actions against validated opaque targets cross the host
  seam.
- No cloud backend, account, telemetry, or credential collection is part of the
  MVP.
- Installation documents the unsupported CDP/DOM integration and trusted local
  process risk.

## Release-blocking acceptance scenarios

Each scenario must have automated evidence where feasible and an explicit manual
record only where macOS or host behavior requires it.

### AC-01 — Resolve the Current Project

- An ordinary non-repository directory produces a safe non-repository state and
  enables no Git mutation.
- A Current Project inside the Main or a Linked Worktree resolves to the same
  Repository and selects the exact Worktree when it remains registered.
- A one-Worktree Repository opens directly into useful Branch, Upstream, status,
  and action state.

### AC-02 — Present the Repository and stable Worktree navigator

- Repository identity, path, counts, Refresh freshness, Fetch freshness, and
  operation status are visible and distinguish local from Remote state.
- Main is first; remaining Worktrees stay in stable order as status changes.
- Search covers name, path, Branch, and proven Codex title without combining
  Worktree state.

### AC-03 — Include every registered Worktree exactly once

- Main, manual, Codex-style, Scheduled-style, Permanent-style, detached,
  custom-root, and Unclassified registered Worktrees all appear exactly once.
- Path conventions, Branch prefixes, task titles, and missing Codex metadata never
  filter inclusion or Git capabilities.
- Provenance appears only from stable evidence; conflicting evidence is
  `Unclassified`.

### AC-04 — Degrade unavailable registrations safely

- Git-locked, missing, and prunable registrations remain distinguishable.
- An unavailable Worktree exposes diagnostics and safe navigation/copy fallbacks
  but no mutation.
- Discovery never prunes, repairs, unlocks, or deletes a registration.

### AC-05 — Classify changes truthfully

- Non-empty groups appear as Conflicts, Staged Changes, Changes, and Untracked.
- A path with staged and unstaged content appears twice with independent baselines
  and correct content.
- Renames, deletions, unusual path bytes, and Worktree-local identity remain
  accurate.

### AC-06 — Review every supported diff kind safely

- HEAD-to-Index, Index-to-Working-Tree, and empty-to-Untracked diffs show the
  intended content.
- Conflict entries are truthful without implying resolution.
- Binary, undecodable, oversized, and over-20,000-line files return metadata and
  safe actions without fake text or UI failure.
- Previous/Next remains scoped to the selected Worktree, group, and filter.

### AC-07 — Stage and Unstage only the selected target

- File and group operations change only the selected Worktree's Index, even when
  another Worktree has the same relative path.
- Conflict entries cannot be staged.
- Spaces, Unicode, leading dashes, newlines, renames, deletions, and Untracked
  Files are passed literally and handled safely.

### AC-08 — Reject stale Index and file evidence

- External file, status, baseline, or Index changes between review and submission
  reject the stale operation and return current state.
- Unstage is Initial-Commit-safe and leaves Working Tree bytes unchanged.
- Bulk results identify each path and represent mixed outcomes as Partial Success
  without rollback claims.

### AC-09 — Commit staged content in Local, Initial, and detached states

- A Local Branch Commit contains exactly staged content and retains unstaged
  content.
- Initial Commit succeeds when identity and staged content exist.
- Detached HEAD Commit requires prominent confirmation and reports the resulting
  Commit without claiming Branch reachability.

### AC-10 — Recover Commit outcomes without losing the draft

- Missing identity, hook rejection, signing failure, external Index lock, stale
  HEAD/Index, timeout, and ambiguous process exit are distinct.
- Commit Draft survives every non-verified-success outcome.
- Verified success reports the short SHA and summary, clears only that Worktree's
  draft, and refreshes HEAD, Index, and status.
- Unknown Outcome prevents duplicate retry until reconciled.

### AC-11 — Switch only a Clean Worktree

- Existing Local Branch and Clean Detached HEAD switches succeed when unoccupied.
- Changed, conflicted, and In-progress Worktrees are blocked without stash,
  discard, carry, or force behavior.
- Leaving an unreachable Detached HEAD Commit requires a warning.

### AC-12 — Enforce Branch Occupancy Repository-wide

- A Local Branch checked out in another registered Worktree is disabled and names
  that exact Worktree.
- Navigation reaches the occupying Worktree.
- Simultaneous switches cannot race occupancy and conflicting requests are Busy,
  not queued.

### AC-13 — Limit Remote-tracking Branch selection

- Local and Remote-tracking results remain separate and Remote-qualified; tags and
  symbolic Remote HEAD aliases do not appear.
- Selecting a Remote-tracking Branch creates only the same-name Local tracking
  Branch after collision, Upstream, target, and occupancy checks pass.
- Branch discovery never Fetches or rewrites an existing Local Branch or Upstream.

### AC-14 — Fetch without changing Worktree content

- Fetch updates objects and Remote-tracking refs without changing any Working Tree
  or Index bytes.
- Fetch all attempts each configured Remote once and reports per-Remote Partial
  Success while preserving successful updates.
- Cached ahead/behind and the last successful Fetch time update truthfully; no
  prune occurs by default.

### AC-15 — Pull only by fast-forward

- A Clean behind Branch fast-forwards from its exact displayed Upstream.
- An ahead Branch is a no-op.
- A diverged, dirty, conflicted, or In-progress Worktree changes no files or refs
  and receives safe guidance without Merge, Rebase, or auto-stash.

### AC-16 — Push only committed history to the exact Upstream

- Push targets only the current Local Branch's exact configured Upstream.
- Uncommitted content remains local and is explicitly described as excluded.
- Known behind/diverged and server non-fast-forward results are blocked or rejected
  without force, matching refs, tags, deletion, or automatic retry.

### AC-17 — Publish an Unpublished Branch explicitly

- Confirmation names the exact Remote and same-name target Branch.
- Upstream is configured only after verified Push success.
- Existing target, permission, policy, network, and ambiguous outcome cases do not
  silently overwrite configuration or escalate to force.

### AC-18 — Distinguish Remote and credential failures

- Offline, authentication, permission, invalid Remote, protected-Branch/policy,
  and non-fast-forward failures remain distinct.
- Existing Git credential helpers and SSH are used without collecting credentials.
- URL userinfo, tokens, secrets, and authorization material never appear in UI,
  logs, errors, or archived evidence.

### AC-19 — Coordinate independent Worktree local mutations

- Different Worktrees may Stage, Unstage, or Commit concurrently without crossing
  Index, HEAD, draft, or selected-target state.
- Two local mutations in one Worktree do not overlap; the second is Busy and not
  queued.
- Existing external locks are reported and never removed.

### AC-20 — Coordinate Repository-wide Branch and Remote operations

- All Branch switches share one Repository lane; all Fetch/Pull/Push/Publish
  operations share another Repository lane.
- Conflicting operations return Busy without silent queueing.
- An unrelated Worktree local mutation does not invalidate independent evidence
  unnecessarily, while shared ref and occupancy changes invalidate every affected
  target.

### AC-21 — Reconcile every attempted mutation

- Success, rejection, known failure, Partial Success, cancellation, interruption,
  and timeout all trigger fresh observation of every affected state axis.
- Late reads cannot overwrite a newer snapshot.
- The displayed operation result agrees with reconciled HEAD, Index, refs,
  Upstream, status, and topology; ambiguity is reported as Unknown Outcome.

### AC-22 — Reject stale topology, identity, and navigation targets

- Removing, moving, restoring, or recreating a Worktree invalidates old Worktree,
  file, Branch occupancy, and navigation targets.
- External HEAD, ref, Upstream, occupancy, and registration changes reject stale
  mutations before execution.
- A restored path is never assumed to be the previous Worktree generation.

### AC-23 — Navigate to exact targets and preserve provenance optionality

- Worktree and Changed File actions never open a same-named target in another
  Worktree.
- Deleted files cannot Open File; renames target the new path; missing or moved
  targets cancel with explanation and safe fallback.
- Codex task/project actions appear only when exact stable metadata supports them;
  loss of that metadata changes no Git inclusion or capability.

### AC-24 — Pass the supported release envelope

- The 25-Worktree, 2,000-Changed-File, and 5,000-ref fixture meets all documented
  timing targets without UI freeze.
- Keyboard, visible focus, target-specific names, live status, focus retention,
  assistive technology, and non-color requirements pass.
- Standalone and named compatible Codex builds expose equivalent Git behavior;
  compatibility failure leaves native Codex state intact and falls back safely.
- Loopback, token/origin, iframe, path/ref injection, process, race, and redaction
  threat tests pass.

## Traceability

| Requirement  | Acceptance scenarios       | Delivery issues |
| ------------ | -------------------------- | --------------- |
| FR1          | AC-01, AC-03, AC-04, AC-22 | #6              |
| FR2          | AC-01–04, AC-22, AC-24     | #8, #15         |
| FR3          | AC-05, AC-06               | #9              |
| FR4          | AC-07, AC-08, AC-19, AC-21 | #10             |
| FR5          | AC-09, AC-10, AC-19, AC-21 | #11             |
| FR6          | AC-11–13, AC-20–22         | #12             |
| FR7          | AC-14–18, AC-20, AC-21     | #13, #14        |
| FR8          | AC-08, AC-10, AC-19–22     | #7              |
| FR9          | AC-03, AC-22, AC-23        | #4, #15         |
| Release gate | AC-01–24                   | #16, #17        |

## Definition of done

The MVP is complete only when delivery issues #2 through #17 are closed, every
AC-01 through AC-24 row has passing source-mode evidence, and the same gate passes
against the signed/notarized macOS package. The standalone surface must remain
functional without the Codex Host Adapter, and installation must clearly disclose
the local CDP trust boundary and unsupported host integration.
