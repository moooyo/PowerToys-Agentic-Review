import { describe, expect, it } from "vitest";
import { buildSchedulingLimits, schedulingLimitValues } from "./form";

describe("scheduling limit form", () => {
  it.each([
    { maxActiveLeases: null, maxQueuedJobs: null },
    { maxActiveLeases: 1, maxQueuedJobs: 1 },
    { maxActiveLeases: 65535, maxQueuedJobs: 1000000 },
  ])("round-trips complete limits %j", (limits) => {
    expect(buildSchedulingLimits(schedulingLimitValues(limits))).toEqual(limits);
  });
  it("discards stale numeric inputs when unlimited is explicitly selected", () => {
    expect(
      buildSchedulingLimits({
        activeUnlimited: true,
        activeLimit: "invalid",
        queueUnlimited: true,
        queueLimit: "0",
      }),
    ).toEqual({ maxActiveLeases: null, maxQueuedJobs: null });
  });
  it.each(["", "0", "-1", "1.5", "1e3", "65536", "9007199254740993"])(
    "rejects invalid active limits %j",
    (activeLimit) => {
      expect(() =>
        buildSchedulingLimits({
          ...schedulingLimitValues({ maxActiveLeases: 1, maxQueuedJobs: null }),
          activeLimit,
        }),
      ).toThrow("Active lease limit");
    },
  );
  it.each(["0", "-1", "1000001", "Infinity"])("rejects invalid queue limits %j", (queueLimit) => {
    expect(() =>
      buildSchedulingLimits({
        ...schedulingLimitValues({ maxActiveLeases: null, maxQueuedJobs: 1 }),
        queueLimit,
      }),
    ).toThrow("Admitted queue limit");
  });
});
