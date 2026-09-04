import { createHash } from "node:crypto";
import {
  type DeepReadonly,
  deepFreezeJson,
  parseCanonicalJson,
  serializeCanonicalJson,
} from "@agentic-review/local-protocol";
import { CloneType, type Static, type TSchema, Type } from "@sinclair/typebox";
import {
  type ParsedRoleConfigV3Lab,
  parseRoleConfigV3Lab,
  ROLE_CONFIG_V3_LAB_COMPLETION_MODE,
  ROLE_CONFIG_V3_LAB_HOST_CONTROL_PROTOCOL_VERSION,
  ROLE_CONFIG_V3_LAB_JOB_ENVELOPE_VERSION,
  ROLE_CONFIG_V3_LAB_MAXIMUM_BYTES,
  RoleConfigV3LabHostControlSelectionSchema,
  type RoleConfigV3LabRole,
} from "./role-config-v3-lab.js";
import { RuntimeBootstrapV1Schema } from "./runtime-bootstrap.js";
import { Value } from "./typebox-value-check.js";

export const RUNTIME_BOOTSTRAP_V2_LAB_VERSION = 2 as const;
export const RUNTIME_BOOTSTRAP_V2_LAB_HOST_CONTROL_RPC_PROTOCOL_VERSION = "2.0" as const;
export const RUNTIME_BOOTSTRAP_V2_LAB_MAXIMUM_BYTES = 64 * 1_024;
export const RUNTIME_BOOTSTRAP_V2_LAB_ARWX_PROTOCOL_MAJOR = 1 as const;
export const RUNTIME_BOOTSTRAP_V2_LAB_ARWX_PROTOCOL_MINOR = 1 as const;
export const RUNTIME_BOOTSTRAP_V2_LAB_ARWX_MAXIMUM_FRAME_BYTES = 1_048_576 as const;
export const RUNTIME_BOOTSTRAP_V2_LAB_ARWX_MINIMUM_QUEUED_BYTES =
  RUNTIME_BOOTSTRAP_V2_LAB_ARWX_MAXIMUM_FRAME_BYTES;
export const RUNTIME_BOOTSTRAP_V2_LAB_ARWX_MAXIMUM_QUEUED_BYTES = 64 * 1_024 * 1_024;

const absoluteEndPattern = "(?![\\s\\S])";
const sha256Pattern = `^[a-f0-9]{64}${absoluteEndPattern}`;
const base64UrlPattern = `^[A-Za-z0-9_-]+${absoluteEndPattern}`;

const RoleConfigDescriptorSchema = Type.Object(
  {
    base64Url: Type.String({
      minLength: 2,
      maxLength: Math.ceil((ROLE_CONFIG_V3_LAB_MAXIMUM_BYTES * 4) / 3),
      pattern: base64UrlPattern,
    }),
    byteLength: Type.Integer({ minimum: 1, maximum: ROLE_CONFIG_V3_LAB_MAXIMUM_BYTES }),
    sha256: Type.String({ minLength: 64, maxLength: 64, pattern: sha256Pattern }),
  },
  { additionalProperties: false },
);

export const RuntimeBootstrapV2LabSchema = freezeSchema(
  Type.Composite(
    [
      Type.Omit(CloneType(RuntimeBootstrapV1Schema), [
        "protocolVersion",
        "bootstrapVersion",
        "arwx",
        "roleConfig",
      ]),
      Type.Object(
        {
          protocolVersion: Type.Literal(RUNTIME_BOOTSTRAP_V2_LAB_HOST_CONTROL_RPC_PROTOCOL_VERSION),
          bootstrapVersion: Type.Literal(RUNTIME_BOOTSTRAP_V2_LAB_VERSION),
          executionAuthority: Type.Literal(false),
          arwx: Type.Object(
            {
              maximumFrameBytes: Type.Literal(RUNTIME_BOOTSTRAP_V2_LAB_ARWX_MAXIMUM_FRAME_BYTES),
              maximumMinor: Type.Literal(RUNTIME_BOOTSTRAP_V2_LAB_ARWX_PROTOCOL_MINOR),
              maximumQueuedBytesPerDirection: Type.Integer({
                minimum: RUNTIME_BOOTSTRAP_V2_LAB_ARWX_MINIMUM_QUEUED_BYTES,
                maximum: RUNTIME_BOOTSTRAP_V2_LAB_ARWX_MAXIMUM_QUEUED_BYTES,
              }),
              minimumMinor: Type.Literal(RUNTIME_BOOTSTRAP_V2_LAB_ARWX_PROTOCOL_MINOR),
              protocolMajor: Type.Literal(RUNTIME_BOOTSTRAP_V2_LAB_ARWX_PROTOCOL_MAJOR),
            },
            { additionalProperties: false },
          ),
          hostControl: CloneType(RoleConfigV3LabHostControlSelectionSchema),
          jobExecutionEnvelopeVersion: Type.Literal(ROLE_CONFIG_V3_LAB_JOB_ENVELOPE_VERSION),
          completionMode: Type.Literal(ROLE_CONFIG_V3_LAB_COMPLETION_MODE),
          roleConfig: RoleConfigDescriptorSchema,
        },
        { additionalProperties: false },
      ),
    ],
    { additionalProperties: false },
  ),
);

