-- The exact-version migration hook backfills these operational rows with the production parser
-- before recording migration 24. No existing Job, attempt, plan, result or audit is rewritten.
CREATE TABLE scheduling_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  episode_sequence INTEGER NOT NULL DEFAULT 0 CHECK (episode_sequence BETWEEN 0 AND 9007199254740991),
  inspection_sequence INTEGER NOT NULL DEFAULT 0 CHECK (inspection_sequence BETWEEN 0 AND 9007199254740991),
  pending_pass_high_water INTEGER NOT NULL DEFAULT 0 CHECK (pending_pass_high_water BETWEEN 0 AND 9007199254740991),
  pending_pass_after_sequence INTEGER NOT NULL DEFAULT 0 CHECK (pending_pass_after_sequence BETWEEN 0 AND 9007199254740991),
  backfill_complete INTEGER NOT NULL DEFAULT 0 CHECK (backfill_complete IN (0, 1)),
  CHECK (pending_pass_after_sequence <= pending_pass_high_water AND pending_pass_high_water <= episode_sequence)
) STRICT, WITHOUT ROWID;
INSERT INTO scheduling_state (singleton) VALUES (1);

CREATE TABLE job_admission (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'admitted')),
  attempt_base INTEGER NOT NULL CHECK (attempt_base BETWEEN 0 AND 9007199254740991),
  episode_sequence INTEGER NOT NULL UNIQUE CHECK (episode_sequence BETWEEN 1 AND 9007199254740991),
  requested_at TEXT NOT NULL,
  timestamp_basis TEXT NOT NULL CHECK (timestamp_basis IN ('recorded', 'migration_backfill')),
  admitted_at TEXT,
  bucket_key TEXT NOT NULL,
  github_repository_id INTEGER CHECK (github_repository_id BETWEEN 1 AND 9007199254740991),
  ownership_state TEXT NOT NULL CHECK (ownership_state IN ('resolved', 'invalid_template', 'unverified', 'conflict', 'unscoped')),
  last_checked_at TEXT,
  last_inspection_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_inspection_sequence BETWEEN 0 AND 9007199254740991),
  blockers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(blockers_json) AND json_type(blockers_json) = 'array'
    AND json_array_length(blockers_json) <= 32 AND length(CAST(blockers_json AS BLOB)) <= 8192),
  CHECK ((state = 'pending' AND admitted_at IS NULL) OR (state = 'admitted' AND admitted_at IS NOT NULL)),
  CHECK ((github_repository_id IS NULL AND bucket_key = 'unscoped')
    OR (github_repository_id IS NOT NULL AND bucket_key = 'github:' || CAST(github_repository_id AS TEXT))),
  CHECK (ownership_state != 'resolved' OR github_repository_id IS NOT NULL)
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_job_admission_pending_episode ON job_admission (state, episode_sequence);
CREATE INDEX ix_job_admission_bucket_state ON job_admission (bucket_key, state, episode_sequence);
CREATE INDEX ix_run_attempts_job_status ON run_attempts (job_id, status);

CREATE TRIGGER tr_scheduling_state_no_replace BEFORE INSERT ON scheduling_state
WHEN EXISTS (SELECT 1 FROM scheduling_state WHERE singleton = NEW.singleton)
BEGIN SELECT RAISE(ABORT, 'scheduling state cannot be replaced'); END;
CREATE TRIGGER tr_scheduling_state_no_delete BEFORE DELETE ON scheduling_state
BEGIN SELECT RAISE(ABORT, 'scheduling state cannot be deleted'); END;
CREATE TRIGGER tr_scheduling_state_update BEFORE UPDATE ON scheduling_state
BEGIN
  SELECT CASE WHEN NEW.singleton IS NOT OLD.singleton OR NEW.episode_sequence < OLD.episode_sequence
    OR NEW.inspection_sequence < OLD.inspection_sequence OR NEW.backfill_complete < OLD.backfill_complete
    THEN RAISE(ABORT, 'invalid scheduling sequence transition') END;
  SELECT CASE WHEN OLD.backfill_complete = 0 AND NEW.backfill_complete = 1 AND EXISTS (
    SELECT 1 FROM jobs AS job LEFT JOIN job_admission AS admission ON admission.job_id = job.id
    WHERE admission.job_id IS NULL
  ) THEN RAISE(ABORT, 'job admission backfill is incomplete') END;
