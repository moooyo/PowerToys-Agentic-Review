import {
  createHash,
  createPublicKey,
  type KeyObject,
  sign as nodeSign,
  verify as nodeVerify,
  timingSafeEqual,
} from "node:crypto";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  createCanonicalJsonDocument,
  LOCAL_CANONICAL_JSON_VERSION,
  serializeCanonicalJson,
} from "./canonical.js";

export const EXECUTION_CAPABILITY_VERSION = 1 as const;
export const RENEWAL_GRANT_VERSION = 1 as const;
export const LOCAL_CAPABILITY_AUDIENCE = "agentic-review/windows-executor/v1" as const;
export const LOCAL_CAPABILITY_SIGNATURE_ALGORITHM = "ECDSA_P256_SHA256_P1363_LOW_S" as const;
export const LOCAL_GRANT_MAXIMUM_DURATION_MS = 45_000;

export type LocalAuthoritySigningDomain =
  | "ExecutionCapabilityV1"
  | "RenewalGrantV1"
  | "HandshakeTranscriptV1";

export const localCapabilityResourceBounds = Object.freeze({
  maximumProcesses: Object.freeze({ minimum: 1, maximum: 1_024 }),
  memoryBytes: Object.freeze({ minimum: 64n * 1024n * 1024n, maximum: 1n << 40n }),
  outputBytes: Object.freeze({ minimum: 1, maximum: 1 << 30 }),
  artifactBytes: Object.freeze({ minimum: 1n, maximum: 64n << 30n }),
  diskBytes: Object.freeze({ minimum: 1n << 20n, maximum: 1n << 40n }),
  hardTimeoutMs: Object.freeze({ minimum: 1_000, maximum: 24 * 60 * 60 * 1_000 }),
});

const safeIntegerMaximum = Number.MAX_SAFE_INTEGER;
const uuidV4Pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const entityIdPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]*$";
const sha256Pattern = "^[a-f0-9]{64}$";
const decimalPattern = "^(?:0|[1-9][0-9]{0,20})$";
const repositoryPattern = "^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$";
const recipeComponentPattern = "^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$";
const p1363SignaturePattern = "^[A-Za-z0-9_-]{86}$";
const p256Order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const p256HalfOrder = p256Order >> 1n;

const SafeNonNegativeIntegerSchema = Type.Integer({ minimum: 0, maximum: safeIntegerMaximum });
const SafePositiveIntegerSchema = Type.Integer({ minimum: 1, maximum: safeIntegerMaximum });
const UuidV4Schema = Type.String({ minLength: 36, maxLength: 36, pattern: uuidV4Pattern });
const Sha256Schema = Type.String({ minLength: 64, maxLength: 64, pattern: sha256Pattern });
const Random256BitSchema = Type.String({ minLength: 64, maxLength: 64, pattern: sha256Pattern });
const DecimalSchema = Type.String({ minLength: 1, maxLength: 21, pattern: decimalPattern });

export const LocalAuthoritySignatureSchema = Type.String({
  minLength: 86,
  maxLength: 86,
  pattern: p1363SignaturePattern,
});

export const LocalCapabilityResourceLimitsSchema = Type.Object(
  {
    maximumProcesses: Type.Integer(localCapabilityResourceBounds.maximumProcesses),
    memoryBytes: DecimalSchema,
    outputBytes: Type.Integer(localCapabilityResourceBounds.outputBytes),
    artifactBytes: DecimalSchema,
    diskBytes: DecimalSchema,
    hardTimeoutMs: Type.Integer(localCapabilityResourceBounds.hardTimeoutMs),
  },
  { additionalProperties: false },
);
export type LocalCapabilityResourceLimits = Static<typeof LocalCapabilityResourceLimitsSchema>;

export const LocalRepositoryIdentitySchema = Type.Object(
  {
    githubRepositoryId: SafePositiveIntegerSchema,
    fullName: Type.String({ minLength: 3, maxLength: 201, pattern: repositoryPattern }),
  },
  { additionalProperties: false },
);
export type LocalRepositoryIdentity = Static<typeof LocalRepositoryIdentitySchema>;

