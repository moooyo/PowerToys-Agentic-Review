import { createHash } from "node:crypto";
import type {
  OperatorPrincipal,
  PromptBinding,
  PromptPreviewRequest,
  PromptPreviewResponse,
  PromptTemplate,
  PromptTemplateCreateRequest,
  PromptTemplateSummary,
  PromptVersion,
  PromptVersionSummary,
  RepositoryValidationProfileBinding,
  ValidationProfileConfig,
  ValidationProfileCreateRequest,
  ValidationProfileVersion,
  ValidationProfileVersionSummary,
} from "@agentic-review/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import type { PromptConfigurationOperation } from "../database/prompt-configuration.js";
import type { OperatorSession } from "../security/operator-auth.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";
import { registerPromptConfigurationRoutes } from "./prompt-configuration.js";

const publicOrigin = "https://review.example.com";
const sessionToken = "S".repeat(43);
const timestamp = "2026-09-07T00:00:00.000Z";
const templateId = "prompt-template-1";
const promptVersionId = "prompt-version-1";
const repositoryId = "repository-1";
const profileId = "validation-profile-1";
const profileVersionId = "validation-profile-version-1";
const workItemId = "work-item-1";
const promptsPath = "/api/v1/operator/prompts";
const templatePath = `${promptsPath}/${templateId}`;
const bindingsPath = "/api/v1/operator/prompt-bindings";
const repositoryPath = `/api/v1/operator/repositories/${repositoryId}`;
const profilesPath = `${repositoryPath}/validation-profiles`;
const profileBindingsPath = `${repositoryPath}/validation-profile-bindings`;
const workflowKind = "pr_static_build";

const session: OperatorSession = {
  issuer: "https://identity.example.com",
  subject: "ordinary-user-123",
  displayName: "Ordinary User",
  email: "user@example.com",
  createdAt: timestamp,
  expiresAt: "2026-09-07T01:00:00.000Z",
};
const actor = { issuer: session.issuer, subject: session.subject };
const createdBy = JSON.stringify([actor.issuer, actor.subject]);

const promptRequest = {
  name: "Static and build review",
  description: "Review source changes and build evidence.",
  workflowKind,
  content: "Review the pull request and report reproducible findings.",
  outputSchemaVersion: "PrReviewPlanV2",
} satisfies PromptTemplateCreateRequest;
const templateSummary = {
  id: templateId,
  name: promptRequest.name,
  description: promptRequest.description,
  workflowKind,
  version: 1,
  draftRevision: 1,
  draftOutputSchemaVersion: "PrReviewPlanV2",
  latestPublishedVersionId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
} satisfies PromptTemplateSummary;
const template = {
  ...templateSummary,
  draftContent: promptRequest.content,
} satisfies PromptTemplate;
const promptVersionSummary = {
  id: promptVersionId,
  templateId,
  version: 1,
  contentSha256: createHash("sha256").update(promptRequest.content).digest("hex"),
  outputSchemaVersion: "PrReviewPlanV2",
  createdAt: timestamp,
  publishedAt: timestamp,
  createdBy,
} satisfies PromptVersionSummary;
const promptVersion = {
  ...promptVersionSummary,
  content: promptRequest.content,
} satisfies PromptVersion;
const globalBinding = {
  repositoryId: null,
  workflowKind,
  promptVersionId,
  version: 1,
} satisfies PromptBinding;
const repositoryBinding = { ...globalBinding, repositoryId } satisfies PromptBinding;
const profileConfig = {
  schemaVersion: "ValidationProfileV1",
  setup: [],
  build: [
    {
      id: "compile",
      name: "Compile the project",
      command: {
        executable: "dotnet",
        args: ["build", "--no-restore"],
        workingDirectory: ".",
        environment: [{ name: "CI", value: "true" }],
      },
      timeoutMs: 60_000,
      required: true,
    },
  ],
  test: [],
  launch: [],
  cleanup: [],
  requiredCapabilities: ["tool.dotnet"],
  hardTimeoutMs: 600_000,
  noProgressTimeoutMs: 120_000,
} satisfies ValidationProfileConfig;
const profileRequest = {
  name: "Build validation",
  workflowKind,
  target: "headless",
  config: profileConfig,
  outputSchemaVersion: "PrReviewPlanV2",
  required: true,
} satisfies ValidationProfileCreateRequest;
const profileVersionSummary = {
  id: profileVersionId,
  profileId,
  repositoryId,
  name: profileRequest.name,
  workflowKind,
  target: "headless",
  outputSchemaVersion: "PrReviewPlanV2",
  required: true,
  version: 1,
  configSha256: "b".repeat(64),
  createdAt: timestamp,
  publishedAt: timestamp,
  createdBy,
} satisfies ValidationProfileVersionSummary;
const profileVersion = {
  ...profileVersionSummary,
  config: profileConfig,
} satisfies ValidationProfileVersion;
const profileBinding = {
  repositoryId,
  profileId,
  profileVersionId,
  enabled: true,
  version: 1,
} satisfies RepositoryValidationProfileBinding;
const previewRequest = { content: "Review {{workItem.title}}.", workItemId };
const previewResponse = {
  renderedContent: "Review the reported regression.",
  contentSha256: "c".repeat(64),
  workItemId,
  repositoryId,
} satisfies PromptPreviewResponse;
const draftRequest = {
  expectedVersion: 1,
  content: "Inspect the changed lines and their build evidence.",
  outputSchemaVersion: "PrReviewPlanV2",
};
const bindingRequest = { expectedVersion: 0, promptVersionId };
const profileBindingRequest = { expectedVersion: 0, profileVersionId, enabled: true };

