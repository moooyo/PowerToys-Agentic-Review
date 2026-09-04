# ADR 0027: Trusted Windows Local Channel Without Local Signatures

## Status

Accepted

## Context

In the trusted-local deployment, Windows local environment and local administrators are trusted by policy. We need a simpler authorization channel for Control to start and renew Executor sessions while preserving strict process and service identity checks.

## Decision

1. Trust boundary:
   - Trust the Windows local machine state and administrator-controlled service installation.
   - Keep Control and Executor as separate restricted service identities.

2. Peer authentication:
   - Authenticate peers only with runtime-bound local facts:
     - SCM service PID
     - Named Pipe server/client PID
     - retained process identity
     - exact Windows service SID and access token
   - Use the `Hello -> HelloAck -> Ready` handshake.
   - Remove `ControlProof` from the protocol.

3. Authorization format:
   - `Start` and `Renew` are unsigned typed authorization messages.
   - Keep replay and context bindings in every authorization payload:
     - `nonce`
     - `bootId`
     - `sessionId`
     - attempt, job, and lease identity
     - reviewed input digests
     - resource limits
     - hard deadlines
     - grant and heartbeat sequences
     - replay constraints and renewal-chain binding

4. Crypto scope reduction:
   - Do not use CNG key generation, local key storage, SPKI exchange, or local signatures for this channel.
   - Package signatures remain install-time integrity controls only.

5. Data model:
   - Modify schema version 4 in place.
   - No migration path and no fallback mode for previous local-signature behavior.

## Consequences

- Reduced protocol and operational complexity for trusted-local deployments.
- Strong dependence on Windows local trust and service hardening.
- Lower implementation and recovery overhead by removing local key lifecycle.
- No compatibility obligation exists because no Worker package or installer has been published.

## Supersedes / Revises

- Revises ADR 0007
- Revises ADR 0025
- Revises ADR 0026
