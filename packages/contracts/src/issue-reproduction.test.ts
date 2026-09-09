import { createHash } from "node:crypto";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { OperatorReviewRunCreateRequestSchema } from "./dashboard-runs.js";
import {
  assertFrozenIssueReproductionBinding,
  assertIssueReproductionCaseAssessment,
  assertIssueReproductionRequest,
  assertReproductionObservationFact,
  FrozenIssueReproductionBindingSchema,
  type FrozenIssueReproductionCase,
  IssueReproductionAssessmentV1Schema,
  type IssueReproductionBindingV1,
  type IssueReproductionCaseAssessment,
  type IssueReproductionCaseRequest,
  IssueReproductionCaseRequestSchema,
  type IssueReproductionRequestV1,
  IssueReproductionRequestV1Schema,
  maximumIssueReproductionRequestUtf8Bytes,
  maximumTestProbeOutputUtf8Bytes,
  ObservationSignatureSchema,
  ObservationValueSchema,
  ProbeObservationsV1Schema,
  ReproductionObservationFactSchema,
  type TestProbeOutputDeclarationV1,
  TestProbeOutputDeclarationV1Schema,
  type TestProbeReceiptV1,
  TestProbeReceiptV1Schema,
  UiAssertionCaptureV1Schema,
} from "./issue-reproduction.js";
import {
  getValidationProfileConfigIssues,
  type ValidationProfileConfig,
  ValidationProfileConfigSchema,
} from "./platform-configuration.js";
import { UiStepExecutionEvidenceSchema } from "./ui-scenarios.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const digest = "a".repeat(64);
const predicate = {
  observation: { kind: "ui_assertion" as const, scenarioId: "save", stepId: "status" },
  equals: { type: "string" as const, value: "Duplicate" },
};
const requestedCase: IssueReproductionCaseRequest = {
  id: "web-case",
  profileId: "profile-1",
  expectedProfileVersionId: "version-1",
  context: "Saving one title in the Web fixture",
  preconditions: [{ kind: "check_passed", checkId: "version-1:build" }],
  presentWhen: { allOf: [predicate] },
  absentWhen: { allOf: [{ ...predicate, equals: { type: "string", value: "Ready" } }] },
};
const request: IssueReproductionRequestV1 = {
  schemaVersion: "IssueReproductionRequestV1",
  claim: "Saving once duplicates the title",
  cases: [requestedCase],
};
const frozenCase: FrozenIssueReproductionCase = {
  id: requestedCase.id,
  context: requestedCase.context,
  preconditions: requestedCase.preconditions,
  presentWhen: requestedCase.presentWhen,
  absentWhen: requestedCase.absentWhen,
  requestId: "profile-1",
  profileVersionId: "version-1",
  profileConfigSha256: digest,
  target: "web",
};
const binding: IssueReproductionBindingV1 = {
  schemaVersion: "IssueReproductionBindingV1",
  activationId: "activation-1",
  repositoryId: "repository-1",
  githubRepositoryId: 1,
  workItemId: "issue-1",
  githubWorkItemId: 2,
  issueRevisionKey: digest,
  testedSourceCommit: "b".repeat(40),
  authorizedBy: {
    issuer: "https://identity.example.test",
    subject: "operator-1",
    authorizedAt: "2026-09-07T10:00:00.000Z",
  },
  claim: request.claim,
  cases: [frozenCase],
};
const assessmentCase: IssueReproductionCaseAssessment = {
  caseId: frozenCase.id,
  requestId: frozenCase.requestId,
  profileVersionId: frozenCase.profileVersionId,
  target: frozenCase.target,
  state: "present",
  matchedObservationRefs: [predicate.observation],
  evidenceIds: ["steps-1"],
  reasons: [],
};
const declaration: TestProbeOutputDeclarationV1 = {
  schemaVersion: "TestProbeOutputDeclarationV1",
  fields: [{ id: "count", description: "The number of matching rows", type: "number" }],
};
const receipt: TestProbeReceiptV1 = {
  schemaVersion: "TestProbeReceiptV1",
  requestId: "profile-1",
  jobId: "job-1",
  runAttemptId: "attempt-1",
  planDigest: digest,
  profileVersionId: "version-1",
  checkId: "version-1:measure",
  capture: "complete",
  output: {
    schemaVersion: "ProbeObservationsV1",
    observations: [{ id: "count", state: "observed", value: { type: "number", value: 2 } }],
  },
  outputSha256: digest,
};
const profile: ValidationProfileConfig = {
  schemaVersion: "ValidationProfileV1",
  setup: [],
  build: [],
  test: [
    {
      id: "measure",
      name: "Measure rows",
      command: { executable: "probe", args: [], workingDirectory: ".", environment: [] },
      timeoutMs: 1_000,
      required: true,
    },
  ],
  launch: [],
  cleanup: [],
  requiredCapabilities: [],
  hardTimeoutMs: 10_000,
  noProgressTimeoutMs: 5_000,
};

