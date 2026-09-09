CREATE TABLE validation_control_audit (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE RESTRICT,
  request_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('dispatch', 'rerun', 'cancel')),
  activation_id TEXT,
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json) AND json_type(result_json) = 'object'
    AND length(CAST(result_json AS BLOB)) BETWEEN 2 AND 1048576
  ),
  created_at TEXT NOT NULL,
  FOREIGN KEY (review_run_id, request_id) REFERENCES review_run_requests(review_run_id, request_id) ON DELETE RESTRICT,
  CHECK (
    (action = 'dispatch' AND request_id IS NULL AND activation_id IS NULL)
    OR (action = 'rerun' AND request_id IS NOT NULL AND activation_id IS NOT NULL AND length(activation_id) BETWEEN 1 AND 128)
    OR (action = 'cancel' AND request_id IS NOT NULL AND activation_id IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX ux_validation_control_rerun_intent
  ON validation_control_audit (review_run_id, request_id, activation_id) WHERE action = 'rerun';
CREATE INDEX ix_validation_control_history
  ON validation_control_audit (review_run_id, created_at DESC, id DESC);

CREATE TRIGGER tr_validation_control_audit_consistency BEFORE INSERT ON validation_control_audit
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM review_runs WHERE id = NEW.review_run_id AND repository_id = NEW.repository_id
  ) THEN RAISE(ABORT, 'validation operation repository/run mismatch') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM validation_control_audit WHERE id = NEW.id)
    OR (NEW.action = 'rerun' AND EXISTS (
      SELECT 1 FROM validation_control_audit WHERE action = 'rerun'
        AND review_run_id = NEW.review_run_id AND request_id = NEW.request_id
        AND activation_id = NEW.activation_id
    )) THEN RAISE(ABORT, 'validation operation receipts cannot be replaced') END;
  SELECT CASE WHEN NEW.action IN ('rerun', 'cancel') AND NOT EXISTS (
    SELECT 1 FROM review_run_job_links
    WHERE review_run_id = NEW.review_run_id AND request_id = NEW.request_id
      AND job_id = json_extract(NEW.result_json, '$.jobId')
      AND (NEW.action != 'rerun' OR activation_number = json_extract(NEW.result_json, '$.jobActivation'))
  ) THEN RAISE(ABORT, 'validation operation result/job mismatch') END;
END;
CREATE TRIGGER tr_validation_control_audit_immutable_update BEFORE UPDATE ON validation_control_audit
BEGIN SELECT RAISE(ABORT, 'validation operation receipts are immutable'); END;
CREATE TRIGGER tr_validation_control_audit_immutable_delete BEFORE DELETE ON validation_control_audit
BEGIN SELECT RAISE(ABORT, 'validation operation receipts are immutable'); END;

CREATE TABLE validation_dispatch_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 0 AND 9007199254740991),
  last_repository_id TEXT REFERENCES managed_repositories(id) ON DELETE RESTRICT
) STRICT;
INSERT INTO validation_dispatch_state (singleton, sequence, last_repository_id)
  VALUES (1, 0, NULL);

CREATE TABLE validation_dispatch_checks (
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  review_run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  pending INTEGER NOT NULL CHECK (pending IN (0, 1)),
  last_sequence INTEGER NOT NULL CHECK (last_sequence BETWEEN 0 AND 9007199254740991),
  checked_at TEXT,
  blockers_json TEXT NOT NULL CHECK (
    json_valid(blockers_json) AND json_type(blockers_json) = 'array'
    AND length(CAST(blockers_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  PRIMARY KEY (review_run_id, request_id),
  FOREIGN KEY (review_run_id, request_id) REFERENCES review_run_requests(review_run_id, request_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ix_validation_dispatch_pending
  ON validation_dispatch_checks (repository_id, pending, last_sequence, review_run_id, request_id);
CREATE INDEX ix_managed_repositories_dispatch_enabled ON managed_repositories (enabled, id);
CREATE TRIGGER tr_validation_dispatch_check_scope BEFORE INSERT ON validation_dispatch_checks
WHEN NOT EXISTS (SELECT 1 FROM review_runs WHERE id = NEW.review_run_id AND repository_id = NEW.repository_id)
BEGIN SELECT RAISE(ABORT, 'dispatch check repository/run mismatch'); END;

-- Materialize only pending requests. New plans and associations update this queue in
-- their existing transactions, so runtime scans never rank the complete run history.
INSERT INTO validation_dispatch_checks (repository_id, review_run_id, request_id, pending, last_sequence, checked_at, blockers_json)
SELECT run.repository_id, run.id, request.request_id, 1, 0, NULL, '[]'
FROM review_runs AS run JOIN review_run_requests AS request ON request.review_run_id = run.id
WHERE NOT EXISTS (SELECT 1 FROM review_run_job_links AS link WHERE link.review_run_id = run.id AND link.request_id = request.request_id);
CREATE TRIGGER tr_validation_dispatch_request_pending AFTER INSERT ON review_run_requests
BEGIN
  INSERT INTO validation_dispatch_checks (repository_id, review_run_id, request_id, pending, last_sequence, checked_at, blockers_json)
  SELECT repository_id, NEW.review_run_id, NEW.request_id, 1, 0, NULL, '[]'
  FROM review_runs WHERE id = NEW.review_run_id;
END;
CREATE TRIGGER tr_validation_dispatch_job_associated AFTER INSERT ON review_run_job_links
BEGIN
  UPDATE validation_dispatch_checks SET pending = 0
  WHERE review_run_id = NEW.review_run_id AND request_id = NEW.request_id;
END;
