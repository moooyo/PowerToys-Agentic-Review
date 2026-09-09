import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  EntityIdSchema,
  type OperatorAccessContext,
  type OperatorPrincipal,
  OperatorPrincipalSchema,
  type OperatorRepositoryPermission,
  OperatorRepositoryPermissionSchema,
  type OperatorRepositoryRole,
  OperatorRepositoryRoleSchema,
  type RepositoryAccessAudit,
  type RepositoryAccessAuditListResponse,
  type RepositoryAccessChangeRequest,
  RepositoryAccessChangeRequestSchema,
  type RepositoryAccessChangeResponse,
  type RepositoryAccessGrant,
  type RepositoryAccessListResponse,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";

export type OperatorReadContext = {
  readonly actor: OperatorPrincipal;
  readonly administrators: readonly OperatorPrincipal[];
};
interface ActorScope {
  readonly actor: OperatorPrincipal;
  readonly repositoryId: string;
}
interface PageScope extends ActorScope {
  readonly page?: number;
  readonly pageSize?: number;
}
export interface OperatorAccessOperationMap {
  getOperatorAccessContext: {
    input: { readonly actor: OperatorPrincipal; readonly repositoryId?: string };
    output: OperatorAccessContext;
  };
  listRepositoryAccessGrants: { input: PageScope; output: RepositoryAccessListResponse };
  listRepositoryAccessAudit: { input: PageScope; output: RepositoryAccessAuditListResponse };
  changeRepositoryAccess: {
    input: ActorScope & { readonly request: RepositoryAccessChangeRequest };
    output: RepositoryAccessChangeResponse;
  };
}
export type OperatorAccessOperation = keyof OperatorAccessOperationMap;
export type OperatorAccessRequest = {
  [K in OperatorAccessOperation]: {
    readonly operation: K;
    readonly input: OperatorAccessOperationMap[K]["input"];
  };
}[OperatorAccessOperation];

export class OperatorAccessError extends Error {
  constructor(
    readonly code:
      | "PLATFORM_INVALID"
      | "PLATFORM_NOT_FOUND"
      | "PLATFORM_FORBIDDEN"
      | "PLATFORM_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "OperatorAccessError";
  }
}
function invalid(message: string): never {
  throw new OperatorAccessError("PLATFORM_INVALID", message);
}
function notFound(): never {
  throw new OperatorAccessError("PLATFORM_NOT_FOUND", "The repository was not found.");
}
function forbidden(): never {
  throw new OperatorAccessError(
    "PLATFORM_FORBIDDEN",
    "The operator does not have permission for this action.",
  );
}
function conflict(message: string): never {
  throw new OperatorAccessError("PLATFORM_CONFLICT", message);
}

const rolePermissions: Readonly<
  Record<OperatorRepositoryRole, readonly OperatorRepositoryPermission[]>
