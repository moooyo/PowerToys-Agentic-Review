-- Prompt/profile sample-set evaluations. Requires the controlled M28 rebuild transaction.

-- Evaluation execution and assessment identities are independent of GitHub request epochs.
-- Published snapshots and all manifests are immutable. Mutable controls retain CAS history.

CREATE TABLE evaluation_sources (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
  source_json TEXT NOT NULL CHECK (
    length(CAST(source_json AS BLOB)) BETWEEN 1 AND 2097152
    AND json_valid(source_json) AND json_type(source_json) IS 'object'
    AND json_extract(source_json, '$.schemaVersion') IS 'EvaluationSourceSnapshotV1'
    AND json_extract(source_json, '$.repository.id') IS repository_id
    AND json_extract(source_json, '$.workItemId') IS work_item_id
    AND json_extract(source_json, '$.revisionId') IS revision_id
    AND json_extract(source_json, '$.revision.revisionKey') IS revision_key
    AND json_extract(source_json, '$.sourceDigest') IS source_digest
    AND json_extract(source_json, '$.freshness') IS 'frozen'
  ),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  created_at TEXT NOT NULL,
  UNIQUE (id, repository_id),
  FOREIGN KEY (work_item_id, repository_id) REFERENCES work_items(id, repository_id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, work_item_id, revision_key) REFERENCES work_item_revisions(id, work_item_id, revision_key) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ix_evaluation_sources_repository ON evaluation_sources(repository_id, created_at DESC, id);

CREATE TABLE evaluation_suites (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  workflow_kind TEXT NOT NULL CHECK (workflow_kind IN ('pr_static_build', 'pr_ui', 'issue_triage', 'issue_validation')),
  target TEXT NOT NULL CHECK (target IN ('headless', 'windows_desktop', 'web')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128 AND instr(name, char(0)) = 0),
  description TEXT NOT NULL CHECK (length(description) <= 2048 AND instr(description, char(0)) = 0),
  draft_revision INTEGER NOT NULL CHECK (draft_revision BETWEEN 1 AND 9007199254740991),
  draft_json TEXT NOT NULL CHECK (
    length(CAST(draft_json AS BLOB)) BETWEEN 1 AND 2097152
    AND json_valid(draft_json) AND json_type(draft_json) IS 'object'
    AND json_extract(draft_json, '$.name') IS name
    AND json_extract(draft_json, '$.description') IS description
    AND json_type(draft_json, '$.cases') IS 'array'
    AND json_array_length(draft_json, '$.cases') BETWEEN 0 AND 32
  ),
  latest_version_id TEXT REFERENCES evaluation_suite_versions(id) ON DELETE RESTRICT,
  created_by_issuer TEXT NOT NULL CHECK (length(created_by_issuer) BETWEEN 1 AND 2048 AND instr(created_by_issuer, char(0)) = 0),
  created_by_subject TEXT NOT NULL CHECK (length(created_by_subject) BETWEEN 1 AND 512 AND instr(created_by_subject, char(0)) = 0),
  updated_by_issuer TEXT NOT NULL CHECK (length(updated_by_issuer) BETWEEN 1 AND 2048 AND instr(updated_by_issuer, char(0)) = 0),
  updated_by_subject TEXT NOT NULL CHECK (length(updated_by_subject) BETWEEN 1 AND 512 AND instr(updated_by_subject, char(0)) = 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, repository_id),
  CHECK (workflow_kind = 'issue_validation'
    OR (workflow_kind = 'pr_ui' AND target IN ('windows_desktop', 'web'))
    OR (workflow_kind IN ('pr_static_build', 'issue_triage') AND target = 'headless'))
) STRICT;
CREATE INDEX ix_evaluation_suites_repository ON evaluation_suites(repository_id, created_at DESC, id);

CREATE TABLE evaluation_source_versions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  suite_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  manifest_json TEXT NOT NULL CHECK (
    length(CAST(manifest_json AS BLOB)) BETWEEN 1 AND 65536
    AND json_valid(manifest_json) AND json_type(manifest_json) IS 'object'
    AND json_extract(manifest_json, '$.schemaVersion') IS 'EvaluationSourceManifestV1'
    AND json_extract(manifest_json, '$.repositoryId') IS repository_id
    AND json_type(manifest_json, '$.cases') IS 'array'
    AND json_array_length(manifest_json, '$.cases') BETWEEN 1 AND 32
  ),
  created_at TEXT NOT NULL,
  UNIQUE (id, suite_id, repository_id),
  FOREIGN KEY (suite_id, repository_id) REFERENCES evaluation_suites(id, repository_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE evaluation_expectation_versions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  suite_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  manifest_json TEXT NOT NULL CHECK (
    length(CAST(manifest_json AS BLOB)) BETWEEN 1 AND 2097152
    AND json_valid(manifest_json) AND json_type(manifest_json) IS 'object'
    AND json_extract(manifest_json, '$.schemaVersion') IS 'EvaluationExpectationManifestV1'
    AND json_extract(manifest_json, '$.repositoryId') IS repository_id
    AND json_type(manifest_json, '$.cases') IS 'array'
    AND json_array_length(manifest_json, '$.cases') BETWEEN 1 AND 32
  ),
  created_at TEXT NOT NULL,
  UNIQUE (id, suite_id, repository_id),
  FOREIGN KEY (suite_id, repository_id) REFERENCES evaluation_suites(id, repository_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE evaluation_suite_versions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  suite_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  source_draft_revision INTEGER NOT NULL CHECK (source_draft_revision BETWEEN 1 AND 9007199254740991),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  description TEXT NOT NULL CHECK (length(description) <= 2048 AND instr(description, char(0)) = 0),
  workflow_kind TEXT NOT NULL,
  target TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  expectation_version_id TEXT NOT NULL,
  source_manifest_sha256 TEXT NOT NULL,
  expectation_manifest_sha256 TEXT NOT NULL,
  case_count INTEGER NOT NULL CHECK (case_count BETWEEN 1 AND 32),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  created_at TEXT NOT NULL,
  UNIQUE (id, repository_id),
  UNIQUE (suite_id, version),
  UNIQUE (suite_id, source_draft_revision),
  FOREIGN KEY (suite_id, repository_id) REFERENCES evaluation_suites(id, repository_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_version_id, suite_id, repository_id) REFERENCES evaluation_source_versions(id, suite_id, repository_id) ON DELETE RESTRICT,
  FOREIGN KEY (expectation_version_id, suite_id, repository_id) REFERENCES evaluation_expectation_versions(id, suite_id, repository_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ix_evaluation_suite_versions_history ON evaluation_suite_versions(repository_id, suite_id, version DESC);

CREATE TABLE evaluations (
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
    AND json_extract(cell_manifest_json, '$.schemaVersion') IS 'EvaluationCellManifestV1'
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
CREATE INDEX ix_evaluations_repository_history ON evaluations(repository_id, created_at DESC, id);

CREATE TABLE evaluation_authorizations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  evaluation_id TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL,
  authorization_digest TEXT NOT NULL CHECK (length(authorization_digest) = 64 AND authorization_digest NOT GLOB '*[^0-9a-f]*'),
  authorization_json TEXT NOT NULL CHECK (
    length(CAST(authorization_json AS BLOB)) BETWEEN 1 AND 16384
    AND json_valid(authorization_json) AND json_type(authorization_json) IS 'object'
    AND json_extract(authorization_json, '$.schemaVersion') IS 'EvaluationExecutionAuthorizationV1'
    AND json_extract(authorization_json, '$.kind') IS 'operator_evaluation'
    AND json_extract(authorization_json, '$.id') IS id
    AND json_extract(authorization_json, '$.evaluationId') IS evaluation_id
    AND json_extract(authorization_json, '$.repositoryId') IS repository_id
    AND json_extract(authorization_json, '$.actor.issuer') IS actor_issuer
    AND json_extract(authorization_json, '$.actor.subject') IS actor_subject
    AND json_extract(authorization_json, '$.authorizedAt') IS created_at
  ),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  created_at TEXT NOT NULL,
  UNIQUE (id, evaluation_id, repository_id),
  FOREIGN KEY (evaluation_id, repository_id) REFERENCES evaluations(id, repository_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE evaluation_cells (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  evaluation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  case_id TEXT NOT NULL CHECK (length(case_id) BETWEEN 1 AND 128),
  arm TEXT NOT NULL CHECK (arm IN ('baseline', 'candidate')),
  trial INTEGER NOT NULL CHECK (trial = 1),
  source_id TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
  -- Preallocated identity, intentionally without a forward FK. The final seal requires its Run.
  run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) BETWEEN 1 AND 128),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  activation_id TEXT NOT NULL CHECK (length(activation_id) BETWEEN 1 AND 128),
  profile_version_id TEXT NOT NULL REFERENCES validation_profile_versions(id) ON DELETE RESTRICT,
  prompt_version_id TEXT NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  authorization_id TEXT NOT NULL,
  applicable INTEGER NOT NULL CHECK (applicable IN (0, 1)),
  UNIQUE (evaluation_id, case_id, arm, trial),
  UNIQUE (id, evaluation_id, repository_id),
  FOREIGN KEY (evaluation_id, repository_id) REFERENCES evaluations(id, repository_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_id, repository_id) REFERENCES evaluation_sources(id, repository_id) ON DELETE RESTRICT,
  FOREIGN KEY (authorization_id, evaluation_id, repository_id) REFERENCES evaluation_authorizations(id, evaluation_id, repository_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ix_evaluation_cells_matrix ON evaluation_cells(evaluation_id, case_id, arm);

CREATE TABLE evaluation_seals (
  evaluation_id TEXT PRIMARY KEY REFERENCES evaluations(id) ON DELETE RESTRICT,
  sealed_at TEXT NOT NULL
) STRICT;

CREATE TABLE evaluation_controls (
  evaluation_id TEXT PRIMARY KEY REFERENCES evaluation_seals(evaluation_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  reason TEXT CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 2048 AND instr(reason, char(0)) = 0)),
  updated_at TEXT NOT NULL,
  CHECK ((status = 'active' AND version = 1 AND reason IS NULL) OR (status = 'cancelled' AND version = 2 AND reason IS NOT NULL))
) STRICT;

CREATE TABLE evaluation_mutation_receipts (
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  change_id TEXT NOT NULL CHECK (length(change_id) BETWEEN 1 AND 128),
  operation TEXT NOT NULL CHECK (operation IN ('source_captured', 'suite_created', 'draft_saved', 'suite_published', 'evaluation_created', 'evaluation_cancelled', 'finding_adjudicated', 'assessment_published')),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 128),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  previous_version INTEGER NOT NULL CHECK (previous_version BETWEEN 0 AND 9007199254740990),
  version INTEGER NOT NULL CHECK (version = previous_version + 1),
  response_json TEXT NOT NULL CHECK (
    length(CAST(response_json AS BLOB)) BETWEEN 1 AND 262144
    AND json_valid(response_json) AND json_type(response_json) IS 'object'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, change_id)
) STRICT;
CREATE INDEX ix_evaluation_receipts_history ON evaluation_mutation_receipts(repository_id, entity_id, created_at DESC, change_id);

CREATE TABLE evaluation_adjudication_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  evaluation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  result_id TEXT NOT NULL REFERENCES validation_job_results(id) ON DELETE RESTRICT,
  result_digest TEXT NOT NULL CHECK (length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
  occurrence_key TEXT NOT NULL CHECK (length(occurrence_key) = 64 AND occurrence_key NOT GLOB '*[^0-9a-f]*'),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  previous_event_id TEXT REFERENCES evaluation_adjudication_events(id) ON DELETE RESTRICT,
  adjudication_json TEXT NOT NULL CHECK (
    length(CAST(adjudication_json AS BLOB)) BETWEEN 1 AND 16384
    AND json_valid(adjudication_json) AND json_type(adjudication_json) IS 'object'
    AND json_extract(adjudication_json, '$.adjudicationId') IS id
    AND json_extract(adjudication_json, '$.resultId') IS result_id
    AND json_extract(adjudication_json, '$.resultDigest') IS result_digest
    AND json_extract(adjudication_json, '$.occurrenceKey') IS occurrence_key
    AND json_extract(adjudication_json, '$.actor.issuer') IS actor_issuer
    AND json_extract(adjudication_json, '$.actor.subject') IS actor_subject
    AND json_extract(adjudication_json, '$.createdAt') IS created_at
  ),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  change_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (cell_id, result_id, result_digest, occurrence_key, version),
  FOREIGN KEY (cell_id, evaluation_id, repository_id) REFERENCES evaluation_cells(id, evaluation_id, repository_id) ON DELETE RESTRICT,
  FOREIGN KEY (repository_id, change_id) REFERENCES evaluation_mutation_receipts(repository_id, change_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX ix_evaluation_adjudications_current ON evaluation_adjudication_events(cell_id, result_id, occurrence_key, version DESC);

CREATE TABLE evaluation_assessments (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  evaluation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  scorer_version TEXT NOT NULL CHECK (length(scorer_version) BETWEEN 1 AND 128),
  scoring_plan_digest TEXT NOT NULL CHECK (length(scoring_plan_digest) = 64 AND scoring_plan_digest NOT GLOB '*[^0-9a-f]*'),
  observation_digest TEXT NOT NULL CHECK (length(observation_digest) = 64 AND observation_digest NOT GLOB '*[^0-9a-f]*'),
  adjudication_digest TEXT NOT NULL CHECK (length(adjudication_digest) = 64 AND adjudication_digest NOT GLOB '*[^0-9a-f]*'),
  observation_json TEXT NOT NULL CHECK (length(CAST(observation_json AS BLOB)) BETWEEN 2 AND 16777216 AND json_valid(observation_json) AND json_type(observation_json) IS 'array'),
  adjudication_json TEXT NOT NULL CHECK (length(CAST(adjudication_json AS BLOB)) BETWEEN 2 AND 16777216 AND json_valid(adjudication_json) AND json_type(adjudication_json) IS 'array'),
  report_digest TEXT NOT NULL CHECK (length(report_digest) = 64 AND report_digest NOT GLOB '*[^0-9a-f]*'),
  report_json TEXT NOT NULL CHECK (length(CAST(report_json AS BLOB)) BETWEEN 1 AND 16777216 AND json_valid(report_json) AND json_type(report_json) IS 'object'),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  change_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (evaluation_id, version),
  FOREIGN KEY (evaluation_id, repository_id) REFERENCES evaluations(id, repository_id) ON DELETE RESTRICT,
  FOREIGN KEY (repository_id, change_id) REFERENCES evaluation_mutation_receipts(repository_id, change_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TRIGGER tr_evaluation_source_insert BEFORE INSERT ON evaluation_sources BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM evaluation_sources WHERE id = NEW.id)
    THEN RAISE(ABORT, 'evaluation sources are immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_repositories AS repository
    JOIN work_items AS item ON item.id = NEW.work_item_id AND item.repository_id = repository.id
    JOIN work_item_revisions AS revision ON revision.id = NEW.revision_id AND revision.work_item_id = item.id
    WHERE repository.id = NEW.repository_id
      AND repository.github_repository_id IS json_extract(NEW.source_json, '$.repository.githubRepositoryId')
      AND item.github_work_item_id IS json_extract(NEW.source_json, '$.workItem.githubWorkItemId')
      AND item.resource_kind IS json_extract(NEW.source_json, '$.workItem.kind')
      AND revision.resource_kind IS json_extract(NEW.source_json, '$.revision.kind')
      AND revision.revision_key IS NEW.revision_key
      AND json_extract(NEW.source_json, '$.revision.githubWorkItemId') IS item.github_work_item_id
      AND json_extract(NEW.source_json, '$.workItem.githubRepositoryId') IS repository.github_repository_id
      AND json_extract(NEW.source_json, '$.revision.githubRepositoryId') IS repository.github_repository_id
      AND CASE item.resource_kind WHEN 'pull_request' THEN (
        revision.base_sha IS json_extract(NEW.source_json, '$.revision.baseSha')
        AND revision.head_sha IS json_extract(NEW.source_json, '$.revision.headSha')
        AND json_extract(NEW.source_json, '$.testedSourceRevision.kind') IS 'pull_request'
        AND revision.base_sha IS json_extract(NEW.source_json, '$.testedSourceRevision.baseSha')
        AND revision.head_sha IS json_extract(NEW.source_json, '$.testedSourceRevision.headSha')
      ) ELSE revision.content_digest IS json_extract(NEW.source_json, '$.revision.contentDigest') END
  ) THEN RAISE(ABORT, 'evaluation source scope does not match stored identities') END;
END;

CREATE TRIGGER tr_evaluation_suite_insert BEFORE INSERT ON evaluation_suites BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM evaluation_suites WHERE id = NEW.id)
    OR NEW.draft_revision != 1 OR NEW.latest_version_id IS NOT NULL
    OR NEW.created_by_issuer IS NOT NEW.updated_by_issuer OR NEW.created_by_subject IS NOT NEW.updated_by_subject
    OR NEW.created_at IS NOT NEW.updated_at
    THEN RAISE(ABORT, 'evaluation suite initial identity is invalid') END;
END;
CREATE TRIGGER tr_evaluation_suite_update BEFORE UPDATE ON evaluation_suites BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.repository_id IS NOT OLD.repository_id
    OR NEW.workflow_kind IS NOT OLD.workflow_kind OR NEW.target IS NOT OLD.target
    OR NEW.created_by_issuer IS NOT OLD.created_by_issuer OR NEW.created_by_subject IS NOT OLD.created_by_subject
    OR NEW.created_at IS NOT OLD.created_at OR NEW.draft_revision != OLD.draft_revision + 1
    THEN RAISE(ABORT, 'evaluation suite identity or revision is invalid') END;
  SELECT CASE WHEN NEW.latest_version_id IS NOT OLD.latest_version_id AND (
    NEW.draft_json IS NOT OLD.draft_json OR NEW.latest_version_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM evaluation_suite_versions AS version WHERE version.id = NEW.latest_version_id
        AND version.suite_id = OLD.id AND version.repository_id = OLD.repository_id
        AND version.source_draft_revision = OLD.draft_revision
    )
  ) THEN RAISE(ABORT, 'evaluation suite publication does not match its draft') END;
END;

CREATE TRIGGER tr_evaluation_source_version_insert BEFORE INSERT ON evaluation_source_versions BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evaluation_suites AS suite WHERE suite.id = NEW.suite_id AND suite.repository_id = NEW.repository_id
      AND suite.workflow_kind IS json_extract(NEW.manifest_json, '$.workflowKind')
      AND suite.target IS json_extract(NEW.manifest_json, '$.target')
  ) OR json_array_length(NEW.manifest_json, '$.cases') != (
    SELECT COUNT(DISTINCT json_extract(value, '$.caseId')) FROM json_each(NEW.manifest_json, '$.cases')
  ) OR EXISTS (
    SELECT 1 FROM json_each(NEW.manifest_json, '$.cases') AS entry WHERE NOT EXISTS (
      SELECT 1 FROM evaluation_sources AS source WHERE source.id = json_extract(entry.value, '$.sourceId')
        AND source.repository_id = NEW.repository_id AND source.source_digest IS json_extract(entry.value, '$.sourceDigest')
        AND CASE json_extract(NEW.manifest_json, '$.workflowKind')
          WHEN 'pr_static_build' THEN json_extract(source.source_json, '$.workItem.kind') IS 'pull_request'
          WHEN 'pr_ui' THEN json_extract(source.source_json, '$.workItem.kind') IS 'pull_request'
          WHEN 'issue_triage' THEN json_extract(source.source_json, '$.workItem.kind') IS 'issue'
            AND json_type(source.source_json, '$.testedSourceRevision') IS 'null'
          WHEN 'issue_validation' THEN json_extract(source.source_json, '$.workItem.kind') IS 'issue'
            AND json_extract(source.source_json, '$.testedSourceRevision.kind') IS 'commit'
          ELSE 0 END
    )
  ) THEN RAISE(ABORT, 'evaluation source manifest is inconsistent') END;
  SELECT CASE WHEN (
    SELECT SUM(length(CAST(source.source_json AS BLOB)))
    FROM json_each(NEW.manifest_json, '$.cases') AS entry
    JOIN evaluation_sources AS source ON source.id = json_extract(entry.value, '$.sourceId')
  ) > 16777216 THEN RAISE(ABORT, 'evaluation source manifest exceeds the aggregate source budget') END;
END;

CREATE TRIGGER tr_evaluation_expectation_version_insert BEFORE INSERT ON evaluation_expectation_versions BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evaluation_suites AS suite WHERE suite.id = NEW.suite_id AND suite.repository_id = NEW.repository_id
      AND suite.workflow_kind IS json_extract(NEW.manifest_json, '$.workflowKind')
      AND suite.target IS json_extract(NEW.manifest_json, '$.target')
  ) OR json_array_length(NEW.manifest_json, '$.cases') != (
    SELECT COUNT(DISTINCT json_extract(value, '$.caseId')) FROM json_each(NEW.manifest_json, '$.cases')
  ) THEN RAISE(ABORT, 'evaluation expectation manifest is inconsistent') END;
END;

CREATE TRIGGER tr_evaluation_suite_version_insert BEFORE INSERT ON evaluation_suite_versions BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evaluation_suites AS suite
    JOIN evaluation_source_versions AS source ON source.id = NEW.source_version_id AND source.suite_id = suite.id
    JOIN evaluation_expectation_versions AS expected ON expected.id = NEW.expectation_version_id AND expected.suite_id = suite.id
    WHERE suite.id = NEW.suite_id AND suite.repository_id = NEW.repository_id
      AND suite.draft_revision = NEW.source_draft_revision AND suite.name IS NEW.name AND suite.description IS NEW.description
      AND suite.workflow_kind IS NEW.workflow_kind AND suite.target IS NEW.target
      AND source.manifest_sha256 IS NEW.source_manifest_sha256 AND expected.manifest_sha256 IS NEW.expectation_manifest_sha256
      AND json_array_length(source.manifest_json, '$.cases') = NEW.case_count
      AND json_array_length(expected.manifest_json, '$.cases') = NEW.case_count
      AND json_array_length(suite.draft_json, '$.cases') = NEW.case_count
      AND EXISTS (SELECT 1 FROM json_each(expected.manifest_json, '$.cases')
        WHERE json_extract(value, '$.applicability.state') IS 'applicable')
      AND NEW.version = COALESCE((SELECT MAX(version) FROM evaluation_suite_versions WHERE suite_id = suite.id), 0) + 1
      AND NOT EXISTS (
        SELECT 1 FROM json_each(source.manifest_json, '$.cases') AS entry WHERE NOT EXISTS (
          SELECT 1 FROM json_each(expected.manifest_json, '$.cases') AS expectation
          JOIN json_each(suite.draft_json, '$.cases') AS draft
            ON json_extract(draft.value, '$.caseId') IS json_extract(expectation.value, '$.caseId')
          WHERE json_extract(expectation.value, '$.caseId') IS json_extract(entry.value, '$.caseId')
            AND json_extract(draft.value, '$.sourceId') IS json_extract(entry.value, '$.sourceId')
            AND json_remove(draft.value, '$.sourceId') IS expectation.value
        )
      )
  ) THEN RAISE(ABORT, 'evaluation suite version does not match its complete published draft') END;
END;

CREATE TRIGGER tr_evaluation_authorization_insert BEFORE INSERT ON evaluation_authorizations BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evaluations AS evaluation JOIN managed_repositories AS repository ON repository.id = evaluation.repository_id
    WHERE evaluation.id = NEW.evaluation_id AND evaluation.repository_id = NEW.repository_id
      AND evaluation.actor_issuer IS NEW.actor_issuer AND evaluation.actor_subject IS NEW.actor_subject
      AND evaluation.created_at IS NEW.created_at
      AND json_extract(NEW.authorization_json, '$.githubRepositoryId') IS repository.github_repository_id
      AND json_extract(NEW.authorization_json, '$.sampleSetVersionId') IS evaluation.suite_version_id
      AND json_extract(NEW.authorization_json, '$.sourceManifestSha256') IS evaluation.source_manifest_sha256
      AND json_extract(NEW.authorization_json, '$.configurationManifestSha256') IS evaluation.configuration_manifest_sha256
      AND json_extract(NEW.authorization_json, '$.cellManifestSha256') IS evaluation.cell_manifest_sha256
      AND json_extract(NEW.authorization_json, '$.executionManifestSha256') IS evaluation.execution_manifest_sha256
  ) THEN RAISE(ABORT, 'evaluation authorization does not match its frozen execution manifest') END;
END;

CREATE TRIGGER tr_evaluation_control_insert BEFORE INSERT ON evaluation_controls BEGIN
  SELECT CASE WHEN NEW.status != 'active' OR NEW.version != 1 OR EXISTS (
    SELECT 1 FROM evaluation_controls WHERE evaluation_id = NEW.evaluation_id
  ) THEN RAISE(ABORT, 'evaluation control must start active') END;
END;
CREATE TRIGGER tr_evaluation_control_update BEFORE UPDATE ON evaluation_controls BEGIN
  SELECT CASE WHEN NEW.evaluation_id IS NOT OLD.evaluation_id OR OLD.status != 'active'
    OR NEW.status != 'cancelled' OR NEW.version != OLD.version + 1
    THEN RAISE(ABORT, 'evaluation cancellation is final') END;
END;


-- M28 review-run integration fragment. New evaluation business tables must already exist.
-- Execute only inside the controlled foreign-key-disabled parent rebuild transaction.
-- Generated from the exported live M27 schema; existing immutable row bytes are copied verbatim.

DROP TRIGGER tr_review_run_request_consistency;

DROP TRIGGER tr_review_run_job_links_consistency;

DROP TRIGGER tr_validation_job_result_insert_consistency;

DROP TRIGGER tr_job_success_review_result_consistency;

DROP TRIGGER tr_evidence_asset_insert;

DROP TRIGGER tr_validation_control_audit_consistency;

DROP TRIGGER tr_validation_dispatch_check_scope;

DROP TRIGGER tr_validation_dispatch_request_pending;

DROP TRIGGER tr_github_review_run_activation_insert;

DROP TRIGGER tr_review_run_decision_insert;

DROP TRIGGER tr_finding_disposition_event_insert;

DROP TRIGGER tr_publication_intent_insert;

DROP TRIGGER tr_notification_event_insert;

DROP TRIGGER tr_notification_validation_terminal;

DROP TRIGGER tr_review_runs_immutable_update;

DROP TRIGGER tr_review_runs_immutable_delete;

CREATE TABLE new_review_runs (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  request_epoch_id TEXT,
  activation_id TEXT NOT NULL CHECK (length(activation_id) BETWEEN 1 AND 128),
  creation_intent_digest TEXT CHECK (creation_intent_digest IS NULL OR (
    length(creation_intent_digest) = 64 AND creation_intent_digest NOT GLOB '*[^0-9a-f]*'
  )),
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'),
  plan_json TEXT NOT NULL CHECK (
    length(CAST(plan_json AS BLOB)) BETWEEN 1 AND 16777216
    AND json_valid(plan_json) AND json_type(plan_json) = 'object'
    AND ((purpose = 'review'
      AND json_extract(plan_json, '$.schemaVersion') IS 'ReviewRunExecutionPlanV1'
      AND json_extract(plan_json, '$.authorization.requestEpochId') IS request_epoch_id)
    OR (purpose = 'evaluation'
      AND json_extract(plan_json, '$.schemaVersion') IS 'ReviewRunExecutionPlanV2'
      AND json_type(plan_json, '$.requestEpochId') IS 'null'
      AND json_type(plan_json, '$.testedSourceAuthorization') IS 'null'
      AND json_type(plan_json, '$.purpose') IS 'object'
      AND json_extract(plan_json, '$.purpose.schemaVersion') IS 'EvaluationExecutionPurposeV1'
      AND json_extract(plan_json, '$.purpose.kind') IS 'evaluation'
      AND json_extract(plan_json, '$.purpose.cellId') IS evaluation_cell_id
      AND json_extract(plan_json, '$.purpose.trial') IS 1
      AND json_extract(plan_json, '$.purpose.upstreamMutationPolicy') IS 'forbidden'
      AND json_type(plan_json, '$.source') IS 'object'
      AND json_type(plan_json, '$.authorization') IS 'object'
      AND json_extract(plan_json, '$.authorization.schemaVersion') IS 'EvaluationExecutionAuthorizationV1'
      AND json_extract(plan_json, '$.authorization.kind') IS 'operator_evaluation'
      AND json_type(plan_json, '$.modelRequirements') IS 'object'
      AND json_array_length(plan_json, '$.jobs') = 1))
    AND json_extract(plan_json, '$.repository.id') IS repository_id
    AND json_extract(plan_json, '$.workItemId') IS work_item_id
    AND json_extract(plan_json, '$.revision.revisionKey') IS revision_key
    AND json_extract(plan_json, '$.activationId') IS activation_id
    AND json_type(plan_json, '$.jobs') IS 'array'
    AND json_array_length(plan_json, '$.jobs') BETWEEN 1 AND 32
  ),
  readiness_json TEXT NOT NULL CHECK (
    length(CAST(readiness_json AS BLOB)) BETWEEN 1 AND 1048576
    AND json_valid(readiness_json) AND json_type(readiness_json) = 'array'
    AND json_array_length(readiness_json) = json_array_length(plan_json, '$.jobs')
  ),
  required_request_blockers_json TEXT NOT NULL CHECK (
    length(CAST(required_request_blockers_json AS BLOB)) BETWEEN 2 AND 1048576
    AND json_valid(required_request_blockers_json) AND json_type(required_request_blockers_json) = 'array'
    AND json_array_length(required_request_blockers_json) <= 4480
  ),
  request_count INTEGER NOT NULL CHECK (request_count = json_array_length(plan_json, '$.jobs')),
  blocked_request_count INTEGER NOT NULL CHECK (blocked_request_count BETWEEN 0 AND request_count),
  required_blocker_count INTEGER NOT NULL CHECK (required_blocker_count = json_array_length(required_request_blockers_json)),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  created_at TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'review' CHECK (purpose IN ('review', 'evaluation')),
  evaluation_cell_id TEXT REFERENCES evaluation_cells(id) ON DELETE RESTRICT,
  UNIQUE (work_item_id, activation_id),
  FOREIGN KEY (work_item_id, repository_id) REFERENCES work_items(id, repository_id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, work_item_id, revision_key) REFERENCES work_item_revisions(id, work_item_id, revision_key) ON DELETE RESTRICT,
  FOREIGN KEY (request_epoch_id, work_item_id) REFERENCES request_epochs(id, work_item_id) ON DELETE RESTRICT,
  UNIQUE (evaluation_cell_id),
  CHECK ((purpose = 'review' AND request_epoch_id IS NOT NULL AND evaluation_cell_id IS NULL)
    OR (purpose = 'evaluation' AND request_epoch_id IS NULL AND evaluation_cell_id IS NOT NULL))
) STRICT;

INSERT INTO new_review_runs (rowid, id, repository_id, work_item_id, revision_id, revision_key, request_epoch_id, activation_id, creation_intent_digest, plan_digest, plan_json, readiness_json, required_request_blockers_json, request_count, blocked_request_count, required_blocker_count, actor_issuer, actor_subject, created_at, purpose, evaluation_cell_id)
SELECT rowid, id, repository_id, work_item_id, revision_id, revision_key, request_epoch_id, activation_id, creation_intent_digest, plan_digest, plan_json, readiness_json, required_request_blockers_json, request_count, blocked_request_count, required_blocker_count, actor_issuer, actor_subject, created_at, 'review', NULL FROM review_runs;

DROP TABLE review_runs;

ALTER TABLE new_review_runs RENAME TO review_runs;

CREATE INDEX ix_review_runs_repository_history ON review_runs (repository_id, created_at DESC, id DESC);

CREATE INDEX ix_review_runs_work_item_history ON review_runs (repository_id, work_item_id, created_at DESC, id DESC);

CREATE TRIGGER tr_review_runs_immutable_update BEFORE UPDATE ON review_runs BEGIN SELECT RAISE(ABORT, 'review runs are immutable'); END;

CREATE TRIGGER tr_review_runs_immutable_delete BEFORE DELETE ON review_runs BEGIN SELECT RAISE(ABORT, 'review runs are immutable'); END;

-- INSERT OR REPLACE must not bypass immutable purpose or the existing Run identity.
CREATE TRIGGER tr_review_run_identity_no_replace BEFORE INSERT ON review_runs
WHEN EXISTS (SELECT 1 FROM review_runs WHERE id = NEW.id
  OR (work_item_id = NEW.work_item_id AND activation_id = NEW.activation_id)
  OR (NEW.evaluation_cell_id IS NOT NULL AND evaluation_cell_id = NEW.evaluation_cell_id))
BEGIN SELECT RAISE(ABORT, 'review run identity cannot be replaced'); END;

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
      AND CASE WHEN json_extract(run.plan_json, '$.modelRequirements.required') IS 1 THEN (
        json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.' || CASE
          WHEN request.workflow_kind IN ('pr_static_build', 'issue_triage') THEN 'validationEvaluationReviewModel'
          ELSE 'validationEvaluationSummaryModel' END) IS '1'
        AND json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.' || CASE
          WHEN request.workflow_kind IN ('pr_static_build', 'issue_triage') THEN 'validationEvaluationSummaryModel'
          ELSE 'validationEvaluationReviewModel' END) IS NULL
      ) ELSE (
        json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.validationEvaluationReviewModel') IS NULL
        AND json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.validationEvaluationSummaryModel') IS NULL
      ) END
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
        + (json_extract(run.plan_json, '$.modelRequirements.required') IS 1)
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
      AND NOT EXISTS (SELECT 1 FROM json_each(job.execution_json, '$.validation')
        WHERE key NOT IN ('schemaVersion', 'runId', 'planDigest', 'activationId', 'requestId',
          'jobActivation', 'repositoryId', 'workItemId', 'revisionKey', 'requestEpochId',
          'workflowKind', 'target', 'required', 'profileVersion', 'promptVersion', 'requiredCheckIds',
          'testedSourceRevision', 'testedSourceAuthorization', 'reproduction', 'purpose', 'source',
          'authorization', 'modelRequirements'))
      AND (SELECT COUNT(*) FROM json_each(job.execution_json, '$.validation')) =
        22 + (json_type(job.execution_json, '$.validation.reproduction') IS 'object')
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
      AND NOT EXISTS (SELECT 1 FROM json_each(job.execution_json, '$.validation')
        WHERE key NOT IN ('schemaVersion', 'runId', 'planDigest', 'activationId', 'requestId',
          'jobActivation', 'repositoryId', 'workItemId', 'revisionKey', 'requestEpochId',
          'workflowKind', 'target', 'required', 'profileVersion', 'promptVersion', 'requiredCheckIds',
          'testedSourceRevision', 'testedSourceAuthorization', 'reproduction', 'purpose', 'source',
          'authorization', 'modelRequirements'))
      AND (SELECT COUNT(*) FROM json_each(job.execution_json, '$.validation')) =
        22 + (json_type(job.execution_json, '$.validation.reproduction') IS 'object')
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
          AND ((run.purpose = 'review' AND run.request_epoch_id = NEW.request_epoch_id)
            OR (run.purpose = 'evaluation' AND run.request_epoch_id IS NULL AND NEW.request_epoch_id IS NULL
              AND NEW.source_event_id IS NULL AND NEW.cancellation_requested_at IS NULL
              AND json_extract(NEW.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
              AND json_type(NEW.execution_json, '$.validation.requestEpochId') IS 'null'
              AND json_type(NEW.execution_json, '$.validation.testedSourceAuthorization') IS 'null'
              AND json_extract(NEW.execution_json, '$.validation.purpose') IS json_extract(run.plan_json, '$.purpose')
              AND json_extract(NEW.execution_json, '$.validation.source') IS json_extract(run.plan_json, '$.source')
              AND json_extract(NEW.execution_json, '$.validation.authorization') IS json_extract(run.plan_json, '$.authorization')
              AND json_extract(NEW.execution_json, '$.validation.modelRequirements') IS json_extract(run.plan_json, '$.modelRequirements')
              AND result.job_activation = 1 AND link.activation_number = 1
              AND NOT EXISTS (SELECT 1 FROM job_request_epochs WHERE job_id = NEW.id)
              AND EXISTS (SELECT 1 FROM evaluation_cells AS cell
                JOIN evaluations AS evaluation ON evaluation.id = cell.evaluation_id AND evaluation.repository_id = cell.repository_id
                JOIN evaluation_seals AS seal ON seal.evaluation_id = evaluation.id
                JOIN evaluation_controls AS control ON control.evaluation_id = evaluation.id AND control.status = 'active'
                WHERE cell.id = run.evaluation_cell_id AND cell.run_id = run.id AND cell.repository_id = run.repository_id
                  AND cell.request_id = request.request_id AND cell.activation_id = run.activation_id
                  AND cell.profile_version_id = request.profile_version_id AND cell.prompt_version_id = request.prompt_version_id
                  AND cell.applicable = 1 AND cell.trial = 1)))
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

-- M28 source fragment derived from the complete M27 trigger definitions.
-- The migration owner recreates these triggers after rebuilding review_runs.
-- Keep the original M2 job/request-epoch consistency trigger unchanged.

CREATE TRIGGER tr_review_run_request_consistency BEFORE INSERT ON review_run_requests
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM review_runs AS run, json_each(run.plan_json, '$.jobs') AS planned
    WHERE run.id = NEW.review_run_id
      AND json_extract(planned.value, '$.requestId') IS NEW.request_id
      AND json_extract(planned.value, '$.workflowKind') IS NEW.workflow_kind
      AND json_extract(planned.value, '$.target') IS NEW.target
      AND json_extract(planned.value, '$.required') IS NEW.required
      AND json_extract(planned.value, '$.profileVersion.id') IS NEW.profile_version_id
      AND json_extract(planned.value, '$.prompt.version.id') IS NEW.prompt_version_id
      AND (NEW.prompt_envelope_json IS NULL OR (
        json_extract(NEW.prompt_envelope_json, '$.name') IS json_extract(planned.value, '$.prompt.version.templateId')
        AND json_extract(NEW.prompt_envelope_json, '$.version') IS CAST(json_extract(planned.value, '$.prompt.version.version') AS TEXT)
      ))
      AND json(planned.value) = json(NEW.request_json)
  ) THEN RAISE(ABORT, 'review run request does not match its frozen plan') END;
