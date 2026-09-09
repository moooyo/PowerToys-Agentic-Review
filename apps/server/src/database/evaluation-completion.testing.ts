import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ValidationJobResultV1 } from "@agentic-review/codex";
import type { WorkerCapabilities } from "@agentic-review/contracts";
import { expect } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { createEvaluationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import {
  createEvaluationBatchFixture,
  readEvaluationBatchCells,
} from "./evaluation-batches.testing.js";
import { createJobAdmissionInTransaction, getJobAdmissionRecord } from "./job-admission.js";
import type { ReviewCompletionJobContext } from "./review-results.js";
import { admitPendingJobsInTransaction } from "./scheduling-admission.js";
import {
  type ValidatedValidationResult,
  validateValidationCompletion,
} from "./validation-results.js";

const queuedAt = "2026-09-08T03:30:00.000Z";
const leasedAt = "2026-09-08T04:00:00.000Z";
export const completedAt = "2026-09-08T04:02:00.000Z";
const deadline = "2026-09-08T04:10:00.000Z";
export function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function insert(database: DatabaseSync, table: string, row: Record<string, SQLInputValue>): void {
  const fields = Object.keys(row);
  database
    .prepare(
      `INSERT INTO ${table} (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
    )
    .run(...Object.values(row));
}

function worker(database: DatabaseSync, protocolLabels: Readonly<Record<string, string>>): void {
  // Only protocol records are created; this fixture never starts an executor or model process.
  const capabilities: WorkerCapabilities = {
    operatingSystem: "windows",
    architecture: "x64",
    headless: true,
    interactiveDesktop: false,
    cliEngine: "codex",
    cliVersion: "1.0.0",
    recipeIds: [],
    labels: {
      executionEnvelope: "2",
      validationHeadless: "1",
      validationEvaluation: "1",
      ...protocolLabels,
    },
  };
  insert(database, "worker_node_credentials", {
    worker_node_id: "evaluation-node",
    display_name: "Synthetic evaluation Worker",
    token_sha256: sha256("evaluation-node"),
    auth_state: "active",
    created_by_issuer: "fixture",
    created_by_subject: "fixture",
    updated_by_issuer: "fixture",
    updated_by_subject: "fixture",
    created_at: leasedAt,
    updated_at: leasedAt,
    activated_at: leasedAt,
  });
  const json = canonicalJson(capabilities);
  insert(database, "workers", {
    id: "evaluation-worker",
    node_id: "evaluation-node",
    instance_id: "evaluation-instance",
    display_name: "Synthetic evaluation Worker",
    version: "1.0.0",
    protocol_version: "1.0",
    max_slots: 4,
    available_slots: 4,
    capabilities_json: json,
    capabilities_digest: sha256(json),
    status: "online",
    registered_at: leasedAt,
    last_seen_at: leasedAt,
    updated_at: leasedAt,
  });
}

export function createEvaluationCompletionFixture(kind: "issue" | "pull_request" = "issue") {
  const base = createEvaluationBatchFixture(kind, { notApplicableCase: false });
  return prepareEvaluationCompletionFixture(base, kind);
}

/** Reuses the explicit synthetic lease fixture with an owner-created frozen batch configuration. */
export function prepareEvaluationCompletionFixture(
  base: ReturnType<typeof createEvaluationBatchFixture>,
  kind: "issue" | "pull_request" = "issue",
  syntheticProtocolLabels: Readonly<Record<string, string>> = {},
) {
  try {
    const batch = base.create({
      ...base.input,
      request: {
        ...base.input.request,
        mode: kind === "issue" ? "profile_only" : "prompt_and_profile",
      },
    });
    const cells = readEvaluationBatchCells(base.database, batch.id).map((cell) => {
      const template = createEvaluationExecutionTemplate({
        runId: cell.run_id,
        plan: cell.plan,
        planDigest: cell.plan_digest,
        frozenPrompt: cell.prompt,
      });
      const jobId = `completion-${cell.arm}`;
      const json = canonicalJson(template);
      transaction(base.database, () => {
        insert(base.database, "jobs", {
          id: jobId,
          work_item_id: base.planInput.workItemId,
          job_kind: kind === "issue" ? "issue_triage" : "pull_request_review",
          semantic_key: jobId,
          concurrency_key: jobId,
          status: "queued",
          execution_json: json,
          execution_digest: sha256(json),
          required_capabilities_json: "[]",
          required_capabilities_digest: sha256("[]"),
          resource_revision: template.validation.revisionKey,
          request_epoch_id: null,
          max_attempts: 1,
          next_attempt_at: queuedAt,
          created_at: queuedAt,
          updated_at: queuedAt,
        });
        createJobAdmissionInTransaction(base.database, jobId, queuedAt);
        insert(base.database, "review_run_job_links", {
          review_run_id: cell.run_id,
          request_id: cell.request_id,
          activation_number: 1,
          job_id: jobId,
          linked_at: queuedAt,
        });
      });
      return { ...cell, jobId, template };
    });
    worker(base.database, syntheticProtocolLabels);
    transaction(base.database, () =>
      admitPendingJobsInTransaction(base.database, { limit: 128 }, leasedAt),
    );
    return { ...base, batch, cells };
  } catch (error) {
    base.close();
    throw error;
  }
}

export type EvaluationCompletionFixture = ReturnType<typeof createEvaluationCompletionFixture>;
type Fixture = EvaluationCompletionFixture;
type Cell = Fixture["cells"][number];

export function selected(fixture: Fixture, arm: "baseline" | "candidate" = "baseline"): Cell {
  const cell = fixture.cells.find((entry) => entry.arm === arm);
  if (!cell) throw new Error("The expected immutable matrix cell is missing.");
  return cell;
}

export function context(database: DatabaseSync, cell: Cell): ReviewCompletionJobContext {
  const row = database
    .prepare(`SELECT job.id AS jobId, job.current_run_attempt_id AS runAttemptId,
    job.job_kind AS jobKind, job.work_item_id AS workItemId, item.resource_kind AS workItemResourceKind,
    job.resource_revision AS resourceRevision, revision.id AS revisionId,
    revision.resource_kind AS revisionResourceKind, revision.base_sha AS revisionBaseSha,
    revision.head_sha AS revisionHeadSha, job.execution_json AS executionJson, job.execution_digest AS executionDigest
    FROM jobs AS job JOIN work_items AS item ON item.id = job.work_item_id
    JOIN review_run_job_links AS link ON link.job_id = job.id
    JOIN review_runs AS run ON run.id = link.review_run_id
    JOIN work_item_revisions AS revision ON revision.id = run.revision_id
    WHERE job.id = ?`)
    .get(cell.jobId) as unknown as ReviewCompletionJobContext;
  return row;
}

export function beginAttempt(
  fixture: Fixture,
  cell: Cell,
  leaseToken?: string,
): ReviewCompletionJobContext {
  expect(cell.plan.modelRequirements.required).toBe(false);
  expect(getJobAdmissionRecord(fixture.database, cell.jobId)).toMatchObject({
    state: "admitted",
    ownershipState: "resolved",
    attemptBase: 0,
    admittedAt: leasedAt,
    blockers: [],
  });
  transaction(fixture.database, () => {
    const attemptId = `attempt-${cell.jobId}`;
    const leased = fixture.database
      .prepare(`UPDATE jobs SET status = 'leased', current_run_attempt_id = ?,
      attempt_count = 1, lease_generation = 1 WHERE id = ? AND status = 'queued' AND attempt_count = 0`)
      .run(attemptId, cell.jobId);
    expect(Number(leased.changes)).toBe(1);
    insert(fixture.database, "run_attempts", {
      id: attemptId,
      job_id: cell.jobId,
      attempt_number: 1,
      worker_id: "evaluation-worker",
      worker_node_id: "evaluation-node",
      worker_instance_id: "evaluation-instance",
      status: "running",
      lease_token_hash: sha256(leaseToken ?? attemptId),
      lease_generation: 1,
      lease_expires_at: deadline,
      execution_deadline_at: deadline,
      no_progress_timeout_ms: 60_000,
      no_progress_deadline_at: deadline,
      last_heartbeat_at: leasedAt,
      phase: "validation",
      started_at: leasedAt,
    });
    fixture.database.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(cell.jobId);
  });
  return context(fixture.database, cell);
}

export function resultFor(cell: Cell): ValidationJobResultV1 {
  const profile = cell.template.validation.profileVersion;
  const checkId = `${profile.id}:compile`;
  const checks: ValidationJobResultV1["report"]["checks"] = [
    {
      id: checkId,
      name: "Compile the frozen source",
      kind: "build",
      required: true,
      outcome: "failed",
      summary: "The synthetic compiler observation failed.",
      expected: null,
      actual: null,
      evidenceIds: [],
      source: "runner",
    },
  ];
  const report = {
    schemaVersion: "ValidationReportV1",
    source: "worker",
    summary: "The known failing build was observed.",
    sourceState: "original",
    checks,
  } as const;
  const execution: ValidationJobResultV1["execution"] = {
    blockers: [],
    diagnostics: [
      {
        stepId: checkId,
        phase: "build",
        outcome: "failed",
        exitCode: 1,
        summary: "Compiler exited with a known error.",
      },
    ],
    cleanupState: "not_needed",
  };
  const common = {
    schemaVersion: "ValidationJobResultV1",
    execution,
    modelReview: { state: "not_requested" },
  } as const;
  return cell.plan.workItem.kind === "issue"
    ? {
        ...common,
        report: { ...report, workItemKind: "issue", reproductionConclusion: "inconclusive" },
      }
    : { ...common, report: { ...report, workItemKind: "pull_request" } };
}

export function validate(
  fixture: Fixture,
  completion: ReviewCompletionJobContext,
  result: ValidationJobResultV1,
) {
  return validateValidationCompletion(
    fixture.database,
    completion,
    sha256(canonicalJson(result)),
    result,
  );
}

export function settle(
  database: DatabaseSync,
  completion: ReviewCompletionJobContext,
  result: ValidatedValidationResult,
): void {
  database
    .prepare(
      "UPDATE run_attempts SET status = 'succeeded', result_digest = ?, result_json = ?, ended_at = ? WHERE id = ?",
    )
    .run(result.resultDigest, result.canonicalResultJson, completedAt, completion.runAttemptId);
}
