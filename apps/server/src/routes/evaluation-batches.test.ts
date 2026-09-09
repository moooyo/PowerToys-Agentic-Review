import * as C from "@agentic-review/contracts";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseRequestError } from "../database/errors.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { registerEvaluationBatchRoutes } from "./evaluation-batches.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";
import {
  operatorConfigurationRateLimits,
  registerOperatorConfigurationRateLimits,
} from "./operator-rate-limit.js";
import { registerReviewRunRoutes } from "./review-runs.js";

const actor = { issuer: "https://evaluations.example.test", subject: "operator-a" };
const origin = "https://review.example.test";
const token = "B".repeat(43);
const now = "2026-09-08T00:00:00.000Z";
const root = "/api/v1/operator/repositories/repository-a";
const batchesPath = `${root}/evaluations`;
const batchPath = `${batchesPath}/evaluation-a`;
const resultPath = `${batchPath}/cells/cell-baseline/results/result-baseline`;
const promptPath = `${root}/evaluation-prompt-options?workflowKind=pr_static_build`;
const createRequest: C.EvaluationBatchCreateRequest = {
  changeId: "create-a",
  suiteId: "suite-a",
  suiteVersionId: "suite-version-a",
  baseline: { profileVersionId: "profile-baseline", promptVersionId: "prompt-baseline" },
  candidate: { profileVersionId: "profile-candidate", promptVersionId: "prompt-candidate" },
  mode: "prompt_and_profile",
  checkMappings: [
    {
      caseId: "case-a",
      criterionId: "criterion-a",
      baselineCheckId: "profile-baseline:build",
      candidateCheckId: "profile-candidate:build",
    },
  ],
};
const summary: C.EvaluationBatchSummaryV1 = {
  schemaVersion: "EvaluationBatchSummaryV1",
  id: "evaluation-a",
  repositoryId: "repository-a",
  suiteId: createRequest.suiteId,
  suiteVersionId: createRequest.suiteVersionId,
  workflowKind: "pr_static_build",
  target: "headless",
  mode: createRequest.mode,
  baseline: createRequest.baseline,
  candidate: createRequest.candidate,
  caseCount: 1,
  cellCount: 2,
  createdAt: now,
  createdBy: actor,
};
const cancelRequest: C.EvaluationBatchCancelRequest = {
  changeId: "cancel-a",
  expectedVersion: 1,
  reason: "Cancel this comparison.",
};
const cancellation: C.EvaluationBatchCancellationV1 = {
  schemaVersion: "EvaluationBatchCancellationV1",
  evaluationId: summary.id,
  repositoryId: summary.repositoryId,
  status: "cancelled",
  version: 2,
  reason: cancelRequest.reason,
  cancelledAt: now,
  cancelledBy: actor,
  cancelledJobCount: 1,
  cancellationRequestedJobCount: 1,
};
const progress: C.EvaluationBatchProgress = {
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
const listItem: C.EvaluationBatchListItemV1 = {
  summary,
  suiteName: "Known examples",
  status: "pending",
  controlStatus: "active",
  controlVersion: 1,
  progress,
};
const list: C.EvaluationBatchListV1 = {
  schemaVersion: "EvaluationBatchListV1",
  repositoryId: summary.repositoryId,
  page: 1,
  pageSize: 20,
  total: 1,
  items: [listItem],
};
function profile(arm: "baseline" | "candidate"): C.ValidationProfileVersionSummary {
  return {
    id: `profile-${arm}`,
    profileId: `profile-root-${arm}`,
    repositoryId: summary.repositoryId,
    version: 1,
    name: `Profile ${arm}`,
    required: true,
    configSha256: "b".repeat(64),
    createdAt: now,
    publishedAt: now,
    createdBy: JSON.stringify([actor.issuer, actor.subject]),
    workflowKind: "pr_static_build",
    target: "headless",
    outputSchemaVersion: "PrReviewPlanV2",
  };
}
function prompt(arm: "baseline" | "candidate"): C.PromptVersionSummary {
  return {
    id: `prompt-${arm}`,
    templateId: `template-${arm}`,
    version: 1,
    contentSha256: "c".repeat(64),
    outputSchemaVersion: "PrReviewPlanV2",
    createdAt: now,
    publishedAt: now,
    createdBy: JSON.stringify([actor.issuer, actor.subject]),
  };
}
const detail: C.EvaluationBatchDetailV1 = {
  schemaVersion: "EvaluationBatchDetailV1",
  ...listItem,
  suiteVersion: {
    schemaVersion: "EvaluationSuiteVersionV1",
    id: summary.suiteVersionId,
    suiteId: summary.suiteId,
    repositoryId: summary.repositoryId,
    workflowKind: summary.workflowKind,
    target: summary.target,
    version: 1,
    sourceDraftRevision: 2,
    name: listItem.suiteName,
    description: "Frozen known examples.",
    sourceVersionId: "source-version-a",
    expectationVersionId: "expectation-version-a",
    sourceManifestSha256: "d".repeat(64),
    expectationManifestSha256: "e".repeat(64),
    caseCount: 1,
    createdAt: now,
    createdBy: actor,
  },
  control: { status: "active", version: 1, reason: null, updatedAt: now, updatedBy: actor },
  configurations: {
    baseline: {
      profile: profile("baseline"),
      prompt: prompt("baseline"),
      modelRequirements: { required: true, expectedModelIdentityDigest: null },
    },
    candidate: {
      profile: profile("candidate"),
      prompt: prompt("candidate"),
      modelRequirements: { required: true, expectedModelIdentityDigest: null },
    },
  },
};
const source: C.EvaluationSourceSummaryV1 = {
  schemaVersion: "EvaluationSourceSummaryV1",
  id: "source-a",
  repositoryId: summary.repositoryId,
  workItemId: "item-a",
  revisionId: "revision-a",
  revisionKey: "a".repeat(64),
  sourceDigest: "f".repeat(64),
  workItemKind: "pull_request",
  number: 7,
  title: "Known regression",
  createdAt: now,
  createdBy: actor,
};
function cell(arm: "baseline" | "candidate"): C.EvaluationCellSummaryV1 {
  return {
    cellId: `cell-${arm}`,
    caseId: "case-a",
    arm,
    trial: 1,
    runId: `run-${arm}`,
    requestId: `request-${arm}`,
    sourceId: source.id,
    sourceDigest: source.sourceDigest,
    profileVersionId: `profile-${arm}`,
    promptVersionId: `prompt-${arm}`,
    state: "not_run",
    job: null,
    result: null,
    blockerCount: 0,
    blockers: [],
  };
}
const matrix: C.EvaluationBatchMatrixV1 = {
  schemaVersion: "EvaluationBatchMatrixV1",
  repositoryId: summary.repositoryId,
  evaluationId: summary.id,
  suiteVersionId: summary.suiteVersionId,
  status: "pending",
  progress,
  cases: [
    {
      caseId: "case-a",
      title: "Known regression",
      applicability: { state: "applicable" },
      source,
      baseline: cell("baseline"),
      candidate: cell("candidate"),
    },
  ],
};
function waitingMatrix(
  jobStatus: "queued" | "retry_waiting",
  admissionState: "pending" | "admitted",
): C.EvaluationBatchMatrixV1 {
  const attemptCount = jobStatus === "retry_waiting" ? 1 : 0;
  const episode = {
    attemptBase: attemptCount,
    requestedAt: now,
    timestampBasis: "recorded" as const,
  };
  const admission: C.JobAdmission =
    admissionState === "pending"
      ? { ...episode, state: "pending", admittedAt: null }
      : { ...episode, state: "admitted", admittedAt: now };
  const state = admissionState === "pending" ? "awaiting_admission" : "queued";
  const waitingCell = (value: C.EvaluationCellSummaryV1): C.EvaluationCellSummaryV1 => ({
    ...value,
    state,
    job: {
      jobId: `job-${value.arm}`,
      status: jobStatus,
      attemptCount,
      admission,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      failureCode: null,
    },
  });
  return {
    ...matrix,
    status: state,
    progress: {
      ...progress,
      not_run: 0,
      awaiting_admission: admissionState === "pending" ? 2 : 0,
      queued: admissionState === "admitted" ? 2 : 0,
    },
    cases: matrix.cases.map((entry) => ({
      ...entry,
      baseline: waitingCell(entry.baseline),
      candidate: waitingCell(entry.candidate),
    })),
  };
}

function cancellingMatrix(): C.EvaluationBatchMatrixV1 {
  return {
    ...matrix,
    status: "cancelling",
    progress: { ...progress, not_run: 0, running: 1, cancelled: 1 },
    cases: matrix.cases.map((entry) => ({
      ...entry,
      baseline: {
        ...entry.baseline,
        state: "running",
        job: {
          jobId: "job-baseline",
          status: "cancel_requested",
          attemptCount: 1,
          admission: null,
          createdAt: now,
          startedAt: now,
          completedAt: null,
          failureCode: null,
        },
      },
      candidate: {
        ...entry.candidate,
        state: "cancelled",
        job: {
          jobId: "job-candidate",
          status: "cancelled",
          attemptCount: 0,
          admission: null,
          createdAt: now,
          startedAt: null,
          completedAt: now,
          failureCode: null,
        },
      },
    })),
  };
}
const prompts: C.EvaluationPromptOptionsV1 = {
  schemaVersion: "EvaluationPromptOptionsV1",
  repositoryId: summary.repositoryId,
  workflowKind: "pr_static_build",
  page: 1,
  pageSize: 20,
  total: 1,
  items: [{ ...prompt("baseline"), templateName: "Baseline prompt", visibility: "binding" }],
};
// This synthetic transport DTO exercises response boundaries, not execution attestation.
function resultPayload(): C.EvaluationCellResultV1 {
  return {
    schemaVersion: "EvaluationCellResultV1",
    repositoryId: summary.repositoryId,
    evaluationId: summary.id,
    cellId: "cell-baseline",
    caseId: "case-a",
    runId: "run-baseline",
    requestId: "request-baseline",
    jobId: "job-baseline",
    runAttemptId: "attempt-baseline",
    resultId: "result-baseline",
    workItemId: source.workItemId,
    sourceId: source.id,
    profileVersionId: summary.baseline.profileVersionId,
    promptVersionId: summary.baseline.promptVersionId,
    arm: "baseline",
    trial: 1,
    resultDigest: "1".repeat(64),
    sourceDigest: source.sourceDigest,
    revisionKey: source.revisionKey,
    planDigest: "2".repeat(64),
    executionDigest: "3".repeat(64),
    workflowKind: "pr_static_build",
    target: "headless",
    createdAt: now,
    modelRequirements: { required: true, expectedModelIdentityDigest: null },
    evidenceComplete: false,
    report: {
      schemaVersion: "ValidationReportV1",
      workItemKind: "pull_request",
      source: "worker",
      summary: "Synthetic result payload for the HTTP boundary.",
      sourceState: "original",
      checks: [],
    },
    execution: { blockers: [], diagnostics: [], cleanupState: "completed" },
    modelReview: {
      state: "completed",
      summary: "The original finding remains visible.",
      recommendation: "comment",
      findings: [
        {
          findingId: "finding-a",
          ordinal: 0,
          priority: 2,
          title: "A retained finding",
          body: "Original model finding content.",
          path: "src/example.ts",
          line: 1,
          endLine: null,
          confidence: 0.8,
        },
      ],
      observations: [],
      issueTriage: null,
      reproductionConclusion: null,
      error: null,
    },
    occurrences: [
      {
        key: "4".repeat(64),
        resultId: "result-baseline",
        resultDigest: "1".repeat(64),
        kind: "pr_finding",
        ordinal: 0,
      },
    ],
  };
}
const routes = [
  {
    name: "create",
    operation: "createEvaluationBatch",
    method: "POST",
    path: batchesPath,
    output: summary,
    body: createRequest,
  },
  {
    name: "cancel",
    operation: "cancelEvaluationBatch",
    method: "POST",
    path: `${batchPath}/cancel`,
    output: cancellation,
    body: cancelRequest,
  },
  {
    name: "list",
    operation: "listEvaluationBatches",
    method: "GET",
    path: batchesPath,
    output: list,
  },
  {
    name: "detail",
    operation: "getEvaluationBatch",
    method: "GET",
    path: batchPath,
    output: detail,
  },
  {
    name: "matrix",
    operation: "getEvaluationBatchMatrix",
    method: "GET",
    path: `${batchPath}/matrix`,
    output: matrix,
  },
  {
    name: "cell result",
    operation: "getEvaluationCellResult",
    method: "GET",
    path: resultPath,
    output: resultPayload(),
  },
  {
    name: "prompt options",
    operation: "listEvaluationPromptOptions",
    method: "GET",
    path: promptPath,
    output: prompts,
  },
] as const;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture(
  output: unknown,
  options: {
    authenticated?: boolean;
    readOnly?: boolean;
    rateLimits?: boolean;
    ordinaryResultRoutes?: boolean;
    error?: Error;
  } = {},
) {
  const session = {
    ...actor,
    displayName: "Evaluation operator",
    email: null,
    createdAt: now,
    expiresAt: "2026-09-09T00:00:00.000Z",
  };
  const auth: OperatorAuthRouteService = {
    publicOrigin: origin,
    postLoginRedirectPath: "/",
    requiresLoopbackRequest: false,
    secureCookies: true,
    usesBrowserBinding: false,
    ensureBrowserBinding: vi.fn(() => undefined),
    startLogin: vi.fn(async () => ({ kind: "session" as const, sessionToken: token, session })),
    completeLogin: vi.fn(async () => {
      throw new Error("No external login in route tests.");
    }),
    getSession: vi.fn(async (value) =>
      value === token && options.authenticated !== false ? session : null,
    ),
    logout: vi.fn(async () => undefined),
  };
  const database = createOperatorRouteTestDatabase(actor, async () => {
    if (options.error) throw options.error;
    return output;
  });
  const app = Fastify({ logger: false });
  apps.push(app);
  registerOperatorAuthRoutes(app, auth);
  app.register(async (scope) => {
    if (options.rateLimits) await registerOperatorConfigurationRateLimits(scope, auth);
    registerEvaluationBatchRoutes(scope, {
      database: database.database,
      operatorAuth: auth,
      ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    });
    if (options.ordinaryResultRoutes)
      registerReviewRunRoutes(scope, { database: database.database, operatorAuth: auth });
  });
  return { app, auth, ...database };
}
const headers = () => ({
  host: "review.example.test",
  cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
  origin,
});

describe("evaluation batch HTTP boundary", () => {
  it("binds the result read to all four path identities and the session actor", async () => {
    const output = resultPayload();
    const f = fixture(output, { readOnly: true });
    const response = await f.app.inject({
      method: "GET",
      url: resultPath,
      headers: {
        ...headers(),
        "x-operator-issuer": "https://forged.example",
        "x-operator-subject": "platform-admin",
      },
      payload: {
        actor: { issuer: "https://forged.example", subject: "platform-admin" },
        repositoryId: "foreign-repository",
        resultId: "foreign-result",
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(output);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("getEvaluationCellResult", {
      repositoryId: summary.repositoryId,
      evaluationId: summary.id,
      cellId: "cell-baseline",
      resultId: "result-baseline",
      actor,
    });
    expect(f.transport).toHaveBeenCalledExactlyOnceWith("operatorRequest", {
      context: { kind: "operator", actor },
      operation: "getEvaluationCellResult",
      input: {
        repositoryId: summary.repositoryId,
        evaluationId: summary.id,
        cellId: "cell-baseline",
        resultId: "result-baseline",
        actor,
      },
    });
  });

  it.each(["repositoryId", "evaluationId", "cellId", "resultId"] as const)(
    "rejects a structurally valid result from another %s with a private 502",
    async (field) => {
      const output = resultPayload();
      output[field] = "private-foreign";
      if (field === "resultId")
        output.occurrences = output.occurrences.map((entry) => ({
          ...entry,
          resultId: output.resultId,
        }));
      expect(C.getEvaluationCellResultIssues(output)).toEqual([]);
      const f = fixture(output);
      const response = await f.app.inject({ method: "GET", url: resultPath, headers: headers() });
      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe("evaluation_response_invalid");
      expect(response.body).not.toContain("private-foreign");
      expect(response.body).not.toContain(output.report.summary);
      expect(f.transport).toHaveBeenCalledOnce();
    },
  );

  it("rejects result query selectors, transformed path identities, and mutation methods before dispatch", async () => {
    for (const path of [
      `${resultPath}?page=1`,
      `${resultPath}?resultId=other`,
      `${resultPath}?resultId=result-baseline&resultId=other`,
      `${resultPath}?actor=platform-admin`,
      `${resultPath}?latest=true`,
      resultPath.replace("repository-a", "%20repository-a"),
      resultPath.replace("evaluation-a", "evaluation-a%20"),
      resultPath.replace("cell-baseline", "cell-baseline%0a"),
      resultPath.replace("result-baseline", "result-baseline%20"),
    ]) {
      const f = fixture(resultPayload());
      expect(
        (await f.app.inject({ method: "GET", url: path, headers: headers() })).statusCode,
      ).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const f = fixture(resultPayload());
      expect(
        (await f.app.inject({ method, url: resultPath, headers: headers(), payload: {} }))
          .statusCode,
      ).toBe(404);
      expect(f.transport).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["PLATFORM_NOT_FOUND", 404],
    ["PLATFORM_FORBIDDEN", 403],
  ] as const)("preserves a current result read permission denial: %s", async (code, status) => {
    const f = fixture(resultPayload(), {
      error: new DatabaseRequestError("The result read was denied.", code),
    });
    const response = await f.app.inject({ method: "GET", url: resultPath, headers: headers() });
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code.toLowerCase());
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.transport).toHaveBeenCalledOnce();
  });

  it("rejects corrupted finding and evidence projections without exposing model content", async () => {
    for (const output of [
      { ...resultPayload(), occurrences: [] },
      { ...resultPayload(), evidenceComplete: true, evidenceVerificationPending: true },
      { ...resultPayload(), authoritative: true },
    ]) {
      const f = fixture(output);
      const response = await f.app.inject({ method: "GET", url: resultPath, headers: headers() });
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain("Original model finding content.");
    }
  });

  it("does not expand the ordinary review result response contract to evaluation results", async () => {
    const output = resultPayload();
    const f = fixture(output, { ordinaryResultRoutes: true });
    const response = await f.app.inject({
      method: "GET",
      url: `${root}/review-runs/${output.runId}/requests/${output.requestId}/jobs/${output.jobId}/result`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain(output.report.summary);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("getDashboardReviewRunJobResult", {
      repositoryId: output.repositoryId,
      reviewRunId: output.runId,
      requestId: output.requestId,
      jobId: output.jobId,
    });
  });

  it("preserves current pending and admitted episodes in waiting matrix, list and detail responses", async () => {
    for (const jobStatus of ["queued", "retry_waiting"] as const) {
      for (const admissionState of ["pending", "admitted"] as const) {
        const output = waitingMatrix(jobStatus, admissionState);
        const item = { ...listItem, status: output.status, progress: output.progress };
        for (const candidate of [
          { path: `${batchPath}/matrix`, output },
          { path: batchesPath, output: { ...list, items: [item] } },
          { path: batchPath, output: { ...detail, ...item } },
        ]) {
          const f = fixture(candidate.output);
          const result = await f.app.inject({
            method: "GET",
            url: candidate.path,
            headers: headers(),
          });
          expect(result.statusCode, result.body).toBe(200);
          expect(result.json()).toEqual(candidate.output);
        }
      }
    }
  });

  it("retains cancelling until the active Job settles after a cancellation control change", async () => {
    const output = cancellingMatrix();
    const item = {
      ...listItem,
      status: "cancelling" as const,
      controlStatus: "cancelled" as const,
      controlVersion: 2 as const,
      progress: output.progress,
    };
    const control = {
      status: "cancelled" as const,
      version: 2 as const,
      reason: cancelRequest.reason,
      updatedAt: now,
      updatedBy: actor,
    };
    for (const candidate of [
      { path: `${batchPath}/matrix`, output, invalid: { ...output, status: "cancelled" } },
      {
        path: batchesPath,
        output: { ...list, items: [item] },
        invalid: { ...list, items: [{ ...item, status: "cancelled" }] },
      },
      {
        path: batchPath,
        output: { ...detail, ...item, control },
        invalid: { ...detail, ...item, control, status: "cancelled" },
      },
    ]) {
      const f = fixture(candidate.output);
      const result = await f.app.inject({ method: "GET", url: candidate.path, headers: headers() });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toEqual(candidate.output);
      const invalid = fixture(candidate.invalid);
      expect(
        (await invalid.app.inject({ method: "GET", url: candidate.path, headers: headers() }))
          .statusCode,
      ).toBe(502);
    }
  });

  it("rejects absent, stale and contradictory current admission projections", async () => {
    const invalid = [
      "missing",
      "stale",
      "claimed_admitted",
      "terminal_episode",
      "absent_job",
    ] as const;
    for (const kind of invalid) {
      const output = waitingMatrix("retry_waiting", "pending");
      const entry = output.cases[0];
      if (
        entry === undefined ||
        entry.baseline.job === null ||
        entry.baseline.job.admission === null
      ) {
        throw new Error("The waiting matrix fixture requires a current pending admission episode.");
      }
      if (kind === "missing") entry.baseline.job.admission = null;
      else if (kind === "stale") entry.baseline.job.admission.attemptBase = 0;
      else if (kind === "claimed_admitted") {
        entry.baseline.state = "queued";
        output.progress.awaiting_admission = 1;
        output.progress.queued = 1;
        output.status = "queued";
      } else if (kind === "terminal_episode") {
        entry.baseline.job.status = "cancelled";
        entry.baseline.state = "cancelled";
        output.progress.awaiting_admission = 1;
        output.progress.cancelled = 1;
      } else entry.baseline.job = null;
      const f = fixture(output);
      expect(
        (await f.app.inject({ method: "GET", url: `${batchPath}/matrix`, headers: headers() }))
          .statusCode,
      ).toBe(502);
    }
  });

  it.each(routes)("binds $name to the authenticated operator wrapper", async (route) => {
    const f = fixture(route.output);
    const result = await f.app.inject({
      method: route.method,
      url: route.path,
      headers: headers(),
      ...("body" in route ? { payload: route.body } : {}),
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual(route.output);
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      route.operation,
      expect.objectContaining({ repositoryId: summary.repositoryId, actor }),
    );
    expect(f.transport).toHaveBeenCalledExactlyOnceWith(
      "operatorRequest",
      expect.objectContaining({ context: { kind: "operator", actor } }),
    );
    expect(f.request.mock.calls[0]?.[1]).not.toHaveProperty("replayOnly");
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.headers.vary).toBe("Cookie");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
  });

  it.each(routes)("rejects unauthenticated $name before owner dispatch", async (route) => {
    const f = fixture(route.output, { authenticated: false });
    const result = await f.app.inject({
      method: route.method,
      url: route.path,
      headers: headers(),
      ...("body" in route ? { payload: route.body } : {}),
    });
    expect(result.statusCode).toBe(401);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(routes.filter((route) => "body" in route))(
    "requires one exact Origin for $name",
    async (route) => {
      for (const suppliedOrigin of [
        undefined,
        "https://untrusted.example.test",
        [origin, origin],
      ]) {
        const f = fixture(route.output);
        const { origin: _origin, ...other } = headers();
        const result = await f.app.inject({
          method: route.method,
          url: route.path,
          payload: route.body,
          // Inject repeated Origin fields to exercise the HTTP boundary's rejection path.
          headers: {
            ...other,
            ...(suppliedOrigin === undefined ? {} : { origin: suppliedOrigin }),
          } as unknown as NonNullable<InjectOptions["headers"]>,
        });
        expect(result.statusCode).toBe(403);
        expect(f.transport).not.toHaveBeenCalled();
      }
    },
  );

  it.each(routes.filter((route) => "body" in route))(
    "never accepts client authority or replay flags for $name",
    async (route) => {
      for (const extra of [
        { actor },
        { repositoryId: "foreign" },
        { readOnly: false },
        { replayOnly: true },
        { replayOnly: false },
        { authorization: { kind: "operator_evaluation" } },
        { plan: {} },
        { resultId: "old-result" },
        { cellId: "client-cell" },
      ]) {
        const f = fixture(route.output, { readOnly: true });
        const result = await f.app.inject({
          method: route.method,
          url: route.path,
          headers: headers(),
          payload: { ...route.body, ...extra },
        });
        expect(result.statusCode).toBe(400);
        expect(f.transport).not.toHaveBeenCalled();
      }
    },
  );

  it("restricts route mutations to owner-checked replays and preserves the owner's independent read-only denial", async () => {
    for (const route of routes.filter((entry) => "body" in entry)) {
      const f = fixture(route.output, { readOnly: true });
      expect(
        (
          await f.app.inject({
            method: route.method,
            url: route.path,
            headers: headers(),
            payload: route.body,
          })
        ).statusCode,
      ).toBe(200);
      expect(f.request).toHaveBeenCalledExactlyOnceWith(
        route.operation,
        expect.objectContaining({ actor, replayOnly: true, request: route.body }),
      );
      for (const readOnly of [false, true]) {
        const denied = fixture(route.output, {
          readOnly,
          error: new DatabaseRequestError("Recovery maintenance.", "DATABASE_READ_ONLY"),
        });
        const result = await denied.app.inject({
          method: route.method,
          url: route.path,
          headers: headers(),
          payload: route.body,
        });
        expect(result.statusCode).toBe(503);
        expect(result.json()).toMatchObject({ code: "configuration_read_only" });
        expect(denied.request).toHaveBeenCalledOnce();
      }
    }
    for (const route of routes.filter((entry) => entry.method === "GET")) {
      const f = fixture(route.output, { readOnly: true });
      expect(
        (await f.app.inject({ method: "GET", url: route.path, headers: headers() })).statusCode,
      ).toBe(200);
      expect(f.request.mock.calls[0]?.[1]).not.toHaveProperty("replayOnly");
    }
  });

  it("passes exact query filters and integer pagination to the owner", async () => {
    const filtered = fixture({ ...list, page: 2, pageSize: 1, total: 2 });
    expect(
      (
        await filtered.app.inject({
          method: "GET",
          url: `${batchesPath}?page=2&pageSize=1&suiteId=suite-a&workflowKind=pr_static_build`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(200);
    expect(filtered.request).toHaveBeenCalledExactlyOnceWith("listEvaluationBatches", {
      repositoryId: summary.repositoryId,
      actor,
      query: { page: 2, pageSize: 1, suiteId: "suite-a", workflowKind: "pr_static_build" },
    });
    const options = fixture({ ...prompts, page: 2, pageSize: 1, total: 2 });
    expect(
      (
        await options.app.inject({
          method: "GET",
          url: `${promptPath}&page=2&pageSize=1`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(200);
    expect(options.request).toHaveBeenCalledExactlyOnceWith("listEvaluationPromptOptions", {
      repositoryId: summary.repositoryId,
      actor,
      query: { page: 2, pageSize: 1, workflowKind: "pr_static_build" },
    });
  });

  it("rejects unsupported, repeated, missing and unsafe query values before owner dispatch", async () => {
    const paths = [
      `${batchesPath}?page=0`,
      `${batchesPath}?page=01`,
      `${batchesPath}?page=1%0a`,
      `${batchesPath}?page=9007199254740991&pageSize=50`,
      `${batchesPath}?pageSize=51`,
      `${batchesPath}?page=1&page=2`,
      `${batchesPath}?suiteId=%20suite-a`,
      `${batchesPath}?workflowKind=unknown`,
      `${batchesPath}?actor=forged`,
      `${root}/evaluation-prompt-options`,
      `${promptPath}&workflowKind=issue_triage`,
      `${promptPath}&suiteId=suite-a`,
      `${batchPath}?page=1`,
      `${batchPath}/matrix?workflowKind=pr_static_build`,
    ];
    for (const path of paths) {
      const f = fixture(null);
      expect(
        (await f.app.inject({ method: "GET", url: path, headers: headers() })).statusCode,
      ).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
    }
  });

  it("rejects whitespace-bearing IDs and mutation query fields", async () => {
    for (const path of [
      batchPath.replace("repository-a", "%20repository-a"),
      batchPath.replace("evaluation-a", "evaluation-a%20"),
      `${batchPath}/matrix?replayOnly=true`,
    ]) {
      const f = fixture(detail);
      expect(
        (await f.app.inject({ method: "GET", url: path, headers: headers() })).statusCode,
      ).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
    }
    for (const route of routes.filter((entry) => "body" in entry)) {
      const f = fixture(route.output);
      expect(
        (
          await f.app.inject({
            method: route.method,
            url: `${route.path}?replayOnly=false`,
            headers: headers(),
            payload: route.body,
          })
        ).statusCode,
      ).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
    }
  });

  it("rejects inconsistent and foreign response scope without exposing its contents", async () => {
    const cases = [
      {
        path: batchesPath,
        method: "POST",
        payload: createRequest,
        output: { ...summary, repositoryId: "private-foreign" },
      },
      {
        path: batchesPath,
        method: "POST",
        payload: createRequest,
        output: { ...summary, suiteVersionId: "private-foreign" },
      },
      {
        path: batchesPath,
        method: "POST",
        payload: createRequest,
        output: { ...summary, candidate: summary.baseline },
      },
      {
        path: batchesPath,
        method: "POST",
        payload: createRequest,
        output: { ...summary, createdBy: { ...actor, subject: "private-foreign" } },
      },
      {
        path: `${batchPath}/cancel`,
        method: "POST",
        payload: cancelRequest,
        output: { ...cancellation, evaluationId: "private-foreign" },
      },
      {
        path: `${batchPath}/cancel`,
        method: "POST",
        payload: cancelRequest,
        output: { ...cancellation, reason: "private-foreign" },
      },
      {
        path: `${batchPath}/cancel`,
        method: "POST",
        payload: cancelRequest,
        output: { ...cancellation, cancelledBy: { ...actor, subject: "private-foreign" } },
      },
      { path: batchesPath, method: "GET", output: { ...list, repositoryId: "private-foreign" } },
      {
        path: batchPath,
        method: "GET",
        output: { ...detail, summary: { ...summary, id: "private-foreign" } },
      },
      {
        path: `${batchPath}/matrix`,
        method: "GET",
        output: { ...matrix, evaluationId: "private-foreign" },
      },
      { path: promptPath, method: "GET", output: { ...prompts, workflowKind: "issue_triage" } },
      {
        path: promptPath,
        method: "GET",
        output: {
          ...prompts,
          items: [{ ...prompts.items[0], outputSchemaVersion: "IssueTriageV2" }],
        },
      },
    ] as const;
    for (const candidate of cases) {
      const f = fixture(candidate.output);
      const result = await f.app.inject({
        method: candidate.method,
        url: candidate.path,
        headers: headers(),
        ...("payload" in candidate ? { payload: candidate.payload } : {}),
      });
      expect(result.statusCode, result.body).toBe(502);
      expect(result.body).not.toContain("private-foreign");
    }
    const wrongFilter = fixture(list);
    expect(
      (
        await wrongFilter.app.inject({
          method: "GET",
          url: `${batchesPath}?suiteId=another-suite`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(502);
    const wrongPage = fixture({ ...list, page: 2, total: 21 });
    expect(
      (await wrongPage.app.inject({ method: "GET", url: batchesPath, headers: headers() }))
        .statusCode,
    ).toBe(502);
  });

  it("rejects incomplete matrices, impossible progress and private full-content additions", async () => {
    const incomplete = structuredClone(matrix);
    const entry = incomplete.cases[0];
    if (entry === undefined) throw new Error("The matrix fixture requires one case.");
    entry.candidate.cellId = entry.baseline.cellId;
    const impossible = { ...matrix, progress: { ...progress, completed: 1 } };
    const leaked = {
      ...detail,
      configurations: {
        ...detail.configurations,
        baseline: {
          ...detail.configurations.baseline,
          prompt: { ...detail.configurations.baseline.prompt, content: "PRIVATE PROMPT CONTENT" },
        },
      },
    };
    for (const candidate of [
      { path: `${batchPath}/matrix`, output: incomplete },
      { path: `${batchPath}/matrix`, output: impossible },
      { path: batchPath, output: leaked },
      {
        path: promptPath,
        output: { ...prompts, items: [{ ...prompts.items[0], content: "PRIVATE PROMPT CONTENT" }] },
      },
    ]) {
      const f = fixture(candidate.output);
      const result = await f.app.inject({ method: "GET", url: candidate.path, headers: headers() });
      expect(result.statusCode).toBe(502);
      expect(result.body).not.toContain("PRIVATE PROMPT CONTENT");
    }
  });

  it("checks mutation byte limits and semantic mappings before owner dispatch", async () => {
    for (const body of [
      {
        ...createRequest,
        checkMappings: [...createRequest.checkMappings, ...createRequest.checkMappings],
      },
      {
        ...createRequest,
        checkMappings: [{ ...createRequest.checkMappings[0], baselineCheckId: "foreign:build" }],
      },
      { ...createRequest, suiteId: "bad\ud800id" },
      { ...createRequest, suiteId: "suite-a\n" },
      {
        ...createRequest,
        baseline: { ...createRequest.baseline, promptVersionId: "prompt-baseline\n" },
      },
      {
        ...createRequest,
        checkMappings: [{ ...createRequest.checkMappings[0], criterionId: "criterion-a\n" }],
      },
    ]) {
      const f = fixture(summary);
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: batchesPath,
            headers: headers(),
            payload: body,
          })
        ).statusCode,
      ).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
    }
    for (const body of [
      { ...cancelRequest, expectedVersion: 2 },
      { ...cancelRequest, reason: "bad\ud800reason" },
      { ...cancelRequest, changeId: "cancel-a\n" },
    ]) {
      const f = fixture(cancellation);
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: `${batchPath}/cancel`,
            headers: headers(),
            payload: body,
          })
        ).statusCode,
      ).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
    }
    for (const [path, payload] of [
      [
        batchesPath,
        { ...createRequest, claimedPlan: "x".repeat(C.maximumEvaluationBatchRequestUtf8Bytes) },
      ],
      [`${batchPath}/cancel`, { ...cancelRequest, claimedPlan: "x".repeat(16 * 1024) }],
    ] as const) {
      const f = fixture(null);
      expect(
        (await f.app.inject({ method: "POST", url: path, headers: headers(), payload })).statusCode,
      ).toBe(413);
      expect(f.transport).not.toHaveBeenCalled();
    }
  });

  it.each([
    "PLATFORM_NOT_FOUND",
    "PLATFORM_FORBIDDEN",
    "PLATFORM_CONFLICT",
    "PLATFORM_INVALID",
  ] as const)("preserves the owner's %s decision without retrying raw RPC", async (code) => {
    const f = fixture(summary, { error: new DatabaseRequestError("Owner rejection.", code) });
    const result = await f.app.inject({
      method: "POST",
      url: batchesPath,
      headers: headers(),
      payload: createRequest,
    });
    expect(result.statusCode).toBe(
      {
        PLATFORM_NOT_FOUND: 404,
        PLATFORM_FORBIDDEN: 403,
        PLATFORM_CONFLICT: 409,
        PLATFORM_INVALID: 400,
      }[code],
    );
    expect(result.json().code).toBe(code.toLowerCase());
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("does not route unsupported methods or internal execution operations", async () => {
    const f = fixture(null);
    for (const [method, path] of [
      ["PUT", batchesPath],
      ["DELETE", batchPath],
      ["PATCH", `${batchPath}/cancel`],
      ["POST", `${batchPath}/dispatch`],
      ["POST", `${batchPath}/cancelEvaluationJob`],
    ] as const) {
      expect(
        (await f.app.inject({ method, url: path, headers: headers(), payload: {} })).statusCode,
      ).toBe(404);
    }
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("uses the shared mutation rate limit even for owner-checked receipt replay", async () => {
    const f = fixture(summary, { rateLimits: true, readOnly: true });
    for (
      let index = 0;
      index < operatorConfigurationRateLimits.mutationsPerPrincipalPerMinute;
      index += 1
    ) {
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: batchesPath,
            headers: headers(),
            payload: createRequest,
          })
        ).statusCode,
      ).toBe(200);
    }
    const limited = await f.app.inject({
      method: "POST",
      url: batchesPath,
      headers: headers(),
      payload: createRequest,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe("request_rate_limited");
    expect(f.request).toHaveBeenCalledTimes(
      operatorConfigurationRateLimits.mutationsPerPrincipalPerMinute,
    );
  });
});
