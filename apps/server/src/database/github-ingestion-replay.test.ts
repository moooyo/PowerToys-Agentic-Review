import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { NormalizedSchedulingEvent, SelfOrAllowlistPolicy } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  IssueTriageV2ModelOutputSchema,
  PrReviewPlanV2ModelOutputSchema,
} from "../../../../packages/codex/src/review-results.js";
import {
  NormalizedEventConflictError,
  WebhookDeliveryConflictError,
} from "../../dist/database/errors.js";
import { ingestSchedulingEvent } from "../../dist/database/github-ingestion.js";
import {
  commitGitHubPollingReconciliation,
  type GitHubPollingReconciliationEventInput,
  readGitHubPollingProjection,
} from "../../dist/database/github-polling-state.js";
import { runMigrations } from "../../dist/database/migrations.js";
import type {
  IngestSchedulingEventInput,
  IngestSchedulingEventResult,
  WebhookDeliveryInput,
} from "../../dist/database/protocol.js";
import { normalizeGitHubWebhookPayload } from "../../dist/github/normalize-webhook.js";
import {
  type GitHubIssueSnapshot,
  type GitHubPollingProjectionKey,
  type GitHubPullRequestSnapshot,
  type GitHubReadClient,
  type GitHubTimelineEvent,
  reconcileGitHubPolling,
} from "../../dist/github/poller.js";
import type { GitHubWebhookEventName } from "../../dist/github/types.js";
import {
  createScheduleJobInput,
  defaultTrustedSchedulingPolicy,
  loadTrustedSchedulingConfig,
  type TrustedSchedulingConfig,
} from "../../dist/scheduling/index.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const promptDirectory = fileURLToPath(new URL("../../../../config/prompts", import.meta.url));
const databases: DatabaseSync[] = [];
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function startRunningJob(
  database: DatabaseSync,
  jobId: string | null,
  attemptId: string,
  startedAt: string,
): void {
  if (jobId === null) throw new Error("The running fixture requires an accepted Job.");
  const workerId = `worker-${attemptId}`;
  const nodeId = `node-${attemptId}`;
  const instanceId = `instance-${attemptId}`;
  const deadline = new Date(Date.parse(startedAt) + 600_000).toISOString();
  const capabilities = JSON.stringify({
    operatingSystem: "windows",
    architecture: "x64",
    headless: true,
    interactiveDesktop: false,
    codexVersion: "test",
    recipeIds: [],
    labels: {},
  });
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(`INSERT INTO worker_node_credentials (worker_node_id, display_name, token_sha256, auth_state,
      created_by_issuer, created_by_subject, updated_by_issuer, updated_by_subject, created_at, updated_at, activated_at)
      VALUES (?, ?, ?, 'active', 'fixture', 'fixture', 'fixture', 'fixture', ?, ?, ?)`)
      .run(nodeId, nodeId, sha256(nodeId), startedAt, startedAt, startedAt);
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
        sha256(capabilities),
        startedAt,
        startedAt,
        startedAt,
      );
    expect(
      database
        .prepare("UPDATE job_admission SET state = 'admitted', admitted_at = ? WHERE job_id = ?")
        .run(startedAt, jobId).changes,
    ).toBe(1);
    expect(
      database
        .prepare(`UPDATE jobs SET status = 'leased', current_run_attempt_id = ?, attempt_count = 1,
      lease_generation = 1, current_step = 'leased', started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued' AND current_run_attempt_id IS NULL`)
        .run(attemptId, startedAt, startedAt, jobId).changes,
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
        sha256(attemptId),
        deadline,
        deadline,
        deadline,
        startedAt,
        startedAt,
      );
    database.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
    database.prepare("UPDATE run_attempts SET status = 'running' WHERE id = ?").run(attemptId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const rawIdentity = (id: number, login: string) => ({
  id,
  node_id: `U_${id}`,
  login,
  type: "User",
});
const rawAuthor = rawIdentity(200, "item-author");
const rawReviewer = rawIdentity(100, "reviewer");
const reviewer = {
  githubUserId: rawReviewer.id,
  githubNodeId: rawReviewer.node_id,
  login: rawReviewer.login,
  accountType: "user",
} as const;
const author = {
  githubUserId: rawAuthor.id,
  githubNodeId: rawAuthor.node_id,
  login: rawAuthor.login,
  accountType: "user",
} as const;
const rawRepository = {
  id: 10,
  node_id: "R_10",
  name: "PowerToys",
  full_name: "microsoft/PowerToys",
  html_url: "https://github.com/microsoft/PowerToys",
  default_branch: "main",
  private: false,
  owner: rawIdentity(1, "microsoft"),
};
const key: GitHubPollingProjectionKey = {
  githubRepositoryId: rawRepository.id,
  repositoryFullName: rawRepository.full_name,
  reviewerGithubUserId: reviewer.githubUserId,
};
const authorizationPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "inherit_authorized_epoch",
} satisfies SelfOrAllowlistPolicy;
const strictAuthorizationPolicy = {
  ...authorizationPolicy,
  newRevisionPolicy: "require_new_authorization",
} satisfies SelfOrAllowlistPolicy;

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe("GitHub ingestion replay with production scheduling inputs", () => {
  it("deduplicates webhook redelivery while rejecting payload and actor conflicts", async () => {
    const { database, config } = await createFixture();
    const payload = webhookPayload(issueSnapshot(501), "assigned");
    const rawPayload = JSON.stringify(payload);
    const firstInput = webhookInput(
      rawPayload,
      "issues",
      "issue-assigned-redelivery",
      "2026-08-30T10:05:30.000Z",
      config,
    );
    const replayInput = webhookInput(
      rawPayload,
      "issues",
      "issue-assigned-redelivery",
      "2026-08-30T10:06:30.000Z",
      config,
    );
    expect(replayInput.event.observedAt).not.toBe(firstInput.event.observedAt);
    expect(replayInput.event.revision.observedAt).not.toBe(firstInput.event.revision.observedAt);

    const first = ingestSchedulingEvent(database, firstInput);
    expect(first).toMatchObject({ outcome: "processed", authorized: true, jobCreated: true });
    expect(ingestSchedulingEvent(database, replayInput)).toMatchObject({
      outcome: "duplicate",
      eventId: first.eventId,
      jobId: first.jobId,
    });

    expect(() =>
      ingestSchedulingEvent(database, {
        ...replayInput,
        delivery: { ...replayInput.delivery, payloadSha256: sha256(`${rawPayload}\n`) },
      }),
    ).toThrow(WebhookDeliveryConflictError);

    const changedActorInput = webhookInput(
      JSON.stringify({ ...payload, sender: rawIdentity(999, "other-reviewer") }),
      "issues",
      "issue-assigned-redelivery",
      "2026-08-30T10:07:30.000Z",
      config,
    );
    expect(() =>
      ingestSchedulingEvent(database, {
        ...changedActorInput,
        delivery: {
          ...changedActorInput.delivery,
          payloadSha256: firstInput.delivery.payloadSha256,
        },
      }),
    ).toThrow(NormalizedEventConflictError);
    expect(() => ingestSchedulingEvent(database, changedActorInput)).toThrow(
      WebhookDeliveryConflictError,
    );
    expect(rowCount(database, "jobs")).toBe(1);
    expect(rowCount(database, "github_events")).toBe(1);
    expect(rowCount(database, "webhook_deliveries")).toBe(1);
  });

  it("shares one real factory job across assignment and review request metadata", async () => {
    const { database, config } = await createFixture();
    const snapshot = pullRequestSnapshot();
    const assignment = webhookInput(
      JSON.stringify(webhookPayload(snapshot, "assigned")),
      "pull_request",
      "pr-assigned",
      "2026-08-30T10:05:30.000Z",
      config,
    );
    const reviewRequest = webhookInput(
      JSON.stringify(webhookPayload(snapshot, "review_requested")),
      "pull_request",
      "pr-review-requested",
      "2026-08-30T10:06:30.000Z",
      config,
    );
    const first = ingestSchedulingEvent(database, assignment);
    const second = ingestSchedulingEvent(database, reviewRequest);

    expect(first).toMatchObject({ authorized: true, jobCreated: true });
    expect(second).toMatchObject({ authorized: true, jobCreated: false, jobId: first.jobId });
    expect(second.openedRequestEpochId).not.toBe(first.openedRequestEpochId);
    expect(rowCount(database, "jobs")).toBe(1);
    expect(rowCount(database, "request_epochs")).toBe(2);
    expect(rowCount(database, "job_request_epochs")).toBe(2);
  });

  it("shares one job across webhook and polling clocks and identity enrichment", async () => {
    const { database, config } = await createFixture();
    const snapshot = pullRequestSnapshot();
    const payload = webhookPayload(snapshot, "assigned");
    const first = ingestSchedulingEvent(
      database,
      webhookInput(
        JSON.stringify(payload),
        "pull_request",
        "pr-webhook-before-poll",
        "2026-08-30T10:05:30.000Z",
        config,
      ),
    );
    expect(first).toMatchObject({ authorized: true, jobCreated: true });
    const github = createGitHubFixture([
      {
        ...snapshot,
        updatedAt: "2026-08-30T10:06:00.000Z",
        author: {
          githubUserId: author.githubUserId,
          login: author.login,
          accountType: author.accountType,
          avatarUrl: "https://avatars.githubusercontent.com/u/200",
        },
      },
    ]);
    github.timelines.set(snapshot.number, [
      {
        githubEventId: 1_001,
        action: "assigned",
        actor: { githubUserId: reviewer.githubUserId, login: reviewer.login },
        target: { githubUserId: reviewer.githubUserId, login: reviewer.login },
        occurredAt: snapshot.updatedAt,
      },
    ]);

    const polled = await pollAndCommit(database, config, github.client, "2026-08-30T10:07:30.000Z");
    expect(polled.entries.map(({ event }) => event.action)).toEqual([
      "request_opened",
      "revision_observed",
    ]);
    expect(eventResult(polled, snapshot.number, "request_opened")).toMatchObject({
      authorized: true,
      jobCreated: false,
      jobId: first.jobId,
    });
    expect(eventResult(polled, snapshot.number, "revision_observed")).toMatchObject({
      authorized: false,
      jobCreated: false,
      jobId: null,
    });
    expect(rowCount(database, "jobs")).toBe(1);
    expect(rowCount(database, "request_epochs")).toBe(1);
  });

  it("preserves the checkpoint until both polling searches are complete", async () => {
    const { database, config } = await createFixture();
    const revisionA = pullRequestSnapshot();
    const github = createGitHubFixture([revisionA]);
    let reviewSearchIncomplete = false;
    const client: GitHubReadClient = {
      ...github.client,
      searchIssuesAndPullRequests: async (request) => ({
        ...(await github.client.searchIssuesAndPullRequests(request)),
        incomplete: reviewSearchIncomplete && request.query.includes("review-requested"),
      }),
    };
    const first = await pollAndCommit(database, config, client, "2026-08-30T10:05:30.000Z");
    const original = eventResult(first, revisionA.number, "request_opened");
    expect(original).toMatchObject({ authorized: true, jobCreated: true });
    const originalRevision = first.projection.workItems[0]?.revision.revisionKey;
    const originalEventCount = rowCount(database, "github_events");
    const revisionB: GitHubPullRequestSnapshot = {
      ...revisionA,
      headSha: "c".repeat(40),
      updatedAt: "2026-08-30T10:06:00.000Z",
    };
    github.snapshots.set(revisionA.number, revisionB);
    reviewSearchIncomplete = true;

    const deferred = await pollAndCommit(database, config, client, "2026-08-30T10:06:30.000Z");
    expect(deferred.entries).toEqual([]);
    expect(deferred.eventResults).toEqual([]);
    expect(deferred.projection).toEqual(first.projection);
    expect(readGitHubPollingProjection(database, key).projection).toEqual(first.projection);
    expect(rowCount(database, "jobs")).toBe(1);
    expect(rowCount(database, "request_epochs")).toBe(1);
    expect(rowCount(database, "github_events")).toBe(originalEventCount);
    expect(readActivationJob(database, original.jobId)).toMatchObject({ status: "queued" });
    expect(readEpochRevisions(database, original.workItemId)).toEqual([
      {
        id: original.openedRequestEpochId,
        requestKind: "assignment",
        status: "active",
        revisionKey: originalRevision,
        embeddedRevisionKey: originalRevision,
      },
    ]);
    expect(
      database
        .prepare("SELECT current_revision_key, source_updated_at FROM work_items WHERE id = ?")
        .get(original.workItemId),
    ).toEqual({ current_revision_key: originalRevision, source_updated_at: revisionA.updatedAt });

    reviewSearchIncomplete = false;
    const completed = await pollAndCommit(database, config, client, "2026-08-30T10:07:30.000Z");
    expect(completed.entries.map(({ event }) => event.action)).toEqual(["revision_observed"]);
    const advanced = eventResult(completed, revisionA.number, "revision_observed");
    expect(advanced).toMatchObject({
      authorized: true,
      jobCreated: true,
      openedRequestEpochId: null,
      activeRequestEpochIds: [original.openedRequestEpochId],
    });
    expect(advanced.jobId).not.toBe(original.jobId);
    expect(readActivationJob(database, original.jobId)).toMatchObject({ status: "stale" });
    expect(readActivationJob(database, advanced.jobId)).toMatchObject({ status: "queued" });
    const advancedRevision = completed.projection.workItems[0]?.revision.revisionKey;
    expect(advancedRevision).not.toBe(originalRevision);
    expect(readEpochRevisions(database, original.workItemId)).toEqual([
      {
        id: original.openedRequestEpochId,
        requestKind: "assignment",
        status: "active",
        revisionKey: advancedRevision,
        embeddedRevisionKey: advancedRevision,
      },
    ]);
    expect(readGitHubPollingProjection(database, key).projection).toEqual(completed.projection);
    expect(rowCount(database, "jobs")).toBe(2);
    expect(rowCount(database, "request_epochs")).toBe(1);

    const repeated = await pollAndCommit(database, config, client, "2026-08-30T10:08:30.000Z");
    expect(repeated.entries).toEqual([]);
    expect(rowCount(database, "jobs")).toBe(2);
    expect(rowCount(database, "request_epochs")).toBe(1);
  });

  it("recovers ambiguous requests with an atomic epoch replacement", async () => {
    const { database, config } = await createFixture();
    const revisionA = pullRequestSnapshot();
    const github = createGitHubFixture([revisionA]);
    const first = await pollAndCommit(database, config, github.client, "2026-08-30T10:05:30.000Z");
    const original = eventResult(first, revisionA.number, "request_opened");
    expect(original).toMatchObject({ authorized: true, jobCreated: true });
    const originalRevision = first.projection.workItems[0]?.revision.revisionKey;
    const ambiguousAt = "2026-08-30T10:06:00.000Z";
    const revisionB: GitHubPullRequestSnapshot = {
      ...revisionA,
      headSha: "c".repeat(40),
      updatedAt: ambiguousAt,
    };
    const ambiguousTimeline: GitHubTimelineEvent[] = [
      assignmentTimeline(revisionA),
      {
        githubEventId: 20_002,
        action: "assigned",
        actor: reviewer,
        target: reviewer,
        occurredAt: ambiguousAt,
      },
      {
        githubEventId: 20_001,
        action: "unassigned",
        actor: reviewer,
        target: reviewer,
        occurredAt: ambiguousAt,
      },
    ];
    github.snapshots.set(revisionA.number, revisionB);
    github.timelines.set(revisionA.number, ambiguousTimeline);

    const deferred = await pollAndCommit(
      database,
      config,
      github.client,
      "2026-08-30T10:06:30.000Z",
    );
    expect(deferred.entries).toEqual([]);
    expect(deferred.projection).toEqual(first.projection);
    expect(readGitHubPollingProjection(database, key).projection).toEqual(first.projection);
    expect(readActivationJob(database, original.jobId)).toMatchObject({ status: "queued" });
    expect(rowCount(database, "jobs")).toBe(1);
    expect(rowCount(database, "request_epochs")).toBe(1);

    const recoveredAt = "2026-08-30T10:07:00.000Z";
    github.snapshots.set(revisionA.number, { ...revisionB, updatedAt: recoveredAt });
    github.timelines.set(revisionA.number, [
      ...ambiguousTimeline,
      {
        githubEventId: 20_003,
        action: "assigned",
        actor: reviewer,
        target: reviewer,
        occurredAt: recoveredAt,
      },
    ]);
    const recovered = await pollAndCommit(
      database,
      config,
      github.client,
      "2026-08-30T10:07:30.000Z",
    );
    expect(recovered.entries.map(({ event }) => event.action)).toEqual([
      "request_opened",
      "revision_observed",
    ]);
    const replacement = eventResult(recovered, revisionA.number, "request_opened");
    expect(replacement).toMatchObject({
      authorized: true,
      jobCreated: true,
      closedRequestEpochIds: [original.openedRequestEpochId],
    });
    expect(eventResult(recovered, revisionA.number, "revision_observed")).toMatchObject({
      authorized: false,
      jobCreated: false,
      jobId: null,
    });
    expect(replacement.openedRequestEpochId).not.toBeNull();
    expect(replacement.openedRequestEpochId).not.toBe(original.openedRequestEpochId);
    expect(replacement.activeRequestEpochIds).toEqual([replacement.openedRequestEpochId]);
    expect(replacement.jobId).not.toBe(original.jobId);
    expect(readActivationJob(database, original.jobId)).toMatchObject({ status: "stale" });
    expect(readActivationJob(database, replacement.jobId)).toMatchObject({ status: "queued" });
    const recoveredRevision = recovered.projection.workItems[0]?.revision.revisionKey;
    expect(readEpochRevisions(database, original.workItemId)).toEqual([
      {
        id: original.openedRequestEpochId,
        requestKind: "assignment",
        status: "closed",
        revisionKey: originalRevision,
        embeddedRevisionKey: originalRevision,
      },
      {
        id: replacement.openedRequestEpochId,
        requestKind: "assignment",
        status: "active",
        revisionKey: recoveredRevision,
        embeddedRevisionKey: recoveredRevision,
      },
    ]);
    expect(readGitHubPollingProjection(database, key).projection).toEqual(recovered.projection);
    expect(rowCount(database, "jobs")).toBe(2);
    expect(rowCount(database, "request_epochs")).toBe(2);

    const repeated = await pollAndCommit(
      database,
      config,
      github.client,
      "2026-08-30T10:08:30.000Z",
    );
    expect(repeated.entries).toEqual([]);
    expect(rowCount(database, "jobs")).toBe(2);
    expect(rowCount(database, "request_epochs")).toBe(2);
  });

  it("authorizes the same SHA from an older webhook snapshot after strict polling", async () => {
    const { database, config } = await createFixture();
    const snapshot = pullRequestSnapshot();
    const github = createGitHubFixture([{ ...snapshot, updatedAt: "2026-08-30T10:06:00.000Z" }]);
    github.timelines.set(snapshot.number, [assignmentTimeline(snapshot)]);
    const polled = await pollAndCommit(
      database,
      config,
      github.client,
      "2026-08-30T10:06:30.000Z",
      strictAuthorizationPolicy,
    );
    expect(polled.entries.map(({ event }) => event.action)).toEqual([
      "request_opened",
      "revision_observed",
    ]);
    for (const result of polled.eventResults) {
      expect(result).toMatchObject({ authorized: false, jobCreated: false, jobId: null });
    }
    expect(rowCount(database, "jobs")).toBe(0);
    expect(rowCount(database, "request_epochs")).toBe(0);

    const assignmentInput = webhookInput(
      JSON.stringify(webhookPayload(snapshot, "assigned")),
      "pull_request",
      "strict-assignment-after-newer-poll-snapshot",
      "2026-08-30T10:07:30.000Z",
      config,
      strictAuthorizationPolicy,
    );
    const assignment = ingestSchedulingEvent(database, assignmentInput);
    expect(assignment).toMatchObject({
      authorized: true,
      jobCreated: true,
      workItemProjected: false,
    });
    expect(assignment.openedRequestEpochId).not.toBeNull();
    expect(rowCount(database, "jobs")).toBe(1);
    expect(readEpochRevisions(database, assignment.workItemId)).toEqual([
      {
        id: assignment.openedRequestEpochId,
        requestKind: "assignment",
        status: "active",
        revisionKey: assignmentInput.event.revision.revisionKey,
        embeddedRevisionKey: assignmentInput.event.revision.revisionKey,
      },
    ]);
    expect(
      database
        .prepare(`
          SELECT state, current_revision_key, source_updated_at, projection_source
          FROM work_items
          WHERE id = ?
        `)
        .get(assignment.workItemId),
    ).toEqual({
      state: "open",
      current_revision_key: assignmentInput.event.revision.revisionKey,
      source_updated_at: "2026-08-30T10:06:00.000Z",
      projection_source: "poll",
    });
  });

  it("withdraws a revision job when its only matching epoch closes", async () => {
    const { database, config } = await createFixture();
    const revisionA = pullRequestSnapshot();
    const assignmentInput = webhookInput(
      JSON.stringify(webhookPayload(revisionA, "assigned")),
      "pull_request",
      "strict-assignment-a",
      "2026-08-30T10:05:30.000Z",
      config,
      strictAuthorizationPolicy,
    );
    const assignment = ingestSchedulingEvent(database, assignmentInput);
    expect(assignment).toMatchObject({ authorized: true, jobCreated: true });

    const revisionB: GitHubPullRequestSnapshot = {
      ...revisionA,
      headSha: "c".repeat(40),
      updatedAt: "2026-08-30T10:06:00.000Z",
    };
    const observationInput = webhookInput(
      JSON.stringify(webhookPayload(revisionB, "synchronize")),
      "pull_request",
      "strict-observe-b",
      "2026-08-30T10:06:30.000Z",
      config,
      strictAuthorizationPolicy,
    );
    const observation = ingestSchedulingEvent(database, observationInput);
    expect(observation).toMatchObject({
      authorized: false,
      jobCreated: false,
      jobId: null,
      staleJobCount: 1,
    });
    expect(rowCount(database, "jobs")).toBe(1);
    expect(readEpochRevisions(database, assignment.workItemId)).toEqual([
      {
        id: assignment.openedRequestEpochId,
        requestKind: "assignment",
        status: "active",
        revisionKey: assignmentInput.event.revision.revisionKey,
        embeddedRevisionKey: assignmentInput.event.revision.revisionKey,
      },
    ]);

    const reviewRequestInput = webhookInput(
      JSON.stringify(
        webhookPayload({ ...revisionB, updatedAt: "2026-08-30T10:07:00.000Z" }, "review_requested"),
      ),
      "pull_request",
      "strict-review-request-b",
      "2026-08-30T10:07:30.000Z",
      config,
      strictAuthorizationPolicy,
    );
    const reviewRequest = ingestSchedulingEvent(database, reviewRequestInput);
    expect(reviewRequest).toMatchObject({ authorized: true, jobCreated: true });
    expect(reviewRequest.jobId).not.toBe(assignment.jobId);
    expect(reviewRequest.activeRequestEpochIds).toHaveLength(2);
    expect(reviewRequest.activeRequestEpochIds).toEqual(
      expect.arrayContaining([assignment.openedRequestEpochId, reviewRequest.openedRequestEpochId]),
    );
    expect(
      database
        .prepare(
          "SELECT request_epoch_id AS requestEpochId FROM job_request_epochs WHERE job_id = ?",
        )
        .all(reviewRequest.jobId),
    ).toEqual([{ requestEpochId: reviewRequest.openedRequestEpochId }]);

    const removalInput = webhookInput(
      JSON.stringify(
        webhookPayload(
          { ...revisionB, updatedAt: "2026-08-30T10:08:00.000Z" },
          "review_request_removed",
        ),
      ),
      "pull_request",
      "strict-review-request-b-removed",
      "2026-08-30T10:08:30.000Z",
      config,
      strictAuthorizationPolicy,
    );
    const removal = ingestSchedulingEvent(database, removalInput);
    expect(removal).toMatchObject({
      closedRequestEpochIds: [reviewRequest.openedRequestEpochId],
      activeRequestEpochIds: [assignment.openedRequestEpochId],
      staleJobCount: 1,
      cancelRequestedJobCount: 0,
    });
    expect(
      database
        .prepare("SELECT status, failure_code FROM jobs WHERE id = ?")
        .get(reviewRequest.jobId),
    ).toEqual({ status: "stale", failure_code: "request_withdrawn" });
    expect(readEpochRevisions(database, assignment.workItemId)).toEqual([
      {
        id: assignment.openedRequestEpochId,
        requestKind: "assignment",
        status: "active",
        revisionKey: assignmentInput.event.revision.revisionKey,
        embeddedRevisionKey: assignmentInput.event.revision.revisionKey,
      },
      {
        id: reviewRequest.openedRequestEpochId,
        requestKind: "review_request",
        status: "closed",
        revisionKey: observationInput.event.revision.revisionKey,
        embeddedRevisionKey: observationInput.event.revision.revisionKey,
      },
    ]);
    expect(rowCount(database, "jobs")).toBe(2);
  });

  it.each([
    { name: "the current policy remains strict", pollingPolicy: strictAuthorizationPolicy },
    { name: "the current policy permits inheritance", pollingPolicy: authorizationPolicy },
  ])("requires fresh consent for a new revision when $name", async ({ pollingPolicy }) => {
    const { database, config } = await createFixture();
    const revisionA = pullRequestSnapshot();
    const assignmentInput = webhookInput(
      JSON.stringify(webhookPayload(revisionA, "assigned")),
      "pull_request",
      "strict-original-assignment-a",
      "2026-08-30T10:05:30.000Z",
      config,
      strictAuthorizationPolicy,
    );
    const assignment = ingestSchedulingEvent(database, assignmentInput);
    expect(assignment).toMatchObject({ authorized: true, jobCreated: true });
    const revisionB: GitHubPullRequestSnapshot = {
      ...revisionA,
      headSha: "c".repeat(40),
      updatedAt: "2026-08-30T10:06:00.000Z",
    };
    const github = createGitHubFixture([revisionB]);
    github.timelines.set(revisionB.number, [assignmentTimeline(revisionA)]);

    const polled = await pollAndCommit(
      database,
      config,
      github.client,
      "2026-08-30T10:06:30.000Z",
      pollingPolicy,
    );
    expect(polled.entries.map(({ event }) => event.action)).toEqual([
      "request_opened",
      "revision_observed",
    ]);
    for (const result of polled.eventResults) {
      expect(result).toMatchObject({
        authorized: false,
        jobCreated: false,
        jobId: null,
        openedRequestEpochId: null,
      });
    }
    expect(rowCount(database, "jobs")).toBe(1);
    expect(readEpochRevisions(database, assignment.workItemId)).toEqual([
      {
        id: assignment.openedRequestEpochId,
        requestKind: "assignment",
        status: "active",
        revisionKey: assignmentInput.event.revision.revisionKey,
        embeddedRevisionKey: assignmentInput.event.revision.revisionKey,
      },
    ]);

    const reauthorizationPolicy = {
      ...strictAuthorizationPolicy,
      policyVersion: 2,
      allowlistedActorGithubUserIds: [999],
    } satisfies SelfOrAllowlistPolicy;
    const renewedInput = webhookInput(
      JSON.stringify({
        ...webhookPayload(revisionB, "assigned"),
        sender: rawIdentity(999, "maintainer"),
      }),
      "pull_request",
      "strict-renewed-assignment-b",
      "2026-08-30T10:07:30.000Z",
      config,
      reauthorizationPolicy,
    );
    const renewed = ingestSchedulingEvent(database, renewedInput);
    expect(renewed).toMatchObject({
      authorized: true,
      jobCreated: true,
      closedRequestEpochIds: [assignment.openedRequestEpochId],
    });
    expect(renewed.openedRequestEpochId).not.toBeNull();
    expect(renewed.openedRequestEpochId).not.toBe(assignment.openedRequestEpochId);
    expect(renewed.activeRequestEpochIds).toEqual([renewed.openedRequestEpochId]);
    expect(renewed.jobId).not.toBe(assignment.jobId);
    expect(readEpochRevisions(database, assignment.workItemId)).toEqual([
      {
        id: assignment.openedRequestEpochId,
        requestKind: "assignment",
        status: "closed",
        revisionKey: assignmentInput.event.revision.revisionKey,
        embeddedRevisionKey: assignmentInput.event.revision.revisionKey,
      },
      {
        id: renewed.openedRequestEpochId,
        requestKind: "assignment",
        status: "active",
        revisionKey: renewedInput.event.revision.revisionKey,
        embeddedRevisionKey: renewedInput.event.revision.revisionKey,
      },
    ]);
    expect(
      database
        .prepare(`
          SELECT
            json_extract(epoch_json, '$.openedByActor.githubUserId') AS actorId,
            json_extract(epoch_json, '$.authorizationPolicyVersion') AS policyVersion,
            json_extract(epoch_json, '$.authorizationBasis') AS authorizationBasis
          FROM request_epochs
          WHERE id = ?
        `)
        .get(renewed.openedRequestEpochId),
    ).toEqual({ actorId: 999, policyVersion: 2, authorizationBasis: "allowlist" });
    expect(
      database
        .prepare(
          "SELECT request_epoch_id AS requestEpochId FROM job_request_epochs WHERE job_id = ?",
        )
        .all(renewed.jobId),
    ).toEqual([{ requestEpochId: renewed.openedRequestEpochId }]);
    expect(rowCount(database, "jobs")).toBe(2);
  });

  it.each([
    {
      name: "strict queued self request",
      policy: strictAuthorizationPolicy,
      openingActor: rawReviewer,
      running: false,
    },
    {
      name: "inherited running allowlisted request",
      policy: { ...authorizationPolicy, allowlistedActorGithubUserIds: [999] },
      openingActor: rawIdentity(999, "maintainer"),
      running: true,
    },
  ])("withdraws $name on denied replacement", async ({ policy, openingActor, running }) => {
    const { database, config } = await createFixture();
    const revisionA = pullRequestSnapshot();
    const assignmentInput = webhookInput(
      JSON.stringify({ ...webhookPayload(revisionA, "assigned"), sender: openingActor }),
      "pull_request",
      "authorized-assignment-before-missed-removal",
      "2026-08-30T10:05:30.000Z",
      config,
      policy,
    );
    const assignment = ingestSchedulingEvent(database, assignmentInput);
    expect(assignment).toMatchObject({ authorized: true, jobCreated: true });
    const attemptId = "request-replaced-running-attempt";
    if (running) {
      const startedAt = "2026-08-30T10:05:45.000Z";
      startRunningJob(database, assignment.jobId, attemptId, startedAt);
    }

    const replacementInput = webhookInput(
      JSON.stringify({
        ...webhookPayload({ ...revisionA, updatedAt: "2026-08-30T10:06:00.000Z" }, "assigned"),
        sender: rawIdentity(888, "untrusted-actor"),
      }),
      "pull_request",
      "denied-new-assignment-after-missed-removal",
      "2026-08-30T10:06:30.000Z",
      config,
      policy,
    );
    expect(Date.parse(replacementInput.event.occurredAt)).toBeGreaterThan(
      Date.parse(assignmentInput.event.occurredAt),
    );
    expect(replacementInput.event.revision.revisionKey).toBe(
      assignmentInput.event.revision.revisionKey,
    );
    const replacement = ingestSchedulingEvent(database, replacementInput);
    expect(replacement).toMatchObject({
      outcome: "processed",
      authorized: false,
      jobCreated: false,
      jobId: null,
      openedRequestEpochId: null,
      closedRequestEpochIds: [assignment.openedRequestEpochId],
      activeRequestEpochIds: [],
      staleJobCount: running ? 0 : 1,
      cancelRequestedJobCount: running ? 1 : 0,
    });
    expect(
      database
        .prepare("SELECT outcome, reason FROM authorization_decisions WHERE github_event_id = ?")
        .all(replacement.eventId),
    ).toEqual([{ outcome: "denied", reason: "denied_actor_not_allowed" }]);
    expect(readEpochRevisions(database, assignment.workItemId)).toEqual([
      {
        id: assignment.openedRequestEpochId,
        requestKind: "assignment",
        status: "closed",
        revisionKey: assignmentInput.event.revision.revisionKey,
        embeddedRevisionKey: assignmentInput.event.revision.revisionKey,
      },
    ]);
    expect(
      database
        .prepare("SELECT status, failure_code, current_run_attempt_id FROM jobs WHERE id = ?")
        .get(assignment.jobId),
    ).toEqual({
      status: running ? "cancel_requested" : "stale",
      failure_code: "request_withdrawn",
      current_run_attempt_id: running ? attemptId : null,
    });
    expect(rowCount(database, "request_epochs")).toBe(1);
    expect(rowCount(database, "jobs")).toBe(1);

    if (running) {
      const revisionB: GitHubPullRequestSnapshot = {
        ...revisionA,
        headSha: "c".repeat(40),
        updatedAt: "2026-08-30T10:07:00.000Z",
      };
      const observed = ingestSchedulingEvent(
        database,
        webhookInput(
          JSON.stringify(webhookPayload(revisionB, "synchronize")),
          "pull_request",
          "new-revision-after-denied-replacement",
          "2026-08-30T10:07:30.000Z",
          config,
          policy,
        ),
      );
      expect(observed).toMatchObject({
        authorized: false,
        jobCreated: false,
        jobId: null,
        openedRequestEpochId: null,
        activeRequestEpochIds: [],
      });
      expect(
        database
          .prepare("SELECT outcome, reason FROM authorization_decisions WHERE github_event_id = ?")
          .all(observed.eventId),
      ).toEqual([{ outcome: "denied", reason: "denied_no_active_epoch" }]);
      expect(rowCount(database, "request_epochs")).toBe(1);
      expect(rowCount(database, "jobs")).toBe(1);
      expect(readActivationJob(database, assignment.jobId)).toMatchObject({
        status: "cancel_requested",
        current_run_attempt_id: attemptId,
      });
    }
  });

  it.each(["queued", "running"] as const)(
    "reactivates a returning revision after the original job was %s",
    async (originalStatus) => {
      const { database, config } = await createFixture();
      const revisionA = pullRequestSnapshot();
      const assignmentInput = webhookInput(
        JSON.stringify(webhookPayload(revisionA, "assigned")),
        "pull_request",
        "activation-original-assignment-a",
        "2026-08-30T10:05:30.000Z",
        config,
        authorizationPolicy,
      );
      const assignment = ingestSchedulingEvent(database, assignmentInput);
      expect(assignment).toMatchObject({ authorized: true, jobCreated: true });
      const firstActivation = readActivationJob(database, assignment.jobId);
      expect(firstActivation).toMatchObject({
        activation: 1,
        status: "queued",
        resource_revision: assignmentInput.event.revision.revisionKey,
        request_epoch_id: assignment.openedRequestEpochId,
      });

      const originalAttemptId = "activation-original-a-attempt";
      if (originalStatus === "running") {
        const startedAt = "2026-08-30T10:05:45.000Z";
        startRunningJob(database, assignment.jobId, originalAttemptId, startedAt);
      }

      const revisionB: GitHubPullRequestSnapshot = {
        ...revisionA,
        headSha: "c".repeat(40),
        updatedAt: "2026-08-30T10:06:00.000Z",
      };
      const github = createGitHubFixture([revisionB]);
      github.timelines.set(revisionB.number, [assignmentTimeline(revisionA)]);
      const switched = await pollAndCommit(
        database,
        config,
        github.client,
        "2026-08-30T10:06:30.000Z",
        authorizationPolicy,
      );
      const jobB = eventResult(switched, revisionB.number, "revision_observed");
      expect(jobB).toMatchObject({ authorized: true, jobCreated: true });
      expect(readActivationJob(database, jobB.jobId)).toMatchObject({
        activation: 1,
        status: "queued",
        request_epoch_id: assignment.openedRequestEpochId,
      });
      const retiredStatus = originalStatus === "running" ? "cancel_requested" : "stale";
      expect(readActivationJob(database, assignment.jobId)).toMatchObject({
        activation: 1,
        status: retiredStatus,
        current_run_attempt_id: originalStatus === "running" ? originalAttemptId : null,
      });

      const returnedSnapshot = { ...revisionA, updatedAt: "2026-08-30T10:07:00.000Z" };
      github.snapshots.set(revisionA.number, returnedSnapshot);
      const returned = await pollAndCommit(
        database,
        config,
        github.client,
        "2026-08-30T10:07:30.000Z",
        authorizationPolicy,
      );
      const secondActivation = eventResult(returned, revisionA.number, "revision_observed");
      expect(secondActivation).toMatchObject({
        authorized: true,
        jobCreated: true,
        activeRequestEpochIds: [assignment.openedRequestEpochId],
        openedRequestEpochId: null,
      });
      expect(secondActivation.jobId).not.toBe(assignment.jobId);
      expect(secondActivation.jobId).not.toBe(jobB.jobId);
      expect(readActivationJob(database, secondActivation.jobId)).toMatchObject({
        activation: 2,
        status: "queued",
        current_run_attempt_id: null,
        resource_revision: assignmentInput.event.revision.revisionKey,
        request_epoch_id: assignment.openedRequestEpochId,
        execution_digest: firstActivation?.execution_digest,
      });
      expect(readActivationJob(database, assignment.jobId)).toMatchObject({
        activation: 1,
        status: retiredStatus,
        current_run_attempt_id: originalStatus === "running" ? originalAttemptId : null,
      });
      expect(readActivationJob(database, jobB.jobId)).toMatchObject({
        activation: 1,
        status: "stale",
      });
      expect(rowCount(database, "jobs")).toBe(3);
      expect(rowCount(database, "request_epochs")).toBe(1);

      if (originalStatus === "running") {
        expect(
          database
            .prepare(`
              SELECT id, status, current_run_attempt_id
              FROM jobs
              WHERE concurrency_key = (SELECT concurrency_key FROM jobs WHERE id = ?)
                AND status IN ('leased', 'running', 'cancel_requested')
            `)
            .all(secondActivation.jobId),
        ).toEqual([
          {
            id: assignment.jobId,
            status: "cancel_requested",
            current_run_attempt_id: originalAttemptId,
          },
        ]);
        expect(() =>
          startRunningJob(
            database,
            secondActivation.jobId,
            "activation-returned-a-attempt",
            "2026-08-30T10:07:45.000Z",
          ),
        ).toThrow(/UNIQUE constraint failed: jobs\.concurrency_key/u);
      }

      const repeated = await pollAndCommit(
        database,
        config,
        github.client,
        "2026-08-30T10:08:30.000Z",
        authorizationPolicy,
      );
      expect(repeated.entries).toEqual([]);
      const repeatedObservation = ingestSchedulingEvent(
        database,
        webhookInput(
          JSON.stringify(webhookPayload(returnedSnapshot, "synchronize")),
          "pull_request",
          "activation-repeated-observation-a",
          "2026-08-30T10:09:30.000Z",
          config,
          authorizationPolicy,
        ),
      );
      expect(repeatedObservation).toMatchObject({
        outcome: "processed",
        authorized: false,
        jobCreated: false,
        jobId: null,
      });
      expect(rowCount(database, "jobs")).toBe(3);
      expect(readActivationJob(database, secondActivation.jobId)).toMatchObject({
        activation: 2,
        status: "queued",
        current_run_attempt_id: null,
      });
      expect(readActivationJob(database, assignment.jobId)).toMatchObject({
        activation: 1,
        status: retiredStatus,
        current_run_attempt_id: originalStatus === "running" ? originalAttemptId : null,
      });
    },
  );

  it("commits an issue replay and fresh issue without reviving closed authorization", async () => {
    const { database, config } = await createFixture();
    const originalSnapshot = issueSnapshot(501);
    const github = createGitHubFixture([originalSnapshot]);
    const first = await pollAndCommit(database, config, github.client, "2026-08-30T10:05:30.000Z");
    const original = eventResult(first, 501, "request_opened");
    expect(original).toMatchObject({ authorized: true, jobCreated: true });

    github.assignedNumbers = [];
    github.snapshots.set(501, {
      ...originalSnapshot,
      state: "closed",
      updatedAt: "2026-08-30T10:06:00.000Z",
      closedAt: "2026-08-30T10:06:00.000Z",
    });
    const closed = await pollAndCommit(database, config, github.client, "2026-08-30T10:06:30.000Z");
    expect(eventResult(closed, 501, "work_item_closed")).toMatchObject({
      closedRequestEpochIds: [original.openedRequestEpochId],
      activeRequestEpochIds: [],
      staleJobCount: 1,
    });
    expect(closed.projection.workItems).toEqual([]);

    github.snapshots.set(501, { ...originalSnapshot, updatedAt: "2026-08-30T10:07:00.000Z" });
    const freshSnapshot = issueSnapshot(500, "2026-08-30T10:07:00.000Z");
    github.snapshots.set(500, freshSnapshot);
    github.timelines.set(500, [assignmentTimeline(freshSnapshot)]);
    github.assignedNumbers = [501, 500];
    const reopened = await pollAndCommit(
      database,
      config,
      github.client,
      "2026-08-30T10:07:30.000Z",
    );

    expect(reopened.entries[0]?.event.workItem.number).toBe(500);
    expect(eventResult(reopened, 500, "request_opened")).toMatchObject({
      authorized: true,
      jobCreated: true,
    });
    expect(eventResult(reopened, 501, "request_opened")).toMatchObject({
      outcome: "duplicate",
      eventId: original.eventId,
      jobId: original.jobId,
    });
    expect(eventResult(reopened, 501, "revision_observed")).toMatchObject({
      authorized: false,
      jobCreated: false,
      jobId: null,
      activeRequestEpochIds: [],
    });
    expectClosedEpochAndOpenProjection(database, originalSnapshot);
    expect(readJobs(database)).toEqual([
      { number: 500, status: "queued" },
      { number: 501, status: "stale" },
    ]);
    expect(readGitHubPollingProjection(database, key).projection).toEqual(reopened.projection);

    const repeated = await pollAndCommit(
      database,
      config,
      github.client,
      "2026-08-30T10:08:30.000Z",
    );
    expect(repeated.entries).toEqual([]);
    expect(rowCount(database, "jobs")).toBe(2);
    expectClosedEpochAndOpenProjection(database, originalSnapshot);
  });

  it("rejects an old assignment first polled after a webhook close", async () => {
    const { database, config } = await createFixture();
    const snapshot = issueSnapshot(501);
    const opened = ingestSchedulingEvent(
      database,
      webhookInput(
        JSON.stringify(webhookPayload(snapshot, "assigned")),
        "issues",
        "issue-webhook-assigned",
        "2026-08-30T10:05:30.000Z",
        config,
      ),
    );
    const closed = ingestSchedulingEvent(
      database,
      webhookInput(
        JSON.stringify(
          webhookPayload(
            {
              ...snapshot,
              state: "closed",
              updatedAt: "2026-08-30T10:06:00.000Z",
              closedAt: "2026-08-30T10:06:00.000Z",
            },
            "closed",
          ),
        ),
        "issues",
        "issue-webhook-closed",
        "2026-08-30T10:06:30.000Z",
        config,
      ),
    );
    expect(closed.closedRequestEpochIds).toEqual([opened.openedRequestEpochId]);
    expect(readGitHubPollingProjection(database, key).projection).toBeNull();

    const github = createGitHubFixture([{ ...snapshot, updatedAt: "2026-08-30T10:07:00.000Z" }]);
    github.timelines.set(501, [assignmentTimeline(snapshot)]);
    const reopened = await pollAndCommit(
      database,
      config,
      github.client,
      "2026-08-30T10:07:30.000Z",
    );
    expect(eventResult(reopened, 501, "request_opened")).toMatchObject({
      outcome: "processed",
      authorized: false,
      jobCreated: false,
      openedRequestEpochId: null,
      activeRequestEpochIds: [],
    });
    expect(eventResult(reopened, 501, "revision_observed")).toMatchObject({
      authorized: false,
      jobCreated: false,
      activeRequestEpochIds: [],
    });
    expectClosedEpochAndOpenProjection(database, snapshot);
    expect(readJobs(database)).toEqual([{ number: 501, status: "stale" }]);
    expect(readGitHubPollingProjection(database, key).projection).toEqual(reopened.projection);

    const repeated = await pollAndCommit(
      database,
      config,
      github.client,
      "2026-08-30T10:08:30.000Z",
    );
    expect(repeated.entries).toEqual([]);
    expect(rowCount(database, "jobs")).toBe(1);
    expectClosedEpochAndOpenProjection(database, snapshot);
  });
});

