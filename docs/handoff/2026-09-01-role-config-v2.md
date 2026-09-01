# RoleConfig v2 Authority Handoff

Status date: 2026-09-01

Branch: `main`

Base commit before this slice: `3e1dd27700a5d9ce5b032aec09c911f9087ccf72`

## Scope

This slice carries the signed RoleConfig v2 authority from native preflight through guarded Node
launch and the committed HostControl boundary.

- Control and Executor bootstraps use an exact, closed RoleConfig v2 document.
- Both roles seal `executionEnabled=false`, `foundationVersion=2`, `maximumSlots=1`, the role, the
  local-authority key ID, and the Executor policy digest.
- The Executor document additionally carries the exact verified local-authority P-256 SPKI bytes as
  a bounded base64url descriptor.
- Native preflight derives the copy-safe runtime authority only from the verified Control and
  Executor pair and their retained runtime contents.
- Launchguard captures that authority once, compares evidence and plan authorities, and retains
  detached immutable inputs for commit.
- Local RPC strictly decodes the sealed v2 document before publishing the committed runtime. Claim
  remains denied before dispatcher or request resources are acquired.
- The TypeScript bootstrap parser enforces exact keys, canonical base64url, byte length, SHA-256,
  key ID, DER round-trip, EC P-256, role separation, and policy digest binding.
- Architecture tests freeze the authority factories, decoder, capture path, call graph, ordering,
  and negative fixtures.

## Safety State

This is still a zero-execution foundation.

- `executionEnabled` is hard-coded to `false` by the native factory.
- `maximumSlots=1` is a signed physical ceiling, not an available-slot advertisement.
- No TypeScript Control or Executor business supervisor is installed.
- No ARWX `Ready` message is emitted.
- HostControl Claim is fail-closed with `OPERATION_NOT_ALLOWED`.
- The production release profile, split installer, signing pipeline, and native Windows evidence are
  still release gates.

Do not add a runtime switch for execution or advertise a non-zero available slot from this state.

## Review Evidence

Independent static reviews of the final Go authority path, TypeScript parser and reviewed-input
digests, and architecture guards reported no P0-P2 findings. These reviews were read-only and did
not execute the candidate.

The latest pre-handoff source snapshot was packaged at:

```text
C:\Users\moooyo\AppData\Local\Temp\shadow-authority-final-4d044c6844ca49158dcbb0a7d0f1f8e7
```

Snapshot hashes:

```text
c3d4148e49f2a8bd4de70ce5b38f1e85d6d7d796dc4d91de4b5eb037f2d0b868  base.tar
601e74c88b05f2934394756ef1bd4498ff3e8b2ca9da3c37861f820b90770018  changes.patch
943699fb1272e56c3aee5837f2f402697bd94b24cec9615725fdfe9535baa491  status.txt
```

The reviewed TypeScript role-input digests in this candidate include:

```text
c5b3ea013ce425118cd4e05cca849c24751257416501977d8b5574d1efa23e7c  runtime-bootstrap.ts
ff682ec40f6d47be036ffe771306dccead3e2a7efe2fd679bd6b726c5a5fe340  runtime-bootstrap-handshake.ts
```

## Verification Blocker

The final candidate was not tested after the last guard and decoder changes. Repository policy
forbids local validation without explicit authorization, and `ssh test-env` timed out while
connecting to `10.0.1.20:22`. No local test fallback was used.

Treat this commit as an unverified handoff candidate until the following remote matrix passes:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm lint

cd native/service-host
go test -count=1 ./...
go test -count=1 -race ./...
go vet ./...
GOOS=windows GOARCH=amd64 go test -exec=/bin/true ./...
GOOS=windows GOARCH=arm64 go test -exec=/bin/true ./...
GOOS=windows GOARCH=amd64 go vet ./...
GOOS=windows GOARCH=arm64 go vet ./...
```

Use a low-concurrency remote setup if the test host remains resource constrained:

```text
TMPDIR=/dev/shm GOTMPDIR=/dev/shm GOCACHE=/dev/shm/go-cache GOMAXPROCS=1 go test -p=1 ...
```

Cross-compilation is not native Windows evidence.

## Next Work

1. Restore `test-env`, run the complete matrix above, and record exact tool versions and results in
   `docs/IMPLEMENTATION_STATUS.md`.
2. Implement the zero-slot Control and Executor shadow supervisors. The Executor must advertise
   `ready=false`, `availableSlots=0`, and `reasonCode=EXECUTION_DISABLED` only after the authenticated
   local handshake.
3. Add a structured post-dispatch hook before using `ArmArwxShutdownV1`; do not arm from inside an
   active ARWX handler.
4. Build the production release profile, signed role bundles, native binaries, and dual-service
   installer.
5. Run native Windows x64 and arm64 token, ACL, Named Pipe, CNG, certificate, Job Object, tamper,
   restart, shutdown, and attack tests before changing Claim authority.

The result-artifact database work is isolated on `codex/artifact-spine` and can be reviewed or
continued independently.
