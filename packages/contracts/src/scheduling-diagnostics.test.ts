import { FormatRegistry, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  getSchedulingDiagnosticsIssues,
  maximumSchedulingDiagnosticReasonCount,
  maximumSchedulingDiagnosticRequirementCount,
  maximumSchedulingDiagnosticRequirementNameLength,
  maximumSchedulingDiagnosticsResponseUtf8Bytes,
  type SchedulingDiagnosticReasonV1 as SchedulingDiagnosticReason,
  SchedulingDiagnosticReasonV1Schema as SchedulingDiagnosticReasonSchema,
  SchedulingDiagnosticRequirementsSchema,
  SchedulingDiagnosticSubjectSchema,
  type SchedulingDiagnostics,
  SchedulingDiagnosticsSchema,
  type SchedulingDiagnosticsV1,
  SchedulingDiagnosticsV1Schema,
  type SchedulingDiagnosticsV3,
  SchedulingDiagnosticsV3Schema,
  SchedulingRequirementNameSchema,
  SchedulingWorkerInspectionSchema,
} from "./scheduling-diagnostics.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const observedAt = "2026-09-07T10:00:00.000Z";
const before = "2026-09-07T09:59:00.000Z";
const after = "2026-09-07T10:01:00.000Z";
const job = {
  jobId: "job-one",
  status: "queued",
  attemptCount: 0,
  createdAt: before,
  nextAttemptAt: before,
} as const;
const waiting: SchedulingDiagnosticsV1 = {
  schemaVersion: "SchedulingDiagnosticsV1",
  observedAt,
  subject: {
    kind: "repository_job",
    repositoryId: "repository-one",
    workItemId: "work-item-one",
    jobId: job.jobId,
  },
  stage: "waiting",
  job,
  workerInspection: { state: "complete", latestContactAt: before },
  requirements: { names: ["software.codex", "labels.windows_uia"], truncated: false },
  reasons: [],
  reasonsTruncated: false,
};
const requestSubject = {
  kind: "validation_request",
  repositoryId: "repository-one",
  workItemId: "work-item-one",
  reviewRunId: "run-one",
  requestId: "request-one",
} as const;
const noJob: SchedulingDiagnosticsV1 = {
  ...waiting,
  subject: requestSubject,
  job: null,
  workerInspection: { state: "not_applicable", latestContactAt: null },
  reasons: [
    { code: "plan_prerequisite_missing", effect: "current_prerequisite", requirement: "prompt" },
  ],
};
const platform: SchedulingDiagnosticsV1 = {
  ...waiting,
  subject: { kind: "platform_job", jobId: job.jobId, association: "unassociated_legacy" },
};

