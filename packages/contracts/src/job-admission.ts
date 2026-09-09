import { type Static, Type } from "@sinclair/typebox";
import { DateTimeSchema, NonNegativeIntegerSchema } from "./common.js";
import type { JobState } from "./states.js";

export const JobAdmissionStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("admitted"),
]);
export type JobAdmissionState = Static<typeof JobAdmissionStateSchema>;

export const JobAdmissionTimestampBasisSchema = Type.Union([
  Type.Literal("recorded"),
  Type.Literal("migration_backfill"),
]);
export type JobAdmissionTimestampBasis = Static<typeof JobAdmissionTimestampBasisSchema>;

const episodeProperties = {
  // This identifies the attempt count for the current waiting episode, not an attempt grant.
  attemptBase: NonNegativeIntegerSchema,
  requestedAt: DateTimeSchema,
  // A backfill timestamp must not be presented as evidence of an original historical admission.
  timestampBasis: JobAdmissionTimestampBasisSchema,
};

export const JobAdmissionSchema = Type.Union([
  Type.Object(
    { ...episodeProperties, state: Type.Literal("pending"), admittedAt: Type.Null() },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...episodeProperties, state: Type.Literal("admitted"), admittedAt: DateTimeSchema },
    { additionalProperties: false },
  ),
]);
export type JobAdmission = Static<typeof JobAdmissionSchema>;

export const NullableJobAdmissionSchema = Type.Union([JobAdmissionSchema, Type.Null()]);

export interface JobAdmissionProjection {
  readonly status: JobState;
  readonly attemptCount: number;
  readonly admission: JobAdmission | null;
}

const canonicalTimestamp = (value: string): boolean => {
  const time = new Date(value);
  return Number.isFinite(time.valueOf()) && time.toISOString() === value;
};

// Call after schema validation. A waiting Job requires its exact current episode; an absent
// or inconsistent row is an integrity error, never an implicit admitted default. Active and
// terminal Jobs retain their persisted history but do not project it as a current queue state.
export function getJobAdmissionIssues(value: JobAdmissionProjection): string[] {
  const issues: string[] = [];
  const waiting = value.status === "queued" || value.status === "retry_waiting";
  if (value.admission === null) {
    if (waiting) issues.push("missing_waiting_admission");
    return issues;
  }
  if (!waiting) issues.push("admission_outside_waiting");
  if (waiting && value.admission.attemptBase !== value.attemptCount)
    issues.push("admission_attempt_mismatch");
  if (!canonicalTimestamp(value.admission.requestedAt))
    issues.push("invalid_admission_request_time");
  if (value.admission.admittedAt !== null && !canonicalTimestamp(value.admission.admittedAt))
    issues.push("invalid_admission_time");
  // Wall-clock rollback can occur between recorded events. Sequence and attempt identity,
  // rather than timestamp ordering, establish an episode's authority.
  return issues;
}
