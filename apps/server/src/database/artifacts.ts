import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type CommittedRunArtifact,
  type CreateResultArtifactUploadRequest,
  maximumResultArtifactBytes,
  maximumResultArtifactChunkBytes,
  maximumResultArtifactChunks,
  type ResultArtifactUploadState,
} from "@agentic-review/contracts";
import { ArtifactUploadConflictError, LeaseLostError } from "./errors.js";

type ArtifactLeaseIdentity = Pick<
  CreateResultArtifactUploadRequest,
  "jobId" | "runAttemptId" | "workerNodeId" | "workerInstanceId" | "leaseToken" | "leaseGeneration"
>;

export type CreateArtifactUploadInput = CreateResultArtifactUploadRequest;

export interface CreateArtifactUploadResult {
  readonly uploadId: string;
  readonly state: ResultArtifactUploadState;
  readonly replayed: boolean;
  readonly nextChunkIndex: number;
  readonly nextOffsetBytes: number;
  readonly maximumChunkBytes: typeof maximumResultArtifactChunkBytes;
  readonly maximumChunkCount: typeof maximumResultArtifactChunks;
}

interface ArtifactChunkMetadata {
  readonly chunkIndex: number;
  readonly offsetBytes: number;
  readonly chunkBytes: number;
  readonly chunkSha256: string;
}

export interface PrepareArtifactChunkInput extends ArtifactLeaseIdentity, ArtifactChunkMetadata {
  readonly uploadId: string;
}

export interface PrepareArtifactChunkResult extends ArtifactChunkMetadata {
  readonly uploadId: string;
  readonly prepareId: string;
  readonly receiptState: "prepared" | "committed";
  readonly replayed: boolean;
  readonly committedNextChunkIndex: number;
  readonly committedOffsetBytes: number;
  readonly preparedNextChunkIndex: number;
  readonly preparedNextOffsetBytes: number;
}

export interface CommitArtifactChunkInput extends PrepareArtifactChunkInput {
  readonly prepareId: string;
}

export interface CommitArtifactChunkResult {
  readonly uploadId: string;
  readonly prepareId: string;
  readonly chunkIndex: number;
  readonly outcome: "accepted" | "replayed";
  readonly nextChunkIndex: number;
  readonly nextOffsetBytes: number;
}

interface ArtifactFinalizeMetadata {
  readonly chunkCount: number;
  readonly totalBytes: number;
  readonly sha256: string;
}

export interface PrepareArtifactFinalizeInput
  extends ArtifactLeaseIdentity,
    ArtifactFinalizeMetadata {
  readonly uploadId: string;
}

export interface PrepareArtifactFinalizeResult extends ArtifactFinalizeMetadata {
  readonly uploadId: string;
  readonly finalizationId: string;
  readonly artifactId: string;
  readonly storageObjectKey: string;
  readonly state: "finalizing" | "committed";
  readonly replayed: boolean;
}

export interface CommitArtifactFinalizeInput extends PrepareArtifactFinalizeInput {
  readonly finalizationId: string;
  readonly storageObjectKey: string;
}

export interface CommitArtifactFinalizeResult {
  readonly state: "committed";
  readonly replayed: boolean;
  readonly artifact: CommittedRunArtifact & { readonly storageObjectKey: string };
}

export interface TerminateArtifactUploadInput extends ArtifactLeaseIdentity {
  readonly uploadId: string;
  readonly state: "abandoned" | "corrupt";
  readonly reason: string;
}

export interface TerminateArtifactUploadResult {
  readonly uploadId: string;
  readonly state: "abandoned" | "corrupt";
  readonly reason: string;
  readonly terminatedAt: string;
  readonly replayed: boolean;
}

interface ActiveLeaseRow {
  readonly job_id: string;
  readonly worker_node_id: string;
  readonly worker_instance_id: string;
  readonly attempt_status: string;
  readonly lease_token_hash: string;
  readonly lease_generation: number;
  readonly lease_expires_at: string;
  readonly execution_deadline_at: string;
  readonly no_progress_deadline_at: string;
  readonly job_status: string;
  readonly current_run_attempt_id: string | null;
  readonly worker_superseded_at: string | null;
}

