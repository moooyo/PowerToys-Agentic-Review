# ADR 0022: Dormant Server Enrollment Binding Authority v1

> Superseded by ADR 0029 before publication. Retained as a historical design record only.

## Status

Superseded by ADR 0025 on 2026-09-03. The receipt, active-status, candidate-mTLS, and Server binding
authority defined here are no longer part of the selected Worker authentication design.

This decision freezes the intended receipt and active-status documents, signature domains, trust
source, Server lifecycle, persistence semantics, authenticated exchange boundaries, and later
Windows publication dependency. This documentation slice implements no TypeScript or Go codec,
database migration, signer, trust key, route, binding resolver, Windows writer, reader, or evidence
consumer. It does not change Worker authentication, Claim, RoleConfig, slots, or execution.

## Context

ADR 0013 requires privileged enrollment to establish a Server-side binding between one exact mTLS
certificate and a stable Worker node before a node-specific package is constructed. ADR 0014 fixes
the local generation-one enrollment record and the final
`server-binding-receipt-v1.bin` path, but deliberately defers the receipt wire format, issuer,
signature algorithm, Server persistence, authenticated exchange, revocation, and verifier trust.

The current Server maps an environment-supplied certificate fingerprint to a `workerNodeId` for
ordinary Worker request authentication. That map is restart configuration, has no signed receipt,
does not bind `installationId` or `enrollmentGeneration`, and has no durable issuance or revocation
history. It is not a receipt issuer and cannot become one by being copied into a document.

The ordering across Server and Windows is security-critical. If a binding becomes normal Worker
authentication authority as soon as a receipt is returned, a crash after the Server commit but
before Windows publishes its final record leaves an orphan certificate that can authenticate. If
Windows publishes a final record before the Server has durably stored the exact receipt, the local
commit marker can name a binding that does not exist. The protocol therefore separates durable
reservation, local create-once publication, active confirmation, and monotonic revocation.

The fixed receipt is an immutable historical statement. No offline document can prove that a
Server-side binding has not been revoked after the document was signed. A separate challenge-bound,
short-lived active-status assertion is required for future live evidence.

## Decision

### Dormant S0 boundary

Slice S0 will be a source-only contract and pure state model. It may define strict TypeScript and Go
codecs, signature verification, a pure lifecycle reducer, unavailable production trust facades,
shared golden vectors, and architecture guards. It has no production consumer and is not exported
from an existing root barrel.

The present documentation slice does not implement S0. Until later slices are separately reviewed:

- `nodeenrollment.Read` remains unavailable on Windows;
- no receipt or status assertion can be issued or verified in production;
- no Server database row, route, listener, signer, or trust key exists;
- the environment certificate map remains the only positive Worker certificate mapping;
- the binding lifecycle supplies no positive or negative Worker authentication decision; and
- no release, installer, service, Claim, lease, or execution path consumes these documents.

### Closed binding lifecycle

The Server lifecycle is closed:

```text
absent -> signing_pending
signing_pending -> reserved | revoked
reserved -> active | revoked
active -> revoked
revoked -> revoked
```

No other transition exists. `revoked` is terminal. A generation-one identity is never unrevoked,
deleted and reused, rebound to another certificate, or replaced by another installation. Rotation,
re-enrollment, and a second enrollment generation require a new profile and review.

The states mean:

- `absent`: no durable Server reservation exists;
- `signing_pending`: the exact statement, authorization binding, issuer key ID, and idempotency
  identity are durable, but no receipt has committed;
- `reserved`: the exact signed receipt bytes and their SHA-256 are durable, but the certificate is
  not active for this authority;
- `active`: the same certificate presented direct mTLS proof of possession after the Windows writer
  published and reverified the final create-once record, and the Server durably bound the exact
  record document SHA-256; and
- `revoked`: an append-only revocation permanently blocks active-status issuance, receipt issuance,
  confirmation, and re-enrollment under this profile.

`bindingRevision=1` is the immutable revision of the generation-one binding identity and signed
receipt. It is not a mutable lifecycle counter and does not change at activation or revocation.

### Exact reserved receipt

