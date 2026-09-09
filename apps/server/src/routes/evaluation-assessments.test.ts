import * as C from "@agentic-review/contracts";
import {
  captureEvaluationObservations,
  freezeEvaluationScoringPlan,
  scoreEvaluation,
} from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseRequestError } from "../database/errors.js";
import { EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE } from "../database/evaluation-assessments.js";
import { evaluationScoreInputDigest } from "../database/evaluation-observations.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import {
  EVALUATION_ASSESSMENT_PATHS,
  registerEvaluationAssessmentRoutes,
} from "./evaluation-assessments.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";

const actor: C.OperatorPrincipal = {
  issuer: "https://assessments.example.test",
  subject: "operator-a",
};
const origin = "https://review.example.test";
const token = "R".repeat(43);
const now = "2026-09-08T01:00:00.000Z";
const scope: C.EvaluationAssessmentScope = {
  repositoryId: "repository-a",
  evaluationId: "evaluation-a",
};
const plan: C.EvaluationScoringPlanV1 = {
  schemaVersion: "EvaluationScoringPlanV1",
  ...scope,
  sampleSetVersionId: "suite-version-a",
  expectationVersionId: "expectation-version-a",
  baseline: {
    profileVersionId: "profile-baseline",
    promptVersionId: "prompt-baseline",
  },
  candidate: {
    profileVersionId: "profile-candidate",
    promptVersionId: "prompt-candidate",
  },
  cases: [
    {
      caseId: "case-a",
      sourceDigest: "a".repeat(64),
      baselineBinding: {
        cellId: "cell-baseline",
        runId: "run-baseline",
        requestId: "request-baseline",
      },
      candidateBinding: {
        cellId: "cell-candidate",
        runId: "run-candidate",
        requestId: "request-candidate",
      },
      applicability: { state: "applicable" },
      criteria: [
        {
          criterionId: "criterion-a",
          description: "Detect the original compiler failure.",
          applicability: { state: "applicable" },
          expectedOutcome: "failed",
          baselineCheckId: "profile-baseline:build",
          candidateCheckId: "profile-candidate:build",
        },
      ],
      findings: {
        annotation: "complete",
        expected: [
          {
            expectedFindingId: "expected-a",
            description: "The known compiler regression is reported.",
          },
        ],
      },
    },
  ],
};
// The route fixture runs the real pure scorer on no observations. It does not attest an owner
// selection, model execution, validation outcome, evidence receipt, or upstream mutation.
const frozen = freezeEvaluationScoringPlan(plan);
const captured = captureEvaluationObservations(frozen, []);
const scored = scoreEvaluation(frozen, captured, []);
const observationDigest = sha256(canonicalJson(captured.observations));
const adjudicationDigest = sha256(canonicalJson([]));

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("The route fixture entry is missing.");
  return value;
}
function scoringSummary(rulesVersion = scored.rulesVersion): C.EvaluationScoringSummaryV1 {
  const { schemaVersion: _schemaVersion, cases: _cases, ...summary } = structuredClone(scored);
  return { ...summary, rulesVersion };
}
function digestFor(value: {
  repositoryId: string;
  evaluationId: string;
  scorerVersion: C.EvaluationScoringReportV1["rulesVersion"];
  scoringPlanDigest: string;
  observationDigest: string;
  adjudicationDigest: string;
}): string {
  return evaluationScoreInputDigest(value);
}
function preview(): C.EvaluationScorePreviewV1 {
  const summary = scoringSummary();
  return {
    schemaVersion: "EvaluationScorePreviewV1",
    ...scope,
    generatedAt: now,
    assessmentVersion: 0,
    selectionDigest: sha256("opaque route fixture selection"),
    scoringPlanDigest: frozen.digest,
    observationDigest,
    adjudicationDigest,
    inputDigest: digestFor({
      ...scope,
      scorerVersion: summary.rulesVersion,
      scoringPlanDigest: frozen.digest,
      observationDigest,
      adjudicationDigest,
    }),
    summary,
    caseIds: scored.cases.map((entry) => entry.caseId),
  };
}
function publishRequest(expectedVersion = 0): C.EvaluationAssessmentPublishRequest {
  return { changeId: "publish-a", expectedVersion, expectedInputDigest: preview().inputDigest };
}
function assessment(
  version = 1,
  scorerVersion = scored.rulesVersion,
): C.EvaluationAssessmentSummaryV1 {
  return {
    schemaVersion: "EvaluationAssessmentSummaryV1",
    ...scope,
    assessmentId: `assessment-${version}`,
    version,
    scorerVersion,
    scoringPlanDigest: frozen.digest,
    observationDigest,
    adjudicationDigest,
    reportDigest: sha256(canonicalJson({ ...scored, rulesVersion: scorerVersion })),
    createdAt: now,
    createdBy: { ...actor },
    summary: scoringSummary(scorerVersion),
    caseIds: scored.cases.map((entry) => entry.caseId),
  };
}
function list(page = 1, pageSize = 20, total = 2): C.EvaluationAssessmentListV1 {
  const offset = (page - 1) * pageSize;
  return {
    schemaVersion: "EvaluationAssessmentListV1",
    ...scope,
    page,
    pageSize,
    total,
    items: Array.from({ length: Math.min(pageSize, Math.max(0, total - offset)) }, (_, index) =>
      assessment(total - offset - index),
    ),
  };
}
function caseDetail(): C.EvaluationAssessmentCaseV1 {
  return {
    schemaVersion: "EvaluationAssessmentCaseV1",
    scope: { ...scope, assessmentId: "assessment-1", caseId: "case-a" },
    reportDigest: assessment().reportDigest,
    scoringPlanDigest: frozen.digest,
    caseTitle: "The frozen compiler regression",
    expectation: structuredClone(required(frozen.plan.cases[0])),
    case: structuredClone(required(scored.cases[0])),
  };
}
function path(template: string): string {
  return template
    .replace(":repositoryId", scope.repositoryId)
    .replace(":evaluationId", scope.evaluationId)
    .replace(":assessmentId", "assessment-1")
    .replace(":caseId", "case-a");
}
const previewPath = path(EVALUATION_ASSESSMENT_PATHS.preview);
const assessmentsPath = path(EVALUATION_ASSESSMENT_PATHS.assessments);
const assessmentPath = path(EVALUATION_ASSESSMENT_PATHS.assessment);
const casePath = path(EVALUATION_ASSESSMENT_PATHS.case);
const routes = [
  {
    name: "preview",
    method: "GET",
    path: previewPath,
    operation: "getEvaluationScorePreview",
    input: { ...scope, actor },
    output: preview(),
  },
  {
    name: "publish",
    method: "POST",
    path: assessmentsPath,
    operation: "publishEvaluationAssessment",
    input: { ...scope, actor, request: publishRequest() },
    body: publishRequest(),
    output: assessment(),
  },
  {
    name: "list",
    method: "GET",
    path: assessmentsPath,
    operation: "listEvaluationAssessments",
    input: { ...scope, actor, query: { page: 1, pageSize: 20 } },
    output: list(),
  },
  {
    name: "assessment",
    method: "GET",
    path: assessmentPath,
    operation: "getEvaluationAssessment",
    input: { ...scope, assessmentId: "assessment-1", actor },
    output: assessment(),
  },
  {
    name: "case",
    method: "GET",
    path: casePath,
    operation: "getEvaluationAssessmentCase",
    input: { ...scope, assessmentId: "assessment-1", caseId: "case-a", actor },
    output: caseDetail(),
  },
] as const;
type Route = (typeof routes)[number];
function responseIssues(value: Route["output"]): string[] {
  switch (value.schemaVersion) {
    case "EvaluationScorePreviewV1":
      return C.getEvaluationScorePreviewIssues(value);
    case "EvaluationAssessmentSummaryV1":
      return C.getEvaluationAssessmentSummaryIssues(value);
    case "EvaluationAssessmentListV1":
      return C.getEvaluationAssessmentListIssues(value);
    case "EvaluationAssessmentCaseV1":
      return C.getEvaluationAssessmentCaseIssues(value);
  }
}
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const headers = () => ({
  host: "review.example.test",
  cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
  origin,
});
function routeRequest(route: Route): InjectOptions {
  return {
    method: route.method,
    url: route.path,
    headers: headers(),
    ...("body" in route ? { payload: route.body } : {}),
  };
}
function expectNoStore(response: { headers: Record<string, unknown> }): void {
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers.vary).toBe("Cookie");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
}
function fixture(
  output: unknown,
  options: { authenticated?: boolean; readOnly?: boolean; error?: Error } = {},
) {
  const principal = { ...actor };
  const session = () => ({
    ...principal,
    displayName: "Assessment operator",
    email: null,
    createdAt: now,
    expiresAt: "2026-09-09T00:00:00.000Z",
  });
  const auth: OperatorAuthRouteService = {
    publicOrigin: origin,
    postLoginRedirectPath: "/",
    requiresLoopbackRequest: false,
    secureCookies: true,
    usesBrowserBinding: false,
    ensureBrowserBinding: vi.fn(() => undefined),
    startLogin: vi.fn(async () => ({
      kind: "session" as const,
      sessionToken: token,
      session: session(),
    })),
    completeLogin: vi.fn(async () => {
      throw new Error("No external login in assessment route tests.");
    }),
    getSession: vi.fn(async (value) =>
      value === token && options.authenticated !== false ? session() : null,
    ),
    logout: vi.fn(async () => undefined),
  };
  const database = createOperatorRouteTestDatabase(principal, async () => {
    if (options.error) throw options.error;
    return output;
  });
  const app = Fastify({ logger: false });
  apps.push(app);
  registerOperatorAuthRoutes(app, auth);
  registerEvaluationAssessmentRoutes(app, {
    database: database.database,
    operatorAuth: auth,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  return { app, auth, principal, ...database };
}

describe("evaluation assessment HTTP authority", () => {
  it("uses the real frozen-plan scorer and canonical input digest for its transport fixtures", () => {
    expect(captured.observations).toEqual([]);
    expect(scored.cases[0]?.baseline.executionState).toBe("not_run");
    expect(scored.cases[0]?.candidate.result).toBeNull();
    expect(scored.baseline.coverage.completedCases).toBe(0);
    for (const route of routes) expect(responseIssues(route.output)).toEqual([]);
    expect(preview().inputDigest).toBe(
      digestFor({
        ...scope,
        scorerVersion: scored.rulesVersion,
        scoringPlanDigest: frozen.digest,
        observationDigest,
        adjudicationDigest,
      }),
    );
    expect(publishRequest().expectedInputDigest).toBe(preview().inputDigest);
    expect(caseDetail().caseTitle).toBe("The frozen compiler regression");
    expect(caseDetail().expectation).toEqual(frozen.plan.cases[0]);
  });

  it.each(routes)(
    "binds $name to the exact path and authenticated operator envelope",
    async (route) => {
      const f = fixture(route.output);
      const response = await f.app.inject(routeRequest(route));
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual(route.output);
      expect(f.request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
      expect(f.transport).toHaveBeenCalledExactlyOnceWith("operatorRequest", {
        context: { kind: "operator", actor },
        operation: route.operation,
        input: route.input,
      });
      expect(f.permissions).not.toHaveBeenCalled();
      expectNoStore(response);
    },
  );

  it.each(routes)("rejects unauthenticated $name before owner dispatch", async (route) => {
    const f = fixture(route.output, { authenticated: false });
    const response = await f.app.inject({
      ...routeRequest(route),
      headers: {
        ...headers(),
        "x-operator-subject": actor.subject,
        "x-operator-issuer": actor.issuer,
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("operator_authentication_required");
    expect(f.transport).not.toHaveBeenCalled();
    expectNoStore(response);
  });

  it.each(routes)("rechecks the current session before the next $name request", async (route) => {
    const f = fixture(route.output);
    expect((await f.app.inject(routeRequest(route))).statusCode).toBe(200);
    vi.mocked(f.auth.getSession).mockResolvedValueOnce(null);
    const denied = await f.app.inject(routeRequest(route));
    expect(denied.statusCode).toBe(401);
    expect(f.request).toHaveBeenCalledOnce();
    expectNoStore(denied);
  });

  it("captures the new session actor on a later request without mutating an earlier frame", async () => {
    const f = fixture(preview());
    expect(
      (await f.app.inject({ method: "GET", url: previewPath, headers: headers() })).statusCode,
    ).toBe(200);
    Object.assign(f.principal, {
      issuer: "https://other-identity.example.test",
      subject: "operator-b",
    });
    expect(
      (await f.app.inject({ method: "GET", url: previewPath, headers: headers() })).statusCode,
    ).toBe(200);
    expect(f.request.mock.calls[0]?.[1]).toEqual({ ...scope, actor });
    expect(f.request.mock.calls[1]?.[1]).toEqual({ ...scope, actor: f.principal });
    expect(f.transport.mock.calls[0]?.[1]).toMatchObject({ context: { kind: "operator", actor } });
  });

  it.each(
    [undefined, "null", "https://untrusted.example.test", `${origin}/`, [origin, origin]].map(
      (suppliedOrigin) => ({ suppliedOrigin }),
    ),
  )("requires one exact publish Origin: %j", async ({ suppliedOrigin }) => {
    const f = fixture(assessment());
    const { origin: _origin, ...other } = headers();
    const response = await f.app.inject({
      method: "POST",
      url: assessmentsPath,
      payload: publishRequest(),
      headers: {
        ...other,
        ...(suppliedOrigin === undefined ? {} : { origin: suppliedOrigin }),
      } as unknown as NonNullable<InjectOptions["headers"]>,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("invalid_operator_auth_origin");
    expect(f.transport).not.toHaveBeenCalled();
    expectNoStore(response);
  });

  it.each(routes.filter((route) => route.method === "GET"))(
    "ignores forged caller hints in $name headers and GET bodies",
    async (route) => {
      const f = fixture(route.output);
      const { origin: _origin, ...other } = headers();
      const response = await f.app.inject({
        ...routeRequest(route),
        headers: { ...other, "x-operator-issuer": "forged", "x-operator-subject": "forged" },
        payload: {
          actor: { issuer: "forged", subject: "forged" },
          repositoryId: "foreign",
          evaluationId: "foreign",
          replayOnly: true,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(f.request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
    },
  );

  it("retries the same publish body through the trusted recovery replay restriction", async () => {
    const body = publishRequest();
    const output = assessment();
    const f = fixture(output, { readOnly: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await f.app.inject({
        method: "POST",
        url: assessmentsPath,
        headers: headers(),
        payload: body,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(output);
      expectNoStore(response);
    }
    expect(f.request.mock.calls).toEqual([
      ["publishEvaluationAssessment", { ...scope, actor, request: body, replayOnly: true }],
      ["publishEvaluationAssessment", { ...scope, actor, request: body, replayOnly: true }],
    ]);
  });

  it.each([false, true])(
    "preserves independent owner recovery denial with route readOnly=%s",
    async (readOnly) => {
      const f = fixture(assessment(), {
        readOnly,
        error: new DatabaseRequestError("PRIVATE recovery state", "DATABASE_READ_ONLY"),
      });
      const response = await f.app.inject({
        method: "POST",
        url: assessmentsPath,
        headers: headers(),
        payload: publishRequest(),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("configuration_read_only");
      expect(response.body).not.toContain("PRIVATE");
      expect(f.request).toHaveBeenCalledExactlyOnceWith("publishEvaluationAssessment", {
        ...scope,
        actor,
        request: publishRequest(),
        ...(readOnly ? { replayOnly: true } : {}),
      });
      expectNoStore(response);
    },
  );

  it.each(routes.filter((route) => route.method === "GET"))(
    "keeps $name readable in recovery without a replay flag",
    async (route) => {
      const f = fixture(route.output, { readOnly: true });
      expect((await f.app.inject(routeRequest(route))).statusCode).toBe(200);
      expect(f.request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
      expect(f.request.mock.calls[0]?.[1]).not.toHaveProperty("replayOnly");
    },
  );

  it("retains historical v1 summaries and original authors on read routes", async () => {
    const old = assessment(1, "explicit-matching-v1");
    old.createdBy.subject = "original-publisher";
    const history = list(1, 20, 1);
    history.items = [old];
    for (const [path, output] of [
      [assessmentPath, old],
      [assessmentsPath, history],
    ] as const) {
      const f = fixture(output);
      const response = await f.app.inject({ method: "GET", url: path, headers: headers() });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual(output);
      expect(f.request.mock.calls[0]?.[1]).toMatchObject({ actor });
    }
  });
});

describe("evaluation assessment HTTP input", () => {
  it.each(["repositoryId", "evaluationId"] as const)(
    "rejects malformed %s on every route",
    async (field) => {
      for (const route of routes) {
        const f = fixture(route.output);
        for (const invalid of ["%20invalid", "invalid%20", "invalid%0a", "invalid%2Fpart"]) {
          const response = await f.app.inject({
            ...routeRequest(route),
            url: route.path.replace(`/${scope[field]}`, `/${invalid}`),
          });
          expect(response.statusCode, `${route.name}: ${field}`).toBe(400);
          expectNoStore(response);
        }
        expect(f.transport).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects transformed assessment and case selectors before owner dispatch", async () => {
    for (const [path, field] of [
      [assessmentPath, "assessment-1"],
      [casePath, "assessment-1"],
      [casePath, "case-a"],
    ]) {
      const f = fixture(null);
      for (const invalid of ["%20invalid", "invalid%20", "invalid%0a", "invalid%2Fpart"])
        expect(
          (
            await f.app.inject({
              method: "GET",
              url: required(path).replace(`/${field}`, `/${invalid}`),
              headers: headers(),
            })
          ).statusCode,
        ).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
    }
  });

  it.each(routes)("rejects unsupported public query fields for $name", async (route) => {
    const f = fixture(route.output, { readOnly: true });
    for (const query of [
      "actor=forged",
      "replayOnly=true",
      "repositoryId=foreign",
      "evaluationId=foreign",
      "assessmentId=other",
      "caseId=other",
      "inputDigest=other",
      "observations=claimed",
      ...(route.name === "list" ? [] : ["page=1", "pageSize=20"]),
    ]) {
      const response = await f.app.inject({
        ...routeRequest(route),
        url: `${route.path}?${query}`,
      });
      expect(response.statusCode, query).toBe(400);
      expectNoStore(response);
    }
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("rejects repeated, noncanonical, and overflowing list pagination", async () => {
    const f = fixture(list());
    for (const query of [
      "page=1&page=2",
      "pageSize=20&pageSize=20",
      "page=",
      "page=0",
      "page=-1",
      "page=1.5",
      "page=01",
      "page=1e2",
      "page=1%20",
      "page=1%0a",
      "page=9007199254740992",
      "page=9007199254740991&pageSize=50",
      "pageSize=0",
      "pageSize=51",
      "pageSize=02",
    ])
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: `${assessmentsPath}?${query}`,
            headers: headers(),
          })
        ).statusCode,
        query,
      ).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each([
    { page: 2, pageSize: 1, total: 3 },
    { page: 1, pageSize: 50, total: 50 },
    { page: 3, pageSize: 20, total: 2 },
  ])("forwards the exact requested list window %j", async ({ page, pageSize, total }) => {
    const output = list(page, pageSize, total);
    const f = fixture(output);
    const response = await f.app.inject({
      method: "GET",
      url: `${assessmentsPath}?page=${page}&pageSize=${pageSize}`,
      headers: headers(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(output);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("listEvaluationAssessments", {
      ...scope,
      actor,
      query: { page, pageSize },
    });
  });

  it("accepts only the three declared publish fields and rejects caller-owned score material", async () => {
    const f = fixture(assessment(), { readOnly: true });
    for (const extra of [
      { observations: [] },
      { adjudications: [] },
      { score: scored },
      { summary: scoringSummary() },
      { report: scored },
      { caseTitle: "replacement" },
      { expectation: plan.cases[0] },
      { actor },
      { replayOnly: true },
      { replayOnly: false },
      { readOnly: false },
      { repositoryId: scope.repositoryId },
      { evaluationId: scope.evaluationId },
      { scorerVersion: scored.rulesVersion },
      { selectionDigest: preview().selectionDigest },
      { inputDigest: preview().inputDigest },
    ]) {
      const response = await f.app.inject({
        method: "POST",
        url: assessmentsPath,
        headers: headers(),
        payload: { ...publishRequest(), ...extra },
      });
      expect(response.statusCode).toBe(400);
    }
    for (const field of Object.keys(publishRequest())) {
      const missing: Record<string, unknown> = publishRequest();
      delete missing[field];
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: assessmentsPath,
            headers: headers(),
            payload: missing,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("rejects malformed publish identities, CAS versions, and input digests", async () => {
    const f = fixture(assessment());
    for (const patch of [
      { changeId: "" },
      { changeId: " change-a" },
      { changeId: "change-a\n" },
      { changeId: "bad\ud800" },
      { expectedVersion: -1 },
      { expectedVersion: 0.5 },
      { expectedVersion: "0" },
      { expectedVersion: Number.MAX_SAFE_INTEGER },
      { expectedInputDigest: "A".repeat(64) },
      { expectedInputDigest: "a".repeat(63) },
      { expectedInputDigest: null },
    ])
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: assessmentsPath,
            headers: headers(),
            payload: { ...publishRequest(), ...patch },
          })
        ).statusCode,
      ).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each([0, Number.MAX_SAFE_INTEGER - 1])(
    "accepts the supported publish CAS boundary %s",
    async (expectedVersion) => {
      const body = publishRequest(expectedVersion);
      const output = assessment(expectedVersion + 1);
      const f = fixture(output);
      const response = await f.app.inject({
        method: "POST",
        url: assessmentsPath,
        headers: headers(),
        payload: body,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual(output);
      expect(f.request).toHaveBeenCalledExactlyOnceWith("publishEvaluationAssessment", {
        ...scope,
        actor,
        request: body,
      });
    },
  );

  it.each([
    {
      name: "malformed JSON",
      payload: '{"changeId":"PRIVATE-parser-input",',
      contentType: "application/json",
      status: 400,
    },
    { name: "empty JSON", payload: "", contentType: "application/json", status: 400 },
    {
      name: "oversized JSON",
      payload: JSON.stringify({
        ...publishRequest(),
        padding: `PRIVATE-parser-input${"x".repeat(C.maximumEvaluationAssessmentReceiptUtf8Bytes)}`,
      }),
      contentType: "application/json",
      status: 413,
    },
    {
      name: "oversized multibyte JSON",
      payload: JSON.stringify({
        ...publishRequest(),
        padding: "雪".repeat(Math.ceil(C.maximumEvaluationAssessmentReceiptUtf8Bytes / 3)),
      }),
      contentType: "application/json",
      status: 413,
    },
    {
      name: "unsupported media",
      payload: "PRIVATE-parser-input",
      contentType: "application/octet-stream",
      status: 415,
    },
    { name: "plain text", payload: "PRIVATE-parser-input", contentType: "text/plain", status: 400 },
    { name: "array JSON", payload: "[]", contentType: "application/json", status: 400 },
    { name: "null JSON", payload: "null", contentType: "application/json", status: 400 },
  ])(
    "redacts $name and rejects it before owner dispatch",
    async ({ payload, contentType, status }) => {
      const f = fixture(assessment());
      const response = await f.app.inject({
        method: "POST",
        url: assessmentsPath,
        headers: { ...headers(), "content-type": contentType },
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({
        code: "evaluation_request_invalid",
        retryable: false,
      });
      expect(response.body).not.toContain("PRIVATE-parser-input");
      expect(f.transport).not.toHaveBeenCalled();
      expectNoStore(response);
    },
  );
});

describe("evaluation assessment HTTP response binding", () => {
  it.each(routes)(
    "rejects a helper-valid foreign repository or evaluation for $name",
    async (route) => {
      for (const field of ["repositoryId", "evaluationId"] as const) {
        const output = structuredClone(route.output);
        if (output.schemaVersion === "EvaluationAssessmentCaseV1")
          output.scope[field] = `foreign-${field}`;
        else {
          output[field] = `foreign-${field}`;
          if (output.schemaVersion === "EvaluationAssessmentListV1")
            for (const item of output.items) item[field] = output[field];
          if (output.schemaVersion === "EvaluationScorePreviewV1")
            output.inputDigest = digestFor({
              repositoryId: output.repositoryId,
              evaluationId: output.evaluationId,
              scorerVersion: output.summary.rulesVersion,
              scoringPlanDigest: output.scoringPlanDigest,
              observationDigest: output.observationDigest,
              adjudicationDigest: output.adjudicationDigest,
            });
        }
        expect(responseIssues(output)).toEqual([]);
        const f = fixture(output);
        const response = await f.app.inject(routeRequest(route));
        expect(response.statusCode, `${route.name}: ${field}`).toBe(502);
        expect(response.json().code).toBe("evaluation_response_invalid");
        expect(response.body).not.toContain(`foreign-${field}`);
        expect(f.transport).toHaveBeenCalledOnce();
        expectNoStore(response);
      }
    },
  );

  it("rejects helper-valid responses for another published assessment or case", async () => {
    const published = { ...assessment(), assessmentId: "foreign-assessment" };
    const otherAssessmentCase = caseDetail();
    otherAssessmentCase.scope.assessmentId = "foreign-assessment";
    const otherCase = caseDetail();
    otherCase.scope.caseId = "foreign-case";
    otherCase.case.caseId = "foreign-case";
    otherCase.expectation.caseId = "foreign-case";
    for (const [path, output] of [
      [assessmentPath, published],
      [casePath, otherAssessmentCase],
      [casePath, otherCase],
    ] as const) {
      expect(responseIssues(output)).toEqual([]);
      const f = fixture(output);
      const response = await f.app.inject({ method: "GET", url: path, headers: headers() });
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain("foreign-");
    }
  });

  it.each(["inputDigest", "observationDigest", "adjudicationDigest", "scoringPlanDigest"] as const)(
    "rejects a helper-valid preview with an inconsistent %s",
    async (field) => {
      const output = preview();
      output[field] = "b".repeat(64);
      if (field === "scoringPlanDigest") output.summary.planDigest = output.scoringPlanDigest;
      expect(C.getEvaluationScorePreviewIssues(output)).toEqual([]);
      const f = fixture(output);
      const response = await f.app.inject({ method: "GET", url: previewPath, headers: headers() });
      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe("evaluation_response_invalid");
    },
  );

  it.each([
    {
      name: "another CAS version",
      mutate: (value: C.EvaluationAssessmentSummaryV1) => {
        value.version += 1;
      },
    },
    {
      name: "another actor issuer",
      mutate: (value: C.EvaluationAssessmentSummaryV1) => {
        value.createdBy.issuer = "https://foreign.example.test";
      },
    },
    {
      name: "another actor subject",
      mutate: (value: C.EvaluationAssessmentSummaryV1) => {
        value.createdBy.subject = "foreign-publisher";
      },
    },
    {
      name: "another scoring plan",
      mutate: (value: C.EvaluationAssessmentSummaryV1) => {
        value.scoringPlanDigest = "b".repeat(64);
        value.summary.planDigest = value.scoringPlanDigest;
      },
    },
    {
      name: "another observation digest",
      mutate: (value: C.EvaluationAssessmentSummaryV1) => {
        value.observationDigest = "b".repeat(64);
      },
    },
    {
      name: "another adjudication digest",
      mutate: (value: C.EvaluationAssessmentSummaryV1) => {
        value.adjudicationDigest = "b".repeat(64);
      },
    },
    {
      name: "another supported scorer",
      mutate: (value: C.EvaluationAssessmentSummaryV1) => {
        value.scorerVersion = "explicit-matching-v1";
        value.summary.rulesVersion = "explicit-matching-v1";
      },
    },
  ])("rejects a helper-valid publish receipt with $name", async ({ mutate }) => {
    const output = assessment();
    mutate(output);
    expect(C.getEvaluationAssessmentPublishResponseIssues(output)).toEqual([]);
    const f = fixture(output);
    const response = await f.app.inject({
      method: "POST",
      url: assessmentsPath,
      headers: headers(),
      payload: publishRequest(),
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("evaluation_response_invalid");
    expect(response.body).not.toContain("foreign-");
    expect(f.transport).toHaveBeenCalledOnce();
  });

  it("does not accept a successful reply for a different well-formed expected input digest", async () => {
    const body = { ...publishRequest(), expectedInputDigest: "b".repeat(64) };
    expect(C.getEvaluationAssessmentPublishRequestIssues(body)).toEqual([]);
    const f = fixture(assessment());
    const response = await f.app.inject({
      method: "POST",
      url: assessmentsPath,
      headers: headers(),
      payload: body,
    });
    expect(response.statusCode).toBe(502);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("publishEvaluationAssessment", {
      ...scope,
      actor,
      request: body,
    });
  });

  it("rejects mismatched summary plan or scorer digests before returning report data", async () => {
    for (const route of routes.filter(
      (entry): entry is Extract<Route, { name: "preview" | "publish" | "assessment" }> =>
        entry.name === "preview" || entry.name === "publish" || entry.name === "assessment",
    )) {
      const output = structuredClone(route.output);
      output.summary.planDigest = "b".repeat(64);
      const schema =
        output.schemaVersion === "EvaluationScorePreviewV1"
          ? C.EvaluationScorePreviewV1Schema
          : C.EvaluationAssessmentSummaryV1Schema;
      expect(Value.Check(schema, output)).toBe(true);
      const f = fixture(output);
      const response = await f.app.inject(routeRequest(route));
      expect(response.statusCode).toBe(502);
    }
    const inconsistent = assessment();
    inconsistent.summary.rulesVersion = "explicit-matching-v1";
    const f = fixture(inconsistent);
    expect(
      (await f.app.inject({ method: "GET", url: assessmentPath, headers: headers() })).statusCode,
    ).toBe(502);
  });

  it("rejects wrong list windows, missing versions, and repeated identities", async () => {
    for (const output of [
      list(2, 20, 21),
      { ...list(), items: [] },
      { ...list(), total: 3 },
      { ...list(), items: [...list().items].reverse() },
      { ...list(), items: [assessment(2), { ...assessment(1), assessmentId: "assessment-2" }] },
    ]) {
      if (output.page === 2) expect(C.getEvaluationAssessmentListIssues(output)).toEqual([]);
      const f = fixture(output);
      const response = await f.app.inject({
        method: "GET",
        url: assessmentsPath,
        headers: headers(),
      });
      expect(response.statusCode).toBe(502);
    }
  });

  it("rejects missing frozen case labels and foreign execution bindings", async () => {
    const missing = { ...caseDetail() } as Record<string, unknown>;
    delete missing.expectation;
    const foreign = caseDetail();
    foreign.expectation.baselineBinding.runId = "PRIVATE-foreign-run";
    const missingCriterion = caseDetail();
    missingCriterion.case.candidate.criteria = [];
    for (const output of [
      missing,
      foreign,
      missingCriterion,
      { ...caseDetail(), observations: [] },
    ]) {
      const f = fixture(output);
      const response = await f.app.inject({ method: "GET", url: casePath, headers: headers() });
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain("PRIVATE");
      expect(response.body).not.toContain("The known compiler regression is reported.");
    }
  });

  it("enforces the smaller receipt budget and complete read-response budget", async () => {
    const receipt = assessment();
    receipt.createdAt = `2026-09-08T01:00:00.${"0".repeat(C.maximumEvaluationAssessmentReceiptUtf8Bytes)}Z`;
    expect(C.getEvaluationAssessmentSummaryIssues(receipt)).toEqual([]);
    const f = fixture(receipt);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: assessmentsPath,
          headers: headers(),
          payload: publishRequest(),
        })
      ).statusCode,
    ).toBe(502);
    const tooLarge = preview();
    tooLarge.generatedAt = `2026-09-08T01:00:00.${"0".repeat(C.maximumEvaluationAssessmentReadUtf8Bytes)}Z`;
    const large = fixture(tooLarge);
    expect(
      (await large.app.inject({ method: "GET", url: previewPath, headers: headers() })).statusCode,
    ).toBe(502);
  });

  it.each(routes)(
    "preserves current owner permission and conflict decisions for $name",
    async (route) => {
      for (const [code, status] of [
        ["PLATFORM_NOT_FOUND", 404],
        ["PLATFORM_FORBIDDEN", 403],
        ["PLATFORM_INVALID", 400],
        ["PLATFORM_CONFLICT", 409],
      ] as const) {
        const f = fixture(route.output, {
          error: new DatabaseRequestError("PRIVATE owner state", code),
        });
        const response = await f.app.inject(routeRequest(route));
        expect(response.statusCode).toBe(status);
        expect(response.json().code).toBe(code.toLowerCase());
        expect(response.body).not.toContain("PRIVATE");
        expect(f.transport).toHaveBeenCalledOnce();
        expectNoStore(response);
      }
    },
  );

  it("maps only the exact owner page-work limit to the public smaller-page error", async () => {
    const f = fixture(list(), {
      error: new DatabaseRequestError(
        EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE,
        "PLATFORM_INVALID",
      ),
    });
    const response = await f.app.inject({
      method: "GET",
      url: `${assessmentsPath}?page=1&pageSize=50`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: "evaluation_report_page_too_large",
      message: "Choose a smaller page size to load these reports.",
      retryable: false,
    });
    expect(response.body).not.toContain(EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("listEvaluationAssessments", {
      ...scope,
      actor,
      query: { page: 1, pageSize: 50 },
    });
    expect(f.transport).toHaveBeenCalledOnce();
    expectNoStore(response);
  });

  it.each([
    {
      error: new DatabaseRequestError(
        `${EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE} PRIVATE detail`,
        "PLATFORM_INVALID",
      ),
      status: 400,
      code: "platform_invalid",
    },
    {
      error: new DatabaseRequestError(
        ` ${EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE}`,
        "PLATFORM_INVALID",
      ),
      status: 400,
      code: "platform_invalid",
    },
    {
      error: new DatabaseRequestError("PRIVATE invalid report input", "PLATFORM_INVALID"),
      status: 400,
      code: "platform_invalid",
    },
    {
      error: new DatabaseRequestError(
        EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE,
        "PLATFORM_CONFLICT",
      ),
      status: 409,
      code: "platform_conflict",
    },
    {
      error: new DatabaseRequestError(EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE),
      status: 500,
      code: "configuration_operation_failed",
    },
    {
      error: new Error(EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE),
      status: 500,
      code: "configuration_operation_failed",
    },
  ])(
    "does not expose or misclassify another list failure: $code",
    async ({ error, status, code }) => {
      const f = fixture(list(), { error });
      const response = await f.app.inject({
        method: "GET",
        url: assessmentsPath,
        headers: headers(),
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().code).toBe(code);
      expect(response.json().code).not.toBe("evaluation_report_page_too_large");
      expect(response.body).not.toContain("PRIVATE");
      expect(response.body).not.toContain(EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE);
      expect(f.transport).toHaveBeenCalledOnce();
      expectNoStore(response);
    },
  );

  it.each(routes)(
    "redacts unexpected owner failures for $name without retrying raw RPC",
    async (route) => {
      for (const error of [
        new Error("PRIVATE datastore path"),
        new DatabaseRequestError("PRIVATE corrupt report", "PLATFORM_CORRUPT"),
      ]) {
        const f = fixture(route.output, { error });
        const response = await f.app.inject(routeRequest(route));
        expect(response.statusCode).toBe(500);
        expect(response.json()).toMatchObject({
          code: "configuration_operation_failed",
          retryable: false,
        });
        expect(response.body).not.toContain("PRIVATE");
        expect(response.body).not.toContain("stack");
        expect(f.transport).toHaveBeenCalledOnce();
        expectNoStore(response);
      }
    },
  );

  it("does not expose unsupported methods or internal scorer entry points", async () => {
    const f = fixture(null);
    for (const [method, path] of [
      ["POST", previewPath],
      ["PUT", assessmentsPath],
      ["PATCH", assessmentPath],
      ["DELETE", assessmentPath],
      ["POST", casePath],
      ["POST", `${previewPath}/captureEvaluationObservations`],
    ] as const)
      expect(
        (await f.app.inject({ method, url: path, headers: headers(), payload: {} })).statusCode,
      ).toBe(404);
    expect(f.transport).not.toHaveBeenCalled();
  });
});
