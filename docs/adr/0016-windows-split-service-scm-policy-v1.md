# ADR 0016: Windows Split-Service SCM Policy v1

> Superseded before publication by ADR 0026. ServiceHost now integrates directly with SCM; the WinSW
> binary, XML, wrapper lifecycle, and wrapper-specific timing values below are historical only. The
> journal-coupled maintenance fence, upgrade, rollback, and blocked final-policy lifecycle are
> retired.
>
## Status

Historical implementation record; superseded before publication by ADR 0026.

Current installer work must start from ADR 0026. The remaining sections below preserve historical
SCM analysis and do not create a production prerequisite unless a later decision explicitly reuses
one value.

This ADR resolves only the portions of the SCM deferral in ADRs 0013 and 0015 that can be fixed
without inventing product recovery values or claiming untested WinSW behavior. RoleConfig remains
foundation version 2 with execution disabled and zero advertised slots.

For initial creation, this ADR deliberately refines ADR 0013's direct demand-start step. A service
is first created disabled, its independent create and security mutations are journaled separately,
and demand-start is applied only after the complete pair is securely configured. ADR 0013's final
pre-start target remains demand-start with recovery disabled.

For service-object query rights, this ADR supersedes the query-status-only rows in ADR 0007. The
existing native identity preflight requires query-config and query-status on both own and peer
records. This refinement adds no start, stop, mutation, ownership, or DACL authority except the
already reviewed Control-to-Executor start/stop kill switch.

## Context

ADR 0013 fixes one logical Worker node as two `SERVICE_WIN32_OWN_PROCESS` services, requires a
demand-start and no-recovery maintenance fence before root mutation, starts Executor before
Control, and restores a reviewed automatic-start and failure-recovery policy only after package
commit. ADR 0015 freezes the filesystem transaction and journal-first rule, but its v1 pending-
action union represents neither service creation nor the individual SCM effects needed to fence,
stop, start, or configure a service. Its two policy actions also lack an exact final policy.

The two signed WinSW XML payloads fix the wrapper-to-ServiceHost launch relationship, Control's
dependency on Executor, a 330-second wrapper stop timeout, and separated log roots. They
intentionally do not configure the service account, service SID type, SCM start policy, recovery
policy, service-object security descriptor, required privileges, or preshutdown behavior.

ServiceHost is the wrapper's direct child, not the Windows service process registered with SCM.
ServiceHost owns native preflight, the Node root Job, HostControl, and the ARWX relays. WinSW owns
the SCM handler and the translation of SCM controls and child exit into wrapper behavior. A policy
cannot infer that translation from ServiceHost source or from generic WinSW documentation.

## Decision

### Policy authority and identifiers

The contract identifier is:

```text
agentic-review-windows-split-service-scm-policy-v1
```

Any future privileged Go installer must recognize this identifier only for the fixed values and
blocked gates in this decision. The identifier does not name a production-complete final policy;
no such profile exists until the final recovery and preshutdown gates are resolved. The identifier
and every fixed value below are installer constants, not package fields. A package index, WinSW XML
element, ServiceHost configuration, environment variable, command-line argument, registry
override, existing service snapshot, or journal field cannot supply or replace an SCM policy value.

The signed XML bytes are a cross-check for the wrapper launch contract. The installer does not
derive SCM authority by parsing the XML. It independently applies this compiled contract and then
reads the complete service state back from SCM.

All SCM operations target the local machine. Remote service management, `sc.exe`, PowerShell
service cmdlets, direct service-registry writes, WMI, and WinSW's install or uninstall commands are
not production installer primitives.

### Minimal native handle access

Every SCM handle is opened for one fixed purpose with the exact numeric access mask below. Generic
rights, `SC_MANAGER_ALL_ACCESS`, `SERVICE_ALL_ACCESS`, `ACCESS_SYSTEM_SECURITY`, and any unlisted
bit are forbidden. A future adapter cannot combine masks for convenience.

| Handle purpose | Exact desired access |
| --- | --- |
| Open one named service | `SC_MANAGER_CONNECT` (`0x00000001`) |
| Create one service | `SC_MANAGER_CREATE_SERVICE` (`0x00000002`) |
| `CreateServiceW` returned service handle | no service access (`0x00000000`) |
| One `ChangeServiceConfigW` or `ChangeServiceConfig2W` mutation | `SERVICE_CHANGE_CONFIG` (`0x00000002`) |
| Set owner, group, and DACL | `WRITE_DAC | WRITE_OWNER` (`0x000c0000`) |
| Send one stop control | `SERVICE_STOP` (`0x00000020`) |
| Start one service | `SERVICE_START` (`0x00000010`) |
| Complete fresh service read-back | `READ_CONTROL | SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | SERVICE_ENUMERATE_DEPENDENTS` (`0x0002000d`) |

