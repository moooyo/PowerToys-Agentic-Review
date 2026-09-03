# ADR 0021: Dormant Cross-Version Installer Store v2

> Withdrawn before publication by ADR 0026. Its source package was deleted and no production
> installer will read or migrate this store format.
>
> Historical note: ADR 0025 replaced the mTLS enrollment premise before ADR 0026 withdrew this
> entire unpublished cross-version store direction.

## Status

Withdrawn before publication by ADR 0026.

This decision freezes canonical documents, namespace ownership, migration preconditions,
publication ordering, and conservative crash recovery. The source-only
`internal/installstorev2lab` package implements the ordinary canonical codecs, fixed path and
sequence derivation, package-private residue and crash-transition models, opaque zero-value-invalid
capability shapes, and lifecycle stubs that always return `ErrUnavailable`. It does not open a file,
change an ACL, replace a head, migrate an installed node, mint a permit, mutate a product root or
service, or grant installer, Claim, or execution authority. The exact Windows APIs and their native
evidence remain release blockers.

## Context

ADR 0015 defines one protected installer namespace, one physical writer lock, one physical active
head, and replaceable schema-v1 transaction records. ADR 0020 defines an independent schema-v2 lab
record but deliberately supplies no paths or store. ADR 0020 always stops before the first SCM
ordinal and has no successful terminal state.

Creating `writer-v2.lock`, `active-head-v2.json`, or a per-transaction head would permit two
privileged binaries to select different authoritative transactions while mutating the same roots
and SCM records. Replacing the schema-v1 record in place would also lose the durable pending intent
needed to interpret a crash after an effect. The cross-version store therefore needs one permanent
physical ownership primitive, one permanent physical head path, and append-only schema-v2 entries.

The physical file names retain `v1` because already installed schema-v1 binaries know those paths.
After migration, their contents intentionally cease to be schema-v1 documents. An old binary must
reject the schema-v2 head and the expanded namespace before attempting any effect. Renaming the
ownership files would weaken that fail-closed property.

## Decision

### Dormant boundary

This ADR is the Slice B contract anticipated by ADR 0020. It does not remove
`durable-store-unavailable` from any ADR 0020 blocked checkpoint. Only source-level codecs, pure
models, opaque invalid-by-default types, and unavailable lifecycle stubs exist. No production
consumer, platform adapter, transition bridge, I/O implementation, or durable intent issuer exists
in this slice.

ADR 0020's `TransactionDocumentV2`, `TransactionRecordV2`, digest domain, 96 KiB maximum, closed
phase graph, and blocked semantics remain byte-for-byte unchanged. This ADR wraps that complete
canonical document in a separate append-only entry. It does not add a field to the record or widen
its parser.

A future production-capable transaction record requires a new record schema and profile plus a
new version of the entry and head documents and a separately reviewed sealed migration bridge. The
strict `EntryDocumentV2` in this ADR accepts only ADR 0020 `TransactionDocumentV2`; it cannot embed a
future record version. A later bridge may reuse the permanent physical lock and head path but may
not reinterpret this entry schema, remove an ADR 0020 blocker, or manufacture a successful terminal
state.

### Permanent physical namespace

The fixed root remains:

```text
C:\ProgramData\AgenticReview\Installer\Transactions
```

The only physical writer lock is permanently:

```text
C:\ProgramData\AgenticReview\Installer\Transactions\writer-v1.lock
```

The only physical active head and its only temporary sibling are permanently:

```text
C:\ProgramData\AgenticReview\Installer\Transactions\active-head-v1.json
C:\ProgramData\AgenticReview\Installer\Transactions\active-head-v1.json.tmp
```

There is no `writer-v2.lock`, `active-head-v2.json`, second global head, per-transaction head,
compatibility alias, registry selector, junction selector, or caller-supplied root.

`writer-v1.lock` has one narrow bootstrap exception. The exact completed and verified
`Installer\Enrollment` layout is allowed and required to pre-exist; enrollment rotation is not
supported. The enrollment writer must have completed, closed all mutation authority, and supplied
fresh opaque enrollment evidence. `Transactions` itself, every transaction/head object, product
runtime root, and Worker service must still be absent, and no unknown Installer sibling is allowed.

A process holding the retained Installer-parent handle and the future exclusive enrollment
completion capability must prove `Transactions` is absent, create `Transactions` with exclusive
create-new semantics and its final descriptor, retain that newly created directory handle, and
immediately create and retain the empty lock with exclusive create-new semantics and its final
descriptor. A concurrent loser or any process that opens a pre-existing `Transactions` directory
cannot create a missing lock. A crash between
directory creation and lock creation leaves an operator-repair state; normal recovery never fills
that gap. After bootstrap, a missing, renamed, replaced, nonempty, linked, or identity-changed lock
is an out-of-band failure and is never recreated. The lock is a permanent cross-version
compatibility anchor, not replaceable journal content.

The global ordering is enrollment-writer ownership, then Installer-parent bootstrap ownership, then
the Transactions writer lock; release occurs in reverse. No code may acquire enrollment mutation
authority while holding the Transactions lock. After bootstrap, normal transaction operations hold
only the Transactions lock and consume fresh opaque enrollment evidence. ADR 0014 does not yet
define the enrollment writer's exclusive capability or this shared-parent handoff, so first
bootstrap and production composition remain blocked.

The future bootstrap publication sequence is exact:

1. Retain and verify the shared Installer parent and completed Enrollment sibling, then prove
   `Transactions` is absent by bounded enumeration.
2. Create `Transactions` exclusively with its final descriptor, flush the retained Installer parent,
   reopen `Transactions`, and verify its identity, volume, ACL, case mode, alternate-name absence,
   and empty contents.
3. Create `writer-v1.lock` exclusively with its final file descriptor and zero bytes, flush the lock
   file, flush `Transactions`, reopen the lock, and verify its identity, zero length, single link,
   unnamed stream, alternate-name absence, and ACL.
