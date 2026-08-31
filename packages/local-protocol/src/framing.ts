import { parseCanonicalJson, serializeCanonicalJson } from "./canonical.js";

export const LOCAL_PROTOCOL_MAGIC = "ARWX" as const;
export const LOCAL_PROTOCOL_HEADER_BYTES = 48;
export const LOCAL_PROTOCOL_MAJOR_VERSION = 1;
export const LOCAL_PROTOCOL_MINOR_VERSION = 0;
export const LOCAL_PROTOCOL_MAX_FRAME_BYTES = 1_048_576;
export const LOCAL_PROTOCOL_MAX_PAYLOAD_BYTES =
  LOCAL_PROTOCOL_MAX_FRAME_BYTES - LOCAL_PROTOCOL_HEADER_BYTES;
export const LOCAL_PROTOCOL_MAX_ARTIFACT_CHUNK_BYTES = 256 * 1_024;
export const LOCAL_PROTOCOL_NIL_CORRELATION_ID = "00000000-0000-0000-0000-000000000000";

export const LocalMessageType = Object.freeze({
  Hello: 1,
  HelloAck: 2,
  Ready: 3,
  StartAttempt: 4,
  RenewGrant: 5,
  CancelAttempt: 6,
  CancelAck: 7,
  Progress: 8,
  ArtifactStart: 9,
  ArtifactChunk: 10,
  ArtifactEnd: 11,
  Complete: 12,
  Failed: 13,
  Drain: 14,
  Drained: 15,
  Ping: 16,
  Pong: 17,
  TerminalDisposition: 18,
  TerminalAck: 19,
  ControlProof: 20,
} as const);

export type LocalMessageType = (typeof LocalMessageType)[keyof typeof LocalMessageType];
export type LocalMessageTypeId = LocalMessageType;
export type LocalProtocolSequence = bigint | number;
export type LocalJsonPrimitive = null | boolean | number | string;
export type LocalJsonValue = LocalJsonPrimitive | readonly LocalJsonValue[] | LocalJsonObject;

export interface LocalJsonObject {
  readonly [key: string]: LocalJsonValue;
}

export interface EncodeLocalFrameInput {
  readonly minorVersion: number;
  readonly messageType: LocalMessageType;
  readonly sequence: LocalProtocolSequence;
  readonly correlationId: string;
  readonly payload: unknown;
}

export interface DecodedLocalFrame {
  readonly majorVersion: typeof LOCAL_PROTOCOL_MAJOR_VERSION;
  readonly minorVersion: number;
  readonly messageType: LocalMessageType;
  readonly sequence: bigint;
  readonly correlationId: string;
  readonly payload: LocalJsonObject;
}

export interface IncrementalLocalFrameDecoderOptions {
  readonly minorVersion: number;
  readonly expectedSequence?: LocalProtocolSequence;
  readonly maximumBufferedBytes?: number;
}

export class LocalProtocolError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalProtocolError";
  }
}

const MAXIMUM_SEQUENCE = (1n << 64n) - 1n;
const ATTEMPT_CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const MESSAGE_TYPES = new Set<number>(Object.values(LocalMessageType));
const SESSION_MESSAGE_TYPES = new Set<LocalMessageType>([
  LocalMessageType.Hello,
  LocalMessageType.HelloAck,
  LocalMessageType.Ready,
  LocalMessageType.Drain,
  LocalMessageType.Drained,
  LocalMessageType.Ping,
  LocalMessageType.Pong,
  LocalMessageType.ControlProof,
]);

interface ParsedHeader {
  readonly minorVersion: number;
  readonly messageType: LocalMessageType;
  readonly payloadLength: number;
  readonly totalLength: number;
  readonly sequence: bigint;
  readonly correlationId: string;
}

