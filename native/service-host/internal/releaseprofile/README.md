# Compiled Release Template

This package defines the independent authority contract between a signed
`AgenticReview.ServiceHost.exe` and the runtime release manifest. Code consuming this contract must
never derive authorization from the installed manifest, bootstrap configuration, command line, or
environment. Instead, the release pipeline compiles one canonical release template into
ServiceHost.

The template uses this exact schema:

```json
{"authenticodeLeafSignerCertificateDerSha256":"<approved-lowercase-sha256>","compatibility":{"workerApiProtocolVersion":"1.0","localProtocolMajor":1,"localProtocolMinimumMinor":0,"localProtocolMaximumMinor":0,"serviceHostRpcVersion":1,"processHostProtocolVersion":1},"dependencies":[{"root":"installation","path":"<canonical-relative-path>","role":"<non-service-host-role>","sha256":"<lowercase-sha256>","size":"<canonical-unsigned-decimal>"}],"profileId":"static-review-v1","releaseId":"<release-id>","schemaVersion":1,"serviceHost":{"root":"installation","path":"native\\AgenticReview.ServiceHost.exe","role":"service-host"}}
```

`dependencies` contains every runtime manifest file except ServiceHost itself. Entries use the
same root, path, role, digest, size, ordering, limits, and required-role rules as the canonical
schema-v2 release manifest. A dependency cannot use the `service-host` role or the fixed
ServiceHost path. The top-level `serviceHost` object is mandatory, unique by schema, and has no
digest or size.

Omitting the self digest is intentional. Embedding the final hash of an executable in that same
executable would require finding a SHA-256 fixed point. The release pipeline hashes the final
signed ServiceHost after compilation and writes that value only to the installed runtime manifest.
Native preflight must later bind that manifest entry to the running process, exact installed File
ID, size, hash, and the Authenticode leaf signer pinned by this compiled template. The final
ServiceHost must be non-empty and no larger than the reviewed `MaximumServiceHostBytes` limit of
512 MiB. Template validation reserves that entire amount in the release-manifest aggregate budget.

## Runtime contract

`Production` is the only function that creates valid `Evidence`. It reads only generated Go
constants selected at compile time. `Evidence` has private state, rejects its zero value, reparses
its retained canonical bytes in `Validate`, recomputes its deterministic digest, and exposes only
copy-returning accessors.

The root release-tag bridge performs an init-time `Production` and `Validate` solely to make a
missing or corrupt template fatal before `main`. It retains and exports no evidence. The production
Windows composition independently calls `Production` as its first authority-loading step and
consumes that result as its sole release-template authority for installation verification and
preflight.

An ordinary build includes `compiled_unavailable.go`; `Production` returns `ErrUnavailable`. A
release build must use the `agenticreview_release` build tag. With that tag, omitting the generated
source is a compile error. A generated source file must never exist in the checkout, tracked,
untracked, or ignored. Never commit a sample signer pin or placeholder production digest.

## Controlled reproducible release build

The template must be created from a trusted staged inventory of all non-ServiceHost artifacts. The
expected digest is a separate, exact 64-byte lowercase-hex file from the release inventory or
attestation that approved those canonical bytes. Both inputs are opened read-only and must be
non-symlink regular files. The destination must be an absolute, nonexistent
`AgenticReview.ServiceHost.exe` path outside the repository.

```text
C:/trusted-release-tools/servicehostrelease.exe \
  -template C:/release-input/release-template.json \
  -expected-sha256-file C:/release-input/release-template.sha256 \
  -output C:/release-output/AgenticReview.ServiceHost.exe \
  -receipt-output C:/release-output/AgenticReview.ServiceHost.build-receipt.json \
  -arch amd64 \
  -go-tool C:/trusted-go/bin/go.exe \
  -go-tool-sha256-file C:/release-input/go.exe.sha256 \
  -git-tool C:/trusted-git/cmd/git.exe \
  -git-tool-sha256-file C:/release-input/git.exe.sha256 \
  -module-cache C:/approved-read-only-go-module-cache \
  -build-root C:/protected-release-build-root
```

