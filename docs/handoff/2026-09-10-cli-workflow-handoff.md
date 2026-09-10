# M39 CLI workflow acceptance handoff

Status: M39 is complete for the controlled-fixture workflow scope. The accepted matrix is the
complete Codex run 3 on source v5 plus the complete Copilot run 6 on source v8: three tasks per
engine, with real required checks, model output, Evaluation scoring and cleanup. This is not one
shared source/run or a combination of partial failed sequences. The validated
[workflow summary](../../artifacts/m39-cli-workflow-20260910/workflow-summary.json) retains both
source/run identities and all six task associations. Earlier failures remain historical evidence.

## Baseline and source identity

M38 was committed and pushed as `7e81d5330fe02955602e9636b009d643ea53269a` on
`codex/validation-platform-resume`. Its
[handoff](./2026-09-10-cli-execution-handoff.md) records the preceding architecture cleanup,
regression evidence, native synthetic smoke and minimal real CLI JSON probes. Those earlier
results do not substitute for M39's complete review/Evaluation task matrix.

The M39 v5 source snapshot used for Codex run 3 contains **1,076 files**. Its archive SHA-256 is:

```text
608c1297a23b91d0cd8cbbe1b1eaec2ca937a6cd65a9b9291d50dda698957993
```

The source reference is the
[M39 v5 manifest](../../artifacts/m32-evaluations-20260908/source-m39-cli-v5.json).
The opt-in harness is documented in
[CLI workflow acceptance](../../deploy/worker/cli-workflow-acceptance/README.md) and implemented
by `run.mjs`, `prepare-server.mjs`, `server.ts`, `worker.ts` and `git-fixture.ts` in that directory.
Compilation and actual runtime receipts must retain their own source identities; an earlier
successful component check does not establish that a later complete workflow passed.

Copilot run 4 used the [M39 v6 source manifest](../../artifacts/m32-evaluations-20260908/source-m39-cli-v6.json),
containing **1,077 files**, with archive SHA-256:

```text
193a74523b92fd1294ac487217ea9e4414711d0dc703ee8d6dc3bc2389031f8a
```

An earlier Worker build recorded SHA-256
`69c5f31578e7e6f8391d1684e0d89caf931de6a3b198f70e429fc98047e2ca1e` before subsequent Copilot
protocol corrections. That remains build history, not the final M39 bundle identity. Subsequent
protocol and harness process-observation builds are recorded with their own source identities below.

Copilot run 5 used the [M39 v7 source manifest](../../artifacts/m32-evaluations-20260908/source-m39-cli-v7.json),
containing **1,077 files**, with archive SHA-256:

```text
bacbb10d21afc731627b9986d26fd70f892432106998b72e8dbe73397822d12a
```

The v7 build/typecheck and Worker bundling completed with exit 0. The retained
[worker-bundle-v3/worker.mjs](../../artifacts/m39-cli-workflow-20260910/worker-bundle-v3/worker.mjs)
has SHA-256 `c69852ccf7857f1ebd9a1f794c0a73082a3f89cc1c68ba146e119b7793d659ab`.
Successful compilation did not change the failed run 5 model result or establish M39 acceptance.
The subsequent v8 terminal-semantics correction is recorded separately below.

Copilot run 6 uses the [M39 v8 source manifest](../../artifacts/m32-evaluations-20260908/source-m39-cli-v8.json),
containing **1,077 files**, with archive SHA-256:

```text
1e1d0cbe08f4b4f1852d28eac8195a030bc6dbeb13fbff0e53a09d6b3ff5ecf9
```

The v8 build/typecheck and Worker bundling passed. The retained
[worker-bundle-v4/worker.mjs](../../artifacts/m39-cli-workflow-20260910/worker-bundle-v4/worker.mjs)
has SHA-256 `b32c3a006bf9313120fc9241c614ae009a1eb3d685de5be660c4fd63d77d3bdf`.
This identifies the build used for the successful Copilot run 6 scope recorded below.
The [final source check](../../artifacts/m39-cli-workflow-20260910/final-source-check.json)
confirmed byte equality for all 1,075 compared v8 manifest files, excluding only this handoff and
the implementation-status document being finalized. No new source archive or runtime retest was
needed for those two documentation updates.

