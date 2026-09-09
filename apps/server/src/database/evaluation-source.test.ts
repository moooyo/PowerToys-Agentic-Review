import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  ActiveAuthorizedRequestEpoch,
  EvaluationSourceReferenceV1,
  EvaluationSourceSnapshotV1,
  GitHubRepository,
  ManagedRepository,
  NormalizedSchedulingEvent,
  OperatorPrincipal,
  OperatorRepositoryRole,
  ReviewRunPlanInput,
  SchedulingRequestOpenedEvent,
  SelfOrAllowlistPolicy,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  assertEvaluationSourceSnapshotIntegrity,
  type CaptureEvaluationSourceInput,
  captureEvaluationSourceInTransaction,
  recomputeEvaluationSourceDigest,
} from "./evaluation-source.js";
import { ingestSchedulingEvent } from "./github-ingestion.js";
import { handleRepositoryConfigurationRequest } from "./managed-repositories.js";
import { runMigrations } from "./migrations.js";
import { handleOperatorAccessRequest } from "./operator-access.js";
import { handleReviewRunRequest, type ReviewRunDetail } from "./review-runs.js";

const now = "2026-09-08T01:00:00.000Z";
const later = "2026-09-08T02:00:00.000Z";
const actor = { issuer: "https://identity.example.test", subject: "maintainer" };
const administrator = { ...actor, subject: "administrator" };
const reviewer = { githubUserId: 100, login: "reviewer", accountType: "user" } as const;
const policy: SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "require_new_authorization",
};
const databases: DatabaseSync[] = [];
const formats = new Map(["date-time", "uri"].map((name) => [name, FormatRegistry.Get(name)]));
let migrationDirectory: string;

beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
  migrationDirectory = mkdtempSync(join(tmpdir(), "evaluation-source-m27-"));
  const source = fileURLToPath(new URL("../../../../migrations", import.meta.url));
  for (const name of readdirSync(source))
    if (/^\d+_.*\.sql$/u.test(name) && Number(name.split("_")[0]) <= 27)
      copyFileSync(join(source, name), join(migrationDirectory, name));
});
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
afterAll(() => {
  rmSync(migrationDirectory, { recursive: true, force: true });
  for (const [name, previous] of formats) {
    if (previous === undefined) FormatRegistry.Delete(name);
    else FormatRegistry.Set(name, previous);
  }
});

function metadata(githubRepositoryId = 1): GitHubRepository {
  return {
    githubRepositoryId,
    githubNodeId: `repository-${githubRepositoryId}`,
    ownerLogin: "example",
    name: `project-${githubRepositoryId}`,
    fullName: `example/project-${githubRepositoryId}`,
    htmlUrl: `https://github.com/example/project-${githubRepositoryId}`,
    defaultBranch: "main",
    isPrivate: false,
  };
}

function observed(
  kind: "pull_request" | "issue" = "pull_request",
  repository = metadata(),
): SchedulingRequestOpenedEvent {
  const githubWorkItemId = repository.githubRepositoryId * 1_000 + 1;
  const common = {
    githubWorkItemId,
    githubNodeId: `item-${githubWorkItemId}`,
    githubRepositoryId: repository.githubRepositoryId,
    number: 1,
    title: "Capture the original settings regression",
    body: "The original full report body.",
    state: "open" as const,
    author: reviewer,
    htmlUrl: `${repository.htmlUrl}/${kind === "issue" ? "issues" : "pull"}/1`,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  const workItem =
    kind === "pull_request" ? { ...common, kind, isDraft: false } : { ...common, kind };
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const revisionKey =
    kind === "pull_request"
      ? sha256(`${baseSha}\0${headSha}`)
      : sha256(JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]));
  return {
    contractVersion: 1,
    eventId: `event-${githubWorkItemId}`,
    source: "webhook",
    sourceEventId: `delivery-${githubWorkItemId}`,
    occurredAt: now,
    observedAt: now,
    repository,
    author: reviewer,
    action: "request_opened",
    requestKind: kind === "pull_request" ? "review_request" : "assignment",
    actor: reviewer,
    target: reviewer,
    workItem,
    revision: {
      githubRepositoryId: repository.githubRepositoryId,
      githubWorkItemId,
      revisionKey,
      observedAt: now,
      sourceUpdatedAt: now,
      ...(kind === "pull_request"
        ? { kind, baseSha, headSha }
        : { kind, contentDigest: revisionKey }),
    },
  };
}