END;

CREATE TRIGGER tr_evidence_asset_insert BEFORE INSERT ON evidence_assets
WHEN EXISTS (SELECT 1 FROM evidence_assets WHERE id = NEW.id OR (run_attempt_id = NEW.run_attempt_id AND client_asset_id = NEW.client_asset_id))
  OR NEW.state <> 'uploading' OR NEW.committed_bytes <> 0
  OR NOT EXISTS (
    SELECT 1 FROM run_attempts AS attempt
    JOIN jobs AS job ON job.id = attempt.job_id
    JOIN workers AS worker ON worker.id = attempt.worker_id
    JOIN review_run_job_links AS link ON link.job_id = job.id
    JOIN review_runs AS run ON run.id = link.review_run_id
    JOIN review_run_requests AS request ON request.review_run_id = run.id AND request.request_id = link.request_id
    WHERE attempt.id = NEW.run_attempt_id AND job.id = NEW.job_id
      AND job.current_run_attempt_id = attempt.id AND job.lease_generation = attempt.lease_generation
      AND job.status IN ('leased', 'running') AND attempt.status IN ('leased', 'running')
      AND job.cancellation_requested_at IS NULL AND worker.superseded_at IS NULL
      AND attempt.worker_node_id = worker.node_id AND attempt.worker_instance_id = worker.instance_id
      AND run.id = NEW.review_run_id AND run.repository_id = NEW.repository_id
      AND run.revision_key = NEW.revision_key AND run.plan_digest = NEW.plan_digest
      AND request.request_id = NEW.request_id AND request.profile_version_id = NEW.profile_version_id
      AND json_extract(job.execution_json, '$.validation.runId') IS run.id
      AND json_extract(job.execution_json, '$.validation.repositoryId') IS run.repository_id
      AND json_extract(job.execution_json, '$.validation.requestId') IS request.request_id
      AND json_extract(job.execution_json, '$.validation.jobActivation') IS link.activation_number
      AND json_extract(job.execution_json, '$.validation.profileVersion.id') IS request.profile_version_id
      AND json_extract(job.execution_json, '$.validation.revisionKey') IS run.revision_key
      AND json_extract(job.execution_json, '$.validation.planDigest') IS run.plan_digest
  )