## Acceptance scope

Each engine must execute one ordinary pull-request review and both baseline/candidate arms of one
Evaluation. Codex and Copilot therefore have **three tasks each, six tasks in total**. A CLI task
can make multiple model requests; six tasks is not a count of provider HTTP requests.

The Windows side uses real production Worker lifecycle/execution components, ProcessHost, the
installed configured CLI, Git worktree preparation and a deterministic Node validation check.
The WSL side runs a real Server with its own SQLite database, HTTP APIs, frozen tasks, result
processing and scoring. Worker registration, leases, terminal acknowledgements and result
submission use the existing implementations rather than synthetic model or success responses.

The one Git transport substitution maps the exact randomly named fictional HTTPS fixture fetch
to an owned local bare repository. It does not replace Git execution, commit/worktree validation,
the Worker task lifecycle, Node check execution, model output, Server persistence or scoring.
The fixture pull request exists only inside this acceptance run's isolated database. No actual
GitHub PR or Issue is created, reviewed, commented on, labeled, published or otherwise mutated.

This is a composition of production components, **not a deployment through Worker `main.ts`**.
It does not accept the full production startup, credential provisioning, service-manager or VM
deployment path. The harness requires explicit `--allow-real-models` opt-in and uses the current
CLI account/login/configuration. The CLI owns authentication, provider selection and model HTTP
traffic; the harness does not read, copy or reset CLI auth/provider files. The existing task and
result protocols and isolated fixture data are used without an additional provider configuration
or schema migration.

## Controlled repository and expected observations

The owned repository documents `applyDiscount(price, percent)` with a percentage in the range
0 through 100. Its base commit divides `percent` by 100; the fixture head replaces that with
`price * (1 - percent)` in `src/discount.js` at line 2. This creates a concrete percentage
calculation defect. Both immutable commit identities are retained by the fixture.

The dependency-free `node check.mjs` check covers zero-percent examples only. It is intentionally
insufficient to prove all documented behavior, and passing it is not proof that the percentage
defect is absent. Model reviews must be evaluated from their actual source-supported findings;
the harness must not manufacture a finding or score from its expected location.

Prompts restrict the exercise to the disposable checkout and forbid file modification, dependency
installation, remote fetch/push, GitHub access and credential inspection. These instructions and
the owned fixture define the authorized exercise; they do not prove Windows/WSL network
confinement. Copilot's current adapter reports incomplete command capture, so its command list
cannot establish that every internal tool operation was observed.

Successful workflow reporting requires the ordinary review and both Evaluation cells to retain
their exact task/attempt, source, Prompt/Profile, CLI metadata, structured result, required-check
and scoring associations. Independent runner checks and model findings remain separate. A model
finding, CLI exit 0 or a terminal Job alone cannot replace the remaining workflow evidence.

## Production PATH correction and harness corrections

The first actual workflow failed during Git environment construction before any model dispatch.
The production correction in `main.ts` supplies Git with a PATH limited to
`<SYSTEMROOT>\System32`, while CLI and Profile execution retain the complete account PATH.
Git still uses its configured absolute executable. The change does not remove the account
configuration needed by the selected CLI or by profile tools.

The targeted [main regression receipt](../../artifacts/M39/main-path-fix/run2/receipt.json)
and [test result](../../artifacts/M39/main-path-fix/run2/main.test.json) record **40 passed,
zero failed and zero skipped**, with process exit 0. The first test collection attempt failed in
its collection environment before running any cases and is retained under
[main-path-fix/run1](../../artifacts/M39/main-path-fix/run1/). It is not counted as a test pass.

The owned [construction check](../../artifacts/m39-cli-workflow-20260910/construction-check-v1/)
reproduced the Git PATH construction problem using components without a model task, supporting
the correction independently of model output. A successful construction check remains narrower
than a complete Worker workflow.

Run 2 also exposed a harness hard-timeout mismatch: the frozen required check allowed 300,000 ms,
while the prepared runner allowed only 120,000 ms. The check was therefore `not_run`. Runner
capacity was then aligned to 300,000 ms. The per-engine workflow budget is 900,000 ms; individual
production task and no-progress budgets still apply.

