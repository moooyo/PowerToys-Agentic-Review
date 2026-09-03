# Worker Token Authentication Follow-up Handoff

Status date: 2026-09-04

Branch: `codex/worker-token-followups`

Base commit: `52dc7086b575d0550daa662c32da76b956d4b9b8`

This follow-up completes the non-blocking operational work left by the initial ADR 0025
implementation: operator credential inventory and Dashboard management, native ServiceHost
schema-v4 Bearer composition, and removal of the superseded Server binding coordinator from the
production storage lifecycle.

## Completed Scope

- `GET /api/v1/operator/worker-nodes` returns strict pages of at most 200 pending, active, and
  revoked credential records. Its default order is latest update and node ID; `sort=identity`
  provides stable multi-page aggregation. It requires an operator session, returns no Token,
  digest, or operator identity, and uses a 300-request-per-minute authenticated operator scope so
  a bounded 10,000-record roster can be safely reloaded. The no-store policy applies throughout.
  Create, rotate, and revoke remain exact-Origin mutations.
- The Dashboard strictly maps and fully paginates both the credential roster and runtime Worker
  rows before merging them, and keeps pending or revoked nodes visible without a running instance.
  The merged snapshot is cached and displayed through local pages of 50 rows, with a hard maximum
  of 200 rendered rows per page. Operators can create, rotate, or revoke a credential from the
  Workers page.
- Create and rotate responses are held only in component memory and displayed in a one-time sealed
  credential panel. The panel cannot be dismissed accidentally, supports explicit clipboard copy,
  and clears the Token from application state and the DOM when closed. The HTTP client allowlists
  only the exact Dashboard reads and Worker credential paths.
- The Dashboard aggregates credential and runtime pages with immutable identity ordering, stable
  total, uniqueness, and progress checks. Rotation sends the record's canonical `updatedAt` as an
  atomic compare-and-set precondition, preventing two concurrent operators from both receiving a
  successful replacement Token for the same prior version. Server and Dashboard boundaries reject
  Token-shaped display names before they can become persistent metadata.
- Native bootstrap schema version 4 selects `agentic-review-worker-auth-v1`. Its Control document
  requires the profile selector and forbids the three historical Worker client-certificate fields.
  The fixed authentication file is a Control-only data-root closed-set member; Executor has no
  corresponding file, Token, or Server transport.
- Native preflight schema v4 binds only the unchanged local Control-to-Executor CNG capability
  signer. The Worker Token is not preflight evidence, a digest input, runtime bootstrap data, or a
  local RPC field.
- Windows production composition rejects schema v3 before opening a Worker credential, loads the
  fixed schema-v4 authentication file for Control, and creates `NewBearerClient`. The platform
  production graph contains no `wincert` import, `NewClient` call, or mTLS evidence input.
- Signed outer-package v1 remains immutable schema-v3 history and explicitly rejects schema v4.
  This preserves fail-closed release behavior until a new signed package and installer profile is
  reviewed.
- The Server storage runtime no longer imports, creates, opens, or closes the historical Server
  binding coordinator or signer. Token-only database startup preserves dormant migration-0012 rows
  without requiring a trusted receipt issuer; those rows remain inert and do not create Worker
  credentials.
- `DatabaseClient` no longer imports or exposes the old coordinator capability, and the production
  database Worker no longer imports receipt persistence or implements its nine mutation/read
  operations. Attempts to invoke those historical operation names return a stable retired error.
- Credential and runtime roster projections replace any Token-shaped historical display name with
  `Redacted worker`, while every current create and registration path rejects such a value before
  persistence.
- Migration `0012_server_binding_persistence_v1.sql` remains byte-identical history. Historical
  persistence, coordinator, signer, and signer-host source remains available for archival tests but
  has no HTTP, Worker-authentication, or storage-runtime consumer.

## Verification

Local verification was explicitly authorized. No command used `test-env`.

```text
git diff --check:                         passed
All-workspace lint:                      passed; Biome checked 334 files
All-workspace typecheck:                 passed
All-workspace build:                     passed
Dashboard tests:                         48/48 passed
Dashboard browser verification:          desktop, 390 px, copy, DOM removal passed
Server Token and credential matrix:      235/235 passed
Contracts matrix:                        28/28 passed
Historical coordinator/persistence:      50/50 passed
Worker unit matrix:                      908/908 passed
Worker role and architecture guards:     19/19 passed
Local WSL database matrix:               164/164 passed
Native focused package tests:             passed
Native all-package compile and vet:       passed
Windows amd64 and arm64 Go builds:        passed
```

The local Node runtime was `26.1.0`, while the repository requires `>=24.20.0 <25`; pnpm emitted the
same engine warning as the initial handoff. The existing ServerStorageRuntime artifact fixture also
fails during ArtifactStorage startup under this local Node 26 environment and reproduces unchanged
on base commit `52dc708`; it occurs before the modified close lifecycle and is not a follow-up
regression.

An exploratory native `go test ./...` also reached the repository's existing local Windows DACL and
`AccessCheck` fixture failures in `servicehostrelease`, `releasepackage`, `secureconfig`, and
`winfile`. The same four package failures reproduce on base commit `52dc708`. The changed native
packages, the updated source-pin guard, `go vet ./...`, and both Windows architecture builds pass.

## Remaining Work

1. Define a separately versioned signed outer-package and installer profile that can publish native
   bootstrap schema v4. The current signed package v1 must remain schema-v3-only.
2. Build the production split-service installer and destination evidence that provisions the fixed
   authentication file separately from signed package content.
3. Delete the now-inert historical Server binding APIs and source in a separate cleanup after
   deciding whether archival executable tests should move out of the production TypeScript tree.
4. Perform deployment recovery exercises for create-response loss, rotation-response loss,
   revocation, and accepted database-backup Token rollback.