The lookup and create manager handles are distinct and short-lived. `CreateServiceW` returns a
zero-access handle that is closed without being used for security, mutation, or observation.
Whether that zero mask and the exact intermediate record behave as required on every supported
Windows build is a native x64 and arm64 blocker.

Each `OpenSCManagerW` call requests exactly the one table mask; the API's connection operation does
not justify OR-ing `SC_MANAGER_CONNECT` into the create mask. If a supported host does not admit
one of these minimal masks, installation remains blocked pending a reviewed contract change rather
than broadening access at runtime.

After a durable intent, one mutation opens its exact minimal service handle, performs one native
effect, and closes the handle. Completion uses a separately opened `0x0002000d` read-back handle;
an effect return value or a mutation handle is never observation evidence. A handle does not cross
an authoritative journal-record publication. Failure to open or close any handle is fail closed.

This policy does not use `LockServiceDatabase`. On currently supported Windows versions that API is
a compatibility operation without effective database-lock semantics, so it cannot serialize this
installer against an administrator. ADR 0015's journal writer lock serializes only reviewed
installer processes. Any concurrent external SCM drift is detected by the fresh complete snapshot
and fails closed; it is not prevented or repaired by claiming a system-wide lock.

The service-security action calls `SetServiceObjectSecurity` with exactly
`OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION`
(`0x00000007`). It does not request SACL access and does not pass
`PROTECTED_DACL_SECURITY_INFORMATION` as an unreviewed extra flag. The input descriptor itself has
the protected-DACL control bit. `QueryServiceObjectSecurity` uses the same exact `0x00000007`
information mask, and the fresh read-back must prove that the bit persisted. Exact preservation of
that control bit with `0x00000007` remains a native blocker; failure does not permit adding another
flag or broadening the handle.

The SCM-mutating installer identity is privileged but not yet fixed. Because the final
service-object DACL grants configuration authority only to Local System and local Administrators,
production mutation requires one of those exact trusted identities unless a later decision changes
the DACL. A low-privilege release reader cannot perform these actions. The mutator token and its
effect on the default descriptor created by `CreateServiceW` require separate native evidence.

### Fixed service identities and launch records

The exact service records are:

| Field | Control | Executor |
| --- | --- | --- |
| Service name | `AgenticReview.Worker.Control` | `AgenticReview.Worker.Executor` |
| Display name | `Agentic Review Worker Control` | `Agentic Review Worker Executor` |
| Description | `Hosts the zero-execution Agentic Review Worker Control role.` | `Hosts the zero-execution Agentic Review Worker Executor role.` |
| Binary path | `"C:\Program Files\AgenticReview\Worker\AgenticReview.Worker.Control.exe"` | `"C:\Program Files\AgenticReview\Worker\AgenticReview.Worker.Executor.exe"` |
| Wrapper configuration | `C:\Program Files\AgenticReview\Worker\AgenticReview.Worker.Control.xml` | `C:\Program Files\AgenticReview\Worker\AgenticReview.Worker.Executor.xml` |
| Wrapper direct child | `C:\Program Files\AgenticReview\Worker\native\AgenticReview.ServiceHost.exe` | same |
| ServiceHost argument | `--config="C:\ProgramData\AgenticReview\TrustedConfig\control-service-host.json"` | `--config="C:\ProgramData\AgenticReview\TrustedConfig\executor-service-host.json"` |
| Working directory | `C:\Program Files\AgenticReview\Worker` | same |
| Service account | `NT SERVICE\AgenticReview.Worker.Control` | `NT SERVICE\AgenticReview.Worker.Executor` |
| Service SID | `S-1-5-80-2091717111-3815740202-2957909909-902494971-3397275836` | `S-1-5-80-2741783613-3141871344-3258369507-3627446740-1359970993` |
| Dependencies | one exact multi-string entry: `AgenticReview.Worker.Executor` | empty multi-string |

The SCM binary path contains the quoted same-basename WinSW executable and no arguments. WinSW
finds its signed same-basename XML beside that executable. The XML, not the SCM binary path, passes
the one fixed `--config` argument to ServiceHost. No service record or XML element passes Node,
RoleConfig, slot, Claim, credential, package, or execution values.

The service account password pointer is null. A password, managed-service-account suffix, built-in
service account, interactive account, domain account, or shared account is invalid. The load-order
group is empty and the tag ID is zero. There are no trigger-start conditions.

