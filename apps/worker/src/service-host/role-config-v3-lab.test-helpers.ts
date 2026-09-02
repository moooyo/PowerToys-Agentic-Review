import { readFileSync } from "node:fs";
import type { RuntimeBootstrapV2LabFacts } from "./runtime-bootstrap-v2-lab.js";

export const testExecutorPolicySha256 = "6".repeat(64);
export const testLocalAuthorityKeyId =
  "5cd252fb0ce8932436faf8ccd1040981b89ee4ad6b9fe9e2a2b7e71aacb27cd3";
export const testLocalAuthorityPublicKeySpki = Buffer.from(
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li_hp_m47n60p8D54WK84zV2sxXs7LtkBoN79R9Q",
  "base64url",
);

export function testCompressedP256PublicKeySpki(): Buffer {
  const path = new URL(
    "../../../../native/service-host/internal/roleconfigv3lab/testdata/p256_compressed_spki.base64url",
    import.meta.url,
  );
  const document = readFileSync(path);
  if (
    document.byteLength < 2 ||
    document[document.byteLength - 1] !== 0x0a ||
    document[document.byteLength - 2] === 0x0d
  ) {
    throw new Error("Compressed P-256 SPKI fixture must end in one LF.");
  }
  const encoded = document.subarray(0, document.byteLength - 1).toString("ascii");
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) {
    throw new Error("Compressed P-256 SPKI fixture must use canonical base64url.");
  }
  return decoded;
}

export function sharedLabGoldenLines(): readonly Buffer[] {
  const path = new URL(
    "../../../../native/service-host/internal/roleconfigv3lab/testdata/role_config_v3_lab.jsonl",
    import.meta.url,
  );
  const document = readFileSync(path);
  if (
    document.byteLength < 2 ||
    document[document.byteLength - 1] !== 0x0a ||
    document[document.byteLength - 2] === 0x0d ||
    document.includes(0x0d)
  ) {
    throw new Error("RoleConfig v3 lab golden must use one LF delimiter per record.");
  }
  const lines = document
    .subarray(0, document.byteLength - 1)
    .toString("utf8")
    .split("\n");
  if (lines.length !== 4) throw new Error("RoleConfig v3 lab golden must contain four records.");
  const expected = [
    [undefined, "control"],
    [undefined, "executor"],
    ["runtimeBootstrap", "control"],
    ["runtimeBootstrap", "executor"],
  ] as const;
  return Object.freeze(
    lines.map((line, index) => {
      const value = JSON.parse(line) as { readonly role?: unknown; readonly type?: unknown };
      const label = expected[index];
      if (label === undefined || value.type !== label[0] || value.role !== label[1]) {
        throw new Error(`RoleConfig v3 lab golden record ${index} has the wrong kind or role.`);
      }
      return Buffer.from(line, "utf8");
    }),
  );
}

export function bootstrapFacts(
  role: "control" | "executor",
  roleConfigDocument: Uint8Array,
): RuntimeBootstrapV2LabFacts {
  return {
    bootstrapId:
      role === "control"
        ? "123e4567-e89b-42d3-a456-426614174000"
        : "123e4567-e89b-42d3-a456-426614174001",
    forceTerminationReserveMs: 15_000,
    gracefulTimeoutMs: 120_000,
    installationManifestSha256: "2".repeat(64),
    maximumQueuedBytesPerDirection: 4 * 1_024 * 1_024,
    nodeBundleSha256: "4".repeat(64),
    preflightSha256: "3".repeat(64),
    releaseId: "2026.09.03-lab+1",
    releaseTemplateSha256: "1".repeat(64),
    role,
    roleConfigDocument,
    workerNodeId: "powertoys-node:01",
  };
}
