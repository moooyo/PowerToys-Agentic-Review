# Dashboard production alignment acceptance

Date: 2026-09-20. Product implementation, functional acceptance, independent visual
review, delivery documentation and operational closeout are complete.

Implementation branch: `codex/dashboard-m3-production`.
Published base: `0909d354c0ab813e5e9fe8a0d0e121bca0a3fbb8`.
Final production source manifest (v10):
`a9a0dfdc3be9542bdec73e8cfb2dddf75dc2c24f96ccfa94413f736db816b492`.

The accepted design package is the separate local artifact
`docs/design/dashboard-m3-redesign`. Its existing files are preserved as design
references, outside the production source submission. The
[production capture board](review/index.html) presents the implemented application.
Its images come from the production bundle and Server, not the earlier prototype.
The delivered board also passed the project's formatting/lint checks and an
offline browser check: all 143 images decoded, filtering/empty/reset behavior and
full-size links worked, and the 390-pixel view had no horizontal overflow.

## Acceptance matrix

Every row is implemented and accepted. Evidence combines meaningful automated
tests, actual production HTTP requests, browser interactions, and visual review.
The final column identifies the layers rather than implying every combination
was exercised in a browser.

| ID | Area | Accepted behavior and evidence |
| --- | --- | --- |
| S01 | Shell | Four navigation groups, contextual destinations, compact account menu, no implicit repository switch; native navigation and final captures. |
| S02 | Navigation | Deep links, Back/Forward, restored workspace scroll, record-scoped state, dirty/busy/sign-out guards and keyboard focus; browser journeys and navigation/session regressions. |
| S03 | Search | Authorized bounded results, exact links, empty state, lost-response retry and obsolete-query isolation; browser checks plus scoped read-model and shared session-boundary tests. |
| S04 | Foundation | Material color/type hierarchy, light/dark, 1440/900/390 and selected 320 layouts, keyboard and actual coarse-pointer targets; 118 final browser checks and independent visual review. |
| R01 | Pull requests | Compact source/investigation list, filters, import, source details, current investigation versus saved result, frozen discussion; native source journeys and captures. |
| R02 | Issues | Shared navigation without invented PR fields; lawful snapshot creation and recovery exercised natively, exact-source input validation covered by automated tests. |
| R03 | Create investigation | Real defaults and full budgets, source CAS, retained unknown request, identical-key recovery without duplicate Task; native response-loss and conflict journeys plus service regressions. |
| T01 | Tasks | Real lifecycle, preparation/queue/blocking explanations, queued and running cancellation, checkpoint resume, ownership until cleanup; browser, native lifecycle and automated tests. |
| T02 | Visible output | Common Codex/Copilot presentation, actual event ingestion, durable replay, retention/gaps, search/filter/export, pause/follow and two genuine attempts; producer tests, native HTTP and browser checks. |
| T03 | Usage | Reported counters and completeness, requested model, unrecorded effort, attempt separation and immutable report usage; accounting/reducer tests and actual native records. |
| T04 | Evidence | Registered uploads only, verified image/video/file bytes, provenance, explicit loading, missing/expired content and revocation; actual upload, preview, playback, download, retention and access journeys. |
| P01 | Reports | Directory, Findings/Evidence/Details, complete findings, pagination, off-page P0 approval guard and sealed provenance; native/browser checks and report regressions. |
| P02 | Report actions | Private drafts, authoritative preview, response-loss recovery, same-intent reconciliation, current source checks, exact Close/Merge state and no redispatch; actual browser journeys with isolated upstream substitutes. |
| A01 | Comments | Publication directory, exact retained bodies/times/history, delivery check versus publication, uncertain-command recovery and accessible disclosures; native publication plus browser history/recovery checks. |
| A02 | Webhooks | Receipt/phase/attempt distinctions, duplicates, retry CAS, response-loss recovery and committed-Task relinking; actual signed intake and browser checks. |
| W01 | Repositories | Focused settings, actual scope, draft/conflict protection, template selection/preview and explicit publishing authorization; real settings save/readback/restore journeys. |
| W02 | Workers | Admission/contact/task kinds distinct, numeric CAS, offline versus never contacted, ownership retained through disable, release only after original-owner cleanup; seven final browser cases. |
| W03 | Scheduling | Actual global capacity and owners, invalid-input rejection, valid 1–16 changes and restoration; native settings journey and scheduler regressions. |
| I01 | Accounts | Independent grants, versioned editing, retained CAS draft, password reset and permission consequences; real isolated-account browser journeys. |
| I02 | My account | Real identity/access, password validation and change, old-credential rejection, new login and session invalidation; actual browser/API checks. |
| I03 | Sign in | Production authentication, error/retry, revoked sessions, logout/back and credential handling; final baseline, password and access journeys. |
| B01 | Output producer | Complete-record normalization/redaction, no hidden reasoning/auth capture, bounded durable journal, stable replay and lifecycle isolation; Worker/contract tests plus both-provider native ingestion. |
| B02 | Read models | Scoped report/publication/artifact/discussion/search reads, bounded cursors and preserved source identity; focused Server/contract tests and real production HTTP consumers. |
| B03 | Boundaries | Repository grants, actor/lease/task/attempt/invocation bindings, artifact integrity, immutable seals and secret-free errors; automated, native and browser authorization/recovery evidence. |

