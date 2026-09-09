import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  GitHubRepository,
  GitHubWorkItem,
  GitHubWorkItemRevision,
  OperatorRepositoryRole,
  RepositoryCreateRequest,
  SelfOrAllowlistPolicy,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createPullRequestRevisionKey } from "../github/revision-key.js";
import {
  handleRepositoryConfigurationRequest,
  isRepositoryConfigurationOperation,
  type RepositoryConfigurationRequest,
  type RepositoryOperation,
  type RepositoryOperationMap,
} from "./managed-repositories.js";
import { runMigrations } from "./migrations.js";
import { handleOperatorAccessRequest, type OperatorReadContext } from "./operator-access.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const timestamp = "2026-09-07T00:00:00.000Z";
const laterTimestamp = "2026-09-07T01:00:00.000Z";
const actor = { issuer: "https://identity.example.test", subject: "operator-1" };
const databases: DatabaseSync[] = [];
const authorizationPolicy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: 100,
  allowlistedActorGithubUserIds: [200],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "inherit_authorized_epoch",
};

const metadata = (githubRepositoryId = 1, fullName = "example/first"): GitHubRepository => {
  const [ownerLogin = "", name = ""] = fullName.split("/");
  return {
    githubRepositoryId,
    githubNodeId: `R_${githubRepositoryId}`,
    ownerLogin,
    name,
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    defaultBranch: "main",
    isPrivate: false,
  };
};

const createDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  expect(runMigrations(database, migrationsDirectory)).toBe(33);
  return database;
};

const execute = <Operation extends RepositoryOperation>(
  database: DatabaseSync,
  operation: Operation,
  input: RepositoryOperationMap[Operation]["input"],
  now = timestamp,
  context?: OperatorReadContext,
): RepositoryOperationMap[Operation]["output"] =>
  handleRepositoryConfigurationRequest(
    database,
    { operation, input } as RepositoryConfigurationRequest,
    now,
    context,
  ) as RepositoryOperationMap[Operation]["output"];

const createRepository = (
  database: DatabaseSync,
  request: RepositoryCreateRequest = { githubRepositoryId: 1, fullName: "example/first" },
) => execute(database, "createManagedRepository", { request, actor });

const bootstrap = (
  database: DatabaseSync,
  repositories = [{ githubRepositoryId: 1, fullName: "example/first" }],
) =>
  execute(database, "bootstrapManagedRepositories", {
    repositories,
    reviewer: { githubUserId: 100, login: "reviewer" },
    authorizationPolicy,
  });

const auditRows = (database: DatabaseSync) =>
  database
    .prepare(
      "SELECT repository_id, action, actor_issuer, actor_subject, version, configuration_json FROM repository_configuration_audit ORDER BY created_at, id",
    )
    .all();

const expectErrorCode = (operation: () => unknown, code: string): void => {
  expect(operation).toThrow(expect.objectContaining({ code }));
};

