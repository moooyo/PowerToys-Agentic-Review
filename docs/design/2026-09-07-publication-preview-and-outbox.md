# Publication preview and delivery outbox

Status: M30 implementation and isolated connected acceptance completed on 2026-09-07.
No live GitHub delivery is authorized by this plan. See the
[acceptance report](../../artifacts/m30-publication-20260907/REPORT.md).
The accepted roadmap requires a complete preview, explicit authorization, durable intent,
delivery adapter, and visible recovery path. M29 scheduling acceptance remains the baseline.

## User flow and authority

An operator selects an immutable decision on one ReviewRun, inspects the exact GitHub target,
reviewed revision, event, and complete outgoing body, then separately confirms publication.
Recording a platform decision never sends to GitHub. Repository read access permits previews
and outbox reads; existing configure permission is required to enable the repository publication
policy, confirm, cancel, retry, or reconcile. Review permission alone gains no new write power.

Repository publication policy is a separate versioned configuration with immutable audit. It is
disabled by default. Delivery additionally requires a separately configured runtime credential;
the ingestion credential is never reused. An unavailable publisher is explicit in the preview
and cannot accept a confirmation that would silently start sending after later configuration.

The initial supported targets are PR reviews and Issue comments on GitHub.com. Ordinary approve,
request-changes, and comment decisions map to explicit GitHub review events. A qualified approval
override is published as a clearly labeled comment, preserving the distinction from unqualified
approval. Issues never receive approval. Check runs are explicitly unavailable in this version.

## Frozen publication and concurrency

The server renders from the complete selected decision and verified immutable run/result data,
never the Dashboard's shortened findings projection. The renderer retains every check, finding,
and policy reason; it does not silently truncate a report to fit the endpoint. Unknown or
oversized payloads return an explicit preview blocker. The final body includes a
stable publication marker shown in the preview, with a semantic digest excluding the marker.

One deterministic publication ID binds the repository, Run, selected decision, and renderer version.
The selected decision fixes its source/result binding. Intent creation additionally checks current
decision version, repository publication policy version, exact payload digest, current source,
permissions, and required evidence after asynchronous verification. A new decision or a changed
result set requires a new preview. A comment event is resolved by its actual event ID, rather than
the latest non-comment decision pointer. Withdrawn/superseded/stale decisions cannot publish.

Intent target, body, digest, selected decision, full binding, actor, and confirmation receipt are
immutable. Mutable delivery state has a CAS version and fenced lease; attempt history is append-only.
Identical change-ID replay returns the original receipt after a current permission check. Reusing
an ID with different actor or content conflicts. A unique logical publication key prevents a
second confirmation of the same selected decision from creating another remote operation.

## Delivery and uncertainty

The publisher is a separately owned, serial background service. It consumes only confirmed
intents, performs read-only GitHub identity/source preflight, then rechecks local actor, source,
decision, policy, evidence, and fence before recording that sending may have begun. Only after
that durable boundary may it make one POST with the frozen payload. It never follows redirects
with credentials or uses arbitrary hosts or paths from a response.

States are pending, delivering, published, failed, blocked, unknown, and cancelled. A definite
preflight/rejection failure can be retried only with a fresh explicit operator action and current
authorization. Once sending may have begun, timeout, disconnect, 5xx, invalid success response,
process loss, or lease expiry produces unknown. Unknown is never automatically resent, even
after a complete scan returns no match. Reconciliation uses GETs only, matching exact target,
marker, body, frozen publisher numeric ID, and PR commit/event semantics. Multiple matches,
edited/dismissed content, pagination limits, or incomplete reads remain visible uncertainty.

GitHub does not offer a general idempotency key or compare-and-swap revision condition for these
creation endpoints. The product promises one recorded send attempt with conservative recovery,
not distributed exactly-once delivery. PR commit_id binds the reviewed commit but cannot make
GitHub's latest-head check atomic with the local transaction. Issue comments have no revision CAS.
These limits appear in the confirmation and delivery history rather than being hidden.

## Integration and verification

The implementation adds strict versioned contracts, migration 26, repository-policy/preview/intent/history operations,
operator allowlist rules, real HTTP routes, scoped Dashboard services, a Run publication preview,
and a real repository-scoped outbox. Preserve existing Job, Run, decision, and finding records.
Use the existing asynchronous evidence-verification/revalidation boundary before publication.

Tests use isolated Linux databases and injected mock GitHub transport only. Contract, route,
database-owner and publisher tests cover stale/revoked conflicts, definite rejection, and
process/lease recovery. Final connected acceptance passed 19 commands and 17 coverage requirements
on two repositories and distinct sessions: exact preview confirmation, permission downgrade,
lost confirmation response and exact replay, ambiguous delivery, GET-only reconciliation,
independent Issue delivery, scoped denial, and policy/attempt history inspection. Both mock
targets received exactly one POST. Test transports reject all real GitHub mutations. A separately
approved live target/payload would be required to claim actual GitHub delivery acceptance.

Actionable in-product notifications and Prompt/profile evaluation remain subsequent roadmap work.
Windows application acceptance separately needs a dedicated interactive environment; model
summaries remain disabled while their existing network boundary is unaccepted.

## Protocol references

- [PR review creation](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request)
  uses explicit commit_id/body/event and returns 200.
- [Issue comment creation](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)
  returns 201; both creation endpoints lack a documented idempotency key.
- [Pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
  and [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
  bound conservative reconciliation and later explicitly authorized retries.
