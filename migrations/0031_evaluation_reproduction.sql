-- The startup-owned rebuild preserves all stored bytes and current guards.
-- The helper extends only the retained Run trigger's manifest version, entry count,
-- and entry key allowlist; the V2-specific guards below validate the added reference.

CREATE TABLE new_evaluations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  suite_version_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL REFERENCES evaluation_source_versions(id) ON DELETE RESTRICT,
  expectation_version_id TEXT NOT NULL REFERENCES evaluation_expectation_versions(id) ON DELETE RESTRICT,
  workflow_kind TEXT NOT NULL,
  target TEXT NOT NULL,
  source_manifest_sha256 TEXT NOT NULL CHECK (length(source_manifest_sha256) = 64 AND source_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  configuration_manifest_sha256 TEXT NOT NULL CHECK (length(configuration_manifest_sha256) = 64 AND configuration_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  cell_manifest_sha256 TEXT NOT NULL CHECK (length(cell_manifest_sha256) = 64 AND cell_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  execution_manifest_sha256 TEXT NOT NULL CHECK (length(execution_manifest_sha256) = 64 AND execution_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  configuration_manifest_json TEXT NOT NULL CHECK (
    length(CAST(configuration_manifest_json AS BLOB)) BETWEEN 1 AND 2097152
    AND json_valid(configuration_manifest_json) AND json_type(configuration_manifest_json) IS 'object'
    AND json_extract(configuration_manifest_json, '$.schemaVersion') IS 'EvaluationConfigurationManifestV1'
    AND json_extract(configuration_manifest_json, '$.repositoryId') IS repository_id
    AND json_type(configuration_manifest_json, '$.baseline') IS 'object'
    AND json_type(configuration_manifest_json, '$.candidate') IS 'object'
  ),
  cell_manifest_json TEXT NOT NULL CHECK (
    length(CAST(cell_manifest_json AS BLOB)) BETWEEN 1 AND 262144
    AND json_valid(cell_manifest_json) AND json_type(cell_manifest_json) IS 'object'
    AND json_extract(cell_manifest_json, '$.schemaVersion') IN ('EvaluationCellManifestV1', 'EvaluationCellManifestV2')
    AND json_extract(cell_manifest_json, '$.evaluationId') IS id
    AND json_extract(cell_manifest_json, '$.repositoryId') IS repository_id
    AND json_type(cell_manifest_json, '$.cells') IS 'array'
    AND json_array_length(cell_manifest_json, '$.cells') BETWEEN 2 AND 64
  ),
  execution_manifest_json TEXT NOT NULL CHECK (
    length(CAST(execution_manifest_json AS BLOB)) BETWEEN 1 AND 16384
    AND json_valid(execution_manifest_json) AND json_type(execution_manifest_json) IS 'object'
    AND json_extract(execution_manifest_json, '$.schemaVersion') IS 'EvaluationExecutionManifestV1'
    AND json_extract(execution_manifest_json, '$.evaluationId') IS id
    AND json_extract(execution_manifest_json, '$.repositoryId') IS repository_id
    AND json_extract(execution_manifest_json, '$.sampleSetVersionId') IS suite_version_id
    AND json_extract(execution_manifest_json, '$.sourceManifestSha256') IS source_manifest_sha256
    AND json_extract(execution_manifest_json, '$.configurationManifestSha256') IS configuration_manifest_sha256
    AND json_extract(execution_manifest_json, '$.cellManifestSha256') IS cell_manifest_sha256
    AND json_extract(execution_manifest_json, '$.trial') IS 1
    AND json_extract(execution_manifest_json, '$.upstreamMutationPolicy') IS 'forbidden'
  ),
  scoring_plan_digest TEXT NOT NULL CHECK (length(scoring_plan_digest) = 64 AND scoring_plan_digest NOT GLOB '*[^0-9a-f]*'),
  scoring_plan_json TEXT NOT NULL CHECK (
    length(CAST(scoring_plan_json AS BLOB)) BETWEEN 1 AND 16777216
    AND json_valid(scoring_plan_json) AND json_type(scoring_plan_json) IS 'object'
    AND json_extract(scoring_plan_json, '$.schemaVersion') IS 'EvaluationScoringPlanV1'
    AND json_extract(scoring_plan_json, '$.evaluationId') IS id
    AND json_extract(scoring_plan_json, '$.repositoryId') IS repository_id
    AND json_extract(scoring_plan_json, '$.sampleSetVersionId') IS suite_version_id
    AND json_extract(scoring_plan_json, '$.expectationVersionId') IS expectation_version_id
    AND json_type(scoring_plan_json, '$.cases') IS 'array'
    AND json_array_length(scoring_plan_json, '$.cases') IS case_count
  ),
  case_count INTEGER NOT NULL CHECK (case_count BETWEEN 1 AND 32),
  cell_count INTEGER NOT NULL CHECK (cell_count = case_count * 2 AND cell_count = json_array_length(cell_manifest_json, '$.cells')),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  created_at TEXT NOT NULL,
  UNIQUE (id, repository_id),
  FOREIGN KEY (suite_version_id, repository_id) REFERENCES evaluation_suite_versions(id, repository_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO new_evaluations (rowid, id, repository_id, suite_version_id, source_version_id, expectation_version_id, workflow_kind, target, source_manifest_sha256, configuration_manifest_sha256, cell_manifest_sha256, execution_manifest_sha256, configuration_manifest_json, cell_manifest_json, execution_manifest_json, scoring_plan_digest, scoring_plan_json, case_count, cell_count, actor_issuer, actor_subject, created_at)
SELECT rowid, id, repository_id, suite_version_id, source_version_id, expectation_version_id, workflow_kind, target, source_manifest_sha256, configuration_manifest_sha256, cell_manifest_sha256, execution_manifest_sha256, configuration_manifest_json, cell_manifest_json, execution_manifest_json, scoring_plan_digest, scoring_plan_json, case_count, cell_count, actor_issuer, actor_subject, created_at
FROM evaluations;
DROP TABLE evaluations;
ALTER TABLE new_evaluations RENAME TO evaluations;

-- Sidecars are immutable evidence. None grants model, execution, or completion authority.
CREATE TABLE evaluation_reproduction_sources (
  source_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  definition_sha256 TEXT NOT NULL CHECK (length(definition_sha256) = 64 AND length(CAST(definition_sha256 AS BLOB)) = 64 AND instr(definition_sha256, char(0)) = 0 AND definition_sha256 NOT GLOB '*[^0-9a-f]*'),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json) AND json_type(definition_json) IS 'object'
    AND length(CAST(definition_json AS BLOB)) BETWEEN 1 AND 2129920),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (source_id, repository_id, definition_sha256),
  FOREIGN KEY (source_id, repository_id) REFERENCES evaluation_sources(id, repository_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE evaluation_reproduction_cells (
  cell_id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_definition_sha256 TEXT CHECK (source_definition_sha256 IS NULL OR (length(source_definition_sha256) = 64 AND length(CAST(source_definition_sha256 AS BLOB)) = 64 AND instr(source_definition_sha256, char(0)) = 0 AND source_definition_sha256 NOT GLOB '*[^0-9a-f]*')),
  record_sha256 TEXT NOT NULL CHECK (length(record_sha256) = 64 AND length(CAST(record_sha256 AS BLOB)) = 64 AND instr(record_sha256, char(0)) = 0 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND json_type(record_json) IS 'object'
    AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 2129920),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (cell_id, evaluation_id, repository_id, record_sha256),
  FOREIGN KEY (cell_id, evaluation_id, repository_id) REFERENCES evaluation_cells(id, evaluation_id, repository_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (source_id, repository_id) REFERENCES evaluation_sources(id, repository_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (source_id, repository_id, source_definition_sha256) REFERENCES evaluation_reproduction_sources(source_id, repository_id, definition_sha256) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE evaluation_reproduction_manifests (
  evaluation_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND length(CAST(manifest_sha256 AS BLOB)) = 64 AND instr(manifest_sha256, char(0)) = 0 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json) AND json_type(manifest_json) IS 'object'
    AND length(CAST(manifest_json AS BLOB)) BETWEEN 1 AND 262144),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (evaluation_id, repository_id, manifest_sha256),
  FOREIGN KEY (evaluation_id, repository_id) REFERENCES evaluations(id, repository_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER tr_evaluation_reproduction_sources_consistency BEFORE INSERT ON evaluation_reproduction_sources
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 WHERE
    NOT EXISTS (SELECT parent, key FROM json_tree(NEW.definition_json) WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1)
    AND (SELECT COUNT(*) FROM json_each(NEW.definition_json)) = 8
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.definition_json) WHERE key NOT IN
      ('schemaVersion','repositoryId','sourceId','sourceDigest','reviewRunId','planDigest','bindingDigest','binding'))
    AND json_extract(NEW.definition_json, '$.schemaVersion') IS 'EvaluationReproductionSourceDefinitionV1'
    AND json_extract(NEW.definition_json, '$.repositoryId') IS NEW.repository_id
    AND json_extract(NEW.definition_json, '$.sourceId') IS NEW.source_id
    AND json_type(NEW.definition_json, '$.binding') IS 'object'
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.definition_json) WHERE key IN ('sourceDigest','planDigest','bindingDigest')
      AND (type IS NOT 'text' OR length(value) != 64 OR length(CAST(value AS BLOB)) != 64
        OR instr(value, char(0)) != 0 OR value GLOB '*[^0-9a-f]*'))
  ) THEN RAISE(ABORT, 'evaluation reproduction source definition is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evaluation_sources AS source
    JOIN review_runs AS run ON run.id = json_extract(source.source_json, '$.provenance.reviewRunId')
      AND run.repository_id = source.repository_id
    WHERE source.id = NEW.source_id AND source.repository_id = NEW.repository_id
      AND json_extract(source.source_json, '$.provenance.kind') IS 'review_run'
      AND json_extract(NEW.definition_json, '$.sourceDigest') IS source.source_digest
      AND json_extract(NEW.definition_json, '$.reviewRunId') IS run.id
      AND json_extract(NEW.definition_json, '$.planDigest') IS run.plan_digest
      AND json_extract(source.source_json, '$.provenance.planDigest') IS run.plan_digest
      AND json_extract(NEW.definition_json, '$.bindingDigest') IS json_extract(run.plan_json, '$.reproduction.bindingDigest')
      AND json_type(run.plan_json, '$.reproduction.binding') IS 'object'
      AND CAST(json_extract(NEW.definition_json, '$.binding') AS BLOB) IS CAST(json_extract(run.plan_json, '$.reproduction.binding') AS BLOB)
  ) THEN RAISE(ABORT, 'evaluation reproduction definition does not match its frozen source Run') END;
END;

CREATE TRIGGER tr_evaluation_reproduction_cells_consistency BEFORE INSERT ON evaluation_reproduction_cells
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM evaluation_seals WHERE evaluation_id = NEW.evaluation_id)
    THEN RAISE(ABORT, 'evaluation reproduction cells must precede sealing') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 WHERE
    NOT EXISTS (SELECT parent, key FROM json_tree(NEW.record_json) WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1)
    AND (SELECT COUNT(*) FROM json_each(NEW.record_json)) = 13
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN
      ('schemaVersion','evaluationId','repositoryId','caseId','cellId','arm','sourceId','sourceDefinitionSha256',
       'selectedCaseIds','mappings','state','blockers','reproduction'))
    AND json_extract(NEW.record_json, '$.schemaVersion') IS 'EvaluationReproductionCellRecordV1'
    AND json_extract(NEW.record_json, '$.evaluationId') IS NEW.evaluation_id
    AND json_extract(NEW.record_json, '$.repositoryId') IS NEW.repository_id
    AND json_extract(NEW.record_json, '$.cellId') IS NEW.cell_id
    AND json_extract(NEW.record_json, '$.sourceId') IS NEW.source_id
    AND json_extract(NEW.record_json, '$.sourceDefinitionSha256') IS NEW.source_definition_sha256
    AND json_type(NEW.record_json, '$.sourceDefinitionSha256') IN ('text','null')
    AND json_extract(NEW.record_json, '$.state') IN ('ready','blocked','not_applicable')
    AND json_type(NEW.record_json, '$.selectedCaseIds') IS 'array'
    AND json_array_length(NEW.record_json, '$.selectedCaseIds') <= 32
    AND NOT EXISTS (SELECT value FROM json_each(NEW.record_json, '$.selectedCaseIds') GROUP BY value HAVING COUNT(*) != 1)
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.record_json, '$.selectedCaseIds')
      WHERE type IS NOT 'text' OR length(value) NOT BETWEEN 1 AND 128 OR instr(value, char(0)) != 0)
    AND json_type(NEW.record_json, '$.mappings') IN ('object','null')
    AND json_type(NEW.record_json, '$.blockers') IS 'array'
    AND json_array_length(NEW.record_json, '$.blockers') <= 16
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.record_json, '$.blockers') AS blocker
      WHERE NOT EXISTS (SELECT 1 WHERE blocker.type IS 'object'
        AND (SELECT COUNT(*) FROM json_each(blocker.value)) = 2
        AND NOT EXISTS (SELECT 1 FROM json_each(blocker.value) WHERE key NOT IN ('code','message'))
        AND json_extract(blocker.value, '$.code') IN ('mapping_missing','mapping_unmapped','mapping_invalid','profile_incompatible','result_too_large')
        AND json_type(blocker.value, '$.message') IS 'text'
        AND length(json_extract(blocker.value, '$.message')) BETWEEN 1 AND 2048
        AND instr(json_extract(blocker.value, '$.message'), char(0)) = 0))
    AND (json_type(NEW.record_json, '$.mappings') IS 'null' OR (
      (SELECT COUNT(*) FROM json_each(NEW.record_json, '$.mappings')) = 2
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.record_json, '$.mappings') WHERE key NOT IN ('observationMappings','checkMappings'))
      AND json_type(NEW.record_json, '$.mappings.observationMappings') IS 'array'
      AND json_type(NEW.record_json, '$.mappings.checkMappings') IS 'array'
      AND json_array_length(NEW.record_json, '$.mappings.observationMappings') <= 1536
      AND json_array_length(NEW.record_json, '$.mappings.checkMappings') <= 1536
      AND NOT EXISTS (SELECT json_extract(value, '$.fromCheckId')
        FROM json_each(NEW.record_json, '$.mappings.checkMappings')
        GROUP BY json_extract(value, '$.fromCheckId') HAVING COUNT(*) != 1)
      AND NOT EXISTS (SELECT json_extract(value, '$.from.kind'), json_extract(value, '$.from.testStepId'),
        json_extract(value, '$.from.observationId'), json_extract(value, '$.from.scenarioId'), json_extract(value, '$.from.stepId')
        FROM json_each(NEW.record_json, '$.mappings.observationMappings')
        GROUP BY json_extract(value, '$.from.kind'), json_extract(value, '$.from.testStepId'),
          json_extract(value, '$.from.observationId'), json_extract(value, '$.from.scenarioId'), json_extract(value, '$.from.stepId')
        HAVING COUNT(*) != 1)
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.record_json, '$.mappings.checkMappings') AS mapping
        WHERE NOT EXISTS (SELECT 1 WHERE mapping.type IS 'object'
          AND (SELECT COUNT(*) FROM json_each(mapping.value)) = 2
          AND NOT EXISTS (SELECT 1 FROM json_each(mapping.value) WHERE key NOT IN ('fromCheckId','toCheckId'))
          AND json_type(mapping.value, '$.fromCheckId') IS 'text'
          AND length(json_extract(mapping.value, '$.fromCheckId')) BETWEEN 3 AND 257
          AND instr(json_extract(mapping.value, '$.fromCheckId'), char(0)) = 0
          AND json_type(mapping.value, '$.toCheckId') IN ('text','null')
          AND (json_type(mapping.value, '$.toCheckId') IS 'null' OR (
            length(json_extract(mapping.value, '$.toCheckId')) BETWEEN 3 AND 257
            AND instr(json_extract(mapping.value, '$.toCheckId'), char(0)) = 0))))
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.record_json, '$.mappings.observationMappings') AS mapping
        WHERE NOT EXISTS (SELECT 1 WHERE mapping.type IS 'object'
          AND (SELECT COUNT(*) FROM json_each(mapping.value)) = 2
          AND NOT EXISTS (SELECT 1 FROM json_each(mapping.value) WHERE key NOT IN ('from','to'))
          AND json_type(mapping.value, '$.from') IS 'object'
          AND json_type(mapping.value, '$.to') IN ('object','null')
          AND NOT EXISTS (SELECT 1 FROM json_each(mapping.value) AS reference
            WHERE reference.type IS 'object' AND NOT EXISTS (SELECT 1 WHERE
              (SELECT COUNT(*) FROM json_each(reference.value)) = 3
              AND CASE json_extract(reference.value, '$.kind')
                WHEN 'probe_value' THEN NOT EXISTS (SELECT 1 FROM json_each(reference.value) WHERE key NOT IN ('kind','testStepId','observationId'))
                WHEN 'ui_assertion' THEN NOT EXISTS (SELECT 1 FROM json_each(reference.value) WHERE key NOT IN ('kind','scenarioId','stepId'))
                ELSE 0 END
              AND NOT EXISTS (SELECT 1 FROM json_each(reference.value) WHERE key != 'kind'
                AND (type IS NOT 'text' OR length(value) NOT BETWEEN 1 AND 128 OR instr(value, char(0)) != 0))
            ))))
    ))
    AND json_type(NEW.record_json, '$.reproduction') IN ('object','null')
    AND (json_type(NEW.record_json, '$.reproduction') IS 'null' OR (
      (SELECT COUNT(*) FROM json_each(NEW.record_json, '$.reproduction')) = 2
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.record_json, '$.reproduction') WHERE key NOT IN ('binding','bindingDigest'))
      AND json_type(NEW.record_json, '$.reproduction.binding') IS 'object'
    ))
    AND (NEW.source_definition_sha256 IS NOT NULL OR (
      json_extract(NEW.record_json, '$.state') IS 'not_applicable'
      AND json_type(NEW.record_json, '$.mappings') IS 'null'
      AND json_array_length(NEW.record_json, '$.selectedCaseIds') = 0
    ))
    AND CASE json_extract(NEW.record_json, '$.state')
      WHEN 'ready' THEN NEW.source_definition_sha256 IS NOT NULL
        AND json_type(NEW.record_json, '$.mappings') IS 'object'
        AND json_array_length(NEW.record_json, '$.selectedCaseIds') > 0
        AND json_type(NEW.record_json, '$.reproduction') IS 'object'
        AND json_array_length(NEW.record_json, '$.blockers') = 0
      WHEN 'blocked' THEN NEW.source_definition_sha256 IS NOT NULL
        AND json_type(NEW.record_json, '$.reproduction') IS 'null'
        AND json_array_length(NEW.record_json, '$.blockers') > 0
      WHEN 'not_applicable' THEN json_type(NEW.record_json, '$.reproduction') IS 'null'
        AND json_array_length(NEW.record_json, '$.blockers') = 0
      ELSE 0 END
  ) THEN RAISE(ABORT, 'evaluation reproduction cell record is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evaluation_cells AS cell
    JOIN evaluations AS evaluation ON evaluation.id = cell.evaluation_id AND evaluation.repository_id = cell.repository_id
    JOIN review_runs AS run ON run.id = cell.run_id AND run.evaluation_cell_id = cell.id AND run.purpose = 'evaluation'
    WHERE cell.id = NEW.cell_id AND cell.evaluation_id = NEW.evaluation_id
      AND cell.repository_id = NEW.repository_id AND cell.source_id = NEW.source_id
      AND NEW.created_at IS evaluation.created_at
      AND CASE WHEN cell.applicable = 0 OR NEW.source_definition_sha256 IS NULL
        THEN json_extract(NEW.record_json, '$.state') IS 'not_applicable'
        ELSE json_extract(NEW.record_json, '$.state') IN ('ready','blocked') END
      AND (NEW.source_definition_sha256 IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM evaluation_sources AS original_source
        JOIN review_runs AS original_run ON original_run.id = json_extract(original_source.source_json, '$.provenance.reviewRunId')
          AND original_run.repository_id = original_source.repository_id
        WHERE original_source.id = cell.source_id AND original_source.repository_id = cell.repository_id
          AND json_extract(original_source.source_json, '$.provenance.kind') IS 'review_run'
          AND json_type(original_run.plan_json, '$.reproduction') IS 'object'
      ))
      AND json_extract(NEW.record_json, '$.caseId') IS cell.case_id
      AND json_extract(NEW.record_json, '$.arm') IS cell.arm
      AND json_extract(evaluation.cell_manifest_json, '$.schemaVersion') IS 'EvaluationCellManifestV2'
      AND EXISTS (
        SELECT 1 FROM json_each(evaluation.cell_manifest_json, '$.cells') AS entry
        WHERE json_extract(entry.value, '$.cellId') IS cell.id
          AND json_extract(entry.value, '$.reproduction.state') IS json_extract(NEW.record_json, '$.state')
          AND json_extract(entry.value, '$.reproduction.cellRecordSha256') IS NEW.record_sha256
          AND json_extract(entry.value, '$.reproduction.bindingDigest') IS json_extract(NEW.record_json, '$.reproduction.bindingDigest')
      )
      AND CASE json_extract(NEW.record_json, '$.state') WHEN 'ready' THEN
        CAST(json_extract(NEW.record_json, '$.reproduction') AS BLOB) IS CAST(json_extract(run.plan_json, '$.reproduction') AS BLOB)
        ELSE json_type(run.plan_json, '$.reproduction') IS NULL END
  ) THEN RAISE(ABORT, 'evaluation reproduction cell does not match its frozen execution identity') END;
