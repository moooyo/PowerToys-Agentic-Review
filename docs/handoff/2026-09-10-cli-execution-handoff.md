# M38 CLI-owned model execution handoff

Status: M38 architecture cleanup and the verification scope in this handoff are complete. The
combined test result is 12,968 passed, zero failed and two explicit Windows-only skips across 359
files. Final v5 build/typecheck/lint and Worker bundling passed. Windows native, Dashboard,
deployment and minimal configured CLI probes are recorded below. This does not declare the entire
product, real-repository model quality or full VM deployment acceptance complete.

## Source identity and change scope

The v3 source snapshot contains **1,068 files**. Its archive SHA-256 is:

```text
7a5d4cde6a600763a28867d83ea05fb86a9886acdf3770b79da2f9635eab5d73
```

The [v3 source manifest](../../artifacts/m32-evaluations-20260908/source-m38-cli-v3.json) is the
source reference for final v3 verification. Compared with the M37 snapshot, the path inventory has
**83 removed files and 16 added files**. Those counts include test files and SQL renumbering; they
are not counts of removed or added production modules. Documentation written after the snapshot
does not change which runtime source a receipt tested.

The v4 snapshot contains **1,069 files** and has archive SHA-256:

```text
f04cb934097f11258eb0f1d23c2c757b72e69daa7874696ecbebdd920e91bba2
```

Production runtime sources are identical between v3 and v4. The changes used for the four-file
retest are test-fixture corrections plus documentation updates. The
[combined result](../../artifacts/m38-cli-execution-20260910/combined-test-results.json) retains
the exact full-suite and retest receipt identities and source-change set. A subsequent change to
`packages/codex/src/launch-spec.test.ts` only formats one line break; its compiled JavaScript is
byte-identical before and after, as recorded in the
[format proof](../../artifacts/m38-cli-execution-20260910/format-token-proof.json). Passed tests
were not rerun for that formatting-only change. The v5 fresh stage completed final
build/typecheck/lint and Worker bundling without repeating the completed tests.

The verified v5 build snapshot contains **1,069 files** and has archive SHA-256:

```text
be8bf6947bd566ea23fe90268bf24820b642f58c0c06877cf4ae1fd923a52f82
```

The [build-source proof](../../artifacts/m38-cli-execution-20260910/build-source-proof.json)
compares v4 and v5 and reports `runtimeSourcesUnchanged: true`. Its only source change is the
test-formatting file above. Together with the compiled-JavaScript format proof, this preserves the
test/runtime relationship across the v3 full run, v4 fixture retest and v5 final build.

The active design is [CLI-owned model execution](../design/2026-09-10-cli-owned-model-execution.md),
within the [single long-lived Worker per VM](../design/2026-09-10-single-worker-vm.md) deployment.

Removed scope includes project-owned provider profile parsing, provider metadata classification,
Responses relaying and HTTP observation chains, global runtime/provider registrations, separate
app-server model composition, and invocation opening/sealing/ledger submission. The Dashboard no
longer needs provider registration, runtime selection or an HTTP invocation-ledger drawer. These
paths are removed rather than retained as unused compatibility backends.

The product is unreleased. Current schema/initialization definitions are maintained directly;
this change does not create an old-version migration, database reset, data conversion or
compatibility project. No existing database or historical acceptance artifact is rewritten.
SQL file changes and renumbering are source changes, not evidence that an existing database was
modified.

## Current execution and retained guarantees

Ordinary model review and Evaluation use the same selected Codex or Copilot CLI runner. The CLI
owns login, user settings, model-service access, provider configuration and HTTP traffic. The
project does not read or copy CLI authentication/provider files, reset the CLI home, or introduce
a second provider configuration for Evaluation. CLI processes receive the account configuration
needed by the CLI while project control credentials remain excluded. Source/build commands retain
their separate minimal environment.

The Worker supplies the prepared workspace, trusted task prompt, authoritative output schema,
cancellation signal and resource limits. Codex uses its stdin/schema/result-file interface;
Copilot receives stdin and streams bounded output for task progress. Adapter JSON-format
instructions do not become a claim about the provider's raw request. Completion requires an
observed process exit, drained streams, bounded output and schema-valid JSON. Missing output,
partial JSON or an otherwise successful exit cannot become a completed model result.

Existing Server capabilities, quotas, active Job leases, Worker-instance/generation checks,
cancellation, terminal replay and source/result ownership remain. ProcessHost process-tree
supervision, timeout/process/memory/output budgets, workspace accounting, cleanup and node-fault
handling remain. One VM can process successive tasks through the same long-lived Worker; the VM
deployment owns account, filesystem and network isolation. This is not a new OS-attestation or
signed execution-admission system.

