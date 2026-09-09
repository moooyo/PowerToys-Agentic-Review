# Current scheduling diagnostics

Status: implemented and verified in the working tree with Linux integration and aggregate
connected browser evidence. Recovery interruptions are retained in the acceptance report.
This is delivery slice 1 of the
[scheduling implementation plan](2026-09-07-scheduling-implementation-plan.md). Configured limits,
durable admission, queue-credit recovery, and repository/class fairness remain required later
slices. No capacity setting is presented as enforced by this change.

## Read model and authority

Three authenticated GET routes expose a strict `SchedulingDiagnosticsV1` observation:

| Route suffix under `/api/v1/operator` | Authority and subject |
| --- | --- |
| `/repositories/:repositoryId/jobs/:jobId/scheduling` | Repository read permission and the exact associated work item/Job. |
| `/repositories/:repositoryId/review-runs/:reviewRunId/requests/:requestId/scheduling` | Repository read permission and the exact Run/request; observes its latest Job or current prerequisites when no Job exists. |
| `/scheduling/jobs/:jobId` | Platform administrator; includes unassociated Legacy Jobs. An associated Job retains its real repository subject. |

Authorization and final reads share one synchronous SQLite read snapshot. The explicit operator
allowlist is separate from internal RPC registration. No read assigns work, changes attempts,
advances a scheduler cursor, synchronizes GitHub, repairs corrupt rows, or dead-letters a Job.
Responses do not expose Worker identities, foreign concurrency holders, credentials, raw
capabilities, execution payloads, or global usage counts.

The DTO distinguishes waiting, executing, and terminal subjects. A request without a Job is
different from queued work. Reasons identify existing claim gates, current request prerequisites,
or observations. Current source/authorization observations are not represented as newly enforced
claim gates. Legacy source checks preserve the existing multi-epoch withdrawal interpretation;
they do not add a new current-policy requirement to historical Legacy execution authority.

## Agreement with existing execution behavior

`database/scheduling-eligibility.ts` contains the unchanged template/reproduction parser, Legacy
requirement matching, prepared V2 runtime-label checks, and final envelope/schema/response-size
validation shared with the actual claim path. Internal read projections use inspected Worker
identities and fixed valid lease placeholders; they allocate no lease or random execution identity
and return none of the projected envelope. Claims retain their original state transitions,
ordering, limits, timestamps, and failure behavior.

Diagnostics count active attempts until they become terminal, including expired but unreaped
attempts and cancellation in progress. A free execution slot and a valid envelope must belong to
the same Worker. No-Job readiness reuses existing dispatch runtime support and checks the current
Run association limit. It does not require free Worker slots merely to construct a valid Job.

Persisted local capacity is an observation; the next claim provides a fresh value. Registration's
default zero is not a capacity report. `last_seen_at` also changes during registration and lease
activity, so the displayed matching-Worker contact time does not establish the age of a capacity
report. Canonical timestamps remain unchanged during clock rollback.

## Bounded work and honest uncertainty

- Responses are limited to 64 KiB, 32 typed reasons, and 64 displayed requirement names of at most
  128 characters. Omitted or unrepresentable names are explicitly reported.
- Worker selection first reads at most 129 IDs using existing indexed status/contact or
  node/instance order. Only 128 selected payloads and indexed active-attempt counts are inspected;
  the extra row establishes partial coverage. A global computed sort is not used before LIMIT.
- Requirement traversal has a finite visit budget. Envelope projections have a cumulative work
  budget, with reuse only for validated ASCII identity lengths that produce equivalent schema and
  byte checks. Exhaustion remains a partial observation.
- An oversized raw JSON representation is not itself proof that the final claim response is too
  large: whitespace and requirements have different wire behavior. Reads that cannot inspect a
  stored value within budget report incomplete inspection instead of inventing an execution gate.
- Absence or unavailability of every compatible Worker requires complete relevant inspection.
  Partial coverage cannot establish absence, reserve capacity, promise queue position, or give an ETA.

## Dashboard behavior

The selected Run request and Job detail show current scheduling separately from frozen readiness.
Visible waiting and executing observations refresh every five seconds; terminal observations stop
polling. Hidden views, changed subjects/sessions, and access loss cancel the transport and discard
previous observations. A failed request does not retain stale diagnostic data. Sample mode states
that live observations are unavailable and never substitutes samples for a production error.

The shared HTTP client retains its existing two-argument GET behavior and 2 MiB default. Diagnostic
calls opt into a caller AbortSignal and the smaller 64 KiB bound through three exact allowed GET
paths. Cancellation cannot reuse partial bytes or trigger a late permission event.

## Verification boundary

Evidence is collected in `artifacts/m27-scheduling-diagnostics-20260907/`. Initial Linux failures
exposed fixture attempts to rewrite frozen M18 data and to mark success without a stored result;
the production immutability guards remain intact. Test fixtures must establish their intended
state through valid creation and completion paths.

The complete Linux Server suite passed 4,068 tests with one skip; shared packages passed 1,126;
the complete Dashboard suite passed 2,678. The focused database diagnostics suite passed 45.
Server build, connected production Dashboard build, and full Dashboard typecheck passed.

The original persistent browser accepted all 12 commands, including automatic refresh, capacity
and pause changes, same-session permission revocation, stale observation removal, and the restored
no-Job request. A later test-env reboot removed the original volatile Server closeout records;
that Server's graceful shutdown is not claimed. Recovery used the same production source and
bundle with a fresh isolated database in persistent storage. All eight HTTP states passed with
unchanged core rows around reads. Recovery browser evidence spans separate sessions because of
an SSH signer failure and a controller command missing its required timestamp; their failed
reports are retained. The final Job/request browser and recovery Server closed explicitly, with
no active fixture lease or shutdown errors. This is aggregate evidence, not a claim that the
recovery controller passed uninterrupted. See the
[acceptance report](../../artifacts/m27-scheduling-diagnostics-20260907/REPORT.md).

The full platform objective remains open, including the
later scheduling slices, actual Windows application acceptance, deployment identities, optional
model isolation, separately authorized publication, notifications, and prompt/profile evaluation.

All verification follows [AGENTS.md](../../AGENTS.md): no real PR or Issue mutation is authorized by
implementation, local execution, or test-env permission. Fixture data is isolated and upstream
integrations remain disabled during connected acceptance.