After run 2, the harness was changed to observe the real terminal acknowledgement before failing
fast. A failed
task, missing completed model result or unsuccessful required check synchronously requests Worker
drain after that acknowledgement, lets owned cleanup complete and prevents another model task
from being claimed. This is a harness control around the actual HTTP response; it does not replace
terminal persistence or manufacture a success. It avoids consuming more model work after an
already failed acceptance condition.

## Retained preparation and execution history

| Stage | Recorded outcome | Scope and retained limit |
| --- | --- | --- |
| Source-run 1 | Server compilation/type checking passed. | Worker/harness compilation was not included; this was not a complete source verification. |
| Source-run 2 | Three Worker TypeScript errors were found and subsequently corrected. | The original compile failure remains; no passing runtime is inferred from the fix. |
| Source-runs 3, 4 and 5 | Complete acceptance-harness compilation passed. | Compilation did not establish real-model workflow or cleanup success. Run 3 used source-run 5. |
| Actual run 1 | Failed in Git PATH construction before a model task. | Server and Host closed. The failure and construction-check reproduction remain part of the record. |
| Actual run 2, Codex | Two real Codex model steps completed and reported the fixture defect. | The required Node check was `not_run` because of the harness timeout mismatch. The third task was manually stopped; this run is failed/interrupted history, not a successful three-task workflow. |
| Actual run 2 cleanup | All recorded owned PIDs and workspaces closed. | Cleanup does not turn the failed/incomplete task matrix into a pass. Server-retained results preserve what actually completed. |
| Actual run 3, Codex 0.145.0 | Ordinary review, Evaluation baseline and candidate all passed with required checks passed, original source and completed model output. Both Evaluation cells completed and an assessment was persisted. | Accepted for this owned-fixture three-task scope; not a general model-quality benchmark or Worker `main.ts` deployment acceptance. |
| Actual run 3, Copilot 1.0.73 | The ordinary required check passed and the CLI exited 0, but final text failed JSON parsing with `CLI_INVALID_RESULT_JSON`. | Acknowledgement-based fail-fast/drain stopped after one task. Baseline and candidate did not execute. All owned processes/workspaces closed; that engine attempt failed. |
| Actual run 4, Copilot 1.0.73 | The ordinary task passed; Evaluation baseline failed with `CLI_INVALID_EVENT_STREAM` despite its required check passing. | Candidate never started. Four reservations released, workspaces empty and Host/Server exits 0. The historical numeric-PID observer reported reused identifiers, not established surviving owned processes; the next stage added bounded JSONL diagnostics. |
| Bounded parser diagnostics v1 | 305 tests passed across four files, zero failures/skips; `noEmit` typecheck and Biome exited 0. | This verified diagnostics without changing parser acceptance, making real model calls or recording raw model output/reasoning. |
| Source v7 / Worker bundle v3 | Full build/typecheck and Worker bundling exited 0. | A passing build is not a passing real Copilot task sequence. |
| Actual run 5, Copilot 1.0.73 | Ordinary required check passed and CLI exit was 0, but the first JSONL rejection was `reason: "after_result"`, `eventIndex: 594`, `eventType: "other"`. | Baseline/candidate never started. A JSON event after the terminal result is established; its exact event type is not. All 32 managed process trees completed, both reservations released and Host/Server closed. |
| Terminal semantics v1 / source v8 | 328 tests passed across four files, zero failures/skips; `noEmit` typecheck, Biome, build/typecheck and Worker bundle generation passed. | Codex behavior was unchanged. The correction freezes one successful root response while continuing full-stream validation; it does not identify the unknown run 5 event as usage. |
| Actual run 6, Copilot 1.0.73 | Ordinary, baseline and candidate passed; required checks passed and model branches completed. Both Evaluation cells completed and an assessment was written. | One Worker instance executed the three-task sequence; all 102 managed process trees completed, all six reservations released, and Host/Server closure passed. |

