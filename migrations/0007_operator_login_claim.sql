ALTER TABLE operator_login_transactions
  ADD COLUMN claimed_at TEXT
  CHECK (
    claimed_at IS NULL
    OR (claimed_at >= created_at AND claimed_at < expires_at)
  );
