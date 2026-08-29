import { resolve } from 'node:path';

import { startCodexRuntime } from './index.js';

const runtime = await startCodexRuntime({
  projectPath: resolve(process.env.CODEX_GIT_PROJECT_PATH ?? process.cwd()),
  surfacePort: readPort('CODEX_GIT_SURFACE_PORT', 5173),
});

console.log(`Codex Git placeholder surface: ${runtime.surfaceUrl.href}`);
console.log(`Codex Git health endpoint: ${runtime.healthUrl.href}`);
console.log(`Codex Git host: ${runtime.currentHost()}`);

let stopping = false;

function stop(): void {
  if (stopping) {
    return;
  }

  stopping = true;
  void runtime.close().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

function readPort(name: string, fallback: number): number {
  const value = process.env[name];

  if (value === undefined) {
    return fallback;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${name} must be an integer between 0 and 65535`);
  }

  return port;
}