END;

CREATE TRIGGER tr_job_admission_insert BEFORE INSERT ON job_admission
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM job_admission WHERE job_id = NEW.job_id)
    THEN RAISE(ABORT, 'job admission cannot be replaced') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM scheduling_state
    WHERE singleton = 1 AND NEW.episode_sequence <= episode_sequence)
    THEN RAISE(ABORT, 'job admission requires an allocated episode') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM jobs AS job, scheduling_state AS scheduling WHERE job.id = NEW.job_id AND scheduling.singleton = 1
      AND ((scheduling.backfill_complete = 0 AND NEW.timestamp_basis = 'migration_backfill'
        AND NEW.state = CASE WHEN job.status IN ('queued', 'retry_waiting') THEN 'admitted' ELSE 'pending' END
        AND NEW.attempt_base = CASE WHEN job.status IN ('leased', 'running', 'cancel_requested') THEN job.attempt_count - 1 ELSE job.attempt_count END)
      OR (scheduling.backfill_complete = 1 AND NEW.timestamp_basis = 'recorded' AND NEW.state = 'pending'
        AND job.status IN ('queued', 'retry_waiting') AND job.current_run_attempt_id IS NULL
        AND NEW.attempt_base = job.attempt_count
        AND NOT EXISTS (SELECT 1 FROM run_attempts WHERE job_id = job.id AND status IN ('leased', 'running'))))
  ) THEN RAISE(ABORT, 'job admission does not match its queue episode') END;
END;
CREATE TRIGGER tr_job_admission_no_delete BEFORE DELETE ON job_admission
BEGIN SELECT RAISE(ABORT, 'job admission history cannot be deleted'); END;
CREATE TRIGGER tr_job_admission_update BEFORE UPDATE ON job_admission
BEGIN
  SELECT CASE WHEN NEW.job_id IS NOT OLD.job_id THEN RAISE(ABORT, 'job admission identity is immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM jobs AS job, scheduling_state AS scheduling WHERE job.id = OLD.job_id AND scheduling.singleton = 1
      AND scheduling.backfill_complete = 1 AND job.status IN ('queued', 'retry_waiting')
      AND job.current_run_attempt_id IS NULL AND NEW.attempt_base = job.attempt_count
      AND NEW.episode_sequence <= scheduling.episode_sequence
      AND NEW.last_inspection_sequence <= scheduling.inspection_sequence
      AND NOT EXISTS (SELECT 1 FROM run_attempts WHERE job_id = job.id AND status IN ('leased', 'running'))
  ) THEN RAISE(ABORT, 'only an unleased waiting job may change admission') END;
  SELECT CASE WHEN (NEW.episode_sequence = OLD.episode_sequence AND (
      NEW.attempt_base IS NOT OLD.attempt_base OR NEW.requested_at IS NOT OLD.requested_at
      OR NEW.timestamp_basis IS NOT OLD.timestamp_basis OR NEW.last_inspection_sequence < OLD.last_inspection_sequence))
    OR (NEW.episode_sequence != OLD.episode_sequence AND (
      NEW.episode_sequence <= OLD.episode_sequence OR NEW.attempt_base != OLD.attempt_base + 1
      OR NEW.state != 'pending' OR NEW.timestamp_basis != 'recorded'))
    THEN RAISE(ABORT, 'invalid job admission episode transition') END;
  SELECT CASE WHEN (NEW.bucket_key IS NOT OLD.bucket_key OR NEW.github_repository_id IS NOT OLD.github_repository_id
      OR NEW.ownership_state IS NOT OLD.ownership_state) AND NOT (
        OLD.ownership_state IN ('unverified', 'unscoped')
        AND NEW.ownership_state IN ('resolved', 'invalid_template', 'conflict')
        AND NEW.episode_sequence = OLD.episode_sequence AND NEW.attempt_base = OLD.attempt_base
        AND NEW.state = OLD.state AND NEW.admitted_at IS OLD.admitted_at)
    THEN RAISE(ABORT, 'job admission ownership is immutable') END;
