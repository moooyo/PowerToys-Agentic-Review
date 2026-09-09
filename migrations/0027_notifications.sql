-- Notifications are bounded inbox projections. Source results and publication audits retain
-- their own history. Only transitions observed after this migration create notifications.
CREATE TABLE notification_retention (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  coverage_start TEXT NOT NULL,
  retained_after TEXT NOT NULL,
  CHECK (retained_after >= substr(coverage_start, 1, 10) || 'T00:00:00.000Z'),
  CHECK (substr(retained_after, 11) = 'T00:00:00.000Z')
) STRICT;
INSERT INTO notification_retention(singleton, coverage_start, retained_after)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT00:00:00.000Z', 'now'));

CREATE TABLE notification_repository_counters (
  repository_id TEXT PRIMARY KEY REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  next_sequence INTEGER NOT NULL DEFAULT 0 CHECK (next_sequence BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE notification_repository_daily_counts (
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  recorded_day TEXT NOT NULL CHECK (length(recorded_day) = 10),
  total INTEGER NOT NULL CHECK (total BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (repository_id, recorded_day)
) STRICT;

CREATE TABLE notification_events (
  id TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('validation_job_terminal', 'publication_attempt')),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 128),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  recorded_day TEXT NOT NULL CHECK (recorded_day = substr(recorded_at, 1, 10)),
  work_item_id TEXT NOT NULL,
  work_item_kind TEXT NOT NULL CHECK (work_item_kind IN ('pull_request', 'issue')),
  work_item_number INTEGER NOT NULL CHECK (work_item_number BETWEEN 1 AND 9007199254740991),
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE RESTRICT,
  revision_key TEXT NOT NULL,
  request_id TEXT,
  job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
  job_activation INTEGER,
  run_attempt_id TEXT REFERENCES run_attempts(id) ON DELETE RESTRICT,
  workflow_kind TEXT CHECK (workflow_kind IN ('pr_static_build', 'pr_ui', 'issue_triage', 'issue_validation')),
  target TEXT CHECK (target IN ('headless', 'windows_desktop', 'web')),
  publication_id TEXT REFERENCES publication_intents(publication_id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'dead_letter', 'cancelled', 'stale', 'published', 'blocked', 'unknown')),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json) AND json_type(summary_json) = 'object'
    AND length(CAST(summary_json AS BLOB)) <= 4096),
  UNIQUE (repository_id, id),
  UNIQUE (repository_id, id, recorded_day),
  UNIQUE (repository_id, sequence),
  UNIQUE (source_kind, source_id),
  FOREIGN KEY (work_item_id, repository_id) REFERENCES work_items(id, repository_id) ON DELETE RESTRICT,
  FOREIGN KEY (review_run_id, request_id, job_activation)
    REFERENCES review_run_job_links(review_run_id, request_id, activation_number) ON DELETE RESTRICT,
  CHECK ((source_kind = 'validation_job_terminal' AND job_id IS NOT NULL AND request_id IS NOT NULL
      AND job_activation IS NOT NULL AND workflow_kind IS NOT NULL AND target IS NOT NULL AND publication_id IS NULL
      AND outcome IN ('succeeded', 'failed', 'dead_letter', 'cancelled', 'stale'))
    OR (source_kind = 'publication_attempt' AND publication_id IS NOT NULL AND job_id IS NULL
      AND request_id IS NULL AND job_activation IS NULL AND run_attempt_id IS NULL
      AND workflow_kind IS NULL AND target IS NULL AND outcome IN ('published', 'failed', 'blocked', 'unknown')))
) STRICT;
CREATE INDEX ix_notification_events_retention ON notification_events(recorded_at, id);