describe("scoped scheduling diagnostic subjects", () => {
  it.each([waiting, noJob, { ...waiting, subject: requestSubject }, platform])(
    "supports a $subject.kind observation without manufacturing a Job",
    (value) => {
      expect(Value.Check(SchedulingDiagnosticsV1Schema, value)).toBe(true);
      expect(getSchedulingDiagnosticsIssues(value)).toEqual([]);
    },
  );

  it("distinguishes unassociated Legacy access from associated repository ownership", () => {
    expect(Value.Check(SchedulingDiagnosticSubjectSchema, platform.subject)).toBe(true);
    for (const invalid of [
      { ...platform.subject, repositoryId: "inferred-owner" },
      { ...platform.subject, workItemId: "inferred-item" },
      { ...platform.subject, association: "associated" },
      { kind: "platform_job", jobId: job.jobId },
      { ...waiting.subject, association: "unassociated_legacy" },
    ])
      expect(Value.Check(SchedulingDiagnosticSubjectSchema, invalid)).toBe(false);
  });

  it("requires the complete repository and request identity rather than an inferred Job ID", () => {
    for (const field of ["repositoryId", "workItemId", "reviewRunId", "requestId"]) {
      const subject: Record<string, unknown> = { ...requestSubject };
      delete subject[field];
      expect(Value.Check(SchedulingDiagnosticSubjectSchema, subject)).toBe(false);
    }
    expect(
      Value.Check(SchedulingDiagnosticSubjectSchema, { ...requestSubject, jobId: job.jobId }),
    ).toBe(false);
    expect(
      getSchedulingDiagnosticsIssues({ ...waiting, job: { ...job, jobId: "different-job" } }),
    ).toContain("job_identity_mismatch");
    expect(
      getSchedulingDiagnosticsIssues({ ...platform, job: { ...job, jobId: "different-job" } }),
    ).toContain("job_identity_mismatch");
    expect(getSchedulingDiagnosticsIssues({ ...waiting, job: null })).toContain(
      "missing_job_identity",
    );
  });

  it("keeps P0 observations separate from admission, limits, ordering and start guarantees", () => {
    for (const [field, value] of [
      ["admission", "admitted"],
      ["limits", { maxQueuedJobs: null }],
      ["repositoryPolicyVersion", 1],
      ["platformPolicyVersion", 1],
      ["fairness", "repository-service-v1"],
      ["eligible", true],
      ["queuePosition", 1],
      ["reserved", true],
      ["estimatedStartAt", after],
      ["retryAfterMs", 5_000],
    ])
      expect(
        Value.Check(SchedulingDiagnosticsV1Schema, { ...waiting, [String(field)]: value }),
      ).toBe(false);
    expect(
      Value.Check(SchedulingDiagnosticsV1Schema, {
        ...waiting,
        schemaVersion: "SchedulingDiagnosticsV2",
      }),
    ).toBe(false);
  });

  it("preserves V1 subjects while current aliases identify V3", () => {
    expect(SchedulingDiagnosticsSchema).toBe(SchedulingDiagnosticsV3Schema);
    expectTypeOf<SchedulingDiagnostics>().toEqualTypeOf<SchedulingDiagnosticsV3>();
    const inspect = (value: SchedulingDiagnosticsV1) => {
      if (value.subject.kind === "validation_request") {
        expectTypeOf(value.subject.reviewRunId).toEqualTypeOf<string>();
        expectTypeOf(value.subject.requestId).toEqualTypeOf<string>();
        // @ts-expect-error A request can have no Job; its current Job is a separate snapshot.
        void value.subject.jobId;
      } else if (value.subject.kind === "platform_job") {
        expectTypeOf(value.subject.association).toEqualTypeOf<"unassociated_legacy">();
        // @ts-expect-error Unassociated Legacy visibility does not imply repository ownership.
        void value.subject.repositoryId;
      }
    };
    inspect(waiting);
    inspect(noJob);
    inspect(platform);
  });
});

