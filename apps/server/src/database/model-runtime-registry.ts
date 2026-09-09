import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { assertPlatformAdministrator, assertRepositoryPermission } from "./operator-access.js";

interface ActorInput {
  readonly actor: C.OperatorPrincipal;
}
interface RegistrationInput extends ActorInput {
  readonly registrationId: string;
}
interface MutationRestriction {
  readonly replayOnly?: true;
}
export interface ModelRuntimeRegistryOperationMap {
  registerModelRuntime: {
    input: ActorInput & MutationRestriction & { readonly request: C.ModelRuntimeRegisterRequest };
    output: C.ModelRuntimeStatusV1;
  };
  changeModelRuntimeControl: {
    input: RegistrationInput &
      MutationRestriction & { readonly request: C.ModelRuntimeControlRequest };
    output: C.ModelRuntimeStatusV1;
  };
  listModelRuntimeRegistrations: {
    input: ActorInput & { readonly query: C.ModelRuntimeListQuery };
    output: C.ModelRuntimeListV1;
  };
  getModelRuntimeRegistration: { input: RegistrationInput; output: C.ModelRuntimeStatusV1 };
  listModelRuntimeHistory: {
    input: RegistrationInput & { readonly query: C.ModelRuntimeHistoryQuery };
    output: C.ModelRuntimeHistoryV1;
  };
  listEvaluationModelRuntimeOptions: {
    input: ActorInput & {
      readonly repositoryId: string;
      readonly query: C.ModelRuntimeOptionsQuery;
    };
    output: C.ModelRuntimeOptionsV1;
  };
}
export type ModelRuntimeRegistryOperation = keyof ModelRuntimeRegistryOperationMap;
export type ModelRuntimeRegistryRequest = {
  [K in ModelRuntimeRegistryOperation]: {
    readonly operation: K;
    readonly input: ModelRuntimeRegistryOperationMap[K]["input"];
  };
}[ModelRuntimeRegistryOperation];
type Mutation = Extract<
  ModelRuntimeRegistryRequest,
  { operation: "registerModelRuntime" | "changeModelRuntimeControl" }
>;
const strict = { additionalProperties: false } as const;
const actor = { actor: C.OperatorPrincipalSchema };
const registrationScope = { ...actor, registrationId: C.EntityIdSchema };
const schemas = {
  registerModelRuntime: Type.Object(
    {
      ...actor,
      request: C.ModelRuntimeRegisterRequestSchema,
      replayOnly: Type.Optional(Type.Literal(true)),
    },
    strict,
  ),
  changeModelRuntimeControl: Type.Object(
    {
      ...registrationScope,
      request: C.ModelRuntimeControlRequestSchema,
      replayOnly: Type.Optional(Type.Literal(true)),
    },
    strict,
  ),
  listModelRuntimeRegistrations: Type.Object(
    { ...actor, query: C.ModelRuntimeListQuerySchema },
    strict,
  ),
  getModelRuntimeRegistration: Type.Object(registrationScope, strict),
  listModelRuntimeHistory: Type.Object(
    { ...registrationScope, query: C.ModelRuntimeHistoryQuerySchema },
    strict,
  ),
  listEvaluationModelRuntimeOptions: Type.Object(
    { ...actor, repositoryId: C.EntityIdSchema, query: C.ModelRuntimeOptionsQuerySchema },
    strict,
  ),
};
const maximumRegistrationBytes = 65_536;
const maximumStatusBytes = 131_072;
const exactId = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/u;
const operationName = (request: Mutation) =>
  request.operation === "registerModelRuntime" ? ("register" as const) : ("control" as const);
