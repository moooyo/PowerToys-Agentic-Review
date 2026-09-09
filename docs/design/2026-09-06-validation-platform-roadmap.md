# Multi-Repository Validation Platform: Gaps and Proposed Roadmap

Status: accepted and in progress, based on the working tree on 2026-09-06.
This document describes the full delivery scope; acceptance does not mean that its features are implemented.
See [the implementation ledger](../handoff/2026-09-07-validation-platform-implementation.md) for verified progress and outstanding work.

## Confirmed requirements

- Support multiple repositories instead of a PowerToys-specific product.
- Keep PR static/build validation and PR UI validation as distinct workflows.
- UI validation must support both Windows desktop applications and Web applications.
- Provide a place to manage prompts.
- Show actionable PR and issue findings, validation evidence, and recommendations.
- Keep PR and issue workspaces separate. Further visual redesign is not the current priority.

## Current capability assessment

| Area | Implemented foundation | Product gap |
| --- | --- | --- |
| Repositories | Configuration accepts multiple GitHub repositories; database identities, polling cursors, and Git caches are repository-scoped. | No repository management, precise Dashboard repository filter, per-repository configuration, or connection readiness workflow. |
| Policy | Admission, revision authorization, capabilities, priorities, leases, and retries exist. | All repositories share one reviewer, scheduling policy, and prompt configuration. |
| PR processing | One Codex review job can inspect code and run build/test commands. | No separate static/build and UI jobs, required checks, test scenarios, or aggregate run. |
| UI execution | ProcessHost contains process trees and enforces resource budgets. | Production Worker advertises headless execution and no interactive desktop. No desktop or browser validation driver exists. |
| Prompts | Fixed files are loaded at startup; rendered prompt and schema hashes are frozen into jobs. | No drafts, publication, repository/workflow bindings, preview, rollback, or evaluation history. |
| PR results | Findings, priorities, source locations, and approve/comment/request-changes advice are stored and displayed. | No complete per-check validation report, two-lane summary, evidence attachments, or policy-based approval eligibility. |
| Issue results | Static classification, suggested labels, missing information, and duplicate candidates exist. | No actual reproduction workflow or confirmed/not-reproduced outcome. |
| Evidence | Model verification claims and Worker command observations are separate. | No screenshots, videos, traces, test-report files, or build-artifact delivery. |
| Operator actions | Worker credential creation, rotation, and revocation are implemented. | Production requeue, cancellation, drain control, human decisions, and GitHub publication are not implemented through the Dashboard adapter. |
| History | Results and attempts are immutable. | Work item details select only the latest job, with no complete run history or comparison. |

Evidence in the current tree:

- [Server repository configuration](../../apps/server/src/config.ts), [polling coordinator](../../apps/server/src/github/polling-coordinator.ts), and [repository projection](../../migrations/0002_github_ingestion.sql).
- [Global scheduling configuration](../../apps/server/src/main.ts), [default policy](../../apps/server/src/scheduling/default-policy.ts), and [fixed prompt loading](../../apps/server/src/scheduling/trusted-config.ts).
- [Worker capabilities](../../apps/worker/src/config.ts), [executor](../../apps/worker/src/execution/review-executor.ts), and [anonymous checkout](../../apps/worker/src/execution/job-workspace.ts).
- [Dashboard query contracts](../../packages/contracts/src/dashboard.ts), [latest-job projection](../../apps/server/src/database/dashboard-queries.ts), and [unsupported operator actions](../../apps/dashboard/src/services/review-control/http-adapter.ts).
- [Review result schemas](../../packages/codex/src/review-results.ts), [execution evidence](../../packages/contracts/src/execution-evidence.ts), and [static-only issue prompt](../../config/prompts/issue-triage-v2.md).

## Target product model

The central object should be a review run for a specific work item revision, not whichever job happened to finish most recently.

