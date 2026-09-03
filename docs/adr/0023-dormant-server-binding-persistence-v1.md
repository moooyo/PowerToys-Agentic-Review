# ADR 0023: Dormant Server Binding Persistence v1

## Status

Superseded by ADR 0025 on 2026-09-03. The receipt-signing aggregate and migration were removed in a
pre-release schema reset; the details below describe historical source only and are not present in
the current production schema.

This documentation slice freezes the S1 SQLite schema, transaction boundaries, exact replay,
asynchronous receipt-signing coordination, issuer bootstrap checks, monotonic revocation, storage
lifecycle, and implementation reachability anticipated by ADR 0022. It does not add migration 0012,
database code, a signer, a production trust profile, an enrollment route, an OIDC policy, a new TLS
listener, a Windows enrollment writer or reader, Worker authentication, Claim, slots, package
authority, installer authority, or execution.

## Context

ADR 0022 and its integrated S0 implementation define exact receipt and active-status documents, a
dedicated P-256 issuer, the closed
`absent -> signing_pending -> reserved -> active -> revoked` lifecycle, and ordinary deterministic
validation. S0 deliberately has no persistence, no hydration API, no signer, no production trust
source, and no application consumer.

S1 must make the reservation and revocation lifecycle crash-safe without turning stored rows into
authentication authority. The difficult boundary is the receipt signature. SQLite must first make
the exact authorization consumption, binding identity, timestamp, statement bytes, and request
digest durable. The signer must then run outside the database Worker and outside any SQLite
transaction. A second transaction may commit exactly one valid receipt. ECDSA signatures are not
assumed deterministic, so two valid concurrent candidates can differ even when they sign the same
statement.

The database also needs a permanent answer for one-shot authorization tokens, exact replay after
authorization expiry, terminal revocation, and issuer mismatch after restore. These properties
cannot rely only on service-process locks. Process-local serialization disappears on crash, while
the SQLite owner, foreign keys, triggers, WAL, and `synchronous=FULL` state survive.

This decision therefore treats SQLite transactions and compare-and-swap predicates as the durable
linearization authority. The S0 codec and reducer validate deterministic facts; they do not grant
trust, permission, Worker identity, or execution authority.

## Decision

### Delivery boundary

S1 is split into this decision and one later implementation slice. The implementation slice will
add exactly one migration and a dormant Server persistence subsystem. It will not add public or
Worker routes.

The planned implementation surface is limited to:

```text
migrations/0012_server_binding_persistence_v1.sql
packages/contracts/package.json
packages/contracts/src/server-binding-authority-v1.ts
packages/contracts/src/server-binding-authority-v1.test.ts
apps/server/src/enrollment/server-binding-state-v1.ts
apps/server/src/enrollment/server-binding-state-v1.test.ts
apps/server/src/enrollment/server-binding-trust-profile-v1.ts
apps/server/src/enrollment/server-binding-signer-provider-v1.ts
apps/server/src/enrollment/server-binding-signer-v1.ts
apps/server/src/enrollment/server-binding-coordinator-v1.ts
apps/server/src/database/server-binding-persistence-v1.ts
apps/server/src/database/server-binding-persistence-v1.test.ts
apps/server/src/database/protocol.ts
apps/server/src/database/database-worker.ts
apps/server/src/database/database-client.ts
apps/server/src/database/errors.ts
apps/server/src/database/database-startup.test.ts
apps/server/src/database/migration-backup.test.ts
apps/server/src/config.ts
apps/server/src/config.test.ts
apps/server/src/runtime/server-storage-runtime.ts
apps/server/src/runtime/server-storage-runtime.test.ts
apps/server/src/main.ts
apps/server/src/main.test.ts
```

Test helpers may be separate `*.testing.ts` files. Any additional production file, route, config
field, package barrel, entry point, Worker import, Dashboard import, or native consumer requires
separate review.

The listed config, storage-runtime, and main files may only load the unavailable-by-default signer
and compiled-trust descriptor, pass its public facts into database startup, own the narrow
persistence capability lifecycle, and fail startup when initialized authority data cannot be
audited. They may not register an enrollment route, resolve a Worker identity from a binding, or
return an authority result to another subsystem.

The current S1 implementation intentionally uses less than that allowance: production config and
`main.ts` have no signer field, import, or loader call. The storage runtime can own an explicitly
supplied internal signer context, but production startup supplies none. Adding production main
composition for trust and signer loading requires a later separately reviewed change to the exact
consumer and source-digest guards.

The existing contracts root barrel remains unchanged. S1 may add only the exact package subpath
`@agentic-review/contracts/server-binding-authority-v1` so the Server persistence and signer
adapters can reuse the reviewed S0 bytes. Architecture tests must allow only the reviewed S1 Server
modules to import that subpath. The Go S0 verifier remains unconsumed by production code.

### Persistent aggregate and effective lifecycle

The durable aggregate consists of four tables with fixed names:

```text
server_binding_receipt_issuer
server_binding_authorizations
server_bindings
server_binding_revocations
```

