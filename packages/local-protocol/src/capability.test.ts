import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createExecutionCapabilitySigningDigest,
  deriveCapabilityKeyId,
  digestExecutionCapability,
  digestRenewalGrant,
  type ExecutionCapabilityV1,
  LOCAL_CAPABILITY_AUDIENCE,
  LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
  LocalCapabilityError,
  signExecutionCapability,
  signRenewalGrant,
  validateExecutionCapability,
  verifyExecutionCapability,
  verifyRenewalGrant,
} from "./capability.js";

const now = 1_800_000_000_000;
const workerInstanceId = "10000000-0000-4000-8000-000000000001";
const executorBootId = "20000000-0000-4000-8000-000000000002";
const runAttemptId = "30000000-0000-4000-8000-000000000003";
const jobId = "40000000-0000-4000-8000-000000000004";
const sessionId = "50000000-0000-4000-8000-000000000005";
const hex = (character: string): string => character.repeat(64);

function capability(keyId = hex("a")): ExecutionCapabilityV1 {
  return {
    capabilityVersion: 1,
    canonicalizationVersion: 1,
    signatureAlgorithm: LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
    keyId,
    audience: LOCAL_CAPABILITY_AUDIENCE,
    capabilityId: hex("1"),
    nonce: hex("2"),
    workerNodeId: "powertoys-node-01",
    workerInstanceId,
    executorBootId,
    sessionId,
    attemptCorrelationId: runAttemptId,
    runAttemptId,
    jobId,
    leaseGeneration: 7,
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
      executorEnvelopeSha256: hex("3"),
      promptSha256: hex("4"),
      outputSchemaSha256: hex("5"),
      policySha256: hex("6"),
      recipeSetSha256: hex("7"),
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
    issuedAtUnixMs: now,
    serverLeaseExpiresAtUnixMs: now + 90_000,
    grantExpiresAtUnixMs: now + 45_000,
    hardDeadlineUnixMs: now + 1_800_000,
  };
}

function context(expectedKeyId = hex("a")) {
  return {
    expectedKeyId,
    expectedWorkerNodeId: "powertoys-node-01",
    expectedWorkerInstanceId: workerInstanceId,
    expectedExecutorBootId: executorBootId,
    expectedSessionId: sessionId,
    nowUnixMs: now + 1_000,
  } as const;
}

