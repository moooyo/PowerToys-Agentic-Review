# Material UI Dashboard rewrite

The framework migration recorded here is retained. The user rejected its initial visual
direction; see the [Material Design reset](2026-09-10-material-design-reset.md) for the current
layout, type scale, color roles, and component presentation.

## Intent

Replace Ant Design, Pro Components, their icons, and the Ant Design-coupled Umi Max shell with
Material UI 9, Vite, and React Router. Preserve current routes, HTTP/sample boundaries, operator
identity epochs, permission checks, repository scope, confirmations, mutations, pagination,
evidence handling, and immutable result semantics. This is a UI rewrite, not a backend redesign.
Do not introduce an Ant Design compatibility facade or weaken checks to simplify conversion.

## Design direction

This is a developer review workbench: its primary job is to scan queued/completed work and inspect
the source, findings, evidence, and required next action. Use Material surfaces and controls with
compact, deliberate information density rather than a marketing dashboard or decorative metrics.

- Ink `#18243C`: navigation rail and strongest text.
- Primary `#3865D6`: selected navigation, focus, and primary actions.
- Canvas `#F4F6FB`: workspace background.
- Surface `#FFFFFF`: review content, forms, dialogs.
- Slate `#63718A`: secondary labels and metadata.
- Teal `#188279`: successful state; warning/error remain semantic Material colors.
- Type: Manrope for restrained page/section headings, Inter for controls/body, Roboto Mono for IDs.
- Geometry: 232px desktop navigation, 64px toolbar, 24px content gutters, 8px spacing scale;
  12px surface corners and quieter borders; responsive navigation drawer on narrow screens.

The signature is a focused review inbox: compact selectable work-item rows and an adjacent
context inspector on wide screens. The inspector shows actual selected-item data, not invented
aggregates. Keep full report/run/evidence workflows accessible. Mobile uses a single column and
the existing detail flow. Avoid large blank header cards, distant text-only action columns,
decorative charts, unrelated illustrations, and counts inferred from a partial page.

This differs from a generic admin template through review-specific hierarchy and the inbox /
inspector interaction. Keep the surrounding pages quiet and consistent; do not repeat a hero,
statistics cards, or a different visual system on each route.

## Shared implementation contracts

- Use native `@mui/material` components and `@mui/icons-material`; do not retain Ant imports.
- Router imports come from `react-router-dom`.
- Session consumers use `useOperatorSession()` from `@/state/session`. It returns
  `{ initialState, setInitialState, loading, refresh }`. `initialState` preserves the existing
  `authenticated`, identity/access, `sessionEpoch`, `authenticationEpoch`, `apiConnected`,
  `accessResolvedAt`, and `currentUser` fields. Tests mock this hook rather than Umi's `useModel`.
- `@/components/ui` supplies domain-neutral Material helpers: `DataTable`, `DetailsGrid`,
  `EmptyState`, `ConfirmDialog`, and `notify(message, severity?)`. Severity is
  `success | error | warning | info` (default `success`). Use native MUI directly when clearer.
- `DataTable<T>` takes `rows`, `columns`, `getRowId`, optional `loading`, `emptyTitle`,
  `emptyDescription`, `onRowClick`, and `ariaLabel`. `DataColumn<T>` has `id`, `label`,
  `render(row, index)`, optional `align`, `width`, and `minWidth`. Optional `pagination` is
  `{ page, pageSize, total, pageSizeOptions?, onChange(page, pageSize) }`, with **one-based** pages
  at this boundary. Rows are already paged; the helper never slices them. Page-size options
  default to an empty list, so each caller explicitly enables its supported choices.
- `DetailsGrid` takes `items: { label, value, key? }[]` and optional `columns: 1 | 2 | 3`.
- `EmptyState` takes `title`, optional `description`, `action`, and `icon`.
- `ConfirmDialog` takes `open`, `title`, `children`, `onClose`, `onConfirm`, optional
  `confirmLabel`, `cancelLabel`, `destructive`, `loading`, and `disabled`.
