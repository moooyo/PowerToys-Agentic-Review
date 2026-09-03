import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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
  verifyServerBindingReceiptWithSpkiV1,
} from "@agentic-review/contracts/server-binding-authority-v1";
import {
  createAbsentServerBindingStateV1,
  reduceServerBindingStateV1,
  type ServerBindingImmutableBasisV1,
  type ServerBindingReceiptSnapshotV1,
  type ServerBindingRevocationReasonV1,
  type ServerBindingStateV1,
} from "../enrollment/server-binding-state-v1.js";

const issuanceRequestDomain = "AgenticReview Server binding issuance request v1";
const revocationRequestDomain = "AgenticReview Server binding revocation request v1";
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/u;
const sha256 = /^[0-9a-f]{64}(?![\s\S])/u;
const entityId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
const packageComponentId = /^[a-z0-9][a-z0-9._+-]{0,127}(?![\s\S])/u;
const utcMilliseconds = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u;
const dosReservedBaseName =
  /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/u;
const issuanceRequestKeys = [
  "authorizationExpiresAt",
  "authorizationId",
  "enrollmentGeneration",
  "expectedCertificateDerSha256",
  "installationId",
  "issuerKeyId",
  "observedCertificateDerSha256",
  "operatorIssuer",
  "operatorSubject",
  "requestId",
  "tokenSha256",
  "workerNodeId",
] as const;
const revocationRequestKeys = ["bindingId", "reasonCode", "revocationId"] as const;
const auditPageSize = 256;
const expectedSchemaRowCount = 35;
const expectedSchemaSha256 = "11ee090c82850cc364523ca074510aa5eaff9b36284413dc3e9d081b8849a269";
const expectedPersistentTriggerCount = 86;
const expectedPersistentTriggerSha256 =
  "e96d19557d5dd3a2db33fa5e34527b1c5061a35a4f2d8482e84b36172fe7ea61";

export type ServerBindingPersistenceErrorCodeV1 =
  | "SERVER_BINDING_AUTHORIZATION_EXPIRED"
  | "SERVER_BINDING_IMMUTABLE_CONFLICT"
  | "SERVER_BINDING_INVALID_INPUT"
  | "SERVER_BINDING_PERSISTENCE_UNAVAILABLE"
  | "SERVER_BINDING_SIGNER_MISMATCH"
  | "SERVER_BINDING_SIGNER_UNAVAILABLE"
  | "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE"
  | "SERVER_BINDING_TERMINAL_REVOKED"
  | "SERVER_BINDING_TRANSITION_INVALID";

export class ServerBindingPersistenceErrorV1 extends Error {
  public constructor(
    public readonly code: ServerBindingPersistenceErrorCodeV1,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ServerBindingPersistenceErrorV1";
  }
}

export interface ServerBindingTrustedIssuerDescriptorV1 {
  readonly authoritySchemaVersion: typeof SERVER_BINDING_AUTHORITY_SCHEMA_VERSION;
  readonly issuer: typeof SERVER_BINDING_AUTHORITY_ISSUER;
  readonly receiptProfileId: typeof SERVER_BINDING_RECEIPT_PROFILE_ID;
  readonly activeStatusProfileId: typeof SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID;
  readonly signatureAlgorithm: typeof SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM;
  readonly issuerKeyId: string;
  readonly issuerPublicKeySpki: Uint8Array;
}

export interface ServerBindingIssuerSnapshotV1 {
  readonly authoritySchemaVersion: 1;
  readonly issuer: typeof SERVER_BINDING_AUTHORITY_ISSUER;
  readonly receiptProfileId: typeof SERVER_BINDING_RECEIPT_PROFILE_ID;
  readonly activeStatusProfileId: typeof SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID;
  readonly signatureAlgorithm: typeof SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM;
  readonly issuerKeyId: string;
  readonly initializedAt: string;
}

export interface CreateServerBindingAuthorizationV1Input {
  readonly authorizationId: string;
  readonly requestId: string;
  readonly tokenSha256: string;
  readonly operatorIssuer: string;
  readonly operatorSubject: string;
  readonly workerNodeId: string;
  readonly installationId: string;
  readonly enrollmentGeneration: 1;
  readonly expectedCertificateDerSha256: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ServerBindingAuthorizationSnapshotV1
  extends CreateServerBindingAuthorizationV1Input {
  readonly issuerKeyId: string;
  readonly consumption: Readonly<{
    readonly bindingId: string;
    readonly issuanceRequestSha256: string;
    readonly consumedAt: string;
  }> | null;
}

export interface CreateServerBindingAuthorizationV1Result {
  readonly outcome: "created" | "replayed";
  readonly authorization: Readonly<ServerBindingAuthorizationSnapshotV1>;
}

export interface ClaimServerBindingAuthorizationV1Input {
  readonly requestId: string;
  readonly tokenSha256: string;
  readonly observedCertificateDerSha256: string;
}

export interface ServerBindingClaimSnapshotV1 {
  readonly authorizationId: string;
  readonly basis: Readonly<ServerBindingImmutableBasisV1>;
}

export type ClaimServerBindingAuthorizationV1Result =
  | Readonly<{
      outcome: "signing_pending";
      claim: Readonly<ServerBindingClaimSnapshotV1>;
    }>
  | Readonly<{
      outcome: "receipt_replay";
      retainedPhase: "reserved" | "active";
      claim: Readonly<ServerBindingClaimSnapshotV1>;
      receipt: Readonly<ServerBindingReceiptSnapshotV1>;
    }>;

export interface CommitServerBindingReceiptV1Input {
  readonly bindingId: string;
  readonly issuanceRequestSha256: string;
  readonly receiptJson: string;
}

export interface CommitServerBindingReceiptV1Result {
  readonly outcome: "committed" | "replayed";
  readonly retainedPhase: "reserved" | "active";
  readonly receipt: Readonly<ServerBindingReceiptSnapshotV1>;
}

export interface ConfirmServerBindingRecordV1Input {
  readonly bindingId: string;
  readonly bindingRevision: 1;
  readonly workerNodeId: string;
  readonly installationId: string;
  readonly enrollmentGeneration: 1;
  readonly certificateDerSha256: string;
  readonly recordDocumentSha256: string;
}

export interface ConfirmServerBindingRecordV1Result {
  readonly outcome: "confirmed" | "replayed";
  readonly bindingId: string;
  readonly recordDocumentSha256: string;
}

export interface ReadServerBindingRecoveryReceiptV1Input {
  readonly certificateDerSha256: string;
}

export interface ServerBindingRecoveryReceiptV1 {
  readonly bindingId: string;
  readonly bindingRevision: 1;
  readonly phase: "reserved" | "active";
  readonly receiptJson: string;
  readonly receiptSha256: string;
}

export interface ServerBindingActiveSnapshotV1 {
  readonly bindingId: string;
  readonly bindingRevision: 1;
  readonly workerNodeId: string;
  readonly installationId: string;
  readonly enrollmentGeneration: 1;
  readonly certificateDerSha256: string;
  readonly issuerKeyId: string;
  readonly receiptSha256: string;
  readonly recordDocumentSha256: string;
}

export interface RevokeServerBindingV1Input {
  readonly revocationId: string;
  readonly bindingId: string;
  readonly reasonCode: ServerBindingRevocationReasonV1;
}

export interface RevokeServerBindingV1Result {
  readonly outcome: "revoked" | "replayed";
  readonly revocationId: string;
  readonly revocationRequestSha256: string;
  readonly bindingId: string;
  readonly priorPhase: "signing_pending" | "reserved" | "active";
  readonly reasonCode: ServerBindingRevocationReasonV1;
  readonly revokedAt: string;
}

export interface ServerBindingPersistenceAuditResultV1 {
  readonly state: "uninitialized" | "initialized";
  readonly issuer: Readonly<ServerBindingIssuerSnapshotV1> | null;
  readonly authorizationCount: number;
  readonly bindingCount: number;
  readonly revocationCount: number;
}

export interface InitializeServerBindingIssuerV1Result {
  readonly outcome: "initialized" | "replayed";
  readonly issuer: Readonly<ServerBindingIssuerSnapshotV1>;
}

export interface InitializeServerBindingIssuerV1Input {
  readonly expectedIssuerKeyId: string;
}

export interface ServerBindingIssuanceRequestBasisV1 {
  readonly authorizationExpiresAt: string;
  readonly authorizationId: string;
  readonly enrollmentGeneration: 1;
  readonly expectedCertificateDerSha256: string;
  readonly installationId: string;
  readonly issuerKeyId: string;
  readonly observedCertificateDerSha256: string;
  readonly operatorIssuer: string;
  readonly operatorSubject: string;
  readonly requestId: string;
  readonly tokenSha256: string;
  readonly workerNodeId: string;
}

export interface ServerBindingRevocationRequestBasisV1 {
  readonly bindingId: string;
  readonly reasonCode: ServerBindingRevocationReasonV1;
  readonly revocationId: string;
}

interface TrustedIssuerSnapshotV1 extends ServerBindingTrustedIssuerDescriptorV1 {
  readonly issuerPublicKeySpki: Uint8Array;
}

interface IssuerRow {
  readonly singleton_id: number;
  readonly authority_schema_version: number;
  readonly issuer: string;
  readonly receipt_profile_id: string;
  readonly active_status_profile_id: string;
  readonly signature_algorithm: string;
  readonly issuer_key_id: string;
  readonly initialized_at: string;
}

interface AuthorizationRow {
  readonly authorization_id: string;
  readonly request_id: string;
  readonly token_sha256: string;
  readonly operator_issuer: string;
  readonly operator_subject: string;
  readonly worker_node_id: string;
  readonly installation_id: string;
  readonly enrollment_generation: number;
  readonly expected_certificate_der_sha256: string;
  readonly issuer_key_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly consumed_binding_id: string | null;
  readonly consumed_issuance_request_sha256: string | null;
  readonly consumed_at: string | null;
}

interface BindingRow {
  readonly binding_id: string;
  readonly binding_revision: number;
  readonly authorization_id: string;
  readonly request_id: string;
  readonly issuance_request_sha256: string;
  readonly worker_node_id: string;
  readonly installation_id: string;
  readonly enrollment_generation: number;
  readonly certificate_der_sha256: string;
  readonly issuer_key_id: string;
  readonly phase: "signing_pending" | "reserved" | "active" | "revoked";
  readonly bound_at: string;
  readonly statement_json: string;
  readonly statement_document_sha256: string;
  readonly receipt_json: string | null;
  readonly receipt_sha256: string | null;
  readonly record_document_sha256: string | null;
}

interface RevocationRow {
  readonly revocation_id: string;
  readonly revocation_request_sha256: string;
  readonly binding_id: string;
  readonly prior_phase: "signing_pending" | "reserved" | "active";
  readonly reason_code: ServerBindingRevocationReasonV1;
  readonly revoked_at: string;
}

interface SchemaRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

interface VerifiedAggregateV1 {
  readonly authorization: Readonly<ServerBindingAuthorizationSnapshotV1>;
  readonly binding: BindingRow;
  readonly basis: Readonly<ServerBindingImmutableBasisV1>;
  readonly state: Readonly<ServerBindingStateV1>;
  readonly receipt: Readonly<ServerBindingReceiptSnapshotV1> | null;
  readonly revocation: RevocationRow | null;
}

const persistenceError = (
  code: ServerBindingPersistenceErrorCodeV1,
  message: string,
  cause?: unknown,
): ServerBindingPersistenceErrorV1 =>
  new ServerBindingPersistenceErrorV1(code, message, cause === undefined ? undefined : { cause });

const invalidInput: (message?: string) => never = (
  message = "The Server binding persistence input is invalid.",
) => {
  throw persistenceError("SERVER_BINDING_INVALID_INPUT", message);
};

const storageIntegrityFailure: (cause?: unknown) => never = (cause) => {
  throw persistenceError(
    "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE",
    "The durable Server binding state is invalid.",
    cause,
  );
};

const assertUuid: (value: unknown, name: string) => asserts value is string = (value, name) => {
  if (typeof value !== "string" || !uuidV4.test(value)) invalidInput(`${name} is invalid.`);
};

const assertSha256: (value: unknown, name: string) => asserts value is string = (value, name) => {
  if (typeof value !== "string" || !sha256.test(value)) invalidInput(`${name} is invalid.`);
};

const assertEntityId: (value: unknown, name: string) => asserts value is string = (value, name) => {
  if (typeof value !== "string" || !entityId.test(value)) invalidInput(`${name} is invalid.`);
};

const assertPackageComponentId: (value: unknown, name: string) => asserts value is string = (
  value,
  name,
) => {
  if (
    typeof value !== "string" ||
    !packageComponentId.test(value) ||
    value.endsWith(".") ||
    dosReservedBaseName.test(value)
  ) {
    invalidInput(`${name} is invalid.`);
  }
};

const assertUtc: (value: unknown, name: string) => asserts value is string = (value, name) => {
  if (typeof value !== "string" || !utcMilliseconds.test(value))
    invalidInput(`${name} is invalid.`);
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString() !== value ||
    value.startsWith("0000")
  ) {
    invalidInput(`${name} is invalid.`);
  }
};