Retained source stages are under
[source-run1](../../artifacts/m39-cli-workflow-20260910/source-run1/),
[source-run2](../../artifacts/m39-cli-workflow-20260910/source-run2/),
[source-run3](../../artifacts/m39-cli-workflow-20260910/source-run3/),
[source-run4](../../artifacts/m39-cli-workflow-20260910/source-run4/) and
[source-run5](../../artifacts/m39-cli-workflow-20260910/source-run5/).
Actual execution history remains under
[run1](../../artifacts/m39-cli-workflow-20260910/run1/) and
[run2](../../artifacts/m39-cli-workflow-20260910/run2/), including the Codex
[Server-retained evidence](../../artifacts/m39-cli-workflow-20260910/run2/codex/server-retained/).
Do not replace these records with later results or reuse an earlier accepted result as a new
Evaluation cell. Private harness inputs can contain temporary access tokens and are not shared
report material; they are distinct from CLI login storage.

## Current matrix

| Engine | Ordinary PR review | Evaluation baseline | Evaluation candidate | Scoring and cleanup |
| --- | --- | --- | --- | --- |
| Codex 0.145.0, run 3 / source v5 | Passed | Passed | Passed | Assessment persisted; cleanup passed |
| Copilot 1.0.73, run 6 / source v8 | Passed | Passed | Passed | Assessment persisted; cleanup passed |

### Accepted Codex run 3 scope

The [engine receipt](../../artifacts/m39-cli-workflow-20260910/run3/codex/receipt.json),
[Worker receipt](../../artifacts/m39-cli-workflow-20260910/run3/codex/worker/receipt.json),
[Server report](../../artifacts/m39-cli-workflow-20260910/run3/codex/server-retained/report.json)
and [Server closure](../../artifacts/m39-cli-workflow-20260910/run3/codex/server-retained/closure.json)
record the successful ordinary/baseline/candidate sequence. All three tasks used Worker instance
`9796983f-f308-4e4c-a822-659f46d0e7c6`, completed their real required checks and model steps, and
retained original source. Both Evaluation cells completed and assessment
`c74f3c01-52c2-4245-ae27-62998133c199` was written through the Server.

The integration owner manually inspected all three finding bodies. Each accurately identified
`src/discount.js:2`: removing `percent / 100` makes `applyDiscount(100, 25)` return `-2400` instead
of `75`. This is a source-supported observation on the controlled fixture. The persisted
assessment still treats the finding quality as provisional/unjudged; manual inspection here
does not manufacture a formal true-positive adjudication, precision/recall score or general
model-quality benchmark.

The Worker admitted and released six reservations, corresponding to separate validation/model
workspaces for three tasks. No active/abandoned reservation, workspace entry or surviving owned
PID remained. Host and Server exits were 0, and the Server closure retained no failure or cleanup
failure. The accepted Codex scope and its original receipts were retained through the separate
Copilot corrections. The v8 terminal-semantics receipt records unchanged Codex behavior.

### Copilot run 3 failure and retained result

This run observed `GitHub Copilot CLI 1.0.73.`, rather than the earlier M38 `1.0.70.` metadata.
The [engine receipt](../../artifacts/m39-cli-workflow-20260910/run3/copilot/receipt.json),
[Worker receipt](../../artifacts/m39-cli-workflow-20260910/run3/copilot/worker/receipt.json) and
[Server closure](../../artifacts/m39-cli-workflow-20260910/run3/copilot/server-retained/closure.json)
retain the actual failure and shutdown. The first ordinary task's deterministic check passed,
but a CLI exit of 0 did not supply valid final model JSON. The model branch failed with
`CLI_INVALID_RESULT_JSON`; it was not converted to a successful model result.

The Server acknowledged the structured ordinary report, including its failed model state. The
task's terminal `succeeded` status therefore must not be read as passing model acceptance.
After that real acknowledgement the harness correctly entered fail-fast/drain, executed no
further tasks and closed all owned processes and workspaces. Its overall Worker receipt is
`failed`. That attempt did not satisfy two-engine acceptance.

The `server-retained/results` export is empty because shutdown happened before the reporting poll.
The original structured result remains in the closed synthetic SQLite database; an empty export
is not evidence that the result was lost or never persisted. The integration owner's
[read-failed-result helper](../../artifacts/m39-cli-workflow-20260910/read-failed-result.mjs)
can read that retained record. The original failed result is not replaced by a later successful
attempt. A subsequent Copilot stdout-protocol change allowed run 4's ordinary task to complete,
but it did not establish a complete three-task pass.

