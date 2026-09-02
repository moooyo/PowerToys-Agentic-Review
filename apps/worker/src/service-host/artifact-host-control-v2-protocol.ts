import {
  maximumResultArtifactChunkRequestBytes,
  maximumResultArtifactChunks,
  maximumResultArtifactControlRequestBytes,
} from "@agentic-review/contracts";
import {
  type DeepReadonly,
  deepFreezeJson,
  parseCanonicalJson,
  serializeCanonicalJson,
} from "@agentic-review/local-protocol";
import {
  decodeHostControlOpaqueJson,
  type HostControlOpaqueJsonDescriptor,
} from "./opaque-json.js";

export const ARTIFACT_HOST_CONTROL_V2_PROTOCOL_VERSION = "2.0" as const;
export const ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CONTROL_BODY_BYTES =
  maximumResultArtifactControlRequestBytes;
export const ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CHUNK_BODY_BYTES =
  maximumResultArtifactChunkRequestBytes;
export const ARTIFACT_HOST_CONTROL_V2_MAXIMUM_RESPONSE_BODY_BYTES = 16 * 1024;
export const ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CONTROL_FRAME_BYTES = 32 * 1024;
export const ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CHUNK_FRAME_BYTES = 512 * 1024;
export const ARTIFACT_HOST_CONTROL_V2_MAXIMUM_RESPONSE_FRAME_BYTES = 32 * 1024;

const framePrefixBytes = 4;

export type ArtifactHostControlV2Operation =
  | "CreateArtifactUpload"
  | "PutArtifactChunk"
  | "FinalizeArtifactUpload"
  | "TerminateArtifactUpload"
  | "CompleteArtifactRun";

export interface ArtifactHostControlV2RunPayload {
  readonly body: Readonly<HostControlOpaqueJsonDescriptor>;
  readonly runAttemptId: string;
}

export interface ArtifactHostControlV2UploadPayload {
  readonly body: Readonly<HostControlOpaqueJsonDescriptor>;
  readonly uploadId: string;
}

export interface ArtifactHostControlV2ChunkPayload extends ArtifactHostControlV2UploadPayload {
  readonly chunkIndex: number;
}

export type ArtifactHostControlV2Payload =
  | ArtifactHostControlV2RunPayload
  | ArtifactHostControlV2UploadPayload
  | ArtifactHostControlV2ChunkPayload;

export interface ParsedArtifactHostControlV2Call {
  readonly protocolVersion: "2.0";
  readonly type: "call";
  readonly requestId: string;
  readonly operation: ArtifactHostControlV2Operation;
  readonly payload: DeepReadonly<ArtifactHostControlV2Payload>;
}

export interface ParsedArtifactHostControlV2SuccessResponse {
  readonly protocolVersion: "2.0";
  readonly type: "response";
  readonly outcome: "ok";
  readonly requestId: string;
  readonly body: DeepReadonly<Record<string, unknown>>;
}

export class ArtifactHostControlV2RemoteError extends Error {
  readonly #code: string;
  readonly #retryable: boolean;

  public constructor(code: string, retryable: boolean) {
    super("Artifact HostControl v2 operation failed.");
    if (!validErrorCode(code) || typeof retryable !== "boolean") {
      throw new TypeError("Artifact HostControl v2 remote error classification is invalid.");
    }
    this.name = "ArtifactHostControlV2RemoteError";
    this.#code = code;
    this.#retryable = retryable;
    artifactHostControlV2RemoteErrorSnapshots.set(this, Object.freeze({ code, retryable }));
    Object.freeze(this);
  }

  public get code(): string {
    return this.#code;
  }

  public get retryable(): boolean {
    return this.#retryable;
  }
}

const artifactHostControlV2RemoteErrorSnapshots = new WeakMap<
  ArtifactHostControlV2RemoteError,
  Readonly<{ code: string; retryable: boolean }>
>();
Object.freeze(ArtifactHostControlV2RemoteError.prototype);

export function snapshotArtifactHostControlV2RemoteError(
  value: unknown,
): Readonly<{ code: string; retryable: boolean }> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return artifactHostControlV2RemoteErrorSnapshots.get(value as ArtifactHostControlV2RemoteError);
}

export interface ParsedArtifactHostControlV2ErrorResponse {
  readonly protocolVersion: "2.0";
  readonly type: "response";
  readonly outcome: "error";
  readonly requestId: string;
  readonly error: ArtifactHostControlV2RemoteError;
}

export type ParsedArtifactHostControlV2Response =
  | ParsedArtifactHostControlV2SuccessResponse
  | ParsedArtifactHostControlV2ErrorResponse;

export class ArtifactHostControlV2ProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ArtifactHostControlV2ProtocolError";
  }
}

