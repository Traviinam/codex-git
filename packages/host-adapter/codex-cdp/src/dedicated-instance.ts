import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const loopbackHost = '127.0.0.1';

export interface DedicatedCodexOwnership {
  readonly endpoint: string;
  readonly instanceId: string;
  readonly processId: number;
  readonly profilePath: string;
}

export interface DedicatedCodexTarget {
  readonly id: string;
  readonly webSocketUrl: string;
}

export interface DedicatedCodexProcess {
  readonly exited: Promise<void>;
  readonly pid: number;
  terminate(): void;
}

export interface DedicatedCodexPlatform {
  createProfile(): Promise<string>;
  readAppIdentity(appPath: string): Promise<{
    readonly build: string;
    readonly version: string;
  }>;
  spawn(executable: string, args: readonly string[]): DedicatedCodexProcess;
  readFile(path: string): Promise<string>;
  fetchJson(url: URL): Promise<unknown>;
  removeProfile(profilePath: string): Promise<void>;
  wait(milliseconds: number): Promise<void>;
}

export interface DedicatedCodexInstance {
  readonly build: string;
  readonly ownership: DedicatedCodexOwnership;
  readonly version: string;
  currentTarget(): Promise<DedicatedCodexTarget | null>;
  subscribe(
    listener: (target: DedicatedCodexTarget | null) => void,
  ): () => void;
  close(): Promise<void>;
}

export interface LaunchDedicatedCodexOptions {
  readonly appPath?: string;
  readonly createInstanceId?: () => string;
  readonly platform?: DedicatedCodexPlatform;
  readonly startupTimeoutMs?: number;
}

export async function launchDedicatedCodexInstance(
  options: LaunchDedicatedCodexOptions = {},
): Promise<DedicatedCodexInstance> {
  const appPath = options.appPath ?? '/Applications/ChatGPT.app';
  const platform = options.platform ?? defaultPlatform;
  const profilePath = await platform.createProfile();
  let process: DedicatedCodexProcess | null = null;

  try {
    const { build, version } = await platform.readAppIdentity(appPath);
    const executable = join(appPath, 'Contents', 'MacOS', 'ChatGPT');
    process = platform.spawn(executable, [
      `--user-data-dir=${profilePath}`,
      '--remote-debugging-port=0',
      '--no-first-run',
    ]);
    const endpoint = await waitForEndpoint(
      platform,
      process,
      profilePath,
      options.startupTimeoutMs ?? 15_000,
    );
    const ownership = {
      endpoint: endpoint.href,
      instanceId: (options.createInstanceId ?? randomUUID)(),
      processId: process.pid,
      profilePath,
    } satisfies DedicatedCodexOwnership;

    const instance = new OwnedDedicatedCodexInstance(
      ownership,
      build,
      version,
      process,
      platform,
    );
    const targetDeadline = Date.now() + (options.startupTimeoutMs ?? 15_000);
    while (Date.now() < targetDeadline) {
      if ((await instance.currentTarget().catch(() => null)) !== null) {
        return instance;
      }
      await platform.wait(50);
    }
    throw new Error('Dedicated Codex renderer target did not become available');
  } catch (error) {
    process?.terminate();
    await platform.removeProfile(profilePath);
    throw error;
  }
}

class OwnedDedicatedCodexInstance implements DedicatedCodexInstance {
  private closeAttempt: Promise<void> | null = null;
  private lastTargetId: string | null = null;
  private missingPolls = 0;
  private pollInFlight = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly subscribers = new Set<
    (target: DedicatedCodexTarget | null) => void
  >();

  constructor(
    readonly ownership: DedicatedCodexOwnership,
    readonly build: string,
    readonly version: string,
    private readonly process: DedicatedCodexProcess,
    private readonly platform: DedicatedCodexPlatform,
  ) {}

  async currentTarget(): Promise<DedicatedCodexTarget | null> {
    const target = await this.discoverTarget();
    this.lastTargetId = target?.id ?? null;
    return target;
  }

