import {
  maximumRunCompletionResultUtf8Bytes,
  type ReviewExecutionEvidence,
  type ValidationSummaryV1,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { createCanonicalResult } from "./canonical-result.js";
import {
  type ValidationJobResultV1,
  ValidationJobResultV1Schema,
} from "./validation-job-results.js";
import {
  getValidationJobResultIssues,
  getValidationJobResultV2Issues,
  getValidationModelSummary,
  getValidationReviewModel,
  ValidationJobResultSchema,
  type ValidationJobResultV2,
  type ValidationJobResultV2ModelResult,
  ValidationJobResultV2RunnerReportSchema,
  ValidationJobResultV2Schema,
} from "./validation-job-results-v2.js";

// Synthetic raw outputs and metadata exercise format consistency, never execution acceptance.
const digest = (value: number) => value.toString(16).padStart(64, "0");
const evidence = (): ReviewExecutionEvidence => ({
  schemaVersion: "ReviewExecutionEvidenceV1",
  source: "worker",
  commandCapture: "complete",
  commands: [],
  worktree: { status: "clean", source: "git_status" },
});
const prModel = () => ({
  schemaVersion: "PrReviewPlanV2" as const,
  summary: "Synthetic PR review.",
  assessment: "comment" as const,
  findings: [
    {
      findingId: "finding-1",
      priority: 1,
      title: "Synthetic finding",
      body: "A bounded original observation.",
      path: "src/example.ts",
      line: 1,
      endLine: null,
      confidence: 0.8,
    },
  ],
  requestedRecipeIds: [],
  verification: {
    status: "not_run" as const,
    summary: "Model-declared verification only.",
    commands: [],
  },
});
const issueModel = () => ({
  schemaVersion: "IssueTriageV2" as const,
  summary: "Synthetic issue triage.",
  category: "bug" as const,
  priority: 1,
  confidence: 0.8,
  suggestedLabels: [],
  missingInformation: [],
  duplicateCandidates: [],
  requestedRecipeIds: [],
  verification: {
    status: "not_run" as const,
    summary: "Model-declared verification only.",
    commands: [],
  },
});
const summary = (kind: "pull_request" | "issue"): ValidationSummaryV1 =>
  kind === "pull_request"
    ? {
        schemaVersion: "ValidationSummaryV1",
        workItemKind: kind,
        summary: "Synthetic UI advice.",
        observations: [],
        recommendation: "needs_human_review",
      }
    : {
        schemaVersion: "ValidationSummaryV1",
        workItemKind: kind,
        summary: "Synthetic validation advice.",
        observations: [],
        reproductionConclusion: "inconclusive",
      };
function fixture(
  kind: "pr" | "issue" | "pr_summary" | "issue_summary" = "pr",
): ValidationJobResultV2 {
  const isIssue = kind.startsWith("issue");
  const result: ValidationJobResultV2ModelResult =
    kind === "pr"
      ? prModel()
      : kind === "issue"
        ? issueModel()
        : summary(isIssue ? "issue" : "pull_request");
  return {
    schemaVersion: "ValidationJobResultV2",
    report: {
      schemaVersion: "ValidationReportV1",
      source: "worker",
      summary: "Deterministic runner facts.",
      sourceState: "original",
      checks: [
        {
          id: "profile:build",
          name: "Build",
          kind: "build",
          required: true,
          outcome: "passed",
          summary: "The synthetic check completed.",
          expected: null,
          actual: null,
          evidenceIds: [],
          source: "runner",
        },
      ],
      ...(isIssue
        ? { workItemKind: "issue", reproductionConclusion: "inconclusive" }
        : { workItemKind: "pull_request" }),
    },
    execution: { blockers: [], diagnostics: [], cleanupState: "not_needed" },
    modelReview: {
      state: "completed",
      result,
      invocation: {
        invocationId: "invocation-1",
        scopeSha256: digest(1),
        receiptSetSha256: digest(2),
        modelOutputSha256: createCanonicalResult(result).sha256,
      },
      executionEvidence: evidence(),
    },
  } as ValidationJobResultV2;
}
function legacy(): ValidationJobResultV1 {
  return {
    schemaVersion: "ValidationJobResultV1",
    report: {
      schemaVersion: "ValidationReportV1",
      workItemKind: "pull_request",
      source: "worker",
      summary: "Historical runner facts.",
      sourceState: "original",
      checks: [],
    },
    execution: { blockers: [], diagnostics: [], cleanupState: "not_needed" },
    modelReview: { state: "completed", result: { ...prModel(), executionEvidence: evidence() } },
  };
}
type Completed = Extract<ValidationJobResultV2["modelReview"], { state: "completed" }>;
function completed(value: ValidationJobResultV2): Completed {
  if (value.modelReview.state !== "completed")
    throw new Error("The synthetic model result is absent.");
  return value.modelReview;
}
const rebind = (value: ValidationJobResultV2) => {
  const model = completed(value);
  model.invocation.modelOutputSha256 = createCanonicalResult(model.result).sha256;
};

describe("strict raw ValidationJobResultV2", () => {
  it.each(["pr", "issue", "pr_summary", "issue_summary"] as const)(
    "accepts the bounded %s raw output without rewriting it",
    (kind) => {
      const value = fixture(kind),
        before = createCanonicalResult(value);
      expect(Value.Check(ValidationJobResultV2Schema, value)).toBe(true);
      expect(Value.Check(ValidationJobResultSchema, value)).toBe(true);
      expect(getValidationJobResultV2Issues(value)).toEqual([]);
      expect(getValidationJobResultIssues(value)).toEqual([]);
      expect(createCanonicalResult(value)).toEqual(before);
      expect(completed(value).result).not.toHaveProperty("executionEvidence");
    },
  );
  it.each(["not_requested", "failed"] as const)(
    "keeps %s without invented output or invocation references",
    (state) => {
      const value = fixture();
      value.modelReview =
        state === "not_requested"
          ? { state }
          : {
              state,
              code: "MODEL_OUTPUT_UNAVAILABLE",
              message: "The model result was not available.",
            };
      expect(getValidationJobResultV2Issues(value)).toEqual([]);
      expect(getValidationModelSummary(value)).toBeNull();
      expect(getValidationReviewModel(value)).toBeNull();
      for (const field of ["result", "invocation", "executionEvidence"]) {
        expect(
          getValidationJobResultV2Issues({
            ...value,
            modelReview: {
              ...value.modelReview,
              [field]: completed(fixture())[field as keyof Completed],
            },
          }),
        ).not.toEqual([]);
      }
    },
  );
  it("rejects modelSummary even when it duplicates the single raw summary exactly", () => {
    const value = fixture("pr_summary");
    const badReport = { ...value.report, modelSummary: completed(value).result };
    expect(Value.Check(ValidationJobResultV2RunnerReportSchema, badReport)).toBe(false);
    expect(getValidationJobResultV2Issues({ ...value, report: badReport })).not.toEqual([]);
  });
  it("rejects enriched model content instead of stripping worker evidence before hashing", () => {
    const value = fixture();
    Object.assign(completed(value).result, { executionEvidence: evidence() });
    rebind(value);
    expect(Value.Check(ValidationJobResultV2Schema, value)).toBe(false);
    expect(getValidationJobResultV2Issues(value)).not.toEqual([]);
  });
  it.each(["pull_request", "issue"] as const)(
    "rejects a raw model result for another %s report kind",
    (kind) => {
      const value = fixture(kind === "pull_request" ? "pr" : "issue");
      completed(value).result = kind === "pull_request" ? issueModel() : prModel();
      rebind(value);
      expect(getValidationJobResultV2Issues(value)).not.toEqual([]);
      completed(value).result = summary(kind === "pull_request" ? "issue" : "pull_request");
      rebind(value);
      expect(getValidationJobResultV2Issues(value)).not.toEqual([]);
    },
  );
  it("rejects model-sourced checks inside the worker report", () => {
    const value = fixture();
    const check = value.report.checks[0];
    if (!check) throw new Error("The synthetic check is absent.");
    check.source = "model";
    expect(getValidationJobResultV2Issues(value)).toContain(
      "ValidationJobResultV2 report checks must contain only runner observations.",
    );
  });
  it.each(["invocationId", "scopeSha256", "receiptSetSha256", "modelOutputSha256"] as const)(
    "requires an exact nonnull %s reference",
    (field) => {
      const value = fixture();
      for (const replacement of [
        null,
        "",
        "bad value",
        `${completed(value).invocation[field]}\n`,
      ]) {
        expect(
          getValidationJobResultV2Issues({
            ...value,
            modelReview: {
              ...completed(value),
              invocation: { ...completed(value).invocation, [field]: replacement },
            },
          }),
        ).not.toEqual([]);
      }
    },
  );
  it("binds the actual raw payload rather than evidence or a supplied second hash", () => {
    const value = fixture();
    completed(value).result.summary = "Changed raw text.";
    expect(getValidationJobResultV2Issues(value)).toContain(
      "The raw model result must match the referenced canonical model output digest.",
    );
    rebind(value);
    expect(getValidationJobResultV2Issues(value)).toEqual([]);
    const original = completed(value).invocation.modelOutputSha256;
    completed(value).executionEvidence.worktree = { status: "unknown", source: "not_observed" };
    expect(getValidationJobResultV2Issues(value)).toEqual([]);
    expect(completed(value).invocation.modelOutputSha256).toBe(original);
    expect(
      getValidationJobResultV2Issues({ ...value, rawSha256: original, enrichedSha256: digest(3) }),
    ).not.toEqual([]);
  });
  it("leaves independent scope and receipt authentication to the owner", () => {
    const value = fixture();
    completed(value).invocation.scopeSha256 = digest(99);
    completed(value).invocation.receiptSetSha256 = digest(98);
    expect(getValidationJobResultV2Issues(value)).toEqual([]);
    expect(getValidationJobResultV2Issues({ ...value, executionAccepted: true })).not.toEqual([]);
  });
  it.each([
    { state: "failed", code: "lowercase", message: "Failure." },
    { state: "failed", code: "BAD\n", message: "Failure." },
    { state: "failed", code: "MODEL_FAILED", message: "x".repeat(2049) },
    { state: "failed", code: "MODEL_FAILED", message: "" },
  ])("rejects malformed failed state %j", (modelReview) => {
    expect(getValidationJobResultV2Issues({ ...fixture(), modelReview })).not.toEqual([]);
  });
});

describe("V1 compatibility and pure selectors", () => {
  it("retains the original V1 Value.Check path and enriched object unchanged", () => {
    const value = legacy(),
      before = JSON.stringify(value);
    expect(Value.Check(ValidationJobResultV1Schema, value)).toBe(true);
    expect(getValidationJobResultIssues(value)).toEqual([]);
    expect(getValidationReviewModel(value)).toBe(
      value.modelReview.state === "completed" ? value.modelReview.result : null,
    );
    expect(getValidationReviewModel(value)).toHaveProperty("executionEvidence");
    expect(JSON.stringify(value)).toBe(before);
    expect(getValidationJobResultV2Issues(value)).not.toEqual([]);
  });
  it("keeps historical V1 summary selection and does not impose new Unicode or byte checks", () => {
    const value = legacy();
    const modelSummary = summary("pull_request");
    if (
      value.report.workItemKind !== "pull_request" ||
      modelSummary.workItemKind !== "pull_request"
    )
      throw new Error("The fixture kind is inconsistent.");
    value.report.modelSummary = modelSummary;
    value.report.summary = "\ud800";
    expect(Value.Check(ValidationJobResultV1Schema, value)).toBe(true);
    expect(getValidationJobResultIssues(value)).toEqual([]);
    expect(getValidationModelSummary(value)).toBe(modelSummary);
  });
  it.each(["pr", "issue"] as const)(
    "returns the exact V2 %s raw reference without evidence enrichment",
    (kind) => {
      const value = fixture(kind);
      expect(getValidationReviewModel(value)).toBe(completed(value).result);
      expect(getValidationReviewModel(value)).not.toHaveProperty("executionEvidence");
      expect(getValidationModelSummary(value)).toBeNull();
    },
  );
  it.each(["pr_summary", "issue_summary"] as const)(
    "returns the exact %s summary and no fabricated review",
    (kind) => {
      const value = fixture(kind);
      expect(getValidationModelSummary(value)).toBe(completed(value).result);
      expect(getValidationReviewModel(value)).toBeNull();
    },
  );
  it.each([null, undefined, {}, { schemaVersion: "ValidationJobResultV3" }])(
    "rejects unsupported wrapper %j",
    (value) => {
      expect(getValidationJobResultIssues(value)).not.toEqual([]);
    },
  );
});

describe("strict JSON without executing accessors", () => {
  it.each(["schemaVersion", "result", "array", "array_prototype"] as const)(
    "rejects %s getters before invoking them",
    (location) => {
      const value = fixture();
      let calls = 0;
      const get = () => {
        calls++;
        throw new Error("A getter must not execute.");
      };
      if (location === "schemaVersion")
        Object.defineProperty(value, "schemaVersion", { enumerable: true, get });
      if (location === "result")
        Object.defineProperty(completed(value), "result", { enumerable: true, get });
      if (location === "array")
        Object.defineProperty(value.report.checks, "0", { enumerable: true, get });
      if (location === "array_prototype") {
        const prototype = Object.create(Array.prototype);
        Object.defineProperty(prototype, "toJSON", { get });
        Object.setPrototypeOf(value.report.checks, prototype);
      }
      expect(getValidationJobResultV2Issues(value)).not.toEqual([]);
      expect(getValidationJobResultIssues(value)).not.toEqual([]);
      expect(calls).toBe(0);
    },
  );
  it("rejects Proxy inputs without reading traps", () => {
    let calls = 0;
    const value = new Proxy(fixture(), {
      getOwnPropertyDescriptor() {
        calls++;
        throw new Error("A proxy trap must not execute.");
      },
    });
    expect(getValidationJobResultIssues(value)).not.toEqual([]);
    expect(getValidationJobResultV2Issues(value)).not.toEqual([]);
    expect(calls).toBe(0);
  });
  it.each(["\ud800", "\udfff"])("rejects malformed Unicode %s", (text) => {
    const value = fixture();
    completed(value).result.summary = text;
    expect(getValidationJobResultV2Issues(value)).not.toEqual([]);
    expect(getValidationJobResultV2Issues({ ...fixture(), [text]: true })).not.toEqual([]);
  });
  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, () => null])(
    "rejects non-JSON property %s",
    (extra) => {
      expect(getValidationJobResultV2Issues({ ...fixture(), extra })).not.toEqual([]);
    },
  );
  it("rejects sparse/decorated arrays, hidden fields, symbols and cycles", () => {
    const sparse = fixture();
    sparse.report.checks.length = 2;
    expect(getValidationJobResultV2Issues(sparse)).not.toEqual([]);
    const decorated = fixture();
    Object.assign(decorated.report.checks, { extra: true });
    expect(getValidationJobResultV2Issues(decorated)).not.toEqual([]);
    const hidden = fixture();
    Object.defineProperty(hidden, "hidden", { value: true });
    expect(getValidationJobResultV2Issues(hidden)).not.toEqual([]);
    expect(getValidationJobResultV2Issues({ ...fixture(), [Symbol("hidden")]: true })).not.toEqual(
      [],
    );
    const cycle = { ...fixture(), extra: {} };
    cycle.extra = cycle;
    expect(getValidationJobResultV2Issues(cycle)).not.toEqual([]);
  });
});

