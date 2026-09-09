import type {
  ReviewRunDecisionChangeRequest,
  ReviewRunDecisionChangeResponse,
  ReviewRunDecisionContext,
  ReviewRunDecisionEvent,
  ReviewRunDecisionHistoryResponse,
} from "@agentic-review/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseRequestError } from "../database/errors.js";
import type { OperatorSession } from "../security/operator-auth.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";
import { registerReviewRunDecisionRoutes } from "./review-run-decisions.js";

const publicOrigin = "https://review.example.com";
const token = "S".repeat(43);
const timestamp = "2026-09-07T12:00:00.000Z";
const actor = { issuer: "https://identity.example.com", subject: "repository-reviewer" };
const scope = { repositoryId: "repository-1", reviewRunId: "run-1" };
const contextPath = `/api/v1/operator/repositories/${scope.repositoryId}/review-runs/${scope.reviewRunId}/decisions`;
const historyPath = `${contextPath}/history`;
const binding = {
  revisionKey: "a".repeat(64),
  planDigest: "b".repeat(64),
  resultSetDigest: "c".repeat(64),
};
const policy = {
  policyVersion: "required-checks-and-p0-p1-v1",
  applicable: true,
  eligible: true,
  blockingFindingCount: 0,
  reasons: [],
  reasonCount: 0,
  reasonsTruncated: false,
} as const;
const event = {
  ...scope,
  ...binding,
  workItemId: "work-item-1",
  workItemKind: "pull_request",
  id: "decision-1",
  changeId: "change-1",
  actor,
  previousVersion: 0,
  version: 1,
  createdAt: timestamp,
  action: "approve",
  reason: "Review the validated revision.",
  supersedesDecisionId: null,
  targetDecisionId: null,
  policyAtDecision: {
    policyVersion: policy.policyVersion,
    applicable: true,
    eligible: true,
    blockingFindingCount: 0,
    reasonCount: 0,
    reasonCodes: [],
    reasonCodesTruncated: false,
  },
} satisfies ReviewRunDecisionEvent;
const change = {
  changeId: event.changeId,
  expectedVersion: 0,
  expectedRevisionKey: binding.revisionKey,
  expectedPlanDigest: binding.planDigest,
  expectedResultSetDigest: binding.resultSetDigest,
  action: "approve",
  reason: event.reason,
} satisfies ReviewRunDecisionChangeRequest;
const receipt = { change: event, replayed: false } satisfies ReviewRunDecisionChangeResponse;
const context = {
  ...scope,
  ...binding,
  workItemId: event.workItemId,
  workItemKind: "pull_request",
  currentRevisionKey: binding.revisionKey,
  version: 1,
  sourceCurrent: true,
  policy: { ...policy, reasons: [] },
  recordedDecision: event,
  recordedDecisionState: "current",
  stateReasons: [],
  canApprove: true,
} satisfies ReviewRunDecisionContext;
const history = {
  ...scope,
  page: 1,
  pageSize: 20,
  total: 1,
  items: [event],
} satisfies ReviewRunDecisionHistoryResponse;
const routes = [
  {
    name: "context",
    method: "GET",
    url: contextPath,
    operation: "getReviewRunDecisionContext",
    input: { ...scope, actor },
    result: context,
    status: 200,
  },
  {
    name: "history",
    method: "GET",
    url: historyPath,
    operation: "listReviewRunDecisionHistory",
    input: { ...scope, actor, page: 1, pageSize: 20 },
    result: history,
    status: 200,
  },
  {
    name: "change",
    method: "POST",
    url: contextPath,
    operation: "changeReviewRunDecision",
    input: { ...scope, actor, ...change },
    result: receipt,
    status: 201,
  },
] as const;
const applications: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
});
const headers = () => ({ cookie: `${OPERATOR_SESSION_COOKIE}=${token}`, origin: publicOrigin });
function expectNoStore(response: { headers: Record<string, unknown> }): void {
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers.vary).toBe("Cookie");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
}
function fixture(
  output: unknown = context,
  options: {
    readOnly?: boolean;
    validSession?: boolean;
    failure?: Error;
    sessionFailure?: Error;
  } = {},
) {
  const session: OperatorSession = {
    ...actor,
    displayName: "Operator",
    email: "operator@example.com",
    createdAt: timestamp,
    expiresAt: "2026-09-07T13:00:00.000Z",
  };
  const auth: OperatorAuthRouteService = {
    publicOrigin,
    postLoginRedirectPath: "/",
    requiresLoopbackRequest: false,
    secureCookies: true,
    usesBrowserBinding: false,
    ensureBrowserBinding: vi.fn(() => undefined),
    startLogin: vi.fn(async () => ({ kind: "session" as const, sessionToken: token, session })),
    completeLogin: vi.fn(async () => {
      throw new Error("Decision route tests do not use an external identity provider.");
    }),
    getSession: vi.fn(async (sessionToken) => {
      if (options.sessionFailure) throw options.sessionFailure;
      return sessionToken === token && options.validSession !== false ? session : null;
    }),
    logout: vi.fn(async () => undefined),
  };
  const database = createOperatorRouteTestDatabase(actor, async () => {
    if (options.failure !== undefined) {
      await Promise.resolve();
      throw options.failure;
    }
    return output;
  });
  const app = Fastify({ logger: false });
  applications.push(app);
  registerOperatorAuthRoutes(app, auth);
  registerReviewRunDecisionRoutes(app, {
    database: database.database,
    operatorAuth: auth,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  return { app, auth, ...database };
}

describe("review run decision authorization and requests", () => {
  it.each(routes)("uses the session actor and scoped RPC for $name", async (route) => {
    const f = fixture(route.result);
    const response = await f.app.inject({
      method: route.method,
      url: route.url,
      ...(route.method === "POST" ? { payload: change } : {}),
      headers: { ...headers(), "x-operator-subject": "forged-subject" },
    });
    expect(response.statusCode).toBe(route.status);
    expect(response.json()).toEqual(route.result);
    expectNoStore(response);
    expect(f.request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
    expect(f.transport).toHaveBeenCalledExactlyOnceWith("operatorRequest", {
      context: { kind: "operator", actor },
      operation: route.operation,
      input: route.input,
    });
    expect(f.permissions).not.toHaveBeenCalled();
  });
  it.each(routes)("rejects missing sessions before the $name RPC", async (route) => {
    const f = fixture(route.result);
    const response = await f.app.inject({
      method: route.method,
      url: route.url,
      ...(route.method === "POST" ? { payload: change } : {}),
      headers: { origin: publicOrigin },
    });
    expect(response.statusCode).toBe(401);
    expectNoStore(response);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(routes)("rejects expired sessions before the $name RPC", async (route) => {
    const f = fixture(route.result, { validSession: false });
    const response = await f.app.inject({
      method: route.method,
      url: route.url,
      ...(route.method === "POST" ? { payload: change } : {}),
      headers: headers(),
    });
    expect(response.statusCode).toBe(401);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(routes)(
    "maps session lookup failures without leaking details for $name",
    async (route) => {
      const f = fixture(route.result, { sessionFailure: new Error("private-session-secret") });
      const response = await f.app.inject({
        method: route.method,
        url: route.url,
        ...(route.method === "POST" ? { payload: change } : {}),
        headers: headers(),
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("private-session-secret");
      expectNoStore(response);
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it.each([
    undefined,
    "null",
    "https://evil.example",
    `${publicOrigin}/`,
    `${publicOrigin}, ${publicOrigin}`,
  ])("rejects invalid mutation Origin %s before database access", async (origin) => {
    const f = fixture(receipt);
    const response = await f.app.inject({
      method: "POST",
      url: contextPath,
      payload: change,
      headers: {
        cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
        ...(origin === undefined ? {} : { origin }),
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("invalid_operator_auth_origin");
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("rejects duplicate mutation Origin headers", async () => {
    const f = fixture(receipt);
    const response = await f.app.inject({
      method: "POST",
      url: contextPath,
      payload: change,
      headers: {
        cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
        Origin: [publicOrigin, publicOrigin],
      },
    });
    expect(response.statusCode).toBe(403);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(routes)("keeps $name reads and blocks mutations during recovery", async (route) => {
    const f = fixture(route.result, { readOnly: true });
    const response = await f.app.inject({
      method: route.method,
      url: route.url,
      ...(route.method === "POST" ? { payload: change } : {}),
      headers: headers(),
    });
    expect(response.statusCode).toBe(route.method === "POST" ? 503 : 200);
    expect(f.transport).toHaveBeenCalledTimes(route.method === "POST" ? 0 : 1);
  });
  it.each(routes)("rejects unknown query fields before $name", async (route) => {
    const f = fixture(route.result);
    const response = await f.app.inject({
      method: route.method,
      url: `${route.url}?actor=forged`,
      ...(route.method === "POST" ? { payload: change } : {}),
      headers: headers(),
    });
    expect(response.statusCode).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each([
    "page=0",
    "page=-1",
    "page=1.5",
    "page=01",
    "page=9007199254740992",
    "page=9007199254740991&pageSize=20",
    "pageSize=0",
    "pageSize=21",
    "pageSize=50",
    "pageSize=51",
    "page=1&page=1",
    "pageSize=1&pageSize=1",
  ])("rejects invalid or duplicate history pagination %s", async (query) => {
    const f = fixture(history);
    const response = await f.app.inject({
      method: "GET",
      url: `${historyPath}?${query}`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(["repositoryId", "reviewRunId"])("rejects malformed %s", async (parameter) => {
    const f = fixture(context);
    const path = contextPath.replace(
      parameter === "repositoryId" ? scope.repositoryId : scope.reviewRunId,
      "%20invalid",
    );
    const response = await f.app.inject({ method: "GET", url: path, headers: headers() });
    expect(response.statusCode).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each([
    ["forged actor", { ...change, actor: { ...actor, subject: "forged" } }],
    ["policy injection", { ...change, policy: policy }],
    ["scope injection", { ...change, repositoryId: "other-repository" }],
    ["missing binding", { ...change, expectedResultSetDigest: undefined }],
    ["invalid digest", { ...change, expectedRevisionKey: "A".repeat(64) }],
    ["unknown action", { ...change, action: "merge" }],
    ["withdraw without target", { ...change, action: "withdraw" }],
    ["nonwithdraw target", { ...change, targetDecisionId: "previous" }],
    ["empty reason", { ...change, reason: "" }],
    ["blank reason", { ...change, reason: "   " }],
    ["oversized reason", { ...change, reason: "r".repeat(2_049) }],
    ["unsafe version", { ...change, expectedVersion: Number.MAX_SAFE_INTEGER }],
    ["negative version", { ...change, expectedVersion: -1 }],
  ])("rejects %s before the mutation RPC", async (_name, payload) => {
    const f = fixture(receipt);
    const response = await f.app.inject({
      method: "POST",
      url: contextPath,
      headers: headers(),
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("enforces the 16 KiB raw request bound before parsing", async () => {
    const f = fixture(receipt);
    const response = await f.app.inject({
      method: "POST",
      url: contextPath,
      headers: { ...headers(), "content-type": "application/json" },
      payload: `${" ".repeat(16_384)}${JSON.stringify(change)}`,
    });
    expect(response.statusCode).toBe(413);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each([
    ["PLATFORM_FORBIDDEN", 403],
    ["PLATFORM_NOT_FOUND", 404],
    ["PLATFORM_CONFLICT", 409],
    ["PLATFORM_INVALID", 400],
  ] as const)("maps database %s without fabricating a receipt", async (code, status) => {
    const f = fixture(receipt, {
      failure: new DatabaseRequestError("Internal operation details.", code),
    });
    const response = await f.app.inject({
      method: "POST",
      url: contextPath,
      headers: headers(),
      payload: change,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code.toLowerCase());
    expect(response.json()).not.toHaveProperty("change");
    if (code === "PLATFORM_FORBIDDEN" || code === "PLATFORM_NOT_FOUND")
      expect(response.body).not.toContain("Internal operation details.");
  });
});

describe("review run decision context response integrity", () => {
  it.each([
    [
      "no decisions",
      { ...context, version: 0, recordedDecision: null, recordedDecisionState: "none" },
    ],
    [
      "only comments",
      { ...context, version: 2, recordedDecision: null, recordedDecisionState: "none" },
    ],
    ["later comment", { ...context, version: 2 }],
    [
      "changed result set",
      {
        ...context,
        resultSetDigest: "d".repeat(64),
        recordedDecisionState: "stale",
        stateReasons: ["result_set_changed"],
      },
    ],
    [
      "source changed",
      {
        ...context,
        currentRevisionKey: "e".repeat(64),
        sourceCurrent: false,
        canApprove: false,
        recordedDecisionState: "stale",
        stateReasons: ["source_not_current"],
      },
    ],
    [
      "A to B to A source",
      {
        ...context,
        sourceCurrent: false,
        canApprove: false,
        recordedDecisionState: "stale",
        stateReasons: ["source_not_current"],
      },
    ],
    [
      "withdrawal remains withdrawn",
      {
        ...context,
        sourceCurrent: false,
        canApprove: false,
        version: 2,
        resultSetDigest: "d".repeat(64),
        recordedDecision: {
          ...event,
          id: "decision-2",
          changeId: "change-2",
          action: "withdraw",
          version: 2,
          previousVersion: 1,
          targetDecisionId: event.id,
          supersedesDecisionId: event.id,
        },
        recordedDecisionState: "withdrawn",
      },
    ],
  ])("accepts coherent %s", async (_name, output) => {
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: contextPath, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
  });
  const failedPolicy = {
    ...policy,
    eligible: false,
    blockingFindingCount: 1,
    reasonCount: 1,
    reasons: [{ code: "blocking_findings" }],
  };
  it.each([
    [
      "approval became ineligible",
      {
        ...context,
        policy: failedPolicy,
        canApprove: false,
        recordedDecisionState: "ineligible",
        stateReasons: ["approval_policy_not_satisfied"],
      },
    ],
    [
      "stale and ineligible",
      {
        ...context,
        policy: failedPolicy,
        canApprove: false,
        sourceCurrent: false,
        resultSetDigest: "d".repeat(64),
        recordedDecisionState: "stale",
        stateReasons: ["result_set_changed", "source_not_current", "approval_policy_not_satisfied"],
      },
    ],
    [
      "explicit override",
      {
        ...context,
        policy: failedPolicy,
        canApprove: false,
        recordedDecision: {
          ...event,
          action: "override_approve",
          policyAtDecision: {
            ...event.policyAtDecision,
            eligible: false,
            blockingFindingCount: 1,
            reasonCount: 1,
            reasonCodes: ["blocking_findings"],
          },
        },
      },
    ],
    [
      "request changes",
      {
        ...context,
        policy: failedPolicy,
        canApprove: false,
        recordedDecision: { ...event, action: "request_changes" },
      },
    ],
    [
      "Issue request changes",
      {
        ...context,
        workItemKind: "issue",
        canApprove: false,
        policy: { ...policy, applicable: false, eligible: null },
        recordedDecision: {
          ...event,
          workItemKind: "issue",
          action: "request_changes",
          policyAtDecision: { ...event.policyAtDecision, applicable: false, eligible: null },
        },
      },
    ],
  ])("accepts coherent %s without overwriting policy facts", async (_name, output) => {
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: contextPath, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
  });
  it.each([
    ["foreign repository", { ...context, repositoryId: "other-repository" }],
    ["foreign run", { ...context, reviewRunId: "other-run" }],
    [
      "foreign event repository",
      { ...context, recordedDecision: { ...event, repositoryId: "other-repository" } },
    ],
    [
      "foreign event work item",
      { ...context, recordedDecision: { ...event, workItemId: "other-work-item" } },
    ],
    [
      "foreign event revision",
      { ...context, recordedDecision: { ...event, revisionKey: "d".repeat(64) } },
    ],
    [
      "foreign event plan",
      { ...context, recordedDecision: { ...event, planDigest: "d".repeat(64) } },
    ],
    ["future event version", { ...context, version: 0 }],
    ["broken event version", { ...context, recordedDecision: { ...event, previousVersion: 1 } }],
    [
      "comment as recorded decision",
      { ...context, recordedDecision: { ...event, action: "comment" } },
    ],
    ["null current decision", { ...context, recordedDecision: null }],
    ["event with none state", { ...context, recordedDecisionState: "none" }],
    ["mismatched current revision", { ...context, currentRevisionKey: "d".repeat(64) }],
    ["false canApprove", { ...context, canApprove: false }],
    ["approve despite failed policy", { ...context, policy: failedPolicy }],
    ["unexplained current state reason", { ...context, stateReasons: ["result_set_changed"] }],
    [
      "missing stale reason",
      { ...context, resultSetDigest: "d".repeat(64), recordedDecisionState: "stale" },
    ],
    [
      "missing ineligible reason",
      { ...context, policy: failedPolicy, canApprove: false, recordedDecisionState: "ineligible" },
    ],
    [
      "ineligible override",
      {
        ...context,
        policy: failedPolicy,
        canApprove: false,
        recordedDecision: { ...event, action: "override_approve" },
        recordedDecisionState: "ineligible",
        stateReasons: ["approval_policy_not_satisfied"],
      },
    ],
    ["withdraw state without withdrawal", { ...context, recordedDecisionState: "withdrawn" }],
    [
      "untruncated policy count mismatch",
      { ...context, policy: { ...policy, eligible: false, reasonCount: 1 }, canApprove: false },
    ],
    [
      "truncated policy missing preview",
      {
        ...context,
        policy: { ...policy, eligible: false, reasonCount: 129, reasonsTruncated: true },
        canApprove: false,
      },
    ],
    ["eligible blocking findings", { ...context, policy: { ...policy, blockingFindingCount: 1 } }],
    [
      "Issue approve",
      {
        ...context,
        workItemKind: "issue",
        policy: { ...policy, applicable: false, eligible: null },
        canApprove: false,
      },
    ],
    [
      "Issue canApprove",
      {
        ...context,
        workItemKind: "issue",
        policy: { ...policy, applicable: false, eligible: null },
        recordedDecision: null,
        recordedDecisionState: "none",
      },
    ],
    ["unknown field", { ...context, secret: "must-not-return" }],
  ])("rejects a schema or relationally inconsistent %s", async (_name, output) => {
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: contextPath, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("must-not-return");
    expect(response.json()).not.toHaveProperty("recordedDecision");
    expectNoStore(response);
  });
});

describe("review run decision history response integrity", () => {
  it("accepts a bounded descending page including comments with distinct result bindings", async () => {
    const second = {
      ...event,
      id: "decision-2",
      changeId: "change-2",
      version: 2,
      previousVersion: 1,
      action: "comment",
      resultSetDigest: "d".repeat(64),
    };
    const output = { ...history, page: 2, pageSize: 2, total: 4, items: [second, event] };
    const f = fixture(output);
    const response = await f.app.inject({
      method: "GET",
      url: `${historyPath}?page=2&pageSize=2`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("listReviewRunDecisionHistory", {
      ...scope,
      actor,
      page: 2,
      pageSize: 2,
    });
  });
  it("accepts an empty page beyond the last event", async () => {
    const output = { ...history, page: 3, items: [] };
    const f = fixture(output);
    const response = await f.app.inject({
      method: "GET",
      url: `${historyPath}?page=3`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
  });
  const secondEvent = {
    ...event,
    id: "decision-2",
    changeId: "change-2",
    version: 2,
    previousVersion: 1,
    supersedesDecisionId: event.id,
  };
  const two = { ...history, total: 2, items: [secondEvent, event] };
  it.each([
    ["foreign top repository", { ...history, repositoryId: "other" }],
    ["foreign top run", { ...history, reviewRunId: "other" }],
    ["foreign event repository", { ...history, items: [{ ...event, repositoryId: "other" }] }],
    ["foreign event run", { ...history, items: [{ ...event, reviewRunId: "other" }] }],
    ["wrong page", { ...history, page: 2 }],
    ["wrong page size", { ...history, pageSize: 1 }],
    ["missing event", { ...history, items: [] }],
    ["total below returned rows", { ...history, total: 0 }],
    [
      "noncontiguous versions",
      { ...history, items: [{ ...event, previousVersion: 1, version: 2 }] },
    ],
    ["ascending versions", { ...two, items: [event, secondEvent] }],
    [
      "duplicate event ID",
      { ...two, items: [{ ...secondEvent, id: event.id, supersedesDecisionId: null }, event] },
    ],
    [
      "duplicate change ID",
      { ...two, items: [{ ...secondEvent, changeId: event.changeId }, event] },
    ],
    [
      "foreign second work item",
      { ...two, items: [secondEvent, { ...event, workItemId: "other" }] },
    ],
    [
      "foreign second revision",
      { ...two, items: [secondEvent, { ...event, revisionKey: "d".repeat(64) }] },
    ],
    [
      "foreign second plan",
      { ...two, items: [secondEvent, { ...event, planDigest: "d".repeat(64) }] },
    ],
    [
      "mixed Issue and PR",
      {
        ...two,
        items: [
          secondEvent,
          {
            ...event,
            action: "comment",
            workItemKind: "issue",
            policyAtDecision: { ...event.policyAtDecision, applicable: false, eligible: null },
          },
        ],
      },
    ],
  ])("rejects %s without returning history contents", async (_name, output) => {
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: historyPath, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.json()).not.toHaveProperty("items");
  });
  it("rejects more items than the requested smaller page", async () => {
    const f = fixture({ ...two, pageSize: 1 });
    const response = await f.app.inject({
      method: "GET",
      url: `${historyPath}?pageSize=1`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(502);
  });
  it("enforces the 1 MiB encoded UTF-8 response bound", async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      ...event,
      id: `decision-${20 - index}`,
      changeId: `change-${20 - index}`,
      previousVersion: 19 - index,
      version: 20 - index,
      reason: "\u754c".repeat(2_048),
      policyAtDecision: {
        ...event.policyAtDecision,
        reasonCount: 128,
        reasonCodes: Array.from({ length: 128 }, (_, codeIndex) =>
          `${codeIndex}`.padEnd(128, "\u754c"),
        ),
        eligible: false,
      },
      action: "override_approve",
    }));
    const output = { ...history, total: 20, items };
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeGreaterThan(1_024 * 1_024);
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThan(2 * 1_024 * 1_024);
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: historyPath, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("review_run_decision_response_invalid");
    expect(response.json()).not.toHaveProperty("items");
  });
});

describe("review run decision immutable receipts", () => {
  it.each([false, true])(
    "returns an accepted original receipt with replayed=%s",
    async (replayed) => {
      const output = { ...receipt, replayed };
      const f = fixture(output);
      const response = await f.app.inject({
        method: "POST",
        url: contextPath,
        headers: headers(),
        payload: change,
      });
      expect(response.statusCode).toBe(replayed ? 200 : 201);
      expect(response.json()).toEqual(output);
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("accepts the canonical trimmed reason without changing the request intent", async () => {
    const f = fixture(receipt);
    const payload = { ...change, reason: `  ${change.reason}  ` };
    const response = await f.app.inject({
      method: "POST",
      url: contextPath,
      headers: headers(),
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(receipt);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("changeReviewRunDecision", {
      ...scope,
      actor,
      ...payload,
    });
  });
  it("returns the original withdrawal receipt with its exact target", async () => {
    const payload = {
      ...change,
      changeId: "withdraw-1",
      expectedVersion: 1,
      action: "withdraw",
      targetDecisionId: event.id,
    };
    const output = {
      replayed: false,
      change: {
        ...event,
        id: "withdrawal-1",
        changeId: payload.changeId,
        previousVersion: 1,
        version: 2,
        action: "withdraw",
        targetDecisionId: event.id,
        supersedesDecisionId: event.id,
      },
    };
    const f = fixture(output);
    const response = await f.app.inject({
      method: "POST",
      url: contextPath,
      headers: headers(),
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(output);
  });
  it("allows duplicate policy reason codes to be represented by one compact code", async () => {
    const payload = { ...change, action: "override_approve" };
    const output = {
      ...receipt,
      change: {
        ...event,
        action: "override_approve",
        policyAtDecision: {
          ...event.policyAtDecision,
          eligible: false,
          reasonCount: 2,
          reasonCodes: ["check_failed"],
        },
      },
    };
    const f = fixture(output);
    const response = await f.app.inject({
      method: "POST",
      url: contextPath,
      headers: headers(),
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(output);
  });
  it("preserves the first 128 distinct compact codes when more reasons are recorded", async () => {
    const payload = { ...change, action: "override_approve" };
    const output = {
      ...receipt,
      change: {
        ...event,
        action: "override_approve",
        policyAtDecision: {
          ...event.policyAtDecision,
          eligible: false,
          reasonCount: 129,
          reasonCodes: Array.from({ length: 128 }, (_, index) => `check_failed_${index}`),
          reasonCodesTruncated: true,
        },
      },
    };
    const f = fixture(output);
    const response = await f.app.inject({
      method: "POST",
      url: contextPath,
      headers: headers(),
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(output);
  });
  it.each([
    ["repository", { ...event, repositoryId: "other" }],
    ["run", { ...event, reviewRunId: "other" }],
    ["actor issuer", { ...event, actor: { ...actor, issuer: `${actor.issuer}/` } }],
    ["actor subject", { ...event, actor: { ...actor, subject: actor.subject.toUpperCase() } }],
    ["change ID", { ...event, changeId: "other" }],
    ["action", { ...event, action: "request_changes" }],
    ["reason", { ...event, reason: "Different decision." }],
    ["revision", { ...event, revisionKey: "d".repeat(64) }],
    ["plan", { ...event, planDigest: "d".repeat(64) }],
    ["result digest", { ...event, resultSetDigest: "d".repeat(64) }],
    ["version", { ...event, previousVersion: 1, version: 2 }],
    ["version chain", { ...event, previousVersion: 1 }],
    ["self supersession", { ...event, supersedesDecisionId: event.id }],
    ["first event supersession", { ...event, supersedesDecisionId: "nonexistent-previous" }],
    [
      "failed ordinary approval",
      {
        ...event,
        policyAtDecision: {
          ...event.policyAtDecision,
          eligible: false,
          reasonCount: 1,
          reasonCodes: ["check_failed"],
        },
      },
    ],
    [
      "false compact count",
      { ...event, policyAtDecision: { ...event.policyAtDecision, reasonCodes: ["check_failed"] } },
    ],
    [
      "false compact truncation",
      { ...event, policyAtDecision: { ...event.policyAtDecision, reasonCodesTruncated: true } },
    ],
    [
      "eligible blocking policy",
      { ...event, policyAtDecision: { ...event.policyAtDecision, blockingFindingCount: 1 } },
    ],
    ["unexpected target", { ...event, targetDecisionId: "other" }],
  ])("rejects mismatched %s even in an idempotent receipt", async (_name, modifiedEvent) => {
    const f = fixture({ change: modifiedEvent, replayed: true });
    const response = await f.app.inject({
      method: "POST",
      url: contextPath,
      headers: headers(),
      payload: change,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).not.toHaveProperty("change");
  });
  it.each([
    ["wrong withdrawal target", { targetDecisionId: "other", supersedesDecisionId: "other" }],
    ["different superseded event", { targetDecisionId: event.id, supersedesDecisionId: "other" }],
    ["self target", { targetDecisionId: "withdrawal-1", supersedesDecisionId: "withdrawal-1" }],
  ])("rejects %s", async (_name, relationship) => {
    const payload = {
      ...change,
      changeId: "withdraw-1",
      expectedVersion: 1,
      action: "withdraw",
      targetDecisionId: event.id,
    };
    const f = fixture({
      replayed: true,
      change: {
        ...event,
        id: "withdrawal-1",
        changeId: payload.changeId,
        previousVersion: 1,
        version: 2,
        action: "withdraw",
        ...relationship,
      },
    });
    const response = await f.app.inject({
      method: "POST",
      url: contextPath,
      headers: headers(),
      payload,
    });
    expect(response.statusCode).toBe(502);
  });
  it("rejects comment receipts that supersede a prior decision", async () => {
    const payload = { ...change, action: "comment" };
    const f = fixture({
      replayed: false,
      change: { ...event, action: "comment", supersedesDecisionId: "previous" },
    });
    const response = await f.app.inject({
      method: "POST",
      url: contextPath,
      headers: headers(),
      payload,
    });
    expect(response.statusCode).toBe(502);
  });
});

describe("versioned finding disposition approval policies", () => {
  const dispositionDigest = "f".repeat(64);
  const policyV2 = {
    ...policy,
    policyVersion: "required-checks-and-unresolved-p0-p1-v2",
    blockingFindingCount: 3,
    unresolvedBlockingFindingCount: 0,
    findingDispositionDigest: dispositionDigest,
    reasons: [],
  } satisfies ReviewRunDecisionContext["policy"];
  const eventV2 = {
    ...event,
    policyAtDecision: {
      ...event.policyAtDecision,
      policyVersion: "required-checks-and-unresolved-p0-p1-v2",
      blockingFindingCount: 3,
      unresolvedBlockingFindingCount: 0,
      findingDispositionDigest: dispositionDigest,
    },
  } satisfies ReviewRunDecisionEvent;
  const contextV2 = {
    ...context,
    policy: policyV2,
    recordedDecision: eventV2,
  } satisfies ReviewRunDecisionContext;

  it.each([
    ["a recorded approval", contextV2],
    [
      "no recorded decision",
      { ...contextV2, version: 0, recordedDecision: null, recordedDecisionState: "none" },
    ],
    ["a later comment", { ...contextV2, version: 2 }],
  ])("accepts resolved or dismissed raw findings with %s", async (_name, output) => {
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: contextPath, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
    expect(response.json().policy.blockingFindingCount).toBe(3);
    expect(response.json().policy.unresolvedBlockingFindingCount).toBe(0);
  });
  it.each([false, true])("preserves V2 approval receipt with replayed=%s", async (replayed) => {
    const output = { change: eventV2, replayed };
    const f = fixture(output);
    const response = await f.app.inject({
      method: "POST",
      url: contextPath,
      headers: headers(),
      payload: change,
    });
    expect(response.statusCode).toBe(replayed ? 200 : 201);
    expect(response.json()).toEqual(output);
  });
  it("retains V1 and V2 policy snapshots together in descending audit history", async () => {
    const newer = {
      ...eventV2,
      id: "decision-v2",
      changeId: "change-v2",
      previousVersion: 1,
      version: 2,
      supersedesDecisionId: event.id,
      resultSetDigest: "e".repeat(64),
    } satisfies ReviewRunDecisionEvent;
    const output = { ...history, total: 2, items: [newer, event] };
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: historyPath, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
  });
  it.each([
    ["eligible unresolved findings", { ...policyV2, unresolvedBlockingFindingCount: 1 }],
    ["unresolved count above raw count", { ...policyV2, unresolvedBlockingFindingCount: 4 }],
    ["missing disposition digest", { ...policyV2, findingDispositionDigest: undefined }],
    ["invalid disposition digest", { ...policyV2, findingDispositionDigest: "A".repeat(64) }],
    ["missing unresolved count", { ...policyV2, unresolvedBlockingFindingCount: undefined }],
    ["negative unresolved count", { ...policyV2, unresolvedBlockingFindingCount: -1 }],
    ["unexplained reason count", { ...policyV2, reasonCount: 1 }],
    ["false reason truncation", { ...policyV2, reasonsTruncated: true }],
  ])("rejects V2 context %s", async (_name, modifiedPolicy) => {
    const f = fixture({ ...contextV2, policy: modifiedPolicy });
    const response = await f.app.inject({ method: "GET", url: contextPath, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.json()).not.toHaveProperty("policy");
  });
  it.each([
    [
      "eligible unresolved findings",
      { ...eventV2.policyAtDecision, unresolvedBlockingFindingCount: 1 },
    ],
    [
      "unresolved count above raw count",
      { ...eventV2.policyAtDecision, unresolvedBlockingFindingCount: 4 },
    ],
    [
      "missing disposition digest",
      { ...eventV2.policyAtDecision, findingDispositionDigest: undefined },
    ],
    [
      "invalid disposition digest",
      { ...eventV2.policyAtDecision, findingDispositionDigest: "A".repeat(64) },
    ],
    [
      "missing unresolved count",
      { ...eventV2.policyAtDecision, unresolvedBlockingFindingCount: undefined },
    ],
    ["unexplained compact count", { ...eventV2.policyAtDecision, reasonCount: 1 }],
    ["false compact truncation", { ...eventV2.policyAtDecision, reasonCodesTruncated: true }],
  ])("rejects V2 receipt and history %s", async (_name, modifiedPolicy) => {
    const modified = { ...eventV2, policyAtDecision: modifiedPolicy };
    const receiptFixture = fixture({ change: modified, replayed: true });
    const receiptResponse = await receiptFixture.app.inject({
      method: "POST",
      url: contextPath,
      headers: headers(),
      payload: change,
    });
    expect(receiptResponse.statusCode).toBe(502);
    expect(receiptResponse.json()).not.toHaveProperty("change");
    const historyFixture = fixture({ ...history, items: [modified] });
    const historyResponse = await historyFixture.app.inject({
      method: "GET",
      url: historyPath,
      headers: headers(),
    });
    expect(historyResponse.statusCode).toBe(502);
    expect(historyResponse.json()).not.toHaveProperty("items");
  });
  it("checks unresolved counts for ineligible V2 policies as well", async () => {
    const invalidPolicy = {
      ...policyV2,
      eligible: false,
      blockingFindingCount: 0,
      unresolvedBlockingFindingCount: 1,
      reasonCount: 1,
      reasons: [{ code: "blocking_findings" }],
    };
    const contextFixture = fixture({
      ...contextV2,
      policy: invalidPolicy,
      recordedDecision: null,
      recordedDecisionState: "none",
      canApprove: false,
    });
    expect(
      (await contextFixture.app.inject({ method: "GET", url: contextPath, headers: headers() }))
        .statusCode,
    ).toBe(502);
    const historyFixture = fixture({
      ...history,
      items: [
        {
          ...eventV2,
          action: "request_changes",
          policyAtDecision: {
            ...eventV2.policyAtDecision,
            eligible: false,
            blockingFindingCount: 0,
            unresolvedBlockingFindingCount: 1,
            reasonCount: 1,
            reasonCodes: ["blocking_findings"],
          },
        },
      ],
    });
    expect(
      (await historyFixture.app.inject({ method: "GET", url: historyPath, headers: headers() }))
        .statusCode,
    ).toBe(502);
  });
  it("preserves a valid ineligible V2 policy without treating raw findings as resolved", async () => {
    const output = {
      ...contextV2,
      canApprove: false,
      policy: {
        ...policyV2,
        eligible: false,
        unresolvedBlockingFindingCount: 1,
        reasonCount: 1,
        reasons: [{ code: "blocking_findings" }],
      },
      recordedDecision: {
        ...eventV2,
        action: "request_changes",
        policyAtDecision: {
          ...eventV2.policyAtDecision,
          eligible: false,
          unresolvedBlockingFindingCount: 1,
          reasonCount: 1,
          reasonCodes: ["blocking_findings"],
        },
      },
    };
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: contextPath, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
  });
  it("continues rejecting eligible raw blocking findings under V1", async () => {
    const invalidPolicy = { ...policy, blockingFindingCount: 3 };
    const invalidEvent = {
      ...event,
      policyAtDecision: { ...event.policyAtDecision, blockingFindingCount: 3 },
    };
    for (const route of [
      { method: "GET", url: contextPath, output: { ...context, policy: invalidPolicy } },
      { method: "GET", url: historyPath, output: { ...history, items: [invalidEvent] } },
      { method: "POST", url: contextPath, output: { change: invalidEvent, replayed: true } },
    ] as const) {
      const f = fixture(route.output);
      expect(
        (
          await f.app.inject({
            method: route.method,
            url: route.url,
            headers: headers(),
            ...(route.method === "POST" ? { payload: change } : {}),
          })
        ).statusCode,
      ).toBe(502);
    }
  });
  it("returns historical V1 receipts without upgrading their policy snapshot", async () => {
    const output = { change: event, replayed: true };
    const f = fixture(output);
    const response = await f.app.inject({
      method: "POST",
      url: contextPath,
      headers: headers(),
      payload: change,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
    expect(response.json().change.policyAtDecision).not.toHaveProperty("findingDispositionDigest");
  });
  it.each([
    ["V1 event under V2 policy", { ...contextV2, recordedDecision: event }],
    ["V2 event under V1 policy", { ...context, recordedDecision: eventV2 }],
    [
      "different V2 disposition",
      {
        ...contextV2,
        recordedDecision: {
          ...eventV2,
          policyAtDecision: {
            ...eventV2.policyAtDecision,
            findingDispositionDigest: "d".repeat(64),
          },
        },
      },
    ],
  ])("rejects equal result sets with %s", async (_name, output) => {
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: contextPath, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.json()).not.toHaveProperty("recordedDecision");
  });
  it.each([
    ["V1 event under V2 policy", { ...contextV2, recordedDecision: event }],
    ["V2 event under V1 policy", { ...context, recordedDecision: eventV2 }],
    [
      "different historical V2 disposition",
      {
        ...contextV2,
        recordedDecision: {
          ...eventV2,
          policyAtDecision: {
            ...eventV2.policyAtDecision,
            findingDispositionDigest: "d".repeat(64),
          },
        },
      },
    ],
  ])("preserves changed result sets with %s", async (_name, previous) => {
    const output = {
      ...previous,
      resultSetDigest: "e".repeat(64),
      recordedDecisionState: "stale",
      stateReasons: ["result_set_changed"],
    };
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: contextPath, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
  });
});
