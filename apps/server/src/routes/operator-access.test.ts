import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  OperatorPrincipal,
  OperatorRepositoryRole,
  RepositoryAccessAuditListResponse,
  RepositoryAccessChangeRequest,
  RepositoryAccessChangeResponse,
  RepositoryAccessListResponse,
} from "@agentic-review/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import { runMigrations } from "../database/migrations.js";
import {
  handleOperatorAccessRequest,
  isOperatorAccessOperation,
  type OperatorAccessRequest,
} from "../database/operator-access.js";
import {
  authorizeOperatorRequest,
  type OperatorRequestInput,
} from "../database/operator-request.js";
import type { OperatorSession } from "../security/operator-auth.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { registerOperatorAccessRoutes } from "./operator-access.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const publicOrigin = "https://review.example.com";
const token = "S".repeat(43);
const timestamp = "2026-09-07T12:00:00.000Z";
const platformAdmin = { issuer: "https://identity.example.com", subject: "platform-admin" };
const member = { ...platformAdmin, subject: "repository-member" };
const target = { ...platformAdmin, subject: "target-member" };
const repositoryId = "repository-1";
const otherRepositoryId = "repository-2";
const contextPath = "/api/v1/operator/access";
const selectedContextPath = `${contextPath}?repositoryId=${repositoryId}`;
const accessPath = `/api/v1/operator/repositories/${repositoryId}/access`;
const historyPath = `${accessPath}/history`;
const changeRequest = {
  changeId: "change-1",
  principal: target,
  role: "viewer",
  expectedVersion: 0,
  reason: "Grant access for validation review.",
} satisfies RepositoryAccessChangeRequest;
const cookieHeaders = () => ({ cookie: `${OPERATOR_SESSION_COOKIE}=${token}` });
const mutationHeaders = () => ({ ...cookieHeaders(), origin: publicOrigin });
const envelope = (actor: OperatorPrincipal, operation: string, input: unknown) => ({
  context: { kind: "operator", actor },
  operation,
  input,
});
const routes = [
  {
    name: "global context",
    method: "GET",
    url: contextPath,
    operation: "getOperatorAccessContext",
    input: { actor: platformAdmin },
  },
  {
    name: "selected context",
    method: "GET",
    url: selectedContextPath,
    operation: "getOperatorAccessContext",
    input: { actor: platformAdmin, repositoryId },
  },
  {
    name: "grant list",
    method: "GET",
    url: accessPath,
    operation: "listRepositoryAccessGrants",
    input: { actor: platformAdmin, repositoryId, page: 1, pageSize: 20 },
  },
  {
    name: "audit history",
    method: "GET",
    url: historyPath,
    operation: "listRepositoryAccessAudit",
    input: { actor: platformAdmin, repositoryId, page: 1, pageSize: 20 },
  },
  {
    name: "access change",
    method: "POST",
    url: accessPath,
    operation: "changeRepositoryAccess",
    input: { actor: platformAdmin, repositoryId, request: changeRequest },
  },
] as const;

const fixtures: { app: FastifyInstance; database: DatabaseSync }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    fixture.database.close();
  }
});

