# PowerToys Agentic Review

Agentic Review investigates GitHub pull requests and issues, produces complete structured
reports, and prepares explicit follow-up actions. The application is unreleased. Its active
execution model uses `Task`, `Attempt`, `LoopCheckpoint`, `Report`, and `ActionIntent`.
The refactor does not provide legacy API compatibility, dual writes, data conversion, or
retired Job database migration scripts. The limited additive upgrades of the active investigation
store are described below.

The [current design](./docs/design/2026-09-15-structured-investigation-results-and-loop.md)
describes the result contract, complete investigation loop, and action rules. The
[architecture](./ARCHITECTURE.md) and application instructions document the active runtime and
deployment boundaries.

## Runtime components

- `apps/server`: the new SQLite-backed Task/Report API, built-in password accounts and scoped sessions,
  Worker credentials, immutable checkpoints and reports, action preparation, and delivery.
- `apps/worker`: an outbound Windows Worker using the new task protocol. ProcessHost owns
  process trees; disposable workspaces hold exact source, model inputs, and captured artifacts.
- `apps/dashboard`: the Material UI PR, Issue, Task, Report, and repository workspaces.
- `packages/contracts`: runtime schemas and semantic validators for the new protocol.
- `packages/domain`: investigation loop transitions, completion rules, action recommendations,
  and permissions computed from the complete result collection.
- `packages/codex`: shared low-level CLI launch and output handling.
- `native/process-host`: managed Windows process lifetime and resource enforcement.

The production Server starts through `apps/server/src/main.ts`; the Worker starts through
`apps/worker/src/main.ts`, bundled as `dist/worker.mjs`. Both select the new investigation
runtime. Older source modules and acceptance receipts describe their original scope and
are not alternate production endpoints or migration inputs.

## Structured investigations

