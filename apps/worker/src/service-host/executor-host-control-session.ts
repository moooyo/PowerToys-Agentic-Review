import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import {
  type ArmArwxShutdownResultV1,
  commitPreparedArmArwxShutdown,
  failPreparedArmArwxShutdown,
  type PreparedArmArwxShutdownV1,
  prepareArmArwxShutdown,
  readArmArwxShutdownDeadline,
  readPreparedArmArwxShutdown,
  validateArmArwxShutdownResult,
} from "./arwx-shutdown.js";
import type { ArwxFinalFrameReceipt } from "./arwx-stdio-channel.js";
import {
  encodeHostControlCall,
  HOST_CONTROL_MAXIMUM_ARM_ARWX_SHUTDOWN_BYTES,
  HostControlFrameDecoder,
  parseHostControlInbound,
} from "./host-control-protocol.js";
import type { HostControlSession, HostControlShutdownRequest } from "./host-control-session.js";
import { type HostControlPipeSelector, isHostControlPipeSelector } from "./launch-contract.js";
import type { ParsedRuntimeBootstrapV1 } from "./runtime-bootstrap.js";
import {
  type CompletedRuntimeBootstrap,
  performRuntimeBootstrapHandshake,
  RuntimeBootstrapHandshakeError,
  type RuntimeBootstrapPreparation,
} from "./runtime-bootstrap-handshake.js";

const defaultConnectTimeoutMs = 30_000;
const defaultCloseTimeoutMs = 15_000;
const maximumTimeoutMs = 10 * 60 * 1_000;
const executorHostControlSessions = new WeakSet<object>();

export type ExecutorHostControlConnector = (
  pipe: HostControlPipeSelector,
  cancellation: AbortSignal,
) => Promise<Duplex>;

export interface ExecutorHostControlOptions {
  readonly role: "executor";
  readonly pipe: HostControlPipeSelector;
  readonly prepareRuntimeBootstrap: RuntimeBootstrapPreparation<"executor">;
  readonly connectTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly connector?: ExecutorHostControlConnector;
}

export interface ExecutorHostControlSession extends HostControlSession<"executor"> {
  readonly role: "executor";
}

/** Recognizes only sessions created by the reviewed Executor connector. */
export function isExecutorHostControlSession(
  session: HostControlSession<"executor">,
): session is ExecutorHostControlSession {
  return executorHostControlSessions.has(session);
}

export class ExecutorHostControlError extends Error {
  public constructor(
    public readonly code:
      | "CLIENT_CLOSED"
      | "CLOSE_TIMEOUT"
      | "CONNECT_CANCELLED"
      | "CONNECT_FAILED"
      | "CONNECT_TIMEOUT"
      | "LIFECYCLE_STATE_INVALID"
      | "LIFECYCLE_TIMEOUT"
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
): Promise<ExecutorHostControlSession> {
  if (options.role !== "executor" || !isHostControlPipeSelector(options.pipe)) {
    throw new TypeError("Executor HostControl options are invalid.");
  }
  if (typeof options.prepareRuntimeBootstrap !== "function") {
    throw new TypeError("Executor runtime bootstrap preparation is required.");
  }
  const connectTimeoutMs = boundedTimeout(options.connectTimeoutMs ?? defaultConnectTimeoutMs);
  const closeTimeoutMs = boundedTimeout(options.closeTimeoutMs ?? defaultCloseTimeoutMs);
  if (signal?.aborted) {
    throw executorError("CONNECT_CANCELLED", "Executor HostControl connection was cancelled.");
  }
  const connector = options.connector ?? defaultConnector;
  const absoluteDeadline = performance.now() + connectTimeoutMs;
  const stream = await connectWithDeadline(connector, options.pipe, absoluteDeadline, signal);
  try {
    return await performRuntimeBootstrapHandshake(
      stream,
      "executor",
      options.prepareRuntimeBootstrap,
      absoluteDeadline,
      (completed) => new ExecutorHostControlSessionImpl(stream, closeTimeoutMs, completed),
      signal,
    );
  } catch (error) {
    if (error instanceof RuntimeBootstrapHandshakeError) {
      if (error.code === "BOOTSTRAP_CANCELLED") {
        throw executorError("CONNECT_CANCELLED", "Executor HostControl bootstrap was cancelled.");
      }
      if (error.code === "BOOTSTRAP_TIMEOUT") {
        throw executorError("CONNECT_TIMEOUT", "Executor HostControl bootstrap timed out.");
      }
      throw executorError("PROTOCOL_FAILURE", "Executor HostControl bootstrap failed.");
    }
    throw error;
  }
}

class ExecutorHostControlSessionImpl implements ExecutorHostControlSession {
  public readonly role = "executor" as const;
  public readonly bootstrap: Readonly<ParsedRuntimeBootstrapV1>;
  readonly #closed = new Deferred<void>();
  readonly #failure = new Deferred<never>();
  readonly #writableHalfClosed = new Deferred<void>();
  readonly #done = Promise.race([this.#closed.promise, this.#failure.promise]);
  readonly #shutdownRequested = new Deferred<Readonly<HostControlShutdownRequest<"executor">>>();
  readonly #decoder = new HostControlFrameDecoder(HOST_CONTROL_MAXIMUM_ARM_ARWX_SHUTDOWN_BYTES);
  readonly #runtimeBootstrap: Readonly<CompletedRuntimeBootstrap<"executor">>;
  #terminalError: ExecutorHostControlError | undefined;
  #state: "open" | "arming" | "armed" | "draining" | "closing" | "closed" | "failed" = "open";
  #readableEndObserved = false;
  #writableHalfCloseObserved = false;
  #transportCloseObserved = false;
  #armPending:
    | {
        readonly id: string;
        readonly prepared: PreparedArmArwxShutdownV1;
        readonly request: ReturnType<typeof readPreparedArmArwxShutdown>["request"];
        readonly deferred: Deferred<Readonly<ArmArwxShutdownResultV1>>;
        readonly timeout: NodeJS.Timeout;
      }
    | undefined;
  #shutdownDeadline: number | undefined;
  #drainPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  public get done(): Promise<void> {
    return this.#done;
  }

