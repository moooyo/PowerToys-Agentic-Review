# ADR 0012: Handle-Bound Staged Package Verification v1

> Historical exact profile note: ADR 0025 removes Worker mTLS credentials from the selected product
> design. This v1 staged-package profile is not reinterpreted; a new profile must replace its mTLS
> evidence fields before production use. Filesystem and handle-bound verification remain valid.

## Status

Accepted for the dormant RoleConfig v2 zero-execution package foundation.

## Context

ADR 0010 defines canonical signed package data, and ADR 0011 admits the index and two bootstrap
documents using one compiled outer signer. Neither decision observes a filesystem. A pathname
reader or caller-supplied inventory would permit replacement, omission, case-alias, reparse,
hard-link, alternate-stream, volume, or ACL attacks and could not close the transport package.

The current slice must remain disconnected from installation and launch. Its output may retain
staging handles so a later design can choose an explicit transfer boundary, but JSON facts alone
must not become authority.

## Decision

`stagedpackage.Verify(context.Context, string)` is the only production minting entry point. It
accepts one canonical local Windows staging-root path. Production code constructs every dependency
internally: component-relative `winfile` opens, the fixed `winacl` staging policy, Windows
Authenticode, and `outeradmission.Admit`. There is no public key, trust evidence, verifier callback,
security callback, inventory, or plan parameter.

Traversal starts at a retained drive-root handle. Every ancestor is opened relative to its retained
parent without following a reparse point. The final staging root and every descendant must have the
exact managed trusted-configuration ACL; earlier ancestors use the closed ambient policy. The
staging profile deliberately grants both Worker service SIDs read access but no execute access to
files. This verifier does not create that profile.

The staging root must have exactly three precisely cased directory entries. The verifier reads the
index, envelope, and two bootstrap files through retained handles and gives those exact cloned bytes
to compiled-trust admission. It then derives the only allowed directory tree from the admitted
index, completely enumerates all three logical roots under fixed budgets, opens every observed child
relative to its parent, and compares enumeration identity, type, attributes, and size with the child
handle. No unindexed object or empty directory is accepted.

Every object must be on one fixed NTFS volume with persistent ACLs. Files must have one hard link;
all objects reject reparse points, deletion-pending state, named streams, case-sensitive directory
mode, case aliases, and security or identity changes. Every payload is streamed through SHA-256.
The `winfile.File` retained handle implements stable positional reads, allowing `peimage` to parse PE
headers and machine architecture without buffering an entire image. All PE roles require strict
single embedded Authenticode evidence from the leaf certificate pinned by both bootstraps. The
ServiceHost additionally matches the signing invariant in its controlled build receipt.

The node SPKI must be canonical P-256 PKIX DER. `releasepackage.InspectFinalizedDocuments` performs
ordinary, non-authorizing reconstruction of the exact descriptor, prepare, closure, template,
build-receipt, and manifest bindings. The verifier then binds release, source, architecture, SPKI,
signer, ServiceHost, and the exact runtime-manifest closure back to the signed index.

Successful `StagedPackageEvidence` owns every handle. Its validation rechecks all retained objects
and recorded enumerations. Its close retries native handles; an unresolved close publishes a
process-fatal package quarantine and retains the owner. Minting and validation commit under both
that quarantine and `winfile.CommitIfCleanupHealthy`, so a concurrent cleanup fatal state wins.

## Deliberate Limits

The signed package and bootstrap documents authenticate logical `packageId`, `installationId`,
absolute target roots, CNG key identity, and mTLS credential identity. The staged tree cannot prove
physical placement at those roots or inspect the future CNG provider, certificate store, or private
key ACL. Those remain signed data, not physical installation evidence.

The staged ACL is one compiled read-only transport policy, not the eventual split installation and
trusted-configuration policy. A later installer must define handle-preserving transfer or reopen and
reverify the destination closure before minting separate installation evidence.

Ordinary builds contain no compiled outer signer, so public verification fails closed after reading
the bounded admission documents. The evidence has no production consumer and cannot reach Claim,
RoleConfig, preflight, launch, `installverify`, or SCM.

Native Windows Lab A remains required and currently blocked. It needs a provisioned fixed-NTFS
fixture with exact staging ACLs, real canonical metadata, both architecture packages, and real
Authenticode signer material. Windows cross-build and static contract tests do not prove native ACL,
stream, enumeration, or WinVerifyTrust behavior.

## Consequences

- Caller-selected trust, inventories, and pathname-only verification cannot enter production.
- The complete staged transport closure remains bound to stable handles until explicit close.
- Large PE payloads are parsed through bounded positional reads; only streaming hash and the
  ServiceHost signing-invariant pass scale with full image size.
- A valid result cannot install, launch, enable Claim, write files, provision credentials, or modify
  services.

## Non-Goals

This decision does not define an archive format, extraction, download, filesystem writes, ACL
provisioning, target-root placement, CNG or certificate writes, private-key signing, SCM operations,
installation, rollback, service launch, or Claim enablement.
