-- Files live in a dedicated private directory owned by the single SQLite owner.
CREATE TABLE evidence_storage_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) = 32)
) STRICT;
INSERT INTO evidence_storage_identity VALUES (1, lower(hex(randomblob(16))));
CREATE TRIGGER tr_evidence_storage_identity_insert BEFORE INSERT ON evidence_storage_identity WHEN EXISTS (SELECT 1 FROM evidence_storage_identity) BEGIN SELECT RAISE(ABORT, 'evidence storage identity is immutable'); END;
CREATE TRIGGER tr_evidence_storage_identity_update BEFORE UPDATE ON evidence_storage_identity BEGIN SELECT RAISE(ABORT, 'evidence storage identity is immutable'); END;
CREATE TRIGGER tr_evidence_storage_identity_delete BEFORE DELETE ON evidence_storage_identity BEGIN SELECT RAISE(ABORT, 'evidence storage identity is immutable'); END;

CREATE TABLE evidence_assets (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*'),
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  run_attempt_id TEXT NOT NULL,
  profile_version_id TEXT NOT NULL REFERENCES validation_profile_versions(id) ON DELETE RESTRICT,
  revision_key TEXT NOT NULL CHECK (length(revision_key) = 64),
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64),
  client_asset_id TEXT NOT NULL CHECK (length(client_asset_id) BETWEEN 1 AND 128),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND length(CAST(metadata_json AS BLOB)) <= 2048),
  kind TEXT NOT NULL CHECK (kind IN ('screenshot', 'trace', 'steps', 'log')),
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 67108864),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  check_id TEXT,
  file_device TEXT NOT NULL,
  file_inode TEXT NOT NULL,
  committed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (committed_bytes BETWEEN 0 AND size_bytes),
  state TEXT NOT NULL CHECK (state IN ('uploading', 'finalized', 'retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finalized_at TEXT,
  retired_at TEXT,
  UNIQUE (run_attempt_id, client_asset_id),
  FOREIGN KEY (run_attempt_id, job_id) REFERENCES run_attempts(id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (review_run_id, request_id) REFERENCES review_run_requests(review_run_id, request_id) ON DELETE RESTRICT,
  CHECK ((kind = 'screenshot' AND media_type = 'image/png' AND size_bytes <= 16777216)
    OR (kind = 'trace' AND media_type IN ('application/zip', 'application/json'))
    OR (kind = 'steps' AND media_type = 'application/json')
    OR (kind = 'log' AND media_type = 'text/plain')),
  CHECK (json_extract(metadata_json, '$.kind') IS kind
    AND json_extract(metadata_json, '$.mediaType') IS media_type
    AND json_extract(metadata_json, '$.sizeBytes') IS size_bytes
    AND json_extract(metadata_json, '$.sha256') IS sha256
    AND json_extract(metadata_json, '$.checkId') IS check_id),
  CHECK ((state = 'uploading' AND finalized_at IS NULL AND retired_at IS NULL)
    OR (state = 'finalized' AND finalized_at IS NOT NULL AND retired_at IS NULL AND committed_bytes = size_bytes)
    OR (state = 'retired' AND retired_at IS NOT NULL))
) STRICT;
CREATE INDEX ix_evidence_assets_scope ON evidence_assets(repository_id, review_run_id, job_id, run_attempt_id, created_at, id);
CREATE INDEX ix_evidence_assets_expiry ON evidence_assets(state, updated_at, id);

CREATE TABLE evidence_asset_chunks (
  asset_id TEXT NOT NULL REFERENCES evidence_assets(id) ON DELETE RESTRICT,
  byte_offset INTEGER NOT NULL CHECK (byte_offset BETWEEN 0 AND 67108863),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 524288),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, byte_offset)
) STRICT;
CREATE TABLE evidence_asset_audit (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES evidence_assets(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('begun', 'finalized', 'retired')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER tr_evidence_asset_insert BEFORE INSERT ON evidence_assets
WHEN EXISTS (SELECT 1 FROM evidence_assets WHERE id = NEW.id OR (run_attempt_id = NEW.run_attempt_id AND client_asset_id = NEW.client_asset_id))
  OR NEW.state <> 'uploading' OR NEW.committed_bytes <> 0
  OR NOT EXISTS (
    SELECT 1 FROM run_attempts AS attempt
    JOIN jobs AS job ON job.id = attempt.job_id
    JOIN workers AS worker ON worker.id = attempt.worker_id
    JOIN review_run_job_links AS link ON link.job_id = job.id
    JOIN review_runs AS run ON run.id = link.review_run_id
    JOIN review_run_requests AS request ON request.review_run_id = run.id AND request.request_id = link.request_id
    WHERE attempt.id = NEW.run_attempt_id AND job.id = NEW.job_id
      AND job.current_run_attempt_id = attempt.id AND job.lease_generation = attempt.lease_generation
      AND job.status IN ('leased', 'running') AND attempt.status IN ('leased', 'running')
      AND job.cancellation_requested_at IS NULL AND worker.superseded_at IS NULL
      AND attempt.worker_node_id = worker.node_id AND attempt.worker_instance_id = worker.instance_id
      AND run.id = NEW.review_run_id AND run.repository_id = NEW.repository_id
      AND run.revision_key = NEW.revision_key AND run.plan_digest = NEW.plan_digest
      AND request.request_id = NEW.request_id AND request.profile_version_id = NEW.profile_version_id
      AND json_extract(job.execution_json, '$.validation.runId') IS run.id
      AND json_extract(job.execution_json, '$.validation.repositoryId') IS run.repository_id
      AND json_extract(job.execution_json, '$.validation.requestId') IS request.request_id
      AND json_extract(job.execution_json, '$.validation.jobActivation') IS link.activation_number
      AND json_extract(job.execution_json, '$.validation.profileVersion.id') IS request.profile_version_id
      AND json_extract(job.execution_json, '$.validation.revisionKey') IS run.revision_key
      AND json_extract(job.execution_json, '$.validation.planDigest') IS run.plan_digest
  )
BEGIN SELECT RAISE(ABORT, 'evidence asset dependency mismatch'); END;

CREATE TRIGGER tr_evidence_asset_identity BEFORE UPDATE ON evidence_assets
WHEN NEW.id IS NOT OLD.id OR NEW.repository_id IS NOT OLD.repository_id
  OR NEW.review_run_id IS NOT OLD.review_run_id OR NEW.request_id IS NOT OLD.request_id
  OR NEW.job_id IS NOT OLD.job_id OR NEW.run_attempt_id IS NOT OLD.run_attempt_id
  OR NEW.profile_version_id IS NOT OLD.profile_version_id OR NEW.revision_key IS NOT OLD.revision_key
  OR NEW.plan_digest IS NOT OLD.plan_digest OR NEW.client_asset_id IS NOT OLD.client_asset_id
  OR NEW.metadata_json IS NOT OLD.metadata_json OR NEW.kind IS NOT OLD.kind
  OR NEW.media_type IS NOT OLD.media_type OR NEW.size_bytes IS NOT OLD.size_bytes
  OR NEW.sha256 IS NOT OLD.sha256 OR NEW.check_id IS NOT OLD.check_id
  OR NEW.file_device IS NOT OLD.file_device OR NEW.file_inode IS NOT OLD.file_inode
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.finalized_at IS NOT NULL AND NEW.finalized_at IS NOT OLD.finalized_at)
  OR (OLD.state = 'retired') OR (OLD.state = 'finalized' AND NEW.state <> 'retired')
  OR NEW.committed_bytes < OLD.committed_bytes
  OR NEW.committed_bytes <> COALESCE((SELECT SUM(size_bytes) FROM evidence_asset_chunks WHERE asset_id = OLD.id), 0)
BEGIN SELECT RAISE(ABORT, 'evidence manifest identity is immutable'); END;
CREATE TRIGGER tr_evidence_asset_delete BEFORE DELETE ON evidence_assets BEGIN SELECT RAISE(ABORT, 'evidence manifests are immutable'); END;
CREATE TRIGGER tr_evidence_chunk_insert BEFORE INSERT ON evidence_asset_chunks
WHEN NOT EXISTS (SELECT 1 FROM evidence_assets WHERE id = NEW.asset_id AND state = 'uploading'
  AND committed_bytes = NEW.byte_offset AND NEW.byte_offset + NEW.size_bytes <= size_bytes)
  OR EXISTS (SELECT 1 FROM evidence_asset_chunks WHERE asset_id = NEW.asset_id AND byte_offset = NEW.byte_offset)
  OR (SELECT COUNT(*) FROM evidence_asset_chunks WHERE asset_id = NEW.asset_id) >= 4096
BEGIN SELECT RAISE(ABORT, 'evidence chunks must be consecutive'); END;
CREATE TRIGGER tr_evidence_chunk_update BEFORE UPDATE ON evidence_asset_chunks BEGIN SELECT RAISE(ABORT, 'evidence chunks are immutable'); END;
CREATE TRIGGER tr_evidence_chunk_delete BEFORE DELETE ON evidence_asset_chunks BEGIN SELECT RAISE(ABORT, 'evidence chunks are immutable'); END;
CREATE TRIGGER tr_evidence_audit_update BEFORE UPDATE ON evidence_asset_audit BEGIN SELECT RAISE(ABORT, 'evidence audit is immutable'); END;
CREATE TRIGGER tr_evidence_audit_delete BEFORE DELETE ON evidence_asset_audit BEGIN SELECT RAISE(ABORT, 'evidence audit is immutable'); END;
CREATE TRIGGER tr_evidence_audit_insert BEFORE INSERT ON evidence_asset_audit WHEN EXISTS (SELECT 1 FROM evidence_asset_audit WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT, 'evidence audit is immutable'); END;

CREATE TRIGGER tr_validation_result_evidence_references BEFORE INSERT ON validation_job_results
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.result_json, '$.report.checks') AS checks,
    json_each(checks.value, '$.evidenceIds') AS reference
  WHERE NOT EXISTS (
    SELECT 1 FROM evidence_assets AS asset
    WHERE asset.id = reference.value AND asset.state = 'finalized'
      AND asset.repository_id = NEW.repository_id AND asset.review_run_id = NEW.review_run_id
      AND asset.request_id = NEW.request_id AND asset.job_id = NEW.job_id
      AND asset.run_attempt_id = NEW.run_attempt_id AND asset.profile_version_id = NEW.profile_version_id
      AND asset.revision_key = NEW.resource_revision AND asset.plan_digest = NEW.plan_digest
      AND asset.check_id = json_extract(checks.value, '$.id')
  )
) OR (NEW.target <> 'headless' AND NEW.evidence_complete = 1 AND (
  NOT EXISTS (SELECT 1 FROM json_each(NEW.result_json, '$.report.checks') WHERE json_extract(value, '$.kind') = 'ui')
  OR EXISTS (SELECT 1 FROM json_each(NEW.result_json, '$.report.checks')
    WHERE json_extract(value, '$.kind') = 'ui' AND json_array_length(value, '$.evidenceIds') = 0)
))
BEGIN SELECT RAISE(ABORT, 'validation result evidence reference is unavailable or outside its frozen scope'); END;