4. Flush the Installer parent again, reopen and re-enumerate both directory levels, prove Enrollment
   is unchanged and the only new subtree is exact empty `Transactions` plus the retained lock, and
   reverify the lock handle still owns the same file without sharing.

No store capability is returned before step 4 completes. A crash before `Transactions` creation is
pristine and may retry. An existing empty `Transactions` directory without the lock is an
operator-repair state and normal bootstrap never fills it. Exact `Transactions` containing only an
exact empty lock may be acquired, reflushed at both directory levels, reopened, and accepted only
after the entire sequence above is re-proved; any other bootstrap residue fails closed. No head,
transaction, journal, product-root, or SCM effect may begin during bootstrap.

Before migration, `active-head-v1.json` contains the strict schema-v1 `HeadDocument` from ADR 0015.
After migration, the same physical file contains only the strict schema-v2 `HeadDocumentV2` in this
ADR. The content version never moves back to 1. An old schema-v1 parser therefore fails closed on a
migrated node.

A reader obtains one bounded byte string through the verified final-head handle. The expected head
schema comes only from a future sealed, external, monotonic release migration inventory; it is not
chosen by the head bytes, a caller flag, parser success, or namespace contents. Expected-v1 accepts
only the strict v1 head and permits no head-reachable or published v2 transaction. `Recover` may
additionally admit only the one exact bounded migration staging or genesis-orphan residue defined
below; every other v2 object is a downgrade or ambiguity. Expected-v2 accepts only the strict v2
parser; even a valid v1 head is a downgrade and fails closed. Residue never selects or changes the
externally sealed expected schema. The other parser may be used for diagnostic classification only
and never for authority. No reader performs a loose JSON version preparse or falls back after the
expected parser fails.

This ADR does not define the durable publication and crash protocol for that external monotonic
inventory. Until a later decision closes it, migration and every production store composition
remain blocked.

Each schema-v2 transaction uses exactly:

```text
C:\ProgramData\AgenticReview\Installer\Transactions\<transactionId>\wal-v2
C:\ProgramData\AgenticReview\Installer\Transactions\<transactionId>\wal-v2\<sequence20>.json
C:\ProgramData\AgenticReview\Installer\Transactions\<transactionId>\wal-v2\<sequence20>.json.tmp
```

The only additional root-name pattern is the non-authoritative migration staging directory derived
from the cryptographically generated transaction ID:

```text
C:\ProgramData\AgenticReview\Installer\Transactions\migration-v2-<transactionId>.tmp
C:\ProgramData\AgenticReview\Installer\Transactions\migration-v2-<transactionId>.tmp\wal-v2
C:\ProgramData\AgenticReview\Installer\Transactions\migration-v2-<transactionId>.tmp\wal-v2\00000000000000000001.json
C:\ProgramData\AgenticReview\Installer\Transactions\migration-v2-<transactionId>.tmp\wal-v2\00000000000000000001.json.tmp
```

The prefix and suffix are literal and the embedded ID must be one canonical UUID equal to the
nested sequence-1 record. At most one such directory exists. It exists only while preparing
migration genesis or as its exact crash residue. It is never named by a head, never contains a v1
record, and is never interpreted as a transaction. No empty canonical UUID directory is an
automatically cleanable migration prefix.

`sequence20` is the record's positive canonical decimal `recordSequence`, left-padded with ASCII
zeroes to exactly 20 digits. Examples are `00000000000000000001.json` and
`00000000000000000001.json.tmp`. During publication the name is derived only from the record
sequence already validated and captured by the sealed `PreparedSuccessor`. During recovery it is
derived only from the authoritative head and current tail, or fixed sequence 1 for migration. A
partial temporary body is never parsed to select its own name or sequence. The name is never a
caller input. Sequence zero, more or fewer than 20 digits, a sign, whitespace, a non-decimal byte,
or a value above unsigned 64-bit maximum is invalid. The unpadded record value remains the exact
ADR 0020 `DecimalUint64` and has no leading zero.

Because this entry version admits only one v2 transaction with at most 4,096 entries, the v2 head,
entry binding, and path derivation additionally reject a v2 record sequence above 4,096. The legacy
`recordSequence` values retained in `PredecessorV2` and `V1InventoryEntryV2` remain canonical positive
unsigned 64-bit decimals and do not inherit the v2-entry count ceiling.

Schema-v1 transaction directories remain immutable inventory after migration. A reconciled v1
directory contains its one canonical `record-v1.json` and no temporary sibling. A schema-v2
transaction directory contains only `wal-v2`, and that directory contains only the admitted entry
and temporary names. A directory cannot contain both v1 and v2 transaction layouts.

The closed namespace admits at most 4,096 retained schema-v1 transaction directories plus the one
current canonical schema-v2 transaction directory, for at most 4,097 canonical transaction
directories total. One matching staging directory is additionally allowed only as transient crash
residue. The sole v2 transaction admits at most 4,096 final entries, and the complete namespace
therefore admits at most 4,096 final v2 entries. Outside a clean namespace, exactly one of these mutually
exclusive crash-residue shapes is admissible for semantic classification by `Recover`:

| Shape | Entry side | Head side |
| --- | --- | --- |
| A | one staging shape `(a)` through `(d)` | no head temporary and no canonical candidate |
| B | one current-tail `N+1` entry temporary | no head temporary |
| C | one exact final direct successor or canonical migration genesis | optionally one fixed head temporary from the same publication |
| D | sealed expected-v2 only: one strict authoritative v2 head and selected tail, with no entry-side residue | no head temporary; recovery only reflashes, reopens, reverifies, and describes the authoritative tail |
| E | one strict authoritative v1 or v2 head and selected record or tail, with no entry-side residue | exactly one fixed head temporary; recovery cleans it and then reclassifies from the authoritative final head |
| V | expected-v1 only: one physically trusted bounded `record-v1.json.tmp` in the head-selected v1 transaction, with no v2 or staging residue | no head temporary |

