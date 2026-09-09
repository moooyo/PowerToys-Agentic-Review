import {
  type OperatorAccessContext,
  OperatorAccessContextSchema,
  type OperatorPrincipal,
  type OperatorRepositoryPermission,
  type OperatorRepositoryRole,
  PositiveIntegerSchema,
  type RepositoryAccessAudit,
  RepositoryAccessAuditListResponseSchema,
  type RepositoryAccessChangeRequest,
  RepositoryAccessChangeRequestSchema,
  RepositoryAccessChangeResponseSchema,
  type RepositoryAccessGrant,
  RepositoryAccessListResponseSchema,
} from "@agentic-review/contracts";
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ReviewControlProtocolError, ReviewControlRequestError } from "../review-control/errors";
import type { AccessPageQuery } from "./adapter";

FormatRegistry.Set(
  "date-time",
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value)),
);

export const rolePermissions: Readonly<
  Record<OperatorRepositoryRole, readonly OperatorRepositoryPermission[]>
> = {
  viewer: ["read"],
  reviewer: ["read", "review"],
  maintainer: ["read", "review", "configure"],
  admin: ["read", "review", "configure", "manage_access"],
};

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const PageQuerySchema = Type.Object(
  {
    page: Type.Optional(PositiveIntegerSchema),
    pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);

function validTimestamp(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)(?![\s\S])/u.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  const calendarDate = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return (
    Number.isFinite(calendarDate.valueOf()) &&
    calendarDate.toISOString().slice(0, 10) === value.slice(0, 10)
  );
}

export function principalKey(principal: OperatorPrincipal): string {
  return JSON.stringify([principal.issuer, principal.subject]);
}

export function samePrincipal(left: OperatorPrincipal, right: OperatorPrincipal): boolean {
  return left.issuer === right.issuer && left.subject === right.subject;
}

function validWireValue(value: unknown, key = ""): boolean {
  if (value === undefined) return false;
  if (typeof value === "string") {
    if (decoder.decode(encoder.encode(value)) !== value) return false;
    if ((key === "id" || key.endsWith("Id")) && !idPattern.test(value)) return false;
    if ((key === "createdAt" || key === "updatedAt") && !validTimestamp(value)) return false;
    if (
      (key === "issuer" || key === "subject") &&
      (value.length === 0 ||
        value.trim() !== value ||
        [...value].some((character) => {
          const code = character.charCodeAt(0);
          return code < 0x20 || code === 0x7f;
        }))
    )
      return false;
    if (key === "reason" && (!value.trim() || value.includes("\0"))) return false;
  }
  if (Array.isArray(value)) return value.every((item) => validWireValue(item));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).every(([entryKey, entry]) => validWireValue(entry, entryKey));
  return typeof value !== "number" || Number.isSafeInteger(value);
}

export function validateAccessRequest<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
): Static<T> {
  if (!Value.Check(schema, value) || !validWireValue(value))
    throw new ReviewControlRequestError(
      operation,
      "request",
      `The ${operation} request is invalid.`,
    );
  return value;
}

export function validateAccessId(value: string, operation: string): void {
  if (typeof value !== "string" || !idPattern.test(value))
    throw new ReviewControlRequestError(
      operation,
      "repositoryId",
      "A valid repository ID is required.",
    );
}

export function normalizeAccessPage(
  query: AccessPageQuery = {},
  operation: string,
): Required<AccessPageQuery> {
  validateAccessRequest(PageQuerySchema, query, operation);
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  if (!Number.isSafeInteger((page - 1) * pageSize))
    throw new ReviewControlRequestError(operation, "page", "The requested page is too large.");
  return { page, pageSize };
}

export function accessPageQuery(query: Required<AccessPageQuery>): string {
  return new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  }).toString();
}

function invalid(operation: string): never {
  throw new ReviewControlProtocolError(
    operation,
    `The ${operation} response is invalid or inconsistent.`,
  );
}

export function validateAccessResponse<T extends TSchema>(
  schema: T,
  value: unknown,
  operation: string,
): Static<T> {
  if (!Value.Check(schema, value) || !validWireValue(value)) invalid(operation);
  return value;
}

