import * as C from "@agentic-review/contracts";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseRequestError } from "../database/errors.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { registerEvaluationAdjudicationRoutes } from "./evaluation-adjudication.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";
import {
  operatorConfigurationRateLimits,
  registerOperatorConfigurationRateLimits,
} from "./operator-rate-limit.js";

const actor = { issuer: "https://evaluations.example.test", subject: "operator-a" };
const origin = "https://review.example.test";
const token = "J".repeat(43);
const now = "2026-09-08T01:00:00.000Z";
const resultDigest = "a".repeat(64);
const resultScope: C.EvaluationCellResultReadQuery = {
  repositoryId: "repository-a",
  evaluationId: "evaluation-a",
  cellId: "cell-baseline",
  resultId: "result-baseline",
};
function occurrence(ordinal = 0): C.FindingOccurrenceRef {
  const identity = {
    resultId: resultScope.resultId,
    resultDigest,
    kind: "validation_observation" as const,
    ordinal,
  };
  return {
    ...identity,
    key: sha256(canonicalJson({ schemaVersion: "FindingOccurrenceV1", ...identity })),
  };
}
const scope: C.EvaluationAdjudicationScope = {
  ...resultScope,
  occurrenceKey: occurrence().key,
};
const resultPath = `/api/v1/operator/repositories/${scope.repositoryId}/evaluations/${scope.evaluationId}/cells/${scope.cellId}/results/${scope.resultId}`;
const contextPath = `${resultPath}/adjudications`;
const changePath = `${contextPath}/${scope.occurrenceKey}`;
const historyPath = `${changePath}/history`;
const judgments: readonly C.EvaluationAdjudicationChangeRequest["judgment"][] = [
  {
    kind: "match",
    expectedFindingId: "expected-a",
    reason: "This occurrence matches the frozen regression.",
  },
  {
    kind: "duplicate",
    primaryOccurrenceKey: occurrence(1).key,
    reason: "The reviewer selected the other occurrence as the primary finding.",
  },
  {
    kind: "false_positive",
    reason: "This occurrence does not describe a defect in the frozen example.",
  },
  {
    kind: "unjudged",
    reason: "Reopen this occurrence for another review.\nPreserve this explanation.",
  },
];
function request(
  judgment: C.EvaluationAdjudicationChangeRequest["judgment"] = {
    kind: "false_positive",
    reason: "The frozen example does not contain this defect.",
  },
): C.EvaluationAdjudicationChangeRequest {
  return { changeId: "change-a", expectedVersion: 1, resultDigest, judgment };
}
function adjudication(version = 1, judgment = request().judgment): C.EvaluationFindingAdjudication {
  return {
    adjudicationId: `event-${version}`,
    caseId: "case-a",
    arm: "baseline",
    resultId: scope.resultId,
    resultDigest,
    occurrenceKey: scope.occurrenceKey,
    ...judgment,
    actor: { ...actor },
    createdAt: now,
  };
}
function context(): C.EvaluationAdjudicationContextV1 {
  return {
    schemaVersion: "EvaluationAdjudicationContextV1",
    scope: { ...resultScope },
    resultDigest,
    caseId: "case-a",
    arm: "baseline",
    modelRequired: true,
    modelState: "completed",
    expectations: {
      annotation: "complete",
      expected: [{ expectedFindingId: "expected-a", description: "Detect the known regression." }],
    },
    items: [
      { occurrence: occurrence(), version: 1, adjudication: adjudication() },
      { occurrence: occurrence(1), version: 0, adjudication: null },
    ],
  };
}
function change(body = request()): C.EvaluationAdjudicationChangeV1 {
  return {
    schemaVersion: "EvaluationAdjudicationChangeV1",
    scope: { ...scope },
    previousVersion: body.expectedVersion,
    version: body.expectedVersion + 1,
    adjudication: adjudication(body.expectedVersion + 1, body.judgment),
  };
}
function history(page = 1, pageSize = 20, total = 2): C.EvaluationAdjudicationHistoryV1 {
  const offset = (page - 1) * pageSize;
  return {
    schemaVersion: "EvaluationAdjudicationHistoryV1",
    scope: { ...scope },
    resultDigest,
    page,
    pageSize,
    total,
    items: Array.from({ length: Math.min(pageSize, Math.max(0, total - offset)) }, (_, index) => {
      const version = total - offset - index;
      return {
        version,
        previousEventId: version === 1 ? null : `event-${version - 1}`,
        adjudication: adjudication(version),
      };
    }),
  };
}
const routes = [
  {
    name: "context",
    method: "GET",
    path: contextPath,
    operation: "getEvaluationAdjudicationContext",
    input: { ...resultScope, actor },
    output: context(),
  },
  {
    name: "change",
    method: "PUT",
    path: changePath,
    operation: "changeEvaluationAdjudication",
    input: { ...scope, actor, request: request() },
    body: request(),
    output: change(),
  },
  {
    name: "history",
    method: "GET",
    path: historyPath,
    operation: "listEvaluationAdjudicationHistory",
    input: { ...scope, actor, query: { page: 1, pageSize: 20 } },
    output: history(),
  },
] as const;
type Route = (typeof routes)[number];
function responseIssues(value: Route["output"]): string[] {
  if (value.schemaVersion === "EvaluationAdjudicationContextV1")
    return C.getEvaluationAdjudicationContextIssues(value);
  if (value.schemaVersion === "EvaluationAdjudicationChangeV1")
    return C.getEvaluationAdjudicationChangeIssues(value);
  return C.getEvaluationAdjudicationHistoryIssues(value);
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
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("The fixture entry is missing.");
  return value;
}
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
    startLogin: vi.fn(async () => ({ kind: "session" as const, sessionToken: token, session })),
    completeLogin: vi.fn(async () => {
      throw new Error("No external login in evaluation adjudication route tests.");
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
  app.register(async (routeScope) => {
    if (options.rateLimits) await registerOperatorConfigurationRateLimits(routeScope, auth);
    registerEvaluationAdjudicationRoutes(routeScope, {
      database: database.database,
      operatorAuth: auth,
      ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    });
  });
  return { app, auth, ...database };
}

describe("evaluation adjudication HTTP authority", () => {
  it.each(routes)(
    "binds $name to the session actor and exact path through operatorRequest",
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
    const response = await f.app.inject(routeRequest(route));
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("operator_authentication_required");
    expect(f.transport).not.toHaveBeenCalled();
    expectNoStore(response);
  });

  it.each(routes)("rechecks the session for the next $name request", async (route) => {
    const f = fixture(route.output);
    expect((await f.app.inject(routeRequest(route))).statusCode).toBe(200);
    vi.mocked(f.auth.getSession).mockResolvedValueOnce(null);
    const denied = await f.app.inject(routeRequest(route));
    expect(denied.statusCode).toBe(401);
    expect(f.request).toHaveBeenCalledOnce();
    expectNoStore(denied);
  });

  it.each(
    [undefined, "null", "https://untrusted.example.test", `${origin}/`, [origin, origin]].map(
      (suppliedOrigin) => ({ suppliedOrigin }),
    ),
  )("requires one exact mutation Origin: %j", async ({ suppliedOrigin }) => {
    const f = fixture(change());
    const { origin: _origin, ...other } = headers();
    const response = await f.app.inject({
      method: "PUT",
      url: changePath,
      payload: request(),
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
    "takes $name scope from the path even if a GET body supplies another caller",
    async (route) => {
      const f = fixture(route.output);
      const { origin: _origin, ...readHeaders } = headers();
      const response = await f.app.inject({
        ...routeRequest(route),
        headers: readHeaders,
        payload: {
          actor: { issuer: "forged", subject: "forged" },
          repositoryId: "foreign",
          replayOnly: true,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(f.request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
    },
  );

  it("lets the owner return an exact original receipt during read-only recovery", async () => {
    const body = request();
    const receipt = change(body);
    const f = fixture(receipt, { readOnly: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await f.app.inject({
        method: "PUT",
        url: changePath,
        headers: headers(),
        payload: body,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(receipt);
      expectNoStore(response);
    }
    expect(f.request).toHaveBeenCalledTimes(2);
    for (const call of f.request.mock.calls)
      expect(call).toEqual([
        "changeEvaluationAdjudication",
        { ...scope, actor, request: body, replayOnly: true },
      ]);
  });

  it.each([false, true])(
    "preserves owner recovery denial with route readOnly=%s",
    async (readOnly) => {
      const f = fixture(change(), {
        readOnly,
        error: new DatabaseRequestError("PRIVATE recovery context", "DATABASE_READ_ONLY"),
      });
      const response = await f.app.inject({
        method: "PUT",
        url: changePath,
        headers: headers(),
        payload: request(),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("configuration_read_only");
      expect(response.body).not.toContain("PRIVATE");
      expect(f.request).toHaveBeenCalledExactlyOnceWith("changeEvaluationAdjudication", {
        ...scope,
        actor,
        request: request(),
        ...(readOnly ? { replayOnly: true } : {}),
      });
      expectNoStore(response);
    },
  );

  it.each(routes.filter((route) => route.method === "GET"))(
    "keeps $name readable in recovery without adding a replay flag",
    async (route) => {
      const f = fixture(route.output, { readOnly: true });
      const response = await f.app.inject(routeRequest(route));
      expect(response.statusCode).toBe(200);
      expect(f.request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
    },
  );

  it("preserves historical judgment authors instead of replacing them with the reader", async () => {
    const previousActor = { issuer: actor.issuer, subject: "previous-reviewer" };
    const current = context();
    required(required(current.items[0]).adjudication).actor = previousActor;
    const events = history();
    for (const item of events.items) item.adjudication.actor = previousActor;
    for (const [path, output] of [
      [contextPath, current],
      [historyPath, events],
    ] as const) {
      const f = fixture(output);
      const response = await f.app.inject({ method: "GET", url: path, headers: headers() });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(output);
      expect(f.request.mock.calls[0]?.[1]).toMatchObject({ actor });
    }
  });
});

describe("evaluation adjudication HTTP input", () => {
  it.each(["repositoryId", "evaluationId", "cellId", "resultId"] as const)(
    "rejects malformed %s on every route before dispatch",
    async (field) => {
      for (const route of routes) {
        const f = fixture(route.output);
        for (const invalidId of ["%20invalid", "invalid%20", "invalid%0a", "invalid%2Fpart"]) {
          const response = await f.app.inject({
            ...routeRequest(route),
            url: route.path.replace(`/${scope[field]}`, `/${invalidId}`),
          });
          expect(response.statusCode, `${route.name}: ${field}=${invalidId}`).toBe(400);
          expectNoStore(response);
        }
        expect(f.transport).not.toHaveBeenCalled();
      }
    },
  );

  it.each(routes.filter((route) => route.name !== "context"))(
    "requires a complete lowercase occurrence digest for $name",
    async (route) => {
      const f = fixture(route.output);
      for (const key of [
        "a".repeat(63),
        "a".repeat(65),
        "A".repeat(64),
        "g".repeat(64),
        `${scope.occurrenceKey}%0a`,
      ]) {
        const response = await f.app.inject({
          ...routeRequest(route),
          url: route.path.replace(scope.occurrenceKey, key),
        });
        expect(response.statusCode, key).toBe(400);
      }
      expect(f.transport).not.toHaveBeenCalled();
    },
  );

  it.each(routes)(
    "rejects public authority and unsupported query fields on $name",
    async (route) => {
      const f = fixture(route.output, { readOnly: true });
      for (const query of [
        "actor=forged",
        "replayOnly=true",
        "replayOnly=false",
        "repositoryId=foreign",
        "evaluationId=other",
        "cellId=other",
        "resultId=other",
        "occurrenceKey=other",
        "changeId=other",
        "unknown=1",
        ...(route.name === "history" ? [] : ["page=1", "pageSize=20"]),
      ]) {
        const response = await f.app.inject({
          ...routeRequest(route),
          url: `${route.path}?${query}`,
        });
        expect(response.statusCode, query).toBe(400);
        expectNoStore(response);
      }
      expect(f.transport).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed, repeated and overflowing history pagination", async () => {
    const f = fixture(history());
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
      "pageSize=1.5",
      "pageSize=02",
      "pageSize=20%0a",
    ]) {
      const response = await f.app.inject({
        method: "GET",
        url: `${historyPath}?${query}`,
        headers: headers(),
      });
      expect(response.statusCode, query).toBe(400);
    }
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each([
    { page: 2, pageSize: 1, total: 3 },
    { page: 1, pageSize: 50, total: 50 },
    { page: 3, pageSize: 20, total: 2 },
  ])(
    "binds exact history pagination %j including an empty later page",
    async ({ page, pageSize, total }) => {
      const output = history(page, pageSize, total);
      const f = fixture(output);
      const response = await f.app.inject({
        method: "GET",
        url: `${historyPath}?page=${page}&pageSize=${pageSize}`,
        headers: headers(),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual(output);
      expect(f.request).toHaveBeenCalledExactlyOnceWith("listEvaluationAdjudicationHistory", {
        ...scope,
        actor,
        query: { page, pageSize },
      });
    },
  );

  it("rejects client authority, execution data and replay flags in the mutation body", async () => {
    const f = fixture(change(), { readOnly: true });
    for (const extra of [
      { actor },
      { replayOnly: true },
      { replayOnly: false },
      { readOnly: false },
      { repositoryId: scope.repositoryId },
      { evaluationId: scope.evaluationId },
      { cellId: scope.cellId },
      { resultId: scope.resultId },
      { occurrenceKey: scope.occurrenceKey },
      { authorization: { kind: "operator_evaluation" } },
      { result: {} },
      { modelState: "completed" },
    ]) {
      const response = await f.app.inject({
        method: "PUT",
        url: changePath,
        headers: headers(),
        payload: { ...request(), ...extra },
      });
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(["changeId", "expectedVersion", "resultDigest", "judgment"])(
    "requires mutation field %s",
    async (field) => {
      const payload: Record<string, unknown> = { ...request() };
      delete payload[field];
      const f = fixture(change());
      const response = await f.app.inject({
        method: "PUT",
        url: changePath,
        headers: headers(),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
    },
  );

  it("requires bounded exact change identity, digest and compare-and-swap version", async () => {
    const f = fixture(change());
    for (const replacement of [
      { changeId: "" },
      { changeId: " change-a" },
      { changeId: "change-a\n" },
      { changeId: "change/a" },
      { expectedVersion: -1 },
      { expectedVersion: 1.5 },
      { expectedVersion: "1" },
      { expectedVersion: Number.MAX_SAFE_INTEGER },
      { resultDigest: "A".repeat(64) },
      { resultDigest: "a".repeat(63) },
      { resultDigest: `${resultDigest}\n` },
    ]) {
      const response = await f.app.inject({
        method: "PUT",
        url: changePath,
        headers: headers(),
        payload: { ...request(), ...replacement },
      });
      expect(response.statusCode, JSON.stringify(replacement)).toBe(400);
    }
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("requires an explicit supported judgment and a bounded nonempty human reason", async () => {
    const f = fixture(change());
    const invalidJudgments = [
      { kind: "match", reason: "Missing the expected finding." },
      { kind: "duplicate", reason: "Missing the primary occurrence." },
      { kind: "true_positive", reason: "An unsupported inferred judgment." },
      { kind: "false_positive", reason: "Unexpected field.", expectedFindingId: "expected-a" },
      { kind: "unjudged", reason: "Unexpected field.", primaryOccurrenceKey: occurrence(1).key },
      { kind: "match", expectedFindingId: " expected-a", reason: "Invalid identity." },
      { kind: "duplicate", primaryOccurrenceKey: "A".repeat(64), reason: "Invalid key." },
      ...["", " \n\t", "bad\0reason", "x".repeat(2049), "bad\ud800reason"].map((reason) => ({
        kind: "false_positive",
        reason,
      })),
    ];
    for (const judgment of invalidJudgments) {
      const response = await f.app.inject({
        method: "PUT",
        url: changePath,
        headers: headers(),
        payload: { ...request(), judgment },
      });
      expect(response.statusCode, JSON.stringify(judgment)).toBe(400);
    }
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(judgments)(
    "preserves the explicit $kind judgment without inference",
    async (judgment) => {
      const body = request(judgment);
      const receipt = change(body);
      const f = fixture(receipt);
      const response = await f.app.inject({
        method: "PUT",
        url: changePath,
        headers: headers(),
        payload: body,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual(receipt);
      expect(f.request).toHaveBeenCalledExactlyOnceWith("changeEvaluationAdjudication", {
        ...scope,
        actor,
        request: body,
      });
    },
  );

  it.each([0, Number.MAX_SAFE_INTEGER - 1])(
    "accepts the supported compare-and-swap boundary %s",
    async (expectedVersion) => {
      const body = { ...request(), expectedVersion };
      const receipt = change(body);
      const f = fixture(receipt);
      const response = await f.app.inject({
        method: "PUT",
        url: changePath,
        headers: headers(),
        payload: body,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual(receipt);
      expect(f.request).toHaveBeenCalledExactlyOnceWith("changeEvaluationAdjudication", {
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
        ...request(),
        padding: `PRIVATE-parser-input${"x".repeat(C.maximumEvaluationAdjudicationChangeUtf8Bytes)}`,
      }),
      contentType: "application/json",
      status: 413,
    },
    {
      name: "oversized multibyte JSON",
      payload: JSON.stringify({
        ...request(),
        padding: "雪".repeat(Math.ceil(C.maximumEvaluationAdjudicationChangeUtf8Bytes / 3)),
      }),
      contentType: "application/json",
      status: 413,
    },
    {
      name: "unsupported media type",
      payload: "PRIVATE-parser-input",
      contentType: "application/octet-stream",
      status: 415,
    },
    { name: "text body", payload: "PRIVATE-parser-input", contentType: "text/plain", status: 400 },
    { name: "array body", payload: "[]", contentType: "application/json", status: 400 },
    { name: "null body", payload: "null", contentType: "application/json", status: 400 },
  ])("redacts $name and stops before owner dispatch", async ({ payload, contentType, status }) => {
    const f = fixture(change());
    const response = await f.app.inject({
      method: "PUT",
      url: changePath,
      headers: { ...headers(), "content-type": contentType },
      payload,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code: "evaluation_request_invalid", retryable: false });
    expect(response.body).not.toContain("PRIVATE-parser-input");
    expect(f.transport).not.toHaveBeenCalled();
    expectNoStore(response);
  });
});

describe("evaluation adjudication HTTP response binding", () => {
  it.each(routes)(
    "rejects another repository, evaluation, cell or result in $name",
    async (route) => {
      for (const field of ["repositoryId", "evaluationId", "cellId", "resultId"] as const) {
        const output = structuredClone(route.output);
        output.scope[field] = `foreign-${field}`;
        if (field === "resultId") {
          if (output.schemaVersion === "EvaluationAdjudicationContextV1") {
            for (const item of output.items) {
              item.occurrence.resultId = output.scope.resultId;
              if (item.adjudication) item.adjudication.resultId = output.scope.resultId;
            }
          } else if (output.schemaVersion === "EvaluationAdjudicationChangeV1")
            output.adjudication.resultId = output.scope.resultId;
          else for (const item of output.items) item.adjudication.resultId = output.scope.resultId;
        }
        expect(responseIssues(output)).toEqual([]);
        const f = fixture(output);
        const response = await f.app.inject(routeRequest(route));
        expect(response.statusCode, `${route.name}: ${field}`).toBe(502);
        expect(response.json().code).toBe("evaluation_response_invalid");
        expect(response.body).not.toContain(`foreign-${field}`);
        expect(f.request).toHaveBeenCalledOnce();
        expectNoStore(response);
      }
    },
  );

  it.each(routes.filter((route) => route.name !== "context"))(
    "rejects a valid $name DTO for another occurrence",
    async (route) => {
      const output = structuredClone(route.output);
      output.scope.occurrenceKey = occurrence(1).key;
      if (output.schemaVersion === "EvaluationAdjudicationChangeV1")
        output.adjudication.occurrenceKey = output.scope.occurrenceKey;
      else
        for (const item of output.items)
          item.adjudication.occurrenceKey = output.scope.occurrenceKey;
      expect(responseIssues(output)).toEqual([]);
      const f = fixture(output);
      const response = await f.app.inject(routeRequest(route));
      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe("evaluation_response_invalid");
    },
  );

  it.each([
    {
      name: "a different previous version",
      mutate: (value: C.EvaluationAdjudicationChangeV1) => {
        value.previousVersion = 2;
        value.version = 3;
      },
    },
    {
      name: "a broken version increment",
      mutate: (value: C.EvaluationAdjudicationChangeV1) => {
        value.version = 3;
      },
    },
    {
      name: "another issuer",
      mutate: (value: C.EvaluationAdjudicationChangeV1) => {
        value.adjudication.actor.issuer = "https://foreign.example.test";
      },
    },
    {
      name: "another subject",
      mutate: (value: C.EvaluationAdjudicationChangeV1) => {
        value.adjudication.actor.subject = "foreign-operator";
      },
    },
    {
      name: "another result digest",
      mutate: (value: C.EvaluationAdjudicationChangeV1) => {
        value.adjudication.resultDigest = "b".repeat(64);
      },
    },
    {
      name: "another judgment kind",
      mutate: (value: C.EvaluationAdjudicationChangeV1) => {
        value.adjudication = { ...value.adjudication, kind: "unjudged" };
      },
    },
    {
      name: "another human reason",
      mutate: (value: C.EvaluationAdjudicationChangeV1) => {
        value.adjudication.reason = "PRIVATE replacement reason";
      },
    },
  ])("rejects a mutation receipt with $name", async ({ mutate }) => {
    const output = change();
    mutate(output);
    const f = fixture(output);
    const response = await f.app.inject({
      method: "PUT",
      url: changePath,
      headers: headers(),
      payload: request(),
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("evaluation_response_invalid");
    expect(response.body).not.toContain("PRIVATE");
    expect(f.transport).toHaveBeenCalledOnce();
    expectNoStore(response);
  });

  it("binds match and duplicate targets to the exact requested identities", async () => {
    for (const judgment of judgments.filter(
      (entry) => entry.kind === "match" || entry.kind === "duplicate",
    )) {
      const body = request(judgment);
      const output = change(body);
      if (output.adjudication.kind === "match")
        output.adjudication.expectedFindingId = "foreign-expected-finding";
      else if (output.adjudication.kind === "duplicate")
        output.adjudication.primaryOccurrenceKey = occurrence(2).key;
      const f = fixture(output);
      const response = await f.app.inject({
        method: "PUT",
        url: changePath,
        headers: headers(),
        payload: body,
      });
      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe("evaluation_response_invalid");
    }
  });

  it("rejects internally inconsistent context occurrences and current judgments", async () => {
    const mutations: ((value: C.EvaluationAdjudicationContextV1) => void)[] = [
      (value) => {
        required(value.items[0]).occurrence.resultDigest = "b".repeat(64);
      },
      (value) => {
        required(value.items[0]).version = 0;
      },
      (value) => {
        required(value.items[0]).adjudication = null;
      },
      (value) => {
        required(required(value.items[0]).adjudication).caseId = "foreign-case";
      },
      (value) => {
        required(required(value.items[0]).adjudication).arm = "candidate";
      },
      (value) => {
        required(required(value.items[0]).adjudication).occurrenceKey = occurrence(1).key;
      },
      (value) => {
        value.items.push(structuredClone(required(value.items[0])));
      },
    ];
    for (const mutate of mutations) {
      const output = context();
      mutate(output);
      const f = fixture(output);
      const response = await f.app.inject({ method: "GET", url: contextPath, headers: headers() });
      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe("evaluation_response_invalid");
    }
  });

  it("rejects invalid or incomplete history chains and cross-result records", async () => {
    const mutations: ((value: C.EvaluationAdjudicationHistoryV1) => void)[] = [
      (value) => {
        required(value.items[0]).previousEventId = "unrelated-event";
      },
      (value) => {
        required(value.items[1]).previousEventId = "impossible-predecessor";
      },
      (value) => {
        required(value.items[0]).version = 1;
      },
      (value) => {
        required(value.items[0]).adjudication.adjudicationId = "event-1";
      },
      (value) => {
        required(value.items[0]).adjudication.resultDigest = "b".repeat(64);
      },
      (value) => {
        required(value.items[0]).adjudication.resultId = "foreign-result";
      },
      (value) => {
        required(value.items[0]).adjudication.caseId = "foreign-case";
      },
      (value) => {
        value.items.pop();
      },
      (value) => {
        value.items.reverse();
      },
    ];
    for (const mutate of mutations) {
      const output = history();
      mutate(output);
      const f = fixture(output);
      const response = await f.app.inject({ method: "GET", url: historyPath, headers: headers() });
      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe("evaluation_response_invalid");
    }
  });

  it.each([history(2, 20), history(1, 1)])(
    "rejects a valid history response for a different requested page: %j",
    async (output) => {
      expect(C.getEvaluationAdjudicationHistoryIssues(output)).toEqual([]);
      const f = fixture(output);
      const response = await f.app.inject({ method: "GET", url: historyPath, headers: headers() });
      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe("evaluation_response_invalid");
    },
  );

  it.each(routes)(
    "rejects malformed and extra-field $name responses without leaking them",
    async (route) => {
      for (const output of [
        null,
        {},
        { ...route.output, privateOwnerField: "PRIVATE owner detail" },
        { ...route.output, schemaVersion: "unsupported-version" },
      ]) {
        const f = fixture(output);
        const response = await f.app.inject(routeRequest(route));
        expect(response.statusCode).toBe(502);
        expect(response.json().code).toBe("evaluation_response_invalid");
        expect(response.body).not.toContain("PRIVATE");
        expect(f.request).toHaveBeenCalledOnce();
      }
    },
  );
});

describe("evaluation adjudication HTTP failures and method boundaries", () => {
  it.each(routes)("redacts owner errors and never retries $name", async (route) => {
    for (const [code, status] of [
      ["PLATFORM_INVALID", 400],
      ["PLATFORM_FORBIDDEN", 403],
      ["PLATFORM_NOT_FOUND", 404],
      ["PLATFORM_CONFLICT", 409],
      ["DATABASE_READ_ONLY", 503],
    ] as const) {
      const f = fixture(route.output, {
        error: new DatabaseRequestError("PRIVATE owner details, SQL and another principal", code),
      });
      const response = await f.app.inject(routeRequest(route));
      expect(response.statusCode, code).toBe(status);
      expect(response.json()).toMatchObject({
        code: code === "DATABASE_READ_ONLY" ? "configuration_read_only" : code.toLowerCase(),
        retryable: false,
      });
      expect(response.body).not.toContain("PRIVATE");
      expect(f.request).toHaveBeenCalledOnce();
      expect(f.transport).toHaveBeenCalledOnce();
      expectNoStore(response);
    }
  });

  it.each(routes)("redacts unexpected failures on $name", async (route) => {
    for (const error of [
      new Error("PRIVATE internal details"),
      new DatabaseRequestError("PRIVATE transport details", "INTERNAL"),
    ]) {
      const f = fixture(route.output, { error });
      const response = await f.app.inject(routeRequest(route));
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        code: "configuration_operation_failed",
        retryable: false,
      });
      expect(response.body).not.toContain("PRIVATE");
      expect(f.request).toHaveBeenCalledOnce();
      expectNoStore(response);
    }
  });

  it("does not expose unsupported methods or owner operation names", async () => {
    const f = fixture(null);
    for (const route of routes) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
        if (method === route.method) continue;
        const response = await f.app.inject({
          method,
          url: route.path,
          headers: headers(),
          payload: {},
        });
        expect(response.statusCode, `${method} ${route.path}`).toBe(404);
      }
    }
    for (const operation of [
      "changeEvaluationAdjudication",
      "getEvaluationAdjudicationContext",
      "listEvaluationAdjudicationHistory",
      "replay",
    ]) {
      const response = await f.app.inject({
        method: "POST",
        url: `${contextPath}/${operation}`,
        headers: headers(),
        payload: request(),
      });
      expect(response.statusCode).toBe(404);
    }
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("applies the shared mutation limit to receipt replays in recovery", async () => {
    const f = fixture(change(), { readOnly: true, rateLimits: true });
    const mutation = {
      method: "PUT",
      url: changePath,
      headers: headers(),
      payload: request(),
    } as const;
    const limit = operatorConfigurationRateLimits.mutationsPerPrincipalPerMinute;
    for (let index = 0; index < limit; index += 1)
      expect((await f.app.inject(mutation)).statusCode).toBe(200);
    const response = await f.app.inject(mutation);
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: "request_rate_limited", retryable: true });
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expect(f.request).toHaveBeenCalledTimes(limit);
    expectNoStore(response);
  });
});
