import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign as nodeSign,
} from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API as TypeScriptApi } from "typescript/unstable/sync";
import { describe, expect, it } from "vitest";

import {
  deriveServerBindingIssuerKeyIdV1,
  marshalServerBindingActiveStatusStatementV1,
  marshalServerBindingActiveStatusV1,
  marshalServerBindingReceiptStatementV1,
  marshalServerBindingReceiptV1,
  parseServerBindingActiveStatusV1,
  parseServerBindingReceiptV1,
  SERVER_BINDING_ACTIVE_STATUS_MAXIMUM_CLOCK_SKEW_MS,
  SERVER_BINDING_ACTIVE_STATUS_MAXIMUM_LIFETIME_MS,
  SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
  SERVER_BINDING_ACTIVE_STATUS_SIGNING_DOMAIN,
  SERVER_BINDING_AUTHORITY_ISSUER,
  SERVER_BINDING_AUTHORITY_MAXIMUM_DOCUMENT_BYTES,
  SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
  SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
  SERVER_BINDING_RECEIPT_PROFILE_ID,
  SERVER_BINDING_RECEIPT_SIGNING_DOMAIN,
  type ServerBindingActiveStatusStatementV1,
  ServerBindingActiveStatusStatementV1Schema,
  type ServerBindingActiveStatusV1,
  ServerBindingActiveStatusV1Schema,
  ServerBindingAuthorityContractError,
  type ServerBindingAuthorityContractErrorCode,
  type ServerBindingReceiptStatementV1,
  ServerBindingReceiptStatementV1Schema,
  type ServerBindingReceiptV1,
  ServerBindingReceiptV1Schema,
  serverBindingActiveStatusSigningDigestV1,
  serverBindingActiveStatusSigningPreimageV1,
  serverBindingReceiptSigningDigestV1,
  serverBindingReceiptSigningPreimageV1,
  verifyServerBindingActiveStatusWithSpkiV1,
  verifyServerBindingReceiptWithSpkiV1,
} from "./server-binding-authority-v1.js";