### Copilot run 4 baseline failure and process observations

The [engine receipt](../../artifacts/m39-cli-workflow-20260910/run4/copilot/receipt.json),
[Worker receipt](../../artifacts/m39-cli-workflow-20260910/run4/copilot/worker/receipt.json) and
[Server closure](../../artifacts/m39-cli-workflow-20260910/run4/copilot/server-retained/closure.json)
retain the ordinary success and baseline failure. The ordinary task completed its required check
and model branch. The baseline completed its real required check but its model branch failed with
`CLI_INVALID_EVENT_STREAM`. After the actual terminal acknowledgement, fail-fast/drain prevented
the candidate from starting. The original results remain in the closed synthetic database and
retained Server evidence. This sequence is failed acceptance, not a two-of-three partial pass
that can be reported as the complete Copilot workflow.

Four reservations were admitted and released; active/abandoned reservation counts, workspace
entries and active process requests were zero. Host and Server exits were 0, and the Server's
`cleanupFailures` array was empty. The original Worker receipt nevertheless listed historical
numeric PIDs `40464` and `42032` in `survivingOwnedPids`. That field did not establish that the
original owned processes survived.

The retained [PID-reuse observation](../../artifacts/m39-cli-workflow-20260910/run4/copilot/pid-reuse-observation.json)
shows that both recorded Git processes had already exited with code 0. PID `42032` was later a
Chrome process started after the Git exit; PID `40464` then identified `svchost`, whose start time
was not available to the inspection. These are not identified surviving owned Git processes.
No process was terminated by that inspection, and the old numeric field is preserved rather than
rewritten as a clean result.

After run 4, the harness replaced historical numeric PID probes with `completedProcessTrees`, derived
from fulfilled managed completion observations with recorded exit/signal information and no
failure. A passing receipt requires completion of all recorded process trees, zero active
requests and successful Host closure. ProcessHost publishes completion only after its owned Job
Object has drained. Run 5 subsequently exercised this observer and confirmed all 32 recorded
managed process trees completed. That does not erase the original run 4 field or resolve the
separate Copilot event-stream failure.

At this stage the Worker owner continued Copilot stdout diagnosis. The later bounded diagnostics
and terminal-semantics correction are recorded below; no provider or relay path was introduced.

### Copilot run 5 trailing-event diagnosis and confirmed cleanup

The [diagnostics verification receipt](../../artifacts/m39-cli-workflow-20260910/copilot-parser-diagnostics-v1/verification.json)
records 305 passing tests across four files, zero failures/skips, successful `noEmit` type checking
and a successful two-file Biome check. It explicitly records no parser acceptance-rule relaxation,
real model call, provider/auth-file read or raw model-output/reasoning capture for that verification.

The subsequent real [engine receipt](../../artifacts/m39-cli-workflow-20260910/run5/copilot/receipt.json),
[Worker receipt](../../artifacts/m39-cli-workflow-20260910/run5/copilot/worker/receipt.json) and
[Server closure](../../artifacts/m39-cli-workflow-20260910/run5/copilot/server-retained/closure.json)
preserve the ordinary task failure. The required check passed, the CLI exited 0 and the model
branch remained failed. The bounded diagnostic identifies the first rejected event as
`reason: "after_result"`, `eventIndex: 594`, `eventType: "other"`. This confirms a JSON event
arrived after the terminal result. `other` is not the event's exact type; usage metadata has not
been established as its cause or type. This observation led to the subsequent terminal-semantics
correction; the unknown historical event has not been relabeled as a known event type.

Acknowledgement-based fail-fast/drain prevented both Evaluation arms from starting. The Worker
recorded 32 managed processes and `completedProcessTrees: 32`, zero active requests, no remaining
workspace entries and two admitted/two released reservations. Active and abandoned reservation
counts were zero. Host and Server exits were 0; Server closure recorded no failure and no cleanup
failure, with retained files preserved. This confirms the scoped process/workspace cleanup while
keeping model execution and the complete Copilot workflow failed.

### Verified Copilot terminal semantics and run 6 boundary

