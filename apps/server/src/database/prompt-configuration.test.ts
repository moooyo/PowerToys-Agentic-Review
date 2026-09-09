import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  PromptTemplateCreateRequest,
  ValidationProfileConfig,
  ValidationProfileCreateRequest,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../scheduling/canonical-json.js";
import { runMigrations } from "./migrations.js";
import {
  handlePromptConfigurationRequest,
  type PromptConfigurationOperation,
  type PromptConfigurationOperationMap,
  type PromptConfigurationRequest,
} from "./prompt-configuration.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const timestamp = "2026-09-07T00:00:00.000Z";
const laterTimestamp = "2026-09-07T01:00:00.000Z";
const actor = { issuer: "https://identity.example.test", subject: "operator-1" };
const databases: DatabaseSync[] = [];
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const promptRequest: PromptTemplateCreateRequest = {
  name: "Static and build review",
  description: "Review source changes and build evidence.",
  workflowKind: "pr_static_build",
  content: "Review the pull request and report reproducible findings.",
  outputSchemaVersion: "PrReviewPlanV2",
};

const profileConfig: ValidationProfileConfig = {
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
};

const profileRequest: ValidationProfileCreateRequest = {
  name: "Build validation",
  workflowKind: "pr_static_build",
  target: "headless",
  config: profileConfig,
  outputSchemaVersion: "PrReviewPlanV2",
  required: true,
};

const createDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  runMigrations(database, migrationsDirectory);
  for (const [id, githubRepositoryId, fullName] of [
    ["repository-1", 1, "example/first"],
    ["repository-2", 2, "example/second"],
  ] as const) {
    database
      .prepare(`
        INSERT INTO managed_repositories (
          id, github_repository_id, full_name, enabled, version, connection_status,
          configuration_source, created_at, updated_at
        ) VALUES (?, ?, ?, 1, 1, 'ready', 'operator', ?, ?)
      `)
      .run(id, githubRepositoryId, fullName, timestamp, timestamp);
  }
  return database;
};

const rowCount = (database: DatabaseSync, table: string): number => {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
};

const expectErrorCode = (operation: () => unknown, code: string): void => {
  expect(operation).toThrow(expect.objectContaining({ code }));
};

const execute = <Operation extends PromptConfigurationOperation>(
  database: DatabaseSync,
  operation: Operation,
  input: PromptConfigurationOperationMap[Operation]["input"],
  now = timestamp,
): PromptConfigurationOperationMap[Operation]["output"] =>
  handlePromptConfigurationRequest(
    database,
    { operation, input } as PromptConfigurationRequest,
    now,
  ) as PromptConfigurationOperationMap[Operation]["output"];

const createPublishedPrompt = (
  database: DatabaseSync,
  request: PromptTemplateCreateRequest = promptRequest,
) => {
  const template = execute(database, "createPromptTemplate", { request, actor });
  const published = execute(database, "publishPromptDraft", {
    templateId: template.id,
    request: { expectedVersion: template.version },
    actor,
  });
  return { template, published };
};

const publishProfile = (database: DatabaseSync, repositoryId = "repository-1") =>
  execute(database, "publishValidationProfile", { repositoryId, request: profileRequest, actor });

const auditCount = (database: DatabaseSync): number =>
  rowCount(database, "prompt_configuration_audit");

