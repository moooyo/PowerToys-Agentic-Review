import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import type { HostControlSession } from "./host-control-session.js";
import { type HostControlPipeSelector, isHostControlPipeSelector } from "./launch-contract.js";

const defaultConnectTimeoutMs = 30_000;
const defaultCloseTimeoutMs = 15_000;
const maximumTimeoutMs = 10 * 60 * 1_000;

export type ExecutorHostControlConnector = (
  pipe: HostControlPipeSelector,
  cancellation: AbortSignal,
) => Promise<Duplex>;

export interface ExecutorHostControlOptions {
  readonly role: "executor";
  readonly pipe: HostControlPipeSelector;
  readonly connectTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly connector?: ExecutorHostControlConnector;
}

export class ExecutorHostControlError extends Error {
  public constructor(
    public readonly code:
      | "CLIENT_CLOSED"
      | "CLOSE_TIMEOUT"
      | "CONNECT_CANCELLED"
      | "CONNECT_FAILED"
      | "CONNECT_TIMEOUT"
      | "PROTOCOL_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "ExecutorHostControlError";
  }
}

/** Connects the Executor rendezvous pipe without exposing any privileged Control RPC method. */
export async function connectExecutorHostControl(
  options: ExecutorHostControlOptions,
  signal?: AbortSignal,
): Promise<HostControlSession<"executor">> {
  if (options.role !== "executor" || !isHostControlPipeSelector(options.pipe)) {
    throw new TypeError("Executor HostControl options are invalid.");
  }
  const connectTimeoutMs = boundedTimeout(options.connectTimeoutMs ?? defaultConnectTimeoutMs);
  const closeTimeoutMs = boundedTimeout(options.closeTimeoutMs ?? defaultCloseTimeoutMs);
  if (signal?.aborted) {
    throw executorError("CONNECT_CANCELLED", "Executor HostControl connection was cancelled.");
  }
  const connector = options.connector ?? defaultConnector;
  const stream = await connectWithDeadline(connector, options.pipe, connectTimeoutMs, signal);
  return new ExecutorHostControlSession(stream, closeTimeoutMs);
}

class ExecutorHostControlSession implements HostControlSession<"executor"> {
  public readonly role = "executor" as const;
  readonly #closed = new Deferred<void>();
  readonly #failure = new Deferred<never>();
  #terminalError: ExecutorHostControlError | undefined;
  #state: "open" | "draining" | "closing" | "closed" | "failed" = "open";
  #readableEndObserved = false;
  #drainPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  public constructor(
    private readonly stream: Duplex,
    private readonly closeTimeoutMs: number,
  ) {
    stream.on("data", () => {
      this.#fail(
        executorError(
          "PROTOCOL_FAILURE",
          "Executor HostControl received an unsupported RPC response.",
        ),
      );
    });
    stream.once("error", () => {
      this.#fail(executorError("PROTOCOL_FAILURE", "Executor HostControl stream failed."));
    });
    stream.once("end", () => {
      this.#readableEndObserved = true;
      if (this.#state !== "draining" && this.#state !== "closing") {
        this.#fail(
          executorError("PROTOCOL_FAILURE", "Executor HostControl peer closed unexpectedly."),
        );
      }
    });
    stream.once("close", () => {
      if (this.#state === "open" || (this.#state === "draining" && !this.#readableEndObserved)) {
        this.#fail(
          executorError("PROTOCOL_FAILURE", "Executor HostControl peer closed unexpectedly."),
          false,
        );
      }
      if (this.#state !== "failed") this.#state = "closed";
      this.#closed.resolve(undefined);
    });
  }

  public drain(): Promise<void> {
    this.#drainPromise ??= this.#drain();
    return this.#drainPromise;
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #drain(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "failed") throw this.#terminalError;
    if (this.#state === "closing") return this.close();
    this.#state = "draining";
    const deadline = performance.now() + this.closeTimeoutMs;
    try {
      await this.#awaitDrainPhase(
        new Promise<void>((resolve, reject) => {
          try {
            this.stream.end(resolve);
          } catch (error) {
            reject(error);
          }
        }),
        deadline,
      );
      await this.#awaitDrainPhase(this.#closed.promise, deadline);
      if (this.#terminalError !== undefined) throw this.#terminalError;
    } catch {
      if (this.#terminalError !== undefined) throw this.#terminalError;
      const error = executorError("CLOSE_TIMEOUT", "Executor HostControl drain timed out.");
      this.#fail(error);
      throw error;
    }
  }

  async #close(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "draining") {
      this.#fail(
        executorError("CLIENT_CLOSED", "Executor HostControl drain was interrupted by close."),
      );
    } else if (this.#state !== "failed") {
      this.#state = "closing";
    }
    try {
      this.stream.destroy();
    } catch {
      // The close event or deadline remains authoritative.
    }
    try {
      await withTimeout(this.#closed.promise, this.closeTimeoutMs);
    } catch {
      throw executorError("CLOSE_TIMEOUT", "Executor HostControl stream did not close in time.");
    }
  }

  #fail(error: ExecutorHostControlError, destroy = true): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    this.#state = "failed";
    this.#terminalError = error;
    this.#failure.reject(error);
    if (destroy) {
      try {
        this.stream.destroy();
      } catch {
        // The terminal state is already committed.
      }
    }
  }

  #awaitDrainPhase<T>(phase: Promise<T>, deadline: number): Promise<T> {
    return withTimeout(
      Promise.race([phase, this.#failure.promise]),
      remainingMilliseconds(deadline),
    );
  }
}

