import { createHash } from "node:crypto";
import {
  type DeepReadonly,
  deepFreezeJson,
  parseCanonicalJson,
} from "@agentic-review/local-protocol";
import { type Static, Type } from "@sinclair/typebox";
import type { ServiceHostPayloadRole } from "./launch-contract.js";
import { decodeHostControlOpaqueJson } from "./opaque-json.js";
import { Value } from "./typebox-value-check.js";

export const RUNTIME_BOOTSTRAP_VERSION = 1 as const;
export const RUNTIME_BOOTSTRAP_MAXIMUM_BYTES = 64 * 1_024;
export const RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES = 47 * 1_024;
export const RUNTIME_BOOTSTRAP_ARWX_PROTOCOL_MAJOR = 1 as const;
export const RUNTIME_BOOTSTRAP_ARWX_MINIMUM_MINOR = 0 as const;
export const RUNTIME_BOOTSTRAP_ARWX_MAXIMUM_MINOR = 0 as const;
export const RUNTIME_BOOTSTRAP_ARWX_MAXIMUM_FRAME_BYTES = 1_048_576 as const;
export const RUNTIME_BOOTSTRAP_ARWX_MINIMUM_QUEUED_BYTES =
  RUNTIME_BOOTSTRAP_ARWX_MAXIMUM_FRAME_BYTES;
export const RUNTIME_BOOTSTRAP_ARWX_MAXIMUM_QUEUED_BYTES = 64 * 1_024 * 1_024;
export const RUNTIME_BOOTSTRAP_MINIMUM_GRACEFUL_TIMEOUT_MS = 1_000;
export const RUNTIME_BOOTSTRAP_MAXIMUM_GRACEFUL_TIMEOUT_MS = 300_000;

const protocolVersion = "1.0" as const;
const absoluteEndPattern = "(?![\\s\\S])";
const uuidV4Pattern = `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}${absoluteEndPattern}`;
const entityIdPattern = `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}${absoluteEndPattern}`;
const sha256Pattern = `^[a-f0-9]{64}${absoluteEndPattern}`;
const base64UrlPattern = `^[A-Za-z0-9_-]+${absoluteEndPattern}`;

const Sha256Schema = Type.String({ minLength: 64, maxLength: 64, pattern: sha256Pattern });
const RoleConfigDescriptorSchema = Type.Object(
  {
    base64Url: Type.String({
      minLength: 2,
      maxLength: Math.ceil((RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES * 4) / 3),
      pattern: base64UrlPattern,
    }),
    byteLength: Type.Integer({
      minimum: 1,
      maximum: RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES,
    }),
    sha256: Sha256Schema,
  },
  { additionalProperties: false },
);

export const ControlFoundationRoleConfigV2Schema = Type.Object(
  {
    executionEnabled: Type.Literal(false),
    foundationVersion: Type.Literal(2),
    maximumSlots: Type.Literal(1),
    role: Type.Literal("control"),
  },
  { additionalProperties: false },
);

export const ExecutorFoundationRoleConfigV2Schema = Type.Object(
  {
    executionEnabled: Type.Literal(false),
    foundationVersion: Type.Literal(2),
    maximumSlots: Type.Literal(1),
    role: Type.Literal("executor"),
  },
  { additionalProperties: false },
);

export type ControlFoundationRoleConfigV2 = Static<typeof ControlFoundationRoleConfigV2Schema>;
export type ExecutorFoundationRoleConfigV2 = Static<typeof ExecutorFoundationRoleConfigV2Schema>;
export type FoundationRoleConfigV2 = ControlFoundationRoleConfigV2 | ExecutorFoundationRoleConfigV2;

