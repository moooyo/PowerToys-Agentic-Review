# ADR 0015: Split Installer Transaction Journal v1

> Superseded by ADR 0029 before publication. Retained as a historical design record only.

> Withdrawn before publication by ADR 0026. No production installer may read, write, migrate, or
> recreate this journal format.
>
> Historical note: ADR 0025 removed Worker mTLS and Server binding receipt facts before ADR 0026
> withdrew this entire unpublished journal direction.

## Status

Withdrawn before publication by ADR 0026.

## Context

ADR 0013 fixes the high-level split installation phases and requires a durable journal around every
filesystem and SCM mutation. It also says both that a transition is recorded before its mutation
and that a transition records the completed mutation. Those statements do not distinguish durable
intent from observed completion and are insufficient at a crash boundary. A single
`ROOT_SWAP_IN_PROGRESS` phase also cannot identify which one of several directory renames was
attempted.

This ADR replaces ADR 0013 only for transaction-record encoding, journal publication, root-action
ordering, and crash interpretation. Where ADR 0013 refers to recording a transition before a
mutation, this ADR requires an explicit pending-action record. Where ADR 0013 refers to recording a
completed mutation, this ADR requires a separate completion record written only after a fresh
physical observation. All other ADR 0013 enrollment, package, service, readiness, and zero-execution
requirements remain in force.

The first profile remains intentionally narrow. It supports a clean initial installation or an
upgrade from one previously committed split installation. It does not support the legacy
single-service Worker, uninstall, enrollment rotation, package download, retention, RoleConfig v3,
Claim, or execution.

## Decision

### Fixed journal namespace

The journal uses the fixed installer root selected by ADRs 0013 and 0014:

```text
C:\ProgramData\AgenticReview\Installer
```

The v1 transaction namespace and all derived files are exactly:

```text
C:\ProgramData\AgenticReview\Installer\Transactions
C:\ProgramData\AgenticReview\Installer\Transactions\writer-v1.lock
C:\ProgramData\AgenticReview\Installer\Transactions\active-head-v1.json
C:\ProgramData\AgenticReview\Installer\Transactions\active-head-v1.json.tmp
C:\ProgramData\AgenticReview\Installer\Transactions\<transactionId>\record-v1.json
C:\ProgramData\AgenticReview\Installer\Transactions\<transactionId>\record-v1.json.tmp
```

`transactionId` is a lowercase canonical RFC 4122 version-4 UUID. It is generated from the Windows
cryptographic random source and is never accepted from a command-line argument, environment
variable, package field, or remote caller. The transaction directory contains only the two fixed
record names above. The `Transactions` directory contains only the lock, active head and its fixed
temporary name, and canonical transaction-ID directories.

The active head selects the sole transaction whose record describes the installed generation or an
installation in progress. It is not a mutable filesystem alias and does not contain package or root
facts. Its payload is exactly:

```text
Head = {
  "transactionId": TransactionId
}

HeadDocument = {
  "head": Head,
  "headSha256": LowercaseSHA256,
  "schemaVersion": 1
}
```

`headSha256` is the domain-separated SHA-256 of the canonical `Head` bytes using the prefix
`AgenticReview split installer active head v1` followed by one NUL byte. The head does not carry the
current record digest, so advancing one transaction requires one authoritative record replacement
rather than an impossible atomic update of two files.

Before the first transaction, the only valid empty state is an absent active head and no transaction
directories. After an active head has been published, it is retained. A later upgrade publishes a
new head only after the previous head names a terminal `COMMITTED/applied` or `ROLLED_BACK` record
and the new initial record has been durably published. A `FAILED_CLOSED` head requires the separately
reviewed repair path and cannot be replaced by starting another transaction. A crash between those
two independent publications may require operator repair; recovery must not infer a new active
transaction.

### Protected ACL and one writer

The `Installer` and `Transactions` directories, the lock, the active-head files, every transaction
directory, and every record file have `SYSTEM` as owner and group and a protected, non-null,
non-defaulted DACL. The DACL contains exactly two explicit allow ACEs: `SYSTEM` and the built-in
Administrators group have full control. There are no inherited ACEs and no ACE for either Worker
service SID, a release reader, an interactive user, or any other trustee. Every object is created
with its final security descriptor; creating it with broader access and repairing the DACL later is
forbidden.

The installer opens `writer-v1.lock` with no read, write, or delete sharing and retains the handle
for its entire journal inspection and mutation lifetime. It verifies the lock file's stable identity,
fixed path, empty content, default data stream only, and exact security descriptor before reading an
active head. Failure to acquire or retain that handle means another writer may exist and the
operation fails closed. No second process, recovery helper, service, or library callback may write
the namespace.

The transaction namespace is closed and bounded. Recovery enumerates at most 4,096 transaction
directories and rejects a larger namespace. An unexpected file, directory, stream, reparse point,
hard-link alias, case alias, case-sensitive directory, cross-volume object, or ACL mismatch produces
`FAILED_CLOSED`. V1 performs no automatic retention or deletion of terminal transaction records.

