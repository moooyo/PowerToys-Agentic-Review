import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import {
  type DashboardJobListQuery,
  type DashboardWorkerListQuery,
  type DashboardWorkItemListQuery,
  type JobExecutionEnvelope,
  JobExecutionEnvelopeSchema,
  type JobExecutionTemplate,
  JobExecutionTemplateSchema,
  maximumClaimLeaseResponseUtf8Bytes,
  type RunTerminalResponse,
  RunTerminalResponseSchema,
} from "@agentic-review/contracts";
import { resolveExpiredAttempt } from "@agentic-review/domain";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { GitHubPollingProjectionKey } from "../github/poller.js";
import type {
  BeginOperatorLoginInput,
  ClaimOperatorLoginTransactionInput,
  CreateOperatorSessionInput,
  DeleteOperatorBrowserFlowInput,
  DeleteOperatorSessionInput,
  FinalizeOperatorLoginInput,
  FindOperatorSessionInput,
} from "../security/operator-auth.js";
import {
  type ClassifyArtifactNamespacePageInput,
  type CommitArtifactChunkInput,
  type CommitArtifactFinalizeInput,
  type CompleteArtifactCleanupInput,
  type CompleteArtifactNamespaceCleanupInput,
  type CreateArtifactUploadInput,
  classifyArtifactNamespacePageAndAdvanceCursor,
  commitArtifactChunk,
  commitArtifactFinalize,
  completeArtifactCleanup,
  completeArtifactNamespaceCleanup,
  createArtifactUpload,
  type ListDueArtifactCleanupsInput,
  type ListDueArtifactNamespaceCleanupsInput,
  listDueArtifactCleanups,
  listDueArtifactNamespaceCleanups,
  type PrepareArtifactChunkInput,
  type PrepareArtifactFinalizeInput,
  prepareArtifactChunk,
  prepareArtifactFinalize,
  probeArtifactUploadCreate,
  type RecordArtifactCleanupFailureInput,
  type RecordArtifactNamespaceCleanupFailureInput,
  readArtifactHealthAccounting,
  readArtifactReconciliationCursor,
  recordArtifactCleanupFailure,
  recordArtifactNamespaceCleanupFailure,
  type TerminalizeInactiveArtifactUploadsInput,
  type TerminateArtifactUploadInput,
  terminalizeInactiveArtifactUploads,
  terminateArtifactUpload,
} from "./artifacts.js";
import { getSystemSnapshot, listJobs, listWorkers, listWorkItems } from "./dashboard-queries.js";
import { adoptLegacyDatabase } from "./database-initialization.js";
import { completeDatabaseShutdown } from "./database-shutdown.js";
import {
  LeaseLostError,
  ResultDigestMismatchError,
  TerminalSubmissionConflictError,
  WorkerInstanceSupersededError,
  WorkerUnavailableError,
} from "./errors.js";
import { ingestSchedulingEvent } from "./github-ingestion.js";
import {
  type CommitGitHubPollingReconciliationInput,
  commitGitHubPollingReconciliation,
  readGitHubPollingProjection,
  type WriteGitHubPollingProjectionInput,
  writeGitHubPollingProjection,
} from "./github-polling-state.js";
import { cleanupIncompleteMigrationBackups, createMigrationBackup } from "./migration-backup.js";
import { inspectMigrationState, type MigrationState, runMigrations } from "./migrations.js";
import {
  beginOperatorLogin,
  type CleanupExpiredOperatorAuthInput,
  claimOperatorLoginTransaction,
  cleanupExpiredOperatorAuth,
  createOperatorSession,
  deleteOperatorBrowserFlow,
  deleteOperatorSession,
  finalizeOperatorLogin,
  findOperatorSession,
} from "./operator-auth.js";
import type {
  ClaimLeaseInput,
  ClaimLeaseResult,
  DatabaseHealth,
  DatabaseRequest,
  DatabaseWorkerOptions,
  HeartbeatLeaseInput,
  HeartbeatLeaseResult,
  HeartbeatWorkerInput,
  IngestSchedulingEventInput,
  LeaseCompletionInput,
  LeaseFailureInput,
  LeaseTerminalResult,
  ReapExpiredLeasesInput,
  RegisteredWorker,
  RegisterWorkerInput,
} from "./protocol.js";
import {
  canonicalizeLegacyReviewResultSubmission,
  canonicalizeReviewResultSubmission,
  persistValidatedReviewResult,
  type ReviewCompletionJobContext,
  validateReviewCompletion,
} from "./review-results.js";
import { DatabaseStorageBinding } from "./storage-security.js";

interface WorkerRow {
  readonly id: string;
  readonly node_id: string;
  readonly instance_id: string;
  readonly max_slots: number;
  readonly capabilities_json: string;
  readonly capabilities_digest: string;
  readonly status: "online" | "draining" | "offline" | "disabled";
}

interface JobCandidateRow {
  readonly id: string;
  readonly job_kind: "issue_triage" | "pull_request_review";
  readonly generation: number;
  readonly intent_version: number;
  readonly semantic_key: string;
  readonly priority: number;
  readonly execution_json: string;
  readonly required_capabilities_json: string;
  readonly next_attempt_at: string;
  readonly created_at: string;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly lease_generation: number;
}

interface HeartbeatRow {
  readonly job_id: string;
  readonly worker_node_id: string;
  readonly worker_instance_id: string;
  readonly status: string;
  readonly lease_token_hash: string;
  readonly lease_generation: number;
  readonly lease_expires_at: string;
  readonly execution_deadline_at: string;
  readonly no_progress_timeout_ms: number;
  readonly no_progress_deadline_at: string;
  readonly progress_sequence: number;
  readonly job_status: string;
  readonly cancellation_requested_at: string | null;
  readonly current_run_attempt_id: string | null;
  readonly worker_status: string;
  readonly worker_superseded_at: string | null;
}

interface TerminalAttemptRow extends HeartbeatRow {
  readonly completion_mode: "inline_result_v1" | "result_artifact_v1";
  readonly result_digest: string | null;
  readonly result_json: string | null;
  readonly failure_code: string | null;
  readonly failure_message: string | null;
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
  readonly persisted_result_id: string | null;
  readonly persisted_result_digest: string | null;
  readonly persisted_result_json: string | null;
  readonly legacy_replay_id: string | null;
  readonly legacy_result_digest: string | null;
  readonly legacy_result_json: string | null;
}

