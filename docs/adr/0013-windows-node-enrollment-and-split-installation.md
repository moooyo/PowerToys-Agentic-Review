# ADR 0013: Windows Node Enrollment and Split Installation

## Status

Accepted for the dormant RoleConfig v2 zero-execution installation foundation.

## Context

ADR 0007 defines one logical Worker node implemented by two separately supervised Windows
services. ADRs 0009 through 0012 define a node-specific signed package, compiled package trust,
logical admission, and handle-bound verification of an already expanded staging tree. They do not
define how node-bound CNG and mTLS identities exist before package construction, how verified bytes
reach their final roots, or how a complete Control/Executor pair is activated and rolled back.

The ordering is security-critical. The node-specific local-authority SPKI, mTLS certificate digest,
private-key security-descriptor digests, target roots, and service identities are signed package
inputs. They cannot be discovered for the first time while installing that package. Conversely, a
signed index authenticates values but does not prove that those values came from the enrolled node
or describe the physical destination.

RoleConfig v2 remains a zero-execution foundation. Its native construction fixes
`foundationVersion=2`, `executionEnabled=false`, and `maximumSlots=1`, while both role runtimes
advertise zero available slots. ServiceHost bootstrap schema version 3 is not RoleConfig v3.

## Decision

### Enrollment precedes package construction

Privileged node enrollment is a separate operation that completes before any node-specific package
is prepared. Enrollment fixes one `workerNodeId`, target architecture, installation identity,
service names and SIDs, physical root profile, and these two distinct machine-scoped identities:

- a non-exportable P-256 local-authority signing key usable only by the Control service SID, plus
  its canonical PKIX SPKI bytes, key name, and protected-DACL digest; and
- a non-exportable mTLS private key usable only by the Control service SID, plus the Local Machine
  `MY` certificate DER digest and private-key protected-DACL digest.

Both keys use the machine-scoped `Microsoft Software Key Storage Provider`, `ECDSA_P256`, a
256-bit key, signing-only usage, and `ExportPolicy=0`. They are separate persisted-key identities.
Each protected key DACL contains only `SYSTEM`, local Administrators, and the Control service SID;
Executor has no ACE, and Control cannot change the owner or DACL.

The exact service identities are:

```text
NT SERVICE\AgenticReview.Worker.Control
S-1-5-80-2091717111-3815740202-2957909909-902494971-3397275836

NT SERVICE\AgenticReview.Worker.Executor
S-1-5-80-2741783613-3141871344-3258369507-3627446740-1359970993
```

Enrollment also establishes the Server-side binding from the mTLS certificate digest to the same
`workerNodeId`. It does not install runtime files, create either service, start a process, admit a
package, or create execution authority. Failure after creating a key or certificate does not imply
that deleting it is safe; incomplete enrollment is quarantined for explicit recovery or revocation.

A later trusted enrollment reader must provide opaque, independently observed facts to the release
and installer paths. Caller-authored JSON, command-line values, environment variables, or the
ordinary fields accepted by `outerpackage.BuildIndex` cannot become enrollment authority. The
concrete enrollment evidence format and rotation protocol remain deferred.

### Initial installation requires a clean runtime host

The first profile supports initial installation only on an enrolled host with no existing Worker
service or runtime installation. The installer must fail closed if it finds the legacy
`AgenticReview.Worker` service, the legacy single-service configuration or runtime root, either
split service in a partial state, or an unjournaled split installation. Legacy-to-split conversion
requires a separate migration ADR with its own credential rotation, root ownership, service
removal, and rollback rules. It is not an initial-install or rollback case in this decision.

A host with a previously committed split package may use the split-to-split upgrade procedure
below. "Clean" describes the initial Worker runtime state; it does not erase the enrollment keys,
certificate, or approved node identity that must already exist before package construction.

### Fixed physical root profile

The first split installation profile uses these exact physical roots on the local `C:` NTFS volume:

