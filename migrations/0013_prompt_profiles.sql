CREATE TABLE prompt_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  description TEXT NOT NULL CHECK (length(description) <= 2048 AND instr(description, char(0)) = 0),
  workflow_kind TEXT NOT NULL CHECK (workflow_kind IN ('pr_static_build', 'pr_ui', 'issue_triage', 'issue_validation')),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  draft_revision INTEGER NOT NULL CHECK (draft_revision BETWEEN 1 AND 9007199254740991),
  draft_content TEXT NOT NULL CHECK (
    length(CAST(draft_content AS BLOB)) BETWEEN 1 AND 262144
    AND length(trim(draft_content, char(9) || char(10) || char(13) || ' ')) > 0
    AND instr(draft_content, char(0)) = 0
  ),
  draft_output_schema_version TEXT NOT NULL,
  latest_published_version_id TEXT REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (draft_output_schema_version = CASE workflow_kind
    WHEN 'pr_static_build' THEN 'PrReviewPlanV2'
    WHEN 'issue_triage' THEN 'IssueTriageV2'
    ELSE 'ValidationSummaryV1' END)
) STRICT;

CREATE TABLE prompt_versions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES prompt_templates(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  source_draft_revision INTEGER NOT NULL CHECK (source_draft_revision BETWEEN 1 AND 9007199254740991),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) BETWEEN 1 AND 262144 AND instr(content, char(0)) = 0),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  output_schema_version TEXT NOT NULL CHECK (output_schema_version IN ('PrReviewPlanV2', 'IssueTriageV2', 'ValidationSummaryV1')),
  created_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 16384 AND instr(created_by, char(0)) = 0),
  UNIQUE (template_id, version)
) STRICT;

CREATE INDEX ix_prompt_templates_workflow_created ON prompt_templates(workflow_kind, created_at DESC, id);
CREATE INDEX ix_prompt_templates_created ON prompt_templates(created_at DESC, id);

CREATE TABLE prompt_bindings (
  scope_key TEXT NOT NULL,
  repository_id TEXT REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  workflow_kind TEXT NOT NULL CHECK (workflow_kind IN ('pr_static_build', 'pr_ui', 'issue_triage', 'issue_validation')),
  prompt_version_id TEXT NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, workflow_kind),
  CHECK (scope_key = CASE WHEN repository_id IS NULL THEN 'global' ELSE 'repository:' || repository_id END)
) STRICT;

CREATE TABLE prompt_binding_history (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  repository_id TEXT REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  workflow_kind TEXT NOT NULL,
  prompt_version_id TEXT NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  previous_version_id TEXT REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 16384),
  UNIQUE (scope_key, workflow_kind, version),
  FOREIGN KEY (scope_key, workflow_kind) REFERENCES prompt_bindings(scope_key, workflow_kind) ON DELETE RESTRICT,
  CHECK (scope_key = CASE WHEN repository_id IS NULL THEN 'global' ELSE 'repository:' || repository_id END)
) STRICT;

CREATE TABLE validation_profiles (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  workflow_kind TEXT NOT NULL CHECK (workflow_kind IN ('pr_static_build', 'pr_ui', 'issue_triage', 'issue_validation')),
  target TEXT NOT NULL CHECK (target IN ('headless', 'windows_desktop', 'web')),
  created_at TEXT NOT NULL,
  CHECK (workflow_kind = 'issue_validation'
    OR (workflow_kind = 'pr_ui' AND target IN ('windows_desktop', 'web'))
    OR (workflow_kind IN ('pr_static_build', 'issue_triage') AND target = 'headless'))
) STRICT;

CREATE TABLE validation_profile_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES validation_profiles(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  config_json TEXT NOT NULL CHECK (
    length(CAST(config_json AS BLOB)) BETWEEN 1 AND 262144
    AND json_valid(config_json)
    AND json_type(config_json) = 'object'
    AND json_extract(config_json, '$.schemaVersion') = 'ValidationProfileV1'
  ),
  config_sha256 TEXT NOT NULL CHECK (length(config_sha256) = 64 AND config_sha256 NOT GLOB '*[^0-9a-f]*'),
  output_schema_version TEXT NOT NULL CHECK (output_schema_version IN ('PrReviewPlanV2', 'IssueTriageV2', 'ValidationReportV1')),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  created_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 16384),
  UNIQUE (profile_id, version)
) STRICT;

