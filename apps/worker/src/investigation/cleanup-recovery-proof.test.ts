import { describe, expect, it } from "vitest";
import type { ProcessHostRecoverySnapshot } from "../execution/process-host-protocol.js";
import { hasRecoveredProcessHostOwnership } from "./cleanup-recovery-proof.js";

const snapshot = (generation: string): ProcessHostRecoverySnapshot => ({
  capability: "named-job-tree-v1",
  instanceKey: "a".repeat(64),
  generation: generation.repeat(64),
  previousTreeDrained: true,
});

describe("ProcessHost crash recovery proof", () => {
  it("accepts a different contained Host generation for the exact same instance", () => {
    expect(hasRecoveredProcessHostOwnership(snapshot("b"), snapshot("c"))).toBe(true);
  });

  it("does not use the current Host to prove its own processes have exited", () => {
    expect(hasRecoveredProcessHostOwnership(snapshot("b"), snapshot("b"))).toBe(false);
  });

  it("does not use another worker data root as ownership evidence", () => {
    expect(
      hasRecoveredProcessHostOwnership(snapshot("b"), {
        ...snapshot("c"),
        instanceKey: "d".repeat(64),
      }),
    ).toBe(false);
  });

  it.each([
    undefined,
    null,
    {},
    { processId: 42, exited: true },
    { ...snapshot("b"), previousTreeDrained: false },
    { ...snapshot("b"), capability: "pid-absence" },
    { ...snapshot("b"), generation: "unknown" },
    { ...snapshot("b"), instanceKey: "a".repeat(64) + "\n" },
  ])("retains missing proof for legacy or malformed previous ownership: %j", (previous) => {
    expect(hasRecoveredProcessHostOwnership(previous, snapshot("c"))).toBe(false);
  });

  it.each([undefined, null, {}, { ...snapshot("c"), previousTreeDrained: false }])(
    "retains missing proof when native recovery evidence is unavailable: %j",
    (current) => expect(hasRecoveredProcessHostOwnership(snapshot("b"), current)).toBe(false),
  );
});