export function encodeLocalFrame(input: EncodeLocalFrameInput): Buffer {
  const minorVersion = assertUnsignedInteger(input.minorVersion, 16, "minorVersion");
  const messageType = assertMessageType(input.messageType);
  const sequence = normalizeSequence(input.sequence, "sequence");
  const correlationId = assertCorrelationId(input.correlationId, messageType);
  const serializedPayload = serializeCanonicalPayload(input.payload);
  const payloadBytes = Buffer.from(serializedPayload, "utf8");

  if (payloadBytes.byteLength > LOCAL_PROTOCOL_MAX_PAYLOAD_BYTES) {
    throw new LocalProtocolError(
      `Local protocol payload exceeds the ${LOCAL_PROTOCOL_MAX_PAYLOAD_BYTES}-byte limit.`,
    );
  }

  const frame = Buffer.allocUnsafe(LOCAL_PROTOCOL_HEADER_BYTES + payloadBytes.byteLength);
  frame.write(LOCAL_PROTOCOL_MAGIC, 0, 4, "ascii");
  frame.writeUInt16LE(LOCAL_PROTOCOL_HEADER_BYTES, 4);
  frame.writeUInt16LE(LOCAL_PROTOCOL_MAJOR_VERSION, 6);
  frame.writeUInt16LE(minorVersion, 8);
  frame.writeUInt16LE(messageType, 10);
  frame.writeUInt32LE(0, 12);
  frame.writeUInt32LE(payloadBytes.byteLength, 16);
  frame.writeBigUInt64LE(sequence, 20);
  correlationIdToBytes(correlationId).copy(frame, 28);
  frame.writeUInt32LE(0, 44);
  payloadBytes.copy(frame, LOCAL_PROTOCOL_HEADER_BYTES);
  return frame;
}

export function decodeLocalFrame(
  bytes: Uint8Array,
  expectedSequence?: LocalProtocolSequence,
): DecodedLocalFrame {
  const normalizedExpected =
    expectedSequence === undefined
      ? undefined
      : normalizeSequence(expectedSequence, "expectedSequence");
  return decodeFrame(bytes, LOCAL_PROTOCOL_MINOR_VERSION, normalizedExpected);
}

export class IncrementalLocalFrameDecoder {
  readonly #minorVersion: number;
  readonly #maximumBufferedBytes: number;
  readonly #header = Buffer.alloc(LOCAL_PROTOCOL_HEADER_BYTES);
  #headerLength = 0;
  #frame: Buffer | undefined;
  #frameLength = 0;
  #nextExpectedSequence: bigint;
  #failure: LocalProtocolError | undefined;
  #ended = false;

  public constructor(options: IncrementalLocalFrameDecoderOptions) {
    this.#minorVersion = assertUnsignedInteger(options.minorVersion, 16, "minorVersion");
    this.#nextExpectedSequence = normalizeSequence(
      options.expectedSequence ?? 1n,
      "expectedSequence",
    );
    this.#maximumBufferedBytes = assertMaximumBufferedBytes(
      options.maximumBufferedBytes ?? LOCAL_PROTOCOL_MAX_FRAME_BYTES,
    );
  }

  public get nextExpectedSequence(): bigint {
    return this.#nextExpectedSequence;
  }

  public get sequenceExhausted(): boolean {
    return this.#nextExpectedSequence > MAXIMUM_SEQUENCE;
  }

  public push(chunk: Uint8Array): readonly DecodedLocalFrame[] {
    this.#assertUsable();
    if (!(chunk instanceof Uint8Array)) {
      return this.#fail(new LocalProtocolError("Local protocol input must be a Uint8Array."));
    }
    if (chunk.byteLength === 0) {
      return [];
    }
    if (this.sequenceExhausted) {
      return this.#fail(new LocalProtocolError("Local protocol sequence space is exhausted."));
    }

    const input = chunk;
    const frames: DecodedLocalFrame[] = [];
    let offset = 0;

    try {
      while (offset < input.byteLength) {
        if (this.#frame === undefined) {
          const copied = Math.min(
            LOCAL_PROTOCOL_HEADER_BYTES - this.#headerLength,
            input.byteLength - offset,
          );
          this.#header.set(input.subarray(offset, offset + copied), this.#headerLength);
          this.#headerLength += copied;
          offset += copied;

          if (this.#headerLength < LOCAL_PROTOCOL_HEADER_BYTES) {
            continue;
          }

          const header = parseHeader(this.#header, this.#minorVersion, this.#nextExpectedSequence);
          if (header.totalLength > this.#maximumBufferedBytes) {
            throw new LocalProtocolError(
              `Local protocol frame requires ${header.totalLength} buffered bytes, exceeding the configured ${this.#maximumBufferedBytes}-byte limit.`,
            );
          }

          this.#frame = Buffer.allocUnsafe(header.totalLength);
          this.#header.copy(this.#frame, 0);
          this.#frameLength = LOCAL_PROTOCOL_HEADER_BYTES;
          this.#headerLength = 0;
        }

        const frame = this.#frame;
        if (frame === undefined) {
          throw new LocalProtocolError("Local protocol decoder entered an invalid state.");
        }
        const copied = Math.min(frame.byteLength - this.#frameLength, input.byteLength - offset);
        frame.set(input.subarray(offset, offset + copied), this.#frameLength);
        this.#frameLength += copied;
        offset += copied;

        if (this.#frameLength === frame.byteLength) {
          const decoded = decodeFrame(frame, this.#minorVersion, this.#nextExpectedSequence);
          this.#frame = undefined;
          this.#frameLength = 0;
          this.#nextExpectedSequence = decoded.sequence + 1n;
          frames.push(decoded);
        }
      }
      return frames;
    } catch (error) {
      return this.#fail(asProtocolError(error));
    }
  }

  public end(): void {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    if (this.#headerLength !== 0 || this.#frame !== undefined) {
      this.#fail(new LocalProtocolError("Local protocol stream ended with a partial frame."));
    }
  }

  public reset(expectedSequence: LocalProtocolSequence = 1n): void {
    this.#nextExpectedSequence = normalizeSequence(expectedSequence, "expectedSequence");
    this.#headerLength = 0;
    this.#frame = undefined;
    this.#frameLength = 0;
    this.#failure = undefined;
    this.#ended = false;
  }

  #assertUsable(): void {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    if (this.#ended) {
      throw new LocalProtocolError("Local protocol decoder has already ended.");
    }
  }

  #fail(error: LocalProtocolError): never {
    this.#failure ??= error;
    this.#headerLength = 0;
    this.#frame = undefined;
    this.#frameLength = 0;
    throw this.#failure;
  }
}