const page = <T>(items: T[], pageNumber = 1, pageSize = 20, total = items.length) => ({
  items,
  total,
  page: pageNumber,
  pageSize,
});
const bindingHistory = (binding: PromptBinding) => ({
  ...binding,
  id: "prompt-binding-history-1",
  previousVersionId: null,
  createdAt: timestamp,
  createdBy,
});
const profileBindingHistory = {
  ...profileBinding,
  id: "profile-binding-history-1",
  previousVersionId: null,
  createdAt: timestamp,
  createdBy,
};

interface RouteRequest {
  readonly name: string;
  readonly method: "GET" | "POST" | "PATCH" | "PUT";
  readonly url: string;
  readonly payload?: object | string;
}

interface ReadRouteCase {
  readonly name: string;
  readonly url: string;
  readonly operation: PromptConfigurationOperation;
  readonly input: object;
  readonly output: unknown;
  readonly response?: unknown;
}

const readRoutes: readonly ReadRouteCase[] = [
  {
    name: "template list",
    url: promptsPath,
    operation: "listPromptTemplates",
    input: { page: 1, pageSize: 20 },
    output: page([templateSummary]),
  },
  {
    name: "template detail",
    url: templatePath,
    operation: "getPromptTemplate",
    input: { templateId },
    output: template,
  },
  {
    name: "prompt version list",
    url: `${templatePath}/versions`,
    operation: "listPromptVersions",
    input: { templateId, page: 1, pageSize: 20 },
    output: page([promptVersionSummary]),
  },
  {
    name: "prompt version detail",
    url: `${templatePath}/versions/${promptVersionId}`,
    operation: "getPromptVersion",
    input: { templateId, versionId: promptVersionId },
    output: promptVersion,
  },
  {
    name: "global binding list",
    url: bindingsPath,
    operation: "listPromptBindings",
    input: { repositoryId: null },
    output: [globalBinding],
    response: { items: [globalBinding] },
  },
  {
    name: "global binding history",
    url: `${bindingsPath}/${workflowKind}/history`,
    operation: "listPromptBindingHistory",
    input: { repositoryId: null, workflowKind, page: 1, pageSize: 20 },
    output: page([bindingHistory(globalBinding)]),
  },
  {
    name: "repository binding list",
    url: `${repositoryPath}/prompt-bindings`,
    operation: "listPromptBindings",
    input: { repositoryId },
    output: [repositoryBinding],
    response: { items: [repositoryBinding] },
  },
  {
    name: "repository binding history",
    url: `${repositoryPath}/prompt-bindings/${workflowKind}/history`,
    operation: "listPromptBindingHistory",
    input: { repositoryId, workflowKind, page: 1, pageSize: 20 },
    output: page([bindingHistory(repositoryBinding)]),
  },
  {
    name: "validation profile list",
    url: profilesPath,
    operation: "listValidationProfiles",
    input: { repositoryId, page: 1, pageSize: 20 },
    output: page([profileVersionSummary]),
  },
  {
    name: "validation profile version list",
    url: `${profilesPath}/${profileId}/versions`,
    operation: "listValidationProfileVersions",
    input: { repositoryId, profileId, page: 1, pageSize: 20 },
    output: page([profileVersionSummary]),
  },
  {
    name: "validation profile version detail",
    url: `${profilesPath}/${profileId}/versions/${profileVersionId}`,
    operation: "getValidationProfileVersion",
    input: { repositoryId, profileId, versionId: profileVersionId },
    output: profileVersion,
  },
  {
    name: "validation profile binding list",
    url: profileBindingsPath,
    operation: "listValidationProfileBindings",
    input: { repositoryId, page: 1, pageSize: 20 },
    output: page([profileBinding]),
  },
  {
    name: "validation profile binding history",
    url: `${profileBindingsPath}/${profileId}/history`,
    operation: "listValidationProfileBindingHistory",
    input: { repositoryId, profileId, page: 1, pageSize: 20 },
    output: page([profileBindingHistory]),
  },
];