The file named `server-binding-receipt-v1.bin` contains strict canonical UTF-8 JSON despite its
binary-safe suffix. The complete document is at most 4 KiB. It has no BOM, insignificant
whitespace, duplicate or unknown member, trailing byte, alternate member order, noncanonical escape,
or non-ASCII string value.

The outer document has exactly these fields in alphabetical order:

```text
ServerBindingReceiptV1 = {
  "algorithm": "ecdsa-p256-sha256-p1363-low-s",
  "issuer": "agentic-review-server-enrollment-binding-authority-v1",
  "issuerKeyId": LowercaseSHA256,
  "profileId": "agentic-review-server-binding-receipt-v1",
  "schemaVersion": 1,
  "signature": UnpaddedBase64URLP256P1363LowS,
  "statement": ServerBindingReceiptStatementV1
}
```

The statement has exactly these fields in alphabetical order:

```text
ServerBindingReceiptStatementV1 = {
  "bindingId": LowercaseUUIDv4,
  "bindingRevision": 1,
  "boundAt": CanonicalUTCMilliseconds,
  "certificateDerSha256": LowercaseSHA256,
  "enrollmentGeneration": 1,
  "installationId": PackageComponentId,
  "statementType": "durable-binding-created",
  "workerNodeId": EntityId
}
```

`boundAt` is chosen once when the durable `signing_pending` identity is created and is retained
across every exact retry. `CanonicalUTCMilliseconds` is exactly
`YYYY-MM-DDTHH:mm:ss.SSSZ`, represents a real UTC instant, and round-trips to the same bytes.

`bindingId` is one lowercase RFC 4122 version-four UUID. `installationId` and `workerNodeId` use the
exact ADR 0014 grammars. The receipt contains no public key, certificate bytes, certificate subject,
SAN, expiry, hostname, URL, capability, slot, Claim, execution, service-start, path, secret, token,
or caller policy.

The signature input is exactly:

```text
SHA256(
  ASCII("AgenticReview Server binding receipt v1") ||
  NUL ||
  canonical(ServerBindingReceiptStatementV1)
)
```

The 32-byte digest is signed with ECDSA P-256. `signature` is exactly the 64-byte IEEE P1363
`r || s` form encoded as strict unpadded base64url. Both scalars are in `[1, n-1]`, and `s` must be
at most the P-256 half order. DER ECDSA, padded base64url, high-S signatures, alternate curve forms,
and signatures over the outer envelope are rejected.

The semantic signature input is that raw 32-byte prehash. A native or raw ECDSA operation signs and
verifies the digest directly and must not hash it again. A Node high-level API that performs
SHA-256 internally must instead receive the exact domain, NUL, and canonical statement preimage so
that its single internal SHA-256 produces the same digest. Passing the already computed digest to
`sign("sha256", ...)` would sign a double hash and is incompatible.

The receipt proves only that the Server durably created the exact reservation. It is not a bearer
token, current-status proof, Worker authentication input, package authority, installation permit,
service authority, Claim authority, or execution authority.

### Exact fresh active-status assertion

A fresh active-status assertion is a separate strict canonical JSON document with its own profile
and signature domain. The complete document is at most 4 KiB and uses the same canonical encoding
and signature-shape rules as the receipt.

Its outer document has exactly these fields in alphabetical order:

```text
ServerBindingActiveStatusV1 = {
  "algorithm": "ecdsa-p256-sha256-p1363-low-s",
  "issuer": "agentic-review-server-enrollment-binding-authority-v1",
  "issuerKeyId": LowercaseSHA256,
  "profileId": "agentic-review-server-binding-active-status-v1",
  "schemaVersion": 1,
  "signature": UnpaddedBase64URLP256P1363LowS,
  "statement": ServerBindingActiveStatusStatementV1
}
```

Its statement has exactly these fields in alphabetical order:

```text
ServerBindingActiveStatusStatementV1 = {
  "bindingId": LowercaseUUIDv4,
  "bindingRevision": 1,
  "certificateDerSha256": LowercaseSHA256,
  "challengeNonceBase64Url": UnpaddedBase64URL32Bytes,
  "enrollmentGeneration": 1,
  "expiresAt": CanonicalUTCMilliseconds,
  "installationId": PackageComponentId,
  "issuedAt": CanonicalUTCMilliseconds,
  "receiptSha256": LowercaseSHA256,
  "recordDocumentSha256": LowercaseSHA256,
  "statementType": "active-binding-current",
  "workerNodeId": EntityId
}
```

