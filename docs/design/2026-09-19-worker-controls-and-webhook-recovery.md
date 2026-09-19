# Worker execution controls and webhook recovery

Status: implemented behavior and the recorded functional/media/native-cancellation scopes are
documented in the [handoff](../handoff/2026-09-19-worker-controls-and-webhook-recovery.md). Operational
closeout is complete and temporary capacity settings are restored. Git publication is a separate handoff.

## Scope

Implement a per-Worker E2E permission, recoverable webhook intake, durable relay delivery, and a
complete real E2E workflow using a small pinned upstream change. Preserve existing reports and
failed receipts. Production hosting and sustained workload/storage-capacity acceptance are deferred.

The Worker control selects whether the Worker can take only static application Tasks or also
execution Tasks. Local screenshots remain allowed; this setting does not remove general model
shell access or introduce a new operating-system sandbox.
Static investigation images and videos must never enter the GitHub media publication pipeline.

## Worker permission

Each authenticated Worker has one versioned, persisted Server setting: `e2eEnabled`, defaulting to
false. The existing Worker role and supported kinds can narrow eligibility but cannot grant this
permission. Server admission and Worker execution both enforce the setting. Static task kinds must
not carry an executable policy; malformed historical tasks cannot bypass admission by their kind.
There is no second local E2E enable flag.

Administrator sessions read `GET /api/workers` and change `POST /api/workers/:id/e2e` using
`{version, e2eEnabled}`. Updates persist a new version and audit record; a stale version conflicts.
Authenticated Workers send `{supportedKinds}` to `POST /api/worker/policy` and receive their
`workerId`, policy `version`, `e2eEnabled`, and `effectiveKinds`. Observing a Worker or advertising
capability never grants permission. Static kinds are `pr-review` and `issue-investigate`; other
kinds use the execution boundary and retain their normal task prerequisites.

Disabling E2E prevents new execution claims and cancels owned active execution tasks. Process and
desktop cleanup remain available. The UI distinguishes a requested disable from confirmed cleanup
and from an offline Worker whose state cannot yet be confirmed. An unavailable E2E Worker leaves
execution tasks queued without blocking eligible static work.

The cancellation request travels in the existing Server heartbeat response. Already accepted
terminal checkpoints can still finish report delivery, and usage/cleanup replay remains active
when an execution-only Worker has no eligible claims. `disabling` represents an online Worker with
unreleased execution ownership; `awaiting_confirmation` includes unresolved offline ownership or
an enabled Worker whose contact/capabilities are not confirmed. A changed setting or expired
heartbeat does not release the global execution lease or the machine desktop guard.

## Event intake and publication

Webhook delivery, Task execution, and comment delivery retain separate states. An HTTP `202` response
with `accepted` or `duplicate` identifies committed intake or its existing receipt, not Task creation
or successful execution. `ignored` can be returned without storing an inbox record. Persisted receipts
retain processing attempt history, with scoped list/detail reads and versioned, idempotent explicit
retry. Automatic transient processing retries are bounded to three attempts by default; an explicit retry begins
a new cycle without replacing prior attempts or the known cumulative count.

The API is `GET /api/github/webhook-deliveries`, `GET /api/github/webhook-deliveries/:deliveryId`,
and `POST /api/github/webhook-deliveries/:deliveryId/retry`. The retry body is
`{version, idempotencyKey}`. Only a failed canonical receipt is eligible, and repository management,
task creation, repository scope, and applicable E2E execution grants are required. List/detail
remain readable with intake disabled. Repeated identical retry commands observe current state;
changed payload under the same key or a stale version returns HTTP `409`.

Both assignment and E2E intake recover an already committed Task before authorizing any new work.
Retrying a failed intake cannot duplicate that Task or rerun its desktop work. If no Task exists,
retry rechecks current authority and source identity. A previously executed terminal Task uses the
separate explicit recovery/new-task workflow. Unknown external writes remain read-only reconciliation.

The relay persists events it has received before attempting local delivery. Bounded retry and restart
recovery reuse the exact signed bytes and delivery identity. A matching receiver acknowledgment is
required for delivered status. Failures before relay receipt require external delivery diagnosis and
explicit redelivery; reconnecting a socket does not reconstruct missing events.

`WebhookRelaySpool` is an independent SQLite module used by a relay adapter, not a new Server
background service. The adapter authenticates its upstream source and owns calls to `enqueue` and
`runNext`; the module has no upstream redelivery API or credential loader. Its supplied transport
targets loopback `/api/github/webhook` only. HTTP `202` must match the delivery ID and a recognized
acceptance state; malformed success responses do not count as delivered. Network errors, timeout,
HTTP `429`, and `5xx` retry within the allowance, while permanent rejection remains failed.

Defaults are six initial delivery attempts, 1,000 retained records, 2 MiB per payload, 64 MiB of logical
admission storage including reserved attempt history, and 128 MiB of SQLite pages. The latter
excludes journal/filesystem overhead. Request timeout is 20 seconds, exponential delay is one
second capped at 30 seconds, and valid `Retry-After` waits are respected up to one day. The module
does not automatically prune records or run background timers; full capacity rejects new intake.

