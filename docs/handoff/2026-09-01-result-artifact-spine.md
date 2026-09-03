# Result Artifact Spine Handoff

Status date: 2026-09-01

Branch: `codex/artifact-spine`

Base commit before this slice: `3e1dd27700a5d9ce5b032aec09c911f9087ccf72`

This branch is intentionally independent from the unverified RoleConfig v2 candidate on `main`.
Rebase or merge it only after both candidates have completed their remote verification matrices.

## Completed Scope

This first logical group implements only contracts, migration, and the SQLite artifact state
machine. It does not implement HTTP routes or filesystem storage.

- Result artifacts only, with a 2 MiB total ceiling.
- Chunks are limited to 256 KiB and an upload is limited to eight chunks.
- Public TypeBox contracts use lowercase UUIDv4 client artifact IDs, exact media type
  `application/json`, canonical SHA-256 digests, bounded names, and canonical unpadded base64url.
- The base64url helper rejects non-zero trailing pad bits that the schema pattern alone cannot
  distinguish.
- `artifact_uploads` records one durable upload identity and a monotonic chunk cursor.
- `artifact_upload_chunks` records stable prepare receipts and immutable committed receipts.
- `run_artifacts` records the immutable published result artifact identity and content-addressed
  object key.
- Create, prepare chunk, commit chunk, prepare finalize, commit finalize, and terminate operations
  run in `BEGIN IMMEDIATE` transactions.
- Every operation, including exact replays, validates the complete active lease fence: job,
  attempt, worker node, worker instance, lease generation, token hash, attempt and job state, three
  deadlines, current attempt ownership, and worker supersession state.
- The database never stores artifact bytes, raw lease tokens, or duplicate lease-token hashes in
  artifact tables.
- Chunk and finalization identity is stable across exact retries. Changed metadata is a conflict.
- `terminateArtifactUpload` permits only active-lease-fenced `receiving` or `finalizing` uploads to
  become `abandoned` or `corrupt`. Exact terminal replay returns the original timestamp; changed
  disposition and committed artifacts are rejected.
- SQL triggers enforce canonical initial state, cursor advancement from committed receipts,
  finalization completeness, immutable terminal tombstones, immutable run artifacts, legal status
  transitions, canonical reason codes, and cross-table identity consistency.

## Frozen Candidate

Two independent static reviewers examined the same final eight-file snapshot and reported no
P0-P2 findings.

```text
8f2925c62ded40c0228481bd85821db1cec8237191cc4928e129ffd12999c287  apps/server/src/database/artifacts.ts
9c1ccf75e886359de493c8920c3316de4bc770f774d96941c602cdbd2df9761a  apps/server/src/database/artifacts.test.ts
036b8e4fcaeabf75b333bebab392cf12303bf2db60feba40914130ccab01518a  apps/server/src/database/database-worker.ts
74ca39f42cdf4e8ffee74586c6007c6ed4ec6e1d8478d311c9035fe5b548cbe9  apps/server/src/database/errors.ts
e88d23e800ab05c5def2743adb42310ef3ff8763f5352d40d67ad5abfe863255  apps/server/src/database/protocol.ts
c4f2d87d99d1ec9777d7b42034019b60a9fc8a5bc050ac913ff4f124732d1774  migrations/0008_result_artifacts.sql
9ac47151fc4dc6444d2d82483abacbfd8e8c10d0237335e3ae893f089861c299  packages/contracts/src/artifacts.ts
b5ec1e3a50525a2228979cf5b73afb423c804822c94f4dede91117e3d8f7944b  packages/contracts/src/index.ts
```

Biome was used only to format the edited files. `git diff --check` passed.

## Verification Blocker

No test or build was run for this candidate. Repository policy forbids local validation without
explicit authorization, and `ssh test-env` timed out while connecting to `10.0.1.20:22`. There was
no local fallback.

At minimum, run this branch on `test-env` before merge:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

The focused database tests are in
`apps/server/src/database/artifacts.test.ts`. Also run the full Server migration and database-client
suites because migration 0008 changes the durable schema and database Worker protocol.

## Required Next Group

Implement the filesystem and transport group without weakening the frozen database invariants.

1. Add a private artifact storage root with separate staging and immutable object namespaces.
2. Add Worker HTTP routes for create, chunk upload, finalize, and explicit termination. Worker
   identity must come from the authenticated per-node Bearer Token mapping, not a request-body
   override. The Server stores only the Token hash and requires an `active` Worker node.
3. Preserve the two-phase order:
   `DB prepare -> durable staging write -> DB commit` for each chunk.
4. Preserve the final order:
   `DB prepare -> full size and SHA-256 verification -> durable immutable publication -> DB commit`.
5. Publish objects at `sha256/<first-two-hex>/<digest>` without replacement. Use a same-directory
   temporary object, file synchronization, an atomic no-replace publication strategy, and directory
   synchronization. Exact retry must verify an existing object before reusing it.
6. Serialize file operations per upload in the Server process so concurrent exact retries cannot
   race one staging descriptor.
7. Handle crashes after every boundary. A published object with an uncommitted DB finalization must
   be safely reusable; committed chunk receipts must never outrun durable staging bytes.
8. Extend the lease reaper with Server-authoritative cleanup for uploads whose lease is already
   invalid. Do not reuse `terminateArtifactUpload`, which intentionally requires an active presented
   lease.
9. Retry failed staging cleanup from durable state or a bounded storage scan. Do not delete immutable
   objects as part of upload cleanup.
10. Require a committed result artifact before the new completion path can succeed. Keep the legacy
    inline completion behavior explicitly versioned until Worker migration is complete.
11. Return public artifact contracts without exposing `storageObjectKey` or server filesystem paths.
12. Map `ARTIFACT_UPLOAD_CONFLICT` and storage-integrity failures to stable, non-retryable worker API
    responses; continue mapping lost lease authority to `lease_lost`.

## Security Notes

- Treat all request identifiers and filenames as untrusted even though contracts are strict.
- Derive every path from validated server-owned IDs or lowercase digests; never join a client path.
- Reject symbolic links, reparse-point paths, hard links, unexpected file types, identity changes,
  permissive modes, and containment escapes.
- Open staging and temporary files with create-new and no-follow semantics where the platform
  supports them, then validate the open descriptor and path identity.
- A lease can expire during file I/O. The second DB phase must re-check the full lease and is the
  authority for whether the staged or published bytes may become committed state.
- Published content-addressed bytes can outlive a failed DB commit after a crash or lease loss; they
  are harmless only if publication is immutable and an exact retry verifies the full object.
- Do not make SQLite state claim that a file operation succeeded before that operation is durable.

## Deferred Product Work

- Worker-side upload client and execution-result wiring.
- Dashboard artifact counts, status, and authenticated download/read views.
- Immutable server-side diff manifests.
- Digest-bound approvals, GitHub outbox reconciliation, and publication writes.
- Retention and garbage collection for unreferenced content-addressed objects.
