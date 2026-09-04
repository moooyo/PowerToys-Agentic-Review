import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ArtifactStreamProtocolError, ArtifactStreamVerifier } from "./artifact-stream.js";
import { createCanonicalJsonDocument } from "./canonical.js";
import {
  type ExecutionCapabilityV1,
  LOCAL_CAPABILITY_AUDIENCE,
  type ValidatedExecutionCapability,
  validateExecutionCapabilityForContext,
} from "./capability.js";
import { type EstablishedLocalSession, establishLocalSession } from "./handshake.js";
import { encodeArtifactChunkData, type HelloAckMessage, type HelloMessage } from "./messages.js";

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
const now = 1_800_000_000_000;
const establishedSession = createEstablishedSession();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createVerifier(
  maximumArtifactBytes: bigint,
  options: {
    readonly maximumArtifactCount?: number;
    readonly maximumConcurrentArtifacts?: number;
  } = {},
  capabilityOverrides: Partial<ExecutionCapabilityV1> = {},
): ArtifactStreamVerifier {
  return new ArtifactStreamVerifier(
    createValidatedCapability(maximumArtifactBytes, capabilityOverrides),
    establishedSession,
    options,
  );
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
  const verifier = createVerifier(2n * 1024n * 1024n);
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

function chunkMessage(
  content: Uint8Array,
  chunkIndex: number,
  offsetBytes: number,
  id = artifactId,
) {
  return {
    ...session,
    artifactId: id,
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
    const verifier = createVerifier(2n * 1024n * 1024n);

    verifier.start(startMessage(content));
    expect(verifier.acceptChunk(chunkMessage(first, 0, 0))).toEqual({
      artifactId,
      chunkIndex: 0,
      offsetBytes: 0n,
      bytes: first,
    });
    expect(verifier.acceptChunk(chunkMessage(second, 1, first.byteLength))).toEqual({
      artifactId,
      chunkIndex: 1,
      offsetBytes: BigInt(first.byteLength),
      bytes: second,
    });
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
    const verifier = createVerifier(64n);
    verifier.start(startMessage(content));
    expect(() => verifier.acceptComplete(completeMessage(content))).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_STREAM_INCOMPLETE" }),
    );
  });

  it("accepts Failed as terminal, discards partial streams, and computes its digest", () => {
    const verifier = createVerifier(64n);
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
    const verifier = createVerifier(64n);
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

  it("fails closed at count, concurrency, authorized byte, and incomplete-stream limits", () => {
    const verifier = createVerifier(4n, {
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

  it("enforces the authorized byte ceiling across every artifact in the attempt", () => {
    const verifier = createVerifier(8n, {
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

  it("derives and snapshots the full session and attempt context from verified authority", () => {
    const verifier = createVerifier(64n);
    const content = Buffer.from("content", "utf8");
    verifier.start(startMessage(content));

    expect(verifier.acceptChunk(chunkMessage(content, 0, 0))).toMatchObject({
      artifactId,
      chunkIndex: 0,
      offsetBytes: 0n,
      bytes: content,
    });
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

  it("permanently fences every API after abort", () => {
    const content = Buffer.from("content", "utf8");
    const verifier = createVerifier(64n);
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

  it("rejects unvalidated authority and every capability-to-session context mismatch", () => {
    const capability = createValidatedCapability(64n);
    const unvalidatedCapability = createCapability(64n) as ValidatedExecutionCapability;
    const unestablishedSession = {
      hello: handshakeHello(),
      helloAck: handshakeHelloAck(),
    } as EstablishedLocalSession;

    expect(
      () => new ArtifactStreamVerifier(unvalidatedCapability, establishedSession),
    ).toThrowError(expect.objectContaining({ code: "ARTIFACT_AUTHORITY_INVALID" }));
    expect(() => new ArtifactStreamVerifier(capability, unestablishedSession)).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_AUTHORITY_INVALID" }),
    );

    for (const overrides of [
      { workerNodeId: "other-node" },
      { workerInstanceId: "other-instance" },
      { executorBootId: "70000000-0000-4000-8000-000000000007" },
      { sessionId: "80000000-0000-4000-8000-000000000008" },
    ]) {
      expect(
        () =>
          new ArtifactStreamVerifier(createValidatedCapability(64n, overrides), establishedSession),
      ).toThrowError(expect.objectContaining({ code: "ARTIFACT_CONTEXT_MISMATCH" }));
    }
  });

  it("returns frozen verified chunk routing metadata with an independent byte copy", () => {
    const secondArtifactId = "70000000-0000-4000-8000-000000000007";
    const first = Buffer.from("first", "utf8");
    const second = Buffer.from("second", "utf8");
    const verifier = createVerifier(64n, { maximumConcurrentArtifacts: 2 });
    verifier.start(startMessage(first, artifactId));
    verifier.start(startMessage(second, secondArtifactId, "log"));

    const acceptedSecond = verifier.acceptChunk(chunkMessage(second, 0, 0, secondArtifactId));
    const acceptedFirst = verifier.acceptChunk(chunkMessage(first, 0, 0, artifactId));

    expect(acceptedSecond).toEqual({
      artifactId: secondArtifactId,
      chunkIndex: 0,
      offsetBytes: 0n,
      bytes: second,
    });
    expect(acceptedFirst).toEqual({ artifactId, chunkIndex: 0, offsetBytes: 0n, bytes: first });
    expect(Object.isFrozen(acceptedSecond)).toBe(true);
    expect(acceptedSecond.bytes).not.toBe(second);
  });
});

function createCapability(
  maximumArtifactBytes: bigint,
  overrides: Partial<ExecutionCapabilityV1> = {},
): ExecutionCapabilityV1 {
  return {
    capabilityVersion: 1,
    canonicalizationVersion: 1,
    audience: LOCAL_CAPABILITY_AUDIENCE,
    capabilityId: "1".repeat(64),
    nonce: "2".repeat(64),
    workerNodeId: session.workerNodeId,
    workerInstanceId: session.workerInstanceId,
    executorBootId: session.executorBootId,
    sessionId: session.sessionId,
    attemptCorrelationId: session.attemptCorrelationId,
    runAttemptId: session.runAttemptId,
    jobId: "job-1",
    leaseGeneration: 7,
    grantSequence: 1,
    repository: { githubRepositoryId: 184456251, fullName: "microsoft/PowerToys" },
    targetRevision: { kind: "issue", revisionDigest: "3".repeat(64) },
    digests: {
      executorEnvelopeSha256: "4".repeat(64),
      promptSha256: "5".repeat(64),
      outputSchemaSha256: expectedOutputSchemaSha256,
      policySha256: "6".repeat(64),
      recipeSetSha256: "7".repeat(64),
    },
    operation: { kind: "static_review" },
    resources: {
      maximumProcesses: 4,
      memoryBytes: "134217728",
      outputBytes: 1_048_576,
      artifactBytes: maximumArtifactBytes.toString(),
      diskBytes: "67108864",
      hardTimeoutMs: 60_000,
    },
    issuedAtUnixMs: now,
    serverLeaseExpiresAtUnixMs: now + 90_000,
    grantExpiresAtUnixMs: now + 30_000,
    hardDeadlineUnixMs: now + 60_000,
    ...overrides,
  };
}

function createValidatedCapability(
  maximumArtifactBytes: bigint,
  overrides: Partial<ExecutionCapabilityV1> = {},
): ValidatedExecutionCapability {
  const capability = createCapability(maximumArtifactBytes, overrides);
  return validateExecutionCapabilityForContext(capability, {
    expectedWorkerNodeId: capability.workerNodeId,
    expectedWorkerInstanceId: capability.workerInstanceId,
    expectedExecutorBootId: capability.executorBootId,
    expectedSessionId: capability.sessionId,
    nowUnixMs: now + 1_000,
  });
}

function handshakeHello(): HelloMessage {
  return {
    protocolMajor: session.protocolMajor,
    minimumMinor: session.protocolMinor,
    maximumMinor: session.protocolMinor,
    workerNodeId: session.workerNodeId,
    workerInstanceId: session.workerInstanceId,
    executorBootId: null,
    sessionId: session.sessionId,
    controlNonce: "8".repeat(64),
    controlManifestSha256: "9".repeat(64),
    controlPreflightSha256: "a".repeat(64),
  };
}

function handshakeHelloAck(): HelloAckMessage {
  const hello = handshakeHello();
  return {
    protocolMajor: session.protocolMajor,
    protocolMinor: session.protocolMinor,
    workerNodeId: session.workerNodeId,
    workerInstanceId: session.workerInstanceId,
    executorBootId: session.executorBootId,
    sessionId: session.sessionId,
    controlNonce: hello.controlNonce,
    executorNonce: "b".repeat(64),
    executorManifestSha256: hello.controlManifestSha256,
    executorPolicySha256: "c".repeat(64),
    executorPreflightSha256: "d".repeat(64),
    maximumSlots: 4,
  };
}

function createEstablishedSession(): EstablishedLocalSession {
  const hello = handshakeHello();
  const helloAck = handshakeHelloAck();
  return establishLocalSession(hello, helloAck);
}
