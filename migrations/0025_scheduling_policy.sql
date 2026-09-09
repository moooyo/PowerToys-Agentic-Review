-- Operational limits start unlimited once. Existing frozen execution and audit bytes are retained.
ALTER TABLE managed_repositories ADD COLUMN max_active_leases INTEGER
  CHECK (max_active_leases BETWEEN 1 AND 65535);
ALTER TABLE managed_repositories ADD COLUMN max_queued_jobs INTEGER
  CHECK (max_queued_jobs BETWEEN 1 AND 1000000);

ALTER TABLE scheduling_state ADD COLUMN successful_admission_sequence INTEGER NOT NULL DEFAULT 0
  CHECK (successful_admission_sequence BETWEEN 0 AND 9007199254740991);
ALTER TABLE scheduling_state ADD COLUMN successful_claim_sequence INTEGER NOT NULL DEFAULT 0
  CHECK (successful_claim_sequence BETWEEN 0 AND 9007199254740991);
ALTER TABLE scheduling_state ADD COLUMN recheck_sequence INTEGER NOT NULL DEFAULT 0
  CHECK (recheck_sequence BETWEEN 0 AND 9007199254740991);
ALTER TABLE scheduling_state ADD COLUMN recovery_pass_high_water INTEGER NOT NULL DEFAULT 0
  CHECK (recovery_pass_high_water BETWEEN 0 AND 9007199254740991);
ALTER TABLE scheduling_state ADD COLUMN recovery_pass_after_sequence INTEGER NOT NULL DEFAULT 0
  CHECK (recovery_pass_after_sequence BETWEEN 0 AND 9007199254740991);
CREATE TRIGGER tr_scheduling_service_sequences BEFORE UPDATE ON scheduling_state
BEGIN
  SELECT CASE WHEN NEW.successful_admission_sequence < OLD.successful_admission_sequence
    OR NEW.successful_claim_sequence < OLD.successful_claim_sequence
    OR NEW.recheck_sequence < OLD.recheck_sequence
    OR NEW.recovery_pass_after_sequence > NEW.recovery_pass_high_water
    OR NEW.recovery_pass_high_water > NEW.episode_sequence
    THEN RAISE(ABORT, 'invalid scheduling service sequence transition') END;
END;

