import { describe, expect, it } from "vitest";
import { createCanonicalJsonDocument, serializeCanonicalJson } from "./canonical.js";
import {
  type ExecutionCapabilityV1,
  LOCAL_CAPABILITY_AUDIENCE,
  LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
  sha256Hex,
} from "./capability.js";
import { LocalMessageType } from "./framing.js";
import {
  assertLocalMessageSender,
  type ExecutorJobEnvelopeV1,
  encodeArtifactChunkData,
  HANDSHAKE_TRANSCRIPT_VERSION,
  LOCAL_ARTIFACT_CHUNK_MAXIMUM_BYTES,
  LOCAL_HANDSHAKE_AUDIENCE,
  LocalMessageValidationError,
  validateLocalMessagePayload,
} from "./messages.js";

const nil = "00000000-0000-0000-0000-000000000000";
const workerInstanceId = "10000000-0000-4000-8000-000000000001";
const executorBootId = "20000000-0000-4000-8000-000000000002";
const runAttemptId = "30000000-0000-4000-8000-000000000003";
const jobId = "40000000-0000-4000-8000-000000000004";
const sessionId = "50000000-0000-4000-8000-000000000005";
const artifactId = "60000000-0000-4000-8000-000000000006";
const hex = (character: string): string => character.repeat(64);

const session = {
  protocolMajor: 1 as const,
  protocolMinor: 0 as const,
  workerNodeId: "powertoys-node-01",
  workerInstanceId,
  executorBootId,
  sessionId,
};
const attempt = { ...session, attemptCorrelationId: runAttemptId, runAttemptId } as const;