BEGIN SELECT RAISE(ABORT, 'evidence asset dependency mismatch'); END;

CREATE TRIGGER tr_validation_control_audit_consistency BEFORE INSERT ON validation_control_audit
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM review_runs WHERE id = NEW.review_run_id AND repository_id = NEW.repository_id
  ) THEN RAISE(ABORT, 'validation operation repository/run mismatch') END;
  SELECT CASE WHEN NEW.action = 'rerun' AND EXISTS (
    SELECT 1 FROM review_runs WHERE id = NEW.review_run_id AND purpose = 'evaluation'
  ) THEN RAISE(ABORT, 'evaluation reruns require a new evaluation') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM validation_control_audit WHERE id = NEW.id)
    OR (NEW.action = 'rerun' AND EXISTS (
      SELECT 1 FROM validation_control_audit WHERE action = 'rerun'
        AND review_run_id = NEW.review_run_id AND request_id = NEW.request_id
        AND activation_id = NEW.activation_id
    )) THEN RAISE(ABORT, 'validation operation receipts cannot be replaced') END;
  SELECT CASE WHEN NEW.action IN ('rerun', 'cancel') AND NOT EXISTS (
    SELECT 1 FROM review_run_job_links
    WHERE review_run_id = NEW.review_run_id AND request_id = NEW.request_id
      AND job_id = json_extract(NEW.result_json, '$.jobId')
      AND (NEW.action != 'rerun' OR activation_number = json_extract(NEW.result_json, '$.jobActivation'))
  ) THEN RAISE(ABORT, 'validation operation result/job mismatch') END;
