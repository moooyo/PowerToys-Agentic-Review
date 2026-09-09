import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Sha256Schema } from "./common.js";
import { getModelRuntimeIdentityIssues, ModelRuntimeIdentityV1Schema } from "./model-runtime.js";
import { type OperatorPrincipal, OperatorPrincipalSchema } from "./operator-access.js";

export const maximumModelRuntimeRegistryRequestUtf8Bytes = 32 * 1024;
export const maximumModelRuntimeRegistryReadUtf8Bytes = 2 * 1024 * 1024;
export const maximumModelRuntimeRegistryPageSize = 50;
const strict = { additionalProperties: false } as const;
const id = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\\s\\S])",
});
const name = Type.String({ minLength: 1, maxLength: 128 });
const reason = Type.String({ minLength: 1, maxLength: 2048 });
const requestedModel = ModelRuntimeIdentityV1Schema.properties.modelId;
const datePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))(?![\s\S])/u;
const timestamp = Type.String({ minLength: 20, maxLength: 64, pattern: datePattern.source });
const version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const previousVersion = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 });
const pageSize = Type.Integer({ minimum: 1, maximum: maximumModelRuntimeRegistryPageSize });
const total = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

// A registration records expected configuration. It does not attest any actual model invocation.
export const ModelRuntimeRegistrationV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelRuntimeRegistrationV1"),
    id,
    name,
    requestedModel,
    identity: ModelRuntimeIdentityV1Schema,
    identitySha256: Sha256Schema,
    createdAt: timestamp,
    createdBy: OperatorPrincipalSchema,
  },
  strict,
);
export type ModelRuntimeRegistrationV1 = Static<typeof ModelRuntimeRegistrationV1Schema>;

export const ModelRuntimeControlV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelRuntimeControlV1"),
    registrationId: id,
    version,
    enabled: Type.Boolean(),
    updatedAt: timestamp,
    updatedBy: OperatorPrincipalSchema,
  },
  strict,
);
export type ModelRuntimeControlV1 = Static<typeof ModelRuntimeControlV1Schema>;

export const ModelRuntimeStatusV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelRuntimeStatusV1"),
    registration: ModelRuntimeRegistrationV1Schema,
    control: ModelRuntimeControlV1Schema,
  },
  strict,
);
export type ModelRuntimeStatusV1 = Static<typeof ModelRuntimeStatusV1Schema>;

export const ModelRuntimeRegisterRequestSchema = Type.Object(
  {
    changeId: id,
    name,
    requestedModel,
    identity: ModelRuntimeIdentityV1Schema,
    enabled: Type.Boolean(),
  },
  strict,
);
export type ModelRuntimeRegisterRequest = Static<typeof ModelRuntimeRegisterRequestSchema>;

export const ModelRuntimeControlRequestSchema = Type.Object(
  {
    changeId: id,
    expectedVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER - 1 }),
    enabled: Type.Boolean(),
    reason,
  },
  strict,
);
export type ModelRuntimeControlRequest = Static<typeof ModelRuntimeControlRequestSchema>;

export const ModelRuntimeAuditEventV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelRuntimeAuditEventV1"),
    id,
    registrationId: id,
    changeId: id,
    operation: Type.Union([Type.Literal("register"), Type.Literal("control")]),
    previousVersion,
    version,
    enabled: Type.Boolean(),
    reason: Type.Union([reason, Type.Null()]),
    createdAt: timestamp,
    createdBy: OperatorPrincipalSchema,
  },
  strict,
);
export type ModelRuntimeAuditEventV1 = Static<typeof ModelRuntimeAuditEventV1Schema>;

const pagination = { page: Type.Optional(version), pageSize: Type.Optional(pageSize) };
export const ModelRuntimeListQuerySchema = Type.Object(
  { ...pagination, enabled: Type.Optional(Type.Boolean()) },
  strict,
);
export type ModelRuntimeListQuery = Static<typeof ModelRuntimeListQuerySchema>;
export const ModelRuntimeHistoryQuerySchema = Type.Object(pagination, strict);
export type ModelRuntimeHistoryQuery = Static<typeof ModelRuntimeHistoryQuerySchema>;
export const ModelRuntimeOptionsQuerySchema = Type.Object(pagination, strict);
export type ModelRuntimeOptionsQuery = Static<typeof ModelRuntimeOptionsQuerySchema>;

export const ModelRuntimeListV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelRuntimeListV1"),
    page: version,
    pageSize,
    total,
    items: Type.Array(ModelRuntimeStatusV1Schema, {
      maxItems: maximumModelRuntimeRegistryPageSize,
    }),
  },
  strict,
);
export type ModelRuntimeListV1 = Static<typeof ModelRuntimeListV1Schema>;
export const ModelRuntimeHistoryV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelRuntimeHistoryV1"),
    registrationId: id,
    page: version,
    pageSize,
    total,
    items: Type.Array(ModelRuntimeAuditEventV1Schema, {
      maxItems: maximumModelRuntimeRegistryPageSize,
    }),
  },
  strict,
);
export type ModelRuntimeHistoryV1 = Static<typeof ModelRuntimeHistoryV1Schema>;
export const ModelRuntimeOptionsV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ModelRuntimeOptionsV1"),
    repositoryId: id,
    page: version,
    pageSize,
    total,
    items: Type.Array(ModelRuntimeRegistrationV1Schema, {
      maxItems: maximumModelRuntimeRegistryPageSize,
    }),
  },
  strict,
);
export type ModelRuntimeOptionsV1 = Static<typeof ModelRuntimeOptionsV1Schema>;

