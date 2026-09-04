# ADR 0018: Stage Exact ARWX 1.1 and Job Execution Envelope v2 Contracts

> Superseded by ADR 0029 before publication. Retained as a historical design record only.

- Status: Accepted
- Date: 2026-09-03

## Context

ADR 0008 requires artifact-backed completion to bind two different hashes: the SHA-256 of the exact
result artifact bytes and the SHA-256 of the Server's canonical validated result. The production
Worker cannot communicate that distinction yet:

- ARWX 1.0 `Complete` carries only `resultSha256`;
- the committed Job execution envelope is version one and has no completion-mode field;
- production claims continue to select and emit only the version-one envelope;
- RuntimeBootstrap, RoleConfig v2, RPC1, signed release compatibility, and both zero-slot role
  entrypoints remain bound to ARWX minor zero; and
- the current local-protocol and contracts package barrels expose only the production contracts.

ADR 0007 normally reserves required-message semantic changes for a major version and permits minor
versions to add only negotiated optional fields or messages. Making `resultDigest` optional would be
unsafe, however: either peer could silently treat the raw artifact digest as the canonical result
digest or complete without binding the Server-authoritative representation.

## Decision

ARWX 1.1 and Job execution envelope v2 are staged as independent, source-only contracts. They are
not exported from the existing package barrels and have no production consumer.

### Exact ARWX 1.1 profile

The dormant profile fixes the framing header minor to one. Its `Hello` has
`minimumMinor = maximumMinor = 1`, every other session- or attempt-scoped message has
`protocolMinor = 1`, and the nested `Hello` and `HelloAck` inside `ControlProof` are also minor one.
The twenty message IDs, 48-byte header, one-MiB frame ceiling, correlation scopes, canonical JSON
rules, and UTF-8 rules are inherited unchanged from ARWX major version one.

ARWX 1.1 `Complete` contains both required fields:

```text
resultSha256 -> SHA-256 of the exact uploaded result artifact bytes
resultDigest -> SHA-256 of the Server canonical validated result JSON
```

Each is exactly 64 lowercase hexadecimal characters. Neither field is optional and neither may
stand in for the other. The values may be equal when the raw bytes already use the exact canonical
encoding, but no implementation may rely on that coincidence.

The profile exposes no minor range, feature probe, optional digest, or fallback API. ARWX 1.0 and
1.1 frames and message schemas reject one another. This exact-negotiated closed profile therefore
narrowly supersedes ADR 0007's optional-only minor rule: the required `resultDigest` applies only
after both signed peers have selected 1.1. It is not a rolling-compatible extension of 1.0.

The source-only module provides only a fixed-minor frame codec and a strict TypeBox schema profile.
It intentionally provides no semantic message validator, handshake transcript verifier, capability
verifier, artifact-stream verifier, or session state machine. Schema acceptance alone grants no
authority. A future activation must add and separately review those minor-one semantic and
cryptographic verifiers before any runtime consumer may import this module.

### Job execution envelope v2

The dormant `JobExecutionEnvelopeV2Schema` reuses all version-one identity, lease, repository,
resource, prompt, and policy constraints while replacing the version marker and adding one required
mode:

```text
envelopeVersion = 2
completionMode = result_artifact_v1
```

There is no inline alternative in this schema. The existing version-one envelope, Claim response
union, database Claim result, and Claim producers remain unchanged and reject a version-two
envelope. A Worker request cannot select this mode.

### Dormancy and activation

The ARWX 1.1 and envelope-v2 modules are absent from their package root barrels and from the legacy,
Control, and Executor production import graphs. Recursive static guards reject a direct or indirect
production import and pin the production framing, messages, barrels, and version-one envelope source
forms. Compiling the dormant files grants no execution, Claim, completion, or slot authority.

Activation requires a separate reviewed release that atomically installs matching signed Control
and Executor packages, introduces an exact RuntimeBootstrap and RoleConfig selection, binds Server
registration and Claim rollout to those artifacts, emits envelope v2 only for a durable
`result_artifact_v1` attempt, and passes native Windows x64 and arm64 downgrade and mixed-package
tests. Any 1.0/1.1 peer combination must fail at handshake, frame, or message validation before an
attempt starts. Activation cannot use a rolling in-place upgrade.

## Consequences

- Raw artifact identity and canonical result identity have distinct required wire fields.
- The future Server rollout has an exact envelope contract with no Worker-controlled mode selector.
- Existing ARWX 1.0, envelope v1, Claim behavior, role bundles, and zero-slot production posture are
  byte- and graph-stable.
- A future activation must cross package, bootstrap, RoleConfig, registration, Claim, and Windows
  evidence gates together.

## Out of Scope

- production ARWX 1.1 negotiation or a compatibility range;
- ARWX 1.1 semantic, handshake, capability, or artifact-stream verification;
- RoleConfig v3, RuntimeBootstrap changes, or release-manifest changes;
- Claim selection, envelope-v2 generation, or any runtime consumer;
- wiring the dormant upload session to HostControl or ARWX 1.1;
- enabling execution slots or artifact-backed production completion; and
- native Windows runtime evidence.

## References

- [ADR 0007: Isolate Windows Worker Control and Execution Identities](0007-windows-control-executor-isolation.md)
- [ADR 0008: Store and Complete Result Artifacts through a Fenced Content-Addressed Protocol](0008-result-artifact-storage-and-completion.md)
- [ADR 0017: Stage Artifact HostControl v2 as a Dormant Fixed-Origin Contract](0017-dormant-artifact-hostcontrol-v2.md)
