import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  type ValidationJobResult,
  type ValidationJobResultV1,
  type ValidationJobResultV2,
  ValidationJobResultV2Schema,
} from "@agentic-review/codex";
import type { FindingOccurrence } from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  compareFindingResultSets,
  type FindingResultRead,
  findingOccurrenceKey,
  readFindingResult,
} from "./finding-occurrences.js";
import { runMigrations } from "./migrations.js";
import * as validationModelResultBinding from "./validation-model-result-binding.js";

const scope = {
  repositoryId: "repo-1",
  reviewRunId: "run-1",
  requestId: "request-1",
  jobId: "job-1",
};
const revision = "a".repeat(64);
const executionDigest = "b".repeat(64);
const createdAt = "2026-09-07T01:00:00.000Z";
const policy = { policyVersion: 1, schedulingTargetGithubUserId: 7 };
const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});
function present<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("A fixture value is missing.");
  return value;
}
function read(database: DatabaseSync, input = scope) {
  database.exec("BEGIN");
  try {
    return readFindingResult(database, input);
  } finally {
    database.exec("ROLLBACK");
  }
}
function prResult(count = 1): ValidationJobResultV1 {
  return {
    schemaVersion: "ValidationJobResultV1",
    report: {
      schemaVersion: "ValidationReportV1",
      workItemKind: "pull_request",
      source: "worker",
      sourceState: "original",
      summary: "The runner completed.",
      checks: [],
    },
    execution: { blockers: [], diagnostics: [], cleanupState: "not_needed" },
    modelReview: {
      state: "completed",
      result: {
        schemaVersion: "PrReviewPlanV2",
        summary: "Review complete.",
        assessment: "request_changes",
        findings: Array.from({ length: count }, (_, ordinal) => ({
          findingId: `finding-${ordinal}`,
          title: `Finding ${ordinal}`,
          body: `Complete finding body ${ordinal}`,
          priority: ordinal % 4,
          path: "src/Main.ts",
          line: ordinal + 1,
          endLine: null,
          confidence: 0.75,
        })),
        requestedRecipeIds: [],
        verification: {
          status: "not_run",
          summary: "The runner has separate checks.",
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
function summaryResult(issue = false, count = 1): ValidationJobResultV1 {
  const result = prResult(0);
  const modelSummary = {
    schemaVersion: "ValidationSummaryV1" as const,
    summary: "Observations complete.",
    observations: Array.from({ length: count }, (_, ordinal) => ({
      id: `observation-${ordinal}`,
      title: `Finding ${ordinal}`,
      body: `Complete finding body ${ordinal}`,
      priority: ordinal % 4,
      path: null,
      line: null,
    })),
  };
  result.modelReview = { state: "not_requested" };
  if (issue)
    return {
      ...result,
      report: {
        ...result.report,
        workItemKind: "issue",
        reproductionConclusion: "inconclusive",
        modelSummary: {
          ...modelSummary,
          workItemKind: "issue",
          reproductionConclusion: "inconclusive",
        },
      },
      modelReview: { state: "not_requested" },
    };
  return {
    ...result,
    report: {
      ...result.report,
      workItemKind: "pull_request",
      modelSummary: { ...modelSummary, workItemKind: "pull_request", recommendation: "comment" },
    },
    modelReview: { state: "not_requested" },
  };
}

function separatedResult(value: ValidationJobResultV1): ValidationJobResultV2 {
  const { modelSummary, ...report } = value.report;
  let model: unknown = modelSummary;
  if (value.modelReview.state === "completed") {
    const { executionEvidence: _executionEvidence, ...rawModel } = value.modelReview.result;
    model = rawModel;
  }
  if (model === undefined) throw new Error("A completed model fixture is required.");
  const result: unknown = {
    ...value,
    schemaVersion: "ValidationJobResultV2",
    report,
    modelReview: {
      state: "completed",
      result: model,
      invocation: {
        invocationId: "invocation-1",
        scopeSha256: "d".repeat(64),
        receiptSetSha256: "e".repeat(64),
        modelOutputSha256: sha256(canonicalJson(model)),
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
  Value.Assert(ValidationJobResultV2Schema, result);
  return result;
}

// Deliberately mutable relational fixtures exercise corrupt and historical rows that production
// migrations reject. A separate migrated-schema check below keeps the SQL surface authoritative.
function fixture(
  options: {
    automatic?: boolean;
    workflow?: "pr_static_build" | "pr_ui" | "issue_validation" | "issue_triage";
    target?: "headless" | "web" | "windows_desktop";
    result?: ValidationJobResult;
  } = {},
) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE managed_repositories(id TEXT PRIMARY KEY, github_repository_id INTEGER, enabled INTEGER,
      version INTEGER, reviewer_github_user_id INTEGER, authorization_policy_json TEXT);
    CREATE TABLE work_items(id TEXT PRIMARY KEY, repository_id TEXT, resource_kind TEXT, current_revision_key TEXT, state TEXT);
    CREATE TABLE work_item_revisions(id TEXT PRIMARY KEY, work_item_id TEXT, revision_key TEXT);
    CREATE TABLE request_epochs(id TEXT PRIMARY KEY, work_item_id TEXT, status TEXT, current_revision_id TEXT,
      target_github_user_id INTEGER, ordinal INTEGER);
    CREATE TABLE review_runs(id TEXT PRIMARY KEY, repository_id TEXT, work_item_id TEXT, revision_id TEXT,
      revision_key TEXT, plan_digest TEXT, activation_id TEXT, request_epoch_id TEXT, request_count INTEGER, plan_json TEXT, purpose TEXT DEFAULT 'review');
    CREATE TABLE review_run_requests(review_run_id TEXT, request_id TEXT, workflow_kind TEXT, target TEXT,
      required INTEGER, profile_version_id TEXT, prompt_version_id TEXT, request_json TEXT);
    CREATE TABLE review_run_job_links(review_run_id TEXT, request_id TEXT, activation_number INTEGER, job_id TEXT);
    CREATE TABLE github_review_run_sources(work_item_id TEXT PRIMARY KEY, current_revision_key TEXT, sequence INTEGER);
    CREATE TABLE github_review_run_activations(work_item_id TEXT, request_epoch_id TEXT, source_sequence INTEGER,
      revision_key TEXT, mode TEXT, review_run_id TEXT);
    CREATE TABLE jobs(id TEXT PRIMARY KEY, work_item_id TEXT, resource_revision TEXT, request_epoch_id TEXT,
      job_kind TEXT, status TEXT, attempt_count INTEGER, current_run_attempt_id TEXT, execution_digest TEXT, updated_at TEXT);
    CREATE TABLE run_attempts(id TEXT PRIMARY KEY, job_id TEXT, status TEXT, attempt_number INTEGER, result_digest TEXT,
      phase TEXT, last_heartbeat_at TEXT, progress_sequence INTEGER);
    CREATE TABLE validation_job_results(id TEXT PRIMARY KEY, run_attempt_id TEXT, job_id TEXT, repository_id TEXT,
      work_item_id TEXT, revision_id TEXT, resource_revision TEXT, review_run_id TEXT, request_id TEXT,
      job_activation INTEGER, activation_id TEXT, plan_digest TEXT, job_kind TEXT, profile_version_id TEXT,
      prompt_version_id TEXT, workflow_kind TEXT, target TEXT, schema_id TEXT, result_digest TEXT,
      execution_template_sha256 TEXT, evidence_complete INTEGER, result_json TEXT, created_at TEXT);
  `);
  const workflow = options.workflow ?? "pr_static_build";
  const target = options.target ?? (workflow === "pr_ui" ? "web" : "headless");
  const issue = workflow.startsWith("issue_");
  const kind = issue ? "issue" : "pull_request";
  const jobKind = issue ? "issue_triage" : "pull_request_review";
  const request = {
    requestId: scope.requestId,
    workflowKind: workflow,
    target,
    required: true,
    profileVersion: { id: "profile-1", config: { command: "PRIVATE COMMAND" } },
    prompt: { version: { id: "prompt-1", content: "PRIVATE PROMPT" } },
  };
  const plan = {
    schemaVersion: "ReviewRunExecutionPlanV1",
    repository: { id: "repo-1", githubRepositoryId: 1 },
    workItemId: "item-1",
    workItem: { kind, title: "PRIVATE TITLE" },
    revision: { revisionKey: revision },
    activationId: "activation-1",
    authorization: { requestEpochId: "epoch-1", targetGithubUserId: 7, sequence: 1, policy },
    jobs: [request],
  };
  const planJson = canonicalJson(plan);
  const planDigest = sha256(planJson);
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
      "INSERT INTO review_runs VALUES ('run-1', 'repo-1', 'item-1', 'revision-1', ?, ?, 'activation-1', 'epoch-1', 1, ?, 'review')",
    )
    .run(revision, planDigest, planJson);
  database
    .prepare(
      "INSERT INTO review_run_requests VALUES ('run-1', 'request-1', ?, ?, 1, 'profile-1', 'prompt-1', ?)",
    )
    .run(workflow, target, canonicalJson(request));
  database.prepare("INSERT INTO github_review_run_sources VALUES ('item-1', ?, 1)").run(revision);
  if (options.automatic)
    database
      .prepare(
        "INSERT INTO github_review_run_activations VALUES ('item-1', 'epoch-1', 1, ?, 'review_run', 'run-1')",
      )
      .run(revision);
  function addJob(
    id: string,
    activation: number,
    value: ValidationJobResult | null,
    timestamp = createdAt,
  ) {
    const raw = value === null ? null : canonicalJson(value);
    const digest = raw === null ? null : sha256(raw);
    database
      .prepare("INSERT INTO jobs VALUES (?, 'item-1', ?, 'epoch-1', ?, ?, ?, NULL, ?, 'initial')")
      .run(
        id,
        revision,
        jobKind,
        value === null ? "queued" : "succeeded",
        Number(value !== null),
        executionDigest,
      );
    database
      .prepare("INSERT INTO review_run_job_links VALUES ('run-1', 'request-1', ?, ?)")
      .run(activation, id);
    if (value !== null) {
      database
        .prepare(
          "INSERT INTO run_attempts VALUES (?, ?, 'succeeded', 1, ?, 'validation', 'initial', 0)",
        )
        .run(`attempt-${id}`, id, digest);
      database
        .prepare(
          "INSERT INTO validation_job_results VALUES (?, ?, ?, 'repo-1', 'item-1', 'revision-1', ?, 'run-1', 'request-1', ?, 'activation-1', ?, ?, 'profile-1', 'prompt-1', ?, ?, ?, ?, ?, 1, ?, ?)",
        )
        .run(
          `result-${id}`,
          `attempt-${id}`,
          id,
          revision,
          activation,
          planDigest,
          jobKind,
          workflow,
          target,
          value.schemaVersion,
          digest,
          executionDigest,
          raw,
          timestamp,
        );
    }
  }
  function save(value: unknown) {
    const raw = canonicalJson(value);
    database
      .prepare(
        "UPDATE validation_job_results SET result_json = ?, result_digest = ? WHERE job_id = 'job-1'",
      )
      .run(raw, sha256(raw));
    database
      .prepare("UPDATE run_attempts SET result_digest = ? WHERE job_id = 'job-1'")
      .run(sha256(raw));
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
  addJob("job-1", 1, options.result ?? prResult());
  return { database, addJob, save, sourceChange, read: () => present(read(database)) };
}

describe("immutable finding result reader", () => {
  it("keeps complete V2 finding ordinals and the original envelope digest after owner binding", () => {
    const value = separatedResult(prResult(100));
    const admitted = vi
      .spyOn(validationModelResultBinding, "readValidationModelResultBindingInTransaction")
      .mockReturnValue(null);
    const f = fixture({ result: value });
    const result = f.read();
    const digest = sha256(canonicalJson(value));
    expect(admitted).toHaveBeenCalledWith(
      f.database,
      {
        repositoryId: scope.repositoryId,
        runId: scope.reviewRunId,
        requestId: scope.requestId,
        jobId: scope.jobId,
        runAttemptId: "attempt-job-1",
        resultDigest: digest,
        executionDigest,
      },
      value,
    );
    expect(result.context).toMatchObject({ resultDigest: digest, findingCount: 100 });
    expect(result.occurrences[99]).toMatchObject({
      kind: "pr_finding",
      ordinal: 99,
      modelId: "finding-99",
      resultDigest: digest,
    });
    expect(result.occurrences[99]?.key).toBe(
      findingOccurrenceKey({
        resultId: result.context.resultId,
        resultDigest: digest,
        kind: "pr_finding",
        ordinal: 99,
      }),
    );
  });
  it.each([false, true])("reads the separated V2 validation summary for issue=%s", (issue) => {
    vi.spyOn(
      validationModelResultBinding,
      "readValidationModelResultBindingInTransaction",
    ).mockReturnValue(null);
    const value = separatedResult(summaryResult(issue, 100));
    const result = fixture({
      result: value,
      workflow: issue ? "issue_validation" : "pr_ui",
    }).read();
    expect(result.context.modelAvailability).toBe("complete");
    expect(result.occurrences).toHaveLength(100);
    expect(result.occurrences[99]).toMatchObject({
      kind: "validation_observation",
      ordinal: 99,
      modelId: "observation-99",
      path: null,
      line: null,
    });
  });
  it("rejects V2 completed findings when independent owner binding fails", () => {
    vi.spyOn(
      validationModelResultBinding,
      "readValidationModelResultBindingInTransaction",
    ).mockImplementation(() => {
      throw new Error("The owner invocation does not match this result.");
    });
    const f = fixture({ result: separatedResult(prResult()) });
    expect(() => f.read()).toThrow(/stored finding result is invalid/);
  });
  it("rejects mismatched V2 schema metadata before invocation binding", () => {
    const admitted = vi.spyOn(
      validationModelResultBinding,
      "readValidationModelResultBindingInTransaction",
    );
    const f = fixture();
    f.database.exec("UPDATE validation_job_results SET schema_id = 'ValidationJobResultV2'");
    expect(() => f.read()).toThrow(/stored finding result is invalid/);
    expect(admitted).not.toHaveBeenCalled();
  });
  it("requires the caller transaction and preserves ownership on success and failure", () => {
    const f = fixture();
    expect(() => readFindingResult(f.database, scope)).toThrow(/existing database transaction/);
    f.database.exec("BEGIN IMMEDIATE");
    expect(readFindingResult(f.database, scope)?.context.historical).toBe(false);
    expect(f.database.isTransaction).toBe(true);
    expect(() => readFindingResult(f.database, { ...scope, jobId: "invalid job" })).toThrow(
      /scope is invalid/,
    );
    expect(f.database.isTransaction).toBe(true);
    f.database.exec("ROLLBACK");
  });
  it.each(["repositoryId", "reviewRunId", "requestId", "jobId"] as const)(
    "never resolves a missing or cross-scoped %s",
    (field) => {
      const f = fixture();
      expect(read(f.database, { ...scope, [field]: "other" })).toBeNull();
    },
  );
  it("reads full original ordinals and preserves historical duplicate model IDs", () => {
    const value = prResult(100);
    if (
      value.modelReview.state !== "completed" ||
      value.modelReview.result.schemaVersion !== "PrReviewPlanV2"
    )
      throw new Error("Invalid fixture.");
    for (const finding of value.modelReview.result.findings) {
      finding.findingId = "same-id";
      finding.body = "x".repeat(8_192);
    }
    const read = fixture({ result: value }).read();
    expect(read.context).toMatchObject({
      ...scope,
      sourceCurrent: true,
      latestForRequest: true,
      historical: false,
      findingCount: 100,
      modelAvailability: "complete",
    });
    expect(read.occurrences).toHaveLength(100);
    expect(read.occurrences[99]).toMatchObject({
      modelId: "same-id",
      ordinal: 99,
      body: "x".repeat(8_192),
      kind: "pr_finding",
    });
    expect(new Set(read.occurrences.map((value) => value.key)).size).toBe(100);
    expect(read.occurrences[0]?.key).toBe(
      sha256(
        canonicalJson({
          schemaVersion: "FindingOccurrenceV1",
          resultId: read.context.resultId,
          resultDigest: read.context.resultDigest,
          kind: "pr_finding",
          ordinal: 0,
        }),
      ),
    );
    expect(JSON.stringify(read)).not.toContain("PRIVATE");
    expect(read).not.toHaveProperty("resultJson");
  });
  it.each(["web", "windows_desktop"] as const)(
    "extracts completed %s summary observations with raw not_requested state",
    (target) => {
      const value = summaryResult(false, 100);
      const result = fixture({ workflow: "pr_ui", target, result: value }).read();
      expect(result.context.modelAvailability).toBe("complete");
      expect(result.occurrences).toHaveLength(100);
      expect(result.occurrences[99]).toMatchObject({
        kind: "validation_observation",
        ordinal: 99,
        path: null,
        line: null,
        endLine: null,
        confidence: null,
      });
    },
  );
  it("preserves Issue observation paths without requiring a source line", () => {
    const value = summaryResult(true);
    present(value.report.modelSummary?.observations[0]).path = "src/issue.ts";
    const result = fixture({ workflow: "issue_validation", result: value }).read();
    expect(result.context.modelAvailability).toBe("complete");
    expect(result.occurrences[0]).toMatchObject({ path: "src/issue.ts", line: null });
  });
  it.each(["failed", "not_requested"] as const)(
    "distinguishes %s output from a complete empty array",
    (state) => {
      const value = prResult();
      value.modelReview =
        state === "failed"
          ? { state, code: "MODEL_FAILED", message: "Model unavailable." }
          : { state };
      const result = fixture({ result: value }).read();
      expect(result.context.modelAvailability).toBe(state);
      expect(result.occurrences).toEqual([]);
      expect(fixture({ result: prResult(0) }).read().context.modelAvailability).toBe("complete");
    },
  );
  it("marks Issue triage as not applicable without inventing findings", () => {
    const value = summaryResult(true);
    delete value.report.modelSummary;
    expect(fixture({ workflow: "issue_triage", result: value }).read()).toMatchObject({
      context: { modelAvailability: "not_applicable", findingCount: 0 },
      occurrences: [],
    });
  });
  it("retains the selected historical result while a later rerun is queued", () => {
    const f = fixture();
    const before = f.read();
    f.addJob("job-2", 2, null);
    const after = f.read();
    expect(after.context).toMatchObject({
      resultId: before.context.resultId,
      sourceCurrent: true,
      latestForRequest: false,
      historical: true,
    });
    expect(after.context.contextDigest).not.toBe(before.context.contextDigest);
    expect(after.occurrences).toEqual(before.occurrences);
    expect(read(f.database, { ...scope, jobId: "job-2" })).toBeNull();
  });
  it.each([true, false])(
    "binds source A-B-A without reviving the prior context for automatic=%s",
    (automatic) => {
      const f = fixture({ automatic });
      const before = f.read();
      f.sourceChange("d".repeat(64), 2);
      expect(f.read().context.sourceCurrent).toBe(false);
      f.sourceChange(revision, 3);
      const after = f.read();
      expect(after.context.sourceCurrent).toBe(!automatic);
      expect(after.context.contextDigest).not.toBe(before.context.contextDigest);
    },
  );
  it.each([
    "DELETE FROM github_review_run_sources",
    "UPDATE work_items SET state = 'closed'",
    "UPDATE request_epochs SET status = 'closed'",
    "UPDATE managed_repositories SET enabled = 0",
    "UPDATE managed_repositories SET reviewer_github_user_id = 8",
    "UPDATE managed_repositories SET github_repository_id = 8",
    "UPDATE managed_repositories SET authorization_policy_json = NULL",
    "UPDATE request_epochs SET target_github_user_id = 8",
    "UPDATE request_epochs SET ordinal = 2",
  ])("keeps historical findings but changes authority and context: %s", (sql) => {
    const f = fixture();
    const before = f.read();
    f.database.exec(sql);
    const after = f.read();
    expect(after.context).toMatchObject({ sourceCurrent: false, historical: true });
    expect(after.context.contextDigest).not.toBe(before.context.contextDigest);
    expect(after.occurrences).toEqual(before.occurrences);
  });
  it("ignores heartbeat, progress and evidence metadata without reading other result bodies", () => {
    const f = fixture();
    const before = f.read();
    f.database.exec(
      "UPDATE jobs SET updated_at = 'later'; UPDATE run_attempts SET phase = 'later', last_heartbeat_at = 'later', progress_sequence = 99; UPDATE validation_job_results SET evidence_complete = 0",
    );
    expect(f.read()).toEqual(before);
    f.addJob("job-2", 2, prResult(), "2026-09-07T02:00:00.000Z");
    f.database.exec(
      "UPDATE validation_job_results SET result_json = 'not JSON' WHERE job_id = 'job-2'",
    );
    expect(f.read().occurrences).toEqual(before.occurrences);
  });
  it.each([
    "UPDATE validation_job_results SET result_digest = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'",
    "UPDATE validation_job_results SET run_attempt_id = 'wrong'",
    "UPDATE validation_job_results SET repository_id = 'wrong'",
    "UPDATE validation_job_results SET work_item_id = 'wrong'",
    "UPDATE validation_job_results SET revision_id = 'wrong'",
    "UPDATE validation_job_results SET review_run_id = 'wrong'",
    "UPDATE validation_job_results SET request_id = 'wrong'",
    "UPDATE validation_job_results SET activation_id = 'wrong'",
    "UPDATE validation_job_results SET job_activation = 2",
    "UPDATE validation_job_results SET profile_version_id = 'wrong'",
    "UPDATE validation_job_results SET prompt_version_id = 'wrong'",
    "UPDATE validation_job_results SET job_kind = 'issue_triage'",
    "UPDATE validation_job_results SET workflow_kind = 'pr_ui'",
    "UPDATE validation_job_results SET target = 'web'",
    "UPDATE validation_job_results SET schema_id = 'PrReviewPlanV2'",
    "UPDATE validation_job_results SET created_at = 'not-a-date'",
    "UPDATE jobs SET resource_revision = 'wrong'",
    "UPDATE jobs SET request_epoch_id = 'wrong'",
    "UPDATE jobs SET job_kind = 'issue_triage'",
    "UPDATE jobs SET current_run_attempt_id = 'wrong'",
    "UPDATE jobs SET execution_digest = 'wrong'",
    "UPDATE run_attempts SET status = 'failed'",
    "UPDATE run_attempts SET status = 'invalid'",
    "UPDATE run_attempts SET attempt_number = 2",
    "UPDATE review_run_requests SET required = 0",
    "UPDATE review_runs SET request_count = 33",
    "UPDATE github_review_run_sources SET sequence = NULL",
    "UPDATE managed_repositories SET enabled = 2",
    "INSERT INTO review_run_job_links SELECT * FROM review_run_job_links",
    "DELETE FROM work_item_revisions",
    "DELETE FROM validation_job_results",
  ])("rejects corrupt relational identity: %s", (sql) => {
    const f = fixture();
    f.database.exec(sql);
    expect(() => f.read()).toThrow(/stored finding result is invalid/);
  });
  it("checks raw bytes against digest instead of canonicalizing a mutated envelope", () => {
    const f = fixture();
    f.database.exec("UPDATE validation_job_results SET result_json = ' ' || result_json");
    expect(() => f.read()).toThrow(/stored finding result is invalid/);
  });
  it.each([
    (value: ValidationJobResultV1) => ({ ...value, unexpected: true }),
    (value: ValidationJobResultV1) => ({
      ...value,
      report: { ...value.report, summary: "x".repeat(2 * 1024 * 1024) },
    }),
    (value: ValidationJobResultV1) => ({
      ...value,
      modelReview: { state: "completed", result: {} },
    }),
  ])("rejects correctly digested but invalid or oversized full results", (mutate) => {
    const f = fixture();
    f.save(mutate(prResult()));
    expect(() => f.read()).toThrow(/stored finding result is invalid/);
  });
  it.each([
    (value: ValidationJobResultV1) => {
      value.modelReview = { state: "failed", code: "MODEL_FAILED", message: "Unavailable." };
    },
    (value: ValidationJobResultV1) => {
      present(value.report.modelSummary?.observations[0]).line = 4;
    },
    (value: ValidationJobResultV1) => {
      present(value.report.modelSummary?.observations[0]).path = "src/./main.ts";
    },
  ])("rejects inconsistent summary semantics", (mutate) => {
    const value = summaryResult();
    mutate(value);
    const f = fixture({ workflow: "pr_ui", result: value });
    expect(() => f.read()).toThrow(/stored finding result is invalid/);
  });
  it("rejects a UI summary grafted onto a static workflow", () => {
    const f = fixture({ result: summaryResult() });
    expect(() => f.read()).toThrow(/stored finding result is invalid/);
  });
  it("rejects a completed legacy model review grafted onto a UI workflow", () => {
    const f = fixture({ workflow: "pr_ui", result: prResult() });
    expect(() => f.read()).toThrow(/stored finding result is invalid/);
  });
  it("compiles the reader against the complete production migration schema", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    runMigrations(database, fileURLToPath(new URL("../../../../migrations", import.meta.url)));
    expect(read(database)).toBeNull();
  });
});

function occurrence(overrides: Partial<Omit<FindingOccurrence, "disposition">> = {}) {
  const ref = {
    resultId: "result-before",
    resultDigest: "a".repeat(64),
    kind: "pr_finding" as const,
    ordinal: 0,
  };
  const value = {
    ...ref,
    key: findingOccurrenceKey(ref),
    modelId: "model-before",
    title: "A finding",
    body: "A full finding body",
    priority: 1,
    path: "src/Main.ts",
    line: 8,
    endLine: 9,
    confidence: 0.7,
    ...overrides,
  };
  return {
    ...value,
    key: findingOccurrenceKey({
      resultId: value.resultId,
      resultDigest: value.resultDigest,
      kind: value.kind,
      ordinal: value.ordinal,
    }),
  };
}
function sets(
  beforeValues = [occurrence()],
  afterValues = [
    occurrence({
      resultId: "result-after",
      resultDigest: "b".repeat(64),
      modelId: "model-after",
      line: 40,
      endLine: 41,
      priority: 0,
      confidence: 0.99,
    }),
  ],
) {
  const context: FindingResultRead["context"] = {
    ...scope,
    workItemId: "item-1",
    workItemKind: "pull_request",
    resultId: "result-before",
    resultDigest: "a".repeat(64),
    revisionKey: revision,
    planDigest: "c".repeat(64),
    profileVersionId: "profile-1",
    promptVersionId: "prompt-1",
    workflowKind: "pr_static_build",
    target: "headless",
    activationNumber: 1,
    createdAt,
    contextDigest: "d".repeat(64),
    sourceCurrent: true,
    latestForRequest: false,
    historical: true,
    modelAvailability: "complete",
    findingCount: beforeValues.length,
  };
  const before: FindingResultRead = { context, occurrences: beforeValues };
  const after: FindingResultRead = {
    context: {
      ...context,
      reviewRunId: "run-2",
      requestId: "request-2",
      jobId: "job-2",
      resultId: "result-after",
      resultDigest: "b".repeat(64),
      createdAt: "2026-09-07T02:00:00.000Z",
      findingCount: afterValues.length,
    },
    occurrences: afterValues,
  };
  return { before, after, compare: () => compareFindingResultSets(before, after) };
}
describe("conservative complete finding comparison", () => {
  it("matches across runs and revisions without treating IDs, lines, priority or confidence as identity", () => {
    const f = sets();
    f.after.context.revisionKey = "f".repeat(64);
    expect(f.compare()).toMatchObject({
      algorithmVersion: "exact-content-v1",
      compatible: true,
      reasons: [],
      items: [{ status: "persistent", reason: null }],
    });
    expect(JSON.stringify(f.compare())).not.toContain("A full finding body");
  });
  it("normalizes only CRLF and CR line endings", () => {
    const f = sets(
      [occurrence({ title: "A\r\nfinding", body: "one\rtwo\r\nthree" })],
      [occurrence({ title: "A\nfinding", body: "one\ntwo\nthree" })],
    );
    expect(f.compare().items.map((value) => value.status)).toEqual(["persistent"]);
  });
  it.each([
    { path: "src/main.ts" },
    { path: null, line: null },
    { title: "a finding" },
    { title: "A finding " },
    { body: "A  full finding body" },
    { body: "A full finding body\n" },
    { path: "src/Ma\u0301in.ts" },
    { kind: "validation_observation" as const },
  ])("does not collapse distinct content: %j", (overrides) => {
    const f = sets([occurrence()], [occurrence(overrides)]);
    expect(f.compare().items.map((value) => value.status)).toEqual(["not_observed_again", "new"]);
  });
  it("keeps null paths comparable without inventing locations", () => {
    const f = sets(
      [occurrence({ kind: "validation_observation", path: null, line: null })],
      [occurrence({ kind: "validation_observation", path: null, line: null })],
    );
    expect(f.compare().items[0]?.status).toBe("persistent");
  });
  it.each([
    [2, 1],
    [1, 2],
    [2, 2],
    [2, 0],
    [0, 2],
  ])("marks every duplicate candidate incomparable for counts %s/%s", (first, second) => {
    const f = sets(
      Array.from({ length: first }, (_, ordinal) => occurrence({ ordinal })),
      Array.from({ length: second }, (_, ordinal) => occurrence({ ordinal })),
    );
    const result = f.compare();
    expect(result.compatible).toBe(true);
    expect(result.items).toHaveLength(first + second);
    expect(
      result.items.every(
        (value) => value.status === "incomparable" && value.reason === "ambiguous_match",
      ),
    ).toBe(true);
  });
  it("absence is not resolution and empty complete output differs from unavailable output", () => {
    const f = sets([occurrence()], []);
    expect(f.compare().items[0]).toMatchObject({
      status: "not_observed_again",
      after: null,
      reason: null,
    });
    f.after.context.modelAvailability = "not_requested";
    expect(f.compare()).toMatchObject({
      compatible: false,
      reasons: ["model_unavailable"],
      items: [{ status: "incomparable", reason: "model_unavailable" }],
    });
    expect(sets([], []).compare()).toMatchObject({ compatible: true, items: [] });
  });
  it.each(["workflowKind", "target", "profileVersionId", "promptVersionId"] as const)(
    "does not compare changed %s configuration",
    (field) => {
      const f = sets();
      Object.assign(f.after.context, { [field]: "different" });
      expect(f.compare()).toMatchObject({ compatible: false, reasons: ["configuration_changed"] });
      expect(f.compare().items.every((value) => value.reason === "configuration_changed")).toBe(
        true,
      );
    },
  );
  it.each(["failed", "not_requested", "not_applicable"] as const)(
    "requires both model arrays to be complete: %s",
    (availability) => {
      const f = sets();
      f.before.context.modelAvailability = availability;
      expect(f.compare()).toMatchObject({ compatible: false, reasons: ["model_unavailable"] });
    },
  );
  it("rejects cross-repository and cross-work-item comparison before exposing rows", () => {
    const f = sets();
    f.after.context.repositoryId = "other";
    expect(() => f.compare()).toThrow(/same repository and work item/);
    f.after.context.repositoryId = f.before.context.repositoryId;
    f.after.context.workItemId = "other";
    expect(() => f.compare()).toThrow(/same repository and work item/);
  });
  it("does not infer temporal order from random IDs when timestamps are tied or reversed", () => {
    const f = sets();
    f.after.context.createdAt = f.before.context.createdAt;
    expect(f.compare()).toMatchObject({ compatible: false, reasons: ["baseline_not_earlier"] });
    f.after.context.createdAt = "2026-09-07T00:00:00.000Z";
    expect(f.compare().reasons).toEqual(["baseline_not_earlier"]);
  });
  it("marks self comparison ineligible even if the caller changes its displayed date", () => {
    const f = sets();
    f.after.context.resultId = f.before.context.resultId;
    expect(f.compare()).toMatchObject({ compatible: false, reasons: ["same_result"] });
  });
});
