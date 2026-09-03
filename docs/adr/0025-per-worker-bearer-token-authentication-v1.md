# ADR 0025: Per-Worker Bearer Token Authentication and Direct Registration v1

## Status

Accepted for implementation on 2026-09-03.

This decision replaces Worker-to-Server mutual TLS, certificate binding, Server binding receipts,
active-status assertions, and the dormant Server binding signer-host with one long-lived Bearer
Token per Worker node. The Server remains a Linux HTTPS control plane and Workers remain Windows
clients.

ADR 0022, ADR 0023, ADR 0024, and the exact ADR 0014 enrollment-record profile are superseded.
ADR 0003, ADR 0007, ADR 0008, ADR 0013, ADR 0015, and ADR 0021 are amended only where they require a
Worker mTLS credential, certificate binding, or Server binding receipt. The exact ADR 0010 through
ADR 0012 package profiles and the fixed ADR 0019 lab blocker tuple are not reinterpreted in place;
their mTLS- or receipt-dependent versions are historical and require explicitly versioned
replacements before production use. Lease tokens, package signatures, Authenticode, the
Control-to-Executor local capability signer, artifact receipts, process isolation, and
zero-execution policy remain separate and unchanged.

## Context

The existing Worker API authenticates a TLS client certificate, maps its SHA-256 fingerprint to a
configured `workerNodeId`, and then checks that identity against the request body. Later dormant
decisions added a signed Server binding receipt, active-status assertions, durable receipt
persistence, and a killable Linux signer-host process.

The selected deployment has a simpler trust model:

- the Server host, Server process, database, deployment administrators, and local Windows Worker
  environment are trusted;
- every authenticated dashboard user has equal authority to create, rotate, and revoke Worker
  credentials;
- Workers do not need offline proof of a Server binding;
- the Server database is the online authority for Worker identity and revocation;
- restoring an older database backup intentionally restores the Token state contained in that
  backup; and
- a local Windows configuration file may contain the Worker Token in plaintext.

Under this model, a dedicated receipt issuer, signer key, KMS or HSM, signer child process, compiled
receipt trust, and Linux signer-host verification do not protect a required boundary. They add
operational and review cost without changing the accepted trust assumptions.

## Decision

### Credential boundaries

The system keeps the following credentials distinct:

1. A long-lived Worker Bearer Token authenticates one Worker node to the Server Worker API.
2. A short-lived lease token fences one run attempt and remains unchanged.
3. The Control-to-Executor local capability signer remains a Windows-local authorization boundary.
4. Package signing, Authenticode, GitHub, Codex, and operator OIDC credentials remain unchanged.

The Worker Bearer Token is never used as a lease token, local capability, package credential,
operator session, GitHub credential, or Codex credential.

### Worker node credential

Each Worker node has exactly one current Token. The Token is:

```text
"arw1_" || BASE64URL_NO_PADDING(CSPRNG(32 bytes))
```

The random component therefore contains 256 bits of entropy and the complete Token contains only
ASCII characters. The Token is long-lived until an authenticated user explicitly rotates or
revokes it. There is no access-token, refresh-token, automatic expiry, automatic rotation, overlap
window, password KDF, salt, pepper, JWT, or Token introspection service.

The Server returns the plaintext Token only from a successful create or rotate operation. Those
responses use `Cache-Control: private, no-store`. The Server never stores the plaintext Token. It
stores the lowercase SHA-256 of the exact ASCII Token and a unique index over that digest. Token
entropy, not a password-hardening function, provides brute-force resistance.

The Windows Worker stores `workerNodeId` and the plaintext Token in exactly one ordinary local
configuration file:

```text
C:\ProgramData\AgenticReview\Control\worker-auth-v1.json
```

The file is the exact UTF-8 JSON object below, occupies at most 4 KiB, and contains no BOM,
insignificant whitespace, alternate member order, duplicate member, or trailing byte:

```json
{"profileId":"agentic-review-worker-auth-v1","token":"arw1_<43-base64url-characters>","workerNodeId":"<entity-id>"}
```

The Worker parses the document, validates the three values, reserializes them in the order above,
and requires exact byte equality. Missing, extra, duplicate, wrongly typed, noncanonical, or
malformed members are rejected. Production accepts no environment variable, command-line
argument, package field, registry value, or alternate file path as a second Worker Token source.
Tests may inject an in-memory reader without changing the production path.

This profile does not require DPAPI, Credential Manager, CNG, a protected hardware key, or a
special local reader identity. The file must not be committed to source control, included in a
release package, copied into diagnostics, or printed in logs. Stronger local storage requires a
later profile rather than an implicit change to v1.

### Persistent Worker node state

Migration `0013_worker_token_auth_v1.sql` adds one node-level credential table. The existing
`workers` table remains the process-instance table and is not used as the long-lived credential
store.

The new table records at least:

