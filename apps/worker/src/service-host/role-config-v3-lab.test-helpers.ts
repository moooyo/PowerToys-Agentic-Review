import {
  createControlRoleConfigV3Lab,
  createExecutorRoleConfigV3Lab,
} from "./role-config-v3-lab.js";
import {
  createRuntimeBootstrapV2Lab,
  type RuntimeBootstrapV2LabFacts,
} from "./runtime-bootstrap-v2-lab.js";

export const testExecutorPolicySha256 = "6".repeat(64);

export function labFixtureLines(): readonly [Buffer, Buffer, Buffer, Buffer] {
  const control = createControlRoleConfigV3Lab(testExecutorPolicySha256);
  const executor = createExecutorRoleConfigV3Lab(testExecutorPolicySha256);
  return Object.freeze([
    control,
    executor,
    createRuntimeBootstrapV2Lab(bootstrapFacts("control", control)),
    createRuntimeBootstrapV2Lab(bootstrapFacts("executor", executor)),
  ]);
}

export function bootstrapFacts(
  role: "control" | "executor",
  roleConfigDocument: Uint8Array,
): RuntimeBootstrapV2LabFacts {
  return {
    bootstrapId:
      role === "control"
        ? "123e4567-e89b-42d3-a456-426614174000"
        : "123e4567-e89b-42d3-a456-426614174001",
    forceTerminationReserveMs: 15_000,
    gracefulTimeoutMs: 120_000,
    installationManifestSha256: "2".repeat(64),
    maximumQueuedBytesPerDirection: 4 * 1_024 * 1_024,
    nodeBundleSha256: "4".repeat(64),
    preflightSha256: "3".repeat(64),
    releaseId: "2026.09.03-lab+1",
    releaseTemplateSha256: "1".repeat(64),
    role,
    roleConfigDocument,
    workerNodeId: "powertoys-node:01",
  };
}
