import type {
  GitHubRepository,
  ManagedRepository,
  ManagedRepositorySummary,
  RepositoryCreateRequest,
  RepositoryUpdateRequest,
} from "@agentic-review/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import {
  RepositoryConnectionError,
  type RepositoryConnectionErrorCode,
} from "../github/repository-connection.js";
import type { OperatorSession } from "../security/operator-auth.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";
import { registerRepositoryRoutes } from "./repositories.js";

const publicOrigin = "https://review.example.com";
const sessionToken = "S".repeat(43);
const timestamp = "2026-09-07T00:00:00.000Z";
const repositoryId = "repository-1";
const repositoriesPath = "/api/v1/operator/repositories";
const repositoryPath = `${repositoriesPath}/${repositoryId}`;
const checkPath = `${repositoryPath}/check-connection`;
const rawFailure = "upstream-body-secret github_pat_private_database_password";
const session: OperatorSession = {
  issuer: "https://identity.example.com",
  subject: "ordinary-user-123",
  displayName: "Ordinary User",
  email: "user@example.com",
  createdAt: timestamp,
  expiresAt: "2026-09-07T01:00:00.000Z",
};
const actor = { issuer: session.issuer, subject: session.subject };
const metadata: GitHubRepository = {
  githubRepositoryId: 123,
  githubNodeId: "R_123",
  ownerLogin: "microsoft",
  name: "PowerToys",
  fullName: "microsoft/PowerToys",
  htmlUrl: "https://github.com/microsoft/PowerToys",
  defaultBranch: "main",
  isPrivate: false,
};
const repositorySummary: ManagedRepositorySummary = {
  id: repositoryId,
  githubRepositoryId: metadata.githubRepositoryId,
  fullName: metadata.fullName,
  enabled: false,
  version: 1,
  reviewerGithubUserId: null,
  reviewerGithubLogin: null,
  schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
  connectionStatus: "unknown",
  connectionMessage: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const repository: ManagedRepository = { ...repositorySummary, authorizationPolicy: null };
const createRequest: RepositoryCreateRequest = {
  githubRepositoryId: metadata.githubRepositoryId,
  fullName: metadata.fullName,
  enabled: false,
};
const updateRequest: RepositoryUpdateRequest = { expectedVersion: 1, enabled: true };
const updatedRepository: ManagedRepository = { ...repository, enabled: true, version: 2 };
const readyMessage = "GitHub repository metadata is accessible.";
const readyRepository: ManagedRepository = {
  ...repository,
  connectionStatus: "ready",
  connectionMessage: readyMessage,
};

interface RouteCase {
  readonly name: string;
  readonly method: "GET" | "POST" | "PATCH";
  readonly url: string;
  readonly payload?: object;
}

const readRoutes: readonly RouteCase[] = [
  { name: "list", method: "GET", url: repositoriesPath },
  { name: "detail", method: "GET", url: repositoryPath },
];
const mutationRoutes: readonly RouteCase[] = [
  {
    name: "resolve",
    method: "POST",
    url: `${repositoriesPath}/resolve`,
    payload: { fullName: metadata.fullName },
  },
  { name: "create", method: "POST", url: repositoriesPath, payload: createRequest },
  { name: "update", method: "PATCH", url: repositoryPath, payload: updateRequest },
  { name: "check", method: "POST", url: checkPath, payload: {} },
];
const allRoutes = [...readRoutes, ...mutationRoutes];

const createAuth = (authenticated = true): OperatorAuthRouteService => ({
  publicOrigin,
  postLoginRedirectPath: "/",
  requiresLoopbackRequest: false,
  secureCookies: true,
  usesBrowserBinding: false,
  ensureBrowserBinding: vi.fn(() => undefined),
  startLogin: vi.fn(async () => ({ kind: "session" as const, sessionToken, session })),
  completeLogin: vi.fn(async () => {
    throw new Error("Not used by repository route tests.");
  }),
  getSession: vi.fn(async (token) => (authenticated && token === sessionToken ? session : null)),
  logout: vi.fn(async () => undefined),
});

const createDatabase = (
  implementation?: (operation: string, input: unknown) => Promise<unknown>,
) => {
  return createOperatorRouteTestDatabase(
    actor,
    implementation ??
      (async (operation: string) => {
        switch (operation) {
          case "listManagedRepositories":
            return { items: [repositorySummary], total: 1 };
          case "getManagedRepository":
            return repository;
          case "createManagedRepository":
            return repository;
          case "updateManagedRepository":
            return updatedRepository;
          case "updateRepositoryConnection":
            return readyRepository;
          default:
            throw new Error(`Unexpected operation: ${operation}`);
        }
      }),
  );
};

const apps: FastifyInstance[] = [];
const createApp = (
  options: {
    readonly auth?: OperatorAuthRouteService;
    readonly database?: DatabaseClient;
    readonly readOnly?: boolean;
    readonly resolveRepository?: (
      fullName: string,
      expectedId?: number,
    ) => Promise<GitHubRepository>;
    readonly connectionUnavailable?: boolean;
  } = {},
) => {
  const auth = options.auth ?? createAuth();
  const database = options.database ?? createDatabase().database;
  const resolveRepository = options.resolveRepository ?? vi.fn(async () => metadata);
  const app = Fastify({ logger: false });
  apps.push(app);
  registerOperatorAuthRoutes(app, auth);
  registerRepositoryRoutes(app, {
    database,
    operatorAuth: auth,
    readOnly: options.readOnly ?? false,
    ...(options.connectionUnavailable ? {} : { resolveRepository }),
  });
  return { app, auth, resolveRepository };
};
const cookieHeaders = () => ({ cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}` });
const authenticatedHeaders = () => ({ ...cookieHeaders(), origin: publicOrigin });
const expectNoStore = (response: { readonly headers: Record<string, unknown> }): void => {
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers.vary).toBe("Cookie");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("operator repository authorization", () => {
  it.each(mutationRoutes.filter((route) => route.name !== "update"))(
    "checks permission before the $name GitHub probe",
    async (route) => {
      const { database, request, permissions, transport } = createDatabase();
      permissions.mockRejectedValue(
        new DatabaseRequestError(
          "The operator cannot configure this repository.",
          "PLATFORM_FORBIDDEN",
        ),
      );
      const { app, resolveRepository } = createApp({ database });
      const response = await app.inject({ ...route, headers: authenticatedHeaders() });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "platform_forbidden", retryable: false });
      expect(request).not.toHaveBeenCalled();
      expect(resolveRepository).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledExactlyOnceWith("operatorRequest", {
        context: { kind: "operator", actor },
        operation: "operatorCheckPermission",
        input: route.name === "check" ? { repositoryId, permission: "configure" } : {},
      });
    },
  );

  it("rechecks platform permission before returning resolved metadata after a revocation", async () => {
    const { database, request, permissions } = createDatabase();
    const { app } = createApp({
      database,
      resolveRepository: async () => {
        permissions.mockRejectedValue(
          new DatabaseRequestError("The operator permission was revoked.", "PLATFORM_FORBIDDEN"),
        );
        return metadata;
      },
    });
    const response = await app.inject({
      method: "POST",
      url: `${repositoriesPath}/resolve`,
      payload: { fullName: metadata.fullName },
      headers: authenticatedHeaders(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(metadata.htmlUrl);
    expect(permissions).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["create", "check", "failed-check"] as const)(
    "uses current permission at the %s write after an awaited GitHub response",
    async (name) => {
      let revoked = false;
      const { database, request, transport } = createDatabase(async (operation) => {
        if (operation === "getManagedRepository") return repository;
        if (revoked)
          throw new DatabaseRequestError(
            "The operator permission was revoked.",
            "PLATFORM_FORBIDDEN",
          );
        throw new Error("A mutation must follow the permission change in this fixture.");
      });
      const { app } = createApp({
        database,
        resolveRepository: async () => {
          await Promise.resolve();
          revoked = true;
          if (name === "failed-check") throw new Error("Private upstream token details.");
          return metadata;
        },
      });
      const response = await app.inject({
        method: "POST",
        url: name === "create" ? repositoriesPath : checkPath,
        payload: name === "create" ? createRequest : {},
        headers: authenticatedHeaders(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain("Private upstream");
      const operation =
        name === "create" ? "createManagedRepository" : "updateRepositoryConnection";
      expect(request).toHaveBeenLastCalledWith(operation, expect.any(Object));
      expect(transport).toHaveBeenLastCalledWith("operatorRequest", {
        context: { kind: "operator", actor },
        operation,
        input: expect.any(Object),
      });
    },
  );

  it("forwards a repository read denial without treating login as repository access", async () => {
    const { database, transport } = createDatabase(async () => {
      throw new DatabaseRequestError("The repository was not found.", "PLATFORM_NOT_FOUND");
    });
    const { app, resolveRepository } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: repositoryPath,
      headers: cookieHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(metadata.fullName);
    expect(resolveRepository).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledExactlyOnceWith("operatorRequest", {
      context: { kind: "operator", actor },
      operation: "getManagedRepository",
      input: { repositoryId },
    });
  });

  it.each(allRoutes)("requires a session for $name", async (route) => {
    const { database, request } = createDatabase();
    const { app, resolveRepository } = createApp({ auth: createAuth(false), database });
    const response = await app.inject({ ...route, headers: authenticatedHeaders() });

    expect(response.statusCode).toBe(401);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "operator_authentication_required" });
    expect(request).not.toHaveBeenCalled();
    expect(resolveRepository).not.toHaveBeenCalled();
  });

  const rejectedOrigins: readonly { name: string; origin?: string | string[] }[] = [
    { name: "missing" },
    { name: "different", origin: "https://attacker.example.com" },
    { name: "trailing slash", origin: `${publicOrigin}/` },
    { name: "case changed", origin: "https://REVIEW.example.com" },
    { name: "default port", origin: "https://review.example.com:443" },
    { name: "null", origin: "null" },
    { name: "repeated", origin: [publicOrigin, publicOrigin] },
  ];
  it.each(
    mutationRoutes.flatMap((route) =>
      rejectedOrigins.map((entry) => ({
        ...route,
        originName: entry.name,
        origin: entry.origin,
      })),
    ),
  )("rejects $originName Origin for $name before session lookup", async (route) => {
    const { database, request } = createDatabase();
    const { app, auth, resolveRepository } = createApp({ database });
    const response = await app.inject({
      method: route.method,
      url: route.url,
      ...(route.payload === undefined ? {} : { payload: route.payload }),
      headers: {
        ...cookieHeaders(),
        ...(route.origin === undefined ? {} : { origin: route.origin }),
      } as Record<string, string | string[]>,
    });

    expect(response.statusCode).toBe(403);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "invalid_operator_auth_origin" });
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(resolveRepository).not.toHaveBeenCalled();
  });

  it.each(mutationRoutes)("blocks $name during recovery maintenance", async (route) => {
    const { database, request } = createDatabase();
    const { app, resolveRepository } = createApp({ database, readOnly: true });
    const response = await app.inject({ ...route, headers: authenticatedHeaders() });

    expect(response.statusCode).toBe(503);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_read_only" });
    expect(request).not.toHaveBeenCalled();
    expect(resolveRepository).not.toHaveBeenCalled();
  });

  it.each(readRoutes)(
    "allows $name with the session cookie during recovery maintenance",
    async (route) => {
      const { app, auth } = createApp({ readOnly: true });
      const response = await app.inject({ ...route, headers: cookieHeaders() });

      expect(response.statusCode).toBe(200);
      expectNoStore(response);
      expect(auth.getSession).toHaveBeenCalledWith(sessionToken, undefined);
    },
  );

  it("does not accept a bearer token instead of the operator session cookie", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: repositoriesPath,
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    expect(response.statusCode).toBe(401);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("operator repository request validation", () => {
  it.each(allRoutes)("rejects unknown query fields for $name", async (route) => {
    const { database, request } = createDatabase();
    const { app, resolveRepository } = createApp({ database });
    const response = await app.inject({
      ...route,
      url: `${route.url}?unknown=value`,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_query_invalid" });
    expect(request).not.toHaveBeenCalled();
    expect(resolveRepository).not.toHaveBeenCalled();
  });

  it.each([
    "page=0",
    "page=01",
    "page=-1",
    "page=1.5",
    "page=1e2",
    "page=9007199254740992",
    "page=9007199254740991&pageSize=50",
    "pageSize=0",
    "pageSize=51",
    "pageSize=1&pageSize=2",
    "page=1&page=1",
    "enabled=1",
    "enabled=True",
    "enabled=true&enabled=false",
    "search=first&search=second",
    `search=${"x".repeat(513)}`,
  ])("rejects the list query %s before database access", async (query) => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: `${repositoriesPath}?${query}`,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "configuration_query_invalid" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(
    [
      { name: "detail", method: "GET" as const, suffix: "" },
      { name: "update", method: "PATCH" as const, suffix: "", payload: updateRequest },
      { name: "check", method: "POST" as const, suffix: "/check-connection", payload: {} },
    ].flatMap((route) =>
      ["%20invalid", "invalid%2Fid", "x".repeat(129), "invalid%00id"].map((id) => ({
        ...route,
        id,
      })),
    ),
  )("rejects invalid repository IDs for $name: $id", async (route) => {
    const { database, request } = createDatabase();
    const { app, resolveRepository } = createApp({ database });
    const response = await app.inject({
      method: route.method,
      url: `${repositoriesPath}/${route.id}${route.suffix}`,
      ...("payload" in route && route.payload !== undefined ? { payload: route.payload } : {}),
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(route.id.length > 128 ? 414 : 400);
    expect(request).not.toHaveBeenCalled();
    expect(resolveRepository).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "resolve a URL",
      method: "POST" as const,
      url: `${repositoriesPath}/resolve`,
      payload: { fullName: metadata.htmlUrl },
    },
    {
      name: "resolve with an extra identity",
      method: "POST" as const,
      url: `${repositoriesPath}/resolve`,
      payload: createRequest,
    },
    {
      name: "create without a GitHub ID",
      method: "POST" as const,
      url: repositoriesPath,
      payload: { fullName: metadata.fullName },
    },
    {
      name: "create with a fractional GitHub ID",
      method: "POST" as const,
      url: repositoriesPath,
      payload: { ...createRequest, githubRepositoryId: 1.5 },
    },
    {
      name: "update without a version",
      method: "PATCH" as const,
      url: repositoryPath,
      payload: { enabled: true },
    },
    {
      name: "update without a change",
      method: "PATCH" as const,
      url: repositoryPath,
      payload: { expectedVersion: 1 },
    },
    {
      name: "update a server-owned identity",
      method: "PATCH" as const,
      url: repositoryPath,
      payload: { ...updateRequest, githubRepositoryId: 999 },
    },
    {
      name: "update server-owned health",
      method: "PATCH" as const,
      url: repositoryPath,
      payload: { ...updateRequest, connectionStatus: "ready" },
    },
    {
      name: "check with an extra field",
      method: "POST" as const,
      url: checkPath,
      payload: { fullName: "attacker/repository" },
    },
    ...mutationRoutes.map((route) => ({
      ...route,
      name: `${route.name} with an injected actor`,
      payload: { ...route.payload, actor: { issuer: "attacker", subject: "admin" } },
    })),
  ])("rejects $name before resolving or writing", async (route) => {
    const { database, request } = createDatabase();
    const { app, resolveRepository } = createApp({ database });
    const response = await app.inject({ ...route, headers: authenticatedHeaders() });

    expect(response.statusCode).toBe(400);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_request_invalid" });
    expect(request).not.toHaveBeenCalled();
    expect(resolveRepository).not.toHaveBeenCalled();
  });
});

describe("operator repository operations", () => {
  it("lists repository summaries with normalized pagination and filters", async () => {
    const { database, request } = createDatabase();
    request.mockResolvedValueOnce({ items: [repositorySummary], total: 6 });
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: `${repositoriesPath}?page=2&pageSize=5&search=microsoft%2F&enabled=false`,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expectNoStore(response);
    expect(response.json()).toEqual({ items: [repositorySummary], total: 6 });
    expect(request).toHaveBeenCalledExactlyOnceWith("listManagedRepositories", {
      page: 2,
      pageSize: 5,
      search: "microsoft/",
      enabled: false,
    });
  });

  it("uses bounded defaults when listing repositories", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: repositoriesPath,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(request).toHaveBeenCalledExactlyOnceWith("listManagedRepositories", {
      page: 1,
      pageSize: 20,
    });
  });

  it("resolves GitHub metadata without writing configuration", async () => {
    const { database, request } = createDatabase();
    const { app, resolveRepository } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: `${repositoriesPath}/resolve`,
      payload: { fullName: metadata.fullName },
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expectNoStore(response);
    expect(response.json()).toEqual(metadata);
    expect(resolveRepository).toHaveBeenCalledExactlyOnceWith(metadata.fullName, undefined);
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves identity before creating with canonical metadata and the session actor", async () => {
    const order: string[] = [];
    const { database, request } = createDatabase(async () => {
      order.push("create");
      return repository;
    });
    const resolveRepository = vi.fn(async () => {
      order.push("resolve");
      expect(request).not.toHaveBeenCalled();
      return metadata;
    });
    const { app } = createApp({ database, resolveRepository });
    const input = { ...createRequest, fullName: "old-owner/old-name" };
    const response = await app.inject({
      method: "POST",
      url: repositoriesPath,
      payload: input,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(201);
    expectNoStore(response);
    expect(response.json()).toEqual(repository);
    expect(order).toEqual(["resolve", "create"]);
    expect(resolveRepository).toHaveBeenCalledExactlyOnceWith(
      input.fullName,
      input.githubRepositoryId,
    );
    expect(request).toHaveBeenCalledExactlyOnceWith("createManagedRepository", {
      request: createRequest,
      metadata,
      actor,
    });
  });

  it("reads repository detail in the requested repository scope", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: repositoryPath,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(repository);
    expect(request).toHaveBeenCalledExactlyOnceWith("getManagedRepository", { repositoryId });
  });

  it("updates with the expected version and the authenticated actor", async () => {
    const { database, request } = createDatabase();
    const { app, resolveRepository } = createApp({ database });
    const response = await app.inject({
      method: "PATCH",
      url: repositoryPath,
      payload: updateRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expectNoStore(response);
    expect(response.json()).toEqual(updatedRepository);
    expect(request).toHaveBeenCalledExactlyOnceWith("updateManagedRepository", {
      repositoryId,
      request: updateRequest,
      actor,
    });
    expect(resolveRepository).not.toHaveBeenCalled();
  });

  it("preserves a compare-and-swap conflict without retrying the update", async () => {
    const { database, request } = createDatabase(async () => {
      throw new DatabaseRequestError(
        "Repository settings changed. Reload before saving.",
        "PLATFORM_CONFLICT",
      );
    });
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "PATCH",
      url: repositoryPath,
      payload: updateRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(409);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "platform_conflict", retryable: false });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([repositoryPath, checkPath])(
    "returns 404 for a missing repository at %s",
    async (url) => {
      const { database, request } = createDatabase(async () => null);
      const { app, resolveRepository } = createApp({ database });
      const response = await app.inject({
        method: url === checkPath ? "POST" : "GET",
        url,
        headers: authenticatedHeaders(),
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "platform_not_found" });
      expect(request).toHaveBeenCalledExactlyOnceWith("getManagedRepository", { repositoryId });
      expect(resolveRepository).not.toHaveBeenCalled();
    },
  );
});

describe("operator repository response boundaries", () => {
  it.each([
    {
      name: "list details instead of summaries",
      url: repositoriesPath,
      method: "GET" as const,
      output: { items: [repository], total: 1 },
    },
    {
      name: "list page larger than requested",
      url: `${repositoriesPath}?pageSize=1`,
      method: "GET" as const,
      output: {
        items: [repositorySummary, { ...repositorySummary, id: "repository-2" }],
        total: 2,
      },
    },
    {
      name: "list with unknown response fields",
      url: repositoriesPath,
      method: "GET" as const,
      output: { items: [], total: 0, internal: rawFailure },
    },
    {
      name: "detail outside repository scope",
      url: repositoryPath,
      method: "GET" as const,
      output: { ...repository, id: "repository-2" },
    },
    {
      name: "detail with unknown response fields",
      url: repositoryPath,
      method: "GET" as const,
      output: { ...repository, internal: rawFailure },
    },
    {
      name: "create with another GitHub identity",
      url: repositoriesPath,
      method: "POST" as const,
      payload: createRequest,
      output: { ...repository, githubRepositoryId: 999 },
    },
    {
      name: "create with another canonical name",
      url: repositoriesPath,
      method: "POST" as const,
      payload: createRequest,
      output: { ...repository, fullName: "another/repository" },
    },
    {
      name: "update outside repository scope",
      url: repositoryPath,
      method: "PATCH" as const,
      payload: updateRequest,
      output: { ...updatedRepository, id: "repository-2" },
    },
    {
      name: "update without advancing the version",
      url: repositoryPath,
      method: "PATCH" as const,
      payload: updateRequest,
      output: repository,
    },
    {
      name: "update with an unexpected version jump",
      url: repositoryPath,
      method: "PATCH" as const,
      payload: updateRequest,
      output: { ...updatedRepository, version: 3 },
    },
  ])("withholds $name", async (route) => {
    const { database } = createDatabase(async () => route.output);
    const { app } = createApp({ database });
    const response = await app.inject({
      method: route.method,
      url: route.url,
      ...("payload" in route && route.payload !== undefined ? { payload: route.payload } : {}),
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(502);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_response_invalid" });
    expect(response.body).not.toContain(rawFailure);
  });

  it.each([
    { name: "a different numeric identity", value: { ...metadata, githubRepositoryId: 999 } },
    { name: "an inconsistent owner", value: { ...metadata, ownerLogin: "attacker" } },
    { name: "an inconsistent repository name", value: { ...metadata, name: "other" } },
    {
      name: "a noncanonical URL",
      value: { ...metadata, htmlUrl: "https://attacker.example.com/repository" },
    },
    { name: "an unknown metadata field", value: { ...metadata, upstreamBody: rawFailure } },
    { name: "an invalid default branch", value: { ...metadata, defaultBranch: "" } },
  ])("rejects resolver metadata containing $name before creating", async ({ value }) => {
    const { database, request } = createDatabase();
    const resolveRepository = vi.fn(async () => value);
    const { app } = createApp({ database, resolveRepository });
    const response = await app.inject({
      method: "POST",
      url: repositoriesPath,
      payload: createRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(502);
    expectNoStore(response);
    expect(response.body).not.toContain(rawFailure);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not return malformed metadata from the resolve route", async () => {
    const { app } = createApp({
      resolveRepository: vi.fn(async () => ({ ...metadata, githubNodeId: "" })),
    });
    const response = await app.inject({
      method: "POST",
      url: `${repositoriesPath}/resolve`,
      payload: { fullName: metadata.fullName },
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(502);
    expectNoStore(response);
  });
});

describe("operator repository connection failures", () => {
  const resolverErrors: readonly { code: RepositoryConnectionErrorCode; status: number }[] = [
    { code: "repository_not_accessible", status: 404 },
    { code: "repository_identity_changed", status: 409 },
    { code: "repository_response_invalid", status: 502 },
    { code: "repository_upstream_unavailable", status: 503 },
    { code: "repository_connection_timeout", status: 503 },
    { code: "repository_connection_cancelled", status: 503 },
  ];
  it.each(
    mutationRoutes
      .filter((route) => ["resolve", "create"].includes(route.name))
      .flatMap((route) => resolverErrors.map((error) => ({ ...route, ...error }))),
  )("returns the safe $code error for $name", async (route) => {
    const error = new RepositoryConnectionError(route.code);
    Object.assign(error, { cause: new Error(rawFailure), body: rawFailure });
    const { database, request } = createDatabase();
    const { app } = createApp({
      database,
      resolveRepository: vi.fn(async () => {
        throw error;
      }),
    });
    const response = await app.inject({
      method: route.method,
      url: route.url,
      ...(route.payload === undefined ? {} : { payload: route.payload }),
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(route.status);
    expectNoStore(response);
    expect(response.json()).toEqual({
      code: route.code,
      message: error.message,
      retryable: route.status >= 500,
    });
    expect(response.body).not.toContain(rawFailure);
    expect(request).not.toHaveBeenCalled();
  });

  it("reports an unavailable resolver without writing a repository", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database, connectionUnavailable: true });
    const response = await app.inject({
      method: "POST",
      url: repositoriesPath,
      payload: createRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "repository_connection_unavailable" });
    expect(request).not.toHaveBeenCalled();
  });

  it("withholds arbitrary resolver errors and raw upstream bodies", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp({
      database,
      resolveRepository: vi.fn(async () => {
        throw new Error(rawFailure);
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: repositoriesPath,
      payload: createRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "configuration_operation_failed" });
    expect(response.body).not.toContain(rawFailure);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([false, true])("persists accessible metadata with private=%s", async (isPrivate) => {
    const resolved = { ...metadata, isPrivate };
    const message = isPrivate
      ? "GitHub metadata is accessible. Private checkout requires a repository credential binding."
      : readyMessage;
    const result = { ...readyRepository, connectionMessage: message };
    const { database, request } = createDatabase(async (operation) =>
      operation === "getManagedRepository" ? repository : result,
    );
    const resolveRepository = vi.fn(async () => resolved);
    const { app } = createApp({ database, resolveRepository });
    const response = await app.inject({
      method: "POST",
      url: checkPath,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expectNoStore(response);
    expect(response.json()).toEqual(result);
    expect(resolveRepository).toHaveBeenCalledExactlyOnceWith(
      repository.fullName,
      repository.githubRepositoryId,
    );
    expect(request.mock.calls).toEqual([
      ["getManagedRepository", { repositoryId }],
      [
        "updateRepositoryConnection",
        { repositoryId, status: "ready", message, metadata: resolved },
      ],
    ]);
  });

  it.each([
    {
      name: "a typed resolver error",
      error: Object.assign(new RepositoryConnectionError("repository_not_accessible"), {
        cause: new Error(rawFailure),
        body: rawFailure,
      }),
    },
    { name: "an arbitrary upstream failure", error: new Error(rawFailure) },
  ])("persists a safe connection failure for $name", async ({ error }) => {
    const message =
      error instanceof RepositoryConnectionError
        ? error.message
        : "The GitHub repository could not be reached.";
    const result = { ...repository, connectionStatus: "error", connectionMessage: message };
    const { database, request } = createDatabase(async (operation) =>
      operation === "getManagedRepository" ? repository : result,
    );
    const { app } = createApp({
      database,
      resolveRepository: vi.fn(async () => {
        throw error;
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: checkPath,
      payload: {},
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expectNoStore(response);
    expect(response.json()).toEqual(result);
    expect(request.mock.calls).toEqual([
      ["getManagedRepository", { repositoryId }],
      ["updateRepositoryConnection", { repositoryId, status: "error", message }],
    ]);
    expect(JSON.stringify(request.mock.calls)).not.toContain(rawFailure);
    expect(response.body).not.toContain(rawFailure);
  });

  it("sanitizes storage failures while persisting an unsuccessful connection check", async () => {
    const { database, request } = createDatabase(async (operation) => {
      if (operation === "getManagedRepository") return repository;
      throw new DatabaseRequestError(rawFailure);
    });
    const { app } = createApp({
      database,
      resolveRepository: vi.fn(async () => {
        throw new Error(rawFailure);
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: checkPath,
      payload: {},
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(500);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_operation_failed" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(response.body).not.toContain(rawFailure);
  });

  it("rejects a connection lookup outside the requested repository before resolving", async () => {
    const { database, request } = createDatabase(async () => ({
      ...repository,
      id: "repository-2",
    }));
    const { app, resolveRepository } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: checkPath,
      payload: {},
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: "configuration_response_invalid" });
    expect(resolveRepository).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledExactlyOnceWith("getManagedRepository", { repositoryId });
  });

  it.each([
    { name: "another repository", output: { ...readyRepository, id: "repository-2" } },
    { name: "another GitHub identity", output: { ...readyRepository, githubRepositoryId: 999 } },
    {
      name: "another canonical name",
      output: { ...readyRepository, fullName: "another/repository" },
    },
    {
      name: "unexpected response fields",
      output: { ...readyRepository, upstreamBody: rawFailure },
    },
  ])("withholds successful connection results containing $name", async ({ output }) => {
    const { database } = createDatabase(async (operation) =>
      operation === "getManagedRepository" ? repository : output,
    );
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: checkPath,
      payload: {},
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(502);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_response_invalid" });
    expect(response.body).not.toContain(rawFailure);
  });

  it("withholds failure results from another repository", async () => {
    const output = {
      ...repository,
      id: "repository-2",
      connectionStatus: "error",
      connectionMessage: "Connection failed.",
    };
    const { database } = createDatabase(async (operation) =>
      operation === "getManagedRepository" ? repository : output,
    );
    const { app } = createApp({
      database,
      resolveRepository: vi.fn(async () => {
        throw new Error(rawFailure);
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: checkPath,
      payload: {},
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(502);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_response_invalid" });
    expect(response.body).not.toContain(rawFailure);
  });
});