### Canonical bounded documents

Both document types are canonical UTF-8 JSON with no BOM, insignificant whitespace, duplicate or
unknown keys, trailing bytes, alternate member order, noncanonical string escape, or out-of-range
number. Parsing re-encodes the typed value and requires byte equality. The member order is exactly
the order shown by the schemas in this ADR. The maximum encoded active-head size is 1 KiB and the
maximum encoded transaction-record size is 64 KiB.

The transaction file contains one replaceable snapshot, not an append-only event stream. Its exact
schema is:

```text
TransactionDocument = {
  "record": TransactionRecord,
  "recordSha256": LowercaseSHA256,
  "schemaVersion": 1
}

TransactionRecord = {
  "actionPlan": ActionPlan,
  "activationPolicyState": ActivationPolicyState,
  "candidate": CandidateGeneration,
  "completedActionOrdinal": ActionOrdinal,
  "failureCode": null | FailureCode,
  "installationId": PackageComponentId,
  "mode": "initial" | "upgrade",
  "pendingAction": null | PendingAction,
  "phase": Phase,
  "previous": null | PackageGeneration,
  "recordSequence": DecimalUint64,
  "rollbackCheckpoint": RollbackCheckpoint,
  "targetArchitecture": "amd64" | "arm64",
  "transactionId": TransactionId,
  "workerNodeId": EntityId
}

CandidateGeneration = {
  "packageId": PackageComponentId,
  "releaseId": ReleaseId,
  "roots": null | CandidateRootSet,
  "signedIndexSha256": LowercaseSHA256
}

CandidateRootSet = {
  "installation": null | RootIdentity,
  "metadata": null | RootIdentity,
  "trustedConfiguration": null | RootIdentity
}

PackageGeneration = {
  "packageId": PackageComponentId,
  "releaseId": ReleaseId,
  "roots": RootSet,
  "signedIndexSha256": LowercaseSHA256
}

RootSet = {
  "installation": RootIdentity,
  "metadata": RootIdentity,
  "trustedConfiguration": RootIdentity
}

RootIdentity = {
  "fileId": LowercaseHex32,
  "securityDescriptorSha256": LowercaseSHA256,
  "volumeSerialNumber": DecimalUint64
}

PendingAction = CreateCandidateAction | PopulateCandidateAction | RenameAction | PolicyAction

CreateCandidateAction = {
  "actionKind": "create-candidate-root",
  "direction": "forward",
  "ordinal": ActionOrdinal,
  "toSlot": CandidateRootSlot
}

PopulateCandidateAction = {
  "actionKind": "populate-candidate-root",
  "direction": "forward",
  "expectedRoot": RootIdentity,
  "ordinal": ActionOrdinal,
  "slot": CandidateRootSlot
}

RenameAction = {
  "actionKind": "rename-directory",
  "direction": "forward" | "rollback",
  "expectedRoot": RootIdentity,
  "fromSlot": RootSlot,
  "ordinal": ActionOrdinal,
  "toSlot": RootSlot
}

PolicyAction = {
  "actionKind": "apply-candidate-executor-policy" |
                "apply-candidate-control-policy" |
                "apply-previous-executor-policy" |
                "apply-previous-control-policy",
  "ordinal": ActionOrdinal
}

ActionKind = "create-candidate-root" |
             "populate-candidate-root" |
             "rename-directory" |
             "apply-candidate-executor-policy" |
             "apply-candidate-control-policy" |
             "apply-previous-executor-policy" |
             "apply-previous-control-policy"

CandidateRootSlot = "metadata-candidate" |
                    "installation-candidate" |
                    "trusted-configuration-candidate"

RootSlot = "metadata-final" |
           "metadata-candidate" |
           "installation-final" |
           "installation-candidate" |
           "installation-rollback" |
           "installation-inactive" |
           "trusted-configuration-final" |
           "trusted-configuration-candidate" |
           "trusted-configuration-rollback" |
           "trusted-configuration-inactive"
```

`PendingAction` is a canonical JSON tagged union selected only by `actionKind`. Each variant requires
exactly the members shown above in exactly that order; a member belonging to another variant is an
unknown member and is rejected. `CandidateRootSlot` has exactly its three `*-candidate` values.
`RootSlot` has exactly the ten values above; metadata intentionally has no rollback or inactive
slot. A `PolicyAction` has no `direction`, `slot`, `fromSlot`, `toSlot`, or root-identity member.

`recordSha256` is the domain-separated SHA-256 of the canonical `TransactionRecord` bytes using the
prefix `AgenticReview split installer transaction record v1` followed by one NUL byte. Decimal
`uint64` values are canonical non-zero decimal strings without a sign or leading zero, except that
`completedActionOrdinal` and `PendingAction.ordinal` are JSON integers in the closed range 0 through
6. A pending action always has a non-zero ordinal.

