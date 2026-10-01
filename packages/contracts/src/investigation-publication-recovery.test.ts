import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import type { InvestigationCommentPublicationSummary } from "./investigation-comments.js";
import {
  type InvestigationPublicationRecoveryBlocker,
  type InvestigationPublicationRecoveryRequest,
  InvestigationPublicationRecoveryRequestSchema,
  type InvestigationPublicationRecoveryStatus,
  InvestigationPublicationRecoveryStatusSchema,
} from "./investigation-publication-recovery.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const version = "a".repeat(64);
const timestamp = "2026-10-01T00:00:00.000Z";
const publication: InvestigationCommentPublicationSummary = {
  id: "progress-reply:task:task-1",
  version,
  mode: "progress",
  repositoryId: "repo-1",
  repositoryFullName: "example/project",
  workItemId: "work-item-1",
  workItemKind: "pull_request",
  workItemNumber: 7,
  taskId: "task-1",
  reportId: "report-1",
  state: "needs_attention",
  reasonCode: "queue_full",
  reason: "The publication queue is full.",
  requiresAttention: true,
  nextAttemptAt: null,
  lastAttemptAt: null,
  lastConfirmedAt: null,
  externalId: null,
  commentUrl: null,
  availableActions: ["sync"],
  createdAt: timestamp,
  updatedAt: timestamp,
};
const missing: InvestigationPublicationRecoveryStatus = {
  taskId: "task-1",
  reportId: "report-1",
  version,
  state: "missing",
  blocker: null,
  publication: null,
  availableActions: ["enqueue"],
};
const request: InvestigationPublicationRecoveryRequest = {
  version,
  reportId: "report-1",
  idempotencyKey: "recovery-command-1",
};

describe("saved report publication recovery contracts", () => {
  it("accepts missing delivery, an existing publication, and a blocked recovery", () => {
    for (const status of [
      missing,
      { ...missing, state: "existing", publication, availableActions: [] },
      {
        ...missing,
        state: "blocked",
        reportId: null,
        blocker: "report_unavailable",
        availableActions: [],
      },
    ])
      expect(Value.Check(InvestigationPublicationRecoveryStatusSchema, status)).toBe(true);
  });

  it("accepts the defined recovery blockers", () => {
    const blockers: InvestigationPublicationRecoveryBlocker[] = [
      "unsupported_task",
      "report_unavailable",
      "newer_task",
      "newer_publication",
      "legacy_publication",
      "publication_conflict",
      "reconcile_required",
      "publication_busy",
      "automatic_replies_disabled",
      "external_writes_disabled",
      "publisher_unavailable",
      "permission_denied",
      "authorization_unavailable",
      "repository_identity_changed",
      "work_item_identity_changed",
    ];
    for (const blocker of blockers)
      expect(
        Value.Check(InvestigationPublicationRecoveryStatusSchema, {
          ...missing,
          state: "blocked",
          blocker,
          availableActions: [],
        }),
      ).toBe(true);
  });

  it("requires every status field and rejects unknown fields at either level", () => {
    for (const key of Object.keys(missing)) {
      const incomplete: Record<string, unknown> = { ...missing };
      delete incomplete[key];
      expect(Value.Check(InvestigationPublicationRecoveryStatusSchema, incomplete)).toBe(false);
    }
    expect(
      Value.Check(InvestigationPublicationRecoveryStatusSchema, {
        ...missing,
        recoveryMode: "retry",
      }),
    ).toBe(false);
    expect(
      Value.Check(InvestigationPublicationRecoveryStatusSchema, {
        ...missing,
        state: "existing",
        publication: { ...publication, recoveryMode: "retry" },
        availableActions: [],
      }),
    ).toBe(false);
  });

  it.each([
    ["invalid task ID", { taskId: "../task-1" }],
    ["invalid report ID", { reportId: "report/1" }],
    ["short version", { version: "a".repeat(63) }],
    ["uppercase version", { version: "A".repeat(64) }],
    ["unknown state", { state: "pending" }],
    ["unknown blocker", { blocker: "worker_unavailable" }],
    ["incomplete publication", { publication: { id: publication.id } }],
    ["invalid publication state", { publication: { ...publication, state: "missing" } }],
    ["comment synchronization action", { availableActions: ["sync"] }],
    ["comment reconciliation action", { availableActions: ["reconcile"] }],
    ["duplicate enqueue action", { availableActions: ["enqueue", "enqueue"] }],
    ["non-array actions", { availableActions: "enqueue" }],
  ] as const)("rejects status with %s", (_name, changed) => {
    expect(
      Value.Check(InvestigationPublicationRecoveryStatusSchema, { ...missing, ...changed }),
    ).toBe(false);
  });

  it("accepts an exact report command with bounded idempotency keys", () => {
    expect(Value.Check(InvestigationPublicationRecoveryRequestSchema, request)).toBe(true);
    for (const idempotencyKey of ["x", "x".repeat(128)])
      expect(
        Value.Check(InvestigationPublicationRecoveryRequestSchema, { ...request, idempotencyKey }),
      ).toBe(true);
  });

  it("requires the version, report ID, and idempotency key", () => {
    for (const key of Object.keys(request)) {
      const incomplete: Record<string, unknown> = { ...request };
      delete incomplete[key];
      expect(Value.Check(InvestigationPublicationRecoveryRequestSchema, incomplete)).toBe(false);
    }
  });

  it("rejects controls from task execution and other publication workflows", () => {
    for (const control of [
      { action: "enqueue" },
      { expectedVersion: version },
      { changeId: "change-1" },
      { budget: { maxRounds: 1, maxDurationMs: 1_000, maxTokens: 100 } },
      { parentReportRef: { id: "report-1", version: 1, digest: version } },
    ])
      expect(
        Value.Check(InvestigationPublicationRecoveryRequestSchema, { ...request, ...control }),
      ).toBe(false);
  });

  it.each([
    ["invalid report ID", { reportId: "report/1" }],
    ["null report ID", { reportId: null }],
    ["short version", { version: "a".repeat(63) }],
    ["non-hex version", { version: "g".repeat(64) }],
    ["uppercase version", { version: "A".repeat(64) }],
    ["numeric version", { version: 1 }],
    ["empty idempotency key", { idempotencyKey: "" }],
    ["whitespace idempotency key", { idempotencyKey: " \t\n" }],
    ["oversized idempotency key", { idempotencyKey: "x".repeat(129) }],
  ] as const)("rejects request with %s", (_name, changed) => {
    expect(
      Value.Check(InvestigationPublicationRecoveryRequestSchema, { ...request, ...changed }),
    ).toBe(false);
  });
});