```text
C:\Program Files\AgenticReview\Worker
C:\ProgramData\AgenticReview\TrustedConfig
C:\ProgramData\AgenticReview\Control
C:\ProgramData\AgenticReview\Executor
C:\ProgramData\AgenticReview\ServiceWrapper\Control
C:\ProgramData\AgenticReview\ServiceWrapper\Executor
C:\ProgramData\AgenticReview\Installer
C:\ProgramData\AgenticReview\Packages\<packageId>
C:\ProgramData\AgenticReview\Staging\<transactionId>
```

The signed `targetRoots.installation` and `targetRoots.trustedConfiguration` values must equal the
first two paths. The signed metadata root must be the canonical package-specific path under
`C:\ProgramData\AgenticReview\Packages`. The staging root is transport state and is not a target
root. Control and Executor data roots and the two ServiceWrapper log roots persist across package
replacement and are never package payload roots. Wrapper logs remain outside the exact role data-
root closures verified by ServiceHost. Each wrapper-log root has protected inheritance: its matching
service SID has only the modification rights required for log creation and rotation, the peer SID
has no access, and only `SYSTEM` and local Administrators have full control.

Every path component is a real directory. Junctions, symbolic links, mount points, other reparse
points, hard-link aliases, alternate data streams, case-sensitive directories, case aliases, and
cross-volume objects are forbidden. An installer must open from retained volume-root handles and
verify parent identity, ACL, volume, and non-reparse state; lexical prefix checks are insufficient.
Changing drive or root layout requires a new reviewed installation profile and a newly signed
node-specific package. A `current` junction or other mutable indirection is not permitted.

### Staged evidence has one in-process consumer

The future production installer is one privileged Go process. That process calls
`stagedpackage.Verify`, owns the returned opaque `StagedPackageEvidence`, calls its validation
method immediately before consuming it, and closes it before process exit. The evidence must never
be serialized, written to the transaction journal, sent over IPC, reconstructed after restart, or
converted into caller-authored path and digest data.

Staged evidence authorizes only consumption of the retained staging closure. Moving or copying
content changes the physical identity to which that evidence is bound. The installer must therefore
reopen and fully reverify the complete destination closure at the signed roots before it may treat
the destination as installed. A restarted installer must verify staging and destination state anew;
the journal cannot resurrect evidence. Unresolved evidence cleanup is process-fatal and prevents
commit.

This decision selects destination reopen and full re-verification rather than relying on an
unproven handle-preserving directory transfer. It does not define the destination evidence API.

### Complete inactive package replacement

Installation and upgrade operate on a complete package pair, never individual Control or Executor
files. Before touching an active root, the installer materializes complete metadata, installation,
and trusted-configuration candidates as physical sibling directories on the same volume, applies
the final protected ACLs, and verifies their full closure. The metadata candidate includes the
package index, detached signature envelope, and all five indexed metadata payloads. Templates,
source maps, scripts, build metadata, and any other unindexed object are excluded.

For an upgrade, Control is drained and must report authenticated `Drained`. Before stopping either
service, the installer durably enters SCM maintenance fencing: both services are changed to demand-
start, every failure action is disabled, and those exact settings are read back from SCM. Control is
then stopped before Executor, and the installer proves both service process trees absent before
changing roots. On a clean initial install, verified absence of both service records is the
maintenance fence; after destination placement, the service records are created directly in demand-
start with failure actions disabled.

Only after that fence does the installer rename the old installation and trusted-configuration
roots to transaction-owned rollback siblings and the complete candidates to all three exact final
roots. The package-specific metadata target must not already exist, except that an independently
reverified byte-identical immutable closure may be reused. The installer never overwrites files in
place and never runs from a candidate or rollback path.

Two directory renames are not one filesystem transaction. A protected, durable installer journal
records each transition before the corresponding mutation. While any root is in an intermediate or
mixed generation, both services remain stopped. Destination verification must bind all three final
physical roots, signed package index and envelope, bootstraps, enrolled identities, release
manifest, and exact ACL profile before startup.