END;

CREATE TRIGGER tr_evaluation_reproduction_manifests_consistency BEFORE INSERT ON evaluation_reproduction_manifests
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM evaluation_seals WHERE evaluation_id = NEW.evaluation_id)
    THEN RAISE(ABORT, 'evaluation reproduction manifests must precede sealing') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 WHERE
    NOT EXISTS (SELECT parent, key FROM json_tree(NEW.manifest_json) WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1)
    AND (SELECT COUNT(*) FROM json_each(NEW.manifest_json)) = 5
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.manifest_json) WHERE key NOT IN
      ('schemaVersion','evaluationId','repositoryId','sources','cells'))
    AND json_extract(NEW.manifest_json, '$.schemaVersion') IS 'EvaluationReproductionManifestV1'
    AND json_extract(NEW.manifest_json, '$.evaluationId') IS NEW.evaluation_id
    AND json_extract(NEW.manifest_json, '$.repositoryId') IS NEW.repository_id
    AND json_type(NEW.manifest_json, '$.sources') IS 'array'
    AND json_array_length(NEW.manifest_json, '$.sources') BETWEEN 0 AND 32
    AND json_type(NEW.manifest_json, '$.cells') IS 'array'
    AND json_array_length(NEW.manifest_json, '$.cells') BETWEEN 2 AND 64
    AND NOT EXISTS (SELECT json_extract(value, '$.caseId') FROM json_each(NEW.manifest_json, '$.sources')
      GROUP BY json_extract(value, '$.caseId') HAVING COUNT(*) != 1)
    AND NOT EXISTS (SELECT json_extract(value, '$.cellId') FROM json_each(NEW.manifest_json, '$.cells')
      GROUP BY json_extract(value, '$.cellId') HAVING COUNT(*) != 1)
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.manifest_json, '$.sources') AS source
      WHERE source.type IS NOT 'object'
        OR (SELECT COUNT(*) FROM json_each(source.value)) != 3
        OR EXISTS (SELECT 1 FROM json_each(source.value) WHERE key NOT IN ('caseId','sourceId','sourceDefinitionSha256'))
        OR json_type(source.value, '$.sourceDefinitionSha256') IS NOT 'text'
        OR length(json_extract(source.value, '$.sourceDefinitionSha256')) != 64
        OR length(CAST(json_extract(source.value, '$.sourceDefinitionSha256') AS BLOB)) != 64
        OR instr(json_extract(source.value, '$.sourceDefinitionSha256'), char(0)) != 0
        OR json_extract(source.value, '$.sourceDefinitionSha256') GLOB '*[^0-9a-f]*')
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.manifest_json, '$.cells') AS cell
      WHERE cell.type IS NOT 'object'
        OR (SELECT COUNT(*) FROM json_each(cell.value)) != 4
        OR EXISTS (SELECT 1 FROM json_each(cell.value) WHERE key NOT IN ('cellId','caseId','arm','cellRecordSha256')))
  ) THEN RAISE(ABORT, 'evaluation reproduction manifest is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evaluations AS evaluation
    WHERE evaluation.id = NEW.evaluation_id AND evaluation.repository_id = NEW.repository_id
      AND NEW.created_at IS evaluation.created_at
      AND json_extract(evaluation.cell_manifest_json, '$.schemaVersion') IS 'EvaluationCellManifestV2'
      AND json_extract(evaluation.cell_manifest_json, '$.reproductionManifestSha256') IS NEW.manifest_sha256
      AND json_array_length(NEW.manifest_json, '$.sources') <= evaluation.case_count
      AND json_array_length(NEW.manifest_json, '$.cells') IS evaluation.cell_count
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.manifest_json, '$.sources') AS source
        WHERE NOT EXISTS (
          SELECT 1 FROM evaluation_source_versions AS version, json_each(version.manifest_json, '$.cases') AS entry
          WHERE version.id = evaluation.source_version_id
            AND json_extract(entry.value, '$.caseId') IS json_extract(source.value, '$.caseId')
            AND json_extract(entry.value, '$.sourceId') IS json_extract(source.value, '$.sourceId')
        ))
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.manifest_json, '$.cells') AS cell
        WHERE NOT EXISTS (
          SELECT 1 FROM json_each(evaluation.cell_manifest_json, '$.cells') AS entry
          WHERE json_extract(entry.value, '$.cellId') IS json_extract(cell.value, '$.cellId')
            AND json_extract(entry.value, '$.caseId') IS json_extract(cell.value, '$.caseId')
            AND json_extract(entry.value, '$.arm') IS json_extract(cell.value, '$.arm')
            AND json_extract(entry.value, '$.reproduction.cellRecordSha256') IS json_extract(cell.value, '$.cellRecordSha256')
        ))
  ) THEN RAISE(ABORT, 'evaluation reproduction manifest does not match its frozen matrix') END;
