# ADR 0030: Explicit Pull Request Execution Authorization

## Status

Accepted on 2026-09-06.

## Context

ADR 0006 authorizes an assignment or review request by its actor and lets later revisions inherit
the active request. ADR 0029 permits execution of admitted repository code. Combining those two
decisions without an explicit scope makes one request also authorize code that a contributor may
push later, including code from a public fork.

A request to review a pull request and permission to execute a particular repository revision are
separate facts. An immutable SHA identifies the bytes to execute; it does not establish permission
to execute those bytes. The trusted-code execution model remains appropriate only when admission
records the intended authorization scope.

## Decision

1. Default execution scope:
   - `AGENTIC_REVIEW_GITHUB_NEW_REVISION_POLICY` defaults to `require_new_authorization`.
   - An authorized pull request assignment or review request authorizes only the immutable
     `baseSha` and `headSha` in that request's verified webhook snapshot.
   - A later base/head revision requires a new explicit assignment or review-request action by an
     authorized actor. A push by an allowed actor is not itself a review request.
   - A request can remain active for observation and audit while the latest revision has no
     execution authorization. Revision observation alone must not create an executable job.

2. Explicit automatic inheritance:
   - An operator may set the exact value `inherit_authorized_epoch` to authorize automatic
     execution of subsequent revisions while an authorized request remains active.
   - This choice trusts future code submitted to that request, including fork changes; it is not
     a claim that the head repository or its contributors have independently been allowlisted.
   - Both the current policy and the policy snapshot that opened the epoch must explicitly permit
     inheritance. A missing `newRevisionPolicy` in a stored snapshot requires new authorization.
   - The opening actor and review target must still satisfy the current policy. Removing the actor
     from the allowlist or changing the configured target prevents future inherited scheduling.
   - A policy change does not enlarge an existing revision-scoped request. An operator must arrange
     a new explicit request when widening its scope. Tightening the current policy stops future
     inheritance without rewriting the original authorization evidence.

3. Evidence from polling:
   - GitHub timeline evidence identifies who opened a request, but does not bind that historical
     action to the head SHA returned by a later pull request detail query.
   - In the default mode, polling synchronizes pull request snapshots and revocations but does not
     open executable authorization from a historical request. A new verified webhook request is
     required for an exact revision authorization.
   - A deployment that needs polling-only automatic PR execution must explicitly choose
     `inherit_authorized_epoch` and accept its wider scope.
   - In either mode, incomplete timeline or search evidence may retain a last-known projection for
     audit but cannot grant execution of a newly observed revision. Conflicting request transitions
     with indistinguishable timestamps also require reconciliation before new execution.
   - Replaying a historical request, including across webhook and polling sources, cannot act as a
     new explicit authorization or reopen an authorization that was already withdrawn.

4. Issue triage:
   - Issue jobs use a snapshot-only workspace and do not check out repository code.
   - An active authorized issue request can continue to cover updated issue snapshots in either
     mode. Polling may recover its actor from complete timeline evidence.
   - Closing or withdrawing the request still prevents future issue scheduling until a new
     authorized request is established.

5. Persistence and job ownership:
   - The existing `authorization_decisions` policy snapshot and digest record the selected scope;
     operators increment `AGENTIC_REVIEW_GITHUB_POLICY_VERSION` when changing policy.
   - An inherited decision records the current policy and references the original epoch, whose
     opening decision retains the original policy snapshot. Both sides remain auditable.
   - Jobs may rely only on epochs that actually authorize their exact revision. An older active
     request for another revision cannot keep a job authorized after its real request is withdrawn.
   - This decision changes admission and future scheduling. It does not retroactively reinterpret
     completed results or introduce an automatic purge of existing jobs during configuration load.

## Consequences

- The default deployment needs fresh request webhooks for PR execution; historical polling events
  cannot silently substitute for exact revision approval.
- Operators retain an explicit opt-in for the existing automatic PR lifecycle workflow.
- Missing legacy policy scope is readable for audit and fails closed for PR inheritance.
- Issue triage keeps its snapshot workflow without gaining repository execution authority.
- ProcessHost remains a process and resource boundary. No adversarial code sandbox or additional
  Worker credential boundary is introduced by this decision.

## Amends

This decision narrows the default revision inheritance in ADR 0006 and defines execution admission
scope for ADR 0029. All other decisions in those ADRs remain unchanged.