const p256Order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const p256HalfOrder = p256Order >> 1n;
const testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQggZDZZcSzKuD4h3Iu
rGCGLBlKcNoYbAjlNgwsgHcJ/iGhRANCAAT6/SVhOAT0FIVQ9/JY4HhWm2IM5fxA
F0qkH3Q//jWyVZNp7k5o+oDKezoZWbxoB46t9HT3+DoCEUaaBPUsIz+c
-----END PRIVATE KEY-----`;
const testPrivateKey = createPrivateKey(testPrivateKeyPem);
const testPublicKey = createPublicKey(testPrivateKey);
const issuerSpki = testPublicKey.export({ format: "der", type: "spki" });
const issuerKeyId = deriveServerBindingIssuerKeyIdV1(issuerSpki);
const serverBindingAuthoritySubpath = "@agentic-review/contracts/server-binding-authority-v1";
const serverBindingSignerHostFixtureSuffix =
  "/apps/server/testdata/server-binding-signer-host-fixture-v1.mjs";
const serverBindingSignerHostFixtureBasename = "server-binding-signer-host-fixture-v1.mjs";
const serverBindingSignerHostFixtureSha256 =
  "3410ff22fcea8ed82eedd4267c3092c14da3ee8c64d7d5346c0ceb62981ad0e0";
const serverBindingAuthorityConsumerAllowlist = [
  "/apps/server/src/database/server-binding-persistence-v1.ts",
  "/apps/server/src/enrollment/server-binding-coordinator-v1.ts",
  "/apps/server/src/enrollment/server-binding-signer-host-protocol-v1.ts",
  "/apps/server/src/enrollment/server-binding-signer-v1.ts",
] as const;
const sensitiveServerBindingModuleConsumers = new Map<string, readonly string[]>([
  ["server-binding-state-v1", ["/apps/server/src/database/server-binding-persistence-v1.ts"]],
  [
    "server-binding-persistence-v1",
    [
      "/apps/server/src/database/database-worker.ts",
      "/apps/server/src/database/protocol.ts",
      "/apps/server/src/enrollment/server-binding-coordinator-v1.ts",
    ],
  ],
  [
    "server-binding-coordinator-v1",
    [
      "/apps/server/src/database/database-client.ts",
      "/apps/server/src/runtime/server-storage-runtime.ts",
    ],
  ],
  [
    "server-binding-signer-host-client-v1",
    ["/apps/server/src/enrollment/server-binding-signer-host-provider-v1.ts"],
  ],
  ["server-binding-signer-host-provider-v1", []],
  [
    "server-binding-signer-host-profile-v1",
    ["/apps/server/src/enrollment/server-binding-signer-host-client-v1.ts"],
  ],
  [
    "server-binding-signer-host-protocol-v1",
    ["/apps/server/src/enrollment/server-binding-signer-host-client-v1.ts"],
  ],
  [
    "server-binding-signer-v1",
    [
      "/apps/server/src/enrollment/server-binding-coordinator-v1.ts",
      "/apps/server/src/runtime/server-storage-runtime.ts",
    ],
  ],
  [
    "server-binding-signer-provider-v1",
    [
      "/apps/server/src/enrollment/server-binding-signer-host-provider-v1.ts",
      "/apps/server/src/enrollment/server-binding-signer-v1.ts",
    ],
  ],
  ["server-binding-trust-profile-v1", ["/apps/server/src/enrollment/server-binding-signer-v1.ts"]],
]);
const sensitiveServerBindingConsumerImports = new Map<string, readonly string[]>([
  [
    "/apps/server/src/enrollment/server-binding-signer-host-client-v1.ts",
    [
      "./server-binding-signer-host-profile-v1.js|ServerBindingSignerHostProfileV1:ServerBindingSignerHostProfileV1:type,loadProductionServerBindingSignerHostProfileV1:loadProductionServerBindingSignerHostProfileV1:value",
      "./server-binding-signer-host-protocol-v1.js|SERVER_BINDING_SIGNER_HOST_FORCED_EXIT_TIMEOUT_MILLISECONDS:SERVER_BINDING_SIGNER_HOST_FORCED_EXIT_TIMEOUT_MILLISECONDS:value,SERVER_BINDING_SIGNER_HOST_GRACEFUL_SHUTDOWN_TIMEOUT_MILLISECONDS:SERVER_BINDING_SIGNER_HOST_GRACEFUL_SHUTDOWN_TIMEOUT_MILLISECONDS:value,SERVER_BINDING_SIGNER_HOST_HANDSHAKE_TIMEOUT_MILLISECONDS:SERVER_BINDING_SIGNER_HOST_HANDSHAKE_TIMEOUT_MILLISECONDS:value,SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDERR_BYTES:SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDERR_BYTES:value,SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION:SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION:value,SERVER_BINDING_SIGNER_HOST_SIGNING_TIMEOUT_MILLISECONDS:SERVER_BINDING_SIGNER_HOST_SIGNING_TIMEOUT_MILLISECONDS:value,ServerBindingSignerHostFrameDecoderV1:ServerBindingSignerHostFrameDecoderV1:value,ServerBindingSignerHostOperationV1:ServerBindingSignerHostOperationV1:type,ServerBindingSignerHostParentMessageV1:ServerBindingSignerHostParentMessageV1:type,frameServerBindingSignerHostPayloadV1:frameServerBindingSignerHostPayloadV1:value,marshalServerBindingSignerHostParentMessageV1:marshalServerBindingSignerHostParentMessageV1:value,parseServerBindingSignerHostChildMessageV1:parseServerBindingSignerHostChildMessageV1:value",
      "node:child_process|ChildProcessWithoutNullStreams:ChildProcessWithoutNullStreams:type,spawn:spawnSignerHostProcess:value",
      "node:crypto|randomUUID:randomUUID:value",
      "node:path|isAbsolute:isAbsolute:value",
    ],
  ],
  ["/apps/server/src/enrollment/server-binding-signer-host-profile-v1.ts", []],
  [
    "/apps/server/src/enrollment/server-binding-signer-host-provider-v1.ts",
    [
      "./server-binding-signer-host-client-v1.js|ServerBindingSignerHostClientErrorV1:ServerBindingSignerHostClientErrorV1:value,createServerBindingSignerHostDirectClientV1:createServerBindingSignerHostDirectClientV1:value",
      "./server-binding-signer-provider-v1.js|ServerBindingSignerProviderStartupErrorV1:ServerBindingSignerProviderStartupErrorV1:value,ServerBindingStatementSignerProviderV1:ServerBindingStatementSignerProviderV1:type",
    ],
  ],
  [
    "/apps/server/src/enrollment/server-binding-signer-host-protocol-v1.ts",
    [
      "@agentic-review/contracts/server-binding-authority-v1|ServerBindingActiveStatusStatementV1:ServerBindingActiveStatusStatementV1:type,ServerBindingReceiptStatementV1:ServerBindingReceiptStatementV1:type,deriveServerBindingIssuerKeyIdV1:deriveServerBindingIssuerKeyIdV1:value,marshalServerBindingActiveStatusStatementV1:marshalServerBindingActiveStatusStatementV1:value,marshalServerBindingReceiptStatementV1:marshalServerBindingReceiptStatementV1:value",
    ],
  ],
  ["/apps/server/src/enrollment/server-binding-signer-provider-v1.ts", []],
  [
    "/apps/server/src/enrollment/server-binding-signer-v1.ts",
    [
      "./server-binding-signer-provider-v1.js|ServerBindingSignerProviderStartupErrorV1:ServerBindingSignerProviderStartupErrorV1:value,loadProductionServerBindingSignerProviderV1:loadProductionServerBindingSignerProviderV1:value",
      "./server-binding-trust-profile-v1.js|loadProductionServerBindingTrustProfileV1:loadProductionServerBindingTrustProfileV1:value",
      "@agentic-review/contracts/server-binding-authority-v1|SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID:SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID:value,SERVER_BINDING_AUTHORITY_ISSUER:SERVER_BINDING_AUTHORITY_ISSUER:value,SERVER_BINDING_AUTHORITY_MAXIMUM_DOCUMENT_BYTES:SERVER_BINDING_AUTHORITY_MAXIMUM_DOCUMENT_BYTES:value,SERVER_BINDING_AUTHORITY_SCHEMA_VERSION:SERVER_BINDING_AUTHORITY_SCHEMA_VERSION:value,SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM:SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM:value,SERVER_BINDING_RECEIPT_PROFILE_ID:SERVER_BINDING_RECEIPT_PROFILE_ID:value,ServerBindingActiveStatusStatementV1:ServerBindingActiveStatusStatementV1:type,ServerBindingActiveStatusV1:ServerBindingActiveStatusV1:type,ServerBindingReceiptStatementV1:ServerBindingReceiptStatementV1:type,ServerBindingReceiptV1:ServerBindingReceiptV1:type,deriveServerBindingIssuerKeyIdV1:deriveServerBindingIssuerKeyIdV1:value,marshalServerBindingActiveStatusStatementV1:marshalServerBindingActiveStatusStatementV1:value,marshalServerBindingActiveStatusV1:marshalServerBindingActiveStatusV1:value,marshalServerBindingReceiptStatementV1:marshalServerBindingReceiptStatementV1:value,marshalServerBindingReceiptV1:marshalServerBindingReceiptV1:value,serverBindingActiveStatusSigningPreimageV1:serverBindingActiveStatusSigningPreimageV1:value,serverBindingReceiptSigningPreimageV1:serverBindingReceiptSigningPreimageV1:value,verifyServerBindingActiveStatusWithSpkiV1:verifyServerBindingActiveStatusWithSpkiV1:value,verifyServerBindingReceiptWithSpkiV1:verifyServerBindingReceiptWithSpkiV1:value",
      "node:crypto|createHash:createHash:value,timingSafeEqual:timingSafeEqual:value",
      "node:util/types|isPromise:isPromise:value",
    ],
  ],
  [
    "/apps/server/src/enrollment/server-binding-coordinator-v1.ts",
    [
      "../database/protocol.js|DatabaseOperationMap:DatabaseOperationMap:type",
      "../database/server-binding-persistence-v1.js|ConfirmServerBindingRecordV1Input:ConfirmServerBindingRecordV1Input:type,ReadServerBindingRecoveryReceiptV1Input:ReadServerBindingRecoveryReceiptV1Input:type,RevokeServerBindingV1Input:RevokeServerBindingV1Input:type,ServerBindingActiveSnapshotV1:ServerBindingActiveSnapshotV1:type,ServerBindingRecoveryReceiptV1:ServerBindingRecoveryReceiptV1:type,ServerBindingTrustedIssuerDescriptorV1:ServerBindingTrustedIssuerDescriptorV1:type,deriveServerBindingRevocationRequestSha256V1:deriveServerBindingRevocationRequestSha256V1:value",
      "./server-binding-signer-v1.js|ServerBindingSignerContextV1:ServerBindingSignerContextV1:type,ServerBindingSignerErrorV1:ServerBindingSignerErrorV1:value,adoptServerBindingSignerV1:adoptServerBindingSignerV1:value,assertServerBindingSignerOwnershipAvailableV1:assertServerBindingSignerOwnershipAvailableV1:value,closeServerBindingSignerV1:closeServerBindingSignerV1:value,readServerBindingSignerDescriptorV1:readServerBindingSignerDescriptorV1:value,signServerBindingReceiptStatementV1:signServerBindingReceiptStatementV1:value",
      "@agentic-review/contracts/server-binding-authority-v1|SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID:SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID:value,SERVER_BINDING_AUTHORITY_ISSUER:SERVER_BINDING_AUTHORITY_ISSUER:value,SERVER_BINDING_AUTHORITY_SCHEMA_VERSION:SERVER_BINDING_AUTHORITY_SCHEMA_VERSION:value,SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM:SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM:value,SERVER_BINDING_RECEIPT_PROFILE_ID:SERVER_BINDING_RECEIPT_PROFILE_ID:value,ServerBindingReceiptStatementV1:ServerBindingReceiptStatementV1:type,marshalServerBindingReceiptStatementV1:marshalServerBindingReceiptStatementV1:value,marshalServerBindingReceiptV1:marshalServerBindingReceiptV1:value,parseServerBindingReceiptV1:parseServerBindingReceiptV1:value,verifyServerBindingReceiptWithSpkiV1:verifyServerBindingReceiptWithSpkiV1:value",
      "node:crypto|createHash:createHash:value,randomBytes:randomBytes:value,randomUUID:randomUUID:value",
    ],
  ],
]);
const sensitiveServerBindingConsumerExports = new Map<string, readonly string[]>([
  [
    "/apps/server/src/database/database-client.ts",
    [
      "DatabaseClient",
      "DatabaseWorkerTransport",
      "attachDatabaseClientForTest",
      "terminateWorkerAndWaitForExit",
    ],
  ],
  ["/apps/server/src/database/database-worker.ts", []],
  [
    "/apps/server/src/database/protocol.ts",
    [
      "ClaimLeaseInput",
      "ClaimLeaseResult",
      "DatabaseHealth",
      "DatabaseOperation",
      "DatabaseOperationMap",
      "DatabaseRequest",
      "DatabaseResponse",
      "DatabaseWorkerMessage",
      "DatabaseWorkerOptions",
      "HeartbeatLeaseInput",
      "HeartbeatLeaseResult",
      "HeartbeatWorkerInput",
      "IngestSchedulingEventInput",
      "IngestSchedulingEventResult",
      "LeaseCompletionInput",
      "LeaseFailureInput",
      "LeaseTerminalResult",
      "ReapExpiredLeasesInput",
      "RegisterWorkerInput",
      "RegisteredWorker",
      "ScheduleJobInput",
      "WebhookDeliveryInput",
    ],
  ],
  [
    "/apps/server/src/database/server-binding-persistence-v1.ts",
    [
      "ClaimServerBindingAuthorizationV1Input",
      "ClaimServerBindingAuthorizationV1Result",
      "CommitServerBindingReceiptV1Input",
      "CommitServerBindingReceiptV1Result",
      "ConfirmServerBindingRecordV1Input",
      "ConfirmServerBindingRecordV1Result",
      "CreateServerBindingAuthorizationV1Input",
      "CreateServerBindingAuthorizationV1Result",
      "InitializeServerBindingIssuerV1Input",
      "InitializeServerBindingIssuerV1Result",
      "ReadServerBindingRecoveryReceiptV1Input",
      "RevokeServerBindingV1Input",
      "RevokeServerBindingV1Result",
      "ServerBindingActiveSnapshotV1",
      "ServerBindingAuthorizationSnapshotV1",
      "ServerBindingClaimSnapshotV1",
      "ServerBindingIssuanceRequestBasisV1",
      "ServerBindingIssuerSnapshotV1",
      "ServerBindingPersistenceAuditResultV1",
      "ServerBindingPersistenceErrorCodeV1",
      "ServerBindingPersistenceErrorV1",
      "ServerBindingRecoveryReceiptV1",
      "ServerBindingRevocationRequestBasisV1",
      "ServerBindingTrustedIssuerDescriptorV1",
      "auditServerBindingPersistenceV1",
      "claimServerBindingAuthorizationV1",
      "commitServerBindingReceiptV1",
      "confirmServerBindingRecordV1",
      "createServerBindingAuthorizationV1",
      "deriveServerBindingIssuanceRequestSha256V1",
      "deriveServerBindingRevocationRequestSha256V1",
      "initializeServerBindingIssuerV1",
      "readServerBindingActiveSnapshotV1",
      "readServerBindingRecoveryReceiptV1",
      "recheckServerBindingActiveSnapshotV1",
      "revokeServerBindingV1",
      "snapshotServerBindingTrustedIssuerDescriptorV1",
    ],
  ],
  [
    "/apps/server/src/enrollment/server-binding-coordinator-v1.ts",
    [
      "CreateServerBindingAuthorizationRequestV1",
      "CreatedServerBindingAuthorizationV1",
      "IssueServerBindingReceiptRequestV1",
      "IssuedServerBindingReceiptV1",
      "ServerBindingAuthorityPortV1",
      "ServerBindingCoordinatorErrorCodeV1",
      "ServerBindingCoordinatorErrorV1",
      "ServerBindingCoordinatorOptionsV1",
      "ServerBindingCoordinatorV1",
      "ServerBindingPersistenceDatabaseHandle",
      "ServerBindingPersistenceDatabaseOperation",
      "createServerBindingTrustedIssuerDescriptorFromSignerV1",
      "isServerBindingPersistenceDatabaseOperation",
      "registerServerBindingPersistenceDatabaseHandle",
      "revokeServerBindingPersistenceDatabaseHandle",
    ],
  ],
  [
    "/apps/server/src/enrollment/server-binding-signer-host-client-v1.ts",
    [
      "ServerBindingSignerHostCleanupStateV1",
      "ServerBindingSignerHostClientErrorV1",
      "ServerBindingSignerHostClientErrorCodeV1",
      "ServerBindingSignerHostClientEventV1",
      "ServerBindingSignerHostClientStateV1",
      "ServerBindingSignerHostDirectClientV1",
      "ServerBindingSignerHostLogicalStateV1",
      "ServerBindingSignerHostStateErrorCodeV1",
      "ServerBindingSignerHostStateErrorV1",
      "SERVER_BINDING_SIGNER_HOST_MAXIMUM_ASSIGNED_REQUEST_IDS",
      "createServerBindingSignerHostDirectClientV1",
      "createServerBindingSignerHostClientStateV1",
      "reduceServerBindingSignerHostClientStateV1",
    ],
  ],
  [
    "/apps/server/src/enrollment/server-binding-signer-host-profile-v1.ts",
    ["ServerBindingSignerHostProfileV1", "loadProductionServerBindingSignerHostProfileV1"],
  ],
  [
    "/apps/server/src/enrollment/server-binding-signer-host-provider-v1.ts",
    ["createServerBindingSignerHostProviderV1"],
  ],
  [
    "/apps/server/src/enrollment/server-binding-signer-host-protocol-v1.ts",
    [
      "SERVER_BINDING_SIGNER_HOST_FORCED_EXIT_TIMEOUT_MILLISECONDS",
      "SERVER_BINDING_SIGNER_HOST_GRACEFUL_SHUTDOWN_TIMEOUT_MILLISECONDS",
      "SERVER_BINDING_SIGNER_HOST_HANDSHAKE_TIMEOUT_MILLISECONDS",
      "SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDERR_BYTES",
      "SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDOUT_BYTES",
      "SERVER_BINDING_SIGNER_HOST_MAXIMUM_CONCURRENT_REQUESTS",
      "SERVER_BINDING_SIGNER_HOST_MAXIMUM_FRAME_BYTES",
      "SERVER_BINDING_SIGNER_HOST_MAXIMUM_STATEMENT_BYTES",
      "SERVER_BINDING_SIGNER_HOST_PROTOCOL_VERSION",
      "SERVER_BINDING_SIGNER_HOST_SIGNING_TIMEOUT_MILLISECONDS",
      "ServerBindingSignerHostCancellationReasonV1",
      "ServerBindingSignerHostChildErrorCodeV1",
      "ServerBindingSignerHostChildMessageV1",
      "ServerBindingSignerHostFrameDecoderV1",
      "ServerBindingSignerHostOperationV1",
      "ServerBindingSignerHostParentMessageV1",
      "ServerBindingSignerHostProtocolErrorCodeV1",
      "ServerBindingSignerHostProtocolErrorV1",
      "frameServerBindingSignerHostPayloadV1",
      "marshalServerBindingSignerHostChildMessageV1",
      "marshalServerBindingSignerHostParentMessageV1",
      "parseServerBindingSignerHostChildMessageV1",
      "parseServerBindingSignerHostParentMessageV1",
    ],
  ],
  [
    "/apps/server/src/enrollment/server-binding-signer-provider-v1.ts",
    [
      "ServerBindingDigestNativeSignerProviderV1",
      "ServerBindingPreimageSha256SignerProviderV1",
      "ServerBindingSignerProviderStartupErrorCodeV1",
      "ServerBindingSignerProviderStartupErrorV1",
      "ServerBindingSignerProviderV1",
      "ServerBindingStatementSignerProviderV1",
      "loadProductionServerBindingSignerProviderV1",
    ],
  ],
  [
    "/apps/server/src/enrollment/server-binding-trust-profile-v1.ts",
    ["ProductionServerBindingTrustProfileV1", "loadProductionServerBindingTrustProfileV1"],
  ],
  [
    "/apps/server/src/enrollment/server-binding-signer-v1.ts",
    [
      "ServerBindingSignerContextV1",
      "ServerBindingSignerDescriptorV1",
      "ServerBindingSignerErrorCodeV1",
      "ServerBindingSignerErrorV1",
      "adoptServerBindingSignerV1",
      "assertServerBindingSignerAdoptableV1",
      "assertServerBindingSignerOwnershipAvailableV1",
      "closeServerBindingSignerV1",
      "closeUnadoptedServerBindingSignerV1",
      "loadServerBindingSignerV1",
      "readServerBindingSignerDescriptorV1",
      "signServerBindingActiveStatusStatementV1",
      "signServerBindingReceiptStatementV1",
    ],
  ],
  [
    "/apps/server/src/runtime/server-storage-runtime.ts",
    [
      "CreateServerStorageRuntimeOptions",
      "ServerStorageRuntime",
      "createServerStorageRuntime",
      "createServerStorageRuntimeWithInitialSweepTimeoutForTest",
    ],
  ],
]);
const sensitiveServerBindingConsumerSourceSha256 = new Map<string, string>([
  [
    "/apps/server/src/database/database-client.ts",
    "1c4f411d714d29b165e83c6ebd914eb8342b59201dc4470224db27cd8e032dfd",
  ],
  [
    "/apps/server/src/database/database-worker.ts",
    "16d6e8e71b879c05c96d4b1b5b286dfddb5ea3a656d2b5f1d89b7ef1eec5a985",
  ],
  [
    "/apps/server/src/database/protocol.ts",
    "1a4ea73c438f21e2b4a1b94925e4df2406abb395a0146e77b35e429e7cab7e5a",
  ],
  [
    "/apps/server/src/database/server-binding-persistence-v1.ts",
    "14e69fbc1cde7553bdaaa7f90f9d54cc14d9d6b41f688c7cff852679111c0d2b",
  ],
  [
    "/apps/server/src/enrollment/server-binding-coordinator-v1.ts",
    "db571ab2313277b3a75fc5997b12efa0174aa6e8552dc5c00dd06cd14713e902",
  ],
  [
    "/apps/server/src/enrollment/server-binding-signer-host-client-v1.ts",
    "241be9daea4c9ec2c0f80b672334746a3a775076b008684dd6275361e47453c5",
  ],
  [
    "/apps/server/src/enrollment/server-binding-signer-host-profile-v1.ts",
    "7d69bce8d28832a741c1d3419fb9320a18ab68bb206977a3df9b0a9fa1dead42",
  ],
  [
    "/apps/server/src/enrollment/server-binding-signer-host-protocol-v1.ts",
    "508078468d24f1bddb79a3880d4795d53678bc38540f56288fc9bd26c5f719ac",
  ],
  [
    "/apps/server/src/enrollment/server-binding-signer-host-provider-v1.ts",
    "f909d28905a5871d1320ddbbdee5929c4df8c653f4d271880ac246d03674fd2c",
  ],
  [
    "/apps/server/src/enrollment/server-binding-signer-provider-v1.ts",
    "1bfe67b23d9693a9e4b7e6024c84d11ec018b03d5f744a529d989488e243da71",
  ],
  [
    "/apps/server/src/enrollment/server-binding-trust-profile-v1.ts",
    "01338da175edb1d2c1cbbf1078ecb629155d04217ab5f97bb32579f16e1368cd",
  ],
  [
    "/apps/server/src/enrollment/server-binding-signer-v1.ts",
    "137f70492faf070484c81ab8262b6090c5ec5cc4f0708b87ec9ebf28d9a33ed5",
  ],
  [
    "/apps/server/src/runtime/server-storage-runtime.ts",
    "56487cd6b81f70b12276ebf1e6c9e481dd4981b37d9694c56caa860f13ca3ff3",
  ],
]);

describe("dormant Server binding authority v1 wire contract", () => {
  it("remains absent from the root barrel and exposes only the controlled S1 subpath", () => {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const contractsRoot = join(repositoryRoot, "packages", "contracts");
    const indexSource = readFileSync(join(contractsRoot, "src", "index.ts"), "utf8");
    const packageSource = readFileSync(join(contractsRoot, "package.json"), "utf8");
    const packageValue = JSON.parse(packageSource) as {
      readonly exports?: Readonly<Record<string, unknown>>;
    };
    const serverPackageValue = JSON.parse(
      readFileSync(join(repositoryRoot, "apps", "server", "package.json"), "utf8"),
    ) as Readonly<Record<string, unknown>>;
    const serverTsconfigValue = JSON.parse(
      readFileSync(join(repositoryRoot, "apps", "server", "tsconfig.json"), "utf8"),
    ) as { readonly compilerOptions?: Readonly<Record<string, unknown>> };
    const rootTsconfigValue = JSON.parse(
      readFileSync(join(repositoryRoot, "tsconfig.base.json"), "utf8"),
    ) as { readonly compilerOptions?: Readonly<Record<string, unknown>> };
    expect(indexSource.toLowerCase()).not.toContain("server-binding-authority-v1");
    expect(serverPackageValue).not.toHaveProperty("imports");
    expect(serverPackageValue).not.toHaveProperty("exports");
    expect(serverTsconfigValue.compilerOptions ?? {}).not.toHaveProperty("paths");
    expect(rootTsconfigValue.compilerOptions ?? {}).not.toHaveProperty("paths");
    const signerHostFixture = resolve(
      repositoryRoot,
      "apps",
      "server",
      "testdata",
      serverBindingSignerHostFixtureBasename,
    );
    const signerHostFixtureSource = readFileSync(signerHostFixture, "utf8").replaceAll(
      "\r\n",
      "\n",
    );
    expect(signerHostFixtureSource).not.toContain("\r");
    expect(signerHostFixtureSource).not.toContain("\uFEFF");
    expect(createHash("sha256").update(signerHostFixtureSource, "utf8").digest("hex")).toBe(
      serverBindingSignerHostFixtureSha256,
    );
    expect(JSON.stringify(serverPackageValue)).not.toContain(
      serverBindingSignerHostFixtureBasename,
    );
    expect(JSON.stringify(serverTsconfigValue)).not.toContain("testdata");
    expect(packageValue.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./server-binding-authority-v1": {
        types: "./dist/server-binding-authority-v1.d.ts",
        import: "./dist/server-binding-authority-v1.js",
      },
    });

    const definition = resolve(
      repositoryRoot,
      "packages",
      "contracts",
      "src",
      "server-binding-authority-v1.ts",
    );
    const definitionSource = readFileSync(definition, "utf8");
    expect(definitionSource).not.toMatch(
      /BEGIN (?:EC )?PRIVATE KEY|createPrivateKey|generateKeyPair(?:Sync)?|\bsign\s+as\b|\bnodeSign\b/u,
    );
    const expectedApi = [
      "SERVER_BINDING_ACTIVE_STATUS_MAXIMUM_CLOCK_SKEW_MS",
      "SERVER_BINDING_ACTIVE_STATUS_MAXIMUM_LIFETIME_MS",
      "SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID",
      "SERVER_BINDING_ACTIVE_STATUS_SIGNING_DOMAIN",
      "SERVER_BINDING_AUTHORITY_ISSUER",
      "SERVER_BINDING_AUTHORITY_MAXIMUM_DOCUMENT_BYTES",
      "SERVER_BINDING_AUTHORITY_SCHEMA_VERSION",
      "SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM",
      "SERVER_BINDING_RECEIPT_PROFILE_ID",
      "SERVER_BINDING_RECEIPT_SIGNING_DOMAIN",
      "ServerBindingActiveStatusStatementV1",
      "ServerBindingActiveStatusStatementV1Schema",
      "ServerBindingActiveStatusV1",
      "ServerBindingActiveStatusV1Schema",
      "ServerBindingAuthorityContractError",
      "ServerBindingAuthorityContractErrorCode",
      "ServerBindingReceiptStatementV1",
      "ServerBindingReceiptStatementV1Schema",
      "ServerBindingReceiptV1",
      "ServerBindingReceiptV1Schema",
      "ServerBindingSignatureDocumentKindV1",
      "ServerBindingSignatureFactsV1",
      "deriveServerBindingIssuerKeyIdV1",
      "marshalServerBindingActiveStatusStatementV1",
      "marshalServerBindingActiveStatusV1",
      "marshalServerBindingReceiptStatementV1",
      "marshalServerBindingReceiptV1",
      "parseServerBindingActiveStatusV1",
      "parseServerBindingReceiptV1",
      "serverBindingActiveStatusSigningDigestV1",
      "serverBindingActiveStatusSigningPreimageV1",
      "serverBindingReceiptSigningDigestV1",
      "serverBindingReceiptSigningPreimageV1",
      "verifyServerBindingActiveStatusWithSpkiV1",
      "verifyServerBindingReceiptWithSpkiV1",
    ];
    const exportInspection = inspectExportApi(definitionSource, definition);
    expect(exportInspection.forbidden).toEqual([]);
    expect(exportInspection.names).toEqual(expectedApi);
    const productionSources = productionSourceFiles(repositoryRoot)
      .filter((file) => resolve(file) !== definition)
      .map((file) => ({ fileName: file, source: readFileSync(file, "utf8") }));
    const normalizedProductionFiles = productionSources.map(({ fileName }) =>
      fileName.replaceAll("\\", "/").toLowerCase(),
    );
    for (const suffix of sensitiveServerBindingConsumerImports.keys()) {
      expect(
        normalizedProductionFiles.some(
          (fileName) => fileName === suffix.slice(1) || fileName.endsWith(suffix),
        ),
        suffix,
      ).toBe(true);
    }
    const inspections = inspectProductionModules(productionSources);
    const offenders: string[] = [];
    for (const { fileName } of productionSources) {
      const violations = inspections.get(fileName) ?? ["AST inspection result unavailable"];
      if (violations.length !== 0) {
        offenders.push(
          `${relative(repositoryRoot, fileName).replaceAll("\\", "/")}: ${violations.join(", ")}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses AST checks for every export binding and production loader form", () => {
    expect(inspectExportApi("export const Existing = 1, Extra = 2;", "mutation.ts")).toEqual({
      forbidden: [],
      names: ["Existing", "Extra"],
    });
    for (const mutation of [
      "export { Existing };",
      "export default function hidden() {}",
      'export * from "./other.js";',
      "export as namespace Hidden;",
    ]) {
      expect(inspectExportApi(mutation, "mutation.ts").forbidden.length, mutation).toBeGreaterThan(
        0,
      );
    }

    const mutations = [
      'import type { Receipt } from "./server-binding-authority-v1.js";',
      'type Receipt = import("./Server-Binding-Authority-V1.js").ServerBindingReceiptV1;',
      'export * from "@agentic-review/contracts/Server-Binding-Authority-V1";',
      'import { parseServerBindingReceiptV1 } from "@agentic-review/contracts/server-binding-authority-v1";',
      'import Receipt = require("./server-binding-authority-v1.js");',
      'await import("./server-binding-" + "authority-v1.js");',
      'require(["@agentic-review/contracts/server-binding-", "authority-v1"].join(""));',
      'const first = "server-binding-"; const second = "authority-v1"; import(first + second);',
      'createRequire(import.meta.url)("@agentic-review/contracts/server-binding-authority-v1");',
      String.raw`await import("./server-binding-\u0061uthority-v1.js");`,
      String.raw`require("./server-binding-\x61uthority-v1.js");`,
      "await import(String.fromCharCode(46, 47, 104, 105, 100, 100, 101, 110));",
      'eval("ignored");',
      'new Function("return 1");',
      'process.getBuiltinModule("node:fs");',
      "const hiddenBuiltin = process.getBuiltinModule;",
      'Module._load("node:fs");',
      'const hiddenLoad = Module["_load"];',
      'process.dlopen(module, "addon.node");',
      'Reflect.get(process, "get" + "BuiltinModule")("node:module");',
      'Reflect.apply(Reflect.get, Reflect, [process, "get" + "BuiltinModule"]);',
      'const hiddenFunction = globalThis["Function"];',
      'import vm from "node:vm";',
      'import { createRequire as hiddenRequire } from "node:module";',
      'new Worker(new URL("./server-binding-authority-v1.js", import.meta.url));',
      'new Worker(new URL("./server-binding-" + "authority-v1.js", import.meta.url));',
      "new globalThis.Worker(new URL(String.fromCharCode(46, 47, 120), import.meta.url));",
      'importScripts("./server-binding-authority-v1.js");',
      'fork("./server-binding-authority-v1.js");',
      'execFile("node", ["./server-binding-authority-v1.js"]);',
      'execFileSync("node", ["./server-binding-authority-v1.js"]);',
      'spawn("node", ["./server-binding-authority-v1.js"]);',
      'spawnSync("node", ["./server-binding-authority-v1.js"]);',
      'const hiddenName = "server-binding-" + "authority-v1";',
      "const hiddenTemplate = `server-binding-$" + '{"authority"}-v1`;',
    ];
    const mutationSources = mutations.map((source, index) => ({
      fileName: `mutation-${index}.ts`,
      source,
    }));
    const mutationInspections = inspectProductionModules(mutationSources);
    for (const mutation of mutationSources) {
      expect(
        mutationInspections.get(mutation.fileName)?.length ?? 0,
        mutation.source,
      ).toBeGreaterThan(0);
    }
    const benignSources = [
      { fileName: "benign-a.ts", source: 'import { Type } from "@sinclair/typebox";' },
      {
        fileName: "benign-b.ts",
        source: 'import { JobSchema } from "@agentic-review/contracts";',
      },
      {
        fileName: "apps/server/src/enrollment/server-binding-signer-v1.ts",
        source:
          'import { deriveServerBindingIssuerKeyIdV1 } from "@agentic-review/contracts/server-binding-authority-v1";',
      },
      {
        fileName: "apps/server/src/enrollment/server-binding-signer-host-protocol-v1.ts",
        source:
          'import { deriveServerBindingIssuerKeyIdV1 } from "@agentic-review/contracts/server-binding-authority-v1";',
      },
      {
        fileName: "apps/server/src/enrollment/server-binding-signer-host-client-v1.ts",
        source:
          'import { type ChildProcessWithoutNullStreams, spawn as spawnSignerHostProcess } from "node:child_process"; const emptySignerHostEnvironment = Object.freeze(Object.create(null)); class DirectSignerHostOwner { async #initialize() { const profile = { executablePath: "x", arguments: [], workingDirectory: "y" }; let child: ChildProcessWithoutNullStreams; child = spawnSignerHostProcess(profile.executablePath, [...profile.arguments], { cwd: profile.workingDirectory, detached: false, env: emptySignerHostEnvironment, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, }); void child; } }',
      },
    ];
    const benignInspections = inspectProductionModules(benignSources);
    for (const benign of benignSources) {
      expect(benignInspections.get(benign.fileName)).toEqual([]);
    }

    const allowlistDriftSources = [
      {
        fileName: "apps/server/src/artifacts/artifact-storage-client.ts",
        source:
          'import { Worker, type WorkerOptions } from "node:worker_threads"; const defaultWorkerFactory = (filename, options) => new Worker(new URL(filename), options);',
      },
      {
        fileName: "apps/server/src/database/database-client.ts",
        source:
          'import { Worker } from "node:worker_threads"; class DatabaseClient { constructor(options) { const workerUrl = new URL(String.fromCharCode(46, 47, 120)); this.worker = new Worker(workerUrl, { workerData: options }); } }',
      },
      {
        fileName: "apps/worker/scripts/build-worker-bundles.mjs",
        source:
          'import { spawnSync } from "node:child_process"; function typecheckWorker() { const typeScriptPackage = fileURLToPath(import.meta.resolve("typescript/package.json")); const compiler = resolve(dirname(typeScriptPackage), "bin/tsc"); spawnSync("node", [compiler, "-p", "tsconfig.json", "--noEmit"], { cwd: workerRoot, encoding: "utf8", windowsHide: true }); }',
      },
      {
        fileName: "apps/worker/src/execution/process-host-client.ts",
        source:
          'import { type ChildProcessWithoutNullStreams, spawn as spawnChildProcess } from "node:child_process"; const defaultSpawnProcess = (executable, argumentsList, options) => spawnChildProcess(executable, [...argumentsList], { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, detached: false, stdio: ["pipe", "pipe", "pipe"], }); spawnChildProcess(dynamicPath, [], {});',
      },
      {
        fileName: "apps/server/src/enrollment/server-binding-signer-host-client-v1.ts",
        source:
          'import { type ChildProcessWithoutNullStreams, spawn as spawnSignerHostProcess } from "node:child_process"; class DirectSignerHostOwner { async #initialize() { const profile = { executablePath: "x", arguments: [], workingDirectory: "y", environment: process.env }; let child: ChildProcessWithoutNullStreams; child = spawnSignerHostProcess(profile.executablePath, [...profile.arguments], { cwd: profile.workingDirectory, detached: false, env: profile.environment, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, }); void child; } }',
      },
    ];
    const driftInspections = inspectProductionModules(allowlistDriftSources);
    for (const drift of allowlistDriftSources) {
      expect(driftInspections.get(drift.fileName)?.length ?? 0, drift.fileName).toBeGreaterThan(0);
    }

    const pureProtocolPath = resolve(
      "apps/server/src/enrollment/server-binding-signer-host-protocol-v1.ts",
    );
    const pureClientPath = resolve(
      "apps/server/src/enrollment/server-binding-signer-host-client-v1.ts",
    );
    const pureModuleMutations = [
      {
        expected: "signer-host A1 pure module contains signing or I/O call",
        fileName: pureProtocolPath,
        source: "void crypto.subtle.sign({}, {}, new Uint8Array());",
      },
      {
        expected: "signer-host A1 import set differs from its exact allowlist",
        fileName: pureClientPath,
        source: 'import { readFileSync } from "node:fs"; void readFileSync;',
      },
      {
        expected: "signer-host A1 pure module contains private-key material or API names",
        fileName: pureClientPath,
        source: 'const privateKey = "-----BEGIN PRIVATE KEY-----"; void privateKey;',
      },
      {
        expected: "production import of a test bridge",
        fileName: resolve("apps/server/src/main.ts"),
        source: 'import "./enrollment/signer-bridge.test.js";',
      },
      {
        expected: "production signer-host fixture reference",
        fileName: resolve("apps/server/src/main.ts"),
        source: 'import "../testdata/server-binding-signer-host-fixture-v1.mjs";',
      },
      {
        expected: "production signer-host fixture scenario selector",
        fileName: resolve("apps/server/src/main.ts"),
        source: 'const signerHostMode = "--fixture-scenario=normal"; void signerHostMode;',
      },
      {
        expected:
          "server-binding-signer-host-provider-v1 import outside exact S1 dependency allowlist",
        fileName: resolve("apps/server/src/main.ts"),
        source:
          'import { createServerBindingSignerHostProviderV1 } from "./enrollment/server-binding-signer-host-provider-v1.js"; void createServerBindingSignerHostProviderV1;',
      },
      {
        expected:
          "server-binding-signer-host-provider-v1 import outside exact S1 dependency allowlist",
        fileName: resolve("apps/server/src/main.ts"),
        source:
          'import { createServerBindingSignerHostProviderV1 } from "./enrollment/server-binding-signer-host-provider-v1.js?raw#escape"; void createServerBindingSignerHostProviderV1;',
      },
      {
        expected:
          "server-binding-signer-host-provider-v1 import outside exact S1 dependency allowlist",
        fileName: resolve("apps/server/src/main.ts"),
        source:
          'import { createServerBindingSignerHostProviderV1 } from "./enrollment/server%2Dbinding%2Dsigner%2Dhost%2Dprovider%2Dv1.js"; void createServerBindingSignerHostProviderV1;',
      },
      {
        expected:
          "server-binding-signer-host-client-v1 import outside exact S1 dependency allowlist",
        fileName: resolve("apps/server/src/enrollment/server-binding-signer-provider-v1.ts"),
        source:
          'import { createServerBindingSignerHostDirectClientV1 } from "./server-binding-signer-host-client-v1.js"; void createServerBindingSignerHostDirectClientV1;',
      },
    ];
    for (const mutation of pureModuleMutations) {
      const inspection =
        inspectProductionModules([{ fileName: mutation.fileName, source: mutation.source }]).get(
          mutation.fileName,
        ) ?? [];
      expect(inspection, mutation.source).toContain(mutation.expected);
    }

    const aliasEscapeSources = [
      {
        fileName: "apps/server/src/artifacts/artifact-storage-client.ts",
        source:
          'import { Worker, type WorkerOptions } from "node:worker_threads"; const defaultWorkerFactory = (filename, options) => new Worker(filename, options) as ArtifactStorageWorkerTransport; const W = Worker; new W(new URL(String.fromCharCode(46, 47, 120)), {});',
      },
      {
        fileName: "apps/server/src/artifacts/artifact-storage-client.ts",
        source:
          'import { Worker, type WorkerOptions } from "node:worker_threads"; const defaultWorkerFactory = (filename, options) => new Worker(filename, options) as ArtifactStorageWorkerTransport; Reflect.construct(Worker, [new URL(String.fromCharCode(46, 47, 120)), {}]);',
      },
      {
        fileName: "apps/worker/src/execution/process-host-client.ts",
        source:
          'import { type ChildProcessWithoutNullStreams, spawn as spawnChildProcess } from "node:child_process"; const defaultSpawnProcess = (executable, argumentsList, options) => spawnChildProcess(executable, [...argumentsList], { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, detached: false, stdio: ["pipe", "pipe", "pipe"], }); spawnChildProcess.call(null, dynamicPath, [], {});',
      },
    ];
    for (const escapeSource of aliasEscapeSources) {
      const inspection = inspectProductionModules([escapeSource]).get(escapeSource.fileName) ?? [];
      expect(inspection.length, escapeSource.source).toBeGreaterThan(0);
    }

    const authorityExportEscapes = [
      {
        fileName: "apps/server/src/enrollment/server-binding-signer-v1.ts",
        source:
          'import { parseServerBindingReceiptV1 } from "@agentic-review/contracts/server-binding-authority-v1"; export { parseServerBindingReceiptV1 };',
      },
      {
        fileName: "apps/server/src/enrollment/server-binding-signer-v1.ts",
        source:
          'import { parseServerBindingReceiptV1 } from "@agentic-review/contracts/server-binding-authority-v1"; const escaped = parseServerBindingReceiptV1; export { escaped };',
      },
      {
        fileName: "apps/server/src/routes/authority-barrel.ts",
        source: 'export * from "../enrollment/server-binding-coordinator-v1.js";',
      },
      {
        fileName: "apps/server/src/database/database-client.ts",
        source: 'export * from "../enrollment/server-binding-coordinator-v1.js";',
      },
      {
        fileName: "apps/server/src/database/database-client.ts",
        source:
          'import { ServerBindingCoordinatorV1 } from "../enrollment/server-binding-coordinator-v1.js"; let escaped; escaped = ServerBindingCoordinatorV1; export { escaped };',
      },
      {
        fileName: "apps/server/src/database/database-client.ts",
        source:
          'const lookup = Reflect.get; Reflect.apply(lookup, Reflect, [process, "get" + "BuiltinModule"]); export class DatabaseClient {} export interface DatabaseWorkerTransport {} export const attachDatabaseClientForTest = 1; export const terminateWorkerAndWaitForExit = 1;',
      },
    ];
    const authorityExportInspections = inspectProductionModules(authorityExportEscapes);
    for (const escapeSource of authorityExportEscapes) {
      expect(
        authorityExportInspections.get(escapeSource.fileName)?.length ?? 0,
        escapeSource.source,
      ).toBeGreaterThan(0);
    }
  });

  it("pins the single statement-provider terminal chain before production activation", () => {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const readServerSource = (name: string): string =>
      readFileSync(
        join(repositoryRoot, "apps", "server", "src", "enrollment", name),
        "utf8",
      ).replaceAll("\r\n", "\n");
    const clientSource = readServerSource("server-binding-signer-host-client-v1.ts");
    const hostProviderSource = readServerSource("server-binding-signer-host-provider-v1.ts");
    const providerSource = readServerSource("server-binding-signer-provider-v1.ts");
    const signerSource = readServerSource("server-binding-signer-v1.ts");
    const coordinatorSource = readServerSource("server-binding-coordinator-v1.ts");

    expect(hostProviderSource.match(/terminalFailure:\s*client\.terminalFailure/gu)).toHaveLength(
      1,
    );
    expect(hostProviderSource.match(/client\.readTerminalError\(\)/gu)).toHaveLength(2);
    expect(providerSource).not.toContain("server-binding-signer-host-client-v1");
    expect(providerSource).not.toContain("node:child_process");
    expect(signerSource).not.toContain("provider.terminalFailure.then(");
    expect(
      signerSource.match(
        /Reflect\.apply\(intrinsicPromiseThen, provider\.terminalFailure, \[observe, observe\]\)/gu,
      ),
    ).toHaveLength(1);
    expect(
      signerSource.indexOf("observeStatementProviderTerminal(provider, terminal)"),
    ).toBeLessThan(signerSource.indexOf("readStatementProviderTerminal(provider)"));
    expect(signerSource.indexOf("readStatementProviderTerminal(provider)")).toBeLessThan(
      signerSource.indexOf("const context = Object.create(null)"),
    );
    expect(signerSource).toContain("terminalFailure: {");
    expect(signerSource).toContain("readTerminalError: {");
    expect(coordinatorSource).not.toContain("signer.terminalFailure.then(");
    expect(
      coordinatorSource.match(
        /Reflect\.apply\(intrinsicPromiseThen, signer\.terminalFailure, \[observeSignerTerminal\]\)/gu,
      ),
    ).toHaveLength(1);
    expect(
      coordinatorSource.indexOf("assertServerBindingSignerOwnershipAvailableV1(signer)"),
    ).toBeLessThan(
      coordinatorSource.indexOf(
        "Reflect.apply(intrinsicPromiseThen, signer.terminalFailure, [observeSignerTerminal])",
      ),
    );
    expect(
      coordinatorSource.indexOf(
        "Reflect.apply(intrinsicPromiseThen, signer.terminalFailure, [observeSignerTerminal])",
      ),
    ).toBeLessThan(coordinatorSource.indexOf("terminalSnapshot = signer.readTerminalError()"));
    expect(coordinatorSource.indexOf("terminalSnapshot = signer.readTerminalError()")).toBeLessThan(
      coordinatorSource.indexOf("databaseHandle = options.database"),
    );
    expect(coordinatorSource).toContain("this.#raceTerminal(initialization)");
    expect(
      coordinatorSource.match(/this\.#failIfSignerTerminal\(\)/gu)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
    expect(clientSource).toContain("hasProvenCleanup");

    const allowedTerminalSources = new Set([
      "/apps/server/src/enrollment/server-binding-coordinator-v1.ts",
      "/apps/server/src/enrollment/server-binding-signer-host-client-v1.ts",
      "/apps/server/src/enrollment/server-binding-signer-host-provider-v1.ts",
      "/apps/server/src/enrollment/server-binding-signer-provider-v1.ts",
      "/apps/server/src/enrollment/server-binding-signer-v1.ts",
    ]);
    const unexpectedTerminalConsumers = productionSourceFiles(repositoryRoot)
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return /\b(?:client|provider|signer)\.terminalFailure\b|\breadTerminalError\b/u.test(
          source,
        );
      })
      .map((file) => file.replaceAll("\\", "/").toLowerCase())
      .filter(
        (file) =>
          ![...allowedTerminalSources].some(
            (suffix) => file === suffix.slice(1) || file.endsWith(suffix),
          ),
      );
    expect(unexpectedTerminalConsumers).toEqual([]);
  });

  it("shares exactly two LF-delimited canonical documents with the Go contract", () => {
    const fixture = readFileSync(
      new URL("../../../testdata/server-binding-authority-v1.jsonl", import.meta.url),
    );
    expect(fixture.byteLength).toBeGreaterThan(2);
    expect(fixture.at(-1)).toBe(0x0a);
    expect(fixture.includes(0x0d)).toBe(false);
    const lines = fixture
      .subarray(0, -1)
      .toString("utf8")
      .split("\n")
      .map((line) => Buffer.from(line, "utf8"));
    expect(lines).toHaveLength(2);

    const receiptDocument = lines[0];
    const statusDocument = lines[1];
    if (receiptDocument === undefined || statusDocument === undefined) {
      throw new Error("Shared Server binding fixture must contain two lines.");
    }
    const receipt = parseServerBindingReceiptV1(receiptDocument);
    const status = parseServerBindingActiveStatusV1(statusDocument);
    expect(verifyServerBindingReceiptWithSpkiV1(receiptDocument, issuerSpki).signatureValid).toBe(
      true,
    );
    expect(
      verifyServerBindingActiveStatusWithSpkiV1(statusDocument, issuerSpki).signatureValid,
    ).toBe(true);
    expect(receipt).toMatchObject({
      issuerKeyId,
      statement: {
        bindingId: "a8f7033b-d65c-4f70-8d37-83c8b1b3706d",
        boundAt: "2026-09-03T00:00:00.000Z",
        certificateDerSha256: "a".repeat(64),
        installationId: "installation-node-001",
        workerNodeId: "worker-node",
      },
    });
    expect(status).toMatchObject({
      issuerKeyId,
      statement: {
        bindingId: receipt.statement.bindingId,
        certificateDerSha256: "a".repeat(64),
        challengeNonceBase64Url: Buffer.alloc(32, 0xab).toString("base64url"),
        expiresAt: "2026-09-03T00:00:45.000Z",
        installationId: "installation-node-001",
        issuedAt: "2026-09-03T00:00:00.000Z",
        receiptSha256: "c".repeat(64),
        recordDocumentSha256: "d".repeat(64),
        workerNodeId: "worker-node",
      },
    });
  });

  it("round-trips the exact canonical receipt and active-status documents", () => {
    const receipt = signedReceipt();
    const receiptDocument = marshalServerBindingReceiptV1(receipt);
    const receiptText = Buffer.from(receiptDocument).toString("utf8");
    expect(receiptText).toBe(canonicalJson(receipt));
    expect(receiptText.startsWith('{"algorithm":')).toBe(true);
    expect(receiptText.endsWith("}")).toBe(true);
    expect(receiptText.includes("\n")).toBe(false);

    const parsedReceipt = parseServerBindingReceiptV1(receiptDocument);
    expect(parsedReceipt).toEqual(receipt);
    expect(Object.isFrozen(parsedReceipt)).toBe(true);
    expect(Object.isFrozen(parsedReceipt.statement)).toBe(true);

    const status = signedActiveStatus();
    const statusDocument = marshalServerBindingActiveStatusV1(status);
    const statusText = Buffer.from(statusDocument).toString("utf8");
    expect(statusText).toBe(canonicalJson(status));
    expect(parseServerBindingActiveStatusV1(statusDocument)).toEqual(status);
  });

  it("snapshots staged descriptor values without invoking caller property getters", () => {
    const receipt = signedReceipt();
    const mutableStatement = { ...receipt.statement };
    let workerDescriptorReads = 0;
    let propertyGets = 0;
    const stagedStatement = new Proxy(mutableStatement, {
      get() {
        propertyGets += 1;
        throw new Error("A caller property getter must not run.");
      },
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "workerNodeId" && descriptor !== undefined) {
          workerDescriptorReads += 1;
          target.workerNodeId = "worker-mutated-after-snapshot";
          return { ...descriptor, value: "worker-node" };
        }
        return descriptor;
      },
    });
    const stagedReceipt = new Proxy(
      { ...receipt, statement: stagedStatement },
      {
        get() {
          propertyGets += 1;
          throw new Error("A caller envelope getter must not run.");
        },
      },
    );

    const document = marshalServerBindingReceiptV1(stagedReceipt);
    expect(parseServerBindingReceiptV1(document).statement.workerNodeId).toBe("worker-node");
    expect(workerDescriptorReads).toBe(1);
    expect(propertyGets).toBe(0);

    const stableStatement = new Proxy(receipt.statement, {
      get() {
        throw new Error("Signing preimage must use descriptor snapshots.");
      },
    });
    expect(serverBindingReceiptSigningPreimageV1(stableStatement)).toEqual(
      serverBindingReceiptSigningPreimageV1(receipt.statement),
    );
  });

  it("maps reflection failures and accessors to closed contract errors", () => {
    const receipt = signedReceipt();
    const throwingProxy = new Proxy(receipt, {
      ownKeys() {
        throw new Error("caller trap");
      },
    });
    expectContractErrorCode(
      () => marshalServerBindingReceiptV1(throwingProxy),
      "SERVER_BINDING_DOCUMENT_INVALID",
    );

    const accessorStatement = { ...receipt.statement } as Record<string, unknown>;
    Object.defineProperty(accessorStatement, "workerNodeId", {
      enumerable: true,
      get: () => "worker-node",
    });
    expectContractErrorCode(
      () => marshalServerBindingReceiptStatementV1(asReceiptStatement(accessorStatement)),
      "SERVER_BINDING_DOCUMENT_INVALID",
    );
  });

  it("uses intrinsic byte-view slots and rejects Proxy deception before copying", () => {
    const oversizedDocument = new Uint8Array(SERVER_BINDING_AUTHORITY_MAXIMUM_DOCUMENT_BYTES + 1);
    Object.defineProperties(oversizedDocument, {
      byteLength: { configurable: true, value: 1 },
      length: { configurable: true, value: Number.MAX_SAFE_INTEGER },
    });
    expectContractErrorCode(
      () => parseServerBindingReceiptV1(oversizedDocument),
      "SERVER_BINDING_DOCUMENT_LIMIT_EXCEEDED",
    );

    const wrongLengthSpki = new Uint8Array(92);
    Object.defineProperties(wrongLengthSpki, {
      byteLength: { configurable: true, value: 91 },
      length: { configurable: true, value: Number.MAX_SAFE_INTEGER },
    });
    expectContractErrorCode(
      () => deriveServerBindingIssuerKeyIdV1(wrongLengthSpki),
      "SERVER_BINDING_SPKI_INVALID",
    );

    const validDocumentWithFakeLength = new Uint8Array(
      marshalServerBindingReceiptV1(signedReceipt()),
    );
    Object.defineProperty(validDocumentWithFakeLength, "length", {
      configurable: true,
      value: Number.MAX_SAFE_INTEGER,
    });
    expect(parseServerBindingReceiptV1(validDocumentWithFakeLength).statement.workerNodeId).toBe(
      "worker-node",
    );
    const validSpkiWithFakeLength = new Uint8Array(issuerSpki);
    Object.defineProperty(validSpkiWithFakeLength, "length", {
      configurable: true,
      value: Number.MAX_SAFE_INTEGER,
    });
    expect(deriveServerBindingIssuerKeyIdV1(validSpkiWithFakeLength)).toBe(issuerKeyId);

    let proxyPropertyReads = 0;
    const deceptiveDocument = new Proxy(oversizedDocument, {
      get(_target, property) {
        proxyPropertyReads += 1;
        if (property === "byteLength") return 1;
        if (property === "length") return 1;
        return 0;
      },
    });
    expectContractErrorCode(
      () => parseServerBindingReceiptV1(deceptiveDocument),
      "SERVER_BINDING_DOCUMENT_INVALID",
    );
    const deceptiveSpki = new Proxy(wrongLengthSpki, {
      get(_target, property) {
        proxyPropertyReads += 1;
        if (property === "byteLength" || property === "length") return 91;
        return 0;
      },
    });
    expectContractErrorCode(
      () => deriveServerBindingIssuerKeyIdV1(deceptiveSpki),
      "SERVER_BINDING_SPKI_INVALID",
    );
    expect(proxyPropertyReads).toBe(0);
  });

  it("keeps every exported schema deeply frozen and structurally detached", () => {
    const receiptProperties = schemaProperties(ServerBindingReceiptV1Schema);
    const statusProperties = schemaProperties(ServerBindingActiveStatusV1Schema);
    expect(receiptProperties.statement).not.toBe(ServerBindingReceiptStatementV1Schema);
    expect(statusProperties.statement).not.toBe(ServerBindingActiveStatusStatementV1Schema);
    for (const schema of [
      ServerBindingReceiptStatementV1Schema,
      ServerBindingReceiptV1Schema,
      ServerBindingActiveStatusStatementV1Schema,
      ServerBindingActiveStatusV1Schema,
    ]) {
      expect(Object.isFrozen(schema)).toBe(true);
      expect(Object.isFrozen(schemaProperties(schema))).toBe(true);
    }
  });

  it("constructs exact domain-separated preimages and single SHA-256 digests", () => {
    const receipt = receiptStatement();
    const receiptPreimage = serverBindingReceiptSigningPreimageV1(receipt);
    expect(receiptPreimage).toEqual(
      Buffer.concat([
        Buffer.from(SERVER_BINDING_RECEIPT_SIGNING_DOMAIN, "ascii"),
        Buffer.from([0]),
        Buffer.from(marshalServerBindingReceiptStatementV1(receipt)),
      ]),
    );
    expect(Buffer.from(serverBindingReceiptSigningDigestV1(receipt)).toString("hex")).toBe(
      createHash("sha256").update(receiptPreimage).digest("hex"),
    );

    const status = activeStatusStatement();
    const statusPreimage = serverBindingActiveStatusSigningPreimageV1(status);
    expect(statusPreimage).toEqual(
      Buffer.concat([
        Buffer.from(SERVER_BINDING_ACTIVE_STATUS_SIGNING_DOMAIN, "ascii"),
        Buffer.from([0]),
        Buffer.from(marshalServerBindingActiveStatusStatementV1(status)),
      ]),
    );
    expect(Buffer.from(serverBindingActiveStatusSigningDigestV1(status)).toString("hex")).toBe(
      createHash("sha256").update(statusPreimage).digest("hex"),
    );
    expect(statusPreimage).not.toEqual(receiptPreimage);
  });

  it("rejects noncanonical JSON, malformed UTF-8, non-ASCII, and size drift", () => {
    const document = Buffer.from(marshalServerBindingReceiptV1(signedReceipt()));
    const text = document.toString("utf8");
    const algorithm = SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM;
    const parsed = JSON.parse(text) as ServerBindingReceiptV1;

    const reordered = JSON.stringify({
      issuer: parsed.issuer,
      algorithm: parsed.algorithm,
      issuerKeyId: parsed.issuerKeyId,
      profileId: parsed.profileId,
      schemaVersion: parsed.schemaVersion,
      signature: parsed.signature,
      statement: parsed.statement,
    });
    const duplicate = text.replace('{"algorithm":', `{"algorithm":"${algorithm}","algorithm":`);
    const escaped = text.replace("worker-node", "worker\\u002dnode");
    const nonAscii = text.replace("worker-node", "worker-nodé");

    const candidates: ReadonlyArray<readonly [string, Buffer]> = [
      ["BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), document])],
      ["leading whitespace", Buffer.concat([Buffer.from(" "), document])],
      ["trailing whitespace", Buffer.concat([document, Buffer.from("\n")])],
      ["reordered members", Buffer.from(reordered)],
      ["duplicate member", Buffer.from(duplicate)],
      ["escaped value", Buffer.from(escaped)],
      ["non-ASCII value", Buffer.from(nonAscii)],
      ["invalid UTF-8", Buffer.from([0xff])],
      ["oversized", Buffer.alloc(SERVER_BINDING_AUTHORITY_MAXIMUM_DOCUMENT_BYTES + 1)],
      ["empty", Buffer.alloc(0)],
    ];
    for (const [name, candidate] of candidates) {
      expect(() => parseServerBindingReceiptV1(candidate), name).toThrow();
    }
  });

  it("rejects missing, extra, null, cross-profile, and cross-type values", () => {
    const receipt = signedReceipt();
    const { issuer: _issuer, ...missing } = receipt;
    for (const candidate of [
      missing,
      { ...receipt, unexpected: true },
      { ...receipt, issuer: null },
      { ...receipt, issuer: "AGENTIC-REVIEW-SERVER-ENROLLMENT-BINDING-AUTHORITY-V1" },
      { ...receipt, profileId: SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID },
      { ...receipt, schemaVersion: 2 },
      { ...receipt, algorithm: "ecdsa-p384-sha384" },
      { ...receipt, issuerKeyId: `${receipt.issuerKeyId}\n` },
      { ...receipt, signature: `${receipt.signature}\n` },
      { ...receipt, statement: activeStatusStatement() },
    ]) {
      expect(() => marshalServerBindingReceiptV1(asReceipt(candidate))).toThrow();
    }

    const status = signedActiveStatus();
    for (const candidate of [
      { ...status, profileId: SERVER_BINDING_RECEIPT_PROFILE_ID },
      { ...status, statement: receiptStatement() },
    ]) {
      expect(() => marshalServerBindingActiveStatusV1(asActiveStatus(candidate))).toThrow();
    }

    expect(() => parseServerBindingReceiptV1(marshalServerBindingActiveStatusV1(status))).toThrow();
    expect(() =>
      parseServerBindingActiveStatusV1(marshalServerBindingReceiptV1(receipt)),
    ).toThrow();
  });

  it("pins UUID, digest, revision, generation, and identifier grammars", () => {
    const receipt = signedReceipt();
    const invalidStatements = [
      { ...receipt.statement, bindingId: "A8F7033B-D65C-4F70-8D37-83C8B1B3706D" },
      { ...receipt.statement, bindingId: "a8f7033b-d65c-5f70-8d37-83c8b1b3706d" },
      { ...receipt.statement, bindingId: "a8f7033b-d65c-4f70-7d37-83c8b1b3706d" },
      { ...receipt.statement, bindingRevision: 2 },
      { ...receipt.statement, enrollmentGeneration: 0 },
      { ...receipt.statement, certificateDerSha256: "A".repeat(64) },
      { ...receipt.statement, certificateDerSha256: "a".repeat(63) },
      { ...receipt.statement, installationId: "Install-01" },
      { ...receipt.statement, installationId: "installation:01" },
      { ...receipt.statement, installationId: "con" },
      { ...receipt.statement, installationId: "com1.bin" },
      { ...receipt.statement, installationId: "installation." },
      { ...receipt.statement, installationId: "a".repeat(129) },
      { ...receipt.statement, installationId: "a\n" },
      { ...receipt.statement, workerNodeId: "worker node" },
      { ...receipt.statement, workerNodeId: "-worker" },
      { ...receipt.statement, workerNodeId: "a".repeat(129) },
      { ...receipt.statement, workerNodeId: "a\n" },
      { ...receipt.statement, bindingId: `${receipt.statement.bindingId}\n` },
      { ...receipt.statement, certificateDerSha256: `${receipt.statement.certificateDerSha256}\n` },
      { ...receipt.statement, boundAt: `${receipt.statement.boundAt}\n` },
      { ...receipt.statement, statementType: "active-binding-current" },
    ];
    for (const statement of invalidStatements) {
      expect(() => marshalServerBindingReceiptStatementV1(asReceiptStatement(statement))).toThrow();
    }

    expect(() =>
      marshalServerBindingReceiptStatementV1({
        ...receipt.statement,
        installationId: "package-01_amd64+release.1",
        workerNodeId: "Worker:Node_01",
      }),
    ).not.toThrow();
    expect(() =>
      marshalServerBindingReceiptStatementV1({
        ...receipt.statement,
        boundAt: "0000-01-01T00:00:00.000Z",
      }),
    ).toThrow(/boundAt is not a canonical UTC millisecond instant/u);
  });
});