function decodeFrame(
  bytes: Uint8Array,
  expectedMinorVersion: number,
  expectedSequence: bigint | undefined,
): DecodedLocalFrame {
  if (!(bytes instanceof Uint8Array)) {
    throw new LocalProtocolError("Local protocol frame must be a Uint8Array.");
  }
  if (bytes.byteLength < LOCAL_PROTOCOL_HEADER_BYTES) {
    throw new LocalProtocolError("Local protocol frame is shorter than its 48-byte header.");
  }
  if (bytes.byteLength > LOCAL_PROTOCOL_MAX_FRAME_BYTES) {
    throw new LocalProtocolError(
      `Local protocol frame exceeds the ${LOCAL_PROTOCOL_MAX_FRAME_BYTES}-byte limit.`,
    );
  }

  const frame = Buffer.from(bytes);
  const header = parseHeader(frame, expectedMinorVersion, expectedSequence);
  if (frame.byteLength < header.totalLength) {
    throw new LocalProtocolError("Local protocol frame payload is incomplete.");
  }
  if (frame.byteLength > header.totalLength) {
    throw new LocalProtocolError("Local protocol frame contains trailing bytes.");
  }

  const payload = parseCanonicalPayload(
    frame.subarray(LOCAL_PROTOCOL_HEADER_BYTES, header.totalLength),
  );
  return {
    majorVersion: LOCAL_PROTOCOL_MAJOR_VERSION,
    minorVersion: header.minorVersion,
    messageType: header.messageType,
    sequence: header.sequence,
    correlationId: header.correlationId,
    payload,
  };
}

function parseHeader(
  header: Buffer,
  expectedMinorVersion: number,
  expectedSequence: bigint | undefined,
): ParsedHeader {
  if (header.byteLength < LOCAL_PROTOCOL_HEADER_BYTES) {
    throw new LocalProtocolError("Local protocol frame is shorter than its 48-byte header.");
  }
  if (header[0] !== 0x41 || header[1] !== 0x52 || header[2] !== 0x57 || header[3] !== 0x58) {
    throw new LocalProtocolError("Local protocol frame has invalid magic bytes.");
  }
  if (header.readUInt16LE(4) !== LOCAL_PROTOCOL_HEADER_BYTES) {
    throw new LocalProtocolError("Local protocol frame has an unsupported header length.");
  }
  if (header.readUInt16LE(6) !== LOCAL_PROTOCOL_MAJOR_VERSION) {
    throw new LocalProtocolError("Local protocol frame has an unsupported major version.");
  }

  const minorVersion = header.readUInt16LE(8);
  if (minorVersion !== expectedMinorVersion) {
    throw new LocalProtocolError(
      `Local protocol minor version ${minorVersion} does not match negotiated version ${expectedMinorVersion}.`,
    );
  }

  const messageType = assertMessageType(header.readUInt16LE(10));
  if (header.readUInt32LE(12) !== 0) {
    throw new LocalProtocolError("Local protocol version 1 requires zero flags.");
  }

  const payloadLength = header.readUInt32LE(16);
  const totalLength = LOCAL_PROTOCOL_HEADER_BYTES + payloadLength;
  if (totalLength > LOCAL_PROTOCOL_MAX_FRAME_BYTES) {
    throw new LocalProtocolError(
      `Local protocol frame exceeds the ${LOCAL_PROTOCOL_MAX_FRAME_BYTES}-byte limit.`,
    );
  }

  const sequence = header.readBigUInt64LE(20);
  if (sequence === 0n) {
    throw new LocalProtocolError("Local protocol sequence must start at 1.");
  }
  if (expectedSequence !== undefined && sequence !== expectedSequence) {
    throw new LocalProtocolError(
      `Local protocol sequence ${sequence} does not match expected sequence ${expectedSequence}.`,
    );
  }

  const correlationId = bytesToCorrelationId(header.subarray(28, 44));
  assertCorrelationId(correlationId, messageType);
  if (header.readUInt32LE(44) !== 0) {
    throw new LocalProtocolError("Local protocol version 1 requires a zero reserved field.");
  }

  return {
    minorVersion,
    messageType,
    payloadLength,
    totalLength,
    sequence,
    correlationId,
  };
}

