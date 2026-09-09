# Configured scheduling policy integration

Status: M29 has completed delivery slices 3 and 4 of the
[complete scheduling plan](2026-09-07-scheduling-implementation-plan.md). Configured quotas,
queue-credit recovery, repository/class fairness, bounded scanning, and the isolated scale and
connected acceptance are complete. See the [acceptance report](../../artifacts/m29-scheduling-policy-20260907/REPORT.md).

## Current implementation

Migration 25 adds nullable repository and platform active/queue limits, independent platform CAS
and immutable audit, successful admission/claim sequences, repository service history, stable
queue ordering, and durable Worker-specific claim scans. All original Job, Run, source, and result
identities remain in their existing tables. Historical repository configuration snapshots have
fixed strict V1/V2 shapes; V1 never implies that limits were unlimited or equal today's values.

Active limits count every leased/running attempt, including cancellation-requested Jobs and
offline, superseded, or expired-but-unreaped execution. Queue limits count admitted waiting Jobs;
accepted pending Jobs and requests without a valid execution configuration remain separate.
Limit reduction preserves existing work and exposes overage. New lease grants recheck exact
global/repository active counts in the same immediate transaction as the original fenced grant.

Admission and claims use separate least-recent-successful-service tickets. New repository buckets
start at the current ticket, and only successful service updates their ticket. PR streaks saturate
at two and reset only after Issue service. Both Issue workflows share the Issue class. Claim
priority affects order by at most ten minutes without changing the original envelope priority.

Bounded credit recovery returns an unleased paused, proved unsupported, or repository-saturated
reservation to pending without changing its episode or age. Busy Workers, partial inspection,
retry backoff, and a full shared active pool do not justify speculative recovery. A claimant's
inline admission uses only that claimant as a runtime witness; full-fleet unsupported recovery
belongs to the owned background pump.

Each claim reserves 128 Job-candidate inspections across inline admission and claim scanning.
Inline admission can use at most 32 inspections and four repository inspection keys. It shares
the RPC's 16-repository budget with the scanner. The scanner reserves primary discovery progress
and rechecks independently, with unused budget transferable. Primary cursors capture a finite
queue-episode high-water mark and independent generation. Matching Worker identity includes its
database identity, instance, protocol, and capability digest. A completed pass can restart even
without new arrivals, while ordinary heartbeats never erase an unfinished pass.

Compact affected-key producer rows record concurrency releases, bucket admission/policy changes,
and Worker affinity changes without writing every matching Job. Consumer passes capture an event
generation and finite queue high-water mark. Repeated changes do not reset a running pass. Each
work class has its own recheck position; a waiting Issue cannot hide behind the first matching PR.
Non-winning eligible candidates retain their cursor position until a real grant removes them.

Public scheduling diagnostics are strict V3 and include current policy/usage/overage plus typed
queue and active limit reasons. Repository readers receive their exact counts and coarse platform
capacity; only platform administrators receive global/unscoped counts and platform audit. Internal
runtime observations retain strict V2 so candidate inspection does not repeat global counting or
mistake queue limits for structural prerequisites. Observational reads change no scheduling state.

## Accepted verification

Evidence and retained failures are under `artifacts/m29-scheduling-policy-20260907/`. The final Linux
Server regression passed 4,457 tests with one platform-specific skip across 108 files; shared
packages passed 1,210 tests across 35 files. Dashboard passed 2,788 tests across 70 files, and the
production build and type checking passed. A Date-only test clock fixed diagnostics fixtures
whose acceptance time otherwise crossed their fixed observation time; production semantics stayed intact.

The production owner processed the isolated 100,000-Job fixture across 20 repositories. Its tail
candidate was granted after 1,042 real claims, with at most 128 candidate inspections and 14
repository keys per RPC. Claim RTT p95 was 435.606 ms, heartbeat RTT p95 439.191 ms, and pending
V2 cancellation 524.301 ms. These include owner queue delay, not just execution inside the owner.
All predetermined latency/progress gates passed. The later HTTP rate-limit fix leaves that owner
and its dependencies byte-identical, as recorded by the compiled-code bridge.

The final connected session passed all 37 commands: two repositories, both work classes, actual
quota edits, reservation recovery, cancellation and two reruns, exact replay, original V1 history,
both platform audit events, scope denial, and same-cookie access loss/restoration with two automatic
restored reads. The fixture created no execution attempts or actual Worker processes. Actual API
fanout exposed an IP-shared rate limit; reads now have a verified-principal budget separate from
mutations, behind an IP abuse limit. Configuration-event and Run drawers expose a read-only
Refresh access action, so access revalidation does not depend on browser focus behavior.

The browser closed at `2026-09-07T13:17:47.770Z`; the fixture API closed at
`2026-09-07T13:18:00.406Z`. The owned process and both forwarded/listening ports were confirmed
absent. Earlier failed fixtures, harness selectors, and timing observations remain preserved.

All SQLite/runtime acceptance uses the prepared Linux test environment. Authorized local checks
cover pure contracts, client/UI/routes, static typing, and compilation. No automated verification
may write to a real repository PR or Issue without the user's exact approval; see
[AGENTS.md](../../AGENTS.md). All current mutation tests use isolated synthetic data.

The wider platform's real Windows application acceptance, model isolation, deployment identities,
separately authorized publication, notifications, and Prompt/profile evaluation remain open.
