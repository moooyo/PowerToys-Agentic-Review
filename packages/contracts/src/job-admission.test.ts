import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  getJobAdmissionIssues,
  type JobAdmission,
  JobAdmissionSchema,
  JobAdmissionStateSchema,
} from "./job-admission.js";
import { JobStateValues } from "./states.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const requestedAt = "2026-09-07T10:00:00.000Z";
const admittedAt = "2026-09-07T10:01:00.000Z";
const pending: JobAdmission = {
  state: "pending",
  attemptBase: 2,
  requestedAt,
  timestampBasis: "recorded",
  admittedAt: null,
};
const admitted: JobAdmission = { ...pending, state: "admitted", admittedAt };

describe("current Job admission episodes", () => {
  it.each([pending, admitted, { ...admitted, timestampBasis: "migration_backfill" }])(
    "accepts an exact $state episode with explicit timestamp provenance",
    (value) => expect(Value.Check(JobAdmissionSchema, value)).toBe(true),
  );

  it("requires every field and rejects private ordering or ownership metadata", () => {
    for (const field of Object.keys(pending)) {
      const value: Record<string, unknown> = { ...pending };
      delete value[field];
      expect(Value.Check(JobAdmissionSchema, value), field).toBe(false);
    }
    for (const field of ["episodeSequence", "bucket", "serviceTicket", "queuePosition", "jobId"])
      expect(Value.Check(JobAdmissionSchema, { ...pending, [field]: "private" }), field).toBe(
        false,
      );
  });

  it("distinguishes a current pending episode from a granted queue admission", () => {
    expect(Value.Check(JobAdmissionSchema, { ...pending, admittedAt })).toBe(false);
    expect(Value.Check(JobAdmissionSchema, { ...admitted, admittedAt: null })).toBe(false);
    for (const state of ["queued", "executing", "terminal", "unlimited", "", null])
      expect(Value.Check(JobAdmissionStateSchema, state)).toBe(false);
    for (const timestampBasis of [null, "", "estimated", "historical"])
      expect(Value.Check(JobAdmissionSchema, { ...admitted, timestampBasis })).toBe(false);
  });

  it("bounds episode attempt identity to nonnegative safe integers", () => {
    for (const attemptBase of [0, Number.MAX_SAFE_INTEGER])
      expect(Value.Check(JobAdmissionSchema, { ...pending, attemptBase })).toBe(true);
    for (const attemptBase of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null])
      expect(Value.Check(JobAdmissionSchema, { ...pending, attemptBase })).toBe(false);
  });

  it.each(["queued", "retry_waiting"] as const)(
    "requires exact admission for %s without consuming another attempt",
    (status) => {
      for (const admission of [pending, admitted]) {
        expect(getJobAdmissionIssues({ status, attemptCount: 2, admission })).toEqual([]);
        expect(getJobAdmissionIssues({ status, attemptCount: 3, admission })).toEqual([
          "admission_attempt_mismatch",
        ]);
      }
      expect(getJobAdmissionIssues({ status, attemptCount: 2, admission: null })).toEqual([
        "missing_waiting_admission",
      ]);
    },
  );

  it.each(JobStateValues.filter((status) => status !== "queued" && status !== "retry_waiting"))(
    "does not project persisted admission as queue state for %s",
    (status) => {
      expect(getJobAdmissionIssues({ status, attemptCount: 3, admission: null })).toEqual([]);
      for (const admission of [pending, admitted])
        expect(getJobAdmissionIssues({ status, attemptCount: 3, admission })).toEqual([
          "admission_outside_waiting",
        ]);
    },
  );

  it("requires canonical timestamps without imposing wall-clock event ordering", () => {
    expect(
      getJobAdmissionIssues({
        status: "queued",
        attemptCount: 2,
        admission: { ...admitted, admittedAt: "2026-09-07T09:59:00.000Z" },
      }),
    ).toEqual([]);
    for (const time of ["invalid", "2026-09-07T10:00:00Z", "2026-09-07T12:00:00.000+02:00"]) {
      expect(
        getJobAdmissionIssues({
          status: "queued",
          attemptCount: 2,
          admission: { ...pending, requestedAt: time },
        }),
      ).toContain("invalid_admission_request_time");
      expect(
        getJobAdmissionIssues({
          status: "queued",
          attemptCount: 2,
          admission: { ...admitted, admittedAt: time },
        }),
      ).toContain("invalid_admission_time");
    }
  });

  it("narrows admission timestamps by state in the public type", () => {
    const inspect = (value: JobAdmission) => {
      if (value.state === "pending") expectTypeOf(value.admittedAt).toEqualTypeOf<null>();
      else expectTypeOf(value.admittedAt).toEqualTypeOf<string>();
      expectTypeOf(value.attemptBase).toEqualTypeOf<number>();
      // @ts-expect-error Public admission does not expose the global service order.
      void value.episodeSequence;
    };
    inspect(pending);
    inspect(admitted);
  });
});