export const LocalTargetRevisionSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("issue"),
      revisionDigest: Sha256Schema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("pull_request"),
      baseSha: Type.String({ minLength: 40, maxLength: 64, pattern: "^[a-f0-9]{40,64}$" }),
      headSha: Type.String({ minLength: 40, maxLength: 64, pattern: "^[a-f0-9]{40,64}$" }),
    },
    { additionalProperties: false },
  ),
]);
export type LocalTargetRevision = Static<typeof LocalTargetRevisionSchema>;

export const LocalCapabilityDigestsSchema = Type.Object(
  {
    executorEnvelopeSha256: Sha256Schema,
    promptSha256: Sha256Schema,
    outputSchemaSha256: Sha256Schema,
    policySha256: Sha256Schema,
    recipeSetSha256: Sha256Schema,
  },
  { additionalProperties: false },
);
export type LocalCapabilityDigests = Static<typeof LocalCapabilityDigestsSchema>;

export const LocalCapabilityOperationSchema = Type.Union([
  Type.Object({ kind: Type.Literal("static_review") }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal("recipe"),
      recipeId: Type.String({ minLength: 1, maxLength: 128, pattern: recipeComponentPattern }),
      recipeVersion: Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: recipeComponentPattern,
      }),
      recipeSha256: Sha256Schema,
    },
    { additionalProperties: false },
  ),
]);
export type LocalCapabilityOperation = Static<typeof LocalCapabilityOperationSchema>;

export const ExecutionCapabilityV1Schema = Type.Object(
  {
    capabilityVersion: Type.Literal(EXECUTION_CAPABILITY_VERSION),
    canonicalizationVersion: Type.Literal(LOCAL_CANONICAL_JSON_VERSION),
    signatureAlgorithm: Type.Literal(LOCAL_CAPABILITY_SIGNATURE_ALGORITHM),
    keyId: Sha256Schema,
    audience: Type.Literal(LOCAL_CAPABILITY_AUDIENCE),
    capabilityId: Random256BitSchema,
    nonce: Random256BitSchema,
    workerNodeId: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: entityIdPattern,
    }),
    workerInstanceId: Type.String({ minLength: 1, maxLength: 128, pattern: entityIdPattern }),
    executorBootId: UuidV4Schema,
    sessionId: UuidV4Schema,
    attemptCorrelationId: UuidV4Schema,
    runAttemptId: Type.String({ minLength: 1, maxLength: 128, pattern: entityIdPattern }),
    jobId: Type.String({ minLength: 1, maxLength: 128, pattern: entityIdPattern }),
    leaseGeneration: SafePositiveIntegerSchema,
    grantSequence: Type.Literal(1),
    repository: LocalRepositoryIdentitySchema,
    targetRevision: LocalTargetRevisionSchema,
    digests: LocalCapabilityDigestsSchema,
    operation: LocalCapabilityOperationSchema,
    resources: LocalCapabilityResourceLimitsSchema,
    issuedAtUnixMs: SafeNonNegativeIntegerSchema,
    serverLeaseExpiresAtUnixMs: SafePositiveIntegerSchema,
    grantExpiresAtUnixMs: SafePositiveIntegerSchema,
    hardDeadlineUnixMs: SafePositiveIntegerSchema,
  },
  { additionalProperties: false },
);
export type ExecutionCapabilityV1 = Static<typeof ExecutionCapabilityV1Schema>;

