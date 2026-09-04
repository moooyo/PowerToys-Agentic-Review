# Worker Token Release, Recovery, and Cleanup Handoff

Status date: 2026-09-04

Branch: `codex/worker-token-release-recovery`

Base commit: `7bf218b0f055e36d0800249a14bab091c70d425a`

This historical change completed the then-current outer-package/installer-profile data contracts,
retired-source cleanup, and Token recovery work. It did not itself implement the production SCM
installer; ADR 0028 and the later simple-installer work completed the repository-local replacement.

## Completed Scope

- The current outer-package index schema 2/profile `agentic-review-worker-outer-package-v2` contains
  no Worker client credential and binds only bootstrap schema 4. The independent signature envelope,
  algorithm, and domain remain schema 1 and sign the canonical current-profile index bytes.
- `BuildIndex` has no Worker credential field. Package v2 rejects `worker-auth-v1.json` at every
  indexed root and path depth and rejects Token-shaped values in all signed identity and path
  strings. No earlier outer-package profile is accepted or retained as a compatibility surface.
- Split installer profile `agentic-review-worker-split-installer-v2` fixes the installation,
  metadata, trusted-configuration, Control-data, and Executor-data roots. Outer admission and
  installation verification require the matching schema-v4 Control/Executor pair.
- `stagedpackage.SelectInstallerPackage` accepts only current package-v2/schema-4 evidence and
  returns an opaque, non-serializable typed gate with revalidation, cleanup-fatal propagation, and
  deterministic handle ownership through `Close`.
- `installerdestination.Verify` is the only production consumer of that typed gate. It reopens the
  three fixed post-swap roots, requires exact path casing and closed trees, rehashes every signed
  payload, byte-compares the index, envelope, and both bootstraps, reruns compiled outer admission,
  rechecks PE Authenticode, and retains both source and destination handles in non-serializable
  process-local evidence. Its
  one-shot gate borrow expires on callback return, and cleanup-fatal state propagates from both
  sides.
- `deploy/worker/split/provision-worker-auth.ps1` accepts only SecureString or interactive Token
  input, verifies canonical base64url, writes the exact fixed JSON without BOM or trailing newline,
  uses same-directory write-through replacement, and verifies the Control service SID owner plus
  the exact inherited file DACL before and after replacement. It is a credential provisioning helper,
  not a complete SCM installer.
- The retired Server-binding persistence, coordinator, signer, signer-host, state, trust, contracts,
  fixtures, native verifier, and old node-enrollment source were deleted. The database protocol no
  longer contains their nine operations; unknown operations fail closed generically.
- Because the product is still unreleased, the later schema-reset follow-up deletes the dormant
  Server-binding migration instead of preserving it or adding a DROP migration. The Worker Token
  migration is now `0012_worker_token_auth_v1.sql`, the current schema version is 12, and none of
  the four historical Server-binding tables exists in the production schema.
- `docs/operations/worker-token-recovery.md` and the five-case database matrix define recovery for
  lost create/rotate responses, cross-restart revocation, accepted same-schema whole-database Token
  rollback, and post-backup node disappearance. Cross-version restore is unsupported.
- The legacy database-adoption authorization was removed. Existing databases require this
  version's initialization marker; databases from earlier unreleased schemas, including version 13,
  are rejected and must be rebuilt.
- Fresh databases still apply migrations 0001 through 0012 in order. Initialized databases must
  already match every current migration filename and checksum; startup performs no forward
  migration or automatic migration backup. The retired data-directory `backups` namespace and its
  cleanup module were removed.
- The follow-up recovery maintenance mode requires an exact loopback listener plus configured
  operator authentication, purges restored operator login state before listening, closes readiness
  and every Worker/worker-artifact route before authentication or storage access, and suppresses
  GitHub ingestion/polling and the lease reaper. Its database-only storage runtime never opens or
  reconciles the artifact root. Operator login, credential reconciliation, and Dashboard reads
  remain available only through the deployment's local recovery access path.
- ADR 0026 withdraws the unpublished installer transaction v1 model, transaction v2 lab, and
  cross-version store v2 lab. Their 50 source files and the legacy single-service mTLS installer,
  WinSW template, and environment example were deleted. The first supported installer is
  clean-install-only: ordinary install rejects every existing or partial Worker, and no upgrade,
  migration, fallback reader, rollback generation, or transaction journal is a future prerequisite.
  A later explicit cleanup command may remove only objects tied to the same failed-run marker.