The signature input is exactly:

```text
SHA256(
  ASCII("AgenticReview Server binding active status v1") ||
  NUL ||
  canonical(ServerBindingActiveStatusStatementV1)
)
```

The raw-prehash and single-SHA-256 rule defined for the receipt applies identically to this domain.

`challengeNonceBase64Url` is exactly 32 unpredictable bytes encoded as 43 characters of strict
unpadded base64url. A future verifier generates it with the operating-system CSPRNG and retains it
in an opaque process-local `ChallengeState`. That state has no public constructor, clone, serializer,
log projection, or cross-process form. Only its exact public nonce bytes are sent to the Server. The
Server copies those bytes only after direct authentication and does not generate, normalize,
truncate, or substitute them. A verifier must compare the decoded challenge in constant time with
the nonce retained by the same `ChallengeState`.

`issuedAt` and `expiresAt` are canonical UTC millisecond instants. `expiresAt` is strictly later
than `issuedAt`, and their difference is at most 60 seconds. Verification uses a compiled maximum
clock skew of 5 seconds: `issuedAt` may not be more than 5 seconds after the verifier's trusted
current time, and the trusted current time must be strictly earlier than `expiresAt`. There is no
post-expiry grace period.

Signature validity, wall-clock validity, and receipt validity do not replace the expected-challenge,
tuple, receipt-digest, and record-digest comparisons.

The Server signs this assertion only while the exact binding is `active`. `absent`,
`signing_pending`, `reserved`, `revoked`, unknown, corrupt, or issuer-mismatched state returns no
signed status assertion. The assertion is not written to the enrollment record, receipt file,
installer journal, transaction journal, package, Worker receipt, or log.

Status assertion issuance and revocation use the same serialized coordinator. First, the Server
reads and freezes the exact active tuple, binding revision, receipt digest, record digest, issuer,
challenge, `issuedAt`, and `expiresAt`. It signs that frozen statement outside the database
transaction. Before returning any bytes, a second `BEGIN IMMEDIATE` transaction must reverify the
same binding is still `active`, has no revocation, and has the same tuple, revision, certificate,
receipt, record, and issuer. That final recheck is the issuance linearization point. A failed or
ambiguous recheck discards the signature and returns no assertion.

If revocation commits before the final recheck, no assertion is returned. If the final recheck
commits first, a later revocation may leave only the already frozen assertion within its original
signed lifetime. Timestamps are never chosen or extended after the first active read.

Even a valid, unexpired assertion is not a bearer credential or Worker authentication decision. A
future verifier may mint opaque process-local active-status evidence only after verifying the
signature, tuple, digests, trusted time, and fresh challenge, then atomically compare-and-swapping
that `ChallengeState` from unused to consumed. Exactly one concurrent verification can consume a
challenge and mint one evidence value. Assertion replay, a second verifier, a copied nonce without
the original state, or a different challenge cannot mint evidence.

The evidence is also one-shot and binds the signed `expiresAt` plus the verifier's trusted-clock
source. `Validate` and the final consuming operation both require trusted `now < expiresAt` and the
same binding and challenge identity. Expiry, cancellation, close, failed verification, or successful
consumption invalidates the evidence. It has no parser, serializer, clone, receipt projection, or
cross-process form. Future `LiveEvidence` composition consumes it immediately in the same bounded
operation rather than retaining it across installer phases.

Revocation cannot invalidate bytes already signed and delivered. If an `active` binding becomes
`revoked`, an assertion signed immediately before the transition can remain acceptable only through
its original signed expiry. The signed span is at most 60 seconds and there is no post-expiry grace.
Under the explicit trusted-clock uncertainty of at most 5 seconds, the real worst-case staleness is
at most 65 seconds. This is an explicit bounded-staleness window, not instantaneous offline
revocation. A Server outage, expired assertion, challenge mismatch, revoked binding, unknown
binding, or unavailable trusted time fails closed.