function ingest(database: DatabaseSync, event: NormalizedSchedulingEvent) {
  const renderedPrompt = "Review the stored source.";
  return ingestSchedulingEvent(database, {
    allowScheduling: true,
    event,
    policy,
    schedule: {
      jobKind: event.workItem.kind === "pull_request" ? "pull_request_review" : "issue_triage",
      priority: 1,
      intentVersion: 1,
      maxAttempts: 1,
      requiredCapabilities: [],
      executionTemplate: {
        repository: {
          githubRepositoryId: event.repository.githubRepositoryId,
          fullName: event.repository.fullName,
        },
        resource: {
          githubNodeId: event.workItem.githubNodeId,
          number: event.workItem.number,
          title: event.workItem.title,
          author: reviewer,
          canonicalSnapshot: event.workItem,
          ...(event.revision.kind === "pull_request"
            ? {
                kind: "pull_request",
                baseSha: event.revision.baseSha,
                headSha: event.revision.headSha,
                isDraft: false,
              }
            : { kind: "issue", revisionDigest: event.revision.revisionKey }),
        },
        prompt: {
          name: "source-fixture",
          version: "1",
          renderedPrompt,
          promptSha256: sha256(renderedPrompt),
          outputSchema: {},
          outputSchemaSha256: sha256("{}"),
        },
        executionPolicy: {
          hardTimeoutMs: 120_000,
          noProgressTimeoutMs: 30_000,
          allowedRecipeIds: [],
          requiredCapabilityLabels: {},
        },
      },
    },
    delivery: {
      deliveryId: event.sourceEventId,
      eventName: event.workItem.kind,
      payloadSha256: sha256(canonicalJson(event)),
      receivedAt: event.observedAt,
    },
  });
}

function setRole(
  database: DatabaseSync,
  repositoryId: string,
  role: OperatorRepositoryRole | null,
  expectedVersion = 0,
): void {
  handleOperatorAccessRequest(
    database,
    {
      operation: "changeRepositoryAccess",
      input: {
        actor: administrator,
        repositoryId,
        request: {
          principal: actor,
          role,
          expectedVersion,
          changeId: `access-${expectedVersion}`,
          reason: "Authorize the isolated source capture fixture.",
        },
      },
    },
    later,
    [administrator],
  );
}

function fixture(kind: "pull_request" | "issue" = "pull_request") {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  runMigrations(database, migrationDirectory);
  handleRepositoryConfigurationRequest(
    database,
    {
      operation: "bootstrapManagedRepositories",
      input: {
        repositories: [metadata(1), metadata(2)].map(({ githubRepositoryId, fullName }) => ({
          githubRepositoryId,
          fullName,
        })),
        reviewer,
        authorizationPolicy: policy,
      },
    },
    now,
  );
  const event = observed(kind);
  const result = ingest(database, event);
  const repository = handleRepositoryConfigurationRequest(
    database,
    { operation: "getManagedRepository", input: { repositoryId: result.repositoryId } },
    now,
  ) as ManagedRepository;
  const epoch = database
    .prepare("SELECT epoch_json FROM request_epochs WHERE id = ?")
    .get(result.openedRequestEpochId) as { epoch_json: string };
  const planInput: ReviewRunPlanInput = {
    activationId: "historical-source-activation",
    repository: {
      id: repository.id,
      githubRepositoryId: repository.githubRepositoryId,
      fullName: repository.fullName,
      configurationVersion: repository.version,
    },
    workItemId: result.workItemId,
    workItem: event.workItem,
    revision: event.revision,
    testedSourceRevision:
      event.revision.kind === "pull_request"
        ? { kind: "pull_request", baseSha: event.revision.baseSha, headSha: event.revision.headSha }
        : { kind: "commit", headSha: "c".repeat(40) },
    testedSourceAuthorization:
      kind === "pull_request"
        ? null
        : {
            kind: "operator",
            activationId: "historical-source-activation",
            ...actor,
            authorizedAt: now,
            githubRepositoryId: repository.githubRepositoryId,
            githubWorkItemId: event.workItem.githubWorkItemId,
            issueRevisionKey: event.revision.revisionKey,
            headSha: "c".repeat(40),
          },
    authorization: JSON.parse(epoch.epoch_json) as ActiveAuthorizedRequestEpoch,
    authorizationPolicy: policy,
    requests: [
      {
        requestId: "fixture-request",
        workflowKind: kind === "pull_request" ? "pr_static_build" : "issue_validation",
        target: "headless",
        required: true,
        profileVersion: null,
        prompt: null,
      },
    ],
    runnerSupport: [],
  };
  setRole(database, repository.id, "maintainer");
  const reference: EvaluationSourceReferenceV1 = {
    kind: "current_work_item",
    workItemId: result.workItemId,
    expectedRevisionKey: event.revision.revisionKey,
    testedIssueCommit: null,
  };
  return {
    database,
    repositoryId: repository.id,
    event,
    reference,
    planInput,
    createRun: () =>
      handleReviewRunRequest(
        database,
        { operation: "createReviewRun", input: { planInput, actor } },
        now,
      ) as ReviewRunDetail,
  };
}

