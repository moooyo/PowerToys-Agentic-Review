import type { Duplex } from "node:stream";
import { serializeCanonicalJson } from "@agentic-review/local-protocol";
import { type Static, Type } from "@sinclair/typebox";
import {
  type ArwxBootstrapReceiveLoopToken,
  type ArwxFinalFrameBinding,
  type ArwxFinalFrameReceipt,
  type ArwxStdioChannel,
  consumeArwxBootstrapReceiveLoopToken,
  consumeArwxFinalFrameReceipt,
  readArwxFinalFrameReceiptDeadline,
} from "./arwx-stdio-channel.js";
import type { ServiceHostPayloadRole } from "./launch-contract.js";
import {
  type ParsedRuntimeBootstrapV1,
  parseRuntimeBootstrap,
  parseRuntimeBootstrapCommit,
  RUNTIME_BOOTSTRAP_MAXIMUM_BYTES,
  RUNTIME_BOOTSTRAP_VERSION,
  type RuntimeBootstrapAckV1,
  RuntimeBootstrapAckV1Schema,
} from "./runtime-bootstrap.js";
import { Value } from "./typebox-value-check.js";

const maximumHandshakeTimeoutMs = 10 * 60 * 1_000;
const framePrefixBytes = 4;

const ControlFoundationRoleConfigSchema = Type.Object(
  {
    executionEnabled: Type.Literal(false),
    foundationVersion: Type.Literal(1),
    role: Type.Literal("control"),
  },
  { additionalProperties: false },
);
const ExecutorFoundationRoleConfigSchema = Type.Object(
  {
    executionEnabled: Type.Literal(false),
    foundationVersion: Type.Literal(1),
    role: Type.Literal("executor"),
  },
  { additionalProperties: false },
);

export type ControlFoundationRoleConfigV1 = Static<typeof ControlFoundationRoleConfigSchema>;
export type ExecutorFoundationRoleConfigV1 = Static<typeof ExecutorFoundationRoleConfigSchema>;

declare const runtimeBootstrapReadyBoundaryBrand: unique symbol;

export interface RuntimeBootstrapReadyBoundary<
  TRole extends ServiceHostPayloadRole = ServiceHostPayloadRole,
> {
  readonly role: TRole;
  readonly [runtimeBootstrapReadyBoundaryBrand]: true;
}

export type RuntimeBootstrapPreparation<TRole extends ServiceHostPayloadRole> = (
  parsed: Readonly<ParsedRuntimeBootstrapV1>,
) => RuntimeBootstrapReadyBoundary<TRole>;

export interface CompletedRuntimeBootstrap<TRole extends ServiceHostPayloadRole> {
  readonly role: TRole;
  readonly parsed: Readonly<ParsedRuntimeBootstrapV1>;
  readonly boundary: RuntimeBootstrapReadyBoundary<TRole>;
}

export class RuntimeBootstrapHandshakeError extends Error {
  public constructor(
    public readonly code:
      | "BOOTSTRAP_CANCELLED"
      | "BOOTSTRAP_COMMIT_INVALID"
      | "BOOTSTRAP_INVALID"
      | "BOOTSTRAP_TIMEOUT"
      | "BOOTSTRAP_TRANSPORT_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeBootstrapHandshakeError";
  }
}

interface BoundaryState<TRole extends ServiceHostPayloadRole = ServiceHostPayloadRole> {
  readonly role: TRole;
  readonly parsed: Readonly<ParsedRuntimeBootstrapV1>;
  readonly arwx: ArwxStdioChannel;
  readonly guardDone: Promise<void>;
  acknowledged: boolean;
  committed: boolean;
  shutdownAttempted: boolean;
}

const boundaryStates = new WeakMap<object, BoundaryState>();
const acknowledgedBootstraps = new WeakSet<object>();