`absent` means that no `server_bindings` row exists. There is no durable empty binding row.

`server_bindings.phase` stores one of `signing_pending`, `reserved`, `active`, or `revoked`.
`bindingRevision=1` and `enrollmentGeneration=1` are immutable identity constants, not lifecycle
counters. No update increments either value.

The only allowed aggregate transitions are:

```text
no binding row -> signing_pending
signing_pending -> reserved
signing_pending -> revoked
reserved -> active
reserved -> revoked
active -> revoked
revoked -> revoked exact replay
```

No row is reset to `absent`. No revoked binding is deleted, unrevoked, rebound, or replaced. The
unique Worker-generation and certificate identities remain occupied forever under profile v1.

Every repository read reconstructs the S0 state by starting with
`createAbsentServerBindingStateV1()` and replaying the stored `begin_signing`, optional
`commit_receipt`, optional `confirm_record`, and optional `revoke` facts in that order. A database
row is never cast or copied directly into a reducer-owned state. Failure to replay exactly is
storage corruption.

### Migration and database ownership

The implementation migration is permanently numbered
`0012_server_binding_persistence_v1.sql`. It creates all four tables, indexes, foreign keys, and
triggers in one normal repository migration transaction. It does not seed an issuer row.

The migration uses SQLite `STRICT` tables. Foreign keys remain enabled. The existing one-process
database owner, migration checksum history, pre-migration online backup, WAL mode, and
`synchronous=FULL` policy remain unchanged. A clean database and an upgrade from schema 11 must
both produce the same schema.

Canonical statement and receipt documents are strict ASCII JSON and are stored as constrained
`TEXT`. SQL requires `json_valid(...)`, top-level object type, no NUL, equal character and UTF-8 byte
length, and the 4 KiB ceiling. Identifiers, digests, profiles, reasons, and canonical UTC
millisecond instants are also constrained `TEXT`. Revisions and generation values are constrained
`INTEGER` constants.

Every mutation operation uses `BEGIN IMMEDIATE`. No transaction remains open while calling a
signer, callback, network operation, logger, response serializer, or process-local queue.

### Fixed encodings and bounds

All lowercase UUIDv4, SHA-256, entity ID, package-component ID, P-256 SPKI, receipt, statement, and
UTC rules are the exact S0 rules from ADR 0022. SQLite checks enforce byte length, lowercase ASCII
shape, fixed constants, nullability, and closed enums. The repository then performs the complete
S0 parse and semantic validation before accepting or returning a row.

The exact bounds are:

- authorization and revocation request IDs are lowercase UUIDv4 values;
- authorization tokens contain exactly 32 CSPRNG bytes and are returned, when a future route is
  added, as 43 characters of canonical unpadded base64url;
- only `SHA256(rawTokenBytes)` is stored; neither the raw bytes nor a hash of the text encoding is
  stored;
- the operator issuer is non-empty, well-formed Unicode, contains no C0 control or U+007F, and
  occupies at most 2,048 UTF-8 bytes;
- the operator subject is non-empty, well-formed Unicode, contains no C0 control or U+007F, and
  occupies at most 512 UTF-8 bytes;
- statement and complete receipt documents each occupy between 1 and 4,096 bytes;
- the issuer SPKI is exactly the canonical 91-byte uncompressed P-256 PKIX DER document; and
- every persisted time is an exact real `YYYY-MM-DDTHH:mm:ss.SSSZ` instant.

The implementation compares copied byte buffers in constant or exact binary form where applicable
and uses exact case-sensitive comparisons for all TEXT values. It does not use locale collation,
Unicode normalization, or case-folding as identity semantics.

### Distinct digest domains

The following values are different facts and must never share a column name or helper name:

1. `token_sha256` is SHA-256 of the exact 32 authorization-token bytes.
2. `issuance_request_sha256` is the domain-separated digest of the internal canonical issuance
   request basis defined below.
3. `certificate_der_sha256` is SHA-256 of the exact peer leaf certificate DER.
4. `statement_document_sha256` is SHA-256 of the exact canonical statement document bytes.
5. `receiptSigningDigest` is SHA-256 of the receipt signing domain, NUL, and exact statement bytes.
6. `receipt_sha256` is SHA-256 of the exact complete canonical receipt document bytes.
7. `record_document_sha256` is SHA-256 of the final local enrollment record document.
8. `revocation_request_sha256` is the separately domain-separated digest of the canonical
   revocation request basis.

Only items 1, 2, 3, 4, 6, 7, and 8 are persisted. The receipt signing digest is derived from the
stored statement bytes immediately before signing and verification. It has no database column.

### Canonical issuance request identity

S1 defines the internal request digest that S0 intentionally left opaque. Its canonical JSON object
contains exactly these members in alphabetical order:

