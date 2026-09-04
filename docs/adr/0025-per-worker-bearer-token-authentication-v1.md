# ADR 0025: Per-Worker Bearer Token Authentication and Direct Registration v1

## Status

Accepted on 2026-09-03 and amended on 2026-09-05 by ADR 0029 for the single-Worker layout.

This ADR remains authoritative for Worker-to-Server authentication. Earlier client-certificate,
Server-binding receipt, Control/Executor, package, and artifact assumptions are not part of this
decision.

## Context

The Server needs to authenticate each Windows Worker node independently. The selected deployment
trusts the Server host, database administrators, and local Windows Worker environment. It does not
need a Worker client certificate, signed Server-binding receipt, offline identity proof, KMS/HSM,
or hardware-backed local key.

The Server database is the online identity and revocation authority. Restoring an older database
backup intentionally restores the credential state contained in that backup.

## Decision

### Credential boundaries

The system keeps these credentials distinct:

1. A long-lived Worker Bearer Token authenticates one Worker node to the Server Worker API.
2. A short-lived lease token fences one run attempt.
3. GitHub ingestion credentials remain on the Server.
4. Operator sessions and optional operator OIDC credentials remain Server-side.

The Worker Token is never used as a lease token, operator credential, GitHub credential, or Codex
credential. It is not propagated to Git, Codex, validation, or ProcessHost child processes.

### Token profile

Each Worker node has exactly one current Token:

```text
"arw1_" || BASE64URL_NO_PADDING(CSPRNG(32 bytes))
```

The Server returns plaintext only after a successful create or rotate operation and uses
`Cache-Control: private, no-store`. It stores only the lowercase SHA-256 digest of the exact ASCII
Token, with a unique constraint over the digest.

There is no refresh token, automatic expiry, automatic rotation, overlap window, JWT, password
KDF, salt, pepper, or introspection service. Rotation immediately replaces the current digest.

### Windows storage

The single Worker process reads exactly one canonical UTF-8 JSON file:

```text
C:\ProgramData\AgenticReview\Worker\worker-auth-v1.json
```

```json
{"profileId":"agentic-review-worker-auth-v1","token":"arw1_<43-base64url-characters>","workerNodeId":"<entity-id>"}
```

The parser rejects missing, extra, duplicate, wrongly typed, noncanonical, malformed, BOM-prefixed,
or trailing bytes. Production accepts no environment variable, command-line argument, registry
value, package field, or alternate path as a second Token source.

The file ACL must grant access only to the Windows identity that runs the Worker, `SYSTEM`, and
local deployment administrators. It must not be committed, packaged, copied into diagnostics, or
printed in logs. This v1 profile intentionally does not require DPAPI, Credential Manager, CNG, or
a hardware key.

### Persistent state

Migration `0008_worker_token_auth_v1.sql` adds the node credential table. The existing `workers`
table continues to represent process instances.

The credential record contains the Worker node ID, display name, Token digest, lifecycle state,
operator audit identities, and lifecycle timestamps. The lifecycle states are `pending`, `active`,
and `revoked`, with these forward transitions:

```text
pending -> active
pending -> revoked
active -> revoked
```

Rotation changes the Token digest and rotation/audit timestamps without changing lifecycle state.
`revoked` is terminal in the current database history. Returning a machine to service requires a
new Worker node identity.

### Operator management API

Any authenticated operator may:

- list Worker credential metadata;
- create a pending Worker and receive its Token once;
- rotate a pending or active Worker using an `expectedUpdatedAt` compare-and-set; or
- idempotently revoke a pending or active Worker.

```text
GET  /api/v1/operator/worker-nodes
POST /api/v1/operator/worker-nodes
POST /api/v1/operator/worker-nodes/{workerNodeId}/token/rotate
POST /api/v1/operator/worker-nodes/{workerNodeId}/revoke
```

Mutation routes require an operator session and exact same-origin protection. Roster responses
never expose plaintext Tokens, Token digests, or operator identities. A lost create or rotate
response is recovered by rotating again; plaintext cannot be replayed.

### Worker registration and authentication

Workers send the Token only in:

```http
Authorization: Bearer <token>
```

The Server accepts no Worker Token from a query, cookie, URL, request body, alternate scheme, or
proxy identity header. The Token mapping is authoritative for `workerNodeId`; any body identity is
only a cross-check.

A pending Token may call only `POST /api/v1/worker/instances`. The first successful registration
atomically validates the registration, transitions the node to `active`, and records the Worker
process instance. All other Worker routes require an active credential.

Every request authenticates against SQLite; there is no long-lived positive Token cache. Rotation
and revocation affect authentication performed after their transactions commit. Requests already
authenticated may finish and remain subject to lease fencing.

### Public failures

Missing, malformed, unknown, rotated, and revoked Tokens share:

```text
401 worker_authentication_failed
WWW-Authenticate: Bearer
```

A valid pending Token on a non-registration route receives
`403 worker_registration_required`. A body identity mismatch receives
`403 worker_identity_mismatch`. Database unavailability receives
`503 worker_authentication_unavailable`.

Errors and logs never contain the Token, digest, or Authorization header.

### Transport

Production Worker traffic uses HTTPS with normal Server certificate validation. There is no Worker
client certificate. Explicit loopback development may use HTTP, but Bearer Token authentication
remains mandatory.

## Accepted limits

- Anyone who can read the local credential file can impersonate that Worker.
- Any authenticated operator can create, rotate, or revoke Worker credentials.
- A compromised Server process or database can alter Worker identities.
- Database rollback can restore an older Token or revive a later-revoked credential state.
- Bearer revocation cannot cancel a request that already authenticated.

These are selected trust assumptions. Stronger local storage, operator roles, anti-rollback epochs,
short-lived credentials, or instant in-flight cancellation require a later ADR.

## Pre-release schema rule

The current schema ends at version 8. There is no compatibility path for older unpublished Worker
certificate, Server-binding, package, artifact, or Token migration sequences. Such databases must
be rebuilt, or restored only from an exact current-schema backup as documented in
`docs/operations/worker-token-recovery.md`.

## Verification requirements

Verification covers:

- exact Token syntax and CSPRNG generation;
- one-time plaintext create/rotate responses with `no-store`;
- digest-only persistence;
- pending registration and atomic activation;
- active authentication, rotation, revocation, and conflict handling;
- identical public failures for invalid credential states;
- identity mismatch rejection across Worker routes;
- same-origin operator mutation protection;
- absence of secrets from logs and errors;
- HTTPS without a Worker client certificate; and
- schema version 8 plus exact-backup rollback behavior.

## Consequences

- Worker authentication is an ordinary database-backed Bearer Token flow.
- One Worker can be rotated or revoked without affecting other nodes.
- The local plaintext Token and accepted database rollback behavior are explicit operational risks.
- Worker authentication does not itself authorize a job; claims, leases, capabilities, and fencing
  remain separate checks.