  public get shutdownRequested(): Promise<Readonly<HostControlShutdownRequest<"executor">>> {
    return this.#shutdownRequested.promise;
  }

  public constructor(
    private readonly stream: Duplex,
    private readonly closeTimeoutMs: number,
    runtimeBootstrap: Readonly<CompletedRuntimeBootstrap<"executor">>,
  ) {
    this.#runtimeBootstrap = runtimeBootstrap;
    this.bootstrap = runtimeBootstrap.parsed;
    executorHostControlSessions.add(this);
    void this.#done.then(undefined, () => undefined);
    stream.on("data", (chunk: Buffer | string) => {
      this.#onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });
    stream.once("error", () => {
      this.#fail(executorError("PROTOCOL_FAILURE", "Executor HostControl stream failed."));
    });
    stream.once("end", () => {
      try {
        this.#decoder.end();
      } catch {
        this.#fail(
          executorError("PROTOCOL_FAILURE", "Executor HostControl response ended partially."),
        );
        return;
      }
      if (
        this.#shutdownDeadline !== undefined &&
        (this.#state === "armed" || this.#state === "draining") &&
        performance.now() >= this.#shutdownDeadline
      ) {
        this.#fail(
          executorError(
            "LIFECYCLE_TIMEOUT",
            "Executor HostControl shutdown EOF missed its deadline.",
          ),
        );
        return;
      }
      this.#readableEndObserved = true;
      if (this.#state !== "armed" && this.#state !== "draining" && this.#state !== "closing") {
        this.#fail(
          executorError("PROTOCOL_FAILURE", "Executor HostControl peer closed unexpectedly."),
        );
      }
    });
    stream.once("close", () => {
      this.#transportCloseObserved = true;
      if (
        this.#shutdownDeadline !== undefined &&
        (this.#state === "armed" || this.#state === "draining") &&
        performance.now() >= this.#shutdownDeadline
      ) {
        this.#fail(
          executorError(
            "LIFECYCLE_TIMEOUT",
            "Executor HostControl shutdown close missed its deadline.",
          ),
          false,
        );
      }
      if (!this.#readableEndObserved && this.#state !== "failed" && this.#state !== "closing") {
        this.#fail(
          executorError("PROTOCOL_FAILURE", "Executor HostControl peer closed unexpectedly."),
          false,
        );
      }
      if (
        (this.#state === "armed" || this.#state === "draining") &&
        !this.#writableHalfCloseObserved
      ) {
        this.#fail(
          executorError(
            "PROTOCOL_FAILURE",
            "Executor HostControl closed before writable shutdown authority settled.",
          ),
          false,
        );
      }
      this.#tryFinalizeClose();
    });
  }

  public drain(absoluteDeadline?: number): Promise<void> {
    this.#drainPromise ??= this.#drain(
      selectShutdownDeadline(absoluteDeadline, this.#shutdownDeadline, this.closeTimeoutMs),
    );
    return this.#drainPromise;
  }

  public close(absoluteDeadline?: number): Promise<void> {
    this.#closePromise ??= this.#close(
      selectShutdownDeadline(absoluteDeadline, this.#shutdownDeadline, this.closeTimeoutMs),
    );
    return this.#closePromise;
  }

  public async armArwxShutdown(
    receipt: ArwxFinalFrameReceipt,
  ): Promise<Readonly<ArmArwxShutdownResultV1>> {
    const shutdownDeadline = readArmArwxShutdownDeadline(this.#runtimeBootstrap, receipt);
    if (shutdownDeadline !== undefined) this.#shutdownDeadline = shutdownDeadline;
    if (this.#state !== "open" || this.#armPending !== undefined) {
      const error = executorError(
        "LIFECYCLE_STATE_INVALID",
        "Executor HostControl cannot arm ARWX shutdown in its current state.",
      );
      this.#fail(error);
      throw error;
    }
    let prepared: PreparedArmArwxShutdownV1;
    try {
      prepared = prepareArmArwxShutdown(this.#runtimeBootstrap, receipt);
    } catch {
      const error = executorError(
        "LIFECYCLE_STATE_INVALID",
        "Executor ARWX shutdown authority is invalid.",
      );
      this.#fail(error);
      throw error;
    }
    const details = readPreparedArmArwxShutdown(prepared);
    this.#shutdownDeadline = details.absoluteDeadline;
    const requestId = `shutdown:${randomUUID()}`;
    let frame: Buffer;
    let timeoutMs: number;
    try {
      frame = encodeHostControlCall("ArmArwxShutdown", requestId, details.request);
      timeoutMs = remainingShutdownMilliseconds(details.absoluteDeadline);
    } catch {
      failPreparedArmArwxShutdown(prepared);
      const error = executorError(
        "LIFECYCLE_TIMEOUT",
        "Executor ARWX shutdown deadline expired before the Arm request.",
      );
      this.#fail(error);
      throw error;
    }
    const deferred = new Deferred<Readonly<ArmArwxShutdownResultV1>>();
    const timeout = setTimeout(() => {
      this.#fail(executorError("LIFECYCLE_TIMEOUT", "Executor ARWX shutdown arm timed out."));
    }, timeoutMs);
    timeout.unref();
    this.#armPending = { id: requestId, prepared, request: details.request, deferred, timeout };
    this.#state = "arming";
    try {
      streamWrite(this.stream, frame).catch(() => {
        this.#fail(executorError("PROTOCOL_FAILURE", "Executor ARWX shutdown write failed."));
      });
    } catch {
      this.#fail(executorError("PROTOCOL_FAILURE", "Executor ARWX shutdown write failed."));
    }
    return await deferred.promise;
  }

  #onData(chunk: Buffer): void {
    if (this.#state === "closed" || this.#state === "failed") return;
    if (this.#state !== "arming" || this.#armPending === undefined) {
      this.#fail(
        executorError("PROTOCOL_FAILURE", "Executor HostControl received unsolicited bytes."),
      );
      return;
    }
    try {
      for (const document of this.#decoder.push(chunk)) {
        const inbound = parseHostControlInbound(document);
        if (inbound.type === "notification") {
          throw new Error("Executor HostControl received a Control-only notification.");
        }
        const pending = this.#armPending;
        if (this.#state !== "arming" || pending === undefined) {
          throw new Error("Executor HostControl received an unsolicited response.");
        }
        const response = inbound;
        if (response.requestId !== pending.id || response.outcome !== "ok") {
          throw new Error("Executor HostControl Arm response is invalid.");
        }
        const deadline = this.#shutdownDeadline;
        if (deadline === undefined || performance.now() >= deadline) {
          throw new Error("Executor HostControl Arm response missed its deadline.");
        }
        const result = validateArmArwxShutdownResult(response.body, pending.request);
        commitPreparedArmArwxShutdown(pending.prepared);
        this.#state = "armed";
        const draining = this.drain();
        draining.catch(() => undefined);
        if (this.#terminalError !== undefined) throw this.#terminalError;
        void Promise.race([this.#writableHalfClosed.promise, this.#failure.promise]).then(
          () => {
            if (this.#terminalError !== undefined || this.#armPending !== pending) return;
            const deadline = this.#shutdownDeadline;
            if (deadline === undefined || performance.now() >= deadline) {
              this.#fail(
                executorError(
                  "LIFECYCLE_TIMEOUT",
                  "Executor ARWX shutdown arm missed its final settlement deadline.",
                ),
              );
              return;
            }
            clearTimeout(pending.timeout);
            this.#armPending = undefined;
            pending.deferred.resolve(result);
            this.#tryFinalizeClose();
          },
          () => undefined,
        );
      }
    } catch {
      this.#fail(executorError("PROTOCOL_FAILURE", "Executor HostControl Arm response failed."));
    }
  }

  #endWritable(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const rejectHalfClose = (): void => {
        const error = executorError(
          "PROTOCOL_FAILURE",
          "Executor HostControl writable half-close callback failed.",
        );
        this.#fail(error);
        reject(error);
      };
      try {
        this.stream.end((error?: Error | null) => {
          if (error !== undefined && error !== null) {
            rejectHalfClose();
            return;
          }
          this.#writableHalfCloseObserved = true;
          this.#writableHalfClosed.resolve(undefined);
          resolve();
        });
      } catch {
        rejectHalfClose();
      }
    });
  }

  async #drain(deadline: number): Promise<void> {
    if (this.#state === "closed") {
      remainingShutdownMilliseconds(deadline);
      return;
    }
    if (this.#state === "failed") throw this.#terminalError;
    if (this.#state === "closing") return this.close(deadline);
    if (this.#state === "arming") {
      const error = executorError(
        "LIFECYCLE_STATE_INVALID",
        "Executor HostControl cannot drain while ARWX shutdown is arming.",
      );
      this.#fail(error);
      throw error;
    }
    this.#state = "draining";
    try {
      await this.#awaitDrainPhase(() => this.#endWritable(), deadline);
      await this.#awaitDrainPhase(() => this.#closed.promise, deadline);
      if (this.#terminalError !== undefined) throw this.#terminalError;
    } catch {
      if (this.#terminalError !== undefined) throw this.#terminalError;
      const error = executorError("CLOSE_TIMEOUT", "Executor HostControl drain timed out.");
      this.#fail(error);
      throw error;
    }
  }

  async #close(deadline: number): Promise<void> {
    if (this.#state === "closed") {
      remainingShutdownMilliseconds(deadline);
      return;
    }
    if (this.#state === "draining") {
      this.#fail(
        executorError("CLIENT_CLOSED", "Executor HostControl drain was interrupted by close."),
      );
    } else if (this.#state === "arming") {
      this.#fail(
        executorError("CLIENT_CLOSED", "Executor HostControl Arm was interrupted by close."),
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
      await withTimeout(this.#closed.promise, remainingShutdownMilliseconds(deadline));
      remainingShutdownMilliseconds(deadline);
    } catch {
      throw executorError("CLOSE_TIMEOUT", "Executor HostControl stream did not close in time.");
    }
  }

  #fail(error: ExecutorHostControlError, destroy = true): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    this.#state = "failed";
    this.#terminalError = error;
    const pending = this.#armPending;
    this.#armPending = undefined;
    if (pending !== undefined) {
      clearTimeout(pending.timeout);
      failPreparedArmArwxShutdown(pending.prepared);
      pending.deferred.reject(error);
    }
    this.#failure.reject(error);
    this.#shutdownRequested.reject(error);
    this.#tryFinalizeClose();
    if (destroy) {
      try {
        this.stream.destroy();
      } catch {
        // The terminal state is already committed.
      }
    }
  }

  async #awaitDrainPhase<T>(createPhase: () => Promise<T>, deadline: number): Promise<T> {
    const timeoutMs = remainingShutdownMilliseconds(deadline);
    const phase = createPhase();
    const result = await withTimeout(Promise.race([phase, this.#failure.promise]), timeoutMs);
    remainingShutdownMilliseconds(deadline);
    return result;
  }

  #tryFinalizeClose(): void {
    if (!this.#transportCloseObserved) return;
    if (this.#state === "failed") {
      this.#closed.resolve(undefined);
      return;
    }
    if (this.#armPending !== undefined) return;
    if (
      this.#state !== "closing" &&
      (!this.#readableEndObserved ||
        !this.#writableHalfCloseObserved ||
        (this.#state !== "armed" && this.#state !== "draining"))
    ) {
      return;
    }
    this.#state = "closed";
    this.#closed.resolve(undefined);
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
  absoluteDeadline: number,
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
    }, remainingMilliseconds(absoluteDeadline));
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

function selectShutdownDeadline(
  requested: number | undefined,
  protocolDeadline: number | undefined,
  configuredTimeoutMs: number,
): number {
  if (requested !== undefined && !Number.isFinite(requested)) {
    throw new TypeError("Executor HostControl shutdown deadline must be finite.");
  }
  return Math.min(
    requested ?? Number.POSITIVE_INFINITY,
    protocolDeadline ?? Number.POSITIVE_INFINITY,
    performance.now() + configuredTimeoutMs,
  );
}

function remainingShutdownMilliseconds(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) {
    throw executorError("LIFECYCLE_TIMEOUT", "Executor ARWX shutdown deadline expired.");
  }
  return remaining;
}

function streamWrite(stream: Duplex, frame: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      stream.write(frame, (error?: Error | null) => {
        if (error !== undefined && error !== null) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}
