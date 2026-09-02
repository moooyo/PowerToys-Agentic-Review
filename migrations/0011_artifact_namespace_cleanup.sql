CREATE TABLE artifact_namespace_reconciliation_cursors (
  name TEXT PRIMARY KEY CHECK (name = 'managed_namespace_v2'),
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

INSERT INTO artifact_namespace_reconciliation_cursors (
  name,
  sweep_generation,
  after_key,
  updated_at,
  last_completed_at
) VALUES (
  'managed_namespace_v2',
  0,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL
);

CREATE TRIGGER tr_artifact_namespace_reconciliation_cursor_identity_immutable
BEFORE UPDATE OF name ON artifact_namespace_reconciliation_cursors
WHEN NEW.name IS NOT OLD.name
BEGIN
  SELECT RAISE(ABORT, 'artifact namespace reconciliation cursor identity is immutable');
END;

CREATE TRIGGER tr_artifact_namespace_reconciliation_cursor_delete
BEFORE DELETE ON artifact_namespace_reconciliation_cursors
BEGIN
  SELECT RAISE(ABORT, 'artifact namespace reconciliation cursor is durable');
END;

CREATE TABLE artifact_namespace_cleanup_journal (
  entry_key TEXT NOT NULL,
  observation_sha256 TEXT NOT NULL CHECK (
    length(observation_sha256) = 64
    AND length(CAST(observation_sha256 AS BLOB)) = 64
    AND instr(observation_sha256, char(0)) = 0
    AND observation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('staging', 'publication-temporary')),
  linked_object_sha256 TEXT CHECK (
    linked_object_sha256 IS NULL
    OR (
      length(linked_object_sha256) = 64
      AND length(CAST(linked_object_sha256 AS BLOB)) = 64
      AND instr(linked_object_sha256, char(0)) = 0
      AND linked_object_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  observed_bytes INTEGER NOT NULL CHECK (observed_bytes BETWEEN 0 AND 2097152),
  expected_link_count INTEGER NOT NULL CHECK (expected_link_count IN (1, 2)),
  file_device TEXT NOT NULL CHECK (
    length(file_device) BETWEEN 1 AND 40
    AND length(CAST(file_device AS BLOB)) = length(file_device)
    AND instr(file_device, char(0)) = 0
    AND file_device NOT GLOB '*[^0-9]*'
    AND (file_device = '0' OR substr(file_device, 1, 1) <> '0')
  ),
  file_inode TEXT NOT NULL CHECK (
    length(file_inode) BETWEEN 1 AND 40
    AND length(CAST(file_inode AS BLOB)) = length(file_inode)
    AND instr(file_inode, char(0)) = 0
    AND file_inode NOT GLOB '*[^0-9]*'
    AND (file_inode = '0' OR substr(file_inode, 1, 1) <> '0')
  ),
  file_ctime_ns TEXT NOT NULL CHECK (
    length(file_ctime_ns) BETWEEN 1 AND 40
    AND length(CAST(file_ctime_ns AS BLOB)) = length(file_ctime_ns)
    AND instr(file_ctime_ns, char(0)) = 0
    AND file_ctime_ns NOT GLOB '*[^0-9]*'
    AND (file_ctime_ns = '0' OR substr(file_ctime_ns, 1, 1) <> '0')
  ),
  file_mode TEXT NOT NULL CHECK (
    length(file_mode) BETWEEN 1 AND 40
    AND length(CAST(file_mode AS BLOB)) = length(file_mode)
    AND instr(file_mode, char(0)) = 0
    AND file_mode NOT GLOB '*[^0-9]*'
    AND (file_mode = '0' OR substr(file_mode, 1, 1) <> '0')
  ),
  file_uid TEXT NOT NULL CHECK (
    length(file_uid) BETWEEN 1 AND 40
    AND length(CAST(file_uid AS BLOB)) = length(file_uid)
    AND instr(file_uid, char(0)) = 0
    AND file_uid NOT GLOB '*[^0-9]*'
    AND (file_uid = '0' OR substr(file_uid, 1, 1) <> '0')
  ),
  parent_device TEXT NOT NULL CHECK (
    length(parent_device) BETWEEN 1 AND 40
    AND length(CAST(parent_device AS BLOB)) = length(parent_device)
    AND instr(parent_device, char(0)) = 0
    AND parent_device NOT GLOB '*[^0-9]*'
    AND (parent_device = '0' OR substr(parent_device, 1, 1) <> '0')
  ),
  parent_inode TEXT NOT NULL CHECK (
    length(parent_inode) BETWEEN 1 AND 40
    AND length(CAST(parent_inode AS BLOB)) = length(parent_inode)
    AND instr(parent_inode, char(0)) = 0
    AND parent_inode NOT GLOB '*[^0-9]*'
    AND (parent_inode = '0' OR substr(parent_inode, 1, 1) <> '0')
  ),
  parent_mode TEXT NOT NULL CHECK (
    length(parent_mode) BETWEEN 1 AND 40
    AND length(CAST(parent_mode AS BLOB)) = length(parent_mode)
    AND instr(parent_mode, char(0)) = 0
    AND parent_mode NOT GLOB '*[^0-9]*'
    AND (parent_mode = '0' OR substr(parent_mode, 1, 1) <> '0')
  ),
  parent_uid TEXT NOT NULL CHECK (
    length(parent_uid) BETWEEN 1 AND 40
    AND length(CAST(parent_uid AS BLOB)) = length(parent_uid)
    AND instr(parent_uid, char(0)) = 0
    AND parent_uid NOT GLOB '*[^0-9]*'
    AND (parent_uid = '0' OR substr(parent_uid, 1, 1) <> '0')
  ),
  linked_object_device TEXT CHECK (
    linked_object_device IS NULL
    OR (length(linked_object_device) BETWEEN 1 AND 40
      AND length(CAST(linked_object_device AS BLOB)) = length(linked_object_device)
      AND instr(linked_object_device, char(0)) = 0
      AND linked_object_device NOT GLOB '*[^0-9]*'
      AND (linked_object_device = '0' OR substr(linked_object_device, 1, 1) <> '0'))
  ),
  linked_object_inode TEXT CHECK (
    linked_object_inode IS NULL
    OR (length(linked_object_inode) BETWEEN 1 AND 40
      AND length(CAST(linked_object_inode AS BLOB)) = length(linked_object_inode)
      AND instr(linked_object_inode, char(0)) = 0
      AND linked_object_inode NOT GLOB '*[^0-9]*'
      AND (linked_object_inode = '0' OR substr(linked_object_inode, 1, 1) <> '0'))
  ),
  linked_object_ctime_ns TEXT CHECK (
    linked_object_ctime_ns IS NULL
    OR (length(linked_object_ctime_ns) BETWEEN 1 AND 40
      AND length(CAST(linked_object_ctime_ns AS BLOB)) = length(linked_object_ctime_ns)
      AND instr(linked_object_ctime_ns, char(0)) = 0
      AND linked_object_ctime_ns NOT GLOB '*[^0-9]*'
      AND (linked_object_ctime_ns = '0' OR substr(linked_object_ctime_ns, 1, 1) <> '0'))
  ),
  reason TEXT NOT NULL CHECK (
    reason IN ('orphan', 'completed_residual', 'stale_identity_mismatch')
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'retry_waiting', 'completed', 'failed', 'superseded')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  next_attempt_at TEXT,
  last_error_code TEXT CHECK (
    last_error_code IS NULL
    OR last_error_code IN (
      'storage_busy',
      'storage_io_failure',
      'storage_timeout',
      'storage_unavailable'
    )
  ),
  last_error_message TEXT,
  last_retry_delay_seconds INTEGER CHECK (
    last_retry_delay_seconds IS NULL
    OR last_retry_delay_seconds BETWEEN 1 AND 86400
  ),
  observed_sweep_generation INTEGER NOT NULL CHECK (
    observed_sweep_generation BETWEEN 0 AND 9007199254740991
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  superseded_at TEXT,
  PRIMARY KEY (entry_key, observation_sha256),
  CHECK (
    length(CAST(entry_key AS BLOB)) = length(entry_key)
    AND instr(entry_key, char(0)) = 0
  ),
  CHECK (updated_at >= created_at),
  CHECK (next_attempt_at IS NULL OR next_attempt_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK (superseded_at IS NULL OR superseded_at >= created_at),
  CHECK (file_device = parent_device),
  CHECK (
    linked_object_device IS NULL
    OR (linked_object_device = file_device
      AND linked_object_inode = file_inode
      AND linked_object_ctime_ns = file_ctime_ns)
  ),
  CHECK (
    (kind = 'staging'
      AND length(entry_key) = 51
      AND substr(entry_key, 1, 8) = 'staging/'
      AND substr(entry_key, 9, 36) GLOB
        '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      AND substr(entry_key, 45, 7) = '.upload'
      AND linked_object_sha256 IS NULL
      AND linked_object_device IS NULL
      AND linked_object_inode IS NULL
      AND linked_object_ctime_ns IS NULL
      AND expected_link_count = 1)
    OR (kind = 'publication-temporary'
      AND length(entry_key) = 104
      AND substr(entry_key, 1, 15) = 'objects/sha256/'
      AND substr(entry_key, 16, 2) NOT GLOB '*[^0-9a-f]*'
      AND substr(entry_key, 18, 10) = '/.publish-'
      AND substr(entry_key, 28, 36) GLOB
        '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      AND substr(entry_key, 64, 1) = '-'
      AND substr(entry_key, 65, 36) GLOB
        '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      AND substr(entry_key, 101, 4) = '.tmp'
      AND (
        (expected_link_count = 1
          AND linked_object_sha256 IS NULL
          AND linked_object_device IS NULL
          AND linked_object_inode IS NULL
          AND linked_object_ctime_ns IS NULL)
        OR (expected_link_count = 2
          AND linked_object_sha256 IS NOT NULL
          AND linked_object_device IS NOT NULL
          AND linked_object_inode IS NOT NULL
          AND linked_object_ctime_ns IS NOT NULL
          AND substr(linked_object_sha256, 1, 2) = substr(entry_key, 16, 2))
      ))
  ),
  CHECK (
    (last_error_code IS NULL
      AND last_error_message IS NULL
      AND last_retry_delay_seconds IS NULL)
    OR (last_error_code = 'storage_busy'
      AND last_error_message = 'Artifact namespace cleanup is temporarily busy.'
      AND last_retry_delay_seconds IS NOT NULL)
    OR (last_error_code = 'storage_io_failure'
      AND last_error_message = 'Artifact namespace cleanup encountered a storage I/O failure.'
      AND last_retry_delay_seconds IS NOT NULL)
    OR (last_error_code = 'storage_timeout'
      AND last_error_message = 'Artifact namespace cleanup exceeded its bounded deadline.'
      AND last_retry_delay_seconds IS NOT NULL)
    OR (last_error_code = 'storage_unavailable'
      AND last_error_message = 'Artifact namespace cleanup owner is unavailable.'
      AND last_retry_delay_seconds IS NOT NULL)
  ),
  CHECK (
    (status = 'pending'
      AND attempt_count = 0
      AND next_attempt_at IS NULL
      AND last_error_code IS NULL
      AND completed_at IS NULL
      AND superseded_at IS NULL)
    OR (status = 'retry_waiting'
      AND attempt_count BETWEEN 1 AND 7
      AND next_attempt_at IS NOT NULL
      AND last_error_code IS NOT NULL
      AND completed_at IS NULL
      AND superseded_at IS NULL)
    OR (status = 'completed'
      AND attempt_count BETWEEN 0 AND 7
      AND next_attempt_at IS NULL
      AND (
        (attempt_count = 0 AND last_error_code IS NULL)
        OR (attempt_count BETWEEN 1 AND 7 AND last_error_code IS NOT NULL)
      )
      AND completed_at IS NOT NULL
      AND superseded_at IS NULL)
    OR (status = 'failed'
      AND attempt_count = 8
      AND next_attempt_at IS NULL
      AND last_error_code IS NOT NULL
      AND completed_at IS NULL
      AND superseded_at IS NULL)
    OR (status = 'superseded'
      AND next_attempt_at IS NULL
      AND (
        (attempt_count = 0 AND last_error_code IS NULL)
        OR (attempt_count BETWEEN 1 AND 8 AND last_error_code IS NOT NULL)
      )
      AND completed_at IS NULL
      AND superseded_at IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX ux_artifact_namespace_cleanup_unresolved_entry
  ON artifact_namespace_cleanup_journal (entry_key)
  WHERE status IN ('pending', 'retry_waiting', 'failed');

CREATE INDEX ix_artifact_namespace_cleanup_due
  ON artifact_namespace_cleanup_journal (
    COALESCE(next_attempt_at, created_at),
    entry_key,
    observation_sha256
  )
  WHERE status IN ('pending', 'retry_waiting');

CREATE INDEX ix_artifact_namespace_cleanup_health_status
  ON artifact_namespace_cleanup_journal (status, entry_key, observation_sha256);

CREATE INDEX ix_artifact_namespace_cleanup_outstanding_created
  ON artifact_namespace_cleanup_journal (created_at, entry_key, observation_sha256)
  WHERE status IN ('pending', 'retry_waiting', 'failed');

CREATE TRIGGER tr_artifact_namespace_cleanup_insert_consistency
BEFORE INSERT ON artifact_namespace_cleanup_journal
WHEN NEW.status <> 'pending'
  OR NEW.attempt_count <> 0
  OR NEW.next_attempt_at IS NOT NULL
  OR NEW.last_error_code IS NOT NULL
  OR NEW.last_error_message IS NOT NULL
  OR NEW.last_retry_delay_seconds IS NOT NULL
  OR NEW.completed_at IS NOT NULL
  OR NEW.superseded_at IS NOT NULL
  OR NEW.updated_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'artifact namespace cleanup must begin pending');
END;

CREATE TRIGGER tr_artifact_namespace_cleanup_identity_immutable
BEFORE UPDATE OF
  entry_key,
  observation_sha256,
  kind,
  linked_object_sha256,
  observed_bytes,
  expected_link_count,
  file_device,
  file_inode,
  file_ctime_ns,
  file_mode,
  file_uid,
  parent_device,
  parent_inode,
  parent_mode,
  parent_uid,
  linked_object_device,
  linked_object_inode,
  linked_object_ctime_ns,
  reason,
  observed_sweep_generation,
  created_at
ON artifact_namespace_cleanup_journal
BEGIN
  SELECT RAISE(ABORT, 'artifact namespace cleanup identity is immutable');
END;

CREATE TRIGGER tr_artifact_namespace_cleanup_transition
BEFORE UPDATE ON artifact_namespace_cleanup_journal
WHEN NOT (
  (OLD.status = 'pending'
    AND NEW.status = 'completed'
    AND NEW.attempt_count = 0)
  OR (OLD.status = 'pending'
    AND NEW.status = 'retry_waiting'
    AND NEW.attempt_count = 1)
  OR (OLD.status = 'pending'
    AND NEW.status = 'superseded'
    AND NEW.attempt_count = 0
    AND NEW.last_error_code IS NULL
    AND NEW.last_error_message IS NULL
    AND NEW.last_retry_delay_seconds IS NULL)
  OR (OLD.status = 'retry_waiting'
    AND NEW.status = 'completed'
    AND NEW.attempt_count = OLD.attempt_count
    AND NEW.last_error_code IS OLD.last_error_code
    AND NEW.last_error_message IS OLD.last_error_message
    AND NEW.last_retry_delay_seconds IS OLD.last_retry_delay_seconds)
  OR (OLD.status = 'retry_waiting'
    AND NEW.status = 'retry_waiting'
    AND NEW.attempt_count = OLD.attempt_count + 1
    AND NEW.attempt_count < 8)
  OR (OLD.status = 'retry_waiting'
    AND NEW.status = 'failed'
    AND NEW.attempt_count = 8
    AND NEW.attempt_count = OLD.attempt_count + 1)
  OR (OLD.status IN ('retry_waiting', 'failed')
    AND NEW.status = 'superseded'
    AND NEW.attempt_count = OLD.attempt_count
    AND NEW.last_error_code IS OLD.last_error_code
    AND NEW.last_error_message IS OLD.last_error_message
    AND NEW.last_retry_delay_seconds IS OLD.last_retry_delay_seconds)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid artifact namespace cleanup transition');
END;

CREATE TRIGGER tr_artifact_namespace_cleanup_time_monotonic
BEFORE UPDATE ON artifact_namespace_cleanup_journal
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'artifact namespace cleanup time cannot move backwards');
END;

CREATE TRIGGER tr_artifact_namespace_cleanup_delete
BEFORE DELETE ON artifact_namespace_cleanup_journal
BEGIN
  SELECT RAISE(ABORT, 'artifact namespace cleanup records are immutable');
END;

CREATE TRIGGER tr_artifact_upload_namespace_staging_collision
BEFORE INSERT ON artifact_uploads
WHEN EXISTS (
  SELECT 1
  FROM artifact_namespace_cleanup_journal AS cleanup
  WHERE cleanup.entry_key = 'staging/' || NEW.id || '.upload'
    AND cleanup.status IN ('pending', 'retry_waiting', 'failed')
)
BEGIN
  SELECT RAISE(ABORT, 'artifact upload staging identity has unresolved namespace cleanup');
END;

CREATE TRIGGER tr_artifact_upload_namespace_temporary_collision
BEFORE UPDATE OF status, finalization_id, final_sha256 ON artifact_uploads
WHEN OLD.status = 'receiving'
  AND NEW.status = 'finalizing'
  AND EXISTS (
    SELECT 1
    FROM artifact_namespace_cleanup_journal AS cleanup
    WHERE cleanup.entry_key =
      'objects/sha256/' || substr(NEW.final_sha256, 1, 2) ||
      '/.publish-' || OLD.id || '-' || NEW.finalization_id || '.tmp'
      AND cleanup.status IN ('pending', 'retry_waiting', 'failed')
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact finalization identity has unresolved namespace cleanup');
END;
