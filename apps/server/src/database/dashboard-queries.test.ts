import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  ActiveAuthorizedRequestEpoch,
  AuthorizationDecision,
  DashboardHealthComponent,
  DashboardJobReadQuery,
  DashboardJobStage,
  DashboardWorkItemStage,
  ExecutionPhase,
  GitHubRepository,
  GitHubWorkItem,
  GitHubWorkItemRevision,
  JobAdmissionState,
  JobExecutionTemplate,
  JobState,
  NormalizedSchedulingEvent,
  OperatorRepositoryRole,
  RunFailureDiagnostics,
  SelfOrAllowlistPolicy,
  WorkerCapabilities,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getJob, getSystemSnapshot, listJobs, listWorkItems } from "./dashboard-queries.js";
import { createJobAdmissionInTransaction } from "./job-admission.js";
import { runMigrations } from "./migrations.js";
import { handleOperatorAccessRequest, type OperatorReadContext } from "./operator-access.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const databases: DatabaseSync[] = [];
const timestamp = "2026-09-01T10:00:00.000Z";
const laterTimestamp = "2026-09-01T11:00:00.000Z";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const ids = (result: { readonly items: readonly { readonly id: string }[] }): string[] =>
  result.items.map((item) => item.id);

const repository: GitHubRepository = {
  githubRepositoryId: 1,
  githubNodeId: "repository-node",
  ownerLogin: "microsoft",
  name: "PowerToys",
  fullName: "microsoft/PowerToys",
  htmlUrl: "https://github.com/microsoft/PowerToys",
  defaultBranch: "main",
  isPrivate: false,
};
const reviewer = { githubUserId: 100, login: "reviewer", accountType: "user" } as const;
const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [200],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "inherit_authorized_epoch",
};

interface RepositoryFixture {
  readonly id: string;
  readonly snapshot: GitHubRepository;
}

interface WorkItemFixture {
  readonly id: string;
  readonly repository: RepositoryFixture;
  readonly revisionId: string;
  readonly snapshot: GitHubWorkItem;
  readonly revision: GitHubWorkItemRevision;
}