export function isModelRuntimeRegistryOperation(
  operation: string,
): operation is ModelRuntimeRegistryOperation {
  return Object.hasOwn(schemas, operation);
}
export class ModelRuntimeRegistryError extends Error {
  constructor(
    readonly code:
      | "PLATFORM_INVALID"
      | "PLATFORM_NOT_FOUND"
      | "PLATFORM_CONFLICT"
      | "PLATFORM_CORRUPT"
      | "DATABASE_READ_ONLY",
  ) {
    super(
      code === "PLATFORM_NOT_FOUND"
        ? "The model runtime registration was not found."
        : code === "PLATFORM_CONFLICT"
          ? "The model runtime registration changed or this change ID belongs to another intent."
          : code === "DATABASE_READ_ONLY"
            ? "New model runtime changes are unavailable during recovery maintenance."
            : code === "PLATFORM_CORRUPT"
              ? "The stored model runtime registration is inconsistent."
              : "The model runtime registry request is invalid.",
    );
    this.name = "ModelRuntimeRegistryError";
  }
}
function fail(code: ModelRuntimeRegistryError["code"]): never {
  throw new ModelRuntimeRegistryError(code);
}
function instant(value: unknown, stored = false): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail(stored ? "PLATFORM_CORRUPT" : "PLATFORM_INVALID");
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function transaction<T>(database: DatabaseSync, mutation: boolean, work: () => T): T {
  const outer = database.isTransaction;
  if (outer && !mutation) return work();
  const savepoint = `model_runtime_${randomUUID().replaceAll("-", "")}`;
  database.exec(outer ? `SAVEPOINT ${savepoint}` : mutation ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const value = work();
    database.exec(outer ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return value;
  } catch (error) {
    if (outer) {
      database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } else database.exec("ROLLBACK");
    throw error;
  }
}
function parse(serialized: string | null, maximum: number): unknown {
  if (serialized === null || Buffer.byteLength(serialized) > maximum) fail("PLATFORM_CORRUPT");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return fail("PLATFORM_CORRUPT");
  }
  if (canonicalJson(value) !== serialized) fail("PLATFORM_CORRUPT");
  return value;
}
function checked<T>(value: T, issues: (value: unknown) => string[]): T {
  if (issues(value).length > 0) fail("PLATFORM_CORRUPT");
  return value;
}

interface RegistrationRow {
  id: string;
  name: string;
  requested_model: string;
  identity_sha256: string;
  registration_sha256: string;
  registration_json: string | null;
  actor_issuer: string;
  actor_subject: string;
  created_at: string;
}
interface ControlRow {
  registration_id: string;
  version: number;
  enabled: number;
  updated_at: string;
  actor_issuer: string;
  actor_subject: string;
}
interface AuditRow {
  id: string;
  registration_id: string;
  change_id: string;
  operation: "register" | "control";
  previous_version: number;
  version: number;
  enabled: number;
  reason: string | null;
  actor_issuer: string;
  actor_subject: string;
  created_at: string;
}
interface ReceiptRow {
  change_id: string;
  registration_id: string;
  operation: "register" | "control";
  intent_digest: string;
  response_sha256: string;
  response_json: string | null;
  previous_version: number;
  version: number;
  actor_issuer: string;
  actor_subject: string;
  created_at: string;
}
const registrationColumns = `id, name, requested_model, identity_sha256, registration_sha256,
  CASE WHEN length(CAST(registration_json AS BLOB)) <= ${maximumRegistrationBytes} THEN registration_json END AS registration_json,
  actor_issuer, actor_subject, created_at`;
const auditColumns =
  "id, registration_id, change_id, operation, previous_version, version, enabled, reason, actor_issuer, actor_subject, created_at";
function auditEvent(row: AuditRow): C.ModelRuntimeAuditEventV1 {
  if (row.enabled !== 0 && row.enabled !== 1) fail("PLATFORM_CORRUPT");
  instant(row.created_at, true);
  return checked(
    {
      schemaVersion: "ModelRuntimeAuditEventV1",
      id: row.id,
      registrationId: row.registration_id,
      changeId: row.change_id,
      operation: row.operation,
      previousVersion: row.previous_version,
      version: row.version,
      enabled: row.enabled === 1,
      reason: row.reason,
      createdAt: row.created_at,
      createdBy: { issuer: row.actor_issuer, subject: row.actor_subject },
    } as C.ModelRuntimeAuditEventV1,
    C.getModelRuntimeAuditEventIssues,
  );
}
function auditHead(
  database: DatabaseSync,
  registrationId: string,
  version: number,
): C.ModelRuntimeAuditEventV1 {
  const row = database
    .prepare(
      `SELECT ${auditColumns} FROM model_runtime_audit WHERE registration_id = ? AND version = ?`,
    )
    .get(registrationId, version) as AuditRow | undefined;
  if (!row) fail("PLATFORM_CORRUPT");
  return auditEvent(row);
}