CREATE TABLE repository_scheduling_state (
  bucket_key TEXT PRIMARY KEY CHECK (bucket_key = 'unscoped' OR
    (bucket_key GLOB 'github:[1-9]*' AND substr(bucket_key, 8) NOT GLOB '*[^0-9]*'
      AND CAST(substr(bucket_key, 8) AS INTEGER) BETWEEN 1 AND 9007199254740991
      AND bucket_key = 'github:' || CAST(CAST(substr(bucket_key, 8) AS INTEGER) AS TEXT))),
  last_admission_ticket INTEGER NOT NULL CHECK (last_admission_ticket BETWEEN 0 AND 9007199254740991),
  last_claim_ticket INTEGER NOT NULL CHECK (last_claim_ticket BETWEEN 0 AND 9007199254740991),
  admission_pr_streak INTEGER NOT NULL DEFAULT 0 CHECK (admission_pr_streak BETWEEN 0 AND 2),
  claim_pr_streak INTEGER NOT NULL DEFAULT 0 CHECK (claim_pr_streak BETWEEN 0 AND 2),
  recheck_generation INTEGER NOT NULL DEFAULT 0 CHECK (recheck_generation BETWEEN 0 AND 9007199254740991)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_repository_scheduling_admission
  ON repository_scheduling_state (last_admission_ticket, bucket_key);
CREATE INDEX ix_repository_scheduling_claim
  ON repository_scheduling_state (last_claim_ticket, bucket_key);
INSERT INTO repository_scheduling_state (bucket_key, last_admission_ticket, last_claim_ticket)
SELECT DISTINCT bucket_key, 0, 0 FROM job_admission;
CREATE TRIGGER tr_repository_scheduling_no_replace BEFORE INSERT ON repository_scheduling_state
WHEN EXISTS (SELECT 1 FROM repository_scheduling_state WHERE bucket_key = NEW.bucket_key)
BEGIN SELECT RAISE(ABORT, 'repository scheduling history cannot be replaced'); END;
CREATE TRIGGER tr_repository_scheduling_no_delete BEFORE DELETE ON repository_scheduling_state
BEGIN SELECT RAISE(ABORT, 'repository scheduling history cannot be deleted'); END;
CREATE TRIGGER tr_repository_scheduling_insert BEFORE INSERT ON repository_scheduling_state
WHEN NOT EXISTS (SELECT 1 FROM scheduling_state WHERE singleton = 1
  AND NEW.last_admission_ticket = successful_admission_sequence
  AND NEW.last_claim_ticket = successful_claim_sequence
  AND NEW.admission_pr_streak = 0 AND NEW.claim_pr_streak = 0 AND NEW.recheck_generation = 0)
BEGIN SELECT RAISE(ABORT, 'new repository scheduling history requires current service tickets'); END;
CREATE TRIGGER tr_repository_scheduling_update BEFORE UPDATE ON repository_scheduling_state
BEGIN
  SELECT CASE WHEN NEW.bucket_key IS NOT OLD.bucket_key
    OR NEW.last_admission_ticket < OLD.last_admission_ticket
    OR NEW.last_claim_ticket < OLD.last_claim_ticket OR NEW.recheck_generation < OLD.recheck_generation
    OR (NEW.admission_pr_streak != OLD.admission_pr_streak AND NEW.last_admission_ticket = OLD.last_admission_ticket)
    OR (NEW.claim_pr_streak != OLD.claim_pr_streak AND NEW.last_claim_ticket = OLD.last_claim_ticket)
    OR NOT EXISTS (SELECT 1 FROM scheduling_state WHERE singleton = 1
      AND NEW.last_admission_ticket <= successful_admission_sequence
      AND NEW.last_claim_ticket <= successful_claim_sequence
      AND (NEW.last_admission_ticket = OLD.last_admission_ticket OR NEW.last_admission_ticket = successful_admission_sequence)
      AND (NEW.last_claim_ticket = OLD.last_claim_ticket OR NEW.last_claim_ticket = successful_claim_sequence))
    THEN RAISE(ABORT, 'invalid repository scheduling service transition') END;
END;

CREATE TABLE platform_scheduling_configuration (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  max_active_leases INTEGER CHECK (max_active_leases BETWEEN 1 AND 65535),
  max_queued_jobs INTEGER CHECK (max_queued_jobs BETWEEN 1 AND 1000000),
  policy_id TEXT NOT NULL CHECK (policy_id = 'repository-service-v1'),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at)
) STRICT, WITHOUT ROWID;
INSERT INTO platform_scheduling_configuration
  (singleton, version, max_active_leases, max_queued_jobs, policy_id, updated_at)
VALUES (1, 1, NULL, NULL, 'repository-service-v1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE TABLE platform_scheduling_configuration_audit (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128 AND instr(id, char(0)) = 0),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  previous_version INTEGER NOT NULL CHECK (previous_version BETWEEN 1 AND 9007199254740990),
  version INTEGER NOT NULL UNIQUE CHECK (version BETWEEN 2 AND 9007199254740991 AND version = previous_version + 1),
  previous_snapshot_json TEXT NOT NULL CHECK (json_valid(previous_snapshot_json)
    AND json_type(previous_snapshot_json) = 'object'
    AND length(CAST(previous_snapshot_json AS BLOB)) <= 16384),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)
    AND json_type(snapshot_json) = 'object' AND length(CAST(snapshot_json AS BLOB)) <= 16384),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_platform_scheduling_configuration_audit_created
  ON platform_scheduling_configuration_audit (created_at DESC, id DESC);
