import type {
  ValidationCheckResult,
  ValidationOutcome,
  ValidationReportV1,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";

import {
  evaluateValidationApproval,
  type ValidationApprovalInput,
  type ValidationApprovalReport,
} from "./validation-policy.js";

const revision = `${"a".repeat(40)}:${"b".repeat(40)}`;
const planDigest = "c".repeat(64);

function check(id: string, overrides: Partial<ValidationCheckResult> = {}): ValidationCheckResult {
  return {
    id,
    name: id,
    kind: "test",
    required: true,
    outcome: "passed",
    summary: "The configured assertion passed.",
    expected: "The expected value is visible.",
    actual: "The expected value is visible.",
    evidenceIds: [`evidence:${id}`],
    source: "runner",
    ...overrides,
  };
}

function report(
  checks: ValidationCheckResult[],
  overrides: Partial<ValidationApprovalReport> = {},
): ValidationApprovalReport {
  return {
    revisionKey: revision,
    planDigest,
    evidenceComplete: true,
    report: {
      schemaVersion: "ValidationReportV1",
      source: "worker",
      workItemKind: "pull_request",
      summary: "Validation completed.",
      sourceState: "original",
      checks,
      modelSummary: {
        schemaVersion: "ValidationSummaryV1",
        workItemKind: "pull_request",
        summary: "No blocking findings were identified.",
        recommendation: "approve",
        observations: [],
      },
    },
    ...overrides,
  };
}

function input(overrides: Partial<ValidationApprovalInput> = {}): ValidationApprovalInput {
  return {
    currentRevisionKey: revision,
    expectedExecutionPlanDigest: planDigest,
    requiredCheckIds: ["static-v1:compile", "desktop-v1:settings", "web-v1:login"],
    reports: [
      report([check("static-v1:compile", { kind: "build" })]),
      report([check("desktop-v1:settings", { kind: "ui" })]),
      report([check("web-v1:login", { kind: "ui" })]),
    ],
    blockingFindingIds: [],
    requiredRequestBlockers: [],
    ...overrides,
  };
}

function oneCheck(outcome: ValidationOutcome = "passed"): ValidationApprovalInput {
  return input({
    requiredCheckIds: ["static-v1:compile"],
    reports: [report([check("static-v1:compile", { outcome })])],
  });
}

describe("validation approval policy", () => {
  it("blocks missing required profiles and lifecycle failures even when existing checks passed", () => {
    const result = evaluateValidationApproval(
      input({
        requiredRequestBlockers: [
          { requestId: "ui", reason: "missing_scenarios" },
          { requestId: "static", reason: "required_cleanup_failed" },
        ],
      }),
    );
    expect(result).toEqual({
      eligible: false,
      reasons: [
        { code: "required_request_blocked", requestId: "ui", reason: "missing_scenarios" },
        {
          code: "required_request_blocked",
          requestId: "static",
          reason: "required_cleanup_failed",
        },
      ],
    });
  });
  it("accepts complete, original, current-revision static, Windows, and Web checks", () => {
    expect(evaluateValidationApproval(input())).toEqual({ eligible: true, reasons: [] });
  });

  it("does not require a model approval when the frozen check and finding policy is satisfied", () => {
    const record = report([check("static-v1:compile")]);
    delete record.report.modelSummary;
    expect(
      evaluateValidationApproval(
        input({ requiredCheckIds: ["static-v1:compile"], reports: [record] }),
      ).eligible,
    ).toBe(true);
  });

  it("cannot convert a valid model approve report without checks into eligibility", () => {
    const result = evaluateValidationApproval(input({ reports: [report([])] }));
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([
      { code: "missing_required_check", checkId: "static-v1:compile" },
      { code: "missing_required_check", checkId: "desktop-v1:settings" },
      { code: "missing_required_check", checkId: "web-v1:login" },
    ]);
  });

  it("detects missing required UI coverage from the plan, even when it is absent from the report", () => {
    const result = evaluateValidationApproval(
      input({ reports: [report([check("static-v1:compile")])] }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContainEqual({
      code: "missing_required_check",
      checkId: "desktop-v1:settings",
    });
    expect(result.reasons).toContainEqual({
      code: "missing_required_check",
      checkId: "web-v1:login",
    });
  });

  it("does not allow a report to weaken a required plan check", () => {
    const result = evaluateValidationApproval(
      input({
        requiredCheckIds: ["static-v1:compile"],
        reports: [report([check("static-v1:compile", { required: false, outcome: "failed" })])],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContainEqual({
      code: "required_check_not_passed",
      checkId: "static-v1:compile",
      reportIndex: 0,
      outcome: "failed",
    });
  });

  it.each<ValidationOutcome>(["failed", "blocked", "not_run", "skipped", "inconclusive"])(
    "prevents approval for a required %s check even when the model recommends approve",
    (outcome) => {
      expect(evaluateValidationApproval(oneCheck(outcome))).toEqual({
        eligible: false,
        reasons: [
          {
            code: "required_check_not_passed",
            checkId: "static-v1:compile",
            reportIndex: 0,
            outcome,
          },
        ],
      });
    },
  );

  it("does not count a model's passed claim as runner evidence", () => {
    const result = evaluateValidationApproval(
      input({
        requiredCheckIds: ["static-v1:compile"],
        reports: [report([check("static-v1:compile", { source: "model" })])],
      }),
    );
    expect(result).toEqual({
      eligible: false,
      reasons: [
        { code: "required_check_not_runner", checkId: "static-v1:compile", reportIndex: 0 },
      ],
    });
  });

  it("does not combine an old UI success with current build results", () => {
    const baseline = input();
    const result = evaluateValidationApproval({
      ...baseline,
      reports: baseline.reports.map((entry, index) =>
        index === 1 ? { ...entry, revisionKey: `${"a".repeat(40)}:${"d".repeat(40)}` } : entry,
      ),
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContainEqual({ code: "stale_revision", reportIndex: 1 });
  });

  it("compares the complete revision key, including a changed base with the same head", () => {
    const baseline = oneCheck();
    const result = evaluateValidationApproval({
      ...baseline,
      currentRevisionKey: `${"d".repeat(40)}:${"b".repeat(40)}`,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContainEqual({ code: "stale_revision", reportIndex: 0 });
  });

  it("does not combine reports from different execution plans on the same revision", () => {
    const result = evaluateValidationApproval(
      input({
        requiredCheckIds: ["static-v1:compile"],
        reports: [report([check("static-v1:compile")], { planDigest: "e".repeat(64) })],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContainEqual({ code: "execution_plan_mismatch", reportIndex: 0 });
  });

  it.each(["modified", "unknown"] as const)("rejects passed checks on %s source", (sourceState) => {
    const record = report([check("static-v1:compile")]);
    const result = evaluateValidationApproval(
      input({
        requiredCheckIds: ["static-v1:compile"],
        reports: [{ ...record, report: { ...record.report, sourceState } }],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContainEqual({
      code: sourceState === "modified" ? "source_modified" : "source_unknown",
      reportIndex: 0,
    });
  });

  it("requires finalized evidence from the same execution record", () => {
    const result = evaluateValidationApproval(
      input({
        requiredCheckIds: ["static-v1:compile", "web-v1:login"],
        reports: [
          report([check("static-v1:compile")], { evidenceComplete: false }),
          report([check("web-v1:login")]),
        ],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContainEqual({ code: "incomplete_evidence", reportIndex: 0 });
  });

  it("keeps infrastructure blockage distinct from completed validation", () => {
    const result = evaluateValidationApproval(
      input({
        requiredCheckIds: ["desktop-v1:settings"],
        reports: [
          report(
            [
              check("desktop-v1:settings", {
                kind: "ui",
                outcome: "blocked",
                summary: "No interactive desktop is available.",
              }),
            ],
            { evidenceComplete: false },
          ),
        ],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContainEqual({
      code: "required_check_not_passed",
      checkId: "desktop-v1:settings",
      reportIndex: 0,
      outcome: "blocked",
    });
    expect(result.reasons).toContainEqual({ code: "incomplete_evidence", reportIndex: 0 });
  });

  it.each([true, false])(
    "does not resolve duplicate attempts by array order: success first=%s",
    (successFirst) => {
      const records = [
        report([check("static-v1:compile")]),
        report([check("static-v1:compile", { outcome: "failed" })]),
      ];
      const result = evaluateValidationApproval(
        input({
          requiredCheckIds: ["static-v1:compile"],
          reports: successFirst ? records : records.toReversed(),
        }),
      );
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContainEqual({
        code: "duplicate_check_id",
        checkId: "static-v1:compile",
        reportIndex: 1,
      });
    },
  );

  it("rejects duplicate IDs within one report, even if both claim passed", () => {
    const result = evaluateValidationApproval(
      input({
        requiredCheckIds: ["static-v1:compile"],
        reports: [report([check("static-v1:compile"), check("static-v1:compile")])],
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContainEqual({
      code: "duplicate_check_id",
      checkId: "static-v1:compile",
      reportIndex: 0,
    });
  });

  it("does not interpret optional failed checks as required coverage failures", () => {
    const result = evaluateValidationApproval(
      input({
        requiredCheckIds: ["static-v1:compile"],
        reports: [
          report([
            check("static-v1:compile"),
            check("web-v1:exploratory", { required: false, outcome: "failed" }),
          ]),
        ],
      }),
    );
    expect(result).toEqual({ eligible: true, reasons: [] });
  });

  it("prevents approval when the selected policy has unresolved blocking findings", () => {
    expect(evaluateValidationApproval(input({ blockingFindingIds: ["finding-1"] }))).toEqual({
      eligible: false,
      reasons: [{ code: "blocking_findings" }],
    });
  });

  it("does not provide PR approval semantics for an issue reproduction report", () => {
    const record = report([check("static-v1:compile")]);
    const issue: ValidationReportV1 = {
      schemaVersion: "ValidationReportV1",
      source: "worker",
      workItemKind: "issue",
      summary: "The defect was not reproduced.",
      sourceState: "original",
      checks: record.report.checks,
      reproductionConclusion: "not_reproduced",
    };
    expect(
      evaluateValidationApproval(
        input({ requiredCheckIds: ["static-v1:compile"], reports: [{ ...record, report: issue }] }),
      ),
    ).toEqual({ eligible: false, reasons: [{ code: "not_pull_request", reportIndex: 0 }] });
  });

  it.each([
    { requiredCheckIds: [], code: "no_required_checks" },
    {
      requiredCheckIds: ["static-v1:compile", "static-v1:compile"],
      code: "duplicate_required_check_id",
    },
    { requiredCheckIds: [""], code: "invalid_required_check_id" },
  ])("fails closed on an invalid required plan: $code", ({ requiredCheckIds, code }) => {
    const result = evaluateValidationApproval(input({ requiredCheckIds }));
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((reason) => reason.code === code)).toBe(true);
  });

  it("fails closed on an absent revision or malformed plan digest", () => {
    const result = evaluateValidationApproval(
      input({ currentRevisionKey: " ", expectedExecutionPlanDigest: "plan" }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContainEqual({ code: "invalid_revision" });
    expect(result.reasons).toContainEqual({ code: "invalid_plan_digest" });
  });

  it("does not let a human override rewrite checks or standard eligibility", () => {
    const baseline = oneCheck("failed");
    const withDecision = {
      ...baseline,
      humanOverride: { decision: "approve", reason: "Accepted by the operator." },
    };
    const before = structuredClone(withDecision);
    Object.freeze(withDecision);
    const result = evaluateValidationApproval(withDecision);
    expect(result).toEqual(evaluateValidationApproval(baseline));
    expect(result.eligible).toBe(false);
    expect(withDecision).toEqual(before);
    expect(withDecision.reports[0]?.report.checks[0]?.outcome).toBe("failed");
  });
});