export const RenewalGrantV1Schema = Type.Object(
  {
    renewalVersion: Type.Literal(RENEWAL_GRANT_VERSION),
    canonicalizationVersion: Type.Literal(LOCAL_CANONICAL_JSON_VERSION),
    signatureAlgorithm: Type.Literal(LOCAL_CAPABILITY_SIGNATURE_ALGORITHM),
    keyId: Sha256Schema,
    audience: Type.Literal(LOCAL_CAPABILITY_AUDIENCE),
    renewalId: Random256BitSchema,
    capabilityId: Random256BitSchema,
    nonce: Random256BitSchema,
    workerNodeId: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: entityIdPattern,
    }),
    workerInstanceId: Type.String({ minLength: 1, maxLength: 128, pattern: entityIdPattern }),
    executorBootId: UuidV4Schema,
    sessionId: UuidV4Schema,
    attemptCorrelationId: UuidV4Schema,
    runAttemptId: Type.String({ minLength: 1, maxLength: 128, pattern: entityIdPattern }),
    jobId: Type.String({ minLength: 1, maxLength: 128, pattern: entityIdPattern }),
    leaseGeneration: SafePositiveIntegerSchema,
    grantSequence: SafePositiveIntegerSchema,
    previousGrantSequence: SafePositiveIntegerSchema,
    serverHeartbeatSequence: SafePositiveIntegerSchema,
    initialCapabilitySha256: Sha256Schema,
    previousGrantSha256: Sha256Schema,
    issuedAtUnixMs: SafeNonNegativeIntegerSchema,
    serverLeaseExpiresAtUnixMs: SafePositiveIntegerSchema,
    grantExpiresAtUnixMs: SafePositiveIntegerSchema,
    hardDeadlineUnixMs: SafePositiveIntegerSchema,
  },
  { additionalProperties: false },
);
export type RenewalGrantV1 = Static<typeof RenewalGrantV1Schema>;

export const SignedExecutionCapabilityV1Schema = Type.Object(
  {
    capability: ExecutionCapabilityV1Schema,
    signature: LocalAuthoritySignatureSchema,
  },
  { additionalProperties: false },
);
export type SignedExecutionCapabilityV1 = Static<typeof SignedExecutionCapabilityV1Schema>;

export const SignedRenewalGrantV1Schema = Type.Object(
  {
    grant: RenewalGrantV1Schema,
    signature: LocalAuthoritySignatureSchema,
  },
  { additionalProperties: false },
);
export type SignedRenewalGrantV1 = Static<typeof SignedRenewalGrantV1Schema>;

export class LocalCapabilityError extends Error {
  public constructor(
    public readonly code:
      | "CAPABILITY_SCHEMA_INVALID"
      | "CAPABILITY_LIMIT_INVALID"
      | "CAPABILITY_TIME_INVALID"
      | "CAPABILITY_CONTEXT_MISMATCH"
      | "CAPABILITY_KEY_INVALID"
      | "CAPABILITY_SIGNATURE_INVALID"
      | "CAPABILITY_EXPIRED"
      | "RENEWAL_SEQUENCE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "LocalCapabilityError";
  }
}

export interface CapabilityVerificationContext {
  readonly expectedKeyId: string;
  readonly expectedWorkerNodeId: string;
  readonly expectedWorkerInstanceId: string;
  readonly expectedExecutorBootId: string;
  readonly expectedSessionId: string;
  readonly nowUnixMs: number;
  readonly maximumClockSkewMs?: number;
}

export interface RenewalVerificationContext extends CapabilityVerificationContext {
  readonly capability: ExecutionCapabilityV1;
  readonly expectedPreviousGrantSha256: string;
  readonly expectedPreviousGrantSequence: number;
  readonly expectedGrantSequence: number;
}

export function validateExecutionCapability(value: unknown): Readonly<ExecutionCapabilityV1> {
  const capability = normalizeSchemaValue<ExecutionCapabilityV1>(
    value,
    ExecutionCapabilityV1Schema,
    "CAPABILITY_SCHEMA_INVALID",
  );
  validateRepository(capability.repository.fullName);
  validateResourceLimits(capability.resources);
  validateGrantTimes(capability);
  if (
    capability.hardDeadlineUnixMs - capability.issuedAtUnixMs >
    capability.resources.hardTimeoutMs
  ) {
    throw capabilityError(
      "CAPABILITY_TIME_INVALID",
      "Capability hard deadline exceeds its signed timeout ceiling.",
    );
  }
  if (
    capability.capabilityId === capability.nonce ||
    isZeroDigest(capability.capabilityId) ||
    isZeroDigest(capability.nonce)
  ) {
    throw capabilityError(
      "CAPABILITY_CONTEXT_MISMATCH",
      "Capability replay identifiers must be independent.",
    );
  }
  return Object.freeze(capability);
}

