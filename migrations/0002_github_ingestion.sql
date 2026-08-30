CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  github_repository_id INTEGER NOT NULL UNIQUE CHECK (github_repository_id > 0),
  github_node_id TEXT NOT NULL UNIQUE,
  owner_login TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  html_url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  is_private INTEGER NOT NULL CHECK (is_private IN (0, 1)),
  snapshot_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('received', 'processed')),
  result_json TEXT
) STRICT;

CREATE INDEX ix_webhook_deliveries_received_at
  ON webhook_deliveries (received_at DESC);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories (id) ON DELETE RESTRICT,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('issue', 'pull_request')),
  github_work_item_id INTEGER NOT NULL UNIQUE CHECK (github_work_item_id > 0),
  github_node_id TEXT NOT NULL UNIQUE,
  github_number INTEGER NOT NULL CHECK (github_number > 0),
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  title TEXT NOT NULL,
  body TEXT,
  html_url TEXT NOT NULL,
  author_github_user_id INTEGER NOT NULL CHECK (author_github_user_id > 0),
  author_login TEXT NOT NULL,
  author_account_type TEXT NOT NULL CHECK (author_account_type IN ('user', 'bot', 'app')),
  current_revision_key TEXT NOT NULL,
  is_draft INTEGER CHECK (is_draft IN (0, 1)),
  source_created_at TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  source_closed_at TEXT,
  snapshot_json TEXT NOT NULL,
  projection_source TEXT NOT NULL CHECK (
    projection_source IN ('webhook', 'poll', 'reconciliation')
  ),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repository_id, github_number),
  CHECK (
    (resource_kind = 'issue' AND is_draft IS NULL)
    OR (resource_kind = 'pull_request' AND is_draft IS NOT NULL)
  )
) STRICT;

CREATE INDEX ix_work_items_repository_updated
  ON work_items (repository_id, updated_at DESC);

CREATE TABLE work_item_revisions (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items (id) ON DELETE RESTRICT,
  revision_key TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('issue', 'pull_request')),
  base_sha TEXT,
  head_sha TEXT,
  content_digest TEXT,
  source_updated_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  revision_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (work_item_id, revision_key),
  CHECK (
    (
      resource_kind = 'issue'
      AND base_sha IS NULL
      AND head_sha IS NULL
      AND content_digest IS NOT NULL
    )
    OR
    (
      resource_kind = 'pull_request'
      AND base_sha IS NOT NULL
      AND head_sha IS NOT NULL
      AND content_digest IS NULL
    )
  )
) STRICT;

CREATE INDEX ix_work_item_revisions_item_observed
  ON work_item_revisions (work_item_id, observed_at DESC);

