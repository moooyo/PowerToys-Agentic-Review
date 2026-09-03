# Canonical Outer Worker Package

`outerpackage` defines the data-only contract used to assemble and verify a node-specific Worker
transport package. It does not read a filesystem, sign with a private key, install files, provision
CNG keys or certificates, or create Windows services.

ADR 0025 leaves package v1 as immutable schema-v3 mTLS history; this follow-up defines package index
schema 2 with profile `agentic-review-worker-outer-package-v2`. V2 omits `mtlsClientCredential`, selects the fixed
split installer v2 roots, and binds only canonical schema-v4 bootstraps. `BuildIndex` remains the
historical v1 builder; `BuildBearerTokenIndex` is the explicit non-secret v2 builder. Persistent
plaintext Token storage exists only in
`C:\ProgramData\AgenticReview\Control\worker-auth-v1.json`, its SHA-256 digest exists only in the
Server database, and neither value is a package input. V2 rejects that filename at every indexed
path, has no Token, Token-digest, or mTLS field, and rejects complete Token-shaped values in every
identity, key-name, root, and payload-path string written to the signed index.

## Package closure

The canonical `package-index.json` has three roots: `metadata`, `installation`, and
`trusted-configuration`. The index and its detached signature are transport metadata and do not
list themselves as payloads. Every other file has one case-fold-unique root/path entry.

The metadata root has exactly five payloads:

1. `package-descriptor.json`
2. `prepare-receipt.json`
3. `reviewed-closure.json`
4. `compiled-release-template.json`
5. `servicehost-build-receipt.json`

The installation root also has the indexed `release-manifest.json`. The trusted-configuration root
has the indexed Control and Executor bootstrap files. Those three files are intentionally absent
from the runtime manifest. Every remaining installation or trusted-configuration entry must match
the runtime manifest closure and its closed role policy.

The `role-config-v2-node-specific` release profile owns four exact WinSW payload slots in the
installation root: `AgenticReview.Worker.Control.exe` and
`AgenticReview.Worker.Executor.exe` are the two `service-wrapper` payloads, while
`AgenticReview.Worker.Control.xml` and `AgenticReview.Worker.Executor.xml` are the two
`service-config` payloads. The release-profile validator rejects alternate casing, paths, roots,
roles, omissions, and duplicates. Outer index normalization invokes that same validator after
reconstructing the runtime manifest files. Wrapper payloads carry the index target architecture;
configuration payloads never carry one.

Both builders obtain one `releasepackage.AssemblySnapshot`. The snapshot revalidates and clones all
six finalized documents inside the release and native-handle cleanup commit gates. The builder does
not reconstruct reviewed metadata from caller-provided fields. `BuildOptions`, including bootstrap
hashes, target roots, CNG identity, and mTLS identity, remains ordinary assembler input: this package
commits it to signed data but does not verify its provenance. V2 instead accepts
`BearerTokenBuildOptions`, which contains only the package/node IDs, local capability identity,
fixed roots, and bootstrap hashes. Package and installation IDs are
lowercase Windows path components; their eventual physical placement under signed target roots is
left to the future filesystem assembly and bootstrap gate.

## Detached signature

The signature envelope remains schema 1 for both index profiles and fixes
`ecdsa-p256-sha256-p1363-low-s`. Its signature is the canonical unpadded base64url encoding of a
64-byte `r || s` value over:

```text
SHA256("AgenticReview outer package index signature v1\0" || canonical_index_bytes)
```

Verification accepts only canonical P-256 SubjectPublicKeyInfo DER and rejects zero, out-of-range,
or high-S scalars, DER signatures, padding, and algorithm substitution. `VerifyDetachedSignature`
returns only an error. Its `trustedSPKI` input is not an authority source; a future production
adapter must supply that key exclusively from compiled `outertrust` policy.
The signed canonical index bytes already include schema/profile, so a signature produced for a v1
index cannot be replayed over a v2 index or vice versa.

## Authority boundary

Successful parsing, release comparison, or signature verification is an ordinary data result. It
does not authorize installation, service creation, Claim, or execution. A future installer must
enumerate the staged filesystem through stable handles, reject all unindexed objects, hash every
payload, cross-bind both bootstrap documents, enforce target-root and identity placement, obtain
the signer from compiled trust, and mint a separate opaque installation evidence value.

In particular, `ValidateAgainstRelease` checks only that an index reproduces one finalized release
closure. It deliberately reuses the node identity, root, and bootstrap values already carried by
the index; it does not prove those assembler-origin values against an independent node authority.
