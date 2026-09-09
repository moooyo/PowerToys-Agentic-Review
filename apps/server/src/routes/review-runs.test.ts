import type {
  DashboardReviewRunDetail,
  DashboardReviewRunJob,
  DashboardReviewRunJobListResponse,
  DashboardReviewRunListResponse,
  DashboardReviewRunReproductionCaseResponse,
  DashboardReviewRunResult,
  DashboardReviewRunSummary,
  DashboardValidationResultSummary,
  OperatorReviewRunCreateRequest,
} from "@agentic-review/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import type { OperatorRequestInput } from "../database/operator-request.js";
import type { OperatorReviewRunOperationMap } from "../database/operator-review-runs.js";
import type { OperatorSession } from "../security/operator-auth.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { registerReviewRunRoutes } from "./review-runs.js";

const publicOrigin = "https://review.example.com";
const sessionToken = "S".repeat(43);
const timestamp = "2026-09-07T10:00:00.000Z";
const repositoryId = "repository-1";
const workItemId = "work-item-1";
const reviewRunId = "review-run-1";
const requestId = "request-1";
const jobId = "job-1";
const digest = "a".repeat(64);
const listPath = `/api/v1/operator/repositories/${repositoryId}/review-runs`;
const createPath = `/api/v1/operator/repositories/${repositoryId}/work-items/${workItemId}/review-runs`;
const detailPath = `${listPath}/${reviewRunId}`;
const jobsPath = `${detailPath}/requests/${requestId}/jobs`;
const resultPath = `${jobsPath}/${jobId}/result`;
const casePath = `${detailPath}/requests/${requestId}/reproduction-cases/case-1`;

const session: OperatorSession = {
  issuer: "https://identity.example.com",
  subject: "ordinary-user-123",
  displayName: "Ordinary User",
  email: "user@example.com",
  createdAt: timestamp,
  expiresAt: "2026-09-07T11:00:00.000Z",
};
const actor = { issuer: session.issuer, subject: session.subject };
const envelope = (operation: string, input: unknown) => ({
  context: { kind: "operator", actor },
  operation,
  input,
});
const createRequest = {
  activationId: "activation-1",
  expectedRevisionKey: digest,
  profileIds: ["profile-1"],
  testedSourceCommit: "c".repeat(40),
} satisfies OperatorReviewRunCreateRequest;
const createdRunIdentity = {
  id: reviewRunId,
  repositoryId,
  workItemId,
  activationId: createRequest.activationId,
} satisfies Pick<
  OperatorReviewRunOperationMap["createOperatorReviewRun"]["output"],
  "id" | "repositoryId" | "workItemId" | "activationId"