`PackageComponentId`, `EntityId`, `ReleaseId`, architecture, and SHA-256 syntax are the fixed
contracts used by the signed outer package. A candidate record must reproduce the exact package
index values. Its `roots` field is null in the first `STAGING_VERIFIED` record. During the fixed
inactive-materialization plan it may contain a partial `CandidateRootSet`; every non-null member is
the freshly observed identity of the corresponding transaction-derived candidate root.
`INACTIVE_PACKAGE_VERIFIED` and every later non-failed record require all three members. An
upgrade's `previous` generation must reproduce the generation selected by the previous terminal
active record and a fresh destination verification. `previous` is null for an initial installation
and required for an upgrade.

`RootIdentity` is ordinary recovery data, not evidence. It records the NTFS volume serial number,
the 128-bit file ID, and the final security-descriptor digest observed for a verified root. Root
paths are not caller-authored record fields. They are derived from the fixed slots below, the
transaction ID, and the package ID. Every use reopens the expected path from a retained volume-root
handle and compares fresh physical facts.

`recordSequence` starts at `1` and increases by exactly one for every authoritative record
replacement. It detects stale in-process writes but does not replace a physical re-observation.
`FailureCode` is one of `JOURNAL_CORRUPT`, `NAMESPACE_AMBIGUOUS`, `DURABILITY_UNPROVED`,
`ROOT_IDENTITY_AMBIGUOUS`, `REVALIDATION_FAILED`, `SCM_UNPROVED`, or `READINESS_UNPROVED`.
Free-form errors, paths, secrets, certificate bytes, token data, or native error messages do not
belong in the record.

### Transaction phases and reduction

`Phase` is the following closed set:

```text
STAGING_VERIFIED
INACTIVE_PACKAGE_VERIFIED
QUIESCED
SCM_MAINTENANCE_FENCED
SERVICES_STOPPED
ROOT_SWAP_IN_PROGRESS
DESTINATION_VERIFIED
EXECUTOR_STARTED
CONTROL_STARTED
AUTHENTICATED_DISABLED_READY
COMMITTED
ROLLBACK_IN_PROGRESS
ROLLED_BACK
FAILED_CLOSED
```

`ActivationPolicyState` is `not-applicable`, `pending`, or `applied`. It is `not-applicable` on the
forward pre-commit path and during rollback until authenticated disabled readiness. The first
`COMMITTED` record must carry `pending` in the same canonical record replacement; there is no valid
`COMMITTED/not-applicable` record. Rollback likewise moves atomically from `not-applicable` to
`pending` with its first previous-policy intent. A `COMMITTED/applied` record is terminal. An upgrade
`ROLLED_BACK/applied` record is valid only after the previous generation's reviewed policy has been
freshly observed as restored. `FAILED_CLOSED` is terminal and preserves the last known activation
state.

`RollbackCheckpoint` is `not-applicable`, `roots-restored`, `executor-started`, `control-started`, or
`authenticated-disabled-ready`. It is `not-applicable` outside an upgrade rollback. It records only
historical progress; after restart the corresponding roots, service state, and readiness must be
observed again.

`ActionPlan` is the following closed set:

```text
none
materialize-inactive
initial-forward
upgrade-forward
upgrade-rollback
candidate-activation-policy
rollback-activation-policy
```

`ActionKind` is the closed union shown by `PendingAction`: create or populate one candidate root,
rename one directory, apply the candidate Executor policy, apply the candidate Control policy,
apply the previous Executor policy, or apply the previous Control policy. No generic command,
service name, policy document, path, callback, or action payload is accepted.

`completedActionOrdinal` is zero when a plan begins and otherwise names the last completed action in
that plan. `pendingAction`, when present, must be the next ordinal and must exactly equal the action
derived from the plan, mode, package binding, fixed service role, and recorded root identities. A
decoder or caller cannot supply a different path, identity, action kind, policy target, or ordinal.

The reducer is a pure validator and next-requirement planner. It accepts ordinary record data and
typed observations obtained by the orchestrator in the current process, and returns either one
fixed next requirement or `FAILED_CLOSED`. It does not perform I/O and its output is not installation,
SCM, readiness, Claim, or execution authority. Production transitions that depend on opaque
evidence must be kept behind the future installer composition boundary; a public API accepting a
caller-authored Boolean such as `ready=true` or `verified=true` is forbidden.

### Complete state and field matrix

The following table is the complete legal v1 state graph. `0/null` means
`completedActionOrdinal=0` and `pendingAction=null`. Rows that mention a deferred SCM or readiness
gate describe the only eventual transition shape, but remain unreachable in production until that
gate is implemented and reviewed.