/** Internal immutable read. The caller establishes operator or execution authority in this transaction. */
export function readModelRuntimeRegistrationInTransaction(
  database: DatabaseSync,
  registrationId: string,
  options: { readonly requireEnabled?: boolean; readonly now?: string } = {},
): {
  registration: C.ModelRuntimeRegistrationV1;
  registrationSha256: string;
  control: C.ModelRuntimeControlV1;
} | null {
  if (
    !database.isTransaction ||
    !Value.Check(C.EntityIdSchema, registrationId) ||
    !exactId.test(registrationId)
  )
    fail("PLATFORM_INVALID");
  if (options.now !== undefined) instant(options.now);
  const row = database
    .prepare(`SELECT ${registrationColumns} FROM model_runtime_registrations WHERE id = ?`)
    .get(registrationId) as RegistrationRow | undefined;
  if (!row) return null;
  const registration = checked(
    parse(row.registration_json, maximumRegistrationBytes) as C.ModelRuntimeRegistrationV1,
    C.getModelRuntimeRegistrationIssues,
  );
  const registrationSha256 = sha256(canonicalJson(registration));
  if (
    registration.id !== row.id ||
    registration.name !== row.name ||
    registration.requestedModel !== row.requested_model ||
    registration.createdAt !== row.created_at ||
    registration.createdBy.issuer !== row.actor_issuer ||
    registration.createdBy.subject !== row.actor_subject ||
    registration.identitySha256 !== row.identity_sha256 ||
    sha256(canonicalJson(registration.identity)) !== row.identity_sha256 ||
    registrationSha256 !== row.registration_sha256
  )
    fail("PLATFORM_CORRUPT");
  instant(registration.createdAt, true);
  const rawControl = database
    .prepare(
      "SELECT registration_id, version, enabled, updated_at, actor_issuer, actor_subject FROM model_runtime_controls WHERE registration_id = ?",
    )
    .get(registrationId) as ControlRow | undefined;
  if (!rawControl || (rawControl.enabled !== 0 && rawControl.enabled !== 1))
    fail("PLATFORM_CORRUPT");
  const control = checked(
    {
      schemaVersion: "ModelRuntimeControlV1",
      registrationId,
      version: rawControl.version,
      enabled: rawControl.enabled === 1,
      updatedAt: rawControl.updated_at,
      updatedBy: { issuer: rawControl.actor_issuer, subject: rawControl.actor_subject },
    } as C.ModelRuntimeControlV1,
    C.getModelRuntimeControlIssues,
  );
  instant(control.updatedAt, true);
  const latest = database
    .prepare(
      "SELECT version FROM model_runtime_audit WHERE registration_id = ? ORDER BY version DESC LIMIT 1",
    )
    .get(registrationId) as { version: number } | undefined;
  if (latest?.version !== control.version) fail("PLATFORM_CORRUPT");
  const head = auditHead(database, registrationId, control.version);
  if (
    head.enabled !== control.enabled ||
    head.createdAt !== control.updatedAt ||
    !same(head.createdBy, control.updatedBy) ||
    Date.parse(control.updatedAt) < Date.parse(registration.createdAt) ||
    (control.version === 1 &&
      (head.operation !== "register" ||
        !same(head.createdBy, registration.createdBy) ||
        head.createdAt !== registration.createdAt)) ||
    (options.now !== undefined &&
      (Date.parse(registration.createdAt) > Date.parse(options.now) ||
        Date.parse(control.updatedAt) > Date.parse(options.now)))
  )
    fail("PLATFORM_CORRUPT");
  if (options.requireEnabled === true && !control.enabled) return null;
  return { registration, registrationSha256, control };
}
function status(
  value: NonNullable<ReturnType<typeof readModelRuntimeRegistrationInTransaction>>,
): C.ModelRuntimeStatusV1 {
  return checked(
    {
      schemaVersion: "ModelRuntimeStatusV1",
      registration: value.registration,
      control: value.control,
    } as C.ModelRuntimeStatusV1,
    C.getModelRuntimeStatusIssues,
  );
}
function required(database: DatabaseSync, id: string, now: string) {
  const value = readModelRuntimeRegistrationInTransaction(database, id, { now });
  if (!value) fail("PLATFORM_NOT_FOUND");
  return value;
}
function mutationDigest(request: Mutation): string {
  const { replayOnly: _replayOnly, ...input } = request.input;
  return sha256(canonicalJson({ operation: request.operation, input }));
}
function replay(
  database: DatabaseSync,
  request: Mutation,
  intentDigest: string,
  now: string,
): C.ModelRuntimeStatusV1 | null {
  const row = database
    .prepare(`SELECT change_id, registration_id, operation, intent_digest, response_sha256,
    CASE WHEN length(CAST(response_json AS BLOB)) <= ${maximumStatusBytes} THEN response_json END AS response_json,
    previous_version, version, actor_issuer, actor_subject, created_at FROM model_runtime_mutation_receipts WHERE change_id = ?`)
    .get(request.input.request.changeId) as ReceiptRow | undefined;
  if (!row) return null;
  if (
    row.operation !== operationName(request) ||
    row.intent_digest !== intentDigest ||
    row.actor_issuer !== request.input.actor.issuer ||
    row.actor_subject !== request.input.actor.subject ||
    (request.operation === "changeModelRuntimeControl" &&
      row.registration_id !== request.input.registrationId)
  )
    fail("PLATFORM_CONFLICT");
  const value = checked(
    parse(row.response_json, maximumStatusBytes) as C.ModelRuntimeStatusV1,
    C.getModelRuntimeStatusIssues,
  );
  const current = required(database, row.registration_id, now);
  const event = auditHead(database, row.registration_id, row.version);
  if (
    sha256(canonicalJson(value)) !== row.response_sha256 ||
    !same(value.registration, current.registration) ||
    value.control.registrationId !== row.registration_id ||
    value.control.version !== row.version ||
    value.control.enabled !== request.input.request.enabled ||
    value.control.updatedAt !== row.created_at ||
    !same(value.control.updatedBy, request.input.actor) ||
    row.version !== row.previous_version + 1 ||
    event.changeId !== request.input.request.changeId ||
    event.operation !== row.operation ||
    event.previousVersion !== row.previous_version ||
    event.enabled !== value.control.enabled ||
    event.createdAt !== row.created_at ||
    !same(event.createdBy, request.input.actor) ||
    (request.operation === "registerModelRuntime"
      ? row.previous_version !== 0 ||
        event.reason !== null ||
        value.registration.name !== request.input.request.name ||
        value.registration.requestedModel !== request.input.request.requestedModel ||
        !same(value.registration.identity, request.input.request.identity) ||
        value.registration.createdAt !== row.created_at ||
        !same(value.registration.createdBy, request.input.actor)
      : row.previous_version !== request.input.request.expectedVersion ||
        event.reason !== request.input.request.reason)
  )
    fail("PLATFORM_CORRUPT");
  return value;
}
function writeAudit(
  database: DatabaseSync,
  request: Mutation,
  registrationId: string,
  previousVersion: number,
  now: string,
): void {
  database
    .prepare(`INSERT INTO model_runtime_audit
    (id, registration_id, change_id, operation, previous_version, version, enabled, reason, actor_issuer, actor_subject, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(),
      registrationId,
      request.input.request.changeId,
      operationName(request),
      previousVersion,
      previousVersion + 1,
      request.input.request.enabled ? 1 : 0,
      request.operation === "registerModelRuntime" ? null : request.input.request.reason,
      request.input.actor.issuer,
      request.input.actor.subject,
      now,
    );
}
function mutate(
  database: DatabaseSync,
  request: Mutation,
  now: string,
  readOnly: boolean,
): C.ModelRuntimeStatusV1 {
  const intentDigest = mutationDigest(request);
  const previous = replay(database, request, intentDigest, now);
  if (previous) return previous;
  if (readOnly) fail("DATABASE_READ_ONLY");
  let id: string, previousVersion: number;
  if (request.operation === "registerModelRuntime") {
    const input = request.input;
    const registration: C.ModelRuntimeRegistrationV1 = {
      schemaVersion: "ModelRuntimeRegistrationV1",
      id: randomUUID(),
      name: input.request.name,
      requestedModel: input.request.requestedModel,
      identity: input.request.identity,
      identitySha256: sha256(canonicalJson(input.request.identity)),
      createdAt: now,
      createdBy: input.actor,
    };
    checked(registration, C.getModelRuntimeRegistrationIssues);
    const serialized = canonicalJson(registration);
    if (Buffer.byteLength(serialized) > maximumRegistrationBytes) fail("PLATFORM_INVALID");
    id = registration.id;
    previousVersion = 0;
    database
      .prepare(`INSERT INTO model_runtime_registrations
      (id, name, requested_model, identity_sha256, registration_sha256, registration_json, actor_issuer, actor_subject, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        registration.name,
        registration.requestedModel,
        registration.identitySha256,
        sha256(serialized),
        serialized,
        input.actor.issuer,
        input.actor.subject,
        now,
      );
  } else {
    id = request.input.registrationId;
    const current = required(database, id, now);
    previousVersion = current.control.version;
    if (previousVersion !== request.input.request.expectedVersion) fail("PLATFORM_CONFLICT");
    if (previousVersion >= Number.MAX_SAFE_INTEGER) fail("PLATFORM_INVALID");
  }
  writeAudit(database, request, id, previousVersion, now);
  const value = status(required(database, id, now));
  if (
    value.control.version !== previousVersion + 1 ||
    value.control.enabled !== request.input.request.enabled
  )
    fail("PLATFORM_CORRUPT");
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized) > maximumStatusBytes) fail("PLATFORM_INVALID");
  database
    .prepare(`INSERT INTO model_runtime_mutation_receipts
    (change_id, registration_id, operation, intent_digest, response_sha256, response_json, previous_version, version, actor_issuer, actor_subject, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      request.input.request.changeId,
      id,
      operationName(request),
      intentDigest,
      sha256(serialized),
      serialized,
      previousVersion,
      previousVersion + 1,
      request.input.actor.issuer,
      request.input.actor.subject,
      now,
    );
  return value;
}
function pagination(query: C.ModelRuntimeHistoryQuery): {
  page: number;
  pageSize: number;
  offset: number;
} {
  const page = query.page ?? 1,
    pageSize = query.pageSize ?? 20,
    offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) fail("PLATFORM_INVALID");
  return { page, pageSize, offset };
}
function list(
  database: DatabaseSync,
  query: C.ModelRuntimeListQuery,
  now: string,
  enabledOnly: boolean,
): C.ModelRuntimeListV1 {
  const { page, pageSize, offset } = pagination(query);
  const enabled = enabledOnly ? true : query.enabled;
  const filter =
    enabled === undefined ? "" : "WHERE control.registration_id IS NULL OR control.enabled = ?";
  const parameters: SQLInputValue[] = enabled === undefined ? [] : [enabled ? 1 : 0];
  const from = `FROM model_runtime_registrations AS registration LEFT JOIN model_runtime_controls AS control ON control.registration_id = registration.id ${filter}`;
  const count = database.prepare(`SELECT COUNT(*) AS total ${from}`).get(...parameters) as {
    total: number;
  };
  const rows = database
    .prepare(
      `SELECT registration.id ${from} ORDER BY registration.created_at DESC, registration.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...parameters, pageSize, offset) as { id: string }[];
  return checked(
    {
      schemaVersion: "ModelRuntimeListV1",
      page,
      pageSize,
      total: count.total,
      items: rows.map(({ id }) => status(required(database, id, now))),
    } as C.ModelRuntimeListV1,
    C.getModelRuntimeListIssues,
  );
}

