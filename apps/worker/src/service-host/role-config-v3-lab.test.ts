import { generateKeyPairSync } from "node:crypto";
import { serializeCanonicalJson } from "@agentic-review/local-protocol";
import { describe, expect, it } from "vitest";
import {
  ControlRoleConfigV3LabSchema,
  createControlRoleConfigV3Lab,
  createExecutorRoleConfigV3Lab,
  ExecutorRoleConfigV3LabSchema,
  isParsedRoleConfigV3Lab,
  parseRoleConfigV3Lab,
  ROLE_CONFIG_V3_LAB_MAXIMUM_BYTES,
  ROLE_CONFIG_V3_LAB_MISSING_PREREQUISITES,
} from "./role-config-v3-lab.js";
import {
  sharedLabGoldenLines,
  testCompressedP256PublicKeySpki,
  testExecutorPolicySha256,
  testLocalAuthorityKeyId,
  testLocalAuthorityPublicKeySpki,
} from "./role-config-v3-lab.test-helpers.js";
import { Value } from "./typebox-value-check.js";

describe("dormant RoleConfig v3 lab", () => {
  it("round-trips the four-record Go and TypeScript golden in strict kind order", () => {
    const [control, executor, controlBootstrap, executorBootstrap] = sharedLabGoldenLines();
    expect(control).toBeDefined();
    expect(executor).toBeDefined();
    expect(controlBootstrap).toBeDefined();
    expect(executorBootstrap).toBeDefined();
    expect(createControlRoleConfigV3Lab(testExecutorPolicySha256, testLocalAuthorityKeyId)).toEqual(
      control,
    );
    expect(
      createExecutorRoleConfigV3Lab(testExecutorPolicySha256, testLocalAuthorityPublicKeySpki),
    ).toEqual(executor);

    for (const [document, role] of [
      [control, "control"],
      [executor, "executor"],
    ] as const) {
      if (document === undefined) throw new Error("Missing RoleConfig v3 lab golden.");
      const parsed = parseRoleConfigV3Lab(document, role);
      expect(isParsedRoleConfigV3Lab(parsed)).toBe(true);
      expect(parsed.executionAuthority).toBe(false);
      expect(parsed.config.activationState).toBe("blocked");
      expect(parsed.config.profile).toBe("disabled-execution-lab-v1");
      expect(parsed.config.missingPrerequisites).toEqual(ROLE_CONFIG_V3_LAB_MISSING_PREREQUISITES);
      expectRecursivelyFrozen(parsed);
    }
    expect(isParsedRoleConfigV3Lab(Object.freeze({ executionAuthority: false }))).toBe(false);
  });

  it("keeps Control and Executor schemas recursively frozen and identity-detached", () => {
    expectRecursivelyFrozen(ControlRoleConfigV3LabSchema);
    expectRecursivelyFrozen(ExecutorRoleConfigV3LabSchema);
    expectRecursivelyDetached(ControlRoleConfigV3LabSchema, ExecutorRoleConfigV3LabSchema);
  });

  it("rejects every fixed-field, dependency, blocker, and unknown-key drift", () => {
    const control = roleConfigValue(0);
    const candidates: Record<string, unknown>[] = [];
    const changed = (mutate: (value: Record<string, unknown>) => void) => {
      const value = structuredClone(control);
      mutate(value);
      candidates.push(value);
    };
    changed((value) => {
      value.extra = true;
    });
    changed((value) => {
      delete value.activationState;
    });
    changed((value) => {
      value.activationState = "ready";
    });
    changed((value) => {
      value.availableSlots = 1;
    });
    changed((value) => {
      value.completionMode = "inline_result_v1";
    });
    changed((value) => {
      value.disabledReasonCode = "execution_disabled";
    });
    changed((value) => {
      value.executionAuthority = true;
    });
    changed((value) => {
      value.executionEnabled = true;
    });
    changed((value) => {
      value.foundationVersion = 2;
    });
    changed((value) => {
      value.globalRolloutDefault = "on";
    });
    changed((value) => {
      value.jobExecutionEnvelopeVersion = 1;
    });
    changed((value) => {
      value.maximumSlots = 0;
    });
    changed((value) => {
      value.profile = "execution-lab-v1";
    });
    changed((value) => {
      value.requiredRuntimeBootstrapVersion = 1;
    });
    changed((value) => {
      value.requiredWorkerApiVersion = "1.0";
    });
    changed((value) => {
      value.executorPolicySha256 = "A".repeat(64);
    });
    changed((value) => {
      const arwx = value.arwx as Record<string, unknown>;
      arwx.minimumMinor = 0;
    });
    changed((value) => {
      const hostControl = value.hostControl as Record<string, unknown>;
      hostControl.protocolVersion = "1.0";
    });
    changed((value) => {
      const hostControl = value.hostControl as { operations: unknown[] };
      hostControl.operations.reverse();
    });
    changed((value) => {
      const blockers = value.missingPrerequisites as unknown[];
      blockers.pop();
    });
    changed((value) => {
      const blockers = value.missingPrerequisites as unknown[];
      blockers.reverse();
    });
    changed((value) => {
      value.missingPrerequisites = null;
    });
    for (const key of [
      "availableSlots",
      "executionAuthority",
      "executionEnabled",
      "foundationVersion",
      "jobExecutionEnvelopeVersion",
      "maximumSlots",
      "requiredRuntimeBootstrapVersion",
    ]) {
      changed((value) => {
        value[key] = null;
      });
    }

    for (const candidate of candidates) {
      expect(Value.Check(ControlRoleConfigV3LabSchema, candidate)).toBe(false);
      expect(() => parseValue(candidate, "control")).toThrowError(
        expect.objectContaining({ code: "INVALID_DOCUMENT" }),
      );
    }
  });

  it("separates legal opposite roles from malformed role values", () => {
    const control = roleConfigValue(0);
    const executor = roleConfigValue(1);
    expect(() => parseValue(executor, "control")).toThrowError(
      expect.objectContaining({ code: "ROLE_MISMATCH" }),
    );
    for (const mutate of [
      (value: Record<string, unknown>) => delete value.localAuthorityPublicKeySpki,
      (value: Record<string, unknown>) => {
        value.extra = true;
      },
      (value: Record<string, unknown>) => {
        const arwx = value.arwx as Record<string, unknown>;
        arwx.maximumMinor = 0;
      },
    ]) {
      const malformedOpposite = structuredClone(executor);
      mutate(malformedOpposite);
      expect(() => parseValue(malformedOpposite, "control")).toThrowError(
        expect.objectContaining({ code: "INVALID_DOCUMENT" }),
      );
    }
    for (const role of [undefined, null, 1, "CONTROL", "unknown"]) {
      const candidate = structuredClone(control);
      if (role === undefined) delete candidate.role;
      else candidate.role = role;
      expect(() => parseValue(candidate, "control")).toThrowError(
        expect.objectContaining({ code: "INVALID_DOCUMENT" }),
      );
    }
  });

  it("enforces role-local P-256 descriptors and canonical DER round trips", () => {
    const control = roleConfigValue(0);
    const executor = roleConfigValue(1);
    const descriptor = structuredClone(executor.localAuthorityPublicKeySpki) as Record<
      string,
      unknown
    >;
    expect(() =>
      parseValue({ ...control, localAuthorityPublicKeySpki: descriptor }, "control"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_DOCUMENT" }));
    const withoutKey = structuredClone(executor);
    delete withoutKey.localAuthorityPublicKeySpki;
    expect(() => parseValue(withoutKey, "executor")).toThrowError(
      expect.objectContaining({ code: "INVALID_DOCUMENT" }),
    );

    for (const mutate of [
      (value: Record<string, unknown>) => {
        const key = value.localAuthorityPublicKeySpki as Record<string, unknown>;
        key.base64Url = `${String(key.base64Url)}=`;
      },
      (value: Record<string, unknown>) => {
        const key = value.localAuthorityPublicKeySpki as Record<string, unknown>;
        key.byteLength = 90;
      },
      (value: Record<string, unknown>) => {
        const key = value.localAuthorityPublicKeySpki as Record<string, unknown>;
        key.sha256 = "0".repeat(64);
      },
      (value: Record<string, unknown>) => {
        value.localAuthorityKeyId = "0".repeat(64);
      },
    ]) {
      const candidate = structuredClone(executor);
      mutate(candidate);
      expect(() => parseValue(candidate, "executor")).toThrowError();
    }

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2_048 }).publicKey.export({
      format: "der",
      type: "spki",
    });
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({
      format: "der",
      type: "spki",
    });
    for (const publicKey of [
      rsa,
      p384,
      testCompressedP256PublicKeySpki(),
      Buffer.concat([testLocalAuthorityPublicKeySpki, Buffer.of(0)]),
    ]) {
      expect(() => createExecutorRoleConfigV3Lab(testExecutorPolicySha256, publicKey)).toThrowError(
        expect.objectContaining({ code: "INVALID_PUBLIC_KEY" }),
      );
    }
  });

  it("rejects noncanonical, invalid UTF-8, and exact size-boundary documents", () => {
    const golden = sharedLabGoldenLines()[0];
    if (golden === undefined) throw new Error("Missing Control RoleConfig v3 lab golden.");
    for (const candidate of [
      Buffer.concat([golden, Buffer.of(0x20)]),
      Buffer.concat([Buffer.of(0xef, 0xbb, 0xbf), golden]),
      Buffer.from(
        golden.toString("utf8").replace('"role":"control"', '"role":"control","role":"control"'),
        "utf8",
      ),
      Buffer.of(0xff),
      Buffer.alloc(ROLE_CONFIG_V3_LAB_MAXIMUM_BYTES, 0x20),
      Buffer.alloc(ROLE_CONFIG_V3_LAB_MAXIMUM_BYTES + 1, 0x20),
      Buffer.alloc(0),
    ]) {
      expect(() => parseRoleConfigV3Lab(candidate, "control")).toThrowError(
        expect.objectContaining({ code: "INVALID_DOCUMENT" }),
      );
    }
  });

  it("snapshots inputs and never exposes mutable parsed authority", () => {
    const source = Buffer.from(testLocalAuthorityPublicKeySpki);
    const created = createExecutorRoleConfigV3Lab(testExecutorPolicySha256, source);
    const original = Buffer.from(created);
    source.fill(0);
    created.fill(0x20);
    expect(
      createExecutorRoleConfigV3Lab(testExecutorPolicySha256, testLocalAuthorityPublicKeySpki),
    ).toEqual(original);

    const input = Buffer.from(original);
    const parsed = parseRoleConfigV3Lab(input, "executor");
    input.fill(0);
    expect(parsed.config.localAuthorityKeyId).toBe(testLocalAuthorityKeyId);
    expect(parsed.executionAuthority).toBe(false);
    expect(() => {
      (parsed.config.hostControl.operations as unknown as string[]).reverse();
    }).toThrow();
  });
});

function roleConfigValue(index: 0 | 1): Record<string, unknown> {
  const document = sharedLabGoldenLines()[index];
  if (document === undefined) throw new Error(`Missing RoleConfig v3 lab golden ${index}.`);
  return JSON.parse(document.toString("utf8")) as Record<string, unknown>;
}

function parseValue(value: unknown, role: "control" | "executor") {
  return parseRoleConfigV3Lab(Buffer.from(serializeCanonicalJson(value), "utf8"), role);
}

function expectRecursivelyFrozen(value: unknown): void {
  const visited = new WeakSet<object>();
  const visit = (current: unknown): void => {
    if (current === null || typeof current !== "object" || visited.has(current)) return;
    visited.add(current);
    expect(Object.isFrozen(current)).toBe(true);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) visit(descriptor.value);
    }
  };
  visit(value);
}

function expectRecursivelyDetached(left: object, right: object): void {
  const leftNodes = collectNodes(left);
  for (const node of collectNodes(right)) expect(leftNodes.has(node)).toBe(false);
}

function collectNodes(root: object): Set<object> {
  const result = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || result.has(value)) return;
    result.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) visit(descriptor.value);
    }
  };
  visit(root);
  return result;
}
