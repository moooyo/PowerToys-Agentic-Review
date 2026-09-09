import type { ValidationJobResultV1, ValidationJobResultV2 } from "@agentic-review/codex";
import type {
  FrozenIssueReproductionBinding,
  TestProbeReceiptV1,
  ValidationJobContext,
  ValidationProfileConfig,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  type ReproductionResultScope,
  recomputeIssueReproductionRequestAssessment,
  validateIssueReproductionResult,
  validateProbeReceiptObservations,
} from "./issue-reproduction.js";

const now = "2026-09-07T00:00:00.000Z";
const digest = "a".repeat(64);
const commit = "b".repeat(40);
const command = (id: string) => ({
  id,
  name: id,
  required: true,
  timeoutMs: 10_000,
  command: { executable: "probe.exe", args: [id], workingDirectory: ".", environment: [] },
});

function fixture(): Omit<ReproductionResultScope, "result"> & { result: ValidationJobResultV1 } {
  const config: ValidationProfileConfig = {
    schemaVersion: "ValidationProfileV1",
    setup: [command("setup")],
    build: [command("build")],
    test: [
      {
        ...command("probe"),
        probeOutput: {
          schemaVersion: "TestProbeOutputDeclarationV1",
          fields: [
            { id: "status", description: "The precise observed status.", type: "string" },
            { id: "count", description: "The measured count.", type: "number" },
          ],
        },
      },
    ],
    launch: [],
    cleanup: [command("cleanup")],
    requiredCapabilities: [],
    hardTimeoutMs: 60_000,
    noProgressTimeoutMs: 10_000,
  };
  const profile: ValidationJobContext["profileVersion"] = {
    id: "version",
    profileId: "profile",
    repositoryId: "repository",
    name: "Probe fixture",
    version: 1,
    workflowKind: "issue_validation",
    target: "headless",
    required: true,
    outputSchemaVersion: "ValidationReportV1",
    createdAt: now,
    publishedAt: now,
    createdBy: "operator",
    config,
    configSha256: sha256(canonicalJson(config)),
  };
  const binding: FrozenIssueReproductionBinding["binding"] = {
    schemaVersion: "IssueReproductionBindingV1",
    activationId: "activation",
    repositoryId: "repository",
    githubRepositoryId: 1,
    workItemId: "issue",
    githubWorkItemId: 2,
    issueRevisionKey: digest,
    testedSourceCommit: commit,
    authorizedBy: { issuer: "issuer", subject: "subject", authorizedAt: now },
    claim: "The status duplicates.",
    cases: [
      {
        id: "case",
        requestId: "request",
        profileVersionId: "version",
        profileConfigSha256: profile.configSha256,
        target: "headless",
        context: "Probe the application.",
        preconditions: [],
        presentWhen: {
          allOf: [
            {
              observation: { kind: "probe_value", testStepId: "probe", observationId: "status" },
              equals: { type: "string", value: "Duplicate" },
            },
          ],
        },
        absentWhen: {
          allOf: [
            {
              observation: { kind: "probe_value", testStepId: "probe", observationId: "status" },
              equals: { type: "string", value: "Ready" },
            },
          ],
        },
      },
    ],
  };
  const validation: ValidationJobContext = {
    schemaVersion: "ValidationJobContextV1",
    runId: "run",
    planDigest: "c".repeat(64),
    activationId: "activation",
    requestId: "request",
    jobActivation: 1,
    repositoryId: "repository",
    workItemId: "issue",
    revisionKey: digest,
    requestEpochId: "epoch",
    workflowKind: "issue_validation",
    target: "headless",
    required: true,
    profileVersion: profile,
    promptVersion: { id: "prompt", templateId: "template", version: 1, contentSha256: digest },
    requiredCheckIds: ["version:build", "version:probe"],
    testedSourceRevision: { kind: "commit", headSha: commit },
    testedSourceAuthorization: {
      kind: "operator",
      activationId: "activation",
      issuer: "issuer",
      subject: "subject",
      authorizedAt: now,
      githubRepositoryId: 1,
      githubWorkItemId: 2,
      issueRevisionKey: digest,
      headSha: commit,
    },
    reproduction: { binding, bindingDigest: sha256(canonicalJson(binding)) },
  };
  const output: TestProbeReceiptV1["output"] = {
    schemaVersion: "ProbeObservationsV1",
    observations: [
      { id: "status", state: "observed", value: { type: "string", value: "Duplicate" } },
      { id: "count", state: "observed", value: { type: "number", value: 2 } },
    ],
  };
  const steps = (["setup", "build", "test", "cleanup"] as const).flatMap((phase) =>
    config[phase].map((step) => ({ id: `version:${step.id}`, phase })),
  );
  const result: ValidationJobResultV1 = {
    schemaVersion: "ValidationJobResultV1",
    report: {
      schemaVersion: "ValidationReportV1",
      source: "worker",
      workItemKind: "issue",
      sourceState: "original",
      summary: "Complete independent measurements.",
      reproductionConclusion: "inconclusive",
      checks: steps.map((step) => ({
        id: step.id,
        name: step.id,
        kind: step.phase === "setup" || step.phase === "cleanup" ? "static" : step.phase,
        required: true,
        outcome: "passed",
        summary: "Passed.",
        expected: null,
        actual: null,
        evidenceIds: [],
        source: "runner",
      })),
    },
    execution: {
      cleanupState: "completed",
      blockers: [],
      diagnostics: steps.map((step) => ({
        stepId: step.id,
        phase: step.phase,
        outcome: "passed",
        exitCode: 0,
        summary: "Exited and drained.",
      })),
    },
    modelReview: { state: "not_requested" },
    probeReceipts: [
      {
        schemaVersion: "TestProbeReceiptV1",
        requestId: "request",
        jobId: "job",
        runAttemptId: "attempt",
        planDigest: validation.planDigest,
        profileVersionId: "version",
        checkId: "version:probe",
        capture: "complete",
        output,
        outputSha256: sha256(canonicalJson(output)),
      },
    ],
  };
  return { validation, jobId: "job", runAttemptId: "attempt", result };
}
function receipt(value: ReproductionResultScope): TestProbeReceiptV1 {
  const item = value.result.probeReceipts?.[0];
  if (item === undefined) throw new Error("The fixture receipt is missing.");
  return item;
}
function updateHash(value: ReproductionResultScope): void {
  receipt(value).outputSha256 = sha256(canonicalJson(receipt(value).output));
}
function attachAssessment(value: ReproductionResultScope): void {
  const recomputed = recomputeIssueReproductionRequestAssessment(value);
  if (recomputed === undefined || value.result.report.workItemKind !== "issue")
    throw new Error("The mapped assessment is missing.");
  value.result.report.reproductionConclusion = recomputed.assessment.conclusion;
  Object.assign(value.result, { reproductionAssessment: recomputed.assessment });
}