const insertProjection = (
  database: DatabaseSync,
  repositoryId: string,
  repository: GitHubRepository,
): void => {
  database
    .prepare(`INSERT INTO repositories (
      id, github_repository_id, github_node_id, owner_login, name, full_name, html_url,
      default_branch, is_private, snapshot_json, observed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      repositoryId,
      repository.githubRepositoryId,
      repository.githubNodeId,
      repository.ownerLogin,
      repository.name,
      repository.fullName,
      repository.htmlUrl,
      repository.defaultBranch,
      Number(repository.isPrivate),
      JSON.stringify(repository),
      timestamp,
      timestamp,
      timestamp,
    );
};

const insertDiscoveredRepository = (
  database: DatabaseSync,
  repositoryId: string,
  repository: GitHubRepository,
): void => {
  insertProjection(database, repositoryId, repository);
  database
    .prepare(`INSERT INTO managed_repositories (
      id, github_repository_id, full_name, enabled, version, connection_status,
      metadata_json, configuration_source, created_at, updated_at
    ) VALUES (?, ?, ?, 0, 1, 'unknown', ?, 'discovered', ?, ?)`)
    .run(
      repositoryId,
      repository.githubRepositoryId,
      repository.fullName,
      JSON.stringify(repository),
      timestamp,
      timestamp,
    );
};

const insertPollingEpoch = (
  database: DatabaseSync,
  sequence: number,
  repositoryId: string,
  reviewerId: number,
  login: string,
  options: { closed?: boolean; updatedAt?: string } = {},
): void => {
  const itemId = `item-${sequence}`;
  const revisionId = `revision-${sequence}`;
  const eventId = `event-${sequence}`;
  const closingEventId = `closing-event-${sequence}`;
  const decisionId = `decision-${sequence}`;
  const digest = "a".repeat(64);
  const updatedAt = options.updatedAt ?? timestamp;
  database
    .prepare(`INSERT INTO work_items (
      id, repository_id, resource_kind, github_work_item_id, github_node_id, github_number,
      state, title, body, html_url, author_github_user_id, author_login, author_account_type,
      current_revision_key, is_draft, source_created_at, source_updated_at, source_closed_at,
      snapshot_json, projection_source, observed_at, created_at, updated_at
    ) VALUES (?, ?, 'issue', ?, ?, ?, 'open', 'Polling fixture', NULL, 'https://github.com/example/repo/issues/1',
      200, 'author', 'user', ?, NULL, ?, ?, NULL, '{}', 'poll', ?, ?, ?)`)
    .run(
      itemId,
      repositoryId,
      sequence,
      `I_${sequence}`,
      sequence,
      digest,
      timestamp,
      updatedAt,
      updatedAt,
      timestamp,
      updatedAt,
    );
  database
    .prepare(`INSERT INTO work_item_revisions (
      id, work_item_id, revision_key, resource_kind, base_sha, head_sha, content_digest,
      source_updated_at, observed_at, revision_json, created_at
    ) VALUES (?, ?, ?, 'issue', NULL, NULL, ?, ?, ?, '{}', ?)`)
    .run(revisionId, itemId, digest, digest, timestamp, timestamp, timestamp);
  for (const closed of options.closed ? [false, true] : [false]) {
    const id = closed ? closingEventId : eventId;
    database
      .prepare(`INSERT INTO github_events (
        id, event_key, source, source_event_id, repository_id, work_item_id, revision_id,
        action, request_kind, close_reason, actor_github_user_id, actor_login,
        target_github_user_id, target_login, occurred_at, observed_at,
        normalized_sha256, normalized_json, created_at
      ) VALUES (?, ?, 'poll', ?, ?, ?, ?, ?, 'assignment', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`)
      .run(
        id,
        id,
        id,
        repositoryId,
        itemId,
        revisionId,
        closed ? "request_closed" : "request_opened",
        closed ? "assignment_removed" : null,
        reviewerId,
        login,
        reviewerId,
        login,
        updatedAt,
        updatedAt,
        digest,
        timestamp,
      );
  }
  database
    .prepare(`INSERT INTO authorization_decisions (
      id, decision_key, github_event_id, work_item_id, outcome, basis, reason,
      policy_kind, policy_version, actor_github_user_id, target_github_user_id,
      evaluated_at, policy_json, policy_sha256, decision_json, created_at
    ) VALUES (?, ?, ?, ?, 'authorized', 'self', 'authorized_self', 'self_or_allowlist',
      1, ?, ?, ?, ?, ?, '{}', ?)`)
    .run(
      decisionId,
      decisionId,
      eventId,
      itemId,
      reviewerId,
      reviewerId,
      timestamp,
      JSON.stringify({ ...authorizationPolicy, schedulingTargetGithubUserId: reviewerId }),
      digest,
      timestamp,
    );
  database
    .prepare(`INSERT INTO request_epochs (
      id, work_item_id, ordinal, request_kind, target_github_user_id, opening_event_id,
      authorization_decision_id, current_revision_id, status, opened_at,
      closing_event_id, close_reason, closed_at, epoch_json, created_at, updated_at
    ) VALUES (?, ?, 1, 'assignment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      `epoch-${sequence}`,
      itemId,
      reviewerId,
      eventId,
      decisionId,
      revisionId,
      options.closed ? "closed" : "active",
      timestamp,
      options.closed ? closingEventId : null,
      options.closed ? "assignment_removed" : null,
      options.closed ? updatedAt : null,
      JSON.stringify({ target: { githubUserId: reviewerId, login } }),
      timestamp,
      updatedAt,
    );
};

const insertPromptRevision = (
  database: DatabaseSync,
  workItemId: string,
  revisionId: string,
  revision: GitHubWorkItemRevision,
): void => {
  database
    .prepare(`INSERT INTO work_item_revisions (
      id, work_item_id, revision_key, resource_kind, base_sha, head_sha, content_digest,
      source_updated_at, observed_at, revision_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      revisionId,
      workItemId,
      revision.revisionKey,
      revision.kind,
      revision.kind === "pull_request" ? revision.baseSha : null,
      revision.kind === "pull_request" ? revision.headSha : null,
      revision.kind === "issue" ? revision.contentDigest : null,
      revision.sourceUpdatedAt,
      revision.observedAt,
      JSON.stringify(revision),
      timestamp,
    );
};

const insertPromptContext = (
  database: DatabaseSync,
  kind: GitHubWorkItem["kind"] = "issue",
  options: {
    repositoryId?: string;
    workItemId?: string;
    revisionId?: string;
    repository?: GitHubRepository;
    githubWorkItemId?: number;
  } = {},
) => {
  const repositoryId = options.repositoryId ?? "prompt-repository";
  const workItemId = options.workItemId ?? "prompt-work-item";
  const revisionId = options.revisionId ?? "prompt-revision";
  const repository = options.repository ?? metadata();
  const githubWorkItemId = options.githubWorkItemId ?? 101;
  insertProjection(database, repositoryId, repository);
  const workItemBase = {
    githubRepositoryId: repository.githubRepositoryId,
    githubWorkItemId,
    githubNodeId: `W_${githubWorkItemId}`,
    number: 7,
    title: "Prompt context fixture",
    body: "Stored issue or pull request content.",
    state: "open" as const,
    author: { githubUserId: 200, login: "author", accountType: "user" as const },
    htmlUrl: `${repository.htmlUrl}/${kind === "issue" ? "issues" : "pull"}/7`,
    createdAt: timestamp,
    updatedAt: timestamp,
    closedAt: null,
  };
  const workItem: GitHubWorkItem =
    kind === "issue" ? { ...workItemBase, kind } : { ...workItemBase, kind, isDraft: true };
  const revisionBase = {
    githubRepositoryId: repository.githubRepositoryId,
    githubWorkItemId: workItem.githubWorkItemId,
    sourceUpdatedAt: timestamp,
    observedAt: timestamp,
  };
  const contentDigest = createHash("sha256")
    .update(JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]))
    .digest("hex");
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const revision: GitHubWorkItemRevision =
    kind === "issue"
      ? { ...revisionBase, kind, revisionKey: contentDigest, contentDigest }
      : {
          ...revisionBase,
          kind,
          revisionKey: createPullRequestRevisionKey(baseSha, headSha),
          baseSha,
          headSha,
        };
  database
    .prepare(`INSERT INTO work_items (
      id, repository_id, resource_kind, github_work_item_id, github_node_id, github_number,
      state, title, body, html_url, author_github_user_id, author_login, author_account_type,
      current_revision_key, is_draft, source_created_at, source_updated_at, source_closed_at,
      snapshot_json, projection_source, observed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, 'poll', ?, ?, ?)`)
    .run(
      workItemId,
      repositoryId,
      workItem.kind,
      workItem.githubWorkItemId,
      workItem.githubNodeId,
      workItem.number,
      workItem.state,
      workItem.title,
      workItem.body,
      workItem.htmlUrl,
      workItem.author.githubUserId,
      workItem.author.login,
      revision.revisionKey,
      workItem.kind === "pull_request" ? Number(workItem.isDraft) : null,
      workItem.createdAt,
      workItem.updatedAt,
      workItem.closedAt,
      JSON.stringify(workItem),
      timestamp,
      timestamp,
      timestamp,
    );
  insertPromptRevision(database, workItemId, revisionId, revision);
  return { repositoryId, workItemId, revisionId, repository, workItem, revision };
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("operator-scoped managed repository reads", () => {
  const administrator = { issuer: "https://identity.example.test", subject: "platform-admin" };
  const principal = { issuer: "https://identity.example.test", subject: "repository-reader" };
  const reader: OperatorReadContext = { actor: principal, administrators: [administrator] };
  const platform: OperatorReadContext = { actor: administrator, administrators: [administrator] };
  let changeSequence = 0;
  function change(
    database: DatabaseSync,
    repositoryId: string,
    role: OperatorRepositoryRole | null,
    expectedVersion = 0,
  ) {
    return handleOperatorAccessRequest(
      database,
      {
        operation: "changeRepositoryAccess",
        input: {
          actor: administrator,
          repositoryId,
          request: {
            changeId: `managed-access-${++changeSequence}`,
            principal,
            role,
            expectedVersion,
            reason: "Managed repository read fixture.",
          },
        },
      },
      timestamp,
      [administrator],
    );
  }
  it.each(["viewer", "reviewer", "maintainer", "admin"] as const)(
    "applies %s visibility before repository search, total and pages",
    (role) => {
      const database = createDatabase();
      createRepository(database, { githubRepositoryId: 1, fullName: "example/a-hidden" });
      const visible = createRepository(database, {
        githubRepositoryId: 2,
        fullName: "example/b-visible",
      });
      const another = createRepository(database, {
        githubRepositoryId: 3,
        fullName: "example/c-visible",
      });
      change(database, visible.id, role);
      change(database, another.id, role);
      for (let page = 1; page <= 3; page++) {
        const output = execute(
          database,
          "listManagedRepositories",
          { page, pageSize: 1, search: "example", enabled: false },
          timestamp,
          reader,
        );
        expect(output.total).toBe(2);
        expect(output.items.map((repository) => repository.id)).toEqual(
          page <= 2 ? [page === 1 ? visible.id : another.id] : [],
        );
        expect(
          output.items.every((repository) => !Object.hasOwn(repository, "authorizationPolicy")),
        ).toBe(true);
      }
      expect(
        execute(database, "listManagedRepositories", { search: "hidden" }, timestamp, reader),
      ).toEqual({ items: [], total: 0 });
    },
  );
  it("returns null for hidden exact repository and GitHub identities", () => {
    const database = createDatabase();
    const repository = createRepository(database);
    expect(
      execute(database, "getManagedRepository", { repositoryId: repository.id }, timestamp, reader),
    ).toBeNull();
    expect(
      execute(
        database,
        "getManagedRepositoryByGitHubId",
        { githubRepositoryId: repository.githubRepositoryId },
        timestamp,
        reader,
      ),
    ).toBeNull();
    expect(execute(database, "listManagedRepositories", {}, timestamp, reader)).toEqual({
      items: [],
      total: 0,
    });
    change(database, repository.id, "viewer");
    expect(
      execute(database, "getManagedRepository", { repositoryId: repository.id }, timestamp, reader),
    ).toEqual(repository);
    expect(
      execute(
        database,
        "getManagedRepositoryByGitHubId",
        { githubRepositoryId: repository.githubRepositoryId },
        timestamp,
        reader,
      ),
    ).toEqual(repository);
  });
  it("does not reuse cached grants after revocation", () => {
    const database = createDatabase();
    const repository = createRepository(database);
    change(database, repository.id, "viewer");
    expect(execute(database, "listManagedRepositories", {}, timestamp, reader).total).toBe(1);
    expect(
      execute(database, "getManagedRepository", { repositoryId: repository.id }, timestamp, reader),
    ).not.toBeNull();
    change(database, repository.id, null, 1);
    expect(execute(database, "listManagedRepositories", {}, timestamp, reader)).toEqual({
      items: [],
      total: 0,
    });
    expect(
      execute(database, "getManagedRepository", { repositoryId: repository.id }, timestamp, reader),
    ).toBeNull();
    expect(
      execute(
        database,
        "getManagedRepositoryByGitHubId",
        { githubRepositoryId: repository.githubRepositoryId },
        timestamp,
        reader,
      ),
    ).toBeNull();
  });
  it("matches the exact issuer and subject using bound SQL values", () => {
    const database = createDatabase();
    const repository = createRepository(database);
    change(database, repository.id, "viewer");
    for (const actor of [
      { ...principal, issuer: "https://other.example.test" },
      { ...principal, subject: principal.subject.toUpperCase() },
      { ...principal, subject: "reader' OR 1 = 1 --" },
    ]) {
      const context = { actor, administrators: [administrator] };
      expect(execute(database, "listManagedRepositories", {}, timestamp, context).total).toBe(0);
      expect(
        execute(
          database,
          "getManagedRepository",
          { repositoryId: repository.id },
          timestamp,
          context,
        ),
      ).toBeNull();
    }
  });
  it("preserves platform administrator and unscoped internal reads", () => {
    const database = createDatabase();
    const first = createRepository(database);
    createRepository(database, { githubRepositoryId: 2, fullName: "example/second" });
    expect(execute(database, "listManagedRepositories", {}, timestamp, platform).total).toBe(2);
    expect(execute(database, "listManagedRepositories", {}).total).toBe(2);
    expect(
      execute(database, "getManagedRepository", { repositoryId: first.id }, timestamp, platform),
    ).toEqual(first);
    expect(
      execute(
        database,
        "getManagedRepositoryByGitHubId",
        { githubRepositoryId: first.githubRepositoryId },
        timestamp,
        platform,
      ),
    ).toEqual(first);
  });
  it("scopes two equal PR numbers by the actual stored repository and observes revocation", () => {
    const database = createDatabase();
    const first = insertPromptContext(database, "pull_request");
    const second = insertPromptContext(database, "pull_request", {
      repositoryId: "second-repository",
      workItemId: "second-item",
      revisionId: "second-revision",
      repository: metadata(2, "example/second"),
      githubWorkItemId: 202,
    });
    for (const context of [first, second])
      createRepository(database, {
        githubRepositoryId: context.repository.githubRepositoryId,
        fullName: context.repository.fullName,
      });
    change(database, first.repositoryId, "viewer");
    expect(first.workItem.number).toBe(second.workItem.number);
    expect(
      execute(
        database,
        "getPromptWorkItemContext",
        { workItemId: first.workItemId },
        timestamp,
        reader,
      )?.repositoryId,
    ).toBe(first.repositoryId);
    expect(
      execute(
        database,
        "getPromptWorkItemContext",
        { workItemId: second.workItemId },
        timestamp,
        reader,
      ),
    ).toBeNull();
    expect(
      execute(
        database,
        "getPromptWorkItemContext",
        { workItemId: second.workItemId },
        timestamp,
        platform,
      )?.repositoryId,
    ).toBe(second.repositoryId);
    expect(
      execute(database, "getPromptWorkItemContext", { workItemId: second.workItemId })
        ?.repositoryId,
    ).toBe(second.repositoryId);
    change(database, first.repositoryId, null, 1);
    expect(
      execute(
        database,
        "getPromptWorkItemContext",
        { workItemId: first.workItemId },
        timestamp,
        reader,
      ),
    ).toBeNull();
  });
  it("does not parse hidden work item content before the SQL authorization filter", () => {
    const database = createDatabase();
    const context = insertPromptContext(database, "pull_request");
    createRepository(database, {
      githubRepositoryId: context.repository.githubRepositoryId,
      fullName: context.repository.fullName,
    });
    database
      .prepare("UPDATE work_items SET snapshot_json = '{private-invalid-json' WHERE id = ?")
      .run(context.workItemId);
    expect(
      execute(
        database,
        "getPromptWorkItemContext",
        { workItemId: context.workItemId },
        timestamp,
        reader,
      ),
    ).toBeNull();
    expect(() =>
      execute(database, "getPromptWorkItemContext", { workItemId: context.workItemId }),
    ).toThrow();
  });
});

describe("managed repository configuration", () => {
  it("creates a disabled repository and records the authenticated actor in immutable audit", () => {
    const database = createDatabase();
    const repository = createRepository(database);

    expect(repository).toMatchObject({
      githubRepositoryId: 1,
      fullName: "example/first",
      enabled: false,
      version: 1,
      reviewerGithubUserId: null,
      reviewerGithubLogin: null,
      authorizationPolicy: null,
      schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
      connectionStatus: "unknown",
      connectionMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(execute(database, "getManagedRepositoryByGitHubId", { githubRepositoryId: 1 })).toEqual(
      repository,
    );
    expect(auditRows(database)).toEqual([
      {
        repository_id: repository.id,
        action: "created",
        actor_issuer: actor.issuer,
        actor_subject: actor.subject,
        version: 1,
        configuration_json: JSON.stringify(repository),
      },
    ]);
    expect(() => database.exec("DELETE FROM repository_configuration_audit")).toThrow(/immutable/u);
    expect(() =>
      database.exec("UPDATE repository_configuration_audit SET actor_subject = 'changed'"),
    ).toThrow(/immutable/u);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("reuses the persisted ingestion identity when an existing projection is enrolled", () => {
    const database = createDatabase();
    insertProjection(database, "repository-persisted", metadata());

    const repository = createRepository(database);

    expect(repository.id).toBe("repository-persisted");
    expect(execute(database, "getManagedRepository", { repositoryId: repository.id })).toEqual(
      repository,
    );
  });

  it("uses CAS and retains one audit snapshot per successful operator update", () => {
    const database = createDatabase();
    const repository = createRepository(database, {
      githubRepositoryId: 1,
      fullName: "example/first",
      schedulingLimits: { maxActiveLeases: 2, maxQueuedJobs: 10 },
    });
    const updated = execute(
      database,
      "updateManagedRepository",
      {
        repositoryId: repository.id,
        request: {
          expectedVersion: 1,
          enabled: true,
          schedulingLimits: { maxActiveLeases: 4, maxQueuedJobs: 20 },
        },
        actor: { ...actor, subject: "operator-2" },
      },
      laterTimestamp,
    );
    expect(updated).toEqual({
      ...repository,
      version: 2,
      enabled: true,
      schedulingLimits: { maxActiveLeases: 4, maxQueuedJobs: 20 },
      updatedAt: laterTimestamp,
    });

    expectErrorCode(
      () =>
        execute(database, "updateManagedRepository", {
          repositoryId: repository.id,
          request: {
            expectedVersion: 1,
            enabled: false,
            schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
          },
          actor,
        }),
      "PLATFORM_CONFLICT",
    );
    expect(execute(database, "getManagedRepository", { repositoryId: repository.id })).toEqual(
      updated,
    );
    expect(auditRows(database)).toHaveLength(2);
    expect(auditRows(database)).toContainEqual(
      expect.objectContaining({
        actor_subject: "operator-2",
        action: "updated",
        version: 2,
        configuration_json: JSON.stringify(updated),
      }),
    );
  });

  it.each([
    { maxActiveLeases: 1, maxQueuedJobs: 1 },
    { maxActiveLeases: 65_535, maxQueuedJobs: 1_000_000 },
    { maxActiveLeases: null, maxQueuedJobs: 5 },
    { maxActiveLeases: 3, maxQueuedJobs: null },
    { maxActiveLeases: null, maxQueuedJobs: null },
  ])("persists explicit scheduling limits on creation %j", (schedulingLimits) => {
    const database = createDatabase();
    const repository = createRepository(database, {
      githubRepositoryId: 1,
      fullName: "example/first",
      schedulingLimits,
    });
    expect(repository.schedulingLimits).toEqual(schedulingLimits);
    expect(execute(database, "getManagedRepository", { repositoryId: repository.id })).toEqual(
      repository,
    );
    expect(
      database
        .prepare("SELECT max_active_leases, max_queued_jobs FROM managed_repositories WHERE id = ?")
        .get(repository.id),
    ).toEqual({
      max_active_leases: schedulingLimits.maxActiveLeases,
      max_queued_jobs: schedulingLimits.maxQueuedJobs,
    });
    expect(auditRows(database)).toEqual([
      expect.objectContaining({ configuration_json: JSON.stringify(repository) }),
    ]);
  });

  it("retains omitted scheduling limits and replaces both fields including explicit nulls", () => {
    const database = createDatabase();
    const created = createRepository(database, {
      githubRepositoryId: 1,
      fullName: "example/first",
      schedulingLimits: { maxActiveLeases: 2, maxQueuedJobs: 10 },
    });
    const retained = execute(database, "updateManagedRepository", {
      repositoryId: created.id,
      request: { expectedVersion: created.version, enabled: true },
      actor,
    });
    expect(retained).toEqual({ ...created, enabled: true, version: 2 });
    let current = retained;
    for (const schedulingLimits of [
      { maxActiveLeases: null, maxQueuedJobs: 20 },
      { maxActiveLeases: 4, maxQueuedJobs: null },
      { maxActiveLeases: null, maxQueuedJobs: null },
    ]) {
      const updated = execute(database, "updateManagedRepository", {
        repositoryId: created.id,
        request: { expectedVersion: current.version, schedulingLimits },
        actor,
      });
      expect(updated).toEqual({ ...current, version: current.version + 1, schedulingLimits });
      expect(
        database
          .prepare(
            "SELECT max_active_leases, max_queued_jobs FROM managed_repositories WHERE id = ?",
          )
          .get(created.id),
      ).toEqual({
        max_active_leases: schedulingLimits.maxActiveLeases,
        max_queued_jobs: schedulingLimits.maxQueuedJobs,
      });
      expect(auditRows(database)).toContainEqual(
        expect.objectContaining({
          version: updated.version,
          action: "updated",
          actor_issuer: actor.issuer,
          actor_subject: actor.subject,
          configuration_json: JSON.stringify(updated),
        }),
      );
      current = updated;
    }
    expect(execute(database, "getManagedRepository", { repositoryId: created.id })).toEqual(
      current,
    );
    expect(auditRows(database)).toHaveLength(5);
  });

  it.each(
    [
      null,
      {},
      [],
      { maxActiveLeases: 2 },
      { maxQueuedJobs: 10 },
      { maxActiveLeases: 0, maxQueuedJobs: null },
      { maxActiveLeases: -1, maxQueuedJobs: null },
      { maxActiveLeases: 1.5, maxQueuedJobs: null },
      { maxActiveLeases: 65_536, maxQueuedJobs: null },
      { maxActiveLeases: "2", maxQueuedJobs: null },
      { maxActiveLeases: true, maxQueuedJobs: null },
      { maxActiveLeases: null, maxQueuedJobs: 0 },
      { maxActiveLeases: null, maxQueuedJobs: -1 },
      { maxActiveLeases: null, maxQueuedJobs: 1.5 },
      { maxActiveLeases: null, maxQueuedJobs: 1_000_001 },
      { maxActiveLeases: null, maxQueuedJobs: "10" },
      { maxActiveLeases: null, maxQueuedJobs: false },
      { maxActiveLeases: 2, maxQueuedJobs: 10, extra: 1 },
    ].map((value) => ({ value })),
  )("rejects malformed scheduling limits without creating or changing history %j", ({ value }) => {
    const database = createDatabase();
    const schedulingLimits = value as NonNullable<RepositoryCreateRequest["schedulingLimits"]>;
    expectErrorCode(
      () =>
        createRepository(database, {
          githubRepositoryId: 1,
          fullName: "example/first",
          schedulingLimits,
        }),
      "PLATFORM_INVALID",
    );
    expect(execute(database, "listManagedRepositories", {})).toEqual({ items: [], total: 0 });
    expect(auditRows(database)).toEqual([]);
    const repository = createRepository(database, {
      githubRepositoryId: 1,
      fullName: "example/first",
      schedulingLimits: { maxActiveLeases: 2, maxQueuedJobs: 10 },
    });
    const history = auditRows(database);
    expectErrorCode(
      () =>
        execute(database, "updateManagedRepository", {
          repositoryId: repository.id,
          request: { expectedVersion: 1, schedulingLimits },
          actor,
        }),
      "PLATFORM_INVALID",
    );
    expect(execute(database, "getManagedRepository", { repositoryId: repository.id })).toEqual(
      repository,
    );
    expect(auditRows(database)).toEqual(history);
  });

  it.each([
    { issuer: "", subject: actor.subject },
    { issuer: actor.issuer, subject: "" },
    { issuer: "i".repeat(2_049), subject: actor.subject },
    { issuer: actor.issuer, subject: "s".repeat(513) },
  ])("rolls back creation and updates for invalid audit actor case %#", (invalidActor) => {
    const database = createDatabase();
    expectErrorCode(
      () =>
        execute(database, "createManagedRepository", {
          request: {
            githubRepositoryId: 1,
            fullName: "example/first",
            schedulingLimits: { maxActiveLeases: 2, maxQueuedJobs: 10 },
          },
          actor: invalidActor,
        }),
      "PLATFORM_INVALID",
    );
    expect(execute(database, "listManagedRepositories", {})).toEqual({ items: [], total: 0 });
    expect(auditRows(database)).toEqual([]);

    const repository = createRepository(database, {
      githubRepositoryId: 1,
      fullName: "example/first",
      schedulingLimits: { maxActiveLeases: 2, maxQueuedJobs: 10 },
    });
    expectErrorCode(
      () =>
        execute(database, "updateManagedRepository", {
          repositoryId: repository.id,
          request: {
            expectedVersion: 1,
            enabled: true,
            schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: 20 },
          },
          actor: invalidActor,
        }),
      "PLATFORM_INVALID",
    );
    expect(execute(database, "getManagedRepository", { repositoryId: repository.id })).toEqual(
      repository,
    );
    expect(auditRows(database)).toHaveLength(1);
  });

  it("rolls back a settings update when its audit insert fails", () => {
    const database = createDatabase();
    const repository = createRepository(database, {
      githubRepositoryId: 1,
      fullName: "example/first",
      schedulingLimits: { maxActiveLeases: 2, maxQueuedJobs: 10 },
    });
    database.exec(`CREATE TEMP TRIGGER fail_repository_audit
      BEFORE INSERT ON repository_configuration_audit
      BEGIN SELECT RAISE(ABORT, 'Injected audit failure'); END`);

    expect(() =>
      execute(database, "updateManagedRepository", {
        repositoryId: repository.id,
        request: {
          expectedVersion: 1,
          enabled: true,
          schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: 20 },
        },
        actor,
      }),
    ).toThrow("Injected audit failure");
    expect(execute(database, "getManagedRepository", { repositoryId: repository.id })).toEqual(
      repository,
    );
    expect(auditRows(database)).toHaveLength(1);
  });

  it("returns null for unknown reads and rejects mutations of an unknown identity", () => {
    const database = createDatabase();
    expect(execute(database, "getManagedRepository", { repositoryId: "missing" })).toBeNull();
    expect(
      execute(database, "getManagedRepositoryByGitHubId", { githubRepositoryId: 42 }),
    ).toBeNull();
    for (const operation of [
      () =>
        execute(database, "updateManagedRepository", {
          repositoryId: "missing",
          request: { expectedVersion: 1, enabled: true },
          actor,
        }),
      () =>
        execute(database, "updateRepositoryConnection", {
          repositoryId: "missing",
          status: "error",
          message: "Unavailable",
        }),
      () => execute(database, "listManagedRepositoryPollingReviewers", { repositoryId: "missing" }),
    ]) {
      expectErrorCode(operation, "PLATFORM_NOT_FOUND");
    }
    expectErrorCode(
      () => execute(database, "getManagedRepository", { repositoryId: "../outside" }),
      "PLATFORM_INVALID",
    );
    expectErrorCode(
      () => execute(database, "getManagedRepositoryByGitHubId", { githubRepositoryId: 0 }),
      "PLATFORM_INVALID",
    );
  });

  it.each([
    { githubRepositoryId: 1, fullName: "example/renamed" },
    { githubRepositoryId: 2, fullName: "EXAMPLE/FIRST" },
  ])("rejects duplicate numeric identity or case-insensitive name $fullName", (request) => {
    const database = createDatabase();
    const repository = createRepository(database);
    expectErrorCode(() => createRepository(database, request), "PLATFORM_CONFLICT");
    expect(execute(database, "listManagedRepositories", {}).total).toBe(1);
    expect(execute(database, "getManagedRepository", { repositoryId: repository.id })).toEqual(
      repository,
    );
    expect(auditRows(database)).toHaveLength(1);
  });

  it("accepts canonical metadata casing and rejects metadata for a different identity", () => {
    const database = createDatabase();
    for (const invalidMetadata of [metadata(2), metadata(1, "example/other")]) {
      expectErrorCode(
        () =>
          execute(database, "createManagedRepository", {
            request: { githubRepositoryId: 1, fullName: "example/first" },
            metadata: invalidMetadata,
            actor,
          }),
        "PLATFORM_INVALID",
      );
    }
    const canonical = metadata(1, "Example/First");
    const repository = execute(database, "createManagedRepository", {
      request: { githubRepositoryId: 1, fullName: "example/first" },
      metadata: canonical,
      actor,
    });
    expect(repository).toMatchObject({ fullName: "Example/First", connectionStatus: "ready" });
    expect(
      database
        .prepare("SELECT metadata_json FROM managed_repositories WHERE id = ?")
        .get(repository.id),
    ).toEqual({ metadata_json: JSON.stringify(canonical) });
  });

  it("returns bounded filtered summaries without loading authorization policies", () => {
    const database = createDatabase();
    const first = createRepository(database, {
      githubRepositoryId: 1,
      fullName: "Example/Alpha",
      schedulingLimits: { maxActiveLeases: 3, maxQueuedJobs: 12 },
    });
    const second = createRepository(database, {
      githubRepositoryId: 2,
      fullName: "example/Beta",
      enabled: true,
    });
    execute(database, "updateManagedRepository", {
      repositoryId: first.id,
      request: {
        expectedVersion: 1,
        reviewerGithubUserId: 100,
        reviewerGithubLogin: "reviewer",
        authorizationPolicy,
        schedulingLimits: { maxActiveLeases: 7, maxQueuedJobs: null },
      },
      actor,
    });
    const summary = execute(database, "listManagedRepositories", { page: 1, pageSize: 1 });
    expect(summary.total).toBe(2);
    expect(summary.items).toHaveLength(1);
    expect(summary.items[0]).toEqual({
      id: first.id,
      githubRepositoryId: 1,
      fullName: "Example/Alpha",
      enabled: false,
      version: 2,
      reviewerGithubUserId: 100,
      reviewerGithubLogin: "reviewer",
      schedulingLimits: { maxActiveLeases: 7, maxQueuedJobs: null },
      connectionStatus: "unknown",
      connectionMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(summary.items[0]).not.toHaveProperty("authorizationPolicy");
    expect(summary.items[0]).not.toHaveProperty("metadata_json");
    const { authorizationPolicy: _policy, ...expectedSecondSummary } = second;
    expect(execute(database, "listManagedRepositories", { page: 2, pageSize: 1 }).items).toEqual([
      {
        ...expectedSecondSummary,
        schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
      },
    ]);
    expect(
      execute(database, "listManagedRepositories", { search: "EXAMPLE/", enabled: true }).items.map(
        (repository) => repository.fullName,
      ),
    ).toEqual(["example/Beta"]);
    expect(execute(database, "listManagedRepositories", { search: "%" }).total).toBe(0);
    expect(execute(database, "listManagedRepositories", { page: 3, pageSize: 1 })).toEqual({
      items: [],
      total: 2,
    });
  });

  it.each([
    { page: 0 },
    { page: 1.5 },
    { pageSize: 0 },
    { pageSize: 51 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
    { search: "s".repeat(513) },
  ])("rejects an invalid or unbounded repository list query %j", (input) => {
    expectErrorCode(
      () => execute(createDatabase(), "listManagedRepositories", input),
      "PLATFORM_INVALID",
    );
  });

  it.each([
    { reviewerGithubUserId: 100 },
    { reviewerGithubLogin: "reviewer" },
    { reviewerGithubUserId: 100, reviewerGithubLogin: "not a login" },
    { reviewerGithubUserId: 101, reviewerGithubLogin: "reviewer", authorizationPolicy },
    { authorizationPolicy },
  ])("rejects mismatched reviewer and policy settings without advancing CAS %j", (changes) => {
    const database = createDatabase();
    const repository = createRepository(database);
    expectErrorCode(
      () =>
        execute(database, "updateManagedRepository", {
          repositoryId: repository.id,
          request: { expectedVersion: 1, ...changes },
          actor,
        }),
      "PLATFORM_INVALID",
    );
    expect(execute(database, "getManagedRepository", { repositoryId: repository.id })).toEqual(
      repository,
    );
    expect(auditRows(database)).toHaveLength(1);
  });

  it("configures and clears the reviewer and policy together", () => {
    const database = createDatabase();
    const repository = createRepository(database);
    const configured = execute(database, "updateManagedRepository", {
      repositoryId: repository.id,
      request: {
        expectedVersion: 1,
        reviewerGithubUserId: 100,
        reviewerGithubLogin: "reviewer",
        authorizationPolicy,
      },
      actor,
    });
    expect(configured.authorizationPolicy).toEqual(authorizationPolicy);
    expectErrorCode(
      () =>
        execute(database, "updateManagedRepository", {
          repositoryId: repository.id,
          request: { expectedVersion: 2, reviewerGithubUserId: null, reviewerGithubLogin: null },
          actor,
        }),
      "PLATFORM_INVALID",
    );
    const cleared = execute(database, "updateManagedRepository", {
      repositoryId: repository.id,
      request: {
        expectedVersion: 2,
        reviewerGithubUserId: null,
        reviewerGithubLogin: null,
        authorizationPolicy: null,
      },
      actor,
    });
    expect(cleared).toMatchObject({
      version: 3,
      reviewerGithubUserId: null,
      reviewerGithubLogin: null,
      authorizationPolicy: null,
    });
  });
});

describe("managed repository bootstrap and connection lifecycle", () => {
  it("bootstraps a discovered identity once and never overwrites later operator changes", () => {
    const database = createDatabase();
    insertDiscoveredRepository(database, "repository-persisted", metadata());
    expect(bootstrap(database)).toEqual({ imported: 1 });
    const configured = execute(database, "getManagedRepository", {
      repositoryId: "repository-persisted",
    });
    expect(configured).toMatchObject({
      id: "repository-persisted",
      enabled: true,
      version: 2,
      reviewerGithubUserId: 100,
      reviewerGithubLogin: "reviewer",
      authorizationPolicy,
    });
    const updated = execute(database, "updateManagedRepository", {
      repositoryId: "repository-persisted",
      request: { expectedVersion: 2, enabled: false },
      actor,
    });

    expect(bootstrap(database, [{ githubRepositoryId: 2, fullName: "example/other" }])).toEqual({
      imported: 0,
    });
    expect(execute(database, "getManagedRepository", { repositoryId: updated.id })).toEqual(
      updated,
    );
    expect(execute(database, "listManagedRepositories", {}).total).toBe(1);
    expect(auditRows(database)).toHaveLength(2);
    expect(auditRows(database)).toContainEqual(
      expect.objectContaining({
        action: "bootstrapped",
        actor_issuer: "system",
        actor_subject: "github-environment-bootstrap",
      }),
    );
  });

  it("keeps operator-owned repository settings during the first bootstrap", () => {
    const database = createDatabase();
    const repository = createRepository(database);
    expect(bootstrap(database)).toEqual({ imported: 0 });
    expect(execute(database, "getManagedRepository", { repositoryId: repository.id })).toEqual(
      repository,
    );
    expect(auditRows(database)).toHaveLength(1);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM repository_configuration_bootstrap").get(),
    ).toEqual({ count: 1 });
  });

  it("rolls back a conflicting bootstrap batch and permits a corrected retry", () => {
    const database = createDatabase();
    expectErrorCode(
      () =>
        bootstrap(database, [
          { githubRepositoryId: 1, fullName: "example/first" },
          { githubRepositoryId: 2, fullName: "EXAMPLE/FIRST" },
        ]),
      "PLATFORM_CONFLICT",
    );
    expect(execute(database, "listManagedRepositories", {})).toEqual({ items: [], total: 0 });
    expect(auditRows(database)).toEqual([]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM repository_configuration_bootstrap").get(),
    ).toEqual({ count: 0 });
    expect(bootstrap(database)).toEqual({ imported: 1 });
  });

  it("accepts a same-ID rename without changing operator settings or configuration version", () => {
    const database = createDatabase();
    const repository = createRepository(database, {
      githubRepositoryId: 1,
      fullName: "example/first",
      enabled: true,
    });
    const renamed = execute(
      database,
      "updateRepositoryConnection",
      {
        repositoryId: repository.id,
        status: "ready",
        message: "GitHub metadata is accessible.",
        metadata: metadata(1, "example/renamed"),
      },
      laterTimestamp,
    );

    expect(renamed).toEqual({
      ...repository,
      fullName: "example/renamed",
      connectionStatus: "ready",
      connectionMessage: "GitHub metadata is accessible.",
      updatedAt: laterTimestamp,
    });
    expect(auditRows(database)).toHaveLength(1);
    const failed = execute(database, "updateRepositoryConnection", {
      repositoryId: repository.id,
      status: "error",
      message: "The repository is not accessible.",
    });
    expect(failed.fullName).toBe("example/renamed");
    expect(failed.version).toBe(repository.version);
    expect(
      database
        .prepare("SELECT metadata_json FROM managed_repositories WHERE id = ?")
        .get(repository.id),
    ).toEqual({ metadata_json: JSON.stringify(metadata(1, "example/renamed")) });
  });

  it("rejects connection metadata identity changes and name conflicts transactionally", () => {
    const database = createDatabase();
    const repository = createRepository(database);
    createRepository(database, { githubRepositoryId: 2, fullName: "example/other" });
    for (const [connectionMetadata, code] of [
      [metadata(2, "example/first"), "PLATFORM_INVALID"],
      [metadata(1, "EXAMPLE/OTHER"), "PLATFORM_CONFLICT"],
    ] as const) {
      expectErrorCode(
        () =>
          execute(database, "updateRepositoryConnection", {
            repositoryId: repository.id,
            status: "ready",
            message: "Ready",
            metadata: connectionMetadata,
          }),
        code,
      );
      expect(execute(database, "getManagedRepository", { repositoryId: repository.id })).toEqual(
        repository,
      );
    }
  });

  it.each(["", "x".repeat(2_049), "unsafe\0message"])(
    "rejects invalid connection messages without mutating settings",
    (message) => {
      const database = createDatabase();
      const repository = createRepository(database);
      expectErrorCode(
        () =>
          execute(database, "updateRepositoryConnection", {
            repositoryId: repository.id,
            status: "error",
            message,
          }),
        "PLATFORM_INVALID",
      );
      expect(execute(database, "getManagedRepository", { repositoryId: repository.id })).toEqual(
        repository,
      );
    },
  );
});

describe("managed repository polling reviewers", () => {
  it("keeps historical active reviewer identities scoped to the repository and uses latest login", () => {
    const database = createDatabase();
    const first = createRepository(database);
    const second = createRepository(database, { githubRepositoryId: 2, fullName: "example/other" });
    insertProjection(database, first.id, metadata());
    insertProjection(database, second.id, metadata(2, "example/other"));
    insertPollingEpoch(database, 1, first.id, 100, "old-reviewer");
    insertPollingEpoch(database, 2, first.id, 100, "renamed-reviewer", {
      updatedAt: laterTimestamp,
    });
    insertPollingEpoch(database, 3, first.id, 101, "other-active-reviewer");
    insertPollingEpoch(database, 4, first.id, 102, "closed-reviewer", { closed: true });
    insertPollingEpoch(database, 5, second.id, 103, "other-repository-reviewer");

    expect(
      execute(database, "listManagedRepositoryPollingReviewers", { repositoryId: first.id }),
    ).toEqual([
      { githubUserId: 100, login: "renamed-reviewer" },
      { githubUserId: 101, login: "other-active-reviewer" },
    ]);
    expect(
      execute(database, "listManagedRepositoryPollingReviewers", { repositoryId: second.id }),
    ).toEqual([{ githubUserId: 103, login: "other-repository-reviewer" }]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects invalid stored reviewer logins instead of passing them to GitHub polling", () => {
    const database = createDatabase();
    const repository = createRepository(database);
    insertProjection(database, repository.id, metadata());
    insertPollingEpoch(database, 1, repository.id, 100, "invalid/login");

    expectErrorCode(
      () =>
        execute(database, "listManagedRepositoryPollingReviewers", { repositoryId: repository.id }),
      "PLATFORM_INVALID",
    );
  });

  it("rejects more active reviewer identities than the bounded polling contract supports", () => {
    const database = createDatabase();
    const repository = createRepository(database);
    insertProjection(database, repository.id, metadata());
    for (let index = 1; index <= 1_025; index += 1) {
      insertPollingEpoch(database, index, repository.id, index, `reviewer-${index}`);
    }

    expectErrorCode(
      () =>
        execute(database, "listManagedRepositoryPollingReviewers", { repositoryId: repository.id }),
      "PLATFORM_INVALID",
    );
  });
});

describe("managed repository prompt work item context", () => {
  it("returns null for an unknown work item", () => {
    const database = createDatabase();

    expect(execute(database, "getPromptWorkItemContext", { workItemId: "missing" })).toBeNull();
  });

  it.each(["", "../outside"])("rejects an invalid work item identity %j", (workItemId) => {
    const database = createDatabase();

    expectErrorCode(
      () => execute(database, "getPromptWorkItemContext", { workItemId }),
      "PLATFORM_INVALID",
    );
  });

  it.each(["issue", "pull_request"] as const)(
    "returns the stored repository, %s, and its current revision without requiring enrollment",
    (kind) => {
      const database = createDatabase();
      const context = insertPromptContext(database, kind);

      expect(
        execute(database, "getPromptWorkItemContext", { workItemId: context.workItemId }),
      ).toEqual({
        repositoryId: context.repositoryId,
        repository: context.repository,
        workItem: context.workItem,
        revision: context.revision,
      });
      expect(execute(database, "listManagedRepositories", {})).toEqual({ items: [], total: 0 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    },
  );

  it("selects the current revision even when another revision was observed later", () => {
    const database = createDatabase();
    const context = insertPromptContext(database);
    insertPromptRevision(database, context.workItemId, "later-observed-revision", {
      ...context.revision,
      kind: "issue",
      revisionKey: "c".repeat(64),
      contentDigest: "c".repeat(64),
      observedAt: laterTimestamp,
    });

    expect(
      execute(database, "getPromptWorkItemContext", { workItemId: context.workItemId })?.revision,
    ).toEqual(context.revision);
  });

  it("returns null when only historical revisions exist for the work item", () => {
    const database = createDatabase();
    const context = insertPromptContext(database);
    database
      .prepare("UPDATE work_items SET current_revision_key = ? WHERE id = ?")
      .run("c".repeat(64), context.workItemId);

    expect(
      execute(database, "getPromptWorkItemContext", { workItemId: context.workItemId }),
    ).toBeNull();
  });

  it("does not borrow an identically keyed revision from a different work item", () => {
    const database = createDatabase();
    const context = insertPromptContext(database);
    insertPollingEpoch(database, 2, context.repositoryId, 100, "reviewer");
    insertPromptRevision(database, "item-2", "other-item-revision", {
      ...context.revision,
      githubWorkItemId: 2,
    });
    database.prepare("DELETE FROM work_item_revisions WHERE id = ?").run(context.revisionId);

    expect(
      execute(database, "getPromptWorkItemContext", { workItemId: context.workItemId }),
    ).toBeNull();
  });

  it.each(["repository", "workItem", "revision"] as const)(
    "rejects a %s snapshot from a different repository",
    (snapshot) => {
      const database = createDatabase();
      const context = insertPromptContext(database);
      if (snapshot === "repository") {
        database
          .prepare("UPDATE repositories SET snapshot_json = ? WHERE id = ?")
          .run(JSON.stringify(metadata(2, "example/other")), context.repositoryId);
      } else if (snapshot === "workItem") {
        database
          .prepare("UPDATE work_items SET snapshot_json = ? WHERE id = ?")
          .run(JSON.stringify({ ...context.workItem, githubRepositoryId: 2 }), context.workItemId);
      } else {
        database
          .prepare("UPDATE work_item_revisions SET revision_json = ? WHERE id = ?")
          .run(JSON.stringify({ ...context.revision, githubRepositoryId: 2 }), context.revisionId);
      }

      expectErrorCode(
        () => execute(database, "getPromptWorkItemContext", { workItemId: context.workItemId }),
        "PLATFORM_INVALID",
      );
    },
  );

  it("rejects a revision snapshot for a different work item", () => {
    const database = createDatabase();
    const context = insertPromptContext(database);
    database
      .prepare("UPDATE work_item_revisions SET revision_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...context.revision, githubWorkItemId: 999 }), context.revisionId);

    expectErrorCode(
      () => execute(database, "getPromptWorkItemContext", { workItemId: context.workItemId }),
      "PLATFORM_INVALID",
    );
  });

  it("rejects a work item snapshot whose kind differs from its revision", () => {
    const database = createDatabase();
    const context = insertPromptContext(database);
    database
      .prepare("UPDATE work_items SET snapshot_json = ? WHERE id = ?")
      .run(
        JSON.stringify({ ...context.workItem, kind: "pull_request", isDraft: false }),
        context.workItemId,
      );

    expectErrorCode(
      () => execute(database, "getPromptWorkItemContext", { workItemId: context.workItemId }),
      "PLATFORM_INVALID",
    );
  });

  it("rejects an unsupported stored work item kind", () => {
    const database = createDatabase();
    const context = insertPromptContext(database);
    database
      .prepare("UPDATE work_items SET snapshot_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...context.workItem, kind: "discussion" }), context.workItemId);

    expectErrorCode(
      () => execute(database, "getPromptWorkItemContext", { workItemId: context.workItemId }),
      "PLATFORM_INVALID",
    );
  });

  it.each([
    ["repository numeric identity", "UPDATE repositories SET github_repository_id = 999"],
    ["work item numeric identity", "UPDATE work_items SET github_work_item_id = 999"],
    ["work item kind", "UPDATE work_items SET resource_kind = 'pull_request', is_draft = 0"],
    [
      "revision kind",
      `UPDATE work_item_revisions SET resource_kind = 'pull_request',
        content_digest = NULL, base_sha = '${"a".repeat(40)}', head_sha = '${"b".repeat(40)}'`,
    ],
  ])("rejects snapshots that disagree with the projected %s", (_description, mutation) => {
    const database = createDatabase();
    const context = insertPromptContext(database);
    database.exec(mutation);

    expectErrorCode(
      () => execute(database, "getPromptWorkItemContext", { workItemId: context.workItemId }),
      "PLATFORM_INVALID",
    );
  });

  it("rejects a revision snapshot whose key is not the selected current revision", () => {
    const database = createDatabase();
    const context = insertPromptContext(database);
    database
      .prepare("UPDATE work_item_revisions SET revision_json = ? WHERE id = ?")
      .run(
        JSON.stringify({ ...context.revision, revisionKey: "c".repeat(64) }),
        context.revisionId,
      );

    expectErrorCode(
      () => execute(database, "getPromptWorkItemContext", { workItemId: context.workItemId }),
      "PLATFORM_INVALID",
    );
  });

  it("rejects an issue revision snapshot that differs from the projected content digest", () => {
    const database = createDatabase();
    const context = insertPromptContext(database);
    database
      .prepare("UPDATE work_item_revisions SET content_digest = ? WHERE id = ?")
      .run("c".repeat(64), context.revisionId);

    expectErrorCode(
      () => execute(database, "getPromptWorkItemContext", { workItemId: context.workItemId }),
      "PLATFORM_INVALID",
    );
  });

  it.each(["base_sha", "head_sha"] as const)(
    "rejects a pull request revision snapshot that differs from the projected %s",
    (column) => {
      const database = createDatabase();
      const context = insertPromptContext(database, "pull_request");
      database
        .prepare(`UPDATE work_item_revisions SET ${column} = ? WHERE id = ?`)
        .run("c".repeat(40), context.revisionId);

      expectErrorCode(
        () => execute(database, "getPromptWorkItemContext", { workItemId: context.workItemId }),
        "PLATFORM_INVALID",
      );
    },
  );
});

describe("repository operation dispatch", () => {
  it("recognizes only the repository configuration operation namespace", () => {
    for (const operation of [
      "listManagedRepositories",
      "getManagedRepository",
      "getManagedRepositoryByGitHubId",
      "getPromptWorkItemContext",
      "listManagedRepositoryPollingReviewers",
      "createManagedRepository",
      "updateManagedRepository",
      "updateRepositoryConnection",
      "bootstrapManagedRepositories",
    ]) {
      expect(isRepositoryConfigurationOperation(operation)).toBe(true);
    }
    expect(isRepositoryConfigurationOperation("createWorkerToken")).toBe(false);
    expect(isRepositoryConfigurationOperation("toString")).toBe(false);
  });
});