Two entry-side residues, two head temporaries, staging plus a canonical candidate, a head temporary
with an unrelated candidate, a v1 record temporary in a non-selected transaction, a physically
untrusted or oversized v1 record temporary, or any other combination is ambiguous. Shape V requires
the final v1 head and selected record to be strict, authoritative, and unchanged; the temporary body
may be empty, partial, or noncanonical and never participates in authority. Crossing any directory,
entry, or residue bound fails closed. No automatic retention, compaction, archival, or garbage
collection is defined.

Recovery reads at most 806,354,944 aggregate admitted filesystem-document bytes (769 MiB), including
all 4,096 allowed legacy records, one allowed v1 record temporary, all 4,096 allowed v2 entries, and
every admitted bounded v2 temporary or head. The derived canonical inventory array has its own 1 MiB
encoding ceiling and counts against the live working-set limit, not the filesystem-read total. It
retains at most 64 native
handles simultaneously, and has a compiled hard deadline of 10 minutes covering enumeration,
reopen, hashing, parsing, and verification. It performs a single streaming pass, retains at most
three 128 KiB document buffers simultaneously, and has a 16 MiB total live working-set ceiling for
document buffers, parsed values, digests, and inventory metadata. Per-file size is checked before
allocation or content read. A deadline, memory, handle, byte, entry, or directory bound is a
fail-closed limit, not permission to skip an object or accept a prefix. Native evidence must prove
that the maximum valid namespace completes within these bounds on supported x64 and arm64 systems;
otherwise the production store remains unavailable.

### Canonical encoding rules

All documents below are canonical UTF-8 JSON with no BOM, insignificant whitespace, duplicate or
unknown members, trailing bytes, alternate member order, noncanonical escape, uppercase digest,
null required member, or out-of-range value. Parsing re-encodes the typed value and requires exact
byte equality. SHA-256 values are exactly 64 lowercase hexadecimal characters.

The size ceilings include the complete encoded document:

```text
HeadDocumentV2          1 KiB
PredecessorDocumentV2   2 KiB
V1InventoryEntryV2[]    1 MiB
EntryDocumentV2       128 KiB
TransactionDocumentV2  96 KiB  (unchanged from ADR 0020)
```

The domains below are ASCII followed by exactly one NUL byte. The digest input is the exact
canonical payload object named by the field, not the outer document, a parsed map, or a normalized
filesystem representation.

### Head document

The head payload and document have exactly these fields and order:

```text
HeadV2 = {
  "entrySha256": LowercaseSHA256,
  "recordSequence": DecimalUint64,
  "transactionId": TransactionId
}

HeadDocumentV2 = {
  "head": HeadV2,
  "headSha256": LowercaseSHA256,
  "schemaVersion": 2
}
```

`headSha256` is SHA-256 over:

```text
"AgenticReview split installer active head v2" || NUL || canonical(HeadV2)
```

The three head selectors derive exactly one entry path. The selected entry must exist, be canonical,
have the same transaction ID and record sequence, and have the exact `entrySha256`. A head never
selects a directory, timestamp, lexical maximum, candidate set, or unverified record.

### V1 predecessor document

Only a schema-v1 terminal record may be the predecessor of the first schema-v2 transaction in this
ADR. The payload and document have exactly these fields and order:

```text
PredecessorV2 = {
  "headDocumentSha256": LowercaseSHA256,
  "inventorySha256": LowercaseSHA256,
  "recordDocumentSha256": LowercaseSHA256,
  "recordSequence": DecimalUint64,
  "sourceSchemaVersion": 1,
  "transactionId": TransactionId
}

PredecessorDocumentV2 = {
  "predecessor": PredecessorV2,
  "predecessorSha256": LowercaseSHA256,
  "schemaVersion": 2
}
```

`headDocumentSha256` and `recordDocumentSha256` are the raw SHA-256 digests of the complete exact
canonical schema-v1 documents read through verified handles.

`inventorySha256` binds every schema-v1 transaction directory, not only the active predecessor. The
canonical inventory is a JSON array sorted by the raw lowercase ASCII `transactionId`; it contains
exactly one entry for every v1 directory:

```text
V1InventoryEntryV2 = {
  "recordDocumentSha256": LowercaseSHA256,
  "recordSequence": DecimalUint64,
  "terminalDisposition": "committed-applied" | "rolled-back-applied",
  "transactionId": TransactionId
}
```

No directory is omitted or duplicated. The active predecessor appears exactly once and matches the
separate predecessor fields. `inventorySha256` is SHA-256 over:

```text
"AgenticReview split installer v1 migration inventory v2" || NUL || canonical(V1InventoryEntryV2[])
```

`predecessorSha256` is SHA-256 over:

```text
"AgenticReview split installer transaction predecessor v2" || NUL || canonical(PredecessorV2)
```

The predecessor is ordinary audit binding, not evidence and not authority. It is valid only when
the still-authoritative v1 head selects that exact transaction, the v1 record sequence matches, the
record is terminal under v1, the complete legacy inventory recomputes to the exact digest, and all
migration prerequisites below are freshly proved. After migration, recovery continues to verify
that every retained v1 directory and record matches this inventory digest.

### Append-only entry document

The entry payload and document have exactly these fields and order:

```text
EntryV2 = {
  "predecessorDocument": null | PredecessorDocumentV2,
  "previousEntrySha256": null | LowercaseSHA256,
  "recordDocument": TransactionDocumentV2
}

EntryDocumentV2 = {
  "entry": EntryV2,
  "entrySha256": LowercaseSHA256,
  "schemaVersion": 2
}
```

`TransactionDocumentV2` is the complete canonical ADR 0020 document, including its existing
`recordSha256` and `schemaVersion=2`. It is nested without conversion. `entrySha256` is SHA-256 over:

```text
"AgenticReview split installer transaction WAL entry v2" || NUL || canonical(EntryV2)
```

For entry sequence 1, `previousEntrySha256` is null. A migration from schema v1 requires the exact
non-null `predecessorDocument`. A future pristine-install bootstrap may use a null predecessor only
after a separate sealed bridge proves that no v1 or v2 head, transaction, product root, or service
exists; that bridge is not provided here.

