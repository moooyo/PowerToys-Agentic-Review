# Configuration audit reads

## Purpose and recorded history

M23 makes existing configuration audit records available to operators without changing their
meaning. Repository activity includes repository configuration snapshots, repository prompt
bindings, and validation profile publication/binding metadata. Platform administrators can inspect
global prompt creation, draft saves, publication, bootstrap registration, and default bindings.

Repository events retain the complete `ManagedRepository` snapshot written with that operation.
The event timestamp equals the snapshot's `updatedAt`; the current repository row can subsequently
change connection status or display metadata without creating a configuration revision. The UI must
not substitute that current row for the recorded snapshot or attribute those later changes to the
recorded actor. Discovered repositories and older backfilled rows need not have a creation event.

Prompt events retain operation metadata, including relevant immutable version IDs. Old unpublished
draft bodies, digests, and before/after differences were not recorded. A draft-save event therefore
shows revision metadata only. Published prompt/profile content remains available through the
existing immutable version APIs. Current template names and draft content are not historical facts.

## Scope and authorization

| Endpoint | Required authority | Read scope |
| --- | --- | --- |
| `GET /api/v1/operator/repositories/:repositoryId/configuration-audit` | Repository `read` | Both audit tables restricted to the exact repository |
| `GET /api/v1/operator/repositories/:repositoryId/configuration-audit/:source/:eventId` | Repository `read` | Exact repository, source, and event ID |
| `GET /api/v1/operator/configuration-audit` | Platform administrator | Prompt audit records with a null repository ID |
| `GET /api/v1/operator/configuration-audit/:eventId` | Platform administrator | Exact global prompt event |

Authentication uses the existing operator session. The explicit database operation allowlist and
the read model both enforce authority. A repository administrator is not implicitly a platform
administrator. Membership audit remains a separate `manage_access` capability and is not merged
into this timeline. Invisible repositories return opaque 404 responses. A missing event within an
authorized scope also returns 404, without revealing whether it exists elsewhere.

The global list accepts an optional `templateId`. Template operations match their recorded entity
ID; global binding/bootstrap operations match the immutable target prompt version's template.
Repository overrides remain excluded even when they reference the selected global template.

## Read contract and consistency

Lists default to 20 rows and accept at most 20 rows per page. Pages are positive integers bounded
at 10,000,000. Responses are capped at 2 MiB. Repository snapshots are capped at 2 MiB; prompt
operation payloads retain their existing 16 KiB limit. List responses contain metadata only and
do not load repository snapshot JSON. Prompt lists load bounded metadata to validate their action,
version, and immutable references.

Count and page reads share one SQLite read transaction. Ordering uses the recorded timestamp text
descending, source ascending, and ID descending. The `(source, id)` pair is the row identity: the
two historical tables can contain the same ID. Tie ordering is deterministic pagination, not an
assertion about causality. System clock rollback does not invalidate an otherwise legitimate
event; no monotonic timestamp sequence is inferred.

Details expose a strict action-specific snapshot. Metadata, actor identity, timestamps, snapshot
identity/revision, and related immutable version/binding ownership are checked. Binding rollback
and rebinding the same version remain valid operations. A malformed repository snapshot prevents
reading that detail but does not suppress its valid list metadata. Errors do not echo raw stored
payloads. The HTTP and Dashboard boundaries independently reject inconsistent scope, pagination,
ordering, duplicate row identities, and event/detail mismatches.

## Migration and retained data

Migration `0023_configuration_audit_reads.sql` rebuilds only the two audit tables as
`STRICT, WITHOUT ROWID`, preserving the original columns, constraints, foreign keys, and stored
values. It restores existing immutable update/delete triggers and indexes, adds explicit duplicate
ID insert guards, and adds a repository index to prompt audit. This closes rowid alias and replace
paths without rewriting historical JSON or inventing missing events. Migration and ledger writes
remain one transaction with foreign keys enabled. Binding/version history tables are untouched.

## Dashboard behavior

Repository details contain configuration activity. Prompt management contains global activity and
a template-specific view. An event opens its recorded actor, operation, revision, scope, and retained
snapshot. Sample mode explicitly reports that audit history is unavailable.

Query and component identities include service mode, exact principal, authentication epoch,
repository/global scope, and the selected event. Refresh, permission checks, errors, and session
changes hide cached data. Responses from abandoned requests cannot populate the active session.
Published content and current editable drafts retain their separate existing interfaces.

## Acceptance boundaries

Contract, route, read-model, migration, and real database-worker RPC tests cover the boundary.
Migration tests preserve raw text bytes and verify transactional rollback, foreign keys, duplicate
IDs, UPSERT/REPLACE, and rowid aliases. RPC tests cover repository viewer access, cross-repository
denial, platform authority, revocation, and unchanged configuration/history after reads.

Connected UI acceptance uses a fresh isolated Linux database, a loopback operator identity, the
production HTTP routes, and the built Dashboard. It does not establish deployed OIDC or production
repository acceptance. No GitHub client, publisher, model, or external PR/Issue write is needed.
The user's external-write restriction in [AGENTS.md](../../AGENTS.md) applies to every test harness.
