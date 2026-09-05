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

Codex Desktop's Content Security Policy blocks direct loopback frame navigation.
Build `7982` uses a sandboxed `about:blank` frame instead. The launcher supplies
HTML directly from its own Vite transform pipeline, including its protocol
bootstrap. CDP writes that document into the identified blank child frame using
`Page.setDocumentContent`; the renderer never supplies a document URL or HTML.
Static module requests permit the frame's opaque `null` Origin. Git protocol
requests still require the instance token and protocol version.

A generation-scoped `Page.setBypassCSP` lease remains limited to the dedicated
renderer. A nonce and frame-source check acknowledge document readiness; missing
readiness, navigation away from the blank frame, or document loading failure
causes standalone fallback. The lease is released on close or failed attachment.
Never grant this lease to a normal user-owned Codex window.

CDP has no application-level authentication in this design. Treat access to the
dedicated loopback debugging endpoint as trusted local-process authority. Do not
bind it to a non-loopback interface, reuse a normal Codex profile, publish the
endpoint, or record it in ordinary logs.

## Tested profile

| Codex Desktop                 | Chromium framework | Frame loading                                | Evidence                                                                           |
| ----------------------------- | ------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `26.901.41600` (build `7982`) | `152.0.7977.64`    | Launcher document into sandboxed blank frame | Automated tests and local adapter smoke; VoiceOver/keyboard release record pending |
| `26.820.60940` (build `7119`) | `151.0.7922.170`   | Legacy direct frame navigation               | Historical fixture and renderer inspection; not the current release reference      |

The automated exact-profile matrix covers read-only probing, fail-closed fallback,
transactional attachment, one-entry mounting, native navigation, repeat
attachment, context updates, opaque iframe sandboxing,
generation/capability/challenge rejection, CSP lease restoration, and complete
teardown.

Any Codex version or DOM shape not listed here fails closed before mutation. A
new version requires a new explicit profile and the same fixture and manual smoke
matrix; do not widen selectors to make an unknown build appear compatible.

## Manual smoke matrix

The release reference is build `7982`. Automated local smoke confirms a visible
Git entry, document loading, Stage/Unstage against a disposable Index, repeated
opening, renderer reload, and native restoration. The durable human release
checks remain pending until the VoiceOver wizard is completed.

Builds `6962` and `7377` remain excluded. Direct HTTP iframe navigation also failed
on `7982`; that failure led to the document-loading path rather than removal of
sandbox restrictions. See the [probe and integration record](../release/evidence/build-7982-compatibility.md).

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