CREATE TRIGGER tr_platform_scheduling_configuration_no_replace BEFORE INSERT ON platform_scheduling_configuration
WHEN EXISTS (SELECT 1 FROM platform_scheduling_configuration WHERE singleton = NEW.singleton)
BEGIN SELECT RAISE(ABORT, 'platform scheduling configuration cannot be replaced'); END;
CREATE TRIGGER tr_platform_scheduling_configuration_no_delete BEFORE DELETE ON platform_scheduling_configuration
BEGIN SELECT RAISE(ABORT, 'platform scheduling configuration cannot be deleted'); END;
CREATE TRIGGER tr_platform_scheduling_audit_no_update BEFORE UPDATE ON platform_scheduling_configuration_audit
BEGIN SELECT RAISE(ABORT, 'platform scheduling audit is immutable'); END;
CREATE TRIGGER tr_platform_scheduling_audit_no_delete BEFORE DELETE ON platform_scheduling_configuration_audit
BEGIN SELECT RAISE(ABORT, 'platform scheduling audit is immutable'); END;
CREATE TRIGGER tr_platform_scheduling_audit_insert BEFORE INSERT ON platform_scheduling_configuration_audit
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM platform_scheduling_configuration_audit
      WHERE id = NEW.id OR version = NEW.version)
    THEN RAISE(ABORT, 'platform scheduling audit cannot be replaced') END;
  -- Fixed snapshots reject extra fields, duplicate keys, missing fields, and invalid scalar types.
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM (SELECT NEW.previous_snapshot_json AS snapshot UNION ALL SELECT NEW.snapshot_json) AS snapshots
    WHERE (SELECT COUNT(*) FROM json_each(snapshot)) != 4
      OR (SELECT COUNT(DISTINCT key) FROM json_each(snapshot)) != 4
      OR EXISTS (SELECT 1 FROM json_each(snapshot) WHERE key NOT IN ('version', 'limits', 'policyId', 'updatedAt'))
      OR json_type(snapshot, '$.version') IS NOT 'integer'
      OR json_extract(snapshot, '$.version') NOT BETWEEN 1 AND 9007199254740991
      OR json_type(snapshot, '$.limits') IS NOT 'object'
      OR (SELECT COUNT(*) FROM json_each(snapshot, '$.limits')) != 2
      OR (SELECT COUNT(DISTINCT key) FROM json_each(snapshot, '$.limits')) != 2
      OR EXISTS (SELECT 1 FROM json_each(snapshot, '$.limits') WHERE key NOT IN ('maxActiveLeases', 'maxQueuedJobs'))
      OR json_type(snapshot, '$.limits.maxActiveLeases') NOT IN ('null', 'integer')
      OR (json_type(snapshot, '$.limits.maxActiveLeases') = 'integer'
        AND json_extract(snapshot, '$.limits.maxActiveLeases') NOT BETWEEN 1 AND 65535)
      OR json_type(snapshot, '$.limits.maxQueuedJobs') NOT IN ('null', 'integer')
      OR (json_type(snapshot, '$.limits.maxQueuedJobs') = 'integer'
        AND json_extract(snapshot, '$.limits.maxQueuedJobs') NOT BETWEEN 1 AND 1000000)
      OR json_type(snapshot, '$.policyId') IS NOT 'text'
      OR json_extract(snapshot, '$.policyId') IS NOT 'repository-service-v1'
      OR json_type(snapshot, '$.updatedAt') IS NOT 'text'
      OR length(json_extract(snapshot, '$.updatedAt')) != 24
      OR strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(snapshot, '$.updatedAt'))
        IS NOT json_extract(snapshot, '$.updatedAt')
  ) THEN RAISE(ABORT, 'platform scheduling audit snapshot is invalid') END;
  SELECT CASE WHEN json_extract(NEW.previous_snapshot_json, '$.version') IS NOT NEW.previous_version
      OR json_extract(NEW.snapshot_json, '$.version') IS NOT NEW.version
      OR json_extract(NEW.snapshot_json, '$.updatedAt') IS NOT NEW.created_at
      OR NOT EXISTS (SELECT 1 FROM platform_scheduling_configuration WHERE singleton = 1
        AND version = NEW.previous_version AND updated_at <= NEW.created_at
        AND json_extract(NEW.previous_snapshot_json, '$.limits.maxActiveLeases') IS max_active_leases
        AND json_extract(NEW.previous_snapshot_json, '$.limits.maxQueuedJobs') IS max_queued_jobs
        AND json_extract(NEW.previous_snapshot_json, '$.policyId') IS policy_id
        AND json_extract(NEW.previous_snapshot_json, '$.updatedAt') IS updated_at)
    THEN RAISE(ABORT, 'platform scheduling audit does not follow the current configuration') END;
