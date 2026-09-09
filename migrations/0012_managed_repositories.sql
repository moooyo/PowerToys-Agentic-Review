CREATE TABLE managed_repositories (
  id TEXT PRIMARY KEY,
  github_repository_id INTEGER NOT NULL UNIQUE CHECK (github_repository_id > 0),
  full_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL CHECK (version > 0),
  reviewer_github_user_id INTEGER CHECK (reviewer_github_user_id > 0),
  reviewer_github_login TEXT,
  authorization_policy_json TEXT CHECK (authorization_policy_json IS NULL OR json_valid(authorization_policy_json)),
  connection_status TEXT NOT NULL CHECK (connection_status IN ('unknown', 'ready', 'error')),
  connection_message TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  configuration_source TEXT NOT NULL CHECK (configuration_source IN ('discovered', 'bootstrap', 'operator')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((reviewer_github_user_id IS NULL) = (reviewer_github_login IS NULL))
) STRICT;

INSERT INTO managed_repositories (
  id, github_repository_id, full_name, enabled, version, connection_status,
  metadata_json, configuration_source, created_at, updated_at
)
SELECT id, github_repository_id, full_name, 0, 1, 'unknown', snapshot_json,
  'discovered', created_at, updated_at
FROM repositories;

CREATE INDEX ix_managed_repositories_name ON managed_repositories (full_name, id);

CREATE TABLE repository_configuration_bootstrap (
  bootstrap_key TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
) STRICT;

CREATE TABLE repository_configuration_audit (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  actor_issuer TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  version INTEGER NOT NULL,
  configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
  created_at TEXT NOT NULL
) STRICT;

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
