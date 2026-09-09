# Validation platform resumed handoff

Latest status: the scoped M34 Windows UI acceptance has completed. Continue from
[the accepted Windows UI handoff](2026-09-09-windows-ui-accepted-handoff.md).
The history below preserves the earlier resumed stages and their source captures.

Date: 2026-09-09. The user resumed the plan after the
[paused handoff](2026-09-09-validation-platform-paused-handoff.md). This document supersedes its
implementation stop point, not its original execution results. Overall platform delivery remains
incomplete; model/Evaluation and deployment acceptance remain open. The earlier Windows UI
stop points below are superseded by the accepted handoff linked above.

## Workspace and authority

- Workspace: `D:\Code\PowerToys-Agentic-Review`.
- Working branch: `codex/validation-platform-resume`, based on `742897319a59b650d1f3274c719bc1752b4457b8`.
- This increment has not been committed or pushed. New source and test files are present in the
  working tree and included in the source captures. Do not transfer only `git diff` or HEAD.
- The user subsequently approved this Windows machine for the scoped local builds, native
  driver tests and real Notepad++ UI acceptance. That authorization remains valid; do not ask
  for it again. Server/SQLite verification continues on Linux `ssh test-env`. Native UI work
  requires idle keyboard/mouse input and the existing shared desktop lease.
- No actual model/provider invocation, real PR/Issue mutation, machine-account change, sandbox
  setup, VM provisioning, firewall change or registry change occurred.
- Never access, enumerate or inspect metadata beneath `apps/worker/.tmp-ui-driver-V7AOfu/`.
  Continue using explicit source paths and the existing exclusion-aware capture helper.
- Preserve all prior results and private configuration exclusions from the paused handoff. Do not
  reuse old fixture credentials, old exclusive output paths or closed runtime instances.
- User-facing communication remains Chinese; code, comments and documentation remain English.

## Windows ownership correction

The production driver now distinguishes the root and selected owner's complete required chain
from other descendants. Transient non-required processes can become ineligible without blocking
the healthy required chain. Both parent snapshots, held creation identities, session, creation
order, the cumulative identity budget and final whole-tree pruning remain enforced. Publication
replaces the live set only after confirmation. Window/UIA actions and TCP confirmation recheck
held ancestry at use time.

See [the correction design](../design/2026-09-09-windows-ownership-recovery.md) and these files:

- `apps/worker/src/ui/windows-driver-entry.ps1`
- `apps/worker/src/ui/windows-driver.test.ts`
- `apps/worker/src/ui/testdata/windows-fixture.ps1`
- `apps/worker/src/ui/windows-ownership-algorithm.test.ts`
- `apps/worker/src/ui/testdata/windows-ownership-harness.cs`

The original readiness failure regression remains. Four native cases were added for helper exit
after pinning, selected GUI-owner exit, intermediate ancestor exit with root/GUI still alive, and
a stable descendant TCP listener. Cleanup retains simultaneous assertion and cleanup errors.
Twenty-two deterministic cases compile the actual production ownership methods with test-only
OS observations; no fake process tree was added to the production protocol.

The original Notepad++ Run remains blocked with incomplete evidence. It was not restarted or
rewritten. The separately created v2 Run below reached the UI steps and retained a different
failure. Neither Run provides completed positive/negative acceptance.

## Local Windows continuation

The later authorized native run passed all 65 tests with no failures or skips:
`artifacts/m34-native-acceptance-20260909/verification/native-full-quiet-v1/receipt.json`.
The user confirmed keyboard activity during the preceding native failures. All failed reports
remain retained. The owned PowerShell module cache path correction also passed 165 mocked
Worker tests; the final Dashboard build succeeded after replacing unsupported BigInt literals.

Clean source v7 contains 1,131 files, with archive SHA-256
`9c44d05e02cb7a065956bd7b19143da300705d2586ca4d0557e20e4e63e90fba`:
`artifacts/m32-source-20260908-m34-native-v7.tar.gz`. Source v6 included a generated PowerShell
cache and must not be used. This handoff and the later focus correction postdate v7; do not
claim that a subsequent working tree is identical to that archive.