export function encodeArtifactHostControlV2Call(
  operation: ArtifactHostControlV2Operation,
  requestId: string,
  payload: Readonly<ArtifactHostControlV2Payload>,
): Buffer {
  assertEntityId(requestId, "requestId");
  const payloadSnapshot = snapshotProtocolObject(payload);
  validateCallPayload(operation, payloadSnapshot as unknown as ArtifactHostControlV2Payload);
  const document = serializeDocument({
    operation,
    payload: payloadSnapshot,
    protocolVersion: ARTIFACT_HOST_CONTROL_V2_PROTOCOL_VERSION,
    requestId,
    type: "call",
  });
  const maximum = requestFrameMaximum(operation);
  if (document.byteLength > maximum) {
    throw protocolError("Artifact HostControl v2 request exceeds its operation limit.");
  }
  return encodeFrame(document, maximum);
}

export function parseArtifactHostControlV2Call(
  document: Uint8Array,
): Readonly<ParsedArtifactHostControlV2Call> {
  const value = parseDocument(document, ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CHUNK_FRAME_BYTES);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["operation", "payload", "protocolVersion", "requestId", "type"]) ||
    value.protocolVersion !== ARTIFACT_HOST_CONTROL_V2_PROTOCOL_VERSION ||
    value.type !== "call" ||
    !isOperation(value.operation) ||
    !validEntityId(value.requestId) ||
    !isRecord(value.payload)
  ) {
    throw protocolError("Artifact HostControl v2 call shape is invalid.");
  }
  validateCallPayload(value.operation, value.payload as unknown as ArtifactHostControlV2Payload);
  if (document.byteLength > requestFrameMaximum(value.operation)) {
    throw protocolError("Artifact HostControl v2 call exceeds its operation limit.");
  }
  return deepFreezeJson({
    operation: value.operation,
    payload: value.payload,
    protocolVersion: ARTIFACT_HOST_CONTROL_V2_PROTOCOL_VERSION,
    requestId: value.requestId,
    type: "call",
  }) as Readonly<ParsedArtifactHostControlV2Call>;
}

export function parseArtifactHostControlV2Response(
  document: Uint8Array,
): ParsedArtifactHostControlV2Response {
  const value = parseDocument(document, ARTIFACT_HOST_CONTROL_V2_MAXIMUM_RESPONSE_FRAME_BYTES);
  if (
    !isRecord(value) ||
    value.protocolVersion !== ARTIFACT_HOST_CONTROL_V2_PROTOCOL_VERSION ||
    value.type !== "response" ||
    !validEntityId(value.requestId)
  ) {
    throw protocolError("Artifact HostControl v2 response shape is invalid.");
  }
  if (value.outcome === "ok") {
    if (!hasExactKeys(value, ["body", "outcome", "protocolVersion", "requestId", "type"])) {
      throw protocolError("Artifact HostControl v2 success response shape is invalid.");
    }
    let body: unknown;
    try {
      body = decodeHostControlOpaqueJson(
        value.body,
        ARTIFACT_HOST_CONTROL_V2_MAXIMUM_RESPONSE_BODY_BYTES,
      );
    } catch {
      throw protocolError("Artifact HostControl v2 success body descriptor is invalid.");
    }
    if (!isRecord(body)) {
      throw protocolError("Artifact HostControl v2 success body must decode to an object.");
    }
    return Object.freeze({
      protocolVersion: ARTIFACT_HOST_CONTROL_V2_PROTOCOL_VERSION,
      type: "response",
      outcome: "ok",
      requestId: value.requestId,
      body: deepFreezeJson(body) as DeepReadonly<Record<string, unknown>>,
    });
  }
  if (
    value.outcome !== "error" ||
    !hasExactKeys(value, ["error", "outcome", "protocolVersion", "requestId", "type"]) ||
    !isRecord(value.error) ||
    !hasExactKeys(value.error, ["code", "message", "retryable"]) ||
    typeof value.error.code !== "string" ||
    !validErrorCode(value.error.code) ||
    typeof value.error.message !== "string" ||
    Buffer.byteLength(value.error.message, "utf8") < 1 ||
    Buffer.byteLength(value.error.message, "utf8") > 512 ||
    containsDisallowedControl(value.error.message) ||
    typeof value.error.retryable !== "boolean"
  ) {
    throw protocolError("Artifact HostControl v2 error response shape is invalid.");
  }
  return Object.freeze({
    protocolVersion: ARTIFACT_HOST_CONTROL_V2_PROTOCOL_VERSION,
    type: "response",
    outcome: "error",
    requestId: value.requestId,
    error: new ArtifactHostControlV2RemoteError(value.error.code, value.error.retryable),
  });
}