/** Issues a role-bound capability only after the configured ARWX receive loop is running. */
export function createRuntimeBootstrapReadyBoundary<TRole extends ServiceHostPayloadRole>(
  role: TRole,
  parsed: Readonly<ParsedRuntimeBootstrapV1>,
  arwx: ArwxStdioChannel,
  receiveLoopToken: ArwxBootstrapReceiveLoopToken,
): RuntimeBootstrapReadyBoundary<TRole> {
  const effectiveGracefulTimeoutMs =
    parsed.bootstrap.shutdown.gracefulTimeoutMs -
    parsed.bootstrap.shutdown.forceTerminationReserveMs;
  const guardDone = consumeArwxBootstrapReceiveLoopToken(receiveLoopToken, arwx, role);
  if (
    parsed.bootstrap.role !== role ||
    arwx.localRole !== role ||
    arwx.state !== "open" ||
    !arwx.receiveLoopStarted ||
    arwx.configuredMaximumQueuedWriteBytes !==
      parsed.bootstrap.arwx.maximumQueuedBytesPerDirection ||
    arwx.configuredCloseTimeoutMs !== effectiveGracefulTimeoutMs ||
    !validFoundationRoleConfig(role, parsed.roleConfig) ||
    guardDone === undefined
  ) {
    throw handshakeError(
      "BOOTSTRAP_INVALID",
      "Runtime bootstrap readiness prerequisites are not satisfied.",
    );
  }
  const boundary = Object.freeze({ role }) as RuntimeBootstrapReadyBoundary<TRole>;
  boundaryStates.set(boundary, {
    role,
    parsed,
    arwx,
    guardDone,
    acknowledged: false,
    committed: false,
    shutdownAttempted: false,
  });
  return boundary;
}

export function isCompletedRuntimeBootstrap(
  completed: Readonly<CompletedRuntimeBootstrap<ServiceHostPayloadRole>>,
): boolean {
  const state = boundaryStates.get(completed.boundary);
  return (
    state?.committed === true &&
    state.parsed === completed.parsed &&
    state.role === completed.role &&
    state.arwx.state === "open" &&
    state.arwx.receiveLoopStarted
  );
}

export interface RuntimeBootstrapArwxShutdownBinding extends ArwxFinalFrameBinding {
  readonly bootstrapId: string;
}

/** Reads a genuine receipt deadline without consuming or granting shutdown authority. */
export function readCompletedRuntimeBootstrapArwxShutdownDeadline<
  TRole extends ServiceHostPayloadRole,
>(
  completed: Readonly<CompletedRuntimeBootstrap<TRole>>,
  receipt: ArwxFinalFrameReceipt,
): number | undefined {
  const state = boundaryStates.get(completed.boundary);
  if (
    state === undefined ||
    state.shutdownAttempted ||
    state.committed !== true ||
    state.parsed !== completed.parsed ||
    state.role !== completed.role
  ) {
    return undefined;
  }
  return readArwxFinalFrameReceiptDeadline(receipt, state.arwx, state.role);
}

/** Consumes one final-frame receipt bound to this exact completed bootstrap and ARWX channel. */
export function consumeCompletedRuntimeBootstrapForArwxShutdown<
  TRole extends ServiceHostPayloadRole,
>(
  completed: Readonly<CompletedRuntimeBootstrap<TRole>>,
  receipt: ArwxFinalFrameReceipt,
): Readonly<RuntimeBootstrapArwxShutdownBinding> | undefined {
  const state = boundaryStates.get(completed.boundary);
  if (
    state === undefined ||
    state.shutdownAttempted ||
    state.committed !== true ||
    state.parsed !== completed.parsed ||
    state.role !== completed.role ||
    state.arwx.state !== "open"
  ) {
    return undefined;
  }
  state.shutdownAttempted = true;
  const finalFrame = consumeArwxFinalFrameReceipt(receipt, state.arwx, state.role);
  if (
    finalFrame === undefined ||
    finalFrame.finalFrameBytes > state.parsed.bootstrap.arwx.maximumFrameBytes
  ) {
    return undefined;
  }
  return Object.freeze({
    ...finalFrame,
    bootstrapId: state.parsed.bootstrap.bootstrapId,
  });
}

