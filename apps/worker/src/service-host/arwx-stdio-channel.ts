import type { Readable, Writable } from "node:stream";
import {
  assertLocalMessageSender,
  type DecodedLocalFrame,
  type DeepReadonly,
  encodeLocalFrame,
  IncrementalLocalFrameDecoder,
  LOCAL_PROTOCOL_MAX_FRAME_BYTES,
  type LocalMessagePayload,
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
          const message = this.#validateInbound(frame);
          try {
            await handler(message);
          } catch {
            throw arwxError("DISPATCH_FAILED", "ARWX message handler failed.");
          }
        }
      }
      try {
        this.#decoder.end();
      } catch {
        throw arwxError("FRAME_INVALID", "ARWX input ended with a partial frame.");
      }
      if (this.#state !== "draining") {
        throw arwxError("UNEXPECTED_EOF", "ARWX input ended before an orderly drain.");
      }
      this.#inputFinished = true;
      await this.#outputDone.promise;
      if (this.#terminalError !== undefined) throw this.#terminalError;
      this.#state = "closed";
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
    if (this.#state !== "open") {
      throw (
        this.#terminalError ??
        arwxError("CHANNEL_STATE_INVALID", "ARWX channel is not accepting messages.")
      );
    }
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

    this.#nextOutboundSequence += 1n;
    const queued: QueuedWrite = { frame, deferred: new Deferred<void>() };
    this.#writes.push(queued);
    this.#queuedWriteBytes += frame.byteLength;
    this.#pumpWrites();
    return queued.deferred.promise;
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
    this.#state = "draining";
    const deadline = performance.now() + this.#closeTimeoutMs;
    try {
      await this.#awaitDrainPhase(this.#waitForWrites(), deadline);
      await this.#awaitDrainPhase(this.#finishOutput(), deadline);
      await this.#awaitDrainPhase(this.#runDone.promise, deadline);
      if (!this.#inputFinished || !this.#outputFinished) {
        throw arwxError("UNEXPECTED_EOF", "ARWX channel did not finish both stream directions.");
      }
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

  #fail(error: ArwxStdioChannelError): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    this.#state = "failed";
    this.#terminalError = error;
    this.#failure.reject(error);
    for (const queued of this.#writes.splice(0)) queued.deferred.reject(error);
    this.#queuedWriteBytes = 0;
    this.#runDone.reject(error);
    this.#outputDone.reject(error);
    this.#input.destroy();
    this.#output.destroy();
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