### Dedicated issuer and trust source

The receipt and active-status assertion use one dedicated Server enrollment-binding issuer key. It
is distinct from:

- the HTTPS Server private key and certificate;
- the Worker mTLS client CA, leaf key, and certificate;
- outer-package and release signing keys;
- the node-local Control-to-Executor authority key;
- operator OIDC issuers and session keys; and
- any Windows ROOT or enterprise certificate-store trust.

The issuer public key is exactly one canonical, uncompressed P-256 PKIX SubjectPublicKeyInfo DER
encoding. It is 91 bytes and has the fixed prefix
`3059301306072a8648ce3d020106082a8648ce3d03010703420004`. Parsing and re-encoding must reproduce
the exact bytes. `issuerKeyId` is lowercase SHA-256 of those exact bytes.

An independently reviewed compiled and signed trust profile is the only verification trust source.
The receipt, status assertion, caller, CLI, environment, TLS peer, Windows ROOT store, database row,
or arbitrary public-key parameter cannot add a trusted key. The `issuer` string is domain identity,
not a trust root.

S1 will persist one issuer singleton containing the exact profile, algorithm, and key ID. Server
startup, signing, and verification fail closed if the configured signer, compiled trust profile,
and singleton differ. The issuer private key is never stored in the application database.

This profile has no transparent issuer rotation. A future rotation requires a new reviewed profile
and signed trust update. It must retain the old verification key for immutable historical receipts,
bind new issuance to the new profile, and define compromise and rollback behavior. Replacing the
singleton key in place is forbidden.

### S1 persistence, idempotency, and revocation

Slice S1 will add a separately reviewed migration and Server persistence implementation. It will
separate four responsibilities:

```text
server_binding_receipt_issuer
server_binding_authorizations
server_bindings
server_binding_revocations
```

The issuer table is an immutable singleton. The authorization table stores only the SHA-256 of one
cryptographically random 256-bit token, never the raw token. Each authorization binds its exact
operator issuer and subject, `workerNodeId`, `installationId`, `enrollmentGeneration=1`, expected
`certificateDerSha256`, expiry, request identity, and eventual consumed binding ID. The operator
creates the authorization only after independently obtaining the exact candidate leaf DER digest;
the issuance caller cannot choose or replace it.

The first exact issuance request compares the direct mTLS leaf DER digest with the authorization's
expected certificate digest, then atomically compare-and-swaps an unused, unexpired authorization to
`consumed(bindingId, requestDigest)` in the same SQLite transaction that creates
`signing_pending`. The canonical request digest includes the observed certificate digest and the
complete authorized tuple. The pending binding cannot commit without token consumption, and token
consumption cannot commit without that exact pending binding. Authorization expiry is evaluated at
this first linearization point.

After that claim, the same token hash may continue or replay only the same `bindingId`, request
digest, authorized tuple, and exact observed certificate digest, including recovery after the
original authorization expiry.
It cannot create another row or change any binding input. Revocation terminates continuation. A
consumed token is never released, reset, or reused, even after signing failure or revocation.

The binding table stores the immutable tuple, lifecycle state, statement bytes, statement digest,
exact receipt bytes, receipt SHA-256, issuer key ID, authorization identity, `boundAt`, and the
exact record document SHA-256 only after activation. It enforces:

- `UNIQUE(worker_node_id, enrollment_generation)`;
- `UNIQUE(certificate_der_sha256)` even after revocation;
- `enrollment_generation = 1` and `binding_revision = 1`;
- exact pairing between state and nullable receipt or record fields; and
- no identity, issuer, statement, receipt, or digest mutation after first publication.

`installationId` is part of the immutable tuple but is not globally unique; ADR 0014 does not state
that installations on different Worker nodes share one global namespace.

Revocation is append-only, binds the exact binding and prior state, uses a closed local reason code,
and records one authoritative UTC time. It cannot be updated or deleted. Revocation may terminate a
`signing_pending`, `reserved`, or `active` binding and permanently prevents receipt commit,
activation, active-status issuance, recovery download, or re-enrollment under this profile.

