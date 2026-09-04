# ADR 0011: Signed Package Admission v1

> Superseded by ADR 0029 before publication. Retained as a historical design record only.

> Historical exact profile note: ADR 0025 removes Worker mTLS credentials from the selected product
> design. This v1 admission profile is not reinterpreted; a new profile must replace its mTLS
> bindings before production use. ADR 0026 makes compiled package trust, node-specific admission,
> retained handles, and opaque evidence replaceable implementation candidates rather than future
> installer requirements.

## Status

Historical implementation record; not a production-installer prerequisite after ADR 0026.

## Context

ADR 0010 defines a canonical outer package index and a detached P-256 signature format. Its pure
verification function deliberately accepts an ordinary SPKI and returns no authority evidence.
Production admission therefore still needs a non-substitutable signer key and a binding between
the signed index and the two ServiceHost bootstrap documents.

The bootstraps use canonical `config` schema version 3. That schema version describes ServiceHost
startup configuration; it is not a RoleConfig v3 and does not enable execution. The runtime
RoleConfig derived later by the guarded preflight chain remains foundation version 2 with
`executionEnabled=false` and `maximumSlots=1`.

## Decision

`outertrust` compiles exactly one canonical P-256 signer SPKI and an independently approved
SHA-256. Ordinary builds contain empty constants and `Production` fails closed. Controlled builds
generate a constants-only source file under `agenticreview_outertrust`. The generator requires an
exact 64-byte approval file distinct from the SPKI and output files. No runtime key source or
private-key operation exists.

`outeradmission.Admit` has exactly four byte inputs: index, detached envelope, Control bootstrap,
and Executor bootstrap. It obtains opaque trust evidence internally from `outertrust.Production`.
It bounds and clones all inputs once, verifies the signature, reparses the same snapshots, and
rejects any mutation between those phases.

Both bootstrap documents are parsed by the existing strict `config.Parse` implementation. The
admission stage binds their exact bytes to the fixed bootstrap payload entries and checks their
pairwise service identities, Worker node, release, roots, manifest selector, local-authority key,
mTLS credential, shared limits, and role-specific runtime selectors against the signed index. This
includes Node, both bundles, the root CA, ProcessHost, Executor policy, and the node-specific SPKI
path and digest.

The returned `SignedPackagePlan` has no exported fields, rejects JSON serialization, revalidates its
private snapshots, and returns only detached copies. It is a signed logical plan, not filesystem,
installation, SCM, CNG, certificate, Claim, or execution evidence. It carries no foundation
version, execution-enabled flag, maximum-slot value, RoleConfig document, or RoleConfig authority.

## Deliberate Limits

The four inputs do not provide the bytes of the package descriptor, runtime manifest, node SPKI, or
other indexed payloads. Consequently this stage cannot prove descriptor
`executionAuthority=false`, manifest-to-payload content closure, P-256 content for the node SPKI,
Authenticode lineage, or actual file identity. It also cannot derive physical placement of the
package ID, installation ID, or metadata root from the bootstraps. Those values remain authenticated
assembler data in the signed index.

The bootstrap pair's data-root non-overlap check is the existing case-insensitive lexical schema
rule, not physical Windows isolation evidence. It does not resolve final paths, aliases, volumes,
hard links, or reparse points and cannot replace handle-bound directory verification.

A later Windows package verifier must retain trusted traversal handles, enumerate the exact staged
closure, hash and parse every indexed payload, bind descriptor and manifest contents, validate PE
architecture and Authenticode, verify the actual SPKI bytes, and bind physical target placement.
Only a later installer boundary may mint installation evidence after that work completes.

## Consequences

- A package key supplied by an archive, environment variable, argument, or runtime configuration
  cannot replace the compiled outer signer.
- A valid signature over an index cannot be combined with bootstraps from another node, role,
  release, root, key, credential, policy, runtime, or manifest selection.
- The default build cannot admit packages, and this slice does not connect admission to an
  installer or any runtime launch path.
- An architecture test permits only the handle-bound `stagedpackage` verifier to import
  `outeradmission`; all installation and runtime paths remain disconnected.
- Claim remains denied by the committed RoleConfig v2 foundation.

## Non-Goals

This decision does not implement archive parsing, filesystem reads or writes, package download,
private-key signing, Authenticode verification, CNG or certificate provisioning, SCM operations,
installation, rollback, service launch, or Claim enablement.