interface MutationRouteCase extends RouteRequest {
  readonly operation: PromptConfigurationOperation;
  readonly input: object;
  readonly output: unknown;
  readonly statusCode: number;
}

const mutationRoutes: readonly MutationRouteCase[] = [
  {
    name: "create template",
    method: "POST",
    url: promptsPath,
    payload: promptRequest,
    operation: "createPromptTemplate",
    input: { request: promptRequest, actor },
    output: template,
    statusCode: 201,
  },
  {
    name: "save draft",
    method: "PATCH",
    url: `${templatePath}/draft`,
    payload: draftRequest,
    operation: "savePromptDraft",
    input: { templateId, request: draftRequest, actor },
    output: { ...template, version: 2, draftRevision: 2, draftContent: draftRequest.content },
    statusCode: 200,
  },
  {
    name: "publish draft",
    method: "POST",
    url: `${templatePath}/publish`,
    payload: { expectedVersion: 1 },
    operation: "publishPromptDraft",
    input: { templateId, request: { expectedVersion: 1 }, actor },
    output: promptVersion,
    statusCode: 201,
  },
  {
    name: "save global binding",
    method: "PUT",
    url: `${bindingsPath}/${workflowKind}`,
    payload: bindingRequest,
    operation: "savePromptBinding",
    input: { repositoryId: null, workflowKind, request: bindingRequest, actor },
    output: globalBinding,
    statusCode: 200,
  },
  {
    name: "save repository binding",
    method: "PUT",
    url: `${repositoryPath}/prompt-bindings/${workflowKind}`,
    payload: bindingRequest,
    operation: "savePromptBinding",
    input: { repositoryId, workflowKind, request: bindingRequest, actor },
    output: repositoryBinding,
    statusCode: 200,
  },
  {
    name: "publish new validation profile",
    method: "POST",
    url: profilesPath,
    payload: profileRequest,
    operation: "publishValidationProfile",
    input: { repositoryId, request: profileRequest, actor },
    output: profileVersion,
    statusCode: 201,
  },
  {
    name: "publish existing validation profile",
    method: "POST",
    url: profilesPath,
    payload: { ...profileRequest, profileId, expectedVersion: 1 },
    operation: "publishValidationProfile",
    input: { repositoryId, request: { ...profileRequest, profileId, expectedVersion: 1 }, actor },
    output: { ...profileVersion, id: "validation-profile-version-2", version: 2 },
    statusCode: 201,
  },
  {
    name: "save validation profile binding",
    method: "PUT",
    url: `${profileBindingsPath}/${profileId}`,
    payload: profileBindingRequest,
    operation: "saveValidationProfileBinding",
    input: { repositoryId, profileId, request: profileBindingRequest, actor },
    output: profileBinding,
    statusCode: 200,
  },
];
const previewRoute: RouteRequest = {
  name: "preview prompt",
  method: "POST",
  url: `${promptsPath}/preview`,
  payload: previewRequest,
};
const writeRequests: readonly RouteRequest[] = [...mutationRoutes, previewRoute];
const allRequests: readonly RouteRequest[] = [
  ...readRoutes.map((route) => ({ name: route.name, method: "GET" as const, url: route.url })),
  ...writeRequests,
];

const createAuth = (authenticated = true): OperatorAuthRouteService => ({
  publicOrigin,
  postLoginRedirectPath: "/",
  requiresLoopbackRequest: false,
  secureCookies: true,
  usesBrowserBinding: false,
  ensureBrowserBinding: vi.fn(() => undefined),
  startLogin: vi.fn(async () => ({ kind: "session" as const, sessionToken, session })),
  completeLogin: vi.fn(async () => {
    throw new Error("Not used by prompt configuration route tests.");
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
        throw new Error(`Unexpected operation: ${operation}`);
      }),
  );
};