CREATE INDEX ix_validation_profiles_repository_created ON validation_profiles(repository_id, created_at DESC, id);

CREATE TABLE validation_profile_bindings (
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES validation_profiles(id) ON DELETE RESTRICT,
  profile_version_id TEXT NOT NULL REFERENCES validation_profile_versions(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, profile_id)
) STRICT;

CREATE TABLE validation_profile_binding_history (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES validation_profiles(id) ON DELETE RESTRICT,
  profile_version_id TEXT NOT NULL REFERENCES validation_profile_versions(id) ON DELETE RESTRICT,
  previous_version_id TEXT REFERENCES validation_profile_versions(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 16384),
  UNIQUE (repository_id, profile_id, version),
  FOREIGN KEY (repository_id, profile_id) REFERENCES validation_profile_bindings(repository_id, profile_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE prompt_configuration_audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('template_created', 'draft_saved', 'prompt_published', 'prompt_bound', 'profile_published', 'profile_bound', 'bootstrap_registered')),
  entity_id TEXT NOT NULL,
  repository_id TEXT REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  created_at TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object' AND length(CAST(detail_json AS BLOB)) <= 16384)
) STRICT;

CREATE INDEX ix_prompt_configuration_audit_entity ON prompt_configuration_audit(entity_id, created_at DESC, id);

CREATE TABLE prompt_configuration_bootstrap (
  workflow_kind TEXT PRIMARY KEY CHECK (workflow_kind IN ('pr_static_build', 'pr_ui', 'issue_triage', 'issue_validation')),
  prompt_version_id TEXT NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER tr_prompt_configuration_bootstrap_consistency
BEFORE INSERT ON prompt_configuration_bootstrap
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM prompt_bindings WHERE scope_key = 'global' AND workflow_kind = NEW.workflow_kind
      AND prompt_version_id = NEW.prompt_version_id
  ) THEN RAISE(ABORT, 'bootstrap marker requires a matching global prompt binding') END;
END;

CREATE TRIGGER tr_prompt_template_update_identity
BEFORE UPDATE ON prompt_templates
BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.workflow_kind IS NOT OLD.workflow_kind
    OR NEW.created_at IS NOT OLD.created_at OR NEW.version != OLD.version + 1
    OR NOT (
      (NEW.draft_revision = OLD.draft_revision + 1 AND NEW.latest_published_version_id IS OLD.latest_published_version_id)
      OR (NEW.draft_revision = OLD.draft_revision AND NEW.draft_content = OLD.draft_content
        AND NEW.draft_output_schema_version = OLD.draft_output_schema_version
        AND NEW.latest_published_version_id IS NOT OLD.latest_published_version_id)
    ) THEN RAISE(ABORT, 'invalid prompt template revision') END;
  SELECT CASE WHEN NEW.latest_published_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM prompt_versions WHERE id = NEW.latest_published_version_id AND template_id = NEW.id
  ) THEN RAISE(ABORT, 'published prompt belongs to another template') END;
END;

CREATE TRIGGER tr_prompt_version_insert_consistency
BEFORE INSERT ON prompt_versions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM prompt_templates WHERE id = NEW.template_id
      AND draft_revision = NEW.source_draft_revision AND draft_content = NEW.content
      AND draft_output_schema_version = NEW.output_schema_version
  ) OR NEW.version != COALESCE((SELECT MAX(version) FROM prompt_versions WHERE template_id = NEW.template_id), 0) + 1
  THEN RAISE(ABORT, 'published prompt must match its current draft') END;
END;

CREATE TRIGGER tr_prompt_binding_insert_consistency
BEFORE INSERT ON prompt_bindings
BEGIN
  SELECT CASE WHEN NEW.version != 1 OR NOT EXISTS (
    SELECT 1 FROM prompt_versions AS version JOIN prompt_templates AS template ON template.id = version.template_id
    WHERE version.id = NEW.prompt_version_id AND template.workflow_kind = NEW.workflow_kind
  ) THEN RAISE(ABORT, 'invalid published prompt binding') END;
END;