```text
ServerBindingIssuanceRequestBasisV1 = {
  "authorizationExpiresAt": CanonicalUTCMilliseconds,
  "authorizationId": LowercaseUUIDv4,
  "enrollmentGeneration": 1,
  "expectedCertificateDerSha256": LowercaseSHA256,
  "installationId": PackageComponentId,
  "issuerKeyId": LowercaseSHA256,
  "observedCertificateDerSha256": LowercaseSHA256,
  "operatorIssuer": BoundedExactString,
  "operatorSubject": BoundedExactString,
  "requestId": LowercaseUUIDv4,
  "tokenSha256": LowercaseSHA256,
  "workerNodeId": EntityId
}
```

The expected and observed certificate digests must be equal, but both are retained in the digest
input so the authorization source and direct peer observation cannot be silently conflated.

The canonical serializer stages one ordinary null-prototype data object, writes the members in the
order above, and serializes every string with the ECMAScript `JSON.stringify` string algorithm,
without a replacer or spacing. It rejects accessors, symbols, non-enumerable properties, extra
members, reflection failures, and unpaired UTF-16 surrogates before serialization. The exact result
is encoded as UTF-8 with no BOM, whitespace, trailing byte, or Unicode normalization. This internal
serializer has one golden-vector suite and is not replaced by generic key-sorting JSON.

`issuance_request_sha256` is exactly:

```text
SHA256(
  UTF8("AgenticReview Server binding issuance request v1") ||
  NUL ||
  canonical(ServerBindingIssuanceRequestBasisV1)
)
```

The request ID is unique across all authorization rows and is fixed when the authorization is
created. Reusing it with a different token, operator, expiry, tuple, certificate, or issuer is a
stable conflict. The canonical basis is internal persistence data, not a public wire contract or a
credential.

### Issuer singleton

`server_binding_receipt_issuer` contains at most one row. Its columns are:

```text
singleton_id
authority_schema_version
issuer
receipt_profile_id
active_status_profile_id
signature_algorithm
issuer_key_id
initialized_at
```

`singleton_id` is the integer `1`. Every schema, issuer, profile, and algorithm value is the exact
S0 constant. `issuer_key_id` is SHA-256 of the independently trusted exact 91-byte public SPKI. The
database stores neither the public SPKI as a possible trust selector nor the issuer private key.

The singleton has a unique issuer key ID and rejects every update, delete, replacement, or second
row. Profile v1 has no in-place key rotation.

A freshly migrated database may have zero issuer rows only while all three other S1 tables are
empty. The dormant Server can start in that state without a signer because no binding authority
has ever been initialized.

The first explicit S1 authority initialization compares all of the following before inserting the
singleton:

- the loader's canonical public SPKI and derived key ID;
- the independently compiled trusted SPKI and profile constants; and
- the exact S0 issuer, receipt profile, active-status profile, schema, and algorithm.

If a singleton already exists, initialization accepts only byte-for-byte equality. If any S1 row
exists without the singleton, or if the configured signer, compiled trust profile, and singleton
differ, startup fails closed. It never repairs, replaces, or re-seeds the issuer.

Once the singleton or any S1 authority row exists, S1 startup must complete this issuer and full-row
audit before reporting ready. An unavailable or mismatched signer then fails the whole Server
startup; it is not downgraded to an authority-only warning. The exact listed `main.ts` and storage
runtime changes compose only this dormant fail-closed lifecycle. They add no initialization switch,
route, or positive authority consumer.

### Authorization rows

`server_binding_authorizations` stores one append-only authorization with one permitted null-to-set
consumption transition. Its columns are:

```text
authorization_id
request_id
token_sha256
operator_issuer
operator_subject
worker_node_id
installation_id
enrollment_generation
expected_certificate_der_sha256
issuer_key_id
created_at
expires_at
consumed_binding_id
consumed_issuance_request_sha256
consumed_at
```

The authorization ID, request ID, and token digest are independently unique. Creation requires the
initialized issuer singleton and rejects an existing binding for the same Worker generation or
certificate, including a revoked binding.

`created_at` and `expires_at` are chosen by the Server authorization policy, with
`expires_at > created_at`. The later S2 policy will bound the maximum lifetime. The enrollment
caller cannot extend or replace either value.

The three consumed columns are either all null or all non-null. The only allowed authorization
update atomically changes:

```text
(NULL, NULL, NULL)
->
(bindingId, issuanceRequestSha256, consumedAt)
```

Every other field remains byte-for-byte unchanged. A consumed row is never released, reset,
deleted, or reused after signing failure, authorization expiry, activation, or revocation. Expired
unused rows also remain as tombstones in profile v1 so request and token identities cannot be
recycled. Retention or archival requires a later profile and migration.

The table defines
`UNIQUE(authorization_id, consumed_binding_id, consumed_issuance_request_sha256)` and a
`consumed_binding_id -> server_bindings.binding_id` foreign key declared exactly
`DEFERRABLE INITIALLY DEFERRED`. The first claim transaction therefore performs the one conditional
authorization UPDATE before inserting the pending binding. The temporary forward reference exists
only inside that transaction; commit is impossible unless the exact binding row was then inserted.

### Binding rows

`server_bindings` stores the immutable basis and the first committed lifecycle facts. Its columns
are:

```text
binding_id
binding_revision
authorization_id
request_id
issuance_request_sha256
worker_node_id
installation_id
enrollment_generation
certificate_der_sha256
issuer_key_id
phase
bound_at
statement_json
statement_document_sha256
receipt_json
receipt_sha256
record_document_sha256
```

The binding ID is a Server-generated lowercase UUIDv4. `binding_revision` and
`enrollment_generation` are both `1`.

The table enforces permanent uniqueness of:

- `authorization_id`;
- `(worker_node_id, enrollment_generation)`;
- `certificate_der_sha256`; and
- the complete binding/request identity needed by the authorization foreign keys.

The authorization table exposes exact matching `UNIQUE` parent keys. Binding uses an immediate
composite foreign key from
`(authorization_id, binding_id, issuance_request_sha256)` to
`(authorization_id, consumed_binding_id, consumed_issuance_request_sha256)`, plus a second
immediate composite foreign key that covers request ID, issuer key ID, Worker node, installation,
generation, and expected certificate. The fixed transaction order is therefore:

1. conditionally consume the authorization;
2. insert the exact `signing_pending` binding; and
3. commit, allowing the one deferred reverse binding reference to resolve.

Any insert, uniqueness, statement construction, or commit failure rolls the authorization UPDATE
back. This makes authorization consumption without the exact pending binding, and pending binding
creation without the exact consumption, impossible to commit.

The phase and nullable fields are paired exactly:

| Phase | Receipt JSON/digest | Record digest |
| --- | --- | --- |
| `signing_pending` | null | null |
| `reserved` | non-null | null |
| `active` | non-null | non-null |
| `revoked` after `signing_pending` | null | null |
| `revoked` after `reserved` | non-null | null |
| `revoked` after `active` | non-null | non-null |

The matching revocation row's `prior_phase` selects the only valid revoked shape.

The statement JSON, statement digest, tuple, request identity, authorization identity, issuer, and
`bound_at` never change. Receipt commit may set only the first exact receipt JSON and digest.
Activation may set only the first exact record digest. Revocation may change only the phase through
the revocation trigger described below. No binding row can be deleted.

### Revocation rows and request identity

`server_binding_revocations` is append-only. Its columns are:

```text
revocation_id
revocation_request_sha256
binding_id
prior_phase
reason_code
revoked_at
```

`revocation_id` is also the required lowercase UUIDv4 idempotency identity for a revocation
request. It is globally unique. `binding_id` is unique, so a binding has at most one terminal
revocation.

The canonical revocation request contains exactly these members in alphabetical order:

```text
ServerBindingRevocationRequestBasisV1 = {
  "bindingId": LowercaseUUIDv4,
  "reasonCode": ClosedRevocationReasonV1,
  "revocationId": LowercaseUUIDv4
}
```

`revocation_request_sha256` is:

```text
SHA256(
  ASCII("AgenticReview Server binding revocation request v1") ||
  NUL ||
  canonical(ServerBindingRevocationRequestBasisV1)
)
```

The database chooses one authoritative `revoked_at` inside the first transaction. The first insert
captures the exact current nonterminal phase as `prior_phase`. An exact retry with the same
revocation ID and digest returns the retained row. Reusing the ID with different input, or using a
new ID after the binding is revoked, is a stable terminal conflict.

The closed reasons remain:

```text
binding_compromised
enrollment_abandoned
integrity_failure
operator_requested
```

Revocation INSERT and `phase -> revoked` are one atomic operation. A `BEFORE INSERT` trigger proves
that the binding exists, is not revoked, has no prior revocation, and matches `prior_phase`. An
`AFTER INSERT` trigger updates exactly that binding to `revoked`. The binding transition trigger
allows a transition to `revoked` only when the just-inserted immutable revocation row matches the
old phase. Any failed comparison aborts the complete transaction. Revocation rows reject every
update and delete.

### SQL mutation guards

Migration 0012 must enforce the aggregate independently of ordinary repository code.

Issuer triggers reject all updates and deletes. Authorization triggers reject noncanonical initial
rows, partial consumption, second consumption, mutation of immutable fields, and deletion. Deferred
foreign keys reject either half of authorization consumption and pending binding creation.

A `BEFORE INSERT ON server_bindings` trigger accepts only `phase='signing_pending'`, null receipt
and record fields, the exact consumed authorization pair, the canonical stored statement, and no
revocation row. Direct insertion of `reserved`, `active`, or `revoked` is always rejected even when
its nullable fields would otherwise form a valid later-state shape.

Binding triggers permit only these exact updates:

1. `signing_pending -> reserved`, setting only the receipt bytes and receipt digest;
2. `reserved -> active`, setting only the record document digest; and
3. a nonterminal phase to `revoked` through the matching revocation-insert trigger.

Every receipt or activation transition requires that no revocation row exists. All identity,
statement, request, issuer, timestamp, and previously committed document fields are immutable.
Delete is forbidden.

Revocation triggers enforce one row, one exact prior phase, the closed reason set, immutable request
identity, atomic terminalization, and no update or delete.