async function createFixture() {
  const config = await loadTrustedSchedulingConfig({
    promptDirectory,
    policy: defaultTrustedSchedulingPolicy,
    outputSchemas: {
      issueTriage: IssueTriageV2ModelOutputSchema,
      pullRequestReview: PrReviewPlanV2ModelOutputSchema,
    },
  });
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  runMigrations(database, migrationsDirectory);
  return { database, config };
}

function issueSnapshot(
  number: number,
  updatedAt = "2026-08-30T10:05:00.000Z",
): GitHubIssueSnapshot {
  return {
    kind: "issue",
    githubWorkItemId: number + 1_000,
    githubNodeId: `I_${number}`,
    number,
    title: `Issue ${number}`,
    body: "Preserve authorization history while reconciling the current snapshot.",
    state: "open",
    author,
    htmlUrl: `https://github.com/microsoft/PowerToys/issues/${number}`,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt,
    closedAt: null,
  };
}

function pullRequestSnapshot(): GitHubPullRequestSnapshot {
  return {
    ...issueSnapshot(601),
    kind: "pull_request",
    githubNodeId: "PR_601",
    htmlUrl: "https://github.com/microsoft/PowerToys/pull/601",
    isDraft: false,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
  };
}

function webhookPayload(
  snapshot: GitHubIssueSnapshot | GitHubPullRequestSnapshot,
  action: "assigned" | "review_requested" | "review_request_removed" | "synchronize" | "closed",
): Record<string, unknown> {
  return {
    action,
    repository: rawRepository,
    sender: rawReviewer,
    ...(action === "assigned" ? { assignee: rawReviewer } : {}),
    ...(action === "review_requested" || action === "review_request_removed"
      ? { requested_reviewer: rawReviewer }
      : {}),
    [snapshot.kind === "issue" ? "issue" : "pull_request"]: {
      id: snapshot.githubWorkItemId,
      node_id: snapshot.githubNodeId,
      number: snapshot.number,
      title: snapshot.title,
      body: snapshot.body,
      state: snapshot.state,
      user: rawAuthor,
      html_url: snapshot.htmlUrl,
      created_at: snapshot.createdAt,
      updated_at: snapshot.updatedAt,
      closed_at: snapshot.closedAt,
      ...(snapshot.kind === "pull_request"
        ? {
            draft: snapshot.isDraft,
            base: { sha: snapshot.baseSha },
            head: { sha: snapshot.headSha },
          }
        : {}),
    },
  };
}