CREATE TABLE notification_read_states (
  repository_id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  recorded_day TEXT NOT NULL,
  principal_issuer TEXT NOT NULL CHECK (length(principal_issuer) BETWEEN 1 AND 2048),
  principal_subject TEXT NOT NULL CHECK (length(principal_subject) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK (state IN ('unread', 'read', 'archived')),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_issuer, principal_subject, notification_id),
  FOREIGN KEY (repository_id, notification_id, recorded_day)
    REFERENCES notification_events(repository_id, id, recorded_day) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ix_notification_read_states_event ON notification_read_states(notification_id, principal_issuer, principal_subject);
CREATE INDEX ix_notification_read_states_retention ON notification_read_states(recorded_day, notification_id, principal_issuer, principal_subject);
CREATE TABLE notification_principal_counters (
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  principal_issuer TEXT NOT NULL,
  principal_subject TEXT NOT NULL,
  recorded_day TEXT NOT NULL,
  read_count INTEGER NOT NULL CHECK (read_count BETWEEN 0 AND 9007199254740991),
  archived_count INTEGER NOT NULL CHECK (archived_count BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (principal_issuer, principal_subject, repository_id, recorded_day)
) STRICT;
CREATE INDEX ix_notification_principal_counters_retention ON notification_principal_counters(recorded_day);

CREATE TABLE notification_change_receipts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  principal_issuer TEXT NOT NULL,
  principal_subject TEXT NOT NULL,
  change_id TEXT NOT NULL CHECK (length(change_id) BETWEEN 1 AND 128),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 65536),
  created_at TEXT NOT NULL,
  retention_day TEXT NOT NULL CHECK (length(retention_day) = 10),
  UNIQUE (repository_id, principal_issuer, principal_subject, change_id)
) STRICT;
CREATE INDEX ix_notification_change_receipts_retention ON notification_change_receipts(retention_day, id);

CREATE TRIGGER tr_notification_sequence_insert BEFORE INSERT ON notification_repository_counters
WHEN NEW.next_sequence != 0 OR EXISTS (SELECT 1 FROM notification_repository_counters WHERE repository_id = NEW.repository_id)
BEGIN SELECT RAISE(ABORT, 'notification sequence cannot be replaced'); END;
CREATE TRIGGER tr_notification_sequence_update BEFORE UPDATE ON notification_repository_counters
WHEN NEW.repository_id IS NOT OLD.repository_id OR NEW.next_sequence != OLD.next_sequence + 1
  OR NOT EXISTS (SELECT 1 FROM notification_events WHERE repository_id = NEW.repository_id AND sequence = NEW.next_sequence)
BEGIN SELECT RAISE(ABORT, 'notification sequence must follow its inserted event'); END;
CREATE TRIGGER tr_notification_sequence_no_delete BEFORE DELETE ON notification_repository_counters
BEGIN SELECT RAISE(ABORT, 'notification sequence must be retained'); END;

CREATE TRIGGER tr_notification_event_insert BEFORE INSERT ON notification_events
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM notification_events WHERE id = NEW.id
    OR (source_kind = NEW.source_kind AND source_id = NEW.source_id))
    THEN RAISE(ABORT, 'notification events cannot be replaced') END;
  SELECT CASE WHEN NEW.recorded_at < (SELECT retained_after FROM notification_retention WHERE singleton = 1)
    OR NEW.sequence IS NOT (SELECT next_sequence + 1 FROM notification_repository_counters WHERE repository_id = NEW.repository_id)
    THEN RAISE(ABORT, 'notification sequence or retention boundary is invalid') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM review_runs WHERE id = NEW.review_run_id
    AND repository_id = NEW.repository_id AND work_item_id = NEW.work_item_id AND revision_key = NEW.revision_key)
    THEN RAISE(ABORT, 'notification run scope is invalid') END;
  SELECT CASE WHEN NEW.source_kind = 'validation_job_terminal' AND NOT EXISTS (
    SELECT 1 FROM review_run_job_links AS link JOIN jobs AS job ON job.id = link.job_id
    WHERE link.job_id = NEW.job_id AND NEW.source_id = NEW.job_id AND link.review_run_id = NEW.review_run_id
      AND link.request_id = NEW.request_id AND link.activation_number = NEW.job_activation AND job.status = NEW.outcome)
    THEN RAISE(ABORT, 'notification validation source is invalid') END;
  SELECT CASE WHEN NEW.source_kind = 'publication_attempt' AND NOT EXISTS (
    SELECT 1 FROM publication_attempt_events AS attempt JOIN publication_intents AS intent ON intent.publication_id = attempt.publication_id
    WHERE attempt.id = NEW.source_id AND attempt.publication_id = NEW.publication_id AND attempt.repository_id = NEW.repository_id
      AND intent.repository_id = NEW.repository_id AND intent.review_run_id = NEW.review_run_id
      AND json_extract(attempt.receipt_json, '$.phase') = 'outcome' AND json_extract(attempt.receipt_json, '$.outcome') = NEW.outcome)
    THEN RAISE(ABORT, 'notification publication source is invalid') END;
