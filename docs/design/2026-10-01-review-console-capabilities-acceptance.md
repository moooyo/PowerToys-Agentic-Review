# Review Console capability acceptance

This change implements the user's accepted capability decisions after the initial
Review Console handoff acceptance. The current product behavior and deferred
decisions are documented in
[capability decisions and implementation](2026-10-01-review-console-capabilities.md).

## Verification scope

The user previously authorized local Dashboard compilation and acceptance within
this Dashboard task. Backend and Worker verification ran in the designated remote
Windows environment. Neither environment executed paid model calls, changed actual
GitHub PRs or Issues, or altered production deployment.

| Check | Result |
| --- | --- |
| Shared Contracts, Domain, and Codex builds | Passed remotely |
| Server build and TypeScript check | Passed remotely |
| Worker build and TypeScript check | Passed remotely |
| Relevant backend/Worker/Contract tests | 38 distinct files, 1,353 distinct tests passed |
| Changed backend Biome check | Passed remotely |
| Dashboard production build and TypeScript check | Passed locally with Node 24.20.0 |
| Dashboard tests | 179 files, 4,559 tests passed locally |
| Dashboard changed-file Biome check | Passed; style warnings remain |
| Browser capability acceptance | 15 accepted cases and 130 executed assertions passed |
| View matrix | 40 screenshots across both desktop widths, themes, and languages |

The remote test total counts Server 27 files / 778 tests, Contracts 9 files / 373
tests, and Worker 2 files / 202 tests. It does not add repeated compilation or test
attempts to the distinct total. A previously passing Worker/Contract scope was
retained when subsequent differences were formatting only. Final checks compared
all 52 changed backend source-file hashes with the verified checkout.

Checks used isolated stores, injected transports, and mocked GitHub responses.
The Worker runner tests supplied a process-host mock rather than a live model.
All temporary verification tasks were removed; retained source and logs are
evidence, not a deployment.

## Business assertions

- Native Prompt publication and binding use repository grants and version
  comparisons. New PR and Issue Reviews freeze their selected content, and real
  runner tests verify that the frozen template enters both snapshot and local
  source model-input paths. Fixed protocol and execution constraints remain.
- Authors and canonical trigger metadata remain bound to their source and
  receipt. Profile resolution, old-source author reads, and intake observations
  perform only read operations.
- Current comments distinguish edited, deleted, inaccessible, and retained
  historical content. Reading older progress formats cannot migrate the ledger
  or enqueue publication.
- Original finding context is bound to the report, source subject, fixed commit,
  tree, blob, and line range. A replacement suggestion is displayed separately.
- Worker contact and activity are calculated by the service. Stale contact cannot
  erase retained task or cleanup ownership. Failed reads and changed versions
  disable admission mutations, including already open confirmation dialogs.
- Missing native report publication can be restored through exact-report,
  versioned, idempotent enrollment. Existing recovery uses the publication's
  supported sync or reconciliation action. It does not create a new Review.
- If a newer root Review arrives during identity or transport preparation, a
  manual recovery fence prevents the older result from being dispatched. Normal
  automatic-publication behavior remains covered separately.
- Coverage presentation and personal dismissal were removed. Existing browser
  dismissal storage is no longer consulted. Execution limits and the shared
  comment/history policy were retained as requested.

The browser fixtures and retained screenshots cover changed views at 1440x900
and 1100x900, Chinese/English, and light/dark appearance. Final interaction
receipts retain separate asset hashes for the broad view matrix and subsequent
read-failure/confirmation deltas. They certify isolated Dashboard behavior, not
live external publication or upstream connectivity.

The 127 capability assertions used the retained matrix and read-failure builds.
A final avatar failure-state adjustment received a separate three-assertion
acceptance for successful image decoding, failed-URL fallback, and a new URL
recovering in the same mounted badge. The matrix was not repeated after that
adjustment. All 93 raw screenshots remain available with their build scope.

Final assets were `index-DOhY-TOk.js` (SHA-256
`72fc1f193c6714ffca58ce068b75635a6d709d913c4d79695fbe1a67c7330034`) and
`index-DBS-4jGL.css` (SHA-256
`329755e08752f2905dd0ef4eab3df9bb12816f9af0497111ef25c721fd7a6c91`). The preceding
127-assertion JavaScript was `index-sTTJe3q5.js` (SHA-256
`ba81a16145264c090fc274e3e911a1b50ae253bdac7c08d7bc9fae8905f5fa8b`), with the
same CSS. Browser contexts, Edge, and isolated HTTP services were closed.
