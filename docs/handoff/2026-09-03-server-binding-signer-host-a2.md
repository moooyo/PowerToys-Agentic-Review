# Dormant Server Binding Signer Host v1 A2 Handoff

> Historical handoff. ADR 0025 supersedes the signer-host direction and cancels its deferred Linux
> process-verification requirement.

Status date: 2026-09-03

Branch: `codex/server-binding-signer-host-v1-a2`

Base commit: `648c00d099075684d063f0fbedbec59e62b4313b`

ADR 0024 governs the complete dormant Linux signer-host transport. This handoff covers A2: the
direct-child client, its production-unavailable profile boundary, and a fixed source-excluded test
fixture. A1 remains authoritative for the strict wire protocol and pure lifecycle reducer. ADR 0022
remains authoritative for receipt and active-status statement bytes and signature rules, and ADR
0023 remains authoritative for persistence, signer adoption, and coordinator ownership.

## Completed Scope

- `server-binding-signer-host-profile-v1.ts` defines the exact executable, argument, and working
  directory snapshot. Its frozen production loader always throws unavailable. No configuration,
  environment fallback, database value, route input, or package document can select a signer host.
- `server-binding-signer-host-client-v1.ts` now owns one direct `node:child_process` child behind a
  frozen Promise-only facade. It generates cryptographically secure UUID v4 identifiers, exposes
  readiness and the first terminal failure, returns defensive public-key and signature copies,
  permits one signing request at a time, and provides idempotent close.
- Profile validation requires exact own fields, absolute executable and working-directory paths,
  and exactly one argument: `--server-binding-signer-host-v1`. Spawn is fixed to `shell=false`,
  `detached=false`, `windowsHide=true`, and three pipes. The replacement environment is an empty
  null-prototype object, so inherited properties and caller variables cannot become child
  environment entries.
- The client verifies the complete hello/ready exchange, including protocol version, instance ID,
  child PID, operation set, canonical P-256 SPKI, and derived key ID. It accepts only the two closed
  S0 signing operations and validates returned P1363 low-S signature shape before returning it.
- Handshake, signing, graceful shutdown, and forced-exit deadlines are independently bounded.
  Caller abort or a signing deadline makes the outcome unknown, sends best-effort cancellation when
  possible, fences all future work, and proceeds to forced termination. A second local signing call
  is recoverably busy and allocates no request ID or protocol frame.
- Logical failure and cleanup evidence remain separate. A successful close requires either proof
  that no process started or an observed child `exit` plus stdin, stdout, and stderr close. An
  unproved forced exit retains the child, streams, listeners, and unsettled writes in a
  process-lifetime quarantine and blocks replacement until late exit proof safely releases it.
- `apps/server/testdata/server-binding-signer-host-fixture-v1.mjs` is a fixed, source-excluded real
  child fixture with one embedded test-only P-256 key. It implements normal receipt and active-status
  signing plus cancellation, hanging-sign, hanging-shutdown, pre-ready exit, protocol corruption,
  stdout overflow, and stderr overflow scenarios. Production code never references its path,
  scenario selector, or key.
- The client itself still forwards only the one strict protocol argument. Real-child tests use
  test-runner module isolation to prepend a closed fixture scenario argument before forwarding that
  profile argument to Node. This is test-only plumbing already permitted by ADR 0024; no production
  spawn hook or mutable adapter was added.
- Architecture guards pin the direct consumer graph, top-level exports, normalized source digests,
  fixed spawn call and options, unavailable loaders, fixture location and digest, compiler and
  package exclusion, and absence of production private-key, process-launch, or fixture reachability.

## Production Boundary

A2 is dormant and grants no production authority:

- the signer-host profile loader remains unavailable;
- the existing signer provider and trust loaders remain unavailable;
- `main.ts`, production configuration, Server routes, Worker authentication, binding resolution,
  Claims, leases, slots, packages, installation, and execution code do not import or instantiate the
  client;
- no production key backend, trust key, signer binary, credential, environment, or deployment
  profile was selected; and
- a fresh database remains uninitialized while retained S1 state still fails closed without a
  future exact production signer and trust descriptor.

Do not treat the fixture, local child launch, ready message, signature, or cleanup result as a
production signer, trust root, Worker identity, or execution-enablement signal.

## Frozen Source Digests

Normalized LF SHA-256 values:

```text
655c58067cd8b125a6cf32675efc9bbf07111349f783d2071feadbfb0a9c687d  apps/server/src/enrollment/server-binding-signer-host-client-v1.ts
7d69bce8d28832a741c1d3419fb9320a18ab68bb206977a3df9b0a9fa1dead42  apps/server/src/enrollment/server-binding-signer-host-profile-v1.ts
3410ff22fcea8ed82eedd4267c3092c14da3ee8c64d7d5346c0ceb62981ad0e0  apps/server/testdata/server-binding-signer-host-fixture-v1.mjs
```

## Verification

Local verification was explicitly authorized. No command was run on `test-env`.

At this handoff snapshot, the focused signer-host protocol, reducer, profile, fake-process,
real-child, and Server binding architecture matrix passed 88 tests on Windows. This includes normal
receipt and active-status signing, busy admission, UUID collision handling, handshake and signing
timeouts, caller abort, cancellation, malformed and flooded output, write failures, shutdown,
forced termination, stdio ordering, unproved-exit quarantine, and replacement fencing.

All-workspace typecheck and build passed, including Dashboard Webpack, Worker bundles, and Server
output. Biome checked 321 files. A post-build scan found no fixture basename, fixture scenario
selector, private-key marker, or fixture stderr marker in `apps/server/dist`.

The local runtime was Node 26.1.0 while repository engines require `>=24.20.0 <25`, so pnpm emitted
an engine warning. The complete all-workspace test suite was not rerun for A2; the focused matrix
above is the final local test evidence for this slice.

Windows-local child tests do not satisfy ADR 0024's mandatory Linux gate. They are not evidence for
Linux signal delivery, process reaping, UID/GID or capability behavior, executable and ancestor
ownership, cgroup containment, uninterruptible D-state, or parent-death cleanup. That evidence is
deferred because this task explicitly authorized local verification instead of `test-env`.

## Deferred Work

1. Complete the dormant provider bridge into the ADR 0023 signer and coordinator ownership model,
   including terminal-failure adoption races and zero-database-request failure snapshots, while
   preserving unavailable production loading and zero production reachability.
2. Run the exact final candidate on Linux and satisfy the mandatory real-child spawn, signal, exit,
   stdio-close, forced-kill, quarantine, and no-descendant verification matrix.
3. Review B independently before activation. B must freeze the protected production key backend,
   compiled trust, signed executable and fixed protected paths, credential identity, environment,
   deployment supervision, cgroup or parent-death policy, rotation, backup, restore, audit, and
   compromise procedures.
4. Keep S2 enrollment, confirmation, active-status, recovery, and revocation routes separate. No
   Worker authentication, Claim, lease, slot, package, installation, or execution authority may
   consume binding state before those reviews and required native evidence complete.

A2 proves a dormant direct-child transport candidate and local generic process behavior only. It
does not complete Linux verification, provider composition, or production activation.
