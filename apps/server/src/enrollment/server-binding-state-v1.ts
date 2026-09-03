import { createHash } from "node:crypto";

const algorithm = "ecdsa-p256-sha256-p1363-low-s" as const;
const issuerName = "agentic-review-server-enrollment-binding-authority-v1" as const;
const receiptProfile = "agentic-review-server-binding-receipt-v1" as const;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/u;
const sha256 = /^[a-f0-9]{64}(?![\s\S])/u;
const entityId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
const packageComponent = /^[a-z0-9][a-z0-9._+-]{0,127}(?![\s\S])/u;
const utcMilliseconds = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z(?![\s\S])/u;
const signature = /^[A-Za-z0-9_-]{85}[AQgw](?![\s\S])/u;
const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const p256Order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const p256HalfOrder = p256Order >> 1n;
const issuedStates = new WeakSet<object>();

export type ServerBindingPhaseV1 = "absent" | "signing_pending" | "reserved" | "active" | "revoked";

export type ServerBindingRevocationReasonV1 =
  | "binding_compromised"
  | "enrollment_abandoned"
  | "integrity_failure"
  | "operator_requested";

export type ServerBindingStateErrorCodeV1 =
  | "EVENT_INVALID"
  | "IMMUTABLE_CONFLICT"
  | "RECEIPT_CONFLICT"
  | "RECORD_CONFLICT"
  | "REVOCATION_CONFLICT"
  | "STATE_INVALID"
  | "TERMINAL_REVOKED"
  | "TRANSITION_INVALID";

export class ServerBindingStateErrorV1 extends Error {
  public constructor(
    public readonly code: ServerBindingStateErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "ServerBindingStateErrorV1";
  }
}

export interface ServerBindingTupleV1 {
  readonly bindingId: string;
  readonly bindingRevision: 1;
  readonly certificateDerSha256: string;
  readonly enrollmentGeneration: 1;
  readonly installationId: string;
  readonly workerNodeId: string;
}

export interface ServerBindingIssuerV1 {
  readonly algorithm: typeof algorithm;
  readonly issuer: typeof issuerName;
  readonly issuerKeyId: string;
  readonly profileId: typeof receiptProfile;
}

export interface ServerBindingStatementSnapshotV1 {
  readonly boundAt: string;
  readonly canonicalJson: string;
  readonly sha256: string;
}

export interface ServerBindingRequestSnapshotV1 {
  readonly requestId: string;
  readonly requestSha256: string;
  readonly tokenSha256: string;
}

export interface ServerBindingImmutableBasisV1 {
  readonly issuer: Readonly<ServerBindingIssuerV1>;
  readonly request: Readonly<ServerBindingRequestSnapshotV1>;
  readonly statement: Readonly<ServerBindingStatementSnapshotV1>;
  readonly tuple: Readonly<ServerBindingTupleV1>;
}

export interface ServerBindingReceiptSnapshotV1 {
  readonly canonicalJson: string;
  readonly receiptSha256: string;
}

export interface ServerBindingRecordSnapshotV1 {
  readonly recordDocumentSha256: string;
}

export interface ServerBindingRevocationSnapshotV1 {
  readonly priorPhase: "signing_pending" | "reserved" | "active";
  readonly reasonCode: ServerBindingRevocationReasonV1;
  readonly revocationId: string;
  readonly revokedAt: string;
}

export interface ServerBindingStateV1 {
  readonly basis: Readonly<ServerBindingImmutableBasisV1> | null;
  readonly phase: ServerBindingPhaseV1;
  readonly receipt: Readonly<ServerBindingReceiptSnapshotV1> | null;
  readonly record: Readonly<ServerBindingRecordSnapshotV1> | null;
  readonly revocation: Readonly<ServerBindingRevocationSnapshotV1> | null;
}

export type ServerBindingStateEventV1 =
  | Readonly<{ type: "begin_signing"; basis: Readonly<ServerBindingImmutableBasisV1> }>
  | Readonly<{
      type: "commit_receipt";
      basis: Readonly<ServerBindingImmutableBasisV1>;
      receipt: Readonly<ServerBindingReceiptSnapshotV1>;
    }>
  | Readonly<{
      type: "confirm_record";
      basis: Readonly<ServerBindingImmutableBasisV1>;
      receipt: Readonly<ServerBindingReceiptSnapshotV1>;
      record: Readonly<ServerBindingRecordSnapshotV1>;
    }>
  | Readonly<{
      type: "revoke";
      basis: Readonly<ServerBindingImmutableBasisV1>;
      receipt: Readonly<ServerBindingReceiptSnapshotV1> | null;
      record: Readonly<ServerBindingRecordSnapshotV1> | null;
      revocation: Readonly<ServerBindingRevocationSnapshotV1>;
    }>;