interface FailureTerminalPayload {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

interface FailureTerminalReplayRecord {
  readonly version: 1;
  readonly terminalOutcome: "failure";
  readonly payload: FailureTerminalPayload;
  readonly response: RunTerminalResponse;
}

interface ExpiredAttemptRow {
  readonly id: string;
  readonly job_id: string;
  readonly lease_expires_at: string;
  readonly execution_deadline_at: string;
  readonly no_progress_deadline_at: string;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly job_status: string;
  readonly cancellation_requested_at: string | null;
}

type AttemptTimeoutFailure =
  | {
      readonly code: "worker_heartbeat_timeout";
      readonly message: "The worker did not renew the lease before it expired.";
    }
  | {
      readonly code: "execution_deadline_exceeded";
      readonly message: "The run attempt exceeded its hard execution deadline.";
    }
  | {
      readonly code: "no_progress_timeout";
      readonly message: "The run attempt did not report progress before its no-progress deadline.";
    };

const port = parentPort;
if (port === null) {
  throw new Error("The database worker requires a parent message port.");
}

const options = workerData as DatabaseWorkerOptions;
let database: DatabaseSync;
let schemaVersion = 0;
const claimCandidatePageSize = 100;

FormatRegistry.Set(
  "date-time",
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)),
);
FormatRegistry.Set("uri", (value) => URL.canParse(value));

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] ?? null)}`);
  return `{${entries.join(",")}}`;
};

const parseJson = (value: string): unknown => JSON.parse(value) as unknown;

const calculateDeadline = (now: Date, timeoutMs: number): string => {
  const deadline = new Date(now.getTime() + timeoutMs);
  if (Number.isNaN(deadline.getTime())) {
    throw new Error("The job execution policy produces an invalid deadline.");
  }
  return deadline.toISOString();
};

const selectAttemptTimeoutFailure = (
  attempt: Pick<
    ExpiredAttemptRow,
    "lease_expires_at" | "execution_deadline_at" | "no_progress_deadline_at"
  >,
): AttemptTimeoutFailure => {
  const deadlines = [
    {
      deadline: attempt.execution_deadline_at,
      priority: 0,
      code: "execution_deadline_exceeded",
      message: "The run attempt exceeded its hard execution deadline.",
    },
    {
      deadline: attempt.no_progress_deadline_at,
      priority: 1,
      code: "no_progress_timeout",
      message: "The run attempt did not report progress before its no-progress deadline.",
    },
    {
      deadline: attempt.lease_expires_at,
      priority: 2,
      code: "worker_heartbeat_timeout",
      message: "The worker did not renew the lease before it expired.",
    },
  ] satisfies Array<
    AttemptTimeoutFailure & {
      readonly deadline: string;
      readonly priority: number;
    }
  >;

  deadlines.sort(
    (left, right) => left.deadline.localeCompare(right.deadline) || left.priority - right.priority,
  );
  const failure = deadlines[0];
  if (failure === undefined) {
    throw new Error("An active run attempt has no deadlines.");
  }
  return failure;
};

const capabilityAtPath = (capabilities: unknown, path: string): unknown => {
  let current = capabilities;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const satisfiesRequirement = (actual: unknown, required: unknown): boolean => {
  if (Array.isArray(required)) {
    return required.every((requirement) => {
      if (typeof requirement !== "string") {
        return false;
      }

      const direct = capabilityAtPath(actual, requirement);
      if (direct === true || direct === requirement) {
        return true;
      }

      if (actual !== null && typeof actual === "object") {
        const recipeIds = (actual as Record<string, unknown>).recipeIds;
        return Array.isArray(recipeIds) && recipeIds.includes(requirement);
      }

      return false;
    });
  }

  if (required !== null && typeof required === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      return false;
    }

    const actualRecord = actual as Record<string, unknown>;
    return Object.entries(required as Record<string, unknown>).every(([key, expected]) =>
      satisfiesRequirement(actualRecord[key], expected),
    );
  }

  if (Array.isArray(actual)) {
    return actual.includes(required);
  }

  return Object.is(actual, required);
};

const withImmediateTransaction = <T>(action: () => T): T => {
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

type ExecutionTemplateParseResult =
  | { readonly ok: true; readonly template: JobExecutionTemplate }
  | { readonly ok: false; readonly message: string };

const parseExecutionTemplate = (serializedTemplate: string): ExecutionTemplateParseResult => {
  let value: unknown;
  try {
    value = parseJson(serializedTemplate);
  } catch {
    return {
      ok: false,
      message: "Stored execution_json is not valid JSON.",
    };
  }

  if (!Value.Check(JobExecutionTemplateSchema, value)) {
    return {
      ok: false,
      message: "Stored execution_json does not match JobExecutionTemplateSchema.",
    };
  }

  return { ok: true, template: value };
};

const deadLetterClaimCandidate = (
  jobId: string,
  now: string,
  failureCode:
    | "invalid_execution_template"
    | "invalid_execution_envelope"
    | "claim_response_too_large",
  failureMessage: string,
): void => {
  const update = database
    .prepare(`
      UPDATE jobs
      SET
        status = 'dead_letter',
        current_run_attempt_id = NULL,
        current_step = NULL,
        completed_at = ?,
        failure_code = ?,
        failure_message = ?,
        updated_at = ?
      WHERE id = ?
        AND status IN ('queued', 'retry_waiting')
        AND current_run_attempt_id IS NULL
    `)
    .run(now, failureCode, failureMessage, now, jobId);
  if (Number(update.changes) !== 1) {
    throw new Error("The invalid job could not be dead-lettered atomically.");
  }
};

const registerWorker = (input: RegisterWorkerInput): RegisteredWorker => {
  const now = new Date().toISOString();
  const capabilitiesJson = canonicalJson(input.capabilities);
  const capabilitiesDigest = hash(capabilitiesJson);

  return withImmediateTransaction(() => {
    const existingInstance = database
      .prepare(`
        SELECT superseded_at
        FROM workers
        WHERE node_id = ? AND instance_id = ?
      `)
      .get(input.workerNodeId, input.workerInstanceId) as unknown as
      | { readonly superseded_at: string | null }
      | undefined;
    if (existingInstance !== undefined && existingInstance.superseded_at !== null) {
      throw new WorkerInstanceSupersededError();
    }

    database
      .prepare(`
        UPDATE workers
        SET
          status = 'offline',
          superseded_at = COALESCE(superseded_at, ?),
          updated_at = ?
        WHERE node_id = ?
          AND instance_id <> ?
          AND superseded_at IS NULL
      `)
      .run(now, now, input.workerNodeId, input.workerInstanceId);

    const row = database
      .prepare(`
        INSERT INTO workers (
          id,
          node_id,
          instance_id,
          display_name,
          version,
          protocol_version,
          max_slots,
          capabilities_json,
          capabilities_digest,
          status,
          registered_at,
          last_seen_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?)
        ON CONFLICT (node_id, instance_id) DO UPDATE SET
          display_name = excluded.display_name,
          version = excluded.version,
          protocol_version = excluded.protocol_version,
          max_slots = excluded.max_slots,
          capabilities_json = excluded.capabilities_json,
          capabilities_digest = excluded.capabilities_digest,
          status = CASE
            WHEN workers.status IN ('disabled', 'draining')
              OR workers.superseded_at IS NOT NULL
              THEN workers.status
            ELSE 'online'
          END,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
        RETURNING id, status
      `)
      .get(
        randomUUID(),
        input.workerNodeId,
        input.workerInstanceId,
        input.displayName,
        input.workerVersion,
        input.protocolVersion,
        input.maxSlots,
        capabilitiesJson,
        capabilitiesDigest,
        now,
        now,
        now,
      ) as unknown as Pick<WorkerRow, "id" | "status"> | undefined;

    if (row === undefined) {
      throw new Error("Worker registration did not return a worker record.");
    }

    return {
      workerId: row.id,
      status: row.status,
      capabilitiesDigest,
    };
  });
};

const heartbeatWorker = (input: HeartbeatWorkerInput): { readonly state: WorkerRow["status"] } => {
  const now = new Date().toISOString();
  const healthJson = canonicalJson(input.health);
  const row = database
    .prepare(`
      UPDATE workers
      SET
        status = CASE
          WHEN status = 'offline' THEN 'online'
          ELSE status
        END,
        heartbeat_sequence = MAX(heartbeat_sequence, ?),
        available_slots = ?,
        health_json = CASE
          WHEN ? >= heartbeat_sequence THEN ?
          ELSE health_json
        END,
        last_seen_at = ?,
        updated_at = ?
      WHERE node_id = ?
        AND instance_id = ?
        AND heartbeat_sequence <= ?
        AND superseded_at IS NULL
        AND status IN ('online', 'draining', 'offline', 'disabled')
      RETURNING status
    `)
    .get(
      input.heartbeatSequence,
      input.availableSlots,
      input.heartbeatSequence,
      healthJson,
      now,
      now,
      input.workerNodeId,
      input.workerInstanceId,
      input.heartbeatSequence,
    ) as unknown as Pick<WorkerRow, "status"> | undefined;

  if (row === undefined) {
    throw new WorkerUnavailableError();
  }
  return { state: row.status };
};

const claimLease = (input: ClaimLeaseInput): ClaimLeaseResult =>
  withImmediateTransaction(() => {
    const now = new Date();
    const nowText = now.toISOString();
    const worker = database
      .prepare(`
        SELECT
          id,
          node_id,
          instance_id,
          max_slots,
          capabilities_json,
          capabilities_digest,
          status
        FROM workers
        WHERE node_id = ? AND instance_id = ?
      `)
      .get(input.workerNodeId, input.workerInstanceId) as unknown as WorkerRow | undefined;

    if (worker === undefined) {
      return { outcome: "worker_unavailable", reason: "not_registered" };
    }
    if (worker.status !== "online") {
      return {
        outcome: "worker_unavailable",
        reason:
          worker.status === "draining" || worker.status === "disabled"
            ? worker.status
            : "not_online",
      };
    }
    const registeredProtocol = database
      .prepare("SELECT protocol_version FROM workers WHERE id = ?")
      .get(worker.id) as unknown as { readonly protocol_version: string };
    if (registeredProtocol.protocol_version !== input.protocolVersion) {
      return {
        outcome: "worker_unavailable",
        reason: "upgrade_required",
      };
    }
    if (worker.capabilities_digest !== input.capabilitiesDigest) {
      return {
        outcome: "worker_unavailable",
        reason: "capabilities_changed",
      };
    }

    const activeRow = database
      .prepare(`
        SELECT COUNT(*) AS active_count
        FROM run_attempts
        WHERE worker_id = ?
          AND worker_instance_id = ?
          AND status IN ('leased', 'running')
      `)
      .get(worker.id, input.workerInstanceId) as unknown as {
      readonly active_count: number;
    };
    if (input.availableSlots <= 0 || activeRow.active_count >= worker.max_slots) {
      return {
        outcome: "worker_unavailable",
        reason: "no_available_slots",
      };
    }

    database
      .prepare("UPDATE workers SET last_seen_at = ?, updated_at = ? WHERE id = ?")
      .run(nowText, nowText, worker.id);

    const capabilities = parseJson(worker.capabilities_json);
    let cursor: JobCandidateRow | undefined;
    while (true) {
      const candidates = database
        .prepare(`
        SELECT
          candidate.id,
          candidate.job_kind,
          candidate.generation,
          candidate.intent_version,
          candidate.semantic_key,
          candidate.priority,
          candidate.execution_json,
          candidate.required_capabilities_json,
          candidate.next_attempt_at,
          candidate.created_at,
          candidate.attempt_count,
          candidate.max_attempts,
          candidate.lease_generation
        FROM jobs AS candidate
        WHERE candidate.status IN ('queued', 'retry_waiting')
          AND candidate.next_attempt_at <= ?
          AND candidate.attempt_count < candidate.max_attempts
          AND candidate.current_run_attempt_id IS NULL
          AND (
            candidate.execution_affinity_node_id IS NULL
            OR candidate.execution_affinity_node_id = ?
          )
          AND NOT EXISTS (
            SELECT 1
            FROM jobs AS active
            WHERE active.id <> candidate.id
              AND active.concurrency_key = candidate.concurrency_key
              AND active.status IN ('leased', 'running', 'cancel_requested')
          )
          AND (
            ? IS NULL
            OR candidate.priority < ?
            OR (
              candidate.priority = ?
              AND candidate.next_attempt_at > ?
            )
            OR (
              candidate.priority = ?
              AND candidate.next_attempt_at = ?
              AND candidate.created_at > ?
            )
            OR (
              candidate.priority = ?
              AND candidate.next_attempt_at = ?
              AND candidate.created_at = ?
              AND candidate.id > ?
            )
          )
        ORDER BY
          candidate.priority DESC,
          candidate.next_attempt_at,
          candidate.created_at,
          candidate.id
        LIMIT ?
      `)
        .all(
          nowText,
          input.workerNodeId,
          cursor?.id ?? null,
          cursor?.priority ?? null,
          cursor?.priority ?? null,
          cursor?.next_attempt_at ?? null,
          cursor?.priority ?? null,
          cursor?.next_attempt_at ?? null,
          cursor?.created_at ?? null,
          cursor?.priority ?? null,
          cursor?.next_attempt_at ?? null,
          cursor?.created_at ?? null,
          cursor?.id ?? null,
          claimCandidatePageSize,
        ) as unknown as JobCandidateRow[];
      if (candidates.length === 0) {
        return { outcome: "no_work", retryAfterMs: 1_000 };
      }

      for (const candidate of candidates) {
        const parsedTemplate = parseExecutionTemplate(candidate.execution_json);
        if (!parsedTemplate.ok) {
          deadLetterClaimCandidate(
            candidate.id,
            nowText,
            "invalid_execution_template",
            parsedTemplate.message,
          );
          continue;
        }

        let requiredCapabilities: unknown;
        try {
          requiredCapabilities = parseJson(candidate.required_capabilities_json);
        } catch {
          deadLetterClaimCandidate(
            candidate.id,
            nowText,
            "invalid_execution_template",
            "Stored required_capabilities_json is not valid JSON.",
          );
          continue;
        }
        if (!satisfiesRequirement(capabilities, requiredCapabilities)) {
          continue;
        }

        const { template } = parsedTemplate;
        const executionDeadlineAt = calculateDeadline(now, template.executionPolicy.hardTimeoutMs);
        const noProgressDeadlineAt = calculateDeadline(
          now,
          template.executionPolicy.noProgressTimeoutMs,
        );
        const requestedLeaseExpiresAt = calculateDeadline(now, input.leaseTtlSeconds * 1_000);
        const leaseExpiresAt =
          requestedLeaseExpiresAt < executionDeadlineAt
            ? requestedLeaseExpiresAt
            : executionDeadlineAt;

        const runAttemptId = randomUUID();
        const leaseToken = randomBytes(32).toString("base64url");
        const leaseTokenHash = hash(leaseToken);
        const leaseGeneration = candidate.lease_generation + 1;
        const attemptNumber = candidate.attempt_count + 1;
        const envelopeCandidate = {
          ...template,
          protocolVersion: input.protocolVersion,
          envelopeVersion: 1,
          assignedAt: nowText,
          leaseExpiresAt,
          executionDeadlineAt,
          lease: {
            jobId: candidate.id,
            runAttemptId,
            workerNodeId: input.workerNodeId,
            workerInstanceId: input.workerInstanceId,
            leaseToken,
            leaseGeneration,
          },
          job: {
            jobId: candidate.id,
            kind: candidate.job_kind,
            priority: candidate.priority,
            attempt: attemptNumber,
            maxAttempts: candidate.max_attempts,
            generation: candidate.generation,
            intentVersion: candidate.intent_version,
            semanticKey: candidate.semantic_key,
          },
        };
        if (!Value.Check(JobExecutionEnvelopeSchema, envelopeCandidate)) {
          deadLetterClaimCandidate(
            candidate.id,
            nowText,
            "invalid_execution_envelope",
            "Server-generated execution envelope does not match JobExecutionEnvelopeSchema.",
          );
          continue;
        }
        const envelope: JobExecutionEnvelope = envelopeCandidate;
        const claimResponseBytes = Buffer.byteLength(
          JSON.stringify({ outcome: "granted", envelope, serverTime: nowText }),
          "utf8",
        );
        if (claimResponseBytes > maximumClaimLeaseResponseUtf8Bytes) {
          deadLetterClaimCandidate(
            candidate.id,
            nowText,
            "claim_response_too_large",
            `Server-generated claim response is ${claimResponseBytes} bytes; maximum is ${maximumClaimLeaseResponseUtf8Bytes}.`,
          );
          continue;
        }

        const update = database
          .prepare(`
          UPDATE jobs
          SET
            status = 'leased',
            attempt_count = ?,
            lease_generation = ?,
            current_run_attempt_id = ?,
            current_step = 'leased',
            started_at = COALESCE(started_at, ?),
            failure_code = NULL,
            failure_message = NULL,
            updated_at = ?
          WHERE id = ?
            AND status IN ('queued', 'retry_waiting')
            AND current_run_attempt_id IS NULL
        `)
          .run(attemptNumber, leaseGeneration, runAttemptId, nowText, nowText, candidate.id);
        if (Number(update.changes) !== 1) {
          throw new Error("The selected job could not be leased atomically.");
        }

        // Artifact completion is rollout-gated; normal claims intentionally use the DB inline default.
        database
          .prepare(`
          INSERT INTO run_attempts (
            id,
            job_id,
            attempt_number,
            worker_id,
            worker_node_id,
            worker_instance_id,
            status,
            lease_token_hash,
            lease_generation,
            lease_expires_at,
            execution_deadline_at,
            no_progress_timeout_ms,
            no_progress_deadline_at,
            last_heartbeat_at,
            phase,
            progress_sequence,
            started_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, 'leased', ?, ?, ?, ?, ?, ?, ?, 'leased', 0, ?
          )
        `)
          .run(
            runAttemptId,
            candidate.id,
            attemptNumber,
            worker.id,
            input.workerNodeId,
            input.workerInstanceId,
            leaseTokenHash,
            leaseGeneration,
            leaseExpiresAt,
            executionDeadlineAt,
            template.executionPolicy.noProgressTimeoutMs,
            noProgressDeadlineAt,
            nowText,
            nowText,
          );

        return {
          outcome: "granted",
          envelope,
        };
      }

      cursor = candidates.at(-1);
      if (cursor === undefined) {
        return { outcome: "no_work", retryAfterMs: 1_000 };
      }
    }
  });

const securelyMatchesHash = (actual: string, expected: string): boolean => {
  if (!/^[a-f0-9]{64}$/u.test(actual) || !/^[a-f0-9]{64}$/u.test(expected)) {
    return false;
  }
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

const matchesTerminalLeaseIdentity = (
  row: TerminalAttemptRow,
  input: LeaseCompletionInput | LeaseFailureInput,
  leaseTokenHash: string,
): boolean =>
  row.job_id === input.jobId &&
  row.worker_node_id === input.workerNodeId &&
  row.worker_instance_id === input.workerInstanceId &&
  row.lease_generation === input.leaseGeneration &&
  securelyMatchesHash(row.lease_token_hash, leaseTokenHash);

const isTerminalAttemptState = (status: string): status is "succeeded" | "failed" | "cancelled" =>
  status === "succeeded" || status === "failed" || status === "cancelled";

const failureTerminalPayload = (input: LeaseFailureInput): FailureTerminalPayload => ({
  code: input.failureCode,
  message: input.failureMessage,
  retryable: input.retryable,
});

const parseFailureTerminalReplayRecord = (
  serialized: string | null,
): FailureTerminalReplayRecord | null => {
  if (serialized === null) {
    return null;
  }

  let value: unknown;
  try {
    value = parseJson(serialized);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const payload = record.payload;
  const response = record.response;
  if (
    record.version !== 1 ||
    record.terminalOutcome !== "failure" ||
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Value.Check(RunTerminalResponseSchema, response)
  ) {
    return null;
  }

  const payloadRecord = payload as Record<string, unknown>;
  if (
    typeof payloadRecord.code !== "string" ||
    typeof payloadRecord.message !== "string" ||
    typeof payloadRecord.retryable !== "boolean"
  ) {
    return null;
  }

  return {
    version: 1,
    terminalOutcome: "failure",
    payload: {
      code: payloadRecord.code,
      message: payloadRecord.message,
      retryable: payloadRecord.retryable,
    },
    response,
  };
};

const heartbeatLease = (input: HeartbeatLeaseInput): HeartbeatLeaseResult =>
  withImmediateTransaction(() => {
    const now = new Date();
    const nowText = now.toISOString();
    const tokenHash = hash(input.leaseToken);
    const row = database
      .prepare(`
        SELECT
          attempt.job_id,
          attempt.worker_node_id,
          attempt.worker_instance_id,
          attempt.status,
          attempt.lease_token_hash,
          attempt.lease_generation,
          attempt.lease_expires_at,
          attempt.execution_deadline_at,
          attempt.no_progress_timeout_ms,
          attempt.no_progress_deadline_at,
          attempt.progress_sequence,
          job.status AS job_status,
          job.cancellation_requested_at,
          job.current_run_attempt_id,
          worker.status AS worker_status,
          worker.superseded_at AS worker_superseded_at
        FROM run_attempts AS attempt
        JOIN jobs AS job ON job.id = attempt.job_id
        JOIN workers AS worker ON worker.id = attempt.worker_id
        WHERE attempt.id = ?
      `)
      .get(input.runAttemptId) as unknown as HeartbeatRow | undefined;

    if (
      row === undefined ||
      row.job_id !== input.jobId ||
      row.worker_node_id !== input.workerNodeId ||
      row.worker_instance_id !== input.workerInstanceId ||
      row.lease_generation !== input.leaseGeneration ||
      !securelyMatchesHash(row.lease_token_hash, tokenHash) ||
      !["leased", "running"].includes(row.status) ||
      row.current_run_attempt_id !== input.runAttemptId ||
      row.lease_expires_at <= nowText ||
      row.execution_deadline_at <= nowText ||
      row.no_progress_deadline_at <= nowText ||
      row.worker_superseded_at !== null ||
      !["leased", "running", "cancel_requested"].includes(row.job_status) ||
      !["online", "draining", "disabled"].includes(row.worker_status)
    ) {
      throw new LeaseLostError();
    }

    const command: HeartbeatLeaseResult["command"] =
      row.cancellation_requested_at !== null || row.job_status === "cancel_requested"
        ? "cancel"
        : row.worker_status === "draining" || row.worker_status === "disabled"
          ? "drain"
          : "continue";
    const requestedLeaseExpiresAt = calculateDeadline(now, input.leaseTtlSeconds * 1_000);
    const leaseExpiresAt =
      requestedLeaseExpiresAt < row.execution_deadline_at
        ? requestedLeaseExpiresAt
        : row.execution_deadline_at;
    const noProgressDeadlineAt =
      input.progressSequence > row.progress_sequence
        ? calculateDeadline(now, row.no_progress_timeout_ms)
        : row.no_progress_deadline_at;
    const progressJson = canonicalJson(input.progress);

    const update = database
      .prepare(`
        UPDATE run_attempts
        SET
          status = CASE WHEN status = 'leased' THEN 'running' ELSE status END,
          lease_expires_at = ?,
          last_heartbeat_at = ?,
          no_progress_deadline_at = CASE
            WHEN ? > progress_sequence THEN ?
            ELSE no_progress_deadline_at
          END,
          phase = CASE WHEN ? >= progress_sequence THEN ? ELSE phase END,
          progress_json = CASE
            WHEN ? >= progress_sequence THEN ?
            ELSE progress_json
          END,
          progress_sequence = MAX(progress_sequence, ?)
        WHERE id = ?
          AND worker_node_id = ?
          AND worker_instance_id = ?
          AND lease_token_hash = ?
          AND lease_generation = ?
          AND lease_expires_at > ?
          AND execution_deadline_at > ?
          AND no_progress_deadline_at > ?
          AND status IN ('leased', 'running')
          AND EXISTS (
            SELECT 1
            FROM jobs
            WHERE jobs.id = run_attempts.job_id
              AND jobs.current_run_attempt_id = run_attempts.id
              AND jobs.status IN ('leased', 'running', 'cancel_requested')
          )
      `)
      .run(
        leaseExpiresAt,
        nowText,
        input.progressSequence,
        noProgressDeadlineAt,
        input.progressSequence,
        input.phase,
        input.progressSequence,
        progressJson,
        input.progressSequence,
        input.runAttemptId,
        input.workerNodeId,
        input.workerInstanceId,
        tokenHash,
        input.leaseGeneration,
        nowText,
        nowText,
        nowText,
      );
    if (Number(update.changes) !== 1) {
      throw new LeaseLostError();
    }

    database
      .prepare(`
        UPDATE jobs
        SET
          status = CASE WHEN status = 'leased' THEN 'running' ELSE status END,
          current_step = ?,
          updated_at = ?
        WHERE id = ? AND current_run_attempt_id = ?
      `)
      .run(input.phase, nowText, row.job_id, input.runAttemptId);
    database
      .prepare(`
        UPDATE workers
        SET last_seen_at = ?, updated_at = ?
        WHERE node_id = ? AND instance_id = ?
      `)
      .run(nowText, nowText, input.workerNodeId, input.workerInstanceId);

    return { leaseExpiresAt, command };
  });

const completeLease = (input: LeaseCompletionInput): LeaseTerminalResult =>
  withImmediateTransaction(() => {
    const now = new Date().toISOString();
    const tokenHash = hash(input.leaseToken);
    const fence = database
      .prepare(`
        SELECT
          attempt.job_id,
          attempt.worker_node_id,
          attempt.worker_instance_id,
          attempt.status,
          attempt.completion_mode,
          attempt.lease_token_hash,
          attempt.lease_generation,
          attempt.lease_expires_at,
          attempt.execution_deadline_at,
          attempt.no_progress_timeout_ms,
          attempt.no_progress_deadline_at,
          attempt.progress_sequence,
          attempt.result_digest,
          attempt.result_json,
          attempt.failure_code,
          attempt.failure_message,
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
          persisted_result.id AS persisted_result_id,
          persisted_result.result_digest AS persisted_result_digest,
          persisted_result.result_json AS persisted_result_json,
          legacy_replay.run_attempt_id AS legacy_replay_id,
          legacy_replay.result_digest AS legacy_result_digest,
          legacy_replay.result_json AS legacy_result_json,
          job.status AS job_status,
          job.cancellation_requested_at,
          job.current_run_attempt_id,
          worker.status AS worker_status,
          worker.superseded_at AS worker_superseded_at
        FROM run_attempts AS attempt
        JOIN jobs AS job ON job.id = attempt.job_id
        JOIN workers AS worker ON worker.id = attempt.worker_id
        LEFT JOIN work_items AS item ON item.id = job.work_item_id
        LEFT JOIN work_item_revisions AS revision
          ON revision.work_item_id = job.work_item_id
          AND revision.revision_key = job.resource_revision
        LEFT JOIN review_results AS persisted_result
          ON persisted_result.run_attempt_id = attempt.id
        LEFT JOIN legacy_review_result_replays AS legacy_replay
          ON legacy_replay.run_attempt_id = attempt.id
        WHERE attempt.id = ?
      `)
      .get(input.runAttemptId) as unknown as TerminalAttemptRow | undefined;
    if (fence === undefined || !matchesTerminalLeaseIdentity(fence, input, tokenHash)) {
      throw new LeaseLostError();
    }
    if (fence.completion_mode !== "inline_result_v1") {
      throw new TerminalSubmissionConflictError();
    }

    if (isTerminalAttemptState(fence.status) && fence.legacy_replay_id !== null) {
      const legacyCanonicalResult = canonicalizeLegacyReviewResultSubmission(input.result);
      if (
        fence.status === "succeeded" &&
        fence.result_digest !== null &&
        fence.result_json === legacyCanonicalResult.canonicalResultJson &&
        fence.legacy_result_digest === fence.result_digest &&
        fence.legacy_result_json === fence.result_json &&
        securelyMatchesHash(input.resultDigest, fence.result_digest) &&
        securelyMatchesHash(legacyCanonicalResult.resultDigest, fence.result_digest)
      ) {
        return {
          jobId: input.jobId,
          runAttemptId: input.runAttemptId,
          jobState: "succeeded",
          runState: "succeeded",
        };
      }
      throw new TerminalSubmissionConflictError();
    }

    const canonicalResult = canonicalizeReviewResultSubmission(input.result);
    const resultJson = canonicalResult.canonicalResultJson;
    const expectedResultDigest = canonicalResult.resultDigest;
    if (isTerminalAttemptState(fence.status)) {
      const requiresPersistedResult = isPersistedReviewJob(fence);
      if (
        fence.status === "succeeded" &&
        fence.result_digest !== null &&
        fence.result_json === resultJson &&
        (fence.persisted_result_id !== null) === requiresPersistedResult &&
        (fence.persisted_result_id === null ||
          (fence.persisted_result_digest === fence.result_digest &&
            fence.persisted_result_json === fence.result_json)) &&
        securelyMatchesHash(input.resultDigest, fence.result_digest) &&
        securelyMatchesHash(expectedResultDigest, fence.result_digest)
      ) {
        return {
          jobId: input.jobId,
          runAttemptId: input.runAttemptId,
          jobState: "succeeded",
          runState: "succeeded",
        };
      }
      throw new TerminalSubmissionConflictError();
    }

    if (
      !["leased", "running"].includes(fence.status) ||
      !["leased", "running"].includes(fence.job_status) ||
      fence.current_run_attempt_id !== input.runAttemptId ||
      fence.lease_expires_at <= now ||
      fence.execution_deadline_at <= now ||
      fence.no_progress_deadline_at <= now ||
      fence.worker_superseded_at !== null
    ) {
      throw new LeaseLostError();
    }
    if (!securelyMatchesHash(input.resultDigest, expectedResultDigest)) {
      throw new ResultDigestMismatchError();
    }
    const reviewContext = toReviewCompletionContext(fence, input.runAttemptId);
    const validatedReview = isPersistedReviewJob(fence)
      ? validateReviewCompletion(reviewContext, input.resultDigest, input.result, canonicalResult)
      : null;
    const committedResultDigest = validatedReview?.resultDigest ?? input.resultDigest;
    const committedResultJson = validatedReview?.canonicalResultJson ?? resultJson;
    const attemptUpdate = database
      .prepare(`
        UPDATE run_attempts
        SET
          status = 'succeeded',
          result_digest = ?,
          result_json = ?,
          ended_at = ?
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
          AND EXISTS (
            SELECT 1
            FROM jobs
            WHERE jobs.id = run_attempts.job_id
              AND jobs.current_run_attempt_id = run_attempts.id
              AND jobs.status IN ('leased', 'running')
          )
      `)
      .run(
        committedResultDigest,
        committedResultJson,
        now,
        input.runAttemptId,
        input.jobId,
        input.workerNodeId,
        input.workerInstanceId,
        tokenHash,
        input.leaseGeneration,
        now,
        now,
        now,
      );
    if (Number(attemptUpdate.changes) !== 1) {
      throw new LeaseLostError();
    }

    if (validatedReview !== null) {
      persistValidatedReviewResult(database, reviewContext, validatedReview, now);
    }

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
      .run(now, now, input.jobId, input.runAttemptId);
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
      .run(now, now, input.workerNodeId, input.workerInstanceId);

    return {
      jobId: input.jobId,
      runAttemptId: input.runAttemptId,
      jobState: "succeeded",
      runState: "succeeded",
    };
  });

const isPersistedReviewJob = (
  row: Pick<TerminalAttemptRow, "work_item_id" | "request_epoch_id">,
): boolean => row.work_item_id !== null && row.request_epoch_id !== null;

const toReviewCompletionContext = (
  row: TerminalAttemptRow,
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

const failLease = (input: LeaseFailureInput): LeaseTerminalResult =>
  withImmediateTransaction(() => {
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const retryAt = new Date(nowDate.getTime() + input.retryDelaySeconds * 1_000).toISOString();
    const tokenHash = hash(input.leaseToken);
    const fence = database
      .prepare(`
        SELECT
          attempt.job_id,
          attempt.worker_node_id,
          attempt.worker_instance_id,
          attempt.status,
          attempt.completion_mode,
          attempt.lease_token_hash,
          attempt.lease_generation,
          attempt.lease_expires_at,
          attempt.execution_deadline_at,
          attempt.no_progress_timeout_ms,
          attempt.no_progress_deadline_at,
          attempt.progress_sequence,
          attempt.result_digest,
          attempt.result_json,
          attempt.failure_code,
          attempt.failure_message,
          job.status AS job_status,
          job.cancellation_requested_at,
          job.current_run_attempt_id,
          worker.status AS worker_status,
          worker.superseded_at AS worker_superseded_at
        FROM run_attempts AS attempt
        JOIN jobs AS job ON job.id = attempt.job_id
        JOIN workers AS worker ON worker.id = attempt.worker_id
        WHERE attempt.id = ?
      `)
      .get(input.runAttemptId) as unknown as TerminalAttemptRow | undefined;
    if (fence === undefined || !matchesTerminalLeaseIdentity(fence, input, tokenHash)) {
      throw new LeaseLostError();
    }

    const terminalPayload = failureTerminalPayload(input);
    const terminalPayloadJson = canonicalJson(terminalPayload);
    const terminalPayloadDigest = hash(terminalPayloadJson);
    if (isTerminalAttemptState(fence.status)) {
      const replay = parseFailureTerminalReplayRecord(fence.result_json);
      if (
        (fence.status === "failed" || fence.status === "cancelled") &&
        fence.result_digest !== null &&
        replay !== null &&
        securelyMatchesHash(terminalPayloadDigest, fence.result_digest) &&
        canonicalJson(replay.payload) === terminalPayloadJson &&
        replay.response.jobId === input.jobId &&
        replay.response.runAttemptId === input.runAttemptId &&
        replay.response.runState === fence.status
      ) {
        return replay.response;
      }
      throw new TerminalSubmissionConflictError();
    }

    if (
      !["leased", "running"].includes(fence.status) ||
      !["leased", "running", "cancel_requested"].includes(fence.job_status) ||
      fence.current_run_attempt_id !== input.runAttemptId ||
      fence.lease_expires_at <= now ||
      fence.execution_deadline_at <= now ||
      fence.no_progress_deadline_at <= now ||
      fence.worker_superseded_at !== null
    ) {
      throw new LeaseLostError();
    }
    const job = database
      .prepare(`
        SELECT attempt_count, max_attempts, status, cancellation_requested_at
        FROM jobs
        WHERE id = ? AND current_run_attempt_id = ?
      `)
      .get(input.jobId, input.runAttemptId) as unknown as
      | {
          readonly attempt_count: number;
          readonly max_attempts: number;
          readonly status: string;
          readonly cancellation_requested_at: string | null;
        }
      | undefined;
    if (job === undefined) {
      throw new LeaseLostError();
    }

    const wasCancelled =
      job.status === "cancel_requested" || job.cancellation_requested_at !== null;
    const runState: LeaseTerminalResult["runState"] = wasCancelled ? "cancelled" : "failed";
    const shouldRetry = !wasCancelled && input.retryable && job.attempt_count < job.max_attempts;
    const jobState: LeaseTerminalResult["jobState"] = wasCancelled
      ? "cancelled"
      : shouldRetry
        ? "retry_waiting"
        : input.retryable
          ? "dead_letter"
          : "failed";
    const terminalResponse: LeaseTerminalResult = {
      jobId: input.jobId,
      runAttemptId: input.runAttemptId,
      jobState,
      runState,
    };
    const replayRecord: FailureTerminalReplayRecord = {
      version: 1,
      terminalOutcome: "failure",
      payload: terminalPayload,
      response: terminalResponse,
    };
    const replayJson = canonicalJson(replayRecord);
    const attemptUpdate = database
      .prepare(`
        UPDATE run_attempts
        SET
          status = ?,
          ended_at = ?,
          failure_code = ?,
          failure_message = ?,
          result_digest = ?,
          result_json = ?
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
          AND EXISTS (
            SELECT 1
            FROM jobs
            WHERE jobs.id = run_attempts.job_id
              AND jobs.current_run_attempt_id = run_attempts.id
              AND jobs.status IN ('leased', 'running', 'cancel_requested')
          )
      `)
      .run(
        runState,
        now,
        input.failureCode,
        input.failureMessage,
        terminalPayloadDigest,
        replayJson,
        input.runAttemptId,
        input.jobId,
        input.workerNodeId,
        input.workerInstanceId,
        tokenHash,
        input.leaseGeneration,
        now,
        now,
        now,
      );
    if (Number(attemptUpdate.changes) !== 1) {
      throw new LeaseLostError();
    }

    const jobUpdate = database
      .prepare(`
        UPDATE jobs
        SET
          status = ?,
          current_run_attempt_id = NULL,
          current_step = NULL,
          next_attempt_at = ?,
          completed_at = ?,
          failure_code = ?,
          failure_message = ?,
          updated_at = ?
        WHERE id = ? AND current_run_attempt_id = ?
      `)
      .run(
        jobState,
        shouldRetry ? retryAt : now,
        shouldRetry ? null : now,
        input.failureCode,
        input.failureMessage,
        now,
        input.jobId,
        input.runAttemptId,
      );
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
      .run(now, now, input.workerNodeId, input.workerInstanceId);

    return terminalResponse;
  });

const reapExpiredLeases = (input: ReapExpiredLeasesInput): { readonly expiredCount: number } =>
  withImmediateTransaction(() => {
    const now = new Date();
    const nowText = now.toISOString();
    const retryAt = new Date(now.getTime() + input.retryDelaySeconds * 1_000).toISOString();
    const offlineBefore = new Date(
      now.getTime() - input.workerOfflineAfterSeconds * 1_000,
    ).toISOString();
    const expired = database
      .prepare(`
        SELECT
          attempt.id,
          attempt.job_id,
          attempt.lease_expires_at,
          attempt.execution_deadline_at,
          attempt.no_progress_deadline_at,
          job.attempt_count,
          job.max_attempts,
          job.status AS job_status,
          job.cancellation_requested_at
        FROM run_attempts AS attempt
        JOIN jobs AS job ON job.id = attempt.job_id
        WHERE attempt.status IN ('leased', 'running')
          AND (
            attempt.lease_expires_at <= ?
            OR attempt.execution_deadline_at <= ?
            OR attempt.no_progress_deadline_at <= ?
          )
      `)
      .all(nowText, nowText, nowText) as unknown as ExpiredAttemptRow[];
    let expiredCount = 0;

    for (const attempt of expired) {
      const failure = selectAttemptTimeoutFailure(attempt);
      const attemptUpdate = database
        .prepare(`
          UPDATE run_attempts
          SET
            status = 'expired',
            ended_at = ?,
            failure_code = ?,
            failure_message = ?
          WHERE id = ?
            AND status IN ('leased', 'running')
            AND (
              lease_expires_at <= ?
              OR execution_deadline_at <= ?
              OR no_progress_deadline_at <= ?
            )
        `)
        .run(nowText, failure.code, failure.message, attempt.id, nowText, nowText, nowText);
      if (Number(attemptUpdate.changes) !== 1) {
        continue;
      }

      expiredCount += 1;
      const resolution = resolveExpiredAttempt({
        attemptCount: attempt.attempt_count,
        maxAttempts: attempt.max_attempts,
        cancellationRequested:
          attempt.job_status === "cancel_requested" || attempt.cancellation_requested_at !== null,
        superseded: attempt.job_status === "stale",
      });
      const nextStatus = resolution.jobState;
      const shouldRetry = nextStatus === "retry_waiting";
      const completedAt = shouldRetry ? null : nowText;

      database
        .prepare(`
          UPDATE jobs
          SET
            status = ?,
            current_run_attempt_id = NULL,
            current_step = NULL,
            next_attempt_at = ?,
            completed_at = ?,
            failure_code = ?,
            failure_message = ?,
            updated_at = ?
          WHERE id = ? AND current_run_attempt_id = ?
        `)
        .run(
          nextStatus,
          shouldRetry ? retryAt : nowText,
          completedAt,
          failure.code,
          failure.message,
          nowText,
          attempt.job_id,
          attempt.id,
        );
    }

    database
      .prepare(`
        UPDATE workers
        SET status = 'offline', updated_at = ?
        WHERE status IN ('online', 'draining') AND last_seen_at <= ?
      `)
      .run(nowText, offlineBefore);

    return { expiredCount };
  });

const ping = (): DatabaseHealth => {
  const row = database.prepare("SELECT sqlite_version() AS sqlite_version").get() as unknown as {
    readonly sqlite_version: string;
  };
  return { sqliteVersion: row.sqlite_version, schemaVersion };
};

const serializeError = (
  error: unknown,
): { readonly name: string; readonly message: string; readonly code?: string } => {
  if (error instanceof Error) {
    const code = "code" in error ? String(error.code) : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(code === undefined ? {} : { code }),
    };
  }
  return { name: "Error", message: String(error) };
};

const handleRequest = (request: DatabaseRequest): unknown => {
  switch (request.operation) {
    case "ping":
      return ping();
    case "registerWorker":
      return registerWorker(request.input as RegisterWorkerInput);
    case "heartbeatWorker":
      return heartbeatWorker(request.input as HeartbeatWorkerInput);
    case "claimLease":
      return claimLease(request.input as ClaimLeaseInput);
    case "heartbeatLease":
      return heartbeatLease(request.input as HeartbeatLeaseInput);
    case "createArtifactUpload":
      return createArtifactUpload(database, request.input as CreateArtifactUploadInput);
    case "probeArtifactUploadCreate":
      return probeArtifactUploadCreate(database, request.input as CreateArtifactUploadInput);
    case "prepareArtifactChunk":
      return prepareArtifactChunk(database, request.input as PrepareArtifactChunkInput);
    case "commitArtifactChunk":
      return commitArtifactChunk(database, request.input as CommitArtifactChunkInput);
    case "prepareArtifactFinalize":
      return prepareArtifactFinalize(database, request.input as PrepareArtifactFinalizeInput);
    case "commitArtifactFinalize":
      return commitArtifactFinalize(database, request.input as CommitArtifactFinalizeInput);
    case "terminateArtifactUpload":
      return terminateArtifactUpload(database, request.input as TerminateArtifactUploadInput);
    case "terminalizeInactiveArtifactUploads":
      return terminalizeInactiveArtifactUploads(
        database,
        request.input as TerminalizeInactiveArtifactUploadsInput,
      );
    case "listDueArtifactCleanups":
      return listDueArtifactCleanups(database, request.input as ListDueArtifactCleanupsInput);
    case "completeArtifactCleanup":
      return completeArtifactCleanup(database, request.input as CompleteArtifactCleanupInput);
    case "recordArtifactCleanupFailure":
      return recordArtifactCleanupFailure(
        database,
        request.input as RecordArtifactCleanupFailureInput,
      );
    case "classifyArtifactNamespacePageAndAdvanceCursor":
      return classifyArtifactNamespacePageAndAdvanceCursor(
        database,
        request.input as ClassifyArtifactNamespacePageInput,
      );
    case "listDueArtifactNamespaceCleanups":
      return listDueArtifactNamespaceCleanups(
        database,
        request.input as ListDueArtifactNamespaceCleanupsInput,
      );
    case "completeArtifactNamespaceCleanup":
      return completeArtifactNamespaceCleanup(
        database,
        request.input as CompleteArtifactNamespaceCleanupInput,
      );
    case "recordArtifactNamespaceCleanupFailure":
      return recordArtifactNamespaceCleanupFailure(
        database,
        request.input as RecordArtifactNamespaceCleanupFailureInput,
      );
    case "readArtifactHealthAccounting":
      return readArtifactHealthAccounting(database, request.input as Record<string, never>);
    case "readArtifactReconciliationCursor":
      return readArtifactReconciliationCursor(database, request.input as Record<string, never>);
    case "completeLease":
      return completeLease(request.input as LeaseCompletionInput);
    case "failLease":
      return failLease(request.input as LeaseFailureInput);
    case "reapExpiredLeases":
      return reapExpiredLeases(request.input as ReapExpiredLeasesInput);
    case "ingestSchedulingEvent":
      return ingestSchedulingEvent(database, request.input as IngestSchedulingEventInput);
    case "listWorkItems":
      return listWorkItems(database, request.input as DashboardWorkItemListQuery);
    case "listJobs":
      return listJobs(database, request.input as DashboardJobListQuery);
    case "listWorkers":
      return listWorkers(database, request.input as DashboardWorkerListQuery);
    case "getSystemSnapshot":
      return getSystemSnapshot(database, schemaVersion);
    case "beginOperatorLogin":
      return beginOperatorLogin(database, request.input as BeginOperatorLoginInput);
    case "claimOperatorLoginTransaction":
      return claimOperatorLoginTransaction(
        database,
        request.input as ClaimOperatorLoginTransactionInput,
      );
    case "finalizeOperatorLogin":
      return finalizeOperatorLogin(database, request.input as FinalizeOperatorLoginInput);
    case "createOperatorSession":
      return createOperatorSession(database, request.input as CreateOperatorSessionInput);
    case "findOperatorSession":
      return findOperatorSession(database, request.input as FindOperatorSessionInput);
    case "deleteOperatorSession":
      return deleteOperatorSession(database, request.input as DeleteOperatorSessionInput);
    case "deleteOperatorBrowserFlow":
      return deleteOperatorBrowserFlow(database, request.input as DeleteOperatorBrowserFlowInput);
    case "cleanupExpiredOperatorAuth":
      return cleanupExpiredOperatorAuth(database, request.input as CleanupExpiredOperatorAuthInput);
    case "readGitHubPollingProjection":
      return readGitHubPollingProjection(database, request.input as GitHubPollingProjectionKey);
    case "writeGitHubPollingProjection":
      return writeGitHubPollingProjection(
        database,
        request.input as WriteGitHubPollingProjectionInput,
      );
    case "commitGitHubPollingReconciliation":
      return commitGitHubPollingReconciliation(
        database,
        request.input as CommitGitHubPollingReconciliationInput,
      );
    case "shutdown":
      return { closed: true } as const;
  }
};

try {
  const storage = DatabaseStorageBinding.prepare(options.databasePath);
  let migrationState: MigrationState | undefined;
  if (storage.snapshot.initializationState === "legacy") {
    storage.assertLegacyCandidate();
    const legacyDatabase = new DatabaseSync(storage.databasePath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    let adoptionError: unknown;
    try {
      migrationState = await adoptLegacyDatabase({
        database: legacyDatabase,
        databasePath: storage.databasePath,
        migrationsDirectory: options.migrationsDirectory,
        storage,
      });
    } catch (error) {
      adoptionError = error;
    }
    let closeError: unknown;
    try {
      legacyDatabase.close();
    } catch (error) {
      closeError = error;
    }
    if (adoptionError !== undefined && closeError !== undefined) {
      throw new AggregateError(
        [adoptionError, closeError],
        "Legacy database adoption and read-only close both failed.",
        { cause: adoptionError },
      );
    }
    if (adoptionError !== undefined) {
      throw adoptionError;
    }
    if (closeError !== undefined) {
      throw closeError;
    }
  } else {
    cleanupIncompleteMigrationBackups(storage.databasePath);
    storage.createDatabaseFile();
  }
  database = new DatabaseSync(storage.databasePath, {
    timeout: 5_000,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  storage.assertDatabaseOpened();
  database.exec("PRAGMA trusted_schema = OFF");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  migrationState ??= inspectMigrationState(database, options.migrationsDirectory);
  if (
    storage.snapshot.initializationState === "initialized" &&
    migrationState.pendingVersions.length > 0
  ) {
    await createMigrationBackup({
      database,
      databasePath: storage.databasePath,
      currentVersion: migrationState.currentVersion,
      targetVersion: migrationState.targetVersion,
    });
  }
  schemaVersion = runMigrations(database, options.migrationsDirectory);
  if (storage.snapshot.initializationState === "fresh") {
    storage.finalizeDatabaseInitialization();
  }
  storage.assertReady();
  port.postMessage({ type: "ready" });

  port.on("message", (request: DatabaseRequest) => {
    if (request.operation === "shutdown") {
      completeDatabaseShutdown(
        database,
        () => {
          port.postMessage({
            type: "response",
            id: request.id,
            ok: true,
            output: { closed: true },
          });
          port.close();
        },
        (error) => {
          port.postMessage({
            type: "response",
            id: request.id,
            ok: false,
            error: serializeError(error),
          });
        },
      );
      return;
    }
    try {
      const output = handleRequest(request);
      port.postMessage({ type: "response", id: request.id, ok: true, output });
    } catch (error) {
      port.postMessage({
        type: "response",
        id: request.id,
        ok: false,
        error: serializeError(error),
      });
    }
  });
} catch (error) {
  port.postMessage({ type: "fatal", error: serializeError(error) });
  port.close();
}
