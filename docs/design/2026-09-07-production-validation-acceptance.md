# Production validation acceptance

Status: real-source headless production acceptance passed on 2026-09-07. Dependency installation,
Web compilation, CI tests, and original-source verification passed together through the production
runtime and HTTP result projection. The broader implementation goal remains open: optional model
summaries and actual Web/Windows UI interaction are not accepted by this result. Every test follows
the prohibition on external PR/Issue writes in [AGENTS.md](../../AGENTS.md).

## Scope

The actual public source is `moooyo/kiss-translator-m3`, repository ID `1132386004`, pinned at
`d32380d8401a4d0d34f9622bfc87f676fd037214`. The Server database, Issue identity, operator identity,
and Worker credential are isolated synthetic acceptance data. No actual Issue, assignment, review,
comment, label, state, or merge operation is created or changed.

The Windows client uses the current production `createExecutionRuntime`, disposable Git workspace
provider, cooperative disk budget, native ProcessHost, headless validation runner, HTTP completion,
and result projection. The credential reader injects only the new fixture credential into the
production configuration parser. No source, disk monitor, check result, or model result is stubbed.
The selected native CLI remains Codex 0.145.0. Existing protected tool directories and provider
configuration are not modified; a separate copied tool directory is verified by executable hashes.

The intended command sequence is frozen dependency installation, `build:web`, then `test:ci`.
The source's release workflows and release skill are excluded. Its bare Web homepage can be tested
independently, while the userscript-mode settings page requires an extension bridge. Those are
different acceptance scenarios, not interchangeable passing pages.

## Confirmed production composition defect

The production factory originally passed only `SYSTEMROOT`, `COMSPEC`, `PATH`, and `PATHEXT` to
the validation runner. The actual runner also requires the selected workspace's `TEMP`, `TMP`, and
`USERPROFILE`. A real Git fetch/checkout succeeded before runner construction failed.

The factory now supplies all seven values from the correct workspace. Regression coverage invokes
the actual runner constructor for headless, Web, and Windows UI factories and checks two distinct
workspaces plus credential exclusion. Eighteen factory tests passed.

## Active filesystem accounting

The first real dependency installation was interrupted by `SNAPSHOT_UNSTABLE` while pnpm was
creating dependency files and links. Active sampling now handles narrowly checked `ENOENT` races
for ordinary file replacement and internal dangling links. Root/attempt identity, canonical parent
paths, stable link metadata, bounded target-ancestor checks, entry/deadline limits, and inactive
deletion authority remain separate constraints.

After that correction, dependency installation completed successfully. The real Web compiler
also exited zero in about 35 seconds, but serial filesystem verification exhausted its 120-second
step budget. The report correctly remained inconclusive and the dependent test stage was not run.
Git source observations themselves caused repeated complete workspace scans, so the final source
state could not be certified within the cleanup verification budget.

Metadata validation now uses batches of at most four independent paths and fully drains each batch
before another begins or exclusive accounting is released. Directory enumeration remains sequential
and retains the actual remaining global entry allowance. An unsafe-path or limit failure takes
precedence over a retryable snapshot race. The bounded parallel implementation passed 88 disk-budget
tests, with nine additional physical filesystem tests passing on Windows.

Each source-state capture now owns one real reservation monitor around both `git status` and
`git rev-parse`. Only the private fixed argument identities used inside that capture omit redundant
nested monitors. Arbitrary calls with equivalent argument text retain their own monitor. Git filters
can perform writes, so this optimization does not rely on a claim that source observations cannot
write. Monitor start, abort, violation, or closure failure still produces an unknown source state.
The workspace suite passed 110 tests.

The validation runner retains its final source capture before cleanup. It makes another capture
after cleanup only when the profile contains cleanup commands; profiles without cleanup no longer
spend the cleanup budget on an identical second scan. The current 127-test runner suite includes both the
no-cleanup timing regression and the case where cleanup restores previously modified files.
The final repeat completed all required commands and source observations under the documented
profile and Worker budgets. This acceptance is scoped to the tested source, runtime, and deployment
layout; it does not establish the same execution time for every repository or host.

This remains cooperative accounting for trusted workloads, not an operating-system hard quota or
handle-bound protection against hostile filesystem swaps. Node filesystem I/O cannot be forcibly
interrupted by these cooperative deadlines.

## Windows package lifecycle working-directory limit

The next real attempt used the optimized accounting code but failed dependency installation with
pnpm 9.14.4's `Error: readStream must be readable`. Its required build and test stages were not run,
the final source state remained unknown, and the failed result was retained through the HTTP API.