For every entry after sequence 1, `predecessorDocument` is null and `previousEntrySha256` exactly
equals the immediately preceding entry's `entrySha256`. The nested record's transaction ID and
record sequence must equal the directory and filename. Successive entries use the same transaction
ID and sequence exactly `N+1`, without wraparound. The complete chain back to entry 1 must be
canonical, contiguous, and digest-linked.

ADR 0020 has no successful terminal tail, so `EntryDocumentV2` defines no v2-tail predecessor and
cannot start a second v2 transaction. A later production record and entry version must define an
exact predecessor variant that binds a successful terminal head and tail from that later production
schema, its complete chain, and the legacy inventory before it can create a new transaction. No
ADR 0020 tail, including `FAILED_CLOSED`, is eligible as a successor predecessor. This unresolved
link is a production blocker, not a reason to treat the current blocked tail as terminal.

A future production migration may move directly from the verified v1 predecessor to that later
record, entry, and head version. It must not publish dormant `EntryDocumentV2` as an intermediate
stepping stone or claim that this ADR's blocked chain was activated.

A head-reachable published entry is create-once. It is never replaced, truncated, patched, copied
over, deleted, or reused for a different document. Earlier reachable entries remain immutable. A
final-named publication candidate that was never selected by the head is not a published entry and
may be removed only by its applicable exact orphan protocol: an existing-transaction direct
successor uses the leaf-file rule, while migration genesis uses only whole-directory rename-back
and staging cleanup. A head update changes only which already durable entry is the tail.

### V1 inventory and migration prerequisites

Migration is a one-way change of the document stored at `active-head-v1.json`. It is unavailable
unless every prerequisite below is satisfied while the retained `writer-v1.lock` handle remains
exclusively held:

1. A signed gate-off rollback binary that understands the complete v1 and v2 namespace is already
   installed, independently verified, and selected by the release rollback inventory. It rejects
   execution, SCM mutation, root mutation, and legacy v1 writer behavior after observing any v2
   object. An old v1-only binary is not an admissible rollback binary.
2. A later decision has frozen and native evidence has proved the external monotonic release
   migration inventory, its sealed expected-head-schema capability, and the crash-safe ordering
   between that inventory and the head transition. This prerequisite is not satisfied by this ADR.
3. No other installer, recovery helper, service, updater, library callback, or rollback process can
   open a second writer. Acquisition failure, handle loss, or uncertain ownership fails closed.
4. The complete namespace passes exact bounded enumeration, identity, volume, stream, link, reparse,
   case, and ACL verification. There is no `.tmp`, orphan, unknown object, mixed v1/v2 directory,
   alternate head, or partial migration residue.
5. The schema-v1 head and selected record are strict canonical documents. The selected record is
   exactly one v1 `COMMITTED/applied` or `ROLLED_BACK/applied` terminal record. `FAILED_CLOSED`, a
   nonterminal record, pending action, ambiguous head, or missing record is not migratable.
6. Every non-selected v1 transaction directory contains one strict canonical successful v1 terminal
   record, exactly `COMMITTED/applied` or `ROLLED_BACK/applied`,
   satisfies its exact transaction and generation bindings, and appears exactly once in the sorted
   inventory digest. Any duplicate, omission, nonterminal record, or binding conflict blocks
   migration. No `FAILED_CLOSED` record is permitted anywhere in the migration inventory, and no
   unrecorded historical-lineage claim is inferred.
7. Fresh handle-bound verification proves the installed roots, release identity, enrollment,
   complete SCM records, process absence or disabled readiness as applicable, and all facts required
   by the future sealed bridge. Journal phases and predecessor digests are not evidence.
8. The new transaction ID comes from the Windows cryptographic random source and is absent from the
   verified namespace. The exact ADR 0020 sequence-1 record, predecessor document, entry document,
   paths, and head bytes are prepared before the first publication.
9. Native Windows x64 and arm64 evidence proves the exact file creation, atomic rename or replace,
   file flush, directory flush, reopen, identity, ACL, crash-cut, power-loss, and rollback behavior
   used by the implementation. This ADR does not presume that evidence exists.

Migration publishes the new sequence-1 entry first and the schema-v2 head second. The old v1 head
remains authoritative until the head replacement is durably complete and reverified. The v1 record
and head document digests remain bound by the predecessor, and the retained v1 record file is never
rewritten into v2.

After migration, recovery reconstructs the exact canonical v1 `HeadDocument` from the predecessor
transaction ID, verifies its raw digest equals `headDocumentSha256`, and recomputes every retained
v1 inventory entry and `inventorySha256`. The overwritten v1 head bytes are never guessed from a
timestamp or cached buffer.

If migration is not started from the exact clean inventory above, no v2 object may be created.
There is no automatic conversion of a v1 pending, failed, corrupt, or nonterminal record and no
repair-by-migration path.

### Store capability surface

The future implementation may expose only semantics equivalent to:

```text
OpenExclusive
Recover
PublishSuccessor
Close
```

`OpenExclusive` accepts no path, root, policy, callback, or namespace selector. It opens the fixed
physical `writer-v1.lock`, retains it without read, write, or delete sharing, verifies the complete
fixed root and the lock's stable identity, zero length, unnamed stream, and exact descriptor, and
performs bounded handle-based security and identity enumeration. The lock is never written,
truncated, renamed, or replaced. A trusted fixed-name temporary, one physically admitted bounded
staging shape `(a)` through `(d)`, one bounded fixed-name current-tail `N+1` final candidate in the
selected existing transaction, one physically admitted bounded canonical-name genesis-orphan
candidate, or Shape V's physical v1 record temporary does not make `OpenExclusive` fail before
recovery can classify it. Open checks only physical name, parent, type, identity, ACL, link, stream,
and size at this boundary; `Recover` decides whether each candidate satisfies its applicable exact
orphan or ADR 0015 protocol. An object whose path, type, identity, ACL,
link, stream, volume, case, or bound is untrusted fails immediately. Otherwise Open returns one
non-copyable store generation that records every enumerated object for `Recover`.

