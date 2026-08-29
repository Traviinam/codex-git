interface Consumer<T> {
  readonly queue: T[];
  wake: (() => void) | null;
}

export class AsyncStream<T> {
  private closed = false;
  private readonly consumers = new Set<Consumer<T>>();

  publish(value: T): void {
    if (this.closed) return;
    for (const consumer of this.consumers) {
      consumer.queue.push(value);
      consumer.wake?.();
    }
  }

  close(): void {
    this.closed = true;
    for (const consumer of this.consumers) {
      consumer.wake?.();
    }
    this.consumers.clear();
  }

  async *read(initial?: T): AsyncIterable<T> {
    const consumer: Consumer<T> = {
      queue: initial === undefined ? [] : [initial],
      wake: null,
    };
    if (!this.closed) {
      this.consumers.add(consumer);
    }

    try {
      while (!this.closed || consumer.queue.length > 0) {
        const value = consumer.queue.shift();
        if (value !== undefined) {
          yield value;
          continue;
        }
        await new Promise<void>((resolve) => {
          consumer.wake = resolve;
        });
        consumer.wake = null;
      }
    } finally {
      this.consumers.delete(consumer);
    }
  }
}