describe("dormant Server binding active-status time contract", () => {
  it("accepts a positive lifetime of at most sixty seconds", () => {
    const statement = activeStatusStatement();
    expect(() => marshalServerBindingActiveStatusStatementV1(statement)).not.toThrow();
    expect(() =>
      marshalServerBindingActiveStatusStatementV1({
        ...statement,
        expiresAt: "2026-09-03T00:01:00.000Z",
      }),
    ).not.toThrow();
    expect(SERVER_BINDING_ACTIVE_STATUS_MAXIMUM_LIFETIME_MS).toBe(60_000);
    expect(SERVER_BINDING_ACTIVE_STATUS_MAXIMUM_CLOCK_SKEW_MS).toBe(5_000);
  });

  it("rejects invalid instants and invalid signed lifetimes", () => {
    const statement = activeStatusStatement();
    for (const candidate of [
      { ...statement, issuedAt: "2026-09-03T00:00:00Z" },
      { ...statement, issuedAt: "2026-09-03T00:00:00.00Z" },
      { ...statement, issuedAt: "2026-09-03T00:00:00.000+00:00" },
      { ...statement, issuedAt: "2026-02-30T00:00:00.000Z" },
      { ...statement, issuedAt: "2026-09-03T00:00:00.000z" },
      { ...statement, expiresAt: statement.issuedAt },
      { ...statement, expiresAt: "2026-09-02T23:59:59.999Z" },
      { ...statement, expiresAt: "2026-09-03T00:01:00.001Z" },
    ]) {
      expect(() =>
        marshalServerBindingActiveStatusStatementV1(asActiveStatusStatement(candidate)),
      ).toThrow();
    }
    expect(() =>
      marshalServerBindingActiveStatusStatementV1({
        ...statement,
        issuedAt: "0000-01-01T00:00:00.000Z",
      }),
    ).toThrow(/issuedAt is not a canonical UTC millisecond instant/u);
    expect(() =>
      marshalServerBindingActiveStatusStatementV1({
        ...statement,
        expiresAt: "0000-12-31T23:59:59.999Z",
      }),
    ).toThrow(/expiresAt is not a canonical UTC millisecond instant/u);
  });

  it("requires one exact 32-byte unpadded base64url challenge", () => {
    const statement = activeStatusStatement();
    const noncanonicalPadBits = mutateUnusedBase64UrlBits(statement.challengeNonceBase64Url);
    const candidates: ReadonlyArray<readonly [string, string]> = [
      ["31 bytes", Buffer.alloc(31).toString("base64url")],
      ["33 bytes", Buffer.alloc(33).toString("base64url")],
      ["padding", `${statement.challengeNonceBase64Url}=`],
      ["newline", `${statement.challengeNonceBase64Url}\n`],
      ["invalid alphabet", `/${statement.challengeNonceBase64Url.slice(1)}`],
      ["noncanonical pad bits", noncanonicalPadBits],
    ];
    for (const [name, challengeNonceBase64Url] of candidates) {
      expect(
        () =>
          marshalServerBindingActiveStatusStatementV1({
            ...statement,
            challengeNonceBase64Url,
          }),
        name,
      ).toThrow();
    }
  });
});