export const RuntimeBootstrapV1Schema = Type.Object(
  {
    protocolVersion: Type.Literal(protocolVersion),
    type: Type.Literal("runtimeBootstrap"),
    bootstrapVersion: Type.Literal(RUNTIME_BOOTSTRAP_VERSION),
    bootstrapId: Type.String({ minLength: 36, maxLength: 36, pattern: uuidV4Pattern }),
    role: Type.Union([Type.Literal("control"), Type.Literal("executor")]),
    workerNodeId: Type.String({ minLength: 1, maxLength: 128, pattern: entityIdPattern }),
    arwx: Type.Object(
      {
        protocolMajor: Type.Literal(RUNTIME_BOOTSTRAP_ARWX_PROTOCOL_MAJOR),
        minimumMinor: Type.Literal(RUNTIME_BOOTSTRAP_ARWX_MINIMUM_MINOR),
        maximumMinor: Type.Literal(RUNTIME_BOOTSTRAP_ARWX_MAXIMUM_MINOR),
        maximumFrameBytes: Type.Literal(RUNTIME_BOOTSTRAP_ARWX_MAXIMUM_FRAME_BYTES),
        maximumQueuedBytesPerDirection: Type.Integer({
          minimum: RUNTIME_BOOTSTRAP_ARWX_MINIMUM_QUEUED_BYTES,
          maximum: RUNTIME_BOOTSTRAP_ARWX_MAXIMUM_QUEUED_BYTES,
        }),
      },
      { additionalProperties: false },
    ),
    shutdown: Type.Object(
      {
        gracefulTimeoutMs: Type.Integer({
          minimum: RUNTIME_BOOTSTRAP_MINIMUM_GRACEFUL_TIMEOUT_MS,
          maximum: RUNTIME_BOOTSTRAP_MAXIMUM_GRACEFUL_TIMEOUT_MS,
        }),
        forceTerminationReserveMs: Type.Integer({
          minimum: 1,
          maximum: RUNTIME_BOOTSTRAP_MAXIMUM_GRACEFUL_TIMEOUT_MS,
        }),
      },
      { additionalProperties: false },
    ),
    roleConfig: RoleConfigDescriptorSchema,
  },
  { additionalProperties: false },
);

export const RuntimeBootstrapAckV1Schema = Type.Object(
  {
    protocolVersion: Type.Literal(protocolVersion),
    type: Type.Literal("runtimeBootstrapAck"),
    bootstrapVersion: Type.Literal(RUNTIME_BOOTSTRAP_VERSION),
    bootstrapId: Type.String({ minLength: 36, maxLength: 36, pattern: uuidV4Pattern }),
    role: Type.Union([Type.Literal("control"), Type.Literal("executor")]),
    bootstrapSha256: Sha256Schema,
    accepted: Type.Literal(true),
    arwxReceiveLoopStarted: Type.Literal(true),
  },
  { additionalProperties: false },
);

export const RuntimeBootstrapCommitV1Schema = Type.Object(
  {
    protocolVersion: Type.Literal(protocolVersion),
    type: Type.Literal("runtimeBootstrapCommit"),
    bootstrapVersion: Type.Literal(RUNTIME_BOOTSTRAP_VERSION),
    bootstrapId: Type.String({ minLength: 36, maxLength: 36, pattern: uuidV4Pattern }),
    role: Type.Union([Type.Literal("control"), Type.Literal("executor")]),
    bootstrapSha256: Sha256Schema,
    committed: Type.Literal(true),
  },
  { additionalProperties: false },
);

export type RuntimeBootstrapV1 = Static<typeof RuntimeBootstrapV1Schema>;
export type RuntimeBootstrapAckV1 = Static<typeof RuntimeBootstrapAckV1Schema>;
export type RuntimeBootstrapCommitV1 = Static<typeof RuntimeBootstrapCommitV1Schema>;

export interface ParsedRuntimeBootstrapV1 {
  readonly bootstrap: DeepReadonly<RuntimeBootstrapV1>;
  readonly roleConfig: DeepReadonly<FoundationRoleConfigV2>;
  readonly bootstrapSha256: string;
}

export class RuntimeBootstrapError extends Error {
  public constructor(
    public readonly code:
      | "COMMIT_MISMATCH"
      | "INVALID_DOCUMENT"
      | "ROLE_MISMATCH"
      | "INVALID_ROLE_CONFIG",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeBootstrapError";
  }
}

const parsedBootstraps = new WeakSet<object>();

