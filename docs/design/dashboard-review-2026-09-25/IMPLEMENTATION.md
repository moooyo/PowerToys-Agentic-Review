# Dashboard design alignment

The production React Dashboard now follows the optimized interactive prototype.
It uses the existing API, permissions, report identities, and action-intent
lifecycle. Prototype fixtures, DOM control adapters, and simulation controls are
not part of the application implementation.

## Implemented areas

| Area | Behavior |
| --- | --- |
| PR and Issue directories | Separate source links from direct operation buttons; one Action / Validation hierarchy; recoverable filters and source refresh; retained queue navigation. |
| Publication | Select findings -> Preview -> Confirm, with optional Edit feedback; automatic summaries derived from selected report content and recorded validation; saved custom summaries and one-click regeneration. |
| Findings | Real MUI checkboxes and labels; current finding stays in the compact directory; filtering preserves available selection and drafts; discarding text preserves selected findings. |
| Tasks | Report links preserve the originating task queue; execution and recorded results remain separate; source provenance is disclosed on demand. |
| Activity | Original text, delivery history, request identity, and webhook metadata are collapsible; refresh failures and empty repository views have recovery actions. |
| Settings and accounts | Concise primary actions, expandable authorization and policy details, preserved dependent settings and consequential confirmations. |
| Shared Material UI | Material 3 choice controls and state layers, Rounded icons, mobile page Select, navigation ripple, inverse snackbar, and contained dialog scrolling. |

## Preserved boundaries

- Preview and confirmation use the same server-prepared payload. Editing requires
  preparation of a new preview.
- P0, actor permissions, source revision, report binding, and unknown-result
  checks remain active.
- Generated summaries describe selected feedback and recorded checks. They do not
  invent a successful runtime verification or apply proposed code changes.
- Worker conflict and unknown-save review requirements remain in the private
  session cache across route changes.
- Frontend verification uses synthetic state and mocked transports. No real
  pull request, issue, account, service, or Worker execution is changed by it.

## Verification

The user authorized local verification of this frontend change using synthetic
state and mocked transports. Checks used Node 24.20.0 and pnpm 11.24.0:

- Investigation unit and component tests: 769 passed across 57 test files.
- Dashboard TypeScript check: passed.
- Dashboard production build: passed. Vite reports a JavaScript chunk-size
  advisory; no bundle splitting is included in this design alignment.
- Biome on the 60 changed application and test files: formatting and error-level
  checks passed. Warning-level diagnostics remain.
- Git whitespace check: passed.

The test coverage includes generated/custom summaries, frozen prepared feedback,
finding selection and draft recovery, source-bound action links, and retained
unknown or conflicting operations. Browser interaction and pixel comparison have
not been performed for the production application.