CREATE TRIGGER tr_prompt_binding_update_consistency
BEFORE UPDATE ON prompt_bindings
BEGIN
  SELECT CASE WHEN NEW.scope_key IS NOT OLD.scope_key OR NEW.repository_id IS NOT OLD.repository_id
    OR NEW.workflow_kind IS NOT OLD.workflow_kind OR NEW.version != OLD.version + 1
    OR NOT EXISTS (
      SELECT 1 FROM prompt_versions AS version JOIN prompt_templates AS template ON template.id = version.template_id
      WHERE version.id = NEW.prompt_version_id AND template.workflow_kind = NEW.workflow_kind
    ) THEN RAISE(ABORT, 'invalid published prompt binding') END;
END;

CREATE TRIGGER tr_prompt_binding_history_consistency
BEFORE INSERT ON prompt_binding_history
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM prompt_bindings WHERE scope_key = NEW.scope_key AND repository_id IS NEW.repository_id
      AND workflow_kind = NEW.workflow_kind AND prompt_version_id = NEW.prompt_version_id AND version = NEW.version
  ) OR NEW.previous_version_id IS NOT (
    SELECT prompt_version_id FROM prompt_binding_history WHERE scope_key = NEW.scope_key
      AND workflow_kind = NEW.workflow_kind AND version = NEW.version - 1
  ) OR NEW.version != COALESCE((SELECT MAX(version) FROM prompt_binding_history
    WHERE scope_key = NEW.scope_key AND workflow_kind = NEW.workflow_kind), 0) + 1
  THEN RAISE(ABORT, 'invalid prompt binding history') END;
END;

CREATE TRIGGER tr_validation_profile_version_consistency
BEFORE INSERT ON validation_profile_versions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM validation_profiles WHERE id = NEW.profile_id AND NEW.output_schema_version = CASE workflow_kind
      WHEN 'pr_static_build' THEN 'PrReviewPlanV2' WHEN 'issue_triage' THEN 'IssueTriageV2' ELSE 'ValidationReportV1' END
  ) OR NEW.version != COALESCE((SELECT MAX(version) FROM validation_profile_versions WHERE profile_id = NEW.profile_id), 0) + 1
  THEN RAISE(ABORT, 'invalid validation profile version') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM validation_profiles WHERE id = NEW.profile_id AND workflow_kind = 'issue_triage')
    AND (json_type(NEW.config_json, '$.setup') IS NOT 'array' OR json_array_length(NEW.config_json, '$.setup') != 0
      OR json_type(NEW.config_json, '$.build') IS NOT 'array' OR json_array_length(NEW.config_json, '$.build') != 0
      OR json_type(NEW.config_json, '$.test') IS NOT 'array' OR json_array_length(NEW.config_json, '$.test') != 0
      OR json_type(NEW.config_json, '$.launch') IS NOT 'array' OR json_array_length(NEW.config_json, '$.launch') != 0
      OR json_type(NEW.config_json, '$.cleanup') IS NOT 'array' OR json_array_length(NEW.config_json, '$.cleanup') != 0)
  THEN RAISE(ABORT, 'static issue triage cannot execute commands') END;
END;

CREATE TRIGGER tr_validation_profile_binding_insert_consistency
BEFORE INSERT ON validation_profile_bindings
BEGIN
  SELECT CASE WHEN NEW.version != 1 OR NOT EXISTS (
    SELECT 1 FROM validation_profile_versions AS version JOIN validation_profiles AS profile ON profile.id = version.profile_id
    WHERE version.id = NEW.profile_version_id AND profile.id = NEW.profile_id AND profile.repository_id = NEW.repository_id
  ) THEN RAISE(ABORT, 'invalid validation profile binding') END;
END;

CREATE TRIGGER tr_validation_profile_binding_update_consistency
BEFORE UPDATE ON validation_profile_bindings
BEGIN
  SELECT CASE WHEN NEW.repository_id IS NOT OLD.repository_id OR NEW.profile_id IS NOT OLD.profile_id
    OR NEW.version != OLD.version + 1 OR NOT EXISTS (
      SELECT 1 FROM validation_profile_versions AS version JOIN validation_profiles AS profile ON profile.id = version.profile_id
      WHERE version.id = NEW.profile_version_id AND profile.id = NEW.profile_id AND profile.repository_id = NEW.repository_id
    ) THEN RAISE(ABORT, 'invalid validation profile binding') END;
END;