```text
worker_node_id
display_name
token_sha256
auth_state
created_by_issuer
created_by_subject
updated_by_issuer
updated_by_subject
created_at
activated_at
rotated_at
revoked_at
updated_at
```

`worker_node_id` and `token_sha256` are independently unique. `auth_state` is exactly `pending`,
`active`, or `revoked`. The only state transitions are:

```text
pending -> active
pending -> revoked
active -> revoked
```

Rotation changes only `token_sha256`, `rotated_at`, `updated_at`, and the two last-operator fields;
it does not change the state. `revoked` is terminal. Reusing a revoked node requires creating a new
Worker node identity.

The database stores the creator and the last operator to rotate or revoke the credential for
ordinary accountability. It does not introduce a second administrator role because every
authenticated dashboard user has equal Token management authority. State-transition admission is
enforced by the sole `database-worker` API inside `BEGIN IMMEDIATE` transactions. Direct SQL writes
by a trusted administrator are outside this profile's threat model; migration `0013` therefore
uses ordinary `CHECK` and `UNIQUE` constraints rather than a second trigger policy layer.

### Operator Token management

Any user with a valid existing operator session may:

- create a pending Worker node and receive its Token once;
- rotate the current Token for a pending or active Worker; or
- idempotently revoke a pending or active Worker.

Mutation routes require the existing operator session and an exact same-origin `Origin` header.
They return no credential through a URL, redirect, cookie, log field, metric label, or error body.
The Worker node ID is generated by the Server. Caller-supplied display text is descriptive only.

The management API is:

```text
GET  /api/v1/operator/worker-nodes?page=<positive-integer>&pageSize=<1-through-200>[&sort=identity]
POST /api/v1/operator/worker-nodes
POST /api/v1/operator/worker-nodes/:workerNodeId/token/rotate
POST /api/v1/operator/worker-nodes/:workerNodeId/revoke
```

The authenticated GET roster is paginated and returns only lifecycle metadata; it never returns a
Token, Token digest, or operator identity. Display text must not contain a complete Worker
Token-shaped value. Rotation requires the roster record's exact canonical `updatedAt` as an
`expectedUpdatedAt` compare-and-set precondition. A concurrent rotation that already advanced the
record returns the ordinary credential-conflict response rather than returning a second successful
Token. Credential update timestamps advance monotonically even when operations occur in the same
millisecond.

The default roster order is latest update followed by Worker node ID. A caller that must aggregate
multiple pages while credentials may change requests `sort=identity`, which orders by immutable
Worker node ID and prevents lifecycle updates from moving records across offset pages.

The authenticated credential-route scope permits 300 requests per minute. A bounded Dashboard
inventory load uses at most 50 requests for 10,000 records, leaving capacity for an operation-driven
reload and an operator refresh without weakening the separate anonymous login or Worker request
limits.

### Worker registration and authentication

The existing Worker instance registration endpoint remains:

```text
POST /api/v1/worker/instances
```

The Worker sends its Token only in:

```http
Authorization: Bearer <token>
```

The Server accepts no Worker Token from a query, cookie, URL, request body, alternate scheme, or
proxy identity header. The Token mapping is the authority for `workerNodeId`. Existing request body
fields may continue carrying `workerNodeId` as a compatibility assertion, but a different value is
rejected and can never select another identity.

The first successful registration performs one database transaction that:

1. verifies the Token digest and a `pending` node;
2. verifies the complete registration request and protocol version;
3. transitions the node to `active`; and
4. upserts the existing Worker process instance.

No failed request activates the node. A repeated request with the same Token and
`workerInstanceId` returns the existing instance result. A new `workerInstanceId` for the same
Token remains the same Worker node and uses the existing instance-supersession behavior.

A pending Token may call only the registration endpoint. Every other Worker route requires an
`active` node. Every Worker route, including artifact upload, completion, heartbeat, claim, and
terminal submission, derives the node identity from the Token mapping.

### Revocation, rotation, and request races

Rotation atomically installs one new digest and invalidates the old Token. There is no overlap.
The rotation transaction checks `expectedUpdatedAt` before replacing the digest, so concurrent
operators cannot both receive successful replacement Tokens for the same prior credential version.
The operator places the new Token in the Windows configuration file and restarts the Worker. If a
rotate response is lost, the operator performs another rotation and uses the last Token actually
received; the Server never retains plaintext to replay a response.

Revocation is idempotent and rejects all later Worker requests. Existing process-instance rows may
be marked disabled or offline. A request that completed authentication before revocation may finish;
revocation applies to subsequent authentication. Existing leases remain governed by their current
lease token and TTL, but the claim transaction rechecks that the node remains active before granting
new work.

Rotation invalidates the old Token for subsequent requests. A request authenticated before the
rotation transaction may finish with the already-established node identity, including an existing
long poll. This request-level race is accepted and is not a second active Token.

