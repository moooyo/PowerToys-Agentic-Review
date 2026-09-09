import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
  ValidationJobResult,
  ValidationJobResultV1,
  ValidationJobResultV2,
} from "@agentic-review/codex";
import type {
  DashboardReviewRunDetail,
  DashboardReviewRunResult,
  DashboardValidationPolicy,
  EvidenceAssetKind,
  FindingDispositionState,
  FindingOccurrenceKind,
  IssueReproductionConclusion,
  UiScenarioExecutionEvidenceV1,
  UiScenarioStep,
  ValidationCheckResult,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { getSystemSnapshot } from "./dashboard-queries.js";
import * as evidenceAssetAccess from "./evidence-assets.js";
import { closeEvidenceAssetStorage, type EvidenceStorageOptions } from "./evidence-assets.js";
import { findingOccurrenceKey } from "./finding-disposition-projection.js";
import { observeGitHubReviewRunSourceInTransaction } from "./github-review-runs.js";
import { runMigrations } from "./migrations.js";
import {
  handleReviewRunQuery,
  handleVerifiedReviewRunQuery,
  isReviewRunQueryOperation,
  type ReviewRunQuery,
  type ReviewRunQueryOperation,
  type ReviewRunQueryOperationMap,
  readVerifiedReviewRunDetailInTransaction,
  type VerifiedReviewRunEvidenceFacts,
} from "./review-run-queries.js";
import type { ValidationEvidenceReferenceScope } from "./validation-results.js";

const now = "2026-09-07T00:00:00.000Z";
const revision = "a".repeat(64);
const planDigest = "b".repeat(64);
const policy = { policyVersion: 1 };
const databases: DatabaseSync[] = [];
const temporaryDirectories: string[] = [];
function itemAt<T>(items: T[], index = 0): T {
  const item = items[index];
  if (item === undefined) throw new Error("The expected fixture item is missing.");
  return item;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) {
    closeEvidenceAssetStorage(database);
    database.close();
  }
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function verifiedQuery<K extends ReviewRunQueryOperation>(
  database: DatabaseSync,
  operation: K,
  input: ReviewRunQueryOperationMap[K]["input"],
  facts?: VerifiedReviewRunEvidenceFacts,
): ReviewRunQueryOperationMap[K]["output"] {
  return handleVerifiedReviewRunQuery(
    database,
    { operation, input } as ReviewRunQuery,
    facts,
  ) as ReviewRunQueryOperationMap[K]["output"];
}

function evidenceFacts(
  profiles: VerifiedReviewRunEvidenceFacts["profiles"] = [
    { requestId: "request-1", jobId: "job-1", status: "verified" },
  ],
) {
  return {
    profiles,
    assertCurrent: vi.fn((): void => undefined),
    admittedEvidenceReferences: vi.fn((_scope: ValidationEvidenceReferenceScope) => true),
    admittedScenarioEvidence: vi.fn((_scope: ValidationEvidenceReferenceScope) => true),
  } satisfies VerifiedReviewRunEvidenceFacts;
}

function forbidSynchronousEvidenceAccess() {
  const references = vi
    .spyOn(evidenceAssetAccess, "finalizedEvidenceReferences")
    .mockImplementation(() => {
      throw new Error("Synchronous evidence verification is forbidden.");
    });
  const reads = vi
    .spyOn(evidenceAssetAccess, "handleEvidenceAssetRequest")
    .mockImplementation(() => {
      throw new Error("Synchronous evidence file reads are forbidden.");
    });
  return { references, reads };
}

describe("verified detail inside a decision transaction", () => {
  const input = { repositoryId: "repo-1", reviewRunId: "run-1" };
  it("requires a transaction without consuming prepared facts outside it", () => {
    const f = fixture();
    const facts = evidenceFacts();
    expect(() => readVerifiedReviewRunDetailInTransaction(f.database, input, facts)).toThrow(
      /existing database transaction/,
    );
    expect(facts.assertCurrent).not.toHaveBeenCalled();
  });
  it("consumes facts in the caller transaction and leaves its writes uncommitted", () => {
    const f = fixture();
    const facts = evidenceFacts();
    forbidSynchronousEvidenceAccess();
    f.database.exec("BEGIN IMMEDIATE; UPDATE managed_repositories SET enabled = 0");
    const detail = readVerifiedReviewRunDetailInTransaction(f.database, input, facts);
    expect(facts.assertCurrent).toHaveBeenCalledOnce();
    expect(detail?.policy.eligible).toBe(false);
    expect(f.database.isTransaction).toBe(true);
    f.database.exec("ROLLBACK");
    expect(f.read().policy.eligible).toBe(true);
  });
  it("propagates a revoked or stale proof before validating input and leaves rollback to the caller", () => {
    const f = fixture();
    const facts = evidenceFacts();
    const error = new Error("The operator was revoked during verification.");
    facts.assertCurrent.mockImplementation(() => {
      throw error;
    });
    f.database.exec("BEGIN IMMEDIATE; UPDATE managed_repositories SET enabled = 0");
    expect(() =>
      readVerifiedReviewRunDetailInTransaction(f.database, { ...input, reviewRunId: "" }, facts),
    ).toThrow(error);
    expect(f.database.isTransaction).toBe(true);
    expect(f.database.prepare("SELECT enabled FROM managed_repositories").get()?.enabled).toBe(0);
    f.database.exec("ROLLBACK");
  });
  it("uses the newest queued rerun and returns no approval from missing prepared evidence", () => {
    const f = fixture();
    f.addJob("job-rerun", 2, "queued");
    f.database.exec("BEGIN");
    const detail = readVerifiedReviewRunDetailInTransaction(f.database, input);
    expect(detail?.policy.eligible).toBe(false);
    expect(detail?.requests[0]?.latestJob?.jobId).toBe("job-rerun");
    expect(detail?.requests[0]?.latestResult).toBeNull();
    expect(f.database.isTransaction).toBe(true);
    f.database.exec("ROLLBACK");
  });
  it("returns null for a foreign scope while retaining transaction ownership", () => {
    const f = fixture();
    f.database.exec("BEGIN");
    expect(
      readVerifiedReviewRunDetailInTransaction(f.database, { ...input, repositoryId: "foreign" }),
    ).toBeNull();
    expect(f.database.isTransaction).toBe(true);
    f.database.exec("ROLLBACK");
  });
  it("captures every policy reason for audit while preserving the bounded display preview", () => {
    const f = fixture({ missingJob: true });
    const blockers = Array.from({ length: 140 }, (_, index) => ({
      requestId: "request-1",
      reason: `Required prerequisite ${index + 1} is missing.`,
    }));
    f.database
      .prepare("UPDATE review_runs SET required_request_blockers_json = ?")
      .run(JSON.stringify(blockers));
    const capture = vi.fn((policy: DashboardValidationPolicy) => {
      expect(f.database.isTransaction).toBe(true);
      expect(policy.reasonsTruncated).toBe(false);
      expect(policy.reasons).toHaveLength(policy.reasonCount);
    });
    f.database.exec("BEGIN IMMEDIATE");
    const detail = readVerifiedReviewRunDetailInTransaction(f.database, input, undefined, capture);
    expect(capture).toHaveBeenCalledOnce();
    const policy = capture.mock.calls[0]?.[0];
    expect(policy?.reasonCount).toBeGreaterThan(128);
    expect(policy?.reasons).toContainEqual(
      expect.objectContaining({ reason: blockers[139]?.reason }),
    );
    expect(detail?.policy.reasons).toHaveLength(128);
    expect(detail?.policy.reasonsTruncated).toBe(true);
    expect(detail?.policy.reasonCount).toBe(policy?.reasonCount);
    policy?.reasons.splice(0);
    expect(detail?.policy.reasons).toHaveLength(128);
    expect(f.database.isTransaction).toBe(true);
    f.database.exec("ROLLBACK");
  });
  it("propagates audit capture failures and leaves the caller transaction intact", () => {
    const f = fixture();
    f.database.exec("BEGIN IMMEDIATE");
    expect(() =>
      readVerifiedReviewRunDetailInTransaction(f.database, input, undefined, () => {
        throw new Error("Audit snapshot rejected.");
      }),
    ).toThrow("Audit snapshot rejected.");
    expect(f.database.isTransaction).toBe(true);
    f.database.exec("ROLLBACK");
  });
});

function query<K extends ReviewRunQueryOperation>(
  database: DatabaseSync,
  operation: K,
  input: ReviewRunQueryOperationMap[K]["input"],
  evidenceStorage?: EvidenceStorageOptions,
): ReviewRunQueryOperationMap[K]["output"] {
  return handleReviewRunQuery(
    database,
    {
      operation,
      input,
    } as ReviewRunQuery,
    evidenceStorage,
  ) as ReviewRunQueryOperationMap[K]["output"];
}
function check(
  id = "profile-1:build",
  kind: ValidationCheckResult["kind"] = "build",
): ValidationCheckResult {
  return {
    id,
    name: "Check the submitted revision",
    kind,
    required: true,
    source: "runner",
    outcome: "passed",
    summary: "The assertion passed.",
    expected: null,
    actual: null,
    evidenceIds: [],
  };
}
function result(): ValidationJobResultV1 {
  return {
    schemaVersion: "ValidationJobResultV1",
    report: {
      schemaVersion: "ValidationReportV1",
      source: "worker",
      workItemKind: "pull_request",
      summary: "The original source compiled.",
      sourceState: "original",
      checks: [check()],
    },
    execution: {
      blockers: [],
      diagnostics: [
        {
          stepId: "profile-1:build",
          phase: "build",
          outcome: "passed",
          exitCode: 0,
          summary: "The command completed.",
        },
      ],
      cleanupState: "not_needed",
    },
    modelReview: {
      state: "completed",
      result: {
        schemaVersion: "PrReviewPlanV2",
        summary: "No blocking issues found.",
        assessment: "approve",
        findings: [],
        requestedRecipeIds: [],
        verification: {
          status: "not_run",
          summary: "Runner checks are recorded separately.",
          commands: [],
        },
        executionEvidence: {
          schemaVersion: "ReviewExecutionEvidenceV1",
          source: "worker",
          commandCapture: "complete",
          commands: [],
          worktree: { status: "clean", source: "git_status" },
        },
      },
    },
  };
}

// A deliberately writable read-model fixture permits corrupt and historical states that write-side
// triggers reject. The empty production-schema test below also compiles the SQL against migrations.
function fixture(options: { issue?: boolean; missingJob?: boolean } = {}) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`CREATE TABLE managed_repositories(id TEXT PRIMARY KEY, full_name TEXT, enabled INTEGER, reviewer_github_user_id INTEGER, authorization_policy_json TEXT);
    CREATE TABLE work_items(id TEXT PRIMARY KEY, repository_id TEXT, resource_kind TEXT, current_revision_key TEXT, state TEXT);
    CREATE TABLE request_epochs(id TEXT PRIMARY KEY, work_item_id TEXT, status TEXT);
    CREATE TABLE review_runs(id TEXT PRIMARY KEY, repository_id TEXT, work_item_id TEXT, revision_key TEXT, plan_digest TEXT, activation_id TEXT, request_epoch_id TEXT, created_at TEXT, request_count INTEGER, plan_json TEXT, readiness_json TEXT, required_request_blockers_json TEXT, revision_id TEXT DEFAULT 'revision-1', purpose TEXT DEFAULT 'review');
    CREATE TABLE review_run_requests(review_run_id TEXT, request_id TEXT, workflow_kind TEXT, target TEXT, required INTEGER, profile_version_id TEXT, prompt_version_id TEXT, request_json TEXT);
    CREATE TABLE review_run_job_links(review_run_id TEXT, request_id TEXT, activation_number INTEGER, job_id TEXT);
    CREATE TABLE validation_dispatch_checks(repository_id TEXT, review_run_id TEXT, request_id TEXT, pending INTEGER, checked_at TEXT, blockers_json TEXT);
    CREATE TABLE github_review_run_sources(work_item_id TEXT PRIMARY KEY, current_revision_key TEXT, sequence INTEGER, activated_at TEXT);
    CREATE TABLE github_review_run_activations(work_item_id TEXT, request_epoch_id TEXT, source_sequence INTEGER, revision_key TEXT, mode TEXT, review_run_id TEXT UNIQUE);
    CREATE TABLE jobs(id TEXT PRIMARY KEY, work_item_id TEXT, resource_revision TEXT, request_epoch_id TEXT, status TEXT, attempt_count INTEGER, current_run_attempt_id TEXT, execution_digest TEXT, created_at TEXT, started_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT, job_kind TEXT DEFAULT '${options.issue ? "issue_triage" : "pull_request_review"}');
    CREATE TABLE job_admission(job_id TEXT PRIMARY KEY, state TEXT, attempt_base INTEGER, episode_sequence INTEGER,
      requested_at TEXT, timestamp_basis TEXT, admitted_at TEXT, bucket_key TEXT, github_repository_id INTEGER,
      ownership_state TEXT, last_checked_at TEXT, last_inspection_sequence INTEGER, blockers_json TEXT);
    CREATE TABLE run_attempts(id TEXT PRIMARY KEY, job_id TEXT, phase TEXT, status TEXT, attempt_number INTEGER, result_digest TEXT, result_json TEXT);
    CREATE TABLE validation_job_results(id TEXT PRIMARY KEY, run_attempt_id TEXT, job_id TEXT, repository_id TEXT, work_item_id TEXT, resource_revision TEXT, review_run_id TEXT, request_id TEXT, job_activation INTEGER, activation_id TEXT, plan_digest TEXT, profile_version_id TEXT, prompt_version_id TEXT, workflow_kind TEXT, target TEXT, schema_id TEXT, result_digest TEXT, result_json TEXT, execution_template_sha256 TEXT, evidence_complete INTEGER, created_at TEXT, revision_id TEXT DEFAULT 'revision-1', job_kind TEXT DEFAULT '${options.issue ? "issue_triage" : "pull_request_review"}');
    CREATE TABLE finding_dispositions(result_id TEXT, result_digest TEXT, repository_id TEXT,
      review_run_id TEXT, request_id TEXT, job_id TEXT, kind TEXT, ordinal INTEGER,
      occurrence_key TEXT, state TEXT, version INTEGER, last_event_id TEXT, created_at TEXT,
      updated_at TEXT, updated_by_issuer TEXT, updated_by_subject TEXT);
    CREATE TABLE finding_disposition_events(id TEXT, result_id TEXT, kind TEXT, ordinal INTEGER,
      repository_id TEXT, review_run_id TEXT, request_id TEXT, job_id TEXT, result_digest TEXT,
      occurrence_key TEXT, state TEXT, version INTEGER, previous_version INTEGER, previous_state TEXT,
      action TEXT, created_at TEXT, actor_issuer TEXT, actor_subject TEXT);
    CREATE TABLE evidence_assets(id TEXT PRIMARY KEY, repository_id TEXT, review_run_id TEXT, request_id TEXT, job_id TEXT, run_attempt_id TEXT, profile_version_id TEXT, revision_key TEXT, plan_digest TEXT, check_id TEXT, state TEXT, committed_bytes INTEGER, size_bytes INTEGER, kind TEXT);`);
  const plan = {
    workItem: { number: 7, title: "Review the settings panel" },
    requiredCheckIds: ["profile-1:build"],
    testedSourceRevision: { kind: "commit", headSha: "a".repeat(40) },
    authorization: { targetGithubUserId: 7, policy },
    prompt: "PRIVATE PROMPT BODY",
  };
  const request = {
    requiredCheckIds: ["profile-1:build"],
    profileVersion: {
      id: "profile-1",
      profileId: "profile",
      name: "Compile",
      version: 1,
      configSha256: planDigest,
      config: {
        setup: [],
        build: [{ id: "build", required: true, command: "PRIVATE COMMAND" }],
        launch: [],
        cleanup: [],
      },
    },
    prompt: {
      version: {
        id: "prompt-1",
        templateId: "prompt",
        version: 1,
        contentSha256: planDigest,
        content: "PRIVATE PROMPT BODY",
      },
    },
  };
  database
    .prepare("INSERT INTO managed_repositories VALUES (?, ?, 1, 7, ?)")
    .run("repo-1", "example/project", JSON.stringify(policy));
  database
    .prepare("INSERT INTO work_items VALUES (?, ?, ?, ?, 'open')")
    .run("item-1", "repo-1", options.issue ? "issue" : "pull_request", revision);
  database.prepare("INSERT INTO request_epochs VALUES ('epoch-1', 'item-1', 'active')").run();
  database
    .prepare(
      "INSERT INTO review_runs (id, repository_id, work_item_id, revision_key, plan_digest, activation_id, request_epoch_id, created_at, request_count, plan_json, readiness_json, required_request_blockers_json) VALUES ('run-1', 'repo-1', 'item-1', ?, ?, 'activation-1', 'epoch-1', ?, 1, ?, ?, '[]')",
    )
    .run(
      revision,
      planDigest,
      now,
      JSON.stringify(plan),
      JSON.stringify([{ requestId: "request-1", state: "ready", reasons: [] }]),
    );
  database
    .prepare(
      "INSERT INTO review_run_requests VALUES ('run-1', 'request-1', ?, 'headless', 1, 'profile-1', 'prompt-1', ?)",
    )
    .run(options.issue ? "issue_validation" : "pr_static_build", JSON.stringify(request));
  function save(value: ValidationJobResult, jobId = "job-1", activation = 1): void {
    const json = canonicalJson(value);
    const digest = sha256(json);
    database
      .prepare(
        "INSERT OR REPLACE INTO run_attempts VALUES (?, ?, 'validation', 'succeeded', 1, ?, ?)",
      )
      .run(`attempt-${jobId}`, jobId, digest, json);
    database
      .prepare(
        "INSERT OR REPLACE INTO validation_job_results (id, run_attempt_id, job_id, repository_id, work_item_id, resource_revision, review_run_id, request_id, job_activation, activation_id, plan_digest, profile_version_id, prompt_version_id, workflow_kind, target, schema_id, result_digest, result_json, execution_template_sha256, evidence_complete, created_at) VALUES (?, ?, ?, 'repo-1', 'item-1', ?, 'run-1', 'request-1', ?, 'activation-1', ?, 'profile-1', 'prompt-1', ?, 'headless', ?, ?, ?, ?, 1, ?)",
      )
      .run(
        `result-${jobId}`,
        `attempt-${jobId}`,
        jobId,
        revision,
        activation,
        planDigest,
        options.issue ? "issue_validation" : "pr_static_build",
        value.schemaVersion,
        digest,
        json,
        planDigest,
        now,
      );
  }
  function addJob(
    jobId: string,
    activation: number,
    status = "succeeded",
    value?: ValidationJobResultV1,
  ): void {
    database
      .prepare(
        "INSERT INTO jobs (id, work_item_id, resource_revision, request_epoch_id, status, attempt_count, current_run_attempt_id, execution_digest, created_at, started_at, completed_at, failure_code, failure_message) VALUES (?, 'item-1', ?, 'epoch-1', ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)",
      )
      .run(
        jobId,
        revision,
        status,
        status === "queued" ? 0 : 1,
        planDigest,
        now,
        status === "queued" ? null : now,
        status === "succeeded" ? now : null,
      );
    database
      .prepare(`INSERT INTO job_admission (job_id, state, attempt_base, episode_sequence, requested_at,
        timestamp_basis, admitted_at, bucket_key, github_repository_id, ownership_state,
        last_checked_at, last_inspection_sequence, blockers_json)
        VALUES (?, 'admitted', ?, ?, ?, 'recorded', ?, 'unscoped', NULL, 'unscoped', NULL, 0, '[]')`)
      .run(jobId, status === "retry_waiting" ? 1 : 0, activation, now, now);
    database
      .prepare("INSERT INTO review_run_job_links VALUES ('run-1', 'request-1', ?, ?)")
      .run(activation, jobId);
    if (value !== undefined) save(value, jobId, activation);
  }
  if (!options.missingJob) addJob("job-1", 1, "succeeded", result());
  function read(evidenceStorage?: EvidenceStorageOptions): DashboardReviewRunDetail {
    const detail = query(
      database,
      "getDashboardReviewRun",
      {
        repositoryId: "repo-1",
        reviewRunId: "run-1",
      },
      evidenceStorage,
    );
    if (detail === null) throw new Error("Expected a fixture run.");
    return detail;
  }
  function readResult(evidenceStorage?: EvidenceStorageOptions): DashboardReviewRunResult | null {
    return query(
      database,
      "getDashboardReviewRunJobResult",
      {
        repositoryId: "repo-1",
        reviewRunId: "run-1",
        requestId: "request-1",
        jobId: "job-1",
      },
      evidenceStorage,
    );
  }
  function requestUpdate(update: (value: typeof request) => void) {
    update(request);
    database
      .prepare("UPDATE review_run_requests SET request_json = ?")
      .run(JSON.stringify(request));
  }
  return { database, read, readResult, save, addJob, requestUpdate, request, plan };
}

