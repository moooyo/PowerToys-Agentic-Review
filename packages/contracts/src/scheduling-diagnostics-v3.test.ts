import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  getSchedulingDiagnosticsIssues,
  getSchedulingLimitReasons,
  type SchedulingDiagnosticPolicy,
  SchedulingDiagnosticReasonV1Schema,
  SchedulingDiagnosticReasonV2Schema,
  SchedulingDiagnosticReasonV3Schema,
  SchedulingDiagnosticsSchema,
  SchedulingDiagnosticsV1Schema,
  SchedulingDiagnosticsV2Schema,
  type SchedulingDiagnosticsV3,
  SchedulingDiagnosticsV3Schema,
} from "./scheduling-diagnostics.js";
import { getSchedulingCapacity } from "./scheduling-policy.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
const timestamp = "2026-09-07T10:00:00.000Z";
const usage = {
  activeLeases: 2,
  admittedQueuedJobs: 3,
  awaitingAdmissionJobs: 1,
  awaitingConfigurationRequests: 1,
};
const policy: SchedulingDiagnosticPolicy = {
  repository: {
    repositoryId: "repository-1",
    version: 2,
    enabled: true,
    limits: { maxActiveLeases: 2, maxQueuedJobs: 3 },
    usage,
    overage: { activeLeases: 0, admittedQueuedJobs: 0 },
  },
  platform: {
    visibility: "restricted",
    version: 3,
    activeCapacity: "limited",
    queueCapacity: "limited",
  },
};
const waiting: SchedulingDiagnosticsV3 = {
  schemaVersion: "SchedulingDiagnosticsV3",
  observedAt: timestamp,
  subject: {
    kind: "repository_job",
    repositoryId: "repository-1",
    workItemId: "item-1",
    jobId: "job-1",
  },
  stage: "waiting",
  job: {
    jobId: "job-1",
    status: "queued",
    attemptCount: 0,
    createdAt: timestamp,
    nextAttemptAt: null,
    admission: {
      state: "pending",
      attemptBase: 0,
      requestedAt: timestamp,
      timestampBasis: "recorded",
      admittedAt: null,
    },
  },
  policy,
  workerInspection: { state: "complete", latestContactAt: timestamp },
  requirements: { names: [], truncated: false },
  reasons: [{ code: "awaiting_admission", effect: "claim_gate" }],
  reasonsTruncated: false,
};
waiting.reasons.push(...getSchedulingLimitReasons(policy, waiting.job, waiting.stage));
const fullPolicy: SchedulingDiagnosticPolicy = {
  ...policy,
  platform: {
    visibility: "full",
    configuration: {
      version: 3,
      limits: { maxActiveLeases: 2, maxQueuedJobs: 3 },
      policyId: "repository-service-v1",
      updatedAt: timestamp,
    },
    usage,
    overage: { activeLeases: 0, admittedQueuedJobs: 0 },
  },
};