type StructuralCode = "EVENT_INVALID" | "STATE_INVALID";
type Descriptors = Readonly<Record<string, PropertyDescriptor>>;

/**
 * Creates a source-only lifecycle fact with no policy or permission meaning. S0 deliberately has
 * no hydration API: only snapshots minted in this module can be reduced.
 */
export function createAbsentServerBindingStateV1(): Readonly<ServerBindingStateV1> {
  return freezeState({
    basis: null,
    phase: "absent",
    receipt: null,
    record: null,
    revocation: null,
  });
}

/**
 * Reduces one already-routed persistence fact without I/O, clocks, callbacks, or authority. Its
 * SHA-256 checks are deterministic data validation; signature trust remains outside this model.
 * Event inputs must be ordinary non-Proxy plain data. Reflection failures are rejected closed.
 */
export function reduceServerBindingStateV1(
  state: Readonly<ServerBindingStateV1>,
  eventValue: Readonly<ServerBindingStateEventV1>,
): Readonly<ServerBindingStateV1> {
  assertState(state);
  const event = snapshotEvent(eventValue);

  if (state.phase === "revoked") return terminalReplay(state, event);
  if (state.phase === "absent") {
    if (event.type !== "begin_signing") {
      throw failure("TRANSITION_INVALID", "An absent binding accepts only begin_signing.");
    }
    return freezeState({
      basis: event.basis,
      phase: "signing_pending",
      receipt: null,
      record: null,
      revocation: null,
    });
  }

  requireSameBasis(state.basis, event.basis);
  switch (event.type) {
    case "begin_signing":
      return state;
    case "commit_receipt":
      if (state.phase === "signing_pending") {
        return freezeState({
          basis: state.basis,
          phase: "reserved",
          receipt: event.receipt,
          record: null,
          revocation: null,
        });
      }
      if (state.phase === "reserved" || state.phase === "active") {
        if (sameReceipt(state.receipt, event.receipt)) return state;
        throw failure("RECEIPT_CONFLICT", "Receipt replay changed the first committed bytes.");
      }
      throw failure("TRANSITION_INVALID", "Receipt commit is invalid in this state.");
    case "confirm_record":
      if (state.phase === "signing_pending") {
        throw failure("TRANSITION_INVALID", "Record confirmation requires reserved state.");
      }
      if (!sameReceipt(state.receipt, event.receipt)) {
        throw failure("RECEIPT_CONFLICT", "Record confirmation changed the retained receipt.");
      }
      if (state.phase === "active") {
        if (sameRecord(state.record, event.record)) return state;
        throw failure("RECORD_CONFLICT", "Record replay changed the first confirmed digest.");
      }
      return freezeState({
        basis: state.basis,
        phase: "active",
        receipt: state.receipt,
        record: event.record,
        revocation: null,
      });
    case "revoke":
      if (event.revocation.priorPhase !== state.phase) {
        throw failure("REVOCATION_CONFLICT", "Revocation does not bind the retained prior state.");
      }
      requireSameReceipt(state.receipt, event.receipt);
      requireSameRecord(state.record, event.record);
      return freezeState({
        basis: state.basis,
        phase: "revoked",
        receipt: state.receipt,
        record: state.record,
        revocation: event.revocation,
      });
  }
}

function terminalReplay(
  state: Readonly<ServerBindingStateV1>,
  event: Readonly<ServerBindingStateEventV1>,
): Readonly<ServerBindingStateV1> {
  if (event.type !== "revoke") {
    throw failure(
      "TERMINAL_REVOKED",
      "A revoked binding accepts only its exact revocation replay.",
    );
  }
  requireSameBasis(state.basis, event.basis);
  requireSameReceipt(state.receipt, event.receipt);
  requireSameRecord(state.record, event.record);
  if (!sameRevocation(state.revocation, event.revocation)) {
    throw failure("REVOCATION_CONFLICT", "Revocation replay changed the terminal record.");
  }
  return state;
}

