import type { Readable } from "node:stream";
import { types } from "node:util";
import { parseModelProtocolJson } from "./model-response-observer.js";
import type {
  ManagedProcess,
  ManagedProcessStandardInput,
  ProcessExitedEvent,
  ProcessTerminationReason,
} from "./process-host-protocol.js";

export const codexAppServerMethods = [
  "initialize",
  "config/read",
  "configRequirements/read",
  "permissionProfile/list",
  "windowsSandbox/readiness",
  "thread/start",
  "experimentalFeature/list",
  "turn/start",
  "turn/interrupt",
  "thread/unsubscribe",
] as const;
export type CodexAppServerMethod = (typeof codexAppServerMethods)[number];
const allowedMethods = new Set<string>(codexAppServerMethods);

export const codexAppServerTransportLimits = Object.freeze({
  maximumFrameBytes: 8 * 1024 * 1024,
  maximumInputBytes: 8 * 1024 * 1024,
  maximumWriteOperations: 1023,
  maximumStdoutBytes: 32 * 1024 * 1024,
  maximumStderrBytes: 1024 * 1024,
  maximumPendingRequests: 8,
  maximumQueuedNotifications: 64,
  maximumQueuedNotificationBytes: 8 * 1024 * 1024,
  maximumNotifications: 10_000,
  requestTimeoutMs: 30_000,
  pipeTimeoutMs: 15_000,
  notificationTimeoutMs: 5000,
  closeGraceMs: 5000,
  forceDrainTimeoutMs: 30_000,
});
export type CodexAppServerTransportLimits = {
  -readonly [Key in keyof typeof codexAppServerTransportLimits]: number;
};
export type CodexAppServerTransportErrorCode =
  | "INVALID_OPTIONS"
  | "UNSUPPORTED_METHOD"
  | "INVALID_REQUEST"
  | "INVALID_PHASE"
  | "LIMIT_EXCEEDED"
  | "WRITE_FAILED"
  | "WRITE_TIMEOUT"
  | "REQUEST_TIMEOUT"
  | "REQUEST_CANCELLED"
  | "REMOTE_ERROR"
  | "INVALID_UTF8"
  | "INVALID_FRAME"
  | "UNKNOWN_RESPONSE"
  | "SERVER_REQUEST_UNSUPPORTED"
  | "NOTIFICATION_FAILED"
  | "NOTIFICATION_TIMEOUT"
  | "ACTIVITY_OBSERVER_FAILED"
  | "UNEXPECTED_EOF"
  | "PROCESS_EXITED"
  | "STREAM_FAILED"
  | "OUTPUT_TRUNCATED"
  | "CLOSED"
  | "CANCELLED"
  | "CLEANUP_UNCONFIRMED";

