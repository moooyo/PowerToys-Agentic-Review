# Split Windows Worker Installation Inputs

This directory contains RoleConfig v2 source inputs for the current split Windows installation
profile and a fixed-path local Worker credential provisioning helper. It is not a complete
installer, a deployable package, or installation evidence. The retired root-level
`deploy/worker/install-worker.ps1` cannot install the schema-4 ADR 0025 per-Worker Bearer Token
profile.

The current clean-install profile accepts only a host with no existing Worker service or runtime
installation. Discovery of an unsupported single-service installation, an existing runtime root,
or a partial installation fails closed. Migration from another layout is outside this profile. A
previously committed split pair may use the split-to-split upgrade path.

The design authority is ADR 0025 together with the still-applicable split-service, package,
transaction, and SCM decisions in ADR 0007, ADRs 0009 through 0013, ADR 0015, and ADR 0016. Earlier
client-certificate, Server-binding-receipt, and enrollment-record requirements are superseded and
do not define an alternate product profile. The XML files only describe how the two WinSW wrappers
launch ServiceHost. They do not provision services, accounts, restricted service SIDs, ACLs, the
local capability-signing key, package trust material, firewall rules, machine policy, physical
roots, or the Worker Bearer Token.

## Source files

```text
deploy/worker/split/
  README.md
  provision-worker-auth.ps1
  winsw/
    AgenticReview.Worker.Control.xml.template
    AgenticReview.Worker.Executor.xml.template
```

The templates contain no substitutions. A controlled node-specific release pipeline must copy the
reviewed bytes to these installation payload paths before hashing, signing, and indexing the final
package:

```text
installation/AgenticReview.Worker.Control.exe
installation/AgenticReview.Worker.Control.xml
installation/AgenticReview.Worker.Executor.exe
installation/AgenticReview.Worker.Executor.xml
```

The `.template` source names, this README, build maps, and other repository material must not appear
in the staged package. The finalized XML files are the two required `service-config` payloads. Their
matching pinned WinSW binaries are the two required `service-wrapper` payloads.

## Frozen launch contract

The first profile fixes these properties:

- service IDs are `AgenticReview.Worker.Control` and `AgenticReview.Worker.Executor`;
- both wrappers run from `C:\Program Files\AgenticReview\Worker`;
- each wrapper's direct child is
  `C:\Program Files\AgenticReview\Worker\native\AgenticReview.ServiceHost.exe`;
- each child receives only the matching absolute `--config` path below
  `C:\ProgramData\AgenticReview\TrustedConfig`;
- Control declares an SCM dependency on Executor, but runtime readiness still requires the
  authenticated ARWX handshake;
- wrapper logs are separated in protected roots at
  `C:\ProgramData\AgenticReview\ServiceWrapper\Control` and
  `C:\ProgramData\AgenticReview\ServiceWrapper\Executor`, outside the exact ServiceHost data-root
  closures; and
- the wrapper stop timeout is 330 seconds, leaving a fixed outer margin around the bootstrap's
  maximum 300-second ServiceHost shutdown budget.

The templates intentionally contain no SCM start mode, delayed-start setting, failure action, or
failure-reset policy. The installer owns those mutable service policies and must fence them during
every root mutation. Finalized XML bytes remain signed package payloads, but they cannot authorize
automatic start or recovery.

There is intentionally no `serviceaccount` element. Account creation and service configuration are
privileged installer operations whose result must be inspected through SCM and token evidence. A
future installer must configure the exact matching virtual account and
`SERVICE_SID_TYPE_RESTRICTED` before any start. Directly invoking WinSW installation with these XML
files is unsupported; the resulting default identity is invalid and ServiceHost must fail closed.

The XML contains no Node path, bundle path, application environment, Worker Bearer Token, other
secret, package signer, RoleConfig value, slot count, or execution setting. ServiceHost obtains the
Node and bundle selectors from the signed, protected bootstrap and independently verifies the
running service identity, manifest, signer, paths, ACLs, and peer.

## Worker API credential boundary

ADR 0025 assigns one independently revocable, long-lived Bearer Token to each Worker node. Any
authenticated dashboard user may create a pending node, rotate its Token, or revoke it. The first
successful Worker registration changes the Server-side state from `pending` to `active`; `revoked`
is terminal. The Linux Server stores only the Token's SHA-256 digest and continues to serve the
Worker API over HTTPS. Restoring an older database backup intentionally restores the Token state in
that backup, including the accepted possibility of reviving a later-revoked Token.

Persistent plaintext Token storage resides only in the fixed ordinary Control configuration file:

```text
C:\ProgramData\AgenticReview\Control\worker-auth-v1.json
```

The exact canonical JSON profile is defined by ADR 0025. The file is persistent local
configuration, not a package payload, signed package input, WinSW substitution, environment
variable, command-line argument, registry value, or alternate credential source. Control uses the
Token only as `Authorization: Bearer <token>` for Worker API requests and continues to validate the
Server's HTTPS certificate. It loads no Worker client certificate, private key, PFX, or client-key
passphrase. The non-secret `workerNodeId` is deliberately cross-bound in this file, both bootstrap
documents, the signed package index, and Server state.

The Worker Token does not replace the short-lived lease token, the Control-to-Executor local
capability signer, package signatures, Authenticode, artifact receipts, GitHub credentials, Codex
credentials, or authenticated ARWX readiness. A Server binding receipt, active-status assertion,
receipt signer, signer-host, KMS, HSM, and the former Linux signer-host verification matrix are not
future deployment gates under the accepted trust model.

## Required package and activation flow

