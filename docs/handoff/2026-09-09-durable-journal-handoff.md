# Durable journal continuation

Historical handoff. On 2026-09-10 the user selected one long-lived Worker per independent VM.
The unused WindowsAttempt implementation described below was subsequently removed as duplicate
infrastructure. Follow [the VM deployment decision](../design/2026-09-10-single-worker-vm.md) for
the current architecture. The recorded M35 source and verification results remain historical.

Updated: 2026-09-10 (Asia/Shanghai). The user restored `ssh test-env` and approved continuing after
[M34 Windows UI acceptance](2026-09-09-windows-ui-accepted-handoff.md). M35 durable lifecycle storage
and recovery passed the scoped Linux verification. Production Windows execution acceptance remains
unavailable; Worker main does not install the new owner or recovery coordinator.

## Implemented and verified scope

- `apps/worker/src/execution/windows-attempt-journal-store.ts`: an explicit SQLite schema,
  atomic full-fence CAS, record/head/global revision consistency, derived lease windows and
  independent commit-clock checks. Unknown commit results are never reported as rollbacks.
- `windows-attempt-journal.ts`, `windows-attempt-journal-owner.ts` and
  `windows-attempt-journal-files.ts` in the same directory: an asynchronous client and dedicated
  owner thread, protected POSIX file observations, exclusive owner lock, explicit create/open,
  initialization marker, timeout poisoning and acknowledgement-plus-exit closure.
- `windows-attempt-recovery.ts`: bounded initial/final inventory, original Worker ownership,
  per-lease reconciliation, retained failures and concurrent revision detection. A clear snapshot
  is not an admission capability; `executionAccepted` stays false.
- New store, owner and recovery tests, plus the shared synthetic lease fixture. Owner coverage
  includes real restart, unknown reply after commit, file replacement, exclusive locking,
  hot-journal recovery and close races. All five selected test files passed on Linux.
- `apps/worker/scripts/build-worker-bundles.mjs` packages the independent owner entry. Worker
  main does not install or start it. No Evaluation or model execution gate was relaxed.

The [design](../design/2026-09-09-windows-durable-journal-recovery.md) records detailed semantics,
limits and remaining integration. The protected file wrapper currently rejects Windows because
POSIX modes are not Windows ACL proof. A qualified Windows service/storage adapter remains open.

## Verification results

Independent static reviews led to fixes for exact schema filtering, optional field typing,
ancestor ownership and identity checks, parent-directory fsync, Worker startup error handling,
shared close promises, required close acknowledgement and a reserved close control slot. The
latest code and tests include those changes. Runtime verification additionally exposed TypeScript
control-flow narrowing and Biome import/void-return errors. The final source uses a declared
`never` failure function and explicit fail-then-return branches without changing runtime behavior.

The test/build/format workflow and retained results are under
`artifacts/m35-journal-20260909/verification/`. Its exact five test files are the new journal,
journal-store and recovery tests, existing Worker lifecycle tests and domain lifecycle tests.
Final run4 completed at `2026-09-09T19:14:46.700Z` against source v3, with every command exiting 0:

| Check | Result |
| --- | --- |
| Shared contracts/domain/codex builds | Passed |
| Worker typecheck | Passed |
| Journal store | 31 passed |
| Journal client/owner | 26 passed |
| Recovery | 25 passed |
| Existing Worker lifecycle | 17 passed |
| Existing domain lifecycle | 16 passed |
| Total | 115 passed, 0 failed, 0 skipped |
| Biome, nine exact new TypeScript files | Exit 0; nine non-null-assertion warnings in synthetic tests/fixture |
| Actual Worker bundle builder | Worker, web-driver and journal-owner entries produced |
| Built owner fixture | Create and reopen each acknowledged close and exited 0 |

The verification script checks exact test-file identities, every assertion result, bundle metadata
and source hashes before/after execution. The built-owner fixture starts only the owner entry
against newly created synthetic files. No Worker main, UI, model, provider or service was started.

Source and evidence identities:

- Archive: `artifacts/m32-source-20260908-m35-journal-v3.tar.gz`, 1,143 files, SHA256
  `7dc6fc96751bd8eb9842521f3c3665cafb74d261232808d9517c1ce51e142a3c`.
- Manifest: `artifacts/m32-evaluations-20260908/source-m35-journal-v3.json`, SHA256
  `c0e009eb6a634dbb0a6f261b93d5cf40cd9dc7852f3747d699d42a5216d7372f`.
- Final receipt: `artifacts/m35-journal-20260909/verification/verify-run4-20260910/verification/tests/verification-receipt.json`,
  SHA256 `5938cacee161f54b6bb56d8787488f5c6b169745342cb20da641ba2e08bb118c`.
- Owner bundle SHA256: `903ea557f02464015d81cc86bccf1bcac701414c36a8d5e5aadaf5cf5e777c67`.
- Remote stage: `/tmp/agentic-review-m35-journal-20260909-run4`. Inputs, original reports and
  remaining synthetic fixture files were copied into the local `verify-run4-20260910/` directory.

The final documentation updates postdate v3; do not claim the entire final documentation tree
matches that capture. Production source and test identities remain associated with v3. The M34
native driver remains unchanged; its acceptance and closed credentials were not rerun or reused.

Historical failures remain available. Format run1 failed before extraction on incompatible GNU
tar flags. Format run2 succeeded and retained reviewed before/after files. Verify run3 failed
Worker typecheck; independent diagnostics on its unchanged v2 snapshot passed all 115 tests and
reported the lint errors fixed in v3. No prior output was replaced. Intermittent SSH agent signing
refusals were retained; subsequent transfers and execution succeeded without reading or changing
authentication files. No local SQLite, tests, builds or formatter were substituted.

## Superseded continuation

The former follow-up plan for a protected Windows service, execution adapter, registered signing
authority, Server challenges and OS-attestation admission is retired. Do not restart it from this
handoff. Current work follows the VM deployment decision and reuses the existing Worker task
leases, ProcessHost shutdown, workspace cleanup and model/result records.

M34 UI acceptance remains relevant to its unchanged native implementation. M35 verifies the
removed dormant implementation only; its test count must not be presented as current coverage.

## Persistent constraints

Use Chinese for user-facing communication and English for code/comments/documentation. Windows
commands use PowerShell. Server/SQLite verification stays on `ssh test-env`. The prior scoped
local Windows UI acceptance is complete and does not justify a new local SQLite fallback.

Never access, enumerate or inspect metadata beneath `apps/worker/.tmp-ui-driver-V7AOfu/`. Use the
existing exclusion-aware capture helper. Do not read prior private configuration or credentials,
reuse closed fixtures, make real PR/Issue writes, invoke providers/models, or perform account,
registry/firewall, sandbox or VM setup without the corresponding authorization. No commit or push
has been performed; new untracked source files must be included when transferring work.