export class CodexAppServerTransportError extends Error {
  constructor(
    readonly code: CodexAppServerTransportErrorCode,
    readonly remoteCode?: number,
  ) {
    super("The bounded Codex app-server transport could not complete its operation.");
    this.name = "CodexAppServerTransportError";
  }
}
export interface CodexAppServerNotification {
  readonly method: string;
  readonly params?: unknown;
  /** Untrusted server metadata; never a local clock or policy assertion. */
  readonly emittedAtMs?: number;
}
export interface CodexAppServerTransportOptions {
  readonly process: ManagedProcess;
  readonly signal?: AbortSignal;
  /** Synchronous progress pulse for actual stdout/stderr bytes, including RPC responses. */
  readonly onActivity?: () => void;
  readonly onNotification?: (
    notification: CodexAppServerNotification,
    signal: AbortSignal,
  ) => void | Promise<void>;
  /** Overrides may only lower the fixed production bounds. */
  readonly limits?: Partial<CodexAppServerTransportLimits>;
}
export interface CodexAppServerRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface CodexAppServerTransportCloseResult {
  readonly outcome: "closed" | "aborted" | "failed";
  readonly failureCode: CodexAppServerTransportErrorCode | null;
  readonly processRequestId: string;
  readonly processId: number;
  readonly stdinStreamId: string;
  readonly exit: ProcessExitedEvent;
  readonly stdoutEnded: boolean;
  readonly stderrEnded: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly frameCount: number;
  readonly notificationCount: number;
  readonly notificationDeliveryComplete: boolean;
}
export interface CodexAppServerTransport {
  /** Resolves only after confirmed process completion and both output streams settle. */
  readonly completed: Promise<CodexAppServerTransportCloseResult>;
  request(
    method: CodexAppServerMethod,
    params?: unknown,
    options?: number | CodexAppServerRequestOptions,
  ): Promise<unknown>;
  notifyInitialized(): Promise<void>;
  close(): Promise<CodexAppServerTransportCloseResult>;
  abort(reason?: ProcessTerminationReason): Promise<CodexAppServerTransportCloseResult>;
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Lifecycle errors can precede the owner's await; they remain observable on this promise.
    void this.promise.catch(() => undefined);
  }
}
type Pending = {
  id: string;
  method: CodexAppServerMethod;
  deferred: Deferred<unknown>;
  written: boolean;
  responseEligible: boolean;
  response?: { result: unknown } | { error: CodexAppServerTransportError };
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
};
type WriteFrame = { bytes: Buffer; pending?: Pending; notification?: Deferred<void> };

function error(code: CodexAppServerTransportErrorCode): CodexAppServerTransportError {
  return new CodexAppServerTransportError(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function own(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}
function onlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function configuredLimits(
  overrides: Partial<CodexAppServerTransportLimits> | undefined,
): CodexAppServerTransportLimits {
  const result: CodexAppServerTransportLimits = { ...codexAppServerTransportLimits };
  if (overrides !== undefined) {
    if (types.isProxy(overrides) || !record(overrides)) throw error("INVALID_OPTIONS");
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(overrides))) {
      if (!own(result, name) || !("value" in descriptor)) throw error("INVALID_OPTIONS");
      const key = name as keyof CodexAppServerTransportLimits;
      const value: unknown = descriptor.value;
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > codexAppServerTransportLimits[key]
      )
        throw error("INVALID_OPTIONS");
      result[key] = value;
    }
  }
  return Object.freeze(result);
}