> = {
  viewer: ["read"],
  reviewer: ["read", "review"],
  maintainer: ["read", "review", "configure"],
  admin: ["read", "review", "configure", "manage_access"],
};
function validatePrincipal(principal: OperatorPrincipal): void {
  if (!Value.Check(OperatorPrincipalSchema, principal))
    invalid("The operator identity is invalid.");
  for (const value of [principal.issuer, principal.subject])
    if (
      !value.isWellFormed() ||
      value.trim() !== value ||
      [...value].some(
        (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
      )
    )
      invalid("The operator identity is invalid.");
}
export function isPlatformAdministrator(
  actor: OperatorPrincipal,
  administrators: readonly OperatorPrincipal[],
): boolean {
  validatePrincipal(actor);
  if (!Array.isArray(administrators) || administrators.length > 1024)
    invalid("The trusted administrator configuration is invalid.");
  let matched = false;
  for (const administrator of administrators) {
    validatePrincipal(administrator);
    matched ||= actor.issuer === administrator.issuer && actor.subject === administrator.subject;
  }
  return matched;
}
export function assertPlatformAdministrator(
  actor: OperatorPrincipal,
  administrators: readonly OperatorPrincipal[],
): void {
  if (!isPlatformAdministrator(actor, administrators)) forbidden();
}

type RepositoryContext = NonNullable<OperatorAccessContext["repository"]>;
export function assertRepositoryPermission(
  database: DatabaseSync,
  actor: OperatorPrincipal,
  repositoryId: string,
  permission: OperatorRepositoryPermission,
  administrators: readonly OperatorPrincipal[],
): RepositoryContext {
  const platformAdministrator = isPlatformAdministrator(actor, administrators);
  if (
    !Value.Check(EntityIdSchema, repositoryId) ||
    !Value.Check(OperatorRepositoryPermissionSchema, permission)
  )
    invalid("The repository permission scope is invalid.");
  if (!database.prepare("SELECT 1 FROM managed_repositories WHERE id = ?").get(repositoryId))
    notFound();
  if (platformAdministrator)
    return {
      repositoryId,
      role: "admin",
      source: "platform",
      permissions: [...rolePermissions.admin],
    };
  const row = database
    .prepare(
      "SELECT role FROM repository_operator_grants WHERE repository_id = ? AND principal_issuer = ? AND principal_subject = ?",
    )
    .get(repositoryId, actor.issuer, actor.subject) as
    | { role: OperatorRepositoryRole | null }
    | undefined;
  if (!row || row.role === null) notFound();
  if (!Value.Check(OperatorRepositoryRoleSchema, row.role))
    invalid("The stored repository role is invalid.");
  if (!rolePermissions[row.role].includes(permission)) forbidden();
  return {
    repositoryId,
    role: row.role,
    source: "repository",
    permissions: [...rolePermissions[row.role]],
  };
}

export function repositoryReadSql(
  repositoryIdExpression: string,
  actor: OperatorPrincipal,
  administrators: readonly OperatorPrincipal[],
): { readonly sql: string; readonly parameters: SQLInputValue[] } {
  if (
    typeof repositoryIdExpression !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/u.test(repositoryIdExpression)
  )
    invalid("The repository SQL scope requires a trusted identifier.");
  if (isPlatformAdministrator(actor, administrators)) return { sql: "1 = 1", parameters: [] };
  return {
    sql: `${repositoryIdExpression} IN (SELECT repository_id FROM repository_operator_grants
      WHERE principal_issuer = ? AND principal_subject = ?
      AND role IN ('viewer', 'reviewer', 'maintainer', 'admin'))`,
    parameters: [actor.issuer, actor.subject],
  };
}

const scopeProperties = { actor: OperatorPrincipalSchema, repositoryId: EntityIdSchema };
const pageProperties = {
  ...scopeProperties,
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
};
const inputSchemas = {
  getOperatorAccessContext: Type.Object(
    { ...scopeProperties, repositoryId: Type.Optional(EntityIdSchema) },
    { additionalProperties: false },
  ),
  listRepositoryAccessGrants: Type.Object(pageProperties, { additionalProperties: false }),
  listRepositoryAccessAudit: Type.Object(pageProperties, { additionalProperties: false }),
  changeRepositoryAccess: Type.Object(
    { ...scopeProperties, request: RepositoryAccessChangeRequestSchema },
    { additionalProperties: false },
  ),
};
export function isOperatorAccessOperation(operation: string): operation is OperatorAccessOperation {
  return Object.hasOwn(inputSchemas, operation);
}

interface GrantRow {
  repository_id: string;
  principal_issuer: string;
  principal_subject: string;
  role: OperatorRepositoryRole | null;
  version: number;
  created_at: string;
  updated_at: string;
  updated_by_issuer: string;
  updated_by_subject: string;
}
interface AuditRow {
  id: string;
  repository_id: string;
  change_id: string;
  principal_issuer: string;
  principal_subject: string;
  actor_issuer: string;
  actor_subject: string;
  previous_role: OperatorRepositoryRole | null;
  role: OperatorRepositoryRole | null;
  previous_version: number;
  version: number;
  reason: string;
  intent_digest: string;
  created_at: string;
}
function mapGrant(row: GrantRow): RepositoryAccessGrant {
  return {
    repositoryId: row.repository_id,
    principal: { issuer: row.principal_issuer, subject: row.principal_subject },
    role: row.role,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: { issuer: row.updated_by_issuer, subject: row.updated_by_subject },
  };
}
function mapAudit(row: AuditRow): RepositoryAccessAudit {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    changeId: row.change_id,
    principal: { issuer: row.principal_issuer, subject: row.principal_subject },
    actor: { issuer: row.actor_issuer, subject: row.actor_subject },
    previousRole: row.previous_role,
    role: row.role,
    previousVersion: row.previous_version,
    version: row.version,
    reason: row.reason,
    createdAt: row.created_at,
  };
}
function page(input: PageScope): { page: number; pageSize: number; offset: number } {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) invalid("The access page offset is too large.");
  return { page, pageSize, offset };
}