const assertOperatorIdentity: (
  value: unknown,
  maximumBytes: number,
  name: string,
) => asserts value is string = (value, maximumBytes, name) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.isWellFormed() ||
    containsOperatorControl(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    invalidInput(`${name} is invalid.`);
  }
};

const assertReason: (value: unknown) => asserts value is ServerBindingRevocationReasonV1 = (
  value,
) => {
  if (
    value !== "binding_compromised" &&
    value !== "enrollment_abandoned" &&
    value !== "integrity_failure" &&
    value !== "operator_requested"
  ) {
    invalidInput("reasonCode is invalid.");
  }
};

const digestText = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const containsOperatorControl = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
};

const domainDigest = (domain: string, canonicalJson: string): string =>
  createHash("sha256")
    .update(domain, "utf8")
    .update(Buffer.from([0]))
    .update(canonicalJson, "utf8")
    .digest("hex");

const snapshotExactDataObject = <TKey extends string>(
  value: unknown,
  expectedKeys: readonly TKey[],
  name: string,
): Readonly<Record<TKey, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidInput(`${name} is invalid.`);
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    invalidInput(`${name} could not be inspected.`);
  }
  if (prototype !== Object.prototype && prototype !== null) invalidInput(`${name} is invalid.`);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key as TKey))
  ) {
    invalidInput(`${name} has invalid fields.`);
  }
  const snapshot = Object.create(null) as Record<TKey, unknown>;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      invalidInput(`${name} has invalid field descriptors.`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
};

const canonicalIssuanceRequestJson = (input: ServerBindingIssuanceRequestBasisV1): string => {
  const value = Object.assign(Object.create(null) as Record<string, unknown>, {
    authorizationExpiresAt: input.authorizationExpiresAt,
    authorizationId: input.authorizationId,
    enrollmentGeneration: input.enrollmentGeneration,
    expectedCertificateDerSha256: input.expectedCertificateDerSha256,
    installationId: input.installationId,
    issuerKeyId: input.issuerKeyId,
    observedCertificateDerSha256: input.observedCertificateDerSha256,
    operatorIssuer: input.operatorIssuer,
    operatorSubject: input.operatorSubject,
    requestId: input.requestId,
    tokenSha256: input.tokenSha256,
    workerNodeId: input.workerNodeId,
  });
  return JSON.stringify(value);
};

export const deriveServerBindingIssuanceRequestSha256V1 = (
  input: ServerBindingIssuanceRequestBasisV1,
): string => {
  const snapshot = snapshotIssuanceRequestBasis(input);
  return domainDigest(issuanceRequestDomain, canonicalIssuanceRequestJson(snapshot));
};

const canonicalRevocationRequestJson = (input: ServerBindingRevocationRequestBasisV1): string =>
  JSON.stringify(
    Object.assign(Object.create(null) as Record<string, unknown>, {
      bindingId: input.bindingId,
      reasonCode: input.reasonCode,
      revocationId: input.revocationId,
    }),
  );

export const deriveServerBindingRevocationRequestSha256V1 = (
  input: ServerBindingRevocationRequestBasisV1,
): string => {
  const fields = snapshotExactDataObject(input, revocationRequestKeys, "Revocation request basis");
  assertUuid(fields.bindingId, "bindingId");
  assertReason(fields.reasonCode);
  assertUuid(fields.revocationId, "revocationId");
  const snapshot: ServerBindingRevocationRequestBasisV1 = Object.freeze({
    bindingId: fields.bindingId,
    reasonCode: fields.reasonCode,
    revocationId: fields.revocationId,
  });
  return domainDigest(revocationRequestDomain, canonicalRevocationRequestJson(snapshot));
};

const snapshotIssuanceRequestBasis = (
  input: ServerBindingIssuanceRequestBasisV1,
): Readonly<ServerBindingIssuanceRequestBasisV1> => {
  const fields = snapshotExactDataObject(input, issuanceRequestKeys, "Issuance request basis");
  assertUtc(fields.authorizationExpiresAt, "authorizationExpiresAt");
  assertUuid(fields.authorizationId, "authorizationId");
  if (fields.enrollmentGeneration !== 1) invalidInput("enrollmentGeneration is invalid.");
  assertSha256(fields.expectedCertificateDerSha256, "expectedCertificateDerSha256");
  assertPackageComponentId(fields.installationId, "installationId");
  assertSha256(fields.issuerKeyId, "issuerKeyId");
  assertSha256(fields.observedCertificateDerSha256, "observedCertificateDerSha256");
  assertOperatorIdentity(fields.operatorIssuer, 2048, "operatorIssuer");
  assertOperatorIdentity(fields.operatorSubject, 512, "operatorSubject");
  assertUuid(fields.requestId, "requestId");
  assertSha256(fields.tokenSha256, "tokenSha256");
  assertEntityId(fields.workerNodeId, "workerNodeId");
  return Object.freeze({
    authorizationExpiresAt: fields.authorizationExpiresAt,
    authorizationId: fields.authorizationId,
    enrollmentGeneration: 1,
    expectedCertificateDerSha256: fields.expectedCertificateDerSha256,
    installationId: fields.installationId,
    issuerKeyId: fields.issuerKeyId,
    observedCertificateDerSha256: fields.observedCertificateDerSha256,
    operatorIssuer: fields.operatorIssuer,
    operatorSubject: fields.operatorSubject,
    requestId: fields.requestId,
    tokenSha256: fields.tokenSha256,
    workerNodeId: fields.workerNodeId,
  });
};

export const snapshotServerBindingTrustedIssuerDescriptorV1 = (
  value: ServerBindingTrustedIssuerDescriptorV1,
): Readonly<ServerBindingTrustedIssuerDescriptorV1> => {
  if (typeof value !== "object" || value === null) invalidInput("Trusted issuer is invalid.");
  if (
    value.authoritySchemaVersion !== SERVER_BINDING_AUTHORITY_SCHEMA_VERSION ||
    value.issuer !== SERVER_BINDING_AUTHORITY_ISSUER ||
    value.receiptProfileId !== SERVER_BINDING_RECEIPT_PROFILE_ID ||
    value.activeStatusProfileId !== SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID ||
    value.signatureAlgorithm !== SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM
  ) {
    throw persistenceError(
      "SERVER_BINDING_SIGNER_MISMATCH",
      "The trusted Server binding issuer profile is invalid.",
    );
  }
  const spki = Uint8Array.from(value.issuerPublicKeySpki);
  let derivedKeyId: string;
  try {
    derivedKeyId = deriveServerBindingIssuerKeyIdV1(spki);
  } catch (error) {
    throw persistenceError(
      "SERVER_BINDING_SIGNER_MISMATCH",
      "The trusted Server binding issuer SPKI is invalid.",
      error,
    );
  }
  if (value.issuerKeyId !== derivedKeyId) {
    throw persistenceError(
      "SERVER_BINDING_SIGNER_MISMATCH",
      "The trusted Server binding issuer key ID is invalid.",
    );
  }
  return Object.freeze({
    authoritySchemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
    issuer: SERVER_BINDING_AUTHORITY_ISSUER,
    receiptProfileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
    activeStatusProfileId: SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
    signatureAlgorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
    issuerKeyId: derivedKeyId,
    issuerPublicKeySpki: Uint8Array.from(spki),
  });
};

