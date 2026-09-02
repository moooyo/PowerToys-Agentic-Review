# ADR 0010: Canonical Signed Outer Worker Packages

## Status

Accepted for the RoleConfig v2 zero-execution release foundation.

## Context

ADR 0009 defines a node-specific finalized release: reviewed closure, prepare receipt, compiled
release template, approved ServiceHost build receipt, signed ServiceHost, runtime manifest, and
package descriptor. Those documents do not yet describe the complete transport package, the two
bootstrap files that pin the manifest, or the node installation identities that are not filesystem
payloads.

An installer must eventually distinguish a signed, closed package from an archive that merely
contains a valid runtime manifest. It must also reject a manifest or metadata document copied from
another node, architecture, source tree, CNG identity, mTLS credential, or target root.

## Decision

The outer package has three logical roots: `metadata`, `installation`, and
`trusted-configuration`. `metadata/package-index.json` and
`metadata/package-index.signature.json` are mandatory transport files but are not payload entries
inside the index. Every other package payload appears exactly once by case-folded root and printable
ASCII Windows-relative path.

The canonical index fixes schema version 1 and profile
`agentic-review-worker-outer-package-v1`. It binds:

- package, installation, Worker node, and release IDs;
- AMD64 or ARM64 target architecture and one Git commit/tree pair;
- the node-specific local-authority SPKI path and SHA-256;
- local-authority CNG key name and security-descriptor SHA-256;
- mTLS client certificate DER SHA-256, fixed `MY` store, and private-key security-descriptor
  SHA-256;
- distinct canonical absolute metadata, installation, and trusted-configuration target roots;
- every payload role, root, path, size, SHA-256, and PE target architecture.

Package and installation IDs are lowercase canonical Windows single-component names. Reserved
device names, colons, separators, trailing dots or spaces, and case variants are invalid. This
pure contract deliberately does not derive a required target-root layout from those IDs. The
future filesystem assembly and bootstrap gate must bind the signed IDs to the actual directory
placement before it can mint installation evidence.

The node identities, target roots, and two bootstrap hashes in `BuildOptions` are ordinary
assembler-origin data. `BuildIndex` commits them to canonical bytes but does not establish their
provenance. `ValidateAgainstRelease` verifies only that an index reproduces the exact finalized
release closure; it intentionally reuses those fields from the index and therefore does not bind
them to an independent node authority. Future handle-bound bootstrap, filesystem, CNG, certificate,
and compiled-trust adapters must establish those facts before any installation evidence is minted.

The metadata closure contains exactly these five files:

1. `package-descriptor.json`
2. `prepare-receipt.json`
3. `reviewed-closure.json`
4. `compiled-release-template.json`
5. `servicehost-build-receipt.json`

The installation root additionally contains the indexed `release-manifest.json`. The trusted
configuration root contains the indexed `control-service-host.json` and
`executor-service-host.json`. The runtime manifest deliberately excludes itself and both bootstrap
files, preserving the non-cyclic manifest rule. Every other installation or trusted-configuration
payload must reproduce one runtime-manifest entry exactly. The index builder consumes the exact
document copies retained by opaque `releasepackage.FinalizedRelease`; it does not reconstruct
release metadata from caller fields. `BuildIndex` obtains them through one cleanup-gated
`AssemblySnapshot`, so a release or native-handle quarantine published before the snapshot commit
prevents package assembly.

Payload roles are closed. Portable-executable roles repeat the index target architecture;
non-PE roles must omit it. Legacy `worker.mjs`, maps, build metadata, script payloads, hook trees,
installers, package index/signature aliases, unsafe paths, case collisions, unknown roles, and
unreviewed runtime extras are rejected.

The detached signature envelope has exact canonical fields and uses only
`ecdsa-p256-sha256-p1363-low-s`. It contains the ordinary SHA-256 of the canonical index, the
SHA-256 key ID of one canonical P-256 SubjectPublicKeyInfo document, and a canonical unpadded
base64url encoding of the 64-byte `r || s` signature. The signature input is:

```text
SHA256("AgenticReview outer package index signature v1\0" || canonical_index_bytes)
```

Zero, out-of-range, high-S, DER-encoded, padded, or noncanonical base64url signatures are rejected.
No algorithm negotiation exists. SPKI parsing accepts only canonical P-256 PKIX public-key DER.

`outerpackage` performs pure parsing and cryptographic validation. Its successful results are
ordinary data checks, not installation evidence. The `trustedSPKI` argument to detached signature
verification is not self-authenticating. A future production adapter must obtain it exclusively
from a compiled `outertrust` authority and must not accept a package, command-line, environment, or
runtime-configuration key as trust input.

## Consequences

- A package for another node, installation identity, architecture, source tree, CNG key, mTLS
  credential, or target root has a different signed index.
- Signing covers metadata and payload identities without introducing a package-index self hash.
- Pure validation can be reused by release tooling without granting filesystem or service-control
  authority.
- A future installer must independently enumerate the physical package, verify every indexed byte,
  reject index/signature duplicates and all unindexed objects, parse and cross-bind both bootstrap
  configurations, obtain the outer signer key from compiled trust, and only then mint opaque
  installation evidence.

## Non-Goals

This decision does not define a private-key signer, archive format, downloader, filesystem reader,
installer, rollback mechanism, SCM service creation, CNG provisioning, bootstrap generation, or
production `outertrust` adapter. It does not enable Claim or add any execution-authority field.