`Recover` consumes the current in-process recovery generation and returns an immutable ordinary
view of the one authoritative v1 inventory or v2 tail. It performs no product-root or SCM effect,
does not return a native handle, and does not mint a durable intent permit. Re-running `Recover` is
idempotent only when the physical namespace and retained identities are unchanged.

`PublishSuccessor` accepts only an unconstructable `PreparedSuccessor` created by a sealed,
package-private transition bridge. The value binds all of the following:

- the open store generation and retained writer identity;
- the exact current head bytes, digest, identity, and selected tail;
- the transaction ID and next record sequence;
- the canonical record document bytes and record digest;
- the predecessor or previous-entry digest;
- the complete canonical entry and next-head bytes and digests; and
- when a pending action exists, its exact canonical bytes and action digest.

The canonical pending action is limited to 16 KiB. Its digest is SHA-256 over:

```text
"AgenticReview split installer pending action v2" || NUL || canonical(PendingActionV2)
```

The prepared value also binds the exact record schema version, SCM policy contract identifier,
blocked-checkpoint shape, head file identity, selected-entry file identity, and both parent-directory
identities. Different bridges cannot assign different action digest meanings.

`PreparedSuccessor` has no public fields, constructor, parser, decoder, serializer, clone, zero-value
meaning, or interface implementable outside the defining package. It becomes stale after any
`Recover`, successful publication, failed publication with uncertain state, ownership change, or
`Close`. A caller cannot prepare one record and substitute another at publication time.

`Close` consumes the store capability, invalidates every prepared value and permit, and closes all
retained handles. A flush, close, cancellation, or ownership result that cannot be resolved is
process-fatal and reported out of band. Close never converts corruption into a journal record and
never performs recursive cleanup.

The store has no `Write(path, bytes)`, `Rename`, `Delete`, `SelectLatest`, `Execute`, generic
operation, caller-supplied timestamp, or arbitrary policy surface.

Before creating a staging directory, temporary entry, or temporary head, preparation checks that an
existing v2 successor's `recordSequence+1` does not wrap, or that migration genesis is exactly
sequence 1. It also proves the per-transaction and global entry counts remain within their ceilings
and the aggregate byte and handle budgets admit the entire publication. Attempting to exceed either
ceiling is rejected before any object is created. Exactly 4,096 entries in one
transaction and globally is admissible; the next preparation is not. The writer never
emits a namespace that its next `Recover` must reject as overflow.

Migration preparation counts every canonical v1 transaction directory and permits all 4,096 legal
legacy directories. Before staging begins it proves there is no canonical v2 transaction. The
staging-to-UUID rename may therefore produce the one current v2 directory and at most 4,097
canonical directories total. Counts are rechecked immediately before directory rename and again
before head publication. This migration never requires retention or GC. Supporting a second v2
transaction requires a later record, entry, and head version to define its own capacity and
retention contract.

### Two-stage publication

Publication always writes the entry before the head. Both stages occur under the retained exclusive
writer lock. No effect, callback, IPC request, service operation, or permit consumption may occur
between them.

For an existing v2 transaction, the entry stage is exactly:

1. Reverify the retained transaction and `wal-v2` directory identities, fixed paths, same NTFS
   volume, exact ACLs, closed namespace, current head, and current tail.
2. Exclusively create the fixed `<sequence20>.json.tmp` with its final security descriptor. An
   existing object is handled only by `Recover` and cannot be overwritten.
3. Write the complete bounded `EntryDocumentV2`, reread it through the same handle, verify canonical
   bytes and all nested digests and bindings, and flush the entry file.
4. Atomically rename the temporary entry to the absent `<sequence20>.json` in the same retained
   `wal-v2` directory, with no replacement, backup, copy, or delete-then-rename fallback.
5. Flush the retained `wal-v2` directory, reopen the final entry, and reverify its file identity,
   single-link state, default stream, exact ACL, canonical bytes, digests, and bindings.

Migration genesis never creates an empty canonical UUID directory. Under the same exclusive lock it
first proves both the final UUID name and `migration-v2-<transactionId>.tmp` are absent, creates the
staging directory with its final descriptor, flushes `Transactions`, reopens and verifies staging,
creates `wal-v2` with its final descriptor, flushes staging, and reopens and verifies `wal-v2`.
It then publishes and verifies the sequence-1 entry inside staging using steps 2 through 5 above.
Only after that entry is durable does it atomically rename the complete staging directory to the
absent canonical UUID name, flush `Transactions`, reopen the canonical directory and entry, and
reverify their names, identities, ACLs, bytes, and bindings. Directory rename is another native
atomicity and power-loss evidence gate; no copy or create-canonical-then-move-children fallback is
allowed.

A crash before the staging-directory rename may leave exactly one of these non-authoritative
prefixes: `(a)` an empty staging directory; `(b)` staging with one empty `wal-v2`; `(c)` staging
with `wal-v2` and one bounded entry temporary of arbitrary partial content; or `(d)` staging with
one exact final sequence-1 entry. With a still-valid old v1 head and no other residue, recovery may
remove only the verified files and directories in that fixed non-v1 staging namespace,
leaf-to-parent, flushing and reopening each parent after deletion. It never adopts staging. An
empty canonical UUID directory is indistinguishable from damaged legacy evidence and always fails
closed. After the staging directory has been renamed to the canonical UUID, it is a final orphan
candidate and must contain the one exact canonical sequence-1 entry required by the stricter orphan
rule below.

Only after all five entry steps succeed, and migration genesis has additionally completed and
reverified the staging-directory rename, may the head stage begin:

1. Reverify that the old head and selected tail are still exact and that the new entry is the sole
   exact child of that tail, or the sole exact migration genesis allowed by the predecessor.
2. Exclusively create `active-head-v1.json.tmp` with its final security descriptor.
3. Write the complete bounded `HeadDocumentV2`, reread it through the same handle, verify canonical
   bytes and digest, and flush the head file.
4. Atomically replace `active-head-v1.json` in the retained `Transactions` directory without a
   backup, copy, in-place truncate, delete-then-rename sequence, or alternate head.
