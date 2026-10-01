# Review Console capability gaps and design extensions

The Review Console handoff defines the target visual design and interactions.
Its HTML prototype uses simulated identities, metadata, session output, and
publication outcomes. The production console binds its presentation to the
existing native contracts instead of copying those sample values.

This document distinguishes product capabilities not currently available from
implemented extensions needed to represent real Review state. It is not a visual,
test, or runtime acceptance receipt.

## Capabilities requiring product evaluation

| Design expectation | Current backend boundary | Current console behavior | Possible future decision |
| --- | --- | --- | --- |
| Read Prompt Markdown, browse its real versions, and set the current version | The native service exposes the Prompt reference recorded on a Review, but no default reference, version catalogue, Markdown body, or active-version mutation. Generic legacy Prompt configuration does not control the native Worker's internally constructed instructions. | Displays recorded references, versions, and digests as historical, read-only data. It explicitly identifies content preview and version switching as unavailable. | Define a native Prompt catalogue and version binding that changes only subsequently created Reviews. |
| Author, module, Issue labels, and complete human-readable source metadata | The current work-item and report contracts do not provide all of the prototype's author/module/label fields. | Omits absent optional metadata. Module search only uses module information when it is actually available. Issue classifications and next-step information use real assessment fields. | Enrich source snapshots and public read contracts with the required recorded metadata. |
| Exact assignment, Code Review request, and re-request attribution | Intake supports all these triggers. The public delivery projection includes transport event, mode, numeric actor/reviewer IDs, and task binding, but does not expose the complete static trigger subtype or resolved login. | Uses neutral "Review request or assignment" wording for static events and numeric IDs; E2E command intake remains distinct. | Expose the recorded trigger subtype and actor identity without guessing from the transport event. |
| Resolved GitHub login and avatar for reviewer/trusted IDs | Intake settings retain numeric reviewer and trusted-actor IDs without an ID-to-login lookup service. | Adds, removes, validates, and saves numeric IDs. It does not substitute the prototype's bot or operator login. | Add optional identity resolution with an explicit unresolved state. |
| Copy a canonical public Webhook URL and show verified connectivity | Settings expose whether the receiver is configured, without a canonical external URL or a connection-health observation. The browser origin alone does not establish the public receiver address. | Displays configured/unconfigured state and explains when address information is unavailable. | Provide a canonical public address and separately defined connectivity observation. |
| Verified publishing account login, permission scope, and authorization identity | Automatic reply settings expose publisher configuration and saved local account authorization, without the publishing GitHub login or verified token scope list. | Displays real configuration, authorization account ID, update information, and recorded rejection reasons. Reauthorization renews the saved local authorization rather than claiming to replace an OAuth token or PAT. | Expose publisher identity and actual scope diagnostics if needed. |
| Republish every historical result with one action | New native conclusions use the shared publisher and its available `sync`/`reconcile` actions. Historical legacy `mode=result` publications have no such actions and retain their original operation workflow. | Uses only server-provided actions. A legacy result is readable but is not offered a fabricated shared-comment retry. | Add a deliberate recovery operation for legacy result records, or retire that recovery path explicitly. |
| Continue a Review after its execution budget is exhausted | The resume endpoint can require an explicit increase of that Review's exhausted limits. The handoff intentionally excludes budget controls. | Retries with the saved limits and surfaces a server rejection without claiming the Review resumed. | Define an operator recovery flow or a server policy for exhausted Reviews; distinguish per-Review recovery from global configuration. |
| Show the GitHub comment exactly as it appears now | The read API retains confirmed delivery bodies; it does not perform a fresh GitHub readback for this view. | Labels the preview as the last confirmed publication and shows its recorded time. | Decide whether an explicit read-only upstream refresh is needed, including edited or deleted comments. |
| File-based coverage matching the prototype | Current reports count review scope units, which need not be individual files. | Labels the count as scope units and uses saved E2E feature outcomes. | Expose exact file coverage if that metric is required; do not relabel scope-unit counts as files. |
| Original code context beside each finding | Findings contain locations and repair advice, but no persisted original code snippet. A replacement suggestion is not the original source. | Renders the real location, impact, and suggestion; omits optional snippets. | Supply context from the exact immutable source revision with an explicit source binding. |
| Numeric command exit code | Normalized session events contain command text, output, and status without a numeric exit-code field. | Shows observed running/completed/failed/cancelled status. It does not display an invented `exit 0`. | Extend normalized output with the observed exit code if this distinction is useful. |
| Ignore a failed Review persistently for the team | There is no shared operator dismissal field or ignore/unignore API. Intake's `ignored` state means an event was rejected by intake policy, not a user dismissed a reminder. | Dismissal and undo affect reminders in the current browser session, scoped to the authenticated identity. They do not change execution, evidence, or server retry behavior. | Decide whether dismissal is personal or shared, its persistence, and whether it should affect reminders only or retry policy. |