function snapshotEvent(value: unknown): Readonly<ServerBindingStateEventV1> {
  const fields = readFields(value, "EVENT_INVALID", "Server binding event");
  const type = field(fields, "type");
  switch (type) {
    case "begin_signing":
      exactFields(fields, ["basis", "type"], "EVENT_INVALID", "Begin-signing event");
      return Object.freeze({
        type,
        basis: snapshotBasis(field(fields, "basis"), "EVENT_INVALID"),
      });
    case "commit_receipt":
      exactFields(fields, ["basis", "receipt", "type"], "EVENT_INVALID", "Receipt event");
      {
        const basis = snapshotBasis(field(fields, "basis"), "EVENT_INVALID");
        return Object.freeze({
          type,
          basis,
          receipt: snapshotReceipt(field(fields, "receipt"), "EVENT_INVALID", basis),
        });
      }
    case "confirm_record":
      exactFields(fields, ["basis", "receipt", "record", "type"], "EVENT_INVALID", "Record event");
      {
        const basis = snapshotBasis(field(fields, "basis"), "EVENT_INVALID");
        return Object.freeze({
          type,
          basis,
          receipt: snapshotReceipt(field(fields, "receipt"), "EVENT_INVALID", basis),
          record: snapshotRecord(field(fields, "record"), "EVENT_INVALID"),
        });
      }
    case "revoke":
      exactFields(
        fields,
        ["basis", "receipt", "record", "revocation", "type"],
        "EVENT_INVALID",
        "Revocation event",
      );
      {
        const basis = snapshotBasis(field(fields, "basis"), "EVENT_INVALID");
        return Object.freeze({
          type,
          basis,
          receipt: snapshotNullableReceipt(field(fields, "receipt"), "EVENT_INVALID", basis),
          record: snapshotNullableRecord(field(fields, "record"), "EVENT_INVALID"),
          revocation: snapshotRevocation(field(fields, "revocation"), "EVENT_INVALID"),
        });
      }
    default:
      throw failure("EVENT_INVALID", "Server binding event type is invalid.");
  }
}

function snapshotBasis(
  value: unknown,
  code: StructuralCode,
): Readonly<ServerBindingImmutableBasisV1> {
  const fields = readFields(value, code, "Server binding immutable basis");
  exactFields(fields, ["issuer", "request", "statement", "tuple"], code, "Immutable basis");
  const tuple = snapshotTuple(field(fields, "tuple"), code);
  const issuer = snapshotIssuer(field(fields, "issuer"), code);
  const statement = snapshotStatement(field(fields, "statement"), code);
  assertStatementBinding(statement, tuple, code);
  return Object.freeze({
    issuer,
    request: snapshotRequest(field(fields, "request"), code),
    statement,
    tuple,
  });
}

function snapshotTuple(value: unknown, code: StructuralCode): Readonly<ServerBindingTupleV1> {
  const fields = readFields(value, code, "Server binding tuple");
  exactFields(
    fields,
    [
      "bindingId",
      "bindingRevision",
      "certificateDerSha256",
      "enrollmentGeneration",
      "installationId",
      "workerNodeId",
    ],
    code,
    "Server binding tuple",
  );
  const result = {
    bindingId: field(fields, "bindingId"),
    bindingRevision: field(fields, "bindingRevision"),
    certificateDerSha256: field(fields, "certificateDerSha256"),
    enrollmentGeneration: field(fields, "enrollmentGeneration"),
    installationId: field(fields, "installationId"),
    workerNodeId: field(fields, "workerNodeId"),
  };
  if (
    typeof result.bindingId !== "string" ||
    !uuidV4.test(result.bindingId) ||
    result.bindingRevision !== 1 ||
    typeof result.certificateDerSha256 !== "string" ||
    !sha256.test(result.certificateDerSha256) ||
    result.enrollmentGeneration !== 1 ||
    typeof result.installationId !== "string" ||
    !validPackageComponent(result.installationId) ||
    typeof result.workerNodeId !== "string" ||
    !entityId.test(result.workerNodeId)
  ) {
    throw failure(code, "Server binding tuple is invalid.");
  }
  return Object.freeze(result) as Readonly<ServerBindingTupleV1>;
}

