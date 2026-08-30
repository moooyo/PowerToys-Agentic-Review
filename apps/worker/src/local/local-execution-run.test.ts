import type { RunTerminalResponse } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";

import { mapRunTerminalResponseOutcome } from "./local-execution-run.js";

const identity = { jobId: "job-1", runAttemptId: "run-1" } as const;

describe("mapRunTerminalResponseOutcome", () => {
  it.each([
    ["succeeded", "succeeded", "committed"],
    ["retry_waiting", "failed", "retry_scheduled"],
    ["cancelled", "cancelled", "cancelled"],
    ["failed", "failed", "committed"],
    ["dead_letter", "failed", "committed"],
  ] as const)("maps %s/%s to %s", (jobState, runState, expected) => {
    expect(mapRunTerminalResponseOutcome({ ...identity, jobState, runState })).toBe(expected);
  });

  it("rejects a schema-valid but semantically inconsistent terminal response", () => {
    const response: RunTerminalResponse = {
      ...identity,
      jobState: "cancelled",
      runState: "failed",
    };
    expect(() => mapRunTerminalResponseOutcome(response)).toThrow(/states are inconsistent/u);
  });
});