export const RuntimeBootstrapV2LabDisabledReadinessProjectionSchema = freezeSchema(
  Type.Object(
    {
      availableSlots: Type.Literal(0),
      executionAuthority: Type.Literal(false),
      ready: Type.Literal(false),
      reasonCode: Type.Literal("EXECUTION_DISABLED"),
    },
    { additionalProperties: false },
  ),
);

export type RuntimeBootstrapV2Lab = Static<typeof RuntimeBootstrapV2LabSchema>;
export type RuntimeBootstrapV2LabDisabledReadinessProjection = Static<
  typeof RuntimeBootstrapV2LabDisabledReadinessProjectionSchema
>;

export interface RuntimeBootstrapV2LabFacts {
  readonly bootstrapId: string;
  readonly forceTerminationReserveMs: number;
  readonly gracefulTimeoutMs: number;
  readonly maximumQueuedBytesPerDirection: number;
  readonly role: RoleConfigV3LabRole;
  readonly roleConfigDocument: Uint8Array;
  readonly workerNodeId: string;
}

export interface ParsedRuntimeBootstrapV2Lab {
  readonly bootstrap: DeepReadonly<RuntimeBootstrapV2Lab>;
  readonly bootstrapSha256: string;
  readonly executionAuthority: false;
  /** This is not an ARWX Ready wire message and grants no Ready authority. */
  readonly disabledReadiness: DeepReadonly<RuntimeBootstrapV2LabDisabledReadinessProjection>;
  readonly roleConfig: Readonly<ParsedRoleConfigV3Lab>;
}

export class RuntimeBootstrapV2LabError extends Error {
  public constructor(
    public readonly code: "INVALID_DOCUMENT" | "INVALID_ROLE_CONFIG" | "ROLE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeBootstrapV2LabError";
    Object.freeze(this);
  }
}

const parsedBootstraps = new WeakSet<object>();
const disabledReadiness = deepFreezeJson({
  availableSlots: 0,
  executionAuthority: false,
  ready: false,
  reasonCode: "EXECUTION_DISABLED",
} as const);

