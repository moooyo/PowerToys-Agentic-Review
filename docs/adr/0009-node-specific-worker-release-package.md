# ADR 0009: Node-Specific Two-Phase Worker Release Packages

> ADR 0026 makes this unpublished node-specific release and receipt composition a historical
> implementation record. A future clean installer may replace it with a simpler node-neutral,
> architecture-specific signed package and is not required to preserve its phases, receipts,
> retained handles, or CNG bindings.

## Status

Historical implementation record; not a production-installer prerequisite after ADR 0026.

## Context

The split Worker runtime already verifies a canonical schema-v2 release manifest against a release
template compiled into `AgenticReview.ServiceHost.exe`. The template commits every non-ServiceHost
dependency. The final manifest then adds the signed ServiceHost hash, avoiding a self-hash cycle.

The manifest deliberately includes the local-authority public SPKI used by one Worker node. The
private key is non-exportable and provisioned for that node. Consequently, two nodes with different
local-authority keys cannot share an identical compiled ServiceHost or release manifest. Treating the
package as reusable would either weaken the existing manifest binding or misrepresent the package's
key identity.

RoleConfig v2 is a zero-execution foundation. Native code fixes `foundationVersion=2`,
`executionEnabled=false`, and `maximumSlots=1`; the TypeScript role runtimes advertise zero
available slots. Package metadata is not an authority source and must never add an execution switch.

## Decision

Worker packages are node-specific and are produced in three phases:

1. **Prepare.** A canonical reviewed-closure document names the exact non-ServiceHost identities,
   package profile, and review-policy identity and version. Its digest arrives in a distinct
   administrator-sealed approval file. The opaque parsed evidence is matched exactly against a
   separately observed canonical
   inventory of final bytes, including the target node's local-authority SPKI and its digest.
   Prepare binds the closure digest and policy, release ID, AMD64 or ARM64 target, one Git commit
   and tree, one Authenticode leaf-certificate DER digest, and the SPKI digest. It emits the
   canonical compiled release template, its digest, and a canonical prepare receipt.
2. **Build and sign.** The controlled `servicehostrelease` driver emits the unsigned PE and a
   canonical build receipt binding source commit/tree, compiled-template digest, release ID, target
   architecture, unsigned SHA-256 and size, and a signing-invariant SHA-256. The signing invariant
   covers the full image after normalizing the PE checksum and certificate-table directory and
   excluding exactly one terminal WIN_CERTIFICATE table. A separate administrator-sealed digest
   approval authorizes the receipt before the output enters the signing stage.
3. **Finalize.** After Authenticode signing, finalization accepts only opaque evidence from the
   handle-bound build-receipt, PE, and signature verifier. It reconstructs
   and checks the prepare receipt against the same reviewed-closure evidence, revalidates the
   complete dependency inventory, rejects any phase mismatch, adds the fixed ServiceHost manifest
   entry, and emits the canonical runtime manifest plus an outer package descriptor.

The reviewed-closure document has this exact canonical shape; every identity uses the same root,
path, role, ordering, path-safety, uniqueness, and required-role policy as the runtime manifest:

```json
{"dependencies":[{"root":"installation","path":"<canonical-relative-path>","role":"<non-service-host-role>"}],"packageProfile":"role-config-v2-node-specific","policyId":"role-config-v2-package-files","policyVersion":1,"schemaVersion":1}
```

`ReviewedClosureEvidence` and `ServiceHostBuildEvidence` can be minted only by production readers
that obtain the document and exact 64-byte lowercase SHA-256 from distinct retained files. The
reader opens each path component relative to a retained parent handle, keeps every ancestor until
commit, rereads no authority file, and rechecks object identity, streams, case mode, and security.
Every production reader locks its OS thread before opening any path, rejects any existing thread
impersonation token, and retains a stable primary-process token snapshot through commit. Tokens
containing Administrators membership, including deny-only membership, or any high-risk privilege
are rejected even when the privilege is disabled.

The approval file and every managed ancestor use an exact protected three-principal DACL: SYSTEM
and local Administrators have full control, and the dedicated reader SID has read-only access to
the approval file and read/execute access to directories. The reader rejects all additional
trustees or masks and any mutation access available to its own token.

The outer descriptor always contains `packageProfile="role-config-v2-node-specific"`,
`foundationVersion=2`, and `executionAuthority=false`. These fields are emitted constants. They are
installer and audit assertions only; runtime Claim authority continues to derive exclusively from
the committed RoleConfig path.

One package contains exactly one Control bundle, one Executor bundle, two service wrappers, two
service configurations, one Node runtime, one ProcessHost, one Codex CLI, one Git CLI, and every
additional identity admitted by the independently reviewed closure. Legacy `worker.mjs`, source
maps, build metadata, unreviewed extras, duplicate or case-conflicting targets, unsafe paths, and
noncanonical inventory order are rejected. The reviewed closure, rather than a second
caller-authored inventory inside the prepare request, is the identity authority.

All PE files use one approved Authenticode leaf signer in this package profile. Actual signing,
timestamping, and online revocation checking remain external stages. `VerifyServiceHost` accepts
no caller-supplied verifier, signature evidence, or detached metadata. It requires the prepared
release plus independently approved build-receipt evidence, then uses one retained file handle for
the bounded image read, strict target-architecture PE32+ validation, embedded Authenticode
verification, signer-pin comparison, and post-signature SHA-256 pass. The final image must contain
one terminal WIN_CERTIFICATE table, no trailing overlay, and the same signing-invariant digest as
the approved unsigned build. The schema-v2 outer descriptor binds the build-receipt digest.
WIN_CERTIFICATE alignment padding must be zero. All retained file and token handles close before
evidence commit; commit is serialized against a process-global cleanup epoch. An unresolved close
permanently advances that epoch, withholds every in-flight or future evidence result, and prevents
Finalize from emitting a descriptor from previously issued evidence. The same commit is read-locked
against `winfile`'s rejected-native-handle quarantine, so either cleanup domain can veto it.

## Consequences

- A new local-authority key requires a new prepare, ServiceHost build, signing operation, manifest,
  and outer package descriptor for that node.
- AMD64 and ARM64 are separate package identities even when their role bundles are byte-identical.
- Prepare and finalize receipts make release, architecture, source, signer, SPKI, dependency, and
  ServiceHost mix-and-match failures explicit before outer package signing. A prepare receipt alone
  cannot reconstruct prepared state; the independently checked reviewed-closure evidence is also
  required.
- ADR 0026 removed the unpublished legacy single-service installer; it is not a compatibility input
  for a future clean installer.
- A later CLI must obtain inventory and signed-ServiceHost metadata from handle-bound trusted
  readers and obtain both closure and build-receipt evidence from their independent approval
  readers. It must not turn caller-authored JSON, a self-computed digest, detached signature
  evidence, or a same-signer binary from another build into authority evidence.
- A later `VerifyFinalizedPackage` boundary must verify the descriptor, manifest, staged bytes,
  signer, and all receipt bindings before any consumer treats a parsed descriptor as evidence.
- A later split-service installer must verify the signed outer package, reproduce these bindings,
  provision both restricted services and protected roots, and activate Executor before Control.

## Non-Goals

This decision does not enable Claim, implement signing, define an online signing service, create
Windows services, provision CNG keys or certificates, apply filesystem or firewall policy, or
replace the native Windows verification matrix required by ADR 0007.