/** Completes Bootstrap -> ReadyAck -> Commit while retaining exclusive ownership of the stream. */
export async function performRuntimeBootstrapHandshake<
  TRole extends ServiceHostPayloadRole,
  TResult,
>(
  stream: Duplex,
  role: TRole,
  prepare: RuntimeBootstrapPreparation<TRole>,
  absoluteDeadline: number,
  promote: (completed: Readonly<CompletedRuntimeBootstrap<TRole>>) => TResult,
  signal?: AbortSignal,
): Promise<TResult> {
  assertHandshakeArguments(stream, role, prepare, promote, absoluteDeadline);
  const owner = new RuntimeBootstrapStreamOwner(stream, absoluteDeadline, signal);
  let readyState: BoundaryState<TRole> | undefined;
  try {
    const bootstrapDocument = await owner.readFrame("bootstrap");
    let parsed: Readonly<ParsedRuntimeBootstrapV1>;
    try {
      parsed = parseRuntimeBootstrap(bootstrapDocument, role);
    } catch {
      throw handshakeError("BOOTSTRAP_INVALID", "RuntimeBootstrapV1 validation failed.");
    }

    let boundary: RuntimeBootstrapReadyBoundary<TRole>;
    try {
      boundary = prepare(parsed);
    } catch {
      throw handshakeError("BOOTSTRAP_INVALID", "Runtime bootstrap preparation failed.");
    }
    const state = boundaryStates.get(boundary);
    if (
      state === undefined ||
      state.acknowledged ||
      state.committed ||
      acknowledgedBootstraps.has(parsed) ||
      state.role !== role ||
      state.parsed !== parsed ||
      state.arwx.state !== "open" ||
      !state.arwx.receiveLoopStarted
    ) {
      throw handshakeError("BOOTSTRAP_INVALID", "Runtime bootstrap readiness boundary is invalid.");
    }
    readyState = state as BoundaryState<TRole>;
    acknowledgedBootstraps.add(parsed);
    state.acknowledged = true;
    owner.watchGuard(state.guardDone);
    await owner.writeFrame(encodeRuntimeBootstrapReadyAck(parsed));

    const commitDocument = await owner.readFrame("commit");
    try {
      parseRuntimeBootstrapCommit(commitDocument, parsed);
    } catch {
      throw handshakeError(
        "BOOTSTRAP_COMMIT_INVALID",
        "RuntimeBootstrapCommitV1 validation failed.",
      );
    }
    if (state.arwx.state !== "open" || !state.arwx.receiveLoopStarted) {
      throw handshakeError(
        "BOOTSTRAP_COMMIT_INVALID",
        "ARWX receive loop stopped before runtime bootstrap commit.",
      );
    }
    const completed = Object.freeze({ role, parsed, boundary });
    const result = owner.promote(() => promote(completed));
    state.committed = true;
    return result;
  } catch (error) {
    readyState?.arwx.abort();
    owner.abort();
    if (error instanceof RuntimeBootstrapHandshakeError) throw error;
    throw handshakeError("BOOTSTRAP_TRANSPORT_FAILED", "Runtime bootstrap transport failed.");
  }
}

function validFoundationRoleConfig(
  role: ServiceHostPayloadRole,
  value: Readonly<Record<string, unknown>>,
): boolean {
  return Value.Check(
    role === "control" ? ControlFoundationRoleConfigSchema : ExecutorFoundationRoleConfigSchema,
    value,
  );
}