function webhookInput(
  rawPayload: string,
  eventName: GitHubWebhookEventName,
  deliveryId: string,
  receivedAt: string,
  config: TrustedSchedulingConfig,
  policy: SelfOrAllowlistPolicy = authorizationPolicy,
): IngestSchedulingEventInput & { readonly delivery: WebhookDeliveryInput } {
  const event = normalizeGitHubWebhookPayload({
    deliveryId,
    eventName,
    receivedAt,
    payload: JSON.parse(rawPayload) as unknown,
  });
  return {
    event,
    policy,
    delivery: { deliveryId, eventName, payloadSha256: sha256(rawPayload), receivedAt },
    schedule: createScheduleJobInput(event, config),
  };
}

function assignmentTimeline(
  snapshot: GitHubIssueSnapshot | GitHubPullRequestSnapshot,
): GitHubTimelineEvent {
  return {
    githubEventId: snapshot.number + 10_000,
    action: "assigned",
    actor: reviewer,
    target: reviewer,
    occurredAt: snapshot.updatedAt,
  };
}

function createGitHubFixture(
  initialSnapshots: readonly (GitHubIssueSnapshot | GitHubPullRequestSnapshot)[],
) {
  const state = {
    assignedNumbers: initialSnapshots.map((snapshot) => snapshot.number),
    snapshots: new Map(initialSnapshots.map((snapshot) => [snapshot.number, snapshot])),
    timelines: new Map<number, readonly GitHubTimelineEvent[]>(
      initialSnapshots.map((snapshot) => [snapshot.number, [assignmentTimeline(snapshot)]]),
    ),
  };
  const readSnapshot = (number: number) => {
    const snapshot = state.snapshots.get(number);
    if (snapshot === undefined) {
      throw new Error(`Missing GitHub snapshot for item ${number}.`);
    }
    return snapshot;
  };
  const client: GitHubReadClient = {
    getRepository: async () => ({
      githubRepositoryId: rawRepository.id,
      githubNodeId: rawRepository.node_id,
      fullName: rawRepository.full_name,
      htmlUrl: rawRepository.html_url,
      defaultBranch: rawRepository.default_branch,
      isPrivate: rawRepository.private,
    }),
    searchIssuesAndPullRequests: async ({ query }) => ({
      items: query.includes("review-requested")
        ? []
        : state.assignedNumbers.map((number) => {
            const snapshot = readSnapshot(number);
            return { kind: snapshot.kind, githubWorkItemId: snapshot.githubWorkItemId, number };
          }),
      nextPage: null,
    }),
    getIssue: async ({ number }) => {
      const snapshot = readSnapshot(number);
      if (snapshot.kind !== "issue") {
        throw new Error(`Expected issue ${number}.`);
      }
      return snapshot;
    },
    getPullRequest: async ({ number }) => {
      const snapshot = readSnapshot(number);
      if (snapshot.kind !== "pull_request") {
        throw new Error(`Expected pull request ${number}.`);
      }
      return snapshot;
    },
    listIssueTimelineEvents: async ({ number }) => ({
      items: state.timelines.get(number) ?? [],
      nextPage: null,
    }),
  };
  return Object.assign(state, { client });
}

