import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign as nodeSign,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  deriveServerBindingIssuerKeyIdV1,
  marshalServerBindingReceiptStatementV1,
  marshalServerBindingReceiptV1,
  SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
  SERVER_BINDING_AUTHORITY_ISSUER,
  SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
  SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
  SERVER_BINDING_RECEIPT_PROFILE_ID,
  type ServerBindingReceiptStatementV1,
  type ServerBindingReceiptV1,
  serverBindingReceiptSigningPreimageV1,
} from "@agentic-review/contracts/server-binding-authority-v1";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { runMigrations } from "../../dist/database/migrations.js";
import {
  auditServerBindingPersistenceV1,
  type ClaimServerBindingAuthorizationV1Result,
  type ConfirmServerBindingRecordV1Input,
  type CreateServerBindingAuthorizationV1Input,
  claimServerBindingAuthorizationV1,
  commitServerBindingReceiptV1,
  confirmServerBindingRecordV1,
  createServerBindingAuthorizationV1,
  deriveServerBindingIssuanceRequestSha256V1,
  deriveServerBindingRevocationRequestSha256V1,
  initializeServerBindingIssuerV1,
  readServerBindingActiveSnapshotV1,
  readServerBindingRecoveryReceiptV1,
  recheckServerBindingActiveSnapshotV1,
  revokeServerBindingV1,
  type ServerBindingPersistenceErrorCodeV1,
  type ServerBindingTrustedIssuerDescriptorV1,
} from "../../dist/database/server-binding-persistence-v1.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const p256Order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const p256HalfOrder = p256Order >> 1n;
const testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQggZDZZcSzKuD4h3Iu
rGCGLBlKcNoYbAjlNgwsgHcJ/iGhRANCAAT6/SVhOAT0FIVQ9/JY4HhWm2IM5fxA
F0qkH3Q//jWyVZNp7k5o+oDKezoZWbxoB46t9HT3+DoCEUaaBPUsIz+c
-----END PRIVATE KEY-----`;
const testPrivateKey = createPrivateKey(testPrivateKeyPem);
const issuerSpki = createPublicKey(testPrivateKey).export({ format: "der", type: "spki" });
const issuerKeyId = deriveServerBindingIssuerKeyIdV1(issuerSpki);
const trustedIssuer = createTrustedIssuer(issuerSpki);

interface Fixture {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  readonly directory: string;
}

type PendingClaim = Extract<
  ClaimServerBindingAuthorizationV1Result,
  { readonly outcome: "signing_pending" }
>;

type NonterminalPhase = "signing_pending" | "reserved" | "active";

interface PreparedBinding {
  readonly authorization: CreateServerBindingAuthorizationV1Input;
  readonly claim: PendingClaim;
  readonly receiptJson: string | null;
  readonly recordDocumentSha256: string | null;
}

const fixtures: Fixture[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) {
    try {
      fixture.database.close();
    } catch {
      // The test may have closed the database before exercising startup behavior.
    }
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("dormant Server binding persistence v1", () => {
  it("hashes only exact immutable request snapshots", () => {
    const issuance = {
      authorizationExpiresAt: "2099-09-03T00:00:00.000Z",
      authorizationId: uuid(90),
      enrollmentGeneration: 1 as const,
      expectedCertificateDerSha256: sha256("expected-certificate"),
      installationId: "worker.installation-digest",
      issuerKeyId,
      observedCertificateDerSha256: sha256("expected-certificate"),
      operatorIssuer: "https://identity.example.test",
      operatorSubject: "operator-digest",
      requestId: uuid(91),
      tokenSha256: sha256("digest-token"),
      workerNodeId: "worker:node-digest",
    };
    const expectedIssuanceDigest = deriveServerBindingIssuanceRequestSha256V1(issuance);
    expect(
      deriveServerBindingIssuanceRequestSha256V1(
        Object.assign(Object.create(null) as typeof issuance, issuance),
      ),
    ).toBe(expectedIssuanceDigest);

    const issuanceWithExtraField = { ...issuance, unexpected: true };
    expectPersistenceCode(
      () => deriveServerBindingIssuanceRequestSha256V1(issuanceWithExtraField),
      "SERVER_BINDING_INVALID_INPUT",
    );

    const requestIdGetter = vi.fn(() => issuance.requestId);
    const issuanceWithAccessor = { ...issuance };
    Object.defineProperty(issuanceWithAccessor, "requestId", {
      configurable: true,
      enumerable: true,
      get: requestIdGetter,
    });
    expectPersistenceCode(
      () => deriveServerBindingIssuanceRequestSha256V1(issuanceWithAccessor),
      "SERVER_BINDING_INVALID_INPUT",
    );
    expect(requestIdGetter).not.toHaveBeenCalled();

    const reflectingProxy = new Proxy(issuance, {
      getOwnPropertyDescriptor() {
        throw new Error("reflection blocked");
      },
    });
    expectPersistenceCode(
      () => deriveServerBindingIssuanceRequestSha256V1(reflectingProxy),
      "SERVER_BINDING_INVALID_INPUT",
    );
    for (const invalid of [
      { ...issuance, requestId: `${issuance.requestId}\n` },
      { ...issuance, tokenSha256: `${issuance.tokenSha256}\n` },
      { ...issuance, workerNodeId: `${issuance.workerNodeId}\n` },
      { ...issuance, installationId: `${issuance.installationId}\n` },
    ]) {
      expectPersistenceCode(
        () => deriveServerBindingIssuanceRequestSha256V1(invalid),
        "SERVER_BINDING_INVALID_INPUT",
      );
    }

    const revocation = {
      bindingId: uuid(92),
      reasonCode: "operator_requested" as const,
      revocationId: uuid(93),
    };
    expect(deriveServerBindingRevocationRequestSha256V1(revocation)).toMatch(/^[0-9a-f]{64}$/u);
    expectPersistenceCode(
      () => deriveServerBindingRevocationRequestSha256V1({ ...revocation, unexpected: true }),
      "SERVER_BINDING_INVALID_INPUT",
    );
  });

  it("fails audit when a required schema guard is removed or replaced", async () => {
    const removed = await openFixture();
    removed.database.exec("DROP TRIGGER tr_server_binding_transition");
    expectPersistenceCode(
      () => auditServerBindingPersistenceV1(removed.database, null),
      "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE",
    );

    const replaced = await openFixture();
    replaced.database.exec(`
      DROP TRIGGER tr_server_binding_transition;
      CREATE TRIGGER tr_server_binding_transition
      AFTER UPDATE ON server_bindings
      BEGIN
        SELECT 1;
      END;
    `);
    expectPersistenceCode(
      () => auditServerBindingPersistenceV1(replaced.database, null),
      "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE",
    );

    const external = await openFixture();
    external.database.exec(`
      CREATE TRIGGER tr_external_server_binding_mutation
      AFTER UPDATE ON jobs
      BEGIN
        UPDATE server_bindings
        SET phase = phase
        WHERE 0;
      END;
    `);
    expectPersistenceCode(
      () => auditServerBindingPersistenceV1(external.database, null),
      "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE",
    );
  });

  it("audits the empty state and enforces issuer initialization replay and mismatch", async () => {
    const { database } = await openFixture();

    expect(auditServerBindingPersistenceV1(database, null)).toEqual({
      state: "uninitialized",
      issuer: null,
      authorizationCount: 0,
      bindingCount: 0,
      revocationCount: 0,
    });

    const initialized = initializeServerBindingIssuerV1(database, trustedIssuer, {
      expectedIssuerKeyId: trustedIssuer.issuerKeyId,
    });
    expect(initialized).toMatchObject({
      outcome: "initialized",
      issuer: {
        authoritySchemaVersion: 1,
        issuer: SERVER_BINDING_AUTHORITY_ISSUER,
        receiptProfileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
        activeStatusProfileId: SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
        signatureAlgorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
        issuerKeyId,
      },
    });
    expect(
      initializeServerBindingIssuerV1(database, trustedIssuer, {
        expectedIssuerKeyId: trustedIssuer.issuerKeyId,
      }),
    ).toEqual({
      outcome: "replayed",
      issuer: initialized.issuer,
    });
    expect(auditServerBindingPersistenceV1(database, trustedIssuer)).toEqual({
      state: "initialized",
      issuer: initialized.issuer,
      authorizationCount: 0,
      bindingCount: 0,
      revocationCount: 0,
    });
    expectPersistenceCode(
      () => auditServerBindingPersistenceV1(database, null),
      "SERVER_BINDING_SIGNER_UNAVAILABLE",
    );

    const alternateKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const alternateIssuer = createTrustedIssuer(
      alternateKeys.publicKey.export({ format: "der", type: "spki" }),
    );
    expectPersistenceCode(
      () =>
        initializeServerBindingIssuerV1(database, alternateIssuer, {
          expectedIssuerKeyId: alternateIssuer.issuerKeyId,
        }),
      "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE",
    );
    expectPersistenceCode(
      () =>
        initializeServerBindingIssuerV1(
          database,
          {
            ...trustedIssuer,
            issuerKeyId: "00".repeat(32),
          },
          { expectedIssuerKeyId: "00".repeat(32) },
        ),
      "SERVER_BINDING_SIGNER_MISMATCH",
    );
  });

  it("creates and exactly replays authorizations while rejecting reused identities", async () => {
    const { database } = await openInitializedFixture();
    const input = authorizationInput(1);

    const created = createServerBindingAuthorizationV1(database, trustedIssuer, input);
    expect(created).toEqual({
      outcome: "created",
      authorization: {
        ...input,
        issuerKeyId,
        consumption: null,
      },
    });
    expect(createServerBindingAuthorizationV1(database, trustedIssuer, input)).toEqual({
      outcome: "replayed",
      authorization: created.authorization,
    });

    for (const conflict of [
      authorizationInput(2, { authorizationId: input.authorizationId }),
      authorizationInput(3, { requestId: input.requestId }),
      authorizationInput(4, { tokenSha256: input.tokenSha256 }),
    ]) {
      expectPersistenceCode(
        () => createServerBindingAuthorizationV1(database, trustedIssuer, conflict),
        "SERVER_BINDING_IMMUTABLE_CONFLICT",
      );
    }
    expect(
      database.prepare("SELECT count(*) AS count FROM server_binding_authorizations").get(),
    ).toEqual({ count: 1 });
  });

  it("atomically creates the first pending claim, rejects unused expiry, and replays after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T00:00:00.500Z");
    const { database } = await openInitializedFixture();
    database
      .prepare("UPDATE operator_auth_clock SET last_observed_at = ? WHERE singleton = 1")
      .run("2026-09-03T00:00:00.000Z");
    const expired = authorizationInput(10, {
      createdAt: "2026-09-03T00:00:00.000Z",
      expiresAt: "2026-09-03T00:00:00.400Z",
    });
    createServerBindingAuthorizationV1(database, trustedIssuer, expired);

    expectPersistenceCode(
      () => claimAuthorization(database, expired),
      "SERVER_BINDING_AUTHORIZATION_EXPIRED",
    );
    expect(
      database
        .prepare(`
          SELECT consumed_binding_id AS bindingId
          FROM server_binding_authorizations
          WHERE authorization_id = ?
        `)
        .get(expired.authorizationId),
    ).toEqual({ bindingId: null });
    expect(database.prepare("SELECT count(*) AS count FROM server_bindings").get()).toEqual({
      count: 0,
    });
    expect(
      database.prepare("SELECT last_observed_at AS now FROM operator_auth_clock").get(),
    ).toEqual({ now: "2026-09-03T00:00:00.500Z" });
    vi.setSystemTime("2026-09-03T00:00:00.200Z");
    expectPersistenceCode(
      () => claimAuthorization(database, expired),
      "SERVER_BINDING_AUTHORIZATION_EXPIRED",
    );

    const consumable = authorizationInput(11, {
      createdAt: "2026-09-03T00:00:00.000Z",
      expiresAt: "2026-09-03T00:00:01.000Z",
    });
    createServerBindingAuthorizationV1(database, trustedIssuer, consumable);
    vi.setSystemTime("2026-09-03T00:00:00.500Z");
    const first = claimNewBinding(database, consumable);
    expect(first.claim.authorizationId).toBe(consumable.authorizationId);
    expect(first.claim.basis.tuple).toMatchObject({
      bindingRevision: 1,
      workerNodeId: consumable.workerNodeId,
      installationId: consumable.installationId,
      enrollmentGeneration: 1,
      certificateDerSha256: consumable.expectedCertificateDerSha256,
    });

    vi.setSystemTime("2026-09-03T00:00:01.001Z");
    expect(claimAuthorization(database, consumable)).toEqual(first);
    expect(
      database
        .prepare(`
          SELECT count(*) AS count
          FROM server_bindings
          WHERE authorization_id = ?
        `)
        .get(consumable.authorizationId),
    ).toEqual({ count: 1 });
  });

  it("rejects a runtime-corrupted authorization clock with duplicate singleton rows", async () => {
    const { database } = await openInitializedFixture();
    const authorization = authorizationInput(12);
    createServerBindingAuthorizationV1(database, trustedIssuer, authorization);
    database.exec(`
      DROP TABLE operator_auth_clock;
      CREATE TABLE operator_auth_clock (
        singleton INTEGER NOT NULL,
        last_observed_at TEXT NOT NULL
      );
      INSERT INTO operator_auth_clock (singleton, last_observed_at)
      VALUES
        (1, '2026-09-03T00:00:00.000Z'),
        (1, '2026-09-03T00:00:00.001Z');
    `);

    expectPersistenceCode(
      () => claimAuthorization(database, authorization),
      "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE",
    );
  });

  it("classifies competing unused authorizations as immutable conflicts", async () => {
    const { database } = await openInitializedFixture();
    const tupleWinner = authorizationInput(12);
    const tupleLoser = authorizationInput(13, {
      workerNodeId: tupleWinner.workerNodeId,
    });
    const certificateWinner = authorizationInput(14);
    const certificateLoser = authorizationInput(15, {
      expectedCertificateDerSha256: certificateWinner.expectedCertificateDerSha256,
    });
    for (const authorization of [tupleWinner, tupleLoser, certificateWinner, certificateLoser]) {
      createServerBindingAuthorizationV1(database, trustedIssuer, authorization);
    }

    claimNewBinding(database, tupleWinner);
    expectPersistenceCode(
      () => claimAuthorization(database, tupleLoser),
      "SERVER_BINDING_IMMUTABLE_CONFLICT",
    );
    claimNewBinding(database, certificateWinner);
    expectPersistenceCode(
      () => claimAuthorization(database, certificateLoser),
      "SERVER_BINDING_IMMUTABLE_CONFLICT",
    );
  });

  it("does not mask a corrupt conflicting binding as an immutable conflict", async () => {
    const { database } = await openInitializedFixture();
    const winner = authorizationInput(16);
    const claimLoser = authorizationInput(17, { workerNodeId: winner.workerNodeId });
    createServerBindingAuthorizationV1(database, trustedIssuer, winner);
    createServerBindingAuthorizationV1(database, trustedIssuer, claimLoser);
    const pending = claimNewBinding(database, winner);

    database.exec("DROP TRIGGER tr_server_binding_transition");
    database
      .prepare("UPDATE server_bindings SET statement_document_sha256 = ? WHERE binding_id = ?")
      .run("ff".repeat(32), pending.claim.basis.tuple.bindingId);

    expectPersistenceCode(
      () =>
        createServerBindingAuthorizationV1(
          database,
          trustedIssuer,
          authorizationInput(18, { workerNodeId: winner.workerNodeId }),
        ),
      "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE",
    );
    expectPersistenceCode(
      () => claimAuthorization(database, claimLoser),
      "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE",
    );
  });

  it("audits authorization tombstones through bounded keyset pages", async () => {
    const { database } = await openInitializedFixture();
    for (let ordinal = 0; ordinal < 257; ordinal += 1) {
      createAuthorization(database, 5_000 + ordinal);
    }

    expect(auditServerBindingPersistenceV1(database, trustedIssuer)).toMatchObject({
      state: "initialized",
      authorizationCount: 257,
      bindingCount: 0,
      revocationCount: 0,
    });
  });

  it("commits the first valid receipt candidate and always replays the retained bytes", async () => {
    const { database } = await openInitializedFixture();
    const authorization = createAuthorization(database, 20);
    const pending = claimNewBinding(database, authorization);
    const firstCandidate = receiptJsonForClaim(pending);
    const losingCandidate = distinctReceiptJsonForClaim(pending, firstCandidate);

    const committed = commitServerBindingReceiptV1(database, trustedIssuer, {
      bindingId: pending.claim.basis.tuple.bindingId,
      issuanceRequestSha256: pending.claim.basis.request.requestSha256,
      receiptJson: firstCandidate,
    });
    expect(committed).toEqual({
      outcome: "committed",
      retainedPhase: "reserved",
      receipt: {
        canonicalJson: firstCandidate,
        receiptSha256: sha256(firstCandidate),
      },
    });

    expect(
      commitServerBindingReceiptV1(database, trustedIssuer, {
        bindingId: pending.claim.basis.tuple.bindingId,
        issuanceRequestSha256: pending.claim.basis.request.requestSha256,
        receiptJson: losingCandidate,
      }),
    ).toEqual({
      outcome: "replayed",
      retainedPhase: "reserved",
      receipt: committed.receipt,
    });
    expect(losingCandidate).not.toBe(firstCandidate);
    expect(claimAuthorization(database, authorization)).toEqual({
      outcome: "receipt_replay",
      retainedPhase: "reserved",
      claim: pending.claim,
      receipt: committed.receipt,
    });
  });

  it("activates only a reserved binding and exactly replays the first record digest", async () => {
    const { database } = await openInitializedFixture();
    const authorization = createAuthorization(database, 30);
    const pending = claimNewBinding(database, authorization);
    const firstRecord = sha256("record-30");
    const confirmation = recordConfirmation(pending, firstRecord);

    expectPersistenceCode(
      () => confirmServerBindingRecordV1(database, trustedIssuer, confirmation),
      "SERVER_BINDING_TRANSITION_INVALID",
    );

    const receiptJson = receiptJsonForClaim(pending);
    commitReceipt(database, pending, receiptJson);
    expect(confirmServerBindingRecordV1(database, trustedIssuer, confirmation)).toEqual({
      outcome: "confirmed",
      bindingId: pending.claim.basis.tuple.bindingId,
      recordDocumentSha256: firstRecord,
    });
    expect(confirmServerBindingRecordV1(database, trustedIssuer, confirmation)).toEqual({
      outcome: "replayed",
      bindingId: pending.claim.basis.tuple.bindingId,
      recordDocumentSha256: firstRecord,
    });
    expectPersistenceCode(
      () =>
        confirmServerBindingRecordV1(database, trustedIssuer, {
          ...confirmation,
          recordDocumentSha256: sha256("changed-record-30"),
        }),
      "SERVER_BINDING_IMMUTABLE_CONFLICT",
    );
    expect(
      commitServerBindingReceiptV1(database, trustedIssuer, {
        bindingId: pending.claim.basis.tuple.bindingId,
        issuanceRequestSha256: pending.claim.basis.request.requestSha256,
        receiptJson,
      }),
    ).toMatchObject({ outcome: "replayed", retainedPhase: "active" });
  });

  it("returns exact recovery receipts and transactionally rechecks active snapshots", async () => {
    const { database } = await openInitializedFixture();
    const prepared = prepareBinding(database, 40, "reserved");
    if (prepared.receiptJson === null) throw new Error("Expected a reserved receipt.");

    expect(
      readServerBindingRecoveryReceiptV1(database, trustedIssuer, {
        certificateDerSha256: prepared.authorization.expectedCertificateDerSha256,
      }),
    ).toEqual({
      bindingId: prepared.claim.claim.basis.tuple.bindingId,
      bindingRevision: 1,
      phase: "reserved",
      receiptJson: prepared.receiptJson,
      receiptSha256: sha256(prepared.receiptJson),
    });
    expect(
      readServerBindingActiveSnapshotV1(database, trustedIssuer, {
        certificateDerSha256: prepared.authorization.expectedCertificateDerSha256,
      }),
    ).toBeNull();

    const recordDocumentSha256 = sha256("record-40");
    confirmServerBindingRecordV1(
      database,
      trustedIssuer,
      recordConfirmation(prepared.claim, recordDocumentSha256),
    );
    const recovery = readServerBindingRecoveryReceiptV1(database, trustedIssuer, {
      certificateDerSha256: prepared.authorization.expectedCertificateDerSha256,
    });
    expect(recovery).toMatchObject({
      phase: "active",
      receiptJson: prepared.receiptJson,
      receiptSha256: sha256(prepared.receiptJson),
    });

    const active = readServerBindingActiveSnapshotV1(database, trustedIssuer, {
      certificateDerSha256: prepared.authorization.expectedCertificateDerSha256,
    });
    if (active === null) throw new Error("Expected an active binding snapshot.");
    expect(recheckServerBindingActiveSnapshotV1(database, trustedIssuer, active)).toEqual(active);
    expectPersistenceCode(
      () =>
        recheckServerBindingActiveSnapshotV1(database, trustedIssuer, {
          ...active,
          recordDocumentSha256: sha256("changed-record-40"),
        }),
      "SERVER_BINDING_IMMUTABLE_CONFLICT",
    );
  });

  it.each([
    ["signing_pending", 50],
    ["reserved", 51],
    ["active", 52],
  ] as const)(
    "revokes %s bindings terminally and exactly replays the request",
    async (phase, ordinal) => {
      const { database } = await openInitializedFixture();
      const prepared = prepareBinding(database, ordinal, phase);
      const activeBeforeRevocation = readServerBindingActiveSnapshotV1(database, trustedIssuer, {
        certificateDerSha256: prepared.authorization.expectedCertificateDerSha256,
      });
      const request = {
        revocationId: uuid(8_000 + ordinal),
        bindingId: prepared.claim.claim.basis.tuple.bindingId,
        reasonCode: "operator_requested" as const,
      };

      const revoked = revokeServerBindingV1(database, trustedIssuer, request);
      expect(revoked).toMatchObject({
        outcome: "revoked",
        revocationId: request.revocationId,
        bindingId: request.bindingId,
        priorPhase: phase,
        reasonCode: request.reasonCode,
      });
      expect(revokeServerBindingV1(database, trustedIssuer, request)).toEqual({
        ...revoked,
        outcome: "replayed",
      });
      expectPersistenceCode(
        () =>
          revokeServerBindingV1(database, trustedIssuer, {
            ...request,
            reasonCode: "integrity_failure",
          }),
        "SERVER_BINDING_IMMUTABLE_CONFLICT",
      );
      expectPersistenceCode(
        () =>
          revokeServerBindingV1(database, trustedIssuer, {
            ...request,
            revocationId: uuid(9_000 + ordinal),
          }),
        "SERVER_BINDING_TERMINAL_REVOKED",
      );
      expectPersistenceCode(
        () => claimAuthorization(database, prepared.authorization),
        "SERVER_BINDING_TERMINAL_REVOKED",
      );
      expect(
        readServerBindingRecoveryReceiptV1(database, trustedIssuer, {
          certificateDerSha256: prepared.authorization.expectedCertificateDerSha256,
        }),
      ).toBeNull();
      expect(
        readServerBindingActiveSnapshotV1(database, trustedIssuer, {
          certificateDerSha256: prepared.authorization.expectedCertificateDerSha256,
        }),
      ).toBeNull();
      if (activeBeforeRevocation !== null) {
        expectPersistenceCode(
          () =>
            recheckServerBindingActiveSnapshotV1(database, trustedIssuer, activeBeforeRevocation),
          "SERVER_BINDING_TERMINAL_REVOKED",
        );
      }

      const receiptJson = prepared.receiptJson ?? receiptJsonForClaim(prepared.claim);
      expectPersistenceCode(
        () =>
          commitServerBindingReceiptV1(database, trustedIssuer, {
            bindingId: request.bindingId,
            issuanceRequestSha256: prepared.claim.claim.basis.request.requestSha256,
            receiptJson,
          }),
        "SERVER_BINDING_TERMINAL_REVOKED",
      );
      expectPersistenceCode(
        () =>
          confirmServerBindingRecordV1(
            database,
            trustedIssuer,
            recordConfirmation(
              prepared.claim,
              prepared.recordDocumentSha256 ?? sha256(`record-after-revocation-${ordinal}`),
            ),
          ),
        "SERVER_BINDING_TERMINAL_REVOKED",
      );
      expect(auditServerBindingPersistenceV1(database, trustedIssuer)).toMatchObject({
        state: "initialized",
        authorizationCount: 1,
        bindingCount: 1,
        revocationCount: 1,
      });
    },
  );

  it("enforces deferred foreign keys and direct SQL mutation triggers", async () => {
    const { database } = await openInitializedFixture();
    const authorization = createAuthorization(database, 60);
    const manual = directBindingFacts(authorization, uuid(6_060));

    expect(() =>
      database
        .prepare("UPDATE server_binding_receipt_issuer SET initialized_at = initialized_at")
        .run(),
    ).toThrow(/server binding receipt issuer is immutable/u);
    expect(() => database.prepare("DELETE FROM server_binding_receipt_issuer").run()).toThrow(
      /server binding receipt issuer is immutable/u,
    );
    expect(() =>
      database
        .prepare(
          "UPDATE server_binding_authorizations SET operator_subject = ? WHERE authorization_id = ?",
        )
        .run("changed-subject", authorization.authorizationId),
    ).toThrow(/server binding authorization is immutable after one consumption/u);
    expect(() =>
      database
        .prepare("DELETE FROM server_binding_authorizations WHERE authorization_id = ?")
        .run(authorization.authorizationId),
    ).toThrow(/server binding authorizations are durable tombstones/u);

    database.exec("BEGIN IMMEDIATE");
    try {
      consumeAuthorizationDirect(database, authorization, manual);
      expect(() => database.exec("COMMIT")).toThrow(/FOREIGN KEY constraint failed/u);
    } finally {
      rollbackIfNeeded(database);
    }
    expect(
      database
        .prepare(`
          SELECT
            consumed_binding_id AS bindingId,
            consumed_issuance_request_sha256 AS requestSha256,
            consumed_at AS consumedAt
          FROM server_binding_authorizations
          WHERE authorization_id = ?
        `)
        .get(authorization.authorizationId),
    ).toEqual({ bindingId: null, requestSha256: null, consumedAt: null });

    for (const candidate of [
      {
        phase: "reserved",
        receiptJson: manual.receiptJson,
        receiptSha256: manual.receiptSha256,
        recordDocumentSha256: null,
      },
      {
        phase: "active",
        receiptJson: manual.receiptJson,
        receiptSha256: manual.receiptSha256,
        recordDocumentSha256: sha256("direct-active-record"),
      },
      {
        phase: "revoked",
        receiptJson: null,
        receiptSha256: null,
        recordDocumentSha256: null,
      },
    ] as const) {
      database.exec("BEGIN IMMEDIATE");
      try {
        consumeAuthorizationDirect(database, authorization, manual);
        expect(() => insertBindingDirect(database, authorization, manual, candidate)).toThrow(
          /server binding must begin as the exact consumed signing request/u,
        );
      } finally {
        rollbackIfNeeded(database);
      }
    }

    const pending = claimNewBinding(database, authorization);
    const receiptJson = receiptJsonForClaim(pending);
    expect(() =>
      database
        .prepare(`
          UPDATE server_bindings
          SET
            phase = 'active',
            receipt_json = ?,
            receipt_sha256 = ?,
            record_document_sha256 = ?
          WHERE binding_id = ?
        `)
        .run(
          receiptJson,
          sha256(receiptJson),
          sha256("direct-record"),
          pending.claim.basis.tuple.bindingId,
        ),
    ).toThrow(/invalid server binding transition/u);
    expect(() =>
      database
        .prepare("DELETE FROM server_bindings WHERE binding_id = ?")
        .run(pending.claim.basis.tuple.bindingId),
    ).toThrow(/server bindings are immutable/u);

    const revocation = revokeServerBindingV1(database, trustedIssuer, {
      revocationId: uuid(8_060),
      bindingId: pending.claim.basis.tuple.bindingId,
      reasonCode: "enrollment_abandoned",
    });
    expect(() =>
      database
        .prepare("UPDATE server_binding_revocations SET reason_code = ? WHERE revocation_id = ?")
        .run("integrity_failure", revocation.revocationId),
    ).toThrow(/server binding revocations are append-only/u);
    expect(() =>
      database
        .prepare("DELETE FROM server_binding_revocations WHERE revocation_id = ?")
        .run(revocation.revocationId),
    ).toThrow(/server binding revocations are append-only/u);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "fails real database startup when a retained aggregate is corrupt",
    async () => {
      const directory = await createTemporaryDirectory("agentic-review-binding-startup-");
      const databasePath = join(directory, "data", "state.sqlite");
      const initialClient = await DatabaseClient.create({
        databasePath,
        migrationsDirectory,
        serverBindingTrustedIssuer: trustedIssuer,
      });
      await initialClient.close();

      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
      const fixture = { database, databasePath, directory };
      fixtures.push(fixture);
      database.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
      initializeServerBindingIssuerV1(database, trustedIssuer, {
        expectedIssuerKeyId: trustedIssuer.issuerKeyId,
      });
      const authorization = createAuthorization(database, 70);
      const pending = claimNewBinding(database, authorization);

      database.exec("DROP TRIGGER tr_server_binding_transition");
      database
        .prepare("UPDATE server_bindings SET statement_document_sha256 = ? WHERE binding_id = ?")
        .run("ff".repeat(32), pending.claim.basis.tuple.bindingId);
      database.close();

      await expect(
        DatabaseClient.create({
          databasePath,
          migrationsDirectory,
          serverBindingTrustedIssuer: trustedIssuer,
        }),
      ).rejects.toThrow(/durable Server binding state is invalid/iu);
    },
  );
});

function createTrustedIssuer(publicKeySpki: Uint8Array): ServerBindingTrustedIssuerDescriptorV1 {
  return {
    authoritySchemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
    issuer: SERVER_BINDING_AUTHORITY_ISSUER,
    receiptProfileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
    activeStatusProfileId: SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
    signatureAlgorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
    issuerKeyId: deriveServerBindingIssuerKeyIdV1(publicKeySpki),
    issuerPublicKeySpki: Uint8Array.from(publicKeySpki),
  };
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function openFixture(): Promise<Fixture> {
  const directory = await createTemporaryDirectory("agentic-review-binding-db-");
  const databasePath = join(directory, "state.sqlite");
  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
  runMigrations(database, migrationsDirectory);
  const fixture = { database, databasePath, directory };
  fixtures.push(fixture);
  return fixture;
}

async function openInitializedFixture(): Promise<Fixture> {
  const fixture = await openFixture();
  initializeServerBindingIssuerV1(fixture.database, trustedIssuer, {
    expectedIssuerKeyId: trustedIssuer.issuerKeyId,
  });
  return fixture;
}

function uuid(ordinal: number): string {
  return `00000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function authorizationInput(
  ordinal: number,
  overrides: Partial<CreateServerBindingAuthorizationV1Input> = {},
): CreateServerBindingAuthorizationV1Input {
  return {
    authorizationId: uuid(100 + ordinal),
    requestId: uuid(1_000 + ordinal),
    tokenSha256: sha256(`authorization-token-${ordinal}`),
    operatorIssuer: "https://identity.example.test",
    operatorSubject: `operator-${ordinal}`,
    workerNodeId: `worker:node-${ordinal}`,
    installationId: `worker.installation-${ordinal}`,
    enrollmentGeneration: 1,
    expectedCertificateDerSha256: sha256(`certificate-${ordinal}`),
    createdAt: "2026-09-03T00:00:00.000Z",
    expiresAt: "2099-09-03T00:00:00.000Z",
    ...overrides,
  };
}