/** Creates a canonical lab document; protocolVersion selects local HostControl RPC 2.0 only. */
export function createRuntimeBootstrapV2Lab(input: RuntimeBootstrapV2LabFacts): Buffer {
  const facts = snapshotFacts(input);
  let roleConfig: Readonly<ParsedRoleConfigV3Lab>;
  try {
    roleConfig = parseRoleConfigV3Lab(facts.roleConfigDocument, facts.role);
  } catch {
    throw bootstrapError(
      "INVALID_ROLE_CONFIG",
      "RuntimeBootstrapV2 lab factory requires a matching RoleConfig v3 lab document.",
    );
  }
  const roleConfigDocument = Buffer.from(facts.roleConfigDocument);
  const roleConfigSha256 = createHash("sha256").update(roleConfigDocument).digest("hex");
  const candidate: RuntimeBootstrapV2Lab = {
    arwx: {
      maximumFrameBytes: RUNTIME_BOOTSTRAP_V2_LAB_ARWX_MAXIMUM_FRAME_BYTES,
      maximumMinor: RUNTIME_BOOTSTRAP_V2_LAB_ARWX_PROTOCOL_MINOR,
      maximumQueuedBytesPerDirection: facts.maximumQueuedBytesPerDirection,
      minimumMinor: RUNTIME_BOOTSTRAP_V2_LAB_ARWX_PROTOCOL_MINOR,
      protocolMajor: RUNTIME_BOOTSTRAP_V2_LAB_ARWX_PROTOCOL_MAJOR,
    },
    bootstrapId: facts.bootstrapId,
    bootstrapVersion: RUNTIME_BOOTSTRAP_V2_LAB_VERSION,
    completionMode: ROLE_CONFIG_V3_LAB_COMPLETION_MODE,
    executionAuthority: false,
    hostControl: {
      operations: [
        "CreateArtifactUpload",
        "PutArtifactChunk",
        "FinalizeArtifactUpload",
        "TerminateArtifactUpload",
        "CompleteArtifactRun",
      ],
      protocolVersion: ROLE_CONFIG_V3_LAB_HOST_CONTROL_PROTOCOL_VERSION,
    },
    jobExecutionEnvelopeVersion: ROLE_CONFIG_V3_LAB_JOB_ENVELOPE_VERSION,
    protocolVersion: RUNTIME_BOOTSTRAP_V2_LAB_HOST_CONTROL_RPC_PROTOCOL_VERSION,
    role: facts.role,
    roleConfig: {
      base64Url: roleConfigDocument.toString("base64url"),
      byteLength: roleConfigDocument.byteLength,
      sha256: roleConfigSha256,
    },
    shutdown: {
      forceTerminationReserveMs: facts.forceTerminationReserveMs,
      gracefulTimeoutMs: facts.gracefulTimeoutMs,
    },
    type: "runtimeBootstrap",
    workerNodeId: facts.workerNodeId,
  };
  if (!Value.Check(RuntimeBootstrapV2LabSchema, candidate) || !validShutdown(candidate)) {
    throw bootstrapError("INVALID_DOCUMENT", "RuntimeBootstrapV2 lab facts are invalid.");
  }
  if (!roleConfig.executionAuthority) {
    const document = Buffer.from(serializeCanonicalJson(candidate), "utf8");
    if (document.byteLength > RUNTIME_BOOTSTRAP_V2_LAB_MAXIMUM_BYTES) {
      throw bootstrapError("INVALID_DOCUMENT", "RuntimeBootstrapV2 lab exceeds its byte limit.");
    }
    parseRuntimeBootstrapV2Lab(document, facts.role);
    return document;
  }
  throw bootstrapError("INVALID_ROLE_CONFIG", "RoleConfig v3 lab unexpectedly has authority.");
}

/** Parses one canonical lab document without creating Ack, Commit, exchange, or Claim authority. */
export function parseRuntimeBootstrapV2Lab(
  document: Uint8Array,
  expectedRole: RoleConfigV3LabRole,
): Readonly<ParsedRuntimeBootstrapV2Lab> {
  assertRole(expectedRole);
  if (
    !(document instanceof Uint8Array) ||
    document.byteLength === 0 ||
    document.byteLength > RUNTIME_BOOTSTRAP_V2_LAB_MAXIMUM_BYTES
  ) {
    throw bootstrapError("INVALID_DOCUMENT", "RuntimeBootstrapV2 lab is outside its byte limit.");
  }
  const snapshot = Buffer.from(document);
  let candidate: unknown;
  try {
    candidate = parseCanonicalJson(snapshot, RUNTIME_BOOTSTRAP_V2_LAB_MAXIMUM_BYTES);
  } catch {
    throw bootstrapError("INVALID_DOCUMENT", "RuntimeBootstrapV2 lab is not canonical JSON.");
  }
  if (
    isRecord(candidate) &&
    (candidate.role === "control" || candidate.role === "executor") &&
    candidate.role !== expectedRole
  ) {
    if (isExactRuntimeBootstrapForRole(candidate, candidate.role)) {
      throw bootstrapError(
        "ROLE_MISMATCH",
        "RuntimeBootstrapV2 lab role does not match the payload.",
      );
    }
    throw bootstrapError("INVALID_DOCUMENT", "RuntimeBootstrapV2 lab opposite role is malformed.");
  }
  if (!Value.Check(RuntimeBootstrapV2LabSchema, candidate)) {
    throw bootstrapError("INVALID_DOCUMENT", "RuntimeBootstrapV2 lab has an invalid shape.");
  }
  const bootstrap = candidate as RuntimeBootstrapV2Lab;
  if (!validShutdown(bootstrap)) {
    throw bootstrapError("INVALID_DOCUMENT", "RuntimeBootstrapV2 lab shutdown limits are invalid.");
  }
  const roleConfigDocument = decodeRoleConfigDescriptor(bootstrap.roleConfig);
  let roleConfig: Readonly<ParsedRoleConfigV3Lab>;
  try {
    roleConfig = parseRoleConfigV3Lab(roleConfigDocument, expectedRole);
  } catch {
    throw bootstrapError("INVALID_ROLE_CONFIG", "RuntimeBootstrapV2 lab roleConfig is invalid.");
  }
  const parsed = Object.freeze({
    bootstrap: deepFreezeJson(bootstrap),
    bootstrapSha256: createHash("sha256").update(snapshot).digest("hex"),
    executionAuthority: false,
    disabledReadiness,
    roleConfig,
  }) satisfies Readonly<ParsedRuntimeBootstrapV2Lab>;
  parsedBootstraps.add(parsed);
  return parsed;
}

