# CI and product completion recovery handoff

Status: CI, code fixes, quality revalidation, six Issue summaries and publication v2 preparation
are verified within their recorded scopes. The code has been fast-forwarded to local `main`;
final local/remote refs are recorded in the [delivery receipt](../../artifacts/m40-ci-product-20260910/delivery.json).
Live publication and Visual Studio installation still await explicit approval.
Do not replay completed model runs or replace earlier failed receipts with later results.

## Branch and CI

- Delivery branch: `main`; implementation branch: `codex/ci-product-completion`.
- Current verified pushed commit: `62297f72861b3bcdd2bc04804602c29532218713`. Earlier work includes `4a475af`, `7648bb6`, `c7364b2`
  and `a288735`; subsequent fixes are `de66f61` (six-file lint correction), `2abd9ce`
  (diagnostics and Issue harness) and `a6e0997` (portable model schema).
- First CI run `34422839545`: Windows and ProcessHost passed. Linux type checking passed, then one
  boundary test failed because it misidentified the acceptance harness. Retain that failure.
- Second CI run `34424470445`: failed on the Dashboard alias boundary; that issue was corrected.
  Preserve the failed run rather than treating the correction as its passing result.
- CI run `34425263241` at `c7364b2`: Windows/ProcessHost passed; Linux typecheck/tests/build passed
  with 13,287 tests passed and 61 skipped, then seven lint errors failed the last stage.
- Those seven errors were reproduced and corrected; Biome passed over the final 907-file source
  selection. This does not relabel the old CI run as passing.
- CI run `34428485996` at `a6e0997` failed a Worker 5,000-ms test during a 2-MiB Buffer deep
  comparison; the reported case took 5,254 ms. Windows/ProcessHost passed. Retain the failed run.
- `62297f7` changes exactly two test assertions to native `Buffer.equals`, preserving production
  uploader code, sample bytes, timeout and other assertions. Linux and Windows each passed all
  51 targeted tests, plus `noEmit` and Biome. The local Linux baseline did not reproduce five seconds;
  its two hotspots changed from approximately 1,382/702 ms to 10/9 ms in bounded before/after runs.
- Final CI run **34429398701** passed all three jobs at `62297f7`, completing at
  `2026-09-10T02:46:33Z`. Linux typecheck/tests/build/lint passed: **13,395 passed, 61 skipped,
  zero failed**. Windows Worker passed **1,972 with 44 skips**; native Go and PowerShell checks
  passed. Lint checked 907 files with zero errors, retaining 132 warnings and 13 informational diagnostics.

The [final CI summary](../../artifacts/m40-ci-product-20260910/ci-final-62297f7/summary.md) and
its JSON/log companions retain all job and package counts. The Linux log SHA-256 is
`c065c71950a5da945c7a79be3c190504ef0093d949a63cd19b12758e3434a735`.
The [Buffer-comparison receipt](../../artifacts/m40-ci-product-20260910/evidence-buffer-comparison-v1/verification.json)
has SHA-256 `ef4025792a06b50bbce15d677c18c619725e8362cd1ed6ca526497fa51b548e4`.
This test-only fix did not change production source or replay the six accepted model tasks.
The implementation branch has been fast-forwarded into local `main`. The delivery receipt
records the final documentation commit, pushed refs and the separate main-push CI run.

Build/boundary/native evidence is retained under
[M40 artifacts](../../artifacts/m40-ci-product-20260910/), including `ci-build-root-v1` through
`ci-build-root-v4`, `ci-boundary-v1`, `ci-windows-worker-v1` and `ci-windows-ui-v1`.

## Verified product fixes and outstanding approvals

| Work | Confirmed progress | Remaining boundary |
| --- | --- | --- |
| P1 finding validation | [finding-validation-run3](../../artifacts/m40-ci-product-20260910/finding-validation-run3/) passed 395 tests, `noEmit` type checking and lint. | Preserve earlier run 1/run 2 failures and source/log identities; this is targeted evidence, not a new full-suite claim. |
| P2 publication | [V2 preparation](../../artifacts/m40-ci-product-20260910/publication-prepare-v2/verification.json) passed both synthetic outbox cases, 13 coordinator scenarios, syntax, Biome and independent review; seven production-boundary tests also passed. | The [13-operation V2 plan](../../artifacts/m40-ci-product-20260910/publication-prepare-v2/approval-bundle-v2/approval-plan.json) is prepared and unapproved. The original 11 operations and all payloads remain unchanged; only Actions suspension/restoration was added. No live fork operation has executed. |
| PowerToys prerequisites | Pinned source restore passed; native build failed with six `MSB8040` errors. The owned build process tree completed and Host exited 0. | Installation of the two specified Visual Studio Spectre components is a separate pending approval. No installation approval has arrived. |
| Summary diagnostics v2 | 318 tests, `noEmit`, Biome and an independent review passed. | This verifies bounded diagnostic handling, not a successful new model workflow. |
| Portable model schema v2 | 327 tests, `noEmit` and Biome passed across the six model schemas; subsequent real run 3 was accepted. | Earlier failed run 1/run 2 receipts remain unchanged. |