### Fixed creation and static policy

A newly created role service must reach the following creation target before it is eligible for
start. `CreateServiceW` supplies the fields it supports directly; the remaining rows require the
separate post-create actions listed below.

| Field | Required value |
| --- | --- |
| `dwServiceType` | `SERVICE_WIN32_OWN_PROCESS` only |
| `CreateServiceW.dwStartType` | `SERVICE_DISABLED` |
| fully configured pre-start `dwStartType` | `SERVICE_DEMAND_START`, applied only after both records are secured and configured |
| `dwErrorControl` | `SERVICE_ERROR_NORMAL` |
| `lpLoadOrderGroup` | null |
| `lpdwTagId` | null; `dwTagId` must read back as zero |
| `lpServiceStartName` | the exact role-specific virtual account above |
| `lpPassword` | null |
| delayed auto-start | false |
| service SID type | `SERVICE_SID_TYPE_RESTRICTED` |
| required privileges | one exact multi-string entry: `SeChangeNotifyPrivilege` |
| failure action reset period | `0` |
| failure reboot message | empty |
| failure command | empty |
| failure action count | `0` |
| failure actions | no entries, not one or more `SC_ACTION_NONE` entries |
| failure actions on non-crash failures | false |
| preshutdown timeout | unavailable; no value may be selected until the WinSW gate is resolved |
| preferred NUMA node | no setting; exact query and clearing ABI remain a native blocker |
| launch protection | `SERVICE_LAUNCH_PROTECTED_NONE` |
| service triggers | none |

Control's `lpDependencies` is the exact double-NUL-terminated multi-string
`AgenticReview.Worker.Executor\0\0`. Executor's `lpDependencies` is null and must read back as an
empty dependency set. The binary path, account, and display-name pointers are non-null and contain
the exact values above. No create-call output value is accepted as read-back evidence.

The post-create configuration shapes are also closed. Description uses
`SERVICE_DESCRIPTIONW` with the role's exact non-null UTF-16 string. SID configuration uses
`SERVICE_SID_INFO(SERVICE_SID_TYPE_RESTRICTED)`. Required privileges use
`SERVICE_REQUIRED_PRIVILEGES_INFOW` with the exact double-NUL-terminated multi-string
`SeChangeNotifyPrivilege\0\0`. Service security is applied from a descriptor with the fixed owner,
group, DACL, and protected-DACL control, then re-read as a self-relative descriptor. No
configuration call uses an opaque caller buffer or leaves an unrelated mutable field selected.

The required-privilege list is closed. If the pinned wrapper, ServiceHost, Node runtime, CNG
provider, certificate provider, or supported Windows build needs another privilege, production
installation remains blocked until a new review changes this contract and the native token matrix
proves the change. A runtime may not silently retain an extra privilege.

Creation alone is never secure configuration. The create action completes only after one
`CreateServiceW` mutation and a fresh observation of the exact disabled intermediate record. A
separate durable security intent must then precede the service-security mutation. The installer
must independently apply and verify the protected descriptor, description, service SID type,
required-privilege list, delayed-start value, failure-action record, failure-actions flag, and the
still-blocked preshutdown value. Only after both roles reach that complete configured state may
separate start-type actions change Executor and then Control from disabled to demand-start.

An initial install rejects either pre-existing split service before publishing a create intent.
After a create intent is durable, recovery may complete it only when the service is stopped with no
process and its entire record matches the exact native-verified disabled intermediate profile,
including the default service-object descriptor produced by the fixed installer identity. The
next record persists the independent security intent before applying the final protected
descriptor. The default descriptor is not acceptable after that security ordinal completes.

That intermediate profile must at minimum prove the exact service type, binary path, account,
dependency set, display name, error control, `SERVICE_DISABLED`, stable stopped state, empty
failure-action table, false non-crash flag, no trigger, and no launch protection. Its service SID,
required-privilege, description, preshutdown, and security values must match the one frozen native
default shape for the cursor, but none is treated as final configuration.

Production creation remains blocked until supported native Windows evidence freezes that exact
intermediate descriptor and proves that it grants no non-administrator start, change-config,
write-DACL, write-owner, or delete authority. Any other intermediate shape is `SCM_UNPROVED`;
recovery does not delete, secure, or otherwise mutate it without the corresponding durable action.

### Service-object security descriptors

The owner and primary group are Local System. The DACL is present, non-null, protected from
inheritance, non-defaulted, and contains exactly four allow ACEs with no object, callback,
conditional, inherited, or deny ACEs. There is no SACL decision in this profile.