const apps: FastifyInstance[] = [];
const createApp = (
  options: {
    readonly auth?: OperatorAuthRouteService;
    readonly database?: DatabaseClient;
    readonly readOnly?: boolean;
    readonly preview?: (
      input: PromptPreviewRequest,
      actor: OperatorPrincipal,
    ) => Promise<PromptPreviewResponse>;
  } = {},
) => {
  const auth = options.auth ?? createAuth();
  const database = options.database ?? createDatabase().database;
  const app = Fastify({ logger: false });
  apps.push(app);
  registerOperatorAuthRoutes(app, auth);
  registerPromptConfigurationRoutes(app, {
    database,
    operatorAuth: auth,
    readOnly: options.readOnly ?? false,
    ...(options.preview === undefined ? {} : { preview: options.preview }),
  });
  return { app, auth };
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

describe("operator prompt configuration routes", () => {
  it.each(
    readRoutes.filter(
      (route) => !("repositoryId" in route.input) || route.input.repositoryId === null,
    ),
  )("requires platform access for the global $name", async (route) => {
    const { database, transport } = createDatabase(async () => {
      throw new DatabaseRequestError(
        "Platform administrator permission is required.",
        "PLATFORM_FORBIDDEN",
      );
    });
    const { app } = createApp({ database });
    const response = await app.inject({ method: "GET", url: route.url, headers: cookieHeaders() });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "platform_forbidden", retryable: false });
    expect(transport).toHaveBeenCalledExactlyOnceWith("operatorRequest", {
      context: { kind: "operator", actor },
      operation: route.operation,
      input: route.input,
    });
  });

  it.each(
    readRoutes.filter(
      (route) => "repositoryId" in route.input && route.input.repositoryId !== null,
    ),
  )("binds the authenticated principal to the repository $name read", async (route) => {
    const { database, transport } = createDatabase(async () => route.output);
    const { app } = createApp({ database, readOnly: true });
    const response = await app.inject({ method: "GET", url: route.url, headers: cookieHeaders() });
    expect(response.statusCode).toBe(200);
    expect(transport).toHaveBeenCalledExactlyOnceWith("operatorRequest", {
      context: { kind: "operator", actor },
      operation: route.operation,
      input: route.input,
    });
  });

  it.each(mutationRoutes)(
    "preserves the permission rejection of $name without changing the actor",
    async (route) => {
      const { database, transport } = createDatabase(async () => {
        throw new DatabaseRequestError(
          "The operator cannot change this configuration.",
          "PLATFORM_FORBIDDEN",
        );
      });
      const { app } = createApp({ database });
      const response = await app.inject({
        method: route.method,
        url: route.url,
        ...(route.payload === undefined ? {} : { payload: route.payload }),
        headers: authenticatedHeaders(),
      });
      expect(response.statusCode).toBe(403);
      expect(transport).toHaveBeenCalledExactlyOnceWith("operatorRequest", {
        context: { kind: "operator", actor },
        operation: route.operation,
        input: route.input,
      });
    },
  );

  it("rejects an operator context in the HTTP body before accessing profiles", async () => {
    const { database, transport } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: profilesPath,
      payload: {
        ...profileRequest,
        context: { kind: "operator", actor: { issuer: "attacker", subject: "root" } },
      },
      headers: authenticatedHeaders(),
    });
    expect(response.statusCode).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(readRoutes)(
    "reads $name through the authenticated cookie without an Origin header",
    async (route) => {
      const { database, request } = createDatabase(async () => route.output);
      const { app, auth } = createApp({ database });
      const response = await app.inject({
        method: "GET",
        url: route.url,
        headers: cookieHeaders(),
      });

      expect(response.statusCode).toBe(200);
      expectNoStore(response);
      expect(response.json()).toEqual(route.response ?? route.output);
      expect(auth.getSession).toHaveBeenCalledWith(sessionToken, undefined);
      expect(request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
    },
  );

  it.each(mutationRoutes)(
    "completes $name with the authenticated actor and CAS request",
    async (route) => {
      const { database, request } = createDatabase(async () => route.output);
      const { app } = createApp({ database });
      const response = await app.inject({
        method: route.method,
        url: route.url,
        ...(route.payload === undefined ? {} : { payload: route.payload }),
        headers: authenticatedHeaders(),
      });

      expect(response.statusCode).toBe(route.statusCode);
      expectNoStore(response);
      expect(response.json()).toEqual(route.output);
      expect(request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
    },
  );

  it.each(allRequests)(
    "requires a cookie session for $name before accessing dependencies",
    async (route) => {
      const { database, request } = createDatabase();
      const preview = vi.fn(async () => previewResponse);
      const { app } = createApp({ database, preview });
      const response = await app.inject({
        method: route.method,
        url: route.url,
        ...(route.payload === undefined ? {} : { payload: route.payload }),
        headers: { origin: publicOrigin },
      });

      expect(response.statusCode).toBe(401);
      expectNoStore(response);
      expect(response.json()).toMatchObject({ code: "operator_authentication_required" });
      expect(request).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
    },
  );

  it("rejects a cookie whose operator session no longer exists", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database, auth: createAuth(false) });
    const response = await app.inject({
      method: "POST",
      url: promptsPath,
      payload: promptRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(401);
    expectNoStore(response);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(writeRequests)(
    "rejects a missing Origin for $name before reading the session",
    async (route) => {
      const { database, request } = createDatabase();
      const preview = vi.fn(async () => previewResponse);
      const { app, auth } = createApp({ database, preview });
      const response = await app.inject({
        method: route.method,
        url: route.url,
        ...(route.payload === undefined ? {} : { payload: route.payload }),
        headers: cookieHeaders(),
      });

      expect(response.statusCode).toBe(403);
      expectNoStore(response);
      expect(response.json()).toMatchObject({ code: "invalid_operator_auth_origin" });
      expect(auth.getSession).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["different", "https://attacker.example.com"],
    ["trailing slash", `${publicOrigin}/`],
    ["case changed", "https://REVIEW.example.com"],
    ["null", "null"],
    ["duplicated", [publicOrigin, publicOrigin]],
  ])("rejects a %s Origin before session or database access", async (_name, origin) => {
    const { database, request } = createDatabase();
    const { app, auth } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: promptsPath,
      payload: promptRequest,
      headers: { ...cookieHeaders(), origin } as Record<string, string | string[]>,
    });

    expect(response.statusCode).toBe(403);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "invalid_operator_auth_origin" });
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(writeRequests)("blocks $name during read-only recovery", async (route) => {
    const { database, request } = createDatabase();
    const preview = vi.fn(async () => previewResponse);
    const { app } = createApp({ database, preview, readOnly: true });
    const response = await app.inject({
      method: route.method,
      url: route.url,
      ...(route.payload === undefined ? {} : { payload: route.payload }),
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(503);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_read_only" });
    expect(request).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it("continues to read configuration during read-only recovery", async () => {
    const { database, request } = createDatabase(async () => page([templateSummary]));
    const { app } = createApp({ database, readOnly: true });
    const response = await app.inject({
      method: "GET",
      url: promptsPath,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expectNoStore(response);
    expect(request).toHaveBeenCalledOnce();
  });

  it("passes an explicit workflow filter and bounded pagination to the database", async () => {
    const output = page([templateSummary], 3, 50, 101);
    const { database, request } = createDatabase(async () => output);
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: `${promptsPath}?workflowKind=${workflowKind}&page=3&pageSize=50`,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
    expect(request).toHaveBeenCalledExactlyOnceWith("listPromptTemplates", {
      workflowKind,
      page: 3,
      pageSize: 50,
    });
  });

  it.each([
    ["unknown field", "?unknown=1"],
    ["duplicate page", "?page=1&page=2"],
    ["duplicate page size", "?pageSize=10&pageSize=20"],
    ["duplicate workflow", `?workflowKind=${workflowKind}&workflowKind=${workflowKind}`],
    ["empty page", "?page="],
    ["zero page", "?page=0"],
    ["leading zero", "?page=01"],
    ["fractional page", "?page=1.5"],
    ["signed page", "?page=%2B1"],
    ["exponential page", "?page=1e2"],
    ["zero page size", "?pageSize=0"],
    ["oversized page", "?page=9007199254740992"],
    ["oversized page size", "?pageSize=51"],
    ["overflowing offset", "?page=9007199254740991&pageSize=2"],
  ])("rejects a %s query before database access", async (_name, query) => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: `${promptsPath}${query}`,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_query_invalid" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(allRequests)("rejects unsupported query fields for $name", async (route) => {
    const { database, request } = createDatabase();
    const preview = vi.fn(async () => previewResponse);
    const { app } = createApp({ database, preview });
    const response = await app.inject({
      method: route.method,
      url: `${route.url}?unknown=1`,
      ...(route.payload === undefined ? {} : { payload: route.payload }),
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "configuration_query_invalid" });
    expect(request).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it("rejects unsupported workflow filter values before database access", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: `${promptsPath}?workflowKind=unsupported`,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "configuration_request_invalid" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["template", `${promptsPath}/-invalid`],
    ["prompt version", `${templatePath}/versions/-invalid`],
    ["repository", "/api/v1/operator/repositories/-invalid/prompt-bindings"],
    ["profile", `${profilesPath}/-invalid/versions`],
    ["profile version", `${profilesPath}/${profileId}/versions/-invalid`],
    ["binding workflow", `${bindingsPath}/unsupported/history`],
  ])("rejects an invalid %s path before database access", async (_name, url) => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({ method: "GET", url, headers: cookieHeaders() });

    expect(response.statusCode).toBe(400);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_request_invalid" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1, null])(
    "rejects draft CAS value %s before database access",
    async (expectedVersion) => {
      const { database, request } = createDatabase();
      const { app } = createApp({ database });
      for (const method of ["PATCH", "POST"] as const) {
        const response = await app.inject({
          method,
          url: `${templatePath}/${method === "PATCH" ? "draft" : "publish"}`,
          payload: method === "PATCH" ? { ...draftRequest, expectedVersion } : { expectedVersion },
          headers: authenticatedHeaders(),
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ code: "configuration_request_invalid" });
      }
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "missing draft CAS",
      method: "PATCH",
      url: `${templatePath}/draft`,
      payload: { content: "Review this change.", outputSchemaVersion: "PrReviewPlanV2" },
    },
    {
      name: "missing publication CAS",
      method: "POST",
      url: `${templatePath}/publish`,
      payload: {},
    },
    {
      name: "negative binding CAS",
      method: "PUT",
      url: `${bindingsPath}/${workflowKind}`,
      payload: { ...bindingRequest, expectedVersion: -1 },
    },
    {
      name: "fractional profile binding CAS",
      method: "PUT",
      url: `${profileBindingsPath}/${profileId}`,
      payload: { ...profileBindingRequest, expectedVersion: 0.5 },
    },
    {
      name: "existing profile without CAS",
      method: "POST",
      url: profilesPath,
      payload: { ...profileRequest, profileId },
    },
    {
      name: "existing profile with zero CAS",
      method: "POST",
      url: profilesPath,
      payload: { ...profileRequest, profileId, expectedVersion: 0 },
    },
    {
      name: "invalid bound prompt version",
      method: "PUT",
      url: `${bindingsPath}/${workflowKind}`,
      payload: { ...bindingRequest, promptVersionId: "-invalid" },
    },
    {
      name: "invalid bound profile version",
      method: "PUT",
      url: `${profileBindingsPath}/${profileId}`,
      payload: { ...profileBindingRequest, profileVersionId: "-invalid" },
    },
    {
      name: "mismatched prompt workflow schema",
      method: "POST",
      url: promptsPath,
      payload: { ...promptRequest, outputSchemaVersion: "IssueTriageV2" },
    },
    {
      name: "unsupported draft output schema",
      method: "PATCH",
      url: `${templatePath}/draft`,
      payload: { ...draftRequest, outputSchemaVersion: "ValidationReportV1" },
    },
    {
      name: "invalid preview work item",
      method: "POST",
      url: `${promptsPath}/preview`,
      payload: { ...previewRequest, workItemId: "-invalid" },
    },
  ] satisfies RouteRequest[])("rejects $name before database or preview access", async (route) => {
    const { database, request } = createDatabase();
    const preview = vi.fn(async () => previewResponse);
    const { app } = createApp({ database, preview });
    const response = await app.inject({
      method: route.method,
      url: route.url,
      ...(route.payload === undefined ? {} : { payload: route.payload }),
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "configuration_request_invalid" });
    expect(request).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it.each(writeRequests)("rejects forged actor fields in $name", async (route) => {
    const { database, request } = createDatabase();
    const preview = vi.fn(async () => previewResponse);
    const { app } = createApp({ database, preview });
    const response = await app.inject({
      method: route.method,
      url: route.url,
      payload: {
        ...(route.payload as object),
        actor: { issuer: "https://attacker.example.com", subject: "forged-operator" },
        createdBy: "forged-operator",
      },
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "configuration_request_invalid" });
    expect(request).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["blank", " \n\t"],
    ["NUL", "Review\0this change."],
    ["oversized UTF-8", "\u4e2d".repeat(87_382)],
    ["unpaired surrogate", "Review \ud800."],
  ])("rejects %s content in create, draft, and preview requests", async (_name, content) => {
    const { database, request } = createDatabase();
    const preview = vi.fn(async () => previewResponse);
    const { app } = createApp({ database, preview });
    for (const route of [
      { method: "POST", url: promptsPath, payload: { ...promptRequest, content } },
      { method: "PATCH", url: `${templatePath}/draft`, payload: { ...draftRequest, content } },
      { method: "POST", url: `${promptsPath}/preview`, payload: { ...previewRequest, content } },
    ] as const) {
      const response = await app.inject({ ...route, headers: authenticatedHeaders() });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "configuration_request_invalid" });
    }
    expect(request).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it.each([
    [
      "no-progress timeout above the hard timeout",
      { ...profileConfig, noProgressTimeoutMs: 600_001 },
    ],
    ["duplicate step IDs", { ...profileConfig, test: profileConfig.build }],
    [
      "step timeout above the hard timeout",
      { ...profileConfig, hardTimeoutMs: 30_000, noProgressTimeoutMs: 10_000 },
    ],
    [
      "inline secret environment variable",
      {
        ...profileConfig,
        build: [
          {
            ...profileConfig.build[0],
            command: {
              ...profileConfig.build[0]?.command,
              environment: [{ name: "API_TOKEN", value: "untrusted-inline-secret" }],
            },
          },
        ],
      },
    ],
  ])("rejects a profile with %s before publication", async (_name, config) => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: profilesPath,
      payload: { ...profileRequest, config },
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "configuration_request_invalid" });
    expect(response.body).not.toContain("untrusted-inline-secret");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects executable steps in an issue triage profile", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: profilesPath,
      payload: {
        ...profileRequest,
        workflowKind: "issue_triage",
        outputSchemaVersion: "IssueTriageV2",
      },
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "configuration_request_invalid" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON without accessing the database", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: promptsPath,
      payload: "{",
      headers: { ...authenticatedHeaders(), "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expectNoStore(response);
    expect(request).not.toHaveBeenCalled();
  });

  it("returns not found when a prompt template does not exist", async () => {
    const { database, request } = createDatabase(async () => null);
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: templatePath,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(404);
    expectNoStore(response);
    expect(request).toHaveBeenCalledExactlyOnceWith("getPromptTemplate", { templateId });
  });

  it.each([
    ["PLATFORM_INVALID", 400, "platform_invalid"],
    ["PLATFORM_NOT_FOUND", 404, "platform_not_found"],
    ["PLATFORM_CONFLICT", 409, "platform_conflict"],
  ] as const)("maps %s database errors to HTTP %s", async (code, statusCode, responseCode) => {
    const { database, request } = createDatabase(async () => {
      throw new DatabaseRequestError("The configuration changed. Reload it before saving.", code);
    });
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: `${templatePath}/publish`,
      payload: { expectedVersion: 1 },
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(statusCode);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: responseCode, retryable: false });
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not expose unexpected database errors", async () => {
    const { database } = createDatabase(async () => {
      throw new Error("Internal connection string: private-database-location");
    });
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: promptsPath,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "configuration_operation_failed" });
    expect(response.body).not.toContain("private-database-location");
  });

  it.each([
    {
      name: "unexpected template fields",
      url: templatePath,
      output: { ...template, privateField: "private-response-value" },
    },
    { name: "full template content in a summary", url: promptsPath, output: page([template]) },
    {
      name: "full version content in a summary",
      url: `${templatePath}/versions`,
      output: page([promptVersion]),
    },
    { name: "incorrect page echo", url: promptsPath, output: page([templateSummary], 2) },
    { name: "incorrect page size echo", url: promptsPath, output: page([templateSummary], 1, 50) },
    {
      name: "too many page items",
      url: `${promptsPath}?pageSize=1`,
      output: page([templateSummary, { ...templateSummary, id: "prompt-template-2" }], 1, 1),
    },
    {
      name: "different template detail ID",
      url: templatePath,
      output: { ...template, id: "other-template" },
    },
    {
      name: "different prompt version scope",
      url: `${templatePath}/versions/${promptVersionId}`,
      output: { ...promptVersion, templateId: "other-template" },
    },
    {
      name: "different prompt version ID",
      url: `${templatePath}/versions/${promptVersionId}`,
      output: { ...promptVersion, id: "other-version" },
    },
    {
      name: "different prompt version list scope",
      url: `${templatePath}/versions`,
      output: page([{ ...promptVersionSummary, templateId: "other-template" }]),
    },
    {
      name: "global binding in a repository list",
      url: `${repositoryPath}/prompt-bindings`,
      output: [globalBinding],
    },
    { name: "repository binding in a global list", url: bindingsPath, output: [repositoryBinding] },
    {
      name: "too many global bindings",
      url: bindingsPath,
      output: Array.from({ length: 5 }, () => globalBinding),
    },
    {
      name: "different binding history scope",
      url: `${bindingsPath}/${workflowKind}/history`,
      output: page([bindingHistory(repositoryBinding)]),
    },
    {
      name: "different profile repository",
      url: `${profilesPath}/${profileId}/versions/${profileVersionId}`,
      output: { ...profileVersion, repositoryId: "other-repository" },
    },
    {
      name: "different profile ID",
      url: `${profilesPath}/${profileId}/versions/${profileVersionId}`,
      output: { ...profileVersion, profileId: "other-profile" },
    },
    {
      name: "different profile version ID",
      url: `${profilesPath}/${profileId}/versions/${profileVersionId}`,
      output: { ...profileVersion, id: "other-profile-version" },
    },
    {
      name: "full profile configuration in a summary",
      url: profilesPath,
      output: page([profileVersion]),
    },
    {
      name: "different profile list repository",
      url: profilesPath,
      output: page([{ ...profileVersionSummary, repositoryId: "other-repository" }]),
    },
    {
      name: "different profile binding repository",
      url: profileBindingsPath,
      output: page([{ ...profileBinding, repositoryId: "other-repository" }]),
    },
    {
      name: "different profile binding history scope",
      url: `${profileBindingsPath}/${profileId}/history`,
      output: page([{ ...profileBindingHistory, profileId: "other-profile" }]),
    },
  ])("rejects $name in database responses", async ({ url, output }) => {
    const { database } = createDatabase(async () => output);
    const { app } = createApp({ database });
    const response = await app.inject({ method: "GET", url, headers: cookieHeaders() });

    expect(response.statusCode).toBe(502);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_response_invalid" });
    expect(response.body).not.toContain("private-response-value");
  });

  it.each(mutationRoutes)("rejects unrecognized response fields after $name", async (route) => {
    const { database, request } = createDatabase(async () => ({
      ...(route.output as object),
      privateField: "private-mutation-response-value",
    }));
    const { app } = createApp({ database });
    const response = await app.inject({
      method: route.method,
      url: route.url,
      ...(route.payload === undefined ? {} : { payload: route.payload }),
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(502);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_response_invalid" });
    expect(response.body).not.toContain("private-mutation-response-value");
    expect(request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
  });

  it("rejects schema-valid response content exceeding the two MiB UTF-8 limit", async () => {
    const output = page(
      Array.from({ length: 50 }, (_, index) => ({
        ...promptVersionSummary,
        id: `prompt-version-${index + 1}`,
        version: index + 1,
        createdBy: "\u4e2d".repeat(16_384),
      })),
      1,
      50,
    );
    const { database } = createDatabase(async () => output);
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: `${templatePath}/versions?pageSize=50`,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(502);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_response_invalid" });
    expect(response.body.length).toBeLessThan(1_024);
  });

  it("returns unavailable when preview has no configured renderer", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: previewRoute.url,
      payload: previewRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(503);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "prompt_preview_unavailable" });
    expect(request).not.toHaveBeenCalled();
  });

  it("renders a preview through the callback without accessing the database", async () => {
    const { database, request } = createDatabase();
    const preview = vi.fn(async () => previewResponse);
    const { app } = createApp({ database, preview });
    const response = await app.inject({
      method: "POST",
      url: previewRoute.url,
      payload: previewRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expectNoStore(response);
    expect(response.json()).toEqual(previewResponse);
    expect(preview).toHaveBeenCalledExactlyOnceWith(previewRequest, actor);
    expect(request).not.toHaveBeenCalled();
  });

  it("supports a preview without a selected work item", async () => {
    const input = { content: "Review the selected change." };
    const output = { ...previewResponse, workItemId: null, repositoryId: null };
    const preview = vi.fn(async () => output);
    const { app } = createApp({ preview });
    const response = await app.inject({
      method: "POST",
      url: previewRoute.url,
      payload: input,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
    expect(preview).toHaveBeenCalledExactlyOnceWith(input, actor);
  });

  it.each([
    ["unexpected fields", { ...previewResponse, privateField: "private-preview-value" }],
    ["different work item", { ...previewResponse, workItemId: "other-work-item" }],
    ["invalid digest", { ...previewResponse, contentSha256: "invalid" }],
  ])("rejects preview output with %s", async (_name, output) => {
    const preview = vi.fn(async () => output as PromptPreviewResponse);
    const { app } = createApp({ preview });
    const response = await app.inject({
      method: "POST",
      url: previewRoute.url,
      payload: previewRequest,
      headers: authenticatedHeaders(),
    });

    expect(response.statusCode).toBe(502);
    expectNoStore(response);
    expect(response.json()).toMatchObject({ code: "configuration_response_invalid" });
    expect(response.body).not.toContain("private-preview-value");
  });
});
