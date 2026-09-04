import { createHash, timingSafeEqual } from "node:crypto";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  createCanonicalJsonDocument,
  type DeepReadonly,
  deepFreezeJson,
  LOCAL_CANONICAL_JSON_VERSION,
  serializeCanonicalJson,
} from "./canonical.js";

export const EXECUTION_CAPABILITY_VERSION = 1 as const;
export const RENEWAL_GRANT_VERSION = 1 as const;
export const LOCAL_CAPABILITY_AUDIENCE = "agentic-review/windows-executor/v1" as const;
export const LOCAL_GRANT_MAXIMUM_DURATION_MS = 45_000;

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

const SafeNonNegativeIntegerSchema = Type.Integer({ minimum: 0, maximum: safeIntegerMaximum });
const SafePositiveIntegerSchema = Type.Integer({ minimum: 1, maximum: safeIntegerMaximum });
const UuidV4Schema = Type.String({ minLength: 36, maxLength: 36, pattern: uuidV4Pattern });
const Sha256Schema = Type.String({ minLength: 64, maxLength: 64, pattern: sha256Pattern });
const Random256BitSchema = Type.String({ minLength: 64, maxLength: 64, pattern: sha256Pattern });
const DecimalSchema = Type.String({ minLength: 1, maxLength: 21, pattern: decimalPattern });

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
    serverHeartbeatSequence: SafeNonNegativeIntegerSchema,
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

export class LocalCapabilityError extends Error {
  public constructor(
    public readonly code:
      | "CAPABILITY_SCHEMA_INVALID"
      | "CAPABILITY_LIMIT_INVALID"
      | "CAPABILITY_TIME_INVALID"
      | "CAPABILITY_CONTEXT_MISMATCH"
      | "CAPABILITY_EXPIRED"
      | "RENEWAL_SEQUENCE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "LocalCapabilityError";
  }
}

export interface CapabilityValidationContext {
  readonly expectedWorkerNodeId: string;
  readonly expectedWorkerInstanceId: string;
  readonly expectedExecutorBootId: string;
  readonly expectedSessionId: string;
  readonly nowUnixMs: number;
  readonly maximumClockSkewMs?: number;
}

export interface RenewalValidationContext extends CapabilityValidationContext {
  readonly capability: ValidatedExecutionCapability;
  readonly expectedPreviousGrantSha256: string;
  readonly expectedPreviousGrantSequence: number;
  readonly expectedGrantSequence: number;
  readonly expectedPreviousServerHeartbeatSequence: number;
}

declare const validatedExecutionCapabilityBrand: unique symbol;
declare const validatedRenewalGrantBrand: unique symbol;

export type ValidatedExecutionCapability = DeepReadonly<ExecutionCapabilityV1> & {
  readonly [validatedExecutionCapabilityBrand]: true;
};

export type ValidatedRenewalGrant = DeepReadonly<RenewalGrantV1> & {
  readonly [validatedRenewalGrantBrand]: true;
};

const validatedExecutionCapabilities = new WeakSet<object>();
const validatedRenewalGrants = new WeakSet<object>();

export function isValidatedExecutionCapability(
  value: unknown,
): value is ValidatedExecutionCapability {
  return typeof value === "object" && value !== null && validatedExecutionCapabilities.has(value);
}

export function isValidatedRenewalGrant(value: unknown): value is ValidatedRenewalGrant {
  return typeof value === "object" && value !== null && validatedRenewalGrants.has(value);
}

export function validateExecutionCapability(value: unknown): DeepReadonly<ExecutionCapabilityV1> {
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
      "Capability hard deadline exceeds its declared timeout ceiling.",
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
  return deepFreezeJson(capability);
}

export function validateRenewalGrant(value: unknown): DeepReadonly<RenewalGrantV1> {
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
  return deepFreezeJson(grant);
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

export function validateExecutionCapabilityForContext(
  value: unknown,
  context: CapabilityValidationContext,
): ValidatedExecutionCapability {
  const capability = validateExecutionCapability(value);
  validateContext(capability, context);
  validatedExecutionCapabilities.add(capability);
  return capability as ValidatedExecutionCapability;
}

export function validateRenewalGrantForContext(
  value: unknown,
  context: RenewalValidationContext,
): ValidatedRenewalGrant {
  const grant = validateRenewalGrant(value);
  validateContext(grant, context);
  const capability = context.capability;
  if (!isValidatedExecutionCapability(capability)) {
    throw capabilityError(
      "CAPABILITY_CONTEXT_MISMATCH",
      "Renewal validation requires a context-validated initial capability.",
    );
  }
  for (const key of [
    "capabilityId",
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
  if (
    !Number.isSafeInteger(context.expectedPreviousServerHeartbeatSequence) ||
    context.expectedPreviousServerHeartbeatSequence < -1 ||
    grant.serverHeartbeatSequence <= context.expectedPreviousServerHeartbeatSequence
  ) {
    throw capabilityError(
      "RENEWAL_SEQUENCE_INVALID",
      "Renewal grant does not follow a fresh successful Server heartbeat.",
    );
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
  validatedRenewalGrants.add(grant);
  return grant as ValidatedRenewalGrant;
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
    throw capabilityError(code, "Local authorization has an invalid canonical value.");
  }
  const normalized = JSON.parse(canonical) as unknown;
  if (!Value.Check(schema, normalized)) {
    throw capabilityError(code, "Local authorization does not match its strict schema.");
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
    readonly workerNodeId: string;
    readonly workerInstanceId: string;
    readonly executorBootId: string;
    readonly sessionId: string;
    readonly issuedAtUnixMs: number;
    readonly grantExpiresAtUnixMs: number;
  },
  context: CapabilityValidationContext,
): void {
  const maximumClockSkewMs = context.maximumClockSkewMs ?? 5_000;
  if (
    !Number.isSafeInteger(context.nowUnixMs) ||
    !Number.isSafeInteger(maximumClockSkewMs) ||
    maximumClockSkewMs < 0 ||
    maximumClockSkewMs > LOCAL_GRANT_MAXIMUM_DURATION_MS
  ) {
    throw new TypeError("Capability validation time context is invalid");
  }
  if (
    value.workerNodeId !== context.expectedWorkerNodeId ||
    value.workerInstanceId !== context.expectedWorkerInstanceId ||
    value.executorBootId !== context.expectedExecutorBootId ||
    value.sessionId !== context.expectedSessionId
  ) {
    throw capabilityError("CAPABILITY_CONTEXT_MISMATCH", "Local authorization context is invalid.");
  }
  if (value.issuedAtUnixMs > context.nowUnixMs + maximumClockSkewMs) {
    throw capabilityError(
      "CAPABILITY_TIME_INVALID",
      "Local authorization was issued in the future.",
    );
  }
  if (value.grantExpiresAtUnixMs <= context.nowUnixMs) {
    throw capabilityError("CAPABILITY_EXPIRED", "Local authorization has expired.");
  }
  if (value.grantExpiresAtUnixMs - context.nowUnixMs > LOCAL_GRANT_MAXIMUM_DURATION_MS) {
    throw capabilityError(
      "CAPABILITY_TIME_INVALID",
      "Local authorization exceeds the maximum receipt-to-expiry duration.",
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
