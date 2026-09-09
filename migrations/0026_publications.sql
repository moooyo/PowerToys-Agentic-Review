CREATE TABLE publication_policies (
  repository_id TEXT PRIMARY KEY REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB)) <= 16384)
) STRICT;

CREATE TABLE publication_policy_events (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  change_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 32768),
  UNIQUE (repository_id, change_id),
  UNIQUE (repository_id, version)
) STRICT;

CREATE TABLE publication_intents (
  publication_id TEXT PRIMARY KEY CHECK (length(publication_id) BETWEEN 1 AND 128),
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE RESTRICT,
  selected_decision_id TEXT NOT NULL REFERENCES review_run_decision_events(id) ON DELETE RESTRICT,
  renderer_version TEXT NOT NULL,
  confirmation_change_id TEXT NOT NULL,
  confirmation_intent_digest TEXT NOT NULL CHECK (length(confirmation_intent_digest) = 64),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json) AND length(CAST(intent_json AS BLOB)) <= 524288),
  created_at TEXT NOT NULL,
  UNIQUE (repository_id, confirmation_change_id),
  UNIQUE (repository_id, review_run_id, selected_decision_id, renderer_version)
) STRICT;

CREATE TABLE publication_states (
  publication_id TEXT PRIMARY KEY REFERENCES publication_intents(publication_id) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'published', 'failed', 'blocked', 'unknown', 'cancelled')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json) AND length(CAST(state_json AS BLOB)) <= 32768),
  fence INTEGER NOT NULL DEFAULT 0 CHECK (fence BETWEEN 0 AND 9007199254740991),
  lease_owner TEXT,
  lease_kind TEXT CHECK (lease_kind IS NULL OR lease_kind IN ('delivery', 'reconciliation')),
  lease_expires_at TEXT,
  send_started_at TEXT,
  reconciliation_requested INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_requested IN (0, 1)),
  reconciliation_event_id TEXT REFERENCES publication_change_events(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL DEFAULT 0 CHECK (attempt_number BETWEEN 0 AND 9007199254740991),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((lease_owner IS NULL) = (lease_kind IS NULL)),
  CHECK (send_started_at IS NULL OR status IN ('delivering', 'unknown', 'published', 'failed'))
) STRICT;
CREATE INDEX ix_publication_pending ON publication_states(status, publication_id);
CREATE INDEX ix_publication_repository ON publication_intents(repository_id, created_at DESC, publication_id);

CREATE TABLE publication_change_events (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  publication_id TEXT NOT NULL REFERENCES publication_intents(publication_id) ON DELETE RESTRICT,
  change_id TEXT NOT NULL,
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 524288),
  UNIQUE (repository_id, change_id)
) STRICT;

CREATE TABLE publication_attempt_events (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES publication_intents(publication_id) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 32768),
  UNIQUE (publication_id, sequence)
) STRICT;

CREATE TRIGGER tr_publication_intent_no_update BEFORE UPDATE ON publication_intents
BEGIN SELECT RAISE(ABORT, 'publication intent is immutable'); END;
CREATE TRIGGER tr_publication_intent_no_delete BEFORE DELETE ON publication_intents
BEGIN SELECT RAISE(ABORT, 'publication intent is immutable'); END;
CREATE TRIGGER tr_publication_policy_event_no_update BEFORE UPDATE ON publication_policy_events
BEGIN SELECT RAISE(ABORT, 'publication policy history is immutable'); END;
CREATE TRIGGER tr_publication_policy_event_no_delete BEFORE DELETE ON publication_policy_events
BEGIN SELECT RAISE(ABORT, 'publication policy history is immutable'); END;
CREATE TRIGGER tr_publication_change_no_update BEFORE UPDATE ON publication_change_events
BEGIN SELECT RAISE(ABORT, 'publication changes are immutable'); END;
CREATE TRIGGER tr_publication_change_no_delete BEFORE DELETE ON publication_change_events
BEGIN SELECT RAISE(ABORT, 'publication changes are immutable'); END;
CREATE TRIGGER tr_publication_attempt_no_update BEFORE UPDATE ON publication_attempt_events
BEGIN SELECT RAISE(ABORT, 'publication attempt history is immutable'); END;
CREATE TRIGGER tr_publication_attempt_no_delete BEFORE DELETE ON publication_attempt_events
BEGIN SELECT RAISE(ABORT, 'publication attempt history is immutable'); END;
CREATE TRIGGER tr_publication_policy_no_delete BEFORE DELETE ON publication_policies
BEGIN SELECT RAISE(ABORT, 'publication policy history must be retained'); END;
CREATE TRIGGER tr_publication_state_no_delete BEFORE DELETE ON publication_states
BEGIN SELECT RAISE(ABORT, 'publication state must be retained'); END;

