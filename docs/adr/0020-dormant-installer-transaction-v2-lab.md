# ADR 0020: Dormant installer transaction schema v2 lab

> Withdrawn before publication by ADR 0026. Its source package was deleted and is not a future
> installer prerequisite.
>
## Status

Withdrawn before publication by ADR 0026.

This decision does not activate an installer, a journal writer, filesystem mutation, registry
mutation, SCM mutation, service start or stop, Claim, or execution. The source-only
`internal/installstorev2lab` contract package is the sole reviewed non-test importer of this lab
package; it validates the complete nested document without widening this API and is itself excluded
from every production graph. Any second non-test importer is forbidden. The only successful
terminal state in this contract is absent: `COMMITTED`,
`ROLLED_BACK`, and activation `applied` are not members of the schema. `FAILED_CLOSED` is the only
terminal phase.

## Context

ADR 0015 freezes transaction schema v1 as a canonical replaceable snapshot for filesystem root
materialization and swaps. Its `PendingAction` union cannot encode individual Windows service
creation, security, configuration, stop, or start effects. Its two opaque policy actions cannot
provide one write-ahead ordinal per native mutation. Changing those v1 unions would change v1
canonical bytes, digest domains, state semantics, and recovery behavior.

ADR 0016 freezes the ordering of several SCM operations but explicitly leaves production gates
open. The raw `SERVICE_FAILURE_ACTIONSW` clear ABI, the create-time intermediate security
descriptor, preferred-NUMA-node no-setting readback, WinSW preshutdown behavior, process-tree stop
evidence, authenticated start readiness, and the final delayed-start and restart policy are not
complete. The final policy profile does not exist.

Schema v2 must therefore model the closed action ordering and conservative recovery semantics
without implying that any SCM intent is executable. It must also avoid choosing a cross-version
journal namespace or Windows persistence implementation before the one-writer migration contract
is reviewed.

## Decision

### Delivery split

The work is split into three independently reviewed slices.

1. Slice A is this decision. It defines `internal/installtransactionv2lab`: exact ordinary data,
   canonical encoding, validation, fixed plan tables, package-private observations, and a pure
   reducer. It has no path constants, platform imports, or runtime consumer. Its sole non-test
   consumer is the source-only Slice B contract package named above.
2. Slice B is ADR 0021 and the source-only `internal/installstorev2lab` contract package. It freezes
   the single cross-version writer lock, single authoritative head, record publication layout, and
   rollback-binary migration inventory while leaving every platform lifecycle operation unavailable.
3. Slice C will define a native SCM adapter only after supported Windows x64 and arm64 evidence
   closes the remaining ABI and readback gates. It will consume an opaque process-local durable
   intent permit, not a deserialized action.

Slice A cannot be used as a production contract. Removing a blocker or adding successful terminal
semantics requires a new schema and separately reviewed production composition.

### Canonical document

The exact outer document is:

```text
TransactionDocumentV2 = {
  "record": TransactionRecordV2,
  "recordSha256": LowercaseSHA256,
  "schemaVersion": 2
}
```

`recordSha256` is SHA-256 over the ASCII domain
`AgenticReview split installer transaction record v2`, one NUL byte, and the exact canonical
`record` bytes. The maximum encoded document is 96 KiB. The document is canonical UTF-8 JSON with
no BOM, whitespace, duplicate or unknown members, trailing bytes, alternate member order,
noncanonical escape, uppercase digest, null required field, or out-of-range value.

The exact record member order is:

```text
TransactionRecordV2 = {
  "actionPlan": ActionPlanV2,
  "activationPolicyState": "not-applicable" | "blocked",
  "blockedCheckpoint": null | BlockedCheckpointV2,
  "candidate": CandidateGenerationV2,
  "completedActionOrdinal": ActionOrdinal,
  "failureCode": null | FailureCodeV2,
  "installationId": PackageComponentId,
  "mode": "initial" | "upgrade",
  "pendingAction": null | PendingActionV2,
  "phase": PhaseV2,
  "scmPolicyContractId": "agentic-review-windows-split-service-scm-policy-v1",
  "previous": null | PackageGenerationV2,
  "recordSequence": DecimalUint64,
  "rollbackCheckpoint": RollbackCheckpointV2,
  "targetArchitecture": "amd64" | "arm64",
  "transactionId": TransactionId,
  "workerNodeId": EntityId
}
```

