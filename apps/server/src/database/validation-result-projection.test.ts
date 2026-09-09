import type { DatabaseSync } from "node:sqlite";
import {
  getValidationJobResultV2Issues,
  type ValidationJobResultV1,
  type ValidationJobResultV2,
} from "@agentic-review/codex";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  currentValidationEvidence,
  normalizedValidationModel,
  normalizedValidationReport,
  type VerifiedValidationEvidenceFacts,
  verificationKey,
  verificationStatuses,
} from "./validation-result-projection.js";

function result(): ValidationJobResultV1 {
  return {
    schemaVersion: "ValidationJobResultV1",
    report: {
      schemaVersion: "ValidationReportV1",
      source: "worker",
      workItemKind: "pull_request",
      summary: "Runner summary",
      sourceState: "original",
      checks: [],
    },
    execution: { blockers: [], diagnostics: [], cleanupState: "not_needed" },
    modelReview: { state: "not_requested" },
  };
}

function issueResult(): ValidationJobResultV1 {
  return {
    ...result(),
    modelReview: { state: "not_requested" },
    report: {
      schemaVersion: "ValidationReportV1",
      source: "worker",
      workItemKind: "issue",
      summary: "Runner result",
      sourceState: "original",
      reproductionConclusion: "inconclusive",
      checks: [],
      modelSummary: {
        schemaVersion: "ValidationSummaryV1",
        workItemKind: "issue",
        summary: "Model conclusion",
        reproductionConclusion: "confirmed",
        observations: [],
      },
    },
  };
}

// Projection fixtures only: these references are not owner binding or execution authorization.
function separated(value: ValidationJobResultV1): ValidationJobResultV2 {
  const { modelSummary, ...report } = value.report;
  const candidate = {
    ...value,
    schemaVersion: "ValidationJobResultV2",
    report,
  } as ValidationJobResultV2;
  if (value.modelReview.state === "completed") {
    const { executionEvidence, ...raw } = value.modelReview.result;
    candidate.modelReview = {
      state: "completed",
      result: raw,
      executionEvidence,
      execution: {
        schemaVersion: "CliModelExecutionV1",
        jobId: "projection-job",
        runAttemptId: "projection-attempt",
        cli: { kind: "codex", version: "synthetic-cli", requestedModel: null },
        promptSha256: "a".repeat(64),
        outputSchemaSha256: "b".repeat(64),
        outputSha256: sha256(canonicalJson(raw)),
        exitCode: 0,
      },
    };
  } else if (modelSummary !== undefined && value.modelReview.state === "not_requested") {
    candidate.modelReview = {
      state: "completed",
      result: modelSummary,
      executionEvidence: {
        schemaVersion: "ReviewExecutionEvidenceV1",
        source: "worker",
        commandCapture: "complete",
        commands: [],
        worktree: { status: "clean", source: "git_status" },
      },
      execution: {
        schemaVersion: "CliModelExecutionV1",
        jobId: "projection-job",
        runAttemptId: "projection-attempt",
        cli: { kind: "codex", version: "synthetic-cli", requestedModel: null },
        promptSha256: "a".repeat(64),
        outputSchemaSha256: "b".repeat(64),
        outputSha256: sha256(canonicalJson(modelSummary)),
        exitCode: 0,
      },
    };
  }
  expect(getValidationJobResultV2Issues(candidate)).toEqual([]);
  return candidate;
}

