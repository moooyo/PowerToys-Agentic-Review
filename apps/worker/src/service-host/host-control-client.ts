import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import {
  type ArmArwxShutdownResultV1,
  commitPreparedArmArwxShutdown,
  failPreparedArmArwxShutdown,
  prepareArmArwxShutdown,
  readArmArwxShutdownDeadline,
  readPreparedArmArwxShutdown,
  validateArmArwxShutdownResult,
} from "./arwx-shutdown.js";
import { type ArwxFinalFrameReceipt, failArwxFinalFrameReceipt } from "./arwx-stdio-channel.js";
import {
  encodeHostControlCall,
  encodeHostControlCancel,
  HOST_CONTROL_MAXIMUM_ARM_ARWX_SHUTDOWN_BYTES,
  HOST_CONTROL_MAXIMUM_BODY_BYTES,
  HOST_CONTROL_MAXIMUM_CANONICAL_FRAME_BYTES,
  HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_BODY_BYTES,
  HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_FRAME_BYTES,
  HOST_CONTROL_MAXIMUM_FRAME_BYTES,
  HOST_CONTROL_MAXIMUM_REQUEST_FRAME_BYTES,
  HostControlFrameDecoder,
  type HostControlJsonObject,
  type HostControlOperation,
  HostControlProtocolError,
  parseHostControlResponse,
  validHostControlEntityId,
  validP256LowSSignature,
} from "./host-control-protocol.js";
import type { HostControlSession } from "./host-control-session.js";
import { type HostControlPipeSelector, isHostControlPipeSelector } from "./launch-contract.js";
import {
  decodeHostControlOpaqueJson,
  type HostControlOpaqueJsonDescriptor,
} from "./opaque-json.js";
import type { ParsedRuntimeBootstrapV1 } from "./runtime-bootstrap.js";
import {
  type CompletedRuntimeBootstrap,
  performRuntimeBootstrapHandshake,
  RuntimeBootstrapHandshakeError,
  type RuntimeBootstrapPreparation,
} from "./runtime-bootstrap-handshake.js";

export { HostControlRemoteError } from "./host-control-protocol.js";
export type { HostControlSession } from "./host-control-session.js";

const maximumConfiguredConcurrency = 64;
const maximumConfiguredRequestIds = 1_000_000;
const maximumConfiguredQueuedWriteBytes = 64 * 1_024 * 1_024;
const maximumConfiguredTimeoutMs = 10 * 60 * 1_000;
const defaultMaximumConcurrentRequests = 16;
const defaultMaximumRequestIds = 1_000_000;
const defaultMaximumQueuedWriteBytes = 16 * 1_024 * 1_024;
const defaultConnectTimeoutMs = 30_000;
const defaultRequestTimeoutMs = 60_000;
const defaultClaimTimeoutMs = 90_000;
const defaultCancellationGraceMs = 10_000;
const defaultCloseTimeoutMs = 15_000;
const controlHostControlClients = new WeakSet<object>();

const sessionFatalErrorCodes = new Set([
  "INVALID_FRAME",
  "INVALID_CANONICAL_JSON",
  "INVALID_MESSAGE",
  "OPERATION_NOT_ALLOWED",
  "UNKNOWN_MESSAGE_TYPE",
  "INVALID_REQUEST_ID",
  "REQUEST_TOO_LARGE",
  "INVALID_PAYLOAD",
  "UNKNOWN_OPERATION",
  "INVALID_TARGET_REQUEST_ID",
  "DUPLICATE_REQUEST_ID",
  "REQUEST_ID_CAPACITY",
]);

export interface HostControlCallOptions {
  readonly signal?: AbortSignal;
}

export interface ControlHostControlClient extends HostControlSession<"control"> {
  readonly role: "control";
  register(
    body: HostControlOpaqueJsonDescriptor,
    options?: HostControlCallOptions,
  ): Promise<unknown>;
  claim(body: HostControlOpaqueJsonDescriptor, options?: HostControlCallOptions): Promise<unknown>;
  instanceHeartbeat(
    workerInstanceId: string,
    body: HostControlOpaqueJsonDescriptor,
    options?: HostControlCallOptions,
  ): Promise<unknown>;
  completeRun(
    runAttemptId: string,
    body: HostControlOpaqueJsonDescriptor,
    options?: HostControlCallOptions,
  ): Promise<unknown>;
  failRun(
    runAttemptId: string,
    body: HostControlOpaqueJsonDescriptor,
    options?: HostControlCallOptions,
  ): Promise<unknown>;
  signLocalDigest(digestSha256: string, options?: HostControlCallOptions): Promise<string>;
  waitForIdle(absoluteDeadline: number): Promise<void>;
  armArwxShutdown(receipt: ArwxFinalFrameReceipt): Promise<Readonly<ArmArwxShutdownResultV1>>;
}

/** Recognizes only clients created by this reviewed Control connector. */
export function isControlHostControlClient(
  session: HostControlSession<"control">,
): session is ControlHostControlClient {
  return controlHostControlClients.has(session);
}

