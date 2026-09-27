# Historical scenario acceptance

Status: acceptance definitions prepared; every new scenario is `not_run`. No execution,
deployment, build, test, or runtime verification is claimed by this document. A prepared
catalog is not evidence that a functional or delivery scenario passed.

The machine-readable catalog is
[`deploy/operations/historical-scenarios.json`](../../deploy/operations/historical-scenarios.json).
It preserves the unresolved boundaries in the
[local source and E2E handoff](../handoff/2026-09-19-local-source-review-e2e.md) and the
[Worker controls and webhook recovery handoff](../handoff/2026-09-19-worker-controls-and-webhook-recovery.md).
The catalog is consumed offline. It neither launches work nor authorizes external writes.

## Recorded history and independent follow-up

| Catalog ID | Historical observation | Required follow-up boundary |
| --- | --- | --- |
| `H-PEEK-LOADING` | The original Peek execution recorded two passed, four failed, and one blocked assertion. The application remained loading. | Recover the exact original file inputs, source pin, and assertion mapping; observe actual rendered content with a same-session positive control. |
| `H-PEEK-NAVIGATION-DISPOSAL` | The same Peek execution attempted navigation without establishing the changed disposal behavior. Cross-file disposal was not exercised. | Establish both fixtures can render, then observe the exact cross-file transition and source-supported disposal condition. |
| `H-LAUNCHER-UNIT-CONVERSION` | Four scenarios retained one passed, one failed, and two blocked outcomes. The `sqmi` target-operand scenario showed `1 mi²` in an actual result control. | Recover all four exact queries and expectations; establish UnitConverter participation and observe actual result values. |
| `H-WEBHOOK-EXTERNAL-401` | A CLI-hook redelivery received external HTTP `401` before the local receiver. Its cause remains unestablished. | Correlate the original failed request with retained boundary diagnostics and establish a supported cause without rewriting the failed receipt. |
| `H-WEBHOOK-RELAY-CACHED-DUPLICATE` | Actual HTTPS redelivery returned `202 duplicate` from the owned relay cache for the same GUID and bytes. The recorded state identities did not change. | Preserve or independently verify the cache boundary with receiver ingress evidence; explicitly record `receiverReentryTested=false`. |
| `H-WEBHOOK-NATIVE-SERVER-DUPLICATE` | Earlier native duplicate/commit-recovery evidence exists separately; the real cached redelivery did not enter the Server twice. | Prove two native entries and a third after Server restart, using identical GUID and raw bytes, one canonical receipt, and unchanged Task/Attempt/invocation/execution identities. |

The Peek aggregate belongs to one historical execution. Listing two follow-up boundaries does
not create two independent historical runs or assign individual historical assertions to either
boundary. Those assignments must come from the original sealed report. A failed assertion is an
observation, not a causal finding against a PR. A new successful simpler fixture does not resolve
an older failed or unexercised feature.

The Launcher selector that returned the literal accessibility label `Title` did not establish a
functional regression. The original blocked scenarios had no matching result row. Inspect the
actual result control and demonstrate plugin participation before judging a qualified absence.
Do not treat `Title`, `Path`, a successful build, a playing video, or recovered saved results as a
successful feature assertion.

## Input recovery

The repository narratives do not contain the exact original Peek file fixtures, its full source
pin, all Launcher query strings, or the per-assertion mapping. The `sqmi` token and the observed
`1 mi²` output do not determine a complete query. Do not fill these gaps with plausible examples.

Before a future functional run, export the relevant original sealed report and its artifact
references through an authorized read-only path. Build a separate input manifest containing the
original report digest and Task/Attempt/feature/assertion identities, source/build pins, exact
fixture bytes or retrievable immutable digests, application configuration, inputs, and
source-supported expectations. Preserve text encoding. Do not include credentials, webhook
secrets, or unredacted signatures in reviewable exports.

Missing required inputs leave the affected scenario `not_run`. New synthetic webhook fixtures
are allowed as isolated fixtures, but must carry new identities and must never be described as
reconstructed historical requests. A historical claim requires its actual original receipts.

## Evidence contract

Each catalog item supplies `requiredEvidenceKinds` for an offline acceptance consumer. The
field lists categories that must be present; it does not make an attached artifact truthful or
replace review of the item-specific `requiredEvidence`, `passCriteria`, and positive controls.
An arbitrary file tagged `ui_assertions` is not proof that an assertion executed.