`CliModelExecutionV1` records the owning Job/attempt, selected CLI kind, detected version, nullable
requested model, task prompt hash, output-schema hash, canonical output hash and successful exit.
Completed model output remains separate from Worker execution evidence, deterministic runner
checks, source state and finalized evidence. The Server recomputes output consistency and checks
the current task/lease and frozen source/Profile/Prompt before completion.

The existing authenticated summary-input freezing workflow and optional `summaryInputRef` remain.
They retain composed Prompt/runner/evidence context ownership without a provider registry or
invocation-opening/seal/ledger dependency. Summary advice cannot invent runner facts or imply
OS-enforced read-only confinement. Model requirements contain only `required`; a null requested
model means CLI default, not an independently observed remote-model identity. Valid individual
results can be scored without requiring both arms to use the same CLI selection; comparisons
retain the recorded CLI/version/model context and its limitations.

## Deployment configuration

`WORKER_MODEL_EXECUTION_ENABLED` retains its default of `true`. When execution and model execution
are enabled, only the first two CLI settings below are required:

| Setting | Meaning |
| --- | --- |
| `WORKER_CLI_ENGINE` | `codex` or `copilot`. |
| `WORKER_CLI_EXECUTABLE_PATH` | Installed CLI application path. |
| `WORKER_CLI_HOME` | Optional CLI-owned persistent home; never copied into an attempt. |
| `WORKER_CLI_MODEL` | Optional model choice passed to the CLI. |
| `WORKER_CLI_SHA256` | Optional executable hash pin. |

There is no configured CLI version. ProcessHost runs bounded `--version` detection with a
20-second/64-KiB limit and retains the first stdout line. CLI paths may be outside the trusted
infrastructure root; Windows WinGet application links resolve to their installed targets.
ProcessHost/Git retain their existing trusted-root and required SHA-256 rules.

Model resource settings are `WORKER_MODEL_MAXIMUM_HARD_TIMEOUT_MS`,
`WORKER_MODEL_MAX_PROCESSES`, `WORKER_MODEL_MAX_MEMORY_BYTES` and
`WORKER_MODEL_MAX_OUTPUT_BYTES`. Existing Git, aggregate-process, disk and validation-target
budgets remain separate. Worker capabilities expose nullable `cliEngine` and `cliVersion`;
both are null for model-free execution. Operators log in through the selected CLI under the
actual Worker identity and intended home. Version detection is not login or model-call acceptance.

The [deployment template](../../deploy/worker/worker-config.template.psd1),
[launch helper](../../deploy/worker/start-worker.ps1) and
[deployment runbook](../../deploy/worker/worker-e2e-runbook.md) describe the active configuration.
Worker credential provisioning is unchanged.

## Confirmed verification

| Verification scope | Confirmed result | Scope boundary |
| --- | --- | --- |
| Native Windows ProcessHost | 235 Go tests passed, zero failed/skipped; vet and build exited 0. | Native helper verification, not a real model run. |
| Native direct-CLI smoke, run 2 | Synthetic Codex success, Copilot success, Codex cancellation, then another Copilot success through the real built ProcessHost. | CLI behavior was synthetic; real model invocations, desktop operations and real repository mutations were zero. |
| Cancellation regression | Native verification receipt records 80 passing regression tests, successful targeted typecheck and Biome check. | Scoped cancellation verification, not the complete v3 workspace gate. |
| Deployment launcher | PowerShell 7.6.5/Pester 3.4.0: one wrapper case passed, zero failed/skipped; exit 0; both source hashes unchanged. | The wrapper ran the complete standalone launcher regression script. It did not start a Worker, CLI or ProcessHost, read credentials or write to an external repository. |
| Dashboard v2 | Production build and 3,578 tests across 114 files passed. | Applies to the recorded v2 source. The compared 347-file Dashboard set differs in v3 only by the two-line, type-only `defaultSettings`/`satisfies` correction. |
| Dashboard Windows run 2, v3 | Contracts emission, Umi setup and Dashboard TypeScript checking all passed; staged source matched v3 before and after. | This run did not repeat the production build or 3,578 tests. Its exact type-only source comparison binds the earlier v2 build/test evidence without claiming a second execution. |
| Full workspace v3 under WSL | Build, typecheck and setup passed. The complete run executed 12,970 cases across 359 files: 12,963 passed, five failed and two Windows-only cases skipped. | The five original fixture/old-cancellation assertion failures remain in the original receipt. This run is not relabeled as wholly passing. |
| Complete four-file v4 retest | 215 passed, zero failed/skipped, covering all tests in the four corrected files. | Production runtime sources are identical to v3. The retest replaces those files' earlier results in the reconciled result; its passes are not simply added to the full-suite total. |
| Reconciled workspace result | 359 files, 12,970 cases: 12,968 passed, zero failed and two explicit Windows-only skips. | File and case sets were checked when producing the combined result. It combines the full v3 run with the complete affected-file v4 retest. |
| v4 build/typecheck and formatting | Type/build gates passed. Biome reported one line-break formatting error in `launch-spec.test.ts`, with 66 warnings and 11 informational diagnostics. | Only that test's formatting was changed; compiled JavaScript stayed identical. The failed lint receipt remains. |
| Final fresh-stage v5 | Shared and Server builds, Worker/Server/Dashboard typechecks, Dashboard setup, Biome and actual Worker/web-driver bundling all exited 0. Biome checked 180 files with zero errors, 66 warnings and 11 informational diagnostics. | Sources matched after execution; the removed journal owner was absent; the receipt recorded no failure. Completed tests were not repeated in this compilation/bundle stage. |
| Configured Codex model probe | One no-tool prompt returned strict `{"status":"ok"}` through the current account/default model in approximately 11.4 seconds. | Command capture reported complete with zero commands. Host exit was 0, owned child PIDs were absent and no node fault was recorded. This was not a repository review or model-quality evaluation. |
| Configured Copilot model probe | One no-tool prompt returned strict `{"status":"ok"}` through the current account/default model in approximately 27.1 seconds. | Command capture reported incomplete with zero observed commands; complete internal tool capture is not established. Host exit was 0, owned child PIDs were absent and no node fault was recorded. |