The [terminal-semantics receipt](../../artifacts/m39-cli-workflow-20260910/copilot-terminal-semantics-v1/verification.json)
records **328 passing tests across four files**, zero failures/skips, `noEmit` typecheck exit 0
and two-file Biome exit 0. The independent contracts review reported no new defect. Combined with
the 40 main tests, the final targeted set is **368 passing tests across five distinct files**.
The earlier 305-test diagnostic stage is not added again. M38's full suite was not rerun for M39.

The corrected parser treats one successful result marker as closing the last complete root
assistant response. Trailing informational, usage, tool, subagent or otherwise irrelevant events
cannot replace that closed response. A duplicate result, later root message, new turn/message
start or abort is rejected. The entire stream still must satisfy UTF-8, JSONL shape, event-count,
line and byte bounds, output-schema validation, actual process exit and stream-drain requirements.
It is not an instruction to stop decoding after the first result or ignore malformed trailing data.
These general terminal rules do not prove that the unretained run 5 event was usage metadata.

The verification receipt records unchanged Codex behavior and no real model calls, provider/auth
file reads, raw model-output/reasoning diagnostic capture or additional session ledger/provider
layer during the component verification. The v8 build and bundle above contain the correction.

### Accepted Copilot run 6 scope

The [engine receipt](../../artifacts/m39-cli-workflow-20260910/run6/copilot/receipt.json),
[Worker receipt](../../artifacts/m39-cli-workflow-20260910/run6/copilot/worker/receipt.json),
[Server report](../../artifacts/m39-cli-workflow-20260910/run6/copilot/server-retained/report.json)
and [Server closure](../../artifacts/m39-cli-workflow-20260910/run6/copilot/server-retained/closure.json)
record a passed Worker, Server phase `complete`, Server `passed: true` and one Worker instance,
`155fbf1c-e40c-4375-a6ff-14212a21e8a9`, for all three successful tasks:

| Stage | Attempt ID |
| --- | --- |
| Ordinary | `9396fd56-0f6e-4c0e-929a-3b421d88e581` |
| Baseline | `7d6111c3-b21c-4ce0-b889-8b59bff2f6c6` |
| Candidate | `6bdd85dd-93f8-4d55-b733-732b5bd17d8f` |

Evaluation `e2dfa6ef-74c6-483c-a7c6-1c6a8e4f706a` retained both completed cells and assessment
`dda8eca2-561c-4180-9559-0b23427cf493`, version 1, scorer `explicit-matching-v2`. Each arm had one
completed case, check coverage 1/1, one unjudged finding, `provisional: true` and null precision
and recall values. The integration owner manually read all three result bodies and confirmed
the missing `/ 100` finding and the `100,25 -> -2400` versus `75` example. This does not turn
provisional finding quality into a benchmark or formal true-positive adjudication.

Model-issued additional assertions that failed while reproducing the known defect are bug
verification observations, not failed mandatory runner checks. Every required runner check passed.
The Worker confirmed **102/102 managed process trees completed**, six admitted/six released
reservations, zero active requests/monitors/reservations, zero abandoned reservations and no
remaining workspaces. Host and Server exits were 0; Server closure had no failure and an empty
`cleanupFailures` array.

## Final scope and retained summary-generation failure

The workflow summary checks all six tasks, identical hashes for the four fixture files, each
engine's complete three-task sequence, 102 completed process trees and six released reservations
per engine, Host/Server closure and the scoped assessment facts. It does not splice successful
tasks from failed Copilot runs into the final run 6 sequence.

The initial summary script incorrectly required an optional successful-engine `failure` field to
be literal null even when JSON omitted it. The retained
[first summary script](../../artifacts/m39-cli-workflow-20260910/summarize-success-failed-v1.mjs)
records that artifact-processing error. The summary check was corrected to accept absent/null
failure fields; no runtime source changed and no model/workflow was rerun for that correction.

M39 establishes the recorded controlled-repository workflow and fixture-specific findings/scoring
observations. It does not establish broad model quality, actual upstream repository review
acceptance, a deployed Worker `main.ts` lifecycle, Windows/Web UI behavior or full VM isolation.
No actual PR/Issue write was performed. Full Worker `main.ts`/Windows VM deployment acceptance
remains the next separate deployment boundary; it does not keep this controlled-fixture scope open.
