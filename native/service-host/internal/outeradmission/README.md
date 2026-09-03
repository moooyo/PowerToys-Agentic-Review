# Signed Package Admission Profile

`outeradmission.Admit` is the production entry point for the first signed-package admission stage.
It accepts canonical package-index bytes, detached-envelope bytes, and the exact Control and
Executor ServiceHost bootstrap bytes. It takes no public key, verifier callback, trust evidence,
filesystem handle, or installation option. The outer signer is loaded only through
`outertrust.Production`.

Admission accepts only the current `outerpackage.IndexSchemaVersion` and
`outerpackage.IndexProfileID` together with `config.SchemaVersion`, the fixed
`agentic-review-worker-auth-v1` selector, and the current installer-profile roots. Neither the
plaintext Worker Token nor its Server-side SHA-256 digest belongs in signed package admission.

All four byte slices are bounded and cloned before verification. Signature verification, canonical
parsing, and bootstrap binding use the same immutable snapshots. A verifier-side mutation or a
verify/parse byte swap invalidates the operation.

The logical binding proves:

- the exact bootstrap sizes and SHA-256 digests match their unique fixed index payloads;
- both canonical `config` documents select the fixed Control and Executor service names,
  service SIDs, pipe, and roles;
- Worker node ID, release ID, installation root, trusted-configuration root, manifest path, and
  manifest digest agree across both bootstraps and the signed index;
- the Node executable, Control and Executor bundles, root CA, ProcessHost, Executor policy, and
  local-authority SPKI selectors match indexed runtime payloads;
- the CNG key name, security-descriptor digest, and shared shutdown and transport limits agree; and
- the fixed Control and Executor data roots and Worker authentication selector agree.

This package does not construct or mint a runtime RoleConfig and `SignedPackagePlan` carries no
RoleConfig authority fields. The existing guarded runtime chain independently remains on foundation
v2 with `executionEnabled=false` and `maximumSlots=1`. In particular, the admission inputs do not
contain the SPKI payload bytes needed for the Executor's inline RoleConfig public-key descriptor.

`SignedPackagePlan` is opaque, refuses JSON serialization, and returns detached data copies. It is
not installation or execution evidence. Package ID, installation ID, metadata root, source and
architecture claims, descriptor contents, manifest contents, Authenticode lineage, SPKI bytes, and
physical placement remain signed logical data or indexed selectors until a later handle-bound
package verifier reads and validates every staged payload. The plan cannot authorize filesystem
writes, CNG or certificate changes, SCM operations, service launch, or Claim.

Only `stagedpackage` and `installerdestination` import `outeradmission` in production, and an
architecture test freezes that boundary. The staged verifier supplies exact retained-handle byte
snapshots; the destination verifier repeats admission over the exact index, envelope, and bootstrap
bytes reopened from all three final roots. Neither result authorizes filesystem mutation, SCM,
launch, Claim, or execution. Existing preflight, runtime installverify, and launch paths remain
disconnected.

The pair check also repeats `config`'s case-insensitive lexical data-root non-overlap rule. That is
only a schema-level consistency check. It does not prove NTFS object separation, canonical final
paths, volume identity, junction or reparse behavior, or directory security.