function capture(
  value: ReturnType<typeof fixture>,
  source: EvaluationSourceReferenceV1 = value.reference,
  options: { actor?: OperatorPrincipal; repositoryId?: string; now?: string } = {},
) {
  value.database.exec("BEGIN IMMEDIATE");
  try {
    return captureEvaluationSourceInTransaction(
      value.database,
      {
        repositoryId: options.repositoryId ?? value.repositoryId,
        actor: options.actor ?? actor,
        source,
      },
      options.now ?? later,
      [administrator],
    );
  } finally {
    value.database.exec("ROLLBACK");
  }
}

function historical(run: ReviewRunDetail): EvaluationSourceReferenceV1 {
  return { kind: "review_run", reviewRunId: run.id, expectedPlanDigest: run.planDigest };
}

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrow(expect.objectContaining({ code }));
}

function revise(value: ReturnType<typeof fixture>, body: string, headSha = "d".repeat(40)) {
  const { event } = value;
  const workItem = { ...event.workItem, body, updatedAt: later };
  const revisionKey =
    event.revision.kind === "pull_request"
      ? sha256(`${event.revision.baseSha}\0${headSha}`)
      : sha256(JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]));
  const changed: NormalizedSchedulingEvent = {
    ...event,
    eventId: `${event.eventId}-changed`,
    sourceEventId: `${event.sourceEventId}-changed`,
    observedAt: later,
    occurredAt: later,
    action: "revision_observed",
    requestKind: null,
    actor: null,
    target: null,
    workItem,
    revision: {
      ...event.revision,
      observedAt: later,
      sourceUpdatedAt: later,
      revisionKey,
      ...(event.revision.kind === "pull_request" ? { headSha } : { contentDigest: revisionKey }),
    },
  };
  ingest(value.database, changed);
  return { workItem, revisionKey };
}