The repository treats every SQLite constraint or trigger failure as an internal invariant failure
unless it has first classified an expected uniqueness or compare-and-swap outcome by rereading the
exact rows. Raw SQLite error text is never exposed as a stable application result.

### Opaque database capability

The S1 database operations are not available through the generic `DatabaseClient.request` method.
`DatabaseClient` may mint exactly one opaque server-binding persistence handle. Only the reviewed
S1 coordinator can adopt it, and closing or terminal database failure revokes it.

The database Worker protocol receives only copied, bounded data. It never receives a raw
authorization token, private key, signer callback, caller-selected trust key, TLS socket, OIDC
session, or HTTP request. The coordinator hashes token bytes before crossing the Worker boundary.
The Worker receives the one independently compiled trusted issuer descriptor selected before
startup, never a per-operation SPKI.

The minimum internal operation groups are:

- initialize and audit the issuer singleton;
- create an authorization from an already authorized operator decision;
- atomically claim or replay an authorization and create `signing_pending`;
- commit or replay the first valid receipt;
- confirm or replay the exact record digest;
- read a strictly verified reserved or active receipt snapshot;
- read and transactionally recheck an active binding snapshot for future S2 status issuance;
- append or replay one revocation; and
- perform the bounded startup integrity audit.

No operation returns a positive authentication, Claim, slot, execution, installation, or package
decision.

### Authoritative clocks and generated identities

The raw authorization token is generated with the operating-system CSPRNG by the coordinator. The
authorization ID and request ID are Server-generated. The database Worker generates the binding ID,
`bound_at`, and `consumed_at` after `BEGIN IMMEDIATE` and before the atomic first commit. It generates
`revoked_at` inside the revocation transaction.

Caller-supplied values cannot choose or replace those facts. Tests may virtualize the process clock
and assert generated UUID properties, but the production implementation exposes no clock, UUID, or
provider attachment.

Authorization expiry is evaluated strictly at the first claim transaction:

```text
unused authorization is claimable iff transactionNow < expiresAt
```

`transactionNow` advances the existing singleton `operator_auth_clock` high-water mark inside the
same `BEGIN IMMEDIATE` transaction. S1 startup pins that table's exact schema and requires exactly
one `singleton = 1` row. Every claim update must affect exactly one clock row and every subsequent
read must return exactly one canonical timestamp. Once a claim observes a later time, an expired
result or a recoverable immutable-identity conflict commits the advanced high-water mark before the
stable application error is returned; neither path may roll observed time back.

After exact consumption, later continuation ignores authorization expiry but must match the stored
token hash, request ID, request digest, binding ID, certificate, tuple, and issuer. A different token
or request cannot inherit that exception.

### Signer profile and trust bootstrap

S1 defines a package-private signer-loader contract but does not select a production private-key
store or HSM. The production loader remains unavailable until a later decision provides protected
key storage and a compiled signed trust artifact. Tests replace the provider module only through
test-runner module isolation; the production loader exposes no test attachment or mutable
registration path. Tests must not place a production private key or signer in a package export,
environment fallback, fixture, or database.

The provider contract is Promise-only and represents an already-isolated signer child-process
transport, not an in-process HSM, CNG, native SDK, or synchronous callback. The Server process may
only copy bounded input into IPC and return a native Promise immediately. Abort must cancel or fence
the remote request, and `close()` must cancel outstanding work, forcibly terminate the isolated
owner when graceful cancellation cannot finish, and resolve only after process exit is observed.
Worker Threads are insufficient for a potentially blocking native signer. Until that reviewed
process boundary exists, the production provider remains deliberately unavailable.

If validation rejects a loaded provider candidate, its close operation is bounded. A close
rejection or deadline expiry permanently poisons signer loading in that process, retains the
candidate in a process-lifetime quarantine until a later successful close can be observed, and
returns one stable startup-fatal error whose cause aggregates validation and cleanup failures. The
failure must never be downgraded to an ordinary unavailable retry while owner exit is unproven.
Candidate loading is serialized, and cleanup counts as successful only when an exact own data
`close` function returns a native Promise that resolves.

The same quarantine rule applies after a context has been adopted: normal or failure-driven signer
shutdown places the provider adapter in process-lifetime quarantine before dropping the context's
reference and removes it only after the native close Promise resolves. Rejection, an invalid return,
or a caller-side close timeout leaves the provider quarantined.

The loader returns one immutable signer context only after the provider-reported public SPKI matches
the independently loaded, compiled S0 trust profile. The coordinator then compares that context with
the startup database descriptor and initializes or replays the singleton before it publishes any
authority. Per-request caller keys and callbacks are forbidden.

The signer API distinguishes two provider shapes:

- a high-level provider signs the exact domain-separated preimage and performs exactly one internal
  SHA-256; or
- a digest-native provider signs the already derived 32-byte digest without hashing it again.

A generic ambiguous `sign(bytes)` surface is forbidden. Every result must be exactly 64-byte IEEE
P1363, have scalars in range, use low-S form, and verify against the trusted canonical SPKI before it
can reach the receipt commit transaction. A provider result may be normalized from high-S to its
mathematically equivalent low-S value only inside the reviewed signer adapter, followed by complete
verification.

