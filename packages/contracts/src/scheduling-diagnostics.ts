import { type Static, Type } from "@sinclair/typebox";
import {
  DateTimeSchema,
  EntityIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "./common.js";
import { getJobAdmissionIssues, NullableJobAdmissionSchema } from "./job-admission.js";
import { SchedulingLimitsSchema } from "./platform-configuration.js";
import {
  getSchedulingCapacity,
  getSchedulingPlatformCapacityIssues,
  getSchedulingStatusIssues,
  SchedulingOverageSchema,
  SchedulingPlatformCapacitySchema,
  SchedulingUsageSchema,
} from "./scheduling-policy.js";
import { JobStateSchema } from "./states.js";

export const maximumSchedulingDiagnosticReasonCount = 32;
export const maximumSchedulingDiagnosticRequirementCount = 64;
export const maximumSchedulingDiagnosticRequirementNameLength = 128;
export const maximumSchedulingDiagnosticsResponseUtf8Bytes = 64 * 1024;

export const SchedulingRequirementNameSchema = Type.String({
  minLength: 1,
  maxLength: maximumSchedulingDiagnosticRequirementNameLength,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:+-]*(?![\\s\\S])",
});
export type SchedulingRequirementName = Static<typeof SchedulingRequirementNameSchema>;

export const SchedulingDiagnosticReasonEffectV1Schema = Type.Union([
  Type.Literal("claim_gate"),
  Type.Literal("current_prerequisite"),
  Type.Literal("observation"),
]);
export const SchedulingDiagnosticReasonEffectV2Schema = SchedulingDiagnosticReasonEffectV1Schema;
export const SchedulingDiagnosticReasonEffectV3Schema = Type.Union([
  ...SchedulingDiagnosticReasonEffectV2Schema.anyOf,
  Type.Literal("admission_gate"),
]);
export const SchedulingDiagnosticReasonEffectSchema = SchedulingDiagnosticReasonEffectV3Schema;
export type SchedulingDiagnosticReasonEffect = Static<
  typeof SchedulingDiagnosticReasonEffectSchema
>;

const gateOrPrerequisiteSchema = Type.Union([
  Type.Literal("claim_gate"),
  Type.Literal("current_prerequisite"),
]);