The canonical policy SDDL for Control is:

```text
O:SYG:SYD:P(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLC;;;S-1-5-80-2091717111-3815740202-2957909909-902494971-3397275836)(A;;CCLC;;;S-1-5-80-2741783613-3141871344-3258369507-3627446740-1359970993)
```

The canonical policy SDDL for Executor is:

```text
O:SYG:SYD:P(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCRPWP;;;S-1-5-80-2091717111-3815740202-2957909909-902494971-3397275836)(A;;CCLC;;;S-1-5-80-2741783613-3141871344-3258369507-3627446740-1359970993)
```

`SY` and `BA` receive service full control. Both service identities receive only
`SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS` on both records so the existing native identity
preflight can verify own and peer service type, account, SID type, and status. Control additionally
receives `SERVICE_START | SERVICE_STOP` on Executor, which is the local kill-switch authority fixed
by ADR 0007. Neither service receives change-config, enumerate-dependent, pause/continue,
interrogate, user-defined-control, delete, read-control, write-DACL, or write-owner rights.

The corresponding access masks are exact: service full control is `0x000f01ff`, query config and
status are `0x00000005`, and query config/status plus start/stop are `0x00000035`. The SDDL rights
`CC`, `LC`, `RP`, and `WP` mean `SERVICE_QUERY_CONFIG`, `SERVICE_QUERY_STATUS`, `SERVICE_START`, and
`SERVICE_STOP` on a service object. Query access is bootstrap evidence access, not installation or
configuration authority. This policy does not replace the separate process-object and token-object
DACLs applied by ServiceHost.

Implementation must compare the owner, group, descriptor control flags, and normalized numeric ACE
masks read from a self-relative descriptor. Text emitted by `sc sdshow`, ACE display order alone, or
a string comparison against an OS-reformatted SDDL is not evidence.

### Exact maintenance fence

The maintenance target for both existing services is:

```text
startType = SERVICE_DEMAND_START
delayedAutoStart = false
failureResetPeriodSeconds = 0
failureRebootMessage = empty
failureCommand = empty
failureActions = []
failureActionsOnNonCrashFailures = false
```

Every fixed identity, binary path, display name, description, account, dependency, service type,
error control, SID type, required privilege, service-object security, launch-protection, trigger,
and eventual preshutdown field must simultaneously match its compiled expected value. Maintenance
does not repair an unknown static field by copying values from the package or ambient service.

Before publishing ordinal 1, the installer must freshly prove that both service records match the
previous generation's complete compiled static and final policy. A mismatch blocks every SCM
mutation; maintenance is not a repair path for an unrecognized or partially configured service.

For an upgrade, the WAL order is Control first, then Executor. For each role it clears the failure-
action table before clearing the non-crash flag, clears delayed auto-start before changing the
start type, and changes the start type last. This prevents a still-installed recovery action from
restarting a service merely because demand-start was selected. Neither service may be stopped and
no root may be mutated until the complete pair has been freshly read back at the maintenance
target.

The exact failure-action clear postcondition is fixed by the maintenance target, but its raw
`SERVICE_FAILURE_ACTIONSW` input representation is not yet authorized. Windows distinguishes null
pointers that preserve fields from non-null inputs that clear them. The repository has source-level
examples of a zero action count paired with a non-null sentinel, but it has no native x64 or arm64
evidence proving one bounded call clears the action array, reset period, reboot message, and command
exactly as required. Both `clear-*-failure-actions` actions therefore remain blocked until the raw
structure and complete read-back are proven on the pinned Windows matrix. Library source or a
successful return code is not evidence. If the target requires more than one native mutation, the
schema-v2 maintenance and creation plans must allocate an independent WAL ordinal to each call and
renumber the later actions; a helper may not hide them behind the current single clear ordinal.

The next action writes `SERVICE_FAILURE_ACTIONS_FLAG(FALSE)`. Delayed-start clearing writes
`SERVICE_DELAYED_AUTO_START_INFO(FALSE)`. A demand-start action uses `ChangeServiceConfigW` with
only `dwStartType=SERVICE_DEMAND_START`; every unrelated change field is `SERVICE_NO_CHANGE` or
null as required by the API.

The maintenance observation accepts only stable `SERVICE_RUNNING` or stable `SERVICE_STOPPED`.
Pending, paused, pause-pending, or continue-pending state is not a completed fence. A stopped
service must have no live wrapper or descendant process; a running service must have one stable
wrapper identity matching the signed package and the expected service record.

