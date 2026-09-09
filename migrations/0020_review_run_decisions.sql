CREATE TABLE review_run_decision_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  work_item_kind TEXT NOT NULL CHECK (work_item_kind IN ('pull_request', 'issue')),
  change_id TEXT NOT NULL CHECK (length(change_id) BETWEEN 1 AND 128),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  action TEXT NOT NULL CHECK (action IN ('approve', 'request_changes', 'comment', 'override_approve', 'withdraw')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2048 AND trim(reason) = reason AND instr(reason, char(0)) = 0),
  previous_version INTEGER NOT NULL CHECK (previous_version BETWEEN 0 AND 9007199254740990),
  version INTEGER NOT NULL CHECK (version = previous_version + 1),
  revision_key TEXT NOT NULL CHECK (length(revision_key) = 64 AND revision_key NOT GLOB '*[^0-9a-f]*'),
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'),
  result_set_digest TEXT NOT NULL CHECK (length(result_set_digest) = 64 AND result_set_digest NOT GLOB '*[^0-9a-f]*'),
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
  target_decision_id TEXT REFERENCES review_run_decision_events(id) ON DELETE RESTRICT,
  supersedes_decision_id TEXT REFERENCES review_run_decision_events(id) ON DELETE RESTRICT,
  snapshot_json TEXT NOT NULL CHECK (
    length(CAST(snapshot_json AS BLOB)) BETWEEN 1 AND 131072
    AND json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'
    AND json_extract(snapshot_json, '$.schemaVersion') IS 'ReviewRunDecisionSnapshotV1'
    AND json_extract(snapshot_json, '$.repositoryId') IS repository_id
    AND json_extract(snapshot_json, '$.reviewRunId') IS review_run_id
    AND json_extract(snapshot_json, '$.workItemId') IS work_item_id
    AND json_extract(snapshot_json, '$.workItemKind') IS work_item_kind
    AND json_extract(snapshot_json, '$.revisionKey') IS revision_key
    AND json_extract(snapshot_json, '$.planDigest') IS plan_digest
  ),
  policy_json TEXT NOT NULL CHECK (
    length(CAST(policy_json AS BLOB)) BETWEEN 1 AND 16777216
    AND json_valid(policy_json) AND json_type(policy_json) = 'object'
    AND json_extract(policy_json, '$.policyVersion') IS 'required-checks-and-p0-p1-v1'
    AND json_type(policy_json, '$.reasons') IS 'array'
    AND json_extract(policy_json, '$.applicable') IS (work_item_kind = 'pull_request')
    AND ((work_item_kind = 'issue' AND json_type(policy_json, '$.eligible') IS 'null')
      OR (work_item_kind = 'pull_request' AND json_type(policy_json, '$.eligible') IN ('true', 'false')))
  ),
  policy_snapshot_json TEXT NOT NULL CHECK (
    length(CAST(policy_snapshot_json AS BLOB)) BETWEEN 1 AND 32768
    AND json_valid(policy_snapshot_json) AND json_type(policy_snapshot_json) = 'object'
    AND json_extract(policy_snapshot_json, '$.policyVersion') IS json_extract(policy_json, '$.policyVersion')
    AND json_extract(policy_snapshot_json, '$.applicable') IS json_extract(policy_json, '$.applicable')
    AND json_extract(policy_snapshot_json, '$.eligible') IS json_extract(policy_json, '$.eligible')
    AND json_extract(policy_snapshot_json, '$.blockingFindingCount') IS json_extract(policy_json, '$.blockingFindingCount')
    AND json_extract(policy_snapshot_json, '$.reasonCount') IS json_extract(policy_json, '$.reasonCount')
    AND json_type(policy_snapshot_json, '$.reasonCodes') IS 'array'
    AND json_array_length(policy_snapshot_json, '$.reasonCodes') <= 128
    AND json_type(policy_snapshot_json, '$.reasonCodesTruncated') IN ('true', 'false')
  ),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  UNIQUE (review_run_id, change_id),
  UNIQUE (review_run_id, version),
  CHECK (work_item_kind = 'pull_request' OR action NOT IN ('approve', 'override_approve')),
  CHECK ((action = 'withdraw' AND target_decision_id IS NOT NULL
      AND supersedes_decision_id IS target_decision_id)
    OR (action != 'withdraw' AND target_decision_id IS NULL)),
  CHECK (action != 'comment' OR supersedes_decision_id IS NULL),
  CHECK (action != 'approve' OR json_extract(policy_json, '$.eligible') IS 1)
) STRICT;

CREATE INDEX ix_review_run_decisions_history
  ON review_run_decision_events(repository_id, review_run_id, version DESC);
CREATE INDEX ix_review_run_decisions_current
  ON review_run_decision_events(review_run_id, version DESC) WHERE action != 'comment';

CREATE TRIGGER tr_review_run_decision_insert BEFORE INSERT ON review_run_decision_events
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM review_run_decision_events WHERE id = NEW.id
      OR (review_run_id = NEW.review_run_id AND change_id = NEW.change_id)
      OR (review_run_id = NEW.review_run_id AND version = NEW.version)
  ) THEN RAISE(ABORT, 'review run decision receipts cannot be replaced') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM review_runs AS run JOIN work_items AS item ON item.id = run.work_item_id
    WHERE run.id = NEW.review_run_id AND run.repository_id = NEW.repository_id
      AND run.work_item_id = NEW.work_item_id AND item.resource_kind = NEW.work_item_kind
      AND run.revision_key = NEW.revision_key AND run.plan_digest = NEW.plan_digest
  ) THEN RAISE(ABORT, 'review run decision scope does not match its run') END;
  SELECT CASE WHEN NEW.previous_version != COALESCE((
    SELECT MAX(version) FROM review_run_decision_events WHERE review_run_id = NEW.review_run_id
  ), 0) OR EXISTS (
    SELECT 1 FROM review_run_decision_events WHERE review_run_id = NEW.review_run_id
      AND version = NEW.previous_version AND created_at > NEW.created_at
  ) THEN RAISE(ABORT, 'review run decision version does not follow its stream') END;
  SELECT CASE WHEN NEW.action != 'comment' AND NEW.supersedes_decision_id IS NOT (
    SELECT CASE WHEN action = 'withdraw' THEN NULL ELSE id END
    FROM review_run_decision_events WHERE review_run_id = NEW.review_run_id
      AND action != 'comment' ORDER BY version DESC LIMIT 1
  ) THEN RAISE(ABORT, 'review run decision does not supersede the active decision') END;
  SELECT CASE WHEN NEW.action = 'withdraw' AND NOT EXISTS (
    SELECT 1 FROM review_run_decision_events WHERE id = NEW.target_decision_id
      AND repository_id = NEW.repository_id AND review_run_id = NEW.review_run_id
      AND action NOT IN ('comment', 'withdraw')
  ) THEN RAISE(ABORT, 'review run withdrawal requires an active decision') END;
END;

CREATE TRIGGER tr_review_run_decision_no_update BEFORE UPDATE ON review_run_decision_events
BEGIN SELECT RAISE(ABORT, 'review run decision audit is immutable'); END;
CREATE TRIGGER tr_review_run_decision_no_delete BEFORE DELETE ON review_run_decision_events
BEGIN SELECT RAISE(ABORT, 'review run decision audit is immutable'); END;
