import type {
  ConfigurationAuditEvent,
  ConfigurationAuditSummary,
  ManagedRepository,
} from "@agentic-review/contracts";
import { maximumConfigurationAuditResponseUtf8Bytes } from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import type { OperatorSession } from "../security/operator-auth.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { registerConfigurationAuditRoutes } from "./configuration-audit.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";

const publicOrigin = "https://review.example.com";
const sessionToken = "S".repeat(43);
const timestamp = "2026-09-07T00:00:00.000Z";
const repositoryId = "repository-1";
const templateId = "template-1";
const eventId = "audit-1";
const repositoryPath = `/api/v1/operator/repositories/${repositoryId}/configuration-audit`;
const repositoryEventPath = `${repositoryPath}/repository/${eventId}`;
const globalPath = "/api/v1/operator/configuration-audit";
const globalEventPath = `${globalPath}/${eventId}`;
const privateValue = "private-audit-response-value";
const session: OperatorSession = {
  issuer: "https://identity.example.com",
  subject: "ordinary-user-123",
  displayName: "Ordinary User",
  email: "user@example.com",
  createdAt: timestamp,
  expiresAt: "2026-09-07T01:00:00.000Z",
};
const actor = { issuer: session.issuer, subject: session.subject };
const repository: ManagedRepository = {
  id: repositoryId,
  githubRepositoryId: 123,
  fullName: "microsoft/PowerToys",
  enabled: false,
  version: 1,
  reviewerGithubUserId: null,
  reviewerGithubLogin: null,
  authorizationPolicy: null,
  connectionStatus: "unknown",
  connectionMessage: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const repositorySummary = {
  id: eventId,
  source: "repository",
  action: "created",
  entityId: repositoryId,
  repositoryId,
  actor,
  createdAt: timestamp,
  version: 1,
} satisfies ConfigurationAuditSummary;
const repositoryEvent = {
  ...repositorySummary,
  snapshot: repository,
} satisfies ConfigurationAuditEvent;
const promptSummary = {
  id: eventId,
  source: "prompt",
  action: "prompt_bound",
  entityId: "binding-history-1",
  repositoryId,
  actor,
  createdAt: timestamp,
  version: 1,
} satisfies ConfigurationAuditSummary;
const promptEvent = {
  ...promptSummary,
  snapshot: {
    workflowKind: "pr_static_build",
    promptVersionId: "prompt-version-1",
    previousVersionId: null,
    version: 1,
  },
} satisfies ConfigurationAuditEvent;
const templateSummary = {
  id: eventId,
  source: "prompt",
  action: "template_created",
  entityId: templateId,
  repositoryId: null,
  actor,
  createdAt: timestamp,
  version: 1,
} satisfies ConfigurationAuditSummary;
const templateEvent = {
  ...templateSummary,
  snapshot: { workflowKind: "pr_static_build", version: 1 },
} satisfies ConfigurationAuditEvent;
const globalBindingSummary = {
  ...promptSummary,
  id: "binding-event-1",
  repositoryId: null,
} satisfies ConfigurationAuditSummary;
const bootstrapSummary = {
  ...templateSummary,
  id: "bootstrap-event-1",
  action: "bootstrap_registered",
  entityId: "pr_static_build",
  version: null,
} satisfies ConfigurationAuditSummary;
const page = <T>(items: T[], pageNumber = 1, pageSize = 20, total = items.length) => ({
  items,
  total,
  page: pageNumber,
  pageSize,
});
const repositoryPage = (
  items: ConfigurationAuditSummary[] = [promptSummary, repositorySummary],
  pageNumber = 1,
  pageSize = 20,
  total = items.length,
) => ({ repositoryId, ...page(items, pageNumber, pageSize, total) });

const readRoutes = [
  {
    name: "repository list",
    url: repositoryPath,
    operation: "listRepositoryConfigurationAudit",
    input: { repositoryId, page: 1, pageSize: 20 },
    output: repositoryPage(),
  },
  {
    name: "repository event",
    url: repositoryEventPath,
    operation: "getRepositoryConfigurationAudit",
    input: { repositoryId, source: "repository", eventId },
    output: repositoryEvent,
  },
  {
    name: "global list",
    url: globalPath,
    operation: "listGlobalConfigurationAudit",
    input: { page: 1, pageSize: 20 },
    output: page([templateSummary]),
  },
  {
    name: "global event",
    url: globalEventPath,
    operation: "getGlobalConfigurationAudit",
    input: { eventId },
    output: templateEvent,
  },
] as const;

const createAuth = (authenticated = true): OperatorAuthRouteService => ({
  publicOrigin,
  postLoginRedirectPath: "/",
  requiresLoopbackRequest: false,
  secureCookies: true,
  usesBrowserBinding: false,
  ensureBrowserBinding: vi.fn(() => undefined),
  startLogin: vi.fn(async () => ({ kind: "session" as const, sessionToken, session })),
  completeLogin: vi.fn(async () => {
    throw new Error("Not used by configuration audit route tests.");
  }),
  getSession: vi.fn(async (token) => (authenticated && token === sessionToken ? session : null)),
  logout: vi.fn(async () => undefined),
});
const createDatabase = (implementation?: (operation: string, input: unknown) => Promise<unknown>) =>
  createOperatorRouteTestDatabase(
    actor,
    implementation ??
      (async (operation) => {
        const route = readRoutes.find((entry) => entry.operation === operation);
        if (!route) throw new Error(`Unexpected operation: ${operation}`);
        return route.output;
      }),
  );
const apps: FastifyInstance[] = [];
const createApp = (
  options: {
    readonly auth?: OperatorAuthRouteService;
    readonly database?: DatabaseClient;
    readonly readOnly?: boolean;
  } = {},
) => {
  const auth = options.auth ?? createAuth();
  const app = Fastify({ logger: false });
  apps.push(app);
  registerOperatorAuthRoutes(app, auth);
  registerConfigurationAuditRoutes(app, {
    database: options.database ?? createDatabase().database,
    operatorAuth: auth,
    readOnly: options.readOnly ?? false,
  });
  return { app, auth };
};
const cookieHeaders = () => ({ cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}` });
const expectNoStore = (response: { readonly headers: Record<string, unknown> }): void => {
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers.vary).toBe("Cookie");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("configuration audit authorization", () => {
  it.each(readRoutes)("requires an operator session for $name", async (route) => {
    const { database, transport } = createDatabase();
    const { app } = createApp({ database, auth: createAuth(false) });
    const response = await app.inject({ method: "GET", url: route.url, headers: cookieHeaders() });

    expect(response.statusCode).toBe(401);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "operator_authentication_required" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(readRoutes)(
    "reads $name through the operator scope during maintenance",
    async (route) => {
      const { database, request, transport } = createDatabase();
      const { app } = createApp({ database, readOnly: true });
      const response = await app.inject({
        method: "GET",
        url: route.url,
        headers: cookieHeaders(),
      });

      expect(response.statusCode).toBe(200);
      expectNoStore(response);
      expect(response.json()).toEqual(route.output);
      expect(request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
      expect(transport).toHaveBeenCalledExactlyOnceWith("operatorRequest", {
        context: { kind: "operator", actor },
        operation: route.operation,
        input: route.input,
      });
    },
  );

  it("does not accept a bearer token as an operator session", async () => {
    const { database, transport } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: globalPath,
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    expect(response.statusCode).toBe(401);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "repository read denial",
      url: repositoryPath,
      code: "PLATFORM_NOT_FOUND",
      status: 404,
    },
    {
      name: "global administrator denial",
      url: globalPath,
      code: "PLATFORM_FORBIDDEN",
      status: 403,
    },
  ])("does not expose audit data after a $name", async ({ url, code, status }) => {
    const { database } = createDatabase(async () => {
      throw new DatabaseRequestError(privateValue, code);
    });
    const { app } = createApp({ database });
    const response = await app.inject({ method: "GET", url, headers: cookieHeaders() });

    expect(response.statusCode).toBe(status);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: code.toLowerCase(), retryable: false });
    expect(response.body).not.toContain(privateValue);
  });

  it("does not register audit mutations", async () => {
    const { database, transport } = createDatabase();
    const { app } = createApp({ database });
    for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
      for (const route of readRoutes) {
        const response = await app.inject({ method, url: route.url, headers: cookieHeaders() });
        expect(response.statusCode).toBe(404);
      }
    }
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("configuration audit request validation", () => {
  it.each(readRoutes)(
    "rejects unknown query fields for $name before database access",
    async (route) => {
      const { database, transport } = createDatabase();
      const { app } = createApp({ database });
      const response = await app.inject({
        method: "GET",
        url: `${route.url}?unknown=value`,
        headers: cookieHeaders(),
      });

      expect(response.statusCode).toBe(400);
      expectNoStore(response);
      expect(response.json()).toMatchObject({ code: "configuration_query_invalid" });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each([
    `${repositoryPath}?pageSize=21`,
    `${globalPath}?pageSize=21`,
    `${repositoryPath}?page=10000001`,
    `${globalPath}?page=0`,
    `${globalPath}?page=01`,
    `${globalPath}?pageSize=1&pageSize=2`,
    `${globalPath}?templateId=${templateId}&templateId=${templateId}`,
    `${repositoryPath}?templateId=${templateId}`,
    `${repositoryEventPath}?page=1`,
    `${globalEventPath}?templateId=${templateId}`,
    `${repositoryPath}/unknown/${eventId}`,
  ])("rejects the unsupported query or source %s", async (url) => {
    const { database, transport } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({ method: "GET", url, headers: cookieHeaders() });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "configuration_query_invalid" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    "/api/v1/operator/repositories/invalid%2Fid/configuration-audit",
    `${repositoryPath}/repository/invalid%2Fid`,
    `${globalPath}/invalid%2Fid`,
    `${globalPath}?templateId=invalid%2Fid`,
  ])("rejects malformed scope identifiers at %s", async (url) => {
    const { database, transport } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({ method: "GET", url, headers: cookieHeaders() });

    expect(response.statusCode).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  });

  it("forwards the maximum page size and preserves an empty page beyond the final event", async () => {
    const output = repositoryPage([], 2, 20, 2);
    const { database, request } = createDatabase(async () => output);
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: `${repositoryPath}?page=2&pageSize=20`,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
    expect(request).toHaveBeenCalledExactlyOnceWith("listRepositoryConfigurationAudit", {
      repositoryId,
      page: 2,
      pageSize: 20,
    });
  });
});

describe("configuration audit response scope", () => {
  it("serves a global list before any route has initialized date formats", async () => {
    const previousFormat = FormatRegistry.Get("date-time");
    FormatRegistry.Delete("date-time");
    try {
      const { app } = createApp();
      const response = await app.inject({
        method: "GET",
        url: globalPath,
        headers: cookieHeaders(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(page([templateSummary]));
    } finally {
      if (previousFormat === undefined) FormatRegistry.Delete("date-time");
      else FormatRegistry.Set("date-time", previousFormat);
    }
  });

  it("distinguishes repository and prompt events that have the same event ID", async () => {
    const { database, request } = createDatabase(async () => promptEvent);
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: `${repositoryPath}/prompt/${eventId}`,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(promptEvent);
    expect(request).toHaveBeenCalledExactlyOnceWith("getRepositoryConfigurationAudit", {
      repositoryId,
      source: "prompt",
      eventId,
    });
  });

  it("retains global binding and bootstrap identities when filtering by template", async () => {
    const output = {
      templateId,
      ...page([bootstrapSummary, globalBindingSummary, templateSummary]),
    };
    const { database, request } = createDatabase(async () => output);
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: `${globalPath}?templateId=${templateId}`,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
    expect(request).toHaveBeenCalledExactlyOnceWith("listGlobalConfigurationAudit", {
      templateId,
      page: 1,
      pageSize: 20,
    });
  });

  it.each([repositoryEventPath, `${repositoryPath}/prompt/${eventId}`, globalEventPath])(
    "returns not found for a missing event in its requested scope: %s",
    async (url) => {
      const { database } = createDatabase(async () => null);
      const { app } = createApp({ database });
      const response = await app.inject({ method: "GET", url, headers: cookieHeaders() });

      expect(response.statusCode).toBe(404);
      expectNoStore(response);
      expect(response.json()).toMatchObject({ code: "configuration_audit_not_found" });
    },
  );

  it.each([
    {
      name: "different event ID",
      url: repositoryEventPath,
      output: { ...repositoryEvent, id: "other-event" },
    },
    { name: "different event source", url: repositoryEventPath, output: promptEvent },
    {
      name: "different repository scope",
      url: repositoryEventPath,
      output: { ...repositoryEvent, repositoryId: "other-repository" },
    },
    { name: "repository event in global scope", url: globalEventPath, output: repositoryEvent },
    {
      name: "repository entity mismatch",
      url: repositoryEventPath,
      output: { ...repositoryEvent, entityId: "other-repository" },
    },
    {
      name: "repository snapshot identity mismatch",
      url: repositoryEventPath,
      output: { ...repositoryEvent, snapshot: { ...repository, id: "other-repository" } },
    },
    {
      name: "repository snapshot revision mismatch",
      url: repositoryEventPath,
      output: { ...repositoryEvent, snapshot: { ...repository, version: 2 } },
    },
    {
      name: "prompt snapshot revision mismatch",
      url: `${repositoryPath}/prompt/${eventId}`,
      output: { ...promptEvent, snapshot: { ...promptEvent.snapshot, version: 2 } },
    },
    {
      name: "different repository page",
      url: repositoryPath,
      output: { ...repositoryPage(), repositoryId: "other-repository" },
    },
    {
      name: "global row in a repository page",
      url: repositoryPath,
      output: repositoryPage([templateSummary]),
    },
    { name: "repository row in a global page", url: globalPath, output: page([promptSummary]) },
    {
      name: "repository row entity mismatch",
      url: repositoryPath,
      output: repositoryPage([{ ...repositorySummary, entityId: "other-repository" }]),
    },
    {
      name: "missing requested template scope",
      url: `${globalPath}?templateId=${templateId}`,
      output: page([templateSummary]),
    },
    {
      name: "unrequested template scope",
      url: globalPath,
      output: { templateId, ...page([templateSummary]) },
    },
    {
      name: "different template event in a filtered page",
      url: `${globalPath}?templateId=${templateId}`,
      output: { templateId, ...page([{ ...templateSummary, entityId: "other-template" }]) },
    },
  ])("rejects a $name", async ({ url, output }) => {
    const { database } = createDatabase(async () => output);
    const { app } = createApp({ database });
    const response = await app.inject({ method: "GET", url, headers: cookieHeaders() });

    expect(response.statusCode).toBe(502);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_audit_response_invalid" });
  });
});

describe("configuration audit response integrity", () => {
  it.each([
    { name: "malformed detail", url: globalEventPath, output: { privateValue } },
    {
      name: "unrecognized historical snapshot field",
      url: globalEventPath,
      output: { ...templateEvent, snapshot: { ...templateEvent.snapshot, content: privateValue } },
    },
    {
      name: "snapshot embedded in a list summary",
      url: repositoryPath,
      output: repositoryPage([
        { ...repositorySummary, snapshot: repository } as ConfigurationAuditSummary,
      ]),
    },
    {
      name: "unrecognized list envelope field",
      url: globalPath,
      output: { ...page([templateSummary]), privateValue },
    },
    { name: "incorrect page number", url: repositoryPath, output: repositoryPage([], 2, 20, 2) },
    { name: "incorrect page size", url: globalPath, output: page([templateSummary], 1, 1) },
    {
      name: "too many items for the requested page",
      url: `${repositoryPath}?pageSize=1`,
      output: repositoryPage([promptSummary, repositorySummary], 1, 1),
    },
    {
      name: "incomplete page despite a larger total",
      url: repositoryPath,
      output: repositoryPage([repositorySummary], 1, 20, 2),
    },
    { name: "negative total", url: globalPath, output: page([], 1, 20, -1) },
    {
      name: "duplicate source and event ID",
      url: repositoryPath,
      output: repositoryPage([repositorySummary, repositorySummary]),
    },
    {
      name: "ascending timestamps",
      url: repositoryPath,
      output: repositoryPage([
        { ...repositorySummary, createdAt: "2026-09-06T00:00:00.000Z" },
        promptSummary,
      ]),
    },
    {
      name: "descending sources at a timestamp tie",
      url: repositoryPath,
      output: repositoryPage([repositorySummary, promptSummary]),
    },
    {
      name: "ascending event IDs at a source and timestamp tie",
      url: repositoryPath,
      output: repositoryPage([repositorySummary, { ...repositorySummary, id: "audit-2" }]),
    },
  ])("rejects $name without exposing database content", async ({ url, output }) => {
    const { database } = createDatabase(async () => output);
    const { app } = createApp({ database });
    const response = await app.inject({ method: "GET", url, headers: cookieHeaders() });

    expect(response.statusCode).toBe(502);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_audit_response_invalid" });
    expect(response.body).not.toContain(privateValue);
  });

  it("preserves descending event IDs within timestamp and source ties", async () => {
    const output = repositoryPage([
      { ...promptSummary, id: "audit-2" },
      promptSummary,
      { ...repositorySummary, id: "audit-2" },
      repositorySummary,
    ]);
    const { database } = createDatabase(async () => output);
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: repositoryPath,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
  });

  it("rejects an audit response exceeding two MiB before returning its contents", async () => {
    // Fractional seconds have no schema length limit, even though normal storage uses milliseconds.
    const createdAt = `2026-09-07T00:00:00.${"0".repeat(maximumConfigurationAuditResponseUtf8Bytes)}Z`;
    const output = page([{ ...templateSummary, createdAt }]);
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeGreaterThan(
      maximumConfigurationAuditResponseUtf8Bytes,
    );
    const { database } = createDatabase(async () => output);
    const { app } = createApp({ database });
    const response = await app.inject({ method: "GET", url: globalPath, headers: cookieHeaders() });

    expect(response.statusCode).toBe(502);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_audit_response_invalid" });
    expect(response.body.length).toBeLessThan(1_024);
  });
});