export function validateRenewalGrant(value: unknown): Readonly<RenewalGrantV1> {
  const grant = normalizeSchemaValue<RenewalGrantV1>(
    value,
    RenewalGrantV1Schema,
    "CAPABILITY_SCHEMA_INVALID",
  );
  validateGrantTimes(grant);
  if (
    grant.renewalId === grant.capabilityId ||
    grant.renewalId === grant.nonce ||
    grant.capabilityId === grant.nonce ||
    isZeroDigest(grant.renewalId) ||
    isZeroDigest(grant.capabilityId) ||
    isZeroDigest(grant.nonce)
  ) {
    throw capabilityError(
      "CAPABILITY_CONTEXT_MISMATCH",
      "Renewal replay identifiers must be independent.",
    );
  }
  return Object.freeze(grant);
}

export function serializeExecutionCapability(capability: unknown): string {
  return serializeCanonicalJson(validateExecutionCapability(capability));
}

export function serializeRenewalGrant(grant: unknown): string {
  return serializeCanonicalJson(validateRenewalGrant(grant));
}

export function digestExecutionCapability(capability: unknown): string {
  return createCanonicalJsonDocument(validateExecutionCapability(capability)).sha256;
}

export function digestRenewalGrant(grant: unknown): string {
  return createCanonicalJsonDocument(validateRenewalGrant(grant)).sha256;
}

export function signExecutionCapability(
  capabilityValue: unknown,
  privateKey: KeyObject,
): Readonly<SignedExecutionCapabilityV1> {
  const capability = validateExecutionCapability(capabilityValue);
  assertP256PrivateKey(privateKey);
  assertLocalAuthorityKeyIdMatches(capability.keyId, privateKey);
  const signature = signLowS(
    createLocalAuthoritySigningBytes("ExecutionCapabilityV1", capability),
    privateKey,
  );
  return Object.freeze({ capability, signature });
}

export function signRenewalGrant(
  grantValue: unknown,
  privateKey: KeyObject,
): Readonly<SignedRenewalGrantV1> {
  const grant = validateRenewalGrant(grantValue);
  assertP256PrivateKey(privateKey);
  assertLocalAuthorityKeyIdMatches(grant.keyId, privateKey);
  const signature = signLowS(createLocalAuthoritySigningBytes("RenewalGrantV1", grant), privateKey);
  return Object.freeze({ grant, signature });
}

export function verifyExecutionCapability(
  signedValue: unknown,
  publicKey: KeyObject,
  context: CapabilityVerificationContext,
): Readonly<ExecutionCapabilityV1> {
  const signed = normalizeSchemaValue<SignedExecutionCapabilityV1>(
    signedValue,
    SignedExecutionCapabilityV1Schema,
    "CAPABILITY_SCHEMA_INVALID",
  );
  const capability = validateExecutionCapability(signed.capability);
  assertP256PublicKey(publicKey);
  assertLocalAuthorityKeyIdMatches(capability.keyId, publicKey);
  verifyLocalAuthoritySignature("ExecutionCapabilityV1", capability, signed.signature, publicKey);
  validateContext(capability, context);
  return capability;
}

export function verifyRenewalGrant(
  signedValue: unknown,
  publicKey: KeyObject,
  context: RenewalVerificationContext,
): Readonly<RenewalGrantV1> {
  const signed = normalizeSchemaValue<SignedRenewalGrantV1>(
    signedValue,
    SignedRenewalGrantV1Schema,
    "CAPABILITY_SCHEMA_INVALID",
  );
  const grant = validateRenewalGrant(signed.grant);
  assertP256PublicKey(publicKey);
  assertLocalAuthorityKeyIdMatches(grant.keyId, publicKey);
  verifyLocalAuthoritySignature("RenewalGrantV1", grant, signed.signature, publicKey);
  validateContext(grant, context);
  const capability = context.capability;
  for (const key of [
    "capabilityId",
    "keyId",
    "workerNodeId",
    "workerInstanceId",
    "executorBootId",
    "sessionId",
    "attemptCorrelationId",
    "runAttemptId",
    "jobId",
    "leaseGeneration",
    "hardDeadlineUnixMs",
  ] as const) {
    if (grant[key] !== capability[key]) {
      throw capabilityError("CAPABILITY_CONTEXT_MISMATCH", "Renewal grant context is invalid.");
    }
  }
  if (
    !Number.isSafeInteger(context.expectedPreviousGrantSequence) ||
    context.expectedPreviousGrantSequence < 1 ||
    grant.previousGrantSequence !== context.expectedPreviousGrantSequence ||
    grant.grantSequence !== context.expectedGrantSequence ||
    grant.grantSequence !== context.expectedPreviousGrantSequence + 1
  ) {
    throw capabilityError("RENEWAL_SEQUENCE_INVALID", "Renewal grant sequence is invalid.");
  }
  if (!secureHexEqual(grant.previousGrantSha256, context.expectedPreviousGrantSha256)) {
    throw capabilityError("CAPABILITY_CONTEXT_MISMATCH", "Renewal grant chain digest is invalid.");
  }
  if (!secureHexEqual(grant.initialCapabilitySha256, digestExecutionCapability(capability))) {
    throw capabilityError(
      "CAPABILITY_CONTEXT_MISMATCH",
      "Renewal grant does not bind the initial capability.",
    );
  }
  return grant;
}

