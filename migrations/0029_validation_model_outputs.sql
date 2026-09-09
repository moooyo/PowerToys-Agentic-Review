-- The startup-owned rebuild preserves existing rows and exact current schema dependencies.

-- CLI metadata binds one completed model output to its Worker attempt and frozen prompt.

-- Validation results retain their frozen workflow identity without reinterpreting
-- or rewriting the legacy review result tables.
CREATE TABLE new_validation_job_results (
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
  schema_id TEXT NOT NULL CHECK (schema_id IN ('ValidationJobResultV1', 'ValidationJobResultV2')),
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
        AND CASE WHEN schema_id = 'ValidationJobResultV1' THEN json_extract(result_json, '$.modelReview.result.schemaVersion') IS CASE job_kind
          WHEN 'pull_request_review' THEN 'PrReviewPlanV2' ELSE 'IssueTriageV2' END
        ELSE (json_extract(result_json, '$.modelReview.result.schemaVersion') IS CASE workflow_kind WHEN 'pr_static_build' THEN 'PrReviewPlanV2' WHEN 'issue_triage' THEN 'IssueTriageV2' ELSE 'ValidationSummaryV1' END
          AND json_type(result_json, '$.modelReview.result.executionEvidence') IS NULL
          AND (workflow_kind IN ('pr_static_build', 'issue_triage') OR json_extract(result_json, '$.modelReview.result.workItemKind') IS json_extract(result_json, '$.report.workItemKind'))
          AND json_type(result_json, '$.modelReview.execution') IS 'object'
          AND json_extract(result_json, '$.modelReview.execution.schemaVersion') IS 'CliModelExecutionV1'
          AND json_extract(result_json, '$.modelReview.execution.jobId') IS job_id
          AND json_extract(result_json, '$.modelReview.execution.runAttemptId') IS run_attempt_id
          AND json_type(result_json, '$.modelReview.executionEvidence') IS 'object'
          AND json_extract(result_json, '$.modelReview.executionEvidence.schemaVersion') IS 'ReviewExecutionEvidenceV1'
          AND json_extract(result_json, '$.modelReview.executionEvidence.source') IS 'worker'
          AND json_type(result_json, '$.modelReview.executionEvidence.commandCapture') IS 'text'
          AND json_extract(result_json, '$.modelReview.executionEvidence.commandCapture') IN ('complete', 'incomplete')
          AND json_type(result_json, '$.modelReview.executionEvidence.commands') IS 'array'
          AND json_array_length(result_json, '$.modelReview.executionEvidence.commands') <= 128
          AND json_type(result_json, '$.modelReview.executionEvidence.worktree') IS 'object'
          AND json_type(result_json, '$.modelReview.executionEvidence.worktree.status') IS 'text'
          AND json_type(result_json, '$.modelReview.executionEvidence.worktree.source') IS 'text'
          AND json_extract(result_json, '$.modelReview.executionEvidence.worktree.status') IN ('clean', 'modified', 'unknown')
          AND json_extract(result_json, '$.modelReview.executionEvidence.worktree.source') IN ('git_status', 'not_observed')
          AND json_type(result_json, '$.modelReview.execution.promptSha256') IS 'text' AND length(json_extract(result_json, '$.modelReview.execution.promptSha256')) = 64 AND length(CAST(json_extract(result_json, '$.modelReview.execution.promptSha256') AS BLOB)) = 64 AND json_extract(result_json, '$.modelReview.execution.promptSha256') NOT GLOB '*[^0-9a-f]*'
          AND json_type(result_json, '$.modelReview.execution.outputSchemaSha256') IS 'text' AND length(json_extract(result_json, '$.modelReview.execution.outputSchemaSha256')) = 64 AND length(CAST(json_extract(result_json, '$.modelReview.execution.outputSchemaSha256') AS BLOB)) = 64 AND json_extract(result_json, '$.modelReview.execution.outputSchemaSha256') NOT GLOB '*[^0-9a-f]*'
          AND json_type(result_json, '$.modelReview.execution.outputSha256') IS 'text' AND length(json_extract(result_json, '$.modelReview.execution.outputSha256')) = 64 AND length(CAST(json_extract(result_json, '$.modelReview.execution.outputSha256') AS BLOB)) = 64 AND json_extract(result_json, '$.modelReview.execution.outputSha256') NOT GLOB '*[^0-9a-f]*') END
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
,
  CHECK (schema_id = 'ValidationJobResultV1' OR json_type(result_json, '$.report.modelSummary') IS NULL)
) STRICT;

