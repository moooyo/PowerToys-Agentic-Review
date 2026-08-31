import { createHash, randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
  assertLocalMessageSender,
  type DecodedLocalFrame,
  type DeepReadonly,
  encodeLocalFrame,
  IncrementalLocalFrameDecoder,
  LOCAL_PROTOCOL_MAX_FRAME_BYTES,
  type LocalMessagePayload,
  LocalMessageType,
  type LocalMessageTypeId,
  validateLocalMessagePayload,
} from "@agentic-review/local-protocol";

export const SERVICE_HOST_ARWX_MAXIMUM_QUEUED_WRITE_BYTES = 4 * 1_024 * 1_024;

export type ArwxPeerRole = "control" | "executor";
export type ArwxStdioChannelState = "open" | "draining" | "closed" | "failed";

export interface ArwxOutboundMessage {
  readonly messageType: LocalMessageTypeId;
  readonly correlationId: string;
  readonly payload: unknown;
}

export interface ArwxInboundMessage {
  readonly sequence: bigint;
  readonly messageType: LocalMessageTypeId;
  readonly correlationId: string;
  readonly payload: DeepReadonly<LocalMessagePayload>;
}

export interface ArwxStdioChannelOptions {
  readonly localRole: ArwxPeerRole;
  readonly input: Readable;
  readonly output: Writable;
  readonly maximumQueuedWriteBytes?: number;
  readonly closeTimeoutMs?: number;
}

declare const arwxBootstrapReceiveLoopTokenBrand: unique symbol;

export interface ArwxBootstrapReceiveLoopToken {
  readonly localRole: ArwxPeerRole;
  readonly [arwxBootstrapReceiveLoopTokenBrand]: true;
}

export interface ArwxBootstrapReceiveLoop {
  readonly token: ArwxBootstrapReceiveLoopToken;
  readonly done: Promise<void>;
}

declare const arwxFinalFrameReceiptBrand: unique symbol;

export interface ArwxFinalFrameReceipt {
  readonly localRole: ArwxPeerRole;
  readonly [arwxFinalFrameReceiptBrand]: true;
}

export interface ArwxFinalFrameBinding {
  readonly localRole: ArwxPeerRole;
  readonly shutdownId: string;
  readonly absoluteDeadline: number;
  readonly finalMessageType: 14 | 15;
  readonly finalSequence: bigint;
  readonly finalCorrelationId: string;
  readonly finalFrameBytes: number;
  readonly finalFrameSha256: string;
}

interface ArwxBootstrapReceiveLoopState {
  readonly channel: ArwxStdioChannel;
  readonly localRole: ArwxPeerRole;
  readonly done: Promise<void>;
  consumed: boolean;
}

interface ArwxLifecycleState {
  activeDispatches: number;
  finalOutboundStarted: boolean;
  finalReceipt: ArwxFinalFrameReceipt | undefined;
  peerFinalObserved: boolean;
  armPhase: "idle" | "arming" | "armed";
  absoluteShutdownDeadline: number | undefined;
  readonly commitArm: () => boolean;
  readonly failArm: () => void;
}

interface ArwxFinalFrameReceiptState extends ArwxFinalFrameBinding {
  readonly channel: ArwxStdioChannel;
  readonly lifecycle: ArwxLifecycleState;
  consumed: boolean;
}

const arwxBootstrapReceiveLoopStates = new WeakMap<object, ArwxBootstrapReceiveLoopState>();
const arwxFinalFrameReceiptStates = new WeakMap<object, ArwxFinalFrameReceiptState>();

export class ArwxStdioChannelError extends Error {
  public constructor(
    public readonly code:
      | "ABORTED"
      | "CHANNEL_STATE_INVALID"
      | "DISPATCH_FAILED"
      | "FRAME_INVALID"
      | "INPUT_FAILED"
      | "MESSAGE_DIRECTION_INVALID"
      | "MESSAGE_INVALID"
      | "OUTPUT_FAILED"
      | "OUTPUT_QUEUE_LIMIT_EXCEEDED"
      | "SEQUENCE_EXHAUSTED"
      | "SHUTDOWN_STATE_INVALID"
      | "UNEXPECTED_EOF",
    message: string,
  ) {
    super(message);
    this.name = "ArwxStdioChannelError";
  }
}

