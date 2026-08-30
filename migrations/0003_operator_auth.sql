CREATE TABLE operator_login_transactions (
  token_sha256 TEXT PRIMARY KEY CHECK (
    length(token_sha256) = 64
    AND token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX ix_operator_login_transactions_expires_at
  ON operator_login_transactions (expires_at);

CREATE TABLE operator_sessions (
  token_sha256 TEXT PRIMARY KEY CHECK (
    length(token_sha256) = 64
    AND token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 512),
  email TEXT CHECK (email IS NULL OR length(email) BETWEEN 1 AND 320),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX ix_operator_sessions_expires_at
  ON operator_sessions (expires_at);

CREATE INDEX ix_operator_sessions_identity
  ON operator_sessions (issuer, subject, expires_at DESC);
