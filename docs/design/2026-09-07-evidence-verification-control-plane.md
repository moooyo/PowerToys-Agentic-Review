# Evidence Verification Outside the SQLite Control Plane

Status: implemented and wired through the SQLite owner, completion/finalization APIs, and prepared run projections. Linux concurrency/lifecycle integration checks have passed; the implementation ledger records the final suite and Dashboard acceptance status.

## Problem and invariant

The previous Run detail path verified every referenced asset synchronously inside the sole DatabaseWorker. A run can have 32 requests with 128 MiB of assets per attempt: one details query could read 4 GiB and feed 8 GiB into chunk and whole-file SHA calculations. Active run details refreshed every five seconds. That work blocked lease heartbeats and cancellation handling while the query held a transaction. These are code-derived bounds, not measured latency results.

Downloads already hash only overlapping chunks. Keep their bounded range validation; they do not rehash an entire trace for each response chunk.

SQLite retains one owner. The new verifier has no database connection, mutation authority, lease tokens, credentials, or arbitrary-path API. No SQLite transaction may span a verifier await. Cache misses must never initiate a synchronous whole-run scan.

## Minimal module boundaries

| Module | Responsibility |
| --- | --- |
| `database/evidence-files.ts` | Shared Linux file checks and bounded reads. Separate owner-only initialize/recover/write operations from read-only opens. Read-only opens verify the storage key, root identity, private permissions, regular files, single links, containment, and `O_NOFOLLOW`; they never create directories or call `fsync`. |
| `database/evidence-verification-worker.ts` | One dedicated read-only Worker. Hash files with a reusable 512 KiB buffer; check each stored chunk and the final digest; parse at most 512 KiB of steps JSON and compare it with the supplied frozen scenario and capture policy. Return compact attestations, never screenshot/trace bodies. |
| `database/evidence-verification-client.ts` | Private MessagePort, bounded priority queue, request deduplication, cancellation, worker lifecycle, and bounded attestation cache. No SQLite access. |
| `database/evidence-verification.ts` | SQLite-owner orchestration: build authorized snapshots, await the verifier outside transactions, then revalidate and admit attestations. Supplies the existing completion and read-model policies with verified facts. |

Existing evidence uploads, scope checks, SQL triggers, and immutable result validation remain authoritative. Extract existing filesystem checks instead of maintaining divergent copies.

Expose owner-only prepare/admit pairs such as `prepareEvidenceFinalization` / `commitEvidenceFinalization` and `prepareValidationCompletion` / `commitValidationCompletion`. Prepared values are internal opaque records, not public inputs. A prepare call returns a frozen dependency snapshot and never opens a transaction that its caller must keep alive.

## Internal API and snapshot

```ts
interface EvidenceVerifier {
  verifyAsset(snapshot: AssetVerificationSnapshot, signal: AbortSignal): Promise<AssetAttestation>;
  verifyScenario(snapshot: ScenarioVerificationSnapshot, signal: AbortSignal): Promise<ScenarioAttestation>;
  probeIdentities(snapshot: IdentityProbeSnapshot, signal: AbortSignal): Promise<IdentityAttestation>;
  close(): Promise<void>;
}
```

The owner derives snapshots from the authenticated operation and frozen rows. An asset snapshot contains a request nonce, storage key and canonical root identity, opaque asset ID, upload/final state, complete repository/run/request/job/attempt/profile/check scope, manifest digest, expected size/SHA, device/inode, and ordered chunk offset/size/SHA tuples. It contains no client-supplied filesystem path. Scenario snapshots additionally bind the result digest, plan digest, frozen scenario/policy digest, target, check outcome, steps asset, and referenced screenshot/trace manifests. Scope checks happen before sending work, not only after it returns.

