# Codex Host Adapter compatibility

The Codex Host Adapter is an unsupported local CDP/DOM integration. It is not an
official Codex extension interface. The standalone Host Adapter remains the
supported fallback whenever discovery, compatibility, attachment, or remounting
cannot be proven safe.

The production integration launches a dedicated profile, binds its loopback CDP
endpoint and target, and connects only the tested public DOM anchors. It preserves
the launcher-owned project path across renderer generations, reference-counts CSP
bypass, and reports typed standalone transitions when safe attachment is lost.

## Trust and ownership requirements

Codex Git attaches only to a renderer selected through a loopback CDP endpoint
owned by a dedicated Codex Git profile or instance. A renderer name, window
title, route, or DOM resemblance is never ownership evidence. The renderer
source must provide a non-empty stable target ID and the exact
`codex-git-dedicated` ownership proof before the compatibility probe can mutate
the document.

Codex Desktop's Content Security Policy does not allow the loopback Git Surface
as a frame. The dedicated renderer therefore grants a generation-scoped
`Page.setBypassCSP` lease before mounting. The lease is released after any
replacement, failed attachment, or connection close. Never grant this lease to
a normal user-owned Codex window: bypassing CSP expands the effect of any script
already executing in that renderer.

CDP has no application-level authentication in this design. Treat access to the
dedicated loopback debugging endpoint as trusted local-process authority. Do not
bind it to a non-loopback interface, reuse a normal Codex profile, publish the
endpoint, or record it in ordinary logs.

## Tested profile

| Codex Desktop                 | Chromium framework | Required anchors                                                | Evidence                                                                 |
| ----------------------------- | ------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `26.820.60940` (build `7119`) | `151.0.7922.170`   | `#app-shell-sidebar`; `[data-app-shell-main-surface="default"]` | Installed renderer bundle inspection plus automated DOM fixture coverage |

The automated exact-profile matrix covers read-only probing, fail-closed fallback,
transactional attachment, one-entry mounting, native navigation, repeat
attachment, context updates, opaque iframe sandboxing,
generation/capability/challenge rejection, CSP lease restoration, and complete
teardown.

Any Codex version or DOM shape not listed here fails closed before mutation. A
new version requires a new explicit profile and the same fixture and manual smoke
matrix; do not widen selectors to make an unknown build appear compatible.

## Manual smoke matrix

This matrix passed on 2026-08-29 against a disposable dedicated profile using
Codex Desktop `26.820.60940` (build `7119`) and Chromium `151.0.7922.170`.
Builds `6962` and `7377` are intentionally excluded: live validation showed
their `app://` Content Security Policy blocks the loopback Git Surface frame
even after the scoped CDP bypass command. Build `7377` also reports Chromium
`151.0.7922.174`, outside the tested framework version. Unsupported builds must
use the standalone surface.

The human portion of the matrix is intentionally limited to behavior that
requires an actual Codex/macOS session. The release wizard records these checks:

- Open `Git` and confirm exactly one entry and one full-page frame.
- Select a native destination and confirm native content is restored with no
  hidden overlay, then reopen `Git` without duplication.
- Reload the renderer and confirm exactly one remounted entry and one fresh
  frame generation.

Context and Current Project transitions, invalid/replayed messages, full
connection and CSP teardown, and broken-selector fallback are enforced by the
automated exact-profile matrix rather than claimed by the human record.
