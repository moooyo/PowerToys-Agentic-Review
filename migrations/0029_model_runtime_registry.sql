-- Platform-owned model runtime registrations retain immutable public identity snapshots.
-- Mutable enablement follows an append-only audit; historical receipts never depend on it.

CREATE TABLE model_runtime_registrations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128 AND instr(id, char(0)) = 0
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]' AND id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128 AND instr(name, char(0)) = 0 AND trim(name) = name),
  requested_model TEXT NOT NULL CHECK (length(requested_model) BETWEEN 1 AND 1024 AND instr(requested_model, char(0)) = 0 AND trim(requested_model) = requested_model),
  identity_sha256 TEXT NOT NULL CHECK (length(identity_sha256) = 64 AND length(CAST(identity_sha256 AS BLOB)) = 64 AND identity_sha256 NOT GLOB '*[^0-9a-f]*'),
  registration_sha256 TEXT NOT NULL CHECK (length(registration_sha256) = 64 AND length(CAST(registration_sha256 AS BLOB)) = 64 AND registration_sha256 NOT GLOB '*[^0-9a-f]*'),
  registration_json TEXT NOT NULL CHECK (
    length(CAST(registration_json AS BLOB)) BETWEEN 1 AND 65536
    AND json_valid(registration_json) AND json_type(registration_json) IS 'object'
    AND json_extract(registration_json, '$.schemaVersion') IS 'ModelRuntimeRegistrationV1'
  ),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_model_runtime_registrations_history
  ON model_runtime_registrations (created_at DESC, id DESC);

CREATE TABLE model_runtime_controls (
  registration_id TEXT PRIMARY KEY REFERENCES model_runtime_registrations(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_model_runtime_controls_enabled ON model_runtime_controls (enabled, registration_id);

CREATE TABLE model_runtime_audit (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128 AND instr(id, char(0)) = 0
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]' AND id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  registration_id TEXT NOT NULL REFERENCES model_runtime_registrations(id) ON DELETE RESTRICT,
  change_id TEXT NOT NULL UNIQUE CHECK (length(change_id) BETWEEN 1 AND 128 AND instr(change_id, char(0)) = 0
    AND substr(change_id, 1, 1) GLOB '[A-Za-z0-9]' AND change_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  operation TEXT NOT NULL CHECK (operation IN ('register', 'control')),
  previous_version INTEGER NOT NULL CHECK (previous_version BETWEEN 0 AND 9007199254740990),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991 AND version = previous_version + 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  reason TEXT CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 2048 AND instr(reason, char(0)) = 0 AND length(trim(reason)) > 0)),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (registration_id, version),
  CHECK ((operation = 'register' AND previous_version = 0 AND version = 1 AND reason IS NULL)
    OR (operation = 'control' AND previous_version >= 1 AND reason IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_model_runtime_audit_history
  ON model_runtime_audit (registration_id, created_at DESC, id DESC);

CREATE TABLE model_runtime_mutation_receipts (
  change_id TEXT PRIMARY KEY REFERENCES model_runtime_audit(change_id) ON DELETE RESTRICT,
  registration_id TEXT NOT NULL REFERENCES model_runtime_registrations(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('register', 'control')),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64 AND length(CAST(intent_digest AS BLOB)) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
  response_sha256 TEXT NOT NULL CHECK (length(response_sha256) = 64 AND length(CAST(response_sha256 AS BLOB)) = 64 AND response_sha256 NOT GLOB '*[^0-9a-f]*'),
  response_json TEXT NOT NULL CHECK (
    length(CAST(response_json AS BLOB)) BETWEEN 1 AND 131072
    AND json_valid(response_json) AND json_type(response_json) IS 'object'),
  previous_version INTEGER NOT NULL CHECK (previous_version BETWEEN 0 AND 9007199254740990),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991 AND version = previous_version + 1),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (registration_id, version)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_model_runtime_receipts_history
  ON model_runtime_mutation_receipts (registration_id, created_at DESC, change_id DESC);

CREATE TRIGGER tr_model_runtime_registration_insert BEFORE INSERT ON model_runtime_registrations
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM model_runtime_registrations WHERE id = NEW.id)
    THEN RAISE(ABORT, 'model runtime registrations cannot be replaced') END;
  SELECT CASE WHEN EXISTS (
    SELECT parent, key FROM json_tree(NEW.registration_json)
    WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1
  ) THEN RAISE(ABORT, 'model runtime registration keys must be unique') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM json_each(NEW.registration_json)) != 8
    OR EXISTS (SELECT 1 FROM json_each(NEW.registration_json) WHERE key NOT IN
      ('schemaVersion', 'id', 'name', 'requestedModel', 'identity', 'identitySha256', 'createdAt', 'createdBy'))
    OR json_type(NEW.registration_json, '$.id') IS NOT 'text'
    OR json_extract(NEW.registration_json, '$.id') IS NOT NEW.id
    OR json_type(NEW.registration_json, '$.name') IS NOT 'text'
    OR json_extract(NEW.registration_json, '$.name') IS NOT NEW.name
    OR json_type(NEW.registration_json, '$.requestedModel') IS NOT 'text'
    OR json_extract(NEW.registration_json, '$.requestedModel') IS NOT NEW.requested_model
    OR json_type(NEW.registration_json, '$.identitySha256') IS NOT 'text'
    OR json_extract(NEW.registration_json, '$.identitySha256') IS NOT NEW.identity_sha256
    OR json_type(NEW.registration_json, '$.createdAt') IS NOT 'text'
    OR json_extract(NEW.registration_json, '$.createdAt') IS NOT NEW.created_at
    OR json_type(NEW.registration_json, '$.createdBy') IS NOT 'object'
    OR (SELECT COUNT(*) FROM json_each(NEW.registration_json, '$.createdBy')) != 2
    OR EXISTS (SELECT 1 FROM json_each(NEW.registration_json, '$.createdBy') WHERE key NOT IN ('issuer', 'subject'))
    OR json_type(NEW.registration_json, '$.createdBy.issuer') IS NOT 'text'
    OR json_extract(NEW.registration_json, '$.createdBy.issuer') IS NOT NEW.actor_issuer
    OR json_type(NEW.registration_json, '$.createdBy.subject') IS NOT 'text'
    OR json_extract(NEW.registration_json, '$.createdBy.subject') IS NOT NEW.actor_subject
    THEN RAISE(ABORT, 'model runtime registration must match its immutable columns') END;
  SELECT CASE WHEN json_type(NEW.registration_json, '$.identity') IS NOT 'object'
    OR (SELECT COUNT(*) FROM json_each(NEW.registration_json, '$.identity')) != 6
    OR EXISTS (SELECT 1 FROM json_each(NEW.registration_json, '$.identity') WHERE key NOT IN
      ('schemaVersion', 'providerId', 'endpointSha256', 'client', 'relay', 'modelId'))
    OR json_extract(NEW.registration_json, '$.identity.schemaVersion') IS NOT 'ModelRuntimeIdentityV1'
    OR json_type(NEW.registration_json, '$.identity.providerId') IS NOT 'text'
    OR length(json_extract(NEW.registration_json, '$.identity.providerId')) NOT BETWEEN 1 AND 128
    OR instr(json_extract(NEW.registration_json, '$.identity.providerId'), char(0)) != 0
    OR json_type(NEW.registration_json, '$.identity.modelId') IS NOT 'text'
    OR length(json_extract(NEW.registration_json, '$.identity.modelId')) NOT BETWEEN 1 AND 1024
    OR instr(json_extract(NEW.registration_json, '$.identity.modelId'), char(0)) != 0
    OR json_type(NEW.registration_json, '$.identity.client') IS NOT 'object'
    OR (SELECT COUNT(*) FROM json_each(NEW.registration_json, '$.identity.client')) != 4
    OR EXISTS (SELECT 1 FROM json_each(NEW.registration_json, '$.identity.client') WHERE key NOT IN
      ('kind', 'version', 'executableSha256', 'launchPolicySha256'))
    OR json_extract(NEW.registration_json, '$.identity.client.kind') IS NOT 'codex_cli'
    OR json_type(NEW.registration_json, '$.identity.client.version') IS NOT 'text'
    OR length(json_extract(NEW.registration_json, '$.identity.client.version')) NOT BETWEEN 1 AND 128
    OR instr(json_extract(NEW.registration_json, '$.identity.client.version'), char(0)) != 0
    OR json_type(NEW.registration_json, '$.identity.relay') IS NOT 'object'
    OR (SELECT COUNT(*) FROM json_each(NEW.registration_json, '$.identity.relay')) != 2
    OR EXISTS (SELECT 1 FROM json_each(NEW.registration_json, '$.identity.relay') WHERE key NOT IN
      ('implementationSha256', 'policySha256'))
    OR EXISTS (
      SELECT 1 FROM (
        SELECT '$.identity.endpointSha256' AS path UNION ALL
        SELECT '$.identity.client.executableSha256' UNION ALL
        SELECT '$.identity.client.launchPolicySha256' UNION ALL
        SELECT '$.identity.relay.implementationSha256' UNION ALL
        SELECT '$.identity.relay.policySha256'
      ) AS commitments
      WHERE json_type(NEW.registration_json, commitments.path) IS NOT 'text'
        OR length(json_extract(NEW.registration_json, commitments.path)) != 64
        OR length(CAST(json_extract(NEW.registration_json, commitments.path) AS BLOB)) != 64
        OR json_extract(NEW.registration_json, commitments.path) GLOB '*[^0-9a-f]*'
    ) THEN RAISE(ABORT, 'model runtime identity must retain its complete public commitments') END;
END;
CREATE TRIGGER tr_model_runtime_registration_no_update BEFORE UPDATE ON model_runtime_registrations
BEGIN SELECT RAISE(ABORT, 'model runtime registrations are immutable'); END;
CREATE TRIGGER tr_model_runtime_registration_no_delete BEFORE DELETE ON model_runtime_registrations
BEGIN SELECT RAISE(ABORT, 'model runtime registrations are immutable'); END;

CREATE TRIGGER tr_model_runtime_audit_insert BEFORE INSERT ON model_runtime_audit
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM model_runtime_audit
    WHERE id = NEW.id OR change_id = NEW.change_id
      OR (registration_id = NEW.registration_id AND version = NEW.version))
    THEN RAISE(ABORT, 'model runtime audit cannot be replaced') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM model_runtime_registrations AS registration
    WHERE registration.id = NEW.registration_id AND registration.created_at <= NEW.created_at
      AND (NEW.operation != 'register' OR (registration.created_at IS NEW.created_at
        AND registration.actor_issuer IS NEW.actor_issuer AND registration.actor_subject IS NEW.actor_subject)))
    THEN RAISE(ABORT, 'model runtime audit requires its immutable registration') END;
  SELECT CASE WHEN (NEW.operation = 'register' AND EXISTS (
      SELECT 1 FROM model_runtime_controls WHERE registration_id = NEW.registration_id))
    OR (NEW.operation = 'control' AND NOT EXISTS (
      SELECT 1 FROM model_runtime_controls WHERE registration_id = NEW.registration_id
        AND version = NEW.previous_version AND updated_at <= NEW.created_at))
    THEN RAISE(ABORT, 'model runtime audit does not follow the current control') END;
END;
CREATE TRIGGER tr_model_runtime_audit_no_update BEFORE UPDATE ON model_runtime_audit
BEGIN SELECT RAISE(ABORT, 'model runtime audit is immutable'); END;
CREATE TRIGGER tr_model_runtime_audit_no_delete BEFORE DELETE ON model_runtime_audit
BEGIN SELECT RAISE(ABORT, 'model runtime audit is immutable'); END;

CREATE TRIGGER tr_model_runtime_control_insert BEFORE INSERT ON model_runtime_controls
WHEN EXISTS (SELECT 1 FROM model_runtime_controls WHERE registration_id = NEW.registration_id)
  OR NOT EXISTS (SELECT 1 FROM model_runtime_audit WHERE registration_id = NEW.registration_id
    AND operation = 'register' AND previous_version = 0 AND version = NEW.version
    AND enabled = NEW.enabled AND created_at IS NEW.updated_at
    AND actor_issuer IS NEW.actor_issuer AND actor_subject IS NEW.actor_subject)
BEGIN SELECT RAISE(ABORT, 'model runtime controls require their immutable registration audit'); END;
CREATE TRIGGER tr_model_runtime_control_update BEFORE UPDATE ON model_runtime_controls
WHEN NEW.registration_id IS NOT OLD.registration_id OR NEW.version != OLD.version + 1
  OR NEW.updated_at < OLD.updated_at
  OR NOT EXISTS (SELECT 1 FROM model_runtime_audit WHERE registration_id = NEW.registration_id
    AND operation = 'control' AND previous_version = OLD.version AND version = NEW.version
    AND enabled = NEW.enabled AND created_at IS NEW.updated_at
    AND actor_issuer IS NEW.actor_issuer AND actor_subject IS NEW.actor_subject)