Package-specific metadata is immutable after placement and is selected as active only by the
committed journal record. Rollback may retain a fully verified new metadata root as inactive, but
must never overwrite it or use it with the restored package pair. Role data, wrapper logs,
workspaces, and credentials are not part of the package swap. The old package pair and its metadata
remain intact until the new transaction is committed or rollback has completed.

### Installation transaction and rollback

The durable transaction has these monotonic states:

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
COMMITTED / ACTIVATION_POLICY_PENDING
COMMITTED / ACTIVATION_POLICY_APPLIED
```

`ROLLBACK_IN_PROGRESS` begins the recovery branch; `ROLLED_BACK` and `FAILED_CLOSED` are terminal
states. Each transition records the transaction ID, package and installation IDs, signed index
digest, previous and candidate release identities, exact root identities, and the completed
mutation. It records no secret, private-key material, or serialized opaque evidence.

`QUIESCED` means that an upgrade received authenticated `Drained` from the active Control service,
or that an initial installation proved there was no prior split or legacy service to drain.
Before its first SCM policy mutation, the installer durably records maintenance-fence intent.
Recovery that sees the intent idempotently applies or verifies demand-start and zero failure actions
for each existing split service. `SCM_MAINTENANCE_FENCED` is entered only after both services have
that exact policy, or a clean initial install has proved both service records absent. Root mutation
cannot begin before this state and `SERVICES_STOPPED` with both process trees proven empty.

Before `ROOT_SWAP_IN_PROGRESS`, failure discards only the inactive candidate after revalidating its
recorded root identity. During or after root swapping, crash recovery keeps both services stopped,
inspects the journal and physical root identities, and either finishes the complete new pair or
restores the complete previous pair. It never guesses from directory names and never recursively
deletes an unverified path.

Failure after either service starts first stops both services and proves their process trees absent.
Rollback may restore only a previously verified, protocol-compatible, complete split package pair
and its matching trusted configuration. The restored pair starts Executor before Control and must
again reach authenticated disabled readiness. Rollback never restores the legacy single-service
Worker and never removes or silently replaces enrolled keys or certificates.

A successful rollback restores the previous reviewed automatic-start and failure-recovery policy
through the same durable `PENDING` then verified `APPLIED` substate before recording `ROLLED_BACK`.
If that restoration cannot be proved, the services remain demand-start with failure actions
disabled and the transaction ends `FAILED_CLOSED`.

Pre-commit service starts are explicit installer actions while demand-start and zero failure actions
remain in force. The installer starts Executor, requires its installer-activation readiness, starts
Control, and requires authenticated disabled readiness. An unexpected exit cannot be hidden by SCM
or WinSW restart behavior during this validation.

The durable write that commits the package also sets activation policy to `PENDING`; there is no
committed state whose activation-policy disposition is absent. Only after commit may the installer
apply the reviewed automatic-start and failure-recovery policy to both services. It verifies the
exact SCM result and then writes `ACTIVATION_POLICY_APPLIED`. If the installer or machine fails
before that write, recovery rolls forward rather than rolling back the committed package: it
idempotently reapplies and verifies both policies, tolerating the case where one service changed or
both changed but the final journal write did not occur. The desired policy is reviewed installer
configuration, not a snapshot of mutable pre-install SCM state.

### Service activation order

The package contains these exact wrapper and same-basename configuration payload paths:

```text
AgenticReview.Worker.Control.exe
AgenticReview.Worker.Control.xml
AgenticReview.Worker.Executor.exe
AgenticReview.Worker.Executor.xml
```

Each wrapper launches the signed, manifest-pinned `AgenticReview.ServiceHost.exe` as its direct
child and passes only one absolute `--config` selector. ServiceHost, not WinSW, verifies and launches
the corresponding `app\control.mjs` or `app\executor.mjs` bundle. WinSW configuration never launches
Node directly and contains no application settings, credentials, package trust, RoleConfig fields,
execution flag, SCM start mode, delayed-start setting, failure action, or failure-reset policy.

The privileged installer creates and verifies both `SERVICE_WIN32_OWN_PROCESS` services under the
fixed distinct virtual accounts, applies `SERVICE_SID_TYPE_RESTRICTED`, service-object ACLs,
recovery policy, filesystem ACLs, CNG and certificate ACLs, firewall policy, and machine-enforced
Codex policy before startup. XML does not establish those privileged facts.

During installer activation, Executor starts first. An SCM `RUNNING` state is not readiness evidence;
the installer requires Executor's stricter local accept-ready state before explicitly starting
Control. Control then performs the authenticated ARWX handshake and must receive a fresh Executor
`Ready` attestation bound to the installed package, boot ID, policy, preflight, and zero capacity.
Failure to obtain that attestation before commit stops the pair and enters rollback or
`FAILED_CLOSED`; installer activation never degrades to an SCM-only readiness check.

Ordinary boot has a narrower ordering rule. After activation policy is applied, SCM may start
Control once Executor is `SERVICE_RUNNING`; it does not run the installer-only accept-ready gate.
Control must withhold every Server readiness and slot report and must not Claim until its new process
has completed a fresh authenticated ARWX handshake and accepted the corresponding Executor `Ready`
attestation. Only then may it report the RoleConfig v2 disabled state: zero available slots and
`EXECUTION_DISABLED`. Claim remains impossible after the gate as well.

The mechanism by which the installer observes the final Control readiness result is deferred. It
must be an authenticated, typed health boundary and must not add a second pipe peer or an execution
authority path.

### Zero-execution invariant

There is no enable switch in enrollment, the package index, the transaction journal, WinSW XML,
the installer command line, bootstrap configuration, environment variables, or recovery state.
`WORKER_EXECUTION_ENABLED`, slot overrides, and legacy Worker arguments are forbidden. Package
descriptor `executionAuthority=false` and RoleConfig v2 constants are assertions that must agree;
neither can be changed by installation input.

Claim, `StartAttempt`, ProcessHost launch, repository command execution, and dynamic validation
remain blocked. A future RoleConfig v3 or any execution-capable configuration requires a separate
ADR, authority design, implementation review, signed package profile, and the complete native
Windows verification matrix from ADR 0007. This ADR supplies no migration switch.

## Consequences

- Node enrollment, node-specific package construction, staging verification, destination
  verification, service provisioning, and activation are distinct fail-closed phases.
- Upgrade downtime is intentional: a complete inactive pair is verified before the active pair is
  stopped and no mixed generation is allowed to run.
- The split WinSW templates are signed package inputs, not an installer and not proof of SCM, ACL,
  start/recovery policy, credential, firewall, or physical-root state.
- The existing `deploy/worker/install-worker.ps1` and legacy single-service template remain
  unchanged and are not a base for this profile.
- Native Windows x64 and arm64 installation, crash recovery, ACL, identity, CNG, certificate,
  WinSW, pipe, readiness, upgrade, rollback, and uninstall evidence remains mandatory before any
  production use.

## Deferred Decisions

- the trusted enrollment evidence schema, secure storage, certificate issuance, Server binding
  publication, rotation, revocation, and interrupted-enrollment recovery;
- the production Go installer API and destination-verification evidence type;
- the durable journal encoding, write-through and directory-flush primitives, and exact crash
  recovery algorithm;
- the pinned WinSW build, verified virtual-account installation behavior, service SDDL, and native
  recovery-policy validation;
- the authenticated installer-facing observation of Control's disabled readiness result; and
- archive, download, extraction, uninstall, and retention policy for immutable package metadata;
- legacy-to-split migration, including legacy credential rotation and service/root removal.

## Non-Goals

This decision does not implement enrollment, signing, download, extraction, installation,
destination verification, journaling, rollback, SCM mutation, ACL mutation, CNG or certificate
mutation, firewall changes, service launch, a readiness probe, RoleConfig v3, Claim, or execution.