export type HostControlConnector = (
  pipe: HostControlPipeSelector,
  cancellation: AbortSignal,
) => Promise<Duplex>;
export type HostControlRequestIdFactory = (kind: "call" | "cancel") => string;

interface CommonConnectOptions {
  readonly pipe: HostControlPipeSelector;
  readonly prepareRuntimeBootstrap: RuntimeBootstrapPreparation<"control">;
  readonly maximumConcurrentRequests?: number;
  readonly maximumRequestIds?: number;
  readonly maximumQueuedWriteBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly claimTimeoutMs?: number;
  readonly cancellationGraceMs?: number;
  readonly closeTimeoutMs?: number;
  readonly connector?: HostControlConnector;
  readonly requestIdFactory?: HostControlRequestIdFactory;
}

export interface ControlHostControlConnectOptions extends CommonConnectOptions {
  readonly role: "control";
}

export class HostControlClientError extends Error {
  public constructor(
    public readonly code:
      | "CANCEL_FAILED"
      | "CLIENT_CLOSED"
      | "CLOSE_TIMEOUT"
      | "CONCURRENCY_LIMIT"
      | "CONNECT_CANCELLED"
      | "CONNECT_FAILED"
      | "CONNECT_TIMEOUT"
      | "DRAIN_TIMEOUT"
      | "LIFECYCLE_STATE_INVALID"
      | "LIFECYCLE_TIMEOUT"
      | "OPERATION_NOT_ALLOWED"
      | "OUTPUT_QUEUE_LIMIT_EXCEEDED"
      | "PROTOCOL_FAILURE"
      | "REQUEST_CANCELLED"
      | "REQUEST_ID_CAPACITY"
      | "REQUEST_INVALID"
      | "REQUEST_TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "HostControlClientError";
  }
}

interface NormalizedOptions {
  readonly role: "control";
  readonly pipe: HostControlPipeSelector;
  readonly prepareRuntimeBootstrap: RuntimeBootstrapPreparation<"control">;
  readonly maximumConcurrentRequests: number;
  readonly maximumRequestIds: number;
  readonly maximumQueuedWriteBytes: number;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly claimTimeoutMs: number;
  readonly cancellationGraceMs: number;
  readonly closeTimeoutMs: number;
  readonly connector: HostControlConnector;
  readonly requestIdFactory: HostControlRequestIdFactory;
}

interface PendingRequest {
  readonly id: string;
  readonly kind: "call" | "cancel";
  readonly responseKind: "opaque-json" | "canonical";
  readonly responseMaximumBytes: number;
  readonly decodedResponseMaximumBytes: number;
  readonly deferred: Deferred<unknown>;
  signal?: AbortSignal;
  abortListener?: () => void;
  timeout?: NodeJS.Timeout;
  cancellationTimeout?: NodeJS.Timeout;
  cancellationStarted: boolean;
  callerSettled: boolean;
}

interface FrameReservation {
  readonly bytes: number;
  released: boolean;
}

type ClientState = "open" | "arming" | "armed" | "draining" | "closing" | "closed" | "failed";

export async function connectHostControl(
  options: ControlHostControlConnectOptions,
  signal?: AbortSignal,
): Promise<ControlHostControlClient> {
  const normalized = normalizeOptions(options);
  if (signal?.aborted) {
    throw clientError("CONNECT_CANCELLED", "HostControl connection was cancelled.");
  }
  const absoluteDeadline = performance.now() + normalized.connectTimeoutMs;
  const stream = await connectWithDeadline(normalized, absoluteDeadline, signal);
  try {
    return await performRuntimeBootstrapHandshake(
      stream,
      "control",
      normalized.prepareRuntimeBootstrap,
      absoluteDeadline,
      (completed) => new HostControlRpcClient(stream, normalized, completed),
      signal,
    );
  } catch (error) {
    if (error instanceof RuntimeBootstrapHandshakeError) {
      if (error.code === "BOOTSTRAP_CANCELLED") {
        throw clientError("CONNECT_CANCELLED", "HostControl bootstrap was cancelled.");
      }
      if (error.code === "BOOTSTRAP_TIMEOUT") {
        throw clientError("CONNECT_TIMEOUT", "HostControl bootstrap timed out.");
      }
      throw clientError("PROTOCOL_FAILURE", "HostControl bootstrap failed.");
    }
    throw error;
  }
}