The fork has Actions enabled and an active Spell workflow may comment automatically. Publication
V2 therefore proposes **13 operations**: temporarily disable Actions first, retain the original
11 operations and every payload, then restore Actions last. It does not cancel workflow runs.
The reviewed bundle is `artifacts/m40-ci-product-20260910/publication-prepare-v2/approval-bundle-v2`;
its plan SHA-256 is `3306bb01a1016777c6454f1033618173cb64af39e06d62da04b89721c983cf7d`.
The new approval request supersedes the old 11-operation question. Neither plan has been
approved or executed, and the old plan is not an executable fallback.

The two Visual Studio component installations are also **unapproved**. Silence, elapsed time or
general implementation/testing permission grants neither authorization. No external fork/live
publication mutation or Visual Studio installation has occurred in this work.

## PowerToys and shared local tools

- Owned source: `D:\AR\m40-0910\PowerToys`, pinned to
  `3a1e642db52d45f88c0cb702b10663e1f65623f7`.
- [Build receipt](../../artifacts/m40-ci-product-20260910/powertoys-build-v1/receipt.json): native
  command exit 1, `processTreeCompleted: true`, Host exit 0. Restore success does not make the
  native build or profile acceptance pass.
- All six upstream build logs were copied byte-for-byte and checked against their SHA-256 values;
  the [retained-log receipt](../../artifacts/m40-ci-product-20260910/powertoys-build-v1/upstream-retained/receipt.json)
  preserves this failed build history independently of the original build-log location.
- The user's personal PowerToys instance is still running. This work did not launch its own UI.
  Do not assume the personal instance belongs to this run or terminate/reset it as test cleanup.
- Shared tools are under `D:\AR\m40-0910\tools`; Git and ProcessHost were copied there.
  No CLI authentication files were copied.

## Closed nine-task quality run and retained receipt failure

The nine real Codex tasks under
[quality-run1](../../artifacts/m40-ci-product-20260910/quality-run1/) reached `succeeded`, and
Windows execution session **50446 is closed**. Four human adjudications were recorded. Each
Evaluation arm reports three checks, TP 2, FP 0, FN 0, duplicates 0, unjudged 0, precision 1,
recall 1 and `provisional: false` for this fixture and its recorded adjudications.

The original acceptance receipt nevertheless remains **failed**: its final assertion still
expected six reservations and encountered `18 !== 6` for the nine-task run. The owner corrected
the cardinality to derive from `expectedTaskCount`. The separate
[retained-evidence revalidation](../../artifacts/m40-ci-product-20260910/quality-checker-correction-v1/retained-quality-revalidation.json)
completed, with SHA-256 `5ff889f8978f611698566b828cb0be8dfec4f1290dd986517783fc17fce0193f`.
Eight checker regressions, `noEmit`, checker bundling and Biome passed. Original receipts were
unchanged, and no model task was replayed. Keep the corrected post-run verification distinct from
the original failed acceptance status.

The candidate healthy-case model explicitly stated that it did not complete the full base/head
review. Preserve that limitation. Successful task states and fixture precision/recall of 1 do
not establish complete review coverage or a general model-quality benchmark.

The WSL stage is `/tmp/agentic-review-m40-quality-20260910-run1`. Its source snapshot is
`m40-quality-v1`, **1,088 files**, archive SHA-256:

```text
1f3ca12bbfac513f83a6db655ac15381d94923795369b64678da35a737e26241
```

The then-unfinished `issue-summary-acceptance` directory was excluded from this quality snapshot.
The separate Issue/summary run used its own later source below. Preserve the quality source,
logs, task identities, four adjudications, reported coverage limitation and original failed receipt.
The revalidation confirmed 18 admitted/released reservations and cleaned workspaces, 324 completed
process trees, zero active requests/monitors/reservations and Host/Server exit 0. Do not restart the
closed session, repeat adjudications or substitute a new source into the old run.

## Issue/summary history and accepted run 3

The `cli_server` owner prepared the Issue/summary helper, with supporting records under
[issue-summary-preparation-run1](../../artifacts/m40-ci-product-20260910/issue-summary-preparation-run1/)
and [issue-summary-source-review1](../../artifacts/m40-ci-product-20260910/issue-summary-source-review1/).
Its intended scope is one ordinary task plus both Evaluation arms per CLI: six tasks total.

Actual run 1 used `D:\AR\m40-0910\issue-summary-run1`. Windows execution session **62153 exited 1**.
The ordinary runner succeeded, but its real optional model summary failed with
`SUMMARY_EXECUTION_FAILED`. The two Evaluation tasks and the Copilot sequence did not run.
The failed outcome is retained; this was not a completed six-task acceptance.

