# Material Design reset

## Brief

The user rejected the first MUI rewrite. Its custom dark sidebar, compressed type, split inbox,
and repeated bordered panels do not satisfy the requested Material Design appearance. Keep the
native MUI implementation and application behavior, but replace the visual composition throughout.
This document supersedes the visual direction in the earlier MUI migration design.

## Direction

Use Material 3 baseline components and roles. This is a repository review application for operators;
the primary page's job is to find a pull request or issue and open its review. Familiar Material
interaction and legibility take precedence over a bespoke visual identity.

- Primary: `#6750A4`; on-primary: white; primary container: `#EADDFF`.
- Surface: `#FFFBFE`; canvas/container-low: `#F7F2FA`; container: `#F3EDF7`.
- Secondary container / navigation selection: `#E8DEF8`; on-secondary-container: `#1D192B`.
- On-surface: `#1D1B20`; on-surface-variant: `#49454F`.
- Outline: `#79747E`; outline-variant: `#CAC4D0`; error: `#B3261E`.
- Typography: Roboto throughout headings and controls, Roboto Mono for code. Headline 32/40,
  title 22/28 and 16/24, body 16/24 and 14/20, labels 14/20 and 12/16. Regular 400 and medium
  500 weights; remove the heavy Manrope headings, all-caps eyebrows, and tiny 11px interface text.
- Shape: 40px pill buttons, circular icon buttons, 32px filter/status chips with 8px corners,
  12px cards, 28px dialogs. Outlined/filled text fields retain native Material geometry.
- Layout: full-width 64px top app bar; 280px standard navigation drawer on desktop; modal drawer
  at compact widths. App bar and navigation share light tonal surfaces. Page gutters 24px/16px.

The review list is the signature. Use a single readable Material list with leading workflow icons,
clear title/supporting-text hierarchy, trailing progress and activity, and an accessible action
to open the full detail surface. Remove the automatically selected inspector and duplicate
Details links from every row. Search and filtering belong to one purposeful toolbar.

```text
App bar: menu / Agentic Review                  Repository / theme / notifications / account
Navigation drawer       Pull requests                                  Refresh
                        Scope and brief supporting text
                        [ Search pull requests                    ] [ Progress filter ]
                        6 pull requests
                        (icon) Title                           Status     Time    >
                               Repository #number · author · revision
                        (icon) Title                           Status     Time    >
                               Repository #number · author · revision
                        Pagination
```

Other pages use the same hierarchy, standard Material tables, text fields, tabs, tonal banners,
and contained/outlined/text button roles. Remove local micro-fonts, gratuitous nested panels,
custom heavy headings, and duplicated padding. Keep all configured fields and advanced details.
Do not invent counts, dashboards, progress values, or decorative charts.

## Implementation boundaries

Preserve session and repository access guards, overlay containment in `#dashboard-session`,
permission-refresh hiding, mutation locks, exact request identities, API payloads, pagination,
immutable version flows, result/evidence distinctions, routes, and sample/HTTP separation.
No new backend, Worker, model, or GitHub operations are part of this redesign.

Root owns shell, theme, shared helpers, fonts, dependencies, and final integration. Feature agents
own their assigned presentation files and relevant tests only. Avoid API-compatibility wrappers,
new architectural abstractions, broad regex rewrites of business logic, or additional subagents.

Run all checks over `ssh test-env`. Use a fresh artifact directory and preserve earlier logs.
Inspect rendered desktop and mobile pages before delivery. The local requested preview may run
on `127.0.0.1:8000`, but do not run local test/build/probe suites. Never inspect
`apps/worker/.tmp-ui-driver-V7AOfu/`, including metadata, and never read credentials.

References: [Material color roles](https://m3.material.io/styles/color/roles),
[navigation drawer](https://m3.material.io/components/navigation-drawer/overview),
[Material UI typography](https://mui.com/material-ui/customization/typography/).

## Delivery and verification

The reset replaces the previous shell with a full-width Material app bar, a light standard
navigation drawer, an account menu, and a responsive repository context bar. Roboto replaces
Inter and Manrope. The theme maps Material baseline light/dark roles into native MUI controls,
with consistent labels, focus states, tonal selection, dialog shape, and touch targets.

Pull requests and issues now use one native Material list. Search uses a filled rounded search
bar; rows and trailing chevrons open the detail drawer. History remains directly accessible.
Request context moved into the detail expansion panel. All configuration, operations, report,
and evidence surfaces use the same type scale and component sizing. Repeated wrappers and
micro-font overrides were removed. API contracts and authorization behavior remain intact.

Verification evidence is in `artifacts/material-reset-20260910`. All executable checks ran on
`ssh test-env`, using the isolated workspace beneath
`/tmp/agentic-mui-dashboard-20260910-q8bVHp` and new `material-reset` logs:

- `typecheck-final.log`: TypeScript passed.
- `tests-final.log`: all 116 files and 3,603 tests passed, including the preserved inbox/detail
  permission checks and three new list interaction cases.
- `build-final.log`: production build passed.
- `lint-final.log`: no errors; 68 existing helper/test warnings and eight style suggestions.
- `browser-v1`: all 11 primary routes rendered without runtime errors.
- `browser-v2`: 19 captured interaction states, including search, result tabs, request context,
  run configuration, repository filters/settings, prompt editing, profile validation, account
  menu, dark mode, and mobile navigation. No console/runtime errors or horizontal overflow.
  Modal backgrounds were verified absent from the accessibility tree.

Browser requests were restricted to GETs against the isolated static development preview.
No GitHub, Worker, model, or live backend mutations were performed. Connected-only evaluation
and notification screens retain their sample-mode unavailable state; component/contract tests
cover their connected behavior. The in-app browser automation token was unavailable, so rendered
checks used remote Chromium with the same source. A transient SSH-agent signing failure resolved
on retry; local verification was not used as a fallback.

The final source snapshot is `snapshot-v2.tar`, SHA-256
`7f6601ab670945688dc44d14b27bacd2e65f4effcd181548da027e0977eb7aa0`.
The Windows preview is running at `http://127.0.0.1:8000/pull-requests`; its startup logs and PID
are in `artifacts/material-reset-preview-20260910`. The implementation was developed on
`codex/mui-dashboard-rewrite`; the verification above covers its final source snapshot.