  subscribe(
    listener: (target: DedicatedCodexTarget | null) => void,
  ): () => void {
    this.subscribers.add(listener);
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => void this.poll(), 500);
      this.pollTimer.unref();
    }
    return () => {
      this.subscribers.delete(listener);
      if (this.subscribers.size === 0 && this.pollTimer !== null) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    };
  }

  private async discoverTarget(): Promise<DedicatedCodexTarget | null> {
    const endpoint = new URL(this.ownership.endpoint);
    const targets = await this.platform.fetchJson(
      new URL('/json/list', endpoint),
    );
    if (!Array.isArray(targets)) {
      return null;
    }

    const ownedTargets = targets.flatMap((target) => {
      const parsed = parseOwnedTarget(target, endpoint);
      return parsed === null ? [] : [parsed];
    });
    return ownedTargets.length === 1 ? (ownedTargets[0] ?? null) : null;
  }

  close(): Promise<void> {
    this.closeAttempt ??= this.closeOnce();
    return this.closeAttempt;
  }

  private async closeOnce(): Promise<void> {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.subscribers.clear();
    this.process.terminate();
    await Promise.race([this.process.exited, this.platform.wait(5_000)]);
    await this.platform.removeProfile(this.ownership.profilePath);
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const target = await this.discoverTarget();
      if (target === null && ++this.missingPolls < 10) return;
      if (target !== null) this.missingPolls = 0;
      const targetId = target?.id ?? null;
      if (targetId !== this.lastTargetId) {
        this.lastTargetId = targetId;
        this.subscribers.forEach((subscriber) => subscriber(target));
      }
    } catch {
      return;
    } finally {
      this.pollInFlight = false;
    }
  }
}

async function waitForEndpoint(
  platform: DedicatedCodexPlatform,
  process: DedicatedCodexProcess,
  profilePath: string,
  timeoutMs: number,
): Promise<URL> {
  const startedAt = Date.now();
  let exited = false;
  void process.exited.then(() => {
    exited = true;
  });

  while (Date.now() - startedAt < timeoutMs) {
    if (exited) {
      throw new Error('Dedicated Codex exited before CDP became available');
    }
    try {
      const contents = await platform.readFile(
        join(profilePath, 'DevToolsActivePort'),
      );
      return parseDevToolsEndpoint(contents);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
    }
    await platform.wait(50);
  }

  throw new Error('Dedicated Codex CDP endpoint did not become available');
}

function parseDevToolsEndpoint(contents: string): URL {
  const [portText, browserPath] = contents.trim().split(/\r?\n/u);
  const port = Number(portText);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    browserPath === undefined ||
    !/^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(browserPath)
  ) {
    throw new Error('Dedicated Codex returned an invalid CDP endpoint');
  }
  return new URL(`http://${loopbackHost}:${port}/`);
}

function parseOwnedTarget(
  value: unknown,
  endpoint: URL,
): DedicatedCodexTarget | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const target = value as Record<string, unknown>;
  if (
    target.type !== 'page' ||
    target.url !== 'app://-/index.html' ||
    typeof target.id !== 'string' ||
    target.id.length === 0 ||
    target.id.includes('/') ||
    typeof target.webSocketDebuggerUrl !== 'string'
  ) {
    return null;
  }

  const parsed = { id: target.id, webSocketUrl: target.webSocketDebuggerUrl };
  return isDedicatedCodexTargetBoundToEndpoint(parsed, endpoint.href)
    ? parsed
    : null;
}

export function isDedicatedCodexTargetBoundToEndpoint(
  target: DedicatedCodexTarget,
  endpointUrl: string,
): boolean {
  let endpoint: URL;
  let webSocketUrl: URL;
  try {
    endpoint = new URL(endpointUrl);
    webSocketUrl = new URL(target.webSocketUrl);
  } catch {
    return false;
  }
  return (
    endpoint.protocol === 'http:' &&
    endpoint.hostname === loopbackHost &&
    endpoint.username === '' &&
    endpoint.password === '' &&
    webSocketUrl.protocol === 'ws:' &&
    webSocketUrl.hostname === loopbackHost &&
    webSocketUrl.port === endpoint.port &&
    webSocketUrl.pathname === `/devtools/page/${target.id}` &&
    webSocketUrl.username === '' &&
    webSocketUrl.password === ''
  );
}

const defaultPlatform: DedicatedCodexPlatform = {
  createProfile: () => mkdtemp(join(tmpdir(), 'codex-git-')),
  async readAppIdentity(appPath) {
    const plist = join(appPath, 'Contents', 'Info.plist');
    const read = (key: string) =>
      executeFile('/usr/bin/plutil', ['-extract', key, 'raw', plist]);
    const [build, version] = await Promise.all([
      read('CFBundleVersion'),
      read('CFBundleShortVersionString'),
    ]);
    return { build, version };
  },
  spawn(executable, args) {
    const child = spawn(executable, [...args], { stdio: 'ignore' });
    if (child.pid === undefined) {
      throw new Error('Dedicated Codex process did not start');
    }
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    return {
      exited,
      pid: child.pid,
      terminate: () => child.kill('SIGTERM'),
    };
  },
  readFile: (path) => readFile(path, 'utf8'),
  async fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Dedicated Codex CDP discovery returned ${response.status}`,
      );
    }
    return response.json() as Promise<unknown>;
  },
  removeProfile: (profilePath) =>
    rm(profilePath, { force: true, recursive: true }),
  wait: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function executeFile(
  executable: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}