- `PageHeader` keeps its current public props: `eyebrow`, `title`, optional `titleId`,
  `description`, and optional `actions`. Its visual implementation changes to Material.
- Existing `StatusTag`, `RepositoryScope`, and permission hooks retain their public domain APIs.
- Modal portals mount inside `#dashboard-session`, beside the application shell. This lets MUI
  hide background content from assistive technology while authentication refreshes still hide
  the entire session, including open overlays. Evaluation drawers and evidence previews also
  close or clear synchronously when their repository read scope becomes unavailable.
- Forms may use React Hook Form or explicit typed draft state with native MUI inputs. Preserve
  existing payload-building helpers and validation behavior. Do not silently omit form fields.
- Prefer MUI's current slot APIs (`slotProps`) over removed legacy component props. Avoid MUI X
  paid components; native Material tables and existing virtualization are sufficient.

## Verification and delivery

Run type checking, existing relevant tests, a production build, and lint over changed source.
Update UI-specific tests for Material markup while preserving behavioral coverage. Verify the
preview in the browser at desktop and narrow widths, inspect core routes and detail/form flows,
and retain the preview at port 8000. Development must clearly show sample mode and must never
send GitHub mutations. Do not launch a Worker, real models, or a live publication acceptance.
No external repository writes are authorized for this UI work. Preserve previous acceptance
artifacts and never inspect `apps/worker/.tmp-ui-driver-V7AOfu/`, including metadata.

## Completion record — 2026-09-10

The rewrite is implemented on `codex/mui-dashboard-rewrite`, based on `db15c1b`.
All routed pages and their forms, tables, reports, and overlays use native Material UI.
Ant Design, Pro Components, their icon packages, and Umi Max have been removed from the
dashboard dependencies and lockfile. The unused legacy work-item page and old shell styles
have been removed; `/work-items` still redirects to the pull-request workspace.
Repository links, query scope, session epochs, permissions, and sample/HTTP adapter selection
retain their behavior. The selected repository's GitHub shortcut is available in the toolbar.

Verification ran over SSH on `test-env`, in
`/tmp/agentic-mui-dashboard-20260910-q8bVHp`. Local copies of its logs and screenshots are in
`artifacts/mui-dashboard-20260910`:

- Dashboard TypeScript checking and the production build passed (`*-final-v2.log`).
- All 116 test files and 3,600 tests passed (`tests-final-v1.log`). After the final evaluation
  drawer visibility change, its result/evidence suites passed again: 22 tests in two files
  (`tests-final-v2.log`).
- Biome completed without errors (`lint-final-v2.log`). It reports 68 existing warnings in
  unchanged helper/test files and three fragment simplification suggestions in evaluation UI.
- Independent Chromium checks opened all 11 primary routes, then exercised inbox selection,
  result/validation/execution tabs, review-run configuration, prompt and repository editors,
  profile field validation, repository scope across navigation, light/dark themes, and mobile
  navigation. Browser logs contain no runtime or console errors (`browser-v2` through
  `browser-v4`). Modal background content is excluded from the accessibility tree.
- Browser requests were restricted to GETs against the isolated local preview server.
  No Worker, model, GitHub mutation, or production backend operation was run.

The connected-only evaluation and personal notification interfaces retain their explicit
unavailable state in sample mode. Their connected behavior is covered by existing mocked
contract/component tests; this UI rewrite does not claim a new live backend acceptance.

The Windows preview remains at `http://127.0.0.1:8000/pull-requests`. Its process ID and startup
logs are retained in `artifacts/mui-dashboard-preview-20260910-final`. In-app browser automation
was unavailable because its app auth token was unavailable, so visual checks used the isolated
remote browser with a development bundle from the same source. Initial remote memory failures
and their logs were retained; resource limits and a static preview avoided repeated OOMs.