const inImmediateTransaction = <T>(database: DatabaseSync, operation: () => T): T => {
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    throw persistenceError(
      "SERVER_BINDING_PERSISTENCE_UNAVAILABLE",
      "The Server binding transaction could not begin.",
      error,
    );
  }
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError) {
      throw persistenceError(
        "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE",
        "The Server binding transaction rollback failed.",
        new AggregateError(
          [error, rollbackError],
          "Server binding persistence operation and rollback both failed.",
          { cause: error },
        ),
      );
    }
    if (error instanceof ServerBindingPersistenceErrorV1) throw error;
    throw persistenceError(
      "SERVER_BINDING_PERSISTENCE_UNAVAILABLE",
      "The Server binding persistence operation failed.",
      error,
    );
  }
};

const nowUtc = (): string => new Date().toISOString();

const advanceServerBindingClock = (database: DatabaseSync): string => {
  const observedAt = nowUtc();
  const update = database
    .prepare(`
      UPDATE operator_auth_clock
      SET last_observed_at = MAX(last_observed_at, ?)
      WHERE singleton = 1
    `)
    .run(observedAt);
  if (Number(update.changes) !== 1) storageIntegrityFailure();
  const rows = database
    .prepare(
      "SELECT singleton, last_observed_at AS now FROM operator_auth_clock WHERE singleton = 1 LIMIT 2",
    )
    .all() as unknown as readonly { readonly singleton: unknown; readonly now: unknown }[];
  return validateStored(() => {
    if (rows.length !== 1) storageIntegrityFailure();
    const [row] = rows;
    if (row === undefined || row.singleton !== 1) storageIntegrityFailure();
    assertUtc(row.now, "Server binding clock");
    if (row.now < observedAt) storageIntegrityFailure();
    return row.now;
  });
};

const verifyServerBindingClock = (database: DatabaseSync): void => {
  if (countTable(database, "operator_auth_clock") !== 1) storageIntegrityFailure();
  const rows = database
    .prepare(
      "SELECT singleton, last_observed_at AS now FROM operator_auth_clock WHERE singleton = 1 LIMIT 2",
    )
    .all() as unknown as readonly { readonly singleton: unknown; readonly now: unknown }[];
  validateStored(() => {
    if (rows.length !== 1) storageIntegrityFailure();
    const [row] = rows;
    if (row === undefined || row.singleton !== 1) storageIntegrityFailure();
    assertUtc(row.now, "Server binding clock");
  });
};

const validateStored = <T>(operation: () => T): T => {
  try {
    return operation();
  } catch (error) {
    return storageIntegrityFailure(error);
  }
};

const readIssuerRow = (database: DatabaseSync): IssuerRow | null =>
  (database
    .prepare(`
      SELECT
        singleton_id,
        authority_schema_version,
        issuer,
        receipt_profile_id,
        active_status_profile_id,
        signature_algorithm,
        issuer_key_id,
        initialized_at
      FROM server_binding_receipt_issuer
      WHERE singleton_id = 1
    `)
    .get() as IssuerRow | undefined) ?? null;

const verifyIssuerRow = (
  row: IssuerRow,
  trustedIssuer: TrustedIssuerSnapshotV1,
): Readonly<ServerBindingIssuerSnapshotV1> =>
  validateStored(() => {
    if (
      row.singleton_id !== 1 ||
      row.authority_schema_version !== SERVER_BINDING_AUTHORITY_SCHEMA_VERSION ||
      row.issuer !== SERVER_BINDING_AUTHORITY_ISSUER ||
      row.receipt_profile_id !== SERVER_BINDING_RECEIPT_PROFILE_ID ||
      row.active_status_profile_id !== SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID ||
      row.signature_algorithm !== SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM ||
      row.issuer_key_id !== trustedIssuer.issuerKeyId
    ) {
      storageIntegrityFailure();
    }
    assertUtc(row.initialized_at, "initializedAt");
    return Object.freeze({
      authoritySchemaVersion: 1 as const,
      issuer: SERVER_BINDING_AUTHORITY_ISSUER,
      receiptProfileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
      activeStatusProfileId: SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
      signatureAlgorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
      issuerKeyId: row.issuer_key_id,
      initializedAt: row.initialized_at,
    });
  });

const requireIssuer = (
  database: DatabaseSync,
  trustedIssuer: TrustedIssuerSnapshotV1,
): Readonly<ServerBindingIssuerSnapshotV1> => {
  const row = readIssuerRow(database);
  if (row === null) {
    throw persistenceError(
      "SERVER_BINDING_SIGNER_UNAVAILABLE",
      "The Server binding issuer is not initialized.",
    );
  }
  return verifyIssuerRow(row, trustedIssuer);
};

const readAuthorizationById = (
  database: DatabaseSync,
  authorizationId: string,
): AuthorizationRow | null =>
  (database
    .prepare(`
      SELECT
        authorization_id,
        request_id,
        token_sha256,
        operator_issuer,
        operator_subject,
        worker_node_id,
        installation_id,
        enrollment_generation,
        expected_certificate_der_sha256,
        issuer_key_id,
        created_at,
        expires_at,
        consumed_binding_id,
        consumed_issuance_request_sha256,
        consumed_at
      FROM server_binding_authorizations
      WHERE authorization_id = ?
    `)
    .get(authorizationId) as AuthorizationRow | undefined) ?? null;

const readAuthorizationByToken = (
  database: DatabaseSync,
  tokenSha256: string,
): AuthorizationRow | null =>
  (database
    .prepare(`
      SELECT
        authorization_id,
        request_id,
        token_sha256,
        operator_issuer,
        operator_subject,
        worker_node_id,
        installation_id,
        enrollment_generation,
        expected_certificate_der_sha256,
        issuer_key_id,
        created_at,
        expires_at,
        consumed_binding_id,
        consumed_issuance_request_sha256,
        consumed_at
      FROM server_binding_authorizations
      WHERE token_sha256 = ?
    `)
    .get(tokenSha256) as AuthorizationRow | undefined) ?? null;

const toAuthorizationSnapshot = (
  row: AuthorizationRow,
): Readonly<ServerBindingAuthorizationSnapshotV1> =>
  validateStored(() => {
    assertUuid(row.authorization_id, "authorizationId");
    assertUuid(row.request_id, "requestId");
    assertSha256(row.token_sha256, "tokenSha256");
    assertOperatorIdentity(row.operator_issuer, 2048, "operatorIssuer");
    assertOperatorIdentity(row.operator_subject, 512, "operatorSubject");
    assertEntityId(row.worker_node_id, "workerNodeId");
    assertPackageComponentId(row.installation_id, "installationId");
    if (row.enrollment_generation !== 1) invalidInput("enrollmentGeneration is invalid.");
    assertSha256(row.expected_certificate_der_sha256, "expectedCertificateDerSha256");
    assertSha256(row.issuer_key_id, "issuerKeyId");
    assertUtc(row.created_at, "createdAt");
    assertUtc(row.expires_at, "expiresAt");
    if (row.expires_at <= row.created_at) storageIntegrityFailure();
    const consumedValues = [
      row.consumed_binding_id,
      row.consumed_issuance_request_sha256,
      row.consumed_at,
    ];
    const nullCount = consumedValues.filter((value) => value === null).length;
    if (nullCount !== 0 && nullCount !== consumedValues.length) storageIntegrityFailure();
    const consumption =
      row.consumed_binding_id === null ||
      row.consumed_issuance_request_sha256 === null ||
      row.consumed_at === null
        ? null
        : Object.freeze({
            bindingId: row.consumed_binding_id,
            issuanceRequestSha256: row.consumed_issuance_request_sha256,
            consumedAt: row.consumed_at,
          });
    if (consumption !== null) {
      assertUuid(consumption.bindingId, "bindingId");
      assertSha256(consumption.issuanceRequestSha256, "issuanceRequestSha256");
      assertUtc(consumption.consumedAt, "consumedAt");
      if (consumption.consumedAt >= row.expires_at) storageIntegrityFailure();
    }
    return Object.freeze({
      authorizationId: row.authorization_id,
      requestId: row.request_id,
      tokenSha256: row.token_sha256,
      operatorIssuer: row.operator_issuer,
      operatorSubject: row.operator_subject,
      workerNodeId: row.worker_node_id,
      installationId: row.installation_id,
      enrollmentGeneration: 1 as const,
      expectedCertificateDerSha256: row.expected_certificate_der_sha256,
      issuerKeyId: row.issuer_key_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumption,
    });
  });

const readBindingById = (database: DatabaseSync, bindingId: string): BindingRow | null =>
  (database
    .prepare(`
      SELECT
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
      FROM server_bindings
      WHERE binding_id = ?
    `)
    .get(bindingId) as BindingRow | undefined) ?? null;

const readBindingByCertificate = (
  database: DatabaseSync,
  certificateDerSha256: string,
): BindingRow | null =>
  (database
    .prepare(`
      SELECT
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
      FROM server_bindings
      WHERE certificate_der_sha256 = ?
    `)
    .get(certificateDerSha256) as BindingRow | undefined) ?? null;