async function pollAndCommit(
  database: DatabaseSync,
  config: TrustedSchedulingConfig,
  client: GitHubReadClient,
  observedAt: string,
  policy: SelfOrAllowlistPolicy = authorizationPolicy,
) {
  const entries: GitHubPollingReconciliationEventInput[] = [];
  const result = await reconcileGitHubPolling({
    client,
    repository: { githubRepositoryId: key.githubRepositoryId, fullName: key.repositoryFullName },
    reviewer,
    previousActiveProjection: readGitHubPollingProjection(database, key).projection,
    now: () => new Date(observedAt),
    ingest: (event) => {
      entries.push({
        event,
        policy,
        schedule: createScheduleJobInput(event, config),
      });
    },
  });
  const committed = commitGitHubPollingReconciliation(database, {
    key,
    projection: result.nextActiveProjection,
    events: entries,
    updatedAt: observedAt,
  });
  return { entries, eventResults: committed.eventResults, projection: result.nextActiveProjection };
}

function eventResult(
  round: Awaited<ReturnType<typeof pollAndCommit>>,
  number: number,
  action: NormalizedSchedulingEvent["action"],
): IngestSchedulingEventResult {
  const index = round.entries.findIndex(
    ({ event }) => event.workItem.number === number && event.action === action,
  );
  const result = round.eventResults[index];
  if (result === undefined) {
    throw new Error(`Missing ${action} ingestion result for item ${number}.`);
  }
  return result;
}

