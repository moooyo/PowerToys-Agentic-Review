# Worker Token Release, Recovery, and Cleanup Handoff

Status date: 2026-09-04

Branch: `codex/worker-token-release-recovery`

Base commit: `7bf218b0f055e36d0800249a14bab091c70d425a`

This change completes the outer-package/installer-profile data contracts, retired-source cleanup,
and Token recovery work. It does not implement the complete production SCM installer.

## Completed Scope

- Outer-package index schema 2/profile `agentic-review-worker-outer-package-v2` omits the historical
  mTLS identity and binds only bootstrap schema v4. The existing signature envelope, algorithm, and
  domain remain schema v1; the signed canonical index bytes prevent v1/v2 interchange.
- `BuildBearerTokenIndex` has no Worker credential-specific or mTLS field. Package v2 rejects
  `worker-auth-v1.json` at every indexed root and path depth and rejects Token-shaped values in all
  signed identity and path strings. Historical package v1 and its canonical golden bytes remain
  unchanged.
- Split installer profile `agentic-review-worker-split-installer-v2` fixes the installation,
  metadata, trusted-configuration, Control-data, and Executor-data roots. Outer admission and
  installation verification require the matching schema-v4 Control/Executor pair.
- `stagedpackage.SelectBearerTokenInstallerV2` rejects historical v1 evidence and returns an opaque,
  non-serializable typed gate with revalidation, cleanup-fatal propagation, and deterministic handle
  ownership through `Close`.
- `deploy/worker/split/provision-worker-auth.ps1` accepts only SecureString or interactive Token
  input, verifies canonical base64url, writes the exact fixed JSON without BOM or trailing newline,
  uses same-directory write-through replacement, and verifies the Control service SID owner plus
  the exact inherited file DACL before and after replacement. It is a credential provisioning helper,
  not a complete SCM installer.
- The retired Server-binding persistence, coordinator, signer, signer-host, state, trust, contracts,
  fixtures, native verifier, and old node-enrollment source were deleted. The database protocol no
  longer contains their nine operations; unknown operations fail closed generically.
- Migration `0012_server_binding_persistence_v1.sql` remains byte-identical with SHA-256
  `aeb61e4c1f2dedafe49977192a72ce7c626ae1bd1555cbe63cf5202ec23ded9f`.
  Startup compatibility preserves representative rows from all four legacy tables across v12/v13
  without creating a Worker credential.
- `docs/operations/worker-token-recovery.md` and the six-case database matrix define recovery for
  lost create/rotate responses, cross-restart revocation, accepted whole-database Token rollback,
  post-backup node disappearance, and pre-v13 restoration.
- The follow-up recovery maintenance mode requires an exact loopback listener plus configured
  operator authentication, purges restored operator login state before listening, closes readiness
  and every Worker/worker-artifact route before authentication or storage access, and suppresses
  GitHub ingestion/polling and the lease reaper. Its database-only storage runtime never opens or
  reconciles the artifact root. Operator login, credential reconciliation, and Dashboard reads
  remain available only through the deployment's local recovery access path.

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
```

The local Node runtime was `26.1.0`, while the repository requires `>=24.20.0 <25`; pnpm emitted
the existing engine warning. A full native `go test ./...` continues to hit the pre-existing local
Windows DACL and `AccessCheck` fixture failures in `servicehostrelease`, `releasepackage`,
`secureconfig`, and `winfile`; the same four package failures reproduce on base commit `7bf218b`.
The credential helper's canonical input, rejection, PowerShell 5.1 parsing, and privilege
enable/restore paths were exercised; physical replacement under the fixed ProgramData ACL awaits
the production installer environment.

The recovery-maintenance follow-up then passed all-workspace typecheck, build, and lint with Biome
checking 316 files. Windows focused config/composition/health/route/direct-database tests passed 44
cases with the one POSIX database Worker restart case skipped. The exact source in a native WSL ext4
checkout passed all 850 Server tests in 51 files, including the database-only artifact sentinel,
atomic purge rollback, clock
preservation, cross-restart old-cookie rejection, and the six Worker Token recovery cases. The
Worker zero-execution architecture check and all 19 role-bundle guards also passed. No command used
`test-env`.

## Remaining Release Work

Repository-local implementation remains for the production SCM installer, destination
re-verification consumer, fixed WinSW validation, CNG provisioning, service creation and policy,
and installer transaction recovery. Server database recovery maintenance ingress is implemented;
deployment operators must still remove the ordinary reverse-proxy upstream and container published
port while it is active.

External release work remains to produce the actual Authenticode-signed ServiceHost, role bundles,
outer-package-v2 signature, compiled release profile, and compiled outer-trust material, then run
the complete installation and recovery matrix on privileged Windows amd64 and arm64 hosts. Those
artifacts and machine-level results cannot be replaced by placeholder credentials or unit tests.