class HostControlRpcClient implements ControlHostControlClient {
  public readonly role = "control" as const;
  public readonly bootstrap: Readonly<ParsedRuntimeBootstrapV1>;
  readonly #stream: Duplex;
  readonly #options: NormalizedOptions;
  readonly #decoder = new HostControlFrameDecoder(HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_FRAME_BYTES);
  readonly #pending = new Map<string, PendingRequest>();
  readonly #seenRequestIds = new Set<string>();
  readonly #closed = new Deferred<void>();
  readonly #failure = new Deferred<never>();
  readonly #writableHalfClosed = new Deferred<void>();
  readonly #done = Promise.race([this.#closed.promise, this.#failure.promise]);
  readonly #pendingEmptyWaiters = new Set<() => void>();
  readonly #frameReservations = new Set<FrameReservation>();
  readonly #runtimeBootstrap: Readonly<CompletedRuntimeBootstrap<"control">>;
  #writeChain: Promise<void> = Promise.resolve();
  #state: ClientState = "open";
  #activeCalls = 0;
  #queuedWriteBytes = 0;
  #terminalError: HostControlClientError | undefined;
  #writableEndStarted = false;
  #writableHalfCloseObserved = false;
  #transportCloseObserved = false;
  #readableEndObserved = false;
  #armOperation: Promise<Readonly<ArmArwxShutdownResultV1>> | undefined;
  #drainPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #shutdownDeadline: number | undefined;

  public get done(): Promise<void> {
    return this.#done;
  }