function fixture(
  options: {
    actor?: OperatorPrincipal;
    readOnly?: boolean;
    mapResponse?: (operation: string, output: unknown) => unknown;
    failure?: Error;
  } = {},
) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON");
  runMigrations(database, migrationsDirectory);
  for (const [index, id] of [repositoryId, otherRepositoryId].entries()) {
    database
      .prepare(`INSERT INTO managed_repositories
      (id, github_repository_id, full_name, enabled, version, connection_status, configuration_source, created_at, updated_at)
      VALUES (?, ?, ?, 0, 1, 'unknown', 'discovered', ?, ?)`)
      .run(id, index + 1, `example/project-${index + 1}`, timestamp, timestamp);
  }
  let actor = options.actor ?? platformAdmin;
  let sequence = 0;
  const administrators = [platformAdmin];
  const nextTimestamp = () => new Date(Date.parse(timestamp) + sequence++ * 1_000).toISOString();
  const session = (): OperatorSession => ({
    ...actor,
    displayName: "Operator",
    email: "operator@example.com",
    createdAt: timestamp,
    expiresAt: "2026-09-07T13:00:00.000Z",
  });
  const auth: OperatorAuthRouteService = {
    publicOrigin,
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
      throw new Error("Not used by access route tests.");
    }),
    getSession: vi.fn(async (sessionToken) => (sessionToken === token ? session() : null)),
    logout: vi.fn(async () => undefined),
  };
  const handled = vi.fn((request: OperatorAccessRequest) =>
    handleOperatorAccessRequest(database, request, nextTimestamp(), administrators),
  );
  const request = vi.fn(async (operation: string, input: unknown) => {
    expect(operation).toBe("operatorRequest");
    expect(input).toEqual(envelope(actor, expect.any(String), expect.anything()));
    try {
      const authorized = authorizeOperatorRequest(
        database,
        input as OperatorRequestInput,
        administrators,
      );
      expect(isOperatorAccessOperation(authorized.request.operation)).toBe(true);
      authorized.revalidate();
      if (options.failure !== undefined) {
        await Promise.resolve();
        throw options.failure;
      }
      const output = handled(authorized.request as OperatorAccessRequest);
      return options.mapResponse === undefined
        ? output
        : options.mapResponse(authorized.request.operation, output);
    } catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string")
        throw new DatabaseRequestError(error.message, error.code);
      throw error;
    }
  });
  const app = Fastify({ logger: false });
  fixtures.push({ app, database });
  registerOperatorAuthRoutes(app, auth);
  registerOperatorAccessRoutes(app, {
    database: { request } as unknown as DatabaseClient,
    operatorAuth: auth,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  const seed = (
    role: OperatorRepositoryRole | null,
    input: {
      principal?: OperatorPrincipal;
      repositoryId?: string;
      expectedVersion?: number;
    } = {},
  ) =>
    handleOperatorAccessRequest(
      database,
      {
        operation: "changeRepositoryAccess",
        input: {
          actor: platformAdmin,
          repositoryId: input.repositoryId ?? repositoryId,
          request: {
            changeId: `seed-${sequence}`,
            principal: input.principal ?? member,
            role,
            expectedVersion: input.expectedVersion ?? 0,
            reason: "Prepare the repository access fixture.",
          },
        },
      },
      nextTimestamp(),
      administrators,
    );
  return {
    app,
    database,
    auth,
    request,
    handled,
    seed,
    loginAs(value: OperatorPrincipal) {
      actor = value;
    },
    changes() {
      return database.prepare("SELECT total_changes() AS count").get()?.count;
    },
  };
}

function expectPrivate(response: { headers: Record<string, unknown> }): void {
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers.vary).toBe("Cookie");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
}
function expectError(
  response: { statusCode: number; body: string; json(): unknown },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toMatchObject({ code, retryable: false, message: expect.any(String) });
  expect(response.body).not.toContain("storage-secret");
  expect(response.body).not.toContain("private-token");
}