describe("dormant Server binding authority v1 ordinary signature checks", () => {
  it("accepts canonical P-256 SPKI and returns only frozen ordinary facts", () => {
    expect(issuerSpki.byteLength).toBe(91);
    expect(issuerSpki.toString("base64url")).toBe(
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-v0lYTgE9BSFUPfyWOB4VptiDOX8QBdKpB90P_41slWTae5OaPqAyns6GVm8aAeOrfR09_g6AhFGmgT1LCM_nA",
    );
    expect(issuerSpki.subarray(0, 27).toString("hex")).toBe(
      "3059301306072a8648ce3d020106082a8648ce3d03010703420004",
    );
    expect(issuerKeyId).toBe("e28eb43c3d5c64b80fe4f26d45e801d1cf45601cbc095fdab74689e760129930");
    expect(issuerKeyId).toBe(createHash("sha256").update(issuerSpki).digest("hex"));

    const receiptFacts = verifyServerBindingReceiptWithSpkiV1(
      marshalServerBindingReceiptV1(signedReceipt()),
      issuerSpki,
    );
    expect(receiptFacts).toEqual({
      algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
      documentKind: "receipt",
      issuerKeyId,
      signatureValid: true,
    });
    expect(Object.isFrozen(receiptFacts)).toBe(true);
    expect(Object.keys(receiptFacts).sort()).toEqual([
      "algorithm",
      "documentKind",
      "issuerKeyId",
      "signatureValid",
    ]);
    expect(receiptFacts).not.toHaveProperty("trusted");
    expect(receiptFacts).not.toHaveProperty("evidence");
    expect(receiptFacts).not.toHaveProperty("authority");

    const statusFacts = verifyServerBindingActiveStatusWithSpkiV1(
      marshalServerBindingActiveStatusV1(signedActiveStatus()),
      issuerSpki,
    );
    expect(statusFacts.documentKind).toBe("active-status");
    expect(statusFacts.signatureValid).toBe(true);
  });

  it("rejects wrong, compressed, trailing, and non-P-256 SPKIs", () => {
    const document = marshalServerBindingReceiptV1(signedReceipt());
    const wrongKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const wrongSpki = wrongKeys.publicKey.export({ format: "der", type: "spki" });
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const p384Spki = p384.publicKey.export({ format: "der", type: "spki" });
    const compressedSpki = compressP256Spki(issuerSpki);

    expect(() => deriveServerBindingIssuerKeyIdV1(compressedSpki)).toThrow();
    expect(() =>
      deriveServerBindingIssuerKeyIdV1(Buffer.concat([issuerSpki, Buffer.from([0])])),
    ).toThrow();
    expect(() => deriveServerBindingIssuerKeyIdV1(p384Spki)).toThrow();
    expect(() => verifyServerBindingReceiptWithSpkiV1(document, wrongSpki)).toThrow();
  });

  it("rejects tuple mutation, a wrong key ID, and a wrong signature", () => {
    const receipt = signedReceipt();
    const modifiedTuple = {
      ...receipt,
      statement: { ...receipt.statement, workerNodeId: "worker-other" },
    };
    expect(() =>
      verifyServerBindingReceiptWithSpkiV1(
        marshalServerBindingReceiptV1(modifiedTuple),
        issuerSpki,
      ),
    ).toThrow();

    const wrongKeyId = { ...receipt, issuerKeyId: "f".repeat(64) };
    expect(() =>
      verifyServerBindingReceiptWithSpkiV1(marshalServerBindingReceiptV1(wrongKeyId), issuerSpki),
    ).toThrow();

    const wrongSignature = Buffer.from(receipt.signature, "base64url");
    wrongSignature[0] = (wrongSignature[0] ?? 0) ^ 1;
    const changedSignature = { ...receipt, signature: wrongSignature.toString("base64url") };
    expect(() =>
      verifyServerBindingReceiptWithSpkiV1(
        marshalServerBindingReceiptV1(changedSignature),
        issuerSpki,
      ),
    ).toThrow();
  });

  it("rejects high-S twins, invalid scalars, DER, padding, and pad-bit aliases", () => {
    const receipt = signedReceipt();
    const highSTwin = toHighSTwin(receipt.signature);
    const invalidSignatures = [
      highSTwin,
      encodeScalars(0n, 1n),
      encodeScalars(p256Order, 1n),
      encodeScalars(1n, 0n),
      encodeScalars(1n, p256HalfOrder + 1n),
      Buffer.alloc(63, 1).toString("base64url"),
      `${receipt.signature}=`,
      `${receipt.signature}\n`,
      mutateUnusedBase64UrlBits(receipt.signature),
      nodeSign("sha256", serverBindingReceiptSigningPreimageV1(receipt.statement), {
        key: testPrivateKey,
        dsaEncoding: "der",
      }).toString("base64url"),
    ];
    for (const signature of invalidSignatures) {
      expect(() => marshalServerBindingReceiptV1({ ...receipt, signature })).toThrow();
    }
  });

  it("rejects Node double-hashed digest signing", () => {
    const statement = receiptStatement();
    const doubleHashedSignature = signLowS(
      serverBindingReceiptSigningDigestV1(statement),
      testPrivateKey,
    );
    const receipt = receiptEnvelope(statement, doubleHashedSignature);
    expect(() =>
      verifyServerBindingReceiptWithSpkiV1(marshalServerBindingReceiptV1(receipt), issuerSpki),
    ).toThrow();
  });

  it("keeps receipt and active-status signing domains disjoint", () => {
    const receiptStatementValue = receiptStatement();
    const wrongReceiptPreimage = Buffer.concat([
      Buffer.from(SERVER_BINDING_ACTIVE_STATUS_SIGNING_DOMAIN, "ascii"),
      Buffer.from([0]),
      Buffer.from(marshalServerBindingReceiptStatementV1(receiptStatementValue)),
    ]);
    const receipt = receiptEnvelope(
      receiptStatementValue,
      signLowS(wrongReceiptPreimage, testPrivateKey),
    );
    expect(() =>
      verifyServerBindingReceiptWithSpkiV1(marshalServerBindingReceiptV1(receipt), issuerSpki),
    ).toThrow();

    const statusStatementValue = activeStatusStatement();
    const wrongStatusPreimage = Buffer.concat([
      Buffer.from(SERVER_BINDING_RECEIPT_SIGNING_DOMAIN, "ascii"),
      Buffer.from([0]),
      Buffer.from(marshalServerBindingActiveStatusStatementV1(statusStatementValue)),
    ]);
    const status = activeStatusEnvelope(
      statusStatementValue,
      signLowS(wrongStatusPreimage, testPrivateKey),
    );
    expect(() =>
      verifyServerBindingActiveStatusWithSpkiV1(
        marshalServerBindingActiveStatusV1(status),
        issuerSpki,
      ),
    ).toThrow();
  });

  it("snapshots caller-owned byte views at every public byte boundary", () => {
    const receiptBytes = Buffer.from(marshalServerBindingReceiptV1(signedReceipt()));
    const expectedReceipt = parseServerBindingReceiptV1(receiptBytes);
    receiptBytes.fill(0);
    expect(expectedReceipt.statement.workerNodeId).toBe("worker-node");

    const spkiForDerivation = Buffer.from(issuerSpki);
    const derived = deriveServerBindingIssuerKeyIdV1(spkiForDerivation);
    spkiForDerivation.fill(0);
    expect(derived).toBe(issuerKeyId);

    const verificationDocument = Buffer.from(marshalServerBindingReceiptV1(signedReceipt()));
    const verificationSpki = Buffer.from(issuerSpki);
    const facts = verifyServerBindingReceiptWithSpkiV1(verificationDocument, verificationSpki);
    verificationDocument.fill(0);
    verificationSpki.fill(0);
    expect(facts).toEqual({
      algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
      documentKind: "receipt",
      issuerKeyId,
      signatureValid: true,
    });
  });
});