END;
CREATE TRIGGER tr_platform_scheduling_configuration_update BEFORE UPDATE ON platform_scheduling_configuration
WHEN NEW.singleton IS NOT OLD.singleton OR NEW.version != OLD.version + 1
  OR NOT EXISTS (SELECT 1 FROM platform_scheduling_configuration_audit AS audit
    WHERE audit.previous_version = OLD.version AND audit.version = NEW.version
      AND audit.created_at IS NEW.updated_at
      AND json_extract(audit.previous_snapshot_json, '$.limits.maxActiveLeases') IS OLD.max_active_leases
      AND json_extract(audit.previous_snapshot_json, '$.limits.maxQueuedJobs') IS OLD.max_queued_jobs
      AND json_extract(audit.previous_snapshot_json, '$.updatedAt') IS OLD.updated_at
      AND json_extract(audit.snapshot_json, '$.limits.maxActiveLeases') IS NEW.max_active_leases
      AND json_extract(audit.snapshot_json, '$.limits.maxQueuedJobs') IS NEW.max_queued_jobs
      AND json_extract(audit.snapshot_json, '$.policyId') IS NEW.policy_id)
BEGIN SELECT RAISE(ABORT, 'platform scheduling configuration requires its next immutable audit'); END;
CREATE TRIGGER tr_platform_scheduling_audit_apply AFTER INSERT ON platform_scheduling_configuration_audit
BEGIN
  UPDATE platform_scheduling_configuration SET version = NEW.version,
    max_active_leases = json_extract(NEW.snapshot_json, '$.limits.maxActiveLeases'),
    max_queued_jobs = json_extract(NEW.snapshot_json, '$.limits.maxQueuedJobs'),
    policy_id = json_extract(NEW.snapshot_json, '$.policyId'), updated_at = NEW.created_at
    WHERE singleton = 1 AND version = NEW.previous_version;
END;

-- Stable operational ordering is derived from existing scalar Job fields. It is not evidence.
ALTER TABLE job_admission ADD COLUMN work_class TEXT NOT NULL DEFAULT 'pull_request'
  CHECK (work_class IN ('pull_request', 'issue'));
ALTER TABLE job_admission ADD COLUMN claim_rank_at_ms INTEGER NOT NULL DEFAULT 0
  CHECK (claim_rank_at_ms BETWEEN -9007199254740991 AND 9007199254740991);
-- The migration transaction alone may populate ordering on active and terminal historical rows.
DROP TRIGGER tr_job_admission_update;
UPDATE job_admission SET
  work_class = CASE WHEN (SELECT job_kind FROM jobs WHERE id = job_id) = 'issue_triage' THEN 'issue' ELSE 'pull_request' END,
  claim_rank_at_ms = (SELECT
    CAST(strftime('%s', MAX(job_admission.requested_at, job.next_attempt_at)) AS INTEGER) * 1000
      + CAST(substr(MAX(job_admission.requested_at, job.next_attempt_at), 21, 3) AS INTEGER)
      - MIN(100, MAX(0, job.priority)) * 6000 FROM jobs AS job WHERE job.id = job_admission.job_id);

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

