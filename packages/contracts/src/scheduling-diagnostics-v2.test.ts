import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { JobAdmission } from "./job-admission.js";
import {
  getSchedulingDiagnosticsIssues,
  type SchedulingDiagnosticJob,
  SchedulingDiagnosticJobSchema,
  SchedulingDiagnosticJobV1Schema,
  type SchedulingDiagnosticJobV2,
  SchedulingDiagnosticJobV2Schema,
  type SchedulingDiagnosticReason,
  SchedulingDiagnosticReasonSchema,
  SchedulingDiagnosticReasonV1Schema,
  SchedulingDiagnosticReasonV2Schema,
  type SchedulingDiagnosticReasonV3,
  SchedulingDiagnosticReasonV3Schema,
  type SchedulingDiagnostics,
  SchedulingDiagnosticsSchema,
  SchedulingDiagnosticsV1Schema,
  type SchedulingDiagnosticsV2,
  SchedulingDiagnosticsV2Schema,
  type SchedulingDiagnosticsV3,
  SchedulingDiagnosticsV3Schema,
} from "./scheduling-diagnostics.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const timestamp = "2026-09-07T10:00:00.000Z";
const admission: JobAdmission = {
  state: "pending",
  attemptBase: 1,
  requestedAt: timestamp,
  timestampBasis: "recorded",
  admittedAt: null,
};
const waiting: SchedulingDiagnosticsV2 = {
  schemaVersion: "SchedulingDiagnosticsV2",
  observedAt: timestamp,
  subject: {
    kind: "repository_job",
    repositoryId: "repository-1",
    workItemId: "work-item-1",
    jobId: "job-1",
  },
  stage: "waiting",
  job: {
    jobId: "job-1",
    status: "retry_waiting",
    attemptCount: 1,
    createdAt: timestamp,
    nextAttemptAt: timestamp,
    admission,
  },
  workerInspection: { state: "complete", latestContactAt: timestamp },
  requirements: { names: [], truncated: false },
  reasons: [{ code: "awaiting_admission", effect: "claim_gate" }],
  reasonsTruncated: false,
};
const job = waiting.job as NonNullable<SchedulingDiagnosticsV2["job"]>;
const noJob: SchedulingDiagnosticsV2 = {
  ...waiting,
  subject: {
    kind: "validation_request",
    repositoryId: "repository-1",
    workItemId: "work-item-1",
    reviewRunId: "run-1",
    requestId: "request-1",
  },
  job: null,
  workerInspection: { state: "not_applicable", latestContactAt: null },
  reasons: [{ code: "plan_prerequisite_missing", effect: "current_prerequisite" }],
};