describe("Issue reproduction contracts", () => {
  it("exposes strict assertions without including rejected values in errors", () => {
    expect(() => assertIssueReproductionRequest(request)).not.toThrow();
    expect(() =>
      assertFrozenIssueReproductionBinding({ binding, bindingDigest: digest }),
    ).not.toThrow();
    expect(() => assertIssueReproductionCaseAssessment(assessmentCase)).not.toThrow();
    const fact = {
      observation: predicate.observation,
      checkId: "version-1:save",
      evidenceIds: [],
      state: "unavailable",
      reason: "missing_element",
    };
    expect(() => assertReproductionObservationFact(fact)).not.toThrow();
    expect(() =>
      assertIssueReproductionRequest({ ...request, actual: "withheld-measurement" }),
    ).toThrow("Issue reproduction request is invalid at");
    expect(() =>
      assertFrozenIssueReproductionBinding({ binding, bindingDigest: "invalid" }),
    ).toThrow(TypeError);
    expect(() =>
      assertIssueReproductionCaseAssessment({ ...assessmentCase, value: "withheld-measurement" }),
    ).toThrow(TypeError);
    expect(() =>
      assertReproductionObservationFact({ ...fact, value: "withheld-measurement" }),
    ).toThrow(TypeError);
  });

  it("accepts explicit run intent and a separately authoritative frozen binding", () => {
    expect(Value.Check(IssueReproductionRequestV1Schema, request)).toBe(true);
    expect(
      Value.Check(FrozenIssueReproductionBindingSchema, { binding, bindingDigest: digest }),
    ).toBe(true);
    expect(
      Value.Check(IssueReproductionCaseRequestSchema, { ...requestedCase, absentWhen: null }),
    ).toBe(true);
    expect(maximumIssueReproductionRequestUtf8Bytes).toBe(2 * 1024 * 1024);
  });

  it.each(["actual", "conclusion", "authorizedBy", "bindingDigest"])(
    "rejects a client-supplied %s field",
    (field) => {
      expect(Value.Check(IssueReproductionRequestV1Schema, { ...request, [field]: "forged" })).toBe(
        false,
      );
    },
  );

  it("rejects unknown nested fields and incomplete frozen identity", () => {
    expect(
      Value.Check(IssueReproductionRequestV1Schema, {
        ...request,
        cases: [
          { ...requestedCase, presentWhen: { allOf: [{ ...predicate, actual: "Duplicate" }] } },
        ],
      }),
    ).toBe(false);
    expect(
      Value.Check(FrozenIssueReproductionBindingSchema, {
        binding: { ...binding, githubRepositoryId: undefined },
        bindingDigest: digest,
      }),
    ).toBe(false);
    expect(
      Value.Check(FrozenIssueReproductionBindingSchema, {
        binding: { ...binding, testedSourceCommit: "b".repeat(41) },
        bindingDigest: digest,
      }),
    ).toBe(false);
    expect(
      Value.Check(IssueReproductionCaseRequestSchema, { ...requestedCase, absentWhen: undefined }),
    ).toBe(false);
  });

  it("enforces case, predicate, and precondition cardinalities", () => {
    const cases = Array.from({ length: 32 }, (_, index) => ({
      ...requestedCase,
      id: `case-${index}`,
    }));
    expect(Value.Check(IssueReproductionRequestV1Schema, { ...request, cases })).toBe(true);
    expect(Value.Check(IssueReproductionRequestV1Schema, { ...request, cases: [] })).toBe(false);
    expect(
      Value.Check(IssueReproductionRequestV1Schema, {
        ...request,
        cases: [...cases, { ...requestedCase, id: "case-33" }],
      }),
    ).toBe(false);
    const predicates = Array.from({ length: 16 }, (_, index) => ({
      ...predicate,
      observation: { ...predicate.observation, stepId: `step-${index}` },
    }));
    expect(Value.Check(ObservationSignatureSchema, { allOf: predicates })).toBe(true);
    expect(Value.Check(ObservationSignatureSchema, { allOf: [] })).toBe(false);
    expect(Value.Check(ObservationSignatureSchema, { allOf: [...predicates, predicate] })).toBe(
      false,
    );
    expect(Value.Check(ObservationSignatureSchema, { allOf: [predicate, predicate] })).toBe(false);
    const preconditions = Array.from({ length: 16 }, (_, index) => ({
      kind: "check_passed",
      checkId: `version-1:check-${index}`,
    }));
    expect(
      Value.Check(IssueReproductionCaseRequestSchema, { ...requestedCase, preconditions }),
    ).toBe(true);
    expect(
      Value.Check(IssueReproductionCaseRequestSchema, { ...requestedCase, preconditions: [] }),
    ).toBe(true);
    expect(
      Value.Check(IssueReproductionCaseRequestSchema, {
        ...requestedCase,
        preconditions: [...preconditions, { kind: "check_passed", checkId: "version-1:extra" }],
      }),
    ).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", null])(
    "rejects non-finite or nonnumeric measured numbers: %s",
    (value) => expect(Value.Check(ObservationValueSchema, { type: "number", value })).toBe(false),
  );

  it("preserves exact strings and accepts finite fractional values", () => {
    for (const value of [0, -0, 0.5, -1.25, Number.MAX_VALUE]) {
      expect(Value.Check(ObservationValueSchema, { type: "number", value })).toBe(true);
    }
    for (const value of ["", " ", "Ready", "ready", "x".repeat(2_048)]) {
      expect(Value.Check(ObservationValueSchema, { type: "string", value })).toBe(true);
    }
    expect(Value.Check(ObservationValueSchema, { type: "string", value: "x".repeat(2_049) })).toBe(
      false,
    );
    expect(Value.Check(ObservationValueSchema, { type: "string", value: "\u0000" })).toBe(false);
    expect(
      Value.Check(ObservationValueSchema, { type: "boolean", value: false, actual: false }),
    ).toBe(false);
  });

  it("keeps actual values out of bounded deterministic assessments", () => {
    const assessment = {
      schemaVersion: "IssueReproductionAssessmentV1",
      rulesVersion: 1,
      bindingDigest: digest,
      planDigest: digest,
      issueRevisionKey: digest,
      testedSourceCommit: binding.testedSourceCommit,
      conclusion: "confirmed",
      coverage: "complete",
      cases: [assessmentCase],
    };
    expect(Value.Check(IssueReproductionAssessmentV1Schema, assessment)).toBe(true);
    for (const changed of [
      { ...assessment, requestId: "profile-1" },
      { ...assessment, conclusion: "needs_information" },
      { ...assessment, rulesVersion: 2 },
      { ...assessment, cases: [{ ...assessmentCase, actual: "Duplicate" }] },
      { ...assessment, cases: [{ ...assessmentCase, reasons: ["arbitrary text"] }] },
      { ...assessment, cases: [{ ...assessmentCase, evidenceIds: ["steps-1", "steps-1"] }] },
      {
        ...assessment,
        cases: [
          {
            ...assessmentCase,
            matchedObservationRefs: [predicate.observation, predicate.observation],
          },
        ],
      },
    ])
      expect(Value.Check(IssueReproductionAssessmentV1Schema, changed)).toBe(false);
  });

  it("retains old optional-field JSON and rejects null extensions", () => {
    const create = { activationId: "activation-1", expectedRevisionKey: digest };
    const before = JSON.stringify({ create, profile });
    const beforeHash = createHash("sha256").update(before).digest("hex");
    expect(Value.Check(OperatorReviewRunCreateRequestSchema, create)).toBe(true);
    expect(Value.Check(ValidationProfileConfigSchema, profile)).toBe(true);
    expect(getValidationProfileConfigIssues(profile)).toEqual([]);
    const after = JSON.stringify({ create, profile });
    expect(after).toBe(before);
    expect(createHash("sha256").update(after).digest("hex")).toBe(beforeHash);
    expect("reproduction" in create).toBe(false);
    expect(profile.test.every((step) => !("probeOutput" in step))).toBe(true);
    expect(
      Value.Check(OperatorReviewRunCreateRequestSchema, { ...create, reproduction: null }),
    ).toBe(false);
  });
});

describe("Structured observation capture contracts", () => {
  it("permits only declared test-phase probes with unique field IDs", () => {
    const testStep = profile.test[0];
    if (testStep === undefined) throw new Error("The fixture must contain a test step.");
    const configured = { ...testStep, probeOutput: declaration };
    expect(Value.Check(TestProbeOutputDeclarationV1Schema, declaration)).toBe(true);
    expect(getValidationProfileConfigIssues({ ...profile, test: [configured] })).toEqual([]);
    for (const phase of ["setup", "build", "launch", "cleanup"] as const) {
      expect(
        getValidationProfileConfigIssues({ ...profile, test: [], [phase]: [configured] }),
      ).toContain("Step measure may declare probe output only in the test phase.");
    }
    const duplicate = {
      ...configured,
      probeOutput: {
        ...declaration,
        fields: [
          { id: "count", description: "First declaration", type: "number" as const },
          { id: "count", description: "Second declaration", type: "boolean" as const },
        ],
      },
    };
    expect(getValidationProfileConfigIssues({ ...profile, test: [duplicate] })).toContain(
      "Step measure repeats probe field ID count.",
    );
  });

  it("bounds probe fields and rejects verdicts or unavailable values", () => {
    const fields = Array.from({ length: 32 }, (_, index) => ({
      id: `field-${index}`,
      description: "Measured count",
      type: "number",
    }));
    expect(Value.Check(TestProbeOutputDeclarationV1Schema, { ...declaration, fields })).toBe(true);
    expect(
      Value.Check(TestProbeOutputDeclarationV1Schema, {
        ...declaration,
        fields: [...fields, { id: "extra", description: "Extra", type: "number" }],
      }),
    ).toBe(false);
    expect(Value.Check(ProbeObservationsV1Schema, receipt.output)).toBe(true);
    expect(
      Value.Check(ProbeObservationsV1Schema, {
        schemaVersion: "ProbeObservationsV1",
        observations: [{ id: "count", state: "unavailable" }],
      }),
    ).toBe(true);
    expect(
      Value.Check(ProbeObservationsV1Schema, { ...receipt.output, conclusion: "confirmed" }),
    ).toBe(false);
    expect(
      Value.Check(ProbeObservationsV1Schema, {
        schemaVersion: "ProbeObservationsV1",
        observations: [{ id: "count", state: "unavailable", value: { type: "number", value: 0 } }],
      }),
    ).toBe(false);
    expect(Value.Check(TestProbeReceiptV1Schema, receipt)).toBe(true);
    expect(Value.Check(TestProbeReceiptV1Schema, { ...receipt, capture: "partial" })).toBe(false);
    expect(Value.Check(TestProbeReceiptV1Schema, { ...receipt, checkId: "measure" })).toBe(false);
    expect(maximumTestProbeOutputUtf8Bytes).toBe(128 * 1024);
  });

  it("distinguishes unavailable facts from false or empty measured values", () => {
    const common = {
      observation: predicate.observation,
      checkId: "version-1:save",
      evidenceIds: [],
    };
    expect(
      Value.Check(ReproductionObservationFactSchema, {
        ...common,
        state: "observed",
        value: { type: "boolean", value: false },
      }),
    ).toBe(true);
    expect(
      Value.Check(ReproductionObservationFactSchema, {
        ...common,
        state: "unavailable",
        reason: "missing_element",
      }),
    ).toBe(true);
    expect(
      Value.Check(ReproductionObservationFactSchema, {
        ...common,
        state: "unavailable",
        reason: "missing_element",
        value: { type: "string", value: "" },
      }),
    ).toBe(false);
    expect(Value.Check(ReproductionObservationFactSchema, { ...common, state: "observed" })).toBe(
      false,
    );
  });

  it("adds capture only to assertion evidence without backfilling historical evidence", () => {
    const step = {
      stepId: "status",
      name: "Read status",
      action: "assertText",
      outcome: "failed",
      summary: "The complete status differs",
      evidenceIds: [],
      expected: "Ready",
      actual: "Duplicate",
    };
    const capture = { schemaVersion: "UiAssertionCaptureV1", state: "complete" };
    const before = JSON.stringify(step);
    expect(Value.Check(UiStepExecutionEvidenceSchema, step)).toBe(true);
    expect(JSON.stringify(step)).toBe(before);
    expect("capture" in step).toBe(false);
    expect(Value.Check(UiStepExecutionEvidenceSchema, { ...step, capture })).toBe(true);
    expect(
      Value.Check(UiStepExecutionEvidenceSchema, {
        ...step,
        action: "click",
        actual: null,
        expected: null,
        capture,
      }),
    ).toBe(false);
    expect(Value.Check(UiStepExecutionEvidenceSchema, { ...step, capture: null })).toBe(false);
    expect(Value.Check(UiAssertionCaptureV1Schema, { ...capture, reason: "timeout" })).toBe(false);
    expect(
      Value.Check(UiAssertionCaptureV1Schema, {
        ...capture,
        state: "unavailable",
        reason: "timeout",
      }),
    ).toBe(true);
    expect(
      Value.Check(UiAssertionCaptureV1Schema, {
        ...capture,
        state: "unavailable",
        reason: "arbitrary",
      }),
    ).toBe(false);
  });
});
