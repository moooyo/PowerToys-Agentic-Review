import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  DashboardReviewRunDetailSchema,
  DashboardReviewRunExecutionCountsSchema,
  DashboardReviewRunJobListQuerySchema,
  DashboardReviewRunJobListResponseSchema,
  DashboardReviewRunJobSchema,
  DashboardReviewRunListQuerySchema,
  DashboardReviewRunListResponseSchema,
  DashboardReviewRunReadQuerySchema,
  DashboardReviewRunRequestSchema,
  DashboardReviewRunResultQuerySchema,
  DashboardReviewRunResultSchema,
  DashboardReviewRunSummarySchema,
  DashboardValidationModelReviewSchema,
  DashboardValidationOutcomeCountsSchema,
  DashboardValidationPolicySchema,
  DashboardValidationResultSummarySchema,
  maximumDashboardReviewRunResponseUtf8Bytes,
  OperatorReviewRunCreateRequestSchema,
} from "./dashboard-runs.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const digest = "a".repeat(64);
const timestamp = "2026-09-07T10:00:00.000Z";
const checks = { passed: 0, failed: 1, blocked: 0, not_run: 0, skipped: 0, inconclusive: 0 };
const execution = {
  missing: 0,
  awaitingAdmission: 0,
  queued: 0,
  active: 0,
  succeeded: 1,
  failed: 0,
  cancelled: 0,
};
const summary = {
  id: "review-run-1",
  repositoryId: "repository-1",
  repository: "example/project",
  workItemId: "work-item-1",
  workItemKind: "pull_request",
  number: 42,
  title: "Validate the settings dialog",
  revisionKey: digest,
  currentRevisionKey: digest,
  freshness: "current",
  planDigest: digest,
  activationId: "activation-1",
  createdAt: timestamp,
  requestCount: 1,
  requiredRequestCount: 1,
  execution,
};
const job = {
  jobId: "job-1",
  activationNumber: 1,
  status: "succeeded",
  admission: null,
  phase: null,
  attemptCount: 1,
  runAttemptId: "attempt-1",
  createdAt: timestamp,
  startedAt: timestamp,
  completedAt: timestamp,
  failureCode: null,
  failureMessage: null,
  resultId: "result-1",
  resultDigest: digest,
};
const modelReview = {
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
  summary: "The model found no additional concerns.",
  recommendation: "approve",
  findings: [],
  observations: [],
  issueTriage: null,
  reproductionConclusion: null,
  error: null,
};
const findingPreview = {
  id: "finding-1",
  priority: 1,
  title: "The dialog did not open",
  body: "The required UI assertion failed.",
  path: "src/settings.ts",
  line: 42,
};
const resultSummary = {
  id: "result-1",
  resultDigest: digest,
  createdAt: timestamp,
  summary: "The runner completed but a required UI check failed.",
  summaryTruncated: false,
  sourceState: "original",
  checks,
  modelReviewState: "completed",
  recommendation: "approve",
  reproductionConclusion: null,
  findings: [findingPreview],
  findingCount: 1,
  findingsTruncated: false,
  evidenceIds: ["evidence-1"],
  evidenceCount: 1,
  evidenceTruncated: false,
  evidenceComplete: true,
  lifecycleBlockerCount: 0,
};
const request = {
  requestId: "request-1",
  workflowKind: "pr_ui",
  target: "web",
  required: true,
  profile: {
    id: "profile-version-1",
    profileId: "profile-1",
    name: "Web UI checks",
    version: 1,
    configSha256: digest,
  },
  prompt: {
    id: "prompt-version-1",
    templateId: "template-1",
    version: 1,
    contentSha256: digest,
  },
  requiredCheckIds: ["profile-version-1:open-settings"],
  readiness: "ready",
  blockers: [],
  blockersTruncated: false,
  latestJob: job,
  latestResult: resultSummary,
};
const policy = {
  applicable: true,
  eligible: false,
  policyVersion: "required-checks-and-p0-p1-v1",
  reasons: [
    {
      code: "REQUIRED_CHECK_FAILED",
      checkId: "profile-version-1:open-settings",
      requestId: "request-1",
      outcome: "failed",
      reason: "The required UI assertion failed.",
    },
  ],
  reasonCount: 1,
  reasonsTruncated: false,
  blockingFindingCount: 1,
};
const detail = {
  ...summary,
  requestEpochId: "epoch-1",
  testedSourceRevision: {
    kind: "pull_request",
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
  },
  requiredCheckIds: ["profile-version-1:open-settings"],
  requests: [request],
  policy,
};
const check = {
  id: "profile-version-1:open-settings",
  name: "Open settings",
  kind: "ui",
  required: true,
  outcome: "failed",
  summary: "The dialog did not become visible.",
  expected: "The settings dialog is visible.",
  actual: "The settings dialog is absent.",
  evidenceIds: ["evidence-1"],
  source: "runner",
};
const result = {
  id: "result-1",
  repositoryId: "repository-1",
  reviewRunId: "review-run-1",
  workItemId: "work-item-1",
  requestId: "request-1",
  jobId: "job-1",
  runAttemptId: "attempt-1",
  activationNumber: 1,
  authoritative: true,
  revisionKey: digest,
  planDigest: digest,
  profileVersionId: "profile-version-1",
  promptVersionId: "prompt-version-1",
  resultDigest: digest,
  createdAt: timestamp,
  evidenceComplete: true,
  report: {
    schemaVersion: "ValidationReportV1",
    workItemKind: "pull_request",
    source: "worker",
    summary: "A required UI assertion failed.",
    sourceState: "original",
    checks: [check],
  },
  execution: { blockers: [], diagnostics: [], cleanupState: "completed" },
  modelReview,
};