5. Flush the retained `Transactions` directory, reopen the final head and selected entry, and
   reverify both identities, exact ACLs, canonical bytes, digests, and mutual bindings.

File flush plus its containing-directory flush is required at both levels. API success,
`FILE_FLAG_WRITE_THROUGH`, write-through rename flags, cache behavior, object existence, or reopen
alone is not a substitute. The exact Windows rename/replace and directory-flush APIs remain
unselected until real supported x64 and arm64 evidence proves their atomicity and power-loss
semantics.

### Durable intent permit

A successful two-stage publication may mint one opaque, process-local `DurableIntentPermit` only
when the newly selected record contains the exact pending action approved by the sealed transition
bridge. The permit binds:

```text
open store generation
writer-lock identity
head file identity
selected-entry file identity
head-parent and entry-parent directory identities
transaction ID
record sequence
record and entry schema versions
SCM policy contract identifier and blocked checkpoint
head digest
entry digest
record digest
action digest
action plan, kind, and ordinal
```

The permit has no public fields, constructor, zero-value meaning, parser, serializer, clone, log
projection, receipt representation, or cross-process encoding. It is one-shot but is only journal
durability admission; by itself it is not effect authority. Consumption performs an atomic in-memory
state change before the future effect begins; a second or concurrent use fails.
Any `Recover`, later publication, ownership loss, uncertain error, shutdown, or `Close` invalidates
it. A permit never reaches Executor, a Worker receipt, a log, package data, or remote input.

Before consumption, the future action-specific sealed adapter must acquire the reviewed native
exclusion for that exact target. A filesystem action retains the exact target and parent handles.
An SCM action requires an action-specific service exclusion generation and retained service handles.
Under that still-live exclusion, the adapter performs the complete fresh exact-before readback and
mints an unconstructable `ExactBeforeToken` bound to the store generation, head, entry, record,
action, observation digest and generation, exclusion generation, and every retained target
identity. The token binds the durable journal intent identity directly and does not depend on a
permit. It is process-local, one-shot, and has no generic constructor or serialization.

The only consumption path is a store-owned, package-private `ValidateAndConsume` operation accepting
both the permit and exact-before token inside the future sealed composition. While the original
writer lock and native exclusion remain held, it immediately
reverifies the live lock identity, reopens the final head and selected entry from their retained
parents, compares their file identities, ACLs, exact bytes, digests, schema versions, sequence,
record, and pending action with the permit, and proves no namespace drift. It also revalidates the
token bindings, retained target identities, exclusion liveness, and exact-before state at the final
effect boundary. It then uses one atomic compare-and-swap to consume both values, and the adapter
immediately performs the fixed effect under the same exclusion and handles without an intervening
callback, asynchronous yield, or authority handoff. Any failed physical comparison, target drift,
lost exclusion, or concurrent consume returns no admission and fails closed. A digest-only,
memory-only, or generic callback consume path is forbidden.

The store does not interpret an action as effect authority. The future action-specific adapter must
consume both sealed values and independently derive every native argument from reviewed compiled
constants.
ADR 0020 cannot receive an SCM permit because its validator rejects every SCM pending action and its
durable-store blocker is permanent.

If Windows provides no reviewed exclusion primitive that prevents root or SCM drift between the
last exact-before readback and the native effect, that action remains a production blocker. The
Transactions writer lock serializes journal writers only; it does not lock external roots or SCM.

A new process never receives a permit merely because the recovered record contains a pending
action. `Recover` returns only non-authorizing state and an ordinary pending descriptor. A future
production schema and native evidence bridge must obtain a fresh complete observation and produce
an unconstructable exact-before token. Recovery then uses a separate store-owned,
package-private `ValidateAndConsumeRecovered` boundary: while the writer lock and native exclusion
remain held, it revalidates the recovered pending intent and token, internally mints the one-shot
journal admission, and immediately consumes that admission and token before the fixed effect. No
unconsumed recovery permit is returned or allowed to cross the boundary. An exact target
observation leads to a prepared completion record, not an effect permit. Any other
observation fails closed. Parsing, chain verification, or historical readiness never revives
authority.

### Crash residue and recovery

Recovery begins only after `OpenExclusive` has retained and verified the permanent writer lock and
completed bounded security and identity inventory of every namespace object. `Recover`, not Open,
performs semantic classification. A valid authoritative head under the sealed external expected
schema is required before recovery deletes, adopts, or interprets any temporary name or entry
prefix. If the head is missing, malformed, noncanonical,
digest-mismatched, unknown-version, ambiguously cased, multiply named, or has an untrusted identity
or ACL, recovery performs no cleanup and fails closed out of band.

Temporary files and final entries have intentionally different recovery rules.

The partial-temporary cleanup below applies only to a v2 entry temporary, the fixed active-head
temporary, and Shape V's one selected v1 record temporary under the migration-aware gate-off store.

An entry temporary name is derived without reading its content. Under an authoritative v2 head it
must be in the selected transaction's `wal-v2` directory and name exactly current sequence `N+1`.
Under an authoritative pre-migration v1 head it may only be sequence 1 inside the sole
`migration-v2-<transactionId>.tmp\wal-v2` staging directory. An entry temporary at any other
transaction, sequence, or parent is not cleanable residue. The head temporary has its own one fixed
path; it is cleanable only when the final head is valid under the externally sealed expected schema.
Its partial content is never used to infer the expected version or target head.

Shape V's record temporary name is also derived without parsing its body. It must be the one fixed
`record-v1.json.tmp` sibling of the strict final `record-v1.json` selected by the authoritative v1
head. The final head and record must remain byte-for-byte unchanged, and no head temporary, v2
object, staging object, or other residue may coexist.

A fixed `.tmp` file may contain zero bytes, a partial write, invalid UTF-8, noncanonical JSON, an
invalid digest, or any other bounded prefix after a normal crash. Its content is not required to be
a valid document before deletion. Recovery may delete it only when all of these facts are exact:

