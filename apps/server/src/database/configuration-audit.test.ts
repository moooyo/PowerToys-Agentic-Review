import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  type ManagedRepository,
  maximumConfigurationAuditResponseUtf8Bytes,
  type PromptTemplateCreateRequest,
  type ValidationProfileCreateRequest,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ConfigurationAuditOperation,
  type ConfigurationAuditOperationMap,
  type ConfigurationAuditRequest,
  handleConfigurationAuditRequest,
} from "./configuration-audit.js";
import { handleRepositoryConfigurationRequest } from "./managed-repositories.js";
import { runMigrations } from "./migrations.js";
import { handleOperatorAccessRequest, type OperatorReadContext } from "./operator-access.js";
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
const later = "2026-09-07T01:00:00.000Z";
const actor = { issuer: "https://identity.example.test", subject: "operator-1" };
const viewer = { issuer: actor.issuer, subject: "viewer-1" };
const adminContext: OperatorReadContext = { actor, administrators: [actor] };
const viewerContext: OperatorReadContext = { actor: viewer, administrators: [actor] };
const databases: DatabaseSync[] = [];
const directories: string[] = [];
const promptRequest: PromptTemplateCreateRequest = {
  name: "Static review",
  description: "Review the recorded source revision.",
  workflowKind: "pr_static_build",
  content: "ORIGINAL_PROMPT_CONTENT",
  outputSchemaVersion: "PrReviewPlanV2",
};
const profileRequest: ValidationProfileCreateRequest = {
  name: "Build checks",
  workflowKind: "pr_static_build",
  target: "headless",
  config: {
    schemaVersion: "ValidationProfileV1",
    setup: [],
    build: [],
    test: [],
    launch: [],
    cleanup: [],
    requiredCapabilities: [],
    hardTimeoutMs: 60_000,
    noProgressTimeoutMs: 30_000,
  },
  outputSchemaVersion: "PrReviewPlanV2",
  required: true,
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function open(path = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  databases.push(database);
  database.exec(
    "PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA recursive_triggers = OFF",
  );
  runMigrations(database, migrationsDirectory);
  return database;
}
function read<K extends ConfigurationAuditOperation>(
  database: DatabaseSync,
  operation: K,
  input: ConfigurationAuditOperationMap[K]["input"],
  context = adminContext,
): ConfigurationAuditOperationMap[K]["output"] {
  return handleConfigurationAuditRequest(
    database,
    { operation, input } as ConfigurationAuditRequest,
    context,
  ) as ConfigurationAuditOperationMap[K]["output"];
}
function prompt<K extends PromptConfigurationOperation>(
  database: DatabaseSync,
  operation: K,
  input: PromptConfigurationOperationMap[K]["input"],
  now = timestamp,
): PromptConfigurationOperationMap[K]["output"] {
  return handlePromptConfigurationRequest(
    database,
    { operation, input } as PromptConfigurationRequest,
    now,
  ) as PromptConfigurationOperationMap[K]["output"];
}
function repository(database: DatabaseSync, number = 1): ManagedRepository {
  return handleRepositoryConfigurationRequest(
    database,
    {
      operation: "createManagedRepository",
      input: {
        request: { githubRepositoryId: number, fullName: `example/repository-${number}` },
        actor,
      },
    },
    timestamp,
  ) as ManagedRepository;
}
function grant(database: DatabaseSync, repositoryId: string): void {
  handleOperatorAccessRequest(
    database,
    {
      operation: "changeRepositoryAccess",
      input: {
        repositoryId,
        actor,
        request: {
          changeId: randomUUID(),
          principal: viewer,
          role: "viewer",
          expectedVersion: 0,
          reason: "Inspect configuration history.",
        },
      },
    },
    timestamp,
    [actor],
  );
}
function seed(database = open()) {
  const first = repository(database);
  const second = repository(database, 2);
  grant(database, first.id);
  const template = prompt(database, "createPromptTemplate", { request: promptRequest, actor });
  const published = prompt(database, "publishPromptDraft", {
    templateId: template.id,
    request: { expectedVersion: 1 },
    actor,
  });
  prompt(database, "savePromptBinding", {
    repositoryId: first.id,
    workflowKind: "pr_static_build",
    request: { expectedVersion: 0, promptVersionId: published.id },
    actor,
  });
  prompt(database, "savePromptBinding", {
    repositoryId: second.id,
    workflowKind: "pr_static_build",
    request: { expectedVersion: 0, promptVersionId: published.id },
    actor,
  });
  prompt(database, "savePromptBinding", {
    repositoryId: null,
    workflowKind: "pr_static_build",
    request: { expectedVersion: 0, promptVersionId: published.id },
    actor,
  });
  prompt(database, "bootstrapPromptTemplates", { templates: [promptRequest], actor });
  const draft = prompt(
    database,
    "savePromptDraft",
    {
      templateId: template.id,
      request: {
        expectedVersion: 2,
        content: "NEW_DRAFT_CONTENT_MUST_NOT_BECOME_HISTORY",
        outputSchemaVersion: "PrReviewPlanV2",
      },
      actor,
    },
    later,
  );
  const nextPublished = prompt(
    database,
    "publishPromptDraft",
    { templateId: template.id, request: { expectedVersion: draft.version }, actor },
    later,
  );
  prompt(
    database,
    "savePromptBinding",
    {
      repositoryId: first.id,
      workflowKind: "pr_static_build",
      request: { expectedVersion: 1, promptVersionId: nextPublished.id },
      actor,
    },
    later,
  );
  const profile = prompt(database, "publishValidationProfile", {
    repositoryId: first.id,
    request: profileRequest,
    actor,
  });
  prompt(database, "saveValidationProfileBinding", {
    repositoryId: first.id,
    profileId: profile.profileId,
    request: { expectedVersion: 0, profileVersionId: profile.id, enabled: true },
    actor,
  });
  const nextProfile = prompt(
    database,
    "publishValidationProfile",
    {
      repositoryId: first.id,
      request: { ...profileRequest, profileId: profile.profileId, expectedVersion: 1 },
      actor,
    },
    later,
  );
  prompt(
    database,
    "saveValidationProfileBinding",
    {
      repositoryId: first.id,
      profileId: profile.profileId,
      request: { expectedVersion: 1, profileVersionId: nextProfile.id, enabled: false },
      actor,
    },
    later,
  );
  const foreignProfile = prompt(database, "publishValidationProfile", {
    repositoryId: second.id,
    request: profileRequest,
    actor,
  });
  handleRepositoryConfigurationRequest(
    database,
    {
      operation: "updateManagedRepository",
      input: {
        repositoryId: first.id,
        request: { expectedVersion: 1, reviewerGithubUserId: 42, reviewerGithubLogin: "reviewer" },
        actor,
      },
    },
    later,
  );
  return {
    database,
    first,
    second,
    template,
    published,
    nextPublished,
    profile,
    nextProfile,
    foreignProfile,
  };
}
type Row = Record<string, SQLInputValue>;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("The required audit fixture is missing.");
  return value;
}
function auditRows(database: DatabaseSync, source: "repository" | "prompt"): Row[] {
  return database
    .prepare(`SELECT * FROM ${source}_configuration_audit ORDER BY created_at, id`)
    .all() as Row[];
}
function cloneAudit(
  database: DatabaseSync,
  source: "repository" | "prompt",
  action: string,
  changes: Row = {},
): string {
  const repositoryId = database
    .prepare("SELECT id FROM managed_repositories ORDER BY github_repository_id LIMIT 1")
    .get()?.id;
  const original = auditRows(database, source).find(
    (row) =>
      row.action === action && (source !== "repository" || row.repository_id === repositoryId),
  );
  if (!original) throw new Error("The audit fixture is missing.");
  const row = { ...original, id: randomUUID(), ...changes };
  database
    .prepare(
      `INSERT INTO ${source}_configuration_audit (${Object.keys(row).join(", ")}) VALUES (${Object.keys(
        row,
      )
        .map(() => "?")
        .join(", ")})`,
    )
    .run(...Object.values(row));
  return row.id as string;
}
function corruptDetail(
  database: DatabaseSync,
  source: "repository" | "prompt",
  eventId: string,
  repositoryId?: string,
): void {
  let caught: unknown;
  try {
    if (repositoryId === undefined) read(database, "getGlobalConfigurationAudit", { eventId });
    else read(database, "getRepositoryConfigurationAudit", { repositoryId, source, eventId });
  } catch (error) {
    caught = error;
  }
  expect(caught).toEqual(
    expect.objectContaining({
      code: "PLATFORM_CORRUPT",
      message: "The stored configuration audit is invalid.",
    }),
  );
  expect(String(caught)).not.toContain("PRIVATE_CANARY");
  expect(database.isTransaction).toBe(false);
}