describe("execution capabilities", () => {
  it("pins the cross-language capability signing digest", () => {
    const vector: ExecutionCapabilityV1 = {
      ...capability(),
      workerInstanceId: "worker-instance:restart-7",
      runAttemptId: "attempt:pr:7",
      jobId: "job:pr:42",
      targetRevision: {
        kind: "pull_request",
        baseSha: "b".repeat(40),
        headSha: "c".repeat(64),
      },
      resources: {
        maximumProcesses: 8,
        memoryBytes: "1073741824",
        outputBytes: 1_048_576,
        artifactBytes: "2097152",
        diskBytes: "1073741824",
        hardTimeoutMs: 60_000,
      },
      serverLeaseExpiresAtUnixMs: now + 90_000,
      grantExpiresAtUnixMs: now + 30_000,
      hardDeadlineUnixMs: now + 60_000,
    };

    expect(createExecutionCapabilitySigningDigest(vector).toString("hex")).toBe(
      "8015fc8eed1746d31de5c250d13be33d732131da4c7a02899c6d9f697b32b139",
    );
  });

  it("supports issue revisions, future Git object widths, and non-UUID Server entity IDs", () => {
    const base = capability();
    expect(
      validateExecutionCapability({
        ...base,
        workerInstanceId: "worker-instance:restart-7",
        runAttemptId: "attempt:issue:7",
        jobId: "job:issue:42",
        targetRevision: { kind: "issue", revisionDigest: hex("d") },
      }),
    ).toMatchObject({
      runAttemptId: "attempt:issue:7",
      targetRevision: { kind: "issue", revisionDigest: hex("d") },
    });
    expect(
      validateExecutionCapability({
        ...base,
        targetRevision: {
          kind: "pull_request",
          baseSha: "a".repeat(64),
          headSha: "b".repeat(64),
        },
      }).targetRevision,
    ).toEqual({ kind: "pull_request", baseSha: "a".repeat(64), headSha: "b".repeat(64) });
  });

  it("validates, canonically digests, signs, and verifies a capability", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const keyId = deriveCapabilityKeyId(publicKey);
    const value = capability(keyId);
    const signed = signExecutionCapability(value, privateKey);

    expect(signed.signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(verifyExecutionCapability(signed, publicKey, context(keyId))).toEqual(value);
    expect(digestExecutionCapability(value)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects tampering, wrong keys, high-S signatures, and malformed signatures", () => {
    const first = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const second = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const keyId = deriveCapabilityKeyId(first.publicKey);
    const signed = signExecutionCapability(capability(keyId), first.privateKey);
    const altered = {
      ...signed,
      capability: { ...signed.capability, leaseGeneration: 8 },
    };
    expect(() => verifyExecutionCapability(altered, first.publicKey, context(keyId))).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_SIGNATURE_INVALID" }),
    );
    expect(() => verifyExecutionCapability(signed, second.publicKey, context(keyId))).toThrow(
      LocalCapabilityError,
    );

    const raw = Buffer.from(signed.signature, "base64url");
    const order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
    let lowS = 0n;
    for (const byte of raw.subarray(32)) lowS = (lowS << 8n) | BigInt(byte);
    let highS = order - lowS;
    for (let index = 63; index >= 32; index -= 1) {
      raw[index] = Number(highS & 0xffn);
      highS >>= 8n;
    }
    expect(() =>
      verifyExecutionCapability(
        { ...signed, signature: raw.toString("base64url") },
        first.publicKey,
        context(keyId),
      ),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_SIGNATURE_INVALID" }));
    expect(() =>
      verifyExecutionCapability(
        { ...signed, signature: `${signed.signature}=` },
        first.publicKey,
        context(keyId),
      ),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_SCHEMA_INVALID" }));
  });

  it("rejects unknown fields, forbidden lease material, bad bounds, and invalid deadlines", () => {
    expect(() => validateExecutionCapability({ ...capability(), leaseToken: "secret" })).toThrow(
      LocalCapabilityError,
    );
    expect(() =>
      validateExecutionCapability({
        ...capability(),
        resources: { ...capability().resources, memoryBytes: "01" },
      }),
    ).toThrow(LocalCapabilityError);
    expect(() =>
      validateExecutionCapability({
        ...capability(),
        resources: { ...capability().resources, diskBytes: "1024" },
      }),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_LIMIT_INVALID" }));
    expect(() =>
      validateExecutionCapability({ ...capability(), grantExpiresAtUnixMs: now + 45_001 }),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_TIME_INVALID" }));
  });

  it("binds key, worker, instance, boot, and expiry context", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const keyId = deriveCapabilityKeyId(publicKey);
    const signed = signExecutionCapability(capability(keyId), privateKey);
    for (const override of [
      { expectedKeyId: "wrong" },
      { expectedWorkerNodeId: "wrong" },
      { expectedWorkerInstanceId: "50000000-0000-4000-8000-000000000005" },
      { expectedExecutorBootId: "60000000-0000-4000-8000-000000000006" },
      { expectedSessionId: "70000000-0000-4000-8000-000000000007" },
    ]) {
      expect(() =>
        verifyExecutionCapability(signed, publicKey, { ...context(keyId), ...override }),
      ).toThrowError(expect.objectContaining({ code: "CAPABILITY_CONTEXT_MISMATCH" }));
    }
    expect(() =>
      verifyExecutionCapability(signed, publicKey, {
        ...context(keyId),
        nowUnixMs: now + 45_000,
      }),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_EXPIRED" }));
  });

  it("chains and verifies exact renewal grants", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const keyId = deriveCapabilityKeyId(publicKey);
    const original = capability(keyId);
    const previousGrantSha256 = digestExecutionCapability(original);
    const grant = {
      renewalVersion: 1 as const,
      canonicalizationVersion: 1 as const,
      signatureAlgorithm: LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
      keyId: original.keyId,
      audience: LOCAL_CAPABILITY_AUDIENCE,
      renewalId: hex("8"),
      capabilityId: original.capabilityId,
      nonce: hex("9"),
      workerNodeId: original.workerNodeId,
      workerInstanceId: original.workerInstanceId,
      executorBootId: original.executorBootId,
      sessionId: original.sessionId,
      attemptCorrelationId: original.attemptCorrelationId,
      runAttemptId: original.runAttemptId,
      jobId: original.jobId,
      leaseGeneration: original.leaseGeneration,
      grantSequence: 2,
      previousGrantSequence: 1,
      serverHeartbeatSequence: 10,
      initialCapabilitySha256: previousGrantSha256,
      previousGrantSha256,
      issuedAtUnixMs: now + 30_000,
      serverLeaseExpiresAtUnixMs: now + 120_000,
      grantExpiresAtUnixMs: now + 75_000,
      hardDeadlineUnixMs: original.hardDeadlineUnixMs,
    };
    const signed = signRenewalGrant(grant, privateKey);
    expect(
      verifyRenewalGrant(signed, publicKey, {
        ...context(keyId),
        nowUnixMs: now + 31_000,
        capability: original,
        expectedPreviousGrantSha256: previousGrantSha256,
        expectedPreviousGrantSequence: 1,
        expectedGrantSequence: 2,
      }),
    ).toEqual(grant);
    expect(digestRenewalGrant(grant)).toMatch(/^[a-f0-9]{64}$/u);

    expect(() =>
      verifyRenewalGrant(signed, publicKey, {
        ...context(keyId),
        nowUnixMs: now + 31_000,
        capability: original,
        expectedPreviousGrantSha256: previousGrantSha256,
        expectedPreviousGrantSequence: 1,
        expectedGrantSequence: 3,
      }),
    ).toThrowError(expect.objectContaining({ code: "RENEWAL_SEQUENCE_INVALID" }));
  });

  it("rejects non-P256 and private/public key role confusion", () => {
    const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    expect(() => signExecutionCapability(capability(), p384.privateKey)).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_KEY_INVALID" }),
    );
    expect(() => signExecutionCapability(capability(), p256.publicKey)).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_KEY_INVALID" }),
    );
  });
});
