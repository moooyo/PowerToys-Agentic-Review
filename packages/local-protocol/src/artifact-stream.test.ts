import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ArtifactStreamProtocolError, ArtifactStreamVerifier } from "./artifact-stream.js";
import { encodeArtifactChunkData } from "./messages.js";

const runAttemptId = "30000000-0000-4000-8000-000000000003";
const session = {
  protocolMajor: 1 as const,
  protocolMinor: 0 as const,
  workerNodeId: "powertoys-node-01",
  workerInstanceId: "10000000-0000-4000-8000-000000000001",
  executorBootId: "20000000-0000-4000-8000-000000000002",
  sessionId: "50000000-0000-4000-8000-000000000005",
  attemptCorrelationId: runAttemptId,
  runAttemptId,
};
const artifactId = "60000000-0000-4000-8000-000000000006";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function startMessage(content: Uint8Array, id = artifactId) {
  return {
    ...session,
    artifactId: id,
    purpose: "result" as const,
    name: "result.json",
    mediaType: "application/json",
    totalBytes: content.byteLength.toString(),
    sha256: sha256(content),
  };
}

function chunkMessage(content: Uint8Array, chunkIndex: number, offsetBytes: number) {
  return {
    ...session,
    artifactId,
    chunkIndex,
    offsetBytes: offsetBytes.toString(),
    ...encodeArtifactChunkData(content),
  };
}

describe("ArtifactStreamVerifier", () => {
  it("streams contiguous chunks without retaining complete artifact bytes", () => {
    const first = Buffer.from('{"summary":', "utf8");
    const second = Buffer.from('"ok"}', "utf8");
    const content = Buffer.concat([first, second]);
    const verifier = new ArtifactStreamVerifier({
      runAttemptId,
      attemptCorrelationId: runAttemptId,
      maximumArtifactBytes: 2n * 1024n * 1024n,
    });

    verifier.start(startMessage(content));
    expect(verifier.acceptChunk(chunkMessage(first, 0, 0))).toEqual(first);
    expect(verifier.acceptChunk(chunkMessage(second, 1, first.byteLength))).toEqual(second);
    expect(
      verifier.end({
        ...session,
        artifactId,
        chunkCount: 2,
        totalBytes: content.byteLength.toString(),
        sha256: sha256(content),
      }),
    ).toEqual({
      artifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: BigInt(content.byteLength),
      sha256: sha256(content),
      chunkCount: 2,
    });
    verifier.assertComplete();
  });

  it("rejects duplicates, out-of-order chunks, overflow, and bad terminal metadata", () => {
    const content = Buffer.from("content", "utf8");
    const verifier = new ArtifactStreamVerifier({
      runAttemptId,
      attemptCorrelationId: runAttemptId,
      maximumArtifactBytes: 64n,
    });
    verifier.start(startMessage(content));
    expect(() => verifier.start(startMessage(content))).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_DUPLICATE" }),
    );
    expect(() => verifier.acceptChunk(chunkMessage(content, 1, 0))).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_SEQUENCE_INVALID" }),
    );
    verifier.acceptChunk(chunkMessage(content, 0, 0));
    expect(() =>
      verifier.end({
        ...session,
        artifactId,
        chunkCount: 1,
        totalBytes: content.byteLength.toString(),
        sha256: "f".repeat(64),
      }),
    ).toThrowError(expect.objectContaining({ code: "ARTIFACT_DIGEST_MISMATCH" }));
  });

  it("fails closed at count, concurrency, signed byte, and incomplete-stream limits", () => {
    const verifier = new ArtifactStreamVerifier({
      runAttemptId,
      attemptCorrelationId: runAttemptId,
      maximumArtifactBytes: 4n,
      maximumArtifactCount: 1,
      maximumConcurrentArtifacts: 1,
    });
    expect(() => verifier.start(startMessage(Buffer.from("12345")))).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_LIMIT_EXCEEDED" }),
    );
    verifier.start(startMessage(Buffer.from("1234")));
    expect(() => verifier.assertComplete()).toThrow(ArtifactStreamProtocolError);
    verifier.abort();
    verifier.assertComplete();
  });

  it("enforces the signed byte ceiling across every artifact in the attempt", () => {
    const verifier = new ArtifactStreamVerifier({
      runAttemptId,
      attemptCorrelationId: runAttemptId,
      maximumArtifactBytes: 8n,
      maximumConcurrentArtifacts: 2,
    });
    verifier.start(startMessage(Buffer.from("1234"), artifactId));
    expect(() =>
      verifier.start(startMessage(Buffer.from("56789"), "70000000-0000-4000-8000-000000000007")),
    ).toThrowError(expect.objectContaining({ code: "ARTIFACT_LIMIT_EXCEEDED" }));

    verifier.abort();
    expect(() =>
      verifier.start(startMessage(Buffer.from("56789"), "80000000-0000-4000-8000-000000000008")),
    ).toThrowError(expect.objectContaining({ code: "ARTIFACT_LIMIT_EXCEEDED" }));
  });
});
