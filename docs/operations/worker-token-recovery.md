# Worker Token Recovery

## Scope

This runbook covers the node-scoped Worker Bearer Token selected by ADR 0025:

- loss of the plaintext create response;
- loss of the plaintext rotate response;
- Worker revocation; and
- restoration of an older whole-database backup.

The Server stores only a SHA-256 digest of each Token. It cannot recover plaintext after the create
or rotate response has been lost.

## Local credential file

From an elevated PowerShell session at the repository root, provision the matching `workerNodeId`
and Token together at the fixed Worker path:

```powershell
.\deploy\worker\provision-worker-auth.ps1 `
  -WorkerNodeId 'worker:<uuid>' `
  -WorkerIdentity 'CONTOSO\AgenticReviewWorker'
```

The script prompts for the Token with masked input, writes canonical UTF-8 JSON without a BOM or
trailing newline, removes inherited ACLs, and grants access only to the Worker identity, `SYSTEM`,
and local administrators. Replace the example identity with the account that actually runs the
Worker. Do not put the Token in a command argument, URL, log, ticket, chat message, or display name.

## Create-response loss

1. Refresh the Worker roster.
2. If the intended pending Worker is absent, create one new Worker and retain both returned values.
3. If it is present, rotate that exact Worker using its current `updatedAt` value. The old unretained
   Token becomes invalid.
4. If several pending records are ambiguous, revoke all ambiguous records and create one replacement.
5. Write the new Token and matching `workerNodeId` to the fixed file, restart the Worker, and verify
   that the roster becomes `active`.

## Rotate-response loss

1. Treat the local Token as invalid and stop restart loops.
2. Refresh the roster and read the Worker's current `updatedAt` value.
3. Rotate the same Worker again with that value.
4. Retain only the Token returned by the second successful rotation.
5. Replace the local credential file, restart the Worker, and verify active registration.

Rotation has no overlap window. A stale `updatedAt` produces a conflict instead of silently
overwriting a newer rotation.

## Revocation

1. Revoke the Worker from the operator API or Dashboard.
2. If the response is uncertain, retry the same revoke; revocation is idempotent.
3. Verify the roster is `revoked` and subsequent Worker authentication fails.
4. To return the machine to service, create a new Worker node identity and install its new Token.

Do not reuse a revoked identity. Revocation does not replace lease-generation fencing for a request
that authenticated before the revocation transaction committed.

## Whole-database rollback

ADR 0025 accepts credential rollback together with a database rollback. Restoring an older snapshot
can restore an older Token, undo a later revocation, or remove a Worker created after the snapshot.

This procedure supports only an exact backup of the current schema version 8 with the current
migration filenames and checksums. There is no cross-version restore or migration compatibility
promise for this pre-release system.

1. Stop every Worker and the Server. Confirm the SQLite owner process has exited.
2. Retain the current database plus any `-wal`, `-shm`, and `-journal` sidecars together outside the
   active data directory before changing anything.
3. Remove active sidecars only after that retention copy is complete.
4. Restore the selected schema-8 database file with the Server owner and private permissions. Keep
   the current `.agentic-review-database-initialized` marker.
5. Configure recovery maintenance:
   - `AGENTIC_REVIEW_RECOVERY_MAINTENANCE=true`;
   - a loopback-only `AGENTIC_REVIEW_HOST`;
   - configured operator authentication;
   - no ordinary reverse-proxy upstream; and
   - no published container port.
6. Start the Server. Confirm `/health/live` returns 200, `/health/ready` returns 503, and a Worker
   route returns 503 with `worker_api_maintenance`.
7. Start a fresh operator login. Recovery startup invalidates restored login transactions, sessions,
   and browser bindings.
8. Treat the restored Worker roster as authoritative. Reapply externally recorded revocations,
   recreate only required missing Workers, and rotate every restored `pending` or `active` Worker.
9. Install every newly returned Token on its matching Windows node.
10. Independently verify database, job, result, lease, GitHub polling, and Worker-roster consistency.
11. Stop the maintenance Server, set `AGENTIC_REVIEW_RECOVERY_MAINTENANCE=false`, restore approved
    ingress, and start normal service only after reconciliation is complete.

Do not combine a restored database with newer SQLite sidecars. A nonempty database without the
initialization marker is rejected; rebuild it instead of inventing an adoption bypass.

For production OIDC, the recovery operator may preserve the registered public origin through a
local hosts/DNS mapping and an SSH tunnel to the loopback listener. Do not restore public ingress
only to complete an OIDC callback. A loopback-auth deployment does not need OIDC for this procedure.

## Automated evidence

The recovery state machine is covered by:

- `apps/server/src/database/worker-token-recovery.test.ts`;
- `apps/server/src/recovery-maintenance.test.ts`; and
- `apps/server/src/database/operator-auth-recovery.test.ts`.

Run these checks on a native Linux filesystem with the repository's required Node.js and pnpm
versions. The production database owner checks intentionally do not use Windows SQLite ownership
semantics.
