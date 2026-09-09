# Durable Job admission foundation

Status: implemented and accepted in M28 with automated regression and connected reviewer browser
evidence. This is delivery slice 2 of the
[complete scheduling plan](2026-09-07-scheduling-implementation-plan.md). Configured repository and
platform limits, queue-credit recovery, and the complete repository/class fairness and bounded
claim continuation policy remain required. No editable quota is exposed by this foundation.

## Durable identity and waiting episodes

Migration 24 adds `job_admission` and `scheduling_state`. A structurally valid, authorized Job is
persisted once with its actual immutable execution template and a pending admission episode.
Legacy ingestion and V2 initial dispatch/rerun use the same episode-creation helper inside their
existing transaction. Existing semantic identities, activation receipts, M14 links, and M18 routing
remain authoritative; capacity or Worker availability does not fabricate another Job identity.

V2 structural readiness is shared between creation and association. Missing profiles, prompts,
source authorization, checks, or typed UI scenarios remain no-Job prerequisites. An absent or
incompatible Worker instead leaves a real Job pending. A pending Job participates in the existing
live-Job rerun exclusion, cancellation, source supersession, and required execution coverage.

An episode binds `attempt_base` to the waiting Job's current attempt count. `failLease` and the
lease reaper create a new pending episode in the same transaction as the terminal attempt and
retry transition. Failure replay does not create another episode. The reaper only creates an
episode when its exact current Job/attempt update succeeded. Retry time, affinity, immutable
execution data, and attempt history remain unchanged.

## Migration and database guards

The exact version-24 migration hook runs the production template parser before committing its
migration receipt. It backfills every Job without rewriting existing Job, attempt, source, plan,
result, or audit bytes. Existing waiting Jobs are admitted. Active/terminal Jobs receive retained
operational history, not a new queue state. Backfill timestamps explicitly use
`migration_backfill`; they do not claim to recover historical entry times.

Stable numeric GitHub repository identity determines the bucket. Associated identity is retained
even when a template is invalid. Ownership distinguishes resolved, invalid template, unverified
within the observation budget, conflict, and unscoped data. A positive claim-time parse can refine
previously unverified ownership without changing the Job or its episode.

SQL guards reject admission replacement/deletion, missing or stale episodes at lease grant,
incorrect attempt increments, active-attempt insertion without its admitted Job, terminal-attempt
reactivation, admission changes during an active lease, and mutation of remaining Legacy ownership
inputs. The one-time backfill flag cannot be reset. Safe integer exhaustion fails transactionally.
Scoped reads check admission integrity before filtering, so missing rows cannot silently disappear
from a queue or become implicit admission.

## Admission and lifecycle

The foundation selector inspects a bounded pending batch in an immediate transaction. It persists
a captured episode high-water mark and cursor; newly arriving episodes enter a later finite pass.
Inspection sequence allocation precedes row updates in the same transaction. This preserves pass
progress but is not the later successful-service fairness policy.

Admission shares the current source, pause, capability, and actual envelope observations used by
scheduling diagnostics. Busy execution slots, retry backoff, and concurrency holders do not alone
forbid queue admission. One validated compatible executor is positive evidence even when the
larger inventory is partial. A real claimant can supply that witness. Public diagnostic byte limits
do not become permanent execution prohibitions for valid historical JSON with large whitespace;
the witness path retains the existing full claim parser and independent wire-response limit.
This compatibility path does not claim to implement the later bounded claim-owner work policy.

Claims require an admitted episode with the exact pre-grant attempt count both in candidate SQL
and in the final guarded update. The original claim ordering and scan remain otherwise intact.
The current foundation has no finite repository/global quota policy and must not be presented as
the completion of P1 limits or fairness.

One owned scheduling pump coalesces successful mutation notifications and calls bounded request
materialization followed by Job admission. Read responses and the pump's own RPC responses do not
create a wake loop. Claim grants, terminal capacity release, relevant Worker changes, and configuration
changes can wake it. The existing lifecycle timer supplies a five-second fallback independently of
lease-reaper success while preserving the configured reaping interval with a monotonic clock.
Shutdown cancels queued wakes, unsubscribes, and drains the active operation before SQLite closes.

## Public projection

Current diagnostics use strict `SchedulingDiagnosticsV2`; V1 remains an exact historical schema.
Job/Run projections include admission only for waiting Jobs. The public episode carries state,
attempt base, request time, timestamp basis, and admitted time. Internal bucket, sequence, and
service counters are not exposed. Pending diagnostics include `awaiting_admission` as an enforced
claim gate. Active and terminal projections do not show historical admission as a live queue.

Work Items with no Job show `Not scheduled`. Pending Jobs show `Awaiting admission`; admitted
waiting Jobs retain the queue presentation. Run counts separate missing execution, pending
admission, admitted queue, and existing execution outcomes. System counts separately show admitted
waiting Jobs, pending Jobs, and no-Job requests. Both oldest-Job times use immutable Job creation
time, while detail views explain the episode timestamp basis. Existing Job IDs drive cancel/rerun.

## Verification evidence and remaining work

Evidence is under `artifacts/m28-admission-foundation-20260907/`:

- Server: 4,205 passing tests and one skip across 100 files in the final full regression.
  Earlier failures and the intermediate aggregate evidence remain retained. Connected HTTP
  acceptance found a missing admission-filter entry in the route normalization allowlist; the
  production route was corrected and nine HTTP query regressions were added before that final run.
- Shared contracts/domain/Codex packages: 1,178 passing tests across 33 files.
- Dashboard: 2,720 passing tests across 66 files; production build and full package typecheck passed.
- Migration/runtime tests preserve the production guards. Historical migration tests pin their
  intended target version rather than silently including later operational tables.

The final connected reviewer browser passed 20 commands, including actual pending cancellation
and rerun, exact result-bound observations, scope denial, same-session access revocation and
restoration. Five HTTP observation phases passed with unchanged core rows around reads. The
production pump admitted the Legacy Job and rerun before the explicit private admission check,
which admitted zero additional Jobs. A repeated rerun receipt did not change business rows.
All attempts remained absent; this was control-plane acceptance, not Worker execution.

The browser closed at `2026-09-07T10:06:29.175Z`; HTTP and SQLite closed explicitly at
`2026-09-07T10:08:24.777Z`, before the fixed deadline, without errors. Original Job/episode
identities, frozen source/plans/configuration, and previous history were preserved. Root visually
reviewed the missing-Prompt, cancellation, rerun, admitted, and revoked screens. See the
[acceptance report](../../artifacts/m28-admission-foundation-20260907/REPORT.md) and its final
evidence assertions for exact scope and retained failed attempts.

The full P1 policy and the platform's remaining
Windows application, model isolation, deployment identity, publication, notification, and evaluation
work remain open. All verification follows [AGENTS.md](../../AGENTS.md); local/test-env authorization
does not authorize any real repository PR or Issue mutation.
