ALTER TABLE run_attempts
ADD COLUMN completion_mode TEXT NOT NULL DEFAULT 'inline_result_v1'
CHECK (completion_mode IN ('inline_result_v1', 'result_artifact_v1'));

CREATE TRIGGER tr_run_attempt_completion_mode_immutable
BEFORE UPDATE OF completion_mode ON run_attempts
WHEN NEW.completion_mode IS NOT OLD.completion_mode
BEGIN
  SELECT RAISE(ABORT, 'run attempt completion mode is immutable');
END;

CREATE UNIQUE INDEX ux_run_artifacts_completion_identity
  ON run_artifacts (id, job_id, run_attempt_id, sha256);

CREATE TABLE artifact_completion_bindings (
  run_attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL UNIQUE,
  artifact_sha256 TEXT NOT NULL CHECK (
    length(artifact_sha256) = 64
    AND length(CAST(artifact_sha256 AS BLOB)) = 64
    AND instr(artifact_sha256, char(0)) = 0
    AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  result_digest TEXT NOT NULL CHECK (
    length(result_digest) = 64
    AND length(CAST(result_digest AS BLOB)) = 64
    AND instr(result_digest, char(0)) = 0
    AND result_digest NOT GLOB '*[^0-9a-f]*'
  ),
  canonicalization_version INTEGER NOT NULL CHECK (canonicalization_version = 1),
  terminal_response_json TEXT NOT NULL CHECK (
    json_valid(terminal_response_json)
    AND json_type(terminal_response_json) = 'object'
    AND length(CAST(terminal_response_json AS BLOB)) <= 4096
    AND json_extract(terminal_response_json, '$.jobId') IS job_id
    AND json_extract(terminal_response_json, '$.runAttemptId') IS run_attempt_id
    AND json_extract(terminal_response_json, '$.jobState') IS 'succeeded'
    AND json_extract(terminal_response_json, '$.runState') IS 'succeeded'
  ),
  completed_at TEXT NOT NULL,
  FOREIGN KEY (run_attempt_id, job_id)
    REFERENCES run_attempts (id, job_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, job_id, run_attempt_id, artifact_sha256)
    REFERENCES run_artifacts (id, job_id, run_attempt_id, sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER tr_artifact_completion_binding_insert_consistency
BEFORE INSERT ON artifact_completion_bindings
WHEN EXISTS (
  SELECT 1
  FROM artifact_completion_bindings AS binding
  WHERE binding.run_attempt_id = NEW.run_attempt_id
    OR binding.artifact_id = NEW.artifact_id
)
OR NOT EXISTS (
  SELECT 1
  FROM run_attempts AS attempt
  WHERE attempt.id = NEW.run_attempt_id
    AND attempt.job_id = NEW.job_id
    AND attempt.completion_mode = 'result_artifact_v1'
    AND attempt.status IN ('leased', 'running')
)
OR NOT EXISTS (
  SELECT 1
  FROM run_artifacts AS artifact
  JOIN artifact_uploads AS upload ON upload.id = artifact.upload_id
  WHERE artifact.id = NEW.artifact_id
    AND artifact.job_id = NEW.job_id
    AND artifact.run_attempt_id = NEW.run_attempt_id
    AND upload.status = 'committed'
)
BEGIN
  SELECT RAISE(ABORT, 'artifact completion binding does not match its run attempt');
END;

CREATE TRIGGER tr_artifact_completion_bindings_immutable_update
BEFORE UPDATE ON artifact_completion_bindings
BEGIN
  SELECT RAISE(ABORT, 'artifact completion bindings are immutable');
END;

CREATE TRIGGER tr_artifact_completion_bindings_immutable_delete
BEFORE DELETE ON artifact_completion_bindings
BEGIN
  SELECT RAISE(ABORT, 'artifact completion bindings are immutable');
END;

CREATE TRIGGER tr_run_attempt_artifact_completion_consistency
BEFORE UPDATE OF status, result_digest ON run_attempts
WHEN NEW.status = 'succeeded'
  AND OLD.status <> 'succeeded'
  AND NEW.completion_mode = 'result_artifact_v1'
  AND NOT EXISTS (
    SELECT 1
    FROM artifact_completion_bindings AS binding
    WHERE binding.run_attempt_id = NEW.id
      AND binding.job_id = NEW.job_id
      AND binding.result_digest = NEW.result_digest
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact completion lacks its immutable terminal binding');
END;

CREATE TRIGGER tr_run_attempt_artifact_completion_immutable
BEFORE UPDATE OF
  job_id,
  worker_id,
  worker_node_id,
  worker_instance_id,
  status,
  lease_token_hash,
  lease_generation,
  result_digest,
  result_json,
  ended_at
ON run_attempts
WHEN EXISTS (
  SELECT 1
  FROM artifact_completion_bindings AS binding
  WHERE binding.run_attempt_id = OLD.id
)
AND (
  NEW.job_id IS NOT OLD.job_id
  OR NEW.worker_id IS NOT OLD.worker_id
  OR NEW.worker_node_id IS NOT OLD.worker_node_id
  OR NEW.worker_instance_id IS NOT OLD.worker_instance_id
  OR NEW.status IS NOT OLD.status
  OR NEW.lease_token_hash IS NOT OLD.lease_token_hash
  OR NEW.lease_generation IS NOT OLD.lease_generation
  OR NEW.result_digest IS NOT OLD.result_digest
  OR NEW.result_json IS NOT OLD.result_json
  OR NEW.ended_at IS NOT OLD.ended_at
)
AND NOT (
  OLD.status IN ('leased', 'running')
  AND NEW.status = 'succeeded'
  AND NEW.result_json IS NOT NULL
  AND NEW.job_id IS OLD.job_id
  AND NEW.worker_id IS OLD.worker_id
  AND NEW.worker_node_id IS OLD.worker_node_id
  AND NEW.worker_instance_id IS OLD.worker_instance_id
  AND NEW.lease_token_hash IS OLD.lease_token_hash
  AND NEW.lease_generation IS OLD.lease_generation
  AND EXISTS (
    SELECT 1
    FROM artifact_completion_bindings AS binding
    WHERE binding.run_attempt_id = OLD.id
      AND binding.job_id = NEW.job_id
      AND binding.result_digest = NEW.result_digest
      AND binding.completed_at = NEW.ended_at
  )
)
BEGIN
  SELECT RAISE(ABORT, 'completed artifact attempt identity is immutable');
END;

CREATE TABLE artifact_upload_cleanup_journal (
  upload_id TEXT PRIMARY KEY
    REFERENCES artifact_uploads (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  terminal_status TEXT NOT NULL CHECK (
    terminal_status IN ('committed', 'abandoned', 'corrupt')
  ),
  cleanup_scope TEXT NOT NULL DEFAULT 'staging_only_v1'
    CHECK (cleanup_scope = 'staging_only_v1'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retry_waiting', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  next_attempt_at TEXT,
  last_error_code TEXT CHECK (
    last_error_code IS NULL
    OR (
      length(last_error_code) BETWEEN 1 AND 128
      AND substr(last_error_code, 1, 1) GLOB '[a-z]'
      AND last_error_code NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  last_error_message TEXT CHECK (
    last_error_message IS NULL OR length(last_error_message) BETWEEN 1 AND 2048
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (status = 'pending'
      AND attempt_count = 0
      AND next_attempt_at IS NULL
      AND last_error_code IS NULL
      AND last_error_message IS NULL
      AND completed_at IS NULL)
    OR (status = 'retry_waiting'
      AND attempt_count BETWEEN 1 AND 7
      AND next_attempt_at IS NOT NULL
      AND last_error_code IS NOT NULL
      AND last_error_message IS NOT NULL
      AND completed_at IS NULL)
    OR (status = 'completed'
      AND next_attempt_at IS NULL
      AND completed_at IS NOT NULL)
    OR (status = 'failed'
      AND attempt_count = 8
      AND next_attempt_at IS NULL
      AND last_error_code IS NOT NULL
      AND last_error_message IS NOT NULL
      AND completed_at IS NULL)
  )
) STRICT;

CREATE INDEX ix_artifact_upload_cleanup_journal_due
  ON artifact_upload_cleanup_journal (status, next_attempt_at, created_at, upload_id);

CREATE TRIGGER tr_artifact_upload_cleanup_insert_consistency
BEFORE INSERT ON artifact_upload_cleanup_journal
WHEN EXISTS (
  SELECT 1
  FROM artifact_upload_cleanup_journal AS cleanup
  WHERE cleanup.upload_id = NEW.upload_id
)
  OR NEW.status <> 'pending'
  OR NEW.attempt_count <> 0
  OR NEW.next_attempt_at IS NOT NULL
  OR NEW.last_error_code IS NOT NULL
  OR NEW.last_error_message IS NOT NULL
  OR NEW.completed_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
    FROM artifact_uploads AS upload
    WHERE upload.id = NEW.upload_id
      AND upload.status = NEW.terminal_status
      AND upload.status IN ('committed', 'abandoned', 'corrupt')
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact upload cleanup does not match a terminal upload');
END;

CREATE TRIGGER tr_artifact_upload_cleanup_identity_immutable
BEFORE UPDATE OF upload_id, terminal_status, cleanup_scope, created_at
ON artifact_upload_cleanup_journal
BEGIN
  SELECT RAISE(ABORT, 'artifact upload cleanup identity is immutable');
END;

CREATE TRIGGER tr_artifact_upload_cleanup_transition
BEFORE UPDATE ON artifact_upload_cleanup_journal
WHEN NOT (
  (OLD.status = 'pending'
    AND NEW.status = 'completed'
    AND NEW.attempt_count = 0)
  OR (OLD.status = 'pending'
    AND NEW.status = 'retry_waiting'
    AND NEW.attempt_count = 1)
  OR (OLD.status = 'retry_waiting'
    AND NEW.status = 'completed'
    AND NEW.attempt_count = OLD.attempt_count)
  OR (OLD.status = 'retry_waiting'
    AND NEW.status = 'retry_waiting'
    AND NEW.attempt_count = OLD.attempt_count + 1
    AND NEW.attempt_count < 8)
  OR (OLD.status = 'retry_waiting'
    AND NEW.status = 'failed'
    AND NEW.attempt_count = OLD.attempt_count + 1
    AND NEW.attempt_count = 8)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid artifact upload cleanup transition');
END;

CREATE TRIGGER tr_artifact_upload_cleanup_delete
BEFORE DELETE ON artifact_upload_cleanup_journal
BEGIN
  SELECT RAISE(ABORT, 'artifact upload cleanup records are immutable');
END;

INSERT INTO artifact_upload_cleanup_journal (
  upload_id,
  terminal_status,
  cleanup_scope,
  status,
  attempt_count,
  created_at,
  updated_at
)
SELECT
  upload.id,
  upload.status,
  'staging_only_v1',
  'pending',
  0,
  COALESCE(upload.committed_at, upload.terminated_at, upload.updated_at),
  COALESCE(upload.committed_at, upload.terminated_at, upload.updated_at)
FROM artifact_uploads AS upload
WHERE upload.status IN ('committed', 'abandoned', 'corrupt');

CREATE TRIGGER tr_artifact_upload_enqueue_cleanup
AFTER UPDATE OF status ON artifact_uploads
WHEN NEW.status IN ('committed', 'abandoned', 'corrupt')
  AND OLD.status NOT IN ('committed', 'abandoned', 'corrupt')
BEGIN
  INSERT INTO artifact_upload_cleanup_journal (
    upload_id,
    terminal_status,
    cleanup_scope,
    status,
    attempt_count,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    NEW.status,
    'staging_only_v1',
    'pending',
    0,
    COALESCE(NEW.committed_at, NEW.terminated_at, NEW.updated_at),
    COALESCE(NEW.committed_at, NEW.terminated_at, NEW.updated_at)
  );
END;

CREATE TRIGGER tr_artifact_upload_replacement_guard
BEFORE INSERT ON artifact_uploads
WHEN EXISTS (
  SELECT 1
  FROM artifact_uploads AS upload
  WHERE upload.id = NEW.id
    OR (
      upload.run_attempt_id = NEW.run_attempt_id
      AND upload.client_artifact_id = NEW.client_artifact_id
    )
    OR (
      upload.run_attempt_id = NEW.run_attempt_id
      AND upload.purpose = NEW.purpose
      AND upload.status IN ('receiving', 'finalizing', 'committed')
      AND NEW.status IN ('receiving', 'finalizing', 'committed')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'artifact upload identities and live results cannot be replaced');
END;

CREATE TRIGGER tr_artifact_upload_primary_key_immutable
BEFORE UPDATE OF id ON artifact_uploads
WHEN NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT, 'artifact upload primary keys are immutable');
END;

CREATE TRIGGER tr_artifact_upload_attempt_quota
BEFORE INSERT ON artifact_uploads
BEGIN
  SELECT CASE
    WHEN (
      SELECT COALESCE(SUM(upload.expected_total_bytes), 0)
      FROM artifact_uploads AS upload
      WHERE upload.run_attempt_id = NEW.run_attempt_id
    ) > 16777216 - NEW.expected_total_bytes
    THEN RAISE(ABORT, 'artifact upload declared-byte quota exceeded')
    WHEN (
      SELECT COUNT(*)
      FROM artifact_uploads AS upload
      WHERE upload.run_attempt_id = NEW.run_attempt_id
    ) >= 8
    THEN RAISE(ABORT, 'artifact upload identity quota exceeded')
  END;
END;