| From | Required durable or fresh condition | Resulting fields |
| --- | --- | --- |
| No transaction | Fresh `StagedPackageEvidence`, then first record publication | `STAGING_VERIFIED`, `candidate.roots=null`, `not-applicable`, `none`, `0/null`, rollback checkpoint `not-applicable` |
| `STAGING_VERIFIED/none` | First inactive-materialization intent | Same phase, plan `materialize-inactive`, cursor `0`, pending ordinal 1 |
| Any active plan with `pendingAction=null` and completed cursor `1 <= n < lastOrdinal` | Durably publish the exact plan-derived ordinal `n+1` intent | Phase, activation, plan, completed cursor, candidate roots, and rollback checkpoint remain unchanged; `pendingAction` becomes exactly ordinal `n+1` |
| `STAGING_VERIFIED/materialize-inactive` | Non-final action freshly observed and completed | Same phase and plan, candidate root members updated as applicable, completed ordinal advanced, pending null |
| `STAGING_VERIFIED/materialize-inactive` | Ordinal 6 freshly verified and completed | `INACTIVE_PACKAGE_VERIFIED`, complete non-null candidate roots, `not-applicable`, plan `none`, `0/null` |
| `INACTIVE_PACKAGE_VERIFIED` | Initial clean-host absence or upgrade authenticated `Drained` freshly proved | `QUIESCED`, other fields unchanged and `none`, `0/null` |
| `QUIESCED` | Deferred maintenance-fence WAL completed and exact SCM fence freshly read back | `SCM_MAINTENANCE_FENCED`, `none`, `0/null` |
| `SCM_MAINTENANCE_FENCED` | Deferred stop WAL completed and both process trees freshly proved absent | `SERVICES_STOPPED`, `none`, `0/null` |
| `SERVICES_STOPPED/none` | First fixed forward rename intent | Atomically `ROOT_SWAP_IN_PROGRESS`, plan selected from mode, cursor `0`, pending ordinal 1 |
| `ROOT_SWAP_IN_PROGRESS` with a forward plan | Non-final rename freshly observed and completed | Same phase and plan, completed ordinal advanced, pending null |
| `ROOT_SWAP_IN_PROGRESS` with a forward plan | Last rename freshly observed and completed | Same phase, plan `none`, `0/null` |
| `ROOT_SWAP_IN_PROGRESS/none` | All three final roots freshly verified by opaque destination evidence | `DESTINATION_VERIFIED`, `none`, `0/null` |
| `DESTINATION_VERIFIED` | Deferred Executor-start WAL and installer accept-ready gate completed | `EXECUTOR_STARTED`, `none`, `0/null` |
| `EXECUTOR_STARTED` | Fresh Executor accept-ready plus deferred Control-start WAL completed | `CONTROL_STARTED`, `none`, `0/null` |
| `CONTROL_STARTED` | Fresh authenticated Control disabled readiness | `AUTHENTICATED_DISABLED_READY`, `none`, `0/null` |
| `AUTHENTICATED_DISABLED_READY/none` | Atomic commit and first candidate-policy intent | `COMMITTED`, activation `pending`, plan `candidate-activation-policy`, cursor `0`, pending ordinal 1 |
| `COMMITTED/pending` with candidate policy plan | Executor policy freshly read back and ordinal 1 completed | Same phase, activation and plan, completed ordinal 1, pending null |
| `COMMITTED/pending` with candidate policy plan | Control policy freshly read back and ordinal 2 completed | `COMMITTED/applied`, plan `none`, `0/null`; terminal |
| `SCM_MAINTENANCE_FENCED` or `SERVICES_STOPPED` upgrade before the first root intent | Both services stopped and the previous final roots freshly reverified | `ROLLBACK_IN_PROGRESS`, activation `not-applicable`, plan `none`, `0/null`, rollback checkpoint `roots-restored` |
| `ROOT_SWAP_IN_PROGRESS/none`, `DESTINATION_VERIFIED`, `EXECUTOR_STARTED`, `CONTROL_STARTED`, or `AUTHENTICATED_DISABLED_READY` upgrade | Forward root plan complete, both services stopped, and first rollback rename intent persisted | `ROLLBACK_IN_PROGRESS`, activation `not-applicable`, plan `upgrade-rollback` with pending ordinal 1, rollback checkpoint `not-applicable` |
| `ROLLBACK_IN_PROGRESS/upgrade-rollback` | Non-final rollback rename freshly observed and completed | Same phase and plan, completed ordinal advanced, pending null |
| `ROLLBACK_IN_PROGRESS/upgrade-rollback` | Ordinal 4 freshly observed and previous roots fully reverified | Same phase, plan `none`, `0/null`, rollback checkpoint `roots-restored` |
| `ROLLBACK_IN_PROGRESS`, roots restored | Deferred Executor-start WAL and fresh accept-ready completed | Same phase, checkpoint `executor-started`, `none`, `0/null` |
| `ROLLBACK_IN_PROGRESS/executor-started` | Deferred Control-start WAL completed | Same phase, checkpoint `control-started`, `none`, `0/null` |
| `ROLLBACK_IN_PROGRESS/control-started` | Fresh authenticated disabled readiness | Same phase, checkpoint `authenticated-disabled-ready`, `none`, `0/null` |
| `ROLLBACK_IN_PROGRESS/authenticated-disabled-ready` | First previous-policy intent persisted | Same phase, activation `pending`, plan `rollback-activation-policy`, cursor `0`, pending ordinal 1 |
| `ROLLBACK_IN_PROGRESS/pending` with rollback policy plan | Previous Executor policy freshly read back and ordinal 1 completed | Same phase, activation and plan, completed ordinal 1, pending null |
| `ROLLBACK_IN_PROGRESS/pending` with rollback policy plan | Previous Control policy freshly read back and ordinal 2 completed | `ROLLED_BACK/applied`, plan `none`, `0/null`; terminal |
| Any pre-commit or rollback nonterminal state | A fixed fail-closed condition is durably recordable | `FAILED_CLOSED`, fixed failure code; activation, plan, pending action, completed ordinal, and rollback checkpoint are retained exactly for audit |

