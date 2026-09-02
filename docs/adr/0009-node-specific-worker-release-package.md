# ADR 0009: Node-Specific Two-Phase Worker Release Packages

## Status

Accepted for the RoleConfig v2 zero-execution release foundation.

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

Worker packages are node-specific and are produced in two phases:

1. **Prepare.** A canonical reviewed-closure document names the exact non-ServiceHost identities,
   package profile, and review-policy identity and version. Its digest arrives independently of the
   document. The opaque parsed evidence is matched exactly against a separately observed canonical
   inventory of final bytes, including the target node's local-authority SPKI and its digest.
   Prepare binds the closure digest and policy, release ID, AMD64 or ARM64 target, one Git commit
   and tree, one Authenticode leaf-certificate DER digest, and the SPKI digest. It emits the
   canonical compiled release template, its digest, and a canonical prepare receipt.
2. **Finalize.** After the controlled ServiceHost build and external Authenticode signing stage,
   finalize accepts only opaque evidence from the trusted PE and signature verifier. It reconstructs
   and checks the prepare receipt against the same reviewed-closure evidence, revalidates the
   complete dependency inventory, rejects any phase mismatch, adds the fixed ServiceHost manifest
   entry, and emits the canonical runtime manifest plus an outer package descriptor.

The reviewed-closure document has this exact canonical shape; every identity uses the same root,
path, role, ordering, path-safety, uniqueness, and required-role policy as the runtime manifest:

```json
{"dependencies":[{"root":"installation","path":"<canonical-relative-path>","role":"<non-service-host-role>"}],"packageProfile":"role-config-v2-node-specific","policyId":"role-config-v2-package-files","policyVersion":1,"schemaVersion":1}
```

This slice deliberately exposes no production constructor or parser that can mint
`ReviewedClosureEvidence`. The next slice must add a handle-bound independent approval reader that
obtains the closure document and approved digest from their distinct trusted inputs, validates both,
and is the sole production minting boundary.

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
timestamping, revocation checking, PE architecture verification, stable file observation, package
assembly, and installer activation are external stages. The pure contract library exposes
`UntrustedServiceHostMetadata` only as the shape of facts that a future handle-bound verifier must
derive; it is never accepted directly for finalization. This slice deliberately has no production
constructor for `VerifiedServiceHostEvidence`.

## Consequences

- A new local-authority key requires a new prepare, ServiceHost build, signing operation, manifest,
  and outer package descriptor for that node.
- AMD64 and ARM64 are separate package identities even when their role bundles are byte-identical.
- Prepare and finalize receipts make release, architecture, source, signer, SPKI, dependency, and
  ServiceHost mix-and-match failures explicit before outer package signing. A prepare receipt alone
  cannot reconstruct prepared state; the independently checked reviewed-closure evidence is also
  required.
- The existing legacy single-service installer remains unchanged and cannot install this package.
- A later CLI must obtain inventory and signed-ServiceHost metadata from handle-bound trusted
  readers and obtain reviewed-closure evidence from the independent approval reader. It must not
  turn caller-authored JSON or a self-computed closure digest into authority evidence.
- A later `VerifyFinalizedPackage` boundary must verify the descriptor, manifest, staged bytes,
  signer, and all receipt bindings before any consumer treats a parsed descriptor as evidence.
- A later split-service installer must verify the signed outer package, reproduce these bindings,
  provision both restricted services and protected roots, and activate Executor before Control.

## Non-Goals

This decision does not enable Claim, implement signing, define an online signing service, create
Windows services, provision CNG keys or certificates, apply filesystem or firewall policy, or
replace the native Windows verification matrix required by ADR 0007.