interface ArtifactUploadRow {
  readonly id: string;
  readonly job_id: string;
  readonly run_attempt_id: string;
  readonly worker_node_id: string;
  readonly worker_instance_id: string;
  readonly lease_generation: number;
  readonly client_artifact_id: string;
  readonly purpose: "result";
  readonly name: string;
  readonly media_type: "application/json";
  readonly expected_total_bytes: number;
  readonly expected_sha256: string;
  readonly status: ResultArtifactUploadState;
  readonly next_chunk_index: number;
  readonly received_bytes: number;
  readonly finalization_id: string | null;
  readonly final_chunk_count: number | null;
  readonly final_total_bytes: number | null;
  readonly final_sha256: string | null;
  readonly terminated_at: string | null;
  readonly termination_reason: string | null;
}

interface ArtifactChunkRow {
  readonly upload_id: string;
  readonly chunk_index: number;
  readonly prepare_id: string;
  readonly offset_bytes: number;
  readonly chunk_bytes: number;
  readonly chunk_sha256: string;
  readonly status: "prepared" | "committed";
}

interface RunArtifactRow {
  readonly id: string;
  readonly upload_id: string;
  readonly job_id: string;
  readonly run_attempt_id: string;
  readonly client_artifact_id: string;
  readonly purpose: "result";
  readonly name: string;
  readonly media_type: "application/json";
  readonly total_bytes: number;
  readonly sha256: string;
  readonly storage_object_key: string;
}

const entityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const artifactNamePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const securelyMatchesSha256 = (actual: string, expected: string): boolean =>
  sha256Pattern.test(actual) &&
  sha256Pattern.test(expected) &&
  timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));

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

export const createArtifactUpload = (
  database: DatabaseSync,
  input: CreateArtifactUploadInput,
): CreateArtifactUploadResult =>
  withImmediateTransaction(database, () => {
    validateCreateInput(input);
    const now = new Date().toISOString();
    requireActiveLease(database, input, now);

    const existing = findUploadByClientId(database, input.runAttemptId, input.clientArtifactId);
    if (existing !== undefined) {
      requireUploadBinding(existing, input);
      if (!matchesCreateMetadata(existing, input)) {
        throw new ArtifactUploadConflictError();
      }
      return createUploadResult(existing, true);
    }

    const liveResult = database
      .prepare(`
        SELECT id
        FROM artifact_uploads
        WHERE run_attempt_id = ?
          AND purpose = 'result'
          AND status IN ('receiving', 'finalizing', 'committed')
      `)
      .get(input.runAttemptId) as unknown as { readonly id: string } | undefined;
    if (liveResult !== undefined) {
      throw new ArtifactUploadConflictError(
        "The run attempt already has a live result artifact upload.",
      );
    }

    const uploadId = randomUUID();
    database
      .prepare(`
        INSERT INTO artifact_uploads (
          id,
          job_id,
          run_attempt_id,
          worker_node_id,
          worker_instance_id,
          lease_generation,
          client_artifact_id,
          purpose,
          name,
          media_type,
          expected_total_bytes,
          expected_sha256,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'receiving', ?, ?)
      `)
      .run(
        uploadId,
        input.jobId,
        input.runAttemptId,
        input.workerNodeId,
        input.workerInstanceId,
        input.leaseGeneration,
        input.clientArtifactId,
        input.purpose,
        input.name,
        input.mediaType,
        input.totalBytes,
        input.sha256,
        now,
        now,
      );

    const created = requireUpload(database, uploadId);
    return createUploadResult(created, false);
  });

