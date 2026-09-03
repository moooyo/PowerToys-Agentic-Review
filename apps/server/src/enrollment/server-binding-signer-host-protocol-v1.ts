import {
  deriveServerBindingIssuerKeyIdV1,
  marshalServerBindingActiveStatusStatementV1,
  marshalServerBindingReceiptStatementV1,
  type ServerBindingActiveStatusStatementV1,
  type ServerBindingReceiptStatementV1,
} from "@agentic-review/contracts/server-binding-authority-v1";

export const SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION = "1.0" as const;
export const SERVER_BINDING_SIGNER_HOST_MAXIMUM_FRAME_BYTES = 8192;
export const SERVER_BINDING_SIGNER_HOST_MAXIMUM_STATEMENT_BYTES = 4096;
export const SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDOUT_BYTES = 16384;
export const SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDERR_BYTES = 16384;
export const SERVER_BINDING_SIGNER_HOST_MAXIMUM_CONCURRENT_REQUESTS = 1;
export const SERVER_BINDING_SIGNER_HOST_HANDSHAKE_TIMEOUT_MILLISECONDS = 10000;
export const SERVER_BINDING_SIGNER_HOST_SIGNING_TIMEOUT_MILLISECONDS = 15000;
export const SERVER_BINDING_SIGNER_HOST_GRACEFUL_SHUTDOWN_TIMEOUT_MILLISECONDS = 5000;
export const SERVER_BINDING_SIGNER_HOST_FORCED_EXIT_TIMEOUT_MILLISECONDS = 10000;

export type ServerBindingSignerHostOperationV1 =
  | "active_status_statement_v1"
  | "receipt_statement_v1";

export type ServerBindingSignerHostCancellationReasonV1 = "caller_abort" | "deadline" | "shutdown";

export type ServerBindingSignerHostChildErrorCodeV1 =
  | "HANDSHAKE_REJECTED"
  | "REQUEST_INVALID"
  | "REQUEST_BUSY"
  | "SIGNING_FAILED"
  | "CANCEL_FAILED"
  | "SHUTDOWN_REJECTED"
  | "INTERNAL_FAILURE";

export type ServerBindingSignerHostParentMessageV1 =
  | Readonly<{
      instanceId: string;
      protocolVersion: typeof SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION;
      type: "hello";
    }>
  | Readonly<{
      protocolVersion: typeof SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION;
      requestId: string;
      statementJson: string;
      type: "sign_receipt_statement_v1";
    }>
  | Readonly<{
      protocolVersion: typeof SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION;
      requestId: string;
      statementJson: string;
      type: "sign_active_status_statement_v1";
    }>
  | Readonly<{
      protocolVersion: typeof SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION;
      reason: ServerBindingSignerHostCancellationReasonV1;
      requestId: string;
      type: "cancel";
    }>
  | Readonly<{
      protocolVersion: typeof SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION;
      requestId: string;
      type: "shutdown";
    }>;

export type ServerBindingSignerHostChildMessageV1 =
  | Readonly<{
      capabilities: Readonly<{
        maximumConcurrentRequests: 1;
        operations: readonly ["active_status_statement_v1", "receipt_statement_v1"];
      }>;
      hostPid: number;
      instanceId: string;
      issuerKeyId: string;
      issuerPublicKeySpki: string;
      protocolVersion: typeof SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION;
      type: "ready";
    }>
  | Readonly<{
      operation: ServerBindingSignerHostOperationV1;
      protocolVersion: typeof SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION;
      requestId: string;
      signature: string;
      type: "signature";
    }>
  | Readonly<{
      protocolVersion: typeof SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION;
      requestId: string;
      type: "cancelled";
    }>
  | Readonly<{
      protocolVersion: typeof SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION;
      requestId: string;
      type: "shutdown_ack";
    }>
  | Readonly<{
      code: ServerBindingSignerHostChildErrorCodeV1;
      protocolVersion: typeof SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION;
      requestId: string | null;
      type: "error";
    }>;

