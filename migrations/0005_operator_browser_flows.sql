CREATE TABLE operator_browser_flows (
  browser_sha256 TEXT PRIMARY KEY CHECK (
    length(browser_sha256) = 64
    AND browser_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX ix_operator_browser_flows_expires_at
  ON operator_browser_flows (expires_at);

ALTER TABLE operator_login_transactions
  ADD COLUMN browser_sha256 TEXT
  REFERENCES operator_browser_flows (browser_sha256) ON DELETE CASCADE;

ALTER TABLE operator_login_transactions
  ADD COLUMN browser_generation INTEGER
  CHECK (
    browser_generation IS NULL
    OR browser_generation BETWEEN 1 AND 9007199254740991
  );

CREATE INDEX ix_operator_login_transactions_browser
  ON operator_login_transactions (browser_sha256, browser_generation, expires_at);

CREATE UNIQUE INDEX ux_operator_login_transactions_browser
  ON operator_login_transactions (browser_sha256)
  WHERE browser_sha256 IS NOT NULL;

ALTER TABLE operator_sessions
  ADD COLUMN browser_sha256 TEXT
  REFERENCES operator_browser_flows (browser_sha256) ON DELETE CASCADE;

ALTER TABLE operator_sessions
  ADD COLUMN browser_generation INTEGER
  CHECK (
    browser_generation IS NULL
    OR browser_generation BETWEEN 1 AND 9007199254740991
  );

CREATE INDEX ix_operator_sessions_browser
  ON operator_sessions (browser_sha256, browser_generation, expires_at);

CREATE UNIQUE INDEX ux_operator_sessions_browser
  ON operator_sessions (browser_sha256)
  WHERE browser_sha256 IS NOT NULL;

CREATE TRIGGER tr_operator_login_transaction_browser_pair_insert
BEFORE INSERT ON operator_login_transactions
WHEN (NEW.browser_sha256 IS NULL) <> (NEW.browser_generation IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'operator login browser binding pair mismatch');
END;

CREATE TRIGGER tr_operator_login_transaction_browser_pair_update
BEFORE UPDATE OF browser_sha256, browser_generation ON operator_login_transactions
WHEN (NEW.browser_sha256 IS NULL) <> (NEW.browser_generation IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'operator login browser binding pair mismatch');
END;

CREATE TRIGGER tr_operator_session_browser_pair_insert
BEFORE INSERT ON operator_sessions
WHEN (NEW.browser_sha256 IS NULL) <> (NEW.browser_generation IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'operator session browser binding pair mismatch');
END;

CREATE TRIGGER tr_operator_session_browser_pair_update
BEFORE UPDATE OF browser_sha256, browser_generation ON operator_sessions
WHEN (NEW.browser_sha256 IS NULL) <> (NEW.browser_generation IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'operator session browser binding pair mismatch');
END;

CREATE TABLE operator_auth_clock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_observed_at TEXT NOT NULL
) STRICT;

INSERT INTO operator_auth_clock (singleton, last_observed_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
