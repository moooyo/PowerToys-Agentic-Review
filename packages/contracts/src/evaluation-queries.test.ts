import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, describe, expect, it } from "vitest";
import type {
  EvaluationBatchCancellationV1,
  EvaluationBatchSummaryV1,
} from "./evaluation-batches.js";
import {
  type EvaluationBatchDetailV1,
  EvaluationBatchDetailV1Schema,
  type EvaluationBatchListV1,
  type EvaluationBatchMatrixV1,
  EvaluationBatchMatrixV1Schema,
  type EvaluationBatchProgress,
  EvaluationCellExecutionStateSchema,
  type EvaluationCellSummaryV1,
  type EvaluationPromptOptionsV1,
  getEvaluationBatchCancellationIssues,
  getEvaluationBatchCancelRequestIssues,
  getEvaluationBatchDetailIssues,
  getEvaluationBatchListIssues,
  getEvaluationBatchListQueryIssues,
  getEvaluationBatchMatrixIssues,
  getEvaluationBatchProgressIssues,
  getEvaluationBatchStatus,
  getEvaluationBatchSummaryIssues,
  getEvaluationPromptOptionsIssues,
  getEvaluationPromptOptionsQueryIssues,
  maximumEvaluationReadUtf8Bytes,
} from "./evaluation-queries.js";
import {
  EvaluationExecutionStateSchema,
  maximumEvaluationCaseCount,
} from "./evaluation-scoring.js";
import {
  type WorkflowKind,
  WorkflowKindValues,
  WorkflowOutputSchemaVersions,
} from "./platform-configuration.js";
import type { JobState } from "./states.js";

