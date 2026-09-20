import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  InvestigationCheckpointRequestSchema,
  InvestigationRuntimeStateSchema,
  InvestigationUnacceptedModelUsageSchema,
} from "./investigation.js";
import {
  InvestigationModelOutputRejectionSchema,
  isCorrectableInvestigationModelOutputIssue,
} from "./investigation-model-output.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const issue = {
  rule: "duplicate_record_id",
  paths: ["/analysis/evidence/1/id"],
} as const;
const request = {
  kind: "rejected_analysis",
  lease: { attemptId: "attempt", fence: 1, leaseToken: "synthetic-lease-token" },
  inputCheckpointRef: { id: "checkpoint", version: 1, digest: "a".repeat(64) },
  round: 1,
  invocationId: "invocation",
  issue,
};
const receipt = {
  attemptId: "attempt",
  round: 1,
  invocationId: "invocation",
  issue,
  recordedAt: "2026-09-20T00:00:00.000Z",
};

describe("bounded model output rejection metadata", () => {
  it("accepts a correction request and a minimal durable runtime receipt", () => {
    expect(Value.Check(InvestigationCheckpointRequestSchema, request)).toBe(true);
    expect(Value.Check(InvestigationModelOutputRejectionSchema, receipt)).toBe(true);
    expect(
      Value.Check(InvestigationRuntimeStateSchema, {
        modelOutputRejections: [receipt],
        completedStepIds: [],
        checks: [],
        evidence: [],
        artifacts: [],
        subjects: [],
        startedSteps: [],
        completedSteps: [],
      }),
    ).toBe(true);
  });

  it.each([
    "/analysis/assessment/evidenceRefs/0",
    "/analysis/assessment/reproduction/evidenceRefs/1",
    "/analysis/assessment/bugAssessment/upstreamFix/evidenceRefs/0",
    "/analysis/assessment/bugAssessment/duplicateOf/evidenceRefs/0",
    "/analysis/assessment/featureAssessment/duplicateOf/evidenceRefs/0",
    "/analysis/assessment/featureAssessment/implementationPlanRef/id",
    "/analysis/assessment/e2eAssessment/planRef/id",
    "/analysis/assessment/reproduction/planRef/id",
    "/analysis/findings/0/rootCause/evidenceRefs/0",
    "/analysis/findings/0/confirmation/evidenceRefs/0",
    "/analysis/findings/0/confirmation/recheckRef",
    "/analysis/findings/0/fixRecommendation/planRef/id",
    "/analysis/nextActions/0/planRef/id",
    "/analysis/nextActions/0/draftRef",
    "/analysis/candidates/0/findingId",
    "/analysis/candidates/0/mergedIntoCandidateId",
    "/analysis/rechecks/0/findingId",
    "/analysis/coverageUnits/0/evidenceRefs/0",
  ])("permits ordinary references at the structural position %s", (path) => {
    expect(
      isCorrectableInvestigationModelOutputIssue({
        rule: "reference_outside_batch",
        paths: [path],
      }),
    ).toBe(true);
  });

  it.each([
    "/analysis/evidence/0/subjectRef",
    "/analysis/findings/0/subjectRef",
    "/analysis/assessment/subjectRef",
    "/inputCheckpointRef/id",
    "/analysis/nextActions/0/validationReportRef/id",
    "/runtime/evidence/0/evidenceRefs/0",
    "/analysis/assessment/private-token/evidenceRefs/0",
    "/analysis/assessment/*/evidenceRefs/0",
    "/analysis/evidence/private-token/evidenceRefs/0",
    "/analysis/evidence/0001/evidenceRefs/0",
    "/analysis/evidence/1000000/evidenceRefs/0",
    "/analysis/evidence/0/evidenceRefs/0/private-token",
    "/analysis/evidence/0/evidenceRefs\nprivate-token",
  ])("rejects an unsafe or non-correctable structural position %s", (path) => {
    expect(
      isCorrectableInvestigationModelOutputIssue({
        rule: "reference_outside_batch",
        paths: [path],
      }),
    ).toBe(false);
  });

  it("rejects untrusted fields, other rules, duplicate paths, and unbounded path lists", () => {
    for (const invalid of [
      { ...issue, message: "Untrusted free-form output" },
      { ...issue, rule: "trusted_evidence_collision" },
      { ...issue, rule: "immutable_record_changed" },
      { ...issue, rule: "delta_binding" },
      { ...issue, paths: [] },
      { ...issue, paths: [...issue.paths, ...issue.paths] },
      {
        ...issue,
        paths: Array.from({ length: 9 }, (_, index) => `/analysis/evidence/${index}/id`),
      },
      { ...issue, paths: ["/analysis/assessment/evidenceRefs/0"] },
      { ...issue, paths: ["/analysis/evidence/1/id\n"] },
      { rule: "reference_outside_batch", paths: ["/analysis/assessment/evidenceRefs/0\n"] },
    ]) {
      expect(isCorrectableInvestigationModelOutputIssue(invalid)).toBe(false);
      expect(
        Value.Check(InvestigationCheckpointRequestSchema, { ...request, issue: invalid }),
      ).toBe(false);
    }
  });

  it("rejects proposal payloads and caller-supplied accounting fields", () => {
    for (const extra of [{ proposal: {} }, { tokens: 1 }, { durationMs: 1 }, { raw: "output" }]) {
      expect(Value.Check(InvestigationCheckpointRequestSchema, { ...request, ...extra })).toBe(
        false,
      );
      expect(Value.Check(InvestigationModelOutputRejectionSchema, { ...receipt, ...extra })).toBe(
        false,
      );
    }
    expect(
      Value.Check(InvestigationCheckpointRequestSchema, { ...request, inputCheckpointRef: null }),
    ).toBe(false);
  });

  it("allows interrupt invocation metadata without expanding legacy runtime usage receipts", () => {
    const modelUsage = { round: 1, tokens: 120, invocationId: "invocation" };
    expect(
      Value.Check(InvestigationCheckpointRequestSchema, {
        kind: "interrupt",
        lease: request.lease,
        reason: "error",
        diagnostics: [],
        modelUsage,
      }),
    ).toBe(true);
    expect(
      Value.Check(InvestigationUnacceptedModelUsageSchema, { attemptId: "attempt", ...modelUsage }),
    ).toBe(false);
  });
});