export type ServerBindingSignerHostProtocolErrorCodeV1 =
  | "FRAME_INVALID"
  | "FRAME_LIMIT_EXCEEDED"
  | "FRAME_TRUNCATED"
  | "MESSAGE_INVALID"
  | "MESSAGE_NOT_CANONICAL";

export class ServerBindingSignerHostProtocolErrorV1 extends Error {
  public constructor(
    public readonly code: ServerBindingSignerHostProtocolErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "ServerBindingSignerHostProtocolErrorV1";
  }
}

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/u;
const sha256 = /^[0-9a-f]{64}(?![\s\S])/u;
const base64Url = /^[A-Za-z0-9_-]+(?![\s\S])/u;
const p1363Signature = /^[A-Za-z0-9_-]{86}(?![\s\S])/u;
const p256Order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const p256HalfOrder = p256Order >> 1n;
const canonicalP256SpkiBytes = 91;
const canonicalP256SpkiBase64UrlCharacters = 122;
const maximumStatementBase64UrlCharacters = 5462;
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)?.get;
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)?.get;

export function marshalServerBindingSignerHostParentMessageV1(
  value: Readonly<ServerBindingSignerHostParentMessageV1>,
): Uint8Array {
  return marshalMessage(snapshotParentMessage(value), serializeParentMessage);
}

export function parseServerBindingSignerHostParentMessageV1(
  payload: Uint8Array,
): Readonly<ServerBindingSignerHostParentMessageV1> {
  return parseMessage(payload, snapshotParentMessage, serializeParentMessage);
}

export function marshalServerBindingSignerHostChildMessageV1(
  value: Readonly<ServerBindingSignerHostChildMessageV1>,
): Uint8Array {
  return marshalMessage(snapshotChildMessage(value), serializeChildMessage);
}

export function parseServerBindingSignerHostChildMessageV1(
  payload: Uint8Array,
): Readonly<ServerBindingSignerHostChildMessageV1> {
  return parseMessage(payload, snapshotChildMessage, serializeChildMessage);
}

export function frameServerBindingSignerHostPayloadV1(payload: Uint8Array): Uint8Array {
  const snapshot = snapshotByteView(payload, "Signer-host frame payload");
  assertPayloadLength(snapshot.byteLength);
  const frame = Buffer.allocUnsafe(4 + snapshot.byteLength);
  frame.writeUInt32BE(snapshot.byteLength, 0);
  snapshot.copy(frame, 4);
  return frame;
}

/** Incrementally extracts payloads without interpreting their message direction or lifecycle state. */
export class ServerBindingSignerHostFrameDecoderV1 {
  #buffer = Buffer.alloc(0);
  #terminalCode: ServerBindingSignerHostProtocolErrorCodeV1 | null = null;

  public push(chunk: Uint8Array): readonly Uint8Array[] {
    this.assertUsable();
    try {
      const snapshot = snapshotByteView(chunk, "Signer-host frame chunk");
      if (snapshot.byteLength === 0) return Object.freeze([]);

      const available =
        this.#buffer.byteLength === 0 ? snapshot : Buffer.concat([this.#buffer, snapshot]);
      const payloads: Uint8Array[] = [];
      let offset = 0;
      while (available.byteLength - offset >= 4) {
        const payloadLength = available.readUInt32BE(offset);
        assertPayloadLength(payloadLength);
        const frameLength = 4 + payloadLength;
        if (available.byteLength - offset < frameLength) break;
        payloads.push(Buffer.from(available.subarray(offset + 4, offset + frameLength)));
        offset += frameLength;
      }

      this.#buffer = Buffer.from(available.subarray(offset));
      if (this.#buffer.byteLength > SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDOUT_BYTES) {
        throw protocolError(
          "FRAME_LIMIT_EXCEEDED",
          "Signer-host framing exceeded its buffered stdout limit.",
        );
      }
      return Object.freeze(payloads);
    } catch (error) {
      this.fail(error);
    }
  }

