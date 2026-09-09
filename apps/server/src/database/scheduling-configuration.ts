import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  EntityIdSchema,
  getSchedulingCapacity,
  getSchedulingConfigurationAuditEventIssues,
  getSchedulingConfigurationAuditListIssues,
  getSchedulingConfigurationAuditSummaryIssues,
  getSchedulingConfigurationIssues,
  getSchedulingStatusIssues,
  maximumSchedulingConfigurationAuditPageSize,
  maximumSchedulingConfigurationAuditSnapshotUtf8Bytes,
  type OperatorPrincipal,
  OperatorPrincipalSchema,
  type PlatformSchedulingStatus,
  PlatformSchedulingStatusSchema,
  type RepositorySchedulingStatus,
  RepositorySchedulingStatusSchema,
  type SchedulingConfiguration,
  type SchedulingConfigurationAuditEvent,
  SchedulingConfigurationAuditEventSchema,
  type SchedulingConfigurationAuditListQuery,
  SchedulingConfigurationAuditListQuerySchema,
  type SchedulingConfigurationAuditListResponse,
  SchedulingConfigurationAuditListResponseSchema,
  type SchedulingConfigurationAuditReadQuery,
  SchedulingConfigurationAuditReadQuerySchema,
  type SchedulingConfigurationAuditSummary,
  SchedulingConfigurationAuditSummarySchema,
  SchedulingConfigurationSchema,
  type SchedulingConfigurationUpdateRequest,
  SchedulingConfigurationUpdateRequestSchema,
} from "@agentic-review/contracts";
import { type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  assertPlatformAdministrator,
  assertRepositoryPermission,
  isPlatformAdministrator,
  type OperatorReadContext,
} from "./operator-access.js";
import {
  readPlatformSchedulingConfiguration,
  readSchedulingOverage,
  readSchedulingUsage,
  resolveRepositorySchedulingPolicy,
} from "./scheduling-accounting.js";

export interface SchedulingConfigurationOperationMap {
  getRepositorySchedulingStatus: {
    input: { readonly repositoryId: string };
    output: RepositorySchedulingStatus | null;
  };
  getPlatformSchedulingStatus: {
    input: Record<string, never>;
    output: PlatformSchedulingStatus;
  };
  updatePlatformSchedulingConfiguration: {
    input: {
      readonly request: SchedulingConfigurationUpdateRequest;
      readonly actor: OperatorPrincipal;
    };
    output: SchedulingConfiguration;
  };
  listPlatformSchedulingConfigurationAudit: {
    input: SchedulingConfigurationAuditListQuery;
    output: SchedulingConfigurationAuditListResponse;
  };
  getPlatformSchedulingConfigurationAudit: {
    input: SchedulingConfigurationAuditReadQuery;
    output: SchedulingConfigurationAuditEvent | null;
  };
}
export type SchedulingConfigurationOperation = keyof SchedulingConfigurationOperationMap;
export type SchedulingConfigurationRequest = {
  [K in SchedulingConfigurationOperation]: {
    readonly operation: K;
    readonly input: SchedulingConfigurationOperationMap[K]["input"];
  };
}[SchedulingConfigurationOperation];

const inputSchemas = {
  getRepositorySchedulingStatus: Type.Object(
    { repositoryId: EntityIdSchema },
    { additionalProperties: false },
  ),
  getPlatformSchedulingStatus: Type.Object({}, { additionalProperties: false }),
  updatePlatformSchedulingConfiguration: Type.Object(
    { request: SchedulingConfigurationUpdateRequestSchema, actor: OperatorPrincipalSchema },
    { additionalProperties: false },
  ),
  listPlatformSchedulingConfigurationAudit: SchedulingConfigurationAuditListQuerySchema,
  getPlatformSchedulingConfigurationAudit: SchedulingConfigurationAuditReadQuerySchema,
};
export function isSchedulingConfigurationOperation(
  operation: string,
): operation is SchedulingConfigurationOperation {
  return Object.hasOwn(inputSchemas, operation);
}