There are no other forward, backward, skip, retry, or terminal transitions. An initial installation
cannot enter `ROLLBACK_IN_PROGRESS` or `ROLLED_BACK`. A committed transaction cannot enter rollback
or failed closed because of an activation-policy failure; it remains `COMMITTED/pending` and recovery
continues the fixed candidate-policy plan. When journal corruption prevents a trustworthy terminal
write, the operational disposition is failed closed without manufacturing a matrix state.

The generic next-intent row applies to `materialize-inactive`, `initial-forward`, `upgrade-forward`,
`upgrade-rollback`, `candidate-activation-policy`, and `rollback-activation-policy`. It never
advances the completed cursor. An active plan with cursor zero and `pendingAction=null` is always
invalid: plan entry must atomically select the plan, reset the cursor to zero, and carry the exact
ordinal-1 pending intent. The effect for ordinal `n+1` is forbidden until the record containing that
exact pending action has completed the durable publication protocol. Completion is governed by the
plan-specific rows and always requires a fresh observation.

A plan normally enters on its first durable intent. That record may atomically change phase, select
the plan, reset the cursor to zero, and install pending ordinal 1, as shown for root swap, rollback,
and candidate commit. A completed plan atomically clears `actionPlan` to `none`, clears
`pendingAction`, and resets `completedActionOrdinal` to zero while applying the table's resulting
phase, activation state, candidate roots, or rollback checkpoint.

No plan can switch directly to another plan. The current plan must complete and clear first. The
only permitted later selections are `upgrade-forward` followed, after completion and a rollback
decision, by `upgrade-rollback`; and `upgrade-rollback` followed, after completion, service restart,
and fresh readiness, by `rollback-activation-policy`. `candidate-activation-policy` and
`rollback-activation-policy` are terminal-direction plans and cannot switch. `FAILED_CLOSED` may
retain the last plan and cursor solely to preserve audit context; a reducer must never interpret,
resume, retry, or execute them from that terminal record.

### Durable record replacement

Every active-head or transaction-record publication uses this sequence:

1. Open the retained parent directory and verify its identity, fixed NTFS volume, closed namespace,
   and exact protected ACL.
2. Create the one fixed `.tmp` file with exclusive create semantics and its final protected security
   descriptor. A pre-existing temporary file is handled only by the recovery rules below.
3. Write the complete bounded canonical document, re-read it through the retained handle, verify its
   digest and canonical bytes, and call `FlushFileBuffers` on the temporary file.
4. Atomically rename the temporary file to an absent final name for first publication, or atomically
   replace the existing final file on subsequent publications. Source and destination are in the
   same retained directory; no backup, copy, in-place truncate, or delete-then-rename sequence is
   permitted.
5. Flush the retained parent-directory handle, reopen the final file, and verify its identity,
   security, canonical bytes, digest, transaction ID, and expected sequence.

No transition or external effect may begin until all five steps succeed. The Windows implementation
must demonstrate that its exact file and directory handles and APIs provide the required flush and
atomic-replacement semantics on the supported NTFS systems. If directory durability cannot be
proved, if an API reports an uncertain result, or if any handle cleanup cannot be resolved, the
installer remains fail closed and no production journal writer is available.

A final file plus its valid fixed `.tmp` sibling means the replacement was not published; the final
file remains authoritative and the temporary object may be removed only after its identity and ACL
are reverified. A temporary file without its final file, two temporary candidates, a sequence gap,
or an invalid final file is ambiguous and produces `FAILED_CLOSED`. Recovery never selects the
highest sequence by scanning names or timestamps.

### Every effect has intent and observed completion

Every filesystem or SCM mutation follows one protocol:

```text
intent persisted -> effect attempted -> fresh observation -> completion persisted
```

The intent record retains the current phase or atomically makes the one phase change admitted by the
state matrix, sets `pendingAction`, and advances `recordSequence`. Only after that record is durably
published may the exact effect run. The effect's return value is not completion evidence. The
installer reopens the affected filesystem objects or SCM records and observes the expected identity
and policy. Only then does it publish the next record, clear `pendingAction`, advance the plan cursor
or apply the plan-completion after-state, and advance `recordSequence`.

For a pending directory rename, recovery derives both paths from the fixed slots and compares the
freshly observed root identity with `expectedRoot`:

- the expected identity only at `fromSlot` means the effect did not occur and may be retried;
- the expected identity only at `toSlot` means the effect occurred and completion may be recorded;
- the identity at both slots, neither slot, a different identity, an inaccessible slot, or an
  unprovable parent-directory flush is uncertain and produces `FAILED_CLOSED`.

