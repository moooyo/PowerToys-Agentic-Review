import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  GitHubRepository,
  ManagedRepository,
  PromptBinding,
  PromptTemplate,
  PromptTemplateCreateRequest,
  PromptVersion,
  RepositoryValidationProfileBinding,
  ValidationProfileCreateRequest,
  ValidationProfileVersion,
} from "@agentic-review/contracts";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { DatabaseOperatorAuthPersistence } from "../../dist/database/operator-auth-persistence.js";
import {
  DEVELOPMENT_OPERATOR_SESSION_COOKIE,
  OPERATOR_LOGIN_PATH,
  OPERATOR_SESSION_PATH,
  registerOperatorAuthRoutes,
} from "../../dist/routes/auth.js";
import { registerPromptConfigurationRoutes } from "../../dist/routes/prompt-configuration.js";
import { registerRepositoryRoutes } from "../../dist/routes/repositories.js";
import { createPromptPreview } from "../../dist/runtime/prompt-preview.js";
import { canonicalJson } from "../../dist/scheduling/canonical-json.js";
import { OperatorAuthService } from "../../dist/security/operator-auth.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const publicOrigin = "http://127.0.0.1:8080";
const host = "127.0.0.1:8080";
const operator = {
  issuer: "urn:agentic-review:development",
  subject: "platform-integration-operator",
  displayName: "Platform Integration Operator",
  email: null,
};
const operatorRoot = "/api/v1/operator";
const repositoryRoot = `${operatorRoot}/repositories`;
const promptRoot = `${operatorRoot}/prompts`;
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const repositories: GitHubRepository[] = [1, 2].map((id) => ({
  githubRepositoryId: id,
  githubNodeId: `R_integration_${id}`,
  ownerLogin: "integration",
  name: `repository-${id}`,
  fullName: `integration/repository-${id}`,
  htmlUrl: `https://github.com/integration/repository-${id}`,
  defaultBranch: "main",
  isPrivate: false,
}));
const promptRequest: PromptTemplateCreateRequest = {
  name: "Integration review prompt",
  description: "Verify published configuration across a process restart.",
  workflowKind: "pr_static_build",
  content: "Review the original revision and cite reproducible evidence.",
  outputSchemaVersion: "PrReviewPlanV2",
};
const profileRequest: ValidationProfileCreateRequest = {
  name: "Integration build profile",
  workflowKind: "pr_static_build",
  target: "headless",
  outputSchemaVersion: "PrReviewPlanV2",
  required: true,
  config: {
    schemaVersion: "ValidationProfileV1",
    setup: [],
    build: [
      {
        id: "compile",
        name: "Build the project",
        command: { executable: "dotnet", args: ["build"], workingDirectory: ".", environment: [] },
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
  },
};

interface RuntimeFixture {
  readonly directory: string;
  readonly databasePath: string;
  app: FastifyInstance | undefined;
  database: DatabaseClient | undefined;
}

const fixtures: RuntimeFixture[] = [];

async function startRuntime(fixture: RuntimeFixture): Promise<void> {
  const database = await DatabaseClient.create({
    databasePath: fixture.databasePath,
    migrationsDirectory,
    operatorAccess: { administrators: [{ issuer: operator.issuer, subject: operator.subject }] },
  });
  fixture.database = database;
  expect(await database.request("ping", {})).toMatchObject({ schemaVersion: 31 });
  const auth = new OperatorAuthService({
    config: {
      mode: "loopback",
      environment: "development",
      publicOrigin,
      loginTransactionTtlSeconds: 600,
      sessionTtlSeconds: 3_600,
      postLoginRedirectPath: "/work-items",
      developmentIdentity: operator,
    },
    persistence: new DatabaseOperatorAuthPersistence(database),
  });
  const app = Fastify({ logger: false, bodyLimit: 2 * 1_024 * 1_024 });
  fixture.app = app;
  registerOperatorAuthRoutes(app, auth);
  registerRepositoryRoutes(app, {
    database,
    operatorAuth: auth,
    // GitHub is the only substituted external boundary. Authentication and storage are real.
    resolveRepository: async (fullName, expectedGithubRepositoryId) => {
      const repository = repositories.find((entry) => entry.fullName === fullName);
      if (repository === undefined)
        throw new Error("The integration repository is not configured.");
      if (expectedGithubRepositoryId !== undefined) {
        expect(expectedGithubRepositoryId).toBe(repository.githubRepositoryId);
      }
      return repository;
    },
  });
  registerPromptConfigurationRoutes(app, {
    database,
    operatorAuth: auth,
    preview: createPromptPreview(database),
  });
  await app.ready();
}

async function closeRuntime(fixture: RuntimeFixture): Promise<void> {
  try {
    await fixture.app?.close();
  } finally {
    fixture.app = undefined;
    await fixture.database?.close();
    fixture.database = undefined;
  }
}

async function createFixture(): Promise<RuntimeFixture> {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-platform-configuration-"));
  const fixture: RuntimeFixture = {
    directory,
    databasePath: join(directory, "server.sqlite"),
    app: undefined,
    database: undefined,
  };
  fixtures.push(fixture);
  await startRuntime(fixture);
  return fixture;
}

async function inject(fixture: RuntimeFixture, options: InjectOptions, expectedStatus: number) {
  if (fixture.app === undefined) throw new Error("The integration app is not running.");
  const response = await fixture.app.inject({
    ...options,
    remoteAddress: "127.0.0.1",
    headers: { host, ...options.headers },
  });
  expect(response.statusCode, response.body).toBe(expectedStatus);
  return response;
}

async function login(fixture: RuntimeFixture): Promise<string> {
  const response = await inject(
    fixture,
    {
      method: "POST",
      url: OPERATOR_LOGIN_PATH,
      headers: { origin: publicOrigin },
    },
    303,
  );
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const sessionCookie = cookies.find((value) =>
    value.startsWith(`${DEVELOPMENT_OPERATOR_SESSION_COOKIE}=`),
  );
  expect(sessionCookie).toBeDefined();
  if (sessionCookie === undefined) throw new Error("Login did not issue an operator session.");
  return sessionCookie.split(";", 1)[0] ?? "";
}

async function requestJson<T>(
  fixture: RuntimeFixture,
  cookie: string,
  method: "GET" | "POST" | "PATCH" | "PUT",
  url: string,
  expectedStatus = 200,
  payload?: object,
): Promise<T> {
  const response = await inject(
    fixture,
    {
      method,
      url,
      headers: { cookie, ...(method === "GET" ? {} : { origin: publicOrigin }) },
      ...(payload === undefined ? {} : { payload }),
    },
    expectedStatus,
  );
  return response.json<T>();
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await closeRuntime(fixture);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "linux")(
  "production platform configuration integration",
  () => {
    it("persists authenticated repository, prompt, profile, and binding state across a database-owner restart", async () => {
      const fixture = await createFixture();
      await inject(fixture, { method: "GET", url: repositoryRoot }, 401);
      const cookie = await login(fixture);
      const session = await requestJson<{ authenticated: boolean; operator: typeof operator }>(
        fixture,
        cookie,
        "GET",
        OPERATOR_SESSION_PATH,
      );
      expect(session).toMatchObject({ authenticated: true, operator });

      const managed: ManagedRepository[] = [];
      for (const repository of repositories) {
        managed.push(
          await requestJson<ManagedRepository>(fixture, cookie, "POST", repositoryRoot, 201, {
            githubRepositoryId: repository.githubRepositoryId,
            fullName: repository.fullName,
          }),
        );
      }
      const [first, second] = managed;
      if (first === undefined || second === undefined)
        throw new Error("Expected two managed repositories.");
      expect(first.connectionStatus).toBe("ready");
      const firstPath = `${repositoryRoot}/${first.id}`;
      const secondPath = `${repositoryRoot}/${second.id}`;
      const updatedRepository = await requestJson<ManagedRepository>(
        fixture,
        cookie,
        "PATCH",
        firstPath,
        200,
        {
          expectedVersion: first.version,
          enabled: true,
          reviewerGithubUserId: 100,
          reviewerGithubLogin: "reviewer",
          authorizationPolicy: {
            kind: "self_or_allowlist",
            policyVersion: 1,
            schedulingTargetGithubUserId: 100,
            allowlistedActorGithubUserIds: [200],
            unknownActorPolicy: "deny",
            newRevisionPolicy: "require_new_authorization",
          },
        },
      );
      expect(updatedRepository.version).toBe(2);

      const template = await requestJson<PromptTemplate>(
        fixture,
        cookie,
        "POST",
        promptRoot,
        201,
        promptRequest,
      );
      const templatePath = `${promptRoot}/${template.id}`;
      const versionOne = await requestJson<PromptVersion>(
        fixture,
        cookie,
        "POST",
        `${templatePath}/publish`,
        201,
        {
          expectedVersion: template.version,
        },
      );
      expect(versionOne.contentSha256).toBe(digest(promptRequest.content));
      expect(JSON.parse(versionOne.createdBy)).toEqual([operator.issuer, operator.subject]);
      const firstPromptBinding = await requestJson<PromptBinding>(
        fixture,
        cookie,
        "PUT",
        `${firstPath}/prompt-bindings/pr_static_build`,
        200,
        {
          expectedVersion: 0,
          promptVersionId: versionOne.id,
        },
      );
      expect(await requestJson(fixture, cookie, "GET", `${secondPath}/prompt-bindings`)).toEqual({
        items: [],
      });
      expect(
        await requestJson(
          fixture,
          cookie,
          "GET",
          `${secondPath}/prompt-bindings/pr_static_build/history`,
        ),
      ).toMatchObject({ items: [], total: 0 });

      const draft = await requestJson<PromptTemplate>(
        fixture,
        cookie,
        "PATCH",
        `${templatePath}/draft`,
        200,
        {
          expectedVersion: 2,
          content: "Review the original revision and include build evidence.",
          outputSchemaVersion: "PrReviewPlanV2",
        },
      );
      const versionTwo = await requestJson<PromptVersion>(
        fixture,
        cookie,
        "POST",
        `${templatePath}/publish`,
        201,
        {
          expectedVersion: draft.version,
        },
      );
      const secondPromptBinding = await requestJson<PromptBinding>(
        fixture,
        cookie,
        "PUT",
        `${secondPath}/prompt-bindings/pr_static_build`,
        200,
        {
          expectedVersion: 0,
          promptVersionId: versionTwo.id,
        },
      );
      expect(versionTwo.contentSha256).not.toBe(versionOne.contentSha256);

      const profileOne = await requestJson<ValidationProfileVersion>(
        fixture,
        cookie,
        "POST",
        `${firstPath}/validation-profiles`,
        201,
        profileRequest,
      );
      expect(profileOne.configSha256).toBe(digest(canonicalJson(profileRequest.config)));
      expect(JSON.parse(profileOne.createdBy)).toEqual([operator.issuer, operator.subject]);
      const profileBindingPath = `${firstPath}/validation-profile-bindings/${profileOne.profileId}`;
      const profileBinding = await requestJson<RepositoryValidationProfileBinding>(
        fixture,
        cookie,
        "PUT",
        profileBindingPath,
        200,
        {
          expectedVersion: 0,
          profileVersionId: profileOne.id,
          enabled: true,
        },
      );
      const profileTwo = await requestJson<ValidationProfileVersion>(
        fixture,
        cookie,
        "POST",
        `${firstPath}/validation-profiles`,
        201,
        {
          ...profileRequest,
          profileId: profileOne.profileId,
          expectedVersion: 1,
          config: { ...profileRequest.config, requiredCapabilities: ["tool.dotnet", "tool.git"] },
        },
      );
      expect(profileTwo.version).toBe(2);
      expect(profileTwo.configSha256).not.toBe(profileOne.configSha256);

      await requestJson(fixture, cookie, "PUT", profileBindingPath, 409, {
        expectedVersion: 0,
        profileVersionId: profileTwo.id,
        enabled: true,
      });
      for (const [method, path, payload] of [
        [
          "GET",
          `${secondPath}/validation-profiles/${profileOne.profileId}/versions/${profileOne.id}`,
          undefined,
        ],
        [
          "PUT",
          `${secondPath}/validation-profile-bindings/${profileOne.profileId}`,
          {
            expectedVersion: 0,
            profileVersionId: profileOne.id,
            enabled: true,
          },
        ],
        [
          "POST",
          `${secondPath}/validation-profiles`,
          {
            ...profileRequest,
            profileId: profileOne.profileId,
            expectedVersion: 2,
          },
        ],
      ] as const) {
        expect(await requestJson(fixture, cookie, method, path, 400, payload)).toMatchObject({
          code: "platform_invalid",
        });
      }
      expect(
        await requestJson(fixture, cookie, "GET", `${secondPath}/validation-profiles`),
      ).toMatchObject({ items: [], total: 0 });
      expect(
        await requestJson(fixture, cookie, "GET", `${secondPath}/validation-profile-bindings`),
      ).toMatchObject({ items: [], total: 0 });

      const firstPromptHistory = await requestJson(
        fixture,
        cookie,
        "GET",
        `${firstPath}/prompt-bindings/pr_static_build/history`,
      );
      const profileHistory = await requestJson(
        fixture,
        cookie,
        "GET",
        `${profileBindingPath}/history`,
      );
      const publishedTemplate = await requestJson<PromptTemplate>(
        fixture,
        cookie,
        "GET",
        templatePath,
      );
      expect(publishedTemplate.version).toBe(4);

      await closeRuntime(fixture);
      await startRuntime(fixture);

      expect(await requestJson(fixture, cookie, "GET", OPERATOR_SESSION_PATH)).toMatchObject({
        authenticated: true,
        operator,
      });
      expect(await requestJson(fixture, cookie, "GET", firstPath)).toEqual(updatedRepository);
      expect(await requestJson(fixture, cookie, "GET", secondPath)).toEqual(second);
      expect(await requestJson(fixture, cookie, "GET", templatePath)).toEqual(publishedTemplate);
      for (const version of [versionOne, versionTwo]) {
        expect(
          await requestJson(fixture, cookie, "GET", `${templatePath}/versions/${version.id}`),
        ).toEqual(version);
      }
      expect(await requestJson(fixture, cookie, "GET", `${firstPath}/prompt-bindings`)).toEqual({
        items: [firstPromptBinding],
      });
      expect(await requestJson(fixture, cookie, "GET", `${secondPath}/prompt-bindings`)).toEqual({
        items: [secondPromptBinding],
      });
      expect(
        await requestJson(
          fixture,
          cookie,
          "GET",
          `${firstPath}/prompt-bindings/pr_static_build/history`,
        ),
      ).toEqual(firstPromptHistory);
      for (const version of [profileOne, profileTwo]) {
        expect(
          await requestJson(
            fixture,
            cookie,
            "GET",
            `${firstPath}/validation-profiles/${version.profileId}/versions/${version.id}`,
          ),
        ).toEqual(version);
      }
      expect(
        await requestJson(fixture, cookie, "GET", `${firstPath}/validation-profile-bindings`),
      ).toMatchObject({
        items: [profileBinding],
        total: 1,
      });
      expect(await requestJson(fixture, cookie, "GET", `${profileBindingPath}/history`)).toEqual(
        profileHistory,
      );
      expect(
        await requestJson(fixture, cookie, "GET", `${secondPath}/validation-profile-bindings`),
      ).toMatchObject({ items: [], total: 0 });
      for (const [repositoryId, version] of [
        [first.id, versionOne],
        [second.id, versionTwo],
      ] as const) {
        expect(
          await fixture.database?.request("resolveWorkflowPrompt", {
            repositoryId,
            workflowKind: "pr_static_build",
          }),
        ).toMatchObject({ version: { id: version.id, content: version.content } });
      }

      await closeRuntime(fixture);
      const persisted = new DatabaseSync(fixture.databasePath, { readOnly: true });
      try {
        expect(
          persisted
            .prepare("SELECT COUNT(*) AS count, MAX(version) AS latest FROM schema_migrations")
            .get(),
        ).toEqual({ count: 31, latest: 31 });
        expect(persisted.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(
          persisted
            .prepare(
              "SELECT DISTINCT actor_issuer, actor_subject FROM repository_configuration_audit",
            )
            .all(),
        ).toEqual([{ actor_issuer: operator.issuer, actor_subject: operator.subject }]);
        expect(
          persisted.prepare("SELECT COUNT(*) AS count FROM repository_configuration_audit").get(),
        ).toEqual({ count: 3 });
      } finally {
        persisted.close();
      }
    }, 60_000);
  },
);
