import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ArtifactStreamProtocolError, ArtifactStreamVerifier } from "./artifact-stream.js";
import { createCanonicalJsonDocument } from "./canonical.js";
import { encodeArtifactChunkData } from "./messages.js";

const runAttemptId = "30000000-0000-4000-8000-000000000003";
const attemptCorrelationId = "40000000-0000-4000-8000-000000000004";
const session = {
  protocolMajor: 1 as const,
  protocolMinor: 0 as const,
  workerNodeId: "powertoys-node-01",
  workerInstanceId: "10000000-0000-4000-8000-000000000001",
  executorBootId: "20000000-0000-4000-8000-000000000002",
  sessionId: "50000000-0000-4000-8000-000000000005",
  attemptCorrelationId,
  runAttemptId,
};
const artifactId = "60000000-0000-4000-8000-000000000006";
const expectedOutputSchemaSha256 = "a".repeat(64);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function startMessage(content: Uint8Array, id = artifactId, purpose: "result" | "log" = "result") {
  return {
    ...session,
    artifactId: id,
    purpose,
    name: "result.json",
    mediaType: "application/json",
    totalBytes: content.byteLength.toString(),
    sha256: sha256(content),
  };
}

function completeMessage(content: Uint8Array, outputSchemaSha256 = "a".repeat(64)) {
  return {
    ...session,
    resultArtifactId: artifactId,
    resultBytes: content.byteLength.toString(),
    resultSha256: sha256(content),
    outputSchemaSha256,
    completedAtUnixMs: 1_800_000_000_000,
  };
}