On a clean initial install, verified absence of both split and legacy services is the maintenance
fence before root mutation. After destination verification, each new record is created disabled,
secured and configured under its independent WAL actions, and only then moved in
Executor-before-Control order to the same demand-start and no-recovery pre-start target.

### Final activation policy is deliberately unavailable

Existing decisions determine only these final invariants:

- both services use `SERVICE_AUTO_START` after activation policy is applied;
- Control retains its exact dependency on Executor;
- `SC_ACTION_REBOOT` and `SC_ACTION_RUN_COMMAND` are forbidden;
- the reboot message and command remain empty; and
- each role's eventual non-empty action array contains one or more bounded
  `SC_ACTION_RESTART` entries followed by exactly one terminal `SC_ACTION_NONE` with zero delay.

Windows repeats the last configured action for later failures, so a final `SC_ACTION_RESTART`
would be an unbounded restart loop and is forbidden. Existing decisions still do not uniquely
determine delayed auto-start, the number of restart actions, each restart delay, the reset period,
whether Control and Executor use the same schedule, or
`FailureActionsOnNonCrashFailures`. This ADR does not choose those values. No caller, package,
existing-service snapshot, XML default, WinSW default, or platform default may fill them in.

Consequently there is no valid compiled final-activation profile yet. Production code must not
apply either candidate or previous activation policy, publish `COMMITTED/applied`, or publish
`ROLLED_BACK/applied`. The first later decision that supplies the missing values must define the
complete two-service policy, not a partial override, and must add native Windows recovery tests for
every configured failure ordinal and reset boundary.

### Wrapper stop and preshutdown gate

Both signed XML files contain exactly:

```xml
<stoptimeout>330 sec</stoptimeout>
```

This is a WinSW child-stop timeout, not an SCM service configuration field. It leaves a 30-second
outer margin around ServiceHost's maximum 300-second graceful shutdown budget. This ADR does not
equate it with the machine-wide `WaitToKillServiceTimeout`, `ServicesPipeTimeout`, an installer
wait deadline, or `SERVICE_CONFIG_PRESHUTDOWN_INFO`. The installer must not change either machine-
wide registry value.

No pinned WinSW release currently proves all of the following on both x64 and arm64:

- which of `SERVICE_CONTROL_STOP`, `SERVICE_CONTROL_SHUTDOWN`, and
  `SERVICE_CONTROL_PRESHUTDOWN` the wrapper accepts;
- how each accepted control is delivered to ServiceHost;
- whether the wrapper waits for the exact XML stop timeout and what it does at expiry;
- whether ServiceHost's exit code is preserved as the service-specific or process exit result;
- whether an absent XML `onfailure` element creates no wrapper-owned restart loop; and
- whether SCM failure actions and WinSW child-exit handling compose without duplicate or hidden
  restart attempts.

The SCM preshutdown timeout and accepted-control expectations are therefore unresolved. No
`ChangeServiceConfig2W(SERVICE_CONFIG_PRESHUTDOWN_INFO)` action may be implemented, no production
service may be started, and no stop or recovery claim may be made until a pinned WinSW version and
native evidence resolve this gate. Generic WinSW documentation or behavior observed from another
version is insufficient.

### Complete SCM read-back snapshot

Every create, configure, fence, stop, start, candidate-policy, and rollback-policy completion must
open the exact local service name afresh and obtain a bounded, stable snapshot. It reads at least:

- `QueryServiceConfigW`: service type, start type, error control, quoted binary path, load-order
  group, tag ID, dependency multi-string including order and termination, account, and display
  name;
- `QueryServiceConfig2W`: description, delayed auto-start, service SID type, required-privilege
  multi-string, failure actions including reset period, command, reboot message, action count,
  action type and delay, failure-actions-on-non-crash flag, preshutdown timeout, launch-protected
  value, trigger information, and `SERVICE_CONFIG_PREFERRED_NODE` information level 9;
- `QueryServiceStatusEx`: service type, current state, controls accepted, Win32 exit code,
  service-specific exit code, checkpoint, wait hint, process ID, and service flags;
- `QueryServiceObjectSecurity`: owner, group, DACL control flags, and every ACE; and
- `EnumDependentServicesW` with `SERVICE_STATE_ALL`: no dependent of Control and exactly Control as
  Executor's sole dependent within the closed split-service installation profile.

Null and empty string or multi-string pointer forms are normalized only after the native API call;
normalization cannot erase a non-empty value, malformed terminator, duplicate dependency or
privilege, unexpected action, or extra trigger. Variable-length calls use bounded retry counts and
hard maximum buffers. A value that changes between two observations, an unsupported information
level, access denial, truncation, malformed multi-string, handle-close failure, or unknown Windows
error is `SCM_UNPROVED`.