describe("operator access routes with the real authorization database", () => {
  it.each(routes)(
    "binds $name to the session actor through the outer RPC envelope",
    async (route) => {
      const f = fixture();
      const response = await f.app.inject({
        method: route.method,
        url: route.url,
        headers: { ...mutationHeaders(), "x-operator-subject": "forged-admin" },
        ...(route.method === "POST" ? { payload: changeRequest } : {}),
      });
      expect(response.statusCode).toBe(route.method === "POST" ? 201 : 200);
      expectPrivate(response);
      expect(f.request).toHaveBeenCalledExactlyOnceWith(
        "operatorRequest",
        envelope(platformAdmin, route.operation, route.input),
      );
      expect(f.handled).toHaveBeenCalledOnce();
    },
  );

  it("returns a global context without grants and conceals every inaccessible repository", async () => {
    const f = fixture({ actor: member });
    const global = await f.app.inject({
      method: "GET",
      url: contextPath,
      headers: cookieHeaders(),
    });
    expect(global.statusCode).toBe(200);
    expect(global.json()).toEqual({
      principal: member,
      platformAdministrator: false,
      repository: null,
    });
    const failures: unknown[] = [];
    for (const url of [
      selectedContextPath,
      `${contextPath}?repositoryId=missing-repository`,
      accessPath,
      historyPath,
    ]) {
      const response = await f.app.inject({ method: "GET", url, headers: cookieHeaders() });
      expectError(response, 404, "platform_not_found");
      failures.push(response.json());
    }
    const change = await f.app.inject({
      method: "POST",
      url: accessPath,
      headers: mutationHeaders(),
      payload: changeRequest,
    });
    expectError(change, 404, "platform_not_found");
    for (const failure of failures) expect(failure).toEqual(change.json());
    expect(f.handled).toHaveBeenCalledOnce();
  });

  it.each([
    ["viewer", ["read"]],
    ["reviewer", ["read", "review"]],
    ["maintainer", ["read", "review", "configure"]],
    ["admin", ["read", "review", "configure", "manage_access"]],
  ] as const)(
    "applies the current %s role to context, membership, audit, and writes",
    async (role, permissions) => {
      const f = fixture({ actor: member });
      f.seed(role);
      const context = await f.app.inject({
        method: "GET",
        url: selectedContextPath,
        headers: cookieHeaders(),
      });
      expect(context.statusCode).toBe(200);
      expect(context.json()).toEqual({
        principal: member,
        platformAdministrator: false,
        repository: { repositoryId, role, source: "repository", permissions },
      });
      const before = f.changes();
      for (const url of [accessPath, historyPath]) {
        const response = await f.app.inject({ method: "GET", url, headers: cookieHeaders() });
        if (role === "admin") expect(response.statusCode).toBe(200);
        else expectError(response, 403, "platform_forbidden");
      }
      const response = await f.app.inject({
        method: "POST",
        url: accessPath,
        headers: mutationHeaders(),
        payload: changeRequest,
      });
      if (role === "admin") {
        expect(response.statusCode).toBe(201);
        expect(response.json()).toMatchObject({ change: { principal: target, actor: member } });
      } else {
        expectError(response, 403, "platform_forbidden");
        expect(f.changes()).toBe(before);
      }
    },
  );

  it.each(["viewer", "reviewer", "maintainer", "admin"] as const)(
    "grants %s to the target principal without changing the acting identity",
    async (role) => {
      const f = fixture();
      const input = { ...changeRequest, role };
      const response = await f.app.inject({
        method: "POST",
        url: accessPath,
        headers: mutationHeaders(),
        payload: input,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        replayed: false,
        change: {
          id: expect.any(String),
          repositoryId,
          changeId: input.changeId,
          principal: target,
          actor: platformAdmin,
          previousRole: null,
          role,
          previousVersion: 0,
          version: 1,
          reason: input.reason,
          createdAt: timestamp,
        },
      });
      const grants = await f.app.inject({
        method: "GET",
        url: accessPath,
        headers: cookieHeaders(),
      });
      expect(grants.json()).toMatchObject({
        total: 1,
        items: [{ principal: target, role, version: 1, updatedBy: platformAdmin }],
      });
      f.loginAs(target);
      const context = await f.app.inject({
        method: "GET",
        url: selectedContextPath,
        headers: cookieHeaders(),
      });
      expect(context.json()).toMatchObject({
        principal: target,
        repository: { role, source: "repository" },
      });
    },
  );

  it("preserves CAS versions across updates, revocation, and reactivation", async () => {
    const f = fixture();
    const post = (input: RepositoryAccessChangeRequest) =>
      f.app.inject({ method: "POST", url: accessPath, headers: mutationHeaders(), payload: input });
    expect((await post(changeRequest)).statusCode).toBe(201);
    const beforeConflict = f.changes();
    expectError(
      await post({ ...changeRequest, changeId: "stale", role: "reviewer" }),
      409,
      "platform_conflict",
    );
    expect(f.changes()).toBe(beforeConflict);
    const updated = await post({
      ...changeRequest,
      changeId: "update",
      role: "maintainer",
      expectedVersion: 1,
    });
    expect(updated.json()).toMatchObject({
      change: { previousRole: "viewer", role: "maintainer", previousVersion: 1, version: 2 },
    });
    const revoked = await post({
      ...changeRequest,
      changeId: "revoke",
      role: null,
      expectedVersion: 2,
    });
    expect(revoked.json()).toMatchObject({
      change: { previousRole: "maintainer", role: null, previousVersion: 2, version: 3 },
    });
    f.loginAs(target);
    expectError(
      await f.app.inject({ method: "GET", url: selectedContextPath, headers: cookieHeaders() }),
      404,
      "platform_not_found",
    );
    f.loginAs(platformAdmin);
    expectError(
      await post({ ...changeRequest, changeId: "stale-reactivation" }),
      409,
      "platform_conflict",
    );
    const grants = (
      await f.app.inject({ method: "GET", url: accessPath, headers: cookieHeaders() })
    ).json<RepositoryAccessListResponse>();
    expect(grants).toMatchObject({
      total: 1,
      items: [{ principal: target, role: null, version: 3 }],
    });
    expect(
      (await post({ ...changeRequest, changeId: "reactivate", expectedVersion: 3 })).json(),
    ).toMatchObject({ change: { previousRole: null, role: "viewer", version: 4 } });
    const history = (
      await f.app.inject({ method: "GET", url: historyPath, headers: cookieHeaders() })
    ).json<RepositoryAccessAuditListResponse>();
    expect(history.total).toBe(4);
    expect(history.items.map((item) => item.version)).toEqual([4, 3, 2, 1]);
  });

  it("accepts only one of two concurrent changes with the same expected version", async () => {
    const f = fixture();
    const responses = await Promise.all(
      [changeRequest, { ...changeRequest, changeId: "competing", role: "reviewer" }].map(
        (payload) =>
          f.app.inject({ method: "POST", url: accessPath, headers: mutationHeaders(), payload }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const history = await f.app.inject({
      method: "GET",
      url: historyPath,
      headers: cookieHeaders(),
    });
    expect(history.json()).toMatchObject({ total: 1, items: [{ previousVersion: 0, version: 1 }] });
  });

  it("returns the original replay receipt without treating it as the current grant", async () => {
    const f = fixture();
    const post = (payload: RepositoryAccessChangeRequest) =>
      f.app.inject({ method: "POST", url: accessPath, headers: mutationHeaders(), payload });
    const first = (await post(changeRequest)).json<RepositoryAccessChangeResponse>();
    await post({ ...changeRequest, changeId: "update", expectedVersion: 1, role: "maintainer" });
    const before = f.changes();
    const replay = await post(changeRequest);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ change: first.change, replayed: true });
    expect(f.changes()).toBe(before);
    const current = await f.app.inject({
      method: "GET",
      url: accessPath,
      headers: cookieHeaders(),
    });
    expect(current.json()).toMatchObject({
      total: 1,
      items: [{ principal: target, role: "maintainer", version: 2 }],
    });
  });

  it.each([null, "viewer"] as const)(
    "checks live authority before replay when the actor role becomes %s",
    async (role) => {
      const f = fixture({ actor: member });
      f.seed("admin");
      const first = await f.app.inject({
        method: "POST",
        url: accessPath,
        headers: mutationHeaders(),
        payload: changeRequest,
      });
      expect(first.statusCode).toBe(201);
      f.seed(role, { expectedVersion: 1 });
      const before = f.changes();
      const handled = f.handled.mock.calls.length;
      const replay = await f.app.inject({
        method: "POST",
        url: accessPath,
        headers: mutationHeaders(),
        payload: changeRequest,
      });
      expectError(
        replay,
        role === null ? 404 : 403,
        role === null ? "platform_not_found" : "platform_forbidden",
      );
      expect(f.handled).toHaveBeenCalledTimes(handled);
      expect(f.changes()).toBe(before);
      expect(replay.body).not.toContain(first.json<RepositoryAccessChangeResponse>().change.id);
    },
  );

  it.each([null, "viewer"] as const)(
    "prevents the last repository administrator from changing their role to %s",
    async (role) => {
      const f = fixture({ actor: member });
      f.seed("admin");
      const input = { ...changeRequest, principal: member, role, expectedVersion: 1 };
      const before = f.changes();
      const response = await f.app.inject({
        method: "POST",
        url: accessPath,
        headers: mutationHeaders(),
        payload: input,
      });
      expectError(response, 409, "platform_conflict");
      expect(f.changes()).toBe(before);
      f.seed("admin", { principal: target });
      const accepted = await f.app.inject({
        method: "POST",
        url: accessPath,
        headers: mutationHeaders(),
        payload: input,
      });
      expect(accepted.statusCode).toBe(201);
      expect(accepted.json()).toMatchObject({
        change: { principal: member, actor: member, role, version: 2 },
      });
    },
  );

  it("allows platform recovery to revoke the final repository administrator", async () => {
    const f = fixture();
    f.seed("admin");
    const response = await f.app.inject({
      method: "POST",
      url: accessPath,
      headers: mutationHeaders(),
      payload: { ...changeRequest, principal: member, role: null, expectedVersion: 1 },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      change: { actor: platformAdmin, principal: member, role: null },
    });
  });

  it.each([
    { role: "reviewer" },
    { principal: member },
    { reason: "A different intent." },
    { expectedVersion: 1 },
  ])("rejects reusing a change identifier with another intent: %j", async (changed) => {
    const f = fixture();
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: accessPath,
          headers: mutationHeaders(),
          payload: changeRequest,
        })
      ).statusCode,
    ).toBe(201);
    const before = f.changes();
    expectError(
      await f.app.inject({
        method: "POST",
        url: accessPath,
        headers: mutationHeaders(),
        payload: { ...changeRequest, ...changed },
      }),
      409,
      "platform_conflict",
    );
    expect(f.changes()).toBe(before);
  });

  it("applies repository scope before counts and pagination for both lists", async () => {
    const f = fixture();
    for (const subject of ["a", "b", "c", "d", "e"])
      f.seed("viewer", { principal: { ...target, subject } });
    f.seed("admin", { repositoryId: otherRepositoryId });
    const grants = await f.app.inject({
      method: "GET",
      url: `${accessPath}?page=2&pageSize=2`,
      headers: cookieHeaders(),
    });
    expect(grants.statusCode).toBe(200);
    expect(grants.json()).toMatchObject({
      repositoryId,
      page: 2,
      pageSize: 2,
      total: 5,
      items: [{ principal: { subject: "c" } }, { principal: { subject: "d" } }],
    });
    const history = await f.app.inject({
      method: "GET",
      url: `${historyPath}?page=2&pageSize=2`,
      headers: cookieHeaders(),
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      repositoryId,
      page: 2,
      pageSize: 2,
      total: 5,
      items: [{ principal: { subject: "c" } }, { principal: { subject: "b" } }],
    });
    for (const url of [accessPath, historyPath]) {
      const empty = await f.app.inject({
        method: "GET",
        url: `${url}?page=4&pageSize=2`,
        headers: cookieHeaders(),
      });
      expect(empty.json()).toEqual({ repositoryId, page: 4, pageSize: 2, total: 5, items: [] });
    }
    expect(f.request).toHaveBeenNthCalledWith(
      1,
      "operatorRequest",
      envelope(platformAdmin, "listRepositoryAccessGrants", {
        repositoryId,
        actor: platformAdmin,
        page: 2,
        pageSize: 2,
      }),
    );
    expect(f.request).toHaveBeenNthCalledWith(
      2,
      "operatorRequest",
      envelope(platformAdmin, "listRepositoryAccessAudit", {
        repositoryId,
        actor: platformAdmin,
        page: 2,
        pageSize: 2,
      }),
    );
  });
});

