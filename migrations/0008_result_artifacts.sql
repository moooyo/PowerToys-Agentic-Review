CREATE TABLE artifact_uploads (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  run_attempt_id TEXT NOT NULL,
  worker_node_id TEXT NOT NULL,
  worker_instance_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  client_artifact_id TEXT NOT NULL CHECK (
    length(client_artifact_id) = 36
    AND client_artifact_id = lower(client_artifact_id)
    AND client_artifact_id GLOB
      '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  purpose TEXT NOT NULL CHECK (purpose = 'result'),
  name TEXT NOT NULL CHECK (
    length(name) BETWEEN 1 AND 128
    AND substr(name, 1, 1) GLOB '[A-Za-z0-9]'
    AND name NOT GLOB '*[^A-Za-z0-9._+-]*'
  ),
  media_type TEXT NOT NULL CHECK (media_type = 'application/json'),
  expected_total_bytes INTEGER NOT NULL CHECK (
    expected_total_bytes BETWEEN 1 AND 2097152
  ),
  expected_sha256 TEXT NOT NULL CHECK (
    length(expected_sha256) = 64
    AND length(CAST(expected_sha256 AS BLOB)) = 64
    AND instr(expected_sha256, char(0)) = 0
    AND expected_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('receiving', 'finalizing', 'committed', 'abandoned', 'corrupt')
  ),
  next_chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk_index BETWEEN 0 AND 8),
  received_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
    received_bytes BETWEEN 0 AND expected_total_bytes
  ),
  finalization_id TEXT UNIQUE,
  final_chunk_count INTEGER CHECK (final_chunk_count BETWEEN 1 AND 8),
  final_total_bytes INTEGER CHECK (final_total_bytes BETWEEN 1 AND 2097152),
  final_sha256 TEXT CHECK (
    final_sha256 IS NULL
    OR (
      length(final_sha256) = 64
      AND length(CAST(final_sha256 AS BLOB)) = 64
      AND instr(final_sha256, char(0)) = 0
      AND final_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  finalizing_at TEXT,
  committed_at TEXT,
  terminated_at TEXT,
  termination_reason TEXT CHECK (
    termination_reason IS NULL
    OR (
      length(termination_reason) BETWEEN 1 AND 128
      AND substr(termination_reason, 1, 1) GLOB '[a-z]'
      AND termination_reason NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_attempt_id, job_id)
    REFERENCES run_attempts (id, job_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (run_attempt_id, client_artifact_id),
  UNIQUE (id, job_id, run_attempt_id),
  CHECK (
    (finalization_id IS NULL) = (final_chunk_count IS NULL)
    AND (finalization_id IS NULL) = (final_total_bytes IS NULL)
    AND (finalization_id IS NULL) = (final_sha256 IS NULL)
    AND (finalization_id IS NULL) = (finalizing_at IS NULL)
  ),
  CHECK (
    (status = 'receiving'
      AND finalization_id IS NULL
      AND committed_at IS NULL
      AND terminated_at IS NULL
      AND termination_reason IS NULL)
    OR (status = 'finalizing'
      AND finalization_id IS NOT NULL
      AND committed_at IS NULL
      AND terminated_at IS NULL
      AND termination_reason IS NULL)
    OR (status = 'committed'
      AND finalization_id IS NOT NULL
      AND committed_at IS NOT NULL
      AND terminated_at IS NULL
      AND termination_reason IS NULL)
    OR (status IN ('abandoned', 'corrupt')
      AND committed_at IS NULL
      AND terminated_at IS NOT NULL
      AND termination_reason IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX ux_artifact_uploads_live_result
  ON artifact_uploads (run_attempt_id, purpose)
  WHERE status IN ('receiving', 'finalizing', 'committed');

CREATE INDEX ix_artifact_uploads_recovery
  ON artifact_uploads (status, updated_at);

CREATE TABLE artifact_upload_chunks (
  upload_id TEXT NOT NULL REFERENCES artifact_uploads (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 7),
  prepare_id TEXT NOT NULL UNIQUE,
  offset_bytes INTEGER NOT NULL CHECK (offset_bytes BETWEEN 0 AND 2097151),
  chunk_bytes INTEGER NOT NULL CHECK (chunk_bytes BETWEEN 1 AND 262144),
  chunk_sha256 TEXT NOT NULL CHECK (
    length(chunk_sha256) = 64
    AND length(CAST(chunk_sha256 AS BLOB)) = 64
    AND instr(chunk_sha256, char(0)) = 0
    AND chunk_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'committed')),
  prepared_at TEXT NOT NULL,
  committed_at TEXT,
  PRIMARY KEY (upload_id, chunk_index),
  CHECK (
    (status = 'prepared' AND committed_at IS NULL)
    OR (status = 'committed' AND committed_at IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_artifact_upload_chunks_status
  ON artifact_upload_chunks (upload_id, status, chunk_index);

CREATE TABLE run_artifacts (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL,
  run_attempt_id TEXT NOT NULL,
  client_artifact_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose = 'result'),
  name TEXT NOT NULL CHECK (
    length(name) BETWEEN 1 AND 128
    AND substr(name, 1, 1) GLOB '[A-Za-z0-9]'
    AND name NOT GLOB '*[^A-Za-z0-9._+-]*'
  ),
  media_type TEXT NOT NULL CHECK (media_type = 'application/json'),
  total_bytes INTEGER NOT NULL CHECK (total_bytes BETWEEN 1 AND 2097152),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64
    AND length(CAST(sha256 AS BLOB)) = 64
    AND instr(sha256, char(0)) = 0
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  storage_object_key TEXT NOT NULL CHECK (
    length(storage_object_key) = 74
    AND storage_object_key GLOB 'sha256/[0-9a-f][0-9a-f]/[0-9a-f]*'
    AND substr(storage_object_key, 8, 2) = substr(sha256, 1, 2)
    AND substr(storage_object_key, 11) = sha256
  ),
  created_at TEXT NOT NULL,
  FOREIGN KEY (upload_id, job_id, run_attempt_id)
    REFERENCES artifact_uploads (id, job_id, run_attempt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (run_attempt_id, job_id)
    REFERENCES run_attempts (id, job_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (run_attempt_id, client_artifact_id),
  UNIQUE (run_attempt_id, purpose)
) STRICT;

CREATE INDEX ix_run_artifacts_job_attempt
  ON run_artifacts (job_id, run_attempt_id, created_at);

CREATE TRIGGER tr_artifact_upload_insert_consistency
BEFORE INSERT ON artifact_uploads
WHEN NEW.status <> 'receiving'
  OR NEW.next_chunk_index <> 0
  OR NEW.received_bytes <> 0
  OR NEW.finalization_id IS NOT NULL
  OR NEW.final_chunk_count IS NOT NULL
  OR NEW.final_total_bytes IS NOT NULL
  OR NEW.final_sha256 IS NOT NULL
  OR NEW.finalizing_at IS NOT NULL
  OR NEW.committed_at IS NOT NULL
  OR NEW.terminated_at IS NOT NULL
  OR NEW.termination_reason IS NOT NULL
  OR NOT EXISTS (
  SELECT 1
  FROM run_attempts AS attempt
  WHERE attempt.id = NEW.run_attempt_id
    AND attempt.job_id = NEW.job_id
    AND attempt.worker_node_id = NEW.worker_node_id
    AND attempt.worker_instance_id = NEW.worker_instance_id
    AND attempt.lease_generation = NEW.lease_generation
)
BEGIN
  SELECT RAISE(ABORT, 'artifact upload attempt identity mismatch');
END;

CREATE TRIGGER tr_artifact_chunk_prepare_consistency
BEFORE INSERT ON artifact_upload_chunks
WHEN NEW.status <> 'prepared'
  OR NEW.committed_at IS NOT NULL
  OR NOT EXISTS (
  SELECT 1
  FROM artifact_uploads AS upload
  WHERE upload.id = NEW.upload_id
    AND upload.status = 'receiving'
    AND NEW.chunk_index = upload.next_chunk_index
    AND NEW.offset_bytes = upload.received_bytes
    AND NEW.offset_bytes + NEW.chunk_bytes <= upload.expected_total_bytes
)
BEGIN
  SELECT RAISE(ABORT, 'artifact chunk does not match the upload cursor');
END;

CREATE TRIGGER tr_artifact_chunk_receipt_update
BEFORE UPDATE ON artifact_upload_chunks
WHEN
  OLD.status <> 'prepared'
  OR NEW.status <> 'committed'
  OR NEW.committed_at IS NULL
  OR NEW.upload_id <> OLD.upload_id
  OR NEW.chunk_index <> OLD.chunk_index
  OR NEW.prepare_id <> OLD.prepare_id
  OR NEW.offset_bytes <> OLD.offset_bytes
  OR NEW.chunk_bytes <> OLD.chunk_bytes
  OR NEW.chunk_sha256 <> OLD.chunk_sha256
  OR NEW.prepared_at <> OLD.prepared_at
BEGIN
  SELECT RAISE(ABORT, 'artifact chunk receipts are immutable after preparation');
END;

CREATE TRIGGER tr_artifact_chunk_receipt_delete
BEFORE DELETE ON artifact_upload_chunks
BEGIN
  SELECT RAISE(ABORT, 'artifact chunk receipts are immutable');
END;

CREATE TRIGGER tr_artifact_upload_cursor_update
BEFORE UPDATE OF next_chunk_index, received_bytes ON artifact_uploads
WHEN
  NEW.next_chunk_index <> OLD.next_chunk_index
  OR NEW.received_bytes <> OLD.received_bytes
BEGIN
  SELECT CASE
    WHEN OLD.status <> 'receiving'
      OR NEW.next_chunk_index <> OLD.next_chunk_index + 1
      OR NOT EXISTS (
        SELECT 1
        FROM artifact_upload_chunks AS chunk
        WHERE chunk.upload_id = OLD.id
          AND chunk.chunk_index = OLD.next_chunk_index
          AND chunk.status = 'committed'
          AND chunk.offset_bytes = OLD.received_bytes
          AND NEW.received_bytes = OLD.received_bytes + chunk.chunk_bytes
      )
    THEN RAISE(ABORT, 'artifact upload cursor lacks a committed chunk receipt')
  END;
END;

CREATE TRIGGER tr_artifact_upload_finalizing_consistency
BEFORE UPDATE OF status ON artifact_uploads
WHEN NEW.status = 'finalizing' AND OLD.status <> 'finalizing'
BEGIN
  SELECT CASE
    WHEN OLD.status <> 'receiving'
      OR NEW.final_chunk_count <> OLD.next_chunk_index
      OR NEW.final_total_bytes <> OLD.received_bytes
      OR NEW.final_total_bytes <> OLD.expected_total_bytes
      OR NEW.final_sha256 <> OLD.expected_sha256
      OR (
        SELECT COUNT(*)
        FROM artifact_upload_chunks AS chunk
        WHERE chunk.upload_id = OLD.id AND chunk.status = 'committed'
      ) <> NEW.final_chunk_count
    THEN RAISE(ABORT, 'artifact finalization does not match committed chunk receipts')
  END;
END;

CREATE TRIGGER tr_run_artifact_insert_consistency
BEFORE INSERT ON run_artifacts
WHEN NOT EXISTS (
  SELECT 1
  FROM artifact_uploads AS upload
  WHERE upload.id = NEW.upload_id
    AND upload.finalization_id = NEW.id
    AND upload.job_id = NEW.job_id
    AND upload.run_attempt_id = NEW.run_attempt_id
    AND upload.client_artifact_id = NEW.client_artifact_id
    AND upload.purpose = NEW.purpose
    AND upload.name = NEW.name
    AND upload.media_type = NEW.media_type
    AND upload.status = 'finalizing'
    AND upload.final_total_bytes = NEW.total_bytes
    AND upload.final_sha256 = NEW.sha256
)
BEGIN
  SELECT RAISE(ABORT, 'run artifact does not match its finalized upload');
END;

CREATE TRIGGER tr_artifact_upload_commit_consistency
BEFORE UPDATE OF status ON artifact_uploads
WHEN NEW.status = 'committed' AND OLD.status <> 'committed'
BEGIN
  SELECT CASE
    WHEN OLD.status <> 'finalizing'
      OR NEW.committed_at IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM run_artifacts AS artifact
        WHERE artifact.upload_id = OLD.id
          AND artifact.job_id = OLD.job_id
          AND artifact.run_attempt_id = OLD.run_attempt_id
          AND artifact.sha256 = OLD.final_sha256
          AND artifact.total_bytes = OLD.final_total_bytes
      )
    THEN RAISE(ABORT, 'committed artifact upload lacks an immutable run artifact')
  END;
END;

CREATE TRIGGER tr_artifact_upload_terminal_immutable
BEFORE UPDATE ON artifact_uploads
WHEN OLD.status IN ('committed', 'abandoned', 'corrupt')
BEGIN
  SELECT RAISE(ABORT, 'terminal artifact uploads are immutable');
END;

CREATE TRIGGER tr_artifact_upload_status_transition
BEFORE UPDATE OF status ON artifact_uploads
WHEN NEW.status <> OLD.status
  AND NOT (
    (OLD.status = 'receiving'
      AND NEW.status IN ('finalizing', 'abandoned', 'corrupt'))
    OR (OLD.status = 'finalizing'
      AND NEW.status IN ('committed', 'abandoned', 'corrupt'))
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid artifact upload status transition');
END;

CREATE TRIGGER tr_artifact_upload_termination_consistency
BEFORE UPDATE OF status ON artifact_uploads
WHEN NEW.status IN ('abandoned', 'corrupt')
  AND OLD.status NOT IN ('abandoned', 'corrupt')
  AND EXISTS (
    SELECT 1 FROM run_artifacts AS artifact WHERE artifact.upload_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'an upload with an immutable run artifact cannot be terminated');
END;

CREATE TRIGGER tr_artifact_upload_finalization_immutable
BEFORE UPDATE OF
  finalization_id,
  final_chunk_count,
  final_total_bytes,
  final_sha256,
  finalizing_at
ON artifact_uploads
WHEN (
  NEW.finalization_id IS NOT OLD.finalization_id
  OR NEW.final_chunk_count IS NOT OLD.final_chunk_count
  OR NEW.final_total_bytes IS NOT OLD.final_total_bytes
  OR NEW.final_sha256 IS NOT OLD.final_sha256
  OR NEW.finalizing_at IS NOT OLD.finalizing_at
)
AND NOT (
  OLD.status = 'receiving'
  AND NEW.status = 'finalizing'
  AND OLD.finalization_id IS NULL
  AND OLD.final_chunk_count IS NULL
  AND OLD.final_total_bytes IS NULL
  AND OLD.final_sha256 IS NULL
  AND OLD.finalizing_at IS NULL
  AND NEW.finalization_id IS NOT NULL
  AND NEW.final_chunk_count IS NOT NULL
  AND NEW.final_total_bytes IS NOT NULL
  AND NEW.final_sha256 IS NOT NULL
  AND NEW.finalizing_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'artifact finalization identity is immutable');
END;

CREATE TRIGGER tr_artifact_upload_identity_immutable
BEFORE UPDATE OF
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
  created_at
ON artifact_uploads
BEGIN
  SELECT RAISE(ABORT, 'artifact upload identity is immutable');
END;

CREATE TRIGGER tr_artifact_upload_delete
BEFORE DELETE ON artifact_uploads
BEGIN
  SELECT RAISE(ABORT, 'artifact uploads are immutable');
END;

CREATE TRIGGER tr_run_artifacts_immutable_update
BEFORE UPDATE ON run_artifacts
BEGIN
  SELECT RAISE(ABORT, 'run artifacts are immutable');
END;

CREATE TRIGGER tr_run_artifacts_immutable_delete
BEFORE DELETE ON run_artifacts
BEGIN
  SELECT RAISE(ABORT, 'run artifacts are immutable');
END;