describe("purpose-neutral validation model projection", () => {
  it.each(["v1", "v2"])(
    "preserves every %s PR finding and its ordinal without reducing it to a preview",
    (version) => {
      const value = result();
      const findings = Array.from({ length: 40 }, (_, ordinal) => ({
        findingId: `finding-${ordinal}`,
        priority: 1 as const,
        title: "Inspect boundary",
        body: "The boundary failed.",
        path: "src/app.ts",
        line: ordinal + 1,
        endLine: null,
        confidence: 0.9,
      }));
      value.modelReview = {
        state: "completed",
        result: {
          schemaVersion: "PrReviewPlanV2",
          summary: "PR model result",
          assessment: "request_changes",
          findings,
          requestedRecipeIds: [],
          verification: {
            status: "not_run",
            summary: "Runner results are separate.",
            commands: [],
          },
          executionEvidence: {
            schemaVersion: "ReviewExecutionEvidenceV1",
            source: "worker",
            commandCapture: "complete",
            commands: [],
            worktree: { status: "clean", source: "git_status" },
          },
        },
      };
      const subject = version === "v1" ? value : separated(value);
      const before = canonicalJson(subject);
      const projection = normalizedValidationModel(subject, "pr_static_build");
      expect(projection).toMatchObject({
        state: "completed",
        summary: "PR model result",
        recommendation: "request_changes",
        issueTriage: null,
        reproductionConclusion: null,
      });
      expect(projection.findings).toEqual(
        findings.map((finding, ordinal) => ({ ...finding, ordinal })),
      );
      expect(canonicalJson(subject)).toEqual(before);
      expect(normalizedValidationReport(subject)).toEqual(value.report);
      if (
        subject.schemaVersion === "ValidationJobResultV2" &&
        subject.modelReview.state === "completed"
      ) {
        expect(subject.modelReview.result).not.toHaveProperty("executionEvidence");
        expect(subject.modelReview.execution.outputSha256).not.toBe(sha256(before));
      }
    },
  );
  it.each(["v1", "v2"])(
    "keeps %s issue triage categories separate from model reproduction advice",
    (version) => {
      const value = issueResult();
      value.modelReview = {
        state: "completed",
        result: {
          schemaVersion: "IssueTriageV2",
          summary: "Need version details",
          category: "bug",
          priority: 2,
          confidence: 0.9,
          suggestedLabels: ["bug"],
          missingInformation: ["Application version"],
          duplicateCandidates: [],
          requestedRecipeIds: [],
          verification: { status: "not_run", summary: "No reproduction in triage.", commands: [] },
          executionEvidence: {
            schemaVersion: "ReviewExecutionEvidenceV1",
            source: "worker",
            commandCapture: "complete",
            commands: [],
            worktree: { status: "clean", source: "git_status" },
          },
        },
      };
      expect(
        normalizedValidationModel(version === "v1" ? value : separated(value), "issue_triage"),
      ).toMatchObject({
        state: "completed",
        summary: "Need version details",
        recommendation: null,
        reproductionConclusion: null,
        issueTriage: { category: "bug", missingInformation: ["Application version"] },
      });
    },
  );
  it("projects V2 summary advice without moving it into Worker observations or changing either digest", () => {
    const legacy = issueResult();
    const value = separated(legacy);
    const bytes = canonicalJson(value);
    if (value.modelReview.state !== "completed") throw new Error("Expected completed CLI output.");
    expect(normalizedValidationModel(value, "issue_validation")).toEqual({
      ...normalizedValidationModel(legacy, "issue_validation"),
      execution: value.modelReview.execution,
    });
    expect(normalizedValidationReport(value)).toEqual(normalizedValidationReport(legacy));
    expect(normalizedValidationReport(value)).toMatchObject({
      reproductionConclusion: "inconclusive",
      summary: "Runner result",
    });
    expect(value.report).not.toHaveProperty("modelSummary");
    expect(canonicalJson(value)).toBe(bytes);
    expect(canonicalJson(legacy)).toContain('"modelSummary"');
  });
  it.each(["not_requested", "failed"] as const)(
    "keeps V2 %s model state without inventing a completed result",
    (state) => {
      const legacy = result();
      if (state === "failed")
        legacy.modelReview = {
          state,
          code: "MODEL_FAILED",
          message: "The model did not complete.",
        };
      const value = separated(legacy);
      expect(normalizedValidationModel(value, "pr_static_build")).toEqual(
        normalizedValidationModel(legacy, "pr_static_build"),
      );
      expect(normalizedValidationReport(value)).toEqual(legacy.report);
    },
  );
  it("promotes UI model summaries only for the matching summary workflows", () => {
    const value = issueResult();
    expect(normalizedValidationModel(value, "issue_validation")).toMatchObject({
      state: "completed",
      summary: "Model conclusion",
      recommendation: null,
      reproductionConclusion: "confirmed",
    });
    expect(normalizedValidationModel(value, "issue_triage")).toMatchObject({
      state: "not_requested",
      summary: null,
      recommendation: null,
      reproductionConclusion: null,
    });
    expect(value.report).toMatchObject({ reproductionConclusion: "inconclusive" });
    const pr = result();
    pr.report.modelSummary = {
      schemaVersion: "ValidationSummaryV1",
      workItemKind: "pull_request",
      summary: "UI model summary",
      recommendation: "approve",
      observations: [],
    };
    expect(normalizedValidationModel(pr, "pr_ui")).toMatchObject({
      state: "completed",
      recommendation: "approve",
      reproductionConclusion: null,
    });
    expect(normalizedValidationModel(pr, "pr_static_build").state).toBe("not_requested");
  });
  it("retains model errors and observations without promoting a failed review", () => {
    const value = issueResult();
    const observation = {
      id: "observation-1",
      title: "Observed issue",
      body: "The view remained open.",
      priority: 1 as const,
      path: null,
      line: null,
    };
    if (!value.report.modelSummary) throw new Error("Expected a model summary fixture.");
    value.report.modelSummary.observations.push(observation);
    value.modelReview = {
      state: "failed",
      code: "MODEL_FAILED",
      message: "The model did not complete.",
    };
    expect(normalizedValidationModel(value, "issue_validation")).toEqual({
      state: "failed",
      summary: null,
      recommendation: null,
      findings: [],
      observations: [observation],
      issueTriage: null,
      reproductionConclusion: null,
      error: { code: "MODEL_FAILED", message: "The model did not complete." },
      execution: null,
    });
  });
  it.each(["pr_static_build", "pr_ui", "issue_triage", "issue_validation"] as const)(
    "does not invent model advice for a runner-only %s result",
    (workflow) => {
      expect(normalizedValidationModel(result(), workflow)).toMatchObject({
        state: "not_requested",
        summary: null,
        findings: [],
        observations: [],
        recommendation: null,
        reproductionConclusion: null,
      });
    },
  );
});