describe("typed current scheduling reasons", () => {
  it.each([
    "repository_paused",
    "no_registered_worker",
    "no_compatible_worker",
    "compatible_worker_unavailable",
    "worker_slots_occupied",
  ])("supports %s for the current enforcement path", (code) => {
    for (const effect of ["claim_gate", "current_prerequisite"])
      expect(Value.Check(SchedulingDiagnosticReasonSchema, { code, effect })).toBe(true);
    expect(Value.Check(SchedulingDiagnosticReasonSchema, { code, effect: "observation" })).toBe(
      false,
    );
  });

  it.each([
    "concurrency_busy",
    "affinity_worker_unavailable",
    "attempt_limit_reached",
    "current_attempt_attached",
    "invalid_job_configuration",
  ])("records %s without revealing a holder, node, or prior attempt", (code) => {
    const reason = { code, effect: "claim_gate" };
    expect(Value.Check(SchedulingDiagnosticReasonSchema, reason)).toBe(true);
    for (const field of ["holderJobId", "workerNodeId", "runAttemptId", "repositoryId", "message"])
      expect(Value.Check(SchedulingDiagnosticReasonSchema, { ...reason, [field]: "foreign" })).toBe(
        false,
      );
  });

  it.each(["authorization_changed", "source_obsolete"])(
    "does not promote %s into an existing claim gate",
    (code) => {
      expect(
        Value.Check(SchedulingDiagnosticReasonSchema, { code, effect: "current_prerequisite" }),
      ).toBe(true);
      expect(Value.Check(SchedulingDiagnosticReasonSchema, { code, effect: "claim_gate" })).toBe(
        false,
      );
    },
  );

  it.each(["worker_capacity_unavailable", "inspection_incomplete"])(
    "labels %s as an observation without asserting a fresh claim ran",
    (code) => {
      expect(Value.Check(SchedulingDiagnosticReasonSchema, { code, effect: "observation" })).toBe(
        true,
      );
      expect(Value.Check(SchedulingDiagnosticReasonSchema, { code, effect: "claim_gate" })).toBe(
        false,
      );
    },
  );

  it("allows a bounded own prerequisite name without private profile content", () => {
    const reason = { code: "plan_prerequisite_missing", effect: "current_prerequisite" };
    expect(Value.Check(SchedulingDiagnosticReasonSchema, reason)).toBe(true);
    expect(
      Value.Check(SchedulingDiagnosticReasonSchema, { ...reason, requirement: "prompt" }),
    ).toBe(true);
    for (const requirement of ["", "repo/other", "software.codex\n", "x".repeat(129)])
      expect(Value.Check(SchedulingDiagnosticReasonSchema, { ...reason, requirement })).toBe(false);
  });

  it("never applies a Job claim gate to a request that has no Job", () => {
    expect(
      getSchedulingDiagnosticsIssues({
        ...noJob,
        reasons: [{ code: "repository_paused", effect: "claim_gate" }],
      }),
    ).toContain("claim_gate_without_job");
    expect(
      getSchedulingDiagnosticsIssues({
        ...noJob,
        reasons: [{ code: "repository_paused", effect: "current_prerequisite" }],
      }),
    ).toEqual([]);
  });

  it.each([
    "repository_paused",
    "no_registered_worker",
    "no_compatible_worker",
    "compatible_worker_unavailable",
    "worker_slots_occupied",
  ] as const)("keeps the %s effect consistent with the presence of an actual Job", (code) => {
    expect(
      getSchedulingDiagnosticsIssues({
        ...waiting,
        reasons: [{ code, effect: "current_prerequisite" }],
      }),
    ).toContain("reason_effect_mismatch");
    expect(
      getSchedulingDiagnosticsIssues({
        ...noJob,
        workerInspection: waiting.workerInspection,
        reasons: [{ code, effect: "current_prerequisite" }],
      }),
    ).toEqual([]);
    expect(
      getSchedulingDiagnosticsIssues({
        ...waiting,
        reasons: [
          { code, effect: "claim_gate" },
          { code, effect: "current_prerequisite" },
        ],
      }),
    ).toContain("duplicate_reason");
  });

  it.each([
    "awaiting_admission",
    "repository_queue_limit",
    "platform_active_limit",
    "missing_credentials",
    "desktop_locked",
    "unlimited",
  ])("rejects the unimplemented or unobserved reason %s", (code) => {
    expect(Value.Check(SchedulingDiagnosticReasonSchema, { code, effect: "claim_gate" })).toBe(
      false,
    );
  });
});