export const prepareArtifactChunk = (
  database: DatabaseSync,
  input: PrepareArtifactChunkInput,
): PrepareArtifactChunkResult =>
  withImmediateTransaction(database, () => {
    validateChunkInput(input);
    const now = new Date().toISOString();
    requireActiveLease(database, input, now);
    const upload = requireUpload(database, input.uploadId);
    requireUploadBinding(upload, input);

    const existing = findChunk(database, input.uploadId, input.chunkIndex);
    if (existing !== undefined) {
      if (!matchesChunkMetadata(existing, input)) {
        throw new ArtifactUploadConflictError(
          "The artifact chunk index already has different immutable metadata.",
        );
      }
      if (existing.status === "prepared" && upload.status !== "receiving") {
        throw new ArtifactUploadConflictError(
          "The prepared artifact chunk belongs to an upload that no longer receives bytes.",
        );
      }
      if (
        existing.status === "committed" &&
        upload.status !== "receiving" &&
        upload.status !== "finalizing" &&
        upload.status !== "committed"
      ) {
        throw new ArtifactUploadConflictError(
          "The committed artifact chunk belongs to a terminated upload.",
        );
      }
      return prepareChunkResult(upload, existing, true);
    }

    if (
      upload.status !== "receiving" ||
      input.chunkIndex !== upload.next_chunk_index ||
      input.offsetBytes !== upload.received_bytes ||
      input.offsetBytes + input.chunkBytes > upload.expected_total_bytes
    ) {
      throw new ArtifactUploadConflictError(
        "The artifact chunk does not match the current upload cursor.",
      );
    }

    const receipt: ArtifactChunkRow = {
      upload_id: input.uploadId,
      chunk_index: input.chunkIndex,
      prepare_id: randomUUID(),
      offset_bytes: input.offsetBytes,
      chunk_bytes: input.chunkBytes,
      chunk_sha256: input.chunkSha256,
      status: "prepared",
    };
    database
      .prepare(`
        INSERT INTO artifact_upload_chunks (
          upload_id,
          chunk_index,
          prepare_id,
          offset_bytes,
          chunk_bytes,
          chunk_sha256,
          status,
          prepared_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?)
      `)
      .run(
        receipt.upload_id,
        receipt.chunk_index,
        receipt.prepare_id,
        receipt.offset_bytes,
        receipt.chunk_bytes,
        receipt.chunk_sha256,
        now,
      );
    database.prepare("UPDATE artifact_uploads SET updated_at = ? WHERE id = ?").run(now, upload.id);
    return prepareChunkResult(upload, receipt, false);
  });

export const commitArtifactChunk = (
  database: DatabaseSync,
  input: CommitArtifactChunkInput,
): CommitArtifactChunkResult =>
  // The caller may commit only after the prepared bytes are durable in the staging object.
  withImmediateTransaction(database, () => {
    validateChunkInput(input);
    requireUuid(input.prepareId, "prepareId");
    const now = new Date().toISOString();
    requireActiveLease(database, input, now);
    const upload = requireUpload(database, input.uploadId);
    requireUploadBinding(upload, input);
    const receipt = findChunk(database, input.uploadId, input.chunkIndex);
    if (
      receipt === undefined ||
      receipt.prepare_id !== input.prepareId ||
      !matchesChunkMetadata(receipt, input)
    ) {
      throw new ArtifactUploadConflictError(
        "The artifact chunk commit does not match its prepared receipt.",
      );
    }

    if (receipt.status === "committed") {
      if (
        upload.status !== "receiving" &&
        upload.status !== "finalizing" &&
        upload.status !== "committed"
      ) {
        throw new ArtifactUploadConflictError(
          "The committed artifact chunk belongs to a terminated upload.",
        );
      }
      return commitChunkResult(upload, receipt, true);
    }
    if (
      upload.status !== "receiving" ||
      upload.next_chunk_index !== receipt.chunk_index ||
      upload.received_bytes !== receipt.offset_bytes
    ) {
      throw new ArtifactUploadConflictError(
        "The prepared artifact chunk no longer matches the upload cursor.",
      );
    }

    const receiptUpdate = database
      .prepare(`
        UPDATE artifact_upload_chunks
        SET status = 'committed', committed_at = ?
        WHERE upload_id = ? AND chunk_index = ? AND prepare_id = ? AND status = 'prepared'
      `)
      .run(now, receipt.upload_id, receipt.chunk_index, receipt.prepare_id);
    if (Number(receiptUpdate.changes) !== 1) {
      throw new ArtifactUploadConflictError("The prepared artifact chunk could not be committed.");
    }

    const nextChunkIndex = receipt.chunk_index + 1;
    const nextOffsetBytes = receipt.offset_bytes + receipt.chunk_bytes;
    const uploadUpdate = database
      .prepare(`
        UPDATE artifact_uploads
        SET next_chunk_index = ?, received_bytes = ?, updated_at = ?
        WHERE id = ?
          AND status = 'receiving'
          AND next_chunk_index = ?
          AND received_bytes = ?
      `)
      .run(
        nextChunkIndex,
        nextOffsetBytes,
        now,
        upload.id,
        receipt.chunk_index,
        receipt.offset_bytes,
      );
    if (Number(uploadUpdate.changes) !== 1) {
      throw new ArtifactUploadConflictError("The artifact upload cursor could not be advanced.");
    }

    return {
      uploadId: upload.id,
      prepareId: receipt.prepare_id,
      chunkIndex: receipt.chunk_index,
      outcome: "accepted",
      nextChunkIndex,
      nextOffsetBytes,
    };
  });

