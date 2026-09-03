# Per-Worker Bearer Token Authentication v1 Handoff

Status date: 2026-09-04

Branch: `codex/worker-token-auth-v1`

Base commit: `e9f393573c1c8eedbf6256b8e23b62d83203ef46`

ADR 0025 replaces Worker mutual TLS, certificate binding, Server binding receipts, active-status
assertions, and the dormant signer-host direction with one independently revocable long-lived
Bearer Token per Worker node. The Server remains the online authority for Worker identity and
revocation. The local Windows environment, Server, database, and authenticated operators are
trusted under the selected profile.

## Completed Scope

- Migration `0013_worker_token_auth_v1.sql` adds the node-level credential record with a unique
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
- The native ServiceHost now has a source-only TLS 1.3 Bearer client, exact canonical profile
  reader, centralized Worker and artifact authorization injection, Token-reflection filtering,
  lifecycle clearing, and mappings for the selected Token-authentication and rate-limit errors.
- Architecture, deployment, implementation-status, ADR, and historical handoff documentation now
  identify receipt, signer-host, and Worker-mTLS material as superseded rather than future gates.

## Production Reachability Boundary

The Server and runnable TypeScript Worker have one positive Worker authentication source: the
database-backed Bearer Token. The certificate fingerprint map and TLS client-CA listener are not
configured or accepted by the Server. The retained migration-0012 tables, receipt code, signer
code, and signer-host code have no Server route or Worker-auth consumer.

The native ServiceHost Bearer implementation is deliberately not a second production path yet.
`internal/platform/production_windows.go` still belongs to the unavailable exact schema-v3
candidate and still constructs the historical mTLS client. Selecting Bearer there would silently
reinterpret signed bootstrap and package fields. A later explicitly versioned bootstrap,
data-root, package, and installer profile must replace that candidate and provision the fixed
Token file before the native split-service Worker can ship.

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

The full workspace test command was also attempted locally. Codex, Contracts, Local Protocol,
Domain, and Worker completed successfully. The Server reported `820` passed, `43` skipped, and `97`
failed on Windows. Those failures are confined to the repository's deliberate POSIX database-owner
guard and the superseded Linux signer-host real-child suite. The affected database files were then
run from a clean local WSL dependency installation and passed `156/156`; the cancelled signer-host
matrix was not rerun.

The local Node runtime was `26.1.0`, while the repository requires `>=24.20.0 <25`. pnpm emitted the
engine warning, but lint, typecheck, build, and the recorded focused tests completed.

## Deferred Work

1. Define and implement the explicitly versioned native bootstrap, package, data-root, and
   installation profile that removes schema-v3 Worker-mTLS fields and selects the fixed Bearer
   profile. This is part of the already-deferred production split-service installer milestone.
2. Add Dashboard controls for create, rotate, revoke, and one-time Token copy if an operator UI is
   desired. The authenticated same-origin management API is complete.
3. Delete superseded receipt, signer, signer-host, and migration-history runtime source only in a
   separate cleanup change after proving no retained migration-0012 rows require historical audit.
4. Perform deployment recovery exercises for Token creation, lost rotate responses, revocation,
   and the explicitly accepted database-backup rollback behavior before a production rollout.

Linux signer-host signals, reaping, cgroups, parent-death behavior, HSM/KMS integration, candidate
certificates, signed receipts, and active-status assertions are not deferred requirements under
ADR 0025.