/** Serializes descriptor values without invoking getters, inherited toJSON, or custom iterators. */
function snapshotParams(value: unknown, maximum: number): string {
  const parts: string[] = [];
  const parents = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const append = (text: string) => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maximum) throw error("LIMIT_EXCEEDED");
    parts.push(text);
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 64) throw error("INVALID_REQUEST");
    if (item === null || typeof item === "boolean") {
      append(String(item));
      return;
    }
    if (typeof item === "string") {
      if (!item.isWellFormed()) throw error("INVALID_REQUEST");
      append(JSON.stringify(item));
      return;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      append(JSON.stringify(item));
      return;
    }
    if (typeof item !== "object" || item === null || parents.has(item))
      throw error("INVALID_REQUEST");
    if (types.isProxy(item)) throw error("INVALID_REQUEST");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (
      (array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(item).length > 0
    )
      throw error("INVALID_REQUEST");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const entries = Object.entries(descriptors).filter(([key]) => !array || key !== "length");
    if (
      entries.length > 100_000 ||
      (array &&
        (entries.length !== item.length || entries.some(([key], index) => key !== String(index))))
    )
      throw error("INVALID_REQUEST");
    parents.add(item);
    append(array ? "[" : "{");
    entries.forEach(([key, descriptor], index) => {
      if (!descriptor.enumerable || !("value" in descriptor) || !key.isWellFormed())
        throw error("INVALID_REQUEST");
      if (index) append(",");
      if (!array) {
        append(JSON.stringify(key));
        append(":");
      }
      visit(descriptor.value, depth + 1);
    });
    append(array ? "]" : "}");
    parents.delete(item);
  };
  visit(value, 0);
  return parts.join("");
}
function freezeJson(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

/** Attaches to one already-owned process. It never launches a CLI or accepts a policy. */
export function createCodexAppServerTransport(
  options: CodexAppServerTransportOptions,
): CodexAppServerTransport {
  return new StdioCodexAppServerTransport(options);
}

class StdioCodexAppServerTransport implements CodexAppServerTransport {
  readonly completed: Promise<CodexAppServerTransportCloseResult>;
  readonly #done = new Deferred<CodexAppServerTransportCloseResult>();
  readonly #terminateProcess: ManagedProcess["terminate"];
  readonly #stdin: ManagedProcessStandardInput;
  readonly #processRequestId: string;
  readonly #processId: number;
  readonly #streamId: string;
  readonly #limits: CodexAppServerTransportLimits;
  readonly #onNotification: CodexAppServerTransportOptions["onNotification"];
  readonly #controller = new AbortController();
  readonly #parentSignal: AbortSignal | undefined;
  readonly #parentAbort = () => {
    void this.abort();
  };
  readonly #pending = new Map<string, Pending>();
  readonly #writes: WriteFrame[] = [];
  readonly #notifications: { notification: CodexAppServerNotification; bytes: number }[] = [];
  #phase: "new" | "initializing" | "initialize_ready" | "notifying" | "ready" = "new";
  #closing = false;
  #settled = false;
  #failure: CodexAppServerTransportError | undefined;
  #aborted = false;
  #writerBusy = false;
  #writerIdle: Promise<void> = Promise.resolve();
  #eofBusy = false;
  #notifierBusy = false;
  #terminationStarted = false;
  #exit: ProcessExitedEvent | undefined;
  #processRejected = false;
  #stdoutDone = false;
  #stderrDone = false;
  #stdoutEnded = false;
  #stderrEnded = false;
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #frameCount = 0;
  #notificationCount = 0;
  #notificationBytes = 0;
  #notificationPending = 0;
  #notificationDeliveryComplete = true;
  #inputBytes = 0;
  #writeOperations = 0;
  #nextId = 0;
  #line: Buffer;
  #lineBytes = 0;
  #graceTimer: NodeJS.Timeout | undefined;
  #streamDrainTimer: NodeJS.Timeout | undefined;
  #forceTimer: NodeJS.Timeout | undefined;

  constructor(options: CodexAppServerTransportOptions) {
    this.#limits = configuredLimits(options.limits);
    const managed = options.process;
    const stdin = managed.stdin;
    if (
      !stdin ||
      !/^[a-f0-9]{64}$/u.test(stdin.streamId) ||
      typeof stdin.write !== "function" ||
      typeof stdin.close !== "function" ||
      typeof managed.terminate !== "function" ||
      !Number.isSafeInteger(managed.processId) ||
      managed.processId < 1 ||
      typeof managed.requestId !== "string" ||
      !managed.requestId ||
      (options.onNotification !== undefined && typeof options.onNotification !== "function") ||
      (options.onActivity !== undefined && typeof options.onActivity !== "function")
    )
      throw error("INVALID_OPTIONS");
    this.#terminateProcess = managed.terminate.bind(managed);
    this.#stdin = Object.freeze({
      streamId: stdin.streamId,
      write: stdin.write.bind(stdin),
      close: stdin.close.bind(stdin),
    });
    this.#processRequestId = managed.requestId;
    this.#processId = managed.processId;
    this.#streamId = stdin.streamId;
    this.#onNotification = options.onNotification;
    this.#parentSignal = options.signal;
    this.#line = Buffer.allocUnsafe(Math.min(4096, this.#limits.maximumFrameBytes));
    this.completed = this.#done.promise;
    this.#attach(managed.stdout, true, options.onActivity);
    this.#attach(managed.stderr, false, options.onActivity);
    void managed.completed.then(
      (event) => {
        if (event.requestId !== this.#processRequestId) {
          this.#processRejected = true;
          this.#fail("PROCESS_EXITED");
        } else {
          this.#exit = Object.freeze({ ...event });
          if (this.#graceTimer) clearTimeout(this.#graceTimer);
          this.#graceTimer = undefined;
          if (!this.#settled && (!this.#stdoutDone || !this.#stderrDone)) {
            this.#streamDrainTimer = setTimeout(() => {
              if (!this.#stdoutDone || !this.#stderrDone) {
                this.#fail("STREAM_FAILED");
                this.#cleanupUnconfirmed();
              }
            }, this.#limits.forceDrainTimeoutMs);
          }
          if (!this.#closing || event.exitCode !== 0 || event.signal !== null)
            this.#fail("PROCESS_EXITED");
          if (event.outputTruncated) this.#fail("OUTPUT_TRUNCATED");
        }
        this.#maybeComplete();
      },
      () => {
        this.#processRejected = true;
        this.#fail("PROCESS_EXITED");
        this.#maybeComplete();
      },
    );
    this.#parentSignal?.addEventListener("abort", this.#parentAbort, { once: true });
    if (this.#parentSignal?.aborted) this.#parentAbort();
  }

  request(
    method: CodexAppServerMethod,
    params?: unknown,
    options?: number | CodexAppServerRequestOptions,
  ): Promise<unknown> {
    try {
      if (!allowedMethods.has(method)) throw error("UNSUPPORTED_METHOD");
      this.#assertOpen();
      if (method === "initialize" ? this.#phase !== "new" : this.#phase !== "ready")
        throw error("INVALID_PHASE");
      const timeoutMs =
        typeof options === "number"
          ? options
          : (options?.timeoutMs ?? this.#limits.requestTimeoutMs);
      const signal = typeof options === "number" ? undefined : options?.signal;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > this.#limits.requestTimeoutMs
      )
        throw error("INVALID_OPTIONS");
      if (signal?.aborted) throw error("REQUEST_CANCELLED");
      if (this.#pending.size >= this.#limits.maximumPendingRequests) throw error("LIMIT_EXCEEDED");
      if (params !== undefined && params !== null && !record(params))
        throw error("INVALID_REQUEST");
      const serializedParams =
        params === undefined
          ? ""
          : `,"params":${snapshotParams(params, this.#limits.maximumFrameBytes)}`;
      const id = `rpc:${++this.#nextId}`;
      const bytes = Buffer.from(
        `{"id":${JSON.stringify(id)},"method":${JSON.stringify(method)}${serializedParams}}\n`,
        "utf8",
      );
      this.#reserve(bytes);
      const pending: Pending = {
        id,
        method,
        deferred: new Deferred<unknown>(),
        written: false,
        responseEligible: false,
      };
      pending.timer = setTimeout(() => this.#fail("REQUEST_TIMEOUT"), timeoutMs);
      if (signal) {
        pending.signal = signal;
        pending.abort = () => this.#fail("REQUEST_CANCELLED", "cancelled", true);
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.#pending.set(id, pending);
      if (method === "initialize") this.#phase = "initializing";
      this.#writes.push({ bytes, pending });
      this.#startWriter();
      return pending.deferred.promise;
    } catch (cause) {
      return Promise.reject(
        cause instanceof CodexAppServerTransportError ? cause : error("INVALID_REQUEST"),
      );
    }
  }

  notifyInitialized(): Promise<void> {
    try {
      this.#assertOpen();
      if (this.#phase !== "initialize_ready") throw error("INVALID_PHASE");
      const bytes = Buffer.from('{"method":"initialized"}\n', "utf8");
      this.#reserve(bytes);
      const notification = new Deferred<void>();
      this.#phase = "notifying";
      this.#writes.push({ bytes, notification });
      this.#startWriter();
      return notification.promise;
    } catch (cause) {
      return Promise.reject(
        cause instanceof CodexAppServerTransportError ? cause : error("INVALID_REQUEST"),
      );
    }
  }

  close(): Promise<CodexAppServerTransportCloseResult> {
    if (this.#closing || this.#settled) return this.completed;
    this.#closing = true;
    if (this.#pending.size || this.#writes.length || this.#phase === "notifying") {
      this.#fail("CLOSED", "cancelled", true);
      return this.completed;
    }
    this.#eofBusy = true;
    void this.#bounded(
      async () => {
        await this.#writerIdle;
        if (this.#controller.signal.aborted) throw this.#failure ?? error("CANCELLED");
        await this.#stdin.close(this.#controller.signal);
      },
      this.#limits.pipeTimeoutMs,
      "WRITE_TIMEOUT",
    )
      .then(
        () => {
          if (!this.#failure && !this.#settled && !this.#exit) {
            this.#graceTimer = setTimeout(() => {
              if (!this.#exit) this.#fail("PROCESS_EXITED");
            }, this.#limits.closeGraceMs);
          }
        },
        (cause: unknown) =>
          this.#fail(cause instanceof CodexAppServerTransportError ? cause.code : "WRITE_FAILED"),
      )
      .finally(() => {
        this.#eofBusy = false;
        this.#maybeComplete();
      });
    return this.completed;
  }

  abort(
    reason: ProcessTerminationReason = "cancelled",
  ): Promise<CodexAppServerTransportCloseResult> {
    if (!this.#settled) this.#fail("CANCELLED", reason, true);
    return this.completed;
  }

  #assertOpen(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closing || this.#settled) throw error("CLOSED");
  }
  #reserve(bytes: Buffer): void {
    const operations = Math.ceil(bytes.length / 65_536);
    if (
      bytes.length - 1 > this.#limits.maximumFrameBytes ||
      this.#inputBytes + bytes.length > this.#limits.maximumInputBytes ||
      this.#writeOperations + operations > this.#limits.maximumWriteOperations
    )
      throw error("LIMIT_EXCEEDED");
    this.#inputBytes += bytes.length;
    this.#writeOperations += operations;
  }
  #startWriter(): void {
    if (this.#writerBusy || this.#failure) return;
    this.#writerBusy = true;
    const idle = new Deferred<void>();
    this.#writerIdle = idle.promise;
    void (async () => {
      try {
        while (!this.#failure) {
          const frame = this.#writes.shift();
          if (!frame) break;
          try {
            for (let offset = 0; offset < frame.bytes.length; offset += 65_536) {
              if (this.#failure) throw this.#failure;
              const chunk = Uint8Array.from(frame.bytes.subarray(offset, offset + 65_536));
              await this.#bounded(
                () => {
                  // A response can race ahead of the final write ACK, but not its submission.
                  if (frame.pending && offset + chunk.length === frame.bytes.length)
                    frame.pending.responseEligible = true;
                  return this.#stdin.write(chunk, this.#controller.signal);
                },
                this.#limits.pipeTimeoutMs,
                "WRITE_TIMEOUT",
              );
            }
            if (this.#failure) throw this.#failure;
            if (frame.pending) {
              frame.pending.written = true;
              this.#settlePending(frame.pending);
            }
            if (frame.notification) {
              this.#phase = "ready";
              frame.notification.resolve();
            }
          } catch (cause) {
            this.#fail(cause instanceof CodexAppServerTransportError ? cause.code : "WRITE_FAILED");
            frame.notification?.reject(this.#failure ?? error("WRITE_FAILED"));
          }
        }
      } finally {
        // Hand off ownership in the same microtask that observes the queue empty.
        this.#writerBusy = false;
        idle.resolve();
        this.#maybeComplete();
      }
    })();
  }
  async #bounded<T>(
    run: () => T | Promise<T>,
    milliseconds: number,
    code: CodexAppServerTransportErrorCode,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (this.#controller.signal.aborted) throw this.#failure ?? error("CANCELLED");
          return run();
        }),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(this.#failure ?? error("CANCELLED"));
          this.#controller.signal.addEventListener("abort", onAbort, { once: true });
          if (this.#controller.signal.aborted) onAbort();
          timer = setTimeout(() => reject(error(code)), milliseconds);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) this.#controller.signal.removeEventListener("abort", onAbort);
    }
  }

  #attach(stream: Readable, stdout: boolean, onActivity?: () => void): void {
    stream.on("data", (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array)) {
        this.#fail("STREAM_FAILED");
        return;
      }
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (stdout) this.#stdoutBytes += bytes.length;
      else this.#stderrBytes += bytes.length;
      if (
        this.#stdoutBytes > this.#limits.maximumStdoutBytes ||
        this.#stderrBytes > this.#limits.maximumStderrBytes
      )
        this.#fail("LIMIT_EXCEEDED");
      if (bytes.length > 0 && !this.#failure && !this.#settled && onActivity) {
        try {
          const returned = onActivity();
          if (returned !== undefined) {
            // An accidental async observer cannot leave an unhandled rejection behind.
            void Promise.resolve(returned).catch(() => undefined);
            this.#fail("ACTIVITY_OBSERVER_FAILED");
          }
        } catch {
          this.#fail("ACTIVITY_OBSERVER_FAILED");
        }
      }
      if (stdout && !this.#failure && !this.#settled) this.#stdout(bytes);
    });
    stream.once("error", () => this.#fail("STREAM_FAILED"));
    stream.once("end", () => {
      if (stdout) {
        this.#stdoutEnded = true;
        this.#stdoutDone = true;
        if (this.#lineBytes) this.#fail("INVALID_FRAME");
        else if (!this.#closing) this.#fail("UNEXPECTED_EOF");
      } else {
        this.#stderrEnded = true;
        this.#stderrDone = true;
      }
      this.#maybeComplete();
    });
    stream.once("close", () => {
      if (stdout) {
        this.#stdoutDone = true;
        if (!this.#stdoutEnded) this.#fail("STREAM_FAILED");
      } else {
        this.#stderrDone = true;
        if (!this.#stderrEnded) this.#fail("STREAM_FAILED");
      }
      this.#maybeComplete();
    });
    // These are dedicated owned output streams; keep draining even after a transport failure.
    stream.resume();
    if (stream.readableEnded || stream.destroyed) {
      if (stdout) {
        this.#stdoutDone = true;
        this.#stdoutEnded = stream.readableEnded;
      } else {
        this.#stderrDone = true;
        this.#stderrEnded = stream.readableEnded;
      }
      this.#fail("UNEXPECTED_EOF");
    }
  }
  #stdout(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length && !this.#failure) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      const segment = bytes.subarray(offset, end);
      const required = this.#lineBytes + segment.length;
      if (required > this.#limits.maximumFrameBytes) {
        this.#fail("LIMIT_EXCEEDED");
        return;
      }
      if (required > this.#line.length) {
        const next = Buffer.allocUnsafe(
          Math.min(this.#limits.maximumFrameBytes, Math.max(required, this.#line.length * 2)),
        );
        this.#line.copy(next, 0, 0, this.#lineBytes);
        this.#line = next;
      }
      segment.copy(this.#line, this.#lineBytes);
      this.#lineBytes = required;
      if (newline < 0) return;
      const frameBytes = this.#lineBytes;
      const frame = this.#line.subarray(0, frameBytes);
      this.#lineBytes = 0;
      this.#frame(frame, frameBytes);
      offset = newline + 1;
    }
  }
  #frame(bytes: Buffer, frameBytes: number): void {
    this.#frameCount += 1;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      this.#fail("INVALID_UTF8");
      return;
    }
    let value: unknown;
    try {
      value = parseModelProtocolJson(text);
    } catch {
      this.#fail("INVALID_FRAME");
      return;
    }
    if (!record(value) || (own(value, "jsonrpc") && value.jsonrpc !== "2.0")) {
      this.#fail("INVALID_FRAME");
      return;
    }
    if (own(value, "method")) {
      if (own(value, "id")) {
        this.#fail("SERVER_REQUEST_UNSUPPORTED");
        return;
      }
      if (
        !onlyKeys(value, ["method", "params", "jsonrpc", "emittedAtMs"]) ||
        typeof value.method !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_./-]{0,127}$/u.test(value.method) ||
        (own(value, "emittedAtMs") &&
          (typeof value.emittedAtMs !== "number" ||
            !Number.isSafeInteger(value.emittedAtMs) ||
            value.emittedAtMs < 0))
      ) {
        this.#fail("INVALID_FRAME");
        return;
      }
      this.#queueNotification(value, frameBytes);
      return;
    }
    if (
      !onlyKeys(value, ["id", "result", "error", "jsonrpc"]) ||
      typeof value.id !== "string" ||
      own(value, "result") === own(value, "error")
    ) {
      this.#fail("INVALID_FRAME");
      return;
    }
    const pending = this.#pending.get(value.id);
    if (!pending?.responseEligible || pending.response) {
      this.#fail("UNKNOWN_RESPONSE");
      return;
    }
    if (own(value, "error")) {
      const remote = value.error;
      if (
        !record(remote) ||
        !onlyKeys(remote, ["code", "message", "data"]) ||
        !Number.isSafeInteger(remote.code) ||
        typeof remote.message !== "string"
      ) {
        this.#fail("INVALID_FRAME");
        return;
      }
      pending.response = {
        error: new CodexAppServerTransportError("REMOTE_ERROR", remote.code as number),
      };
    } else {
      freezeJson(value.result);
      pending.response = { result: value.result };
    }
    this.#settlePending(pending);
  }
  #settlePending(pending: Pending): void {
    if (!pending.written || !pending.response || this.#failure || !this.#pending.has(pending.id))
      return;
    this.#removePending(pending);
    if ("error" in pending.response) {
      pending.deferred.reject(pending.response.error);
      if (pending.method === "initialize") this.#fail("REMOTE_ERROR");
    } else {
      if (pending.method === "initialize") this.#phase = "initialize_ready";
      pending.deferred.resolve(pending.response.result);
    }
  }
  #removePending(pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    this.#pending.delete(pending.id);
  }
  #queueNotification(value: Record<string, unknown>, bytes: number): void {
    if (++this.#notificationCount > this.#limits.maximumNotifications) {
      this.#fail("LIMIT_EXCEEDED");
      return;
    }
    if (!this.#onNotification) return;
    if (
      this.#notificationPending + 1 > this.#limits.maximumQueuedNotifications ||
      this.#notificationBytes + bytes > this.#limits.maximumQueuedNotificationBytes
    ) {
      this.#fail("LIMIT_EXCEEDED");
      return;
    }
    const notification: CodexAppServerNotification = {
      method: value.method as string,
      ...(own(value, "params") ? { params: value.params } : {}),
      ...(own(value, "emittedAtMs") ? { emittedAtMs: value.emittedAtMs as number } : {}),
    };
    freezeJson(notification);
    this.#notifications.push({ notification, bytes });
    this.#notificationPending += 1;
    this.#notificationBytes += bytes;
    if (this.#notifierBusy) return;
    this.#notifierBusy = true;
    void (async () => {
      try {
        while (!this.#failure) {
          const next = this.#notifications.shift();
          if (!next) break;
          try {
            await this.#bounded(
              () => this.#onNotification?.(next.notification, this.#controller.signal),
              this.#limits.notificationTimeoutMs,
              "NOTIFICATION_TIMEOUT",
            );
          } catch (cause) {
            this.#notificationDeliveryComplete = false;
            this.#fail(
              cause instanceof CodexAppServerTransportError ? cause.code : "NOTIFICATION_FAILED",
            );
          } finally {
            this.#notificationPending -= 1;
            this.#notificationBytes -= next.bytes;
          }
        }
      } finally {
        // Do not leave a busy-but-unowned queue until a separate promise reaction.
        this.#notifierBusy = false;
        this.#maybeComplete();
      }
    })();
  }
  #fail(
    code: CodexAppServerTransportErrorCode,
    reason: ProcessTerminationReason = "cancelled",
    aborted = false,
  ): void {
    if (this.#settled || this.#failure) return;
    this.#failure = error(code);
    this.#aborted = aborted;
    this.#closing = true;
    this.#lineBytes = 0;
    this.#line = Buffer.alloc(0);
    for (const pending of [...this.#pending.values()]) {
      this.#removePending(pending);
      pending.deferred.reject(this.#failure);
    }
    for (const frame of this.#writes.splice(0)) frame.notification?.reject(this.#failure);
    if (this.#notificationPending) this.#notificationDeliveryComplete = false;
    for (const next of this.#notifications.splice(0)) {
      this.#notificationPending -= 1;
      this.#notificationBytes -= next.bytes;
    }
    this.#controller.abort(this.#failure);
    if (this.#graceTimer) clearTimeout(this.#graceTimer);
    if (!this.#terminationStarted) {
      this.#terminationStarted = true;
      this.#forceTimer = setTimeout(
        () => this.#cleanupUnconfirmed(),
        this.#limits.forceDrainTimeoutMs,
      );
      void Promise.resolve()
        .then(() => this.#terminateProcess(reason))
        .catch(() => undefined);
    }
    this.#maybeComplete();
  }
  #maybeComplete(): void {
    // Process exit and output-stream drain have separate bounds from callback delivery.
    if (this.#stdoutDone && this.#stderrDone && this.#streamDrainTimer) {
      clearTimeout(this.#streamDrainTimer);
      this.#streamDrainTimer = undefined;
    }
    if (
      this.#settled ||
      !this.#closing ||
      !this.#stdoutDone ||
      !this.#stderrDone ||
      this.#writerBusy ||
      this.#eofBusy ||
      this.#notifierBusy
    )
      return;
    if (this.#processRejected) {
      this.#cleanupUnconfirmed();
      return;
    }
    if (!this.#exit) return;
    this.#settled = true;
    this.#clearLifecycle();
    this.#done.resolve(
      Object.freeze({
        outcome: this.#failure ? (this.#aborted ? "aborted" : "failed") : "closed",
        failureCode: this.#failure?.code ?? null,
        processRequestId: this.#processRequestId,
        processId: this.#processId,
        stdinStreamId: this.#streamId,
        exit: this.#exit,
        stdoutEnded: this.#stdoutEnded,
        stderrEnded: this.#stderrEnded,
        stdoutBytes: this.#stdoutBytes,
        stderrBytes: this.#stderrBytes,
        frameCount: this.#frameCount,
        notificationCount: this.#notificationCount,
        notificationDeliveryComplete: this.#notificationDeliveryComplete,
      }),
    );
  }
  #cleanupUnconfirmed(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#clearLifecycle();
    this.#done.reject(error("CLEANUP_UNCONFIRMED"));
    // Output listeners remain attached and drain late bytes; no other Host process is touched.
  }
  #clearLifecycle(): void {
    if (this.#graceTimer) clearTimeout(this.#graceTimer);
    if (this.#streamDrainTimer) clearTimeout(this.#streamDrainTimer);
    if (this.#forceTimer) clearTimeout(this.#forceTimer);
    this.#parentSignal?.removeEventListener("abort", this.#parentAbort);
  }
}