END;

CREATE TRIGGER tr_validation_dispatch_check_scope BEFORE INSERT ON validation_dispatch_checks
WHEN NOT EXISTS (SELECT 1 FROM review_runs WHERE id = NEW.review_run_id AND repository_id = NEW.repository_id)
BEGIN SELECT RAISE(ABORT, 'dispatch check repository/run mismatch'); END;

CREATE TRIGGER tr_validation_dispatch_request_pending AFTER INSERT ON review_run_requests
BEGIN
  INSERT INTO validation_dispatch_checks (repository_id, review_run_id, request_id, pending, last_sequence, checked_at, blockers_json)
  SELECT repository_id, NEW.review_run_id, NEW.request_id, 1, 0, NULL, '[]'
  FROM review_runs WHERE id = NEW.review_run_id;
END;

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
    SELECT 1 FROM review_runs WHERE purpose = 'review' AND id = NEW.review_run_id AND work_item_id = NEW.work_item_id
      AND request_epoch_id = NEW.request_epoch_id AND revision_key = NEW.revision_key
      AND actor_issuer = 'urn:agentic-review:server' AND actor_subject = 'github-ingestion'
  ) THEN RAISE(ABORT, 'GitHub review run activation identity mismatch') END;
END;

CREATE TRIGGER tr_review_run_decision_insert BEFORE INSERT ON review_run_decision_events
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM review_run_decision_events WHERE id = NEW.id
      OR (review_run_id = NEW.review_run_id AND change_id = NEW.change_id)
      OR (review_run_id = NEW.review_run_id AND version = NEW.version)
  ) THEN RAISE(ABORT, 'review run decision receipts cannot be replaced') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM review_runs AS run JOIN work_items AS item ON item.id = run.work_item_id
    WHERE run.id = NEW.review_run_id AND run.repository_id = NEW.repository_id
      AND run.purpose = 'review'
      AND run.work_item_id = NEW.work_item_id AND item.resource_kind = NEW.work_item_kind
      AND run.revision_key = NEW.revision_key AND run.plan_digest = NEW.plan_digest
  ) THEN RAISE(ABORT, 'review run decision scope does not match its run') END;
  SELECT CASE WHEN NEW.previous_version != COALESCE((
    SELECT MAX(version) FROM review_run_decision_events WHERE review_run_id = NEW.review_run_id
  ), 0) OR EXISTS (
    SELECT 1 FROM review_run_decision_events WHERE review_run_id = NEW.review_run_id
      AND version = NEW.previous_version AND created_at > NEW.created_at
  ) THEN RAISE(ABORT, 'review run decision version does not follow its stream') END;
  SELECT CASE WHEN NEW.action != 'comment' AND NEW.supersedes_decision_id IS NOT (
    SELECT CASE WHEN action = 'withdraw' THEN NULL ELSE id END
    FROM review_run_decision_events WHERE review_run_id = NEW.review_run_id
      AND action != 'comment' ORDER BY version DESC LIMIT 1
  ) THEN RAISE(ABORT, 'review run decision does not supersede the active decision') END;
  SELECT CASE WHEN NEW.action = 'withdraw' AND NOT EXISTS (
    SELECT 1 FROM review_run_decision_events WHERE id = NEW.target_decision_id
      AND repository_id = NEW.repository_id AND review_run_id = NEW.review_run_id
      AND action NOT IN ('comment', 'withdraw')
  ) THEN RAISE(ABORT, 'review run withdrawal requires an active decision') END;