S1 signing is asynchronous with respect to the database worker:

1. A transaction validates authorization and uniqueness, atomically claims the token into the exact
   binding ID and request digest, creates `signing_pending`, and stores the exact canonical
   statement, its digest, chosen `boundAt`, and issuer key ID.
2. The dedicated signer signs that stored statement outside the SQLite transaction.
3. A second transaction verifies the signature and uses compare-and-swap to store the complete
   exact receipt bytes and enter `reserved`.
4. The service commits, rereads the stored row, reparses and reverifies the exact bytes, and only
   then returns the receipt.

ECDSA signatures are not assumed deterministic. A concurrent signer or retry after a crash may
produce different valid signatures, but only the first successful compare-and-swap becomes the
receipt. Every exact retry returns the stored bytes; it never signs a replacement. A crash after
commit but before response therefore replays the same receipt.

Reusing a request identity with different inputs, changing any tuple member, binding the same
certificate to another identity, binding another certificate to the same node generation, changing
issuer identity, or retrying a revoked binding is a stable conflict. Database corruption,
ambiguous compare-and-swap outcome, signer mismatch, commit failure, reread mismatch, or unavailable
issuer fails closed and returns no receipt.

The database continues to use its single owner, migrations, WAL, and `synchronous=FULL` durability.
S1 must add strict checks, immutable triggers, concurrency tests, migration backup coverage, bounded
row and receipt sizes, and no receipt or token content in logs.

### S2 authenticated exchange

Slice S2 will add authenticated routes only after S0 and S1 are complete.

An operator preauthorization route requires a production OIDC session, exact same-origin mutation
checks, and a dedicated enrollment-authority subject allowlist narrower than ordinary dashboard
access. The operator request fixes the expected lowercase SHA-256 of the already generated
candidate leaf certificate DER together with the node, installation, and generation tuple. It
issues one bounded, expiring, one-shot authorization token; only its digest is persisted.

Receipt issuance requires direct candidate mTLS proof of possession and the one-shot authorization.
The candidate certificate is not yet in the current Worker certificate map. The dedicated route must
independently require an encrypted `TLSSocket`, `socket.authorized=true`, a nonempty exact peer leaf
DER value, and successful authorization consumption. It computes `certificateDerSha256` from
`getPeerCertificate().raw` and requires it to equal the preauthorized digest before claiming the
authorization or creating a binding.

The route must also prove that the candidate certificate digest is absent from the current
`workerCertificateBindings`, regardless of whether an existing entry would map it to the same or a
different node. A certificate that already has ordinary Worker positive authentication cannot enter
this reservation lifecycle because `reserved` would no longer mean inactive.

The issuance boundary rejects:

- insecure-loopback mode or an HTTP request without direct mTLS;
- a certificate digest, certificate, public key, subject, or SAN supplied in the body;
- `fingerprint256`, a proxy header, forwarding header, forwarded certificate, or caller hostname as
  certificate evidence;
- an authorization outside its exact tuple, expiry, issuer, subject, or one-shot state; and
- any caller-selected issuer, trust key, algorithm, profile, binding ID, timestamp, or Server
  origin.

After the Windows writer has published and reverified the final record, active confirmation uses the
same direct certificate and exact reserved binding. It accepts the exact lowercase
`recordDocumentSha256`, compare-and-swaps `reserved -> active`, commits and rereads the row, and
returns no receipt replacement. Exact confirmation replay is idempotent; another record digest or
certificate is a terminal conflict.

The active-status route also requires the same direct active certificate. The certificate selects
the one binding; a caller cannot select another binding ID. The only caller-controlled assertion
input is the bounded fresh challenge. Reserved, revoked, unknown, ambiguous, or unavailable state
returns no signed assertion.

Receipt recovery download is a separate narrow read boundary. The same direct, authorized candidate
certificate uniquely selects the binding by the SHA-256 of its exact peer leaf DER. Only `reserved`
or `active` returns the exact stored receipt bytes after database reread, canonical parse, digest,
signature, tuple, and issuer-singleton verification. The request accepts no body or query selector
for a binding ID, node, installation, certificate digest, receipt digest, or trust key, and it does
not accept an authorization-token or forwarded-certificate fallback. `signing_pending`, `revoked`,
unknown, ambiguous, corrupt, or issuer-mismatched state returns no bytes. The route never re-signs
or serializes an equivalent replacement. Downloading an active receipt is still historical readback
and never authorizes local record repair, Worker authentication, or fresh evidence.