Real fixture v2 (`4a93f887-a4f0-4257-94d9-6f18c98e47c2`) ran a new Worker checkout and successfully
built Notepad++ commit `2f50e44ffe9aa607a0e50e1f2ab143e0daed1391`. Its positive Run
`6e92aa55-4d4d-487a-8dd7-95eb3e645184` failed because the single New toolbar Invoke returned but
`new 2` never appeared. The ordered outcomes were `passed, passed, passed, failed, not_run,
not_run`. The negative case was never activated. Job status `succeeded` means the terminal
result was accepted, not that its UI check passed.

The real Dashboard independently displayed the passed build, failed UI check and four retained
evidence assets. All four asset sizes, hashes and ownership matched. The original post-click
image showed only `new 1`. See
`artifacts/m34-native-acceptance-20260909/dashboard-preparation/forensic-positive-v2/readback-v2/`.
The earlier forensic locator/comparison failures remain retained as well.

The v2 Worker/Host/UI and desktop lease closed cleanly. Server v2 stopped explicitly at
`2026-09-09T07:22:18.864Z`, closed HTTP/SQLite and revoked its Worker credential. Its source,
spec, Dashboard and configuration matched, with no closure errors. The owned SSH forward was
also stopped. Records are under
`artifacts/m34-native-acceptance-20260909/verification/fixture-public-v2/` and
`D:/AR/m34ui-0909-v2/public/`. Do not restart v2, reuse its private credentials or rerun its
exclusive client output paths.

A separate, bounded diagnostic compared fresh copies of the pinned public Notepad++ build.
Both applications started in the background. The unchanged driver reproduced the missing tab;
the candidate that focused the verified top-level window before the single Invoke passed all
six unchanged assertions. Independent inspection confirmed `new 1` plus `new 2` and no third
tab. Both diagnostic Hosts and desktop leases closed cleanly. See
`artifacts/m34-native-acceptance-20260909/invoke-diagnostics/comparison-v1.md`.

The production focus correction and its background/occlusion regressions passed the complete
67-test native file, with zero failures/skips and confirmed Host/lease closure:
`artifacts/m34-native-acceptance-20260909/verification/native-full-focus-v1/receipt.json`.
The same production driver passed all six real Notepad++ diagnostic assertions. Intermediate
focused fixture preparation/callback observations and a TypeScript diagnostic remain retained
in `focus-regression-diagnostics.md`; the final typecheck and formatting reports are
`worker-typecheck-v8-run3.json` and `biome-v8-run3.log` under the same verification directory.

Fresh v3 public client/Server/Dashboard acceptance preparation is underway; there is no live v3
instance yet. Diagnostic success does not replace a new Worker checkout, build, positive and
deliberate negative Run, evidence verification and Dashboard inspection. The next capture is
`m34-focus-v8`; do not substitute the older v7 driver or any standalone diagnostic binary.

## Execution foundations

Two independent implementation slices are now present:

1. `packages/contracts/src/windows-attempt-execution-lease.ts` and its tests define strict,
   bounded lease metadata, role/root bindings, canonical bytes and digest/current-snapshot
   consistency checks. They do not establish signature trust or effective OS permissions.
2. `packages/domain/src/windows-attempt-lifecycle.ts` and
   `apps/worker/src/execution/windows-attempt-lifecycle.ts`, with adjacent tests, provide journal
   replay/CAS rules and orchestration through injected ports. They retain intent/outcome history,
   protect cancellation and quarantine, separate execution closure from retention, reject stale
   owners and late completion, and bound each journal/adapter wait. Tests model independent commit
   clocks and unknown writes. The default adapter returns `ADAPTER_UNAVAILABLE`.

The [foundation design](../design/2026-09-09-windows-execution-foundations.md) records exact limits.
No durable journal implementation, global recovery scanner, OS adapter, signed execution evidence,
Server challenge consumption, lease renewal or production admission integration exists in this
increment. Existing Evaluation refusal and `executionAccepted: false` remain unchanged.

## Retained verification

Evidence root: `artifacts/m34-ancestry-20260909/verification/`.

- `csharp-static-run2/compile-receipt.json`: full production C# compiled against .NET Framework
  4.8 references with C# 5 on Linux. Source SHA-256:
  `250f89b3908137658c3a1543018497b4c5ba8cb98e57d99ad97cac0248a2f653`.
- `fixture-csharp-static-run1/`: full fixture C# also compiled with C# 5/net48. Source SHA-256:
  `46c6eea7b7ba4af1ae502b583446b09332c7d226c112c48b56360190f75cdcbf`.