### Receipt issuance coordination

The exact issuance flow is:

1. The coordinator decodes and copies the 32-byte token, hashes it, and discards the raw mutable
   bytes as soon as practical.
2. A first `BEGIN IMMEDIATE` transaction loads the authorization by token hash, verifies the exact
   request identity, operator-bound authorization facts, expected versus directly observed
   certificate digest, issuer, and uniqueness constraints.
3. For an unused authorization, the transaction requires `now < expires_at`, generates the binding
   ID and `bound_at`, builds the exact canonical S0 statement, derives
   `statement_document_sha256` and the internal `issuance_request_sha256`, consumes the
   authorization, and inserts `signing_pending` atomically.
4. For a consumed authorization, the transaction accepts only the exact stored binding and request
   basis, even after expiry. It returns either the exact stored receipt or the stored pending
   statement. Revocation terminates continuation.
5. The transaction commits before any signer call. The signer signs only the returned stored
   statement bytes.
6. The coordinator constructs and validates a canonical S0 receipt and verifies it against the
   trusted issuer SPKI.
7. A second `BEGIN IMMEDIATE` transaction reparses the candidate, verifies its signature using the
   independently compiled trusted SPKI supplied at Worker startup, rechecks the complete immutable
   basis and absence of revocation, and compare-and-swaps `signing_pending -> reserved`.
8. After commit, the service rereads the aggregate, reconstructs it through the S0 reducer, reparses
   the exact stored bytes, recomputes every digest, verifies the signature against the compiled
   trust profile, and only then returns the stored receipt bytes.

If another signer committed a different valid ECDSA signature first, the losing candidate is
discarded. The losing request rereads and returns the winner's exact stored receipt. Nondeterministic
signatures are not an immutable-input conflict.

If the compare-and-swap result, commit result, Worker response, or reread is ambiguous, the service
returns no candidate bytes. Recovery starts with a fresh database read. It never assumes that the
candidate it signed was committed.

### Activation, recovery reads, and future status rechecks

S1 persistence implements but does not route exact record confirmation. Confirmation accepts one
already authenticated direct-certificate digest, one binding identity, and one record document
digest. In a `BEGIN IMMEDIATE` transaction it requires `reserved`, no revocation, the same
certificate and tuple, and the exact stored receipt before compare-and-swapping to `active`. Exact
active replay returns the retained digest; any different digest is a conflict.

Recovery receipt reads select the binding by the exact direct certificate digest. Only unrevoked
`reserved` or `active` aggregates may return the exact retained receipt after full canonical,
digest, issuer, signature, and reducer validation. `signing_pending`, `revoked`, absent, ambiguous,
or corrupt state returns no bytes.

For future active-status signing, S1 exposes two persistence operations rather than signing inside
SQLite:

1. read and freeze the exact active tuple, receipt digest, record digest, issuer, and binding
   revision; and
2. after external signing, run a second `BEGIN IMMEDIATE` exact recheck of all frozen fields and the
   absence of revocation.

The second transaction is the future active-status linearization point. S1 does not create,
persist, or return an active-status assertion.

### Revocation linearization

Revocation and receipt/activation transitions rely on the same SQLite owner and `BEGIN IMMEDIATE`
serialization. A process-local coordinator may coalesce exact retries, but it is not the durable
authority.

If revocation commits before receipt CAS, no receipt is stored or returned. If receipt CAS commits
first, the exact receipt remains immutable historical data and revocation may then terminalize the
binding. If revocation commits before activation, activation fails. If activation commits first,
revocation retains the record digest and terminalizes the active binding.

The future S2 active-status and recovery-download coordinator must serialize its frozen operation
with revocation and perform the final database recheck defined above. No S1 shortcut may return
bytes based only on an earlier read.

### Crash and retry matrix

S1 uses these fixed recovery rules:

- crash before the first transaction commits: no consumption or binding exists; the unused token
  may retry only before its original expiry;
- crash after pending commit: the token remains permanently consumed and an exact retry may
  continue after expiry;
- signer failure: `signing_pending` remains; only exact continuation or revocation is allowed;
- crash after signing but before receipt commit: a retry may produce another valid signature, and
  the first successful CAS wins;
- crash or lost response after receipt commit: exact retry returns the stored receipt bytes and
  never signs a replacement;
- ambiguous receipt commit: return no bytes, then reread on a new operation;
- crash before revocation commit: no revocation exists;
- crash or lost response after revocation commit: the same revocation ID and digest replay the
  stored terminal row; and
- backup restore or process restart: startup audits the issuer and every retained aggregate before
  the authority can be considered available.

Startup and recovery never delete a pending row, release a consumed token, recreate a receipt,
choose a new `bound_at`, repair a record digest, replace an issuer, or infer success from a partial
row.

### Startup integrity audit and lifecycle