function assertHandshakeArguments<TRole extends ServiceHostPayloadRole>(
  stream: Duplex,
  role: TRole,
  prepare: RuntimeBootstrapPreparation<TRole>,
  promote: (completed: Readonly<CompletedRuntimeBootstrap<TRole>>) => unknown,
  absoluteDeadline: number,
): void {
  const now = performance.now();
  if (
    stream === null ||
    typeof stream !== "object" ||
    typeof stream.destroy !== "function" ||
    (role !== "control" && role !== "executor") ||
    typeof prepare !== "function" ||
    typeof promote !== "function" ||
    !Number.isFinite(absoluteDeadline) ||
    absoluteDeadline - now > maximumHandshakeTimeoutMs
  ) {
    throw new TypeError("Runtime bootstrap handshake arguments are invalid.");
  }
  if (stream.destroyed || stream.readableEnded) {
    destroyHandshakeStream(stream);
    throw handshakeError("BOOTSTRAP_TRANSPORT_FAILED", "Runtime bootstrap stream is not readable.");
  }
  if (absoluteDeadline <= now) {
    destroyHandshakeStream(stream);
    throw handshakeError("BOOTSTRAP_TIMEOUT", "Runtime bootstrap handshake timed out.");
  }
}

function encodeFrame(document: Uint8Array): Buffer {
  if (document.byteLength === 0 || document.byteLength > RUNTIME_BOOTSTRAP_MAXIMUM_BYTES) {
    throw handshakeError("BOOTSTRAP_INVALID", "Runtime bootstrap frame is outside its byte limit.");
  }
  const frame = Buffer.allocUnsafe(framePrefixBytes + document.byteLength);
  frame.writeUInt32LE(document.byteLength, 0);
  frame.set(document, framePrefixBytes);
  return frame;
}

function encodeRuntimeBootstrapReadyAck(parsed: Readonly<ParsedRuntimeBootstrapV1>): Buffer {
  const value: RuntimeBootstrapAckV1 = {
    protocolVersion: "1.0",
    type: "runtimeBootstrapAck",
    bootstrapVersion: RUNTIME_BOOTSTRAP_VERSION,
    bootstrapId: parsed.bootstrap.bootstrapId,
    role: parsed.bootstrap.role,
    bootstrapSha256: parsed.bootstrapSha256,
    accepted: true,
    arwxReceiveLoopStarted: true,
  };
  if (!Value.Check(RuntimeBootstrapAckV1Schema, value)) {
    throw handshakeError("BOOTSTRAP_INVALID", "Runtime bootstrap acknowledgement is invalid.");
  }
  return Buffer.from(serializeCanonicalJson(value), "utf8");
}

const maximumHandshakeBufferedBytes = 2 * (framePrefixBytes + RUNTIME_BOOTSTRAP_MAXIMUM_BYTES);

interface PendingFrameRead {
  readonly phase: "bootstrap" | "commit";
  readonly resolve: (frame: Buffer) => void;
  readonly reject: (error: RuntimeBootstrapHandshakeError) => void;
}

class RuntimeBootstrapStreamOwner {
  readonly #terminal = new Deferred<never>();
  readonly #chunks: Buffer[] = [];
  #bufferedBytes = 0;
  #pendingRead: PendingFrameRead | undefined;
  #promoted = false;
  #terminalError: RuntimeBootstrapHandshakeError | undefined;
  readonly #deadlineTimer: NodeJS.Timeout;

