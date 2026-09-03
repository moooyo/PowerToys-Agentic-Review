# Dormant Server Enrollment Binding Authority v1 S0 Handoff

Status date: 2026-09-03

Branch: `codex/server-binding-authority-v1-lab`

Base commit before this slice: `a77a5dcb3af161d21d763a74d6201b872209ebe0`

ADR 0022 was frozen in commit `041eb9b6e4facd97f3610d730f0224bac91ff1b7` and merged into
`codex/integration` by the base commit above. Its reviewed document SHA-256 is
`1883d04c2ec4aa67221523f5a5ce0c9dafccd0d6ac3855d7beaf5fb90cfb28a1`.

## Completed Scope

This slice implements only the source-only S0 contract described by ADR 0022.

- Hidden TypeScript receipt and active-status DTOs, recursively frozen TypeBox schemas, strict
  canonical codecs, exact signing preimages and digests, and ordinary caller-key signature checks.
- Exact 4 KiB document bounds, ASCII-only values, real UTC millisecond timestamps in years
  `0001..9999`, strict unpadded base64url, lowercase digests and UUIDs, and the ADR 0014 identifier
  grammars.
- Exact 91-byte uncompressed P-256 PKIX SPKI verification, SHA-256 issuer key IDs, 64-byte P1363
  signatures, scalar range checks, low-S enforcement, and receipt/status domain separation.
- A deterministic Server lifecycle reducer for `absent`, `signing_pending`, `reserved`, `active`,
  and terminal `revoked`, including exact replay, immutable-basis checks, first-writer receipt and
  record behavior, canonical byte/digest binding, and module-minted state identity.
- A standard-library-only Go verifier with an always-unavailable production trust facade.
- Opaque CSPRNG challenge state and one-shot active-status evidence. Copies share atomic lifecycle
  state; validation and final consumption bind the exact tuple, challenge, trusted clock, and signed
  expiry.
- Two LF-delimited canonical golden documents shared by TypeScript and Go. The fixture contains only
  the public test key identity and signed public documents, never the private key.
- Architecture guards that keep both TypeScript modules out of package barrels and every production
  consumer, keep the Go package unconsumed, pin the exported and production file surfaces, and fence
  runtime-loader aliases and indirect calls.

## Zero-Authority Boundary

- `packages/contracts/src/index.ts` and `packages/contracts/package.json` expose no S0 subpath.
- No Server route, database, migration, config, runtime, Worker authentication, or application entry
  point imports the S0 files.
- No native production package imports `serverbindingauthorityv1`.
- `ProductionVerifier()` always returns `ErrUnavailable`; no production source embeds a test key,
  signer, private-key parser, or key-generation path.
- Caller-supplied SPKI verification returns ordinary signature facts only. It cannot mint trust,
  active-status evidence, Worker identity, Claim, lease, slot, installation, or execution authority.
- The environment certificate map remains the sole positive Worker certificate mapping.

## Frozen Candidate

