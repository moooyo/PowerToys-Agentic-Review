import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  completion,
  createEvidenceControlPlaneFixture,
  type EvidenceControlPlaneFixture,
  present,
} from "./evidence-control-plane.testing.js";
import { findingOccurrenceKey } from "./finding-disposition-projection.js";
import { runMigrations } from "./migrations.js";
import {
  ReviewRunDecisionSnapshotV1Schema,
  ReviewRunDecisionSnapshotV2Schema,
  readReviewRunDecisionSnapshotInTransaction,
} from "./review-run-decision-snapshot.js";
import * as validationModelResultBinding from "./validation-model-result-binding.js";

const scope = { repositoryId: "repo-1", reviewRunId: "run-1" };
const revision = "a".repeat(64);
const executionDigest = "b".repeat(64);
const resultDigest = "c".repeat(64);
const policy = { policyVersion: 1, schedulingTargetGithubUserId: 7 };
const databases: DatabaseSync[] = [];
const realFixtures: EvidenceControlPlaneFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  for (const fixture of realFixtures.splice(0)) await fixture.dispose();
});

function read(database: DatabaseSync, query = scope) {
  database.exec("BEGIN");
  try {
    return readReviewRunDecisionSnapshotInTransaction(database, query);
  } finally {
    database.exec("ROLLBACK");
  }
}