The Server creates the pending Worker node before release preparation. The node-specific package is
then built from the Worker node ID, the Control-to-Executor local capability-authority SPKI, fixed
roots, final wrapper configurations, both role bundles, and all other reviewed non-Token
dependencies. Neither the plaintext Token nor its digest is a package input. The reviewed role
entrypoints are `apps/worker/src/control-main.ts` and `apps/worker/src/executor-main.ts`; their bundle
outputs become the exact package payloads `app\control.mjs` and `app\executor.mjs`. Those are the only
role bundle payloads; legacy `worker.mjs`, source maps, and metadata sidecars are forbidden.

Before Control starts, the privileged installation flow must place and exactly validate
`worker-auth-v1.json` at its fixed path. This credential provisioning is separate from package
signing and package-root replacement. Rotation replaces only that configuration value and restarts
Control; it does not rebuild or resign the Worker package.

After the installer has created the fixed Control data root, the local provisioning helper can
write or rotate the profile without putting plaintext Token data on a command line:

```powershell
$token = Read-Host 'Worker Token' -AsSecureString
.\provision-worker-auth.ps1 -WorkerNodeId 'worker-node-001' -Token $token
```

If `-Token` is omitted, the helper prompts for the Token as a secure string. It accepts no plaintext
Token parameter or output path, writes canonical UTF-8 without a BOM through a same-directory
write-through replacement, removes bounded stale temporary credential files before writing, rereads
the exact bytes, sets and verifies the fixed Control service SID as file owner, and never emits the
Token. The parent Control data root must already carry the installer-owned inheritance profile and
the helper must run under an installer identity that holds `SeRestorePrivilege`. The caller must
serialize provisioning operations. The helper enables that privilege only for the bounded file
operation and restores its prior state before returning. `-ValidateOnly` validates input without
writing. It is a credential provisioning helper, not the deferred SCM/root transaction installer.

The future privileged Go installer must:

1. verify the expanded staging tree with `stagedpackage.Verify`;
2. select `InstallerPackage` from the verified evidence and consume only that current
   typed gate in the same process without serialization;
3. materialize and fully verify complete inactive metadata, installation, and
   trusted-configuration roots;
4. for an upgrade, drain Control and wait for authenticated `Drained`; for an initial install,
   prove that no unsupported single-service or split Worker installation exists;
5. durably set each existing split service to demand-start with all failure actions disabled, then
   stop Control and Executor and prove both process trees absent; on a clean install, persist the
   verified absence as the maintenance fence without creating a service;
6. journal and place or swap all three complete physical roots without junctions or in-place file
   replacement;
7. reopen and fully reverify all three exact signed destination roots through the verify-only
   `installerdestination.Verify` typed-gate composition;
8. on a clean install, create each service disabled, journal and apply its protected security and
   remaining configuration independently, and move the fully configured pair to demand-start only
   in Executor-before-Control order; then, while demand-start and no-recovery remain enforced,
   explicitly start Executor, require its installer activation readiness, explicitly start Control,
   and require a fresh authenticated disabled Executor `Ready` attestation;
9. commit the package with activation policy durably marked `PENDING`; and
10. idempotently restore the reviewed automatic-start and failure-recovery policy, verify it through
    SCM, and durably mark activation policy `APPLIED`.

SCM `RUNNING` is not authenticated readiness. A failure or restart cannot reconstruct opaque
evidence from the transaction journal. Recovery keeps both services stopped until it can complete
the new pair or restore a previously verified, protocol-compatible split pair. After package commit,
recovery never rolls back solely because activation policy remains `PENDING`; it rolls forward by
reapplying and verifying the exact policy until the journal records `APPLIED`.

When Control first registers with a pending Token, the Server atomically activates that Worker node
and records the process instance. Authentication does not grant Claim, lease, slot, package,
installation, local capability, or execution authority. Every later Worker request is admitted from
the current database-backed Token state, and database unavailability fails authentication closed.

The stricter Executor installer-activation readiness in step 8 applies only to a privileged install
or upgrade transaction. On an ordinary machine boot, SCM may start Control after Executor reaches
`SERVICE_RUNNING`. Control must then establish a fresh authenticated ARWX session and receive the
Executor `Ready` attestation before it reports readiness or slot state to the Server. It must not
Claim before that gate, and RoleConfig v2 prevents Claim after the gate as well.

## Zero-execution boundary

RoleConfig remains foundation version 2 with `executionEnabled=false` and `maximumSlots=1`; the
runtime advertises zero available slots and `EXECUTION_DISABLED`. Bootstrap schema version 4 is not
RoleConfig v4. No enrollment field, package field, XML element, environment variable, command-line
argument, installer option, or rollback state can enable execution.

These files do not authorize Claim, `StartAttempt`, ProcessHost launch, repository commands, or
dynamic validation. Native Windows x64 and arm64 verification required by ADR 0007 remains blocked.

## Deferred production work

Native bootstrap schema 4, Control data-root verification, preflight, production composition,
signed outer-package v2, and installer profile v2 select the fixed ADR 0025 authentication file as
the only Worker authentication path. `stagedpackage.SelectInstallerPackage` accepts only the
current schema-4/package-v2 evidence before the destination verifier can consume it. The read-only
`installerdestination.Verify` composition now implements step 7, but no production installer
performs steps 3 through 6 or invokes it. The repository still lacks the
production split installer, root materializer and atomic swap, transaction-journal schema v2 and
its durable Windows store, the native SCM adapter, the
complete final recovery and preshutdown policy, pinned WinSW release validation, native proof of the
disabled-create intermediate DACL and failure-action clearing, authenticated installer-facing
readiness observation, archive/extractor, and native Windows verification evidence.
Migration from the unsupported single-service scaffold is not part of the current installation
path. The remaining items must be designed and reviewed before these inputs can become a supported
installation path. Worker client-certificate enrollment, binding receipts, receipt trust,
signer-host implementation, and signer-host Linux process tests are not deferred requirements.