function createAuthorization(
  database: DatabaseSync,
  ordinal: number,
  overrides: Partial<CreateServerBindingAuthorizationV1Input> = {},
): CreateServerBindingAuthorizationV1Input {
  const input = authorizationInput(ordinal, overrides);
  const result = createServerBindingAuthorizationV1(database, trustedIssuer, input);
  if (result.outcome !== "created") throw new Error("Expected a new authorization.");
  return input;
}

function claimAuthorization(
  database: DatabaseSync,
  authorization: CreateServerBindingAuthorizationV1Input,
): ClaimServerBindingAuthorizationV1Result {
  return claimServerBindingAuthorizationV1(database, trustedIssuer, {
    requestId: authorization.requestId,
    tokenSha256: authorization.tokenSha256,
    observedCertificateDerSha256: authorization.expectedCertificateDerSha256,
  });
}

function claimNewBinding(
  database: DatabaseSync,
  authorization: CreateServerBindingAuthorizationV1Input,
): PendingClaim {
  const result = claimAuthorization(database, authorization);
  if (result.outcome !== "signing_pending") throw new Error("Expected a pending binding claim.");
  return result;
}

function receiptJsonForClaim(claim: PendingClaim): string {
  const statement = JSON.parse(
    claim.claim.basis.statement.canonicalJson,
  ) as ServerBindingReceiptStatementV1;
  return receiptJsonForStatement(statement);
}

