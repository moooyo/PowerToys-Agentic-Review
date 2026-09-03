# Worker Token Recovery Exercises

## Scope

This runbook covers the four expected operational recovery cases for the per-Worker Bearer Token
profile selected by ADR 0025:

- a successful create response whose plaintext Token was not retained;
- a successful rotate response whose plaintext Token was not retained;
- Worker credential revocation; and
- restoration of an older database backup.

The database-backup exercise covers only the Worker credential consequences of a whole-Server
database rollback. It is not a complete Server disaster-recovery procedure and does not establish
that jobs, attempts, leases, operator sessions, GitHub polling state, artifact metadata, or artifact
storage are ready to resume.

The Server database is the credential authority. It stores only the Token SHA-256 digest and cannot
replay plaintext from a completed create or rotate operation. Recovery uses the existing roster,
rotation, and revocation operations. It does not use a receipt, certificate, recovery key,
anti-rollback service, or separate credential authority.

## General rules

1. Never place a Token in a URL, log, ticket, chat message, display name, or database query.
2. Provision a create or rotate Token together with its matching `workerNodeId` by running
   `deploy/worker/split/provision-worker-auth.ps1 -WorkerNodeId <workerNodeId>` and pasting the Token
   only into its secure prompt. Do not place the Token in a command argument or pipeline. The script
   writes the fixed path with the required field order, UTF-8 without BOM, and no trailing newline;
   do not handwrite an alternate JSON form. Before invoking it, the split installer must have
   created the exact Control data-root inheritance profile, the caller must hold
   `SeRestorePrivilege`, and provisioning calls must be serialized. If those prerequisites or the
   production installer are unavailable, credential installation remains blocked.
3. When a mutation response is uncertain, refresh the credential roster before choosing the next
   operation. Do not infer the Server state from the browser error alone.
4. Rotation has no overlap. After a successful rotation, the prior Token is invalid for subsequent
   requests.
5. Revocation is terminal for that Worker node identity and is safe to retry.

## Exercise 1: create response loss

Simulate a connection failure after the Server commits credential creation but before the operator
retains the plaintext Token.

1. Refresh the Worker credential roster.
2. If the intended pending Worker is absent, submit one new create operation. Retain the
   `workerNodeId` and Token from that successful create response and provision them together.
3. If the pending Worker is present, do not attempt to recover its original Token. Select that
   roster record, rotate it using its current `updatedAt` value, and retain the Token from that
   successful rotation response.
4. Provision the Token from the branch taken above with its matching create-response or roster
   `workerNodeId`, then start or restart the Worker.
5. Verify that the Worker registers and the roster changes from `pending` to `active`.

Checking the roster before creating again avoids leaving an unnecessary second pending Worker node.
The recovery rotation invalidates the unretained Token from the completed create operation.
Display names are not unique. If several new pending records are plausible and there is no
unambiguous pre-operation roster snapshot or Worker node ID, revoke every ambiguous record and
create one clean replacement instead of guessing which Token belongs to the intended machine.

## Exercise 2: rotate response loss

Simulate a connection failure after a rotation commits but before the operator retains its
plaintext Token.

1. Treat the Worker's current local Token as potentially invalid. Do not repeatedly restart it.
2. Refresh the credential roster and read the record's new `updatedAt` value.
3. Rotate the same Worker again with that current `updatedAt` value.
4. Retain only the Token returned by this second successful rotation and provision it with the same
   `workerNodeId` into the fixed local Worker configuration file.
5. Restart the Worker and verify active registration.

A retry that uses the stale pre-rotation `updatedAt` value fails with the credential-conflict
response. The second successful rotation invalidates both the pre-rotation Token and the unretained
Token from the first rotation.

## Exercise 3: revocation

1. Revoke the Worker from the Dashboard.
2. If the response is uncertain, submit the revoke operation again. The retry returns the same
   terminal `revoked` state without changing its lifecycle timestamps.