END;

CREATE TRIGGER tr_evaluation_reproduction_manifest_version BEFORE INSERT ON evaluations
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 WHERE
    NOT EXISTS (SELECT parent, key FROM json_tree(NEW.cell_manifest_json) WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1)
    AND CASE json_extract(NEW.cell_manifest_json, '$.schemaVersion')
      WHEN 'EvaluationCellManifestV1' THEN
        json_type(NEW.cell_manifest_json, '$.reproductionManifestSha256') IS NULL
        AND NOT EXISTS (SELECT 1 FROM json_each(NEW.cell_manifest_json, '$.cells')
          WHERE json_type(value, '$.reproduction') IS NOT NULL)
      WHEN 'EvaluationCellManifestV2' THEN
        (json_type(NEW.cell_manifest_json, '$.reproductionManifestSha256') IS 'text'
          AND length(json_extract(NEW.cell_manifest_json, '$.reproductionManifestSha256')) = 64
          AND length(CAST(json_extract(NEW.cell_manifest_json, '$.reproductionManifestSha256') AS BLOB)) = 64
          AND instr(json_extract(NEW.cell_manifest_json, '$.reproductionManifestSha256'), char(0)) = 0
          AND json_extract(NEW.cell_manifest_json, '$.reproductionManifestSha256') NOT GLOB '*[^0-9a-f]*')
        AND NOT EXISTS (SELECT 1 FROM json_each(NEW.cell_manifest_json, '$.cells') AS entry WHERE NOT EXISTS (SELECT 1 WHERE
          json_type(entry.value, '$.reproduction') IS 'object'
          AND (SELECT COUNT(*) FROM json_each(entry.value, '$.reproduction')) = 3
          AND NOT EXISTS (SELECT 1 FROM json_each(entry.value, '$.reproduction') WHERE key NOT IN ('state','bindingDigest','cellRecordSha256'))
          AND json_extract(entry.value, '$.reproduction.state') IN ('ready','blocked','not_applicable')
          AND (json_type(entry.value, '$.reproduction.cellRecordSha256') IS 'text' AND length(json_extract(entry.value, '$.reproduction.cellRecordSha256')) = 64 AND length(CAST(json_extract(entry.value, '$.reproduction.cellRecordSha256') AS BLOB)) = 64 AND instr(json_extract(entry.value, '$.reproduction.cellRecordSha256'), char(0)) = 0 AND json_extract(entry.value, '$.reproduction.cellRecordSha256') NOT GLOB '*[^0-9a-f]*')
          AND (json_type(entry.value, '$.reproduction.bindingDigest') IS 'null'
            OR (json_type(entry.value, '$.reproduction.bindingDigest') IS 'text' AND length(json_extract(entry.value, '$.reproduction.bindingDigest')) = 64 AND length(CAST(json_extract(entry.value, '$.reproduction.bindingDigest') AS BLOB)) = 64 AND instr(json_extract(entry.value, '$.reproduction.bindingDigest'), char(0)) = 0 AND json_extract(entry.value, '$.reproduction.bindingDigest') NOT GLOB '*[^0-9a-f]*'))
          AND CASE json_extract(entry.value, '$.reproduction.state') WHEN 'ready'
            THEN json_type(entry.value, '$.reproduction.bindingDigest') IS 'text'
            ELSE json_type(entry.value, '$.reproduction.bindingDigest') IS 'null' END
        ))
      ELSE 0 END
  ) THEN RAISE(ABORT, 'evaluation cell manifest reproduction metadata is invalid') END;
