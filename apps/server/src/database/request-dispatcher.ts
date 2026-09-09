export class DatabaseWorkerShuttingDownError extends Error {
  readonly code = "DATABASE_WORKER_SHUTTING_DOWN";
  readonly retryable = true;

  constructor() {
    super("The Database Worker is shutting down.");
    this.name = "DatabaseWorkerShuttingDownError";
  }
}

/** Concurrent message lifetimes; every SQLite segment remains the caller's responsibility. */
export class DatabaseRequestDispatcher {
  readonly #controller = new AbortController();
  readonly #pending = new Set<Promise<void>>();
  #draining = false;
  #drainPromise: Promise<void> | undefined;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get draining(): boolean {
    return this.#draining;
  }

  run<T>(work: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
    if (this.#draining) return Promise.reject(new DatabaseWorkerShuttingDownError());

    // Reserve before invoking work: work or an abort listener can re-enter drain synchronously.
    let releaseReservation!: () => void;
    const reservation = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    this.#pending.add(reservation);

    let returned: T | Promise<T>;
    try {
      // Do not defer this call or place it behind another request's promise.
      returned = work(this.#controller.signal);
    } catch (error) {
      returned = Promise.reject(error);
    }

    const result = Promise.resolve(returned).then((value) => {
      if (this.#draining) throw new DatabaseWorkerShuttingDownError();
      return value;
    });
    const release = (): void => {
      this.#pending.delete(reservation);
      releaseReservation();
    };
    // Return the actual result promise, not a finally wrapper that could settle after drain.
    // Response reactions registered by the caller run before the reservation's drain reaction.
    void result.then(release, release);
    return result;
  }

  drain(): Promise<void> {
    if (this.#drainPromise !== undefined) return this.#drainPromise;

    let complete!: () => void;
    this.#drainPromise = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.#draining = true;
    // Admission and the memoized promise are visible before synchronous abort listeners run.
    this.#controller.abort(new DatabaseWorkerShuttingDownError());
    void Promise.allSettled([...this.#pending]).then(() => complete());
    return this.#drainPromise;
  }
}
