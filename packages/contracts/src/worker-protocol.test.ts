import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { ClaimLeaseUnavailableSchema } from "./job-envelope.js";
import { ExecutionPhaseSchema } from "./states.js";
import { LeaseCommandActionSchema, WorkerCapabilitiesSchema } from "./worker.js";

describe("current Worker protocol", () => {
  it.each(["review", "revision"])("reports %s with a generic CLI phase", (phase) => {
    expect(Value.Check(ExecutionPhaseSchema, `cli_${phase}`)).toBe(true);
    expect(Value.Check(ExecutionPhaseSchema, `codex_${phase}`)).toBe(false);
  });

  const capabilities = {
    operatingSystem: "windows",
    architecture: "x64",
    headless: true,
    interactiveDesktop: false,
    cliEngine: "codex",
    cliVersion: "1.0.0",
    recipeIds: [],
    labels: {},
  };

  it.each(["codex", "copilot"])("reports the configured %s CLI", (cliEngine) => {
    expect(Value.Check(WorkerCapabilitiesSchema, { ...capabilities, cliEngine })).toBe(true);
  });

  it("reports unavailable CLI metadata explicitly", () => {
    expect(
      Value.Check(WorkerCapabilitiesSchema, {
        ...capabilities,
        cliEngine: null,
        cliVersion: null,
      }),
    ).toBe(true);
    for (const field of ["cliEngine", "cliVersion"]) {
      const missing: Record<string, unknown> = { ...capabilities };
      delete missing[field];
      expect(Value.Check(WorkerCapabilitiesSchema, missing)).toBe(false);
    }
  });

  it.each([{ cliEngine: "other" }, { cliVersion: "" }, { cliVersion: "x".repeat(129) }])(
    "rejects malformed CLI metadata %j",
    (changes) => {
      expect(Value.Check(WorkerCapabilitiesSchema, { ...capabilities, ...changes })).toBe(false);
    },
  );

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