const readRevocationByBinding = (database: DatabaseSync, bindingId: string): RevocationRow | null =>
  (database
    .prepare(`
      SELECT
        revocation_id,
        revocation_request_sha256,
        binding_id,
        prior_phase,
        reason_code,
        revoked_at
      FROM server_binding_revocations
      WHERE binding_id = ?
    `)
    .get(bindingId) as RevocationRow | undefined) ?? null;

const readRevocationById = (database: DatabaseSync, revocationId: string): RevocationRow | null =>
  (database
    .prepare(`
      SELECT
        revocation_id,
        revocation_request_sha256,
        binding_id,
        prior_phase,
        reason_code,
        revoked_at
      FROM server_binding_revocations
      WHERE revocation_id = ?
    `)
    .get(revocationId) as RevocationRow | undefined) ?? null;

const verifyBindingShape = (row: BindingRow): void => {
  validateStored(() => {
    assertUuid(row.binding_id, "bindingId");
    if (row.binding_revision !== 1) invalidInput("bindingRevision is invalid.");
    assertUuid(row.authorization_id, "authorizationId");
    assertUuid(row.request_id, "requestId");
    assertSha256(row.issuance_request_sha256, "issuanceRequestSha256");
    assertEntityId(row.worker_node_id, "workerNodeId");
    assertPackageComponentId(row.installation_id, "installationId");
    if (row.enrollment_generation !== 1) invalidInput("enrollmentGeneration is invalid.");
    assertSha256(row.certificate_der_sha256, "certificateDerSha256");
    assertSha256(row.issuer_key_id, "issuerKeyId");
    assertUtc(row.bound_at, "boundAt");
    assertSha256(row.statement_document_sha256, "statementDocumentSha256");
    if (
      row.phase !== "signing_pending" &&
      row.phase !== "reserved" &&
      row.phase !== "active" &&
      row.phase !== "revoked"
    ) {
      storageIntegrityFailure();
    }
    if (
      typeof row.statement_json !== "string" ||
      Buffer.byteLength(row.statement_json, "utf8") < 1 ||
      Buffer.byteLength(row.statement_json, "utf8") > 4096
    ) {
      storageIntegrityFailure();
    }
    if (row.receipt_json !== null && Buffer.byteLength(row.receipt_json, "utf8") > 4096) {
      storageIntegrityFailure();
    }
    if (row.record_document_sha256 !== null) {
      assertSha256(row.record_document_sha256, "recordDocumentSha256");
    }
  });
};

const loadVerifiedAggregateByBindingRow = (
  database: DatabaseSync,
  trustedIssuer: TrustedIssuerSnapshotV1,
  binding: BindingRow,
): VerifiedAggregateV1 => {
  verifyBindingShape(binding);
  const issuer = requireIssuer(database, trustedIssuer);
  if (binding.issuer_key_id !== issuer.issuerKeyId) storageIntegrityFailure();
  const authorizationRow = readAuthorizationById(database, binding.authorization_id);
  if (authorizationRow === null) storageIntegrityFailure();
  const authorization = toAuthorizationSnapshot(authorizationRow);
  if (
    authorization.consumption === null ||
    authorization.consumption.bindingId !== binding.binding_id ||
    authorization.consumption.issuanceRequestSha256 !== binding.issuance_request_sha256 ||
    authorization.requestId !== binding.request_id ||
    authorization.workerNodeId !== binding.worker_node_id ||
    authorization.installationId !== binding.installation_id ||
    authorization.enrollmentGeneration !== binding.enrollment_generation ||
    authorization.expectedCertificateDerSha256 !== binding.certificate_der_sha256 ||
    authorization.issuerKeyId !== binding.issuer_key_id
  ) {
    storageIntegrityFailure();
  }

  const issuanceRequestSha256 = deriveServerBindingIssuanceRequestSha256V1({
    authorizationExpiresAt: authorization.expiresAt,
    authorizationId: authorization.authorizationId,
    enrollmentGeneration: authorization.enrollmentGeneration,
    expectedCertificateDerSha256: authorization.expectedCertificateDerSha256,
    installationId: authorization.installationId,
    issuerKeyId: authorization.issuerKeyId,
    observedCertificateDerSha256: binding.certificate_der_sha256,
    operatorIssuer: authorization.operatorIssuer,
    operatorSubject: authorization.operatorSubject,
    requestId: authorization.requestId,
    tokenSha256: authorization.tokenSha256,
    workerNodeId: authorization.workerNodeId,
  });
  if (issuanceRequestSha256 !== binding.issuance_request_sha256) storageIntegrityFailure();

  let statement: ServerBindingReceiptStatementV1;
  try {
    const parsed = JSON.parse(binding.statement_json) as ServerBindingReceiptStatementV1;
    const canonical = Buffer.from(marshalServerBindingReceiptStatementV1(parsed)).toString("utf8");
    if (canonical !== binding.statement_json) storageIntegrityFailure();
    statement = parsed;
  } catch (error) {
    storageIntegrityFailure(error);
  }
  if (digestText(binding.statement_json) !== binding.statement_document_sha256) {
    storageIntegrityFailure();
  }
  if (
    statement.bindingId !== binding.binding_id ||
    statement.bindingRevision !== 1 ||
    statement.boundAt !== binding.bound_at ||
    statement.certificateDerSha256 !== binding.certificate_der_sha256 ||
    statement.enrollmentGeneration !== 1 ||
    statement.installationId !== binding.installation_id ||
    statement.statementType !== "durable-binding-created" ||
    statement.workerNodeId !== binding.worker_node_id
  ) {
    storageIntegrityFailure();
  }

  const basis: Readonly<ServerBindingImmutableBasisV1> = Object.freeze({
    issuer: Object.freeze({
      algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
      issuer: SERVER_BINDING_AUTHORITY_ISSUER,
      issuerKeyId: issuer.issuerKeyId,
      profileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
    }),
    request: Object.freeze({
      requestId: binding.request_id,
      requestSha256: binding.issuance_request_sha256,
      tokenSha256: authorization.tokenSha256,
    }),
    statement: Object.freeze({
      boundAt: binding.bound_at,
      canonicalJson: binding.statement_json,
      sha256: binding.statement_document_sha256,
    }),
    tuple: Object.freeze({
      bindingId: binding.binding_id,
      bindingRevision: 1 as const,
      certificateDerSha256: binding.certificate_der_sha256,
      enrollmentGeneration: 1 as const,
      installationId: binding.installation_id,
      workerNodeId: binding.worker_node_id,
    }),
  });

  let state = createAbsentServerBindingStateV1();
  state = validateStored(() => reduceServerBindingStateV1(state, { type: "begin_signing", basis }));

  let receipt: Readonly<ServerBindingReceiptSnapshotV1> | null = null;
  if (binding.receipt_json !== null || binding.receipt_sha256 !== null) {
    if (binding.receipt_json === null || binding.receipt_sha256 === null) storageIntegrityFailure();
    try {
      const bytes = Buffer.from(binding.receipt_json, "utf8");
      const parsed = parseServerBindingReceiptV1(bytes);
      const canonical = Buffer.from(marshalServerBindingReceiptV1(parsed)).toString("utf8");
      if (canonical !== binding.receipt_json || digestText(canonical) !== binding.receipt_sha256) {
        storageIntegrityFailure();
      }
      verifyServerBindingReceiptWithSpkiV1(bytes, trustedIssuer.issuerPublicKeySpki);
      const statementCanonical = Buffer.from(
        marshalServerBindingReceiptStatementV1(parsed.statement),
      ).toString("utf8");
      if (
        statementCanonical !== binding.statement_json ||
        parsed.issuerKeyId !== issuer.issuerKeyId
      ) {
        storageIntegrityFailure();
      }
      receipt = Object.freeze({
        canonicalJson: canonical,
        receiptSha256: binding.receipt_sha256,
      });
    } catch (error) {
      storageIntegrityFailure(error);
    }
    const committedReceipt = receipt;
    if (committedReceipt === null) storageIntegrityFailure();
    state = validateStored(() =>
      reduceServerBindingStateV1(state, {
        type: "commit_receipt",
        basis,
        receipt: committedReceipt,
      }),
    );
  }

  if (binding.record_document_sha256 !== null) {
    const recordDocumentSha256 = binding.record_document_sha256;
    if (receipt === null) storageIntegrityFailure();
    state = validateStored(() =>
      reduceServerBindingStateV1(state, {
        type: "confirm_record",
        basis,
        receipt,
        record: Object.freeze({ recordDocumentSha256 }),
      }),
    );
  }

  const revocation = readRevocationByBinding(database, binding.binding_id);
  if (revocation !== null) {
    validateStored(() => {
      assertUuid(revocation.revocation_id, "revocationId");
      assertSha256(revocation.revocation_request_sha256, "revocationRequestSha256");
      assertReason(revocation.reason_code);
      assertUtc(revocation.revoked_at, "revokedAt");
      if (
        revocation.binding_id !== binding.binding_id ||
        (revocation.prior_phase !== "signing_pending" &&
          revocation.prior_phase !== "reserved" &&
          revocation.prior_phase !== "active") ||
        deriveServerBindingRevocationRequestSha256V1({
          bindingId: binding.binding_id,
          reasonCode: revocation.reason_code,
          revocationId: revocation.revocation_id,
        }) !== revocation.revocation_request_sha256
      ) {
        storageIntegrityFailure();
      }
    });
    state = validateStored(() =>
      reduceServerBindingStateV1(state, {
        type: "revoke",
        basis,
        receipt,
        record:
          binding.record_document_sha256 === null
            ? null
            : Object.freeze({ recordDocumentSha256: binding.record_document_sha256 }),
        revocation: Object.freeze({
          priorPhase: revocation.prior_phase,
          reasonCode: revocation.reason_code,
          revocationId: revocation.revocation_id,
          revokedAt: revocation.revoked_at,
        }),
      }),
    );
  }

  if (state.phase !== binding.phase || (binding.phase === "revoked") !== (revocation !== null)) {
    storageIntegrityFailure();
  }
  return Object.freeze({ authorization, binding, basis, state, receipt, revocation });
};