export function deriveCapabilityPublicKey(privateKey: KeyObject): KeyObject {
  assertP256PrivateKey(privateKey);
  return createPublicKey(privateKey);
}

export function deriveCapabilityKeyId(key: KeyObject): string {
  const publicKey = key.type === "private" ? deriveCapabilityPublicKey(key) : key;
  assertP256PublicKey(publicKey);
  const spki = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(spki).digest("hex");
}

export function createExecutionCapabilitySigningBytes(capability: unknown): Buffer {
  return createLocalAuthoritySigningBytes(
    "ExecutionCapabilityV1",
    validateExecutionCapability(capability),
  );
}

export function createRenewalGrantSigningBytes(grant: unknown): Buffer {
  return createLocalAuthoritySigningBytes("RenewalGrantV1", validateRenewalGrant(grant));
}

// Native CNG adapters sign this 32-byte digest directly with ECDSA P-256. They must not request
// CNG to hash this digest again. Node's sign helper instead hashes the corresponding signing bytes.
export function createExecutionCapabilitySigningDigest(capability: unknown): Buffer {
  return createLocalAuthoritySigningDigest(
    "ExecutionCapabilityV1",
    validateExecutionCapability(capability),
  );
}

export function createRenewalGrantSigningDigest(grant: unknown): Buffer {
  return createLocalAuthoritySigningDigest("RenewalGrantV1", validateRenewalGrant(grant));
}

export function createLocalAuthoritySigningBytes(
  type: LocalAuthoritySigningDomain,
  value: unknown,
): Buffer {
  const domain = Buffer.from(
    `AgenticReview.LocalAuthority/${type}/ECDSA-P256-SHA256/P1363/1`,
    "ascii",
  );
  const payload = Buffer.from(serializeCanonicalJson(value), "utf8");
  const lengths = Buffer.allocUnsafe(8);
  lengths.writeUInt32BE(domain.byteLength, 0);
  lengths.writeUInt32BE(payload.byteLength, 4);
  return Buffer.concat([lengths, domain, payload]);
}

export function createLocalAuthoritySigningDigest(
  type: LocalAuthoritySigningDomain,
  value: unknown,
): Buffer {
  return createHash("sha256").update(createLocalAuthoritySigningBytes(type, value)).digest();
}

/** Encodes a ServiceHost signature only when it is already canonical 64-byte P1363 low-S. */
export function encodeLocalAuthoritySignature(signature: Uint8Array): string {
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
    throw capabilityError(
      "CAPABILITY_SIGNATURE_INVALID",
      "Local authority signature must be exactly 64 bytes.",
    );
  }
  const encoded = Buffer.from(signature).toString("base64url");
  decodeCanonicalSignature(encoded);
  return encoded;
}

export function verifyLocalAuthoritySignature(
  type: LocalAuthoritySigningDomain,
  value: unknown,
  signature: string,
  publicKey: KeyObject,
): void {
  assertP256PublicKey(publicKey);
  verifyLowS(createLocalAuthoritySigningBytes(type, value), signature, publicKey);
}