function receiptStatement(): ServerBindingReceiptStatementV1 {
  return {
    bindingId: "a8f7033b-d65c-4f70-8d37-83c8b1b3706d",
    bindingRevision: 1,
    boundAt: "2026-09-03T00:00:00.000Z",
    certificateDerSha256: "a".repeat(64),
    enrollmentGeneration: 1,
    installationId: "installation-node-001",
    statementType: "durable-binding-created",
    workerNodeId: "worker-node",
  };
}

function activeStatusStatement(): ServerBindingActiveStatusStatementV1 {
  return {
    bindingId: "a8f7033b-d65c-4f70-8d37-83c8b1b3706d",
    bindingRevision: 1,
    certificateDerSha256: "a".repeat(64),
    challengeNonceBase64Url: Buffer.alloc(32, 0xab).toString("base64url"),
    enrollmentGeneration: 1,
    expiresAt: "2026-09-03T00:00:45.000Z",
    installationId: "installation-node-001",
    issuedAt: "2026-09-03T00:00:00.000Z",
    receiptSha256: "c".repeat(64),
    recordDocumentSha256: "d".repeat(64),
    statementType: "active-binding-current",
    workerNodeId: "worker-node",
  };
}

function signedReceipt(): ServerBindingReceiptV1 {
  const statement = receiptStatement();
  return receiptEnvelope(
    statement,
    signLowS(serverBindingReceiptSigningPreimageV1(statement), testPrivateKey),
  );
}

