import {
  type DeepReadonly,
  deepFreezeJson,
  parseCanonicalJson,
  serializeCanonicalJson,
} from "@agentic-review/local-protocol";
import { decodeHostControlOpaqueJson } from "./opaque-json.js";

export const HOST_CONTROL_PROTOCOL_VERSION = "1.0" as const;
export const HOST_CONTROL_MAXIMUM_CANONICAL_FRAME_BYTES = 1_048_576;
export const HOST_CONTROL_MAXIMUM_BODY_BYTES = 1_048_576;
export const HOST_CONTROL_MAXIMUM_FRAME_BYTES = 1_398_599;
export const HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES = 2 * 1_024 * 1_024 + 16 * 1_024;
export const HOST_CONTROL_MAXIMUM_REQUEST_FRAME_BYTES = 2_818_535;
export const HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_BODY_BYTES = 16 * 1_024 * 1_024;
export const HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_FRAME_BYTES = 22_369_945;
export const HOST_CONTROL_MAXIMUM_ARM_ARWX_SHUTDOWN_BYTES = 1_024;

const framePrefixBytes = 4;

export type HostControlOperation =
  | "Register"
  | "Claim"
  | "InstanceHeartbeat"
  | "CompleteRun"
  | "FailRun"
  | "ArmArwxShutdown"
  | "SignLocalDigest";

export type HostControlJsonObject = Readonly<Record<string, unknown>>;
export type HostControlResponseBody = DeepReadonly<Record<string, unknown>>;

export interface ParsedHostControlSuccessResponse {
  readonly outcome: "ok";
  readonly requestId: string;
  readonly body: HostControlResponseBody;
}

export interface ParsedHostControlErrorResponse {
  readonly outcome: "error";
  readonly requestId: string;
  readonly error: HostControlRemoteError;
}

export type ParsedHostControlResponse =
  | ParsedHostControlSuccessResponse
  | ParsedHostControlErrorResponse;

export class HostControlProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HostControlProtocolError";
  }
}

export class HostControlRemoteError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HostControlRemoteError";
  }
}

export function encodeHostControlCall(
  operation: HostControlOperation,
  requestId: string,
  payload: HostControlJsonObject,
): Buffer {
  assertEntityId(requestId, "requestId");
  validateOperationPayload(operation, payload);
  const document = serializeDocument({
    operation,
    payload,
    protocolVersion: HOST_CONTROL_PROTOCOL_VERSION,
    requestId,
    type: "call",
  });
  const maximum =
    operation === "CompleteRun"
      ? HOST_CONTROL_MAXIMUM_REQUEST_FRAME_BYTES
      : operation === "ArmArwxShutdown"
        ? HOST_CONTROL_MAXIMUM_ARM_ARWX_SHUTDOWN_BYTES
        : operation === "SignLocalDigest"
          ? HOST_CONTROL_MAXIMUM_CANONICAL_FRAME_BYTES
          : HOST_CONTROL_MAXIMUM_FRAME_BYTES;
  if (document.byteLength > maximum) {
    throw new HostControlProtocolError("HostControl request exceeds its operation limit.");
  }
  return encodeLengthPrefixedFrame(document, maximum);
}

export function encodeHostControlCancel(requestId: string, targetRequestId: string): Buffer {
  assertEntityId(requestId, "requestId");
  assertEntityId(targetRequestId, "targetRequestId");
  if (requestId === targetRequestId) {
    throw new HostControlProtocolError("HostControl cancel request cannot target itself.");
  }
  const document = serializeDocument({
    protocolVersion: HOST_CONTROL_PROTOCOL_VERSION,
    requestId,
    targetRequestId,
    type: "cancel",
  });
  if (document.byteLength > HOST_CONTROL_MAXIMUM_CANONICAL_FRAME_BYTES) {
    throw new HostControlProtocolError("HostControl cancel request exceeds its byte limit.");
  }
  return encodeLengthPrefixedFrame(document, HOST_CONTROL_MAXIMUM_CANONICAL_FRAME_BYTES);
}

