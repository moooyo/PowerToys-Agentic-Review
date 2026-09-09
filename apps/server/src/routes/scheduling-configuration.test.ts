import type {
  PlatformSchedulingStatus,
  RepositorySchedulingStatus,
  SchedulingConfiguration,
  SchedulingConfigurationAuditEvent,
  SchedulingConfigurationAuditListResponse,
  SchedulingConfigurationAuditSummary,
  SchedulingConfigurationUpdateRequest,
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
import { registerSchedulingConfigurationRoutes } from "./scheduling-configuration.js";

const publicOrigin = "https://review.example.com";
const token = "S".repeat(43);
const timestamp = "2026-09-07T12:00:00.000Z";
const earlier = "2026-09-07T11:00:00.000Z";
const actor = { issuer: "https://identity.example.com", subject: "operator-1" };
const repositoryId = "repository-1";
const repositoryPath = `/api/v1/operator/repositories/${repositoryId}/scheduling`;
const platformPath = "/api/v1/operator/scheduling";
const activityPath = `${platformPath}/activity`;
const configuration: SchedulingConfiguration = {
  version: 1,
  limits: { maxActiveLeases: 4, maxQueuedJobs: 12 },
  policyId: "repository-service-v1",
  updatedAt: earlier,
};
const updateRequest: SchedulingConfigurationUpdateRequest = {
  expectedVersion: 1,
  limits: { maxActiveLeases: null, maxQueuedJobs: null },
};
const updated: SchedulingConfiguration = {
  ...configuration,
  version: 2,
  limits: updateRequest.limits,
  updatedAt: timestamp,
};
const platformStatus: PlatformSchedulingStatus = {
  observedAt: timestamp,
  configuration,
  usage: {
    activeLeases: 6,
    admittedQueuedJobs: 15,
    awaitingAdmissionJobs: 7,
    awaitingConfigurationRequests: 2,
  },
  unscopedUsage: {
    activeLeases: 1,
    admittedQueuedJobs: 2,
    awaitingAdmissionJobs: 0,
    awaitingConfigurationRequests: 0,
  },
  overage: { activeLeases: 2, admittedQueuedJobs: 3 },
};
const repositoryStatus: RepositorySchedulingStatus = {
  repositoryId,
  observedAt: timestamp,
  repositoryVersion: 3,
  enabled: true,
  limits: { maxActiveLeases: 2, maxQueuedJobs: 5 },
  usage: {
    activeLeases: 3,
    admittedQueuedJobs: 6,
    awaitingAdmissionJobs: 4,
    awaitingConfigurationRequests: 1,
  },
  overage: { activeLeases: 1, admittedQueuedJobs: 1 },
  platform: {
    visibility: "restricted",
    version: configuration.version,
    activeCapacity: "limited",
    queueCapacity: "limited",
  },
};
const auditSummary: SchedulingConfigurationAuditSummary = {
  id: "audit-event-2",
  actor,
  previousVersion: 1,
  version: 2,
  createdAt: timestamp,
};
const auditEvent: SchedulingConfigurationAuditEvent = {
  ...auditSummary,
  previousSnapshot: configuration,
  snapshot: updated,
};
const auditList: SchedulingConfigurationAuditListResponse = {
  items: [auditSummary],
  total: 1,
  page: 1,
  pageSize: 20,
};
const readRoutes = [
  {
    name: "repository status",
    method: "GET",
    url: repositoryPath,
    operation: "getRepositorySchedulingStatus",
    input: { repositoryId },
    output: repositoryStatus,
  },
  {
    name: "platform status",
    method: "GET",
    url: platformPath,
    operation: "getPlatformSchedulingStatus",
    input: {},
    output: platformStatus,
  },
  {
    name: "configuration activity",
    method: "GET",
    url: activityPath,
    operation: "listPlatformSchedulingConfigurationAudit",
    input: { page: 1, pageSize: 20 },
    output: auditList,
  },
  {
    name: "configuration event",
    method: "GET",
    url: `${activityPath}/${auditEvent.id}`,
    operation: "getPlatformSchedulingConfigurationAudit",
    input: { eventId: auditEvent.id },
    output: auditEvent,
  },
] as const;
const routes = [
  ...readRoutes,
  {
    name: "platform update",
    method: "PATCH",
    url: platformPath,
    payload: updateRequest,
    operation: "updatePlatformSchedulingConfiguration",
    input: { request: updateRequest, actor },
    output: updated,
  },
] as const;
const applications: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});
const headers = () => ({ cookie: `${OPERATOR_SESSION_COOKIE}=${token}` });
const mutationHeaders = () => ({ ...headers(), origin: publicOrigin });
function expectNoStore(response: { headers: Record<string, unknown> }): void {
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers.vary).toBe("Cookie");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
}
function fixture(
  output: unknown = null,
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
      throw new Error(
        "Scheduling configuration route tests do not use an external identity provider.",
      );
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
  registerSchedulingConfigurationRoutes(app, {
    database: database.database,
    operatorAuth: auth,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  return { app, auth, ...database };
}

describe("scheduling configuration route authorization", () => {
  it.each(routes)("binds $name to the authenticated session principal", async (route) => {
    const f = fixture(route.output);
    const response = await f.app.inject({
      method: route.method,
      url: route.url,
      ...(route.method === "PATCH" ? { payload: route.payload } : {}),
      headers: { ...mutationHeaders(), "x-operator-subject": "forged-subject" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(route.output);
    expectNoStore(response);
    expect(f.transport).toHaveBeenCalledExactlyOnceWith("operatorRequest", {
      context: { kind: "operator", actor },
      operation: route.operation,
      input: route.input,
    });
    expect(f.request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
    expect(f.permissions).not.toHaveBeenCalled();
  });

  it.each(routes)(
    "rejects anonymous and expired $name sessions before database access",
    async (route) => {
      for (const authenticated of [false, true]) {
        const f = fixture(route.output, { validSession: false });
        const response = await f.app.inject({
          method: route.method,
          url: route.url,
          ...(route.method === "PATCH" ? { payload: route.payload } : {}),
          headers: { ...(authenticated ? headers() : {}), origin: publicOrigin },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json().code).toBe("operator_authentication_required");
        expectNoStore(response);
        expect(f.transport).not.toHaveBeenCalled();
      }
    },
  );

  it.each(routes)("hides session failures on $name", async (route) => {
    const f = fixture(route.output, { sessionFailure: new Error("PRIVATE_CANARY") });
    const response = await f.app.inject({
      method: route.method,
      url: route.url,
      ...(route.method === "PATCH" ? { payload: route.payload } : {}),
      headers: mutationHeaders(),
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("PRIVATE_CANARY");
    expectNoStore(response);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(readRoutes)("allows $name reads during recovery maintenance", async (route) => {
    const f = fixture(route.output, { readOnly: true });
    const response = await f.app.inject({ method: "GET", url: route.url, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(route.output);
    expectNoStore(response);
    expect(f.request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
  });

  it.each([undefined, publicOrigin, "https://another.example"])(
    "preserves GET access with Origin=%s",
    async (origin) => {
      const f = fixture(platformStatus);
      const response = await f.app.inject({
        method: "GET",
        url: platformPath,
        headers: { ...headers(), ...(origin === undefined ? {} : { origin }) },
      });
      expect(response.statusCode).toBe(200);
      expect(f.request).toHaveBeenCalledExactlyOnceWith("getPlatformSchedulingStatus", {});
    },
  );

  it.each(routes)(
    "rejects query identity overrides on $name before database access",
    async (route) => {
      const f = fixture(route.output);
      const response = await f.app.inject({
        method: route.method,
        url: `${route.url}?actor=forged&repositoryId=other`,
        ...(route.method === "PATCH" ? { payload: route.payload } : {}),
        headers: mutationHeaders(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("configuration_query_invalid");
      expect(f.transport).not.toHaveBeenCalled();
    },
  );

  it.each(routes)(
    "maps inaccessible $name scopes without leaking database details",
    async (route) => {
      for (const [code, status] of [
        ["PLATFORM_NOT_FOUND", 404],
        ["PLATFORM_FORBIDDEN", 403],
      ] as const) {
        const f = fixture(null, { failure: new DatabaseRequestError("PRIVATE_CANARY", code) });
        const response = await f.app.inject({
          method: route.method,
          url: route.url,
          ...(route.method === "PATCH" ? { payload: route.payload } : {}),
          headers: mutationHeaders(),
        });
        expect(response.statusCode).toBe(status);
        expect(response.json().code).toBe(code.toLowerCase());
        expect(response.body).not.toContain("PRIVATE_CANARY");
        expectNoStore(response);
      }
    },
  );
});

describe("platform scheduling updates", () => {
  it.each([
    { name: "missing", origin: undefined },
    { name: "foreign", origin: "https://another.example" },
    { name: "trailing slash", origin: `${publicOrigin}/` },
    { name: "default port", origin: "https://review.example.com:443" },
    { name: "null", origin: "null" },
    { name: "repeated", origin: [publicOrigin, publicOrigin] },
  ])("rejects $name Origin before checking a session", async ({ origin }) => {
    const f = fixture(updated);
    const response = await f.app.inject({
      method: "PATCH",
      url: platformPath,
      headers: { ...headers(), ...(origin === undefined ? {} : { origin }) },
      payload: updateRequest,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("invalid_operator_auth_origin");
    expectNoStore(response);
    expect(f.auth.getSession).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("rejects updates during recovery maintenance before database access", async () => {
    const f = fixture(updated, { readOnly: true });
    const response = await f.app.inject({
      method: "PATCH",
      url: platformPath,
      headers: mutationHeaders(),
      payload: updateRequest,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("configuration_read_only");
    expectNoStore(response);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(
    [
      {},
      { expectedVersion: 1 },
      { ...updateRequest, expectedVersion: 0 },
      { ...updateRequest, expectedVersion: "1" },
      { ...updateRequest, actor },
      { ...updateRequest, policyId: "repository-service-v1" },
      { ...updateRequest, updatedAt: timestamp },
      { ...updateRequest, limits: null },
      { ...updateRequest, limits: [] },
      { ...updateRequest, limits: { maxActiveLeases: null } },
      { ...updateRequest, limits: { maxQueuedJobs: null } },
      { ...updateRequest, limits: { maxActiveLeases: 0, maxQueuedJobs: null } },
      { ...updateRequest, limits: { maxActiveLeases: 65_536, maxQueuedJobs: null } },
      { ...updateRequest, limits: { maxActiveLeases: 1.5, maxQueuedJobs: null } },
      { ...updateRequest, limits: { maxActiveLeases: "2", maxQueuedJobs: null } },
      { ...updateRequest, limits: { maxActiveLeases: null, maxQueuedJobs: 0 } },
      { ...updateRequest, limits: { maxActiveLeases: null, maxQueuedJobs: 1_000_001 } },
      { ...updateRequest, limits: { maxActiveLeases: null, maxQueuedJobs: true } },
      { ...updateRequest, limits: { ...updateRequest.limits, extra: true } },
    ].map((payload) => ({ payload })),
  )("rejects malformed or server-owned update fields %j", async ({ payload }) => {
    const f = fixture(updated);
    const response = await f.app.inject({
      method: "PATCH",
      url: platformPath,
      headers: mutationHeaders(),
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("configuration_request_invalid");
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each([
    { maxActiveLeases: 1, maxQueuedJobs: 1 },
    { maxActiveLeases: 65_535, maxQueuedJobs: 1_000_000 },
    { maxActiveLeases: null, maxQueuedJobs: 10 },
    { maxActiveLeases: 2, maxQueuedJobs: null },
    { maxActiveLeases: null, maxQueuedJobs: null },
  ])("passes complete explicit limits unchanged %j", async (limits) => {
    const output = { ...updated, limits };
    const f = fixture(output);
    const request = { ...updateRequest, limits };
    const response = await f.app.inject({
      method: "PATCH",
      url: platformPath,
      headers: mutationHeaders(),
      payload: request,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("updatePlatformSchedulingConfiguration", {
      request,
      actor,
    });
  });

  it("returns a CAS conflict without retrying the update", async () => {
    const message = "Scheduling configuration changed. Reload before saving.";
    const f = fixture(null, { failure: new DatabaseRequestError(message, "PLATFORM_CONFLICT") });
    const response = await f.app.inject({
      method: "PATCH",
      url: platformPath,
      headers: mutationHeaders(),
      payload: updateRequest,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "platform_conflict", message, retryable: false });
    expectNoStore(response);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...updated, version: 3 },
    { ...updated, limits: { maxActiveLeases: 1, maxQueuedJobs: null } },
    { ...updated, updatedAt: "2026-02-30T12:00:00.000Z" },
  ])("rejects a response that does not match the accepted update %j", async (output) => {
    const f = fixture(output);
    const response = await f.app.inject({
      method: "PATCH",
      url: platformPath,
      headers: mutationHeaders(),
      payload: updateRequest,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("scheduling_response_invalid");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});

describe("scheduling status and activity response integrity", () => {
  it.each([
    { url: repositoryPath, output: { ...repositoryStatus, repositoryId: "other-repository" } },
    {
      url: repositoryPath,
      output: { ...repositoryStatus, overage: { activeLeases: 0, admittedQueuedJobs: 0 } },
    },
    {
      url: platformPath,
      output: { ...platformStatus, overage: { activeLeases: 0, admittedQueuedJobs: 0 } },
    },
    {
      url: platformPath,
      output: {
        ...platformStatus,
        unscopedUsage: { ...platformStatus.unscopedUsage, activeLeases: 7 },
      },
    },
    {
      url: platformPath,
      output: {
        ...platformStatus,
        configuration: { ...configuration, updatedAt: "2026-09-07T13:00:00Z" },
      },
    },
    {
      url: repositoryPath,
      output: {
        ...repositoryStatus,
        platform: {
          visibility: "full",
          configuration,
          usage: platformStatus.usage,
          overage: { activeLeases: 0, admittedQueuedJobs: 0 },
        },
      },
    },
    {
      url: repositoryPath,
      output: {
        ...repositoryStatus,
        platform: {
          visibility: "full",
          configuration: updated,
          usage: { ...platformStatus.usage, awaitingAdmissionJobs: 0 },
          overage: { activeLeases: 0, admittedQueuedJobs: 0 },
        },
      },
    },
    { url: `${activityPath}/${auditEvent.id}`, output: { ...auditEvent, id: "other-event" } },
    {
      url: `${activityPath}/${auditEvent.id}`,
      output: { ...auditEvent, snapshot: { ...updated, version: 3 } },
    },
    {
      url: `${activityPath}/${auditEvent.id}`,
      output: { ...auditEvent, snapshot: { ...updated, updatedAt: earlier } },
    },
  ])("rejects inconsistent scheduling data from $url", async ({ url, output }) => {
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      code: "scheduling_response_invalid",
      message: "The scheduling response could not be validated.",
      retryable: false,
    });
    expectNoStore(response);
  });

  it("retains current configuration when the observation clock moves behind its update", async () => {
    const output = {
      ...platformStatus,
      configuration: { ...configuration, updatedAt: "2026-09-07T13:00:00.000Z" },
    };
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: platformPath, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
    expectNoStore(response);
  });

  it.each([repositoryPath, `${activityPath}/${auditEvent.id}`])(
    "returns not found for missing records at %s",
    async (url) => {
      const f = fixture();
      const response = await f.app.inject({ method: "GET", url, headers: headers() });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe("platform_not_found");
    },
  );

  it.each([
    "page=0",
    "page=1.5",
    "page=01",
    "page=10000001",
    "page=9007199254740992",
    "pageSize=0",
    "pageSize=21",
    "pageSize=1.5",
    "page=1&page=2",
    "pageSize=1&pageSize=2",
  ])("rejects unbounded or repeated activity query %s before database access", async (query) => {
    const f = fixture(auditList);
    const response = await f.app.inject({
      method: "GET",
      url: `${activityPath}?${query}`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("passes bounded activity pagination and permits an empty page beyond the total", async () => {
    const output = { items: [], total: 1, page: 10_000_000, pageSize: 20 };
    const f = fixture(output);
    const response = await f.app.inject({
      method: "GET",
      url: `${activityPath}?page=10000000&pageSize=20`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("listPlatformSchedulingConfigurationAudit", {
      page: 10_000_000,
      pageSize: 20,
    });
  });

  it.each([
    { ...auditList, page: 2 },
    { ...auditList, pageSize: 10 },
    { ...auditList, items: [] },
    { ...auditList, total: 0 },
    { ...auditList, items: [{ ...auditSummary, previousVersion: 2 }] },
    {
      ...auditList,
      items: [{ ...auditSummary, actor: { ...actor, subject: " PRIVATE_CANARY " } }],
    },
    { ...auditList, total: 2, items: [auditSummary, auditSummary] },
    {
      ...auditList,
      total: 2,
      items: [{ ...auditSummary, id: "audit-event-1" }, auditSummary],
    },
    {
      ...auditList,
      total: 2,
      items: [{ ...auditSummary, id: "audit-event-3", createdAt: earlier }, auditSummary],
    },
  ])("rejects inconsistent or incorrectly ordered activity pages %j", async (output) => {
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: activityPath, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("scheduling_response_invalid");
    expect(response.body).not.toContain("PRIVATE_CANARY");
  });

  it("returns equal-time activity events in descending id order without snapshots", async () => {
    const output = {
      ...auditList,
      total: 2,
      items: [auditSummary, { ...auditSummary, id: "audit-event-1" }],
    };
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: activityPath, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
    expect(response.body).not.toContain("snapshot");
  });

  it("rejects activity summaries containing detail snapshots", async () => {
    const f = fixture({ ...auditList, items: [auditEvent] });
    const response = await f.app.inject({ method: "GET", url: activityPath, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("configuration_response_invalid");
    expect(response.body).not.toContain("previousSnapshot");
  });
});