All v2 types are new closed unions and structures. They do not alias, embed, or widen the v1
`TransactionRecord`, `PendingAction`, `ActionPlan`, `Phase`, or activation state. The filesystem
action variants repeat the v1 fields and ordinal tables exactly so their meaning can be compared
without coupling the object graphs.

The SCM policy contract identifier is exactly the identifier frozen by ADR 0016. Dormancy and
incompleteness are expressed only by schema version 2 and the derived blocked checkpoint. No second
SCM policy identifier or complete final profile is invented.

The accepted phases are only:

```text
STAGING_VERIFIED
INACTIVE_PACKAGE_VERIFIED
QUIESCED
SCM_MAINTENANCE_FENCED
SERVICES_STOPPED
ROOT_SWAP_IN_PROGRESS
DESTINATION_VERIFIED
SERVICE_CONFIGURATION_IN_PROGRESS
SERVICES_CONFIGURED
EXECUTOR_STARTED
CONTROL_STARTED
AUTHENTICATED_DISABLED_READY
ROLLBACK_IN_PROGRESS
FAILED_CLOSED
```

`SERVICE_CONFIGURATION_IN_PROGRESS` and `SERVICES_CONFIGURED` distinguish absent service records,
partially configured disabled records, and a fully configured disabled pair. Reusing
`DESTINATION_VERIFIED` for those states is forbidden.

### Ordinary action data

Filesystem action variants retain their v1 exact fields. An SCM action carries only:

```text
SCMActionV2 = {
  "actionKind": ActionKindV2,
  "ordinal": ActionOrdinal,
  "policyContractId": "agentic-review-windows-split-service-scm-policy-v1",
  "role": "control" | "executor"
}

SCMGenerationActionV2 = {
  "actionKind": "start-executor" | "start-control",
  "ordinal": ActionOrdinal,
  "policyContractId": "agentic-review-windows-split-service-scm-policy-v1",
  "role": "control" | "executor",
  "targetGeneration": "candidate" | "previous"
}
```

Service names, paths, SIDs, accounts, descriptions, dependencies, start modes, timeouts, access
masks, failure-action values, native handles, buffers, callbacks, and caller-selected policy data
are not action fields. They must eventually come from reviewed compiled constants.

An action is ordinary data, never authority. The codec recognizes every exact union shape so it
can reject cross-variant members. Validation nevertheless rejects every SCM action as a pending
intent under this blocked profile.

### Fixed action ordering

The upgrade maintenance table is:

```text
1  clear-control-failure-actions                         BLOCKED
2  clear-control-failure-actions-on-non-crash
3  clear-control-delayed-auto-start
4  set-control-demand-start
5  clear-executor-failure-actions                        BLOCKED
6  clear-executor-failure-actions-on-non-crash
7  clear-executor-delayed-auto-start
8  set-executor-demand-start
```

The stop table is:

```text
1  stop-control
2  stop-executor
```

The initial service-creation table is:

```text
1   create-disabled-executor-service                 BLOCKED
2   set-executor-service-security
3   set-executor-description
4   set-executor-service-sid-type
5   set-executor-required-privileges
6   clear-executor-delayed-auto-start
7   clear-executor-failure-actions                  BLOCKED
8   clear-executor-failure-actions-on-non-crash
9   set-executor-preshutdown-policy                 BLOCKED
10  create-disabled-control-service                  BLOCKED
11  set-control-service-security
12  set-control-description
13  set-control-service-sid-type
14  set-control-required-privileges
15  clear-control-delayed-auto-start
16  clear-control-failure-actions                   BLOCKED
17  clear-control-failure-actions-on-non-crash
18  set-control-preshutdown-policy                  BLOCKED
19  set-executor-demand-start
20  set-control-demand-start
```

Candidate and previous start each use ordinal 1 for Executor and ordinal 2 for Control. Final
candidate and previous policy plans have no executable action list. Their blocked checkpoint uses
an explicit unavailable action kind at ordinal 1 solely to name the closed boundary.

Every eventual native mutation requires its own write-ahead ordinal. If failure-action clearing
needs more than one native call, or preferred-node repair needs a mutation, a later schema must add
independent ordinals and renumber the plan. A helper cannot hide multiple calls behind one v2
ordinal.

### Derived blocked checkpoint

A blocked checkpoint is not caller-selected metadata. Its exact shape is:

```text
BlockedCheckpointV2 = {
  "actionKind": ActionKindV2,
  "missingPrerequisites": [BlockedReasonV2, ...],
  "ordinal": ActionOrdinal,
  "plan": ActionPlanV2
}
```

