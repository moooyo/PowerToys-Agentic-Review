import { type Static, Type } from "@sinclair/typebox";
import {
  DateTimeSchema,
  EntityIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "./common.js";
import { OperatorPrincipalSchema } from "./operator-access.js";
import { type SchedulingLimits, SchedulingLimitsSchema } from "./platform-configuration.js";

export const schedulingPolicyId = "repository-service-v1";
export const maximumSchedulingStatusResponseUtf8Bytes = 64 * 1024;
export const maximumSchedulingConfigurationAuditPageSize = 20;
export const maximumSchedulingConfigurationAuditSnapshotUtf8Bytes = 4 * 1024;
export const maximumSchedulingConfigurationAuditResponseUtf8Bytes = 512 * 1024;

// Configuration is mutable operational policy. It is never part of a frozen ReviewRun snapshot.
export const SchedulingConfigurationSchema = Type.Object(
  {
    version: PositiveIntegerSchema,
    limits: SchedulingLimitsSchema,
    policyId: Type.Literal(schedulingPolicyId),
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type SchedulingConfiguration = Static<typeof SchedulingConfigurationSchema>;

// Actor attribution, update time, and policy identity are owned by the server.
export const SchedulingConfigurationUpdateRequestSchema = Type.Object(
  { expectedVersion: PositiveIntegerSchema, limits: SchedulingLimitsSchema },
  { additionalProperties: false },
);
export type SchedulingConfigurationUpdateRequest = Static<
  typeof SchedulingConfigurationUpdateRequestSchema
>;

export const SchedulingUsageSchema = Type.Object(
  {
    // Count leased/running attempts, including cancellation requests and unreaped expiry.
    activeLeases: NonNegativeIntegerSchema,
    // Only admitted Jobs whose lifecycle is queued or retry_waiting consume queue capacity.
    admittedQueuedJobs: NonNegativeIntegerSchema,
    awaitingAdmissionJobs: NonNegativeIntegerSchema,
    // Pending validation requests for which no real Job can yet be constructed.
    awaitingConfigurationRequests: NonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type SchedulingUsage = Static<typeof SchedulingUsageSchema>;

export const SchedulingOverageSchema = Type.Object(
  {
    activeLeases: NonNegativeIntegerSchema,
    admittedQueuedJobs: NonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type SchedulingOverage = Static<typeof SchedulingOverageSchema>;

// This reports quota headroom only. It does not establish Worker availability, reserve a slot,
// or promise that this subject will be the next admitted or claimed Job.
export const SchedulingCapacitySchema = Type.Union([
  Type.Literal("available"),
  Type.Literal("limited"),
]);
export type SchedulingCapacity = Static<typeof SchedulingCapacitySchema>;

export const SchedulingPlatformVisibilitySchema = Type.Union([
  Type.Object(
    {
      visibility: Type.Literal("restricted"),
      version: PositiveIntegerSchema,
      activeCapacity: SchedulingCapacitySchema,
      queueCapacity: SchedulingCapacitySchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      visibility: Type.Literal("full"),
      configuration: SchedulingConfigurationSchema,
      usage: SchedulingUsageSchema,
      overage: SchedulingOverageSchema,
    },
    { additionalProperties: false },
  ),
]);
export type SchedulingPlatformVisibility = Static<typeof SchedulingPlatformVisibilitySchema>;
export const SchedulingPlatformCapacitySchema = SchedulingPlatformVisibilitySchema;
export type SchedulingPlatformCapacity = Static<typeof SchedulingPlatformCapacitySchema>;

// Shared by admission, claims, and diagnostics after exact accounting in their own snapshot.
export function getSchedulingCapacity(
  limits: SchedulingLimits,
  usage: SchedulingUsage,
): { activeCapacity: SchedulingCapacity; queueCapacity: SchedulingCapacity } {
  return {
    activeCapacity:
      limits.maxActiveLeases !== null && usage.activeLeases >= limits.maxActiveLeases
        ? "limited"
        : "available",
    queueCapacity:
      limits.maxQueuedJobs !== null && usage.admittedQueuedJobs >= limits.maxQueuedJobs
        ? "limited"
        : "available",
  };
}

export const RepositorySchedulingStatusSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    observedAt: DateTimeSchema,
    repositoryVersion: PositiveIntegerSchema,
    enabled: Type.Boolean(),
    limits: SchedulingLimitsSchema,
    usage: SchedulingUsageSchema,
    overage: SchedulingOverageSchema,
    platform: SchedulingPlatformVisibilitySchema,
  },
  { additionalProperties: false },
);
export type RepositorySchedulingStatus = Static<typeof RepositorySchedulingStatusSchema>;

export const PlatformSchedulingStatusSchema = Type.Object(
  {
    observedAt: DateTimeSchema,
    configuration: SchedulingConfigurationSchema,
    usage: SchedulingUsageSchema,
    unscopedUsage: SchedulingUsageSchema,
    overage: SchedulingOverageSchema,
  },
  { additionalProperties: false },
);
export type PlatformSchedulingStatus = Static<typeof PlatformSchedulingStatusSchema>;

const auditProperties = {
  id: EntityIdSchema,
  actor: OperatorPrincipalSchema,
  previousVersion: PositiveIntegerSchema,
  version: PositiveIntegerSchema,
  createdAt: DateTimeSchema,
};

// These list/detail DTOs require platform administrator access; repository scope grants no access.
export const SchedulingConfigurationAuditSummarySchema = Type.Object(auditProperties, {
  additionalProperties: false,
});
export type SchedulingConfigurationAuditSummary = Static<
  typeof SchedulingConfigurationAuditSummarySchema
>;

export const SchedulingConfigurationAuditEventSchema = Type.Object(
  {
    ...auditProperties,
    previousSnapshot: SchedulingConfigurationSchema,
    snapshot: SchedulingConfigurationSchema,
  },
  { additionalProperties: false },
);
export type SchedulingConfigurationAuditEvent = Static<
  typeof SchedulingConfigurationAuditEventSchema
>;

const pageSchema = Type.Integer({ minimum: 1, maximum: 10_000_000 });
const pageSizeSchema = Type.Integer({
  minimum: 1,
  maximum: maximumSchedulingConfigurationAuditPageSize,
});
export const SchedulingConfigurationAuditListQuerySchema = Type.Object(
  { page: Type.Optional(pageSchema), pageSize: Type.Optional(pageSizeSchema) },
  { additionalProperties: false },
);
export type SchedulingConfigurationAuditListQuery = Static<
  typeof SchedulingConfigurationAuditListQuerySchema
>;

export const SchedulingConfigurationAuditReadQuerySchema = Type.Object(
  { eventId: EntityIdSchema },
  { additionalProperties: false },
);
export type SchedulingConfigurationAuditReadQuery = Static<
  typeof SchedulingConfigurationAuditReadQuerySchema
>;

export const SchedulingConfigurationAuditListResponseSchema = Type.Object(
  {
    items: Type.Array(SchedulingConfigurationAuditSummarySchema, {
      maxItems: maximumSchedulingConfigurationAuditPageSize,
    }),
    total: NonNegativeIntegerSchema,
    page: pageSchema,
    pageSize: pageSizeSchema,
  },
  { additionalProperties: false },
);
export type SchedulingConfigurationAuditListResponse = Static<
  typeof SchedulingConfigurationAuditListResponseSchema
>;

function canonicalTimestamp(value: string): boolean {
  const time = new Date(value);
  return Number.isFinite(time.valueOf()) && time.toISOString() === value;
}

function encodedLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function getSchedulingConfigurationIssues(value: SchedulingConfiguration): string[] {
  return canonicalTimestamp(value.updatedAt) ? [] : ["invalid_configuration_time"];
}

function overageMatches(
  limits: SchedulingLimits,
  usage: SchedulingUsage,
  overage: SchedulingOverage,
): boolean {
  return (
    overage.activeLeases ===
      (limits.maxActiveLeases === null
        ? 0
        : Math.max(0, usage.activeLeases - limits.maxActiveLeases)) &&
    overage.admittedQueuedJobs ===
      (limits.maxQueuedJobs === null
        ? 0
        : Math.max(0, usage.admittedQueuedJobs - limits.maxQueuedJobs))
  );
}

export function getSchedulingPlatformCapacityIssues(value: SchedulingPlatformCapacity): string[] {
  if (value.visibility === "restricted") return [];
  const issues = getSchedulingConfigurationIssues(value.configuration);
  if (!overageMatches(value.configuration.limits, value.usage, value.overage))
    issues.push("platform_overage_mismatch");
  return issues;
}

// Call after schema validation. Exact ownership/count provenance and authorization must be
// established by the synchronous database snapshot that constructs the response.
export function getSchedulingStatusIssues(
  value: RepositorySchedulingStatus | PlatformSchedulingStatus,
): string[] {
  const issues: string[] = [];
  if (!canonicalTimestamp(value.observedAt)) issues.push("invalid_observation_time");
  if (encodedLength(value) > maximumSchedulingStatusResponseUtf8Bytes)
    issues.push("status_response_too_large");
  const configuration = "repositoryId" in value ? null : value.configuration;
  const limits = "repositoryId" in value ? value.limits : value.configuration.limits;
  if (!overageMatches(limits, value.usage, value.overage)) issues.push("overage_mismatch");
  if (configuration !== null) {
    issues.push(...getSchedulingConfigurationIssues(configuration));
  }
  if ("repositoryId" in value) {
    if (value.platform.visibility === "full") {
      const platform = value.platform;
      issues.push(...getSchedulingPlatformCapacityIssues(platform));
      if (
        (Object.keys(value.usage) as (keyof SchedulingUsage)[]).some(
          (key) => value.usage[key] > platform.usage[key],
        )
      )
        issues.push("repository_usage_exceeds_platform");
    }
  } else if (
    (Object.keys(value.unscopedUsage) as (keyof SchedulingUsage)[]).some(
      (key) => value.unscopedUsage[key] > value.usage[key],
    )
  ) {
    issues.push("unscoped_usage_exceeds_platform");
  }
  return [...new Set(issues)];
}

export function getSchedulingConfigurationAuditSummaryIssues(
  value: SchedulingConfigurationAuditSummary,
): string[] {
  const issues: string[] = [];
  if (!canonicalTimestamp(value.createdAt)) issues.push("invalid_audit_time");
  if (
    [value.actor.issuer, value.actor.subject].some(
      (part) =>
        part.trim() !== part ||
        !part.isWellFormed() ||
        [...part].some(
          (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
        ),
    )
  )
    issues.push("invalid_audit_actor");
  if (value.version - value.previousVersion !== 1) issues.push("audit_version_mismatch");
  return issues;
}

export function getSchedulingConfigurationAuditEventIssues(
  value: SchedulingConfigurationAuditEvent,
): string[] {
  const issues = getSchedulingConfigurationAuditSummaryIssues(value);
  issues.push(...getSchedulingConfigurationIssues(value.previousSnapshot));
  issues.push(...getSchedulingConfigurationIssues(value.snapshot));
  if (
    value.previousSnapshot.version !== value.previousVersion ||
    value.snapshot.version !== value.version
  )
    issues.push("snapshot_version_mismatch");
  if (
    value.snapshot.updatedAt !== value.createdAt ||
    value.previousSnapshot.updatedAt > value.snapshot.updatedAt
  )
    issues.push("snapshot_time_mismatch");
  if (
    encodedLength(value.previousSnapshot) > maximumSchedulingConfigurationAuditSnapshotUtf8Bytes ||
    encodedLength(value.snapshot) > maximumSchedulingConfigurationAuditSnapshotUtf8Bytes
  )
    issues.push("audit_snapshot_too_large");
  if (encodedLength(value) > maximumSchedulingConfigurationAuditResponseUtf8Bytes)
    issues.push("audit_response_too_large");
  return [...new Set(issues)];
}

export function getSchedulingConfigurationAuditListIssues(
  value: SchedulingConfigurationAuditListResponse,
): string[] {
  const issues = value.items.flatMap(getSchedulingConfigurationAuditSummaryIssues);
  const offset = (value.page - 1) * value.pageSize;
  const expectedCount = Math.min(value.pageSize, Math.max(0, value.total - offset));
  if (value.items.length !== expectedCount) issues.push("invalid_audit_page_size");
  if (new Set(value.items.map((item) => item.id)).size !== value.items.length)
    issues.push("duplicate_audit_event");
  for (let index = 1; index < value.items.length; index += 1) {
    const previous = value.items[index - 1];
    const current = value.items[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      (previous.createdAt < current.createdAt ||
        (previous.createdAt === current.createdAt && previous.id < current.id))
    )
      issues.push("invalid_audit_order");
  }
  if (encodedLength(value) > maximumSchedulingConfigurationAuditResponseUtf8Bytes)
    issues.push("audit_response_too_large");
  return [...new Set(issues)];
}