- the authoritative final is either `(a)` a strict unchanged v2 head selecting the unchanged old or
  fully published new v2 tail, or `(b)` a strict unchanged v1 head under sealed expected-v1
  selecting its strict unchanged v1 record;
- the temporary object has the exact head-derived or migration-derived name above in the one
  retained parent directory;
- it is a regular non-reparse file created under the store ACL, with exact owner, group, protected
  DACL, stable file identity, one hard link, default stream only, and size within the applicable
  document ceiling; and
- no second temporary, alternate case, stream, alias, fork, unknown object, or namespace drift
  exists.

For expected-v1, the residue table remains authoritative: a record temporary is only Shape V, a
head temporary alone is only Shape E, and a staging or canonical-genesis companion must be the sole
Shape A or C residue. A canonical genesis must carry the exact predecessor binding and successful
v1 terminal facts required by the migration rule. These cases never permit a v1 record temporary
and head temporary to coexist.

After handle-relative deletion, recovery flushes the retained parent directory and re-enumerates it.
It never parses a partial temporary prefix to select a transaction or sequence. An untrusted
temporary object is not deleted and causes out-of-band failure.

An unreferenced final WAL entry is more dangerous because a future implementation might otherwise
mistake it for a published intent. Under a valid v2 head that still selects the old tail, recovery
may roll back exactly one existing-transaction orphan final entry only if it is a complete canonical
direct successor:

- its transaction ID is the current transaction;
- its sequence is exactly the current sequence plus one;
- its `previousEntrySha256` exactly names the current tail;
- its predecessor, record, entry digest, file name, identity, ACL, link, stream, and size are exact;
- no sibling entry claims the same or a later sequence, no second child forms a fork, and no other
  residue exists except the matching fixed head temporary file; and
- the still-authoritative head and old tail remain byte-for-byte unchanged through the check.

The orphan is deleted handle-relatively and the `wal-v2` directory is flushed and re-enumerated.
The orphan is never adopted, even if its record is valid, because head publication did not complete
and no effect permit could have been minted. A matching head temporary is cleaned under the
temporary-file rule. If any direct-successor fact is not exact, recovery preserves all bytes and
fails closed out of band.

Migration genesis is not covered by that leaf-file deletion rule. A canonical migration orphan is
handled only by the whole-directory rename-back protocol below.

For migration, a sealed expected-v1 state, valid schema-v1 head, and one new transaction containing
one canonical sequence-1 entry is the only admissible final orphan. Its predecessor must bind the
exact authoritative v1 head and terminal record. If the matching head temporary exists, recovery
first removes that temporary under its separate rule, flushes and reopens `Transactions`, and proves
the canonical orphan is unchanged.

Recovery never leaf-deletes inside the canonical UUID orphan. It atomically renames the complete
canonical directory back to the absent `migration-v2-<transactionId>.tmp` name, flushes
`Transactions`, reopens the result, and verifies the exact staging case `(d)`. A crash before this
rename leaves the same verifiable canonical orphan; a crash after it leaves staging case `(d)`.
If enumeration shows both names, neither name, or an uncertain rename result, recovery preserves
everything and fails closed. Once in staging, cleanup follows the staging leaf-to-parent rule, so no
cleanup cut can create an empty canonical UUID directory. It does not adopt the entry or replace the
v1 head. Migration may be retried later only from a newly reverified clean v1 inventory.

When sealed expected state is v2 and the final physical head contains a valid `HeadDocumentV2`,
recovery does not depend on an in-memory label that calls its selected entry old or new and does not
roll the head back. With no temporary residue this is Shape D. It reopens and reverifies the
complete chain, flushes the selected entry file and `wal-v2` directory, flushes the head file and
`Transactions` directory, reopens the final head and selected entry, and adopts the new tail only
after identities, ACLs, bytes, and mutual bindings remain exact. A removable fixed head temporary
is instead Shape E: it is cleaned by the rule above and recovery restarts classification from the
authoritative final head rather than adopting a remembered publication result.

The following conditions always fail closed out of band without selecting an older entry:

- a missing or untrusted authoritative head;
- a missing, malformed, noncanonical, digest-mismatched, or identity-mismatched selected entry;
- a sequence gap, repeated sequence, broken previous digest, detached genesis, or chain that does
  not end at the selected tail;
- two direct successors, any fork, more than one orphan, or a later unreferenced sequence;
- an unexpected file, directory, stream, hard link, reparse point, case alias, cross-volume object,
  ACL mismatch, or enumeration overflow;
- uncertain rename, replace, flush, deletion, reopen, handle-close, or ownership result; or
- any state for which the old-versus-new head cannot be proved from the final authoritative bytes.

Recovery never chooses the lexically largest filename, numerically largest sequence, newest
timestamp, longest valid prefix, most recently modified transaction, or last parseable document.
It never truncates a corrupt tail, rewrites the head to an older entry, adopts an orphan, or repairs
an untrusted namespace by manufacturing a `FAILED_CLOSED` record. The operational result is
reported out of band while original evidence remains untouched.

### Windows object and namespace security

The future implementation must prove all of these properties through retained native handles:

- the shared fixed Installer parent, `Transactions`, every transaction directory, every `wal-v2`
  directory, every retained `record-v1.json`, the permanent lock, the head and temporary head, and
  every entry and temporary entry reside on the expected fixed local `C:` NTFS volume;
- `Transactions` and every object below it have SYSTEM as owner and group and a protected, non-null,
  non-defaulted DACL containing
  exactly two explicit allow ACEs: SYSTEM and built-in Administrators full control;
- no Worker service SID, release reader, interactive user, inherited ACE, deny ACE, conditional ACE,
  callback ACE, unknown trustee, or alternate policy grants access;
- every created object receives its final security descriptor at creation; create-broad-then-repair
  is forbidden;
- all path components have exact casing, case sensitivity is not enabled, final handle paths match
  the fixed namespace, and no 8.3 name, junction, mount point, symbolic link, or other alias selects
  an object;