describe("versioned validation envelope reads", () => {
  it.each(["not_requested", "failed"] as const)(
    "reads a V2 %s result without rewriting its original bytes or result digest",
    (state) => {
      const f = fixture();
      const original = result();
      const value: ValidationJobResultV2 = {
        ...original,
        schemaVersion: "ValidationJobResultV2",
        modelReview:
          state === "not_requested"
            ? { state }
            : { state, code: "MODEL_FAILED", message: "The synthetic model did not complete." },
      };
      f.save(value);
      const bytes = canonicalJson(value);
      const full = f.readResult();
      expect(full).toMatchObject({
        resultDigest: sha256(bytes),
        report: value.report,
        execution: value.execution,
        modelReview: { state },
      });
      expect(f.read().requests[0]?.latestResult).toMatchObject({
        resultDigest: sha256(bytes),
        modelReviewState: state,
      });
      expect(
        f.database
          .prepare(
            "SELECT schema_id, result_json FROM validation_job_results WHERE id = 'result-job-1'",
          )
          .get(),
      ).toEqual({ schema_id: "ValidationJobResultV2", result_json: bytes });
      expect(
        f.database.prepare("SELECT result_json FROM run_attempts WHERE id = 'attempt-job-1'").get(),
      ).toEqual({ result_json: bytes });
      // Matching metadata and digest columns do not excuse different terminal attempt bytes.
      f.database
        .prepare("UPDATE run_attempts SET result_json = ? WHERE id = 'attempt-job-1'")
        .run("{}");
      expect(() => f.read()).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
    },
  );
});

function disposition(
  database: DatabaseSync,
  state: FindingDispositionState,
  ordinal = 0,
  kind: FindingOccurrenceKind = "pr_finding",
  jobId = "job-1",
) {
  const row = database
    .prepare(`SELECT id, result_digest, repository_id, review_run_id,
    request_id, job_id FROM validation_job_results WHERE job_id = ?`)
    .get(jobId);
  if (!row) throw new Error("The finding result fixture is missing.");
  const occurrence = {
    resultId: String(row.id),
    resultDigest: String(row.result_digest),
    kind,
    ordinal,
  };
  if (state === "open") return occurrence;
  const key = findingOccurrenceKey(occurrence);
  const eventId = `finding-event-${key}`;
  database
    .prepare(`INSERT INTO finding_dispositions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1,
    ?, ?, ?, 'https://identity.example.test', 'reviewer')`)
    .run(
      occurrence.resultId,
      occurrence.resultDigest,
      String(row.repository_id),
      String(row.review_run_id),
      String(row.request_id),
      String(row.job_id),
      kind,
      ordinal,
      key,
      state,
      eventId,
      now,
      now,
    );
  database
    .prepare(`INSERT INTO finding_disposition_events SELECT last_event_id, result_id, kind,
    ordinal, repository_id, review_run_id, request_id, job_id, result_digest, occurrence_key,
    state, version, 0, 'open', ?, updated_at, updated_by_issuer, updated_by_subject
    FROM finding_dispositions WHERE occurrence_key = ?`)
    .run(state === "accepted" ? "accept" : state === "dismissed" ? "dismiss" : "resolve", key);
  return occurrence;
}

describe("disposition-aware approval policy", () => {
  function blockingResult(count = 1) {
    const value = result();
    if (
      value.modelReview.state !== "completed" ||
      value.modelReview.result.schemaVersion !== "PrReviewPlanV2"
    )
      throw new Error("Expected a PR model result.");
    value.modelReview.result.findings = Array.from({ length: count }, (_, ordinal) => ({
      findingId: `finding-${ordinal}`,
      priority: 1,
      title: "Review a boundary",
      body: "A boundary may fail.",
      path: "src/app.ts",
      line: ordinal + 1,
      endLine: null,
      confidence: 0.9,
    }));
    return value;
  }
  it.each(["open", "accepted", "dismissed", "resolved"] as const)(
    "retains the raw count while evaluating %s occurrences",
    (state) => {
      const f = fixture();
      f.save(blockingResult());
      const before = f.read().policy;
      disposition(f.database, state);
      const current = f.read().policy;
      expect(current).toMatchObject({
        policyVersion: "required-checks-and-unresolved-p0-p1-v2",
        blockingFindingCount: 1,
        unresolvedBlockingFindingCount: state === "open" || state === "accepted" ? 1 : 0,
        eligible: state === "dismissed" || state === "resolved",
      });
      if (
        current.policyVersion !== "required-checks-and-unresolved-p0-p1-v2" ||
        before.policyVersion !== "required-checks-and-unresolved-p0-p1-v2"
      )
        throw new Error("Expected V2 policy.");
      if (state === "open")
        expect(current.findingDispositionDigest).toBe(before.findingDispositionDigest);
      else expect(current.findingDispositionDigest).not.toBe(before.findingDispositionDigest);
      expect(f.readResult()?.modelReview.findings).toHaveLength(1);
    },
  );
  it("evaluates original ordinals beyond the preview without hiding unresolved findings", () => {
    const f = fixture();
    f.save(blockingResult(20));
    for (let ordinal = 0; ordinal < 19; ordinal++) disposition(f.database, "dismissed", ordinal);
    expect(f.read().requests[0]?.latestResult?.findings).toHaveLength(8);
    expect(f.read().policy).toMatchObject({
      blockingFindingCount: 20,
      unresolvedBlockingFindingCount: 1,
      eligible: false,
    });
    disposition(f.database, "resolved", 19);
    expect(f.read().policy).toMatchObject({
      blockingFindingCount: 20,
      unresolvedBlockingFindingCount: 0,
      eligible: true,
    });
  });
  it("keeps identical model identifiers in separate immutable occurrence namespaces", () => {
    const f = fixture();
    const value = blockingResult();
    value.report = {
      ...value.report,
      workItemKind: "pull_request",
      modelSummary: {
        schemaVersion: "ValidationSummaryV1",
        workItemKind: "pull_request",
        summary: "A separate observation requires attention.",
        recommendation: "request_changes",
        observations: [
          {
            id: "finding-0",
            title: "Review a boundary",
            body: "A boundary may fail.",
            priority: 1,
            path: "src/app.ts",
            line: 1,
          },
        ],
      },
    };
    f.save(value);
    disposition(f.database, "resolved", 0, "pr_finding");
    expect(f.read().policy).toMatchObject({
      blockingFindingCount: 2,
      unresolvedBlockingFindingCount: 1,
      eligible: false,
    });
    disposition(f.database, "dismissed", 0, "validation_observation");
    expect(f.read().policy).toMatchObject({
      blockingFindingCount: 2,
      unresolvedBlockingFindingCount: 0,
      eligible: true,
    });
    expect(f.readResult()?.modelReview).toMatchObject({
      findings: [expect.objectContaining({ findingId: "finding-0", ordinal: 0 })],
      observations: [expect.objectContaining({ id: "finding-0" })],
    });
  });
  it.each(["failed_check", "pending_evidence", "unavailable_evidence", "lifecycle_error"])(
    "does not let dismissal override %s",
    (failure) => {
      const f = fixture();
      const value = blockingResult();
      if (failure === "failed_check") itemAt(value.report.checks).outcome = "failed";
      if (failure === "lifecycle_error")
        value.execution.blockers.push({
          phase: "cleanup",
          stepId: null,
          code: "CLEANUP_FAILED",
          message: "Cleanup failed.",
        });
      f.save(value);
      disposition(f.database, "dismissed");
      const facts = evidenceFacts([
        {
          requestId: "request-1",
          jobId: "job-1",
          status:
            failure === "pending_evidence"
              ? "pending"
              : failure === "unavailable_evidence"
                ? "unavailable"
                : "verified",
        },
      ]);
      const output = verifiedQuery(
        f.database,
        "getDashboardReviewRun",
        { repositoryId: "repo-1", reviewRunId: "run-1" },
        facts,
      );
      expect(output?.policy).toMatchObject({
        blockingFindingCount: 1,
        unresolvedBlockingFindingCount: 0,
        eligible: false,
      });
      expect(output?.policy.reasonCount).toBeGreaterThan(0);
    },
  );
  it("rejects a projection outside the complete immutable occurrence list", () => {
    const f = fixture();
    f.save(blockingResult());
    disposition(f.database, "dismissed", 1);
    expect(() => f.read()).toThrow(/projection is invalid/);
  });
  it("does not carry a disposition to an identical finding in a new activation", () => {
    const f = fixture();
    const value = blockingResult();
    f.save(value);
    disposition(f.database, "dismissed");
    expect(f.read().policy.eligible).toBe(true);
    f.addJob("job-2", 2, "succeeded", value);
    expect(f.read().policy).toMatchObject({
      blockingFindingCount: 1,
      unresolvedBlockingFindingCount: 1,
      eligible: false,
    });
  });
  it("retains optional-lane P0/P1 blocking until that exact occurrence is disposed", () => {
    const f = fixture();
    const optional = {
      ...f.request,
      requiredCheckIds: [],
      profileVersion: {
        ...f.request.profileVersion,
        id: "profile-optional",
        profileId: "optional",
      },
    };
    f.database
      .prepare(
        "INSERT INTO review_run_requests VALUES ('run-1', 'request-optional', 'pr_static_build', 'headless', 0, 'profile-optional', 'prompt-1', ?)",
      )
      .run(JSON.stringify(optional));
    f.database.prepare("UPDATE review_runs SET request_count = 2, readiness_json = ?").run(
      JSON.stringify([
        { requestId: "request-1", state: "ready", reasons: [] },
        { requestId: "request-optional", state: "ready", reasons: [] },
      ]),
    );
    const value = blockingResult();
    value.report.checks = [check("profile-optional:build")];
    f.addJob("job-optional", 2, "succeeded", value);
    f.database.exec(
      "UPDATE review_run_job_links SET request_id = 'request-optional', activation_number = 1 WHERE job_id = 'job-optional'; UPDATE validation_job_results SET request_id = 'request-optional', job_activation = 1, profile_version_id = 'profile-optional' WHERE job_id = 'job-optional'",
    );
    expect(f.read().policy).toMatchObject({
      blockingFindingCount: 1,
      unresolvedBlockingFindingCount: 1,
      eligible: false,
    });
    disposition(f.database, "resolved", 0, "pr_finding", "job-optional");
    expect(f.read().policy).toMatchObject({
      blockingFindingCount: 1,
      unresolvedBlockingFindingCount: 0,
      eligible: true,
    });
  });
});