function rowCount(
  database: DatabaseSync,
  table: "jobs" | "github_events" | "webhook_deliveries" | "request_epochs" | "job_request_epochs",
): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    readonly count: number;
  };
  return row.count;
}

function readJobs(database: DatabaseSync) {
  return database
    .prepare(`
      SELECT item.github_number AS number, job.status
      FROM jobs AS job
      JOIN work_items AS item ON item.id = job.work_item_id
      ORDER BY item.github_number, job.created_at, job.id
    `)
    .all();
}

function readEpochRevisions(database: DatabaseSync, workItemId: string) {
  return database
    .prepare(`
      SELECT
        epoch.id,
        epoch.request_kind AS requestKind,
        epoch.status,
        revision.revision_key AS revisionKey,
        json_extract(epoch.epoch_json, '$.currentRevision.revisionKey') AS embeddedRevisionKey
      FROM request_epochs AS epoch
      JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id
      WHERE epoch.work_item_id = ?
      ORDER BY epoch.ordinal
    `)
    .all(workItemId);
}

function readActivationJob(database: DatabaseSync, jobId: string | null) {
  return database
    .prepare(`
      SELECT activation, status, current_run_attempt_id, resource_revision,
             request_epoch_id, execution_digest
      FROM jobs
      WHERE id = ?
    `)
    .get(jobId);
}

function expectClosedEpochAndOpenProjection(database: DatabaseSync, snapshot: GitHubIssueSnapshot) {
  expect(
    database
      .prepare(`
        SELECT epoch.ordinal, epoch.status
        FROM request_epochs AS epoch
        JOIN work_items AS item ON item.id = epoch.work_item_id
        WHERE item.github_work_item_id = ?
        ORDER BY epoch.ordinal
      `)
      .all(snapshot.githubWorkItemId),
  ).toEqual([{ ordinal: 1, status: "closed" }]);
  expect(
    database
      .prepare("SELECT state, source_updated_at FROM work_items WHERE github_work_item_id = ?")
      .get(snapshot.githubWorkItemId),
  ).toEqual({ state: "open", source_updated_at: "2026-08-30T10:07:00.000Z" });
}
