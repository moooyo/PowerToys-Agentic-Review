-- Preserve M20 receipts byte for byte while admitting the explicit disposition policy.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE review_run_decision_events_next (
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
  revision_key TEXT NOT NULL CHECK (length(revision_key) = 64 AND length(CAST(revision_key AS BLOB)) = 64 AND revision_key NOT GLOB '*[^0-9a-f]*'),
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64 AND length(CAST(plan_digest AS BLOB)) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'),
  result_set_digest TEXT NOT NULL CHECK (length(result_set_digest) = 64 AND result_set_digest NOT GLOB '*[^0-9a-f]*'),
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
  target_decision_id TEXT REFERENCES review_run_decision_events_next(id) ON DELETE RESTRICT,
  supersedes_decision_id TEXT REFERENCES review_run_decision_events_next(id) ON DELETE RESTRICT,
  snapshot_json TEXT NOT NULL CHECK (
    length(CAST(snapshot_json AS BLOB)) BETWEEN 1 AND 131072
    AND json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'
    AND json_extract(snapshot_json, '$.schemaVersion') IN ('ReviewRunDecisionSnapshotV1', 'ReviewRunDecisionSnapshotV2')
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
    AND json_extract(policy_json, '$.policyVersion') IN ('required-checks-and-p0-p1-v1', 'required-checks-and-unresolved-p0-p1-v2')
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
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64 AND length(CAST(intent_digest AS BLOB)) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64 AND length(CAST(receipt_digest AS BLOB)) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  UNIQUE (review_run_id, change_id),
  UNIQUE (review_run_id, version),
  CHECK (work_item_kind = 'pull_request' OR action NOT IN ('approve', 'override_approve')),
  CHECK ((action = 'withdraw' AND target_decision_id IS NOT NULL
      AND supersedes_decision_id IS target_decision_id)
    OR (action != 'withdraw' AND target_decision_id IS NULL)),
  CHECK (action != 'comment' OR supersedes_decision_id IS NULL),
  CHECK (
    (json_extract(snapshot_json, '$.schemaVersion') IS 'ReviewRunDecisionSnapshotV1'
      AND json_extract(policy_json, '$.policyVersion') IS 'required-checks-and-p0-p1-v1')
    OR (json_extract(snapshot_json, '$.schemaVersion') IS 'ReviewRunDecisionSnapshotV2'
      AND json_extract(policy_json, '$.policyVersion') IS 'required-checks-and-unresolved-p0-p1-v2'
      AND json_type(snapshot_json, '$.findingDispositionDigest') IS 'text'
      AND length(json_extract(snapshot_json, '$.findingDispositionDigest')) = 64
      AND length(CAST(json_extract(snapshot_json, '$.findingDispositionDigest') AS BLOB)) = 64
      AND json_extract(snapshot_json, '$.findingDispositionDigest') NOT GLOB '*[^0-9a-f]*'
      AND json_extract(policy_json, '$.findingDispositionDigest') IS json_extract(snapshot_json, '$.findingDispositionDigest')
      AND json_extract(policy_snapshot_json, '$.findingDispositionDigest') IS json_extract(snapshot_json, '$.findingDispositionDigest')
      AND json_type(policy_json, '$.blockingFindingCount') IS 'integer'
      AND json_extract(policy_json, '$.blockingFindingCount') BETWEEN 0 AND 9007199254740991
      AND json_type(policy_json, '$.unresolvedBlockingFindingCount') IS 'integer'
      AND json_extract(policy_json, '$.unresolvedBlockingFindingCount') BETWEEN 0 AND json_extract(policy_json, '$.blockingFindingCount')
      AND json_type(policy_snapshot_json, '$.blockingFindingCount') IS 'integer'
      AND json_type(policy_snapshot_json, '$.unresolvedBlockingFindingCount') IS 'integer'
      AND json_extract(policy_snapshot_json, '$.unresolvedBlockingFindingCount') IS json_extract(policy_json, '$.unresolvedBlockingFindingCount'))
  ),
  CHECK (action != 'approve' OR json_extract(policy_json, '$.eligible') IS 1)
) STRICT, WITHOUT ROWID;

-- The migration runner owns BEGIN IMMEDIATE and COMMIT. Keep foreign keys enabled.
-- Both self-references above name the replacement table; RENAME retargets them atomically.
INSERT INTO review_run_decision_events_next (
  id, repository_id, review_run_id, work_item_id, work_item_kind, change_id,
  actor_issuer, actor_subject, action, reason, previous_version, version,
  revision_key, plan_digest, result_set_digest, policy_digest, target_decision_id,
  supersedes_decision_id, snapshot_json, policy_json, policy_snapshot_json,
  intent_digest, receipt_digest, created_at
) SELECT id, repository_id, review_run_id, work_item_id, work_item_kind, change_id,
  actor_issuer, actor_subject, action, reason, previous_version, version,
  revision_key, plan_digest, result_set_digest, policy_digest, target_decision_id,
  supersedes_decision_id, snapshot_json, policy_json, policy_snapshot_json,
  intent_digest, receipt_digest, created_at FROM review_run_decision_events;
DROP TABLE review_run_decision_events;
ALTER TABLE review_run_decision_events_next RENAME TO review_run_decision_events;
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

-- Occurrence keys and receipt digests are computed and validated by the Server.
-- SQL protects their shape, relational scope, immutable history, and atomic projection.
CREATE TABLE finding_disposition_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  result_id TEXT NOT NULL REFERENCES validation_job_results(id) ON DELETE RESTRICT,
  result_digest TEXT NOT NULL CHECK (length(result_digest) = 64 AND length(CAST(result_digest AS BLOB)) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('pr_finding', 'validation_observation')),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
  occurrence_key TEXT NOT NULL CHECK (length(occurrence_key) = 64 AND length(CAST(occurrence_key AS BLOB)) = 64 AND occurrence_key NOT GLOB '*[^0-9a-f]*'),
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  work_item_kind TEXT NOT NULL CHECK (work_item_kind IN ('pull_request', 'issue')),
  revision_key TEXT NOT NULL CHECK (length(revision_key) = 64 AND length(CAST(revision_key AS BLOB)) = 64 AND revision_key NOT GLOB '*[^0-9a-f]*'),
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64 AND length(CAST(plan_digest AS BLOB)) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'),
  result_set_digest_at_change TEXT NOT NULL CHECK (length(result_set_digest_at_change) = 64 AND length(CAST(result_set_digest_at_change AS BLOB)) = 64 AND result_set_digest_at_change NOT GLOB '*[^0-9a-f]*'),
  context_digest_at_change TEXT NOT NULL CHECK (length(context_digest_at_change) = 64 AND length(CAST(context_digest_at_change AS BLOB)) = 64 AND context_digest_at_change NOT GLOB '*[^0-9a-f]*'),
  source_current_at_change INTEGER NOT NULL CHECK (source_current_at_change IN (0, 1)),
  latest_for_request_at_change INTEGER NOT NULL CHECK (latest_for_request_at_change IN (0, 1)),
  change_id TEXT NOT NULL CHECK (length(change_id) BETWEEN 1 AND 128),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  action TEXT NOT NULL CHECK (action IN ('accept', 'dismiss', 'resolve', 'reopen')),
  previous_state TEXT NOT NULL CHECK (previous_state IN ('open', 'accepted', 'dismissed', 'resolved')),
  state TEXT NOT NULL CHECK (state IN ('open', 'accepted', 'dismissed', 'resolved')),
  previous_version INTEGER NOT NULL CHECK (previous_version BETWEEN 0 AND 9007199254740990),
  version INTEGER NOT NULL CHECK (version = previous_version + 1),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2048 AND trim(reason) = reason AND instr(reason, char(0)) = 0),
  created_at TEXT NOT NULL,
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64 AND length(CAST(intent_digest AS BLOB)) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64 AND length(CAST(receipt_digest AS BLOB)) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (repository_id, change_id),
  UNIQUE (result_id, kind, ordinal, version),
  FOREIGN KEY (review_run_id, request_id) REFERENCES review_run_requests(review_run_id, request_id) ON DELETE RESTRICT,
  CHECK (state != previous_state),
  CHECK (state = CASE action WHEN 'accept' THEN 'accepted' WHEN 'dismiss' THEN 'dismissed'
    WHEN 'resolve' THEN 'resolved' WHEN 'reopen' THEN 'open' END),
  CHECK (previous_version != 0 OR previous_state = 'open')
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_finding_disposition_events_history
  ON finding_disposition_events(repository_id, result_id, kind, ordinal, version DESC);
