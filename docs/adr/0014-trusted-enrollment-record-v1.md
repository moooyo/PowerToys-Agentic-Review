# ADR 0014: Trusted Enrollment Record v1

## Status

Accepted for a non-authorizing, fail-closed RoleConfig v2 contract only. No production enrollment
reader, writer, release consumer, installer consumer, or Server binding authority is available.
This ADR supersedes only ADR 0013's deferral of the canonical record schema and its generation-one
storage profile. Reader identity, receipt authentication, live evidence, rotation, revocation, and
interrupted-enrollment implementation remain deferred.

## Context

ADR 0013 requires node enrollment to precede construction of a node-specific Worker package. The
outer package currently carries a Worker node ID, installation ID, target architecture, local-
authority CNG identity, mTLS credential identity, and target roots, but those values are ordinary
assembler data. Signing an index authenticates the values chosen by the assembler; it does not
prove that they came from the enrolled Windows node.

The existing native primitives solve only parts of this problem. `cng` and `wincert` can inspect
real machine-scoped keys and certificates, while `winidentity` can verify either a running
restricted Worker service or a low-privilege release process. They do not define a durable
enrollment transaction or a trustworthy handoff between a privileged enrollment writer and a
low-privilege release reader.

That handoff cannot be collapsed into one process without a new security decision. The enrolled
private-key DACLs permit only `SYSTEM`, local Administrators, and the Control service SID. A release
reader that cannot mutate independently approved input is deliberately neither administrator nor
`SYSTEM`, and Control does not exist during enrollment. Caller JSON, command-line values, and
environment variables therefore cannot bridge the privilege boundary.

## Decision

### Record and evidence remain different types

`nodeenrollment.Record` is ordinary, non-authorizing data. It can be constructed by any caller and
can be parsed or serialized without granting package, installation, service, Claim, signing, or
execution authority.

`nodeenrollment.RecordEvidence` is an opaque facade whose zero value is invalid. A future reader
may mint it only after it has independently verified the fixed record path, the fixed Server
binding receipt path, their stable filesystem identities and security, and the receipt authority.
Parsing canonical JSON never mints evidence. `RecordEvidence` refuses JSON serialization so it
cannot become a transferable authority token.

Both Windows and non-Windows production reads fail closed in this slice. Non-Windows returns
`ErrUnsupported`. Windows returns `ErrUnavailable` until the reader identity, handle-bound reader,
and Server receipt verifier are implemented and reviewed.

### Fixed generation-one files

The only accepted final paths are:

```text
C:\ProgramData\AgenticReview\Installer\Enrollment\record-v1.json
C:\ProgramData\AgenticReview\Installer\Enrollment\server-binding-receipt-v1.bin
```

The record is canonical UTF-8 JSON with no BOM, insignificant whitespace, duplicate or unknown
keys, trailing bytes, or alternate field ordering. Its maximum size is 64 KiB. The exact schema is:

```json
{"enrollmentGeneration":1,"installationId":"<lowercase-package-component>","localAuthorityCng":{"keyName":"<persisted-key-name>","keyUniqueName":"<observed-unique-name>","publicKeySpkiBase64Url":"<canonical-p256-pkix-der-base64url>","publicKeySpkiSha256":"<lowercase-sha256>","securityDescriptorSha256":"<lowercase-sha256>"},"mtlsClientCredential":{"certificateDerSha256":"<lowercase-sha256>","certificateStore":"MY","privateKeyPublicKeySpkiSha256":"<lowercase-sha256>","privateKeySecurityDescriptorSha256":"<lowercase-sha256>","privateKeyUniqueName":"<observed-unique-name>"},"physicalRootProfileId":"agentic-review-windows-split-roots-v1","profileId":"agentic-review-trusted-enrollment-record-v1","schemaVersion":1,"serverBindingReceiptSha256":"<lowercase-sha256>","serviceIdentityProfileId":"agentic-review-worker-control-executor-v1","state":"committed","targetArchitecture":"amd64","workerNodeId":"<entity-id>"}
```

`targetArchitecture` may instead be `arm64`. The local-authority SPKI is exact canonical P-256
PKIX DER encoded as unpadded base64url. Its recorded digest must match those bytes. The local-
authority and mTLS key unique names and public-key digests must be distinct. These checks establish
only internal record consistency; the future live verifier must compare them with native CNG and
certificate observations.

The installation ID uses the same lowercase Windows-safe component syntax as the outer package.
The Worker node ID, target architecture, lowercase SHA-256 values, and `MY` certificate store use
the same syntax and constants as the existing outer package and credential contracts. The v1 key
name and unique-name fields intentionally use the outer package's bounded printable-ASCII subset.
The native CNG primitives can observe a broader 256-UTF-16-unit name, but a future writer must fail
closed rather than publish a native name that this record cannot represent.

There is exactly one v1 generation. `enrollmentGeneration=1` and `state=committed` are constants.
The v1 reader rejects every other generation or state. Rotation, replacement, and re-enrollment
are unsupported rather than implicit overwrite operations.

### Fixed service and physical-root profiles

The record selects profiles by fixed IDs instead of carrying caller-selected service identities or
paths. `agentic-review-worker-control-executor-v1` expands only to:

```text
AgenticReview.Worker.Control
S-1-5-80-2091717111-3815740202-2957909909-902494971-3397275836

AgenticReview.Worker.Executor
S-1-5-80-2741783613-3141871344-3258369507-3627446740-1359970993
```

`agentic-review-windows-split-roots-v1` fixes these exact persistent roots and derivation parents:

```text
C:\Program Files\AgenticReview\Worker
C:\ProgramData\AgenticReview\TrustedConfig
C:\ProgramData\AgenticReview\Control
C:\ProgramData\AgenticReview\Executor
C:\ProgramData\AgenticReview\ServiceWrapper\Control
C:\ProgramData\AgenticReview\ServiceWrapper\Executor
C:\ProgramData\AgenticReview\Installer
C:\ProgramData\AgenticReview\Packages
C:\ProgramData\AgenticReview\Staging
```

The first seven entries are exact persistent roots. `Packages` is the parent for the exact
`Packages\<packageId>` metadata root, while `Staging` is the parent for the transport-only
`Staging\<transactionId>` path and is not a target root. Both child paths are derived from separately
validated identifiers and are not enrollment-record fields or caller-selected roots.

### Privileged writer and low-privilege reader are separate phases

A future privileged writer performs native enrollment, obtains the Server binding receipt, and
then publishes generation one. The writer may run as `SYSTEM` or under a reviewed administrative
installer identity because those principals already own recovery access to the CNG keys. The
writer never exposes a private-key handle or bytes to the release reader.

The final Enrollment directory, record, and receipt use protected, non-defaulted DACLs. `SYSTEM`
and local Administrators have full control. One dedicated release-reader SID has read/execute on
managed directories and read-only access to the two final files, with no create, append, write,
delete, `WRITE_DAC`, or `WRITE_OWNER` access. No other trustee or inherited ACE is accepted. The
exact dedicated reader identity and service or account provisioning are deliberately not guessed
in this ADR. Until a later decision fixes that identity and the corresponding native token
contract, the Windows reader remains unavailable.

The low-privilege reader opens from a retained volume-root handle, verifies a fixed NTFS volume,
every component identity, non-reparse state, hard-link count, case mode, streams, owner, DACL, and
effective mutation denial, and retains or revalidates the complete path through evidence commit.
It accepts no record path, receipt path, security descriptor, SID, verifier callback, public key,
or trust selector from its caller.

### Server binding receipt

The final receipt must prove that the Server durably bound the record's exact mTLS certificate DER
SHA-256 to the same `workerNodeId`, `installationId`, and `enrollmentGeneration=1`. It must also be
domain-separated from package signing, local Control-Executor signing, and TLS certificates. It
does not grant execution, slots, Claim, publication, installation, or service-start authority.

The record stores only the SHA-256 of the exact receipt bytes at the fixed receipt path. The receipt
wire format, issuer key, signature algorithm, online enrollment exchange, Server persistence API,
revocation behavior, and verifier trust source remain deferred. A local digest without successful
receipt verification is not binding evidence. Consequently, the present Windows `Read` cannot mint
`RecordEvidence`.

The Server's current environment-supplied certificate map is not a receipt issuer and cannot
satisfy this requirement. A later Server ADR and migration must establish durable binding state and
the authenticated receipt protocol before the native reader becomes available.

### Crash recovery and publication ordering

Generation one is create-once. A future writer records durable transaction intent before creating
a key, requesting a certificate, or publishing a Server binding. It writes and flushes candidate
receipt and record objects in a transaction-owned quarantine, verifies their exact bytes and
security, publishes the final receipt first, and creates the final record last. Creation of the
final record is the local commit marker and must fail if that path already exists.

A receipt without a final record, a final record without its exact receipt, any mismatched digest,
or any journal or candidate ambiguity is incomplete enrollment. Recovery keeps it quarantined and
requires explicit repair or revocation. It never infers success from the presence of a CNG key or
certificate, never silently overwrites the final files, and never deletes a key or certificate
merely because publication was interrupted.

The exact journal encoding, write-through operations, directory flush implementation, enrollment
writer, and repair command remain deferred. Their absence keeps all production evidence reads
unavailable.

### Future live evidence

The installer requires stronger evidence than the low-privilege release reader. A future opaque
`LiveEvidence` boundary must re-read the committed record and receipt, observe native OS
architecture, inspect the local-authority key through `cng`, inspect the certificate and private key
through `wincert`, compare every recorded digest and unique identity, reject key reuse, and close
all native resources before evidence commit. It must serialize cleanup against the existing native
handle quarantine.

`winidentity.Preflight` is not used for enrollment because it requires already installed services
and a restricted service process token. The later destination verifier separately proves the SCM
service names, SIDs, accounts, SID type, physical roots, and installed bytes after service creation.

## Consequences

- A canonical record can now be tested and transported as ordinary data without being mistaken for
  enrollment authority.
- No JSON field, CLI flag, environment variable, parsed `Record`, or zero `RecordEvidence` can
  authorize a release or installation.
- Release and outer-package integration must wait for a real handle-bound reader and Server receipt
  verifier. No production package is made publishable by this decision.
- Generation-one enrollment cannot rotate. Rotation requires a new ADR, schema or profile, Server
  protocol, and recovery analysis.
- RoleConfig v2 remains fixed at zero execution. This record contains no execution switch, slot
  value, Claim authority, SCM mutation, or service-start instruction.

## Deferred Decisions

- the dedicated release-reader identity and how it is provisioned;
- the Server binding receipt wire format, signing key, signature algorithm, storage migration,
  enrollment API, revocation, and trust distribution;
- the privileged enrollment writer and its CNG, certificate issuance, journal, flush, quarantine,
  repair, and revocation implementation;
- the handle-bound Windows `Read` implementation and opaque `LiveEvidence` type;
- releasepackage and outerpackage evidence consumers; and
- destination verification and the production split installer.

## Non-Goals

This decision does not create or mutate keys, certificates, files, ACLs, services, firewall rules,
SCM state, Server bindings, package indexes, release documents, or installation roots. It does not
implement Claim, ProcessHost, Codex, repository commands, publication, RoleConfig v3, or any
execution-capable path.