END;
CREATE TRIGGER tr_notification_event_count_insert AFTER INSERT ON notification_events
BEGIN
  UPDATE notification_repository_counters SET next_sequence = NEW.sequence
  WHERE repository_id = NEW.repository_id;
  INSERT INTO notification_repository_daily_counts(repository_id, recorded_day, total)
  VALUES (NEW.repository_id, NEW.recorded_day, 1)
  ON CONFLICT(repository_id, recorded_day) DO UPDATE SET total = total + 1;
END;
CREATE TRIGGER tr_notification_event_no_update BEFORE UPDATE ON notification_events
BEGIN SELECT RAISE(ABORT, 'notification events are immutable'); END;
CREATE TRIGGER tr_notification_event_retention_delete BEFORE DELETE ON notification_events
WHEN NOT EXISTS (SELECT 1 FROM notification_retention WHERE singleton = 1 AND OLD.recorded_at < retained_after)
BEGIN SELECT RAISE(ABORT, 'notification deletion requires an active retention boundary'); END;
CREATE TRIGGER tr_notification_event_count_delete AFTER DELETE ON notification_events
BEGIN
  UPDATE notification_repository_daily_counts SET total = total - 1
  WHERE repository_id = OLD.repository_id AND recorded_day = OLD.recorded_day;
  DELETE FROM notification_repository_daily_counts
  WHERE repository_id = OLD.repository_id AND recorded_day = OLD.recorded_day AND total = 0;
END;

CREATE TRIGGER tr_notification_state_insert BEFORE INSERT ON notification_read_states
WHEN NEW.version != 1 OR EXISTS (SELECT 1 FROM notification_read_states
  WHERE notification_id = NEW.notification_id AND principal_issuer = NEW.principal_issuer AND principal_subject = NEW.principal_subject)
BEGIN SELECT RAISE(ABORT, 'notification state cannot replace an existing version'); END;
CREATE TRIGGER tr_notification_state_update BEFORE UPDATE ON notification_read_states
WHEN NEW.repository_id IS NOT OLD.repository_id OR NEW.notification_id IS NOT OLD.notification_id
  OR NEW.principal_issuer IS NOT OLD.principal_issuer OR NEW.principal_subject IS NOT OLD.principal_subject
  OR NEW.recorded_day IS NOT OLD.recorded_day
  OR NEW.version != OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'notification state version is invalid'); END;
CREATE TRIGGER tr_notification_state_count_insert AFTER INSERT ON notification_read_states
BEGIN
  INSERT INTO notification_principal_counters(repository_id, principal_issuer, principal_subject, recorded_day, read_count, archived_count)
  VALUES (NEW.repository_id, NEW.principal_issuer, NEW.principal_subject, NEW.recorded_day, NEW.state = 'read', NEW.state = 'archived')
  ON CONFLICT(principal_issuer, principal_subject, repository_id, recorded_day) DO UPDATE
    SET read_count = read_count + (NEW.state = 'read'), archived_count = archived_count + (NEW.state = 'archived');
END;
CREATE TRIGGER tr_notification_state_count_update AFTER UPDATE ON notification_read_states
BEGIN
  UPDATE notification_principal_counters
  SET read_count = read_count - (OLD.state = 'read') + (NEW.state = 'read'),
      archived_count = archived_count - (OLD.state = 'archived') + (NEW.state = 'archived')
  WHERE repository_id = NEW.repository_id AND principal_issuer = NEW.principal_issuer AND principal_subject = NEW.principal_subject
    AND recorded_day = NEW.recorded_day;