const createFixture = () => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  const schemaVersion = runMigrations(database, migrationsDirectory);
  const addRepository = (id: string, snapshot: GitHubRepository): RepositoryFixture => {
    database
      .prepare(`
      INSERT INTO repositories (
        id, github_repository_id, github_node_id, owner_login, name, full_name,
        html_url, default_branch, is_private, snapshot_json, observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        snapshot.githubRepositoryId,
        snapshot.githubNodeId,
        snapshot.ownerLogin,
        snapshot.name,
        snapshot.fullName,
        snapshot.htmlUrl,
        snapshot.defaultBranch,
        snapshot.isPrivate ? 1 : 0,
        JSON.stringify(snapshot),
        timestamp,
        timestamp,
        timestamp,
      );
    return { id, snapshot };
  };
  const defaultRepository = addRepository("repository", repository);
  let sequence = 0;

  const addWorkItem = (
    id: string,
    options: {
      readonly repository?: RepositoryFixture;
      readonly kind?: "issue" | "pull_request";
      readonly state?: "open" | "closed";
      readonly title?: string;
      readonly authorLogin?: string;
      readonly number?: number;
      readonly updatedAt?: string;
    } = {},
  ): WorkItemFixture => {
    sequence += 1;
    const kind = options.kind ?? "issue";
    const updatedAt = options.updatedAt ?? timestamp;
    const selectedRepository = options.repository ?? defaultRepository;
    const number = options.number ?? sequence;
    const base = {
      githubRepositoryId: selectedRepository.snapshot.githubRepositoryId,
      githubWorkItemId: sequence,
      githubNodeId: `node-${id}`,
      number,
      title: options.title ?? `Title for ${id}`,
      body: null,
      state: options.state ?? "open",
      author: {
        githubUserId: 200,
        login: options.authorLogin ?? "contributor",
        accountType: "user" as const,
      },
      htmlUrl: `${selectedRepository.snapshot.htmlUrl}/${kind === "issue" ? "issues" : "pull"}/${number}`,
      createdAt: timestamp,
      updatedAt,
      closedAt: options.state === "closed" ? updatedAt : null,
    };
    const snapshot: GitHubWorkItem =
      kind === "issue" ? { ...base, kind } : { ...base, kind, isDraft: false };
    const revisionBase = {
      githubRepositoryId: selectedRepository.snapshot.githubRepositoryId,
      githubWorkItemId: sequence,
      revisionKey: hash(id),
      observedAt: updatedAt,
      sourceUpdatedAt: updatedAt,
    };
    const revision: GitHubWorkItemRevision =
      kind === "issue"
        ? { ...revisionBase, kind, contentDigest: hash(id) }
        : { ...revisionBase, kind, baseSha: "a".repeat(40), headSha: "b".repeat(40) };
    const revisionId = `revision-${id}`;
    database
      .prepare(`
        INSERT INTO work_items (
          id, repository_id, resource_kind, github_work_item_id, github_node_id,
          github_number, state, title, html_url, author_github_user_id, author_login,
          author_account_type, current_revision_key, is_draft, source_created_at,
          source_updated_at, source_closed_at, snapshot_json, projection_source,
          observed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, 'poll', ?, ?, ?)
      `)
      .run(
        id,
        selectedRepository.id,
        kind,
        snapshot.githubWorkItemId,
        snapshot.githubNodeId,
        snapshot.number,
        snapshot.state,
        snapshot.title,
        snapshot.htmlUrl,
        snapshot.author.githubUserId,
        snapshot.author.login,
        revision.revisionKey,
        kind === "issue" ? null : 0,
        snapshot.createdAt,
        updatedAt,
        snapshot.closedAt,
        JSON.stringify(snapshot),
        updatedAt,
        timestamp,
        updatedAt,
      );
    database
      .prepare(`
        INSERT INTO work_item_revisions (
          id, work_item_id, revision_key, resource_kind, base_sha, head_sha,
          content_digest, source_updated_at, observed_at, revision_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        revisionId,
        id,
        revision.revisionKey,
        kind,
        revision.kind === "pull_request" ? revision.baseSha : null,
        revision.kind === "pull_request" ? revision.headSha : null,
        revision.kind === "issue" ? revision.contentDigest : null,
        updatedAt,
        updatedAt,
        JSON.stringify(revision),
        timestamp,
      );
    return { id, repository: selectedRepository, revisionId, snapshot, revision };
  };

  const addEvent = (
    item: WorkItemFixture,
    action: "request_opened" | "request_closed",
    suffix: string = action,
    occurredAt = timestamp,
  ): NormalizedSchedulingEvent => {
    const eventBase = {
      contractVersion: 1 as const,
      eventId: `${item.id}-${suffix}`,
      source: "poll" as const,
      sourceEventId: `${item.id}-${suffix}`,
      occurredAt,
      observedAt: occurredAt,
      repository: item.repository.snapshot,
      workItem: item.snapshot,
      revision: item.revision,
      author: item.snapshot.author,
      actor: reviewer,
      target: reviewer,
      requestKind: "assignment" as const,
    };
    const event: NormalizedSchedulingEvent =
      action === "request_opened"
        ? { ...eventBase, action }
        : { ...eventBase, action, closeReason: "assignment_removed" };
    const json = JSON.stringify(event);
    database
      .prepare(`
        INSERT INTO github_events (
          id, event_key, source, source_event_id, repository_id, work_item_id, revision_id,
          action, request_kind, close_reason, actor_github_user_id, actor_login,
          target_github_user_id, target_login, occurred_at, observed_at,
          normalized_sha256, normalized_json, created_at
        ) VALUES (?, ?, 'poll', ?, ?, ?, ?, ?, 'assignment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.eventId,
        event.eventId,
        event.sourceEventId,
        item.repository.id,
        item.id,
        item.revisionId,
        action,
        action === "request_closed" ? "assignment_removed" : null,
        reviewer.githubUserId,
        reviewer.login,
        reviewer.githubUserId,
        reviewer.login,
        occurredAt,
        occurredAt,
        hash(json),
        json,
        occurredAt,
      );
    return event;
  };

  const addDecision = (
    item: WorkItemFixture,
    event: NormalizedSchedulingEvent,
    basis: "self" | "allowlist" | null,
  ): string => {
    const id = `${event.eventId}-decision`;
    const decision: AuthorizationDecision = {
      eventId: event.eventId,
      outcome: basis === null ? "denied" : "authorized",
      basis,
      reason:
        basis === null
          ? "denied_actor_not_allowed"
          : basis === "self"
            ? "authorized_self"
            : "authorized_allowlisted",
      policyKind: "self_or_allowlist",
      policyVersion: 1,
      actorGithubUserId: reviewer.githubUserId,
      targetGithubUserId: reviewer.githubUserId,
      inheritedFromEpochId: null,
      evaluatedAt: event.occurredAt,
    };
    const policyJson = JSON.stringify(policy);
    database
      .prepare(`
        INSERT INTO authorization_decisions (
          id, decision_key, github_event_id, work_item_id, outcome, basis, reason,
          policy_kind, policy_version, actor_github_user_id, target_github_user_id,
          evaluated_at, policy_json, policy_sha256, decision_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'self_or_allowlist', 1, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        id,
        event.eventId,
        item.id,
        decision.outcome,
        basis,
        decision.reason,
        reviewer.githubUserId,
        reviewer.githubUserId,
        event.occurredAt,
        policyJson,
        hash(policyJson),
        JSON.stringify(decision),
        event.occurredAt,
      );
    return id;
  };

  const addEpoch = (item: WorkItemFixture, basis: "self" | "allowlist" = "self"): void => {
    const event = addEvent(item, "request_opened");
    const decisionId = addDecision(item, event, basis);
    const epoch: ActiveAuthorizedRequestEpoch = {
      requestEpochId: `epoch-${item.id}`,
      githubRepositoryId: item.snapshot.githubRepositoryId,
      githubWorkItemId: item.snapshot.githubWorkItemId,
      requestKind: "assignment",
      sequence: 1,
      target: reviewer,
      openedByActor: reviewer,
      authorizationBasis: basis,
      authorizationPolicyVersion: 1,
      openedByEventId: event.eventId,
      openedAt: timestamp,
      currentRevision: item.revision,
      status: "active",
      closedByEventId: null,
      closedAt: null,
      closeReason: null,
    };
    database
      .prepare(`
        INSERT INTO request_epochs (
          id, work_item_id, ordinal, request_kind, target_github_user_id,
          opening_event_id, authorization_decision_id, current_revision_id,
          status, opened_at, epoch_json, created_at, updated_at
        ) VALUES (?, ?, 1, 'assignment', ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `)
      .run(
        epoch.requestEpochId,
        item.id,
        reviewer.githubUserId,
        event.eventId,
        decisionId,
        item.revisionId,
        timestamp,
        JSON.stringify(epoch),
        timestamp,
        timestamp,
      );
  };

  const addJob = (
    item: WorkItemFixture,
    options: {
      readonly id?: string;
      readonly status?: JobState;
      readonly phase?: ExecutionPhase | null;
      readonly createdAt?: string;
      readonly admission?: JobAdmissionState;
      readonly attemptCount?: number;
      readonly admissionRequestedAt?: string;
    } = {},
  ): string => {
    const id = options.id ?? `job-${item.id}`;
    const createdAt = options.createdAt ?? timestamp;
    const status = options.status ?? "queued";
    const active = ["leased", "running", "cancel_requested"].includes(status);
    const attemptCount = options.attemptCount ?? (active || status === "retry_waiting" ? 1 : 0);
    const resourceBase = {
      githubNodeId: item.snapshot.githubNodeId,
      number: item.snapshot.number,
      title: item.snapshot.title,
      author: item.snapshot.author,
      canonicalSnapshot: item.snapshot,
    };
    const execution: JobExecutionTemplate = {
      repository: {
        githubRepositoryId: item.repository.snapshot.githubRepositoryId,
        fullName: item.repository.snapshot.fullName,
      },
      resource:
        item.revision.kind === "issue"
          ? { ...resourceBase, kind: "issue", revisionDigest: item.revision.contentDigest }
          : {
              ...resourceBase,
              kind: "pull_request",
              baseSha: item.revision.baseSha,
              headSha: item.revision.headSha,
              isDraft: false,
            },
      prompt: {
        name: "projection-fixture",
        version: "1",
        renderedPrompt: "Read-only projection fixture.",
        promptSha256: hash("Read-only projection fixture."),
        outputSchema: {},
        outputSchemaSha256: hash("{}"),
      },
      executionPolicy: {
        hardTimeoutMs: 600_000,
        noProgressTimeoutMs: 120_000,
        allowedRecipeIds: [],
        requiredCapabilityLabels: {},
      },
    };
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(`
        INSERT INTO jobs (
          id, work_item_id, job_kind, semantic_key, concurrency_key, status,
          execution_json, resource_revision, current_step, next_attempt_at, created_at, updated_at,
          attempt_count
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        item.id,
        item.snapshot.kind === "issue" ? "issue_triage" : "pull_request_review",
        `semantic-${id}`,
        `concurrency-${id}`,
        JSON.stringify(execution),
        item.revision.revisionKey,
        options.phase ?? null,
        createdAt,
        createdAt,
        createdAt,
        active ? attemptCount - 1 : attemptCount,
      );
    const requestedAt = options.admissionRequestedAt ?? createdAt;
    createJobAdmissionInTransaction(database, id, requestedAt);
    if (options.admission !== "pending" || active)
      database
        .prepare("UPDATE job_admission SET state = 'admitted', admitted_at = ? WHERE job_id = ?")
        .run(requestedAt, id);
    if (active) {
      const attemptId = `attempt-${id}-${attemptCount}`;
      database
        .prepare(`UPDATE jobs SET status = 'leased', attempt_count = ?,
        current_run_attempt_id = ?, lease_generation = ? WHERE id = ?`)
        .run(attemptCount, attemptId, attemptCount, id);
      addAttempt(id, attemptCount, null, "leased", options.phase ?? "leased");
      database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, id);
    } else {
      database
        .prepare("UPDATE jobs SET status = ?, attempt_count = ? WHERE id = ?")
        .run(status, attemptCount, id);
    }
    database.exec("COMMIT");
    return id;
  };

  const deny = (item: WorkItemFixture): void => {
    addDecision(item, addEvent(item, "request_opened", "denied", laterTimestamp), null);
  };

  const addAttempt = (
    jobId: string,
    attemptNumber: number,
    diagnostics: RunFailureDiagnostics | null = null,
    status: "failed" | "leased" = "failed",
    phase: ExecutionPhase = "validation",
  ): string => {
    const capabilities: WorkerCapabilities = {
      operatingSystem: "windows",
      architecture: "x64",
      headless: true,
      interactiveDesktop: false,
      codexVersion: "1.0.0",
      recipeIds: ["issue-triage"],
      labels: {},
    };
    const capabilitiesJson = JSON.stringify(capabilities);
    database
      .prepare(`
        INSERT OR IGNORE INTO workers (
          id, node_id, instance_id, display_name, version, protocol_version, max_slots,
          capabilities_json, capabilities_digest, status, registered_at, last_seen_at, updated_at
        ) VALUES ('worker', 'worker-search-node', 'worker-instance', 'Test worker', '1.0.0',
          '1.0', 1, ?, ?, 'online', ?, ?, ?)
      `)
      .run(capabilitiesJson, hash(capabilitiesJson), timestamp, timestamp, timestamp);
    const id = `attempt-${jobId}-${attemptNumber}`;
    database
      .prepare(`
        INSERT INTO run_attempts (
          id, job_id, attempt_number, worker_id, worker_node_id, worker_instance_id,
          status, lease_token_hash, lease_generation, lease_expires_at, execution_deadline_at,
          no_progress_timeout_ms, no_progress_deadline_at, last_heartbeat_at, phase,
          started_at, failure_diagnostics_json
        ) VALUES (?, ?, ?, 'worker', 'worker-search-node', 'worker-instance', ?, ?, ?, ?, ?,
          60000, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        jobId,
        attemptNumber,
        status,
        hash(id),
        attemptNumber,
        laterTimestamp,
        laterTimestamp,
        laterTimestamp,
        timestamp,
        phase,
        timestamp,
        diagnostics === null ? null : JSON.stringify(diagnostics),
      );
    return id;
  };

  return {
    database,
    schemaVersion,
    addRepository,
    addWorkItem,
    addEvent,
    addDecision,
    addEpoch,
    addJob,
    deny,
    addAttempt,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

// Simulate an obsolete writer that bypassed the atomic Job/admission insertion helper.
// Production claim guards still apply; this fixture never creates an attempt.
function insertMissingAdmissionJob(database: DatabaseSync, jobId: string, itemId: string): void {
  database
    .prepare(`INSERT INTO jobs (id, work_item_id, job_kind, semantic_key, concurrency_key,
    status, execution_json, resource_revision, next_attempt_at, created_at, updated_at)
    SELECT ?, id, 'issue_triage', ?, ?, 'queued', '{}', current_revision_key, ?, ?, ?
    FROM work_items WHERE id = ?`)
    .run(jobId, jobId, jobId, timestamp, laterTimestamp, laterTimestamp, itemId);
}

describe("dashboard repository access scopes", () => {
  const administrator = { issuer: "https://identity.example.test", subject: "platform-admin" };
  const principal = { issuer: "https://identity.example.test", subject: "repository-reader" };
  const reader: OperatorReadContext = { actor: principal, administrators: [administrator] };
  const platform: OperatorReadContext = { actor: administrator, administrators: [administrator] };
  let changeSequence = 0;
  function enrollRepositories(database: DatabaseSync) {
    database
      .prepare(`INSERT INTO managed_repositories
      (id, github_repository_id, full_name, enabled, version, connection_status, metadata_json, configuration_source, created_at, updated_at)
      SELECT id, github_repository_id, full_name, 0, 1, 'unknown', snapshot_json, 'discovered', created_at, updated_at FROM repositories`)
      .run();
  }
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
            changeId: `dashboard-access-${++changeSequence}`,
            principal,
            role,
            expectedVersion,
            reason: "Dashboard access fixture.",
          },
        },
      },
      timestamp,
      [administrator],
    );
  }
  function scopedFixture() {
    const f = createFixture();
    const other = f.addRepository("repository-other", {
      ...repository,
      githubRepositoryId: 2,
      githubNodeId: "other-node",
      ownerLogin: "another-owner",
      fullName: "another-owner/PowerToys",
      htmlUrl: "https://github.com/another-owner/PowerToys",
    });
    for (let index = 0; index < 3; index++) {
      for (const visible of [false, true]) {
        const item = f.addWorkItem(`${visible ? "visible" : "hidden"}-${index}`, {
          kind: "pull_request",
          number: 42 + index,
          title: "Shared validation target",
          ...(visible ? {} : { repository: other }),
        });
        f.addJob(item);
      }
    }
    enrollRepositories(f.database);
    return f;
  }
  it.each(["viewer", "reviewer", "maintainer", "admin"] as const)(
    "scopes %s reads before unscoped totals, search and pagination",
    (role) => {
      const f = scopedFixture();
      change(f.database, "repository", role);
      for (let page = 1; page <= 4; page++) {
        const input = { page, pageSize: 1, search: "shared validation" };
        const items = listWorkItems(f.database, input, reader);
        const jobs = listJobs(f.database, input, reader);
        expect(items.total).toBe(3);
        expect(jobs.total).toBe(3);
        expect(ids(items)).toEqual(page <= 3 ? [`visible-${page - 1}`] : []);
        expect(ids(jobs)).toEqual(page <= 3 ? [`job-visible-${page - 1}`] : []);
      }
      expect(
        listWorkItems(f.database, { search: "42" }, reader).items.map((item) => [
          item.repositoryId,
          item.number,
        ]),
      ).toEqual([["repository", 42]]);
      expect(listJobs(f.database, { search: "42" }, reader).total).toBe(1);
      expect(listWorkItems(f.database, { repositoryId: "repository-other" }, reader)).toEqual({
        items: [],
        total: 0,
      });
      expect(listJobs(f.database, { repositoryId: "repository-other" }, reader)).toEqual({
        items: [],
        total: 0,
      });
    },
  );
  it("does not reveal totals for an ungranted principal or another identity issuer", () => {
    const f = scopedFixture();
    expect(listWorkItems(f.database, {}, reader)).toEqual({ items: [], total: 0 });
    expect(listJobs(f.database, {}, reader)).toEqual({ items: [], total: 0 });
    change(f.database, "repository", "viewer");
    const anotherIssuer = {
      ...reader,
      actor: { ...principal, issuer: "https://other-identity.example.test" },
    };
    expect(listWorkItems(f.database, {}, anotherIssuer).total).toBe(0);
    expect(listJobs(f.database, {}, anotherIssuer).total).toBe(0);
    const injection = { ...reader, actor: { ...principal, subject: "reader' OR 1 = 1 --" } };
    expect(listWorkItems(f.database, {}, injection).total).toBe(0);
    expect(listJobs(f.database, {}, injection).total).toBe(0);
  });
  it("checks admission integrity within the current reader scope before admission filtering", () => {
    const f = scopedFixture();
    change(f.database, "repository", "viewer");
    insertMissingAdmissionJob(f.database, "foreign-corrupt", "hidden-0");
    expect(listJobs(f.database, { admission: "admitted" }, reader).total).toBe(3);
    expect(listWorkItems(f.database, { stage: "queued" }, reader).total).toBe(3);
    expect(getJob(f.database, { jobId: "foreign-corrupt" }, reader)).toBeNull();
    expect(() => listJobs(f.database, { admission: "admitted" }, platform)).toThrow(
      expect.objectContaining({ code: "PLATFORM_CORRUPT" }),
    );
    insertMissingAdmissionJob(f.database, "visible-corrupt", "visible-0");
    expect(() =>
      listJobs(f.database, { admission: "admitted", page: 9, pageSize: 1 }, reader),
    ).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
    expect(() => listWorkItems(f.database, { stage: "queued" }, reader)).toThrow(
      expect.objectContaining({ code: "PLATFORM_CORRUPT" }),
    );
  });
  it("reflects a grant revocation on the next query without a cached repository list", () => {
    const f = scopedFixture();
    change(f.database, "repository", "viewer");
    expect(listWorkItems(f.database, {}, reader).total).toBe(3);
    expect(listJobs(f.database, {}, reader).total).toBe(3);
    expect(getJob(f.database, { jobId: "job-visible-0" }, reader)?.repositoryId).toBe("repository");
    change(f.database, "repository", null, 1);
    expect(listWorkItems(f.database, {}, reader)).toEqual({ items: [], total: 0 });
    expect(listJobs(f.database, {}, reader)).toEqual({ items: [], total: 0 });
    expect(getJob(f.database, { jobId: "job-visible-0" }, reader)).toBeNull();
    change(f.database, "repository-other", "viewer");
    expect(ids(listJobs(f.database, {}, reader))).toEqual([
      "job-hidden-0",
      "job-hidden-1",
      "job-hidden-2",
    ]);
  });
  it("uses stored job ownership and rejects caller-supplied repository claims", () => {
    const f = scopedFixture();
    change(f.database, "repository", "viewer");
    const forgedExecution = JSON.stringify({
      repository: { fullName: "microsoft/PowerToys", repositoryId: "repository" },
    });
    const original = f.database
      .prepare("SELECT execution_json FROM jobs WHERE id = 'job-hidden-0'")
      .get()?.execution_json;
    expect(() =>
      f.database
        .prepare("UPDATE jobs SET execution_json = ? WHERE id = 'job-hidden-0'")
        .run(forgedExecution),
    ).toThrow("admitted job ownership inputs are immutable");
    expect(
      f.database.prepare("SELECT execution_json FROM jobs WHERE id = 'job-hidden-0'").get()
        ?.execution_json,
    ).toBe(original);
    // An invalid stored Legacy template cannot claim its work item's read authority. Seed it
    // at insertion because an accepted Job's ownership inputs cannot subsequently be replaced.
    const jobId = "job-hidden-forged-repository";
    f.database.exec("BEGIN IMMEDIATE");
    f.database
      .prepare(`INSERT INTO jobs (id, work_item_id, job_kind, semantic_key, concurrency_key,
        status, execution_json, resource_revision, next_attempt_at, created_at, updated_at)
        SELECT ?, work_item_id, job_kind, ?, ?, 'queued', ?, resource_revision,
        next_attempt_at, created_at, updated_at FROM jobs WHERE id = 'job-hidden-0'`)
      .run(jobId, jobId, jobId, forgedExecution);
    createJobAdmissionInTransaction(f.database, jobId, timestamp);
    f.database.exec("COMMIT");
    expect(getJob(f.database, { jobId }, reader)).toBeNull();
    expect(() =>
      getJob(
        f.database,
        { jobId, repositoryId: "repository" } as unknown as DashboardJobReadQuery,
        reader,
      ),
    ).toThrow("lookup input");
    expect(getJob(f.database, { jobId }, platform)?.repositoryId).toBe("repository-other");
  });
  it("preserves platform administrator and trusted internal reads", () => {
    const f = scopedFixture();
    expect(listWorkItems(f.database, {}, platform).total).toBe(6);
    expect(listJobs(f.database, {}, platform).total).toBe(6);
    expect(listWorkItems(f.database, {}).total).toBe(6);
    expect(listJobs(f.database, {}).total).toBe(6);
    expect(getJob(f.database, { jobId: "job-hidden-0" })?.repositoryId).toBe("repository-other");
  });
  it("denies unowned legacy jobs to repository operators without inventing repository metadata", () => {
    const f = scopedFixture();
    change(f.database, "repository", "admin");
    f.database.exec("BEGIN IMMEDIATE");
    f.database
      .prepare(`INSERT INTO jobs (id, work_item_id, job_kind, semantic_key, concurrency_key, status, execution_json, resource_revision, next_attempt_at, created_at, updated_at)
      VALUES ('platform-legacy', NULL, 'issue_triage', 'platform-legacy', 'platform-legacy', 'queued', ?, 'legacy', ?, ?, ?)`)
      .run(
        JSON.stringify({ repository: { fullName: "microsoft/PowerToys" } }),
        timestamp,
        timestamp,
        timestamp,
      );
    createJobAdmissionInTransaction(f.database, "platform-legacy", timestamp);
    f.database.exec("COMMIT");
    expect(getJob(f.database, { jobId: "platform-legacy" }, reader)).toBeNull();
    // The current dashboard contract requires a work item; administrators retain the same
    // legacy null projection until that separate product contract is expanded.
    expect(getJob(f.database, { jobId: "platform-legacy" }, platform)).toBeNull();
    expect(getJob(f.database, { jobId: "platform-legacy" })).toBeNull();
    expect(listJobs(f.database, {}, reader).total).toBe(3);
    expect(listJobs(f.database, {}, platform).total).toBe(6);
  });
});

