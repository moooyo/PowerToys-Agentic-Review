import { createHash, createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  deriveServerBindingIssuerKeyIdV1,
  marshalServerBindingReceiptStatementV1,
  marshalServerBindingReceiptV1,
  parseServerBindingReceiptV1,
  SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
  SERVER_BINDING_AUTHORITY_ISSUER,
  SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
  SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
  SERVER_BINDING_RECEIPT_PROFILE_ID,
  type ServerBindingReceiptStatementV1,
  serverBindingReceiptSigningPreimageV1,
  verifyServerBindingReceiptWithSpkiV1,
} from "@agentic-review/contracts/server-binding-authority-v1";
import { afterEach, describe, expect, it, vi } from "vitest";

const signerMaterialMock = vi.hoisted(() => ({
  provider: undefined as unknown,
  trustProfile: undefined as unknown,
}));

vi.mock("../../dist/enrollment/server-binding-signer-provider-v1.js", () => ({
  loadProductionServerBindingSignerProviderV1: async (): Promise<unknown> => {
    if (signerMaterialMock.provider === undefined) {
      throw new Error("The mocked production signer provider is unavailable.");
    }
    return signerMaterialMock.provider;
  },
}));

vi.mock("../../dist/enrollment/server-binding-trust-profile-v1.js", () => ({
  loadProductionServerBindingTrustProfileV1: async (): Promise<unknown> => {
    if (signerMaterialMock.trustProfile === undefined) {
      throw new Error("The mocked production trust profile is unavailable.");
    }
    return signerMaterialMock.trustProfile;
  },
}));

import type { DatabaseOperationMap } from "../../dist/database/protocol.js";
import { deriveServerBindingRevocationRequestSha256V1 } from "../../dist/database/server-binding-persistence-v1.js";
import {
  type CreateServerBindingAuthorizationRequestV1,
  createServerBindingTrustedIssuerDescriptorFromSignerV1,
  type IssueServerBindingReceiptRequestV1,
  isServerBindingPersistenceDatabaseOperation,
  registerServerBindingPersistenceDatabaseHandle,
  revokeServerBindingPersistenceDatabaseHandle,
  type ServerBindingAuthorityPortV1,
  ServerBindingCoordinatorV1,
  type ServerBindingPersistenceDatabaseHandle,
  type ServerBindingPersistenceDatabaseOperation,
} from "../../dist/enrollment/server-binding-coordinator-v1.js";
import {
  adoptServerBindingSignerV1,
  closeServerBindingSignerV1,
  loadServerBindingSignerV1,
  type ServerBindingSignerContextV1,
  signServerBindingReceiptStatementV1,
} from "../../dist/enrollment/server-binding-signer-v1.js";

const testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQggZDZZcSzKuD4h3Iu
rGCGLBlKcNoYbAjlNgwsgHcJ/iGhRANCAAT6/SVhOAT0FIVQ9/JY4HhWm2IM5fxA
F0qkH3Q//jWyVZNp7k5o+oDKezoZWbxoB46t9HT3+DoCEUaaBPUsIz+c
-----END PRIVATE KEY-----`;
const testPrivateKey = createPrivateKey(testPrivateKeyPem);
const issuerSpki = createPublicKey(testPrivateKey).export({ format: "der", type: "spki" });
const issuerKeyId = deriveServerBindingIssuerKeyIdV1(issuerSpki);
const timestamp = "2026-09-03T01:02:03.004Z";
const expiresAt = "2026-09-03T02:02:03.004Z";
const bindingId = "0f7d78fa-f002-4ede-9cd6-06951ee9b745";
const authorizationId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const requestId = "414e8391-7237-4d45-8a0f-d3af926b842b";
const certificateDerSha256 = "11".repeat(32);
const recordDocumentSha256 = "22".repeat(32);
const tokenSha256 = "33".repeat(32);
const issuanceRequestSha256 = "44".repeat(32);

type FakeDatabaseOwner = Parameters<typeof registerServerBindingPersistenceDatabaseHandle>[1];
type DatabaseHandler = (input: unknown) => unknown | Promise<unknown>;
type ClaimInput = DatabaseOperationMap["claimServerBindingAuthorizationV1"]["input"];
type PendingClaim = Extract<
  DatabaseOperationMap["claimServerBindingAuthorizationV1"]["output"],
  { readonly outcome: "signing_pending" }
>;

const defaultAuthorization =
  (): DatabaseOperationMap["createServerBindingAuthorizationV1"]["input"] => ({
    authorizationId,
    requestId,
    tokenSha256,
    operatorIssuer: "operator.example",
    operatorSubject: "operator:subject-1",
    workerNodeId: "worker:node-1",
    installationId: "worker.installation-1",
    enrollmentGeneration: 1,
    expectedCertificateDerSha256: certificateDerSha256,
    createdAt: timestamp,
    expiresAt,
  });

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const initializeResult = (): DatabaseOperationMap["initializeServerBindingIssuerV1"]["output"] => ({
  outcome: "initialized",
  issuer: {
    authoritySchemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
    issuer: SERVER_BINDING_AUTHORITY_ISSUER,
    receiptProfileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
    activeStatusProfileId: SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
    signatureAlgorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
    issuerKeyId,
    initializedAt: timestamp,
  },
});

const createPendingClaim = (
  input: ClaimInput,
  authorization = defaultAuthorization(),
): PendingClaim => {
  const statement: ServerBindingReceiptStatementV1 = {
    bindingId,
    bindingRevision: 1,
    boundAt: timestamp,
    certificateDerSha256: input.observedCertificateDerSha256,
    enrollmentGeneration: 1,
    installationId: authorization.installationId,
    statementType: "durable-binding-created",
    workerNodeId: authorization.workerNodeId,
  };
  const canonicalJson = Buffer.from(marshalServerBindingReceiptStatementV1(statement)).toString(
    "utf8",
  );
  return {
    outcome: "signing_pending",
    claim: {
      authorizationId: authorization.authorizationId,
      basis: {
        issuer: {
          algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
          issuer: SERVER_BINDING_AUTHORITY_ISSUER,
          issuerKeyId,
          profileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
        },
        request: {
          requestId: input.requestId,
          requestSha256: issuanceRequestSha256,
          tokenSha256: input.tokenSha256,
        },
        statement: {
          boundAt: timestamp,
          canonicalJson,
          sha256: sha256(canonicalJson),
        },
        tuple: {
          bindingId,
          bindingRevision: 1,
          certificateDerSha256: input.observedCertificateDerSha256,
          enrollmentGeneration: 1,
          installationId: authorization.installationId,
          workerNodeId: authorization.workerNodeId,
        },
      },
    },
  };
};

class FakeDatabase implements FakeDatabaseOwner {
  readonly terminal = Promise.withResolvers<Error>();
  readonly terminalFailure = this.terminal.promise;
  readonly requests: Array<{
    readonly operation: ServerBindingPersistenceDatabaseOperation;
    readonly input: unknown;
  }> = [];
  readonly handlers = new Map<ServerBindingPersistenceDatabaseOperation, DatabaseHandler>();
  authorization: DatabaseOperationMap["createServerBindingAuthorizationV1"]["input"] =
    defaultAuthorization();

  async request<TOperation extends ServerBindingPersistenceDatabaseOperation>(
    operation: TOperation,
    input: DatabaseOperationMap[TOperation]["input"],
  ): Promise<DatabaseOperationMap[TOperation]["output"]> {
    this.requests.push({ operation, input });
    const handler = this.handlers.get(operation);
    if (handler !== undefined) {
      return (await handler(input)) as DatabaseOperationMap[TOperation]["output"];
    }

    let output: unknown;
    switch (operation) {
      case "initializeServerBindingIssuerV1":
        output = initializeResult();
        break;
      case "createServerBindingAuthorizationV1": {
        const authorization =
          input as DatabaseOperationMap["createServerBindingAuthorizationV1"]["input"];
        this.authorization = authorization;
        output = {
          outcome: "created",
          authorization: {
            ...authorization,
            issuerKeyId,
            consumption: null,
          },
        };
        break;
      }
      case "claimServerBindingAuthorizationV1":
        output = createPendingClaim(
          input as DatabaseOperationMap["claimServerBindingAuthorizationV1"]["input"],
          this.authorization,
        );
        break;
      case "commitServerBindingReceiptV1": {
        const commit = input as DatabaseOperationMap["commitServerBindingReceiptV1"]["input"];
        output = {
          outcome: "committed",
          retainedPhase: "reserved",
          receipt: {
            canonicalJson: commit.receiptJson,
            receiptSha256: sha256(commit.receiptJson),
          },
        };
        break;
      }
      case "confirmServerBindingRecordV1": {
        const confirmation = input as DatabaseOperationMap["confirmServerBindingRecordV1"]["input"];
        output = {
          outcome: "confirmed",
          bindingId: confirmation.bindingId,
          recordDocumentSha256: confirmation.recordDocumentSha256,
        };
        break;
      }
      case "readServerBindingRecoveryReceiptV1":
      case "readServerBindingActiveSnapshotV1":
        output = null;
        break;
      case "recheckServerBindingActiveSnapshotV1":
        output = input;
        break;
      case "revokeServerBindingV1": {
        const revocation = input as DatabaseOperationMap["revokeServerBindingV1"]["input"];
        output = {
          outcome: "revoked",
          revocationId: revocation.revocationId,
          revocationRequestSha256: deriveServerBindingRevocationRequestSha256V1(revocation),
          bindingId: revocation.bindingId,
          priorPhase: "active",
          reasonCode: revocation.reasonCode,
          revokedAt: timestamp,
        };
        break;
      }
      default:
        throw new Error(`Unexpected database operation ${operation}.`);
    }
    return output as DatabaseOperationMap[TOperation]["output"];
  }
}

const attachDatabase = (database: FakeDatabase): ServerBindingPersistenceDatabaseHandle =>
  registerServerBindingPersistenceDatabaseHandle(database, database);

const createCoordinator = (
  database: FakeDatabase,
  signer?: Readonly<ServerBindingSignerContextV1>,
  timeoutOptions: Readonly<{
    readonly operationTimeoutMilliseconds?: number;
    readonly closeTimeoutMilliseconds?: number;
  }> = {},
): ServerBindingCoordinatorV1 =>
  new ServerBindingCoordinatorV1(
    signer === undefined
      ? { database: attachDatabase(database), ...timeoutOptions }
      : { database: attachDatabase(database), signer, ...timeoutOptions },
  );

const requireAuthority = (
  coordinator: ServerBindingCoordinatorV1,
): ServerBindingAuthorityPortV1 => {
  const authority = coordinator.authority;
  if (authority === null) throw new Error("Expected the coordinator authority to be ready.");
  return authority;
};

const databaseOperations = (
  database: FakeDatabase,
): readonly ServerBindingPersistenceDatabaseOperation[] =>
  database.requests.map(({ operation }) => operation);

const validIssueRequest = (
  authorizationToken = Buffer.alloc(32, 0xa5).toString("base64url"),
): IssueServerBindingReceiptRequestV1 => ({
  requestId,
  authorizationToken,
  observedCertificateDerSha256: certificateDerSha256,
});

const loadTestSigner = async (
  signPreimageSha256: (preimage: Uint8Array) => Promise<unknown> | unknown = (preimage) =>
    nodeSign("sha256", preimage, {
      dsaEncoding: "ieee-p1363",
      key: testPrivateKey,
    }),
  close: () => Promise<void> = async () => undefined,
): Promise<Readonly<ServerBindingSignerContextV1>> => {
  if (signerMaterialMock.provider !== undefined || signerMaterialMock.trustProfile !== undefined) {
    throw new Error("A signer material mock is already active.");
  }
  signerMaterialMock.provider = Object.freeze({
    close,
    kind: "preimage-sha256" as const,
    issuerPublicKeySpki: Uint8Array.from(issuerSpki),
    signPreimageSha256: async (preimage: Uint8Array) => signPreimageSha256(preimage),
  });
  signerMaterialMock.trustProfile = Object.freeze({
    compiledTrustedIssuerPublicKeySpki: Uint8Array.from(issuerSpki),
  });
  try {
    return await loadServerBindingSignerV1();
  } finally {
    signerMaterialMock.provider = undefined;
    signerMaterialMock.trustProfile = undefined;
  }
};

const signedReceiptForClaim = async (
  signer: Readonly<ServerBindingSignerContextV1>,
  claim: PendingClaim,
): Promise<string> => {
  const statementJson = claim.claim.basis.statement.canonicalJson;
  const signature = await signServerBindingReceiptStatementV1(
    signer,
    Buffer.from(statementJson, "utf8"),
  );
  const statement = JSON.parse(statementJson) as ServerBindingReceiptStatementV1;
  return Buffer.from(
    marshalServerBindingReceiptV1({
      algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
      issuer: SERVER_BINDING_AUTHORITY_ISSUER,
      issuerKeyId,
      profileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
      schemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
      signature,
      statement,
    }),
  ).toString("utf8");
};

const codedDatabaseError = (code: string): Error & { readonly code: string } =>
  Object.assign(new Error(`Private database detail for ${code}.`), { code });

afterEach(() => {
  signerMaterialMock.provider = undefined;
  signerMaterialMock.trustProfile = undefined;
  vi.useRealTimers();
});

describe("Server binding coordinator v1", () => {
  it("keeps database handles opaque, single-consumer, forge-resistant, and revocable", async () => {
    const knownOperations: readonly ServerBindingPersistenceDatabaseOperation[] = [
      "claimServerBindingAuthorizationV1",
      "commitServerBindingReceiptV1",
      "confirmServerBindingRecordV1",
      "createServerBindingAuthorizationV1",
      "initializeServerBindingIssuerV1",
      "readServerBindingActiveSnapshotV1",
      "readServerBindingRecoveryReceiptV1",
      "recheckServerBindingActiveSnapshotV1",
      "revokeServerBindingV1",
    ];
    expect(knownOperations.every(isServerBindingPersistenceDatabaseOperation)).toBe(true);
    expect(isServerBindingPersistenceDatabaseOperation("shutdown")).toBe(false);

    const revokedHandle = attachDatabase(new FakeDatabase());
    expect(Reflect.ownKeys(revokedHandle)).toEqual([]);
    expect(Reflect.getPrototypeOf(revokedHandle)).toBeNull();
    expect(Object.isFrozen(revokedHandle)).toBe(true);
    expect(revokeServerBindingPersistenceDatabaseHandle(revokedHandle)).toBe(true);
    expect(revokeServerBindingPersistenceDatabaseHandle(revokedHandle)).toBe(false);
    expect(() => new ServerBindingCoordinatorV1({ database: revokedHandle })).toThrow(
      /consumed or forged/u,
    );

    const consumedHandle = attachDatabase(new FakeDatabase());
    const coordinator = new ServerBindingCoordinatorV1({ database: consumedHandle });
    expect(() => new ServerBindingCoordinatorV1({ database: consumedHandle })).toThrow(
      /consumed or forged/u,
    );
    expect(
      () =>
        new ServerBindingCoordinatorV1({
          database: Object.freeze(Object.create(null)) as ServerBindingPersistenceDatabaseHandle,
        }),
    ).toThrow(/consumed or forged/u);
    await coordinator.close();
  });

  it("preserves the database handle when the signer cannot be adopted", async () => {
    const signer = await loadTestSigner();
    const signerOwner = {};
    adoptServerBindingSignerV1(signer, signerOwner);
    const handle = attachDatabase(new FakeDatabase());

    expect(() => new ServerBindingCoordinatorV1({ database: handle, signer })).toThrowError(
      expect.objectContaining({ code: "SIGNER_UNAVAILABLE" }),
    );

    const coordinator = new ServerBindingCoordinatorV1({ database: handle });
    await coordinator.close();
    await closeServerBindingSignerV1(signer, signerOwner);
  });

  it("opens without signer authority and keeps open single-use", async () => {
    const database = new FakeDatabase();
    const coordinator = createCoordinator(database);

    expect(coordinator.state).toBe("new");
    expect(coordinator.authority).toBeNull();
    await coordinator.open();
    expect(coordinator.state).toBe("ready");
    expect(coordinator.authority).toBeNull();
    expect(database.requests).toEqual([]);
    await expect(coordinator.open()).rejects.toMatchObject({
      code: "NOT_READY",
      message: "The binding coordinator open operation is single-use.",
    });
    await coordinator.close();
    expect(coordinator.state).toBe("closed");
  });

  it("initializes the signer and preserves the create-to-issue persistence sequence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(timestamp));
    const signedPreimages: Buffer[] = [];
    const signer = await loadTestSigner((preimage) => {
      signedPreimages.push(Buffer.from(preimage));
      return nodeSign("sha256", preimage, {
        dsaEncoding: "ieee-p1363",
        key: testPrivateKey,
      });
    });
    const descriptor = createServerBindingTrustedIssuerDescriptorFromSignerV1(signer);
    expect(descriptor).toMatchObject({
      authoritySchemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
      issuer: SERVER_BINDING_AUTHORITY_ISSUER,
      receiptProfileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
      activeStatusProfileId: SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
      signatureAlgorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
      issuerKeyId,
    });
    expect(Buffer.from(descriptor.issuerPublicKeySpki)).toEqual(issuerSpki);
    expect(Object.isFrozen(descriptor)).toBe(true);

    const database = new FakeDatabase();
    const coordinator = createCoordinator(database, signer);
    await coordinator.open();
    const authority = requireAuthority(coordinator);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(database.requests).toEqual([
      {
        operation: "initializeServerBindingIssuerV1",
        input: { expectedIssuerKeyId: issuerKeyId },
      },
    ]);

    const createRequest: CreateServerBindingAuthorizationRequestV1 = {
      operatorIssuer: "operator.example",
      operatorSubject: "operator:subject-1",
      workerNodeId: "worker:node-1",
      installationId: "worker.installation-1",
      expectedCertificateDerSha256: certificateDerSha256,
      expiresAt,
    };
    const created = await authority.createAuthorization(createRequest);
    expect(Object.isFrozen(created)).toBe(true);
    expect(created.authorizationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(created.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(created.authorizationToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const expectedTokenSha256 = sha256(Buffer.from(created.authorizationToken, "base64url"));
    expect(database.requests[1]).toEqual({
      operation: "createServerBindingAuthorizationV1",
      input: {
        authorizationId: created.authorizationId,
        requestId: created.requestId,
        tokenSha256: expectedTokenSha256,
        operatorIssuer: createRequest.operatorIssuer,
        operatorSubject: createRequest.operatorSubject,
        workerNodeId: createRequest.workerNodeId,
        installationId: createRequest.installationId,
        enrollmentGeneration: 1,
        expectedCertificateDerSha256: createRequest.expectedCertificateDerSha256,
        createdAt: timestamp,
        expiresAt,
      },
    });

    const issued = await authority.issueReceipt({
      requestId: created.requestId,
      authorizationToken: created.authorizationToken,
      observedCertificateDerSha256: certificateDerSha256,
    });
    expect(Object.isFrozen(issued)).toBe(true);
    expect(databaseOperations(database)).toEqual([
      "initializeServerBindingIssuerV1",
      "createServerBindingAuthorizationV1",
      "claimServerBindingAuthorizationV1",
      "commitServerBindingReceiptV1",
    ]);
    expect(database.requests[2]).toEqual({
      operation: "claimServerBindingAuthorizationV1",
      input: {
        requestId: created.requestId,
        tokenSha256: expectedTokenSha256,
        observedCertificateDerSha256: certificateDerSha256,
      },
    });
    expect(database.requests[3]).toMatchObject({
      operation: "commitServerBindingReceiptV1",
      input: {
        bindingId,
        issuanceRequestSha256,
        receiptJson: issued.receiptJson,
      },
    });
    expect(issued).toMatchObject({
      bindingId,
      phase: "reserved",
      receiptSha256: sha256(issued.receiptJson),
    });

    const parsedReceipt = parseServerBindingReceiptV1(Buffer.from(issued.receiptJson, "utf8"));
    expect(parsedReceipt.statement).toEqual({
      bindingId,
      bindingRevision: 1,
      boundAt: timestamp,
      certificateDerSha256,
      enrollmentGeneration: 1,
      installationId: createRequest.installationId,
      statementType: "durable-binding-created",
      workerNodeId: createRequest.workerNodeId,
    });
    expect(signedPreimages).toEqual([
      Buffer.from(serverBindingReceiptSigningPreimageV1(parsedReceipt.statement)),
    ]);
    expect(
      verifyServerBindingReceiptWithSpkiV1(Buffer.from(issued.receiptJson, "utf8"), issuerSpki),
    ).toMatchObject({ issuerKeyId, signatureValid: true });
    await coordinator.close();
  });

  it("returns retained receipt bytes without signing or committing a replay", async () => {
    let signCalls = 0;
    const signer = await loadTestSigner((preimage) => {
      signCalls += 1;
      return nodeSign("sha256", preimage, {
        dsaEncoding: "ieee-p1363",
        key: testPrivateKey,
      });
    });
    const database = new FakeDatabase();
    const replayClaim = createPendingClaim({
      requestId,
      tokenSha256: sha256(Buffer.from(validIssueRequest().authorizationToken, "base64url")),
      observedCertificateDerSha256: certificateDerSha256,
    });
    const replayReceiptJson = await signedReceiptForClaim(signer, replayClaim);
    signCalls = 0;
    const replayReceiptSha256 = sha256(replayReceiptJson);
    database.handlers.set("claimServerBindingAuthorizationV1", (_input) => {
      return {
        outcome: "receipt_replay",
        retainedPhase: "active",
        claim: replayClaim.claim,
        receipt: {
          canonicalJson: replayReceiptJson,
          receiptSha256: replayReceiptSha256,
        },
      };
    });
    const coordinator = createCoordinator(database, signer);
    await coordinator.open();

    const issue = validIssueRequest();
    await expect(requireAuthority(coordinator).issueReceipt(issue)).resolves.toEqual({
      bindingId,
      phase: "active",
      receiptJson: replayReceiptJson,
      receiptSha256: replayReceiptSha256,
    });
    expect(signCalls).toBe(0);
    expect(databaseOperations(database)).toEqual([
      "initializeServerBindingIssuerV1",
      "claimServerBindingAuthorizationV1",
    ]);
    expect(database.requests[1]).toEqual({
      operation: "claimServerBindingAuthorizationV1",
      input: {
        requestId: issue.requestId,
        tokenSha256: sha256(Buffer.from(issue.authorizationToken, "base64url")),
        observedCertificateDerSha256: issue.observedCertificateDerSha256,
      },
    });
    await coordinator.close();
  });

  it("rejects noncanonical authorization tokens before persistence", async () => {
    const signer = await loadTestSigner();
    const database = new FakeDatabase();
    const coordinator = createCoordinator(database, signer);
    await coordinator.open();

    await expect(
      requireAuthority(coordinator).issueReceipt(validIssueRequest("not-base64url")),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "The binding authorization token is invalid.",
    });
    expect(databaseOperations(database)).toEqual(["initializeServerBindingIssuerV1"]);
    await coordinator.close();
  });

  it("rejects extra authority input fields without evaluating them", async () => {
    const signer = await loadTestSigner();
    const database = new FakeDatabase();
    const coordinator = createCoordinator(database, signer);
    await coordinator.open();
    let getterCalls = 0;
    const input = { ...validIssueRequest() } as IssueServerBindingReceiptRequestV1 & {
      secret?: unknown;
    };
    Object.defineProperty(input, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return Buffer.alloc(1_000_000);
      },
    });

    await expect(requireAuthority(coordinator).issueReceipt(input)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(getterCalls).toBe(0);
    expect(databaseOperations(database)).toEqual(["initializeServerBindingIssuerV1"]);
    await coordinator.close();
  });

  it("maps persistence errors to stable coordinator errors", async () => {
    const cases = [
      [
        "SERVER_BINDING_AUTHORIZATION_EXPIRED",
        "AUTHORIZATION_EXPIRED",
        "The binding authorization expired.",
        false,
      ],
      [
        "SERVER_BINDING_IMMUTABLE_CONFLICT",
        "IMMUTABLE_CONFLICT",
        "The binding request conflicts.",
        false,
      ],
      ["SERVER_BINDING_INVALID_INPUT", "INVALID_INPUT", "The binding request is invalid.", false],
      [
        "SERVER_BINDING_SIGNER_MISMATCH",
        "SIGNER_MISMATCH",
        "The binding issuer does not match.",
        true,
      ],
      [
        "SERVER_BINDING_SIGNER_UNAVAILABLE",
        "SIGNER_UNAVAILABLE",
        "The binding signer is unavailable.",
        false,
      ],
      [
        "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE",
        "STORAGE_INTEGRITY_FAILURE",
        "The durable binding state is invalid.",
        true,
      ],
      [
        "SERVER_BINDING_TERMINAL_REVOKED",
        "TERMINAL_REVOKED",
        "The binding is permanently revoked.",
        false,
      ],
      [
        "SERVER_BINDING_TRANSITION_INVALID",
        "TRANSITION_INVALID",
        "The binding transition is invalid.",
        false,
      ],
      [
        "SERVER_BINDING_PERSISTENCE_UNAVAILABLE",
        "PERSISTENCE_OUTCOME_UNKNOWN",
        "The binding persistence outcome is unknown.",
        true,
      ],
      [
        "UNRECOGNIZED_DATABASE_FAILURE",
        "PERSISTENCE_OUTCOME_UNKNOWN",
        "The binding persistence outcome is unknown.",
        true,
      ],
    ] as const;
    for (const [databaseCode, coordinatorCode, message, terminal] of cases) {
      const signer = await loadTestSigner();
      const database = new FakeDatabase();
      const coordinator = createCoordinator(database, signer);
      await coordinator.open();
      const authority = requireAuthority(coordinator);
      const error = codedDatabaseError(databaseCode);
      database.handlers.set("readServerBindingRecoveryReceiptV1", () => Promise.reject(error));
      const observed = await authority
        .readRecoveryReceipt({ certificateDerSha256 })
        .catch((failure: unknown) => failure);
      expect(observed).toMatchObject({
        name: "ServerBindingCoordinatorErrorV1",
        code: coordinatorCode,
        message,
      });
      expect((observed as Error).cause).toBe(error);
      expect(coordinator.state).toBe(terminal ? "failed" : "ready");
      if (terminal) {
        await expect(coordinator.close()).rejects.toBe(observed);
      } else {
        await coordinator.close();
      }
    }
  });

  it.each([
    {
      name: "invalid committed statement",
      expectedCode: "STORAGE_INTEGRITY_FAILURE",
      expectedMessage: "The Server binding statement basis is invalid.",
      terminal: true,
      createSigner: () => loadTestSigner(),
      configureDatabase: (database: FakeDatabase) => {
        database.handlers.set("claimServerBindingAuthorizationV1", (input) => {
          const pending = createPendingClaim(input as ClaimInput);
          return {
            ...pending,
            claim: {
              ...pending.claim,
              basis: {
                ...pending.claim.basis,
                statement: {
                  ...pending.claim.basis.statement,
                  canonicalJson: "{}",
                },
              },
            },
          };
        });
      },
    },
    {
      name: "invalid provider signature",
      expectedCode: "SIGNER_MISMATCH",
      expectedMessage: "The binding signature did not verify.",
      terminal: true,
      createSigner: () => loadTestSigner(() => Buffer.alloc(64)),
    },
    {
      name: "provider operation failure",
      expectedCode: "SIGNER_UNAVAILABLE",
      expectedMessage: "The binding signer is unavailable.",
      terminal: false,
      createSigner: () =>
        loadTestSigner(() => {
          throw new Error("Private signer provider detail.");
        }),
    },
  ])("maps $name through the signer boundary", async (testCase) => {
    const signer = await testCase.createSigner();
    const database = new FakeDatabase();
    testCase.configureDatabase?.(database);
    const coordinator = createCoordinator(database, signer);
    await coordinator.open();

    const observed = await requireAuthority(coordinator)
      .issueReceipt(validIssueRequest())
      .catch((error: unknown) => error);
    expect(observed).toMatchObject({
      name: "ServerBindingCoordinatorErrorV1",
      code: testCase.expectedCode,
      message: testCase.expectedMessage,
    });
    expect(databaseOperations(database)).not.toContain("commitServerBindingReceiptV1");
    expect(coordinator.state).toBe(testCase.terminal ? "failed" : "ready");
    if (testCase.terminal) {
      await expect(coordinator.close()).rejects.toBe(observed);
    } else {
      await coordinator.close();
    }
  });

  it("rejects a forged signer context before consuming the database handle", () => {
    const forged = Object.freeze({
      issuerKeyId,
      issuerPublicKeySpki: Uint8Array.from(issuerSpki),
    }) as Readonly<ServerBindingSignerContextV1>;
    const database = new FakeDatabase();

    expect(() => createCoordinator(database, forged)).toThrowError(
      expect.objectContaining({
        name: "ServerBindingCoordinatorErrorV1",
        code: "SIGNER_MISMATCH",
      }),
    );

    expect(() => createCoordinator(database)).not.toThrow();
  });

  it("reads the signer option once before adopting its single owner", async () => {
    const signer = await loadTestSigner();
    const database = new FakeDatabase();
    let signerReads = 0;
    const options = { database: attachDatabase(database) } as {
      database: ServerBindingPersistenceDatabaseHandle;
      signer?: Readonly<ServerBindingSignerContextV1>;
    };
    Object.defineProperty(options, "signer", {
      enumerable: true,
      get() {
        signerReads += 1;
        if (signerReads !== 1) throw new Error("signer was read more than once");
        return signer;
      },
    });

    const coordinator = new ServerBindingCoordinatorV1(options);
    expect(signerReads).toBe(1);
    await coordinator.open();
    await coordinator.close();
  });

  it("fail-stops on database terminal failure and reuses the terminal close result", async () => {
    const signer = await loadTestSigner();
    const database = new FakeDatabase();
    const coordinator = createCoordinator(database, signer);
    await coordinator.open();
    const authority = requireAuthority(coordinator);
    const terminalFailure = new Error("Private database terminal detail.");

    database.terminal.resolve(terminalFailure);
    await Promise.resolve();
    expect(coordinator.state).toBe("failed");
    expect(coordinator.authority).toBeNull();
    const observed = await authority
      .readRecoveryReceipt({ certificateDerSha256 })
      .catch((failure: unknown) => failure);
    expect(observed).toMatchObject({
      name: "ServerBindingCoordinatorErrorV1",
      code: "PERSISTENCE_OUTCOME_UNKNOWN",
      message: "The binding coordinator entered a terminal failure.",
    });
    expect((observed as Error).cause).toBe(terminalFailure);
    expect(databaseOperations(database)).toEqual(["initializeServerBindingIssuerV1"]);

    const closing = coordinator.close();
    expect(coordinator.close()).toBe(closing);
    await expect(closing).rejects.toBe(observed);
    expect(coordinator.state).toBe("failed");
  });

  it("returns the first terminal cause when an in-flight signer later fails", async () => {
    const signing = Promise.withResolvers<unknown>();
    const signer = await loadTestSigner(() => signing.promise);
    const database = new FakeDatabase();
    const coordinator = createCoordinator(database, signer);
    await coordinator.open();
    const operation = requireAuthority(coordinator)
      .issueReceipt(validIssueRequest())
      .catch((error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();

    const databaseFailure = new Error("Private database terminal detail.");
    database.terminal.resolve(databaseFailure);
    await Promise.resolve();
    await Promise.resolve();
    signing.reject(new Error("Late private signer failure."));

    const observed = await operation;
    expect(observed).toMatchObject({
      code: "PERSISTENCE_OUTCOME_UNKNOWN",
      message: "The binding coordinator entered a terminal failure.",
      cause: databaseFailure,
    });
    await expect(coordinator.close()).rejects.toBe(observed);
  });

  it("rejects every pending wrapper immediately while retaining raw settlement ownership", async () => {
    const signer = await loadTestSigner();
    const database = new FakeDatabase();
    const firstRaw =
      Promise.withResolvers<DatabaseOperationMap["readServerBindingRecoveryReceiptV1"]["output"]>();
    const secondRaw =
      Promise.withResolvers<DatabaseOperationMap["readServerBindingRecoveryReceiptV1"]["output"]>();
    let requestIndex = 0;
    database.handlers.set("readServerBindingRecoveryReceiptV1", () => {
      requestIndex += 1;
      return requestIndex === 1 ? firstRaw.promise : secondRaw.promise;
    });
    const coordinator = createCoordinator(database, signer);
    await coordinator.open();
    const authority = requireAuthority(coordinator);
    const first = authority
      .readRecoveryReceipt({ certificateDerSha256 })
      .catch((error: unknown) => error);
    const second = authority
      .readRecoveryReceipt({ certificateDerSha256 })
      .catch((error: unknown) => error);
    await Promise.resolve();

    const databaseFailure = new Error("Private database terminal detail.");
    database.terminal.resolve(databaseFailure);
    const [firstObserved, secondObserved] = await Promise.all([first, second]);
    expect(firstObserved).toBe(secondObserved);
    expect(firstObserved).toMatchObject({
      code: "PERSISTENCE_OUTCOME_UNKNOWN",
      cause: databaseFailure,
    });

    let closeSettled = false;
    const closing = coordinator.close().catch((error: unknown) => error);
    void closing.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    firstRaw.resolve(null);
    secondRaw.resolve(null);
    await expect(closing).resolves.toBe(firstObserved);
  });

  it("closes before open without touching persistence and keeps close idempotent", async () => {
    const database = new FakeDatabase();
    const coordinator = createCoordinator(database);

    const closing = coordinator.close();
    expect(coordinator.close()).toBe(closing);
    await closing;
    expect(coordinator.state).toBe("closed");
    expect(coordinator.authority).toBeNull();
    expect(database.requests).toEqual([]);
    await expect(coordinator.open()).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("normalizes a signer failure while closing before open and enters failed", async () => {
    const signer = await loadTestSigner(undefined, async () => {
      throw new Error("Private provider close detail.");
    });
    const coordinator = createCoordinator(new FakeDatabase(), signer);

    const observed = await coordinator.close().catch((error: unknown) => error);

    expect(observed).toMatchObject({
      name: "ServerBindingCoordinatorErrorV1",
      code: "PERSISTENCE_OUTCOME_UNKNOWN",
      message: "The binding coordinator failed.",
    });
    expect(coordinator.state).toBe("failed");
    await expect(coordinator.open()).rejects.toBe(observed);
  });

  it("lets an in-flight open settle before completing close without publishing authority", async () => {
    const signer = await loadTestSigner();
    const database = new FakeDatabase();
    const initialization =
      Promise.withResolvers<DatabaseOperationMap["initializeServerBindingIssuerV1"]["output"]>();
    database.handlers.set("initializeServerBindingIssuerV1", () => initialization.promise);
    const coordinator = createCoordinator(database, signer);

    const opening = coordinator.open();
    expect(coordinator.state).toBe("opening");
    const closing = coordinator.close();
    expect(coordinator.state).toBe("closing");
    await expect(coordinator.open()).rejects.toMatchObject({ code: "CLOSED" });
    expect(coordinator.close()).toBe(closing);
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    initialization.resolve(initializeResult());
    await opening;
    await closing;
    expect(closeSettled).toBe(true);
    expect(coordinator.state).toBe("closed");
    expect(coordinator.authority).toBeNull();
    expect(databaseOperations(database)).toEqual(["initializeServerBindingIssuerV1"]);
  });

  it("fail-stops when the persistence open deadline expires", async () => {
    vi.useFakeTimers();
    const signer = await loadTestSigner();
    const database = new FakeDatabase();
    const initialization =
      Promise.withResolvers<DatabaseOperationMap["initializeServerBindingIssuerV1"]["output"]>();
    database.handlers.set("initializeServerBindingIssuerV1", () => initialization.promise);
    const coordinator = createCoordinator(database, signer, {
      operationTimeoutMilliseconds: 10,
      closeTimeoutMilliseconds: 20,
    });

    const observedPromise = coordinator.open().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    const observed = await observedPromise;
    expect(observed).toMatchObject({
      code: "PERSISTENCE_OUTCOME_UNKNOWN",
      message: "The binding coordinator open deadline expired.",
    });
    expect(coordinator.state).toBe("failed");
    expect(coordinator.authority).toBeNull();
    let closeSettled = false;
    const closing = coordinator.close().catch((error: unknown) => error);
    void closing.then(() => {
      closeSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closeSettled).toBe(false);

    initialization.resolve(initializeResult());
    await vi.advanceTimersByTimeAsync(0);
    await expect(closing).resolves.toBe(observed);
  });

  it("does not commit after a signer operation exceeds its deadline", async () => {
    vi.useFakeTimers();
    const signing = Promise.withResolvers<unknown>();
    let signingPreimage: Buffer | undefined;
    const signer = await loadTestSigner((preimage) => {
      signingPreimage = Buffer.from(preimage);
      return signing.promise;
    });
    const database = new FakeDatabase();
    const coordinator = createCoordinator(database, signer, {
      operationTimeoutMilliseconds: 10,
      closeTimeoutMilliseconds: 20,
    });
    await coordinator.open();

    const operationPromise = requireAuthority(coordinator)
      .issueReceipt(validIssueRequest())
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(signingPreimage).toBeDefined();
    await vi.advanceTimersByTimeAsync(10);
    const observed = await operationPromise;
    expect(observed).toMatchObject({
      code: "PERSISTENCE_OUTCOME_UNKNOWN",
      message: "The binding persistence operation deadline expired.",
    });
    expect(coordinator.state).toBe("failed");
    expect(databaseOperations(database)).not.toContain("commitServerBindingReceiptV1");

    if (signingPreimage === undefined) throw new Error("Expected a captured signing preimage.");
    signing.resolve(
      nodeSign("sha256", signingPreimage, {
        dsaEncoding: "ieee-p1363",
        key: testPrivateKey,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(databaseOperations(database)).not.toContain("commitServerBindingReceiptV1");
    await expect(coordinator.close()).rejects.toBe(observed);
  });

  it("bounds close while an admitted persistence operation is unsettled", async () => {
    vi.useFakeTimers();
    const signer = await loadTestSigner();
    const database = new FakeDatabase();
    const activeRead =
      Promise.withResolvers<DatabaseOperationMap["readServerBindingRecoveryReceiptV1"]["output"]>();
    database.handlers.set("readServerBindingRecoveryReceiptV1", () => activeRead.promise);
    const coordinator = createCoordinator(database, signer, {
      operationTimeoutMilliseconds: 100,
      closeTimeoutMilliseconds: 10,
    });
    await coordinator.open();
    const operationPromise = requireAuthority(coordinator)
      .readRecoveryReceipt({ certificateDerSha256 })
      .catch((error: unknown) => error);

    const closePromise = coordinator.close().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    const closeError = await closePromise;
    expect(closeError).toMatchObject({
      code: "PERSISTENCE_OUTCOME_UNKNOWN",
      message: "The binding coordinator close deadline expired.",
    });
    expect(coordinator.state).toBe("failed");

    activeRead.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    await expect(operationPromise).resolves.toBe(closeError);
  });

  it("drains active authority operations before close and rejects new work", async () => {
    const signer = await loadTestSigner();
    const database = new FakeDatabase();
    const coordinator = createCoordinator(database, signer);
    await coordinator.open();
    const authority = requireAuthority(coordinator);
    const recoveryClaim = createPendingClaim({
      requestId,
      tokenSha256,
      observedCertificateDerSha256: certificateDerSha256,
    });
    const recoveryReceiptJson = await signedReceiptForClaim(signer, recoveryClaim);
    const recovery = {
      bindingId,
      bindingRevision: 1 as const,
      phase: "reserved" as const,
      receiptJson: recoveryReceiptJson,
      receiptSha256: sha256(recoveryReceiptJson),
    };
    const activeRead =
      Promise.withResolvers<DatabaseOperationMap["readServerBindingRecoveryReceiptV1"]["output"]>();
    database.handlers.set("readServerBindingRecoveryReceiptV1", () => activeRead.promise);

    const operation = authority.readRecoveryReceipt({ certificateDerSha256 });
    const closing = coordinator.close();
    expect(coordinator.state).toBe("closing");
    expect(coordinator.authority).toBeNull();
    expect(coordinator.close()).toBe(closing);
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(databaseOperations(database)).toEqual([
      "initializeServerBindingIssuerV1",
      "readServerBindingRecoveryReceiptV1",
    ]);
    await expect(authority.readRecoveryReceipt({ certificateDerSha256 })).rejects.toMatchObject({
      code: "CLOSED",
      message: "The binding coordinator is closed.",
    });
    expect(databaseOperations(database)).toEqual([
      "initializeServerBindingIssuerV1",
      "readServerBindingRecoveryReceiptV1",
    ]);

    activeRead.resolve(recovery);
    await expect(operation).resolves.toEqual(recovery);
    await closing;
    expect(closeSettled).toBe(true);
    expect(coordinator.state).toBe("closed");
    await expect(authority.readRecoveryReceipt({ certificateDerSha256 })).rejects.toMatchObject({
      code: "CLOSED",
    });
  });

  it("routes the remaining authority operations without changing their inputs", async () => {
    const signer = await loadTestSigner();
    const database = new FakeDatabase();
    const coordinator = createCoordinator(database, signer);
    await coordinator.open();
    const authority = requireAuthority(coordinator);
    const confirmation: DatabaseOperationMap["confirmServerBindingRecordV1"]["input"] = {
      bindingId,
      bindingRevision: 1,
      workerNodeId: "worker:node-1",
      installationId: "worker.installation-1",
      enrollmentGeneration: 1,
      certificateDerSha256,
      recordDocumentSha256,
    };
    const activeSnapshot: DatabaseOperationMap["recheckServerBindingActiveSnapshotV1"]["input"] = {
      bindingId,
      bindingRevision: 1,
      workerNodeId: "worker:node-1",
      installationId: "worker.installation-1",
      enrollmentGeneration: 1,
      certificateDerSha256,
      issuerKeyId,
      receiptSha256: "66".repeat(32),
      recordDocumentSha256,
    };
    const revocation: DatabaseOperationMap["revokeServerBindingV1"]["input"] = {
      revocationId: "55fa93f8-4b12-491c-a469-1e934c087c3e",
      bindingId,
      reasonCode: "operator_requested",
    };

    await authority.confirmRecord(confirmation);
    await authority.readRecoveryReceipt({ certificateDerSha256 });
    await authority.readActiveSnapshot({ certificateDerSha256 });
    await authority.recheckActiveSnapshot(activeSnapshot);
    await authority.revoke(revocation);
    expect(database.requests.slice(1)).toEqual([
      { operation: "confirmServerBindingRecordV1", input: confirmation },
      {
        operation: "readServerBindingRecoveryReceiptV1",
        input: { certificateDerSha256 },
      },
      {
        operation: "readServerBindingActiveSnapshotV1",
        input: { certificateDerSha256 },
      },
      { operation: "recheckServerBindingActiveSnapshotV1", input: activeSnapshot },
      { operation: "revokeServerBindingV1", input: revocation },
    ]);
    await coordinator.close();
  });

  it("keeps production composition lifecycle-only and out of the application surface", () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../../..");
    const runtimeSource = readFileSync(
      resolve(repositoryRoot, "apps/server/src/runtime/server-storage-runtime.ts"),
      "utf8",
    );
    const mainSource = readFileSync(resolve(repositoryRoot, "apps/server/src/main.ts"), "utf8");
    const appSource = readFileSync(resolve(repositoryRoot, "apps/server/src/app.ts"), "utf8");
    const runtimeClose = runtimeSource.indexOf("const close = (): Promise<void> =>");
    const bindingClose = runtimeSource.indexOf(
      "const bindingClose = activeServerBindingCoordinator.close()",
      runtimeClose,
    );
    const artifactClose = runtimeSource.indexOf(
      "const artifactClose = bindingClose.then(",
      runtimeClose,
    );
    const artifactOwnerClose = runtimeSource.indexOf("activeCoordinator.close()", artifactClose);
    const aggregateClose = runtimeSource.indexOf(
      "Promise.allSettled([bindingClose, artifactClose])",
      runtimeClose,
    );

    expect(runtimeSource).toContain("database.createServerBindingPersistenceDatabaseHandle()");
    expect(runtimeSource).toContain("await serverBindingCoordinator.open()");
    expect(runtimeClose).toBeGreaterThan(-1);
    expect(bindingClose).toBeGreaterThan(runtimeClose);
    expect(artifactClose).toBeGreaterThan(bindingClose);
    expect(artifactOwnerClose).toBeGreaterThan(artifactClose);
    expect(aggregateClose).toBeGreaterThan(artifactOwnerClose);
    expect(runtimeSource).not.toMatch(
      /\b(?:activeServerBindingCoordinator|serverBindingCoordinator)\.authority\b/u,
    );
    expect(mainSource).not.toContain("serverBindingSigner");
    expect(mainSource).not.toContain("ServerBindingCoordinatorV1");
    expect(appSource).not.toContain("serverBinding");
  });
});
