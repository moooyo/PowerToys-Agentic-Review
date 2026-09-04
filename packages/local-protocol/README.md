# Agentic Review Local Protocol

`@agentic-review/local-protocol` defines the application contract between the Windows Control and
Executor services. It does not implement the Named Pipe, ServiceHost peer authentication, queueing,
timeouts, or the attempt state machine.

## Wire format

Version 1 uses a fixed 48-byte little-endian header followed by canonical UTF-8 JSON:

```text
offset  size  field
0       4     ASCII magic "ARWX"
4       2     headerLength = 48
6       2     majorVersion = 1
8       2     negotiated minorVersion
10      2     stable messageType ID
12      4     flags = 0
16      4     payloadLength
20      8     per-direction sequence, unsigned little-endian
28      16    correlation UUID bytes
44      4     reserved = 0
```

The first frame in each direction has sequence `1`; every subsequent frame increments it exactly
once. Sequence exhaustion at `2^64 - 1` is fatal and never wraps. Session messages use the nil
correlation UUID. Attempt messages use a dedicated canonical v4 `attemptCorrelationId`, while
Server `jobId`, `runAttemptId`, and `workerInstanceId` retain their wider `EntityId` contract. A
fresh authenticated pipe session resets both directional sequences.

Frames are at most 1 MiB including the header. JSON is canonicalization version 1: object keys are
sorted, whitespace is absent, strings contain only Unicode scalar values, and numbers are safe
integers. Receivers decode UTF-8 fatally, parse the JSON, reserialize it, and require exact byte
equality. This also rejects duplicate object keys and alternative number spellings.

Artifact data is base64url without padding. Each decoded chunk is at most 256 KiB. Large review
results use the artifact stream and `Complete` references the completed result artifact, so the
Server's 2 MiB result limit does not conflict with the 1 MiB local frame limit.

## Local authorization

`ExecutionCapabilityV1` is a short-lived, lease-token-free authorization. It binds the Worker,
Executor boot/session, attempt and job identities, the target revision, canonical input digests,
operation, resource ceilings, deadlines, and independent replay identifiers. `RenewalGrantV1`
chains the initial capability and previous grant with an exact next sequence and a fresh successful
Server heartbeat sequence. Grants remain limited to 45 seconds and never extend the hard deadline.

The Windows local environment is trusted. The protocol therefore carries no local ECDSA key,
`keyId`, signature algorithm, signature wrapper, or `ControlProof`. The session sequence is
`Hello` (Control), `HelloAck` (Executor), then `Ready` (Executor); message type IDs are exactly
1 through 19.

`establishLocalSession` validates and runtime-brands the exact `Hello` and `HelloAck` pair. The
established session binds the negotiated protocol, both nonces, Worker node and Control instance,
session and Executor boot IDs, the shared installation manifest, both preflight digests, the Executor
policy digest, and `maximumSlots`. `validateReadyForEstablishedSession` accepts `Ready` only when
all Executor session fields match that branded session. The brand proves in-process validation, not
cryptographic authentication.

`StartAttempt` carries the plain `ExecutionCapabilityV1` in its `authorization` field together
with a from-zero allowlisted local envelope containing all execution inputs but no Server lease
identity. The message validator cross-checks every authorization digest, revision, session, attempt,
job, deadline, and resource field. `RenewGrant` carries the plain `RenewalGrantV1` authorization.

Only values returned by `validateExecutionCapabilityForContext` and
`validateRenewalGrantForContext` receive runtime brands accepted by replay and artifact
verification. Replay reservations, heartbeat ordering, generation fencing, single-use
authorizations, monotonic deadlines, resource ceilings, and terminal cleanup remain mandatory.

The package never defines a field for a Server lease token, authorization header, executable path,
or free-form command. Callers must reserve replay state atomically, apply installed policy ceilings,
convert accepted wall-clock durations to monotonic deadlines, and terminate all attempt processes
when the pipe or local grant is lost.