const loadVerifiedAggregateByBindingId = (
  database: DatabaseSync,
  trustedIssuer: TrustedIssuerSnapshotV1,
  bindingId: string,
): VerifiedAggregateV1 | null => {
  const binding = readBindingById(database, bindingId);
  return binding === null
    ? null
    : loadVerifiedAggregateByBindingRow(database, trustedIssuer, binding);
};

const hasVerifiedBindingIdentityConflict = (
  database: DatabaseSync,
  trustedIssuer: TrustedIssuerSnapshotV1,
  workerNodeId: string,
  certificateDerSha256: string,
): boolean => {
  const matches = database
    .prepare(`
      SELECT binding_id
      FROM server_bindings
      WHERE (worker_node_id = ? AND enrollment_generation = 1)
        OR certificate_der_sha256 = ?
      ORDER BY binding_id
      LIMIT 3
    `)
    .all(workerNodeId, certificateDerSha256) as unknown as readonly {
    readonly binding_id: string;
  }[];
  if (matches.length > 2) storageIntegrityFailure();
  for (const match of matches) {
    if (loadVerifiedAggregateByBindingId(database, trustedIssuer, match.binding_id) === null) {
      storageIntegrityFailure();
    }
  }
  return matches.length !== 0;
};

const countTable = (database: DatabaseSync, table: string): number => {
  const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as
    | { readonly count: number }
    | undefined;
  if (row === undefined || !Number.isSafeInteger(row.count) || row.count < 0)
    storageIntegrityFailure();
  return row.count;
};

const verifyServerBindingSchema = (database: DatabaseSync): void => {
  const rows = validateStored(
    () =>
      database
        .prepare(`
          SELECT type, name, tbl_name, sql
          FROM sqlite_schema
          WHERE tbl_name IN (
            'server_binding_receipt_issuer',
            'server_binding_authorizations',
            'server_bindings',
            'server_binding_revocations',
            'operator_auth_clock'
          )
          ORDER BY type, name
        `)
        .all() as unknown as readonly SchemaRow[],
  );
  if (rows.length !== expectedSchemaRowCount) storageIntegrityFailure();
  const canonicalRows = rows.map((row) => {
    if (
      typeof row.type !== "string" ||
      typeof row.name !== "string" ||
      typeof row.tbl_name !== "string" ||
      (typeof row.sql !== "string" && row.sql !== null)
    ) {
      storageIntegrityFailure();
    }
    return [
      row.type,
      row.name,
      row.tbl_name,
      typeof row.sql === "string" ? row.sql.replace(/\r\n?/gu, "\n").trim() : null,
    ] as const;
  });
  if (digestText(JSON.stringify(canonicalRows)) !== expectedSchemaSha256) {
    storageIntegrityFailure();
  }
  const triggerRows = validateStored(
    () =>
      database
        .prepare(`
          SELECT type, name, tbl_name, sql
          FROM sqlite_schema
          WHERE type = 'trigger'
          ORDER BY name
        `)
        .all() as unknown as readonly SchemaRow[],
  );
  if (triggerRows.length !== expectedPersistentTriggerCount) storageIntegrityFailure();
  const canonicalTriggers = triggerRows.map((row) => [
    row.type,
    row.name,
    row.tbl_name,
    typeof row.sql === "string" ? row.sql.replace(/\r\n?/gu, "\n").trim() : row.sql,
  ]);
  if (digestText(JSON.stringify(canonicalTriggers)) !== expectedPersistentTriggerSha256) {
    storageIntegrityFailure();
  }
};

const readAuditIdPage = (
  database: DatabaseSync,
  kind: "authorization" | "binding",
  afterId: string,
): readonly string[] => {
  const rows =
    kind === "authorization"
      ? (database
          .prepare(`
            SELECT authorization_id AS id
            FROM server_binding_authorizations
            WHERE authorization_id > ?
            ORDER BY authorization_id
            LIMIT ?
          `)
          .all(afterId, auditPageSize) as unknown as readonly { readonly id: unknown }[])
      : (database
          .prepare(`
            SELECT binding_id AS id
            FROM server_bindings
            WHERE binding_id > ?
            ORDER BY binding_id
            LIMIT ?
          `)
          .all(afterId, auditPageSize) as unknown as readonly { readonly id: unknown }[]);
  const ids: string[] = [];
  let previousId = afterId;
  for (const row of rows) {
    if (typeof row.id !== "string" || row.id <= previousId) storageIntegrityFailure();
    ids.push(row.id);
    previousId = row.id;
  }
  return ids;
};

export const auditServerBindingPersistenceV1 = (
  database: DatabaseSync,
  trustedIssuerValue: ServerBindingTrustedIssuerDescriptorV1 | null,
): Readonly<ServerBindingPersistenceAuditResultV1> =>
  inImmediateTransaction(database, () => {
    verifyServerBindingSchema(database);
    verifyServerBindingClock(database);
    const authorizationCount = countTable(database, "server_binding_authorizations");
    const bindingCount = countTable(database, "server_bindings");
    const revocationCount = countTable(database, "server_binding_revocations");
    const issuerCount = countTable(database, "server_binding_receipt_issuer");
    const total = authorizationCount + bindingCount + revocationCount + issuerCount;
    if (total === 0) {
      return Object.freeze({
        state: "uninitialized" as const,
        issuer: null,
        authorizationCount: 0,
        bindingCount: 0,
        revocationCount: 0,
      });
    }
    if (trustedIssuerValue === null) {
      throw persistenceError(
        "SERVER_BINDING_SIGNER_UNAVAILABLE",
        "Initialized Server binding state requires the trusted issuer.",
      );
    }
    const trustedIssuer = snapshotServerBindingTrustedIssuerDescriptorV1(trustedIssuerValue);
    if (issuerCount !== 1) storageIntegrityFailure();
    const issuerRow = readIssuerRow(database);
    if (issuerRow === null) storageIntegrityFailure();
    const issuer = verifyIssuerRow(issuerRow, trustedIssuer);

    if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
      storageIntegrityFailure();
    }

    let auditedAuthorizationCount = 0;
    let lastAuthorizationId = "";
    while (true) {
      const authorizationIds = readAuditIdPage(database, "authorization", lastAuthorizationId);
      for (const authorizationId of authorizationIds) {
        const authorization = readAuthorizationById(database, authorizationId);
        if (authorization === null) storageIntegrityFailure();
        const snapshot = toAuthorizationSnapshot(authorization);
        if (snapshot.issuerKeyId !== issuer.issuerKeyId) storageIntegrityFailure();
      }
      auditedAuthorizationCount += authorizationIds.length;
      if (authorizationIds.length < auditPageSize) break;
      lastAuthorizationId = authorizationIds.at(-1) ?? storageIntegrityFailure();
    }
    if (auditedAuthorizationCount !== authorizationCount) storageIntegrityFailure();

    let auditedBindingCount = 0;
    let lastBindingId = "";
    while (true) {
      const bindingIds = readAuditIdPage(database, "binding", lastBindingId);
      for (const bindingId of bindingIds) {
        if (loadVerifiedAggregateByBindingId(database, trustedIssuer, bindingId) === null) {
          storageIntegrityFailure();
        }
      }
      auditedBindingCount += bindingIds.length;
      if (bindingIds.length < auditPageSize) break;
      lastBindingId = bindingIds.at(-1) ?? storageIntegrityFailure();
    }
    if (auditedBindingCount !== bindingCount) storageIntegrityFailure();

    return Object.freeze({
      state: "initialized" as const,
      issuer,
      authorizationCount,
      bindingCount,
      revocationCount,
    });
  });

