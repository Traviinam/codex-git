---
status: accepted
---

# Use the system Git CLI behind a local Repository Engine

Codex Git will obtain Git semantics from the user's system Git executable, but
only the local Repository Engine may discover repositories, construct arguments,
start Git processes, or interpret their results. The browser surface communicates
through typed product operations and never receives general process authority.

## Considered options

- Implement Git behavior with a JavaScript or Rust library. Library coverage and
  behavior would diverge from the user's configured Git, hooks, signing, credential
  helpers, and Worktree semantics.
- Let the UI invoke Git directly. This exposes filesystem and process authority to
  an untrusted presentation surface and spreads correctness rules across callers.
- Put system Git behind one deep Repository Engine module. This preserves native
  behavior while concentrating validation, concurrency, redaction, and recovery.

## Consequences

The Repository Engine owns a small typed interface and all Git execution policy.
It must use literal arguments and bounded input/output, preserve configured hooks,
signing, and credential helpers, never invoke a shell, and reconcile state after
every attempted mutation. Packaging may supervise the Engine but must not fork or
reimplement its Git behavior.