BEGIN SELECT RAISE(ABORT, 'model runtime controls require their next immutable audit'); END;
CREATE TRIGGER tr_model_runtime_control_no_delete BEFORE DELETE ON model_runtime_controls
BEGIN SELECT RAISE(ABORT, 'model runtime controls retain their historical identity'); END;
CREATE TRIGGER tr_model_runtime_audit_apply AFTER INSERT ON model_runtime_audit
BEGIN
  INSERT INTO model_runtime_controls (registration_id, version, enabled, updated_at, actor_issuer, actor_subject)
    SELECT NEW.registration_id, NEW.version, NEW.enabled, NEW.created_at, NEW.actor_issuer, NEW.actor_subject
    WHERE NEW.operation = 'register';
  UPDATE model_runtime_controls SET version = NEW.version, enabled = NEW.enabled,
    updated_at = NEW.created_at, actor_issuer = NEW.actor_issuer, actor_subject = NEW.actor_subject
    WHERE NEW.operation = 'control' AND registration_id = NEW.registration_id AND version = NEW.previous_version;
END;

CREATE TRIGGER tr_model_runtime_receipt_insert BEFORE INSERT ON model_runtime_mutation_receipts
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM model_runtime_mutation_receipts
    WHERE change_id = NEW.change_id OR (registration_id = NEW.registration_id AND version = NEW.version))
    THEN RAISE(ABORT, 'model runtime mutation receipts cannot be replaced') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM model_runtime_audit WHERE change_id = NEW.change_id
    AND registration_id = NEW.registration_id AND operation = NEW.operation
    AND previous_version = NEW.previous_version AND version = NEW.version
    AND actor_issuer IS NEW.actor_issuer AND actor_subject IS NEW.actor_subject
    AND created_at IS NEW.created_at)
    THEN RAISE(ABORT, 'model runtime mutation receipt must match its immutable audit') END;
  SELECT CASE WHEN EXISTS (
    SELECT parent, key FROM json_tree(NEW.response_json)
    WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1
  ) THEN RAISE(ABORT, 'model runtime receipt keys must be unique') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM json_each(NEW.response_json)) != 3
    OR EXISTS (SELECT 1 FROM json_each(NEW.response_json) WHERE key NOT IN ('schemaVersion', 'registration', 'control'))
    OR json_extract(NEW.response_json, '$.schemaVersion') IS NOT 'ModelRuntimeStatusV1'
    OR json_type(NEW.response_json, '$.registration') IS NOT 'object'
    OR json_type(NEW.response_json, '$.control') IS NOT 'object'
    OR (SELECT COUNT(*) FROM json_each(NEW.response_json, '$.control')) != 6
    OR EXISTS (SELECT 1 FROM json_each(NEW.response_json, '$.control') WHERE key NOT IN
      ('schemaVersion', 'registrationId', 'version', 'enabled', 'updatedAt', 'updatedBy'))
    OR json_extract(NEW.response_json, '$.control.schemaVersion') IS NOT 'ModelRuntimeControlV1'
    OR json_type(NEW.response_json, '$.control.registrationId') IS NOT 'text'
    OR json_extract(NEW.response_json, '$.control.registrationId') IS NOT NEW.registration_id
    OR json_type(NEW.response_json, '$.control.version') IS NOT 'integer'
    OR json_extract(NEW.response_json, '$.control.version') IS NOT NEW.version
    OR json_type(NEW.response_json, '$.control.enabled') NOT IN ('true', 'false')
    OR json_type(NEW.response_json, '$.control.updatedAt') IS NOT 'text'
    OR json_extract(NEW.response_json, '$.control.updatedAt') IS NOT NEW.created_at
    OR json_type(NEW.response_json, '$.control.updatedBy') IS NOT 'object'
    OR (SELECT COUNT(*) FROM json_each(NEW.response_json, '$.control.updatedBy')) != 2
    OR EXISTS (SELECT 1 FROM json_each(NEW.response_json, '$.control.updatedBy') WHERE key NOT IN ('issuer', 'subject'))
    OR json_type(NEW.response_json, '$.control.updatedBy.issuer') IS NOT 'text'
    OR json_extract(NEW.response_json, '$.control.updatedBy.issuer') IS NOT NEW.actor_issuer
    OR json_type(NEW.response_json, '$.control.updatedBy.subject') IS NOT 'text'
    OR json_extract(NEW.response_json, '$.control.updatedBy.subject') IS NOT NEW.actor_subject
    OR NOT EXISTS (SELECT 1 FROM model_runtime_registrations AS registration
      JOIN model_runtime_audit AS audit ON audit.registration_id = registration.id
      WHERE registration.id = NEW.registration_id AND audit.change_id = NEW.change_id
        AND CAST(json_extract(NEW.response_json, '$.registration') AS BLOB) IS CAST(registration.registration_json AS BLOB)
        AND json_extract(NEW.response_json, '$.control.enabled') IS audit.enabled)
    THEN RAISE(ABORT, 'model runtime receipt must retain its exact historical status') END;
END;
CREATE TRIGGER tr_model_runtime_receipt_no_update BEFORE UPDATE ON model_runtime_mutation_receipts
BEGIN SELECT RAISE(ABORT, 'model runtime mutation receipts are immutable'); END;
CREATE TRIGGER tr_model_runtime_receipt_no_delete BEFORE DELETE ON model_runtime_mutation_receipts
BEGIN SELECT RAISE(ABORT, 'model runtime mutation receipts are immutable'); END;

-- New evaluations may select only a currently enabled registration. Existing immutable
-- plans and jobs remain bound to their frozen snapshot after subsequent control changes.
CREATE TRIGGER tr_evaluation_runtime_registration_insert BEFORE INSERT ON evaluations
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.configuration_manifest_json) AS arm
    WHERE arm.key IN ('baseline', 'candidate') AND NOT EXISTS (
      SELECT 1 WHERE arm.type IS 'object'
        AND (SELECT COUNT(*) FROM json_each(arm.value))
          = 3 + (json_type(arm.value, '$.modelRuntimeRegistration') IS 'object')
        AND NOT EXISTS (SELECT 1 FROM json_each(arm.value) WHERE key NOT IN
          ('profileVersion', 'prompt', 'modelRequirements', 'modelRuntimeRegistration'))
        AND NOT EXISTS (SELECT parent, key FROM json_tree(arm.value)
          WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1)
        AND json_type(arm.value, '$.modelRequirements') IS 'object'
        AND (SELECT COUNT(*) FROM json_each(arm.value, '$.modelRequirements'))
          = 2 + (json_type(arm.value, '$.modelRequirements.runtimeRegistration') IS 'object')
        AND NOT EXISTS (SELECT 1 FROM json_each(arm.value, '$.modelRequirements') WHERE key NOT IN
          ('required', 'expectedModelIdentityDigest', 'runtimeRegistration'))
        AND json_type(arm.value, '$.modelRequirements.required') IN ('true', 'false')
        AND (json_type(arm.value, '$.modelRequirements.expectedModelIdentityDigest') IS 'null'
          OR (json_type(arm.value, '$.modelRequirements.expectedModelIdentityDigest') IS 'text'
            AND length(json_extract(arm.value, '$.modelRequirements.expectedModelIdentityDigest')) = 64
            AND length(CAST(json_extract(arm.value, '$.modelRequirements.expectedModelIdentityDigest') AS BLOB)) = 64
            AND json_extract(arm.value, '$.modelRequirements.expectedModelIdentityDigest') NOT GLOB '*[^0-9a-f]*'))
        AND ((json_type(arm.value, '$.modelRequirements.runtimeRegistration') IS NULL
            AND json_type(arm.value, '$.modelRuntimeRegistration') IS NULL)
          OR (json_type(arm.value, '$.modelRequirements.runtimeRegistration') IS 'object'
            AND (SELECT COUNT(*) FROM json_each(arm.value, '$.modelRequirements.runtimeRegistration')) = 2
            AND NOT EXISTS (SELECT 1 FROM json_each(arm.value, '$.modelRequirements.runtimeRegistration')
              WHERE key NOT IN ('registrationId', 'registrationSha256'))
            AND json_type(arm.value, '$.modelRequirements.runtimeRegistration.registrationId') IS 'text'
            AND json_type(arm.value, '$.modelRequirements.runtimeRegistration.registrationSha256') IS 'text'
            AND json_type(arm.value, '$.modelRuntimeRegistration') IS 'object'
            AND EXISTS (SELECT 1 FROM model_runtime_registrations AS registration
              JOIN model_runtime_controls AS control ON control.registration_id = registration.id AND control.enabled = 1
              WHERE registration.id IS json_extract(arm.value, '$.modelRequirements.runtimeRegistration.registrationId')
                AND registration.registration_sha256 IS json_extract(arm.value, '$.modelRequirements.runtimeRegistration.registrationSha256')
                AND registration.identity_sha256 IS json_extract(arm.value, '$.modelRequirements.expectedModelIdentityDigest')
                AND CAST(registration.registration_json AS BLOB) IS CAST(json_extract(arm.value, '$.modelRuntimeRegistration') AS BLOB)
                AND registration.created_at <= NEW.created_at AND control.updated_at <= NEW.created_at)))
    )
  ) THEN RAISE(ABORT, 'evaluation model requirements must retain an enabled registered snapshot or the historical shape') END;
END;

CREATE TRIGGER tr_evaluation_run_runtime_registration_insert BEFORE INSERT ON review_runs
WHEN NEW.purpose = 'evaluation'
BEGIN
  SELECT CASE WHEN NOT (
    (json_type(NEW.plan_json, '$.modelRequirements.runtimeRegistration') IS NULL
      AND json_type(NEW.plan_json, '$.modelRuntimeRegistration') IS NULL)
    OR (json_type(NEW.plan_json, '$.modelRequirements.runtimeRegistration') IS 'object'
      AND (SELECT COUNT(*) FROM json_each(NEW.plan_json, '$.modelRequirements.runtimeRegistration')) = 2
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.plan_json, '$.modelRequirements.runtimeRegistration')
        WHERE key NOT IN ('registrationId', 'registrationSha256'))
      AND json_type(NEW.plan_json, '$.modelRequirements.runtimeRegistration.registrationId') IS 'text'
      AND json_type(NEW.plan_json, '$.modelRequirements.runtimeRegistration.registrationSha256') IS 'text'
      AND json_type(NEW.plan_json, '$.modelRuntimeRegistration') IS 'object'
      AND EXISTS (SELECT 1 FROM model_runtime_registrations AS registration
        WHERE registration.id IS json_extract(NEW.plan_json, '$.modelRequirements.runtimeRegistration.registrationId')
          AND registration.registration_sha256 IS json_extract(NEW.plan_json, '$.modelRequirements.runtimeRegistration.registrationSha256')
          AND registration.identity_sha256 IS json_extract(NEW.plan_json, '$.modelRequirements.expectedModelIdentityDigest')
          AND CAST(registration.registration_json AS BLOB) IS CAST(json_extract(NEW.plan_json, '$.modelRuntimeRegistration') AS BLOB)
          AND registration.created_at <= json_extract(NEW.plan_json, '$.authorization.authorizedAt')))
  ) OR EXISTS (SELECT parent, key FROM json_tree(NEW.plan_json, '$.modelRequirements')
    WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1)
    THEN RAISE(ABORT, 'evaluation plans must retain their exact immutable model registration') END;
END;

