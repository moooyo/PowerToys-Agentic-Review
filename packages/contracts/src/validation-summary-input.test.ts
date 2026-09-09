import { FormatRegistry } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import {
  type FreezeValidationSummaryInputRequest,
  type FreezeValidationSummaryInputResponse,
  type FrozenValidationSummaryInputV1,
  getFreezeValidationSummaryInputRequestIssues,
  getFreezeValidationSummaryInputResponseIssues,
  getFrozenValidationSummaryInputIssues,
  getValidationSummaryContextIssues,
  maximumValidationSummaryContextUtf8Bytes,
  type ValidationSummaryContextV1,
} from "./validation-summary-input.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
const hash = "a".repeat(64);
const frozenAt = "2026-09-08T00:00:00.000Z";
function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error("Missing synthetic fixture item.");
  return value;
}
function context(): ValidationSummaryContextV1 {
  return {
    schemaVersion: "ValidationSummaryContextV1",
    runId: "run-a",
    requestId: "request-a",
    jobId: "job-a",
    runAttemptId: "attempt-a",
    githubRepositoryId: 123,
    profileVersionId: "profile-a",
    revisionKey: hash,
    planDigest: hash,
    testedSourceRevision: {
      kind: "pull_request",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    report: {
      schemaVersion: "ValidationReportV1",
      workItemKind: "pull_request",
      source: "worker",
      summary: "Compilation failed.",
      sourceState: "original",
      checks: [
        {
          id: "profile-a:build",
          name: "Compile",
          kind: "build",
          required: true,
          outcome: "failed",
          summary: "Compiler returned 1.",
          expected: "Exit 0",
          actual: "Exit 1",
          evidenceIds: [],
          source: "runner",
        },
      ],
    },
    execution: {
      blockers: [],
      diagnostics: [
        {
          stepId: "profile-a:build",
          phase: "build",
          outcome: "failed",
          exitCode: 1,
          summary: "Compiler returned 1.",
        },
      ],
      cleanupState: "completed",
    },
    evidence: { assets: [], scenarios: [] },
  };
}
function request(): FreezeValidationSummaryInputRequest {
  return {
    lease: {
      jobId: "job-a",
      runAttemptId: "attempt-a",
      workerNodeId: "worker-a",
      workerInstanceId: "instance-a",
      leaseGeneration: 1,
      leaseToken: "synthetic-lease-token-for-summary-input",
    },
    inputId: "input-a",
    context: context(),
  };
}
function document(): FrozenValidationSummaryInputV1 {
  return {
    schemaVersion: "FrozenValidationSummaryInputV1",
    inputId: "input-a",
    repositoryId: "repository-a",
    evaluationId: "evaluation-a",
    cellId: "cell-a",
    authorizationId: "authorization-a",
    executionManifestSha256: hash,
    workerNodeId: "worker-a",
    workerInstanceId: "instance-a",
    leaseGeneration: 1,
    sourcePromptSha256: hash,
    outputSchemaSha256: hash,
    contextSha256: hash,
    actualPromptSha256: hash,
    context: context(),
    frozenAt,
  };
}
function response(): FreezeValidationSummaryInputResponse {
  return {
    schemaVersion: "FreezeValidationSummaryInputResponseV1",
    reference: {
      schemaVersion: "ValidationSummaryInputReferenceV1",
      inputId: "input-a",
      inputSha256: hash,
      sourcePromptSha256: hash,
      outputSchemaSha256: hash,
      contextSha256: hash,
      actualPromptSha256: hash,
    },
    frozenAt,
  };
}
describe("validation summary input contracts", () => {
  it("retains failed runner facts and separates context, source Prompt and complete input identities", () => {
    expect(getValidationSummaryContextIssues(context())).toEqual([]);
    expect(getFreezeValidationSummaryInputRequestIssues(request())).toEqual([]);
    expect(getFrozenValidationSummaryInputIssues(document())).toEqual([]);
    expect(getFreezeValidationSummaryInputResponseIssues(response())).toEqual([]);
    expect(context().report.checks[0]?.outcome).toBe("failed");
  });
  it.each(["modelSummary", "modelCheck", "modelBlocker", "modelDiagnostic"])(
    "rejects prior model contribution %s",
    (mutation) => {
      const value = context();
      if (mutation === "modelSummary")
        Object.assign(value.report, {
          modelSummary: {
            schemaVersion: "ValidationSummaryV1",
            workItemKind: "pull_request",
            summary: "Advice",
            recommendation: "approve",
            observations: [],
          },
        });
      if (mutation === "modelCheck") first(value.report.checks).source = "model";
      if (mutation === "modelBlocker")
        value.execution.blockers.push({
          phase: "model_review",
          stepId: null,
          code: "MODEL_FAILED",
          message: "Earlier model failed.",
        });
      if (mutation === "modelDiagnostic") first(value.execution.diagnostics).phase = "model_review";
      expect(getValidationSummaryContextIssues(value).length).toBeGreaterThan(0);
    },
  );
  it("rejects duplicates and evidence from a different attempt", () => {
    const value = context();
    value.report.checks.push(structuredClone(first(value.report.checks)));
    expect(getValidationSummaryContextIssues(value).length).toBeGreaterThan(0);
    value.report.checks.pop();
    value.evidence.assets.push({
      id: "asset-a",
      repositoryId: "repository-a",
      runId: value.runId,
      jobId: value.jobId,
      runAttemptId: "other-attempt",
      requestId: value.requestId,
      profileVersionId: value.profileVersionId,
      revisionKey: value.revisionKey,
      planDigest: value.planDigest,
      metadata: {
        kind: "log",
        mediaType: "text/plain",
        sha256: hash,
        sizeBytes: 3,
        capturedAt: frozenAt,
      },
      state: "finalized",
      createdAt: frozenAt,
      finalizedAt: frozenAt,
      retiredAt: null,
    });
    expect(getValidationSummaryContextIssues(value)).toContain(
      "Summary evidence must belong to the same frozen attempt and profile.",
    );
    first(value.evidence.assets).runAttemptId = value.runAttemptId;
    expect(getValidationSummaryContextIssues(value)).toEqual([]);
    value.evidence.assets.push(structuredClone(first(value.evidence.assets)));
    expect(getValidationSummaryContextIssues(value).length).toBeGreaterThan(0);
  });
  it("rejects mismatched lease identity and a lease credential inside context", () => {
    const value = request();
    value.context.runAttemptId = "other-attempt";
    expect(getFreezeValidationSummaryInputRequestIssues(value).length).toBeGreaterThan(0);
    value.context.runAttemptId = value.lease.runAttemptId;
    value.context.report.summary = `Unexpected echo: ${value.lease.leaseToken}`;
    expect(getFreezeValidationSummaryInputRequestIssues(value)).toContain(
      "Summary context cannot contain the lease credential.",
    );
  });
  it("does not execute accessors or custom serialization and rejects cycles", () => {
    const getter = vi.fn(() => "hidden");
    const value = context();
    Object.defineProperty(value.report, "summary", { get: getter, enumerable: true });
    expect(getValidationSummaryContextIssues(value).length).toBeGreaterThan(0);
    expect(getter).not.toHaveBeenCalled();
    const serialize = vi.fn(() => context());
    expect(
      getValidationSummaryContextIssues({ ...context(), toJSON: serialize }).length,
    ).toBeGreaterThan(0);
    expect(serialize).not.toHaveBeenCalled();
    const cycle = context();
    Object.assign(cycle, { cycle });
    expect(getValidationSummaryContextIssues(cycle).length).toBeGreaterThan(0);
  });
  it("rejects unknown fields, explicit undefined, malformed Unicode and sparse arrays", () => {
    expect(
      getValidationSummaryContextIssues({ ...context(), workspace: "C:\\Private" }).length,
    ).toBeGreaterThan(0);
    expect(
      getValidationSummaryContextIssues({ ...context(), observationResults: undefined }).length,
    ).toBeGreaterThan(0);
    const value = context();
    value.report.summary = "\ud800";
    expect(getValidationSummaryContextIssues(value).length).toBeGreaterThan(0);
    value.report.summary = "Valid";
    value.report.checks.length = 2;
    expect(getValidationSummaryContextIssues(value).length).toBeGreaterThan(0);
    const noPrototype = context();
    Object.setPrototypeOf(noPrototype.report.checks, null);
    expect(getValidationSummaryContextIssues(noPrototype).length).toBeGreaterThan(0);
  });
  it("enforces total UTF-8 size as well as per-field bounds without dropping diagnostics", () => {
    const value = context();
    value.execution.diagnostics = Array.from({ length: 100 }, (_, index) => ({
      stepId: `profile-a:test-${index}`,
      phase: "test",
      outcome: "failed",
      exitCode: 1,
      summary: "Failure",
      stdout: "\u6d4b".repeat(1000),
    }));
    expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeGreaterThan(
      maximumValidationSummaryContextUtf8Bytes,
    );
    expect(getValidationSummaryContextIssues(value).length).toBeGreaterThan(0);
    expect(value.execution.diagnostics).toHaveLength(100);
  });
  it.each(["2026-02-30T00:00:00.000Z", "2026-09-08T00:00:00Z", "2026-09-08T08:00:00.000+08:00"])(
    "rejects noncanonical frozen time %s",
    (time) => {
      expect(
        getFrozenValidationSummaryInputIssues({ ...document(), frozenAt: time }).length,
      ).toBeGreaterThan(0);
      expect(
        getFreezeValidationSummaryInputResponseIssues({ ...response(), frozenAt: time }).length,
      ).toBeGreaterThan(0);
    },
  );
});
