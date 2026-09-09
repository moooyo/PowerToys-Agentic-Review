ALTER TABLE jobs
  ADD COLUMN activation INTEGER NOT NULL DEFAULT 1 CHECK (activation > 0);

CREATE INDEX ix_jobs_activation_lookup
  ON jobs (request_epoch_id, job_kind, resource_revision, activation DESC);

DROP INDEX ux_jobs_epoch_revision;

CREATE UNIQUE INDEX ux_jobs_epoch_revision
  ON jobs (
    request_epoch_id,
    job_kind,
    resource_revision,
    intent_version,
    execution_digest,
    required_capabilities_digest,
    max_attempts,
    priority
  )
  WHERE request_epoch_id IS NOT NULL
    AND execution_digest IS NOT NULL
    AND required_capabilities_digest IS NOT NULL
    AND status NOT IN ('stale', 'cancelled', 'cancel_requested');