function completedVerifier(content: Uint8Array, purpose: "result" | "log" = "result") {
  const verifier = new ArtifactStreamVerifier({
    ...session,
    maximumArtifactBytes: 2n * 1024n * 1024n,
    expectedOutputSchemaSha256,
  });
  verifier.start(startMessage(content, artifactId, purpose));
  verifier.acceptChunk(chunkMessage(content, 0, 0));
  verifier.end({
    ...session,
    artifactId,
    chunkCount: 1,
    totalBytes: content.byteLength.toString(),
    sha256: sha256(content),
  });
  return verifier;
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
      ...session,
      maximumArtifactBytes: 2n * 1024n * 1024n,
      expectedOutputSchemaSha256,
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

  it("binds Complete to the unique verified result artifact and output schema", () => {
    const content = Buffer.from('{"summary":"ok"}', "utf8");
    const verifier = completedVerifier(content);
    const terminal = completeMessage(content);
    const completed = verifier.acceptComplete(terminal);

    expect(completed).toMatchObject({
      terminal,
      terminalPayloadSha256: createCanonicalJsonDocument(terminal).sha256,
      resultArtifact: {
        artifactId,
        purpose: "result",
        totalBytes: BigInt(content.byteLength),
        sha256: sha256(content),
      },
    });
    expect(Object.isFrozen(completed)).toBe(true);
    expect(Object.isFrozen(completed.terminal)).toBe(true);
    expect(Object.isFrozen(completed.resultArtifact)).toBe(true);
    expect(() => verifier.acceptComplete(terminal)).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_TERMINAL_REPLAYED" }),
    );
  });

  it.each([
    ["unseen artifact", { resultArtifactId: "70000000-0000-4000-8000-000000000007" }, "result"],
    ["wrong length", { resultBytes: "1" }, "result"],
    ["wrong digest", { resultSha256: "f".repeat(64) }, "result"],
    ["wrong schema", { outputSchemaSha256: "b".repeat(64) }, "result"],
    ["log artifact", {}, "log"],
  ] as const)("rejects Complete with %s", (_name, change, purpose) => {
    const content = Buffer.from('{"summary":"ok"}', "utf8");
    const verifier = completedVerifier(content, purpose);
    const terminal = { ...completeMessage(content), ...change };
    expect(() => verifier.acceptComplete(terminal)).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_TERMINAL_MISMATCH" }),
    );
  });

  it("rejects Complete while an artifact stream is incomplete", () => {
    const content = Buffer.from("content", "utf8");
    const verifier = new ArtifactStreamVerifier({
      ...session,
      maximumArtifactBytes: 64n,
      expectedOutputSchemaSha256,
    });
    verifier.start(startMessage(content));
    expect(() => verifier.acceptComplete(completeMessage(content))).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_STREAM_INCOMPLETE" }),
    );
  });

  it("accepts Failed as terminal, discards partial streams, and computes its digest", () => {
    const verifier = new ArtifactStreamVerifier({
      ...session,
      maximumArtifactBytes: 64n,
      expectedOutputSchemaSha256,
    });
    verifier.start(startMessage(Buffer.from("partial", "utf8")));
    const terminal = {
      ...session,
      code: "CODEX_FAILED",
      message: "Codex failed.",
      retryable: true,
      failedAtUnixMs: 1_800_000_000_000,
    };
    expect(verifier.acceptFailed(terminal)).toEqual({
      terminal,
      terminalPayloadSha256: createCanonicalJsonDocument(terminal).sha256,
    });
    verifier.assertComplete();
    expect(() => verifier.start(startMessage(Buffer.from("later", "utf8")))).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_TERMINAL_REPLAYED" }),
    );
  });

  it("rejects duplicates, out-of-order chunks, overflow, and bad terminal metadata", () => {
    const content = Buffer.from("content", "utf8");
    const verifier = new ArtifactStreamVerifier({
      ...session,
      maximumArtifactBytes: 64n,
      expectedOutputSchemaSha256,
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
    expect(
      verifier.end({
        ...session,
        artifactId,
        chunkCount: 1,
        totalBytes: content.byteLength.toString(),
        sha256: sha256(content),
      }),
    ).toMatchObject({ artifactId, sha256: sha256(content) });
  });

  it("fails closed at count, concurrency, signed byte, and incomplete-stream limits", () => {
    const verifier = new ArtifactStreamVerifier({
      ...session,
      maximumArtifactBytes: 4n,
      expectedOutputSchemaSha256,
      maximumArtifactCount: 1,
      maximumConcurrentArtifacts: 1,
    });
    expect(() => verifier.start(startMessage(Buffer.from("12345")))).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_LIMIT_EXCEEDED" }),
    );
    verifier.start(startMessage(Buffer.from("1234")));
    expect(() => verifier.assertComplete()).toThrow(ArtifactStreamProtocolError);
    verifier.abort();
    expect(() => verifier.assertComplete()).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_ABORTED" }),
    );
  });

  it("enforces the signed byte ceiling across every artifact in the attempt", () => {
    const verifier = new ArtifactStreamVerifier({
      ...session,
      maximumArtifactBytes: 8n,
      expectedOutputSchemaSha256,
      maximumConcurrentArtifacts: 2,
    });
    verifier.start(startMessage(Buffer.from("1234"), artifactId));
    expect(() =>
      verifier.start(startMessage(Buffer.from("56789"), "70000000-0000-4000-8000-000000000007")),
    ).toThrowError(expect.objectContaining({ code: "ARTIFACT_LIMIT_EXCEEDED" }));

    verifier.abort();
    expect(() =>
      verifier.start(startMessage(Buffer.from("56789"), "80000000-0000-4000-8000-000000000008")),
    ).toThrowError(expect.objectContaining({ code: "ARTIFACT_ABORTED" }));
  });

  it("snapshots the full session and attempt context at construction", () => {
    const options = {
      ...session,
      maximumArtifactBytes: 64n,
      expectedOutputSchemaSha256,
    };
    const verifier = new ArtifactStreamVerifier(options);
    const content = Buffer.from("content", "utf8");
    verifier.start(startMessage(content));

    options.workerNodeId = "mutated-node";
    options.sessionId = "90000000-0000-4000-8000-000000000009";
    options.attemptCorrelationId = "a0000000-0000-4000-8000-00000000000a";
    options.runAttemptId = "mutated-attempt";

    expect(verifier.acceptChunk(chunkMessage(content, 0, 0))).toEqual(content);
    expect(() =>
      verifier.end({
        ...session,
        workerNodeId: "other-node",
        artifactId,
        chunkCount: 1,
        totalBytes: content.byteLength.toString(),
        sha256: sha256(content),
      }),
    ).toThrowError(expect.objectContaining({ code: "ARTIFACT_CONTEXT_MISMATCH" }));
    expect(
      verifier.end({
        ...session,
        artifactId,
        chunkCount: 1,
        totalBytes: content.byteLength.toString(),
        sha256: sha256(content),
      }),
    ).toMatchObject({ artifactId });
  });

  it("binds the output schema at construction and permanently fences every API after abort", () => {
    expect(
      () =>
        new ArtifactStreamVerifier({
          ...session,
          maximumArtifactBytes: 64n,
          expectedOutputSchemaSha256: "invalid",
        }),
    ).toThrow(TypeError);

    const content = Buffer.from("content", "utf8");
    const verifier = new ArtifactStreamVerifier({
      ...session,
      maximumArtifactBytes: 64n,
      expectedOutputSchemaSha256,
    });
    verifier.abort();
    verifier.abort();
    const failed = {
      ...session,
      code: "CODEX_FAILED",
      message: "Codex failed.",
      retryable: true,
      failedAtUnixMs: 1_800_000_000_000,
    };
    const end = {
      ...session,
      artifactId,
      chunkCount: 1,
      totalBytes: content.byteLength.toString(),
      sha256: sha256(content),
    };
    for (const action of [
      () => verifier.start(startMessage(content)),
      () => verifier.acceptChunk(chunkMessage(content, 0, 0)),
      () => verifier.end(end),
      () => verifier.acceptComplete(completeMessage(content)),
      () => verifier.acceptFailed(failed),
      () => verifier.assertComplete(),
    ]) {
      expect(action).toThrowError(expect.objectContaining({ code: "ARTIFACT_ABORTED" }));
    }
  });
});