function normalizeSchemaValue<T>(
  value: unknown,
  schema: TSchema,
  code: LocalCapabilityError["code"],
): T {
  let canonical: string;
  try {
    canonical = serializeCanonicalJson(value);
  } catch {
    throw capabilityError(code, "Signed local authority has an invalid canonical value.");
  }
  const normalized = JSON.parse(canonical) as unknown;
  if (!Value.Check(schema, normalized)) {
    throw capabilityError(code, "Signed local authority does not match its strict schema.");
  }
  return normalized as T;
}

function validateRepository(fullName: string): void {
  const [owner, name] = fullName.split("/");
  if (owner === "." || owner === ".." || name === "." || name === "..") {
    throw capabilityError("CAPABILITY_SCHEMA_INVALID", "Repository identity is invalid.");
  }
}

function validateResourceLimits(resources: LocalCapabilityResourceLimits): void {
  const memoryBytes = parseBoundedDecimal(
    resources.memoryBytes,
    localCapabilityResourceBounds.memoryBytes,
  );
  const artifactBytes = parseBoundedDecimal(
    resources.artifactBytes,
    localCapabilityResourceBounds.artifactBytes,
  );
  const diskBytes = parseBoundedDecimal(
    resources.diskBytes,
    localCapabilityResourceBounds.diskBytes,
  );
  if (artifactBytes > diskBytes || memoryBytes <= 0n) {
    throw capabilityError("CAPABILITY_LIMIT_INVALID", "Capability resource limits are invalid.");
  }
}

function parseBoundedDecimal(
  value: string,
  bounds: { readonly minimum: bigint; readonly maximum: bigint },
): bigint {
  const parsed = BigInt(value);
  if (parsed < bounds.minimum || parsed > bounds.maximum) {
    throw capabilityError("CAPABILITY_LIMIT_INVALID", "Capability resource limit is out of range.");
  }
  return parsed;
}

function validateGrantTimes(value: {
  readonly issuedAtUnixMs: number;
  readonly serverLeaseExpiresAtUnixMs: number;
  readonly grantExpiresAtUnixMs: number;
  readonly hardDeadlineUnixMs: number;
}): void {
  if (
    value.issuedAtUnixMs >= value.grantExpiresAtUnixMs ||
    value.grantExpiresAtUnixMs - value.issuedAtUnixMs > LOCAL_GRANT_MAXIMUM_DURATION_MS ||
    value.grantExpiresAtUnixMs > value.serverLeaseExpiresAtUnixMs ||
    value.grantExpiresAtUnixMs > value.hardDeadlineUnixMs
  ) {
    throw capabilityError("CAPABILITY_TIME_INVALID", "Local grant deadlines are invalid.");
  }
}

function validateContext(
  value: {
    readonly keyId: string;
    readonly workerNodeId: string;
    readonly workerInstanceId: string;
    readonly executorBootId: string;
    readonly sessionId: string;
    readonly issuedAtUnixMs: number;
    readonly grantExpiresAtUnixMs: number;
  },
  context: CapabilityVerificationContext,
): void {
  const maximumClockSkewMs = context.maximumClockSkewMs ?? 5_000;
  if (
    !Number.isSafeInteger(context.nowUnixMs) ||
    !Number.isSafeInteger(maximumClockSkewMs) ||
    maximumClockSkewMs < 0 ||
    maximumClockSkewMs > LOCAL_GRANT_MAXIMUM_DURATION_MS
  ) {
    throw new TypeError("Capability verification time context is invalid");
  }
  if (
    value.keyId !== context.expectedKeyId ||
    value.workerNodeId !== context.expectedWorkerNodeId ||
    value.workerInstanceId !== context.expectedWorkerInstanceId ||
    value.executorBootId !== context.expectedExecutorBootId ||
    value.sessionId !== context.expectedSessionId
  ) {
    throw capabilityError(
      "CAPABILITY_CONTEXT_MISMATCH",
      "Signed local authority context is invalid.",
    );
  }
  if (value.issuedAtUnixMs > context.nowUnixMs + maximumClockSkewMs) {
    throw capabilityError(
      "CAPABILITY_TIME_INVALID",
      "Signed local authority was issued in the future.",
    );
  }
  if (value.grantExpiresAtUnixMs <= context.nowUnixMs) {
    throw capabilityError("CAPABILITY_EXPIRED", "Signed local authority has expired.");
  }
}