describe("prepared evidence read projection", () => {
  function withReference() {
    const f = fixture();
    const value = result();
    itemAt(value.report.checks).evidenceIds = ["asset-1"];
    f.save(value);
    f.database
      .prepare(
        "INSERT INTO evidence_assets VALUES ('asset-1', 'repo-1', 'run-1', 'request-1', 'job-1', 'attempt-job-1', 'profile-1', ?, ?, 'profile-1:build', 'finalized', 1, 1, 'log')",
      )
      .run(revision, planDigest);
    return f;
  }
  const detailQuery = { repositoryId: "repo-1", reviewRunId: "run-1" };
  const resultQuery = { ...detailQuery, requestId: "request-1", jobId: "job-1" };
  it("uses admitted facts with exact scope and never calls synchronous verification or file reads", () => {
    const f = withReference();
    const forbidden = forbidSynchronousEvidenceAccess();
    const facts = evidenceFacts();
    facts.assertCurrent.mockImplementation(() => {
      expect(f.database.isTransaction).toBe(true);
    });
    facts.admittedEvidenceReferences.mockImplementation(() => {
      expect(facts.assertCurrent).toHaveBeenCalledTimes(1);
      return true;
    });
    const output = verifiedQuery(f.database, "getDashboardReviewRunJobResult", resultQuery, facts);
    expect(output?.evidenceComplete).toBe(true);
    expect(output).not.toHaveProperty("evidenceVerificationPending");
    expect(facts.admittedEvidenceReferences).toHaveBeenCalledExactlyOnceWith({
      repositoryId: "repo-1",
      runId: "run-1",
      requestId: "request-1",
      jobId: "job-1",
      runAttemptId: "attempt-job-1",
      profileVersionId: "profile-1",
      checkId: "profile-1:build",
      evidenceIds: ["asset-1"],
    });
    expect(facts.admittedScenarioEvidence).not.toHaveBeenCalled();
    expect(forbidden.references).not.toHaveBeenCalled();
    expect(forbidden.reads).not.toHaveBeenCalled();
  });
  it("does not fall back to metadata completeness when prepared facts are missing", () => {
    const f = withReference();
    const forbidden = forbidSynchronousEvidenceAccess();
    const output = verifiedQuery(f.database, "getDashboardReviewRunJobResult", resultQuery);
    expect(output?.evidenceComplete).toBe(false);
    expect(output).not.toHaveProperty("evidenceVerificationPending");
    expect(verifiedQuery(f.database, "getDashboardReviewRun", detailQuery)?.policy.eligible).toBe(
      false,
    );
    expect(forbidden.references).not.toHaveBeenCalled();
    expect(forbidden.reads).not.toHaveBeenCalled();
  });
  it.each([
    { name: "missing", profiles: [] },
    {
      name: "another request",
      profiles: [{ requestId: "request-other", jobId: "job-1", status: "verified" as const }],
    },
    {
      name: "another job",
      profiles: [{ requestId: "request-1", jobId: "job-other", status: "verified" as const }],
    },
    {
      name: "unavailable",
      profiles: [{ requestId: "request-1", jobId: "job-1", status: "unavailable" as const }],
    },
    {
      name: "duplicate",
      profiles: [
        { requestId: "request-1", jobId: "job-1", status: "verified" as const },
        { requestId: "request-1", jobId: "job-1", status: "verified" as const },
      ],
    },
  ])("treats $name profile authority as unavailable", ({ profiles }) => {
    const f = withReference();
    const facts = evidenceFacts(profiles);
    const forbidden = forbidSynchronousEvidenceAccess();
    const output = verifiedQuery(f.database, "getDashboardReviewRunJobResult", resultQuery, facts);
    expect(output?.evidenceComplete).toBe(false);
    expect(output).not.toHaveProperty("evidenceVerificationPending");
    expect(facts.admittedEvidenceReferences).not.toHaveBeenCalled();
    expect(forbidden.references).not.toHaveBeenCalled();
    expect(forbidden.reads).not.toHaveBeenCalled();
  });
  it.each(["negative", "exception"])(
    "keeps a %s reference admission displayable without sync fallback",
    (failure) => {
      const f = withReference();
      const facts = evidenceFacts();
      const forbidden = forbidSynchronousEvidenceAccess();
      facts.admittedEvidenceReferences.mockImplementation(() => {
        if (failure === "exception") throw new Error("The proof is unavailable.");
        return false;
      });
      const output = verifiedQuery(
        f.database,
        "getDashboardReviewRunJobResult",
        resultQuery,
        facts,
      );
      expect(output?.evidenceComplete).toBe(false);
      expect(output?.report.checks[0]?.outcome).toBe("passed");
      expect(output).not.toHaveProperty("evidenceVerificationPending");
      expect(forbidden.references).not.toHaveBeenCalled();
      expect(forbidden.reads).not.toHaveBeenCalled();
    },
  );
  it("exposes pending verification separately from check outcomes and clears it after verification", () => {
    const f = fixture();
    const facts = evidenceFacts([{ requestId: "request-1", jobId: "job-1", status: "pending" }]);
    const forbidden = forbidSynchronousEvidenceAccess();
    const output = verifiedQuery(f.database, "getDashboardReviewRun", detailQuery, facts);
    expect(output?.policy.eligible).toBe(false);
    expect(output?.requests[0]?.blockers).toContain("evidence_verification_pending");
    expect(output?.requests[0]?.latestResult).toMatchObject({
      evidenceComplete: false,
      evidenceVerificationPending: true,
      checks: { passed: 1, failed: 0 },
    });
    const full = verifiedQuery(f.database, "getDashboardReviewRunJobResult", resultQuery, facts);
    expect(full).toMatchObject({ evidenceComplete: false, evidenceVerificationPending: true });
    expect(full?.report).not.toHaveProperty("evidenceVerificationPending");
    expect(full?.execution).not.toHaveProperty("evidenceVerificationPending");
    facts.profiles = [{ requestId: "request-1", jobId: "job-1", status: "verified" }];
    const completed = verifiedQuery(f.database, "getDashboardReviewRun", detailQuery, facts);
    expect(completed?.policy.eligible).toBe(true);
    expect(completed?.requests[0]?.latestResult).not.toHaveProperty("evidenceVerificationPending");
    expect(forbidden.references).not.toHaveBeenCalled();
    expect(forbidden.reads).not.toHaveBeenCalled();
  });
  it("propagates a stale prepared token before adapting callback failures", () => {
    const f = withReference();
    const facts = evidenceFacts();
    const forbidden = forbidSynchronousEvidenceAccess();
    facts.assertCurrent.mockImplementation(() => {
      throw new Error("The prepared selection changed.");
    });
    expect(() => verifiedQuery(f.database, "getDashboardReviewRun", detailQuery, facts)).toThrow(
      "The prepared selection changed.",
    );
    expect(f.database.isTransaction).toBe(false);
    expect(facts.admittedEvidenceReferences).not.toHaveBeenCalled();
    expect(forbidden.references).not.toHaveBeenCalled();
    expect(forbidden.reads).not.toHaveBeenCalled();
  });
  it("still rejects retired metadata and stale authoritative attempts despite positive proof callbacks", () => {
    const f = withReference();
    const facts = evidenceFacts();
    const forbidden = forbidSynchronousEvidenceAccess();
    f.database.exec("UPDATE evidence_assets SET state = 'retired'");
    expect(
      verifiedQuery(f.database, "getDashboardReviewRunJobResult", resultQuery, facts)
        ?.evidenceComplete,
    ).toBe(false);
    f.database.exec("UPDATE jobs SET attempt_count = 2");
    expect(
      verifiedQuery(f.database, "getDashboardReviewRunJobResult", resultQuery, facts),
    ).toBeNull();
    // A forged successful job with an unrelated attempt cannot produce a current policy digest.
    expect(() => verifiedQuery(f.database, "getDashboardReviewRun", detailQuery, facts)).toThrow(
      /projection is invalid/,
    );
    expect(forbidden.references).not.toHaveBeenCalled();
    expect(forbidden.reads).not.toHaveBeenCalled();
  });
  it("requires a prepared profile even when a headless report has no evidence files", () => {
    const f = fixture();
    expect(verifiedQuery(f.database, "getDashboardReviewRun", detailQuery)?.policy.eligible).toBe(
      false,
    );
    expect(
      verifiedQuery(f.database, "getDashboardReviewRun", detailQuery, evidenceFacts())?.policy
        .eligible,
    ).toBe(true);
  });
  it("does not let prepared evidence replace a missing static model review", () => {
    const f = fixture();
    const value = result();
    value.modelReview = { state: "not_requested" };
    f.save(value);
    const output = verifiedQuery(f.database, "getDashboardReviewRun", detailQuery, evidenceFacts());
    expect(output?.requests[0]?.latestResult?.evidenceComplete).toBe(true);
    expect(output?.requests[0]?.blockers).toContain("missing_model_review");
    expect(output?.policy.eligible).toBe(false);
  });
  it("still verifies immutable result bytes before consuming evidence admissions", () => {
    const f = withReference();
    const facts = evidenceFacts();
    f.database.exec("UPDATE validation_job_results SET result_json = '{}'");
    expect(() =>
      verifiedQuery(f.database, "getDashboardReviewRunJobResult", resultQuery, facts),
    ).toThrow("projection is invalid");
    expect(facts.admittedEvidenceReferences).not.toHaveBeenCalled();
  });
  it("preserves scope and revision fences in prepared mode", () => {
    const f = withReference();
    const facts = evidenceFacts();
    expect(
      verifiedQuery(
        f.database,
        "getDashboardReviewRunJobResult",
        { ...resultQuery, repositoryId: "repo-other" },
        facts,
      ),
    ).toBeNull();
    f.database.prepare("UPDATE work_items SET current_revision_key = ?").run("c".repeat(64));
    const output = verifiedQuery(f.database, "getDashboardReviewRun", detailQuery, facts);
    expect(output?.freshness).toBe("superseded");
    expect(output?.policy.eligible).toBe(false);
  });
  it("shows pending issue evidence without inventing an approval policy", () => {
    const f = fixture({ issue: true });
    f.save({
      schemaVersion: "ValidationJobResultV1",
      report: {
        schemaVersion: "ValidationReportV1",
        source: "worker",
        workItemKind: "issue",
        sourceState: "original",
        summary: "The runner reproduced the report.",
        reproductionConclusion: "confirmed",
        checks: [check()],
      },
      execution: { blockers: [], diagnostics: [], cleanupState: "not_needed" },
      modelReview: { state: "not_requested" },
    });
    const facts = evidenceFacts([{ requestId: "request-1", jobId: "job-1", status: "pending" }]);
    const output = verifiedQuery(f.database, "getDashboardReviewRun", detailQuery, facts);
    expect(output?.policy).toMatchObject({ applicable: false, eligible: null });
    expect(output?.requests[0]?.latestResult).toMatchObject({
      evidenceVerificationPending: true,
      evidenceComplete: false,
      reproductionConclusion: "confirmed",
    });
  });
  it("keeps optional evidence pending visible without blocking verified required coverage", () => {
    const f = fixture();
    const optional = {
      ...f.request,
      requiredCheckIds: [],
      profileVersion: {
        ...f.request.profileVersion,
        id: "profile-optional",
        profileId: "optional",
      },
    };
    f.database
      .prepare(
        "INSERT INTO review_run_requests VALUES ('run-1', 'request-optional', 'pr_static_build', 'headless', 0, 'profile-optional', 'prompt-1', ?)",
      )
      .run(JSON.stringify(optional));
    f.database.prepare("UPDATE review_runs SET request_count = 2, readiness_json = ?").run(
      JSON.stringify([
        { requestId: "request-1", state: "ready", reasons: [] },
        { requestId: "request-optional", state: "ready", reasons: [] },
      ]),
    );
    const optionalResult = result();
    optionalResult.report.checks = [check("profile-optional:build")];
    f.addJob("job-optional", 2, "succeeded", optionalResult);
    f.database.exec(
      "UPDATE review_run_job_links SET request_id = 'request-optional', activation_number = 1 WHERE job_id = 'job-optional'; UPDATE validation_job_results SET request_id = 'request-optional', job_activation = 1, profile_version_id = 'profile-optional' WHERE job_id = 'job-optional'",
    );
    const facts = evidenceFacts([
      { requestId: "request-1", jobId: "job-1", status: "verified" },
      { requestId: "request-optional", jobId: "job-optional", status: "pending" },
    ]);
    const output = verifiedQuery(f.database, "getDashboardReviewRun", detailQuery, facts);
    expect(output?.policy.eligible).toBe(true);
    expect(
      output?.requests.find((entry) => entry.requestId === "request-optional")?.latestResult,
    ).toMatchObject({ evidenceComplete: false, evidenceVerificationPending: true });
  });
});

