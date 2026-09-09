import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  GitHubActor,
  GitHubRepository,
  ManagedRepository,
  NormalizedSchedulingEvent,
  PromptVersion,
  RepositoryUpdateRequest,
  SchedulingRequestOpenedEvent,
  SelfOrAllowlistPolicy,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IssueTriageV2ModelOutputSchema,
  PrReviewPlanV2ModelOutputSchema,
} from "../../../../packages/codex/src/review-results.js";
import { ingestSchedulingEvent } from "../../dist/database/github-ingestion.js";
import {
  commitGitHubPollingReconciliation,
  readGitHubPollingProjection,
} from "../../dist/database/github-polling-state.js";
import {
  handleRepositoryConfigurationRequest,
  isRepositoryConfigurationOperation,
  type RepositoryConfigurationRequest,
  type RepositoryOperation,
  type RepositoryOperationMap,
} from "../../dist/database/managed-repositories.js";
import { runMigrations } from "../../dist/database/migrations.js";
import {
  handlePromptConfigurationRequest,
  isPromptConfigurationOperation,
  type PromptConfigurationOperation,
  type PromptConfigurationOperationMap,
  type PromptConfigurationRequest,
} from "../../dist/database/prompt-configuration.js";
import type { IngestSchedulingEventInput } from "../../dist/database/protocol.js";
import { GitHubEventIngestionService } from "../../dist/github/ingestion-service.js";
import { type GitHubReadClient, reconcileGitHubPolling } from "../../dist/github/poller.js";
import { createPullRequestRevisionKey } from "../../dist/github/revision-key.js";
import { ManagedGitHubRuntimeConfiguration } from "../../dist/runtime/managed-github-configuration.js";
import {
  defaultTrustedSchedulingPolicy,
  loadTrustedSchedulingConfig,
} from "../../dist/scheduling/index.js";

const timestamp = "2026-09-07T00:00:00.000Z";
const later = "2026-09-07T00:01:00.000Z";
const last = "2026-09-07T00:02:00.000Z";
const operator = { issuer: "https://identity.example.test", subject: "operator" };
const reviewer = { githubUserId: 100, login: "reviewer", accountType: "user" } as const;
const secondReviewer = { githubUserId: 101, login: "other-reviewer", accountType: "user" } as const;
const allowedActor = { githubUserId: 200, login: "maintainer", accountType: "user" } as const;
const author = { githubUserId: 900, login: "contributor", accountType: "user" } as const;
const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [allowedActor.githubUserId],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "require_new_authorization",
};
const firstRepository: GitHubRepository = {
  githubRepositoryId: 1,
  githubNodeId: "repository-1",
  ownerLogin: "first-owner",
  name: "project",
  fullName: "first-owner/project",
  htmlUrl: "https://github.com/first-owner/project",
  defaultBranch: "main",
  isPrivate: false,
};
const secondRepository: GitHubRepository = {
  ...firstRepository,
  githubRepositoryId: 2,
  githubNodeId: "repository-2",
  ownerLogin: "second-owner",
  fullName: "second-owner/project",
  htmlUrl: "https://github.com/second-owner/project",
};
const databases: DatabaseSync[] = [];

