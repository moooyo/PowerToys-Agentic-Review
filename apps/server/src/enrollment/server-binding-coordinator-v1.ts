import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
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
import type { DatabaseOperationMap } from "../database/protocol.js";
import type {
  ConfirmServerBindingRecordV1Input,
  ReadServerBindingRecoveryReceiptV1Input,
  RevokeServerBindingV1Input,
  ServerBindingActiveSnapshotV1,
  ServerBindingRecoveryReceiptV1,
  ServerBindingTrustedIssuerDescriptorV1,
} from "../database/server-binding-persistence-v1.js";
import { deriveServerBindingRevocationRequestSha256V1 } from "../database/server-binding-persistence-v1.js";
import {
  adoptServerBindingSignerV1,
  assertServerBindingSignerAdoptableV1,
  closeServerBindingSignerV1,
  readServerBindingSignerDescriptorV1,
  type ServerBindingSignerContextV1,
  ServerBindingSignerErrorV1,
  signServerBindingReceiptStatementV1,
} from "./server-binding-signer-v1.js";

const databaseHandleBrand: unique symbol = Symbol("server-binding-persistence-database-handle");
const tokenBytes = 32;
const tokenCharacters = 43;
const defaultOperationTimeoutMilliseconds = 30_000;
const defaultCloseTimeoutMilliseconds = 60_000;
const maximumTimeoutMilliseconds = 10 * 60 * 1_000;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/u;
const sha256 = /^[0-9a-f]{64}(?![\s\S])/u;
const entityId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
const packageComponentId = /^[a-z0-9][a-z0-9._+-]{0,127}(?![\s\S])/u;
const utcMilliseconds = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z(?![\s\S])/u;

export type ServerBindingPersistenceDatabaseOperation =
  | "claimServerBindingAuthorizationV1"
  | "commitServerBindingReceiptV1"
  | "confirmServerBindingRecordV1"
  | "createServerBindingAuthorizationV1"
  | "initializeServerBindingIssuerV1"
  | "readServerBindingActiveSnapshotV1"
  | "readServerBindingRecoveryReceiptV1"
  | "recheckServerBindingActiveSnapshotV1"
  | "revokeServerBindingV1";

export const isServerBindingPersistenceDatabaseOperation = (
  operation: string,
): operation is ServerBindingPersistenceDatabaseOperation => {
  switch (operation) {
    case "claimServerBindingAuthorizationV1":
    case "commitServerBindingReceiptV1":
    case "confirmServerBindingRecordV1":
    case "createServerBindingAuthorizationV1":
    case "initializeServerBindingIssuerV1":
    case "readServerBindingActiveSnapshotV1":
    case "readServerBindingRecoveryReceiptV1":
    case "recheckServerBindingActiveSnapshotV1":
    case "revokeServerBindingV1":
      return true;
    default:
      return false;
  }
};

type ServerBindingDatabaseRequest = <TOperation extends ServerBindingPersistenceDatabaseOperation>(
  operation: TOperation,
  input: DatabaseOperationMap[TOperation]["input"],
) => Promise<DatabaseOperationMap[TOperation]["output"]>;

interface ServerBindingDatabaseOwner {
  readonly identity: object;
  readonly terminalFailure: Promise<Error>;
  readonly request: ServerBindingDatabaseRequest;
}

export interface ServerBindingPersistenceDatabaseHandle {
  readonly [databaseHandleBrand]: true;
}

interface DatabaseHandleRecord {
  readonly owner: ServerBindingDatabaseOwner;
}

const databaseHandleRecords = new WeakMap<object, DatabaseHandleRecord>();

/** @internal Imported only by DatabaseClient and source-excluded tests. */
export const registerServerBindingPersistenceDatabaseHandle = (
  identity: object,
  owner: Omit<ServerBindingDatabaseOwner, "identity">,
): ServerBindingPersistenceDatabaseHandle => {
  if (
    (typeof identity !== "object" && typeof identity !== "function") ||
    identity === null ||
    !(owner?.terminalFailure instanceof Promise) ||
    typeof owner.request !== "function"
  ) {
    throw new TypeError("Server binding persistence database owner binding is invalid.");
  }
  const request = owner.request;
  const handle = Object.freeze(Object.create(null)) as ServerBindingPersistenceDatabaseHandle;
  databaseHandleRecords.set(handle, {
    owner: Object.freeze({
      identity,
      terminalFailure: owner.terminalFailure,
      request: (<TOperation extends ServerBindingPersistenceDatabaseOperation>(
        operation: TOperation,
        input: DatabaseOperationMap[TOperation]["input"],
      ) =>
        Reflect.apply(request, owner, [operation, input]) as Promise<
          DatabaseOperationMap[TOperation]["output"]
        >) as ServerBindingDatabaseRequest,
    }),
  });
  return handle;
};

/** @internal Allows DatabaseClient to abandon one unconsumed handle during shutdown. */
export const revokeServerBindingPersistenceDatabaseHandle = (
  handle: ServerBindingPersistenceDatabaseHandle,
): boolean => databaseHandleRecords.delete(handle);

const consumeDatabaseHandle = (
  handle: ServerBindingPersistenceDatabaseHandle,
): DatabaseHandleRecord => {
  if (typeof handle !== "object" || handle === null) {
    throw new TypeError("Server binding persistence database handle is invalid.");
  }
  const record = databaseHandleRecords.get(handle);
  if (record === undefined) {
    throw new TypeError("Server binding persistence database handle was consumed or forged.");
  }
  databaseHandleRecords.delete(handle);
  return record;
};

export type ServerBindingCoordinatorErrorCodeV1 =
  | "AUTHORIZATION_EXPIRED"
  | "CLOSED"
  | "IMMUTABLE_CONFLICT"
  | "INVALID_INPUT"
  | "NOT_READY"
  | "PERSISTENCE_OUTCOME_UNKNOWN"
  | "SIGNER_MISMATCH"
  | "SIGNER_UNAVAILABLE"
  | "STORAGE_INTEGRITY_FAILURE"
  | "TERMINAL_REVOKED"
  | "TRANSITION_INVALID";

export class ServerBindingCoordinatorErrorV1 extends Error {
  public constructor(
    public readonly code: ServerBindingCoordinatorErrorCodeV1,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ServerBindingCoordinatorErrorV1";
  }
}

export interface CreateServerBindingAuthorizationRequestV1 {
  readonly operatorIssuer: string;
  readonly operatorSubject: string;
  readonly workerNodeId: string;
  readonly installationId: string;
  readonly expectedCertificateDerSha256: string;
  readonly expiresAt: string;
}