>;
const summary = {
  id: reviewRunId,
  repositoryId,
  repository: "example/project",
  workItemId,
  workItemKind: "pull_request",
  number: 42,
  title: "Validate the settings dialog",
  revisionKey: digest,
  currentRevisionKey: digest,
  freshness: "current",
  planDigest: digest,
  activationId: createRequest.activationId,
  createdAt: timestamp,
  requestCount: 1,
  requiredRequestCount: 1,
  execution: {
    missing: 0,
    awaitingAdmission: 0,
    queued: 0,
    active: 0,
    succeeded: 1,
    failed: 0,
    cancelled: 0,
  },
} satisfies DashboardReviewRunSummary;
const job = {
  jobId,
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
} satisfies DashboardReviewRunJob;
const resultSummary = {
  id: "result-1",
  resultDigest: digest,
  createdAt: timestamp,
  summary: "Validation completed without additional findings.",
  summaryTruncated: false,
  sourceState: "original",
  checks: { passed: 0, failed: 0, blocked: 0, not_run: 0, skipped: 0, inconclusive: 0 },
  modelReviewState: "not_requested",
  recommendation: null,
  reproductionConclusion: null,
  findings: [],
  findingCount: 0,
  findingsTruncated: false,
  evidenceIds: [],
  evidenceCount: 0,
  evidenceTruncated: false,
  evidenceComplete: true,
  lifecycleBlockerCount: 0,
} satisfies DashboardValidationResultSummary;
const detail = {
  ...summary,
  requestEpochId: "epoch-1",
  testedSourceRevision: {
    kind: "pull_request",
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
  },
  requiredCheckIds: [],
  requests: [
    {
      requestId,
      workflowKind: "pr_static_build",
      target: "headless",
      required: true,
      profile: {
        id: "profile-version-1",
        profileId: "profile-1",
        name: "Static checks",
        version: 1,
        configSha256: digest,
      },
      prompt: {
        id: "prompt-version-1",
        templateId: "template-1",
        version: 1,
        contentSha256: digest,
      },
      requiredCheckIds: [],
      readiness: "ready",
      blockers: [],
      blockersTruncated: false,
      latestJob: job,
      latestResult: resultSummary,
    },
  ],
  policy: {
    applicable: true,
    eligible: true,
    policyVersion: "required-checks-and-p0-p1-v1",
    reasons: [],
    reasonCount: 0,
    reasonsTruncated: false,
    blockingFindingCount: 0,
  },
} satisfies DashboardReviewRunDetail;
const result = {
  id: "result-1",
  repositoryId,
  reviewRunId,
  workItemId,
  requestId,
  jobId,
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
    summary: resultSummary.summary,
    sourceState: "original",
    checks: [],
  },
  execution: { blockers: [], diagnostics: [], cleanupState: "completed" },
  modelReview: {
    state: "not_requested",
    summary: null,
    recommendation: null,
    findings: [],
    observations: [],
    issueTriage: null,
    reproductionConclusion: null,
    error: null,
    execution: null,
  },
} satisfies DashboardReviewRunResult;
const list = {
  items: [summary],
  total: 1,
  page: 1,
  pageSize: 20,
} satisfies DashboardReviewRunListResponse;
const jobs = {
  repositoryId,
  reviewRunId,
  requestId,
  items: [job],
  total: 1,
  page: 1,
  pageSize: 20,
} satisfies DashboardReviewRunJobListResponse;

const reproductionCase = {
  repositoryId,
  reviewRunId,
  requestId,
  caseId: "case-1",
  jobId: null,
  resultId: null,
  bindingDigest: digest,
  planDigest: digest,
  binding: {
    schemaVersion: "IssueReproductionBindingV1",
    activationId: "activation-1",
    repositoryId,
    githubRepositoryId: 1,
    workItemId,
    githubWorkItemId: 42,
    issueRevisionKey: digest,
    testedSourceCommit: "c".repeat(40),
    authorizedBy: { issuer: session.issuer, subject: session.subject, authorizedAt: timestamp },
    claim: "The operation creates a duplicate.",
  },
  case: {
    id: "case-1",
    requestId,
    profileVersionId: "profile-version-1",
    profileConfigSha256: digest,
    target: "headless",
    context: "Observe the isolated operation.",
    preconditions: [],
    absentWhen: null,
    presentWhen: {
      allOf: [
        {
          observation: { kind: "probe_value", testStepId: "test", observationId: "duplicate" },
          equals: { type: "boolean", value: true },
        },
      ],
    },
  },
  recorded: null,
  current: {
    caseId: "case-1",
    requestId,
    profileVersionId: "profile-version-1",
    target: "headless",
    state: "inconclusive",
    matchedObservationRefs: [],
    evidenceIds: [],
    reasons: ["execution_pending"],
  },
  observations: [],
} satisfies DashboardReviewRunReproductionCaseResponse;

const readRoutes = [
  {
    name: "reproduction case",
    url: casePath,
    operation: "getDashboardReviewRunReproductionCase",
    input: { repositoryId, reviewRunId, requestId, caseId: "case-1" },
    output: reproductionCase,
  },
  {
    name: "run list",
    url: listPath,
    operation: "listDashboardReviewRuns",
    input: { repositoryId, page: 1, pageSize: 20 },
    output: list,
  },
  {
    name: "run detail",
    url: detailPath,
    operation: "getDashboardReviewRun",
    input: { repositoryId, reviewRunId },
    output: detail,
  },
  {
    name: "request job history",
    url: jobsPath,
    operation: "listDashboardReviewRunJobs",
    input: { repositoryId, reviewRunId, requestId, page: 1, pageSize: 20 },
    output: jobs,
  },
  {
    name: "job result",
    url: resultPath,
    operation: "getDashboardReviewRunJobResult",
    input: { repositoryId, reviewRunId, requestId, jobId },
    output: result,
  },
] as const;

