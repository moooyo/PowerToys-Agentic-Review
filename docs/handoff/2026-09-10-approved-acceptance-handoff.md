# M41 approved acceptance handoff

The explicitly approved live publication workflow passed on `moooyo/PowerToys`. Visual Studio
installation and PowerToys build/test/UI acceptance remain unfinished. The remote project baseline
is `main` at `bdfa577`, with all three jobs green in CI run `34432088155`. This round's helper and
documentation changes have targeted local verification; the baseline CI result does not represent
a new full-suite run of those changes. Final local Git state and remote refs are recorded in the
[M41 delivery receipt](../../artifacts/m41-approved-acceptance-20260910/delivery.json).
No push to the main project repository is authorized in this round.

## Accepted publication and restored state

The first V2 attempt failed on the initial Actions-disable PUT with HTTP 409. No branch, PR,
Issue or comment was created, and readback confirmed the original settings unchanged. That
[failed receipt](../../artifacts/m41-approved-acceptance-20260910/publication-live-retained-v1/live-run1-receipt.json)
remains intact. V3 sent only `{ "enabled": false }` for that operation. The
[scope comparison](../../artifacts/m41-approved-acceptance-20260910/publication-v3-scope-comparison.json)
confirms the other 12 operations and all six payload files are unchanged within the approved scope.

V3/root session `62857` exited 0. All 13 approved mutations succeeded: 11 coordinator operations
and one POST from each of the two production publication outboxes. Each outbox retained the
deliberately lost acknowledgement as `unknown`, reconciled through GET-only reads and became
`published`, without another POST. The
[live receipt](../../artifacts/m41-approved-acceptance-20260910/publication-live-retained-v2/live-run1/receipt.json)
records the exact targets:

| Target | Publication | Final state |
| --- | --- | --- |
| Fork PR #1 | Review `5162481132`, event `COMMENT` | Closed, not merged |
| Fork Issue #2 | Comment `5612697745` | Closed |

The [independent readback](../../artifacts/m41-approved-acceptance-20260910/publication-live-v2/remote-readback-v2/verification.json)
confirmed the test branch is absent, Issues is disabled, and Actions exactly matches its original
`enabled: true`, `allowed_actions: "all"`, `sha_pinning_required: false` state. Fork `main` remains
at `3a1e642db52d45f88c0cb702b10663e1f65623f7`, the same four Actions runs remain with no new run,
and no upstream repository write occurred. The closed targets and their publication bodies remain
as the approved remote history.

The first independent REST readback is retained as failed because Issue endpoints returned HTTP
410 after the Issues feature was restored to disabled. The successful readback combined the
retained REST responses with a read-only GraphQL query for the exact created Issue and PR nodes.
No mutation was used to make readback pass.

## Diagnostics and preparation evidence

The [targeted verification](../../artifacts/m41-approved-acceptance-20260910/diagnostics-preparation-v1/verification.json)
passed two production SQLite outbox fixtures, 18 synthetic coordinator scenarios, both JavaScript
syntax checks, Biome and independent review. Failure diagnostics retain only bounded message,
documentation URL and request ID fields with exact token redaction. Oversized bodies are omitted
entirely; the 409 scenarios confirm one attempted disable, original-state readback and no branch
creation or POST. Original source copies and the initial `/mnt/d` SQLite storage-permission
failure are retained separately. The frozen production dependency stage was not modified.

## PowerToys continuation boundary

The two Visual Studio Spectre components are approved but not installed. The first attempt exited
5007; the second `RunAs` attempt was canceled at UAC. The
[final state check](../../artifacts/m41-approved-acceptance-20260910/vs-components-final-state.json)
confirms both component directories remain absent. The request to display UAC again has no reply,
so no third attempt was made. Continue only after that interaction is resolved.

The [build helper and bundle](../../artifacts/m41-approved-acceptance-20260910/build-preparation-v1/README.md)
are ready for `D:\AR\m40-0910\PowerToys` at the pinned commit above. They reuse the owned build-home
cache while requiring a new report directory. The [seven-test plan](../../artifacts/m41-approved-acceptance-20260910/powertoys-test-plan-v1.md)
selects existing Settings serialization and mocked-storage tests; it is a plan, not seven passing
tests. No PowerToys build, test or UI execution occurred in M41. M40's six `MSB8040` build failures
and their upstream logs remain retained.

After prerequisites, run the prepared build and selected tests with fresh evidence and owned
process cleanup. UI acceptance additionally needs an owned interactive environment and explicit
state restoration; the personal running PowerToys instance is not an acceptance target. Full
Worker `main.ts` on the intended VM, Issue triage, deployed OIDC and broader quality/operational
coverage remain separate work. M39 PR workflows, M40 headless summaries and the three-case quality
observations retain their recorded scopes. This milestone does not complete the whole product or
all P1/P2 work, and it does not authorize another live publication run or new targets/payloads.