## Verification

Local verification was explicitly authorized. No command used `test-env`.

```text
git diff --check:                         passed
All-workspace lint:                      passed; Biome checked 314 files
All-workspace typecheck:                 passed
All-workspace build:                     passed
Dashboard tests:                         48/48 passed
Server route/auth/config matrix:         235/235 passed
Contracts source-boundary matrix:        8/8 passed
Worker unit matrix:                      908/908 passed
Worker role and architecture guards:     19/19 passed
Local WSL database/recovery matrix:      170/170 passed
Native focused package tests:            passed uncached
Native all-package vet:                  passed
Windows amd64 and arm64 Go builds:       passed
PowerShell input/privilege-scope smoke:  passed
Unreleased installer cleanup:           50 transaction/store files plus 3 legacy deploy files removed
Deleted package production references:  none
Current installer-verification Go gate:  passed
Windows amd64 and arm64 rebuild:         passed
```

The local Node runtime was `26.1.0`, while the repository requires `>=24.20.0 <25`; pnpm emitted
the existing engine warning. A full native `go test ./...` continues to hit the pre-existing local
Windows DACL and `AccessCheck` fixture failures in `servicehostrelease`, `releasepackage`,
`secureconfig`, and `winfile`; the same four package failures reproduce on base commit `7bf218b`.
The credential helper's canonical input, rejection, PowerShell 5.1 parsing, and privilege
enable/restore paths were exercised; physical replacement under the fixed ProgramData ACL awaits
the production installer environment.

The installer-destination focused matrix covers the v2 positive closure, alternate-profile and
fixed-root rejection, exact root and payload casing, payload/index/envelope/bootstrap byte drift,
extra entries, repeated and post-close use, borrowed-view expiry, source/destination cleanup-fatal
mapping, and source ownership. It is verify-only and does not claim that a privileged root swap was
performed.

The recovery-maintenance follow-up then passed all-workspace typecheck, build, and lint with Biome
checking 316 files. Windows focused config/composition/health/route/direct-database tests passed 44
cases with the one POSIX database Worker restart case skipped. The exact source in a native WSL ext4
checkout passed all 850 Server tests in 51 files, including the database-only artifact sentinel,
atomic purge rollback, clock preservation, cross-restart old-cookie rejection, and the then-current
six Worker Token recovery cases. The Worker zero-execution architecture check and all 19 role-bundle guards
also passed. No command used `test-env`.

The final pre-release database schema reset was verified from a native WSL ext4 checkout with a
task-local Node 24.20.0 toolchain. The focused database startup, Worker Token recovery, storage
runtime, health, and artifact matrix passed 100/100; the complete Server suite passed 833/833 in 49
files; and Contracts passed 8/8 in 2 files. All-workspace typecheck, build, and lint passed with
Biome checking 312 files. The Worker zero-execution architecture check and all 19 role-bundle guards
also passed. This verification covers fresh schema-12 construction, exact-current initialized
database admission, rejection of lower and unknown applied migration sets before any upgrade or
backup action, absence of the retired Server-binding tables and migration, removal of the legacy
adoption marker, and same-schema-only credential backup recovery. No command used `test-env`.

## Superseding completion and remaining release work

ADR 0028 and the later simple-installer work completed the repository-local Windows clean installer.
It verifies the canonical manifest and raw Ed25519 signature, checks architecture and every required
file before mutation, writes the fixed roots and minimal local configuration, creates the two
restricted virtual-account services, starts Executor before Control, and finally selects automatic
start. The earlier node-specific package, CNG, outer-package, compiled release-profile,
outer-trust, destination-evidence, and receipt mechanisms were deleted rather than reused.

External release work remains: provide the production Ed25519 key material and real amd64 and arm64
payloads, compile the matching public key into each installer, and run the clean-install and native
lifecycle matrix from elevated Windows hosts. No installer transaction recovery, upgrade,
migration, fallback, rollback, receipt, repair, or resume implementation is required.

Server database recovery maintenance ingress is implemented. Deployment operators must still
remove the ordinary reverse-proxy upstream and unsupported bridge-container exposure while recovery
maintenance is active.
