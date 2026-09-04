import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { ClaimLeaseUnavailableSchema } from "./job-envelope.js";
import { LeaseCommandActionSchema } from "./worker.js";

describe("current Worker protocol", () => {
  it("has no unpublished upgrade compatibility action", () => {
    expect(Value.Check(LeaseCommandActionSchema, "upgrade_required")).toBe(false);
    expect(
      Value.Check(ClaimLeaseUnavailableSchema, {
        outcome: "worker_unavailable",
        serverTime: "2026-09-04T00:00:00.000Z",
        reason: "upgrade_required",
      }),
    ).toBe(false);
  });
});