CREATE INDEX ix_job_admission_pending_service
  ON job_admission (state, bucket_key, work_class, episode_sequence, job_id);
CREATE INDEX ix_job_admission_claim_service
  ON job_admission (state, bucket_key, work_class, claim_rank_at_ms, episode_sequence, job_id);
CREATE INDEX ix_run_attempts_active_accounting
  ON run_attempts (status, job_id) WHERE status IN ('leased', 'running');
CREATE INDEX ix_validation_dispatch_pending_accounting
  ON validation_dispatch_checks (pending, repository_id, review_run_id, request_id);

CREATE TRIGGER tr_job_admission_order_insert AFTER INSERT ON job_admission
BEGIN
  INSERT INTO repository_scheduling_state (bucket_key, last_admission_ticket, last_claim_ticket)
    SELECT NEW.bucket_key, successful_admission_sequence, successful_claim_sequence
    FROM scheduling_state WHERE singleton = 1 AND NOT EXISTS (
      SELECT 1 FROM repository_scheduling_state WHERE bucket_key = NEW.bucket_key);
  UPDATE job_admission SET
    work_class = CASE WHEN (SELECT job_kind FROM jobs WHERE id = NEW.job_id) = 'issue_triage'
      THEN 'issue' ELSE 'pull_request' END,
    claim_rank_at_ms = (SELECT
      CAST(strftime('%s', MAX(NEW.requested_at, job.next_attempt_at)) AS INTEGER) * 1000
        + CAST(substr(MAX(NEW.requested_at, job.next_attempt_at), 21, 3) AS INTEGER)
        - MIN(100, MAX(0, job.priority)) * 6000 FROM jobs AS job WHERE job.id = NEW.job_id)
    WHERE job_id = NEW.job_id;
END;
CREATE TRIGGER tr_job_admission_order_retry AFTER UPDATE OF episode_sequence ON job_admission
WHEN NEW.episode_sequence != OLD.episode_sequence
BEGIN
  UPDATE job_admission SET
    work_class = CASE WHEN (SELECT job_kind FROM jobs WHERE id = NEW.job_id) = 'issue_triage'
      THEN 'issue' ELSE 'pull_request' END,
    claim_rank_at_ms = (SELECT
      CAST(strftime('%s', MAX(NEW.requested_at, job.next_attempt_at)) AS INTEGER) * 1000
        + CAST(substr(MAX(NEW.requested_at, job.next_attempt_at), 21, 3) AS INTEGER)
        - MIN(100, MAX(0, job.priority)) * 6000 FROM jobs AS job WHERE job.id = NEW.job_id)
    WHERE job_id = NEW.job_id;
END;
CREATE TRIGGER tr_job_admission_order_update BEFORE UPDATE OF work_class, claim_rank_at_ms ON job_admission
WHEN NOT EXISTS (SELECT 1 FROM jobs AS job WHERE job.id = NEW.job_id
  AND NEW.work_class = CASE WHEN job.job_kind = 'issue_triage' THEN 'issue' ELSE 'pull_request' END
  AND NEW.claim_rank_at_ms = CAST(strftime('%s', MAX(NEW.requested_at, job.next_attempt_at)) AS INTEGER) * 1000
    + CAST(substr(MAX(NEW.requested_at, job.next_attempt_at), 21, 3) AS INTEGER)
    - MIN(100, MAX(0, job.priority)) * 6000)
BEGIN SELECT RAISE(ABORT, 'job admission ordering must match its queue episode'); END;