export const initializeServerBindingIssuerV1 = (
  database: DatabaseSync,
  trustedIssuerValue: ServerBindingTrustedIssuerDescriptorV1,
  input: InitializeServerBindingIssuerV1Input,
): Readonly<InitializeServerBindingIssuerV1Result> => {
  const trustedIssuer = snapshotServerBindingTrustedIssuerDescriptorV1(trustedIssuerValue);
  if (typeof input !== "object" || input === null) invalidInput();
  assertSha256(input.expectedIssuerKeyId, "expectedIssuerKeyId");
  if (input.expectedIssuerKeyId !== trustedIssuer.issuerKeyId) {
    throw persistenceError(
      "SERVER_BINDING_SIGNER_MISMATCH",
      "The Server binding signer does not match the startup trusted issuer.",
    );
  }
  return inImmediateTransaction(database, () => {
    const existing = readIssuerRow(database);
    if (existing !== null) {
      return Object.freeze({
        outcome: "replayed" as const,
        issuer: verifyIssuerRow(existing, trustedIssuer),
      });
    }
    if (
      countTable(database, "server_binding_authorizations") !== 0 ||
      countTable(database, "server_bindings") !== 0 ||
      countTable(database, "server_binding_revocations") !== 0
    ) {
      storageIntegrityFailure();
    }
    const initializedAt = nowUtc();
    database
      .prepare(`
        INSERT INTO server_binding_receipt_issuer (
          singleton_id,
          authority_schema_version,
          issuer,
          receipt_profile_id,
          active_status_profile_id,
          signature_algorithm,
          issuer_key_id,
          initialized_at
        ) VALUES (1, 1, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        SERVER_BINDING_AUTHORITY_ISSUER,
        SERVER_BINDING_RECEIPT_PROFILE_ID,
        SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
        SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
        trustedIssuer.issuerKeyId,
        initializedAt,
      );
    const inserted = readIssuerRow(database);
    if (inserted === null) storageIntegrityFailure();
    return Object.freeze({
      outcome: "initialized" as const,
      issuer: verifyIssuerRow(inserted, trustedIssuer),
    });
  });
};

const validateAuthorizationInput = (input: CreateServerBindingAuthorizationV1Input): void => {
  if (typeof input !== "object" || input === null) invalidInput();
  assertUuid(input.authorizationId, "authorizationId");
  assertUuid(input.requestId, "requestId");
  assertSha256(input.tokenSha256, "tokenSha256");
  assertOperatorIdentity(input.operatorIssuer, 2048, "operatorIssuer");
  assertOperatorIdentity(input.operatorSubject, 512, "operatorSubject");
  assertEntityId(input.workerNodeId, "workerNodeId");
  assertPackageComponentId(input.installationId, "installationId");
  if (input.enrollmentGeneration !== 1) invalidInput("enrollmentGeneration is invalid.");
  assertSha256(input.expectedCertificateDerSha256, "expectedCertificateDerSha256");
  assertUtc(input.createdAt, "createdAt");
  assertUtc(input.expiresAt, "expiresAt");
  if (input.expiresAt <= input.createdAt) invalidInput("Authorization expiry is invalid.");
};

const sameAuthorizationInput = (
  snapshot: Readonly<ServerBindingAuthorizationSnapshotV1>,
  input: CreateServerBindingAuthorizationV1Input,
  issuerKeyId: string,
): boolean =>
  snapshot.authorizationId === input.authorizationId &&
  snapshot.requestId === input.requestId &&
  snapshot.tokenSha256 === input.tokenSha256 &&
  snapshot.operatorIssuer === input.operatorIssuer &&
  snapshot.operatorSubject === input.operatorSubject &&
  snapshot.workerNodeId === input.workerNodeId &&
  snapshot.installationId === input.installationId &&
  snapshot.enrollmentGeneration === input.enrollmentGeneration &&
  snapshot.expectedCertificateDerSha256 === input.expectedCertificateDerSha256 &&
  snapshot.issuerKeyId === issuerKeyId &&
  snapshot.createdAt === input.createdAt &&
  snapshot.expiresAt === input.expiresAt &&
  snapshot.consumption === null;

export const createServerBindingAuthorizationV1 = (
  database: DatabaseSync,
  trustedIssuerValue: ServerBindingTrustedIssuerDescriptorV1,
  input: CreateServerBindingAuthorizationV1Input,
): Readonly<CreateServerBindingAuthorizationV1Result> => {
  validateAuthorizationInput(input);
  const trustedIssuer = snapshotServerBindingTrustedIssuerDescriptorV1(trustedIssuerValue);
  return inImmediateTransaction(database, () => {
    const issuer = requireIssuer(database, trustedIssuer);
    const identityMatches = database
      .prepare(`
        SELECT authorization_id
        FROM server_binding_authorizations
        WHERE authorization_id = ? OR request_id = ? OR token_sha256 = ?
        ORDER BY authorization_id
      `)
      .all(input.authorizationId, input.requestId, input.tokenSha256) as unknown as readonly {
      readonly authorization_id: string;
    }[];
    if (identityMatches.length !== 0) {
      const verifiedMatches = identityMatches.map((identityMatch) => {
        const existing = readAuthorizationById(database, identityMatch.authorization_id);
        if (existing === null) storageIntegrityFailure();
        const snapshot = toAuthorizationSnapshot(existing);
        if (snapshot.issuerKeyId !== issuer.issuerKeyId) storageIntegrityFailure();
        if (snapshot.consumption !== null) {
          const aggregate = loadVerifiedAggregateByBindingId(
            database,
            trustedIssuer,
            snapshot.consumption.bindingId,
          );
          if (
            aggregate === null ||
            aggregate.authorization.authorizationId !== snapshot.authorizationId
          ) {
            storageIntegrityFailure();
          }
        }
        return snapshot;
      });
      if (identityMatches.length !== 1) {
        throw persistenceError(
          "SERVER_BINDING_IMMUTABLE_CONFLICT",
          "The Server binding authorization identity is already used.",
        );
      }
      const snapshot = verifiedMatches[0];
      if (snapshot === undefined) storageIntegrityFailure();
      if (!sameAuthorizationInput(snapshot, input, issuer.issuerKeyId)) {
        throw persistenceError(
          "SERVER_BINDING_IMMUTABLE_CONFLICT",
          "The Server binding authorization identity has different immutable state.",
        );
      }
      return Object.freeze({ outcome: "replayed" as const, authorization: snapshot });
    }

    if (
      hasVerifiedBindingIdentityConflict(
        database,
        trustedIssuer,
        input.workerNodeId,
        input.expectedCertificateDerSha256,
      )
    ) {
      throw persistenceError(
        "SERVER_BINDING_IMMUTABLE_CONFLICT",
        "The Server binding identity is already reserved.",
      );
    }

    database
      .prepare(`
        INSERT INTO server_binding_authorizations (
          authorization_id,
          request_id,
          token_sha256,
          operator_issuer,
          operator_subject,
          worker_node_id,
          installation_id,
          enrollment_generation,
          expected_certificate_der_sha256,
          issuer_key_id,
          created_at,
          expires_at,
          consumed_binding_id,
          consumed_issuance_request_sha256,
          consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, NULL)
      `)
      .run(
        input.authorizationId,
        input.requestId,
        input.tokenSha256,
        input.operatorIssuer,
        input.operatorSubject,
        input.workerNodeId,
        input.installationId,
        input.expectedCertificateDerSha256,
        issuer.issuerKeyId,
        input.createdAt,
        input.expiresAt,
      );
    const inserted = readAuthorizationById(database, input.authorizationId);
    if (inserted === null) storageIntegrityFailure();
    return Object.freeze({
      outcome: "created" as const,
      authorization: toAuthorizationSnapshot(inserted),
    });
  });
};

const claimResultFromAggregate = (
  aggregate: VerifiedAggregateV1,
): Readonly<ClaimServerBindingAuthorizationV1Result> => {
  if (aggregate.state.phase === "revoked") {
    throw persistenceError(
      "SERVER_BINDING_TERMINAL_REVOKED",
      "The Server binding is permanently revoked.",
    );
  }
  const claim = Object.freeze({
    authorizationId: aggregate.authorization.authorizationId,
    basis: aggregate.basis,
  });
  if (aggregate.state.phase === "signing_pending") {
    return Object.freeze({ outcome: "signing_pending" as const, claim });
  }
  if (aggregate.state.phase !== "reserved" && aggregate.state.phase !== "active") {
    storageIntegrityFailure();
  }
  if (aggregate.receipt === null) storageIntegrityFailure();
  return Object.freeze({
    outcome: "receipt_replay" as const,
    retainedPhase: aggregate.state.phase,
    claim,
    receipt: aggregate.receipt,
  });
};

export const claimServerBindingAuthorizationV1 = (
  database: DatabaseSync,
  trustedIssuerValue: ServerBindingTrustedIssuerDescriptorV1,
  input: ClaimServerBindingAuthorizationV1Input,
): Readonly<ClaimServerBindingAuthorizationV1Result> => {
  if (typeof input !== "object" || input === null) invalidInput();
  assertUuid(input.requestId, "requestId");
  assertSha256(input.tokenSha256, "tokenSha256");
  assertSha256(input.observedCertificateDerSha256, "observedCertificateDerSha256");
  const trustedIssuer = snapshotServerBindingTrustedIssuerDescriptorV1(trustedIssuerValue);

  const transaction = inImmediateTransaction<
    | Readonly<{ expired: true }>
    | Readonly<{ conflict: true }>
    | Readonly<{ expired: false; result: Readonly<ClaimServerBindingAuthorizationV1Result> }>
  >(database, () => {
    const issuer = requireIssuer(database, trustedIssuer);
    const authorizationRow = readAuthorizationByToken(database, input.tokenSha256);
    if (authorizationRow === null) {
      throw persistenceError(
        "SERVER_BINDING_INVALID_INPUT",
        "The Server binding authorization is unavailable.",
      );
    }
    const authorization = toAuthorizationSnapshot(authorizationRow);
    if (
      authorization.requestId !== input.requestId ||
      authorization.expectedCertificateDerSha256 !== input.observedCertificateDerSha256 ||
      authorization.issuerKeyId !== issuer.issuerKeyId
    ) {
      throw persistenceError(
        "SERVER_BINDING_IMMUTABLE_CONFLICT",
        "The Server binding request does not match its authorization.",
      );
    }
    const issuanceRequestSha256 = deriveServerBindingIssuanceRequestSha256V1({
      authorizationExpiresAt: authorization.expiresAt,
      authorizationId: authorization.authorizationId,
      enrollmentGeneration: authorization.enrollmentGeneration,
      expectedCertificateDerSha256: authorization.expectedCertificateDerSha256,
      installationId: authorization.installationId,
      issuerKeyId: authorization.issuerKeyId,
      observedCertificateDerSha256: input.observedCertificateDerSha256,
      operatorIssuer: authorization.operatorIssuer,
      operatorSubject: authorization.operatorSubject,
      requestId: authorization.requestId,
      tokenSha256: authorization.tokenSha256,
      workerNodeId: authorization.workerNodeId,
    });

    if (authorization.consumption !== null) {
      if (authorization.consumption.issuanceRequestSha256 !== issuanceRequestSha256) {
        throw persistenceError(
          "SERVER_BINDING_IMMUTABLE_CONFLICT",
          "The consumed Server binding request has different immutable state.",
        );
      }
      const aggregate = loadVerifiedAggregateByBindingId(
        database,
        trustedIssuer,
        authorization.consumption.bindingId,
      );
      if (aggregate === null) storageIntegrityFailure();
      return Object.freeze({
        expired: false as const,
        result: claimResultFromAggregate(aggregate),
      });
    }

    const transactionNow = advanceServerBindingClock(database);
    if (transactionNow >= authorization.expiresAt) {
      return Object.freeze({ expired: true as const });
    }
    if (
      hasVerifiedBindingIdentityConflict(
        database,
        trustedIssuer,
        authorization.workerNodeId,
        authorization.expectedCertificateDerSha256,
      )
    ) {
      return Object.freeze({ conflict: true as const });
    }
    const bindingId = randomUUID();
    const statement: ServerBindingReceiptStatementV1 = {
      bindingId,
      bindingRevision: 1,
      boundAt: transactionNow,
      certificateDerSha256: authorization.expectedCertificateDerSha256,
      enrollmentGeneration: 1,
      installationId: authorization.installationId,
      statementType: "durable-binding-created",
      workerNodeId: authorization.workerNodeId,
    };
    const statementJson = Buffer.from(marshalServerBindingReceiptStatementV1(statement)).toString(
      "utf8",
    );
    const statementDocumentSha256 = digestText(statementJson);
    const update = database
      .prepare(`
        UPDATE server_binding_authorizations
        SET
          consumed_binding_id = ?,
          consumed_issuance_request_sha256 = ?,
          consumed_at = ?
        WHERE authorization_id = ?
          AND consumed_binding_id IS NULL
          AND consumed_issuance_request_sha256 IS NULL
          AND consumed_at IS NULL
          AND expires_at > ?
      `)
      .run(
        bindingId,
        issuanceRequestSha256,
        transactionNow,
        authorization.authorizationId,
        transactionNow,
      );
    if (Number(update.changes) !== 1) {
      throw persistenceError(
        "SERVER_BINDING_PERSISTENCE_UNAVAILABLE",
        "The Server binding authorization could not be consumed.",
      );
    }
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
        ) VALUES (?, 1, ?, ?, ?, ?, ?, 1, ?, ?, 'signing_pending', ?, ?, ?, NULL, NULL, NULL)
      `)
      .run(
        bindingId,
        authorization.authorizationId,
        authorization.requestId,
        issuanceRequestSha256,
        authorization.workerNodeId,
        authorization.installationId,
        authorization.expectedCertificateDerSha256,
        issuer.issuerKeyId,
        transactionNow,
        statementJson,
        statementDocumentSha256,
      );
    const aggregate = loadVerifiedAggregateByBindingId(database, trustedIssuer, bindingId);
    if (aggregate === null) storageIntegrityFailure();
    return Object.freeze({ expired: false as const, result: claimResultFromAggregate(aggregate) });
  });
  if ("result" in transaction) return transaction.result;
  if ("expired" in transaction) {
    throw persistenceError(
      "SERVER_BINDING_AUTHORIZATION_EXPIRED",
      "The Server binding authorization expired before consumption.",
    );
  }
  throw persistenceError(
    "SERVER_BINDING_IMMUTABLE_CONFLICT",
    "The Server binding worker generation or certificate is already bound.",
  );
};