Its source is `m40-summary-v1`, **1,093 files**, archive SHA-256:

```text
586147d48b0dd3d3ed27688df3b179a169536d71781542f828cdc4e9042e2d44
```

The WSL stage is `/tmp/agentic-review-m40-summary-20260910-run1`. Keep its source, logs, failed
summary result and available shutdown evidence. Do not relabel the failed optional summary as
successful because the runner passed.

Run 2 exposed the concrete request failure: HTTP 400 rejected a regex lookaround in the model-facing
schema at `observations.items.properties.path.anyOf[0].pattern`. This was a schema portability
problem, not a provider-configuration problem. The run 2 diagnosis and all nine retained Server
files were saved; Server closure exited 0. Worker and coordinator receipts remain failed.

Bounded redacted diagnostics and preservation of existing exception code/message were corrected
and verified. The portable schema correction was also verified as recorded above. No provider
settings or CLI authentication files were changed to bypass the rejected schema.

**Run 3/session 23027 exited 0. All six tasks are accepted for the frozen headless measurement
case; completion was recorded at `2026-09-10T02:18:50Z`. Do not replay them for the CI test fix.**

- Run data: `D:\AR\m40-0910\issue-summary-run3`.
- Configuration: [issue-summary-run3-config.json](../../artifacts/m40-ci-product-20260910/issue-summary-run3-config.json).
- Unified source: `m40-integrated-v2`, **1,105 files**, archive SHA-256
  `5e431ed84012d49a3c9794940da84b447d500c4f75c95f9c0e830255c4789899`.
- WSL stage: `/tmp/agentic-review-m40-integrated-20260910-run2`.
- Windows shared build and Linux Server/shared build/typecheck passed. The 907-file source Biome
  check passed. `workspace-source-comparison.json` recorded all 1,105 snapshot files matching.

The [independent semantic review](../../artifacts/m40-ci-product-20260910/issue-summary-run3-independent-review/REVIEW.md)
accepted all six summaries' numerical facts, scope and evidence attribution. Codex and Copilot each
completed ordinary plus both Evaluation tasks on one Worker instance. The engines ran sequentially
with different instances; four cross-task boundaries prove previous cleanup completed before the
next task. Each engine retained 108 native managed completions (102 Git, three probes, three CLI),
two frozen summary inputs and six deferred cleanups: **216 completions, four frozen inputs and
12 cleanups total**. Startup version probes are outside the managed task-process count.

Host/Server closure passed. Only after closure were both Server directories copied; all 19 files
per engine, **38 total**, matched their originals. Exact task/result/input/closure identities and
the sequential-cleanup proof are in the independent-review directory:

- `REVIEW.md`: SHA-256 `ff2a3b4a97c8bc38629c145215d6a5b4ac4fc9d5786ce6055c159a2a678f8cd8`.
- [retention.json](../../artifacts/m40-ci-product-20260910/issue-summary-run3-independent-review/retention.json): SHA-256 `0bc3fea09a212a0811038f623cc2bcc5f47181a875f67870a17e5a6c10b5cd3c`.
- [closed-server-copies.json](../../artifacts/m40-ci-product-20260910/issue-summary-run3-independent-review/closed-server-copies.json): SHA-256 `9888c05aa118dcbb2dbad0c49efcd1588fd089e26dea28617f6afddc365693ea`.

Acceptance is limited to the frozen Issue #1064 sample using unmodified v2.0.32 timedtext/rule
processing at `7dfc03ebc7f10530681109f6a5aec982a5573936`. It excludes installed-extension,
video-playback, AI-segmentation, translation and GUI behavior. A minor wording issue concerning
the input's final U+0020 is retained by the review; it did not alter timing or primary/control
conclusions and did not require rewriting results. Ordinary V1 advice remains in
`report.modelSummary` with `modelReview.not_requested`; the managed CLI evidence proves it ran.

## Remaining closeout

CI, quality post-run revalidation and the six headless Issue summaries are verified within their
recorded scopes. Preserve the earlier CI, cardinality and summary failures unchanged. The remaining
external work requires approval of publication v2's prepared 13-operation bundle and separate
approval of the two Visual Studio components. Do not execute the old 11-operation plan.
`5787871` contains the reviewed publication-only follow-up after the green CI revision. The main
fast-forward and documentation delivery retain the verified production runtime; exact refs and
push results are recorded in the delivery receipt.

No live fork PR, Issue, comment or settings mutation, and no Visual Studio installation, has
executed in this pass. Existing M38/M39 acceptance retains its own scope and does not complete the pending
PowerToys/VM deployment, UI, Issue triage, live publication, OIDC or broader model-quality scope.