describe("current versioned policy observations", () => {
  it("requires V3 policy and preserves strict historical V1/V2 observations", () => {
    expect(Value.Check(SchedulingDiagnosticsSchema, waiting)).toBe(true);
    expect(getSchedulingDiagnosticsIssues(waiting)).toEqual([]);
    expect(getSchedulingDiagnosticsIssues({ ...waiting, policy: fullPolicy })).toEqual([]);
    const { policy: _policy, ...withoutPolicy } = waiting;
    expect(Value.Check(SchedulingDiagnosticsV3Schema, withoutPolicy)).toBe(false);
    for (const schema of [SchedulingDiagnosticsV1Schema, SchedulingDiagnosticsV2Schema]) {
      expect(Value.Check(schema, waiting)).toBe(false);
      expect(
        Value.Check(schema, {
          ...waiting,
          schemaVersion: schema.properties.schemaVersion.const,
          reasons: [],
        }),
      ).toBe(false);
    }
  });

  it.each([
    ["repository_queue_limit", "admission_gate"],
    ["platform_queue_limit", "admission_gate"],
    ["repository_active_limit", "claim_gate"],
    ["platform_active_limit", "claim_gate"],
  ])("allows only the precise new effect for %s", (code, effect) => {
    const reason = { code, effect };
    expect(Value.Check(SchedulingDiagnosticReasonV3Schema, reason)).toBe(true);
    expect(Value.Check(SchedulingDiagnosticReasonV1Schema, reason)).toBe(false);
    expect(Value.Check(SchedulingDiagnosticReasonV2Schema, reason)).toBe(false);
    for (const wrongEffect of [
      "observation",
      "current_prerequisite",
      effect === "claim_gate" ? "admission_gate" : "claim_gate",
    ])
      expect(Value.Check(SchedulingDiagnosticReasonV3Schema, { code, effect: wrongEffect })).toBe(
        false,
      );
    expect(Value.Check(SchedulingDiagnosticReasonV3Schema, { ...reason, limit: 3 })).toBe(false);
  });

  it("uses exact inclusive quota boundaries and unlimited scope semantics", () => {
    expect(getSchedulingCapacity({ maxActiveLeases: 3, maxQueuedJobs: 4 }, usage)).toEqual({
      activeCapacity: "available",
      queueCapacity: "available",
    });
    expect(getSchedulingCapacity({ maxActiveLeases: 2, maxQueuedJobs: 3 }, usage)).toEqual({
      activeCapacity: "limited",
      queueCapacity: "limited",
    });
    expect(getSchedulingCapacity({ maxActiveLeases: null, maxQueuedJobs: null }, usage)).toEqual({
      activeCapacity: "available",
      queueCapacity: "available",
    });
    expect(getSchedulingLimitReasons(policy, waiting.job, "waiting")).toEqual([
      { code: "repository_queue_limit", effect: "admission_gate" },
      { code: "platform_queue_limit", effect: "admission_gate" },
      { code: "repository_active_limit", effect: "claim_gate" },
      { code: "platform_active_limit", effect: "claim_gate" },
    ]);
  });

  it("requires matching exact repository policy and forbids restricted global payloads", () => {
    if (!policy.repository) throw new Error("The fixture requires repository policy.");
    expect(
      getSchedulingDiagnosticsIssues({ ...waiting, policy: { ...policy, repository: null } }),
    ).toContain("repository_policy_identity_mismatch");
    expect(
      getSchedulingDiagnosticsIssues({
        ...waiting,
        policy: { ...policy, repository: { ...policy.repository, repositoryId: "foreign" } },
      }),
    ).toContain("repository_policy_identity_mismatch");
    for (const leaked of [
      { usage },
      { limits: { maxActiveLeases: 2, maxQueuedJobs: 3 } },
      { workerNodeId: "foreign" },
      { repositoryId: "foreign" },
    ]) {
      expect(
        Value.Check(SchedulingDiagnosticsV3Schema, {
          ...waiting,
          policy: { ...policy, platform: { ...policy.platform, ...leaked } },
        }),
      ).toBe(false);
    }
    const platformJob = {
      ...waiting,
      subject: {
        kind: "platform_job",
        jobId: "job-1",
        association: "unassociated_legacy",
      } as const,
    };
    expect(getSchedulingDiagnosticsIssues(platformJob)).toContain("platform_job_policy_restricted");
    expect(getSchedulingDiagnosticsIssues({ ...platformJob, policy: fullPolicy })).toEqual([]);
  });

  it("requires actual finite saturated usage for every limit reason", () => {
    const awaitingAdmission = { code: "awaiting_admission", effect: "claim_gate" } as const;
    expect(getSchedulingDiagnosticsIssues({ ...waiting, reasons: [awaitingAdmission] })).toContain(
      "limit_reason_mismatch",
    );
    if (!policy.repository) throw new Error("The fixture requires repository policy.");
    const availablePolicy: SchedulingDiagnosticPolicy = {
      repository: { ...policy.repository, limits: { maxActiveLeases: null, maxQueuedJobs: null } },
      platform: {
        visibility: "restricted",
        version: 3,
        activeCapacity: "available",
        queueCapacity: "available",
      },
    };
    expect(getSchedulingDiagnosticsIssues({ ...waiting, policy: availablePolicy })).toContain(
      "limit_reason_mismatch",
    );
    expect(
      getSchedulingDiagnosticsIssues({
        ...waiting,
        policy: availablePolicy,
        reasons: [awaitingAdmission],
      }),
    ).toEqual([]);
  });

  it("never assigns quota blockers to requests without a real Job", () => {
    const noJob: SchedulingDiagnosticsV3 = {
      ...waiting,
      subject: {
        kind: "validation_request",
        repositoryId: "repository-1",
        workItemId: "item-1",
        reviewRunId: "run-1",
        requestId: "request-1",
      },
      job: null,
      workerInspection: { state: "not_applicable", latestContactAt: null },
      reasons: [{ code: "plan_prerequisite_missing", effect: "current_prerequisite" }],
    };
    expect(Value.Check(SchedulingDiagnosticsV3Schema, noJob)).toBe(true);
    expect(getSchedulingDiagnosticsIssues(noJob)).toEqual([]);
    expect(getSchedulingLimitReasons(policy, null, "waiting")).toEqual([]);
    expect(
      getSchedulingDiagnosticsIssues({
        ...noJob,
        reasons: [{ code: "repository_queue_limit", effect: "admission_gate" }],
      }),
    ).toContain("admission_gate_without_job");
  });

  it("observes active limits on admitted Jobs without inventing queue blockers", () => {
    if (!waiting.job?.admission) throw new Error("The fixture requires admission.");
    const job = {
      ...waiting.job,
      admission: { ...waiting.job.admission, state: "admitted", admittedAt: timestamp } as const,
    };
    const reasons = getSchedulingLimitReasons(policy, job, "waiting");
    expect(reasons.map((reason) => reason.code)).toEqual([
      "repository_active_limit",
      "platform_active_limit",
    ]);
    expect(getSchedulingDiagnosticsIssues({ ...waiting, job, reasons })).toEqual([]);
    expect(getSchedulingLimitReasons(policy, job, "executing")).toEqual([]);
    expect(getSchedulingLimitReasons(policy, job, "terminal")).toEqual([]);
  });
});
