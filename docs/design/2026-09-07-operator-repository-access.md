# Operator repository access

Status: M19 persistence, HTTP authorization, and Dashboard integration are implemented and verified.
This is a prerequisite for revision-bound human decisions and finding disposition. It does not
implement those decisions or Issue reproduction mapping. The subsequent M20a decision workflow is
tracked [separately](./2026-09-07-run-human-decisions.md).

## Authority and roles

An operator identity is the exact, case-sensitive `(issuer, subject)` pair established by the
existing authenticated session. Display names, email addresses, GitHub logins, request-body
actors, and Worker bearer credentials are not substitutes for that pair.

Platform administrators come only from trusted Server configuration. Loopback mode uses its
explicit development identity. OIDC deployments must provide
`AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON`: a nonempty unique subset of the existing authorized
login subjects. The configured issuer text is preserved exactly and checked by existing OIDC
discovery validation. A missing administrator setting fails configuration validation. There is
no first-login administrator, inference from old sessions, or implicit promotion of every allowed
login subject. Runtime administrators cannot be changed through the HTTP membership API.

M19 adds repository memberships with four inherited permission levels:

| Repository role | Read repository/work items/results/evidence | Run controls | Repository configuration | Manage repository members |
| --- | --- | --- | --- | --- |
| viewer | Yes | No | No | No |
| reviewer | Yes | Yes | No | No |
| maintainer | Yes | Yes | Yes | No |
| admin | Yes | Yes | Yes | Yes |

Platform administrators have all repository permissions. They alone may add repositories, access
global Prompt catalogs/templates/versions/default bindings, or inspect and manage global Worker,
System, and credential resources. Profiles belong to repositories. Reading an authorized run or
its repository-bound configuration does not authorize enumerating unrelated global templates.

A runtime administrator can also have an independent repository grant. It does not reduce their
effective runtime authority; it becomes relevant only if that identity is later removed from
trusted administrator configuration. A repository admin cannot remove the last repository-admin
grant unless acting as a platform administrator, which remains the recovery authority. Pausing
repository scheduling does not revoke access to its history.

## Persistence and requests

`0019_operator_repository_access.sql` creates repository grant tombstones and immutable access
audit records. An audit insertion atomically updates the grant projection through triggers.
Direct projection edits, replacement, deletion, and history rewriting are rejected. Changes use
an expected version, a reason, and a scoped idempotency key. Authorization is checked before
replaying a receipt; a revoked caller cannot reuse an old successful change to regain access.
Receipts describe the historical accepted change, not a promise of current membership.

Operator HTTP handlers bind their database requests to the session identity through
`bindOperatorDatabase`. The dedicated `operatorRequest` envelope has an explicit operation
allowlist, independent of the privileged internal database operation registry. It cannot invoke
lease/authentication, ingestion, bootstrap, raw SQL, shutdown, or nested Operator operations.
Audit actor fields are derived from the context and reject conflicting supplied identities.
Trusted Server scheduling, Worker, authentication, and maintenance code keeps its separate
internal database path; possession of that in-process client is system authority, not a browser
permission. New Operator routes must use the bound path.

Database authorization resolves actual resource ownership, including older Job IDs and work-item
lookups. Invisible or missing resources have the same opaque 404 response. An operator who can
read a repository but lacks a requested action receives an opaque 403. Schema/configuration and
version-conflict diagnostics remain actionable within authorized scope.

Lists filter authorized repositories in SQL before search, totals, ordering, and pagination.
They never fetch a global page and hide unauthorized rows afterward. Permission predicates read
current grant rows, rather than retaining a cached list of authorized repositories. Existing
unassociated legacy Jobs remain hidden from nonadministrators; the previous Dashboard DTO still
does not project Jobs without a work item.

Prepared evidence reads authorize before preflight and again inside their final synchronous
projection after awaiting verification. A revocation during hashing prevents the response from
containing previously prepared data. Each evidence download chunk is a new authorized database
operation, so a stream does not retain an irrevocable access grant. GitHub connection probes
check their required permission before using the Server integration credential and recheck after
asynchronous work. The verifier still cannot access SQLite or receive operator/Worker credentials.

## Dashboard and HTTP surfaces

- `GET /api/v1/operator/access` returns the current principal and platform status; an optional
  `repositoryId` requires repository read access and returns the effective role/permissions.
- `GET /api/v1/operator/repositories/:repositoryId/access` lists grants, including tombstones.
- `POST` to the same path records a versioned membership change.
- `GET /api/v1/operator/repositories/:repositoryId/access/history` lists immutable changes.

Membership lists and history are bounded to 50 rows per page. Response validation binds both
outer scope and every returned row to the selected repository. Changes bind the returned receipt
to the submitted intent and authenticated actor. Recovery maintenance permits reads while
membership mutations remain disabled; the existing restricted credential-recovery workflow is
preserved for platform administrators.

An authenticated user with no grants has an empty repository directory, rather than being
silently promoted or signed out. UI controls reflect current permissions, but the Server remains
authoritative. A different authenticated principal must not reuse the previous user's query
cache, selected work item, or repository title. Ordinary same-principal permission refresh must
not reset unsaved drafts unnecessarily. Explicit sample data is separate from production access;
an HTTP authorization failure never enables a sample-data fallback.

## Verification and remaining boundaries

The integrated Linux Server regression passed 2,771 tests with one skip. Eleven real
`DatabaseClient` tests include two repositories with the same PR number/SHA, scoped totals,
identity mismatch, role changes, replay/last-admin safeguards, per-chunk revocation, and two
32 MiB prepared-read races where revocation prevents data return while heartbeats continue.
Route tests exercise session context, denied probes, credential generation, response scope,
read-only recovery, and malformed or forged input. The final contracts/domain/Codex/source-boundary
regression passed 625 tests. Dashboard verification passed 1,511 tests, formal type checking,
production build, and Biome. Session identity changes replace the query client and remount the
route tree; same-principal permission refresh preserves unsaved drafts.

Real HTTP and production-Dashboard acceptance used an isolated synthetic database and a configured
loopback platform administrator. It exercised grant, role change, revocation, immutable receipts,
conflicts, and audit history. Exactly two fixture membership tombstones and six audit entries were
created; all seven original business tables retained their complete row digests. No GitHub service
was configured and no repository PR/Issue was written. The temporary API and tunnel were stopped
and their ports released. See the [acceptance report](../../artifacts/m19-access-20260907/REPORT.md)
and [browser record](../../artifacts/dashboard-e2e/m19-verification.json).

The connected browser exercise used only the configured platform administrator. Lower-role
authorization and session switching have automated unit/integration coverage, but real lower-role
browser sessions and an actual OIDC provider were not exercised by this fixture.

This grants access to Operator surfaces, not a separate untrusted-executor security model.
Registered Workers and Server internal services retain their documented trusted roles. Private
repository checkout credentials, finding disposition, publication authorization,
repository execution quotas, and complete real-project acceptance remain separate work.

An OIDC deployment upgrading from M18 must explicitly identify its platform administrators before
starting the new Server. Existing data is migrated without deriving grants from old login or audit
records. Use a configured platform administrator to assign repository memberships after startup.