Recovery download and revocation use the same serialized coordinator. The service first freezes the
same-certificate binding, state, tuple, exact stored receipt, receipt digest, and issuer outside the
response boundary. Before returning any byte, a `BEGIN IMMEDIATE` transaction must reverify that the
binding is still `reserved` or `active`, has no revocation, and has the same tuple, certificate,
receipt bytes, receipt digest, and issuer singleton. This final recheck is the download
linearization point. A failed or ambiguous recheck discards the response.

If revocation commits first, download returns no bytes. If download linearizes first, only that
already frozen exact response may finish after revocation; it remains historical data and cannot
produce authentication, active status, evidence, or local repair authority.

Operator revocation requires a production OIDC session, exact same-origin mutation checks, and the
same dedicated enrollment-authority subject allowlist used for preauthorization. It appends the
terminal revocation and immediately prevents new enrollment receipts, confirmation, downloads, and
active assertions within this authority.

The current environment certificate map remains the sole positive mapping used by existing Worker
routes. Neither S0 nor this authority's binding table is a positive Worker authentication source.
S0 also adds no negative revocation veto to current Worker authentication. Consequently, revoking a
binding does not claim to revoke an independently configured environment-map entry. Any future
Worker-auth migration or negative veto requires a separate atomic rollout and failure analysis.

Active confirmation never writes, refreshes, or proposes an environment-map entry. Adding an active
certificate to positive Worker authentication requires a later, independent atomic rollout that
preserves zero execution and defines revocation, rollback, and first-node behavior.

The current Server also requires a nonempty environment map when insecure Worker authentication is
disabled. First-node startup with an empty map, a dedicated enrollment listener, listener isolation,
and any enrollment-only Server mode remain deferred. This decision does not weaken the current
startup check or reuse the shared listener without a later review.

### Windows publication and active confirmation

The future privileged Windows writer depends on S0, S1, S2, a reviewed enrollment transaction
journal, exact CNG and certificate provisioning, the shared Installer-parent ownership contract,
and a fixed reader identity. It must obtain and independently verify the exact reserved receipt
before constructing the final record that names its SHA-256.

The local publication order remains ADR 0014:

1. Durably record enrollment intent before creating a key, requesting a certificate, or requesting
   a binding.
2. Create and reobserve the two distinct non-exportable keys and the exact mTLS certificate.
3. Obtain the reserved receipt through the authenticated S2 exchange and verify its signature,
   trust key, tuple, certificate digest, and exact bytes.
4. Write and verify candidate receipt and record objects in transaction-owned quarantine.
5. Publish the final receipt create-once, flush the file and parent, reopen it, and reverify bytes,
   identity, security, link count, streams, and alias absence.
6. Publish the final record create-once, flush the file and parent, reopen it, and reverify the same
   properties. The final record is the local commit marker.
7. Confirm the exact final record document SHA-256 to the Server using the same candidate
   certificate.
8. Close all writer authority before exposing any completion or live evidence.

Two files are not described as one physical atomic replace. Atomicity is logical: receipt first,
record last as the commit marker, followed by exact Server activation confirmation. A crash before
local record commit leaves at most a `reserved` Server binding, which is not Worker authentication.
A crash after local record commit but before confirmation leaves a committed local record whose
binding is not active; recovery must exact-replay confirmation or revoke. It never manufactures a
receipt, rewrites the create-once files, or deletes an uncertain key or certificate.

A final receipt without a final record is incomplete enrollment under ADR 0014 and remains
quarantined. Normal recovery must not infer permission to construct or publish the record from the
receipt, candidate bytes, a key, or a certificate. Only a separately reviewed explicit repair path
may reprove the exact durable journal and publication preconditions before completing the record;
otherwise it revokes the binding. A final record without its exact receipt, or any ambiguous local
publication result, always fails closed.

