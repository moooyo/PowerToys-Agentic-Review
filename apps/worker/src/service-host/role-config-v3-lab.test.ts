import { serializeCanonicalJson } from "@agentic-review/local-protocol";
import { describe, expect, it } from "vitest";
import {
  createControlRoleConfigV3Lab,
  createExecutorRoleConfigV3Lab,
  isParsedRoleConfigV3Lab,
  parseRoleConfigV3Lab,
  ROLE_CONFIG_V3_LAB_MAXIMUM_BYTES,
  ROLE_CONFIG_V3_LAB_MISSING_PREREQUISITES,
  RoleConfigV3LabError,
} from "./role-config-v3-lab.js";
import { labFixtureLines, testExecutorPolicySha256 } from "./role-config-v3-lab.test-helpers.js";

describe("RoleConfig v3 lab", () => {
  it("matches shared Control and Executor fixtures without local key material", () => {
    const [control, executor] = goldens();
    expect(createControlRoleConfigV3Lab(testExecutorPolicySha256)).toEqual(control);
    expect(createExecutorRoleConfigV3Lab(testExecutorPolicySha256)).toEqual(executor);

    for (const [document, role] of [
      [control, "control"],
      [executor, "executor"],
    ] as const) {
      const parsed = parseRoleConfigV3Lab(document, role);
      expect(isParsedRoleConfigV3Lab(parsed)).toBe(true);
      expect(parsed.executionAuthority).toBe(false);
      expect(parsed.config.executionEnabled).toBe(false);
      expect(parsed.config).not.toHaveProperty("localAuthorityKeyId");
      expect(parsed.config).not.toHaveProperty("localAuthorityPublicKeySpki");
      expect(parsed.config.missingPrerequisites).toEqual(ROLE_CONFIG_V3_LAB_MISSING_PREREQUISITES);
    }
  });

  it("rejects opposite roles and legacy local-authority fields", () => {
    const [control, executor] = goldens();
    expect(() => parseRoleConfigV3Lab(control, "executor")).toThrowError(
      expect.objectContaining({ code: "ROLE_MISMATCH" }),
    );
    expect(() => parseRoleConfigV3Lab(executor, "control")).toThrowError(
      expect.objectContaining({ code: "ROLE_MISMATCH" }),
    );

    for (const [document, role, mutation] of [
      [control, "control", { localAuthorityKeyId: "0".repeat(64) }],
      [executor, "executor", { localAuthorityPublicKeySpki: {} }],
    ] as const) {
      const value = { ...JSON.parse(document.toString("utf8")), ...mutation };
      expect(() =>
        parseRoleConfigV3Lab(Buffer.from(serializeCanonicalJson(value)), role),
      ).toThrowError(expect.objectContaining({ code: "INVALID_DOCUMENT" }));
    }
  });

  it.each([
    ["executionEnabled", true],
    ["maximumSlots", 2],
    ["foundationVersion", 2],
    ["executionAuthority", true],
  ])("rejects mutated %s", (field, candidate) => {
    const [control] = goldens();
    const value = JSON.parse(control.toString("utf8")) as Record<string, unknown>;
    value[field] = candidate;
    expect(() =>
      parseRoleConfigV3Lab(Buffer.from(serializeCanonicalJson(value)), "control"),
    ).toThrow(RoleConfigV3LabError);
  });

  it("rejects noncanonical and oversized documents", () => {
    const [control] = goldens();
    expect(() =>
      parseRoleConfigV3Lab(Buffer.concat([control, Buffer.from(" ")]), "control"),
    ).toThrow(RoleConfigV3LabError);
    expect(() =>
      parseRoleConfigV3Lab(Buffer.alloc(ROLE_CONFIG_V3_LAB_MAXIMUM_BYTES + 1), "control"),
    ).toThrow(RoleConfigV3LabError);
  });
});

function goldens(): readonly [Buffer, Buffer] {
  const lines = labFixtureLines();
  const control = lines[0];
  const executor = lines[1];
  if (control === undefined || executor === undefined) {
    throw new Error("RoleConfig v3 lab golden records are incomplete.");
  }
  return [control, executor];
}