The same intent/effect/observation/completion protocol applies to future SCM fencing, service
creation, policy changes, stop, and start operations. Their action schemas and platform effects are
blocked until the exact SCM contracts described below are reviewed; they cannot be represented by
inventing additional `RootSlot` values.

### Journaled inactive materialization

Successful staging verification does not imply that any candidate root exists. The installer first
publishes the `STAGING_VERIFIED` transaction record with `candidate.roots=null` and makes that
transaction active. No candidate directory, partial candidate content, candidate ACL, or other
materialization effect may be created before both publications are durable.

Inactive materialization uses only the three transaction-derived candidate slots listed below. It
does not write an active final root, select package metadata, create or change a service, or grant
installation or execution authority. That lack of active authority does not make unjournaled work
acceptable: every candidate creation and population effect uses the same pending-action WAL.

The `materialize-inactive` plan is exactly:

```text
1  create metadata-candidate
2  populate and verify metadata-candidate
3  create installation-candidate
4  populate and verify installation-candidate
5  create trusted-configuration-candidate
6  populate and verify trusted-configuration-candidate
```

The nullable candidate-root shape is fixed at every ordinal:

| Durable point | `candidate.roots` | `metadata` | `installation` | `trustedConfiguration` |
| --- | --- | --- | --- | --- |
| Initial `STAGING_VERIFIED` record, plan entry, and pending ordinal 1 | null | not present | not present | not present |
| Ordinal 1 complete and throughout pending ordinal 2 | object | non-null | null | null |
| Ordinal 2 complete and throughout pending ordinal 3 | object | non-null | null | null |
| Ordinal 3 complete and throughout pending ordinal 4 | object | non-null | non-null | null |
| Ordinal 4 complete and throughout pending ordinal 5 | object | non-null | non-null | null |
| Ordinal 5 complete and throughout pending ordinal 6 | object | non-null | non-null | non-null |
| Ordinal 6 complete and `INACTIVE_PACKAGE_VERIFIED` entered | object | non-null | non-null | non-null |

The `CandidateRootSet` object first appears when ordinal 1 completion records the metadata root
identity. A create-action intent retains the preceding shape; it cannot pre-fill the identity that
the effect has not yet produced. A populate-action intent is valid only when its target member is
already non-null and exactly matches `expectedRoot`. Populate completion does not change nullability
or replace an identity. No later root may be filled early, and no recorded identity may be changed
by a subsequent ordinal.

A create action has no caller-supplied expected identity. Its completion freshly observes the empty
directory, final protected ACL, fixed parent, non-reparse state, default stream, same volume, and
new file ID, then writes that `RootIdentity` into the corresponding partial `CandidateRootSet`.
The following populate action is bound to that recorded identity. It may copy only the matching
logical staged root into the retained candidate directory, apply the final ACL profile, and run the
full candidate verifier before completion.

After restart, a pending create whose derived slot is absent may be retried. If the slot exists but
its identity was not yet recorded, recovery may adopt it only after proving it is the exact empty
directory described by the pending action and then durably recording its freshly observed identity;
otherwise it fails closed. A pending populate must reopen the derived slot, match the identity
already in the record, and fully reverify its contents. Complete content permits completion. Partial
content may be cleaned only by a bounded, handle-relative cleanup that continues to match the
recorded root identity and proves it cannot reach an active or aliased path. If that cleanup cannot
be proved, the partial root remains inactive and recovery fails closed.

No partial candidate may exist outside these transaction-derived slots. Recovery never searches for
or adopts a candidate by name, timestamp, content similarity, or package digest. Completion of
ordinal 6 requires all three candidate identities and complete fresh verification, then atomically
enters `INACTIVE_PACKAGE_VERIFIED` and clears the plan and cursor as specified by the matrix.

### Fixed root slots and forward plans

The derived v1 paths are:

```text
installation-final
  C:\Program Files\AgenticReview\Worker
installation-candidate
  C:\Program Files\AgenticReview\Worker.candidate-<transactionId>
installation-rollback
  C:\Program Files\AgenticReview\Worker.rollback-<transactionId>
installation-inactive
  C:\Program Files\AgenticReview\Worker.inactive-<transactionId>

trusted-configuration-final
  C:\ProgramData\AgenticReview\TrustedConfig
trusted-configuration-candidate
  C:\ProgramData\AgenticReview\TrustedConfig.candidate-<transactionId>
trusted-configuration-rollback
  C:\ProgramData\AgenticReview\TrustedConfig.rollback-<transactionId>
trusted-configuration-inactive
  C:\ProgramData\AgenticReview\TrustedConfig.inactive-<transactionId>

metadata-final
  C:\ProgramData\AgenticReview\Packages\<packageId>
metadata-candidate
  C:\ProgramData\AgenticReview\Packages\<packageId>.candidate-<transactionId>
```

