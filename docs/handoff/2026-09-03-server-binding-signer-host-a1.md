# Dormant Server Binding Signer Host v1 A1 Handoff

Status date: 2026-09-03

Branch: `codex/server-binding-signer-host-v1-lab`

Base commit: `4294f5eb9057ebd52d5095a049fc4d264af18be0`

ADR 0024 governs the complete dormant Linux signer-host transport. This handoff covers only the A1
source foundation: strict wire bytes and a no-I/O lifecycle reducer. ADR 0022 remains authoritative
for receipt and active-status statement schemas, canonical bytes, P-256 SPKI, and P1363 low-S
signature rules. ADR 0023 remains authoritative for the dormant persistence coordinator and signer
ownership boundary.

## Completed Scope

- `server-binding-signer-host-protocol-v1.ts` implements the exact protocol constants, closed parent
  and child message unions, canonical JSON marshalling and parsing, strict UUID/cancellation/error
  grammars, receipt and active-status statement profile validation, canonical SPKI/key-ID pairing,
  P1363 scalar-range and low-S checks, four-byte big-endian framing, fragmentation, coalescing,
  truncation detection, and terminal decoder failure.
- The codec accepts only exact plain data snapshots. It rejects accessors, symbols, extra members,
  wrong field order on the wire, duplicate JSON members through canonical re-marshalling, invalid
  UTF-8, BOMs, non-ASCII decoded messages, noncanonical base64url, cross-profile statements, and
  deceptive byte views.
- `server-binding-signer-host-client-v1.ts` is intentionally a pure lifecycle reducer. It records
  separate logical and cleanup states, strict request correlation, recoverable local busy admission,
  first-terminal-cause latching, close fencing, orderly shutdown acknowledgement, forced
  termination, `spawn_not_started`, `exit_unproven`, and later `exit_proven` cleanup without process,
  timer, signal, trust, key, or authority capability.
- The reducer accepts only canonical UUID v4 request IDs; ADR 0024 requires A2 to obtain them from a
  cryptographically secure generator. It retains an exact bounded 4096-ID lifetime ledger, permits
  at most 4095 signing IDs, reserves the final ID for shutdown, and moves to healthy `closing` when
  the last signing operation settles. Busy rejection allocates no ID; automatic replacement remains
  deferred.
- Exit proof clears live request correlation. An unproved exit retains raw ownership facts for
  quarantine and may later advance to proved exit without changing the first logical failure.
  Duplicate shutdown acknowledgement is rejected.
- Architecture guards pin both modules to zero production consumers, exact top-level APIs, exact
  imports, normalized source SHA-256, and no private-key, signing, I/O, loader, or hidden re-export
  capability. The protocol is the sole new direct S0 contract consumer.
- No barrel, package export, tsconfig alias, production entrypoint, signer provider, trust loader,
  configuration, route, authentication mapping, Claim, slot, package, installation, or execution
  path was added.

## Frozen Source Digests

Normalized LF SHA-256 values:

```text
3abbf2d6034ce3b5f76ee30a82a5716ccbcb8dbb9c061d9e009c7a29bb793ed5  apps/server/src/enrollment/server-binding-signer-host-client-v1.ts
508078468d24f1bddb79a3880d4795d53678bc38540f56288fc9bd26c5f719ac  apps/server/src/enrollment/server-binding-signer-host-protocol-v1.ts
```

## Verification

Local verification was explicitly authorized. No command was run on `test-env`.

The exact candidate passed:

- all-workspace `pnpm typecheck`;
- all-workspace `pnpm build`, including Dashboard Webpack, Worker bundles, and Server output;
- `pnpm lint` across 316 files;
- the focused protocol, lifecycle, and Server binding architecture matrix, 53/53;
- 45 non-platform Server files, 680 passed and 36 skipped;
- the remaining supported `workers.test.ts` cases, 23 passed and one excluded baseline case;
- Codex 86, local-protocol 92, Contracts 27, Domain 21, Worker 897, and Worker role-bundle plus
  zero-execution guards 19 tests during the complete workspace attempt.

The complete local workspace test was attempted; the exact final Server rerun reached 712 passed,
43 skipped, and 86 failed. Eighty-five failures were the existing Windows fail-closed result from
five POSIX database/backup suites. One deep-JSON route assertion returned 409 rather than 413 under
local Node 26.1.0 and was reproduced on the unchanged pre-A1 `main` source. Repository engines
require `>=24.20.0 <25`. Neither condition is reported as Linux or supported-Node evidence.

## Deferred Work

1. A2 must implement the direct `child_process` client, cryptographically secure UUID v4 generation,
   exact spawn profile, pipe ownership, timeout scheduling, cancellation, output ceilings, close
   choreography, request-capacity retirement, observed child exit plus stdio close proof, and
   process-lifetime quarantine.
2. A2 must add the out-of-production-tree fixture and real Linux child-process matrix covering spawn
   failure, protocol corruption, output flooding, signals, forced termination, and no-descendant
   assumptions. Local Windows source tests do not satisfy this gate.
3. A later reviewed A integration must add the dormant host profile and provider bridge while
   preserving the existing unavailable production loader and zero production reachability.
4. B must independently select the protected private-key backend, compiled signed trust, executable
   release and deployment identity, parent-death/process-tree policy, rotation, backup, and compromise
   procedures before any production activation.
5. S2 enrollment, confirmation, status, recovery, and revocation routes remain separate work. No
   Worker-auth or execution authority may consume binding state before those reviews and native
   evidence complete.

Do not treat A1 as a usable signer transport. It proves only source-level byte validation and
lifecycle reduction; there is no child process, backend, trust activation, or real exit evidence.
