-- Immutable pre-model runner input. This record grants no execution or completion authority.
CREATE TABLE model_summary_inputs (
  input_id TEXT PRIMARY KEY CHECK(length(input_id) BETWEEN 1 AND 128 AND input_id NOT GLOB '*[^A-Za-z0-9._:-]*' AND substr(input_id,1,1) GLOB '[A-Za-z0-9]'),
  run_attempt_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id),
  evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
  cell_id TEXT NOT NULL REFERENCES evaluation_cells(id),
  run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  worker_node_id TEXT NOT NULL,
  worker_instance_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK(lease_generation BETWEEN 1 AND 9007199254740991),
  input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json) = 'object' AND length(CAST(input_json AS BLOB)) <= 294912),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256) = 64 AND length(CAST(input_sha256 AS BLOB)) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
  intent_sha256 TEXT NOT NULL CHECK(length(intent_sha256) = 64 AND length(CAST(intent_sha256 AS BLOB)) = 64 AND intent_sha256 NOT GLOB '*[^0-9a-f]*'),
  frozen_at TEXT NOT NULL CHECK(length(frozen_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', frozen_at) IS frozen_at),
  FOREIGN KEY(run_attempt_id, job_id) REFERENCES run_attempts(id, job_id),
  FOREIGN KEY(run_id, request_id) REFERENCES review_run_requests(review_run_id, request_id),
  FOREIGN KEY(worker_node_id, worker_instance_id) REFERENCES workers(node_id, instance_id)
) STRICT;

CREATE TRIGGER tr_model_summary_input_no_replace BEFORE INSERT ON model_summary_inputs
WHEN EXISTS (SELECT 1 FROM model_summary_inputs WHERE input_id = NEW.input_id OR run_attempt_id = NEW.run_attempt_id)
BEGIN SELECT RAISE(ABORT, 'summary input is immutable'); END;
CREATE TRIGGER tr_model_summary_input_no_update BEFORE UPDATE ON model_summary_inputs
BEGIN SELECT RAISE(ABORT, 'summary input is immutable'); END;
CREATE TRIGGER tr_model_summary_input_no_delete BEFORE DELETE ON model_summary_inputs
BEGIN SELECT RAISE(ABORT, 'summary input is immutable'); END;

CREATE TRIGGER tr_model_summary_input_consistency BEFORE INSERT ON model_summary_inputs
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 WHERE
    NOT EXISTS (SELECT parent,key FROM json_tree(NEW.input_json) WHERE key IS NOT NULL GROUP BY parent,key HAVING COUNT(*) != 1)
    AND (SELECT COUNT(*) FROM json_each(NEW.input_json)) = 16
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.input_json) WHERE key NOT IN
      ('schemaVersion','inputId','repositoryId','evaluationId','cellId','authorizationId','executionManifestSha256',
       'workerNodeId','workerInstanceId','leaseGeneration','sourcePromptSha256','outputSchemaSha256','contextSha256','actualPromptSha256','context','frozenAt'))
    AND json_extract(NEW.input_json,'$.schemaVersion') IS 'FrozenValidationSummaryInputV1'
    AND json_extract(NEW.input_json,'$.inputId') IS NEW.input_id
    AND json_extract(NEW.input_json,'$.repositoryId') IS NEW.repository_id
    AND json_extract(NEW.input_json,'$.evaluationId') IS NEW.evaluation_id
    AND json_extract(NEW.input_json,'$.cellId') IS NEW.cell_id
    AND json_extract(NEW.input_json,'$.workerNodeId') IS NEW.worker_node_id
    AND json_extract(NEW.input_json,'$.workerInstanceId') IS NEW.worker_instance_id
    AND json_type(NEW.input_json,'$.leaseGeneration') IS 'integer'
    AND json_extract(NEW.input_json,'$.leaseGeneration') IS NEW.lease_generation
    AND json_extract(NEW.input_json,'$.frozenAt') IS NEW.frozen_at
    AND json_type(NEW.input_json,'$.executionManifestSha256') IS 'text' AND length(json_extract(NEW.input_json,'$.executionManifestSha256')) = 64 AND length(CAST(json_extract(NEW.input_json,'$.executionManifestSha256') AS BLOB)) = 64 AND json_extract(NEW.input_json,'$.executionManifestSha256') NOT GLOB '*[^0-9a-f]*'
    AND json_type(NEW.input_json,'$.sourcePromptSha256') IS 'text' AND length(json_extract(NEW.input_json,'$.sourcePromptSha256')) = 64 AND length(CAST(json_extract(NEW.input_json,'$.sourcePromptSha256') AS BLOB)) = 64 AND json_extract(NEW.input_json,'$.sourcePromptSha256') NOT GLOB '*[^0-9a-f]*'
    AND json_type(NEW.input_json,'$.outputSchemaSha256') IS 'text' AND length(json_extract(NEW.input_json,'$.outputSchemaSha256')) = 64 AND length(CAST(json_extract(NEW.input_json,'$.outputSchemaSha256') AS BLOB)) = 64 AND json_extract(NEW.input_json,'$.outputSchemaSha256') NOT GLOB '*[^0-9a-f]*'
    AND json_type(NEW.input_json,'$.contextSha256') IS 'text' AND length(json_extract(NEW.input_json,'$.contextSha256')) = 64 AND length(CAST(json_extract(NEW.input_json,'$.contextSha256') AS BLOB)) = 64 AND json_extract(NEW.input_json,'$.contextSha256') NOT GLOB '*[^0-9a-f]*'
    AND json_type(NEW.input_json,'$.actualPromptSha256') IS 'text' AND length(json_extract(NEW.input_json,'$.actualPromptSha256')) = 64 AND length(CAST(json_extract(NEW.input_json,'$.actualPromptSha256') AS BLOB)) = 64 AND json_extract(NEW.input_json,'$.actualPromptSha256') NOT GLOB '*[^0-9a-f]*'
    AND json_type(NEW.input_json,'$.context') IS 'object'
    AND length(CAST(json_extract(NEW.input_json,'$.context') AS BLOB)) <= 262144
    AND (SELECT COUNT(*) FROM json_each(NEW.input_json,'$.context')) BETWEEN 13 AND 15
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.input_json,'$.context') WHERE key NOT IN
      ('schemaVersion','runId','requestId','jobId','runAttemptId','githubRepositoryId','profileVersionId','revisionKey','planDigest',
       'testedSourceRevision','report','execution','evidence','reproduction','observationResults'))
    AND json_extract(NEW.input_json,'$.context.schemaVersion') IS 'ValidationSummaryContextV1'
    AND json_extract(NEW.input_json,'$.context.runId') IS NEW.run_id
    AND json_extract(NEW.input_json,'$.context.requestId') IS NEW.request_id
    AND json_extract(NEW.input_json,'$.context.jobId') IS NEW.job_id
    AND json_extract(NEW.input_json,'$.context.runAttemptId') IS NEW.run_attempt_id
    AND json_type(NEW.input_json,'$.context.report') IS 'object'
    AND json_type(NEW.input_json,'$.context.report.modelSummary') IS NULL
    AND json_type(NEW.input_json,'$.context.report.checks') IS 'array'
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.input_json,'$.context.report.checks') WHERE json_extract(value,'$.source') IS NOT 'runner')
    AND json_type(NEW.input_json,'$.context.execution') IS 'object'
    AND json_type(NEW.input_json,'$.context.execution.blockers') IS 'array'
    AND json_type(NEW.input_json,'$.context.execution.diagnostics') IS 'array'
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.input_json,'$.context.execution.blockers') WHERE json_extract(value,'$.phase') IS 'model_review')
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.input_json,'$.context.execution.diagnostics') WHERE json_extract(value,'$.phase') IS 'model_review')
    AND json_type(NEW.input_json,'$.context.evidence') IS 'object'
    AND (SELECT COUNT(*) FROM json_each(NEW.input_json,'$.context.evidence')) = 2
    AND json_type(NEW.input_json,'$.context.evidence.assets') IS 'array'
    AND json_array_length(NEW.input_json,'$.context.evidence.assets') <= 256
    AND json_type(NEW.input_json,'$.context.evidence.scenarios') IS 'array'
    AND json_array_length(NEW.input_json,'$.context.evidence.scenarios') <= 32
  ) THEN RAISE(ABORT, 'summary input metadata is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM run_attempts AS attempt
    JOIN jobs AS job ON job.id = attempt.job_id
    JOIN workers AS worker ON worker.id = attempt.worker_id AND worker.node_id = attempt.worker_node_id AND worker.instance_id = attempt.worker_instance_id
    JOIN worker_node_credentials AS credential ON credential.worker_node_id = worker.node_id AND credential.auth_state = 'active'
    JOIN review_run_job_links AS link ON link.job_id = job.id AND link.activation_number = 1
    JOIN review_runs AS run ON run.id = link.review_run_id AND run.purpose = 'evaluation'
    JOIN review_run_requests AS request ON request.review_run_id = run.id AND request.request_id = link.request_id
    JOIN evaluation_cells AS cell ON cell.id = run.evaluation_cell_id AND cell.run_id = run.id AND cell.repository_id = run.repository_id AND cell.request_id = request.request_id
    JOIN evaluations AS evaluation ON evaluation.id = cell.evaluation_id AND evaluation.repository_id = cell.repository_id
    JOIN evaluation_seals AS seal ON seal.evaluation_id = evaluation.id
    JOIN evaluation_controls AS control ON control.evaluation_id = evaluation.id
    JOIN managed_repositories AS repository ON repository.id = cell.repository_id
    WHERE attempt.id = NEW.run_attempt_id AND job.id = NEW.job_id
      AND run.id = NEW.run_id AND cell.request_id = NEW.request_id
      AND cell.repository_id = NEW.repository_id AND cell.evaluation_id = NEW.evaluation_id AND cell.id = NEW.cell_id
      AND attempt.worker_node_id = NEW.worker_node_id AND attempt.worker_instance_id = NEW.worker_instance_id
      AND attempt.lease_generation = NEW.lease_generation AND job.lease_generation = attempt.lease_generation
      AND job.current_run_attempt_id = attempt.id AND attempt.status IN ('leased','running') AND job.status IN ('leased','running')
      AND attempt.started_at <= NEW.frozen_at AND attempt.lease_expires_at > NEW.frozen_at
      AND attempt.execution_deadline_at > NEW.frozen_at AND attempt.no_progress_deadline_at > NEW.frozen_at
      AND job.cancellation_requested_at IS NULL AND worker.superseded_at IS NULL AND worker.status IN ('online','draining')
      AND repository.enabled = 1 AND cell.applicable = 1 AND control.status = 'active'
      AND run.request_epoch_id IS NULL AND job.request_epoch_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM job_request_epochs WHERE job_id = job.id)
      AND json_extract(run.plan_json,'$.modelRequirements.required') IS 1
      AND json_extract(job.execution_json,'$.validation.schemaVersion') IS 'ValidationJobContextV2'
      AND json_extract(job.execution_json,'$.validation.workflowKind') IN ('pr_ui','issue_validation')
      AND json_extract(job.execution_json,'$.validation.runId') IS run.id
      AND json_extract(job.execution_json,'$.validation.requestId') IS cell.request_id
      AND CAST(json_extract(job.execution_json,'$.validation.modelRequirements') AS BLOB) IS CAST(json_extract(run.plan_json,'$.modelRequirements') AS BLOB)
      AND json_extract(NEW.input_json,'$.authorizationId') IS cell.authorization_id
      AND json_extract(NEW.input_json,'$.executionManifestSha256') IS evaluation.execution_manifest_sha256
      AND json_extract(NEW.input_json,'$.sourcePromptSha256') IS json_extract(request.prompt_envelope_json,'$.promptSha256')
      AND json_extract(NEW.input_json,'$.outputSchemaSha256') IS json_extract(request.prompt_envelope_json,'$.outputSchemaSha256')
      AND json_extract(NEW.input_json,'$.context.githubRepositoryId') IS json_extract(job.execution_json,'$.repository.githubRepositoryId')
      AND json_extract(NEW.input_json,'$.context.profileVersionId') IS json_extract(job.execution_json,'$.validation.profileVersion.id')
      AND json_extract(NEW.input_json,'$.context.revisionKey') IS json_extract(job.execution_json,'$.validation.revisionKey')
      AND json_extract(NEW.input_json,'$.context.planDigest') IS json_extract(job.execution_json,'$.validation.planDigest')
      AND json_extract(NEW.input_json,'$.context.report.workItemKind') IS json_extract(job.execution_json,'$.resource.kind')
      AND json_extract(NEW.input_json,'$.context.testedSourceRevision') IS json_extract(job.execution_json,'$.validation.testedSourceRevision')
      AND json_extract(NEW.input_json,'$.context.reproduction') IS json_extract(job.execution_json,'$.validation.reproduction')
  ) THEN RAISE(ABORT, 'summary input requires its current exact evaluation lease') END;
