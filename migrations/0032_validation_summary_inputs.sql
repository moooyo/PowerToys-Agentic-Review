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
  SELECT CASE WHEN EXISTS (SELECT 1 FROM model_invocation_openings WHERE run_attempt_id = NEW.run_attempt_id)
    THEN RAISE(ABORT, 'summary input cannot follow an invocation opening') END;
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
    JOIN model_runtime_registrations AS registration ON registration.id = json_extract(run.plan_json,'$.modelRequirements.runtimeRegistration.registrationId')
      AND registration.registration_sha256 IS json_extract(run.plan_json,'$.modelRequirements.runtimeRegistration.registrationSha256')
      AND registration.identity_sha256 IS json_extract(run.plan_json,'$.modelRequirements.expectedModelIdentityDigest')
      AND CAST(registration.registration_json AS BLOB) IS CAST(json_extract(run.plan_json,'$.modelRuntimeRegistration') AS BLOB)
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
      AND CAST(json_extract(job.execution_json,'$.validation.modelRuntimeRegistration') AS BLOB) IS CAST(registration.registration_json AS BLOB)
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

-- Replace only the two version-sensitive guards. Existing rows and immutable-update guards remain intact.
DROP TRIGGER tr_model_invocation_opening_consistency;
DROP TRIGGER tr_model_invocation_submission_consistency;
CREATE TRIGGER tr_model_invocation_opening_consistency BEFORE INSERT ON model_invocation_openings
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 WHERE NOT EXISTS (SELECT parent, key FROM json_tree(NEW.opening_json) WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1)
    AND (json_type(NEW.opening_json, '$') IS 'object' AND (SELECT COUNT(*) FROM json_each(NEW.opening_json, '$')) = 5 AND NOT EXISTS (SELECT 1 FROM json_each(NEW.opening_json, '$') WHERE key NOT IN ('schemaVersion', 'scope', 'scopeSha256', 'runtime', 'openedAt')))
    AND ((json_extract(NEW.opening_json, '$.schemaVersion') IS 'ModelInvocationOpeningV1' AND json_extract(NEW.opening_json, '$.scope.schemaVersion') IS 'ModelInvocationScopeV1')
      OR (json_extract(NEW.opening_json, '$.schemaVersion') IS 'ModelInvocationOpeningV2' AND json_extract(NEW.opening_json, '$.scope.schemaVersion') IS 'ModelInvocationScopeV2'))
    AND json_extract(NEW.opening_json, '$.openedAt') IS NEW.opened_at
    AND json_extract(NEW.opening_json, '$.scopeSha256') IS NEW.scope_sha256
    AND (json_type(NEW.opening_json, '$.scope') IS 'object' AND (SELECT COUNT(*) FROM json_each(NEW.opening_json, '$.scope')) = CASE json_extract(NEW.opening_json, '$.scope.schemaVersion') WHEN 'ModelInvocationScopeV1' THEN 18 ELSE 20 END AND NOT EXISTS (SELECT 1 FROM json_each(NEW.opening_json, '$.scope') WHERE key NOT IN ('schemaVersion', 'repositoryId', 'evaluationId', 'cellId', 'runId', 'requestId', 'jobId', 'attemptId', 'invocationId', 'authorizationId', 'executionManifestSha256', 'promptSha256', 'outputSchemaSha256', 'expectedModelIdentitySha256', 'requestedModel', 'workerNodeId', 'workerInstanceId', 'leaseGeneration', 'purpose', 'inputRef')))
    AND (json_extract(NEW.opening_json, '$.scope.schemaVersion') IS 'ModelInvocationScopeV1'
      OR (json_extract(NEW.opening_json, '$.scope.purpose') IS 'validation_summary'
        AND json_type(NEW.opening_json, '$.scope.inputRef') IS 'object'
        AND (SELECT COUNT(*) FROM json_each(NEW.opening_json, '$.scope.inputRef')) = 7
        AND NOT EXISTS (SELECT 1 FROM json_each(NEW.opening_json, '$.scope.inputRef') WHERE key NOT IN ('schemaVersion','inputId','inputSha256','sourcePromptSha256','outputSchemaSha256','contextSha256','actualPromptSha256'))
        AND json_extract(NEW.opening_json, '$.scope.inputRef.schemaVersion') IS 'ValidationSummaryInputReferenceV1'
        AND json_type(NEW.opening_json, '$.scope.inputRef.inputId') IS 'text'
        AND length(json_extract(NEW.opening_json, '$.scope.inputRef.inputId')) BETWEEN 1 AND 128
        AND json_extract(NEW.opening_json, '$.scope.inputRef.inputId') NOT GLOB '*[^A-Za-z0-9._:-]*'
        AND json_type(NEW.opening_json, '$.scope.inputRef.inputSha256') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.inputRef.inputSha256')) = 64 AND length(CAST(json_extract(NEW.opening_json, '$.scope.inputRef.inputSha256') AS BLOB)) = 64 AND json_extract(NEW.opening_json, '$.scope.inputRef.inputSha256') NOT GLOB '*[^0-9a-f]*'
        AND json_type(NEW.opening_json, '$.scope.inputRef.sourcePromptSha256') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.inputRef.sourcePromptSha256')) = 64 AND length(CAST(json_extract(NEW.opening_json, '$.scope.inputRef.sourcePromptSha256') AS BLOB)) = 64 AND json_extract(NEW.opening_json, '$.scope.inputRef.sourcePromptSha256') NOT GLOB '*[^0-9a-f]*'
        AND json_type(NEW.opening_json, '$.scope.inputRef.outputSchemaSha256') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.inputRef.outputSchemaSha256')) = 64 AND length(CAST(json_extract(NEW.opening_json, '$.scope.inputRef.outputSchemaSha256') AS BLOB)) = 64 AND json_extract(NEW.opening_json, '$.scope.inputRef.outputSchemaSha256') NOT GLOB '*[^0-9a-f]*'
        AND json_type(NEW.opening_json, '$.scope.inputRef.contextSha256') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.inputRef.contextSha256')) = 64 AND length(CAST(json_extract(NEW.opening_json, '$.scope.inputRef.contextSha256') AS BLOB)) = 64 AND json_extract(NEW.opening_json, '$.scope.inputRef.contextSha256') NOT GLOB '*[^0-9a-f]*'
        AND json_type(NEW.opening_json, '$.scope.inputRef.actualPromptSha256') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.inputRef.actualPromptSha256')) = 64 AND length(CAST(json_extract(NEW.opening_json, '$.scope.inputRef.actualPromptSha256') AS BLOB)) = 64 AND json_extract(NEW.opening_json, '$.scope.inputRef.actualPromptSha256') NOT GLOB '*[^0-9a-f]*'))
    AND (json_type(NEW.opening_json, '$.scope.repositoryId') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.repositoryId')) BETWEEN 1 AND 128 AND instr(json_extract(NEW.opening_json, '$.scope.repositoryId'), char(0)) = 0)
    AND (json_type(NEW.opening_json, '$.scope.evaluationId') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.evaluationId')) BETWEEN 1 AND 128 AND instr(json_extract(NEW.opening_json, '$.scope.evaluationId'), char(0)) = 0)
    AND (json_type(NEW.opening_json, '$.scope.cellId') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.cellId')) BETWEEN 1 AND 128 AND instr(json_extract(NEW.opening_json, '$.scope.cellId'), char(0)) = 0)
    AND (json_type(NEW.opening_json, '$.scope.runId') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.runId')) BETWEEN 1 AND 128 AND instr(json_extract(NEW.opening_json, '$.scope.runId'), char(0)) = 0)
    AND (json_type(NEW.opening_json, '$.scope.requestId') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.requestId')) BETWEEN 1 AND 128 AND instr(json_extract(NEW.opening_json, '$.scope.requestId'), char(0)) = 0)
    AND (json_type(NEW.opening_json, '$.scope.jobId') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.jobId')) BETWEEN 1 AND 128 AND instr(json_extract(NEW.opening_json, '$.scope.jobId'), char(0)) = 0)
    AND (json_type(NEW.opening_json, '$.scope.attemptId') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.attemptId')) BETWEEN 1 AND 128 AND instr(json_extract(NEW.opening_json, '$.scope.attemptId'), char(0)) = 0)
    AND (json_type(NEW.opening_json, '$.scope.invocationId') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.invocationId')) BETWEEN 1 AND 128 AND instr(json_extract(NEW.opening_json, '$.scope.invocationId'), char(0)) = 0)
    AND (json_type(NEW.opening_json, '$.scope.authorizationId') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.authorizationId')) BETWEEN 1 AND 128 AND instr(json_extract(NEW.opening_json, '$.scope.authorizationId'), char(0)) = 0)
    AND (json_type(NEW.opening_json, '$.scope.executionManifestSha256') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.executionManifestSha256')) = 64 AND length(CAST(json_extract(NEW.opening_json, '$.scope.executionManifestSha256') AS BLOB)) = 64 AND json_extract(NEW.opening_json, '$.scope.executionManifestSha256') NOT GLOB '*[^0-9a-f]*')
    AND (json_type(NEW.opening_json, '$.scope.promptSha256') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.promptSha256')) = 64 AND length(CAST(json_extract(NEW.opening_json, '$.scope.promptSha256') AS BLOB)) = 64 AND json_extract(NEW.opening_json, '$.scope.promptSha256') NOT GLOB '*[^0-9a-f]*')
    AND (json_type(NEW.opening_json, '$.scope.outputSchemaSha256') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.outputSchemaSha256')) = 64 AND length(CAST(json_extract(NEW.opening_json, '$.scope.outputSchemaSha256') AS BLOB)) = 64 AND json_extract(NEW.opening_json, '$.scope.outputSchemaSha256') NOT GLOB '*[^0-9a-f]*')
    AND (json_type(NEW.opening_json, '$.scope.expectedModelIdentitySha256') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.expectedModelIdentitySha256')) = 64 AND length(CAST(json_extract(NEW.opening_json, '$.scope.expectedModelIdentitySha256') AS BLOB)) = 64 AND json_extract(NEW.opening_json, '$.scope.expectedModelIdentitySha256') NOT GLOB '*[^0-9a-f]*')
    AND (json_type(NEW.opening_json, '$.scope.requestedModel') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.requestedModel')) BETWEEN 1 AND 1024 AND instr(json_extract(NEW.opening_json, '$.scope.requestedModel'), char(0)) = 0)
    AND (json_type(NEW.opening_json, '$.scope.workerNodeId') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.workerNodeId')) BETWEEN 1 AND 128 AND instr(json_extract(NEW.opening_json, '$.scope.workerNodeId'), char(0)) = 0)
    AND (json_type(NEW.opening_json, '$.scope.workerInstanceId') IS 'text' AND length(json_extract(NEW.opening_json, '$.scope.workerInstanceId')) BETWEEN 1 AND 128 AND instr(json_extract(NEW.opening_json, '$.scope.workerInstanceId'), char(0)) = 0)
    AND (json_type(NEW.opening_json, '$.scope.leaseGeneration') IS 'integer' AND json_extract(NEW.opening_json, '$.scope.leaseGeneration') BETWEEN 1 AND 9007199254740991)
    AND (json_type(NEW.opening_json, '$.runtime') IS 'object' AND (SELECT COUNT(*) FROM json_each(NEW.opening_json, '$.runtime')) = 4 AND NOT EXISTS (SELECT 1 FROM json_each(NEW.opening_json, '$.runtime') WHERE key NOT IN ('providerId', 'endpointSha256', 'client', 'relay')))
    AND (json_type(NEW.opening_json, '$.runtime.providerId') IS 'text' AND length(json_extract(NEW.opening_json, '$.runtime.providerId')) BETWEEN 1 AND 128 AND instr(json_extract(NEW.opening_json, '$.runtime.providerId'), char(0)) = 0)
    AND (json_type(NEW.opening_json, '$.runtime.endpointSha256') IS 'text' AND length(json_extract(NEW.opening_json, '$.runtime.endpointSha256')) = 64 AND length(CAST(json_extract(NEW.opening_json, '$.runtime.endpointSha256') AS BLOB)) = 64 AND json_extract(NEW.opening_json, '$.runtime.endpointSha256') NOT GLOB '*[^0-9a-f]*')
    AND (json_type(NEW.opening_json, '$.runtime.client') IS 'object' AND (SELECT COUNT(*) FROM json_each(NEW.opening_json, '$.runtime.client')) = 4 AND NOT EXISTS (SELECT 1 FROM json_each(NEW.opening_json, '$.runtime.client') WHERE key NOT IN ('kind', 'version', 'executableSha256', 'launchPolicySha256')))
    AND json_extract(NEW.opening_json, '$.runtime.client.kind') IS 'codex_cli'
    AND (json_type(NEW.opening_json, '$.runtime.client.version') IS 'text' AND length(json_extract(NEW.opening_json, '$.runtime.client.version')) BETWEEN 1 AND 128 AND instr(json_extract(NEW.opening_json, '$.runtime.client.version'), char(0)) = 0)
    AND (json_type(NEW.opening_json, '$.runtime.client.executableSha256') IS 'text' AND length(json_extract(NEW.opening_json, '$.runtime.client.executableSha256')) = 64 AND length(CAST(json_extract(NEW.opening_json, '$.runtime.client.executableSha256') AS BLOB)) = 64 AND json_extract(NEW.opening_json, '$.runtime.client.executableSha256') NOT GLOB '*[^0-9a-f]*')
    AND (json_type(NEW.opening_json, '$.runtime.client.launchPolicySha256') IS 'text' AND length(json_extract(NEW.opening_json, '$.runtime.client.launchPolicySha256')) = 64 AND length(CAST(json_extract(NEW.opening_json, '$.runtime.client.launchPolicySha256') AS BLOB)) = 64 AND json_extract(NEW.opening_json, '$.runtime.client.launchPolicySha256') NOT GLOB '*[^0-9a-f]*')
    AND (json_type(NEW.opening_json, '$.runtime.relay') IS 'object' AND (SELECT COUNT(*) FROM json_each(NEW.opening_json, '$.runtime.relay')) = 2 AND NOT EXISTS (SELECT 1 FROM json_each(NEW.opening_json, '$.runtime.relay') WHERE key NOT IN ('implementationSha256', 'policySha256')))
    AND (json_type(NEW.opening_json, '$.runtime.relay.implementationSha256') IS 'text' AND length(json_extract(NEW.opening_json, '$.runtime.relay.implementationSha256')) = 64 AND length(CAST(json_extract(NEW.opening_json, '$.runtime.relay.implementationSha256') AS BLOB)) = 64 AND json_extract(NEW.opening_json, '$.runtime.relay.implementationSha256') NOT GLOB '*[^0-9a-f]*')
    AND (json_type(NEW.opening_json, '$.runtime.relay.policySha256') IS 'text' AND length(json_extract(NEW.opening_json, '$.runtime.relay.policySha256')) = 64 AND length(CAST(json_extract(NEW.opening_json, '$.runtime.relay.policySha256') AS BLOB)) = 64 AND json_extract(NEW.opening_json, '$.runtime.relay.policySha256') NOT GLOB '*[^0-9a-f]*')) THEN RAISE(ABORT, 'model invocation opening has invalid metadata') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM run_attempts AS attempt
    JOIN jobs AS job ON job.id = attempt.job_id
    JOIN workers AS worker ON worker.id = attempt.worker_id
      AND worker.node_id = attempt.worker_node_id AND worker.instance_id = attempt.worker_instance_id
    JOIN worker_node_credentials AS credential ON credential.worker_node_id = worker.node_id
    JOIN review_run_job_links AS link ON link.job_id = job.id AND link.activation_number = 1
    JOIN review_runs AS run ON run.id = link.review_run_id AND run.purpose = 'evaluation'
    JOIN review_run_requests AS request ON request.review_run_id = run.id AND request.request_id = link.request_id
    JOIN evaluation_cells AS cell ON cell.id = run.evaluation_cell_id AND cell.run_id = run.id
      AND cell.repository_id = run.repository_id AND cell.request_id = request.request_id
    JOIN evaluations AS evaluation ON evaluation.id = cell.evaluation_id AND evaluation.repository_id = cell.repository_id
    JOIN evaluation_seals AS evaluation_seal ON evaluation_seal.evaluation_id = evaluation.id
    JOIN evaluation_controls AS control ON control.evaluation_id = evaluation.id
    JOIN managed_repositories AS repository ON repository.id = cell.repository_id
    JOIN model_runtime_registrations AS registration ON registration.id = json_extract(run.plan_json, '$.modelRequirements.runtimeRegistration.registrationId')
      AND registration.registration_sha256 IS json_extract(run.plan_json, '$.modelRequirements.runtimeRegistration.registrationSha256')
      AND registration.identity_sha256 IS json_extract(run.plan_json, '$.modelRequirements.expectedModelIdentityDigest')
      AND CAST(registration.registration_json AS BLOB) IS CAST(json_extract(run.plan_json, '$.modelRuntimeRegistration') AS BLOB)
    WHERE attempt.id = NEW.run_attempt_id AND job.id = NEW.job_id
      AND attempt.worker_node_id = NEW.worker_node_id AND attempt.worker_instance_id = NEW.worker_instance_id
      AND attempt.lease_generation = NEW.lease_generation AND job.lease_generation = attempt.lease_generation
      AND job.current_run_attempt_id = attempt.id AND attempt.status IN ('leased', 'running') AND job.status IN ('leased', 'running')
      AND attempt.started_at <= NEW.opened_at AND attempt.lease_expires_at > NEW.opened_at
      AND attempt.execution_deadline_at > NEW.opened_at AND attempt.no_progress_deadline_at > NEW.opened_at
      AND job.cancellation_requested_at IS NULL AND worker.superseded_at IS NULL
      AND worker.status IN ('online', 'draining') AND credential.auth_state = 'active'
      AND repository.enabled = 1 AND cell.applicable = 1 AND control.status = 'active'
      AND run.request_epoch_id IS NULL AND job.request_epoch_id IS NULL
      AND json_extract(run.plan_json, '$.modelRequirements.required') IS 1
      AND json_extract(job.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
      AND json_extract(job.execution_json, '$.validation.runId') IS run.id
      AND json_extract(job.execution_json, '$.validation.requestId') IS cell.request_id
      AND CAST(json_extract(job.execution_json, '$.validation.modelRequirements') AS BLOB) IS CAST(json_extract(run.plan_json, '$.modelRequirements') AS BLOB)
      AND CAST(json_extract(job.execution_json, '$.validation.modelRuntimeRegistration') AS BLOB) IS CAST(registration.registration_json AS BLOB)
      AND json_extract(NEW.opening_json, '$.scope.repositoryId') IS run.repository_id
      AND json_extract(NEW.opening_json, '$.scope.evaluationId') IS evaluation.id
      AND json_extract(NEW.opening_json, '$.scope.cellId') IS cell.id
      AND json_extract(NEW.opening_json, '$.scope.runId') IS run.id
      AND json_extract(NEW.opening_json, '$.scope.requestId') IS cell.request_id
      AND json_extract(NEW.opening_json, '$.scope.jobId') IS NEW.job_id
      AND json_extract(NEW.opening_json, '$.scope.attemptId') IS NEW.run_attempt_id
      AND json_extract(NEW.opening_json, '$.scope.invocationId') IS NEW.invocation_id
      AND json_extract(NEW.opening_json, '$.scope.authorizationId') IS cell.authorization_id
      AND json_extract(NEW.opening_json, '$.scope.executionManifestSha256') IS evaluation.execution_manifest_sha256
      AND json_extract(NEW.opening_json, '$.scope.promptSha256') IS json_extract(request.prompt_envelope_json, '$.promptSha256')
      AND json_extract(NEW.opening_json, '$.scope.outputSchemaSha256') IS json_extract(request.prompt_envelope_json, '$.outputSchemaSha256')
      AND json_extract(NEW.opening_json, '$.scope.expectedModelIdentitySha256') IS registration.identity_sha256
      AND json_extract(NEW.opening_json, '$.scope.requestedModel') IS registration.requested_model
      AND json_extract(NEW.opening_json, '$.scope.workerNodeId') IS NEW.worker_node_id
      AND json_extract(NEW.opening_json, '$.scope.workerInstanceId') IS NEW.worker_instance_id
      AND json_extract(NEW.opening_json, '$.scope.leaseGeneration') IS NEW.lease_generation
      AND ((json_extract(NEW.opening_json, '$.schemaVersion') IS 'ModelInvocationOpeningV1'
        AND json_extract(job.execution_json, '$.validation.workflowKind') IN ('pr_static_build','issue_triage'))
      OR (json_extract(NEW.opening_json, '$.schemaVersion') IS 'ModelInvocationOpeningV2'
        AND json_extract(job.execution_json, '$.validation.workflowKind') IN ('pr_ui','issue_validation')
        AND EXISTS (SELECT 1 FROM model_summary_inputs AS summary
        WHERE summary.input_id IS json_extract(NEW.opening_json, '$.scope.inputRef.inputId')
          AND summary.input_sha256 IS json_extract(NEW.opening_json, '$.scope.inputRef.inputSha256')
          AND summary.run_attempt_id = attempt.id AND summary.job_id = job.id
          AND summary.repository_id = run.repository_id AND summary.evaluation_id = evaluation.id AND summary.cell_id = cell.id
          AND summary.run_id = run.id AND summary.request_id = cell.request_id
          AND summary.worker_node_id = attempt.worker_node_id AND summary.worker_instance_id = attempt.worker_instance_id
          AND summary.lease_generation = attempt.lease_generation AND summary.frozen_at <= NEW.opened_at
          AND json_extract(summary.input_json, '$.sourcePromptSha256') IS json_extract(NEW.opening_json, '$.scope.inputRef.sourcePromptSha256')
          AND json_extract(summary.input_json, '$.outputSchemaSha256') IS json_extract(NEW.opening_json, '$.scope.inputRef.outputSchemaSha256')
          AND json_extract(summary.input_json, '$.contextSha256') IS json_extract(NEW.opening_json, '$.scope.inputRef.contextSha256')
          AND json_extract(summary.input_json, '$.actualPromptSha256') IS json_extract(NEW.opening_json, '$.scope.inputRef.actualPromptSha256')
          AND json_extract(summary.input_json, '$.sourcePromptSha256') IS json_extract(NEW.opening_json, '$.scope.promptSha256')
          AND json_extract(summary.input_json, '$.outputSchemaSha256') IS json_extract(NEW.opening_json, '$.scope.outputSchemaSha256')
          AND json_extract(summary.input_json, '$.authorizationId') IS cell.authorization_id
          AND json_extract(summary.input_json, '$.executionManifestSha256') IS evaluation.execution_manifest_sha256
      )))
  ) THEN RAISE(ABORT, 'model invocation opening requires its current exact evaluation lease') END;
END;

CREATE TRIGGER tr_model_invocation_submission_consistency BEFORE INSERT ON model_invocation_submissions
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 WHERE NOT EXISTS (SELECT parent, key FROM json_tree(NEW.receipt_set_json) WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1)
    AND NOT EXISTS (SELECT parent, key FROM json_tree(NEW.response_json) WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1)
    AND (json_type(NEW.receipt_set_json, '$') IS 'object' AND (SELECT COUNT(*) FROM json_each(NEW.receipt_set_json, '$')) = 10 AND NOT EXISTS (SELECT 1 FROM json_each(NEW.receipt_set_json, '$') WHERE key NOT IN ('schemaVersion', 'scope', 'scopeSha256', 'runtime', 'calls', 'closedAt', 'state', 'modelOutputSha256', 'observedIdentity', 'observedIdentitySha256')))
    AND json_extract(NEW.receipt_set_json, '$.schemaVersion') IN ('ModelInvocationReceiptSetV1','ModelInvocationReceiptSetV2')
    AND json_type(NEW.receipt_set_json, '$.calls') IS 'array'
    AND json_array_length(NEW.receipt_set_json, '$.calls') BETWEEN 0 AND 128
    AND (json_type(NEW.response_json, '$') IS 'object' AND (SELECT COUNT(*) FROM json_each(NEW.response_json, '$')) = 7 AND NOT EXISTS (SELECT 1 FROM json_each(NEW.response_json, '$') WHERE key NOT IN ('schemaVersion', 'invocationId', 'scopeSha256', 'receiptSetSha256', 'receivedAt', 'consistency', 'executionAccepted')))
    AND json_extract(NEW.response_json, '$.schemaVersion') IS 'ModelInvocationSubmissionV1'
    AND json_extract(NEW.response_json, '$.invocationId') IS NEW.invocation_id
    AND json_extract(NEW.response_json, '$.scopeSha256') IS NEW.scope_sha256
    AND json_extract(NEW.response_json, '$.receiptSetSha256') IS NEW.receipt_set_sha256
    AND json_extract(NEW.response_json, '$.receivedAt') IS NEW.received_at
    AND json_type(NEW.response_json, '$.executionAccepted') IS 'false'
    AND (json_type(NEW.response_json, '$.consistency') IS 'object' AND (SELECT COUNT(*) FROM json_each(NEW.response_json, '$.consistency')) = 3 AND NOT EXISTS (SELECT 1 FROM json_each(NEW.response_json, '$.consistency') WHERE key NOT IN ('state', 'reasons', 'observedIdentitySha256')))
    AND json_extract(NEW.response_json, '$.consistency.state') IN ('matched', 'unavailable', 'mismatched', 'invalid')
    AND json_type(NEW.response_json, '$.consistency.reasons') IS 'array'
    AND json_array_length(NEW.response_json, '$.consistency.reasons') BETWEEN 0 AND 17
    AND (json_type(NEW.response_json, '$.consistency.observedIdentitySha256') IS 'null' OR (json_type(NEW.response_json, '$.consistency.observedIdentitySha256') IS 'text' AND length(json_extract(NEW.response_json, '$.consistency.observedIdentitySha256')) = 64 AND length(CAST(json_extract(NEW.response_json, '$.consistency.observedIdentitySha256') AS BLOB)) = 64 AND json_extract(NEW.response_json, '$.consistency.observedIdentitySha256') NOT GLOB '*[^0-9a-f]*'))
    AND ((json_extract(NEW.response_json, '$.consistency.state') IS 'matched' AND json_array_length(NEW.response_json, '$.consistency.reasons') = 0 AND json_type(NEW.response_json, '$.consistency.observedIdentitySha256') IS 'text')
      OR (json_extract(NEW.response_json, '$.consistency.state') IS NOT 'matched' AND json_array_length(NEW.response_json, '$.consistency.reasons') > 0))
    AND (json_extract(NEW.response_json, '$.consistency.state') IS NOT 'invalid' OR json_type(NEW.response_json, '$.consistency.observedIdentitySha256') IS 'null')
    AND NOT EXISTS (SELECT value FROM json_each(NEW.response_json, '$.consistency.reasons') GROUP BY value HAVING COUNT(*) != 1)) THEN RAISE(ABORT, 'model invocation submission has invalid metadata') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM run_attempts AS attempt
    JOIN jobs AS job ON job.id = attempt.job_id
    JOIN workers AS worker ON worker.id = attempt.worker_id
      AND worker.node_id = attempt.worker_node_id AND worker.instance_id = attempt.worker_instance_id
    JOIN worker_node_credentials AS credential ON credential.worker_node_id = worker.node_id
    JOIN review_run_job_links AS link ON link.job_id = job.id AND link.activation_number = 1
    JOIN review_runs AS run ON run.id = link.review_run_id AND run.purpose = 'evaluation'
    JOIN review_run_requests AS request ON request.review_run_id = run.id AND request.request_id = link.request_id
    JOIN evaluation_cells AS cell ON cell.id = run.evaluation_cell_id AND cell.run_id = run.id
      AND cell.repository_id = run.repository_id AND cell.request_id = request.request_id
    JOIN evaluations AS evaluation ON evaluation.id = cell.evaluation_id AND evaluation.repository_id = cell.repository_id
    JOIN evaluation_seals AS evaluation_seal ON evaluation_seal.evaluation_id = evaluation.id
    JOIN evaluation_controls AS control ON control.evaluation_id = evaluation.id
    JOIN managed_repositories AS repository ON repository.id = cell.repository_id
    JOIN model_runtime_registrations AS registration ON registration.id = json_extract(run.plan_json, '$.modelRequirements.runtimeRegistration.registrationId')
      AND registration.registration_sha256 IS json_extract(run.plan_json, '$.modelRequirements.runtimeRegistration.registrationSha256')
      AND registration.identity_sha256 IS json_extract(run.plan_json, '$.modelRequirements.expectedModelIdentityDigest')
      AND CAST(registration.registration_json AS BLOB) IS CAST(json_extract(run.plan_json, '$.modelRuntimeRegistration') AS BLOB)
    JOIN model_invocation_openings AS opening ON opening.invocation_id = NEW.invocation_id AND opening.scope_sha256 = NEW.scope_sha256
    JOIN model_invocation_seals AS seal ON seal.invocation_id = opening.invocation_id AND seal.scope_sha256 = NEW.scope_sha256 AND seal.receipt_set_sha256 = NEW.receipt_set_sha256
    WHERE attempt.id = opening.run_attempt_id AND job.id = opening.job_id
      AND attempt.worker_node_id = opening.worker_node_id AND attempt.worker_instance_id = opening.worker_instance_id
      AND attempt.lease_generation = opening.lease_generation AND job.lease_generation = attempt.lease_generation
      AND job.current_run_attempt_id = attempt.id AND attempt.status IN ('leased', 'running') AND job.status IN ('leased', 'running')
      AND attempt.started_at <= NEW.received_at AND attempt.lease_expires_at > NEW.received_at
      AND attempt.execution_deadline_at > NEW.received_at AND attempt.no_progress_deadline_at > NEW.received_at
      AND job.cancellation_requested_at IS NULL AND worker.superseded_at IS NULL
      AND worker.status IN ('online', 'draining') AND credential.auth_state = 'active'
      AND repository.enabled = 1 AND cell.applicable = 1 AND control.status = 'active'
      AND run.request_epoch_id IS NULL AND job.request_epoch_id IS NULL
      AND json_extract(run.plan_json, '$.modelRequirements.required') IS 1
      AND json_extract(job.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
      AND json_extract(job.execution_json, '$.validation.runId') IS run.id
      AND json_extract(job.execution_json, '$.validation.requestId') IS cell.request_id
      AND CAST(json_extract(job.execution_json, '$.validation.modelRequirements') AS BLOB) IS CAST(json_extract(run.plan_json, '$.modelRequirements') AS BLOB)
      AND CAST(json_extract(job.execution_json, '$.validation.modelRuntimeRegistration') AS BLOB) IS CAST(registration.registration_json AS BLOB) AND opening.opened_at <= seal.recorded_at AND seal.recorded_at <= NEW.received_at
      AND ((json_extract(NEW.receipt_set_json, '$.schemaVersion') IS 'ModelInvocationReceiptSetV1' AND json_extract(opening.opening_json, '$.schemaVersion') IS 'ModelInvocationOpeningV1')
        OR (json_extract(NEW.receipt_set_json, '$.schemaVersion') IS 'ModelInvocationReceiptSetV2' AND json_extract(opening.opening_json, '$.schemaVersion') IS 'ModelInvocationOpeningV2'))
      AND CAST(json_extract(NEW.receipt_set_json, '$.scope') AS BLOB) IS CAST(json_extract(opening.opening_json, '$.scope') AS BLOB)
      AND json_extract(NEW.receipt_set_json, '$.scopeSha256') IS opening.scope_sha256
      AND CAST(json_extract(NEW.receipt_set_json, '$.runtime') AS BLOB) IS CAST(json_extract(opening.opening_json, '$.runtime') AS BLOB)
      AND json_type(NEW.receipt_set_json, '$.closedAt') IS json_type(seal.seal_json, '$.closedAt') AND json_extract(NEW.receipt_set_json, '$.closedAt') IS json_extract(seal.seal_json, '$.closedAt')
      AND json_type(NEW.receipt_set_json, '$.state') IS json_type(seal.seal_json, '$.state') AND json_extract(NEW.receipt_set_json, '$.state') IS json_extract(seal.seal_json, '$.state')
      AND json_type(NEW.receipt_set_json, '$.modelOutputSha256') IS json_type(seal.seal_json, '$.modelOutputSha256') AND json_extract(NEW.receipt_set_json, '$.modelOutputSha256') IS json_extract(seal.seal_json, '$.modelOutputSha256')
      AND json_type(NEW.receipt_set_json, '$.observedIdentitySha256') IS json_type(seal.seal_json, '$.observedIdentitySha256') AND json_extract(NEW.receipt_set_json, '$.observedIdentitySha256') IS json_extract(seal.seal_json, '$.observedIdentitySha256')
      AND json_array_length(NEW.receipt_set_json, '$.calls') IS json_extract(seal.seal_json, '$.callCount')
      AND json_extract(NEW.receipt_set_json, '$.calls[#-1].sha256') IS json_extract(seal.seal_json, '$.lastReceiptSha256')
  ) THEN RAISE(ABORT, 'model invocation submission requires its independently sealed exact evaluation lease') END;
END;