Repositories can enable assignment Webhooks and configure a recipient plus trusted assigning
GitHub user IDs in the Dashboard. A verified assignment imports a complete frozen source and
automatically queues a native Task. Delivery deduplication and durable recovery preserve its
identity across retries. This path does not poll GitHub; see the
[receiver setup](./apps/server/README.md#listen-for-trusted-assignments).

Trusted users can independently request a pinned PR E2E run with a new `@configured-account e2e`
conversation comment when E2E intake is enabled. This creates a separate execution Task and progress
comment. Static review capacity is configurable; all execution tasks share one global E2E slot,
held through confirmed process, workspace, and desktop cleanup. See the
[trusted E2E command setup](./apps/server/README.md#trusted-pr-e2e-commands).

Each Worker starts with E2E disabled. Administrators enable its single persisted execution setting
in **Workers**; local roles can narrow capability but cannot grant permission. Disabling it stops
new execution claims and requests cancellation, with cleanup confirmation shown separately. This
setting does not remove local shell access or screenshots. Static report images/videos cannot be
published to GitHub. See [Worker controls](./apps/server/README.md#worker-execution-permission).

**Webhooks** shows scoped assignment/E2E receipts, failure reasons, processing history, and linked
Tasks. A versioned, idempotent retry resumes failed intake and reattaches an already committed Task
without repeating execution. A separate durable relay spool covers events received by a configured
relay, with explicit versioned retry for failed deliveries and retained attempt history. It does
not automatically request GitHub redelivery. See
[webhook recovery](./apps/server/README.md#inspect-and-retry-webhook-intake).

PR and Issue investigation use a persistent discovery and recheck loop. Every retained finding
contains its priority, trigger, impact, root cause or explicit uncertainty, evidence, repair
advice, feedback draft, and final-version recheck. Priorities order presentation; they never
silently limit the final report to top-k findings.

Completion requires handled coverage and candidate records, valid final rechecks, and a sealed
report. Budget exhaustion, cancellation, unavailable inputs, and protocol failures produce
explicit partial outcomes. A successful CLI exit does not establish investigation completeness.
Checkpoints support continuation without discarding confirmed findings or replaying uncertain
execution steps.

Reports distinguish original PR revisions, Issue snapshots, explicitly selected commits, local
patches, and verified remote branches. Verification results preserve their exact subject and
evidence. Passing checks on a local patch do not certify the original PR or an upstream fix.

## Recommendations and actions

The Server computes recommendations separately from current operation permissions. A confirmed,
unresolved P0 on the current original PR blocks Approve. P1 findings, missing required E2E,
and incomplete analysis change the recommendation but do not add that content prohibition.
Actual actor permissions, target state, SHA, and unresolved delivery are checked independently.

Saved plans and validated `nextActions` drive follow-up preparation. Missing source or environment
inputs can be supplied in a preparation form; execution still requires real prerequisites.
Linked verification preserves the parent report and selected scenarios instead of repeating a
full review. Implementation produces separately identified edits and patches. Creating a PR
requires an existing, verified remote branch and never implicitly commits or pushes.

Operator-initiated GitHub writes require a prepared and confirmed action intent. Unknown delivery is reconciled
with read-only requests, not automatically resent. The default Server configuration disables
external writes. Automated tests must not write to real PRs or issues; see [AGENTS.md](./AGENTS.md).

Repositories can authorize automatic English conclusion comments for future completed PR and Issue
investigations. Report sealing atomically queues the saved template and report reference. The
Server verifies the publishing GitHub account, freezes the comment, and prepares and confirms it
under that standing authorization, without per-report human review. Replies disclose the selected
model and represented GitHub user. PR replies show Conclusion, Summary, Findings, and collapsed
Details. Issue replies instead show Triage result and Next steps before collapsed Investigation
details. Their short summary is part of the conclusion, and bug reports show an independent
Runtime reproduction status. Information or verification requests remain visible. Current
permissions, publisher identity, and target versions
are rechecked before sending. See the
[automatic reply setup](./apps/server/README.md#automatically-reply-with-investigation-results)
and the [PR](./docs/templates/auto-reply-pr.md) and [Issue](./docs/templates/auto-reply-issue.md) templates.

Repositories can also enable assignment progress comments. An accepted trusted assignment queues
an acknowledgement before the investigation input is imported. The same comment is updated when
work starts, stops, or produces a complete conclusion. Every update identifies the AI assistant
and verified publishing account. Template edits apply to subsequent new updates; prior attempts
retain their exact bodies. The Dashboard shows ordinary create/update delivery history with status,
time, expandable body, and failure details alongside the investigation's independent state.
See [assignment progress setup](./apps/server/README.md#track-assignment-tasks-in-one-progress-comment).

## Configuration and development

Use Node.js 24.20.x and pnpm 11.24.x. The Server uses `INVESTIGATION_*` configuration; the Worker
uses `INVESTIGATION_WORKER_*`. Read the [Server instructions](./apps/server/README.md) and
[Worker instructions](./apps/worker/README.md) before starting a deployment. New investigation databases are
initialized directly with the `investigation-v5` schema. Exact `investigation-v2`,
`investigation-v3`, and `investigation-v4` databases receive additive storage migrations;
unrelated or incomplete schemas are rejected without deletion.

The [production operations workflow](./deploy/operations/README.md) provides Windows hosting,
administrator-only storage observations, explicit capacity thresholds, and a deployment acceptance
checklist. The [four-GiB workflow handoff](./docs/handoff/2026-09-27-four-gib-workflow-acceptance.md)
records passed native lifecycle and Dashboard checks, isolated Scheduled Task hosting, cooperative
shutdown, backup/restore, and bounded failure recovery. The subsequent
[CI correction and production cutover](./docs/handoff/2026-09-27-ci-and-production-cutover.md)
deployed release `a6ae2995407037683e5be120f76e928aad212c4b` after all three CI jobs passed.
The Server, static Worker, and Dashboard relay are running with preserved accounts and retained
data. VM reboot, real-application execution, live publication, and sustained capacity remain
separate acceptance.

The Dashboard development server uses clearly labeled synthetic data, including PowerToys PR,
Bug, Feature, incomplete-report, and page-two P0 examples:

```powershell
pnpm --filter @agentic-review/dashboard dev
```

Production Dashboard requests use the authenticated new API and never fall back to sample data.

## Built-in accounts

The console uses application-owned username/password accounts. The first administrator is
initialized from deployment configuration, with no default production password. Administrators
manage accounts and explicit repository/action grants; account administration does not implicitly
grant access to every repository. Password changes, resets, disabled accounts, and permission
changes revoke existing sessions.

Read the [Server account setup and recovery instructions](./apps/server/README.md) before starting
a new deployment. The account database is initialized separately from investigation data;
third-party login and conversion of the previous authentication database are outside this scope.
GitHub API credentials and Worker credentials remain independent of console login.

The [account design](./docs/design/2026-09-15-built-in-accounts.md) records the API, session behavior,
and acceptance scope. General model-quality evaluation remains outside this delivery. The recorded
[Worker controls and webhook recovery follow-up](./docs/design/2026-09-19-worker-controls-and-webhook-recovery.md)
used owned-fork PR #15 and retained complete changed-path coverage of PowerToys Run Calculator.
The earlier PR #14 source-preparation failures remain historical; pinned-submodule support and
deployment-owned compiler selection were subsequently implemented. Earlier Peek and Launcher
outcomes and the exact inputs required for independent follow-up are recorded in the
[historical scenario catalog](./docs/operations/historical-scenarios.md).

Run verification on the project-designated remote Windows worker. Linux-specific checks may use
`test-env`; local verification requires explicit authorization for the current task. Standard
package build, typecheck, test, and lint scripts remain available. The
[investigation acceptance instructions](./deploy/investigation-acceptance/README.md) describe the
opt-in synthetic lifecycle harness and real CLI companion, including prerequisites and exclusions;
their availability does not imply a completed acceptance run. Tests should use mocked transports
and isolated databases, with no real repository mutations.

Biome checks authored application and design sources. Its explicit design-artifact exclusions
cover generated composite HTML/SVG, generated icon/font assets, and vendored dependency bundles;
the corresponding JavaScript, JSX, CSS, HTML templates, JSON inputs, and generator sources remain
in scope. Regenerate the affected offline artifacts after source changes and validate SVG as XML.
See the [CI correction and deployment record](./docs/handoff/2026-09-27-ci-and-production-cutover.md).

## Evidence and project status

Evidence retention defaults to 30 days, 1 GiB of resident original content, and 10,000 resident
artifacts. Bounded cleanup preserves recovery and follow-up source dependencies. Current artifact
availability is separate from immutable reports, and inherited patches retain their original
producer identities in `sourceArtifacts`. See the [Server evidence instructions](./apps/server/README.md#evidence-retention-and-capacity)
for configuration, HTTP availability responses, and physical SQLite storage limits.

The 2026-09-19 acceptance covers complete pinned-checkout static review, invocation usage,
static/E2E scheduling, independent PNG/MP4 publication and playback, managed recovery, and
application-open cancellation. Functional PR scenarios retain their own unsuccessful outcomes;
playable evidence is not a functional pass. That earlier redelivery received an external HTTP 401
before the receiver; the later cached-duplicate result below retains its separate scope. Neither
result diagnoses that original failure or establishes sustained workload/storage capacity.

The subsequent Worker controls, static-media publication guards, webhook recovery, and durable relay
spool have [scoped software and Dashboard/native-intake verification](./docs/handoff/2026-09-19-worker-controls-and-webhook-recovery.md).
The native intake browser scope uses real HTTP/SQLite with GitHub mocked. PR #15's sixth Task passed
three Calculator features and four UI assertions with confirmed cleanup. The fifth report's four
GitHub images and MP4 playback passed while that Task remained blocked. Real HTTPS redelivery
returned a cached duplicate without a second Server receipt. The eighth Task completed naturally
with confirmed cleanup but no disable CAS. A separate synthetic-input/real-runtime native W4 fixture
passed; the real-PR observer failures remain. Operational closeout is complete and temporary capacity
settings were restored with legacy services/history preserved. That implementation is part of the
published source; its original acceptance boundaries remain unchanged.

The September 27 operations increment passed 149 distinct targeted tests, a 30-test serial Windows
repeat, 10 native lifecycle checks, and 11 production Dashboard/native HTTP/SQLite browser steps.
Scheduled Task hosting, duplicate-start protection, cooperative shutdown, populated backup/restore,
bounded Server retries, and the Worker's same-boot recovery gate passed in isolation. Webhook tests
separately cover relay cached duplicates and actual Server receiver re-entry across restart. The
short two-task capacity observation and sampled 4 GiB workflow are not sustained or concurrent
capacity results. No real model, PowerToys build/UI, GitHub write, or VM reboot was performed by
that isolated operations acceptance.

The subsequent production cutover preserved the original account identity and password, four
Tasks, four report exports, and 47 evidence records. Persisted Server static concurrency and Worker
concurrency are both one, with no active leases or new Tasks. A six-step read-only browser check
and three inspected screenshots covered the running Dashboard. Its action-loading capture and
unexercised media remain historical limits of that run. The subsequent
[Dashboard interaction follow-up](./docs/handoff/2026-09-27-dashboard-interaction-acceptance.md)
observed completed native action availability, disabled external actions with their guard reasons,
PNG preview/focus recovery, and playback, pause, seek, and disposal of an existing MP4. Final
independent review accepted all eight production steps and three screenshots with unchanged
business-state digests. A separate isolated phase passed seven steps and five reviewed screenshots
covering validation, retained drafts, same-key recovery after an injected 503, and a new edited
preview while preserving the first intent. Confirmation stayed disabled and no external operation
occurred. Temporary sessions, processes, tasks, and credentials were cleaned up. Outbound writes,
media uploads, webhook intake, and E2E remain held. The current
[implementation status](./docs/IMPLEMENTATION_STATUS.md) and
[cutover record](./docs/handoff/2026-09-27-ci-and-production-cutover.md) preserve the exact scope
and the remaining acceptance work.

[Implementation Status](./docs/IMPLEMENTATION_STATUS.md) distinguishes this refactor from historical
milestones. M39/M40 model workflows, M41 publication acceptance, M42 selected PowerToys tests, and
the later fork build receipts retain their exact recorded revisions and scope. They do not by
themselves accept the new Task protocol, a new Windows deployment, or a new model/UI scenario.
