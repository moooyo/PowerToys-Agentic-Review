import { generateKeyPairSync, type KeyObject, sign as nodeSign } from "node:crypto";
import type { RunTerminalResponse } from "@agentic-review/contracts";
import {
  ArtifactStreamVerifier,
  createCanonicalJsonDocument,
  createHandshakeTranscriptSigningBytes,
  createHandshakeTranscriptV1,
  createSignedHandshakeProofV1,
  deriveCapabilityKeyId,
  type ExecutionCapabilityV1,
  type HandshakeTranscriptV1,
  type HelloAckMessage,
  type HelloMessage,
  LOCAL_CAPABILITY_AUDIENCE,
  LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
  signExecutionCapability,
  type VerifiedExecutionCapability,
  type VerifiedHandshakeTranscriptV1,
  verifyExecutionCapability,
  verifySignedHandshakeProofV1,
} from "@agentic-review/local-protocol";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { PreparedLocalExecutionStart } from "./executor-envelope.js";
import {
  createLocalExecutionCancellation,
  type LocalExecutionBroker,
} from "./local-execution-broker.js";
import {
  type LocalExecutionTerminalDecision,
  mapRunTerminalResponseOutcome,
  prepareLocalExecutionRenewal,
  prepareLocalTerminalDecision,
} from "./local-execution-run.js";

const identity = { jobId: "job-1", runAttemptId: "run-1" } as const;
const authorityNow = 1_800_000_000_000;
const p256Order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const p256HalfOrder = p256Order >> 1n;
const authorityKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const authorityKeyId = deriveCapabilityKeyId(authorityKeys.publicKey);
const artifactSession = {
  protocolMajor: 1 as const,
  protocolMinor: 0 as const,
  workerNodeId: "worker-node-1",
  workerInstanceId: "worker-instance-1",
  executorBootId: "20000000-0000-4000-8000-000000000002",
  sessionId: "30000000-0000-4000-8000-000000000003",
  attemptCorrelationId: "40000000-0000-4000-8000-000000000004",
};
const artifactHandshake = createVerifiedArtifactHandshake();

describe("mapRunTerminalResponseOutcome", () => {
  it.each([
    ["succeeded", "succeeded", "committed"],
    ["retry_waiting", "failed", "retry_scheduled"],
    ["cancelled", "cancelled", "cancelled"],
    ["failed", "failed", "committed"],
    ["dead_letter", "failed", "committed"],
  ] as const)("maps %s/%s to %s", (jobState, runState, expected) => {
    expect(mapRunTerminalResponseOutcome({ ...identity, jobState, runState })).toBe(expected);
  });

  it("rejects a schema-valid but semantically inconsistent terminal response", () => {
    const response: RunTerminalResponse = {
      ...identity,
      jobState: "cancelled",
      runState: "failed",
    };
    expect(() => mapRunTerminalResponseOutcome(response)).toThrow(/states are inconsistent/u);
  });

  it("prepares one deeply frozen decision bound to verified terminal and run identity", () => {
    const response: RunTerminalResponse & { extra?: string } = {
      ...identity,
      jobState: "retry_waiting",
      runState: "failed",
    };
    const terminal = verifiedFailure();
    const decision = prepareLocalTerminalDecision(
      identity,
      terminal,
      response,
      "retain_for_janitor",
      1_800_000_000_000,
    );
    response.jobState = "failed";
    response.extra = "later mutation";

    expect(decision).toMatchObject({
      runIdentity: identity,
      serverResponse: { ...identity, jobState: "retry_waiting", runState: "failed" },
      terminalPayloadSha256: terminal.terminalPayloadSha256,
      outcome: "retry_scheduled",
      workspaceDisposition: "retain_for_janitor",
      decidedAtUnixMs: 1_800_000_000_000,
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.runIdentity)).toBe(true);
    expect(Object.isFrozen(decision.serverResponse)).toBe(true);
    expect(decision.serverResponse).not.toHaveProperty("extra");
    expectTypeOf<Extract<keyof LocalExecutionTerminalDecision, string>>().toEqualTypeOf<
      | "runIdentity"
      | "serverResponse"
      | "terminalPayloadSha256"
      | "outcome"
      | "workspaceDisposition"
      | "decidedAtUnixMs"
    >();
  });

  it("rejects cross-run, malformed, and structurally forged terminal evidence", () => {
    const response = { ...identity, jobState: "retry_waiting", runState: "failed" } as const;
    expect(() =>
      prepareLocalTerminalDecision(
        { jobId: "job-1", runAttemptId: "other-run" },
        verifiedFailure(),
        response,
        "delete",
        1,
      ),
    ).toThrow(/another execution run/u);
    expect(() =>
      prepareLocalTerminalDecision(identity, verifiedFailure("other-run"), response, "delete", 1),
    ).toThrow(/another execution run/u);
    expect(() =>
      prepareLocalTerminalDecision(
        identity,
        {
          ...verifiedFailure(),
          terminalPayloadSha256: "f".repeat(64),
        },
        response,
        "delete",
        1,
      ),
    ).toThrow(/not produced by ArtifactStreamVerifier/u);
    expect(() =>
      prepareLocalTerminalDecision(
        identity,
        verifiedFailure(),
        { ...response, extra: true },
        "delete",
        1,
      ),
    ).toThrow(/strict schema/u);
  });
});