function validateCallPayload(
  operation: ArtifactHostControlV2Operation,
  payload: Readonly<ArtifactHostControlV2Payload>,
): void {
  if (!isRecord(payload)) {
    throw protocolError("Artifact HostControl v2 operation payload is invalid.");
  }
  const record = payload as Readonly<Record<string, unknown>>;
  switch (operation) {
    case "CreateArtifactUpload":
    case "CompleteArtifactRun":
      if (!hasExactKeys(record, ["body", "runAttemptId"]) || !validEntityId(record.runAttemptId)) {
        throw protocolError("Artifact HostControl v2 run payload is invalid.");
      }
      validateBodyDescriptor(record.body, ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CONTROL_BODY_BYTES);
      return;
    case "PutArtifactChunk":
      if (
        !hasExactKeys(record, ["body", "chunkIndex", "uploadId"]) ||
        !validEntityId(record.uploadId) ||
        !Number.isSafeInteger(record.chunkIndex) ||
        (record.chunkIndex as number) < 0 ||
        (record.chunkIndex as number) >= maximumResultArtifactChunks
      ) {
        throw protocolError("Artifact HostControl v2 chunk payload is invalid.");
      }
      validateBodyDescriptor(record.body, ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CHUNK_BODY_BYTES);
      return;
    case "FinalizeArtifactUpload":
    case "TerminateArtifactUpload":
      if (!hasExactKeys(record, ["body", "uploadId"]) || !validEntityId(record.uploadId)) {
        throw protocolError("Artifact HostControl v2 upload payload is invalid.");
      }
      validateBodyDescriptor(record.body, ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CONTROL_BODY_BYTES);
      return;
    default:
      throw protocolError("Artifact HostControl v2 operation is not supported.");
  }
}

function validateBodyDescriptor(value: unknown, maximumBytes: number): void {
  try {
    decodeHostControlOpaqueJson(value, maximumBytes);
  } catch {
    throw protocolError("Artifact HostControl v2 body descriptor is invalid.");
  }
}

function requestFrameMaximum(operation: ArtifactHostControlV2Operation): number {
  return operation === "PutArtifactChunk"
    ? ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CHUNK_FRAME_BYTES
    : ARTIFACT_HOST_CONTROL_V2_MAXIMUM_CONTROL_FRAME_BYTES;
}

function isOperation(value: unknown): value is ArtifactHostControlV2Operation {
  return (
    value === "CreateArtifactUpload" ||
    value === "PutArtifactChunk" ||
    value === "FinalizeArtifactUpload" ||
    value === "TerminateArtifactUpload" ||
    value === "CompleteArtifactRun"
  );
}

function parseDocument(document: Uint8Array, maximumBytes: number): unknown {
  try {
    return parseCanonicalJson(document, maximumBytes);
  } catch {
    throw protocolError("Artifact HostControl v2 message is not bounded canonical JSON.");
  }
}

function serializeDocument(value: Readonly<Record<string, unknown>>): Buffer {
  try {
    return Buffer.from(serializeCanonicalJson(value), "utf8");
  } catch {
    throw protocolError("Artifact HostControl v2 request is not canonical JSON data.");
  }
}

function encodeFrame(document: Buffer, maximumBytes: number): Buffer {
  if (document.byteLength < 1 || document.byteLength > maximumBytes) {
    throw protocolError("Artifact HostControl v2 frame is outside its byte limit.");
  }
  const frame = Buffer.allocUnsafe(framePrefixBytes + document.byteLength);
  frame.writeUInt32LE(document.byteLength, 0);
  document.copy(frame, framePrefixBytes);
  return frame;
}

function assertEntityId(value: string, description: string): void {
  if (!validEntityId(value)) {
    throw protocolError(`${description} is not a valid Artifact HostControl v2 entity ID.`);
  }
}

function validEntityId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u.test(value);
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
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function validErrorCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value);
}

function snapshotProtocolObject(value: unknown): Readonly<Record<string, unknown>> {
  const snapshot = snapshotProtocolValue(value, { nodes: 0 }, 0);
  if (!isRecord(snapshot)) throw protocolError("Artifact HostControl v2 payload is invalid.");
  return snapshot;
}

function snapshotProtocolValue(value: unknown, budget: { nodes: number }, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw protocolError("Artifact HostControl v2 payload is invalid.");
    return value;
  }
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    depth >= 8
  ) {
    throw protocolError("Artifact HostControl v2 payload is invalid.");
  }
  budget.nodes += 1;
  if (budget.nodes > 32) throw protocolError("Artifact HostControl v2 payload is too complex.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 16) {
    throw protocolError("Artifact HostControl v2 payload has too many fields.");
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
      throw protocolError("Artifact HostControl v2 payload field is invalid.");
    }
    snapshot[key] = snapshotProtocolValue(descriptor.value, budget, depth + 1);
  }
  return Object.freeze(snapshot);
}

function protocolError(message: string): ArtifactHostControlV2ProtocolError {
  return new ArtifactHostControlV2ProtocolError(message);
}
