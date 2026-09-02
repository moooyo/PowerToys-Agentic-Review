import { createHash, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ArtifactRunCompletionSubmission,
  ArtifactRunCompletionSubmissionSchema,
  maximumResultArtifactBytes,
  type RunTerminalResponse,
  RunTerminalResponseSchema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import {
  ArtifactCompletionModeMismatchError,
  ArtifactCompletionStateInvalidError,
  LeaseLostError,
  ResultDigestMismatchError,
  TerminalSubmissionConflictError,
} from "./errors.js";
import {
  canonicalizeReviewResultSubmission,
  persistValidatedReviewResult,
  type ReviewCompletionJobContext,
  validateArtifactReviewCompletion,
  validateReviewCompletion,
} from "./review-results.js";

export interface PreparedArtifactCompletionMetadata {
  readonly artifactId: string;
  readonly totalBytes: number;
  readonly sha256: string;
  readonly storageObjectKey: string;
}

export type PrepareArtifactCompletionResult =
  | {
      readonly disposition: "prepared";
      readonly artifact: PreparedArtifactCompletionMetadata;
      readonly reviewContext: ReviewCompletionJobContext;
    }
  | {
      readonly disposition: "replayed";
      readonly response: RunTerminalResponse;
    };

export interface CommitArtifactCompletionInput extends ArtifactRunCompletionSubmission {
  readonly artifactSha256: string;
  readonly artifactTotalBytes: number;
  readonly storageObjectKey: string;
  readonly canonicalizationVersion: 1;
  readonly canonicalResultJson: string;
}

interface ArtifactCompletionRow {
  readonly job_id: string;
  readonly worker_node_id: string;
  readonly worker_instance_id: string;
  readonly attempt_status: string;
  readonly completion_mode: "inline_result_v1" | "result_artifact_v1";
  readonly lease_token_hash: string;
  readonly lease_generation: number;
  readonly lease_expires_at: string;
  readonly execution_deadline_at: string;
  readonly no_progress_deadline_at: string;
  readonly result_digest: string | null;
  readonly result_json: string | null;
  readonly ended_at: string | null;
  readonly job_status: string;
  readonly current_run_attempt_id: string | null;
  readonly job_completed_at: string | null;
  readonly worker_superseded_at: string | null;
  readonly job_kind: "issue_triage" | "pull_request_review";
  readonly work_item_id: string | null;
  readonly request_epoch_id: string | null;
  readonly work_item_resource_kind: "issue" | "pull_request" | null;
  readonly resource_revision: string;
  readonly revision_id: string | null;
  readonly revision_resource_kind: "issue" | "pull_request" | null;
  readonly revision_base_sha: string | null;
  readonly revision_head_sha: string | null;
  readonly execution_json: string;
  readonly execution_digest: string | null;
  readonly artifact_id: string | null;
  readonly artifact_job_id: string | null;
  readonly artifact_run_attempt_id: string | null;
  readonly artifact_purpose: string | null;
  readonly artifact_media_type: string | null;
  readonly artifact_total_bytes: number | null;
  readonly artifact_sha256: string | null;
  readonly storage_object_key: string | null;
  readonly artifact_upload_status: string | null;
  readonly binding_artifact_id: string | null;
  readonly binding_job_id: string | null;
  readonly binding_artifact_sha256: string | null;
  readonly binding_result_digest: string | null;
  readonly binding_canonicalization_version: number | null;
  readonly terminal_response_json: string | null;
  readonly binding_completed_at: string | null;
  readonly persisted_result_id: string | null;
  readonly persisted_result_digest: string | null;
  readonly persisted_result_json: string | null;
}

const queryCompletionRow = (
  database: DatabaseSync,
  runAttemptId: string,
  artifactId: string,
): ArtifactCompletionRow | undefined =>
  database
    .prepare(`
      SELECT
        attempt.job_id,
        attempt.worker_node_id,
        attempt.worker_instance_id,
        attempt.status AS attempt_status,
        attempt.completion_mode,
        attempt.lease_token_hash,
        attempt.lease_generation,
        attempt.lease_expires_at,
        attempt.execution_deadline_at,
        attempt.no_progress_deadline_at,
        attempt.result_digest,
        attempt.result_json,
        attempt.ended_at,
        job.status AS job_status,
        job.current_run_attempt_id,
        job.completed_at AS job_completed_at,
        worker.superseded_at AS worker_superseded_at,
        job.job_kind,
        job.work_item_id,
        job.request_epoch_id,
        item.resource_kind AS work_item_resource_kind,
        job.resource_revision,
        revision.id AS revision_id,
        revision.resource_kind AS revision_resource_kind,
        revision.base_sha AS revision_base_sha,
        revision.head_sha AS revision_head_sha,
        job.execution_json,
        job.execution_digest,
        artifact.id AS artifact_id,
        artifact.job_id AS artifact_job_id,
        artifact.run_attempt_id AS artifact_run_attempt_id,
        artifact.purpose AS artifact_purpose,
        artifact.media_type AS artifact_media_type,
        artifact.total_bytes AS artifact_total_bytes,
        artifact.sha256 AS artifact_sha256,
        artifact.storage_object_key,
        upload.status AS artifact_upload_status,
        binding.artifact_id AS binding_artifact_id,
        binding.job_id AS binding_job_id,
        binding.artifact_sha256 AS binding_artifact_sha256,
        binding.result_digest AS binding_result_digest,
        binding.canonicalization_version AS binding_canonicalization_version,
        binding.terminal_response_json,
        binding.completed_at AS binding_completed_at,
        persisted_result.id AS persisted_result_id,
        persisted_result.result_digest AS persisted_result_digest,
        persisted_result.result_json AS persisted_result_json
      FROM run_attempts AS attempt
      JOIN jobs AS job ON job.id = attempt.job_id
      JOIN workers AS worker ON worker.id = attempt.worker_id
      LEFT JOIN work_items AS item ON item.id = job.work_item_id
      LEFT JOIN work_item_revisions AS revision
        ON revision.work_item_id = job.work_item_id
        AND revision.revision_key = job.resource_revision
      LEFT JOIN run_artifacts AS artifact ON artifact.id = ?
      LEFT JOIN artifact_uploads AS upload ON upload.id = artifact.upload_id
      LEFT JOIN artifact_completion_bindings AS binding
        ON binding.run_attempt_id = attempt.id
      LEFT JOIN review_results AS persisted_result
        ON persisted_result.run_attempt_id = attempt.id
      WHERE attempt.id = ?
    `)
    .get(artifactId, runAttemptId) as unknown as ArtifactCompletionRow | undefined;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const securelyMatchesSha256 = (actual: string, expected: string): boolean => {
  if (!/^[a-f0-9]{64}$/u.test(actual) || !/^[a-f0-9]{64}$/u.test(expected)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
};

const requireCanonicalDateTime = (value: string | null): string => {
  if (value === null) {
    throw new ArtifactCompletionStateInvalidError();
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new ArtifactCompletionStateInvalidError();
  }
  return value;
};

const matchesLeaseIdentity = (
  row: ArtifactCompletionRow,
  input: ArtifactRunCompletionSubmission,
): boolean =>
  row.job_id === input.jobId &&
  row.worker_node_id === input.workerNodeId &&
  row.worker_instance_id === input.workerInstanceId &&
  row.lease_generation === input.leaseGeneration &&
  securelyMatchesSha256(row.lease_token_hash, sha256(input.leaseToken));

const toReviewContext = (
  row: ArtifactCompletionRow,
  runAttemptId: string,
): ReviewCompletionJobContext => ({
  jobId: row.job_id,
  runAttemptId,
  jobKind: row.job_kind,
  workItemId: row.work_item_id,
  workItemResourceKind: row.work_item_resource_kind,
  resourceRevision: row.resource_revision,
  revisionId: row.revision_id,
  revisionResourceKind: row.revision_resource_kind,
  revisionBaseSha: row.revision_base_sha,
  revisionHeadSha: row.revision_head_sha,
  executionJson: row.execution_json,
  executionDigest: row.execution_digest,
});

const rebuildTerminalResponse = (serialized: string): RunTerminalResponse => {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new ArtifactCompletionStateInvalidError();
  }
  if (!Value.Check(RunTerminalResponseSchema, value)) {
    throw new ArtifactCompletionStateInvalidError();
  }
  const response = value as RunTerminalResponse;
  const rebuilt = Object.freeze({
    jobId: response.jobId,
    runAttemptId: response.runAttemptId,
    jobState: response.jobState,
    runState: response.runState,
  });
  if (JSON.stringify(rebuilt) !== serialized) {
    throw new ArtifactCompletionStateInvalidError();
  }
  return rebuilt;
};

const hasBinding = (row: ArtifactCompletionRow): boolean =>
  row.binding_artifact_id !== null ||
  row.binding_job_id !== null ||
  row.binding_artifact_sha256 !== null ||
  row.binding_result_digest !== null ||
  row.binding_canonicalization_version !== null ||
  row.terminal_response_json !== null ||
  row.binding_completed_at !== null;

const requireArtifactMetadata = (
  row: ArtifactCompletionRow,
  input: ArtifactRunCompletionSubmission,
  durableBinding = false,
): PreparedArtifactCompletionMetadata => {
  if (
    row.artifact_id !== input.artifactId ||
    row.artifact_job_id !== input.jobId ||
    row.artifact_run_attempt_id !== input.runAttemptId ||
    row.artifact_upload_status !== "committed"
  ) {
    if (durableBinding) throw new ArtifactCompletionStateInvalidError();
    throw new TerminalSubmissionConflictError();
  }
  if (
    row.artifact_purpose !== "result" ||
    row.artifact_media_type !== "application/json" ||
    !Number.isSafeInteger(row.artifact_total_bytes) ||
    (row.artifact_total_bytes as number) < 1 ||
    (row.artifact_total_bytes as number) > maximumResultArtifactBytes ||
    typeof row.artifact_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.artifact_sha256) ||
    row.storage_object_key !== `sha256/${row.artifact_sha256.slice(0, 2)}/${row.artifact_sha256}`
  ) {
    throw new ArtifactCompletionStateInvalidError();
  }
  return Object.freeze({
    artifactId: row.artifact_id,
    totalBytes: row.artifact_total_bytes as number,
    sha256: row.artifact_sha256,
    storageObjectKey: row.storage_object_key,
  });
};