function envelope(): ExecutorJobEnvelopeV1 {
  const outputSchemaJson = serializeCanonicalJson({
    additionalProperties: false,
    properties: { summary: { type: "string" } },
    required: ["summary"],
    type: "object",
  });
  const renderedPrompt = "Review this PowerToys change.";
  const canonicalSnapshotJson = serializeCanonicalJson({
    projectionVersion: 1,
    repository: {
      githubRepositoryId: 184456251,
      fullName: "microsoft/PowerToys",
    },
    resource: {
      kind: "pull_request",
      githubNodeId: "PR_kwDOAv9ZBc5-test",
      number: 123,
      title: "Improve PowerToys Run",
      author: {
        githubUserId: 42,
        login: "contributor",
        accountType: "user",
        githubNodeId: "MDQ6VXNlcjQy",
      },
      revision: {
        kind: "pull_request",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
    },
    body: { state: "complete", text: "Pull request body" },
  });
  return {
    envelopeVersion: 1,
    jobId,
    runAttemptId,
    jobKind: "pull_request_review",
    priority: 10,
    attempt: 1,
    maxAttempts: 3,
    generation: 3,
    intentVersion: 1,
    semanticKey: "powertoys/pr/123/head",
    repository: {
      githubRepositoryId: 184456251,
      fullName: "microsoft/PowerToys",
    },
    resource: {
      kind: "pull_request",
      githubNodeId: "PR_kwDOAv9ZBc5-test",
      number: 123,
      title: "Improve PowerToys Run",
      author: {
        githubUserId: 42,
        login: "contributor",
        accountType: "user",
        githubNodeId: "MDQ6VXNlcjQy",
      },
      canonicalSnapshotJson,
      canonicalSnapshotSha256: sha256Hex(canonicalSnapshotJson),
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      isDraft: false,
    },
    prompt: {
      name: "pr-review",
      version: "1",
      renderedPrompt,
      promptSha256: sha256Hex(renderedPrompt),
      outputSchemaJson,
      outputSchemaSha256: sha256Hex(outputSchemaJson),
    },
    policy: {
      hardTimeoutMs: 1_800_000,
      noProgressTimeoutMs: 300_000,
      maxCodexTurns: 8,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {},
    },
  };
}

function capability(localEnvelope: ExecutorJobEnvelopeV1): ExecutionCapabilityV1 {
  return {
    capabilityVersion: 1,
    canonicalizationVersion: 1,
    signatureAlgorithm: LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
    keyId: hex("a"),
    audience: LOCAL_CAPABILITY_AUDIENCE,
    capabilityId: hex("1"),
    nonce: hex("2"),
    workerNodeId: session.workerNodeId,
    workerInstanceId,
    executorBootId,
    sessionId,
    attemptCorrelationId: runAttemptId,
    runAttemptId,
    jobId,
    leaseGeneration: 3,
    grantSequence: 1,
    repository: {
      githubRepositoryId: 184456251,
      fullName: "microsoft/PowerToys",
    },
    targetRevision: {
      kind: "pull_request",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    digests: {
      executorEnvelopeSha256: createCanonicalJsonDocument(localEnvelope).sha256,
      promptSha256: localEnvelope.prompt.promptSha256,
      outputSchemaSha256: localEnvelope.prompt.outputSchemaSha256,
      policySha256: createCanonicalJsonDocument(localEnvelope.policy).sha256,
      recipeSetSha256: createCanonicalJsonDocument([]).sha256,
    },
    operation: { kind: "static_review" },
    resources: {
      maximumProcesses: 32,
      memoryBytes: "8589934592",
      outputBytes: 8_388_608,
      artifactBytes: "2147483648",
      diskBytes: "17179869184",
      hardTimeoutMs: 1_800_000,
    },
    issuedAtUnixMs: 1_800_000_000_000,
    serverLeaseExpiresAtUnixMs: 1_800_000_090_000,
    grantExpiresAtUnixMs: 1_800_000_045_000,
    hardDeadlineUnixMs: 1_800_001_800_000,
  };
}

describe("local protocol message schemas", () => {
  it("pins message direction without restricting bidirectional liveness probes", () => {
    expect(() => assertLocalMessageSender(LocalMessageType.StartAttempt, "control")).not.toThrow();
    expect(() => assertLocalMessageSender(LocalMessageType.StartAttempt, "executor")).toThrow(
      LocalMessageValidationError,
    );
    expect(() => assertLocalMessageSender(LocalMessageType.ControlProof, "control")).not.toThrow();
    expect(() => assertLocalMessageSender(LocalMessageType.ControlProof, "executor")).toThrow(
      LocalMessageValidationError,
    );
    expect(() => assertLocalMessageSender(LocalMessageType.Ping, "control")).not.toThrow();
    expect(() => assertLocalMessageSender(LocalMessageType.Ping, "executor")).not.toThrow();
  });

  it("rejects capability-label keys and values outside the strict record schema", () => {
    const localEnvelope = envelope();
    for (const requiredCapabilityLabels of [
      { "invalid key": "value" },
      { [`a${"b".repeat(64)}`]: "value" },
      { valid: { nested: true } },
    ]) {
      expect(() =>
        validateLocalMessagePayload(
          LocalMessageType.StartAttempt,
          {
            ...attempt,
            signedAuthorization: {
              capability: capability(localEnvelope),
              signature: "A".repeat(86),
            },
            executorEnvelope: {
              ...localEnvelope,
              policy: { ...localEnvelope.policy, requiredCapabilityLabels },
            },
          },
          runAttemptId,
        ),
      ).toThrowError(expect.objectContaining({ code: "MESSAGE_SCHEMA_INVALID" }));
    }
  });

  it("strictly validates session lifecycle messages", () => {
    const hello = {
      protocolMajor: 1,
      minimumMinor: 0,
      maximumMinor: 0,
      workerNodeId: session.workerNodeId,
      workerInstanceId,
      executorBootId: null,
      sessionId,
      controlNonce: hex("1"),
      controlManifestSha256: hex("2"),
      controlPreflightSha256: hex("3"),
    };
    expect(validateLocalMessagePayload(LocalMessageType.Hello, hello, nil)).toEqual(hello);
    expect(() =>
      validateLocalMessagePayload(LocalMessageType.Hello, { ...hello, command: "cmd.exe" }, nil),
    ).toThrow(LocalMessageValidationError);

    const helloAck = {
      ...session,
      controlNonce: hello.controlNonce,
      executorNonce: hex("4"),
      executorManifestSha256: hello.controlManifestSha256,
      executorPolicySha256: hex("6"),
      executorPreflightSha256: hex("7"),
      maximumSlots: 4,
    };
    const controlProof = {
      ...session,
      signedProof: {
        transcript: {
          transcriptVersion: HANDSHAKE_TRANSCRIPT_VERSION,
          canonicalizationVersion: 1,
          signatureAlgorithm: LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
          keyId: hex("8"),
          audience: LOCAL_HANDSHAKE_AUDIENCE,
          hello,
          helloAck,
        },
        signature: "A".repeat(86),
      },
    };
    expect(validateLocalMessagePayload(LocalMessageType.ControlProof, controlProof, nil)).toEqual(
      controlProof,
    );
    expect(() =>
      validateLocalMessagePayload(
        LocalMessageType.ControlProof,
        { ...controlProof, sessionId: "90000000-0000-4000-8000-000000000009" },
        nil,
      ),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_CONTEXT_MISMATCH" }));
    expect(() =>
      validateLocalMessagePayload(
        LocalMessageType.ControlProof,
        {
          ...controlProof,
          signedProof: { ...controlProof.signedProof, privateKey: "must-not-cross" },
        },
        nil,
      ),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_SCHEMA_INVALID" }));

    const ready = {
      ...session,
      controlNonce: hex("1"),
      executorNonce: hex("2"),
      executorManifestSha256: hex("3"),
      executorPolicySha256: hex("4"),
      executorPreflightSha256: hex("5"),
      isolationMode: "split-service-v1",
      ready: true,
      availableSlots: 4,
      reasonCode: null,
    };
    expect(validateLocalMessagePayload(LocalMessageType.Ready, ready, nil)).toEqual(ready);
    expect(() =>
      validateLocalMessagePayload(LocalMessageType.Ready, { ...ready, availableSlots: 0 }, nil),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_CONTEXT_MISMATCH" }));
  });

  it("binds StartAttempt identities and every signed digest", () => {
    const localEnvelope = envelope();
    const signedAuthorization = {
      capability: capability(localEnvelope),
      signature: "A".repeat(86),
    };
    const start = { ...attempt, signedAuthorization, executorEnvelope: localEnvelope };
    expect(validateLocalMessagePayload(LocalMessageType.StartAttempt, start, runAttemptId)).toEqual(
      start,
    );
    expect(() =>
      validateLocalMessagePayload(
        LocalMessageType.StartAttempt,
        {
          ...start,
          executorEnvelope: { ...localEnvelope, semanticKey: "changed" },
        },
        runAttemptId,
      ),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_DIGEST_MISMATCH" }));
    expect(() =>
      validateLocalMessagePayload(LocalMessageType.StartAttempt, start, jobId),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_CONTEXT_MISMATCH" }));
  });

  it("deeply freezes validated StartAttempt authority and execution data", () => {
    const localEnvelope = envelope();
    const start = {
      ...attempt,
      signedAuthorization: {
        capability: capability(localEnvelope),
        signature: "A".repeat(86),
      },
      executorEnvelope: localEnvelope,
    };
    const validated = validateLocalMessagePayload(
      LocalMessageType.StartAttempt,
      start,
      runAttemptId,
    ) as typeof start;

    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.signedAuthorization.capability.resources)).toBe(true);
    expect(Object.isFrozen(validated.signedAuthorization.capability.digests)).toBe(true);
    expect(Object.isFrozen(validated.executorEnvelope.policy.allowedRecipeIds)).toBe(true);
    expect(() => {
      (validated.executorEnvelope.policy.allowedRecipeIds as string[]).push("changed");
    }).toThrow();
  });

  it("requires the strict snapshot projection schema and matching outer identity", () => {
    const original = envelope();
    const projection = JSON.parse(original.resource.canonicalSnapshotJson) as Record<
      string,
      unknown
    >;
    for (const changedProjection of [
      { ...projection, leaseToken: "must-not-cross" },
      {
        ...projection,
        resource: {
          ...(projection.resource as Record<string, unknown>),
          title: "Different title",
        },
      },
    ]) {
      const canonicalSnapshotJson = serializeCanonicalJson(changedProjection);
      const changedEnvelope: ExecutorJobEnvelopeV1 = {
        ...original,
        resource: {
          ...original.resource,
          canonicalSnapshotJson,
          canonicalSnapshotSha256: sha256Hex(canonicalSnapshotJson),
        },
      };
      const start = {
        ...attempt,
        signedAuthorization: {
          capability: capability(changedEnvelope),
          signature: "A".repeat(86),
        },
        executorEnvelope: changedEnvelope,
      };
      expect(() =>
        validateLocalMessagePayload(LocalMessageType.StartAttempt, start, runAttemptId),
      ).toThrowError(
        expect.objectContaining({
          code: Object.hasOwn(changedProjection, "leaseToken")
            ? "MESSAGE_SCHEMA_INVALID"
            : "MESSAGE_CONTEXT_MISMATCH",
        }),
      );
    }
  });

  it("maps malformed embedded JSON to the local message error boundary", () => {
    const localEnvelope = envelope();
    const start = {
      ...attempt,
      signedAuthorization: {
        capability: capability(localEnvelope),
        signature: "A".repeat(86),
      },
      executorEnvelope: localEnvelope,
    };
    const tooDeep = `${'{"value":'.repeat(66)}0${"}".repeat(66)}`;
    for (const outputSchemaJson of ["{]", '{"b":2,"a":1}', tooDeep]) {
      expect(() =>
        validateLocalMessagePayload(
          LocalMessageType.StartAttempt,
          {
            ...start,
            executorEnvelope: {
              ...localEnvelope,
              prompt: { ...localEnvelope.prompt, outputSchemaJson },
            },
          },
          runAttemptId,
        ),
      ).toThrowError(expect.objectContaining({ code: "MESSAGE_ENCODING_INVALID" }));
    }
    for (const canonicalSnapshotJson of ["{]", '{"b":2,"a":1}', tooDeep]) {
      expect(() =>
        validateLocalMessagePayload(
          LocalMessageType.StartAttempt,
          {
            ...start,
            executorEnvelope: {
              ...localEnvelope,
              resource: { ...localEnvelope.resource, canonicalSnapshotJson },
            },
          },
          runAttemptId,
        ),
      ).toThrowError(expect.objectContaining({ code: "MESSAGE_ENCODING_INVALID" }));
    }
  });

  it("binds issue jobs to their revision digest without requiring Git commit IDs", () => {
    const base = envelope();
    const revisionDigest = hex("d");
    const canonicalSnapshotJson = serializeCanonicalJson({
      projectionVersion: 1,
      repository: base.repository,
      resource: {
        kind: "issue",
        githubNodeId: "I_kwDOAv9ZBc5-test",
        number: 456,
        title: "PowerToys issue",
        author: base.resource.author,
        revision: { kind: "issue", revisionDigest },
      },
      body: { state: "complete", text: "Issue body" },
    });
    const issueEnvelope: ExecutorJobEnvelopeV1 = {
      ...base,
      jobKind: "issue_triage",
      resource: {
        kind: "issue",
        githubNodeId: "I_kwDOAv9ZBc5-test",
        number: 456,
        title: "PowerToys issue",
        author: base.resource.author,
        canonicalSnapshotJson,
        canonicalSnapshotSha256: sha256Hex(canonicalSnapshotJson),
        revisionDigest,
      },
    };
    const issueCapability: ExecutionCapabilityV1 = {
      ...capability(issueEnvelope),
      targetRevision: { kind: "issue", revisionDigest },
    };
    const start = {
      ...attempt,
      signedAuthorization: { capability: issueCapability, signature: "A".repeat(86) },
      executorEnvelope: issueEnvelope,
    };
    expect(validateLocalMessagePayload(LocalMessageType.StartAttempt, start, runAttemptId)).toEqual(
      start,
    );
    expect(() =>
      validateLocalMessagePayload(
        LocalMessageType.StartAttempt,
        {
          ...start,
          signedAuthorization: {
            ...start.signedAuthorization,
            capability: {
              ...issueCapability,
              targetRevision: { kind: "issue", revisionDigest: hex("e") },
            },
          },
        },
        runAttemptId,
      ),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_CONTEXT_MISMATCH" }));
  });

  it("requires a streamed result artifact instead of embedding a large result", () => {
    const complete = {
      ...attempt,
      resultArtifactId: artifactId,
      resultBytes: "2097152",
      resultSha256: hex("a"),
      outputSchemaSha256: hex("b"),
      completedAtUnixMs: 1_800_000_010_000,
    };
    expect(validateLocalMessagePayload(LocalMessageType.Complete, complete, runAttemptId)).toEqual(
      complete,
    );
    expect(() =>
      validateLocalMessagePayload(
        LocalMessageType.Complete,
        { ...complete, result: { summary: "embedded" } },
        runAttemptId,
      ),
    ).toThrow(LocalMessageValidationError);
  });

  it("encodes and validates artifact chunks at the exact decoded-byte limit", () => {
    const bytes = Buffer.alloc(LOCAL_ARTIFACT_CHUNK_MAXIMUM_BYTES, 0xa5);
    const encoded = encodeArtifactChunkData(bytes);
    const chunk = {
      ...attempt,
      artifactId,
      chunkIndex: 0,
      offsetBytes: "0",
      ...encoded,
    };
    expect(
      validateLocalMessagePayload(LocalMessageType.ArtifactChunk, chunk, runAttemptId),
    ).toEqual(chunk);
    expect(() =>
      encodeArtifactChunkData(Buffer.alloc(LOCAL_ARTIFACT_CHUNK_MAXIMUM_BYTES + 1)),
    ).toThrow(LocalMessageValidationError);
    expect(() =>
      validateLocalMessagePayload(
        LocalMessageType.ArtifactChunk,
        { ...chunk, chunkBytes: encoded.chunkBytes - 1 },
        runAttemptId,
      ),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_LIMIT_EXCEEDED" }));
  });

  it("rejects noncanonical base64url, artifact overflows, and bad chunk digests", () => {
    const encoded = encodeArtifactChunkData(Buffer.from("chunk"));
    const chunk = {
      ...attempt,
      artifactId,
      chunkIndex: 0,
      offsetBytes: "0",
      ...encoded,
    };
    for (const mutation of [
      { data: `${encoded.data}=` },
      { chunkSha256: hex("f") },
      { offsetBytes: (64n * 1024n * 1024n * 1024n + 1n).toString() },
    ]) {
      expect(() =>
        validateLocalMessagePayload(
          LocalMessageType.ArtifactChunk,
          { ...chunk, ...mutation },
          runAttemptId,
        ),
      ).toThrow(LocalMessageValidationError);
    }
  });

  it("enforces nil session correlation and exact attempt correlation", () => {
    const ping = { ...session, probeId: hex("1"), sentAtUnixMs: 1_800_000_000_000 };
    expect(validateLocalMessagePayload(LocalMessageType.Ping, ping, nil)).toEqual(ping);
    expect(() =>
      validateLocalMessagePayload(LocalMessageType.Ping, ping, runAttemptId),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_CONTEXT_MISMATCH" }));

    const failed = {
      ...attempt,
      code: "CODEX_FAILED",
      message: "Codex did not return a valid result.",
      retryable: true,
      failedAtUnixMs: 1_800_000_010_000,
    };
    expect(validateLocalMessagePayload(LocalMessageType.Failed, failed, runAttemptId)).toEqual(
      failed,
    );
    expect(() => validateLocalMessagePayload(LocalMessageType.Failed, failed, nil)).toThrowError(
      expect.objectContaining({ code: "MESSAGE_CONTEXT_MISMATCH" }),
    );
  });

  it("uses an explicit terminal disposition handshake before workspace cleanup", () => {
    const disposition = {
      ...attempt,
      dispositionId: hex("d"),
      terminalPayloadSha256: hex("e"),
      outcome: "committed",
      workspaceDisposition: "delete",
      decidedAtUnixMs: 1_800_000_020_000,
    };
    expect(
      validateLocalMessagePayload(LocalMessageType.TerminalDisposition, disposition, runAttemptId),
    ).toEqual(disposition);
    expect(() =>
      validateLocalMessagePayload(
        LocalMessageType.TerminalDisposition,
        { ...disposition, leaseToken: "must-never-cross" },
        runAttemptId,
      ),
    ).toThrow(LocalMessageValidationError);

    const acknowledgement = {
      ...attempt,
      dispositionId: disposition.dispositionId,
      processCount: 0,
      cleanupOutcome: "deleted",
      acknowledgedAtUnixMs: 1_800_000_021_000,
    };
    expect(
      validateLocalMessagePayload(LocalMessageType.TerminalAck, acknowledgement, runAttemptId),
    ).toEqual(acknowledgement);
  });
});
