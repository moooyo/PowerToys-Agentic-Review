# Optional validation summaries: implemented execution contract

Status: implemented and wired into Worker production composition. The feature is opt-in and
disabled by default. Production model acceptance remains pending. This slice uses the existing
result contracts and does not add a database migration.

## Implemented scope

`main.ts` creates `ValidationSummaryExecutor` through the optional `ProfileJobExecutor` factory when
summary configuration is enabled. `pr_ui` and every supported target of `issue_validation` can now
execute their frozen `ValidationSummaryV1` prompt. The existing required model-review path for
`pr_static_build` and `issue_triage` remains separate.

Previously, UI/reproduction prompts were frozen and required by admission but never executed. The
implemented opt-in resolves that execution gap. A frozen prompt still does not prove that a model
ran: disabled summaries display as not requested, and attempted failures remain visible. Prompt
admission is unchanged; removing its prerequisite is a separate plan-policy decision.

## Shared process layer and strict adapters

`PreparedCodexOutputRunner.run<TSchema>()` was extracted from `review-executor.ts`. It receives an
already prepared workspace, a trusted schema selected in code, bounded prompt input, the existing
execution context, and a launch policy.
It returns typed output or a failure plus command and file-change observations. Process startup,
disk monitoring, progress pulses, bounded stdout/stderr draining, stable result-file reads, teardown,
and credential redaction share one implementation. `ReviewJobExecutor` remains an adapter with its
existing envelope checks and result enrichment.

The shared runner reuses `buildCodexExecLaunchSpec`, `CodexJsonlParser`,
`determineCodexExecutionResult<TSchema>`, and `createCanonicalResult` from `packages/codex/src`.
Review retains its original default launch behavior. Summary execution uses the same trusted
provider configuration and lease cancellation without passing through the legacy review schema or
findings/recipe-request validator.

`ValidationSummaryExecutor` independently requires `pr_ui` or `issue_validation`, selects the
exact PR/Issue `ValidationSummaryV1` branch from deployed code, and verifies the frozen prompt and
schema bytes/digests. It validates unique observation IDs and coherent relative path/line pairs.
The existing V2 plan/profile/source checks remain in the profile executor. Arbitrary
envelope-supplied schemas and model-supplied runner authority fields are rejected.

## Input, workspace, and authority

Profile execution invokes summaries after runner normalization and, for UI targets, teardown and
evidence finalization. The summary adapter creates its own `purpose = model` workspace and registers
deferred cleanup on the original execution context. Both workspaces retain the authorized source;
all mutable model directories must be disjoint from the validation workspace.

`createValidationSummaryContext()` constructs deterministic `ValidationSummaryContextV1` bytes from
immutable report/execution snapshots and validated evidence. All frozen checks remain present.
Uploaded manifests must match the run, request, job, attempt, profile, revision, plan, and check;
scenario screenshot IDs are remapped to finalized Server IDs. Step identity/action/name/expected
values and the normalized steps document's exact SHA-256 and byte length are checked. Incomplete
UI evidence causes a visible optional failure instead of a reduced context.

The context contains structured evidence, not trace archives, screenshot pixels, source-directory
links, command environment values, or configured fill values. Runner-supplied `modelSummary` is
rejected. The adapter cannot claim to have inspected screenshots through the disabled image tool.

Frozen prompt bytes and `promptSha256` remain unchanged. Dynamic context has its own
`contextSha256`, verified again by the profile composer. The context is bounded to 256 KiB, combined
prompt input to 512 KiB, and the composed terminal result to 2 MiB. Oversize data fails the optional
summary without silently dropping failed checks or losing the runner report.

The `summary_read_only` policy builds `codex exec --sandbox read-only --ignore-rules`, keeps approval
disabled, configures the elevated Windows sandbox, and passes the network-access-false setting. It
explicitly disables browser/computer-use/app/MCP/plugin/hook/subagent entry points. Provider access is separate
from the child command environment. These are configured controls; the native acceptance limits
below apply to claims about their production enforcement.

The summary adapter observes model source state before and after execution. A modified/unknown
checkout or observed file-change event invalidates advice even when valid JSON was returned. Final
`git status` alone cannot prove that code was never changed and restored; do not make that claim
without enforcing the read-only
policy. Rejected advice uses `modelReview.failed` with a fixed
`SUMMARY_CONTEXT_MODIFIED`/`SUMMARY_CONTEXT_UNKNOWN` code; `report.modelSummary` is omitted. Never
rewrite the runner's `sourceState`, checks, reproduction conclusion, or evidence references.

## Existing storage and optional behavior

Successful strict `ValidationSummaryV1` output is stored in the existing `report.modelSummary` field.
Its wire representation keeps `modelReview = { state: "not_requested" }`: this field's
`completed` branch is specifically a legacy PR/Issue review, and the Server rejects it for summary
workflows. The Dashboard already projects a present summary as completed. A failed optional attempt
uses the existing `modelReview.failed` branch and has no summary; a disabled summary has neither a
summary nor a failure.

`WORKER_VALIDATION_SUMMARY_ENABLED` defaults to `false`. Enabling it requires execution and at least
one enabled validation runner. `WORKER_VALIDATION_SUMMARY_TIMEOUT_MS` defaults to `60000` and accepts
positive integers from `10000` through `300000` milliseconds. Enabled but unavailable, malformed,
budget-exhausted, or safely timed-out attempts are visible failures. Deterministic validation is
not retried solely to recover optional prose.