// A reason's effect describes the existing enforcement path, not a promise that a claim ran.
export const SchedulingDiagnosticReasonV1Schema = Type.Union([
  Type.Object(
    {
      code: Type.Union([
        Type.Literal("repository_paused"),
        Type.Literal("no_registered_worker"),
        Type.Literal("no_compatible_worker"),
        Type.Literal("compatible_worker_unavailable"),
        Type.Literal("worker_slots_occupied"),
      ]),
      effect: gateOrPrerequisiteSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      code: Type.Literal("retry_backoff"),
      effect: Type.Literal("claim_gate"),
      until: DateTimeSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      code: Type.Union([
        Type.Literal("concurrency_busy"),
        Type.Literal("affinity_worker_unavailable"),
        Type.Literal("attempt_limit_reached"),
        Type.Literal("current_attempt_attached"),
        Type.Literal("invalid_job_configuration"),
      ]),
      effect: Type.Literal("claim_gate"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      code: Type.Literal("plan_prerequisite_missing"),
      effect: Type.Literal("current_prerequisite"),
      requirement: Type.Optional(SchedulingRequirementNameSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      code: Type.Union([Type.Literal("authorization_changed"), Type.Literal("source_obsolete")]),
      effect: Type.Literal("current_prerequisite"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      code: Type.Union([
        Type.Literal("worker_capacity_unavailable"),
        Type.Literal("inspection_incomplete"),
      ]),
      // Persisted available_slots does not replace the fresh value supplied by the next claim.
      effect: Type.Literal("observation"),
    },
    { additionalProperties: false },
  ),
]);
export type SchedulingDiagnosticReasonV1 = Static<typeof SchedulingDiagnosticReasonV1Schema>;

export const SchedulingDiagnosticReasonV2Schema = Type.Union([
  ...SchedulingDiagnosticReasonV1Schema.anyOf,
  Type.Object(
    { code: Type.Literal("awaiting_admission"), effect: Type.Literal("claim_gate") },
    { additionalProperties: false },
  ),
]);
export type SchedulingDiagnosticReasonV2 = Static<typeof SchedulingDiagnosticReasonV2Schema>;

export const SchedulingDiagnosticReasonV3Schema = Type.Union([
  ...SchedulingDiagnosticReasonV2Schema.anyOf,
  Type.Object(
    {
      code: Type.Union([
        Type.Literal("repository_queue_limit"),
        Type.Literal("platform_queue_limit"),
      ]),
      effect: Type.Literal("admission_gate"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      code: Type.Union([
        Type.Literal("repository_active_limit"),
        Type.Literal("platform_active_limit"),
      ]),
      effect: Type.Literal("claim_gate"),
    },
    { additionalProperties: false },
  ),
]);
export type SchedulingDiagnosticReasonV3 = Static<typeof SchedulingDiagnosticReasonV3Schema>;
export const SchedulingDiagnosticReasonSchema = SchedulingDiagnosticReasonV3Schema;
export type SchedulingDiagnosticReason = SchedulingDiagnosticReasonV3;

export const SchedulingDiagnosticSubjectSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("repository_job"),
      repositoryId: EntityIdSchema,
      workItemId: EntityIdSchema,
      jobId: EntityIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("validation_request"),
      repositoryId: EntityIdSchema,
      workItemId: EntityIdSchema,
      reviewRunId: EntityIdSchema,
      requestId: EntityIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("platform_job"),
      jobId: EntityIdSchema,
      association: Type.Literal("unassociated_legacy"),
    },
    { additionalProperties: false },
  ),
]);
export type SchedulingDiagnosticSubject = Static<typeof SchedulingDiagnosticSubjectSchema>;