END;

-- A summary must use the exact runner document frozen for this attempt before CLI execution.
CREATE TRIGGER tr_validation_job_result_summary_input_binding BEFORE INSERT ON validation_job_results
WHEN NEW.schema_id = 'ValidationJobResultV2'
  AND json_extract(NEW.result_json, '$.modelReview.state') IS 'completed'
  AND NEW.workflow_kind IN ('pr_ui','issue_validation')
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 WHERE
      (SELECT COUNT(*) FROM json_each(NEW.result_json, '$.modelReview.execution.summaryInputRef')) = 7
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.result_json, '$.modelReview.execution.summaryInputRef')
        WHERE key NOT IN ('schemaVersion','inputId','inputSha256','sourcePromptSha256','outputSchemaSha256','contextSha256','actualPromptSha256'))
      AND json_extract(NEW.result_json, '$.modelReview.execution.summaryInputRef.schemaVersion') IS 'ValidationSummaryInputReferenceV1'
      AND json_type(NEW.result_json, '$.modelReview.execution.summaryInputRef.inputId') IS 'text'
      AND length(json_extract(NEW.result_json, '$.modelReview.execution.summaryInputRef.inputId')) BETWEEN 1 AND 128
      AND substr(json_extract(NEW.result_json, '$.modelReview.execution.summaryInputRef.inputId'),1,1) GLOB '[A-Za-z0-9]'
      AND json_extract(NEW.result_json, '$.modelReview.execution.summaryInputRef.inputId') NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.result_json, '$.modelReview.execution.summaryInputRef')
        WHERE key IN ('inputSha256','sourcePromptSha256','outputSchemaSha256','contextSha256','actualPromptSha256')
          AND (type IS NOT 'text' OR length(value) != 64 OR length(CAST(value AS BLOB)) != 64 OR value GLOB '*[^0-9a-f]*'))
  ) THEN RAISE(ABORT, 'CLI summary execution requires a complete frozen input reference') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM model_summary_inputs AS summary
    JOIN run_attempts AS attempt ON attempt.id = summary.run_attempt_id AND attempt.job_id = summary.job_id
    JOIN review_runs AS run ON run.id = summary.run_id AND run.purpose = 'evaluation'
    JOIN evaluation_cells AS cell ON cell.id = run.evaluation_cell_id AND cell.run_id = run.id
      AND cell.repository_id = run.repository_id AND cell.request_id = summary.request_id
    WHERE summary.input_id IS json_extract(NEW.result_json, '$.modelReview.execution.summaryInputRef.inputId')
      AND summary.input_sha256 IS json_extract(NEW.result_json, '$.modelReview.execution.summaryInputRef.inputSha256')
      AND summary.run_attempt_id IS NEW.run_attempt_id AND summary.job_id IS NEW.job_id
      AND summary.repository_id IS NEW.repository_id AND summary.run_id IS NEW.review_run_id AND summary.request_id IS NEW.request_id
      AND summary.cell_id = cell.id AND summary.evaluation_id = cell.evaluation_id
      AND summary.worker_node_id = attempt.worker_node_id AND summary.worker_instance_id = attempt.worker_instance_id
      AND summary.lease_generation = attempt.lease_generation AND summary.frozen_at <= NEW.created_at
      AND json_extract(summary.input_json, '$.sourcePromptSha256') IS json_extract(NEW.result_json, '$.modelReview.execution.summaryInputRef.sourcePromptSha256')
      AND json_extract(summary.input_json, '$.outputSchemaSha256') IS json_extract(NEW.result_json, '$.modelReview.execution.summaryInputRef.outputSchemaSha256')
      AND json_extract(summary.input_json, '$.contextSha256') IS json_extract(NEW.result_json, '$.modelReview.execution.summaryInputRef.contextSha256')
      AND json_extract(summary.input_json, '$.actualPromptSha256') IS json_extract(NEW.result_json, '$.modelReview.execution.summaryInputRef.actualPromptSha256')
      AND json_extract(summary.input_json, '$.actualPromptSha256') IS json_extract(NEW.result_json, '$.modelReview.execution.promptSha256')
      AND json_extract(summary.input_json, '$.outputSchemaSha256') IS json_extract(NEW.result_json, '$.modelReview.execution.outputSchemaSha256')
      AND CAST(json_extract(summary.input_json, '$.context.report') AS BLOB) IS CAST(json_extract(NEW.result_json, '$.report') AS BLOB)
      AND json_extract(summary.input_json, '$.context.execution.cleanupState') IS json_extract(NEW.result_json, '$.execution.cleanupState')
      AND json_extract(summary.input_json, '$.context.execution.blockers') IS
        (SELECT json_group_array(json(value)) FROM json_each(NEW.result_json, '$.execution.blockers') WHERE json_extract(value, '$.phase') IS NOT 'model_review')
      AND json_extract(summary.input_json, '$.context.execution.diagnostics') IS
        (SELECT json_group_array(json(value)) FROM json_each(NEW.result_json, '$.execution.diagnostics') WHERE json_extract(value, '$.phase') IS NOT 'model_review')
      AND json_extract(summary.input_json, '$.context.observationResults.probeReceipts') IS json_extract(NEW.result_json, '$.probeReceipts')
      AND json_extract(summary.input_json, '$.context.observationResults.reproductionAssessment') IS json_extract(NEW.result_json, '$.reproductionAssessment')
  ) THEN RAISE(ABORT, 'CLI summary output must retain its exact frozen runner input') END;
END;
