/// <reference types="node" />

import {
  createHash,
  createPublicKey,
  type KeyObject,
  verify as nodeVerify,
  timingSafeEqual,
} from "node:crypto";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const SERVER_BINDING_AUTHORITY_SCHEMA_VERSION = 1 as const;
export const SERVER_BINDING_AUTHORITY_MAXIMUM_DOCUMENT_BYTES = 4 * 1024;
export const SERVER_BINDING_ACTIVE_STATUS_MAXIMUM_LIFETIME_MS = 60_000;
export const SERVER_BINDING_ACTIVE_STATUS_MAXIMUM_CLOCK_SKEW_MS = 5_000;
export const SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM =
  "ecdsa-p256-sha256-p1363-low-s" as const;
export const SERVER_BINDING_AUTHORITY_ISSUER =
  "agentic-review-server-enrollment-binding-authority-v1" as const;
export const SERVER_BINDING_RECEIPT_PROFILE_ID =
  "agentic-review-server-binding-receipt-v1" as const;
export const SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID =
  "agentic-review-server-binding-active-status-v1" as const;
export const SERVER_BINDING_RECEIPT_SIGNING_DOMAIN =
  "AgenticReview Server binding receipt v1" as const;
export const SERVER_BINDING_ACTIVE_STATUS_SIGNING_DOMAIN =
  "AgenticReview Server binding active status v1" as const;

const uuidV4Pattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\\s\\S])";
const sha256Pattern = "^[a-f0-9]{64}(?![\\s\\S])";
const entityIdPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\\s\\S])";
const packageComponentIdPattern = "^[a-z0-9][a-z0-9._+-]{0,127}(?![\\s\\S])";
const canonicalUtcMillisecondsPattern =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z(?![\\s\\S])";
const p1363SignaturePattern = "^[A-Za-z0-9_-]{86}(?![\\s\\S])";
const challengeNoncePattern = "^[A-Za-z0-9_-]{43}(?![\\s\\S])";

const p256Order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const p256HalfOrder = p256Order >> 1n;
const canonicalP256SpkiPrefix = Buffer.from(
  "3059301306072a8648ce3d020106082a8648ce3d03010703420004",
  "hex",
);
const canonicalP256SpkiBytes = 91;
const canonicalP256SpkiCurveNames = new Set(["prime256v1", "P-256"]);
const dosReservedBaseName =
  /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9]|lpt[1-9])(?![\s\S])/u;
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

function createUuidV4Schema() {
  return Type.String({ minLength: 36, maxLength: 36, pattern: uuidV4Pattern });
}

function createSha256Schema() {
  return Type.String({ minLength: 64, maxLength: 64, pattern: sha256Pattern });
}

function createCanonicalUtcMillisecondsSchema() {
  return Type.String({
    minLength: 24,
    maxLength: 24,
    pattern: canonicalUtcMillisecondsPattern,
  });
}

function createEntityIdSchema() {
  return Type.String({ minLength: 1, maxLength: 128, pattern: entityIdPattern });
}

function createPackageComponentIdSchema() {
  return Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: packageComponentIdPattern,
  });
}

function createP1363LowSSignatureSchema() {
  return Type.String({ minLength: 86, maxLength: 86, pattern: p1363SignaturePattern });
}

function createChallengeNonceSchema() {
  return Type.String({ minLength: 43, maxLength: 43, pattern: challengeNoncePattern });
}

function createReceiptStatementSchema() {
  return Type.Object(
    {
      bindingId: createUuidV4Schema(),
      bindingRevision: Type.Literal(1),
      boundAt: createCanonicalUtcMillisecondsSchema(),
      certificateDerSha256: createSha256Schema(),
      enrollmentGeneration: Type.Literal(1),
      installationId: createPackageComponentIdSchema(),
      statementType: Type.Literal("durable-binding-created"),
      workerNodeId: createEntityIdSchema(),
    },
    { additionalProperties: false },
  );
}

function createActiveStatusStatementSchema() {
  return Type.Object(
    {
      bindingId: createUuidV4Schema(),
      bindingRevision: Type.Literal(1),
      certificateDerSha256: createSha256Schema(),
      challengeNonceBase64Url: createChallengeNonceSchema(),
      enrollmentGeneration: Type.Literal(1),
      expiresAt: createCanonicalUtcMillisecondsSchema(),
      installationId: createPackageComponentIdSchema(),
      issuedAt: createCanonicalUtcMillisecondsSchema(),
      receiptSha256: createSha256Schema(),
      recordDocumentSha256: createSha256Schema(),
      statementType: Type.Literal("active-binding-current"),
      workerNodeId: createEntityIdSchema(),
    },
    { additionalProperties: false },
  );
}