END;

CREATE TRIGGER tr_finding_disposition_event_insert BEFORE INSERT ON finding_disposition_events
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM finding_disposition_events WHERE id = NEW.id
      OR (repository_id = NEW.repository_id AND change_id = NEW.change_id)
      OR (result_id = NEW.result_id AND kind = NEW.kind AND ordinal = NEW.ordinal AND version = NEW.version)
  ) THEN RAISE(ABORT, 'finding disposition receipts cannot be replaced') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM validation_job_results AS result
    JOIN review_runs AS run ON run.id = result.review_run_id
    JOIN work_items AS item ON item.id = result.work_item_id
    JOIN review_run_requests AS request ON request.review_run_id = result.review_run_id
      AND request.request_id = result.request_id
    WHERE result.id = NEW.result_id AND result.result_digest = NEW.result_digest
      AND result.repository_id = NEW.repository_id AND result.review_run_id = NEW.review_run_id
      AND result.request_id = NEW.request_id AND result.job_id = NEW.job_id
      AND result.work_item_id = NEW.work_item_id AND item.resource_kind = NEW.work_item_kind
      AND result.resource_revision = NEW.revision_key AND result.plan_digest = NEW.plan_digest
      AND run.purpose = 'review'
      AND run.repository_id = NEW.repository_id AND run.work_item_id = NEW.work_item_id
      AND run.revision_key = NEW.revision_key AND run.plan_digest = NEW.plan_digest
      AND item.repository_id = NEW.repository_id
  ) THEN RAISE(ABORT, 'finding disposition scope does not match its result') END;
  SELECT CASE WHEN (NEW.previous_version = 0 AND EXISTS (
    SELECT 1 FROM finding_dispositions WHERE result_id = NEW.result_id
      AND kind = NEW.kind AND ordinal = NEW.ordinal
  )) OR (NEW.previous_version > 0 AND NOT EXISTS (
    SELECT 1 FROM finding_dispositions AS current
    JOIN finding_disposition_events AS event ON event.id = current.last_event_id
    WHERE current.result_id = NEW.result_id AND current.kind = NEW.kind AND current.ordinal = NEW.ordinal
      AND current.repository_id = NEW.repository_id AND current.review_run_id = NEW.review_run_id
      AND current.request_id = NEW.request_id AND current.job_id = NEW.job_id
      AND current.result_digest = NEW.result_digest AND current.occurrence_key = NEW.occurrence_key
      AND current.version = NEW.previous_version AND current.state = NEW.previous_state
      AND current.updated_at <= NEW.created_at
      AND event.result_id = current.result_id AND event.kind = current.kind AND event.ordinal = current.ordinal
      AND event.version = current.version AND event.state = current.state
  )) THEN RAISE(ABORT, 'finding disposition does not follow the current occurrence') END;
END;

CREATE TRIGGER tr_publication_intent_insert BEFORE INSERT ON publication_intents
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM publication_intents WHERE publication_id=NEW.publication_id
    OR (repository_id=NEW.repository_id AND confirmation_change_id=NEW.confirmation_change_id)
    OR (repository_id=NEW.repository_id AND review_run_id=NEW.review_run_id AND selected_decision_id=NEW.selected_decision_id AND renderer_version=NEW.renderer_version))
    THEN RAISE(ABORT, 'publication intents cannot be replaced') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM review_run_decision_events AS decision JOIN review_runs AS run ON run.id=decision.review_run_id
    WHERE run.purpose = 'review' AND decision.id=NEW.selected_decision_id AND decision.repository_id=NEW.repository_id AND run.repository_id=NEW.repository_id AND run.id=NEW.review_run_id)
    THEN RAISE(ABORT, 'publication decision scope is invalid') END;
  SELECT CASE WHEN json_extract(NEW.intent_json, '$.publicationId') IS NOT NEW.publication_id
    OR json_extract(NEW.intent_json, '$.binding.repositoryId') IS NOT NEW.repository_id
    OR json_extract(NEW.intent_json, '$.binding.reviewRunId') IS NOT NEW.review_run_id
    OR json_extract(NEW.intent_json, '$.binding.selectedDecisionId') IS NOT NEW.selected_decision_id
    OR json_extract(NEW.intent_json, '$.confirmationChangeId') IS NOT NEW.confirmation_change_id
    THEN RAISE(ABORT, 'publication intent binding is invalid') END;
END;

CREATE TRIGGER tr_notification_event_insert BEFORE INSERT ON notification_events
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM notification_events WHERE id = NEW.id
    OR (source_kind = NEW.source_kind AND source_id = NEW.source_id))
    THEN RAISE(ABORT, 'notification events cannot be replaced') END;
  SELECT CASE WHEN NEW.recorded_at < (SELECT retained_after FROM notification_retention WHERE singleton = 1)
    OR NEW.sequence IS NOT (SELECT next_sequence + 1 FROM notification_repository_counters WHERE repository_id = NEW.repository_id)
    THEN RAISE(ABORT, 'notification sequence or retention boundary is invalid') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM review_runs WHERE purpose = 'review' AND id = NEW.review_run_id
    AND repository_id = NEW.repository_id AND work_item_id = NEW.work_item_id AND revision_key = NEW.revision_key)
    THEN RAISE(ABORT, 'notification run scope is invalid') END;
  SELECT CASE WHEN NEW.source_kind = 'validation_job_terminal' AND NOT EXISTS (
    SELECT 1 FROM review_run_job_links AS link JOIN jobs AS job ON job.id = link.job_id
    WHERE link.job_id = NEW.job_id AND NEW.source_id = NEW.job_id AND link.review_run_id = NEW.review_run_id
      AND link.request_id = NEW.request_id AND link.activation_number = NEW.job_activation AND job.status = NEW.outcome)
    THEN RAISE(ABORT, 'notification validation source is invalid') END;
  SELECT CASE WHEN NEW.source_kind = 'publication_attempt' AND NOT EXISTS (
    SELECT 1 FROM publication_attempt_events AS attempt JOIN publication_intents AS intent ON intent.publication_id = attempt.publication_id
    WHERE attempt.id = NEW.source_id AND attempt.publication_id = NEW.publication_id AND attempt.repository_id = NEW.repository_id
      AND intent.repository_id = NEW.repository_id AND intent.review_run_id = NEW.review_run_id
      AND json_extract(attempt.receipt_json, '$.phase') = 'outcome' AND json_extract(attempt.receipt_json, '$.outcome') = NEW.outcome)
    THEN RAISE(ABORT, 'notification publication source is invalid') END;
END;

CREATE TRIGGER tr_notification_validation_terminal AFTER UPDATE OF status ON jobs
WHEN NEW.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled', 'stale')
  AND OLD.status NOT IN ('succeeded', 'failed', 'dead_letter', 'cancelled', 'stale')
  AND EXISTS (
    SELECT 1 FROM review_run_job_links AS link JOIN review_runs AS run ON run.id = link.review_run_id
    WHERE link.job_id = NEW.id AND run.purpose = 'review'
  )
  AND NOT EXISTS (SELECT 1 FROM notification_events WHERE source_kind = 'validation_job_terminal' AND source_id = NEW.id)
