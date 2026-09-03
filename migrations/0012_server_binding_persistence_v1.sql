CREATE TABLE server_binding_receipt_issuer (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  authority_schema_version INTEGER NOT NULL CHECK (authority_schema_version = 1),
  issuer TEXT NOT NULL CHECK (
    issuer = 'agentic-review-server-enrollment-binding-authority-v1'
  ),
  receipt_profile_id TEXT NOT NULL CHECK (
    receipt_profile_id = 'agentic-review-server-binding-receipt-v1'
  ),
  active_status_profile_id TEXT NOT NULL CHECK (
    active_status_profile_id = 'agentic-review-server-binding-active-status-v1'
  ),
  signature_algorithm TEXT NOT NULL CHECK (
    signature_algorithm = 'ecdsa-p256-sha256-p1363-low-s'
  ),
  issuer_key_id TEXT NOT NULL UNIQUE CHECK (
    length(issuer_key_id) = 64
    AND length(CAST(issuer_key_id AS BLOB)) = 64
    AND instr(issuer_key_id, char(0)) = 0
    AND issuer_key_id NOT GLOB '*[^0-9a-f]*'
  ),
  initialized_at TEXT NOT NULL CHECK (
    length(initialized_at) = 24
    AND length(CAST(initialized_at AS BLOB)) = 24
    AND initialized_at GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND substr(initialized_at, 1, 4) <> '0000'
    AND CAST(substr(initialized_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    AND CAST(substr(initialized_at, 9, 2) AS INTEGER) BETWEEN 1 AND CASE
      CAST(substr(initialized_at, 6, 2) AS INTEGER)
      WHEN 1 THEN 31
      WHEN 2 THEN CASE
        WHEN CAST(substr(initialized_at, 1, 4) AS INTEGER) % 4 = 0
          AND (
            CAST(substr(initialized_at, 1, 4) AS INTEGER) % 100 <> 0
            OR CAST(substr(initialized_at, 1, 4) AS INTEGER) % 400 = 0
          )
        THEN 29
        ELSE 28
      END
      WHEN 3 THEN 31
      WHEN 4 THEN 30
      WHEN 5 THEN 31
      WHEN 6 THEN 30
      WHEN 7 THEN 31
      WHEN 8 THEN 31
      WHEN 9 THEN 30
      WHEN 10 THEN 31
      WHEN 11 THEN 30
      WHEN 12 THEN 31
    END
    AND CAST(substr(initialized_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(initialized_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(initialized_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  )
) STRICT;

CREATE TABLE server_binding_authorizations (
  authorization_id TEXT PRIMARY KEY CHECK (
    length(authorization_id) = 36
    AND length(CAST(authorization_id AS BLOB)) = 36
    AND authorization_id GLOB
      '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  request_id TEXT NOT NULL UNIQUE CHECK (
    length(request_id) = 36
    AND length(CAST(request_id AS BLOB)) = 36
    AND request_id GLOB
      '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  token_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(token_sha256) = 64
    AND length(CAST(token_sha256 AS BLOB)) = 64
    AND instr(token_sha256, char(0)) = 0
    AND token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  operator_issuer TEXT NOT NULL CHECK (
    length(operator_issuer) >= 1
    AND length(CAST(operator_issuer AS BLOB)) BETWEEN 1 AND 2048
    AND json_valid(json_quote(operator_issuer)) IS 1
    AND json_extract(json_quote(operator_issuer), '$') IS operator_issuer
    AND instr(operator_issuer, char(0)) = 0
    AND instr(operator_issuer, char(1)) = 0
    AND instr(operator_issuer, char(2)) = 0
    AND instr(operator_issuer, char(3)) = 0
    AND instr(operator_issuer, char(4)) = 0
    AND instr(operator_issuer, char(5)) = 0
    AND instr(operator_issuer, char(6)) = 0
    AND instr(operator_issuer, char(7)) = 0
    AND instr(operator_issuer, char(8)) = 0
    AND instr(operator_issuer, char(9)) = 0
    AND instr(operator_issuer, char(10)) = 0
    AND instr(operator_issuer, char(11)) = 0
    AND instr(operator_issuer, char(12)) = 0
    AND instr(operator_issuer, char(13)) = 0
    AND instr(operator_issuer, char(14)) = 0
    AND instr(operator_issuer, char(15)) = 0
    AND instr(operator_issuer, char(16)) = 0
    AND instr(operator_issuer, char(17)) = 0
    AND instr(operator_issuer, char(18)) = 0
    AND instr(operator_issuer, char(19)) = 0
    AND instr(operator_issuer, char(20)) = 0
    AND instr(operator_issuer, char(21)) = 0
    AND instr(operator_issuer, char(22)) = 0
    AND instr(operator_issuer, char(23)) = 0
    AND instr(operator_issuer, char(24)) = 0
    AND instr(operator_issuer, char(25)) = 0
    AND instr(operator_issuer, char(26)) = 0
    AND instr(operator_issuer, char(27)) = 0
    AND instr(operator_issuer, char(28)) = 0
    AND instr(operator_issuer, char(29)) = 0
    AND instr(operator_issuer, char(30)) = 0
    AND instr(operator_issuer, char(31)) = 0
    AND instr(operator_issuer, char(127)) = 0
  ),
  operator_subject TEXT NOT NULL CHECK (
    length(operator_subject) >= 1
    AND length(CAST(operator_subject AS BLOB)) BETWEEN 1 AND 512
    AND json_valid(json_quote(operator_subject)) IS 1
    AND json_extract(json_quote(operator_subject), '$') IS operator_subject
    AND instr(operator_subject, char(0)) = 0
    AND instr(operator_subject, char(1)) = 0
    AND instr(operator_subject, char(2)) = 0
    AND instr(operator_subject, char(3)) = 0
    AND instr(operator_subject, char(4)) = 0
    AND instr(operator_subject, char(5)) = 0
    AND instr(operator_subject, char(6)) = 0
    AND instr(operator_subject, char(7)) = 0
    AND instr(operator_subject, char(8)) = 0
    AND instr(operator_subject, char(9)) = 0
    AND instr(operator_subject, char(10)) = 0
    AND instr(operator_subject, char(11)) = 0
    AND instr(operator_subject, char(12)) = 0
    AND instr(operator_subject, char(13)) = 0
    AND instr(operator_subject, char(14)) = 0
    AND instr(operator_subject, char(15)) = 0
    AND instr(operator_subject, char(16)) = 0
    AND instr(operator_subject, char(17)) = 0
    AND instr(operator_subject, char(18)) = 0
    AND instr(operator_subject, char(19)) = 0
    AND instr(operator_subject, char(20)) = 0
    AND instr(operator_subject, char(21)) = 0
    AND instr(operator_subject, char(22)) = 0
    AND instr(operator_subject, char(23)) = 0
    AND instr(operator_subject, char(24)) = 0
    AND instr(operator_subject, char(25)) = 0
    AND instr(operator_subject, char(26)) = 0
    AND instr(operator_subject, char(27)) = 0
    AND instr(operator_subject, char(28)) = 0
    AND instr(operator_subject, char(29)) = 0
    AND instr(operator_subject, char(30)) = 0
    AND instr(operator_subject, char(31)) = 0
    AND instr(operator_subject, char(127)) = 0
  ),
  worker_node_id TEXT NOT NULL CHECK (
    length(worker_node_id) BETWEEN 1 AND 128
    AND length(CAST(worker_node_id AS BLOB)) = length(worker_node_id)
    AND substr(worker_node_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND worker_node_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  installation_id TEXT NOT NULL CHECK (
    length(installation_id) BETWEEN 1 AND 128
    AND length(CAST(installation_id AS BLOB)) = length(installation_id)
    AND substr(installation_id, 1, 1) GLOB '[a-z0-9]'
    AND installation_id NOT GLOB '*[^a-z0-9._+-]*'
    AND substr(installation_id, -1, 1) <> '.'
    AND (
      CASE
        WHEN instr(installation_id, '.') = 0 THEN installation_id
        ELSE substr(installation_id, 1, instr(installation_id, '.') - 1)
      END
    ) NOT IN ('con', 'prn', 'aux', 'nul', 'conin$', 'conout$', 'clock$')
    AND NOT (
      length(
        CASE
          WHEN instr(installation_id, '.') = 0 THEN installation_id
          ELSE substr(installation_id, 1, instr(installation_id, '.') - 1)
        END
      ) = 4
      AND (
        CASE
          WHEN instr(installation_id, '.') = 0 THEN installation_id
          ELSE substr(installation_id, 1, instr(installation_id, '.') - 1)
        END
      ) GLOB 'com[1-9]'
    )
    AND NOT (
      length(
        CASE
          WHEN instr(installation_id, '.') = 0 THEN installation_id
          ELSE substr(installation_id, 1, instr(installation_id, '.') - 1)
        END
      ) = 4
      AND (
        CASE
          WHEN instr(installation_id, '.') = 0 THEN installation_id
          ELSE substr(installation_id, 1, instr(installation_id, '.') - 1)
        END
      ) GLOB 'lpt[1-9]'
    )
  ),
  enrollment_generation INTEGER NOT NULL CHECK (enrollment_generation = 1),
  expected_certificate_der_sha256 TEXT NOT NULL CHECK (
    length(expected_certificate_der_sha256) = 64
    AND length(CAST(expected_certificate_der_sha256 AS BLOB)) = 64
    AND instr(expected_certificate_der_sha256, char(0)) = 0
    AND expected_certificate_der_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  issuer_key_id TEXT NOT NULL CHECK (
    length(issuer_key_id) = 64
    AND length(CAST(issuer_key_id AS BLOB)) = 64
    AND instr(issuer_key_id, char(0)) = 0
    AND issuer_key_id NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND length(CAST(created_at AS BLOB)) = 24
    AND created_at GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND substr(created_at, 1, 4) <> '0000'
    AND CAST(substr(created_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    AND CAST(substr(created_at, 9, 2) AS INTEGER) BETWEEN 1 AND CASE
      CAST(substr(created_at, 6, 2) AS INTEGER)
      WHEN 1 THEN 31
      WHEN 2 THEN CASE
        WHEN CAST(substr(created_at, 1, 4) AS INTEGER) % 4 = 0
          AND (
            CAST(substr(created_at, 1, 4) AS INTEGER) % 100 <> 0
            OR CAST(substr(created_at, 1, 4) AS INTEGER) % 400 = 0
          )
        THEN 29
        ELSE 28
      END
      WHEN 3 THEN 31
      WHEN 4 THEN 30
      WHEN 5 THEN 31
      WHEN 6 THEN 30
      WHEN 7 THEN 31
      WHEN 8 THEN 31
      WHEN 9 THEN 30
      WHEN 10 THEN 31
      WHEN 11 THEN 30
      WHEN 12 THEN 31
    END
    AND CAST(substr(created_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(created_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(created_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  ),
  expires_at TEXT NOT NULL CHECK (
    length(expires_at) = 24
    AND length(CAST(expires_at AS BLOB)) = 24
    AND expires_at GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND substr(expires_at, 1, 4) <> '0000'
    AND CAST(substr(expires_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    AND CAST(substr(expires_at, 9, 2) AS INTEGER) BETWEEN 1 AND CASE
      CAST(substr(expires_at, 6, 2) AS INTEGER)
      WHEN 1 THEN 31
      WHEN 2 THEN CASE
        WHEN CAST(substr(expires_at, 1, 4) AS INTEGER) % 4 = 0
          AND (
            CAST(substr(expires_at, 1, 4) AS INTEGER) % 100 <> 0
            OR CAST(substr(expires_at, 1, 4) AS INTEGER) % 400 = 0
          )
        THEN 29
        ELSE 28
      END
      WHEN 3 THEN 31
      WHEN 4 THEN 30
      WHEN 5 THEN 31
      WHEN 6 THEN 30
      WHEN 7 THEN 31
      WHEN 8 THEN 31
      WHEN 9 THEN 30
      WHEN 10 THEN 31
      WHEN 11 THEN 30
      WHEN 12 THEN 31
    END
    AND CAST(substr(expires_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(expires_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(expires_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  ),
  consumed_binding_id TEXT CHECK (
    consumed_binding_id IS NULL
    OR (
      length(consumed_binding_id) = 36
      AND length(CAST(consumed_binding_id AS BLOB)) = 36
      AND consumed_binding_id GLOB
        '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    )
  ),
  consumed_issuance_request_sha256 TEXT CHECK (
    consumed_issuance_request_sha256 IS NULL
    OR (
      length(consumed_issuance_request_sha256) = 64
      AND length(CAST(consumed_issuance_request_sha256 AS BLOB)) = 64
      AND instr(consumed_issuance_request_sha256, char(0)) = 0
      AND consumed_issuance_request_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  consumed_at TEXT CHECK (
    consumed_at IS NULL
    OR (
      length(consumed_at) = 24
      AND length(CAST(consumed_at AS BLOB)) = 24
      AND consumed_at GLOB
        '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND substr(consumed_at, 1, 4) <> '0000'
      AND CAST(substr(consumed_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
      AND CAST(substr(consumed_at, 9, 2) AS INTEGER) BETWEEN 1 AND CASE
        CAST(substr(consumed_at, 6, 2) AS INTEGER)
        WHEN 1 THEN 31
        WHEN 2 THEN CASE
          WHEN CAST(substr(consumed_at, 1, 4) AS INTEGER) % 4 = 0
            AND (
              CAST(substr(consumed_at, 1, 4) AS INTEGER) % 100 <> 0
              OR CAST(substr(consumed_at, 1, 4) AS INTEGER) % 400 = 0
            )
          THEN 29
          ELSE 28
        END
        WHEN 3 THEN 31
        WHEN 4 THEN 30
        WHEN 5 THEN 31
        WHEN 6 THEN 30
        WHEN 7 THEN 31
        WHEN 8 THEN 31
        WHEN 9 THEN 30
        WHEN 10 THEN 31
        WHEN 11 THEN 30
        WHEN 12 THEN 31
      END
      AND CAST(substr(consumed_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
      AND CAST(substr(consumed_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
      AND CAST(substr(consumed_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
    )
  ),
  FOREIGN KEY (issuer_key_id)
    REFERENCES server_binding_receipt_issuer (issuer_key_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (consumed_binding_id)
    REFERENCES server_bindings (binding_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    authorization_id,
    consumed_binding_id,
    consumed_issuance_request_sha256
  ) REFERENCES server_bindings (
    authorization_id,
    binding_id,
    issuance_request_sha256
  ) ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (
    authorization_id,
    consumed_binding_id,
    consumed_issuance_request_sha256
  ),
  UNIQUE (
    authorization_id,
    request_id,
    issuer_key_id,
    worker_node_id,
    installation_id,
    enrollment_generation,
    expected_certificate_der_sha256
  ),
  CHECK (expires_at > created_at),
  CHECK (
    (consumed_binding_id IS NULL
      AND consumed_issuance_request_sha256 IS NULL
      AND consumed_at IS NULL)
    OR (consumed_binding_id IS NOT NULL
      AND consumed_issuance_request_sha256 IS NOT NULL
      AND consumed_at IS NOT NULL
      AND consumed_at < expires_at)
  )
) STRICT;

CREATE TABLE server_bindings (
  binding_id TEXT PRIMARY KEY CHECK (
    length(binding_id) = 36
    AND length(CAST(binding_id AS BLOB)) = 36
    AND binding_id GLOB
      '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  binding_revision INTEGER NOT NULL CHECK (binding_revision = 1),
  authorization_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL CHECK (
    length(request_id) = 36
    AND length(CAST(request_id AS BLOB)) = 36
    AND request_id GLOB
      '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  issuance_request_sha256 TEXT NOT NULL CHECK (
    length(issuance_request_sha256) = 64
    AND length(CAST(issuance_request_sha256 AS BLOB)) = 64
    AND instr(issuance_request_sha256, char(0)) = 0
    AND issuance_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  worker_node_id TEXT NOT NULL CHECK (
    length(worker_node_id) BETWEEN 1 AND 128
    AND length(CAST(worker_node_id AS BLOB)) = length(worker_node_id)
    AND substr(worker_node_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND worker_node_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  installation_id TEXT NOT NULL CHECK (
    length(installation_id) BETWEEN 1 AND 128
    AND length(CAST(installation_id AS BLOB)) = length(installation_id)
    AND substr(installation_id, 1, 1) GLOB '[a-z0-9]'
    AND installation_id NOT GLOB '*[^a-z0-9._+-]*'
    AND substr(installation_id, -1, 1) <> '.'
    AND (
      CASE
        WHEN instr(installation_id, '.') = 0 THEN installation_id
        ELSE substr(installation_id, 1, instr(installation_id, '.') - 1)
      END
    ) NOT IN ('con', 'prn', 'aux', 'nul', 'conin$', 'conout$', 'clock$')
    AND NOT (
      length(
        CASE
          WHEN instr(installation_id, '.') = 0 THEN installation_id
          ELSE substr(installation_id, 1, instr(installation_id, '.') - 1)
        END
      ) = 4
      AND (
        CASE
          WHEN instr(installation_id, '.') = 0 THEN installation_id
          ELSE substr(installation_id, 1, instr(installation_id, '.') - 1)
        END
      ) GLOB 'com[1-9]'
    )
    AND NOT (
      length(
        CASE
          WHEN instr(installation_id, '.') = 0 THEN installation_id
          ELSE substr(installation_id, 1, instr(installation_id, '.') - 1)
        END
      ) = 4
      AND (
        CASE
          WHEN instr(installation_id, '.') = 0 THEN installation_id
          ELSE substr(installation_id, 1, instr(installation_id, '.') - 1)
        END
      ) GLOB 'lpt[1-9]'
    )
  ),
  enrollment_generation INTEGER NOT NULL CHECK (enrollment_generation = 1),
  certificate_der_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(certificate_der_sha256) = 64
    AND length(CAST(certificate_der_sha256 AS BLOB)) = 64
    AND instr(certificate_der_sha256, char(0)) = 0
    AND certificate_der_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  issuer_key_id TEXT NOT NULL CHECK (
    length(issuer_key_id) = 64
    AND length(CAST(issuer_key_id AS BLOB)) = 64
    AND instr(issuer_key_id, char(0)) = 0
    AND issuer_key_id NOT GLOB '*[^0-9a-f]*'
  ),
  phase TEXT NOT NULL CHECK (
    phase IN ('signing_pending', 'reserved', 'active', 'revoked')
  ),
  bound_at TEXT NOT NULL CHECK (
    length(bound_at) = 24
    AND length(CAST(bound_at AS BLOB)) = 24
    AND bound_at GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND substr(bound_at, 1, 4) <> '0000'
    AND CAST(substr(bound_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    AND CAST(substr(bound_at, 9, 2) AS INTEGER) BETWEEN 1 AND CASE
      CAST(substr(bound_at, 6, 2) AS INTEGER)
      WHEN 1 THEN 31
      WHEN 2 THEN CASE
        WHEN CAST(substr(bound_at, 1, 4) AS INTEGER) % 4 = 0
          AND (
            CAST(substr(bound_at, 1, 4) AS INTEGER) % 100 <> 0
            OR CAST(substr(bound_at, 1, 4) AS INTEGER) % 400 = 0
          )
        THEN 29
        ELSE 28
      END
      WHEN 3 THEN 31
      WHEN 4 THEN 30
      WHEN 5 THEN 31
      WHEN 6 THEN 30
      WHEN 7 THEN 31
      WHEN 8 THEN 31
      WHEN 9 THEN 30
      WHEN 10 THEN 31
      WHEN 11 THEN 30
      WHEN 12 THEN 31
    END
    AND CAST(substr(bound_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(bound_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(bound_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  ),
  statement_json TEXT NOT NULL CHECK (
    length(CAST(statement_json AS BLOB)) BETWEEN 1 AND 4096
    AND length(CAST(statement_json AS BLOB)) = length(statement_json)
    AND instr(statement_json, char(0)) = 0
    AND json_valid(statement_json)
    AND json_type(statement_json) IS 'object'
    AND statement_json =
      '{"bindingId":"' || binding_id ||
      '","bindingRevision":1,"boundAt":"' || bound_at ||
      '","certificateDerSha256":"' || certificate_der_sha256 ||
      '","enrollmentGeneration":1,"installationId":"' || installation_id ||
      '","statementType":"durable-binding-created","workerNodeId":"' ||
      worker_node_id || '"}'
  ),
  statement_document_sha256 TEXT NOT NULL CHECK (
    length(statement_document_sha256) = 64
    AND length(CAST(statement_document_sha256 AS BLOB)) = 64
    AND instr(statement_document_sha256, char(0)) = 0
    AND statement_document_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_json TEXT CHECK (
    receipt_json IS NULL
    OR (
      length(CAST(receipt_json AS BLOB)) BETWEEN 1 AND 4096
      AND length(CAST(receipt_json AS BLOB)) = length(receipt_json)
      AND instr(receipt_json, char(0)) = 0
      AND json_valid(receipt_json)
      AND json_type(receipt_json) IS 'object'
      AND json_type(receipt_json, '$.signature') IS 'text'
      AND length(json_extract(receipt_json, '$.signature')) = 86
      AND length(CAST(json_extract(receipt_json, '$.signature') AS BLOB)) = 86
      AND json_extract(receipt_json, '$.signature') NOT GLOB '*[^A-Za-z0-9_-]*'
      AND substr(json_extract(receipt_json, '$.signature'), -1, 1) IN ('A', 'Q', 'g', 'w')
      AND receipt_json =
        '{"algorithm":"ecdsa-p256-sha256-p1363-low-s",' ||
        '"issuer":"agentic-review-server-enrollment-binding-authority-v1",' ||
        '"issuerKeyId":"' || issuer_key_id || '",' ||
        '"profileId":"agentic-review-server-binding-receipt-v1",' ||
        '"schemaVersion":1,"signature":"' ||
        json_extract(receipt_json, '$.signature') || '","statement":' ||
        statement_json || '}'
    )
  ),
  receipt_sha256 TEXT CHECK (
    receipt_sha256 IS NULL
    OR (
      length(receipt_sha256) = 64
      AND length(CAST(receipt_sha256 AS BLOB)) = 64
      AND instr(receipt_sha256, char(0)) = 0
      AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  record_document_sha256 TEXT CHECK (
    record_document_sha256 IS NULL
    OR (
      length(record_document_sha256) = 64
      AND length(CAST(record_document_sha256 AS BLOB)) = 64
      AND instr(record_document_sha256, char(0)) = 0
      AND record_document_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  FOREIGN KEY (issuer_key_id)
    REFERENCES server_binding_receipt_issuer (issuer_key_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (
    authorization_id,
    binding_id,
    issuance_request_sha256
  ) REFERENCES server_binding_authorizations (
    authorization_id,
    consumed_binding_id,
    consumed_issuance_request_sha256
  ) ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (
    authorization_id,
    request_id,
    issuer_key_id,
    worker_node_id,
    installation_id,
    enrollment_generation,
    certificate_der_sha256
  ) REFERENCES server_binding_authorizations (
    authorization_id,
    request_id,
    issuer_key_id,
    worker_node_id,
    installation_id,
    enrollment_generation,
    expected_certificate_der_sha256
  ) ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT DEFERRABLE INITIALLY IMMEDIATE,
  UNIQUE (worker_node_id, enrollment_generation),
  UNIQUE (authorization_id, binding_id, issuance_request_sha256),
  CHECK (
    (receipt_json IS NULL AND receipt_sha256 IS NULL)
    OR (receipt_json IS NOT NULL AND receipt_sha256 IS NOT NULL)
  ),
  CHECK (
    (phase = 'signing_pending'
      AND receipt_json IS NULL
      AND receipt_sha256 IS NULL
      AND record_document_sha256 IS NULL)
    OR (phase = 'reserved'
      AND receipt_json IS NOT NULL
      AND receipt_sha256 IS NOT NULL
      AND record_document_sha256 IS NULL)
    OR (phase = 'active'
      AND receipt_json IS NOT NULL
      AND receipt_sha256 IS NOT NULL
      AND record_document_sha256 IS NOT NULL)
    OR (phase = 'revoked'
      AND (
        (receipt_json IS NULL
          AND receipt_sha256 IS NULL
          AND record_document_sha256 IS NULL)
        OR (receipt_json IS NOT NULL
          AND receipt_sha256 IS NOT NULL
          AND record_document_sha256 IS NULL)
        OR (receipt_json IS NOT NULL
          AND receipt_sha256 IS NOT NULL
          AND record_document_sha256 IS NOT NULL)
      ))
  )
) STRICT;

CREATE TABLE server_binding_revocations (
  revocation_id TEXT PRIMARY KEY CHECK (
    length(revocation_id) = 36
    AND length(CAST(revocation_id AS BLOB)) = 36
    AND revocation_id GLOB
      '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  revocation_request_sha256 TEXT NOT NULL CHECK (
    length(revocation_request_sha256) = 64
    AND length(CAST(revocation_request_sha256 AS BLOB)) = 64
    AND instr(revocation_request_sha256, char(0)) = 0
    AND revocation_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  binding_id TEXT NOT NULL UNIQUE,
  prior_phase TEXT NOT NULL CHECK (
    prior_phase IN ('signing_pending', 'reserved', 'active')
  ),
  reason_code TEXT NOT NULL CHECK (
    reason_code IN (
      'binding_compromised',
      'enrollment_abandoned',
      'integrity_failure',
      'operator_requested'
    )
  ),
  revoked_at TEXT NOT NULL CHECK (
    length(revoked_at) = 24
    AND length(CAST(revoked_at AS BLOB)) = 24
    AND revoked_at GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND substr(revoked_at, 1, 4) <> '0000'
    AND CAST(substr(revoked_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    AND CAST(substr(revoked_at, 9, 2) AS INTEGER) BETWEEN 1 AND CASE
      CAST(substr(revoked_at, 6, 2) AS INTEGER)
      WHEN 1 THEN 31
      WHEN 2 THEN CASE
        WHEN CAST(substr(revoked_at, 1, 4) AS INTEGER) % 4 = 0
          AND (
            CAST(substr(revoked_at, 1, 4) AS INTEGER) % 100 <> 0
            OR CAST(substr(revoked_at, 1, 4) AS INTEGER) % 400 = 0
          )
        THEN 29
        ELSE 28
      END
      WHEN 3 THEN 31
      WHEN 4 THEN 30
      WHEN 5 THEN 31
      WHEN 6 THEN 30
      WHEN 7 THEN 31
      WHEN 8 THEN 31
      WHEN 9 THEN 30
      WHEN 10 THEN 31
      WHEN 11 THEN 30
      WHEN 12 THEN 31
    END
    AND CAST(substr(revoked_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(revoked_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(revoked_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  ),
  FOREIGN KEY (binding_id)
    REFERENCES server_bindings (binding_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    NOT DEFERRABLE INITIALLY IMMEDIATE
) STRICT;

CREATE INDEX ix_server_binding_authorizations_unconsumed_expiry
  ON server_binding_authorizations (expires_at, authorization_id)
  WHERE consumed_binding_id IS NULL;

CREATE INDEX ix_server_binding_authorizations_consumed_binding
  ON server_binding_authorizations (consumed_binding_id, authorization_id)
  WHERE consumed_binding_id IS NOT NULL;

CREATE INDEX ix_server_bindings_phase
  ON server_bindings (phase, binding_id);

CREATE INDEX ix_server_binding_revocations_revoked_at
  ON server_binding_revocations (revoked_at, revocation_id);

CREATE TRIGGER tr_server_binding_receipt_issuer_insert_once
BEFORE INSERT ON server_binding_receipt_issuer
WHEN EXISTS (SELECT 1 FROM server_binding_receipt_issuer)
BEGIN
  SELECT RAISE(ABORT, 'server binding receipt issuer is immutable');
END;

CREATE TRIGGER tr_server_binding_receipt_issuer_update
BEFORE UPDATE ON server_binding_receipt_issuer
BEGIN
  SELECT RAISE(ABORT, 'server binding receipt issuer is immutable');
END;

CREATE TRIGGER tr_server_binding_receipt_issuer_delete
BEFORE DELETE ON server_binding_receipt_issuer
BEGIN
  SELECT RAISE(ABORT, 'server binding receipt issuer is immutable');
END;

CREATE TRIGGER tr_server_binding_authorization_insert_consistency
BEFORE INSERT ON server_binding_authorizations
WHEN NEW.consumed_binding_id IS NOT NULL
  OR NEW.consumed_issuance_request_sha256 IS NOT NULL
  OR NEW.consumed_at IS NOT NULL
  OR NOT EXISTS (
    SELECT 1
    FROM server_binding_receipt_issuer AS receipt_issuer
    WHERE receipt_issuer.singleton_id = 1
      AND receipt_issuer.issuer_key_id = NEW.issuer_key_id
  )
  OR EXISTS (
    SELECT 1
    FROM server_binding_authorizations AS authorization
    WHERE authorization.authorization_id = NEW.authorization_id
      OR authorization.request_id = NEW.request_id
      OR authorization.token_sha256 = NEW.token_sha256
  )
  OR EXISTS (
    SELECT 1
    FROM server_bindings AS binding
    WHERE (
      binding.worker_node_id = NEW.worker_node_id
      AND binding.enrollment_generation = NEW.enrollment_generation
    )
      OR binding.certificate_der_sha256 = NEW.expected_certificate_der_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'server binding authorization insert is inconsistent');
END;

CREATE TRIGGER tr_server_binding_authorization_consume_once
BEFORE UPDATE ON server_binding_authorizations
WHEN NOT (
  OLD.consumed_binding_id IS NULL
  AND OLD.consumed_issuance_request_sha256 IS NULL
  AND OLD.consumed_at IS NULL
  AND NEW.consumed_binding_id IS NOT NULL
  AND NEW.consumed_issuance_request_sha256 IS NOT NULL
  AND NEW.consumed_at IS NOT NULL
  AND NEW.consumed_at < OLD.expires_at
  AND NEW.authorization_id IS OLD.authorization_id
  AND NEW.request_id IS OLD.request_id
  AND NEW.token_sha256 IS OLD.token_sha256
  AND NEW.operator_issuer IS OLD.operator_issuer
  AND NEW.operator_subject IS OLD.operator_subject
  AND NEW.worker_node_id IS OLD.worker_node_id
  AND NEW.installation_id IS OLD.installation_id
  AND NEW.enrollment_generation IS OLD.enrollment_generation
  AND NEW.expected_certificate_der_sha256 IS OLD.expected_certificate_der_sha256
  AND NEW.issuer_key_id IS OLD.issuer_key_id
  AND NEW.created_at IS OLD.created_at
  AND NEW.expires_at IS OLD.expires_at
  AND NOT EXISTS (
    SELECT 1
    FROM server_bindings AS binding
    WHERE binding.binding_id = NEW.consumed_binding_id
      OR binding.authorization_id = OLD.authorization_id
      OR (
        binding.worker_node_id = OLD.worker_node_id
        AND binding.enrollment_generation = OLD.enrollment_generation
      )
      OR binding.certificate_der_sha256 = OLD.expected_certificate_der_sha256
  )
)
BEGIN
  SELECT RAISE(ABORT, 'server binding authorization is immutable after one consumption');
END;

CREATE TRIGGER tr_server_binding_authorization_delete
BEFORE DELETE ON server_binding_authorizations
BEGIN
  SELECT RAISE(ABORT, 'server binding authorizations are durable tombstones');
END;

CREATE TRIGGER tr_server_binding_insert_consistency
BEFORE INSERT ON server_bindings
WHEN NEW.phase <> 'signing_pending'
  OR NEW.receipt_json IS NOT NULL
  OR NEW.receipt_sha256 IS NOT NULL
  OR NEW.record_document_sha256 IS NOT NULL
  OR EXISTS (
    SELECT 1
    FROM server_bindings AS binding
    WHERE binding.binding_id = NEW.binding_id
      OR binding.authorization_id = NEW.authorization_id
      OR (
        binding.worker_node_id = NEW.worker_node_id
        AND binding.enrollment_generation = NEW.enrollment_generation
      )
      OR binding.certificate_der_sha256 = NEW.certificate_der_sha256
  )
  OR NOT EXISTS (
    SELECT 1
    FROM server_binding_authorizations AS authorization
    WHERE authorization.authorization_id = NEW.authorization_id
      AND authorization.request_id = NEW.request_id
      AND authorization.issuer_key_id = NEW.issuer_key_id
      AND authorization.worker_node_id = NEW.worker_node_id
      AND authorization.installation_id = NEW.installation_id
      AND authorization.enrollment_generation = NEW.enrollment_generation
      AND authorization.expected_certificate_der_sha256 = NEW.certificate_der_sha256
      AND authorization.consumed_binding_id = NEW.binding_id
      AND authorization.consumed_issuance_request_sha256 = NEW.issuance_request_sha256
  )
  OR EXISTS (
    SELECT 1
    FROM server_binding_revocations AS revocation
    WHERE revocation.binding_id = NEW.binding_id
  )
BEGIN
  SELECT RAISE(ABORT, 'server binding must begin as the exact consumed signing request');
END;

CREATE TRIGGER tr_server_binding_transition
BEFORE UPDATE ON server_bindings
WHEN NOT (
  NEW.binding_id IS OLD.binding_id
  AND NEW.binding_revision IS OLD.binding_revision
  AND NEW.authorization_id IS OLD.authorization_id
  AND NEW.request_id IS OLD.request_id
  AND NEW.issuance_request_sha256 IS OLD.issuance_request_sha256
  AND NEW.worker_node_id IS OLD.worker_node_id
  AND NEW.installation_id IS OLD.installation_id
  AND NEW.enrollment_generation IS OLD.enrollment_generation
  AND NEW.certificate_der_sha256 IS OLD.certificate_der_sha256
  AND NEW.issuer_key_id IS OLD.issuer_key_id
  AND NEW.bound_at IS OLD.bound_at
  AND NEW.statement_json IS OLD.statement_json
  AND NEW.statement_document_sha256 IS OLD.statement_document_sha256
  AND (
    (OLD.phase = 'signing_pending'
      AND NEW.phase = 'reserved'
      AND OLD.receipt_json IS NULL
      AND OLD.receipt_sha256 IS NULL
      AND NEW.receipt_json IS NOT NULL
      AND NEW.receipt_sha256 IS NOT NULL
      AND NEW.record_document_sha256 IS OLD.record_document_sha256
      AND NOT EXISTS (
        SELECT 1
        FROM server_binding_revocations AS revocation
        WHERE revocation.binding_id = OLD.binding_id
      ))
    OR (OLD.phase = 'reserved'
      AND NEW.phase = 'active'
      AND NEW.receipt_json IS OLD.receipt_json
      AND NEW.receipt_sha256 IS OLD.receipt_sha256
      AND OLD.record_document_sha256 IS NULL
      AND NEW.record_document_sha256 IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM server_binding_revocations AS revocation
        WHERE revocation.binding_id = OLD.binding_id
      ))
    OR (OLD.phase IN ('signing_pending', 'reserved', 'active')
      AND NEW.phase = 'revoked'
      AND NEW.receipt_json IS OLD.receipt_json
      AND NEW.receipt_sha256 IS OLD.receipt_sha256
      AND NEW.record_document_sha256 IS OLD.record_document_sha256
      AND EXISTS (
        SELECT 1
        FROM server_binding_revocations AS revocation
        WHERE revocation.binding_id = OLD.binding_id
          AND revocation.prior_phase = OLD.phase
      ))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid server binding transition');
END;

CREATE TRIGGER tr_server_binding_delete
BEFORE DELETE ON server_bindings
BEGIN
  SELECT RAISE(ABORT, 'server bindings are immutable');
END;

CREATE TRIGGER tr_server_binding_revocation_insert_consistency
BEFORE INSERT ON server_binding_revocations
WHEN EXISTS (
    SELECT 1
    FROM server_binding_revocations AS revocation
    WHERE revocation.revocation_id = NEW.revocation_id
      OR revocation.binding_id = NEW.binding_id
  )
  OR NOT EXISTS (
    SELECT 1
    FROM server_bindings AS binding
    WHERE binding.binding_id = NEW.binding_id
      AND binding.phase = NEW.prior_phase
      AND binding.phase IN ('signing_pending', 'reserved', 'active')
  )
BEGIN
  SELECT RAISE(ABORT, 'server binding revocation does not match a nonterminal binding');
END;

CREATE TRIGGER tr_server_binding_revocation_terminalize
AFTER INSERT ON server_binding_revocations
BEGIN
  UPDATE server_bindings
  SET phase = 'revoked'
  WHERE binding_id = NEW.binding_id
    AND phase = NEW.prior_phase;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM server_bindings AS binding
      WHERE binding.binding_id = NEW.binding_id
        AND binding.phase = 'revoked'
    )
    THEN RAISE(ABORT, 'server binding revocation did not terminalize its binding')
  END;
END;

CREATE TRIGGER tr_server_binding_revocation_update
BEFORE UPDATE ON server_binding_revocations
BEGIN
  SELECT RAISE(ABORT, 'server binding revocations are append-only');
END;

CREATE TRIGGER tr_server_binding_revocation_delete
BEFORE DELETE ON server_binding_revocations
BEGIN
  SELECT RAISE(ABORT, 'server binding revocations are append-only');
END;
