import { createHash } from "node:crypto";
import {
  type DeepReadonly,
  deepFreezeJson,
  parseCanonicalJson,
  serializeCanonicalJson,
} from "@agentic-review/local-protocol";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "./typebox-value-check.js";

export const ROLE_CONFIG_V3_LAB_MAXIMUM_BYTES = 16 * 1_024;
export const ROLE_CONFIG_V3_LAB_PROFILE = "disabled-execution-lab-v1" as const;
export const ROLE_CONFIG_V3_LAB_DISABLED_REASON_CODE = "EXECUTION_DISABLED" as const;
export const ROLE_CONFIG_V3_LAB_FOUNDATION_VERSION = 3 as const;
export const ROLE_CONFIG_V3_LAB_HOST_CONTROL_PROTOCOL_VERSION = "2.0" as const;
export const ROLE_CONFIG_V3_LAB_ARWX_PROTOCOL_MAJOR = 1 as const;
export const ROLE_CONFIG_V3_LAB_ARWX_PROTOCOL_MINOR = 1 as const;
export const ROLE_CONFIG_V3_LAB_JOB_ENVELOPE_VERSION = 2 as const;
export const ROLE_CONFIG_V3_LAB_COMPLETION_MODE = "result_artifact_v1" as const;
export const ROLE_CONFIG_V3_LAB_REQUIRED_RUNTIME_BOOTSTRAP_VERSION = 2 as const;
export const ROLE_CONFIG_V3_LAB_REQUIRED_WORKER_API_VERSION = "1.1" as const;

export const ROLE_CONFIG_V3_LAB_HOST_CONTROL_OPERATIONS = Object.freeze([
  "CreateArtifactUpload",
  "PutArtifactChunk",
  "FinalizeArtifactUpload",
  "TerminateArtifactUpload",
  "CompleteArtifactRun",
] as const);

export const ROLE_CONFIG_V3_LAB_MISSING_PREREQUISITES = Object.freeze([
  "artifact_readiness_attestation",
  "arwx_1_1_semantic_verifiers",
  "enrollment_live_evidence",
  "hostcontrol_v2_production_composition",
  "job_execution_envelope_v2_claim_selection",
  "migration_inventory_gate_off_rollback_binary",
  "persistent_exact_node_allowlist",
  "release_compatibility_profile_v2",
  "role_config_v3_production_authority",
  "runtime_bootstrap_v2_production_exchange",
  "server_global_rollout_gate_default_off",
  "server_binding_receipt",
  "signed_matching_packages",
  "signed_node_attestation",
  "windows_arm64_signed_install_attack_rollback_evidence",
  "windows_x64_signed_install_attack_rollback_evidence",
  "worker_api_1_1",
  "worker_claim_envelope_v2_consumer",
] as const);

const absoluteEndPattern = "(?![\\s\\S])";
const sha256Pattern = `^[a-f0-9]{64}${absoluteEndPattern}`;

const sha256Schema = () => Type.String({ minLength: 64, maxLength: 64, pattern: sha256Pattern });

const arwxSelectionSchema = () =>
  Type.Object(
    {
      maximumMinor: Type.Literal(ROLE_CONFIG_V3_LAB_ARWX_PROTOCOL_MINOR),
      minimumMinor: Type.Literal(ROLE_CONFIG_V3_LAB_ARWX_PROTOCOL_MINOR),
      protocolMajor: Type.Literal(ROLE_CONFIG_V3_LAB_ARWX_PROTOCOL_MAJOR),
    },
    { additionalProperties: false },
  );

const hostControlOperationsSchema = () =>
  Type.Tuple([
    Type.Literal("CreateArtifactUpload"),
    Type.Literal("PutArtifactChunk"),
    Type.Literal("FinalizeArtifactUpload"),
    Type.Literal("TerminateArtifactUpload"),
    Type.Literal("CompleteArtifactRun"),
  ]);

const hostControlSelectionSchema = () =>
  Type.Object(
    {
      operations: hostControlOperationsSchema(),
      protocolVersion: Type.Literal(ROLE_CONFIG_V3_LAB_HOST_CONTROL_PROTOCOL_VERSION),
    },
    { additionalProperties: false },
  );

const missingPrerequisitesSchema = () =>
  Type.Tuple([
    Type.Literal("artifact_readiness_attestation"),
    Type.Literal("arwx_1_1_semantic_verifiers"),
    Type.Literal("enrollment_live_evidence"),
    Type.Literal("hostcontrol_v2_production_composition"),
    Type.Literal("job_execution_envelope_v2_claim_selection"),
    Type.Literal("migration_inventory_gate_off_rollback_binary"),
    Type.Literal("persistent_exact_node_allowlist"),
    Type.Literal("release_compatibility_profile_v2"),
    Type.Literal("role_config_v3_production_authority"),
    Type.Literal("runtime_bootstrap_v2_production_exchange"),
    Type.Literal("server_global_rollout_gate_default_off"),
    Type.Literal("server_binding_receipt"),
    Type.Literal("signed_matching_packages"),
    Type.Literal("signed_node_attestation"),
    Type.Literal("windows_arm64_signed_install_attack_rollback_evidence"),
    Type.Literal("windows_x64_signed_install_attack_rollback_evidence"),
    Type.Literal("worker_api_1_1"),
    Type.Literal("worker_claim_envelope_v2_consumer"),
  ]);