All source and destination pairs are siblings on the same fixed `C:` NTFS volume. V1 does not use
ADR 0013's optional reuse of a pre-existing byte-identical metadata root. `metadata-final` must be
absent before the first root action; its presence blocks the transaction rather than introducing a
second branch.

The `initial-forward` plan is exactly:

```text
1  metadata-candidate                 -> metadata-final
2  installation-candidate             -> installation-final
3  trusted-configuration-candidate    -> trusted-configuration-final
```

The `upgrade-forward` plan is exactly:

```text
1  metadata-candidate                 -> metadata-final
2  installation-final                 -> installation-rollback
3  trusted-configuration-final        -> trusted-configuration-rollback
4  installation-candidate             -> installation-final
5  trusted-configuration-candidate    -> trusted-configuration-final
```

The first root-action intent changes the phase to `ROOT_SWAP_IN_PROGRESS` and selects the plan in
the same durable record. Both services must already be fenced, stopped, and freshly proven to have
no remaining process tree. They remain stopped through every action and destination verification.
Every rename must be followed by a flush of the retained common parent before its completion record
may be published.

After any forward root-action intent is durable, recovery first reconciles that pending action and
then completes the entire forward plan. It never guesses a rollback point in a mixed generation.
If the remaining verified roots cannot complete the plan, the result is `FAILED_CLOSED`. For an
initial installation there is no previous pair and therefore no root rollback; failure after root
mutation either completes the disabled candidate pair or fails closed.

### Upgrade rollback plan

An upgrade may enter `ROLLBACK_IN_PROGRESS` only after all five forward root actions have completed
or after a service-start or readiness failure with the complete candidate generation at the final
roots and the complete previous generation at the rollback roots. The direction is persisted before
the first rollback effect and cannot switch back to forward.

The `upgrade-rollback` plan is exactly:

```text
1  trusted-configuration-final        -> trusted-configuration-inactive
2  installation-final                 -> installation-inactive
3  installation-rollback              -> installation-final
4  trusted-configuration-rollback     -> trusted-configuration-final
```

The new package-specific metadata root is immutable and remains inactive; it is never renamed onto
the previous metadata path and is never deleted by v1 recovery. After action 4, the previous three
roots must be freshly and fully reverified before services may be started in Executor-then-Control
order. After authenticated disabled readiness, restoration of the previous reviewed SCM activation
policy uses the fixed `rollback-activation-policy` WAL plan below. A `ROLLED_BACK/applied` record may
be published only by completing that plan. Any inability to prove those conditions produces
`FAILED_CLOSED`.

### Evidence is process-local and non-durable

No `StagedPackageEvidence`, future destination evidence, enrollment `LiveEvidence`, service token,
native handle, CNG or certificate evidence, `Drained` message, Executor accept-ready observation,
Control readiness attestation, signature, or serialized evidence digest is stored in either journal
document. The ordinary root identities and package digests in a record are recovery selectors only.

After process restart, every evidence-dependent prerequisite is invalid even when the phase records
that it succeeded previously. Before the next dependent effect, the installer must reopen and fully
reverify staging or destination roots, re-read live enrollment facts, re-observe SCM and process-tree
state, and reacquire authenticated drain or readiness as applicable. A journal parser never mints
evidence, and recovery never advances from a historical readiness phase directly to commit.

Unresolved cleanup of opaque evidence or a native handle is process-fatal. It prevents a completion
or commit record and leaves the transaction fail closed for a fresh recovery process.

### Commit and activation policy

Commit is one durable transaction-record replacement from
`AUTHENTICATED_DISABLED_READY/not-applicable` to `COMMITTED/pending`. The same record selects
`candidate-activation-policy`, resets its cursor, and persists its first pending action. It selects
the candidate package metadata as active and cannot be split into separate package and activation
records. Once that record is published, rollback is forbidden. Recovery may only complete this
policy plan and publish `COMMITTED/applied`.

The candidate activation plan is exactly:

```text
1  apply-candidate-executor-policy
2  apply-candidate-control-policy
```

The rollback activation plan is exactly:

```text
1  apply-previous-executor-policy
2  apply-previous-control-policy
```

Each ordinal is a separate WAL cursor. Its intent is durably present in `pendingAction` before the
SCM call. Completion requires a fresh SCM read-back of that service's entire reviewed policy before
the ordinal advances. A crash after changing Executor but before recording completion therefore
reconciles and completes ordinal 1; it cannot skip to Control. The final completion atomically sets
activation to `applied`, clears the plan, pending action, and cursor, and enters the terminal
`COMMITTED/applied` or `ROLLED_BACK/applied` after-state from the matrix.

Rollback policy restoration follows the same durable `pending` then `applied` discipline as
candidate activation. The transition from rollback readiness to `pending` selects
`rollback-activation-policy` and persists its Executor ordinal-1 intent in one record. It never
restores an ambient SCM snapshot: `previous` identifies the previously reviewed split generation,
and the future compiled policy contract must determine the exact expected policy for that
generation.