| Object | Responsibility |
| --- | --- |
| Repository | Stable GitHub repository identity, current name, connection, enabled state, settings, and access policy. |
| ValidationProfileVersion | Immutable workflow configuration: target, toolchain, commands, scenarios, assertions, required capabilities, budgets, and evidence policy. |
| PromptVersion | Immutable published prompt content and a supported output-schema version. |
| ReviewRun | One authorized request for one revision, with a frozen execution plan, policy, profile versions, and prompt versions. |
| Validation Job | An independently schedulable part of the run, identified by workflow, profile, and target. Reuse the existing job infrastructure. |
| RunAttempt | A retry of one job. An attempt must not be repurposed to mean a different validation lane. |
| CheckResult | One review check, build, test case, scenario, or assertion with its outcome and evidence references. |
| EvidenceAsset | A bounded, authenticated file associated with a run, job, attempt, and optional check. |
| OperatorDecision | A human decision tied to an exact revision and result digest, including any override reason. |
| PublicationIntent | A separately authorized, idempotent request to publish a result to GitHub. |

Use GitHub repository numeric IDs as identity; names are mutable display metadata. Preserve the current internal repository IDs and import existing environment configuration as bootstrap data. Avoid two competing configuration sources that silently overwrite one another.

Repository selection must constrain server queries, pagination, totals, run creation, and result reads. A frontend selector or fuzzy repository-name search is insufficient. Repository rename and transfer should refresh display/configuration metadata without changing historical identity.

## Workflow separation

| Workflow | Scope | Required output |
| --- | --- | --- |
| PR static/build | Code review, static checks, compilation, and configured non-UI automated tests. | Findings plus separate outcomes for each configured check. |
| PR UI: Windows desktop | Install or launch the exact build and exercise desktop scenarios. | Steps, assertions, expected/actual behavior, environment identity, screenshots, and failure evidence. |
| PR UI: Web | Start the exact application build, exercise browser scenarios, and collect browser evidence. | Steps, assertions, browser identity, screenshots, trace, and relevant console/network failures. |
| Issue triage | Classify the report and assess information completeness. | Category, ownership/labels, missing information, duplicate candidates, and uncertainty. |
| Issue validation | Reproduce the reported behavior on an explicitly selected revision and environment. | Reproduction steps, expected/actual behavior, evidence, and a reproduction conclusion. |

Windows desktop and Web are targets within UI validation, not two retry attempts. A repository may require either or both; support for both does not mean every PR must run every target.

Profiles define prerequisites. UI normally waits for a compatible build artifact, but unrelated profiles may run independently. Failure to satisfy a prerequisite must produce a visible blocked or not-run outcome instead of an indefinitely queued task.

The UI should present both PR lanes together, with independent status, required/optional designation, revision, configuration version, findings, and rerun controls. Issue validation should use confirmed, not_reproduced, needs_information, blocked, or inconclusive outcomes. Failure to reproduce is not proof that an issue is invalid.

## Execution and aggregation invariants

1. Freeze the repository identity, exact source revision, execution plan, policy, prompt, schema, profile, and relevant environment versions when creating a run.
2. Preserve the existing lease, fencing, replay, and immutable-result mechanisms. Extend the job envelope with validation identity rather than creating an unrelated scheduler.
3. Include workflow/profile/configuration identity in deduplication. Preserve a distinct request activation identity so an intentional rerun is possible without accepting duplicate deliveries.
4. Separate job-level duplicate-execution exclusion from shared-resource exclusion. The current work-item-wide concurrency key should not accidentally serialize independent validation jobs; one interactive desktop must still be exclusively leased.
5. Replace the latest-job-only Dashboard projection with a run and profile projection. A late result from one lane must not overwrite another lane.
6. Validate the original PR revision in a clean execution workspace. Any agent-proposed repair belongs in a separate workspace and result. A successful test after modifying the code must not certify the submitted PR.
7. A reused build must match the exact source, build configuration, toolchain, and dependency inputs through its manifest/digest. Never select an artifact by "latest build for this PR".
8. New commits make previous results historical. Never combine a successful UI run from an old commit with a successful build from a new commit to recommend approval.
9. Lost ownership must stop execution and restore shared environments before capacity is reused. Fencing result writes alone does not prevent an old UI process from interacting with the next attempt.

## Windows and Web execution environments

