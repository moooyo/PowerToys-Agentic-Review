-- Independently authenticated model invocation observations. No row authorizes model execution.
-- Raw Worker credentials and raw lease tokens are never retained by these tables.
CREATE TABLE model_invocation_openings (
  invocation_id TEXT NOT NULL CHECK (length(invocation_id) BETWEEN 1 AND 128 AND substr(invocation_id, 1, 1) GLOB '[A-Za-z0-9]' AND invocation_id NOT GLOB '*[^A-Za-z0-9._:-]*') PRIMARY KEY,
  run_attempt_id TEXT NOT NULL UNIQUE REFERENCES run_attempts(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  worker_node_id TEXT NOT NULL REFERENCES worker_node_credentials(worker_node_id) ON DELETE RESTRICT,
  worker_instance_id TEXT NOT NULL CHECK (length(worker_instance_id) BETWEEN 1 AND 128 AND substr(worker_instance_id, 1, 1) GLOB '[A-Za-z0-9]' AND worker_instance_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  lease_generation INTEGER NOT NULL CHECK (lease_generation BETWEEN 1 AND 9007199254740991),
  scope_sha256 TEXT NOT NULL CHECK (length(scope_sha256) = 64 AND length(CAST(scope_sha256 AS BLOB)) = 64 AND scope_sha256 NOT GLOB '*[^0-9a-f]*'),
  opening_json TEXT NOT NULL CHECK (length(CAST(opening_json AS BLOB)) BETWEEN 1 AND 32768 AND json_valid(opening_json) AND json_type(opening_json) IS 'object'),
  opening_sha256 TEXT NOT NULL CHECK (length(opening_sha256) = 64 AND length(CAST(opening_sha256 AS BLOB)) = 64 AND opening_sha256 NOT GLOB '*[^0-9a-f]*'),
  begin_intent_sha256 TEXT NOT NULL CHECK (length(begin_intent_sha256) = 64 AND length(CAST(begin_intent_sha256 AS BLOB)) = 64 AND begin_intent_sha256 NOT GLOB '*[^0-9a-f]*'),
  opened_at TEXT NOT NULL CHECK (length(opened_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', opened_at) IS opened_at),
  UNIQUE (invocation_id, scope_sha256),
  FOREIGN KEY (worker_node_id, worker_instance_id) REFERENCES workers(node_id, instance_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE model_invocation_seals (
  invocation_id TEXT PRIMARY KEY REFERENCES model_invocation_openings(invocation_id) ON DELETE RESTRICT,
  scope_sha256 TEXT NOT NULL CHECK (length(scope_sha256) = 64 AND length(CAST(scope_sha256 AS BLOB)) = 64 AND scope_sha256 NOT GLOB '*[^0-9a-f]*'),
  receipt_set_sha256 TEXT NOT NULL CHECK (length(receipt_set_sha256) = 64 AND length(CAST(receipt_set_sha256 AS BLOB)) = 64 AND receipt_set_sha256 NOT GLOB '*[^0-9a-f]*'),
  seal_json TEXT NOT NULL CHECK (length(CAST(seal_json AS BLOB)) BETWEEN 1 AND 32768 AND json_valid(seal_json) AND json_type(seal_json) IS 'object'),
  seal_sha256 TEXT NOT NULL CHECK (length(seal_sha256) = 64 AND length(CAST(seal_sha256 AS BLOB)) = 64 AND seal_sha256 NOT GLOB '*[^0-9a-f]*'),
  seal_intent_sha256 TEXT NOT NULL CHECK (length(seal_intent_sha256) = 64 AND length(CAST(seal_intent_sha256 AS BLOB)) = 64 AND seal_intent_sha256 NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) IS recorded_at),
  UNIQUE (invocation_id, scope_sha256, receipt_set_sha256),
  FOREIGN KEY (invocation_id, scope_sha256) REFERENCES model_invocation_openings(invocation_id, scope_sha256) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE model_invocation_submissions (
  invocation_id TEXT PRIMARY KEY REFERENCES model_invocation_seals(invocation_id) ON DELETE RESTRICT,
  scope_sha256 TEXT NOT NULL CHECK (length(scope_sha256) = 64 AND length(CAST(scope_sha256 AS BLOB)) = 64 AND scope_sha256 NOT GLOB '*[^0-9a-f]*'),
  receipt_set_sha256 TEXT NOT NULL CHECK (length(receipt_set_sha256) = 64 AND length(CAST(receipt_set_sha256 AS BLOB)) = 64 AND receipt_set_sha256 NOT GLOB '*[^0-9a-f]*'),
  receipt_set_json TEXT NOT NULL CHECK (length(CAST(receipt_set_json AS BLOB)) BETWEEN 1 AND 1048576 AND json_valid(receipt_set_json) AND json_type(receipt_set_json) IS 'object'),
  response_json TEXT NOT NULL CHECK (length(CAST(response_json AS BLOB)) BETWEEN 1 AND 32768 AND json_valid(response_json) AND json_type(response_json) IS 'object'),
  response_sha256 TEXT NOT NULL CHECK (length(response_sha256) = 64 AND length(CAST(response_sha256 AS BLOB)) = 64 AND response_sha256 NOT GLOB '*[^0-9a-f]*'),
  submit_intent_sha256 TEXT NOT NULL CHECK (length(submit_intent_sha256) = 64 AND length(CAST(submit_intent_sha256 AS BLOB)) = 64 AND submit_intent_sha256 NOT GLOB '*[^0-9a-f]*'),
  received_at TEXT NOT NULL CHECK (length(received_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', received_at) IS received_at),
  FOREIGN KEY (invocation_id, scope_sha256, receipt_set_sha256)
    REFERENCES model_invocation_seals(invocation_id, scope_sha256, receipt_set_sha256) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER tr_model_invocation_openings_no_replace BEFORE INSERT ON model_invocation_openings
WHEN EXISTS (SELECT 1 FROM model_invocation_openings WHERE invocation_id = NEW.invocation_id) OR EXISTS (SELECT 1 FROM model_invocation_openings WHERE run_attempt_id = NEW.run_attempt_id)
BEGIN SELECT RAISE(ABORT, 'model invocation records cannot be replaced'); END;
CREATE TRIGGER tr_model_invocation_openings_no_update BEFORE UPDATE ON model_invocation_openings
BEGIN SELECT RAISE(ABORT, 'model invocation records are immutable'); END;
CREATE TRIGGER tr_model_invocation_openings_no_delete BEFORE DELETE ON model_invocation_openings
BEGIN SELECT RAISE(ABORT, 'model invocation records cannot be deleted'); END;

CREATE TRIGGER tr_model_invocation_seals_no_replace BEFORE INSERT ON model_invocation_seals
WHEN EXISTS (SELECT 1 FROM model_invocation_seals WHERE invocation_id = NEW.invocation_id)
BEGIN SELECT RAISE(ABORT, 'model invocation records cannot be replaced'); END;
CREATE TRIGGER tr_model_invocation_seals_no_update BEFORE UPDATE ON model_invocation_seals
BEGIN SELECT RAISE(ABORT, 'model invocation records are immutable'); END;
CREATE TRIGGER tr_model_invocation_seals_no_delete BEFORE DELETE ON model_invocation_seals
BEGIN SELECT RAISE(ABORT, 'model invocation records cannot be deleted'); END;

CREATE TRIGGER tr_model_invocation_submissions_no_replace BEFORE INSERT ON model_invocation_submissions
WHEN EXISTS (SELECT 1 FROM model_invocation_submissions WHERE invocation_id = NEW.invocation_id)
BEGIN SELECT RAISE(ABORT, 'model invocation records cannot be replaced'); END;
CREATE TRIGGER tr_model_invocation_submissions_no_update BEFORE UPDATE ON model_invocation_submissions
BEGIN SELECT RAISE(ABORT, 'model invocation records are immutable'); END;
CREATE TRIGGER tr_model_invocation_submissions_no_delete BEFORE DELETE ON model_invocation_submissions
BEGIN SELECT RAISE(ABORT, 'model invocation records cannot be deleted'); END;

CREATE TRIGGER tr_model_invocation_opening_consistency BEFORE INSERT ON model_invocation_openings
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 WHERE NOT EXISTS (SELECT parent, key FROM json_tree(NEW.opening_json) WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1)
    AND (json_type(NEW.opening_json, '$') IS 'object' AND (SELECT COUNT(*) FROM json_each(NEW.opening_json, '$')) = 5 AND NOT EXISTS (SELECT 1 FROM json_each(NEW.opening_json, '$') WHERE key NOT IN ('schemaVersion', 'scope', 'scopeSha256', 'runtime', 'openedAt')))
    AND json_extract(NEW.opening_json, '$.schemaVersion') IS 'ModelInvocationOpeningV1'
    AND json_extract(NEW.opening_json, '$.openedAt') IS NEW.opened_at
    AND json_extract(NEW.opening_json, '$.scopeSha256') IS NEW.scope_sha256
    AND (json_type(NEW.opening_json, '$.scope') IS 'object' AND (SELECT COUNT(*) FROM json_each(NEW.opening_json, '$.scope')) = 18 AND NOT EXISTS (SELECT 1 FROM json_each(NEW.opening_json, '$.scope') WHERE key NOT IN ('schemaVersion', 'repositoryId', 'evaluationId', 'cellId', 'runId', 'requestId', 'jobId', 'attemptId', 'invocationId', 'authorizationId', 'executionManifestSha256', 'promptSha256', 'outputSchemaSha256', 'expectedModelIdentitySha256', 'requestedModel', 'workerNodeId', 'workerInstanceId', 'leaseGeneration')))
    AND json_extract(NEW.opening_json, '$.scope.schemaVersion') IS 'ModelInvocationScopeV1'
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
  ) THEN RAISE(ABORT, 'model invocation opening requires its current exact evaluation lease') END;
END;

CREATE TRIGGER tr_model_invocation_seal_consistency BEFORE INSERT ON model_invocation_seals
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 WHERE NOT EXISTS (SELECT parent, key FROM json_tree(NEW.seal_json) WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1)
    AND (json_type(NEW.seal_json, '$') IS 'object' AND (SELECT COUNT(*) FROM json_each(NEW.seal_json, '$')) = 13 AND NOT EXISTS (SELECT 1 FROM json_each(NEW.seal_json, '$') WHERE key NOT IN ('schemaVersion', 'invocationId', 'scopeSha256', 'receiptSetSha256', 'closedAt', 'state', 'callCount', 'lastReceiptSha256', 'modelOutputSha256', 'observedIdentitySha256', 'processClosed', 'relayClosed', 'recordedAt')))
    AND json_extract(NEW.seal_json, '$.schemaVersion') IS 'ModelInvocationSealV1'
    AND (json_type(NEW.seal_json, '$.closedAt') IS 'text' AND length(json_extract(NEW.seal_json, '$.closedAt')) BETWEEN 20 AND 64 AND instr(json_extract(NEW.seal_json, '$.closedAt'), char(0)) = 0)
    AND json_extract(NEW.seal_json, '$.state') IN ('closed', 'cancelled')
    AND (json_type(NEW.seal_json, '$.callCount') IS 'integer' AND json_extract(NEW.seal_json, '$.callCount') BETWEEN 0 AND 128)
    AND json_type(NEW.seal_json, '$.processClosed') IN ('true', 'false')
    AND json_type(NEW.seal_json, '$.relayClosed') IN ('true', 'false')
    AND (json_type(NEW.seal_json, '$.lastReceiptSha256') IS 'null' OR (json_type(NEW.seal_json, '$.lastReceiptSha256') IS 'text' AND length(json_extract(NEW.seal_json, '$.lastReceiptSha256')) = 64 AND length(CAST(json_extract(NEW.seal_json, '$.lastReceiptSha256') AS BLOB)) = 64 AND json_extract(NEW.seal_json, '$.lastReceiptSha256') NOT GLOB '*[^0-9a-f]*'))
    AND (json_type(NEW.seal_json, '$.modelOutputSha256') IS 'null' OR (json_type(NEW.seal_json, '$.modelOutputSha256') IS 'text' AND length(json_extract(NEW.seal_json, '$.modelOutputSha256')) = 64 AND length(CAST(json_extract(NEW.seal_json, '$.modelOutputSha256') AS BLOB)) = 64 AND json_extract(NEW.seal_json, '$.modelOutputSha256') NOT GLOB '*[^0-9a-f]*'))
    AND (json_type(NEW.seal_json, '$.observedIdentitySha256') IS 'null' OR (json_type(NEW.seal_json, '$.observedIdentitySha256') IS 'text' AND length(json_extract(NEW.seal_json, '$.observedIdentitySha256')) = 64 AND length(CAST(json_extract(NEW.seal_json, '$.observedIdentitySha256') AS BLOB)) = 64 AND json_extract(NEW.seal_json, '$.observedIdentitySha256') NOT GLOB '*[^0-9a-f]*'))
    AND ((json_extract(NEW.seal_json, '$.callCount') = 0) = (json_type(NEW.seal_json, '$.lastReceiptSha256') IS 'null'))
    AND (json_extract(NEW.seal_json, '$.callCount') != 0 OR (json_type(NEW.seal_json, '$.modelOutputSha256') IS 'null' AND json_type(NEW.seal_json, '$.observedIdentitySha256') IS 'null'))
    AND (json_type(NEW.seal_json, '$.modelOutputSha256') IS 'null' OR (json_extract(NEW.seal_json, '$.state') IS 'closed' AND json_extract(NEW.seal_json, '$.processClosed') IS 1 AND json_extract(NEW.seal_json, '$.relayClosed') IS 1))
    AND json_extract(NEW.seal_json, '$.invocationId') IS NEW.invocation_id
    AND json_extract(NEW.seal_json, '$.scopeSha256') IS NEW.scope_sha256
    AND json_extract(NEW.seal_json, '$.receiptSetSha256') IS NEW.receipt_set_sha256
    AND json_extract(NEW.seal_json, '$.recordedAt') IS NEW.recorded_at) THEN RAISE(ABORT, 'model invocation seal has invalid metadata') END;
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
    WHERE attempt.id = opening.run_attempt_id AND job.id = opening.job_id
      AND attempt.worker_node_id = opening.worker_node_id AND attempt.worker_instance_id = opening.worker_instance_id
      AND attempt.lease_generation = opening.lease_generation AND job.lease_generation = attempt.lease_generation
      AND job.current_run_attempt_id = attempt.id AND attempt.status IN ('leased', 'running') AND job.status IN ('leased', 'running')
      AND attempt.started_at <= NEW.recorded_at AND attempt.lease_expires_at > NEW.recorded_at
      AND attempt.execution_deadline_at > NEW.recorded_at AND attempt.no_progress_deadline_at > NEW.recorded_at
      AND job.cancellation_requested_at IS NULL AND worker.superseded_at IS NULL
      AND worker.status IN ('online', 'draining') AND credential.auth_state = 'active'
      AND repository.enabled = 1 AND cell.applicable = 1 AND control.status = 'active'
      AND run.request_epoch_id IS NULL AND job.request_epoch_id IS NULL
      AND json_extract(run.plan_json, '$.modelRequirements.required') IS 1
      AND json_extract(job.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
      AND json_extract(job.execution_json, '$.validation.runId') IS run.id
      AND json_extract(job.execution_json, '$.validation.requestId') IS cell.request_id
      AND CAST(json_extract(job.execution_json, '$.validation.modelRequirements') AS BLOB) IS CAST(json_extract(run.plan_json, '$.modelRequirements') AS BLOB)
      AND CAST(json_extract(job.execution_json, '$.validation.modelRuntimeRegistration') AS BLOB) IS CAST(registration.registration_json AS BLOB) AND opening.opened_at <= NEW.recorded_at
  ) THEN RAISE(ABORT, 'model invocation seal requires its current exact evaluation lease') END;
END;

CREATE TRIGGER tr_model_invocation_submission_consistency BEFORE INSERT ON model_invocation_submissions
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 WHERE NOT EXISTS (SELECT parent, key FROM json_tree(NEW.receipt_set_json) WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1)
    AND NOT EXISTS (SELECT parent, key FROM json_tree(NEW.response_json) WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1)
    AND (json_type(NEW.receipt_set_json, '$') IS 'object' AND (SELECT COUNT(*) FROM json_each(NEW.receipt_set_json, '$')) = 10 AND NOT EXISTS (SELECT 1 FROM json_each(NEW.receipt_set_json, '$') WHERE key NOT IN ('schemaVersion', 'scope', 'scopeSha256', 'runtime', 'calls', 'closedAt', 'state', 'modelOutputSha256', 'observedIdentity', 'observedIdentitySha256')))
    AND json_extract(NEW.receipt_set_json, '$.schemaVersion') IS 'ModelInvocationReceiptSetV1'
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
