CREATE TABLE repository_operator_grants (
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  principal_issuer TEXT NOT NULL CHECK (length(principal_issuer) BETWEEN 1 AND 2048 AND instr(principal_issuer, char(0)) = 0),
  principal_subject TEXT NOT NULL CHECK (length(principal_subject) BETWEEN 1 AND 512 AND instr(principal_subject, char(0)) = 0),
  role TEXT CHECK (role IN ('viewer', 'reviewer', 'maintainer', 'admin')),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (updated_at >= created_at),
  updated_by_issuer TEXT NOT NULL,
  updated_by_subject TEXT NOT NULL,
  PRIMARY KEY (repository_id, principal_issuer, principal_subject)
) STRICT;

CREATE INDEX ix_repository_operator_grants_principal
  ON repository_operator_grants(principal_issuer, principal_subject, repository_id)
  WHERE role IS NOT NULL;
CREATE INDEX ix_repository_operator_grants_administrators
  ON repository_operator_grants(repository_id, role);

CREATE TABLE repository_operator_access_audit (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  change_id TEXT NOT NULL CHECK (length(change_id) BETWEEN 1 AND 128),
  principal_issuer TEXT NOT NULL CHECK (length(principal_issuer) BETWEEN 1 AND 2048 AND instr(principal_issuer, char(0)) = 0),
  principal_subject TEXT NOT NULL CHECK (length(principal_subject) BETWEEN 1 AND 512 AND instr(principal_subject, char(0)) = 0),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  previous_role TEXT CHECK (previous_role IN ('viewer', 'reviewer', 'maintainer', 'admin')),
  role TEXT CHECK (role IN ('viewer', 'reviewer', 'maintainer', 'admin')),
  previous_version INTEGER NOT NULL CHECK (previous_version BETWEEN 0 AND 9007199254740990),
  version INTEGER NOT NULL CHECK (version = previous_version + 1),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2048 AND instr(reason, char(0)) = 0),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  UNIQUE (repository_id, change_id),
  UNIQUE (repository_id, principal_issuer, principal_subject, version)
) STRICT;

CREATE INDEX ix_repository_operator_access_audit_history
  ON repository_operator_access_audit(repository_id, created_at DESC, id DESC);

CREATE TRIGGER tr_repository_operator_access_audit_insert
BEFORE INSERT ON repository_operator_access_audit
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM repository_operator_access_audit
    WHERE id = NEW.id OR (repository_id = NEW.repository_id AND change_id = NEW.change_id)
  ) THEN RAISE(ABORT, 'repository access receipts cannot be replaced') END;
  SELECT CASE WHEN
    (NEW.previous_version = 0 AND (
      NEW.previous_role IS NOT NULL OR EXISTS (
        SELECT 1 FROM repository_operator_grants WHERE repository_id = NEW.repository_id
          AND principal_issuer = NEW.principal_issuer AND principal_subject = NEW.principal_subject
      )
    )) OR (NEW.previous_version > 0 AND NOT EXISTS (
      SELECT 1 FROM repository_operator_grants WHERE repository_id = NEW.repository_id
        AND principal_issuer = NEW.principal_issuer AND principal_subject = NEW.principal_subject
        AND version = NEW.previous_version AND role IS NEW.previous_role AND updated_at <= NEW.created_at
    )) THEN RAISE(ABORT, 'repository access receipt does not follow the current grant') END;
END;

CREATE TRIGGER tr_repository_operator_grant_insert BEFORE INSERT ON repository_operator_grants
WHEN EXISTS (
  SELECT 1 FROM repository_operator_grants WHERE repository_id = NEW.repository_id
    AND principal_issuer = NEW.principal_issuer AND principal_subject = NEW.principal_subject
) OR NOT EXISTS (
  SELECT 1 FROM repository_operator_access_audit WHERE repository_id = NEW.repository_id
    AND principal_issuer = NEW.principal_issuer AND principal_subject = NEW.principal_subject
    AND previous_version = 0 AND version = NEW.version AND role IS NEW.role
    AND created_at = NEW.created_at AND created_at = NEW.updated_at
    AND actor_issuer = NEW.updated_by_issuer AND actor_subject = NEW.updated_by_subject
)
BEGIN SELECT RAISE(ABORT, 'repository grants require their immutable access receipt'); END;

CREATE TRIGGER tr_repository_operator_grant_update BEFORE UPDATE ON repository_operator_grants
WHEN NEW.repository_id IS NOT OLD.repository_id
  OR NEW.principal_issuer IS NOT OLD.principal_issuer
  OR NEW.principal_subject IS NOT OLD.principal_subject
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.version != OLD.version + 1
  OR NOT EXISTS (
    SELECT 1 FROM repository_operator_access_audit WHERE repository_id = NEW.repository_id
      AND principal_issuer = NEW.principal_issuer AND principal_subject = NEW.principal_subject
      AND previous_version = OLD.version AND previous_role IS OLD.role
      AND version = NEW.version AND role IS NEW.role AND created_at = NEW.updated_at
      AND actor_issuer = NEW.updated_by_issuer AND actor_subject = NEW.updated_by_subject
  )
BEGIN SELECT RAISE(ABORT, 'repository grants require their next immutable access receipt'); END;

CREATE TRIGGER tr_repository_operator_access_apply AFTER INSERT ON repository_operator_access_audit
BEGIN
  INSERT INTO repository_operator_grants (
    repository_id, principal_issuer, principal_subject, role, version,
    created_at, updated_at, updated_by_issuer, updated_by_subject
  ) SELECT NEW.repository_id, NEW.principal_issuer, NEW.principal_subject, NEW.role, NEW.version,
    NEW.created_at, NEW.created_at, NEW.actor_issuer, NEW.actor_subject
    WHERE NEW.previous_version = 0;
  UPDATE repository_operator_grants SET role = NEW.role, version = NEW.version,
    updated_at = NEW.created_at, updated_by_issuer = NEW.actor_issuer, updated_by_subject = NEW.actor_subject
    WHERE NEW.previous_version > 0 AND repository_id = NEW.repository_id
      AND principal_issuer = NEW.principal_issuer AND principal_subject = NEW.principal_subject;
END;

CREATE TRIGGER tr_repository_operator_grants_no_delete BEFORE DELETE ON repository_operator_grants
BEGIN SELECT RAISE(ABORT, 'repository grant revocations must retain a tombstone'); END;
CREATE TRIGGER tr_repository_operator_access_audit_no_update BEFORE UPDATE ON repository_operator_access_audit
BEGIN SELECT RAISE(ABORT, 'repository access audit is immutable'); END;
CREATE TRIGGER tr_repository_operator_access_audit_no_delete BEFORE DELETE ON repository_operator_access_audit
BEGIN SELECT RAISE(ABORT, 'repository access audit is immutable'); END;