function wellFormed(value: unknown, parents = new Set<object>()): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || parents.has(value) || parents.size > 64) return false;
  if (
    (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    return false;
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(
    ([key]) => !Array.isArray(value) || key !== "length",
  );
  if (
    Array.isArray(value) &&
    (entries.length !== value.length || entries.some(([key], index) => key !== String(index)))
  )
    return false;
  parents.add(value);
  const valid = entries.every(
    ([key, descriptor]) =>
      key.isWellFormed() &&
      descriptor.enumerable &&
      "value" in descriptor &&
      wellFormed(descriptor.value, parents),
  );
  parents.delete(value);
  return valid;
}
function shape(
  schema: TSchema,
  value: unknown,
  maximumBytes = maximumModelRuntimeRegistryReadUtf8Bytes,
): string[] {
  try {
    if (!wellFormed(value) || !Value.Check(schema, value))
      return ["Model runtime registry data must match its strict JSON contract."];
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes)
      return ["Model runtime registry data exceeds its aggregate UTF-8 byte limit."];
    return [];
  } catch {
    return ["Model runtime registry data must match its strict JSON contract."];
  }
}
function exactText(value: string): boolean {
  return value.trim() === value && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}
function actorIssues(actor: OperatorPrincipal): string[] {
  return [actor.issuer, actor.subject].every(exactText)
    ? []
    : ["Registry actors must retain exact identities without control characters."];
}
function validDate(value: string): boolean {
  const match = datePattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    Number(match[3]) >= 1 &&
    Number(match[3]) <=
      ([31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(match[2]) - 1] ?? 0) &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59 &&
    Number(match[7] ?? 0) <= 23 &&
    Number(match[8] ?? 0) <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}
function reasonIssues(value: string): string[] {
  return value.trim().length > 0 &&
    [...value].every(
      (character) => ["\t", "\r", "\n"].includes(character) || !/[\p{Cc}\p{Cf}]/u.test(character),
    )
    ? []
    : ["Registry changes require a nonempty reason without unsafe control characters."];
}
function registrationIssues(value: ModelRuntimeRegistrationV1): string[] {
  const issues = [
    ...getModelRuntimeIdentityIssues(value.identity),
    ...actorIssues(value.createdBy),
  ];
  if (![value.name, value.requestedModel].every(exactText))
    issues.push(
      "Registry names and requested models must retain exact text without control characters.",
    );
  if (!validDate(value.createdAt))
    issues.push("Registry creation requires a valid exact timestamp.");
  return issues;
}
function controlIssues(value: ModelRuntimeControlV1): string[] {
  const issues = actorIssues(value.updatedBy);
  if (!validDate(value.updatedAt))
    issues.push("Registry control requires a valid exact timestamp.");
  return issues;
}
function statusIssues(value: ModelRuntimeStatusV1): string[] {
  const issues = [...registrationIssues(value.registration), ...controlIssues(value.control)];
  if (
    value.registration.id !== value.control.registrationId ||
    Date.parse(value.registration.createdAt) > Date.parse(value.control.updatedAt)
  )
    issues.push("Registry status must bind control to its original registration and chronology.");
  if (
    value.control.version === 1 &&
    (value.control.updatedAt !== value.registration.createdAt ||
      value.control.updatedBy.issuer !== value.registration.createdBy.issuer ||
      value.control.updatedBy.subject !== value.registration.createdBy.subject)
  )
    issues.push("Initial registry control must retain the registration actor and timestamp.");
  return issues;
}
function auditIssues(value: ModelRuntimeAuditEventV1): string[] {
  const issues = actorIssues(value.createdBy);
  if (!validDate(value.createdAt))
    issues.push("Registry audit events require a valid exact timestamp.");
  if (
    value.version !== value.previousVersion + 1 ||
    (value.operation === "register" && (value.previousVersion !== 0 || value.reason !== null)) ||
    (value.operation === "control" && (value.previousVersion === 0 || value.reason === null))
  )
    issues.push(
      "Registry audit events must retain their operation, reason, and consecutive versions.",
    );
  if (value.reason !== null) issues.push(...reasonIssues(value.reason));
  return issues;
}
function paginationIssues(value: { page?: number; pageSize?: number }): string[] {
  return Number.isSafeInteger(((value.page ?? 1) - 1) * (value.pageSize ?? 20))
    ? []
    : ["The registry page offset must be a safe integer."];
}
function pageIssues(value: {
  page: number;
  pageSize: number;
  total: number;
  items: readonly unknown[];
}): string[] {
  const issues = paginationIssues(value);
  if (issues.length > 0) return issues;
  const offset = (value.page - 1) * value.pageSize;
  if (value.items.length !== Math.min(value.pageSize, Math.max(0, value.total - offset)))
    issues.push("Registry page contents must agree with its pagination and total.");
  return issues;
}

