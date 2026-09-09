# ADR 0006: Authorize GitHub Scheduling by Assignment Actor

- Status: Accepted
- Date: 2026-08-30

Revision authorization scope is amended by [ADR 0030](./0030-explicit-pull-request-execution-authorization.md).

## Context

An issue or pull request assigned to the configured reviewer must not automatically authorize every GitHub user to consume worker capacity. The system must distinguish who created the item, who performed the assignment or review request, and who was targeted.

## Decision

Ingest GitHub webhook events when a GitHub App can be installed, and always run periodic polling reconciliation to recover missed deliveries and current-state drift. If webhook installation is unavailable, polling becomes the primary ingestion path.

Normalize and persist three separate identities:

- `author`: the issue or pull request creator.
- `actor`: the user or App that assigned the item or requested review.
- `target`: the assignee or requested reviewer.

Authorization uses immutable GitHub user IDs, not login names. The default policy is `SelfOrAllowlist`: a request is eligible only when the target is the configured reviewer and the actor is either that reviewer or a configured allowed user. Unknown actors are denied. Team review requests and Apps are denied until explicitly configured with stable team or installation identities.

For polling, read GitHub issue timeline/events to recover `assigner` or `review_requester`; current assignee and requested-reviewer lists alone are insufficient. Webhook deliveries and polled events are normalized through the same idempotent ingestion path.

An authorized assignment or review request opens an authorization epoch. By default, pull request
execution is limited to the immutable base/head revision in the verified request webhook. A later
PR revision requires a new explicit request. Operators may explicitly select
`inherit_authorized_epoch` to trust subsequent PR code while the request remains active; both the
current and original epoch policies must permit it. Issue snapshots retain active-request
inheritance because their jobs do not check out code. Unassignment or review-request removal closes
the epoch, cancels or stales work that depended on it, and requires new actor authorization before
future scheduling.

In the default execution mode, polling cannot turn a historical PR request actor into authorization
of the current SHA. It still synchronizes PR state and revocations. Incomplete or conflicting
request evidence pauses new execution rather than extending the last-known authorization.

Unauthorized events are retained with an explicit reason for audit and dashboard visibility but do not create executable jobs. Local operator scheduling is recorded as a separate operator identity and never impersonates a GitHub actor.

## Consequences

- Self-assignment is distinguishable from assignment by another user.
- Arbitrary contributors cannot schedule expensive work merely by targeting the reviewer.
- Renamed GitHub accounts do not break authorization identity.
- Polling requires extra GitHub API calls and rate-limit-aware event caching.
- Authorization policies and epochs become versioned, auditable domain data.
