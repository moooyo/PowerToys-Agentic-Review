import { createHash } from "node:crypto";
import type * as C from "@agentic-review/contracts";
import { runtimeStatus } from "../model-runtime-registrations/fixtures.testing";

export const evaluationModelInvocationTestScope = {
  repositoryId: "repository-a",
  evaluationId: "evaluation-a",
  cellId: "cell-a",
};
export type EvaluationModelInvocationFixtureState = "open" | "sealed" | "submitted";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

export const invocationFixtureDigest = (value: unknown): string =>
  createHash("sha256").update(canonical(value), "utf8").digest("hex");

export function evaluationInvocationRuntimeFixture(): C.ModelRuntimeRegistrationV1 {
  const registration = runtimeStatus().registration;
  registration.createdAt = "2026-09-08T00:00:00.000Z";
  return registration;
}

export function evaluationCellInvocationItemFixture(
  state: EvaluationModelInvocationFixtureState = "submitted",
  suffix = "one",
): C.EvaluationCellInvocationListV1["items"][number] {
  const registration = evaluationInvocationRuntimeFixture();
  const { schemaVersion: _schemaVersion, modelId: _modelId, ...runtime } = registration.identity;
  const scope: C.ModelInvocationScopeV1 = {
    schemaVersion: "ModelInvocationScopeV1",
    ...evaluationModelInvocationTestScope,
    runId: "run-a",
    requestId: "request-a",
    jobId: "job-a",
    attemptId: `attempt-${suffix}`,
    invocationId: `invocation-${suffix}`,
    authorizationId: "authorization-a",
    executionManifestSha256: "1".repeat(64),
    promptSha256: "2".repeat(64),
    outputSchemaSha256: "3".repeat(64),
    expectedModelIdentitySha256: registration.identitySha256,
    requestedModel: registration.requestedModel,
    workerNodeId: "worker-node-a",
    workerInstanceId: "worker-instance-a",
    leaseGeneration: 1,
  };
  const opening: C.ModelInvocationOpeningV1 = {
    schemaVersion: "ModelInvocationOpeningV1",
    scope,
    scopeSha256: invocationFixtureDigest(scope),
    runtime,
    openedAt: "2026-09-08T00:01:00.000Z",
  };
  const seal: C.ModelInvocationSealV1 = {
    schemaVersion: "ModelInvocationSealV1",
    invocationId: scope.invocationId,
    scopeSha256: opening.scopeSha256,
    receiptSetSha256: "4".repeat(64),
    closedAt: "2026-09-08T00:01:02.000Z",
    state: "closed",
    callCount: 1,
    lastReceiptSha256: "5".repeat(64),
    modelOutputSha256: "6".repeat(64),
    observedIdentitySha256: registration.identitySha256,
    processClosed: true,
    relayClosed: true,
    recordedAt: "2026-09-08T00:01:03.000Z",
  };
  return {
    opening,
    observedIdentity: state === "submitted" ? registration.identity : null,
    seal: state === "open" ? null : seal,
    submission:
      state !== "submitted"
        ? null
        : {
            schemaVersion: "ModelInvocationSubmissionV1",
            invocationId: scope.invocationId,
            scopeSha256: opening.scopeSha256,
            receiptSetSha256: seal.receiptSetSha256,
            receivedAt: "2026-09-08T00:01:04.000Z",
            consistency: {
              state: "matched",
              reasons: [],
              observedIdentitySha256: registration.identitySha256,
            },
            executionAccepted: false,
          },
    callOutcomes:
      state !== "submitted"
        ? null
        : {
            completed: 1,
            provider_failed: 0,
            provider_incomplete: 0,
            transport_failed: 0,
            cancelled: 0,
            protocol_invalid: 0,
            budget_exceeded: 0,
          },
  };
}

export function evaluationCellInvocationListFixture(
  state: EvaluationModelInvocationFixtureState = "submitted",
): C.EvaluationCellInvocationListV1 {
  return {
    schemaVersion: "EvaluationCellInvocationListV1",
    ...evaluationModelInvocationTestScope,
    expectedRuntimeRegistration: evaluationInvocationRuntimeFixture(),
    page: 1,
    pageSize: 10,
    total: 1,
    sampledAt: "2026-09-08T00:02:00.000Z",
    items: [evaluationCellInvocationItemFixture(state)],
  };
}
