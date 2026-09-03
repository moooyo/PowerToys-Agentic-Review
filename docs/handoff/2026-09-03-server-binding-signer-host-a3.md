# Dormant Server Binding Signer Host v1 A3 Handoff

> Historical handoff. ADR 0025 supersedes the signer-host provider bridge. Its local verification
> remains historical evidence; no production activation or Linux signer-host matrix will follow.

Status date: 2026-09-03

Branch: `codex/server-binding-signer-host-v1-a3`

Base commit: `e6cd62753986c33ae1235d9b2acc9aea50f5707f`

ADR 0024 governs the complete dormant Linux signer-host transport. This handoff covers A3: the
package-private host-provider bridge and its integration with the ADR 0023 signer and coordinator
ownership model. A1 remains authoritative for the strict protocol and lifecycle reducer. A2 remains
authoritative for the direct-child transport, unavailable host profile, source-excluded fixture, and
process cleanup evidence. ADR 0022 remains authoritative for canonical receipt and active-status
statements and their P-256 P1363 low-S signatures.

## Completed Source Scope

- `server-binding-signer-host-provider-v1.ts` creates the direct client, waits for its verified ready
  state, snapshots the canonical issuer SPKI, and returns the exact frozen seven-member
  `binding-statements-v1` provider. The bridge exposes only receipt-statement signing,
  active-status-statement signing, terminal failure, a synchronous terminal snapshot, and
  idempotent close. It exposes no profile, executable, environment, spawn, key, or generic signing
  seam.
- Startup mismatch and unavailability are normalized into the closed provider-startup error set.
  Failed startup attempts close the direct client before returning an error, and unproved cleanup
  remains unavailable rather than releasing ownership or permitting a replacement.
- The direct client now exposes cleanup proof only to the package-private bridge. Public signing
  rejects promptly after an abort or terminal transition while unsettled raw pipe writes remain
  owned and quarantined. A clean child exit cannot be mistaken for a completed orderly shutdown
  until the buffered shutdown acknowledgement is observed.
- `server-binding-signer-provider-v1.ts` adds only the exact statement-provider shape to the existing
  closed provider union. The production loader remains unchanged and unconditionally unavailable;
  it does not import or instantiate the host-provider bridge.
- `server-binding-signer-v1.ts` accepts the statement-provider shape while preserving the existing
  `preimage-sha256` and `digest-native` byte, hash, signature, and normal error semantics. It passes
  exact canonical S0 statement bytes to the bridge, independently constructs and verifies the
  complete receipt or active-status document, rejects rather than normalizes a high-S
  statement-provider result, and makes invalid or unverifiable statement-provider output terminal.
  Replacement admission is intentionally stricter for every provider kind while prior cleanup is
  unresolved; this closes the existing ownership gap required by ADR 0023 rather than claiming
  literal lifecycle zero-drift.
- Signer contexts now expose one native `terminalFailure` Promise and one synchronous
  `readTerminalError` snapshot. Terminal observation is installed before context publication, uses
  the intrinsic native Promise continuation, latches one stable first cause, and keeps provider and
  raw-operation ownership until close settlement is known. A post-publication uncertain transport
  result maps to `SIGNER_OUTCOME_UNKNOWN`.
- `server-binding-coordinator-v1.ts` installs the signer terminal reaction before its first terminal
  snapshot and before consuming the one-shot database handle. It restores the handle if signer
  adoption fails, checks terminal state across construction and open races, and maps
  `SIGNER_OUTCOME_UNKNOWN` to terminal `PERSISTENCE_OUTCOME_UNKNOWN` without issuing a positive
  authority result.
- Focused tests cover the bridge facade, startup cleanup, fake-process and real-child composition,
  canonical receipt and active-status inputs, invalid signatures, intrinsic Promise observation,
  reentrant close and admission, terminal failure before and during adoption and initialization,
  ready and signing failures, close races, and prompt abort while raw pipe settlements remain
  quarantined.
- Architecture guards pin the exact host-provider consumer set, provider-to-signer-to-coordinator
  terminal chain, top-level exports, imports, normalized source digests, fixture exclusion, and
  production reachability. The new host-provider module has zero production consumers.

