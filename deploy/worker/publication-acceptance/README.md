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

The exact request bodies are in `approval-plan.json`, generated from `plan.mjs`.

1. Create `codex/m40-publication-20260910-b2619d4e` from the frozen main commit.
2. Add only `doc/agentic-review-acceptance/m40-publication-20260910-b2619d4e.md` with the supplied text.
3. Create the supplied draft PR against this fork's `main`.
4. Temporarily set this fork's `has_issues` to `true`.
5. Create the supplied dedicated test Issue.
6. Send exactly one PR review with event `COMMENT` and the approved production-renderer body.
7. Send exactly one Issue comment with the approved production-renderer body.
8. Close the newly created draft PR, without merging it.
9. Close the newly created test Issue as completed.
10. Delete only the newly created test branch.
11. Restore `has_issues` to `false`.

The test PR/Issue and their comments remain as remote history. Enabling Issues is necessary for
the Issue-comment case on this fork; restoration is part of this same proposed scope. No labels,
assignees, review requests, approval reviews, source code changes, merges, or comment edits are
included. Repository automations may observe the new draft PR and Issue; this harness does not
change or enable workflow settings.

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