Windows UI validation requires a managed interactive session with explicit readiness, exclusive use, and recovery. Record the OS/image version, architecture, resolution/DPI, locale, application build, and relevant test-data state. Allocate, restore, install/launch, execute, collect evidence, stop, restore, and release are observable lifecycle steps. A locked session, crash, unexpected dialog, or failed restore is an environment outcome.

A normal Windows service is not a reliable interactive desktop executor: services use a noninteractive window station and Session 0. The implementation needs an interactive Worker mode or a narrowly scoped session executor on a dedicated test host. Select that deployment model explicitly; do not assume enabling a Boolean capability creates it. See [Microsoft's interactive-service guidance](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services).

Web validation needs application startup/shutdown, port allocation, readiness checks, browser contexts, test-account/data setup, and cleanup. Browser context isolation handles browser state; it does not reset the application database or replace process/host isolation. See [Playwright isolation](https://playwright.dev/docs/browser-contexts).

Use driver adapters so a common scenario/check model can support Windows UI automation and Web browser automation. Deterministic assertions should carry the verdict. Agent-assisted exploration can add findings, but observations must be distinguished from repeatable asserted checks. A trace records useful behavior; a trace alone is not proof of passed assertions. Playwright's low-level tracing API specifically does not capture test assertions; see [tracing documentation](https://playwright.dev/docs/api/class-tracing).

The initial fleet may remain Windows-based. Supporting Web validation does not itself require implementing a Linux Worker at the same time.

## Prompt and validation-profile management

Prompt instructions and execution profiles solve different problems. Prompts define review reasoning and output expectations; profiles define trusted setup/build/launch/test/cleanup behavior and required coverage.

The first Prompt management release should provide:

- Create/edit a draft with optimistic concurrency control.
- Preview its rendered content against a selected repository and work-item snapshot.
- Publish an immutable version with author, timestamp, digest, and supported schema version.
- Bind a published version to a repository and workflow, with an explicit global default.
- Roll back by changing the binding, retaining all historical versions and results.
- Show which queued and historical runs use each version.
- Record changes and publication in an audit log.

Schema evolution remains a code/Worker capability concern initially. Do not let a prompt editor publish arbitrary output schemas that deployed Workers cannot interpret. Prompt publication affects future runs only. Queued and active jobs retain their original snapshots.

Add sample-set evaluations and version comparison after the version/binding lifecycle works. Evaluation results should report coverage and regressions rather than treating a larger model-generated confidence number as improvement.

Validation-profile management needs per-repository build commands, target executable or startup command, environment prerequisites, test scenarios, assertions, required/optional checks, timeouts, cleanup, and evidence retention. Secrets are references to protected configuration, never prompt text.

## Results and decisions

The report must keep these dimensions separate:

| Dimension | Meaning |
| --- | --- |
| Execution state | Whether a job queued, ran, completed, failed operationally, or was cancelled. |
| Check outcome | passed, failed, blocked, not_run, skipped, or inconclusive, with a reason and expected/actual evidence. |
| Model recommendation | Advice and findings produced by the reviewer, including uncertainty. |
| Policy conclusion | Whether the current revision has satisfied the repository's required validation and finding policy. |
| Human decision | A recorded operator decision for this exact result and revision. |
| GitHub publication state | Whether a separately requested review/comment/check was actually delivered. |

Execution success is not validation success. A valid, successfully submitted report can contain failed compilation or failed UI assertions. A model recommendation of approve does not establish required test coverage or mean GitHub has received an approval.

Unqualified approval eligibility requires every required check to have passed on the current revision with complete evidence, and no unresolved blocking findings under the selected policy. Failed, blocked, not_run, skipped, or inconclusive required checks must prevent that conclusion. Missing evidence, stale results, and modified-source verification must also prevent that conclusion. A human override is a separate, explicitly qualified decision and does not turn failed checks into passed checks. Show the reason instead of flattening everything into failed. Optional failures and accepted exceptions remain visible.

A useful report should answer, in order: what revision was checked; what is the overall conclusion; which required checks ran; what failed and why; where is the evidence; what should the operator do next. Include history and direct links to individual runs and checks. Findings comparison should distinguish new, persistent, resolved, and dismissed findings without rewriting old results.

## Evidence delivery

UI evidence is a required product capability, not optional decoration. Add storage for screenshots, traces, videos when needed, structured test reports, selected logs, and compatible build packages. Keep the result JSON small and reference evidence IDs.

An evidence manifest should contain repository/revision/run/job/attempt/profile identity, optional scenario/check identity, type, media type, size, digest, and capture time. Use authenticated access, upload ownership checks, size/count quotas, explicit retention, and cleanup. Required uploads must be finalized before a result claims complete evidence; interrupted uploads must not appear as valid evidence.

This changes the inline-only MVP decision in [ADR 0029](../adr/0029-trusted-code-single-worker-and-shared-worktrees.md). A new ADR should document the narrower evidence requirement. Do not restore the old unpublished installer, split-worker, or artifact compatibility designs wholesale.

## Additional product gaps

| Priority | Capability | User-visible reason |
| --- | --- | --- |
| P0 | Run creation, rerun, cancellation, and repository pause | Operators need to control a selected workflow/profile, not rely solely on a new GitHub assignment event. Explicit run permissions must be defined for authenticated operators. |
| P0 | Connection and capability diagnostics | Explain missing credentials, denied authorization, unsupported profiles, absent desktop sessions, and unavailable Workers before or during scheduling. |
| P0 | Run history and revision freshness | Preserve both lanes and intentional reruns; prevent old successes from misleading a reviewer. |
| P0 | Per-repository access and configuration audit | Repository selection is not an authorization boundary, especially for private repositories or multiple teams. |
| P1 | Per-repository concurrency, quotas, and scheduling fairness | A large repository or high-priority PR traffic must not indefinitely crowd out other repositories or issue triage. |
| P1 | Failure classification and retry policy | Separate a code/test failure from environment or infrastructure failure; do not erase flaky failures by silently retrying until green. |
| P1 | Reusable scenario/test-data management | UI validation needs reproducible setup, assertions, and reset behavior rather than free-form launch instructions alone. |
| P1 | Finding disposition and human override | Operators need to accept, dismiss, or request changes with a reason tied to the reviewed revision. |
| P2 | Publication preview and GitHub delivery outbox | Publish only the selected, authorized current-revision result, with deduplication and visible delivery failures. Advice remains useful without publication. |
| P2 | Notifications and prompt/profile evaluation | Notify on actionable completion or failure and compare configuration changes against known examples. |

## Delivery order and acceptance

1. **Repository and run foundation.** Add repository management and exact server-side scope; profile/prompt publication and bindings; immutable ReviewRun plans; per-profile result contracts; real run/history reads. Import existing configuration and preserve historical jobs. Acceptance: two repositories with the same PR number remain distinct, and different prompt/profile versions cannot affect each other's runs.
2. **Static/build workflow and report.** Execute configured checks in the original revision workspace, record typed outcomes, and expose operator run/rerun/cancel actions and aggregate conclusions. Acceptance: a completed job with failed compilation is visibly failed validation; missing required UI coverage cannot be shown as approval eligibility.
3. **Evidence and both UI targets.** Implement bounded evidence delivery plus one real Windows desktop profile and one real Web profile. Acceptance includes failing assertions, screenshots/trace where applicable, process termination, environment restoration, stale-attempt fencing, and artifact/revision matching. This milestone is not complete with only Web support.
4. **Issue reproduction and decision workflow.** Reuse the profiles for issue validation; add finding history/disposition and recorded human decisions. Add publication preview/outbox and notifications according to repository policy and operator authorization.

Each slice must work through persistence, API, scheduling/execution where applicable, and Dashboard. Unsupported functionality must remain explicitly unavailable rather than being simulated by production UI fixtures.

## Remaining scope decisions

- Whether private repositories are required in the initial release; the current anonymous checkout cannot support them.
- Which initial repositories and concrete Windows/Web scenarios define acceptance.
- Which UI profiles are automatic, manual, required, or optional for each repository.
- Required toolchains, test accounts/data, environment reset strategy, and evidence retention limits.
- Whether the initial product stops at recommendations or also publishes GitHub reviews after a human decision.

GitHub.com is the existing integration boundary. GitHub Enterprise and non-GitHub providers should be explicit later scope decisions rather than accidental assumptions in the first implementation.