export const ServerBindingReceiptStatementV1Schema = freezeSchema(createReceiptStatementSchema());

export type ServerBindingReceiptStatementV1 = Static<typeof ServerBindingReceiptStatementV1Schema>;

export const ServerBindingReceiptV1Schema = freezeSchema(
  Type.Object(
    {
      algorithm: Type.Literal(SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM),
      issuer: Type.Literal(SERVER_BINDING_AUTHORITY_ISSUER),
      issuerKeyId: createSha256Schema(),
      profileId: Type.Literal(SERVER_BINDING_RECEIPT_PROFILE_ID),
      schemaVersion: Type.Literal(SERVER_BINDING_AUTHORITY_SCHEMA_VERSION),
      signature: createP1363LowSSignatureSchema(),
      statement: createReceiptStatementSchema(),
    },
    { additionalProperties: false },
  ),
);

export type ServerBindingReceiptV1 = Static<typeof ServerBindingReceiptV1Schema>;

export const ServerBindingActiveStatusStatementV1Schema = freezeSchema(
  createActiveStatusStatementSchema(),
);

export type ServerBindingActiveStatusStatementV1 = Static<
  typeof ServerBindingActiveStatusStatementV1Schema
>;

export const ServerBindingActiveStatusV1Schema = freezeSchema(
  Type.Object(
    {
      algorithm: Type.Literal(SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM),
      issuer: Type.Literal(SERVER_BINDING_AUTHORITY_ISSUER),
      issuerKeyId: createSha256Schema(),
      profileId: Type.Literal(SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID),
      schemaVersion: Type.Literal(SERVER_BINDING_AUTHORITY_SCHEMA_VERSION),
      signature: createP1363LowSSignatureSchema(),
      statement: createActiveStatusStatementSchema(),
    },
    { additionalProperties: false },
  ),
);

export type ServerBindingActiveStatusV1 = Static<typeof ServerBindingActiveStatusV1Schema>;

export type ServerBindingSignatureDocumentKindV1 = "receipt" | "active-status";

/** Ordinary cryptographic facts only. The caller-supplied key is not a trust source. */
export interface ServerBindingSignatureFactsV1 {
  readonly algorithm: typeof SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM;
  readonly documentKind: ServerBindingSignatureDocumentKindV1;
  readonly issuerKeyId: string;
  readonly signatureValid: true;
}

export type ServerBindingAuthorityContractErrorCode =
  | "SERVER_BINDING_DOCUMENT_INVALID"
  | "SERVER_BINDING_DOCUMENT_LIMIT_EXCEEDED"
  | "SERVER_BINDING_DOCUMENT_NOT_CANONICAL"
  | "SERVER_BINDING_ISSUER_KEY_ID_MISMATCH"
  | "SERVER_BINDING_SIGNATURE_INVALID"
  | "SERVER_BINDING_SPKI_INVALID";

export class ServerBindingAuthorityContractError extends Error {
  public constructor(
    public readonly code: ServerBindingAuthorityContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServerBindingAuthorityContractError";
  }
}

const receiptStatementKeys = [
  "bindingId",
  "bindingRevision",
  "boundAt",
  "certificateDerSha256",
  "enrollmentGeneration",
  "installationId",
  "statementType",
  "workerNodeId",
] as const;
const receiptKeys = [
  "algorithm",
  "issuer",
  "issuerKeyId",
  "profileId",
  "schemaVersion",
  "signature",
  "statement",
] as const;
const activeStatusStatementKeys = [
  "bindingId",
  "bindingRevision",
  "certificateDerSha256",
  "challengeNonceBase64Url",
  "enrollmentGeneration",
  "expiresAt",
  "installationId",
  "issuedAt",
  "receiptSha256",
  "recordDocumentSha256",
  "statementType",
  "workerNodeId",
] as const;
const activeStatusKeys = receiptKeys;

export function marshalServerBindingReceiptStatementV1(
  value: ServerBindingReceiptStatementV1,
): Uint8Array {
  const snapshot = snapshotReceiptStatement(value);
  validateReceiptStatement(snapshot);
  return Buffer.from(serializeReceiptStatement(snapshot), "utf8");
}