CREATE TRIGGER tr_evaluation_job_runtime_registration_insert BEFORE INSERT ON jobs
WHEN CASE WHEN json_valid(NEW.execution_json) THEN (
  json_extract(NEW.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
  OR json_extract(NEW.execution_json, '$.validation.purpose.kind') IS 'evaluation'
  OR json_type(NEW.execution_json, '$.validation.modelRuntimeRegistration') IS NOT NULL
  OR json_type(NEW.execution_json, '$.validation.modelRequirements.runtimeRegistration') IS NOT NULL
) ELSE 0 END
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM review_runs AS run
    WHERE run.purpose = 'evaluation' AND run.id IS json_extract(NEW.execution_json, '$.validation.runId')
      AND json_extract(NEW.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
      AND json_type(NEW.execution_json, '$.validation.modelRequirements') IS 'object'
      AND CAST(json_extract(NEW.execution_json, '$.validation.modelRequirements') AS BLOB)
        IS CAST(json_extract(run.plan_json, '$.modelRequirements') AS BLOB)
      AND json_type(NEW.execution_json, '$.validation.modelRuntimeRegistration') IS json_type(run.plan_json, '$.modelRuntimeRegistration')
      AND CAST(json_extract(NEW.execution_json, '$.validation.modelRuntimeRegistration') AS BLOB)
        IS CAST(json_extract(run.plan_json, '$.modelRuntimeRegistration') AS BLOB)
      AND NOT EXISTS (SELECT key FROM json_each(NEW.execution_json) GROUP BY key HAVING COUNT(*) != 1)
      AND NOT EXISTS (SELECT key FROM json_each(NEW.execution_json, '$.validation') GROUP BY key HAVING COUNT(*) != 1)
  ) THEN RAISE(ABORT, 'evaluation jobs must retain their frozen model requirements and snapshot') END;
END;

CREATE TRIGGER tr_evaluation_job_runtime_registration_update BEFORE UPDATE OF execution_json ON jobs
WHEN (CASE WHEN json_valid(OLD.execution_json) THEN (
    json_extract(OLD.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
    OR json_extract(OLD.execution_json, '$.validation.purpose.kind') IS 'evaluation'
    OR json_type(OLD.execution_json, '$.validation.modelRuntimeRegistration') IS NOT NULL
    OR json_type(OLD.execution_json, '$.validation.modelRequirements.runtimeRegistration') IS NOT NULL
  ) ELSE 0 END)
  OR (CASE WHEN json_valid(NEW.execution_json) THEN (
    json_extract(NEW.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
    OR json_extract(NEW.execution_json, '$.validation.purpose.kind') IS 'evaluation'
    OR json_type(NEW.execution_json, '$.validation.modelRuntimeRegistration') IS NOT NULL
    OR json_type(NEW.execution_json, '$.validation.modelRequirements.runtimeRegistration') IS NOT NULL
  ) ELSE 0 END)
  OR EXISTS (SELECT 1 FROM review_run_job_links AS link JOIN review_runs AS run ON run.id = link.review_run_id
    WHERE link.job_id = OLD.id AND run.purpose = 'evaluation')
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM review_runs AS run
    WHERE run.purpose = 'evaluation' AND run.id IS json_extract(NEW.execution_json, '$.validation.runId')
      AND (EXISTS (SELECT 1 FROM review_run_job_links WHERE job_id = OLD.id AND review_run_id = run.id)
        OR (NOT EXISTS (SELECT 1 FROM review_run_job_links AS link JOIN review_runs AS linked ON linked.id = link.review_run_id
            WHERE link.job_id = OLD.id AND linked.purpose = 'evaluation')
          AND (json_type(OLD.execution_json, '$.validation.runId') IS NULL
            OR json_extract(OLD.execution_json, '$.validation.runId') IS run.id)))
      AND json_extract(NEW.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
      AND json_type(NEW.execution_json, '$.validation.modelRequirements') IS 'object'
      AND CAST(json_extract(NEW.execution_json, '$.validation.modelRequirements') AS BLOB)
        IS CAST(json_extract(run.plan_json, '$.modelRequirements') AS BLOB)
      AND json_type(NEW.execution_json, '$.validation.modelRuntimeRegistration') IS json_type(run.plan_json, '$.modelRuntimeRegistration')
      AND CAST(json_extract(NEW.execution_json, '$.validation.modelRuntimeRegistration') AS BLOB)
        IS CAST(json_extract(run.plan_json, '$.modelRuntimeRegistration') AS BLOB)
      AND NOT EXISTS (SELECT key FROM json_each(NEW.execution_json) GROUP BY key HAVING COUNT(*) != 1)
      AND NOT EXISTS (SELECT key FROM json_each(NEW.execution_json, '$.validation') GROUP BY key HAVING COUNT(*) != 1)
  ) THEN RAISE(ABORT, 'evaluation job updates cannot change their frozen model registration') END;
END;

CREATE TRIGGER tr_evaluation_job_runtime_registration_lease BEFORE UPDATE OF status ON jobs
WHEN NEW.status = 'leased' AND OLD.status IN ('queued', 'retry_waiting')
  AND ((CASE WHEN json_valid(NEW.execution_json) THEN (
    json_extract(NEW.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
    OR json_extract(NEW.execution_json, '$.validation.purpose.kind') IS 'evaluation'
    OR json_type(NEW.execution_json, '$.validation.modelRuntimeRegistration') IS NOT NULL
    OR json_type(NEW.execution_json, '$.validation.modelRequirements.runtimeRegistration') IS NOT NULL
  ) ELSE 0 END)
  OR EXISTS (SELECT 1 FROM review_run_job_links AS link JOIN review_runs AS run ON run.id = link.review_run_id
    WHERE link.job_id = OLD.id AND run.purpose = 'evaluation'))
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM review_run_job_links AS link
    JOIN review_runs AS run ON run.id = link.review_run_id AND run.purpose = 'evaluation'
    WHERE link.job_id = NEW.id AND run.id IS json_extract(NEW.execution_json, '$.validation.runId')
      AND json_extract(NEW.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
      AND json_type(NEW.execution_json, '$.validation.modelRequirements') IS 'object'
      AND CAST(json_extract(NEW.execution_json, '$.validation.modelRequirements') AS BLOB)
        IS CAST(json_extract(run.plan_json, '$.modelRequirements') AS BLOB)
      AND json_type(NEW.execution_json, '$.validation.modelRuntimeRegistration') IS json_type(run.plan_json, '$.modelRuntimeRegistration')
      AND CAST(json_extract(NEW.execution_json, '$.validation.modelRuntimeRegistration') AS BLOB)
        IS CAST(json_extract(run.plan_json, '$.modelRuntimeRegistration') AS BLOB)
      AND NOT EXISTS (SELECT key FROM json_each(NEW.execution_json) GROUP BY key HAVING COUNT(*) != 1)
      AND NOT EXISTS (SELECT key FROM json_each(NEW.execution_json, '$.validation') GROUP BY key HAVING COUNT(*) != 1)
  ) THEN RAISE(ABORT, 'evaluation leases require the unchanged frozen model registration') END;
END;


-- Extend the existing strict V2 guards without rewriting historical rows or cell budgets.
DROP TRIGGER tr_evaluation_review_run_insert;

CREATE TRIGGER tr_evaluation_review_run_insert
BEFORE INSERT ON review_runs
WHEN NEW.purpose = 'evaluation'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    WHERE NEW.request_epoch_id IS NULL
      AND NEW.evaluation_cell_id IS NOT NULL
      AND NEW.request_count = 1
      AND json_valid(NEW.plan_json)
      AND json_type(NEW.plan_json) IS 'object'
      AND json_extract(NEW.plan_json, '$.schemaVersion') IS 'ReviewRunExecutionPlanV2'
      AND json_type(NEW.plan_json, '$.requestEpochId') IS 'null'
      AND json_type(NEW.plan_json, '$.testedSourceAuthorization') IS 'null'
      AND json_type(NEW.plan_json, '$.activationId') IS 'text'
      AND json_type(NEW.plan_json, '$.repository') IS 'object'
      AND json_type(NEW.plan_json, '$.workItemId') IS 'text'
      AND json_type(NEW.plan_json, '$.workItem') IS 'object'
      AND json_type(NEW.plan_json, '$.revision') IS 'object'
      AND json_type(NEW.plan_json, '$.testedSourceRevision') IN ('object', 'null')
      AND json_type(NEW.plan_json, '$.source') IS 'object'
      AND json_type(NEW.plan_json, '$.authorization') IS 'object'
      AND json_type(NEW.plan_json, '$.purpose') IS 'object'
      AND json_type(NEW.plan_json, '$.modelRequirements') IS 'object'
      AND json_type(NEW.plan_json, '$.jobs') IS 'array'
      AND json_array_length(NEW.plan_json, '$.jobs') = 1
      AND json_type(NEW.plan_json, '$.jobs[0]') IS 'object'
      AND json_type(NEW.plan_json, '$.requiredCheckIds') IS 'array'
      AND (json_type(NEW.plan_json, '$.reproduction') IS NULL
        OR json_type(NEW.plan_json, '$.reproduction') IS 'object')
      AND (SELECT COUNT(*) FROM json_each(NEW.plan_json))
        = 15 + (json_type(NEW.plan_json, '$.reproduction') IS 'object')
          + (json_type(NEW.plan_json, '$.modelRuntimeRegistration') IS 'object')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.plan_json)
        WHERE key NOT IN ('schemaVersion', 'activationId', 'repository', 'workItemId',
          'workItem', 'revision', 'testedSourceRevision', 'testedSourceAuthorization',
          'authorization', 'jobs', 'requiredCheckIds', 'requestEpochId', 'purpose',
          'source', 'modelRequirements', 'reproduction', 'modelRuntimeRegistration')
      )
      AND NOT EXISTS (
        SELECT key FROM json_each(NEW.plan_json) GROUP BY key HAVING COUNT(*) != 1
      )
      AND (SELECT COUNT(*) FROM json_each(NEW.plan_json, '$.purpose')) = 11
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.plan_json, '$.purpose')
        WHERE key NOT IN ('schemaVersion', 'kind', 'evaluationId', 'cellId', 'caseId',
          'arm', 'sampleSetVersionId', 'authorizationId', 'executionManifestSha256',
          'trial', 'upstreamMutationPolicy')
      )
      AND NOT EXISTS (
        SELECT key FROM json_each(NEW.plan_json, '$.purpose') GROUP BY key HAVING COUNT(*) != 1
      )
      AND json_extract(NEW.plan_json, '$.purpose.schemaVersion') IS 'EvaluationExecutionPurposeV1'
      AND json_extract(NEW.plan_json, '$.purpose.kind') IS 'evaluation'
      AND json_type(NEW.plan_json, '$.purpose.evaluationId') IS 'text'
      AND json_type(NEW.plan_json, '$.purpose.cellId') IS 'text'
      AND json_type(NEW.plan_json, '$.purpose.caseId') IS 'text'
      AND json_type(NEW.plan_json, '$.purpose.arm') IS 'text'
      AND json_type(NEW.plan_json, '$.purpose.sampleSetVersionId') IS 'text'
      AND json_type(NEW.plan_json, '$.purpose.authorizationId') IS 'text'
      AND json_type(NEW.plan_json, '$.purpose.executionManifestSha256') IS 'text'
      AND json_type(NEW.plan_json, '$.purpose.trial') IS 'integer'
      AND json_extract(NEW.plan_json, '$.purpose.trial') IS 1
      AND json_extract(NEW.plan_json, '$.purpose.upstreamMutationPolicy') IS 'forbidden'
      AND (SELECT COUNT(*) FROM json_each(NEW.plan_json, '$.modelRequirements'))
        = 2 + (json_type(NEW.plan_json, '$.modelRequirements.runtimeRegistration') IS 'object')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.plan_json, '$.modelRequirements')
        WHERE key NOT IN ('required', 'expectedModelIdentityDigest', 'runtimeRegistration')
      )
      AND json_type(NEW.plan_json, '$.modelRequirements.required') IN ('true', 'false')
      AND (
        json_type(NEW.plan_json, '$.modelRequirements.expectedModelIdentityDigest') IS 'null'
        OR (
          json_type(NEW.plan_json, '$.modelRequirements.expectedModelIdentityDigest') IS 'text'
          AND length(json_extract(NEW.plan_json, '$.modelRequirements.expectedModelIdentityDigest')) = 64
          AND length(CAST(json_extract(NEW.plan_json, '$.modelRequirements.expectedModelIdentityDigest') AS BLOB)) = 64
          AND json_extract(NEW.plan_json, '$.modelRequirements.expectedModelIdentityDigest') NOT GLOB '*[^0-9a-f]*'
        )
      )
      AND (SELECT COUNT(*) FROM json_each(NEW.plan_json, '$.jobs[0]')) = 7
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.plan_json, '$.jobs[0]')
        WHERE key NOT IN ('requestId', 'workflowKind', 'target', 'required',
          'profileVersion', 'prompt', 'requiredCheckIds')
      )
      AND NOT EXISTS (
        SELECT key FROM json_each(NEW.plan_json, '$.jobs[0]') GROUP BY key HAVING COUNT(*) != 1
      )
      AND json_type(NEW.plan_json, '$.jobs[0].requestId') IS 'text'
      AND json_type(NEW.plan_json, '$.jobs[0].workflowKind') IS 'text'
      AND json_type(NEW.plan_json, '$.jobs[0].target') IS 'text'
      AND json_type(NEW.plan_json, '$.jobs[0].required') IN ('true', 'false')
      AND json_type(NEW.plan_json, '$.jobs[0].profileVersion') IS 'object'
      AND json_type(NEW.plan_json, '$.jobs[0].prompt') IS 'object'
      AND json_type(NEW.plan_json, '$.jobs[0].requiredCheckIds') IS 'array'
      AND json_array_length(NEW.plan_json, '$.jobs[0].requiredCheckIds') <= 96
      AND CAST(json_extract(NEW.plan_json, '$.requiredCheckIds') AS BLOB)
        IS CAST(json_extract(NEW.plan_json, '$.jobs[0].requiredCheckIds') AS BLOB)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.plan_json, '$.jobs[0].requiredCheckIds')
        WHERE type IS NOT 'text' OR length(value) NOT BETWEEN 3 AND 257
          OR instr(value, char(0)) != 0
      )
      AND NOT EXISTS (
        SELECT value FROM json_each(NEW.plan_json, '$.jobs[0].requiredCheckIds')
        GROUP BY value HAVING COUNT(*) != 1
      )
  ) THEN RAISE(ABORT, 'evaluation run requires a strict frozen V2 plan') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM evaluation_cells AS cell
    JOIN evaluations AS evaluation
      ON evaluation.id = cell.evaluation_id AND evaluation.repository_id = cell.repository_id
    JOIN evaluation_sources AS source
      ON source.id = cell.source_id AND source.repository_id = cell.repository_id
    JOIN evaluation_authorizations AS authorization
      ON authorization.id = cell.authorization_id
      AND authorization.evaluation_id = evaluation.id
      AND authorization.repository_id = evaluation.repository_id
    JOIN managed_repositories AS managed_repository ON managed_repository.id = evaluation.repository_id
    JOIN repositories AS repository ON repository.id = source.repository_id
    JOIN work_items AS item
      ON item.id = source.work_item_id AND item.repository_id = source.repository_id
    JOIN work_item_revisions AS revision
      ON revision.id = source.revision_id AND revision.work_item_id = source.work_item_id
    JOIN validation_profile_versions AS profile_version ON profile_version.id = cell.profile_version_id
    JOIN validation_profiles AS profile ON profile.id = profile_version.profile_id
    JOIN prompt_versions AS prompt_version ON prompt_version.id = cell.prompt_version_id
    JOIN prompt_templates AS prompt_template ON prompt_template.id = prompt_version.template_id
    JOIN json_each(NEW.plan_json, '$.jobs') AS request ON request.key = 0 AND request.type = 'object'
    JOIN json_each(evaluation.configuration_manifest_json) AS configuration
      ON configuration.key = cell.arm AND configuration.type = 'object'
    JOIN json_each(evaluation.cell_manifest_json, '$.cells') AS manifest_cell
      ON manifest_cell.type = 'object' AND json_extract(manifest_cell.value, '$.cellId') IS cell.id
    WHERE cell.id = NEW.evaluation_cell_id
      AND cell.run_id = NEW.id AND cell.activation_id = NEW.activation_id
      AND cell.trial = 1 AND cell.arm IN ('baseline', 'candidate')
      AND cell.repository_id = NEW.repository_id
      AND source.work_item_id = NEW.work_item_id AND source.revision_id = NEW.revision_id
      AND source.revision_key = NEW.revision_key AND source.source_digest = cell.source_digest
      AND revision.revision_key = NEW.revision_key AND revision.resource_kind = item.resource_kind
      AND managed_repository.github_repository_id = repository.github_repository_id
      AND NEW.actor_issuer = evaluation.actor_issuer AND NEW.actor_subject = evaluation.actor_subject
      AND authorization.actor_issuer = evaluation.actor_issuer
      AND authorization.actor_subject = evaluation.actor_subject
      AND json_extract(NEW.plan_json, '$.activationId') IS cell.activation_id
      AND json_extract(NEW.plan_json, '$.purpose.evaluationId') IS evaluation.id
      AND json_extract(NEW.plan_json, '$.purpose.cellId') IS cell.id
      AND json_extract(NEW.plan_json, '$.purpose.caseId') IS cell.case_id
      AND json_extract(NEW.plan_json, '$.purpose.arm') IS cell.arm
      AND json_extract(NEW.plan_json, '$.purpose.sampleSetVersionId') IS evaluation.suite_version_id
      AND json_extract(NEW.plan_json, '$.purpose.authorizationId') IS authorization.id
      AND json_extract(NEW.plan_json, '$.purpose.executionManifestSha256') IS evaluation.execution_manifest_sha256
      AND CAST(json_extract(NEW.plan_json, '$.source') AS BLOB) IS CAST(source.source_json AS BLOB)
      AND CAST(json_extract(NEW.plan_json, '$.authorization') AS BLOB) IS CAST(authorization.authorization_json AS BLOB)
      AND json_extract(NEW.plan_json, '$.source.schemaVersion') IS 'EvaluationSourceSnapshotV1'
      AND json_extract(NEW.plan_json, '$.source.freshness') IS 'frozen'
      AND json_extract(NEW.plan_json, '$.source.revisionId') IS source.revision_id
      AND json_extract(NEW.plan_json, '$.source.sourceDigest') IS source.source_digest
      AND json_extract(NEW.plan_json, '$.workItemId') IS source.work_item_id
      AND json_extract(NEW.plan_json, '$.source.workItemId') IS source.work_item_id
      AND CAST(json_extract(NEW.plan_json, '$.repository') AS BLOB) IS CAST(json_extract(source.source_json, '$.repository') AS BLOB)
      AND CAST(json_extract(NEW.plan_json, '$.workItem') AS BLOB) IS CAST(json_extract(source.source_json, '$.workItem') AS BLOB)
      AND CAST(json_extract(NEW.plan_json, '$.revision') AS BLOB) IS CAST(json_extract(source.source_json, '$.revision') AS BLOB)
      AND CAST(json_extract(NEW.plan_json, '$.testedSourceRevision') AS BLOB) IS CAST(json_extract(source.source_json, '$.testedSourceRevision') AS BLOB)
      AND json_extract(NEW.plan_json, '$.repository.id') IS repository.id
      AND json_type(NEW.plan_json, '$.repository.githubRepositoryId') IS 'integer'
      AND json_extract(NEW.plan_json, '$.repository.githubRepositoryId') IS repository.github_repository_id
      AND json_type(NEW.plan_json, '$.workItem.githubRepositoryId') IS 'integer'
      AND json_extract(NEW.plan_json, '$.workItem.githubRepositoryId') IS repository.github_repository_id
      AND json_type(NEW.plan_json, '$.workItem.githubWorkItemId') IS 'integer'
      AND json_extract(NEW.plan_json, '$.workItem.githubWorkItemId') IS item.github_work_item_id
      AND json_extract(NEW.plan_json, '$.workItem.githubNodeId') IS item.github_node_id
      AND json_type(NEW.plan_json, '$.workItem.number') IS 'integer'
      AND json_extract(NEW.plan_json, '$.workItem.number') IS item.github_number
      AND json_extract(NEW.plan_json, '$.workItem.kind') IS item.resource_kind
      AND json_type(NEW.plan_json, '$.revision.githubRepositoryId') IS 'integer'
      AND json_extract(NEW.plan_json, '$.revision.githubRepositoryId') IS repository.github_repository_id
      AND json_type(NEW.plan_json, '$.revision.githubWorkItemId') IS 'integer'
      AND json_extract(NEW.plan_json, '$.revision.githubWorkItemId') IS item.github_work_item_id
      AND json_extract(NEW.plan_json, '$.revision.kind') IS revision.resource_kind
      AND json_extract(NEW.plan_json, '$.revision.revisionKey') IS revision.revision_key
      AND json_extract(revision.revision_json, '$.githubRepositoryId') IS repository.github_repository_id
      AND json_extract(revision.revision_json, '$.githubWorkItemId') IS item.github_work_item_id
      AND json_extract(revision.revision_json, '$.kind') IS revision.resource_kind
      AND json_extract(revision.revision_json, '$.revisionKey') IS revision.revision_key
      AND (
        (item.resource_kind = 'pull_request' AND evaluation.workflow_kind IN ('pr_static_build', 'pr_ui')
          AND json_extract(NEW.plan_json, '$.revision.baseSha') IS revision.base_sha
          AND json_extract(NEW.plan_json, '$.revision.headSha') IS revision.head_sha
          AND json_extract(revision.revision_json, '$.baseSha') IS revision.base_sha
          AND json_extract(revision.revision_json, '$.headSha') IS revision.head_sha
          AND length(revision.base_sha) IN (40, 64) AND length(CAST(revision.base_sha AS BLOB)) = length(revision.base_sha)
          AND revision.base_sha NOT GLOB '*[^0-9a-f]*'
          AND length(revision.head_sha) IN (40, 64) AND length(CAST(revision.head_sha AS BLOB)) = length(revision.head_sha)
          AND revision.head_sha NOT GLOB '*[^0-9a-f]*'
          AND json_type(NEW.plan_json, '$.testedSourceRevision') IS 'object'
          AND json_extract(NEW.plan_json, '$.testedSourceRevision.kind') IS 'pull_request'
          AND json_extract(NEW.plan_json, '$.testedSourceRevision.baseSha') IS revision.base_sha
          AND json_extract(NEW.plan_json, '$.testedSourceRevision.headSha') IS revision.head_sha
          AND (SELECT COUNT(*) FROM json_each(NEW.plan_json, '$.revision')) = 6
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.plan_json, '$.revision')
            WHERE key NOT IN ('githubRepositoryId', 'githubWorkItemId', 'kind', 'revisionKey', 'baseSha', 'headSha')
          )
          AND (SELECT COUNT(*) FROM json_each(NEW.plan_json, '$.testedSourceRevision')) = 3
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.plan_json, '$.testedSourceRevision')
            WHERE key NOT IN ('kind', 'baseSha', 'headSha')
          ))
        OR (item.resource_kind = 'issue' AND evaluation.workflow_kind IN ('issue_triage', 'issue_validation')
          AND json_extract(NEW.plan_json, '$.revision.contentDigest') IS revision.content_digest
          AND json_extract(revision.revision_json, '$.contentDigest') IS revision.content_digest
          AND (SELECT COUNT(*) FROM json_each(NEW.plan_json, '$.revision')) = 5
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.plan_json, '$.revision')
            WHERE key NOT IN ('githubRepositoryId', 'githubWorkItemId', 'kind', 'revisionKey', 'contentDigest')
          )
          AND (
            (evaluation.workflow_kind = 'issue_triage' AND json_type(NEW.plan_json, '$.testedSourceRevision') IS 'null')
            OR (evaluation.workflow_kind = 'issue_validation'
              AND json_type(NEW.plan_json, '$.testedSourceRevision') IS 'object'
              AND json_extract(NEW.plan_json, '$.testedSourceRevision.kind') IS 'commit'
              AND json_type(NEW.plan_json, '$.testedSourceRevision.headSha') IS 'text'
              AND length(json_extract(NEW.plan_json, '$.testedSourceRevision.headSha')) IN (40, 64)
              AND length(CAST(json_extract(NEW.plan_json, '$.testedSourceRevision.headSha') AS BLOB))
                = length(json_extract(NEW.plan_json, '$.testedSourceRevision.headSha'))
              AND json_extract(NEW.plan_json, '$.testedSourceRevision.headSha') NOT GLOB '*[^0-9a-f]*'
              AND (SELECT COUNT(*) FROM json_each(NEW.plan_json, '$.testedSourceRevision')) = 2
              AND NOT EXISTS (
                SELECT 1 FROM json_each(NEW.plan_json, '$.testedSourceRevision')
                WHERE key NOT IN ('kind', 'headSha')
              ))
          ))
      )
      AND json_extract(NEW.plan_json, '$.authorization.schemaVersion') IS 'EvaluationExecutionAuthorizationV1'
      AND json_extract(NEW.plan_json, '$.authorization.kind') IS 'operator_evaluation'
      AND json_extract(NEW.plan_json, '$.authorization.id') IS authorization.id
      AND json_extract(NEW.plan_json, '$.authorization.evaluationId') IS evaluation.id
      AND json_extract(NEW.plan_json, '$.authorization.repositoryId') IS evaluation.repository_id
      AND json_type(NEW.plan_json, '$.authorization.githubRepositoryId') IS 'integer'
      AND json_extract(NEW.plan_json, '$.authorization.githubRepositoryId') IS repository.github_repository_id
      AND json_extract(NEW.plan_json, '$.authorization.sampleSetVersionId') IS evaluation.suite_version_id
      AND json_extract(NEW.plan_json, '$.authorization.sourceManifestSha256') IS evaluation.source_manifest_sha256
      AND json_extract(NEW.plan_json, '$.authorization.configurationManifestSha256') IS evaluation.configuration_manifest_sha256
      AND json_extract(NEW.plan_json, '$.authorization.cellManifestSha256') IS evaluation.cell_manifest_sha256
      AND json_extract(NEW.plan_json, '$.authorization.executionManifestSha256') IS evaluation.execution_manifest_sha256
      AND json_extract(NEW.plan_json, '$.authorization.actor.issuer') IS authorization.actor_issuer
      AND json_extract(NEW.plan_json, '$.authorization.actor.subject') IS authorization.actor_subject
      AND json_extract(NEW.plan_json, '$.authorization.authorizedAt') IS authorization.created_at
      AND julianday(json_extract(source.source_json, '$.provenance.capturedAt')) <= julianday(authorization.created_at)
      AND json_extract(evaluation.configuration_manifest_json, '$.schemaVersion') IS 'EvaluationConfigurationManifestV1'
      AND json_extract(evaluation.configuration_manifest_json, '$.repositoryId') IS evaluation.repository_id
      AND (SELECT COUNT(*) FROM json_each(configuration.value))
        = 3 + (json_type(configuration.value, '$.modelRuntimeRegistration') IS 'object')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(configuration.value)
        WHERE key NOT IN ('profileVersion', 'prompt', 'modelRequirements', 'modelRuntimeRegistration')
      )
      AND CAST(json_extract(request.value, '$.profileVersion') AS BLOB) IS CAST(json_extract(configuration.value, '$.profileVersion') AS BLOB)
      AND CAST(json_extract(request.value, '$.prompt') AS BLOB) IS CAST(json_extract(configuration.value, '$.prompt') AS BLOB)
      AND CAST(json_extract(NEW.plan_json, '$.modelRequirements') AS BLOB) IS CAST(json_extract(configuration.value, '$.modelRequirements') AS BLOB)
      AND json_type(NEW.plan_json, '$.modelRuntimeRegistration') IS json_type(configuration.value, '$.modelRuntimeRegistration')
      AND CAST(json_extract(NEW.plan_json, '$.modelRuntimeRegistration') AS BLOB)
        IS CAST(json_extract(configuration.value, '$.modelRuntimeRegistration') AS BLOB)
      AND json_extract(request.value, '$.requestId') IS cell.request_id
      AND json_extract(request.value, '$.workflowKind') IS evaluation.workflow_kind
      AND json_extract(request.value, '$.target') IS evaluation.target
      AND profile.repository_id = evaluation.repository_id
      AND profile.workflow_kind = evaluation.workflow_kind AND profile.target = evaluation.target
      AND (profile_version.required = 0 OR json_extract(request.value, '$.required') IS 1)
      AND (evaluation.workflow_kind NOT IN ('pr_static_build', 'issue_triage')
        OR json_extract(NEW.plan_json, '$.modelRequirements.required') IS 1)
      AND (SELECT COUNT(*) FROM json_each(request.value, '$.profileVersion')) = 14
      AND NOT EXISTS (
        SELECT 1 FROM json_each(request.value, '$.profileVersion')
        WHERE key NOT IN ('id', 'profileId', 'repositoryId', 'version', 'name', 'config',
          'configSha256', 'required', 'createdAt', 'publishedAt', 'createdBy',
          'workflowKind', 'target', 'outputSchemaVersion')
      )
      AND json_extract(request.value, '$.profileVersion.id') IS profile_version.id
      AND json_extract(request.value, '$.profileVersion.profileId') IS profile.id
      AND json_extract(request.value, '$.profileVersion.repositoryId') IS profile.repository_id
      AND json_type(request.value, '$.profileVersion.version') IS 'integer'
      AND json_extract(request.value, '$.profileVersion.version') IS profile_version.version
      AND json_extract(request.value, '$.profileVersion.name') IS profile_version.name
      AND json_type(request.value, '$.profileVersion.config') IS 'object'
      AND CAST(json_extract(request.value, '$.profileVersion.config') AS BLOB) IS CAST(profile_version.config_json AS BLOB)
      AND json_extract(request.value, '$.profileVersion.configSha256') IS profile_version.config_sha256
      AND json_type(request.value, '$.profileVersion.required') IN ('true', 'false')
      AND json_extract(request.value, '$.profileVersion.required') IS profile_version.required
      AND json_extract(request.value, '$.profileVersion.createdAt') IS profile_version.created_at
      AND json_extract(request.value, '$.profileVersion.publishedAt') IS profile_version.published_at
      AND json_extract(request.value, '$.profileVersion.createdBy') IS profile_version.created_by
      AND json_extract(request.value, '$.profileVersion.workflowKind') IS profile.workflow_kind
      AND json_extract(request.value, '$.profileVersion.target') IS profile.target
      AND json_extract(request.value, '$.profileVersion.outputSchemaVersion') IS profile_version.output_schema_version
      AND profile_version.output_schema_version = CASE evaluation.workflow_kind
        WHEN 'pr_static_build' THEN 'PrReviewPlanV2'
        WHEN 'issue_triage' THEN 'IssueTriageV2' ELSE 'ValidationReportV1' END
      AND (SELECT COUNT(*) FROM json_each(request.value, '$.prompt')) = 2
      AND NOT EXISTS (
        SELECT 1 FROM json_each(request.value, '$.prompt') WHERE key NOT IN ('workflowKind', 'version')
      )
      AND json_extract(request.value, '$.prompt.workflowKind') IS evaluation.workflow_kind
      AND prompt_template.workflow_kind = evaluation.workflow_kind
      AND json_type(request.value, '$.prompt.version') IS 'object'
      AND (SELECT COUNT(*) FROM json_each(request.value, '$.prompt.version')) = 9
      AND NOT EXISTS (
        SELECT 1 FROM json_each(request.value, '$.prompt.version')
        WHERE key NOT IN ('id', 'templateId', 'version', 'content', 'contentSha256',
          'outputSchemaVersion', 'createdAt', 'publishedAt', 'createdBy')
      )
      AND json_extract(request.value, '$.prompt.version.id') IS prompt_version.id
      AND json_extract(request.value, '$.prompt.version.templateId') IS prompt_template.id
      AND json_type(request.value, '$.prompt.version.version') IS 'integer'
      AND json_extract(request.value, '$.prompt.version.version') IS prompt_version.version
      AND json_type(request.value, '$.prompt.version.content') IS 'text'
      AND CAST(json_extract(request.value, '$.prompt.version.content') AS BLOB) IS CAST(prompt_version.content AS BLOB)
      AND json_extract(request.value, '$.prompt.version.contentSha256') IS prompt_version.content_sha256
      AND json_extract(request.value, '$.prompt.version.outputSchemaVersion') IS prompt_version.output_schema_version
      AND json_extract(request.value, '$.prompt.version.createdAt') IS prompt_version.created_at
      AND json_extract(request.value, '$.prompt.version.publishedAt') IS prompt_version.published_at
      AND json_extract(request.value, '$.prompt.version.createdBy') IS prompt_version.created_by
      AND prompt_version.output_schema_version = CASE evaluation.workflow_kind
        WHEN 'pr_static_build' THEN 'PrReviewPlanV2'
        WHEN 'issue_triage' THEN 'IssueTriageV2' ELSE 'ValidationSummaryV1' END
      AND json_extract(evaluation.cell_manifest_json, '$.schemaVersion') IS 'EvaluationCellManifestV1'
      AND json_extract(evaluation.cell_manifest_json, '$.evaluationId') IS evaluation.id
      AND json_extract(evaluation.cell_manifest_json, '$.repositoryId') IS evaluation.repository_id
      AND (SELECT COUNT(*) FROM json_each(evaluation.cell_manifest_json, '$.cells')
        WHERE json_extract(value, '$.cellId') IS cell.id) = 1
      AND (SELECT COUNT(*) FROM json_each(manifest_cell.value)) = 14
      AND NOT EXISTS (
        SELECT 1 FROM json_each(manifest_cell.value)
        WHERE key NOT IN ('cellId', 'caseId', 'arm', 'trial', 'sourceId', 'sourceDigest',
          'runId', 'requestId', 'activationId', 'profileVersionId', 'promptVersionId',
          'renderedPromptDigest', 'outputSchemaDigest', 'modelRequirements')
      )
      AND json_extract(manifest_cell.value, '$.cellId') IS cell.id
      AND json_extract(manifest_cell.value, '$.caseId') IS cell.case_id
      AND json_extract(manifest_cell.value, '$.arm') IS cell.arm
      AND json_type(manifest_cell.value, '$.trial') IS 'integer'
      AND json_extract(manifest_cell.value, '$.trial') IS cell.trial
      AND json_extract(manifest_cell.value, '$.sourceId') IS source.id
      AND json_extract(manifest_cell.value, '$.sourceDigest') IS source.source_digest
      AND json_extract(manifest_cell.value, '$.runId') IS NEW.id
      AND json_extract(manifest_cell.value, '$.requestId') IS cell.request_id
      AND json_extract(manifest_cell.value, '$.activationId') IS NEW.activation_id
      AND json_extract(manifest_cell.value, '$.profileVersionId') IS profile_version.id
      AND json_extract(manifest_cell.value, '$.promptVersionId') IS prompt_version.id
      AND CAST(json_extract(manifest_cell.value, '$.modelRequirements') AS BLOB)
        IS CAST(json_extract(NEW.plan_json, '$.modelRequirements') AS BLOB)
      -- The request/seal guards compare these commitments with the rendered envelope.
      AND json_type(manifest_cell.value, '$.renderedPromptDigest') IS 'text'
      AND length(json_extract(manifest_cell.value, '$.renderedPromptDigest')) = 64
      AND length(CAST(json_extract(manifest_cell.value, '$.renderedPromptDigest') AS BLOB)) = 64
      AND json_extract(manifest_cell.value, '$.renderedPromptDigest') NOT GLOB '*[^0-9a-f]*'
      AND json_type(manifest_cell.value, '$.outputSchemaDigest') IS 'text'
      AND length(json_extract(manifest_cell.value, '$.outputSchemaDigest')) = 64
      AND length(CAST(json_extract(manifest_cell.value, '$.outputSchemaDigest') AS BLOB)) = 64
      AND json_extract(manifest_cell.value, '$.outputSchemaDigest') NOT GLOB '*[^0-9a-f]*'
      -- Required checks are exactly the published build/test/UI required steps.
      AND (json_extract(request.value, '$.required') IS 1
        OR json_array_length(request.value, '$.requiredCheckIds') = 0)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(request.value, '$.requiredCheckIds') AS required_check
        WHERE NOT EXISTS (
          SELECT 1 FROM json_each(profile_version.config_json, '$.build') AS step
          WHERE json_extract(step.value, '$.required') IS 1
            AND required_check.value IS profile_version.id || ':' || json_extract(step.value, '$.id')
        ) AND NOT EXISTS (
          SELECT 1 FROM json_each(profile_version.config_json, '$.test') AS step
          WHERE json_extract(step.value, '$.required') IS 1
            AND required_check.value IS profile_version.id || ':' || json_extract(step.value, '$.id')
        ) AND NOT EXISTS (
          SELECT 1 FROM json_each(profile_version.config_json, '$.ui.scenarios') AS step
          WHERE json_extract(step.value, '$.required') IS 1
            AND required_check.value IS profile_version.id || ':' || json_extract(step.value, '$.id')
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(profile_version.config_json, '$.build') AS step
        WHERE json_extract(request.value, '$.required') IS 1
          AND json_extract(step.value, '$.required') IS 1
          AND NOT EXISTS (
            SELECT 1 FROM json_each(request.value, '$.requiredCheckIds')
            WHERE value IS profile_version.id || ':' || json_extract(step.value, '$.id')
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(profile_version.config_json, '$.test') AS step
        WHERE json_extract(request.value, '$.required') IS 1
          AND json_extract(step.value, '$.required') IS 1
          AND NOT EXISTS (
            SELECT 1 FROM json_each(request.value, '$.requiredCheckIds')
            WHERE value IS profile_version.id || ':' || json_extract(step.value, '$.id')
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(profile_version.config_json, '$.ui.scenarios') AS step
        WHERE json_extract(request.value, '$.required') IS 1
          AND json_extract(step.value, '$.required') IS 1
          AND NOT EXISTS (
            SELECT 1 FROM json_each(request.value, '$.requiredCheckIds')
            WHERE value IS profile_version.id || ':' || json_extract(step.value, '$.id')
          )
      )
      AND (
        json_type(NEW.plan_json, '$.reproduction') IS NULL
        OR (
          evaluation.workflow_kind = 'issue_validation'
          AND json_type(NEW.plan_json, '$.reproduction.binding') IS 'object'
          AND (SELECT COUNT(*) FROM json_each(NEW.plan_json, '$.reproduction')) = 2
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.plan_json, '$.reproduction')
            WHERE key NOT IN ('binding', 'bindingDigest')
          )
          AND json_type(NEW.plan_json, '$.reproduction.bindingDigest') IS 'text'
          AND length(json_extract(NEW.plan_json, '$.reproduction.bindingDigest')) = 64
          AND length(CAST(json_extract(NEW.plan_json, '$.reproduction.bindingDigest') AS BLOB)) = 64
          AND json_extract(NEW.plan_json, '$.reproduction.bindingDigest') NOT GLOB '*[^0-9a-f]*'
          AND json_extract(NEW.plan_json, '$.reproduction.binding.schemaVersion') IS 'IssueReproductionBindingV1'
          AND json_extract(NEW.plan_json, '$.reproduction.binding.activationId') IS cell.activation_id
          AND json_extract(NEW.plan_json, '$.reproduction.binding.repositoryId') IS evaluation.repository_id
          AND json_type(NEW.plan_json, '$.reproduction.binding.githubRepositoryId') IS 'integer'
          AND json_extract(NEW.plan_json, '$.reproduction.binding.githubRepositoryId') IS repository.github_repository_id
          AND json_extract(NEW.plan_json, '$.reproduction.binding.workItemId') IS item.id
          AND json_type(NEW.plan_json, '$.reproduction.binding.githubWorkItemId') IS 'integer'
          AND json_extract(NEW.plan_json, '$.reproduction.binding.githubWorkItemId') IS item.github_work_item_id
          AND json_extract(NEW.plan_json, '$.reproduction.binding.issueRevisionKey') IS source.revision_key
          AND json_extract(NEW.plan_json, '$.reproduction.binding.testedSourceCommit')
            IS json_extract(NEW.plan_json, '$.testedSourceRevision.headSha')
          AND json_type(NEW.plan_json, '$.reproduction.binding.authorizedBy') IS 'object'
          AND json_extract(NEW.plan_json, '$.reproduction.binding.authorizedBy.issuer') IS authorization.actor_issuer
          AND json_extract(NEW.plan_json, '$.reproduction.binding.authorizedBy.subject') IS authorization.actor_subject
          AND json_extract(NEW.plan_json, '$.reproduction.binding.authorizedBy.authorizedAt') IS authorization.created_at
          AND json_type(NEW.plan_json, '$.reproduction.binding.cases') IS 'array'
          AND json_array_length(NEW.plan_json, '$.reproduction.binding.cases') BETWEEN 1 AND 32
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.plan_json, '$.reproduction.binding.cases') AS reproduction_case
            WHERE reproduction_case.type IS NOT 'object'
              OR json_extract(reproduction_case.value, '$.requestId') IS NOT cell.request_id
              OR json_extract(reproduction_case.value, '$.profileVersionId') IS NOT profile_version.id
              OR json_extract(reproduction_case.value, '$.profileConfigSha256') IS NOT profile_version.config_sha256
              OR json_extract(reproduction_case.value, '$.target') IS NOT evaluation.target
          )
        )
      )
  ) THEN RAISE(ABORT, 'evaluation run does not match its frozen source, authority, cell, and published configuration') END;