  public finish(): void {
    this.assertUsable();
    if (this.#buffer.byteLength !== 0) {
      this.#terminalCode = "FRAME_TRUNCATED";
      throw protocolError("FRAME_TRUNCATED", "Signer-host stdout ended with a truncated frame.");
    }
    this.#terminalCode = "FRAME_INVALID";
  }

  private assertUsable(): void {
    if (this.#terminalCode !== null) {
      throw protocolError(this.#terminalCode, "Signer-host frame decoder is no longer usable.");
    }
  }

  private fail(error: unknown): never {
    const normalized =
      error instanceof ServerBindingSignerHostProtocolErrorV1
        ? error
        : protocolError("FRAME_INVALID", "Signer-host frame decoding failed.");
    this.#terminalCode = normalized.code;
    this.#buffer = Buffer.alloc(0);
    throw normalized;
  }
}

function marshalMessage<T>(value: T, serialize: (value: T) => string): Uint8Array {
  const payload = Buffer.from(serialize(value), "utf8");
  assertPayloadLength(payload.byteLength);
  return payload;
}

function parseMessage<T>(
  payload: Uint8Array,
  snapshotValue: (value: unknown) => T,
  serialize: (value: T) => string,
): Readonly<T> {
  const snapshot = snapshotByteView(payload, "Signer-host message payload");
  assertPayloadLength(snapshot.byteLength);
  if (snapshot[0] === 0xef && snapshot[1] === 0xbb && snapshot[2] === 0xbf) {
    throw protocolError(
      "MESSAGE_INVALID",
      "Signer-host message must not contain a byte-order mark.",
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot);
  } catch {
    throw protocolError("MESSAGE_INVALID", "Signer-host message is not valid UTF-8.");
  }
  assertAscii(text, "Signer-host message");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw protocolError("MESSAGE_INVALID", "Signer-host message is not valid JSON.");
  }

  const normalized = snapshotValue(parsed);
  if (serialize(normalized) !== text) {
    throw protocolError(
      "MESSAGE_NOT_CANONICAL",
      "Signer-host message is not in its canonical representation.",
    );
  }
  return deepFreezeData(normalized);
}

function snapshotParentMessage(value: unknown): ServerBindingSignerHostParentMessageV1 {
  const fields = snapshotPlainDataObject(value, "Signer-host parent message");
  const type = requireString(fields.type, "Signer-host parent message type");
  switch (type) {
    case "hello":
      assertExactKeys(fields, ["instanceId", "protocolVersion", "type"]);
      return {
        instanceId: requireUuid(fields.instanceId, "Signer-host instance ID"),
        protocolVersion: requireProtocolVersion(fields.protocolVersion),
        type,
      };
    case "sign_receipt_statement_v1":
      assertExactKeys(fields, ["protocolVersion", "requestId", "statementJson", "type"]);
      return {
        protocolVersion: requireProtocolVersion(fields.protocolVersion),
        requestId: requireUuid(fields.requestId, "Signer-host request ID"),
        statementJson: requireStatement(fields.statementJson, "receipt_statement_v1"),
        type,
      };
    case "sign_active_status_statement_v1":
      assertExactKeys(fields, ["protocolVersion", "requestId", "statementJson", "type"]);
      return {
        protocolVersion: requireProtocolVersion(fields.protocolVersion),
        requestId: requireUuid(fields.requestId, "Signer-host request ID"),
        statementJson: requireStatement(fields.statementJson, "active_status_statement_v1"),
        type,
      };
    case "cancel":
      assertExactKeys(fields, ["protocolVersion", "reason", "requestId", "type"]);
      return {
        protocolVersion: requireProtocolVersion(fields.protocolVersion),
        reason: requireCancellationReason(fields.reason),
        requestId: requireUuid(fields.requestId, "Signer-host request ID"),
        type,
      };
    case "shutdown":
      assertExactKeys(fields, ["protocolVersion", "requestId", "type"]);
      return {
        protocolVersion: requireProtocolVersion(fields.protocolVersion),
        requestId: requireUuid(fields.requestId, "Signer-host request ID"),
        type,
      };
    default:
      throw protocolError("MESSAGE_INVALID", "Signer-host parent message type is unknown.");
  }
}