describe("prepareLocalExecutionRenewal", () => {
  const start = {
    attemptCorrelationId: "1000000a-0000-4000-8000-000000000001",
    authorityBasis: {
      leaseGeneration: 7,
      observedAtMonotonicMilliseconds: 10,
      remainingHardDeadlineMilliseconds: 50_000,
    },
    executorEnvelope: { runAttemptId: "run-1" },
  } as unknown as PreparedLocalExecutionStart;

  it("accepts heartbeat sequence zero and returns only lease-token-free timing evidence", () => {
    const prepared = prepareLocalExecutionRenewal(start, {
      runAttemptId: "run-1",
      leaseGeneration: 7,
      serverHeartbeatSequence: 0,
      observedAtMonotonicMilliseconds: 12.1,
      remainingLeaseMilliseconds: 44_997.9,
      action: "continue",
    });

    expect(prepared).toEqual({
      attemptCorrelationId: "1000000a-0000-4000-8000-000000000001",
      runAttemptId: "run-1",
      leaseGeneration: 7,
      serverHeartbeatSequence: 0,
      observedAtMonotonicMilliseconds: 13,
      remainingLeaseMilliseconds: 44_997,
      remainingHardDeadlineMilliseconds: 49_997,
      action: "continue",
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(JSON.stringify(prepared)).not.toContain("leaseToken");
  });

  it.each([
    [{ runAttemptId: "other-run" }, "RENEWAL_IDENTITY_MISMATCH"],
    [{ leaseGeneration: 8 }, "RENEWAL_IDENTITY_MISMATCH"],
    [{ action: "stale" as "continue" }, "RENEWAL_ACTION_INVALID"],
    [{ serverHeartbeatSequence: -1 }, "RENEWAL_SEQUENCE_INVALID"],
    [{ remainingLeaseMilliseconds: 0 }, "RENEWAL_TIMING_INVALID"],
    [{ remainingLeaseMilliseconds: 49_999 }, "RENEWAL_TIMING_INVALID"],
    [{ observedAtMonotonicMilliseconds: 9 }, "RENEWAL_TIMING_INVALID"],
    [{ observedAtMonotonicMilliseconds: 50_010 }, "RENEWAL_TIMING_INVALID"],
    [{ observedAtMonotonicMilliseconds: Number.NaN }, "RENEWAL_TIMING_INVALID"],
    [{ remainingLeaseMilliseconds: Number.POSITIVE_INFINITY }, "RENEWAL_TIMING_INVALID"],
  ] as const)("rejects invalid renewal evidence %#j", (change, code) => {
    expect(() =>
      prepareLocalExecutionRenewal(start, {
        runAttemptId: "run-1",
        leaseGeneration: 7,
        serverHeartbeatSequence: 1,
        observedAtMonotonicMilliseconds: 12,
        remainingLeaseMilliseconds: 45_000,
        action: "drain",
        ...change,
      }),
    ).toThrowError(expect.objectContaining({ code }));
  });
});

describe("LocalExecutionBroker boundary", () => {
  it("exposes prepared data and a runtime cancellation facade without reason or Event", () => {
    expectTypeOf<
      Parameters<LocalExecutionBroker["start"]>[0]
    >().toEqualTypeOf<PreparedLocalExecutionStart>();
    expectTypeOf<keyof Parameters<LocalExecutionBroker["start"]>[1]>().toEqualTypeOf<
      "aborted" | "subscribe"
    >();

    const source = new AbortController();
    const cancellation = createLocalExecutionCancellation(source.signal);
    let callbackArgumentCount = -1;
    cancellation.subscribe((...argumentsList: unknown[]) => {
      callbackArgumentCount = argumentsList.length;
    });
    source.abort({ leaseToken: "server-secret" });

    expect(cancellation.aborted).toBe(true);
    expect(callbackArgumentCount).toBe(0);
    expect("reason" in cancellation).toBe(false);
    expect("addEventListener" in cancellation).toBe(false);
  });
});

function verifiedFailure(runAttemptId: string = identity.runAttemptId) {
  const context = {
    ...artifactSession,
    runAttemptId,
  };
  const terminal = {
    ...context,
    code: "CODEX_FAILED",
    message: "Codex failed.",
    retryable: true,
    failedAtUnixMs: 1_800_000_000_000,
  };
  const verifier = new ArtifactStreamVerifier(
    createVerifiedArtifactCapability(runAttemptId),
    artifactHandshake,
  );
  const verified = verifier.acceptFailed(terminal);
  expect(verified.terminalPayloadSha256).toBe(createCanonicalJsonDocument(terminal).sha256);
  return verified;
}

function createVerifiedArtifactCapability(runAttemptId: string): VerifiedExecutionCapability {
  const capability: ExecutionCapabilityV1 = {
    capabilityVersion: 1,
    canonicalizationVersion: 1,
    signatureAlgorithm: LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
    keyId: authorityKeyId,
    audience: LOCAL_CAPABILITY_AUDIENCE,
    capabilityId: "1".repeat(64),
    nonce: "2".repeat(64),
    workerNodeId: artifactSession.workerNodeId,
    workerInstanceId: artifactSession.workerInstanceId,
    executorBootId: artifactSession.executorBootId,
    sessionId: artifactSession.sessionId,
    attemptCorrelationId: artifactSession.attemptCorrelationId,
    runAttemptId,
    jobId: identity.jobId,
    leaseGeneration: 7,
    grantSequence: 1,
    repository: { githubRepositoryId: 184456251, fullName: "microsoft/PowerToys" },
    targetRevision: { kind: "issue", revisionDigest: "3".repeat(64) },
    digests: {
      executorEnvelopeSha256: "4".repeat(64),
      promptSha256: "5".repeat(64),
      outputSchemaSha256: "a".repeat(64),
      policySha256: "6".repeat(64),
      recipeSetSha256: "7".repeat(64),
    },
    operation: { kind: "static_review" },
    resources: {
      maximumProcesses: 4,
      memoryBytes: "134217728",
      outputBytes: 1_048_576,
      artifactBytes: "64",
      diskBytes: "1048576",
      hardTimeoutMs: 60_000,
    },
    issuedAtUnixMs: authorityNow,
    serverLeaseExpiresAtUnixMs: authorityNow + 90_000,
    grantExpiresAtUnixMs: authorityNow + 30_000,
    hardDeadlineUnixMs: authorityNow + 60_000,
  };
  return verifyExecutionCapability(
    signExecutionCapability(capability, authorityKeys.privateKey),
    authorityKeys.publicKey,
    {
      expectedKeyId: authorityKeyId,
      expectedWorkerNodeId: capability.workerNodeId,
      expectedWorkerInstanceId: capability.workerInstanceId,
      expectedExecutorBootId: capability.executorBootId,
      expectedSessionId: capability.sessionId,
      nowUnixMs: authorityNow + 1_000,
    },
  );
}

function createVerifiedArtifactHandshake(): VerifiedHandshakeTranscriptV1 {
  const hello: HelloMessage = {
    protocolMajor: artifactSession.protocolMajor,
    minimumMinor: artifactSession.protocolMinor,
    maximumMinor: artifactSession.protocolMinor,
    workerNodeId: artifactSession.workerNodeId,
    workerInstanceId: artifactSession.workerInstanceId,
    executorBootId: null,
    sessionId: artifactSession.sessionId,
    controlNonce: "8".repeat(64),
    controlManifestSha256: "9".repeat(64),
    controlPreflightSha256: "a".repeat(64),
  };
  const helloAck: HelloAckMessage = {
    protocolMajor: artifactSession.protocolMajor,
    protocolMinor: artifactSession.protocolMinor,
    workerNodeId: artifactSession.workerNodeId,
    workerInstanceId: artifactSession.workerInstanceId,
    executorBootId: artifactSession.executorBootId,
    sessionId: artifactSession.sessionId,
    controlNonce: hello.controlNonce,
    executorNonce: "b".repeat(64),
    executorManifestSha256: hello.controlManifestSha256,
    executorPolicySha256: "c".repeat(64),
    executorPreflightSha256: "d".repeat(64),
    maximumSlots: 4,
  };
  const transcript = createHandshakeTranscriptV1(hello, helloAck, authorityKeyId);
  const proof = createSignedHandshakeProofV1(
    transcript,
    signArtifactTranscript(transcript, authorityKeys.privateKey),
  );
  return verifySignedHandshakeProofV1(proof, authorityKeys.publicKey, {
    expectedKeyId: authorityKeyId,
    expectedHello: hello,
    expectedHelloAck: helloAck,
  });
}

function signArtifactTranscript(transcript: HandshakeTranscriptV1, privateKey: KeyObject): Buffer {
  const result = Buffer.from(
    nodeSign("sha256", createHandshakeTranscriptSigningBytes(transcript), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }),
  );
  const s = readUnsigned(result.subarray(32));
  if (s > p256HalfOrder) writeUnsigned(p256Order - s, result, 32);
  return result;
}

function readUnsigned(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function writeUnsigned(value: bigint, target: Uint8Array, offset: number): void {
  let remaining = value;
  for (let index = offset + 31; index >= offset; index -= 1) {
    target[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}
