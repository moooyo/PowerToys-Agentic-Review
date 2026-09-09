# Real Web validation acceptance

Status: positive Web execution and the deliberate negative control passed their acceptance gates,
including complete evidence and Dashboard presentation. The negative validation correctly remains
failed. The broader implementation objective remains open.

## Scope and execution boundary

The real source is `moooyo/kiss-translator-m3`, repository ID `1132386004`, pinned at
`d32380d8401a4d0d34f9622bfc87f676fd037214`. Issue `2147483001`, the Server database, operator,
and Worker credential are isolated synthetic data. The Windows client uses the production
`createExecutionRuntime`, disposable Git workspace, cooperative disk accounting, native
ProcessHost, UI coordinator, Web driver, evidence uploader, and HTTP result projection. The
production factory's Node workspace backend is used; this does not establish native workspace
security or cancellable Windows filesystem I/O.

No actual repository PR or Issue is written. The isolated Server has no GitHub integration and
rejects outbound `fetch`; the source is fetched anonymously. Model summaries are disabled and the
harness rejects a Codex process before dispatch. Public dependency installation is separate from
the browser policy: the tested browser is restricted to the exact managed application origin.
See [AGENTS.md](../../AGENTS.md) for the external-write approval rule.

These are application and credential controls, not network-layer isolation of arbitrary build
children. The ordinary ProcessHost `CreateProcess`/JobObject path does not install a network
policy, and `pnpm install` runs dependency lifecycle scripts. The user rule applies to those
scripts too. The reviewed harness contains no live PR/Issue write operation and no such write was
performed; this acceptance does not claim that every possible child-process network write is
technically blocked.

## Required behavior and evidence

The source's standalone Web homepage supports a real light-to-dark-to-light theme interaction.
It does not require the userscript bridge needed by the separate options application. The frozen
profile installs dependencies, runs `build:web`, and serves the resulting unmodified `build/web`
bytes through a reviewed GET/HEAD-only helper. The explicit build environment
`REACT_APP_SITEURL=.` makes the source template's favicon relative; no source or response rewrite
is used.

The [source scenario review](../../artifacts/m26-real-web-20260907/source-scenarios.md) specifies
the exact public role/name locators, assertion observations, and current protocol limitations.

| Case | Required observation | Required assets |
| --- | --- | --- |
| Positive | Two real clicks and seven assertions: correct hero heading, light state, dark state with the previous action absent, then restored light state with the dark action absent. All three report checks pass. | Seven assertion screenshots, one ordered steps asset, one trace. |
| Deliberate negative control | Enter dark state, then compare the real, uniquely located hero heading with deliberately incorrect expected text. Preserve the failed `assertText`, its actual title, and the planned restore click as `not_run`. The validation remains failed. | Four assertion screenshots, one ordered steps asset, one trace. |

The negative control requires a separate immutable profile version and Run. It deliberately changes
an assertion expectation, not application bytes, and is not a reported source defect. Each case
must verify exact check and ordered step sets, downloaded evidence ownership, byte counts and
SHA-256 values, original source state, faithful HTTP projection, and complete process/workspace
cleanup. Dashboard acceptance must show the same observed result and evidence. A page-load
screenshot, successful upload request, or anticipated asset count alone does not prove this gate.

The saved steps contract does not contain the raw driver reason code. For a failed `assertText`
with a non-null actual observation, the production Web parser requires `assertion_failed`.
That classification can be inferred from the enforced parser invariant; it must not be described
as a field directly read from the HTTP report or downloaded steps.

## Defect found by real execution

The first positive run launched the real Web driver, which exited zero, but the coordinator then
spent approximately 255 seconds in source verification without progress events. The unchanged
180-second no-progress policy caused lease loss before an accepted result could be submitted.
This remains a failed acceptance, with no accepted UI result or complete evidence claim.