describe("configuration audit reads", () => {
  it("merges only matching repository audits and returns every recorded action without current draft content", () => {
    const { database, first, second, template } = seed();
    const before = {
      repository: auditRows(database, "repository"),
      prompt: auditRows(database, "prompt"),
    };
    const repo = read(
      database,
      "listRepositoryConfigurationAudit",
      { repositoryId: first.id },
      viewerContext,
    );
    expect(repo).toMatchObject({ repositoryId: first.id, page: 1, pageSize: 20, total: 8 });
    expect(repo.items.every((event) => event.repositoryId === first.id)).toBe(true);
    expect(new Set(repo.items.map((event) => event.action))).toEqual(
      new Set(["created", "updated", "prompt_bound", "profile_published", "profile_bound"]),
    );
    expect(repo.items.every((event) => !("snapshot" in event))).toBe(true);
    for (const summary of repo.items) {
      const detail = read(
        database,
        "getRepositoryConfigurationAudit",
        { repositoryId: first.id, source: summary.source, eventId: summary.id },
        viewerContext,
      );
      expect(detail).toMatchObject(summary);
      expect(detail).toHaveProperty("snapshot");
    }
    const global = read(database, "listGlobalConfigurationAudit", {});
    expect(global.items.every((event) => event.repositoryId === null)).toBe(true);
    expect(new Set(global.items.map((event) => event.action))).toEqual(
      new Set([
        "template_created",
        "draft_saved",
        "prompt_published",
        "prompt_bound",
        "bootstrap_registered",
      ]),
    );
    for (const summary of global.items)
      expect(read(database, "getGlobalConfigurationAudit", { eventId: summary.id })).toMatchObject(
        summary,
      );
    const detailJson = JSON.stringify(
      global.items.map((event) =>
        read(database, "getGlobalConfigurationAudit", { eventId: event.id }),
      ),
    );
    expect(detailJson).not.toContain("ORIGINAL_PROMPT_CONTENT");
    expect(detailJson).not.toContain("NEW_DRAFT_CONTENT_MUST_NOT_BECOME_HISTORY");
    expect(detailJson).not.toContain(promptRequest.name);
    expect(
      read(database, "listGlobalConfigurationAudit", { templateId: template.id }).items,
    ).toEqual(global.items);
    expect(JSON.stringify(repo)).not.toContain(second.id);
    expect({
      repository: auditRows(database, "repository"),
      prompt: auditRows(database, "prompt"),
    }).toEqual(before);
  });

  it("keeps the recorded repository configuration after connection health and configuration change", () => {
    const { database, first } = seed();
    const event = required(
      read(database, "listRepositoryConfigurationAudit", {
        repositoryId: first.id,
      }).items.find((entry) => entry.action === "created"),
    );
    handleRepositoryConfigurationRequest(
      database,
      {
        operation: "updateRepositoryConnection",
        input: {
          repositoryId: first.id,
          status: "error",
          message: "CURRENT_CONNECTION_FAILURE",
        },
      },
      later,
    );
    const detail = read(database, "getRepositoryConfigurationAudit", {
      repositoryId: first.id,
      source: "repository",
      eventId: event.id,
    });
    expect(detail?.snapshot).toEqual(first);
    expect(JSON.stringify(detail)).not.toContain("CURRENT_CONNECTION_FAILURE");
    expect(
      read(database, "listRepositoryConfigurationAudit", { repositoryId: first.id }).total,
    ).toBe(8);
  });

  it("reads legacy snapshots without limits and retains their exact bytes after new limit updates", () => {
    const database = open();
    const first = repository(database);
    const { schedulingLimits: _limits, ...legacySnapshot } = first;
    const rawSnapshot = ` \r\n${JSON.stringify(
      { ...legacySnapshot, connectionMessage: "Historical caf\u00e9 \ud83d\ude80" },
      null,
      2,
    )
      .replace('"version": 1', '"version": 1e+00')
      .replace("caf\u00e9", "caf\\u00e9")}\r\n `;
    const legacyId = cloneAudit(database, "repository", "created", {
      configuration_json: rawSnapshot,
    });
    const recordedBytes = () =>
      database
        .prepare(`SELECT typeof(configuration_json) AS storage_type, hex(configuration_json) AS bytes
          FROM repository_configuration_audit WHERE id = ?`)
        .get(legacyId);
    const before = recordedBytes();
    expect(before).toEqual({
      storage_type: "text",
      bytes: Buffer.from(rawSnapshot, "utf8").toString("hex").toUpperCase(),
    });
    const updated = handleRepositoryConfigurationRequest(
      database,
      {
        operation: "updateManagedRepository",
        input: {
          repositoryId: first.id,
          request: {
            expectedVersion: first.version,
            schedulingLimits: { maxActiveLeases: 3, maxQueuedJobs: 12 },
          },
          actor,
        },
      },
      later,
    ) as ManagedRepository;
    const legacyDetail = read(database, "getRepositoryConfigurationAudit", {
      repositoryId: first.id,
      source: "repository",
      eventId: legacyId,
    });
    expect(legacyDetail?.snapshot).toEqual(JSON.parse(rawSnapshot));
    expect(legacyDetail?.snapshot).not.toHaveProperty("schedulingLimits");
    const currentEvent = required(
      read(database, "listRepositoryConfigurationAudit", { repositoryId: first.id }).items.find(
        (event) => event.action === "updated",
      ),
    );
    expect(
      read(database, "getRepositoryConfigurationAudit", {
        repositoryId: first.id,
        source: "repository",
        eventId: currentEvent.id,
      })?.snapshot,
    ).toEqual(updated);
    expect(updated.schedulingLimits).toEqual({ maxActiveLeases: 3, maxQueuedJobs: 12 });
    expect(recordedBytes()).toEqual(before);
    expect(
      read(database, "getRepositoryConfigurationAudit", {
        repositoryId: first.id,
        source: "repository",
        eventId: legacyId,
      }),
    ).toEqual(legacyDetail);
    expect(recordedBytes()).toEqual(before);
  });

  it("records repository bootstrap attribution without inventing connection events", () => {
    const database = open();
    handleRepositoryConfigurationRequest(
      database,
      {
        operation: "bootstrapManagedRepositories",
        input: {
          repositories: [{ githubRepositoryId: 3, fullName: "example/bootstrap" }],
          reviewer: { githubUserId: 42, login: "reviewer" },
          authorizationPolicy: {
            kind: "self_or_allowlist",
            policyVersion: 1,
            schedulingTargetGithubUserId: 42,
            allowlistedActorGithubUserIds: [],
            unknownActorPolicy: "deny",
          },
        },
      },
      timestamp,
    );
    const row = required(auditRows(database, "repository")[0]);
    const detail = read(database, "getRepositoryConfigurationAudit", {
      repositoryId: row.repository_id as string,
      source: "repository",
      eventId: row.id as string,
    });
    expect(detail).toMatchObject({
      action: "bootstrapped",
      version: 1,
      actor: { issuer: "system", subject: "github-environment-bootstrap" },
      snapshot: { enabled: true, connectionStatus: "unknown" },
    });
  });

  it("preserves a valid recorded update when the server clock moves backwards", () => {
    const database = open();
    const first = repository(database);
    const earlier = "2026-09-06T23:59:59.000Z";
    handleRepositoryConfigurationRequest(
      database,
      {
        operation: "updateManagedRepository",
        input: {
          repositoryId: first.id,
          request: {
            expectedVersion: 1,
            reviewerGithubUserId: 42,
            reviewerGithubLogin: "reviewer",
          },
          actor,
        },
      },
      earlier,
    );
    const row = required(
      auditRows(database, "repository").find((entry) => entry.action === "updated"),
    );
    expect(
      read(database, "getRepositoryConfigurationAudit", {
        repositoryId: first.id,
        source: "repository",
        eventId: row.id as string,
      }),
    ).toMatchObject({
      createdAt: earlier,
      snapshot: { createdAt: timestamp, updatedAt: earlier, version: 2 },
    });
  });

  it("enforces repository visibility and global administrator scope before looking up an event", () => {
    const { database, first, second } = seed();
    const globalId = required(read(database, "listGlobalConfigurationAudit", {}).items[0]).id;
    const other = required(
      read(database, "listRepositoryConfigurationAudit", { repositoryId: second.id }).items[0],
    );
    expect(
      read(
        database,
        "getRepositoryConfigurationAudit",
        { repositoryId: first.id, source: "prompt", eventId: globalId },
        viewerContext,
      ),
    ).toBeNull();
    expect(
      read(
        database,
        "getRepositoryConfigurationAudit",
        { repositoryId: first.id, source: other.source, eventId: other.id },
        viewerContext,
      ),
    ).toBeNull();
    expect(read(database, "getGlobalConfigurationAudit", { eventId: other.id })).toBeNull();
    expect(() =>
      read(
        database,
        "listRepositoryConfigurationAudit",
        { repositoryId: second.id },
        viewerContext,
      ),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
    expect(() =>
      read(
        database,
        "getRepositoryConfigurationAudit",
        { repositoryId: second.id, source: other.source, eventId: other.id },
        viewerContext,
      ),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
    expect(() => read(database, "listGlobalConfigurationAudit", {}, viewerContext)).toThrow(
      expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }),
    );
    expect(() =>
      read(database, "getGlobalConfigurationAudit", { eventId: globalId }, viewerContext),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }));
    expect(() =>
      read(database, "listRepositoryConfigurationAudit", { repositoryId: "missing" }),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
    expect(() => read(database, "listGlobalConfigurationAudit", { templateId: "missing" })).toThrow(
      expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }),
    );
    expect(
      handleConfigurationAuditRequest(database, {
        operation: "getRepositoryConfigurationAudit",
        input: { repositoryId: first.id, source: "repository", eventId: "missing" },
      }),
    ).toBeNull();
  });

  it("orders equal timestamps by source then descending id with deterministic bounded pages", () => {
    const { database, first } = seed();
    for (let index = 0; index < 26; index++)
      cloneAudit(database, "repository", "created", {
        id: `tie-${index.toString().padStart(3, "0")}`,
      });
    const firstPage = read(database, "listRepositoryConfigurationAudit", {
      repositoryId: first.id,
    });
    const secondPage = read(database, "listRepositoryConfigurationAudit", {
      repositoryId: first.id,
      page: 2,
    });
    expect(firstPage.items).toHaveLength(20);
    expect(secondPage.items).toHaveLength(14);
    const ids = [...firstPage.items, ...secondPage.items].map((row) => `${row.source}:${row.id}`);
    const sql = database
      .prepare(`SELECT source, id FROM (
      SELECT 'repository' AS source, id, created_at FROM repository_configuration_audit WHERE repository_id = ?
      UNION ALL SELECT 'prompt' AS source, id, created_at FROM prompt_configuration_audit WHERE repository_id = ?
    ) ORDER BY created_at DESC, source ASC, id DESC`)
      .all(first.id, first.id);
    expect(ids).toEqual(sql.map((row) => `${row.source}:${row.id}`));
    expect(new Set(ids).size).toBe(34);
    expect(
      read(database, "listRepositoryConfigurationAudit", { repositoryId: first.id, page: 10 }),
    ).toMatchObject({ items: [], total: 34, page: 10, pageSize: 20 });
    expect(Buffer.byteLength(JSON.stringify(firstPage))).toBeLessThan(
      maximumConfigurationAuditResponseUtf8Bytes,
    );
  });

  it.each([
    { page: 0 },
    { page: 1.5 },
    { page: 10_000_001 },
    { pageSize: 0 },
    { pageSize: 21 },
    { pageSize: Number.NaN },
    { extra: "private" },
  ])("rejects invalid list query %j", (query) => {
    const database = open();
    expect(() =>
      handleConfigurationAuditRequest(
        database,
        { operation: "listGlobalConfigurationAudit", input: query } as ConfigurationAuditRequest,
        adminContext,
      ),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
  });

  it("uses one read snapshot for authorization, count, records and referenced history", () => {
    const directory = mkdtempSync(join(tmpdir(), "configuration-audit-reads-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const database = open(path);
    database.exec("PRAGMA journal_mode = WAL");
    const first = repository(database);
    const writer = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    databases.push(writer);
    const originalPrepare = database.prepare.bind(database);
    let inserted = false;
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      expect(database.isTransaction).toBe(true);
      if (!inserted && sql.includes("AS total")) {
        inserted = true;
        cloneAudit(writer, "repository", "created");
      }
      return originalPrepare(sql);
    });
    const result = read(database, "listRepositoryConfigurationAudit", { repositoryId: first.id });
    expect(result).toMatchObject({ total: 1 });
    expect(result.items).toHaveLength(1);
    expect(inserted).toBe(true);
    vi.restoreAllMocks();
    expect(
      read(database, "listRepositoryConfigurationAudit", { repositoryId: first.id }).total,
    ).toBe(2);
    database.exec("BEGIN");
    read(database, "listRepositoryConfigurationAudit", { repositoryId: first.id });
    expect(database.isTransaction).toBe(true);
    database.exec("ROLLBACK");
  });

  it("does not read repository snapshots while listing metadata", () => {
    const database = open();
    const first = repository(database);
    const id = cloneAudit(database, "repository", "created", {
      configuration_json: JSON.stringify({ value: "PRIVATE_CANARY".repeat(200_000) }),
    });
    const queries: string[] = [];
    const original = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      queries.push(sql);
      return original(sql);
    });
    expect(
      read(database, "listRepositoryConfigurationAudit", { repositoryId: first.id }).items,
    ).toHaveLength(2);
    expect(queries.every((sql) => !sql.includes("configuration_json"))).toBe(true);
    corruptDetail(database, "repository", id, first.id);
  });
});