`ValidationSummaryExecutor` owns the only optional timer; Profile composition directly awaits it.
With default teardown of 5 seconds, completion reserve of 30 seconds, and no-progress submission
safety of 5 seconds, its budget is:

```text
hardRemaining = min(executionDeadlineAt, assignedAt + hardTimeoutMs) - now
summaryBudget = min(configuredMaximum,
                    hardRemaining - completionReserve - teardown,
                    noProgressWindow - teardown - submissionSafety)
```

A budget below 10 seconds returns `SUMMARY_BUDGET_UNAVAILABLE` without starting a model. A
30-second no-progress window permits at most 20 seconds when the hard deadline has sufficient
room. Cancellation has a separate bounded terminate/stream-drain proof. Parent lease loss still
throws its original reason. Workspace cleanup remains deferred until after terminal submission;
it does not consume a second optional timer. `WORKER_VALIDATION_CLEANUP_TIMEOUT_MS` configures the
validation runners, not this summary-budget formula.

Ordinary summary failures and model-worktree changes stay in the optional model state. They do not
add `execution.blockers`, which the Server would treat as incomplete evidence. Unconfirmed process
teardown or a Worker health fault is different: the adapter reports `cleanupUnconfirmed`/`nodeFault`,
and the profile composer adds `SUMMARY_LIFECYCLE_UNCONFIRMED` under `model_review` and reports the
node fault. Runner check/source/evidence fields remain intact while unsafe lifecycle state prevents
eligibility. Existing policy remains driven by original runner checks and finalized assets; a
successful summary can add P0/P1 observations but cannot turn
a failed check into approval eligibility.

Server semantic validation permits summaries only for the matching summary workflow/work-item
kind, with `modelReview.state = not_requested`. It requires the exact existing schema and rejects
model-supplied checks, source state, execution details, or evidence fields before persistence.

The Issue read model now takes model advice from `report.modelSummary.reproductionConclusion`.
No summary means no model conclusion; it no longer copies the worker's conclusion into that field.
The worker's conservative `report.reproductionConclusion` remains separate and can remain
`inconclusive` while optional model advice says `confirmed`.
Passing assertions alone cannot decide whether an Issue was reproduced; that requires an explicit
mapping from the reported bug to frozen scenario expectations, beyond this summary slice.

## Verification and remaining acceptance

The local full Worker suite passed **1,199 tests with 18 skipped**. Targeted coverage includes legacy
Review parity, strict summary/schema/context binding, model workspace isolation and mutation,
single-budget timeout behavior, lease propagation, deferred cleanup, teardown faults, and Profile
composition with the real adapter. Server completion and separate runner/model Issue projections
also have targeted regression coverage. These checks do not establish production model acceptance.

The [native probe report](../../artifacts/codex-read-only-probe-20260907/REPORT.md) records Codex
`0.145.0` using its direct restricted-token helper with `:read-only` and
`windows.sandbox="unelevated"`. Reading the owned fixture succeeded; overwriting an existing file
and creating a new file were denied, with unchanged marker bytes. **A direct TCP connection to the
owned loopback listener succeeded.** No external endpoint or model was contacted. This probe
therefore proves only the observed filesystem denials in that helper/configuration, not network
isolation or the production summary path.

M24 subsequently exercised the actual model-backed `codex exec --sandbox read-only` path with the
elevated Windows sandbox. The parent matched the model's exact encoded command, observed successful
marker reads and denied overwrite/new-file operations, and independently counted a successful
connection to its owned loopback listener. CLI output completed and the process, listener, monitor,
and attempt closed cleanly. This confirms a loopback access gap in the tested configuration; it is
not evidence about every external destination. The optional summary is not accepted as
network-isolated. See the [production acceptance ledger](2026-09-07-production-validation-acceptance.md).

Real repository report composition also returned `SUMMARY_CONTEXT_UNSAFE` before model launch
because all configured provider-header values are treated as protected text. Short values and
ordinary transport metadata can collide with legitimate report content. Unknown authorization
headers remain protected; length or appearance cannot justify declassification. No real provider
configuration was changed to bypass this rejection.

The final M24 full Worker regression passed **1,370 tests with 28 skipped**, and the production bundle
built successfully on authorized Windows. These checks do not resolve either model boundary.
Keep the opt-in disabled until network enforcement and actual end-to-end summary acceptance are
established. Deterministic headless checks can be accepted separately with the summary disabled.

Reference points: [Profile integration](../../apps/worker/src/execution/profile-job-executor.ts),
[shared process runner](../../apps/worker/src/execution/prepared-codex-output-runner.ts),
[summary adapter and budget](../../apps/worker/src/execution/validation-summary-executor.ts),
[runtime configuration](../../apps/worker/src/execution/validation-runtime-config.ts),
[report/summary schemas](../../packages/contracts/src/validation-report.ts),
[model-state union](../../packages/codex/src/validation-job-results.ts),
[Server completion validation](../../apps/server/src/database/validation-results.ts), and
[result projection and eligibility](../../apps/server/src/database/review-run-queries.ts).