function snapshotIssuer(value: unknown, code: StructuralCode): Readonly<ServerBindingIssuerV1> {
  const fields = readFields(value, code, "Server binding issuer");
  exactFields(fields, ["algorithm", "issuer", "issuerKeyId", "profileId"], code, "Issuer");
  const result = {
    algorithm: field(fields, "algorithm"),
    issuer: field(fields, "issuer"),
    issuerKeyId: field(fields, "issuerKeyId"),
    profileId: field(fields, "profileId"),
  };
  if (
    result.algorithm !== algorithm ||
    result.issuer !== issuerName ||
    typeof result.issuerKeyId !== "string" ||
    !sha256.test(result.issuerKeyId) ||
    result.profileId !== receiptProfile
  ) {
    throw failure(code, "Server binding issuer is invalid.");
  }
  return Object.freeze(result) as Readonly<ServerBindingIssuerV1>;
}

function snapshotStatement(
  value: unknown,
  code: StructuralCode,
): Readonly<ServerBindingStatementSnapshotV1> {
  const fields = readFields(value, code, "Server binding statement");
  exactFields(fields, ["boundAt", "canonicalJson", "sha256"], code, "Statement");
  const result = {
    boundAt: field(fields, "boundAt"),
    canonicalJson: field(fields, "canonicalJson"),
    sha256: field(fields, "sha256"),
  };
  if (
    typeof result.boundAt !== "string" ||
    !validUtc(result.boundAt) ||
    typeof result.canonicalJson !== "string" ||
    !validJsonSnapshot(result.canonicalJson) ||
    typeof result.sha256 !== "string" ||
    !sha256.test(result.sha256) ||
    digest(result.canonicalJson) !== result.sha256
  ) {
    throw failure(code, "Server binding statement snapshot is invalid.");
  }
  return Object.freeze(result) as Readonly<ServerBindingStatementSnapshotV1>;
}

function snapshotRequest(
  value: unknown,
  code: StructuralCode,
): Readonly<ServerBindingRequestSnapshotV1> {
  const fields = readFields(value, code, "Server binding request");
  exactFields(fields, ["requestId", "requestSha256", "tokenSha256"], code, "Request");
  const result = {
    requestId: field(fields, "requestId"),
    requestSha256: field(fields, "requestSha256"),
    tokenSha256: field(fields, "tokenSha256"),
  };
  if (
    typeof result.requestId !== "string" ||
    !entityId.test(result.requestId) ||
    typeof result.requestSha256 !== "string" ||
    !sha256.test(result.requestSha256) ||
    typeof result.tokenSha256 !== "string" ||
    !sha256.test(result.tokenSha256)
  ) {
    throw failure(code, "Server binding request snapshot is invalid.");
  }
  return Object.freeze(result) as Readonly<ServerBindingRequestSnapshotV1>;
}

function snapshotReceipt(
  value: unknown,
  code: StructuralCode,
  basis: Readonly<ServerBindingImmutableBasisV1>,
): Readonly<ServerBindingReceiptSnapshotV1> {
  const fields = readFields(value, code, "Server binding receipt");
  exactFields(fields, ["canonicalJson", "receiptSha256"], code, "Receipt");
  const result = {
    canonicalJson: field(fields, "canonicalJson"),
    receiptSha256: field(fields, "receiptSha256"),
  };
  if (
    typeof result.canonicalJson !== "string" ||
    !validJsonSnapshot(result.canonicalJson) ||
    typeof result.receiptSha256 !== "string" ||
    !sha256.test(result.receiptSha256) ||
    digest(result.canonicalJson) !== result.receiptSha256
  ) {
    throw failure(code, "Server binding receipt snapshot is invalid.");
  }
  assertReceiptBinding(result.canonicalJson as string, basis, code);
  return Object.freeze(result) as Readonly<ServerBindingReceiptSnapshotV1>;
}

function snapshotRecord(
  value: unknown,
  code: StructuralCode,
): Readonly<ServerBindingRecordSnapshotV1> {
  const fields = readFields(value, code, "Server binding record");
  exactFields(fields, ["recordDocumentSha256"], code, "Record");
  const recordDocumentSha256 = field(fields, "recordDocumentSha256");
  if (typeof recordDocumentSha256 !== "string" || !sha256.test(recordDocumentSha256)) {
    throw failure(code, "Server binding record snapshot is invalid.");
  }
  return Object.freeze({ recordDocumentSha256 });
}