- `worker-stage-run4/independent-receipt.json`: 55 contract tests, 16 domain tests and 49 Worker
  tests passed, with zero failures and 34 native tests skipped. The Worker count includes one test
  that runs all 22 ownership cases; those 22 are not another 22 Vitest tests.
- The original C# run1 warning, inconsistent concurrent capture in source v1, intermediate
  TypeScript failures and formatting diagnostics remain in their original run directories.
- No PowerShell parser/runtime was available at the checked remote paths. C# compilation and
  synthetic process observations are not PowerShell execution or real Windows acceptance.

Prepared final source v5 has 1,130 files and SHA-256
`8e3d07f008525f975135b329c3f913ee013a749cdaef7cca59768f5924efb24b`:

- Archive: `artifacts/m32-source-20260908-m34-ancestry-v5.tar.gz`.
- Manifest: `artifacts/m32-evaluations-20260908/source-m34-ancestry-v5.json`.
- Capture helper: `artifacts/m32-evaluations-20260908/capture-source.mjs`.

This handoff is written after that capture; do not claim that the complete later documentation
tree equals the archive. Source v5 differs from the successful v4 behavior tests only by a typed
local SDK alias in the test runner and one domain formatting line.

### Final verification result

The [final stage receipt](../../artifacts/m34-ancestry-20260909/verification/worker-stage-run5/stage-receipt.json)
records successful fresh shared package builds, Worker type checking, a fresh Worker bundle,
the selected Worker tests and ten-file Biome checks. All 1,130 captured source files matched
their original hashes after verification. Biome reported no errors and nine warnings confined
to non-null assertions in synthetic test fixtures.

The final Worker run passed 49 tests with no failures; 34 Windows-native tests remained skipped.
Its ownership harness passed all 22 internal cases. The already successful 55 contract and 16
domain tests are associated with v5 through
[exact source identities and the one-line formatting delta](../../artifacts/m34-ancestry-20260909/verification/worker-stage-run5/source-association.json).
The total relevant coverage is 120 passed Vitest tests, not the sum of every overlapping run.

The final [runtime asset manifest](../../artifacts/m34-ancestry-20260909/verification/worker-stage-run5/runtime-assets.json)
records 121 assets. `worker.mjs` SHA-256 is
`4bb1e48e5022a90a6551661cc0b7c754cdc0bdc8fcd1b844900d6498596987b6`.
The bundled Windows driver matches the production source SHA-256
`250f89b3908137658c3a1543018497b4c5ba8cb98e57d99ad97cac0248a2f653`.

Final isolated Linux source/build root:
`/tmp/agentic-review-m34-ancestry-worker-20260909-run5`.
No application, model, native fixture or platform service was started by these checks. There is
no running M34 acceptance instance to resume. Historical failed captures and command reports
remain available in runs 1-4 and have not been changed to passing.

## Historical next execution sequence before v3 acceptance

1. Preserve the successful 67-test native run and all earlier failures. Local Windows verification
   is already approved; keep Server/SQLite checks on `ssh test-env` and retain account-wide desktop
   exclusivity and all original exclusions.
2. Capture the frozen focus correction and build fresh Worker/runtime assets. Reuse the unchanged
   Server/Dashboard build only through the explicit source association; do not present inherited
   test results as new executions.
3. Prepare fresh Worker/native assets and a new immutable M34 fixture/client/execution root. Check
   all source/runtime/helper pins and paths. Preserve the corrected `client/launch-v2.mjs` guard.
   Complete preparation before starting the short-lived fixture Server.
4. Complete the actual Notepad++ positive case, independently verify screenshots and ordered steps,
   then activate the deliberate negative case. Read both results/evidence in the real Dashboard
   and close all temporary services. Never rewrite the original blocked Run.
5. Resolve the supported native/VM execution-adapter and deployment choices. Continue durable
   journal/recovery integration and separately authenticated signed prepared/closed evidence,
   invocation bindings and transactional Server validation. Only actual accepted enforcement and
   execution evidence can replace the current unconditional Evaluation refusal.
6. Complete real model/Evaluation and intended deployment acceptance, including OIDC, multi-user
   operation and persistent storage. Private checkout authentication remains a separate decision.
   M33's accepted real Issue timing claim and M26's Web acceptance do not need to be repeated.
