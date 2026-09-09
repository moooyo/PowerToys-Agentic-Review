import { createCanonicalResult } from "@agentic-review/codex";
import type {
  TestProbeReceiptV1,
  ValidationExecutionDetails,
  ValidationReportV1,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  createReproductionAssessment,
  validateReproductionEnvelope,
} from "./issue-reproduction-results.js";
import { mappedEvaluationProfileFixture } from "./profile-envelope.testing.js";

function fixture(value: boolean) {
  const envelope = mappedEvaluationProfileFixture();
  const context = envelope.validation;
  const frozen = context.reproduction;
  const selected = frozen?.binding.cases[0];
  if (selected === undefined || frozen === undefined) throw new Error("Synthetic case missing.");
  selected.absentWhen = {
    allOf: [
      {
        observation: { kind: "probe_value", testStepId: "test", observationId: "observed" },
        equals: { type: "boolean", value: false },
      },
    ],
  };
  frozen.bindingDigest = createCanonicalResult(frozen.binding).sha256;
  const checkId = `${context.profileVersion.id}:test`;
  const report: ValidationReportV1 = {
    schemaVersion: "ValidationReportV1",
    source: "worker",
    workItemKind: "issue",
    summary: "Synthetic deterministic probe.",
    sourceState: "original",
    reproductionConclusion: "inconclusive",
    checks: [
      {
        id: checkId,
        name: "Synthetic probe",
        kind: "test",
        source: "runner",
        required: true,
        outcome: "passed",
        summary: "Probe settled.",
        expected: null,
        actual: null,
        evidenceIds: [],
      },
    ],
  };
  const execution: ValidationExecutionDetails = {
    cleanupState: "completed",
    blockers: [],
    diagnostics: [
      {
        stepId: checkId,
        phase: "test",
        outcome: "passed",
        exitCode: 0,
        summary: "Probe settled.",
        stdout: "",
        stderr: "",
      },
    ],
  };
  const output: TestProbeReceiptV1["output"] = {
    schemaVersion: "ProbeObservationsV1",
    observations: [{ id: "observed", state: "observed", value: { type: "boolean", value } }],
  };
  const receipt: TestProbeReceiptV1 = {
    schemaVersion: "TestProbeReceiptV1",
    requestId: context.requestId,
    jobId: envelope.job.jobId,
    runAttemptId: envelope.lease.runAttemptId,
    planDigest: context.planDigest,
    profileVersionId: context.profileVersion.id,
    checkId,
    capture: "complete",
    output,
    outputSha256: createCanonicalResult(output).sha256,
  };
  return { envelope, report, execution, receipt };
}

describe("mapped evaluation reproduction observations", () => {
  it.each([
    { value: true, conclusion: "confirmed" },
    { value: false, conclusion: "not_reproduced" },
  ] as const)("derives $conclusion from the actual typed probe value", ({ value, conclusion }) => {
    const f = fixture(value);
    const original = createCanonicalResult({
      report: f.report,
      execution: f.execution,
      receipt: f.receipt,
    }).json;
    expect(f.envelope.validation.testedSourceAuthorization).toBeNull();
    expect(() => validateReproductionEnvelope(f.envelope)).not.toThrow();
    const assessment = createReproductionAssessment(
      f.envelope,
      f.report,
      f.execution,
      { assets: [], scenarios: [] },
      [f.receipt],
    );
    expect(assessment).toMatchObject({
      conclusion,
      coverage: "complete",
      bindingDigest: f.envelope.validation.reproduction?.bindingDigest,
      planDigest: f.envelope.validation.planDigest,
      requestId: f.envelope.validation.requestId,
    });
    expect(
      createCanonicalResult({ report: f.report, execution: f.execution, receipt: f.receipt }).json,
    ).toBe(original);
  });

  it("does not infer reproduction from successful execution when the observation is absent", () => {
    const f = fixture(true);
    const assessment = createReproductionAssessment(
      f.envelope,
      f.report,
      f.execution,
      { assets: [], scenarios: [] },
      undefined,
    );
    expect(assessment).toMatchObject({ conclusion: "inconclusive", coverage: "partial" });
  });

  it("rejects a rehashed binding that borrows an unrelated operator identity", () => {
    const f = fixture(true),
      frozen = f.envelope.validation.reproduction;
    if (frozen === undefined) throw new Error("Synthetic binding missing.");
    frozen.binding.authorizedBy.subject = "another-operator";
    frozen.bindingDigest = createCanonicalResult(frozen.binding).sha256;
    expect(() =>
      createReproductionAssessment(
        f.envelope,
        f.report,
        f.execution,
        { assets: [], scenarios: [] },
        [f.receipt],
      ),
    ).toThrow();
  });
});