-- One table owns finite scans and compact affected-key notifications. Producer rows use the
-- sentinel identity; consumer rows retain the exact registered Worker identity and capability set.
CREATE TABLE claim_scan_state (
  worker_id TEXT NOT NULL,
  worker_instance_id TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  capabilities_digest TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('coordinator', 'bucket', 'concurrency', 'affinity', 'backoff')),
  scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 4096),
  work_class TEXT NOT NULL CHECK (work_class IN ('all', 'pull_request', 'issue')),
  scan_kind TEXT NOT NULL CHECK (scan_kind IN ('coordinator', 'primary', 'recheck', 'event')),
  pass_generation INTEGER NOT NULL DEFAULT 0 CHECK (pass_generation BETWEEN 0 AND 9007199254740991),
  high_water_sequence INTEGER NOT NULL DEFAULT 0 CHECK (high_water_sequence BETWEEN 0 AND 9007199254740991),
  after_rank_at_ms INTEGER CHECK (after_rank_at_ms BETWEEN -9007199254740991 AND 9007199254740991),
  after_episode_sequence INTEGER NOT NULL DEFAULT 0 CHECK (after_episode_sequence BETWEEN 0 AND 9007199254740991),
  after_job_id TEXT NOT NULL DEFAULT '',
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  dirty_generation INTEGER NOT NULL DEFAULT 0 CHECK (dirty_generation BETWEEN 0 AND 9007199254740991),
  recheck_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (worker_id, worker_instance_id, protocol_version, capabilities_digest,
    scope_kind, scope_key, work_class, scan_kind),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', recheck_at) IS recheck_at),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CHECK (after_episode_sequence <= high_water_sequence),
  CHECK ((scan_kind = 'event' AND worker_id = '*' AND worker_instance_id = '*'
    AND protocol_version = '*' AND capabilities_digest = '*' AND work_class = 'all')
    OR (scan_kind != 'event' AND worker_id != '*'))
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_claim_scan_events ON claim_scan_state (scan_kind, dirty_generation, scope_kind, scope_key);
CREATE INDEX ix_claim_scan_consumers ON claim_scan_state
  (worker_id, worker_instance_id, protocol_version, capabilities_digest, scan_kind, completed, updated_at);
CREATE INDEX ix_jobs_concurrency_recheck ON jobs (concurrency_key, status, id);
CREATE INDEX ix_jobs_affinity_recheck ON jobs (execution_affinity_node_id, status, id);
CREATE INDEX ix_jobs_backoff_recheck ON jobs (next_attempt_at, status, id);
CREATE INDEX ix_job_admission_recheck_order ON job_admission
  (state, work_class, claim_rank_at_ms, episode_sequence, job_id);
CREATE TRIGGER tr_claim_scan_insert BEFORE INSERT ON claim_scan_state
WHEN NEW.high_water_sequence > (SELECT episode_sequence FROM scheduling_state WHERE singleton = 1)
  OR NEW.dirty_generation > (SELECT recheck_sequence FROM scheduling_state WHERE singleton = 1)
BEGIN SELECT RAISE(ABORT, 'claim scan exceeds its captured scheduling state'); END;
CREATE TRIGGER tr_claim_scan_update BEFORE UPDATE ON claim_scan_state
WHEN NEW.high_water_sequence > (SELECT episode_sequence FROM scheduling_state WHERE singleton = 1)
  OR NEW.dirty_generation > (SELECT recheck_sequence FROM scheduling_state WHERE singleton = 1)
BEGIN SELECT RAISE(ABORT, 'claim scan exceeds its captured scheduling state'); END;

CREATE TRIGGER tr_scheduling_admission_recheck AFTER INSERT ON job_admission
BEGIN
  UPDATE scheduling_state SET recheck_sequence = recheck_sequence + 1 WHERE singleton = 1;
  INSERT INTO claim_scan_state (worker_id, worker_instance_id, protocol_version,
    capabilities_digest, scope_kind, scope_key, work_class, scan_kind, dirty_generation, updated_at)
  SELECT '*', '*', '*', '*', 'bucket', NEW.bucket_key, 'all', 'event', recheck_sequence,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM scheduling_state WHERE singleton = 1
  ON CONFLICT (worker_id, worker_instance_id, protocol_version, capabilities_digest,
    scope_kind, scope_key, work_class, scan_kind) DO UPDATE SET
    dirty_generation = excluded.dirty_generation, updated_at = excluded.updated_at;
