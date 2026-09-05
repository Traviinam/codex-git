# Build 7982 compatibility probe

- Direct HTTP iframe navigation: failed.
- Blank-frame document injection: full built UI prototype passed (see below).
- Production adapter document-loading path: implemented; manual release acceptance remains pending.
- Performed: 2026-09-06 (Asia/Shanghai).
- Source commit: `07c30c0813c5e4ec5e3de5f863015b2c181c5b40`.
- Environment: macOS 26.6.2, Apple M4, Node 24.19.0.
- Application: 26.901.41600 (build 7982).
- CDP browser product: `Chrome/152.0.7977.64`.

## Procedure and observations

1. Launch the installed application through `launchDedicatedCodexInstance`,
   using a disposable profile and its owned loopback CDP target.
2. Wait for the renderer to initialize. Confirm one `#app-shell-sidebar` and
   one `[data-app-shell-main-surface="default"]` anchor.
3. Serve a minimal HTML page from an ephemeral listener on `127.0.0.1`. The page
   posts a load acknowledgement to its parent.
4. Enable `Network` events and `Page.setBypassCSP` on the dedicated target.
5. Append an iframe with `sandbox="allow-scripts"` pointing to the probe page.
6. Observe `Network.loadingFailed` for the Document request with
   `errorText: net::ERR_BLOCKED_BY_CSP`. No load acknowledgement arrives during
   the three-second observation interval.
7. Remove the probe iframe, disable the CSP bypass, close the listener and CDP
   session, and close the dedicated instance and disposable profile.

This probe does not establish Git product behavior, native-navigation recovery,
or accessibility conformance. Both required manual release checks remain
pending. Do not add this build to the supported profile or mark AC-24 passed on
the strength of DOM anchors alone.

## Alternative document-loading prototype

A subsequent probe used a sandboxed `about:blank` iframe and
`Page.setDocumentContent`, inspired by dashi-taskboard commit
`08f0419cc3cb1b14f09578806f6bcac53b067414`. No third-party injector was executed.
The original direct-navigation failure does not establish that all embedding
techniques fail on this build.

The prototype served this repository's existing built JavaScript and CSS from an
owned ephemeral loopback listener permitting the opaque `null` origin. It loaded
the built HTML in the local process, added a loopback base URL and the existing
protocol bootstrap, and wrote the document into the named blank frame. It used
`sandbox="allow-scripts"`, without `allow-same-origin`, and retained the existing
token-protected protocol server.

Observed on the same build and machine:

- The complete React Git interface rendered and displayed an actual disposable
  repository snapshot.
- An externally created file appeared through the existing invalidation/SSE path.
- Stage and Unstage invoked from the embedded UI updated and cleared the actual
  disposable repository Index, checked with `git diff --cached --name-only`.
- After a renderer reload, the probe explicitly recreated the frame and wrote the
  document again; the UI loaded the updated repository snapshot.
- Explicit teardown removed the frame and restored the native main surface.

These are prototype observations, not production adapter or manual acceptance
results. The probe used built assets and a temporary asset listener, not the
launcher's Vite development surface. Reload recovery was driven by the probe;
production lifecycle automation, exact host/project binding, frame readiness,
authenticated document delivery, failure cleanup, layout, and VoiceOver/keyboard
acceptance still require implementation and verification.

## Production adapter integration

The adapter now recognizes the exact build and Chromium pair, inserts a Git
button before the native Explore group, and uses a launcher-owned HTML callback.
Unlike the earlier prototype, this path uses the existing Vite surface and
protocol bootstrap directly, with an explicit opaque-origin asset CORS policy.
The current frame name, blank URL, and per-load nonce constrain document delivery.
The legacy in-process DOM adapter rejects this profile because it has no CDP
document loader.

The source-mode CI reference and repeatable manual wizard now target build 7982.
No manual check has been marked passed and no standalone-only scope waiver was
applied. The historical direct-navigation failure is retained above to explain
the implementation choice.

On the final local adapter smoke, the Git entry appeared in the native navigation
area (one entry), repeat opening left one frame, and renderer reload automatically
restored one entry and one frame with document readiness confirmed. Native
navigation removed the Git surface and restored the main surface's original
visibility. The smoke process exited successfully after adapter cleanup.

Reload readiness is deduplicated so repeated execution-context events cannot
rewrite an already initialized module document. The remount grace period is
15 seconds to accommodate the actual renderer startup. Asset CORS is restricted
by response media type to JavaScript/CSS; bootstrap and fallback HTML have no
opaque-origin CORS permission. A loopback regression test enforces that boundary.
