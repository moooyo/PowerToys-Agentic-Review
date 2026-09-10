# GitHub publication acceptance

This acceptance is prepared for **moooyo/PowerToys** (repository ID `1299518756`), using the
current `moooyo` GitHub CLI identity (user ID `42196638`). Preparation does not authorize or perform
GitHub writes. The default script mode is preparation; execution requires the operator to approve
the generated plan and both complete rendered publication templates, then explicitly use
`--execute`.

The fixed baseline is `main` at `3a1e642db52d45f88c0cb702b10663e1f65623f7`. Issues are currently
disabled. Execution must recheck these facts, refuse an existing test branch, and refuse any
substitute repository or existing PR/Issue.

## Requested external changes

This V2 plan replaces the unapproved 11-operation V1 plan. The original document, PR/Issue bodies,
publication templates, branch, repository identity and source SHA remain unchanged. V1 artifacts
are retained and cannot be used to execute V2.

The exact request bodies are in `approval-plan.json`, generated from `plan.mjs`.

1. Disable this fork's Actions with the supplied `PUT /actions/permissions` payload.
2. Create `codex/m40-publication-20260910-b2619d4e` from the frozen main commit.
3. Add only `doc/agentic-review-acceptance/m40-publication-20260910-b2619d4e.md` with the supplied text.
4. Create the supplied draft PR against this fork's `main`.
5. Temporarily set this fork's `has_issues` to `true`.
6. Create the supplied dedicated test Issue.
7. Send exactly one PR review with event `COMMENT` and the approved production-renderer body.
8. Send exactly one Issue comment with the approved production-renderer body.
9. Close the newly created draft PR, without merging it.
10. Close the newly created test Issue as completed.
11. Delete only the newly created test branch.
12. Restore `has_issues` to `false`.
13. Restore this fork's original Actions permissions with the supplied payload.

The test PR/Issue and their comments remain as remote history. Enabling Issues is necessary for
the Issue-comment case on this fork; restoration is part of this same proposed scope. No labels,
assignees, review requests, approval reviews, source code changes, merges, or comment edits are
included. The fork's frozen `spelling2.yml` listens to `pull_request_target` and can post PR comments,
including for draft PRs. Disabling repository Actions for the complete exercise prevents this
known workflow and other repository workflows from reacting to these test mutations.

Before the first write, the harness requires the exact original Actions state:
`enabled: true`, `allowed_actions: "all"`, `sha_pinning_required: false`. It reads every workflow-run
page and refuses any status other than `completed`, including queued, in-progress, requested,
pending, waiting and unknown states. It never cancels an existing run. After requesting disable,
it requires `enabled: false` in a GET response and repeats the run check before creating the
branch or either target. Visible optional permission fields must still match the original values;
the API may omit those fields while Actions is disabled. Initial and final restoration checks
require the complete original permission values.

The official [GitHub REST API description](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json)
defines all three request fields for `PUT /repos/{owner}/{repo}/actions/permissions`, with a `204`
success response. Both payloads explicitly retain `allowed_actions: "all"` and
`sha_pinning_required: false`; only `enabled` changes. No workflow file or per-workflow state is
edited. After the original cleanup attempts, the harness reads back permissions and restores the
original state whenever it attempted to change Actions. Lost acknowledgements are recorded and
resolved with GET; failed or uncertain restoration is retained in the receipt. It never blindly
retries a mutation.

## Production components and result meaning

The harness uses the existing SQLite fixture helper, production database owner, publication
preview and confirmation, durable outbox, `startPublicationPublisher`, and
`GitHubPublicationClient`. The local run and validation result are explicitly synthetic. They do
not claim an actual PowerToys build, test, model run, or product approval.

The real client checks the authenticated user, repository ID, work-item ID, URL and frozen source
before publishing. After each successful real POST, the harness deliberately discards its local
acknowledgement. The database must retain `unknown`; explicit reconciliation must use GET only,
find one exact body/identity match, persist `published`, and leave the POST count at one. This is
an acknowledgement-loss exercise, not permission to resend a mutation.

The two complete renderer templates must be included in the approval bundle. Only the mechanical
fields listed in `plan.mjs` may be replaced after the new targets exist. Every other character of
the rendered body must match its approved template. The normal production integrity checks remain
enabled.

## Credentials and execution environment

Run the SQLite owner in the supported Linux environment with the prepared project build. The
GitHub credential comes from `gh auth token --hostname github.com` and stays in memory. A
coordinator may instead pipe that same current-session credential to the harness through stdin;
it must not place the token in an argument, a file, a transcript, or a receipt. The harness never
reads Codex/Copilot authentication or provider files.

Prepare and inspect the bundle before asking for execution approval. No target creation, setting
change, branch push, review, comment, or cleanup request is allowed during preparation.
