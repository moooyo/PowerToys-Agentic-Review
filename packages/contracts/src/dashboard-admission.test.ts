import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  DashboardJobListQuerySchema,
  DashboardJobStageSchema,
  DashboardSystemReadSchema,
  DashboardWorkItemStageSchema,
  getDashboardWorkItemAdmissionIssues,
} from "./dashboard.js";
import { DashboardReviewRunExecutionCountsSchema } from "./dashboard-runs.js";
import type { JobAdmission } from "./job-admission.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const timestamp = "2026-09-07T10:00:00.000Z";
const pending: JobAdmission = {
  state: "pending",
  attemptBase: 1,
  requestedAt: timestamp,
  timestampBasis: "recorded",
  admittedAt: null,
};
const admitted: JobAdmission = { ...pending, state: "admitted", admittedAt: timestamp };
const unscheduled = {
  latestJobId: null,
  latestJobStatus: null,
  latestJobAttemptCount: null,
  latestJobAdmission: null,
  stage: "not_scheduled",
} as const;
const waiting = {
  latestJobId: "job-1",
  latestJobStatus: "retry_waiting",
  latestJobAttemptCount: 1,
  latestJobAdmission: pending,
  stage: "awaiting_admission",
} as const;

describe("Dashboard admission projections", () => {
  it("keeps unscheduled items, pending Jobs and admitted queue entries distinct", () => {
    for (const value of [
      unscheduled,
      waiting,
      { ...waiting, latestJobAdmission: admitted, stage: "queued" as const },
    ])
      expect(getDashboardWorkItemAdmissionIssues(value)).toEqual([]);
    expect(getDashboardWorkItemAdmissionIssues({ ...unscheduled, stage: "queued" })).toEqual([
      "unscheduled_stage_mismatch",
    ]);
    expect(getDashboardWorkItemAdmissionIssues({ ...waiting, stage: "queued" })).toEqual([
      "admission_stage_mismatch",
    ]);
    expect(
      getDashboardWorkItemAdmissionIssues({ ...waiting, latestJobAdmission: admitted }),
    ).toEqual(["admission_stage_mismatch"]);
  });

  it("does not invent a Job from admission, status or attempt metadata", () => {
    for (const update of [
      { latestJobStatus: "queued" as const },
      { latestJobAttemptCount: 0 },
      { latestJobAdmission: pending },
    ])
      expect(getDashboardWorkItemAdmissionIssues({ ...unscheduled, ...update })).toContain(
        "admission_without_job_identity",
      );
    for (const update of [{ latestJobStatus: null }, { latestJobAttemptCount: null }])
      expect(getDashboardWorkItemAdmissionIssues({ ...waiting, ...update })).toEqual([
        "incomplete_latest_job_identity",
      ]);
  });

  it("requires the latest Job's exact waiting episode", () => {
    expect(getDashboardWorkItemAdmissionIssues({ ...waiting, latestJobAttemptCount: 2 })).toEqual([
      "admission_attempt_mismatch",
    ]);
    expect(getDashboardWorkItemAdmissionIssues({ ...waiting, latestJobAdmission: null })).toContain(
      "missing_waiting_admission",
    );
  });

  it.each([
    ["running", "reviewing"],
    ["cancel_requested", "reviewing"],
    ["succeeded", "done"],
    ["cancelled", "done"],
  ] as const)("does not show an old queue episode for %s", (status, stage) => {
    const value = { ...waiting, latestJobStatus: status, latestJobAdmission: null, stage };
    expect(getDashboardWorkItemAdmissionIssues(value)).toEqual([]);
    expect(
      getDashboardWorkItemAdmissionIssues({ ...value, latestJobAdmission: admitted }),
    ).toContain("admission_outside_waiting");
    for (const stage of ["not_scheduled", "awaiting_admission", "queued"] as const)
      expect(getDashboardWorkItemAdmissionIssues({ ...value, stage })).toContain(
        "queue_stage_outside_waiting",
      );
  });

  it("offers admission filters separately from lifecycle status", () => {
    for (const admission of ["pending", "admitted", ["pending", "admitted"]])
      expect(Value.Check(DashboardJobListQuerySchema, { admission, status: "retry_waiting" })).toBe(
        true,
      );
    for (const admission of ["queued", null, [], ["pending", "pending"], ["pending", "unknown"]])
      expect(Value.Check(DashboardJobListQuerySchema, { admission })).toBe(false);
    expect(Value.Check(DashboardJobStageSchema, "awaiting_admission")).toBe(true);
    expect(Value.Check(DashboardWorkItemStageSchema, "not_scheduled")).toBe(true);
    expect(Value.Check(DashboardJobStageSchema, "not_scheduled")).toBe(false);
  });

  it("requires a distinct Run count for accepted Jobs awaiting admission", () => {
    const execution = {
      missing: 1,
      awaitingAdmission: 1,
      queued: 1,
      active: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
    };
    expect(Value.Check(DashboardReviewRunExecutionCountsSchema, execution)).toBe(true);
    const { awaitingAdmission: _omitted, ...legacy } = execution;
    expect(Value.Check(DashboardReviewRunExecutionCountsSchema, legacy)).toBe(false);
    for (const awaitingAdmission of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        Value.Check(DashboardReviewRunExecutionCountsSchema, { ...execution, awaitingAdmission }),
      ).toBe(false);
  });

  it("requires all backlog counters without converting missing configuration into queue usage", () => {
    const value = {
      serverVersion: "0.1.0",
      protocolVersion: "1.0",
      nodeVersion: "24.20.0",
      sqliteVersion: "3.50.0",
      databaseSizeBytes: 0,
      oldestQueuedAt: null,
      queuedJobs: 0,
      awaitingAdmissionJobs: 1,
      pendingValidationRequests: 2,
      oldestAwaitingAdmissionAt: timestamp,
      activeWorkers: 0,
      activeLeases: 0,
      pendingApprovals: 0,
      health: [],
    };
    expect(Value.Check(DashboardSystemReadSchema, value)).toBe(true);
    for (const field of [
      "queuedJobs",
      "awaitingAdmissionJobs",
      "pendingValidationRequests",
      "oldestAwaitingAdmissionAt",
    ]) {
      const missing: Record<string, unknown> = { ...value };
      delete missing[field];
      expect(Value.Check(DashboardSystemReadSchema, missing), field).toBe(false);
    }
  });
});