function snapshotChildMessage(value: unknown): ServerBindingSignerHostChildMessageV1 {
  const fields = snapshotPlainDataObject(value, "Signer-host child message");
  const type = requireString(fields.type, "Signer-host child message type");
  switch (type) {
    case "ready": {
      assertExactKeys(fields, [
        "capabilities",
        "hostPid",
        "instanceId",
        "issuerKeyId",
        "issuerPublicKeySpki",
        "protocolVersion",
        "type",
      ]);
      const issuerKeyId = requireSha256(fields.issuerKeyId, "Signer-host issuer key ID");
      const issuerPublicKeySpki = requireCanonicalSpki(fields.issuerPublicKeySpki, issuerKeyId);
      return {
        capabilities: snapshotCapabilities(fields.capabilities),
        hostPid: requirePositiveSafeInteger(fields.hostPid, "Signer-host PID"),
        instanceId: requireUuid(fields.instanceId, "Signer-host instance ID"),
        issuerKeyId,
        issuerPublicKeySpki,
        protocolVersion: requireProtocolVersion(fields.protocolVersion),
        type,
      };
    }
    case "signature":
      assertExactKeys(fields, ["operation", "protocolVersion", "requestId", "signature", "type"]);
      return {
        operation: requireOperation(fields.operation),
        protocolVersion: requireProtocolVersion(fields.protocolVersion),
        requestId: requireUuid(fields.requestId, "Signer-host request ID"),
        signature: requireP1363LowSSignature(fields.signature),
        type,
      };
    case "cancelled":
      assertExactKeys(fields, ["protocolVersion", "requestId", "type"]);
      return {
        protocolVersion: requireProtocolVersion(fields.protocolVersion),
        requestId: requireUuid(fields.requestId, "Signer-host request ID"),
        type,
      };
    case "shutdown_ack":
      assertExactKeys(fields, ["protocolVersion", "requestId", "type"]);
      return {
        protocolVersion: requireProtocolVersion(fields.protocolVersion),
        requestId: requireUuid(fields.requestId, "Signer-host request ID"),
        type,
      };
    case "error":
      assertExactKeys(fields, ["code", "protocolVersion", "requestId", "type"]);
      return {
        code: requireChildErrorCode(fields.code),
        protocolVersion: requireProtocolVersion(fields.protocolVersion),
        requestId:
          fields.requestId === null
            ? null
            : requireUuid(fields.requestId, "Signer-host request ID"),
        type,
      };
    default:
      throw protocolError("MESSAGE_INVALID", "Signer-host child message type is unknown.");
  }
}

function snapshotCapabilities(value: unknown): Readonly<{
  maximumConcurrentRequests: 1;
  operations: readonly ["active_status_statement_v1", "receipt_statement_v1"];
}> {
  const fields = snapshotPlainDataObject(value, "Signer-host capabilities");
  assertExactKeys(fields, ["maximumConcurrentRequests", "operations"]);
  if (fields.maximumConcurrentRequests !== SERVER_BINDING_SIGNER_HOST_MAXIMUM_CONCURRENT_REQUESTS) {
    throw protocolError("MESSAGE_INVALID", "Signer-host concurrency capability is invalid.");
  }
  const operations = snapshotExactStringArray(fields.operations, "Signer-host operations");
  if (
    operations.length !== 2 ||
    operations[0] !== "active_status_statement_v1" ||
    operations[1] !== "receipt_statement_v1"
  ) {
    throw protocolError("MESSAGE_INVALID", "Signer-host operation capabilities are invalid.");
  }
  return {
    maximumConcurrentRequests: 1,
    operations: ["active_status_statement_v1", "receipt_statement_v1"],
  };
}

