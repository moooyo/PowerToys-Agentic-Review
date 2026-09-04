# ADR 0019: Stage a Dormant RoleConfig v3 Disabled-Execution Lab

> Superseded by ADR 0029 before publication. Retained as a historical design record only.

> Historical exact profile note: ADR 0025 supersedes the `server_binding_receipt` activation blocker
> as a future production requirement. The fixed lab profile is not reinterpreted and remains
> disabled; a later profile must define replacement activation gates.

- Status: Accepted
- Date: 2026-09-03

## Context

The result-artifact storage and Worker-side source contracts now include a dormant upload session,
a fixed-origin HostControl 2.0 five-operation surface, an exact ARWX 1.1 schema profile, and Job
execution envelope version two. None of those contracts is reachable from production. The installed
foundation remains deliberately incompatible with execution:

- native `foundationRoleConfigJSON` and `decodeFoundationRoleConfig` accept only exact RoleConfig
  version two with `executionEnabled = false`;
- production `RuntimeBootstrapV1` selects local HostControl RPC 1.0 and ARWX 1.0;
- the sealed native operation policy keeps Claim unavailable;
- production Claim emits and consumes only Job execution envelope version one; and
- signed matching packages, enrollment live evidence, Server binding receipts, and native Windows
  activation evidence do not exist.

Changing the version-two decoder or adding fields to `RuntimeBootstrapV1` would create an implicit
upgrade path inside the active RPC1 boundary. A lab document must instead describe the intended
closed combination while proving that the combination still grants no execution authority.

## Decision

RoleConfig v3 and RuntimeBootstrapV2 are staged as independent, source-only lab contracts. The
exact profile name is `disabled-execution-lab-v1`. The TypeScript modules have no barrel export or
production import, and the Go package has no non-test external consumer.

### Exact disabled RoleConfig

Control and Executor share these fixed facts:

```text
foundationVersion = 3
profile = disabled-execution-lab-v1
activationState = blocked
globalRolloutDefault = off
executionEnabled = false
executionAuthority = false
maximumSlots = 1
availableSlots = 0
disabledReasonCode = EXECUTION_DISABLED
```

The physical maximum remains one for later capacity accounting, while the advertised value remains
zero. Control carries only the SHA-256 key identifier. Executor additionally carries the exact
base64url, length, and SHA-256 descriptor for one canonical P-256 PKIX DER SPKI public key. Control
rejects public-key bytes, and Executor rejects a missing, non-P-256, noncanonical, or inconsistent
descriptor. Both implementations require the exact 91-byte uncompressed P-256 PKIX SPKI form, the
fixed DER AlgorithmIdentifier and bit-string prefix
`3059301306072a8648ce3d020106082a8648ce3d03010703420004`, and a parse-and-reencode byte match. A
shared compressed-point SPKI negative vector is rejected by both languages.

The document binds these exact target contracts:

```text
ARWX                         = major 1, minimumMinor 1, maximumMinor 1
HostControl                  = protocol 2.0, exact five-operation ordered surface
JobExecutionEnvelope        = version 2
completionMode              = result_artifact_v1
requiredRuntimeBootstrap    = version 2
requiredWorkerApi           = version 1.1
```

HostControl operations are exactly create artifact upload, put artifact chunk, finalize upload,
terminate upload, and artifact-backed run completion. The version fields record an activation
target; they are not implementation or rollout evidence.

### Closed activation blockers

Every lab RoleConfig contains this complete, ordered missing-prerequisite tuple:

```text
artifact_readiness_attestation
arwx_1_1_semantic_verifiers
enrollment_live_evidence
hostcontrol_v2_production_composition
job_execution_envelope_v2_claim_selection
migration_inventory_gate_off_rollback_binary
persistent_exact_node_allowlist
release_compatibility_profile_v2
role_config_v3_production_authority
runtime_bootstrap_v2_production_exchange
server_global_rollout_gate_default_off
server_binding_receipt
signed_matching_packages
signed_node_attestation
windows_arm64_signed_install_attack_rollback_evidence
windows_x64_signed_install_attack_rollback_evidence
worker_api_1_1
worker_claim_envelope_v2_consumer
```

The tuple cannot shrink, grow, reorder, or contain `null`. Completing one item therefore requires a
new reviewed profile rather than mutating the meaning of this permanently blocked profile.

### RuntimeBootstrapV2 lab document

The lab bootstrap is also a pure canonical data contract. Its `protocolVersion = "2.0"` field is
named and documented as the **local HostControl RPC2 selection**. It is not the Worker API 1.1
version and is not the ARWX 1.1 version. Separate fields bind ARWX to exact minor one, the closed
HostControl operation tuple, Job execution envelope version two, and `result_artifact_v1`.