describe("review run query scope and bounded history", () => {
  it("compiles reads against the complete production migration schema", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    runMigrations(database, fileURLToPath(new URL("../../../../migrations/", import.meta.url)));
    expect(query(database, "listDashboardReviewRuns", { repositoryId: "repo-1" })).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    expect(
      query(database, "getDashboardReviewRun", { repositoryId: "repo-1", reviewRunId: "run-1" }),
    ).toBeNull();
  });
  it("reads successful jobs after their current attempt pointer has been cleared", () => {
    const f = fixture();
    const detail = f.read();
    expect(detail.policy.eligible).toBe(true);
    expect(detail.requests[0]?.latestJob?.runAttemptId).toBe("attempt-job-1");
    expect(f.readResult()?.report.checks[0]?.outcome).toBe("passed");
  });
  it("never returns private plans, prompt bodies or commands in summaries or detail", () => {
    const f = fixture();
    const text = JSON.stringify([
      f.read(),
      query(f.database, "listDashboardReviewRuns", { repositoryId: "repo-1" }),
    ]);
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain("request_json");
    expect(f.read().requests[0]?.profile?.configSha256).toBe(planDigest);
  });
  it.each(["repo-other", "repo-1-other"])(
    "does not fall back across repository scope %s",
    (repositoryId) => {
      const f = fixture();
      expect(query(f.database, "listDashboardReviewRuns", { repositoryId }).total).toBe(0);
      expect(
        query(f.database, "getDashboardReviewRun", { repositoryId, reviewRunId: "run-1" }),
      ).toBeNull();
      expect(
        query(f.database, "listDashboardReviewRunJobs", {
          repositoryId,
          reviewRunId: "run-1",
          requestId: "request-1",
        }),
      ).toBeNull();
      expect(
        query(f.database, "getDashboardReviewRunJobResult", {
          repositoryId,
          reviewRunId: "run-1",
          requestId: "request-1",
          jobId: "job-1",
        }),
      ).toBeNull();
    },
  );
  it("applies exact work item scope before totals and detail", () => {
    const f = fixture();
    expect(
      query(f.database, "listDashboardReviewRuns", {
        repositoryId: "repo-1",
        workItemId: "item-other",
      }).total,
    ).toBe(0);
    expect(
      query(f.database, "getDashboardReviewRun", {
        repositoryId: "repo-1",
        reviewRunId: "run-1",
        workItemId: "item-other",
      }),
    ).toBeNull();
  });
  it("rejects a result requested through another request or job", () => {
    const f = fixture();
    expect(
      query(f.database, "getDashboardReviewRunJobResult", {
        repositoryId: "repo-1",
        reviewRunId: "run-1",
        requestId: "request-other",
        jobId: "job-1",
      }),
    ).toBeNull();
    expect(
      query(f.database, "getDashboardReviewRunJobResult", {
        repositoryId: "repo-1",
        reviewRunId: "run-1",
        requestId: "request-1",
        jobId: "job-other",
      }),
    ).toBeNull();
  });
  it("uses the newest activation even while it is queued and preserves prior results as history", () => {
    const f = fixture();
    f.addJob("job-2", 2, "queued");
    const detail = f.read();
    expect(detail.requests[0]?.latestJob?.jobId).toBe("job-2");
    expect(detail.requests[0]?.latestResult).toBeNull();
    expect(detail.policy.eligible).toBe(false);
    expect(f.readResult()?.authoritative).toBe(false);
  });
  it.each(["queued", "retry_waiting"])(
    "projects a pending %s episode separately from the admitted queue and preserves history",
    (status) => {
      const f = fixture();
      f.addJob("job-pending", 2, status);
      f.database.exec(
        "UPDATE job_admission SET state = 'pending', admitted_at = NULL WHERE job_id = 'job-pending'",
      );
      const snapshot = () =>
        JSON.stringify({
          runs: f.database.prepare("SELECT * FROM review_runs").all(),
          requests: f.database.prepare("SELECT * FROM review_run_requests").all(),
          jobs: f.database.prepare("SELECT * FROM jobs").all(),
          admissions: f.database.prepare("SELECT * FROM job_admission").all(),
          attempts: f.database.prepare("SELECT * FROM run_attempts").all(),
          results: f.database.prepare("SELECT * FROM validation_job_results").all(),
        });
      const before = snapshot();
      const detail = f.read();
      const expectedEpisode = {
        state: "pending",
        attemptBase: status === "retry_waiting" ? 1 : 0,
        requestedAt: now,
        timestampBasis: "recorded",
        admittedAt: null,
      };
      expect(detail.execution).toEqual({
        missing: 0,
        awaitingAdmission: 1,
        queued: 0,
        active: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      });
      expect(detail.requests[0]?.latestJob).toMatchObject({
        jobId: "job-pending",
        status,
        admission: expectedEpisode,
      });
      expect(detail.requests[0]?.blockers).toContain("execution_awaiting_admission");
      expect(detail.requests[0]?.blockers).not.toContain(`execution_${status}`);
      expect(detail.policy.eligible).toBe(false);
      expect(detail.requests[0]?.latestResult).toBeNull();
      const summary = query(f.database, "listDashboardReviewRuns", { repositoryId: "repo-1" });
      expect(summary.items[0]?.execution).toEqual(detail.execution);
      const history = query(f.database, "listDashboardReviewRunJobs", {
        repositoryId: "repo-1",
        reviewRunId: "run-1",
        requestId: "request-1",
      });
      expect(history?.items[0]?.admission).toEqual(expectedEpisode);
      expect(history?.items[1]).toMatchObject({
        jobId: "job-1",
        admission: null,
        resultId: "result-job-1",
      });
      expect(f.readResult()?.authoritative).toBe(false);
      expect(snapshot()).toBe(before);

      f.database
        .prepare(
          "UPDATE job_admission SET state = 'admitted', admitted_at = ? WHERE job_id = 'job-pending'",
        )
        .run(now);
      expect(f.read().execution).toMatchObject({ awaitingAdmission: 0, queued: 1 });
      expect(f.read().requests[0]?.blockers).toContain(`execution_${status}`);
    },
  );
  it("keeps a no-Job request in the missing count rather than pending admission", () => {
    const f = fixture({ missingJob: true });
    expect(f.read()).toMatchObject({
      execution: { missing: 1, awaitingAdmission: 0, queued: 0 },
      requests: [{ latestJob: null, latestResult: null }],
      policy: { eligible: false },
    });
  });
  it("counts pending validation requests separately and excludes any request that already has a Job", () => {
    const f = fixture({ missingJob: true });
    expect(f.read().execution.missing).toBe(1);
    f.database.exec(`CREATE TABLE workers(id TEXT PRIMARY KEY, status TEXT, superseded_at TEXT);
      INSERT INTO validation_dispatch_checks VALUES ('repo-1', 'run-1', 'request-1', 1, NULL, '[]');`);
    expect(getSystemSnapshot(f.database, 24)).toMatchObject({
      pendingValidationRequests: 1,
      queuedJobs: 0,
      awaitingAdmissionJobs: 0,
      oldestQueuedAt: null,
      oldestAwaitingAdmissionAt: null,
    });
    f.addJob("job-1", 1, "queued");
    // Deliberately retain an outdated pending check in this writable projection fixture.
    expect(getSystemSnapshot(f.database, 24)).toMatchObject({
      pendingValidationRequests: 0,
      queuedJobs: 1,
      awaitingAdmissionJobs: 0,
    });
    f.database.exec("UPDATE job_admission SET state = 'pending', admitted_at = NULL");
    expect(getSystemSnapshot(f.database, 24)).toMatchObject({
      pendingValidationRequests: 0,
      queuedJobs: 0,
      awaitingAdmissionJobs: 1,
      oldestQueuedAt: null,
      oldestAwaitingAdmissionAt: now,
    });
  });
  it.each([
    ["missing", "DELETE FROM job_admission WHERE job_id = 'job-pending'"],
    ["attempt mismatch", "UPDATE job_admission SET attempt_base = 7 WHERE job_id = 'job-pending'"],
    ["invalid state", "UPDATE job_admission SET state = 'unknown' WHERE job_id = 'job-pending'"],
    [
      "invalid request time",
      "UPDATE job_admission SET requested_at = 'not-a-date' WHERE job_id = 'job-pending'",
    ],
    [
      "invalid basis",
      "UPDATE job_admission SET timestamp_basis = 'inferred' WHERE job_id = 'job-pending'",
    ],
    [
      "missing admitted time",
      "UPDATE job_admission SET admitted_at = NULL WHERE job_id = 'job-pending'",
    ],
    [
      "pending admitted time",
      "UPDATE job_admission SET state = 'pending' WHERE job_id = 'job-pending'",
    ],
  ])("rejects %s waiting admission instead of defaulting to queued", (_name, sql) => {
    const f = fixture();
    f.addJob("job-pending", 2, "queued");
    f.database.exec(sql);
    for (const read of [
      () => f.read(),
      () => query(f.database, "listDashboardReviewRuns", { repositoryId: "repo-1" }),
      () =>
        query(f.database, "listDashboardReviewRunJobs", {
          repositoryId: "repo-1",
          reviewRunId: "run-1",
          requestId: "request-1",
        }),
    ])
      expect(read).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
    expect(
      query(f.database, "listDashboardReviewRuns", { repositoryId: "repo-other" }).items,
    ).toEqual([]);
    expect(f.database.isTransaction).toBe(false);
  });
  it.each([
    "leased",
    "running",
    "cancel_requested",
    "succeeded",
    "failed",
    "dead_letter",
    "stale",
    "cancelled",
  ])(
    "hides persisted admission history for a %s Job without dropping its integrity checks",
    (status) => {
      const f = fixture({ missingJob: true });
      f.addJob("job-1", 1, status, status === "succeeded" ? result() : undefined);
      const detail = f.read();
      expect(detail.requests[0]?.latestJob?.admission).toBeNull();
      expect(detail.execution.awaitingAdmission).toBe(0);
      expect(detail.execution.queued).toBe(0);
      f.database.exec("DELETE FROM job_admission WHERE job_id = 'job-1'");
      expect(() => f.read()).toThrow(expect.objectContaining({ code: "PLATFORM_CORRUPT" }));
    },
  );
  it("preserves migration timestamp provenance without rejecting wall-clock rollback", () => {
    const f = fixture({ missingJob: true });
    f.addJob("job-1", 1, "queued");
    const previous = "2026-09-06T23:59:59.000Z";
    f.database
      .prepare("UPDATE job_admission SET timestamp_basis = 'migration_backfill', admitted_at = ?")
      .run(previous);
    expect(f.read().requests[0]?.latestJob?.admission).toEqual({
      state: "admitted",
      attemptBase: 0,
      requestedAt: now,
      timestampBasis: "migration_backfill",
      admittedAt: previous,
    });
  });
  it("paginates a request's complete activation history", () => {
    const f = fixture();
    for (let index = 2; index <= 71; index++) f.addJob(`job-${index}`, index, "queued");
    const page = query(f.database, "listDashboardReviewRunJobs", {
      repositoryId: "repo-1",
      reviewRunId: "run-1",
      requestId: "request-1",
      page: 2,
      pageSize: 20,
    });
    expect(page).toMatchObject({
      repositoryId: "repo-1",
      reviewRunId: "run-1",
      requestId: "request-1",
    });
    expect(page?.total).toBe(71);
    expect(page?.items).toHaveLength(20);
    expect(page?.items[0]?.activationNumber).toBe(51);
    expect(f.read().requests).toHaveLength(1);
  });
  it("returns the resolved scope even when request history is empty", () => {
    const f = fixture({ missingJob: true });
    expect(
      query(f.database, "listDashboardReviewRunJobs", {
        repositoryId: "repo-1",
        reviewRunId: "run-1",
        requestId: "request-1",
      }),
    ).toEqual({
      repositoryId: "repo-1",
      reviewRunId: "run-1",
      requestId: "request-1",
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    expect(
      query(f.database, "listDashboardReviewRunJobs", {
        repositoryId: "repo-1",
        reviewRunId: "run-1",
        requestId: "request-other",
      }),
    ).toBeNull();
  });
  it("selects one historical job directly despite many newer activations", () => {
    const f = fixture();
    for (let index = 2; index <= 71; index++) f.addJob(`job-${index}`, index, "queued");
    expect(
      query(f.database, "listDashboardReviewRunJobs", {
        repositoryId: "repo-1",
        reviewRunId: "run-1",
        requestId: "request-1",
        jobId: "job-1",
        page: 1,
        pageSize: 1,
      }),
    ).toMatchObject({
      repositoryId: "repo-1",
      reviewRunId: "run-1",
      requestId: "request-1",
      items: [{ jobId: "job-1", activationNumber: 1 }],
      total: 1,
      page: 1,
      pageSize: 1,
    });
    expect(
      query(f.database, "listDashboardReviewRunJobs", {
        repositoryId: "repo-1",
        reviewRunId: "run-1",
        requestId: "request-1",
        jobId: "absent-job",
        page: 1,
        pageSize: 1,
      }),
    ).toMatchObject({ items: [], total: 0 });
    for (const scope of [
      { repositoryId: "another-repo", reviewRunId: "run-1", requestId: "request-1" },
      { repositoryId: "repo-1", reviewRunId: "another-run", requestId: "request-1" },
      { repositoryId: "repo-1", reviewRunId: "run-1", requestId: "another-request" },
    ])
      expect(
        query(f.database, "listDashboardReviewRunJobs", { ...scope, jobId: "job-1" }),
      ).toBeNull();
  });
  it("returns an exact failed job without a report or newest-job substitution", () => {
    const f = fixture({ missingJob: true });
    f.addJob("failed-job", 1, "failed");
    f.addJob("newest-job", 2, "queued");
    expect(
      query(f.database, "listDashboardReviewRunJobs", {
        repositoryId: "repo-1",
        reviewRunId: "run-1",
        requestId: "request-1",
        jobId: "failed-job",
      }),
    ).toMatchObject({
      items: [{ jobId: "failed-job", status: "failed", resultId: null }],
      total: 1,
    });
  });
  it.each([0, 51, Number.MAX_SAFE_INTEGER])("rejects invalid page size %s", (pageSize) => {
    const f = fixture();
    expect(() =>
      query(f.database, "listDashboardReviewRuns", { repositoryId: "repo-1", pageSize }),
    ).toThrow("query is invalid");
  });
  it("rejects unsafe pagination products without opening an unbounded query", () => {
    const f = fixture();
    expect(() =>
      query(f.database, "listDashboardReviewRuns", {
        repositoryId: "repo-1",
        page: Number.MAX_SAFE_INTEGER,
        pageSize: 50,
      }),
    ).toThrow("supported range");
  });
  it("recognizes only its explicit operation names", () => {
    expect(isReviewRunQueryOperation("getDashboardReviewRun")).toBe(true);
    expect(isReviewRunQueryOperation("getReviewRun")).toBe(false);
  });
});

describe("current validation dispatch readiness", () => {
  function initiallyBlocked(f: ReturnType<typeof fixture>) {
    f.database
      .prepare("UPDATE review_runs SET readiness_json = ?, required_request_blockers_json = ?")
      .run(
        JSON.stringify([
          { requestId: "request-1", state: "blocked", reasons: [{ code: "unsupported_target" }] },
        ]),
        JSON.stringify([{ requestId: "request-1", reason: "unsupported_target" }]),
      );
  }
  function dispatchCheck(
    f: ReturnType<typeof fixture>,
    reasons: unknown,
    options: { checkedAt?: string | null; pending?: number; repositoryId?: string } = {},
  ) {
    f.database
      .prepare("INSERT INTO validation_dispatch_checks VALUES (?, 'run-1', 'request-1', ?, ?, ?)")
      .run(
        options.repositoryId ?? "repo-1",
        options.pending ?? 1,
        options.checkedAt === undefined ? now : options.checkedAt,
        JSON.stringify(reasons),
      );
  }
  it("retains initial readiness until the pending request has actually been checked", () => {
    const f = fixture({ missingJob: true });
    initiallyBlocked(f);
    dispatchCheck(f, [], { checkedAt: null });
    expect(f.read().requests[0]).toMatchObject({
      readiness: "blocked",
      blockers: ["unsupported_target", "missing_job"],
    });
    expect(f.read().policy.eligible).toBe(false);
  });
  it("uses the latest dispatch blockers instead of obsolete initial blockers", () => {
    const f = fixture({ missingJob: true });
    initiallyBlocked(f);
    dispatchCheck(f, [{ code: "missing_capability", capability: "ui:web" }]);
    const detail = f.read();
    expect(detail.requests[0]).toMatchObject({
      readiness: "blocked",
      blockers: ["missing_capability: ui:web", "missing_job"],
    });
    expect(detail.policy.reasons).not.toContainEqual(
      expect.objectContaining({ reason: "unsupported_target" }),
    );
    expect(detail.policy.reasons).toContainEqual(
      expect.objectContaining({ reason: "missing_capability: ui:web" }),
    );
  });
  it.each([
    ["authorization_changed", "The current authorization no longer permits execution."],
    ["job_association_limit", "The run has reached its maximum number of job activations."],
  ])("maps stopped scheduler code %s to a public explanation", (code, explanation) => {
    const f = fixture({ missingJob: true });
    initiallyBlocked(f);
    dispatchCheck(f, [{ code }], { pending: 0 });
    expect(f.read().requests[0]?.readiness).toBe("blocked");
    expect(f.read().requests[0]?.blockers).toContain(explanation);
    expect(f.read().requests[0]?.blockers).not.toContain(code);
  });
  it("does not fall back to a dispatch check from another repository", () => {
    const f = fixture({ missingJob: true });
    initiallyBlocked(f);
    dispatchCheck(f, [], { repositoryId: "repo-other" });
    expect(f.read().requests[0]?.readiness).toBe("blocked");
    expect(f.read().requests[0]?.blockers).toContain("unsupported_target");
  });
  it("a successful dispatch clears historic capability blockers from eligibility", () => {
    const f = fixture();
    initiallyBlocked(f);
    dispatchCheck(f, [{ code: "unsupported_target" }], { pending: 0 });
    expect(f.read().requests[0]).toMatchObject({ readiness: "ready", blockers: [] });
    expect(f.read().policy.eligible).toBe(true);
  });
  it("an associated queued job is ready to execute without claiming completed validation", () => {
    const f = fixture();
    initiallyBlocked(f);
    f.addJob("job-2", 2, "queued");
    expect(f.read().requests[0]).toMatchObject({
      readiness: "ready",
      blockers: ["execution_queued"],
    });
    expect(f.read().policy.eligible).toBe(false);
  });
  it("keeps source freshness and authorization separate from the resolved dispatch readiness", () => {
    const f = fixture();
    initiallyBlocked(f);
    f.database.prepare("UPDATE work_items SET current_revision_key = ?").run("c".repeat(64));
    f.database.exec("UPDATE request_epochs SET status = 'closed'");
    const detail = f.read();
    expect(detail.freshness).toBe("superseded");
    expect(detail.requests[0]?.readiness).toBe("ready");
    expect(detail.requests[0]?.blockers).toContain("authorization_closed");
    expect(detail.requests[0]?.blockers).not.toContain("unsupported_target");
    expect(detail.policy.eligible).toBe(false);
    expect(detail.policy.reasons).toContainEqual(
      expect.objectContaining({ code: "stale_revision" }),
    );
  });
  it("a current empty blocker list cannot imply success without a job", () => {
    const f = fixture({ missingJob: true });
    initiallyBlocked(f);
    dispatchCheck(f, []);
    expect(f.read().requests[0]).toMatchObject({ readiness: "ready", blockers: ["missing_job"] });
    expect(f.read().policy.eligible).toBe(false);
  });
  it.each([
    { reasons: [{ code: "unknown-private-dispatch-code" }] },
    { reasons: [{ code: "authorization_changed", actor: "private-actor" }] },
    { reasons: "invalid" },
  ])("rejects an invalid current dispatch projection %#", ({ reasons }) => {
    const f = fixture({ missingJob: true });
    dispatchCheck(f, reasons);
    expect(() => f.read()).toThrow("projection is invalid");
  });
});

describe("automatic GitHub source activation freshness", () => {
  function track(f: ReturnType<typeof fixture>, automatic = true): void {
    f.database.exec("BEGIN");
    expect(
      observeGitHubReviewRunSourceInTransaction(
        f.database,
        { workItemId: "item-1", currentRevisionKey: revision, revisionChanged: false },
        now,
      ),
    ).toBe(1);
    if (automatic)
      f.database
        .prepare(
          "INSERT INTO github_review_run_activations VALUES ('item-1', 'epoch-1', 1, ?, 'review_run', 'run-1')",
        )
        .run(revision);
    f.database.exec("COMMIT");
  }
  function transition(f: ReturnType<typeof fixture>, nextRevision: string, sequence: number): void {
    f.database.exec("BEGIN");
    f.database
      .prepare("UPDATE work_items SET current_revision_key = ? WHERE id = 'item-1'")
      .run(nextRevision);
    expect(
      observeGitHubReviewRunSourceInTransaction(
        f.database,
        { workItemId: "item-1", currentRevisionKey: nextRevision, revisionChanged: true },
        now,
      ),
    ).toBe(sequence);
    f.database.exec("COMMIT");
  }
  it("does not revive an old A success after A to B to A, and requires the new A run's own result", () => {
    const f = fixture();
    track(f);
    expect(f.read().policy.eligible).toBe(true);
    transition(f, "c".repeat(64), 2);
    expect(f.read().freshness).toBe("superseded");
    transition(f, revision, 3);
    const old = f.read();
    expect(old.revisionKey).toBe(old.currentRevisionKey);
    expect(old.freshness).toBe("superseded");
    expect(old.policy.eligible).toBe(false);
    expect(old.policy.reasons).toContainEqual(
      expect.objectContaining({ reason: "source_activation_superseded" }),
    );
    expect(old.policy.reasons).toContainEqual(expect.objectContaining({ code: "stale_revision" }));
    const newPlan = canonicalJson({ ...f.plan, activationId: "activation-new-a" });
    const newDigest = sha256(newPlan);
    const later = "2026-09-07T00:01:00.000Z";
    f.database
      .prepare(`INSERT INTO review_runs
      SELECT 'run-new-a', repository_id, work_item_id, revision_key, ?, 'activation-new-a', request_epoch_id,
        ?, request_count, ?, readiness_json, required_request_blockers_json, revision_id, purpose FROM review_runs WHERE id = 'run-1'`)
      .run(newDigest, later, newPlan);
    f.database.exec(
      `INSERT INTO review_run_requests SELECT 'run-new-a', request_id, workflow_kind, target, required, profile_version_id, prompt_version_id, request_json FROM review_run_requests WHERE review_run_id = 'run-1'`,
    );
    f.database
      .prepare(
        "INSERT INTO github_review_run_activations VALUES ('item-1', 'epoch-1', 3, ?, 'review_run', 'run-new-a')",
      )
      .run(revision);
    f.database
      .prepare(`INSERT INTO jobs SELECT 'job-new-a', work_item_id, resource_revision, request_epoch_id,
      'queued', 0, NULL, ?, ?, NULL, NULL, NULL, NULL, job_kind FROM jobs WHERE id = 'job-1'`)
      .run(newDigest, later);
    f.database
      .prepare(`INSERT INTO job_admission SELECT 'job-new-a', state, 0, 2, ?, timestamp_basis,
        ?, bucket_key, github_repository_id, ownership_state, NULL, 0, blockers_json
        FROM job_admission WHERE job_id = 'job-1'`)
      .run(later, later);
    f.database.exec(
      "INSERT INTO review_run_job_links VALUES ('run-new-a', 'request-1', 1, 'job-new-a')",
    );
    const readNew = () =>
      query(f.database, "getDashboardReviewRun", {
        repositoryId: "repo-1",
        reviewRunId: "run-new-a",
      });
    expect(readNew()?.freshness).toBe("current");
    expect(readNew()?.policy.eligible).toBe(false);
    expect(readNew()?.requests[0]?.latestResult).toBeNull();
    f.database
      .prepare(
        "UPDATE jobs SET status = 'succeeded', attempt_count = 1, started_at = ?, completed_at = ? WHERE id = 'job-new-a'",
      )
      .run(later, later);
    f.database.exec(
      "INSERT INTO run_attempts SELECT 'attempt-new-a', 'job-new-a', phase, status, attempt_number, result_digest, result_json FROM run_attempts WHERE id = 'attempt-job-1'",
    );
    f.database
      .prepare(`INSERT INTO validation_job_results
      SELECT 'result-new-a', 'attempt-new-a', 'job-new-a', repository_id, work_item_id, resource_revision,
        'run-new-a', request_id, 1, 'activation-new-a', ?, profile_version_id, prompt_version_id, workflow_kind,
        target, schema_id, result_digest, result_json, ?, evidence_complete, ?, revision_id, job_kind
      FROM validation_job_results WHERE id = 'result-job-1'`)
      .run(newDigest, newDigest, later);
    expect(readNew()?.policy.eligible).toBe(true);
    expect(readNew()?.requests[0]?.latestResult?.id).toBe("result-new-a");
    expect(f.read().policy.eligible).toBe(false);
    const list = query(f.database, "listDashboardReviewRuns", { repositoryId: "repo-1" });
    expect(list.items.map((item) => [item.id, item.freshness])).toEqual([
      ["run-new-a", "current"],
      ["run-1", "superseded"],
    ]);
    expect(f.readResult()?.id).toBe("result-job-1");
  });
  it("preserves exact-revision manual run eligibility independently of automatic source sequence", () => {
    const f = fixture();
    track(f, false);
    transition(f, "c".repeat(64), 2);
    expect(f.read().policy.eligible).toBe(false);
    transition(f, revision, 3);
    expect(f.read().freshness).toBe("current");
    expect(f.read().policy.eligible).toBe(true);
  });
  it("fails closed when an automatic run's current source record is missing", () => {
    const f = fixture();
    track(f);
    f.database.exec("DELETE FROM github_review_run_sources");
    expect(f.read().freshness).toBe("superseded");
    expect(f.read().policy.eligible).toBe(false);
  });
  it.each(["work_item_id", "request_epoch_id", "revision_key"])(
    "does not trust an automatic route with mismatched %s",
    (column) => {
      const f = fixture();
      track(f);
      f.database
        .prepare(`UPDATE github_review_run_activations SET ${column} = ?`)
        .run("other-identity");
      expect(f.read().policy.reasons).toContainEqual(
        expect.objectContaining({ reason: "source_activation_superseded" }),
      );
    },
  );
  it("does not trust source key agreement without source sequence agreement", () => {
    const f = fixture();
    track(f);
    f.database.exec("UPDATE github_review_run_sources SET sequence = 3");
    expect(f.read().freshness).toBe("superseded");
    expect(f.read().policy.eligible).toBe(false);
  });
  it("does not trust source sequence agreement without the exact source revision", () => {
    const f = fixture();
    track(f);
    f.database
      .prepare("UPDATE github_review_run_sources SET current_revision_key = ?")
      .run("c".repeat(64));
    expect(f.read().policy.eligible).toBe(false);
  });
});

describe("authoritative approval eligibility", () => {
  it.each(["failed", "blocked", "not_run", "skipped", "inconclusive"] as const)(
    "execution success does not make a %s required check eligible",
    (outcome) => {
      const f = fixture();
      const value = result();
      itemAt(value.report.checks).outcome = outcome;
      f.save(value);
      const detail = f.read();
      expect(detail.execution.succeeded).toBe(1);
      expect(detail.policy.eligible).toBe(false);
      expect(detail.requests[0]?.latestResult?.recommendation).toBe("approve");
      expect(detail.policy.reasons).toContainEqual(
        expect.objectContaining({ code: "required_check_not_passed", outcome }),
      );
    },
  );
  it.each(["modified", "unknown"] as const)("does not certify %s source", (sourceState) => {
    const f = fixture();
    const value = result();
    value.report.sourceState = sourceState;
    f.save(value);
    expect(f.read().policy.eligible).toBe(false);
  });
  it("blocks an old revision even when all its jobs passed", () => {
    const f = fixture();
    f.database.prepare("UPDATE work_items SET current_revision_key = ?").run("c".repeat(64));
    const detail = f.read();
    expect(detail.freshness).toBe("superseded");
    expect(detail.policy.eligible).toBe(false);
    expect(detail.policy.reasons).toContainEqual(
      expect.objectContaining({ code: "stale_revision" }),
    );
  });
  it("blocks missing required jobs", () => {
    const detail = fixture({ missingJob: true }).read();
    expect(detail.policy.eligible).toBe(false);
    expect(detail.execution.missing).toBe(1);
  });
  it.each(["queued", "running", "failed", "cancelled", "dead_letter", "stale"])(
    "blocks a required %s latest execution",
    (status) => {
      const f = fixture({ missingJob: true });
      f.addJob("job-1", 1, status);
      expect(f.read().policy.eligible).toBe(false);
    },
  );
  it("does not accept a prior attempt result after a later attempt became authoritative", () => {
    const f = fixture();
    f.database.exec("UPDATE jobs SET attempt_count = 2");
    expect(f.readResult()).toBeNull();
    expect(() => f.read()).toThrow(/projection is invalid/);
  });
  it.each([
    "work_item_closed",
    "authorization_closed",
    "repository_paused",
    "authorization_policy_changed",
  ])("blocks %s lifecycle state", (reason) => {
    const f = fixture();
    if (reason === "work_item_closed") f.database.exec("UPDATE work_items SET state = 'closed'");
    if (reason === "authorization_closed")
      f.database.exec("UPDATE request_epochs SET status = 'closed'");
    if (reason === "repository_paused")
      f.database.exec("UPDATE managed_repositories SET enabled = 0");
    if (reason === "authorization_policy_changed")
      f.database.exec("UPDATE managed_repositories SET reviewer_github_user_id = 8");
    expect(f.read().policy.reasons).toContainEqual(
      expect.objectContaining({ code: "required_request_blocked", reason }),
    );
  });
  it("blocks missing legacy review even if a stray summary claims approval", () => {
    const f = fixture();
    const value = result();
    value.modelReview = { state: "not_requested" };
    value.report = {
      ...value.report,
      workItemKind: "pull_request",
      modelSummary: {
        schemaVersion: "ValidationSummaryV1",
        workItemKind: "pull_request",
        summary: "Looks good.",
        recommendation: "approve",
        observations: [],
      },
    };
    f.save(value);
    expect(f.read().policy.reasons).toContainEqual(
      expect.objectContaining({ reason: "missing_model_review" }),
    );
  });
  it("blocks model errors and cleanup failures independently from checks", () => {
    const f = fixture();
    const value = result();
    value.modelReview = { state: "failed", code: "MODEL_FAILED", message: "The model failed." };
    value.execution.cleanupState = "failed";
    f.save(value);
    const reasons = f.read().policy.reasons;
    expect(reasons).toContainEqual(expect.objectContaining({ reason: "missing_model_review" }));
    expect(reasons).toContainEqual(expect.objectContaining({ reason: "cleanup_incomplete" }));
  });
  it("blocks lifecycle errors even when all reported checks passed", () => {
    const f = fixture();
    const value = result();
    value.execution.blockers.push({
      phase: "source",
      stepId: null,
      code: "SOURCE_UNKNOWN",
      message: "Unable to verify the source.",
    });
    f.save(value);
    expect(f.read().policy.reasons).toContainEqual(
      expect.objectContaining({ reason: "source: SOURCE_UNKNOWN" }),
    );
  });
  it.each([0, 1, 2, 3])("applies the explicit P0/P1 finding policy at priority %s", (priority) => {
    const f = fixture();
    const value = result();
    if (
      value.modelReview.state !== "completed" ||
      value.modelReview.result.schemaVersion !== "PrReviewPlanV2"
    )
      throw new Error("Expected PR model fixture.");
    value.modelReview.result.findings = [
      {
        findingId: "finding-1",
        priority,
        title: "Finding",
        body: "Check the boundary.",
        path: "src/app.ts",
        line: 3,
        endLine: null,
        confidence: 0.9,
      },
    ];
    f.save(value);
    expect(f.read().policy.eligible).toBe(priority > 1);
    expect(f.read().policy.blockingFindingCount).toBe(priority <= 1 ? 1 : 0);
  });
  it("does not confuse model-provided checks with runner assertions", () => {
    const f = fixture();
    const value = result();
    itemAt(value.report.checks).source = "model";
    f.save(value);
    expect(f.read().policy.reasons).toContainEqual(
      expect.objectContaining({ code: "required_check_not_runner" }),
    );
  });
  it("rejects result bytes that do not match their immutable digest", () => {
    const f = fixture();
    f.database.exec("UPDATE validation_job_results SET result_json = '{}'");
    expect(() => f.read()).toThrow("projection is invalid");
  });
  it("rejects a result beyond the two MiB read boundary", () => {
    const f = fixture();
    const json = JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) });
    const digest = sha256(json);
    f.database
      .prepare("UPDATE validation_job_results SET result_json = ?, result_digest = ?")
      .run(json, digest);
    f.database.prepare("UPDATE run_attempts SET result_digest = ?").run(digest);
    expect(() => f.read()).toThrow("projection is invalid");
  });
  it("truncates findings explicitly while preserving complete result details", () => {
    const f = fixture();
    const value = result();
    if (
      value.modelReview.state !== "completed" ||
      value.modelReview.result.schemaVersion !== "PrReviewPlanV2"
    )
      throw new Error("Expected PR model fixture.");
    value.modelReview.result.findings = Array.from({ length: 20 }, (_, index) => ({
      findingId: `finding-${index}`,
      priority: 2,
      title: "Finding",
      body: "b".repeat(600),
      path: "src/app.ts",
      line: 3,
      endLine: null,
      confidence: 0.9,
    }));
    f.save(value);
    const preview = f.read().requests[0]?.latestResult;
    expect(preview?.findings).toHaveLength(8);
    expect(preview?.findingCount).toBe(20);
    expect(preview?.findingsTruncated).toBe(true);
    expect(f.readResult()?.modelReview.findings).toHaveLength(20);
  });
  it("does not split Unicode surrogate pairs at summary and finding preview boundaries", () => {
    const f = fixture();
    const value = result();
    value.report.summary = `${"a".repeat(1_023)}\u{1f600}`;
    if (
      value.modelReview.state !== "completed" ||
      value.modelReview.result.schemaVersion !== "PrReviewPlanV2"
    )
      throw new Error("Expected PR model fixture.");
    value.modelReview.result.findings = [
      {
        findingId: "finding-1",
        priority: 2,
        title: "Finding",
        body: `${"b".repeat(511)}\u{1f600}`,
        path: "src/app.ts",
        line: 3,
        endLine: null,
        confidence: 0.9,
      },
    ];
    f.save(value);
    const preview = f.read().requests[0]?.latestResult;
    expect(preview?.summary).toBe("a".repeat(1_023));
    expect(preview?.summaryTruncated).toBe(true);
    expect(preview?.findings[0]?.body).toBe("b".repeat(511));
    expect(preview?.findingsTruncated).toBe(true);
    expect(preview?.summary.isWellFormed()).toBe(true);
    expect(preview?.findings[0]?.body.isWellFormed()).toBe(true);
  });
  it("bounds Unicode job failures in both latest-job and history projections", () => {
    const f = fixture();
    f.database.prepare("UPDATE jobs SET failure_message = ?").run(`${"a".repeat(2_047)}\u{1f600}`);
    expect(f.read().requests[0]?.latestJob?.failureMessage).toBe("a".repeat(2_047));
    const history = query(f.database, "listDashboardReviewRunJobs", {
      repositoryId: "repo-1",
      reviewRunId: "run-1",
      requestId: "request-1",
    });
    expect(history?.items[0]?.failureMessage).toBe("a".repeat(2_047));
    f.database.prepare("UPDATE jobs SET failure_message = ?").run("\u{1f600}".repeat(2_048));
    expect(f.read().requests[0]?.latestJob?.failureMessage).toBe("\u{1f600}".repeat(1_024));
  });
  it("shows issue reproduction without an approval conclusion", () => {
    const f = fixture({ issue: true });
    const value: ValidationJobResultV1 = {
      schemaVersion: "ValidationJobResultV1",
      report: {
        schemaVersion: "ValidationReportV1",
        source: "worker",
        workItemKind: "issue",
        sourceState: "original",
        summary: "The reported crash was reproduced.",
        reproductionConclusion: "confirmed",
        checks: [check()],
        modelSummary: {
          schemaVersion: "ValidationSummaryV1",
          workItemKind: "issue",
          summary: "The observed crash matches the report.",
          reproductionConclusion: "confirmed",
          observations: [],
        },
      },
      execution: { blockers: [], diagnostics: [], cleanupState: "not_needed" },
      modelReview: { state: "not_requested" },
    };
    f.save(value);
    expect(f.read().policy).toMatchObject({ applicable: false, eligible: null });
    expect(f.read().requests[0]?.latestResult?.reproductionConclusion).toBe("confirmed");
  });
});