describe("dashboard database queries", () => {
  it("separates pending admission from queued Jobs and unscheduled work items", () => {
    const f = createFixture();
    f.addWorkItem("no-job");
    f.addJob(f.addWorkItem("pending"), { admission: "pending" });
    f.addJob(f.addWorkItem("retry"), {
      status: "retry_waiting",
      admission: "pending",
      attemptCount: 3,
    });
    f.addJob(f.addWorkItem("admitted"));
    f.addJob(f.addWorkItem("running"), { status: "running" });
    f.addJob(f.addWorkItem("finished"), { status: "succeeded" });
    const snapshot = () =>
      JSON.stringify({
        jobs: f.database.prepare("SELECT * FROM jobs ORDER BY id").all(),
        admissions: f.database.prepare("SELECT * FROM job_admission ORDER BY job_id").all(),
        attempts: f.database.prepare("SELECT * FROM run_attempts ORDER BY id").all(),
      });
    const before = snapshot();
    expect(ids(listJobs(f.database, { admission: "pending" }))).toEqual([
      "job-pending",
      "job-retry",
    ]);
    expect(ids(listJobs(f.database, { stage: "awaiting_admission" }))).toEqual([
      "job-pending",
      "job-retry",
    ]);
    expect(ids(listJobs(f.database, { admission: "admitted" }))).toEqual(["job-admitted"]);
    expect(ids(listJobs(f.database, { stage: "queued" }))).toEqual(["job-admitted"]);
    expect(listJobs(f.database, { admission: ["pending", "admitted"] }).total).toBe(3);
    expect(listJobs(f.database, { status: "queued" }).total).toBe(2);
    expect(listJobs(f.database, { admission: "pending", status: "running" }).total).toBe(0);
    expect(listJobs(f.database, { admission: [] }).total).toBe(5);
    const items = listWorkItems(f.database, { pageSize: 200 }).items;
    expect(items.find((item) => item.id === "no-job")).toMatchObject({
      stage: "not_scheduled",
      latestJobId: null,
      latestJobStatus: null,
      latestJobAdmission: null,
      latestJobAttemptCount: null,
    });
    expect(items.find((item) => item.id === "retry")).toMatchObject({
      stage: "awaiting_admission",
      latestJobStatus: "retry_waiting",
      latestJobAttemptCount: 3,
      latestJobAdmission: {
        state: "pending",
        attemptBase: 3,
        requestedAt: timestamp,
        timestampBasis: "recorded",
        admittedAt: null,
      },
    });
    expect(ids(listWorkItems(f.database, { stage: "not_scheduled" }))).toEqual(["no-job"]);
    expect(ids(listWorkItems(f.database, { stage: "awaiting_admission" }))).toEqual([
      "pending",
      "retry",
    ]);
    expect(getJob(f.database, { jobId: "job-retry" })?.admission).toEqual(
      items.find((item) => item.id === "retry")?.latestJobAdmission,
    );
    expect(getJob(f.database, { jobId: "job-running" })?.admission).toBeNull();
    expect(getJob(f.database, { jobId: "job-finished" })?.admission).toBeNull();
    expect(snapshot()).toBe(before);
  });
  it("reports admitted and pending Job ages from creation, without using episode timestamps", () => {
    const f = createFixture();
    const earlier = "2026-09-01T08:00:00.000Z";
    const pendingAt = "2026-09-01T09:00:00.000Z";
    f.addJob(f.addWorkItem("older-terminal"), { status: "cancelled", createdAt: earlier });
    f.addJob(f.addWorkItem("pending"), {
      admission: "pending",
      createdAt: pendingAt,
      admissionRequestedAt: timestamp,
    });
    f.addJob(f.addWorkItem("queued"), {
      createdAt: timestamp,
      admissionRequestedAt: laterTimestamp,
    });
    f.addJob(f.addWorkItem("retry"), { status: "retry_waiting", createdAt: laterTimestamp });
    const system = getSystemSnapshot(f.database, f.schemaVersion);
    expect(system).toMatchObject({
      queuedJobs: 2,
      awaitingAdmissionJobs: 1,
      pendingValidationRequests: 0,
      oldestQueuedAt: timestamp,
      oldestAwaitingAdmissionAt: pendingAt,
    });
    insertMissingAdmissionJob(f.database, "missing-episode", "queued");
    expect(() => getSystemSnapshot(f.database, f.schemaVersion)).toThrow(
      expect.objectContaining({ code: "PLATFORM_CORRUPT" }),
    );
  });
  it("scopes work items and jobs by exact repository identity before counting and pagination", () => {
    const fixture = createFixture();
    const otherRepository = fixture.addRepository("repository-other", {
      ...repository,
      githubRepositoryId: 2,
      githubNodeId: "other-repository-node",
      ownerLogin: "another-owner",
      fullName: "another-owner/PowerToys",
      htmlUrl: "https://github.com/another-owner/PowerToys",
    });
    for (const [id, number, kind, selectedRepository] of [
      ["item-a", 42, "issue", undefined],
      ["item-b", 42, "issue", otherRepository],
      ["item-c", 43, "pull_request", undefined],
      ["item-d", 43, "pull_request", otherRepository],
      ["item-e", 44, "issue", undefined],
    ] as const) {
      const item = fixture.addWorkItem(id, {
        number,
        kind,
        title: "Shared review target",
        ...(selectedRepository === undefined ? {} : { repository: selectedRepository }),
      });
      fixture.addEpoch(item);
      fixture.addJob(item);
    }

    for (const [repositoryId, expected] of [
      ["repository", ["item-a", "item-c", "item-e"]],
      ["repository-other", ["item-b", "item-d"]],
    ] as const) {
      for (let page = 1; page <= expected.length + 1; page += 1) {
        const query = { repositoryId, page, pageSize: 1, search: "shared review" };
        const workItems = listWorkItems(fixture.database, query);
        const jobs = listJobs(fixture.database, query);
        const expectedPage = expected.slice(page - 1, page);
        expect(workItems.total).toBe(expected.length);
        expect(jobs.total).toBe(expected.length);
        expect(ids(workItems)).toEqual(expectedPage);
        expect(ids(jobs)).toEqual(expectedPage.map((id) => `job-${id}`));
        for (const row of [...workItems.items, ...jobs.items]) {
          expect(row.repositoryId).toBe(repositoryId);
        }
      }
    }

    const duplicateNumberItems = listWorkItems(fixture.database, { search: "42" });
    expect(duplicateNumberItems.total).toBe(2);
    expect(duplicateNumberItems.items.map((item) => [item.repositoryId, item.number])).toEqual([
      ["repository", 42],
      ["repository-other", 42],
    ]);
    expect(listWorkItems(fixture.database, {}).total).toBe(5);
    expect(listJobs(fixture.database, {}).total).toBe(5);
    expect(
      ids(
        listWorkItems(fixture.database, {
          repositoryId: "repository-other",
          kind: "pull_request",
          state: "assigned",
          stage: "queued",
          authorization: "self",
        }),
      ),
    ).toEqual(["item-d"]);
    expect(
      ids(
        listJobs(fixture.database, {
          repositoryId: "repository-other",
          status: "queued",
          stage: "queued",
          workItemId: "item-d",
        }),
      ),
    ).toEqual(["job-item-d"]);
    expect(
      listJobs(fixture.database, {
        repositoryId: "repository",
        workItemId: "item-d",
      }),
    ).toEqual({ items: [], total: 0 });
    expect(getJob(fixture.database, { jobId: "job-item-d" })?.repositoryId).toBe(
      "repository-other",
    );

    for (const repositoryId of ["repo", "REPOSITORY", "missing-repository"]) {
      expect(listWorkItems(fixture.database, { repositoryId })).toEqual({ items: [], total: 0 });
      expect(listJobs(fixture.database, { repositoryId })).toEqual({ items: [], total: 0 });
    }
  });

  it("preserves raw phases while queued and terminal statuses override stages", () => {
    const fixture = createFixture();
    const cases: {
      readonly id: string;
      readonly status: JobState;
      readonly phase: ExecutionPhase | null;
      readonly jobStage: DashboardJobStage;
      readonly workItemStage: DashboardWorkItemStage;
    }[] = [
      {
        id: "queued",
        status: "queued",
        phase: "validation",
        jobStage: "queued",
        workItemStage: "queued",
      },
      {
        id: "retry",
        status: "retry_waiting",
        phase: "completing",
        jobStage: "queued",
        workItemStage: "queued",
      },
      ...(["stale", "succeeded", "failed", "dead_letter", "cancelled"] as const).map((status) => ({
        id: status,
        status,
        phase: "codex_review" as const,
        jobStage: "done" as const,
        workItemStage: "done" as const,
      })),
      {
        id: "null-leased",
        status: "leased",
        phase: null,
        jobStage: "leased",
        workItemStage: "preparing",
      },
      {
        id: "null-running",
        status: "running",
        phase: null,
        jobStage: "leased",
        workItemStage: "preparing",
      },
      {
        id: "null-cancel",
        status: "cancel_requested",
        phase: null,
        jobStage: "leased",
        workItemStage: "preparing",
      },
      {
        id: "leased",
        status: "running",
        phase: "leased",
        jobStage: "leased",
        workItemStage: "preparing",
      },
      {
        id: "preparing",
        status: "running",
        phase: "preparing",
        jobStage: "preparing",
        workItemStage: "preparing",
      },
      {
        id: "review",
        status: "running",
        phase: "codex_review",
        jobStage: "codex_review",
        workItemStage: "reviewing",
      },
      {
        id: "revision",
        status: "running",
        phase: "codex_revision",
        jobStage: "codex_revision",
        workItemStage: "reviewing",
      },
      {
        id: "validation",
        status: "running",
        phase: "validation",
        jobStage: "validation",
        workItemStage: "validating",
      },
      {
        id: "uploading",
        status: "running",
        phase: "uploading",
        jobStage: "uploading",
        workItemStage: "waiting_approval",
      },
      {
        id: "completing",
        status: "running",
        phase: "completing",
        jobStage: "completing",
        workItemStage: "waiting_approval",
      },
      {
        id: "cancelling",
        status: "cancel_requested",
        phase: "cancelling",
        jobStage: "cancelling",
        workItemStage: "reviewing",
      },
    ];
    for (const row of cases) fixture.addJob(fixture.addWorkItem(row.id), row);
    fixture.addWorkItem("no-job");

    for (const stage of new Set(cases.map((row) => row.jobStage))) {
      const expected = cases
        .filter((row) => row.jobStage === stage)
        .map((row) => row.id)
        .sort();
      const result = listJobs(fixture.database, { stage });
      expect(ids(result), stage).toEqual(expected);
      expect(result.total, stage).toBe(expected.length);
    }
    const workItems = listWorkItems(fixture.database, { pageSize: 200 });
    for (const row of cases) {
      expect(workItems.items.find((item) => item.id === row.id)?.stage, row.id).toBe(
        row.workItemStage,
      );
    }
    expect(workItems.items.find((item) => item.id === "no-job")?.stage).toBe("not_scheduled");
    expect(ids(listJobs(fixture.database, { phase: "leased" }))).toEqual(["leased"]);
    expect(ids(listJobs(fixture.database, { phase: "validation" }))).toEqual([
      "queued",
      "validation",
    ]);
    expect(listJobs(fixture.database, { status: "leased", phase: "leased" })).toEqual({
      items: [],
      total: 0,
    });
    expect(
      ids(listJobs(fixture.database, { status: ["queued", "retry_waiting"], stage: "queued" })),
    ).toEqual(["queued", "retry"]);
    expect(
      ids(
        listJobs(fixture.database, {
          status: ["queued", "running"],
          phase: ["validation", "preparing"],
          stage: ["queued", "preparing"],
          workItemId: "queued",
        }),
      ),
    ).toEqual(["queued"]);
  });

  it("orders source closure, active jobs, active epochs, and request closure by precedence", () => {
    const fixture = createFixture();
    const closed = fixture.addWorkItem("closed", { state: "closed" });
    fixture.addEpoch(closed);
    fixture.addJob(closed, { status: "running", phase: "validation" });
    fixture.addEvent(closed, "request_closed", "closed", laterTimestamp);
    for (const status of ["leased", "running", "cancel_requested"] as const) {
      const item = fixture.addWorkItem(`active-${status}`);
      fixture.addEpoch(item);
      fixture.addJob(item, { status });
      fixture.addEvent(item, "request_closed", "closed", laterTimestamp);
    }
    const assigned = fixture.addWorkItem("assigned");
    fixture.addEpoch(assigned);
    fixture.addJob(assigned, { status: "failed" });
    fixture.addEvent(assigned, "request_closed", "closed", laterTimestamp);
    const unassigned = fixture.addWorkItem("unassigned");
    fixture.addJob(unassigned, { status: "succeeded" });
    fixture.addEvent(unassigned, "request_closed");
    fixture.addWorkItem("open");

    expect(listWorkItems(fixture.database, {}).items.map((item) => [item.id, item.state])).toEqual([
      ["active-cancel_requested", "active"],
      ["active-leased", "active"],
      ["active-running", "active"],
      ["assigned", "assigned"],
      ["closed", "closed"],
      ["open", "open"],
      ["unassigned", "unassigned"],
    ]);
    expect(ids(listWorkItems(fixture.database, { state: ["closed", "assigned"] }))).toEqual([
      "assigned",
      "closed",
    ]);
    expect(ids(listWorkItems(fixture.database, { state: "active" }))).toHaveLength(3);
  });

  it("prefers active epoch authorization over denial and excludes null authorization", () => {
    const fixture = createFixture();
    for (const basis of ["self", "allowlist"] as const) {
      const item = fixture.addWorkItem(basis);
      fixture.addEpoch(item, basis);
      fixture.deny(item);
    }
    const denied = fixture.addWorkItem("denied");
    fixture.deny(denied);
    const authorizedWithoutEpoch = fixture.addWorkItem("authorized-without-epoch");
    fixture.addDecision(
      authorizedWithoutEpoch,
      fixture.addEvent(authorizedWithoutEpoch, "request_opened"),
      "self",
    );
    fixture.addWorkItem("unknown");

    expect(
      listWorkItems(fixture.database, {}).items.map((item) => [item.id, item.authorization]),
    ).toEqual([
      ["allowlist", "allowlisted"],
      ["authorized-without-epoch", null],
      ["denied", "denied"],
      ["self", "self"],
      ["unknown", null],
    ]);
    expect(ids(listWorkItems(fixture.database, { authorization: ["self", "denied"] }))).toEqual([
      "denied",
      "self",
    ]);
    expect(
      listWorkItems(fixture.database, { authorization: "allowlisted" }).items[0],
    ).toMatchObject({
      authorizationReason: "authorized_allowlisted",
      activeRequestEpoch: { authorization: "allowlisted" },
    });
    expect(listWorkItems(fixture.database, { authorization: "self" }).items[0]).toMatchObject({
      authorizationReason: "authorized_self",
      activeRequestEpoch: { authorization: "self" },
    });
  });

  it("combines multiple values with OR and distinct work-item filters with AND", () => {
    const fixture = createFixture();
    const assigned = fixture.addWorkItem("match-assigned");
    fixture.addEpoch(assigned);
    const active = fixture.addWorkItem("match-active");
    fixture.addJob(active, { status: "running", phase: "codex_review" });
    fixture.deny(active);
    const otherKind = fixture.addWorkItem("other-kind", { kind: "pull_request" });
    fixture.addEpoch(otherKind);
    const otherAuthorization = fixture.addWorkItem("other-authorization");
    fixture.addEpoch(otherAuthorization, "allowlist");
    const otherStage = fixture.addWorkItem("other-stage");
    fixture.addEpoch(otherStage);
    fixture.addJob(otherStage, { status: "running", phase: "validation" });
    const otherState = fixture.addWorkItem("other-state", { state: "closed" });
    fixture.addEpoch(otherState);
    const unknown = fixture.addWorkItem("unknown-authorization");
    fixture.addJob(unknown, { status: "running", phase: "codex_review" });

    const query = {
      kind: "issue" as const,
      state: ["assigned", "active"] as ("assigned" | "active")[],
      stage: ["not_scheduled", "reviewing"] as ("not_scheduled" | "reviewing")[],
      authorization: ["self", "denied"] as ("self" | "denied")[],
    };
    const result = listWorkItems(fixture.database, query);
    expect(ids(result)).toEqual(["match-active", "match-assigned"]);
    expect(result.total).toBe(2);
    expect(
      ids(listWorkItems(fixture.database, { ...query, kind: ["issue", "pull_request"] })),
    ).toEqual(["match-active", "match-assigned", "other-kind"]);
    expect(
      listWorkItems(fixture.database, { kind: [], state: [], stage: [], authorization: [] }).total,
    ).toBe(7);
  });

  it("filters before pagination and keeps exact totals for partial, empty, and enormous pages", () => {
    const fixture = createFixture();
    seedHistory(fixture);
    const expectations = [
      { page: 1, suffixes: ["100", "101"] },
      { page: 2, suffixes: ["102", "103"] },
      { page: 4, suffixes: ["106"] },
      { page: 5, suffixes: [] },
    ];
    for (const { page, suffixes } of expectations) {
      const jobs = listJobs(fixture.database, { status: "queued", page, pageSize: 2 });
      const items = listWorkItems(fixture.database, { stage: "queued", page, pageSize: 2 });
      expect(ids(jobs)).toEqual(suffixes.map((suffix) => `job-item-${suffix}`));
      expect(ids(items)).toEqual(suffixes.map((suffix) => `item-${suffix}`));
      expect(jobs.total).toBe(7);
      expect(items.total).toBe(7);
    }
    expect(listJobs(fixture.database, { status: "failed" })).toEqual({ items: [], total: 0 });
    expect(listWorkItems(fixture.database, { kind: "pull_request" })).toEqual({
      items: [],
      total: 0,
    });
    expect(listJobs(fixture.database, { page: Number.MAX_SAFE_INTEGER, pageSize: 200 })).toEqual({
      items: [],
      total: 107,
    });
    expect(
      listWorkItems(fixture.database, { page: Number.MAX_SAFE_INTEGER, pageSize: 200 }),
    ).toEqual({
      items: [],
      total: 107,
    });
    expect(
      listJobs(fixture.database, { status: [], phase: [], stage: [], pageSize: 200 }).total,
    ).toBe(107);
  });

  it("materializes only the requested page when more than one hundred historical rows match", () => {
    const fixture = createFixture();
    seedHistory(fixture);
    const materializedCounts: number[] = [];
    const prepare = fixture.database.prepare.bind(fixture.database);
    vi.spyOn(fixture.database, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...parameters) => {
        const rows = all(...parameters);
        materializedCounts.push(rows.length);
        return rows;
      });
      return statement;
    });

    expect(listJobs(fixture.database, { page: 2, pageSize: 2 }).total).toBe(107);
    expect(listWorkItems(fixture.database, { page: 2, pageSize: 2 }).total).toBe(107);
    expect(materializedCounts).toEqual([2, 2]);
    expect(listJobs(fixture.database, { status: "failed", pageSize: 2 }).items).toEqual([]);
    expect(listWorkItems(fixture.database, { kind: "pull_request", pageSize: 2 }).items).toEqual(
      [],
    );
    expect(
      listJobs(fixture.database, { page: Number.MAX_SAFE_INTEGER, pageSize: 200 }).items,
    ).toEqual([]);
    expect(
      listWorkItems(fixture.database, { page: Number.MAX_SAFE_INTEGER, pageSize: 200 }).items,
    ).toEqual([]);
    expect(materializedCounts).toEqual([2, 2]);
  });

  it("breaks list timestamp ties by ascending IDs and chooses the latest job by descending IDs", () => {
    const fixture = createFixture();
    fixture.addWorkItem("item-z");
    fixture.addWorkItem("item-m");
    const item = fixture.addWorkItem("item-a");
    fixture.addJob(item, { id: "job-z", status: "succeeded" });
    fixture.addJob(item, { id: "job-a", status: "running", phase: "validation" });

    expect(ids(listWorkItems(fixture.database, { pageSize: 2 }))).toEqual(["item-a", "item-m"]);
    expect(ids(listWorkItems(fixture.database, { page: 2, pageSize: 2 }))).toEqual(["item-z"]);
    expect(ids(listJobs(fixture.database, { pageSize: 1 }))).toEqual(["job-a"]);
    expect(ids(listJobs(fixture.database, { page: 2, pageSize: 1 }))).toEqual(["job-z"]);
    expect(listWorkItems(fixture.database, { stage: "done" }).items[0]).toMatchObject({
      id: "item-a",
      latestJobId: "job-z",
      latestJobStatus: "succeeded",
      state: "open",
      stage: "done",
    });
  });

  it("trims search text, ignores ASCII case, and escapes percent, underscore, and backslash", () => {
    const fixture = createFixture();
    for (const [id, title] of [
      ["case", "MiXeD Needle"],
      ["percent", "Coverage at 20%"],
      ["percent-decoy", "Coverage at 200"],
      ["underscore", "under_score"],
      ["underscore-decoy", "underXscore"],
      ["backslash", "Path C:\\workspace"],
      ["backslash-decoy", "Path C:workspace"],
    ] as const) {
      fixture.addJob(fixture.addWorkItem(id, { title }));
    }
    for (const [search, expected] of [
      ["  nEeDlE\t", "case"],
      ["%", "percent"],
      ["_", "underscore"],
      ["\\", "backslash"],
    ] as const) {
      expect(ids(listWorkItems(fixture.database, { search })), search).toEqual([expected]);
      expect(ids(listJobs(fixture.database, { search })), search).toEqual([`job-${expected}`]);
    }
    expect(listWorkItems(fixture.database, { search: " \t\n " }).total).toBe(7);
    expect(listJobs(fixture.database, { search: " \t\n " }).total).toBe(7);
    expect(listWorkItems(fixture.database, { search: "POWERTOYS" }).total).toBe(7);
    expect(listJobs(fixture.database, { search: "MICROSOFT" }).total).toBe(7);

    const authored = fixture.addWorkItem("authored", {
      authorLogin: "DistinctAuthor",
      number: 901234,
    });
    const jobId = fixture.addJob(authored);
    const attemptId = fixture.addAttempt(jobId, 1);
    fixture.database
      .prepare("UPDATE jobs SET current_run_attempt_id = ? WHERE id = ?")
      .run(attemptId, jobId);
    expect(ids(listWorkItems(fixture.database, { search: "distinctAUTHOR" }))).toEqual([
      "authored",
    ]);
    expect(ids(listWorkItems(fixture.database, { search: "901234" }))).toEqual(["authored"]);
    expect(ids(listJobs(fixture.database, { search: "901234" }))).toEqual([jobId]);
    expect(ids(listJobs(fixture.database, { search: "WORKER-search-node" }))).toEqual([jobId]);
    expect(ids(listJobs(fixture.database, { search: "JOB-authored" }))).toEqual([jobId]);
  });

  it("reads diagnostics from the highest attempt number without reusing older diagnostics", () => {
    const fixture = createFixture();
    const jobId = fixture.addJob(fixture.addWorkItem("diagnostics"), { status: "failed" });
    const diagnostics: RunFailureDiagnostics = {
      category: "process",
      exitCode: 7,
      summary: "Review process failed.",
      correlationId: "attempt-correlation",
    };
    fixture.addAttempt(jobId, 2, diagnostics);
    fixture.addAttempt(jobId, 1, { ...diagnostics, exitCode: 1, summary: "Older failure." });
    expect(getJob(fixture.database, { jobId })).toMatchObject({
      workerNodeId: null,
      failureDiagnostics: diagnostics,
    });

    fixture.addAttempt(jobId, 3);
    expect(getJob(fixture.database, { jobId })?.failureDiagnostics).toBeNull();
    const unattemptedJob = fixture.addJob(fixture.addWorkItem("unattempted"));
    expect(getJob(fixture.database, { jobId: unattemptedJob })?.failureDiagnostics).toBeNull();
  });

  it("uses supplied GitHub runtime health without inferring health from historical events", () => {
    const fixture = createFixture();
    fixture.addEvent(fixture.addWorkItem("historical"), "request_opened");
    const githubHealth: DashboardHealthComponent = {
      id: "github",
      name: "GitHub ingestion",
      status: "degraded",
      summary: "The most recent poll failed.",
      checkedAt: laterTimestamp,
    };
    expect(
      getSystemSnapshot(fixture.database, fixture.schemaVersion, { githubHealth }).health.find(
        (component) => component.id === "github",
      ),
    ).toEqual(githubHealth);
    expect(
      getSystemSnapshot(fixture.database, fixture.schemaVersion).health.find(
        (component) => component.id === "github",
      )?.status,
    ).toBe("unavailable");
  });
});

const seedHistory = (fixture: ReturnType<typeof createFixture>): void => {
  for (let index = 106; index >= 0; index -= 1) {
    const suffix = index.toString().padStart(3, "0");
    const item = fixture.addWorkItem(`item-${suffix}`);
    fixture.addJob(item, {
      status: index >= 100 ? "queued" : "running",
      phase: "validation",
    });
  }
};