3. Refresh the roster and verify `revoked`.
4. Verify that subsequent Worker authentication fails and that rotation of the revoked identity is
   rejected.
5. If the machine must return to service, create a new Worker node identity and install its new
   Token. Do not attempt to reuse the revoked identity.

Revocation affects authentication performed after the revocation transaction. It does not cancel a
request that already passed authentication or replace lease-token fencing.
The terminal rule applies to forward transitions in the current database history. Restoring an
older whole-database snapshot replaces that history and can therefore restore a pre-revocation
state without performing a `revoked -> active` transition.

## Exercise 4: database-backup rollback

ADR 0025 intentionally accepts credential rollback with database rollback. A restored backup may:

- make the Token captured in the backup valid again;
- invalidate a Token created by a later rotation;
- revive a Worker that was revoked after the backup was taken;
- remove a Worker node created after the backup was taken.

This runbook supports only a backup from the current schema version 12 with the exact current
migration filenames and checksums. It does not support cross-version restore, migration during
restore, the retired schema version 13, or a database produced by an older unreleased build. Rebuild
the Server database and recreate required Worker credentials when the backup is not an exact current
schema backup.

The repository does not provide a database restore API or CLI. For an in-place restore, perform the
following storage operation:

1. Stop the Workers and Server and confirm that the Server database process has exited.
2. Before deleting anything, copy the current database and every existing SQLite `-wal`, `-shm`,
   and `-journal` sidecar together to a retained location outside the active data directory. Keep
   that directory owned by the Server identity at mode `0700` and every retained file at mode
   `0600`. A verified standalone SQLite backup with the same private ownership may be retained
   instead.
3. Only after that complete retention step, remove the sidecars from the active data directory.
4. Verify that the selected backup is the exact current schema version 12, then replace the database
   file. Keep the data directory at mode `0700`, restore the database file to mode `0600` with the
   Server owner, and retain the current `.agentic-review-database-initialized` marker.
5. Before starting the Server, configure the built-in recovery boundary:
   - set `AGENTIC_REVIEW_RECOVERY_MAINTENANCE=true` exactly;
   - set `AGENTIC_REVIEW_HOST` to `127.0.0.1`, `::1`, or another accepted loopback spelling;
   - keep operator authentication configured;
   - remove the ordinary reverse-proxy upstream and remove any container published port for this
     Server; and
   - permit access only from the designated local recovery terminal or through an SSH tunnel whose
     Server-side destination is the loopback listener.
   Do not expose the recovery listener through a reverse proxy, load balancer, container port, or
   ordinary network interface. Stopping managed Workers is insufficient because external holders
   of a restored Worker Token could otherwise attempt authentication.
   For production OIDC, preserve the registered `AGENTIC_REVIEW_PUBLIC_ORIGIN` through a local
   hosts/DNS mapping and the SSH tunnel to the loopback listener; do not restore the ordinary
   reverse-proxy upstream merely to complete the callback. For a container, the tunnel endpoint
   must run in the same network namespace or the Server must use host networking. Ordinary bridged
   container networking is not a supported recovery topology.
6. Keep the existing `.agentic-review-database-initialized` marker, then start the Server. Every
   maintenance start atomically deletes restored operator login transactions, sessions, and browser
   bindings before the listener opens, while preserving the operator authentication clock
   high-water mark. Maintenance uses a database-only storage runtime and does not open, enumerate,
   create, or reconcile the artifact root. Confirm that `/health/live` returns 200,
   `/health/ready` returns 503, and a Worker endpoint returns 503 with `worker_api_maintenance`.

Do not combine the restored database with newer SQLite sidecars. Restoring into a new data directory
is not supported by this runbook or the current public tooling because a backup does not contain the
current initialization marker. There is no legacy-adoption authorization, fallback, or public
adoption CLI. A nonempty database without the current marker is rejected and must be rebuilt; do not
invent an authorization file or bypass.

After startup:

1. Start a new operator login. Restored operator cookies are invalid because maintenance startup
   purged their database sessions before listening.
2. Treat the restored credential roster as authoritative. A Windows Worker configuration is not
   rolled back with the database, so a later local Token may immediately receive HTTP 401.
3. For every externally recorded post-backup revocation, revoke the node only when it is still
   present in the restored roster. If it is absent, leave it absent and do not recreate it merely to
   replay the revocation.
4. Recreate only required non-revoked Worker nodes that were created after the backup.
5. Before restoring Worker traffic, rotate every restored `pending` or `active` Worker, install each
   newly returned Token in its Windows local configuration, and restart that Worker.
6. Verify the intended `active` and `revoked` roster states.
7. Complete the independent whole-Server database, job, lease, artifact-metadata, and artifact-storage
   consistency recovery procedure before authorizing work dispatch. Completing this Token runbook
   alone is never sufficient to resume dispatch.
8. Only after credential reconciliation and the independent whole-Server consistency procedure
   have both completed, stop the maintenance Server, set
   `AGENTIC_REVIEW_RECOVERY_MAINTENANCE=false`, restore the normal listener and approved ingress,
   and start the Server in normal mode. Do not expose the maintenance process itself by restoring
   the reverse-proxy upstream or container published port around it.

If no approved whole-Server consistency recovery procedure exists, or any part of it cannot be
completed, keep work dispatch blocked. The Server supplies the Worker API fence, readiness state,
GitHub ingestion/polling and lease-reaper suppression, restored-session purge, and a database-only
runtime that leaves the artifact tree untouched. This mode is not a replacement for restoring and
validating a coherent database and artifact set before normal mode resumes. The deployment still
owns the required loopback-only topology; if the reverse proxy, published port, or ordinary network
listener cannot be removed, keep database recovery blocked. Container recovery is supported only
for host-network processes or a trusted local tunnel sidecar in the same network namespace;
ordinary bridged-container recovery is unsupported, and a published port is not an acceptable
shortcut.

These post-restore rotations are an operational reconciliation step. They do not add an
anti-rollback epoch or change the accepted local trust model.
A reliable external post-backup change record makes revocation reconciliation complete; the
restored database cannot reconstruct changes that are absent from its snapshot.

## Automated evidence

The database state-machine recovery matrix is implemented in
`apps/server/src/database/worker-token-recovery.test.ts`. It uses the real `DatabaseClient` and
database Worker operations. It does not inject a transport-level network failure. The maintenance
boundary is covered by `apps/server/src/recovery-maintenance.test.ts`, and the atomic purge,
rollback, clock preservation, restart, old-cookie rejection, and fresh-login behavior are covered
by `apps/server/src/database/operator-auth-recovery.test.ts`. The operator route suite separately
proves one-time plaintext responses and `no-store` headers. The backup case restores a clean,
closed current-schema SQLite snapshot so that the test isolates credential rollback behavior.
Backup creation and retention are deployment responsibilities; the Server does not create an
automatic migration backup or maintain a data-directory backup namespace.

Run from the repository root on Linux, or from a local WSL repository copy stored on its native
Linux filesystem:

```bash
pnpm --filter @agentic-review/server build
pnpm --filter @agentic-review/server exec vitest run \
  src/recovery-maintenance.test.ts \
  src/database/operator-auth-recovery.test.ts \
  src/database/worker-token-recovery.test.ts
```

Running `worker-token-recovery.test.ts` and the database Worker restart case directly on Windows
skips those cases because the production Server database owner checks require POSIX filesystem
ownership. The configuration, route, health, direct atomic-purge, and rollback tests run on
Windows. A checkout mounted from NTFS into WSL is not a substitute for a native WSL filesystem copy
and does not count as database Worker recovery verification.

The five current-schema Worker Token recovery tests plus the maintenance and operator-auth recovery
set must pass before a Token-authenticated production rollout or after changing Worker credential or
operator-session persistence semantics.