END;

CREATE TRIGGER tr_evaluation_reproduction_run BEFORE INSERT ON review_runs
WHEN NEW.purpose = 'evaluation'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM evaluation_cells AS cell
    JOIN evaluations AS evaluation ON evaluation.id = cell.evaluation_id AND evaluation.repository_id = cell.repository_id
    JOIN evaluation_sources AS source ON source.id = cell.source_id AND source.repository_id = cell.repository_id
    JOIN review_runs AS original_run ON original_run.id = json_extract(source.source_json, '$.provenance.reviewRunId')
      AND original_run.repository_id = source.repository_id
    WHERE cell.id = NEW.evaluation_cell_id AND cell.run_id = NEW.id AND cell.repository_id = NEW.repository_id
      AND json_extract(evaluation.cell_manifest_json, '$.schemaVersion') IS 'EvaluationCellManifestV1'
      AND json_extract(source.source_json, '$.provenance.kind') IS 'review_run'
      AND json_type(original_run.plan_json, '$.reproduction') IS 'object'
  ) THEN RAISE(ABORT, 'V1 evaluation Run cannot omit its source reproduction definition') END;
  SELECT CASE WHEN json_type(NEW.plan_json, '$.reproduction') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM evaluation_cells AS cell
    JOIN evaluations AS evaluation ON evaluation.id = cell.evaluation_id AND evaluation.repository_id = cell.repository_id,
      json_each(evaluation.cell_manifest_json, '$.cells') AS entry
    WHERE cell.id = NEW.evaluation_cell_id AND cell.run_id = NEW.id AND cell.repository_id = NEW.repository_id
      AND json_extract(evaluation.cell_manifest_json, '$.schemaVersion') IS 'EvaluationCellManifestV2'
      AND json_extract(entry.value, '$.cellId') IS cell.id
      AND json_extract(entry.value, '$.reproduction.state') IS 'ready'
      AND json_extract(entry.value, '$.reproduction.bindingDigest') IS json_extract(NEW.plan_json, '$.reproduction.bindingDigest')
  ) THEN RAISE(ABORT, 'evaluation reproduction Run requires a matching V2 cell') END;
