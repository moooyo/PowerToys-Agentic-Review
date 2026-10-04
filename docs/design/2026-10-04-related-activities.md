# Related activity presentation, 2026-10-04

The user approved keeping all related activity states visible, using an activity
list by default and a timeline for inspecting history. This resolves item 16 of
the [Review Console capability decisions](2026-10-01-review-console-capability-gaps.md).

## Navigation and grouping

The Inbox shows one native task record per PR or Issue source, including repeated
root Reviews and standalone root E2E work. Related reproduction, repair,
implementation, and verification tasks remain within that family rather than
becoming duplicate Inbox records. Failed intake events without a task retain
their separate event-recovery records; they are not presented as execution tasks.

When a family contains multiple activities, details display each activity as a
selectable row with its own execution state. The default list exposes completed,
failed, queued, and running work together. Selection has a separate visual style
from execution status, so selecting a failed activity does not change its state.

Choosing a row reads that activity's exact report, session, and recovery controls.
The existing identity, authorization, cleanup, and publication checks continue
to apply. Navigation is disabled while an operation is pending. Exact activity
links continue to open their recorded task within its original family.

The timeline sorts by recorded creation time without arrows or numbered steps.
It represents observed chronology rather than a requirement to execute tasks in
that order. Missing or invalid time remains explicit; a recorded update time is
labeled as an update rather than invented creation time.

Switching the list and timeline preserves the selected activity and content tab.
Separate tasks of the same kind remain separate rows. Historical failures remain
readable even when newer work of that kind completes. Existing family attention
and current-work selection priorities apply to the latest recorded source revision;
older source revisions remain readable without displacing current work. The stable
family identity comes from its earliest recorded root, while explicit task links
select the exact root, child, or historical activity. Combined container and task
links compare both identities rather than silently opening another activity.

At 760px and narrower, the console uses horizontal navigation, a wrapping toolbar,
and stacked Inbox and detail panels. Each panel retains its own scrolling, and the
detail panel keeps a minimum height so activity controls remain accessible. The
desktop rail, header, and two-column presentation retain their original layout.

## State and metadata

Execution status comes from the task's recorded state. A completed Review can
coexist with a failed E2E task and a running verification. Missing or failed
publication does not rewrite a completed task's execution state; its retained
delivery information remains separate.
Activity rows infer missing-publication warnings only for root tasks with native
comment delivery responsibility. Completed reproduction, repair, and verification
follow-ups do not acquire that warning merely because they have no independent
comment. Recorded delivery problems retain their own warning.

Rows use available recorded stages, consumption, and timestamps without guessing
missing runtime information. The selected activity's current detail response is
reflected in its row, while the Inbox refresh supplies the other family states.
List presentation changes do not create attempts, restart work, publish comments,
or alter saved reports. The shared GitHub comment and per-round report history
remain as previously approved.

## Verification

The designated Windows Worker passed the Contracts build, Dashboard type check
and production build, and Biome for the eight changed TypeScript files. The six
targeted test files passed 138 tests covering activity presentation, source
grouping, exact navigation, detail loading, recorded execution allowance, and
immutable source/comment evidence.

The freshly compiled Dashboard passed all 11 browser checks on the Windows Worker.
The 1440px light and 320px dark layouts had no horizontal overflow. Checks covered
source grouping, exact root/child report and session navigation within the same
SPA record, layout and tab preservation, polling and externally updated activity
states, and real activity selection and layout controls at 320px. The final
screenshots were inspected with the production icon font loaded.

Browser API responses used GET-only synthetic native fixtures; action admission
and busy-selection guards were covered by unit tests. No production deployment,
application model call, or actual GitHub PR/Issue write was performed.