export function readAccessContext(
  value: unknown,
  operation: string,
  repositoryId?: string,
): OperatorAccessContext {
  const result = validateAccessResponse(OperatorAccessContextSchema, value, operation);
  const repository = result.repository;
  if (repositoryId === undefined) {
    if (repository !== null) invalid(operation);
    return result;
  }
  if (
    repository === null ||
    repository.repositoryId !== repositoryId ||
    (result.platformAdministrator
      ? repository.source !== "platform" || repository.role !== "admin"
      : repository.source !== "repository") ||
    repository.permissions.length !== rolePermissions[repository.role].length ||
    !rolePermissions[repository.role].every((permission) =>
      repository.permissions.includes(permission),
    )
  )
    invalid(operation);
  return result;
}

export function grantIsConsistent(grant: RepositoryAccessGrant): boolean {
  return Date.parse(grant.createdAt) <= Date.parse(grant.updatedAt);
}

function auditIsConsistent(audit: RepositoryAccessAudit): boolean {
  return (
    audit.previousVersion < Number.MAX_SAFE_INTEGER &&
    audit.version === audit.previousVersion + 1 &&
    (audit.previousVersion !== 0 || audit.previousRole === null)
  );
}

function validatePage<T extends { repositoryId: string }>(
  result: { repositoryId: string; page: number; pageSize: number; total: number; items: T[] },
  repositoryId: string,
  query: Required<AccessPageQuery>,
  operation: string,
): void {
  const offset = (query.page - 1) * query.pageSize;
  const expectedCount = Math.min(query.pageSize, Math.max(0, result.total - offset));
  if (
    result.repositoryId !== repositoryId ||
    result.page !== query.page ||
    result.pageSize !== query.pageSize ||
    result.items.length !== expectedCount ||
    result.items.some((item) => item.repositoryId !== repositoryId)
  )
    invalid(operation);
}

export function readAccessList(
  value: unknown,
  repositoryId: string,
  query: Required<AccessPageQuery>,
  operation: string,
) {
  const result = validateAccessResponse(RepositoryAccessListResponseSchema, value, operation);
  validatePage(result, repositoryId, query, operation);
  if (
    new Set(result.items.map((item) => principalKey(item.principal))).size !==
      result.items.length ||
    !result.items.every(grantIsConsistent)
  )
    invalid(operation);
  return result;
}

export function readAccessHistory(
  value: unknown,
  repositoryId: string,
  query: Required<AccessPageQuery>,
  operation: string,
) {
  const result = validateAccessResponse(RepositoryAccessAuditListResponseSchema, value, operation);
  validatePage(result, repositoryId, query, operation);
  if (
    new Set(result.items.map((item) => item.id)).size !== result.items.length ||
    new Set(result.items.map((item) => item.changeId)).size !== result.items.length ||
    !result.items.every(auditIsConsistent)
  )
    invalid(operation);
  const histories = new Map<string, RepositoryAccessAudit[]>();
  for (const item of result.items) {
    const key = principalKey(item.principal);
    const history = histories.get(key) ?? [];
    history.push(item);
    histories.set(key, history);
  }
  for (const history of histories.values()) {
    history.sort((left, right) => left.version - right.version);
    for (let index = 1; index < history.length; index += 1) {
      const prior = history[index - 1];
      const current = history[index];
      if (
        prior !== undefined &&
        current !== undefined &&
        (prior.version === current.version ||
          Date.parse(prior.createdAt) > Date.parse(current.createdAt) ||
          (current.previousVersion === prior.version && current.previousRole !== prior.role))
      )
        invalid(operation);
    }
  }
  return result;
}

export function validateAccessChange(
  input: RepositoryAccessChangeRequest,
  operation: string,
): RepositoryAccessChangeRequest {
  return validateAccessRequest(RepositoryAccessChangeRequestSchema, input, operation);
}

export function readAccessChange(
  value: unknown,
  repositoryId: string,
  input: RepositoryAccessChangeRequest,
  operation: string,
) {
  const result = validateAccessResponse(RepositoryAccessChangeResponseSchema, value, operation);
  const change = result.change;
  if (
    !auditIsConsistent(change) ||
    change.repositoryId !== repositoryId ||
    change.changeId !== input.changeId ||
    !samePrincipal(change.principal, input.principal) ||
    change.role !== input.role ||
    change.previousVersion !== input.expectedVersion ||
    change.reason !== input.reason
  )
    invalid(operation);
  return result;
}
