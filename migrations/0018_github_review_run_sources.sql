CREATE TABLE github_review_run_sources (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE RESTRICT,
  current_revision_key TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  activated_at TEXT NOT NULL,
  FOREIGN KEY (work_item_id, current_revision_key)
    REFERENCES work_item_revisions(work_item_id, revision_key) ON DELETE RESTRICT
) STRICT;

-- Earlier source transitions were not numbered. Start the current projected activation at one;
-- subsequent observed changes are tracked even without profile bindings or execution authority.
INSERT INTO github_review_run_sources (work_item_id, current_revision_key, sequence, activated_at)
SELECT id, current_revision_key, 1, updated_at FROM work_items;

CREATE TRIGGER tr_github_review_run_source_insert BEFORE INSERT ON github_review_run_sources
WHEN NEW.sequence != 1 OR NOT EXISTS (
  SELECT 1 FROM work_items WHERE id = NEW.work_item_id AND current_revision_key = NEW.current_revision_key
)
BEGIN SELECT RAISE(ABORT, 'GitHub review run source must match its work item projection'); END;

CREATE TRIGGER tr_github_review_run_source_update BEFORE UPDATE ON github_review_run_sources
WHEN NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.current_revision_key IS OLD.current_revision_key
  OR NEW.sequence != OLD.sequence + 1
  OR NOT EXISTS (
    SELECT 1 FROM work_items WHERE id = NEW.work_item_id AND current_revision_key = NEW.current_revision_key
  )
BEGIN SELECT RAISE(ABORT, 'GitHub review run source changes require a new projected revision'); END;

CREATE TRIGGER tr_github_review_run_source_delete BEFORE DELETE ON github_review_run_sources
BEGIN SELECT RAISE(ABORT, 'GitHub review run source activations cannot be deleted'); END;

CREATE TABLE github_review_run_activations (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  request_epoch_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK (source_sequence BETWEEN 1 AND 9007199254740991),
  revision_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('legacy', 'review_run')),
  review_run_id TEXT UNIQUE REFERENCES review_runs(id) ON DELETE RESTRICT,
  legacy_job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (work_item_id, request_epoch_id, source_sequence),
  FOREIGN KEY (request_epoch_id, work_item_id) REFERENCES request_epochs(id, work_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (work_item_id, revision_key) REFERENCES work_item_revisions(work_item_id, revision_key) ON DELETE RESTRICT,
  CHECK ((mode = 'legacy' AND legacy_job_id IS NOT NULL AND review_run_id IS NULL)
    OR (mode = 'review_run' AND review_run_id IS NOT NULL AND legacy_job_id IS NULL))
) STRICT;

-- Preserve the first usable legacy execution for an already active request at migration time.
-- Configuring profiles later must not launch a second pipeline for that same activation.
INSERT INTO github_review_run_activations (
  work_item_id, request_epoch_id, source_sequence, revision_key, mode, review_run_id, legacy_job_id, created_at
)
SELECT work_item_id, request_epoch_id, 1, revision_key, 'legacy', NULL, job_id, created_at FROM (
  SELECT item.id AS work_item_id, epoch.id AS request_epoch_id, revision.revision_key,
    job.id AS job_id, job.created_at,
    ROW_NUMBER() OVER (PARTITION BY item.id, epoch.id ORDER BY job.created_at, job.rowid) AS ordinal
  FROM work_items AS item
  JOIN request_epochs AS epoch ON epoch.work_item_id = item.id AND epoch.status = 'active'
  JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id AND revision.revision_key = item.current_revision_key
  JOIN job_request_epochs AS link ON link.request_epoch_id = epoch.id
  JOIN jobs AS job ON job.id = link.job_id AND job.work_item_id = item.id AND job.resource_revision = revision.revision_key
  WHERE json_type(job.execution_json, '$.validation') IS NULL
    AND job.status NOT IN ('stale', 'cancelled', 'cancel_requested')
) WHERE ordinal = 1;

CREATE TRIGGER tr_github_review_run_activation_insert BEFORE INSERT ON github_review_run_activations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM github_review_run_sources AS source
    JOIN request_epochs AS epoch ON epoch.work_item_id = source.work_item_id
    JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id
    WHERE source.work_item_id = NEW.work_item_id AND source.sequence = NEW.source_sequence
      AND source.current_revision_key = NEW.revision_key AND epoch.id = NEW.request_epoch_id
      AND epoch.status = 'active' AND revision.revision_key = NEW.revision_key
  ) THEN RAISE(ABORT, 'GitHub review run activation requires the current authorized source') END;
  SELECT CASE WHEN NEW.mode = 'legacy' AND NOT EXISTS (
    SELECT 1 FROM jobs AS job JOIN job_request_epochs AS link ON link.job_id = job.id
    WHERE job.id = NEW.legacy_job_id AND job.work_item_id = NEW.work_item_id
      AND job.resource_revision = NEW.revision_key AND link.request_epoch_id = NEW.request_epoch_id
      AND json_type(job.execution_json, '$.validation') IS NULL
  ) THEN RAISE(ABORT, 'GitHub legacy activation job identity mismatch') END;
  SELECT CASE WHEN NEW.mode = 'review_run' AND NOT EXISTS (
    SELECT 1 FROM review_runs WHERE id = NEW.review_run_id AND work_item_id = NEW.work_item_id
      AND request_epoch_id = NEW.request_epoch_id AND revision_key = NEW.revision_key
      AND actor_issuer = 'urn:agentic-review:server' AND actor_subject = 'github-ingestion'
  ) THEN RAISE(ABORT, 'GitHub review run activation identity mismatch') END;
END;

CREATE TRIGGER tr_github_review_run_activation_update BEFORE UPDATE ON github_review_run_activations
BEGIN SELECT RAISE(ABORT, 'GitHub review run activation routing is immutable'); END;
CREATE TRIGGER tr_github_review_run_activation_delete BEFORE DELETE ON github_review_run_activations
BEGIN SELECT RAISE(ABORT, 'GitHub review run activation routing is immutable'); END;

CREATE TRIGGER tr_github_review_run_job_source BEFORE INSERT ON review_run_job_links
WHEN EXISTS (
  SELECT 1 FROM github_review_run_activations AS activation
  WHERE activation.mode = 'review_run' AND activation.review_run_id = NEW.review_run_id
) AND NOT EXISTS (
  SELECT 1 FROM github_review_run_activations AS activation
  JOIN github_review_run_sources AS source ON source.work_item_id = activation.work_item_id
  WHERE activation.mode = 'review_run' AND activation.review_run_id = NEW.review_run_id
    AND activation.source_sequence = source.sequence
    AND activation.revision_key = source.current_revision_key
)
BEGIN SELECT RAISE(ABORT, 'GitHub validation job belongs to an obsolete source activation'); END;
