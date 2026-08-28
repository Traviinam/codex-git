# Codex Git

Codex Git is the local Git workspace presented for the Current Project. Its
language keeps Repository-wide facts separate from the state and actions of each
registered Worktree.

## Workspace

**Current Project**:
The local macOS project currently selected as the source of the Git workspace.
It may or may not belong to a Repository.
_Avoid_: Active project, open folder

**Repository**:
One Git repository, including its shared objects, references, configuration, and
registered Worktrees.
_Avoid_: Repo, project, folder

**Worktree**:
One registered checkout of a Repository with its own Working Tree, Index, and
HEAD.
_Avoid_: Workspace, checkout, task

**Main Worktree**:
The primary Worktree of a Repository. It is a Git role, not a claim about its
Branch name or how the Worktree is used.
_Avoid_: Main Branch, root Worktree

**Linked Worktree**:
Any registered Worktree that is not the Main Worktree.
_Avoid_: Secondary Repository, child Worktree

**Available Worktree**:
A registered Worktree whose Working Tree can currently be inspected and used for
the capabilities allowed by its Git state.
_Avoid_: Healthy Worktree, active task

**Unavailable Worktree**:
A registered Worktree that cannot currently be inspected or acted on, while its
registration remains relevant for diagnosis.
_Avoid_: Deleted Worktree, invalid Worktree

**Worktree Generation**:
One continuous identity lifetime of a registered Worktree. Removing, moving, or
recreating a Worktree begins a different generation even if a path is reused.
_Avoid_: Worktree version, refresh generation

## Provenance

**Provenance**:
Optional evidence about who or what created or owns a Worktree. Provenance never
determines whether a Worktree belongs to the Repository or which Git capabilities
it has.
_Avoid_: Worktree type, Git source

**Codex Task Worktree**:
A Worktree whose association with a Codex task is proven by stable Codex-owned
metadata.
_Avoid_: Codex-looking Worktree, task Branch

**Scheduled Worktree**:
A Worktree whose scheduled lifecycle is proven by stable Codex-owned metadata.
_Avoid_: Automation Branch, scheduled-looking Worktree

**Permanent Worktree**:
A Worktree whose permanent lifecycle is proven by stable Codex-owned metadata.
_Avoid_: Long-lived Worktree, manually named Worktree

**External Worktree**:
A Worktree whose non-Codex origin is proven by stable Codex-owned metadata.
_Avoid_: Manual Worktree, unknown Worktree

**Unclassified Worktree**:
A Worktree for which provenance evidence is absent, unstable, or conflicting.
_Avoid_: External Worktree, other Worktree

## Git state

**Working Tree**:
The checked-out files of one Worktree.
_Avoid_: Workspace files, local files

**Index**:
The staged snapshot belonging to one Worktree and proposed for its next Commit.
_Avoid_: Staging area, staged files

**HEAD**:
The current Commit position of one Worktree, either attached to a Local Branch or
detached.
_Avoid_: Current Branch, latest Commit

**Local Branch**:
A named local reference to a Commit.
_Avoid_: Branch when local or remote-tracking kind matters

**Remote-tracking Branch**:
A locally cached reference representing the last fetched state of a Branch in a
Remote.
_Avoid_: Remote Branch, live Branch

**Upstream**:
The configured Remote-tracking Branch against which a Local Branch is compared
and to which its ordinary Pull and Push are directed.
_Avoid_: Remote, origin, destination Branch

**Unpublished Branch**:
A Local Branch without an Upstream that is eligible to be published to a
confirmed same-name Branch on a selected Remote.
_Avoid_: New Branch, local-only Branch

**Detached HEAD**:
A Worktree state in which HEAD identifies a Commit without being attached to a
Local Branch.
_Avoid_: No Branch, anonymous Branch

**Initial Repository State**:
A Repository state before the first Commit exists.
_Avoid_: Empty Branch, broken HEAD

**Clean Worktree**:
A Worktree with no Conflict and no difference among HEAD, Index, and Working
Tree, including no Untracked File.
_Avoid_: Safe Worktree, unchanged Repository

**In-progress Git Operation**:
A Git-managed Repository state indicating an unfinished operation whose
completion or recovery is outside the MVP.
_Avoid_: Busy Worktree, lock

**Branch Occupancy**:
The association between a Local Branch and the registered Worktree in which it is
currently checked out.
_Avoid_: Branch lock, Branch owner

## Changes and review

**Changed File**:
One path-and-baseline observation in a Worktree. The same path may be represented
by more than one Changed File when it differs across multiple baselines.
_Avoid_: Dirty file, modified path

**Conflict**:
A Changed File whose Index has unresolved entries.
_Avoid_: Merge error, unstaged change

**Staged Change**:
A Changed File representing a difference from HEAD to Index.
_Avoid_: Staged File

**Change**:
A Changed File representing a difference from Index to Working Tree.
_Avoid_: Unstaged File, modification

**Untracked File**:
A Working Tree path that is not represented in the Index.
_Avoid_: New Change, unstaged file

**Diff Baseline**:
The exact pair of Git states compared for one Changed File review.
_Avoid_: File version, diff type

**Commit Draft**:
The unsubmitted Commit message associated with one Repository and Worktree.
_Avoid_: Commit, message template

## Operations and outcomes

**Local Mutation**:
An operation that may change one Worktree's Index, HEAD, or Working Tree without
contacting a Remote.
_Avoid_: Local command, file operation

**Branch Switch**:
A Repository-coordinated operation that changes the Branch or detached position
of one Worktree.
_Avoid_: Checkout, Branch change

**Remote Operation**:
An operation that communicates with a configured Remote and may change shared
references or transfer Git objects.
_Avoid_: Network command, sync

**Refresh**:
A local observation that produces current Repository and Worktree state without
contacting a Remote.
_Avoid_: Fetch, reload

**Reconciliation**:
A fresh observation after an attempted mutation that establishes what Git state
actually resulted.
_Avoid_: Refresh when outcome recovery is meant, rollback

**Succeeded**:
An operation outcome in which the requested effect is verified in reconciled
state.
_Avoid_: Completed

**Rejected**:
An operation outcome in which a current precondition prevents execution and no
requested mutation begins.
_Avoid_: Failed, invalid

**Failed Known**:
An operation outcome in which execution does not achieve the requested effect and
reconciled state is known.
_Avoid_: Error, rejected

**Partial Success**:
An operation outcome in which independently reportable requested effects have a
mixture of verified success and failure.
_Avoid_: Failed, mostly succeeded

**Unknown Outcome**:
An operation outcome in which interruption, timeout, or ambiguous process state
prevents the product from proving whether the requested effect occurred.
_Avoid_: Failed, cancelled

**Busy**:
A Rejected outcome indicating that a conflicting operation lane is already in
use and the new mutation was not queued.
_Avoid_: Pending, waiting