function facts(
  profiles: VerifiedValidationEvidenceFacts["profiles"],
): VerifiedValidationEvidenceFacts {
  return {
    profiles,
    assertCurrent: vi.fn(),
    admittedEvidenceReferences: vi.fn(() => true),
    admittedScenarioEvidence: vi.fn(() => true),
  };
}

describe("verification projection boundaries", () => {
  it("preserves exact request and Job identities and marks repeated statuses unavailable", () => {
    const key = verificationKey("request:a", "job");
    expect(key).not.toBe(verificationKey("request", "a:job"));
    const value = facts([
      { requestId: "request:a", jobId: "job", status: "verified" },
      { requestId: "request:a", jobId: "job", status: "verified" },
      { requestId: "other", jobId: "job", status: "pending" },
    ]);
    expect([...verificationStatuses(value)]).toEqual([
      [key, "unavailable"],
      [verificationKey("other", "job"), "pending"],
    ]);
    expect(value.assertCurrent).not.toHaveBeenCalled();
  });
  it("fails closed on absent or over-limit prepared profile metadata", () => {
    expect(verificationStatuses(undefined).size).toBe(0);
    expect(
      verificationStatuses(
        facts(
          Array.from({ length: 33 }, (_, index) => ({
            requestId: `request-${index}`,
            jobId: "job",
            status: "verified",
          })),
        ),
      ).size,
    ).toBe(0);
  });
  it.each(["pending", "unavailable"] as const)(
    "does not read SQLite or storage for %s evidence",
    (status) => {
      const prepare = vi.fn(() => {
        throw new Error("No database read is allowed.");
      });
      const value = facts([{ requestId: "request", jobId: "job", status }]);
      expect(
        currentValidationEvidence(
          { prepare } as unknown as DatabaseSync,
          { id: "run", repositoryId: "repo", revisionKey: "revision", planDigest: "digest" },
          "request",
          { jobId: "job" },
          { runAttemptId: "attempt", profileVersionId: "profile", evidenceComplete: 1 },
          result(),
          { kind: "prepared", facts: value, statuses: verificationStatuses(value) },
        ),
      ).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      expect(value.admittedEvidenceReferences).not.toHaveBeenCalled();
    },
  );
});