A separate diagnostic ran 60 owned child-process probes using the same Node 24.20.0 executable and
the fixed Windows `cmd.exe`. Both tested command-line forms succeeded at working-directory lengths
220 and 255 through 258. All probes at length 259 failed with `ENOENT`; at lengths 260, 261, 265,
and 300 they additionally returned immediately unreadable standard-output and standard-error
streams. Directory creation, metadata reads, and canonical resolution had succeeded for these same
paths. Every child closed without a timeout, and the owned diagnostic directory was removed.

Static inspection of the pinned source identifies `core-js-pure@3.47.0`. Its package lifecycle
directory is 257 characters in the earlier successful installation and 261 in the newer attempt.
The diagnostic's illustrative 3.40.0 path has the same character count; it is not the version claimed
for the actual source. A fresh shorter-root repeat subsequently completed installation with the
same source and pnpm version, supporting the path-length explanation for the previous stream error.
No package-manager upgrade, sandbox fallback, or relaxed filesystem guard was used for that repeat.

The shorter-root Run `743cd6d5-dae3-4bf3-b1ee-01f936c6339c` finished at
`2026-09-07T03:51:07.752Z`. Installation exited zero in 123,331 ms and the Web compiler exited zero
in 34,477 ms. The build step still exceeded its 120-second budget, which includes the actual monitor
lifecycle, so the result remained inconclusive with `STEP_TIMEOUT` and the tests did not run.
Unlike the earlier attempts, final source verification completed as `original`. The HTTP projection
was verified and the process host closed with no remaining workspaces, active requests, or faults.

The `STEP_TIMEOUT` message now says that the validation step exceeded its execution and verification
deadline. This accurately covers a command that exits zero before its verification budget is
exhausted. The change does not alter timeout decisions or rewrite the stored earlier reports.
The 123-test validation-runner suite and targeted formatting passed after this wording correction,
and the latest Worker production build also passed.

## Copied package-manager launcher

The version-2 Run `f5a58568-c9d4-43fd-9a08-6c05e7ea6797` completed installation and the complete
build step successfully. Installation took 123,042 ms and the compiler process took 35,198 ms.
The test command exited 1 after 394 ms with `The system cannot find the path specified.` before
`test:scripts` or Jest ran. The final source state was unknown, so the acceptance remained failed.

Inspection found that the copied `Pnpm9/bin/pnpm.cmd` retained a relative reference to
`../../../node24`, which no longer resolves from the copied tool directory. The initial runtime
version check invoked pnpm through Node directly and therefore did not exercise this launcher.
This is a harness tool-deployment failure, not an observed source-test assertion failure. The
correction targets only the separate copied launcher; the original protected tool tree remains
unchanged, and the package-manager version remains pinned. The corrected launcher then passed an
actual `cmd.exe /d /s /c pnpm --version` invocation in 360 ms, returning `9.14.4`, exit zero, and a
closed child. The before/after launcher bytes and their hashes are retained in the repair evidence.

The final repeat retained profile version 2 and used a 180-second final source verification
budget. The Worker now accepts explicit budgets from 1,000 through 300,000 ms while retaining the
30,000 ms default and all existing monitoring/path guards. A simulated 75-second source observation
passes under an explicit 180-second budget and returns unknown under the unchanged 30-second
default. The complete expanded-budget Worker suite passed 1,370 tests with 28 skipped and none
failed; its production build passed. The actual complete headless repeat then passed as recorded
below.

## Model boundary evidence

Two fresh owned synthetic probes used the production prepared output runner with
`--sandbox read-only` and `windows.sandbox="elevated"`. The second probe strictly matched the
model-generated command after normalizing only its Windows executable path presentation. It
retained the exact encoded payload, observed all four nonce-delimited phases, and checked file
bytes and a loopback listener independently in the parent.

- The controlled marker read succeeded.
- The controlled overwrite and new-file attempts failed; marker bytes stayed identical and the
  new file remained absent.
- The controlled TCP connection to the owned `127.0.0.1` listener succeeded. The listener recorded
  one model-window connection after its independent positive control.
- The model process exited zero, output parsing completed, and the owned process, listener,
  monitor, reservation, and attempt all closed cleanly.