export function parseHostControlResponse(document: Uint8Array): ParsedHostControlResponse {
  let value: unknown;
  try {
    value = parseCanonicalJson(document, HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_FRAME_BYTES);
  } catch {
    throw new HostControlProtocolError("HostControl response is not canonical JSON.");
  }
  if (
    !isRecord(value) ||
    value.protocolVersion !== HOST_CONTROL_PROTOCOL_VERSION ||
    value.type !== "response"
  ) {
    throw new HostControlProtocolError("HostControl response shape is invalid.");
  }
  const requestId = value.requestId;
  if (!validEntityId(requestId)) {
    throw new HostControlProtocolError("HostControl response correlation is invalid.");
  }
  if (value.outcome === "ok") {
    if (
      !hasExactKeys(value, ["body", "outcome", "protocolVersion", "requestId", "type"]) ||
      !isRecord(value.body)
    ) {
      throw new HostControlProtocolError("HostControl success response shape is invalid.");
    }
    return {
      outcome: "ok",
      requestId,
      body: deepFreezeJson(value.body) as HostControlResponseBody,
    };
  }
  if (
    value.outcome !== "error" ||
    !hasExactKeys(value, ["error", "outcome", "protocolVersion", "requestId", "type"])
  ) {
    throw new HostControlProtocolError("HostControl response outcome is invalid.");
  }
  if (document.byteLength > HOST_CONTROL_MAXIMUM_CANONICAL_FRAME_BYTES) {
    throw new HostControlProtocolError("HostControl error response exceeds its byte limit.");
  }
  const error = value.error;
  if (
    !isRecord(error) ||
    !hasExactKeys(error, ["code", "message", "retryable"]) ||
    typeof error.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}(?![\s\S])/u.test(error.code) ||
    typeof error.message !== "string" ||
    Buffer.byteLength(error.message, "utf8") < 1 ||
    Buffer.byteLength(error.message, "utf8") > 512 ||
    containsDisallowedControl(error.message) ||
    typeof error.retryable !== "boolean"
  ) {
    throw new HostControlProtocolError("HostControl error response shape is invalid.");
  }
  return {
    outcome: "error",
    requestId,
    error: new HostControlRemoteError(error.code, error.message, error.retryable),
  };
}

export class HostControlFrameDecoder {
  readonly #prefix = Buffer.alloc(framePrefixBytes);
  #prefixLength = 0;
  #payload: Buffer | undefined;
  #payloadLength = 0;
  #failed = false;
  #ended = false;

  public constructor(
    private readonly maximumFrameBytes = HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_FRAME_BYTES,
  ) {
    if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes < 1) {
      throw new RangeError("HostControl frame maximum must be a positive safe integer.");
    }
  }

  public push(chunk: Uint8Array): readonly Buffer[] {
    this.#assertUsable();
    if (!(chunk instanceof Uint8Array)) return this.#fail("HostControl input must be bytes.");
    const frames: Buffer[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.#payload === undefined) {
        const copied = Math.min(framePrefixBytes - this.#prefixLength, chunk.byteLength - offset);
        this.#prefix.set(chunk.subarray(offset, offset + copied), this.#prefixLength);
        this.#prefixLength += copied;
        offset += copied;
        if (this.#prefixLength < framePrefixBytes) continue;
        const length = this.#prefix.readUInt32LE(0);
        if (length === 0 || length > this.maximumFrameBytes) {
          return this.#fail("HostControl frame length is outside its byte limit.");
        }
        this.#payload = Buffer.allocUnsafe(length);
        this.#payloadLength = 0;
        this.#prefixLength = 0;
      }

      const payload = this.#payload;
      if (payload === undefined) return this.#fail("HostControl decoder state is invalid.");
      const copied = Math.min(payload.byteLength - this.#payloadLength, chunk.byteLength - offset);
      payload.set(chunk.subarray(offset, offset + copied), this.#payloadLength);
      this.#payloadLength += copied;
      offset += copied;
      if (this.#payloadLength === payload.byteLength) {
        frames.push(payload);
        this.#payload = undefined;
        this.#payloadLength = 0;
      }
    }
    return frames;
  }

  public end(): void {
    if (this.#failed) throw new HostControlProtocolError("HostControl decoder already failed.");
    if (this.#ended) return;
    this.#ended = true;
    if (this.#prefixLength !== 0 || this.#payload !== undefined) {
      this.#fail("HostControl stream ended with a partial frame.");
    }
  }

  #assertUsable(): void {
    if (this.#failed || this.#ended) {
      throw new HostControlProtocolError("HostControl decoder is not usable.");
    }
  }

  #fail(message: string): never {
    this.#failed = true;
    this.#payload = undefined;
    this.#payloadLength = 0;
    this.#prefixLength = 0;
    throw new HostControlProtocolError(message);
  }
}

export function validHostControlEntityId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u.test(value);
}

export function validP256LowSSignature(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/u.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 64 || bytes.toString("base64url") !== value) return false;
  const r = BigInt(`0x${bytes.subarray(0, 32).toString("hex")}`);
  const s = BigInt(`0x${bytes.subarray(32).toString("hex")}`);
  const order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
  return r > 0n && r < order && s > 0n && s <= order >> 1n;
}