The relay's `retryFailed` method is a separate contract from the intake HTTP retry. It receives
`{deliveryId, expectedVersion, requestId, reason, additionalAttempts?}` and queues only a failed
record at the inspected numeric version. Allowed reasons are `receiver_available`,
`configuration_corrected`, and `manual_recovery`. An identical request ID/payload returns the
current record and original retry receipt; changed payload conflicts. The operation does not
itself send an HTTP request, and delivered records cannot requeue.

Each explicit batch defaults to six additional attempts, permits 1-100, and must fit the configured
lifetime ceiling, which defaults to 100 attempts. Cumulative attempt numbering and all prior history
remain intact. Capacity reservation, retry receipt, version change, and requeue commit in one
transaction or fail together. Re-enqueueing the same signed envelope never substitutes for explicit
failed-delivery retry. The spool database's additive schema v1-to-v2 migration only adds its version
and retry metadata; the application database remains `investigation-v4`.

GitHub media publication independently binds the stored `pr-e2e` Task and its execution grant,
Server-sealed report, pinned subject, assigned producer attempts, and trusted E2E tool observations.
Static Task media or forged producer fields must produce no upload attempt. Local screenshots and
general model shell access remain outside this publication guard.

## E2E scope and fixture

The E2E model receives the complete frozen task scope and execution policy. Runtime observations must
use supported launch modes, actual result controls, intact text encoding, and expectations supported
by the pinned source and dependencies. Repeated unchanged blockers do not justify repeated execution.