END;

CREATE TRIGGER tr_evaluation_reproduction_seal BEFORE INSERT ON evaluation_seals
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM evaluations AS evaluation WHERE evaluation.id = NEW.evaluation_id
      AND json_extract(evaluation.cell_manifest_json, '$.schemaVersion') IS 'EvaluationCellManifestV2'
      AND NOT EXISTS (
        SELECT 1 FROM evaluation_reproduction_manifests AS root
        WHERE root.evaluation_id = evaluation.id AND root.repository_id = evaluation.repository_id
          AND root.manifest_sha256 IS json_extract(evaluation.cell_manifest_json, '$.reproductionManifestSha256')
          AND (SELECT COUNT(*) FROM evaluation_reproduction_cells WHERE evaluation_id = evaluation.id) = evaluation.cell_count
          AND NOT EXISTS (
            SELECT 1 FROM evaluation_cells AS cell WHERE cell.evaluation_id = evaluation.id AND NOT EXISTS (
              SELECT 1 FROM evaluation_reproduction_cells AS record,
                json_each(root.manifest_json, '$.cells') AS cell_ref
              WHERE record.cell_id = cell.id AND record.evaluation_id = evaluation.id AND record.repository_id = evaluation.repository_id
                AND (record.source_definition_sha256 IS NOT NULL) = EXISTS (
                  SELECT 1 FROM evaluation_sources AS original_source
                  JOIN review_runs AS original_run ON original_run.id = json_extract(original_source.source_json, '$.provenance.reviewRunId')
                    AND original_run.repository_id = original_source.repository_id
                  WHERE original_source.id = cell.source_id AND original_source.repository_id = cell.repository_id
                    AND json_extract(original_source.source_json, '$.provenance.kind') IS 'review_run'
                    AND json_type(original_run.plan_json, '$.reproduction') IS 'object'
                )
                AND json_extract(cell_ref.value, '$.cellId') IS cell.id
                AND json_extract(cell_ref.value, '$.caseId') IS cell.case_id
                AND json_extract(cell_ref.value, '$.arm') IS cell.arm
                AND json_extract(cell_ref.value, '$.cellRecordSha256') IS record.record_sha256
                AND CASE WHEN record.source_definition_sha256 IS NULL THEN NOT EXISTS (
                  SELECT 1 FROM json_each(root.manifest_json, '$.sources') AS source_ref
                  WHERE json_extract(source_ref.value, '$.caseId') IS cell.case_id
                ) ELSE EXISTS (
                  SELECT 1 FROM evaluation_reproduction_sources AS definition,
                    json_each(root.manifest_json, '$.sources') AS source_ref
                  WHERE definition.source_id = cell.source_id AND definition.repository_id = cell.repository_id
                    AND definition.definition_sha256 IS record.source_definition_sha256
                    AND json_extract(source_ref.value, '$.caseId') IS cell.case_id
                    AND json_extract(source_ref.value, '$.sourceId') IS cell.source_id
                    AND json_extract(source_ref.value, '$.sourceDefinitionSha256') IS record.source_definition_sha256
                ) END
            )
          )
      )
  ) THEN RAISE(ABORT, 'evaluation reproduction records must be complete before sealing') END;