The bootstrap embeds only a canonical base64url/length/SHA-256 descriptor for an exact RoleConfig v3
document. Its role and the decoded RoleConfig role must match. The TypeScript and Go factories and
parsers are data-only: they implement no acknowledgement, commit, channel, exchange, launch binding,
operation policy, or Claim constructor.

Successful parsing returns a branded or opaque immutable value with `executionAuthority = false`.
It can derive a `DisabledReadinessProjection` containing `ready = false`, `availableSlots = 0`,
`executionAuthority = false`, and `reasonCode = EXECUTION_DISABLED`. This projection is **not** an
ARWX `Ready` wire message, contains none of the ARWX session or transcript binding, and grants no
Ready authority.

### Cross-language and production exclusion

Go and TypeScript share one four-record canonical JSONL golden in strict order: Control RoleConfig,
Executor RoleConfig, Control RuntimeBootstrap, and Executor RuntimeBootstrap. Both implementations
must reproduce and parse all four records byte for byte. Tests cover exact object keys, canonical
UTF-8 JSON, duplicate keys, byte ceilings, canonical base64url, digest and length binding, P-256 DER
round trips, role separation, frozen or opaque return values, and input/output alias isolation.

Recursive source guards reject the lab modules from the legacy, Control, and Executor entrypoints
through relative imports, bare subpaths, TypeScript `import = require`, runtime loaders, or an
indirect export from the existing runtime-bootstrap module. Source pins keep the production
RoleConfig v2 parser, native foundation encoder and decoder, sealed Claim-policy derivation, RPC1
server gates, Claim contract and producer, and production role composition unchanged. The Go lab
package scans the native module and fails if any non-test package imports it.

### Activation remains a separate release

There is no version fallback, feature probe, rolling upgrade, or partial activation. A future
profile can be considered only after all of these conditions hold together:

- an explicit persistent Server global rollout gate remains off by default, and a separate
  persistent exact node allowlist selects each canary node; the local `globalRolloutDefault` value
  is only a requirement and is not evidence that either Server gate exists;
- Worker API 1.1, the production RuntimeBootstrapV2 exchange, HostControl 2.0 composition, and ARWX
  1.1 semantic, handshake, capability, and artifact-stream verifiers are complete;
- the signed release compatibility profile atomically selects Worker API 1.1, local HostControl
  RPC2, ARWX 1.1, RuntimeBootstrapV2, and the matching Control and Executor payloads;
- a production RoleConfig v3 authority derives the exact role-local documents only from verified
  native and rollout evidence rather than accepting a Node-selected document;
- Server Claim selection durably emits only Job execution envelope version two with
  `result_artifact_v1` for the selected attempt;
- the shared Claim schema and Worker Claim consumer accept exactly that version-two envelope only
  after the same rollout selection;
- native enrollment live evidence verifies the signed node attestation and Server binding receipt;
- artifact readiness is attested before admission and remains fail-closed;
- matching Control, Executor, and native packages are signed and installed atomically; and
- native Windows x64 and arm64 signed installation, attack, mixed-version, downgrade, restart, and
  rollback evidence passes.

Garbage collection is not a hard canary gate. Rollback for any migration-bearing release must use a
gate-off binary built against the same migration inventory; an older binary with a smaller inventory
is not an acceptable rollback target.

## Consequences

- The intended v3 combination has a byte-exact, cross-language review surface without becoming a
  production compatibility signal.
- Every accepted lab document remains explicitly blocked, zero-advertised, and incapable of Claim.
- The simplified disabled-readiness projection cannot be mistaken for authenticated ARWX Ready.
- Future activation must replace this profile and cross every rollout, evidence, package, protocol,
  and migration gate in one reviewed release.

## Out of Scope

- changing or extending production RoleConfig v2 or RuntimeBootstrapV1;
- implementing a RuntimeBootstrapV2 acknowledgement, commit, exchange, or launch binding;
- enabling HostControl RPC2, ARWX 1.1, Worker API 1.1, or Job envelope v2 in production;
- adding a Claim producer, consumer, operation-policy authority, or nonzero advertised slot;
- changing production entrypoints, role bundles, release manifests, or installation composition;
  and
- treating schema acceptance, the golden fixture, or this ADR as activation evidence.

## References

- [ADR 0007: Isolate Windows Worker Control and Execution Identities](0007-windows-control-executor-isolation.md)
- [ADR 0008: Store and Complete Result Artifacts through a Fenced Content-Addressed Protocol](0008-result-artifact-storage-and-completion.md)
- [ADR 0014: Define Trusted Enrollment Record v1](0014-trusted-enrollment-record-v1.md)
- [ADR 0017: Stage Artifact HostControl v2 as a Dormant Fixed-Origin Contract](0017-dormant-artifact-hostcontrol-v2.md)
- [ADR 0018: Stage Exact ARWX 1.1 and Job Execution Envelope v2 Contracts](0018-dormant-arwx-minor-1-and-job-envelope-v2.md)
