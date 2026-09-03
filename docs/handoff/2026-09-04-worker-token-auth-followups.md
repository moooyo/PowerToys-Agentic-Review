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
- Signed outer-package v1 remains immutable schema-v3 history. Outer-package v2 and split installer
  profile v2 bind only schema-v4 bootstraps, omit mTLS/package credential material, reject
  `worker-auth-v1.json` as a payload, and require the retained staged-evidence typed gate.
- The Server storage runtime no longer imports, creates, opens, or closes the historical Server
  binding coordinator or signer. Token-only database startup preserves dormant migration-0012 rows
  without requiring a trusted receipt issuer; those rows remain inert and do not create Worker
  credentials.
- `DatabaseClient` no longer imports or exposes the old coordinator capability, and the production
  database Worker no longer imports receipt persistence or implements its nine mutation/read
  operations. Unknown internal database operations now fail closed through the generic unsupported
  operation boundary; the historical operation vocabulary no longer exists in the protocol.
- Credential and runtime roster projections replace any Token-shaped historical display name with
  `Redacted worker`, while every current create and registration path rejects such a value before
  persistence.
- Migration `0012_server_binding_persistence_v1.sql` remains byte-identical history. The historical
  persistence, coordinator, signer, signer-host, contracts, fixtures, and native verifier source
  was subsequently deleted. ADRs and handoffs preserve the design record, while the startup
  compatibility test preserves representative rows in all four legacy tables across v12/v13
  startup without creating a Worker credential.

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

1. Produce actual signed outer-package-v2 release material.
2. Build the production split-service SCM installer and destination evidence that provisions the
   fixed authentication file separately from signed package content.

The later `codex/worker-token-release-recovery` change completed the v2 package and installer-profile
contracts, deleted the retired Server-binding implementation island, and added the six-case Token
recovery matrix plus `docs/operations/worker-token-recovery.md`. Only the two release and
installation workstreams above remain; the production installer still includes repository-local
implementation as well as privileged environment validation.