Attestations echo the nonce and snapshot digest and include descriptor and named-file identities before and after verification, including device/inode, size, ctimeNs, mtimeNs, mode, owner, and link count. The verifier rejects changed identities, absent bytes, truncated reads, extra/missing chunks, digest mismatches, invalid UTF-8/JSON, and mismatched scenario observations. The owner accepts responses only from its verifier's private port and only for a matching pending snapshot. Internal attestations are never accepted from a Worker HTTP request or model output.

## Narrow asynchronous dispatch

Keep ordinary database operations synchronous. Permit promises only for `finalizeEvidenceUpload`, V2 `completeLease`, evidence-aware run detail/result queries, and shutdown. The message callback must resolve each request independently; it must not await a global request chain. Track pending asynchronous requests explicitly. Synchronous SQLite segments remain non-interleavable, and every await boundary asserts `database.isTransaction === false`.

**Finalization:** in a short transaction, validate the live lease and fully committed upload, then snapshot its manifest/chunks. Verify outside the transaction. Re-enter an immediate transaction and repeat lease/generation/worker/cancellation/deadline, manifest, offset, retention, and file-identity checks. Only then rename, perform the existing durability barriers, and commit finalized state. Rebind the verified identity after the owner-controlled rename, which can change ctime. A verifier response for an expired or superseded lease never authorizes finalization. Existing rename-before-commit recovery remains supported.

**Completion:** first validate the canonical result's structure and frozen execution identity and collect its evidence dependencies, without claiming evidence completeness. A missing/non-finalized/cross-scope reference is a real invalid reference; a cache miss is not. Await asset/scenario preflight without a transaction. Before committing, rerun the existing complete-lease fence and result checks and recheck every dependency and admitted identity. The synchronous `validateEvidenceReferences` callback consumes matching admitted attestations only; it must not hash files or substitute an unconditional `true`. Same-digest retries can share verification, but each terminal submission independently repeats the fence and existing idempotency rules.

**Reads:** take a short snapshot of the result and dependencies. A warm cache requires a fresh bounded identity probe before reuse; run that probe outside SQLite too. Then recheck the result digest/latest activation/retention and build the projection in a short read transaction. A cold cache queues bounded background verification and returns `evidence_verification_pending`, `evidenceComplete: false`, and ineligible approval. Preserve the stored execution outcome: pending verification is not a failed test or an HTTP 400. Add an explicit pending verification status to detail/result DTOs and poll it even when every job is terminal; the current active/queued-only polling condition is insufficient. A changed snapshot returns pending or retries once, never an unbounded retry loop. Listing run summaries does not verify asset bytes.

## Cache and admission bounds

Cache keys include storage key, canonical root identity, full scoped manifest digest, expected content SHA, device/inode, size, ctimeNs, and mtimeNs. Scenario keys additionally include result, plan, scenario, policy, and dependency-manifest digests. Cache compact verified facts, not parsed 512 KiB documents. A fresh identity probe must cover both the open descriptor and named file, including mode/owner/link count. Retirement and deletion invalidate entries; changed identities fail closed and trigger re-verification. A TTL alone is never sufficient.

Metadata equality is not content equality: a Linux test observed same-tick writes preserving both ctimeNs and mtimeNs. A proof is reusable only if full byte verification began after all relevant timestamps were at least two seconds old, the filesystem is a known local tmpfs/ext4/xfs/btrfs, and wall-clock elapsed time remains consistent with a monotonic clock. This is a conservative policy for those filesystems, not a universal Linux timestamp guarantee. Young or future timestamps, unknown/network filesystems, and unstable clocks produce non-reusable proofs. Clock discontinuities above 250 ms clear and disable the client's positive cache. Re-verification after the stability window is required before reuse; waiting alone never upgrades an old proof.

Every proof carries `verification` facts (`filesystemType`, `startedAtUnixMs`, `finishedAtUnixMs`, `elapsedMonotonicMs`, `clockStable`, `reusable`). A non-reusable proof can serve its current awaited operation, but cannot be saved as a positive result for later reads. Internal `peekAssetAttestation` / `peekScenarioAttestation` expose only unprobed cache state. Callers must still obtain fresh identity probes and revalidate database authority. Current finalization/completion cannot require a positive cache entry to consume their fresh proofs. A filesystem that disables reuse must execute fresh read preflight outside SQLite and deliver that current projection; it must not remain pending forever merely because `peek` always misses.

