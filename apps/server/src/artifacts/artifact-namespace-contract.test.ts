import { describe, expect, it } from "vitest";
import {
  calculateArtifactNamespaceObservationSha256,
  parseArtifactNamespaceEntryKey,
  snapshotArtifactNamespaceObservation,
  snapshotArtifactNamespaceScanPageInput,
} from "../../dist/artifacts/artifact-namespace-contract.js";

const identity = {
  entryKey: "staging/70000000-0000-4000-8000-000000000001.upload",
  kind: "staging" as const,
  uploadId: "70000000-0000-4000-8000-000000000001",
  finalizationId: null,
  linkedObjectSha256: null,
  observedBytes: 1,
  expectedLinkCount: 1 as const,
  fileDevice: "1",
  fileInode: "2",
  fileCtimeNs: "3",
  fileMode: "384",
  fileUid: "1000",
  parentDevice: "1",
  parentInode: "4",
  parentMode: "448",
  parentUid: "1000",
  linkedObjectDevice: null,
  linkedObjectInode: null,
  linkedObjectCtimeNs: null,
};

describe("artifact namespace contract", () => {
  it("accepts only managed keys and binds every stable identity field into the digest", () => {
    expect(parseArtifactNamespaceEntryKey(identity.entryKey)).toMatchObject({
      kind: "staging",
      uploadId: identity.uploadId,
    });
    for (const key of [
      "../staging/70000000-0000-4000-8000-000000000001.upload",
      `objects/sha256/aa/${"a".repeat(64)}`,
      "staging/not-a-uuid.upload",
    ]) {
      expect(() => parseArtifactNamespaceEntryKey(key)).toThrow(TypeError);
    }
    const digest = calculateArtifactNamespaceObservationSha256(identity);
    expect(calculateArtifactNamespaceObservationSha256({ ...identity, fileCtimeNs: "4" })).not.toBe(
      digest,
    );
    expect(
      snapshotArtifactNamespaceObservation({ ...identity, observationSha256: digest }),
    ).toEqual({ ...identity, observationSha256: digest });
  });

  it("rejects accessor and oversized scan inputs without reading caller data", () => {
    let reads = 0;
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(input, {
      scanSessionId: {
        enumerable: true,
        get() {
          reads += 1;
          return "80000000-0000-4000-8000-000000000001";
        },
      },
      sweepGeneration: { enumerable: true, value: 0 },
      expectedAfterKey: { enumerable: true, value: null },
      maximumEntries: { enumerable: true, value: 1 },
    });
    expect(() => snapshotArtifactNamespaceScanPageInput(input)).toThrow(TypeError);
    expect(reads).toBe(0);
    expect(() =>
      snapshotArtifactNamespaceScanPageInput({
        scanSessionId: "80000000-0000-4000-8000-000000000001",
        sweepGeneration: 0,
        expectedAfterKey: null,
        maximumEntries: 257,
      }),
    ).toThrow(TypeError);
  });
});