CREATE TABLE github_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('webhook', 'poll', 'reconciliation')),
  source_event_id TEXT NOT NULL,
  webhook_delivery_id TEXT UNIQUE REFERENCES webhook_deliveries (delivery_id) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL REFERENCES repositories (id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items (id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL REFERENCES work_item_revisions (id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (
    action IN (
      'request_opened',
      'request_closed',
      'revision_observed',
      'work_item_closed',
      'work_item_reopened'
    )
  ),
  request_kind TEXT CHECK (request_kind IN ('assignment', 'review_request')),
  close_reason TEXT CHECK (
    close_reason IN ('assignment_removed', 'review_request_removed', 'work_item_closed')
  ),
  actor_github_user_id INTEGER,
  actor_login TEXT,
  target_github_user_id INTEGER,
  target_login TEXT,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  normalized_sha256 TEXT NOT NULL CHECK (
    length(normalized_sha256) = 64
    AND normalized_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  normalized_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (source, source_event_id),
  CHECK (
    (action IN ('request_opened', 'request_closed') AND request_kind IS NOT NULL)
    OR (
      action IN ('revision_observed', 'work_item_closed', 'work_item_reopened')
      AND request_kind IS NULL
    )
  ),
  CHECK (
    (action = 'request_closed' AND close_reason IN ('assignment_removed', 'review_request_removed'))
    OR (action = 'work_item_closed' AND close_reason = 'work_item_closed')
    OR (
      action IN ('request_opened', 'revision_observed', 'work_item_reopened')
      AND close_reason IS NULL
    )
  ),
  CHECK (
    (source = 'webhook' AND webhook_delivery_id IS NOT NULL)
    OR (source <> 'webhook' AND webhook_delivery_id IS NULL)
  )
) STRICT;

CREATE INDEX ix_github_events_work_item_occurred
  ON github_events (work_item_id, occurred_at DESC, created_at DESC);

CREATE TABLE authorization_decisions (
  id TEXT PRIMARY KEY,
  decision_key TEXT NOT NULL UNIQUE,
  github_event_id TEXT NOT NULL REFERENCES github_events (id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL REFERENCES work_items (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('authorized', 'denied')),
  basis TEXT CHECK (basis IN ('self', 'allowlist', 'active_epoch')),
  reason TEXT NOT NULL CHECK (
    reason IN (
      'authorized_self',
      'authorized_allowlisted',
      'inherited_active_epoch',
      'denied_event_not_request_open',
      'denied_work_item_closed',
      'denied_identity_mismatch',
      'denied_target_unknown',
      'denied_wrong_target',
      'denied_actor_unknown',
      'denied_actor_not_allowed',
      'denied_no_active_epoch',
      'denied_epoch_work_item_mismatch',
      'denied_revision_not_inheritable',
      'denied_revision_unchanged'
    )
  ),
  policy_kind TEXT NOT NULL CHECK (policy_kind = 'self_or_allowlist'),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  actor_github_user_id INTEGER,
  target_github_user_id INTEGER,
  inherited_from_epoch_id TEXT,
  evaluated_at TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  policy_sha256 TEXT NOT NULL CHECK (
    length(policy_sha256) = 64
    AND policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  decision_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (outcome = 'authorized' AND basis IS NOT NULL)
    OR (outcome = 'denied' AND basis IS NULL)
  )
) STRICT;

CREATE INDEX ix_authorization_decisions_work_item_evaluated
  ON authorization_decisions (work_item_id, evaluated_at DESC);

CREATE TABLE request_epochs (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items (id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  request_kind TEXT NOT NULL CHECK (request_kind IN ('assignment', 'review_request')),
  target_github_user_id INTEGER NOT NULL CHECK (target_github_user_id > 0),
  opening_event_id TEXT NOT NULL UNIQUE REFERENCES github_events (id) ON DELETE RESTRICT,
  authorization_decision_id TEXT NOT NULL UNIQUE
    REFERENCES authorization_decisions (id) ON DELETE RESTRICT,
  current_revision_id TEXT NOT NULL REFERENCES work_item_revisions (id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  opened_at TEXT NOT NULL,
  closing_event_id TEXT REFERENCES github_events (id) ON DELETE RESTRICT,
  close_reason TEXT CHECK (
    close_reason IN ('assignment_removed', 'review_request_removed', 'work_item_closed')
  ),
  closed_at TEXT,
  epoch_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_item_id, ordinal),
  CHECK (
    (status = 'active' AND closing_event_id IS NULL AND close_reason IS NULL AND closed_at IS NULL)
    OR
    (
      status = 'closed'
      AND closing_event_id IS NOT NULL
      AND close_reason IS NOT NULL
      AND closed_at IS NOT NULL
    )
  )
) STRICT;

CREATE UNIQUE INDEX ux_request_epochs_active_request
  ON request_epochs (work_item_id, request_kind, target_github_user_id)
  WHERE status = 'active';

CREATE INDEX ix_request_epochs_work_item_status
  ON request_epochs (work_item_id, status, opened_at DESC);

ALTER TABLE jobs
  ADD COLUMN request_epoch_id TEXT REFERENCES request_epochs (id) ON DELETE RESTRICT;

ALTER TABLE jobs
  ADD COLUMN source_event_id TEXT REFERENCES github_events (id) ON DELETE RESTRICT;

ALTER TABLE jobs
  ADD COLUMN execution_digest TEXT;

ALTER TABLE jobs
  ADD COLUMN required_capabilities_digest TEXT;

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
    AND required_capabilities_digest IS NOT NULL;

CREATE INDEX ix_jobs_work_item_created
  ON jobs (work_item_id, created_at DESC);

CREATE TABLE job_request_epochs (
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE RESTRICT,
  request_epoch_id TEXT NOT NULL REFERENCES request_epochs (id) ON DELETE RESTRICT,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (job_id, request_epoch_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_job_request_epochs_epoch
  ON job_request_epochs (request_epoch_id, job_id);

CREATE TRIGGER tr_authorization_decision_event_consistency
BEFORE INSERT ON authorization_decisions
WHEN NOT EXISTS (
  SELECT 1
  FROM github_events AS event
  WHERE event.id = NEW.github_event_id
    AND event.work_item_id = NEW.work_item_id
)
BEGIN
  SELECT RAISE(ABORT, 'authorization decision event/work-item mismatch');
END;

CREATE TRIGGER tr_authorization_decision_inherited_epoch_consistency
BEFORE INSERT ON authorization_decisions
WHEN
  (CASE WHEN NEW.basis = 'active_epoch' THEN 1 ELSE 0 END)
    <> (CASE WHEN NEW.inherited_from_epoch_id IS NOT NULL THEN 1 ELSE 0 END)
  OR (
    NEW.inherited_from_epoch_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM request_epochs AS epoch
      WHERE epoch.id = NEW.inherited_from_epoch_id
        AND epoch.work_item_id = NEW.work_item_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'authorization decision inherited-epoch mismatch');
END;

CREATE TRIGGER tr_request_epoch_insert_consistency
BEFORE INSERT ON request_epochs
WHEN
  NOT EXISTS (
    SELECT 1
    FROM github_events AS event
    WHERE event.id = NEW.opening_event_id
      AND event.work_item_id = NEW.work_item_id
      AND event.action = 'request_opened'
  )
  OR NOT EXISTS (
    SELECT 1
    FROM authorization_decisions AS decision
    WHERE decision.id = NEW.authorization_decision_id
      AND decision.github_event_id = NEW.opening_event_id
      AND decision.work_item_id = NEW.work_item_id
      AND decision.outcome = 'authorized'
      AND decision.basis IN ('self', 'allowlist')
  )
  OR NOT EXISTS (
    SELECT 1
    FROM work_item_revisions AS revision
    WHERE revision.id = NEW.current_revision_id
      AND revision.work_item_id = NEW.work_item_id
  )
BEGIN
  SELECT RAISE(ABORT, 'request epoch dependency mismatch');
END;

CREATE TRIGGER tr_request_epoch_revision_update_consistency
BEFORE UPDATE OF current_revision_id ON request_epochs
WHEN NOT EXISTS (
  SELECT 1
  FROM work_item_revisions AS revision
  WHERE revision.id = NEW.current_revision_id
    AND revision.work_item_id = NEW.work_item_id
)
BEGIN
  SELECT RAISE(ABORT, 'request epoch revision/work-item mismatch');
END;

CREATE TRIGGER tr_job_scheduling_links_consistency
BEFORE INSERT ON jobs
WHEN
  (
    NEW.request_epoch_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM request_epochs AS epoch
      WHERE epoch.id = NEW.request_epoch_id
        AND epoch.work_item_id = NEW.work_item_id
    )
  )
  OR (
    NEW.source_event_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM github_events AS event
      WHERE event.id = NEW.source_event_id
        AND event.work_item_id = NEW.work_item_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'job scheduling link/work-item mismatch');
END;

CREATE TRIGGER tr_job_request_epoch_link_consistency
BEFORE INSERT ON job_request_epochs
WHEN NOT EXISTS (
  SELECT 1
  FROM jobs AS job
  JOIN request_epochs AS epoch ON epoch.id = NEW.request_epoch_id
  WHERE job.id = NEW.job_id
    AND job.work_item_id = epoch.work_item_id
)
BEGIN
  SELECT RAISE(ABORT, 'job/request-epoch work-item mismatch');
END;
