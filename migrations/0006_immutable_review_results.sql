CREATE UNIQUE INDEX ux_run_attempts_review_result_identity
  ON run_attempts (id, job_id);

CREATE UNIQUE INDEX ux_jobs_review_result_identity
  ON jobs (id, work_item_id, job_kind, resource_revision);

CREATE UNIQUE INDEX ux_work_item_revisions_review_result_identity
  ON work_item_revisions (id, work_item_id, revision_key);

CREATE TABLE legacy_review_result_replays (
  run_attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  result_digest TEXT NOT NULL CHECK (
    length(result_digest) = 64
    AND length(CAST(result_digest AS BLOB)) = 64
    AND instr(result_digest, char(0)) = 0
    AND result_digest NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json)
    AND length(CAST(result_json AS BLOB)) <= 2097152
  ),
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (run_attempt_id, job_id)
    REFERENCES run_attempts (id, job_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

INSERT INTO legacy_review_result_replays (
  run_attempt_id,
  job_id,
  result_digest,
  result_json,
  recorded_at
)
SELECT
  attempt.id,
  attempt.job_id,
  attempt.result_digest,
  attempt.result_json,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM run_attempts AS attempt
JOIN jobs AS job ON job.id = attempt.job_id
WHERE attempt.status = 'succeeded'
  AND attempt.result_digest IS NOT NULL
  AND length(attempt.result_digest) = 64
  AND length(CAST(attempt.result_digest AS BLOB)) = 64
  AND instr(attempt.result_digest, char(0)) = 0
  AND attempt.result_digest NOT GLOB '*[^0-9a-f]*'
  AND attempt.result_json IS NOT NULL
  AND json_valid(attempt.result_json)
  AND length(CAST(attempt.result_json AS BLOB)) <= 2097152
  AND job.work_item_id IS NOT NULL
  AND job.request_epoch_id IS NOT NULL;

CREATE TRIGGER tr_legacy_review_result_replays_immutable_update
BEFORE UPDATE ON legacy_review_result_replays
BEGIN
  SELECT RAISE(ABORT, 'legacy review-result replay markers are immutable');
END;

CREATE TRIGGER tr_legacy_review_result_replays_immutable_insert
BEFORE INSERT ON legacy_review_result_replays
BEGIN
  SELECT RAISE(ABORT, 'legacy review-result replay markers are migration-only');
END;

CREATE TRIGGER tr_legacy_review_result_replays_immutable_delete
BEFORE DELETE ON legacy_review_result_replays
BEGIN
  SELECT RAISE(ABORT, 'legacy review-result replay markers are immutable');
END;

CREATE TABLE review_results (
  id TEXT PRIMARY KEY,
  run_attempt_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE,
  work_item_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('issue_triage', 'pull_request_review')),
  resource_revision TEXT NOT NULL,
  schema_id TEXT NOT NULL CHECK (schema_id IN ('IssueTriageV1', 'PrReviewPlanV1')),
  result_digest TEXT NOT NULL CHECK (
    length(result_digest) = 64
    AND length(CAST(result_digest AS BLOB)) = 64
    AND instr(result_digest, char(0)) = 0
    AND result_digest NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json)
    AND json_type(result_json) = 'object'
    AND length(CAST(result_json AS BLOB)) <= 2097152
  ),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 8192),
  requested_recipe_ids_json TEXT NOT NULL CHECK (
    json_valid(requested_recipe_ids_json)
    AND json_type(requested_recipe_ids_json) = 'array'
  ),
  output_schema_sha256 TEXT NOT NULL CHECK (
    length(output_schema_sha256) = 64
    AND length(CAST(output_schema_sha256 AS BLOB)) = 64
    AND instr(output_schema_sha256, char(0)) = 0
    AND output_schema_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  prompt_sha256 TEXT NOT NULL CHECK (
    length(prompt_sha256) = 64
    AND length(CAST(prompt_sha256 AS BLOB)) = 64
    AND instr(prompt_sha256, char(0)) = 0
    AND prompt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  allowed_recipe_ids_json TEXT NOT NULL CHECK (
    json_valid(allowed_recipe_ids_json)
    AND json_type(allowed_recipe_ids_json) = 'array'
  ),
  execution_template_sha256 TEXT NOT NULL CHECK (
    length(execution_template_sha256) = 64
    AND length(CAST(execution_template_sha256 AS BLOB)) = 64
    AND instr(execution_template_sha256, char(0)) = 0
    AND execution_template_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  execution_template_json TEXT NOT NULL CHECK (
    json_valid(execution_template_json)
    AND json_type(execution_template_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_attempt_id, job_id)
    REFERENCES run_attempts (id, job_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (job_id, work_item_id, job_kind, resource_revision)
    REFERENCES jobs (id, work_item_id, job_kind, resource_revision)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, work_item_id, resource_revision)
    REFERENCES work_item_revisions (id, work_item_id, revision_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (job_kind = 'issue_triage' AND schema_id = 'IssueTriageV1')
    OR (job_kind = 'pull_request_review' AND schema_id = 'PrReviewPlanV1')
  ),
  CHECK (json_extract(result_json, '$.schemaVersion') IS schema_id),
  CHECK (json_extract(result_json, '$.summary') IS summary),
  CHECK (
    json_type(result_json, '$.requestedRecipeIds') IS 'array'
    AND json(requested_recipe_ids_json)
      IS json(json_extract(result_json, '$.requestedRecipeIds'))
  )
) STRICT;

CREATE INDEX ix_review_results_work_item_created
  ON review_results (work_item_id, created_at DESC);

CREATE TABLE pr_review_results (
  review_result_id TEXT PRIMARY KEY
    REFERENCES review_results (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  assessment TEXT NOT NULL CHECK (assessment IN ('approve', 'comment', 'request_changes'))
) STRICT;

CREATE TABLE pr_review_findings (
  review_result_id TEXT NOT NULL
    REFERENCES pr_review_results (review_result_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
  finding_id TEXT NOT NULL CHECK (length(finding_id) BETWEEN 1 AND 128),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8192),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  line INTEGER NOT NULL CHECK (line BETWEEN 1 AND 10000000),
  end_line INTEGER CHECK (end_line IS NULL OR end_line BETWEEN line AND 10000000),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  PRIMARY KEY (review_result_id, finding_id),
  UNIQUE (review_result_id, ordinal)
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_pr_review_findings_priority
  ON pr_review_findings (review_result_id, priority, ordinal);

CREATE TABLE issue_triage_results (
  review_result_id TEXT PRIMARY KEY
    REFERENCES review_results (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  category TEXT NOT NULL CHECK (
    category IN ('bug', 'feature_request', 'documentation', 'question', 'support', 'other')
  ),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  suggested_labels_json TEXT NOT NULL CHECK (
    json_valid(suggested_labels_json)
    AND json_type(suggested_labels_json) = 'array'
  ),
  missing_information_json TEXT NOT NULL CHECK (
    json_valid(missing_information_json)
    AND json_type(missing_information_json) = 'array'
  ),
  duplicate_candidates_json TEXT NOT NULL CHECK (
    json_valid(duplicate_candidates_json)
    AND json_type(duplicate_candidates_json) = 'array'
  )
) STRICT;

CREATE TRIGGER tr_review_result_insert_consistency
BEFORE INSERT ON review_results
WHEN
  NOT EXISTS (
    SELECT 1
    FROM run_attempts AS attempt
    JOIN jobs AS job ON job.id = attempt.job_id
    JOIN work_items AS item ON item.id = job.work_item_id
    JOIN work_item_revisions AS revision
      ON revision.id = NEW.revision_id
      AND revision.work_item_id = job.work_item_id
      AND revision.revision_key = job.resource_revision
    WHERE attempt.id = NEW.run_attempt_id
      AND attempt.job_id = NEW.job_id
      AND attempt.status = 'succeeded'
      AND attempt.result_digest = NEW.result_digest
      AND attempt.result_json = NEW.result_json
      AND job.id = NEW.job_id
      AND job.work_item_id = NEW.work_item_id
      AND job.job_kind = NEW.job_kind
      AND job.resource_revision = NEW.resource_revision
      AND job.current_run_attempt_id = NEW.run_attempt_id
      AND job.status IN ('leased', 'running')
      AND job.request_epoch_id IS NOT NULL
      AND job.execution_digest = NEW.execution_template_sha256
      AND job.execution_json = NEW.execution_template_json
      AND json_extract(job.execution_json, '$.prompt.promptSha256') = NEW.prompt_sha256
      AND json_extract(job.execution_json, '$.prompt.outputSchemaSha256') = NEW.output_schema_sha256
      AND json(NEW.allowed_recipe_ids_json)
        IS json(json_extract(job.execution_json, '$.executionPolicy.allowedRecipeIds'))
      AND (
        (
          NEW.job_kind = 'issue_triage'
          AND item.resource_kind = 'issue'
          AND revision.resource_kind = 'issue'
        )
        OR (
          NEW.job_kind = 'pull_request_review'
          AND item.resource_kind = 'pull_request'
          AND revision.resource_kind = 'pull_request'
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'review result dependency mismatch');
END;

CREATE TRIGGER tr_pr_review_result_insert_consistency
BEFORE INSERT ON pr_review_results
WHEN NOT EXISTS (
  SELECT 1
  FROM review_results AS result
  JOIN jobs AS job ON job.id = result.job_id
  WHERE result.id = NEW.review_result_id
    AND result.job_kind = 'pull_request_review'
    AND result.schema_id = 'PrReviewPlanV1'
    AND job.status IN ('leased', 'running')
    AND job.current_run_attempt_id = result.run_attempt_id
)
OR NEW.assessment IS NOT (
  SELECT json_extract(result_json, '$.assessment')
  FROM review_results
  WHERE id = NEW.review_result_id
)
BEGIN
  SELECT RAISE(ABORT, 'PR review projection/result mismatch');
END;

CREATE TRIGGER tr_pr_review_finding_insert_consistency
BEFORE INSERT ON pr_review_findings
WHEN NOT EXISTS (
  SELECT 1
  FROM pr_review_results AS projection
  JOIN review_results AS result ON result.id = projection.review_result_id
  JOIN jobs AS job ON job.id = result.job_id
  WHERE projection.review_result_id = NEW.review_result_id
    AND job.status IN ('leased', 'running')
    AND job.current_run_attempt_id = result.run_attempt_id
)
OR NOT EXISTS (
  SELECT 1
  FROM review_results AS result,
    json_each(result.result_json, '$.findings') AS finding
  WHERE result.id = NEW.review_result_id
    AND CAST(finding.key AS INTEGER) = NEW.ordinal
    AND json_extract(finding.value, '$.findingId') IS NEW.finding_id
    AND json_extract(finding.value, '$.priority') IS NEW.priority
    AND json_extract(finding.value, '$.title') IS NEW.title
    AND json_extract(finding.value, '$.body') IS NEW.body
    AND json_extract(finding.value, '$.path') IS NEW.path
    AND json_extract(finding.value, '$.line') IS NEW.line
    AND json_extract(finding.value, '$.endLine') IS NEW.end_line
    AND json_extract(finding.value, '$.confidence') IS NEW.confidence
)
BEGIN
  SELECT RAISE(ABORT, 'PR finding/result mismatch');
END;

CREATE TRIGGER tr_issue_triage_result_insert_consistency
BEFORE INSERT ON issue_triage_results
WHEN NOT EXISTS (
  SELECT 1
  FROM review_results AS result
  JOIN jobs AS job ON job.id = result.job_id
  WHERE result.id = NEW.review_result_id
    AND result.job_kind = 'issue_triage'
    AND result.schema_id = 'IssueTriageV1'
    AND job.status IN ('leased', 'running')
    AND job.current_run_attempt_id = result.run_attempt_id
)
OR NOT EXISTS (
  SELECT 1
  FROM review_results AS result
  WHERE result.id = NEW.review_result_id
    AND json_extract(result.result_json, '$.category') IS NEW.category
    AND json_extract(result.result_json, '$.priority') IS NEW.priority
    AND json_extract(result.result_json, '$.confidence') IS NEW.confidence
    AND json(json_extract(result.result_json, '$.suggestedLabels'))
      IS json(NEW.suggested_labels_json)
    AND json(json_extract(result.result_json, '$.missingInformation'))
      IS json(NEW.missing_information_json)
    AND json(json_extract(result.result_json, '$.duplicateCandidates'))
      IS json(NEW.duplicate_candidates_json)
)
BEGIN
  SELECT RAISE(ABORT, 'issue triage projection/result mismatch');
END;

CREATE TRIGGER tr_job_success_review_result_consistency
BEFORE UPDATE OF status ON jobs
WHEN NEW.status = 'succeeded'
  AND OLD.status <> 'succeeded'
  AND NEW.work_item_id IS NOT NULL
  AND NEW.request_epoch_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM review_results AS result
    WHERE result.job_id = NEW.id
      AND result.run_attempt_id = OLD.current_run_attempt_id
      AND result.work_item_id = NEW.work_item_id
      AND result.job_kind = NEW.job_kind
      AND (
        (
          NEW.job_kind = 'pull_request_review'
          AND EXISTS (
            SELECT 1 FROM pr_review_results
            WHERE review_result_id = result.id
          )
          AND (
            SELECT COUNT(*)
            FROM pr_review_findings
            WHERE review_result_id = result.id
          ) = json_array_length(result.result_json, '$.findings')
        )
        OR (
          NEW.job_kind = 'issue_triage'
          AND EXISTS (
            SELECT 1 FROM issue_triage_results
            WHERE review_result_id = result.id
          )
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'succeeded job requires a complete immutable review result');
END;

CREATE TRIGGER tr_review_results_immutable_update
BEFORE UPDATE ON review_results
BEGIN
  SELECT RAISE(ABORT, 'review results are immutable');
END;

CREATE TRIGGER tr_review_results_immutable_delete
BEFORE DELETE ON review_results
BEGIN
  SELECT RAISE(ABORT, 'review results are immutable');
END;

CREATE TRIGGER tr_pr_review_results_immutable_update
BEFORE UPDATE ON pr_review_results
BEGIN
  SELECT RAISE(ABORT, 'PR review projections are immutable');
END;

CREATE TRIGGER tr_pr_review_results_immutable_delete
BEFORE DELETE ON pr_review_results
BEGIN
  SELECT RAISE(ABORT, 'PR review projections are immutable');
END;

CREATE TRIGGER tr_pr_review_findings_immutable_update
BEFORE UPDATE ON pr_review_findings
BEGIN
  SELECT RAISE(ABORT, 'PR review findings are immutable');
END;

CREATE TRIGGER tr_pr_review_findings_immutable_delete
BEFORE DELETE ON pr_review_findings
BEGIN
  SELECT RAISE(ABORT, 'PR review findings are immutable');
END;

CREATE TRIGGER tr_issue_triage_results_immutable_update
BEFORE UPDATE ON issue_triage_results
BEGIN
  SELECT RAISE(ABORT, 'issue triage projections are immutable');
END;

CREATE TRIGGER tr_issue_triage_results_immutable_delete
BEFORE DELETE ON issue_triage_results
BEGIN
  SELECT RAISE(ABORT, 'issue triage projections are immutable');
END;

CREATE TRIGGER tr_github_review_job_scheduling_identity_immutable
BEFORE UPDATE OF
  work_item_id,
  request_epoch_id,
  source_event_id,
  job_kind,
  resource_revision,
  execution_json,
  execution_digest,
  required_capabilities_json,
  required_capabilities_digest
ON jobs
WHEN OLD.work_item_id IS NOT NULL
  AND OLD.request_epoch_id IS NOT NULL
  AND (
    NEW.work_item_id IS NOT OLD.work_item_id
    OR NEW.request_epoch_id IS NOT OLD.request_epoch_id
    OR NEW.source_event_id IS NOT OLD.source_event_id
    OR NEW.job_kind IS NOT OLD.job_kind
    OR NEW.resource_revision IS NOT OLD.resource_revision
    OR NEW.execution_json IS NOT OLD.execution_json
    OR NEW.execution_digest IS NOT OLD.execution_digest
    OR NEW.required_capabilities_json IS NOT OLD.required_capabilities_json
    OR NEW.required_capabilities_digest IS NOT OLD.required_capabilities_digest
  )
BEGIN
  SELECT RAISE(ABORT, 'GitHub review scheduling identity is immutable');
END;

CREATE TRIGGER tr_run_attempt_completed_review_identity_immutable
BEFORE UPDATE OF status, result_digest, result_json ON run_attempts
WHEN (
  EXISTS (
    SELECT 1 FROM review_results WHERE run_attempt_id = OLD.id
  )
  OR EXISTS (
    SELECT 1 FROM legacy_review_result_replays WHERE run_attempt_id = OLD.id
  )
)
AND (
  NEW.status <> OLD.status
  OR NEW.result_digest IS NOT OLD.result_digest
  OR NEW.result_json IS NOT OLD.result_json
)
BEGIN
  SELECT RAISE(ABORT, 'completed review attempt result is immutable');
END;

CREATE TRIGGER tr_work_item_revision_completed_review_identity_immutable
BEFORE UPDATE OF
  work_item_id,
  revision_key,
  resource_kind,
  base_sha,
  head_sha,
  content_digest,
  revision_json
ON work_item_revisions
WHEN EXISTS (
  SELECT 1 FROM review_results WHERE revision_id = OLD.id
)
AND (
  NEW.work_item_id <> OLD.work_item_id
  OR NEW.revision_key <> OLD.revision_key
  OR NEW.resource_kind <> OLD.resource_kind
  OR NEW.base_sha IS NOT OLD.base_sha
  OR NEW.head_sha IS NOT OLD.head_sha
  OR NEW.content_digest IS NOT OLD.content_digest
  OR NEW.revision_json <> OLD.revision_json
)
BEGIN
  SELECT RAISE(ABORT, 'completed review revision identity is immutable');
END;
