interface PendingRead<T> {
  readonly read: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

export class GitReadPolicy {
  readonly #maximumConcurrency: number;
  readonly #pending: PendingRead<unknown>[] = [];
  readonly #inFlight = new Map<string, Promise<unknown>>();
  #active = 0;

  constructor(maximumConcurrency: number) {
    if (!Number.isSafeInteger(maximumConcurrency) || maximumConcurrency < 1) {
      throw new Error('Git read concurrency must be a positive integer.');
    }
    this.#maximumConcurrency = maximumConcurrency;
  }

  run<T>(key: string, read: () => Promise<T>): Promise<T> {
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) {
      return existing as Promise<T>;
    }

    const scheduled = new Promise<T>((resolve, reject) => {
      this.#pending.push({
        read,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
    const tracked = scheduled.finally(() => {
      if (this.#inFlight.get(key) === tracked) {
        this.#inFlight.delete(key);
      }
    });
    this.#inFlight.set(key, tracked);
    this.#startPendingReads();
    return tracked;
  }

  #startPendingReads(): void {
    while (
      this.#active < this.#maximumConcurrency &&
      this.#pending.length > 0
    ) {
      const pending = this.#pending.shift()!;
      this.#active += 1;
      void pending
        .read()
        .then(pending.resolve, pending.reject)
        .finally(() => {
          this.#active -= 1;
          this.#startPendingReads();
        });
    }
  }
}

export async function runSelectedFirst<T, Result>(
  items: readonly T[],
  isSelected: (item: T) => boolean,
  observe: (item: T) => Promise<Result>,
): Promise<readonly Result[]> {
  const selected = items.filter(isSelected);
  const remaining = items.filter((item) => !isSelected(item));
  const selectedResults = await Promise.all(selected.map(observe));
  const remainingResults = await Promise.all(remaining.map(observe));
  return [...selectedResults, ...remainingResults];
}