describe("dashboard review run query contracts", () => {
  it("allows one exact job ID only within a complete request scope", () => {
    const query = {
      repositoryId: "repo-1",
      reviewRunId: "run-1",
      requestId: "request-1",
      jobId: "job-1",
    };
    expect(Value.Check(DashboardReviewRunJobListQuerySchema, query)).toBe(true);
    for (const jobId of ["", "../job", ["job-1"], null, "x".repeat(129)])
      expect(Value.Check(DashboardReviewRunJobListQuerySchema, { ...query, jobId })).toBe(false);
    expect(Value.Check(DashboardReviewRunJobListQuerySchema, { jobId: "job-1" })).toBe(false);
  });
  const queries = [
    ["list", DashboardReviewRunListQuerySchema, { repositoryId: "repository-1" }],
    [
      "detail",
      DashboardReviewRunReadQuerySchema,
      { repositoryId: "repository-1", reviewRunId: "review-run-1" },
    ],
    [
      "jobs",
      DashboardReviewRunJobListQuerySchema,
      { repositoryId: "repository-1", reviewRunId: "review-run-1", requestId: "request-1" },
    ],
    [
      "result",
      DashboardReviewRunResultQuerySchema,
      {
        repositoryId: "repository-1",
        reviewRunId: "review-run-1",
        requestId: "request-1",
        jobId: "job-1",
      },
    ],
  ] as const;

  it.each(queries)("requires every scope identifier for %s queries", (_name, schema, valid) => {
    expect(Value.Check(schema, valid)).toBe(true);
    for (const field of Object.keys(valid)) {
      const missing: Record<string, unknown> = { ...valid };
      delete missing[field];
      expect(Value.Check(schema, missing), field).toBe(false);
    }
  });

  it.each(queries)("rejects malformed or ambiguous %s scope", (_name, schema, valid) => {
    for (const repositoryId of [
      "",
      "owner/repo",
      "repository-1,repository-2",
      ["repository-1", "repository-2"],
      "x".repeat(129),
      null,
    ]) {
      expect(Value.Check(schema, { ...valid, repositoryId }), JSON.stringify(repositoryId)).toBe(
        false,
      );
    }
    expect(Value.Check(schema, { ...valid, includePrivate: true })).toBe(false);
  });

  it.each([
    ["list", DashboardReviewRunListQuerySchema, { repositoryId: "repository-1" }],
    [
      "jobs",
      DashboardReviewRunJobListQuerySchema,
      { repositoryId: "repository-1", reviewRunId: "review-run-1", requestId: "request-1" },
    ],
  ] as const)("bounds %s pagination to 50", (_name, schema, valid) => {
    expect(Value.Check(schema, { ...valid, page: 2, pageSize: 50 })).toBe(true);
    for (const pageSize of [0, -1, 1.5, 51, "50", [50], null]) {
      expect(Value.Check(schema, { ...valid, pageSize }), JSON.stringify(pageSize)).toBe(false);
    }
    for (const page of [0, -1, 1.5, "2", [2], null]) {
      expect(Value.Check(schema, { ...valid, page }), JSON.stringify(page)).toBe(false);
    }
  });

  it("allows an exact work item filter only on list and detail queries", () => {
    expect(
      Value.Check(DashboardReviewRunListQuerySchema, {
        repositoryId: "repository-1",
        workItemId: "work-item-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(DashboardReviewRunReadQuerySchema, {
        repositoryId: "repository-1",
        reviewRunId: "review-run-1",
        workItemId: "work-item-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(DashboardReviewRunResultQuerySchema, {
        ...queries[3][2],
        workItemId: "work-item-1",
      }),
    ).toBe(false);
  });
});