function receiptEnvelope(
  statement: ServerBindingReceiptStatementV1,
  signature: string,
): ServerBindingReceiptV1 {
  return {
    algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
    issuer: SERVER_BINDING_AUTHORITY_ISSUER,
    issuerKeyId,
    profileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
    schemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
    signature,
    statement,
  };
}

function signedActiveStatus(): ServerBindingActiveStatusV1 {
  const statement = activeStatusStatement();
  return activeStatusEnvelope(
    statement,
    signLowS(serverBindingActiveStatusSigningPreimageV1(statement), testPrivateKey),
  );
}

function activeStatusEnvelope(
  statement: ServerBindingActiveStatusStatementV1,
  signature: string,
): ServerBindingActiveStatusV1 {
  return {
    algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
    issuer: SERVER_BINDING_AUTHORITY_ISSUER,
    issuerKeyId,
    profileId: SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
    schemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
    signature,
    statement,
  };
}

function signLowS(preimage: Uint8Array, privateKey: KeyObject): string {
  const signature = nodeSign("sha256", preimage, {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  const r = readUnsignedBigEndian(signature.subarray(0, 32));
  let s = readUnsignedBigEndian(signature.subarray(32));
  if (s > p256HalfOrder) s = p256Order - s;
  return encodeScalars(r, s);
}

function toHighSTwin(encoded: string): string {
  const signature = Buffer.from(encoded, "base64url");
  const r = readUnsignedBigEndian(signature.subarray(0, 32));
  const s = readUnsignedBigEndian(signature.subarray(32));
  return encodeScalars(r, p256Order - s);
}

function encodeScalars(r: bigint, s: bigint): string {
  const signature = Buffer.alloc(64);
  writeUnsignedBigEndian(r, signature.subarray(0, 32));
  writeUnsignedBigEndian(s, signature.subarray(32));
  return signature.toString("base64url");
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
  if (remaining !== 0n) throw new RangeError("Test scalar does not fit in 32 bytes.");
}

function mutateUnusedBase64UrlBits(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const remainder = value.length % 4;
  const unusedBits = remainder === 2 ? 4 : remainder === 3 ? 2 : 0;
  const last = value.at(-1);
  const index = last === undefined ? -1 : alphabet.indexOf(last);
  if (unusedBits === 0 || index < 0 || (index & ((1 << unusedBits) - 1)) !== 0) {
    throw new Error("Test value has no unused base64url bits.");
  }
  const alias = alphabet[index + 1];
  if (alias === undefined) throw new Error("Test base64url alias is unavailable.");
  return `${value.slice(0, -1)}${alias}`;
}

function compressP256Spki(spki: Buffer): Buffer {
  const x = spki.subarray(27, 59);
  const y = spki.subarray(59, 91);
  const tag = ((y.at(-1) ?? 0) & 1) === 0 ? 0x02 : 0x03;
  return Buffer.concat([
    Buffer.from([0x30, 0x39]),
    spki.subarray(2, 23),
    Buffer.from([0x03, 0x22, 0x00, tag]),
    x,
  ]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return stringifyTestJson(value);
  }
  if (typeof value === "string") return stringifyTestJson(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Unsupported test JSON value.");
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${stringifyTestJson(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function stringifyTestJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Unsupported test JSON value.");
  return serialized;
}

function asReceipt(value: unknown): ServerBindingReceiptV1 {
  return value as ServerBindingReceiptV1;
}

function asActiveStatus(value: unknown): ServerBindingActiveStatusV1 {
  return value as ServerBindingActiveStatusV1;
}

function asReceiptStatement(value: unknown): ServerBindingReceiptStatementV1 {
  return value as ServerBindingReceiptStatementV1;
}

function asActiveStatusStatement(value: unknown): ServerBindingActiveStatusStatementV1 {
  return value as ServerBindingActiveStatusStatementV1;
}

function expectContractErrorCode(
  action: () => unknown,
  code: ServerBindingAuthorityContractErrorCode,
): void {
  let captured: unknown;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(ServerBindingAuthorityContractError);
  expect((captured as ServerBindingAuthorityContractError).code).toBe(code);
}

function schemaProperties(schema: unknown): Readonly<Record<string, unknown>> {
  return (schema as { readonly properties: Readonly<Record<string, unknown>> }).properties;
}

interface ExportApiInspection {
  readonly forbidden: string[];
  readonly names: string[];
}

function inspectExportApi(source: string, fileName: string): ExportApiInspection {
  return withVirtualSourceFiles([{ fileName, source }], (sourceFiles) => {
    const sourceFile = sourceFiles.get(fileName);
    if (sourceFile === undefined) throw new Error(`Missing virtual AST for ${fileName}.`);
    return inspectExportSourceFile(sourceFile);
  });
}

function inspectExportSourceFile(sourceFile: ts.SourceFile): ExportApiInspection {
  const forbidden: string[] = [];
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      forbidden.push("export list or star");
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      forbidden.push("export default or assignment");
      continue;
    }
    if (ts.isNamespaceExportDeclaration(statement)) {
      forbidden.push("namespace export");
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      forbidden.push("default export modifier");
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
      continue;
    }
    if (
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isModuleDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      if (statement.name === undefined) forbidden.push("anonymous exported declaration");
      else names.push(statement.name.text);
      continue;
    }
    forbidden.push(`unsupported exported syntax ${ts.SyntaxKind[statement.kind]}`);
  }
  return { forbidden: forbidden.sort(), names: names.sort() };
}

function collectBindingNames(name: ts.BindingName, names: string[]): void {
  if (ts.isIdentifier(name)) {
    names.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element) && element.name !== undefined) {
      collectBindingNames(element.name, names);
    }
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as ts.Node & { readonly modifiers?: readonly ts.Node[] }).modifiers;
  return modifiers?.some((value) => value.kind === kind) ?? false;
}

interface AstSourceInput {
  readonly fileName: string;
  readonly source: string;
}

function inspectProductionModules(
  sources: readonly AstSourceInput[],
): ReadonlyMap<string, string[]> {
  return withVirtualSourceFiles(sources, (sourceFiles) => {
    const inspections = new Map<string, string[]>();
    for (const source of sources) {
      const sourceFile = sourceFiles.get(source.fileName);
      if (sourceFile === undefined) throw new Error(`Missing virtual AST for ${source.fileName}.`);
      inspections.set(source.fileName, inspectProductionSourceFile(sourceFile, source.fileName));
    }
    return inspections;
  });
}

function isAllowedServerBindingAuthorityImport(node: ts.Node, normalizedFileName: string): boolean {
  return (
    ts.isStringLiteralLikeNode(node) &&
    node.text === serverBindingAuthoritySubpath &&
    ts.isImportDeclaration(node.parent) &&
    node.parent.moduleSpecifier === node &&
    serverBindingAuthorityConsumerAllowlist.some(
      (suffix) => normalizedFileName === suffix.slice(1) || normalizedFileName.endsWith(suffix),
    )
  );
}

function inspectProductionSourceFile(
  sourceFile: ts.SourceFile,
  originalFileName: string,
): string[] {
  const violations = new Set<string>();
  const normalizedFileName = originalFileName.replaceAll("\\", "/").toLowerCase();
  const expectedExportApi = isAbsolute(originalFileName)
    ? [...sensitiveServerBindingConsumerExports.entries()].find(
        ([suffix]) => normalizedFileName === suffix.slice(1) || normalizedFileName.endsWith(suffix),
      )?.[1]
    : undefined;
  if (expectedExportApi !== undefined) {
    const inspection = inspectExportSourceFile(sourceFile);
    if (
      inspection.forbidden.length !== 0 ||
      JSON.stringify(inspection.names) !== JSON.stringify([...expectedExportApi].sort())
    ) {
      violations.add("sensitive consumer export API differs from its exact allowlist");
    }
  }
  const expectedSourceSha256 = isAbsolute(originalFileName)
    ? [...sensitiveServerBindingConsumerSourceSha256.entries()].find(
        ([suffix]) => normalizedFileName === suffix.slice(1) || normalizedFileName.endsWith(suffix),
      )?.[1]
    : undefined;
  if (expectedSourceSha256 !== undefined) {
    const normalizedSource = sourceFile.getFullText().replaceAll("\r\n", "\n");
    if (
      normalizedSource.includes("\r") ||
      normalizedSource.includes("\uFEFF") ||
      createHash("sha256").update(normalizedSource, "utf8").digest("hex") !== expectedSourceSha256
    ) {
      violations.add("sensitive consumer source differs from its reviewed digest");
    }
  }
  const expectedImports = isAbsolute(originalFileName)
    ? [...sensitiveServerBindingConsumerImports.entries()].find(
        ([suffix]) => normalizedFileName === suffix.slice(1) || normalizedFileName.endsWith(suffix),
      )?.[1]
    : undefined;
  if (expectedImports !== undefined) {
    const actualImports = sourceFile.statements
      .filter(ts.isImportDeclaration)
      .map((declaration) => {
        const moduleName = ts.isStringLiteralLikeNode(declaration.moduleSpecifier)
          ? declaration.moduleSpecifier.text
          : "invalid";
        return `${moduleName}|${importedBindingSignature(declaration)}`;
      })
      .sort();
    if (JSON.stringify(actualImports) !== JSON.stringify([...expectedImports].sort())) {
      violations.add("signer-host A1 import set differs from its exact allowlist");
    }
    for (const violation of inspectSignerHostA1PureModule(sourceFile)) violations.add(violation);
  }
  const loaderBindings = collectImportedLoaderBindings(sourceFile);
  const reflectGetAliases = collectReflectGetAliases(sourceFile);
  if (reflectGetAliases.size !== 0) {
    violations.add("Reflect.get loader-capable alias");
  }
  for (const violation of inspectSensitiveBindingExports(sourceFile)) {
    violations.add(violation);
  }
  const allowedLoaderBindingReferences = new Map<string, number>();
  let allowedWorkerCalls = 0;
  let allowedSpawnSyncCalls = 0;
  let allowedProcessHostSpawnCalls = 0;
  let allowedSignerHostSpawnCalls = 0;
  const inspectModuleSpecifier = (specifier: ts.Expression): void => {
    if (!ts.isStringLiteralLikeNode(specifier)) return;
    const candidates = [specifier.text, decodeStaticLiteral(specifier.getText(sourceFile))].map(
      (value) => value.replace(/^["'`]|["'`]$/gu, "").toLowerCase(),
    );
    if (
      candidates.some((value) => value.includes("server-binding-authority-v1")) &&
      !isAllowedServerBindingAuthorityImport(specifier, normalizedFileName)
    ) {
      violations.add("server binding authority import outside exact S1 allowlist");
    }
    for (const candidate of candidates) {
      const normalizedCandidate = candidate.replaceAll("\\", "/");
      if (
        /(?:^|\/)[^/]+\.(?:spec|test|testing)(?:\.[cm]?[jt]sx?)?(?:[?#].*)?$/u.test(
          normalizedCandidate,
        )
      ) {
        violations.add("production import of a test bridge");
      }
      const moduleName = sensitiveServerBindingModuleName(candidate);
      if (
        moduleName !== undefined &&
        !isAllowedSensitiveServerBindingConsumer(moduleName, normalizedFileName)
      ) {
        violations.add(`${moduleName} import outside exact S1 dependency allowlist`);
      }
    }
    if (
      candidates.some(
        (value) =>
          value === "module" ||
          value === "node:module" ||
          value === "vm" ||
          value.startsWith("node:vm"),
      )
    ) {
      violations.add("runtime loader module import");
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && findAncestor(node, ts.isImportDeclaration) === undefined) {
      const loaderKind = loaderBindings.get(node.text);
      if (loaderKind !== undefined) {
        if (isAllowedImportedLoaderReference(node, loaderKind, sourceFile, normalizedFileName)) {
          allowedLoaderBindingReferences.set(
            node.text,
            (allowedLoaderBindingReferences.get(node.text) ?? 0) + 1,
          );
        } else {
          violations.add(`${node.text} loader binding escaped its direct call target`);
        }
      }
    }
    const staticValue = staticStringValue(node);
    if (
      staticValue?.toLowerCase().includes("server-binding-authority-v1") === true &&
      !isAllowedServerBindingAuthorityImport(node, normalizedFileName)
    ) {
      violations.add("server binding authority sensitive literal outside exact S1 allowlist");
    }
    if (staticValue?.toLowerCase().includes(serverBindingSignerHostFixtureBasename) === true) {
      violations.add("production signer-host fixture reference");
    }
    if (staticValue?.toLowerCase().includes("--fixture-scenario=") === true) {
      violations.add("production signer-host fixture scenario selector");
    }
    if (ts.isIdentifier(node)) {
      const identifier = node.text.toLowerCase();
      if (
        identifier === "_load" ||
        identifier === "createrequire" ||
        identifier === "dlopen" ||
        identifier === "eval" ||
        identifier === "function" ||
        identifier === "getbuiltinmodule" ||
        identifier === "require"
      ) {
        violations.add(`${identifier} loader reference`);
      }
    }
    if (ts.isElementAccessExpression(node)) {
      const memberName = staticStringValue(node.argumentExpression)?.toLowerCase();
      if (
        memberName !== undefined &&
        [
          "_load",
          "createrequire",
          "dlopen",
          "eval",
          "function",
          "getbuiltinmodule",
          "require",
        ].includes(memberName)
      ) {
        violations.add(`${memberName} computed loader reference`);
      }
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) inspectModuleSpecifier(node.moduleSpecifier);
    }
    if (ts.isImportDeclaration(node)) {
      inspectLoaderImport(node, normalizedFileName, violations);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLikeNode(node.argument.literal)
    ) {
      inspectModuleSpecifier(node.argument.literal);
    }
    if (ts.isImportEqualsDeclaration(node)) violations.add("import equals loader");
    if (ts.isCallExpression(node)) {
      if (ts.isImportExpression(node.expression)) violations.add("dynamic import loader");
      const name = calledExpressionName(node.expression);
      if (name === "get" && expressionReceiverName(node.expression) === "reflect") {
        const receiver = node.arguments[0];
        const memberName =
          node.arguments[1] === undefined
            ? undefined
            : staticStringValue(node.arguments[1])?.toLowerCase();
        if (
          (receiver !== undefined &&
            ts.isIdentifier(receiver) &&
            ["globalthis", "module", "process"].includes(receiver.text.toLowerCase())) ||
          (memberName !== undefined &&
            [
              "_load",
              "createrequire",
              "dlopen",
              "function",
              "getbuiltinmodule",
              "require",
            ].includes(memberName))
        ) {
          violations.add("Reflect.get runtime loader escape");
        }
      }
      if (
        name === "apply" &&
        expressionReceiverName(node.expression) === "reflect" &&
        node.arguments[0] !== undefined &&
        isReflectGetReference(node.arguments[0], reflectGetAliases)
      ) {
        violations.add("Reflect.apply loader lookup escape");
      }
      if (
        name === "createrequire" ||
        name === "dlopen" ||
        name === "eval" ||
        name === "getbuiltinmodule" ||
        name === "require"
      ) {
        violations.add(`${name} runtime loader`);
      }
      if (name === "function") violations.add("Function runtime loader");
      if (name === "_load" && expressionReceiverName(node.expression) === "module") {
        violations.add("Module._load runtime loader");
      }
      if (
        name === "execfile" ||
        name === "execfilesync" ||
        name === "fork" ||
        name === "importscripts" ||
        name === "spawn" ||
        name === "spawnsync"
      ) {
        if (isAllowedSpawnSyncCall(node, sourceFile, normalizedFileName)) {
          allowedSpawnSyncCalls += 1;
        } else {
          violations.add(`${name} process or script loader`);
        }
      }
      if (name === "spawnchildprocess") {
        if (isAllowedProcessHostSpawnCall(node, sourceFile, normalizedFileName)) {
          allowedProcessHostSpawnCalls += 1;
        } else {
          violations.add("spawnChildProcess loader outside exact allowlist");
        }
      }
      if (name === "spawnsignerhostprocess") {
        if (isAllowedSignerHostSpawnCall(node, sourceFile, normalizedFileName)) {
          allowedSignerHostSpawnCalls += 1;
        } else {
          violations.add("spawnSignerHostProcess loader outside exact allowlist");
        }
      }
    }
    if (ts.isNewExpression(node) && calledExpressionName(node.expression) === "worker") {
      if (isAllowedWorkerCall(node, sourceFile, normalizedFileName)) {
        allowedWorkerCalls += 1;
      } else {
        violations.add("Worker loader");
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text.toLowerCase() === "function"
    ) {
      violations.add("Function runtime loader");
    }
    node.forEachChild((child) => {
      visit(child);
      return undefined;
    });
  };
  visit(sourceFile);
  const expectedWorkerCalls =
    normalizedFileName.endsWith("/apps/server/src/artifacts/artifact-storage-client.ts") ||
    normalizedFileName.endsWith("/apps/server/src/database/database-client.ts")
      ? 1
      : 0;
  const expectedSpawnSyncCalls = normalizedFileName.endsWith(
    "/apps/worker/scripts/build-worker-bundles.mjs",
  )
    ? 1
    : 0;
  const expectedProcessHostSpawnCalls = normalizedFileName.endsWith(
    "/apps/worker/src/execution/process-host-client.ts",
  )
    ? 1
    : 0;
  const expectedSignerHostSpawnCalls = matchesNormalizedFileSuffix(
    normalizedFileName,
    "/apps/server/src/enrollment/server-binding-signer-host-client-v1.ts",
  )
    ? 1
    : 0;
  if (
    allowedWorkerCalls !== expectedWorkerCalls ||
    allowedSpawnSyncCalls !== expectedSpawnSyncCalls ||
    allowedProcessHostSpawnCalls !== expectedProcessHostSpawnCalls ||
    allowedSignerHostSpawnCalls !== expectedSignerHostSpawnCalls
  ) {
    violations.add("exact loader allowlist call count mismatch");
  }
  for (const binding of loaderBindings.keys()) {
    if ((allowedLoaderBindingReferences.get(binding) ?? 0) !== 1) {
      violations.add(`${binding} loader binding reference count mismatch`);
    }
  }
  return [...violations].sort();
}

function sensitiveServerBindingModuleName(specifier: string): string | undefined {
  let normalized = specifier.replaceAll("\\", "/").toLowerCase();
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Invalid percent encoding remains unmatched and is rejected by ordinary module resolution.
  }
  const suffixStart = normalized.search(/[?#]/u);
  if (suffixStart >= 0) normalized = normalized.slice(0, suffixStart);
  for (const moduleName of sensitiveServerBindingModuleConsumers.keys()) {
    if (
      normalized === moduleName ||
      normalized.endsWith(`/${moduleName}`) ||
      normalized.endsWith(`/${moduleName}.js`) ||
      normalized.endsWith(`/${moduleName}.ts`)
    ) {
      return moduleName;
    }
  }
  return undefined;
}

function isAllowedSensitiveServerBindingConsumer(
  moduleName: string,
  normalizedFileName: string,
): boolean {
  return (
    sensitiveServerBindingModuleConsumers
      .get(moduleName)
      ?.some(
        (suffix) => normalizedFileName === suffix.slice(1) || normalizedFileName.endsWith(suffix),
      ) ?? false
  );
}

function inspectSensitiveBindingExports(sourceFile: ts.SourceFile): string[] {
  const taintedBindings = collectSensitiveImportedBindings(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer !== undefined &&
            exposesSensitiveBinding(declaration.initializer, taintedBindings) &&
            !taintedBindings.has(declaration.name.text)
          ) {
            taintedBindings.add(declaration.name.text);
            changed = true;
          }
        }
      }
      if (
        ts.isExpressionStatement(statement) &&
        ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(statement.expression.left) &&
        exposesSensitiveBinding(statement.expression.right, taintedBindings) &&
        !taintedBindings.has(statement.expression.left.text)
      ) {
        taintedBindings.add(statement.expression.left.text);
        changed = true;
      }
    }
  }

  const violations: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLikeNode(statement.moduleSpecifier) &&
      (statement.moduleSpecifier.text.toLowerCase() === serverBindingAuthoritySubpath ||
        sensitiveServerBindingModuleName(statement.moduleSpecifier.text) !== undefined)
    ) {
      violations.push("sensitive module direct re-export");
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        if (taintedBindings.has(localName)) {
          violations.push(`${localName} sensitive imported binding re-export`);
        }
      }
    }
    if (
      ts.isExportAssignment(statement) &&
      exposesSensitiveBinding(statement.expression, taintedBindings)
    ) {
      violations.push("sensitive imported binding export assignment");
    }
    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          declaration.initializer !== undefined &&
          exposesSensitiveBinding(declaration.initializer, taintedBindings)
        ) {
          violations.push("sensitive imported binding exported through a variable");
        }
      }
    }
    if (
      ts.isFunctionDeclaration(statement) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      statement.body !== undefined &&
      blockReturnsSensitiveBinding(statement.body, taintedBindings)
    ) {
      violations.push("sensitive imported binding returned by an exported function");
    }
    if (ts.isClassDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const member of statement.members) {
        if (
          ts.isPropertyDeclaration(member) &&
          member.initializer !== undefined &&
          exposesSensitiveBinding(member.initializer, taintedBindings)
        ) {
          violations.push("sensitive imported binding exported through a class field");
        }
        if (
          member.body !== undefined &&
          blockReturnsSensitiveBinding(member.body, taintedBindings)
        ) {
          violations.push("sensitive imported binding returned by an exported class member");
        }
      }
    }
  }
  return violations;
}