Current production startup deliberately passes no signer or trusted issuer descriptor. After
`runMigrations()` succeeds, the Worker performs the schema and aggregate audit before it sends
`ready`: a fresh zero-row authority remains uninitialized, while any retained authority row without
the exact descriptor is fatal. Tests and reviewed internal composition may supply a signer context;
the storage runtime then passes only its verified public descriptor into `DatabaseWorkerOptions`
and the coordinator initializes or replays the issuer singleton after Worker readiness. Production
main loading of the independently compiled trust profile and child-process signer, plus any future
route publication, remains a separate reviewed activation slice.

The S1 subsystem has the closed lifecycle:

```text
new -> opening -> ready -> closing -> closed
opening -> failed
ready -> failed
closing -> failed
```

`failed` and `closed` are terminal. Open is single-use and cannot follow either terminal state.
Operations are accepted only in `ready`. `close()` from `new` moves directly to `closed`.
`close()` during `opening` fences admission, waits for startup to settle, and, if startup succeeds,
closes without publishing `ready`; if startup fails, the original failure wins. `close()` from
`ready` moves once through `closing`, rejects queued-but-not-started work, waits for the active
bounded operation and capability settlement, then releases signer references. Repeated close calls
return the same promise and do not repeat effects.

Calls admitted through a retained authority facade after `closing` begins, plus every `open()` after
`closing` or `closed`, return the stable `CLOSED` category. Temporary pre-ready or repeated-open
conditions return `NOT_READY`. A startup signer that has not yet been adopted by a coordinator is
owned by a separate atomic cleanup lease; startup rollback may close only that unadopted lease and
must never close a context already adopted by another owner. Coordinator construction verifies
signer adoptability before consuming the one-shot database capability and restores that capability
if the immediately following adoption unexpectedly fails.

Database Worker exit, owner-loss evidence, protocol corruption, or an outcome-unknown persistence
failure moves the subsystem to `failed`, rejects all pending and future work with the first terminal
cause, and forbids reopen. A close after failure performs only best-effort owned-resource cleanup,
returns or rejects with the original terminal cause, and leaves the logical state `failed`.

One lifecycle owner holds the DatabaseClient and owner lock. The coordinator receives only the
narrow S1 capability; it receives no second database-close or owner-lock-close authority. Lifecycle
shutdown cannot make an ambiguous operation successful.

The startup audit is bounded and paginated. It verifies:

- the allowed zero-row fresh state or exactly one issuer singleton;
- the exact `operator_auth_clock` schema and its single canonical high-water row;
- signer SPKI, compiled trust profile, singleton key ID, issuer, profiles, schema, and algorithm;
- every authorization's canonical fields and all-or-none consumption shape;
- one exact consumed authorization for every binding and no consumed authorization without its
  exact binding;
- every statement's canonical bytes, document digest, tuple, timestamp, request, and issuer;
- every stored receipt's canonical bytes, document digest, statement equality, low-S signature,
  and trusted issuer verification;
- every phase/nullability pairing through S0 reducer replay;
- every active record digest; and
- every revocation's exact request digest, prior phase, retained receipt/record shape, reason, and
  terminal state.

Any mismatch is terminal for startup. The audit does not rewrite or quarantine rows. There is no
degraded trust, alternate key, stale cache, unsigned continuation, or row-by-row best effort.
Unknown SQLite failures, Worker timeouts, and lost Worker responses are terminal or outcome-unknown;
they never expose raw constraint text or make a candidate receipt returnable.

### Errors and logging

S1 uses stable internal categories for invalid input, expired authorization, immutable conflict,
terminal revocation, signer unavailable, signer mismatch, persistence unavailable, storage
integrity failure, and closed lifecycle. S2 will separately map these categories to authenticated
HTTP responses.

Logs may contain a stable operation code, request ID, authorization ID, binding ID, revocation ID,
and closed error category. Logs must not contain a raw token, token digest, canonical statement,
receipt bytes, signature, certificate bytes, private-key material, OIDC subject, SQLite row dump,
request body, or arbitrary remote error text.

### Dormant security boundary

Migration 0012 and S1 rows do not change the current environment certificate map. The binding and
revocation tables are neither a positive Worker authentication source nor a negative revocation
veto. Empty-map startup behavior is unchanged.

No S1 type or row can grant Worker identity, Claim, lease, slot, readiness, package construction,
installation, service start, local-authority use, or execution. The listed `main.ts` and storage
runtime code may own startup and shutdown only. No route, listener, Worker-auth resolver, Worker,
Dashboard, native release, installer, or role bundle consumes an S1 authority result.

S1 does not persist `ChallengeState`, active-status assertions, `ActiveStatusEvidence`,
`RecordEvidence`, or `LiveEvidence`. It does not make `nodeenrollment.Read` available.

## Verification Requirements

The implementation slice must cover, on the exact candidate:

- clean migration to schema 12 and upgrade from schema 11;
- pre-migration backup creation, restore, checksum pinning, and incomplete-backup cleanup;
- every table, index, foreign key, CHECK, trigger, update, delete, and direct-SQL mutation guard;
- direct binding INSERT attempts for `reserved`, `active`, and `revoked`, all of which must fail;
- zero-row issuer bootstrap, exact replay, row-without-issuer failure, signer mismatch, trust
  mismatch, key-ID mismatch, and forbidden replacement;
- 32-byte token generation and hashing, no raw-token persistence, request digest golden vectors,
  request-ID conflicts, unused expiry, high-water rollback resistance, duplicate-clock rejection,
  exact consumed replay after expiry, and permanent tombstones;
- atomic authorization consumption plus pending creation under injected failures at every statement
  and commit boundary;
- duplicate Worker generation, duplicate certificate, wrong direct certificate, wrong token,
  changed operator authorization, changed tuple, changed issuer, and changed request;
- signer failure, double hashing, wrong key, wrong curve, DER signature, malformed P1363, invalid
  scalar, high-S handling, Promise-only provider enforcement, cancellation, deterministic close,
  unadopted startup cleanup, and trusted verification before commit;
- concurrent exact signers that produce different valid signatures, first-CAS-wins behavior, exact
  stored-byte replay, and conflicting requests;
- activation exact replay and changed record conflict;
- revocation from every nonterminal phase, atomic revocation trigger behavior, exact terminal replay,
  request-ID conflict, update/delete rejection, and receipt/activation races in both orders;
- startup pagination, aggregate reducer replay, canonical/digest/signature corruption, orphan rows,
  backup restore, close races, database Worker exit, and terminal lifecycle behavior;
- absence of token digests and document bytes from errors and logs;
- generic `DatabaseClient.request` rejection for every privileged S1 operation; and
- architecture guards proving the reviewed main and storage-runtime files only own startup and
  shutdown, while no route, Worker-auth path, Claim path, Worker, Dashboard, role bundle, Go
  production package, root contracts barrel, or other main-entry logic consumes an S1 authority
  result.

With explicit local authorization, validation runs on the current Windows workspace and includes
focused migration, database, coordinator, signer, and architecture tests, followed by repository
typecheck, test, build, and lint. Native Go validation is required only if the implementation slice
changes native code. Native Windows enrollment, CNG, certificate, ACL, power-loss, and attack
evidence remain later release gates.

## Compatibility

ADR 0022 remains the authority for the receipt, active-status document, signature domains, issuer,
lifecycle, S2 exchange, and Windows publication order. This decision resolves only its deferred S1
database encodings, request digests, transaction ordering, signer coordination, replay, startup,
and revocation persistence.

ADR 0014 remains the local record and fixed-path contract. S1 does not create or read the local
record. ADR 0013 remains the enrollment-before-package and zero-execution installation foundation.

The existing Worker API 1.0 and environment certificate map are byte-for-byte unchanged. There is
no dual-read, fallback, migration, or trust union between that map and the S1 tables.

## Consequences

- One authorization token can create at most one exact durable pending binding.
- Authorization expiry cannot destroy exact recovery after the token has been atomically consumed.
- Nondeterministic ECDSA output does not break idempotency because SQLite retains the first valid
  receipt bytes.
- Revocation is append-only, request-idempotent, and terminal across crashes.
- A restored or tampered database cannot silently substitute an issuer or malformed aggregate.
- The dormant migration can exist without enabling enrollment or changing Worker authentication.
- Once authority data exists, the Server must possess the exact configured signer and compiled
  trust profile to become ready.

## Deferred Decisions

- the production private-key store, HSM, key ACL, backup, and compromise procedure;
- the compiled signed production trust artifact and any future issuer rotation profile;
- the S2 OIDC enrollment-authority policy, authorization lifetime, rate limit, administration,
  candidate mTLS listener, issuance, confirmation, active-status, recovery, and revocation routes;
- operator audit retention beyond the exact authorization identity stored here;
- authorization tombstone archival under a future profile;
- the Windows enrollment journal, key and certificate creation, receipt-first and record-last
  publication, repair command, and crash recovery;
- the handle-bound reader, `RecordEvidence`, active-status verification, and `LiveEvidence`;
- destination verification, package construction, protected installer composition, and SCM
  evidence; and
- any Worker-auth migration, revocation veto, Claim or slot activation, RoleConfig v3 production
  activation, or canary rollout.

## Non-Goals

- making a database row, receipt, or active-status document a bearer credential;
- storing a raw authorization token or private key;
- signing inside SQLite or holding a transaction open across signing;
- repairing corruption by deleting, rewriting, resigning, or replacing durable facts;
- supporting a second enrollment generation or issuer rotation in profile v1;
- exposing S1 through a public package barrel or HTTP route; or
- enabling package, installer, service, Claim, lease, slot, or execution authority.

## References

- ADR 0002: Linux Fastify and `node:sqlite` Server
- ADR 0003: Remote Windows Worker leases
- ADR 0007: Windows Control/Executor isolation
- ADR 0013: Windows node enrollment and split installation
- ADR 0014: Trusted enrollment record v1
- ADR 0022: Dormant Server enrollment binding authority v1
