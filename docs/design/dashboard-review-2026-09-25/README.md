# Interactive frontend UI / UX prototype

The [production implementation notes](IMPLEMENTATION.md) map this design to the
React Dashboard and document its retained behavior and verification boundaries.

Open **[optimized.html](optimized.html)** to use the optimized interface. The original
[index.html](index.html) remains an identical compatibility entry. The entry point shows
an interactive application with buttons, editable fields, filters, dialogs,
page navigation, and changing sample state. The earlier schematic atlas is kept
as a [supplementary review tool](atlas.html).

The optimized [visual overview](optimized-overview.png) shows the list, source
detail, report reader, and composition dialog after the review loop. A
[linked SVG version](optimized-overview.svg) opens the related prototype views.
These are authored UI schematics, not browser screenshots. Individual PNG and SVG
illustrations are available in `optimized-screens/`.

The standalone HTML embeds its CSS, JavaScript, icons, and example data. Open it
directly in a browser; no server, dependency installation, or application login
is required. The initial view is the Pull requests directory with an example
administrator session. Business operations affect sample state only. Reloading
resets the sample workspace; route information remains in the URL.

## Start reviewing

1. Click **Request changes** in a Pull request row to open its action dialog, or
   click the title to inspect the source detail.
2. Open its report, filter findings, select feedback, and edit private drafts.
3. Choose findings and open **Preview**. A short summary is generated automatically.
   Use **Edit feedback** only when you want to change the summary or finding text,
   then confirm the reviewed simulated result.
4. Use **Try a flow** for examples such as a P0 on page two, task recovery,
   Issue follow-up, comment recovery, or account access.
5. Open **Roles and states** to explore a read-only identity, preparation-only
   permissions, loading, empty results, refresh failure, conflict, unknown
   submission, unavailable access, and changed source.

The account button opens My account, appearance switching, copy-view, and sign-out.
Sign-in is a local sample flow. No real credential is needed or transmitted.

The [UI / UX review loop](UX-REVIEW.md) records the latest usability and copy
changes: concise list outcomes, clearer primary actions, recoverable filters,
consistent account identity, and less repetitive publishing instructions.

Select controls use the project's installed MUI components with the existing
Material 3 palette, outlined floating labels, and themed menus. Text fields share
the floating-label treatment. List rows show validation badges without repeating
the column label. The dependency bundle is embedded, so the prototype stays offline.

The subsequent Material 3 loop also adds MUI Checkbox, Radio, Switch, Tooltip,
and TouchRipple behavior. Setting switches, permission selections, navigation
tabs, filter chips, dialog surfaces, disabled states, and inverse snackbars share
the project theme. Roboto, Roboto Mono, and Material Rounded icons are embedded
locally. Existing action buttons and dialogs retain their DOM event contracts;
this is not a replacement of the production application.

Finding selection uses visible native checkboxes styled with Material 3 tokens,
retaining direct label, keyboard, and change-event behavior. Other MUI choice
adapters hide the original input only after the replacement is rendered and
restore it if rendering fails.

## Interactive coverage

| Area | Interactions |
| --- | --- |
| Workspace shell | Four navigation groups, group tabs, repository scope, search, copy view, account menu, light/dark appearance |
| Pull requests and Issues | Direct action dialogs, search and filters, pagination, source details, context-preserving back navigation |
| Tasks | Task details, attempts, output search, files, cancellation confirmation, cleanup states, resume budgets |
| Reports | Finding search, filters, pagination, cross-page selection, current-finding navigation, private feedback drafts, selected review |
| Publication | Select findings, generated summary, exact Preview, optional Edit feedback, independent confirmation, simulated receipt, P0 and permission guards, unknown-result recovery |
| Follow-up | Saved plan, exact source input, preparation, confirmation, linked synthetic queued task |
| Activity | Comment/publication details, attempts, webhook handling, recovery previews, explicit simulation of acknowledgement and result |
| Workspace settings | Repository Intake and Replies, dirty-state handling, conflicts, global scheduling, Worker E2E controls |
| Accounts | Account editing, explicit repository/action grants, password forms, sign-in/sign-out sample transitions |