END;

CREATE TRIGGER tr_scheduling_admission_change_recheck AFTER UPDATE OF state, episode_sequence, bucket_key ON job_admission
WHEN NEW.state IS NOT OLD.state OR NEW.episode_sequence != OLD.episode_sequence OR NEW.bucket_key IS NOT OLD.bucket_key
BEGIN
  UPDATE scheduling_state SET recheck_sequence = recheck_sequence + 1 WHERE singleton = 1;
  INSERT INTO claim_scan_state (worker_id, worker_instance_id, protocol_version,
    capabilities_digest, scope_kind, scope_key, work_class, scan_kind, dirty_generation, updated_at)
  SELECT '*', '*', '*', '*', 'bucket', NEW.bucket_key, 'all', 'event', recheck_sequence,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM scheduling_state WHERE singleton = 1
  ON CONFLICT (worker_id, worker_instance_id, protocol_version, capabilities_digest,
    scope_kind, scope_key, work_class, scan_kind) DO UPDATE SET
    dirty_generation = excluded.dirty_generation, updated_at = excluded.updated_at;
END;

CREATE TRIGGER tr_scheduling_attempt_release_recheck AFTER UPDATE OF status ON run_attempts
WHEN OLD.status IN ('leased', 'running') AND NEW.status NOT IN ('leased', 'running')
BEGIN
  UPDATE scheduling_state SET recheck_sequence = recheck_sequence + 1 WHERE singleton = 1;
  INSERT INTO claim_scan_state (worker_id, worker_instance_id, protocol_version,
    capabilities_digest, scope_kind, scope_key, work_class, scan_kind, dirty_generation, updated_at)
  SELECT '*', '*', '*', '*', 'concurrency', (SELECT concurrency_key FROM jobs WHERE id = NEW.job_id), 'all', 'event', recheck_sequence,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM scheduling_state WHERE singleton = 1
  ON CONFLICT (worker_id, worker_instance_id, protocol_version, capabilities_digest,
    scope_kind, scope_key, work_class, scan_kind) DO UPDATE SET
    dirty_generation = excluded.dirty_generation, updated_at = excluded.updated_at;
  INSERT INTO claim_scan_state (worker_id, worker_instance_id, protocol_version,
    capabilities_digest, scope_kind, scope_key, work_class, scan_kind, dirty_generation, updated_at)
  SELECT '*', '*', '*', '*', 'bucket', (SELECT bucket_key FROM job_admission WHERE job_id = NEW.job_id), 'all', 'event', recheck_sequence,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM scheduling_state WHERE singleton = 1
  ON CONFLICT (worker_id, worker_instance_id, protocol_version, capabilities_digest,
    scope_kind, scope_key, work_class, scan_kind) DO UPDATE SET
    dirty_generation = excluded.dirty_generation, updated_at = excluded.updated_at;
END;