const commonRoleConfigProperties = () => ({
  activationState: Type.Literal("blocked"),
  arwx: arwxSelectionSchema(),
  availableSlots: Type.Literal(0),
  completionMode: Type.Literal(ROLE_CONFIG_V3_LAB_COMPLETION_MODE),
  disabledReasonCode: Type.Literal(ROLE_CONFIG_V3_LAB_DISABLED_REASON_CODE),
  executionAuthority: Type.Literal(false),
  executionEnabled: Type.Literal(false),
  executorPolicySha256: sha256Schema(),
  foundationVersion: Type.Literal(ROLE_CONFIG_V3_LAB_FOUNDATION_VERSION),
  globalRolloutDefault: Type.Literal("off"),
  hostControl: hostControlSelectionSchema(),
  jobExecutionEnvelopeVersion: Type.Literal(ROLE_CONFIG_V3_LAB_JOB_ENVELOPE_VERSION),
  maximumSlots: Type.Literal(1),
  missingPrerequisites: missingPrerequisitesSchema(),
  profile: Type.Literal(ROLE_CONFIG_V3_LAB_PROFILE),
  requiredRuntimeBootstrapVersion: Type.Literal(
    ROLE_CONFIG_V3_LAB_REQUIRED_RUNTIME_BOOTSTRAP_VERSION,
  ),
  requiredWorkerApiVersion: Type.Literal(ROLE_CONFIG_V3_LAB_REQUIRED_WORKER_API_VERSION),
});

export const RoleConfigV3LabArwxSelectionSchema = freezeSchema(arwxSelectionSchema());
export const RoleConfigV3LabHostControlSelectionSchema = freezeSchema(hostControlSelectionSchema());

export const ControlRoleConfigV3LabSchema = freezeSchema(
  Type.Object(
    {
      ...commonRoleConfigProperties(),
      role: Type.Literal("control"),
    },
    { additionalProperties: false },
  ),
);

export const ExecutorRoleConfigV3LabSchema = freezeSchema(
  Type.Object(
    {
      ...commonRoleConfigProperties(),
      role: Type.Literal("executor"),
    },
    { additionalProperties: false },
  ),
);

export type ControlRoleConfigV3Lab = Static<typeof ControlRoleConfigV3LabSchema>;
export type ExecutorRoleConfigV3Lab = Static<typeof ExecutorRoleConfigV3LabSchema>;
export type RoleConfigV3Lab = ControlRoleConfigV3Lab | ExecutorRoleConfigV3Lab;
export type RoleConfigV3LabRole = RoleConfigV3Lab["role"];

export interface ParsedRoleConfigV3Lab {
  readonly config: DeepReadonly<RoleConfigV3Lab>;
  readonly canonicalSha256: string;
  readonly executionAuthority: false;
}

export class RoleConfigV3LabError extends Error {
  public constructor(
    public readonly code: "INVALID_DOCUMENT" | "ROLE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "RoleConfigV3LabError";
    Object.freeze(this);
  }
}

const parsedRoleConfigs = new WeakSet<object>();

/** Creates one canonical disabled Control role configuration. */
export function createControlRoleConfigV3Lab(executorPolicySha256: string): Buffer {
  assertSha256(executorPolicySha256, "executorPolicySha256");
  return encodeRoleConfig(fixedRoleConfig("control", executorPolicySha256), "control");
}

/** Creates one canonical disabled Executor role configuration. */
export function createExecutorRoleConfigV3Lab(executorPolicySha256: string): Buffer {
  assertSha256(executorPolicySha256, "executorPolicySha256");
  return encodeRoleConfig(fixedRoleConfig("executor", executorPolicySha256), "executor");
}