export function isParsedRuntimeBootstrapV2Lab(
  value: unknown,
): value is Readonly<ParsedRuntimeBootstrapV2Lab> {
  return typeof value === "object" && value !== null && parsedBootstraps.has(value);
}

function snapshotFacts(input: RuntimeBootstrapV2LabFacts): RuntimeBootstrapV2LabFacts {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("RuntimeBootstrapV2 lab facts must be one plain data object.");
  }
  const prototype = Object.getPrototypeOf(input) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("RuntimeBootstrapV2 lab facts must use a plain prototype.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const expectedKeys = [
    "bootstrapId",
    "forceTerminationReserveMs",
    "gracefulTimeoutMs",
    "maximumQueuedBytesPerDirection",
    "role",
    "roleConfigDocument",
    "workerNodeId",
  ];
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.some((key) => typeof key !== "string") ||
    actualKeys.map(String).sort().join("\u0000") !== expectedKeys.join("\u0000")
  ) {
    throw new TypeError("RuntimeBootstrapV2 lab facts have unexpected keys.");
  }
  const value = (key: (typeof expectedKeys)[number]): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)?.value;
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError("RuntimeBootstrapV2 lab facts must contain enumerable data fields.");
    }
    return descriptor.value;
  };
  const roleConfigDocument = value("roleConfigDocument");
  if (!(roleConfigDocument instanceof Uint8Array)) {
    throw new TypeError("RuntimeBootstrapV2 lab roleConfigDocument must be bytes.");
  }
  return Object.freeze({
    bootstrapId: value("bootstrapId"),
    forceTerminationReserveMs: value("forceTerminationReserveMs"),
    gracefulTimeoutMs: value("gracefulTimeoutMs"),
    maximumQueuedBytesPerDirection: value("maximumQueuedBytesPerDirection"),
    role: value("role"),
    roleConfigDocument: Buffer.from(roleConfigDocument),
    workerNodeId: value("workerNodeId"),
  } as RuntimeBootstrapV2LabFacts);
}

function decodeRoleConfigDescriptor(descriptor: RuntimeBootstrapV2Lab["roleConfig"]): Buffer {
  let document: Buffer;
  try {
    document = Buffer.from(descriptor.base64Url, "base64url");
  } catch {
    throw bootstrapError("INVALID_ROLE_CONFIG", "RoleConfig descriptor encoding is invalid.");
  }
  const digest = createHash("sha256").update(document).digest("hex");
  if (
    document.byteLength !== descriptor.byteLength ||
    document.byteLength === 0 ||
    document.byteLength > ROLE_CONFIG_V3_LAB_MAXIMUM_BYTES ||
    document.toString("base64url") !== descriptor.base64Url ||
    digest !== descriptor.sha256
  ) {
    throw bootstrapError("INVALID_ROLE_CONFIG", "RoleConfig descriptor is inconsistent.");
  }
  return document;
}

function validShutdown(bootstrap: RuntimeBootstrapV2Lab): boolean {
  return (
    bootstrap.shutdown.forceTerminationReserveMs < bootstrap.shutdown.gracefulTimeoutMs &&
    bootstrap.executionAuthority === false
  );
}

function isExactRuntimeBootstrapForRole(value: unknown, role: RoleConfigV3LabRole): boolean {
  if (!Value.Check(RuntimeBootstrapV2LabSchema, value)) return false;
  const bootstrap = value as RuntimeBootstrapV2Lab;
  if (!validShutdown(bootstrap)) return false;
  try {
    parseRoleConfigV3Lab(decodeRoleConfigDescriptor(bootstrap.roleConfig), role);
    return true;
  } catch {
    return false;
  }
}

function assertRole(value: RoleConfigV3LabRole): void {
  if (value !== "control" && value !== "executor") {
    throw new TypeError("RuntimeBootstrapV2 lab role must be control or executor.");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bootstrapError(
  code: RuntimeBootstrapV2LabError["code"],
  message: string,
): RuntimeBootstrapV2LabError {
  return new RuntimeBootstrapV2LabError(code, message);
}

function freezeSchema<TSchemaValue extends TSchema>(schema: TSchemaValue): TSchemaValue {
  const visited = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) {
        freeze(descriptor.value);
      }
    }
    Object.freeze(value);
  };
  freeze(schema);
  return schema;
}