This driver is the only supported release build path. It rejects a dirty checkout, every untracked
file, ignored files below the ServiceHost module, any physical generated source, an in-repository
or existing output, and a mismatched independent digest. Git runs with an exact environment
allowlist, an empty private global configuration, a private empty hooks directory, replacement
objects disabled, and fixed configuration guards. Repository-local configuration is restricted to
a narrow set of inert checkout metadata; command-capable configuration and repository-local
`info/attributes` are rejected. The driver captures one commit, derives its tree from that commit,
inventories every ServiceHost blob, and creates a bounded tar archive for that identity. Its
internal extractor rejects noncanonical paths, links, devices, duplicate or case-conflicting names,
and size or count overflows. Every extracted file must exactly match the fixed tree by path, size,
and Git blob ID.

The private source snapshot is sealed read-only and retained by a directory identity handle. The
driver renders and AST-validates a constants-only source, writes and flushes that source with
exclusive creation, and exposes it at the fixed nonexistent target inside the snapshot only through
a Go overlay. The build uses `-mod=readonly`, `-trimpath`, `-buildvcs=false`, the explicit release
tag, a disabled workspace and Go environment file, no proxy, no cgo, and an explicit Windows
architecture. Go receives an exact environment allowlist without Git on `PATH`. Go and Git are
absolute, read-only launchers pinned by separate SHA-256 files. The module cache is an explicit
approved input and passes `go mod verify` before and after compilation; the Go build cache, GOPATH,
home, and temp roots are new private directories. The driver uses structured `go mod edit -json`
output to reject every local module replacement, and rejects assembly source files in the snapshot,
so module and assembler source cannot escape to an unverified local path.

Before publishing, the driver revalidates the complete snapshot against the fixed Git tree,
rechecks the original checkout's commit and tree, verifies all retained directory identities, and
revalidates the generated source, overlay, launchers, template inputs, and module cache. It parses
both the retained compiler output and retained published output as bounded PE32+ images, requires
the requested AMD64 or ARM64 machine and executable characteristic, checks header and section
bounds, and compares source-before-copy, copy-stream, source-after-copy, and retained-output
SHA-256 values. Publication uses exclusive creation outside the repository. The driver also emits
a canonical build receipt binding the source commit and tree, release-template digest, target
architecture, unsigned output SHA-256 and size, and a signing-invariant SHA-256. The invariant
normalizes only the PE checksum and certificate-table directory and excludes exactly one terminal
WIN_CERTIFICATE table, so final verification can prove that signing did not replace the built
image. Private files are removed on handled return paths; crash or force-termination cleanup
belongs to the CI job.

On Windows, the private build directory and pre-provisioned output directory use a protected DACL
containing only the release-builder SID, `SYSTEM`, and local Administrators. The approved
module-cache root grants the release builder read/execute only. POSIX builders require each
controlled directory to be owned by the effective release-builder UID, private build/output leaves,
and a non-writable module cache. Retained directory handles are rechecked against their paths; on
POSIX, `os.SameFile` binds those checks to device and inode identity.

The driver has one total deadline and shorter Git, module verification, and compilation deadlines.
It kills and waits for each direct child and bounds captured child output. It does not provide full
descendant-process containment. The signed CI job must run the entire invocation inside a Windows
Job Object or a Linux cgroup/systemd scope with its own hard deadline, kill-on-close policy, and
residual-directory cleanup.

Direct release-tag builds are intentionally unsupported and fail without the private overlay.

### Trusted build base

This driver is reproducible within a controlled build base; it is not a defense against a
malicious build host or toolchain. The signed CI image, complete Go distribution, complete Git for
Windows distribution, approved module-cache subtree, operating system, and protected ancestors of
the build and output roots are external trusted inputs. Pinning the Go and Git launcher files,
scrubbing their environment, and running `go mod verify` detect common drift but do not attest every
compiler, standard-library, Git helper, DLL, or cache descendant. CI image admission and its
read-only toolchain policy must verify that complete closure before invoking this driver.