export function marshalServerBindingReceiptV1(value: ServerBindingReceiptV1): Uint8Array {
  const snapshot = snapshotReceipt(value);
  validateReceipt(snapshot);
  return Buffer.from(serializeReceipt(snapshot), "utf8");
}

export function parseServerBindingReceiptV1(document: Uint8Array): ServerBindingReceiptV1 {
  return parseCanonicalDocument(document, snapshotReceipt, validateReceipt, serializeReceipt);
}

export function marshalServerBindingActiveStatusStatementV1(
  value: ServerBindingActiveStatusStatementV1,
): Uint8Array {
  const snapshot = snapshotActiveStatusStatement(value);
  validateActiveStatusStatement(snapshot);
  return Buffer.from(serializeActiveStatusStatement(snapshot), "utf8");
}

export function marshalServerBindingActiveStatusV1(value: ServerBindingActiveStatusV1): Uint8Array {
  const snapshot = snapshotActiveStatus(value);
  validateActiveStatus(snapshot);
  return Buffer.from(serializeActiveStatus(snapshot), "utf8");
}

export function parseServerBindingActiveStatusV1(
  document: Uint8Array,
): ServerBindingActiveStatusV1 {
  return parseCanonicalDocument(
    document,
    snapshotActiveStatus,
    validateActiveStatus,
    serializeActiveStatus,
  );
}

export function serverBindingReceiptSigningPreimageV1(
  statement: ServerBindingReceiptStatementV1,
): Uint8Array {
  return signingPreimage(
    SERVER_BINDING_RECEIPT_SIGNING_DOMAIN,
    marshalServerBindingReceiptStatementV1(statement),
  );
}

export function serverBindingReceiptSigningDigestV1(
  statement: ServerBindingReceiptStatementV1,
): Uint8Array {
  return createHash("sha256").update(serverBindingReceiptSigningPreimageV1(statement)).digest();
}

export function serverBindingActiveStatusSigningPreimageV1(
  statement: ServerBindingActiveStatusStatementV1,
): Uint8Array {
  return signingPreimage(
    SERVER_BINDING_ACTIVE_STATUS_SIGNING_DOMAIN,
    marshalServerBindingActiveStatusStatementV1(statement),
  );
}

export function serverBindingActiveStatusSigningDigestV1(
  statement: ServerBindingActiveStatusStatementV1,
): Uint8Array {
  return createHash("sha256")
    .update(serverBindingActiveStatusSigningPreimageV1(statement))
    .digest();
}

export function deriveServerBindingIssuerKeyIdV1(issuerPublicKeySpki: Uint8Array): string {
  const snapshot = snapshotCanonicalP256SpkiBytes(issuerPublicKeySpki);
  parseCanonicalP256Spki(snapshot);
  return createHash("sha256").update(snapshot).digest("hex");
}

export function verifyServerBindingReceiptWithSpkiV1(
  document: Uint8Array,
  issuerPublicKeySpki: Uint8Array,
): Readonly<ServerBindingSignatureFactsV1> {
  const receipt = parseServerBindingReceiptV1(document);
  return verifyWithCallerSpki(
    "receipt",
    receipt.issuerKeyId,
    receipt.signature,
    serverBindingReceiptSigningPreimageV1(receipt.statement),
    issuerPublicKeySpki,
  );
}

export function verifyServerBindingActiveStatusWithSpkiV1(
  document: Uint8Array,
  issuerPublicKeySpki: Uint8Array,
): Readonly<ServerBindingSignatureFactsV1> {
  const status = parseServerBindingActiveStatusV1(document);
  return verifyWithCallerSpki(
    "active-status",
    status.issuerKeyId,
    status.signature,
    serverBindingActiveStatusSigningPreimageV1(status.statement),
    issuerPublicKeySpki,
  );
}

function snapshotReceiptStatement(value: unknown): ServerBindingReceiptStatementV1 {
  const fields = snapshotExactDataObject(value, receiptStatementKeys, "Binding receipt statement");
  return {
    bindingId: fields.bindingId,
    bindingRevision: fields.bindingRevision,
    boundAt: fields.boundAt,
    certificateDerSha256: fields.certificateDerSha256,
    enrollmentGeneration: fields.enrollmentGeneration,
    installationId: fields.installationId,
    statementType: fields.statementType,
    workerNodeId: fields.workerNodeId,
  } as ServerBindingReceiptStatementV1;
}

