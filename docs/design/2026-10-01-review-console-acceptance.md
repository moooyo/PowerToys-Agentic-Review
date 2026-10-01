# Review Console design acceptance

The Dashboard was reimplemented from the `design_handoff_review_console` handoff
using the existing React, Material UI, TanStack Query, and authenticated native
API layers. The handoff HTML and its simulated runtime remain reference material;
production does not import their mock records or runtime.

## Implemented view and interaction scope

- The 88px navigation rail exposes Inbox and Settings. The 72px header contains
  the repository, search, language, theme, and account controls.
- The Inbox uses a 400px maximum list column, a 16px gap, independent panel
  scrolling, and a selected Review detail with Trigger, Review, Report, and Publish.
- Report, Session, and Comment tabs use real saved findings, normalized output,
  and confirmed delivery bodies. Running records show observed elapsed time and
  their latest readable output instead of invented percentage progress.
- Settings contains Event intake, Automatic replies, Prompt, Execution, Workers,
  Accounts, and My account. Intake and reply drafts remain mounted across section
  switches, with validation, version conflicts, save/discard, and navigation guards.
- Login, menus, dialogs, recovery feedback, light/dark appearance, and Chinese/
  English controls follow the handoff's tokens, dimensions, and font families.

## Verification

The user explicitly authorized local Dashboard compilation and acceptance for
this task. Checks used Node 24.20.0 and pnpm 11.24.0.

| Check | Result |
| --- | --- |
| Contracts build | Passed |
| Dashboard TypeScript check | Passed |
| Dashboard production Vite build | Passed |
| Dashboard tests | 176 files and 4,416 tests passed |
| Changed-file Biome check | Passed with no errors or warnings |
| Workspace Biome check | Passed; pre-existing warnings and informational diagnostics remain |
| Browser acceptance matrix | 10 scenarios and 80 executed assertions passed |
| Visual evidence | 71 implementation screenshots and 37 handoff reference screenshots |

Browser acceptance served frozen production assets with an isolated, synthetic
same-origin HTTP API. It covered 1440x900 and 1100x900 desktop viewports, both
languages and themes, all seven Settings sections, the detail tabs, search,
dismissal/undo, keyboard tab navigation, login, account controls, stop/continue,
and supported republishing. Additional fixtures verified related activity,
unconfirmed publication, native final conclusions carried by progress comments,
historical report-specific delivery proof, and unavailable exact links.

The matrix recorded no page errors, unmatched API requests, unauthorized external
requests, or unexpected HTTP errors. The expected rejected login returned 401.
All five mutation requests affected only in-memory fixtures. Browser contexts,
Edge, and the temporary HTTP service were closed afterward. These assertions
establish the Dashboard's behavior against its HTTP contracts and isolated data;
they do not certify a live GitHub write or a deployed Worker run.

The matrix's frozen JavaScript was `index-DeC-arTK.js` (SHA-256
`b4e625e024ddd43bc82b7a80967e3ec9d04c67480bfebfa5a6d8b09153c2159e`) and its CSS
was `index-BMOzFbtV.css` (SHA-256
`2462279a8bc1b0605be2bbca15811d97ec73628757c0fd722a71e360ad1ad2ad`). A final
CSS-only account disclosure adjustment removed a duplicate disclosure arrow and
inherited padding. Its separate modal acceptance passed one scenario and 18
assertions, with four screenshots at 1440x900 light and 1100x900 dark. It checked
one disclosure arrow, zero inherited padding, expansion/collapse, visible footer
actions, and no horizontal overflow. All temporary resources were closed.

The final delta used `index-Bj1HvL8-.js` (SHA-256
`8eccaf650d181cfb046ab52145bb8ee0ed036d4c101a4da45147825f74c082f6`) and
`index-BRRBDdzX.css` (SHA-256
`3e51d46e95d573bc201a210b55b4f438e7fc8b0cb8d3f32f7ece2e7ff34ef03a`). The full
matrix and delta receipts retain their distinct asset hashes and scopes; the 80
matrix assertions were not repeated after this final CSS-only adjustment.

## Corrections made during acceptance

Implementation defects were corrected before integration: the live Inbox output
row, narrow desktop failure-action wrapping, Settings navigation spacing, account
heading alignment, visible modal actions, business permission summaries, exact
priority colors, and Bug/Feature conclusion colors and icons.

Source review also corrected functional wiring defects: publication directory
pagination, native shared-comment final-report binding, historical publication
proof after re-requests, related activity monitoring, member intake recovery
permissions, asynchronous cancellation, saved-progress wording, precise resource
response binding, stale publication error banners, and exact-link selection.

Visual comparison used the same desktop viewports and explicit token/geometry
checks. Real API records have different titles, findings, metadata, and outcomes
from the handoff's sample records, so a whole-screen pixel difference is not a
meaningful fidelity score. The retained screenshots allow the layout, component
states, spacing, typography, and colors to be reviewed directly.

## Product decisions left for evaluation

Missing native capabilities and necessary design extensions are documented in
[Review Console capability gaps](2026-10-01-review-console-capability-gaps.md).
They include Prompt catalogue/version control, optional source and identity
metadata, persistent dismissal, legacy result recovery, exhausted-budget recovery,
original snippets/exit codes, and fresh GitHub comment readback. The extra
unconfirmed-publication group and related activity selector represent supported
real states that the prototype did not draw.