describe("access HTTP authentication and input boundaries", () => {
  it.each(routes)(
    "rejects missing, invalid, or Worker-only authentication for $name",
    async (route) => {
      const f = fixture();
      for (const extra of [
        {},
        { cookie: `${OPERATOR_SESSION_COOKIE}=invalid-session` },
        { authorization: `Bearer arw1_${"x".repeat(43)}` },
      ]) {
        const response = await f.app.inject({
          method: route.method,
          url: route.url,
          headers: { origin: publicOrigin, ...extra },
          ...(route.method === "POST" ? { payload: changeRequest } : {}),
        });
        expectError(response, 401, "operator_authentication_required");
        expectPrivate(response);
      }
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    "null",
    "https://attacker.example.com",
    `${publicOrigin}/`,
    [publicOrigin, publicOrigin],
  ])("requires exactly one trusted mutation Origin: %j", async (origin) => {
    const f = fixture();
    const response = await f.app.inject({
      method: "POST",
      url: accessPath,
      headers: { ...cookieHeaders(), ...(origin === undefined ? {} : { Origin: origin }) },
      payload: changeRequest,
    });
    expectError(response, 403, "invalid_operator_auth_origin");
    expect(f.auth.getSession).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("authenticates before attempting to parse a malformed change body", async () => {
    const f = fixture();
    const response = await f.app.inject({
      method: "POST",
      url: accessPath,
      headers: { origin: publicOrigin, "content-type": "application/json" },
      payload: "{",
    });
    expectError(response, 401, "operator_authentication_required");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("keeps recovery reads functional with SQLite query_only and blocks all HTTP writes", async () => {
    const f = fixture({ readOnly: true });
    f.seed("viewer");
    f.database.exec("PRAGMA query_only = ON");
    const before = f.changes();
    const mutation = await f.app.inject({
      method: "POST",
      url: accessPath,
      headers: mutationHeaders(),
      payload: changeRequest,
    });
    expectError(mutation, 503, "configuration_read_only");
    expect(f.request).not.toHaveBeenCalled();
    for (const url of [contextPath, selectedContextPath, accessPath, historyPath]) {
      const response = await f.app.inject({ method: "GET", url, headers: cookieHeaders() });
      expect(response.statusCode).toBe(200);
      expectPrivate(response);
    }
    expect(f.changes()).toBe(before);
    expect(
      f.handled.mock.calls.every(([request]) => request.operation !== "changeRepositoryAccess"),
    ).toBe(true);
  });

  it.each([
    `${contextPath}?repoId=${repositoryId}`,
    `${contextPath}?repositoryId=${repositoryId}&repositoryId=${repositoryId}`,
    `${contextPath}?actor=platform-admin`,
    `${contextPath}?page=1`,
    `${accessPath}?repositoryId=${otherRepositoryId}`,
    `${accessPath}?page=1&page=2`,
    `${accessPath}?pageSize=1&pageSize=2`,
    `${historyPath}?page=0`,
    `${historyPath}?pageSize=51`,
    `${historyPath}?page=1.5`,
    `${historyPath}?page=9007199254740991&pageSize=50`,
    `${historyPath}?principal=other-user`,
  ])("rejects unsupported or ambiguous query parameters: %s", async (url) => {
    const f = fixture();
    const response = await f.app.inject({ method: "GET", url, headers: cookieHeaders() });
    expectError(response, 400, "configuration_query_invalid");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rejects query parameters on access changes", async () => {
    const f = fixture();
    const response = await f.app.inject({
      method: "POST",
      url: `${accessPath}?actor=admin`,
      headers: mutationHeaders(),
      payload: changeRequest,
    });
    expectError(response, 400, "configuration_query_invalid");
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([
    { method: "GET", url: `${contextPath}?repositoryId=-invalid` },
    { method: "GET", url: accessPath.replace(repositoryId, "invalid%20repository") },
    { method: "GET", url: historyPath.replace(repositoryId, "-invalid") },
    { method: "POST", url: accessPath.replace(repositoryId, "-invalid") },
  ] as const)("rejects malformed repository identifiers in $method $url", async (route) => {
    const f = fixture();
    const response = await f.app.inject({
      ...route,
      headers: mutationHeaders(),
      ...(route.method === "POST" ? { payload: changeRequest } : {}),
    });
    expectError(response, 400, "configuration_request_invalid");
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([
    { actor: platformAdmin },
    { context: { kind: "operator", actor: platformAdmin } },
    { repositoryId: otherRepositoryId },
    { version: 100 },
    { principal: { ...target, email: "admin@example.com" } },
    { principal: null },
    { role: "owner" },
    { role: undefined },
    { expectedVersion: -1 },
    { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { expectedVersion: 0.5 },
    { reason: "" },
    { reason: "x".repeat(2_049) },
  ])("rejects acting identity, authority, and malformed change fields: %j", async (extra) => {
    const f = fixture();
    const response = await f.app.inject({
      method: "POST",
      url: accessPath,
      headers: mutationHeaders(),
      payload: { ...changeRequest, ...extra },
    });
    expectError(response, 400, "configuration_request_invalid");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does not use a body or header to elevate an ordinary reader", async () => {
    const f = fixture({ actor: member });
    f.seed("viewer");
    const response = await f.app.inject({
      method: "POST",
      url: accessPath,
      headers: { ...mutationHeaders(), "x-operator-subject": platformAdmin.subject },
      payload: { ...changeRequest, principal: platformAdmin, role: "admin" },
    });
    expectError(response, 403, "platform_forbidden");
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "operatorRequest",
      envelope(member, "changeRepositoryAccess", {
        repositoryId,
        actor: member,
        request: { ...changeRequest, principal: platformAdmin, role: "admin" },
      }),
    );
    expect(f.handled).not.toHaveBeenCalled();
  });

  it.each([" ", "\0", "\ud800"])(
    "rejects an invalid reason after the current actor is authorized: %j",
    async (reason) => {
      const f = fixture();
      const before = f.changes();
      const response = await f.app.inject({
        method: "POST",
        url: accessPath,
        headers: mutationHeaders(),
        payload: { ...changeRequest, reason },
      });
      expectError(response, 400, "platform_invalid");
      expect(f.changes()).toBe(before);
    },
  );

  it("enforces the bounded JSON change body", async () => {
    const f = fixture();
    const response = await f.app.inject({
      method: "POST",
      url: accessPath,
      headers: mutationHeaders(),
      payload: { ...changeRequest, padding: "x".repeat(16_384) },
    });
    expect(response.statusCode).toBe(413);
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(routes)("conceals asynchronous database failures for $name", async (route) => {
    const f = fixture({
      failure: new DatabaseRequestError(
        "C:/private/storage-secret private-token",
        "PLATFORM_NOT_FOUND",
      ),
    });
    const response = await f.app.inject({
      method: route.method,
      url: route.url,
      headers: mutationHeaders(),
      ...(route.method === "POST" ? { payload: changeRequest } : {}),
    });
    expectError(response, 404, "platform_not_found");
    expectPrivate(response);
    expect(f.handled).not.toHaveBeenCalled();
  });
});

describe("access response identity validation", () => {
  it.each([
    {
      name: "another global principal subject",
      url: contextPath,
      patch: { principal: { ...platformAdmin, subject: "storage-secret" } },
    },
    {
      name: "another selected principal issuer",
      url: selectedContextPath,
      patch: { principal: { ...platformAdmin, issuer: "https://other.example.com" } },
    },
    {
      name: "an unexpected global repository",
      url: contextPath,
      patch: {
        repository: { repositoryId, role: "admin", source: "platform", permissions: ["read"] },
      },
    },
    {
      name: "another selected repository",
      url: selectedContextPath,
      patch: {
        repository: {
          repositoryId: otherRepositoryId,
          role: "admin",
          source: "platform",
          permissions: ["read"],
        },
      },
    },
    {
      name: "an absent selected repository",
      url: selectedContextPath,
      patch: { repository: null },
    },
    {
      name: "private response metadata",
      url: contextPath,
      patch: { storagePath: "C:/private/storage-secret" },
    },
  ])("rejects $name from the database", async ({ url, patch }) => {
    const f = fixture({
      mapResponse: (_operation, output) => ({ ...(output as object), ...patch }),
    });
    const response = await f.app.inject({ method: "GET", url, headers: cookieHeaders() });
    expectError(response, 502, "configuration_response_invalid");
  });

  it.each([
    { repositoryId: otherRepositoryId },
    { changeId: "another-change" },
    { principal: { ...target, subject: "another-target" } },
    { principal: { ...target, issuer: "https://other.example.com" } },
    { actor: { ...platformAdmin, subject: "another-actor" } },
    { actor: { ...platformAdmin, issuer: "https://other.example.com" } },
    { role: "maintainer" },
    { role: null },
    { previousVersion: 1 },
    { version: 2 },
    { reason: "A different accepted request." },
  ])("rejects a change receipt that disagrees with the request: %j", async (patch) => {
    const f = fixture({
      mapResponse: (_operation, output) => {
        const response = output as RepositoryAccessChangeResponse;
        return { ...response, change: { ...response.change, ...patch } };
      },
    });
    const response = await f.app.inject({
      method: "POST",
      url: accessPath,
      headers: mutationHeaders(),
      payload: changeRequest,
    });
    expectError(response, 502, "configuration_response_invalid");
  });

  it.each([accessPath, historyPath])(
    "rejects a cross-scope or overfull page at %s",
    async (url) => {
      for (const corruption of [
        "outer repository",
        "item repository",
        "page",
        "page size",
        "too many items",
      ] as const) {
        const f = fixture({
          mapResponse: (_operation, output) => {
            const page = output as RepositoryAccessListResponse | RepositoryAccessAuditListResponse;
            switch (corruption) {
              case "outer repository":
                return { ...page, repositoryId: otherRepositoryId };
              case "item repository":
                return {
                  ...page,
                  items: page.items.map((item) => ({ ...item, repositoryId: otherRepositoryId })),
                };
              case "page":
                return { ...page, page: 2 };
              case "page size":
                return { ...page, pageSize: 2 };
              case "too many items":
                return { ...page, total: 2, items: [...page.items, ...page.items] };
            }
          },
        });
        f.seed("viewer");
        const response = await f.app.inject({
          method: "GET",
          url: `${url}?pageSize=1`,
          headers: cookieHeaders(),
        });
        expect(response.statusCode, corruption).toBe(502);
        expect(response.json()).toMatchObject({ code: "configuration_response_invalid" });
      }
    },
  );
});