This proves a loopback access gap in the tested production configuration. It does not prove
anything about every external destination, and model prose is not used as boundary evidence.
The official [Windows sandbox documentation](https://developers.openai.com/codex/windows)
describes the elevated implementation; the concrete deployed behavior above controls acceptance.
The optional summary remains disabled by default and is not accepted as network-isolated.

## Provider metadata classification

The existing loader maps every configured provider HTTP header into native-only environment
variables. The factory and prepared output runner then treat every value as protected text.
This conflates transport metadata with secrets: the ordinary `worker` literal used in a provider
test also appears in the validation DTO, and a short protected value can match unrelated paths or
revision identifiers. Actual summary composition returned `SUMMARY_CONTEXT_UNSAFE` before invoking
the model on the real repository report.

Unknown and custom authorization headers must remain protected until their semantics are
established. Value length or numeric appearance does not authorize disclosure. A future explicit
public-metadata policy should bind the selected provider, endpoint, exact header name, and approved
literal. It must classify each header before collecting protected values; another credential or
lease with the same value must still win. No real provider value has been declassified or removed
from the existing checks during this acceptance.

## Result presentation

The production Dashboard has displayed the actual installation pass, inconclusive build,
unexecuted dependent tests, unknown final source state, and separate model-summary failure.
Browser checks and screenshots used a fresh isolated context, business GET requests, and local
fixture sign-in only. No outside-origin request, console error, or page error was observed.

A second browser acceptance displayed the shorter-root Run's installation pass, inconclusive build,
unexecuted tests, and verified `original` source state. Its model section correctly showed that no
summary was requested. `browser-headless-results.json` passed without console/page errors or
outside-origin requests, and the three headless screenshots were visually inspected. This remains
evidence of faithful failed-result presentation, not a passing headless validation.

`browser-capacity-results.json` also passed for the version-2 Run. It displayed passed installation
and build checks, the failed test command, unknown source state, and no model summary requested.
No console/page errors or outside-origin requests were observed. This additional browser pass does
not change the failed execution outcome.

The final `browser-accepted-results.json` passed for Run
`2716eb05-18b3-4e53-8ed9-971693f81788`. Its checks, model-status, and diagnostics views displayed
all three passed checks, verified `original` source, profile version 2, and no summary requested.
The screenshots were visually inspected. No console/page errors or outside-origin requests were
observed. Earlier failed-result evidence remains separate and unchanged.

Detailed run identities, immutable reports, browser recordings, and lifecycle closure records are
under `artifacts/m24-real-execution-20260907`. Failed executions remain in the isolated history;
they are not rewritten when a later implementation is tested.

## Component verification and remaining acceptance

The latest local Windows Worker production build passed. The complete suite after the explicit
budget expansion passed 1,370 tests, skipped 28, and failed none across 31 test files; focused counts
above are included in that total. The earlier full run passed 1,361 tests with 28 skipped before
the timeout-message clarification; its affected 123-test runner suite was repeated successfully
after that clarification. The latest runner suite contains 127 passing tests. Type checking and
targeted formatting checks also passed. The skipped platform/UI
integration cases are not claimed as executed. The remote Worker build stopped with `TS2307`
because that snapshot lacked `playwright-core`; no remote Worker test pass is claimed for M24.

Final Run `2716eb05-18b3-4e53-8ed9-971693f81788` passed every required command and final source
verification together. It started at `2026-09-07T04:14:15.337Z`, finished at
`2026-09-07T04:23:41.791Z`, and recorded 566,426 ms elapsed. Installation, build, and `test:ci`
all exited zero and were reported as passed; source state was `original`, execution blockers were
empty, and the HTTP result projection matched. The retained source-script output reports 10 passed
tests and none failed. Jest also ran and the combined `test:ci` command exited zero; its bounded
diagnostic prefix omits the Jest summary footer, so no Jest test count is claimed.

This is `headless_only` acceptance. Summary generation was disabled, the harness rejected Codex
launches before passing requests to the process host, and the result records
`modelReview.state: not_requested`. No model process ran. The synthetic Issue's
`reproductionConclusion` remains `inconclusive`; this does not claim reproduction or resolution of
an actual repository Issue.

The final repeat used published profile version `05d8d71f-9c4d-47db-8fd7-fc08e3e5582a`, with
240-second build/test budgets and a 900-second total hard budget. Normal publication and a
compare-and-swap repository binding selected this new version. The acceptance checked eight classes
of existing rows before and after publication; raw-row hashes remained equal for prior profile
versions, Runs, requests, job links, Run audit events, Jobs, attempts, and results. The older profile,
plans, and failed Runs remain unchanged. These budgets include retained monitoring work; no source
or disk guard is disabled.

The final run used a fresh `M24-r7-194756` root, the corrected copied launcher, and the explicit
180-second final-source budget. Its process host closed with no remaining workspaces, active
requests, or faults. The final Server lifecycle closed at `2026-09-07T04:24:19.812Z`, before its
`2026-09-07T04:33:42.012Z` deadline; HTTP/database closure and free local/remote ports were verified.
Every M24 test API lifecycle and started native client host is closed.

Actual Web interaction and Windows desktop interaction remain separate acceptance work. Optional
summaries retain their context-classification and observed loopback-isolation limitations. The
headless pass does not establish those outcomes, and no actual Issue reproduction is claimed.

The detailed M24 evidence ledger is
[REPORT.md](../../artifacts/m24-real-execution-20260907/REPORT.md).
