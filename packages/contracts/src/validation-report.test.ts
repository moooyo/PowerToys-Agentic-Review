import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  IssueValidationReportV1Schema,
  maximumValidationCheckEvidenceReferences,
  PullRequestValidationReportV1Schema,
  type ValidationCheckResult,
  ValidationCheckResultSchema,
  ValidationObservationSchema,
  ValidationOutcomeSchema,
  type ValidationReportV1,
  ValidationReportV1Schema,
  type ValidationSummaryV1,
  ValidationSummaryV1Schema,
} from "./validation-report.js";

function check(overrides: Partial<ValidationCheckResult> = {}): ValidationCheckResult {
  return {
    id: "desktop-v1:launch",
    name: "Launch the application",
    kind: "ui",
    required: true,
    outcome: "passed",
    summary: "The main window shows the expected controls.",
    expected: "The main window exposes the settings button.",
    actual: "The settings button is visible and enabled.",
    evidenceIds: ["evidence:screenshot-1"],
    source: "runner",
    ...overrides,
  };
}

const prSummary: ValidationSummaryV1 = {
  schemaVersion: "ValidationSummaryV1",
  workItemKind: "pull_request",
  summary: "The implementation is consistent with the requested change.",
  recommendation: "approve",
  observations: [],
};

const issueSummary: ValidationSummaryV1 = {
  schemaVersion: "ValidationSummaryV1",
  workItemKind: "issue",
  summary: "The reported dialog failure was reproduced.",
  reproductionConclusion: "confirmed",
  observations: [],
};

function prReport(): ValidationReportV1 {
  return {
    schemaVersion: "ValidationReportV1",
    source: "worker",
    workItemKind: "pull_request",
    summary: "The configured desktop checks completed.",
    sourceState: "original",
    checks: [check()],
    modelSummary: prSummary,
  };
}