CREATE TRIGGER tr_validation_profile_binding_history_consistency
BEFORE INSERT ON validation_profile_binding_history
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM validation_profile_bindings WHERE repository_id = NEW.repository_id AND profile_id = NEW.profile_id
      AND profile_version_id = NEW.profile_version_id AND enabled = NEW.enabled AND version = NEW.version
  ) OR NEW.previous_version_id IS NOT (
    SELECT profile_version_id FROM validation_profile_binding_history WHERE repository_id = NEW.repository_id
      AND profile_id = NEW.profile_id AND version = NEW.version - 1
  ) OR NEW.version != COALESCE((SELECT MAX(version) FROM validation_profile_binding_history
    WHERE repository_id = NEW.repository_id AND profile_id = NEW.profile_id), 0) + 1
  THEN RAISE(ABORT, 'invalid validation profile binding history') END;
END;

CREATE TRIGGER tr_prompt_versions_immutable_update BEFORE UPDATE ON prompt_versions BEGIN SELECT RAISE(ABORT, 'published prompt versions are immutable'); END;
CREATE TRIGGER tr_prompt_versions_immutable_delete BEFORE DELETE ON prompt_versions BEGIN SELECT RAISE(ABORT, 'published prompt versions are immutable'); END;
CREATE TRIGGER tr_prompt_templates_immutable_delete BEFORE DELETE ON prompt_templates BEGIN SELECT RAISE(ABORT, 'prompt templates cannot be deleted'); END;
CREATE TRIGGER tr_prompt_bindings_immutable_delete BEFORE DELETE ON prompt_bindings BEGIN SELECT RAISE(ABORT, 'prompt bindings cannot be deleted'); END;
CREATE TRIGGER tr_prompt_binding_history_immutable_update BEFORE UPDATE ON prompt_binding_history BEGIN SELECT RAISE(ABORT, 'prompt binding history is immutable'); END;
CREATE TRIGGER tr_prompt_binding_history_immutable_delete BEFORE DELETE ON prompt_binding_history BEGIN SELECT RAISE(ABORT, 'prompt binding history is immutable'); END;
CREATE TRIGGER tr_validation_profiles_immutable_update BEFORE UPDATE ON validation_profiles BEGIN SELECT RAISE(ABORT, 'validation profile identity is immutable'); END;
CREATE TRIGGER tr_validation_profiles_immutable_delete BEFORE DELETE ON validation_profiles BEGIN SELECT RAISE(ABORT, 'validation profile identity is immutable'); END;
CREATE TRIGGER tr_validation_profile_versions_immutable_update BEFORE UPDATE ON validation_profile_versions BEGIN SELECT RAISE(ABORT, 'published validation profile versions are immutable'); END;
CREATE TRIGGER tr_validation_profile_versions_immutable_delete BEFORE DELETE ON validation_profile_versions BEGIN SELECT RAISE(ABORT, 'published validation profile versions are immutable'); END;
CREATE TRIGGER tr_validation_profile_bindings_immutable_delete BEFORE DELETE ON validation_profile_bindings BEGIN SELECT RAISE(ABORT, 'validation profile bindings cannot be deleted'); END;
CREATE TRIGGER tr_validation_profile_history_immutable_update BEFORE UPDATE ON validation_profile_binding_history BEGIN SELECT RAISE(ABORT, 'validation profile binding history is immutable'); END;
CREATE TRIGGER tr_validation_profile_history_immutable_delete BEFORE DELETE ON validation_profile_binding_history BEGIN SELECT RAISE(ABORT, 'validation profile binding history is immutable'); END;
CREATE TRIGGER tr_prompt_configuration_audit_immutable_update BEFORE UPDATE ON prompt_configuration_audit BEGIN SELECT RAISE(ABORT, 'prompt configuration audit is immutable'); END;
CREATE TRIGGER tr_prompt_configuration_audit_immutable_delete BEFORE DELETE ON prompt_configuration_audit BEGIN SELECT RAISE(ABORT, 'prompt configuration audit is immutable'); END;
CREATE TRIGGER tr_prompt_configuration_bootstrap_immutable_update BEFORE UPDATE ON prompt_configuration_bootstrap BEGIN SELECT RAISE(ABORT, 'prompt bootstrap markers are immutable'); END;
CREATE TRIGGER tr_prompt_configuration_bootstrap_immutable_delete BEFORE DELETE ON prompt_configuration_bootstrap BEGIN SELECT RAISE(ABORT, 'prompt bootstrap markers are immutable'); END;