The Server authenticates each request against the database and does not use a long-lived Token
cache. Database unavailability fails closed. Basic request-rate limiting protects the authentication
lookup from denial-of-service traffic; account-style lockout is unnecessary for a 256-bit Token.

### Failure responses

Missing, malformed, unknown, rotated, and revoked Tokens share one public response:

```text
401 worker_authentication_failed
WWW-Authenticate: Bearer
```

An otherwise valid pending Token on a non-registration route receives:

```text
403 worker_registration_required
```

A body identity that differs from the Token mapping receives:

```text
403 worker_identity_mismatch
```

An unavailable authentication database receives:

```text
503 worker_authentication_unavailable
```

Errors never contain the Token, its digest, the Authorization header, or a database lookup detail.

### HTTPS and Server configuration

Production Worker traffic continues to require HTTPS and normal Server certificate validation.
Worker client certificates are removed. The Server no longer loads a Worker client CA, requests a
client certificate, or loads a static certificate-fingerprint map. The Worker TLS client retains
the Server CA and optional fixed server name but no longer loads a client certificate, private key,
PFX, or client-key passphrase.

Loopback HTTP may remain an explicit development-only transport. It does not bypass Bearer Token
authentication.

### Accepted trust and recovery limits

This profile accepts all of the following:

- anyone who can read a Worker's local configuration may impersonate that Worker;
- any authenticated dashboard user may create, rotate, or revoke any Worker Token;
- a compromised Server process or database can create or alter Worker identities;
- restoring an old database backup may restore an old Token, revive a later-revoked Token, or
  invalidate a later-rotated Token; and
- bearer revocation cannot cancel a request that already passed authentication.

These are explicit product choices, not unimplemented security controls. A stronger local secret
store, role model, anti-rollback epoch, independent credential authority, short-lived Token, or
instant in-flight cancellation requires a later ADR.

### Legacy transition

The certificate map and Bearer Token authentication must not remain as two positive production
authentication sources. Production rollout creates a Token for every retained Worker, updates its
configuration, and then switches the Server to Token-only authentication.

Migration `0012_server_binding_persistence_v1.sql` remains immutable migration history. Its dormant
tables never become Worker authentication authority. The superseded receipt, signer, signer-host,
compiled trust, node-enrollment record, and related executable source were deleted on 2026-09-04.
The migration and its existing rows remain intact; a later forward cleanup migration may remove
the tables only after proving that every deployed database contains no rows.

## Verification Requirements

Implementation verification must cover:

- exact Token syntax and 32-byte CSPRNG generation;
- plaintext returned only on create and rotate with `no-store`;
- database storage containing only the Token digest;
- pending registration, active authentication, revoked rejection, and atomic rotation;
- exact registration replay and process-instance supersession;
- body identity mismatch rejection on every Worker request shape;
- missing, malformed, unknown, rotated, and revoked Token indistinguishability;
- database-unavailable fail-closed behavior;
- all Worker and artifact routes using the same Token identity source;
- operator session and same-origin enforcement for every Token mutation;
- complete paginated credential roster reads without Token or digest disclosure;
- stale concurrent rotation rejection through the `expectedUpdatedAt` compare-and-set;
- rejection of Token-shaped values in persistent Worker display text;
- absence of Worker Tokens and Authorization headers from logs and errors;
- Worker HTTPS validation without a client certificate;
- production rejection of the old certificate map and absence of dual authentication; and
- restored-backup tests documenting the accepted Token rollback behavior.

Linux verification is limited to the actual Linux Server HTTPS, SQLite, and route integration. The
superseded signer-host signal, reaping, cgroup, parent-death, and D-state matrix is cancelled.
Windows verification covers configuration loading and Bearer header behavior; it does not require a
client certificate, CNG TLS key, receipt, or Server binding verifier.

## Consequences

- Worker registration and authentication become ordinary database-backed Bearer authentication.
- One Worker can be rotated or revoked without affecting other Workers.
- Existing Worker instance, lease, heartbeat, artifact, and completion protocols remain largely
  unchanged.
- The private-key, receipt, active-status, signer-host, and Linux process-supervision design is no
  longer required.
- A copied Token is sufficient to impersonate a Worker until rotation or revocation.
- Plaintext local storage and database rollback risks are accepted by the selected trust model.
- Removing exact mTLS fields from signed package and enrollment profiles requires new profile
  versions or explicit supersession; existing exact formats are not silently reinterpreted.

## Non-Goals

- anonymous Worker self-registration;
- one shared Token for all Workers;
- Worker client certificates or mutual TLS;
- signed Server binding receipts or active-status assertions;
- KMS, HSM, PKCS#11, signer-host, or receipt trust management;
- protecting a Token from trusted local Windows users or administrators;
- differentiating operator roles;
- preventing credential rollback after database restore;
- changing lease tokens, package signatures, local capability signatures, or execution policy; or
- enabling execution merely because a Worker authenticated successfully.