END;

CREATE TRIGGER tr_job_admission_initial_active BEFORE INSERT ON jobs
WHEN NEW.status IN ('leased', 'running', 'cancel_requested')
BEGIN SELECT RAISE(ABORT, 'a new job must acquire admission before a lease'); END;
CREATE TRIGGER tr_job_admission_lease BEFORE UPDATE OF status ON jobs
WHEN NEW.status IN ('leased', 'running', 'cancel_requested') AND OLD.status NOT IN ('leased', 'running', 'cancel_requested')
BEGIN
  SELECT CASE WHEN OLD.status NOT IN ('queued', 'retry_waiting') OR NEW.status != 'leased'
    OR OLD.current_run_attempt_id IS NOT NULL OR NEW.current_run_attempt_id IS NULL
    OR NEW.attempt_count != OLD.attempt_count + 1
    OR NEW.attempt_count NOT BETWEEN 1 AND 9007199254740991
    OR EXISTS (SELECT 1 FROM run_attempts WHERE job_id = OLD.id AND status IN ('leased', 'running'))
    OR NOT EXISTS (SELECT 1 FROM job_admission AS admission, scheduling_state AS scheduling
      WHERE admission.job_id = OLD.id AND admission.state = 'admitted' AND admission.attempt_base = OLD.attempt_count
        AND admission.ownership_state = 'resolved' AND scheduling.singleton = 1 AND scheduling.backfill_complete = 1)
    THEN RAISE(ABORT, 'a lease requires the matching admitted queue episode') END;
END;
CREATE TRIGGER tr_job_admission_active_attempt BEFORE INSERT ON run_attempts
WHEN NEW.status IN ('leased', 'running')
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM run_attempts WHERE job_id = NEW.job_id AND status IN ('leased', 'running'))
    OR NOT EXISTS (SELECT 1 FROM jobs AS job JOIN job_admission AS admission ON admission.job_id = job.id
      JOIN scheduling_state AS scheduling ON scheduling.singleton = 1 AND scheduling.backfill_complete = 1
      WHERE job.id = NEW.job_id AND job.status IN ('leased', 'running') AND job.current_run_attempt_id = NEW.id
        AND job.attempt_count = NEW.attempt_number AND admission.attempt_base = NEW.attempt_number - 1
        AND admission.state = 'admitted' AND admission.ownership_state = 'resolved')
    THEN RAISE(ABORT, 'an active attempt requires its admitted queue episode') END;
END;
CREATE TRIGGER tr_job_admission_no_attempt_reactivation BEFORE UPDATE OF status ON run_attempts
WHEN NEW.status IN ('leased', 'running') AND OLD.status NOT IN ('leased', 'running')
BEGIN SELECT RAISE(ABORT, 'a terminal attempt cannot be reactivated'); END;

-- M6 already protects scheduled associated review identities. Cover the remaining Legacy
-- ownership inputs without rebuilding Jobs or replacing that existing guard.
CREATE TRIGGER tr_job_admission_legacy_identity BEFORE UPDATE OF work_item_id, execution_json ON jobs
WHEN EXISTS (SELECT 1 FROM job_admission WHERE job_id = OLD.id)
  AND NOT (OLD.work_item_id IS NOT NULL AND OLD.request_epoch_id IS NOT NULL)
  AND (NEW.work_item_id IS NOT OLD.work_item_id OR NEW.execution_json IS NOT OLD.execution_json)
BEGIN SELECT RAISE(ABORT, 'admitted job ownership inputs are immutable'); END;