END;
CREATE TRIGGER tr_notification_state_retention_delete BEFORE DELETE ON notification_read_states
WHEN NOT EXISTS (SELECT 1 FROM notification_events AS event JOIN notification_retention AS retention ON retention.singleton = 1
  WHERE event.id = OLD.notification_id AND event.repository_id = OLD.repository_id
    AND event.recorded_at < retention.retained_after)
BEGIN SELECT RAISE(ABORT, 'notification state deletion requires an active retention boundary'); END;
CREATE TRIGGER tr_notification_state_count_delete AFTER DELETE ON notification_read_states
BEGIN
  UPDATE notification_principal_counters SET read_count = read_count - (OLD.state = 'read'),
    archived_count = archived_count - (OLD.state = 'archived')
  WHERE repository_id = OLD.repository_id AND principal_issuer = OLD.principal_issuer AND principal_subject = OLD.principal_subject
    AND recorded_day = OLD.recorded_day;
END;

CREATE TRIGGER tr_notification_receipt_no_update BEFORE UPDATE ON notification_change_receipts
BEGIN SELECT RAISE(ABORT, 'notification change receipts are immutable'); END;
CREATE TRIGGER tr_notification_receipt_no_replace BEFORE INSERT ON notification_change_receipts
WHEN EXISTS (SELECT 1 FROM notification_change_receipts WHERE id = NEW.id
  OR (repository_id = NEW.repository_id AND principal_issuer = NEW.principal_issuer
    AND principal_subject = NEW.principal_subject AND change_id = NEW.change_id))
BEGIN SELECT RAISE(ABORT, 'notification change receipts cannot be replaced'); END;
CREATE TRIGGER tr_notification_receipt_retention_delete BEFORE DELETE ON notification_change_receipts
WHEN NOT EXISTS (SELECT 1 FROM notification_retention WHERE singleton = 1 AND OLD.retention_day < substr(retained_after, 1, 10))
BEGIN SELECT RAISE(ABORT, 'notification receipt deletion requires an active retention boundary'); END;
CREATE TRIGGER tr_notification_retention_no_delete BEFORE DELETE ON notification_retention
BEGIN SELECT RAISE(ABORT, 'notification retention boundary must be retained'); END;
CREATE TRIGGER tr_notification_retention_no_replace BEFORE INSERT ON notification_retention
WHEN EXISTS (SELECT 1 FROM notification_retention WHERE singleton = NEW.singleton)
BEGIN SELECT RAISE(ABORT, 'notification retention boundary cannot be replaced'); END;
CREATE TRIGGER tr_notification_retention_update BEFORE UPDATE ON notification_retention
WHEN NEW.singleton IS NOT OLD.singleton OR NEW.coverage_start IS NOT OLD.coverage_start
  OR NEW.retained_after < OLD.retained_after
BEGIN SELECT RAISE(ABORT, 'notification retention must advance monotonically'); END;

CREATE TRIGGER tr_notification_validation_terminal AFTER UPDATE OF status ON jobs
WHEN NEW.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled', 'stale')
  AND OLD.status NOT IN ('succeeded', 'failed', 'dead_letter', 'cancelled', 'stale')
  AND EXISTS (SELECT 1 FROM review_run_job_links WHERE job_id = NEW.id)
  AND NOT EXISTS (SELECT 1 FROM notification_events WHERE source_kind = 'validation_job_terminal' AND source_id = NEW.id)