Likewise, retained leaf-directory handles, full snapshot revalidation, and output file identity
checks detect changes at their verification points, but they do not resist an administrator or
hostile build host that can replace trusted ancestors and restore them between observations. The
signing stage must approve the exact build-receipt digest, verify the receipt's unsigned hash
against the published output, and preserve its signing invariant while signing. Local
Administrators, `SYSTEM`, root, the CI platform, and the release-signing service
remain outside this driver's threat boundary. Ancestor ACLs and ownership are enforced by that
external trusted build base.

## Release ordering

The first reviewed package-assembly slice lives in `internal/releasepackage`. It constructs and
reparses a canonical prepare receipt only when given the same opaque reviewed-closure evidence. The
closure document fixes the package profile, review-policy identity and version, and every
non-ServiceHost identity. The package calls the type-safe
`releaseprofile.BuildTemplate` API and then requires every mutable release input again before it
will add opaque, externally verified signed-ServiceHost evidence and emit a runtime manifest. Its
outer descriptor is node-specific and fixes RoleConfig foundation version 2 with execution
authority disabled. It does not inspect files, verify Authenticode, sign an artifact, or install a
service; those remain mandatory trusted pipeline stages.

Production evidence loaders traverse from a retained volume-root handle, open every component
relative to its retained parent, keep all ancestors through the verification commit, and fail the
process closed if handle cleanup remains unresolved. Closure and ServiceHost build-receipt
authority each require a separate exact 64-byte digest file in an administrator-sealed hierarchy.
Each loader locks its OS thread before opening a path, rejects every thread impersonation token,
and snapshots a retained primary process token. Administrators membership, including deny-only
membership, and high-risk privileges are forbidden even when disabled. All file, access-token, and
primary-token handles close before the result is committed against the process-global cleanup
epoch and `winfile`'s rejected-handle quarantine. An unresolved close in either domain invalidates
every in-flight and future commit, including Finalize.
Every managed ancestor and approval file has an exact three-principal DACL: SYSTEM and local
Administrators have full control, while the dedicated reader SID has read/execute on directories
and read-only access on the digest file. Other trustees, masks, inherited ACEs, and a reader that
can write, delete, or change ownership or DACLs are rejected.

`VerifiedServiceHostEvidence` can be minted only from the prepared release, the independently
approved controlled-build receipt, and one final signed ServiceHost. The same retained file handle
is used for a bounded read, PE32+ architecture validation, Authenticode verification, and a second
SHA-256 pass. The approved receipt's signing invariant must match the signed image, and the leaf
signer must match the prepared signer pin. Detached metadata, caller-supplied verifiers, and
self-computed receipt digests are not accepted. Exactly one terminal WIN_CERTIFICATE is allowed,
and every alignment-padding byte after its declared length must be zero. The schema-v2 outer
descriptor binds the approved build-receipt digest. A later
`VerifyFinalizedPackage` boundary must reverify the descriptor, manifest, package bytes, signer,
and every receipt binding before installation or publication.

1. Build and sign every non-ServiceHost dependency for one target node and architecture.
2. Parse the independently approved reviewed closure, inventory those final bytes, and generate the
   canonical release template and prepare receipt.
3. Run the controlled `servicehostrelease` driver, independently approve its build-receipt digest,
   and sign the receipt-bound output.
4. Verify and hash the final signed ServiceHost against the approved build receipt.
5. Reinspect the dependency inventory, finalize the complete runtime manifest with that self hash,
   and emit the zero-authority outer package descriptor.
6. Generate the two bootstrap configurations that pin the runtime manifest digest and repeat the
   compiled signer pin.
7. Verify the complete staged tree from zero and sign the outer installer or package.

The bootstrap signer field is a cross-check, not the signer authority. Installation verification
must use the signer pin from compiled `Evidence` for every Authenticode decision.

There is not yet a production release pipeline in this repository. Consequently, the composed
Windows runtime remains unavailable in ordinary builds because they intentionally contain no
compiled release template. ADR 0026 removed the unpublished legacy single-service installer; the
future clean installer may reuse or simplify this release-profile composition but has no
compatibility obligation to it.