describe("honest Worker inventory observations", () => {
  const partial: SchedulingDiagnosticsV1 = {
    ...waiting,
    workerInspection: { state: "partial", latestContactAt: before },
    reasons: [{ code: "inspection_incomplete", effect: "observation" }],
  };

  it("represents a partial scan without global inventory counts", () => {
    expect(Value.Check(SchedulingDiagnosticsV1Schema, partial)).toBe(true);
    expect(getSchedulingDiagnosticsIssues(partial)).toEqual([]);
    for (const field of [
      "scannedCount",
      "registeredCount",
      "totalCount",
      "workerIds",
      "globalActiveLeases",
    ])
      expect(
        Value.Check(SchedulingWorkerInspectionSchema, { ...partial.workerInspection, [field]: 1 }),
      ).toBe(false);
  });

  it.each([
    "no_registered_worker",
    "no_compatible_worker",
    "compatible_worker_unavailable",
    "worker_slots_occupied",
  ] as const)("does not infer %s from only a partial inventory", (code) => {
    expect(
      getSchedulingDiagnosticsIssues({
        ...partial,
        reasons: [...partial.reasons, { code, effect: "claim_gate" }],
      }),
    ).toContain("unproved_worker_absence");
    expect(
      getSchedulingDiagnosticsIssues({ ...waiting, reasons: [{ code, effect: "claim_gate" }] }),
    ).toEqual([]);
  });

  it("allows independently proved per-Job gates alongside a partial scan", () => {
    expect(
      getSchedulingDiagnosticsIssues({
        ...partial,
        reasons: [
          { code: "repository_paused", effect: "claim_gate" },
          { code: "concurrency_busy", effect: "claim_gate" },
          { code: "affinity_worker_unavailable", effect: "claim_gate" },
          ...partial.reasons,
        ],
      }),
    ).toEqual([]);
  });

  it("requires the partial-scan reason to agree with the inspection state", () => {
    expect(getSchedulingDiagnosticsIssues({ ...partial, reasons: [] })).toContain(
      "inspection_completeness_mismatch",
    );
    expect(getSchedulingDiagnosticsIssues({ ...waiting, reasons: partial.reasons })).toContain(
      "inspection_completeness_mismatch",
    );
  });

  it("keeps last contact distinct from heartbeat or capacity-report age", () => {
    expect(
      Value.Check(SchedulingWorkerInspectionSchema, { state: "complete", latestContactAt: null }),
    ).toBe(true);
    for (const field of [
      "latestHeartbeatAt",
      "heartbeatAgeMs",
      "capacityObservedAt",
      "lockedDesktop",
    ])
      expect(
        Value.Check(SchedulingWorkerInspectionSchema, {
          ...waiting.workerInspection,
          [field]: before,
        }),
      ).toBe(false);
    expect(
      getSchedulingDiagnosticsIssues({
        ...waiting,
        workerInspection: { state: "complete", latestContactAt: after },
      }),
    ).toEqual([]);
    expect(
      getSchedulingDiagnosticsIssues({
        ...noJob,
        workerInspection: { state: "not_applicable", latestContactAt: before },
      }),
    ).toContain("invalid_worker_contact_time");
  });

  it("requires an inspected Worker before reporting its committed capacity or affinity state", () => {
    for (const reason of [
      { code: "worker_capacity_unavailable", effect: "observation" },
      { code: "affinity_worker_unavailable", effect: "claim_gate" },
    ] as const) {
      expect(
        getSchedulingDiagnosticsIssues({
          ...waiting,
          workerInspection: { state: "not_applicable", latestContactAt: null },
          reasons: [reason],
        }),
      ).toContain("worker_reason_without_inspection");
    }
  });

  it("rejects contradictory absence and observed compatible Worker reasons", () => {
    for (const absent of ["no_registered_worker", "no_compatible_worker"] as const) {
      for (const present of ["compatible_worker_unavailable", "worker_slots_occupied"] as const) {
        expect(
          getSchedulingDiagnosticsIssues({
            ...waiting,
            reasons: [
              { code: absent, effect: "claim_gate" },
              { code: present, effect: "claim_gate" },
            ],
          }),
        ).toContain("contradictory_worker_observation");
      }
      expect(
        getSchedulingDiagnosticsIssues({
          ...waiting,
          reasons: [
            { code: absent, effect: "claim_gate" },
            { code: "worker_capacity_unavailable", effect: "observation" },
          ],
        }),
      ).toContain("contradictory_worker_observation");
    }
    expect(
      getSchedulingDiagnosticsIssues({
        ...waiting,
        reasons: [
          { code: "worker_slots_occupied", effect: "claim_gate" },
          { code: "compatible_worker_unavailable", effect: "claim_gate" },
        ],
      }),
    ).toEqual([]);
  });
});