/** Parses one exact canonical bootstrap and binds it to the compiled payload role. */
export function parseRuntimeBootstrap(
  document: Uint8Array,
  expectedRole: ServiceHostPayloadRole,
): Readonly<ParsedRuntimeBootstrapV1> {
  assertRole(expectedRole);
  if (
    !(document instanceof Uint8Array) ||
    document.byteLength === 0 ||
    document.byteLength > RUNTIME_BOOTSTRAP_MAXIMUM_BYTES
  ) {
    throw bootstrapError("INVALID_DOCUMENT", "RuntimeBootstrapV1 is outside its byte limit.");
  }
  const snapshot = Buffer.from(document);
  let candidate: unknown;
  try {
    candidate = parseCanonicalJson(snapshot, RUNTIME_BOOTSTRAP_MAXIMUM_BYTES);
  } catch {
    throw bootstrapError("INVALID_DOCUMENT", "RuntimeBootstrapV1 is not bounded canonical JSON.");
  }
  if (!Value.Check(RuntimeBootstrapV1Schema, candidate)) {
    throw bootstrapError(
      "INVALID_DOCUMENT",
      "RuntimeBootstrapV1 does not match its strict schema.",
    );
  }
  const bootstrap = candidate as RuntimeBootstrapV1;
  if (bootstrap.role !== expectedRole) {
    throw bootstrapError("ROLE_MISMATCH", "RuntimeBootstrapV1 role does not match this payload.");
  }
  if (bootstrap.shutdown.forceTerminationReserveMs >= bootstrap.shutdown.gracefulTimeoutMs) {
    throw bootstrapError("INVALID_DOCUMENT", "RuntimeBootstrapV1 shutdown limits are invalid.");
  }

  let roleConfig: unknown;
  try {
    roleConfig = decodeHostControlOpaqueJson(
      bootstrap.roleConfig,
      RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES,
    );
  } catch {
    throw bootstrapError(
      "INVALID_ROLE_CONFIG",
      "RuntimeBootstrapV1 roleConfig is not a valid exact JSON descriptor.",
    );
  }
  const validatedRoleConfig = validateFoundationRoleConfig(roleConfig, expectedRole);
  const parsed = Object.freeze({
    bootstrap: deepFreezeJson(bootstrap),
    roleConfig: deepFreezeJson(validatedRoleConfig),
    bootstrapSha256: createHash("sha256").update(snapshot).digest("hex"),
  }) satisfies Readonly<ParsedRuntimeBootstrapV1>;
  parsedBootstraps.add(parsed);
  return parsed;
}

export function isParsedRuntimeBootstrapForRole(
  parsed: Readonly<ParsedRuntimeBootstrapV1>,
  role: ServiceHostPayloadRole,
): boolean {
  return (
    parsedBootstraps.has(parsed) &&
    parsed.bootstrap.role === role &&
    parsed.roleConfig.role === role
  );
}

/** Validates the post-activation commit against the parser-issued bootstrap identity. */
export function parseRuntimeBootstrapCommit(
  document: Uint8Array,
  parsed: Readonly<ParsedRuntimeBootstrapV1>,
): DeepReadonly<RuntimeBootstrapCommitV1> {
  if (!parsedBootstraps.has(parsed)) {
    throw new TypeError("Runtime bootstrap commit requires a parser-issued bootstrap.");
  }
  if (
    !(document instanceof Uint8Array) ||
    document.byteLength === 0 ||
    document.byteLength > RUNTIME_BOOTSTRAP_MAXIMUM_BYTES
  ) {
    throw bootstrapError("INVALID_DOCUMENT", "RuntimeBootstrapCommitV1 is outside its byte limit.");
  }
  let candidate: unknown;
  try {
    candidate = parseCanonicalJson(Buffer.from(document), RUNTIME_BOOTSTRAP_MAXIMUM_BYTES);
  } catch {
    throw bootstrapError(
      "INVALID_DOCUMENT",
      "RuntimeBootstrapCommitV1 is not bounded canonical JSON.",
    );
  }
  if (!Value.Check(RuntimeBootstrapCommitV1Schema, candidate)) {
    throw bootstrapError(
      "INVALID_DOCUMENT",
      "RuntimeBootstrapCommitV1 does not match its strict schema.",
    );
  }
  const commit = candidate as RuntimeBootstrapCommitV1;
  if (
    commit.bootstrapId !== parsed.bootstrap.bootstrapId ||
    commit.role !== parsed.bootstrap.role ||
    commit.bootstrapSha256 !== parsed.bootstrapSha256
  ) {
    throw bootstrapError(
      "COMMIT_MISMATCH",
      "RuntimeBootstrapCommitV1 does not bind the accepted bootstrap.",
    );
  }
  return deepFreezeJson(commit);
}

function assertRole(value: ServiceHostPayloadRole): void {
  if (value !== "control" && value !== "executor") {
    throw new TypeError("Expected runtime bootstrap role must be control or executor.");
  }
}

function validateFoundationRoleConfig(
  value: unknown,
  role: ServiceHostPayloadRole,
): DeepReadonly<FoundationRoleConfigV2> {
  const schema =
    role === "control" ? ControlFoundationRoleConfigV2Schema : ExecutorFoundationRoleConfigV2Schema;
  if (!Value.Check(schema, value)) {
    throw bootstrapError(
      "INVALID_ROLE_CONFIG",
      "RuntimeBootstrapV1 roleConfig does not match the strict foundation schema.",
    );
  }
  return deepFreezeJson(value as FoundationRoleConfigV2);
}

function bootstrapError(
  code: RuntimeBootstrapError["code"],
  message: string,
): RuntimeBootstrapError {
  return new RuntimeBootstrapError(code, message);
}