END;

DROP TRIGGER tr_review_run_job_links_consistency;

CREATE TRIGGER tr_review_run_job_links_consistency BEFORE INSERT ON review_run_job_links
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM review_run_job_links WHERE review_run_id = NEW.review_run_id) >= 4096
    THEN RAISE(ABORT, 'review run job association limit reached') END;
  SELECT CASE WHEN NEW.activation_number != COALESCE((
    SELECT MAX(activation_number) FROM review_run_job_links
    WHERE review_run_id = NEW.review_run_id AND request_id = NEW.request_id
  ), 0) + 1 THEN RAISE(ABORT, 'review run job activations must be consecutive') END;
  SELECT CASE WHEN NOT (EXISTS (
    SELECT 1 FROM review_runs AS run
    JOIN review_run_requests AS request ON request.review_run_id = run.id
    JOIN jobs AS job ON job.id = NEW.job_id
    JOIN managed_repositories AS repository ON repository.id = run.repository_id
    JOIN work_items AS item ON item.id = run.work_item_id
    JOIN request_epochs AS epoch ON epoch.id = run.request_epoch_id
    JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id
    WHERE run.id = NEW.review_run_id AND request.request_id = NEW.request_id
      AND run.purpose = 'review'
      AND repository.enabled = 1 AND item.state = 'open' AND epoch.status = 'active'
      AND repository.reviewer_github_user_id = json_extract(run.plan_json, '$.authorization.targetGithubUserId')
      AND repository.authorization_policy_json IS NOT NULL
      AND NOT EXISTS (
        SELECT key, value, type FROM json_each(repository.authorization_policy_json)
        EXCEPT SELECT key, value, type FROM json_each(run.plan_json, '$.authorization.policy')
      )
      AND NOT EXISTS (
        SELECT key, value, type FROM json_each(run.plan_json, '$.authorization.policy')
        EXCEPT SELECT key, value, type FROM json_each(repository.authorization_policy_json)
      )
      AND item.current_revision_key = run.revision_key AND revision.revision_key = run.revision_key
      AND job.work_item_id = run.work_item_id AND job.resource_revision = run.revision_key
      AND job.request_epoch_id = run.request_epoch_id
      AND job.status = 'queued' AND job.attempt_count = 0
      AND NOT EXISTS (SELECT 1 FROM run_attempts WHERE job_id = job.id)
      AND epoch.target_github_user_id = json_extract(run.plan_json, '$.authorization.targetGithubUserId')
      AND epoch.ordinal = json_extract(run.plan_json, '$.authorization.sequence')
      AND job.job_kind = CASE WHEN request.workflow_kind IN ('pr_static_build', 'pr_ui') THEN 'pull_request_review' ELSE 'issue_triage' END
      AND json_extract(job.execution_json, '$.repository.githubRepositoryId') IS json_extract(run.plan_json, '$.repository.githubRepositoryId')
      AND json_extract(job.execution_json, '$.repository.fullName') IS json_extract(run.plan_json, '$.repository.fullName')
      AND json_extract(job.execution_json, '$.resource.kind') IS json_extract(run.plan_json, '$.workItem.kind')
      AND json_extract(job.execution_json, '$.resource.githubNodeId') IS json_extract(run.plan_json, '$.workItem.githubNodeId')
      AND json_extract(job.execution_json, '$.resource.number') IS json_extract(run.plan_json, '$.workItem.number')
      AND json_extract(job.execution_json, '$.resource.title') IS json_extract(run.plan_json, '$.workItem.title')
      AND json_extract(job.execution_json, '$.resource.author') IS json_extract(run.plan_json, '$.workItem.author')
      AND json_extract(job.execution_json, '$.resource.canonicalSnapshot') IS json_extract(run.plan_json, '$.workItem')
      AND CASE WHEN json_extract(run.plan_json, '$.workItem.kind') = 'pull_request' THEN (
        json_extract(job.execution_json, '$.resource.baseSha') IS json_extract(run.plan_json, '$.revision.baseSha')
        AND json_extract(job.execution_json, '$.resource.headSha') IS json_extract(run.plan_json, '$.revision.headSha')
        AND json_extract(job.execution_json, '$.resource.isDraft') IS json_extract(run.plan_json, '$.workItem.isDraft')
      ) ELSE json_extract(job.execution_json, '$.resource.revisionDigest') IS run.revision_key END
      AND json_extract(job.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV1'
      AND json_extract(job.execution_json, '$.validation.runId') IS run.id
      AND json_extract(job.execution_json, '$.validation.planDigest') IS run.plan_digest
      AND json_extract(job.execution_json, '$.validation.activationId') IS run.activation_id
      AND json_extract(job.execution_json, '$.validation.requestId') IS request.request_id
      AND json_extract(job.execution_json, '$.validation.jobActivation') IS NEW.activation_number
      AND json_extract(job.execution_json, '$.validation.repositoryId') IS run.repository_id
      AND json_extract(job.execution_json, '$.validation.workItemId') IS run.work_item_id
      AND json_extract(job.execution_json, '$.validation.revisionKey') IS run.revision_key
      AND json_extract(job.execution_json, '$.validation.requestEpochId') IS run.request_epoch_id
      AND json_extract(job.execution_json, '$.validation.workflowKind') IS request.workflow_kind
      AND json_extract(job.execution_json, '$.validation.target') IS request.target
      AND json_extract(job.execution_json, '$.validation.required') IS request.required
      AND request.profile_version_id IS NOT NULL AND request.prompt_version_id IS NOT NULL
      AND json_extract(job.execution_json, '$.prompt') IS request.prompt_envelope_json
      AND json_extract(job.execution_json, '$.executionPolicy.hardTimeoutMs') IS json_extract(request.request_json, '$.profileVersion.config.hardTimeoutMs')
      AND json_extract(job.execution_json, '$.executionPolicy.noProgressTimeoutMs') IS json_extract(request.request_json, '$.profileVersion.config.noProgressTimeoutMs')
      AND json_extract(job.execution_json, '$.executionPolicy.allowedRecipeIds') IS '[]'
      AND json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.executionEnvelope') IS '2'
      AND json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.' || CASE request.target
        WHEN 'headless' THEN 'validationHeadless' WHEN 'web' THEN 'validationWeb' ELSE 'validationWindowsDesktop' END) IS '1'
      -- Extensions are derived from the immutable request. No extra or missing labels are allowed.
      AND json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels') IS 'object'
      AND CASE WHEN EXISTS (
        SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
        WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
      ) THEN (
        request.workflow_kind = 'issue_validation'
        AND json_extract(run.plan_json, '$.workItem.kind') IS 'issue'
        AND json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.issueReproduction') IS '1'
        AND json_type(job.execution_json, '$.validation.reproduction') IS 'object'
        AND json_extract(job.execution_json, '$.validation.reproduction') IS json_extract(run.plan_json, '$.reproduction')
        AND NOT EXISTS (
          SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
          WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
            AND (json_extract(reproduction_case.value, '$.profileVersionId') IS NOT request.profile_version_id
              OR json_extract(reproduction_case.value, '$.profileConfigSha256') IS NOT json_extract(request.request_json, '$.profileVersion.configSha256')
              OR json_extract(reproduction_case.value, '$.target') IS NOT request.target)
        )
      ) ELSE (
        json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.issueReproduction') IS NULL
        AND json_type(job.execution_json, '$.validation.reproduction') IS NULL
      ) END
      AND CASE WHEN EXISTS (
        SELECT 1 FROM json_each(request.request_json, '$.profileVersion.config.test') AS test_step
        WHERE json_type(test_step.value, '$.probeOutput') IS 'object'
      ) THEN json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.structuredProbeOutput') IS '1'
      ELSE json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.structuredProbeOutput') IS NULL END
      AND CASE WHEN (
        EXISTS (
          SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
          WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
            AND json_extract(reproduction_case.value, '$.target') != 'headless'
        ) OR (
          json_extract(request.request_json, '$.profileVersion.config.ui.target') IS 'web'
          AND json_extract(request.request_json, '$.profileVersion.config.ui.evidence.trace') IS 'off'
        )
      ) THEN json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.uiAssertionObservation') IS '1'
      ELSE json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.uiAssertionObservation') IS NULL END
      AND (SELECT COUNT(*) FROM json_each(job.execution_json, '$.executionPolicy.requiredCapabilityLabels')) = 2
        + EXISTS (
          SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
          WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
        )
        + EXISTS (
          SELECT 1 FROM json_each(request.request_json, '$.profileVersion.config.test') AS test_step
          WHERE json_type(test_step.value, '$.probeOutput') IS 'object'
        )
        + (EXISTS (
          SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
          WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
            AND json_extract(reproduction_case.value, '$.target') != 'headless'
        ) OR (
          json_extract(request.request_json, '$.profileVersion.config.ui.target') IS 'web'
          AND json_extract(request.request_json, '$.profileVersion.config.ui.evidence.trace') IS 'off'
        ))
      AND json_extract(job.execution_json, '$.validation.profileVersion') IS json_extract(request.request_json, '$.profileVersion')
      AND json_extract(job.execution_json, '$.validation.promptVersion.id') IS request.prompt_version_id
      AND json_extract(job.execution_json, '$.validation.promptVersion.templateId') IS json_extract(request.request_json, '$.prompt.version.templateId')
      AND json_extract(job.execution_json, '$.validation.promptVersion.version') IS json_extract(request.request_json, '$.prompt.version.version')
      AND json_extract(job.execution_json, '$.validation.promptVersion.contentSha256') IS json_extract(request.request_json, '$.prompt.version.contentSha256')
      AND json_extract(job.execution_json, '$.validation.requiredCheckIds') IS json_extract(request.request_json, '$.requiredCheckIds')
      AND json_extract(job.execution_json, '$.validation.testedSourceRevision') IS json_extract(run.plan_json, '$.testedSourceRevision')
      AND json_extract(job.execution_json, '$.validation.testedSourceAuthorization') IS json_extract(run.plan_json, '$.testedSourceAuthorization')
      AND (request.workflow_kind != 'issue_validation' OR (
        json_type(run.plan_json, '$.testedSourceRevision') IS 'object'
        AND json_type(run.plan_json, '$.testedSourceAuthorization') IS 'object'
      ))
      AND NOT EXISTS (
        SELECT 1 FROM json_each(run.readiness_json) AS readiness,
          json_each(readiness.value, '$.reasons') AS reason
        WHERE json_extract(readiness.value, '$.requestId') = request.request_id
          AND json_extract(reason.value, '$.code') NOT IN (
            'unsupported_target', 'missing_capability', 'evidence_delivery_unavailable'
          )
      )
  ) OR EXISTS (
    SELECT 1 FROM review_runs AS run
    JOIN review_run_requests AS request ON request.review_run_id = run.id
    JOIN jobs AS job ON job.id = NEW.job_id
    JOIN managed_repositories AS repository ON repository.id = run.repository_id
    JOIN work_items AS item ON item.id = run.work_item_id
    JOIN evaluation_cells AS cell ON cell.id = run.evaluation_cell_id AND cell.run_id = run.id
      AND cell.repository_id = run.repository_id AND cell.request_id = request.request_id
      AND cell.activation_id = run.activation_id AND cell.profile_version_id = request.profile_version_id
      AND cell.prompt_version_id = request.prompt_version_id
    JOIN evaluations AS evaluation ON evaluation.id = cell.evaluation_id AND evaluation.repository_id = run.repository_id
    JOIN evaluation_seals AS seal ON seal.evaluation_id = evaluation.id
    JOIN evaluation_controls AS control ON control.evaluation_id = evaluation.id AND control.status = 'active'
    JOIN evaluation_authorizations AS authorization ON authorization.id = cell.authorization_id
      AND authorization.evaluation_id = evaluation.id AND authorization.repository_id = run.repository_id
    JOIN work_item_revisions AS revision ON revision.id = run.revision_id AND revision.work_item_id = run.work_item_id
    WHERE run.id = NEW.review_run_id AND request.request_id = NEW.request_id
      AND run.purpose = 'evaluation' AND run.request_epoch_id IS NULL
      AND json_extract(run.plan_json, '$.schemaVersion') IS 'ReviewRunExecutionPlanV2'
      AND repository.enabled = 1 AND cell.applicable = 1 AND cell.trial = 1
      AND NEW.activation_number = 1 AND revision.revision_key = run.revision_key
      AND json_extract(run.plan_json, '$.authorization') IS authorization.authorization_json
      AND json_extract(run.plan_json, '$.purpose.evaluationId') IS evaluation.id
      AND json_extract(run.plan_json, '$.purpose.authorizationId') IS authorization.id
      AND json_extract(run.plan_json, '$.purpose.executionManifestSha256') IS evaluation.execution_manifest_sha256
      AND job.work_item_id = run.work_item_id AND job.resource_revision = run.revision_key
      AND job.request_epoch_id IS NULL AND job.source_event_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM job_request_epochs WHERE job_id = job.id)
      AND job.status = 'queued' AND job.attempt_count = 0
      AND NOT EXISTS (SELECT 1 FROM run_attempts WHERE job_id = job.id)
      AND job.job_kind = CASE WHEN request.workflow_kind IN ('pr_static_build', 'pr_ui') THEN 'pull_request_review' ELSE 'issue_triage' END
      AND json_extract(job.execution_json, '$.repository.githubRepositoryId') IS json_extract(run.plan_json, '$.repository.githubRepositoryId')
      AND json_extract(job.execution_json, '$.repository.fullName') IS json_extract(run.plan_json, '$.repository.fullName')
      AND json_extract(job.execution_json, '$.resource.kind') IS json_extract(run.plan_json, '$.workItem.kind')
      AND json_extract(job.execution_json, '$.resource.githubNodeId') IS json_extract(run.plan_json, '$.workItem.githubNodeId')
      AND json_extract(job.execution_json, '$.resource.number') IS json_extract(run.plan_json, '$.workItem.number')
      AND json_extract(job.execution_json, '$.resource.title') IS json_extract(run.plan_json, '$.workItem.title')
      AND json_extract(job.execution_json, '$.resource.author') IS json_extract(run.plan_json, '$.workItem.author')
      AND json_extract(job.execution_json, '$.resource.canonicalSnapshot') IS json_extract(run.plan_json, '$.workItem')
      AND CASE WHEN json_extract(run.plan_json, '$.workItem.kind') = 'pull_request' THEN (
        json_extract(job.execution_json, '$.resource.baseSha') IS json_extract(run.plan_json, '$.revision.baseSha')
        AND json_extract(job.execution_json, '$.resource.headSha') IS json_extract(run.plan_json, '$.revision.headSha')
        AND json_extract(job.execution_json, '$.resource.isDraft') IS json_extract(run.plan_json, '$.workItem.isDraft')
      ) ELSE json_extract(job.execution_json, '$.resource.revisionDigest') IS run.revision_key END
      AND json_extract(job.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
      AND json_extract(job.execution_json, '$.validation.runId') IS run.id
      AND json_extract(job.execution_json, '$.validation.planDigest') IS run.plan_digest
      AND json_extract(job.execution_json, '$.validation.activationId') IS run.activation_id
      AND json_extract(job.execution_json, '$.validation.requestId') IS request.request_id
      AND json_extract(job.execution_json, '$.validation.jobActivation') IS NEW.activation_number
      AND json_extract(job.execution_json, '$.validation.repositoryId') IS run.repository_id
      AND json_extract(job.execution_json, '$.validation.workItemId') IS run.work_item_id
      AND json_extract(job.execution_json, '$.validation.revisionKey') IS run.revision_key
      AND json_extract(job.execution_json, '$.validation.requestEpochId') IS run.request_epoch_id
      AND json_extract(job.execution_json, '$.validation.workflowKind') IS request.workflow_kind
      AND json_extract(job.execution_json, '$.validation.target') IS request.target
      AND json_extract(job.execution_json, '$.validation.required') IS request.required
      AND request.profile_version_id IS NOT NULL AND request.prompt_version_id IS NOT NULL
      AND json_extract(job.execution_json, '$.prompt') IS request.prompt_envelope_json
      AND json_extract(job.execution_json, '$.executionPolicy.hardTimeoutMs') IS json_extract(request.request_json, '$.profileVersion.config.hardTimeoutMs')
      AND json_extract(job.execution_json, '$.executionPolicy.noProgressTimeoutMs') IS json_extract(request.request_json, '$.profileVersion.config.noProgressTimeoutMs')
      AND json_extract(job.execution_json, '$.executionPolicy.allowedRecipeIds') IS '[]'
      AND json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.executionEnvelope') IS '2'
      AND json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.validationEvaluation') IS '1'
      AND json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.' || CASE request.target
        WHEN 'headless' THEN 'validationHeadless' WHEN 'web' THEN 'validationWeb' ELSE 'validationWindowsDesktop' END) IS '1'
      -- Extensions are derived from the immutable request. No extra or missing labels are allowed.
      AND json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels') IS 'object'
      AND CASE WHEN EXISTS (
        SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
        WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
      ) THEN (
        request.workflow_kind = 'issue_validation'
        AND json_extract(run.plan_json, '$.workItem.kind') IS 'issue'
        AND json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.issueReproduction') IS '1'
        AND json_type(job.execution_json, '$.validation.reproduction') IS 'object'
        AND json_extract(job.execution_json, '$.validation.reproduction') IS json_extract(run.plan_json, '$.reproduction')
        AND NOT EXISTS (
          SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
          WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
            AND (json_extract(reproduction_case.value, '$.profileVersionId') IS NOT request.profile_version_id
              OR json_extract(reproduction_case.value, '$.profileConfigSha256') IS NOT json_extract(request.request_json, '$.profileVersion.configSha256')
              OR json_extract(reproduction_case.value, '$.target') IS NOT request.target)
        )
      ) ELSE (
        json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.issueReproduction') IS NULL
        AND json_type(job.execution_json, '$.validation.reproduction') IS NULL
      ) END
      AND CASE WHEN EXISTS (
        SELECT 1 FROM json_each(request.request_json, '$.profileVersion.config.test') AS test_step
        WHERE json_type(test_step.value, '$.probeOutput') IS 'object'
      ) THEN json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.structuredProbeOutput') IS '1'
      ELSE json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.structuredProbeOutput') IS NULL END
      AND CASE WHEN (
        EXISTS (
          SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
          WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
            AND json_extract(reproduction_case.value, '$.target') != 'headless'
        ) OR (
          json_extract(request.request_json, '$.profileVersion.config.ui.target') IS 'web'
          AND json_extract(request.request_json, '$.profileVersion.config.ui.evidence.trace') IS 'off'
        )
      ) THEN json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.uiAssertionObservation') IS '1'
      ELSE json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.uiAssertionObservation') IS NULL END
      AND (SELECT COUNT(*) FROM json_each(job.execution_json, '$.executionPolicy.requiredCapabilityLabels')) = 3
        + EXISTS (
          SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
          WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
        )
        + EXISTS (
          SELECT 1 FROM json_each(request.request_json, '$.profileVersion.config.test') AS test_step
          WHERE json_type(test_step.value, '$.probeOutput') IS 'object'
        )
        + (EXISTS (
          SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
          WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
            AND json_extract(reproduction_case.value, '$.target') != 'headless'
        ) OR (
          json_extract(request.request_json, '$.profileVersion.config.ui.target') IS 'web'
          AND json_extract(request.request_json, '$.profileVersion.config.ui.evidence.trace') IS 'off'
        ))
      AND json_extract(job.execution_json, '$.validation.profileVersion') IS json_extract(request.request_json, '$.profileVersion')
      AND json_extract(job.execution_json, '$.validation.promptVersion.id') IS request.prompt_version_id
      AND json_extract(job.execution_json, '$.validation.promptVersion.templateId') IS json_extract(request.request_json, '$.prompt.version.templateId')
      AND json_extract(job.execution_json, '$.validation.promptVersion.version') IS json_extract(request.request_json, '$.prompt.version.version')
      AND json_extract(job.execution_json, '$.validation.promptVersion.contentSha256') IS json_extract(request.request_json, '$.prompt.version.contentSha256')
      AND json_extract(job.execution_json, '$.validation.requiredCheckIds') IS json_extract(request.request_json, '$.requiredCheckIds')
      AND json_extract(job.execution_json, '$.validation.testedSourceRevision') IS json_extract(run.plan_json, '$.testedSourceRevision')
      AND json_extract(job.execution_json, '$.validation.testedSourceAuthorization') IS json_extract(run.plan_json, '$.testedSourceAuthorization')
      AND (request.workflow_kind != 'issue_validation' OR (
        json_type(run.plan_json, '$.testedSourceRevision') IS 'object'
        AND json_extract(run.plan_json, '$.testedSourceRevision.kind') IS 'commit'
      ))
      AND NOT EXISTS (
        SELECT 1 FROM json_each(run.readiness_json) AS readiness,
          json_each(readiness.value, '$.reasons') AS reason
        WHERE json_extract(readiness.value, '$.requestId') = request.request_id
          AND json_extract(reason.value, '$.code') NOT IN (
            'unsupported_target', 'missing_capability', 'evidence_delivery_unavailable'
          )
      )
      AND json_type(job.execution_json, '$.validation') IS 'object'
      AND json_type(job.execution_json, '$.validation.schemaVersion') IS 'text'
      AND json_type(job.execution_json, '$.validation.runId') IS 'text'
      AND json_type(job.execution_json, '$.validation.planDigest') IS 'text'
      AND json_type(job.execution_json, '$.validation.activationId') IS 'text'
      AND json_type(job.execution_json, '$.validation.requestId') IS 'text'
      AND json_type(job.execution_json, '$.validation.jobActivation') IS 'integer'
      AND json_type(job.execution_json, '$.validation.repositoryId') IS 'text'
      AND json_type(job.execution_json, '$.validation.workItemId') IS 'text'
      AND json_type(job.execution_json, '$.validation.revisionKey') IS 'text'
      AND json_type(job.execution_json, '$.validation.workflowKind') IS 'text'
      AND json_type(job.execution_json, '$.validation.target') IS 'text'
      AND json_type(job.execution_json, '$.validation.required') IN ('true', 'false')
      AND json_type(job.execution_json, '$.validation.requestEpochId') IS 'null'
      AND json_type(job.execution_json, '$.validation.testedSourceAuthorization') IS 'null'
      AND json_type(job.execution_json, '$.validation.profileVersion') IS 'object'
      AND json_type(job.execution_json, '$.validation.requiredCheckIds') IS 'array'
      AND json_type(job.execution_json, '$.validation.purpose') IS 'object'
      AND json_type(job.execution_json, '$.validation.source') IS 'object'
      AND json_type(job.execution_json, '$.validation.authorization') IS 'object'
      AND json_type(job.execution_json, '$.validation.modelRequirements') IS 'object'
      AND json_type(job.execution_json, '$.validation.testedSourceRevision') IS json_type(run.plan_json, '$.testedSourceRevision')
      AND json_extract(job.execution_json, '$.validation.testedSourceRevision') IS json_extract(run.plan_json, '$.testedSourceRevision')
      AND json_type(job.execution_json, '$.validation.reproduction') IS json_type(run.plan_json, '$.reproduction')
      AND json_extract(job.execution_json, '$.validation.reproduction') IS json_extract(run.plan_json, '$.reproduction')
      AND json_extract(job.execution_json, '$.validation.profileVersion') IS json_extract(request.request_json, '$.profileVersion')
      AND json_extract(job.execution_json, '$.validation.requiredCheckIds') IS json_extract(request.request_json, '$.requiredCheckIds')
      AND json_extract(job.execution_json, '$.validation.purpose') IS json_extract(run.plan_json, '$.purpose')
      AND json_extract(job.execution_json, '$.validation.source') IS json_extract(run.plan_json, '$.source')
      AND json_extract(job.execution_json, '$.validation.authorization') IS json_extract(run.plan_json, '$.authorization')
      AND json_extract(job.execution_json, '$.validation.modelRequirements') IS json_extract(run.plan_json, '$.modelRequirements')
      AND json_type(job.execution_json, '$.validation.modelRuntimeRegistration') IS json_type(run.plan_json, '$.modelRuntimeRegistration')
      AND CAST(json_extract(job.execution_json, '$.validation.modelRuntimeRegistration') AS BLOB)
        IS CAST(json_extract(run.plan_json, '$.modelRuntimeRegistration') AS BLOB)
      AND NOT EXISTS (SELECT 1 FROM json_each(job.execution_json, '$.validation')
        WHERE key NOT IN ('schemaVersion', 'runId', 'planDigest', 'activationId', 'requestId',
          'jobActivation', 'repositoryId', 'workItemId', 'revisionKey', 'requestEpochId',
          'workflowKind', 'target', 'required', 'profileVersion', 'promptVersion', 'requiredCheckIds',
          'testedSourceRevision', 'testedSourceAuthorization', 'reproduction', 'purpose', 'source',
          'authorization', 'modelRequirements', 'modelRuntimeRegistration'))
      AND (SELECT COUNT(*) FROM json_each(job.execution_json, '$.validation')) =
        22 + (json_type(job.execution_json, '$.validation.reproduction') IS 'object')
          + (json_type(job.execution_json, '$.validation.modelRuntimeRegistration') IS 'object')
      AND NOT EXISTS (SELECT key FROM json_each(job.execution_json, '$.validation')
        GROUP BY key HAVING COUNT(*) != 1)
      AND json_type(job.execution_json, '$.validation.promptVersion') IS 'object'
      AND (SELECT COUNT(*) FROM json_each(job.execution_json, '$.validation.promptVersion')) = 4
      AND NOT EXISTS (SELECT 1 FROM json_each(job.execution_json, '$.validation.promptVersion')
        WHERE key NOT IN ('id', 'templateId', 'version', 'contentSha256'))
      AND json_type(job.execution_json, '$.validation.promptVersion.id') IS 'text'
      AND json_type(job.execution_json, '$.validation.promptVersion.templateId') IS 'text'
      AND json_type(job.execution_json, '$.validation.promptVersion.version') IS 'integer'
      AND json_type(job.execution_json, '$.validation.promptVersion.contentSha256') IS 'text'
      AND json_extract(job.execution_json, '$.validation.promptVersion.id') IS request.prompt_version_id
      AND json_extract(job.execution_json, '$.validation.promptVersion.templateId') IS json_extract(request.request_json, '$.prompt.version.templateId')
      AND json_extract(job.execution_json, '$.validation.promptVersion.version') IS json_extract(request.request_json, '$.prompt.version.version')
      AND json_extract(job.execution_json, '$.validation.promptVersion.contentSha256') IS json_extract(request.request_json, '$.prompt.version.contentSha256')
  )) THEN RAISE(ABORT, 'review run job does not match its frozen validation identity') END;