Native evidence is in the
[Windows verification receipt](../../artifacts/m38-cli-execution-20260910/windows-native-build-v1/verification.json),
[Go summary](../../artifacts/m38-cli-execution-20260910/windows-native-build-v1/go-summary.json),
[smoke run 2 receipt](../../artifacts/m38-cli-execution-20260910/windows-native-build-v1/smoke-run2/receipt.json)
and [source-stability record](../../artifacts/m38-cli-execution-20260910/windows-native-build-v1/source-stability.json).
The ProcessHost executable SHA-256 is:

```text
2811238c88a6f2b38247f2cd68ac60570c58ecd5b0fe490c6dc593b2d9dfd7ea
```

Smoke run 2 completed with no node faults, all recorded owned child PIDs gone, and ProcessHost
exit 0. The source-stability receipt reports no changes to the 34 captured native files or 307
compiled smoke inputs. This establishes the recorded process/protocol and consecutive-task scope;
it does not establish an authenticated real provider call or general VM isolation.

The native receipt separately records installed CLI `--version` observations from owned empty
homes: Codex `codex-cli 0.145.0` and `GitHub Copilot CLI 1.0.70.`. Those are metadata observations
only. Verification scripts did not read provider or authentication files for that check.

Deployment evidence is retained in the
[launcher test report](../../artifacts/m38-cli-execution-20260910/deploy-tests-run1/REPORT.md),
[Pester XML](../../artifacts/m38-cli-execution-20260910/deploy-tests-run1/pester-results.xml) and
[source/result summary](../../artifacts/m38-cli-execution-20260910/deploy-tests-run1/summary.json).
Pester counts one wrapper case, not the individual assertions inside the standalone harness.

The [combined workspace result](../../artifacts/m38-cli-execution-20260910/combined-test-results.json)
references the [original v3 full run](../../artifacts/m38-cli-execution-20260910/verification/wsl/verify-run3-20260910/verification/tests/vitest-results.json)
and [complete v4 four-file retest](../../artifacts/m38-cli-execution-20260910/verification/wsl/verify-run4-20260910/verification/tests/vitest-results.json).
The retested files were `apps/server/src/routes/review-runs.test.ts`,
`apps/server/src/database/validation-result-projection.test.ts`,
`apps/server/src/database/validation-result-rebuild.test.ts` and
`apps/worker/src/execution/review-executor.test.ts`. The five corrected expectations belonged to
fixtures or old cancellation assertions; no production-source change is used to combine these runs.

The two retained platform skips are explicit:

- `apps/server/src/config.test.ts`: `loadConfig evidence storage rejects Windows UNC roots and case aliases inside SQLite`.
- `apps/worker/src/execution/validation-runtime-config.test.ts`: `native Windows validation file checks opens real synthetic files without launching a process`.

They require native Windows and were skipped in the WSL run. The native Go, smoke and deployment
results above are separate scopes; they do not silently convert these two test cases into passes.

The [final v5 receipt](../../artifacts/m38-cli-execution-20260910/verification/wsl/verify-run5-20260910/verification/tests/verification-receipt.json)
records eight successful commands, `sourcesAfterMatched: true`, `removedOwnerAbsent: true` and
`failure: null`. Its SHA-256 is:

```text
3ef24c7e35b27156a079e1d19f68593c4ea9fa32adf4f062a104bb7721490c54
```

The emitted `worker.mjs` SHA-256 is:

```text
0064d137b493d128b4ce0d7e1542bd9ec1139984441872fb370c4268adf297bf
```