function serializeParentMessage(value: ServerBindingSignerHostParentMessageV1): string {
  switch (value.type) {
    case "hello":
      return `{"instanceId":${JSON.stringify(value.instanceId)},"protocolVersion":"1.0","type":"hello"}`;
    case "sign_receipt_statement_v1":
      return `{"protocolVersion":"1.0","requestId":${JSON.stringify(value.requestId)},"statementJson":${JSON.stringify(value.statementJson)},"type":"sign_receipt_statement_v1"}`;
    case "sign_active_status_statement_v1":
      return `{"protocolVersion":"1.0","requestId":${JSON.stringify(value.requestId)},"statementJson":${JSON.stringify(value.statementJson)},"type":"sign_active_status_statement_v1"}`;
    case "cancel":
      return `{"protocolVersion":"1.0","reason":${JSON.stringify(value.reason)},"requestId":${JSON.stringify(value.requestId)},"type":"cancel"}`;
    case "shutdown":
      return `{"protocolVersion":"1.0","requestId":${JSON.stringify(value.requestId)},"type":"shutdown"}`;
  }
}

function serializeChildMessage(value: ServerBindingSignerHostChildMessageV1): string {
  switch (value.type) {
    case "ready":
      return `{"capabilities":{"maximumConcurrentRequests":1,"operations":["active_status_statement_v1","receipt_statement_v1"]},"hostPid":${value.hostPid},"instanceId":${JSON.stringify(value.instanceId)},"issuerKeyId":${JSON.stringify(value.issuerKeyId)},"issuerPublicKeySpki":${JSON.stringify(value.issuerPublicKeySpki)},"protocolVersion":"1.0","type":"ready"}`;
    case "signature":
      return `{"operation":${JSON.stringify(value.operation)},"protocolVersion":"1.0","requestId":${JSON.stringify(value.requestId)},"signature":${JSON.stringify(value.signature)},"type":"signature"}`;
    case "cancelled":
      return `{"protocolVersion":"1.0","requestId":${JSON.stringify(value.requestId)},"type":"cancelled"}`;
    case "shutdown_ack":
      return `{"protocolVersion":"1.0","requestId":${JSON.stringify(value.requestId)},"type":"shutdown_ack"}`;
    case "error":
      return `{"code":${JSON.stringify(value.code)},"protocolVersion":"1.0","requestId":${value.requestId === null ? "null" : JSON.stringify(value.requestId)},"type":"error"}`;
  }
}

function requireStatement(value: unknown, operation: ServerBindingSignerHostOperationV1): string {
  const encoded = requireString(value, "Signer-host statement");
  if (encoded.length > maximumStatementBase64UrlCharacters || !base64Url.test(encoded)) {
    throw protocolError("MESSAGE_INVALID", "Signer-host statement encoding is invalid.");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > SERVER_BINDING_SIGNER_HOST_MAXIMUM_STATEMENT_BYTES ||
    bytes.toString("base64url") !== encoded
  ) {
    throw protocolError("MESSAGE_INVALID", "Signer-host statement encoding is not canonical.");
  }

  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertAscii(text, "Signer-host statement");
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw protocolError("MESSAGE_INVALID", "Signer-host statement is invalid.");
  }

  let canonical: Uint8Array;
  try {
    canonical =
      operation === "receipt_statement_v1"
        ? marshalServerBindingReceiptStatementV1(parsed as ServerBindingReceiptStatementV1)
        : marshalServerBindingActiveStatusStatementV1(
            parsed as ServerBindingActiveStatusStatementV1,
          );
  } catch {
    throw protocolError("MESSAGE_INVALID", "Signer-host statement does not match its profile.");
  }
  if (!Buffer.from(canonical).equals(bytes)) {
    throw protocolError("MESSAGE_INVALID", "Signer-host statement is not canonical.");
  }
  return encoded;
}