describe("operator review run creation contracts", () => {
  const createRequest = { activationId: "activation-1", expectedRevisionKey: digest };

  it("requires a stable activation identity and expected revision digest", () => {
    expect(Value.Check(OperatorReviewRunCreateRequestSchema, createRequest)).toBe(true);
    expect(Value.Check(OperatorReviewRunCreateRequestSchema, { expectedRevisionKey: digest })).toBe(
      false,
    );
    expect(
      Value.Check(OperatorReviewRunCreateRequestSchema, { activationId: "activation-1" }),
    ).toBe(false);
    expect(
      Value.Check(OperatorReviewRunCreateRequestSchema, {
        ...createRequest,
        expectedRevisionKey: "revision-1",
      }),
    ).toBe(false);
  });

  it.each([40, 64])("accepts an exact %s-character source commit", (length) => {
    expect(
      Value.Check(OperatorReviewRunCreateRequestSchema, {
        ...createRequest,
        testedSourceCommit: "a".repeat(length),
      }),
    ).toBe(true);
  });

  it.each([
    "main",
    "HEAD",
    "refs/heads/main",
    "abc1234",
    "a".repeat(39),
    "a".repeat(41),
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(40),
    "g".repeat(40),
    `${"a".repeat(40)}\n`,
    null,
  ])("rejects a noncanonical source commit %j", (testedSourceCommit) => {
    expect(
      Value.Check(OperatorReviewRunCreateRequestSchema, { ...createRequest, testedSourceCommit }),
    ).toBe(false);
  });

  it("bounds unique selected profile identities to between one and 32", () => {
    expect(
      Value.Check(OperatorReviewRunCreateRequestSchema, {
        ...createRequest,
        profileIds: ["profile-1"],
      }),
    ).toBe(true);
    expect(
      Value.Check(OperatorReviewRunCreateRequestSchema, {
        ...createRequest,
        profileIds: Array.from({ length: 32 }, (_, index) => `profile-${index}`),
      }),
    ).toBe(true);
    for (const profileIds of [
      [],
      ["profile-1", "profile-1"],
      ["owner/profile"],
      Array.from({ length: 33 }, (_, index) => `profile-${index}`),
      "profile-1",
      null,
    ]) {
      expect(
        Value.Check(OperatorReviewRunCreateRequestSchema, { ...createRequest, profileIds }),
      ).toBe(false);
    }
  });

  it.each([
    "repositoryId",
    "workItemId",
    "plan",
    "promptVersionId",
    "config",
    "authorization",
    "testedSourceAuthorization",
    "requiredCheckIds",
  ])("rejects the caller-supplied field %s", (field) => {
    expect(
      Value.Check(OperatorReviewRunCreateRequestSchema, { ...createRequest, [field]: "untrusted" }),
    ).toBe(false);
  });
});