describe("execution stage and canonical scheduling times", () => {
  it.each(["queued", "retry_waiting"] as const)("keeps %s in waiting", (status) => {
    expect(getSchedulingDiagnosticsIssues({ ...waiting, job: { ...job, status } })).toEqual([]);
    expect(
      getSchedulingDiagnosticsIssues({ ...waiting, stage: "executing", job: { ...job, status } }),
    ).toContain("job_stage_mismatch");
  });

  it.each([
    ["leased", "executing"],
    ["running", "executing"],
    ["cancel_requested", "executing"],
    ["stale", "terminal"],
    ["succeeded", "terminal"],
    ["failed", "terminal"],
    ["dead_letter", "terminal"],
    ["cancelled", "terminal"],
  ] as const)("reports %s as %s without a new waiting diagnosis", (status, stage) => {
    const value: SchedulingDiagnosticsV1 = {
      ...waiting,
      stage,
      job: { ...job, status, attemptCount: 1, nextAttemptAt: null },
      workerInspection: { state: "not_applicable", latestContactAt: null },
    };
    expect(Value.Check(SchedulingDiagnosticsV1Schema, value)).toBe(true);
    expect(getSchedulingDiagnosticsIssues(value)).toEqual([]);
    expect(
      getSchedulingDiagnosticsIssues({ ...value, workerInspection: waiting.workerInspection }),
    ).toContain("inspection_outside_waiting");
    expect(
      getSchedulingDiagnosticsIssues({
        ...value,
        reasons: [{ code: "attempt_limit_reached", effect: "claim_gate" }],
      }),
    ).toContain("reasons_outside_waiting");
    expect(
      getSchedulingDiagnosticsIssues({
        ...value,
        job: { ...job, status, attemptCount: 1, nextAttemptAt: after },
      }),
    ).toContain("retry_time_outside_waiting");
  });

  it("binds a retry backoff to the exact stored future eligibility time", () => {
    const value: SchedulingDiagnosticsV1 = {
      ...waiting,
      job: { ...job, status: "retry_waiting", attemptCount: 1, nextAttemptAt: after },
      reasons: [{ code: "retry_backoff", effect: "claim_gate", until: after }],
    };
    expect(Value.Check(SchedulingDiagnosticsV1Schema, value)).toBe(true);
    expect(getSchedulingDiagnosticsIssues(value)).toEqual([]);
    for (const until of [before, observedAt, "2026-09-07T10:02:00.000Z", "2026-09-07T10:01:00Z"])
      expect(
        getSchedulingDiagnosticsIssues({
          ...value,
          reasons: [{ code: "retry_backoff", effect: "claim_gate", until }],
        }),
      ).toContain("invalid_backoff_observation");
    expect(
      Value.Check(SchedulingDiagnosticReasonSchema, {
        code: "retry_backoff",
        effect: "claim_gate",
      }),
    ).toBe(false);
    expect(
      Value.Check(SchedulingDiagnosticReasonSchema, {
        code: "concurrency_busy",
        effect: "claim_gate",
        until: after,
      }),
    ).toBe(false);
  });

  it.each([
    "2026-09-07T10:00:00Z",
    "2026-09-07T18:00:00.000+08:00",
    "not-a-time",
    "2026-02-30T10:00:00.000Z",
  ])("rejects a noncanonical observation time %s", (time) => {
    expect(getSchedulingDiagnosticsIssues({ ...waiting, observedAt: time })).toContain(
      "invalid_observation_time",
    );
  });

  it("preserves canonical persisted times through clock rollback without clamping them", () => {
    expect(
      getSchedulingDiagnosticsIssues({ ...waiting, job: { ...job, createdAt: after } }),
    ).toEqual([]);
    expect(
      getSchedulingDiagnosticsIssues({
        ...waiting,
        job: { ...job, createdAt: "2026-09-07T10:00:00Z" },
      }),
    ).toContain("invalid_job_creation_time");
    expect(
      getSchedulingDiagnosticsIssues({
        ...waiting,
        job: { ...job, nextAttemptAt: "2026-09-07T10:00:00Z" },
      }),
    ).toContain("invalid_retry_time");
    expect(
      getSchedulingDiagnosticsIssues({
        ...waiting,
        workerInspection: { state: "complete", latestContactAt: "2026-09-07T09:59:00Z" },
      }),
    ).toContain("invalid_worker_contact_time");
  });
});