`SERVICE_CONFIG_PREFERRED_NODE` must prove that no preferred NUMA node is configured. The exact
successful no-setting response on every supported Windows build, and the raw mutation required to
clear a pre-existing setting, are not yet proven. Until native evidence fixes those forms, a
configured node or an unprovable query blocks the transaction. No current plan contains a clear-
preferred-node action; adding one requires a separate schema-v2 ordinal before any mutation.

Read-back compares the entire expected snapshot after every action, not only the field most
recently written. During initial creation, the exact plan-derived partial pair is:

| Durable point | Executor | Control | Dependent topology |
| --- | --- | --- | --- |
| Before ordinal 1 | absent | absent | none |
| Ordinal 1 complete and pending ordinal 2 | disabled, exact native-verified intermediate descriptor | absent | none |
| Ordinal 2 through 9 | disabled, final descriptor and exactly the fields completed by the cursor | absent | none |
| Ordinal 10 complete and pending ordinal 11 | disabled and fully configured | disabled, exact native-verified intermediate descriptor | Executor has exactly Control |
| Ordinal 11 through 18 | disabled and fully configured | disabled, final descriptor and exactly the fields completed by the cursor | Executor has exactly Control |
| Ordinal 19 complete | demand-start and fully configured | disabled and fully configured | Executor has exactly Control |
| Ordinal 20 complete | demand-start and fully configured | demand-start and fully configured | Executor has exactly Control |

An action intent retains the preceding row until its native effect is observed. A field scheduled
for a later configure ordinal must match the separately frozen intermediate default for that
cursor; it is not ignored. A missing service, default descriptor, disabled start type, or partial
configuration is accepted in no other plan state. The effect's return value is never completion
evidence.

### Transaction journal schema v2 is required

The ADR 0015 v1 record cannot encode this decision. Its pending-action union has no create,
configure, fence, stop, or start action, while its two per-role policy actions cannot represent the
individual `ChangeServiceConfigW`, `ChangeServiceConfig2W`, or service-security effects and cannot
bind an exact policy profile. Adding those values to a v1 record would change its canonical schema,
closed state matrix, golden bytes, and recovery meaning.

A separately reviewed transaction schema v2 must add closed, plan-derived SCM actions. An action
contains only its schema-defined kind, role, ordinal, target generation where applicable, and one
fixed compiled policy-profile identifier. Service names, paths, SIDs, accounts, descriptions,
dependencies, start modes, timeouts, access masks, failure values, native handles, callbacks, and
arbitrary policy objects are derived from compiled constants and are not action fields.

At minimum, schema v2 requires these plans and orderings.

#### Upgrade maintenance plan

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

Ordinal 8 completion requires the full pair snapshot to match the maintenance target before the
phase can become `SCM_MAINTENANCE_FENCED`.

#### Stop plan

```text
1  stop-control
2  stop-executor
```

Each stop intent precedes `ControlService(SERVICE_CONTROL_STOP)`. Completion requires stable
`SERVICE_STOPPED`, the retained wrapper handle signaled, the complete wrapper-ServiceHost-Node tree
absent, and the service-root Job observed empty through a future opaque process-tree boundary.
`QueryServiceStatusEx.dwProcessId` is not valid absence evidence in the stopped state and cannot
replace those handle-bound observations. An already stopped role is a no-op only after the same
absence proof. Ordinal 2 completion and a fresh pair observation are required for
`SERVICES_STOPPED`.

The installer never stops Executor first and relies on dependency propagation to stop Control.

#### Initial service-creation plan

After all destination roots are verified, initial installation configures Executor completely
before it creates Control, so Control's dependency never names an absent service:

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

Every ordinal is one WAL intent for exactly one native mutation. Ordinals 1 and 10 each contain
only `CreateServiceW`; ordinals 2 and 11 independently authorize the service-security mutation.
No create, security, or `ChangeServiceConfig2W` effect can be collapsed behind another pending
action. The failure-clear and preshutdown ordinals, and therefore the production plan, remain
unavailable until their native gates are resolved. Ordinal 19 cannot run until both services are
fully secured and configured while disabled. Ordinal 20 cannot run until ordinal 19 has been
freshly read back. Plan completion requires both services stopped, fully configured, and
demand-start with recovery disabled before either service-start intent.

Schema v2 needs an explicit service-configured phase or an equivalent closed checkpoint. Reusing
`DESTINATION_VERIFIED` for both absent and fully configured service records would make recovery
ambiguous.