export const prepareArtifactFinalize = (
  database: DatabaseSync,
  input: PrepareArtifactFinalizeInput,
): PrepareArtifactFinalizeResult =>
  withImmediateTransaction(database, () => {
    validateFinalizeInput(input);
    const now = new Date().toISOString();
    requireActiveLease(database, input, now);
    const upload = requireUpload(database, input.uploadId);
    requireUploadBinding(upload, input);

    if (upload.status === "finalizing" || upload.status === "committed") {
      requireMatchingFinalization(upload, input);
      return prepareFinalizeResult(upload, true);
    }
    if (
      upload.status !== "receiving" ||
      upload.next_chunk_index !== input.chunkCount ||
      upload.received_bytes !== input.totalBytes ||
      upload.expected_total_bytes !== input.totalBytes ||
      upload.expected_sha256 !== input.sha256
    ) {
      throw new ArtifactUploadConflictError(
        "The artifact finalization does not match the completed upload cursor.",
      );
    }

    const receiptSummary = database
      .prepare(`
        SELECT
          COUNT(*) AS receipt_count,
          COALESCE(SUM(chunk_bytes), 0) AS receipt_bytes,
          COALESCE(SUM(CASE WHEN status = 'committed' THEN 0 ELSE 1 END), 0)
            AS uncommitted_count
        FROM artifact_upload_chunks
        WHERE upload_id = ?
      `)
      .get(upload.id) as unknown as {
      readonly receipt_count: number;
      readonly receipt_bytes: number;
      readonly uncommitted_count: number;
    };
    if (
      receiptSummary.receipt_count !== input.chunkCount ||
      receiptSummary.receipt_bytes !== input.totalBytes ||
      receiptSummary.uncommitted_count !== 0
    ) {
      throw new ArtifactUploadConflictError(
        "The artifact finalization lacks a complete set of committed chunk receipts.",
      );
    }

    const finalizationId = randomUUID();
    const update = database
      .prepare(`
        UPDATE artifact_uploads
        SET
          status = 'finalizing',
          finalization_id = ?,
          final_chunk_count = ?,
          final_total_bytes = ?,
          final_sha256 = ?,
          finalizing_at = ?,
          updated_at = ?
        WHERE id = ? AND status = 'receiving'
      `)
      .run(finalizationId, input.chunkCount, input.totalBytes, input.sha256, now, now, upload.id);
    if (Number(update.changes) !== 1) {
      throw new ArtifactUploadConflictError("The artifact upload could not enter finalization.");
    }
    return prepareFinalizeResult(requireUpload(database, upload.id), false);
  });