function snapshotReceipt(value: unknown): ServerBindingReceiptV1 {
  const fields = snapshotExactDataObject(value, receiptKeys, "Binding receipt");
  return {
    algorithm: fields.algorithm,
    issuer: fields.issuer,
    issuerKeyId: fields.issuerKeyId,
    profileId: fields.profileId,
    schemaVersion: fields.schemaVersion,
    signature: fields.signature,
    statement: snapshotReceiptStatement(fields.statement),
  } as ServerBindingReceiptV1;
}

function snapshotActiveStatusStatement(value: unknown): ServerBindingActiveStatusStatementV1 {
  const fields = snapshotExactDataObject(
    value,
    activeStatusStatementKeys,
    "Binding active-status statement",
  );
  return {
    bindingId: fields.bindingId,
    bindingRevision: fields.bindingRevision,
    certificateDerSha256: fields.certificateDerSha256,
    challengeNonceBase64Url: fields.challengeNonceBase64Url,
    enrollmentGeneration: fields.enrollmentGeneration,
    expiresAt: fields.expiresAt,
    installationId: fields.installationId,
    issuedAt: fields.issuedAt,
    receiptSha256: fields.receiptSha256,
    recordDocumentSha256: fields.recordDocumentSha256,
    statementType: fields.statementType,
    workerNodeId: fields.workerNodeId,
  } as ServerBindingActiveStatusStatementV1;
}

function snapshotActiveStatus(value: unknown): ServerBindingActiveStatusV1 {
  const fields = snapshotExactDataObject(value, activeStatusKeys, "Binding active-status");
  return {
    algorithm: fields.algorithm,
    issuer: fields.issuer,
    issuerKeyId: fields.issuerKeyId,
    profileId: fields.profileId,
    schemaVersion: fields.schemaVersion,
    signature: fields.signature,
    statement: snapshotActiveStatusStatement(fields.statement),
  } as ServerBindingActiveStatusV1;
}

function snapshotExactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
  name: string,
): Record<string, unknown> {
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("not an object");
    }
    prototype = Reflect.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_INVALID",
      `${name} could not be snapshotted as a plain data object.`,
    );
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw contractError("SERVER_BINDING_DOCUMENT_INVALID", `${name} must be a plain object.`);
  }
  const descriptorKeys = Reflect.ownKeys(descriptors);
  if (
    descriptorKeys.length !== expectedKeys.length ||
    descriptorKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key)) ||
    expectedKeys.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_INVALID",
      `${name} does not have its exact member set.`,
    );
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw contractError("SERVER_BINDING_DOCUMENT_INVALID", `${name} contains a non-data member.`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function validateReceipt(value: unknown): asserts value is ServerBindingReceiptV1 {
  if (!Value.Check(ServerBindingReceiptV1Schema, value)) {
    throw contractError("SERVER_BINDING_DOCUMENT_INVALID", "Binding receipt fields are invalid.");
  }
  validateReceiptStatement(value.statement);
  decodeCanonicalP1363LowSSignature(value.signature);
}

function validateReceiptStatement(
  value: unknown,
): asserts value is ServerBindingReceiptStatementV1 {
  if (!Value.Check(ServerBindingReceiptStatementV1Schema, value)) {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_INVALID",
      "Binding receipt statement fields are invalid.",
    );
  }
  assertCanonicalUtcMilliseconds(value.boundAt, "boundAt");
  assertPackageComponentId(value.installationId);
}

function validateActiveStatus(value: unknown): asserts value is ServerBindingActiveStatusV1 {
  if (!Value.Check(ServerBindingActiveStatusV1Schema, value)) {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_INVALID",
      "Binding active-status fields are invalid.",
    );
  }
  validateActiveStatusStatement(value.statement);
  decodeCanonicalP1363LowSSignature(value.signature);
}