## Verification results

Checks ran in the authorized Windows environment. No local product verification
was performed. Later candidates reused earlier results only for unchanged source
and built assets checked by hash. Targeted counts overlap and must not be summed
into a unique test total.

| Candidate | Executed checks | Result |
| --- | --- | --- |
| v4 | Shared, Server, Worker and Dashboard builds; relevant type checks and changed-source error-level lint | Passed |
| v4 | Full Dashboard suite | 157 files, 4,141 tests passed |
| v4 | Focused Contracts / Server / Worker suites | 3 files / 218 tests; 9 files / 158 tests; 7 files / 408 tests passed |
| v5 | Navigation/session regressions, UI lint/types/build | 4 files, 21 tests passed |
| v6 | Evidence/navigation regressions, UI lint/types/build | 5 files, 53 tests passed |
| v7 | Affected UI regressions, lint/types/build | 13 files, 100 tests passed |
| v8 | Affected UI regressions, lint/types/build | 3 files, 38 tests passed |
| v9 | Style-only corrections: lint/types/build, contrast and touch checks | Passed |
| v10 | Server rebuild and action protocol/legacy/concurrency regressions | 1 file, 60 tests passed |
| v10 | Dashboard types, affected regressions, production build and changed-source lint | 7 files, 66 tests passed |
| v10 | Full production browser baseline | 118 checks passed, 143 screenshots, no uncaught page/console errors |
| v10 | New action reconciliation and remaining action guards | 6 cases passed; earlier successful submissions were not redispatched |
| v10 | Comment history, import conflict recovery and output/history checks | 9 cases completed; see receipt attribution below |
| v10 | Worker policy, contact, CAS and cleanup | 7 cases passed |
| v10 | Previously malformed reconciled intent | Real HTTP reads passed strict schema validation; stored-record hash unchanged |

Additional executed browser receipts cover the 17 shell/workspace/static-Task
cases, media/playback/integrity and access restoration, password reset/change,
source creation CAS and unknown-key recovery, publication/webhook recovery,
repository settings, global scheduling, running cancellation/cleanup, search
failures and normal/hover/focus contrast. Successful business cases are attributed
individually where a later unrelated helper step failed.

The final baseline includes actual coarse-pointer geometry with 48-pixel targets
and stable light/dark contrast. Normal, hover and focus checks retained the 4.5:1
text threshold. Independent review opened 62 v9 captures across all eleven
destinations, then eight v10 captures for the final changes; root separately
inspected eight Task/output/evidence captures. No actionable visual issue remains
in the reviewed scope. Screenshots do not replace behavioral assertions.

## Closed findings