No exact product decision currently fixes the final automatic-start, delayed-start, failure-action,
failure-delay, reset-period, or related SCM recovery values for both services. This ADR deliberately
does not invent them. Until a later reviewed decision fixes one compiled policy and its exact native
read-back comparison, production SCM mutation code, production transitions into `COMMITTED`, both
candidate policy ordinals, both rollback policy ordinals, and production transitions into
`ROLLED_BACK` are blocked. Caller JSON, package data, XML, environment variables, command-line
flags, or a snapshot of mutable pre-install SCM state cannot supply that policy.

The maintenance fence remains the ADR 0013 policy of demand-start with all failure actions disabled,
but its exact Windows encoding and read-back contract must be fixed with the SCM adapter before the
adapter is used. A journal state alone never proves the fence.

### Corruption and ambiguous recovery

The installer enters the operational `FAILED_CLOSED` disposition, performs no further mutation, and
starts no service when it observes any of the following:

- a malformed, noncanonical, oversized, unknown-version, digest-mismatched, or unknown-field head or
  record;
- an unknown namespace entry, missing active record, active-head mismatch, more than one nonterminal
  transaction, or any independently named or nonconforming candidate for the active head;
- a transaction binding that differs from the signed package, live enrollment, fixed root profile,
  or previous committed record;
- an uncertain rename, unexpected root identity, unexpected hard link or reparse point, cross-volume
  object, path alias, stream, ACL mismatch, or unproved directory flush;
- a state, activation disposition, action plan, ordinal, pending action, or sequence not admitted by
  the closed reducer; or
- an SCM, process-tree, drain, readiness, evidence-cleanup, or destination-verification result that
  cannot be freshly proved.

When the authoritative record is still valid and the failure itself can be durably published, the
installer may publish `FAILED_CLOSED` with the corresponding fixed `failureCode`. If the head,
record, namespace, writer lock, or journal durability is itself untrusted, it must leave the
original bytes untouched and report `FAILED_CLOSED` out of band. It must not rewrite corruption into
an apparently valid terminal record.

Recovery never chooses between records by timestamp, directory order, lexical maximum, sequence
alone, or the apparent presence of executable files. It never recursively deletes an unverified
path. Repair of a failed-closed or ambiguous namespace is a separately reviewed administrative
operation and is not part of v1.

### Deferred platform gates

The following work remains required before the pure transaction contract can become a production
installer:

- an installer-owned, opaque destination verifier for all three final roots;
- a Windows journal writer that proves the exact atomic replace, file flush, directory flush, lock,
  ACL, closed-namespace, cleanup, and power-loss behavior defined here;
- handle-relative candidate materialization, root rename, ACL application, and physical identity
  reinspection on supported NTFS systems;
- a fixed SCM service and recovery-policy ADR plus native create, configure, fence, read-back, stop,
  process-tree absence, start, rollback, and service-object SDDL primitives;
- the pinned WinSW release and verified virtual-account behavior; and
- authenticated installer-facing drain, Executor accept-ready, and Control disabled-readiness
  boundaries.

Drain and readiness remain deferred exactly as in ADR 0013. SCM `SERVICE_RUNNING`, a process exit
code, an unauthenticated file or pipe, or the journal phase is not a substitute. These missing gates
block service-start, readiness, rollback-completion, and commit paths in production code.

### Zero-execution invariant

This journal contains no execution switch, slot override, command, workspace path, repository input,
lease, Claim token, ProcessHost request, or arbitrary environment value. RoleConfig remains
foundation version 2 with execution disabled and zero advertised slots. No phase, pending action,
recovery branch, failure state, installer option, or repaired record can enable Claim or execution.

## Consequences

- The coarse ADR 0013 phases now have an unambiguous write-ahead and completion protocol without a
  general-purpose event-sourcing framework.
- Root-swap crash recovery is deterministic because one pending ordinal identifies the only effect
  that may have crossed the durable boundary.
- The active head identifies one transaction while each transaction retains its own bounded,
  canonical snapshot. Updating a transaction never requires a two-file atomic commit.
- A power loss may conservatively require administrative repair even before a root mutation. This is
  preferred to adopting an unjournaled or multiply active transaction.
- Pure model, codec, reducer, and recovery-planner work may proceed before Windows effects, but none
  of those data checks creates installation authority.
- Production installation remains blocked on destination evidence, Windows durability, exact SCM
  policy, and authenticated installer readiness.

## Deferred Decisions

- the production Go installer command and composition API;
- the concrete destination-evidence API and staged-evidence consumption path;
- the exact Windows filesystem APIs and native x64/arm64 crash evidence that satisfy this contract;
- the exact final and maintenance SCM policy encoding and read-back profile;
- authenticated installer-facing drain and readiness protocols;
- repair, retention, metadata garbage collection, and archival of terminal journals; and
- any future schema migration.

## Non-Goals

This decision does not implement an installer, writer, filesystem mutation, destination verifier,
SCM operation, service launch, readiness probe, enrollment, rotation, download, extraction,
uninstall, legacy migration, or repair tool. It does not define RoleConfig v3, Claim, ProcessHost
launch, Codex execution, repository commands, or dynamic validation.
