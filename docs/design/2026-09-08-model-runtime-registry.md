# Immutable expected model runtime registrations

## Operator workflow

Platform administrators manage expected runtime registrations in the Dashboard System page.
Registration records a name, requested model alias, provider identifier, expected provider model
identifier, endpoint digest, CLI version/executable/launch-policy digests, and relay implementation
and policy digests. It does not contain an endpoint URL, credential, header, private profile path,
or a claim that an actual model was executed or verified.

A registration is immutable. Changing its identity, requested alias or name creates another
registration with a new ID. Separate versioned controls allow or disallow new evaluation selections.
Control changes require an expected version, a change ID and a reason. The owner records an audit
event and exact replay receipt in the same transaction. Disabling selection does not modify already
authorized frozen evaluations and is not a replacement for cancelling those evaluations.

Repository maintainers select registrations through their repository's evaluation options endpoint.
They cannot access platform registry mutations or the platform's control history. Only currently
enabled registrations are offered, and creation rechecks enabled state in the owner transaction.
The Dashboard does not silently replace a selection that disappears from the available options.
Profile-only evaluations omit model registration selection.

## Storage and authorization

Migration `0029_model_runtime_registry.sql` adds immutable registration, audit and mutation-receipt
records and a separately controlled current projection. Replacement insertion cannot erase any of
these identities or their history. Audit insertion drives the current control version; direct
unrelated control changes are rejected. Historical migration checksums are unchanged.

Every public operation travels through the existing authenticated `operatorRequest` envelope.
Platform registry operations require current platform administrator configuration; repository
options require current repository configure permission. The registry owner repeats these checks
inside its transaction. Bare registry RPC operations are refused by the database Worker.

Mutation order is current permission, exact receipt replay, recovery restriction, then new
registration or control CAS. Matching authorized retries retain their original response even after
later control changes. Reusing a change ID with another actor or intent is rejected. Recovery mode
permits only existing authorized receipt replay and never creates a new registry change.

The owner independently recomputes the canonical identity digest and full registration digest when
reading stored data. Stored JSON shape, bytes, timestamps, control version and latest audit event
must agree. The HTTP and Dashboard layers validate response shape and request scope/echo; registry
responses additionally verify the expected identity's digest. This checks metadata consistency,
not the provenance of an actual provider response.

## Frozen evaluation integration

The public evaluation request selects only `modelRuntimeRegistrationId` for each arm. Clients do
not submit registration snapshots or expected identity digests. The owner resolves the selected
registration before computing any configuration, cell, execution, authorization or plan digest.

`modelRequirements.runtimeRegistration` is an optional compact reference containing the registered
ID and full registration digest. `expectedModelIdentityDigest` retains the canonical runtime
identity digest. Complete `modelRuntimeRegistration` snapshots reside separately in the frozen
arm configuration, Run plan and execution context. The cell manifest contains only the compact
reference. It therefore does not duplicate complete registrations across all 64 possible cells or
require enlarging the existing 262,144-byte cell-manifest column limit.

Contracts enforce paired presence, matching IDs and expected identity digests. Domain and owner
checks recompute cryptographic digests. SQL guards compare the immutable registry record with
configuration/plan/context snapshots and retain the existing exact plan, cell, authorization and
job relationships. The execution manifest's existing configuration and cell digests bind these
additions without introducing a circular digest dependency.

Readback, Dashboard batch details and scoring use the frozen expectation. Current registration
control does not rewrite historical state. Older two-field model requirements remain readable and
retain their original bytes and unknown identity. Creating a later registration cannot backfill,
re-authorize or silently rerun an older batch.

## Uncertain responses and access refresh

The System registry retains one original mutation intent within the authenticated session, including
its actor, complete payload, change ID and expected control version. A lost or invalid response
keeps new changes disabled until the original intent is retried or definitively rejected.

Temporary access checking or a transient access-query failure hides protected DOM content and
suspends reads and mutations while retaining the same intent. Its owner remains mounted independently
of System health and the outer access gate. Confirmed permission loss, logout, principal changes
or authentication-epoch changes clear the controller and session query data. Late results cannot
populate a different session. A definitive CAS conflict refreshes current control before a new edit.

Development sample mode presents a connection-required message and does not fabricate registry
records or mutation receipts. The normal connected production build uses the authenticated APIs.

## Execution boundary still required

Registration establishes the expected configuration, not actual execution eligibility. Required
model evaluation continues to be refused at readiness, claim and completion until independently
authenticated, lease-fenced invocation/closure acceptance and the actual command/model execution
boundary are implemented and accepted. Registered expectations use the diagnostic prerequisite
`verified_model_execution`; old missing expectations retain `verified_model_identity`.

The next integration must measure the actual CLI and launch policy, compose a trusted authorization
helper without exposing provider credentials, collect the entire actual invocation chain, and bind
an independent closure record to the exact attempt. Only then can observed model identity feed
versioned results and model-backed evaluation scoring. The earlier controlled loopback probe has
not established network isolation. No actual PR or Issue mutation is authorized by registration or
by general local/test-env verification permission.
