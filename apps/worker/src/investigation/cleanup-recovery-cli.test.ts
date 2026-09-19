import { describe, expect, it } from "vitest";
import { parseCleanupRecoveryCommand } from "./cleanup-recovery-cli.js";

describe("operator cleanup recovery commands", () => {
  it("does not change ordinary Worker startup and provides a read-only status command", () => {
    expect(parseCleanupRecoveryCommand([])).toBeNull();
    expect(parseCleanupRecoveryCommand(["cleanup-recovery", "list"])).toEqual({ kind: "list" });
  });

  it("requires explicit desktop restoration while native recovery proves the owned process tree", () => {
    expect(
      parseCleanupRecoveryCommand([
        "cleanup-recovery",
        "confirm",
        "attempt-1",
        "--desktop-restored",
        "--reason",
        "Restored the dedicated test desktop.",
      ]),
    ).toEqual({
      kind: "confirm",
      attemptId: "attempt-1",
      desktopRestored: true,
      ownedProcessTreeStopped: false,
      reason: "Restored the dedicated test desktop.",
    });
  });

  it("separately records an explicit legacy process-tree verification", () => {
    expect(
      parseCleanupRecoveryCommand([
        "cleanup-recovery",
        "confirm",
        "attempt-1",
        "--desktop-restored",
        "--owned-process-tree-stopped",
        "--reason",
        "Verified the original host and every owned process stopped; restored the desktop.",
      ]),
    ).toMatchObject({ ownedProcessTreeStopped: true });
  });

  it("rejects implied confirmations, credentials, broad targets, and duplicate flags", () => {
    for (const args of [
      ["cleanup-recovery", "confirm", "attempt-1", "--reason", "checked"],
      ["cleanup-recovery", "confirm", "*", "--desktop-restored", "--reason", "checked"],
      [
        "cleanup-recovery",
        "confirm",
        "attempt-1",
        "--desktop-restored",
        "--lease-token",
        "private",
      ],
      [
        "cleanup-recovery",
        "confirm",
        "attempt-1",
        "--desktop-restored",
        "--desktop-restored",
        "--reason",
        "checked",
      ],
    ])
      expect(() => parseCleanupRecoveryCommand(args)).toThrow();
  });
});
