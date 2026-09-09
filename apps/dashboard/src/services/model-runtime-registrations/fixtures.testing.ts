import { createHash } from "node:crypto";
import type * as C from "@agentic-review/contracts";

export const registryActor: C.OperatorPrincipal = {
  issuer: "https://identity.example.test",
  subject: "administrator",
};
const now = "2026-09-08T01:00:00.000Z";
export const registryId = "runtime-a";
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
export const identityDigest = (identity: C.ModelRuntimeIdentityV1) =>
  createHash("sha256").update(canonical(identity)).digest("hex");
export function registrationRequest(): C.ModelRuntimeRegisterRequest {
  return {
    changeId: "register-runtime-a",
    name: "Expected runtime",
    requestedModel: "configured-alias",
    enabled: true,
    identity: {
      schemaVersion: "ModelRuntimeIdentityV1",
      providerId: "synthetic-provider",
      modelId: "expected-model",
      endpointSha256: "a".repeat(64),
      client: {
        kind: "codex_cli",
        version: "1.0.0",
        executableSha256: "b".repeat(64),
        launchPolicySha256: "c".repeat(64),
      },
      relay: { implementationSha256: "d".repeat(64), policySha256: "e".repeat(64) },
    },
  };
}
export function controlRequest(): C.ModelRuntimeControlRequest {
  return {
    changeId: "disable-runtime-a",
    expectedVersion: 1,
    enabled: false,
    reason: "Pause new selections.",
  };
}
export function runtimeStatus(enabled = true, version = 1): C.ModelRuntimeStatusV1 {
  const request = registrationRequest();
  return {
    schemaVersion: "ModelRuntimeStatusV1",
    registration: {
      schemaVersion: "ModelRuntimeRegistrationV1",
      id: registryId,
      name: request.name,
      requestedModel: request.requestedModel,
      identity: request.identity,
      identitySha256: identityDigest(request.identity),
      createdAt: now,
      createdBy: { ...registryActor },
    },
    control: {
      schemaVersion: "ModelRuntimeControlV1",
      registrationId: registryId,
      version,
      enabled,
      updatedAt: version === 1 ? now : "2026-09-08T02:00:00.000Z",
      updatedBy: { ...registryActor },
    },
  };
}
export function runtimeList(enabled = true): C.ModelRuntimeListV1 {
  return {
    schemaVersion: "ModelRuntimeListV1",
    page: 1,
    pageSize: 20,
    total: 1,
    items: [runtimeStatus(enabled)],
  };
}
export function runtimeOptions(): C.ModelRuntimeOptionsV1 {
  return {
    schemaVersion: "ModelRuntimeOptionsV1",
    repositoryId: "repo-a",
    page: 1,
    pageSize: 20,
    total: 1,
    items: [runtimeStatus().registration],
  };
}
export function runtimeHistory(): C.ModelRuntimeHistoryV1 {
  return {
    schemaVersion: "ModelRuntimeHistoryV1",
    registrationId: registryId,
    page: 1,
    pageSize: 20,
    total: 2,
    items: [
      {
        schemaVersion: "ModelRuntimeAuditEventV1",
        id: "event-2",
        registrationId: registryId,
        changeId: "disable-runtime-a",
        operation: "control",
        previousVersion: 1,
        version: 2,
        enabled: false,
        reason: "Pause new selections.",
        createdAt: "2026-09-08T02:00:00.000Z",
        createdBy: { ...registryActor },
      },
      {
        schemaVersion: "ModelRuntimeAuditEventV1",
        id: "event-1",
        registrationId: registryId,
        changeId: "register-runtime-a",
        operation: "register",
        previousVersion: 0,
        version: 1,
        enabled: true,
        reason: null,
        createdAt: now,
        createdBy: { ...registryActor },
      },
    ],
  };
}