function transaction<T>(database: DatabaseSync, action: () => T, write: boolean): T {
  const nested = database.isTransaction;
  const savepoint = `operator_access_${randomUUID().replaceAll("-", "")}`;
  database.exec(nested ? `SAVEPOINT ${savepoint}` : write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const value = action();
    database.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return value;
  } catch (error) {
    if (nested) {
      database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } else database.exec("ROLLBACK");
    throw error;
  }
}

function changeAccess(
  database: DatabaseSync,
  input: OperatorAccessOperationMap["changeRepositoryAccess"]["input"],
  now: string,
  administrators: readonly OperatorPrincipal[],
): RepositoryAccessChangeResponse {
  const { actor, repositoryId, request } = input;
  assertRepositoryPermission(database, actor, repositoryId, "manage_access", administrators);
  validatePrincipal(request.principal);
  if (!request.reason.isWellFormed() || !request.reason.trim() || request.reason.includes("\0"))
    invalid("An access change reason is required.");
  const intentDigest = sha256(canonicalJson({ actor, repositoryId, request }));
  const prior = database
    .prepare(
      "SELECT * FROM repository_operator_access_audit WHERE repository_id = ? AND change_id = ?",
    )
    .get(repositoryId, request.changeId) as AuditRow | undefined;
  if (prior) {
    if (prior.intent_digest !== intentDigest)
      conflict("This access change identifier belongs to another request or actor.");
    return { change: mapAudit(prior), replayed: true };
  }
  const current = database
    .prepare(
      "SELECT * FROM repository_operator_grants WHERE repository_id = ? AND principal_issuer = ? AND principal_subject = ?",
    )
    .get(repositoryId, request.principal.issuer, request.principal.subject) as GrantRow | undefined;
  if ((current?.version ?? 0) !== request.expectedVersion)
    conflict("Repository access changed. Reload before saving.");
  if (request.expectedVersion === Number.MAX_SAFE_INTEGER)
    conflict("The repository access version is exhausted.");
  if (current && current.updated_at > now)
    conflict("The access change timestamp precedes the current grant.");
  if (
    current?.role === "admin" &&
    request.role !== "admin" &&
    !isPlatformAdministrator(actor, administrators)
  ) {
    const remaining = database
      .prepare(
        "SELECT 1 FROM repository_operator_grants WHERE repository_id = ? AND role = 'admin' AND NOT (principal_issuer = ? AND principal_subject = ?) LIMIT 1",
      )
      .get(repositoryId, request.principal.issuer, request.principal.subject);
    if (!remaining)
      conflict("A repository administrator cannot remove the last repository administrator.");
  }
  const row: AuditRow = {
    id: randomUUID(),
    repository_id: repositoryId,
    change_id: request.changeId,
    principal_issuer: request.principal.issuer,
    principal_subject: request.principal.subject,
    actor_issuer: actor.issuer,
    actor_subject: actor.subject,
    previous_role: current?.role ?? null,
    role: request.role,
    previous_version: request.expectedVersion,
    version: request.expectedVersion + 1,
    reason: request.reason,
    intent_digest: intentDigest,
    created_at: now,
  };
  database
    .prepare(`INSERT INTO repository_operator_access_audit (
    id, repository_id, change_id, principal_issuer, principal_subject, actor_issuer, actor_subject,
    previous_role, role, previous_version, version, reason, intent_digest, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      row.id,
      row.repository_id,
      row.change_id,
      row.principal_issuer,
      row.principal_subject,
      row.actor_issuer,
      row.actor_subject,
      row.previous_role,
      row.role,
      row.previous_version,
      row.version,
      row.reason,
      row.intent_digest,
      row.created_at,
    );
  return { change: mapAudit(row), replayed: false };
}

export function handleOperatorAccessRequest(
  database: DatabaseSync,
  request: OperatorAccessRequest,
  now: string,
  administrators: readonly OperatorPrincipal[],
): OperatorAccessOperationMap[OperatorAccessOperation]["output"] {
  if (
    !request ||
    !isOperatorAccessOperation(request.operation) ||
    !Value.Check(inputSchemas[request.operation], request.input)
  )
    invalid("The operator access request is invalid.");
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now)
    invalid("A canonical access timestamp is required.");
  return transaction(
    database,
    () => {
      const input = request.input;
      const platformAdministrator = isPlatformAdministrator(input.actor, administrators);
      switch (request.operation) {
        case "getOperatorAccessContext":
          return {
            principal: { ...input.actor },
            platformAdministrator,
            repository:
              input.repositoryId === undefined
                ? null
                : assertRepositoryPermission(
                    database,
                    input.actor,
                    input.repositoryId,
                    "read",
                    administrators,
                  ),
          };
        case "changeRepositoryAccess":
          return changeAccess(database, request.input, now, administrators);
        case "listRepositoryAccessGrants": {
          const input = request.input;
          assertRepositoryPermission(
            database,
            input.actor,
            input.repositoryId,
            "manage_access",
            administrators,
          );
          const pagination = page(input);
          const total = (
            database
              .prepare(
                "SELECT COUNT(*) AS total FROM repository_operator_grants WHERE repository_id = ?",
              )
              .get(input.repositoryId) as { total: number }
          ).total;
          const rows = database
            .prepare(
              "SELECT * FROM repository_operator_grants WHERE repository_id = ? ORDER BY principal_issuer, principal_subject LIMIT ? OFFSET ?",
            )
            .all(
              input.repositoryId,
              pagination.pageSize,
              pagination.offset,
            ) as unknown as GrantRow[];
          return {
            repositoryId: input.repositoryId,
            page: pagination.page,
            pageSize: pagination.pageSize,
            total,
            items: rows.map(mapGrant),
          };
        }
        case "listRepositoryAccessAudit": {
          const input = request.input;
          assertRepositoryPermission(
            database,
            input.actor,
            input.repositoryId,
            "manage_access",
            administrators,
          );
          const pagination = page(input);
          const total = (
            database
              .prepare(
                "SELECT COUNT(*) AS total FROM repository_operator_access_audit WHERE repository_id = ?",
              )
              .get(input.repositoryId) as { total: number }
          ).total;
          const rows = database
            .prepare(
              "SELECT * FROM repository_operator_access_audit WHERE repository_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
            )
            .all(
              input.repositoryId,
              pagination.pageSize,
              pagination.offset,
            ) as unknown as AuditRow[];
          return {
            repositoryId: input.repositoryId,
            page: pagination.page,
            pageSize: pagination.pageSize,
            total,
            items: rows.map(mapAudit),
          };
        }
      }
    },
    request.operation === "changeRepositoryAccess",
  );
}
