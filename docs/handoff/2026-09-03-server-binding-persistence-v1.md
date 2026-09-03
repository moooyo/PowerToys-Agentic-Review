# Dormant Server Binding Persistence v1 S1 Handoff

Status date: 2026-09-03

Branch: `codex/server-binding-persistence-v1-lab`

Base commit: `2437b312c3b375bf952e98aa76e8305f95d84191`

ADR 0023 is the governing decision for this slice. ADR 0022 remains authoritative for the S0 wire
documents, signature domains, state reducer, and future native evidence boundaries.

## Completed Scope

- Migration 0012 advances the database schema from 11 to 12 and creates the immutable issuer,
  authorization, binding, and append-only revocation aggregate with complete CHECK, foreign-key,
  uniqueness, update, delete, and direct-SQL mutation guards.
- The S1 repository implements exact authorization replay, token-hash-only persistence, atomic
  authorization consumption plus pending binding creation, deterministic request digests,
  first-valid-receipt compare-and-swap, record activation, recovery and active reads, and monotonic
  revocation.
- Startup audits the exact S1 schema, all persistent triggers, the shared authentication-clock
  schema and singleton row, issuer trust, every authorization, and every aggregate. Large tables use
  bounded keyset pagination.
- Authorization expiry advances the persistent `operator_auth_clock` high-water mark. Expiry and
  recoverable identity conflicts commit observed time before returning their stable errors; runtime
  reads require exactly one updated and returned clock row.
- DatabaseClient exposes one opaque, single-consumer S1 capability. Generic requests reject every
  privileged operation, failed or closed owners revoke unconsumed handles, synchronous send failures
  remove pending requests, and fatal storage-integrity codes remain stable.
- The coordinator snapshots exact inputs and Worker outputs, verifies every receipt and response
  association, tracks both public operations and raw settlements, applies bounded open, operation,
  close, and signer deadlines, immediately broadcasts the first terminal cause, and distinguishes
  permanent `CLOSED` from temporary `NOT_READY`.
- Signer trust and provider loading are independent. The provider contract is Promise-only and is
  reserved for an already-isolated child-process IPC proxy. Production loading remains unavailable.
  Candidate cleanup is serialized, must resolve through a native Promise, and permanently poisons
  loading plus quarantines the candidate whenever termination cannot be proved. Adopted-provider
  shutdown likewise releases quarantine only after its native close Promise resolves.
- Signer contexts have one owner. Runtime rollback closes only an atomically unadopted signer lease;
  an already adopted context is never closed by another owner. Coordinator construction validates
  signer adoptability before consuming the one-shot database handle and restores the handle on an
  unexpected adoption failure.
- Server storage lifecycle composes S1 close before artifact-runtime close, preserves owner locks
  until database and storage owner exit are proved, and retains unresolved locks in process-lifetime
  quarantine.

## Zero-Authority Boundary

- Production config and `main.ts` do not load a signer or trust profile and do not receive an S1
  authority result.
- A fresh database remains uninitialized. Existing authority data without the exact trusted signer
  descriptor fails startup closed.
- There is no enrollment route, OIDC enrollment policy, direct candidate TLS listener, Worker-auth
  resolver, revocation veto, Windows writer or reader, Claim, slot, package, or execution consumer.
- The existing environment certificate map remains the only positive Worker identity mapping.
- Exact import allowlists, top-level export allowlists, normalized source SHA-256 pins, runtime return
  member checks, taint checks, and role-bundle verification fence production reachability.

## Frozen Persistent Structure

```text
S1 schema rows:                 35
S1 schema SHA-256:              11ee090c82850cc364523ca074510aa5eaff9b36284413dc3e9d081b8849a269
Persistent triggers:            86
Persistent trigger SHA-256:     e96d19557d5dd3a2db33fa5e34527b1c5061a35a4f2d8482e84b36172fe7ea61
```

