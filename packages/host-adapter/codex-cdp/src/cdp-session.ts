export interface CdpEvent {
  readonly method: string;
  readonly params?: unknown;
}

export interface CdpSession {
  send(method: string, params?: unknown): Promise<unknown>;
  subscribe(listener: (event: CdpEvent) => void): () => void;
  close(): Promise<void>;
}

export async function connectCdpSession(url: string): Promise<CdpSession> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener(
      'error',
      () => reject(new Error('Dedicated Codex CDP websocket failed to open')),
      { once: true },
    );
  });
  return new WebSocketCdpSession(socket);
}

class WebSocketCdpSession implements CdpSession {
  private nextId = 0;
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly pending = new Map<
    number,
    { reject(error: Error): void; resolve(value: unknown): void }
  >();

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', this.handleMessage);
    socket.addEventListener('close', this.handleClose);
  }

  send(method: string, params?: unknown): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Dedicated Codex CDP session is closed'));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      this.socket.send(
        JSON.stringify(
          params === undefined ? { id, method } : { id, method, params },
        ),
      );
    });
  }

  subscribe(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    const closed = new Promise<void>((resolve) => {
      this.socket.addEventListener('close', () => resolve(), { once: true });
    });
    this.socket.close();
    await Promise.race([
      closed,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  private readonly handleMessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(event.data) as unknown;
    } catch {
      return;
    }
    if (!isRecord(message)) {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(message.id);
      if (isRecord(message.error)) {
        pending.reject(new Error('Dedicated Codex CDP command failed'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') {
      this.listeners.forEach((listener) =>
        listener({ method: message.method as string, params: message.params }),
      );
    }
  };

  private readonly handleClose = () => {
    const error = new Error('Dedicated Codex CDP session closed');
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
    this.listeners.forEach((listener) =>
      listener({ method: 'CodexGit.sessionClosed' }),
    );
    this.listeners.clear();
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