class Deferred<T> {
  public readonly promise: Promise<T>;
  readonly #resolve: (value: T | PromiseLike<T>) => void;
  readonly #reject: (reason?: unknown) => void;
  #settled = false;

  public constructor() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    this.promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.promise.catch(() => undefined);
    this.#resolve = resolve;
    this.#reject = reject;
  }

  public resolve(value: T): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve(value);
  }

  public reject(reason: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#reject(reason);
  }
}

async function connectWithDeadline(
  connector: ExecutorHostControlConnector,
  pipe: HostControlPipeSelector,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Duplex> {
  const connectionCancellation = new AbortController();
  const connection = Promise.resolve().then(() => connector(pipe, connectionCancellation.signal));
  return await new Promise<Duplex>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = (): void => {
      finish(() => {
        connectionCancellation.abort();
        reject(
          executorError("CONNECT_CANCELLED", "Executor HostControl connection was cancelled."),
        );
      });
    };
    timer = setTimeout(() => {
      finish(() => {
        connectionCancellation.abort();
        reject(executorError("CONNECT_TIMEOUT", "Executor HostControl connection timed out."));
      });
    }, timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    void connection.then(
      (stream) => {
        if (settled) stream.destroy();
        else finish(() => resolve(stream));
      },
      () =>
        finish(() =>
          reject(executorError("CONNECT_FAILED", "Executor HostControl connection failed.")),
        ),
    );
  });
}

const defaultConnector: ExecutorHostControlConnector = async (pipe, cancellation) => {
  if (cancellation.aborted) {
    throw executorError("CONNECT_CANCELLED", "Executor HostControl connection was cancelled.");
  }
  return await new Promise<Duplex>((resolve, reject) => {
    const socket = createConnection({ path: pipe, allowHalfOpen: false });
    const onConnect = (): void => {
      cancellation.removeEventListener("abort", onAbort);
      resolve(socket);
    };
    const onError = (): void => {
      socket.removeListener("connect", onConnect);
      cancellation.removeEventListener("abort", onAbort);
      reject(executorError("CONNECT_FAILED", "Executor HostControl connection failed."));
    };
    const onAbort = (): void => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.destroy();
      reject(executorError("CONNECT_CANCELLED", "Executor HostControl connection was cancelled."));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    cancellation.addEventListener("abort", onAbort, { once: true });
  });
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumTimeoutMs) {
    throw new RangeError(
      `Executor HostControl timeout must be from 1 through ${maximumTimeoutMs}.`,
    );
  }
  return value;
}

function executorError(
  code: ExecutorHostControlError["code"],
  message: string,
): ExecutorHostControlError {
  return new ExecutorHostControlError(code, message);
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(1, deadline - performance.now());
}