function encodeLengthPrefixedFrame(document: Buffer, maximumBytes: number): Buffer {
  if (document.byteLength === 0 || document.byteLength > maximumBytes) {
    throw new HostControlProtocolError("HostControl frame is outside its byte limit.");
  }
  const frame = Buffer.allocUnsafe(framePrefixBytes + document.byteLength);
  frame.writeUInt32LE(document.byteLength, 0);
  document.copy(frame, framePrefixBytes);
  return frame;
}

function validateOperationPayload(
  operation: HostControlOperation,
  payload: HostControlJsonObject,
): void {
  switch (operation) {
    case "Register":
    case "Claim":
      assertBodyPayload(payload, ["body"], HOST_CONTROL_MAXIMUM_BODY_BYTES);
      return;
    case "InstanceHeartbeat":
      assertBodyPayload(payload, ["body", "workerInstanceId"], HOST_CONTROL_MAXIMUM_BODY_BYTES);
      assertEntityId(payload.workerInstanceId as string, "workerInstanceId");
      return;
    case "CompleteRun":
      assertBodyPayload(
        payload,
        ["body", "runAttemptId"],
        HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES,
      );
      assertEntityId(payload.runAttemptId as string, "runAttemptId");
      return;
    case "FailRun":
      assertBodyPayload(payload, ["body", "runAttemptId"], HOST_CONTROL_MAXIMUM_BODY_BYTES);
      assertEntityId(payload.runAttemptId as string, "runAttemptId");
      return;
    case "ArmArwxShutdown":
      assertArmArwxShutdownPayload(payload);
      return;
    case "SignLocalDigest":
      if (
        !hasExactKeys(payload, ["digestSha256"]) ||
        typeof payload.digestSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(payload.digestSha256)
      ) {
        throw new HostControlProtocolError("HostControl signing payload is invalid.");
      }
      return;
  }
}

function assertBodyPayload(
  payload: HostControlJsonObject,
  keys: readonly string[],
  maximumBodyBytes: number,
): void {
  if (!hasExactKeys(payload, keys) || !isRecord(payload.body)) {
    throw new HostControlProtocolError("HostControl operation payload is invalid.");
  }
  try {
    decodeHostControlOpaqueJson(payload.body, maximumBodyBytes);
  } catch {
    throw new HostControlProtocolError("HostControl operation body descriptor is invalid.");
  }
}

function assertArmArwxShutdownPayload(payload: HostControlJsonObject): void {
  if (
    !hasExactKeys(payload, [
      "bootstrapId",
      "finalCorrelationId",
      "finalFrameBytes",
      "finalFrameSha256",
      "finalMessageType",
      "finalSequence",
      "remainingShutdownMs",
      "shutdownId",
    ]) ||
    !isUuidV4(payload.bootstrapId) ||
    !isUuidV4(payload.shutdownId) ||
    !Number.isSafeInteger(payload.remainingShutdownMs) ||
    (payload.remainingShutdownMs as number) < 1 ||
    (payload.remainingShutdownMs as number) > 300_000 ||
    (payload.finalMessageType !== 14 && payload.finalMessageType !== 15) ||
    typeof payload.finalSequence !== "string" ||
    !/^[1-9][0-9]{0,19}(?![\s\S])/u.test(payload.finalSequence) ||
    BigInt(payload.finalSequence) > (1n << 64n) - 1n ||
    payload.finalCorrelationId !== "00000000-0000-0000-0000-000000000000" ||
    !Number.isSafeInteger(payload.finalFrameBytes) ||
    (payload.finalFrameBytes as number) < 48 ||
    (payload.finalFrameBytes as number) > 1_048_576 ||
    typeof payload.finalFrameSha256 !== "string" ||
    !/^[a-f0-9]{64}(?![\s\S])/u.test(payload.finalFrameSha256)
  ) {
    throw new HostControlProtocolError("ArmArwxShutdownV1 payload is invalid.");
  }
}

function isUuidV4(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/u.test(value)
  );
}

function serializeDocument(value: HostControlJsonObject): Buffer {
  try {
    return Buffer.from(serializeCanonicalJson(value), "utf8");
  } catch {
    throw new HostControlProtocolError("HostControl request is not canonical JSON data.");
  }
}

function assertEntityId(value: string, name: string): void {
  if (!validHostControlEntityId(value)) {
    throw new HostControlProtocolError(`${name} is not a valid local RPC entity ID.`);
  }
}

function validEntityId(value: unknown): value is string {
  return validHostControlEntityId(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function containsDisallowedControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 && codePoint !== 0x09) return true;
  }
  return false;
}
