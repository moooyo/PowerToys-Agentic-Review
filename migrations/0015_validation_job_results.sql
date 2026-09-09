-- Validation results retain their frozen workflow identity without reinterpreting
-- or rewriting the legacy review result tables.
CREATE TABLE validation_job_results (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  run_attempt_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('issue_triage', 'pull_request_review')),
  resource_revision TEXT NOT NULL,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  activation_id TEXT NOT NULL CHECK (length(activation_id) BETWEEN 1 AND 128),
  job_activation INTEGER NOT NULL CHECK (job_activation BETWEEN 1 AND 9007199254740991),
  workflow_kind TEXT NOT NULL CHECK (workflow_kind IN ('pr_static_build', 'pr_ui', 'issue_triage', 'issue_validation')),
  target TEXT NOT NULL CHECK (target IN ('headless', 'windows_desktop', 'web')),
  plan_digest TEXT NOT NULL CHECK (
    length(plan_digest) = 64 AND length(CAST(plan_digest AS BLOB)) = 64
    AND instr(plan_digest, char(0)) = 0 AND plan_digest NOT GLOB '*[^0-9a-f]*'
  ),
  prompt_version_id TEXT NOT NULL REFERENCES prompt_versions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  profile_version_id TEXT NOT NULL REFERENCES validation_profile_versions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  schema_id TEXT NOT NULL CHECK (schema_id = 'ValidationJobResultV1'),
  result_digest TEXT NOT NULL CHECK (
    length(result_digest) = 64 AND length(CAST(result_digest AS BLOB)) = 64
    AND instr(result_digest, char(0)) = 0 AND result_digest NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json) AND json_type(result_json) = 'object'
    AND length(CAST(result_json AS BLOB)) <= 2097152
  ),
  execution_template_sha256 TEXT NOT NULL CHECK (
    length(execution_template_sha256) = 64 AND length(CAST(execution_template_sha256 AS BLOB)) = 64
    AND instr(execution_template_sha256, char(0)) = 0
    AND execution_template_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_complete INTEGER NOT NULL CHECK (evidence_complete IN (0, 1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_attempt_id, job_id)
    REFERENCES run_attempts (id, job_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (job_id, work_item_id, job_kind, resource_revision)
    REFERENCES jobs (id, work_item_id, job_kind, resource_revision)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (work_item_id, repository_id)
    REFERENCES work_items (id, repository_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, work_item_id, resource_revision)
    REFERENCES work_item_revisions (id, work_item_id, revision_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (review_run_id, request_id, job_activation)
    REFERENCES review_run_job_links (review_run_id, request_id, activation_number)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (json_extract(result_json, '$.schemaVersion') IS schema_id),
  CHECK (json_type(result_json, '$.report') IS 'object'),
  CHECK (json_extract(result_json, '$.report.schemaVersion') IS 'ValidationReportV1'),
  CHECK (json_extract(result_json, '$.report.source') IS 'worker'),
  CHECK (
    json_type(result_json, '$.report.summary') IS 'text'
    AND length(json_extract(
      replace(replace(json_quote(json_extract(result_json, '$.report.summary')), '\\', ' '), '\u0000', ' '),
      '$'
    )) BETWEEN 1 AND 8192
    AND json_type(result_json, '$.report.sourceState') IS 'text'
    AND json_extract(result_json, '$.report.sourceState') IN ('original', 'modified', 'unknown')
    AND json_type(result_json, '$.report.checks') IS 'array'
    AND json_array_length(result_json, '$.report.checks') <= 160
  ),
  CHECK (
    json_type(result_json, '$.execution') IS 'object'
    AND json_type(result_json, '$.execution.blockers') IS 'array'
    AND json_array_length(result_json, '$.execution.blockers') <= 160
    AND json_type(result_json, '$.execution.diagnostics') IS 'array'
    AND json_array_length(result_json, '$.execution.diagnostics') <= 192
    AND json_type(result_json, '$.execution.cleanupState') IS 'text'
    AND json_extract(result_json, '$.execution.cleanupState') IN ('completed', 'failed', 'not_needed')
  ),
  CHECK (
    json_type(result_json, '$.modelReview') IS 'object'
    AND CASE json_extract(result_json, '$.modelReview.state')
      WHEN 'not_requested' THEN 1
      WHEN 'failed' THEN
        json_type(result_json, '$.modelReview.code') IS 'text'
        AND length(json_extract(result_json, '$.modelReview.code')) BETWEEN 1 AND 128
        AND instr(json_extract(result_json, '$.modelReview.code'), char(0)) = 0
        AND json_extract(result_json, '$.modelReview.code') GLOB '[A-Z]*'
        AND json_extract(result_json, '$.modelReview.code') NOT GLOB '*[^A-Z0-9_]*'
        AND json_type(result_json, '$.modelReview.message') IS 'text'
        AND length(json_extract(
          replace(replace(json_quote(json_extract(result_json, '$.modelReview.message')), '\\', ' '), '\u0000', ' '),
          '$'
        )) BETWEEN 1 AND 2048
      WHEN 'completed' THEN
        json_type(result_json, '$.modelReview.result') IS 'object'
        AND json_extract(result_json, '$.modelReview.result.schemaVersion') IS CASE job_kind
          WHEN 'pull_request_review' THEN 'PrReviewPlanV2' ELSE 'IssueTriageV2' END
      ELSE 0
    END
  ),
  CHECK (
    (job_kind = 'pull_request_review'
      AND workflow_kind IN ('pr_static_build', 'pr_ui')
      AND json_extract(result_json, '$.report.workItemKind') IS 'pull_request')
    OR (job_kind = 'issue_triage'
      AND workflow_kind IN ('issue_triage', 'issue_validation')
      AND json_extract(result_json, '$.report.workItemKind') IS 'issue'
      AND json_type(result_json, '$.report.reproductionConclusion') IS 'text'
      AND json_extract(result_json, '$.report.reproductionConclusion')
        IN ('confirmed', 'not_reproduced', 'needs_information', 'blocked', 'inconclusive'))
  ),
  CHECK (workflow_kind = 'issue_validation'
    OR (workflow_kind = 'pr_ui' AND target IN ('windows_desktop', 'web'))
    OR (workflow_kind IN ('pr_static_build', 'issue_triage') AND target = 'headless'))
) STRICT;

CREATE INDEX ix_validation_job_results_work_item_created
  ON validation_job_results (repository_id, work_item_id, created_at DESC, id DESC);
CREATE INDEX ix_validation_job_results_review_run
  ON validation_job_results (review_run_id, request_id, job_activation);

CREATE TRIGGER tr_validation_job_result_insert_consistency
BEFORE INSERT ON validation_job_results
WHEN NOT EXISTS (
  SELECT 1
  FROM run_attempts AS attempt
  JOIN jobs AS job ON job.id = attempt.job_id
  JOIN work_items AS item ON item.id = job.work_item_id
  JOIN work_item_revisions AS revision
    ON revision.id = NEW.revision_id
    AND revision.work_item_id = job.work_item_id
    AND revision.revision_key = job.resource_revision
  JOIN review_run_job_links AS link ON link.job_id = job.id
  JOIN review_runs AS run ON run.id = link.review_run_id
  JOIN review_run_requests AS request
    ON request.review_run_id = link.review_run_id AND request.request_id = link.request_id
  WHERE attempt.id = NEW.run_attempt_id
    AND attempt.job_id = NEW.job_id AND attempt.status = 'succeeded'
    AND attempt.result_digest IS NEW.result_digest
    AND CAST(attempt.result_json AS BLOB) IS CAST(NEW.result_json AS BLOB)
    AND job.id = NEW.job_id AND job.work_item_id = NEW.work_item_id
    AND job.job_kind = NEW.job_kind AND job.resource_revision = NEW.resource_revision
    AND job.current_run_attempt_id = NEW.run_attempt_id
    AND job.status IN ('leased', 'running')
    AND job.request_epoch_id = run.request_epoch_id
    AND job.execution_digest IS NEW.execution_template_sha256
    AND item.repository_id = NEW.repository_id
    AND item.resource_kind = json_extract(NEW.result_json, '$.report.workItemKind')
    AND revision.resource_kind = item.resource_kind
    AND link.review_run_id = NEW.review_run_id AND link.request_id = NEW.request_id
    AND link.activation_number = NEW.job_activation
    AND run.repository_id = NEW.repository_id AND run.work_item_id = NEW.work_item_id
    AND run.revision_id = NEW.revision_id AND run.revision_key = NEW.resource_revision
    AND run.activation_id = NEW.activation_id AND run.plan_digest = NEW.plan_digest
    AND request.workflow_kind = NEW.workflow_kind AND request.target = NEW.target
    AND request.prompt_version_id = NEW.prompt_version_id
    AND request.profile_version_id = NEW.profile_version_id
    AND json_extract(job.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV1'
    AND json_extract(job.execution_json, '$.validation.runId') IS NEW.review_run_id
    AND json_extract(job.execution_json, '$.validation.requestId') IS NEW.request_id
    AND json_extract(job.execution_json, '$.validation.activationId') IS NEW.activation_id
    AND json_extract(job.execution_json, '$.validation.jobActivation') IS NEW.job_activation
    AND json_extract(job.execution_json, '$.validation.repositoryId') IS NEW.repository_id
    AND json_extract(job.execution_json, '$.validation.workItemId') IS NEW.work_item_id
    AND json_extract(job.execution_json, '$.validation.revisionKey') IS NEW.resource_revision
    AND json_extract(job.execution_json, '$.validation.requestEpochId') IS run.request_epoch_id
    AND json_extract(job.execution_json, '$.validation.planDigest') IS NEW.plan_digest
    AND json_extract(job.execution_json, '$.validation.workflowKind') IS NEW.workflow_kind
    AND json_extract(job.execution_json, '$.validation.target') IS NEW.target
    AND json_extract(job.execution_json, '$.validation.required') IS request.required
    AND json_extract(job.execution_json, '$.validation.promptVersion.id') IS NEW.prompt_version_id
    AND json_extract(job.execution_json, '$.validation.profileVersion.id') IS NEW.profile_version_id
)
OR EXISTS (
  SELECT 1 FROM review_results WHERE job_id = NEW.job_id OR run_attempt_id = NEW.run_attempt_id
)
-- Reject REPLACE before SQLite can silently delete an existing immutable result.
OR EXISTS (
  SELECT 1 FROM validation_job_results
  WHERE id = NEW.id OR job_id = NEW.job_id OR run_attempt_id = NEW.run_attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'validation result dependency mismatch');
END;

-- A validation job must never complete through the legacy projection path.
CREATE TRIGGER tr_review_result_reject_validation_job
BEFORE INSERT ON review_results
WHEN EXISTS (
  SELECT 1 FROM jobs WHERE id = NEW.job_id
    AND json_type(execution_json, '$.validation') IS NOT NULL
)
OR EXISTS (
  SELECT 1 FROM validation_job_results
  WHERE job_id = NEW.job_id OR run_attempt_id = NEW.run_attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'validation jobs require a validation result');
END;

DROP TRIGGER tr_job_success_review_result_consistency;

CREATE TRIGGER tr_job_success_review_result_consistency
BEFORE UPDATE OF status ON jobs
WHEN NEW.status = 'succeeded'
  AND OLD.status <> 'succeeded'
  AND (
    (NEW.work_item_id IS NOT NULL AND NEW.request_epoch_id IS NOT NULL)
    OR json_type(OLD.execution_json, '$.validation') IS NOT NULL
    OR json_type(NEW.execution_json, '$.validation') IS NOT NULL
    OR EXISTS (SELECT 1 FROM review_run_job_links WHERE job_id = OLD.id OR job_id = NEW.id)
  )
  AND NOT (
    (
      json_type(OLD.execution_json, '$.validation') IS NULL
      AND json_type(NEW.execution_json, '$.validation') IS NULL
      AND NOT EXISTS (SELECT 1 FROM review_run_job_links WHERE job_id = OLD.id OR job_id = NEW.id)
      AND EXISTS (
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
    )
    OR (
      json_type(NEW.execution_json, '$.validation') IS 'object'
      AND EXISTS (
        SELECT 1
        FROM validation_job_results AS result
        JOIN review_run_job_links AS link
          ON link.job_id = result.job_id
          AND link.review_run_id = result.review_run_id
          AND link.request_id = result.request_id
          AND link.activation_number = result.job_activation
        JOIN review_runs AS run ON run.id = result.review_run_id
        JOIN review_run_requests AS request
          ON request.review_run_id = result.review_run_id AND request.request_id = result.request_id
        WHERE result.job_id = NEW.id
          AND result.run_attempt_id = OLD.current_run_attempt_id
          AND result.work_item_id = NEW.work_item_id
          AND result.job_kind = NEW.job_kind
          AND result.resource_revision = NEW.resource_revision
          AND result.execution_template_sha256 IS NEW.execution_digest
          AND run.repository_id = result.repository_id AND run.work_item_id = result.work_item_id
          AND run.revision_id = result.revision_id AND run.revision_key = result.resource_revision
          AND run.activation_id = result.activation_id AND run.plan_digest = result.plan_digest
          AND run.request_epoch_id = NEW.request_epoch_id
          AND request.workflow_kind = result.workflow_kind AND request.target = result.target
          AND request.prompt_version_id = result.prompt_version_id
          AND request.profile_version_id = result.profile_version_id
          AND json_extract(NEW.execution_json, '$.validation.runId') IS result.review_run_id
          AND json_extract(NEW.execution_json, '$.validation.requestId') IS result.request_id
          AND json_extract(NEW.execution_json, '$.validation.activationId') IS result.activation_id
          AND json_extract(NEW.execution_json, '$.validation.jobActivation') IS result.job_activation
          AND json_extract(NEW.execution_json, '$.validation.repositoryId') IS result.repository_id
          AND json_extract(NEW.execution_json, '$.validation.workItemId') IS result.work_item_id
          AND json_extract(NEW.execution_json, '$.validation.revisionKey') IS result.resource_revision
          AND json_extract(NEW.execution_json, '$.validation.planDigest') IS result.plan_digest
          AND json_extract(NEW.execution_json, '$.validation.workflowKind') IS result.workflow_kind
          AND json_extract(NEW.execution_json, '$.validation.target') IS result.target
          AND json_extract(NEW.execution_json, '$.validation.promptVersion.id') IS result.prompt_version_id
          AND json_extract(NEW.execution_json, '$.validation.profileVersion.id') IS result.profile_version_id
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'succeeded job requires a complete immutable review result');
END;

CREATE TRIGGER tr_validation_job_initial_success_rejected
BEFORE INSERT ON jobs
WHEN NEW.status = 'succeeded' AND json_type(NEW.execution_json, '$.validation') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'validation jobs require a complete immutable validation result');
END;

CREATE TRIGGER tr_completed_job_validation_identity
BEFORE UPDATE OF execution_json, execution_digest, work_item_id, request_epoch_id ON jobs
WHEN OLD.status = 'succeeded' AND NEW.status = 'succeeded'
  AND json_type(NEW.execution_json, '$.validation') IS NOT NULL
  AND (NEW.execution_json IS NOT OLD.execution_json
    OR NEW.execution_digest IS NOT OLD.execution_digest
    OR NEW.work_item_id IS NOT OLD.work_item_id
    OR NEW.request_epoch_id IS NOT OLD.request_epoch_id)
BEGIN
  SELECT RAISE(ABORT, 'completed jobs cannot acquire or change validation identity');
END;

CREATE TRIGGER tr_run_attempt_completed_validation_identity_immutable
BEFORE UPDATE OF status, result_digest, result_json ON run_attempts
WHEN EXISTS (SELECT 1 FROM validation_job_results WHERE run_attempt_id = OLD.id)
  AND (NEW.status IS NOT OLD.status
    OR NEW.result_digest IS NOT OLD.result_digest
    OR CAST(NEW.result_json AS BLOB) IS NOT CAST(OLD.result_json AS BLOB))
BEGIN
  SELECT RAISE(ABORT, 'completed validation attempt result is immutable');
END;

CREATE TRIGGER tr_work_item_revision_completed_validation_identity_immutable
BEFORE UPDATE OF work_item_id, revision_key, resource_kind, base_sha, head_sha, content_digest, revision_json
ON work_item_revisions
WHEN EXISTS (SELECT 1 FROM validation_job_results WHERE revision_id = OLD.id)
  AND (NEW.work_item_id IS NOT OLD.work_item_id
    OR NEW.revision_key IS NOT OLD.revision_key
    OR NEW.resource_kind IS NOT OLD.resource_kind
    OR NEW.base_sha IS NOT OLD.base_sha
    OR NEW.head_sha IS NOT OLD.head_sha
    OR NEW.content_digest IS NOT OLD.content_digest
    OR NEW.revision_json IS NOT OLD.revision_json)
BEGIN
  SELECT RAISE(ABORT, 'completed validation revision identity is immutable');
END;

CREATE TRIGGER tr_validation_job_results_immutable_update
BEFORE UPDATE ON validation_job_results
BEGIN
  SELECT RAISE(ABORT, 'validation job results are immutable');
END;

CREATE TRIGGER tr_validation_job_results_immutable_delete
BEFORE DELETE ON validation_job_results
BEGIN
  SELECT RAISE(ABORT, 'validation job results are immutable');
END;
