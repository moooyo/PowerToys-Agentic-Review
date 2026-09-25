# UI / UX review loop

Date: September 25, 2026.
Scope: the offline interactive prototype in this directory. Production Dashboard
source, services, accounts, and repository records are outside this change.

## Review criteria

- Make the next useful operation easy to find, with one primary action per area.
- Keep list rows scannable. Do not repeat an action as explanatory text.
- Retain state, target, blockers, field errors, and consequential confirmation.
- Move low-frequency provenance and protocol detail into named disclosures.
- Preserve selection, drafts, identity, and navigation context across interactions.
- Give loading, failure, empty results, and restricted access an appropriate exit.
- Keep long forms, focused controls, and action feedback reachable.

## Loop 1: inspection and changes

The starting reference showed `Next: Prepare request changes` beneath a conclusion
that already led to the same action. This pattern also appeared in detail headers,
task progress, publication instructions, and administrative pages.

| Area | Finding | Change |
| --- | --- | --- |
| Lists | Repeated next-action prose obscured the saved outcome. | Remove `Next:` subtitles and align column labels with status or outcome. |
| Source details | The recommendation appeared as a heading, paragraph, and button. | Use a concise outcome and one primary operation; disclose supporting rationale. |
| Tasks | Outcome, metadata, and progress repeatedly described the same task. | Separate execution from saved results and shorten status-specific guidance. |
| Reports | A collapsed directory could hide the current finding after advancing beyond item five. | Keep the collapsed finding window aligned with the current item. |
| Search | New linked tasks could not be found through workspace search. | Include retained follow-up task IDs and titles. |
| Notifications | Feedback occupied document flow and could be outside the visible area. | Use a dismissible snackbar, including inside an open dialog. |
| Dialogs | Long content could push actions away, and a reopened dialog could retain a previous scroll position. | Scroll the body independently and reset position on a new dialog view. |
| Activity | Some refresh failures had no in-context recovery; empty repository scope could not be cleared with filters. | Provide direct refresh recovery and an all-repositories exit. |
| Settings | Dependent reply controls could leave an invalid selection. | Update dependent state together and retain field validation. |
| Accounts | Newly created sample accounts could not complete the sample login flow. | Resolve the actual session account consistently across core and settings. |
| Publication | Small selection lists lacked bulk controls; some empty results had no useful reset. | Add selection controls and distinguish no findings from filtered-out findings. |
| Submission | Reopening a handled preview could leave an ineffective Confirm button. | Show its recorded receipt, preserving the original submission identity. |
| Follow-up | An already queued task could be prepared again, and its page repeated several absence warnings. | Link to the active task and use one concise queued state. |
| Simulation | Prototype-only acknowledgement and cleanup controls appeared among ordinary operations. | Group them under explicit Simulation controls. |

## Loop 2: boundary and integration review

The second pass checks the modified flows against their retained invariants:

- An unresolved P0 still blocks approval across filtering, selection, preview,
  and final confirmation.
- Unknown submissions keep their original identity. Refresh is not a replacement
  submission, and simulated acknowledgement is explicitly a prototype control.
- Saved feedback and publishing text remain independent; importing or replacing
  content stays explicit.
- Account changes adopt the actual current identity and grants. Invalid or
  disabled custom accounts must not fall back to an administrator preset.
- Password changes and disabled accounts end the sample session; ordinary access
  changes retain the same identity while clearing its previous private drafts.
- A linked queued task does not claim Worker execution or completed validation.

Independent source review is used to inspect cross-module changes before the
final document is assembled. Any unresolved browser-dependent behavior remains
outside the accepted evidence below.

## Loop 3: independent integration read and final corrections

The independent read found and corrected additional integration issues:

- Reserve a notification row inside dialogs so status messages do not cover
  confirmation buttons. Outside dialogs, notifications remain floating and
  pause auto-dismiss while hovered or focused.
- Make the changed-source notice point to an actual recovery operation, preserving
  saved report snapshots rather than rewriting them.
- Normalize imported source numbers and new usernames before duplicate checks.
- Update the account avatar from the actual signed-in identity.
- Share the saved source SHA between both follow-up entry points.
- Expose the follow-up task kind and saved-plan summary before confirmation.
- Label an unresolved close/CI check as still unconfirmed; do not invent a
  successful audit result or an unsupported manual-unlock operation.

The static review ended with no additional confirmed blocking defect in the
reviewed paths. This is a source-review stopping point, not a browser acceptance
claim. The runtime-dependent checks below remain open.

## Verification evidence and limits

### Follow-up: missing finding checkboxes

The user reported that the finding selection dialog showed no checkboxes. Source
inspection identified an unsafe enhancement order: original inputs were hidden
before their MUI replacements rendered, with no recovery for an empty or failed
replacement. The specific runtime rendering failure was not observed.

Publication and report finding selections now retain visible native inputs with
stable IDs, explicit labels, Material 3 styling, and keyboard focus. The existing
selection, Select all, Clear, generated summary, and Preview handlers are retained.
Other choice adapters delay hiding the original input until the replacement is
present and restore the original input and labels when rendering fails. Switches
check their thumb and track rather than assuming every MUI choice contains SVG.