function distinctReceiptJsonForClaim(claim: PendingClaim, first: string): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = receiptJsonForClaim(claim);
    if (candidate !== first) return candidate;
  }
  throw new Error("The test signer did not produce a distinct valid ECDSA candidate.");
}

function receiptJsonForStatement(statement: ServerBindingReceiptStatementV1): string {
  const receipt: ServerBindingReceiptV1 = {
    algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
    issuer: SERVER_BINDING_AUTHORITY_ISSUER,
    issuerKeyId,
    profileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
    schemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
    signature: signLowS(serverBindingReceiptSigningPreimageV1(statement), testPrivateKey),
    statement,
  };
  return Buffer.from(marshalServerBindingReceiptV1(receipt)).toString("utf8");
}

function signLowS(preimage: Uint8Array, privateKey: KeyObject): string {
  const signature = nodeSign("sha256", preimage, {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  const r = readUnsignedBigEndian(signature.subarray(0, 32));
  let s = readUnsignedBigEndian(signature.subarray(32));
  if (s > p256HalfOrder) s = p256Order - s;
  const normalized = Buffer.alloc(64);
  writeUnsignedBigEndian(r, normalized.subarray(0, 32));
  writeUnsignedBigEndian(s, normalized.subarray(32));
  return normalized.toString("base64url");
}

function readUnsignedBigEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function writeUnsignedBigEndian(value: bigint, target: Uint8Array): void {
  let remaining = value;
  for (let index = target.byteLength - 1; index >= 0; index -= 1) {
    target[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new Error("Test scalar does not fit in 32 bytes.");
}

function commitReceipt(database: DatabaseSync, claim: PendingClaim, receiptJson: string): void {
  const result = commitServerBindingReceiptV1(database, trustedIssuer, {
    bindingId: claim.claim.basis.tuple.bindingId,
    issuanceRequestSha256: claim.claim.basis.request.requestSha256,
    receiptJson,
  });
  if (result.outcome !== "committed") throw new Error("Expected the first receipt commit.");
}

function recordConfirmation(
  claim: PendingClaim,
  recordDocumentSha256: string,
): ConfirmServerBindingRecordV1Input {
  const tuple = claim.claim.basis.tuple;
  return {
    bindingId: tuple.bindingId,
    bindingRevision: tuple.bindingRevision,
    workerNodeId: tuple.workerNodeId,
    installationId: tuple.installationId,
    enrollmentGeneration: tuple.enrollmentGeneration,
    certificateDerSha256: tuple.certificateDerSha256,
    recordDocumentSha256,
  };
}

function prepareBinding(
  database: DatabaseSync,
  ordinal: number,
  phase: NonterminalPhase,
): PreparedBinding {
  const authorization = createAuthorization(database, ordinal);
  const claim = claimNewBinding(database, authorization);
  if (phase === "signing_pending") {
    return { authorization, claim, receiptJson: null, recordDocumentSha256: null };
  }

  const receiptJson = receiptJsonForClaim(claim);
  commitReceipt(database, claim, receiptJson);
  if (phase === "reserved") {
    return { authorization, claim, receiptJson, recordDocumentSha256: null };
  }

  const recordDocumentSha256 = sha256(`record-${ordinal}`);
  const confirmation = confirmServerBindingRecordV1(
    database,
    trustedIssuer,
    recordConfirmation(claim, recordDocumentSha256),
  );
  if (confirmation.outcome !== "confirmed") throw new Error("Expected first activation.");
  return { authorization, claim, receiptJson, recordDocumentSha256 };
}

function expectPersistenceCode(
  operation: () => unknown,
  code: ServerBindingPersistenceErrorCodeV1,
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected Server binding persistence error ${code}.`);
}

interface DirectBindingFacts {
  readonly bindingId: string;
  readonly boundAt: string;
  readonly issuanceRequestSha256: string;
  readonly statementJson: string;
  readonly statementDocumentSha256: string;
  readonly receiptJson: string;
  readonly receiptSha256: string;
}

function directBindingFacts(
  authorization: CreateServerBindingAuthorizationV1Input,
  bindingId: string,
): DirectBindingFacts {
  const boundAt = "2026-09-03T00:00:01.000Z";
  const issuanceRequestSha256 = deriveServerBindingIssuanceRequestSha256V1({
    authorizationExpiresAt: authorization.expiresAt,
    authorizationId: authorization.authorizationId,
    enrollmentGeneration: authorization.enrollmentGeneration,
    expectedCertificateDerSha256: authorization.expectedCertificateDerSha256,
    installationId: authorization.installationId,
    issuerKeyId,
    observedCertificateDerSha256: authorization.expectedCertificateDerSha256,
    operatorIssuer: authorization.operatorIssuer,
    operatorSubject: authorization.operatorSubject,
    requestId: authorization.requestId,
    tokenSha256: authorization.tokenSha256,
    workerNodeId: authorization.workerNodeId,
  });
  const statement: ServerBindingReceiptStatementV1 = {
    bindingId,
    bindingRevision: 1,
    boundAt,
    certificateDerSha256: authorization.expectedCertificateDerSha256,
    enrollmentGeneration: 1,
    installationId: authorization.installationId,
    statementType: "durable-binding-created",
    workerNodeId: authorization.workerNodeId,
  };
  const statementJson = Buffer.from(marshalServerBindingReceiptStatementV1(statement)).toString(
    "utf8",
  );
  const receiptJson = receiptJsonForStatement(statement);
  return {
    bindingId,
    boundAt,
    issuanceRequestSha256,
    statementJson,
    statementDocumentSha256: sha256(statementJson),
    receiptJson,
    receiptSha256: sha256(receiptJson),
  };
}

function consumeAuthorizationDirect(
  database: DatabaseSync,
  authorization: CreateServerBindingAuthorizationV1Input,
  facts: DirectBindingFacts,
): void {
  database
    .prepare(`
      UPDATE server_binding_authorizations
      SET
        consumed_binding_id = ?,
        consumed_issuance_request_sha256 = ?,
        consumed_at = ?
      WHERE authorization_id = ?
    `)
    .run(
      facts.bindingId,
      facts.issuanceRequestSha256,
      facts.boundAt,
      authorization.authorizationId,
    );
}

function insertBindingDirect(
  database: DatabaseSync,
  authorization: CreateServerBindingAuthorizationV1Input,
  facts: DirectBindingFacts,
  candidate: Readonly<{
    phase: "reserved" | "active" | "revoked";
    receiptJson: string | null;
    receiptSha256: string | null;
    recordDocumentSha256: string | null;
  }>,
): void {
  database
    .prepare(`
      INSERT INTO server_bindings (
        binding_id,
        binding_revision,
        authorization_id,
        request_id,
        issuance_request_sha256,
        worker_node_id,
        installation_id,
        enrollment_generation,
        certificate_der_sha256,
        issuer_key_id,
        phase,
        bound_at,
        statement_json,
        statement_document_sha256,
        receipt_json,
        receipt_sha256,
        record_document_sha256
      ) VALUES (?, 1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      facts.bindingId,
      authorization.authorizationId,
      authorization.requestId,
      facts.issuanceRequestSha256,
      authorization.workerNodeId,
      authorization.installationId,
      authorization.expectedCertificateDerSha256,
      issuerKeyId,
      candidate.phase,
      facts.boundAt,
      facts.statementJson,
      facts.statementDocumentSha256,
      candidate.receiptJson,
      candidate.receiptSha256,
      candidate.recordDocumentSha256,
    );
}

function rollbackIfNeeded(database: DatabaseSync): void {
  if (database.isTransaction) database.exec("ROLLBACK");
}