/** Current authority, exact replay, CAS, audit and receipt persistence share one synchronous owner transaction. */
export function handleModelRuntimeRegistryRequest(
  database: DatabaseSync,
  request: ModelRuntimeRegistryRequest,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
  options: { readonly readOnly?: boolean } = {},
): ModelRuntimeRegistryOperationMap[ModelRuntimeRegistryOperation]["output"] {
  if (
    !request ||
    !isModelRuntimeRegistryOperation(request.operation) ||
    !Value.Check(schemas[request.operation], request.input)
  )
    fail("PLATFORM_INVALID");
  instant(now);
  if (
    ("registrationId" in request.input && !exactId.test(request.input.registrationId)) ||
    ("repositoryId" in request.input && !exactId.test(request.input.repositoryId))
  )
    fail("PLATFORM_INVALID");
  const mutation =
    request.operation === "registerModelRuntime" ||
    request.operation === "changeModelRuntimeControl";
  const readOnly =
    options.readOnly === true ||
    ("replayOnly" in request.input && request.input.replayOnly === true);
  const issues =
    request.operation === "registerModelRuntime"
      ? C.getModelRuntimeRegisterRequestIssues(request.input.request)
      : request.operation === "changeModelRuntimeControl"
        ? C.getModelRuntimeControlRequestIssues(request.input.request)
        : request.operation === "listModelRuntimeHistory"
          ? C.getModelRuntimeHistoryQueryIssues(request.input.query)
          : request.operation === "listEvaluationModelRuntimeOptions"
            ? C.getModelRuntimeOptionsQueryIssues(request.input.query)
            : "query" in request.input
              ? C.getModelRuntimeListQueryIssues(request.input.query)
              : [];
  if (issues.length > 0) fail("PLATFORM_INVALID");
  return transaction(database, mutation && !readOnly, () => {
    if (request.operation === "listEvaluationModelRuntimeOptions") {
      assertRepositoryPermission(
        database,
        request.input.actor,
        request.input.repositoryId,
        "configure",
        administrators,
      );
      const page = list(database, request.input.query, now, true);
      return checked(
        {
          schemaVersion: "ModelRuntimeOptionsV1",
          repositoryId: request.input.repositoryId,
          page: page.page,
          pageSize: page.pageSize,
          total: page.total,
          items: page.items.map(({ registration }) => registration),
        } as C.ModelRuntimeOptionsV1,
        C.getModelRuntimeOptionsIssues,
      );
    }
    assertPlatformAdministrator(request.input.actor, administrators);
    switch (request.operation) {
      case "registerModelRuntime":
      case "changeModelRuntimeControl":
        return mutate(database, request, now, readOnly);
      case "getModelRuntimeRegistration":
        return status(required(database, request.input.registrationId, now));
      case "listModelRuntimeRegistrations":
        return list(database, request.input.query, now, false);
      case "listModelRuntimeHistory": {
        required(database, request.input.registrationId, now);
        const { page, pageSize, offset } = pagination(request.input.query);
        const { total } = database
          .prepare("SELECT COUNT(*) AS total FROM model_runtime_audit WHERE registration_id = ?")
          .get(request.input.registrationId) as { total: number };
        const rows = database
          .prepare(
            `SELECT ${auditColumns} FROM model_runtime_audit WHERE registration_id = ? ORDER BY version DESC LIMIT ? OFFSET ?`,
          )
          .all(request.input.registrationId, pageSize, offset) as unknown as AuditRow[];
        return checked(
          {
            schemaVersion: "ModelRuntimeHistoryV1",
            registrationId: request.input.registrationId,
            page,
            pageSize,
            total,
            items: rows.map(auditEvent),
          } as C.ModelRuntimeHistoryV1,
          C.getModelRuntimeHistoryIssues,
        );
      }
    }
  });
}