const failAuditWrites = (database: DatabaseSync, action?: string): void => {
  database.exec(`
    CREATE TEMP TRIGGER reject_test_audit BEFORE INSERT ON prompt_configuration_audit
    ${action === undefined ? "" : `WHEN NEW.action = '${action}'`}
    BEGIN SELECT RAISE(ABORT, 'Injected audit failure'); END;
  `);
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("prompt template publication and bindings", () => {
  it("uses draft CAS and preserves every published version when the draft changes", () => {
    const database = createDatabase();
    const { template, published } = createPublishedPrompt(database);
    expect(template).toMatchObject({
      version: 1,
      draftRevision: 1,
      latestPublishedVersionId: null,
    });
    expect(published).toMatchObject({
      templateId: template.id,
      version: 1,
      content: promptRequest.content,
      contentSha256: sha256(promptRequest.content),
      createdBy: JSON.stringify([actor.issuer, actor.subject]),
    });
    const current = execute(database, "getPromptTemplate", { templateId: template.id });
    expect(current).toMatchObject({
      version: 2,
      draftRevision: 1,
      latestPublishedVersionId: published.id,
    });
    const changed = execute(
      database,
      "savePromptDraft",
      {
        templateId: template.id,
        request: {
          expectedVersion: 2,
          content: "Inspect the changed lines and their build evidence.",
          outputSchemaVersion: "PrReviewPlanV2",
        },
        actor,
      },
      laterTimestamp,
    );
    expect(changed).toMatchObject({
      version: 3,
      draftRevision: 2,
      latestPublishedVersionId: published.id,
    });
    const beforeRejectedSave = auditCount(database);
    expectErrorCode(
      () =>
        execute(database, "savePromptDraft", {
          templateId: template.id,
          request: {
            expectedVersion: 2,
            content: "Stale overwrite",
            outputSchemaVersion: "PrReviewPlanV2",
          },
          actor,
        }),
      "PLATFORM_CONFLICT",
    );
    expectErrorCode(
      () =>
        execute(database, "publishPromptDraft", {
          templateId: template.id,
          request: { expectedVersion: 2 },
          actor,
        }),
      "PLATFORM_CONFLICT",
    );
    expect(auditCount(database)).toBe(beforeRejectedSave);
    const second = execute(
      database,
      "publishPromptDraft",
      {
        templateId: template.id,
        request: { expectedVersion: changed.version },
        actor,
      },
      laterTimestamp,
    );
    expect(second).toMatchObject({
      version: 2,
      content: changed.draftContent,
      contentSha256: sha256(changed.draftContent),
    });
    expect(execute(database, "listPromptVersions", { templateId: template.id })).toMatchObject({
      items: [
        { id: second.id, version: 2 },
        { id: published.id, version: 1 },
      ],
      total: 2,
    });
    expect(
      execute(database, "getPromptVersion", { templateId: template.id, versionId: published.id }),
    ).toEqual(published);
    expect(execute(database, "getPromptTemplate", { templateId: template.id })).toMatchObject({
      version: 4,
      draftRevision: 2,
      latestPublishedVersionId: second.id,
    });
  });

  it("requires a workflow-compatible published version and an existing repository", () => {
    const database = createDatabase();
    const { template, published } = createPublishedPrompt(database);
    const save = (
      repositoryId: string | null,
      promptVersionId: string,
      workflowKind = "pr_static_build",
    ) =>
      handlePromptConfigurationRequest(
        database,
        {
          operation: "savePromptBinding",
          input: {
            repositoryId,
            workflowKind,
            request: { expectedVersion: 0, promptVersionId },
            actor,
          },
        } as PromptConfigurationRequest,
        timestamp,
      );
    expectErrorCode(() => save("repository-1", template.id), "PLATFORM_NOT_FOUND");
    expectErrorCode(() => save("repository-1", published.id, "issue_triage"), "PLATFORM_INVALID");
    expectErrorCode(() => save("missing-repository", published.id), "PLATFORM_NOT_FOUND");
    expectErrorCode(
      () =>
        execute(database, "savePromptDraft", {
          templateId: template.id,
          request: {
            expectedVersion: 2,
            content: "Use a different output contract.",
            outputSchemaVersion: "IssueTriageV2",
          },
          actor,
        }),
      "PLATFORM_INVALID",
    );
    expect(rowCount(database, "prompt_bindings")).toBe(0);
    expect(rowCount(database, "prompt_binding_history")).toBe(0);
    expect(auditCount(database)).toBe(2);
  });

  it("keeps repository overrides isolated from global updates and records rollback history", () => {
    const database = createDatabase();
    const first = createPublishedPrompt(database).published;
    const second = createPublishedPrompt(database, {
      ...promptRequest,
      content: "Updated global review instructions.",
    }).published;
    const bind = (repositoryId: string | null, expectedVersion: number, promptVersionId: string) =>
      execute(database, "savePromptBinding", {
        repositoryId,
        workflowKind: "pr_static_build",
        request: { expectedVersion, promptVersionId },
        actor,
      });
    bind(null, 0, first.id);
    const override = bind("repository-1", 0, first.id);
    bind(null, 1, second.id);
    expect(execute(database, "listPromptBindings", { repositoryId: null })).toEqual([
      {
        repositoryId: null,
        workflowKind: "pr_static_build",
        promptVersionId: second.id,
        version: 2,
      },
    ]);
    expect(execute(database, "listPromptBindings", { repositoryId: "repository-1" })).toEqual([
      override,
    ]);
    expect(execute(database, "listPromptBindings", { repositoryId: "repository-2" })).toEqual([]);
    const auditBeforeConflict = auditCount(database);
    expectErrorCode(() => bind(null, 1, first.id), "PLATFORM_CONFLICT");
    expect(auditCount(database)).toBe(auditBeforeConflict);
    bind(null, 2, first.id);
    const history = execute(database, "listPromptBindingHistory", {
      repositoryId: null,
      workflowKind: "pr_static_build",
    });
    expect(history.total).toBe(3);
    expect(
      history.items.map(({ version, promptVersionId, previousVersionId }) => ({
        version,
        promptVersionId,
        previousVersionId,
      })),
    ).toEqual([
      { version: 3, promptVersionId: first.id, previousVersionId: second.id },
      { version: 2, promptVersionId: second.id, previousVersionId: first.id },
      { version: 1, promptVersionId: first.id, previousVersionId: null },
    ]);
    expect(
      history.items.every(
        (entry) => entry.createdBy === JSON.stringify([actor.issuer, actor.subject]),
      ),
    ).toBe(true);
  });

  it.each([
    ["UTF-8 byte overflow", "\u754c".repeat(90_000)],
    ["unpaired surrogate", "Invalid \ud800 input"],
    ["whitespace only", " \t\n "],
    ["embedded NUL", "Before\0after"],
  ])("rejects %s prompt content before creating a template", (_label, content) => {
    const database = createDatabase();
    expectErrorCode(
      () =>
        execute(database, "createPromptTemplate", {
          request: { ...promptRequest, content },
          actor,
        }),
      "PLATFORM_INVALID",
    );
    expect(rowCount(database, "prompt_templates")).toBe(0);
    expect(auditCount(database)).toBe(0);
  });

  it("accepts exact UTF-8 byte limits and hashes persisted text without normalization", () => {
    const database = createDatabase();
    const content = `${"\u754c".repeat(87_381)}!`;
    expect(Buffer.byteLength(content, "utf8")).toBe(262_144);
    const { published } = createPublishedPrompt(database, { ...promptRequest, content });
    expect(published.content).toBe(content);
    expect(published.contentSha256).toBe(sha256(content));
  });

  it("rolls back draft creation and publication if audit persistence fails", () => {
    const database = createDatabase();
    failAuditWrites(database);
    expect(() =>
      execute(database, "createPromptTemplate", { request: promptRequest, actor }),
    ).toThrow("Injected audit failure");
    expect(rowCount(database, "prompt_templates")).toBe(0);
    expect(auditCount(database)).toBe(0);
    database.exec("DROP TRIGGER reject_test_audit");
    const template = execute(database, "createPromptTemplate", { request: promptRequest, actor });
    failAuditWrites(database);
    expect(() =>
      execute(database, "publishPromptDraft", {
        templateId: template.id,
        request: { expectedVersion: 1 },
        actor,
      }),
    ).toThrow("Injected audit failure");
    expect(rowCount(database, "prompt_versions")).toBe(0);
    expect(execute(database, "getPromptTemplate", { templateId: template.id })).toEqual(template);
    expect(auditCount(database)).toBe(1);
    database.exec("DROP TRIGGER reject_test_audit");
    expect(
      execute(database, "publishPromptDraft", {
        templateId: template.id,
        request: { expectedVersion: 1 },
        actor,
      }).version,
    ).toBe(1);
  });

  it("rolls back prompt binding state and history together if audit persistence fails", () => {
    const database = createDatabase();
    const first = createPublishedPrompt(database).published;
    const second = createPublishedPrompt(database).published;
    const input = {
      repositoryId: "repository-1",
      workflowKind: "pr_static_build",
      request: { expectedVersion: 0, promptVersionId: first.id },
      actor,
    } as const;
    const initial = execute(database, "savePromptBinding", input);
    const before = auditCount(database);
    failAuditWrites(database);
    expect(() =>
      execute(database, "savePromptBinding", {
        ...input,
        request: { expectedVersion: 1, promptVersionId: second.id },
      }),
    ).toThrow("Injected audit failure");
    expect(execute(database, "listPromptBindings", { repositoryId: "repository-1" })).toEqual([
      initial,
    ]);
    expect(rowCount(database, "prompt_binding_history")).toBe(1);
    expect(auditCount(database)).toBe(before);
  });
});

describe("validation profile publication and bindings", () => {
  it.each(["setup", "build", "test", "launch", "cleanup"] as const)(
    "rejects executable %s steps in an issue-triage profile",
    (stage) => {
      const database = createDatabase();
      const config: ValidationProfileConfig = {
        ...profileConfig,
        setup: [],
        build: [],
        test: [],
        launch: [],
        cleanup: [],
        [stage]: profileConfig.build,
      };
      expectErrorCode(
        () =>
          execute(database, "publishValidationProfile", {
            repositoryId: "repository-1",
            request: {
              ...profileRequest,
              workflowKind: "issue_triage",
              outputSchemaVersion: "IssueTriageV2",
              config,
            },
            actor,
          }),
        "PLATFORM_INVALID",
      );
      expect(rowCount(database, "validation_profiles")).toBe(0);
      expect(auditCount(database)).toBe(0);
    },
  );

  it("accepts an issue-triage profile with no executable steps", () => {
    const database = createDatabase();
    const config: ValidationProfileConfig = {
      ...profileConfig,
      setup: [],
      build: [],
      test: [],
      launch: [],
      cleanup: [],
    };
    const result = execute(database, "publishValidationProfile", {
      repositoryId: "repository-1",
      request: {
        ...profileRequest,
        workflowKind: "issue_triage",
        outputSchemaVersion: "IssueTriageV2",
        config,
      },
      actor,
    });
    expect(result).toMatchObject({
      workflowKind: "issue_triage",
      outputSchemaVersion: "IssueTriageV2",
      target: "headless",
      config,
    });
    expect(auditCount(database)).toBe(1);
  });

  it("publishes immutable versions with CAS while keeping the bound version explicit", () => {
    const database = createDatabase();
    const first = publishProfile(database);
    const binding = execute(database, "saveValidationProfileBinding", {
      repositoryId: "repository-1",
      profileId: first.profileId,
      request: { expectedVersion: 0, profileVersionId: first.id, enabled: true },
      actor,
    });
    const changed = {
      ...profileRequest,
      name: "Required build validation",
      profileId: first.profileId,
      expectedVersion: 1,
    };
    const second = execute(
      database,
      "publishValidationProfile",
      { repositoryId: "repository-1", request: changed, actor },
      laterTimestamp,
    );
    expect(second).toMatchObject({
      profileId: first.profileId,
      version: 2,
      name: changed.name,
      config: profileConfig,
      configSha256: sha256(canonicalJson(profileConfig)),
      required: true,
    });
    expect(
      execute(database, "listValidationProfiles", { repositoryId: "repository-1" }),
    ).toMatchObject({ items: [{ id: second.id, version: 2 }], total: 1 });
    expect(
      execute(database, "listValidationProfileVersions", {
        repositoryId: "repository-1",
        profileId: first.profileId,
      }),
    ).toMatchObject({
      items: [
        { id: second.id, version: 2 },
        { id: first.id, version: 1 },
      ],
      total: 2,
    });
    expect(
      execute(database, "getValidationProfileVersion", {
        repositoryId: "repository-1",
        profileId: first.profileId,
        versionId: first.id,
      }),
    ).toEqual(first);
    expect(
      execute(database, "listValidationProfileBindings", { repositoryId: "repository-1" }),
    ).toMatchObject({ items: [binding], total: 1 });
    const before = auditCount(database);
    expectErrorCode(
      () =>
        execute(database, "publishValidationProfile", {
          repositoryId: "repository-1",
          request: changed,
          actor,
        }),
      "PLATFORM_CONFLICT",
    );
    expect(auditCount(database)).toBe(before);
    expect(rowCount(database, "validation_profile_versions")).toBe(2);
  });

  it("rejects cross-repository, workflow, target, and profile-version substitutions", () => {
    const database = createDatabase();
    const first = publishProfile(database);
    const other = publishProfile(database, "repository-2");
    const update = { ...profileRequest, profileId: first.profileId, expectedVersion: 1 };
    expectErrorCode(
      () =>
        execute(database, "publishValidationProfile", {
          repositoryId: "repository-2",
          request: update,
          actor,
        }),
      "PLATFORM_INVALID",
    );
    expectErrorCode(
      () =>
        execute(database, "publishValidationProfile", {
          repositoryId: "repository-1",
          request: {
            ...update,
            workflowKind: "pr_ui",
            target: "web",
            outputSchemaVersion: "ValidationReportV1",
          },
          actor,
        }),
      "PLATFORM_INVALID",
    );
    expectErrorCode(
      () =>
        execute(database, "saveValidationProfileBinding", {
          repositoryId: "repository-1",
          profileId: first.profileId,
          request: { expectedVersion: 0, profileVersionId: other.id, enabled: true },
          actor,
        }),
      "PLATFORM_INVALID",
    );
    expectErrorCode(
      () =>
        execute(database, "saveValidationProfileBinding", {
          repositoryId: "repository-2",
          profileId: first.profileId,
          request: { expectedVersion: 0, profileVersionId: first.id, enabled: true },
          actor,
        }),
      "PLATFORM_INVALID",
    );
    expectErrorCode(
      () =>
        execute(database, "listValidationProfileVersions", {
          repositoryId: "repository-2",
          profileId: first.profileId,
        }),
      "PLATFORM_INVALID",
    );
    const ui = execute(database, "publishValidationProfile", {
      repositoryId: "repository-1",
      request: {
        ...profileRequest,
        workflowKind: "pr_ui",
        target: "web",
        outputSchemaVersion: "ValidationReportV1",
      },
      actor,
    });
    expectErrorCode(
      () =>
        execute(database, "publishValidationProfile", {
          repositoryId: "repository-1",
          request: {
            ...profileRequest,
            profileId: ui.profileId,
            expectedVersion: 1,
            workflowKind: "pr_ui",
            target: "windows_desktop",
            outputSchemaVersion: "ValidationReportV1",
          },
          actor,
        }),
      "PLATFORM_INVALID",
    );
    expect(rowCount(database, "validation_profile_versions")).toBe(3);
    expect(rowCount(database, "validation_profile_bindings")).toBe(0);
    expect(auditCount(database)).toBe(3);
  });

  it("records profile activation, disabling, and rollback without losing prior versions", () => {
    const database = createDatabase();
    const first = publishProfile(database);
    const second = execute(database, "publishValidationProfile", {
      repositoryId: "repository-1",
      request: { ...profileRequest, profileId: first.profileId, expectedVersion: 1 },
      actor,
    });
    const bind = (expectedVersion: number, profileVersionId: string, enabled: boolean) =>
      execute(database, "saveValidationProfileBinding", {
        repositoryId: "repository-1",
        profileId: first.profileId,
        request: { expectedVersion, profileVersionId, enabled },
        actor,
      });
    bind(0, first.id, true);
    bind(1, second.id, true);
    bind(2, second.id, false);
    expectErrorCode(() => bind(2, first.id, true), "PLATFORM_CONFLICT");
    const rollback = bind(3, first.id, true);
    expect(rollback).toMatchObject({ version: 4, profileVersionId: first.id, enabled: true });
    const history = execute(database, "listValidationProfileBindingHistory", {
      repositoryId: "repository-1",
      profileId: first.profileId,
    });
    expect(history.total).toBe(4);
    expect(
      history.items.map(({ version, profileVersionId, previousVersionId, enabled }) => ({
        version,
        profileVersionId,
        previousVersionId,
        enabled,
      })),
    ).toEqual([
      { version: 4, profileVersionId: first.id, previousVersionId: second.id, enabled: true },
      { version: 3, profileVersionId: second.id, previousVersionId: second.id, enabled: false },
      { version: 2, profileVersionId: second.id, previousVersionId: first.id, enabled: true },
      { version: 1, profileVersionId: first.id, previousVersionId: null, enabled: true },
    ]);
  });

  it.each([
    [
      "no-progress timeout above the hard timeout",
      { ...profileConfig, noProgressTimeoutMs: 601_000 },
    ],
    [
      "step timeout above the hard timeout",
      { ...profileConfig, hardTimeoutMs: 30_000, noProgressTimeoutMs: 10_000 },
    ],
    ["duplicate step IDs across stages", { ...profileConfig, setup: profileConfig.build }],
    [
      "case-insensitive environment collisions",
      {
        ...profileConfig,
        build: profileConfig.build.map((step) => ({
          ...step,
          command: {
            ...step.command,
            environment: [
              { name: "Path", value: "first" },
              { name: "PATH", value: "second" },
            ],
          },
        })),
      },
    ],
    [
      "plaintext secret environment",
      {
        ...profileConfig,
        build: profileConfig.build.map((step) => ({
          ...step,
          command: { ...step.command, environment: [{ name: "API_TOKEN", value: "plaintext" }] },
        })),
      },
    ],
    [
      "UTF-8 configuration byte overflow",
      {
        ...profileConfig,
        build: profileConfig.build.map((step) => ({
          ...step,
          command: {
            ...step.command,
            args: Array.from({ length: 20 }, () => "\u754c".repeat(8_192)),
          },
        })),
      },
    ],
  ] satisfies [string, ValidationProfileConfig][])(
    "rejects %s without leaving a profile or audit record",
    (_label, config) => {
      const database = createDatabase();
      expectErrorCode(
        () =>
          execute(database, "publishValidationProfile", {
            repositoryId: "repository-1",
            request: { ...profileRequest, config },
            actor,
          }),
        "PLATFORM_INVALID",
      );
      expect(rowCount(database, "validation_profiles")).toBe(0);
      expect(rowCount(database, "validation_profile_versions")).toBe(0);
      expect(auditCount(database)).toBe(0);
    },
  );

  it("rolls back new profile identities, versions, bindings, and history on persistence failures", () => {
    const database = createDatabase();
    failAuditWrites(database);
    expect(() => publishProfile(database)).toThrow("Injected audit failure");
    expect(rowCount(database, "validation_profiles")).toBe(0);
    expect(rowCount(database, "validation_profile_versions")).toBe(0);
    expect(auditCount(database)).toBe(0);
    database.exec("DROP TRIGGER reject_test_audit");
    const profile = publishProfile(database);
    failAuditWrites(database);
    expect(() =>
      execute(database, "saveValidationProfileBinding", {
        repositoryId: "repository-1",
        profileId: profile.profileId,
        request: { expectedVersion: 0, profileVersionId: profile.id, enabled: true },
        actor,
      }),
    ).toThrow("Injected audit failure");
    expect(rowCount(database, "validation_profile_bindings")).toBe(0);
    expect(rowCount(database, "validation_profile_binding_history")).toBe(0);
    expect(auditCount(database)).toBe(1);
  });
});

describe("configuration reads and bootstrap", () => {
  it("bounds full pages while preserving worst-case encoded author attribution", () => {
    const database = createDatabase();
    const maximumActor = { issuer: "\u0001".repeat(2_048), subject: "\u0001".repeat(512) };
    const createdBy = JSON.stringify([maximumActor.issuer, maximumActor.subject]);
    expect(createdBy.length).toBeGreaterThan(15_000);
    const template = execute(database, "createPromptTemplate", {
      request: promptRequest,
      actor: maximumActor,
    });
    let currentProfileId: string | undefined;
    for (let version = 1; version <= 51; version += 1) {
      execute(database, "publishPromptDraft", {
        templateId: template.id,
        request: { expectedVersion: version },
        actor: maximumActor,
      });
      const profile = execute(database, "publishValidationProfile", {
        repositoryId: "repository-1",
        request:
          currentProfileId === undefined
            ? profileRequest
            : { ...profileRequest, profileId: currentProfileId, expectedVersion: version - 1 },
        actor: maximumActor,
      });
      currentProfileId = profile.profileId;
    }
    if (currentProfileId === undefined) throw new Error("The profile fixture was not created.");
    const promptPage = execute(database, "listPromptVersions", {
      templateId: template.id,
      pageSize: 50,
    });
    const profilePage = execute(database, "listValidationProfileVersions", {
      repositoryId: "repository-1",
      profileId: currentProfileId,
      pageSize: 50,
    });
    for (const result of [promptPage, profilePage]) {
      expect(result.total).toBe(51);
      expect(result.items).toHaveLength(50);
      expect(result.items.every((item) => item.createdBy === createdBy)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(2 * 1_024 * 1_024);
    }
    expect(
      execute(database, "listPromptVersions", { templateId: template.id, page: 2, pageSize: 50 }),
    ).toMatchObject({ total: 51, items: [{ version: 1, createdBy }] });
    expect(
      execute(database, "listValidationProfileVersions", {
        repositoryId: "repository-1",
        profileId: currentProfileId,
        page: 2,
        pageSize: 50,
      }),
    ).toMatchObject({ total: 51, items: [{ version: 1, createdBy }] });
  });

  it("paginates summaries without returning large prompt bodies or profile configurations", () => {
    const database = createDatabase();
    const largeContent = "Detailed review instructions.\n".repeat(8_000);
    const first = createPublishedPrompt(database, { ...promptRequest, content: largeContent });
    const second = createPublishedPrompt(database, {
      name: "Issue triage",
      workflowKind: "issue_triage",
      content: largeContent,
      outputSchemaVersion: "IssueTriageV2",
    });
    const newerDraft = execute(database, "savePromptDraft", {
      templateId: first.template.id,
      request: {
        expectedVersion: 2,
        content: `${largeContent}Additional instruction.`,
        outputSchemaVersion: "PrReviewPlanV2",
      },
      actor,
    });
    const latest = execute(database, "publishPromptDraft", {
      templateId: first.template.id,
      request: { expectedVersion: newerDraft.version },
      actor,
    });
    const firstPage = execute(database, "listPromptTemplates", { page: 1, pageSize: 1 });
    const secondPage = execute(database, "listPromptTemplates", { page: 2, pageSize: 1 });
    expect(firstPage).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(secondPage).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id))).toEqual(
      new Set([first.template.id, second.template.id]),
    );
    for (const item of [...firstPage.items, ...secondPage.items])
      expect(item).not.toHaveProperty("draftContent");
    expect(
      execute(database, "listPromptTemplates", { workflowKind: "issue_triage" }),
    ).toMatchObject({ total: 1, items: [{ id: second.template.id }] });
    expect(execute(database, "listPromptTemplates", { page: 3, pageSize: 1 })).toMatchObject({
      total: 2,
      items: [],
    });
    const versions = execute(database, "listPromptVersions", {
      templateId: first.template.id,
      page: 2,
      pageSize: 1,
    });
    expect(versions).toMatchObject({ total: 2, items: [{ id: first.published.id }] });
    expect(versions.items[0]).not.toHaveProperty("content");
    expect(
      execute(database, "getPromptVersion", { templateId: first.template.id, versionId: latest.id })
        .content,
    ).toBe(newerDraft.draftContent);

    const largeConfig: ValidationProfileConfig = {
      ...profileConfig,
      build: profileConfig.build.map((step) => ({
        ...step,
        command: { ...step.command, args: Array.from({ length: 16 }, () => "a".repeat(8_000)) },
      })),
    };
    const profile = execute(database, "publishValidationProfile", {
      repositoryId: "repository-1",
      request: { ...profileRequest, config: largeConfig },
      actor,
    });
    const profileSecond = execute(database, "publishValidationProfile", {
      repositoryId: "repository-1",
      request: {
        ...profileRequest,
        profileId: profile.profileId,
        expectedVersion: 1,
        config: largeConfig,
      },
      actor,
    });
    const another = publishProfile(database);
    const profiles = execute(database, "listValidationProfiles", {
      repositoryId: "repository-1",
      pageSize: 1,
    });
    const profilesPageTwo = execute(database, "listValidationProfiles", {
      repositoryId: "repository-1",
      page: 2,
      pageSize: 1,
    });
    expect(profiles.total).toBe(2);
    expect(new Set([...profiles.items, ...profilesPageTwo.items].map((item) => item.id))).toEqual(
      new Set([profileSecond.id, another.id]),
    );
    for (const item of [...profiles.items, ...profilesPageTwo.items])
      expect(item).not.toHaveProperty("config");
    const profileVersions = execute(database, "listValidationProfileVersions", {
      repositoryId: "repository-1",
      profileId: profile.profileId,
      page: 2,
      pageSize: 1,
    });
    expect(profileVersions).toMatchObject({ total: 2, items: [{ id: profile.id }] });
    expect(profileVersions.items[0]).not.toHaveProperty("config");
    expect(
      execute(database, "getValidationProfileVersion", {
        repositoryId: "repository-1",
        profileId: profile.profileId,
        versionId: profile.id,
      }).config,
    ).toEqual(largeConfig);
    expect(
      JSON.stringify([firstPage, secondPage, versions, profiles, profilesPageTwo, profileVersions])
        .length,
    ).toBeLessThan(20_000);
  });

  it("scopes version details to the requested template and repository profile", () => {
    const database = createDatabase();
    const first = createPublishedPrompt(database);
    const second = createPublishedPrompt(database);
    expectErrorCode(
      () =>
        execute(database, "getPromptVersion", {
          templateId: first.template.id,
          versionId: second.published.id,
        }),
      "PLATFORM_NOT_FOUND",
    );
    expectErrorCode(
      () =>
        execute(database, "getPromptVersion", {
          templateId: first.template.id,
          versionId: "missing-version",
        }),
      "PLATFORM_NOT_FOUND",
    );
    const profile = publishProfile(database);
    const other = publishProfile(database);
    expectErrorCode(
      () =>
        execute(database, "getValidationProfileVersion", {
          repositoryId: "repository-1",
          profileId: profile.profileId,
          versionId: other.id,
        }),
      "PLATFORM_NOT_FOUND",
    );
    expectErrorCode(
      () =>
        execute(database, "getValidationProfileVersion", {
          repositoryId: "repository-2",
          profileId: profile.profileId,
          versionId: profile.id,
        }),
      "PLATFORM_INVALID",
    );
  });

  it.each([
    { page: 0 },
    { page: -1 },
    { page: 1.5 },
    { pageSize: 0 },
    { pageSize: 51 },
    { pageSize: Number.NaN },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
  ])("rejects unsafe pagination consistently: %j", (query) => {
    const database = createDatabase();
    const { template } = createPublishedPrompt(database);
    const profile = publishProfile(database);
    const requests: PromptConfigurationRequest[] = [
      { operation: "listPromptTemplates", input: query },
      { operation: "listPromptVersions", input: { templateId: template.id, ...query } },
      {
        operation: "listPromptBindingHistory",
        input: { repositoryId: null, workflowKind: "pr_static_build", ...query },
      },
      { operation: "listValidationProfiles", input: { repositoryId: "repository-1", ...query } },
      {
        operation: "listValidationProfileVersions",
        input: { repositoryId: "repository-1", profileId: profile.profileId, ...query },
      },
      {
        operation: "listValidationProfileBindings",
        input: { repositoryId: "repository-1", ...query },
      },
      {
        operation: "listValidationProfileBindingHistory",
        input: { repositoryId: "repository-1", profileId: profile.profileId, ...query },
      },
    ];
    for (const request of requests)
      expectErrorCode(
        () => handlePromptConfigurationRequest(database, request, timestamp),
        "PLATFORM_INVALID",
      );
  });

  it("bootstraps once and preserves operator changes and repository overrides on restart", () => {
    const database = createDatabase();
    const bootstrapInput = { templates: [promptRequest], actor };
    const first = execute(database, "bootstrapPromptTemplates", bootstrapInput);
    expect(first).toHaveLength(1);
    const initialId = first[0]?.promptVersionId;
    expect(initialId).toEqual(expect.any(String));
    const replacement = createPublishedPrompt(database, {
      ...promptRequest,
      content: "Operator-maintained configuration.",
    }).published;
    const override = execute(database, "savePromptBinding", {
      repositoryId: "repository-1",
      workflowKind: "pr_static_build",
      request: { expectedVersion: 0, promptVersionId: replacement.id },
      actor,
    });
    const changedGlobal = execute(database, "savePromptBinding", {
      repositoryId: null,
      workflowKind: "pr_static_build",
      request: { expectedVersion: 1, promptVersionId: replacement.id },
      actor,
    });
    const before = {
      templates: rowCount(database, "prompt_templates"),
      versions: rowCount(database, "prompt_versions"),
      audits: auditCount(database),
    };
    const restarted = execute(
      database,
      "bootstrapPromptTemplates",
      { templates: [{ ...promptRequest, content: "New on-disk default." }], actor },
      laterTimestamp,
    );
    expect(restarted).toEqual([changedGlobal]);
    expect(execute(database, "listPromptBindings", { repositoryId: "repository-1" })).toEqual([
      override,
    ]);
    expect({
      templates: rowCount(database, "prompt_templates"),
      versions: rowCount(database, "prompt_versions"),
      audits: auditCount(database),
    }).toEqual(before);
    expect(
      database.prepare("SELECT prompt_version_id FROM prompt_configuration_bootstrap").get(),
    ).toMatchObject({ prompt_version_id: initialId });
  });

  it("adopts an existing global binding during bootstrap without overwriting it", () => {
    const database = createDatabase();
    const { published } = createPublishedPrompt(database);
    const binding = execute(database, "savePromptBinding", {
      repositoryId: null,
      workflowKind: "pr_static_build",
      request: { expectedVersion: 0, promptVersionId: published.id },
      actor,
    });
    const before = auditCount(database);
    expect(
      execute(database, "bootstrapPromptTemplates", { templates: [promptRequest], actor }),
    ).toEqual([binding]);
    expect(auditCount(database)).toBe(before + 1);
    expect(
      database
        .prepare(
          "SELECT action FROM prompt_configuration_audit WHERE action = 'bootstrap_registered'",
        )
        .all(),
    ).toHaveLength(1);
    expect(rowCount(database, "prompt_templates")).toBe(1);
    expect(rowCount(database, "prompt_configuration_bootstrap")).toBe(1);
  });

  it("rolls back the entire bootstrap batch when a later workflow cannot be audited", () => {
    const database = createDatabase();
    const templates: PromptTemplateCreateRequest[] = [
      promptRequest,
      {
        name: "Issue triage",
        workflowKind: "issue_triage",
        content: "Triage the issue.",
        outputSchemaVersion: "IssueTriageV2",
      },
    ];
    database.exec(`
      CREATE TEMP TRIGGER reject_test_audit BEFORE INSERT ON prompt_configuration_audit
      WHEN NEW.action = 'template_created' AND EXISTS (
        SELECT id FROM prompt_templates WHERE id = NEW.entity_id AND workflow_kind = 'issue_triage'
      ) BEGIN SELECT RAISE(ABORT, 'Injected second-workflow audit failure'); END;
    `);
    expect(() => execute(database, "bootstrapPromptTemplates", { templates, actor })).toThrow(
      "Injected second-workflow audit failure",
    );
    for (const table of [
      "prompt_templates",
      "prompt_versions",
      "prompt_bindings",
      "prompt_binding_history",
      "prompt_configuration_bootstrap",
      "prompt_configuration_audit",
    ])
      expect(rowCount(database, table)).toBe(0);
    database.exec("DROP TRIGGER reject_test_audit");
    expect(execute(database, "bootstrapPromptTemplates", { templates, actor })).toHaveLength(2);
  });

  it("rejects repeated bootstrap workflows before any side effects", () => {
    const database = createDatabase();
    expectErrorCode(
      () =>
        execute(database, "bootstrapPromptTemplates", {
          templates: [promptRequest, promptRequest],
          actor,
        }),
      "PLATFORM_INVALID",
    );
    expect(rowCount(database, "prompt_templates")).toBe(0);
    expect(auditCount(database)).toBe(0);
  });

  it("preserves full authenticated attribution and rejects malformed actors before writes", () => {
    const database = createDatabase();
    const longActor = {
      issuer: `https://identity.example.test/${"i".repeat(1_900)}`,
      subject: "s".repeat(512),
    };
    const template = execute(database, "createPromptTemplate", {
      request: promptRequest,
      actor: longActor,
    });
    const published = execute(database, "publishPromptDraft", {
      templateId: template.id,
      request: { expectedVersion: 1 },
      actor: longActor,
    });
    expect(JSON.parse(published.createdBy)).toEqual([longActor.issuer, longActor.subject]);
    expect(
      database
        .prepare("SELECT actor_issuer, actor_subject FROM prompt_configuration_audit LIMIT 1")
        .get(),
    ).toMatchObject({ actor_issuer: longActor.issuer, actor_subject: longActor.subject });
    for (const badActor of [
      { ...actor, issuer: "" },
      { ...actor, subject: " " },
      { ...actor, issuer: " padded" },
      { ...actor, subject: "s".repeat(513) },
      { ...actor, issuer: "i".repeat(2_049) },
      { ...actor, subject: "bad\0subject" },
      { ...actor, subject: "bad\ud800subject" },
    ])
      expectErrorCode(
        () =>
          execute(database, "createPromptTemplate", { request: promptRequest, actor: badActor }),
        "PLATFORM_INVALID",
      );
    expect(rowCount(database, "prompt_templates")).toBe(1);
    expect(auditCount(database)).toBe(2);
  });
});

