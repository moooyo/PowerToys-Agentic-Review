import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, describe, expect, it } from "vitest";
import {
  type EvaluationCellResultReadQuery,
  type EvaluationCellResultV1,
  EvaluationCellResultV1Schema,
  getEvaluationCellResultIssues,
  getEvaluationCellResultReadQueryIssues,
  maximumEvaluationCellResultUtf8Bytes,
} from "./evaluation-results.js";
import { maximumFindingResultOccurrenceCount } from "./finding-dispositions.js";

const now = "2026-09-08T01:00:00.000Z";
const digest = "a".repeat(64);
const originalDateTime = FormatRegistry.Get("date-time");
afterAll(() => {
  if (originalDateTime === undefined) FormatRegistry.Delete("date-time");
  else FormatRegistry.Set("date-time", originalDateTime);
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("The fixture entry is missing.");
  return value;
}

function query(): EvaluationCellResultReadQuery {
  return {
    repositoryId: "repository-1",
    evaluationId: "evaluation-1",
    cellId: "cell:baseline:case-1",
    resultId: "result-1",
  };
}

function result(): EvaluationCellResultV1 {
  const value: EvaluationCellResultV1 = {
    schemaVersion: "EvaluationCellResultV1",
    ...query(),
    caseId: "case-1",
    runId: "run-1",
    requestId: "request-1",
    jobId: "job-1",
    runAttemptId: "attempt-1",
    workItemId: "work-item-1",
    sourceId: "source-1",
    profileVersionId: "profile:baseline:v1",
    promptVersionId: "prompt:baseline:v1",
    arm: "baseline",
    trial: 1,
    resultDigest: digest,
    sourceDigest: "b".repeat(64),
    revisionKey: "c".repeat(64),
    planDigest: "d".repeat(64),
    executionDigest: "e".repeat(64),
    workflowKind: "pr_static_build",
    target: "headless",
    createdAt: now,
    modelRequirements: { required: true },
    evidenceComplete: true,
    report: {
      schemaVersion: "ValidationReportV1",
      workItemKind: "pull_request",
      source: "worker",
      summary: "The frozen source was checked.",
      sourceState: "original",
      checks: [
        {
          id: "profile:baseline:v1:build",
          name: "Compile the original source",
          kind: "build",
          required: true,
          outcome: "failed",
          summary: "The original source did not compile.",
          expected: "The compiler succeeds.",
          actual: "The compiler returned an error.",
          evidenceIds: ["evidence-1"],
          source: "runner",
        },
      ],
    },
    execution: {
      blockers: [],
      diagnostics: [
        {
          stepId: "profile:baseline:v1:build",
          phase: "build",
          outcome: "failed",
          exitCode: 1,
          summary: "Compilation failed.",
          stdout: "Compiler output.",
          stderr: "The required symbol is absent.",
        },
      ],
      cleanupState: "completed",
    },
    modelReview: {
      state: "completed",
      execution: {
        schemaVersion: "CliModelExecutionV1",
        jobId: "job-1",
        runAttemptId: "attempt-1",
        cli: { kind: "codex", version: "1.0.0", requestedModel: null },
        promptSha256: digest,
        outputSchemaSha256: digest,
        outputSha256: digest,
        exitCode: 0,
      },
      summary: "The model identified two findings and two observations.",
      recommendation: "request_changes",
      findings: Array.from({ length: 2 }, (_, ordinal) => ({
        findingId: `finding-${ordinal}`,
        ordinal,
        priority: ordinal === 0 ? 2 : 0,
        title: `Finding ${ordinal}`,
        body: "The finding retains its original position.",
        path: "src/example.ts",
        line: ordinal + 1,
        endLine: null,
        confidence: 0.8,
      })),
      observations: Array.from({ length: 2 }, (_, ordinal) => ({
        id: `observation-${ordinal}`,
        priority: ordinal === 0 ? 3 : 1,
        title: `Observation ${ordinal}`,
        body: "The observation retains its original position.",
        path: null,
        line: null,
      })),
      issueTriage: null,
      reproductionConclusion: null,
      error: null,
    },
    occurrences: [],
  };
  replaceOccurrences(value);
  return value;
}

function replaceOccurrences(value: EvaluationCellResultV1): void {
  const identities = [
    ...value.modelReview.findings.map((_finding, ordinal) => ({
      kind: "pr_finding" as const,
      ordinal,
    })),
    ...value.modelReview.observations.map((_observation, ordinal) => ({
      kind: "validation_observation" as const,
      ordinal,
    })),
  ];
  value.occurrences = identities.map((identity, index) => ({
    ...identity,
    key: (index + 1).toString(16).padStart(64, "0"),
    resultId: value.resultId,
    resultDigest: value.resultDigest,
  }));
}

function atByteLimit(): EvaluationCellResultV1 {
  const value = result();
  value.execution.diagnostics = Array.from({ length: 192 }, (_, index) => ({
    stepId: `profile:baseline:v1:step-${index}`,
    phase: "test",
    outcome: "passed",
    exitCode: 0,
    summary: "Captured output.",
    stdout: "",
  }));
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  let remaining = maximumEvaluationCellResultUtf8Bytes - bytes;
  for (const diagnostic of value.execution.diagnostics) {
    const multibyteCount = Math.min(4096, Math.floor(remaining / 3));
    diagnostic.stdout = "雪".repeat(multibyteCount);
    remaining -= multibyteCount * 3;
    const asciiCount = Math.min(4096 - multibyteCount, remaining);
    diagnostic.stdout += "x".repeat(asciiCount);
    remaining -= asciiCount;
  }
  if (remaining !== 0) throw new Error("The fixture could not fill the aggregate byte budget.");
  return value;
}

describe("evaluation cell result read scope", () => {
  it("requires all four exact selection identities without mutation", () => {
    const value = query();
    const original = structuredClone(value);
    expect(getEvaluationCellResultReadQueryIssues(value)).toEqual([]);
    expect(value).toEqual(original);
    for (const field of Object.keys(value)) {
      const omitted: Record<string, unknown> = { ...value };
      delete omitted[field];
      expect(getEvaluationCellResultReadQueryIssues(omitted).length, field).toBeGreaterThan(0);
    }
  });

  it.each(["repositoryId", "evaluationId", "cellId", "resultId"] as const)(
    "rejects ambiguous or transformed %s values",
    (field) => {
      for (const invalid of [
        "",
        "x".repeat(129),
        " id",
        "id ",
        "id\n",
        "id\u007f",
        "../id",
        "owner/repository",
        "id-1,id-2",
        1,
        null,
        ["id"],
      ])
        expect(
          getEvaluationCellResultReadQueryIssues({ ...query(), [field]: invalid }).length,
        ).toBeGreaterThan(0);
    },
  );

  it("rejects extra query selectors that would weaken the explicit cell/result scope", () => {
    for (const extra of [
      { jobId: "job-1" },
      { latest: true },
      { reviewRunId: "run-1" },
      { repositoryId: undefined },
      { page: 1 },
    ])
      expect(
        getEvaluationCellResultReadQueryIssues({ ...query(), ...extra }).length,
      ).toBeGreaterThan(0);
  });
});

describe("evaluation cell result projection", () => {
  it.each(["jobId", "runAttemptId"] as const)(
    "rejects CLI execution from a different %s",
    (field) => {
      const value = result();
      if (value.modelReview.execution === null) throw new Error("The CLI execution is absent.");
      value.modelReview.execution[field] = `another-${field}`;
      expect(Value.Check(EvaluationCellResultV1Schema, value)).toBe(true);
      expect(getEvaluationCellResultIssues(value)).toContain(
        "CLI execution must belong to the evaluation result's exact job and run attempt.",
      );
    },
  );

  it("retains immutable evaluation identities, raw findings, and diagnostics in both arms", () => {
    for (const arm of ["baseline", "candidate"] as const) {
      const value = { ...result(), arm };
      const original = structuredClone(value);
      expect(getEvaluationCellResultIssues(value)).toEqual([]);
      expect(Value.Check(EvaluationCellResultV1Schema, value)).toBe(true);
      expect(value).toEqual(original);
    }
  });

  it("uses the established workflow/target pairs and the report's actual work item kind", () => {
    for (const [workflowKind, targets] of [
      ["pr_static_build", ["headless"]],
      ["pr_ui", ["windows_desktop", "web"]],
      ["issue_triage", ["headless"]],
      ["issue_validation", ["headless", "windows_desktop", "web"]],
    ] as const) {
      for (const target of targets) {
        const value = result();
        value.workflowKind = workflowKind;
        value.target = target;
        if (workflowKind.startsWith("issue_"))
          value.report = {
            ...value.report,
            workItemKind: "issue",
            reproductionConclusion: "inconclusive",
          };
        expect(getEvaluationCellResultIssues(value), `${workflowKind}/${target}`).toEqual([]);
      }
    }
    for (const patch of [
      { workflowKind: "pr_ui" },
      { target: "web" },
      { workflowKind: "issue_triage" },
      { workflowKind: "issue_validation" },
    ])
      expect(getEvaluationCellResultIssues({ ...result(), ...patch }).length).toBeGreaterThan(0);
  });

  it("does not duplicate the normalized model summary inside the worker report", () => {
    const value = result();
    value.report = {
      ...value.report,
      workItemKind: "pull_request",
      modelSummary: {
        schemaVersion: "ValidationSummaryV1",
        workItemKind: "pull_request",
        summary: "A duplicated normalized summary.",
        recommendation: "comment",
        observations: value.modelReview.observations,
      },
    };
    expect(Value.Check(EvaluationCellResultV1Schema, value)).toBe(true);
    expect(getEvaluationCellResultIssues(value).join(" ")).toMatch(/duplicated/u);
  });

  it("preserves not-requested and failed model diagnostics without inferring applicability", () => {
    for (const state of ["not_requested", "failed"] as const) {
      for (const modelRequired of [true, false]) {
        const value = result();
        value.modelReview.state = state;
        value.modelReview.execution = null;
        value.modelReview.error =
          state === "failed"
            ? { code: "MODEL_UNAVAILABLE", message: "The model could not finish." }
            : null;
        value.modelRequirements.required = modelRequired;
        const original = structuredClone(value);
        expect(getEvaluationCellResultIssues(value)).toEqual([]);
        expect(value).toEqual(original);
        value.modelReview.findings = [];
        value.modelReview.observations = [];
        replaceOccurrences(value);
        expect(getEvaluationCellResultIssues(value)).toEqual([]);
      }
    }
    expect(
      getEvaluationCellResultIssues({ ...result(), applicability: "not_applicable" }).length,
    ).toBeGreaterThan(0);
  });

  it("keeps verification pending explicit and accepts only the literal true marker", () => {
    const value = { ...result(), evidenceComplete: false, evidenceVerificationPending: true };
    expect(getEvaluationCellResultIssues(value)).toEqual([]);
    expect(getEvaluationCellResultIssues({ ...value, evidenceComplete: true }).join(" ")).toMatch(
      /cannot be complete while verification is pending/u,
    );
    for (const evidenceVerificationPending of [false, "true", 1, null, undefined])
      expect(
        getEvaluationCellResultIssues({ ...value, evidenceVerificationPending }).length,
      ).toBeGreaterThan(0);
  });

  it.each([
    "authoritative",
    "requestEpochId",
    "activationNumber",
    "approvalEligibility",
    "policy",
    "reproduction",
    "probeReceipts",
    "upstreamMutationPolicy",
  ])("excludes ordinary review authority or action fields: %s", (field) => {
    expect(getEvaluationCellResultIssues({ ...result(), [field]: true }).length).toBeGreaterThan(0);
  });

  it("rejects malformed digests, missing identities, and undeclared trials", () => {
    const value = result();
    for (const [field, entry] of Object.entries(value)) {
      if (!field.endsWith("Id")) continue;
      for (const invalid of [undefined, null, [entry], `${entry}\n`, ` ${entry}`])
        expect(
          getEvaluationCellResultIssues({ ...value, [field]: invalid }).length,
          field,
        ).toBeGreaterThan(0);
    }
    for (const field of [
      "resultDigest",
      "sourceDigest",
      "revisionKey",
      "planDigest",
      "executionDigest",
    ])
      for (const invalid of ["a".repeat(63), "A".repeat(64), "g".repeat(64), null])
        expect(
          getEvaluationCellResultIssues({ ...value, [field]: invalid }).length,
          field,
        ).toBeGreaterThan(0);
    for (const patch of [
      { trial: 2 },
      { arm: "best_attempt" },
      { schemaVersion: "EvaluationCellResultV2" },
    ])
      expect(getEvaluationCellResultIssues({ ...value, ...patch }).length).toBeGreaterThan(0);
  });
});

describe("original evaluation finding occurrences", () => {
  it("keeps kind-local ordinal order even when display priority would sort differently", () => {
    const value = result();
    expect(value.occurrences.map(({ kind, ordinal }) => ({ kind, ordinal }))).toEqual([
      { kind: "pr_finding", ordinal: 0 },
      { kind: "pr_finding", ordinal: 1 },
      { kind: "validation_observation", ordinal: 0 },
      { kind: "validation_observation", ordinal: 1 },
    ]);
    expect(getEvaluationCellResultIssues(value)).toEqual([]);
    value.occurrences.reverse();
    expect(getEvaluationCellResultIssues(value).length).toBeGreaterThan(0);
  });

  it("rejects missing, duplicate, cross-result, or relabelled occurrence references", () => {
    const mutations: ((value: EvaluationCellResultV1) => void)[] = [
      (value) => {
        value.occurrences.pop();
      },
      (value) => {
        value.occurrences.push(structuredClone(required(value.occurrences[0])));
      },
      (value) => {
        required(value.occurrences[1]).key = required(value.occurrences[0]).key;
      },
      (value) => {
        required(value.occurrences[0]).resultId = "other-result";
      },
      (value) => {
        required(value.occurrences[0]).resultDigest = "f".repeat(64);
      },
      (value) => {
        required(value.occurrences[0]).kind = "validation_observation";
      },
      (value) => {
        required(value.occurrences[1]).ordinal = 0;
      },
      (value) => {
        required(value.modelReview.findings[0]).ordinal = 1;
      },
      (value) => {
        value.modelReview.findings.reverse();
      },
    ];
    for (const mutate of mutations) {
      const value = result();
      mutate(value);
      expect(Value.Check(EvaluationCellResultV1Schema, value)).toBe(true);
      expect(getEvaluationCellResultIssues(value).length).toBeGreaterThan(0);
    }
  });

  it("retains duplicate model labels as separate original occurrences", () => {
    const value = result();
    required(value.modelReview.findings[1]).findingId = required(
      value.modelReview.findings[0],
    ).findingId;
    required(value.modelReview.observations[1]).id = required(value.modelReview.observations[0]).id;
    expect(getEvaluationCellResultIssues(value)).toEqual([]);
  });

  it("supports the established 200-reference limit across the two original model arrays", () => {
    const value = result();
    const finding = required(value.modelReview.findings[0]);
    const observation = required(value.modelReview.observations[0]);
    value.modelReview.findings = Array.from({ length: 100 }, (_, ordinal) => ({
      ...finding,
      ordinal,
    }));
    value.modelReview.observations = Array.from({ length: 100 }, () => ({ ...observation }));
    replaceOccurrences(value);
    expect(value.occurrences).toHaveLength(maximumFindingResultOccurrenceCount);
    expect(getEvaluationCellResultIssues(value)).toEqual([]);
    value.occurrences.push(structuredClone(required(value.occurrences[0])));
    expect(getEvaluationCellResultIssues(value).length).toBeGreaterThan(0);
  });

  it("leaves content digest and occurrence hash verification to the owning service", () => {
    const value = result();
    value.resultDigest = "f".repeat(64);
    replaceOccurrences(value);
    required(value.occurrences[0]).key = "e".repeat(64);
    expect(getEvaluationCellResultIssues(value)).toEqual([]);
  });
});

describe("strict evaluation result JSON and size", () => {
  it("rejects non-JSON objects without invoking accessors or accepting discarded data", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const accessor = Object.defineProperty(query(), "resultId", {
      enumerable: true,
      get() {
        throw new Error("The accessor must not execute.");
      },
    });
    const inaccessible = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("The proxy cannot be inspected.");
        },
      },
    );
    for (const value of [
      null,
      undefined,
      [],
      { ...query(), cellId: "bad\ud800" },
      { ...query(), extra: 1n },
      { ...query(), extra: Number.NaN },
      { ...query(), extra: new Date(now) },
      { ...query(), [Symbol("hidden")]: true },
      Object.defineProperty(query(), "hidden", { value: true }),
      circular,
      accessor,
      inaccessible,
    ]) {
      expect(() => getEvaluationCellResultReadQueryIssues(value)).not.toThrow();
      expect(getEvaluationCellResultReadQueryIssues(value).length).toBeGreaterThan(0);
    }
    expect(
      getEvaluationCellResultReadQueryIssues(Object.assign(Object.create(null), query())),
    ).toEqual([]);
    for (const occurrences of [new Array(4), Object.assign(result().occurrences, { hidden: true })])
      expect(getEvaluationCellResultIssues({ ...result(), occurrences }).length).toBeGreaterThan(0);
    const malformed = result();
    required(malformed.modelReview.findings[0]).body = "bad\ud800";
    expect(getEvaluationCellResultIssues(malformed).length).toBeGreaterThan(0);
  });

  it("rejects malformed nested report, execution, and model structures", () => {
    const value = result();
    for (const patch of [
      { report: { ...value.report, source: "model" } },
      {
        execution: {
          ...value.execution,
          diagnostics: [{ ...value.execution.diagnostics[0], hidden: true }],
        },
      },
      { modelReview: { ...value.modelReview, state: "not_applicable" } },
      { modelRequirements: {} },
      { occurrences: [{ ...value.occurrences[0], ordinal: 100 }] },
    ])
      expect(getEvaluationCellResultIssues({ ...value, ...patch }).length).toBeGreaterThan(0);
  });

  it("enforces the aggregate UTF-8 budget at its exact boundary with real diagnostic text", () => {
    const value = atByteLimit();
    const bytes = (entry: unknown) => new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    expect(bytes(value)).toBe(maximumEvaluationCellResultUtf8Bytes);
    expect(getEvaluationCellResultIssues(value)).toEqual([]);
    const available = required(
      value.execution.diagnostics.find((entry) => (entry.stdout?.length ?? 0) < 4096),
    );
    available.stdout += "雪";
    expect(bytes(value)).toBe(maximumEvaluationCellResultUtf8Bytes + 3);
    expect(Value.Check(EvaluationCellResultV1Schema, value)).toBe(true);
    expect(getEvaluationCellResultIssues(value).join(" ")).toMatch(/aggregate UTF-8 byte limit/u);
  });
});
