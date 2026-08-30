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

## Local authority

`ExecutionCapabilityV1` is a short-lived, lease-token-free authorization. It binds the Control and
Executor boot/session identities, attempt and job identities, an issue revision digest or pull
request base/head commits, canonical data
digests, operation, ceilings, deadlines, and replay identifiers. `RenewalGrantV1` chains the initial
capability and previous grant with an exact next sequence and Server heartbeat sequence.

Signatures use ECDSA P-256 with SHA-256 over length-prefixed, domain-separated canonical bytes. The
`keyId` is the lowercase SHA-256 digest of the public key's DER SubjectPublicKeyInfo. The wire encoding is
exactly 64-byte IEEE P1363 `r || s`, base64url without padding, with low-S normalization. DER,
high-S, wrong-curve, malformed, and noncanonical encodings are rejected. Production signing remains
the responsibility of the Control-only non-exportable CNG adapter. That adapter signs the exported
32-byte signing digest directly and must not hash it a second time. The Node helpers hash the
domain-separated signing bytes internally and are the shared contract implementation and test oracle.

`StartAttempt` carries a from-zero allowlisted local envelope containing all execution inputs but no
Server lease identity: job metadata, repository identity, issue or pull-request resource metadata,
a bounded canonical snapshot, prompt, output schema, and execution policy. It is cross-checked
against every signed capability digest and revision field. `TerminalDisposition` and `TerminalAck`
form a final handshake so Executor cleanup follows a definitive Server terminal outcome.

The package never defines a field for a Server lease token, authorization header, executable path,
or free-form command. Callers must still verify signatures, apply installed policy ceilings, reserve
replay state atomically, convert accepted wall-clock durations to monotonic deadlines, and terminate
all attempt processes when the pipe or local grant is lost.
