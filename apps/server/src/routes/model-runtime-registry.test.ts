import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "@agentic-review/contracts";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import {
  MODEL_RUNTIME_REGISTRY_PATHS,
  registerModelRuntimeRegistryRoutes,
} from "./model-runtime-registry.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";
import {
  operatorConfigurationRateLimits,
  registerOperatorConfigurationRateLimits,
} from "./operator-rate-limit.js";

const actor: C.OperatorPrincipal = {
  issuer: "https://runtime-registry.example.test",
  subject: "operator-a",
};
const origin = "https://review.example.test";
const token = "R".repeat(43);
const now = "2026-09-08T01:00:00.000Z";
const identity: C.ModelRuntimeIdentityV1 = {
  schemaVersion: "ModelRuntimeIdentityV1",
  providerId: "synthetic-provider",
  modelId: "provider-model",
  endpointSha256: sha256("synthetic endpoint"),
  client: {
    kind: "codex_cli",
    version: "1.0.0",
    executableSha256: sha256("synthetic executable"),
    launchPolicySha256: sha256("synthetic policy"),
  },
  relay: {
    implementationSha256: sha256("synthetic relay"),
    policySha256: sha256("synthetic relay policy"),
  },
};
const createRequest: C.ModelRuntimeRegisterRequest = {
  changeId: "register-runtime-a",
  name: "Expected runtime",
  requestedModel: "configured-model",
  identity,
  enabled: true,
};
const controlRequest: C.ModelRuntimeControlRequest = {
  changeId: "disable-runtime-a",
  expectedVersion: 1,
  enabled: false,
  reason: "Pause new evaluation selections.",
};
function status(id = "runtime-a", enabled = true, version = 1): C.ModelRuntimeStatusV1 {
  return {
    schemaVersion: "ModelRuntimeStatusV1",
    registration: {
      schemaVersion: "ModelRuntimeRegistrationV1",
      id,
      name: createRequest.name,
      requestedModel: createRequest.requestedModel,
      identity: structuredClone(identity),
      identitySha256: sha256(canonicalJson(identity)),
      createdAt: now,
      createdBy: { ...actor },
    },
    control: {
      schemaVersion: "ModelRuntimeControlV1",
      registrationId: id,
      version,
      enabled,
      updatedAt: version === 1 ? now : "2026-09-08T01:01:00.000Z",
      updatedBy: { ...actor },
    },
  };
}
function list(
  items = [status()],
  page = 1,
  pageSize = 20,
  total = items.length,
): C.ModelRuntimeListV1 {
  return { schemaVersion: "ModelRuntimeListV1", page, pageSize, total, items };
}
function history(): C.ModelRuntimeHistoryV1 {
  return {
    schemaVersion: "ModelRuntimeHistoryV1",
    registrationId: "runtime-a",
    page: 1,
    pageSize: 20,
    total: 2,
    items: [
      {
        schemaVersion: "ModelRuntimeAuditEventV1",
        id: "event-2",
        registrationId: "runtime-a",
        changeId: controlRequest.changeId,
        operation: "control",
        previousVersion: 1,
        version: 2,
        enabled: false,
        reason: controlRequest.reason,
        createdAt: "2026-09-08T01:01:00.000Z",
        createdBy: { ...actor },
      },
      {
        schemaVersion: "ModelRuntimeAuditEventV1",
        id: "event-1",
        registrationId: "runtime-a",
        changeId: createRequest.changeId,
        operation: "register",
        previousVersion: 0,
        version: 1,
        enabled: true,
        reason: null,
        createdAt: now,
        createdBy: { ...actor },
      },
    ],
  };
}
function options(): C.ModelRuntimeOptionsV1 {
  return {
    schemaVersion: "ModelRuntimeOptionsV1",
    repositoryId: "repo-a",
    page: 1,
    pageSize: 20,
    total: 1,
    items: [status().registration],
  };
}
const registrationsPath = MODEL_RUNTIME_REGISTRY_PATHS.registrations;
const registrationPath = MODEL_RUNTIME_REGISTRY_PATHS.registration.replace(
  ":registrationId",
  "runtime-a",
);
const historyPath = MODEL_RUNTIME_REGISTRY_PATHS.history.replace(":registrationId", "runtime-a");
const optionsPath = MODEL_RUNTIME_REGISTRY_PATHS.options.replace(":repositoryId", "repo-a");
const routes = [
  {
    name: "register",
    method: "POST",
    path: registrationsPath,
    operation: "registerModelRuntime",
    input: { actor, request: createRequest },
    body: createRequest,
    output: status(),
  },
  {
    name: "control",
    method: "PATCH",
    path: registrationPath,
    operation: "changeModelRuntimeControl",
    input: { actor, registrationId: "runtime-a", request: controlRequest },
    body: controlRequest,
    output: status("runtime-a", false, 2),
  },
  {
    name: "list",
    method: "GET",
    path: registrationsPath,
    operation: "listModelRuntimeRegistrations",
    input: { actor, query: { page: 1, pageSize: 20 } },
    output: list(),
  },
  {
    name: "get",
    method: "GET",
    path: registrationPath,
    operation: "getModelRuntimeRegistration",
    input: { actor, registrationId: "runtime-a" },
    output: status(),
  },
  {
    name: "history",
    method: "GET",
    path: historyPath,
    operation: "listModelRuntimeHistory",
    input: { actor, registrationId: "runtime-a", query: { page: 1, pageSize: 20 } },
    output: history(),
  },
  {
    name: "options",
    method: "GET",
    path: optionsPath,
    operation: "listEvaluationModelRuntimeOptions",
    input: { actor, repositoryId: "repo-a", query: { page: 1, pageSize: 20 } },
    output: options(),
  },
] as const;
type Route = (typeof routes)[number];
const apps: FastifyInstance[] = [];
const owners = new Set<DatabaseClient>();
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all([...owners].map((owner) => owner.close()));
  owners.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const headers = () => ({
  host: "review.example.test",
  origin,
  cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
});
function requestFor(route: Route): InjectOptions {
  return {
    method: route.method,
    url: route.path,
    headers: headers(),
    ...("body" in route ? { payload: route.body } : {}),
  };
}
function fixture(
  output: unknown,
  selected: {
    authenticated?: boolean;
    readOnly?: boolean;
    error?: Error;
    rateLimits?: boolean;
  } = {},
) {
  const session = {
    ...actor,
    displayName: "Registry operator",
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
      throw new Error("No external login is used by registry route tests.");
    }),
    getSession: vi.fn(async (value) =>
      value === token && selected.authenticated !== false ? session : null,
    ),
    logout: vi.fn(async () => undefined),
  };
  const database = createOperatorRouteTestDatabase(actor, async () => {
    if (selected.error) throw selected.error;
    return output;
  });
  const app = Fastify({ logger: false });
  apps.push(app);
  registerOperatorAuthRoutes(app, auth);
  app.register(async (scope) => {
    if (selected.rateLimits) await registerOperatorConfigurationRateLimits(scope, auth);
    registerModelRuntimeRegistryRoutes(scope, {
      database: database.database,
      operatorAuth: auth,
      ...(selected.readOnly === undefined ? {} : { readOnly: selected.readOnly }),
    });
  });
  return { app, auth, ...database };
}