export const SchedulingDiagnosticJobV1Schema = Type.Object(
  {
    jobId: EntityIdSchema,
    status: JobStateSchema,
    attemptCount: NonNegativeIntegerSchema,
    createdAt: DateTimeSchema,
    // This is the stored retry eligibility time, not an expected execution start.
    nextAttemptAt: Type.Union([DateTimeSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type SchedulingDiagnosticJobV1 = Static<typeof SchedulingDiagnosticJobV1Schema>;

export const SchedulingDiagnosticJobV2Schema = Type.Object(
  { ...SchedulingDiagnosticJobV1Schema.properties, admission: NullableJobAdmissionSchema },
  { additionalProperties: false },
);
export type SchedulingDiagnosticJobV2 = Static<typeof SchedulingDiagnosticJobV2Schema>;
export const SchedulingDiagnosticJobV3Schema = SchedulingDiagnosticJobV2Schema;
export type SchedulingDiagnosticJobV3 = Static<typeof SchedulingDiagnosticJobV3Schema>;
export const SchedulingDiagnosticJobSchema = SchedulingDiagnosticJobV3Schema;
export type SchedulingDiagnosticJob = SchedulingDiagnosticJobV3;

export const SchedulingWorkerInspectionSchema = Type.Object(
  {
    state: Type.Union([
      Type.Literal("complete"),
      Type.Literal("partial"),
      Type.Literal("not_applicable"),
    ]),
    // Latest committed last_seen_at in the inspected relevant inventory. Registration, claims,
    // and lease activity update this too; it cannot establish the age of a capacity report.
    latestContactAt: Type.Union([DateTimeSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type SchedulingWorkerInspection = Static<typeof SchedulingWorkerInspectionSchema>;

export const SchedulingDiagnosticRequirementsSchema = Type.Object(
  {
    // Only names extracted from this subject's own immutable requirements are permitted.
    names: Type.Array(SchedulingRequirementNameSchema, {
      maxItems: maximumSchedulingDiagnosticRequirementCount,
      uniqueItems: true,
    }),
    // Names may be omitted by the projection budget or because a valid Legacy requirement
    // cannot be represented by this public identifier format. Do not manufacture a replacement.
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SchedulingDiagnosticRequirements = Static<
  typeof SchedulingDiagnosticRequirementsSchema
>;

// V1 is a read-only observation of existing waiting gates. Admission, configured limits,
// fairness, reservations, and scheduling estimates are deliberately absent from this version.
export const SchedulingDiagnosticsV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("SchedulingDiagnosticsV1"),
    observedAt: DateTimeSchema,
    subject: SchedulingDiagnosticSubjectSchema,
    stage: Type.Union([
      Type.Literal("waiting"),
      Type.Literal("executing"),
      Type.Literal("terminal"),
    ]),
    job: Type.Union([SchedulingDiagnosticJobV1Schema, Type.Null()]),
    workerInspection: SchedulingWorkerInspectionSchema,
    requirements: SchedulingDiagnosticRequirementsSchema,
    reasons: Type.Array(SchedulingDiagnosticReasonV1Schema, {
      maxItems: maximumSchedulingDiagnosticReasonCount,
      uniqueItems: true,
    }),
    reasonsTruncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SchedulingDiagnosticsV1 = Static<typeof SchedulingDiagnosticsV1Schema>;

// V2 observes a real Job's current admission episode. Configured limits, service ordering,
// reservations, and scheduling estimates remain outside this foundation contract.
export const SchedulingDiagnosticsV2Schema = Type.Object(
  {
    ...SchedulingDiagnosticsV1Schema.properties,
    schemaVersion: Type.Literal("SchedulingDiagnosticsV2"),
    job: Type.Union([SchedulingDiagnosticJobV2Schema, Type.Null()]),
    reasons: Type.Array(SchedulingDiagnosticReasonV2Schema, {
      maxItems: maximumSchedulingDiagnosticReasonCount,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type SchedulingDiagnosticsV2 = Static<typeof SchedulingDiagnosticsV2Schema>;

export const SchedulingDiagnosticRepositoryPolicySchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    version: PositiveIntegerSchema,
    enabled: Type.Boolean(),
    limits: SchedulingLimitsSchema,
    usage: SchedulingUsageSchema,
    overage: SchedulingOverageSchema,
  },
  { additionalProperties: false },
);
export type SchedulingDiagnosticRepositoryPolicy = Static<
  typeof SchedulingDiagnosticRepositoryPolicySchema
>;

export const SchedulingDiagnosticPolicySchema = Type.Object(
  {
    // Null is permitted only for a platform-only Legacy Job with no managed repository policy.
    repository: Type.Union([SchedulingDiagnosticRepositoryPolicySchema, Type.Null()]),
    platform: SchedulingPlatformCapacitySchema,
  },
  { additionalProperties: false },
);
export type SchedulingDiagnosticPolicy = Static<typeof SchedulingDiagnosticPolicySchema>;

// V3 reads current policy and exact usage in the authorized observation snapshot. These fields
// never reserve capacity and never alter the frozen plan, execution template, or old diagnostics.
export const SchedulingDiagnosticsV3Schema = Type.Object(
  {
    ...SchedulingDiagnosticsV2Schema.properties,
    schemaVersion: Type.Literal("SchedulingDiagnosticsV3"),
    policy: SchedulingDiagnosticPolicySchema,
    reasons: Type.Array(SchedulingDiagnosticReasonV3Schema, {
      maxItems: maximumSchedulingDiagnosticReasonCount,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type SchedulingDiagnosticsV3 = Static<typeof SchedulingDiagnosticsV3Schema>;
export const SchedulingDiagnosticsSchema = SchedulingDiagnosticsV3Schema;
export type SchedulingDiagnostics = Static<typeof SchedulingDiagnosticsSchema>;

export function getSchedulingLimitReasons(
  policy: SchedulingDiagnosticPolicy,
  job: SchedulingDiagnosticJob | null,
  stage: SchedulingDiagnostics["stage"],
): SchedulingDiagnosticReasonV3[] {
  if (job === null || stage !== "waiting") return [];
  const repository =
    policy.repository === null
      ? null
      : getSchedulingCapacity(policy.repository.limits, policy.repository.usage);
  const platform =
    policy.platform.visibility === "restricted"
      ? policy.platform
      : getSchedulingCapacity(policy.platform.configuration.limits, policy.platform.usage);
  const reasons: SchedulingDiagnosticReasonV3[] = [];
  if (job.admission?.state === "pending") {
    if (repository?.queueCapacity === "limited")
      reasons.push({ code: "repository_queue_limit", effect: "admission_gate" });
    if (platform.queueCapacity === "limited")
      reasons.push({ code: "platform_queue_limit", effect: "admission_gate" });
  }
  if (repository?.activeCapacity === "limited")
    reasons.push({ code: "repository_active_limit", effect: "claim_gate" });
  if (platform.activeCapacity === "limited")
    reasons.push({ code: "platform_active_limit", effect: "claim_gate" });
  return reasons;
}

const schedulingLimitReasonCodes = new Set([
  "repository_queue_limit",
  "platform_queue_limit",
  "repository_active_limit",
  "platform_active_limit",
]);

function getDiagnosticPolicyIssues(value: SchedulingDiagnosticsV3): string[] {
  const issues: string[] = [];
  const repository = value.policy.repository;
  const platform = value.policy.platform;
  if (value.subject.kind !== "platform_job") {
    if (repository === null || repository.repositoryId !== value.subject.repositoryId)
      issues.push("repository_policy_identity_mismatch");
  } else if (platform.visibility !== "full") {
    issues.push("platform_job_policy_restricted");
  }
  if (repository !== null) {
    issues.push(
      ...getSchedulingStatusIssues({
        repositoryId: repository.repositoryId,
        repositoryVersion: repository.version,
        enabled: repository.enabled,
        observedAt: value.observedAt,
        limits: repository.limits,
        usage: repository.usage,
        overage: repository.overage,
        platform,
      }),
    );
  } else if (platform.visibility === "full") {
    issues.push(...getSchedulingPlatformCapacityIssues(platform));
  }
  const expected = new Set(
    getSchedulingLimitReasons(value.policy, value.job, value.stage).map((reason) => reason.code),
  );
  const actual = new Set(
    value.reasons
      .filter((reason) => schedulingLimitReasonCodes.has(reason.code))
      .map((reason) => reason.code),
  );
  if (
    [...actual].some((code) => !expected.has(code)) ||
    (!value.reasonsTruncated && [...expected].some((code) => !actual.has(code)))
  )
    issues.push("limit_reason_mismatch");
  return issues;
}

function canonicalTimestamp(value: string): boolean {
  const time = new Date(value);
  return Number.isFinite(time.valueOf()) && time.toISOString() === value;
}

const completeInspectionReasons: ReadonlySet<SchedulingDiagnosticReason["code"]> = new Set([
  "no_registered_worker",
  "no_compatible_worker",
  "compatible_worker_unavailable",
  "worker_slots_occupied",
]);
const contextualGateReasons: ReadonlySet<SchedulingDiagnosticReason["code"]> = new Set([
  "repository_paused",
  ...completeInspectionReasons,
]);
const workerObservationReasons: ReadonlySet<SchedulingDiagnosticReason["code"]> = new Set([
  ...completeInspectionReasons,
  "affinity_worker_unavailable",
  "worker_capacity_unavailable",
]);

// Call after schema validation. These checks cannot prove database ownership, requirement
// provenance, or inventory completeness; the authorized reader must establish those facts.
export function getSchedulingDiagnosticsIssues(
  value: SchedulingDiagnosticsV1 | SchedulingDiagnosticsV2 | SchedulingDiagnosticsV3,
): string[] {
  const issues: string[] = [];
  const add = (issue: string) => {
    if (!issues.includes(issue)) issues.push(issue);
  };
  if (!canonicalTimestamp(value.observedAt)) add("invalid_observation_time");
  if (value.schemaVersion !== "SchedulingDiagnosticsV1") {
    if (value.job !== null) {
      for (const issue of getJobAdmissionIssues(value.job)) add(issue);
    }
    const awaitingAdmission = value.job?.admission?.state === "pending";
    if (awaitingAdmission !== value.reasons.some((reason) => reason.code === "awaiting_admission"))
      add("admission_reason_mismatch");
  }
  if (value.schemaVersion === "SchedulingDiagnosticsV3") {
    for (const issue of getDiagnosticPolicyIssues(value)) add(issue);
  }
  const job = value.job;
  if (job === null) {
    if (value.subject.kind !== "validation_request" || value.stage !== "waiting")
      add("missing_job_identity");
    if (value.reasons.some((reason) => reason.effect === "claim_gate"))
      add("claim_gate_without_job");
    if (value.reasons.some((reason) => reason.effect === "admission_gate"))
      add("admission_gate_without_job");
  } else {
    if (value.subject.kind !== "validation_request" && value.subject.jobId !== job.jobId)
      add("job_identity_mismatch");
    const stage =
      job.status === "queued" || job.status === "retry_waiting"
        ? "waiting"
        : job.status === "leased" || job.status === "running" || job.status === "cancel_requested"
          ? "executing"
          : "terminal";
    if (value.stage !== stage) add("job_stage_mismatch");
    if (!canonicalTimestamp(job.createdAt)) add("invalid_job_creation_time");
    if (job.nextAttemptAt !== null && !canonicalTimestamp(job.nextAttemptAt))
      add("invalid_retry_time");
    if (value.stage !== "waiting" && job.nextAttemptAt !== null) add("retry_time_outside_waiting");
  }
  if (value.stage !== "waiting") {
    if (value.workerInspection.state !== "not_applicable") add("inspection_outside_waiting");
    if (value.reasons.length > 0 || value.reasonsTruncated) add("reasons_outside_waiting");
  }
  if (
    value.workerInspection.latestContactAt !== null &&
    (!canonicalTimestamp(value.workerInspection.latestContactAt) ||
      value.workerInspection.state === "not_applicable")
  )
    add("invalid_worker_contact_time");
  const partial = value.workerInspection.state === "partial";
  if (partial !== value.reasons.some((reason) => reason.code === "inspection_incomplete"))
    add("inspection_completeness_mismatch");
  if (
    value.workerInspection.state !== "complete" &&
    value.reasons.some((reason) => completeInspectionReasons.has(reason.code))
  )
    add("unproved_worker_absence");
  if (
    value.workerInspection.state === "not_applicable" &&
    value.reasons.some((reason) => workerObservationReasons.has(reason.code))
  )
    add("worker_reason_without_inspection");
  const reasonCodes = new Set(value.reasons.map((reason) => reason.code));
  const compatibleWorkerObserved =
    reasonCodes.has("compatible_worker_unavailable") ||
    reasonCodes.has("worker_slots_occupied") ||
    reasonCodes.has("worker_capacity_unavailable");
  if (
    (reasonCodes.has("no_registered_worker") &&
      (reasonCodes.has("no_compatible_worker") || compatibleWorkerObserved)) ||
    (reasonCodes.has("no_compatible_worker") && compatibleWorkerObserved)
  )
    add("contradictory_worker_observation");
  if (value.reasonsTruncated && value.reasons.length !== maximumSchedulingDiagnosticReasonCount)
    add("invalid_reason_truncation");
  const reasonIdentities = new Set<string>();
  for (const reason of value.reasons) {
    const identity =
      reason.code === "plan_prerequisite_missing"
        ? `${reason.code}:${reason.requirement ?? ""}`
        : reason.code;
    if (reasonIdentities.has(identity)) add("duplicate_reason");
    reasonIdentities.add(identity);
    if (
      contextualGateReasons.has(reason.code) &&
      reason.effect !== (job === null ? "current_prerequisite" : "claim_gate")
    )
      add("reason_effect_mismatch");
    if (
      reason.code === "retry_backoff" &&
      (!canonicalTimestamp(reason.until) ||
        reason.until <= value.observedAt ||
        job === null ||
        reason.until !== job.nextAttemptAt)
    )
      add("invalid_backoff_observation");
  }
  return issues;
}
