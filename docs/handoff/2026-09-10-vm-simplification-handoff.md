# VM Worker simplification

Date: 2026-09-10 (Asia/Shanghai). The user selected one long-lived Worker per independent VM,
processing successive tasks, and explicitly requested removal of the unused execution-acceptance
field without compatibility branches. The scoped implementation and remote verification are complete.
The [deployment decision](../design/2026-09-10-single-worker-vm.md) defines the current architecture.

## Review findings and changes

- Removed the unused WindowsAttempt lease, lifecycle, protected SQLite journal, owner thread,
  recovery coordinator and synthetic tests: 15 files, 7,000 lines, two exports and one bundle entry.
  Its only external consumers had been those exports and the dormant bundle entry. Existing Worker
  task leases, ProcessHost and workspace cleanup do not depend on it.
- Retired the proposed privileged execution service, per-attempt OS adapter, signed prepared/
  closed evidence and OS-attestation admission roadmap. Three obsolete design documents now point
  to the VM decision; historical M35 source and verification remain retained in artifacts.
- Removed unconditional OS-proof rejection from Evaluation readiness, claim, Worker execution,
  model-result completion and scoring. Valid results use the existing frozen task, current lease,
  actual invocation and original model-output binding.
- Removed `executionAccepted` from current contracts, Worker/Server records and checks, SQL guards,
  Dashboard fixtures and tests. The Dashboard no longer displays a constant `Not accepted` row.
  The source and SQL definition scan contains no remaining field or WindowsAttempt references.
- Fixed real capability matching: review and summary model support are derived from the configured
  factories. A Worker with ordinary model support alone cannot claim a required Evaluation model
  task; profile-only tasks do not require a model backend. This uses the existing scheduler and
  adds no operator switch, VM attestation or signing system.
- Synchronized both frozen-job SQL guards with the workflow-specific model capability labels.
  Wrong, missing, numeric or extra labels still fail. Current ownership, cancellation, exact frozen
  input and result binding checks remain in place. Unbound V1 model content cannot bypass V2 binding.

The normal operational controls remain: Worker authentication and leases, queue/concurrency limits,
timeouts/cancellation, process-tree termination, desktop exclusion, deferred workspace cleanup,
draining after cleanup failure, provider-value redaction and Evaluation publication restrictions.
Model invocation completion records contain identifiers/digests and observed closure facts; they
are not digital signatures.

## Verified results

Final source `m36-vm-v6`, remote stage `/tmp/agentic-review-m36-vm-20260910-run6`, completed at
`2026-09-09T19:55:00.171Z`. All seven verification commands exited 0.

| Area | Test files | Passed assertions |
| --- | ---: | ---: |
| Worker | 17 | 962 |
| Server | 15 | 362 |
| Dashboard static markup and service adapter | 2 | 102 |
| Contracts | 4 | 334 |
| Domain | 3 | 95 |
| Codex result schema | 1 | 47 |
| Total | 42 | 1,902 |

There were zero failed, skipped or todo tests. Shared packages and Server built successfully;
Worker and Server typechecks passed. Biome checked 64 exact modified TypeScript files and exited 0
with 67 warnings and 2 informational diagnostics; this is not a warning-free lint result. Actual
Worker packaging produced only `worker` and `web-driver` entries, and verified the removed owner
and its 15 source files were absent. Source hashes matched before and after remote verification.

The suites include real synthetic DatabaseClient/HTTP/RPC paths, newly created SQLite databases,
model-result persistence and scoring, capability-aware claims, wrong/cancelled/replaced attempts,
cross-invocation output rejection, ProcessHost/relay cleanup and 13 SQL capability-negative cases.
No production Worker, real provider/model, interactive UI or VM provisioning ran. Dashboard checks
were static rendering/service tests, not a full Umi build or browser acceptance run.

## Source and retained evidence

- Archive: `artifacts/m32-source-20260908-m36-vm-v6.tar.gz`, 1,132 files, SHA256
  `8254956973995f38b6f3df85527c661cf83643f081750a1d30a796b613988dda`.
- Manifest: `artifacts/m32-evaluations-20260908/source-m36-vm-v6.json`, SHA256
  `bd0a0b2327017ec4f903689cd4f3db22bf58676a6091cfa58ca6ea00004c0936`.
- Final receipt: `artifacts/m36-vm-simplification-20260910/verification/verify-run6-20260910/verification/tests/verification-receipt.json`,
  SHA256 `89e4b50a33ba11a1053f119d7e5b38006d1af804727b0a1332d8a1c63e47bb5d`.
- Worker bundle SHA256: `5dd08a60a4b02cd673eefff2b42bd9d299442a68acaa92103aac9f3de3f3990c`.
- Native driver SHA256 remains
  `b49c4a9acf00bbdef28ba3ff136873f06873a9f17b0b81abc716ace6f0f2610a`.

The local `verify-run6-20260910/` directory contains inputs, verification outputs and remaining
synthetic temporary files copied from the owned remote stage. Earlier captures, formatting
before/after files, failed verification and diagnostic receipts remain under the same M36 artifact
root. Run2 exposed a missing Server build prerequisite and invalid profile-only test fixtures;
run4 exposed a missing Issue-report field and SQL capability-rule synchronization. Their failures
were corrected and all selected tests rerun against the final frozen source.

This handoff and final status-document edits postdate v6. They do not change tested source or
SQL definition identities. No commit or push was performed. Preserve untracked files when transferring
the workspace; do not transfer only HEAD or a tracked diff.

## Unreleased schema policy and next work

The product is unreleased. Development directly maintains the current contracts and schema;
database resets, old-version upgrades, data conversion and compatibility migrations are not
required and are not backlog items. The existing SQL files and initialization infrastructure
remain the source of the current schema. No existing database or historical receipt was modified,
and no closed M34 credential was reused. Do not silently reset persistent data.

Next, configure the chosen VM's existing Worker and Evaluation model backend, then perform an
explicitly scoped real provider/model end-to-end run and consecutive-task cleanup checks. There
is no pending protected journal, OS adapter, signing service or execution-attestation project.
Do not claim synthetic verification as real VM/model acceptance.

Keep verification on `ssh test-env`; no local test/build/formatter fallback was used. Never access
or enumerate `apps/worker/.tmp-ui-driver-V7AOfu/`. Continue exclusion-aware source capture, retain
failed runs and use new owned stages. Do not read old private configuration, perform actual
PR/Issue writes, provision accounts/VMs or change firewall/registry without the relevant scope.