Use one hashing Worker with asynchronous reads and a yield between 512 KiB chunks so small identity probes are not trapped behind a whole run. Start with one active hash, at most 32 queued asset tasks, eight foreground waiters, 16 background profile trackers, at most 64 assets per identity-probe message, a 1 MiB snapshot-message ceiling, 4,096 chunk tuples per asset, and a 16 MiB/10,000-entry LRU cache. Process a profile's assets incrementally rather than enqueueing all 8,192 possible run assets. Deduplicate repeated polls by scoped result/manifest digest and give completion/finalization priority over background reads without starving admitted background work.

A full queue or verifier timeout yields retryable `evidence_verification_busy`/`evidence_verification_unavailable`, never `unknown evidence`. Use a configurable soft response budget below the deployment's Worker request timeout. Shared verification may finish after a waiter times out and populate the cache, but cannot commit that timed-out submission. Every later retry reacquires authority. Missing bytes, corruption, and scenario mismatch remain distinguishable from queue pressure. Do not allow queue growth proportional to repeated Dashboard polls.

The cache assumes finalized Server files have no authorized writers other than this owner, which only retires/unlinks them; untrusted application execution is on a different Worker host. ctime/mtime probes detect ordinary external modifications and replacements, but are not a defense against privileged filesystem manipulation or silent bit rot without metadata changes. Retain per-download chunk hashing and perform periodic or explicit re-verification through the same bounded background verifier. Restart drops all in-memory attestations: cold reads stay pending while background verification rebuilds them, rather than scanning 4 GiB on the control thread.

## Shutdown and race handling

Shutdown first stops admission and marks the owner draining. Abort background verification and pending foreground preflights; settle their callers with retryable shutdown errors. Await verifier exit within the existing database lifecycle deadline, then terminate it if necessary. Only after pending continuations are unable to enter SQLite may the owner close its scan cursors and database. Ignore late verifier messages; no continuation may post success or mutate SQLite after draining begins. A busy verifier must never delay heartbeat processing before shutdown.

Retention, cancellation, new attempts, newer activations, or file mutation can occur while verification runs. Recheck them after every await and before cache admission or result projection/commit. A pinned read descriptor does not make a retired asset available. Identical bytes in another repository, profile, check, attempt, or storage root never share authorization.

## Acceptance tests

- A deliberately paused verifier does not block heartbeat, cancellation, or an unrelated database read; no transaction survives an await. Use a tiny fixture and a deterministic verifier barrier, not multi-GiB files.
- Cold run details return pending, enqueue bounded deduplicated work, and never invoke synchronous whole-file hashing. Warm reads use identity probes and reuse the scenario attestation.
- A fully terminal run keeps polling while evidence verification is pending and stops after a verified or unavailable outcome.
- Restart rebuilds verification asynchronously; verifier crash, queue pressure, and timeout return retryable errors without treating valid references as unknown.
- Completion/finalization waiting on verification loses authority correctly on cancellation, expiry, worker supersession, generation change, or retention. Same-digest replay remains idempotent.
- Same-size content mutation, timestamp change, inode replacement, hard/soft links, permission changes, missing bytes, and storage-key/root changes invalidate cached evidence. Restoring bytes requires fresh verification.
- Steps/scenario/policy or referenced-image digest changes invalidate semantic attestations. Preserve both Windows and Web success cases and the 34-reference boundary.
- Shutdown during a paused preflight settles callers, observes or forces verifier exit, closes SQLite last, and rejects late responses.
- Read-only opens perform no creation or `fsync`; write/recovery durability barriers and bounded range-download integrity tests still pass.
