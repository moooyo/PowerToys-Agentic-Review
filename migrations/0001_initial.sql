CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  version TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  max_slots INTEGER NOT NULL CHECK (max_slots > 0),
  capabilities_json TEXT NOT NULL,
  capabilities_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('online', 'draining', 'offline', 'disabled')),
  heartbeat_sequence INTEGER NOT NULL DEFAULT 0 CHECK (heartbeat_sequence >= 0),
  available_slots INTEGER NOT NULL DEFAULT 0 CHECK (available_slots >= 0),
  health_json TEXT,
  superseded_at TEXT,
  registered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (node_id, instance_id)
) STRICT;

CREATE INDEX ix_workers_status_last_seen
  ON workers (status, last_seen_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  work_item_id TEXT,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('issue_triage', 'pull_request_review')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  intent_version INTEGER NOT NULL DEFAULT 1 CHECK (intent_version > 0),
  semantic_key TEXT NOT NULL UNIQUE,
  concurrency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'queued',
      'retry_waiting',
      'leased',
      'running',
      'cancel_requested',
      'stale',
      'succeeded',
      'failed',
      'dead_letter',
      'cancelled'
    )
  ),
  priority INTEGER NOT NULL DEFAULT 0,
  execution_json TEXT NOT NULL,
  required_capabilities_json TEXT NOT NULL DEFAULT '[]',
  resource_revision TEXT NOT NULL,
  execution_affinity_node_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  current_run_attempt_id TEXT,
  current_step TEXT,
  next_attempt_at TEXT NOT NULL,
  cancellation_requested_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_jobs_claim
  ON jobs (status, next_attempt_at, priority DESC, created_at ASC);

CREATE UNIQUE INDEX ux_jobs_active_concurrency
  ON jobs (concurrency_key)
  WHERE status IN ('leased', 'running', 'cancel_requested');

CREATE TABLE run_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT NOT NULL REFERENCES workers (id) ON DELETE RESTRICT,
  worker_node_id TEXT NOT NULL,
  worker_instance_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('leased', 'running', 'succeeded', 'failed', 'cancelled', 'expired')
  ),
  lease_token_hash TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  lease_expires_at TEXT NOT NULL,
  execution_deadline_at TEXT NOT NULL,
  no_progress_timeout_ms INTEGER NOT NULL CHECK (no_progress_timeout_ms > 0),
  no_progress_deadline_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  phase TEXT NOT NULL,
  progress_sequence INTEGER NOT NULL DEFAULT 0 CHECK (progress_sequence >= 0),
  progress_json TEXT,
  result_digest TEXT,
  result_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  failure_code TEXT,
  failure_message TEXT,
  UNIQUE (job_id, attempt_number)
) STRICT;

CREATE INDEX ix_run_attempts_expiry
  ON run_attempts (status, lease_expires_at);

CREATE INDEX ix_run_attempts_execution_deadline
  ON run_attempts (status, execution_deadline_at);

CREATE INDEX ix_run_attempts_no_progress_deadline
  ON run_attempts (status, no_progress_deadline_at);

CREATE INDEX ix_run_attempts_worker
  ON run_attempts (worker_id, worker_instance_id, status);