#### Candidate and rollback start plans

```text
1  start-executor
2  start-control
```

`StartServiceW` receives no service arguments. Executor start completion requires the exact SCM
record and wrapper identity, stable `SERVICE_RUNNING`, the direct-child ServiceHost relationship,
and fresh authenticated installer accept-ready evidence. Only then may Control start. Control
start completion requires its corresponding stable identities and fresh authenticated disabled
readiness before the candidate can reach `AUTHENTICATED_DISABLED_READY` or rollback can reach its
equivalent checkpoint.

SCM `SERVICE_RUNNING`, a nonzero process ID, or a process exit code alone is not readiness.
Readiness evidence is process-local and is never serialized into the journal.

#### Candidate and previous final-policy plans

The final plans retain Executor-before-Control ordering, but their action lists cannot be frozen
until the final decision gate supplies delayed-start and recovery values. Schema v2 must represent
each eventual native mutation with its own WAL ordinal and bind every action to the one compiled
complete policy. It cannot retain the v1 meaning of one opaque `apply-*-policy` effect per role.

### Recovery and rollback ordering

Every SCM mutation follows:

```text
intent persisted -> one native effect attempted -> complete fresh observation -> completion persisted
```

A pending action whose complete target is observed may be completed. A pending action whose exact
pre-effect state is observed may be retried. A recognized safe partial configure state may be
advanced only by reapplying the same idempotent target under the same pending action. A different
service, account, binary path, dependency, security descriptor, unexpected running process,
unreadable field, or state that matches neither the exact before nor target shape is
`SCM_UNPROVED` and fails closed.

An upgrade abandoned after maintenance begins but before the first root intent first completes the
maintenance and stop plans and freshly reverifies the unchanged previous roots. It then starts
Executor and Control in that order, reacquires disabled readiness, and attempts the still-blocked
previous final policy without a root rename. After candidate roots have reached their final slots,
rollback first stops Control and then Executor, proves both trees absent, completes the ADR 0015
root rollback, reverifies the previous destination, starts Executor and then Control, obtains fresh
disabled readiness, and only then attempts that previous final policy. A committed candidate never
enters rollback; `COMMITTED/pending` can only roll forward to its exact final policy.

An initial installation has no service-delete recovery plan. Failure after service creation leaves
every created record stopped at its last journaled disabled or demand-start state, with recovery
disabled, and fails closed. It never promotes a remaining disabled record merely to make the pair
uniform. Deletion, uninstall, repair, and adoption outside one pending create action require
separate decisions.

The v1 journal remains useful as a pure filesystem model, but production transitions from
`QUIESCED` through `SCM_MAINTENANCE_FENCED`, from `DESTINATION_VERIFIED` through service start, into
`COMMITTED`, and from rollback readiness into `ROLLED_BACK` remain blocked. No adapter may perform
SCM effects beside a v1 record and call them implementation details.

### Zero-execution invariant

This policy contains no execution switch, available-slot value, Claim operation, repository input,
ProcessHost request, lease, token, or credential. Maintenance and initial creation always use
demand-start with recovery disabled. The missing final policy is a release blocker, not an excuse
to use defaults. No SCM state can override RoleConfig v2's `executionEnabled=false` or authorize a
nonzero slot.

## Required native evidence

Before any production SCM adapter or schema-v2 transition is enabled, supported fully patched
Windows x64 and arm64 hosts must prove:

- exact virtual-account creation and null-password behavior;
- each crash point between service creation and final service-object DACL publication;
- the raw `SERVICE_FAILURE_ACTIONSW` clearing representation and its complete postcondition;
- exact restricted service SID and required-privilege token results;
- exact minimal manager and service-handle access checks, zero-access create handles, and fresh
  read-back handle separation;
- byte-equivalent service configuration and protected service-object security read-back;
- successful preservation of the protected DACL with security-information mask `0x00000007`;
- the exact no-setting and clearing behavior for `SERVICE_CONFIG_PREFERRED_NODE`;
- denial of every service-object right not listed above for both service identities;
- dependency start and stop ordering without treating dependency state as readiness;
- each maintenance WAL crash point, including partial `ChangeServiceConfig2W` outcomes;
- stopped-state process-tree and root-Job absence after graceful and forced wrapper termination;
- wrapper response to stop, shutdown, preshutdown, child exit, timeout, and nonzero exit;
- final recovery behavior for every later restart ordinal, reset boundary, crash/non-crash mode,
  and simultaneous or cascading role failure;
