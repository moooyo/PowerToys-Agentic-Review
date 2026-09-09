import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  getSchedulingConfigurationAuditEventIssues,
  getSchedulingConfigurationAuditListIssues,
  getSchedulingConfigurationIssues,
  getSchedulingStatusIssues,
  maximumSchedulingConfigurationAuditPageSize,
  type PlatformSchedulingStatus,
  PlatformSchedulingStatusSchema,
  type RepositorySchedulingStatus,
  RepositorySchedulingStatusSchema,
  type SchedulingConfiguration,
  type SchedulingConfigurationAuditEvent,
  SchedulingConfigurationAuditEventSchema,
  SchedulingConfigurationAuditListQuerySchema,
  SchedulingConfigurationAuditListResponseSchema,
  SchedulingConfigurationAuditReadQuerySchema,
  SchedulingConfigurationAuditSummarySchema,
  SchedulingConfigurationSchema,
  SchedulingConfigurationUpdateRequestSchema,
  SchedulingPlatformVisibilitySchema,
  type SchedulingUsage,
  SchedulingUsageSchema,
} from "./scheduling-policy.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const timestamp = "2026-09-07T10:00:00.000Z";
const configuration: SchedulingConfiguration = {
  version: 1,
  limits: { maxActiveLeases: null, maxQueuedJobs: null },
  policyId: "repository-service-v1",
  updatedAt: timestamp,
};
const usage: SchedulingUsage = {
  activeLeases: 3,
  admittedQueuedJobs: 4,
  awaitingAdmissionJobs: 7,
  awaitingConfigurationRequests: 2,
};
const zeroUsage: SchedulingUsage = {
  activeLeases: 0,
  admittedQueuedJobs: 0,
  awaitingAdmissionJobs: 0,
  awaitingConfigurationRequests: 0,
};
const repository: RepositorySchedulingStatus = {
  repositoryId: "repository-1",
  observedAt: timestamp,
  repositoryVersion: 3,
  enabled: true,
  limits: { maxActiveLeases: 2, maxQueuedJobs: 3 },
  usage,
  overage: { activeLeases: 1, admittedQueuedJobs: 1 },
  platform: {
    visibility: "restricted",
    version: 1,
    activeCapacity: "available",
    queueCapacity: "limited",
  },
};
const platform: PlatformSchedulingStatus = {
  observedAt: timestamp,
  configuration,
  usage,
  unscopedUsage: zeroUsage,
  overage: { activeLeases: 0, admittedQueuedJobs: 0 },
};
const event: SchedulingConfigurationAuditEvent = {
  id: "scheduling-audit-1",
  actor: { issuer: "local", subject: "operator-1" },
  previousVersion: 1,
  version: 2,
  previousSnapshot: configuration,
  snapshot: {
    ...configuration,
    version: 2,
    limits: { maxActiveLeases: 2, maxQueuedJobs: 3 },
  },
  createdAt: timestamp,
};
const { previousSnapshot: _previousSnapshot, snapshot: _snapshot, ...summary } = event;

describe("platform scheduling configuration", () => {
  it("requires a fixed service policy and a complete versioned replacement", () => {
    expect(Value.Check(SchedulingConfigurationSchema, configuration)).toBe(true);
    expect(getSchedulingConfigurationIssues(configuration)).toEqual([]);
    expect(
      Value.Check(SchedulingConfigurationUpdateRequestSchema, {
        expectedVersion: 1,
        limits: configuration.limits,
      }),
    ).toBe(true);
    for (const replacement of [
      {},
      { expectedVersion: 1 },
      { expectedVersion: 0, limits: configuration.limits },
      { expectedVersion: 1, limits: { maxQueuedJobs: 3 } },
      { expectedVersion: 1, limits: configuration.limits, actor: event.actor },
      { expectedVersion: 1, limits: configuration.limits, policyId: "repository-service-v1" },
    ]) {
      expect(Value.Check(SchedulingConfigurationUpdateRequestSchema, replacement)).toBe(false);
    }
    for (const policyId of [null, "priority-v1", "repository-service-v2"]) {
      expect(Value.Check(SchedulingConfigurationSchema, { ...configuration, policyId })).toBe(
        false,
      );
    }
    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(Value.Check(SchedulingConfigurationSchema, { ...configuration, version })).toBe(false);
    }
  });

  it("rejects noncanonical times after schema validation", () => {
    expect(
      getSchedulingConfigurationIssues({ ...configuration, updatedAt: "2026-09-07T10:00:00Z" }),
    ).toContain("invalid_configuration_time");
    expect(
      getSchedulingStatusIssues({ ...platform, observedAt: "2026-09-07T12:00:00.000+02:00" }),
    ).toContain("invalid_observation_time");
    // A committed configuration can predate a server clock rollback without becoming invalid.
    expect(
      getSchedulingStatusIssues({
        ...platform,
        configuration: { ...configuration, updatedAt: "2026-09-07T10:00:01.000Z" },
      }),
    ).toEqual([]);
  });
});