describe("issue model advice projection", () => {
  function issueResult(
    workerConclusion: IssueReproductionConclusion,
    modelConclusion?: IssueReproductionConclusion,
  ): ValidationJobResultV1 {
    return {
      schemaVersion: "ValidationJobResultV1",
      report: {
        schemaVersion: "ValidationReportV1",
        source: "worker",
        workItemKind: "issue",
        sourceState: "original",
        summary: "The runner recorded its reproduction outcome.",
        reproductionConclusion: workerConclusion,
        checks: [check()],
        ...(modelConclusion === undefined
          ? {}
          : {
              modelSummary: {
                schemaVersion: "ValidationSummaryV1" as const,
                workItemKind: "issue" as const,
                summary: "The model assessed the reproduction evidence.",
                reproductionConclusion: modelConclusion,
                observations: [],
              },
            }),
      },
      execution: { blockers: [], diagnostics: [], cleanupState: "not_needed" },
      modelReview: { state: "not_requested" },
    };
  }
  it.each(["confirmed", "not_reproduced", "needs_information"] as const)(
    "projects the model's %s advice independently from the runner conclusion",
    (modelConclusion) => {
      const f = fixture({ issue: true });
      f.save(issueResult("inconclusive", modelConclusion));
      const full = f.readResult();
      expect(full?.report).toMatchObject({
        workItemKind: "issue",
        reproductionConclusion: "inconclusive",
      });
      expect(full?.modelReview).toMatchObject({
        state: "completed",
        reproductionConclusion: modelConclusion,
        recommendation: null,
        summary: "The model assessed the reproduction evidence.",
      });
      expect(f.read().requests[0]?.latestResult?.reproductionConclusion).toBe("inconclusive");
      expect(f.read().policy).toMatchObject({ applicable: false, eligible: null });
    },
  );
  it.each(["confirmed", "not_reproduced", "needs_information", "blocked", "inconclusive"] as const)(
    "does not invent model advice from a runner %s conclusion",
    (workerConclusion) => {
      const f = fixture({ issue: true });
      f.save(issueResult(workerConclusion));
      expect(f.readResult()?.report).toMatchObject({
        workItemKind: "issue",
        reproductionConclusion: workerConclusion,
      });
      expect(f.readResult()?.modelReview).toMatchObject({
        state: "not_requested",
        reproductionConclusion: null,
        recommendation: null,
        summary: null,
      });
      expect(f.read().requests[0]?.latestResult?.reproductionConclusion).toBe(workerConclusion);
    },
  );
  it.each([undefined, "not_reproduced"] as const)(
    "does not promote advice when the model failed, summary=%s",
    (modelConclusion) => {
      const f = fixture({ issue: true });
      const value = issueResult("confirmed", modelConclusion);
      value.modelReview = {
        state: "failed",
        code: "MODEL_FAILED",
        message: "The model did not complete.",
      };
      f.save(value);
      expect(f.readResult()?.modelReview).toMatchObject({
        state: "failed",
        reproductionConclusion: null,
        recommendation: null,
        summary: null,
        error: { code: "MODEL_FAILED", message: "The model did not complete." },
      });
      expect(f.readResult()?.report).toMatchObject({
        workItemKind: "issue",
        reproductionConclusion: "confirmed",
      });
      expect(f.read().requests[0]?.latestResult?.reproductionConclusion).toBe("confirmed");
    },
  );
  it("keeps legacy issue triage separate from reproduction advice", () => {
    const f = fixture({ issue: true });
    const value = issueResult("inconclusive");
    value.modelReview = {
      state: "completed",
      result: {
        schemaVersion: "IssueTriageV2",
        summary: "The issue needs an application version.",
        category: "bug",
        priority: 2,
        confidence: 0.9,
        suggestedLabels: ["bug"],
        missingInformation: ["Application version"],
        duplicateCandidates: [],
        requestedRecipeIds: [],
        verification: {
          status: "not_run",
          summary: "Triage does not perform reproduction.",
          commands: [],
        },
        executionEvidence: {
          schemaVersion: "ReviewExecutionEvidenceV1",
          source: "worker",
          commandCapture: "complete",
          commands: [],
          worktree: { status: "clean", source: "git_status" },
        },
      },
    };
    f.save(value);
    f.database.exec(
      "UPDATE review_run_requests SET workflow_kind = 'issue_triage'; UPDATE validation_job_results SET workflow_kind = 'issue_triage'",
    );
    expect(f.readResult()?.modelReview).toMatchObject({
      state: "completed",
      reproductionConclusion: null,
      recommendation: null,
      issueTriage: { category: "bug", missingInformation: ["Application version"] },
    });
    expect(f.readResult()?.report).toMatchObject({
      workItemKind: "issue",
      reproductionConclusion: "inconclusive",
    });
  });
  it("does not introduce issue reproduction advice into a PR legacy review", () => {
    const f = fixture();
    expect(f.readResult()?.modelReview).toMatchObject({
      state: "completed",
      recommendation: "approve",
      reproductionConclusion: null,
    });
    expect(f.readResult()?.report).not.toHaveProperty("reproductionConclusion");
    expect(f.read().requests[0]?.latestResult?.reproductionConclusion).toBeNull();
  });
});

