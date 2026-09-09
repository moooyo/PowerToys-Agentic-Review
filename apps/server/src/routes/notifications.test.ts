import type {
  NotificationList,
  NotificationOverview,
  NotificationStateChange,
  NotificationStateChangeRequest,
  NotificationSummary,
} from "@agentic-review/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseRequestError } from "../database/errors.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { registerNotificationRoutes } from "./notifications.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";

const actor = { issuer: "https://notifications.example.test", subject: "reader-a" };
const origin = "https://review.example.test";
const token = "N".repeat(43);
const time = "2026-09-07T00:05:00.000Z";
const observation = {
  actor,
  observedAt: time,
  coverageStart: "2026-09-07T00:01:00.000Z",
  retainedAfter: "2026-09-07T00:00:00.000Z",
};
const overview: NotificationOverview = {
  schemaVersion: "NotificationOverviewV1",
  ...observation,
  items: [
    {
      repositoryId: "repository-a",
      fullName: "example/repository-a",
      counts: { total: 1, unread: 1, read: 0, archived: 0 },
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};
const summary: NotificationSummary = {
  schemaVersion: "NotificationSummaryV1",
  ...observation,
  repositoryId: null,
  unreadCount: 1,
  capped: false,
};
const list: NotificationList = {
  schemaVersion: "NotificationListV1",
  ...observation,
  repositoryId: "repository-a",
  limit: 20,
  filter: { state: "all", workItemKind: "all" },
  nextCursor: null,
  scanLimited: false,
  items: [
    {
      event: {
        schemaVersion: "NotificationEventV1",
        id: "notification-a",
        repositoryId: "repository-a",
        workItemId: "item-a",
        workItemKind: "pull_request",
        number: 7,
        reviewRunId: "run-a",
        revisionKey: "a".repeat(64),
        sourceId: "job-a",
        occurredAt: "2026-09-07T00:02:00.000Z",
        recordedAt: "2026-09-07T00:03:00.000Z",
        kind: "validation",
        jobId: "job-a",
        requestId: "request-a",
        jobActivation: 1,
        runAttemptId: "attempt-a",
        workflowKind: "pr_static_build",
        target: "headless",
        jobStatus: "succeeded",
        result: {
          resultId: "result-a",
          checks: {
            total: 2,
            passed: 1,
            failed: 1,
            blocked: 0,
            not_run: 0,
            skipped: 0,
            inconclusive: 0,
          },
          requiredNonPassed: 1,
          lifecycleBlockers: 1,
          evidenceComplete: true,
          sourceState: "original",
          cleanupState: "completed",
        },
      },
      state: {
        schemaVersion: "NotificationReadStateV1",
        notificationId: "notification-a",
        version: 0,
        state: "unread",
        updatedAt: null,
      },
    },
  ],
};
const change: NotificationStateChangeRequest = {
  changeId: "change-a",
  changes: [{ notificationId: "notification-a", expectedVersion: 0, state: "read" }],
};
const receipt: NotificationStateChange = {
  schemaVersion: "NotificationStateChangeV1",
  actor,
  repositoryId: "repository-a",
  changeId: change.changeId,
  createdAt: time,
  changes: [
    {
      notificationId: "notification-a",
      previousVersion: 0,
      state: {
        schemaVersion: "NotificationReadStateV1",
        notificationId: "notification-a",
        version: 1,
        state: "read",
        updatedAt: time,
      },
    },
  ],
  replayed: false,
};
const base = "/api/v1/operator/repositories/repository-a/notifications";
const routes = [
  {
    name: "overview",
    method: "GET",
    path: "/api/v1/operator/notifications/overview",
    operation: "listNotificationOverview",
    output: overview,
  },
  {
    name: "global summary",
    method: "GET",
    path: "/api/v1/operator/notifications/summary",
    operation: "getNotificationSummary",
    output: summary,
  },
  {
    name: "repository summary",
    method: "GET",
    path: "/api/v1/operator/notifications/summary?repositoryId=repository-a",
    operation: "getNotificationSummary",
    output: { ...summary, repositoryId: "repository-a" },
  },
  {
    name: "repository inbox",
    method: "GET",
    path: base,
    operation: "listRepositoryNotifications",
    output: list,
  },
  {
    name: "personal state",
    method: "POST",
    path: `${base}/state`,
    operation: "changeNotificationStates",
    output: receipt,
    body: change,
  },
] as const;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function fixture(
  output: unknown,
  options: { authenticated?: boolean; readOnly?: boolean; error?: Error } = {},
) {
  const session = {
    ...actor,
    displayName: "Notification reader",
    email: null,
    createdAt: time,
    expiresAt: "2026-09-08T00:00:00.000Z",
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
    if (options.error) throw options.error;
    return output;
  });
  const app = Fastify({ logger: false });
  apps.push(app);
  registerOperatorAuthRoutes(app, auth);
  registerNotificationRoutes(app, {
    database: database.database,
    operatorAuth: auth,
    readOnly: options.readOnly,
  });
  return { app, ...database };
}
const headers = () => ({
  host: "review.example.test",
  cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
  origin,
});

describe("notification HTTP boundary", () => {
  it.each(routes)("binds $name to the authenticated operator", async (route) => {
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
      expect.objectContaining({ actor }),
    );
    expect(f.transport.mock.calls[0]?.[0]).toBe("operatorRequest");
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.headers.vary).toBe("Cookie");
  });
  it.each(routes)("rejects unauthenticated $name without owner calls", async (route) => {
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
  it.each(routes)("rejects an owner response for another actor in $name", async (route) => {
    const f = fixture({ ...route.output, actor: { ...actor, subject: "foreign" } });
    const result = await f.app.inject({
      method: route.method,
      url: route.path,
      headers: headers(),
      payload: "body" in route ? route.body : undefined,
    });
    expect(result.statusCode).toBe(502);
  });
  it.each([
    "?limit=0",
    "?limit=51",
    "?limit=01",
    "?limit=1e1",
    "?limit=1&limit=2",
    "?cursor=0",
    "?cursor=01",
    "?cursor=9007199254740992",
    "?cursor=2&cursor=3",
    "?page=2",
    "?actor=foreign",
    "?state=unknown",
    "?workItemKind=job",
  ])("rejects invalid inbox queries %s before dispatch", async (query) => {
    const f = fixture(list);
    expect(
      (await f.app.inject({ method: "GET", url: base + query, headers: headers() })).statusCode,
    ).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(["?page=0", "?page=10000001", "?pageSize=51", "?repositoryId=repository-a"])(
    "rejects unsupported overview queries %s",
    async (query) => {
      const f = fixture(overview);
      expect(
        (await f.app.inject({ method: "GET", url: routes[0].path + query, headers: headers() }))
          .statusCode,
      ).toBe(400);
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it.each([
    "?repositoryId=",
    "?repositoryId=repository-a%0A",
    "?repositoryId=a&repositoryId=b",
    "?page=1",
  ])("does not turn an invalid summary scope into a global read: %s", async (query) => {
    const f = fixture(summary);
    expect(
      (await f.app.inject({ method: "GET", url: routes[1].path + query, headers: headers() }))
        .statusCode,
    ).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("retains a bounded empty candidate window with its continuation", async () => {
    const value = {
      ...list,
      items: [],
      nextCursor: "42",
      scanLimited: true,
      filter: { ...list.filter, state: "unread" },
    };
    const f = fixture(value);
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: `${base}?state=unread&cursor=300`,
          headers: headers(),
        })
      ).json(),
    ).toEqual(value);
  });
  it("rejects a mismatched state filter or repository projection", async () => {
    for (const value of [
      { ...list, repositoryId: "other" },
      { ...list, filter: { ...list.filter, state: "read" } },
    ]) {
      const f = fixture(value);
      expect(
        (await f.app.inject({ method: "GET", url: base, headers: headers() })).statusCode,
      ).toBe(502);
    }
  });
  it("requires exact personal CAS receipts including original replay", async () => {
    const f = fixture({ ...receipt, replayed: true });
    const result = await f.app.inject({
      method: "POST",
      url: `${base}/state`,
      headers: headers(),
      payload: change,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().replayed).toBe(true);
    const mismatch = fixture({ ...receipt, changeId: "other-change" });
    expect(
      (
        await mismatch.app.inject({
          method: "POST",
          url: `${base}/state`,
          headers: headers(),
          payload: change,
        })
      ).statusCode,
    ).toBe(502);
  });
  it.each([
    { ...change, actor: { ...actor, subject: "foreign" } },
    { ...change, repositoryId: "foreign" },
    { ...change, changes: [...change.changes, ...change.changes] },
    {
      ...change,
      changes: Array.from({ length: 51 }, (_, i) => ({
        notificationId: `event-${i}`,
        expectedVersion: 0,
        state: "read",
      })),
    },
    {
      ...change,
      changes: [
        {
          notificationId: "notification-a",
          expectedVersion: Number.MAX_SAFE_INTEGER,
          state: "read",
        },
      ],
    },
  ])("rejects unsafe or ambiguous personal changes %# before dispatch", async (payload) => {
    const f = fixture(receipt);
    expect(
      (await f.app.inject({ method: "POST", url: `${base}/state`, headers: headers(), payload }))
        .statusCode,
    ).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("enforces origin and recovery read-only rules on personal writes", async () => {
    const f = fixture(receipt);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `${base}/state`,
          headers: { ...headers(), origin: "https://foreign.example.test" },
          payload: change,
        })
      ).statusCode,
    ).toBe(403);
    const recovery = fixture(receipt, { readOnly: true });
    expect(
      (
        await recovery.app.inject({
          method: "POST",
          url: `${base}/state`,
          headers: headers(),
          payload: change,
        })
      ).statusCode,
    ).toBe(503);
    expect(f.transport).not.toHaveBeenCalled();
    expect(recovery.transport).not.toHaveBeenCalled();
  });
  it("preserves a non-disclosing expired or revoked notification response", async () => {
    const f = fixture(null, {
      error: new DatabaseRequestError("The notification was not found.", "PLATFORM_NOT_FOUND"),
    });
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `${base}/state`,
          headers: headers(),
          payload: change,
        })
      ).statusCode,
    ).toBe(404);
  });
  it("does not expose retention or an unscoped event mutation route", async () => {
    const f = fixture(null);
    for (const url of [
      "/api/v1/operator/notifications/maintain",
      "/api/v1/operator/notifications/state",
    ]) {
      expect(
        (await f.app.inject({ method: "POST", url, headers: headers(), payload: change }))
          .statusCode,
      ).toBe(404);
    }
    expect(f.transport).not.toHaveBeenCalled();
  });
});