export class SchedulingConfigurationError extends Error {
  constructor(
    readonly code: "PLATFORM_INVALID" | "PLATFORM_CONFLICT" | "PLATFORM_CORRUPT",
    message: string,
  ) {
    super(message);
    this.name = "SchedulingConfigurationError";
  }
}
function invalid(message = "The scheduling configuration request is invalid."): never {
  throw new SchedulingConfigurationError("PLATFORM_INVALID", message);
}
function corrupt(): never {
  throw new SchedulingConfigurationError(
    "PLATFORM_CORRUPT",
    "The stored scheduling configuration is invalid.",
  );
}
function check<T>(schema: TSchema, value: T, issues: () => string[] = () => []): T {
  if (!Value.Check(schema, value) || issues().length > 0) corrupt();
  return value;
}
function transaction<T>(database: DatabaseSync, mutation: boolean, action: () => T): T {
  if (database.isTransaction) return action();
  database.exec(mutation ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
function configuration(database: DatabaseSync): SchedulingConfiguration {
  const value = readPlatformSchedulingConfiguration(database);
  return check(SchedulingConfigurationSchema, value, () => getSchedulingConfigurationIssues(value));
}
function actorIsValid(actor: OperatorPrincipal): boolean {
  return (
    Value.Check(OperatorPrincipalSchema, actor) &&
    [actor.issuer, actor.subject].every(
      (part) =>
        part.trim() === part &&
        part.isWellFormed() &&
        ![...part].some(
          (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
        ),
    )
  );
}

interface AuditRow {
  readonly id: string;
  readonly actor_issuer: string;
  readonly actor_subject: string;
  readonly previous_version: number;
  readonly version: number;
  readonly created_at: string;
  readonly previous_snapshot_json: string | null;
  readonly snapshot_json: string | null;
}
const auditColumns = "id, actor_issuer, actor_subject, previous_version, version, created_at";
function auditSummary(row: AuditRow): SchedulingConfigurationAuditSummary {
  const value = {
    id: row.id,
    actor: { issuer: row.actor_issuer, subject: row.actor_subject },
    previousVersion: row.previous_version,
    version: row.version,
    createdAt: row.created_at,
  };
  if (!actorIsValid(value.actor)) corrupt();
  return check(SchedulingConfigurationAuditSummarySchema, value, () =>
    getSchedulingConfigurationAuditSummaryIssues(value),
  );
}
function auditSnapshot(value: string | null): SchedulingConfiguration {
  if (
    value === null ||
    Buffer.byteLength(value, "utf8") > maximumSchedulingConfigurationAuditSnapshotUtf8Bytes
  )
    corrupt();
  let snapshot: SchedulingConfiguration;
  try {
    snapshot = JSON.parse(value) as SchedulingConfiguration;
  } catch {
    return corrupt();
  }
  return check(SchedulingConfigurationSchema, snapshot, () =>
    getSchedulingConfigurationIssues(snapshot),
  );
}
function auditEvent(row: AuditRow): SchedulingConfigurationAuditEvent {
  const value = {
    ...auditSummary(row),
    previousSnapshot: auditSnapshot(row.previous_snapshot_json),
    snapshot: auditSnapshot(row.snapshot_json),
  };
  return check(SchedulingConfigurationAuditEventSchema, value, () =>
    getSchedulingConfigurationAuditEventIssues(value),
  );
}

export function handleSchedulingConfigurationRequest(
  database: DatabaseSync,
  request: SchedulingConfigurationRequest,
  now: string,
  context?: OperatorReadContext,
): unknown {
  if (!Value.Check(inputSchemas[request.operation], request.input)) invalid();
  return transaction(
    database,
    request.operation === "updatePlatformSchedulingConfiguration",
    () => {
      // Authorization and the final policy/accounting projection share this synchronous snapshot.
      if (context !== undefined) {
        if (request.operation === "getRepositorySchedulingStatus") {
          assertRepositoryPermission(
            database,
            context.actor,
            request.input.repositoryId,
            "read",
            context.administrators,
          );
        } else {
          assertPlatformAdministrator(context.actor, context.administrators);
        }
      }
      switch (request.operation) {
        case "getRepositorySchedulingStatus": {
          const row = database
            .prepare("SELECT github_repository_id FROM managed_repositories WHERE id = ?")
            .get(request.input.repositoryId) as { github_repository_id: number } | undefined;
          if (!row) return null;
          const bucketKey = `github:${row.github_repository_id}`;
          const policy = resolveRepositorySchedulingPolicy(database, bucketKey);
          if (policy === null || policy.repositoryId !== request.input.repositoryId) corrupt();
          const usage = readSchedulingUsage(database, { bucketKey });
          const platformConfiguration = configuration(database);
          const platformUsage = readSchedulingUsage(database);
          const full =
            context === undefined || isPlatformAdministrator(context.actor, context.administrators);
          const value: RepositorySchedulingStatus = {
            repositoryId: request.input.repositoryId,
            observedAt: now,
            repositoryVersion: policy.version,
            enabled: policy.enabled,
            limits: policy.limits,
            usage,
            overage: readSchedulingOverage(usage, policy.limits),
            platform: full
              ? {
                  visibility: "full",
                  configuration: platformConfiguration,
                  usage: platformUsage,
                  overage: readSchedulingOverage(platformUsage, platformConfiguration.limits),
                }
              : {
                  visibility: "restricted",
                  version: platformConfiguration.version,
                  ...getSchedulingCapacity(platformConfiguration.limits, platformUsage),
                },
          };
          return check(RepositorySchedulingStatusSchema, value, () =>
            getSchedulingStatusIssues(value),
          );
        }
        case "getPlatformSchedulingStatus": {
          const current = configuration(database);
          const usage = readSchedulingUsage(database);
          const value: PlatformSchedulingStatus = {
            observedAt: now,
            configuration: current,
            usage,
            unscopedUsage: readSchedulingUsage(database, { bucketKey: "unscoped" }),
            overage: readSchedulingOverage(usage, current.limits),
          };
          return check(PlatformSchedulingStatusSchema, value, () =>
            getSchedulingStatusIssues(value),
          );
        }
        case "updatePlatformSchedulingConfiguration": {
          const { actor, request: input } = request.input;
          if (
            !actorIsValid(actor) ||
            (context !== undefined &&
              (actor.issuer !== context.actor.issuer || actor.subject !== context.actor.subject))
          )
            invalid("An authenticated scheduling configuration actor is required.");
          const current = configuration(database);
          if (current.version !== input.expectedVersion)
            throw new SchedulingConfigurationError(
              "PLATFORM_CONFLICT",
              "Scheduling settings changed. Reload before saving.",
            );
          if (current.version === Number.MAX_SAFE_INTEGER)
            invalid("The scheduling configuration version is exhausted.");
          const next: SchedulingConfiguration = {
            ...current,
            version: current.version + 1,
            limits: input.limits,
            updatedAt: now,
          };
          const event: SchedulingConfigurationAuditEvent = {
            id: randomUUID(),
            actor,
            previousVersion: current.version,
            version: next.version,
            createdAt: now,
            previousSnapshot: current,
            snapshot: next,
          };
          check(SchedulingConfigurationAuditEventSchema, event, () =>
            getSchedulingConfigurationAuditEventIssues(event),
          );
          // The audit insert trigger checks CAS and applies the exact new configuration atomically.
          database
            .prepare(`INSERT INTO platform_scheduling_configuration_audit
          (id, actor_issuer, actor_subject, previous_version, version,
           previous_snapshot_json, snapshot_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
              event.id,
              actor.issuer,
              actor.subject,
              current.version,
              next.version,
              JSON.stringify(current),
              JSON.stringify(next),
              now,
            );
          const saved = configuration(database);
          if (
            saved.version !== next.version ||
            saved.policyId !== next.policyId ||
            saved.updatedAt !== next.updatedAt ||
            saved.limits.maxActiveLeases !== next.limits.maxActiveLeases ||
            saved.limits.maxQueuedJobs !== next.limits.maxQueuedJobs
          )
            corrupt();
          return saved;
        }
        case "listPlatformSchedulingConfigurationAudit": {
          const { page = 1, pageSize = maximumSchedulingConfigurationAuditPageSize } =
            request.input;
          const rows = database
            .prepare(`SELECT ${auditColumns} FROM platform_scheduling_configuration_audit
            ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
            .all(pageSize, (page - 1) * pageSize) as unknown as AuditRow[];
          const { total } = database
            .prepare("SELECT COUNT(*) AS total FROM platform_scheduling_configuration_audit")
            .get() as { total: number };
          const value = { items: rows.map(auditSummary), total, page, pageSize };
          return check(SchedulingConfigurationAuditListResponseSchema, value, () =>
            getSchedulingConfigurationAuditListIssues(value),
          );
        }
        case "getPlatformSchedulingConfigurationAudit": {
          const maximum = maximumSchedulingConfigurationAuditSnapshotUtf8Bytes;
          const row = database
            .prepare(`SELECT ${auditColumns},
            CASE WHEN length(CAST(previous_snapshot_json AS BLOB)) <= ${maximum}
              THEN previous_snapshot_json ELSE NULL END AS previous_snapshot_json,
            CASE WHEN length(CAST(snapshot_json AS BLOB)) <= ${maximum}
              THEN snapshot_json ELSE NULL END AS snapshot_json
            FROM platform_scheduling_configuration_audit WHERE id = ?`)
            .get(request.input.eventId) as AuditRow | undefined;
          return row ? auditEvent(row) : null;
        }
      }
    },
  );
}