CREATE TRIGGER tr_publication_intent_insert BEFORE INSERT ON publication_intents
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM publication_intents WHERE publication_id=NEW.publication_id
    OR (repository_id=NEW.repository_id AND confirmation_change_id=NEW.confirmation_change_id)
    OR (repository_id=NEW.repository_id AND review_run_id=NEW.review_run_id AND selected_decision_id=NEW.selected_decision_id AND renderer_version=NEW.renderer_version))
    THEN RAISE(ABORT, 'publication intents cannot be replaced') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM review_run_decision_events AS decision JOIN review_runs AS run ON run.id=decision.review_run_id
    WHERE decision.id=NEW.selected_decision_id AND decision.repository_id=NEW.repository_id AND run.repository_id=NEW.repository_id AND run.id=NEW.review_run_id)
    THEN RAISE(ABORT, 'publication decision scope is invalid') END;
  SELECT CASE WHEN json_extract(NEW.intent_json, '$.publicationId') IS NOT NEW.publication_id
    OR json_extract(NEW.intent_json, '$.binding.repositoryId') IS NOT NEW.repository_id
    OR json_extract(NEW.intent_json, '$.binding.reviewRunId') IS NOT NEW.review_run_id
    OR json_extract(NEW.intent_json, '$.binding.selectedDecisionId') IS NOT NEW.selected_decision_id
    OR json_extract(NEW.intent_json, '$.confirmationChangeId') IS NOT NEW.confirmation_change_id
    THEN RAISE(ABORT, 'publication intent binding is invalid') END;
END;
CREATE TRIGGER tr_publication_policy_event_insert BEFORE INSERT ON publication_policy_events
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM publication_policy_events WHERE id=NEW.id
    OR (repository_id=NEW.repository_id AND (change_id=NEW.change_id OR version=NEW.version)))
    THEN RAISE(ABORT, 'publication policy events cannot be replaced') END;
  SELECT CASE WHEN NEW.version != COALESCE((SELECT MAX(version) FROM publication_policy_events WHERE repository_id=NEW.repository_id),0)+1
    THEN RAISE(ABORT, 'publication policy event does not follow its stream') END;
END;
CREATE TRIGGER tr_publication_change_insert BEFORE INSERT ON publication_change_events
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM publication_change_events WHERE id=NEW.id OR (repository_id=NEW.repository_id AND change_id=NEW.change_id))
    THEN RAISE(ABORT, 'publication changes cannot be replaced') END;
END;
CREATE TRIGGER tr_publication_attempt_insert BEFORE INSERT ON publication_attempt_events
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM publication_attempt_events WHERE id=NEW.id OR (publication_id=NEW.publication_id AND sequence=NEW.sequence))
    THEN RAISE(ABORT, 'publication attempts cannot be replaced') END;
  SELECT CASE WHEN NEW.sequence != COALESCE((SELECT MAX(sequence) FROM publication_attempt_events WHERE publication_id=NEW.publication_id),0)+1
    THEN RAISE(ABORT, 'publication attempt does not follow its stream') END;
END;
CREATE TRIGGER tr_publication_state_transition BEFORE UPDATE ON publication_states
BEGIN
  SELECT CASE WHEN NEW.publication_id IS NOT OLD.publication_id OR NEW.repository_id IS NOT OLD.repository_id
    OR NEW.version NOT IN (OLD.version,OLD.version+1) OR NEW.fence < OLD.fence
    OR (NEW.version=OLD.version AND (NEW.state_json IS NOT OLD.state_json OR NEW.status IS NOT OLD.status OR NEW.attempt_number IS NOT OLD.attempt_number))
    THEN RAISE(ABORT, 'publication delivery version is invalid') END;
  SELECT CASE WHEN NEW.status != OLD.status AND NOT (
    (OLD.status='pending' AND NEW.status IN ('delivering','cancelled'))
    OR (OLD.status='delivering' AND NEW.status IN ('published','failed','blocked','unknown'))
    OR (OLD.status IN ('failed','blocked') AND NEW.status IN ('pending','cancelled'))
    OR (OLD.status='unknown' AND NEW.status='published'))
    THEN RAISE(ABORT, 'publication delivery transition is invalid') END;
END;
CREATE TRIGGER tr_publication_policy_insert BEFORE INSERT ON publication_policies
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM publication_policies WHERE repository_id=NEW.repository_id)
    THEN RAISE(ABORT, 'publication policies cannot be replaced') END;
END;
CREATE TRIGGER tr_publication_state_insert BEFORE INSERT ON publication_states
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM publication_states WHERE publication_id=NEW.publication_id)
    THEN RAISE(ABORT, 'publication states cannot be replaced') END;
  SELECT CASE WHEN NEW.repository_id IS NOT (SELECT repository_id FROM publication_intents WHERE publication_id=NEW.publication_id)
    THEN RAISE(ABORT, 'publication state scope is invalid') END;
END;