function startRunningJob(database: DatabaseSync, jobId: string | null, attemptId: string): void {
  if (jobId === null) throw new Error("The running fixture requires an accepted Job.");
  const workerId = `worker-${attemptId}`;
  const nodeId = `node-${attemptId}`;
  const instanceId = `instance-${attemptId}`;
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const deadline = new Date(Date.parse(timestamp) + 600_000).toISOString();
  const capabilities = JSON.stringify({
    operatingSystem: "windows",
    architecture: "x64",
    headless: true,
    interactiveDesktop: false,
    cliEngine: "codex",
    cliVersion: "test",
    recipeIds: [],
    labels: {},
  });
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(`INSERT INTO worker_node_credentials (worker_node_id, display_name, token_sha256, auth_state,
      created_by_issuer, created_by_subject, updated_by_issuer, updated_by_subject, created_at, updated_at, activated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        nodeId,
        nodeId,
        digest(nodeId),
        operator.issuer,
        operator.subject,
        operator.issuer,
        operator.subject,
        timestamp,
        timestamp,
        timestamp,
      );
    database
      .prepare(`INSERT INTO workers (id, node_id, instance_id, display_name, version, protocol_version,
      max_slots, capabilities_json, capabilities_digest, status, registered_at, last_seen_at, updated_at)
      VALUES (?, ?, ?, ?, 'test', '1.0', 1, ?, ?, 'online', ?, ?, ?)`)
      .run(
        workerId,
        nodeId,
        instanceId,
        workerId,
        capabilities,
        digest(capabilities),
        timestamp,
        timestamp,
        timestamp,
      );
    expect(
      database
        .prepare("UPDATE job_admission SET state = 'admitted', admitted_at = ? WHERE job_id = ?")
        .run(timestamp, jobId).changes,
    ).toBe(1);
    expect(
      database
        .prepare(`UPDATE jobs SET status = 'leased', current_run_attempt_id = ?, attempt_count = 1,
      lease_generation = 1, current_step = 'leased', started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued' AND current_run_attempt_id IS NULL`)
        .run(attemptId, timestamp, timestamp, jobId).changes,
    ).toBe(1);
    database
      .prepare(`INSERT INTO run_attempts (id, job_id, attempt_number, worker_id, worker_node_id,
      worker_instance_id, status, lease_token_hash, lease_generation, lease_expires_at, execution_deadline_at,
      no_progress_timeout_ms, no_progress_deadline_at, last_heartbeat_at, phase, started_at)
      VALUES (?, ?, 1, ?, ?, ?, 'leased', ?, 1, ?, ?, 600000, ?, ?, 'leased', ?)`)
      .run(
        attemptId,
        jobId,
        workerId,
        nodeId,
        instanceId,
        digest(attemptId),
        deadline,
        deadline,
        deadline,
        timestamp,
        timestamp,
      );
    database.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
    database.prepare("UPDATE run_attempts SET status = 'running' WHERE id = ?").run(attemptId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const repositoryRequest = <K extends RepositoryOperation>(
  database: DatabaseSync,
  operation: K,
  input: RepositoryOperationMap[K]["input"],
): RepositoryOperationMap[K]["output"] =>
  handleRepositoryConfigurationRequest(
    database,
    { operation, input } as RepositoryConfigurationRequest,
    timestamp,
  ) as RepositoryOperationMap[K]["output"];
const promptRequest = <K extends PromptConfigurationOperation>(
  database: DatabaseSync,
  operation: K,
  input: PromptConfigurationOperationMap[K]["input"],
): PromptConfigurationOperationMap[K]["output"] =>
  handlePromptConfigurationRequest(
    database,
    { operation, input } as PromptConfigurationRequest,
    timestamp,
  ) as PromptConfigurationOperationMap[K]["output"];

async function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  runMigrations(database, fileURLToPath(new URL("../../../../migrations", import.meta.url)));
  repositoryRequest(database, "bootstrapManagedRepositories", {
    repositories: [firstRepository, secondRepository].map(({ githubRepositoryId, fullName }) => ({
      githubRepositoryId,
      fullName,
    })),
    reviewer,
    authorizationPolicy: policy,
  });
  const defaults = await loadTrustedSchedulingConfig({
    promptDirectory: fileURLToPath(new URL("../../../../config/prompts", import.meta.url)),
    policy: defaultTrustedSchedulingPolicy,
    outputSchemas: {
      issueTriage: IssueTriageV2ModelOutputSchema,
      pullRequestReview: PrReviewPlanV2ModelOutputSchema,
    },
  });
  const request = vi.fn(async (operation: string, input: unknown) => {
    if (isRepositoryConfigurationOperation(operation)) {
      return handleRepositoryConfigurationRequest(
        database,
        { operation, input } as RepositoryConfigurationRequest,
        timestamp,
      );
    }
    if (isPromptConfigurationOperation(operation)) {
      return handlePromptConfigurationRequest(
        database,
        { operation, input } as PromptConfigurationRequest,
        timestamp,
      );
    }
    if (operation === "ingestSchedulingEvent")
      return ingestSchedulingEvent(database, input as IngestSchedulingEventInput);
    throw new Error(`Unexpected operation ${operation}.`);
  });
  const runtime = new ManagedGitHubRuntimeConfiguration({
    database: { request } as never,
    legacySchedulingConfig: defaults,
  });
  const ingestion = new GitHubEventIngestionService({
    database: { request } as never,
    resolveConfiguration: (event) => runtime.resolveEvent(event),
  });
  const service = {
    ingest: (event: NormalizedSchedulingEvent) => ingestion.ingest(event, deliveryForEvent(event)),
  };
  const readRepository = (githubRepositoryId = 1): ManagedRepository => {
    const repository = repositoryRequest(database, "getManagedRepositoryByGitHubId", {
      githubRepositoryId,
    });
    if (repository === null) throw new Error("Fixture repository missing.");
    return repository;
  };
  const updateRepository = (
    change: Omit<RepositoryUpdateRequest, "expectedVersion">,
    githubRepositoryId = 1,
  ) => {
    const repository = readRepository(githubRepositoryId);
    return repositoryRequest(database, "updateManagedRepository", {
      repositoryId: repository.id,
      actor: operator,
      request: { ...change, expectedVersion: repository.version },
    });
  };
  return { database, defaults, runtime, service, request, readRepository, updateRepository };
}

function deliveryForEvent(event: NormalizedSchedulingEvent) {
  return event.source === "webhook"
    ? {
        deliveryId: event.sourceEventId,
        eventName: event.workItem.kind === "issue" ? "issues" : "pull_request",
        payloadSha256: createHash("sha256").update(JSON.stringify(event)).digest("hex"),
        receivedAt: event.observedAt,
      }
    : null;
}

function requestEvent(
  id: string,
  options: {
    repository?: GitHubRepository;
    target?: GitHubActor;
    actor?: GitHubActor;
    head?: string;
    at?: string;
    kind?: "issue" | "pull_request";
  } = {},
): SchedulingRequestOpenedEvent {
  const repository = options.repository ?? firstRepository;
  const kind = options.kind ?? "pull_request";
  const at = options.at ?? timestamp;
  const headSha = options.head ?? "a".repeat(40);
  const githubWorkItemId = repository.githubRepositoryId * 100 + (kind === "issue" ? 43 : 42);
  const revisionKey =
    kind === "pull_request"
      ? createPullRequestRevisionKey("b".repeat(40), headSha)
      : createHash("sha256")
          .update(
            JSON.stringify(["Review this change", "Untrusted repository content.", "open", at]),
          )
          .digest("hex");
  const base = {
    githubRepositoryId: repository.githubRepositoryId,
    githubWorkItemId,
    githubNodeId: `item-${githubWorkItemId}`,
    number: kind === "issue" ? 43 : 42,
    title: "Review this change",
    body: "Untrusted repository content.",
    state: "open" as const,
    author,
    htmlUrl: `${repository.htmlUrl}/${kind === "issue" ? "issues" : "pull"}/${kind === "issue" ? 43 : 42}`,
    createdAt: timestamp,
    updatedAt: at,
    closedAt: null,
  };
  const revision = {
    githubRepositoryId: repository.githubRepositoryId,
    githubWorkItemId,
    revisionKey,
    observedAt: at,
    sourceUpdatedAt: at,
  };
  return {
    contractVersion: 1,
    eventId: id,
    source: kind === "pull_request" ? "webhook" : "poll",
    sourceEventId: id,
    occurredAt: at,
    observedAt: at,
    repository,
    author,
    action: "request_opened",
    requestKind: "assignment",
    actor: options.actor ?? allowedActor,
    target: options.target ?? reviewer,
    workItem: kind === "issue" ? { ...base, kind } : { ...base, kind, isDraft: false },
    revision:
      kind === "issue"
        ? { ...revision, kind, contentDigest: revisionKey }
        : { ...revision, kind, baseSha: "b".repeat(40), headSha },
  };
}

function publishedPrompt(
  database: DatabaseSync,
  content: string,
  workflowKind: "pr_static_build" | "issue_triage" = "pr_static_build",
) {
  const template = promptRequest(database, "createPromptTemplate", {
    actor: operator,
    request:
      workflowKind === "pr_static_build"
        ? { name: content, workflowKind, content, outputSchemaVersion: "PrReviewPlanV2" }
        : { name: content, workflowKind, content, outputSchemaVersion: "IssueTriageV2" },
  });
  return promptRequest(database, "publishPromptDraft", {
    templateId: template.id,
    actor: operator,
    request: { expectedVersion: template.version },
  });
}

function bind(
  database: DatabaseSync,
  repositoryId: string | null,
  version: PromptVersion,
  workflowKind: "pr_static_build" | "issue_triage" = "pr_static_build",
) {
  const existing = promptRequest(database, "listPromptBindings", { repositoryId }).find(
    (entry) => entry.workflowKind === workflowKind,
  );
  return promptRequest(database, "savePromptBinding", {
    repositoryId,
    workflowKind,
    actor: operator,
    request: { promptVersionId: version.id, expectedVersion: existing?.version ?? 0 },
  });
}

function job(database: DatabaseSync, jobId: string | null) {
  return database
    .prepare("SELECT status, execution_json, execution_digest FROM jobs WHERE id = ?")
    .get(jobId) as {
    status: string;
    execution_json: string;
    execution_digest: string;
  };
}

describe("managed GitHub runtime configuration", () => {
  it("resolves repository published prompts before global bindings with explicit deployed fallback", async () => {
    const f = await fixture();
    const event = requestEvent("first");
    expect((await f.runtime.resolveEvent(event))?.schedule?.executionTemplate.prompt.version).toBe(
      "2",
    );
    const global = publishedPrompt(f.database, "Global static review");
    const specific = publishedPrompt(f.database, "Repository static review");
    const triage = publishedPrompt(f.database, "Global issue triage", "issue_triage");
    bind(f.database, null, global);
    bind(f.database, f.readRepository().id, specific);
    bind(f.database, null, triage, "issue_triage");
    const resolved = await f.runtime.resolveEvent(event);
    expect(resolved?.schedule?.executionTemplate.prompt).toMatchObject({
      version: specific.id,
      name: "Repository static review",
    });
    expect(resolved?.schedule?.executionTemplate.prompt.renderedPrompt).toContain(
      "Repository static review",
    );
    expect(resolved?.schedule?.jobKind).toBe("pull_request_review");
    expect(Object.isFrozen(resolved?.schedule?.executionTemplate.prompt)).toBe(true);
    expect(
      (await f.runtime.resolveEvent(requestEvent("other", { repository: secondRepository })))
        ?.schedule?.executionTemplate.prompt.version,
    ).toBe(global.id);
    expect(
      (await f.runtime.resolveEvent(requestEvent("issue", { kind: "issue" })))?.schedule
        ?.executionTemplate.prompt.version,
    ).toBe(triage.id);
    expect(f.defaults.pullRequestReview.version).toBe("2");
  });

  it("uses each repository reviewer and allowlist without treating enablement as authorization", async () => {
    const f = await fixture();
    f.updateRepository(
      {
        reviewerGithubUserId: secondReviewer.githubUserId,
        reviewerGithubLogin: secondReviewer.login,
        authorizationPolicy: {
          ...policy,
          schedulingTargetGithubUserId: secondReviewer.githubUserId,
          allowlistedActorGithubUserIds: [300],
        },
      },
      2,
    );
    expect(await f.service.ingest(requestEvent("first"))).toMatchObject({
      authorized: true,
      jobCreated: true,
    });
    expect(
      await f.service.ingest(
        requestEvent("denied", { repository: secondRepository, target: secondReviewer }),
      ),
    ).toMatchObject({ authorized: false, jobCreated: false });
    expect(
      await f.service.ingest(
        requestEvent("allowed", {
          repository: secondRepository,
          target: secondReviewer,
          actor: { githubUserId: 300, login: "other-maintainer", accountType: "user" },
          at: later,
        }),
      ),
    ).toMatchObject({ authorized: true, jobCreated: true });
    expect(await f.runtime.listPollingTargets()).toEqual([
      {
        repository: { githubRepositoryId: 1, fullName: firstRepository.fullName },
        reviewer: { githubUserId: 100, login: reviewer.login },
      },
      {
        repository: { githubRepositoryId: 2, fullName: secondRepository.fullName },
        reviewer: { githubUserId: 101, login: secondReviewer.login },
      },
    ]);
  });

  it("keeps a frozen epoch job across prompt rebinds and transport observations, then uses the new binding after new authorization", async () => {
    const f = await fixture();
    f.updateRepository({
      authorizationPolicy: { ...policy, newRevisionPolicy: "inherit_authorized_epoch" },
    });
    const first = publishedPrompt(f.database, "First published prompt");
    bind(f.database, f.readRepository().id, first);
    const event = requestEvent("original-request");
    const admitted = await f.service.ingest(event);
    const originalJob = job(f.database, admitted.jobId);
    const next = publishedPrompt(f.database, "Next published prompt");
    bind(f.database, f.readRepository().id, next);
    expect(await f.service.ingest(event)).toMatchObject({
      outcome: "duplicate",
      jobId: admitted.jobId,
    });
    expect(
      await f.service.ingest({
        ...event,
        source: "reconciliation",
        eventId: "transport-observation",
        sourceEventId: "transport-observation",
      }),
    ).toMatchObject({ jobCreated: false, jobId: admitted.jobId });
    expect(
      await f.service.ingest({
        ...event,
        eventId: "same-revision",
        sourceEventId: "same-revision",
        action: "revision_observed",
        requestKind: null,
        target: null,
      }),
    ).toMatchObject({ authorized: false, jobCreated: false, jobId: null });
    expect(job(f.database, admitted.jobId)).toEqual(originalJob);
    const reauthorized = await f.service.ingest(requestEvent("new-authorization", { at: later }));
    expect(reauthorized).toMatchObject({ authorized: true, jobCreated: true });
    expect(reauthorized.jobId).not.toBe(admitted.jobId);
    expect(JSON.parse(job(f.database, reauthorized.jobId).execution_json).prompt.version).toBe(
      next.id,
    );
    expect(job(f.database, admitted.jobId).execution_json).toBe(originalJob.execution_json);
  });

  it("does not extend strict SHA authorization when a prompt binding changes", async () => {
    const f = await fixture();
    const admitted = await f.service.ingest(requestEvent("original"));
    bind(f.database, f.readRepository().id, publishedPrompt(f.database, "New instructions"));
    const changed = requestEvent("revision-b", { head: "c".repeat(40), at: later });
    const observation: NormalizedSchedulingEvent = {
      ...changed,
      action: "revision_observed",
      requestKind: null,
      target: null,
    };
    expect(await f.service.ingest(observation)).toMatchObject({
      authorized: false,
      jobCreated: false,
    });
    expect(job(f.database, admitted.jobId).status).toBe("stale");
    expect(
      await f.service.ingest(requestEvent("authorize-b", { head: "c".repeat(40), at: last })),
    ).toMatchObject({ authorized: true, jobCreated: true });
  });

  it("observes paused repositories without opening epochs or jobs and still cancels a running job on closure", async () => {
    const f = await fixture();
    const event = requestEvent("running");
    const admitted = await f.service.ingest(event);
    startRunningJob(f.database, admitted.jobId, "attempt-1");
    f.updateRepository({ enabled: false });
    expect(job(f.database, admitted.jobId).status).toBe("running");
    const closed: NormalizedSchedulingEvent = {
      ...event,
      eventId: "closed",
      sourceEventId: "closed",
      occurredAt: later,
      observedAt: later,
      workItem: { ...event.workItem, state: "closed", closedAt: later, updatedAt: later },
      action: "work_item_closed",
      requestKind: null,
      target: null,
      closeReason: "work_item_closed",
    };
    expect(await f.service.ingest(closed)).toMatchObject({
      authorized: false,
      jobCreated: false,
      cancelRequestedJobCount: 1,
    });
    expect(job(f.database, admitted.jobId).status).toBe("cancel_requested");
    expect(
      await f.service.ingest(requestEvent("paused-issue", { kind: "issue", at: later })),
    ).toMatchObject({ authorized: false, jobCreated: false, openedRequestEpochId: null });
    expect(
      (await f.runtime.listPollingTargets()).some(
        (entry) => entry.repository.githubRepositoryId === 1,
      ),
    ).toBe(true);
    f.updateRepository({ enabled: true });
    expect(
      await f.service.ingest(requestEvent("paused-issue", { kind: "issue", at: later })),
    ).toMatchObject({ outcome: "duplicate", authorized: false, jobCreated: false });
    expect(
      await f.service.ingest(
        requestEvent("fresh-issue-authorization", { kind: "issue", at: last }),
      ),
    ).toMatchObject({ authorized: true, jobCreated: true });
  });

  it.each(["changed", "cleared"] as const)(
    "keeps historical reviewer polling observation-only after reviewer settings are %s",
    async (mode) => {
      const f = await fixture();
      const original = requestEvent("original");
      const admitted = await f.service.ingest(original);
      f.updateRepository(
        mode === "changed"
          ? {
              reviewerGithubUserId: secondReviewer.githubUserId,
              reviewerGithubLogin: secondReviewer.login,
              authorizationPolicy: {
                ...policy,
                schedulingTargetGithubUserId: secondReviewer.githubUserId,
              },
            }
          : { reviewerGithubUserId: null, reviewerGithubLogin: null, authorizationPolicy: null },
      );
      expect(
        (await f.runtime.listPollingTargets())
          .filter((entry) => entry.repository.githubRepositoryId === 1)
          .map((entry) => entry.reviewer.githubUserId)
          .sort(),
      ).toEqual(mode === "changed" ? [100, 101] : [100]);
      const withdrawn: NormalizedSchedulingEvent = {
        ...original,
        source: "reconciliation",
        eventId: "withdrawn",
        sourceEventId: "withdrawn",
        occurredAt: later,
        observedAt: later,
        action: "request_closed",
        closeReason: "assignment_removed",
      };
      const key = {
        githubRepositoryId: 1,
        repositoryFullName: firstRepository.fullName,
        reviewerGithubUserId: reviewer.githubUserId,
      };
      const entries = await f.runtime.prepareReconciliation(key, [withdrawn]);
      expect(entries[0]).toMatchObject({
        allowScheduling: false,
        schedule: null,
        policy: { schedulingTargetGithubUserId: reviewer.githubUserId },
      });
      const entry = entries[0];
      if (entry === undefined) throw new Error("The reconciliation entry is missing.");
      expect(ingestSchedulingEvent(f.database, { ...entry, delivery: null })).toMatchObject({
        authorized: false,
        jobCreated: false,
        closedRequestEpochIds: [admitted.openedRequestEpochId],
      });
      expect(job(f.database, admitted.jobId).status).toBe("stale");
      expect(
        (await f.runtime.listPollingTargets())
          .filter((entry) => entry.repository.githubRepositoryId === 1)
          .map((entry) => entry.reviewer.githubUserId),
      ).toEqual(mode === "changed" ? [101] : []);
    },
  );

  it("never falls back to static admission for unknown IDs or mismatched names", async () => {
    const f = await fixture();
    await expect(
      f.service.ingest(
        requestEvent("unknown", { repository: { ...firstRepository, githubRepositoryId: 99 } }),
      ),
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_NOT_CONFIGURED" });
    await expect(
      f.service.ingest(
        requestEvent("mismatch", {
          repository: { ...firstRepository, fullName: "wrong-owner/project" },
        }),
      ),
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_NOT_CONFIGURED" });
    expect(f.database.prepare("SELECT COUNT(*) AS total FROM github_events").get()).toEqual({
      total: 0,
    });
    await expect(
      f.runtime.prepareReconciliation(
        {
          githubRepositoryId: 1,
          repositoryFullName: firstRepository.fullName,
          reviewerGithubUserId: 100,
        },
        [requestEvent("other", { repository: secondRepository })],
      ),
    ).rejects.toThrow(/another repository/u);
  });

  it("reconciles a lost withdrawal for the previous reviewer without any polling checkpoint", async () => {
    const f = await fixture();
    const original = requestEvent("webhook-before-first-poll");
    const admitted = await f.service.ingest(original);
    startRunningJob(f.database, admitted.jobId, "attempt-1");
    f.updateRepository({
      reviewerGithubUserId: secondReviewer.githubUserId,
      reviewerGithubLogin: secondReviewer.login,
      authorizationPolicy: { ...policy, schedulingTargetGithubUserId: secondReviewer.githubUserId },
    });
    expect(
      f.database.prepare("SELECT COUNT(*) AS total FROM github_polling_projections").get(),
    ).toEqual({ total: 0 });
    const key = {
      githubRepositoryId: 1,
      repositoryFullName: firstRepository.fullName,
      reviewerGithubUserId: reviewer.githubUserId,
    };
    const seeded = readGitHubPollingProjection(f.database, key).projection;
    expect(seeded?.workItems).toHaveLength(1);
    if (original.workItem.kind !== "pull_request" || original.revision.kind !== "pull_request")
      throw new Error("The fixture must be a pull request.");
    const client: GitHubReadClient = {
      getRepository: vi.fn(async () => firstRepository),
      searchIssuesAndPullRequests: vi.fn(async () => ({ items: [], nextPage: null })),
      getIssue: vi.fn(async () => {
        throw new Error("Unexpected issue read.");
      }),
      getPullRequest: vi.fn(async () => ({
        ...original.workItem,
        kind: "pull_request" as const,
        isDraft: false,
        baseSha: "b".repeat(40),
        headSha: "a".repeat(40),
        updatedAt: later,
      })),
      listIssueTimelineEvents: vi.fn(async () => ({ items: [], nextPage: null })),
    };
    const events: NormalizedSchedulingEvent[] = [];
    const reconciled = await reconcileGitHubPolling({
      repository: firstRepository,
      reviewer,
      client,
      previousActiveProjection: seeded,
      ingest: (event) => {
        events.push(event);
      },
      now: () => new Date(last),
    });
    expect(client.getPullRequest).toHaveBeenCalledOnce();
    expect(events.map((event) => event.action)).toContain("request_closed");
    const entries = await f.runtime.prepareReconciliation(key, events);
    expect(
      entries.every((entry) => entry.allowScheduling === false && entry.schedule === null),
    ).toBe(true);
    const committed = commitGitHubPollingReconciliation(f.database, {
      key,
      projection: reconciled.nextActiveProjection,
      events: entries,
      updatedAt: last,
    });
    expect(committed.eventResults.some((entry) => entry.cancelRequestedJobCount === 1)).toBe(true);
    expect(job(f.database, admitted.jobId).status).toBe("cancel_requested");
    expect(
      f.database.prepare("SELECT failure_code FROM jobs WHERE id = ?").get(admitted.jobId),
    ).toEqual({ failure_code: "request_withdrawn" });
    expect(readGitHubPollingProjection(f.database, key).projection?.workItems).toEqual([]);
    expect(
      (await f.runtime.listPollingTargets())
        .filter((entry) => entry.repository.githubRepositoryId === 1)
        .map((entry) => entry.reviewer.githubUserId),
    ).toEqual([101]);
  });

  it("keeps a resolved job snapshot immutable while later resolves see updated settings", async () => {
    const f = await fixture();
    const before = await f.runtime.resolveEvent(requestEvent("snapshot"));
    f.updateRepository({ enabled: false });
    expect(before?.allowScheduling).toBe(true);
    expect(Object.isFrozen(before?.policy.allowlistedActorGithubUserIds)).toBe(true);
    expect((await f.runtime.resolveEvent(requestEvent("next")))?.allowScheduling).toBe(false);
    const restarted = new ManagedGitHubRuntimeConfiguration({
      database: { request: f.request } as never,
      legacySchedulingConfig: f.defaults,
    });
    repositoryRequest(f.database, "bootstrapManagedRepositories", {
      repositories: [firstRepository].map(({ githubRepositoryId, fullName }) => ({
        githubRepositoryId,
        fullName,
      })),
      reviewer,
      authorizationPolicy: policy,
    });
    expect((await restarted.resolveEvent(requestEvent("restart")))?.allowScheduling).toBe(false);
  });

  it.each(["issue", "pull_request"] as const)(
    "does not grant a paused %s request through another transport after resume",
    async (kind) => {
      const f = await fixture();
      f.updateRepository({
        enabled: false,
        authorizationPolicy: { ...policy, newRevisionPolicy: "inherit_authorized_epoch" },
      });
      const original: NormalizedSchedulingEvent = {
        ...requestEvent("paused-webhook", { kind }),
        source: "webhook",
      };
      expect(await f.service.ingest(original)).toMatchObject({
        schedulingSuppressed: true,
        authorized: false,
        openedRequestEpochId: null,
      });
      f.updateRepository({ enabled: true });
      expect(
        await f.service.ingest({
          ...original,
          source: "poll",
          eventId: "same-request-from-poll",
          sourceEventId: "same-request-from-poll",
        }),
      ).toMatchObject({
        schedulingSuppressed: true,
        authorized: false,
        jobCreated: false,
        openedRequestEpochId: null,
      });
      expect(f.database.prepare("SELECT COUNT(*) AS total FROM jobs").get()).toEqual({ total: 0 });
      expect(
        await f.service.ingest(requestEvent("fresh-request", { kind, at: later })),
      ).toMatchObject({ authorized: true, jobCreated: true });
    },
  );

  it("allows an exact-SHA webhook after polling lacked authorization evidence", async () => {
    const f = await fixture();
    const event = requestEvent("exact-sha-webhook");
    expect(
      await f.service.ingest({
        ...event,
        source: "poll",
        eventId: "incomplete-poll",
        sourceEventId: "incomplete-poll",
      }),
    ).toMatchObject({ authorized: false, jobCreated: false });
    expect(await f.service.ingest(event)).toMatchObject({ authorized: true, jobCreated: true });
  });

  it.each(["pause", "revoke_actor", "change_reviewer", "require_exact_sha"] as const)(
    "rejects admission atomically when %s happens after resolving configuration",
    async (change) => {
      const f = await fixture();
      f.updateRepository({
        authorizationPolicy: { ...policy, newRevisionPolicy: "inherit_authorized_epoch" },
      });
      const event: NormalizedSchedulingEvent = {
        ...requestEvent("racing-request"),
        source: "poll",
      };
      const resolved = await f.runtime.resolveEvent(event);
      if (resolved === null) throw new Error("The configuration snapshot is missing.");
      if (change === "pause") f.updateRepository({ enabled: false });
      else if (change === "revoke_actor")
        f.updateRepository({
          authorizationPolicy: { ...policy, allowlistedActorGithubUserIds: [] },
        });
      else if (change === "change_reviewer")
        f.updateRepository({
          reviewerGithubUserId: secondReviewer.githubUserId,
          reviewerGithubLogin: secondReviewer.login,
          authorizationPolicy: {
            ...policy,
            schedulingTargetGithubUserId: secondReviewer.githubUserId,
          },
        });
      else f.updateRepository({ authorizationPolicy: policy });

      expect(() =>
        ingestSchedulingEvent(f.database, {
          event,
          policy: resolved.policy,
          allowScheduling: resolved.allowScheduling,
          schedule: resolved.schedule,
          delivery: null,
        }),
      ).toThrow(/settings changed/u);
      expect(f.database.prepare("SELECT COUNT(*) AS total FROM github_events").get()).toEqual({
        total: 0,
      });
      expect(f.database.prepare("SELECT COUNT(*) AS total FROM jobs").get()).toEqual({ total: 0 });
      expect(await f.service.ingest(event)).toMatchObject({ authorized: false, jobCreated: false });
    },
  );
});