An independent source review covered the fallback and event paths. Browser
interaction remains unverified under the restriction described below.

### Follow-up: direct actions and automatic summaries

The PR/Issue directory now separates source navigation from the next operation.
Request changes and other supported operations open their dialogs directly from
the row, preserving the list behind the dialog. Read-only progress/evidence links
retain the original list filter, page, scroll position, and opener.

Feedback publication now uses Select findings -> Preview -> Confirm. The former
mandatory Compose step is an optional Edit feedback branch. The prototype derives
a concise summary from the selected findings and recorded validation state. It
updates generated text when the selection changes, preserves explicit custom
edits, and offers Use generated summary to restore automatic text.

Example for two selected cancellation findings:

> Requesting changes for 2 findings affecting cancellation and configuration
> persistence. Runtime validation is still pending.

Preview and Confirm use the same frozen payload. Invalid anchors, overlapping
suggestions, empty finding text, changed feedback, or size errors open the optional
editor and focus the relevant field. P0, permissions, source identity, and unknown
submission rules remain in force. No live submission was made.

Static integration review covered direct actions on non-first sources, dialog
closure, saved drafts, cross-source preview identity, and list-return navigation.
Runtime verification remains subject to the limitation below.

### Continued Material 3 loop

The component-level follow-up used the repository's `MaterialTheme` as the visual
reference, then performed a second independent static integration review.

| Mismatch | Correction |
| --- | --- |
| Browser-native checkbox and setting controls | MUI Checkbox/Radio for choices and acknowledgements; MUI Switch for repository boolean settings. |
| Text labels always floated, including empty untouched fields | Resting and floating labels now respond to content, placeholders, focus, disabled, and readonly state. |
| Password visibility used an external text button | Place a Material visibility icon inside the outlined field and preserve the selection when toggling. |
| Selected chips, navigation, and findings lost their fill on hover | Keep their selected container and apply the hover/pressed state layer. |
| Tabs lacked keyboard behavior and matching content semantics | Add tablist/tab/tabpanel associations, roving focus, and Left/Right/Home/End navigation. |
| Icon tooltip metadata had no renderer | Add MUI Tooltip anchored to the existing action, plus MUI TouchRipple feedback. |
| Font declarations fell back to system fonts offline | Embed Roboto 400/500/700 and Roboto Mono 400 from the installed project assets. |
| Icons used a separate line-icon family | Replace placeholders with the installed MUI Rounded SVG geometry. |
| Snackbar, stepper, loading, and disabled surfaces were inconsistent | Apply inverse snackbar colors, circle/connector steps, theme opacity roles, and reduced-motion-aware loading. |

Integration review found additional issues that were corrected before assembly:

- Resetting filter values now synchronizes the visible MUI Select controls.
- Choice controls dispatch one model change; confirmation-only edits still mark
  the dialog dirty and preserve the existing unsaved-change guard.
- Error summaries ignore stale presentation proxies while updating the original
  field state. Re-rendered forms restore focus through the original model ID.
- Wrapping tab content preserves the parent stack's spacing.
- Menu Escape handling retains the underlying dialog, and tooltip/popover
  containers stay within an open native dialog when required.

The loop used static source review and document-asset generation. It does not
establish runtime behavior, performance, pixel equivalence, or accessibility
acceptance. The existing browser-tool restriction still applies.

### Follow-up: repeated labels and Material 3 controls

The next visual review identified two omissions: per-row Validation/Reproduction
captions and native-looking select controls. The captions were removed while
retaining status badges and accessible context. Select surfaces and menus now use
the workspace's actual MUI components, with the current Material 3 theme tokens;
text fields use matching outlined floating labels.

The adapter retains native model IDs, values, and change events, and synchronizes
disabled/error state and focus. Its menus are contained by the current dialog.
An independent static read found an Escape propagation issue; the menu close
handler now prevents the native dialog's default dismissal. No browser result is
claimed for these changes.

The user explicitly authorized local browser inspection of this offline prototype
for this task. The browser tool rejected the `file://` URL under its Browser Use
URL policy before returning a page state. That restriction was not bypassed.

Consequently, the current evidence is source inspection and static re-review,
not browser acceptance. No successful runtime interaction, rendered-layout,
screen-reader, export, or cross-browser result is claimed. The document assembler
only combines source files; successful assembly is not a JavaScript or UI test.

The remaining browser pass should cover:

1. PR and Issue filtering, queue return, and narrow-layout navigation.
2. Report finding five to six, cross-page P0, selection, and draft continuation.
3. Compose edits, field errors, exact preview, confirmation, and unknown recovery.
4. New account login, sign-out, self-grant changes, disabled accounts, and resets.
5. Settings conflicts, unsaved navigation, dependent reply controls, and refresh.
6. Long-dialog scrolling, snackbar focus, and light/dark layouts at narrow widths.

No real PR, Issue, credential, account, or service was changed by this review.