describe("evidence freshness", () => {
  function withEvidence() {
    const f = fixture();
    const value = result();
    itemAt(value.report.checks).evidenceIds = ["asset-1"];
    f.save(value);
    f.database
      .prepare(
        "INSERT INTO evidence_assets VALUES ('asset-1', 'repo-1', 'run-1', 'request-1', 'job-1', 'attempt-job-1', 'profile-1', ?, ?, 'profile-1:build', 'finalized', 1, 1, 'log')",
      )
      .run(revision, planDigest);
    return f;
  }
  it("accepts exact finalized manifests", () => {
    expect(withEvidence().read().policy.eligible).toBe(true);
  });
  it.each(["retired", "uploading"])(
    "blocks %s evidence despite the stored completeness flag",
    (state) => {
      const f = withEvidence();
      f.database.prepare("UPDATE evidence_assets SET state = ?").run(state);
      expect(f.read().policy.reasons).toContainEqual(
        expect.objectContaining({ code: "incomplete_evidence" }),
      );
    },
  );
  it.each([
    "repository_id",
    "review_run_id",
    "request_id",
    "job_id",
    "run_attempt_id",
    "profile_version_id",
    "revision_key",
    "plan_digest",
    "check_id",
  ])("rejects evidence from another %s", (column) => {
    const f = withEvidence();
    f.database.prepare(`UPDATE evidence_assets SET ${column} = ?`).run("other");
    expect(f.readResult()?.evidenceComplete).toBe(false);
  });
  it("does not infer complete evidence from a successful check", () => {
    const f = fixture();
    f.database.exec("UPDATE validation_job_results SET evidence_complete = 0");
    expect(f.read().policy.eligible).toBe(false);
  });
  it.skipIf(process.platform !== "linux")(
    "rechecks finalized bytes and blocks same-size corruption or a missing file",
    () => {
      const f = fixture();
      const directory = mkdtempSync(join(tmpdir(), "review-run-evidence-"));
      temporaryDirectories.push(directory);
      chmodSync(directory, 0o700);
      const storageKey = "1".repeat(32);
      const assetId = "00000000-0000-4000-8000-000000000001";
      const path = join(directory, `${assetId}.asset`);
      const bytes = "original";
      writeFileSync(join(directory, `.owner-${storageKey}`), "", { mode: 0o600 });
      writeFileSync(path, bytes, { mode: 0o600 });
      const info = statSync(path, { bigint: true });
      f.database.exec(`CREATE TABLE evidence_storage_identity(singleton INTEGER, storage_key TEXT);
      CREATE TABLE evidence_asset_chunks(asset_id TEXT, byte_offset INTEGER, size_bytes INTEGER, sha256 TEXT);
      ALTER TABLE evidence_assets ADD COLUMN sha256 TEXT;
      ALTER TABLE evidence_assets ADD COLUMN file_device TEXT;
      ALTER TABLE evidence_assets ADD COLUMN file_inode TEXT;`);
      f.database.prepare("INSERT INTO evidence_storage_identity VALUES (1, ?)").run(storageKey);
      f.database
        .prepare("INSERT INTO evidence_asset_chunks VALUES (?, 0, ?, ?)")
        .run(assetId, bytes.length, sha256(bytes));
      f.database
        .prepare(
          "INSERT INTO evidence_assets VALUES (?, 'repo-1', 'run-1', 'request-1', 'job-1', 'attempt-job-1', 'profile-1', ?, ?, 'profile-1:build', 'finalized', ?, ?, 'log', ?, ?, ?)",
        )
        .run(
          assetId,
          revision,
          planDigest,
          bytes.length,
          bytes.length,
          sha256(bytes),
          String(info.dev),
          String(info.ino),
        );
      const value = result();
      itemAt(value.report.checks).evidenceIds = [assetId];
      f.save(value);
      const options: EvidenceStorageOptions = {
        evidenceDirectory: directory,
        globalQuotaBytes: 1_048_576,
        globalAssetLimit: 256,
        retentionMs: 60_000,
        incompleteUploadTtlMs: 60_000,
      };
      expect(f.readResult(options)?.evidenceComplete).toBe(true);
      expect(f.read(options).policy.eligible).toBe(true);
      writeFileSync(path, "tampered");
      expect(statSync(path, { bigint: true }).ino).toBe(info.ino);
      expect(f.readResult(options)?.evidenceComplete).toBe(false);
      expect(f.read(options).policy.reasons).toContainEqual(
        expect.objectContaining({ code: "incomplete_evidence" }),
      );
      writeFileSync(path, bytes);
      expect(f.read(options).policy.eligible).toBe(true);
      unlinkSync(path);
      expect(f.readResult(options)?.evidenceComplete).toBe(false);
      expect(f.read(options).policy.eligible).toBe(false);
      expect(f.readResult()?.evidenceComplete).toBe(true);
    },
  );
});