Normalized LF source SHA-256 values for the reviewed production boundary are:

```text
aeb61e4c1f2dedafe49977192a72ce7c626ae1bd1555cbe63cf5202ec23ded9f  migrations/0012_server_binding_persistence_v1.sql
14e69fbc1cde7553bdaaa7f90f9d54cc14d9d6b41f688c7cff852679111c0d2b  apps/server/src/database/server-binding-persistence-v1.ts
d64ec2717c051a6e4abb26e0401e0433d490c450b7c78db6b05cab1e8b6c8d05  apps/server/src/enrollment/server-binding-coordinator-v1.ts
d7ec395d41529f395c59206080966503c79d2ca42a3742b876d8de6031f441ba  apps/server/src/enrollment/server-binding-signer-provider-v1.ts
01338da175edb1d2c1cbbf1078ecb629155d04217ab5f97bb32579f16e1368cd  apps/server/src/enrollment/server-binding-trust-profile-v1.ts
128a5f6183041f539544b27457320c78734d5daba374975c297a955a7fa5caef  apps/server/src/enrollment/server-binding-signer-v1.ts
1c4f411d714d29b165e83c6ebd914eb8342b59201dc4470224db27cd8e032dfd  apps/server/src/database/database-client.ts
16d6e8e71b879c05c96d4b1b5b286dfddb5ea3a656d2b5f1d89b7ef1eec5a985  apps/server/src/database/database-worker.ts
1a4ea73c438f21e2b4a1b94925e4df2406abb395a0146e77b35e429e7cab7e5a  apps/server/src/database/protocol.ts
56487cd6b81f70b12276ebf1e6c9e481dd4981b37d9694c56caa860f13ca3ff3  apps/server/src/runtime/server-storage-runtime.ts
```

## Verification

Local verification was explicitly authorized. No command was run on `test-env`.

The exact candidate passed on Windows with pnpm `11.24.0`:

- all-workspace `pnpm typecheck`;
- all-workspace `pnpm build`, including Dashboard Webpack, Worker bundles, and Server output;
- `pnpm lint` across 312 files;
- Contracts `27/27`;
- the nine-file S0/S1, persistence, shutdown, health, artifact, and runtime-focused matrix with
  `174` passed and `6` platform skips;
- the focused DatabaseClient S1 capability matrix with `5` passed and `66` unrelated tests skipped;
- the focused database startup owner-exit helper with `1` passed and `9` unrelated tests skipped;
  and
- Worker role-bundle and zero-execution architecture verification `19/19`.

The local Node runtime was `26.1.0`, while repository engines require `>=24.20.0 <25`; every pnpm
command reported that engine warning but completed successfully. The full database-startup and
migration-backup files were also attempted locally. Their POSIX ownership cases fail closed on
Windows by design; no remote replacement run was made because this task explicitly required local
verification only.

Independent final reviews found no remaining P0-P2 findings after the clock, lifecycle, signer,
settlement, handle-ownership, and ADR consistency fixes.

## Deferred Work

1. A reviewed production child-process signer, protected private-key store, compiled signed trust
   artifact, forced termination and owner-exit proof, backup, rotation, and compromise procedure.
2. S2 enrollment-authority policy, same-origin preauthorization, direct candidate mTLS receipt
   issuance, confirmation, active-status, recovery-download, and revocation routes.
3. The privileged Windows enrollment journal, CNG and certificate creation, receipt-first and
   record-last publication, handle-bound reader, repair command, and crash recovery.
4. Composition of `RecordEvidence` and fresh active-status evidence into immediate-use
   `LiveEvidence`, followed by destination verification and installer composition.
5. Any Worker-auth migration, negative revocation veto, Claim or slot activation, package
   construction, production RoleConfig activation, or canary rollout.

Do not make the S1 tables a positive Worker authentication source. Do not add production signer or
route wiring without updating the exact architecture guards and completing a separate review.