describe("workflow prompt resolution", () => {
  const bindPrompt = (
    database: DatabaseSync,
    repositoryId: string | null,
    promptVersionId: string,
    expectedVersion = 0,
  ) =>
    execute(database, "savePromptBinding", {
      repositoryId,
      workflowKind: "pr_static_build",
      request: { expectedVersion, promptVersionId },
      actor,
    });

  const resolve = (database: DatabaseSync, repositoryId = "repository-1") =>
    execute(database, "resolveWorkflowPrompt", { repositoryId, workflowKind: "pr_static_build" });

  it("returns null for unconfigured workflows and rejects an unknown repository", () => {
    const database = createDatabase();
    expect(resolve(database)).toBeNull();
    expectErrorCode(() => resolve(database, "missing-repository"), "PLATFORM_NOT_FOUND");
    expect(auditCount(database)).toBe(0);
  });

  it("uses a global default until a repository override is explicitly bound", () => {
    const database = createDatabase();
    const global = createPublishedPrompt(database);
    const globalBinding = bindPrompt(database, null, global.published.id);
    const globalResult = {
      binding: globalBinding,
      version: global.published,
      templateName: global.template.name,
      workflowKind: "pr_static_build",
    };
    expect(resolve(database)).toEqual(globalResult);
    expect(resolve(database, "repository-2")).toEqual(globalResult);
    const override = createPublishedPrompt(database, {
      ...promptRequest,
      name: "Repository-specific review",
      content: "Review this repository using its own instructions.",
    });
    const repositoryBinding = bindPrompt(database, "repository-1", override.published.id);
    const before = auditCount(database);
    expect(resolve(database)).toEqual({
      binding: repositoryBinding,
      version: override.published,
      templateName: override.template.name,
      workflowKind: "pr_static_build",
    });
    expect(resolve(database, "repository-2")).toEqual(globalResult);
    expect(auditCount(database)).toBe(before);
    expect(execute(database, "listPromptBindings", { repositoryId: "repository-2" })).toEqual([]);
  });

  it("keeps resolution pinned to the bound publication until explicit rebinding and rollback", () => {
    const database = createDatabase();
    const { template, published } = createPublishedPrompt(database);
    const initialBinding = bindPrompt(database, "repository-1", published.id);
    const initial = resolve(database);
    expect(initial).toMatchObject({ binding: initialBinding, version: published });
    const draft = execute(database, "savePromptDraft", {
      templateId: template.id,
      request: {
        expectedVersion: 2,
        content: "A new draft is not an active instruction.",
        outputSchemaVersion: "PrReviewPlanV2",
      },
      actor,
    });
    expect(resolve(database)).toEqual(initial);
    const second = execute(database, "publishPromptDraft", {
      templateId: template.id,
      request: { expectedVersion: draft.version },
      actor,
    });
    expect(resolve(database)).toEqual(initial);
    const changedBinding = bindPrompt(database, "repository-1", second.id, 1);
    const changed = resolve(database);
    expect(changed).toMatchObject({ binding: changedBinding, version: second });
    const rollback = bindPrompt(database, "repository-1", published.id, 2);
    expect(resolve(database)).toMatchObject({ binding: rollback, version: published });
    expect(changed).toMatchObject({ binding: changedBinding, version: second });
  });

  it("resolves only the requested workflow without falling back across workflow kinds", () => {
    const database = createDatabase();
    const pr = createPublishedPrompt(database);
    bindPrompt(database, null, pr.published.id);
    expect(
      execute(database, "resolveWorkflowPrompt", {
        repositoryId: "repository-1",
        workflowKind: "issue_triage",
      }),
    ).toBeNull();
    expect(
      execute(database, "resolveWorkflowPrompt", {
        repositoryId: "repository-1",
        workflowKind: "pr_ui",
      }),
    ).toBeNull();
    const issue = createPublishedPrompt(database, {
      name: "Issue triage",
      workflowKind: "issue_triage",
      content: "Classify the issue without running commands.",
      outputSchemaVersion: "IssueTriageV2",
    });
    const issueBinding = execute(database, "savePromptBinding", {
      repositoryId: null,
      workflowKind: "issue_triage",
      request: { expectedVersion: 0, promptVersionId: issue.published.id },
      actor,
    });
    expect(
      execute(database, "resolveWorkflowPrompt", {
        repositoryId: "repository-1",
        workflowKind: "issue_triage",
      }),
    ).toEqual({
      binding: issueBinding,
      version: issue.published,
      templateName: issue.template.name,
      workflowKind: "issue_triage",
    });
    expect(resolve(database)).toMatchObject({
      version: pr.published,
      workflowKind: "pr_static_build",
    });
    expect(
      execute(database, "resolveWorkflowPrompt", {
        repositoryId: "repository-1",
        workflowKind: "issue_validation",
      }),
    ).toBeNull();
  });

  it.each([
    "digest",
    "content",
    "output schema",
    "unsupported output schema",
    "template workflow",
    "blank content with matching digest",
  ] as const)(
    "fails closed on corrupted bound %s instead of silently using a valid global default",
    (corruption) => {
      const database = createDatabase();
      const global = createPublishedPrompt(database);
      const selected = createPublishedPrompt(database, {
        ...promptRequest,
        name: "Repository override",
        content: "Repository-specific published instructions.",
      });
      bindPrompt(database, null, global.published.id);
      bindPrompt(database, "repository-1", selected.published.id);
      const unaffected = resolve(database, "repository-2");
      database.exec("DROP TRIGGER tr_prompt_versions_immutable_update");
      switch (corruption) {
        case "digest":
          database
            .prepare("UPDATE prompt_versions SET content_sha256 = ? WHERE id = ?")
            .run("0".repeat(64), selected.published.id);
          break;
        case "content":
          database
            .prepare("UPDATE prompt_versions SET content = ? WHERE id = ?")
            .run("Tampered instructions without a matching digest.", selected.published.id);
          break;
        case "output schema":
          database
            .prepare(
              "UPDATE prompt_versions SET output_schema_version = 'IssueTriageV2' WHERE id = ?",
            )
            .run(selected.published.id);
          break;
        case "unsupported output schema":
          database.exec("PRAGMA ignore_check_constraints = ON");
          database
            .prepare(
              "UPDATE prompt_versions SET output_schema_version = 'UnsupportedSchemaV99' WHERE id = ?",
            )
            .run(selected.published.id);
          database.exec("PRAGMA ignore_check_constraints = OFF");
          break;
        case "template workflow":
          database.exec("DROP TRIGGER tr_prompt_template_update_identity");
          database
            .prepare(
              "UPDATE prompt_templates SET workflow_kind = 'issue_triage', draft_output_schema_version = 'IssueTriageV2' WHERE id = ?",
            )
            .run(selected.template.id);
          break;
        case "blank content with matching digest": {
          const content = " \t\n ";
          database
            .prepare("UPDATE prompt_versions SET content = ?, content_sha256 = ? WHERE id = ?")
            .run(content, sha256(content), selected.published.id);
          break;
        }
      }
      const before = auditCount(database);
      expectErrorCode(() => resolve(database), "PLATFORM_INVALID");
      expect(resolve(database, "repository-2")).toEqual(unaffected);
      expect(auditCount(database)).toBe(before);
    },
  );
});