function snapshotRevocation(
  value: unknown,
  code: StructuralCode,
): Readonly<ServerBindingRevocationSnapshotV1> {
  const fields = readFields(value, code, "Server binding revocation");
  exactFields(
    fields,
    ["priorPhase", "reasonCode", "revocationId", "revokedAt"],
    code,
    "Revocation",
  );
  const result = {
    priorPhase: field(fields, "priorPhase"),
    reasonCode: field(fields, "reasonCode"),
    revocationId: field(fields, "revocationId"),
    revokedAt: field(fields, "revokedAt"),
  };
  if (
    (result.priorPhase !== "signing_pending" &&
      result.priorPhase !== "reserved" &&
      result.priorPhase !== "active") ||
    !validReason(result.reasonCode) ||
    typeof result.revocationId !== "string" ||
    !uuidV4.test(result.revocationId) ||
    typeof result.revokedAt !== "string" ||
    !validUtc(result.revokedAt)
  ) {
    throw failure(code, "Server binding revocation snapshot is invalid.");
  }
  return Object.freeze(result) as Readonly<ServerBindingRevocationSnapshotV1>;
}

function snapshotNullableReceipt(
  value: unknown,
  code: StructuralCode,
  basis: Readonly<ServerBindingImmutableBasisV1>,
): Readonly<ServerBindingReceiptSnapshotV1> | null {
  return value === null ? null : snapshotReceipt(value, code, basis);
}

function snapshotNullableRecord(
  value: unknown,
  code: StructuralCode,
): Readonly<ServerBindingRecordSnapshotV1> | null {
  return value === null ? null : snapshotRecord(value, code);
}

interface ReceiptStatementDocument {
  readonly bindingId: string;
  readonly bindingRevision: 1;
  readonly boundAt: string;
  readonly certificateDerSha256: string;
  readonly enrollmentGeneration: 1;
  readonly installationId: string;
  readonly statementType: "durable-binding-created";
  readonly workerNodeId: string;
}

function assertStatementBinding(
  snapshot: Readonly<ServerBindingStatementSnapshotV1>,
  tuple: Readonly<ServerBindingTupleV1>,
  code: StructuralCode,
): void {
  const statement = parseStatementDocument(snapshot.canonicalJson, code);
  if (
    snapshot.boundAt !== statement.boundAt ||
    statement.bindingId !== tuple.bindingId ||
    statement.bindingRevision !== tuple.bindingRevision ||
    statement.certificateDerSha256 !== tuple.certificateDerSha256 ||
    statement.enrollmentGeneration !== tuple.enrollmentGeneration ||
    statement.installationId !== tuple.installationId ||
    statement.workerNodeId !== tuple.workerNodeId
  ) {
    throw failure(code, "Server binding statement does not match its immutable tuple.");
  }
}

function assertReceiptBinding(
  document: string,
  basis: Readonly<ServerBindingImmutableBasisV1>,
  code: StructuralCode,
): void {
  const value = parseJson(document, code, "Server binding receipt");
  const fields = readFields(value, code, "Server binding receipt document");
  exactFields(
    fields,
    ["algorithm", "issuer", "issuerKeyId", "profileId", "schemaVersion", "signature", "statement"],
    code,
    "Server binding receipt document",
  );
  const statement = parseStatementValue(field(fields, "statement"), code);
  const signatureValue = field(fields, "signature");
  const canonical = JSON.stringify({
    algorithm: field(fields, "algorithm"),
    issuer: field(fields, "issuer"),
    issuerKeyId: field(fields, "issuerKeyId"),
    profileId: field(fields, "profileId"),
    schemaVersion: field(fields, "schemaVersion"),
    signature: signatureValue,
    statement,
  });
  if (
    field(fields, "algorithm") !== basis.issuer.algorithm ||
    field(fields, "issuer") !== basis.issuer.issuer ||
    field(fields, "issuerKeyId") !== basis.issuer.issuerKeyId ||
    field(fields, "profileId") !== basis.issuer.profileId ||
    field(fields, "schemaVersion") !== 1 ||
    typeof signatureValue !== "string" ||
    !validSignatureEncoding(signatureValue) ||
    JSON.stringify(statement) !== basis.statement.canonicalJson ||
    canonical !== document
  ) {
    throw failure(
      code,
      "Server binding receipt document is not exact or does not match its basis.",
    );
  }
}

function parseStatementDocument(document: string, code: StructuralCode): ReceiptStatementDocument {
  return parseStatementValue(parseJson(document, code, "Server binding statement"), code, document);
}

