---
status: accepted
---

# Isolate Codex host integration behind a Host Adapter

Codex Git will expose one Host Adapter interface with standalone and Codex CDP/DOM
adapters. The standalone adapter is the dependable fallback; the Codex adapter is
an explicitly unsupported, replaceable integration that may mount the same Git
surface in compatible Codex Desktop builds without letting host details enter the
product modules.

## Considered options

- Build directly against Codex renderer structure. This couples every product
  module to an undocumented host that can change without notice.
- Ship only a standalone surface. This is stable but does not provide the intended
  top-level Codex `Git` experience.
- Isolate host behavior behind an adapter seam. This preserves the intended
  experience while keeping compatibility failure local and recoverable.

## Consequences

The Codex adapter must fail closed, validate compatibility before mutation, clean
up everything it mounts, and fall back to standalone operation. No official Codex
extension capability is assumed, and installation/runtime documentation must
disclose the trusted-local-process CDP boundary.