interface QueuedWrite {
  readonly frame: Buffer;
  readonly deferred: Deferred<void>;
}

const maximumSequence = (1n << 64n) - 1n;
const defaultCloseTimeoutMs = 15_000;
const maximumCloseTimeoutMs = 10 * 60 * 1_000;

export class ArwxStdioChannel {
  public readonly localRole: ArwxPeerRole;
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #decoder = new IncrementalLocalFrameDecoder({
    minorVersion: 0,
    expectedSequence: 1n,
    maximumBufferedBytes: LOCAL_PROTOCOL_MAX_FRAME_BYTES,
  });
  readonly #maximumQueuedWriteBytes: number;
  readonly #closeTimeoutMs: number;
  readonly #writes: QueuedWrite[] = [];
  readonly #runDone = new Deferred<void>();
  readonly #outputDone = new Deferred<void>();
  readonly #failure = new Deferred<never>();
  readonly #shutdownArmCommitted = new Deferred<void>();
  readonly #lifecycle: ArwxLifecycleState = {
    activeDispatches: 0,
    finalOutboundStarted: false,
    finalReceipt: undefined,
    peerFinalObserved: false,
    armPhase: "idle",
    absoluteShutdownDeadline: undefined,
    commitArm: () => this.#commitArmedShutdown(),
    failArm: () => this.abort(),
  };
  #state: ArwxStdioChannelState = "open";
  #nextOutboundSequence = 1n;
  #queuedWriteBytes = 0;
  #writing = false;
  #runStarted = false;
  #inputFinished = false;
  #outputFinished = false;
  #terminalError: ArwxStdioChannelError | undefined;
  #drainPromise: Promise<void> | undefined;

  public constructor(options: ArwxStdioChannelOptions) {
    if (options.localRole !== "control" && options.localRole !== "executor") {
      throw new TypeError("ARWX local role must be control or executor.");
    }
    this.localRole = options.localRole;
    this.#input = options.input;
    this.#output = options.output;
    this.#maximumQueuedWriteBytes = boundedInteger(
      options.maximumQueuedWriteBytes ?? SERVICE_HOST_ARWX_MAXIMUM_QUEUED_WRITE_BYTES,
      "maximumQueuedWriteBytes",
      LOCAL_PROTOCOL_MAX_FRAME_BYTES,
      64 * 1_024 * 1_024,
    );
    this.#closeTimeoutMs = boundedInteger(
      options.closeTimeoutMs ?? defaultCloseTimeoutMs,
      "closeTimeoutMs",
      1,
      maximumCloseTimeoutMs,
    );
    this.#input.once("error", () => {
      this.#fail(arwxError("INPUT_FAILED", "ARWX standard input failed."));
    });
    this.#input.once("end", () => {
      if (!this.#runStarted && this.#state !== "failed") {
        this.#fail(
          arwxError("UNEXPECTED_EOF", "ARWX input ended before its receive loop started."),
        );
      }
    });
    this.#input.once("close", () => {
      if (!this.#runStarted && this.#state !== "failed") {
        this.#fail(
          arwxError("UNEXPECTED_EOF", "ARWX input closed before its receive loop started."),
        );
      }
    });
    this.#output.once("error", () => {
      this.#fail(arwxError("OUTPUT_FAILED", "ARWX standard output failed."));
    });
    this.#output.once("close", () => {
      if (!this.#outputFinished && this.#state !== "failed") {
        this.#fail(arwxError("OUTPUT_FAILED", "ARWX standard output closed unexpectedly."));
      }
    });
  }

  public get state(): ArwxStdioChannelState {
    return this.#state;
  }

  public get receiveLoopStarted(): boolean {
    return this.#runStarted;
  }

  public get configuredMaximumQueuedWriteBytes(): number {
    return this.#maximumQueuedWriteBytes;
  }

  public get configuredCloseTimeoutMs(): number {
    return this.#closeTimeoutMs;
  }

  /** Starts one pre-commit receiver and issues a channel-bound, single-use readiness token. */
  public startRuntimeBootstrapReceiveLoop(
    handler: (message: Readonly<ArwxInboundMessage>) => void | Promise<void>,
  ): Readonly<ArwxBootstrapReceiveLoop> {
    if (this.#runStarted || this.#state !== "open") {
      throw arwxError(
        "CHANNEL_STATE_INVALID",
        "ARWX runtime bootstrap guard can start only once on an open channel.",
      );
    }
    if (typeof handler !== "function") {
      throw new TypeError("ARWX runtime bootstrap receive handler is required.");
    }
    const done = this.run(handler);
    done.catch(() => undefined);
    const token = Object.freeze({ localRole: this.localRole }) as ArwxBootstrapReceiveLoopToken;
    arwxBootstrapReceiveLoopStates.set(token, {
      channel: this,
      localRole: this.localRole,
      done,
      consumed: false,
    });
    return Object.freeze({ token, done });
  }

  public async run(
    handler: (message: Readonly<ArwxInboundMessage>) => void | Promise<void>,
  ): Promise<void> {
    if (this.#runStarted) {
      throw arwxError("CHANNEL_STATE_INVALID", "ARWX input loop can run only once.");
    }
    if (this.#state !== "open" && this.#state !== "draining") {
      throw (
        this.#terminalError ?? arwxError("CHANNEL_STATE_INVALID", "ARWX channel is not readable.")
      );
    }
    this.#runStarted = true;
    try {
      for await (const value of this.#input) {
        const chunk = value instanceof Uint8Array ? value : Buffer.from(String(value), "utf8");
        let frames: readonly DecodedLocalFrame[];
        try {
          frames = this.#decoder.push(chunk);
        } catch {
          throw arwxError("FRAME_INVALID", "ARWX input frame is invalid.");
        }
        for (const frame of frames) {
          if (this.#terminalError !== undefined) throw this.#terminalError;
          const expectedPeerFinal =
            this.localRole === "control" ? LocalMessageType.Drained : LocalMessageType.Drain;
          if (frame.messageType === expectedPeerFinal) {
            if (
              this.#lifecycle.peerFinalObserved ||
              (this.localRole === "control" && !this.#lifecycle.finalOutboundStarted)
            ) {
              throw arwxError(
                "SHUTDOWN_STATE_INVALID",
                "ARWX peer final frame is duplicate or out of order.",
              );
            }
            this.#lifecycle.peerFinalObserved = true;
          } else if (
            this.#lifecycle.peerFinalObserved ||
            this.#lifecycle.finalOutboundStarted ||
            this.#lifecycle.armPhase !== "idle"
          ) {
            throw arwxError(
              "SHUTDOWN_STATE_INVALID",
              "ARWX received a business message after shutdown started.",
            );
          }
          const message = this.#validateInbound(frame);
          this.#lifecycle.activeDispatches += 1;
          try {
            await handler(message);
          } catch {
            throw arwxError("DISPATCH_FAILED", "ARWX message handler failed.");
          } finally {
            this.#lifecycle.activeDispatches -= 1;
          }
        }
      }
      try {
        this.#decoder.end();
      } catch {
        throw arwxError("FRAME_INVALID", "ARWX input ended with a partial frame.");
      }
      this.#inputFinished = true;
      if (this.#lifecycle.finalOutboundStarted) {
        const deadline = this.#lifecycle.absoluteShutdownDeadline;
        if (deadline === undefined) {
          throw arwxError("SHUTDOWN_STATE_INVALID", "ARWX shutdown deadline is unavailable.");
        }
        if (this.#lifecycle.armPhase !== "armed") {
          try {
            await withTimeout(
              Promise.race([this.#shutdownArmCommitted.promise, this.#failure.promise]),
              remainingShutdownMilliseconds(deadline),
            );
          } catch {
            if (this.#terminalError !== undefined) throw this.#terminalError;
            throw arwxError(
              "SHUTDOWN_STATE_INVALID",
              "ARWX shutdown was not armed before its input deadline.",
            );
          }
        }
        if (!this.#lifecycle.peerFinalObserved || this.#state !== "draining") {
          throw arwxError(
            "SHUTDOWN_STATE_INVALID",
            "ARWX peer final frame or armed drain state is missing.",
          );
        }
      } else if (this.#state !== "draining") {
        throw arwxError("UNEXPECTED_EOF", "ARWX input ended before an orderly drain.");
      }
      await this.#outputDone.promise;
      if (this.#terminalError !== undefined) throw this.#terminalError;
      this.#runDone.resolve(undefined);
    } catch (error) {
      const failure =
        error instanceof ArwxStdioChannelError
          ? error
          : arwxError("INPUT_FAILED", "ARWX standard input failed.");
      this.#fail(failure);
      throw this.#terminalError;
    }
  }

  public send(message: ArwxOutboundMessage): Promise<void> {
    return this.#queueOutbound(message, false).deferred.promise;
  }

  /** Writes the role's final shutdown frame and returns authority derived from the exact bytes. */
  public async sendFinal(
    message: ArwxOutboundMessage,
    absoluteShutdownDeadline: number,
  ): Promise<ArwxFinalFrameReceipt> {
    const now = performance.now();
    if (
      !Number.isFinite(absoluteShutdownDeadline) ||
      absoluteShutdownDeadline <= now ||
      absoluteShutdownDeadline - now > this.#closeTimeoutMs
    ) {
      const error = arwxError(
        "SHUTDOWN_STATE_INVALID",
        "ARWX final frame deadline is outside the configured shutdown budget.",
      );
      this.#fail(error);
      throw error;
    }
    const expectedMessageType =
      this.localRole === "control" ? LocalMessageType.Drain : LocalMessageType.Drained;
    if (message.messageType !== expectedMessageType) {
      const error = arwxError(
        "SHUTDOWN_STATE_INVALID",
        "ARWX final frame type is invalid for the local role.",
      );
      this.#fail(error);
      throw error;
    }
    if (this.localRole === "executor" && !this.#lifecycle.peerFinalObserved) {
      const error = arwxError(
        "SHUTDOWN_STATE_INVALID",
        "Executor ARWX cannot send Drained before receiving Drain.",
      );
      this.#fail(error);
      throw error;
    }
    this.#lifecycle.absoluteShutdownDeadline = absoluteShutdownDeadline;
    const queued = this.#queueOutbound(message, true);
    try {
      await withTimeout(
        Promise.race([queued.deferred.promise, this.#failure.promise]),
        remainingShutdownMilliseconds(absoluteShutdownDeadline),
      );
    } catch {
      if (this.#terminalError !== undefined) throw this.#terminalError;
      const error = arwxError("OUTPUT_FAILED", "ARWX final frame write timed out.");
      this.#fail(error);
      throw error;
    }
    if (this.#state !== "open" || this.#lifecycle.finalReceipt !== undefined) {
      const error = arwxError(
        "SHUTDOWN_STATE_INVALID",
        "ARWX final frame receipt state is invalid.",
      );
      this.#fail(error);
      throw error;
    }
    const receipt = Object.freeze({ localRole: this.localRole }) as ArwxFinalFrameReceipt;
    const state: ArwxFinalFrameReceiptState = {
      channel: this,
      lifecycle: this.#lifecycle,
      localRole: this.localRole,
      shutdownId: randomUUID(),
      absoluteDeadline: absoluteShutdownDeadline,
      finalMessageType: expectedMessageType,
      finalSequence: queued.sequence,
      finalCorrelationId: message.correlationId,
      finalFrameBytes: queued.frame.byteLength,
      finalFrameSha256: createHash("sha256").update(queued.frame).digest("hex"),
      consumed: false,
    };
    arwxFinalFrameReceiptStates.set(receipt, state);
    this.#lifecycle.finalReceipt = receipt;
    return receipt;
  }

  #queueOutbound(
    message: ArwxOutboundMessage,
    final: boolean,
  ): QueuedWrite & { readonly sequence: bigint } {
    if (this.#state !== "open") {
      throw (
        this.#terminalError ??
        arwxError("CHANNEL_STATE_INVALID", "ARWX channel is not accepting messages.")
      );
    }
    if (this.#lifecycle.finalOutboundStarted) {
      const error = arwxError(
        "SHUTDOWN_STATE_INVALID",
        "ARWX does not accept messages after its final outbound frame.",
      );
      this.#fail(error);
      throw error;
    }
    if (final) this.#lifecycle.finalOutboundStarted = true;
    if (this.#nextOutboundSequence > maximumSequence) {
      const error = arwxError("SEQUENCE_EXHAUSTED", "ARWX outbound sequence is exhausted.");
      this.#fail(error);
      throw error;
    }
    try {
      assertLocalMessageSender(message.messageType, this.localRole);
    } catch {
      const error = arwxError(
        "MESSAGE_DIRECTION_INVALID",
        "ARWX message type is invalid for the local role.",
      );
      this.#fail(error);
      throw error;
    }
    let payload: DeepReadonly<LocalMessagePayload>;
    try {
      payload = validateLocalMessagePayload(
        message.messageType,
        message.payload,
        message.correlationId,
      );
    } catch {
      const error = arwxError("MESSAGE_INVALID", "ARWX outbound message is invalid.");
      this.#fail(error);
      throw error;
    }
    let frame: Buffer;
    try {
      frame = encodeLocalFrame({
        minorVersion: 0,
        messageType: message.messageType,
        sequence: this.#nextOutboundSequence,
        correlationId: message.correlationId,
        payload,
      });
    } catch {
      const error = arwxError("FRAME_INVALID", "ARWX outbound frame is invalid.");
      this.#fail(error);
      throw error;
    }
    if (this.#queuedWriteBytes + frame.byteLength > this.#maximumQueuedWriteBytes) {
      const error = arwxError(
        "OUTPUT_QUEUE_LIMIT_EXCEEDED",
        "ARWX outbound queue exceeds its byte limit.",
      );
      this.#fail(error);
      throw error;
    }

    const sequence = this.#nextOutboundSequence;
    this.#nextOutboundSequence += 1n;
    const queued: QueuedWrite = { frame, deferred: new Deferred<void>() };
    this.#writes.push(queued);
    this.#queuedWriteBytes += frame.byteLength;
    this.#pumpWrites();
    return { ...queued, sequence };
  }

  public drain(): Promise<void> {
    this.#drainPromise ??= this.#drain();
    return this.#drainPromise;
  }

  public close(): Promise<void> {
    return this.drain();
  }

  public abort(): void {
    this.#fail(arwxError("ABORTED", "ARWX channel was aborted."));
  }

  #validateInbound(frame: DecodedLocalFrame): Readonly<ArwxInboundMessage> {
    const remoteRole = this.localRole === "control" ? "executor" : "control";
    try {
      assertLocalMessageSender(frame.messageType, remoteRole);
    } catch {
      throw arwxError(
        "MESSAGE_DIRECTION_INVALID",
        "ARWX inbound message type is invalid for the remote role.",
      );
    }
    let payload: DeepReadonly<LocalMessagePayload>;
    try {
      payload = validateLocalMessagePayload(frame.messageType, frame.payload, frame.correlationId);
    } catch {
      throw arwxError("MESSAGE_INVALID", "ARWX inbound message is invalid.");
    }
    return Object.freeze({
      sequence: frame.sequence,
      messageType: frame.messageType,
      correlationId: frame.correlationId,
      payload,
    });
  }

  #pumpWrites(): void {
    if (this.#writing || this.#state === "failed") return;
    const queued = this.#writes[0];
    if (queued === undefined) return;
    this.#writing = true;
    try {
      this.#output.write(queued.frame, (error?: Error | null) => {
        this.#writing = false;
        if (this.#state === "failed") return;
        if (this.#writes[0] !== queued) {
          this.#fail(arwxError("OUTPUT_FAILED", "ARWX output queue ownership changed."));
          return;
        }
        if (error !== undefined && error !== null) {
          this.#fail(arwxError("OUTPUT_FAILED", "ARWX standard output write failed."));
          return;
        }
        this.#writes.shift();
        this.#queuedWriteBytes -= queued.frame.byteLength;
        queued.deferred.resolve(undefined);
        this.#pumpWrites();
      });
    } catch {
      this.#writing = false;
      this.#fail(arwxError("OUTPUT_FAILED", "ARWX standard output write failed."));
    }
  }

  async #drain(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "failed") throw this.#terminalError;
    if (this.#lifecycle.finalOutboundStarted && this.#lifecycle.armPhase !== "armed") {
      const error = arwxError(
        "SHUTDOWN_STATE_INVALID",
        "ARWX cannot drain before its final frame is armed.",
      );
      this.#fail(error);
      throw error;
    }
    this.#state = "draining";
    const deadline =
      this.#lifecycle.absoluteShutdownDeadline ?? performance.now() + this.#closeTimeoutMs;
    try {
      await this.#awaitDrainPhase(this.#waitForWrites(), deadline);
      await this.#awaitDrainPhase(this.#finishOutput(), deadline);
      await this.#awaitDrainPhase(this.#runDone.promise, deadline);
      if (!this.#inputFinished || !this.#outputFinished) {
        throw arwxError("UNEXPECTED_EOF", "ARWX channel did not finish both stream directions.");
      }
      if (this.#lifecycle.absoluteShutdownDeadline !== undefined) {
        remainingShutdownMilliseconds(deadline);
      }
      this.#state = "closed";
    } catch {
      if (this.#terminalError !== undefined) throw this.#terminalError;
      const error = arwxError("OUTPUT_FAILED", "ARWX channel drain timed out.");
      this.#fail(error);
      throw error;
    }
  }

  async #waitForWrites(): Promise<void> {
    while (this.#writes.length > 0 || this.#writing) {
      const pending = this.#writes.map((entry) => entry.deferred.promise);
      if (pending.length === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      } else {
        await Promise.all(pending);
      }
    }
  }

  #finishOutput(): Promise<void> {
    if (this.#outputFinished) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      try {
        this.#output.end(() => {
          this.#outputFinished = true;
          this.#outputDone.resolve(undefined);
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  #commitArmedShutdown(): boolean {
    const deadline = this.#lifecycle.absoluteShutdownDeadline;
    if (this.#state !== "open" || this.#lifecycle.armPhase !== "arming" || deadline === undefined) {
      return false;
    }
    try {
      remainingShutdownMilliseconds(deadline);
    } catch {
      this.#fail(arwxError("SHUTDOWN_STATE_INVALID", "ARWX shutdown deadline expired."));
      return false;
    }
    this.#lifecycle.armPhase = "armed";
    this.#state = "draining";
    this.#shutdownArmCommitted.resolve(undefined);
    const draining = this.drain();
    draining.catch(() => undefined);
    if (this.#terminalError !== undefined) return false;
    return true;
  }

  #fail(error: ArwxStdioChannelError): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    this.#state = "failed";
    this.#terminalError = error;
    this.#failure.reject(error);
    for (const queued of this.#writes.splice(0)) queued.deferred.reject(error);
    this.#queuedWriteBytes = 0;
    this.#runDone.reject(error);
    this.#outputDone.reject(error);
    try {
      this.#input.destroy();
    } catch {
      // The terminal state is already committed.
    }
    try {
      this.#output.destroy();
    } catch {
      // The terminal state is already committed.
    }
  }

  #awaitDrainPhase<T>(phase: Promise<T>, deadline: number): Promise<T> {
    const timeout =
      this.#lifecycle.absoluteShutdownDeadline === undefined
        ? remainingMilliseconds(deadline)
        : remainingShutdownMilliseconds(deadline);
    return withTimeout(Promise.race([phase, this.#failure.promise]), timeout);
  }
}

/** Consumes a genuine bootstrap-guard token for one exact live channel and role. */
export function consumeArwxBootstrapReceiveLoopToken(
  token: ArwxBootstrapReceiveLoopToken,
  channel: ArwxStdioChannel,
  role: ArwxPeerRole,
): Promise<void> | undefined {
  const state = arwxBootstrapReceiveLoopStates.get(token);
  if (
    state === undefined ||
    state.consumed ||
    state.channel !== channel ||
    state.localRole !== role ||
    channel.localRole !== role ||
    channel.state !== "open" ||
    !channel.receiveLoopStarted
  ) {
    return undefined;
  }
  state.consumed = true;
  return state.done;
}

/** Consumes authority for the exact final frame only after dispatch and output are quiescent. */
export function consumeArwxFinalFrameReceipt(
  receipt: ArwxFinalFrameReceipt,
  channel: ArwxStdioChannel,
  role: ArwxPeerRole,
): Readonly<ArwxFinalFrameBinding> | undefined {
  const state = arwxFinalFrameReceiptStates.get(receipt);
  if (state === undefined || state.consumed) return undefined;
  state.consumed = true;
  if (
    state.channel !== channel ||
    state.lifecycle.finalReceipt !== receipt ||
    state.lifecycle.armPhase !== "idle" ||
    state.lifecycle.activeDispatches !== 0 ||
    state.localRole !== role ||
    channel.localRole !== role ||
    channel.state !== "open" ||
    state.absoluteDeadline <= performance.now()
  ) {
    return undefined;
  }
  state.lifecycle.armPhase = "arming";
  return Object.freeze({
    localRole: state.localRole,
    shutdownId: state.shutdownId,
    absoluteDeadline: state.absoluteDeadline,
    finalMessageType: state.finalMessageType,
    finalSequence: state.finalSequence,
    finalCorrelationId: state.finalCorrelationId,
    finalFrameBytes: state.finalFrameBytes,
    finalFrameSha256: state.finalFrameSha256,
  });
}

/** Reads only the deadline of an unconsumed receipt bound to this exact channel and role. */
export function readArwxFinalFrameReceiptDeadline(
  receipt: ArwxFinalFrameReceipt,
  channel: ArwxStdioChannel,
  role: ArwxPeerRole,
): number | undefined {
  const state = arwxFinalFrameReceiptStates.get(receipt);
  if (
    state === undefined ||
    state.consumed ||
    state.channel !== channel ||
    state.lifecycle.finalReceipt !== receipt ||
    state.localRole !== role ||
    channel.localRole !== role
  ) {
    return undefined;
  }
  return state.absoluteDeadline;
}

/** Commits the pending arm only after HostControl returned its exact success echo. */
export function commitArwxFinalFrameReceipt(receipt: ArwxFinalFrameReceipt): boolean {
  const state = arwxFinalFrameReceiptStates.get(receipt);
  if (state === undefined || !state.consumed || state.lifecycle.finalReceipt !== receipt) {
    return false;
  }
  return state.lifecycle.commitArm();
}

/** Makes a pending final-frame arm terminal after any HostControl failure or timeout. */
export function failArwxFinalFrameReceipt(receipt: ArwxFinalFrameReceipt): void {
  const state = arwxFinalFrameReceiptStates.get(receipt);
  if (state !== undefined && state.lifecycle.finalReceipt === receipt) {
    state.lifecycle.failArm();
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

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

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

function arwxError(code: ArwxStdioChannelError["code"], message: string): ArwxStdioChannelError {
  return new ArwxStdioChannelError(code, message);
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(1, deadline - performance.now());
}

function remainingShutdownMilliseconds(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) {
    throw arwxError("SHUTDOWN_STATE_INVALID", "ARWX shutdown deadline expired.");
  }
  return remaining;
}