CREATE TRIGGER tr_scheduling_job_constraint_recheck AFTER UPDATE OF concurrency_key, execution_affinity_node_id, next_attempt_at ON jobs
WHEN NEW.concurrency_key IS NOT OLD.concurrency_key OR NEW.execution_affinity_node_id IS NOT OLD.execution_affinity_node_id OR NEW.next_attempt_at IS NOT OLD.next_attempt_at
BEGIN
  UPDATE scheduling_state SET recheck_sequence = recheck_sequence + 1 WHERE singleton = 1;
  INSERT INTO claim_scan_state (worker_id, worker_instance_id, protocol_version,
    capabilities_digest, scope_kind, scope_key, work_class, scan_kind, dirty_generation, updated_at)
  SELECT '*', '*', '*', '*', 'concurrency', OLD.concurrency_key, 'all', 'event', recheck_sequence,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM scheduling_state WHERE singleton = 1
  ON CONFLICT (worker_id, worker_instance_id, protocol_version, capabilities_digest,
    scope_kind, scope_key, work_class, scan_kind) DO UPDATE SET
    dirty_generation = excluded.dirty_generation, updated_at = excluded.updated_at;
  INSERT INTO claim_scan_state (worker_id, worker_instance_id, protocol_version,
    capabilities_digest, scope_kind, scope_key, work_class, scan_kind, dirty_generation, updated_at)
  SELECT '*', '*', '*', '*', 'concurrency', NEW.concurrency_key, 'all', 'event', recheck_sequence,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM scheduling_state WHERE singleton = 1
  ON CONFLICT (worker_id, worker_instance_id, protocol_version, capabilities_digest,
    scope_kind, scope_key, work_class, scan_kind) DO UPDATE SET
    dirty_generation = excluded.dirty_generation, updated_at = excluded.updated_at;
END;

CREATE TRIGGER tr_scheduling_repository_policy_recheck AFTER UPDATE OF enabled, max_active_leases, max_queued_jobs ON managed_repositories
WHEN NEW.enabled IS NOT OLD.enabled OR NEW.max_active_leases IS NOT OLD.max_active_leases OR NEW.max_queued_jobs IS NOT OLD.max_queued_jobs
BEGIN
  UPDATE scheduling_state SET recheck_sequence = recheck_sequence + 1 WHERE singleton = 1;
  INSERT INTO claim_scan_state (worker_id, worker_instance_id, protocol_version,
    capabilities_digest, scope_kind, scope_key, work_class, scan_kind, dirty_generation, updated_at)
  SELECT '*', '*', '*', '*', 'bucket', 'github:' || CAST(NEW.github_repository_id AS TEXT), 'all', 'event', recheck_sequence,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM scheduling_state WHERE singleton = 1
  ON CONFLICT (worker_id, worker_instance_id, protocol_version, capabilities_digest,
    scope_kind, scope_key, work_class, scan_kind) DO UPDATE SET
    dirty_generation = excluded.dirty_generation, updated_at = excluded.updated_at;
END;

CREATE TRIGGER tr_scheduling_worker_affinity_recheck AFTER UPDATE OF status, instance_id, capabilities_digest ON workers
WHEN NEW.status IS NOT OLD.status OR NEW.instance_id IS NOT OLD.instance_id OR NEW.capabilities_digest IS NOT OLD.capabilities_digest
BEGIN
  UPDATE scheduling_state SET recheck_sequence = recheck_sequence + 1 WHERE singleton = 1;
  INSERT INTO claim_scan_state (worker_id, worker_instance_id, protocol_version,
    capabilities_digest, scope_kind, scope_key, work_class, scan_kind, dirty_generation, updated_at)
  SELECT '*', '*', '*', '*', 'affinity', NEW.node_id, 'all', 'event', recheck_sequence,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM scheduling_state WHERE singleton = 1
  ON CONFLICT (worker_id, worker_instance_id, protocol_version, capabilities_digest,
    scope_kind, scope_key, work_class, scan_kind) DO UPDATE SET
    dirty_generation = excluded.dirty_generation, updated_at = excluded.updated_at;
END;


CREATE TRIGGER tr_job_admission_owner_service AFTER UPDATE OF bucket_key ON job_admission
WHEN NEW.bucket_key IS NOT OLD.bucket_key
BEGIN
  INSERT INTO repository_scheduling_state (bucket_key, last_admission_ticket, last_claim_ticket)
    SELECT NEW.bucket_key, successful_admission_sequence, successful_claim_sequence
    FROM scheduling_state WHERE singleton = 1 AND NOT EXISTS (
      SELECT 1 FROM repository_scheduling_state WHERE bucket_key = NEW.bucket_key);
END;