  public constructor(
    stream: Duplex,
    options: NormalizedOptions,
    runtimeBootstrap: Readonly<CompletedRuntimeBootstrap<"control">>,
  ) {
    this.#stream = stream;
    this.#options = options;
    this.#runtimeBootstrap = runtimeBootstrap;
    this.bootstrap = runtimeBootstrap.parsed;
    controlHostControlClients.add(this);
    void this.#done.then(undefined, () => undefined);
    stream.on("data", (chunk: Buffer | string) => {
      this.#onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });
    stream.once("end", () => this.#onEnd());
    stream.once("error", () => {
      this.#fail(clientError("PROTOCOL_FAILURE", "HostControl stream failed."));
    });
    stream.once("close", () => this.#onClose());
  }

  public register(
    body: HostControlOpaqueJsonDescriptor,
    options: HostControlCallOptions = {},
  ): Promise<unknown> {
    return this.#call("Register", { body }, "opaque-json", options.signal);
  }

  public claim(
    body: HostControlOpaqueJsonDescriptor,
    options: HostControlCallOptions = {},
  ): Promise<unknown> {
    return this.#call("Claim", { body }, "opaque-json", options.signal);
  }

  public instanceHeartbeat(
    workerInstanceId: string,
    body: HostControlOpaqueJsonDescriptor,
    options: HostControlCallOptions = {},
  ): Promise<unknown> {
    assertEntityId(workerInstanceId, "workerInstanceId");
    return this.#call(
      "InstanceHeartbeat",
      { body, workerInstanceId },
      "opaque-json",
      options.signal,
    );
  }

  public completeRun(
    runAttemptId: string,
    body: HostControlOpaqueJsonDescriptor,
    options: HostControlCallOptions = {},
  ): Promise<unknown> {
    assertEntityId(runAttemptId, "runAttemptId");
    return this.#call("CompleteRun", { body, runAttemptId }, "opaque-json", options.signal);
  }

  public failRun(
    runAttemptId: string,
    body: HostControlOpaqueJsonDescriptor,
    options: HostControlCallOptions = {},
  ): Promise<unknown> {
    assertEntityId(runAttemptId, "runAttemptId");
    return this.#call("FailRun", { body, runAttemptId }, "opaque-json", options.signal);
  }

  public async signLocalDigest(
    digestSha256: string,
    options: HostControlCallOptions = {},
  ): Promise<string> {
    if (!/^[a-f0-9]{64}$/u.test(digestSha256)) {
      throw clientError("REQUEST_INVALID", "Local signing digest must be lowercase SHA-256.");
    }
    const body = await this.#call("SignLocalDigest", { digestSha256 }, "canonical", options.signal);
    if (
      !isRecord(body) ||
      !hasExactKeys(body, ["signatureP1363"]) ||
      typeof body.signatureP1363 !== "string" ||
      !validP256LowSSignature(body.signatureP1363)
    ) {
      this.#fail(clientError("PROTOCOL_FAILURE", "HostControl signing response is invalid."));
      throw this.#terminalError;
    }
    return body.signatureP1363;
  }

  public armArwxShutdown(
    receipt: ArwxFinalFrameReceipt,
  ): Promise<Readonly<ArmArwxShutdownResultV1>> {
    const operation = this.#runArmArwxShutdown(receipt);
    if (this.#armOperation === undefined) {
      this.#armOperation = operation;
      void operation.then(
        () => this.#settleArmOperation(operation),
        () => this.#settleArmOperation(operation),
      );
    }
    return operation;
  }

  async #runArmArwxShutdown(
    receipt: ArwxFinalFrameReceipt,
  ): Promise<Readonly<ArmArwxShutdownResultV1>> {
    const shutdownDeadline = readArmArwxShutdownDeadline(this.#runtimeBootstrap, receipt);
    if (shutdownDeadline !== undefined) this.#shutdownDeadline = shutdownDeadline;
    this.#assertAccepting();
    if (
      this.#activeCalls !== 0 ||
      this.#pending.size !== 0 ||
      this.#frameReservations.size !== 0 ||
      this.#queuedWriteBytes !== 0
    ) {
      failArwxFinalFrameReceipt(receipt);
      const error = clientError(
        "LIFECYCLE_STATE_INVALID",
        "HostControl cannot arm ARWX shutdown while RPC work is active.",
      );
      this.#fail(error);
      throw error;
    }
    let prepared: ReturnType<typeof prepareArmArwxShutdown>;
    try {
      prepared = prepareArmArwxShutdown(this.#runtimeBootstrap, receipt);
    } catch {
      const error = clientError(
        "LIFECYCLE_STATE_INVALID",
        "HostControl ARWX shutdown authority is invalid.",
      );
      this.#fail(error);
      throw error;
    }
    const details = readPreparedArmArwxShutdown(prepared);
    this.#shutdownDeadline = details.absoluteDeadline;
    let response: unknown;
    try {
      const pending = this.#call(
        "ArmArwxShutdown",
        details.request,
        "canonical",
        undefined,
        details.absoluteDeadline,
      );
      this.#state = "arming";
      response = await pending;
      if (this.#state !== "arming" || performance.now() >= details.absoluteDeadline) {
        throw new Error("Arm response arrived outside its lifecycle state.");
      }
      const result = validateArmArwxShutdownResult(response, details.request);
      commitPreparedArmArwxShutdown(prepared);
      this.#state = "armed";
      const draining = this.drain();
      draining.catch(() => undefined);
      if (this.#terminalError !== undefined) throw this.#terminalError;
      try {
        await this.#awaitDrainPhase(
          () => this.#writableHalfClosed.promise,
          details.absoluteDeadline,
        );
      } catch {
        if (this.#terminalError === undefined) {
          this.#fail(
            clientError(
              "LIFECYCLE_TIMEOUT",
              "HostControl ARWX shutdown arm missed its final settlement deadline.",
            ),
          );
        }
        throw this.#terminalError;
      }
      if (this.#terminalError !== undefined) throw this.#terminalError;
      return result;
    } catch {
      failPreparedArmArwxShutdown(prepared);
      const error =
        this.#terminalError ??
        clientError("PROTOCOL_FAILURE", "HostControl ARWX shutdown arm failed.");
      this.#fail(error);
      throw error;
    }
  }

  public drain(absoluteDeadline?: number): Promise<void> {
    this.#drainPromise ??= this.#drain(
      selectShutdownDeadline(
        absoluteDeadline,
        this.#shutdownDeadline,
        this.#options.closeTimeoutMs,
      ),
    );
    return this.#drainPromise;
  }

  public async waitForIdle(absoluteDeadline: number): Promise<void> {
    if (!Number.isFinite(absoluteDeadline) || this.#state !== "open") {
      throw clientError(
        "LIFECYCLE_STATE_INVALID",
        "HostControl idle wait requires an open client and finite deadline.",
      );
    }
    try {
      const pendingTimeoutMs = remainingShutdownMilliseconds(absoluteDeadline);
      await withDeadline(
        Promise.race([this.#waitForPendingEmpty(), this.#failure.promise]),
        pendingTimeoutMs,
      );
      remainingShutdownMilliseconds(absoluteDeadline);
      const writeTimeoutMs = remainingShutdownMilliseconds(absoluteDeadline);
      await withDeadline(Promise.race([this.#writeChain, this.#failure.promise]), writeTimeoutMs);
      remainingShutdownMilliseconds(absoluteDeadline);
    } catch {
      if (this.#terminalError !== undefined) throw this.#terminalError;
      throw clientError(
        "LIFECYCLE_TIMEOUT",
        "HostControl did not become idle before its shutdown deadline.",
      );
    }
    if (
      this.#activeCalls !== 0 ||
      this.#pending.size !== 0 ||
      this.#frameReservations.size !== 0 ||
      this.#queuedWriteBytes !== 0
    ) {
      throw clientError("LIFECYCLE_STATE_INVALID", "HostControl idle ownership did not converge.");
    }
  }

  public close(absoluteDeadline?: number): Promise<void> {
    this.#closePromise ??= this.#close(
      selectShutdownDeadline(
        absoluteDeadline,
        this.#shutdownDeadline,
        this.#options.closeTimeoutMs,
      ),
    );
    return this.#closePromise;
  }

  #call(
    operation: HostControlOperation,
    payload: HostControlJsonObject,
    responseKind: "opaque-json" | "canonical",
    signal: AbortSignal | undefined,
    absoluteDeadline?: number,
  ): Promise<unknown> {
    this.#assertControlOperation();
    this.#assertAccepting();
    if (signal?.aborted) {
      throw clientError("REQUEST_CANCELLED", "HostControl request was cancelled.");
    }
    if (this.#activeCalls >= this.#options.maximumConcurrentRequests) {
      throw clientError("CONCURRENCY_LIMIT", "HostControl concurrent request limit is reached.");
    }

    const timeoutMs =
      absoluteDeadline === undefined
        ? operation === "Claim"
          ? this.#options.claimTimeoutMs
          : this.#options.requestTimeoutMs
        : remainingShutdownMilliseconds(absoluteDeadline);

    const requestId = this.#allocateRequestId("call");
    let frame: Buffer;
    try {
      frame = encodeHostControlCall(operation, requestId, payload);
    } catch {
      throw clientError("REQUEST_INVALID", "HostControl request is invalid.");
    }
    const reservation = this.#reserveFrame(frame.byteLength);
    const pending: PendingRequest = {
      id: requestId,
      kind: "call",
      responseKind,
      responseMaximumBytes:
        operation === "Claim"
          ? HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_FRAME_BYTES
          : operation === "ArmArwxShutdown"
            ? HOST_CONTROL_MAXIMUM_ARM_ARWX_SHUTDOWN_BYTES
            : operation === "SignLocalDigest"
              ? HOST_CONTROL_MAXIMUM_CANONICAL_FRAME_BYTES
              : HOST_CONTROL_MAXIMUM_FRAME_BYTES,
      decodedResponseMaximumBytes:
        operation === "Claim"
          ? HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_BODY_BYTES
          : HOST_CONTROL_MAXIMUM_BODY_BYTES,
      deferred: new Deferred<unknown>(),
      cancellationStarted: false,
      callerSettled: false,
      ...(signal === undefined ? {} : { signal }),
    };
    this.#pending.set(requestId, pending);
    this.#activeCalls += 1;
    pending.timeout = setTimeout(() => {
      if (operation === "ArmArwxShutdown") {
        this.#fail(clientError("LIFECYCLE_TIMEOUT", "HostControl ARWX shutdown arm timed out."));
      } else {
        this.#cancelPending(pending, "REQUEST_TIMEOUT");
      }
    }, timeoutMs);
    pending.timeout.unref();
    if (signal !== undefined) {
      pending.abortListener = () => this.#cancelPending(pending, "REQUEST_CANCELLED");
      signal.addEventListener("abort", pending.abortListener, { once: true });
    }
    void this.#enqueueFrame(frame, reservation).catch(() => {
      this.#fail(clientError("PROTOCOL_FAILURE", "HostControl request write failed."));
    });
    return pending.deferred.promise;
  }

  #cancelPending(pending: PendingRequest, code: "REQUEST_CANCELLED" | "REQUEST_TIMEOUT"): void {
    if (this.#pending.get(pending.id) !== pending || pending.cancellationStarted) return;
    pending.cancellationStarted = true;
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    if (!pending.callerSettled) {
      pending.callerSettled = true;
      pending.deferred.reject(
        clientError(
          code,
          code === "REQUEST_TIMEOUT"
            ? "HostControl request exceeded its local deadline."
            : "HostControl request was cancelled.",
        ),
      );
    }
    pending.cancellationTimeout = setTimeout(() => {
      this.#fail(clientError("CANCEL_FAILED", "HostControl cancellation did not settle."));
    }, this.#options.cancellationGraceMs);
    pending.cancellationTimeout.unref();
    try {
      this.#sendCancel(pending.id);
    } catch {
      this.#fail(clientError("CANCEL_FAILED", "HostControl cancellation could not be sent."));
    }
  }

  #sendCancel(targetRequestId: string): void {
    const requestId = this.#allocateRequestId("cancel");
    const frame = encodeHostControlCancel(requestId, targetRequestId);
    const reservation = this.#reserveFrame(frame.byteLength);
    const pending: PendingRequest = {
      id: requestId,
      kind: "cancel",
      responseKind: "canonical",
      responseMaximumBytes: HOST_CONTROL_MAXIMUM_CANONICAL_FRAME_BYTES,
      decodedResponseMaximumBytes: HOST_CONTROL_MAXIMUM_CANONICAL_FRAME_BYTES,
      deferred: new Deferred<unknown>(),
      cancellationStarted: false,
      callerSettled: false,
    };
    pending.timeout = setTimeout(() => {
      this.#fail(clientError("CANCEL_FAILED", "HostControl cancel acknowledgement timed out."));
    }, this.#options.cancellationGraceMs);
    pending.timeout.unref();
    this.#pending.set(requestId, pending);
    void this.#enqueueFrame(frame, reservation).catch(() => {
      this.#fail(clientError("CANCEL_FAILED", "HostControl cancel write failed."));
    });
  }

  #onData(chunk: Buffer): void {
    if (this.#state === "closed" || this.#state === "failed") return;
    try {
      for (const document of this.#decoder.push(chunk)) {
        this.#handleResponse(document);
      }
    } catch {
      this.#fail(clientError("PROTOCOL_FAILURE", "HostControl response framing is invalid."));
    }
  }

  #onEnd(): void {
    if (this.#state === "closed" || this.#state === "failed") return;
    try {
      this.#decoder.end();
    } catch {
      this.#fail(
        clientError("PROTOCOL_FAILURE", "HostControl response ended with a partial frame."),
      );
      return;
    }
    if (
      this.#shutdownDeadline !== undefined &&
      (this.#state === "armed" || this.#state === "draining") &&
      performance.now() >= this.#shutdownDeadline
    ) {
      this.#fail(clientError("LIFECYCLE_TIMEOUT", "HostControl shutdown EOF missed its deadline."));
      return;
    }
    this.#readableEndObserved = true;
    if (
      this.#state === "open" ||
      this.#state === "arming" ||
      (this.#state === "draining" && (this.#pending.size !== 0 || !this.#writableEndStarted))
    ) {
      this.#fail(clientError("PROTOCOL_FAILURE", "HostControl peer closed unexpectedly."));
    }
  }

  #onClose(): void {
    this.#transportCloseObserved = true;
    if (
      this.#shutdownDeadline !== undefined &&
      (this.#state === "armed" || this.#state === "draining") &&
      performance.now() >= this.#shutdownDeadline
    ) {
      this.#fail(
        clientError("LIFECYCLE_TIMEOUT", "HostControl shutdown close missed its deadline."),
        false,
      );
    }
    if (!this.#readableEndObserved && this.#state !== "failed" && this.#state !== "closing") {
      try {
        this.#decoder.end();
      } catch {
        this.#fail(
          clientError("PROTOCOL_FAILURE", "HostControl response closed with a partial frame."),
          false,
        );
      }
      this.#fail(
        clientError("PROTOCOL_FAILURE", "HostControl peer closed before readable EOF."),
        false,
      );
    }
    if (
      this.#state === "open" ||
      this.#state === "arming" ||
      ((this.#state === "armed" || this.#state === "draining") &&
        !this.#writableHalfCloseObserved) ||
      (this.#state === "draining" && this.#pending.size !== 0)
    ) {
      this.#fail(clientError("PROTOCOL_FAILURE", "HostControl peer closed unexpectedly."), false);
    }
    this.#tryFinalizeClose();
  }

  #handleResponse(document: Buffer): void {
    const response = parseHostControlResponse(document);
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined) {
      throw new HostControlProtocolError("HostControl response has unknown correlation.");
    }
    if (document.byteLength > pending.responseMaximumBytes) {
      throw new HostControlProtocolError("HostControl response exceeds its operation limit.");
    }
    if (response.outcome === "error" && sessionFatalErrorCodes.has(response.error.code)) {
      this.#fail(clientError("PROTOCOL_FAILURE", "HostControl reported a fatal session error."));
      return;
    }
    let successValue: unknown;
    if (response.outcome === "ok") {
      if (pending.responseKind === "opaque-json") {
        try {
          successValue = decodeHostControlOpaqueJson(
            response.body,
            pending.decodedResponseMaximumBytes,
          );
        } catch {
          throw new HostControlProtocolError("HostControl response body descriptor is invalid.");
        }
      } else {
        successValue = response.body;
      }
    }
    this.#removePending(pending);

    if (pending.kind === "cancel") {
      if (
        (response.outcome === "ok" &&
          hasExactKeys(response.body, ["cancelled"]) &&
          response.body.cancelled === true) ||
        (response.outcome === "error" && response.error.code === "REQUEST_NOT_ACTIVE")
      ) {
        pending.callerSettled = true;
        pending.deferred.resolve(Object.freeze({ cancelled: response.outcome === "ok" }));
        return;
      }
      throw new HostControlProtocolError("HostControl cancel acknowledgement is invalid.");
    }

    if (!pending.callerSettled) {
      pending.callerSettled = true;
      if (response.outcome === "ok") pending.deferred.resolve(successValue);
      else pending.deferred.reject(response.error);
    }
  }

  #removePending(pending: PendingRequest): void {
    if (this.#pending.get(pending.id) !== pending) return;
    this.#pending.delete(pending.id);
    if (pending.timeout !== undefined) clearTimeout(pending.timeout);
    if (pending.cancellationTimeout !== undefined) clearTimeout(pending.cancellationTimeout);
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    if (pending.kind === "call") this.#activeCalls -= 1;
    if (this.#pending.size === 0) {
      for (const resolve of this.#pendingEmptyWaiters) resolve();
      this.#pendingEmptyWaiters.clear();
    }
  }

  #allocateRequestId(kind: "call" | "cancel"): string {
    if (this.#seenRequestIds.size >= this.#options.maximumRequestIds) {
      const error = clientError(
        "REQUEST_ID_CAPACITY",
        "HostControl request ID capacity is exhausted.",
      );
      this.#fail(error);
      throw error;
    }
    const requestId = this.#options.requestIdFactory(kind);
    if (!validHostControlEntityId(requestId) || this.#seenRequestIds.has(requestId)) {
      const error = clientError("PROTOCOL_FAILURE", "HostControl request ID source is invalid.");
      this.#fail(error);
      throw error;
    }
    this.#seenRequestIds.add(requestId);
    return requestId;
  }

  #reserveFrame(bytes: number): FrameReservation {
    if (this.#queuedWriteBytes + bytes > this.#options.maximumQueuedWriteBytes) {
      throw clientError(
        "OUTPUT_QUEUE_LIMIT_EXCEEDED",
        "HostControl outbound queue exceeds its byte limit.",
      );
    }
    const reservation: FrameReservation = { bytes, released: false };
    this.#queuedWriteBytes += bytes;
    this.#frameReservations.add(reservation);
    return reservation;
  }

  #releaseFrame(reservation: FrameReservation): void {
    if (reservation.released) return;
    reservation.released = true;
    this.#frameReservations.delete(reservation);
    this.#queuedWriteBytes -= reservation.bytes;
    if (this.#queuedWriteBytes < 0) {
      this.#queuedWriteBytes = 0;
      this.#fail(clientError("PROTOCOL_FAILURE", "HostControl queue accounting failed."));
    }
  }