const validateCandidateReceipt = (
  trustedIssuer: TrustedIssuerSnapshotV1,
  receiptJson: unknown,
): Readonly<ServerBindingReceiptSnapshotV1> & {
  readonly statementJson: string;
} => {
  if (
    typeof receiptJson !== "string" ||
    Buffer.byteLength(receiptJson, "utf8") < 1 ||
    Buffer.byteLength(receiptJson, "utf8") > 4096
  ) {
    invalidInput("receiptJson is invalid.");
  }
  try {
    const bytes = Buffer.from(receiptJson, "utf8");
    const receipt = parseServerBindingReceiptV1(bytes);
    const canonical = Buffer.from(marshalServerBindingReceiptV1(receipt)).toString("utf8");
    if (canonical !== receiptJson) invalidInput("receiptJson is not canonical.");
    verifyServerBindingReceiptWithSpkiV1(bytes, trustedIssuer.issuerPublicKeySpki);
    return Object.freeze({
      canonicalJson: canonical,
      receiptSha256: digestText(canonical),
      statementJson: Buffer.from(
        marshalServerBindingReceiptStatementV1(receipt.statement),
      ).toString("utf8"),
    });
  } catch (error) {
    if (error instanceof ServerBindingPersistenceErrorV1) throw error;
    throw persistenceError(
      "SERVER_BINDING_SIGNER_MISMATCH",
      "The Server binding receipt candidate is invalid.",
      error,
    );
  }
};

export const commitServerBindingReceiptV1 = (
  database: DatabaseSync,
  trustedIssuerValue: ServerBindingTrustedIssuerDescriptorV1,
  input: CommitServerBindingReceiptV1Input,
): Readonly<CommitServerBindingReceiptV1Result> => {
  if (typeof input !== "object" || input === null) invalidInput();
  assertUuid(input.bindingId, "bindingId");
  assertSha256(input.issuanceRequestSha256, "issuanceRequestSha256");
  const trustedIssuer = snapshotServerBindingTrustedIssuerDescriptorV1(trustedIssuerValue);
  const candidate = validateCandidateReceipt(trustedIssuer, input.receiptJson);
  let outcome: "committed" | "replayed" = "committed";

  inImmediateTransaction(database, () => {
    const aggregate = loadVerifiedAggregateByBindingId(database, trustedIssuer, input.bindingId);
    if (aggregate === null) invalidInput("The Server binding is unavailable.");
    if (aggregate.basis.request.requestSha256 !== input.issuanceRequestSha256) {
      throw persistenceError(
        "SERVER_BINDING_IMMUTABLE_CONFLICT",
        "The Server binding receipt request does not match the pending binding.",
      );
    }
    if (candidate.statementJson !== aggregate.basis.statement.canonicalJson) {
      throw persistenceError(
        "SERVER_BINDING_IMMUTABLE_CONFLICT",
        "The Server binding receipt changed the committed statement.",
      );
    }
    if (aggregate.state.phase === "revoked") {
      throw persistenceError(
        "SERVER_BINDING_TERMINAL_REVOKED",
        "The Server binding is permanently revoked.",
      );
    }
    if (aggregate.state.phase === "reserved" || aggregate.state.phase === "active") {
      outcome = "replayed";
      return;
    }
    const update = database
      .prepare(`
        UPDATE server_bindings
        SET phase = 'reserved', receipt_json = ?, receipt_sha256 = ?
        WHERE binding_id = ?
          AND phase = 'signing_pending'
          AND issuance_request_sha256 = ?
          AND receipt_json IS NULL
          AND receipt_sha256 IS NULL
          AND record_document_sha256 IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM server_binding_revocations AS revocation
            WHERE revocation.binding_id = server_bindings.binding_id
          )
      `)
      .run(
        candidate.canonicalJson,
        candidate.receiptSha256,
        input.bindingId,
        input.issuanceRequestSha256,
      );
    if (Number(update.changes) !== 1) {
      throw persistenceError(
        "SERVER_BINDING_PERSISTENCE_UNAVAILABLE",
        "The Server binding receipt could not be committed.",
      );
    }
  });

  const retained = loadVerifiedAggregateByBindingId(database, trustedIssuer, input.bindingId);
  if (retained === null) storageIntegrityFailure();
  if (retained.state.phase === "revoked") {
    throw persistenceError(
      "SERVER_BINDING_TERMINAL_REVOKED",
      "The Server binding was revoked before receipt replay completed.",
    );
  }
  if (
    (retained.state.phase !== "reserved" && retained.state.phase !== "active") ||
    retained.receipt === null
  ) {
    storageIntegrityFailure();
  }
  return Object.freeze({
    outcome,
    retainedPhase: retained.state.phase,
    receipt: retained.receipt,
  });
};

export const confirmServerBindingRecordV1 = (
  database: DatabaseSync,
  trustedIssuerValue: ServerBindingTrustedIssuerDescriptorV1,
  input: ConfirmServerBindingRecordV1Input,
): Readonly<ConfirmServerBindingRecordV1Result> => {
  if (typeof input !== "object" || input === null) invalidInput();
  assertUuid(input.bindingId, "bindingId");
  if (input.bindingRevision !== 1 || input.enrollmentGeneration !== 1) invalidInput();
  assertEntityId(input.workerNodeId, "workerNodeId");
  assertPackageComponentId(input.installationId, "installationId");
  assertSha256(input.certificateDerSha256, "certificateDerSha256");
  assertSha256(input.recordDocumentSha256, "recordDocumentSha256");
  const trustedIssuer = snapshotServerBindingTrustedIssuerDescriptorV1(trustedIssuerValue);
  let outcome: "confirmed" | "replayed" = "confirmed";

  inImmediateTransaction(database, () => {
    const aggregate = loadVerifiedAggregateByBindingId(database, trustedIssuer, input.bindingId);
    if (aggregate === null) invalidInput("The Server binding is unavailable.");
    const tuple = aggregate.basis.tuple;
    if (
      tuple.bindingRevision !== input.bindingRevision ||
      tuple.workerNodeId !== input.workerNodeId ||
      tuple.installationId !== input.installationId ||
      tuple.enrollmentGeneration !== input.enrollmentGeneration ||
      tuple.certificateDerSha256 !== input.certificateDerSha256
    ) {
      throw persistenceError(
        "SERVER_BINDING_IMMUTABLE_CONFLICT",
        "The Server binding record confirmation changed the immutable tuple.",
      );
    }
    if (aggregate.state.phase === "revoked") {
      throw persistenceError(
        "SERVER_BINDING_TERMINAL_REVOKED",
        "The Server binding is permanently revoked.",
      );
    }
    if (aggregate.state.phase === "active") {
      if (aggregate.binding.record_document_sha256 !== input.recordDocumentSha256) {
        throw persistenceError(
          "SERVER_BINDING_IMMUTABLE_CONFLICT",
          "The Server binding record confirmation changed the first digest.",
        );
      }
      outcome = "replayed";
      return;
    }
    if (aggregate.state.phase !== "reserved") {
      throw persistenceError(
        "SERVER_BINDING_TRANSITION_INVALID",
        "The Server binding record cannot be confirmed before receipt reservation.",
      );
    }
    const update = database
      .prepare(`
        UPDATE server_bindings
        SET phase = 'active', record_document_sha256 = ?
        WHERE binding_id = ?
          AND phase = 'reserved'
          AND certificate_der_sha256 = ?
          AND receipt_json IS NOT NULL
          AND receipt_sha256 IS NOT NULL
          AND record_document_sha256 IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM server_binding_revocations AS revocation
            WHERE revocation.binding_id = server_bindings.binding_id
          )
      `)
      .run(input.recordDocumentSha256, input.bindingId, input.certificateDerSha256);
    if (Number(update.changes) !== 1) {
      throw persistenceError(
        "SERVER_BINDING_PERSISTENCE_UNAVAILABLE",
        "The Server binding record could not be confirmed.",
      );
    }
  });

  const retained = loadVerifiedAggregateByBindingId(database, trustedIssuer, input.bindingId);
  if (
    retained === null ||
    retained.state.phase !== "active" ||
    retained.binding.record_document_sha256 !== input.recordDocumentSha256
  ) {
    if (retained?.state.phase === "revoked") {
      throw persistenceError(
        "SERVER_BINDING_TERMINAL_REVOKED",
        "The Server binding was revoked before confirmation replay completed.",
      );
    }
    storageIntegrityFailure();
  }
  return Object.freeze({
    outcome,
    bindingId: input.bindingId,
    recordDocumentSha256: input.recordDocumentSha256,
  });
};