/** Digests and platform authorization must be independently checked by the persistence owner. */
export function getModelRuntimeRegistrationIssues(value: unknown): string[] {
  const issues = shape(ModelRuntimeRegistrationV1Schema, value);
  return issues.length ? issues : registrationIssues(value as ModelRuntimeRegistrationV1);
}
export function getModelRuntimeControlIssues(value: unknown): string[] {
  const issues = shape(ModelRuntimeControlV1Schema, value);
  return issues.length ? issues : controlIssues(value as ModelRuntimeControlV1);
}
export function getModelRuntimeStatusIssues(value: unknown): string[] {
  const issues = shape(ModelRuntimeStatusV1Schema, value);
  return issues.length ? issues : statusIssues(value as ModelRuntimeStatusV1);
}
export function getModelRuntimeRegisterRequestIssues(value: unknown): string[] {
  const issues = shape(
    ModelRuntimeRegisterRequestSchema,
    value,
    maximumModelRuntimeRegistryRequestUtf8Bytes,
  );
  if (issues.length) return issues;
  const request = value as ModelRuntimeRegisterRequest;
  issues.push(...getModelRuntimeIdentityIssues(request.identity));
  if (![request.name, request.requestedModel].every(exactText))
    issues.push(
      "Registry names and requested models must retain exact text without control characters.",
    );
  return issues;
}
export function getModelRuntimeControlRequestIssues(value: unknown): string[] {
  const issues = shape(
    ModelRuntimeControlRequestSchema,
    value,
    maximumModelRuntimeRegistryRequestUtf8Bytes,
  );
  return issues.length ? issues : reasonIssues((value as ModelRuntimeControlRequest).reason);
}
export function getModelRuntimeAuditEventIssues(value: unknown): string[] {
  const issues = shape(ModelRuntimeAuditEventV1Schema, value);
  return issues.length ? issues : auditIssues(value as ModelRuntimeAuditEventV1);
}
export function getModelRuntimeListQueryIssues(value: unknown): string[] {
  const issues = shape(ModelRuntimeListQuerySchema, value, 8192);
  return issues.length ? issues : paginationIssues(value as ModelRuntimeListQuery);
}
export function getModelRuntimeHistoryQueryIssues(value: unknown): string[] {
  const issues = shape(ModelRuntimeHistoryQuerySchema, value, 8192);
  return issues.length ? issues : paginationIssues(value as ModelRuntimeHistoryQuery);
}
export function getModelRuntimeOptionsQueryIssues(value: unknown): string[] {
  const issues = shape(ModelRuntimeOptionsQuerySchema, value, 8192);
  return issues.length ? issues : paginationIssues(value as ModelRuntimeOptionsQuery);
}
/** Enabled state and repository access are independently checked by the owner at selection time. */
export function getModelRuntimeOptionsIssues(value: unknown): string[] {
  const issues = shape(ModelRuntimeOptionsV1Schema, value);
  if (issues.length) return issues;
  const options = value as ModelRuntimeOptionsV1;
  issues.push(...pageIssues(options));
  if (new Set(options.items.map((item) => item.id)).size !== options.items.length)
    issues.push("Registry options must have unique registration identities.");
  for (const item of options.items) issues.push(...registrationIssues(item));
  return issues;
}
export function getModelRuntimeListIssues(value: unknown): string[] {
  const issues = shape(ModelRuntimeListV1Schema, value);
  if (issues.length) return issues;
  const list = value as ModelRuntimeListV1;
  issues.push(...pageIssues(list));
  if (new Set(list.items.map((item) => item.registration.id)).size !== list.items.length)
    issues.push("Registry list items must have unique registration identities.");
  for (const item of list.items) issues.push(...statusIssues(item));
  return issues;
}
export function getModelRuntimeHistoryIssues(value: unknown): string[] {
  const issues = shape(ModelRuntimeHistoryV1Schema, value);
  if (issues.length) return issues;
  const history = value as ModelRuntimeHistoryV1;
  issues.push(...pageIssues(history));
  const offset = (history.page - 1) * history.pageSize;
  const ids = new Set<string>(),
    changes = new Set<string>();
  for (const [index, event] of history.items.entries()) {
    issues.push(...auditIssues(event));
    if (
      event.registrationId !== history.registrationId ||
      event.version !== history.total - offset - index ||
      ids.has(event.id) ||
      changes.has(event.changeId)
    )
      issues.push("Registry history must retain one scope and complete descending event versions.");
    const previous = history.items[index - 1];
    if (previous && Date.parse(event.createdAt) > Date.parse(previous.createdAt))
      issues.push("Registry history timestamps must agree with descending event versions.");
    ids.add(event.id);
    changes.add(event.changeId);
  }
  return issues;
}