BEGIN
  INSERT INTO notification_repository_counters(repository_id)
  SELECT run.repository_id FROM review_run_job_links AS link JOIN review_runs AS run ON run.id = link.review_run_id
  WHERE link.job_id = NEW.id AND run.purpose = 'review' AND NOT EXISTS (
    SELECT 1 FROM notification_repository_counters WHERE repository_id = run.repository_id);
  INSERT INTO notification_events(id, repository_id, sequence, source_kind, source_id, occurred_at, recorded_at, recorded_day,
    work_item_id, work_item_kind, work_item_number, review_run_id, revision_key, request_id, job_id, job_activation,
    run_attempt_id, workflow_kind, target, outcome, summary_json)
  SELECT lower(hex(randomblob(16))), run.repository_id, counter.next_sequence + 1, 'validation_job_terminal', NEW.id,
    COALESCE(NEW.completed_at, NEW.updated_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%d', 'now'), run.work_item_id,
    json_extract(run.plan_json, '$.workItem.kind'), json_extract(run.plan_json, '$.workItem.number'), run.id,
    run.revision_key, link.request_id, NEW.id, link.activation_number,
    COALESCE(result.run_attempt_id, OLD.current_run_attempt_id), request.workflow_kind, request.target, NEW.status,
    CASE WHEN NEW.status = 'succeeded' THEN json_object(
      'resultId', result.id,
      'checks', json((SELECT json_object(
        'passed', COALESCE(SUM(json_extract(value, '$.outcome') = 'passed'), 0),
        'failed', COALESCE(SUM(json_extract(value, '$.outcome') = 'failed'), 0),
        'blocked', COALESCE(SUM(json_extract(value, '$.outcome') = 'blocked'), 0),
        'notRun', COALESCE(SUM(json_extract(value, '$.outcome') = 'not_run'), 0),
        'skipped', COALESCE(SUM(json_extract(value, '$.outcome') = 'skipped'), 0),
        'inconclusive', COALESCE(SUM(json_extract(value, '$.outcome') = 'inconclusive'), 0),
        'requiredNonPassed', COALESCE(SUM(json_extract(value, '$.required') = 1 AND json_extract(value, '$.outcome') != 'passed'), 0)
      ) FROM json_each(result.result_json, '$.report.checks'))),
      'blockerCount', json_array_length(result.result_json, '$.execution.blockers'),
      'sourceState', json_extract(result.result_json, '$.report.sourceState'),
      'cleanupState', json_extract(result.result_json, '$.execution.cleanupState'),
      'evidenceComplete', result.evidence_complete)
    ELSE json_object('attemptCount', NEW.attempt_count) END
  FROM review_run_job_links AS link JOIN review_runs AS run ON run.id = link.review_run_id
  JOIN review_run_requests AS request ON request.review_run_id = link.review_run_id AND request.request_id = link.request_id
  JOIN notification_repository_counters AS counter ON counter.repository_id = run.repository_id
  LEFT JOIN validation_job_results AS result ON result.job_id = NEW.id
  WHERE link.job_id = NEW.id AND run.purpose = 'review';
END;

CREATE TRIGGER tr_evaluation_job_request_epoch_rejected
BEFORE INSERT ON job_request_epochs
WHEN EXISTS (
  SELECT 1 FROM jobs AS job
  WHERE job.id = NEW.job_id
    AND CASE WHEN json_valid(job.execution_json) THEN (
      json_extract(job.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
      OR json_extract(job.execution_json, '$.validation.purpose.kind') IS 'evaluation'
      OR json_extract(job.execution_json, '$.validation.purpose.schemaVersion') IS 'EvaluationExecutionPurposeV1'
      OR json_extract(job.execution_json, '$.validation.authorization.kind') IS 'operator_evaluation'
      OR json_extract(job.execution_json, '$.validation.authorization.schemaVersion') IS 'EvaluationExecutionAuthorizationV1'
      OR json_extract(job.execution_json, '$.validation.source.schemaVersion') IS 'EvaluationSourceSnapshotV1'
    ) ELSE 0 END
)
OR EXISTS (
  SELECT 1 FROM review_run_job_links AS link
  JOIN review_runs AS run ON run.id = link.review_run_id
  WHERE link.job_id = NEW.job_id AND run.purpose = 'evaluation'
)
BEGIN
  SELECT RAISE(ABORT, 'evaluation jobs cannot acquire request epochs');
END;


CREATE TRIGGER tr_evaluation_job_routing_insert BEFORE INSERT ON jobs
WHEN CASE WHEN json_valid(NEW.execution_json) THEN (
  json_extract(NEW.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
  OR json_extract(NEW.execution_json, '$.validation.purpose.kind') IS 'evaluation'
  OR json_extract(NEW.execution_json, '$.validation.purpose.schemaVersion') IS 'EvaluationExecutionPurposeV1'
  OR json_extract(NEW.execution_json, '$.validation.authorization.kind') IS 'operator_evaluation'
  OR json_extract(NEW.execution_json, '$.validation.source.schemaVersion') IS 'EvaluationSourceSnapshotV1'
) ELSE 0 END
BEGIN
  SELECT CASE WHEN NEW.request_epoch_id IS NOT NULL OR NEW.source_event_id IS NOT NULL
    OR NOT CASE WHEN json_valid(NEW.execution_json) THEN (
      json_extract(NEW.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
      AND json_extract(NEW.execution_json, '$.validation.purpose.kind') IS 'evaluation'
      AND json_type(NEW.execution_json, '$.validation.requestEpochId') IS 'null'
      AND json_type(NEW.execution_json, '$.validation.testedSourceAuthorization') IS 'null'
      AND json_extract(NEW.execution_json, '$.validation.purpose.upstreamMutationPolicy') IS 'forbidden'
    ) ELSE 0 END
    THEN RAISE(ABORT, 'evaluation jobs cannot acquire GitHub routing authority') END;
END;

CREATE TRIGGER tr_evaluation_job_routing_update BEFORE UPDATE OF request_epoch_id, source_event_id, execution_json ON jobs
WHEN (CASE WHEN json_valid(NEW.execution_json) THEN (
  json_extract(NEW.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
  OR json_extract(NEW.execution_json, '$.validation.purpose.kind') IS 'evaluation'
  OR json_extract(NEW.execution_json, '$.validation.purpose.schemaVersion') IS 'EvaluationExecutionPurposeV1'
  OR json_extract(NEW.execution_json, '$.validation.authorization.kind') IS 'operator_evaluation'
  OR json_extract(NEW.execution_json, '$.validation.source.schemaVersion') IS 'EvaluationSourceSnapshotV1'
) ELSE 0 END) OR EXISTS (SELECT 1 FROM review_run_job_links AS link
  JOIN review_runs AS run ON run.id = link.review_run_id
  WHERE link.job_id = OLD.id AND run.purpose = 'evaluation')
BEGIN
  SELECT CASE WHEN NEW.request_epoch_id IS NOT NULL OR NEW.source_event_id IS NOT NULL
    OR NOT CASE WHEN json_valid(NEW.execution_json) THEN (
      json_extract(NEW.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
      AND json_extract(NEW.execution_json, '$.validation.purpose.kind') IS 'evaluation'
      AND json_type(NEW.execution_json, '$.validation.requestEpochId') IS 'null'
      AND json_type(NEW.execution_json, '$.validation.testedSourceAuthorization') IS 'null'
      AND json_extract(NEW.execution_json, '$.validation.purpose.upstreamMutationPolicy') IS 'forbidden'
    ) ELSE 0 END
    THEN RAISE(ABORT, 'evaluation jobs cannot acquire GitHub routing authority') END;
END;

CREATE TRIGGER tr_evaluation_job_lease_scope BEFORE UPDATE OF status ON jobs
WHEN NEW.status = 'leased' AND OLD.status IN ('queued', 'retry_waiting')
  AND ((CASE WHEN json_valid(NEW.execution_json) THEN (
  json_extract(NEW.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
  OR json_extract(NEW.execution_json, '$.validation.purpose.kind') IS 'evaluation'
  OR json_extract(NEW.execution_json, '$.validation.purpose.schemaVersion') IS 'EvaluationExecutionPurposeV1'
  OR json_extract(NEW.execution_json, '$.validation.authorization.kind') IS 'operator_evaluation'
  OR json_extract(NEW.execution_json, '$.validation.source.schemaVersion') IS 'EvaluationSourceSnapshotV1'
) ELSE 0 END) OR EXISTS (SELECT 1 FROM review_run_job_links AS link
  JOIN review_runs AS run ON run.id = link.review_run_id
  WHERE link.job_id = OLD.id AND run.purpose = 'evaluation'))
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM review_run_job_links AS link
    JOIN review_runs AS run ON run.id = link.review_run_id AND run.purpose = 'evaluation'
    JOIN review_run_requests AS request ON request.review_run_id = run.id AND request.request_id = link.request_id
    JOIN evaluation_cells AS cell ON cell.id = run.evaluation_cell_id AND cell.run_id = run.id
      AND cell.repository_id = run.repository_id AND cell.request_id = request.request_id
      AND cell.activation_id = run.activation_id AND cell.profile_version_id = request.profile_version_id
      AND cell.prompt_version_id = request.prompt_version_id
    JOIN evaluation_seals AS seal ON seal.evaluation_id = cell.evaluation_id
    JOIN evaluation_controls AS control ON control.evaluation_id = cell.evaluation_id AND control.status = 'active'
    JOIN managed_repositories AS repository ON repository.id = run.repository_id AND repository.enabled = 1
    WHERE link.job_id = NEW.id AND link.activation_number = 1 AND cell.trial = 1 AND cell.applicable = 1
      AND run.request_epoch_id IS NULL AND NEW.request_epoch_id IS NULL AND NEW.source_event_id IS NULL
      AND NEW.cancellation_requested_at IS NULL AND NEW.work_item_id = run.work_item_id
      AND NEW.resource_revision = run.revision_key
      AND json_extract(NEW.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV2'
      AND json_extract(NEW.execution_json, '$.validation.runId') IS run.id
      AND json_extract(NEW.execution_json, '$.validation.requestId') IS request.request_id
      AND json_extract(NEW.execution_json, '$.validation.planDigest') IS run.plan_digest
      AND json_extract(NEW.execution_json, '$.validation.purpose') IS json_extract(run.plan_json, '$.purpose')
      AND json_extract(NEW.execution_json, '$.validation.authorization') IS json_extract(run.plan_json, '$.authorization')
  ) THEN RAISE(ABORT, 'evaluation lease requires an active sealed cell and its frozen run') END;
END;

-- Bind a complete frozen evaluation Run before the matrix seal is created.
-- Owner validation recomputes canonical digests and validates the complete contracts.
-- This trigger compares authoritative source, authorization, configuration, and cell
-- content as well as their identifiers; digest-shaped values alone are insufficient.
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
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.plan_json)
        WHERE key NOT IN ('schemaVersion', 'activationId', 'repository', 'workItemId',
          'workItem', 'revision', 'testedSourceRevision', 'testedSourceAuthorization',
          'authorization', 'jobs', 'requiredCheckIds', 'requestEpochId', 'purpose',
          'source', 'modelRequirements', 'reproduction')
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
      AND (SELECT COUNT(*) FROM json_each(NEW.plan_json, '$.modelRequirements')) = 1
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.plan_json, '$.modelRequirements')
        WHERE key NOT IN ('required')
      )
      AND json_type(NEW.plan_json, '$.modelRequirements.required') IN ('true', 'false')
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
      AND (SELECT COUNT(*) FROM json_each(configuration.value)) = 3
      AND NOT EXISTS (
        SELECT 1 FROM json_each(configuration.value)
        WHERE key NOT IN ('profileVersion', 'prompt', 'modelRequirements')
      )
      AND CAST(json_extract(request.value, '$.profileVersion') AS BLOB) IS CAST(json_extract(configuration.value, '$.profileVersion') AS BLOB)
      AND CAST(json_extract(request.value, '$.prompt') AS BLOB) IS CAST(json_extract(configuration.value, '$.prompt') AS BLOB)
      AND CAST(json_extract(NEW.plan_json, '$.modelRequirements') AS BLOB) IS CAST(json_extract(configuration.value, '$.modelRequirements') AS BLOB)
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



-- These guards are installed after the controlled review_runs replacement.
CREATE TRIGGER tr_evaluation_insert BEFORE INSERT ON evaluations BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM evaluations WHERE id = NEW.id) OR NOT EXISTS (
    SELECT 1 FROM evaluation_suite_versions AS suite WHERE suite.id = NEW.suite_version_id
      AND suite.repository_id = NEW.repository_id AND suite.source_version_id = NEW.source_version_id
      AND suite.expectation_version_id = NEW.expectation_version_id
      AND suite.source_manifest_sha256 IS NEW.source_manifest_sha256
      AND suite.workflow_kind IS NEW.workflow_kind AND suite.target IS NEW.target AND suite.case_count = NEW.case_count
  ) THEN RAISE(ABORT, 'evaluation must use one published suite version') END;
  SELECT CASE WHEN json_extract(NEW.execution_manifest_json, '$.workflowKind') IS NOT NEW.workflow_kind
    OR json_extract(NEW.execution_manifest_json, '$.target') IS NOT NEW.target
    OR NEW.cell_count != (SELECT COUNT(DISTINCT json_extract(value, '$.cellId')) FROM json_each(NEW.cell_manifest_json, '$.cells'))
    OR NEW.cell_count != (SELECT COUNT(DISTINCT json_extract(value, '$.runId')) FROM json_each(NEW.cell_manifest_json, '$.cells'))
    OR NEW.case_count != (SELECT COUNT(DISTINCT json_extract(value, '$.caseId')) FROM json_each(NEW.scoring_plan_json, '$.cases'))
    THEN RAISE(ABORT, 'evaluation matrix identities are incomplete or duplicated') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.cell_manifest_json, '$.cells') AS entry
    WHERE json_extract(entry.value, '$.trial') IS NOT 1
      OR json_extract(entry.value, '$.arm') NOT IN ('baseline', 'candidate')
      OR json_extract(entry.value, '$.arm') IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM evaluation_source_versions AS version, json_each(version.manifest_json, '$.cases') AS source
        WHERE version.id = NEW.source_version_id
          AND json_extract(source.value, '$.caseId') IS json_extract(entry.value, '$.caseId')
          AND json_extract(source.value, '$.sourceId') IS json_extract(entry.value, '$.sourceId')
          AND json_extract(source.value, '$.sourceDigest') IS json_extract(entry.value, '$.sourceDigest')
      )
      OR NOT EXISTS (
        SELECT 1 FROM json_each(NEW.scoring_plan_json, '$.cases') AS expected
        WHERE json_extract(expected.value, '$.caseId') IS json_extract(entry.value, '$.caseId')
          AND json_extract(expected.value, '$.sourceDigest') IS json_extract(entry.value, '$.sourceDigest')
          AND json_extract(expected.value, '$.' || json_extract(entry.value, '$.arm') || 'Binding.cellId') IS json_extract(entry.value, '$.cellId')
          AND json_extract(expected.value, '$.' || json_extract(entry.value, '$.arm') || 'Binding.runId') IS json_extract(entry.value, '$.runId')
          AND json_extract(expected.value, '$.' || json_extract(entry.value, '$.arm') || 'Binding.requestId') IS json_extract(entry.value, '$.requestId')
      )
      OR json_extract(entry.value, '$.profileVersionId') IS NOT json_extract(NEW.configuration_manifest_json, '$.' || json_extract(entry.value, '$.arm') || '.profileVersion.id')
      OR json_extract(entry.value, '$.promptVersionId') IS NOT json_extract(NEW.configuration_manifest_json, '$.' || json_extract(entry.value, '$.arm') || '.prompt.version.id')
      OR json_extract(entry.value, '$.modelRequirements') IS NOT json_extract(NEW.configuration_manifest_json, '$.' || json_extract(entry.value, '$.arm') || '.modelRequirements')
  ) THEN RAISE(ABORT, 'evaluation cells do not match the frozen source, configuration, and scoring bindings') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM evaluation_source_versions AS version, json_each(version.manifest_json, '$.cases') AS source
    WHERE version.id = NEW.source_version_id AND (
      (SELECT COUNT(*) FROM json_each(NEW.cell_manifest_json, '$.cells') AS entry
       WHERE json_extract(entry.value, '$.caseId') IS json_extract(source.value, '$.caseId')
         AND json_extract(entry.value, '$.arm') IS 'baseline') != 1
      OR (SELECT COUNT(*) FROM json_each(NEW.cell_manifest_json, '$.cells') AS entry
       WHERE json_extract(entry.value, '$.caseId') IS json_extract(source.value, '$.caseId')
         AND json_extract(entry.value, '$.arm') IS 'candidate') != 1
    )
  ) THEN RAISE(ABORT, 'every evaluation case requires both declared arms') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.scoring_plan_json, '$.cases') AS scored
    WHERE NOT EXISTS (
      SELECT 1 FROM evaluation_expectation_versions AS version,
        json_each(version.manifest_json, '$.cases') AS expected
      WHERE version.id = NEW.expectation_version_id
        AND json_extract(expected.value, '$.caseId') IS json_extract(scored.value, '$.caseId')
        AND json_extract(expected.value, '$.applicability') IS json_extract(scored.value, '$.applicability')
        AND json_extract(expected.value, '$.findings') IS json_extract(scored.value, '$.findings')
        AND json_type(scored.value, '$.criteria') IS 'array'
        AND json_array_length(expected.value, '$.criteria') IS json_array_length(scored.value, '$.criteria')
        AND json_array_length(scored.value, '$.criteria') = (SELECT COUNT(DISTINCT json_extract(value, '$.criterionId')) FROM json_each(scored.value, '$.criteria'))
        AND NOT EXISTS (
          SELECT 1 FROM json_each(scored.value, '$.criteria') AS criterion WHERE NOT EXISTS (
            SELECT 1 FROM json_each(expected.value, '$.criteria') AS original
            WHERE json_extract(original.value, '$.criterionId') IS json_extract(criterion.value, '$.criterionId')
              AND original.value IS json_remove(criterion.value, '$.baselineCheckId', '$.candidateCheckId')
          )
        )
    )
  ) THEN RAISE(ABORT, 'evaluation scoring cannot change frozen expectations or remove criteria') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.configuration_manifest_json) AS arm
    WHERE arm.key IN ('baseline', 'candidate') AND NOT EXISTS (
      SELECT 1 FROM validation_profile_versions AS version
      JOIN validation_profiles AS profile ON profile.id = version.profile_id
      JOIN prompt_versions AS prompt ON prompt.id = json_extract(arm.value, '$.prompt.version.id')
      JOIN prompt_templates AS template ON template.id = prompt.template_id
      WHERE version.id = json_extract(arm.value, '$.profileVersion.id')
        AND arm.type IS 'object'
        AND (SELECT COUNT(*) FROM json_each(arm.value)) = 3
        AND NOT EXISTS (SELECT 1 FROM json_each(arm.value) WHERE key NOT IN ('profileVersion','prompt','modelRequirements'))
        AND NOT EXISTS (SELECT parent, key FROM json_tree(arm.value) WHERE key IS NOT NULL GROUP BY parent, key HAVING COUNT(*) != 1)
        AND json_type(arm.value, '$.modelRequirements') IS 'object'
        AND (SELECT COUNT(*) FROM json_each(arm.value, '$.modelRequirements')) = 1
        AND NOT EXISTS (SELECT 1 FROM json_each(arm.value, '$.modelRequirements') WHERE key NOT IN ('required'))
        AND json_type(arm.value, '$.modelRequirements.required') IN ('true','false')
        AND profile.repository_id = NEW.repository_id AND profile.workflow_kind = NEW.workflow_kind AND profile.target = NEW.target
        AND template.workflow_kind = NEW.workflow_kind AND json_extract(arm.value, '$.prompt.workflowKind') IS NEW.workflow_kind
        AND json_extract(arm.value, '$.profileVersion.repositoryId') IS NEW.repository_id
        AND json_extract(arm.value, '$.profileVersion.profileId') IS profile.id
        AND json_extract(arm.value, '$.profileVersion.workflowKind') IS NEW.workflow_kind
        AND json_extract(arm.value, '$.profileVersion.target') IS NEW.target
        AND json_extract(arm.value, '$.profileVersion.config') IS version.config_json
        AND json_extract(arm.value, '$.profileVersion.configSha256') IS version.config_sha256
        AND json_extract(arm.value, '$.profileVersion.version') IS version.version
        AND json_extract(arm.value, '$.profileVersion.name') IS version.name
        AND json_extract(arm.value, '$.profileVersion.required') IS version.required
        AND json_extract(arm.value, '$.profileVersion.outputSchemaVersion') IS version.output_schema_version
        AND json_extract(arm.value, '$.profileVersion.createdAt') IS version.created_at
        AND json_extract(arm.value, '$.profileVersion.publishedAt') IS version.published_at
        AND json_extract(arm.value, '$.profileVersion.createdBy') IS version.created_by
        AND json_extract(arm.value, '$.prompt.version.templateId') IS prompt.template_id
        AND json_extract(arm.value, '$.prompt.version.version') IS prompt.version
        AND json_extract(arm.value, '$.prompt.version.content') IS prompt.content
        AND json_extract(arm.value, '$.prompt.version.contentSha256') IS prompt.content_sha256
        AND json_extract(arm.value, '$.prompt.version.outputSchemaVersion') IS prompt.output_schema_version
        AND json_extract(arm.value, '$.prompt.version.createdAt') IS prompt.created_at
        AND json_extract(arm.value, '$.prompt.version.publishedAt') IS prompt.published_at
        AND json_extract(arm.value, '$.prompt.version.createdBy') IS prompt.created_by
        AND json_extract(NEW.scoring_plan_json, '$.' || arm.key || '.profileVersionId') IS version.id
        AND json_extract(NEW.scoring_plan_json, '$.' || arm.key || '.promptVersionId') IS prompt.id
    )
  ) THEN RAISE(ABORT, 'evaluation configuration must retain real published versions') END;