END;

DROP TRIGGER tr_validation_job_result_insert_consistency;

CREATE TRIGGER tr_validation_job_result_insert_consistency
BEFORE INSERT ON validation_job_results
WHEN NOT (EXISTS (
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
    AND run.purpose = 'review'
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
) OR EXISTS (
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
    AND run.purpose = 'evaluation' AND run.request_epoch_id IS NULL
    AND link.activation_number = 1 AND NEW.job_activation = 1
    AND job.source_event_id IS NULL AND job.cancellation_requested_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM job_request_epochs WHERE job_id = job.id)
    AND EXISTS (SELECT 1 FROM evaluation_cells AS cell
      JOIN evaluations AS evaluation ON evaluation.id = cell.evaluation_id AND evaluation.repository_id = cell.repository_id
      JOIN evaluation_seals AS seal ON seal.evaluation_id = evaluation.id
      JOIN evaluation_controls AS control ON control.evaluation_id = evaluation.id AND control.status = 'active'
      WHERE cell.id = run.evaluation_cell_id AND cell.run_id = run.id AND cell.repository_id = run.repository_id
        AND cell.request_id = request.request_id AND cell.activation_id = run.activation_id
        AND cell.profile_version_id = request.profile_version_id AND cell.prompt_version_id = request.prompt_version_id
        AND cell.applicable = 1 AND cell.trial = 1)
    AND attempt.job_id = NEW.job_id AND attempt.status = 'succeeded'
    AND attempt.result_digest IS NEW.result_digest
    AND CAST(attempt.result_json AS BLOB) IS CAST(NEW.result_json AS BLOB)
    AND job.id = NEW.job_id AND job.work_item_id = NEW.work_item_id
    AND job.job_kind = NEW.job_kind AND job.resource_revision = NEW.resource_revision
    AND job.current_run_attempt_id = NEW.run_attempt_id
    AND job.status IN ('leased', 'running')
    AND job.request_epoch_id IS NULL
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
    AND json_extract(job.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
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
      AND json_type(job.execution_json, '$.validation') IS 'object'
      AND json_type(job.execution_json, '$.validation.schemaVersion') IS 'text'
      AND json_type(job.execution_json, '$.validation.runId') IS 'text'
      AND json_type(job.execution_json, '$.validation.planDigest') IS 'text'
      AND json_type(job.execution_json, '$.validation.activationId') IS 'text'
      AND json_type(job.execution_json, '$.validation.requestId') IS 'text'
      AND json_type(job.execution_json, '$.validation.jobActivation') IS 'integer'
      AND json_type(job.execution_json, '$.validation.repositoryId') IS 'text'
      AND json_type(job.execution_json, '$.validation.workItemId') IS 'text'
      AND json_type(job.execution_json, '$.validation.revisionKey') IS 'text'
      AND json_type(job.execution_json, '$.validation.workflowKind') IS 'text'
      AND json_type(job.execution_json, '$.validation.target') IS 'text'
      AND json_type(job.execution_json, '$.validation.required') IN ('true', 'false')
      AND json_type(job.execution_json, '$.validation.requestEpochId') IS 'null'
      AND json_type(job.execution_json, '$.validation.testedSourceAuthorization') IS 'null'
      AND json_type(job.execution_json, '$.validation.profileVersion') IS 'object'
      AND json_type(job.execution_json, '$.validation.requiredCheckIds') IS 'array'
      AND json_type(job.execution_json, '$.validation.purpose') IS 'object'
      AND json_type(job.execution_json, '$.validation.source') IS 'object'
      AND json_type(job.execution_json, '$.validation.authorization') IS 'object'
      AND json_type(job.execution_json, '$.validation.modelRequirements') IS 'object'
      AND json_type(job.execution_json, '$.validation.testedSourceRevision') IS json_type(run.plan_json, '$.testedSourceRevision')
      AND json_extract(job.execution_json, '$.validation.testedSourceRevision') IS json_extract(run.plan_json, '$.testedSourceRevision')
      AND json_type(job.execution_json, '$.validation.reproduction') IS json_type(run.plan_json, '$.reproduction')
      AND json_extract(job.execution_json, '$.validation.reproduction') IS json_extract(run.plan_json, '$.reproduction')
      AND json_extract(job.execution_json, '$.validation.profileVersion') IS json_extract(request.request_json, '$.profileVersion')
      AND json_extract(job.execution_json, '$.validation.requiredCheckIds') IS json_extract(request.request_json, '$.requiredCheckIds')
      AND json_extract(job.execution_json, '$.validation.purpose') IS json_extract(run.plan_json, '$.purpose')
      AND json_extract(job.execution_json, '$.validation.source') IS json_extract(run.plan_json, '$.source')
      AND json_extract(job.execution_json, '$.validation.authorization') IS json_extract(run.plan_json, '$.authorization')
      AND json_extract(job.execution_json, '$.validation.modelRequirements') IS json_extract(run.plan_json, '$.modelRequirements')
      AND json_type(job.execution_json, '$.validation.modelRuntimeRegistration') IS json_type(run.plan_json, '$.modelRuntimeRegistration')
      AND CAST(json_extract(job.execution_json, '$.validation.modelRuntimeRegistration') AS BLOB)
        IS CAST(json_extract(run.plan_json, '$.modelRuntimeRegistration') AS BLOB)
      AND NOT EXISTS (SELECT 1 FROM json_each(job.execution_json, '$.validation')
        WHERE key NOT IN ('schemaVersion', 'runId', 'planDigest', 'activationId', 'requestId',
          'jobActivation', 'repositoryId', 'workItemId', 'revisionKey', 'requestEpochId',
          'workflowKind', 'target', 'required', 'profileVersion', 'promptVersion', 'requiredCheckIds',
          'testedSourceRevision', 'testedSourceAuthorization', 'reproduction', 'purpose', 'source',
          'authorization', 'modelRequirements', 'modelRuntimeRegistration'))
      AND (SELECT COUNT(*) FROM json_each(job.execution_json, '$.validation')) =
        22 + (json_type(job.execution_json, '$.validation.reproduction') IS 'object')
          + (json_type(job.execution_json, '$.validation.modelRuntimeRegistration') IS 'object')
      AND NOT EXISTS (SELECT key FROM json_each(job.execution_json, '$.validation')
        GROUP BY key HAVING COUNT(*) != 1)
      AND json_type(job.execution_json, '$.validation.promptVersion') IS 'object'
      AND (SELECT COUNT(*) FROM json_each(job.execution_json, '$.validation.promptVersion')) = 4
      AND NOT EXISTS (SELECT 1 FROM json_each(job.execution_json, '$.validation.promptVersion')
        WHERE key NOT IN ('id', 'templateId', 'version', 'contentSha256'))
      AND json_type(job.execution_json, '$.validation.promptVersion.id') IS 'text'
      AND json_type(job.execution_json, '$.validation.promptVersion.templateId') IS 'text'
      AND json_type(job.execution_json, '$.validation.promptVersion.version') IS 'integer'
      AND json_type(job.execution_json, '$.validation.promptVersion.contentSha256') IS 'text'
      AND json_extract(job.execution_json, '$.validation.promptVersion.id') IS request.prompt_version_id
      AND json_extract(job.execution_json, '$.validation.promptVersion.templateId') IS json_extract(request.request_json, '$.prompt.version.templateId')
      AND json_extract(job.execution_json, '$.validation.promptVersion.version') IS json_extract(request.request_json, '$.prompt.version.version')
      AND json_extract(job.execution_json, '$.validation.promptVersion.contentSha256') IS json_extract(request.request_json, '$.prompt.version.contentSha256')
))
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
