CREATE TABLE worker_node_credentials (
  worker_node_id TEXT PRIMARY KEY CHECK (
    length(worker_node_id) BETWEEN 1 AND 128
    AND length(CAST(worker_node_id AS BLOB)) = length(worker_node_id)
    AND substr(worker_node_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND worker_node_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  display_name TEXT NOT NULL CHECK (
    length(display_name) BETWEEN 1 AND 512
    AND length(CAST(display_name AS BLOB)) BETWEEN 1 AND 2048
    AND instr(display_name, char(0)) = 0
  ),
  token_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(token_sha256) = 64
    AND length(CAST(token_sha256 AS BLOB)) = 64
    AND instr(token_sha256, char(0)) = 0
    AND token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  auth_state TEXT NOT NULL CHECK (auth_state IN ('pending', 'active', 'revoked')),
  created_by_issuer TEXT NOT NULL CHECK (
    length(created_by_issuer) BETWEEN 1 AND 2048
    AND length(CAST(created_by_issuer AS BLOB)) BETWEEN 1 AND 8192
    AND instr(created_by_issuer, char(0)) = 0
  ),
  created_by_subject TEXT NOT NULL CHECK (
    length(created_by_subject) BETWEEN 1 AND 512
    AND length(CAST(created_by_subject AS BLOB)) BETWEEN 1 AND 2048
    AND instr(created_by_subject, char(0)) = 0
  ),
  updated_by_issuer TEXT NOT NULL CHECK (
    length(updated_by_issuer) BETWEEN 1 AND 2048
    AND length(CAST(updated_by_issuer AS BLOB)) BETWEEN 1 AND 8192
    AND instr(updated_by_issuer, char(0)) = 0
  ),
  updated_by_subject TEXT NOT NULL CHECK (
    length(updated_by_subject) BETWEEN 1 AND 512
    AND length(CAST(updated_by_subject AS BLOB)) BETWEEN 1 AND 2048
    AND instr(updated_by_subject, char(0)) = 0
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  activated_at TEXT,
  rotated_at TEXT,
  revoked_at TEXT,
  CHECK (updated_at >= created_at),
  CHECK (activated_at IS NULL OR activated_at >= created_at),
  CHECK (rotated_at IS NULL OR rotated_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (
    (auth_state = 'pending' AND activated_at IS NULL AND revoked_at IS NULL)
    OR (auth_state = 'active' AND activated_at IS NOT NULL AND revoked_at IS NULL)
    OR (auth_state = 'revoked' AND revoked_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX ix_worker_node_credentials_auth_state
  ON worker_node_credentials (auth_state, worker_node_id);