describe("complete canonical result byte budget", () => {
  function atLimit(): ValidationJobResultV2 {
    const value = fixture();
    const model = completed(value).result;
    if (model.schemaVersion !== "PrReviewPlanV2")
      throw new Error("The fixture requires a PR model result.");
    model.findings = Array.from({ length: 100 }, (_, index) => ({
      findingId: `finding-${index}`,
      priority: 1,
      title: "Synthetic finding",
      body: "x",
      path: "src/example.ts",
      line: 1,
      endLine: null,
      confidence: 0.8,
    }));
    let remaining =
      maximumRunCompletionResultUtf8Bytes -
      Buffer.byteLength(createCanonicalResult(value).json, "utf8");
    for (const finding of model.findings) {
      const capacity = 8192 - finding.body.length;
      const multi = Math.min(capacity, Math.floor(remaining / 3));
      remaining -= multi * 3;
      const ascii = Math.min(capacity - multi, remaining);
      remaining -= ascii;
      finding.body += "界".repeat(multi) + "x".repeat(ascii);
    }
    if (remaining !== 0) throw new Error("The bounded fixture cannot fill the aggregate limit.");
    rebind(value);
    return value;
  }
  it("accepts exactly two MiB including raw output, evidence, report and references", () => {
    const value = atLimit();
    expect(Buffer.byteLength(createCanonicalResult(value).json, "utf8")).toBe(
      maximumRunCompletionResultUtf8Bytes,
    );
    expect(getValidationJobResultV2Issues(value)).toEqual([]);
  });
  it("rejects one extra evidence byte without truncating otherwise valid raw output", () => {
    const value = atLimit();
    value.report.summary += "x";
    expect(Value.Check(ValidationJobResultV2Schema, value)).toBe(true);
    expect(Buffer.byteLength(createCanonicalResult(value).json, "utf8")).toBe(
      maximumRunCompletionResultUtf8Bytes + 1,
    );
    expect(getValidationJobResultV2Issues(value)).toContain(
      "The complete ValidationJobResultV2 exceeds the terminal result UTF-8 byte limit.",
    );
  });
  it("does not apply the new aggregate validator to historical V1", () => {
    const value = legacy();
    if (
      value.modelReview.state !== "completed" ||
      value.modelReview.result.schemaVersion !== "PrReviewPlanV2"
    )
      throw new Error("The fixture requires a PR result.");
    const finding = prModel().findings[0];
    if (finding === undefined) throw new Error("The synthetic finding is absent.");
    value.modelReview.result.findings = Array.from({ length: 100 }, (_, index) => ({
      ...finding,
      findingId: `finding-${index}`,
      body: "界".repeat(8192),
    }));
    expect(Buffer.byteLength(createCanonicalResult(value).json, "utf8")).toBeGreaterThan(
      maximumRunCompletionResultUtf8Bytes,
    );
    expect(Value.Check(ValidationJobResultV1Schema, value)).toBe(true);
    expect(getValidationJobResultIssues(value)).toEqual([]);
  });
});
