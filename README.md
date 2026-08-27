# Codex Git

Codex Git is a planned local Git surface for Codex Desktop. This repository currently contains only the initial application scaffold; Worktree discovery, Git commands, Codex injection, packaging, and other product features are not implemented.

## Requirements

- macOS
- Node.js 22.12 or newer
- npm 11

## Commands

```sh
npm install
npm run dev
```

The placeholder UI is available at the URL printed by Vite. The server scaffold can be started separately:

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
apps/launcher                  Runtime composition placeholder
apps/server                    Loopback server scaffold
apps/ui                        Standalone React placeholder surface
packages/protocol              Shared protocol types
packages/repository-engine     Repository session boundary only
packages/host-adapter          Host Adapter boundary
packages/host-adapter/*        Codex CDP and standalone adapter placeholders
tests/                         Reserved contract, integration, and end-to-end layers
```
# codex-git