const terminalReplay = (
  row: ArtifactCompletionRow,
  input: ArtifactRunCompletionSubmission,
): RunTerminalResponse => {
  if (row.attempt_status !== "succeeded") {
    if (hasBinding(row) || row.persisted_result_id !== null) {
      throw new ArtifactCompletionStateInvalidError();
    }
    throw new TerminalSubmissionConflictError();
  }
  if (
    row.binding_artifact_id === null ||
    row.binding_job_id === null ||
    row.binding_artifact_sha256 === null ||
    row.binding_result_digest === null ||
    row.binding_canonicalization_version !== 1 ||
    row.terminal_response_json === null ||
    row.binding_completed_at === null
  ) {
    throw new ArtifactCompletionStateInvalidError();
  }
  if (
    row.binding_artifact_id !== input.artifactId ||
    !securelyMatchesSha256(row.binding_result_digest, input.resultDigest)
  ) {
    throw new TerminalSubmissionConflictError();
  }
  const artifact = requireArtifactMetadata(row, input, true);
  const response = rebuildTerminalResponse(row.terminal_response_json);
  const bindingCompletedAt = requireCanonicalDateTime(row.binding_completed_at);
  if (
    artifact.sha256 !== row.binding_artifact_sha256 ||
    row.binding_job_id !== input.jobId ||
    row.result_digest !== row.binding_result_digest ||
    row.result_json === null ||
    requireCanonicalDateTime(row.ended_at) !== bindingCompletedAt ||
    row.job_status !== "succeeded" ||
    row.current_run_attempt_id !== null ||
    requireCanonicalDateTime(row.job_completed_at) !== bindingCompletedAt ||
    row.persisted_result_id === null ||
    row.persisted_result_digest !== row.result_digest ||
    row.persisted_result_json !== row.result_json ||
    response.jobId !== input.jobId ||
    response.runAttemptId !== input.runAttemptId ||
    response.jobState !== "succeeded" ||
    response.runState !== "succeeded"
  ) {
    throw new ArtifactCompletionStateInvalidError();
  }
  try {
    const validated = validateArtifactReviewCompletion(
      toReviewContext(row, input.runAttemptId),
      row.binding_result_digest,
      Buffer.from(row.result_json, "utf8"),
    );
    if (
      validated.canonicalResultJson !== row.result_json ||
      !securelyMatchesSha256(validated.resultDigest, row.binding_result_digest)
    ) {
      throw new ArtifactCompletionStateInvalidError();
    }
  } catch {
    throw new ArtifactCompletionStateInvalidError();
  }
  return response;
};

