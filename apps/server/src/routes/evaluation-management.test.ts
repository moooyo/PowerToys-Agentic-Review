import * as C from "@agentic-review/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseRequestError } from "../database/errors.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { registerEvaluationManagementRoutes } from "./evaluation-management.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";
import {
  operatorConfigurationRateLimits,
  registerOperatorConfigurationRateLimits,
} from "./operator-rate-limit.js";

const actor = { issuer: "https://evaluations.example.test", subject: "operator-a" };
const origin = "https://review.example.test";
const token = "E".repeat(43);
const now = "2026-09-08T00:00:00.000Z";
const digest = "a".repeat(64);
const base = "/api/v1/operator/repositories/repository-a";
const sourceSummary: C.EvaluationSourceSummaryV1 = {
  schemaVersion: "EvaluationSourceSummaryV1",
  id: "source-a",
  repositoryId: "repository-a",
  workItemId: "work-item-a",
  revisionId: "revision-a",
  revisionKey: digest,
  sourceDigest: "b".repeat(64),
  workItemKind: "pull_request",
  number: 7,
  title: "Preserve a known sample",
  createdAt: now,
  createdBy: actor,
};
const sourceDetail: C.EvaluationSourceDetailV1 = {
  ...sourceSummary,
  snapshot: {
    schemaVersion: "EvaluationSourceSnapshotV1",
    repository: {
      id: "repository-a",
      githubRepositoryId: 100,
      fullName: "example/repository-a",
      configurationVersion: 1,
    },
    workItemId: "work-item-a",
    workItem: {
      kind: "pull_request",
      githubWorkItemId: 200,
      githubNodeId: "NODE_200",
      githubRepositoryId: 100,
      number: 7,
      title: sourceSummary.title,
      body: "The original source body.",
      state: "open",
      isDraft: false,
      author: { githubUserId: 300, login: "contributor" },
      htmlUrl: "https://github.com/example/repository-a/pull/7",
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    },
    revision: {
      kind: "pull_request",
      githubRepositoryId: 100,
      githubWorkItemId: 200,
      revisionKey: digest,
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
    },
    revisionId: "revision-a",
    freshness: "frozen",
    sourceDigest: sourceSummary.sourceDigest,
    testedSourceRevision: {
      kind: "pull_request",
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
    },
    provenance: { kind: "current_work_item", capturedAt: now, expectedRevisionKey: digest },
  },
};
const sourceCapture: C.EvaluationSourceCaptureRequest = {
  changeId: "capture-a",
  source: {
    kind: "current_work_item",
    workItemId: "work-item-a",
    expectedRevisionKey: digest,
    testedIssueCommit: null,
  },
};
const suiteCreate: C.EvaluationSuiteCreateRequest = {
  changeId: "create-a",
  name: "Known examples",
  description: "Frozen regression samples.",
  workflowKind: "pr_static_build",
  target: "headless",
};
const suiteCreated: C.EvaluationSuiteSummaryV1 = {
  schemaVersion: "EvaluationSuiteSummaryV1",
  id: "suite-a",
  repositoryId: "repository-a",
  name: suiteCreate.name,
  description: suiteCreate.description,
  workflowKind: suiteCreate.workflowKind,
  target: suiteCreate.target,
  draftRevision: 1,
  caseCount: 0,
  latestVersionId: null,
  createdAt: now,
  updatedAt: now,
  createdBy: actor,
  updatedBy: actor,
};
const draft: C.EvaluationSuiteDraft = {
  name: suiteCreate.name,
  description: suiteCreate.description,
  cases: [
    {
      caseId: "case-a",
      title: "Known negative sample",
      sourceId: "source-a",
      applicability: { state: "applicable" },
      criteria: [
        {
          criterionId: "criterion-a",
          description: "The build succeeds.",
          applicability: { state: "applicable" },
          expectedOutcome: "passed",
        },
      ],
      findings: { annotation: "complete", expected: [] },
    },
  ],
};
const suiteSummary: C.EvaluationSuiteSummaryV1 = {
  ...suiteCreated,
  draftRevision: 2,
  caseCount: 1,
};
const suiteDetail: C.EvaluationSuiteDetailV1 = { ...suiteSummary, draft };
const suiteSave: C.EvaluationSuiteSaveRequest = { changeId: "save-a", expectedRevision: 1, draft };
const suitePublish: C.EvaluationSuitePublishRequest = {
  changeId: "publish-a",
  expectedRevision: 2,
};
const suiteVersion: C.EvaluationSuiteVersionV1 = {
  schemaVersion: "EvaluationSuiteVersionV1",
  id: "version-a",
  suiteId: "suite-a",
  repositoryId: "repository-a",
  version: 1,
  sourceDraftRevision: 2,
  name: suiteCreate.name,
  description: suiteCreate.description,
  workflowKind: suiteCreate.workflowKind,
  target: suiteCreate.target,
  sourceVersionId: "source-version-a",
  expectationVersionId: "expectation-version-a",
  sourceManifestSha256: "c".repeat(64),
  expectationManifestSha256: "d".repeat(64),
  caseCount: 1,
  createdAt: now,
  createdBy: actor,
};
const draftCase = draft.cases[0];
if (draftCase === undefined) throw new Error("The fixture requires one published case.");
const { sourceId: publishedSourceId, ...publishedExpectation } = draftCase;
const publishedCaseScope = {
  repositoryId: suiteVersion.repositoryId,
  suiteId: suiteVersion.suiteId,
  versionId: suiteVersion.id,
};
const publishedManifestScope = {
  ...publishedCaseScope,
  sourceVersionId: suiteVersion.sourceVersionId,
  expectationVersionId: suiteVersion.expectationVersionId,
  sourceManifestSha256: suiteVersion.sourceManifestSha256,
  expectationManifestSha256: suiteVersion.expectationManifestSha256,
};
const publishedCaseSummary: C.EvaluationSuiteCaseSummaryV1 = {
  schemaVersion: "EvaluationSuiteCaseSummaryV1",
  ...publishedCaseScope,
  caseId: publishedExpectation.caseId,
  title: publishedExpectation.title,
  sourceId: publishedSourceId,
  sourceDigest: sourceSummary.sourceDigest,
  applicability: publishedExpectation.applicability,
  criterionCount: publishedExpectation.criteria.length,
  annotation: publishedExpectation.findings.annotation,
  expectedFindingCount: publishedExpectation.findings.expected.length,
};
const publishedCaseList: C.EvaluationSuiteCaseListV1 = {
  schemaVersion: "EvaluationSuiteCaseListV1",
  ...publishedManifestScope,
  items: [publishedCaseSummary],
  total: 1,
};
const publishedCaseDetail: C.EvaluationSuiteCaseDetailV1 = {
  schemaVersion: "EvaluationSuiteCaseDetailV1",
  ...publishedManifestScope,
  caseId: publishedExpectation.caseId,
  source: sourceSummary,
  expectation: publishedExpectation,
};
const casesPath = `${base}/evaluation-suites/suite-a/versions/version-a/cases`;
const page = { repositoryId: "repository-a", total: 1, page: 1, pageSize: 20 };
const routes = [
  {
    name: "source capture",
    method: "POST",
    path: `${base}/evaluation-sources`,
    operation: "captureEvaluationSource",
    output: sourceSummary,
    body: sourceCapture,
  },
  {
    name: "source detail",
    method: "GET",
    path: `${base}/evaluation-sources/source-a`,
    operation: "getEvaluationSource",
    output: sourceDetail,
  },
  {
    name: "source list",
    method: "GET",
    path: `${base}/evaluation-sources`,
    operation: "listEvaluationSources",
    output: { ...page, items: [sourceSummary] },
  },
  {
    name: "suite creation",
    method: "POST",
    path: `${base}/evaluation-suites`,
    operation: "createEvaluationSuite",
    output: suiteCreated,
    body: suiteCreate,
  },
  {
    name: "suite detail",
    method: "GET",
    path: `${base}/evaluation-suites/suite-a`,
    operation: "getEvaluationSuite",
    output: suiteDetail,
  },
  {
    name: "suite list",
    method: "GET",
    path: `${base}/evaluation-suites`,
    operation: "listEvaluationSuites",
    output: { ...page, items: [suiteSummary] },
  },
  {
    name: "draft save",
    method: "PUT",
    path: `${base}/evaluation-suites/suite-a/draft`,
    operation: "saveEvaluationSuiteDraft",
    output: suiteSummary,
    body: suiteSave,
  },
  {
    name: "suite publication",
    method: "POST",
    path: `${base}/evaluation-suites/suite-a/versions`,
    operation: "publishEvaluationSuite",
    output: suiteVersion,
    body: suitePublish,
  },
  {
    name: "suite versions",
    method: "GET",
    path: `${base}/evaluation-suites/suite-a/versions`,
    operation: "listEvaluationSuiteVersions",
    output: { ...page, suiteId: "suite-a", items: [suiteVersion] },
  },
  {
    name: "suite version",
    method: "GET",
    path: `${base}/evaluation-suites/suite-a/versions/version-a`,
    operation: "getEvaluationSuiteVersion",
    output: suiteVersion,
  },
  {
    name: "published case list",
    method: "GET",
    path: casesPath,
    operation: "listEvaluationSuiteCases",
    output: publishedCaseList,
  },
  {
    name: "published case detail",
    method: "GET",
    path: `${casesPath}/case-a`,
    operation: "getEvaluationSuiteCase",
    output: publishedCaseDetail,
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
    startLogin: vi.fn(async () => ({ kind: "session", sessionToken: token, session })),
    completeLogin: vi.fn(async () => {
      throw new Error("No external login in these tests.");
    }),
    getSession: vi.fn(async (value) =>
      value === token && options.authenticated !== false ? session : null,
    ),
    logout: vi.fn(async () => undefined),
  };
  const database = createOperatorRouteTestDatabase(actor, async () => {
    if (options.error !== undefined) throw options.error;
    return output;
  });
  const app = Fastify({ logger: false });
  apps.push(app);
  registerOperatorAuthRoutes(app, auth);
  app.register(async (scope) => {
    if (options.rateLimits) await registerOperatorConfigurationRateLimits(scope, auth);
    registerEvaluationManagementRoutes(scope, {
      database: database.database,
      operatorAuth: auth,
      readOnly: options.readOnly ?? false,
    });
  });
  return { app, auth, ...database };
}