function collectSensitiveImportedBindings(sourceFile: ts.SourceFile): Set<string> {
  const bindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLikeNode(statement.moduleSpecifier) ||
      statement.importClause === undefined
    ) {
      continue;
    }
    const moduleName = statement.moduleSpecifier.text.toLowerCase();
    if (
      moduleName !== serverBindingAuthoritySubpath &&
      sensitiveServerBindingModuleName(moduleName) === undefined
    ) {
      continue;
    }
    if (statement.importClause.name !== undefined) {
      bindings.add(statement.importClause.name.text);
    }
    const namedBindings = statement.importClause.namedBindings;
    if (namedBindings === undefined) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      bindings.add(namedBindings.name.text);
      continue;
    }
    for (const element of namedBindings.elements) bindings.add(element.name.text);
  }
  return bindings;
}

function collectReflectGetAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        isReflectGetReference(node.initializer, aliases) &&
        !aliases.has(node.name.text)
      ) {
        aliases.add(node.name.text);
        changed = true;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        isReflectGetReference(node.right, aliases) &&
        !aliases.has(node.left.text)
      ) {
        aliases.add(node.left.text);
        changed = true;
      }
      node.forEachChild((child) => {
        visit(child);
        return undefined;
      });
    };
    visit(sourceFile);
  }
  return aliases;
}

function isReflectGetReference(expression: ts.Expression, aliases: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(expression)) return aliases.has(expression.text);
  if (ts.isParenthesizedExpression(expression)) {
    return isReflectGetReference(expression.expression, aliases);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text.toLowerCase() === "reflect" &&
      expression.name.text.toLowerCase() === "get"
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    return (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text.toLowerCase() === "reflect" &&
      staticStringValue(expression.argumentExpression)?.toLowerCase() === "get"
    );
  }
  return false;
}

function exposesSensitiveBinding(
  expression: ts.Expression,
  bindings: ReadonlySet<string>,
): boolean {
  if (ts.isIdentifier(expression)) return bindings.has(expression.text);
  if (ts.isParenthesizedExpression(expression)) {
    return exposesSensitiveBinding(expression.expression, bindings);
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertion(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return exposesSensitiveBinding(expression.expression, bindings);
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return exposesSensitiveBinding(expression.expression, bindings);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.some(
      (element) => !ts.isOmittedExpression(element) && exposesSensitiveBinding(element, bindings),
    );
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) return bindings.has(property.name.text);
      if (ts.isPropertyAssignment(property)) {
        return exposesSensitiveBinding(property.initializer, bindings);
      }
      if (ts.isSpreadAssignment(property))
        return exposesSensitiveBinding(property.expression, bindings);
      return false;
    });
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      exposesSensitiveBinding(expression.whenTrue, bindings) ||
      exposesSensitiveBinding(expression.whenFalse, bindings)
    );
  }
  if (ts.isArrowFunction(expression) && !ts.isBlock(expression.body)) {
    return exposesSensitiveBinding(expression.body, bindings);
  }
  if (ts.isArrowFunction(expression) && ts.isBlock(expression.body)) {
    return blockReturnsSensitiveBinding(expression.body, bindings);
  }
  return false;
}

function blockReturnsSensitiveBinding(block: ts.Block, bindings: ReadonlySet<string>): boolean {
  let escaped = false;
  const visit = (node: ts.Node): void => {
    if (escaped || (node !== block && isFunctionLikeNode(node))) return;
    if (
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      exposesSensitiveBinding(node.expression, bindings)
    ) {
      escaped = true;
      return;
    }
    node.forEachChild((child) => {
      visit(child);
      return undefined;
    });
  };
  visit(block);
  return escaped;
}

function isFunctionLikeNode(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function inspectSignerHostA1PureModule(sourceFile: ts.SourceFile): string[] {
  const violations = new Set<string>();
  const source = sourceFile.getFullText();
  if (
    /BEGIN (?:EC |RSA |ENCRYPTED |OPENSSH )?PRIVATE KEY|\bcreatePrivateKey\b|\bgenerateKeyPair(?:Sync)?\b|\bprivateKey\b|\bprivate_key\b|\bpkcs8\b|\bjwk\b/iu.test(
      source,
    )
  ) {
    violations.add("signer-host A1 pure module contains private-key material or API names");
  }

  const forbiddenCalls = new Set([
    "derivebits",
    "derivekey",
    "fetch",
    "generatekey",
    "generatekeypair",
    "generatekeypairsync",
    "importkey",
    "open",
    "sign",
    "unwrapkey",
  ]);
  const forbiddenConstructors = new Set(["eventsource", "websocket", "xmlhttprequest"]);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callName = calledExpressionName(node.expression);
      if (callName !== undefined && forbiddenCalls.has(callName)) {
        violations.add("signer-host A1 pure module contains signing or I/O call");
      }
    }
    if (ts.isNewExpression(node)) {
      const constructorName = calledExpressionName(node.expression);
      if (constructorName !== undefined && forbiddenConstructors.has(constructorName)) {
        violations.add("signer-host A1 pure module contains I/O construction");
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text.toLowerCase() === "process" &&
      ["env", "stderr", "stdin", "stdout"].includes(node.name.text.toLowerCase())
    ) {
      violations.add("signer-host A1 pure module contains process I/O access");
    }
    node.forEachChild((child) => {
      visit(child);
      return undefined;
    });
  };
  visit(sourceFile);
  return [...violations].sort();
}

