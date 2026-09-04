import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { serializeCanonicalJson } from "@agentic-review/local-protocol";
import { describe, expect, it } from "vitest";
import { bootstrapFacts, labFixtureLines } from "./role-config-v3-lab.test-helpers.js";
import { RuntimeBootstrapV1Schema } from "./runtime-bootstrap.js";
import {
  createRuntimeBootstrapV2Lab,
  isParsedRuntimeBootstrapV2Lab,
  parseRuntimeBootstrapV2Lab,
  RUNTIME_BOOTSTRAP_V2_LAB_MAXIMUM_BYTES,
  RuntimeBootstrapV2LabSchema,
} from "./runtime-bootstrap-v2-lab.js";
import { Value } from "./typebox-value-check.js";

describe("dormant RuntimeBootstrapV2 lab", () => {
  it("round-trips both native-to-Node golden documents without authority", () => {
    const [controlRoleConfig, executorRoleConfig, controlGolden, executorGolden] =
      labFixtureLines();
    for (const [role, roleConfig, golden] of [
      ["control", controlRoleConfig, controlGolden],
      ["executor", executorRoleConfig, executorGolden],
    ] as const) {
      if (roleConfig === undefined || golden === undefined) {
        throw new Error(`Missing RuntimeBootstrapV2 lab ${role} golden.`);
      }
      const document = createRuntimeBootstrapV2Lab(bootstrapFacts(role, roleConfig));
      expect(document).toEqual(golden);
      const parsed = parseRuntimeBootstrapV2Lab(document, role);
      expect(isParsedRuntimeBootstrapV2Lab(parsed)).toBe(true);
      expect(parsed.executionAuthority).toBe(false);
      expect(parsed.bootstrap.executionAuthority).toBe(false);
      expect(parsed.bootstrap.protocolVersion).toBe("2.0");
      expect(parsed.bootstrap.arwx.minimumMinor).toBe(1);
      expect(parsed.bootstrap.arwx.maximumMinor).toBe(1);
      expect(parsed.disabledReadiness).toEqual({
        availableSlots: 0,
        executionAuthority: false,
        ready: false,
        reasonCode: "EXECUTION_DISABLED",
      });
      expectRecursivelyFrozen(parsed);
    }
    expect(isParsedRuntimeBootstrapV2Lab(Object.freeze({ executionAuthority: false }))).toBe(false);
  });

  it("keeps the v2 schema detached from v1 and makes the profiles mutually exclusive", () => {
    expectRecursivelyFrozen(RuntimeBootstrapV2LabSchema);
    expectRecursivelyDetached(RuntimeBootstrapV1Schema, RuntimeBootstrapV2LabSchema);
    const versionOne = JSON.parse(readRuntimeBootstrapV1Golden().toString("utf8"));
    const versionTwo = bootstrapValue(2);
    expect(Value.Check(RuntimeBootstrapV1Schema, versionOne)).toBe(true);
    expect(Value.Check(RuntimeBootstrapV2LabSchema, versionTwo)).toBe(true);
    expect(Value.Check(RuntimeBootstrapV1Schema, versionTwo)).toBe(false);
    expect(Value.Check(RuntimeBootstrapV2LabSchema, versionOne)).toBe(false);
  });

  it("rejects all protocol-selection, authority, and closed-operation drift", () => {
    const control = bootstrapValue(2);
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
      value.protocolVersion = "1.0";
    });
    changed((value) => {
      value.bootstrapVersion = 1;
    });
    changed((value) => {
      value.executionAuthority = true;
    });
    changed((value) => {
      value.completionMode = "inline_result_v1";
    });
    changed((value) => {
      value.jobExecutionEnvelopeVersion = 1;
    });
    changed((value) => {
      const arwx = value.arwx as Record<string, unknown>;
      arwx.minimumMinor = 0;
    });
    changed((value) => {
      const arwx = value.arwx as Record<string, unknown>;
      arwx.maximumMinor = 0;
    });
    changed((value) => {
      const hostControl = value.hostControl as Record<string, unknown>;
      hostControl.protocolVersion = "1.1";
    });
    changed((value) => {
      const hostControl = value.hostControl as { operations: unknown[] };
      hostControl.operations.reverse();
    });
    changed((value) => {
      value.roleConfig = null;
    });
    changed((value) => {
      const shutdown = value.shutdown as Record<string, unknown>;
      shutdown.forceTerminationReserveMs = shutdown.gracefulTimeoutMs;
    });
    for (const key of ["bootstrapVersion", "executionAuthority", "jobExecutionEnvelopeVersion"]) {
      changed((value) => {
        value[key] = null;
      });
    }

    for (const candidate of candidates) {
      expect(() => parseValue(candidate, "control")).toThrowError();
    }
    for (const candidate of candidates.filter((_, index) => index !== 11)) {
      expect(Value.Check(RuntimeBootstrapV2LabSchema, candidate)).toBe(false);
    }
    expect(Value.Check(RuntimeBootstrapV2LabSchema, candidates[11])).toBe(true);
  });

  it("separates a legal opposite role from missing, null, and malformed role values", () => {
    const control = bootstrapValue(2);
    const executor = bootstrapValue(3);
    expect(() => parseValue(executor, "control")).toThrowError(
      expect.objectContaining({ code: "ROLE_MISMATCH" }),
    );
    for (const mutate of [
      (value: Record<string, unknown>) => {
        delete value.roleConfig;
      },
      (value: Record<string, unknown>) => {
        value.extra = true;
      },
      (value: Record<string, unknown>) => {
        const roleConfig = value.roleConfig as Record<string, unknown>;
        roleConfig.sha256 = "0".repeat(64);
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

  it("binds the exact canonical RoleConfig descriptor and role", () => {
    const control = bootstrapValue(2);
    const controlRoleConfig = labFixtureLines()[0];
    const executorRoleConfig = labFixtureLines()[1];
    if (controlRoleConfig === undefined || executorRoleConfig === undefined) {
      throw new Error("Missing RoleConfig v3 lab golden.");
    }
    const executorDescriptor = descriptor(executorRoleConfig);

    for (const [mutate, code] of [
      [
        (value: Record<string, unknown>) => {
          const roleConfig = value.roleConfig as Record<string, unknown>;
          roleConfig.byteLength = Number(roleConfig.byteLength) + 1;
        },
        "INVALID_ROLE_CONFIG",
      ],
      [
        (value: Record<string, unknown>) => {
          const roleConfig = value.roleConfig as Record<string, unknown>;
          roleConfig.sha256 = "0".repeat(64);
        },
        "INVALID_ROLE_CONFIG",
      ],
      [
        (value: Record<string, unknown>) => {
          const roleConfig = value.roleConfig as Record<string, unknown>;
          roleConfig.base64Url = `${String(roleConfig.base64Url)}=`;
        },
        "INVALID_DOCUMENT",
      ],
      [
        (value: Record<string, unknown>) => {
          value.roleConfig = executorDescriptor;
        },
        "INVALID_ROLE_CONFIG",
      ],
    ] as const) {
      const candidate = structuredClone(control);
      mutate(candidate);
      expect(() => parseValue(candidate, "control")).toThrowError(
        expect.objectContaining({ code }),
      );
    }
    expect(() =>
      createRuntimeBootstrapV2Lab(bootstrapFacts("control", executorRoleConfig)),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ROLE_CONFIG" }));
    expect(() =>
      createRuntimeBootstrapV2Lab(bootstrapFacts("executor", controlRoleConfig)),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ROLE_CONFIG" }));
  });

  it("rejects noncanonical, invalid UTF-8, and exact size-boundary documents", () => {
    const golden = labFixtureLines()[2];
    if (golden === undefined) throw new Error("Missing Control RuntimeBootstrapV2 lab golden.");
    for (const candidate of [
      Buffer.concat([golden, Buffer.of(0x20)]),
      Buffer.concat([Buffer.of(0xef, 0xbb, 0xbf), golden]),
      Buffer.from(
        golden.toString("utf8").replace('"role":"control"', '"role":"control","role":"control"'),
        "utf8",
      ),
      Buffer.of(0xff),
      Buffer.alloc(RUNTIME_BOOTSTRAP_V2_LAB_MAXIMUM_BYTES, 0x20),
      Buffer.alloc(RUNTIME_BOOTSTRAP_V2_LAB_MAXIMUM_BYTES + 1, 0x20),
      Buffer.alloc(0),
    ]) {
      expect(() => parseRuntimeBootstrapV2Lab(candidate, "control")).toThrowError(
        expect.objectContaining({ code: "INVALID_DOCUMENT" }),
      );
    }
  });

  it("rejects accessors, custom prototypes, extra facts, and input aliasing", () => {
    const roleConfig = labFixtureLines()[0];
    const golden = labFixtureLines()[2];
    if (roleConfig === undefined || golden === undefined)
      throw new Error("Missing Control golden.");
    const facts = bootstrapFacts("control", Buffer.from(roleConfig));

    const accessor = { ...facts };
    Object.defineProperty(accessor, "role", {
      enumerable: true,
      get: () => facts.role,
    });
    expect(() => createRuntimeBootstrapV2Lab(accessor)).toThrow(TypeError);

    const customPrototype = Object.assign(Object.create({ inherited: true }) as object, facts);
    expect(() =>
      createRuntimeBootstrapV2Lab(customPrototype as RuntimeBootstrapV2LabFactsForTest),
    ).toThrow(TypeError);
    expect(() => createRuntimeBootstrapV2Lab({ ...facts, extra: true } as never)).toThrow(
      TypeError,
    );

    const mutableRoleConfig = Buffer.from(roleConfig);
    const created = createRuntimeBootstrapV2Lab(bootstrapFacts("control", mutableRoleConfig));
    mutableRoleConfig.fill(0);
    expect(created).toEqual(golden);
    const parsed = parseRuntimeBootstrapV2Lab(created, "control");
    created.fill(0);
    expect(parsed.bootstrap.bootstrapId).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(parsed.executionAuthority).toBe(false);
    expect(() => {
      (parsed.bootstrap.hostControl.operations as unknown as string[]).reverse();
    }).toThrow();
  });
});

type RuntimeBootstrapV2LabFactsForTest = Parameters<typeof createRuntimeBootstrapV2Lab>[0];

function bootstrapValue(index: 2 | 3): Record<string, unknown> {
  const document = labFixtureLines()[index];
  if (document === undefined) throw new Error(`Missing RuntimeBootstrapV2 lab golden ${index}.`);
  return JSON.parse(document.toString("utf8")) as Record<string, unknown>;
}

function parseValue(value: unknown, role: "control" | "executor") {
  return parseRuntimeBootstrapV2Lab(Buffer.from(serializeCanonicalJson(value), "utf8"), role);
}

function descriptor(document: Uint8Array): Readonly<Record<string, unknown>> {
  const bytes = Buffer.from(document);
  return {
    base64Url: bytes.toString("base64url"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function readRuntimeBootstrapV1Golden(): Buffer {
  const path = new URL(
    "../../../../native/service-host/internal/localrpc/testdata/runtime_bootstrap_v1.json",
    import.meta.url,
  );
  const document = readFileSync(path);
  return Buffer.from(document.subarray(0, document.byteLength - 1));
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