BEGIN
  INSERT INTO notification_repository_counters(repository_id)
  SELECT run.repository_id FROM review_run_job_links AS link JOIN review_runs AS run ON run.id = link.review_run_id
  WHERE link.job_id = NEW.id AND NOT EXISTS (
    SELECT 1 FROM notification_repository_counters WHERE repository_id = run.repository_id);
  INSERT INTO notification_events(id, repository_id, sequence, source_kind, source_id, occurred_at, recorded_at, recorded_day,
    work_item_id, work_item_kind, work_item_number, review_run_id, revision_key, request_id, job_id, job_activation,
    run_attempt_id, workflow_kind, target, outcome, summary_json)
  SELECT lower(hex(randomblob(16))), run.repository_id, counter.next_sequence + 1, 'validation_job_terminal', NEW.id,
    COALESCE(NEW.completed_at, NEW.updated_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%d', 'now'), run.work_item_id,
    json_extract(run.plan_json, '$.workItem.kind'), json_extract(run.plan_json, '$.workItem.number'), run.id,
    run.revision_key, link.request_id, NEW.id, link.activation_number,
    COALESCE(result.run_attempt_id, OLD.current_run_attempt_id), request.workflow_kind, request.target, NEW.status,
    CASE WHEN NEW.status = 'succeeded' THEN json_object(
      'resultId', result.id,
      'checks', json((SELECT json_object(
        'passed', COALESCE(SUM(json_extract(value, '$.outcome') = 'passed'), 0),
        'failed', COALESCE(SUM(json_extract(value, '$.outcome') = 'failed'), 0),
        'blocked', COALESCE(SUM(json_extract(value, '$.outcome') = 'blocked'), 0),
        'notRun', COALESCE(SUM(json_extract(value, '$.outcome') = 'not_run'), 0),
        'skipped', COALESCE(SUM(json_extract(value, '$.outcome') = 'skipped'), 0),
        'inconclusive', COALESCE(SUM(json_extract(value, '$.outcome') = 'inconclusive'), 0),
        'requiredNonPassed', COALESCE(SUM(json_extract(value, '$.required') = 1 AND json_extract(value, '$.outcome') != 'passed'), 0)
      ) FROM json_each(result.result_json, '$.report.checks'))),
      'blockerCount', json_array_length(result.result_json, '$.execution.blockers'),
      'sourceState', json_extract(result.result_json, '$.report.sourceState'),
      'cleanupState', json_extract(result.result_json, '$.execution.cleanupState'),
      'evidenceComplete', result.evidence_complete)
    ELSE json_object('attemptCount', NEW.attempt_count) END
  FROM review_run_job_links AS link JOIN review_runs AS run ON run.id = link.review_run_id
  JOIN review_run_requests AS request ON request.review_run_id = link.review_run_id AND request.request_id = link.request_id
  JOIN notification_repository_counters AS counter ON counter.repository_id = run.repository_id
  LEFT JOIN validation_job_results AS result ON result.job_id = NEW.id
  WHERE link.job_id = NEW.id;
END;

CREATE TRIGGER tr_notification_publication_outcome AFTER INSERT ON publication_attempt_events
WHEN json_extract(NEW.receipt_json, '$.phase') = 'outcome'
BEGIN
  INSERT INTO notification_repository_counters(repository_id) SELECT NEW.repository_id
  WHERE NOT EXISTS (SELECT 1 FROM notification_repository_counters WHERE repository_id = NEW.repository_id);
  INSERT INTO notification_events(id, repository_id, sequence, source_kind, source_id, occurred_at, recorded_at, recorded_day,
    work_item_id, work_item_kind, work_item_number, review_run_id, revision_key, publication_id, outcome, summary_json)
  SELECT lower(hex(randomblob(16))), NEW.repository_id, counter.next_sequence + 1, 'publication_attempt', NEW.id,
    json_extract(NEW.receipt_json, '$.createdAt'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%d', 'now'),
    json_extract(intent.intent_json, '$.binding.workItemId'), json_extract(intent.intent_json, '$.target.kind'),
    json_extract(intent.intent_json, '$.target.number'), intent.review_run_id,
    json_extract(intent.intent_json, '$.binding.revisionKey'), NEW.publication_id,
    json_extract(NEW.receipt_json, '$.outcome'), json_object(
      'attemptNumber', json_extract(NEW.receipt_json, '$.attemptNumber'),
      'attemptKind', json_extract(NEW.receipt_json, '$.kind'),
      'failureCode', json_extract(NEW.receipt_json, '$.failure.code'))
  FROM publication_intents AS intent JOIN notification_repository_counters AS counter ON counter.repository_id = intent.repository_id
  WHERE intent.publication_id = NEW.publication_id AND intent.repository_id = NEW.repository_id;
END;