export const readServerBindingRecoveryReceiptV1 = (
  database: DatabaseSync,
  trustedIssuerValue: ServerBindingTrustedIssuerDescriptorV1,
  input: ReadServerBindingRecoveryReceiptV1Input,
): Readonly<ServerBindingRecoveryReceiptV1> | null => {
  if (typeof input !== "object" || input === null) invalidInput();
  assertSha256(input.certificateDerSha256, "certificateDerSha256");
  const trustedIssuer = snapshotServerBindingTrustedIssuerDescriptorV1(trustedIssuerValue);
  const binding = readBindingByCertificate(database, input.certificateDerSha256);
  if (binding === null) return null;
  const aggregate = loadVerifiedAggregateByBindingRow(database, trustedIssuer, binding);
  if (
    (aggregate.state.phase !== "reserved" && aggregate.state.phase !== "active") ||
    aggregate.receipt === null
  ) {
    return null;
  }
  return Object.freeze({
    bindingId: binding.binding_id,
    bindingRevision: 1 as const,
    phase: aggregate.state.phase,
    receiptJson: aggregate.receipt.canonicalJson,
    receiptSha256: aggregate.receipt.receiptSha256,
  });
};

const activeSnapshotFromAggregate = (
  aggregate: VerifiedAggregateV1,
): Readonly<ServerBindingActiveSnapshotV1> | null => {
  if (
    aggregate.state.phase !== "active" ||
    aggregate.receipt === null ||
    aggregate.binding.record_document_sha256 === null
  ) {
    return null;
  }
  return Object.freeze({
    bindingId: aggregate.binding.binding_id,
    bindingRevision: 1 as const,
    workerNodeId: aggregate.binding.worker_node_id,
    installationId: aggregate.binding.installation_id,
    enrollmentGeneration: 1 as const,
    certificateDerSha256: aggregate.binding.certificate_der_sha256,
    issuerKeyId: aggregate.binding.issuer_key_id,
    receiptSha256: aggregate.receipt.receiptSha256,
    recordDocumentSha256: aggregate.binding.record_document_sha256,
  });
};

export const readServerBindingActiveSnapshotV1 = (
  database: DatabaseSync,
  trustedIssuerValue: ServerBindingTrustedIssuerDescriptorV1,
  input: ReadServerBindingRecoveryReceiptV1Input,
): Readonly<ServerBindingActiveSnapshotV1> | null => {
  if (typeof input !== "object" || input === null) invalidInput();
  assertSha256(input.certificateDerSha256, "certificateDerSha256");
  const trustedIssuer = snapshotServerBindingTrustedIssuerDescriptorV1(trustedIssuerValue);
  const binding = readBindingByCertificate(database, input.certificateDerSha256);
  if (binding === null) return null;
  return activeSnapshotFromAggregate(
    loadVerifiedAggregateByBindingRow(database, trustedIssuer, binding),
  );
};

const sameActiveSnapshot = (
  left: Readonly<ServerBindingActiveSnapshotV1>,
  right: Readonly<ServerBindingActiveSnapshotV1>,
): boolean =>
  left.bindingId === right.bindingId &&
  left.bindingRevision === right.bindingRevision &&
  left.workerNodeId === right.workerNodeId &&
  left.installationId === right.installationId &&
  left.enrollmentGeneration === right.enrollmentGeneration &&
  left.certificateDerSha256 === right.certificateDerSha256 &&
  left.issuerKeyId === right.issuerKeyId &&
  left.receiptSha256 === right.receiptSha256 &&
  left.recordDocumentSha256 === right.recordDocumentSha256;

export const recheckServerBindingActiveSnapshotV1 = (
  database: DatabaseSync,
  trustedIssuerValue: ServerBindingTrustedIssuerDescriptorV1,
  input: ServerBindingActiveSnapshotV1,
): Readonly<ServerBindingActiveSnapshotV1> => {
  if (typeof input !== "object" || input === null) invalidInput();
  const trustedIssuer = snapshotServerBindingTrustedIssuerDescriptorV1(trustedIssuerValue);
  return inImmediateTransaction(database, () => {
    const aggregate = loadVerifiedAggregateByBindingId(database, trustedIssuer, input.bindingId);
    if (aggregate === null) {
      throw persistenceError(
        "SERVER_BINDING_IMMUTABLE_CONFLICT",
        "The active Server binding no longer exists.",
      );
    }
    if (aggregate.state.phase === "revoked") {
      throw persistenceError(
        "SERVER_BINDING_TERMINAL_REVOKED",
        "The Server binding is permanently revoked.",
      );
    }
    const current = activeSnapshotFromAggregate(aggregate);
    if (current === null || !sameActiveSnapshot(current, input)) {
      throw persistenceError(
        "SERVER_BINDING_IMMUTABLE_CONFLICT",
        "The active Server binding changed before final recheck.",
      );
    }
    return current;
  });
};

const revocationResult = (
  row: RevocationRow,
  outcome: "revoked" | "replayed",
): Readonly<RevokeServerBindingV1Result> =>
  Object.freeze({
    outcome,
    revocationId: row.revocation_id,
    revocationRequestSha256: row.revocation_request_sha256,
    bindingId: row.binding_id,
    priorPhase: row.prior_phase,
    reasonCode: row.reason_code,
    revokedAt: row.revoked_at,
  });

export const revokeServerBindingV1 = (
  database: DatabaseSync,
  trustedIssuerValue: ServerBindingTrustedIssuerDescriptorV1,
  input: RevokeServerBindingV1Input,
): Readonly<RevokeServerBindingV1Result> => {
  if (typeof input !== "object" || input === null) invalidInput();
  assertUuid(input.revocationId, "revocationId");
  assertUuid(input.bindingId, "bindingId");
  assertReason(input.reasonCode);
  const trustedIssuer = snapshotServerBindingTrustedIssuerDescriptorV1(trustedIssuerValue);
  const revocationRequestSha256 = deriveServerBindingRevocationRequestSha256V1(input);

  return inImmediateTransaction(database, () => {
    const existingById = readRevocationById(database, input.revocationId);
    if (existingById !== null) {
      const retainedAggregate = loadVerifiedAggregateByBindingId(
        database,
        trustedIssuer,
        existingById.binding_id,
      );
      if (retainedAggregate === null || retainedAggregate.state.phase !== "revoked") {
        storageIntegrityFailure();
      }
      if (
        existingById.binding_id !== input.bindingId ||
        existingById.reason_code !== input.reasonCode ||
        existingById.revocation_request_sha256 !== revocationRequestSha256
      ) {
        throw persistenceError(
          "SERVER_BINDING_IMMUTABLE_CONFLICT",
          "The Server binding revocation identity has different immutable state.",
        );
      }
      return revocationResult(existingById, "replayed");
    }

    const aggregate = loadVerifiedAggregateByBindingId(database, trustedIssuer, input.bindingId);
    if (aggregate === null) invalidInput("The Server binding is unavailable.");
    if (aggregate.state.phase === "revoked") {
      throw persistenceError(
        "SERVER_BINDING_TERMINAL_REVOKED",
        "The Server binding already has a different terminal revocation.",
      );
    }
    const priorPhase = aggregate.state.phase;
    const revokedAt = advanceServerBindingClock(database);
    database
      .prepare(`
        INSERT INTO server_binding_revocations (
          revocation_id,
          revocation_request_sha256,
          binding_id,
          prior_phase,
          reason_code,
          revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.revocationId,
        revocationRequestSha256,
        input.bindingId,
        priorPhase,
        input.reasonCode,
        revokedAt,
      );
    const inserted = readRevocationById(database, input.revocationId);
    if (inserted === null) storageIntegrityFailure();
    const revokedAggregate = loadVerifiedAggregateByBindingId(
      database,
      trustedIssuer,
      input.bindingId,
    );
    if (revokedAggregate === null || revokedAggregate.state.phase !== "revoked") {
      storageIntegrityFailure();
    }
    return revocationResult(inserted, "revoked");
  });
};