## Dormant Production Boundary

A1, A2, and the A3 bridge are now present as a dormant source candidate, but they grant no
production authority:

- `loadProductionServerBindingSignerProviderV1()` still throws unavailable and has no branch that
  constructs the host-provider bridge;
- the host-profile and trust-profile production loaders remain unavailable;
- the host-provider module is package-private, has zero production consumers, and is unreachable
  from `main.ts` and the composed Server runtime;
- production configuration has no signer-host executable, working directory, key backend, trust
  key, credential, environment, or deployment input;
- no route, database migration, Worker-auth resolver, Claim, lease, slot, package, installation, or
  execution path consumes the bridge; and
- a fresh database remains uninitialized, while retained S1 state still fails closed without a
  future exact production signer and compiled trust descriptor.

The test fixture, its private key, local child launch, successful ready message, signature, and
cleanup result are test evidence only. None is a production signer, trust root, Worker identity, or
execution-enablement signal.

## Frozen Source Digests

Normalized LF SHA-256 values:

```text
241be9daea4c9ec2c0f80b672334746a3a775076b008684dd6275361e47453c5  apps/server/src/enrollment/server-binding-signer-host-client-v1.ts
f909d28905a5871d1320ddbbdee5929c4df8c653f4d271880ac246d03674fd2c  apps/server/src/enrollment/server-binding-signer-host-provider-v1.ts
1bfe67b23d9693a9e4b7e6024c84d11ec018b03d5f744a529d989488e243da71  apps/server/src/enrollment/server-binding-signer-provider-v1.ts
137f70492faf070484c81ab8262b6090c5ec5cc4f0708b87ec9ebf28d9a33ed5  apps/server/src/enrollment/server-binding-signer-v1.ts
db571ab2313277b3a75fc5997b12efa0174aa6e8552dc5c00dd06cd14713e902  apps/server/src/enrollment/server-binding-coordinator-v1.ts
```

## Verification

Local verification was explicitly authorized. No command is required on `test-env` for this task.

The exact local A3 candidate completed the following verification:

```text
Focused A3 matrix:            153/153 passed across 9 files
All-workspace typecheck:      passed
All-workspace build:          passed
All-workspace lint:           passed; Biome checked 323 files
Built-output marker scan:     passed; 4/4 fixture and private markers absent
Independent P0-P2 review:     no remaining findings
```

The local runtime was Node 26.1.0 while the repository requires `>=24.20.0 <25`, so pnpm emitted an
engine warning. The complete all-workspace test suite was not rerun for A3; the focused matrix above
is the final local test evidence for this slice.

Windows-local verification may establish codec behavior, generic Node child-process behavior,
bridge composition, and production unreachability. It is not Linux evidence. ADR 0024's mandatory
Linux matrix remains deferred for the exact final candidate, including signal delivery, process
reaping, UID/GID and capability behavior, executable and ancestor ownership, cgroup containment,
uninterruptible D-state, and parent-death cleanup.

## Deferred Work

1. Run the exact integrated A1+A2+A3 candidate on Linux and record the mandatory real-child spawn,
   signal, exit, stdio-close, forced-kill, quarantine, and no-descendant verification matrix. Until
   that evidence exists, do not describe the complete ADR 0024 A stage as verified or complete.
2. Review B independently before activation. B must freeze the protected production key backend,
   compiled signed trust, signed executable and protected paths, credential identity, deployment
   supervision, cgroup or parent-death policy, rotation, backup, restore, audit, and compromise
   procedures.
3. Keep the production provider loader unavailable and keep the bridge out of `main.ts` until B
   defines the shutdown, unproved-exit, owner-lock, restart, and release-composition policies.
4. Keep S2 enrollment, confirmation, active-status, recovery, and revocation routes separate. No
   Worker authentication, Claim, lease, slot, package, installation, or execution authority may
   consume binding state before those reviews and required native evidence complete.

A3 completes the dormant source bridge between the A2 direct client and the existing S1
signer/coordinator ownership model. It does not complete Linux verification or activate a production
signer.