function parseStatementValue(
  value: unknown,
  code: StructuralCode,
  expectedDocument?: string,
): ReceiptStatementDocument {
  const fields = readFields(value, code, "Server binding statement document");
  exactFields(
    fields,
    [
      "bindingId",
      "bindingRevision",
      "boundAt",
      "certificateDerSha256",
      "enrollmentGeneration",
      "installationId",
      "statementType",
      "workerNodeId",
    ],
    code,
    "Server binding statement document",
  );
  const statement = {
    bindingId: field(fields, "bindingId"),
    bindingRevision: field(fields, "bindingRevision"),
    boundAt: field(fields, "boundAt"),
    certificateDerSha256: field(fields, "certificateDerSha256"),
    enrollmentGeneration: field(fields, "enrollmentGeneration"),
    installationId: field(fields, "installationId"),
    statementType: field(fields, "statementType"),
    workerNodeId: field(fields, "workerNodeId"),
  };
  if (
    typeof statement.bindingId !== "string" ||
    !uuidV4.test(statement.bindingId) ||
    statement.bindingRevision !== 1 ||
    typeof statement.boundAt !== "string" ||
    !validUtc(statement.boundAt) ||
    typeof statement.certificateDerSha256 !== "string" ||
    !sha256.test(statement.certificateDerSha256) ||
    statement.enrollmentGeneration !== 1 ||
    typeof statement.installationId !== "string" ||
    !validPackageComponent(statement.installationId) ||
    statement.statementType !== "durable-binding-created" ||
    typeof statement.workerNodeId !== "string" ||
    !entityId.test(statement.workerNodeId)
  ) {
    throw failure(code, "Server binding statement document is invalid.");
  }
  const result = statement as ReceiptStatementDocument;
  if (expectedDocument !== undefined && JSON.stringify(result) !== expectedDocument) {
    throw failure(code, "Server binding statement document is not canonical.");
  }
  return result;
}

function parseJson(document: string, code: StructuralCode, description: string): unknown {
  try {
    return JSON.parse(document) as unknown;
  } catch {
    throw failure(code, `${description} is not JSON.`);
  }
}

function assertState(state: Readonly<ServerBindingStateV1>): void {
  if (typeof state !== "object" || state === null || !issuedStates.has(state)) {
    throw failure("STATE_INVALID", "Server binding state was not minted by this module.");
  }
  const fields = readFields(state, "STATE_INVALID", "Server binding state");
  exactFields(
    fields,
    ["basis", "phase", "receipt", "record", "revocation"],
    "STATE_INVALID",
    "Server binding state",
  );
  requireFrozen(state, "Server binding state");
  const phase = field(fields, "phase");
  const basis = field(fields, "basis");
  const receipt = field(fields, "receipt");
  const record = field(fields, "record");
  const revocation = field(fields, "revocation");
  if (!validPhase(phase)) throw failure("STATE_INVALID", "Server binding phase is invalid.");

  if (phase === "absent") {
    if (basis !== null || receipt !== null || record !== null || revocation !== null) {
      throw failure("STATE_INVALID", "Absent state retains binding facts.");
    }
    return;
  }

  const checkedBasis = assertFrozenBasis(basis);
  if (phase === "signing_pending") {
    if (receipt !== null || record !== null || revocation !== null) {
      throw failure("STATE_INVALID", "Signing-pending state facts are inconsistent.");
    }
    return;
  }
  if (phase === "reserved") {
    assertFrozenReceipt(receipt, checkedBasis);
    if (record !== null || revocation !== null) {
      throw failure("STATE_INVALID", "Reserved state facts are inconsistent.");
    }
    return;
  }
  if (phase === "active") {
    assertFrozenReceipt(receipt, checkedBasis);
    assertFrozenRecord(record);
    if (revocation !== null) throw failure("STATE_INVALID", "Active state retains a revocation.");
    return;
  }

  assertFrozenRevocation(revocation);
  const prior = (revocation as Readonly<ServerBindingRevocationSnapshotV1>).priorPhase;
  if (prior === "signing_pending") {
    if (receipt !== null || record !== null) {
      throw failure("STATE_INVALID", "Revoked pending state retained later facts.");
    }
    return;
  }
  assertFrozenReceipt(receipt, checkedBasis);
  if (prior === "reserved") {
    if (record !== null)
      throw failure("STATE_INVALID", "Revoked reserved state retained a record.");
    return;
  }
  assertFrozenRecord(record);
}

