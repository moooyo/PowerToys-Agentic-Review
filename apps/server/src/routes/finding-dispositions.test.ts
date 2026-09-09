import { PrReviewFindingV1Schema, ValidationJobResultV1Schema } from "@agentic-review/codex";
import type {
  FindingComparisonResponse,
  FindingComparisonSide,
  FindingDispositionChangeRequest,
  FindingDispositionChangeResponse,
  FindingDispositionEvent,
  FindingDispositionHistoryResponse,
  FindingListResponse,
  FindingOccurrence,
  FindingOccurrenceRef,
  FindingResultContext,
} from "@agentic-review/contracts";
import {
  maximumFindingDispositionResponseUtf8Bytes,
  maximumRunCompletionResultUtf8Bytes,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseRequestError } from "../database/errors.js";
import { canonicalizeReviewResultSubmission } from "../database/review-results.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import type { OperatorSession } from "../security/operator-auth.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { registerFindingDispositionRoutes } from "./finding-dispositions.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";

const publicOrigin = "https://review.example.com";
const token = "S".repeat(43);
const timestamp = "2026-09-07T12:00:00.000Z";
const actor = { issuer: "https://identity.example.com", subject: "repository-reviewer" };
const scope = {
  repositoryId: "repository-1",
  reviewRunId: "run-1",
  requestId: "request-1",
  jobId: "job-1",
};
const baseline = { beforeReviewRunId: "run-0", beforeRequestId: "request-0", beforeJobId: "job-0" };
const listPath = `/api/v1/operator/repositories/${scope.repositoryId}/review-runs/${scope.reviewRunId}/requests/${scope.requestId}/jobs/${scope.jobId}/findings`;
function refFor(
  resultId: string,
  resultDigest: string,
  ordinal = 0,
  kind: FindingOccurrenceRef["kind"] = "pr_finding",
): FindingOccurrenceRef {
  const ref = { resultId, resultDigest, kind, ordinal };
  return { ...ref, key: sha256(canonicalJson({ schemaVersion: "FindingOccurrenceV1", ...ref })) };
}
const ref = refFor("result-1", "a".repeat(64));
const beforeRef = refFor("result-0", "b".repeat(64));
const changePath = `${listPath}/${ref.key}/disposition`;
const historyPath = `${listPath}/${ref.key}/history`;
const comparisonPath = `${listPath}/comparison?${new URLSearchParams(baseline)}`;
const context = {
  ...scope,
  workItemId: "work-item-1",
  workItemKind: "pull_request",
  resultId: ref.resultId,
  resultDigest: ref.resultDigest,
  revisionKey: "c".repeat(64),
  planDigest: "d".repeat(64),
  profileVersionId: "profile-version-1",
  promptVersionId: "prompt-version-1",
  workflowKind: "pr_static_build",
  target: "headless",
  activationNumber: 1,
  createdAt: timestamp,
  contextDigest: "e".repeat(64),
  sourceCurrent: true,
  latestForRequest: true,
  historical: false,
  modelAvailability: "complete",
  findingCount: 1,
  dispositionDigest: "f".repeat(64),
} satisfies FindingResultContext;
const finding = {
  ...ref,
  modelId: "model-finding-1",
  title: "Handle the missing file",
  body: "The missing file prevents initialization.",
  priority: 1,
  path: "src/main.ts",
  line: 1,
  endLine: 2,
  confidence: 0.9,
  disposition: { state: "open", version: 0, lastEventId: null, updatedAt: null, updatedBy: null },
} satisfies FindingOccurrence;
const list = {
  context,
  items: [finding],
  page: 1,
  pageSize: 20,
  total: 1,
  summary: {
    open: 1,
    accepted: 0,
    dismissed: 0,
    resolved: 0,
    rawBlocking: 1,
    unresolvedBlocking: 1,
  },
} satisfies FindingListResponse;
const event = {
  ...scope,
  id: "event-1",
  changeId: "change-1",
  workItemId: context.workItemId,
  workItemKind: context.workItemKind,
  occurrence: ref,
  revisionKey: context.revisionKey,
  planDigest: context.planDigest,
  resultSetDigestAtChange: "9".repeat(64),
  contextDigestAtChange: context.contextDigest,
  sourceCurrentAtChange: true,
  latestForRequestAtChange: true,
  previousState: "open",
  state: "accepted",
  previousVersion: 0,
  version: 1,
  action: "accept",
  reason: "The regression needs a fix.",
  actor,
  createdAt: timestamp,
} satisfies FindingDispositionEvent;
const change = {
  changeId: event.changeId,
  expectedVersion: 0,
  expectedResultDigest: ref.resultDigest,
  expectedContextDigest: context.contextDigest,
  kind: ref.kind,
  ordinal: ref.ordinal,
  action: "accept",
  reason: event.reason,
} satisfies FindingDispositionChangeRequest;
const receipt = { change: event, replayed: false } satisfies FindingDispositionChangeResponse;
const history = {
  ...scope,
  occurrence: ref,
  page: 1,
  pageSize: 20,
  total: 1,
  items: [event],
} satisfies FindingDispositionHistoryResponse;
function sideFor(value: FindingOccurrenceRef): FindingComparisonSide {
  return {
    ...value,
    title: finding.title,
    priority: finding.priority,
    path: finding.path,
    line: finding.line,
  };
}
const beforeContext = {
  ...context,
  reviewRunId: baseline.beforeReviewRunId,
  requestId: baseline.beforeRequestId,
  jobId: baseline.beforeJobId,
  resultId: beforeRef.resultId,
  resultDigest: beforeRef.resultDigest,
  sourceCurrent: false,
  historical: true,
  createdAt: "2026-09-07T11:00:00.000Z",
} satisfies FindingResultContext;
const comparison = {
  algorithmVersion: "exact-content-v1",
  before: beforeContext,
  after: context,
  compatible: true,
  reasons: [],
  items: [{ status: "persistent", before: sideFor(beforeRef), after: sideFor(ref), reason: null }],
  page: 1,
  pageSize: 20,
  total: 1,
} satisfies FindingComparisonResponse;
const routes = [
  {
    name: "list",
    method: "GET",
    url: listPath,
    operation: "listFindingOccurrences",
    input: { ...scope, actor, page: 1, pageSize: 20 },
    result: list,
    status: 200,
  },
  {
    name: "comparison",
    method: "GET",
    url: comparisonPath,
    operation: "compareFindingResults",
    input: { ...scope, ...baseline, actor, page: 1, pageSize: 20 },
    result: comparison,
    status: 200,
  },
  {
    name: "history",
    method: "GET",
    url: historyPath,
    operation: "getFindingDispositionHistory",
    input: { ...scope, actor, occurrenceKey: ref.key, page: 1, pageSize: 20 },
    result: history,
    status: 200,
  },
  {
    name: "change",
    method: "POST",
    url: changePath,
    operation: "changeFindingDisposition",
    input: { ...scope, actor, occurrenceKey: ref.key, ...change },
    result: receipt,
    status: 201,
  },
] as const;
const applications: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});
const headers = () => ({ cookie: `${OPERATOR_SESSION_COOKIE}=${token}`, origin: publicOrigin });
function expectNoStore(response: { headers: Record<string, unknown> }): void {
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers.vary).toBe("Cookie");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
}
function fixture(
  output: unknown = list,
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
      throw new Error("Finding route tests do not use an external identity provider.");
    }),
    getSession: vi.fn(async (sessionToken) => {
      if (options.sessionFailure) throw options.sessionFailure;
      return sessionToken === token && options.validSession !== false ? session : null;
    }),
    logout: vi.fn(async () => undefined),
  };
  const database = createOperatorRouteTestDatabase(actor, async () => {
    if (options.failure) throw options.failure;
    return output;
  });
  const app = Fastify({ logger: false });
  applications.push(app);
  registerOperatorAuthRoutes(app, auth);
  registerFindingDispositionRoutes(app, {
    database: database.database,
    operatorAuth: auth,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  return { app, auth, ...database };
}
async function expectInvalid(
  url: string,
  output: unknown,
  payload?: FindingDispositionChangeRequest,
) {
  const f = fixture(output);
  const response = await f.app.inject({
    method: payload === undefined ? "GET" : "POST",
    url,
    headers: headers(),
    ...(payload === undefined ? {} : { payload }),
  });
  expect(response.statusCode).toBe(502);
  expect(response.json()).not.toHaveProperty("items");
  expect(response.json()).not.toHaveProperty("change");
  expectNoStore(response);
}

describe("finding disposition authorization and requests", () => {
  it.each(routes)("uses the session actor and scoped RPC for $name", async (route) => {
    const f = fixture(route.result);
    const response = await f.app.inject({
      method: route.method,
      url: route.url,
      headers: { ...headers(), "x-operator-subject": "forged-subject" },
      ...(route.method === "POST" ? { payload: change } : {}),
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
  it.each(routes)("rejects missing or expired sessions before $name RPC", async (route) => {
    for (const missing of [true, false]) {
      const f = fixture(route.result, { validSession: false });
      const response = await f.app.inject({
        method: route.method,
        url: route.url,
        headers: missing ? { origin: publicOrigin } : headers(),
        ...(route.method === "POST" ? { payload: change } : {}),
      });
      expect(response.statusCode).toBe(401);
      expectNoStore(response);
      expect(f.transport).not.toHaveBeenCalled();
    }
  });
  it.each(routes)("hides session lookup failures for $name", async (route) => {
    const f = fixture(route.result, { sessionFailure: new Error("private-session-secret") });
    const response = await f.app.inject({
      method: route.method,
      url: route.url,
      headers: headers(),
      ...(route.method === "POST" ? { payload: change } : {}),
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private-session-secret");
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    "null",
    "https://evil.example",
    `${publicOrigin}/`,
    `${publicOrigin}, ${publicOrigin}`,
  ])("rejects invalid mutation Origin %s", async (origin) => {
    const f = fixture(receipt);
    const response = await f.app.inject({
      method: "POST",
      url: changePath,
      payload: change,
      headers: {
        cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
        ...(origin === undefined ? {} : { origin }),
      },
    });
    expect(response.statusCode).toBe(403);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("rejects mutations in recovery mode while retaining reads", async () => {
    const f = fixture(receipt, { readOnly: true });
    const response = await f.app.inject({
      method: "POST",
      url: changePath,
      payload: change,
      headers: headers(),
    });
    expect(response.statusCode).toBe(503);
    expect(f.transport).not.toHaveBeenCalled();
    for (const route of routes.filter((route) => route.method === "GET")) {
      const reader = fixture(route.result, { readOnly: true });
      expect(
        (await reader.app.inject({ method: "GET", url: route.url, headers: headers() })).statusCode,
      ).toBe(200);
    }
  });
  it.each(routes)("rejects query actor injection for $name", async (route) => {
    const f = fixture(route.result);
    const response = await f.app.inject({
      method: route.method,
      url: `${route.url}${route.url.includes("?") ? "&" : "?"}actor=forged`,
      headers: headers(),
      ...(route.method === "POST" ? { payload: change } : {}),
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
  ])("rejects invalid pagination %s", async (query) => {
    for (const route of routes.filter((route) => route.method === "GET")) {
      const f = fixture(route.result);
      const response = await f.app.inject({
        method: "GET",
        url: `${route.url}${route.url.includes("?") ? "&" : "?"}${query}`,
        headers: headers(),
      });
      expect(response.statusCode).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
    }
  });
  it.each(Object.keys(scope) as (keyof typeof scope)[])("rejects malformed %s", async (key) => {
    const f = fixture();
    const response = await f.app.inject({
      method: "GET",
      url: listPath.replace(scope[key], "%20invalid"),
      headers: headers(),
    });
    expect(response.statusCode).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(["a".repeat(63), "A".repeat(64), "g".repeat(64), "invalid", "a".repeat(65)])(
    "rejects malformed occurrence key %s",
    async (key) => {
      for (const method of ["GET", "POST"] as const) {
        const f = fixture();
        const response = await f.app.inject({
          method,
          url: (method === "GET" ? historyPath : changePath).replace(ref.key, key),
          headers: headers(),
          ...(method === "POST" ? { payload: change } : {}),
        });
        expect(response.statusCode).toBe(400);
        expect(f.transport).not.toHaveBeenCalled();
      }
    },
  );
  it.each(Object.keys(baseline))("requires a unique explicit baseline %s", async (key) => {
    for (const query of [
      new URLSearchParams(Object.entries(baseline).filter(([name]) => name !== key)),
      new URLSearchParams({ ...baseline, [key]: " invalid" }),
      new URLSearchParams([...Object.entries(baseline), [key, "duplicate"]]),
    ]) {
      const f = fixture(comparison);
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: `${listPath}/comparison?${query}`,
            headers: headers(),
          })
        ).statusCode,
      ).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
    }
  });
  it.each([
    ["actor injection", { ...change, actor }],
    ["scope injection", { ...change, repositoryId: "other" }],
    ["missing context", { ...change, expectedContextDigest: undefined }],
    ["missing result", { ...change, expectedResultDigest: undefined }],
    ["invalid digest", { ...change, expectedResultDigest: "A".repeat(64) }],
    ["unknown action", { ...change, action: "approve" }],
    ["unknown namespace", { ...change, kind: "model" }],
    ["negative ordinal", { ...change, ordinal: -1 }],
    ["excessive ordinal", { ...change, ordinal: 100 }],
    ["empty reason", { ...change, reason: "" }],
    ["blank reason", { ...change, reason: " \n\t" }],
    ["reason bound", { ...change, reason: "r".repeat(2_049) }],
    ["control reason", { ...change, reason: "reason\u0000" }],
    ["C1 control reason", { ...change, reason: "reason\u0085" }],
    ["invalid Unicode reason", { ...change, reason: "reason\ud800" }],
    ["negative version", { ...change, expectedVersion: -1 }],
    ["unsafe version", { ...change, expectedVersion: Number.MAX_SAFE_INTEGER }],
  ])("rejects %s before mutation RPC", async (_name, payload) => {
    const f = fixture(receipt);
    expect(
      (await f.app.inject({ method: "POST", url: changePath, headers: headers(), payload }))
        .statusCode,
    ).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("enforces the 16 KiB raw request bound before parsing", async () => {
    const f = fixture(receipt);
    const response = await f.app.inject({
      method: "POST",
      url: changePath,
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
  ] as const)("maps database %s", async (code, status) => {
    for (const route of routes) {
      const f = fixture(route.result, {
        failure: new DatabaseRequestError("Private repository details.", code),
      });
      const response = await f.app.inject({
        method: route.method,
        url: route.url,
        headers: headers(),
        ...(route.method === "POST" ? { payload: change } : {}),
      });
      expect(response.statusCode).toBe(status);
      if (status === 403 || status === 404)
        expect(response.body).not.toContain("Private repository details.");
      expect(response.json()).not.toHaveProperty("items");
      expect(response.json()).not.toHaveProperty("change");
    }
  });
  it.each(routes)("hides unexpected database errors for $name", async (route) => {
    const f = fixture(route.result, { failure: new Error("private-driver-secret") });
    const response = await f.app.inject({
      method: route.method,
      url: route.url,
      headers: headers(),
      ...(route.method === "POST" ? { payload: change } : {}),
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private-driver-secret");
  });
});

describe("finding list response integrity", () => {
  it("enforces the 2 MiB serialized response limit before returning data", async () => {
    const createdAt = `September 7, 2026${" ".repeat(maximumFindingDispositionResponseUtf8Bytes)}`;
    expect(Number.isFinite(Date.parse(createdAt))).toBe(true);
    const f = fixture({ ...list, context: { ...context, createdAt } });
    const response = await f.app.inject({ method: "GET", url: listPath, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("configuration_response_invalid");
    expect(response.body.length).toBeLessThan(512);
  });
  it("retains complete legal pages whose escaped findings and audit principals exceed 1 MiB", async () => {
    const rawFindings = Array.from({ length: 20 }, (_, ordinal) => ({
      findingId: `finding-${ordinal}`,
      priority: 1,
      title: "\u0001".repeat(256),
      body: "\u0001".repeat(8192),
      path: "界".repeat(1024),
      line: 1,
      endLine: null,
      confidence: 1,
    }));
    const rawResult = {
      schemaVersion: "ValidationJobResultV1",
      report: {
        schemaVersion: "ValidationReportV1",
        source: "worker",
        workItemKind: "pull_request",
        summary: "Completed.",
        sourceState: "original",
        checks: [],
      },
      modelReview: {
        state: "completed",
        result: {
          schemaVersion: "PrReviewPlanV2",
          summary: "Completed.",
          assessment: "request_changes",
          findings: rawFindings,
          requestedRecipeIds: [],
          verification: { status: "not_run", summary: "No checks configured.", commands: [] },
          executionEvidence: {
            schemaVersion: "ReviewExecutionEvidenceV1",
            source: "worker",
            commandCapture: "complete",
            commands: [],
            worktree: { status: "unknown", source: "not_observed" },
          },
        },
      },
      execution: { blockers: [], diagnostics: [], cleanupState: "not_needed" },
    };
    Value.Assert(ValidationJobResultV1Schema, rawResult);
    for (const original of rawFindings) Value.Assert(PrReviewFindingV1Schema, original);
    const stored = canonicalizeReviewResultSubmission(rawResult);
    expect(Buffer.byteLength(stored.canonicalResultJson, "utf8")).toBeLessThan(
      maximumRunCompletionResultUtf8Bytes,
    );
    const prefix = "https://identity.example.test/";
    const updatedBy = {
      issuer: prefix + "界".repeat(2048 - prefix.length),
      subject: "界".repeat(512),
    };
    for (const edited of [false, true]) {
      const items: FindingOccurrence[] = rawFindings.map((original, ordinal) => ({
        ...refFor(context.resultId, stored.resultDigest, ordinal),
        modelId: original.findingId,
        priority: original.priority,
        title: original.title,
        body: original.body,
        path: original.path,
        line: original.line,
        endLine: original.endLine,
        confidence: original.confidence,
        disposition: edited
          ? {
              state: "accepted",
              version: 1,
              lastEventId: `event-${ordinal}`,
              updatedAt: timestamp,
              updatedBy,
            }
          : finding.disposition,
      }));
      const output: FindingListResponse = {
        ...list,
        context: { ...context, resultDigest: stored.resultDigest, findingCount: 20 },
        total: 20,
        items,
        summary: {
          open: edited ? 0 : 20,
          accepted: edited ? 20 : 0,
          dismissed: 0,
          resolved: 0,
          rawBlocking: 20,
          unresolvedBlocking: 20,
        },
      };
      const encodedBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
      expect(encodedBytes).toBeGreaterThan(1024 * 1024);
      expect(encodedBytes).toBeLessThan(maximumFindingDispositionResponseUtf8Bytes);
      const f = fixture(output);
      const response = await f.app.inject({ method: "GET", url: listPath, headers: headers() });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(output);
    }
  });
  it("returns complete bounded pages of findings without truncating their original text", async () => {
    const items = Array.from({ length: 20 }, (_, ordinal) => ({
      ...finding,
      ...refFor(ref.resultId, ref.resultDigest, ordinal),
      body: "A".repeat(8192),
    }));
    const output = {
      ...list,
      context: { ...context, findingCount: 20 },
      total: 20,
      items,
      summary: { ...list.summary, open: 20, rawBlocking: 20, unresolvedBlocking: 20 },
    };
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: listPath, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual(items);
  });
  it.each([
    ["repository", { ...list, context: { ...context, repositoryId: "private-repo" } }],
    ["run", { ...list, context: { ...context, reviewRunId: "other" } }],
    ["request", { ...list, context: { ...context, requestId: "other" } }],
    ["job", { ...list, context: { ...context, jobId: "other" } }],
    ["false historical flag", { ...list, context: { ...context, historical: true } }],
    ["stale source flag", { ...list, context: { ...context, sourceCurrent: false } }],
    ["old execution flag", { ...list, context: { ...context, latestForRequest: false } }],
    [
      "missing model with findings",
      { ...list, context: { ...context, modelAvailability: "not_requested" } },
    ],
    [
      "failed model with findings",
      { ...list, context: { ...context, modelAvailability: "failed" } },
    ],
    ["work item kind", { ...list, context: { ...context, workItemKind: "issue" } }],
    ["invalid static target", { ...list, context: { ...context, target: "web" } }],
    ["incorrect total", { ...list, total: 2 }],
    ["false context count", { ...list, context: { ...context, findingCount: 2 } }],
    ["page mismatch", { ...list, page: 2 }],
    ["size mismatch", { ...list, pageSize: 1 }],
    ["missing page item", { ...list, items: [] }],
    ["status summary", { ...list, summary: { ...list.summary, resolved: 1 } }],
    ["false raw blocking", { ...list, summary: { ...list.summary, rawBlocking: 0 } }],
    ["false unresolved blocking", { ...list, summary: { ...list.summary, unresolvedBlocking: 0 } }],
    ["unknown output field", { ...list, secret: "private-result" }],
  ])("rejects %s", async (_name, output) => expectInvalid(listPath, output));
  it.each([
    ["false key", { ...finding, key: "1".repeat(64) }],
    ["wrong result", { ...finding, ...refFor("other", ref.resultDigest) }],
    ["wrong result digest", { ...finding, ...refFor(ref.resultId, "2".repeat(64)) }],
    ["out of range original ordinal", { ...finding, ...refFor(ref.resultId, ref.resultDigest, 1) }],
    [
      "initial accepted state",
      { ...finding, disposition: { ...finding.disposition, state: "accepted" } },
    ],
    [
      "initial event",
      { ...finding, disposition: { ...finding.disposition, lastEventId: "unexpected" } },
    ],
    [
      "initial timestamp",
      { ...finding, disposition: { ...finding.disposition, updatedAt: timestamp } },
    ],
    ["initial actor", { ...finding, disposition: { ...finding.disposition, updatedBy: actor } }],
    ["version without event", { ...finding, disposition: { ...finding.disposition, version: 1 } }],
    ["invalid line range", { ...finding, line: 5, endLine: 4 }],
    ["missing path", { ...finding, path: null }],
    ["missing PR confidence", { ...finding, confidence: null }],
    [
      "wrong occurrence namespace",
      { ...finding, ...refFor(ref.resultId, ref.resultDigest, 0, "validation_observation") },
    ],
  ])("rejects item %s", async (_name, item) => expectInvalid(listPath, { ...list, items: [item] }));
  it("preserves display order without renumbering original ordinals", async () => {
    const last = { ...finding, ...refFor(ref.resultId, ref.resultDigest, 1) };
    const output = {
      ...list,
      context: { ...context, findingCount: 2 },
      total: 2,
      items: [last, finding],
      summary: { ...list.summary, open: 2, rawBlocking: 2, unresolvedBlocking: 2 },
    };
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: listPath, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: FindingOccurrence) => item.ordinal)).toEqual([1, 0]);
  });
  it("rejects duplicate identities even when counts match", async () => {
    await expectInvalid(listPath, {
      ...list,
      context: { ...context, findingCount: 2 },
      total: 2,
      items: [finding, finding],
      summary: { ...list.summary, open: 2, rawBlocking: 2, unresolvedBlocking: 2 },
    });
  });
  it.each(["failed", "not_requested", "not_applicable", "complete"] as const)(
    "retains explicit %s with an empty finding list",
    async (availability) => {
      const output: FindingListResponse = {
        ...list,
        context: { ...context, modelAvailability: availability, findingCount: 0 },
        items: [],
        total: 0,
        summary: {
          open: 0,
          accepted: 0,
          dismissed: 0,
          resolved: 0,
          rawBlocking: 0,
          unresolvedBlocking: 0,
        },
      };
      const f = fixture(output);
      const response = await f.app.inject({ method: "GET", url: listPath, headers: headers() });
      expect(response.statusCode).toBe(200);
      expect(response.json().context.modelAvailability).toBe(availability);
    },
  );
  it("supports full validation observations and historical issue results", async () => {
    const output: FindingListResponse = {
      ...list,
      context: {
        ...context,
        workItemKind: "issue",
        workflowKind: "issue_validation",
        target: "windows_desktop",
        sourceCurrent: false,
        historical: true,
      },
      items: [
        {
          ...finding,
          ...refFor(ref.resultId, ref.resultDigest, 0, "validation_observation"),
          path: null,
          line: null,
          endLine: null,
          confidence: null,
        },
      ],
    };
    const f = fixture(output);
    expect(
      (await f.app.inject({ method: "GET", url: listPath, headers: headers() })).statusCode,
    ).toBe(200);
  });
  it("allows reopened findings with a nonzero audit version", async () => {
    const f = fixture({
      ...list,
      items: [
        {
          ...finding,
          disposition: {
            state: "open",
            version: 2,
            lastEventId: "event-2",
            updatedAt: timestamp,
            updatedBy: actor,
          },
        },
      ],
    });
    expect(
      (await f.app.inject({ method: "GET", url: listPath, headers: headers() })).statusCode,
    ).toBe(200);
  });
  it("checks summaries against only the requested page while retaining full counts", async () => {
    const output = {
      ...list,
      context: { ...context, findingCount: 2 },
      total: 2,
      page: 2,
      pageSize: 1,
      items: [{ ...finding, ...refFor(ref.resultId, ref.resultDigest, 1) }],
      summary: { ...list.summary, open: 2, rawBlocking: 2, unresolvedBlocking: 2 },
    };
    const f = fixture(output);
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: `${listPath}?page=2&pageSize=1`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(200);
    await expectInvalid(`${listPath}?page=2&pageSize=1`, {
      ...output,
      summary: { ...output.summary, rawBlocking: 0, unresolvedBlocking: 0 },
    });
  });
  it("returns a bounded empty page past the last result", async () => {
    const f = fixture({ ...list, items: [], page: 2 });
    expect(
      (await f.app.inject({ method: "GET", url: `${listPath}?page=2`, headers: headers() }))
        .statusCode,
    ).toBe(200);
  });
});

describe("finding mutation and audit response integrity", () => {
  it.each([
    ["repository", { ...event, repositoryId: "other" }],
    ["run", { ...event, reviewRunId: "other" }],
    ["request", { ...event, requestId: "other" }],
    ["job", { ...event, jobId: "other" }],
    ["key", { ...event, occurrence: { ...ref, key: "0".repeat(64) } }],
    ["result", { ...event, occurrence: refFor("other-result", ref.resultDigest) }],
    ["digest", { ...event, occurrence: refFor(ref.resultId, "0".repeat(64)) }],
    [
      "namespace",
      { ...event, occurrence: refFor(ref.resultId, ref.resultDigest, 0, "validation_observation") },
    ],
    ["ordinal", { ...event, occurrence: refFor(ref.resultId, ref.resultDigest, 1) }],
    ["change ID", { ...event, changeId: "other" }],
    ["actor issuer", { ...event, actor: { ...actor, issuer: "https://other.example" } }],
    ["actor subject", { ...event, actor: { ...actor, subject: "other" } }],
    ["context digest", { ...event, contextDigestAtChange: "0".repeat(64) }],
    ["action", { ...event, action: "dismiss", state: "dismissed" }],
    ["state mapping", { ...event, state: "resolved" }],
    ["initial state", { ...event, previousState: "dismissed" }],
    ["no state change", { ...event, previousState: "accepted" }],
    ["version", { ...event, previousVersion: 1, version: 2 }],
    ["broken version chain", { ...event, version: 2 }],
    ["reason", { ...event, reason: "Different reason." }],
    ["untrimmed reason", { ...event, reason: ` ${event.reason} ` }],
    ["invalid control reason", { ...event, reason: "reason\u0085" }],
  ])("rejects %s even for immutable replay receipts", async (_name, modified) =>
    expectInvalid(changePath, { change: modified, replayed: true }, change),
  );
  it.each([false, true])(
    "preserves accepted receipt history when replayed is %s",
    async (replayed) => {
      const output = {
        change: { ...event, sourceCurrentAtChange: false, latestForRequestAtChange: false },
        replayed,
      };
      const f = fixture(output);
      const response = await f.app.inject({
        method: "POST",
        url: changePath,
        payload: change,
        headers: headers(),
      });
      expect(response.statusCode).toBe(replayed ? 200 : 201);
      expect(response.json()).toEqual(output);
    },
  );
  it.each(["accept", "dismiss", "resolve", "reopen"] as const)(
    "validates the %s state mapping",
    async (action) => {
      const mapped = {
        accept: "accepted",
        dismiss: "dismissed",
        resolve: "resolved",
        reopen: "open",
      } as const;
      const previousState = action === "reopen" ? "resolved" : "open";
      const output: FindingDispositionChangeResponse = {
        change: {
          ...event,
          previousState,
          previousVersion: 1,
          version: 2,
          action,
          state: mapped[action],
        },
        replayed: false,
      };
      const f = fixture(output);
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: changePath,
            headers: headers(),
            payload: { ...change, action, expectedVersion: 1 },
          })
        ).statusCode,
      ).toBe(201);
    },
  );
  it("preserves reason paragraphs and trims only their outer whitespace", async () => {
    const reason = "First paragraph.\n\r\nSecond\tparagraph.";
    const f = fixture({ change: { ...event, reason }, replayed: false });
    const payload = { ...change, reason: ` \r\n${reason}\t ` };
    const response = await f.app.inject({
      method: "POST",
      url: changePath,
      headers: headers(),
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().change.reason).toBe(reason);
    expect(f.request.mock.calls[0]?.[1]).toMatchObject({ reason: payload.reason });
  });
  it.each([
    ["repository", { ...history, repositoryId: "other" }],
    ["run", { ...history, reviewRunId: "other" }],
    ["request", { ...history, requestId: "other" }],
    ["job", { ...history, jobId: "other" }],
    ["occurrence", { ...history, occurrence: beforeRef }],
    ["page", { ...history, page: 2 }],
    ["page size", { ...history, pageSize: 1 }],
    ["total", { ...history, total: 2 }],
    ["missing event", { ...history, items: [] }],
    ["event scope", { ...history, items: [{ ...event, jobId: "other" }] }],
    ["event occurrence", { ...history, items: [{ ...event, occurrence: beforeRef }] }],
    ["event action", { ...history, items: [{ ...event, state: "resolved" }] }],
  ])("rejects history %s", async (_name, output) => expectInvalid(historyPath, output));
  it("validates descending audit chains without replacing historical principals", async () => {
    const second: FindingDispositionEvent = {
      ...event,
      id: "event-2",
      changeId: "change-2",
      actor: { ...actor, subject: "other-reviewer" },
      previousState: "accepted",
      state: "resolved",
      action: "resolve",
      previousVersion: 1,
      version: 2,
      createdAt: "2026-09-07T12:01:00.000Z",
    };
    const output = { ...history, total: 2, items: [second, event] };
    const f = fixture(output);
    expect(
      (await f.app.inject({ method: "GET", url: historyPath, headers: headers() })).statusCode,
    ).toBe(200);
    for (const broken of [
      { ...second, previousState: "open" },
      { ...second, workItemId: "other" },
      { ...second, workItemKind: "issue" },
      { ...second, revisionKey: "0".repeat(64) },
      { ...second, planDigest: "0".repeat(64) },
      { ...second, id: event.id },
      { ...second, changeId: event.changeId },
      { ...second, createdAt: "2026-09-07T11:59:00.000Z" },
    ])
      await expectInvalid(historyPath, { ...output, items: [broken, event] });
  });
  it("supports empty audit history and later pages with original version numbers", async () => {
    for (const output of [
      { ...history, total: 0, items: [] },
      { ...history, page: 2, pageSize: 1, total: 2 },
    ]) {
      const f = fixture(output);
      const response = await f.app.inject({
        method: "GET",
        url: `${historyPath}?page=${output.page}&pageSize=${output.pageSize}`,
        headers: headers(),
      });
      expect(response.statusCode).toBe(200);
    }
  });
});

describe("finding comparison response integrity", () => {
  it.each([
    ["before repository", { ...comparison, before: { ...beforeContext, repositoryId: "other" } }],
    ["before run", { ...comparison, before: { ...beforeContext, reviewRunId: "other" } }],
    ["before request", { ...comparison, before: { ...beforeContext, requestId: "other" } }],
    ["before job", { ...comparison, before: { ...beforeContext, jobId: "other" } }],
    ["after repository", { ...comparison, after: { ...context, repositoryId: "other" } }],
    ["after run", { ...comparison, after: { ...context, reviewRunId: "other" } }],
    ["after request", { ...comparison, after: { ...context, requestId: "other" } }],
    ["after job", { ...comparison, after: { ...context, jobId: "other" } }],
    ["work item", { ...comparison, before: { ...beforeContext, workItemId: "other" } }],
    [
      "work item kind",
      {
        ...comparison,
        before: { ...beforeContext, workItemKind: "issue", workflowKind: "issue_validation" },
      },
    ],
    ["compatibility", { ...comparison, compatible: false }],
    ["reasons", { ...comparison, reasons: ["model_unavailable"] }],
    [
      "configuration omission",
      { ...comparison, before: { ...beforeContext, promptVersionId: "other" } },
    ],
    [
      "baseline time omission",
      { ...comparison, before: { ...beforeContext, createdAt: timestamp } },
    ],
    ["incorrect total", { ...comparison, total: 0 }],
    ["extra total", { ...comparison, total: 3 }],
    ["page", { ...comparison, page: 2 }],
    ["page size", { ...comparison, pageSize: 1 }],
    ["unknown algorithm", { ...comparison, algorithmVersion: "fuzzy-v1" }],
  ])("rejects comparison %s", async (_name, output) => expectInvalid(comparisonPath, output));
  it.each([
    [
      "missing both sides",
      { status: "incomparable", before: null, after: null, reason: "ambiguous_match" },
    ],
    ["unbound before", { ...comparison.items[0], before: sideFor(ref) }],
    ["unbound after", { ...comparison.items[0], after: sideFor(beforeRef) }],
    [
      "forged key",
      { ...comparison.items[0], before: { ...sideFor(beforeRef), key: "0".repeat(64) } },
    ],
    ["persistent missing side", { ...comparison.items[0], before: null }],
    [
      "persistent mismatch title",
      { ...comparison.items[0], after: { ...sideFor(ref), title: "Different finding" } },
    ],
    [
      "persistent mismatch path",
      { ...comparison.items[0], after: { ...sideFor(ref), path: "other.ts" } },
    ],
    ["persistent false reason", { ...comparison.items[0], reason: "ambiguous_match" }],
    ["new with before", { ...comparison.items[0], status: "new" }],
    ["not observed with after", { ...comparison.items[0], status: "not_observed_again" }],
    ["unsupported auto resolution", { ...comparison.items[0], status: "resolved" }],
    [
      "incomparable with both",
      { ...comparison.items[0], status: "incomparable", reason: "ambiguous_match" },
    ],
    [
      "false incompatible reason",
      {
        status: "incomparable",
        before: sideFor(beforeRef),
        after: null,
        reason: "configuration_changed",
      },
    ],
  ])("rejects row %s", async (_name, row) =>
    expectInvalid(comparisonPath, { ...comparison, items: [row] }),
  );
  it("shows unmatched findings as new and not observed again without resolving them", async () => {
    const output: FindingComparisonResponse = {
      ...comparison,
      total: 2,
      items: [
        { status: "not_observed_again", before: sideFor(beforeRef), after: null, reason: null },
        {
          status: "new",
          before: null,
          after: { ...sideFor(ref), title: "Another finding" },
          reason: null,
        },
      ],
    };
    const f = fixture(output);
    expect(
      (await f.app.inject({ method: "GET", url: comparisonPath, headers: headers() })).json(),
    ).toEqual(output);
  });
  it("accepts ambiguous matches as separate unpaired occurrences", async () => {
    const output: FindingComparisonResponse = {
      ...comparison,
      total: 2,
      items: [
        {
          status: "incomparable",
          before: sideFor(beforeRef),
          after: null,
          reason: "ambiguous_match",
        },
        { status: "incomparable", before: null, after: sideFor(ref), reason: "ambiguous_match" },
      ],
    };
    const f = fixture(output);
    expect(
      (await f.app.inject({ method: "GET", url: comparisonPath, headers: headers() })).statusCode,
    ).toBe(200);
  });
  it("rejects duplicated comparison side identities", async () => {
    await expectInvalid(comparisonPath, {
      ...comparison,
      total: 2,
      items: [comparison.items[0], comparison.items[0]],
    });
  });
  it("retains configuration incompatibility and bounded single-sided rows", async () => {
    const output: FindingComparisonResponse = {
      ...comparison,
      before: { ...beforeContext, profileVersionId: "old-profile" },
      compatible: false,
      reasons: ["configuration_changed"],
      total: 2,
      items: [
        {
          status: "incomparable",
          before: sideFor(beforeRef),
          after: null,
          reason: "configuration_changed",
        },
        {
          status: "incomparable",
          before: null,
          after: sideFor(ref),
          reason: "configuration_changed",
        },
      ],
    };
    const f = fixture(output);
    expect(
      (await f.app.inject({ method: "GET", url: comparisonPath, headers: headers() })).statusCode,
    ).toBe(200);
    await expectInvalid(comparisonPath, {
      ...output,
      items: [{ ...output.items[0], reason: "model_unavailable" }, output.items[1]],
    });
  });
  it("does not call an absent model a clean comparison", async () => {
    const output: FindingComparisonResponse = {
      ...comparison,
      after: { ...context, modelAvailability: "failed", findingCount: 0 },
      compatible: false,
      reasons: ["model_unavailable"],
      items: [
        {
          status: "incomparable",
          before: sideFor(beforeRef),
          after: null,
          reason: "model_unavailable",
        },
      ],
    };
    const f = fixture(output);
    expect(
      (await f.app.inject({ method: "GET", url: comparisonPath, headers: headers() })).statusCode,
    ).toBe(200);
    await expectInvalid(comparisonPath, {
      ...output,
      compatible: true,
      reasons: [],
      items: [
        { status: "not_observed_again", before: sideFor(beforeRef), after: null, reason: null },
      ],
    });
  });
  it("keeps same-result and later-baseline comparisons explicitly incomparable", async () => {
    const output: FindingComparisonResponse = {
      ...comparison,
      before: context,
      compatible: false,
      reasons: ["same_result", "baseline_not_earlier"],
      total: 2,
      items: [
        { status: "incomparable", before: sideFor(ref), after: null, reason: null },
        { status: "incomparable", before: null, after: sideFor(ref), reason: null },
      ],
    };
    const f = fixture(output);
    const url = `${listPath}/comparison?${new URLSearchParams({ beforeReviewRunId: scope.reviewRunId, beforeRequestId: scope.requestId, beforeJobId: scope.jobId })}`;
    expect((await f.app.inject({ method: "GET", url, headers: headers() })).statusCode).toBe(200);
    await expectInvalid(comparisonPath, {
      ...output,
      before: {
        ...beforeContext,
        resultId: ref.resultId,
        resultDigest: ref.resultDigest,
        createdAt: timestamp,
      },
    });
  });
});
