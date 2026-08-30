CREATE TABLE github_polling_projections (
  projection_key TEXT PRIMARY KEY,
  github_repository_id INTEGER NOT NULL CHECK (github_repository_id > 0),
  repository_full_name TEXT NOT NULL COLLATE NOCASE,
  reviewer_github_user_id INTEGER NOT NULL CHECK (reviewer_github_user_id > 0),
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
  updated_at TEXT NOT NULL,
  UNIQUE (github_repository_id, reviewer_github_user_id)
) STRICT;

CREATE INDEX ix_github_polling_projections_updated
  ON github_polling_projections (updated_at DESC);