Every new evidence set must identify the catalog scenario, independent run, source revision,
fixture manifest, actual execution environment, start/end times, and outcome. Correlate evidence
to that run and retain immutable artifact digests. A single follow-up run may cover more than one
scenario, but each scenario still needs its own input mapping, controls, observations, and result.
Preserve all original reports, receipts, outcomes, identifiers, and media without edits.

Apply the outcomes as follows:

- `not_run`: required inputs or evidence are absent, the designated environment is unavailable,
  a prerequisite prevents exercising the intended behavior, or only code/test definitions exist.
- `passed`: all required inputs, controls, observations, and cleanup evidence satisfy the catalog's
  pass criteria. Keep the accepted boundary explicit.
- `failed`: the intended scenario executed with established prerequisites and controls and its
  observed behavior violated a criterion. Preserve the failure evidence and any cleanup failure.

If execution is blocked by a prerequisite, record its explanation with the `not_run` result.
Do not overwrite an earlier observed failure with `not_run`: preserve individual observations and
record the new acceptance conclusion separately. Likewise, missing feature evidence cannot be
replaced by generic build, publication, accounting, or cleanup success.

The functional scenarios require owned process/window identities, pinned source/build evidence,
actual UI assertions, matching image/video observations, and managed cleanup receipts. Peek
disposal additionally needs a supported observation of the previous resource. Generic process
memory readings or window closure do not establish that disposal condition.

## Webhook boundaries

Keep three separate questions:

1. **Original external `401`:** identify the response-producing boundary and cause using the
   exact failed request's evidence. Later HTTPS success does not retrospectively explain it.
   Log absence is useful only when retention and recording coverage are established by a control.
2. **Relay cached duplicate:** the first request reaches the receiver and the exact duplicate is
   satisfied by the relay's durable cached receipt. Demonstrate unchanged spool history and
   downstream identities, and retain `receiverReentryTested=false`.
3. **Native receiver duplicate:** two distinct requests reach the Server receiver with the same
   GUID and raw bytes. Capture the first committed/processed state before comparing the second
   response and persisted identities. Restart the Server with the same database and require a
   third request to return the same duplicate with unchanged identities. A relay cache must not
   intercept either re-entry request; do not clear idempotency state to enable the check.

HTTP `202 accepted` or `202 duplicate` confirms the scoped intake acknowledgment; it does not
alone prove Task creation, execution, or functional success. The native receiver scenario uses an
isolated synthetic fixture and deterministic processing boundary so asynchronous work from the
first request cannot be mistaken for duplicate work from the second. Record mocked outbound calls
to prove that no actual repository write occurred.

The prepared coverage in `apps/server/src/investigation/webhook-runtime.test.ts` uses native
loopback HTTP and real isolated SQLite for issue assignment, PR assignment, and E2E command
intake. It separately observes relay cache hits and native receiver entries, including retained
Server/relay databases across restart. The receiver verifies HMAC over exact CRLF JSON bytes and
the receipt preserves their digest. Source reads and publication transports are mocked; no Worker
or model runs. Additional native cases preserve signature `401` as a failed relay attempt with no
business receipt and reject a `401` even when its body resembles a duplicate acknowledgment.
These definitions have not been executed for this change and do not diagnose the historical `401`.

Neither cached replay nor native duplicate handling establishes physical power-loss durability,
sustained throughput, total SQLite/WAL storage capacity, or an entire live HTTPS path. Those
claims require their own operational acceptance evidence.

## Execution and cleanup safety

The catalog and its offline consumer cannot start a Worker, resume a historical Task, replay a
delivery, call GitHub, or change repository state. Preparing these definitions does not authorize
later live work. Actual repository PR/issue writes still require explicit approval for the target,
operation, content, and scope under [AGENTS.md](../../AGENTS.md).

Use isolated databases and mocked upstream/provider/outbound transports for future webhook
execution. Future functional runs use a new explicit Task/run identity and the authorized Windows
environment when it becomes available. Keep publication disabled for isolated acceptance. Do not
resume old incomplete execution to obtain fresh observations; recorded-result recovery only
adopts saved evidence and does not constitute a new functional test.

Retain receipts and media before disposing of owned run resources. Functional cleanup must prove
owned process exit, workspace cleanup, and execution/desktop lease release through the managed
protocol. Do not delete shared files, modify retained production databases, or use unrelated
process termination as cleanup evidence. If cleanup cannot be proved, retain the blocker and do
not infer resource release from a terminal Task state.