type ImportedLoaderKind = "process-host-spawn" | "signer-host-spawn" | "spawn-sync" | "worker";

function collectImportedLoaderBindings(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, ImportedLoaderKind> {
  const bindings = new Map<string, ImportedLoaderKind>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLikeNode(statement.moduleSpecifier) ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    const moduleName = statement.moduleSpecifier.text.toLowerCase();
    for (const element of statement.importClause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName?.text ?? element.name.text).toLowerCase();
      if (
        (moduleName === "node:worker_threads" || moduleName === "worker_threads") &&
        imported === "worker"
      ) {
        bindings.set(element.name.text, "worker");
      }
      if (moduleName === "node:child_process" || moduleName === "child_process") {
        if (imported === "spawnsync") bindings.set(element.name.text, "spawn-sync");
        if (imported === "spawn") {
          bindings.set(
            element.name.text,
            element.name.text === "spawnSignerHostProcess"
              ? "signer-host-spawn"
              : "process-host-spawn",
          );
        }
      }
    }
  }
  return bindings;
}

function isAllowedImportedLoaderReference(
  identifier: ts.Identifier,
  kind: ImportedLoaderKind,
  sourceFile: ts.SourceFile,
  normalizedFileName: string,
): boolean {
  const parent = identifier.parent;
  if (kind === "worker" && ts.isNewExpression(parent) && parent.expression === identifier) {
    return isAllowedWorkerCall(parent, sourceFile, normalizedFileName);
  }
  if (kind === "spawn-sync" && ts.isCallExpression(parent) && parent.expression === identifier) {
    return isAllowedSpawnSyncCall(parent, sourceFile, normalizedFileName);
  }
  if (
    kind === "process-host-spawn" &&
    ts.isCallExpression(parent) &&
    parent.expression === identifier
  ) {
    return isAllowedProcessHostSpawnCall(parent, sourceFile, normalizedFileName);
  }
  if (
    kind === "signer-host-spawn" &&
    ts.isCallExpression(parent) &&
    parent.expression === identifier
  ) {
    return isAllowedSignerHostSpawnCall(parent, sourceFile, normalizedFileName);
  }
  return false;
}

function staticStringValue(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLikeNode(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticStringValue(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticStringValue(span.expression);
      if (expression === undefined) return undefined;
      value += `${expression}${span.literal.text}`;
    }
    return value;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "join" &&
    ts.isArrayLiteralExpression(node.expression.expression) &&
    (node.arguments.length === 0 ||
      (node.arguments.length === 1 && staticStringValue(node.arguments[0] as ts.Node) === ""))
  ) {
    const parts = node.expression.expression.elements.map((element) => staticStringValue(element));
    return parts.some((part) => part === undefined) ? undefined : parts.join("");
  }
  return undefined;
}

function inspectLoaderImport(
  declaration: ts.ImportDeclaration,
  normalizedFileName: string,
  violations: Set<string>,
): void {
  if (!ts.isStringLiteralLikeNode(declaration.moduleSpecifier)) return;
  const moduleName = declaration.moduleSpecifier.text.toLowerCase();
  if (moduleName === "node:child_process" || moduleName === "child_process") {
    const expected = normalizedFileName.endsWith("/apps/worker/scripts/build-worker-bundles.mjs")
      ? "spawnSync:spawnSync:value"
      : normalizedFileName.endsWith("/apps/worker/src/execution/process-host-client.ts")
        ? "ChildProcessWithoutNullStreams:ChildProcessWithoutNullStreams:type,spawn:spawnChildProcess:value"
        : matchesNormalizedFileSuffix(
              normalizedFileName,
              "/apps/server/src/enrollment/server-binding-signer-host-client-v1.ts",
            )
          ? "ChildProcessWithoutNullStreams:ChildProcessWithoutNullStreams:type,spawn:spawnSignerHostProcess:value"
          : undefined;
    if (expected === undefined || importedBindingSignature(declaration) !== expected) {
      violations.add("child_process import outside exact allowlist");
    }
  }
  if (moduleName === "node:worker_threads" || moduleName === "worker_threads") {
    const expected = normalizedFileName.endsWith(
      "/apps/server/src/artifacts/artifact-storage-client.ts",
    )
      ? "Worker:Worker:value,WorkerOptions:WorkerOptions:type"
      : normalizedFileName.endsWith("/apps/server/src/database/database-client.ts")
        ? "Worker:Worker:value"
        : normalizedFileName.endsWith("/apps/server/src/artifacts/artifact-storage-worker.ts") ||
            normalizedFileName.endsWith("/apps/server/src/database/database-worker.ts")
          ? "parentPort:parentPort:value,workerData:workerData:value"
          : undefined;
    if (expected === undefined || importedBindingSignature(declaration) !== expected) {
      violations.add("worker_threads import outside exact allowlist");
    }
  }
}

function importedBindingSignature(declaration: ts.ImportDeclaration): string {
  const clause = declaration.importClause;
  const phaseModifier = clause?.phaseModifier as ts.Node | ts.SyntaxKind | undefined;
  const phaseModifierKind = typeof phaseModifier === "number" ? phaseModifier : phaseModifier?.kind;
  if (
    clause === undefined ||
    clause.name !== undefined ||
    (phaseModifierKind !== undefined && phaseModifierKind !== ts.SyntaxKind.TypeKeyword) ||
    clause.namedBindings === undefined ||
    !ts.isNamedImports(clause.namedBindings)
  ) {
    return "invalid";
  }
  const clauseIsTypeOnly = clause.isTypeOnly || phaseModifierKind === ts.SyntaxKind.TypeKeyword;
  return clause.namedBindings.elements
    .map((element) => {
      const imported = element.propertyName?.text ?? element.name.text;
      return `${imported}:${element.name.text}:${clauseIsTypeOnly || element.isTypeOnly ? "type" : "value"}`;
    })
    .sort()
    .join(",");
}

function isAllowedWorkerCall(
  expression: ts.NewExpression,
  sourceFile: ts.SourceFile,
  normalizedFileName: string,
): boolean {
  if (
    normalizedFileName.endsWith("/apps/server/src/artifacts/artifact-storage-client.ts") &&
    compactNodeText(expression, sourceFile) === "newWorker(filename,options)"
  ) {
    const arrow = findAncestor(expression, ts.isArrowFunction);
    const declaration = arrow?.parent;
    return (
      arrow !== undefined &&
      declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === "defaultWorkerFactory" &&
      declaration.initializer === arrow &&
      compactNodeText(arrow, sourceFile) ===
        "(filename,options)=>newWorker(filename,options)asArtifactStorageWorkerTransport"
    );
  }
  if (
    normalizedFileName.endsWith("/apps/server/src/database/database-client.ts") &&
    compactNodeText(expression, sourceFile) === "newWorker(workerUrl,{workerData:options})"
  ) {
    const constructorDeclaration = findAncestor(expression, ts.isConstructorDeclaration);
    const containingClass =
      constructorDeclaration === undefined
        ? undefined
        : findAncestor(constructorDeclaration, ts.isClassDeclaration);
    const initializer =
      constructorDeclaration === undefined
        ? undefined
        : findUniqueVariableInitializer(constructorDeclaration, "workerUrl");
    return (
      constructorDeclaration !== undefined &&
      containingClass?.name?.text === "DatabaseClient" &&
      initializer !== undefined &&
      compactNodeText(initializer, sourceFile) ===
        'import.meta.url.endsWith(".ts")?newURL("./database-worker.ts",import.meta.url):newURL("./database-worker.js",import.meta.url)'
    );
  }
  return false;
}

function isAllowedSpawnSyncCall(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  normalizedFileName: string,
): boolean {
  if (
    !normalizedFileName.endsWith("/apps/worker/scripts/build-worker-bundles.mjs") ||
    calledExpressionName(expression.expression) !== "spawnsync" ||
    compactNodeText(expression, sourceFile) !==
      'spawnSync(process.execPath,[compiler,"-p","tsconfig.json","--noEmit"],{cwd:workerRoot,encoding:"utf8",windowsHide:true,})'
  ) {
    return false;
  }
  const functionDeclaration = findAncestor(expression, ts.isFunctionDeclaration);
  if (functionDeclaration?.name?.text !== "typecheckWorker") return false;
  const packageInitializer = findUniqueVariableInitializer(
    functionDeclaration,
    "typeScriptPackage",
  );
  const compilerInitializer = findUniqueVariableInitializer(functionDeclaration, "compiler");
  return (
    packageInitializer !== undefined &&
    compilerInitializer !== undefined &&
    compactNodeText(packageInitializer, sourceFile) ===
      'fileURLToPath(import.meta.resolve("typescript/package.json"))' &&
    compactNodeText(compilerInitializer, sourceFile) ===
      'resolve(dirname(typeScriptPackage),"bin/tsc")'
  );
}

function isAllowedProcessHostSpawnCall(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  normalizedFileName: string,
): boolean {
  if (
    !normalizedFileName.endsWith("/apps/worker/src/execution/process-host-client.ts") ||
    compactNodeText(expression, sourceFile) !==
      'spawnChildProcess(executable,[...argumentsList],{cwd:options.cwd,env:options.env,shell:false,windowsHide:true,detached:false,stdio:["pipe","pipe","pipe"],})'
  ) {
    return false;
  }
  const arrow = findAncestor(expression, ts.isArrowFunction);
  const declaration = arrow?.parent;
  return (
    arrow !== undefined &&
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === "defaultSpawnProcess" &&
    declaration.initializer === arrow &&
    compactNodeText(arrow, sourceFile) ===
      '(executable,argumentsList,options)=>spawnChildProcess(executable,[...argumentsList],{cwd:options.cwd,env:options.env,shell:false,windowsHide:true,detached:false,stdio:["pipe","pipe","pipe"],})'
  );
}

function isAllowedSignerHostSpawnCall(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  normalizedFileName: string,
): boolean {
  if (
    !matchesNormalizedFileSuffix(
      normalizedFileName,
      "/apps/server/src/enrollment/server-binding-signer-host-client-v1.ts",
    ) ||
    compactNodeText(expression, sourceFile) !==
      'spawnSignerHostProcess(profile.executablePath,[...profile.arguments],{cwd:profile.workingDirectory,detached:false,env:emptySignerHostEnvironment,shell:false,stdio:["pipe","pipe","pipe"],windowsHide:true,})'
  ) {
    return false;
  }
  const method = findAncestor(expression, ts.isMethodDeclaration);
  return method?.name.getText(sourceFile) === "#initialize";
}

function matchesNormalizedFileSuffix(normalizedFileName: string, suffix: string): boolean {
  return normalizedFileName === suffix.slice(1) || normalizedFileName.endsWith(suffix);
}

function compactNodeText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/gu, "");
}

function findAncestor<TNode extends ts.Node>(
  node: ts.Node,
  predicate: (candidate: ts.Node) => candidate is TNode,
): TNode | undefined {
  let current = node.parent as ts.Node | undefined;
  while (current !== undefined && current !== current.parent) {
    if (predicate(current)) return current;
    current = current.parent as ts.Node | undefined;
  }
  return undefined;
}

function findUniqueVariableInitializer(root: ts.Node, name: string): ts.Expression | undefined {
  const matches: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      matches.push(node.initializer);
    }
    node.forEachChild((child) => {
      visit(child);
      return undefined;
    });
  };
  visit(root);
  return matches.length === 1 ? matches[0] : undefined;
}

function withVirtualSourceFiles<T>(
  sources: readonly AstSourceInput[],
  inspect: (sourceFiles: ReadonlyMap<string, ts.SourceFile>) => T,
): T {
  const virtualRoot = resolve(process.cwd(), ".server-binding-authority-ast").replaceAll("\\", "/");
  const configPath = `${virtualRoot}/tsconfig.json`;
  const virtualPaths = sources.map(
    (source, index) => `${virtualRoot}/source-${index}${sourceFileExtension(source.fileName)}`,
  );
  const virtualFiles: Record<string, string> = {
    [configPath]: JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: false },
      files: virtualPaths,
    }),
  };
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const virtualPath = virtualPaths[index];
    if (source === undefined || virtualPath === undefined) {
      throw new Error("Virtual AST source indexing failed.");
    }
    virtualFiles[virtualPath] = source.source;
  }

  const api = new TypeScriptApi({
    cwd: virtualRoot,
    fs: createVirtualFileSystem(virtualFiles),
  });
  try {
    const snapshot = api.updateSnapshot({
      openFiles: virtualPaths,
      openProjects: [configPath],
    });
    try {
      const sourceFiles = new Map<string, ts.SourceFile>();
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        const virtualPath = virtualPaths[index];
        if (source === undefined || virtualPath === undefined) {
          throw new Error("Virtual AST source indexing failed.");
        }
        const project = snapshot.getDefaultProjectForFile(virtualPath);
        const sourceFile = project?.program.getSourceFile(virtualPath);
        if (sourceFile === undefined)
          throw new Error(`TypeScript did not parse ${source.fileName}.`);
        sourceFiles.set(source.fileName, sourceFile);
      }
      return inspect(sourceFiles);
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

function sourceFileExtension(fileName: string): string {
  return fileName.toLowerCase().match(/\.(?:[cm]?[jt]s|[jt]sx)$/u)?.[0] ?? ".ts";
}

function calledExpressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text.toLowerCase();
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text.toLowerCase();
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLikeNode(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text.toLowerCase();
  }
  return undefined;
}

function expressionReceiverName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text.toLowerCase();
  }
  if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text.toLowerCase();
  }
  return undefined;
}

function decodeStaticLiteral(value: string): string {
  return value
    .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (_match, hexadecimal: string) =>
      codePointForScan(hexadecimal),
    )
    .replace(/\\u([0-9a-f]{4})/giu, (_match, hexadecimal: string) => codePointForScan(hexadecimal))
    .replace(/\\x([0-9a-f]{2})/giu, (_match, hexadecimal: string) => codePointForScan(hexadecimal));
}

function codePointForScan(hexadecimal: string): string {
  const value = Number.parseInt(hexadecimal, 16);
  return Number.isSafeInteger(value) && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "invalid-code-point";
}

function productionSourceFiles(root: string): string[] {
  const skippedDirectories = new Set([
    ".git",
    ".turbo",
    ".umi",
    ".umi-production",
    "coverage",
    "dist",
    "node_modules",
  ]);
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) visit(path);
        continue;
      }
      if (
        !entry.isFile() ||
        !/\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(entry.name) ||
        /\.(?:spec|test)\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(entry.name)
      ) {
        continue;
      }
      if (path.replaceAll("\\", "/").toLowerCase().endsWith(serverBindingSignerHostFixtureSuffix)) {
        continue;
      }
      files.push(path);
    }
  };
  visit(root);
  return files.sort();
}
