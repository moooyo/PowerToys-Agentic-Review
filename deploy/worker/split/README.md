# Split Windows Worker Installation Inputs

This directory contains dormant RoleConfig v2 source inputs for the future split Windows installer.
It is not an installer, a deployable package, or installation evidence. The legacy
`deploy/worker/install-worker.ps1` remains unchanged and cannot install this profile.

The first installation profile accepts only an enrolled host with no existing Worker service or
runtime installation. Discovery of the legacy `AgenticReview.Worker` service, a legacy runtime
root, or a partial legacy installation fails closed. Legacy-to-split migration requires a separate
ADR and is not inferred from the upgrade procedure below. A previously committed split pair may use
the split-to-split upgrade path.

The design authority is ADR 0013 together with ADR 0007, ADRs 0009 through 0012, the ADR 0015
transaction model, and the ADR 0016 SCM policy contract. The XML files only describe how the two
WinSW wrappers launch ServiceHost. They do not provision services, accounts, restricted service
SIDs, ACLs, keys, certificates, firewall rules, machine policy, or physical roots.

## Source files

```text
deploy/worker/split/
  README.md
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

The XML contains no Node path, bundle path, application environment, secret, package signer,
RoleConfig value, slot count, or execution setting. ServiceHost obtains the Node and bundle selectors
from the signed, protected bootstrap and independently verifies the running service identity,
manifest, signer, paths, ACLs, and peer.

## Required package and activation flow

Node enrollment completes before release preparation. The node-specific package is then built from
the enrolled local-authority SPKI, mTLS identity, fixed roots, final wrapper configurations, both
role bundles, and all other reviewed dependencies. The reviewed role entrypoints are
`apps/worker/src/control-main.ts` and `apps/worker/src/executor-main.ts`; their bundle outputs become
the exact package payloads `app\control.mjs` and `app\executor.mjs`. Those are the only role bundle
payloads; legacy `worker.mjs`, source maps, and metadata sidecars are forbidden.

The future privileged Go installer must:

1. verify the expanded staging tree with `stagedpackage.Verify`;
2. consume the opaque `StagedPackageEvidence` in that same process without serialization;
3. materialize and fully verify complete inactive metadata, installation, and
   trusted-configuration roots;
4. for an upgrade, drain Control and wait for authenticated `Drained`; for an initial install,
   prove that no legacy or split Worker installation exists;
5. durably set each existing split service to demand-start with all failure actions disabled, then
   stop Control and Executor and prove both process trees absent; on a clean install, persist the
   verified absence as the maintenance fence without creating a service;
6. journal and place or swap all three complete physical roots without junctions or in-place file
   replacement;
7. reopen and fully reverify all three exact signed destination roots;
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

The stricter Executor installer-activation readiness in step 8 applies only to a privileged install
or upgrade transaction. On an ordinary machine boot, SCM may start Control after Executor reaches
`SERVICE_RUNNING`. Control must then establish a fresh authenticated ARWX session and receive the
Executor `Ready` attestation before it reports readiness or slot state to the Server. It must not
Claim before that gate, and RoleConfig v2 prevents Claim after the gate as well.

## Zero-execution boundary

RoleConfig remains foundation version 2 with `executionEnabled=false` and `maximumSlots=1`; the
runtime advertises zero available slots and `EXECUTION_DISABLED`. Bootstrap schema version 3 is not
RoleConfig v3. No enrollment field, package field, XML element, environment variable, command-line
argument, installer option, or rollback state can enable execution.

These files do not authorize Claim, `StartAttempt`, ProcessHost launch, repository commands, or
dynamic validation. Native Windows x64 and arm64 verification required by ADR 0007 remains blocked.

## Deferred production work

The repository still lacks the trusted enrollment evidence boundary, production split installer,
destination-verification evidence, transaction-journal schema v2 and its durable Windows store,
the native SCM adapter, the complete final recovery and preshutdown policy, pinned WinSW release
validation, native proof of the disabled-create intermediate DACL and failure-action clearing,
authenticated installer-facing readiness observation, archive/extractor, and native Windows
verification evidence. Legacy-to-split migration is separately deferred. Those items must be
designed and reviewed before these inputs can become a supported installation path.
