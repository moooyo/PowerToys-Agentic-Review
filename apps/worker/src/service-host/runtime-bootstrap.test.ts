import { createHash } from "node:crypto";
import { serializeCanonicalJson } from "@agentic-review/local-protocol";
import { describe, expect, it } from "vitest";
import { encodeHostControlOpaqueJson } from "./opaque-json.js";
import {
  parseRuntimeBootstrap,
  parseRuntimeBootstrapCommit,
  RUNTIME_BOOTSTRAP_MAXIMUM_BYTES,
  RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES,
  RuntimeBootstrapError,
} from "./runtime-bootstrap.js";
import {
  bootstrapDocument,
  foundationRoleConfig,
  testExecutorPolicySha256,
} from "./runtime-bootstrap.test-helpers.js";

type MutableJsonObject = Record<string, unknown>;

describe("RuntimeBootstrapV1", () => {
  it("parses the shared Go/TypeScript golden without local-authority key material", () => {
    const golden = bootstrapDocument("control");
    const parsed = parseRuntimeBootstrap(golden, "control");

    expect(parsed.bootstrap).toMatchObject({
      protocolVersion: "1.0",
      type: "runtimeBootstrap",
      bootstrapVersion: 1,
      role: "control",
      workerNodeId: "powertoys-node:01",
    });
    expect(parsed.roleConfig).toEqual(foundationRoleConfig("control"));
    expect(parsed.roleConfig).not.toHaveProperty("localAuthorityKeyId");
    expect(parsed.bootstrapSha256).toBe(createHash("sha256").update(golden).digest("hex"));
  });

  it("supports the exact executor role while binding the expected role", () => {
    const executor = bootstrapDocument("executor");
    const parsed = parseRuntimeBootstrap(executor, "executor");
    expect(parsed.roleConfig).toEqual(foundationRoleConfig("executor"));
    expect(parsed.roleConfig).not.toHaveProperty("localAuthorityPublicKeySpki");
    expect(() => parseRuntimeBootstrap(executor, "control")).toThrowError(
      expect.objectContaining({ code: "ROLE_MISMATCH" }),
    );
  });

  it.each([
    ["legacy local key ID", "control" as const, { localAuthorityKeyId: "0".repeat(64) }],
    ["legacy public key", "executor" as const, { localAuthorityPublicKeySpki: {} }],
    ["wrong foundation version", "control" as const, { foundationVersion: 1 }],
    ["enabled execution", "executor" as const, { executionEnabled: true }],
    ["nonfixed maximum slots", "executor" as const, { maximumSlots: 2 }],
  ])("rejects %s in strict roleConfig v2", (_name, role, mutation) => {
    const roleConfig = { ...foundationRoleConfig(role), ...mutation };
    expect(() => parseRuntimeBootstrap(roleConfigDocument(role, roleConfig), role)).toThrowError(
      expect.objectContaining({ code: "INVALID_ROLE_CONFIG" }),
    );
  });

  it("validates a commit against the exact bootstrap digest", () => {
    const bootstrap = bootstrapDocument("control");
    const parsed = parseRuntimeBootstrap(bootstrap, "control");
    const commit = Buffer.from(
      serializeCanonicalJson({
        bootstrapId: parsed.bootstrap.bootstrapId,
        bootstrapSha256: parsed.bootstrapSha256,
        bootstrapVersion: 1,
        committed: true,
        protocolVersion: "1.0",
        role: "control",
        type: "runtimeBootstrapCommit",
      }),
      "utf8",
    );
    expect(parseRuntimeBootstrapCommit(commit, parsed).committed).toBe(true);
    expect(() =>
      parseRuntimeBootstrapCommit(
        Buffer.from(
          serializeCanonicalJson({
            ...JSON.parse(commit.toString("utf8")),
            bootstrapSha256: "0".repeat(64),
          }),
          "utf8",
        ),
        parsed,
      ),
    ).toThrowError(expect.objectContaining({ code: "COMMIT_MISMATCH" }));
  });

  it("binds ACK identity to opaque roleConfig bytes, not only parsed semantics", () => {
    const compact = Buffer.from(JSON.stringify(foundationRoleConfig("control")), "utf8");
    const spaced = Buffer.from(
      ` { "executionEnabled" : false, "executorPolicySha256" : "${testExecutorPolicySha256}", "foundationVersion" : 2, "maximumSlots" : 1, "role" : "control" } `,
      "utf8",
    );
    const first = parseRuntimeBootstrap(withRoleConfig(compact), "control");
    const second = parseRuntimeBootstrap(withRoleConfig(spaced), "control");
    expect(first.roleConfig).toEqual(second.roleConfig);
    expect(first.bootstrapSha256).not.toBe(second.bootstrapSha256);
  });

  it.each([
    [1_048_576, 1_000, 1],
    [64 * 1_024 * 1_024, 300_000, 299_999],
  ])("accepts exact queue and shutdown endpoints", (queueBytes, gracefulTimeoutMs, reserveMs) => {
    const document = mutateGolden((value) => {
      nested(value, "arwx").maximumQueuedBytesPerDirection = queueBytes;
      nested(value, "shutdown").gracefulTimeoutMs = gracefulTimeoutMs;
      nested(value, "shutdown").forceTerminationReserveMs = reserveMs;
    });
    expect(parseRuntimeBootstrap(document, "control").bootstrap.shutdown).toEqual({
      forceTerminationReserveMs: reserveMs,
      gracefulTimeoutMs,
    });
  });

  it.each([
    ["unknown field", (value: MutableJsonObject) => (value.extra = true)],
    ["bad role", (value: MutableJsonObject) => (value.role = "other")],
    [
      "bad queue",
      (value: MutableJsonObject) => (nested(value, "arwx").maximumQueuedBytesPerDirection = 1),
    ],
    [
      "bad shutdown",
      (value: MutableJsonObject) => (nested(value, "shutdown").forceTerminationReserveMs = 120_000),
    ],
  ])("rejects a mutated %s", (_name, mutate) => {
    expect(() => parseRuntimeBootstrap(mutateGolden(mutate), "control")).toThrow(
      RuntimeBootstrapError,
    );
  });

  it("enforces aggregate and decoded roleConfig limits", () => {
    expect(() =>
      parseRuntimeBootstrap(Buffer.alloc(RUNTIME_BOOTSTRAP_MAXIMUM_BYTES + 1), "control"),
    ).toThrow(RuntimeBootstrapError);
    const document = mutateGolden((value) => {
      value.roleConfig = encodeHostControlOpaqueJson(
        { ...foundationRoleConfig("control"), padding: "x".repeat(47_000) },
        RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES,
      );
    });
    expect(() => parseRuntimeBootstrap(document, "control")).toThrowError(
      expect.objectContaining({ code: "INVALID_ROLE_CONFIG" }),
    );
  });
});