describe("dashboard review run dimensions", () => {
  it("retains completed CLI execution metadata and requires an explicit nullable projection", () => {
    expect(Value.Check(DashboardValidationModelReviewSchema, modelReview)).toBe(true);
    expect(
      Value.Check(DashboardValidationModelReviewSchema, { ...modelReview, execution: null }),
    ).toBe(true);
    const { execution: _omitted, ...missingExecution } = modelReview;
    expect(Value.Check(DashboardValidationModelReviewSchema, missingExecution)).toBe(false);
    expect(
      Value.Check(DashboardValidationModelReviewSchema, {
        ...modelReview,
        execution: { ...modelReview.execution, exitCode: 1 },
      }),
    ).toBe(false);
  });

  it("keeps successful execution, failed validation, model approval, and ineligibility separate", () => {
    expect(Value.Check(DashboardReviewRunDetailSchema, detail)).toBe(true);
    expect(Value.Check(DashboardReviewRunResultSchema, result)).toBe(true);
    expect(detail.execution.succeeded).toBe(1);
    expect(detail.requests[0]?.latestResult.checks.failed).toBe(1);
    expect(result.modelReview.recommendation).toBe("approve");
    expect(detail.policy.eligible).toBe(false);
  });

  it("represents a missing result and an explicit readiness blocker without inventing success", () => {
    expect(
      Value.Check(DashboardReviewRunRequestSchema, {
        ...request,
        profile: null,
        prompt: null,
        readiness: "blocked",
        blockers: ["The required profile has no enabled published version."],
        latestJob: null,
        latestResult: null,
      }),
    ).toBe(true);
  });

  it("represents a required pending Job with its real identity and an admission blocker", () => {
    const pending = {
      ...request,
      required: true,
      blockers: ["execution_awaiting_admission"],
      latestJob: {
        ...job,
        status: "queued",
        attemptCount: 0,
        admission: {
          state: "pending",
          attemptBase: 0,
          requestedAt: timestamp,
          timestampBasis: "recorded",
          admittedAt: null,
        },
        runAttemptId: null,
        startedAt: null,
        completedAt: null,
        resultId: null,
        resultDigest: null,
      },
      latestResult: null,
    };
    expect(Value.Check(DashboardReviewRunRequestSchema, pending)).toBe(true);
    const { admission: _omitted, ...missingAdmission } = pending.latestJob;
    expect(Value.Check(DashboardReviewRunJobSchema, missingAdmission)).toBe(false);
  });

  it.each(["failed", "not_requested"])("can report model state %s independently", (state) => {
    expect(
      Value.Check(DashboardReviewRunResultSchema, {
        ...result,
        modelReview: {
          ...modelReview,
          state,
          execution: null,
          summary: null,
          recommendation: null,
          error:
            state === "failed"
              ? { code: "MODEL_FAILED", message: "Model execution failed." }
              : null,
        },
      }),
    ).toBe(true);
  });

  it("represents Issue reproduction with an inapplicable approval policy", () => {
    expect(
      Value.Check(DashboardReviewRunDetailSchema, {
        ...detail,
        workItemKind: "issue",
        testedSourceRevision: { kind: "commit", headSha: "c".repeat(40) },
        requests: [{ ...request, workflowKind: "issue_validation" }],
        policy: {
          ...policy,
          applicable: false,
          eligible: null,
          reasons: [],
          reasonCount: 0,
          blockingFindingCount: 0,
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(DashboardReviewRunResultSchema, {
        ...result,
        report: { ...result.report, workItemKind: "issue", reproductionConclusion: "confirmed" },
        modelReview: { ...modelReview, recommendation: null, reproductionConclusion: "confirmed" },
      }),
    ).toBe(true);
  });

  it.each([true, false])(
    "rejects a boolean approval eligibility for Issue results (%s)",
    (eligible) => {
      expect(
        Value.Check(DashboardReviewRunDetailSchema, {
          ...detail,
          workItemKind: "issue",
          policy: { ...policy, applicable: false, eligible },
        }),
      ).toBe(false);
    },
  );

  it("rejects an applicable Issue approval policy and an inapplicable PR policy", () => {
    expect(Value.Check(DashboardReviewRunDetailSchema, { ...detail, workItemKind: "issue" })).toBe(
      false,
    );
    expect(
      Value.Check(DashboardReviewRunDetailSchema, {
        ...detail,
        policy: { ...policy, applicable: false, eligible: null },
      }),
    ).toBe(false);
    expect(Value.Check(DashboardValidationPolicySchema, { ...policy, eligible: null })).toBe(false);
  });

  it("does not permit execution states to replace validation outcomes or model authority", () => {
    expect(Value.Check(DashboardValidationOutcomeCountsSchema, execution)).toBe(false);
    expect(Value.Check(DashboardReviewRunExecutionCountsSchema, checks)).toBe(false);
    expect(
      Value.Check(DashboardValidationModelReviewSchema, { ...modelReview, eligible: true }),
    ).toBe(false);
    expect(
      Value.Check(DashboardReviewRunResultSchema, {
        ...result,
        report: { ...result.report, checks: [{ ...check, outcome: "succeeded" }] },
      }),
    ).toBe(false);
  });
});

describe("dashboard review run response bounds", () => {
  it.each([
    ["summary", DashboardValidationResultSummarySchema, resultSummary],
    ["result", DashboardReviewRunResultSchema, result],
  ] as const)(
    "represents pending verification explicitly in the %s projection",
    (_name, schema, value) => {
      expect(
        Value.Check(schema, {
          ...value,
          evidenceComplete: false,
          evidenceVerificationPending: true,
        }),
      ).toBe(true);
      expect(Value.Check(schema, value)).toBe(true);
      expect(Value.Check(schema, { ...value, evidenceVerificationPending: false })).toBe(false);
      expect(Value.Check(schema, { ...value, evidenceVerificationPending: "pending" })).toBe(false);
    },
  );
  it.each([
    ["runs", DashboardReviewRunListResponseSchema, summary],
    ["jobs", DashboardReviewRunJobListResponseSchema, job],
  ] as const)("bounds %s pages and rejects unknown pagination metadata", (name, schema, item) => {
    const response = {
      ...(name === "jobs"
        ? { repositoryId: "repo-1", reviewRunId: "run-1", requestId: "request-1" }
        : {}),
      items: Array.from({ length: 50 }, () => item),
      total: 50,
      page: 1,
      pageSize: 50,
    };
    expect(Value.Check(schema, response)).toBe(true);
    expect(Value.Check(schema, { ...response, items: [...response.items, item] })).toBe(false);
    expect(Value.Check(schema, { ...response, pageSize: 51 })).toBe(false);
    expect(Value.Check(schema, { ...response, total: -1 })).toBe(false);
    expect(Value.Check(schema, { ...response, privateCursor: "secret" })).toBe(false);
  });

  it.each(["repositoryId", "reviewRunId", "requestId"] as const)(
    "requires job history response %s",
    (key) => {
      const response = {
        repositoryId: "repo-1",
        reviewRunId: "run-1",
        requestId: "request-1",
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
      };
      expect(Value.Check(DashboardReviewRunJobListResponseSchema, response)).toBe(true);
      const { [key]: _scope, ...missingScope } = response;
      expect(Value.Check(DashboardReviewRunJobListResponseSchema, missingScope)).toBe(false);
      expect(
        Value.Check(DashboardReviewRunJobListResponseSchema, { ...response, [key]: "wrong/scope" }),
      ).toBe(false);
    },
  );

  it("bounds the request inventory and qualified required checks", () => {
    expect(Value.Check(DashboardReviewRunDetailSchema, { ...detail, requests: [] })).toBe(false);
    expect(
      Value.Check(DashboardReviewRunDetailSchema, {
        ...detail,
        requests: Array.from({ length: 33 }, () => request),
      }),
    ).toBe(false);
    expect(
      Value.Check(DashboardReviewRunRequestSchema, {
        ...request,
        requiredCheckIds: ["unqualified"],
      }),
    ).toBe(false);
    expect(
      Value.Check(DashboardReviewRunRequestSchema, {
        ...request,
        requiredCheckIds: [...request.requiredCheckIds, ...request.requiredCheckIds],
      }),
    ).toBe(false);
    expect(
      Value.Check(DashboardReviewRunRequestSchema, {
        ...request,
        requiredCheckIds: Array.from(
          { length: 97 },
          (_, index) => `profile-version-1:step-${index}`,
        ),
      }),
    ).toBe(false);
  });

  it("bounds finding and evidence previews while preserving full counts and truncation flags", () => {
    const bounded = {
      ...resultSummary,
      summary: "s".repeat(1_024),
      summaryTruncated: true,
      findings: Array.from({ length: 8 }, (_, index) => ({
        ...findingPreview,
        id: `finding-${index}`,
      })),
      findingCount: 100,
      findingsTruncated: true,
      evidenceIds: Array.from({ length: 32 }, (_, index) => `evidence-${index}`),
      evidenceCount: 100,
      evidenceTruncated: true,
    };
    expect(Value.Check(DashboardValidationResultSummarySchema, bounded)).toBe(true);
    for (const invalid of [
      { ...bounded, summary: "s".repeat(1_025) },
      { ...bounded, findings: [...bounded.findings, findingPreview] },
      { ...bounded, evidenceIds: [...bounded.evidenceIds, "evidence-33"] },
      { ...bounded, evidenceIds: ["evidence-1", "evidence-1"] },
      { ...bounded, findings: [{ ...findingPreview, body: "b".repeat(513) }] },
      { ...bounded, findingCount: -1 },
      { ...bounded, evidenceCount: -1 },
    ]) {
      expect(Value.Check(DashboardValidationResultSummarySchema, invalid)).toBe(false);
    }
  });

  it("bounds policy reasons without dropping the total reason count", () => {
    const reason = { code: "MISSING_EVIDENCE", reason: "Required evidence is unavailable." };
    const bounded = {
      ...policy,
      reasons: Array.from({ length: 128 }, () => reason),
      reasonCount: 200,
      reasonsTruncated: true,
    };
    expect(Value.Check(DashboardValidationPolicySchema, bounded)).toBe(true);
    expect(
      Value.Check(DashboardValidationPolicySchema, {
        ...bounded,
        reasons: [...bounded.reasons, reason],
      }),
    ).toBe(false);
    expect(
      Value.Check(DashboardValidationPolicySchema, { ...bounded, policyVersion: "unknown" }),
    ).toBe(false);
  });

  it("bounds full report checks, model text, and diagnostic output", () => {
    expect(
      Value.Check(DashboardReviewRunResultSchema, {
        ...result,
        report: { ...result.report, checks: Array.from({ length: 161 }, () => check) },
      }),
    ).toBe(false);
    expect(
      Value.Check(DashboardReviewRunResultSchema, {
        ...result,
        modelReview: { ...modelReview, summary: "s".repeat(8_193) },
      }),
    ).toBe(false);
    const diagnostic = {
      stepId: check.id,
      phase: "ui",
      outcome: "failed",
      exitCode: 1,
      summary: "The assertion failed.",
      stdout: "o".repeat(4_096),
      stderr: "e".repeat(4_096),
    };
    expect(
      Value.Check(DashboardReviewRunResultSchema, {
        ...result,
        execution: { ...result.execution, diagnostics: [diagnostic] },
      }),
    ).toBe(true);
    for (const field of ["stdout", "stderr"]) {
      expect(
        Value.Check(DashboardReviewRunResultSchema, {
          ...result,
          execution: {
            ...result.execution,
            diagnostics: [{ ...diagnostic, [field]: "x".repeat(4_097) }],
          },
        }),
      ).toBe(false);
    }
    expect(maximumDashboardReviewRunResponseUtf8Bytes).toBe(2 * 1024 * 1024);
  });
});

describe("dashboard review run configuration redaction", () => {
  it.each([
    "plan",
    "frozenPlan",
    "authorizationPolicy",
    "testedSourceAuthorization",
    "renderedPrompt",
    "promptContent",
    "config",
    "environment",
    "secretRefs",
    "workspaceRoot",
    "privateMetadata",
  ])("rejects the private field %s from every response envelope", (field) => {
    for (const [schema, valid] of [
      [DashboardReviewRunSummarySchema, summary],
      [DashboardReviewRunDetailSchema, detail],
      [DashboardReviewRunRequestSchema, request],
      [DashboardReviewRunJobSchema, job],
      [DashboardValidationResultSummarySchema, resultSummary],
      [DashboardReviewRunResultSchema, result],
    ] as const) {
      expect(Value.Check(schema, { ...valid, [field]: "private" })).toBe(false);
    }
  });

  it("returns version identities and digests without published prompt or profile content", () => {
    expect(Value.Check(DashboardReviewRunRequestSchema, request)).toBe(true);
    for (const field of [
      "content",
      "draftContent",
      "renderedContent",
      "environment",
      "secretRef",
    ]) {
      expect(
        Value.Check(DashboardReviewRunRequestSchema, {
          ...request,
          prompt: { ...request.prompt, [field]: "private" },
        }),
      ).toBe(false);
    }
    for (const field of ["config", "setup", "command", "environment", "secretRef"]) {
      expect(
        Value.Check(DashboardReviewRunRequestSchema, {
          ...request,
          profile: { ...request.profile, [field]: "private" },
        }),
      ).toBe(false);
    }
  });

  it("rejects private fields injected into report, execution, model, or policy objects", () => {
    for (const field of ["report", "execution", "modelReview"] as const) {
      expect(
        Value.Check(DashboardReviewRunResultSchema, {
          ...result,
          [field]: { ...result[field], privateMetadata: "private" },
        }),
      ).toBe(false);
    }
    expect(
      Value.Check(DashboardReviewRunDetailSchema, {
        ...detail,
        policy: { ...policy, authorizationPolicy: "private" },
      }),
    ).toBe(false);
    expect(
      Value.Check(DashboardReviewRunResultSchema, {
        ...result,
        report: { ...result.report, checks: [{ ...check, secretRef: "private" }] },
      }),
    ).toBe(false);
  });
});

describe("versioned finding disposition policies", () => {
  const policyV2 = {
    ...policy,
    policyVersion: "required-checks-and-unresolved-p0-p1-v2",
    blockingFindingCount: 2,
    unresolvedBlockingFindingCount: 0,
    findingDispositionDigest: digest,
    eligible: true,
    reasons: [],
    reasonCount: 0,
  };

  it.each([policy, policyV2])("preserves PR/Issue applicability for $policyVersion", (value) => {
    expect(Value.Check(DashboardValidationPolicySchema, value)).toBe(true);
    expect(Value.Check(DashboardReviewRunDetailSchema, { ...detail, policy: value })).toBe(true);
    const issuePolicy = { ...value, applicable: false, eligible: null };
    expect(Value.Check(DashboardValidationPolicySchema, issuePolicy)).toBe(true);
    expect(
      Value.Check(DashboardReviewRunDetailSchema, {
        ...detail,
        workItemKind: "issue",
        policy: issuePolicy,
      }),
    ).toBe(true);
    for (const invalid of [
      { ...value, eligible: null },
      { ...issuePolicy, eligible: true },
      { ...issuePolicy, eligible: false },
    ]) {
      expect(Value.Check(DashboardValidationPolicySchema, invalid)).toBe(false);
    }
    expect(
      Value.Check(DashboardReviewRunDetailSchema, {
        ...detail,
        workItemKind: "issue",
        policy: value,
      }),
    ).toBe(false);
    expect(Value.Check(DashboardReviewRunDetailSchema, { ...detail, policy: issuePolicy })).toBe(
      false,
    );
  });

  it("keeps legacy objects exact and requires both disposition fields in V2", () => {
    for (const field of ["unresolvedBlockingFindingCount", "findingDispositionDigest"] as const) {
      const missing: Record<string, unknown> = { ...policyV2 };
      delete missing[field];
      expect(Value.Check(DashboardValidationPolicySchema, missing)).toBe(false);
      expect(
        Value.Check(DashboardValidationPolicySchema, { ...policy, [field]: policyV2[field] }),
      ).toBe(false);
    }
    expect(
      Value.Check(DashboardValidationPolicySchema, {
        ...policyV2,
        policyVersion: "required-checks-and-p0-p1-v1",
      }),
    ).toBe(false);
  });

  it("retains raw blocking findings when disposition removes the current policy blocker", () => {
    expect(policyV2.blockingFindingCount).toBeGreaterThan(policyV2.unresolvedBlockingFindingCount);
    expect(Value.Check(DashboardValidationPolicySchema, policyV2)).toBe(true);
    expect(
      Value.Check(DashboardValidationPolicySchema, {
        ...policyV2,
        eligible: false,
        unresolvedBlockingFindingCount: 2,
        reasons: [{ code: "blocking_finding" }],
        reasonCount: 1,
      }),
    ).toBe(true);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, "0", null])(
    "rejects an invalid unresolved count %j",
    (unresolvedBlockingFindingCount) => {
      expect(
        Value.Check(DashboardValidationPolicySchema, {
          ...policyV2,
          unresolvedBlockingFindingCount,
        }),
      ).toBe(false);
    },
  );

  it.each([
    "",
    "a".repeat(40),
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    `${digest}\n`,
    null,
  ])("requires an exact disposition digest %j", (findingDispositionDigest) => {
    expect(
      Value.Check(DashboardValidationPolicySchema, { ...policyV2, findingDispositionDigest }),
    ).toBe(false);
  });
});