describe("UI scenarios and lifecycle requirements", () => {
  function uiFixture(target: "web" | "windows_desktop" = "web") {
    const f = fixture();
    const request = {
      ...f.request,
      requiredCheckIds: ["profile-1:build", "profile-1:scenario"],
      profileVersion: {
        ...f.request.profileVersion,
        config: {
          ...f.request.profileVersion.config,
          ui: {
            scenarios: [{ id: "scenario", steps: [{ action: "assertVisible" }] }],
            evidence: {
              required: true,
              screenshots: "every_assertion",
              screenshotScope: target === "web" ? "viewport" : "owned_window",
              ...(target === "web" ? { trace: "always" } : {}),
            },
          },
        },
      },
    };
    f.database
      .prepare(
        "UPDATE review_run_requests SET workflow_kind = 'pr_ui', target = ?, request_json = ?",
      )
      .run(target, JSON.stringify(request));
    f.database
      .prepare("UPDATE review_runs SET plan_json = ?")
      .run(JSON.stringify({ ...f.plan, requiredCheckIds: request.requiredCheckIds }));
    const value = result();
    value.report.checks.push({
      ...check("profile-1:scenario", "ui"),
      evidenceIds: ["steps-1", "screenshot-1", ...(target === "web" ? ["trace-1"] : [])],
    });
    value.report = {
      ...value.report,
      workItemKind: "pull_request",
      modelSummary: {
        schemaVersion: "ValidationSummaryV1",
        workItemKind: "pull_request",
        summary: "The scenario passed.",
        observations: [],
        recommendation: "approve",
      },
    };
    value.modelReview = { state: "not_requested" };
    function saveUi() {
      f.save(value);
      f.database
        .prepare("UPDATE validation_job_results SET workflow_kind = 'pr_ui', target = ?")
        .run(target);
    }
    saveUi();
    for (const kind of ["steps", "screenshot", ...(target === "web" ? ["trace"] : [])]) {
      f.database
        .prepare(
          "INSERT INTO evidence_assets VALUES (?, 'repo-1', 'run-1', 'request-1', 'job-1', 'attempt-job-1', 'profile-1', ?, ?, 'profile-1:scenario', 'finalized', 1, 1, ?)",
        )
        .run(`${kind}-1`, revision, planDigest, kind);
    }
    return { ...f, value, saveUi, uiRequest: request };
  }
  function preparedUiFixture(target: "web" | "windows_desktop" = "web") {
    const f = uiFixture(target);
    const preparedRequest = {
      ...f.uiRequest,
      profileVersion: {
        ...f.uiRequest.profileVersion,
        config: {
          ...f.uiRequest.profileVersion.config,
          ui: {
            ...f.uiRequest.profileVersion.config.ui,
            target,
            scenarios: [
              {
                id: "scenario",
                name: "Open settings",
                required: true,
                timeoutMs: 1_000,
                ...(target === "web" ? { path: "/settings" } : {}),
                steps: [
                  {
                    id: "visible",
                    name: "Settings is visible",
                    action: "assertVisible",
                    expected: true,
                    timeoutMs: 1_000,
                    locator:
                      target === "web"
                        ? { by: "testId", testId: "settings" }
                        : { by: "automationId", automationId: "settings" },
                  },
                ],
              },
            ],
          },
        },
      },
    };
    f.database
      .prepare("UPDATE review_run_requests SET request_json = ?")
      .run(JSON.stringify(preparedRequest));
    return { ...f, preparedRequest };
  }
  it.each(["web", "windows_desktop"] as const)(
    "uses prepared %s scenario authority without reading a steps file",
    (target) => {
      const f = preparedUiFixture(target);
      const facts = evidenceFacts();
      const forbidden = forbidSynchronousEvidenceAccess();
      const output = verifiedQuery(
        f.database,
        "getDashboardReviewRun",
        { repositoryId: "repo-1", reviewRunId: "run-1" },
        facts,
      );
      expect(output?.policy.eligible).toBe(true);
      expect(output?.requests[0]?.latestResult?.evidenceComplete).toBe(true);
      expect(facts.admittedScenarioEvidence).toHaveBeenCalledExactlyOnceWith({
        repositoryId: "repo-1",
        runId: "run-1",
        requestId: "request-1",
        jobId: "job-1",
        runAttemptId: "attempt-job-1",
        profileVersionId: "profile-1",
        checkId: "profile-1:scenario",
        evidenceIds: ["steps-1", "screenshot-1", ...(target === "web" ? ["trace-1"] : [])],
      });
      expect(forbidden.references).not.toHaveBeenCalled();
      expect(forbidden.reads).not.toHaveBeenCalled();
    },
  );
  it.each(["negative", "exception"])(
    "does not turn %s prepared scenario evidence into complete coverage",
    (failure) => {
      const f = preparedUiFixture();
      const facts = evidenceFacts();
      const forbidden = forbidSynchronousEvidenceAccess();
      facts.admittedScenarioEvidence.mockImplementation(() => {
        if (failure === "exception") throw new Error("Scenario proof is unavailable.");
        return false;
      });
      const output = verifiedQuery(
        f.database,
        "getDashboardReviewRun",
        { repositoryId: "repo-1", reviewRunId: "run-1" },
        facts,
      );
      expect(facts.admittedEvidenceReferences).toHaveBeenCalled();
      expect(facts.admittedScenarioEvidence).toHaveBeenCalled();
      expect(output?.policy.eligible).toBe(false);
      expect(output?.requests[0]?.latestResult).toMatchObject({
        evidenceComplete: false,
        checks: { passed: 2, failed: 0 },
      });
      expect(output?.requests[0]?.latestResult).not.toHaveProperty("evidenceVerificationPending");
      expect(forbidden.references).not.toHaveBeenCalled();
      expect(forbidden.reads).not.toHaveBeenCalled();
    },
  );
  it.each(["pending", "unavailable"] as const)(
    "does not invoke proof callbacks or sync fallback for %s UI evidence",
    (status) => {
      const f = preparedUiFixture();
      const facts = evidenceFacts([{ requestId: "request-1", jobId: "job-1", status }]);
      const forbidden = forbidSynchronousEvidenceAccess();
      const output = verifiedQuery(
        f.database,
        "getDashboardReviewRun",
        { repositoryId: "repo-1", reviewRunId: "run-1" },
        facts,
      );
      expect(output?.policy.eligible).toBe(false);
      expect(output?.requests[0]?.latestResult?.evidenceComplete).toBe(false);
      expect(output?.requests[0]?.latestResult?.evidenceVerificationPending).toBe(
        status === "pending" ? true : undefined,
      );
      expect(facts.admittedEvidenceReferences).not.toHaveBeenCalled();
      expect(facts.admittedScenarioEvidence).not.toHaveBeenCalled();
      expect(forbidden.references).not.toHaveBeenCalled();
      expect(forbidden.reads).not.toHaveBeenCalled();
    },
  );
  it("retains frozen UI profile validation even when prepared callbacks would approve", () => {
    const f = preparedUiFixture();
    const facts = evidenceFacts();
    const forbidden = forbidSynchronousEvidenceAccess();
    f.preparedRequest.profileVersion.config.ui.target = "windows_desktop";
    f.database
      .prepare("UPDATE review_run_requests SET request_json = ?")
      .run(JSON.stringify(f.preparedRequest));
    const output = verifiedQuery(
      f.database,
      "getDashboardReviewRun",
      { repositoryId: "repo-1", reviewRunId: "run-1" },
      facts,
    );
    expect(output?.policy.eligible).toBe(false);
    expect(facts.admittedScenarioEvidence).not.toHaveBeenCalled();
    expect(forbidden.references).not.toHaveBeenCalled();
    expect(forbidden.reads).not.toHaveBeenCalled();
  });
  function storedUiFixture(target: "web" | "windows_desktop" = "web") {
    const f = uiFixture(target);
    const directory = mkdtempSync(join(tmpdir(), "review-run-ui-evidence-"));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o700);
    const storageKey = "2".repeat(32);
    writeFileSync(join(directory, `.owner-${storageKey}`), "", { mode: 0o600 });
    f.database.exec(`DELETE FROM evidence_assets;
      CREATE TABLE evidence_storage_identity(singleton INTEGER, storage_key TEXT);
      CREATE TABLE evidence_asset_chunks(asset_id TEXT, byte_offset INTEGER, size_bytes INTEGER, sha256 TEXT);
      ALTER TABLE evidence_assets ADD COLUMN sha256 TEXT;
      ALTER TABLE evidence_assets ADD COLUMN file_device TEXT;
      ALTER TABLE evidence_assets ADD COLUMN file_inode TEXT;
      ALTER TABLE evidence_assets ADD COLUMN metadata_json TEXT;
      ALTER TABLE evidence_assets ADD COLUMN created_at TEXT;
      ALTER TABLE evidence_assets ADD COLUMN finalized_at TEXT;
      ALTER TABLE evidence_assets ADD COLUMN retired_at TEXT;`);
    f.database.prepare("INSERT INTO evidence_storage_identity VALUES (1, ?)").run(storageKey);
    const options: EvidenceStorageOptions = {
      evidenceDirectory: directory,
      globalQuotaBytes: 4 * 1024 * 1024,
      globalAssetLimit: 256,
      retentionMs: 60_000,
      incompleteUploadTtlMs: 60_000,
    };
    const assetId = (number: number): string =>
      `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
    const stepsId = assetId(1);
    const screenshotIds = [assetId(2), assetId(3), assetId(4), assetId(5)];
    const traceId = assetId(6);
    const stepProperties = {
      timeoutMs: 1_000,
      locator:
        target === "web"
          ? ({ by: "testId", testId: "settings" } as const)
          : ({ by: "automationId", automationId: "settings" } as const),
    };
    const frozenSteps = [
      { ...stepProperties, id: "open", name: "Open settings", action: "click" },
      { ...stepProperties, id: "fill", name: "Set the value", action: "fill", value: "fixture" },
      {
        ...stepProperties,
        id: "visible",
        name: "Visible settings",
        action: "assertVisible",
        expected: true,
      },
      {
        ...stepProperties,
        id: "value",
        name: "Correct value",
        action: "assertValue",
        expected: "fixture",
      },
      {
        ...stepProperties,
        id: "exact",
        name: "Exact status",
        action: "assertText",
        expected: "Ready",
        match: "exact",
      },
      {
        ...stepProperties,
        id: "contains",
        name: "Status contains text",
        action: "assertText",
        expected: "Ready",
        match: "contains",
      },
    ] as UiScenarioStep[];
    const storedRequest = {
      ...f.uiRequest,
      profileVersion: {
        ...f.uiRequest.profileVersion,
        config: {
          ...f.uiRequest.profileVersion.config,
          ui: {
            ...f.uiRequest.profileVersion.config.ui,
            target,
            scenarios: [
              {
                id: "scenario",
                name: "Settings scenario",
                required: true,
                timeoutMs: 30_000,
                ...(target === "web" ? { path: "/settings" } : {}),
                steps: frozenSteps,
              },
            ],
          },
        },
      },
    };
    f.database
      .prepare("UPDATE review_run_requests SET request_json = ?")
      .run(JSON.stringify(storedRequest));
    const evidence: UiScenarioExecutionEvidenceV1 = {
      schemaVersion: "UiScenarioExecutionEvidenceV1",
      source: "ui_driver",
      scenarioId: "scenario",
      target,
      steps: frozenSteps.map((step, index) => {
        const common = {
          stepId: step.id,
          name: step.name,
          outcome: "passed" as const,
          summary: "The UI step passed.",
          evidenceIds: index < 2 ? [] : [itemAt(screenshotIds, index - 2)],
        };
        switch (step.action) {
          case "click":
          case "fill":
            return { ...common, action: step.action, expected: null, actual: null };
          case "assertVisible":
            return {
              ...common,
              action: step.action,
              expected: step.expected,
              actual: step.expected,
            };
          case "assertValue":
            return {
              ...common,
              action: step.action,
              expected: step.expected,
              actual: step.expected,
            };
          case "assertText":
            return {
              ...common,
              action: step.action,
              expected: step.expected,
              actual:
                step.match === "contains" ? `State: ${step.expected} for review` : step.expected,
            };
        }
        throw new Error("Unsupported fixture action.");
      }),
    };
    function storeAsset(id: string, kind: EvidenceAssetKind, bytes: Buffer): void {
      const path = join(directory, `${id}.asset`);
      writeFileSync(path, bytes, { mode: 0o600 });
      const info = statSync(path, { bigint: true });
      const digest = createHash("sha256").update(bytes).digest("hex");
      const mediaType = kind === "screenshot" ? "image/png" : "application/json";
      const metadata = {
        kind,
        mediaType,
        sizeBytes: bytes.length,
        sha256: digest,
        capturedAt: now,
        checkId: "profile-1:scenario",
      };
      f.database.prepare("DELETE FROM evidence_assets WHERE id = ?").run(id);
      f.database.prepare("DELETE FROM evidence_asset_chunks WHERE asset_id = ?").run(id);
      f.database
        .prepare(`INSERT INTO evidence_assets
        (id, repository_id, review_run_id, request_id, job_id, run_attempt_id, profile_version_id,
        revision_key, plan_digest, check_id, state, committed_bytes, size_bytes, kind, sha256,
        file_device, file_inode, metadata_json, created_at, finalized_at, retired_at)
        VALUES (?, 'repo-1', 'run-1', 'request-1', 'job-1', 'attempt-job-1', 'profile-1',
        ?, ?, 'profile-1:scenario', 'finalized', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(
          id,
          revision,
          planDigest,
          bytes.length,
          bytes.length,
          kind,
          digest,
          String(info.dev),
          String(info.ino),
          JSON.stringify(metadata),
          now,
          now,
        );
      for (let offset = 0; offset < bytes.length; offset += 512 * 1024) {
        const chunk = bytes.subarray(offset, offset + 512 * 1024);
        f.database
          .prepare("INSERT INTO evidence_asset_chunks VALUES (?, ?, ?, ?)")
          .run(id, offset, chunk.length, createHash("sha256").update(chunk).digest("hex"));
      }
    }
    function saveSteps(value: unknown = evidence): void {
      storeAsset(stepsId, "steps", Buffer.from(JSON.stringify(value)));
    }
    saveSteps();
    for (const id of screenshotIds) {
      storeAsset(
        id,
        "screenshot",
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=",
          "base64",
        ),
      );
    }
    if (target === "web") storeAsset(traceId, "trace", Buffer.from("{}"));
    itemAt(f.value.report.checks, 1).evidenceIds = [
      stepsId,
      ...screenshotIds,
      ...(target === "web" ? [traceId] : []),
    ];
    f.saveUi();
    return {
      ...f,
      directory,
      options,
      evidence,
      frozenSteps,
      storedRequest,
      stepsId,
      screenshotIds,
      traceId,
      storeAsset,
      saveSteps,
    };
  }
  function requiredLaunch(f: ReturnType<typeof uiFixture>, exitCode: number | null = null) {
    const row = f.database
      .prepare("SELECT request_json FROM review_run_requests WHERE request_id = 'request-1'")
      .get() as { request_json: string };
    const request = JSON.parse(row.request_json) as {
      profileVersion: { config: { launch: { id: string; name: string; required: boolean }[] } };
    };
    request.profileVersion.config.launch = [
      { id: "start-app", name: "Start the application", required: true },
    ];
    f.database
      .prepare("UPDATE review_run_requests SET request_json = ? WHERE request_id = 'request-1'")
      .run(JSON.stringify(request));
    const diagnostic = {
      stepId: "profile-1:start-app",
      phase: "launch" as const,
      outcome: "passed" as const,
      exitCode,
      summary: "The owned persistent application reached readiness.",
    };
    f.value.execution.diagnostics.push(diagnostic);
    f.saveUi();
    return diagnostic;
  }
  it.each([null, 0, 137])(
    "accepts required launch diagnostics without inventing a check, exitCode=%s",
    (exitCode) => {
      const f = uiFixture();
      requiredLaunch(f, exitCode);
      expect(
        f.readResult()?.report.checks.some((check) => check.id === "profile-1:start-app"),
      ).toBe(false);
      expect(f.read().policy.eligible).toBe(true);
      expect(f.read().requests[0]?.blockers).not.toContain("lifecycle_not_passed: start-app");
    },
  );
  it.each(["failed", "blocked", "not_run", "skipped", "inconclusive"] as const)(
    "blocks a required %s launch diagnostic",
    (outcome) => {
      const f = uiFixture();
      const launch = requiredLaunch(f);
      f.value.execution.diagnostics = f.value.execution.diagnostics.map((entry) =>
        entry === launch ? { ...entry, outcome } : entry,
      );
      f.saveUi();
      expect(f.read().policy.reasons).toContainEqual(
        expect.objectContaining({ reason: "lifecycle_not_passed: start-app" }),
      );
    },
  );
  it.each([
    { stepId: "profile-1:start-app", phase: "setup" },
    { stepId: "profile-other:start-app", phase: "launch" },
    { stepId: "profile-1:other-launch", phase: "launch" },
  ] as const)("rejects launch diagnostics outside frozen identity or phase %#", (changes) => {
    const f = uiFixture();
    const launch = requiredLaunch(f);
    f.value.execution.diagnostics = f.value.execution.diagnostics.map((entry) =>
      entry === launch ? { ...entry, ...changes } : entry,
    );
    f.saveUi();
    expect(f.read().policy.reasons).toContainEqual(
      expect.objectContaining({ reason: "lifecycle_not_passed: start-app" }),
    );
  });
  it("does not let a fabricated launch check replace missing lifecycle diagnostics", () => {
    const f = uiFixture();
    const launch = requiredLaunch(f);
    f.value.execution.diagnostics = f.value.execution.diagnostics.filter(
      (entry) => entry !== launch,
    );
    f.value.report.checks.push(check("profile-1:start-app", "static"));
    f.saveUi();
    expect(f.read().policy.reasons).toContainEqual(
      expect.objectContaining({ reason: "lifecycle_not_passed: start-app" }),
    );
  });
  it("rejects ambiguous duplicate launch diagnostics", () => {
    const f = uiFixture();
    const launch = requiredLaunch(f);
    f.value.execution.diagnostics.push({ ...launch });
    f.saveUi();
    expect(f.read().policy.reasons).toContainEqual(
      expect.objectContaining({ reason: "lifecycle_not_passed: start-app" }),
    );
  });
  it.each(["setup", "cleanup"] as const)(
    "still requires runner checks for %s even when diagnostics pass",
    (phase) => {
      const f = fixture();
      f.requestUpdate((request) => {
        Object.assign(request.profileVersion.config, { [phase]: [{ id: phase, required: true }] });
      });
      const value = result();
      value.execution.diagnostics.push({
        stepId: `profile-1:${phase}`,
        phase,
        outcome: "passed",
        exitCode: 0,
        summary: "The lifecycle command completed.",
      });
      if (phase === "cleanup") value.execution.cleanupState = "completed";
      f.save(value);
      expect(f.read().policy.reasons).toContainEqual(
        expect.objectContaining({ reason: `lifecycle_not_passed: ${phase}` }),
      );
    },
  );
  describe.skipIf(process.platform !== "linux")("stored UI step evidence integrity", () => {
    it.each(["web", "windows_desktop"] as const)(
      "accepts deterministic %s coverage without a requested model summary",
      (target) => {
        const f = storedUiFixture(target);
        requiredLaunch(f, 137);
        const { modelSummary: _modelSummary, ...report } = f.value.report;
        f.value.report = report;
        f.value.modelReview = { state: "not_requested" };
        f.saveUi();
        const detail = f.read(f.options);
        expect(detail.policy.eligible).toBe(true);
        expect(detail.requests[0]?.blockers).not.toContain("missing_model_review");
        expect(detail.requests[0]?.latestResult).toMatchObject({
          modelReviewState: "not_requested",
          recommendation: null,
          evidenceComplete: true,
        });
        expect(f.readResult(f.options)?.modelReview).toMatchObject({
          state: "not_requested",
          summary: null,
          recommendation: null,
          error: null,
        });
      },
    );
    it.each(["web", "windows_desktop"] as const)(
      "a required %s launch can pass alongside verified scenario files",
      (target) => {
        const f = storedUiFixture(target);
        requiredLaunch(f, 137);
        expect(f.read(f.options).policy.eligible).toBe(true);
        expect(
          f
            .readResult(f.options)
            ?.report.checks.some((check) => check.id === "profile-1:start-app"),
        ).toBe(false);
      },
    );
    function expectIncomplete(f: ReturnType<typeof storedUiFixture>): void {
      expect(f.readResult(f.options)?.evidenceComplete).toBe(false);
      expect(f.read(f.options).policy.eligible).toBe(false);
      expect(f.read(f.options).policy.reasons).toContainEqual(
        expect.objectContaining({ code: "incomplete_evidence" }),
      );
    }
    it.each(["web", "windows_desktop"] as const)(
      "accepts exact frozen %s scenarios with independent assertion captures",
      (target) => {
        const f = storedUiFixture(target);
        expect(f.readResult(f.options)?.evidenceComplete).toBe(true);
        expect(f.read(f.options).policy.eligible).toBe(true);
      },
    );
    it.each([
      "scenario",
      "target",
      "step_id",
      "name",
      "action",
      "expected",
      "order",
      "missing_step",
      "extra_step",
    ] as const)("rejects a stored scenario with a mismatched %s", (mismatch) => {
      const f = storedUiFixture();
      switch (mismatch) {
        case "scenario":
          f.evidence.scenarioId = "other-scenario";
          break;
        case "target":
          f.evidence.target = "windows_desktop";
          break;
        case "step_id":
          itemAt(f.evidence.steps).stepId = "other-step";
          break;
        case "name":
          itemAt(f.evidence.steps).name = "Other step";
          break;
        case "action":
          Object.assign(itemAt(f.evidence.steps), { action: "fill" });
          break;
        case "expected":
          Object.assign(itemAt(f.evidence.steps, 2), { expected: false, actual: false });
          break;
        case "order":
          f.evidence.steps.splice(0, 2, itemAt(f.evidence.steps, 1), itemAt(f.evidence.steps));
          break;
        case "missing_step":
          f.evidence.steps.pop();
          break;
        case "extra_step":
          f.evidence.steps.push({ ...itemAt(f.evidence.steps), stepId: "extra" });
          break;
      }
      f.saveSteps();
      expectIncomplete(f);
    });
    it.each([2, 3, 4, 5])(
      "rejects null actual values for a passed assertion at index %s",
      (index) => {
        const f = storedUiFixture();
        itemAt(f.evidence.steps, index).actual = null;
        f.saveSteps();
        expectIncomplete(f);
      },
    );
    it.each([
      [2, false],
      [3, "different"],
      [4, "Ready for review"],
      [5, "Not available"],
    ] as const)("rejects a false passed assertion at index %s", (index, actual) => {
      const f = storedUiFixture();
      Object.assign(itemAt(f.evidence.steps, index), { actual });
      f.saveSteps();
      expectIncomplete(f);
    });
    it.each(["failed", "blocked", "not_run", "skipped", "inconclusive"] as const)(
      "rejects a passed check containing a %s step",
      (outcome) => {
        const f = storedUiFixture();
        itemAt(f.evidence.steps).outcome = outcome;
        f.saveSteps();
        expectIncomplete(f);
      },
    );
    it.each(["missing", "cross_check", "unlisted", "wrong_kind", "duplicate_capture"] as const)(
      "rejects a %s assertion screenshot reference",
      (problem) => {
        const f = storedUiFixture();
        const step = itemAt(f.evidence.steps, 2);
        const id = itemAt(f.screenshotIds);
        switch (problem) {
          case "missing":
            step.evidenceIds = [];
            break;
          case "cross_check":
            f.database
              .prepare("UPDATE evidence_assets SET check_id = 'profile-1:other' WHERE id = ?")
              .run(id);
            break;
          case "unlisted":
            {
              const replacementId = "00000000-0000-4000-8000-000000000007";
              f.storeAsset(
                replacementId,
                "screenshot",
                readFileSync(join(f.directory, `${id}.asset`)),
              );
              itemAt(f.value.report.checks, 1).evidenceIds = itemAt(
                f.value.report.checks,
                1,
              ).evidenceIds.map((entry) => (entry === id ? replacementId : entry));
            }
            f.saveUi();
            break;
          case "wrong_kind":
            step.evidenceIds = [f.stepsId];
            break;
          case "duplicate_capture":
            itemAt(f.evidence.steps, 3).evidenceIds = [id];
            break;
        }
        f.saveSteps();
        expectIncomplete(f);
      },
    );
    it("rejects an unknown screenshot referenced only inside step evidence", () => {
      const f = storedUiFixture();
      itemAt(f.evidence.steps, 2).evidenceIds = ["00000000-0000-4000-8000-000000000099"];
      f.saveSteps();
      expectIncomplete(f);
    });
    it("rejects a missing screenshot file while finalized metadata remains present", () => {
      const f = storedUiFixture();
      unlinkSync(join(f.directory, `${itemAt(f.screenshotIds)}.asset`));
      expectIncomplete(f);
    });
    it.each([3, 4, 5])("rejects changed expected text at step index %s", (index) => {
      const f = storedUiFixture();
      Object.assign(itemAt(f.evidence.steps, index), { expected: "Changed", actual: "Changed" });
      f.saveSteps();
      expectIncomplete(f);
    });
    it("rejects an internally inconsistent frozen UI target", () => {
      const f = storedUiFixture();
      f.storedRequest.profileVersion.config.ui.target = "windows_desktop";
      f.database
        .prepare("UPDATE review_run_requests SET request_json = ?")
        .run(JSON.stringify(f.storedRequest));
      expectIncomplete(f);
    });
    it.each([{ source: "model" }, { schemaVersion: "UiScenarioExecutionEvidenceV2" }])(
      "rejects non-driver or unknown-version step envelopes %j",
      (override) => {
        const f = storedUiFixture();
        f.saveSteps({ ...f.evidence, ...override });
        expectIncomplete(f);
      },
    );
    it.each(["retired", "uploading"])("rejects %s assertion captures", (state) => {
      const f = storedUiFixture();
      f.database
        .prepare("UPDATE evidence_assets SET state = ? WHERE id = ?")
        .run(state, itemAt(f.screenshotIds));
      expectIncomplete(f);
    });
    it.each(["envelope", "step"] as const)("rejects unknown fields in the %s", (location) => {
      const f = storedUiFixture();
      if (location === "envelope") f.saveSteps({ ...f.evidence, privateState: "unexpected" });
      else
        f.saveSteps({
          ...f.evidence,
          steps: [
            { ...itemAt(f.evidence.steps), privateState: "unexpected" },
            ...f.evidence.steps.slice(1),
          ],
        });
      expectIncomplete(f);
    });
    it.each(["invalid_json", "invalid_utf8", "arbitrary_bytes"] as const)(
      "rejects finalized steps containing %s",
      (kind) => {
        const f = storedUiFixture();
        let bytes: Buffer;
        if (kind === "invalid_json") bytes = Buffer.from('{"schemaVersion":');
        else if (kind === "arbitrary_bytes")
          bytes = Buffer.from("No structured scenario evidence was captured.");
        else {
          bytes = Buffer.from(JSON.stringify(f.evidence));
          const offset = bytes.indexOf(Buffer.from("The UI step passed."));
          if (offset < 0) throw new Error("Expected fixture summary text.");
          bytes[offset] = 0xff;
        }
        f.storeAsset(f.stepsId, "steps", bytes);
        expectIncomplete(f);
      },
    );
    it("accepts at most 512 KiB of structured step evidence", () => {
      const f = storedUiFixture();
      const json = Buffer.from(JSON.stringify(f.evidence));
      const boundary = Buffer.concat([json, Buffer.alloc(512 * 1024 - json.length, 0x20)]);
      f.storeAsset(f.stepsId, "steps", boundary);
      expect(f.readResult(f.options)?.evidenceComplete).toBe(true);
      f.storeAsset(f.stepsId, "steps", Buffer.concat([boundary, Buffer.from(" ")]));
      expectIncomplete(f);
    });
  });
  it.each(["web", "windows_desktop"] as const)(
    "uses a completed model summary and exact required evidence for %s",
    (target) => {
      const f = uiFixture(target);
      expect(f.read().policy.eligible).toBe(true);
      expect(f.read().requests[0]?.latestResult?.modelReviewState).toBe("completed");
    },
  );
  it.each(["steps-1", "screenshot-1", "trace-1"])(
    "blocks UI approval when required %s evidence is missing",
    (id) => {
      const f = uiFixture();
      itemAt(f.value.report.checks, 1).evidenceIds = itemAt(
        f.value.report.checks,
        1,
      ).evidenceIds.filter((entry) => entry !== id);
      f.saveUi();
      expect(f.readResult()?.evidenceComplete).toBe(false);
      expect(f.read().policy.eligible).toBe(false);
    },
  );
  it("blocks an omitted required scenario even if the stored completeness flag is true", () => {
    const f = uiFixture();
    f.value.report.checks.pop();
    f.saveUi();
    expect(f.read().policy.reasons).toContainEqual(
      expect.objectContaining({ code: "missing_required_check", checkId: "profile-1:scenario" }),
    );
    expect(f.readResult()?.evidenceComplete).toBe(false);
  });
  it("does not use one screenshot to satisfy multiple required assertion captures", () => {
    const f = uiFixture();
    itemAt(f.uiRequest.profileVersion.config.ui.scenarios).steps.push({ action: "assertVisible" });
    f.database
      .prepare("UPDATE review_run_requests SET request_json = ?")
      .run(JSON.stringify(f.uiRequest));
    expect(f.readResult()?.evidenceComplete).toBe(false);
  });
  it("blocks P1 model observations from UI review", () => {
    const f = uiFixture();
    if (f.value.report.modelSummary === undefined) throw new Error("Expected UI summary.");
    f.value.report.modelSummary.observations.push({
      id: "observation-1",
      title: "Incorrect state",
      body: "The control remains disabled.",
      priority: 1,
      path: null,
      line: null,
    });
    f.saveUi();
    expect(f.read().policy.blockingFindingCount).toBe(1);
    expect(f.read().policy.eligible).toBe(false);
  });
  it("keeps PR UI recommendations isolated from issue reproduction advice", () => {
    const f = uiFixture();
    expect(f.readResult()?.modelReview).toMatchObject({
      state: "completed",
      recommendation: "approve",
      reproductionConclusion: null,
    });
    expect(f.readResult()?.report).not.toHaveProperty("reproductionConclusion");
    expect(f.read().requests[0]?.latestResult?.reproductionConclusion).toBeNull();
  });
  it("shows an optional UI model error without erasing successful deterministic coverage", () => {
    const f = uiFixture();
    const { modelSummary: _modelSummary, ...report } = f.value.report;
    f.value.report = report;
    f.value.modelReview = {
      state: "failed",
      code: "MODEL_FAILED",
      message: "The optional model advice was unavailable.",
    };
    f.saveUi();
    expect(f.read().policy.eligible).toBe(true);
    expect(f.read().requests[0]?.latestResult).toMatchObject({
      modelReviewState: "failed",
      recommendation: null,
    });
    expect(f.readResult()?.modelReview.error).toEqual({
      code: "MODEL_FAILED",
      message: "The optional model advice was unavailable.",
    });
    f.value.execution.blockers.push({
      phase: "model_review",
      stepId: null,
      code: "MODEL_FAILED",
      message: "An explicitly required review step failed.",
    });
    f.saveUi();
    expect(f.read().policy.eligible).toBe(false);
    expect(f.read().policy.reasons).toContainEqual(
      expect.objectContaining({ reason: "model_review: MODEL_FAILED" }),
    );
  });
  it("does not require model advice for issue reproduction but still requires legacy issue triage", () => {
    const f = fixture({ issue: true });
    const value: ValidationJobResultV1 = {
      schemaVersion: "ValidationJobResultV1",
      report: {
        schemaVersion: "ValidationReportV1",
        source: "worker",
        workItemKind: "issue",
        sourceState: "original",
        summary: "The reported failure was reproduced by the runner.",
        reproductionConclusion: "confirmed",
        checks: [check()],
      },
      execution: { blockers: [], diagnostics: [], cleanupState: "not_needed" },
      modelReview: { state: "not_requested" },
    };
    f.save(value);
    expect(f.read().requests[0]?.blockers).not.toContain("missing_model_review");
    expect(f.read().requests[0]?.latestResult).toMatchObject({
      reproductionConclusion: "confirmed",
      modelReviewState: "not_requested",
      recommendation: null,
    });
    f.database.exec(
      "UPDATE review_run_requests SET workflow_kind = 'issue_triage'; UPDATE validation_job_results SET workflow_kind = 'issue_triage'",
    );
    expect(f.read().requests[0]?.blockers).toContain("missing_model_review");
  });
  it.each(["setup", "launch", "cleanup"] as const)(
    "does not ignore missing %s lifecycle checks",
    (phase) => {
      const f = fixture();
      f.requestUpdate((request) => {
        Object.assign(request.profileVersion.config, { [phase]: [{ id: phase, required: true }] });
      });
      expect(f.read().policy.reasons).toContainEqual(
        expect.objectContaining({ reason: `lifecycle_not_passed: ${phase}` }),
      );
    },
  );
});