END;

CREATE TRIGGER tr_evaluation_reproduction_sources_no_replace BEFORE INSERT ON evaluation_reproduction_sources
WHEN EXISTS (SELECT 1 FROM evaluation_reproduction_sources WHERE source_id = NEW.source_id)
BEGIN SELECT RAISE(ABORT, 'evaluation reproduction records are immutable'); END;
CREATE TRIGGER tr_evaluation_reproduction_sources_no_update BEFORE UPDATE ON evaluation_reproduction_sources
BEGIN SELECT RAISE(ABORT, 'evaluation reproduction records are immutable'); END;
CREATE TRIGGER tr_evaluation_reproduction_sources_no_delete BEFORE DELETE ON evaluation_reproduction_sources
BEGIN SELECT RAISE(ABORT, 'evaluation reproduction records cannot be deleted'); END;

CREATE TRIGGER tr_evaluation_reproduction_cells_no_replace BEFORE INSERT ON evaluation_reproduction_cells
WHEN EXISTS (SELECT 1 FROM evaluation_reproduction_cells WHERE cell_id = NEW.cell_id)
BEGIN SELECT RAISE(ABORT, 'evaluation reproduction records are immutable'); END;
CREATE TRIGGER tr_evaluation_reproduction_cells_no_update BEFORE UPDATE ON evaluation_reproduction_cells
BEGIN SELECT RAISE(ABORT, 'evaluation reproduction records are immutable'); END;
CREATE TRIGGER tr_evaluation_reproduction_cells_no_delete BEFORE DELETE ON evaluation_reproduction_cells
BEGIN SELECT RAISE(ABORT, 'evaluation reproduction records cannot be deleted'); END;

CREATE TRIGGER tr_evaluation_reproduction_manifests_no_replace BEFORE INSERT ON evaluation_reproduction_manifests
WHEN EXISTS (SELECT 1 FROM evaluation_reproduction_manifests WHERE evaluation_id = NEW.evaluation_id)
BEGIN SELECT RAISE(ABORT, 'evaluation reproduction records are immutable'); END;
CREATE TRIGGER tr_evaluation_reproduction_manifests_no_update BEFORE UPDATE ON evaluation_reproduction_manifests
BEGIN SELECT RAISE(ABORT, 'evaluation reproduction records are immutable'); END;
CREATE TRIGGER tr_evaluation_reproduction_manifests_no_delete BEFORE DELETE ON evaluation_reproduction_manifests
BEGIN SELECT RAISE(ABORT, 'evaluation reproduction records cannot be deleted'); END;