// Writable relational fixtures exercise corruption that production migrations prohibit. A real
// migrated DatabaseWorker fixture below also covers actual lifecycle, result admission, and reruns.
function fixture(options: { automatic?: boolean; missingJob?: boolean; issue?: boolean } = {}) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE managed_repositories(id TEXT PRIMARY KEY, github_repository_id INTEGER,
      enabled INTEGER, version INTEGER, reviewer_github_user_id INTEGER, authorization_policy_json TEXT);
    CREATE TABLE work_items(id TEXT PRIMARY KEY, repository_id TEXT, resource_kind TEXT,
      current_revision_key TEXT, state TEXT);
    CREATE TABLE work_item_revisions(id TEXT PRIMARY KEY, work_item_id TEXT, revision_key TEXT);
    CREATE TABLE request_epochs(id TEXT PRIMARY KEY, work_item_id TEXT, status TEXT,
      current_revision_id TEXT, target_github_user_id INTEGER, ordinal INTEGER);
    CREATE TABLE review_runs(id TEXT PRIMARY KEY, repository_id TEXT, work_item_id TEXT,
      revision_id TEXT, revision_key TEXT, plan_digest TEXT, activation_id TEXT, request_epoch_id TEXT,
      request_count INTEGER, plan_json TEXT, purpose TEXT DEFAULT 'review');
    CREATE TABLE review_run_requests(review_run_id TEXT, request_id TEXT, workflow_kind TEXT,
      target TEXT, required INTEGER, profile_version_id TEXT, prompt_version_id TEXT, request_json TEXT);
    CREATE TABLE review_run_job_links(review_run_id TEXT, request_id TEXT, activation_number INTEGER, job_id TEXT);
    CREATE TABLE github_review_run_sources(work_item_id TEXT PRIMARY KEY, current_revision_key TEXT, sequence INTEGER);
    CREATE TABLE github_review_run_activations(work_item_id TEXT, request_epoch_id TEXT,
      source_sequence INTEGER, revision_key TEXT, mode TEXT, review_run_id TEXT);
    CREATE TABLE jobs(id TEXT PRIMARY KEY, work_item_id TEXT, resource_revision TEXT,
      request_epoch_id TEXT, job_kind TEXT, status TEXT, attempt_count INTEGER,
      current_run_attempt_id TEXT, execution_digest TEXT, updated_at TEXT);
    CREATE TABLE run_attempts(id TEXT PRIMARY KEY, job_id TEXT, status TEXT, attempt_number INTEGER,
      result_digest TEXT, phase TEXT, last_heartbeat_at TEXT, progress_sequence INTEGER);
    CREATE TABLE validation_job_results(id TEXT PRIMARY KEY, run_attempt_id TEXT, job_id TEXT,
      repository_id TEXT, work_item_id TEXT, revision_id TEXT, resource_revision TEXT, review_run_id TEXT,
      request_id TEXT, job_activation INTEGER, activation_id TEXT, plan_digest TEXT, job_kind TEXT,
      profile_version_id TEXT, prompt_version_id TEXT, workflow_kind TEXT, target TEXT,
      schema_id TEXT, result_digest TEXT, execution_template_sha256 TEXT, evidence_complete INTEGER);
    CREATE TABLE finding_dispositions(result_id TEXT, result_digest TEXT, repository_id TEXT,
      review_run_id TEXT, request_id TEXT, job_id TEXT, kind TEXT, ordinal INTEGER,
      occurrence_key TEXT, state TEXT, version INTEGER, last_event_id TEXT, created_at TEXT,
      updated_at TEXT, updated_by_issuer TEXT, updated_by_subject TEXT);
    CREATE TABLE finding_disposition_events(id TEXT, result_id TEXT, kind TEXT, ordinal INTEGER,
      repository_id TEXT, review_run_id TEXT, request_id TEXT, job_id TEXT, result_digest TEXT,
      occurrence_key TEXT, state TEXT, version INTEGER, previous_version INTEGER, previous_state TEXT,
      action TEXT, created_at TEXT, actor_issuer TEXT, actor_subject TEXT);
  `);
  const kind = options.issue ? "issue" : "pull_request";
  const workflowKind = options.issue ? "issue_validation" : "pr_static_build";
  const jobKind = options.issue ? "issue_triage" : "pull_request_review";
  const plan = {
    schemaVersion: "ReviewRunExecutionPlanV1",
    repository: { id: scope.repositoryId, githubRepositoryId: 1 },
    workItemId: "item-1",
    workItem: { kind, title: "Private work item title" },
    revision: { revisionKey: revision },
    activationId: "activation-1",
    authorization: { requestEpochId: "epoch-1", targetGithubUserId: 7, sequence: 1, policy },
    jobs: [] as Record<string, unknown>[],
  };
  database
    .prepare("INSERT INTO managed_repositories VALUES ('repo-1', 1, 1, 1, 7, ?)")
    .run(canonicalJson(policy));
  database
    .prepare("INSERT INTO work_items VALUES ('item-1', 'repo-1', ?, ?, 'open')")
    .run(kind, revision);
  database
    .prepare("INSERT INTO work_item_revisions VALUES ('revision-1', 'item-1', ?)")
    .run(revision);
  database.exec(
    "INSERT INTO request_epochs VALUES ('epoch-1', 'item-1', 'active', 'revision-1', 7, 1)",
  );
  database
    .prepare(
      "INSERT INTO review_runs VALUES ('run-1', 'repo-1', 'item-1', 'revision-1', ?, ?, 'activation-1', 'epoch-1', 0, ?, 'review')",
    )
    .run(revision, sha256(canonicalJson(plan)), canonicalJson(plan));
  database.prepare("INSERT INTO github_review_run_sources VALUES ('item-1', ?, 1)").run(revision);
  if (options.automatic)
    database
      .prepare(
        "INSERT INTO github_review_run_activations VALUES ('item-1', 'epoch-1', 1, ?, 'review_run', 'run-1')",
      )
      .run(revision);
  function addRequest(id: string, required = true) {
    const request = {
      requestId: id,
      workflowKind,
      target: "headless",
      required,
      profileVersion: { id: `profile-${id}`, config: { command: "PRIVATE COMMAND" } },
      prompt: { version: { id: `prompt-${id}`, content: "PRIVATE PROMPT" } },
    };
    plan.jobs.push(request);
    const json = canonicalJson(plan);
    const digest = sha256(json);
    database
      .prepare("UPDATE review_runs SET request_count = ?, plan_json = ?, plan_digest = ?")
      .run(plan.jobs.length, json, digest);
    database.prepare("UPDATE validation_job_results SET plan_digest = ?").run(digest);
    database
      .prepare("INSERT INTO review_run_requests VALUES ('run-1', ?, ?, 'headless', ?, ?, ?, ?)")
      .run(
        id,
        workflowKind,
        Number(required),
        `profile-${id}`,
        `prompt-${id}`,
        canonicalJson(request),
      );
  }
  function addJob(id: string, requestId = "request-1", activation = 1, status = "succeeded") {
    const active = ["leased", "running", "cancel_requested"].includes(status);
    const attempted = !["queued", "cancelled", "stale"].includes(status);
    database
      .prepare("INSERT INTO jobs VALUES (?, 'item-1', ?, 'epoch-1', ?, ?, ?, ?, ?, 'initial')")
      .run(
        id,
        revision,
        jobKind,
        status,
        Number(attempted),
        active ? `attempt-${id}` : null,
        executionDigest,
      );
    database
      .prepare("INSERT INTO review_run_job_links VALUES ('run-1', ?, ?, ?)")
      .run(requestId, activation, id);
    if (attempted)
      database
        .prepare("INSERT INTO run_attempts VALUES (?, ?, ?, 1, ?, 'validation', 'initial', 0)")
        .run(
          `attempt-${id}`,
          id,
          status === "succeeded"
            ? "succeeded"
            : active
              ? status === "leased"
                ? "leased"
                : "running"
              : "failed",
          resultDigest,
        );
    if (status === "succeeded")
      database
        .prepare(
          "INSERT INTO validation_job_results VALUES (?, ?, ?, 'repo-1', 'item-1', 'revision-1', ?, 'run-1', ?, ?, 'activation-1', ?, ?, ?, ?, ?, 'headless', 'ValidationJobResultV1', ?, ?, 1)",
        )
        .run(
          `result-${id}`,
          `attempt-${id}`,
          id,
          revision,
          requestId,
          activation,
          sha256(canonicalJson(plan)),
          jobKind,
          `profile-${requestId}`,
          `prompt-${requestId}`,
          workflowKind,
          resultDigest,
          executionDigest,
        );
  }
  function sourceChange(key: string, sequence: number) {
    database
      .prepare(
        "INSERT OR REPLACE INTO work_item_revisions VALUES ('current-revision', 'item-1', ?)",
      )
      .run(key);
    database.prepare("UPDATE work_items SET current_revision_key = ?").run(key);
    database.exec("UPDATE request_epochs SET current_revision_id = 'current-revision'");
    database
      .prepare("UPDATE github_review_run_sources SET current_revision_key = ?, sequence = ?")
      .run(key, sequence);
  }
  addRequest("request-1");
  if (!options.missingJob) addJob("job-1");
  return { database, addRequest, addJob, sourceChange, read: () => present(read(database)) };
}

describe("review run decision snapshots", () => {
  it("admits V2 through the independent owner binding without changing the snapshot basis", () => {
    const f = fixture();
    const before = read(f.database);
    const admitted = vi
      .spyOn(
        validationModelResultBinding,
        "validateStoredValidationModelResultBindingInTransaction",
      )
      .mockReturnValue(null);
    f.database.exec("UPDATE validation_job_results SET schema_id = 'ValidationJobResultV2'");
    expect(read(f.database)).toEqual(before);
    expect(admitted).toHaveBeenCalledWith(f.database, {
      resultId: "result-job-1",
      schemaId: "ValidationJobResultV2",
      repositoryId: scope.repositoryId,
      runId: scope.reviewRunId,
      requestId: "request-1",
      jobId: "job-1",
      runAttemptId: "attempt-job-1",
      resultDigest,
      executionDigest,
    });
  });
  it("rejects a V2 decision basis when the independent owner binding fails", () => {
    const f = fixture();
    f.database.exec("UPDATE validation_job_results SET schema_id = 'ValidationJobResultV2'");
    vi.spyOn(
      validationModelResultBinding,
      "validateStoredValidationModelResultBindingInTransaction",
    ).mockImplementation(() => {
      throw new Error("The owner invocation is invalid.");
    });
    expect(() => read(f.database)).toThrowError(
      expect.objectContaining({ code: "PLATFORM_CORRUPT" }),
    );
  });
  it("preserves the historical V1 schema while deliberately changing the current basis", () => {
    const current = fixture().read();
    const { findingDispositionDigest, ...common } = current.snapshot;
    const historical = { ...common, schemaVersion: "ReviewRunDecisionSnapshotV1" };
    expect(Value.Check(ReviewRunDecisionSnapshotV1Schema, historical)).toBe(true);
    expect(Value.Check(ReviewRunDecisionSnapshotV2Schema, historical)).toBe(false);
    expect(findingDispositionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256(canonicalJson(historical))).not.toBe(current.resultSetDigest);
  });
  it("changes the basis on every disposition version and ignores edits to old activations", () => {
    const f = fixture();
    const initial = f.read();
    const occurrence = {
      resultId: "result-job-1",
      resultDigest,
      kind: "pr_finding" as const,
      ordinal: 0,
    };
    f.database
      .prepare(`INSERT INTO finding_dispositions VALUES (?, ?, 'repo-1', 'run-1',
      'request-1', 'job-1', 'pr_finding', 0, ?, 'resolved', 1, 'event-1', ?, ?,
      'https://identity.example.test', 'reviewer')`)
      .run(
        occurrence.resultId,
        occurrence.resultDigest,
        findingOccurrenceKey(occurrence),
        "2026-09-07T00:00:00.000Z",
        "2026-09-07T00:00:00.000Z",
      );
    const record = (previousState: string, action: string) =>
      f.database
        .prepare(`INSERT INTO finding_disposition_events
      SELECT last_event_id, result_id, kind, ordinal, repository_id, review_run_id, request_id,
      job_id, result_digest, occurrence_key, state, version, version - 1, ?, ?, updated_at,
      updated_by_issuer, updated_by_subject FROM finding_dispositions`)
        .run(previousState, action);
    record("open", "resolve");
    const resolved = f.read();
    expect(resolved.resultSetDigest).not.toBe(initial.resultSetDigest);
    expect(resolved.snapshot.findingDispositionDigest).not.toBe(
      initial.snapshot.findingDispositionDigest,
    );
    f.database.exec(
      "UPDATE finding_dispositions SET state = 'open', version = 2, last_event_id = 'event-2'",
    );
    record("resolved", "reopen");
    const reopened = f.read();
    expect(reopened.resultSetDigest).not.toBe(initial.resultSetDigest);
    expect(reopened.resultSetDigest).not.toBe(resolved.resultSetDigest);
    f.addJob("job-2", "request-1", 2, "queued");
    const latest = f.read();
    f.database.exec(
      "UPDATE finding_dispositions SET state = 'resolved', version = 3, last_event_id = 'event-3'",
    );
    record("open", "resolve");
    expect(f.read().resultSetDigest).toBe(latest.resultSetDigest);
  });
  it("requires the caller transaction and keeps ownership on success or failure", () => {
    const f = fixture();
    expect(() => readReviewRunDecisionSnapshotInTransaction(f.database, scope)).toThrow(
      /existing database transaction/,
    );
    f.database.exec("BEGIN IMMEDIATE");
    expect(readReviewRunDecisionSnapshotInTransaction(f.database, scope)?.sourceCurrent).toBe(true);
    expect(f.database.isTransaction).toBe(true);
    expect(() =>
      readReviewRunDecisionSnapshotInTransaction(f.database, { ...scope, repositoryId: "bad id" }),
    ).toThrow(/scope is invalid/);
    expect(f.database.isTransaction).toBe(true);
    f.database.exec("ROLLBACK");
  });

  it("returns null for missing or cross-repository runs", () => {
    const f = fixture();
    expect(read(f.database, { ...scope, repositoryId: "repo-2" })).toBeNull();
    expect(read(f.database, { ...scope, reviewRunId: "missing" })).toBeNull();
  });

  it("binds all planned lanes including optional, missing and queued requests in stable order", () => {
    const f = fixture();
    f.addRequest("optional-z", false);
    f.addRequest("optional-a", false);
    f.addJob("job-optional", "optional-z", 1, "queued");
    const snapshot = f.read();
    expect(snapshot.sourceCurrent).toBe(true);
    expect(Value.Check(ReviewRunDecisionSnapshotV2Schema, snapshot.snapshot)).toBe(true);
    expect(Value.Check(ReviewRunDecisionSnapshotV1Schema, snapshot.snapshot)).toBe(false);
    expect(snapshot.snapshot).toMatchObject({
      schemaVersion: "ReviewRunDecisionSnapshotV2",
      ...scope,
      workItemId: "item-1",
      workItemKind: "pull_request",
      revisionKey: revision,
      itemState: "open",
      epochStatus: "active",
      repositoryEnabled: true,
      repositoryVersion: 1,
      authorizationPolicyCurrent: true,
      currentSourceSequence: 1,
      automaticSourceSequence: null,
    });
    expect(
      snapshot.snapshot.requests.map((request) => [
        request.requestId,
        request.required,
        request.latestJob?.status ?? null,
      ]),
    ).toEqual([
      ["optional-a", false, null],
      ["optional-z", false, "queued"],
      ["request-1", true, "succeeded"],
    ]);
    expect(snapshot.snapshot.requests[2]?.latestJob).toMatchObject({
      jobId: "job-1",
      activationNumber: 1,
      latestAttempt: { id: "attempt-job-1", number: 1, status: "succeeded" },
      result: { id: "result-job-1", digest: resultDigest, runAttemptId: "attempt-job-1" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
    expect(JSON.stringify(snapshot)).not.toContain("Private work item title");
    expect(snapshot.resultSetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.read().resultSetDigest).toBe(snapshot.resultSetDigest);
  });

  it.each([true, false])(
    "invalidates a queued rerun immediately for required=%s without using the older result",
    (required) => {
      const f = fixture({ missingJob: true });
      f.addRequest("request-2", required);
      f.addJob("prior", "request-2");
      const before = f.read();
      f.addJob("new", "request-2", 2, "queued");
      const after = f.read();
      expect(after.resultSetDigest).not.toBe(before.resultSetDigest);
      expect(after.snapshot.requests[1]?.latestJob).toEqual({
        jobId: "new",
        activationNumber: 2,
        status: "queued",
        attemptCount: 0,
        executionDigest,
        latestAttempt: null,
        result: null,
      });
      expect(JSON.stringify(after.snapshot)).not.toContain("result-prior");
    },
  );

  it("changes from missing to queued and retains failed attempts with their pointer cleared", () => {
    const f = fixture({ missingJob: true });
    const missing = f.read();
    f.addJob("job-1", "request-1", 1, "retry_waiting");
    const failed = f.read();
    expect(failed.resultSetDigest).not.toBe(missing.resultSetDigest);
    expect(failed.snapshot.requests[0]?.latestJob).toMatchObject({
      status: "retry_waiting",
      latestAttempt: { id: "attempt-job-1", number: 1, status: "failed" },
      result: null,
    });
    f.database.exec(
      "UPDATE jobs SET attempt_count = 2, status = 'leased', current_run_attempt_id = 'attempt-2'; INSERT INTO run_attempts VALUES ('attempt-2', 'job-1', 'leased', 2, NULL, 'leased', 'later', 0)",
    );
    expect(f.read().resultSetDigest).not.toBe(failed.resultSetDigest);
    expect(f.read().snapshot.requests[0]?.latestJob?.latestAttempt).toEqual({
      id: "attempt-2",
      number: 2,
      status: "leased",
    });
  });

  it.each(["cancelled", "stale"])("retains unattempted %s jobs", (status) => {
    const f = fixture({ missingJob: true });
    f.addJob("job-1", "request-1", 1, status);
    expect(f.read().snapshot.requests[0]?.latestJob).toMatchObject({
      status,
      latestAttempt: null,
      result: null,
    });
  });

  it("does not digest heartbeat, phase, progress, timestamps or evidence cache availability", () => {
    const f = fixture({ missingJob: true });
    f.addJob("job-1", "request-1", 1, "running");
    const before = f.read().resultSetDigest;
    f.database.exec(
      "UPDATE jobs SET updated_at = 'later'; UPDATE run_attempts SET phase = 'uploading', last_heartbeat_at = 'later', progress_sequence = 100",
    );
    expect(f.read().resultSetDigest).toBe(before);
    const complete = fixture();
    const stable = complete.read().resultSetDigest;
    complete.database.exec("UPDATE validation_job_results SET evidence_complete = 0");
    expect(complete.read().resultSetDigest).toBe(stable);
  });

  it.each([true, false])(
    "prevents source A-B-A from reviving old decisions for automatic=%s",
    (automatic) => {
      const f = fixture({ automatic });
      const original = f.read();
      f.sourceChange("d".repeat(64), 2);
      expect(f.read().sourceCurrent).toBe(false);
      f.sourceChange(revision, 3);
      const returned = f.read();
      expect(returned.resultSetDigest).not.toBe(original.resultSetDigest);
      expect(returned.snapshot.currentSourceSequence).toBe(3);
      expect(returned.sourceCurrent).toBe(!automatic);
    },
  );

  it("keeps Issue source identity separate from its tested commit through the frozen plan digest", () => {
    const f = fixture({ issue: true });
    expect(f.read().snapshot.workItemKind).toBe("issue");
    expect(f.read().sourceCurrent).toBe(true);
    f.sourceChange("d".repeat(64), 2);
    expect(f.read().sourceCurrent).toBe(false);
  });

  it.each([
    "DELETE FROM github_review_run_sources",
    "UPDATE github_review_run_sources SET current_revision_key = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'",
    "INSERT INTO work_item_revisions VALUES ('different', 'item-1', 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'); UPDATE request_epochs SET current_revision_id = 'different'",
  ])("fails source authority closed without destroying historical identity: %s", (mutation) => {
    const f = fixture();
    f.database.exec(mutation);
    expect(f.read().sourceCurrent).toBe(false);
  });

  it.each([
    ["UPDATE work_items SET state = 'closed'", "itemState", "closed"],
    ["UPDATE request_epochs SET status = 'closed'", "epochStatus", "closed"],
    ["UPDATE managed_repositories SET enabled = 0", "repositoryEnabled", false],
    ["UPDATE managed_repositories SET version = 2", "repositoryVersion", 2],
    [
      "UPDATE managed_repositories SET reviewer_github_user_id = 8",
      "authorizationPolicyCurrent",
      false,
    ],
    [
      "UPDATE managed_repositories SET github_repository_id = 8",
      "authorizationPolicyCurrent",
      false,
    ],
    ["UPDATE request_epochs SET target_github_user_id = 8", "authorizationPolicyCurrent", false],
    ["UPDATE request_epochs SET ordinal = 2", "authorizationPolicyCurrent", false],
    [
      "UPDATE managed_repositories SET authorization_policy_json = NULL",
      "authorizationPolicyCurrent",
      false,
    ],
    [
      "UPDATE managed_repositories SET authorization_policy_json = '{\"policyVersion\":2}'",
      "authorizationPolicyCurrent",
      false,
    ],
  ])(
    "binds current authority facts while retaining historical records: %s",
    (mutation, field, value) => {
      const f = fixture();
      const before = f.read().resultSetDigest;
      f.database.exec(mutation as string);
      const after = f.read();
      expect(after.resultSetDigest).not.toBe(before);
      expect(after.snapshot).toHaveProperty(field as string, value);
    },
  );

  it("keeps a new repository version distinct even when the policy returns to its old value", () => {
    const f = fixture();
    const original = f.read().resultSetDigest;
    f.database.exec("UPDATE managed_repositories SET enabled = 0, version = 2");
    f.database.exec("UPDATE managed_repositories SET enabled = 1, version = 3");
    expect(f.read().resultSetDigest).not.toBe(original);
  });

  it.each([
    "DELETE FROM managed_repositories",
    "DELETE FROM work_items",
    "DELETE FROM request_epochs",
    "DELETE FROM work_item_revisions",
    "UPDATE work_items SET resource_kind = 'issue'",
    "UPDATE work_items SET repository_id = 'foreign'",
    "UPDATE request_epochs SET work_item_id = 'foreign'",
    "UPDATE review_runs SET plan_json = '{}'",
    "UPDATE review_runs SET plan_json = 'invalid'",
    "UPDATE review_runs SET plan_digest = 'bad'",
    "UPDATE review_runs SET activation_id = 'bad id'",
    "UPDATE review_runs SET request_count = 2",
    "UPDATE managed_repositories SET enabled = 2",
    "UPDATE managed_repositories SET version = 9007199254740992",
    "UPDATE github_review_run_sources SET sequence = 0",
    "UPDATE github_review_run_sources SET sequence = NULL",
    "UPDATE github_review_run_sources SET sequence = NULL, current_revision_key = NULL",
    "UPDATE review_run_requests SET required = 0",
    "UPDATE review_run_requests SET request_json = '{}'",
    "INSERT INTO review_run_requests SELECT * FROM review_run_requests",
    "DELETE FROM jobs",
    "UPDATE review_run_job_links SET job_id = NULL",
    "UPDATE jobs SET work_item_id = 'foreign'",
    "UPDATE jobs SET request_epoch_id = 'foreign'",
    "UPDATE jobs SET resource_revision = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'",
    "UPDATE jobs SET job_kind = 'issue_triage'",
    "UPDATE jobs SET attempt_count = 2",
    "UPDATE jobs SET attempt_count = 0",
    "UPDATE jobs SET status = 'unknown'",
    "UPDATE jobs SET execution_digest = 'bad'",
    "UPDATE jobs SET current_run_attempt_id = 'foreign'",
    "DELETE FROM run_attempts",
    "UPDATE run_attempts SET job_id = 'foreign'",
    "UPDATE run_attempts SET attempt_number = 2",
    "UPDATE run_attempts SET result_digest = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'",
    "UPDATE run_attempts SET status = 'failed'",
    "UPDATE review_run_job_links SET activation_number = 2",
    "INSERT INTO review_run_job_links SELECT * FROM review_run_job_links",
    "DELETE FROM validation_job_results",
    ...[
      "repository_id",
      "work_item_id",
      "revision_id",
      "review_run_id",
      "request_id",
      "activation_id",
      "profile_version_id",
      "prompt_version_id",
      "run_attempt_id",
    ].map((column) => `UPDATE validation_job_results SET ${column} = 'foreign'`),
    "UPDATE validation_job_results SET workflow_kind = 'issue_triage'",
    "UPDATE validation_job_results SET target = 'web'",
    "UPDATE validation_job_results SET job_kind = 'issue_triage'",
    "UPDATE validation_job_results SET schema_id = 'unknown'",
    ...["resource_revision", "plan_digest", "result_digest", "execution_template_sha256"].map(
      (column) =>
        `UPDATE validation_job_results SET ${column} = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'`,
    ),
  ])("rejects malformed fields or substituted authoritative relations: %s", (mutation) => {
    const f = fixture();
    f.database.exec(mutation);
    expect(() => f.read()).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
  });

  it.each([
    "UPDATE github_review_run_activations SET source_sequence = NULL",
    "UPDATE github_review_run_activations SET source_sequence = 0",
    "UPDATE github_review_run_activations SET mode = 'legacy'",
    "UPDATE github_review_run_activations SET work_item_id = 'foreign'",
    "UPDATE github_review_run_activations SET request_epoch_id = 'foreign'",
    "UPDATE github_review_run_activations SET revision_key = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'",
    "INSERT INTO github_review_run_activations SELECT * FROM github_review_run_activations",
  ])(
    "rejects a substituted automatic activation instead of treating it as a manual run: %s",
    (mutation) => {
      const f = fixture({ automatic: true });
      f.database.exec(mutation);
      expect(() => f.read()).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
    },
  );

  it("compiles the snapshot projection against all production migrations", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    runMigrations(database, fileURLToPath(new URL("../../../../migrations", import.meta.url)));
    expect(read(database)).toBeNull();
  });

  it("tracks real queued, leased, running, completed and rerun identities without upstream writes", async () => {
    const fixture = await createEvidenceControlPlaneFixture(1);
    realFixtures.push(fixture);
    const capture = () => present(fixture.read((reader) => read(reader, fixture.query)));
    const queued = capture();
    expect(queued.sourceCurrent).toBe(true);
    expect(queued.snapshot.requests[0]?.latestJob?.status).toBe("queued");
    const envelope = present((await fixture.claimAll())[0]);
    const leased = capture();
    expect(leased.resultSetDigest).not.toBe(queued.resultSetDigest);
    expect(leased.snapshot.requests[0]?.latestJob?.latestAttempt?.id).toBe(
      envelope.lease.runAttemptId,
    );
    await fixture.heartbeat(envelope, 1);
    const running = capture();
    await fixture.heartbeat(envelope, 2);
    expect(capture().resultSetDigest).toBe(running.resultSetDigest);
    await fixture.client.request("completeLease", completion(envelope, []));
    const succeeded = capture();
    expect(succeeded.resultSetDigest).not.toBe(running.resultSetDigest);
    expect(succeeded.snapshot.requests[0]?.latestJob).toMatchObject({
      status: "succeeded",
      latestAttempt: { id: envelope.lease.runAttemptId, status: "succeeded" },
      result: { runAttemptId: envelope.lease.runAttemptId },
    });
    await fixture.client.request("rerunValidationRequest", {
      ...fixture.query,
      requestId: envelope.validation.requestId,
      activationId: "snapshot-rerun",
      actor: { issuer: "https://identity.example.test", subject: "snapshot-operator" },
    });
    const rerun = capture();
    expect(rerun.resultSetDigest).not.toBe(succeeded.resultSetDigest);
    expect(rerun.snapshot.requests[0]?.latestJob).toMatchObject({
      status: "queued",
      activationNumber: 2,
      result: null,
      latestAttempt: null,
    });
  });
});