function assertFrozenBasis(value: unknown): Readonly<ServerBindingImmutableBasisV1> {
  requireFrozen(value, "Server binding immutable basis");
  const fields = readFields(value, "STATE_INVALID", "Server binding immutable basis");
  exactFields(
    fields,
    ["issuer", "request", "statement", "tuple"],
    "STATE_INVALID",
    "Immutable basis",
  );
  for (const key of ["issuer", "request", "statement", "tuple"] as const) {
    requireFrozen(field(fields, key), `Server binding ${key}`);
  }
  return snapshotBasis(value, "STATE_INVALID");
}

function assertFrozenReceipt(value: unknown, basis: Readonly<ServerBindingImmutableBasisV1>): void {
  requireFrozen(value, "Server binding receipt");
  snapshotReceipt(value, "STATE_INVALID", basis);
}

function assertFrozenRecord(value: unknown): void {
  requireFrozen(value, "Server binding record");
  snapshotRecord(value, "STATE_INVALID");
}

function assertFrozenRevocation(value: unknown): void {
  requireFrozen(value, "Server binding revocation");
  snapshotRevocation(value, "STATE_INVALID");
}

function requireFrozen(value: unknown, description: string): void {
  if (typeof value !== "object" || value === null || !Object.isFrozen(value)) {
    throw failure("STATE_INVALID", `${description} must be immutable.`);
  }
}

function requireSameBasis(
  retained: Readonly<ServerBindingImmutableBasisV1> | null,
  candidate: Readonly<ServerBindingImmutableBasisV1>,
): void {
  if (retained === null || !sameBasis(retained, candidate)) {
    throw failure("IMMUTABLE_CONFLICT", "Server binding immutable basis changed.");
  }
}

function requireSameReceipt(
  retained: Readonly<ServerBindingReceiptSnapshotV1> | null,
  candidate: Readonly<ServerBindingReceiptSnapshotV1> | null,
): void {
  if (!sameNullableReceipt(retained, candidate)) {
    throw failure("RECEIPT_CONFLICT", "Event changed the retained receipt facts.");
  }
}

function requireSameRecord(
  retained: Readonly<ServerBindingRecordSnapshotV1> | null,
  candidate: Readonly<ServerBindingRecordSnapshotV1> | null,
): void {
  if (!sameNullableRecord(retained, candidate)) {
    throw failure("RECORD_CONFLICT", "Event changed the retained record facts.");
  }
}

function sameBasis(
  left: Readonly<ServerBindingImmutableBasisV1>,
  right: Readonly<ServerBindingImmutableBasisV1>,
): boolean {
  return (
    left.tuple.bindingId === right.tuple.bindingId &&
    left.tuple.bindingRevision === right.tuple.bindingRevision &&
    left.tuple.certificateDerSha256 === right.tuple.certificateDerSha256 &&
    left.tuple.enrollmentGeneration === right.tuple.enrollmentGeneration &&
    left.tuple.installationId === right.tuple.installationId &&
    left.tuple.workerNodeId === right.tuple.workerNodeId &&
    left.issuer.algorithm === right.issuer.algorithm &&
    left.issuer.issuer === right.issuer.issuer &&
    left.issuer.issuerKeyId === right.issuer.issuerKeyId &&
    left.issuer.profileId === right.issuer.profileId &&
    left.statement.boundAt === right.statement.boundAt &&
    left.statement.canonicalJson === right.statement.canonicalJson &&
    left.statement.sha256 === right.statement.sha256 &&
    left.request.requestId === right.request.requestId &&
    left.request.requestSha256 === right.request.requestSha256 &&
    left.request.tokenSha256 === right.request.tokenSha256
  );
}

function sameReceipt(
  left: Readonly<ServerBindingReceiptSnapshotV1> | null,
  right: Readonly<ServerBindingReceiptSnapshotV1>,
): boolean {
  return (
    left !== null &&
    left.canonicalJson === right.canonicalJson &&
    left.receiptSha256 === right.receiptSha256
  );
}

function sameNullableReceipt(
  left: Readonly<ServerBindingReceiptSnapshotV1> | null,
  right: Readonly<ServerBindingReceiptSnapshotV1> | null,
): boolean {
  return left === null ? right === null : right !== null && sameReceipt(left, right);
}