`nodeenrollment.Read` remains unavailable until a later handle-bound reader verifies both fixed
files, exact filesystem identity and security, receipt signature and compiled trust, and all tuple
bindings. A verified receipt still proves historical reservation only. Future `LiveEvidence` must
add native CNG, certificate, architecture, key-separation, and fresh active-status evidence.

### No Worker, Claim, or execution authority

No lifecycle state, receipt field, assertion field, signature, authorization token, database row,
route response, parsed value, or opaque verifier result in this profile grants Worker registration,
positive Worker authentication, heartbeat, Claim, lease, slot, ProcessHost, Codex, repository,
installation, service-start, publication, or execution authority.

Schema acceptance and signature validity are data checks. A future process-local status evidence is
one-shot freshness evidence only and cannot cross IPC, be serialized, or be presented as a bearer
credential. Existing RoleConfig v2 and every zero-execution gate remain unchanged.

### Planned S0 implementation surface

The first implementation slice is limited to source-only dormant files equivalent to:

```text
packages/contracts/src/server-binding-authority-v1.ts
packages/contracts/src/server-binding-authority-v1.test.ts
apps/server/src/enrollment/server-binding-state-v1.ts
apps/server/src/enrollment/server-binding-state-v1.test.ts
native/service-host/internal/serverbindingauthorityv1/
testdata/server-binding-authority-v1.jsonl
```

The TypeScript contract is not exported from `packages/contracts/src/index.ts`. The Server state
module has no route, database, config, app, or production entrypoint consumer. The Go package has no
non-test consumer. Production issuer trust remains an unavailable facade with no embedded test key.

Architecture guards must pin the exact production file set and exported API, reject direct,
subpath, case-alias, runtime-loader, indirect-barrel, and `import = require` production
reachability,
and prove that no Worker, scheduling, lease, Claim, role, installer, or execution module consumes
the dormant contracts.

### Slice dependencies

S1 depends on the complete S0 canonical, signature, trust, lifecycle, and golden-vector surface. It
adds the real migration, persistence repository, signer loader, exact replay coordinator, revocation
repository, startup issuer singleton check, and fail-closed storage lifecycle. It adds no public
issuance route until its crash and concurrency matrix is complete.

S2 depends on S1 and on a separately reviewed enrollment-operator authorization policy. It adds the
OIDC preauthorization, direct candidate-mTLS receipt issuance, same-certificate activation
confirmation, active-status, recovery download, and revocation routes. It must not weaken ordinary
Worker authentication or empty-map startup behavior.

The Windows enrollment transaction, writer, reader, `LiveEvidence`, destination verifier, package
consumer, and installer bridge are later independently reviewed slices. None may be enabled from
S0, S1, or S2 alone.

## Verification Requirements

S0 shared golden vectors must make TypeScript and Go reproduce and parse the same receipt and
active-status bytes and verify signatures against the same fixed public test key. Negative vectors
cover:

- missing, extra, duplicate, reordered, escaped, null, wrong-case, non-ASCII, BOM, whitespace,
  trailing, invalid UTF-8, and oversized documents;
- wrong profile, schema, issuer, statement type, binding revision, enrollment generation, timestamp,
  challenge length, base64url padding, digest length, UUID version, or identifier grammar;
- modified tuple, receipt digest, record digest, issue time, expiry, or challenge after signing;
- wrong key, key ID, curve, domain, signature length, DER signature, zero or out-of-range scalar,
  high-S twin, compressed SPKI, noncanonical SPKI, key substitution, and double-hashed prehash; and
- receipt/status cross-type substitution and use of either document as a bearer or Worker auth
  input.

Challenge and evidence tests cover concurrent double-mint attempts, replay of one assertion against
an already consumed challenge, the same assertion with a new challenge, copied nonce bytes without
the original opaque state, cancellation and close, mint immediately before expiry, and failure to
validate or consume evidence after expiry.