describe("configuration audit corruption handling", () => {
  it.each(
    [
      null,
      {},
      [],
      "PRIVATE_CANARY",
      { maxActiveLeases: null },
      { maxQueuedJobs: null },
      { maxActiveLeases: 0, maxQueuedJobs: null },
      { maxActiveLeases: 65_536, maxQueuedJobs: null },
      { maxActiveLeases: 1.5, maxQueuedJobs: null },
      { maxActiveLeases: "2", maxQueuedJobs: null },
      { maxActiveLeases: null, maxQueuedJobs: 0 },
      { maxActiveLeases: null, maxQueuedJobs: 1_000_001 },
      { maxActiveLeases: null, maxQueuedJobs: 1.5 },
      { maxActiveLeases: null, maxQueuedJobs: "10" },
      { maxActiveLeases: null, maxQueuedJobs: null, PRIVATE_CANARY: true },
    ].map((schedulingLimits) => ({ schedulingLimits })),
  )(
    "rejects malformed V2 limits without falling back to the legacy snapshot %j",
    ({ schedulingLimits }) => {
      const database = open();
      const first = repository(database);
      const id = cloneAudit(database, "repository", "created", {
        configuration_json: JSON.stringify({ ...first, schedulingLimits }),
      });
      const before = auditRows(database, "repository");
      corruptDetail(database, "repository", id, first.id);
      expect(auditRows(database, "repository")).toEqual(before);
    },
  );

  it("requires the complete historical shape when a snapshot has no scheduling limits", () => {
    const database = open();
    const first = repository(database);
    const { schedulingLimits: _limits, connectionStatus: _status, ...incompleteLegacy } = first;
    const id = cloneAudit(database, "repository", "created", {
      configuration_json: JSON.stringify(incompleteLegacy),
    });
    corruptDetail(database, "repository", id, first.id);
  });

  it.each([
    ["unknown action", { action: "PRIVATE_CANARY" }],
    ["invalid event id", { id: "invalid/id" }],
    ["unsafe stored version", { version: 9_007_199_254_740_992n }],
    ["invalid actor", { actor_subject: "PRIVATE_CANARY\n" }],
    ["invalid date", { created_at: "2026-02-30T00:00:00.000Z" }],
  ] as const)("rejects %s without echoing stored values", (_label, changes) => {
    const database = open();
    const first = repository(database);
    const id = cloneAudit(database, "repository", "created", changes);
    if (!Object.hasOwn(changes, "id")) corruptDetail(database, "repository", id, first.id);
    expect(() =>
      read(database, "listRepositoryConfigurationAudit", { repositoryId: first.id }),
    ).toThrow(
      expect.objectContaining({
        code: "PLATFORM_CORRUPT",
        message: "The stored configuration audit is invalid.",
      }),
    );
  });

  it.each([
    [
      "recorded repository",
      (snapshot: ManagedRepository) => ({ ...snapshot, id: "other-repository" }),
    ],
    ["recorded revision", (snapshot: ManagedRepository) => ({ ...snapshot, version: 2 })],
    [
      "unsafe numeric id",
      (snapshot: ManagedRepository) => ({ ...snapshot, githubRepositoryId: 9_007_199_254_740_992 }),
    ],
    ["unknown property", (snapshot: ManagedRepository) => ({ ...snapshot, PRIVATE_CANARY: true })],
    [
      "invalid reviewer pairing",
      (snapshot: ManagedRepository) => ({ ...snapshot, reviewerGithubUserId: 42 }),
    ],
    [
      "malformed nested timestamp",
      (snapshot: ManagedRepository) => ({ ...snapshot, createdAt: "2026-02-30T00:00:00.000Z" }),
    ],
  ] as const)("rejects inconsistent %s snapshots", (_label, mutate) => {
    const database = open();
    const first = repository(database);
    const id = cloneAudit(database, "repository", "created", {
      configuration_json: JSON.stringify(mutate(first)),
    });
    corruptDetail(database, "repository", id, first.id);
  });

  it.each([
    ["template_created", { workflowKind: "pr_static_build", version: 2 }],
    ["draft_saved", { version: 3, draftRevision: 2, content: "PRIVATE_CANARY" }],
    ["draft_saved", { version: 2, draftRevision: 3 }],
    ["prompt_published", { promptVersionId: "missing", version: 2, publishedVersion: 1 }],
    ["bootstrap_registered", { promptVersionId: "missing" }],
  ] as const)("rejects malformed %s payloads", (action, payload) => {
    const { database } = seed();
    const id = cloneAudit(database, "prompt", action, { detail_json: JSON.stringify(payload) });
    corruptDetail(database, "prompt", id);
  });

  it("rejects cross-repository profile versions and histories while retaining scope isolation", () => {
    const { database, first, second, foreignProfile } = seed();
    const forgedProfile = cloneAudit(database, "prompt", "profile_published", {
      repository_id: first.id,
      entity_id: foreignProfile.profileId,
      detail_json: JSON.stringify({ profileVersionId: foreignProfile.id, version: 1 }),
    });
    corruptDetail(database, "prompt", forgedProfile, first.id);
    expect(
      read(database, "getRepositoryConfigurationAudit", {
        repositoryId: second.id,
        source: "prompt",
        eventId: forgedProfile,
      }),
    ).toBeNull();
    const history = required(
      auditRows(database, "prompt").find(
        (row) => row.action === "prompt_bound" && row.repository_id === second.id,
      ),
    );
    const forgedBinding = cloneAudit(database, "prompt", "prompt_bound", {
      repository_id: first.id,
      entity_id: required(history.entity_id),
      detail_json: required(history.detail_json),
    });
    corruptDetail(database, "prompt", forgedBinding, first.id);
    const profileHistory = required(
      auditRows(database, "prompt").find((row) => row.action === "profile_bound"),
    );
    const foreignHistory = cloneAudit(database, "prompt", "profile_bound", {
      repository_id: second.id,
      entity_id: required(profileHistory.entity_id),
      detail_json: required(profileHistory.detail_json),
    });
    corruptDetail(database, "prompt", foreignHistory, second.id);
  });

  it("rejects mismatched immutable author, previous version and bootstrap workflow", () => {
    const { database, first, published } = seed();
    corruptDetail(
      database,
      "prompt",
      cloneAudit(database, "prompt", "prompt_published", { actor_subject: "PRIVATE_CANARY" }),
    );
    const bound = required(
      auditRows(database, "prompt").find(
        (row) =>
          row.action === "prompt_bound" &&
          row.repository_id === first.id &&
          row.created_at === timestamp,
      ),
    );
    const mismatch = cloneAudit(database, "prompt", "prompt_bound", {
      repository_id: first.id,
      entity_id: required(bound.entity_id),
      detail_json: JSON.stringify({
        ...JSON.parse(bound.detail_json as string),
        previousVersionId: published.id,
      }),
    });
    corruptDetail(database, "prompt", mismatch, first.id);
    corruptDetail(
      database,
      "prompt",
      cloneAudit(database, "prompt", "bootstrap_registered", { entity_id: "issue_triage" }),
    );
  });

  it("rejects malformed stored JSON and overlong prompt metadata with one generic error", () => {
    const { database, first } = seed();
    database.exec("PRAGMA ignore_check_constraints = ON");
    const repoId = cloneAudit(database, "repository", "created", {
      configuration_json: '{"PRIVATE_CANARY":',
    });
    corruptDetail(database, "repository", repoId, first.id);
    const promptId = cloneAudit(database, "prompt", "draft_saved", {
      detail_json: '{"PRIVATE_CANARY":',
    });
    corruptDetail(database, "prompt", promptId);
    const oversized = cloneAudit(database, "prompt", "draft_saved", {
      detail_json: JSON.stringify({ version: 3, draftRevision: 2, padding: "x".repeat(16_384) }),
    });
    corruptDetail(database, "prompt", oversized);
  });
});