describe("evaluation source capture from persisted M1-M27 state", () => {
  it("captures the full current PR snapshot with server identities and no database writes", () => {
    const value = fixture();
    const before = value.database.prepare("SELECT total_changes() AS count").get();
    const source = capture(value);
    const row = value.database
      .prepare("SELECT id FROM work_item_revisions WHERE work_item_id = ? AND revision_key = ?")
      .get(value.planInput.workItemId, value.event.revision.revisionKey) as { id: string };
    expect(source).toEqual({
      schemaVersion: "EvaluationSourceSnapshotV1",
      repository: value.planInput.repository,
      workItemId: value.planInput.workItemId,
      workItem: value.event.workItem,
      revision: {
        kind: "pull_request",
        githubRepositoryId: value.event.repository.githubRepositoryId,
        githubWorkItemId: value.event.workItem.githubWorkItemId,
        revisionKey: value.event.revision.revisionKey,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
      revisionId: row.id,
      testedSourceRevision: value.planInput.testedSourceRevision,
      sourceDigest: recomputeEvaluationSourceDigest(source),
      freshness: "frozen",
      provenance: {
        kind: "current_work_item",
        capturedAt: later,
        expectedRevisionKey: value.event.revision.revisionKey,
      },
    });
    expect(value.database.prepare("SELECT total_changes() AS count").get()).toEqual(before);
    expect(value.database.isTransaction).toBe(false);
    expect(() => assertEvaluationSourceSnapshotIntegrity(source)).not.toThrow();
  });

  it("captures explicit Issue checkout selection separately from the content revision", () => {
    const value = fixture("issue");
    expect(capture(value).testedSourceRevision).toBeNull();
    const source = capture(value, { ...value.reference, testedIssueCommit: "c".repeat(64) });
    expect(source.testedSourceRevision).toEqual({ kind: "commit", headSha: "c".repeat(64) });
    expect(source.revision.revisionKey).toBe(value.event.revision.revisionKey);
    expect(source.sourceDigest).not.toBe(capture(value).sourceDigest);
  });

  it.each(["pull_request", "issue"] as const)(
    "rejects a changed current %s revision and captures the new full body only by its new key",
    (kind) => {
      const value = fixture(kind);
      const original = capture(value);
      const changed = revise(value, "A changed full body with a new source revision.");
      expectCode(() => capture(value), "PLATFORM_CONFLICT");
      const source = capture(value, {
        ...value.reference,
        expectedRevisionKey: changed.revisionKey,
      });
      expect(source.workItem).toEqual(changed.workItem);
      expect(source.sourceDigest).not.toBe(original.sourceDigest);
      expect(original.workItem.body).toBe("The original full report body.");
    },
  );

  it("captures a changed PR body even when the exact commit pair is unchanged", () => {
    const value = fixture();
    const original = capture(value);
    revise(value, "New PR metadata for the same commit pair.", "b".repeat(40));
    const source = capture(value);
    expect(source.revision).toEqual(original.revision);
    expect(source.workItem.body).toBe("New PR metadata for the same commit pair.");
    expect(source.sourceDigest).not.toBe(original.sourceDigest);
  });

  it.each(["pull_request", "issue"] as const)(
    "preserves historical %s body, source and configuration after current state changes",
    (kind) => {
      const value = fixture(kind);
      const run = value.createRun();
      const original = capture(value, historical(run));
      revise(value, "This current body must never overwrite a historical sample.");
      value.database
        .prepare("UPDATE managed_repositories SET version = version + 1, enabled = 0 WHERE id = ?")
        .run(value.repositoryId);
      value.database
        .prepare(`UPDATE request_epochs SET status = 'closed', closing_event_id = opening_event_id,
          close_reason = 'work_item_closed', closed_at = ? WHERE work_item_id = ?`)
        .run(later, value.planInput.workItemId);
      const source = capture(value, historical(run));
      expect(source).toEqual(original);
      expect(source.repository).toEqual(run.plan.repository);
      expect(source.workItem).toEqual(run.plan.workItem);
      expect(source.testedSourceRevision).toEqual(run.plan.testedSourceRevision);
      expect(source.provenance).toEqual({
        kind: "review_run",
        capturedAt: later,
        reviewRunId: run.id,
        planDigest: run.planDigest,
        requestEpochId: run.requestEpochId,
      });
      expect(source).not.toHaveProperty("authorization");
      expect(source).not.toHaveProperty("testedSourceAuthorization");
    },
  );

  it("hashes content independently of capture time and source provenance", () => {
    const value = fixture();
    const current = capture(value, value.reference, { now });
    const run = value.createRun();
    const historicalSource = capture(value, historical(run));
    expect(historicalSource.sourceDigest).toBe(current.sourceDigest);
    expect(historicalSource.provenance).not.toEqual(current.provenance);
    const modified = structuredClone(current);
    modified.workItem.body = "A forged replacement body.";
    expectCode(() => assertEvaluationSourceSnapshotIntegrity(modified), "PLATFORM_CORRUPT");
    modified.sourceDigest = recomputeEvaluationSourceDigest(modified);
    expect(() => assertEvaluationSourceSnapshotIntegrity(modified)).not.toThrow();
  });

  it.each(["viewer", "reviewer", null] as const)(
    "rechecks current configure permission after changing the role to %s",
    (role) => {
      const value = fixture();
      const run = value.createRun();
      capture(value);
      capture(value, historical(run));
      setRole(value.database, value.repositoryId, role, 1);
      for (const source of [value.reference, historical(run)])
        expectCode(
          () => capture(value, source),
          role === null ? "PLATFORM_NOT_FOUND" : "PLATFORM_FORBIDDEN",
        );
    },
  );

  it("keeps out-of-scope items and runs indistinguishable from nonexistent sources", () => {
    const value = fixture();
    const foreign = ingest(value.database, observed("pull_request", metadata(2)));
    const run = value.createRun();
    for (const source of [
      { ...value.reference, workItemId: foreign.workItemId },
      { ...value.reference, workItemId: "missing-work-item" },
      {
        kind: "review_run",
        reviewRunId: "missing-run",
        expectedPlanDigest: run.planDigest,
      } as const,
    ])
      expectCode(() => capture(value, source), "PLATFORM_NOT_FOUND");
    setRole(value.database, foreign.repositoryId, "maintainer");
    expectCode(
      () => capture(value, historical(run), { repositoryId: foreign.repositoryId }),
      "PLATFORM_NOT_FOUND",
    );
    expectCode(
      () => capture(value, historical(run), { actor: { ...actor, subject: "unknown" } }),
      "PLATFORM_NOT_FOUND",
    );
  });

  it("requires a caller transaction and rejects malformed references before reading source data", () => {
    const value = fixture();
    const input: CaptureEvaluationSourceInput = {
      repositoryId: value.repositoryId,
      actor,
      source: value.reference,
    };
    expectCode(
      () => captureEvaluationSourceInTransaction(value.database, input, later, [administrator]),
      "PLATFORM_INVALID",
    );
    for (const source of [
      { ...value.reference, workItem: value.event.workItem },
      { ...value.reference, expectedRevisionKey: "a".repeat(40) },
      { ...value.reference, testedIssueCommit: "a".repeat(41) },
      { ...value.reference, testedIssueCommit: "main" },
      { kind: "review_run", reviewRunId: "run-1", expectedPlanDigest: "A".repeat(64) },
    ])
      expectCode(() => capture(value, source as EvaluationSourceReferenceV1), "PLATFORM_INVALID");
    expectCode(() => capture(value, value.reference, { now: "2026-09-08" }), "PLATFORM_INVALID");
    expectCode(
      () => capture(value, { ...value.reference, testedIssueCommit: "c".repeat(40) }),
      "PLATFORM_INVALID",
    );
  });

  it.each([
    "UPDATE work_items SET title = 'A contradictory title' WHERE id = ?",
    "UPDATE work_items SET body = 'A contradictory body' WHERE id = ?",
    "UPDATE work_items SET github_node_id = 'different-node' WHERE id = ?",
    "UPDATE work_items SET author_login = 'different-author' WHERE id = ?",
    "UPDATE work_items SET is_draft = 1 WHERE id = ?",
    "UPDATE work_item_revisions SET head_sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE work_item_id = ?",
    "UPDATE work_item_revisions SET revision_json = '{}' WHERE work_item_id = ?",
    "UPDATE work_items SET snapshot_json = '{' WHERE id = ?",
  ])("rejects contradictory persisted source data: %s", (sql) => {
    const value = fixture();
    value.database.prepare(sql).run(value.planInput.workItemId);
    expectCode(() => capture(value), "PLATFORM_CORRUPT");
  });

  it("rejects repository numeric identity and canonical metadata contradictions", () => {
    const value = fixture();
    value.database
      .prepare("UPDATE managed_repositories SET github_repository_id = 999 WHERE id = ?")
      .run(value.repositoryId);
    expectCode(() => capture(value), "PLATFORM_CORRUPT");
    value.database
      .prepare("UPDATE managed_repositories SET github_repository_id = 1 WHERE id = ?")
      .run(value.repositoryId);
    value.database
      .prepare("UPDATE repositories SET full_name = 'example/renamed' WHERE id = ?")
      .run(value.repositoryId);
    expectCode(() => capture(value), "PLATFORM_CORRUPT");
  });

  it("recomputes Issue content digests even when its snapshot and scalar columns agree", () => {
    const value = fixture("issue");
    const changed = { ...value.event.workItem, body: "Unversioned edited Issue body." };
    value.database
      .prepare("UPDATE work_items SET body = ?, snapshot_json = ? WHERE id = ?")
      .run(changed.body, canonicalJson(changed), value.planInput.workItemId);
    expectCode(() => capture(value), "PLATFORM_CORRUPT");
  });

  it("recomputes PR commit digests even when revision JSON and scalar columns agree", () => {
    const value = fixture();
    const changed = { ...value.event.revision, headSha: "f".repeat(40) };
    value.database
      .prepare(
        "UPDATE work_item_revisions SET head_sha = ?, revision_json = ? WHERE work_item_id = ?",
      )
      .run(changed.headSha, canonicalJson(changed), value.planInput.workItemId);
    expectCode(() => capture(value), "PLATFORM_CORRUPT");
  });

  it("rejects invalid exact PR hashes admitted by the broader ingestion hash shape", () => {
    const value = fixture();
    const changed = { ...value.event.revision, headSha: "f".repeat(41) };
    value.database
      .prepare(
        "UPDATE work_item_revisions SET head_sha = ?, revision_json = ? WHERE work_item_id = ?",
      )
      .run(changed.headSha, canonicalJson(changed), value.planInput.workItemId);
    expectCode(() => capture(value), "PLATFORM_CORRUPT");
  });

  it("checks the requested historical digest and recomputes the stored immutable plan digest", () => {
    const value = fixture();
    const run = value.createRun();
    expectCode(
      () => capture(value, { ...historical(run), expectedPlanDigest: "f".repeat(64) }),
      "PLATFORM_CONFLICT",
    );
    // Deliberately corrupt an isolated fixture while retaining the real table constraints.
    value.database.exec("DROP TRIGGER tr_review_runs_immutable_update");
    const forged = { ...run.plan, workItem: { ...run.plan.workItem, body: "Tampered old body." } };
    value.database
      .prepare("UPDATE review_runs SET plan_json = ? WHERE id = ?")
      .run(canonicalJson(forged), run.id);
    expectCode(() => capture(value, historical(run)), "PLATFORM_CORRUPT");
  });

  it("rejects forged historical snapshot identities even with a matching recomputed plan digest", () => {
    const value = fixture();
    const run = value.createRun();
    value.database.exec("DROP TRIGGER tr_review_runs_immutable_update");
    const forged = {
      ...run.plan,
      workItem: { ...run.plan.workItem, githubWorkItemId: 999_999 },
    };
    const digest = sha256(canonicalJson(forged));
    value.database
      .prepare("UPDATE review_runs SET plan_json = ?, plan_digest = ? WHERE id = ?")
      .run(canonicalJson(forged), digest, run.id);
    expectCode(
      () => capture(value, { kind: "review_run", reviewRunId: run.id, expectedPlanDigest: digest }),
      "PLATFORM_CORRUPT",
    );
  });

  it("rejects historical strict-contract extras and malformed V2 plans", () => {
    const value = fixture();
    const run = value.createRun();
    value.database.exec("DROP TRIGGER tr_review_runs_immutable_update");
    value.database.exec("PRAGMA ignore_check_constraints = ON");
    for (const forged of [
      { ...run.plan, rawAuthorization: {} },
      { ...run.plan, schemaVersion: "ReviewRunExecutionPlanV2" },
    ]) {
      const digest = sha256(canonicalJson(forged));
      value.database
        .prepare("UPDATE review_runs SET plan_json = ?, plan_digest = ? WHERE id = ?")
        .run(canonicalJson(forged), digest, run.id);
      expectCode(
        () =>
          capture(value, { kind: "review_run", reviewRunId: run.id, expectedPlanDigest: digest }),
        "PLATFORM_CORRUPT",
      );
    }
  });

  it("rejects oversized UTF-8 bodies before JSON parsing instead of truncating them", () => {
    const value = fixture();
    const oversized = "x".repeat(2 * 1024 * 1024 + 1);
    value.database
      .prepare("UPDATE work_items SET snapshot_json = ? WHERE id = ?")
      .run(oversized, value.planInput.workItemId);
    expectCode(() => capture(value), "PLATFORM_INVALID");
    const unicode = { ...value.event.workItem, body: "界".repeat(750_000) };
    value.database
      .prepare("UPDATE work_items SET body = ?, snapshot_json = ? WHERE id = ?")
      .run(unicode.body, canonicalJson(unicode), value.planInput.workItemId);
    expectCode(() => capture(value), "PLATFORM_INVALID");
  });

  it("rejects historical source bodies larger than the source budget despite the larger plan budget", () => {
    const value = fixture();
    const run = value.createRun();
    value.database.exec("DROP TRIGGER tr_review_runs_immutable_update");
    const oversized = {
      ...run.plan,
      workItem: { ...run.plan.workItem, body: "界".repeat(750_000) },
    };
    const digest = sha256(canonicalJson(oversized));
    value.database
      .prepare("UPDATE review_runs SET plan_json = ?, plan_digest = ? WHERE id = ?")
      .run(canonicalJson(oversized), digest, run.id);
    expectCode(
      () => capture(value, { kind: "review_run", reviewRunId: run.id, expectedPlanDigest: digest }),
      "PLATFORM_INVALID",
    );
  });

  it("enforces the final aggregate source budget and verifies stored source digests", () => {
    const value = fixture();
    const original = capture(value);
    const source = structuredClone(original);
    source.workItem.body = "界".repeat(700_000);
    source.sourceDigest = recomputeEvaluationSourceDigest(source);
    expectCode(() => assertEvaluationSourceSnapshotIntegrity(source), "PLATFORM_CORRUPT");
    const forged: EvaluationSourceSnapshotV1 = { ...original, sourceDigest: "a".repeat(64) };
    expectCode(() => assertEvaluationSourceSnapshotIntegrity(forged), "PLATFORM_CORRUPT");
  });
});