function validateActiveStatusStatement(
  value: unknown,
): asserts value is ServerBindingActiveStatusStatementV1 {
  if (!Value.Check(ServerBindingActiveStatusStatementV1Schema, value)) {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_INVALID",
      "Binding active-status statement fields are invalid.",
    );
  }
  assertPackageComponentId(value.installationId);
  assertCanonicalBase64Url(value.challengeNonceBase64Url, 32, "challengeNonceBase64Url");
  const issuedAt = assertCanonicalUtcMilliseconds(value.issuedAt, "issuedAt");
  const expiresAt = assertCanonicalUtcMilliseconds(value.expiresAt, "expiresAt");
  const lifetime = expiresAt - issuedAt;
  if (lifetime <= 0 || lifetime > SERVER_BINDING_ACTIVE_STATUS_MAXIMUM_LIFETIME_MS) {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_INVALID",
      "Binding active-status lifetime is invalid.",
    );
  }
}

function assertPackageComponentId(value: string): void {
  const base = value.split(".", 1)[0];
  if (
    value === "." ||
    value === ".." ||
    value.endsWith(".") ||
    value.endsWith(" ") ||
    base === undefined ||
    dosReservedBaseName.test(base)
  ) {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_INVALID",
      "installationId is not a canonical package component identifier.",
    );
  }
}

function assertCanonicalUtcMilliseconds(value: string, name: string): number {
  const milliseconds = Date.parse(value);
  if (
    value.startsWith("0000-") ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_INVALID",
      `${name} is not a canonical UTC millisecond instant.`,
    );
  }
  return milliseconds;
}

function parseCanonicalDocument<T>(
  document: Uint8Array,
  snapshotValue: (value: unknown) => T,
  validate: (value: unknown) => asserts value is T,
  serialize: (value: T) => string,
): T {
  const snapshot = snapshotBoundedDocumentBytes(document);
  if (snapshot[0] === 0xef && snapshot[1] === 0xbb && snapshot[2] === 0xbf) {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_INVALID",
      "Binding authority document must not contain a byte-order mark.",
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot);
  } catch {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_INVALID",
      "Binding authority document is not valid UTF-8.",
    );
  }
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) {
      throw contractError(
        "SERVER_BINDING_DOCUMENT_INVALID",
        "Binding authority document must contain only ASCII values.",
      );
    }
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_INVALID",
      "Binding authority document is not valid JSON.",
    );
  }
  const normalized = snapshotValue(value);
  validate(normalized);
  const canonical = serialize(normalized);
  if (canonical !== text) {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_NOT_CANONICAL",
      "Binding authority document is not in its canonical representation.",
    );
  }
  return deepFreezeData(normalized);
}

function serializeReceiptStatement(value: ServerBindingReceiptStatementV1): string {
  return stringifyKnownJson({
    bindingId: value.bindingId,
    bindingRevision: value.bindingRevision,
    boundAt: value.boundAt,
    certificateDerSha256: value.certificateDerSha256,
    enrollmentGeneration: value.enrollmentGeneration,
    installationId: value.installationId,
    statementType: value.statementType,
    workerNodeId: value.workerNodeId,
  });
}

function serializeReceipt(value: ServerBindingReceiptV1): string {
  return `{"algorithm":${JSON.stringify(value.algorithm)},"issuer":${JSON.stringify(
    value.issuer,
  )},"issuerKeyId":${JSON.stringify(value.issuerKeyId)},"profileId":${JSON.stringify(
    value.profileId,
  )},"schemaVersion":${value.schemaVersion},"signature":${JSON.stringify(
    value.signature,
  )},"statement":${serializeReceiptStatement(value.statement)}}`;
}

function serializeActiveStatusStatement(value: ServerBindingActiveStatusStatementV1): string {
  return stringifyKnownJson({
    bindingId: value.bindingId,
    bindingRevision: value.bindingRevision,
    certificateDerSha256: value.certificateDerSha256,
    challengeNonceBase64Url: value.challengeNonceBase64Url,
    enrollmentGeneration: value.enrollmentGeneration,
    expiresAt: value.expiresAt,
    installationId: value.installationId,
    issuedAt: value.issuedAt,
    receiptSha256: value.receiptSha256,
    recordDocumentSha256: value.recordDocumentSha256,
    statementType: value.statementType,
    workerNodeId: value.workerNodeId,
  });
}

function serializeActiveStatus(value: ServerBindingActiveStatusV1): string {
  return `{"algorithm":${JSON.stringify(value.algorithm)},"issuer":${JSON.stringify(
    value.issuer,
  )},"issuerKeyId":${JSON.stringify(value.issuerKeyId)},"profileId":${JSON.stringify(
    value.profileId,
  )},"schemaVersion":${value.schemaVersion},"signature":${JSON.stringify(
    value.signature,
  )},"statement":${serializeActiveStatusStatement(value.statement)}}`;
}

