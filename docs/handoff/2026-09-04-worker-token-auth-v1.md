# Per-Worker Bearer Token Authentication v1 Handoff

Status date: 2026-09-04

Branch: `codex/worker-token-auth-v1`

Base commit: `e9f393573c1c8eedbf6256b8e23b62d83203ef46`

ADR 0025 replaces Worker mutual TLS, certificate binding, Server binding receipts, active-status
assertions, and the dormant signer-host direction with one independently revocable long-lived
Bearer Token per Worker node. The Server remains the online authority for Worker identity and
revocation. The local Windows environment, Server, database, and authenticated operators are
trusted under the selected profile.

## 2026-09-04 Follow-up Amendment

Branch `codex/worker-token-followups` completes three items that were deferred by the initial
handoff: the authenticated credential roster and Dashboard management flow, native ServiceHost
bootstrap schema v4 and Bearer production composition, and removal of the superseded Server binding
coordinator from the production storage lifecycle. The signed outer-package v1 and installer remain
historical schema-v3 profiles. The later release follow-up adds outer-package v2 and split installer
profile v2 contracts for schema v4 while leaving actual signed material and the production SCM
installer deferred.

## Completed Scope

- Migration `0012_worker_token_auth_v1.sql` adds the node-level credential record with a unique
  lowercase SHA-256 Token digest, `pending`/`active`/`revoked` state, operator attribution, and
  activation, rotation, and revocation timestamps. The database-worker performs create,
  authenticate, rotate, revoke, registration activation, and active-state Claim rechecks inside
  the reviewed transaction boundaries.
- Authenticated same-origin operator routes create a Server-generated Worker node and Token, rotate
  a pending or active Token without overlap, and idempotently revoke a credential. Plaintext is
  returned only by successful create and rotate responses with private no-store headers; SQLite
  stores only the digest.
- Every Worker and artifact route authenticates one strict `Authorization: Bearer` value against
  the database. Registration alone accepts a pending Token. Later routes require active state,
  derive `workerNodeId` from the Token mapping, reject body identity overrides, and fail closed when
  authentication storage is unavailable.
- Worker-plane rate limiting runs before the authentication database lookup. Operator credential
  rate limiting runs before session and mutation work. Rate-limit responses retain HTTP 429.
- Request logging redacts Authorization, removes query strings from logged URLs, and redacts a
  Token-shaped path or host value. Authentication errors never return the Token, digest, header, or
  lookup detail.
- Production Server configuration requires HTTPS. Explicit development HTTP is limited to a
  loopback listener and does not bypass Token authentication. Legacy Server Worker-mTLS settings
  are rejected.
- The TypeScript Windows Worker loads the Token and node ID only from the exact canonical UTF-8
  profile at `C:\ProgramData\AgenticReview\Control\worker-auth-v1.json`, sends Bearer authorization
  on every Worker request, validates the Server certificate, and loads no client certificate,
  private key, PFX, or passphrase.
- The native ServiceHost has a TLS 1.3 Bearer client, exact canonical profile reader, centralized
  Worker and artifact authorization injection, Token-reflection filtering, lifecycle clearing, and
  mappings for the selected Token-authentication and rate-limit errors. Bootstrap schema v4 now
  selects it for Control while Executor receives no Worker credential or Server transport.
- The operator credential roster returns only non-secret lifecycle data for pending, active, and
  revoked nodes through strict 200-record pages. The Dashboard aggregates the complete bounded
  roster, merges it with Worker runtime state, and provides create, rotate, revoke, one-time reveal,
  and clipboard-copy operations without using browser storage. Rotation uses the record's
  `updatedAt` as a compare-and-set precondition, and persistent display text rejects Token shapes.
- Architecture, deployment, implementation-status, ADR, and historical handoff documentation now
  identify receipt, signer-host, and Worker-mTLS material as superseded rather than future gates.

## Production Reachability Boundary

The Server and runnable TypeScript Worker have one positive Worker authentication source: the
database-backed Bearer Token. The certificate fingerprint map and TLS client-CA listener are not
configured or accepted by the Server. The receipt, signer, signer-host, and Server-binding database
tables are absent from the current production source and schema. A pre-release schema reset reused
migration version 12 for the Worker Token schema.

Native ServiceHost production composition now accepts only bootstrap schema v4. Control loads the
fixed authentication file and constructs `NewBearerClient`; Executor has no Worker credential or
Server transport. Historical schema v3 remains parseable for exact-byte compatibility but fails
production startup before credential acquisition. Signed outer-package v1 still accepts only schema
v3; outer-package v2 and installer profile v2 now bind schema v4, but actual signed release material,
destination evidence, and the production SCM installer are still required before shipment.

The production Server storage lifecycle no longer creates, opens, or closes the superseded Server
binding coordinator. The current schema contains no Server-binding rows or tables and provides no
legacy-adoption or schema-13 compatibility path. Databases from earlier unreleased builds must be
rebuilt.

This repository remains execution-disabled. Successful Worker authentication does not grant a
Claim, lease, slot, package, installation, local capability, or execution authority.

## Verification

Local verification was explicitly authorized. No command was run on `test-env`.

```text
git diff --check:                         passed
All-workspace lint:                      passed; Biome checked 327 files
All-workspace typecheck:                 passed
All-workspace build:                     passed
Server Token/config/route matrix:        185 passed, 5 platform skips
Worker unit matrix:                      908 passed
Worker role and architecture guards:     19 passed
Local WSL database matrix:               156 passed
Native focused Go packages:              passed
Native focused go vet:                   passed
Native all-package Windows compile:      passed
Independent native review:               no remaining P0-P2 findings
```

The follow-up verification additionally passed Dashboard `48/48`, Server `235/235`, Contracts
`28/28`, historical coordinator and persistence `50/50`, Worker `908/908` plus role guards `19/19`,
local WSL database `164/164`, native focused tests, native all-package compilation and vet, and
Windows amd64 and arm64 cross-builds. Browser
verification covered desktop and 390-pixel layouts, clipboard copy, and Token removal from the DOM
after the one-time panel closed.

The full workspace test command was also attempted locally. Codex, Contracts, Local Protocol,
Domain, and Worker completed successfully. The Server reported `820` passed, `43` skipped, and `97`
failed on Windows. Those failures are confined to the repository's deliberate POSIX database-owner
guard and the superseded Linux signer-host real-child suite. The affected database files were then
run from a clean local WSL dependency installation and passed `156/156`; the cancelled signer-host
matrix was not rerun.

The local Node runtime was `26.1.0`, while the repository requires `>=24.20.0 <25`. pnpm emitted the
engine warning, but lint, typecheck, build, and the recorded focused tests completed.

## Deferred Work

1. Produce actual signed outer-package-v2 release material and implement root materialization,
   atomic swap, and the production SCM installer. The later installer-destination slice completed
   the read-only typed-gate re-verification evidence for all three fixed post-swap roots, but no
   production installer invokes it. Signed package v1 remains immutable schema-v3 history.

The later `codex/worker-token-release-recovery` change completed the executable historical-source
cleanup and the Token recovery exercises. A subsequent pre-release reset removed the dormant
four-table migration, renumbered the Worker Token migration to version 12, and limited operational
restore to exact current-schema backups.

Linux signer-host signals, reaping, cgroups, parent-death behavior, HSM/KMS integration, candidate
certificates, signed receipts, and active-status assertions are not deferred requirements under
ADR 0025.