export interface CreatedServerBindingAuthorizationV1 {
  readonly authorizationId: string;
  readonly requestId: string;
  readonly authorizationToken: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface IssueServerBindingReceiptRequestV1 {
  readonly requestId: string;
  readonly authorizationToken: string;
  readonly observedCertificateDerSha256: string;
}

export interface IssuedServerBindingReceiptV1 {
  readonly bindingId: string;
  readonly phase: "reserved" | "active";
  readonly receiptJson: string;
  readonly receiptSha256: string;
}

export interface ServerBindingAuthorityPortV1 {
  readonly createAuthorization: (
    input: CreateServerBindingAuthorizationRequestV1,
  ) => Promise<Readonly<CreatedServerBindingAuthorizationV1>>;
  readonly issueReceipt: (
    input: IssueServerBindingReceiptRequestV1,
  ) => Promise<Readonly<IssuedServerBindingReceiptV1>>;
  readonly confirmRecord: (
    input: ConfirmServerBindingRecordV1Input,
  ) => Promise<DatabaseOperationMap["confirmServerBindingRecordV1"]["output"]>;
  readonly readRecoveryReceipt: (
    input: ReadServerBindingRecoveryReceiptV1Input,
  ) => Promise<Readonly<ServerBindingRecoveryReceiptV1> | null>;
  readonly readActiveSnapshot: (
    input: ReadServerBindingRecoveryReceiptV1Input,
  ) => Promise<Readonly<ServerBindingActiveSnapshotV1> | null>;
  readonly recheckActiveSnapshot: (
    input: ServerBindingActiveSnapshotV1,
  ) => Promise<Readonly<ServerBindingActiveSnapshotV1>>;
  readonly revoke: (
    input: RevokeServerBindingV1Input,
  ) => Promise<DatabaseOperationMap["revokeServerBindingV1"]["output"]>;
}

export interface ServerBindingCoordinatorOptionsV1 {
  readonly database: ServerBindingPersistenceDatabaseHandle;
  readonly signer?: Readonly<ServerBindingSignerContextV1>;
  readonly operationTimeoutMilliseconds?: number;
  readonly closeTimeoutMilliseconds?: number;
}

type CoordinatorState = "new" | "opening" | "ready" | "closing" | "closed" | "failed";

const coordinatorError = (
  code: ServerBindingCoordinatorErrorCodeV1,
  message: string,
  cause?: unknown,
): ServerBindingCoordinatorErrorV1 =>
  new ServerBindingCoordinatorErrorV1(code, message, cause === undefined ? undefined : { cause });

const normalizeDatabaseError = (error: unknown): ServerBindingCoordinatorErrorV1 => {
  if (error instanceof ServerBindingCoordinatorErrorV1) return error;
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  switch (code) {
    case "SERVER_BINDING_AUTHORIZATION_EXPIRED":
      return coordinatorError("AUTHORIZATION_EXPIRED", "The binding authorization expired.", error);
    case "SERVER_BINDING_IMMUTABLE_CONFLICT":
      return coordinatorError("IMMUTABLE_CONFLICT", "The binding request conflicts.", error);
    case "SERVER_BINDING_INVALID_INPUT":
      return coordinatorError("INVALID_INPUT", "The binding request is invalid.", error);
    case "SERVER_BINDING_SIGNER_MISMATCH":
      return coordinatorError("SIGNER_MISMATCH", "The binding issuer does not match.", error);
    case "SERVER_BINDING_SIGNER_UNAVAILABLE":
      return coordinatorError("SIGNER_UNAVAILABLE", "The binding signer is unavailable.", error);
    case "SERVER_BINDING_STORAGE_INTEGRITY_FAILURE":
      return coordinatorError(
        "STORAGE_INTEGRITY_FAILURE",
        "The durable binding state is invalid.",
        error,
      );
    case "SERVER_BINDING_TERMINAL_REVOKED":
      return coordinatorError("TERMINAL_REVOKED", "The binding is permanently revoked.", error);
    case "SERVER_BINDING_TRANSITION_INVALID":
      return coordinatorError("TRANSITION_INVALID", "The binding transition is invalid.", error);
    default:
      return coordinatorError(
        "PERSISTENCE_OUTCOME_UNKNOWN",
        "The binding persistence outcome is unknown.",
        error,
      );
  }
};

const normalizeSignerError = (error: unknown): ServerBindingCoordinatorErrorV1 => {
  if (!(error instanceof ServerBindingSignerErrorV1)) {
    return coordinatorError("SIGNER_UNAVAILABLE", "The binding signer failed.", error);
  }
  switch (error.code) {
    case "SIGNER_INPUT_INVALID":
      return coordinatorError(
        "STORAGE_INTEGRITY_FAILURE",
        "The committed binding statement is invalid.",
        error,
      );
    case "SIGNER_MISMATCH":
    case "SIGNATURE_INVALID":
      return coordinatorError("SIGNER_MISMATCH", "The binding signature did not verify.", error);
    case "SIGNER_UNAVAILABLE":
      return coordinatorError("SIGNER_UNAVAILABLE", "The binding signer is unavailable.", error);
  }
};

type SnapshotFailureKind = "input" | "protocol";

const snapshotFailure = (kind: SnapshotFailureKind, message: string): never => {
  throw coordinatorError(kind === "input" ? "INVALID_INPUT" : "STORAGE_INTEGRITY_FAILURE", message);
};

const snapshotExactObject = (
  value: unknown,
  keys: readonly string[],
  kind: SnapshotFailureKind,
  name: string,
): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return snapshotFailure(kind, `${name} is invalid.`);
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return snapshotFailure(kind, `${name} could not be inspected.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return snapshotFailure(kind, `${name} must be a plain data object.`);
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return snapshotFailure(kind, `${name} has invalid fields.`);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      return snapshotFailure(kind, `${name} has invalid field descriptors.`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
};

const requireString = (
  value: unknown,
  maximumBytes: number,
  kind: SnapshotFailureKind,
  name: string,
): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.isWellFormed() ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    return snapshotFailure(kind, `${name} is invalid.`);
  }
  return value;
};

const requirePattern = (
  value: unknown,
  pattern: RegExp,
  kind: SnapshotFailureKind,
  name: string,
): string => {
  if (typeof value !== "string" || !pattern.test(value)) {
    return snapshotFailure(kind, `${name} is invalid.`);
  }
  return value;
};

const requireUtc = (value: unknown, kind: SnapshotFailureKind, name: string): string => {
  const text = requirePattern(value, utcMilliseconds, kind, name);
  const parsed = new Date(text);
  if (
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString() !== text ||
    text.startsWith("0000")
  ) {
    return snapshotFailure(kind, `${name} is invalid.`);
  }
  return text;
};

const requireOperatorIdentity = (
  value: unknown,
  maximumBytes: number,
  kind: SnapshotFailureKind,
  name: string,
): string => {
  const text = requireString(value, maximumBytes, kind, name);
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return snapshotFailure(kind, `${name} is invalid.`);
    }
  }
  return text;
};

const requirePackageComponentId = (
  value: unknown,
  kind: SnapshotFailureKind,
  name: string,
): string => {
  const text = requirePattern(value, packageComponentId, kind, name);
  const base = text.split(".", 1)[0]?.toLowerCase() ?? "";
  if (
    text.endsWith(".") ||
    ["aux", "clock$", "con", "conin$", "conout$", "nul", "prn"].includes(base) ||
    /^com[1-9](?![\s\S])/u.test(base) ||
    /^lpt[1-9](?![\s\S])/u.test(base)
  ) {
    return snapshotFailure(kind, `${name} is invalid.`);
  }
  return text;
};

const requireLiteral = <T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  kind: SnapshotFailureKind,
  name: string,
): T => {
  if (!allowed.includes(value as T)) return snapshotFailure(kind, `${name} is invalid.`);
  return value as T;
};

const digestText = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const snapshotCreateAuthorizationRequest = (
  value: unknown,
): Readonly<CreateServerBindingAuthorizationRequestV1> => {
  const fields = snapshotExactObject(
    value,
    [
      "operatorIssuer",
      "operatorSubject",
      "workerNodeId",
      "installationId",
      "expectedCertificateDerSha256",
      "expiresAt",
    ],
    "input",
    "Server binding authorization request",
  );
  return Object.freeze({
    operatorIssuer: requireOperatorIdentity(fields.operatorIssuer, 2048, "input", "operatorIssuer"),
    operatorSubject: requireOperatorIdentity(
      fields.operatorSubject,
      512,
      "input",
      "operatorSubject",
    ),
    workerNodeId: requirePattern(fields.workerNodeId, entityId, "input", "workerNodeId"),
    installationId: requirePackageComponentId(fields.installationId, "input", "installationId"),
    expectedCertificateDerSha256: requirePattern(
      fields.expectedCertificateDerSha256,
      sha256,
      "input",
      "expectedCertificateDerSha256",
    ),
    expiresAt: requireUtc(fields.expiresAt, "input", "expiresAt"),
  });
};

const snapshotIssueReceiptRequest = (
  value: unknown,
): Readonly<IssueServerBindingReceiptRequestV1> => {
  const fields = snapshotExactObject(
    value,
    ["requestId", "authorizationToken", "observedCertificateDerSha256"],
    "input",
    "Server binding receipt request",
  );
  return Object.freeze({
    requestId: requirePattern(fields.requestId, uuidV4, "input", "requestId"),
    authorizationToken: requireString(
      fields.authorizationToken,
      tokenCharacters,
      "input",
      "authorizationToken",
    ),
    observedCertificateDerSha256: requirePattern(
      fields.observedCertificateDerSha256,
      sha256,
      "input",
      "observedCertificateDerSha256",
    ),
  });
};

const snapshotReadInput = (
  value: unknown,
  kind: SnapshotFailureKind,
): Readonly<ReadServerBindingRecoveryReceiptV1Input> => {
  const fields = snapshotExactObject(
    value,
    ["certificateDerSha256"],
    kind,
    "Server binding read input",
  );
  return Object.freeze({
    certificateDerSha256: requirePattern(
      fields.certificateDerSha256,
      sha256,
      kind,
      "certificateDerSha256",
    ),
  });
};

const snapshotConfirmationInput = (value: unknown): Readonly<ConfirmServerBindingRecordV1Input> => {
  const fields = snapshotExactObject(
    value,
    [
      "bindingId",
      "bindingRevision",
      "workerNodeId",
      "installationId",
      "enrollmentGeneration",
      "certificateDerSha256",
      "recordDocumentSha256",
    ],
    "input",
    "Server binding confirmation",
  );
  return Object.freeze({
    bindingId: requirePattern(fields.bindingId, uuidV4, "input", "bindingId"),
    bindingRevision: requireLiteral(
      fields.bindingRevision,
      [1] as const,
      "input",
      "bindingRevision",
    ),
    workerNodeId: requirePattern(fields.workerNodeId, entityId, "input", "workerNodeId"),
    installationId: requirePackageComponentId(fields.installationId, "input", "installationId"),
    enrollmentGeneration: requireLiteral(
      fields.enrollmentGeneration,
      [1] as const,
      "input",
      "enrollmentGeneration",
    ),
    certificateDerSha256: requirePattern(
      fields.certificateDerSha256,
      sha256,
      "input",
      "certificateDerSha256",
    ),
    recordDocumentSha256: requirePattern(
      fields.recordDocumentSha256,
      sha256,
      "input",
      "recordDocumentSha256",
    ),
  });
};

const snapshotActiveSnapshot = (
  value: unknown,
  kind: SnapshotFailureKind,
): Readonly<ServerBindingActiveSnapshotV1> => {
  const fields = snapshotExactObject(
    value,
    [
      "bindingId",
      "bindingRevision",
      "workerNodeId",
      "installationId",
      "enrollmentGeneration",
      "certificateDerSha256",
      "issuerKeyId",
      "receiptSha256",
      "recordDocumentSha256",
    ],
    kind,
    "Server binding active snapshot",
  );
  return Object.freeze({
    bindingId: requirePattern(fields.bindingId, uuidV4, kind, "bindingId"),
    bindingRevision: requireLiteral(fields.bindingRevision, [1] as const, kind, "bindingRevision"),
    workerNodeId: requirePattern(fields.workerNodeId, entityId, kind, "workerNodeId"),
    installationId: requirePackageComponentId(fields.installationId, kind, "installationId"),
    enrollmentGeneration: requireLiteral(
      fields.enrollmentGeneration,
      [1] as const,
      kind,
      "enrollmentGeneration",
    ),
    certificateDerSha256: requirePattern(
      fields.certificateDerSha256,
      sha256,
      kind,
      "certificateDerSha256",
    ),
    issuerKeyId: requirePattern(fields.issuerKeyId, sha256, kind, "issuerKeyId"),
    receiptSha256: requirePattern(fields.receiptSha256, sha256, kind, "receiptSha256"),
    recordDocumentSha256: requirePattern(
      fields.recordDocumentSha256,
      sha256,
      kind,
      "recordDocumentSha256",
    ),
  });
};

const snapshotRevocationInput = (value: unknown): Readonly<RevokeServerBindingV1Input> => {
  const fields = snapshotExactObject(
    value,
    ["revocationId", "bindingId", "reasonCode"],
    "input",
    "Server binding revocation",
  );
  return Object.freeze({
    revocationId: requirePattern(fields.revocationId, uuidV4, "input", "revocationId"),
    bindingId: requirePattern(fields.bindingId, uuidV4, "input", "bindingId"),
    reasonCode: requireLiteral(
      fields.reasonCode,
      [
        "binding_compromised",
        "enrollment_abandoned",
        "integrity_failure",
        "operator_requested",
      ] as const,
      "input",
      "reasonCode",
    ),
  });
};

const snapshotReceipt = (
  value: unknown,
): Readonly<{ canonicalJson: string; receiptSha256: string }> => {
  const fields = snapshotExactObject(
    value,
    ["canonicalJson", "receiptSha256"],
    "protocol",
    "Server binding receipt response",
  );
  const canonicalJson = requireString(fields.canonicalJson, 4096, "protocol", "canonicalJson");
  const receiptSha256 = requirePattern(fields.receiptSha256, sha256, "protocol", "receiptSha256");
  try {
    const parsed = parseServerBindingReceiptV1(Buffer.from(canonicalJson, "utf8"));
    const remarshal = Buffer.from(marshalServerBindingReceiptV1(parsed)).toString("utf8");
    if (remarshal !== canonicalJson || digestText(canonicalJson) !== receiptSha256) {
      return snapshotFailure("protocol", "The Server binding receipt response is invalid.");
    }
  } catch {
    return snapshotFailure("protocol", "The Server binding receipt response is invalid.");
  }
  return Object.freeze({ canonicalJson, receiptSha256 });
};

const snapshotBasis = (
  value: unknown,
): Readonly<{
  issuer: Readonly<{
    algorithm: typeof SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM;
    issuer: typeof SERVER_BINDING_AUTHORITY_ISSUER;
    issuerKeyId: string;
    profileId: typeof SERVER_BINDING_RECEIPT_PROFILE_ID;
  }>;
  request: Readonly<{ requestId: string; requestSha256: string; tokenSha256: string }>;
  statement: Readonly<{ boundAt: string; canonicalJson: string; sha256: string }>;
  tuple: Readonly<{
    bindingId: string;
    bindingRevision: 1;
    certificateDerSha256: string;
    enrollmentGeneration: 1;
    installationId: string;
    workerNodeId: string;
  }>;
}> => {
  const fields = snapshotExactObject(
    value,
    ["issuer", "request", "statement", "tuple"],
    "protocol",
    "Server binding immutable basis",
  );
  const issuerFields = snapshotExactObject(
    fields.issuer,
    ["algorithm", "issuer", "issuerKeyId", "profileId"],
    "protocol",
    "Server binding issuer basis",
  );
  const requestFields = snapshotExactObject(
    fields.request,
    ["requestId", "requestSha256", "tokenSha256"],
    "protocol",
    "Server binding request basis",
  );
  const statementFields = snapshotExactObject(
    fields.statement,
    ["boundAt", "canonicalJson", "sha256"],
    "protocol",
    "Server binding statement basis",
  );
  const tupleFields = snapshotExactObject(
    fields.tuple,
    [
      "bindingId",
      "bindingRevision",
      "certificateDerSha256",
      "enrollmentGeneration",
      "installationId",
      "workerNodeId",
    ],
    "protocol",
    "Server binding tuple basis",
  );
  const canonicalJson = requireString(
    statementFields.canonicalJson,
    4096,
    "protocol",
    "statement.canonicalJson",
  );
  const statementSha256 = requirePattern(
    statementFields.sha256,
    sha256,
    "protocol",
    "statement.sha256",
  );
  let parsedStatement: ServerBindingReceiptStatementV1;
  try {
    parsedStatement = JSON.parse(canonicalJson) as ServerBindingReceiptStatementV1;
    if (
      Buffer.from(marshalServerBindingReceiptStatementV1(parsedStatement)).toString("utf8") !==
        canonicalJson ||
      digestText(canonicalJson) !== statementSha256
    ) {
      return snapshotFailure("protocol", "The Server binding statement basis is invalid.");
    }
  } catch {
    return snapshotFailure("protocol", "The Server binding statement basis is invalid.");
  }
  const tuple = Object.freeze({
    bindingId: requirePattern(tupleFields.bindingId, uuidV4, "protocol", "tuple.bindingId"),
    bindingRevision: requireLiteral(
      tupleFields.bindingRevision,
      [1] as const,
      "protocol",
      "tuple.bindingRevision",
    ),
    certificateDerSha256: requirePattern(
      tupleFields.certificateDerSha256,
      sha256,
      "protocol",
      "tuple.certificateDerSha256",
    ),
    enrollmentGeneration: requireLiteral(
      tupleFields.enrollmentGeneration,
      [1] as const,
      "protocol",
      "tuple.enrollmentGeneration",
    ),
    installationId: requirePackageComponentId(
      tupleFields.installationId,
      "protocol",
      "tuple.installationId",
    ),
    workerNodeId: requirePattern(
      tupleFields.workerNodeId,
      entityId,
      "protocol",
      "tuple.workerNodeId",
    ),
  });
  const boundAt = requireUtc(statementFields.boundAt, "protocol", "statement.boundAt");
  if (
    parsedStatement.bindingId !== tuple.bindingId ||
    parsedStatement.bindingRevision !== tuple.bindingRevision ||
    parsedStatement.certificateDerSha256 !== tuple.certificateDerSha256 ||
    parsedStatement.enrollmentGeneration !== tuple.enrollmentGeneration ||
    parsedStatement.installationId !== tuple.installationId ||
    parsedStatement.workerNodeId !== tuple.workerNodeId ||
    parsedStatement.boundAt !== boundAt ||
    parsedStatement.statementType !== "durable-binding-created"
  ) {
    return snapshotFailure("protocol", "The Server binding statement tuple is invalid.");
  }
  return Object.freeze({
    issuer: Object.freeze({
      algorithm: requireLiteral(
        issuerFields.algorithm,
        [SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM] as const,
        "protocol",
        "issuer.algorithm",
      ),
      issuer: requireLiteral(
        issuerFields.issuer,
        [SERVER_BINDING_AUTHORITY_ISSUER] as const,
        "protocol",
        "issuer.issuer",
      ),
      issuerKeyId: requirePattern(
        issuerFields.issuerKeyId,
        sha256,
        "protocol",
        "issuer.issuerKeyId",
      ),
      profileId: requireLiteral(
        issuerFields.profileId,
        [SERVER_BINDING_RECEIPT_PROFILE_ID] as const,
        "protocol",
        "issuer.profileId",
      ),
    }),
    request: Object.freeze({
      requestId: requirePattern(requestFields.requestId, uuidV4, "protocol", "request.requestId"),
      requestSha256: requirePattern(
        requestFields.requestSha256,
        sha256,
        "protocol",
        "request.requestSha256",
      ),
      tokenSha256: requirePattern(
        requestFields.tokenSha256,
        sha256,
        "protocol",
        "request.tokenSha256",
      ),
    }),
    statement: Object.freeze({
      boundAt,
      canonicalJson,
      sha256: statementSha256,
    }),
    tuple,
  });
};

const snapshotClaim = (value: unknown) => {
  const fields = snapshotExactObject(
    value,
    ["authorizationId", "basis"],
    "protocol",
    "Server binding claim response",
  );
  return Object.freeze({
    authorizationId: requirePattern(fields.authorizationId, uuidV4, "protocol", "authorizationId"),
    basis: snapshotBasis(fields.basis),
  });
};

const snapshotIssuer = (value: unknown) => {
  const fields = snapshotExactObject(
    value,
    [
      "authoritySchemaVersion",
      "issuer",
      "receiptProfileId",
      "activeStatusProfileId",
      "signatureAlgorithm",
      "issuerKeyId",
      "initializedAt",
    ],
    "protocol",
    "Server binding issuer response",
  );
  return Object.freeze({
    authoritySchemaVersion: requireLiteral(
      fields.authoritySchemaVersion,
      [SERVER_BINDING_AUTHORITY_SCHEMA_VERSION] as const,
      "protocol",
      "authoritySchemaVersion",
    ),
    issuer: requireLiteral(
      fields.issuer,
      [SERVER_BINDING_AUTHORITY_ISSUER] as const,
      "protocol",
      "issuer",
    ),
    receiptProfileId: requireLiteral(
      fields.receiptProfileId,
      [SERVER_BINDING_RECEIPT_PROFILE_ID] as const,
      "protocol",
      "receiptProfileId",
    ),
    activeStatusProfileId: requireLiteral(
      fields.activeStatusProfileId,
      [SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID] as const,
      "protocol",
      "activeStatusProfileId",
    ),
    signatureAlgorithm: requireLiteral(
      fields.signatureAlgorithm,
      [SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM] as const,
      "protocol",
      "signatureAlgorithm",
    ),
    issuerKeyId: requirePattern(fields.issuerKeyId, sha256, "protocol", "issuerKeyId"),
    initializedAt: requireUtc(fields.initializedAt, "protocol", "initializedAt"),
  });
};

const snapshotAuthorization = (value: unknown) => {
  const fields = snapshotExactObject(
    value,
    [
      "authorizationId",
      "requestId",
      "tokenSha256",
      "operatorIssuer",
      "operatorSubject",
      "workerNodeId",
      "installationId",
      "enrollmentGeneration",
      "expectedCertificateDerSha256",
      "issuerKeyId",
      "createdAt",
      "expiresAt",
      "consumption",
    ],
    "protocol",
    "Server binding authorization response",
  );
  const consumption =
    fields.consumption === null
      ? null
      : (() => {
          const consumptionFields = snapshotExactObject(
            fields.consumption,
            ["bindingId", "issuanceRequestSha256", "consumedAt"],
            "protocol",
            "Server binding authorization consumption",
          );
          return Object.freeze({
            bindingId: requirePattern(
              consumptionFields.bindingId,
              uuidV4,
              "protocol",
              "consumption.bindingId",
            ),
            issuanceRequestSha256: requirePattern(
              consumptionFields.issuanceRequestSha256,
              sha256,
              "protocol",
              "consumption.issuanceRequestSha256",
            ),
            consumedAt: requireUtc(
              consumptionFields.consumedAt,
              "protocol",
              "consumption.consumedAt",
            ),
          });
        })();
  return Object.freeze({
    authorizationId: requirePattern(fields.authorizationId, uuidV4, "protocol", "authorizationId"),
    requestId: requirePattern(fields.requestId, uuidV4, "protocol", "requestId"),
    tokenSha256: requirePattern(fields.tokenSha256, sha256, "protocol", "tokenSha256"),
    operatorIssuer: requireOperatorIdentity(
      fields.operatorIssuer,
      2048,
      "protocol",
      "operatorIssuer",
    ),
    operatorSubject: requireOperatorIdentity(
      fields.operatorSubject,
      512,
      "protocol",
      "operatorSubject",
    ),
    workerNodeId: requirePattern(fields.workerNodeId, entityId, "protocol", "workerNodeId"),
    installationId: requirePackageComponentId(fields.installationId, "protocol", "installationId"),
    enrollmentGeneration: requireLiteral(
      fields.enrollmentGeneration,
      [1] as const,
      "protocol",
      "enrollmentGeneration",
    ),
    expectedCertificateDerSha256: requirePattern(
      fields.expectedCertificateDerSha256,
      sha256,
      "protocol",
      "expectedCertificateDerSha256",
    ),
    issuerKeyId: requirePattern(fields.issuerKeyId, sha256, "protocol", "issuerKeyId"),
    createdAt: requireUtc(fields.createdAt, "protocol", "createdAt"),
    expiresAt: requireUtc(fields.expiresAt, "protocol", "expiresAt"),
    consumption,
  });
};

const snapshotDatabaseOutput = (
  operation: ServerBindingPersistenceDatabaseOperation,
  value: unknown,
): unknown => {
  switch (operation) {
    case "initializeServerBindingIssuerV1": {
      const fields = snapshotExactObject(
        value,
        ["outcome", "issuer"],
        "protocol",
        "Server binding initialization response",
      );
      return Object.freeze({
        outcome: requireLiteral(
          fields.outcome,
          ["initialized", "replayed"] as const,
          "protocol",
          "outcome",
        ),
        issuer: snapshotIssuer(fields.issuer),
      });
    }
    case "createServerBindingAuthorizationV1": {
      const fields = snapshotExactObject(
        value,
        ["outcome", "authorization"],
        "protocol",
        "Server binding authorization response",
      );
      return Object.freeze({
        outcome: requireLiteral(
          fields.outcome,
          ["created", "replayed"] as const,
          "protocol",
          "outcome",
        ),
        authorization: snapshotAuthorization(fields.authorization),
      });
    }
    case "claimServerBindingAuthorizationV1": {
      let replayShape = false;
      try {
        replayShape =
          value !== null &&
          typeof value === "object" &&
          Object.getOwnPropertyDescriptor(value, "outcome")?.value === "receipt_replay";
      } catch {
        return snapshotFailure("protocol", "The Server binding claim response is invalid.");
      }
      const base = snapshotExactObject(
        value,
        replayShape ? ["outcome", "retainedPhase", "claim", "receipt"] : ["outcome", "claim"],
        "protocol",
        "Server binding claim response",
      );
      const outcome = requireLiteral(
        base.outcome,
        ["signing_pending", "receipt_replay"] as const,
        "protocol",
        "outcome",
      );
      if (outcome === "signing_pending") {
        if (Reflect.ownKeys(base).length !== 2) {
          return snapshotFailure("protocol", "The Server binding claim response is invalid.");
        }
        return Object.freeze({ outcome, claim: snapshotClaim(base.claim) });
      }
      return Object.freeze({
        outcome,
        retainedPhase: requireLiteral(
          base.retainedPhase,
          ["reserved", "active"] as const,
          "protocol",
          "retainedPhase",
        ),
        claim: snapshotClaim(base.claim),
        receipt: snapshotReceipt(base.receipt),
      });
    }
    case "commitServerBindingReceiptV1": {
      const fields = snapshotExactObject(
        value,
        ["outcome", "retainedPhase", "receipt"],
        "protocol",
        "Server binding receipt commit response",
      );
      return Object.freeze({
        outcome: requireLiteral(
          fields.outcome,
          ["committed", "replayed"] as const,
          "protocol",
          "outcome",
        ),
        retainedPhase: requireLiteral(
          fields.retainedPhase,
          ["reserved", "active"] as const,
          "protocol",
          "retainedPhase",
        ),
        receipt: snapshotReceipt(fields.receipt),
      });
    }
    case "confirmServerBindingRecordV1": {
      const fields = snapshotExactObject(
        value,
        ["outcome", "bindingId", "recordDocumentSha256"],
        "protocol",
        "Server binding confirmation response",
      );
      return Object.freeze({
        outcome: requireLiteral(
          fields.outcome,
          ["confirmed", "replayed"] as const,
          "protocol",
          "outcome",
        ),
        bindingId: requirePattern(fields.bindingId, uuidV4, "protocol", "bindingId"),
        recordDocumentSha256: requirePattern(
          fields.recordDocumentSha256,
          sha256,
          "protocol",
          "recordDocumentSha256",
        ),
      });
    }
    case "readServerBindingRecoveryReceiptV1": {
      if (value === null) return null;
      const fields = snapshotExactObject(
        value,
        ["bindingId", "bindingRevision", "phase", "receiptJson", "receiptSha256"],
        "protocol",
        "Server binding recovery response",
      );
      const receipt = snapshotReceipt({
        canonicalJson: fields.receiptJson,
        receiptSha256: fields.receiptSha256,
      });
      return Object.freeze({
        bindingId: requirePattern(fields.bindingId, uuidV4, "protocol", "bindingId"),
        bindingRevision: requireLiteral(
          fields.bindingRevision,
          [1] as const,
          "protocol",
          "bindingRevision",
        ),
        phase: requireLiteral(fields.phase, ["reserved", "active"] as const, "protocol", "phase"),
        receiptJson: receipt.canonicalJson,
        receiptSha256: receipt.receiptSha256,
      });
    }
    case "readServerBindingActiveSnapshotV1":
      return value === null ? null : snapshotActiveSnapshot(value, "protocol");
    case "recheckServerBindingActiveSnapshotV1":
      return snapshotActiveSnapshot(value, "protocol");
    case "revokeServerBindingV1": {
      const fields = snapshotExactObject(
        value,
        [
          "outcome",
          "revocationId",
          "revocationRequestSha256",
          "bindingId",
          "priorPhase",
          "reasonCode",
          "revokedAt",
        ],
        "protocol",
        "Server binding revocation response",
      );
      return Object.freeze({
        outcome: requireLiteral(
          fields.outcome,
          ["revoked", "replayed"] as const,
          "protocol",
          "outcome",
        ),
        revocationId: requirePattern(fields.revocationId, uuidV4, "protocol", "revocationId"),
        revocationRequestSha256: requirePattern(
          fields.revocationRequestSha256,
          sha256,
          "protocol",
          "revocationRequestSha256",
        ),
        bindingId: requirePattern(fields.bindingId, uuidV4, "protocol", "bindingId"),
        priorPhase: requireLiteral(
          fields.priorPhase,
          ["signing_pending", "reserved", "active"] as const,
          "protocol",
          "priorPhase",
        ),
        reasonCode: requireLiteral(
          fields.reasonCode,
          [
            "binding_compromised",
            "enrollment_abandoned",
            "integrity_failure",
            "operator_requested",
          ] as const,
          "protocol",
          "reasonCode",
        ),
        revokedAt: requireUtc(fields.revokedAt, "protocol", "revokedAt"),
      });
    }
  }
};

const verifyReceiptForSigner = (
  receiptJson: string,
  signer: Readonly<ServerBindingSignerContextV1>,
  expectedStatementJson?: string,
): void => {
  try {
    const descriptor = readServerBindingSignerDescriptorV1(signer);
    const bytes = Buffer.from(receiptJson, "utf8");
    const receipt = parseServerBindingReceiptV1(bytes);
    verifyServerBindingReceiptWithSpkiV1(bytes, descriptor.issuerPublicKeySpki);
    const statementJson = Buffer.from(
      marshalServerBindingReceiptStatementV1(receipt.statement),
    ).toString("utf8");
    if (
      receipt.issuerKeyId !== descriptor.issuerKeyId ||
      (expectedStatementJson !== undefined && statementJson !== expectedStatementJson)
    ) {
      snapshotFailure("protocol", "The Server binding receipt response is invalid.");
    }
  } catch (error) {
    if (error instanceof ServerBindingCoordinatorErrorV1) throw error;
    snapshotFailure("protocol", "The Server binding receipt response is invalid.");
  }
};

const trustedDescriptorFromSigner = (
  signer: Readonly<ServerBindingSignerContextV1>,
): Readonly<ServerBindingTrustedIssuerDescriptorV1> => {
  const descriptor = readServerBindingSignerDescriptorV1(signer);
  return Object.freeze({
    authoritySchemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
    issuer: SERVER_BINDING_AUTHORITY_ISSUER,
    receiptProfileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
    activeStatusProfileId: SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
    signatureAlgorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
    issuerKeyId: descriptor.issuerKeyId,
    issuerPublicKeySpki: Uint8Array.from(descriptor.issuerPublicKeySpki),
  });
};

const decodeAuthorizationToken = (value: string): Buffer => {
  if (
    typeof value !== "string" ||
    value.length !== tokenCharacters ||
    /[^A-Za-z0-9_-]/u.test(value)
  ) {
    throw coordinatorError("INVALID_INPUT", "The binding authorization token is invalid.");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== tokenBytes || bytes.toString("base64url") !== value) {
    throw coordinatorError("INVALID_INPUT", "The binding authorization token is not canonical.");
  }
  return bytes;
};

const readTimeout = (value: number | undefined, fallback: number, name: string): number => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximumTimeoutMilliseconds) {
    throw new TypeError(`${name} is invalid.`);
  }
  return selected;
};

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
  createError: () => Error,
  onTimeout?: () => void,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(createError());
        }, timeoutMilliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export class ServerBindingCoordinatorV1 {
  readonly #database: ServerBindingDatabaseOwner;
  readonly #operationTimeoutMilliseconds: number;
  readonly #closeTimeoutMilliseconds: number;
  #signer: Readonly<ServerBindingSignerContextV1> | undefined;
  #state: CoordinatorState = "new";
  #authority: Readonly<ServerBindingAuthorityPortV1> | null = null;
  #terminalError: ServerBindingCoordinatorErrorV1 | undefined;
  #openPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #signerClosePromise: Promise<void> | undefined;
  readonly #terminalWaiters = new Set<(error: ServerBindingCoordinatorErrorV1) => void>();
  readonly #active = new Set<Promise<unknown>>();
  readonly #settlements = new Set<Promise<unknown>>();
  readonly #abortControllers = new Set<AbortController>();

  public constructor(options: ServerBindingCoordinatorOptionsV1) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("Server binding coordinator options are invalid.");
    }
    const signer = options.signer;
    this.#operationTimeoutMilliseconds = readTimeout(
      options.operationTimeoutMilliseconds,
      defaultOperationTimeoutMilliseconds,
      "operationTimeoutMilliseconds",
    );
    this.#closeTimeoutMilliseconds = readTimeout(
      options.closeTimeoutMilliseconds,
      defaultCloseTimeoutMilliseconds,
      "closeTimeoutMilliseconds",
    );
    if (signer !== undefined) {
      try {
        assertServerBindingSignerAdoptableV1(signer);
      } catch (error) {
        throw normalizeSignerError(error);
      }
    }
    const databaseHandle = options.database;
    const databaseRecord = consumeDatabaseHandle(databaseHandle);
    if (signer !== undefined) {
      try {
        adoptServerBindingSignerV1(signer, this);
      } catch (error) {
        databaseHandleRecords.set(databaseHandle, databaseRecord);
        throw normalizeSignerError(error);
      }
    }
    this.#database = databaseRecord.owner;
    this.#signer = signer;
    void this.#database.terminalFailure.then((error) => this.#fail(error));
  }

  public get state(): CoordinatorState {
    return this.#state;
  }

  public get authority(): Readonly<ServerBindingAuthorityPortV1> | null {
    return this.#state === "ready" ? this.#authority : null;
  }

  public open(): Promise<void> {
    if (this.#terminalError !== undefined) {
      return Promise.reject(this.#terminalError);
    }
    if (this.#state === "closing" || this.#state === "closed") {
      return Promise.reject(coordinatorError("CLOSED", "The binding coordinator is closed."));
    }
    if (this.#state !== "new") {
      return Promise.reject(
        coordinatorError("NOT_READY", "The binding coordinator open operation is single-use."),
      );
    }
    this.#state = "opening";
    this.#openPromise = this.#open();
    return this.#openPromise;
  }

  public close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #open(): Promise<void> {
    try {
      if (this.#terminalError !== undefined) throw this.#terminalError;
      const signer = this.#signer;
      if (signer !== undefined) {
        const initialization = this.#trackSettlement(
          this.#request("initializeServerBindingIssuerV1", {
            expectedIssuerKeyId: signer.issuerKeyId,
          }),
        );
        const initialized = await withTimeout(
          initialization,
          this.#operationTimeoutMilliseconds,
          () =>
            coordinatorError(
              "PERSISTENCE_OUTCOME_UNKNOWN",
              "The binding coordinator open deadline expired.",
            ),
        );
        if (initialized.issuer.issuerKeyId !== signer.issuerKeyId) {
          throw coordinatorError(
            "SIGNER_MISMATCH",
            "The binding signer does not match the database startup issuer.",
          );
        }
        if (this.#state === "opening") this.#authority = this.#createAuthorityPort();
      }
      if (this.#terminalError !== undefined) throw this.#terminalError;
      if (this.#state === "opening") this.#state = "ready";
    } catch (error) {
      if (this.#terminalError !== undefined) throw this.#terminalError;
      const normalized = normalizeDatabaseError(error);
      this.#fail(normalized);
      throw this.#terminalError ?? normalized;
    }
  }

  async #close(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state !== "failed") this.#state = "closing";
    try {
      await this.#openPromise?.catch(() => undefined);
      await withTimeout(
        Promise.allSettled([...this.#active]).then(() => undefined),
        this.#closeTimeoutMilliseconds,
        () =>
          coordinatorError(
            "PERSISTENCE_OUTCOME_UNKNOWN",
            "The binding coordinator close deadline expired.",
          ),
        () => this.#abortActiveOperations(),
      );
      await withTimeout(
        Promise.allSettled([...this.#settlements]).then(() => undefined),
        this.#closeTimeoutMilliseconds,
        () =>
          coordinatorError(
            "PERSISTENCE_OUTCOME_UNKNOWN",
            "The binding capability settlement deadline expired.",
          ),
        () => this.#abortActiveOperations(),
      );
      await withTimeout(this.#beginSignerClose(), this.#closeTimeoutMilliseconds, () =>
        coordinatorError(
          "PERSISTENCE_OUTCOME_UNKNOWN",
          "The binding signer close deadline expired.",
        ),
      );
      this.#authority = null;
      if (this.#terminalError !== undefined) throw this.#terminalError;
      this.#state = "closed";
    } catch (error) {
      if (this.#terminalError !== undefined) throw this.#terminalError;
      const normalized =
        error instanceof ServerBindingCoordinatorErrorV1
          ? error
          : coordinatorError(
              "PERSISTENCE_OUTCOME_UNKNOWN",
              "The binding coordinator failed.",
              error,
            );
      this.#fail(normalized);
      throw this.#terminalError ?? normalized;
    }
  }

  async #request<TOperation extends ServerBindingPersistenceDatabaseOperation>(
    operation: TOperation,
    input: DatabaseOperationMap[TOperation]["input"],
  ): Promise<DatabaseOperationMap[TOperation]["output"]> {
    const output = await this.#database.request(operation, input);
    return snapshotDatabaseOutput(operation, output) as DatabaseOperationMap[TOperation]["output"];
  }

  #trackSettlement<T>(started: Promise<T>): Promise<T> {
    this.#settlements.add(started);
    void started.finally(() => this.#settlements.delete(started)).catch(() => undefined);
    return started;
  }

  #createAuthorityPort(): Readonly<ServerBindingAuthorityPortV1> {
    return Object.freeze({
      createAuthorization: (input) => this.#run(() => this.#createAuthorization(input)),
      issueReceipt: (input) => this.#run((signal) => this.#issueReceipt(input, signal)),
      confirmRecord: (input) => this.#run(() => this.#confirmRecord(input)),
      readRecoveryReceipt: (input) => this.#run(() => this.#readRecoveryReceipt(input)),
      readActiveSnapshot: (input) => this.#run(() => this.#readActiveSnapshot(input)),
      recheckActiveSnapshot: (input) => this.#run(() => this.#recheckActiveSnapshot(input)),
      revoke: (input) => this.#run(() => this.#revoke(input)),
    } satisfies ServerBindingAuthorityPortV1);
  }

  #run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#terminalError !== undefined) {
      return Promise.reject(this.#terminalError);
    }
    if (this.#state === "closing" || this.#state === "closed") {
      return Promise.reject(coordinatorError("CLOSED", "The binding coordinator is closed."));
    }
    if (this.#state !== "ready" || this.#authority === null) {
      return Promise.reject(coordinatorError("NOT_READY", "The binding coordinator is not ready."));
    }
    const controller = new AbortController();
    this.#abortControllers.add(controller);
    let started: Promise<T>;
    try {
      started = operation(controller.signal);
    } catch (error) {
      started = Promise.reject(error);
    }
    this.#trackSettlement(started);
    void started.finally(() => this.#abortControllers.delete(controller)).catch(() => undefined);
    const bounded = withTimeout(
      started,
      this.#operationTimeoutMilliseconds,
      () =>
        coordinatorError(
          "PERSISTENCE_OUTCOME_UNKNOWN",
          "The binding persistence operation deadline expired.",
        ),
      () => controller.abort(new Error("Server binding operation deadline expired.")),
    );
    const terminal = Promise.withResolvers<never>();
    const rejectTerminal = (error: ServerBindingCoordinatorErrorV1): void => terminal.reject(error);
    this.#terminalWaiters.add(rejectTerminal);
    if (this.#terminalError !== undefined) rejectTerminal(this.#terminalError);
    const pending = Promise.race([bounded, terminal.promise])
      .then((result) => {
        if (this.#terminalError !== undefined) throw this.#terminalError;
        return result;
      })
      .catch((error: unknown) => {
        if (this.#terminalError !== undefined) throw this.#terminalError;
        const normalized =
          error instanceof ServerBindingCoordinatorErrorV1 ? error : normalizeDatabaseError(error);
        if (
          normalized.code === "PERSISTENCE_OUTCOME_UNKNOWN" ||
          normalized.code === "STORAGE_INTEGRITY_FAILURE" ||
          normalized.code === "SIGNER_MISMATCH"
        ) {
          this.#fail(normalized);
          throw this.#terminalError ?? normalized;
        }
        throw normalized;
      });
    this.#active.add(pending);
    void pending
      .finally(() => {
        this.#active.delete(pending);
        this.#terminalWaiters.delete(rejectTerminal);
      })
      .catch(() => undefined);
    return pending;
  }

  async #createAuthorization(
    input: CreateServerBindingAuthorizationRequestV1,
  ): Promise<Readonly<CreatedServerBindingAuthorizationV1>> {
    const request = snapshotCreateAuthorizationRequest(input);
    const token = randomBytes(tokenBytes);
    const authorizationToken = token.toString("base64url");
    const tokenSha256 = createHash("sha256").update(token).digest("hex");
    token.fill(0);
    const createdAt = new Date().toISOString();
    const authorizationId = randomUUID();
    const requestId = randomUUID();
    const persisted = await this.#request("createServerBindingAuthorizationV1", {
      authorizationId,
      requestId,
      tokenSha256,
      operatorIssuer: request.operatorIssuer,
      operatorSubject: request.operatorSubject,
      workerNodeId: request.workerNodeId,
      installationId: request.installationId,
      enrollmentGeneration: 1,
      expectedCertificateDerSha256: request.expectedCertificateDerSha256,
      createdAt,
      expiresAt: request.expiresAt,
    });
    const retained = persisted.authorization;
    if (
      retained.authorizationId !== authorizationId ||
      retained.requestId !== requestId ||
      retained.tokenSha256 !== tokenSha256 ||
      retained.operatorIssuer !== request.operatorIssuer ||
      retained.operatorSubject !== request.operatorSubject ||
      retained.workerNodeId !== request.workerNodeId ||
      retained.installationId !== request.installationId ||
      retained.enrollmentGeneration !== 1 ||
      retained.expectedCertificateDerSha256 !== request.expectedCertificateDerSha256 ||
      retained.issuerKeyId !== this.#signer?.issuerKeyId ||
      retained.createdAt !== createdAt ||
      retained.expiresAt !== request.expiresAt ||
      retained.consumption !== null
    ) {
      snapshotFailure("protocol", "The Server binding authorization response is invalid.");
    }
    return Object.freeze({
      authorizationId,
      requestId,
      authorizationToken,
      createdAt,
      expiresAt: request.expiresAt,
    });
  }

  async #issueReceipt(
    input: IssueServerBindingReceiptRequestV1,
    signal: AbortSignal,
  ): Promise<Readonly<IssuedServerBindingReceiptV1>> {
    const request = snapshotIssueReceiptRequest(input);
    const signer = this.#signer;
    if (signer === undefined) {
      throw coordinatorError("SIGNER_UNAVAILABLE", "The binding signer is unavailable.");
    }
    const token = decodeAuthorizationToken(request.authorizationToken);
    const tokenSha256 = createHash("sha256").update(token).digest("hex");
    token.fill(0);
    const claim = await this.#request("claimServerBindingAuthorizationV1", {
      requestId: request.requestId,
      tokenSha256,
      observedCertificateDerSha256: request.observedCertificateDerSha256,
    });
    if (this.#terminalError !== undefined) throw this.#terminalError;
    if (
      claim.claim.basis.request.requestId !== request.requestId ||
      claim.claim.basis.request.tokenSha256 !== tokenSha256 ||
      claim.claim.basis.tuple.certificateDerSha256 !== request.observedCertificateDerSha256 ||
      claim.claim.basis.issuer.issuerKeyId !== signer.issuerKeyId
    ) {
      snapshotFailure("protocol", "The Server binding claim response is invalid.");
    }
    if (claim.outcome === "receipt_replay") {
      verifyReceiptForSigner(
        claim.receipt.canonicalJson,
        signer,
        claim.claim.basis.statement.canonicalJson,
      );
      return Object.freeze({
        bindingId: claim.claim.basis.tuple.bindingId,
        phase: claim.retainedPhase,
        receiptJson: claim.receipt.canonicalJson,
        receiptSha256: claim.receipt.receiptSha256,
      });
    }

    let signature: string;
    try {
      signature = await signServerBindingReceiptStatementV1(
        signer,
        Buffer.from(claim.claim.basis.statement.canonicalJson, "utf8"),
        signal,
      );
    } catch (error) {
      throw normalizeSignerError(error);
    }
    if (this.#terminalError !== undefined) throw this.#terminalError;
    const statement = JSON.parse(
      claim.claim.basis.statement.canonicalJson,
    ) as ServerBindingReceiptStatementV1;
    const receiptJson = Buffer.from(
      marshalServerBindingReceiptV1({
        algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
        issuer: SERVER_BINDING_AUTHORITY_ISSUER,
        issuerKeyId: signer.issuerKeyId,
        profileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
        schemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
        signature,
        statement,
      }),
    ).toString("utf8");
    const committed = await this.#request("commitServerBindingReceiptV1", {
      bindingId: claim.claim.basis.tuple.bindingId,
      issuanceRequestSha256: claim.claim.basis.request.requestSha256,
      receiptJson,
    });
    verifyReceiptForSigner(
      committed.receipt.canonicalJson,
      signer,
      claim.claim.basis.statement.canonicalJson,
    );
    return Object.freeze({
      bindingId: claim.claim.basis.tuple.bindingId,
      phase: committed.retainedPhase,
      receiptJson: committed.receipt.canonicalJson,
      receiptSha256: committed.receipt.receiptSha256,
    });
  }

  async #confirmRecord(
    input: ConfirmServerBindingRecordV1Input,
  ): Promise<DatabaseOperationMap["confirmServerBindingRecordV1"]["output"]> {
    const request = snapshotConfirmationInput(input);
    const result = await this.#request("confirmServerBindingRecordV1", request);
    if (
      result.bindingId !== request.bindingId ||
      result.recordDocumentSha256 !== request.recordDocumentSha256
    ) {
      snapshotFailure("protocol", "The Server binding confirmation response is invalid.");
    }
    return result;
  }

  async #readRecoveryReceipt(
    input: ReadServerBindingRecoveryReceiptV1Input,
  ): Promise<Readonly<ServerBindingRecoveryReceiptV1> | null> {
    const request = snapshotReadInput(input, "input");
    const result = await this.#request("readServerBindingRecoveryReceiptV1", request);
    if (result === null) return null;
    const signer = this.#signer;
    if (signer === undefined) {
      throw coordinatorError("SIGNER_UNAVAILABLE", "The binding signer is unavailable.");
    }
    verifyReceiptForSigner(result.receiptJson, signer);
    const receipt = parseServerBindingReceiptV1(Buffer.from(result.receiptJson, "utf8"));
    if (
      receipt.statement.certificateDerSha256 !== request.certificateDerSha256 ||
      receipt.statement.bindingId !== result.bindingId ||
      receipt.statement.bindingRevision !== result.bindingRevision
    ) {
      snapshotFailure("protocol", "The Server binding recovery response is invalid.");
    }
    return result;
  }

  async #readActiveSnapshot(
    input: ReadServerBindingRecoveryReceiptV1Input,
  ): Promise<Readonly<ServerBindingActiveSnapshotV1> | null> {
    const request = snapshotReadInput(input, "input");
    const result = await this.#request("readServerBindingActiveSnapshotV1", request);
    if (result === null) return null;
    const signer = this.#signer;
    if (
      result.certificateDerSha256 !== request.certificateDerSha256 ||
      signer === undefined ||
      result.issuerKeyId !== signer.issuerKeyId
    ) {
      snapshotFailure("protocol", "The Server binding active response is invalid.");
    }
    return result;
  }

  async #recheckActiveSnapshot(
    input: ServerBindingActiveSnapshotV1,
  ): Promise<Readonly<ServerBindingActiveSnapshotV1>> {
    const request = snapshotActiveSnapshot(input, "input");
    const result = await this.#request("recheckServerBindingActiveSnapshotV1", request);
    if (JSON.stringify(result) !== JSON.stringify(request)) {
      snapshotFailure("protocol", "The Server binding active recheck response is invalid.");
    }
    return result;
  }

  async #revoke(
    input: RevokeServerBindingV1Input,
  ): Promise<DatabaseOperationMap["revokeServerBindingV1"]["output"]> {
    const request = snapshotRevocationInput(input);
    const result = await this.#request("revokeServerBindingV1", request);
    if (
      result.revocationId !== request.revocationId ||
      result.bindingId !== request.bindingId ||
      result.reasonCode !== request.reasonCode
    ) {
      snapshotFailure("protocol", "The Server binding revocation response is invalid.");
    }
    if (result.revocationRequestSha256 !== deriveServerBindingRevocationRequestSha256V1(request)) {
      snapshotFailure("protocol", "The Server binding revocation response is invalid.");
    }
    return result;
  }

  #abortActiveOperations(): void {
    for (const controller of this.#abortControllers) {
      controller.abort(new Error("Server binding coordinator shutdown requested."));
    }
  }

  #beginSignerClose(): Promise<void> {
    if (this.#signerClosePromise !== undefined) return this.#signerClosePromise;
    const signer = this.#signer;
    this.#signer = undefined;
    this.#signerClosePromise =
      signer === undefined ? Promise.resolve() : closeServerBindingSignerV1(signer, this);
    return this.#signerClosePromise;
  }

  #fail(error: unknown): void {
    if (this.#terminalError !== undefined || this.#state === "closed") return;
    const terminalError =
      error instanceof ServerBindingCoordinatorErrorV1
        ? error
        : coordinatorError(
            "PERSISTENCE_OUTCOME_UNKNOWN",
            "The binding coordinator entered a terminal failure.",
            error,
          );
    this.#terminalError = terminalError;
    this.#authority = null;
    this.#state = "failed";
    for (const rejectTerminal of this.#terminalWaiters) rejectTerminal(terminalError);
    this.#terminalWaiters.clear();
    this.#abortActiveOperations();
    void this.#beginSignerClose().catch(() => undefined);
  }
}

export const createServerBindingTrustedIssuerDescriptorFromSignerV1 = (
  signer: Readonly<ServerBindingSignerContextV1>,
): Readonly<ServerBindingTrustedIssuerDescriptorV1> => trustedDescriptorFromSigner(signer);