function signingPreimage(domain: string, statement: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from(domain, "ascii"), Buffer.from([0]), Buffer.from(statement)]);
}

function stringifyKnownJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_INVALID",
      "Binding authority document cannot be serialized.",
    );
  }
  return serialized;
}

function verifyWithCallerSpki(
  documentKind: ServerBindingSignatureDocumentKindV1,
  documentIssuerKeyId: string,
  signatureText: string,
  signingPreimageBytes: Uint8Array,
  issuerPublicKeySpki: Uint8Array,
): Readonly<ServerBindingSignatureFactsV1> {
  const spkiSnapshot = snapshotCanonicalP256SpkiBytes(issuerPublicKeySpki);
  const key = parseCanonicalP256Spki(spkiSnapshot);
  const derivedKeyId = createHash("sha256").update(spkiSnapshot).digest("hex");
  if (!secureHexEqual(documentIssuerKeyId, derivedKeyId)) {
    throw contractError(
      "SERVER_BINDING_ISSUER_KEY_ID_MISMATCH",
      "Binding authority issuer key ID does not match the supplied SPKI.",
    );
  }
  const signature = decodeCanonicalP1363LowSSignature(signatureText);

  // Node performs SHA-256 internally, so it must receive the raw domain-separated preimage once.
  if (!nodeVerify("sha256", signingPreimageBytes, { key, dsaEncoding: "ieee-p1363" }, signature)) {
    throw contractError(
      "SERVER_BINDING_SIGNATURE_INVALID",
      "Binding authority signature is invalid.",
    );
  }
  return Object.freeze({
    algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
    documentKind,
    issuerKeyId: derivedKeyId,
    signatureValid: true,
  });
}

function parseCanonicalP256Spki(document: Buffer): KeyObject {
  const bytes = document;
  if (
    bytes.byteLength !== canonicalP256SpkiBytes ||
    !bytes.subarray(0, canonicalP256SpkiPrefix.byteLength).equals(canonicalP256SpkiPrefix)
  ) {
    throw contractError(
      "SERVER_BINDING_SPKI_INVALID",
      "Binding authority SPKI is not canonical uncompressed P-256 PKIX DER.",
    );
  }

  let key: KeyObject;
  try {
    key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  } catch {
    throw contractError("SERVER_BINDING_SPKI_INVALID", "Binding authority SPKI is invalid.");
  }
  if (
    key.type !== "public" ||
    key.asymmetricKeyType !== "ec" ||
    !canonicalP256SpkiCurveNames.has(key.asymmetricKeyDetails?.namedCurve ?? "")
  ) {
    throw contractError("SERVER_BINDING_SPKI_INVALID", "Binding authority SPKI is not P-256.");
  }

  let canonical: Buffer;
  try {
    canonical = key.export({ format: "der", type: "spki" });
  } catch {
    throw contractError("SERVER_BINDING_SPKI_INVALID", "Binding authority SPKI cannot be encoded.");
  }
  if (canonical.byteLength !== bytes.byteLength || !timingSafeEqual(canonical, bytes)) {
    throw contractError(
      "SERVER_BINDING_SPKI_INVALID",
      "Binding authority SPKI does not use its canonical encoding.",
    );
  }
  return key;
}

function snapshotBoundedDocumentBytes(value: Uint8Array): Buffer {
  const view = readIntrinsicUint8View(
    value,
    "Binding authority document",
    "SERVER_BINDING_DOCUMENT_INVALID",
  );
  if (view.byteLength === 0 || view.byteLength > SERVER_BINDING_AUTHORITY_MAXIMUM_DOCUMENT_BYTES) {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_LIMIT_EXCEEDED",
      "Binding authority document size is outside the supported range.",
    );
  }
  return copyIntrinsicUint8View(
    value,
    view,
    "Binding authority document",
    "SERVER_BINDING_DOCUMENT_INVALID",
  );
}

function snapshotCanonicalP256SpkiBytes(value: Uint8Array): Buffer {
  const view = readIntrinsicUint8View(
    value,
    "Binding authority SPKI",
    "SERVER_BINDING_SPKI_INVALID",
  );
  if (view.byteLength !== canonicalP256SpkiBytes) {
    throw contractError(
      "SERVER_BINDING_SPKI_INVALID",
      "Binding authority SPKI is not exactly 91 bytes.",
    );
  }
  return copyIntrinsicUint8View(
    value,
    view,
    "Binding authority SPKI",
    "SERVER_BINDING_SPKI_INVALID",
  );
}