describe("bounded and private scheduling observations", () => {
  it("bounds own requirement names independently from the reason count", () => {
    const names = Array.from({ length: 64 }, (_, index) => `labels.requirement-${index}`);
    const requirements = { names, truncated: true };
    expect(Value.Check(SchedulingDiagnosticRequirementsSchema, requirements)).toBe(true);
    expect(getSchedulingDiagnosticsIssues({ ...waiting, requirements })).toEqual([]);
    expect(
      Value.Check(SchedulingDiagnosticRequirementsSchema, {
        ...requirements,
        names: [...names, "software.extra"],
      }),
    ).toBe(false);
    expect(
      Value.Check(SchedulingDiagnosticRequirementsSchema, {
        ...requirements,
        names: ["software.codex", "software.codex"],
      }),
    ).toBe(false);
    expect(
      getSchedulingDiagnosticsIssues({ ...waiting, requirements: { names: [], truncated: true } }),
    ).toEqual([]);
    expect(
      getSchedulingDiagnosticsIssues({
        ...waiting,
        requirements: { names: ["software.codex"], truncated: true },
      }),
    ).toEqual([]);
    expect(Value.Check(SchedulingRequirementNameSchema, "n".repeat(128))).toBe(true);
    for (const name of [
      "",
      "n".repeat(129),
      "label=value",
      "C:\\private",
      "secret/name",
      "node\n",
      "name\u0000",
      "cap name",
    ])
      expect(Value.Check(SchedulingRequirementNameSchema, name)).toBe(false);
  });

  it("requires explicit truncation without extending a response past 32 reasons", () => {
    const reasons: SchedulingDiagnosticReason[] = Array.from({ length: 32 }, (_, index) => ({
      code: "plan_prerequisite_missing",
      effect: "current_prerequisite",
      requirement: `requirement-${index}`,
    }));
    const value = { ...noJob, reasons, reasonsTruncated: true };
    expect(Value.Check(SchedulingDiagnosticsV1Schema, value)).toBe(true);
    expect(getSchedulingDiagnosticsIssues(value)).toEqual([]);
    expect(
      Value.Check(SchedulingDiagnosticsV1Schema, {
        ...value,
        reasons: [...reasons, { code: "source_obsolete", effect: "current_prerequisite" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(SchedulingDiagnosticsV1Schema, {
        ...noJob,
        reasons: [...noJob.reasons, ...noJob.reasons],
      }),
    ).toBe(false);
    expect(getSchedulingDiagnosticsIssues({ ...noJob, reasonsTruncated: true })).toContain(
      "invalid_reason_truncation",
    );
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, "0", null])(
    "rejects invalid own attempt counts %j",
    (attemptCount) => {
      expect(
        Value.Check(SchedulingDiagnosticsV1Schema, { ...waiting, job: { ...job, attemptCount } }),
      ).toBe(false);
    },
  );

  it("rejects raw capability, foreign identity and global capacity fields at each boundary", () => {
    const targets: [TSchema, object][] = [
      [SchedulingDiagnosticsV1Schema, waiting],
      [SchedulingDiagnosticSubjectSchema, waiting.subject],
      [SchedulingWorkerInspectionSchema, waiting.workerInspection],
      [SchedulingDiagnosticRequirementsSchema, waiting.requirements],
      [
        SchedulingDiagnosticReasonSchema,
        { code: "plan_prerequisite_missing", effect: "current_prerequisite" },
      ],
    ];
    for (const [schema, value] of targets)
      for (const field of [
        "workerId",
        "workerNodeId",
        "capabilities",
        "template",
        "globalUsage",
        "credential",
        "foreignRepositoryId",
      ])
        expect(Value.Check(schema, { ...value, [field]: "private" })).toBe(false);
  });

  it("exports explicit transport and shape budgets", () => {
    expect(maximumSchedulingDiagnosticsResponseUtf8Bytes).toBe(64 * 1024);
    expect(maximumSchedulingDiagnosticReasonCount).toBe(32);
    expect(maximumSchedulingDiagnosticRequirementCount).toBe(64);
    expect(maximumSchedulingDiagnosticRequirementNameLength).toBe(128);
  });
});
