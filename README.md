# Codex Git

Codex Git is a planned local Git surface for Codex Desktop. This repository currently contains only the initial application scaffold; Worktree discovery, Git commands, Codex injection, packaging, and other product features are not implemented.

## Product and architecture

- [Domain language](./CONTEXT.md)
- [macOS MVP product requirements](./docs/product/mvp-prd.md)
- [MVP technical architecture](./docs/architecture/mvp-technical-architecture.md)
- Architecture decisions:
  - [Isolate Codex host integration behind a Host Adapter](./docs/adr/0001-isolate-codex-host-integration.md)
  - [Use the system Git CLI behind a local Repository Engine](./docs/adr/0002-use-system-git-behind-repository-engine.md)

## Requirements

- macOS
- Node.js 22.12 or newer
- npm 11

## Commands

```sh
npm ci
npm run dev
```

The launcher attaches the placeholder Git Surface through the standalone Host Adapter and prints its URL plus the loopback health URL. The surface uses port `5173` by default; `CODEX_GIT_SURFACE_PORT` and `CODEX_GIT_PORT` override the listener ports.

The server scaffold can also be started separately:

```sh
npm run dev:server
```

Verification commands:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

## Workspace layout

```text
apps/launcher                  Standalone runtime composition root
apps/server                    Loopback server scaffold
apps/ui                        Standalone React placeholder surface
packages/protocol              Shared protocol types
packages/repository-engine     Repository session boundary only
packages/host-adapter          Host Adapter boundary
packages/host-adapter/*        Codex CDP and standalone adapter placeholders
tests/                         Contract, integration, end-to-end, and fixture layers
```

# codex-git