function mutateGolden(mutate: (value: MutableJsonObject) => void): Buffer {
  const value = JSON.parse(bootstrapDocument("control").toString("utf8")) as MutableJsonObject;
  mutate(value);
  return Buffer.from(serializeCanonicalJson(value), "utf8");
}

function roleConfigDocument(
  role: "control" | "executor",
  roleConfig: Readonly<Record<string, unknown>>,
): Buffer {
  const value = JSON.parse(bootstrapDocument(role).toString("utf8")) as MutableJsonObject;
  value.role = role;
  value.roleConfig = encodeHostControlOpaqueJson(
    roleConfig,
    RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES,
  );
  return Buffer.from(serializeCanonicalJson(value), "utf8");
}

function withRoleConfig(roleConfig: Buffer): Buffer {
  const value = JSON.parse(bootstrapDocument("control").toString("utf8")) as MutableJsonObject;
  value.roleConfig = descriptorFor(roleConfig);
  return Buffer.from(serializeCanonicalJson(value), "utf8");
}

function descriptorFor(bytes: Buffer): Readonly<Record<string, unknown>> {
  return Object.freeze({
    base64Url: bytes.toString("base64url"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function nested(value: MutableJsonObject, key: string): MutableJsonObject {
  const candidate = value[key];
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`Expected ${key} to be an object.`);
  }
  return candidate as MutableJsonObject;
}