The pure lifecycle matrix covers every allowed transition, every forbidden edge, exact replay,
request-identity conflict, concurrent signing candidates, first compare-and-swap wins, lost
response, atomic token claim with pending creation, exact consumed-token recovery after expiry,
consumed-token conflict, wrong-certificate token theft, revocation from every nonterminal state,
terminal revocation, status signing versus revocation in both linearization orders, download versus
revocation in both linearization orders, and the absence of any active assertion outside `active`.

S1 later adds clean and upgraded migration tests, constraints and trigger mutation tests, backup and
restore, issuer mismatch, signer failure, crash between prepare/sign/CAS/commit/reread/response,
concurrent exact and conflicting requests, receipt byte preservation, bounded rows, and append-only
revocation.

S2 later adds real TLS integration tests proving candidate certificate possession, exact leaf DER
hashing, operator-pinned certificate digest, one-shot authorization, narrow OIDC allowlisting,
same-origin enforcement, rejection of a different CA-valid leaf carrying the right token,
same-certificate confirmation, challenge reflection, hard expiry without post-expiry grace, no
newly linearized assertion after revocation, exact stored-byte recovery download, candidate
environment-map exclusion,
no insecure-loopback fallback, no forwarded-certificate trust, rate limits, response byte
preservation, and token/log redaction.

All implementation validation runs on `ssh test-env`. It includes focused TypeScript and Go tests,
cross-language golden comparison, full repository typecheck, test, build, and lint, full Go unit and
race tests, Go vet, and Windows amd64 and arm64 build, test-compile, and vet. Cross-compilation is
not native Windows trust, CNG, certificate, ACL, atomicity, power-loss, or attack evidence.

## Compatibility

ADR 0014 remains the canonical local enrollment-record and fixed-path contract. This decision
supersedes only its deferral of the Server binding receipt wire format, fresh status format,
lifecycle, trust, persistence target, authenticated exchange target, and revocation semantics. It
does not make the current reader available or change the local record schema.

ADR 0013 remains the enrollment-before-package and zero-execution installation foundation. ADR 0021
continues to require a separately reviewed shared Installer-parent handoff and fresh opaque
enrollment evidence before transaction-store bootstrap.

The existing environment certificate map and Worker API 1.0 remain unchanged. There is no dual-read
or dual-authority fallback between that map and the new binding table. S0 contains no production
receipt issuer and no production trust key.

## Consequences

- A fixed receipt has a byte-exact, cross-language meaning without becoming current authorization.
- Server crash recovery can return the stored nondeterministic ECDSA receipt bytes exactly.
- Local publication cannot activate a certificate before the create-once record is durably verified.
- Fresh challenge assertions bound offline revocation staleness to an explicit short window.
- Revocation is monotonic, while immutable receipts remain valid historical evidence.
- Current Worker authentication and zero-execution behavior remain unchanged.
- Real persistence, routes, Windows publication, reader identity, live evidence, and destination
  evidence remain blocked on later slices and native evidence.

## Deferred Decisions

- the real migration SQL and exact database column encodings;
- the protected issuer private-key storage or HSM integration;
- the compiled signed production trust artifact and issuer rotation profile;
- the enrollment-only listener or safe first-node startup with an empty Worker certificate map;
- the exact OIDC enrollment-authority allowlist and authorization-administration workflow;
- the Windows enrollment journal, CNG and certificate creation adapters, shared Installer-parent
  ACL, reader identity, repair command, and native crash recovery;
- the handle-bound `RecordEvidence` reader and one-shot `LiveEvidence` implementation;
- destination verification, package construction, installer composition, and SCM evidence; and
- any future Worker-auth migration or revocation veto involving the binding table.

## References

- [ADR 0007: Isolate Windows Worker Control and Execution Identities](0007-windows-control-executor-isolation.md)
- [ADR 0013: Windows Node Enrollment and Split Installation](0013-windows-node-enrollment-and-split-installation.md)
- [ADR 0014: Trusted Enrollment Record v1](0014-trusted-enrollment-record-v1.md)
- [ADR 0019: Stage a Dormant RoleConfig v3 Disabled-Execution Lab](0019-dormant-role-config-v3-disabled-execution-lab.md)
- [ADR 0021: Dormant Cross-Version Installer Store v2](0021-dormant-cross-version-installer-store-v2.md)