| ID | Correction and closing evidence |
| --- | --- |
| D-01 | Verified thumbnails, explicit video loading and compact file details replaced dense evidence cards; native media checks and final captures passed. |
| D-02 | One report media gallery and accurate execution-kind wording; composition regressions and actual report media checks passed. |
| D-03 | Explicit responsive source-row columns; actual geometry and visual rechecks passed. |
| D-04 | Compact truthful usage, aligned Task rows, distributed metadata, tonal statuses and corrected corner scaling; desktop/compact/dark checks passed. |
| D-05 | Grouped source/investigation/result strip with compact layout; responsive and touch checks passed. |
| D-06 | Scroll is saved before route changes can clamp it; the original bounded Back/Forward regression passed. |
| D-07 | PR creation no longer offers the Issue-only snapshot mode; lawful Issue modes and retained-request guards passed. |
| D-08 | Compact repository tabs expose Scheduling and named overflow controls; 320/390 and touch checks passed. |
| D-09 | Compact Reports filters use a labelled dialog and retained URL state; independent visual recheck passed. |
| D-10 | Readable known webhook reasons with exact diagnostics retained; neutral unknown fallback; actual recovery and visual checks passed. |
| D-11 | Narrow suggestion headings no longer fragment beside a long status badge; 320-pixel visual recheck passed. |
| D-12 | File-details disclosure meets 48-pixel coarse targets without overlapping Download; actual geometry passed. |
| D-13 | Opaque semantic containers correct selected warning-label contrast; normal/hover/focus and dark measurements passed. |
| D-14 | Touch minima survive MUI/sx styles across pages and overlays; actual coarse-pointer checks passed. |
| D-15 | Disclosures have unique summary/region associations; native DOM checks and the original Comments history journey passed. |
| D-16 | Removed the unsupported Latest first caption; stable-ID pagination remains; desktop/compact/dark Comments rechecks passed. |
| D-17 | Reconciliation persists only the three defined result fields. Precise legacy reads preserve history. Strict HTTP/schema, concurrency, no-redispatch and new real UI recovery checks passed. |

## Scope and evidence limits

- The application used its production bundle, actual Server, isolated stores and
  canonical domain operations. Upstream writes and model events were synthetic.
  No real model invocation or actual repository PR/Issue write occurred. Uploaded
  PNG/WebM files were real synthetic bytes, not proof of PowerToys functionality.
- Both CLI producer paths have normalization/journal/lifecycle tests and native
  HTTP ingestion evidence. No new paid CLI session was executed. Requested model
  and reported tokens remain distinct from resolved model or estimated live usage.
  Reasoning effort remains `Not recorded`.
- Actual account changes invalidate sessions. Media revocation therefore proves
  401 teardown, blob release, subsequent authenticated 403 denial, and restored
  access. A same-session media-card 403 via that operation is unreachable; its
  defensive component branch retains automated-test coverage.
- Changed sources do not revive an old intent, suggestion or sealed report.
  Import recovery/new source-bound Task creation are tested separately from stale
  action refusal. No fake React cache or report-seal rewrite was used.
- The historic reconciled terminal intent has no arbitrary reopen-by-ID UI after
  its private in-memory draft is gone. Compatibility was verified by actual HTTP
  reads of a complete database backup. A new intent verified the repaired UI.
- Two import cases returned HTTP `status` fields that overwrote their helper's
  scenario-status field with 409 and 201. Assertions completed successfully; the
  original receipt and a separate attribution record are retained. Imports were
  not repeated to rewrite history.
- Both native provider-ingestion sequences passed inside a harness run whose
  later login step failed. A separate run passed eight authorization checks.
  One earlier harness detailed receipt was overwritten by its successor; the
  original failure-stage log and isolated database remain. Its lost synthetic
  lease was not given a fabricated cleanup acknowledgment or reused as final proof.
- Selector corrections and genuine authentication rate limits remain recorded.
  Limits were not weakened; valid owned sessions and targeted continuations
  avoided unnecessary redispatch and duplicate mutation.

## Operational closeout

The final owned fixtures stopped cooperatively with exit code 0. Independent
readback found no owned listeners, active scheduled work, browser/helper processes
or live resource leases in the final runs: all 18 leases were released. Retained
legacy processes kept their original identities. Databases, failed attempts and
source archives remain available without modifying the original working tree or
the three design directories. Detailed operational memory stays outside the repository.
