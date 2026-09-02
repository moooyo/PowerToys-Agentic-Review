ALTER TABLE artifact_upload_cleanup_journal
ADD COLUMN last_retry_delay_seconds INTEGER CHECK (
  last_retry_delay_seconds IS NULL
  OR last_retry_delay_seconds BETWEEN 1 AND 86400
);

CREATE INDEX ix_artifact_uploads_reconciliation_v1
  ON artifact_uploads (updated_at, id)
  WHERE status IN ('receiving', 'finalizing');

CREATE INDEX ix_artifact_upload_cleanup_journal_due_v2
  ON artifact_upload_cleanup_journal (
    COALESCE(next_attempt_at, created_at),
    upload_id
  )
  WHERE status IN ('pending', 'retry_waiting');

CREATE TABLE artifact_reconciliation_cursors (
  name TEXT PRIMARY KEY CHECK (name = 'managed_namespace_v1'),
  sweep_generation INTEGER NOT NULL DEFAULT 0 CHECK (
    sweep_generation BETWEEN 0 AND 9007199254740991
  ),
  after_key TEXT CHECK (
    after_key IS NULL
    OR (
      length(after_key) BETWEEN 1 AND 256
      AND length(CAST(after_key AS BLOB)) = length(after_key)
      AND instr(after_key, char(0)) = 0
      AND after_key NOT GLOB '*[^A-Za-z0-9._/-]*'
      AND substr(after_key, 1, 1) <> '/'
      AND substr(after_key, -1, 1) <> '/'
      AND after_key <> '.'
      AND after_key <> '..'
      AND after_key NOT LIKE './%'
      AND after_key NOT LIKE '../%'
      AND after_key NOT LIKE '%/./%'
      AND after_key NOT LIKE '%/../%'
      AND after_key NOT LIKE '%/.'
      AND after_key NOT LIKE '%/..'
      AND after_key NOT LIKE '%//%'
    )
  ),
  updated_at TEXT NOT NULL,
  last_completed_at TEXT,
  CHECK (last_completed_at IS NULL OR last_completed_at <= updated_at)
) STRICT;

INSERT INTO artifact_reconciliation_cursors (
  name,
  sweep_generation,
  after_key,
  updated_at,
  last_completed_at
) VALUES (
  'managed_namespace_v1',
  0,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL
);

CREATE TRIGGER tr_artifact_reconciliation_cursor_identity_immutable
BEFORE UPDATE OF name ON artifact_reconciliation_cursors
WHEN NEW.name IS NOT OLD.name
BEGIN
  SELECT RAISE(ABORT, 'artifact reconciliation cursor identity is immutable');
END;

CREATE TRIGGER tr_artifact_reconciliation_cursor_delete
BEFORE DELETE ON artifact_reconciliation_cursors
BEGIN
  SELECT RAISE(ABORT, 'artifact reconciliation cursor is durable');
END;

CREATE TRIGGER tr_artifact_cleanup_retry_delay_insert_consistency
BEFORE INSERT ON artifact_upload_cleanup_journal
WHEN NEW.last_retry_delay_seconds IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'pending artifact cleanup cannot have retry delay identity');
END;

CREATE TRIGGER tr_artifact_cleanup_retry_delay_update_consistency
BEFORE UPDATE ON artifact_upload_cleanup_journal
WHEN NOT (
  (NEW.status = 'pending' AND NEW.last_retry_delay_seconds IS NULL)
  OR (NEW.status = 'retry_waiting' AND NEW.last_retry_delay_seconds IS NOT NULL)
  OR (NEW.status = 'failed' AND NEW.last_retry_delay_seconds IS NOT NULL)
  OR (NEW.status = 'completed'
    AND (
      (NEW.attempt_count = 0 AND NEW.last_retry_delay_seconds IS NULL)
      OR (NEW.attempt_count BETWEEN 1 AND 7
        AND NEW.last_retry_delay_seconds IS NOT NULL)
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'artifact cleanup retry delay identity is inconsistent');
END;

CREATE TRIGGER tr_artifact_cleanup_completed_failure_identity_immutable
BEFORE UPDATE OF last_error_code, last_error_message, last_retry_delay_seconds
ON artifact_upload_cleanup_journal
WHEN NEW.status = 'completed'
  AND (
    NEW.last_error_code IS NOT OLD.last_error_code
    OR NEW.last_error_message IS NOT OLD.last_error_message
    OR NEW.last_retry_delay_seconds IS NOT OLD.last_retry_delay_seconds
  )
BEGIN
  SELECT RAISE(ABORT, 'completed artifact cleanup failure identity is immutable');
END;