describe("prompt configuration migration guards", () => {
  const seedAppendOnlyRecords = (database: DatabaseSync): void => {
    database
      .prepare(`
        INSERT INTO prompt_templates (
          id, name, description, workflow_kind, version, draft_revision, draft_content,
          draft_output_schema_version, created_at, updated_at
        ) VALUES ('template-1', 'Static review', '', 'pr_static_build', 1, 1, ?,
          'PrReviewPlanV2', ?, ?)
      `)
      .run(promptRequest.content, timestamp, timestamp);
    database
      .prepare(`
        INSERT INTO prompt_versions (
          id, template_id, version, source_draft_revision, content, content_sha256,
          output_schema_version, created_at, published_at, created_by
        ) VALUES ('prompt-version-1', 'template-1', 1, 1, ?, ?, 'PrReviewPlanV2', ?, ?, ?)
      `)
      .run(
        promptRequest.content,
        sha256(promptRequest.content),
        timestamp,
        timestamp,
        JSON.stringify(actor),
      );
    database.exec(`
      UPDATE prompt_templates SET version = 2, latest_published_version_id = 'prompt-version-1'
      WHERE id = 'template-1';
    `);
    database
      .prepare(`
        INSERT INTO prompt_bindings (
          scope_key, repository_id, workflow_kind, prompt_version_id, version, updated_at
        ) VALUES ('global', NULL, 'pr_static_build', 'prompt-version-1', 1, ?)
      `)
      .run(timestamp);
    database
      .prepare(`
        INSERT INTO prompt_binding_history (
          id, scope_key, repository_id, workflow_kind, prompt_version_id, previous_version_id,
          version, created_at, created_by
        ) VALUES ('binding-history-1', 'global', NULL, 'pr_static_build', 'prompt-version-1',
          NULL, 1, ?, ?)
      `)
      .run(timestamp, JSON.stringify(actor));
    database
      .prepare(`
        INSERT INTO validation_profiles (id, repository_id, workflow_kind, target, created_at)
        VALUES ('profile-1', 'repository-1', 'pr_static_build', 'headless', ?)
      `)
      .run(timestamp);
    database
      .prepare(`
        INSERT INTO validation_profile_versions (
          id, profile_id, version, name, config_json, config_sha256, output_schema_version,
          required, created_at, published_at, created_by
        ) VALUES ('profile-version-1', 'profile-1', 1, 'Build', ?, ?, 'PrReviewPlanV2',
          1, ?, ?, ?)
      `)
      .run(
        JSON.stringify(profileConfig),
        sha256(JSON.stringify(profileConfig)),
        timestamp,
        timestamp,
        JSON.stringify(actor),
      );
    database
      .prepare(`
        INSERT INTO validation_profile_bindings (
          repository_id, profile_id, profile_version_id, enabled, version, updated_at
        ) VALUES ('repository-1', 'profile-1', 'profile-version-1', 1, 1, ?)
      `)
      .run(timestamp);
    database
      .prepare(`
        INSERT INTO validation_profile_binding_history (
          id, repository_id, profile_id, profile_version_id, previous_version_id,
          enabled, version, created_at, created_by
        ) VALUES ('profile-history-1', 'repository-1', 'profile-1', 'profile-version-1',
          NULL, 1, 1, ?, ?)
      `)
      .run(timestamp, JSON.stringify(actor));
    database
      .prepare(`
        INSERT INTO prompt_configuration_audit (
          id, action, entity_id, repository_id, actor_issuer, actor_subject, created_at, detail_json
        ) VALUES ('audit-1', 'prompt_published', 'prompt-version-1', NULL, ?, ?, ?, '{}')
      `)
      .run(actor.issuer, actor.subject, timestamp);
    database
      .prepare(`
        INSERT INTO prompt_configuration_bootstrap (workflow_kind, prompt_version_id, created_at)
        VALUES ('pr_static_build', 'prompt-version-1', ?)
      `)
      .run(timestamp);
  };

  it.each([
    ["prompt_versions", "content = 'Changed outside the API'"],
    ["prompt_binding_history", "version = 2"],
    ["validation_profiles", "repository_id = 'repository-2'"],
    ["validation_profile_versions", "name = 'Changed outside the API'"],
    ["validation_profile_binding_history", "enabled = 0"],
    ["prompt_configuration_audit", "actor_subject = 'different-operator'"],
    ["prompt_configuration_bootstrap", "created_at = '2026-09-08T00:00:00.000Z'"],
  ])("rejects direct UPDATE and DELETE of append-only %s", (table, assignment) => {
    const database = createDatabase();
    seedAppendOnlyRecords(database);
    expect(() => database.exec(`UPDATE ${table} SET ${assignment}`)).toThrow(/immutable/u);
    expect(() => database.exec(`DELETE FROM ${table}`)).toThrow(/immutable/u);
    expect(rowCount(database, table)).toBe(1);
  });

  it("preserves identities and rejects direct binding deletion", () => {
    const database = createDatabase();
    seedAppendOnlyRecords(database);
    expect(() =>
      database.exec("UPDATE prompt_templates SET workflow_kind = 'pr_ui', version = 3"),
    ).toThrow(/invalid prompt template revision/u);
    for (const table of ["prompt_templates", "prompt_bindings", "validation_profile_bindings"]) {
      expect(() => database.exec(`DELETE FROM ${table}`)).toThrow(/cannot be deleted/u);
    }
    expect(() =>
      database.exec(`
        UPDATE prompt_bindings SET workflow_kind = 'issue_triage', version = 2
        WHERE scope_key = 'global'
      `),
    ).toThrow(/invalid published prompt binding/u);
    expect(() =>
      database.exec(`
        UPDATE validation_profile_bindings SET repository_id = 'repository-2', version = 2
      `),
    ).toThrow(/invalid validation profile binding/u);
  });
});