function sameRecord(
  left: Readonly<ServerBindingRecordSnapshotV1> | null,
  right: Readonly<ServerBindingRecordSnapshotV1>,
): boolean {
  return left !== null && left.recordDocumentSha256 === right.recordDocumentSha256;
}

function sameNullableRecord(
  left: Readonly<ServerBindingRecordSnapshotV1> | null,
  right: Readonly<ServerBindingRecordSnapshotV1> | null,
): boolean {
  return left === null ? right === null : right !== null && sameRecord(left, right);
}

function sameRevocation(
  left: Readonly<ServerBindingRevocationSnapshotV1> | null,
  right: Readonly<ServerBindingRevocationSnapshotV1>,
): boolean {
  return (
    left !== null &&
    left.priorPhase === right.priorPhase &&
    left.reasonCode === right.reasonCode &&
    left.revocationId === right.revocationId &&
    left.revokedAt === right.revokedAt
  );
}

function freezeState(value: ServerBindingStateV1): Readonly<ServerBindingStateV1> {
  const state = Object.freeze(value);
  issuedStates.add(state);
  return state;
}

function readFields(value: unknown, code: StructuralCode, description: string): Descriptors {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      throw failure(code, `${description} must be a plain string-keyed data object.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) {
      if (
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        Object.hasOwn(descriptor, "get") ||
        Object.hasOwn(descriptor, "set")
      ) {
        throw failure(code, `${description} must contain only enumerable data properties.`);
      }
    }
    return descriptors;
  } catch (error) {
    if (error instanceof ServerBindingStateErrorV1 && error.code === code) throw error;
    throw failure(code, `${description} could not be inspected as plain data.`);
  }
}

function exactFields(
  descriptors: Descriptors,
  expectedFields: readonly string[],
  code: StructuralCode,
  description: string,
): void {
  const actual = Object.keys(descriptors).toSorted();
  const expected = [...expectedFields].toSorted();
  if (actual.length !== expected.length || actual.join("\u0000") !== expected.join("\u0000")) {
    throw failure(code, `${description} fields are not exact.`);
  }
}

function field(descriptors: Descriptors, name: string): unknown {
  return Object.hasOwn(descriptors, name) ? descriptors[name]?.value : undefined;
}

function validPhase(value: unknown): value is ServerBindingPhaseV1 {
  return (
    value === "absent" ||
    value === "signing_pending" ||
    value === "reserved" ||
    value === "active" ||
    value === "revoked"
  );
}

function validReason(value: unknown): value is ServerBindingRevocationReasonV1 {
  return (
    value === "binding_compromised" ||
    value === "enrollment_abandoned" ||
    value === "integrity_failure" ||
    value === "operator_requested"
  );
}

function validJsonSnapshot(value: string): boolean {
  if (value.length < 2 || value.length > 4_096 || value[0] !== "{" || value.at(-1) !== "}") {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    if (character < 0x20 || character > 0x7e) return false;
  }
  return true;
}

function validSignatureEncoding(value: string): boolean {
  if (!signature.test(value)) return false;
  const bytes = decodeBase64Url(value);
  if (bytes === null || bytes.byteLength !== 64) return false;
  const r = unsignedBigEndian(bytes.subarray(0, 32));
  const s = unsignedBigEndian(bytes.subarray(32));
  return r > 0n && r < p256Order && s > 0n && s <= p256HalfOrder;
}

function decodeBase64Url(value: string): Uint8Array | null {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of value) {
    const digit = base64UrlAlphabet.indexOf(character);
    if (digit < 0) return null;
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  return bits === 4 && accumulator === 0 ? Uint8Array.from(bytes) : null;
}

function unsignedBigEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function validUtc(value: string): boolean {
  const match = utcMilliseconds.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

function validPackageComponent(value: string): boolean {
  if (!packageComponent.test(value) || value === "." || value === ".." || value.endsWith(".")) {
    return false;
  }
  const base = value.split(".", 1)[0]?.toUpperCase();
  if (
    base === undefined ||
    base === "CON" ||
    base === "PRN" ||
    base === "AUX" ||
    base === "NUL" ||
    /^(?:COM|LPT)[1-9]$/u.test(base)
  ) {
    return false;
  }
  return true;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function failure(code: ServerBindingStateErrorCodeV1, message: string): ServerBindingStateErrorV1 {
  return new ServerBindingStateErrorV1(code, message);
}
