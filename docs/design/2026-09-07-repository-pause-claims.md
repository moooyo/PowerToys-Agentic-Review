# Repository pause at lease claim

Status: implemented and verified on Linux `test-env` on 2026-09-07.

## Behavior and transaction boundary

Pausing a managed repository now holds its existing `queued` and `retry_waiting` jobs at
`claimLease`, in addition to the existing dispatch restriction. The claim path reads the current
`managed_repositories.enabled` value using the parsed execution template's stable GitHub repository
ID. This covers legacy V1 and validation V2 jobs, including jobs without a `work_item_id` association.
A repository rename does not change this identity.

The pause check and lease allocation share the existing `BEGIN IMMEDIATE` transaction. A pause
committed before that claim is observed before allocating an attempt. If the claim commits first,
its lease remains active: pausing does not cancel, fence, or revoke existing execution. Lease
heartbeats and the existing completion, cancellation, and expiry rules remain authoritative.

Skipping a paused candidate does not change its job status, consume an attempt, or rewrite its
frozen execution template. Candidate pagination continues, allowing a lower-priority job from
another enabled repository to be considered after a full page of paused jobs. Enabling the
repository makes held jobs eligible under the existing capability, concurrency, retry-time, and
Worker-slot checks.

## Compatibility and scope

Every existing managed row with `enabled = 0` is paused, including rows whose configuration source
is `discovered`. Discovery alone does not authorize execution. Legacy jobs with no matching
managed repository row retain their previous claim behavior. This compatibility rule does not
exempt an explicitly disabled or discovered managed repository.

There is no schema migration or change to immutable Run plans. The change introduces no repository
quota, global execution limit, durable legacy admission queue, or execution-fairness guarantee.
Priority ordering remains global, so PR priority can still delay Issue work. Those remaining
features are described in the proposed
[scheduling limits and diagnostics design](2026-09-07-repository-scheduling-limits.md).

## Verification

The Linux Server build passed. The focused claim and DatabaseClient suites passed 103 tests;
the full Server suite passed 3,896 tests with one platform-specific skip and zero failures.
Biome passed for the three changed source/test files. Recorded results are
[the focused report](../../artifacts/m25-paused-claim-focused.json) and
[the full Server report](../../artifacts/m25-server-tests.json).

Ten added regressions cover V1/V2 queued and retrying jobs, pause followed by enabling, another
repository after 101 higher-priority paused candidates, continued active-lease heartbeats,
unmanaged legacy compatibility, and disabled discovered repositories. Existing legacy execution
fixtures now explicitly enable scheduling at two initialization call sites; the general
fixture still supports jobs without a managed repository row. Verification used isolated synthetic
data and did not write to any repository's actual PRs or issues.

Implementation and tests:

- [Lease claim transaction](../../apps/server/src/database/database-worker.ts)
- [Claim regressions](../../apps/server/src/database/validation-claim.test.ts)
- [Legacy execution fixtures](../../apps/server/src/database/database-client.test.ts)