describe("admission-aware scheduling observations", () => {
  it.each([waiting, noJob])("accepts the exact $subject.kind V2 observation", (value) => {
    expect(Value.Check(SchedulingDiagnosticsV2Schema, value)).toBe(true);
    expect(getSchedulingDiagnosticsIssues(value)).toEqual([]);
  });

  it("keeps every historical shape exact while current public aliases identify V3", () => {
    expect(SchedulingDiagnosticsSchema).toBe(SchedulingDiagnosticsV3Schema);
    expect(SchedulingDiagnosticJobSchema).toBe(SchedulingDiagnosticJobV2Schema);
    expect(SchedulingDiagnosticReasonSchema).toBe(SchedulingDiagnosticReasonV3Schema);
    expectTypeOf<SchedulingDiagnostics>().toEqualTypeOf<SchedulingDiagnosticsV3>();
    expectTypeOf<SchedulingDiagnosticJob>().toEqualTypeOf<SchedulingDiagnosticJobV2>();
    expectTypeOf<SchedulingDiagnosticReason>().toEqualTypeOf<SchedulingDiagnosticReasonV3>();
    expect(Value.Check(SchedulingDiagnosticsSchema, waiting)).toBe(false);
    expect(Value.Check(SchedulingDiagnosticsV1Schema, waiting)).toBe(false);
    expect(Value.Check(SchedulingDiagnosticJobV1Schema, job)).toBe(false);
    expect(Value.Check(SchedulingDiagnosticReasonV1Schema, waiting.reasons[0])).toBe(false);
    const { admission: _omitted, ...oldJob } = job;
    const old = { ...waiting, schemaVersion: "SchedulingDiagnosticsV1", job: oldJob, reasons: [] };
    expect(Value.Check(SchedulingDiagnosticsV1Schema, old)).toBe(true);
    expect(Value.Check(SchedulingDiagnosticsSchema, old)).toBe(false);
    expect(Value.Check(SchedulingDiagnosticJobSchema, oldJob)).toBe(false);
  });

  it("requires the current episode to match the waiting Job's attempt count", () => {
    expect(
      getSchedulingDiagnosticsIssues({ ...waiting, job: { ...job, attemptCount: 2 } }),
    ).toContain("admission_attempt_mismatch");
    expect(
      getSchedulingDiagnosticsIssues({ ...waiting, job: { ...job, admission: null } }),
    ).toContain("missing_waiting_admission");
  });

  it("requires an awaiting-admission reason exactly when a real pending episode exists", () => {
    expect(getSchedulingDiagnosticsIssues({ ...waiting, reasons: [] })).toContain(
      "admission_reason_mismatch",
    );
    const admitted: SchedulingDiagnosticsV2 = {
      ...waiting,
      job: { ...job, admission: { ...admission, state: "admitted", admittedAt: timestamp } },
      reasons: [],
    };
    expect(getSchedulingDiagnosticsIssues(admitted)).toEqual([]);
    expect(getSchedulingDiagnosticsIssues({ ...admitted, reasons: waiting.reasons })).toContain(
      "admission_reason_mismatch",
    );
    expect(getSchedulingDiagnosticsIssues({ ...noJob, reasons: waiting.reasons })).toEqual([
      "admission_reason_mismatch",
      "claim_gate_without_job",
    ]);
    for (const effect of ["observation", "current_prerequisite"])
      expect(
        Value.Check(SchedulingDiagnosticReasonSchema, { code: "awaiting_admission", effect }),
      ).toBe(false);
  });

  it.each([
    ["running", "executing"],
    ["cancel_requested", "executing"],
    ["succeeded", "terminal"],
    ["cancelled", "terminal"],
  ] as const)("does not expose current admission while %s", (status, stage) => {
    const value: SchedulingDiagnosticsV2 = {
      ...waiting,
      stage,
      job: { ...job, status, admission: null, nextAttemptAt: null },
      workerInspection: { state: "not_applicable", latestContactAt: null },
      reasons: [],
    };
    expect(Value.Check(SchedulingDiagnosticsV2Schema, value)).toBe(true);
    expect(getSchedulingDiagnosticsIssues(value)).toEqual([]);
    expect(
      getSchedulingDiagnosticsIssues({
        ...value,
        job: { ...job, status, admission, nextAttemptAt: null },
      }),
    ).toContain("admission_outside_waiting");
  });

  it("does not turn admission into a lease reservation, limit assertion or service guarantee", () => {
    for (const field of [
      "queuePosition",
      "reserved",
      "estimatedStartAt",
      "limits",
      "bucket",
      "episodeSequence",
    ])
      expect(Value.Check(SchedulingDiagnosticsV2Schema, { ...waiting, [field]: 1 }), field).toBe(
        false,
      );
    for (const code of [
      "repository_queue_limit",
      "platform_active_limit",
      "missing_credentials",
      "desktop_locked",
    ])
      expect(
        Value.Check(SchedulingDiagnosticReasonV2Schema, { code, effect: "claim_gate" }),
        code,
      ).toBe(false);
  });

  it("preserves canonical admission observations across wall-clock rollback", () => {
    expect(
      getSchedulingDiagnosticsIssues({
        ...waiting,
        observedAt: "2026-09-07T09:59:00.000Z",
        job: {
          ...job,
          nextAttemptAt: null,
          admission: {
            ...admission,
            state: "admitted",
            admittedAt: "2026-09-07T09:58:00.000Z",
          },
        },
        reasons: [],
      }),
    ).toEqual([]);
  });
});