The validator derives all four members from the record's phase, plan, completed cursor, mode, and
rollback checkpoint, then requires byte-for-byte semantic equality. The prerequisite array has a
fixed order, no duplicates, and no caller-selected subset. A blocked record always has
`pendingAction=null`. A record with a serialized SCM pending action, a cursor at or beyond the
first blocked ordinal, a missing checkpoint, or a changed checkpoint is invalid.

Every SCM checkpoint includes these baseline prerequisites:

```text
durable-store-unavailable
native-adapter-unavailable
preferred-node-no-setting-readback-unavailable
```

Maintenance additionally requires `failure-actions-clear-abi-unavailable`. Stop additionally
requires `stop-process-tree-evidence-unavailable`. Initial service creation additionally requires
`create-intermediate-dacl-evidence-unavailable`, `failure-actions-clear-abi-unavailable`, and
`preshutdown-contract-unavailable`. Candidate and previous start additionally require
`start-readiness-evidence-unavailable`. The two final checkpoints additionally require their exact
candidate or previous final-policy prerequisite.

This v2 schema therefore stops before ordinal 1 of every SCM plan. Later ordinals remain frozen in
the plan catalogue for review and cross-language comparison; they are not reachable record states.
Resolving any prerequisite requires a new schema rather than mutating this schema's
meaning.

### Full readback and observation boundary

The package-private SCM observation is ordinary process-local data. It binds the transaction ID,
record sequence, canonical record digest, action plan, action ordinal, and action kind. An
observation from another transaction or another record is rejected even if its sequence and
plan-local ordinal match.

A future adapter may create the internal observation only after one complete fresh pair readback
containing:

- all `QueryServiceConfigW` fields;
- every reviewed `QueryServiceConfig2W` class, including description, delayed auto-start, SID type,
  required privileges, failure actions and non-crash flag, preshutdown, trigger information,
  preferred node, and launch protection;
- `QueryServiceStatusEx`;
- owner, group, DACL control flags, and every normalized ACE from service-object security;
- the exact dependent-service topology;
- action-specific retained wrapper, complete process-tree, root Job, or authenticated readiness
  evidence.

The effect return, `ERROR_SERVICE_EXISTS`, a service state, a process ID, a timestamp, an old
snapshot, or a Boolean `verified` value is not evidence. Create completion requires the exact
disabled intermediate state and the create-time DACL frozen by future native evidence. The next
security ordinal separately applies and reads back the final protected DACL. Preferred-node
readback must prove no setting; configured, unreadable, or unsupported state is not repairable in
this schema.

Slice A does not implement the normalized Windows snapshot reader or the classifier that compares
that snapshot with compiled before and target states. Those are Slice C contracts. The internal
observation and its pure binding classifier are unreachable scaffolding that fixes identity and
conservative result categories only; they do not prove that a full readback occurred.

### Pure reducer and recovery classification

The reducer is package-private and performs no I/O. For a valid blocked record it returns only the
exact blocked checkpoint. For v2 filesystem actions it preserves the ADR 0015 write-ahead and
fresh-observation semantics. Its SCM observation classifier documents the future recovery rule:

```text
exact complete pre-state  -> retry the same action under the same durable intent
exact complete target     -> classify target observed; do not publish a v2 completion
anything else             -> SCM_UNPROVED and fail closed out of band
```

No safe partial classification exists in this schema. An inaccessible field, pending service
state, different account,
binary, dependency, descriptor, process identity, both/neither root placement, or state that is not
one exact listed before/target shape is unproved.

If future native evidence proves one action-specific partial state safe, a later schema
must encode that exact observation variant. It cannot widen this generic classifier.

Because every SCM plan is blocked before ordinal 1, the target-observed result is descriptive
package-private data only. Publishing an SCM completion requires a later schema with a
reviewed durable store and native evidence boundary.

The public package exposes only canonical marshal, parse, and validation functions plus ordinary
data types. Successor validation, blocker derivation, observations, reductions, and phase movement
are package-private. No caller can present two valid snapshots and ask the package to bless the
transition between them.

### Upgrade recovery order

An upgrade interrupted after maintenance begins but before the first root intent must first finish
the same fixed maintenance and stop sequence, then freshly reverify the unchanged previous roots.
It starts previous Executor and then previous Control, reacquires authenticated disabled readiness,
and stops at the previous-final-policy blocked checkpoint.

After candidate roots reach final slots, rollback must:

1. stop Control and then Executor;
2. prove both wrapper and child trees absent and both service-root Jobs empty;
3. publish and complete the ADR 0015 root rollback ordinals;
4. freshly reverify all three previous roots;
5. start Executor and then Control;
6. reacquire authenticated disabled readiness; and
7. stop at the previous-final-policy blocked checkpoint.

A partial forward root plan is completed before rollback; it is never played backward. Initial
installation has no service-delete or root rollback path. It leaves each created service at its
last journaled stopped, disabled, or demand-start state with recovery disabled, then fails closed.

### Schema v1 incompatibility

V1 and v2 parsers reject each other's complete canonical documents. Changing `schemaVersion` and
the digest domain together, or mixing the v1 policy action with a v2 SCM action, does not migrate a
record. The three filesystem action wire shapes are intentionally restated field-for-field and are
distinguished by their containing versioned document, not by an action-local tag.

No nonterminal, pending, or `FAILED_CLOSED` v1 record can be translated. A terminal v1 record is
also never rewritten in place. A future migration may start a new v2 transaction only while holding
the one cross-version writer lock and only after fresh root and SCM verification. That migration is
not part of this decision.

After any v2 publication, an old v1 binary is not an acceptable rollback binary. Rollback must use
a gate-off binary that understands the complete migration inventory and fails closed on v2 state.

### Deferred protected store

Slice A defines no path and performs no filesystem operation. Slice B must first close the
cross-version namespace decision. In particular, `writer-v2.lock` and a parallel v2 active head are
forbidden because v1 and v2 could each believe that it owns the same final roots and SCM records.
There must be one retained exclusive writer handle and one authoritative head across versions.
An old binary that sees v2 data must fail closed.

The future store may expose only narrow lifecycle operations equivalent to:

```text
OpenExclusive
Recover
PublishSuccessor
Close
```

It must enforce a closed bounded namespace; exact SYSTEM owner and group; a protected, non-null,
non-defaulted DACL containing only SYSTEM and built-in Administrators full control; stable
handle-bound identity; no reparse points, hard links, alternate streams, case aliases,
case-sensitive directories, or cross-volume object; and no caller-selected path.

Every publication must perform:

```text
exclusive fixed temporary create with final ACL
-> complete write
-> same-handle reread and canonical/digest verification
-> FlushFileBuffers(file)
-> same-directory atomic publication
-> flush retained parent directory
-> reopen final and verify identity and bytes
-> mint process-local DurableIntentPermit
```

The permit must bind transaction ID, record sequence, canonical record digest, plan, action
ordinal, and exact action digest. A future effect adapter accepts only that permit and must confirm
that it still names the current authoritative record before any mutation.

A valid final plus a temporary file leaves the final authoritative. A temporary-only publication,
sequence gap, duplicate or case alias, invalid final, broken link, untrusted lock or head, or
unproved directory durability fails closed out of band. Recovery never selects the largest
sequence, newest timestamp, or last parseable file, and never falls back from a corrupt tail to an
older record that may precede an already executed effect.

### Deferred native adapter

Slice C must not expose `Execute(action)`, a generic operation name, caller-selected configuration,
path, handle, pointer, buffer, or callback. It will provide action-specific methods that derive all
arguments from reviewed compiled constants and consume the exact opaque durable permit. It must
hold the exclusive writer ownership across intent publication, effect, fresh observation, and
completion publication.

Supported Windows x64 and arm64 install, crash-cut, power-loss, ACL/reparse/hard-link/ADS attack,
SCM readback, stop/start, and rollback evidence are release gates. No default SCM value closes a
missing contract.

## Compatibility and guards

Architecture tests pin the v1 non-test source file set and raw hashes, the v2 lab production input
set and normalized source hashes, the complete exported v2 API, pure dependency allowlist, and the
absence of any non-test consumer. Canonical tests pin exact field order, JSON tags, union shapes,
digest domain, strict parsing, alias isolation, and valid cross-version rejection inputs.

The package is not imported by an entry point, local RPC, preflight, release composition, Claim,
Control, Executor, or an installer writer. Its presence changes no production behavior.

## Consequences

- The SCM ordinal inventory and recovery classification become reviewable without introducing an
  effect path.
- `FAILED_CLOSED` remains the only terminal v2 lab state. There is intentionally no successful
  install transaction in this schema.
- Durable storage and native mutation remain explicit later security boundaries rather than hidden
  implementation details.
- Production installation remains blocked until a new schema closes every prerequisite and
  provides signed native evidence.
