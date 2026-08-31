import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { serializeCanonicalJson } from "@agentic-review/local-protocol";
import { describe, expect, it } from "vitest";
import { encodeHostControlOpaqueJson } from "./opaque-json.js";
import {
  createRuntimeBootstrapAck,
  encodeRuntimeBootstrapAck,
  parseRuntimeBootstrap,
  RUNTIME_BOOTSTRAP_MAXIMUM_BYTES,
  RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES,
  RuntimeBootstrapError,
} from "./runtime-bootstrap.js";

type MutableJsonObject = Record<string, unknown>;

describe("RuntimeBootstrapV1", () => {
  it("parses the shared Go/TypeScript golden and binds the exact bytes in its ACK", () => {
    const golden = readSharedGolden();
    const parsed = parseRuntimeBootstrap(golden, "control");

    expect(parsed.bootstrap).toMatchObject({
      protocolVersion: "1.0",
      type: "runtimeBootstrap",
      bootstrapVersion: 1,
      role: "control",
      workerNodeId: "powertoys-node:01",
    });
    expect(parsed.roleConfig).toEqual({
      confidence: 0.8,
      maximum: Number.MAX_VALUE,
      minimum: Number.MIN_VALUE,
    });
    expect(parsed.bootstrap.roleConfig).toEqual({
      base64Url:
        "eyJjb25maWRlbmNlIjowLjgsIm1heGltdW0iOjEuNzk3NjkzMTM0ODYyMzE1N2UrMzA4LCJtaW5pbXVtIjo1ZS0zMjR9",
      byteLength: 69,
      sha256: "75740ca3678e2efea5c080c5950accbe75f3eeb673facefc373b9eb0ee802dba",
    });

    const digest = createHash("sha256").update(golden).digest("hex");
    expect(parsed.bootstrapSha256).toBe(digest);
    expect(encodeRuntimeBootstrapAck(parsed).toString("utf8")).toBe(
      `{"accepted":true,"arwxHandlerReady":true,"bootstrapId":"123e4567-e89b-42d3-a456-426614174000","bootstrapSha256":"${digest}","bootstrapVersion":1,"protocolVersion":"1.0","role":"control","type":"runtimeBootstrapAck"}`,
    );
    expect(createRuntimeBootstrapAck(parsed)).toEqual({
      accepted: true,
      arwxHandlerReady: true,
      bootstrapId: "123e4567-e89b-42d3-a456-426614174000",
      bootstrapSha256: digest,
      bootstrapVersion: 1,
      protocolVersion: "1.0",
      role: "control",
      type: "runtimeBootstrapAck",
    });
  });

  it("does not let callers manufacture an ACK or select its protocol fields", () => {
    const parsed = parseRuntimeBootstrap(readSharedGolden(), "control");
    const forged = { ...parsed };
    expect(() => createRuntimeBootstrapAck(forged)).toThrow(TypeError);
    expect(() =>
      createRuntimeBootstrapAck({
        ...parsed,
        bootstrapSha256: "0".repeat(64),
      }),
    ).toThrow(TypeError);
  });

  it("supports the exact executor role while binding the expected role", () => {
    const executor = mutateGolden((value) => {
      value.role = "executor";
    });
    expect(parseRuntimeBootstrap(executor, "executor").bootstrap.role).toBe("executor");
    expect(() => parseRuntimeBootstrap(executor, "control")).toThrowError(
      expect.objectContaining({ code: "ROLE_MISMATCH" }),
    );
  });

  it("binds ACKs to opaque roleConfig exact bytes, not only parsed semantics", () => {
    const firstRoleConfig = Buffer.from('{"confidence":0.8}', "utf8");
    const secondRoleConfig = Buffer.from(' { "confidence" : 0.8 } ', "utf8");
    const firstDocument = mutateGolden((value) => {
      value.roleConfig = descriptorFor(firstRoleConfig);
    });
    const secondDocument = mutateGolden((value) => {
      value.roleConfig = descriptorFor(secondRoleConfig);
    });
    const first = parseRuntimeBootstrap(firstDocument, "control");
    const second = parseRuntimeBootstrap(secondDocument, "control");

    expect(first.roleConfig).toEqual(second.roleConfig);
    expect(first.bootstrapSha256).not.toBe(second.bootstrapSha256);
    expect(createRuntimeBootstrapAck(first).bootstrapSha256).not.toBe(
      createRuntimeBootstrapAck(second).bootstrapSha256,
    );
  });

  it.each([
    [1_048_576, 1_000, 1],
    [64 * 1_024 * 1_024, 300_000, 299_999],
  ])(
    "accepts exact queue/shutdown limit endpoints (%i, %i, %i)",
    (queueBytes, gracefulTimeoutMs, forceTerminationReserveMs) => {
      const document = mutateGolden((value) => {
        nested(value, "arwx").maximumQueuedBytesPerDirection = queueBytes;
        nested(value, "shutdown").gracefulTimeoutMs = gracefulTimeoutMs;
        nested(value, "shutdown").forceTerminationReserveMs = forceTerminationReserveMs;
      });
      expect(parseRuntimeBootstrap(document, "control").bootstrap.shutdown).toEqual({
        forceTerminationReserveMs,
        gracefulTimeoutMs,
      });
    },
  );

  const fieldMutations: readonly [string, (value: MutableJsonObject) => void][] = [
    ["protocolVersion", (value) => assign(value, "protocolVersion", "1.1")],
    ["type", (value) => assign(value, "type", "bootstrap")],
    ["bootstrapVersion", (value) => assign(value, "bootstrapVersion", 2)],
    [
      "bootstrapId",
      (value) => assign(value, "bootstrapId", "123e4567-e89b-12d3-a456-426614174000"),
    ],
    ["role", (value) => assign(value, "role", "other")],
    ["workerNodeId", (value) => assign(value, "workerNodeId", "bad node")],
    ["releaseId", (value) => assign(value, "releaseId", "bad release")],
    ["releaseTemplateSha256", (value) => assign(value, "releaseTemplateSha256", "A".repeat(64))],
    [
      "installationManifestSha256",
      (value) => assign(value, "installationManifestSha256", "A".repeat(64)),
    ],
    ["preflightSha256", (value) => assign(value, "preflightSha256", "A".repeat(64))],
    ["nodeBundleSha256", (value) => assign(value, "nodeBundleSha256", "A".repeat(64))],
    ["arwx.protocolMajor", (value) => assign(nested(value, "arwx"), "protocolMajor", 2)],
    ["arwx.minimumMinor", (value) => assign(nested(value, "arwx"), "minimumMinor", 1)],
    ["arwx.maximumMinor", (value) => assign(nested(value, "arwx"), "maximumMinor", 1)],
    [
      "arwx.maximumFrameBytes",
      (value) => assign(nested(value, "arwx"), "maximumFrameBytes", 1_048_575),
    ],
    [
      "arwx.queue minimum",
      (value) => assign(nested(value, "arwx"), "maximumQueuedBytesPerDirection", 1_048_575),
    ],
    [
      "arwx.queue maximum",
      (value) =>
        assign(nested(value, "arwx"), "maximumQueuedBytesPerDirection", 64 * 1_024 * 1_024 + 1),
    ],
    [
      "shutdown.gracefulTimeoutMs",
      (value) => assign(nested(value, "shutdown"), "gracefulTimeoutMs", 300_001),
    ],
    [
      "shutdown.gracefulTimeoutMs minimum",
      (value) => assign(nested(value, "shutdown"), "gracefulTimeoutMs", 999),
    ],
    [
      "shutdown.forceTerminationReserveMs",
      (value) => assign(nested(value, "shutdown"), "forceTerminationReserveMs", 120_000),
    ],
    [
      "shutdown.forceTerminationReserveMs minimum",
      (value) => assign(nested(value, "shutdown"), "forceTerminationReserveMs", 0),
    ],
    ["roleConfig.base64Url", (value) => assign(nested(value, "roleConfig"), "base64Url", "e30=")],
    ["roleConfig.byteLength", (value) => assign(nested(value, "roleConfig"), "byteLength", 70)],
    ["roleConfig.sha256", (value) => assign(nested(value, "roleConfig"), "sha256", "0".repeat(64))],
  ];

  it.each(fieldMutations)("rejects a mutated %s field", (_name, mutate) => {
    expect(() => parseRuntimeBootstrap(mutateGolden(mutate), "control")).toThrow(
      RuntimeBootstrapError,
    );
  });

  it.each(["\n", "\r", "\u2028", "\u2029"])(
    "rejects entity and release IDs with a final line terminator %#j",
    (terminator) => {
      const workerNodeDocument = mutateGolden((value) => {
        value.workerNodeId = `node${terminator}`;
      });
      const releaseDocument = mutateGolden((value) => {
        value.releaseId = `release${terminator}`;
      });
      expect(() => parseRuntimeBootstrap(workerNodeDocument, "control")).toThrow(
        RuntimeBootstrapError,
      );
      expect(() => parseRuntimeBootstrap(releaseDocument, "control")).toThrow(
        RuntimeBootstrapError,
      );
    },
  );

  it.each(["minimumMinor", "maximumMinor"])("rejects null %s", (field) => {
    const document = mutateGolden((value) => {
      nested(value, "arwx")[field] = null;
    });
    expect(() => parseRuntimeBootstrap(document, "control")).toThrow(RuntimeBootstrapError);
  });

  it.each([
    ["unknown top-level field", mutateGolden((value) => assign(value, "extra", true))],
    ["unknown nested field", mutateGolden((value) => assign(nested(value, "arwx"), "extra", true))],
    [
      "duplicate field",
      Buffer.from(
        readSharedGolden()
          .toString("utf8")
          .replace('"role":"control"', '"role":"control","role":"control"'),
        "utf8",
      ),
    ],
    ["noncanonical whitespace", Buffer.concat([readSharedGolden(), Buffer.from(" ")])],
    [
      "unsafe integer",
      Buffer.from(
        readSharedGolden().toString("utf8").replace("4194304", "9007199254740992"),
        "utf8",
      ),
    ],
    ["invalid UTF-8", Buffer.from([0xff])],
    ["oversized document", Buffer.alloc(RUNTIME_BOOTSTRAP_MAXIMUM_BYTES + 1, 0x78)],
  ])("rejects %s", (_name, document) => {
    expect(() => parseRuntimeBootstrap(document, "control")).toThrow(RuntimeBootstrapError);
  });

  it("enforces the decoded roleConfig and aggregate envelope limits independently", () => {
    const decodedLimitDescriptor = encodeHostControlOpaqueJson(
      { padding: "x".repeat(RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES - 14) },
      RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES,
    );
    const expanded = mutateGolden((value) => {
      value.roleConfig = decodedLimitDescriptor;
    });
    expect(expanded.byteLength).toBeGreaterThan(RUNTIME_BOOTSTRAP_MAXIMUM_BYTES);
    expect(() => parseRuntimeBootstrap(expanded, "control")).toThrowError(
      expect.objectContaining({ code: "INVALID_DOCUMENT" }),
    );

    const forgedDecodedOversize = mutateGolden((value) => {
      nested(value, "roleConfig").byteLength = RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES + 1;
    });
    expect(forgedDecodedOversize.byteLength).toBeLessThan(RUNTIME_BOOTSTRAP_MAXIMUM_BYTES);
    expect(() => parseRuntimeBootstrap(forgedDecodedOversize, "control")).toThrowError(
      expect.objectContaining({ code: "INVALID_DOCUMENT" }),
    );

    const fittingDescriptor = encodeHostControlOpaqueJson(
      { padding: "x".repeat(47_000) },
      RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES,
    );
    const fitting = mutateGolden((value) => {
      value.roleConfig = fittingDescriptor;
    });
    expect(fitting.byteLength).toBeLessThanOrEqual(RUNTIME_BOOTSTRAP_MAXIMUM_BYTES);
    expect(parseRuntimeBootstrap(fitting, "control").roleConfig).toEqual({
      padding: "x".repeat(47_000),
    });
  });

  it("rejects an opaque array even though its decimal JSON is otherwise valid", () => {
    const bytes = Buffer.from(`[0.8,1.7976931348623157e+308,5e-324]`, "utf8");
    const document = mutateGolden((value) => {
      value.roleConfig = {
        base64Url: bytes.toString("base64url"),
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    expect(() => parseRuntimeBootstrap(document, "control")).toThrowError(
      expect.objectContaining({ code: "INVALID_ROLE_CONFIG" }),
    );
  });

  it("snapshots bounded input before creating the ACK digest", () => {
    const source = readSharedGolden();
    const digest = createHash("sha256").update(source).digest("hex");
    const parsed = parseRuntimeBootstrap(source, "control");
    source.fill(0x78);
    expect(createRuntimeBootstrapAck(parsed).bootstrapSha256).toBe(digest);
    expect(() => parseRuntimeBootstrap("not bytes" as unknown as Uint8Array, "control")).toThrow(
      RuntimeBootstrapError,
    );
  });
});

function readSharedGolden(): Buffer {
  const path = new URL(
    "../../../../native/service-host/internal/localrpc/testdata/runtime_bootstrap_v1.json",
    import.meta.url,
  );
  const document = readFileSync(path);
  if (
    document.byteLength < 2 ||
    document[document.byteLength - 1] !== 0x0a ||
    document[document.byteLength - 2] === 0x0d
  ) {
    throw new Error("Runtime bootstrap golden must have exactly one LF repository delimiter.");
  }
  return Buffer.from(document.subarray(0, document.byteLength - 1));
}

function mutateGolden(mutate: (value: MutableJsonObject) => void): Buffer {
  const value = JSON.parse(readSharedGolden().toString("utf8")) as MutableJsonObject;
  mutate(value);
  return Buffer.from(serializeCanonicalJson(value), "utf8");
}

function nested(value: MutableJsonObject, key: string): MutableJsonObject {
  const candidate = value[key];
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`Expected ${key} to be an object.`);
  }
  return candidate as MutableJsonObject;
}

function assign(value: MutableJsonObject, key: string, candidate: unknown): void {
  value[key] = candidate;
}

function descriptorFor(bytes: Buffer): Readonly<Record<string, unknown>> {
  return Object.freeze({
    base64Url: bytes.toString("base64url"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