function assertMessageType(value: number): LocalMessageType {
  if (!Number.isInteger(value) || !MESSAGE_TYPES.has(value)) {
    throw new LocalProtocolError(`Unknown local protocol message type ${String(value)}.`);
  }
  return value as LocalMessageType;
}

function assertCorrelationId(value: string, messageType: LocalMessageType): string {
  const isSessionMessage = SESSION_MESSAGE_TYPES.has(messageType);
  const isNil = value === LOCAL_PROTOCOL_NIL_CORRELATION_ID;
  if (isSessionMessage !== isNil) {
    throw new LocalProtocolError(
      isSessionMessage
        ? "Session-scoped local protocol messages require the nil correlationId."
        : "Attempt-scoped local protocol messages require a non-nil correlationId.",
    );
  }
  if (!isNil && !ATTEMPT_CORRELATION_ID_PATTERN.test(value)) {
    throw new LocalProtocolError(
      "Attempt-scoped local protocol correlationId must be a canonical lowercase RFC 4122 version 4 UUID.",
    );
  }
  return value;
}

function correlationIdToBytes(value: string): Buffer {
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function bytesToCorrelationId(value: Uint8Array): string {
  const hexadecimal = Buffer.from(value).toString("hex");
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
}

function normalizeSequence(value: LocalProtocolSequence, name: string): bigint {
  let normalized: bigint;
  if (typeof value === "bigint") {
    normalized = value;
  } else {
    if (!Number.isSafeInteger(value)) {
      throw new LocalProtocolError(`${name} must be a positive safe integer or bigint.`);
    }
    normalized = BigInt(value);
  }
  if (normalized < 1n || normalized > MAXIMUM_SEQUENCE) {
    throw new LocalProtocolError(`${name} must fit in a positive unsigned 64-bit integer.`);
  }
  return normalized;
}

function assertUnsignedInteger(value: number, bits: number, name: string): number {
  const maximum = 2 ** bits - 1;
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new LocalProtocolError(`${name} must be an unsigned ${bits}-bit integer.`);
  }
  return value;
}

function assertMaximumBufferedBytes(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < LOCAL_PROTOCOL_HEADER_BYTES ||
    value > LOCAL_PROTOCOL_MAX_FRAME_BYTES
  ) {
    throw new LocalProtocolError(
      `maximumBufferedBytes must be between ${LOCAL_PROTOCOL_HEADER_BYTES} and ${LOCAL_PROTOCOL_MAX_FRAME_BYTES}.`,
    );
  }
  return value;
}

function parseCanonicalPayload(bytes: Uint8Array): LocalJsonObject {
  let value: unknown;
  try {
    value = parseCanonicalJson(bytes, LOCAL_PROTOCOL_MAX_PAYLOAD_BYTES);
  } catch (error) {
    throw new LocalProtocolError("Local protocol payload is not strict canonical JSON.", {
      cause: error,
    });
  }
  if (!isJsonObject(value)) {
    throw new LocalProtocolError("Local protocol payload must be a JSON object.");
  }
  return value;
}

function serializeCanonicalPayload(value: unknown): string {
  if (!isJsonObject(value)) {
    throw new LocalProtocolError("Local protocol payload must be a JSON object.");
  }
  try {
    return serializeCanonicalJson(value);
  } catch (error) {
    throw new LocalProtocolError("Local protocol payload is not strict canonical JSON.", {
      cause: error,
    });
  }
}

function isJsonObject(value: unknown): value is LocalJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asProtocolError(error: unknown): LocalProtocolError {
  return error instanceof LocalProtocolError
    ? error
    : new LocalProtocolError("Local protocol decoding failed.", { cause: error });
}
