# Current frontend UI / UX review prototype

Open [the supplementary review atlas](atlas.html) in a browser. It is an offline,
click-through prototype of the frontend at commit `91021df` on September 25, 2026.
The artifact includes 40 screen/state diagrams, eight guided journeys, and 120
screen-specific review questions. No dependency installation or application server
is needed.

[Open the flow map](overview.svg) or use the [complete diagram catalog](CATALOG.md).

## Review workflow

1. Start with **Flow map**, or open **Journeys** for an ordered walkthrough.
2. Open a screen by clicking a map card, linked diagram control, or index entry.
3. Use **Where this interaction goes** to inspect conditions and alternative states.
4. Compare the diagram with its source references and review questions.
5. Mark **Reviewed** or **Needs discussion**, then write a note.
6. Use **Export review** to save a JSON record containing every screen's status
   and notes. **Print view** prints the current screen or journey.

Each screen and journey has a stable hash link. Individual SVG files can be
downloaded and shared. SVG links return to the matching screen in `atlas.html`;
retain the folder structure when sharing the full artifact. Source links are
relative to the repository and require the repository checkout to remain present.

## Coverage

| Area | Included views |
| --- | --- |
| Review | Pull requests, Issues, source detail, bug and feature assessments, Reports, finding reader |
| Investigation | Tasks, task workspace, interrupted recovery, saved follow-up preparation |
| Publication | Selection, composition, exact preview, receipt, unresolved P0, unknown outcome, Create PR, duplicate closure |
| Activity | Comments and retained publication, Webhook events and handling details |
| Workspace | Repositories, Intake, Replies, global scheduling, Workers, Accounts and editor dialog, My account |
| Shared states | Sign-in, session expiry, unsaved edits, settings conflict, first loading, empty results, first error, refresh failure, access denied |

The ten current route-mounted workspace pages are included. Historical unmounted
pages are excluded. The prototype uses the current Material 3 blue, surfaces,
navigation groups, and typography fallbacks. Screen structures intentionally
group controls and explanatory content to support review.

The eight journeys cover feedback publication, P0 blocking, task recovery, Issue
follow-up, unknown action recovery, authentication, repository settings, and
event-to-publication traceability. Journey branches identify both their source
and destination. Directory cards in the Operate map lane are peers, not a
sequential business process.

## Interpretation and limits

These are source-derived wireframes with illustrative content, not screenshots,
pixel-accurate reproductions, running forms, or evidence of application acceptance.
Every linked control navigates to a diagram. Search, review notes, status changes,
printing, and JSON export operate on the documentation only. Schematic input
fields and unlinked tabs are explanatory; they do not simulate application state.

The prototype preserves these distinctions:

- Task completion, saved assessment, validation, and resource cleanup are separate.
- Report selection, private feedback drafts, and publishing selection are separate.
- Prepare and Execute permissions are independent. Confirmation binds the exact
  target, source revision, intent version, and payload.
- An unresolved current-source P0 cannot be bypassed by changing visible filters
  or checkboxes. Merge uses its own guards.
- Unknown action outcomes retain the original submission identity. Comments and
  webhook object refreshes do not magically reconcile unknown acknowledgements.
- Follow-up planning does not establish execution readiness. Creating a PR needs
  verified remote-branch evidence; it does not implicitly commit or push code.
- Repository intake and replies are scoped settings; scheduling is workspace-wide.
- Account administration does not automatically grant repository or action access.

Conditional states in a diagram are explanatory alternatives, not a claim that
all warnings and controls are simultaneously visible in the actual application.
The artifact records review prompts, not a list of confirmed product defects.

## Review data

Notes are stored by source snapshot and screen in browser `localStorage` when it
is available. Separate screen keys prevent one window from overwriting another
screen's notes. If two windows edit the same screen, the latest save wins.
Export includes the newest available saved entries as well as in-memory notes.

File-origin storage behavior depends on the browser. Moving the folder, clearing
browser data, or switching profiles can make notes unavailable. If storage is
unavailable, an explicit banner states that notes remain only in the open page.
Export before closing or sharing. The JSON export is a review record; this version
does not import or merge review files.

## Verification status

Source inventory and static code review were performed. Static review corrected
journey advancement through repeated screens, non-integer step links, active tabs,
keyboard-focus CSS scope, and independent storage for each screen's notes.

Browser rendering and interaction verification are **blocked** because the
designated remote Windows environment was stopped. No local browser verification,
application runtime probe, test suite, or application build was run. The document
generator was used only to create the HTML and SVG artifacts. Generated output
is not a passing browser check. Visual clipping, browser-specific SVG behavior,
keyboard interaction, persistence, export, and print still need remote inspection.

No production service, account, configuration, real PR, or Issue was changed.

## Files

- `core.json`, `support.json`, `states.json`: authored screen and journey inventory.
- `viewer.html`: offline viewer template and review controls.
- `generate.py`: standard-library document publisher.
- `atlas.html`: generated supplementary viewer with all diagrams and data embedded.
- `overview.svg`, `screens/*.svg`, `flows/*.svg`: standalone vector diagrams.
- `CATALOG.md`, `manifest.json`: generated index and source/evidence metadata.

After editing the inventory or viewer, regenerate the documentation with:

```powershell
python .\docs\design\dashboard-review-2026-09-25\generate.py
```

Use the project-designated verification environment for subsequent browser checks.
Keep this review prototype separate from product changes and deployment acceptance.