const createAuth = (): OperatorAuthRouteService => ({
  publicOrigin,
  postLoginRedirectPath: "/",
  requiresLoopbackRequest: false,
  secureCookies: true,
  usesBrowserBinding: false,
  ensureBrowserBinding: vi.fn(() => undefined),
  startLogin: vi.fn(async () => ({ kind: "session" as const, sessionToken, session })),
  completeLogin: vi.fn(async () => {
    throw new Error("Not used by review run route tests.");
  }),
  getSession: vi.fn(async (token) => (token === sessionToken ? session : null)),
  logout: vi.fn(async () => undefined),
});
const createDatabase = (
  implementation?: (operation: string, input: unknown) => Promise<unknown>,
) => {
  const request = vi.fn(async (operation: string, input: unknown) => {
    expect(operation).toBe("operatorRequest");
    expect(input).toEqual(envelope(expect.any(String), expect.anything()));
    const authorized = input as OperatorRequestInput;
    if (implementation === undefined)
      throw new Error(`Unexpected operation: ${authorized.operation}`);
    return implementation(authorized.operation, authorized.input);
  });
  return { database: { request } as unknown as DatabaseClient, request };
};
const apps: FastifyInstance[] = [];
const createApp = (database: DatabaseClient, readOnly = false) => {
  const app = Fastify({ logger: false });
  const auth = createAuth();
  apps.push(app);
  registerOperatorAuthRoutes(app, auth);
  registerReviewRunRoutes(app, { database, operatorAuth: auth, readOnly });
  return { app, auth };
};
const cookieHeaders = () => ({ cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}` });
const authenticatedHeaders = () => ({ ...cookieHeaders(), origin: publicOrigin });
const expectNoStore = (response: { readonly headers: Record<string, unknown> }) => {
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers.vary).toBe("Cookie");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("operator review run routes", () => {
  it("binds an explicitly selected historical reproduction job in the read request and response", async () => {
    const { database, request } = createDatabase(async () => ({ ...reproductionCase, jobId }));
    const { app } = createApp(database);
    const response = await app.inject({
      method: "GET",
      url: `${casePath}?jobId=${jobId}`,
      headers: cookieHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "operatorRequest",
      envelope("getDashboardReviewRunReproductionCase", {
        repositoryId,
        reviewRunId,
        requestId,
        caseId: "case-1",
        jobId,
      }),
    );
  });

  it.each(["binding", "case", "current", "result"])(
    "rejects inconsistent reproduction %s identity",
    async (kind) => {
      const malformed: DashboardReviewRunReproductionCaseResponse =
        structuredClone(reproductionCase);
      if (kind === "binding") malformed.binding.repositoryId = "other-repository";
      if (kind === "case") malformed.case.requestId = "other-request";
      if (kind === "current") malformed.current.profileVersionId = "other-profile";
      if (kind === "result") malformed.resultId = "result-without-recorded-assessment";
      const { database } = createDatabase(async () => malformed);
      const { app } = createApp(database);
      const response = await app.inject({ method: "GET", url: casePath, headers: cookieHeaders() });
      expect(response.statusCode).toBe(502);
    },
  );

  it("accepts a bounded reproduction intent larger than the legacy creation body budget", async () => {
    const requestBody: OperatorReviewRunCreateRequest = {
      ...createRequest,
      reproduction: {
        schemaVersion: "IssueReproductionRequestV1",
        claim: "Observe the duplicate behavior.",
        cases: Array.from({ length: 12 }, (_, index) => ({
          id: `case-${index}`,
          profileId: "profile-1",
          expectedProfileVersionId: "profile-version-1",
          context: "x".repeat(2048),
          preconditions: [],
          presentWhen: reproductionCase.case.presentWhen,
          absentWhen: null,
        })),
      },
    };
    expect(Buffer.byteLength(JSON.stringify(requestBody), "utf8")).toBeGreaterThan(16384);
    const { database } = createDatabase(async (operation) =>
      operation === "createOperatorReviewRun" ? createdRunIdentity : detail,
    );
    const { app } = createApp(database);
    const response = await app.inject({
      method: "POST",
      url: createPath,
      headers: authenticatedHeaders(),
      payload: requestBody,
    });
    expect(response.statusCode).toBe(201);
  });

  it.each(readRoutes)("reads $name with every repository and nested scope", async (route) => {
    const { database, request } = createDatabase(async () => route.output);
    const { app, auth } = createApp(database);
    const response = await app.inject({ method: "GET", url: route.url, headers: cookieHeaders() });

    expect(response.statusCode).toBe(200);
    expectNoStore(response);
    expect(response.json()).toEqual(route.output);
    expect(auth.getSession).toHaveBeenCalledWith(sessionToken, undefined);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "operatorRequest",
      envelope(route.operation, route.input),
    );
  });

  it.each([
    {
      name: "filtered run list",
      url: `${listPath}?workItemId=${workItemId}&page=3&pageSize=2`,
      operation: "listDashboardReviewRuns",
      input: { repositoryId, workItemId, page: 3, pageSize: 2 },
      output: { ...list, total: 5, page: 3, pageSize: 2 },
    },
    {
      name: "filtered run detail",
      url: `${detailPath}?workItemId=${workItemId}`,
      operation: "getDashboardReviewRun",
      input: { repositoryId, reviewRunId, workItemId },
      output: detail,
    },
    {
      name: "paginated job history",
      url: `${jobsPath}?page=2&pageSize=50`,
      operation: "listDashboardReviewRunJobs",
      input: { repositoryId, reviewRunId, requestId, page: 2, pageSize: 50 },
      output: { ...jobs, total: 51, page: 2, pageSize: 50 },
    },
    {
      name: "exact historical job",
      url: `${jobsPath}?page=1&pageSize=1&jobId=${jobId}`,
      operation: "listDashboardReviewRunJobs",
      input: { repositoryId, reviewRunId, requestId, jobId, page: 1, pageSize: 1 },
      output: { ...jobs, pageSize: 1 },
    },
    {
      name: "absent historical job",
      url: `${jobsPath}?jobId=absent-job`,
      operation: "listDashboardReviewRunJobs",
      input: { repositoryId, reviewRunId, requestId, jobId: "absent-job", page: 1, pageSize: 20 },
      output: { ...jobs, items: [], total: 0 },
    },
  ])("passes the exact $name query to the database", async (route) => {
    const { database, request } = createDatabase(async () => route.output);
    const { app } = createApp(database);
    const response = await app.inject({ method: "GET", url: route.url, headers: cookieHeaders() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(route.output);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "operatorRequest",
      envelope(route.operation, route.input),
    );
  });

  it("creates a run with the cookie actor and returns the subsequent dashboard projection", async () => {
    const { database, request } = createDatabase(async (operation) => {
      if (operation === "createOperatorReviewRun") {
        return { ...createdRunIdentity, plan: { renderedPrompt: "private-frozen-prompt" } };
      }
      if (operation === "getDashboardReviewRun") return detail;
      throw new Error(`Unexpected operation: ${operation}`);
    });
    const { app } = createApp(database);
    const response = await app.inject({
      method: "POST",
      url: createPath,
      payload: createRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(201);
    expectNoStore(response);
    expect(response.json()).toEqual(detail);
    expect(response.body).not.toContain("private-frozen-prompt");
    expect(request.mock.calls).toEqual([
      [
        "operatorRequest",
        envelope("createOperatorReviewRun", {
          repositoryId,
          workItemId,
          request: createRequest,
          actor,
        }),
      ],
      [
        "operatorRequest",
        envelope("getDashboardReviewRun", { repositoryId, workItemId, reviewRunId }),
      ],
    ]);
  });

  it.each([
    ...readRoutes.map((route) => ({
      name: route.name,
      method: "GET" as const,
      url: route.url,
      payload: undefined,
    })),
    { name: "run creation", method: "POST" as const, url: createPath, payload: createRequest },
  ])("requires a cookie session for $name before database access", async (route) => {
    const { database, request } = createDatabase();
    const { app } = createApp(database);
    const response = await app.inject({
      method: route.method,
      url: route.url,
      ...(route.payload === undefined ? {} : { payload: route.payload }),
      headers: { origin: publicOrigin },
    });

    expect(response.statusCode).toBe(401);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "operator_authentication_required" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(readRoutes)("does not accept a Worker Bearer identity for $name", async (route) => {
    const { database, request } = createDatabase();
    const { app } = createApp(database);
    const response = await app.inject({
      method: "GET",
      url: route.url,
      headers: { authorization: `Bearer arw1_${"x".repeat(43)}` },
    });
    expect(response.statusCode).toBe(401);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not accept a Worker Bearer identity for run creation", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp(database);
    const response = await app.inject({
      method: "POST",
      url: createPath,
      payload: createRequest,
      headers: { origin: publicOrigin, authorization: `Bearer arw1_${"x".repeat(43)}` },
    });
    expect(response.statusCode).toBe(401);
    expect(request).not.toHaveBeenCalled();
  });

  it("rechecks the session-scoped run projection after creation and conceals revoked access", async () => {
    const { database, request } = createDatabase(async (operation) => {
      if (operation === "createOperatorReviewRun") return createdRunIdentity;
      await Promise.resolve();
      throw new DatabaseRequestError("C:/private/evidence/storage-secret", "PLATFORM_NOT_FOUND");
    });
    const { app } = createApp(database);
    const response = await app.inject({
      method: "POST",
      url: createPath,
      payload: createRequest,
      headers: authenticatedHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "platform_not_found", retryable: false });
    expect(response.body).not.toContain("storage-secret");
    expect(request.mock.calls).toEqual([
      [
        "operatorRequest",
        envelope("createOperatorReviewRun", {
          repositoryId,
          workItemId,
          request: createRequest,
          actor,
        }),
      ],
      [
        "operatorRequest",
        envelope("getDashboardReviewRun", { repositoryId, workItemId, reviewRunId }),
      ],
    ]);
  });

  it.each(readRoutes)("maps asynchronous access failures safely for $name", async (route) => {
    for (const [code, statusCode, retryable] of [
      ["PLATFORM_FORBIDDEN", 403, false],
      ["PLATFORM_NOT_FOUND", 404, false],
      ["DATABASE_WORKER_SHUTTING_DOWN", 503, true],
    ] as const) {
      const { database, request } = createDatabase(async () => {
        await Promise.resolve();
        throw new DatabaseRequestError("C:/private/evidence/storage-secret private-token", code);
      });
      const { app } = createApp(database);
      const response = await app.inject({
        method: "GET",
        url: route.url,
        headers: cookieHeaders(),
      });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({
        code: code.toLowerCase(),
        retryable,
        message: expect.any(String),
      });
      expect(response.body).not.toContain("private");
      expect(response.body).not.toContain("storage-secret");
      expectNoStore(response);
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "operatorRequest",
        envelope(route.operation, route.input),
      );
    }
  });

  it.each([
    ["missing", undefined],
    ["different", "https://attacker.example.com"],
  ])("rejects a %s creation Origin before session lookup", async (_name, origin) => {
    const { database, request } = createDatabase();
    const { app, auth } = createApp(database);
    const response = await app.inject({
      method: "POST",
      url: createPath,
      payload: createRequest,
      headers: { ...cookieHeaders(), ...(origin === undefined ? {} : { origin }) },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "invalid_operator_auth_origin" });
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks creation during recovery while preserving run reads", async () => {
    const { database, request } = createDatabase(async () => list);
    const { app } = createApp(database, true);
    const mutation = await app.inject({
      method: "POST",
      url: createPath,
      payload: createRequest,
      headers: authenticatedHeaders(),
    });

    expect(mutation.statusCode).toBe(503);
    expect(mutation.json()).toMatchObject({ code: "configuration_read_only" });
    expect(request).not.toHaveBeenCalled();
    const read = await app.inject({ method: "GET", url: listPath, headers: cookieHeaders() });
    expect(read.statusCode).toBe(200);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "operatorRequest",
      envelope("listDashboardReviewRuns", {
        repositoryId,
        page: 1,
        pageSize: 20,
      }),
    );
  });

  it.each([
    ["unknown list filter", `${listPath}?requestId=${requestId}`],
    ["pagination on detail", `${detailPath}?page=1`],
    ["work item filter on job history", `${jobsPath}?workItemId=${workItemId}`],
    ["work item filter on result", `${resultPath}?workItemId=${workItemId}`],
    ["duplicate work item filter", `${listPath}?workItemId=${workItemId}&workItemId=${workItemId}`],
    ["oversized run page", `${listPath}?pageSize=51`],
    ["zero job page", `${jobsPath}?page=0`],
    ["duplicate job page", `${jobsPath}?page=1&page=2`],
    ["invalid historical job", `${jobsPath}?jobId=..%2Fjob`],
    ["duplicate historical job", `${jobsPath}?jobId=${jobId}&jobId=other-job`],
  ])("rejects %s before database access", async (name, url) => {
    const { database, request } = createDatabase();
    const { app } = createApp(database);
    const response = await app.inject({ method: "GET", url, headers: cookieHeaders() });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code:
        name === "invalid historical job"
          ? "configuration_request_invalid"
          : "configuration_query_invalid",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects query fields on creation instead of treating them as run options", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp(database);
    const response = await app.inject({
      method: "POST",
      url: `${createPath}?profileIds=profile-2`,
      payload: createRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "configuration_query_invalid" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["repository path", "/api/v1/operator/repositories/-invalid/review-runs"],
    ["run path", `${listPath}/-invalid`],
    ["request path", `${detailPath}/requests/-invalid/jobs`],
    ["job path", `${jobsPath}/-invalid/result`],
    ["work item filter", `${listPath}?workItemId=-invalid`],
  ])("rejects an invalid %s before database access", async (_name, url) => {
    const { database, request } = createDatabase();
    const { app } = createApp(database);
    const response = await app.inject({ method: "GET", url, headers: cookieHeaders() });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "configuration_request_invalid" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an invalid work item creation path", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp(database);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/operator/repositories/${repositoryId}/work-items/-invalid/review-runs`,
      payload: createRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "configuration_request_invalid" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["missing activation", { expectedRevisionKey: digest }],
    ["invalid revision digest", { ...createRequest, expectedRevisionKey: "revision-1" }],
    ["duplicate selected profiles", { ...createRequest, profileIds: ["profile-1", "profile-1"] }],
    ["empty profile selection", { ...createRequest, profileIds: [] }],
    ["symbolic source revision", { ...createRequest, testedSourceCommit: "HEAD" }],
    [
      "forged actor",
      {
        ...createRequest,
        actor: { issuer: "https://attacker.example.com", subject: "forged-operator" },
      },
    ],
    ["caller-supplied work item scope", { ...createRequest, workItemId: "other-work-item" }],
    [
      "forged authorization context",
      { ...createRequest, context: { kind: "operator", actor: { ...actor, subject: "admin" } } },
    ],
    [
      "caller-supplied frozen plan",
      { ...createRequest, plan: { activationId: "forged-activation" } },
    ],
  ])("rejects a creation body with %s", async (_name, payload) => {
    const { database, request } = createDatabase();
    const { app } = createApp(database);
    const response = await app.inject({
      method: "POST",
      url: createPath,
      payload,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "configuration_request_invalid" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(readRoutes.filter((route) => route.operation !== "listDashboardReviewRuns"))(
    "returns not found when $name is outside the selected scope",
    async (route) => {
      const { database, request } = createDatabase(async () => null);
      const { app } = createApp(database);
      const response = await app.inject({
        method: "GET",
        url: route.url,
        headers: cookieHeaders(),
      });

      expect(response.statusCode).toBe(404);
      expectNoStore(response);
      expect(response.json()).toMatchObject({ code: "review_run_not_found" });
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "operatorRequest",
        envelope(route.operation, route.input),
      );
    },
  );

  it("returns not found if the newly created run cannot be projected in its work item", async () => {
    const { database, request } = createDatabase(async (operation) =>
      operation === "createOperatorReviewRun" ? createdRunIdentity : null,
    );
    const { app } = createApp(database);
    const response = await app.inject({
      method: "POST",
      url: createPath,
      payload: createRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "review_run_not_found" });
    expect(request.mock.calls).toHaveLength(2);
    expect(request).toHaveBeenLastCalledWith(
      "operatorRequest",
      envelope("getDashboardReviewRun", {
        repositoryId,
        workItemId,
        reviewRunId,
      }),
    );
  });

  it("preserves a stale revision conflict and does not fetch a dashboard projection", async () => {
    const { database, request } = createDatabase(async () => {
      throw new DatabaseRequestError("The requested revision has changed.", "PLATFORM_CONFLICT");
    });
    const { app } = createApp(database);
    const response = await app.inject({
      method: "POST",
      url: createPath,
      payload: createRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "platform_conflict", retryable: false });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "operatorRequest",
      envelope("createOperatorReviewRun", {
        repositoryId,
        workItemId,
        request: createRequest,
        actor,
      }),
    );
  });

  it.each([
    {
      name: "different repository in a run summary",
      url: listPath,
      output: { ...list, items: [{ ...summary, repositoryId: "other-repository" }] },
    },
    {
      name: "different filtered work item",
      url: `${listPath}?workItemId=${workItemId}`,
      output: { ...list, items: [{ ...summary, workItemId: "other-work-item" }] },
    },
    {
      name: "full detail returned as a run summary",
      url: listPath,
      output: { ...list, items: [detail] },
    },
    { name: "different run page", url: listPath, output: { ...list, page: 2 } },
    { name: "different run page size", url: listPath, output: { ...list, pageSize: 50 } },
    {
      name: "too many run items for the requested page",
      url: `${listPath}?pageSize=1`,
      output: {
        ...list,
        items: [summary, { ...summary, id: "review-run-2" }],
        total: 2,
        pageSize: 1,
      },
    },
    {
      name: "different detail repository",
      url: detailPath,
      output: { ...detail, repositoryId: "other-repository" },
    },
    { name: "different detail run", url: detailPath, output: { ...detail, id: "other-run" } },
    {
      name: "different detail work item",
      url: `${detailPath}?workItemId=${workItemId}`,
      output: { ...detail, workItemId: "other-work-item" },
    },
    {
      name: "oversized result summary",
      url: detailPath,
      output: {
        ...detail,
        requests: [
          { ...detail.requests[0], latestResult: { ...resultSummary, summary: "s".repeat(1_025) } },
        ],
      },
    },
    { name: "different job page", url: jobsPath, output: { ...jobs, page: 2 } },
    { name: "different filtered job", url: `${jobsPath}?jobId=other-job`, output: jobs },
    {
      name: "multiple filtered jobs",
      url: `${jobsPath}?jobId=${jobId}`,
      output: { ...jobs, total: 2 },
    },
    {
      name: "too many job items for the requested page",
      url: `${jobsPath}?pageSize=1`,
      output: { ...jobs, items: [job, { ...job, jobId: "job-2" }], total: 2, pageSize: 1 },
    },
    {
      name: "private result fields",
      url: resultPath,
      output: { ...result, renderedPrompt: "private-result-prompt" },
    },
    ...["repositoryId", "reviewRunId", "requestId"].map((field) => ({
      name: `different job history ${field}`,
      url: jobsPath,
      output: { ...jobs, [field]: "other-scope" },
    })),
    ...["repositoryId", "reviewRunId", "requestId", "jobId"].map((field) => ({
      name: `different result ${field}`,
      url: resultPath,
      output: { ...result, [field]: "other-scope" },
    })),
  ])("rejects $name from the database", async ({ url, output }) => {
    const { database } = createDatabase(async () => output);
    const { app } = createApp(database);
    const response = await app.inject({ method: "GET", url, headers: cookieHeaders() });

    expect(response.statusCode).toBe(502);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_response_invalid" });
    expect(response.body).not.toContain("private-result-prompt");
  });

  it.each(["repositoryId", "workItemId", "id"])(
    "rejects a created dashboard detail with a different %s",
    async (field) => {
      const { database, request } = createDatabase(async (operation) => {
        if (operation === "createOperatorReviewRun") return createdRunIdentity;
        return { ...detail, [field]: "other-scope" };
      });
      const { app } = createApp(database);
      const response = await app.inject({
        method: "POST",
        url: createPath,
        payload: createRequest,
        headers: authenticatedHeaders(),
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ code: "configuration_response_invalid" });
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenLastCalledWith(
        "operatorRequest",
        envelope("getDashboardReviewRun", {
          repositoryId,
          workItemId,
          reviewRunId,
        }),
      );
    },
  );

  it.each([
    ["missing run", null],
    ["invalid run identity", { ...createdRunIdentity, id: "-invalid" }],
    ["different repository", { ...createdRunIdentity, repositoryId: "other-repository" }],
    ["different work item", { ...createdRunIdentity, workItemId: "other-work-item" }],
    ["different activation", { ...createdRunIdentity, activationId: "other-activation" }],
  ])("rejects a creation response with %s before the dashboard lookup", async (_name, output) => {
    const { database, request } = createDatabase(async () => output);
    const { app } = createApp(database);
    const response = await app.inject({
      method: "POST",
      url: createPath,
      payload: createRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: "review_run_response_invalid" });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "operatorRequest",
      envelope("createOperatorReviewRun", {
        repositoryId,
        workItemId,
        request: createRequest,
        actor,
      }),
    );
  });
});
