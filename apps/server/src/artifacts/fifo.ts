export class KeyedFifo {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const predecessor = this.#tails.get(key) ?? Promise.resolve();
    const result = predecessor.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    });
    return result;
  }
}

export class SerialFifo {
  readonly #fifo = new KeyedFifo();

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    return this.#fifo.run("serial", operation);
  }
}