All six emitted files were copied to the
[retained Worker bundle directory](../../artifacts/m38-cli-execution-20260910/worker-bundle/)
and individually matched against the receipt hashes: `worker.mjs`, `worker.mjs.map`,
`worker.meta.json`, `web-driver.mjs`, `web-driver.mjs.map` and `web-driver.meta.json`. The receipt
retains each file's size and hash. This is actual bundle generation, not a typecheck substituted
for a build. The stage launched no production Worker, model CLI, UI or service.

The [Dashboard Windows run 2 receipt](../../artifacts/m38-cli-execution-20260910/dashboard-local-run2/reports/verification-receipt.json)
binds its source to the v3 archive and records all three successful compilation/setup stages.
Its SHA-256 is:

```text
3fb41fe9f24958214afd8aab2d4462fe719c362628410deb9cee0d6db62042bc
```

The [real Codex receipt](../../artifacts/m38-cli-execution-20260910/real-codex-run1/receipt.json)
and [real Copilot receipt](../../artifacts/m38-cli-execution-20260910/real-copilot-run1/receipt.json)
both exist and record one successful configured CLI/model response. Each records
`requestedModel: null`, exact structured output `{"status":"ok"}`, no observed file change,
successful Host closure, absent owned child PIDs and an empty fault list. The probes used the
machine's current CLI login/configuration without changing it. The harnesses did not manually
read or copy provider/authentication files and performed no actual PR/Issue write.

The CLI versions were Codex `codex-cli 0.145.0` and `GitHub Copilot CLI 1.0.70.`. Codex reported
`commandCapture: "complete"` with `commandCount: 0`; Copilot reported
`commandCapture: "incomplete"` with `commandCount: 0`. The latter means zero commands were
observed, not that all internal tool operations were enumerated. No-tool instructions, configured
CLI defaults and valid JSON do not independently identify a provider's underlying model or
establish repository review quality. These two real calls are distinct from the earlier synthetic
process smoke and version-only metadata observations.

## Retained failures

1. Remote run 2 encountered resource scarcity: the Worker typecheck process was killed with
   `SIGKILL`, without a TypeScript diagnostic. SSH was briefly unavailable and later recovered.
   That run is not a passing typecheck, and the absence of a diagnostic is not proof of source
   correctness. The later completed WSL runs and their reconciled result are separate evidence.
2. Native smoke run 1 misclassified cancellation as `CLI_PROCESS_DRAIN_UNCONFIRMED` instead of
   retaining the original synthetic cancellation. The
   [failure](../../artifacts/m38-cli-execution-20260910/windows-native-build-v1/smoke/failure.json)
   and [cleanup receipt](../../artifacts/m38-cli-execution-20260910/windows-native-build-v1/smoke/failure-cleanup.json)
   remain. Cleanup confirmed all owned processes gone. The cancellation correction, targeted
   regression and successful native smoke run 2 do not erase this initial failure.
3. Dashboard run 1 failed type checking. A type-only `defaultSettings` correction using
   `satisfies` was applied. The v2 production build/test pass remains valid for its source;
   Windows run 2 independently passed v3 contracts emission, setup and type checking after the
   correction. It did not repeat the v2 build/test commands or erase the original type failure.
4. The v3 full test run had five failures among 12,970 cases. Their old fixture expectations and
   cancellation assertions were corrected only in tests. All 215 tests in the four affected files
   passed in v4. The original five failures remain available alongside the combined result.
5. The v4 Biome gate reported one formatting error in `packages/codex/src/launch-spec.test.ts`,
   66 warnings and 11 informational diagnostics. The single line-break formatting correction did
   not change compiled test JavaScript. Existing passing tests were not rerun merely for formatting;
   the fresh v5 build/typecheck/lint/bundle stage subsequently passed, retaining 66 warnings and
   11 informational diagnostics with zero errors.

The original resource, Dashboard, native smoke, test and lint failures remain part of their stage
records. The reconciled test result does not replace those records or relabel any failed run as
wholly passing.

## Closure and remaining deployment scope

M38 closes the CLI architecture cleanup, the reconciled test run and the final emitted bundle.
The source distinction remains explicit: v3 ran the whole suite, v4 reran the four complete
affected test files without production changes, and v5 performed final compilation/lint/bundling
after a compiled-JavaScript-identical test-formatting change. No additional test pass is claimed
for v5. The two configured CLI probes establish minimal no-tool JSON connectivity, successful
owned-process cleanup and their recorded command-capture limits.

No actual repository PR/Issue write is authorized by CLI configuration, login, this handoff or
general test permission. Such actions retain their separate exact-target/operation/content
authorization requirement. Real repository review/evaluation workflows, model-quality assessment,
application-specific evidence and the intended VM deployment remain outside the two minimal
configured CLI probes and the synthetic/metadata scopes above.