function requireCanonicalSpki(value: unknown, issuerKeyId: string): string {
  const encoded = requireString(value, "Signer-host issuer SPKI");
  if (encoded.length !== canonicalP256SpkiBase64UrlCharacters || !base64Url.test(encoded)) {
    throw protocolError("MESSAGE_INVALID", "Signer-host issuer SPKI encoding is invalid.");
  }
  const spki = Buffer.from(encoded, "base64url");
  if (spki.byteLength !== canonicalP256SpkiBytes || spki.toString("base64url") !== encoded) {
    throw protocolError("MESSAGE_INVALID", "Signer-host issuer SPKI encoding is not canonical.");
  }
  let derivedKeyId: string;
  try {
    derivedKeyId = deriveServerBindingIssuerKeyIdV1(spki);
  } catch {
    throw protocolError("MESSAGE_INVALID", "Signer-host issuer SPKI is invalid.");
  }
  if (derivedKeyId !== issuerKeyId) {
    throw protocolError("MESSAGE_INVALID", "Signer-host issuer key ID does not match its SPKI.");
  }
  return encoded;
}

function requireP1363LowSSignature(value: unknown): string {
  const encoded = requireString(value, "Signer-host signature");
  if (!p1363Signature.test(encoded)) {
    throw protocolError("MESSAGE_INVALID", "Signer-host signature encoding is invalid.");
  }
  const signature = Buffer.from(encoded, "base64url");
  if (signature.byteLength !== 64 || signature.toString("base64url") !== encoded) {
    throw protocolError("MESSAGE_INVALID", "Signer-host signature encoding is not canonical.");
  }
  const r = readUnsignedBigEndian(signature.subarray(0, 32));
  const s = readUnsignedBigEndian(signature.subarray(32));
  if (r <= 0n || r >= p256Order || s <= 0n || s > p256HalfOrder) {
    throw protocolError("MESSAGE_INVALID", "Signer-host signature is not canonical low-S ECDSA.");
  }
  return encoded;
}

function requireProtocolVersion(
  value: unknown,
): typeof SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION {
  if (value !== SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION) {
    throw protocolError("MESSAGE_INVALID", "Signer-host protocol version is invalid.");
  }
  return value;
}

function requireUuid(value: unknown, name: string): string {
  const normalized = requireString(value, name);
  if (!uuidV4.test(normalized)) {
    throw protocolError("MESSAGE_INVALID", `${name} is invalid.`);
  }
  return normalized;
}

function requireSha256(value: unknown, name: string): string {
  const normalized = requireString(value, name);
  if (!sha256.test(normalized)) {
    throw protocolError("MESSAGE_INVALID", `${name} is invalid.`);
  }
  return normalized;
}

function requireOperation(value: unknown): ServerBindingSignerHostOperationV1 {
  if (value !== "active_status_statement_v1" && value !== "receipt_statement_v1") {
    throw protocolError("MESSAGE_INVALID", "Signer-host signature operation is invalid.");
  }
  return value;
}

function requireCancellationReason(value: unknown): ServerBindingSignerHostCancellationReasonV1 {
  if (value !== "caller_abort" && value !== "deadline" && value !== "shutdown") {
    throw protocolError("MESSAGE_INVALID", "Signer-host cancellation reason is invalid.");
  }
  return value;
}

function requireChildErrorCode(value: unknown): ServerBindingSignerHostChildErrorCodeV1 {
  switch (value) {
    case "HANDSHAKE_REJECTED":
    case "REQUEST_INVALID":
    case "REQUEST_BUSY":
    case "SIGNING_FAILED":
    case "CANCEL_FAILED":
    case "SHUTDOWN_REJECTED":
    case "INTERNAL_FAILURE":
      return value;
    default:
      throw protocolError("MESSAGE_INVALID", "Signer-host child error code is invalid.");
  }
}

function requirePositiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
    throw protocolError("MESSAGE_INVALID", `${name} is invalid.`);
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw protocolError("MESSAGE_INVALID", `${name} must be a string.`);
  }
  return value;
}

function assertPayloadLength(length: number): void {
  if (length === 0) {
    throw protocolError("FRAME_INVALID", "Signer-host frame payload must not be empty.");
  }
  if (length > SERVER_BINDING_SIGNER_HOST_MAXIMUM_FRAME_BYTES) {
    throw protocolError("FRAME_LIMIT_EXCEEDED", "Signer-host frame payload exceeds its limit.");
  }
}

function assertAscii(value: string, name: string): void {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      throw protocolError("MESSAGE_INVALID", `${name} must contain only ASCII values.`);
    }
  }
}

function snapshotPlainDataObject(value: unknown, name: string): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") throw new TypeError();
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        throw new TypeError();
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    throw protocolError("MESSAGE_INVALID", `${name} must be an exact plain data object.`);
  }
}

function snapshotExactStringArray(value: unknown, name: string): readonly string[] {
  try {
    if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = (
      descriptors as unknown as Record<string, PropertyDescriptor | undefined>
    ).length;
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      throw new TypeError();
    }
    const length = lengthDescriptor.value;
    const ownKeys = Reflect.ownKeys(descriptors);
    const expectedKeys = Array.from({ length }, (_, index) => String(index));
    expectedKeys.push("length");
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      throw new TypeError();
    }
    const snapshot: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "string"
      ) {
        throw new TypeError();
      }
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch {
    throw protocolError("MESSAGE_INVALID", `${name} must be an exact string array.`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw protocolError("MESSAGE_INVALID", "Signer-host message has an invalid member set.");
  }
}

interface IntrinsicUint8View {
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
}

function snapshotByteView(value: Uint8Array, name: string): Buffer {
  const before = readIntrinsicUint8View(value, name);
  let snapshot: Buffer;
  try {
    snapshot = Buffer.from(new Uint8Array(before.buffer, before.byteOffset, before.byteLength));
  } catch {
    throw protocolError("FRAME_INVALID", `${name} could not be snapshotted.`);
  }
  const after = readIntrinsicUint8View(value, name);
  if (
    before.buffer !== after.buffer ||
    before.byteLength !== after.byteLength ||
    before.byteOffset !== after.byteOffset ||
    snapshot.byteLength !== before.byteLength
  ) {
    throw protocolError("FRAME_INVALID", `${name} changed while it was snapshotted.`);
  }
  return snapshot;
}

function readIntrinsicUint8View(value: Uint8Array, name: string): IntrinsicUint8View {
  try {
    if (
      typedArrayBufferGetter === undefined ||
      typedArrayByteLengthGetter === undefined ||
      typedArrayByteOffsetGetter === undefined ||
      typedArrayTagGetter === undefined ||
      value === null ||
      typeof value !== "object" ||
      Reflect.apply(typedArrayTagGetter, value, []) !== "Uint8Array"
    ) {
      throw new TypeError();
    }
    return {
      buffer: Reflect.apply(typedArrayBufferGetter, value, []) as ArrayBufferLike,
      byteLength: Reflect.apply(typedArrayByteLengthGetter, value, []) as number,
      byteOffset: Reflect.apply(typedArrayByteOffsetGetter, value, []) as number,
    };
  } catch {
    throw protocolError("FRAME_INVALID", `${name} must be an intrinsic Uint8Array view.`);
  }
}

function readUnsignedBigEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function deepFreezeData<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreezeData(child);
    Object.freeze(value);
  }
  return value;
}

function protocolError(
  code: ServerBindingSignerHostProtocolErrorCodeV1,
  message: string,
): ServerBindingSignerHostProtocolErrorV1 {
  return new ServerBindingSignerHostProtocolErrorV1(code, message);
}