const headers = () => ({
  host: "review.example.test",
  cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
  origin,
});

describe("evaluation management HTTP boundary", () => {
  it.each(routes)("binds $name to the current authenticated repository scope", async (route) => {
    const f = fixture(route.output);
    const result = await f.app.inject({
      method: route.method,
      url: route.path,
      headers: headers(),
      payload: "body" in route ? route.body : undefined,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(route.output);
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      route.operation,
      expect.objectContaining({ repositoryId: "repository-a", actor }),
    );
    expect(f.request.mock.calls[0]?.[1]).not.toHaveProperty("replayOnly");
    expect(f.transport).toHaveBeenCalledExactlyOnceWith(
      "operatorRequest",
      expect.objectContaining({ context: { kind: "operator", actor } }),
    );
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.headers.vary).toBe("Cookie");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
  });

  it.each(routes)("rejects unauthenticated $name before any owner call", async (route) => {
    const f = fixture(route.output, { authenticated: false });
    const result = await f.app.inject({
      method: route.method,
      url: route.path,
      headers: headers(),
      payload: "body" in route ? route.body : undefined,
    });
    expect(result.statusCode).toBe(401);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(routes)("rejects foreign repository responses for $name", async (route) => {
    const f = fixture({ ...route.output, repositoryId: "other-repository" });
    const result = await f.app.inject({
      method: route.method,
      url: route.path,
      headers: headers(),
      payload: "body" in route ? route.body : undefined,
    });
    expect(result.statusCode).toBe(502);
    expect(result.body).not.toContain("other-repository");
  });

  it.each(routes.filter((route) => "body" in route))(
    "requires an exact Origin for $name",
    async (route) => {
      for (const suppliedOrigin of [
        undefined,
        "https://untrusted.example.test",
        [origin, origin],
      ]) {
        const f = fixture(route.output);
        const { origin: _origin, ...otherHeaders } = headers();
        const result = await f.app.inject({
          method: route.method,
          url: route.path,
          headers: {
            ...otherHeaders,
            ...(suppliedOrigin === undefined ? {} : { origin: suppliedOrigin }),
          },
          payload: route.body,
        });
        expect(result.statusCode).toBe(403);
        expect(f.transport).not.toHaveBeenCalled();
      }
    },
  );

  it.each(routes.filter((route) => "body" in route))(
    "rejects client authority and snapshot fields for $name",
    async (route) => {
      for (const extra of [
        { actor },
        { repositoryId: "other-repository" },
        { readOnly: false },
        { replayOnly: false },
        { replayOnly: true },
        { snapshot: sourceDetail.snapshot },
        { sourceDigest: digest },
      ]) {
        for (const readOnly of [false, true]) {
          const f = fixture(route.output, { readOnly });
          const result = await f.app.inject({
            method: route.method,
            url: route.path,
            headers: headers(),
            payload: { ...route.body, ...extra },
          });
          expect(result.statusCode).toBe(400);
          expect(f.transport).not.toHaveBeenCalled();
        }
      }
    },
  );

  it.each(routes.filter((route) => "body" in route))(
    "rejects a mutation receipt attributed to another operator for $name",
    async (route) => {
      const field = route.operation === "saveEvaluationSuiteDraft" ? "updatedBy" : "createdBy";
      const f = fixture({ ...route.output, [field]: { ...actor, subject: "other-operator" } });
      const result = await f.app.inject({
        method: route.method,
        url: route.path,
        headers: headers(),
        payload: route.body,
      });
      expect(result.statusCode).toBe(502);
    },
  );

  it.each(routes.filter((route) => "body" in route))(
    "allows an owner-verified original replay of $name in recovery mode",
    async (route) => {
      const f = fixture(route.output, { readOnly: true });
      const result = await f.app.inject({
        method: route.method,
        url: route.path,
        headers: headers(),
        payload: route.body,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual(route.output);
      expect(f.request).toHaveBeenCalledExactlyOnceWith(
        route.operation,
        expect.objectContaining({
          actor,
          repositoryId: "repository-a",
          request: route.body,
          replayOnly: true,
        }),
      );
    },
  );

  it.each(routes.filter((route) => "body" in route))(
    "maps owner recovery refusal for a new $name to maintenance",
    async (route) => {
      const f = fixture(null, {
        readOnly: true,
        error: new DatabaseRequestError("No existing mutation receipt.", "DATABASE_READ_ONLY"),
      });
      const result = await f.app.inject({
        method: route.method,
        url: route.path,
        headers: headers(),
        payload: route.body,
      });
      expect(result.statusCode).toBe(503);
      expect(result.json().code).toBe("configuration_read_only");
      expect(f.request).toHaveBeenCalledExactlyOnceWith(
        route.operation,
        expect.objectContaining({ replayOnly: true }),
      );
    },
  );

  it.each([
    ["PLATFORM_INVALID", 400],
    ["PLATFORM_FORBIDDEN", 403],
    ["PLATFORM_NOT_FOUND", 404],
    ["PLATFORM_CONFLICT", 409],
  ] as const)(
    "maps %s owner failures without dropping the repository scope",
    async (code, status) => {
      const f = fixture(null, {
        error: new DatabaseRequestError("The selected resource is unavailable.", code),
      });
      const result = await f.app.inject({
        method: "POST",
        url: `${base}/evaluation-suites`,
        headers: headers(),
        payload: suiteCreate,
      });
      expect(result.statusCode).toBe(status);
      expect(result.json().code).toBe(code.toLowerCase());
    },
  );

  it.each([
    "?page=0",
    "?page=01",
    "?page=1e1",
    "?page=1%0A",
    "?page=9007199254740991&pageSize=50",
    "?pageSize=51",
    "?page=1&page=2",
    "?actor=other",
    "?sourceDigest=claimed",
  ])("rejects invalid list pagination and unsupported query %s", async (query) => {
    for (const path of [
      `${base}/evaluation-sources`,
      `${base}/evaluation-suites`,
      `${base}/evaluation-suites/suite-a/versions`,
    ]) {
      const f = fixture(null);
      expect(
        (await f.app.inject({ method: "GET", url: path + query, headers: headers() })).statusCode,
      ).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
    }
  });

  it.each(routes)(
    "rejects unsupported query fields and malformed scope on $name",
    async (route) => {
      for (const url of [
        `${route.path}?unsupported=value`,
        route.path.replace("repository-a", "repository-a%0A"),
      ]) {
        const f = fixture(route.output);
        const result = await f.app.inject({
          method: route.method,
          url,
          headers: headers(),
          payload: "body" in route ? route.body : undefined,
        });
        expect(result.statusCode).toBe(400);
        expect(f.transport).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects mismatched page, source, suite, version and mutation receipt identities", async () => {
    const candidates = [
      {
        method: "GET",
        path: `${base}/evaluation-sources`,
        output: { ...page, page: 2, total: 21, items: [sourceSummary] },
      },
      {
        method: "GET",
        path: `${base}/evaluation-sources/source-a`,
        output: { ...sourceDetail, id: "source-other" },
      },
      {
        method: "GET",
        path: `${base}/evaluation-suites/suite-a`,
        output: { ...suiteDetail, id: "suite-other" },
      },
      {
        method: "GET",
        path: `${base}/evaluation-suites/suite-a/versions`,
        output: {
          ...page,
          suiteId: "suite-other",
          items: [{ ...suiteVersion, suiteId: "suite-other" }],
        },
      },
      {
        method: "GET",
        path: `${base}/evaluation-suites/suite-a/versions/version-a`,
        output: { ...suiteVersion, id: "version-other" },
      },
      {
        method: "POST",
        path: `${base}/evaluation-sources`,
        output: { ...sourceSummary, revisionKey: "c".repeat(64) },
        body: sourceCapture,
      },
      {
        method: "POST",
        path: `${base}/evaluation-suites`,
        output: suiteSummary,
        body: suiteCreate,
      },
      {
        method: "PUT",
        path: `${base}/evaluation-suites/suite-a/draft`,
        output: { ...suiteSummary, draftRevision: 3 },
        body: suiteSave,
      },
      {
        method: "POST",
        path: `${base}/evaluation-suites/suite-a/versions`,
        output: { ...suiteVersion, sourceDraftRevision: 3 },
        body: suitePublish,
      },
    ] as const;
    for (const candidate of candidates) {
      const f = fixture(candidate.output);
      expect(
        (
          await f.app.inject({
            method: candidate.method,
            url: candidate.path,
            headers: headers(),
            payload: "body" in candidate ? candidate.body : undefined,
          })
        ).statusCode,
      ).toBe(502);
    }
  });

  it("forwards only immutable historical source references and positive draft CAS", async () => {
    const historical: C.EvaluationSourceCaptureRequest = {
      changeId: "capture-historical",
      source: { kind: "review_run", reviewRunId: "review-run-a", expectedPlanDigest: digest },
    };
    const f = fixture(sourceSummary);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `${base}/evaluation-sources`,
          headers: headers(),
          payload: historical,
        })
      ).statusCode,
    ).toBe(200);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("captureEvaluationSource", {
      repositoryId: "repository-a",
      actor,
      request: historical,
    });
    for (const payload of [
      { ...suiteSave, expectedRevision: 0 },
      { ...suiteSave, draft: { ...draft, cases: [...draft.cases, ...draft.cases] } },
      { ...suiteSave, draft: { ...draft, name: "bad\ud800name" } },
    ]) {
      const invalid = fixture(suiteSummary);
      expect(
        (
          await invalid.app.inject({
            method: "PUT",
            url: `${base}/evaluation-suites/suite-a/draft`,
            headers: headers(),
            payload,
          })
        ).statusCode,
      ).toBe(400);
      expect(invalid.transport).not.toHaveBeenCalled();
    }
  });

  it("rejects aggregate body overflow before owner dispatch", async () => {
    const f = fixture(sourceSummary);
    const result = await f.app.inject({
      method: "POST",
      url: `${base}/evaluation-sources`,
      headers: headers(),
      payload: {
        ...sourceCapture,
        claimedBody: "x".repeat(C.maximumEvaluationSourceCaptureRequestUtf8Bytes),
      },
    });
    expect(result.statusCode).toBe(413);
    expect(f.transport).not.toHaveBeenCalled();
    const suite = fixture(suiteSummary);
    const oversized = await suite.app.inject({
      method: "PUT",
      url: `${base}/evaluation-suites/suite-a/draft`,
      headers: headers(),
      payload: { ...suiteSave, claimedBody: "x".repeat(C.maximumEvaluationSuiteUtf8Bytes) },
    });
    expect(oversized.statusCode).toBe(413);
    expect(suite.transport).not.toHaveBeenCalled();
  });

  it("keeps complete sources and assessment bodies out of bounded list responses", async () => {
    for (const candidate of [
      { path: `${base}/evaluation-sources`, output: { ...page, items: [sourceDetail] } },
      { path: `${base}/evaluation-suites`, output: { ...page, items: [suiteDetail] } },
      {
        path: `${base}/evaluation-suites/suite-a/versions`,
        output: { ...page, suiteId: "suite-a", items: [{ ...suiteVersion, cases: draft.cases }] },
      },
    ]) {
      const f = fixture(candidate.output);
      expect(
        (await f.app.inject({ method: "GET", url: candidate.path, headers: headers() })).statusCode,
      ).toBe(502);
    }
  });

  it("uses the existing principal mutation rate limit even for replayable changes", async () => {
    const f = fixture(suiteCreated, { rateLimits: true, readOnly: true });
    for (
      let index = 0;
      index < operatorConfigurationRateLimits.mutationsPerPrincipalPerMinute;
      index += 1
    ) {
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: `${base}/evaluation-suites`,
            headers: headers(),
            payload: suiteCreate,
          })
        ).statusCode,
      ).toBe(200);
    }
    const limited = await f.app.inject({
      method: "POST",
      url: `${base}/evaluation-suites`,
      headers: headers(),
      payload: suiteCreate,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe("request_rate_limited");
    expect(f.request).toHaveBeenCalledTimes(
      operatorConfigurationRateLimits.mutationsPerPrincipalPerMinute,
    );
    expect(f.auth.getSession).toHaveBeenCalledTimes(
      operatorConfigurationRateLimits.mutationsPerPrincipalPerMinute + 1,
    );
  });

  it("reads the complete frozen case list and one expectation with read access in recovery", async () => {
    const { origin: _origin, ...readHeaders } = headers();
    for (const route of routes.filter(
      (entry) =>
        entry.operation === "listEvaluationSuiteCases" ||
        entry.operation === "getEvaluationSuiteCase",
    )) {
      const f = fixture(route.output, { readOnly: true });
      const result = await f.app.inject({ method: "GET", url: route.path, headers: readHeaders });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual(route.output);
      expect(f.request).toHaveBeenCalledExactlyOnceWith(route.operation, {
        ...publishedCaseScope,
        actor,
        ...(route.operation === "getEvaluationSuiteCase" ? { caseId: "case-a" } : {}),
      });
      expect(result.body).not.toContain("The original source body.");
    }
  });

  it.each(["?page=1", "?pageSize=20", "?caseId=other", "?actor=other", "?versionId=other"])(
    "rejects every query field on immutable case reads: %s",
    async (query) => {
      for (const path of [casesPath, `${casesPath}/case-a`]) {
        const f = fixture(null);
        expect(
          (await f.app.inject({ method: "GET", url: path + query, headers: headers() })).statusCode,
        ).toBe(400);
        expect(f.transport).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects another suite or version even when a case response is internally consistent", async () => {
    for (const changed of [{ suiteId: "other-suite" }, { versionId: "other-version" }]) {
      const list = fixture({
        ...publishedCaseList,
        ...changed,
        items: [{ ...publishedCaseSummary, ...changed }],
      });
      expect(
        (await list.app.inject({ method: "GET", url: casesPath, headers: headers() })).statusCode,
      ).toBe(502);
      const detail = fixture({ ...publishedCaseDetail, ...changed });
      expect(
        (await detail.app.inject({ method: "GET", url: `${casesPath}/case-a`, headers: headers() }))
          .statusCode,
      ).toBe(502);
    }
    const differentCase = fixture({
      ...publishedCaseDetail,
      caseId: "other-case",
      expectation: { ...publishedExpectation, caseId: "other-case" },
    });
    expect(
      (
        await differentCase.app.inject({
          method: "GET",
          url: `${casesPath}/case-a`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(502);
  });

  it("requires a complete bounded case list without duplicate IDs or assessment bodies", async () => {
    for (const output of [
      { ...publishedCaseList, total: 2 },
      { ...publishedCaseList, total: 0, items: [] },
      { ...publishedCaseList, total: 2, items: [publishedCaseSummary, publishedCaseSummary] },
      {
        ...publishedCaseList,
        items: [{ ...publishedCaseSummary, expectation: publishedExpectation }],
      },
      {
        ...publishedCaseList,
        total: 33,
        items: Array.from({ length: 33 }, (_, index) => ({
          ...publishedCaseSummary,
          caseId: `case-${index}`,
        })),
      },
    ]) {
      const f = fixture(output);
      expect(
        (await f.app.inject({ method: "GET", url: casesPath, headers: headers() })).statusCode,
      ).toBe(502);
    }
    const complete = {
      ...publishedCaseList,
      total: 32,
      items: Array.from({ length: 32 }, (_, index) => ({
        ...publishedCaseSummary,
        caseId: `case-${index}`,
      })),
    };
    const f = fixture(complete);
    const result = await f.app.inject({ method: "GET", url: casesPath, headers: headers() });
    expect(result.statusCode).toBe(200);
    expect(result.json().items).toHaveLength(32);
  });

  it("rejects full source snapshots and inconsistent frozen labels in case detail", async () => {
    for (const output of [
      { ...publishedCaseDetail, source: sourceDetail },
      { ...publishedCaseDetail, snapshot: sourceDetail.snapshot },
      { ...publishedCaseDetail, expectation: { ...publishedExpectation, sourceId: "source-a" } },
      { ...publishedCaseDetail, expectation: { ...publishedExpectation, caseId: "other-case" } },
      { ...publishedCaseDetail, source: { ...sourceSummary, repositoryId: "other-repository" } },
      { ...publishedCaseDetail, expectationManifestSha256: "claimed" },
    ]) {
      const f = fixture(output);
      expect(
        (await f.app.inject({ method: "GET", url: `${casesPath}/case-a`, headers: headers() }))
          .statusCode,
      ).toBe(502);
    }
    for (const segment of ["suite-a", "version-a", "case-a"]) {
      const f = fixture(publishedCaseDetail);
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: `${casesPath}/case-a`.replace(segment, `${segment}%0A`),
            headers: headers(),
          })
        ).statusCode,
      ).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
    }
  });
});