  #enqueueFrame(frame: Buffer, reservation: FrameReservation): Promise<void> {
    const write = this.#writeChain.then(() => this.#writeFrame(frame));
    const settled = write.finally(() => this.#releaseFrame(reservation));
    this.#writeChain = settled.catch(() => undefined);
    return settled;
  }

  #writeFrame(frame: Buffer): Promise<void> {
    if (this.#state === "failed" || this.#state === "closed" || this.#state === "closing") {
      return Promise.reject(
        this.#terminalError ?? clientError("CLIENT_CLOSED", "HostControl client is closed."),
      );
    }
    return new Promise<void>((resolve, reject) => {
      try {
        this.#stream.write(frame, (error?: Error | null) => {
          if (error !== undefined && error !== null) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  #assertControlOperation(): void {
    if (this.#options.role !== "control") {
      const error = clientError(
        "OPERATION_NOT_ALLOWED",
        "Executor HostControl session cannot issue privileged RPC operations.",
      );
      this.#fail(error);
      throw error;
    }
  }

  #assertAccepting(): void {
    if (this.#state !== "open") {
      throw (
        this.#terminalError ??
        clientError("CLIENT_CLOSED", "HostControl client is not accepting requests.")
      );
    }
  }

  #fail(error: HostControlClientError, destroy = true): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    this.#state = "failed";
    this.#terminalError = error;
    this.#failure.reject(error);
    this.#rejectAll(error);
    for (const reservation of [...this.#frameReservations]) this.#releaseFrame(reservation);
    this.#tryFinalizeClose();
    if (destroy) {
      try {
        this.#stream.destroy();
      } catch {
        // The terminal state is already committed.
      }
    }
  }

  #rejectAll(error: HostControlClientError): void {
    for (const pending of [...this.#pending.values()]) {
      this.#removePending(pending);
      if (!pending.callerSettled) {
        pending.callerSettled = true;
        pending.deferred.reject(error);
      }
    }
  }

  #waitForPendingEmpty(): Promise<void> {
    if (this.#pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#pendingEmptyWaiters.add(resolve));
  }

  #endWritable(): Promise<void> {
    this.#writableEndStarted = true;
    return new Promise<void>((resolve, reject) => {
      const rejectHalfClose = (): void => {
        const error = clientError(
          "PROTOCOL_FAILURE",
          "HostControl writable half-close callback failed.",
        );
        this.#fail(error);
        reject(error);
      };
      try {
        this.#stream.end((error?: Error | null) => {
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
      const error = clientError(
        "LIFECYCLE_STATE_INVALID",
        "HostControl cannot drain while ARWX shutdown is arming.",
      );
      this.#fail(error);
      throw error;
    }
    this.#state = "draining";
    try {
      await this.#awaitDrainPhase(() => this.#waitForPendingEmpty(), deadline);
      await this.#awaitDrainPhase(() => this.#writeChain, deadline);
      await this.#awaitDrainPhase(() => this.#endWritable(), deadline);
      await this.#awaitDrainPhase(() => this.#closed.promise, deadline);
      if (this.#terminalError !== undefined) throw this.#terminalError;
    } catch {
      if (this.#terminalError !== undefined) throw this.#terminalError;
      const error = clientError("DRAIN_TIMEOUT", "HostControl drain did not finish in time.");
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
      this.#fail(clientError("CLIENT_CLOSED", "HostControl drain was interrupted by close."));
    } else if (this.#state !== "failed") {
      this.#state = "closing";
      this.#rejectAll(clientError("CLIENT_CLOSED", "HostControl client is closed."));
    }
    try {
      this.#stream.destroy();
    } catch {
      // The close event or deadline below remains authoritative.
    }
    try {
      await withDeadline(this.#closed.promise, remainingShutdownMilliseconds(deadline));
      remainingShutdownMilliseconds(deadline);
    } catch {
      throw clientError("CLOSE_TIMEOUT", "HostControl stream did not close in time.");
    }
  }

  async #awaitDrainPhase<T>(createPhase: () => Promise<T>, deadline: number): Promise<T> {
    const timeoutMs = remainingShutdownMilliseconds(deadline);
    const phase = createPhase();
    const result = await withDeadline(Promise.race([phase, this.#failure.promise]), timeoutMs);
    remainingShutdownMilliseconds(deadline);
    return result;
  }

  #settleArmOperation(operation: Promise<Readonly<ArmArwxShutdownResultV1>>): void {
    if (this.#armOperation !== operation) return;
    this.#armOperation = undefined;
    this.#tryFinalizeClose();
  }

  #tryFinalizeClose(): void {
    if (!this.#transportCloseObserved) return;
    if (this.#state === "failed") {
      this.#closed.resolve(undefined);
      return;
    }
    if (this.#armOperation !== undefined) return;
    if (
      this.#state !== "closing" &&
      (!this.#readableEndObserved ||
        !this.#writableHalfCloseObserved ||
        this.#activeCalls !== 0 ||
        this.#pending.size !== 0 ||
        this.#frameReservations.size !== 0 ||
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
  #settled = false;
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

function normalizeOptions(options: ControlHostControlConnectOptions): NormalizedOptions {
  if (options.role !== "control") {
    throw new TypeError("HostControl RPC role must be control.");
  }
  if (!isHostControlPipeSelector(options.pipe)) {
    throw new TypeError("HostControl pipe selector is invalid.");
  }
  if (typeof options.prepareRuntimeBootstrap !== "function") {
    throw new TypeError("HostControl runtime bootstrap preparation is required.");
  }
  return {
    role: options.role,
    pipe: options.pipe,
    prepareRuntimeBootstrap: options.prepareRuntimeBootstrap,
    maximumConcurrentRequests: boundedInteger(
      options.maximumConcurrentRequests ?? defaultMaximumConcurrentRequests,
      "maximumConcurrentRequests",
      1,
      maximumConfiguredConcurrency,
    ),
    maximumRequestIds: boundedInteger(
      options.maximumRequestIds ?? defaultMaximumRequestIds,
      "maximumRequestIds",
      1,
      maximumConfiguredRequestIds,
    ),
    maximumQueuedWriteBytes: boundedInteger(
      options.maximumQueuedWriteBytes ?? defaultMaximumQueuedWriteBytes,
      "maximumQueuedWriteBytes",
      HOST_CONTROL_MAXIMUM_REQUEST_FRAME_BYTES + 4,
      maximumConfiguredQueuedWriteBytes,
    ),
    connectTimeoutMs: boundedTimeout(options.connectTimeoutMs ?? defaultConnectTimeoutMs),
    requestTimeoutMs: boundedTimeout(options.requestTimeoutMs ?? defaultRequestTimeoutMs),
    claimTimeoutMs: boundedTimeout(options.claimTimeoutMs ?? defaultClaimTimeoutMs),
    cancellationGraceMs: boundedTimeout(options.cancellationGraceMs ?? defaultCancellationGraceMs),
    closeTimeoutMs: boundedTimeout(options.closeTimeoutMs ?? defaultCloseTimeoutMs),
    connector: options.connector ?? defaultConnector,
    requestIdFactory:
      options.requestIdFactory ??
      ((kind) => `${kind === "call" ? "request" : "cancel"}:${randomUUID()}`),
  };
}

async function connectWithDeadline(
  options: NormalizedOptions,
  absoluteDeadline: number,
  signal: AbortSignal | undefined,
): Promise<Duplex> {
  const connectionCancellation = new AbortController();
  const connection = Promise.resolve().then(() =>
    options.connector(options.pipe, connectionCancellation.signal),
  );
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
        reject(clientError("CONNECT_CANCELLED", "HostControl connection was cancelled."));
      });
    };
    timer = setTimeout(() => {
      finish(() => {
        connectionCancellation.abort();
        reject(clientError("CONNECT_TIMEOUT", "HostControl connection timed out."));
      });
    }, remainingMilliseconds(absoluteDeadline));
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    void connection.then(
      (stream) => {
        if (settled) {
          stream.destroy();
          return;
        }
        finish(() => resolve(stream));
      },
      () => {
        finish(() => reject(clientError("CONNECT_FAILED", "HostControl connection failed.")));
      },
    );
  });
}

const defaultConnector: HostControlConnector = async (pipe, cancellation) => {
  if (cancellation.aborted) {
    throw clientError("CONNECT_CANCELLED", "HostControl connection was cancelled.");
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
      reject(clientError("CONNECT_FAILED", "HostControl connection failed."));
    };
    const onAbort = (): void => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.destroy();
      reject(clientError("CONNECT_CANCELLED", "HostControl connection was cancelled."));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    cancellation.addEventListener("abort", onAbort, { once: true });
  });
};

function assertEntityId(value: string, name: string): void {
  if (!validHostControlEntityId(value)) {
    throw clientError("REQUEST_INVALID", `${name} is not a valid local RPC entity ID.`);
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumConfiguredTimeoutMs) {
    throw new RangeError(
      `HostControl timeout must be from 1 through ${maximumConfiguredTimeoutMs} milliseconds.`,
    );
  }
  return value;
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
    throw new TypeError("HostControl shutdown deadline must be finite.");
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
    throw clientError("LIFECYCLE_TIMEOUT", "HostControl ARWX shutdown deadline expired.");
  }
  return remaining;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(clientError("CLOSE_TIMEOUT", "HostControl close deadline expired."));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function clientError(
  code: HostControlClientError["code"],
  message: string,
): HostControlClientError {
  return new HostControlClientError(code, message);
}