CREATE INDEX ix_finding_disposition_events_run
  ON finding_disposition_events(repository_id, review_run_id, created_at DESC, id DESC);

CREATE TABLE finding_dispositions (
  result_id TEXT NOT NULL REFERENCES validation_job_results(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('pr_finding', 'validation_observation')),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  result_digest TEXT NOT NULL CHECK (length(result_digest) = 64 AND length(CAST(result_digest AS BLOB)) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
  occurrence_key TEXT NOT NULL UNIQUE CHECK (length(occurrence_key) = 64 AND length(CAST(occurrence_key AS BLOB)) = 64 AND occurrence_key NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('open', 'accepted', 'dismissed', 'resolved')),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  last_event_id TEXT NOT NULL UNIQUE REFERENCES finding_disposition_events(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (updated_at >= created_at),
  updated_by_issuer TEXT NOT NULL,
  updated_by_subject TEXT NOT NULL,
  PRIMARY KEY (result_id, kind, ordinal),
  FOREIGN KEY (review_run_id, request_id) REFERENCES review_run_requests(review_run_id, request_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_finding_dispositions_run
  ON finding_dispositions(repository_id, review_run_id, result_id, kind, ordinal);

CREATE TRIGGER tr_finding_disposition_event_insert BEFORE INSERT ON finding_disposition_events
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM finding_disposition_events WHERE id = NEW.id
      OR (repository_id = NEW.repository_id AND change_id = NEW.change_id)
      OR (result_id = NEW.result_id AND kind = NEW.kind AND ordinal = NEW.ordinal AND version = NEW.version)
  ) THEN RAISE(ABORT, 'finding disposition receipts cannot be replaced') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM validation_job_results AS result
    JOIN review_runs AS run ON run.id = result.review_run_id
    JOIN work_items AS item ON item.id = result.work_item_id
    JOIN review_run_requests AS request ON request.review_run_id = result.review_run_id
      AND request.request_id = result.request_id
    WHERE result.id = NEW.result_id AND result.result_digest = NEW.result_digest
      AND result.repository_id = NEW.repository_id AND result.review_run_id = NEW.review_run_id
      AND result.request_id = NEW.request_id AND result.job_id = NEW.job_id
      AND result.work_item_id = NEW.work_item_id AND item.resource_kind = NEW.work_item_kind
      AND result.resource_revision = NEW.revision_key AND result.plan_digest = NEW.plan_digest
      AND run.repository_id = NEW.repository_id AND run.work_item_id = NEW.work_item_id
      AND run.revision_key = NEW.revision_key AND run.plan_digest = NEW.plan_digest
      AND item.repository_id = NEW.repository_id
  ) THEN RAISE(ABORT, 'finding disposition scope does not match its result') END;
  SELECT CASE WHEN (NEW.previous_version = 0 AND EXISTS (
    SELECT 1 FROM finding_dispositions WHERE result_id = NEW.result_id
      AND kind = NEW.kind AND ordinal = NEW.ordinal
  )) OR (NEW.previous_version > 0 AND NOT EXISTS (
    SELECT 1 FROM finding_dispositions AS current
    JOIN finding_disposition_events AS event ON event.id = current.last_event_id
    WHERE current.result_id = NEW.result_id AND current.kind = NEW.kind AND current.ordinal = NEW.ordinal
      AND current.repository_id = NEW.repository_id AND current.review_run_id = NEW.review_run_id
      AND current.request_id = NEW.request_id AND current.job_id = NEW.job_id
      AND current.result_digest = NEW.result_digest AND current.occurrence_key = NEW.occurrence_key
      AND current.version = NEW.previous_version AND current.state = NEW.previous_state
      AND current.updated_at <= NEW.created_at
      AND event.result_id = current.result_id AND event.kind = current.kind AND event.ordinal = current.ordinal
      AND event.version = current.version AND event.state = current.state
  )) THEN RAISE(ABORT, 'finding disposition does not follow the current occurrence') END;
END;

CREATE TRIGGER tr_finding_disposition_insert BEFORE INSERT ON finding_dispositions
WHEN EXISTS (
  SELECT 1 FROM finding_dispositions WHERE (result_id = NEW.result_id AND kind = NEW.kind AND ordinal = NEW.ordinal)
    OR occurrence_key = NEW.occurrence_key OR last_event_id = NEW.last_event_id
) OR NOT EXISTS (
  SELECT 1 FROM finding_disposition_events AS event WHERE event.id = NEW.last_event_id
    AND event.result_id = NEW.result_id AND event.kind = NEW.kind AND event.ordinal = NEW.ordinal
    AND event.repository_id = NEW.repository_id AND event.review_run_id = NEW.review_run_id
    AND event.request_id = NEW.request_id AND event.job_id = NEW.job_id
    AND event.result_digest = NEW.result_digest AND event.occurrence_key = NEW.occurrence_key
    AND event.previous_version = 0 AND event.version = NEW.version AND event.state = NEW.state
    AND event.created_at = NEW.created_at AND event.created_at = NEW.updated_at
    AND event.actor_issuer = NEW.updated_by_issuer AND event.actor_subject = NEW.updated_by_subject
    AND NOT EXISTS (SELECT 1 FROM finding_disposition_events AS later WHERE later.result_id = event.result_id
      AND later.kind = event.kind AND later.ordinal = event.ordinal AND later.version > event.version)
)
BEGIN SELECT RAISE(ABORT, 'finding dispositions require their immutable event'); END;

CREATE TRIGGER tr_finding_disposition_update BEFORE UPDATE ON finding_dispositions
WHEN NEW.result_id IS NOT OLD.result_id OR NEW.kind IS NOT OLD.kind OR NEW.ordinal IS NOT OLD.ordinal
  OR NEW.repository_id IS NOT OLD.repository_id OR NEW.review_run_id IS NOT OLD.review_run_id
  OR NEW.request_id IS NOT OLD.request_id OR NEW.job_id IS NOT OLD.job_id
  OR NEW.result_digest IS NOT OLD.result_digest OR NEW.occurrence_key IS NOT OLD.occurrence_key
  OR NEW.created_at IS NOT OLD.created_at OR NEW.version != OLD.version + 1
  OR NOT EXISTS (
    SELECT 1 FROM finding_disposition_events AS event WHERE event.id = NEW.last_event_id
      AND event.result_id = NEW.result_id AND event.kind = NEW.kind AND event.ordinal = NEW.ordinal
      AND event.repository_id = NEW.repository_id AND event.review_run_id = NEW.review_run_id
      AND event.request_id = NEW.request_id AND event.job_id = NEW.job_id
      AND event.result_digest = NEW.result_digest AND event.occurrence_key = NEW.occurrence_key
      AND event.previous_version = OLD.version AND event.previous_state = OLD.state
      AND event.version = NEW.version AND event.state = NEW.state AND event.created_at = NEW.updated_at
      AND event.actor_issuer = NEW.updated_by_issuer AND event.actor_subject = NEW.updated_by_subject
      AND NOT EXISTS (SELECT 1 FROM finding_disposition_events AS later WHERE later.result_id = event.result_id
        AND later.kind = event.kind AND later.ordinal = event.ordinal AND later.version > event.version)
  )
BEGIN SELECT RAISE(ABORT, 'finding dispositions require their next immutable event'); END;

CREATE TRIGGER tr_finding_disposition_apply AFTER INSERT ON finding_disposition_events
BEGIN
  INSERT INTO finding_dispositions (
    result_id, kind, ordinal, repository_id, review_run_id, request_id, job_id,
    result_digest, occurrence_key, state, version, last_event_id,
    created_at, updated_at, updated_by_issuer, updated_by_subject
  ) SELECT NEW.result_id, NEW.kind, NEW.ordinal, NEW.repository_id, NEW.review_run_id, NEW.request_id, NEW.job_id,
    NEW.result_digest, NEW.occurrence_key, NEW.state, NEW.version, NEW.id,
    NEW.created_at, NEW.created_at, NEW.actor_issuer, NEW.actor_subject WHERE NEW.previous_version = 0;
  UPDATE finding_dispositions SET state = NEW.state, version = NEW.version, last_event_id = NEW.id,
    updated_at = NEW.created_at, updated_by_issuer = NEW.actor_issuer, updated_by_subject = NEW.actor_subject
    WHERE NEW.previous_version > 0 AND result_id = NEW.result_id AND kind = NEW.kind AND ordinal = NEW.ordinal;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM finding_dispositions WHERE result_id = NEW.result_id AND kind = NEW.kind AND ordinal = NEW.ordinal
      AND repository_id = NEW.repository_id AND review_run_id = NEW.review_run_id
      AND request_id = NEW.request_id AND job_id = NEW.job_id AND result_digest = NEW.result_digest
      AND occurrence_key = NEW.occurrence_key AND state = NEW.state AND version = NEW.version
      AND last_event_id = NEW.id AND updated_at = NEW.created_at
      AND updated_by_issuer = NEW.actor_issuer AND updated_by_subject = NEW.actor_subject
  ) THEN RAISE(ABORT, 'finding disposition event did not update its projection') END;
END;

CREATE TRIGGER tr_finding_disposition_no_delete BEFORE DELETE ON finding_dispositions
BEGIN SELECT RAISE(ABORT, 'finding dispositions must retain their history'); END;
CREATE TRIGGER tr_finding_disposition_event_no_update BEFORE UPDATE ON finding_disposition_events
BEGIN SELECT RAISE(ABORT, 'finding disposition audit is immutable'); END;
CREATE TRIGGER tr_finding_disposition_event_no_delete BEFORE DELETE ON finding_disposition_events
BEGIN SELECT RAISE(ABORT, 'finding disposition audit is immutable'); END;