describe("scoped scheduling status", () => {
  it("reports exact own usage and separates admitted, pending, and no-Job waiting", () => {
    expect(Value.Check(RepositorySchedulingStatusSchema, repository)).toBe(true);
    expect(getSchedulingStatusIssues(repository)).toEqual([]);
    expect(Value.Check(PlatformSchedulingStatusSchema, platform)).toBe(true);
    expect(getSchedulingStatusIssues(platform)).toEqual([]);
    for (const field of Object.keys(usage)) {
      const incomplete: Record<string, unknown> = { ...usage };
      delete incomplete[field];
      expect(Value.Check(SchedulingUsageSchema, incomplete), field).toBe(false);
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", null]) {
        expect(Value.Check(SchedulingUsageSchema, { ...usage, [field]: value })).toBe(false);
      }
    }
  });

  it("does not allow restricted global details to leak or masquerade as unlimited", () => {
    const restricted = repository.platform;
    expect(Value.Check(SchedulingPlatformVisibilitySchema, restricted)).toBe(true);
    for (const foreign of [
      { usage },
      { limits: configuration.limits },
      { configuration },
      { overage: platform.overage },
      { activeLeases: 3 },
      { workerNodeId: "worker-secret" },
      { repositoryId: "repository-secret" },
    ]) {
      expect(Value.Check(SchedulingPlatformVisibilitySchema, { ...restricted, ...foreign })).toBe(
        false,
      );
      expect(
        Value.Check(RepositorySchedulingStatusSchema, {
          ...repository,
          platform: { ...restricted, ...foreign },
        }),
      ).toBe(false);
    }
    expect(Value.Check(SchedulingPlatformVisibilitySchema, null)).toBe(false);
    expect(
      Value.Check(SchedulingPlatformVisibilitySchema, { ...restricted, activeCapacity: null }),
    ).toBe(false);
    const full = { visibility: "full", configuration, usage, overage: platform.overage } as const;
    expect(Value.Check(SchedulingPlatformVisibilitySchema, full)).toBe(true);
    expect(Value.Check(SchedulingPlatformVisibilitySchema, { ...full, version: 1 })).toBe(false);
    expect(getSchedulingStatusIssues({ ...repository, platform: full })).toEqual([]);
  });

  it("preserves overage when limits are lowered and rejects fabricated accounting", () => {
    expect(
      getSchedulingStatusIssues({
        ...repository,
        overage: { activeLeases: 0, admittedQueuedJobs: 0 },
      }),
    ).toContain("overage_mismatch");
    expect(
      getSchedulingStatusIssues({
        ...platform,
        unscopedUsage: { ...zeroUsage, activeLeases: usage.activeLeases + 1 },
      }),
    ).toContain("unscoped_usage_exceeds_platform");
    expect(
      getSchedulingStatusIssues({
        ...repository,
        platform: {
          visibility: "full",
          configuration,
          usage: zeroUsage,
          overage: platform.overage,
        },
      }),
    ).toContain("repository_usage_exceeds_platform");
    expect(
      getSchedulingStatusIssues({
        ...repository,
        platform: {
          visibility: "full",
          configuration,
          usage,
          overage: { activeLeases: 1, admittedQueuedJobs: 0 },
        },
      }),
    ).toContain("platform_overage_mismatch");
  });
});