interface IntrinsicUint8View {
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
}

function readIntrinsicUint8View(
  value: Uint8Array,
  name: string,
  code: ServerBindingAuthorityContractErrorCode,
): IntrinsicUint8View {
  try {
    if (
      typedArrayBufferGetter === undefined ||
      typedArrayByteLengthGetter === undefined ||
      typedArrayByteOffsetGetter === undefined ||
      typedArrayTagGetter === undefined
    ) {
      throw new TypeError("typed-array intrinsic getters are unavailable");
    }
    const tag = Reflect.apply(typedArrayTagGetter, value, []) as unknown;
    const buffer = Reflect.apply(typedArrayBufferGetter, value, []) as unknown;
    const byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []) as unknown;
    const byteOffset = Reflect.apply(typedArrayByteOffsetGetter, value, []) as unknown;
    if (
      tag !== "Uint8Array" ||
      !(buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer) ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      typeof byteOffset !== "number" ||
      !Number.isSafeInteger(byteOffset) ||
      byteOffset < 0
    ) {
      throw new TypeError("value has no exact Uint8Array internal slot");
    }
    return { buffer, byteLength, byteOffset };
  } catch {
    throw contractError(code, `${name} is not an intrinsic Uint8Array view.`);
  }
}

function copyIntrinsicUint8View(
  value: Uint8Array,
  before: IntrinsicUint8View,
  name: string,
  code: ServerBindingAuthorityContractErrorCode,
): Buffer {
  let snapshot: Buffer;
  try {
    const safeView = new Uint8Array(before.buffer, before.byteOffset, before.byteLength);
    snapshot = Buffer.from(safeView);
  } catch {
    throw contractError(code, `${name} bytes could not be snapshotted.`);
  }
  const after = readIntrinsicUint8View(value, name, code);
  if (
    after.buffer !== before.buffer ||
    after.byteOffset !== before.byteOffset ||
    after.byteLength !== before.byteLength ||
    snapshot.byteLength !== before.byteLength
  ) {
    throw contractError(code, `${name} changed while it was snapshotted.`);
  }
  return snapshot;
}

function decodeCanonicalP1363LowSSignature(encoded: string): Buffer {
  if (!new RegExp(p1363SignaturePattern, "u").test(encoded)) {
    throw contractError(
      "SERVER_BINDING_SIGNATURE_INVALID",
      "Binding authority signature encoding is invalid.",
    );
  }
  const signature = Buffer.from(encoded, "base64url");
  if (signature.byteLength !== 64 || signature.toString("base64url") !== encoded) {
    throw contractError(
      "SERVER_BINDING_SIGNATURE_INVALID",
      "Binding authority signature encoding is not canonical.",
    );
  }
  const r = readUnsignedBigEndian(signature.subarray(0, 32));
  const s = readUnsignedBigEndian(signature.subarray(32));
  if (r <= 0n || r >= p256Order || s <= 0n || s > p256HalfOrder) {
    throw contractError(
      "SERVER_BINDING_SIGNATURE_INVALID",
      "Binding authority signature is not canonical low-S ECDSA.",
    );
  }
  return signature;
}

function assertCanonicalBase64Url(value: string, expectedBytes: number, name: string): void {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== expectedBytes || decoded.toString("base64url") !== value) {
    throw contractError(
      "SERVER_BINDING_DOCUMENT_INVALID",
      `${name} is not canonical unpadded base64url.`,
    );
  }
}

function readUnsignedBigEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function secureHexEqual(left: string, right: string): boolean {
  if (!new RegExp(sha256Pattern, "u").test(left) || !new RegExp(sha256Pattern, "u").test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function deepFreezeData<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeData(child);
    Object.freeze(value);
  }
  return value;
}

function freezeSchema<TSchemaValue extends TSchema>(schema: TSchemaValue): TSchemaValue {
  const visited = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) freeze(descriptor.value);
    }
    Object.freeze(value);
  };
  freeze(schema);
  return schema;
}

function contractError(
  code: ServerBindingAuthorityContractErrorCode,
  message: string,
): ServerBindingAuthorityContractError {
  return new ServerBindingAuthorityContractError(code, message);
}
