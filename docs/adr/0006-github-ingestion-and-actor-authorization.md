# ADR 0006: Authorize GitHub Scheduling by Assignment Actor

- Status: Accepted
- Date: 2026-08-30

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

An authorized assignment or review request opens an authorization epoch. New pull request head revisions may inherit that authorization while the request remains active. Unassignment or review-request removal closes the epoch, cancels or stales related work, and requires a new actor authorization before future scheduling.

Unauthorized events are retained with an explicit reason for audit and dashboard visibility but do not create executable jobs. Local operator scheduling is recorded as a separate operator identity and never impersonates a GitHub actor.

## Consequences

- Self-assignment is distinguishable from assignment by another user.
- Arbitrary contributors cannot schedule expensive work merely by targeting the reviewer.
- Renamed GitHub accounts do not break authorization identity.
- Polling requires extra GitHub API calls and rate-limit-aware event caching.
- Authorization policies and epochs become versioned, auditable domain data.