`ui-profile-runner.ts` now emits `source_capture_started` and `source_capture_completed` around
the existing initial, prerequisite, after-scenario, before-cleanup, and after-cleanup source
captures. All five capture sites remain. Only finite operation boundaries report progress; pending
captures, disk monitor ticks, and timer pulses cannot keep a stalled execution alive. Aborted
execution suppresses events, so cleanup cannot renew a lost lease.

The second positive attempt exposed a harness budget mismatch: its Worker hard limit was
840,000 ms, below the immutable profile's 900,000 ms limit. The command bridge's
`#assertProfileLimits` rejected it before commands ran; the executor reported
`PROFILE_EXECUTION_FAILED`. The corrected harness reads the exact frozen profile before claiming
its job and validates its capacity requirement. It restores Worker capacity to 900,000 ms,
reserves 240,000 ms for cleanup, and uses a fresh fixed 1,260,000 ms API
lifecycle for its 1,140,000 ms client limit. The immutable profile, no-progress limit, and product
capacity checks are unchanged.

The corrected third run submitted passing installation, build, and UI checks. The Server recorded
the Run as `succeeded`, with `sourceState: original` and no execution blockers. The harness then
expected `execution.cleanupState: completed`, whereas the returned result contained `not_needed`.
It stopped at that assertion before its evidence download verifier. The existing executor
normalizes completed cleanup to `not_needed` when the frozen profile has no cleanup commands;
the published profile has none. This is a harness expectation error. Independent read verification
subsequently downloaded all nine assets, validated their bytes and ownership, matched all nine
ordered steps, and retained the original resource-closure evidence. It accepted the existing result
without starting another Worker or changing the original failed harness report.

## Accepted evidence and limits

The [execution ledger](../../artifacts/m26-real-web-20260907/REPORT.md) records exact Run IDs,
failure artifacts, bundle pins, verification results, and lifecycle records. The complete local
Worker suite after the progress change passed 1,374 tests, skipped 28, and failed none; skipped
cases are not counted as platform/UI acceptance.

The [positive acceptance resolution](../../artifacts/m26-real-web-20260907/positive-acceptance.json)
binds the original report, independent evidence verification, and Dashboard functional result.
The seven assertion screenshots, steps, and trace total 3,792,249 downloaded bytes. The original
light and dark screenshots visibly show the theme transition. The Dashboard browser checks
confirmed the result, evidence list, steps download, and image decoding without console, page,
HTTP, or blocked-request errors. The initial preview image was captured before the modal was
visible and is excluded from visual acceptance. A separate browser repeat waited for settled
animation, stable bounds, opacity, and an unobscured image, then recorded the complete visible
preview. That screenshot was visually inspected.

The trace was also parsed as an archive and event stream: 44 entries, 33 before/after event pairs,
two click calls, seven screenshot calls, and 60 frame snapshots. This confirms meaningful trace
content in addition to the original asset's hash and size.

The separate negative version also passed acceptance. Installation and build passed; the actual
UI check failed at the deliberately mismatched heading. Downloaded steps retain the full actual
homepage title, the wrong expected text, and the restore click as `not_run`. Four screenshots, one
steps asset, and one trace totaled 3,163,058 verified bytes. Source remained original, blockers were
empty, and all owned client resources were closed. The Dashboard displayed the failed UI check,
complete evidence, and a visible PNG preview. Both synthetic Issue results retain reproduction as
`inconclusive`; this test makes no real Issue reproduction or approval recommendation.

The negative trace was parsed independently: 42 entries, 89 before/after pairs, one click, four
screenshots, and 171 frame snapshots. Final database inspection confirmed that all eight sets of
preexisting history rows remained byte-identical after the separate negative run. All owned M26
API lifecycles, native clients, and acceptance browsers closed.

This scope does not cover Windows desktop interaction, translation providers, the extension/options
runtime, language selection, pixel comparison, model summaries, or real Issue reproduction. Those remain
separate work; the broader implementation objective remains open.