export const commitArtifactFinalize = (
  database: DatabaseSync,
  input: CommitArtifactFinalizeInput,
): CommitArtifactFinalizeResult =>
  // The caller may commit only after the verified object is atomically published and durable.
  withImmediateTransaction(database, () => {
    validateFinalizeInput(input);
    requireUuid(input.finalizationId, "finalizationId");
    const now = new Date().toISOString();
    requireActiveLease(database, input, now);
    const upload = requireUpload(database, input.uploadId);
    requireUploadBinding(upload, input);
    requireMatchingFinalization(upload, input);
    const expectedObjectKey = storageObjectKey(input.sha256);
    if (input.storageObjectKey !== expectedObjectKey) {
      throw new ArtifactUploadConflictError(
        "The published artifact object key does not match the prepared finalization.",
      );
    }

    if (upload.status === "committed") {
      return { state: "committed", replayed: true, artifact: requireRunArtifact(database, upload) };
    }
    if (upload.status !== "finalizing") {
      throw new ArtifactUploadConflictError("The artifact upload is not ready to commit.");
    }

    database
      .prepare(`
        INSERT INTO run_artifacts (
          id,
          upload_id,
          job_id,
          run_attempt_id,
          client_artifact_id,
          purpose,
          name,
          media_type,
          total_bytes,
          sha256,
          storage_object_key,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.finalizationId,
        upload.id,
        upload.job_id,
        upload.run_attempt_id,
        upload.client_artifact_id,
        upload.purpose,
        upload.name,
        upload.media_type,
        input.totalBytes,
        input.sha256,
        input.storageObjectKey,
        now,
      );
    const update = database
      .prepare(`
        UPDATE artifact_uploads
        SET status = 'committed', committed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'finalizing' AND finalization_id = ?
      `)
      .run(now, now, upload.id, input.finalizationId);
    if (Number(update.changes) !== 1) {
      throw new ArtifactUploadConflictError(
        "The finalized artifact upload could not be committed.",
      );
    }
    return { state: "committed", replayed: false, artifact: requireRunArtifact(database, upload) };
  });

export const terminateArtifactUpload = (
  database: DatabaseSync,
  input: TerminateArtifactUploadInput,
): TerminateArtifactUploadResult =>
  withImmediateTransaction(database, () => {
    validateTerminationInput(input);
    const now = new Date().toISOString();
    requireActiveLease(database, input, now);
    const upload = requireUpload(database, input.uploadId);
    requireUploadBinding(upload, input);

    if (upload.status === "abandoned" || upload.status === "corrupt") {
      if (
        upload.status !== input.state ||
        upload.termination_reason !== input.reason ||
        upload.terminated_at === null
      ) {
        throw new ArtifactUploadConflictError(
          "The artifact upload already has a different terminal disposition.",
        );
      }
      return {
        uploadId: upload.id,
        state: upload.status,
        reason: upload.termination_reason,
        terminatedAt: upload.terminated_at,
        replayed: true,
      };
    }
    if (upload.status === "committed") {
      throw new ArtifactUploadConflictError("A committed artifact upload cannot be terminated.");
    }

    const update = database
      .prepare(`
        UPDATE artifact_uploads
        SET
          status = ?,
          terminated_at = ?,
          termination_reason = ?,
          updated_at = ?
        WHERE id = ?
          AND status IN ('receiving', 'finalizing')
          AND NOT EXISTS (
            SELECT 1 FROM run_artifacts AS artifact
            WHERE artifact.upload_id = artifact_uploads.id
          )
      `)
      .run(input.state, now, input.reason, now, upload.id);
    if (Number(update.changes) !== 1) {
      throw new ArtifactUploadConflictError(
        "The artifact upload could not be terminated from its current state.",
      );
    }
    return {
      uploadId: upload.id,
      state: input.state,
      reason: input.reason,
      terminatedAt: now,
      replayed: false,
    };
  });

function requireActiveLease(
  database: DatabaseSync,
  input: ArtifactLeaseIdentity,
  now: string,
): ActiveLeaseRow {
  validateLeaseIdentity(input);
  const row = database
    .prepare(`
      SELECT
        attempt.job_id,
        attempt.worker_node_id,
        attempt.worker_instance_id,
        attempt.status AS attempt_status,
        attempt.lease_token_hash,
        attempt.lease_generation,
        attempt.lease_expires_at,
        attempt.execution_deadline_at,
        attempt.no_progress_deadline_at,
        job.status AS job_status,
        job.current_run_attempt_id,
        worker.superseded_at AS worker_superseded_at
      FROM run_attempts AS attempt
      JOIN jobs AS job ON job.id = attempt.job_id
      JOIN workers AS worker ON worker.id = attempt.worker_id
      WHERE attempt.id = ?
    `)
    .get(input.runAttemptId) as unknown as ActiveLeaseRow | undefined;
  const tokenHash = sha256(input.leaseToken);
  if (
    row === undefined ||
    row.job_id !== input.jobId ||
    row.worker_node_id !== input.workerNodeId ||
    row.worker_instance_id !== input.workerInstanceId ||
    row.lease_generation !== input.leaseGeneration ||
    !securelyMatchesSha256(row.lease_token_hash, tokenHash) ||
    !["leased", "running"].includes(row.attempt_status) ||
    !["leased", "running"].includes(row.job_status) ||
    row.current_run_attempt_id !== input.runAttemptId ||
    row.lease_expires_at <= now ||
    row.execution_deadline_at <= now ||
    row.no_progress_deadline_at <= now ||
    row.worker_superseded_at !== null
  ) {
    throw new LeaseLostError();
  }
  return row;
}

function findUploadByClientId(
  database: DatabaseSync,
  runAttemptId: string,
  clientArtifactId: string,
): ArtifactUploadRow | undefined {
  return database
    .prepare(`
      SELECT
        id,
        job_id,
        run_attempt_id,
        worker_node_id,
        worker_instance_id,
        lease_generation,
        client_artifact_id,
        purpose,
        name,
        media_type,
        expected_total_bytes,
        expected_sha256,
        status,
        next_chunk_index,
        received_bytes,
        finalization_id,
        final_chunk_count,
        final_total_bytes,
        final_sha256,
        terminated_at,
        termination_reason
      FROM artifact_uploads
      WHERE run_attempt_id = ? AND client_artifact_id = ?
    `)
    .get(runAttemptId, clientArtifactId) as unknown as ArtifactUploadRow | undefined;
}

function requireUpload(database: DatabaseSync, uploadId: string): ArtifactUploadRow {
  requireEntityId(uploadId, "uploadId");
  const row = database
    .prepare(`
      SELECT
        id,
        job_id,
        run_attempt_id,
        worker_node_id,
        worker_instance_id,
        lease_generation,
        client_artifact_id,
        purpose,
        name,
        media_type,
        expected_total_bytes,
        expected_sha256,
        status,
        next_chunk_index,
        received_bytes,
        finalization_id,
        final_chunk_count,
        final_total_bytes,
        final_sha256,
        terminated_at,
        termination_reason
      FROM artifact_uploads
      WHERE id = ?
    `)
    .get(uploadId) as unknown as ArtifactUploadRow | undefined;
  if (row === undefined) {
    throw new ArtifactUploadConflictError("The artifact upload does not exist.");
  }
  return row;
}

function findChunk(
  database: DatabaseSync,
  uploadId: string,
  chunkIndex: number,
): ArtifactChunkRow | undefined {
  return database
    .prepare(`
      SELECT
        upload_id,
        chunk_index,
        prepare_id,
        offset_bytes,
        chunk_bytes,
        chunk_sha256,
        status
      FROM artifact_upload_chunks
      WHERE upload_id = ? AND chunk_index = ?
    `)
    .get(uploadId, chunkIndex) as unknown as ArtifactChunkRow | undefined;
}

function requireRunArtifact(
  database: DatabaseSync,
  upload: ArtifactUploadRow,
): CommittedRunArtifact & { readonly storageObjectKey: string } {
  const row = database
    .prepare(`
      SELECT
        id,
        upload_id,
        job_id,
        run_attempt_id,
        client_artifact_id,
        purpose,
        name,
        media_type,
        total_bytes,
        sha256,
        storage_object_key
      FROM run_artifacts
      WHERE upload_id = ?
    `)
    .get(upload.id) as unknown as RunArtifactRow | undefined;
  if (row === undefined) {
    throw new ArtifactUploadConflictError(
      "The committed artifact upload has no immutable artifact record.",
    );
  }
  return {
    artifactId: row.id,
    uploadId: row.upload_id,
    clientArtifactId: row.client_artifact_id,
    jobId: row.job_id,
    runAttemptId: row.run_attempt_id,
    purpose: row.purpose,
    name: row.name,
    mediaType: row.media_type,
    totalBytes: row.total_bytes,
    sha256: row.sha256,
    storageObjectKey: row.storage_object_key,
  };
}

function createUploadResult(
  upload: ArtifactUploadRow,
  replayed: boolean,
): CreateArtifactUploadResult {
  return {
    uploadId: upload.id,
    state: upload.status,
    replayed,
    nextChunkIndex: upload.next_chunk_index,
    nextOffsetBytes: upload.received_bytes,
    maximumChunkBytes: maximumResultArtifactChunkBytes,
    maximumChunkCount: maximumResultArtifactChunks,
  };
}

function prepareChunkResult(
  upload: ArtifactUploadRow,
  receipt: ArtifactChunkRow,
  replayed: boolean,
): PrepareArtifactChunkResult {
  return {
    uploadId: upload.id,
    prepareId: receipt.prepare_id,
    receiptState: receipt.status,
    replayed,
    chunkIndex: receipt.chunk_index,
    offsetBytes: receipt.offset_bytes,
    chunkBytes: receipt.chunk_bytes,
    chunkSha256: receipt.chunk_sha256,
    committedNextChunkIndex: upload.next_chunk_index,
    committedOffsetBytes: upload.received_bytes,
    preparedNextChunkIndex: receipt.chunk_index + 1,
    preparedNextOffsetBytes: receipt.offset_bytes + receipt.chunk_bytes,
  };
}

function commitChunkResult(
  upload: ArtifactUploadRow,
  receipt: ArtifactChunkRow,
  replayed: boolean,
): CommitArtifactChunkResult {
  if (
    upload.next_chunk_index < receipt.chunk_index + 1 ||
    upload.received_bytes < receipt.offset_bytes + receipt.chunk_bytes
  ) {
    throw new ArtifactUploadConflictError(
      "The committed artifact chunk is ahead of the durable upload cursor.",
    );
  }
  return {
    uploadId: upload.id,
    prepareId: receipt.prepare_id,
    chunkIndex: receipt.chunk_index,
    outcome: replayed ? "replayed" : "accepted",
    nextChunkIndex: upload.next_chunk_index,
    nextOffsetBytes: upload.received_bytes,
  };
}

function prepareFinalizeResult(
  upload: ArtifactUploadRow,
  replayed: boolean,
): PrepareArtifactFinalizeResult {
  if (
    upload.finalization_id === null ||
    upload.final_chunk_count === null ||
    upload.final_total_bytes === null ||
    upload.final_sha256 === null ||
    (upload.status !== "finalizing" && upload.status !== "committed")
  ) {
    throw new ArtifactUploadConflictError("The artifact finalization state is incomplete.");
  }
  return {
    uploadId: upload.id,
    finalizationId: upload.finalization_id,
    artifactId: upload.finalization_id,
    storageObjectKey: storageObjectKey(upload.final_sha256),
    state: upload.status,
    replayed,
    chunkCount: upload.final_chunk_count,
    totalBytes: upload.final_total_bytes,
    sha256: upload.final_sha256,
  };
}

function requireUploadBinding(upload: ArtifactUploadRow, input: ArtifactLeaseIdentity): void {
  if (
    upload.job_id !== input.jobId ||
    upload.run_attempt_id !== input.runAttemptId ||
    upload.worker_node_id !== input.workerNodeId ||
    upload.worker_instance_id !== input.workerInstanceId ||
    upload.lease_generation !== input.leaseGeneration
  ) {
    throw new LeaseLostError();
  }
}

function matchesCreateMetadata(
  upload: ArtifactUploadRow,
  input: CreateArtifactUploadInput,
): boolean {
  return (
    upload.purpose === input.purpose &&
    upload.name === input.name &&
    upload.media_type === input.mediaType &&
    upload.expected_total_bytes === input.totalBytes &&
    upload.expected_sha256 === input.sha256
  );
}

function matchesChunkMetadata(receipt: ArtifactChunkRow, input: ArtifactChunkMetadata): boolean {
  return (
    receipt.chunk_index === input.chunkIndex &&
    receipt.offset_bytes === input.offsetBytes &&
    receipt.chunk_bytes === input.chunkBytes &&
    receipt.chunk_sha256 === input.chunkSha256
  );
}

function requireMatchingFinalization(
  upload: ArtifactUploadRow,
  input: ArtifactFinalizeMetadata & { readonly finalizationId?: string },
): void {
  if (
    upload.finalization_id === null ||
    upload.final_chunk_count !== input.chunkCount ||
    upload.final_total_bytes !== input.totalBytes ||
    upload.final_sha256 !== input.sha256 ||
    (input.finalizationId !== undefined && upload.finalization_id !== input.finalizationId)
  ) {
    throw new ArtifactUploadConflictError(
      "The artifact finalization request does not match its prepared identity.",
    );
  }
}

function storageObjectKey(digest: string): string {
  return `sha256/${digest.slice(0, 2)}/${digest}`;
}

function validateCreateInput(input: CreateArtifactUploadInput): void {
  validateLeaseIdentity(input);
  requireUuid(input.clientArtifactId, "clientArtifactId");
  if (input.purpose !== "result") {
    throw new TypeError("Result artifact uploads require purpose=result.");
  }
  if (!artifactNamePattern.test(input.name)) {
    throw new TypeError("Result artifact names must use the canonical artifact-name format.");
  }
  if (input.mediaType !== "application/json") {
    throw new TypeError("Result artifacts must use application/json.");
  }
  requireInteger(input.totalBytes, 1, maximumResultArtifactBytes, "totalBytes");
  requireSha256(input.sha256, "sha256");
}

function validateChunkInput(input: PrepareArtifactChunkInput): void {
  validateLeaseIdentity(input);
  requireEntityId(input.uploadId, "uploadId");
  requireInteger(input.chunkIndex, 0, maximumResultArtifactChunks - 1, "chunkIndex");
  requireInteger(input.offsetBytes, 0, maximumResultArtifactBytes - 1, "offsetBytes");
  requireInteger(input.chunkBytes, 1, maximumResultArtifactChunkBytes, "chunkBytes");
  requireSha256(input.chunkSha256, "chunkSha256");
  if (input.offsetBytes + input.chunkBytes > maximumResultArtifactBytes) {
    throw new RangeError("The artifact chunk exceeds the result artifact byte ceiling.");
  }
}

function validateFinalizeInput(input: PrepareArtifactFinalizeInput): void {
  validateLeaseIdentity(input);
  requireEntityId(input.uploadId, "uploadId");
  requireInteger(input.chunkCount, 1, maximumResultArtifactChunks, "chunkCount");
  requireInteger(input.totalBytes, 1, maximumResultArtifactBytes, "totalBytes");
  requireSha256(input.sha256, "sha256");
}

function validateTerminationInput(input: TerminateArtifactUploadInput): void {
  validateLeaseIdentity(input);
  requireEntityId(input.uploadId, "uploadId");
  if (input.state !== "abandoned" && input.state !== "corrupt") {
    throw new TypeError("Artifact upload termination requires an abandoned or corrupt state.");
  }
  if (!/^[a-z][a-z0-9_]{0,127}$/u.test(input.reason)) {
    throw new TypeError("Artifact upload termination requires a canonical reason code.");
  }
}

function validateLeaseIdentity(input: ArtifactLeaseIdentity): void {
  requireEntityId(input.jobId, "jobId");
  requireEntityId(input.runAttemptId, "runAttemptId");
  requireEntityId(input.workerNodeId, "workerNodeId");
  requireEntityId(input.workerInstanceId, "workerInstanceId");
  requireInteger(input.leaseGeneration, 1, Number.MAX_SAFE_INTEGER, "leaseGeneration");
  if (
    typeof input.leaseToken !== "string" ||
    input.leaseToken.length < 32 ||
    input.leaseToken.length > 1024
  ) {
    throw new TypeError("leaseToken must contain between 32 and 1024 characters.");
  }
}

function requireEntityId(value: string, name: string): void {
  if (typeof value !== "string" || !entityIdPattern.test(value)) {
    throw new TypeError(`${name} must be a valid entity identifier.`);
  }
}

function requireUuid(value: string, name: string): void {
  if (typeof value !== "string" || !uuidV4Pattern.test(value)) {
    throw new TypeError(`${name} must be a lowercase UUIDv4.`);
  }
}

function requireSha256(value: string, name: string): void {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest.`);
  }
}

function requireInteger(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}
