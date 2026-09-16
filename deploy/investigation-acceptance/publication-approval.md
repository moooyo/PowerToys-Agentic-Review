# Native Task/Report publication approval and execution record

**Status: explicitly approved and passed for the single run recorded below. The one-run approval
is consumed and cannot be reused.** The JSON companion remains the original immutable approval
draft, not an executable harness. Its original `draft_pending_user_approval` field is historical;
this document records the later approval and execution without changing the approved JSON bytes.

Run ID: `investigation-publication-20260916-v1`.

The approved scope covered one run and exactly two test comments through the active
investigation Server's prepared and confirmed `ActionIntent` path. Each target permitted at most one
GitHub POST attempt. The fixed bodies below make no code, review, reproduction, or product-quality
conclusion and require no maintainer response. The comments remain in place; cleanup is not part
of this scope.

## Verified targets

Read-only observations completed at `2026-09-16T02:40:40Z`. The repository is the public fork
[`moooyo/PowerToys`](https://github.com/moooyo/PowerToys), GitHub numeric ID `1299518756`, with owner
`moooyo` (`42196638`). It is neither archived nor disabled, and Issues are enabled. `GET /user`
returned the same public identity. No token value was read or displayed.

| Target | Observed identity and state | Revision |
| --- | --- | --- |
| [PR #3](https://github.com/moooyo/PowerToys/pull/3), `[Agentic test] Quick Accent toolbar recovery after focus changes` | Open, draft, unmerged, unlocked; PR ID `4521963214`, issue-resource ID `5444099473`; author `moooyo` (`42196638`). | Base `ae52732c3d694f53bddce983da8c01112d81853b`; head `266618cf30c62f2d008d67d3209b7e11de5a0195`; updated `2026-09-14T02:15:31Z`. |
| [Issue #5](https://github.com/moooyo/PowerToys/issues/5), `[Agentic test] ZoomIt DSC settings do not match Settings changes` | Open, unlocked; Issue ID `5444100835`; author `moooyo` (`42196638`); not a PR. | No PR head SHA; updated `2026-09-14T12:31:23Z`. |

PR #3 had no conversation comments. Issue #5 had one existing comment. The fully paginated comment
reads found no `investigation-publication-20260916-v1` marker on either target. These observations
must be refreshed before execution; changed identities, revisions, or target state require a new
reviewable draft rather than silent retargeting.

## Fixed comment bodies and allowed requests

Operation 1 is a PR **conversation comment**, not a review, approval, or inline code comment:

`POST /repos/moooyo/PowerToys/issues/3/comments`

The complete fixed `ActionIntent.payload.body` is:

```text
Native Task/Report publication acceptance test.

Run ID: `investigation-publication-20260916-v1`
Target: `moooyo/PowerToys#3` (pull request conversation comment).

This comment tests the new investigation Server's prepared and confirmed ActionIntent comment delivery. It contains no code-review findings, approval recommendation, reproduction result, or product-quality conclusion. No maintainer response or action is needed.
```

Operation 2 is an Issue comment:

`POST /repos/moooyo/PowerToys/issues/5/comments`

The complete fixed `ActionIntent.payload.body` is:

```text
Native Task/Report publication acceptance test.

Run ID: `investigation-publication-20260916-v1`
Target: `moooyo/PowerToys#5` (issue comment).

This comment tests the new investigation Server's prepared and confirmed ActionIntent comment delivery. It contains no code-review findings, approval recommendation, reproduction result, or product-quality conclusion. No maintainer response or action is needed.
```

Both actions use `action: "comment"` and a feedback payload with `kind: "feedback"`, the exact body
above, `findingIds: []`, and `drafts: []`. No findings or report conclusions may be inserted.

The native GitHub transport appends two LF characters and this correlation comment to each body:

```text
<!-- agentic-review-action:<prepared intent id>:<prepared payloadDigest> -->
```

The Server generates the intent ID during preparation and computes the payload digest from the
fixed payload. No intent existed when the original draft was prepared, so it specified this native
suffix rule without inventing a marker ID. The user's approval covered that rule. The two generated
marker values were the only permitted variation; the visible body, action, payload structure,
target, and endpoint remained fixed. The prepared intents and fully expanded bodies were checked
before the exact versions and digests were confirmed. The production Server transport delivered
the comments; no direct `gh`, browser, or independent comment POST was used.

## Existing repository automation

Read-only Actions permissions returned `enabled: true` and `allowed_actions: "all"`. The observed
default-branch SHA was `8e832ee72dcffb5df297ceb9e06a04797375092c`. Inspection of its ten workflow YAML
files found one `issue_comment.created` trigger, in
[spelling2.yml](https://github.com/moooyo/PowerToys/blob/8e832ee72dcffb5df297ceb9e06a04797375092c/.github/workflows/spelling2.yml).

Its spelling job requires a PR event or push event, so that job does not run for these comments.
Its update job requires a PR comment containing `@check-spelling-bot`, `apply`, and `https://`.
Neither approved body nor the native suffix contains those commands, so that job is expected to
be skipped. GitHub may still create a workflow-run record for each event with skipped jobs.

Approval includes normal GitHub comment notifications and `issue_comment` events. This inspection
does not inventory external notification subscriptions or installed third-party applications.
Recheck the default-branch SHA, relevant workflow content, and Actions permissions before sending.
Do not disable automation, dispatch or cancel workflows, or change repository settings as part of
this run.

## Execution and reconciliation limits

These are the limits approved for the completed run. They do not authorize another execution.

1. Wait for explicit approval of this draft, including the fixed bodies, native suffix rule,
   single-run write budget, and incidental comment-event effects.
2. Refresh all target, publisher, repository, and automation observations using GET requests.
   Stop if this run ID or either matching native marker already exists.
3. Use the native Server's imported snapshots and current action context to bind exact source
   identities. Preserve repository, actor, revision, target-state, and pending-delivery guards.
   Do not invent source, report, or finding evidence.
4. Prepare each native comment intent, retain its exact payload and generated marker, and confirm
   that intent once. Only the production Server transport may make the two listed upstream POSTs.
5. Retain response status, comment ID/URL, native intent state, and GET-only readback of the exact
   body, author, and target. Do not interpret transport acceptance as code-review correctness.

An unknown delivery stops further POSTs until GET-only reconciliation establishes its state.
Use the existing native reconcile path and paginated comment GETs; never automatically resend,
create a replacement intent, or use a compensating write. If delivery remains unknown or fails,
retain its receipts and stop the run. Approval is consumed by this one run and does not authorize
another attempt, target, body, or rerun.

The only permitted GitHub mutations are the two listed comment POST attempts. Creating or editing
PRs/issues, changing labels or reviewers, closing/reopening, reviews, approvals, merges, commits,
pushes, branches, repository settings, and workflow changes are excluded. Editing or deleting the
test comments is also excluded. No write to `microsoft/PowerToys` or any other repository is allowed.

The exact machine-readable targets, bodies, constraints, and required receipts are in
[publication-approval.json](./publication-approval.json). This draft contains no deployment host,
private path, local account, or credential information.

## Approval and execution record

The user explicitly approved the draft for `investigation-publication-20260916-v1`. The approved
JSON SHA-256 is `0671baa0f8a5c4b446dbadc3a8e4b7013cae1af04c490f6662bbdbf3f49ba936`; its original
bytes and fixed payloads have not been rewritten. Native preparation ran from
`2026-09-16T07:22:59Z` to `07:23:22Z` without external writes. Execution ran from
`2026-09-16T07:24:12.437Z` to `07:24:53Z` and passed, with both native ActionIntents in
`succeeded` state and the Server exiting with code 0.

| Target | Result | Conversation count | Native confirmations | Derived POST-attempt upper bound | New matching comments observed by GET |
| --- | --- | --- | ---: | ---: | ---: |
| PR #3 | [Comment 5693633461](https://github.com/moooyo/PowerToys/pull/3#issuecomment-5693633461) | 0 to 1 | 1 | 1 | 1 |
| Issue #5 | [Comment 5693635709](https://github.com/moooyo/PowerToys/issues/5#issuecomment-5693635709) | 1 to 2 | 1 | 1 | 1 |

Independent GET readback matched the complete approved body, native marker, author numeric ID
`42196638`, and target for each comment. The POST-attempt upper bound is derived from one native
confirmation per target and the production transport's single-mutation path. No HTTP proxy was
installed, so this is not a direct measurement of network POST counts. Neither delivery became
unknown and native reconciliation was not invoked. Ordinary GET readback does not establish the
unknown-delivery recovery path.

The run restricted repository endpoints to `moooyo/PowerToys`, with `GET /user` used separately
for publisher identity. Redirects were rejected. No request to `microsoft/PowerToys` was part of
this publication run. The only repository mutations were the two approved comments. No product
code changed and no new full-suite result is claimed for this execution.

Cleanup at `2026-09-16T07:26:19Z` confirmed the temporary publisher credential was removed,
the owned Server was closed, and original CLI authentication remained untouched. The sanitized
native receipt is retained with SHA-256
`d991019800be08e9294c4f2752a65872741792087d417a573d04661cf31ef5d0`.

Both comments remain in place. The single-run budget is fully consumed; it does not authorize a
rerun, replacement intent, comment edit/deletion, or any other cleanup mutation. Other publication,
source execution, real reproduction, UI, and production-operation scopes retain their own boundaries.