- directories and files are non-reparse, files have exactly one hard link and only the unnamed data
  stream, and transaction IDs and sequence names pass the exact canonical grammar;
- every identity, link count, stream set, volume serial number, filesystem type, ACL, and canonical
  byte sequence, including each retained v1 record's 64 KiB bound and strict canonical parser, is
  checked again after each namespace mutation; and
- retained parent and file handles prevent a path substitution between inspection, publication,
  flush, reopen, cleanup, and close.

The reviewed descriptor targets are exact and ordered:

```text
directory: O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)
file:      O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)
```

These descriptors apply only to `Transactions` and its descendants. The Installer parent is shared
with ADR 0014 Enrollment and is not owned by this store. The store verifies that parent through a
separately reviewed shared-parent contract, never rewrites its ACL, and does not require the
Transactions two-ACE descriptor on it. The Enrollment release reader may retain only the traverse
and read rights granted by that separate contract; those rights do not propagate into the protected
Transactions subtree. The shared-parent ACL and enrollment-writer handoff are not yet frozen, so
bootstrap remains a production blocker.

Native comparison covers owner and group identity and their non-defaulted state; DACL present,
protected, non-defaulted control bits; and the exact ACE count, order, type, inheritance flags,
access mask, and SID. Children use their own protected final descriptors and therefore contain no
inherited ACE. SACL authoring and comparison are not granted by this contract; if supported Windows
behavior requires a SACL decision, the store remains unavailable until a later security review
freezes it.

Short-name and case checks are native blockers, not string heuristics. Every file and directory must
be queried with `GetFileInformationByHandleEx(FileAlternateNameInfo, ...)` and proved to have no 8.3
alternate name. Rejecting a visible tilde is insufficient. Each retained directory must be proved
case-insensitive, and all admitted and enumerated names must be unique under Windows ordinal
case-insensitive comparison equivalent to `CompareStringOrdinal(..., TRUE)`. Generic Unicode case
folding may reject input early but cannot prove absence of an NTFS case collision.

The implementation must use handle-relative, bounded enumeration and cleanup. It must not call a
shell, `cmd.exe`, PowerShell, WMI, `sc.exe`, WinSW install or uninstall, recursive deletion, glob,
path-normalizing helper, caller callback, or generic filesystem abstraction that can escape the
fixed namespace. Journal bytes, paths, native error text, handles, and permit material are not
copied into Worker logs or receipts.

This ADR specifies required semantics, not an unproved API recipe. The precise access masks, share
modes, create dispositions, rename or replace primitive, directory handle flags, and directory
flush mechanism must be frozen by the Windows implementation review and demonstrated on supported
x64 and arm64 systems. Documentation or an API success return is not durability evidence.

### Shutdown and error handling

Shutdown stops admission of new preparations, invalidates unused permits, and lets at most the
currently entered publication stage reach one proven old-or-new durable state within its bounded
deadline. It never begins an effect during shutdown. An expired deadline, ignored cancellation,
uncertain native result, or close failure leaves no authority in memory and produces out-of-band
failure for fresh recovery.

Error values and logs contain only stable local categories such as namespace ambiguous, journal
corrupt, durability unproved, ownership lost, or migration blocked. They do not retain document
bytes, action payloads, native buffers, SIDs, paths beyond fixed public constants, handles, permit
state, or arbitrary Windows error text.

## Compatibility

ADR 0015 remains the schema-v1 record and pre-migration namespace contract. This ADR supersedes it
only for the document stored at the permanent active-head path after successful migration and for
the append-only v2 entry layout, with one earlier narrow cleanup refinement. A migration-aware
gate-off store may delete a partial `active-head-v1.json.tmp` or Shape V's selected
`record-v1.json.tmp` only when the final v1 head and selected record are strict, authoritative, and
unchanged; sealed expected schema is v1; the temporary path, type, identity, ACL, link, stream, and
applicable 1 KiB or 64 KiB size bound are exact; and no unrelated residue exists. The temporary was
never authoritative, no v2 permit can have been minted, deletion is followed by parent flush and
re-enumeration, and its content is never used to infer a head, record, version, or sequence. This
ADR does not alter any v1 canonical schema, digest, action, reducer, or final record file.

ADR 0020 remains permanently blocked. `internal/installstorev2lab` is its sole reviewed non-test
importer and uses `MarshalRecord` and `ParseRecord` only to preserve the complete nested canonical
document. The store lab is itself unreachable from production, and any second non-test importer of
either lab is rejected by architecture guards. Production activation requires all of the following
as separate reviewed work:

- a new production-capable transaction record schema/profile;
- a sealed transition bridge that is the only constructor of `PreparedSuccessor`;
- a protected native store implementation and exact API/ABI review;
- signed gate-off rollback binary installation before migration;
- x64 and arm64 native atomicity, flush, crash-cut, power-loss, ACL, reparse, hard-link, stream,
  case-alias, fork, and rollback evidence;
- destination, enrollment, SCM, process-tree, readiness, and package evidence required by the
  record transition; and
- an atomically versioned release migration inventory that prevents any v1-only writer from running
  after the schema-v2 head is published.

There is no compatibility fallback, dual-read selection, rolling writer upgrade, orphan adoption,
or automatic migration. Garbage collection is not an activation or canary gate, but any later GC
must be a separate handle-bound decision and cannot weaken the bounded namespace or chain proof.

## Consequences

- One permanent lock and one permanent physical head prevent cross-version split-brain ownership.
- Append-only entries retain every durable intent and completion record while the head selects one
  exact tail.
- Every legal 4,096-directory v1 inventory can add the one current v2 transaction without GC;
  additional v2 transactions remain outside this version.
- Entry-before-head publication makes an old-head crash residue safely discardable only when it is
  the unique exact existing-transaction direct successor or the unique predecessor-bound migration
  genesis under its applicable orphan protocol, and no permit could have been issued.
- A new-head crash never falls back; it is adopted only after full reflush, reopen, and verification.
- The contract exposes no filesystem or effect capability today. Windows implementation and
  production composition remain blocked on native evidence and new schema work.