This version adapts the repository's M3 / 06 interactive implementation to provide
the requested frontend review experience. Its design and main workflows informed
the V8 application at `91021df`. It is a behavioral design study, not a byte-for-byte
copy of the production frontend or a runtime acceptance result.

## Known simplifications

- The sample Accounts editor uses a full-page form; the current application uses
  a dialog. Other flows include working dialogs and unsaved-change confirmation.
- Create PR, duplicate Issue closure, and the complete independent feedback-draft
  list are not implemented as interactive sample operations. The supplementary
  atlas contains their source-derived descriptions.
- Sample report directories and queues use local fixtures, not the production
  server's cursor implementation.
- Linked follow-ups become queued sample tasks; no Worker executes them.
- Comments and webhook refreshes do not clear unknown acknowledgements. Explicit
  **Simulation controls** represent prototype-only acknowledgement and outcome input;
  they do not claim that the product exposes such an API.
- No real evidence media, backend authentication, GitHub write, service control,
  or production record is used. Preparation and confirmation change sample state.

The previous [review atlas](atlas.html) remains available for notes, source links,
40 schematic diagrams, eight journeys, and review JSON export. Its scope is
documented separately in [ATLAS.md](ATLAS.md). It records the earlier source
snapshot; the optimized prototype and visual overview include the newer two-step
publication design.

## Files and maintenance

- `prototype/`: editable HTML, CSS, JavaScript, and dependency notices.
- `prototype/material-controls.jsx`: MUI Select adapter that preserves the sample state events.
- `prototype/material-choice-controls.jsx`: MUI Checkbox, Radio, and setting-switch adapter.
- `prototype/material-action-effects.jsx`: MUI ripple and tooltip behavior on existing actions.
- `prototype/material-navigation.js`: tab semantics, keyboard navigation, and filter check indicators.
- `prototype/material-surfaces.css`: Material 3 component roles and interaction states.
- `prototype/material-assets.js`, `prototype/material-fonts.css`: embedded Material icons and Roboto fonts.
- `prototype/vendor/material-controls.bundle.js`: bundled React, MUI, and Emotion controls.
- `prototype/vendor/material-licenses/`: dependency license notices.
- `bundle-controls.mjs`: packages the control adapter using existing workspace dependencies.
- `generate-material-assets.mjs`: regenerates local Material icons, fonts, and their notices.
- `compose.py`: combines these files into the independent `index.html` artifact.
- `optimized.html`: the optimized interactive frontend prototype.
- `index.html`: the same prototype at the original entry address.
- `optimized-overview.png` and `optimized-overview.svg`: the optimized UI design board.
- `optimized-screens/`: four individual screen illustrations.
- `draw_optimized.py`: authors the SVG/PNG illustrations without running a browser.
- `atlas.html`: the supplementary schematic review notebook.
- `generate.py`: updates the atlas and its SVG diagrams without changing the UI prototype.

To regenerate the interactive document:

```powershell
python .\docs\design\dashboard-review-2026-09-25\compose.py
```

After changing a control adapter, run `bundle-controls.mjs` with Node first,
then run `compose.py`. Run `generate-material-assets.mjs` when the icon mapping or
font assets change. These scripts package the design artifact; they do not build
or verify the production application.

## Verification boundary

Two review/fix passes and an independent integration read covered the interaction
hooks, copy hierarchy, identity changes, publication guards, and state recovery.
The document assembler does not run the application.

The user authorized local browser inspection of this offline prototype for the
review task. The browser tool rejected its file URL under its Browser Use URL
policy before returning page state. That restriction was not bypassed. Browser
rendering and interaction verification therefore remain blocked. No successful
browser check, runtime probe, application build, or test-suite result is claimed.
Prior checks of the older prototype do not establish acceptance of this version.
