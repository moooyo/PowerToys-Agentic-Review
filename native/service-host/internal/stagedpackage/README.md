# Handle-Bound Staged Package Verification v1

`stagedpackage.Verify` is the only production entry point. On Windows it accepts one canonical
absolute staging-root path and opens that path from its drive root one component at a time. It does
not accept a file inventory, public key, signature verifier, ACL callback, or preconstructed
admission plan.

The volume root and staging ancestors use the closed ambient `winacl` policy. The staging root and
every descendant use the closed managed trusted-configuration policy: SYSTEM and Administrators
have full control, both fixed Worker service SIDs have read/traverse access, and staged files do not
grant service execute access. This is a deliberately strict read-only staging profile. A future
assembler must create that exact ACL layout before verification; this package never writes or
repairs ACLs.

The verifier retains every directory and file handle and proves:

- the fixed staging root contains exactly `metadata`, `installation`, and
  `trusted-configuration`, with exact casing;
- each logical subtree contains exactly the index, envelope, and indexed payload closure, with no
  empty, extra, case-aliased, reparse, hard-linked, named-stream, non-NTFS, network, or cross-volume
  objects;
- each enumeration identity, type, attributes, and file size match the separately opened child
  handle, and every retained object and enumeration remains unchanged;
- the exact index, envelope, and bootstrap byte snapshots are passed to
  `outeradmission.Admit`, which uses only compiled `outertrust`;
- every file size and SHA-256 matches its signed entry;
- every PE role has the signed machine architecture and a strict embedded Authenticode signature
  from the bootstrap-pinned leaf certificate; PE parsing uses stable positional reads rather than
  buffering a complete image;
- the ServiceHost signing invariant matches the controlled build receipt;
- the node-specific SPKI is canonical P-256 PKIX DER and matches its signed path and digest; and
- the package descriptor, prepare receipt, reviewed closure, compiled template, build receipt, and
  runtime manifest form one internally consistent finalized release whose runtime entries exactly
  match the index.

`StagedPackageEvidence` owns all handles until `Close`. `Validate` rechecks handle identity,
metadata, streams, ACL bytes, case mode, and every recorded directory enumeration. An unresolved
native close publishes a package cleanup fatal state and retains the owner; both evidence commit
and later validation are also linearized with the `winfile` process cleanup quarantine.

## Authority boundary

The evidence is a retained observation of staged bytes. It is not installation, physical target
placement, CNG, certificate, SCM, Claim, or execution evidence, has no production consumer, and
refuses JSON serialization. Signed `packageId`, `installationId`, target roots, CNG identity, and
mTLS identity are cross-bound to the bootstrap fields that exist, but this verifier does not inspect
the target filesystem, CNG provider, certificate store, or private-key ACL. It therefore cannot
claim that staged directories already occupy the signed target roots.

Ordinary builds contain no compiled outer signer and fail closed during admission. Native Windows
Lab A remains blocked until a provisioned fixed-NTFS staging fixture exists with the exact managed
ACLs, real canonical package bytes, signed AMD64 and ARM64 PE payloads, and the approved signer
chain. Cross-compilation checks the Windows adapter, but it cannot replace that lab.

This package performs no archive extraction, download, file or ACL write, bootstrap generation,
CNG or certificate provisioning, SCM operation, installation, rollback, launch, or Claim change.
