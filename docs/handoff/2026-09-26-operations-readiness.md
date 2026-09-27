# Operations readiness implementation, 2026-09-26

This is the implementation-time record. Subsequent remote checks and bounded Windows acceptance
are recorded in the [four-GiB workflow handoff](2026-09-27-four-gib-workflow-acceptance.md).

## Status

The deployment and acceptance support code is prepared. The designated Windows Worker was
unavailable during implementation, so software verification, deployment, desktop execution,
restart/restore rehearsal, and sustained capacity acceptance remain pending. No production
configuration, running service, PR, Issue, model, or historical Task was changed.

## Implemented scope

- A private Windows Scheduled Task host separates Server startup from interactive Worker logon.
  It checks declared entry hashes, preserves independent persistent roots, bounds automatic
  restart attempts, and delivers cooperative shutdown through a private IPC channel. Unconfirmed
  Worker cleanup requires recovery instead of starting an overlapping replacement.
- Administrator-only operations snapshots expose physical file lengths and available filesystem
  capacity alongside SQLite pages, task/lease aggregates, and logical evidence quotas. Unknown
  states and unavailable measurements remain explicit. Snapshots do not checkpoint, vacuum, or
  delete records; ordinary authentication maintenance still contributes to account DB writes.
- The capacity collector uses declared thresholds, actual completed task counts, monotonic
  process timing, bounded sampling, session rotation, and complete receipt writes. Server restarts,
  clock discontinuities, missing measurements, regressing/unknown counters, and observed task
  interruptions cannot become a capacity pass.
- Native HTTP/SQLite webhook regression sources cover repeated Issue assignment, PR assignment,
  and E2E command deliveries, including a Server restart. Cached relay responses and actual
  receiver re-entry have distinct assertions. Rejected signatures/HTTP 401 cannot create a
  successful delivery merely because their body resembles a duplicate receipt.
- Deployment and historical scenario catalogs feed a fresh `not_run` packet. Evidence hashes
  prepare recorded passes for human review; the summarizer never claims to execute UI assertions
  or resolve the historical Peek/Launcher failures.
- CI definitions include the new pure operations tests and deployment PowerShell parsing for
  future runs. Exact source-boundary rules distinguish offline design tools from production
  helpers without granting adjacent files general runtime-loader exemptions.

## Remaining execution

Follow [the operations workflow](../../deploy/operations/README.md) in order. The first required
step is software verification against the final tree in the designated environment. Preserve
source/build/runtime manifests before deployment; the existing old CI failure is not a passing
result for this change.

Next run isolated native lifecycle acceptance, Windows hosting/recovery and backup/restore
rehearsals, deployed Dashboard integration, selected historical cases, and a predeclared sustained
workload. Keep each outcome and cleanup receipt separately. Exact historical Peek/Launcher inputs
must be recovered from their original sealed evidence, not invented from a summary.

Real PR/Issue operations require their own explicit current scope approval after their exact
targets, payloads, and incidental effects are prepared. None of the new tools triggers those
operations, and previous consumed approvals must not be reused.

No tests or builds were executed for this handoff. Source review and formatting do not substitute
for remote software verification or Windows runtime acceptance.