```text
9a4db8a08bb650e0d9a0e7e2bb927d63dd71af33ba38fdf30900ce5b6f37b388  apps/server/src/enrollment/server-binding-state-v1.ts
29b38459aa8e5d1d29be85d3aead0f9154e1d28bdb231d0e277c6fe567c94bd3  apps/server/src/enrollment/server-binding-state-v1.test.ts
40601da911983094dbdfaa6131778251ce8c2496b70074e1d0b1b2200578bc33  packages/contracts/src/server-binding-authority-v1.ts
3aea0e57f4b38d33fdfd9f7c1073e584201798855d7e65595332c866f77c626d  packages/contracts/src/server-binding-authority-v1.test.ts
4544738a27b69fb39dde0b79188446b11b5a88e81c3d4ea44e99e6e6a982de45  testdata/server-binding-authority-v1.jsonl
20e54de79e4d54c15620c9238e776c4904a35a02e35d9db0765a6fc0369213f4  native/service-host/internal/serverbindingauthorityv1/architecture_test.go
923828f60e236c663d5aca31b8a0cbf6ad0f5d6d9f0cfc9beb679fada14da529  native/service-host/internal/serverbindingauthorityv1/canonical_test.go
33f08884aa843588fdcb7bc57f6cf159ebd6d012c3f8c329b94cadc94a0130c6  native/service-host/internal/serverbindingauthorityv1/canonical.go
17d3f5c0fea79635d1bbb5b1f2b3670fbf72959518b46c2b46c97c1dac84512d  native/service-host/internal/serverbindingauthorityv1/doc.go
647ed698e2751f9629e4443c1cf9820494f01420916bf24eb73160e009a2f3f0  native/service-host/internal/serverbindingauthorityv1/evidence_test.go
258c067c82790f93718acf655051a455bf093ee8a80d7c2cbf3f4a7d08f65c46  native/service-host/internal/serverbindingauthorityv1/evidence.go
dec917426b1238d0d4f7c56d3bed6566d93782f76049f5d286083adb53e3e82a  native/service-host/internal/serverbindingauthorityv1/fixture_test.go
78d6c1ce5ac37ad282d637283fe2faa8e149901ca7d4a79ae03713330fb1bf53  native/service-host/internal/serverbindingauthorityv1/signature_test.go
0d35fc2d7bcdb7fcaab85143d165c78c4e4a27d01bfd5b60f9f11b79f8431a07  native/service-host/internal/serverbindingauthorityv1/signature.go
1278ecb0b1eb5d53873d71a0573858c9e3f4bd7ec60da54cd9d5c9284491f255  native/service-host/internal/serverbindingauthorityv1/test_helpers_test.go
2c144729cc671c2c67b80fd83467578fdaddfaebb89b29486bd5c1c1690f3182  native/service-host/internal/serverbindingauthorityv1/types.go
891dfb9c15c71bf827be5ff1576fe5c4fac787d1aa3e4e593bca8dbde4ccd245  native/service-host/internal/serverbindingauthorityv1/verifier.go
```

The two shared fixture line SHA-256 values are:

```text
7f26a7618f33cdfd5384c224904dcf232084de94a83858084ddb526b8c41beeb  receipt
0a453bbb93bc62ed2509d4ac73faab723944f5eb245d05e6ade1a0b5983c0c8f  active-status
```

## Verification

The final S0 code was verified locally after explicit authorization with Node `24.20.0`, pnpm
`11.24.0`, and Go `1.26.3 windows/amd64`:

- all-workspace serial TypeScript typecheck passed;
- all-workspace serial build passed, including the dashboard Webpack build and Worker bundles;
- `pnpm lint` passed for 304 files;
- contracts tests passed `27/27`, including `22/22` new S0 contract tests;
- the final Server reducer passed `13/13` focused tests;
- Codex `86/86`, local protocol `92/92`, domain `21/21`, Worker `897/897`, and Worker architecture
  `19/19` passed locally; and
- the final Go package passed its 30 focused tests, while `go vet ./...` passed.

The complete Server suite requires POSIX ownership and persistent-filesystem semantics and therefore
fails closed on Windows by design. On `test-env`, the full Server suite passed `748/748` on an
isolated ext4 test volume. The earlier remote integrated Go snapshot passed every package, serial
race detection, and vet; Windows amd64 and arm64 all-package test compilation, build, and vet also
passed. The final year-zero tightening was then covered by the final local focused Go run.

The local full Go suite also exercises existing machine-specific Windows ACL and token policy. It
reported unrelated host-DACL failures and a blocking WinPipe test on this developer machine; the new
package itself passed, and the corresponding platform-neutral full suite and Windows cross-builds
were already green on `test-env`.

## Deferred Work

S0 is not a production enrollment implementation. The following remain separate reviewed slices:

1. S1 SQLite migration, immutable issuer singleton, authorization and binding repositories,
   asynchronous signer coordination, exact replay, append-only revocation, startup checks, and
   fail-closed storage lifecycle.
2. S2 production OIDC enrollment-authority policy, same-origin preauthorization, direct candidate
   mTLS receipt issuance, confirmation, active-status, recovery-download, and revocation routes.
3. The privileged Windows enrollment journal, CNG and certificate creation, receipt-first and
   record-last publication, handle-bound reader, repair command, and crash recovery.
4. Composition of `RecordEvidence` and fresh active-status evidence into one immediate-use
   `LiveEvidence` value, followed by destination verification and installer composition.
5. Any Worker-auth migration, negative revocation veto, Claim or slot activation, package
   construction, production RoleConfig v3 activation, or canary rollout.

Do not start S1 until this S0 commit is integrated and its production-unreachable architecture
guards remain green. Do not make the binding table a positive Worker authentication source in S1 or
S2.
