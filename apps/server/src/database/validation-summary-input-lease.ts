import { timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { readEvaluationJobBindingInTransaction } from "./evaluation-execution.js";

export class ValidationSummaryInputLeaseError extends Error {
  constructor(
    readonly code:
      | "WORKER_TOKEN_REJECTED"
      | "VALIDATION_SUMMARY_INPUT_LEASE_REJECTED"
      | "VALIDATION_SUMMARY_INPUT_CORRUPT"
      | "VALIDATION_SUMMARY_INPUT_INVALID",
  ) {
    super("The validation summary input does not match its Worker lease.");
    this.name = "ValidationSummaryInputLeaseError";
  }
}
function fail(code: ValidationSummaryInputLeaseError["code"]): never {
  throw new ValidationSummaryInputLeaseError(code);
}
interface AttemptRow {
  id: string;
  job_id: string;
  worker_node_id: string;
  worker_instance_id: string;
  lease_generation: number;
  lease_token_hash: string;
  status: string;
  lease_expires_at: string;
  execution_deadline_at: string;
  no_progress_deadline_at: string;
  started_at: string;
  job_status: string;
  current_run_attempt_id: string | null;
  job_lease_generation: number;
  cancellation_requested_at: string | null;
  execution_json: string | null;
  execution_digest: string;
  worker_status: string;
  superseded_at: string | null;
  actual_worker_node_id: string;
  actual_worker_instance_id: string;
}

/** Authenticate the ordinary task lease before freezing the summary's exact runner input. */
export function readValidationSummaryInputAttemptInTransaction(
  database: DatabaseSync,
  input: { readonly workerTokenSha256: string; readonly lease: C.LeaseIdentity },
  now: string,
) {
  if (
    !database.isTransaction ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  )
    fail("VALIDATION_SUMMARY_INPUT_INVALID");
  const credential = database
    .prepare(
      "SELECT worker_node_id FROM worker_node_credentials WHERE token_sha256 = ? AND auth_state = 'active'",
    )
    .get(input.workerTokenSha256) as { worker_node_id: string } | undefined;
  if (!credential || credential.worker_node_id !== input.lease.workerNodeId)
    fail("WORKER_TOKEN_REJECTED");
  const attempt = database
    .prepare(`SELECT attempt.id, attempt.job_id, attempt.worker_node_id, attempt.worker_instance_id,
    attempt.lease_generation, attempt.lease_token_hash, attempt.status, attempt.lease_expires_at,
    attempt.execution_deadline_at, attempt.no_progress_deadline_at, attempt.started_at,
    job.status AS job_status, job.current_run_attempt_id, job.lease_generation AS job_lease_generation,
    job.cancellation_requested_at, job.execution_digest,
    CASE WHEN length(CAST(job.execution_json AS BLOB)) <= ${C.maximumReviewRunPlanUtf8Bytes} THEN job.execution_json END AS execution_json,
    worker.node_id AS actual_worker_node_id, worker.instance_id AS actual_worker_instance_id,
    worker.status AS worker_status, worker.superseded_at
    FROM run_attempts AS attempt JOIN jobs AS job ON job.id = attempt.job_id
    JOIN workers AS worker ON worker.id = attempt.worker_id WHERE attempt.id = ?`)
    .get(input.lease.runAttemptId) as AttemptRow | undefined;
  const lease = input.lease;
  if (
    !attempt ||
    attempt.job_id !== lease.jobId ||
    attempt.worker_node_id !== lease.workerNodeId ||
    attempt.worker_instance_id !== lease.workerInstanceId ||
    attempt.lease_generation !== lease.leaseGeneration ||
    !/^[a-f0-9]{64}$/u.test(attempt.lease_token_hash) ||
    !timingSafeEqual(
      Buffer.from(sha256(lease.leaseToken), "hex"),
      Buffer.from(attempt.lease_token_hash, "hex"),
    )
  )
    fail("VALIDATION_SUMMARY_INPUT_LEASE_REJECTED");
  if (
    attempt.actual_worker_node_id !== attempt.worker_node_id ||
    attempt.actual_worker_instance_id !== attempt.worker_instance_id ||
    attempt.execution_json === null
  )
    fail("VALIDATION_SUMMARY_INPUT_CORRUPT");
  let template: unknown;
  try {
    template = JSON.parse(attempt.execution_json);
  } catch {
    return fail("VALIDATION_SUMMARY_INPUT_CORRUPT");
  }
  if (
    !Value.Check(C.JobExecutionTemplateV2Schema, template) ||
    template.validation.schemaVersion !== "ValidationJobContextV2"
  )
    fail("VALIDATION_SUMMARY_INPUT_LEASE_REJECTED");
  if (
    canonicalJson(template) !== attempt.execution_json ||
    sha256(attempt.execution_json) !== attempt.execution_digest
  )
    fail("VALIDATION_SUMMARY_INPUT_CORRUPT");
  const cell = readEvaluationJobBindingInTransaction(database, attempt.job_id, template, now);
  if (!cell.plan.modelRequirements.required) fail("VALIDATION_SUMMARY_INPUT_LEASE_REJECTED");
  return { attempt, frozen: { cell } };
}

export function assertActiveValidationSummaryInputAttempt(
  { attempt, frozen }: ReturnType<typeof readValidationSummaryInputAttemptInTransaction>,
  now: string,
): void {
  for (const date of [
    attempt.lease_expires_at,
    attempt.execution_deadline_at,
    attempt.no_progress_deadline_at,
    attempt.started_at,
  ]) {
    if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date)
      fail("VALIDATION_SUMMARY_INPUT_CORRUPT");
  }
  if (
    !frozen.cell.applicable ||
    !frozen.cell.repositoryEnabled ||
    frozen.cell.controlStatus !== "active" ||
    frozen.cell.reproductionReadiness.state === "blocked" ||
    !["leased", "running"].includes(attempt.status) ||
    !["leased", "running"].includes(attempt.job_status) ||
    !["online", "draining"].includes(attempt.worker_status) ||
    attempt.superseded_at !== null ||
    attempt.cancellation_requested_at !== null ||
    attempt.current_run_attempt_id !== attempt.id ||
    attempt.job_lease_generation !== attempt.lease_generation ||
    attempt.lease_expires_at <= now ||
    attempt.execution_deadline_at <= now ||
    attempt.no_progress_deadline_at <= now ||
    attempt.started_at > now
  )
    fail("VALIDATION_SUMMARY_INPUT_LEASE_REJECTED");
}