END;

CREATE TRIGGER tr_evaluation_cell_insert BEFORE INSERT ON evaluation_cells BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM evaluation_cells WHERE id = NEW.id)
    OR EXISTS (SELECT 1 FROM evaluation_seals WHERE evaluation_id = NEW.evaluation_id)
    OR EXISTS (SELECT 1 FROM review_runs WHERE id = NEW.run_id)
    THEN RAISE(ABORT, 'evaluation cells require new execution identities before sealing') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evaluations AS evaluation
    JOIN evaluation_sources AS source ON source.id = NEW.source_id AND source.repository_id = evaluation.repository_id,
      json_each(evaluation.cell_manifest_json, '$.cells') AS entry,
      json_each(evaluation.scoring_plan_json, '$.cases') AS expected
    WHERE evaluation.id = NEW.evaluation_id AND evaluation.repository_id = NEW.repository_id
      AND source.source_digest IS NEW.source_digest
      AND json_extract(entry.value, '$.cellId') IS NEW.id
      AND json_extract(entry.value, '$.caseId') IS NEW.case_id
      AND json_extract(entry.value, '$.arm') IS NEW.arm
      AND json_extract(entry.value, '$.trial') IS NEW.trial
      AND json_extract(entry.value, '$.sourceId') IS NEW.source_id
      AND json_extract(entry.value, '$.sourceDigest') IS NEW.source_digest
      AND json_extract(entry.value, '$.runId') IS NEW.run_id
      AND json_extract(entry.value, '$.requestId') IS NEW.request_id
      AND json_extract(entry.value, '$.activationId') IS NEW.activation_id
      AND json_extract(entry.value, '$.profileVersionId') IS NEW.profile_version_id
      AND json_extract(entry.value, '$.promptVersionId') IS NEW.prompt_version_id
      AND json_extract(expected.value, '$.caseId') IS NEW.case_id
      AND CASE json_extract(expected.value, '$.applicability.state') WHEN 'applicable' THEN 1 WHEN 'not_applicable' THEN 0 ELSE -1 END IS NEW.applicable
  ) THEN RAISE(ABORT, 'evaluation cell does not match its declared matrix') END;
END;

