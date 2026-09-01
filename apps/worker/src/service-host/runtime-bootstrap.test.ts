import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { serializeCanonicalJson } from "@agentic-review/local-protocol";
import { describe, expect, it } from "vitest";
import { encodeHostControlOpaqueJson } from "./opaque-json.js";
import {
  bootstrapDocument,
  foundationRoleConfig,
  testExecutorPolicySha256,
  testLocalAuthorityKeyId,
} from "./runtime-bootstrap.test-helpers.js";
import {
  parseRuntimeBootstrap,
  parseRuntimeBootstrapCommit,
  RUNTIME_BOOTSTRAP_MAXIMUM_BYTES,
  RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES,
  RuntimeBootstrapError,
} from "./runtime-bootstrap.js";

type MutableJsonObject = Record<string, unknown>;

describe("RuntimeBootstrapV1", () => {
  it("parses the shared Go/TypeScript golden and binds its exact bytes", () => {
    const golden = readSharedGolden();
    const parsed = parseRuntimeBootstrap(golden, "control");

    expect(parsed.bootstrap).toMatchObject({
      protocolVersion: "1.0",
      type: "runtimeBootstrap",
      bootstrapVersion: 1,
      role: "control",
      workerNodeId: "powertoys-node:01",
    });
    expect(parsed.roleConfig).toEqual(foundationRoleConfig("control"));
    expect(parsed.localAuthorityPublicKey).toBeNull();
    expect(parsed.bootstrap.roleConfig).toEqual({
      base64Url:
        "eyJleGVjdXRpb25FbmFibGVkIjpmYWxzZSwiZXhlY3V0b3JQb2xpY3lTaGEyNTYiOiI2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2IiwiZm91bmRhdGlvblZlcnNpb24iOjIsImxvY2FsQXV0aG9yaXR5S2V5SWQiOiI1Y2QyNTJmYjBjZTg5MzI0MzZmYWY4Y2NkMTA0MDk4MWI4OWVlNGFkNmI5ZmU5ZTJhMmI3ZTcxYWFjYjI3Y2QzIiwibWF4aW11bVNsb3RzIjoxLCJyb2xlIjoiY29udHJvbCJ9",
      byteLength: 261,
      sha256: "c50978551cd0d98616fc5cdfaa041da4c45a6b3db99027aed05663ad8e81566b",
    });

    const digest = createHash("sha256").update(golden).digest("hex");
    expect(parsed.bootstrapSha256).toBe(digest);
    const commit = Buffer.from(
      serializeCanonicalJson({
        bootstrapId: parsed.bootstrap.bootstrapId,
        bootstrapSha256: digest,
        bootstrapVersion: 1,
        committed: true,
        protocolVersion: "1.0",
        role: "control",
        type: "runtimeBootstrapCommit",
      }),
      "utf8",
    );
    expect(parseRuntimeBootstrapCommit(commit, parsed).committed).toBe(true);
  });

  it("supports the exact executor role while binding the expected role", () => {
    const executor = bootstrapDocument("executor");
    const parsed = parseRuntimeBootstrap(executor, "executor");
    expect(parsed.bootstrap.role).toBe("executor");
    expect(parsed.roleConfig).toEqual(foundationRoleConfig("executor"));
    expect(parsed.localAuthorityPublicKey).toMatchObject({
      type: "public",
      asymmetricKeyType: "ec",
    });
    expect(() => parseRuntimeBootstrap(executor, "control")).toThrowError(
      expect.objectContaining({ code: "ROLE_MISMATCH" }),
    );
  });

  it.each([
    [
      "Control public-key bytes",
      "control" as const,
      {
        ...foundationRoleConfig("control"),
        localAuthorityPublicKeySpki: {
          base64Url: "AA",
          byteLength: 1,
          sha256: "0".repeat(64),
        },
      },
    ],
    [
      "missing Executor public-key bytes",
      "executor" as const,
      Object.fromEntries(
        Object.entries(foundationRoleConfig("executor")).filter(
          ([key]) => key !== "localAuthorityPublicKeySpki",
        ),
      ),
    ],
    [
      "wrong foundation version",
      "control" as const,
      { ...foundationRoleConfig("control"), foundationVersion: 1 },
    ],
    [
      "enabled execution",
      "executor" as const,
      { ...foundationRoleConfig("executor"), executionEnabled: true },
    ],
    [
      "nonfixed maximum slots",
      "executor" as const,
      { ...foundationRoleConfig("executor"), maximumSlots: 2 },
    ],
  ])("rejects %s in strict roleConfig v2", (_name, role, roleConfig) => {
    expect(() => parseRuntimeBootstrap(roleConfigDocument(role, roleConfig), role)).toThrowError(
      expect.objectContaining({ code: "INVALID_ROLE_CONFIG" }),
    );
  });

  it("requires the Executor descriptor digest, keyId, and DER bytes to agree", () => {
    const original = foundationRoleConfig("executor");
    const descriptor = original.localAuthorityPublicKeySpki as Readonly<Record<string, unknown>>;
    for (const roleConfig of [
      { ...original, localAuthorityKeyId: "0".repeat(64) },
      {
        ...original,
        localAuthorityPublicKeySpki: { ...descriptor, sha256: "0".repeat(64) },
      },
      {
        ...original,
        localAuthorityPublicKeySpki: { ...descriptor, byteLength: 90 },
      },
    ]) {
      expect(() =>
        parseRuntimeBootstrap(roleConfigDocument("executor", roleConfig), "executor"),
      ).toThrowError(expect.objectContaining({ code: "INVALID_ROLE_CONFIG" }));
    }
  });

  it("rejects non-DER and non-P-256 Executor public keys after exact descriptor validation", () => {
    const nonDer = Buffer.from("not DER", "utf8");
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({
      format: "der",
      type: "spki",
    });
    for (const bytes of [nonDer, Buffer.from(p384)]) {
      const keyId = createHash("sha256").update(bytes).digest("hex");
      const roleConfig = {
        ...foundationRoleConfig("executor"),
        localAuthorityKeyId: keyId,
        localAuthorityPublicKeySpki: {
          base64Url: bytes.toString("base64url"),
          byteLength: bytes.byteLength,
          sha256: keyId,
        },
      };
      expect(() =>
        parseRuntimeBootstrap(roleConfigDocument("executor", roleConfig), "executor"),
      ).toThrowError(expect.objectContaining({ code: "INVALID_ROLE_CONFIG" }));
    }
  });

  it.each([
    ["bootstrap ID", { bootstrapId: "123e4567-e89b-42d3-b456-426614174000" }],
    ["digest", { bootstrapSha256: "0".repeat(64) }],
    ["role", { role: "executor" }],
    ["commit state", { committed: false }],
    ["unknown field", { extra: true }],
  ])("rejects a RuntimeBootstrapCommitV1 with a mismatched %s", (_name, mutation) => {
    const bootstrap = readSharedGolden();
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
        ...mutation,
      }),
      "utf8",
    );
    expect(() => parseRuntimeBootstrapCommit(commit, parsed)).toThrow(RuntimeBootstrapError);
  });

  it("binds ACKs to opaque roleConfig exact bytes, not only parsed semantics", () => {
    const firstRoleConfig = Buffer.from(JSON.stringify(foundationRoleConfig("control")), "utf8");
    const secondRoleConfig = Buffer.from(
      ` { "executionEnabled" : false, "executorPolicySha256" : "${testExecutorPolicySha256}", "foundationVersion" : 2, "localAuthorityKeyId" : "${testLocalAuthorityKeyId}", "maximumSlots" : 1, "role" : "control" } `,
      "utf8",
    );
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
    const forgedDecodedOversize = mutateGolden((value) => {
      nested(value, "roleConfig").byteLength = RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES + 1;
    });
    expect(forgedDecodedOversize.byteLength).toBeLessThan(RUNTIME_BOOTSTRAP_MAXIMUM_BYTES);
    expect(() => parseRuntimeBootstrap(forgedDecodedOversize, "control")).toThrowError(
      expect.objectContaining({ code: "INVALID_DOCUMENT" }),
    );

    const unknownField = mutateGolden((value) => {
      value.roleConfig = encodeHostControlOpaqueJson(
        { ...foundationRoleConfig("control"), padding: "x".repeat(47_000) },
        RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES,
      );
    });
    expect(unknownField.byteLength).toBeLessThanOrEqual(RUNTIME_BOOTSTRAP_MAXIMUM_BYTES);
    expect(() => parseRuntimeBootstrap(unknownField, "control")).toThrowError(
      expect.objectContaining({ code: "INVALID_ROLE_CONFIG" }),
    );
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
    expect(parsed.bootstrapSha256).toBe(digest);
    expect(() => parseRuntimeBootstrap("not bytes" as unknown as Uint8Array, "control")).toThrow(
      RuntimeBootstrapError,
    );
  });
});

function readSharedGolden(): Buffer {
  // Biome must not reformat this wire fixture: Go and TypeScript bind its exact canonical bytes.
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

function roleConfigDocument(
  role: "control" | "executor",
  roleConfig: Readonly<Record<string, unknown>>,
): Buffer {
  const value = JSON.parse(readSharedGolden().toString("utf8")) as MutableJsonObject;
  value.role = role;
  value.roleConfig = encodeHostControlOpaqueJson(
    roleConfig,
    RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES,
  );
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