INSERT INTO new_validation_job_results (rowid, id, run_attempt_id, job_id, repository_id, work_item_id, revision_id, job_kind, resource_revision, review_run_id, request_id, activation_id, job_activation, workflow_kind, target, plan_digest, prompt_version_id, profile_version_id, schema_id, result_digest, result_json, execution_template_sha256, evidence_complete, created_at)

SELECT rowid, id, run_attempt_id, job_id, repository_id, work_item_id, revision_id, job_kind, resource_revision, review_run_id, request_id, activation_id, job_activation, workflow_kind, target, plan_digest, prompt_version_id, profile_version_id, schema_id, result_digest, result_json, execution_template_sha256, evidence_complete, created_at FROM validation_job_results;

DROP TABLE validation_job_results;

ALTER TABLE new_validation_job_results RENAME TO validation_job_results;

CREATE TRIGGER tr_validation_job_result_v2_binding BEFORE INSERT ON validation_job_results
WHEN NEW.schema_id = 'ValidationJobResultV2'
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.result_json, '$.report.checks')
    WHERE json_extract(value, '$.source') IS NOT 'runner')
    OR EXISTS (SELECT parent, key FROM json_tree(NEW.result_json) WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) <> 1)
    OR (SELECT COUNT(*) FROM json_each(NEW.result_json, '$.modelReview')) <> CASE json_extract(NEW.result_json, '$.modelReview.state') WHEN 'not_requested' THEN 1 WHEN 'failed' THEN 3 WHEN 'completed' THEN 4 ELSE 0 END
    OR EXISTS (SELECT 1 FROM json_each(NEW.result_json, '$.modelReview') WHERE key NOT IN ('state','code','message','result','execution','executionEvidence'))
    OR (json_extract(NEW.result_json, '$.modelReview.state') <> 'completed' AND (json_type(NEW.result_json, '$.modelReview.result') IS NOT NULL OR json_type(NEW.result_json, '$.modelReview.execution') IS NOT NULL OR json_type(NEW.result_json, '$.modelReview.executionEvidence') IS NOT NULL))
    THEN RAISE(ABORT, 'validation V2 must keep runner facts separate from one model output') END;
  SELECT CASE WHEN json_extract(NEW.result_json, '$.modelReview.state') IS 'completed' AND NOT EXISTS (
    SELECT 1 WHERE
      (SELECT COUNT(*) FROM json_each(NEW.result_json, '$.modelReview.execution')) = 8 + (NEW.workflow_kind IN ('pr_ui', 'issue_validation'))
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.result_json, '$.modelReview.execution') WHERE key NOT IN
        ('schemaVersion','jobId','runAttemptId','cli','promptSha256','outputSchemaSha256','outputSha256','exitCode','summaryInputRef'))
      AND json_type(NEW.result_json, '$.modelReview.execution.cli') IS 'object'
      AND (SELECT COUNT(*) FROM json_each(NEW.result_json, '$.modelReview.execution.cli')) = 3
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.result_json, '$.modelReview.execution.cli') WHERE key NOT IN ('kind','version','requestedModel'))
      AND json_extract(NEW.result_json, '$.modelReview.execution.cli.kind') IN ('codex','copilot')
      AND json_type(NEW.result_json, '$.modelReview.execution.cli.version') IS 'text'
      AND length(json_extract(NEW.result_json, '$.modelReview.execution.cli.version')) BETWEEN 1 AND 128
      AND trim(json_extract(NEW.result_json, '$.modelReview.execution.cli.version')) IS json_extract(NEW.result_json, '$.modelReview.execution.cli.version')
      AND instr(json_extract(NEW.result_json, '$.modelReview.execution.cli.version'), char(0)) = 0
      AND (json_type(NEW.result_json, '$.modelReview.execution.cli.requestedModel') IS 'null'
        OR (json_type(NEW.result_json, '$.modelReview.execution.cli.requestedModel') IS 'text'
          AND length(json_extract(NEW.result_json, '$.modelReview.execution.cli.requestedModel')) BETWEEN 1 AND 128
          AND trim(json_extract(NEW.result_json, '$.modelReview.execution.cli.requestedModel')) IS json_extract(NEW.result_json, '$.modelReview.execution.cli.requestedModel')
          AND instr(json_extract(NEW.result_json, '$.modelReview.execution.cli.requestedModel'), char(0)) = 0))
      AND json_type(NEW.result_json, '$.modelReview.execution.exitCode') IS 'integer'
      AND json_extract(NEW.result_json, '$.modelReview.execution.exitCode') IS 0
      AND ((NEW.workflow_kind IN ('pr_static_build','issue_triage') AND json_type(NEW.result_json, '$.modelReview.execution.summaryInputRef') IS NULL)
        OR (NEW.workflow_kind IN ('pr_ui','issue_validation') AND json_type(NEW.result_json, '$.modelReview.execution.summaryInputRef') IS 'object'))
  ) THEN RAISE(ABORT, 'validation V2 requires complete CLI execution metadata') END;
  SELECT CASE WHEN json_extract(NEW.result_json, '$.modelReview.state') IS 'completed' AND NOT EXISTS (
    SELECT 1 FROM jobs AS job
    JOIN run_attempts AS attempt ON attempt.id = NEW.run_attempt_id AND attempt.job_id = job.id
    JOIN review_runs AS run ON run.id = NEW.review_run_id AND run.purpose = 'evaluation'
    JOIN review_run_requests AS request ON request.review_run_id = run.id AND request.request_id = NEW.request_id
    JOIN evaluation_cells AS cell ON cell.id = run.evaluation_cell_id AND cell.run_id = run.id
      AND cell.repository_id = run.repository_id AND cell.request_id = request.request_id
    WHERE job.id = NEW.job_id AND job.current_run_attempt_id = attempt.id
      AND job.lease_generation = attempt.lease_generation AND attempt.status = 'succeeded'
      AND run.repository_id = NEW.repository_id AND request.workflow_kind = NEW.workflow_kind
      AND json_extract(run.plan_json, '$.modelRequirements.required') IS 1
      AND json_extract(NEW.result_json, '$.modelReview.execution.jobId') IS job.id
      AND json_extract(NEW.result_json, '$.modelReview.execution.runAttemptId') IS attempt.id
      AND json_extract(NEW.result_json, '$.modelReview.execution.outputSchemaSha256') IS json_extract(request.prompt_envelope_json, '$.outputSchemaSha256')
      AND ((NEW.workflow_kind IN ('pr_static_build','issue_triage')
        AND json_extract(NEW.result_json, '$.modelReview.execution.promptSha256') IS json_extract(request.prompt_envelope_json, '$.promptSha256'))
        OR (NEW.workflow_kind IN ('pr_ui','issue_validation')
          AND json_extract(NEW.result_json, '$.modelReview.execution.promptSha256') IS json_extract(NEW.result_json, '$.modelReview.execution.summaryInputRef.actualPromptSha256')
          AND json_extract(NEW.result_json, '$.modelReview.execution.outputSchemaSha256') IS json_extract(NEW.result_json, '$.modelReview.execution.summaryInputRef.outputSchemaSha256')))
  ) THEN RAISE(ABORT, 'validation V2 model output requires its exact CLI task and prompt') END;
END;