  public constructor(
    private readonly stream: Duplex,
    absoluteDeadline: number,
    private readonly signal: AbortSignal | undefined,
  ) {
    const remaining = absoluteDeadline - performance.now();
    if (remaining <= 0) {
      destroyHandshakeStream(stream);
      throw handshakeError("BOOTSTRAP_TIMEOUT", "Runtime bootstrap handshake timed out.");
    }
    this.#deadlineTimer = setTimeout(() => {
      this.#fail(handshakeError("BOOTSTRAP_TIMEOUT", "Runtime bootstrap handshake timed out."));
    }, remaining);
    this.#deadlineTimer.unref();
    stream.on("data", this.#onData);
    stream.once("end", this.#onEnd);
    stream.once("error", this.#onError);
    stream.once("close", this.#onClose);
    signal?.addEventListener("abort", this.#onAbort, { once: true });
    if (signal?.aborted) {
      this.#fail(
        handshakeError("BOOTSTRAP_CANCELLED", "Runtime bootstrap handshake was cancelled."),
      );
    } else if (stream.destroyed || stream.readableEnded) {
      this.#fail(
        handshakeError("BOOTSTRAP_TRANSPORT_FAILED", "Runtime bootstrap stream is not readable."),
      );
    } else {
      stream.resume();
    }
  }

  public async readFrame(phase: "bootstrap" | "commit"): Promise<Buffer> {
    if (this.#terminalError !== undefined) throw this.#terminalError;
    if (this.#pendingRead !== undefined || this.#promoted) {
      throw handshakeError(
        "BOOTSTRAP_TRANSPORT_FAILED",
        "Runtime bootstrap read state is invalid.",
      );
    }
    const available = this.#extractFrame();
    if (available !== undefined) return available;
    return await new Promise<Buffer>((resolve, reject) => {
      this.#pendingRead = { phase, resolve, reject };
      this.#pumpRead();
    });
  }

  public async writeFrame(document: Uint8Array): Promise<void> {
    if (this.#terminalError !== undefined) throw this.#terminalError;
    if (this.#promoted) {
      throw handshakeError(
        "BOOTSTRAP_TRANSPORT_FAILED",
        "Runtime bootstrap write state is invalid.",
      );
    }
    const frame = encodeFrame(document);
    const written = new Promise<void>((resolve, reject) => {
      try {
        this.stream.write(frame, (error?: Error | null) => {
          if (error !== undefined && error !== null) {
            reject(handshakeError("BOOTSTRAP_TRANSPORT_FAILED", "Runtime bootstrap write failed."));
            return;
          }
          resolve();
        });
      } catch {
        reject(handshakeError("BOOTSTRAP_TRANSPORT_FAILED", "Runtime bootstrap write failed."));
      }
    });
    await Promise.race([written, this.#terminal.promise]);
    if (this.#terminalError !== undefined) throw this.#terminalError;
  }

  public watchGuard(done: Promise<void>): void {
    void done.then(
      () => {
        this.#fail(
          handshakeError(
            "BOOTSTRAP_TRANSPORT_FAILED",
            "ARWX runtime bootstrap guard stopped before promotion.",
          ),
        );
      },
      () => {
        this.#fail(
          handshakeError(
            "BOOTSTRAP_TRANSPORT_FAILED",
            "ARWX runtime bootstrap guard failed before promotion.",
          ),
        );
      },
    );
  }

  public promote<TResult>(factory: () => TResult): TResult {
    if (
      this.#terminalError !== undefined ||
      this.#promoted ||
      this.#pendingRead !== undefined ||
      this.#bufferedBytes !== 0 ||
      this.stream.destroyed ||
      this.stream.readableEnded
    ) {
      throw (
        this.#terminalError ??
        handshakeError("BOOTSTRAP_TRANSPORT_FAILED", "Runtime bootstrap promotion failed.")
      );
    }
    this.stream.pause();
    try {
      const result = factory();
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw handshakeError(
          "BOOTSTRAP_TRANSPORT_FAILED",
          "Runtime bootstrap promotion must install its stream owner synchronously.",
        );
      }
      if (this.#terminalError !== undefined || this.stream.destroyed || this.stream.readableEnded) {
        throw (
          this.#terminalError ??
          handshakeError("BOOTSTRAP_TRANSPORT_FAILED", "Runtime bootstrap promotion failed.")
        );
      }
      this.#detach();
      this.#promoted = true;
      this.stream.resume();
      return result;
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  public abort(): void {
    if (this.#promoted) return;
    this.#fail(
      this.#terminalError ??
        handshakeError("BOOTSTRAP_TRANSPORT_FAILED", "Runtime bootstrap handshake failed."),
    );
    try {
      this.stream.destroy();
    } catch {
      // The bootstrap failure is already terminal.
    } finally {
      this.#detach();
    }
  }

  readonly #onData = (chunk: Buffer | string): void => {
    if (!Buffer.isBuffer(chunk)) {
      this.#fail(
        handshakeError(
          "BOOTSTRAP_TRANSPORT_FAILED",
          "Runtime bootstrap stream emitted non-byte data.",
        ),
      );
      return;
    }
    if (chunk.byteLength === 0) return;
    if (this.#bufferedBytes + chunk.byteLength > maximumHandshakeBufferedBytes) {
      this.#fail(handshakeError("BOOTSTRAP_INVALID", "Runtime bootstrap input exceeds its limit."));
      return;
    }
    this.#chunks.push(Buffer.from(chunk));
    this.#bufferedBytes += chunk.byteLength;
    this.#pumpRead();
  };

  readonly #onEnd = (): void => {
    this.#fail(
      handshakeError("BOOTSTRAP_TRANSPORT_FAILED", "Runtime bootstrap stream ended early."),
    );
  };

  readonly #onError = (): void => {
    this.#fail(handshakeError("BOOTSTRAP_TRANSPORT_FAILED", "Runtime bootstrap stream failed."));
  };

  readonly #onClose = (): void => {
    this.#fail(
      handshakeError("BOOTSTRAP_TRANSPORT_FAILED", "Runtime bootstrap stream closed early."),
    );
  };

  readonly #onAbort = (): void => {
    this.#fail(handshakeError("BOOTSTRAP_CANCELLED", "Runtime bootstrap handshake was cancelled."));
  };

  #pumpRead(): void {
    const pending = this.#pendingRead;
    if (pending === undefined || this.#terminalError !== undefined) return;
    let frame: Buffer | undefined;
    try {
      frame = this.#extractFrame();
    } catch (error) {
      this.#fail(
        error instanceof RuntimeBootstrapHandshakeError
          ? error
          : handshakeError("BOOTSTRAP_INVALID", `Runtime bootstrap ${pending.phase} is invalid.`),
      );
      return;
    }
    if (frame === undefined) return;
    this.#pendingRead = undefined;
    pending.resolve(frame);
  }

  #extractFrame(): Buffer | undefined {
    if (this.#bufferedBytes < framePrefixBytes) return undefined;
    const buffered = Buffer.concat(this.#chunks, this.#bufferedBytes);
    const length = buffered.readUInt32LE(0);
    if (length === 0 || length > RUNTIME_BOOTSTRAP_MAXIMUM_BYTES) {
      throw handshakeError("BOOTSTRAP_INVALID", "Runtime bootstrap frame length is invalid.");
    }
    const frameBytes = framePrefixBytes + length;
    if (buffered.byteLength < frameBytes) return undefined;
    const frame = Buffer.from(buffered.subarray(framePrefixBytes, frameBytes));
    const remainder = buffered.subarray(frameBytes);
    this.#chunks.length = 0;
    this.#bufferedBytes = remainder.byteLength;
    if (remainder.byteLength > 0) this.#chunks.push(Buffer.from(remainder));
    return frame;
  }

  #fail(error: RuntimeBootstrapHandshakeError): void {
    if (this.#promoted || this.#terminalError !== undefined) return;
    this.#terminalError = error;
    this.stream.pause();
    const pending = this.#pendingRead;
    this.#pendingRead = undefined;
    pending?.reject(error);
    this.#terminal.reject(error);
  }

  #detach(): void {
    clearTimeout(this.#deadlineTimer);
    this.signal?.removeEventListener("abort", this.#onAbort);
    this.stream.removeListener("data", this.#onData);
    this.stream.removeListener("end", this.#onEnd);
    this.stream.removeListener("error", this.#onError);
    this.stream.removeListener("close", this.#onClose);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

function destroyHandshakeStream(stream: Duplex): void {
  try {
    stream.destroy();
  } catch {
    // The handshake cannot retain a stream after its startup deadline.
  }
}

class Deferred<T> {
  public readonly promise: Promise<T>;
  readonly #resolve: (value: T | PromiseLike<T>) => void;
  readonly #reject: (reason?: unknown) => void;

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
    this.#resolve(value);
  }

  public reject(reason: unknown): void {
    this.#reject(reason);
  }
}

function handshakeError(
  code: RuntimeBootstrapHandshakeError["code"],
  message: string,
): RuntimeBootstrapHandshakeError {
  return new RuntimeBootstrapHandshakeError(code, message);
}