describe("validation result contracts", () => {
  it.each(["passed", "failed", "blocked", "not_run", "skipped", "inconclusive"])(
    "accepts the explicit %s outcome",
    (outcome) => expect(Value.Check(ValidationOutcomeSchema, outcome)).toBe(true),
  );

  it.each(["succeeded", "unknown", "approve", "", null])(
    "rejects execution state or advice as a validation outcome: %s",
    (outcome) => expect(Value.Check(ValidationOutcomeSchema, outcome)).toBe(false),
  );

  it("accepts runner checks and separately attributed model claims", () => {
    expect(Value.Check(ValidationCheckResultSchema, check())).toBe(true);
    expect(Value.Check(ValidationCheckResultSchema, check({ source: "model" }))).toBe(true);
  });

  it("retains every screenshot for a 32-step scenario together with steps and trace", () => {
    const evidenceIds = [
      ...Array.from({ length: 32 }, (_, index) => `screenshot:${index}`),
      "evidence:steps",
      "evidence:trace",
    ];
    expect(evidenceIds).toHaveLength(maximumValidationCheckEvidenceReferences);
    expect(Value.Check(ValidationCheckResultSchema, check({ evidenceIds }))).toBe(true);
  });

  it("accepts a bounded PR report without implying that the model approved the checks", () => {
    const report = { ...prReport(), checks: [check({ outcome: "failed" })] };
    expect(Value.Check(ValidationReportV1Schema, report)).toBe(true);
    expect(Value.Check(PullRequestValidationReportV1Schema, report)).toBe(true);
    expect(Value.Check(IssueValidationReportV1Schema, report)).toBe(false);
  });

  it("keeps an issue reproduction conclusion separate from the model's opinion", () => {
    const report = {
      ...prReport(),
      workItemKind: "issue",
      reproductionConclusion: "inconclusive",
      modelSummary: issueSummary,
    };
    expect(Value.Check(ValidationReportV1Schema, report)).toBe(true);
    expect(Value.Check(IssueValidationReportV1Schema, report)).toBe(true);
    expect(Value.Check(PullRequestValidationReportV1Schema, report)).toBe(false);
  });

  it("requires a distinct Worker conclusion for an issue report", () => {
    expect(
      Value.Check(ValidationReportV1Schema, {
        ...prReport(),
        workItemKind: "issue",
        modelSummary: issueSummary,
      }),
    ).toBe(false);
  });

  it("allows an empty-check blocked report to record unavailable infrastructure", () => {
    expect(
      Value.Check(ValidationReportV1Schema, {
        ...prReport(),
        sourceState: "unknown",
        checks: [],
        modelSummary: undefined,
      }),
    ).toBe(true);
  });

  it.each([
    { checks: [check()] },
    { source: "runner" },
    { sourceState: "original" },
    { evidenceComplete: true },
    { executionEvidence: { source: "worker", commands: [] } },
  ])("rejects injected execution authority in model output: %j", (injected) => {
    expect(Value.Check(ValidationSummaryV1Schema, { ...prSummary, ...injected })).toBe(false);
  });

  it("rejects execution authority smuggled through a model observation", () => {
    expect(
      Value.Check(ValidationSummaryV1Schema, {
        ...prSummary,
        observations: [
          {
            id: "observation-1",
            title: "Build",
            body: "Passed",
            priority: 2,
            path: null,
            line: null,
            source: "runner",
          },
        ],
      }),
    ).toBe(false);
  });

  it("does not interchange PR advice and issue reproduction", () => {
    expect(Value.Check(ValidationSummaryV1Schema, prSummary)).toBe(true);
    expect(Value.Check(ValidationSummaryV1Schema, issueSummary)).toBe(true);
    expect(
      Value.Check(ValidationSummaryV1Schema, { ...issueSummary, recommendation: "approve" }),
    ).toBe(false);
    expect(
      Value.Check(ValidationSummaryV1Schema, { ...prSummary, reproductionConclusion: "confirmed" }),
    ).toBe(false);
    expect(
      Value.Check(ValidationReportV1Schema, { ...prReport(), modelSummary: issueSummary }),
    ).toBe(false);
  });

  it.each([
    { source: "model" },
    { sourceState: "clean" },
    { recommendation: "approve" },
    { evidenceComplete: true },
    { checks: [check({ source: "runner" }), { ...check(), trusted: true }] },
  ])("rejects unsupported Worker report fields or states: %j", (overrides) => {
    expect(Value.Check(ValidationReportV1Schema, { ...prReport(), ...overrides })).toBe(false);
  });

  it.each([
    { id: "" },
    { id: `profile:${"x".repeat(250)}` },
    { name: "x".repeat(257) },
    { kind: "command" },
    { summary: "x".repeat(2_049) },
    { expected: "x".repeat(2_049) },
    { actual: "" },
    { source: "worker" },
    { evidenceIds: ["evidence:1", "evidence:1"] },
    {
      evidenceIds: Array.from(
        { length: maximumValidationCheckEvidenceReferences + 1 },
        (_, index) => `evidence:${index}`,
      ),
    },
  ])("bounds individual checks: %j", (overrides) => {
    expect(Value.Check(ValidationCheckResultSchema, { ...check(), ...overrides })).toBe(false);
  });

  it("bounds check counts and report text", () => {
    expect(
      Value.Check(ValidationReportV1Schema, {
        ...prReport(),
        checks: Array.from({ length: 161 }, (_, index) => check({ id: `check:${index}` })),
      }),
    ).toBe(false);
    expect(
      Value.Check(ValidationReportV1Schema, { ...prReport(), summary: "x".repeat(8_193) }),
    ).toBe(false);
  });

  it.each([
    "/src/file.ts",
    "C:/src/file.ts",
    "src\\file.ts",
    "../file.ts",
    "src/../file.ts",
    "src\u0000/file.ts",
  ])("rejects unsafe observation paths: %s", (path) => {
    expect(
      Value.Check(ValidationObservationSchema, {
        id: "finding:1",
        title: "Failure",
        body: "The assertion failed.",
        priority: 1,
        path,
        line: 10,
      }),
    ).toBe(false);
  });

  it("bounds observations and accepts a repository-relative source location", () => {
    const observation = {
      id: "finding:1",
      title: "Failure",
      body: "The assertion failed.",
      priority: 1,
      path: "src/app.ts",
      line: 10,
    };
    expect(Value.Check(ValidationObservationSchema, observation)).toBe(true);
    expect(Value.Check(ValidationObservationSchema, { ...observation, line: 0 })).toBe(false);
    expect(Value.Check(ValidationObservationSchema, { ...observation, priority: 4 })).toBe(false);
    expect(
      Value.Check(ValidationObservationSchema, { ...observation, body: "x".repeat(4_097) }),
    ).toBe(false);
    expect(
      Value.Check(ValidationSummaryV1Schema, {
        ...prSummary,
        observations: Array.from({ length: 101 }, (_, index) => ({
          ...observation,
          id: `finding:${index}`,
        })),
      }),
    ).toBe(false);
  });
});