- machine reboot, installer crash, power loss, and recovery after every SCM WAL intent; and
- inability of XML, package fields, environment, command-line values, registry drift, or a stale
  journal to select another policy.

Cross-compilation, fake SCM providers, source inspection, `sc.exe` output, and generic WinSW tests
are not native evidence.

## Consequences

- The exact service identity, creation target, service-object rights, required privilege, and
  maintenance fence are no longer open product choices.
- The final automatic-start and recovery schedule remains intentionally unavailable instead of
  acquiring accidental defaults.
- A production installer requires transaction schema v2; the current v1 commit and rollback gates
  remain closed.
- The pinned WinSW release and its native stop, preshutdown, and exit propagation behavior are
  security and durability dependencies, not packaging details.
- Future RoleConfig v3 work is ADR 0017 or later and cannot use SCM configuration as execution
  authority.

## Deferred decisions and blockers

- pinned WinSW x64 and arm64 version, hashes, and complete native behavior matrix;
- the exact Local System or local-Administrator installer identity and token used for SCM mutation;
- the exact safe intermediate service-object descriptor produced by `CreateServiceW` on each
  supported Windows build and installer identity;
- the complete disabled-create intermediate defaults returned by `QueryServiceConfig2W`;
- the exact raw `SERVICE_FAILURE_ACTIONSW` representation that clears every maintenance recovery
  field in one mutation;
- zero-access `CreateServiceW` handles and exact minimal-access behavior on each supported build;
- protected-DACL preservation with the fixed `SetServiceObjectSecurity` information mask;
- `SERVICE_CONFIG_PREFERRED_NODE` no-setting read-back and any required schema-v2 clear action;
- exact `SERVICE_CONFIG_PRESHUTDOWN_INFO` value and accepted-control contract;
- installer stop/start observation deadlines outside the signed 330-second XML child timeout;
- final delayed-auto-start values;
- complete per-role restart action arrays and delays;
- failure-action reset period and failure-actions-on-non-crash value;
- transaction-journal schema v2, reducer, codec, protected store, and observation types;
- opaque process-tree absence and authenticated installer readiness boundaries; and
- production SCM adapter and installer composition.

## Non-goals

This decision does not call SCM, create or change a service, set a security descriptor, stop or
start a process, implement journal schema v2, select a WinSW binary, define uninstall or repair,
enable RoleConfig v3, authorize Claim, or provide native Windows evidence.

## References

- [ADR 0007: Isolate Windows Worker Control and Execution Identities](0007-windows-control-executor-isolation.md)
- [ADR 0013: Windows Node Enrollment and Split Installation](0013-windows-node-enrollment-and-split-installation.md)
- [ADR 0015: Split Installer Transaction Journal v1](0015-split-installer-transaction-journal-v1.md)
- [CreateServiceW](https://learn.microsoft.com/windows/win32/api/winsvc/nf-winsvc-createservicew)
- [ChangeServiceConfigW](https://learn.microsoft.com/windows/win32/api/winsvc/nf-winsvc-changeserviceconfigw)
- [ChangeServiceConfig2W](https://learn.microsoft.com/windows/win32/api/winsvc/nf-winsvc-changeserviceconfig2w)
- [QueryServiceConfigW](https://learn.microsoft.com/windows/win32/api/winsvc/nf-winsvc-queryserviceconfigw)
- [QueryServiceConfig2W](https://learn.microsoft.com/windows/win32/api/winsvc/nf-winsvc-queryserviceconfig2w)
- [QueryServiceStatusEx](https://learn.microsoft.com/windows/win32/api/winsvc/nf-winsvc-queryservicestatusex)
- [EnumDependentServicesW](https://learn.microsoft.com/windows/win32/api/winsvc/nf-winsvc-enumdependentservicesw)
- [SetServiceObjectSecurity](https://learn.microsoft.com/windows/win32/api/winsvc/nf-winsvc-setserviceobjectsecurity)
- [Service Security and Access Rights](https://learn.microsoft.com/windows/win32/services/service-security-and-access-rights)
- [Service User Accounts](https://learn.microsoft.com/windows/win32/services/service-user-accounts)
- [SERVICE_FAILURE_ACTIONS](https://learn.microsoft.com/windows/win32/api/winsvc/ns-winsvc-service_failure_actionsw)
- [SERVICE_FAILURE_ACTIONS_FLAG](https://learn.microsoft.com/windows/win32/api/winsvc/ns-winsvc-service_failure_actions_flag)
- [SERVICE_PRESHUTDOWN_INFO](https://learn.microsoft.com/windows/win32/api/winsvc/ns-winsvc-service_preshutdown_info)
