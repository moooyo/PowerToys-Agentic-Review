-- Preserve every historical audit value while removing physical rowid replacement paths.
-- The migration runner owns the transaction; foreign keys remain enabled throughout.
CREATE TABLE repository_configuration_audit_next (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  actor_issuer TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  version INTEGER NOT NULL,
  configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
  created_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

INSERT INTO repository_configuration_audit_next (
  id, repository_id, action, actor_issuer, actor_subject, version, configuration_json, created_at
)
SELECT id, repository_id, action, actor_issuer, actor_subject, version, configuration_json, created_at
FROM repository_configuration_audit;

DROP TABLE repository_configuration_audit;
ALTER TABLE repository_configuration_audit_next RENAME TO repository_configuration_audit;

CREATE INDEX ix_repository_configuration_audit_repository
  ON repository_configuration_audit (repository_id, created_at, id);

CREATE TRIGGER repository_configuration_audit_no_update
BEFORE UPDATE ON repository_configuration_audit BEGIN
  SELECT RAISE(ABORT, 'Repository configuration audit is immutable.');
END;

CREATE TRIGGER repository_configuration_audit_no_delete
BEFORE DELETE ON repository_configuration_audit BEGIN
  SELECT RAISE(ABORT, 'Repository configuration audit is immutable.');
END;

CREATE TRIGGER repository_configuration_audit_no_replace
BEFORE INSERT ON repository_configuration_audit
WHEN EXISTS (SELECT 1 FROM repository_configuration_audit WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'Repository configuration audit cannot be replaced.');
END;

CREATE TABLE prompt_configuration_audit_next (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('template_created', 'draft_saved', 'prompt_published', 'prompt_bound', 'profile_published', 'profile_bound', 'bootstrap_registered')),
  entity_id TEXT NOT NULL,
  repository_id TEXT REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  created_at TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object' AND length(CAST(detail_json AS BLOB)) <= 16384)
) STRICT, WITHOUT ROWID;

INSERT INTO prompt_configuration_audit_next (
  id, action, entity_id, repository_id, actor_issuer, actor_subject, created_at, detail_json
)
SELECT id, action, entity_id, repository_id, actor_issuer, actor_subject, created_at, detail_json
FROM prompt_configuration_audit;

DROP TABLE prompt_configuration_audit;
ALTER TABLE prompt_configuration_audit_next RENAME TO prompt_configuration_audit;

CREATE INDEX ix_prompt_configuration_audit_entity ON prompt_configuration_audit(entity_id, created_at DESC, id);
CREATE INDEX ix_prompt_configuration_audit_repository
  ON prompt_configuration_audit(repository_id, created_at DESC, id DESC);

CREATE TRIGGER tr_prompt_configuration_audit_immutable_update BEFORE UPDATE ON prompt_configuration_audit BEGIN SELECT RAISE(ABORT, 'prompt configuration audit is immutable'); END;
CREATE TRIGGER tr_prompt_configuration_audit_immutable_delete BEFORE DELETE ON prompt_configuration_audit BEGIN SELECT RAISE(ABORT, 'prompt configuration audit is immutable'); END;

CREATE TRIGGER tr_prompt_configuration_audit_no_replace
BEFORE INSERT ON prompt_configuration_audit
WHEN EXISTS (SELECT 1 FROM prompt_configuration_audit WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'prompt configuration audit cannot be replaced');
END;