describe("independent stored probe admission", () => {
  it("uses V2 Worker probe facts even when separate model advice says the issue was not reproduced", () => {
    const legacy = fixture();
    if (legacy.result.report.workItemKind !== "issue")
      throw new Error("The Issue fixture is missing.");
    const { modelSummary: _modelSummary, ...report } = legacy.result.report;
    const model = {
      schemaVersion: "ValidationSummaryV1" as const,
      workItemKind: "issue" as const,
      summary: "Synthetic model advice is not a runner assertion.",
      reproductionConclusion: "not_reproduced" as const,
      observations: [],
    };
    const result: ValidationJobResultV2 = {
      ...legacy.result,
      schemaVersion: "ValidationJobResultV2",
      report,
      modelReview: {
        state: "completed",
        result: model,
        executionEvidence: {
          schemaVersion: "ReviewExecutionEvidenceV1",
          source: "worker",
          commandCapture: "complete",
          commands: [],
          worktree: { status: "clean", source: "git_status" },
        },
        invocation: {
          invocationId: "projection-only",
          scopeSha256: "a".repeat(64),
          receiptSetSha256: "b".repeat(64),
          modelOutputSha256: sha256(canonicalJson(model)),
        },
      },
    };
    const scope: ReproductionResultScope = { ...legacy, result };
    expect(validateProbeReceiptObservations(scope)).toEqual(
      validateProbeReceiptObservations(legacy),
    );
    expect(recomputeIssueReproductionRequestAssessment(scope)?.assessment.conclusion).toBe(
      "confirmed",
    );
    attachAssessment(scope);
    expect(() => validateIssueReproductionResult(scope)).not.toThrow();
    expect(scope.result.report).not.toHaveProperty("modelSummary");
    expect(model.reproductionConclusion).toBe("not_reproduced");
  });

  it("recomputes from complete receipts and ignores diagnostic previews and model advice", () => {
    const value = fixture();
    expect(validateProbeReceiptObservations(value)).toHaveLength(2);
    expect(recomputeIssueReproductionRequestAssessment(value)?.assessment.conclusion).toBe(
      "confirmed",
    );
    if (value.result.report.workItemKind !== "issue")
      throw new Error("The Issue fixture is missing.");
    value.result.report.modelSummary = {
      schemaVersion: "ValidationSummaryV1",
      workItemKind: "issue",
      summary: "It was not reproduced.",
      reproductionConclusion: "not_reproduced",
      observations: [],
    };
    for (const diagnostic of value.result.execution.diagnostics) diagnostic.stdout = "Ready";
    attachAssessment(value);
    expect(() => validateIssueReproductionResult(value)).not.toThrow();
  });
  it.each([
    "requestId",
    "jobId",
    "runAttemptId",
    "profileVersionId",
    "checkId",
    "planDigest",
  ] as const)("rejects substituted receipt %s", (field) => {
    const value = fixture();
    receipt(value)[field] = field === "planDigest" ? "f".repeat(64) : "other";
    expect(() => validateProbeReceiptObservations(value)).toThrow();
  });
  it("rejects wrong hash, duplicate receipt, missing receipt, and receipts for failed commands", () => {
    const value = fixture();
    receipt(value).outputSha256 = "f".repeat(64);
    expect(() => validateProbeReceiptObservations(value)).toThrow();
    updateHash(value);
    value.result.probeReceipts?.push(receipt(value));
    expect(() => validateProbeReceiptObservations(value)).toThrow();
    value.result.probeReceipts = [];
    expect(() => validateProbeReceiptObservations(value)).toThrow();
    const failed = fixture();
    const check = failed.result.report.checks.find((item) => item.id === "version:probe");
    const diagnostic = failed.result.execution.diagnostics.find(
      (item) => item.stepId === "version:probe",
    );
    if (check === undefined || diagnostic === undefined)
      throw new Error("The probe records are missing.");
    check.outcome = "failed";
    diagnostic.outcome = "failed";
    diagnostic.exitCode = 1;
    expect(() => validateProbeReceiptObservations(failed)).toThrow();
    delete failed.result.probeReceipts;
    expect(validateProbeReceiptObservations(failed)).toEqual([]);
    expect(recomputeIssueReproductionRequestAssessment(failed)?.assessment.conclusion).toBe(
      "blocked",
    );
  });
  it.each(["duplicate", "missing", "extra", "wrong_type", "unsafe", "nonfinite"] as const)(
    "rejects %s observation fields even after a recomputed document hash",
    (fault) => {
      const value = fixture();
      const output = receipt(value).output;
      if (fault === "duplicate")
        output.observations.push({
          id: "count",
          state: "observed",
          value: { type: "number", value: 3 },
        });
      if (fault === "missing") output.observations.pop();
      if (fault === "extra") output.observations.push({ id: "extra", state: "unavailable" });
      if (fault === "wrong_type")
        output.observations[0] = {
          id: "status",
          state: "observed",
          value: { type: "number", value: 3 },
        };
      if (fault === "unsafe")
        output.observations[0] = {
          id: "status",
          state: "observed",
          value: { type: "string", value: "ghp_0123456789abcdef" },
        };
      if (fault === "nonfinite")
        output.observations[1] = {
          id: "count",
          state: "observed",
          value: { type: "number", value: Infinity },
        };
      updateHash(value);
      expect(() => validateProbeReceiptObservations(value)).toThrow();
    },
  );
  it("retains empty strings and typed negative-zero equality without coercion", () => {
    const value = fixture();
    receipt(value).output.observations = [
      { id: "status", state: "observed", value: { type: "string", value: "" } },
      { id: "count", state: "observed", value: { type: "number", value: -0 } },
    ];
    updateHash(value);
    expect(validateProbeReceiptObservations(value)).toHaveLength(2);
    expect(recomputeIssueReproductionRequestAssessment(value)?.assessment.conclusion).toBe(
      "inconclusive",
    );
  });
  it("does not turn unavailable capture or missing process drainage into an absent measurement", () => {
    const value = fixture();
    receipt(value).output.observations[0] = { id: "status", state: "unavailable" };
    updateHash(value);
    expect(recomputeIssueReproductionRequestAssessment(value)?.assessment.conclusion).toBe(
      "blocked",
    );
    const drain = fixture();
    const diagnostic = drain.result.execution.diagnostics.find(
      (entry) => entry.stepId === "version:probe",
    );
    if (diagnostic === undefined) throw new Error("The fixture diagnostic is missing.");
    diagnostic.exitCode = null;
    expect(() => validateProbeReceiptObservations(drain)).toThrow();
  });
  it("rejects forged assessment, forged runner conclusion, and post-hoc unbound assessments", () => {
    const value = fixture();
    expect(() => validateIssueReproductionResult(value)).toThrow();
    attachAssessment(value);
    if (value.result.report.workItemKind !== "issue")
      throw new Error("The Issue fixture is missing.");
    value.result.report.reproductionConclusion = "not_reproduced";
    expect(() => validateIssueReproductionResult(value)).toThrow();
    attachAssessment(value);
    if (
      !("reproductionAssessment" in value.result) ||
      value.result.reproductionAssessment === undefined
    )
      throw new Error("The recorded assessment is missing.");
    value.result.reproductionAssessment.conclusion = "not_reproduced";
    expect(() => validateIssueReproductionResult(value)).toThrow();
    attachAssessment(value);
    delete value.validation.reproduction;
    expect(() => validateIssueReproductionResult(value)).toThrow();
    delete value.result.reproductionAssessment;
    expect(() => validateIssueReproductionResult(value)).not.toThrow();
  });
  it("checks the exact authoritative source and profile configuration again", () => {
    const value = fixture();
    value.validation.revisionKey = "e".repeat(64);
    expect(() => recomputeIssueReproductionRequestAssessment(value)).toThrow();
    const changed = fixture();
    changed.validation.profileVersion.config.test.reverse();
    changed.validation.profileVersion.config.build = [];
    expect(() => recomputeIssueReproductionRequestAssessment(changed)).toThrow();
  });
});
