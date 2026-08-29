const MAX_PENDING_INVALIDATIONS = 32;

export class InvalidationStream<T> {
  readonly #subscribers = new Set<InvalidationSubscription<T>>();
  #closed = false;

  publish(value: T): void {
    if (this.#closed) {
      return;
    }
    for (const subscriber of this.#subscribers) {
      subscriber.publish(value);
    }
  }

  subscribe(): AsyncIterable<T> {
    const subscription = new InvalidationSubscription<T>(() => {
      this.#subscribers.delete(subscription);
    });
    if (this.#closed) {
      subscription.close();
    } else {
      this.#subscribers.add(subscription);
    }
    return subscription;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const subscriber of this.#subscribers) {
      subscriber.close();
    }
    this.#subscribers.clear();
  }
}

class InvalidationSubscription<T> implements AsyncIterableIterator<T> {
  readonly #pending: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  readonly #onClose: () => void;
  #closed = false;

  constructor(onClose: () => void) {
    this.#onClose = onClose;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#pending.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  publish(value: T): void {
    if (this.#closed) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value });
      return;
    }
    if (this.#pending.length === MAX_PENDING_INVALIDATIONS) {
      this.#pending.shift();
    }
    this.#pending.push(value);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#pending.length = 0;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
    this.#onClose();
  }
}