describe("platform scheduling configuration audit", () => {
  it("requires exact old and new configuration snapshots and authenticated attribution", () => {
    expect(Value.Check(SchedulingConfigurationAuditSummarySchema, summary)).toBe(true);
    expect(Value.Check(SchedulingConfigurationAuditSummarySchema, event)).toBe(false);
    expect(Value.Check(SchedulingConfigurationAuditEventSchema, event)).toBe(true);
    expect(Value.Check(SchedulingConfigurationAuditEventSchema, summary)).toBe(false);
    expect(getSchedulingConfigurationAuditEventIssues(event)).toEqual([]);
    for (const field of ["previousSnapshot", "snapshot", "actor", "previousVersion", "version"]) {
      const incomplete: Record<string, unknown> = { ...event };
      delete incomplete[field];
      expect(Value.Check(SchedulingConfigurationAuditEventSchema, incomplete)).toBe(false);
    }
    for (const actor of ["operator-1", { issuer: "local" }, { ...event.actor, role: "admin" }]) {
      expect(Value.Check(SchedulingConfigurationAuditEventSchema, { ...event, actor })).toBe(false);
    }
    for (const snapshot of [
      { ...configuration, limits: { maxActiveLeases: 0, maxQueuedJobs: null } },
      { ...configuration, updatedBy: "operator-1" },
    ]) {
      expect(Value.Check(SchedulingConfigurationAuditEventSchema, { ...event, snapshot })).toBe(
        false,
      );
    }
  });

  it("checks snapshot version pairing, sequential CAS history, and exact timestamps", () => {
    expect(getSchedulingConfigurationAuditEventIssues({ ...event, version: 3 })).toContain(
      "audit_version_mismatch",
    );
    expect(
      getSchedulingConfigurationAuditEventIssues({ ...event, previousSnapshot: event.snapshot }),
    ).toContain("snapshot_version_mismatch");
    expect(
      getSchedulingConfigurationAuditEventIssues({
        ...event,
        createdAt: "2026-09-07T10:00:01.000Z",
      }),
    ).toContain("snapshot_time_mismatch");
    expect(
      getSchedulingConfigurationAuditEventIssues({
        ...event,
        previousSnapshot: { ...configuration, updatedAt: "2026-09-07T10:00:01.000Z" },
      }),
    ).toContain("snapshot_time_mismatch");
  });

  it.each([" operator", "operator ", "operator\u0000id", "operator\u007fid", "\ud800"])(
    "rejects invalid authenticated actor text: %j",
    (part) => {
      for (const field of ["issuer", "subject"] as const) {
        expect(
          getSchedulingConfigurationAuditEventIssues({
            ...event,
            actor: { ...event.actor, [field]: part },
          }),
        ).toContain("invalid_audit_actor");
      }
    },
  );

  it("bounds platform-only pagination and returns summaries without repository filters", () => {
    expect(Value.Check(SchedulingConfigurationAuditListQuerySchema, {})).toBe(true);
    expect(
      Value.Check(SchedulingConfigurationAuditListQuerySchema, {
        page: 10_000_000,
        pageSize: maximumSchedulingConfigurationAuditPageSize,
      }),
    ).toBe(true);
    for (const query of [
      { page: 0 },
      { page: 10_000_001 },
      { pageSize: 21 },
      { repositoryId: "repository-1" },
      { templateId: "template-1" },
    ]) {
      expect(Value.Check(SchedulingConfigurationAuditListQuerySchema, query)).toBe(false);
    }
    expect(Value.Check(SchedulingConfigurationAuditReadQuerySchema, { eventId: event.id })).toBe(
      true,
    );
    expect(
      Value.Check(SchedulingConfigurationAuditReadQuerySchema, {
        eventId: event.id,
        repositoryId: "repository-1",
      }),
    ).toBe(false);
    const page = { items: [summary], total: 1, page: 1, pageSize: 20 };
    expect(Value.Check(SchedulingConfigurationAuditListResponseSchema, page)).toBe(true);
    expect(getSchedulingConfigurationAuditListIssues(page)).toEqual([]);
    expect(
      Value.Check(SchedulingConfigurationAuditListResponseSchema, { ...page, items: [event] }),
    ).toBe(false);
    expect(
      Value.Check(SchedulingConfigurationAuditListResponseSchema, {
        ...page,
        items: Array.from({ length: 21 }, () => summary),
      }),
    ).toBe(false);
    expect(
      getSchedulingConfigurationAuditListIssues({ ...page, items: [summary, summary] }),
    ).toEqual(["invalid_audit_page_size", "duplicate_audit_event"]);
    expect(getSchedulingConfigurationAuditListIssues({ ...page, items: [] })).toContain(
      "invalid_audit_page_size",
    );
    expect(getSchedulingConfigurationAuditListIssues({ ...page, page: 2, items: [] })).toEqual([]);
    const second = { ...summary, id: "scheduling-audit-2", previousVersion: 2, version: 3 };
    expect(
      getSchedulingConfigurationAuditListIssues({ ...page, total: 2, items: [summary, second] }),
    ).toContain("invalid_audit_order");
    expect(
      getSchedulingConfigurationAuditListIssues({ ...page, total: 2, items: [second, summary] }),
    ).toEqual([]);
  });
});