The current fixture is the open draft [owned-fork PR #15](https://github.com/moooyo/PowerToys/pull/15),
using the actual merged revision of upstream [PowerToys PR #47506](https://github.com/microsoft/PowerToys/pull/47506).
Head `c46083dd8d6012f76ab328fabcb1a4d17cf135aa` has sole parent/base/merge base
`65112a7b05ab4a05a24f70933e82711037eebeba`. Its one-commit, four-file +21/-1 change belongs entirely
to PowerToys Run Calculator. Both complete trees have 9,510 entries and no gitlinks or unsupported
entries. This is a real upstream merge after intervening submodule removal, not the original PR
author-branch head or a synthesized patch. Fixture creation and source inspection are not functional
acceptance. A subsequent isolated build-readiness check passed after the minimal Spectre-component
repair, with no model, application launch, or Task. The fifth real Task then independently checked
out and built the source, sealed 1,321 outputs, and launched Launcher. Three registered features
passed four actual Calculator UI assertions with four PNGs and one valid MP4, including the implicit
positive control before the absence assertion. The final Task remains blocked because an earlier
feature's two assertions against static `Title`/`Path` accessibility labels were never executed.
Individual behavior evidence does not accept every registered feature in that fifth Task. Its
GitHub media subsequently loaded four PNGs and played/decoded the MP4, without changing the blocked
outcome. A sixth same-scope Task independently rebuilt and launched the source and completed exactly
three registered features and all four required UI assertions, with four PNGs and one valid MP4.
Its workspace cleanup and native lease release are subsequently confirmed. The separate
active-window/recording observers failed before disable in the seventh and eighth Tasks. Both
completed naturally; the eighth also has confirmed cleanup. A separate isolated native W4 fixture
then passed using synthetic source/upstream/provider inputs and real runtime/window/FFmpeg, flag-API
cancellation, and cleanup. No real model ran. This supplemental result does not relabel the two
real-PR observer failures. Operational closeout is complete; Git publication is a separate handoff.
Required scenarios are:

| Scenario | Required observation |
| --- | --- |
| Explicit `sqrt(-1)` with Calculator action keyword `=` | The actual result `SubTitle` explicitly reports that complex numbers are unsupported. A generic error or the static control label is insufficient. |
| Implicit `sqrt(-1)` without `=` | No Calculator error result row is displayed, after a same-mode positive control confirms that implicit `2+2` produces the Calculator result `4`. |
| Explicit `2+2` with `=` | The actual Calculator result is `4`. |

The implicit-query positive control is required in the same configured application session and
without `=`. An absent error row alone is insufficient: a disabled Calculator plugin would also
produce no Calculator error. Record the normal Calculator result before asserting absence for
`sqrt(-1)`; other plugins' results are allowed and do not satisfy the positive control.

The sixth Task's command included observed `QueryTextBox`/`ListItem` mapping as diagnostic context
without changing code, gates, source, API, or the four expected observations. It rebuilt, reran the
real assertions, and captured fresh media without reusing previous build outputs. The fifth Task's
blocked feature and report remain preserved. The accepted sixth report retains that source unit
tests were read rather than executed and the evaluator's concrete runtime type was not independently
measured. Other plugins logged initialization errors, while Calculator participation in global
queries was verified. These limits do not add new required validation.

Actual standard HTTPS GitHub redelivery is accepted only through the owned relay's cached duplicate
response for the same delivery GUID and raw bytes. The four pre-existing Task/Attempt/invocation
identities remained unchanged; a second entry into the Server receiver was not tested. Earlier
native duplicate/commit recovery and isolated relay restart evidence retain their separate scopes.

The unchanged all-changed-path coverage gate still applies. Passing the frozen scope into the model
does not implement scope-aware coverage narrowing or allow another changed component to be omitted.
[PR #14](https://github.com/moooyo/PowerToys/pull/14), which used the original author-branch head,
remains an open draft with two unsuccessful live sequences preserved. Three of its Tasks were
cancelled and one was blocked before any model invocation. Its source includes two unsupported
gitlinks; the current implementation does not add submodule support. The replacement fixture does
not rewrite that failure history. See the [handoff](../handoff/2026-09-19-worker-controls-and-webhook-recovery.md)
for the first sequence's monitor failure and nonzero Worker shutdown boundary.
The earlier owned-fork [PR #13](https://github.com/moooyo/PowerToys/pull/13), mirroring upstream
[PR #47767](https://github.com/microsoft/PowerToys/pull/47767), is superseded, unexecuted, and closed.
Only its open/closed state changed; its refs and body remain preserved, with no comments or reviews
created by the abandoned run. That PR also changes CmdPal and is not accepted through a Run-only
scenario list.

Earlier Peek loading, navigation, and Launcher unit-conversion failures retain their original status.
Only supported diagnostic evidence may establish their causes. Choosing a simpler fixture does not
convert those historical failures into passes.

## Implementation map

| Area | Current implementation |
| --- | --- |
| Worker contracts and control persistence | `packages/contracts/src/investigation-worker-controls.ts` and `apps/server/src/investigation/worker-controls.ts`; records use the active investigation store and do not introduce a new schema identity. |
| Admission, disable, and heartbeat cancellation | `apps/server/src/investigation/service.ts`, `resource-scheduler.ts`, and `app.ts`. |
| Worker policy and execution guards | `apps/worker/src/investigation/http-client.ts`, `task-service.ts`, and `runtime.ts`; existing cleanup/usage replay is retained when disabled. |
| Webhook contracts and controls | `packages/contracts/src/investigation-webhook-deliveries.ts`, `apps/server/src/investigation/webhook-delivery-controls.ts`, and `webhook-delivery-http.ts`. |
| Assignment and E2E recovery | `apps/server/src/investigation/webhook-intake.ts` and `e2e-intake.ts`; receipt recovery precedes creating new work. |
| Relay spool | `apps/server/src/investigation/webhook-relay-spool.ts`; companion integration and real delivery acceptance require separate evidence. |
| Static-media publication boundary | `apps/server/src/investigation/e2e-media-publication.ts` and its runtime integration. |
| Frozen E2E scope | `apps/worker/src/investigation/e2e-agent-runner.ts`. |
| Dashboard operations | `apps/dashboard/src/investigation/workers-page.tsx` and `webhook-deliveries-page.tsx`; routes are `/workers` and `/webhooks`. |

These source locations document implementation ownership, not proof that remote tests or live
operations passed. The prior local-source/E2E handoff remains authoritative for its earlier scope.

## Acceptance matrix

| ID | Requirement | Required evidence |
| --- | --- | --- |
| W1 | Persisted Worker permission and scoped administration | Default-off, optimistic version conflicts, audit history, current identity checks, and role narrowing. |
| W2 | No static-kind execution bypass | Creation contract/API rejection and claim/execution rejection of malformed retained tasks. |
| W3 | Static-only and E2E Workers coexist | A static-only Worker continues static work and never claims execution; an enabled Worker executes the pinned fixture. |
| W4 | Disable during execution | New claims stop; the owned application/recording stops; cleanup confirmation precedes resource release and confirmed UI state. |
| P1 | Static media never reaches GitHub | Synthetic static and forged producer cases make zero upload calls; legitimate E2E publication still succeeds. |
| H1 | Inspectable and retryable intake failure | List/detail/attempt history, bounded transient retry, explicit recovery, stale version handling, and permission enforcement. |
| H2 | Commit/recovery idempotence | Crash after Task commit reattaches the same Task, including E2E and changed authorization; retry never starts another desktop run. |
| H3 | Durable relay delivery | Local network/5xx failure, restart, identical replay, identity conflict, permanent rejection, failed-record CAS/idempotent retry, preserved cumulative attempts, atomic capacity admission, lifetime limits, and v1-to-v2 spool migration. |
| E1 | Complete frozen E2E instructions | Real runner input retains the task scope and policy without changing source or authority. |
| E2 | Real functional workflow | Pinned build, actual UI input/result assertions, feature media, sealed report, and confirmed process/workspace cleanup. |
| E3 | Independent external delivery | Exact owned-fork trigger/result identities, media upload receipts, and independently observed playback. No upstream mutation. |
| D1 | Current operational documentation | Worker controls, webhook recovery, current schema, exact accepted scopes, and deferred operations/capacity are consistent. |

Verification runs only in the designated remote environments. Real repository writes require the
current explicitly authorized target and execution scope; synthetic failure tests use isolated data
and mocked outbound transports.