Worker display names and authoritative online/busy health are also absent from the
current control contract. The console uses the real Worker ID, recent contact,
activity leases, and E2E admission/cleanup state. A contact timestamp is an
observation rather than proof that the Worker is currently healthy.

## Implemented extensions to the handoff

### Completed report with unconfirmed publication

The prototype progresses every successful Review through publication. Real
automatic replies can be disabled, unavailable, awaiting delivery, or lacking a
confirmed report-specific publication. Review completion therefore cannot be
translated automatically into "Published", and missing publication metadata is
not proof that a GitHub write failed.

The console adds a separate **Completed · Publication unconfirmed** Inbox group.
These records retain their readable report and session. They do not increase the
needs-attention badge and are not given a false published or publication-failed
status. Actual pending/sending/retrying publication remains in progress; a
recorded blocked, failed, or uncertain publication retains its real reason and
available recovery actions.

This adds one group to the handoff. Product evaluation can decide whether the
group should remain, use another label, or become a filter once the product has
an explicit unpublished-result policy.

### Related reproduction, repair, E2E, and verification activity

Native Reviews can have related reproduction, patch, implementation, E2E, and
verification work. Hiding these activities would remove monitoring and recovery
for existing execution capabilities; showing each as an unrelated new intake
would lose its connection to the original Review.

The console retains one Inbox record for the original Review and adds an activity
selector inside its details. Each selection reads its own report, session, model,
Worker, and recovery controls. Active or failing related work can bring the
family into the appropriate Inbox group. A completed related activity without a
separate comment is represented as completed, not as a failed publication. Exact
activity links select the related activity inside the same family.

This adds a selector that was not drawn in the prototype, while keeping internal
Attempt and Checkpoint concepts out of the user interface. Product evaluation can
decide whether activities should remain selectable there or receive another
explicit layout.

### Historical publication after a re-request

The shared publisher updates the same GitHub comment for later Review activity.
Its current report binding can therefore replace the binding of an older Review.
The console retains exact-report successful delivery receipts to distinguish
"previously posted" from "the current comment still shows this result". Historical
publication is identified as previously posted, with a note that the comment has
subsequently changed; its saved report remains available.

Explicit record links that are unavailable or inaccessible show an unavailable
state. They do not silently display a different Review as if it were the requested
historical record.

## State semantics preserved during the rewrite

- A stop acknowledgement means the request was accepted. The Worker can still be
  stopping or cleaning up. Continuation from saved progress is promised only when
  a checkpoint exists; otherwise the action restarts from the original source.
- Shared final conclusions are bound by the completed report ID even though their
  publication protocol mode remains `progress`. A received or started comment is
  not proof that the conclusion was published.
- A successful update clears an older failure banner for that comment; the failed
  delivery remains in history. Uncertain outcomes are not silently resent.
- Findings retain confirmed versus hypothesis status. Coverage is shown as scope
  units, and E2E coverage uses actual saved feature outcomes.
- Account, repository, publication, task, report, and session identities remain
  bound to their real records. Changing the account or grants clears protected
  query state instead of reusing another account's session output.

These semantics are implementation responsibilities, not optional feature gaps.
The [Dashboard README](../../apps/dashboard/README.md) describes the registered
views, API usage, and permission boundaries.