export const prepareArtifactCompletion = (
  database: DatabaseSync,
  input: ArtifactRunCompletionSubmission,
): PrepareArtifactCompletionResult => {
  if (!Value.Check(ArtifactRunCompletionSubmissionSchema, input)) {
    throw new TypeError("Artifact completion input is invalid.");
  }
  const row = queryCompletionRow(database, input.runAttemptId, input.artifactId);
  if (row === undefined) {
    throw new LeaseLostError();
  }
  const terminal = ["succeeded", "failed", "cancelled"].includes(row.attempt_status);
  if (!matchesLeaseIdentity(row, input)) {
    if (terminal && row.completion_mode === "result_artifact_v1") {
      throw new TerminalSubmissionConflictError();
    }
    throw new LeaseLostError();
  }
  if (row.completion_mode !== "result_artifact_v1") {
    throw new ArtifactCompletionModeMismatchError();
  }
  if (terminal) {
    return Object.freeze({
      disposition: "replayed",
      response: terminalReplay(row, input),
    });
  }
  if (hasBinding(row) || row.persisted_result_id !== null) {
    throw new ArtifactCompletionStateInvalidError();
  }
  const now = new Date().toISOString();
  const leaseExpiresAt = requireCanonicalDateTime(row.lease_expires_at);
  const executionDeadlineAt = requireCanonicalDateTime(row.execution_deadline_at);
  const noProgressDeadlineAt = requireCanonicalDateTime(row.no_progress_deadline_at);
  if (
    !["leased", "running"].includes(row.attempt_status) ||
    !["leased", "running"].includes(row.job_status) ||
    row.current_run_attempt_id !== input.runAttemptId ||
    leaseExpiresAt <= now ||
    executionDeadlineAt <= now ||
    noProgressDeadlineAt <= now ||
    row.worker_superseded_at !== null
  ) {
    throw new LeaseLostError();
  }
  if (row.work_item_id === null || row.request_epoch_id === null) {
    throw new ArtifactCompletionStateInvalidError();
  }
  return Object.freeze({
    disposition: "prepared",
    artifact: requireArtifactMetadata(row, input),
    reviewContext: Object.freeze(toReviewContext(row, input.runAttemptId)),
  });
};