const now = "2026-09-08T01:00:00.000Z";
const actor = { issuer: "https://identity.example", subject: "operator-1" };
const digest = "a".repeat(64);
const originalDateTime = FormatRegistry.Get("date-time");
afterAll(() => {
  if (originalDateTime === undefined) FormatRegistry.Delete("date-time");
  else FormatRegistry.Set("date-time", originalDateTime);
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("The fixture entry is missing.");
  return value;
}

function appendAtPath(value: object, path: string, suffix: string): void {
  const fields = path.split(".");
  const field = required(fields.pop());
  const target = fields.reduce(
    (entry, key) => entry[key] as Record<string, unknown>,
    value as Record<string, unknown>,
  );
  if (typeof target[field] !== "string") throw new Error("The identity path is not a string.");
  target[field] += suffix;
}

function summary(): EvaluationBatchSummaryV1 {
  return {
    schemaVersion: "EvaluationBatchSummaryV1",
    id: "evaluation-1",
    repositoryId: "repository-1",
    suiteId: "suite-1",
    suiteVersionId: "suite-version-1",
    workflowKind: "pr_static_build",
    target: "headless",
    mode: "prompt_and_profile",
    baseline: { profileVersionId: "profile-baseline-v1", promptVersionId: "prompt-baseline-v1" },
    candidate: { profileVersionId: "profile-candidate-v2", promptVersionId: "prompt-candidate-v2" },
    caseCount: 1,
    cellCount: 2,
    createdAt: now,
    createdBy: { ...actor },
  };
}

function progress(): EvaluationBatchProgress {
  return {
    totalCells: 2,
    applicableCells: 2,
    notApplicableCells: 0,
    not_run: 2,
    awaiting_admission: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    invalid: 0,
  };
}

function configuration(
  arm: "baseline" | "candidate",
): EvaluationBatchDetailV1["configurations"]["baseline"] {
  const selected = summary()[arm];
  return {
    profile: {
      id: selected.profileVersionId,
      profileId: `profile-${arm}`,
      repositoryId: "repository-1",
      version: arm === "baseline" ? 1 : 2,
      name: "Frozen build profile",
      required: true,
      workflowKind: "pr_static_build",
      target: "headless",
      outputSchemaVersion: "PrReviewPlanV2",
      configSha256: digest,
      createdAt: now,
      publishedAt: now,
      createdBy: "operator-1",
    },
    prompt: {
      id: selected.promptVersionId,
      templateId: `template-${arm}`,
      version: arm === "baseline" ? 1 : 2,
      contentSha256: digest,
      outputSchemaVersion: "PrReviewPlanV2",
      createdAt: now,
      publishedAt: now,
      createdBy: "operator-1",
    },
    modelRequirements: { required: true },
  };
}

function detail(): EvaluationBatchDetailV1 {
  return {
    schemaVersion: "EvaluationBatchDetailV1",
    summary: summary(),
    suiteName: "Compiler regressions",
    status: "pending",
    controlStatus: "active",
    controlVersion: 1,
    progress: progress(),
    suiteVersion: {
      schemaVersion: "EvaluationSuiteVersionV1",
      id: "suite-version-1",
      suiteId: "suite-1",
      repositoryId: "repository-1",
      version: 1,
      sourceDraftRevision: 3,
      name: "Compiler regressions",
      description: "Frozen examples for a paired comparison.",
      workflowKind: "pr_static_build",
      target: "headless",
      sourceVersionId: "source-version-1",
      expectationVersionId: "expectation-version-1",
      sourceManifestSha256: digest,
      expectationManifestSha256: "b".repeat(64),
      caseCount: 1,
      createdAt: now,
      createdBy: { ...actor },
    },
    control: {
      status: "active",
      version: 1,
      reason: null,
      updatedAt: now,
      updatedBy: { ...actor },
    },
    configurations: { baseline: configuration("baseline"), candidate: configuration("candidate") },
  };
}

function list(): EvaluationBatchListV1 {
  const { summary, suiteName, status, controlStatus, controlVersion, progress } = detail();
  return {
    schemaVersion: "EvaluationBatchListV1",
    repositoryId: "repository-1",
    page: 1,
    pageSize: 20,
    total: 1,
    items: [{ summary, suiteName, status, controlStatus, controlVersion, progress }],
  };
}

function cell(caseIndex: number, arm: "baseline" | "candidate"): EvaluationCellSummaryV1 {
  return {
    cellId: `cell-${caseIndex}-${arm}`,
    caseId: `case-${caseIndex}`,
    arm,
    trial: 1,
    runId: `run-${caseIndex}-${arm}`,
    requestId: `request-${caseIndex}-${arm}`,
    sourceId: `source-${caseIndex}`,
    sourceDigest: digest,
    ...summary()[arm],
    state: "not_run",
    job: null,
    result: null,
    blockerCount: 0,
    blockers: [],
  };
}

function matrix(caseCount = 1): EvaluationBatchMatrixV1 {
  return {
    schemaVersion: "EvaluationBatchMatrixV1",
    repositoryId: "repository-1",
    evaluationId: "evaluation-1",
    suiteVersionId: "suite-version-1",
    status: "pending",
    progress: {
      ...progress(),
      totalCells: caseCount * 2,
      applicableCells: caseCount * 2,
      not_run: caseCount * 2,
    },
    cases: Array.from({ length: caseCount }, (_, index) => ({
      caseId: `case-${index}`,
      title: "Detect the known build failure",
      applicability: { state: "applicable" },
      source: {
        schemaVersion: "EvaluationSourceSummaryV1",
        id: `source-${index}`,
        repositoryId: "repository-1",
        workItemId: `work-item-${index}`,
        revisionId: `revision-${index}`,
        revisionKey: "b".repeat(64),
        sourceDigest: digest,
        workItemKind: "pull_request",
        number: index + 1,
        title: "Frozen pull request",
        createdAt: now,
        createdBy: { ...actor },
      },
      baseline: cell(index, "baseline"),
      candidate: cell(index, "candidate"),
    })),
  };
}

function setJob(
  cell: EvaluationCellSummaryV1,
  status: JobState,
  state: EvaluationCellSummaryV1["state"],
  failureCode: string | null = null,
): void {
  cell.state = state;
  cell.job = {
    jobId: `job-${cell.cellId}`,
    status,
    attemptCount: 1,
    admission:
      status === "queued" || status === "retry_waiting"
        ? {
            state: "admitted",
            attemptBase: 1,
            requestedAt: now,
            admittedAt: now,
            timestampBasis: "recorded",
          }
        : null,
    createdAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt: ["succeeded", "failed", "dead_letter", "cancelled", "stale"].includes(status)
      ? now
      : null,
    failureCode,
  };
  cell.result =
    status === "succeeded"
      ? {
          resultId: `result-${cell.cellId}`,
          runAttemptId: `attempt-${cell.cellId}`,
          resultDigest: digest,
          createdAt: now,
        }
      : null;
}

function refreshMatrix(value: EvaluationBatchMatrixV1): void {
  value.progress = {
    ...progress(),
    totalCells: value.cases.length * 2,
    applicableCells: 0,
    not_run: 0,
  };
  for (const entry of value.cases) {
    for (const arm of ["baseline", "candidate"] as const) {
      if (entry.applicability.state === "applicable") {
        value.progress.applicableCells += 1;
        value.progress[entry[arm].state] += 1;
      } else value.progress.notApplicableCells += 1;
    }
  }
  value.status = getEvaluationBatchStatus(value.progress, false);
}

function promptOptions(workflowKind: WorkflowKind = "pr_static_build"): EvaluationPromptOptionsV1 {
  return {
    schemaVersion: "EvaluationPromptOptionsV1",
    repositoryId: "repository-1",
    workflowKind,
    page: 1,
    pageSize: 20,
    total: 1,
    items: [
      {
        ...configuration("baseline").prompt,
        outputSchemaVersion: WorkflowOutputSchemaVersions[workflowKind],
        templateName: "Review prompt",
        visibility: "binding",
      },
    ],
  };
}

function cancellation(): EvaluationBatchCancellationV1 {
  return {
    schemaVersion: "EvaluationBatchCancellationV1",
    evaluationId: "evaluation-1",
    repositoryId: "repository-1",
    status: "cancelled",
    version: 2,
    reason: "Stop this comparison.",
    cancelledAt: now,
    cancelledBy: { ...actor },
    cancelledJobCount: 1,
    cancellationRequestedJobCount: 1,
  };
}

describe("evaluation query pagination", () => {
  it("accepts omitted defaults, valid filters, and safe distant windows without mutation", () => {
    for (const value of [
      {},
      { page: 1, pageSize: 50, suiteId: "suite-1", workflowKind: "pr_ui" },
      { page: Number.MAX_SAFE_INTEGER, pageSize: 1 },
    ]) {
      const original = structuredClone(value);
      expect(getEvaluationBatchListQueryIssues(value)).toEqual([]);
      expect(value).toEqual(original);
    }
    for (const workflowKind of WorkflowKindValues)
      expect(getEvaluationPromptOptionsQueryIssues({ workflowKind })).toEqual([]);
  });

  it.each([
    { page: 0 },
    { page: 1.5 },
    { page: "2" },
    { pageSize: 0 },
    { pageSize: 51 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 2 },
    { page: Number.MAX_SAFE_INTEGER + 1 },
    { suiteId: "" },
    { workflowKind: "unknown" },
    { repositoryId: "client-scope" },
  ])("rejects unsafe or unrecognized list queries: %j", (value) => {
    expect(getEvaluationBatchListQueryIssues(value).length).toBeGreaterThan(0);
  });

  it("requires workflow scope and rejects extra prompt filters", () => {
    for (const value of [
      {},
      { workflowKind: "pr_ui", suiteId: "suite-1" },
      { workflowKind: "pr_ui", page: Number.MAX_SAFE_INTEGER },
      { workflowKind: "pr_ui", pageSize: 51 },
    ])
      expect(getEvaluationPromptOptionsQueryIssues(value).length).toBeGreaterThan(0);
  });

  it("requires every item in a page and permits an empty window beyond the end", () => {
    for (const [make, validate] of [
      [list, getEvaluationBatchListIssues],
      [promptOptions, getEvaluationPromptOptionsIssues],
    ] as const) {
      const valid = make();
      expect(validate(valid)).toEqual([]);
      expect(validate({ ...valid, page: 2, items: [] })).toEqual([]);
      expect(validate({ ...valid, total: 0, items: [] })).toEqual([]);
      for (const patch of [
        { total: 2 },
        { total: 0 },
        { page: 2 },
        { items: [] },
        { page: Number.MAX_SAFE_INTEGER, pageSize: 2 },
      ])
        expect(validate({ ...valid, ...patch }).length).toBeGreaterThan(0);
      expect(
        validate({ ...valid, total: 2, items: [valid.items[0], valid.items[0]] }).length,
      ).toBeGreaterThan(0);
    }
  });
});

describe("evaluation progress and frozen detail", () => {
  it("counts both arms and retains every applicable terminal outcome", () => {
    expect(getEvaluationBatchProgressIssues(progress())).toEqual([]);
    expect(
      getEvaluationBatchProgressIssues({ ...progress(), totalCells: 4, notApplicableCells: 2 }),
    ).toEqual([]);
    for (const patch of [
      { totalCells: 3 },
      { applicableCells: 1, not_run: 1, notApplicableCells: 1 },
      { not_run: 1 },
      { not_run: 2, completed: 1 },
      { totalCells: 0, applicableCells: 0, not_run: 0 },
      { applicableCells: 0, not_run: 0, notApplicableCells: 2 },
      { totalCells: 66, applicableCells: 66, not_run: 66 },
    ])
      expect(getEvaluationBatchProgressIssues({ ...progress(), ...patch }).length).toBeGreaterThan(
        0,
      );
  });

  it("requires an explicit count for cells awaiting admission without changing scoring states", () => {
    expect(Value.Check(EvaluationCellExecutionStateSchema, "awaiting_admission")).toBe(true);
    expect(Value.Check(EvaluationExecutionStateSchema, "awaiting_admission")).toBe(false);
    expect(
      getEvaluationBatchProgressIssues({ ...progress(), not_run: 0, awaiting_admission: 2 }),
    ).toEqual([]);
    const { awaiting_admission: _waiting, ...legacy } = progress();
    expect(getEvaluationBatchProgressIssues(legacy).length).toBeGreaterThan(0);
    expect(
      getEvaluationBatchProgressIssues({ ...progress(), awaiting_admission: 1 }).length,
    ).toBeGreaterThan(0);
  });

  it("derives status from unfinished cells and distinguishes cancellation from failure", () => {
    const empty = { ...progress(), not_run: 0 };
    expect(getEvaluationBatchStatus({ ...empty, running: 1, queued: 1 }, false)).toBe("running");
    expect(getEvaluationBatchStatus({ ...empty, queued: 1, not_run: 1 }, false)).toBe("queued");
    expect(getEvaluationBatchStatus({ ...empty, running: 1, awaiting_admission: 1 }, false)).toBe(
      "running",
    );
    expect(getEvaluationBatchStatus({ ...empty, queued: 1, awaiting_admission: 1 }, false)).toBe(
      "queued",
    );
    expect(getEvaluationBatchStatus({ ...empty, awaiting_admission: 1, not_run: 1 }, false)).toBe(
      "awaiting_admission",
    );
    expect(getEvaluationBatchStatus({ ...empty, not_run: 1, blocked: 1 }, false)).toBe("pending");
    expect(getEvaluationBatchStatus({ ...empty, blocked: 1, failed: 1 }, false)).toBe("blocked");
    expect(getEvaluationBatchStatus({ ...empty, invalid: 1, completed: 1 }, false)).toBe("blocked");
    expect(getEvaluationBatchStatus({ ...empty, failed: 2 }, false)).toBe("completed");
    expect(getEvaluationBatchStatus({ ...empty, cancelled: 2 }, false)).toBe("completed");
    expect(getEvaluationBatchStatus({ ...empty, running: 2 }, true)).toBe("cancelling");
    expect(getEvaluationBatchStatus({ ...empty, awaiting_admission: 2 }, true)).toBe("cancelled");
    expect(getEvaluationBatchStatus({ ...empty, cancelled: 2 }, true)).toBe("cancelled");
  });

  it("keeps frozen selections and model requirements consistent with the batch mode", () => {
    const value = detail();
    const original = structuredClone(value);
    expect(getEvaluationBatchSummaryIssues(value.summary)).toEqual([]);
    expect(getEvaluationBatchDetailIssues(value)).toEqual([]);
    expect(value).toEqual(original);
    value.summary.mode = "profile_only";
    for (const arm of ["baseline", "candidate"] as const)
      value.configurations[arm].modelRequirements.required = false;
    expect(getEvaluationBatchDetailIssues(value)).toEqual([]);
    value.summary.candidate = { ...value.summary.baseline };
    value.configurations.candidate = structuredClone(value.configurations.baseline);
    expect(getEvaluationBatchDetailIssues(value)).toEqual([]);
  });

  it("requires an explicit boolean model requirement for each frozen arm", () => {
    const value = detail();
    for (const arm of ["baseline", "candidate"] as const) {
      for (const modelRequirements of [
        {},
        { required: null },
        { required: "true" },
        { required: true, enabled: true },
      ]) {
        expect(
          getEvaluationBatchDetailIssues({
            ...value,
            configurations: {
              ...value.configurations,
              [arm]: { ...value.configurations[arm], modelRequirements },
            },
          }).length,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("rejects summaries whose workflow, paired count, or author are inconsistent", () => {
    for (const patch of [
      { cellCount: 3 },
      { workflowKind: "pr_ui" },
      { target: "web" },
      { createdBy: { ...actor, subject: " operator-1" } },
      { createdBy: { ...actor, issuer: "issuer\u0001" } },
    ])
      expect(getEvaluationBatchSummaryIssues({ ...summary(), ...patch }).length).toBeGreaterThan(0);
    for (const target of ["headless", "windows_desktop", "web"] as const)
      expect(
        getEvaluationBatchSummaryIssues({ ...summary(), workflowKind: "issue_validation", target }),
      ).toEqual([]);
  });

  it.each([
    "id",
    "suiteId",
    "repositoryId",
    "name",
    "caseCount",
    "workflowKind",
    "target",
  ] as const)("rejects a replaced frozen suite %s", (field) => {
    const value = detail();
    const replacement = {
      id: "other-version",
      suiteId: "other-suite",
      repositoryId: "other-repository",
      name: "Renamed live suite",
      caseCount: 2,
      workflowKind: "issue_triage",
      target: "web",
    };
    Object.assign(value.suiteVersion, { [field]: replacement[field] });
    expect(getEvaluationBatchDetailIssues(value).length).toBeGreaterThan(0);
  });

  it("rejects cross-scope profiles, substituted prompts, and a mode that contradicts model requirements", () => {
    const mutations: ((value: EvaluationBatchDetailV1) => void)[] = [
      (value) => {
        value.configurations.baseline.profile.id = "other-profile";
      },
      (value) => {
        value.configurations.candidate.profile.repositoryId = "other-repository";
      },
      (value) => {
        value.configurations.candidate.prompt.id = "other-prompt";
      },
      (value) => {
        value.configurations.baseline.prompt.outputSchemaVersion = "IssueTriageV2";
      },
      (value) => {
        value.configurations.candidate.modelRequirements.required = false;
      },
      (value) => {
        value.summary.mode = "profile_only";
      },
      (value) => {
        value.controlVersion = 2;
      },
      (value) => {
        value.status = "completed";
      },
      (value) => {
        value.progress.totalCells = 4;
        value.progress.applicableCells = 4;
        value.progress.not_run = 4;
      },
    ];
    for (const mutate of mutations) {
      const value = detail();
      mutate(value);
      expect(Value.Check(EvaluationBatchDetailV1Schema, value)).toBe(true);
      expect(getEvaluationBatchDetailIssues(value).length).toBeGreaterThan(0);
    }
  });

  it("shows current cancellation while preserving the frozen batch and unfinished cells", () => {
    const value = detail();
    value.status = "cancelled";
    value.controlStatus = "cancelled";
    value.controlVersion = 2;
    value.control = {
      status: "cancelled",
      version: 2,
      reason: "Stop this comparison.",
      updatedAt: now,
      updatedBy: { ...actor },
    };
    expect(getEvaluationBatchDetailIssues(value)).toEqual([]);
    for (const reason of ["", "  ", "bad\0reason"])
      expect(
        getEvaluationBatchDetailIssues({ ...value, control: { ...value.control, reason } }).length,
      ).toBeGreaterThan(0);
    expect(
      getEvaluationBatchDetailIssues({ ...value, controlStatus: "active", controlVersion: 1 })
        .length,
    ).toBeGreaterThan(0);
  });

  it("keeps cancellation in progress until every running cell has stopped", () => {
    const value = detail();
    value.status = "cancelling";
    value.controlStatus = "cancelled";
    value.controlVersion = 2;
    value.control = {
      status: "cancelled",
      version: 2,
      reason: "Stop this comparison.",
      updatedAt: now,
      updatedBy: { ...actor },
    };
    value.progress = { ...progress(), not_run: 0, running: 1, cancelled: 1 };
    expect(getEvaluationBatchDetailIssues(value)).toEqual([]);
    expect(
      getEvaluationBatchDetailIssues({ ...value, status: "cancelled" }).length,
    ).toBeGreaterThan(0);
    const page = list();
    const item = required(page.items[0]);
    Object.assign(item, {
      status: value.status,
      controlStatus: value.controlStatus,
      controlVersion: value.controlVersion,
      progress: value.progress,
    });
    expect(getEvaluationBatchListIssues(page)).toEqual([]);
    item.status = "cancelled";
    expect(getEvaluationBatchListIssues(page).length).toBeGreaterThan(0);
    value.progress = { ...progress(), not_run: 0, cancelled: 2 };
    expect(getEvaluationBatchDetailIssues(value).length).toBeGreaterThan(0);
    value.status = "cancelled";
    expect(getEvaluationBatchDetailIssues(value)).toEqual([]);
  });

  it("rejects repository leakage and inconsistent list summaries", () => {
    const value = list();
    expect(
      getEvaluationBatchListIssues({ ...value, repositoryId: "other-repository" }).length,
    ).toBeGreaterThan(0);
    required(value.items[0]).summary.target = "web";
    expect(getEvaluationBatchListIssues(value).length).toBeGreaterThan(0);
  });
});

describe("paired evaluation matrix", () => {
  it("preserves all 32 cases and excludes inapplicable cells only from execution totals", () => {
    expect(getEvaluationBatchMatrixIssues(matrix(maximumEvaluationCaseCount))).toEqual([]);
    expect(
      getEvaluationBatchMatrixIssues(matrix(maximumEvaluationCaseCount + 1)).length,
    ).toBeGreaterThan(0);
    const value = matrix(2);
    required(value.cases[1]).applicability = {
      state: "not_applicable",
      reason: "This case does not exercise the selected workflow.",
    };
    refreshMatrix(value);
    expect(value.progress).toEqual({ ...progress(), totalCells: 4, notApplicableCells: 2 });
    expect(getEvaluationBatchMatrixIssues(value)).toEqual([]);
    setJob(required(value.cases[1]).candidate, "queued", "queued");
    expect(getEvaluationBatchMatrixIssues(value).length).toBeGreaterThan(0);
  });

  it.each([
    ["queued", "queued", null],
    ["retry_waiting", "queued", null],
    ["leased", "running", null],
    ["running", "running", null],
    ["cancel_requested", "running", null],
    ["succeeded", "completed", null],
    ["failed", "failed", "COMPILATION_FAILED"],
    ["dead_letter", "failed", "ATTEMPTS_EXHAUSTED"],
    ["failed", "blocked", "EVALUATION_EXECUTION_BOUNDARY_UNAVAILABLE"],
    ["dead_letter", "blocked", "EVALUATION_EXECUTION_BOUNDARY_UNAVAILABLE"],
    ["cancelled", "cancelled", null],
    ["stale", "invalid", null],
  ] as const)(
    "reports %s as %s with its persisted result semantics",
    (jobStatus, state, failureCode) => {
      const value = matrix();
      const baseline = required(value.cases[0]).baseline;
      setJob(baseline, jobStatus, state, failureCode);
      refreshMatrix(value);
      expect(getEvaluationBatchMatrixIssues(value)).toEqual([]);
      if (jobStatus !== "queued" && jobStatus !== "retry_waiting") {
        required(baseline.job).admission = {
          state: "pending",
          attemptBase: 1,
          requestedAt: now,
          admittedAt: null,
          timestampBasis: "recorded",
        };
        expect(getEvaluationBatchMatrixIssues(value)).toContain("admission_outside_waiting");
        required(baseline.job).admission = null;
      }
      baseline.state = state === "completed" ? "running" : "completed";
      refreshMatrix(value);
      expect(getEvaluationBatchMatrixIssues(value).length).toBeGreaterThan(0);
    },
  );

  it.each(["queued", "retry_waiting"] as const)(
    "keeps %s behind admission until its exact waiting episode is admitted",
    (jobStatus) => {
      const value = matrix();
      const baseline = required(value.cases[0]).baseline;
      setJob(baseline, jobStatus, "awaiting_admission");
      const job = required(baseline.job);
      job.admission = {
        state: "pending",
        attemptBase: job.attemptCount,
        requestedAt: now,
        admittedAt: null,
        timestampBasis: "recorded",
      };
      refreshMatrix(value);
      expect(value.status).toBe("awaiting_admission");
      expect(value.progress.awaiting_admission).toBe(1);
      expect(value.progress.queued).toBe(0);
      expect(getEvaluationBatchMatrixIssues(value)).toEqual([]);
      baseline.state = "queued";
      refreshMatrix(value);
      expect(getEvaluationBatchMatrixIssues(value).length).toBeGreaterThan(0);
      job.admission = { ...job.admission, state: "admitted", admittedAt: now };
      refreshMatrix(value);
      expect(value.status).toBe("queued");
      expect(value.progress.awaiting_admission).toBe(0);
      expect(value.progress.queued).toBe(1);
      expect(getEvaluationBatchMatrixIssues(value)).toEqual([]);
      baseline.state = "awaiting_admission";
      refreshMatrix(value);
      expect(getEvaluationBatchMatrixIssues(value).length).toBeGreaterThan(0);
    },
  );

  it("rejects absent admission, mismatched waiting attempts, and noncanonical timestamps", () => {
    const value = matrix();
    setJob(required(value.cases[0]).baseline, "retry_waiting", "queued");
    refreshMatrix(value);
    const mutations: [string, (job: NonNullable<EvaluationCellSummaryV1["job"]>) => void][] = [
      [
        "missing_waiting_admission",
        (job) => {
          job.admission = null;
        },
      ],
      [
        "admission_attempt_mismatch",
        (job) => {
          required(job.admission).attemptBase += 1;
        },
      ],
      [
        "invalid_admission_request_time",
        (job) => {
          required(job.admission).requestedAt = "2026-09-08T01:00:00Z";
        },
      ],
      [
        "invalid_admission_time",
        (job) => {
          required(job.admission).admittedAt = "2026-09-08T01:00:00Z";
        },
      ],
    ];
    for (const [issue, mutate] of mutations) {
      const changed = structuredClone(value);
      mutate(required(required(changed.cases[0]).baseline.job));
      expect(getEvaluationBatchMatrixIssues(changed)).toContain(issue);
    }
    const omitted = structuredClone(value);
    Reflect.deleteProperty(required(required(omitted.cases[0]).baseline.job), "admission");
    expect(getEvaluationBatchMatrixIssues(omitted).length).toBeGreaterThan(0);
    const admission = required(required(required(value.cases[0]).baseline.job).admission);
    admission.timestampBasis = "migration_backfill";
    admission.requestedAt = "2026-09-08T02:00:00.000Z";
    expect(getEvaluationBatchMatrixIssues(value)).toEqual([]);
  });

  it("does not report cancel-requested execution as stopped before acknowledgement", () => {
    const value = matrix();
    const baseline = required(value.cases[0]).baseline;
    setJob(baseline, "cancel_requested", "running");
    refreshMatrix(value);
    value.status = "cancelling";
    expect(getEvaluationBatchMatrixIssues(value)).toEqual([]);
    expect(
      getEvaluationBatchMatrixIssues({ ...value, status: "cancelled" }).length,
    ).toBeGreaterThan(0);
    baseline.state = "cancelled";
    refreshMatrix(value);
    value.status = "cancelled";
    expect(getEvaluationBatchMatrixIssues(value).length).toBeGreaterThan(0);
    setJob(baseline, "cancelled", "cancelled");
    refreshMatrix(value);
    value.status = "cancelled";
    expect(getEvaluationBatchMatrixIssues(value)).toEqual([]);
    expect(
      getEvaluationBatchMatrixIssues({ ...value, status: "cancelling" }).length,
    ).toBeGreaterThan(0);
  });

  it("never presents missing or unrelated results as completed evaluation cells", () => {
    for (const state of [
      "awaiting_admission",
      "queued",
      "running",
      "completed",
      "failed",
      "invalid",
    ] as const) {
      const value = matrix();
      required(value.cases[0]).baseline.state = state;
      refreshMatrix(value);
      expect(getEvaluationBatchMatrixIssues(value).length).toBeGreaterThan(0);
    }
    const value = matrix();
    setJob(required(value.cases[0]).baseline, "succeeded", "completed");
    required(value.cases[0]).baseline.result = null;
    refreshMatrix(value);
    expect(getEvaluationBatchMatrixIssues(value).length).toBeGreaterThan(0);
    for (const state of ["not_run", "blocked", "cancelled"] as const) {
      const withoutJob = matrix();
      required(withoutJob.cases[0]).baseline.state = state;
      refreshMatrix(withoutJob);
      expect(getEvaluationBatchMatrixIssues(withoutJob)).toEqual([]);
    }
  });

  it.each(["cellId", "runId", "requestId"] as const)(
    "rejects a reused %s across paired arms",
    (key) => {
      const value = matrix();
      const entry = required(value.cases[0]);
      entry.candidate[key] = entry.baseline[key];
      expect(getEvaluationBatchMatrixIssues(value).length).toBeGreaterThan(0);
    },
  );

  it("rejects shared Jobs, results, and attempts across otherwise distinct cells", () => {
    for (const key of ["jobId", "resultId", "runAttemptId"] as const) {
      const value = matrix();
      const entry = required(value.cases[0]);
      setJob(entry.baseline, "succeeded", "completed");
      setJob(entry.candidate, "succeeded", "completed");
      if (key === "jobId") required(entry.candidate.job).jobId = required(entry.baseline.job).jobId;
      else required(entry.candidate.result)[key] = required(entry.baseline.result)[key];
      refreshMatrix(value);
      expect(getEvaluationBatchMatrixIssues(value).length).toBeGreaterThan(0);
    }
  });

  it("rejects broken pairing, changed frozen selections, and source scope or digest mismatches", () => {
    const mutations: ((value: EvaluationBatchMatrixV1) => void)[] = [
      (value) => {
        required(value.cases[1]).caseId = required(value.cases[0]).caseId;
      },
      (value) => {
        required(value.cases[0]).baseline.caseId = "other-case";
      },
      (value) => {
        required(value.cases[0]).candidate.arm = "baseline";
      },
      (value) => {
        required(value.cases[0]).baseline.sourceId = "other-source";
      },
      (value) => {
        required(value.cases[0]).baseline.sourceDigest = "c".repeat(64);
      },
      (value) => {
        required(value.cases[0]).source.repositoryId = "other-repository";
      },
      (value) => {
        required(value.cases[1]).baseline.profileVersionId = "new-profile";
      },
      (value) => {
        required(value.cases[1]).candidate.promptVersionId = "new-prompt";
      },
      (value) => {
        required(value.cases[0]).source.createdBy.subject = "operator-1 ";
      },
    ];
    for (const mutate of mutations) {
      const value = matrix(2);
      mutate(value);
      expect(Value.Check(EvaluationBatchMatrixV1Schema, value)).toBe(true);
      expect(getEvaluationBatchMatrixIssues(value).length).toBeGreaterThan(0);
    }
  });

  it("shows only the first 16 blockers while retaining the complete count", () => {
    for (const blockerCount of [0, 1, 16, 17, 140]) {
      const value = matrix();
      required(value.cases[0]).baseline.blockerCount = blockerCount;
      required(value.cases[0]).baseline.blockers = Array.from(
        { length: Math.min(16, blockerCount) },
        () => ({ code: "missing_capability", capability: "isolated_execution" }),
      );
      expect(getEvaluationBatchMatrixIssues(value)).toEqual([]);
      required(value.cases[0]).baseline.blockerCount = blockerCount === 0 ? 1 : 0;
      expect(getEvaluationBatchMatrixIssues(value).length).toBeGreaterThan(0);
    }
  });

  it("rejects incomplete progress and fabricated batch status", () => {
    const value = matrix();
    expect(
      getEvaluationBatchMatrixIssues({
        ...value,
        progress: { ...progress(), totalCells: 4, applicableCells: 4, not_run: 4 },
      }).length,
    ).toBeGreaterThan(0);
    expect(
      getEvaluationBatchMatrixIssues({ ...value, status: "completed" }).length,
    ).toBeGreaterThan(0);
    expect(getEvaluationBatchMatrixIssues({ ...value, status: "cancelled" })).toEqual([]);
  });
});

describe("evaluation prompt options and cancellation", () => {
  it("matches prompt output schemas to every workflow and preserves visibility", () => {
    for (const workflowKind of WorkflowKindValues) {
      const value = promptOptions(workflowKind);
      for (const visibility of ["platform", "binding", "frozen_run"] as const) {
        required(value.items[0]).visibility = visibility;
        expect(getEvaluationPromptOptionsIssues(value)).toEqual([]);
      }
      required(value.items[0]).outputSchemaVersion =
        workflowKind === "issue_triage" ? "PrReviewPlanV2" : "IssueTriageV2";
      expect(getEvaluationPromptOptionsIssues(value).length).toBeGreaterThan(0);
    }
  });

  it("requires an explicit reason and active control version for cancellation", () => {
    const value = { changeId: "cancel-1", expectedVersion: 1, reason: "Stop this comparison." };
    expect(getEvaluationBatchCancelRequestIssues(value)).toEqual([]);
    for (const patch of [
      { reason: "" },
      { reason: " \t\n" },
      { reason: "bad\0reason" },
      { reason: "x".repeat(2049) },
      { expectedVersion: 2 },
      { cancelledBy: actor },
      { cancelledJobCount: 1 },
    ])
      expect(getEvaluationBatchCancelRequestIssues({ ...value, ...patch }).length).toBeGreaterThan(
        0,
      );
  });

  it("bounds the combined cancelled and cancellation-requested Jobs to 64", () => {
    const value = cancellation();
    expect(getEvaluationBatchCancellationIssues(value)).toEqual([]);
    expect(
      getEvaluationBatchCancellationIssues({
        ...value,
        cancelledJobCount: 32,
        cancellationRequestedJobCount: 32,
      }),
    ).toEqual([]);
    expect(
      getEvaluationBatchCancellationIssues({
        ...value,
        cancelledJobCount: 0,
        cancellationRequestedJobCount: 0,
      }),
    ).toEqual([]);
    for (const patch of [
      { cancelledJobCount: 64, cancellationRequestedJobCount: 1 },
      { cancelledJobCount: -1 },
      { cancellationRequestedJobCount: 0.5 },
      { version: 1 },
      { status: "pending" },
      { cancelledBy: { ...actor, subject: "operator-1\n" } },
    ])
      expect(getEvaluationBatchCancellationIssues({ ...value, ...patch }).length).toBeGreaterThan(
        0,
      );
  });
});

describe("strict evaluation read JSON and encoded size", () => {
  it("rejects whitespace and control suffixes throughout nested identities and actors", () => {
    const fixtures: [() => object, (value: unknown) => string[], string[]][] = [
      [() => ({ suiteId: "suite-1" }), getEvaluationBatchListQueryIssues, ["suiteId"]],
      [
        summary,
        getEvaluationBatchSummaryIssues,
        [
          "id",
          "repositoryId",
          "suiteId",
          "suiteVersionId",
          "baseline.profileVersionId",
          "candidate.promptVersionId",
          "createdBy.issuer",
          "createdBy.subject",
        ],
      ],
      [list, getEvaluationBatchListIssues, ["repositoryId", "items.0.summary.id"]],
      [
        detail,
        getEvaluationBatchDetailIssues,
        [
          "suiteVersion.sourceVersionId",
          "suiteVersion.expectationVersionId",
          "suiteVersion.createdBy.subject",
          "configurations.baseline.profile.profileId",
          "configurations.baseline.prompt.templateId",
          "configurations.baseline.prompt.createdBy",
          "control.updatedBy.issuer",
        ],
      ],
      [
        matrix,
        getEvaluationBatchMatrixIssues,
        [
          "repositoryId",
          "evaluationId",
          "suiteVersionId",
          "cases.0.caseId",
          "cases.0.baseline.cellId",
          "cases.0.candidate.runId",
          "cases.0.baseline.requestId",
          "cases.0.baseline.sourceId",
          "cases.0.source.revisionId",
          "cases.0.source.workItemId",
          "cases.0.source.createdBy.subject",
        ],
      ],
      [
        promptOptions,
        getEvaluationPromptOptionsIssues,
        ["repositoryId", "items.0.id", "items.0.templateId", "items.0.createdBy"],
      ],
      [
        () => ({ changeId: "cancel-1", expectedVersion: 1, reason: "Stop the comparison." }),
        getEvaluationBatchCancelRequestIssues,
        ["changeId"],
      ],
      [
        cancellation,
        getEvaluationBatchCancellationIssues,
        ["evaluationId", "repositoryId", "cancelledBy.issuer", "cancelledBy.subject"],
      ],
    ];
    for (const [make, validate, paths] of fixtures) {
      for (const path of paths) {
        for (const suffix of ["\n", " ", "\u007f"]) {
          const value = make();
          appendAtPath(value, path, suffix);
          const original = structuredClone(value);
          expect(validate(value).length, `${path}: ${JSON.stringify(suffix)}`).toBeGreaterThan(0);
          expect(value).toEqual(original);
        }
      }
    }
    const completed = matrix();
    setJob(required(completed.cases[0]).baseline, "succeeded", "completed");
    refreshMatrix(completed);
    for (const path of [
      "cases.0.baseline.job.jobId",
      "cases.0.baseline.result.resultId",
      "cases.0.baseline.result.runAttemptId",
    ]) {
      const value = structuredClone(completed);
      appendAtPath(value, path, "\n");
      expect(getEvaluationBatchMatrixIssues(value).length).toBeGreaterThan(0);
    }
  });

  it("rejects malformed JSON without invoking getters or mutating the input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const accessor = Object.defineProperty({}, "page", {
      enumerable: true,
      get() {
        throw new Error("A contract validator must not invoke accessors.");
      },
    });
    const hidden = Object.defineProperty({}, "page", { enumerable: false, value: 1 });
    const malformed = [
      null,
      undefined,
      [],
      { page: Number.NaN },
      { page: Number.POSITIVE_INFINITY },
      { page: 1n },
      { page: new Date(now) },
      { suiteId: "bad\ud800" },
      { "bad\ud800": 1 },
      { page: undefined },
      { [Symbol("hidden")]: 1 },
      circular,
      accessor,
      hidden,
    ];
    for (const value of malformed) {
      expect(() => getEvaluationBatchListQueryIssues(value)).not.toThrow();
      expect(getEvaluationBatchListQueryIssues(value).length).toBeGreaterThan(0);
    }
    expect(
      getEvaluationBatchListQueryIssues(Object.assign(Object.create(null), { page: 1 })),
    ).toEqual([]);
  });

  it("rejects sparse arrays and array properties that JSON serialization would discard", () => {
    const value = list();
    const sparse = new Array(1);
    const named = Object.assign([...value.items], { hiddenResult: "not serialized" });
    const symbolic = Object.assign([...value.items], { [Symbol("hidden")]: 1 });
    for (const items of [sparse, named, symbolic])
      expect(getEvaluationBatchListIssues({ ...value, items }).length).toBeGreaterThan(0);
  });

  it("rejects full snapshots, prompt content, and undeclared execution facts from bounded reads", () => {
    const value = detail();
    expect(
      getEvaluationBatchDetailIssues({
        ...value,
        configurations: {
          ...value.configurations,
          baseline: {
            ...value.configurations.baseline,
            prompt: { ...value.configurations.baseline.prompt, content: "private prompt" },
          },
        },
      }).length,
    ).toBeGreaterThan(0);
    const cells = matrix();
    Object.assign(required(cells.cases[0]).source, { snapshot: { body: "full captured body" } });
    expect(getEvaluationBatchMatrixIssues(cells).length).toBeGreaterThan(0);
    expect(
      getEvaluationBatchSummaryIssues({ ...summary(), authorization: {} }).length,
    ).toBeGreaterThan(0);
  });

  it("measures aggregate UTF-8 bytes at the exact limit without rounding multibyte content", () => {
    const value = detail();
    value.configurations.baseline.prompt.createdBy = "reviewer雪";
    const bytes = (entry: unknown) => new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    const remaining = maximumEvaluationReadUtf8Bytes - bytes(value);
    value.configurations.baseline.prompt.createdAt = `2026-09-08T01:00:00.${"0".repeat(remaining + 3)}Z`;
    expect(bytes(value)).toBe(maximumEvaluationReadUtf8Bytes);
    expect(getEvaluationBatchDetailIssues(value)).toEqual([]);
    value.configurations.baseline.prompt.createdBy += "雪";
    expect(bytes(value)).toBe(maximumEvaluationReadUtf8Bytes + 3);
    expect(Value.Check(EvaluationBatchDetailV1Schema, value)).toBe(true);
    expect(getEvaluationBatchDetailIssues(value).join(" ")).toMatch(/UTF-8 byte limit/u);
  });
});