describe("model runtime registry HTTP boundary", () => {
  it.each(routes)("binds $name to its exact authenticated operator RPC", async (route) => {
    const f = fixture(route.output);
    const response = await f.app.inject(requestFor(route));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(route.output);
    expect(f.transport).toHaveBeenCalledExactlyOnceWith("operatorRequest", {
      context: { kind: "operator", actor },
      operation: route.operation,
      input: route.input,
    });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.vary).toBe("Cookie");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });
  it.each(routes)("requires a current cookie session for $name", async (route) => {
    const f = fixture(route.output, { authenticated: false });
    expect((await f.app.inject(requestFor(route))).statusCode).toBe(401);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("uses the login cookie without accepting actor or trusted replay flags in mutation bodies", async () => {
    const f = fixture(status());
    const login = await f.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "review.example.test", origin },
    });
    expect(login.statusCode).toBe(303);
    expect(login.cookies.find((cookie) => cookie.name === OPERATOR_SESSION_COOKIE)?.value).toBe(
      token,
    );
    for (const addition of [
      { actor: { ...actor, subject: "forged" } },
      { replayOnly: true },
      { readOnly: false },
    ]) {
      const response = await f.app.inject({
        method: "POST",
        url: registrationsPath,
        headers: headers(),
        payload: { ...createRequest, ...addition },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(routes.filter((route) => route.method !== "GET"))(
    "checks exactly one matching Origin for $name",
    async (route) => {
      const f = fixture(route.output);
      for (const value of [undefined, "https://elsewhere.example.test", [origin, origin]]) {
        const selectedHeaders = {
          host: "review.example.test",
          cookie: headers().cookie,
          ...(value === undefined ? {} : { origin: value }),
        };
        const response = await f.app.inject({
          ...requestFor(route),
          headers: selectedHeaders as unknown as NonNullable<InjectOptions["headers"]>,
        });
        expect(response.statusCode).toBe(403);
      }
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it.each(routes)(
    "keeps $name available in recovery while trusting only route-injected replay restrictions",
    async (route) => {
      const f = fixture(route.output, { readOnly: true });
      expect((await f.app.inject(requestFor(route))).statusCode).toBe(200);
      expect(f.request).toHaveBeenCalledExactlyOnceWith(route.operation, {
        ...route.input,
        ...(route.method === "GET" ? {} : { replayOnly: true }),
      });
    },
  );
  it("keeps the exact mutation payload across retry attempts", async () => {
    const f = fixture(status(), { readOnly: true });
    const payload = JSON.stringify(createRequest);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await f.app.inject({
        method: "POST",
        url: registrationsPath,
        headers: { ...headers(), "content-type": "application/json" },
        payload,
      });
      expect(response.json()).toEqual(status());
    }
    expect(f.request.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [
        "registerModelRuntime",
        { actor, request: createRequest, replayOnly: true },
      ]),
    );
  });
  it.each([
    "enabled=1",
    "enabled=True",
    "enabled=",
    "page=01",
    "page=0",
    "pageSize=51",
    "page=1&page=2",
    "unknown=true",
  ])("rejects invalid list query %s", async (query) => {
    const f = fixture(list());
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: `${registrationsPath}?${query}`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("checks list pagination and both boolean filter values", async () => {
    for (const enabled of [true, false]) {
      const f = fixture(list([status("runtime-b", enabled)], 2, 1, 2));
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: `${registrationsPath}?page=2&pageSize=1&enabled=${enabled}`,
            headers: headers(),
          })
        ).statusCode,
      ).toBe(200);
      expect(f.request).toHaveBeenCalledExactlyOnceWith("listModelRuntimeRegistrations", {
        actor,
        query: { page: 2, pageSize: 1, enabled },
      });
    }
  });
  it.each([
    `${registrationPath}?page=1`,
    `${historyPath}?enabled=true`,
    `${optionsPath}?enabled=true`,
    `${registrationPath}%0A`,
    `${optionsPath.replace("repo-a", "repo-a%0A")}`,
  ])("rejects unsupported or altered scope %s", async (url) => {
    const f = fixture(status());
    expect((await f.app.inject({ method: "GET", url, headers: headers() })).statusCode).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(["PUT", "DELETE"] as const)("does not expose %s mutations", async (method) => {
    const f = fixture(status());
    expect(
      (
        await f.app.inject({
          method,
          url: registrationPath,
          headers: headers(),
          payload: controlRequest,
        })
      ).statusCode,
    ).toBe(404);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("enforces the mutation UTF-8 body budget before contacting the owner", async () => {
    const f = fixture(status());
    const response = await f.app.inject({
      method: "POST",
      url: registrationsPath,
      headers: { ...headers(), "content-type": "application/json" },
      payload: JSON.stringify({
        ...createRequest,
        padding: "界".repeat(C.maximumModelRuntimeRegistryRequestUtf8Bytes),
      }),
    });
    expect(response.statusCode).toBe(413);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("uses the existing principal mutation rate limit", async () => {
    const f = fixture(status(), { rateLimits: true });
    for (
      let index = 0;
      index < operatorConfigurationRateLimits.mutationsPerPrincipalPerMinute;
      index++
    )
      expect((await f.app.inject(requestFor(routes[0]))).statusCode).toBe(200);
    expect((await f.app.inject(requestFor(routes[0]))).statusCode).toBe(429);
    expect(f.request).toHaveBeenCalledTimes(
      operatorConfigurationRateLimits.mutationsPerPrincipalPerMinute,
    );
  });
  it.each([
    ["PLATFORM_NOT_FOUND", 404],
    ["PLATFORM_FORBIDDEN", 403],
    ["PLATFORM_CONFLICT", 409],
    ["PLATFORM_INVALID", 400],
    ["PLATFORM_CORRUPT", 500],
    ["DATABASE_READ_ONLY", 503],
  ] as const)("maps %s without disclosing owner diagnostics", async (code, expected) => {
    const f = fixture(status(), {
      error: new DatabaseRequestError("DO_NOT_DISCLOSE_OWNER_DETAILS", code),
    });
    const response = await f.app.inject(requestFor(routes[0]));
    expect(response.statusCode).toBe(expected);
    expect(response.body).not.toContain("DO_NOT_DISCLOSE_OWNER_DETAILS");
  });
  const badResponses: { name: string; request: InjectOptions; output: unknown }[] = [
    {
      name: "registration actor",
      request: requestFor(routes[0]),
      output: (() => {
        const value = status();
        value.registration.createdBy.subject = "other";
        value.control.updatedBy.subject = "other";
        return value;
      })(),
    },
    {
      name: "registration payload",
      request: requestFor(routes[0]),
      output: { ...status(), registration: { ...status().registration, name: "other name" } },
    },
    {
      name: "identity digest",
      request: requestFor(routes[3]),
      output: {
        ...status(),
        registration: { ...status().registration, identitySha256: "f".repeat(64) },
      },
    },
    { name: "get scope", request: requestFor(routes[3]), output: status("other-runtime") },
    {
      name: "control version",
      request: requestFor(routes[1]),
      output: status("runtime-a", false, 3),
    },
    {
      name: "control actor",
      request: requestFor(routes[1]),
      output: {
        ...status("runtime-a", false, 2),
        control: {
          ...status("runtime-a", false, 2).control,
          updatedBy: { ...actor, subject: "other" },
        },
      },
    },
    {
      name: "filter",
      request: { method: "GET", url: `${registrationsPath}?enabled=false`, headers: headers() },
      output: list(),
    },
    {
      name: "page",
      request: { method: "GET", url: `${registrationsPath}?page=2&pageSize=1`, headers: headers() },
      output: list([status()], 1, 1, 1),
    },
    {
      name: "history scope",
      request: requestFor(routes[4]),
      output: {
        ...history(),
        registrationId: "other-runtime",
        items: history().items.map((item) => ({ ...item, registrationId: "other-runtime" })),
      },
    },
    {
      name: "options scope",
      request: requestFor(routes[5]),
      output: { ...options(), repositoryId: "other-repository" },
    },
    {
      name: "unknown credential field",
      request: requestFor(routes[3]),
      output: { ...status(), credential: "DO_NOT_DISCLOSE" },
    },
  ];
  it.each(badResponses)("rejects mismatched $name response", async ({ request, output }) => {
    const f = fixture(output);
    const response = await f.app.inject(request);
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("model_runtime_response_invalid");
    expect(response.body).not.toContain("DO_NOT_DISCLOSE");
  });
});

describe("model runtime registry real owner RPC gate", () => {
  it("rejects direct registry RPCs and binds recovery replay to the current authenticated platform actor", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-runtime-registry-rpc-"));
    roots.push(root);
    await chmod(root, 0o700);
    const databasePath = join(root, "registry.sqlite");
    const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
    const start = async (
      administrators: readonly C.OperatorPrincipal[],
      recoveryMaintenance = false,
    ) => {
      const owner = await DatabaseClient.create({
        databasePath,
        migrationsDirectory,
        recoveryMaintenance,
        operatorAccess: { administrators },
      });
      owners.add(owner);
      return owner;
    };
    const close = async (owner: DatabaseClient) => {
      await owner.close();
      owners.delete(owner);
    };
    let owner = await start([actor]);
    const raw = [
      { operation: "registerModelRuntime", input: { actor, request: createRequest } },
      {
        operation: "changeModelRuntimeControl",
        input: { actor, registrationId: "runtime-a", request: controlRequest },
      },
      { operation: "listModelRuntimeRegistrations", input: { actor, query: {} } },
      { operation: "getModelRuntimeRegistration", input: { actor, registrationId: "runtime-a" } },
      {
        operation: "listModelRuntimeHistory",
        input: { actor, registrationId: "runtime-a", query: {} },
      },
      {
        operation: "listEvaluationModelRuntimeOptions",
        input: { actor, repositoryId: "repo-a", query: {} },
      },
    ] as const;
    for (const entry of raw)
      await expect(owner.request(entry.operation, entry.input)).rejects.toMatchObject({
        code: "PLATFORM_FORBIDDEN",
      });
    const bound = bindOperatorDatabase(owner, actor);
    const registered = await bound.request("registerModelRuntime", {
      actor,
      request: createRequest,
    });
    expect(registered.registration.createdBy).toEqual(actor);
    expect(registered.registration.identitySha256).toBe(sha256(canonicalJson(identity)));
    await expect(
      owner.request("operatorRequest", {
        context: { kind: "operator", actor },
        operation: "getModelRuntimeRegistration",
        input: {
          actor: { ...actor, subject: "spoofed" },
          registrationId: registered.registration.id,
        },
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });
    await close(owner);
    owner = await start([actor], true);
    expect(
      await bindOperatorDatabase(owner, actor).request("registerModelRuntime", {
        actor,
        request: createRequest,
      }),
    ).toEqual(registered);
    await expect(
      bindOperatorDatabase(owner, actor).request("registerModelRuntime", {
        actor,
        request: { ...createRequest, changeId: "new-recovery-change" },
      }),
    ).rejects.toMatchObject({ code: "DATABASE_READ_ONLY" });
    const after = await bindOperatorDatabase(owner, actor).request(
      "listModelRuntimeRegistrations",
      { actor, query: {} },
    );
    expect(after.total).toBe(1);
    await close(owner);
    owner = await start([], true);
    await expect(
      bindOperatorDatabase(owner, actor).request("registerModelRuntime", {
        actor,
        request: createRequest,
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });
  });
});