function signLowS(bytes: Uint8Array, privateKey: KeyObject): string {
  const raw = nodeSign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" });
  if (raw.byteLength !== 64) {
    throw capabilityError("CAPABILITY_SIGNATURE_INVALID", "Signer returned an invalid signature.");
  }
  const canonical = canonicalizeLowS(raw);
  return canonical.toString("base64url");
}

function verifyLowS(bytes: Uint8Array, encoded: string, publicKey: KeyObject): void {
  const signature = decodeCanonicalSignature(encoded);
  if (!nodeVerify("sha256", bytes, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)) {
    throw capabilityError("CAPABILITY_SIGNATURE_INVALID", "Local authority signature is invalid.");
  }
}

function canonicalizeLowS(signature: Uint8Array): Buffer {
  const result = Buffer.from(signature);
  const r = readUnsignedBigEndian(result.subarray(0, 32));
  let s = readUnsignedBigEndian(result.subarray(32));
  if (r <= 0n || r >= p256Order || s <= 0n || s >= p256Order) {
    throw capabilityError("CAPABILITY_SIGNATURE_INVALID", "ECDSA signature scalars are invalid.");
  }
  if (s > p256HalfOrder) {
    s = p256Order - s;
    writeUnsignedBigEndian(s, result, 32, 32);
  }
  return result;
}

function decodeCanonicalSignature(encoded: string): Buffer {
  if (!new RegExp(p1363SignaturePattern, "u").test(encoded)) {
    throw capabilityError("CAPABILITY_SIGNATURE_INVALID", "Signature encoding is invalid.");
  }
  const signature = Buffer.from(encoded, "base64url");
  if (signature.byteLength !== 64 || signature.toString("base64url") !== encoded) {
    throw capabilityError("CAPABILITY_SIGNATURE_INVALID", "Signature encoding is not canonical.");
  }
  const r = readUnsignedBigEndian(signature.subarray(0, 32));
  const s = readUnsignedBigEndian(signature.subarray(32));
  if (r <= 0n || r >= p256Order || s <= 0n || s > p256HalfOrder) {
    throw capabilityError(
      "CAPABILITY_SIGNATURE_INVALID",
      "Signature is not canonical low-S ECDSA.",
    );
  }
  return signature;
}

function readUnsignedBigEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function writeUnsignedBigEndian(
  value: bigint,
  target: Uint8Array,
  offset: number,
  length: number,
): void {
  let remaining = value;
  for (let index = offset + length - 1; index >= offset; index -= 1) {
    target[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) {
    throw capabilityError("CAPABILITY_SIGNATURE_INVALID", "ECDSA scalar does not fit.");
  }
}

function assertP256PrivateKey(key: KeyObject): void {
  if (key.type !== "private" || !isP256EcKey(key)) {
    throw capabilityError("CAPABILITY_KEY_INVALID", "A P-256 private key is required.");
  }
}

function assertP256PublicKey(key: KeyObject): void {
  if (key.type !== "public" || !isP256EcKey(key)) {
    throw capabilityError("CAPABILITY_KEY_INVALID", "A P-256 public key is required.");
  }
}

function isP256EcKey(key: KeyObject): boolean {
  return (
    key.asymmetricKeyType === "ec" &&
    (key.asymmetricKeyDetails?.namedCurve === "prime256v1" ||
      key.asymmetricKeyDetails?.namedCurve === "P-256")
  );
}

export function assertLocalAuthorityKeyIdMatches(keyId: string, key: KeyObject): void {
  const derived = deriveCapabilityKeyId(key);
  if (!secureHexEqual(keyId, derived)) {
    throw capabilityError(
      "CAPABILITY_KEY_INVALID",
      "Signed authority keyId does not match the P-256 SubjectPublicKeyInfo digest.",
    );
  }
}

function secureHexEqual(left: string, right: string): boolean {
  if (!new RegExp(sha256Pattern, "u").test(left) || !new RegExp(sha256Pattern, "u").test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isZeroDigest(value: string): boolean {
  return value === "0".repeat(64);
}

function capabilityError(
  code: LocalCapabilityError["code"],
  message: string,
): LocalCapabilityError {
  return new LocalCapabilityError(code, message);
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