CREATE TRIGGER tr_evaluation_seal_insert BEFORE INSERT ON evaluation_seals BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM evaluation_seals WHERE evaluation_id = NEW.evaluation_id)
    THEN RAISE(ABORT, 'evaluation seals are immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evaluations AS evaluation
    WHERE evaluation.id = NEW.evaluation_id
      AND (SELECT COUNT(*) FROM evaluation_authorizations WHERE evaluation_id = evaluation.id) = 1
      AND (SELECT COUNT(*) FROM evaluation_cells WHERE evaluation_id = evaluation.id) = evaluation.cell_count
      AND NOT EXISTS (
        SELECT 1 FROM evaluation_cells AS cell WHERE cell.evaluation_id = evaluation.id AND NOT EXISTS (
          SELECT 1 FROM review_runs AS run
          JOIN review_run_requests AS request ON request.review_run_id = run.id AND request.request_id = cell.request_id
          WHERE run.id = cell.run_id AND run.purpose = 'evaluation' AND run.evaluation_cell_id = cell.id
            AND run.request_count = 1 AND (SELECT COUNT(*) FROM review_run_requests WHERE review_run_id = run.id) = 1
            AND request.profile_version_id IS cell.profile_version_id AND request.prompt_version_id IS cell.prompt_version_id
            AND EXISTS (
              SELECT 1 FROM json_each(evaluation.cell_manifest_json, '$.cells') AS entry
              WHERE json_extract(entry.value, '$.cellId') IS cell.id
                AND json_extract(entry.value, '$.renderedPromptDigest') IS json_extract(request.prompt_envelope_json, '$.promptSha256')
                AND json_extract(entry.value, '$.outputSchemaDigest') IS json_extract(request.prompt_envelope_json, '$.outputSchemaSha256')
            )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM evaluation_cells AS cell JOIN review_run_job_links AS link ON link.review_run_id = cell.run_id
        WHERE cell.evaluation_id = evaluation.id
      )
  ) THEN RAISE(ABORT, 'evaluation cannot be sealed until every cell has its new Run and request') END;
END;

CREATE TRIGGER tr_evaluation_adjudication_insert BEFORE INSERT ON evaluation_adjudication_events BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM evaluation_adjudication_events WHERE id = NEW.id) OR NOT EXISTS (
    SELECT 1 FROM evaluation_cells AS cell
    JOIN evaluation_seals AS seal ON seal.evaluation_id = cell.evaluation_id
    JOIN review_run_job_links AS link ON link.review_run_id = cell.run_id AND link.request_id = cell.request_id AND link.activation_number = 1
    JOIN validation_job_results AS result ON result.job_id = link.job_id AND result.id = NEW.result_id
    WHERE cell.id = NEW.cell_id AND cell.evaluation_id = NEW.evaluation_id AND cell.repository_id = NEW.repository_id
      AND result.result_digest IS NEW.result_digest
      AND json_extract(NEW.adjudication_json, '$.caseId') IS cell.case_id
      AND json_extract(NEW.adjudication_json, '$.arm') IS cell.arm
      AND NEW.version = COALESCE((SELECT MAX(version) FROM evaluation_adjudication_events
        WHERE cell_id = NEW.cell_id AND result_id = NEW.result_id AND result_digest = NEW.result_digest AND occurrence_key = NEW.occurrence_key), 0) + 1
      AND NEW.previous_event_id IS (SELECT id FROM evaluation_adjudication_events
        WHERE cell_id = NEW.cell_id AND result_id = NEW.result_id AND result_digest = NEW.result_digest AND occurrence_key = NEW.occurrence_key ORDER BY version DESC LIMIT 1)
  ) THEN RAISE(ABORT, 'evaluation adjudication must bind its actual result and previous version') END;
END;

CREATE TRIGGER tr_evaluation_assessment_insert BEFORE INSERT ON evaluation_assessments BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM evaluation_assessments WHERE id = NEW.id) OR NOT EXISTS (
    SELECT 1 FROM evaluations AS evaluation JOIN evaluation_seals AS seal ON seal.evaluation_id = evaluation.id
    WHERE evaluation.id = NEW.evaluation_id AND evaluation.repository_id = NEW.repository_id
      AND evaluation.scoring_plan_digest IS NEW.scoring_plan_digest
      AND NEW.version = COALESCE((SELECT MAX(version) FROM evaluation_assessments WHERE evaluation_id = NEW.evaluation_id), 0) + 1
  ) THEN RAISE(ABORT, 'evaluation assessment must bind the sealed scoring plan and next version') END;
END;


-- Explicit no-REPLACE protection also applies when recursive trigger execution is disabled.

CREATE TRIGGER tr_evaluation_sources_no_replace BEFORE INSERT ON evaluation_sources
WHEN EXISTS (SELECT 1 FROM evaluation_sources WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be replaced'); END;

CREATE TRIGGER tr_evaluation_sources_immutable_update BEFORE UPDATE ON evaluation_sources BEGIN SELECT RAISE(ABORT, 'evaluation records are immutable'); END;

CREATE TRIGGER tr_evaluation_sources_immutable_delete BEFORE DELETE ON evaluation_sources BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be deleted'); END;

CREATE TRIGGER tr_evaluation_suites_no_replace BEFORE INSERT ON evaluation_suites
WHEN EXISTS (SELECT 1 FROM evaluation_suites WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be replaced'); END;

CREATE TRIGGER tr_evaluation_suites_immutable_delete BEFORE DELETE ON evaluation_suites BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be deleted'); END;

CREATE TRIGGER tr_evaluation_source_versions_no_replace BEFORE INSERT ON evaluation_source_versions
WHEN EXISTS (SELECT 1 FROM evaluation_source_versions WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be replaced'); END;

CREATE TRIGGER tr_evaluation_source_versions_immutable_update BEFORE UPDATE ON evaluation_source_versions BEGIN SELECT RAISE(ABORT, 'evaluation records are immutable'); END;

CREATE TRIGGER tr_evaluation_source_versions_immutable_delete BEFORE DELETE ON evaluation_source_versions BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be deleted'); END;

CREATE TRIGGER tr_evaluation_expectation_versions_no_replace BEFORE INSERT ON evaluation_expectation_versions
WHEN EXISTS (SELECT 1 FROM evaluation_expectation_versions WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be replaced'); END;

CREATE TRIGGER tr_evaluation_expectation_versions_immutable_update BEFORE UPDATE ON evaluation_expectation_versions BEGIN SELECT RAISE(ABORT, 'evaluation records are immutable'); END;

CREATE TRIGGER tr_evaluation_expectation_versions_immutable_delete BEFORE DELETE ON evaluation_expectation_versions BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be deleted'); END;

CREATE TRIGGER tr_evaluation_suite_versions_no_replace BEFORE INSERT ON evaluation_suite_versions
WHEN EXISTS (SELECT 1 FROM evaluation_suite_versions WHERE id = NEW.id OR (suite_id = NEW.suite_id AND (version = NEW.version OR source_draft_revision = NEW.source_draft_revision)))
BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be replaced'); END;

CREATE TRIGGER tr_evaluation_suite_versions_immutable_update BEFORE UPDATE ON evaluation_suite_versions BEGIN SELECT RAISE(ABORT, 'evaluation records are immutable'); END;

CREATE TRIGGER tr_evaluation_suite_versions_immutable_delete BEFORE DELETE ON evaluation_suite_versions BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be deleted'); END;

CREATE TRIGGER tr_evaluations_no_replace BEFORE INSERT ON evaluations
WHEN EXISTS (SELECT 1 FROM evaluations WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be replaced'); END;

CREATE TRIGGER tr_evaluations_immutable_update BEFORE UPDATE ON evaluations BEGIN SELECT RAISE(ABORT, 'evaluation records are immutable'); END;

CREATE TRIGGER tr_evaluations_immutable_delete BEFORE DELETE ON evaluations BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be deleted'); END;

CREATE TRIGGER tr_evaluation_authorizations_no_replace BEFORE INSERT ON evaluation_authorizations
WHEN EXISTS (SELECT 1 FROM evaluation_authorizations WHERE id = NEW.id OR evaluation_id = NEW.evaluation_id)
BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be replaced'); END;

CREATE TRIGGER tr_evaluation_authorizations_immutable_update BEFORE UPDATE ON evaluation_authorizations BEGIN SELECT RAISE(ABORT, 'evaluation records are immutable'); END;

CREATE TRIGGER tr_evaluation_authorizations_immutable_delete BEFORE DELETE ON evaluation_authorizations BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be deleted'); END;

CREATE TRIGGER tr_evaluation_cells_no_replace BEFORE INSERT ON evaluation_cells
WHEN EXISTS (SELECT 1 FROM evaluation_cells WHERE id = NEW.id OR run_id = NEW.run_id OR (evaluation_id = NEW.evaluation_id AND case_id = NEW.case_id AND arm = NEW.arm AND trial = NEW.trial))
BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be replaced'); END;

CREATE TRIGGER tr_evaluation_cells_immutable_update BEFORE UPDATE ON evaluation_cells BEGIN SELECT RAISE(ABORT, 'evaluation records are immutable'); END;

CREATE TRIGGER tr_evaluation_cells_immutable_delete BEFORE DELETE ON evaluation_cells BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be deleted'); END;

CREATE TRIGGER tr_evaluation_seals_no_replace BEFORE INSERT ON evaluation_seals
WHEN EXISTS (SELECT 1 FROM evaluation_seals WHERE evaluation_id = NEW.evaluation_id)
BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be replaced'); END;

CREATE TRIGGER tr_evaluation_seals_immutable_update BEFORE UPDATE ON evaluation_seals BEGIN SELECT RAISE(ABORT, 'evaluation records are immutable'); END;

CREATE TRIGGER tr_evaluation_seals_immutable_delete BEFORE DELETE ON evaluation_seals BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be deleted'); END;

CREATE TRIGGER tr_evaluation_controls_no_replace BEFORE INSERT ON evaluation_controls
WHEN EXISTS (SELECT 1 FROM evaluation_controls WHERE evaluation_id = NEW.evaluation_id)
BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be replaced'); END;

CREATE TRIGGER tr_evaluation_controls_immutable_delete BEFORE DELETE ON evaluation_controls BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be deleted'); END;

CREATE TRIGGER tr_evaluation_mutation_receipts_no_replace BEFORE INSERT ON evaluation_mutation_receipts
WHEN EXISTS (SELECT 1 FROM evaluation_mutation_receipts WHERE repository_id = NEW.repository_id AND change_id = NEW.change_id)
BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be replaced'); END;

CREATE TRIGGER tr_evaluation_mutation_receipts_immutable_update BEFORE UPDATE ON evaluation_mutation_receipts BEGIN SELECT RAISE(ABORT, 'evaluation records are immutable'); END;

CREATE TRIGGER tr_evaluation_mutation_receipts_immutable_delete BEFORE DELETE ON evaluation_mutation_receipts BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be deleted'); END;

CREATE TRIGGER tr_evaluation_adjudication_events_no_replace BEFORE INSERT ON evaluation_adjudication_events
WHEN EXISTS (SELECT 1 FROM evaluation_adjudication_events WHERE id = NEW.id OR (cell_id = NEW.cell_id AND result_id = NEW.result_id AND result_digest = NEW.result_digest AND occurrence_key = NEW.occurrence_key AND version = NEW.version))
BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be replaced'); END;

CREATE TRIGGER tr_evaluation_adjudication_events_immutable_update BEFORE UPDATE ON evaluation_adjudication_events BEGIN SELECT RAISE(ABORT, 'evaluation records are immutable'); END;

CREATE TRIGGER tr_evaluation_adjudication_events_immutable_delete BEFORE DELETE ON evaluation_adjudication_events BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be deleted'); END;

CREATE TRIGGER tr_evaluation_assessments_no_replace BEFORE INSERT ON evaluation_assessments
WHEN EXISTS (SELECT 1 FROM evaluation_assessments WHERE id = NEW.id OR (evaluation_id = NEW.evaluation_id AND version = NEW.version))
BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be replaced'); END;

CREATE TRIGGER tr_evaluation_assessments_immutable_update BEFORE UPDATE ON evaluation_assessments BEGIN SELECT RAISE(ABORT, 'evaluation records are immutable'); END;

CREATE TRIGGER tr_evaluation_assessments_immutable_delete BEFORE DELETE ON evaluation_assessments BEGIN SELECT RAISE(ABORT, 'evaluation records cannot be deleted'); END;