/** Parses one exact canonical v3 lab document and preserves its permanently disabled authority. */
export function parseRoleConfigV3Lab(
  document: Uint8Array,
  expectedRole: RoleConfigV3LabRole,
): Readonly<ParsedRoleConfigV3Lab> {
  assertRole(expectedRole);
  if (
    !(document instanceof Uint8Array) ||
    document.byteLength === 0 ||
    document.byteLength > ROLE_CONFIG_V3_LAB_MAXIMUM_BYTES
  ) {
    throw roleConfigError("INVALID_DOCUMENT", "RoleConfig v3 lab document is outside its limit.");
  }
  const snapshot = Buffer.from(document);
  let candidate: unknown;
  try {
    candidate = parseCanonicalJson(snapshot, ROLE_CONFIG_V3_LAB_MAXIMUM_BYTES);
  } catch {
    throw roleConfigError("INVALID_DOCUMENT", "RoleConfig v3 lab document is not canonical JSON.");
  }
  if (
    isRecord(candidate) &&
    (candidate.role === "control" || candidate.role === "executor") &&
    candidate.role !== expectedRole
  ) {
    if (isExactRoleConfigForRole(candidate, candidate.role)) {
      throw roleConfigError("ROLE_MISMATCH", "RoleConfig v3 lab role does not match the payload.");
    }
    throw roleConfigError("INVALID_DOCUMENT", "RoleConfig v3 lab opposite role is malformed.");
  }
  const schema =
    expectedRole === "control" ? ControlRoleConfigV3LabSchema : ExecutorRoleConfigV3LabSchema;
  if (!Value.Check(schema, candidate)) {
    throw roleConfigError("INVALID_DOCUMENT", "RoleConfig v3 lab document has an invalid shape.");
  }
  const config = candidate as RoleConfigV3Lab;

  const parsed = Object.freeze({
    config: deepFreezeJson(config),
    canonicalSha256: createHash("sha256").update(snapshot).digest("hex"),
    executionAuthority: false,
  }) satisfies Readonly<ParsedRoleConfigV3Lab>;
  parsedRoleConfigs.add(parsed);
  return parsed;
}

export function isParsedRoleConfigV3Lab(value: unknown): value is Readonly<ParsedRoleConfigV3Lab> {
  return typeof value === "object" && value !== null && parsedRoleConfigs.has(value);
}

function fixedRoleConfig(role: "control", executorPolicySha256: string): ControlRoleConfigV3Lab;
function fixedRoleConfig(role: "executor", executorPolicySha256: string): ExecutorRoleConfigV3Lab;
function fixedRoleConfig(
  role: RoleConfigV3LabRole,
  executorPolicySha256: string,
): Omit<ControlRoleConfigV3Lab, "role"> & { readonly role: RoleConfigV3LabRole } {
  return {
    activationState: "blocked",
    arwx: {
      maximumMinor: ROLE_CONFIG_V3_LAB_ARWX_PROTOCOL_MINOR,
      minimumMinor: ROLE_CONFIG_V3_LAB_ARWX_PROTOCOL_MINOR,
      protocolMajor: ROLE_CONFIG_V3_LAB_ARWX_PROTOCOL_MAJOR,
    },
    availableSlots: 0,
    completionMode: ROLE_CONFIG_V3_LAB_COMPLETION_MODE,
    disabledReasonCode: ROLE_CONFIG_V3_LAB_DISABLED_REASON_CODE,
    executionAuthority: false,
    executionEnabled: false,
    executorPolicySha256,
    foundationVersion: ROLE_CONFIG_V3_LAB_FOUNDATION_VERSION,
    globalRolloutDefault: "off",
    hostControl: {
      operations: [...ROLE_CONFIG_V3_LAB_HOST_CONTROL_OPERATIONS],
      protocolVersion: ROLE_CONFIG_V3_LAB_HOST_CONTROL_PROTOCOL_VERSION,
    },
    jobExecutionEnvelopeVersion: ROLE_CONFIG_V3_LAB_JOB_ENVELOPE_VERSION,
    maximumSlots: 1,
    missingPrerequisites: [...ROLE_CONFIG_V3_LAB_MISSING_PREREQUISITES],
    profile: ROLE_CONFIG_V3_LAB_PROFILE,
    requiredRuntimeBootstrapVersion: ROLE_CONFIG_V3_LAB_REQUIRED_RUNTIME_BOOTSTRAP_VERSION,
    requiredWorkerApiVersion: ROLE_CONFIG_V3_LAB_REQUIRED_WORKER_API_VERSION,
    role,
  };
}

function encodeRoleConfig(value: RoleConfigV3Lab, role: RoleConfigV3LabRole): Buffer {
  const document = Buffer.from(serializeCanonicalJson(value), "utf8");
  parseRoleConfigV3Lab(document, role);
  return document;
}

function isExactRoleConfigForRole(value: unknown, role: RoleConfigV3LabRole): boolean {
  const schema = role === "control" ? ControlRoleConfigV3LabSchema : ExecutorRoleConfigV3LabSchema;
  return Value.Check(schema, value);
}

function assertRole(value: RoleConfigV3LabRole): void {
  if (value !== "control" && value !== "executor") {
    throw new TypeError("RoleConfig v3 lab role must be control or executor.");
  }
}

function assertSha256(value: string, name: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${name} must be one lowercase SHA-256 digest.`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roleConfigError(
  code: RoleConfigV3LabError["code"],
  message: string,
): RoleConfigV3LabError {
  return new RoleConfigV3LabError(code, message);
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