const withImmediateTransaction = <T>(database: DatabaseSync, action: () => T): T => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const commitArtifactCompletion = (
  database: DatabaseSync,
  input: CommitArtifactCompletionInput,
): RunTerminalResponse =>
  withImmediateTransaction(database, () => {
    if (input.canonicalizationVersion !== 1 || typeof input.canonicalResultJson !== "string") {
      throw new TypeError("Artifact completion commit input is invalid.");
    }
    const submission: ArtifactRunCompletionSubmission = {
      jobId: input.jobId,
      runAttemptId: input.runAttemptId,
      workerNodeId: input.workerNodeId,
      workerInstanceId: input.workerInstanceId,
      leaseToken: input.leaseToken,
      leaseGeneration: input.leaseGeneration,
      artifactId: input.artifactId,
      resultDigest: input.resultDigest,
    };
    const prepared = prepareArtifactCompletion(database, submission);
    if (prepared.disposition === "replayed") {
      return prepared.response;
    }
    if (
      prepared.artifact.sha256 !== input.artifactSha256 ||
      prepared.artifact.totalBytes !== input.artifactTotalBytes ||
      prepared.artifact.storageObjectKey !== input.storageObjectKey
    ) {
      throw new ArtifactCompletionStateInvalidError();
    }

    let result: unknown;
    try {
      result = JSON.parse(input.canonicalResultJson) as unknown;
    } catch {
      throw new ArtifactCompletionStateInvalidError();
    }
    const canonicalResult = canonicalizeReviewResultSubmission(result);
    if (
      canonicalResult.canonicalResultJson !== input.canonicalResultJson ||
      !securelyMatchesSha256(canonicalResult.resultDigest, input.resultDigest)
    ) {
      throw new ResultDigestMismatchError();
    }
    const validated = validateReviewCompletion(
      prepared.reviewContext,
      input.resultDigest,
      result,
      canonicalResult,
    );
    const completedAt = new Date().toISOString();
    const terminalResponse: RunTerminalResponse = {
      jobId: input.jobId,
      runAttemptId: input.runAttemptId,
      jobState: "succeeded",
      runState: "succeeded",
    };
    const terminalResponseJson = JSON.stringify(terminalResponse);

    database
      .prepare(`
        INSERT INTO artifact_completion_bindings (
          run_attempt_id,
          job_id,
          artifact_id,
          artifact_sha256,
          result_digest,
          canonicalization_version,
          terminal_response_json,
          completed_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `)
      .run(
        input.runAttemptId,
        input.jobId,
        input.artifactId,
        input.artifactSha256,
        input.resultDigest,
        terminalResponseJson,
        completedAt,
      );

    const tokenHash = sha256(input.leaseToken);
    const attemptUpdate = database
      .prepare(`
        UPDATE run_attempts
        SET status = 'succeeded', result_digest = ?, result_json = ?, ended_at = ?
        WHERE id = ?
          AND job_id = ?
          AND worker_node_id = ?
          AND worker_instance_id = ?
          AND lease_token_hash = ?
          AND lease_generation = ?
          AND lease_expires_at > ?
          AND execution_deadline_at > ?
          AND no_progress_deadline_at > ?
          AND status IN ('leased', 'running')
          AND completion_mode = 'result_artifact_v1'
          AND EXISTS (
            SELECT 1 FROM jobs
            WHERE jobs.id = run_attempts.job_id
              AND jobs.current_run_attempt_id = run_attempts.id
              AND jobs.status IN ('leased', 'running')
          )
      `)
      .run(
        validated.resultDigest,
        validated.canonicalResultJson,
        completedAt,
        input.runAttemptId,
        input.jobId,
        input.workerNodeId,
        input.workerInstanceId,
        tokenHash,
        input.leaseGeneration,
        completedAt,
        completedAt,
        completedAt,
      );
    if (Number(attemptUpdate.changes) !== 1) {
      throw new LeaseLostError();
    }

    persistValidatedReviewResult(database, prepared.reviewContext, validated, completedAt);
    const jobUpdate = database
      .prepare(`
        UPDATE jobs
        SET
          status = 'succeeded',
          current_run_attempt_id = NULL,
          current_step = NULL,
          completed_at = ?,
          failure_code = NULL,
          failure_message = NULL,
          updated_at = ?
        WHERE id = ?
          AND current_run_attempt_id = ?
          AND status IN ('leased', 'running')
      `)
      .run(completedAt, completedAt, input.jobId, input.runAttemptId);
    if (Number(jobUpdate.changes) !== 1) {
      throw new LeaseLostError();
    }
    database
      .prepare(`
        UPDATE workers
        SET
          status = CASE WHEN status = 'offline' THEN 'online' ELSE status END,
          last_seen_at = ?,
          updated_at = ?
        WHERE node_id = ? AND instance_id = ? AND superseded_at IS NULL
      `)
      .run(completedAt, completedAt, input.workerNodeId, input.workerInstanceId);
    return Object.freeze(terminalResponse);
  });
