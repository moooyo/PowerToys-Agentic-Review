import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  deriveCapabilityKeyId,
  digestExecutionCapability,
  type ExecutionCapabilityV1,
  LOCAL_CAPABILITY_AUDIENCE,
  LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
  signExecutionCapability,
  signRenewalGrant,
  type VerifiedExecutionCapability,
  verifyExecutionCapability,
  verifyRenewalGrant,
} from "./capability.js";
import { LocalAuthorityReplayError, LocalAuthorityReplayGuard } from "./replay.js";

const hex = (value: string): string => value.repeat(64);
const now = 1_800_000_000_000;
const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const keyId = deriveCapabilityKeyId(keys.publicKey);

function capability(capabilityId = hex("1")): ExecutionCapabilityV1 {
  return {
    capabilityVersion: 1,
    canonicalizationVersion: 1,
    signatureAlgorithm: LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
    keyId,
    audience: LOCAL_CAPABILITY_AUDIENCE,
    capabilityId,
    nonce: hex("2"),
    workerNodeId: "node-1",
    workerInstanceId: "instance-1",
    executorBootId: "20000000-0000-4000-8000-000000000002",
    sessionId: "50000000-0000-4000-8000-000000000005",
    attemptCorrelationId: "30000000-0000-4000-8000-000000000003",
    runAttemptId: "attempt-1",
    jobId: "job-1",
    leaseGeneration: 1,
    grantSequence: 1,
    repository: { githubRepositoryId: 1, fullName: "microsoft/PowerToys" },
    targetRevision: {
      kind: "pull_request",
      baseSha: "b".repeat(40),
      headSha: "c".repeat(64),
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
      maximumProcesses: 8,
      memoryBytes: "1073741824",
      outputBytes: 1_048_576,
      artifactBytes: "2097152",
      diskBytes: "1073741824",
      hardTimeoutMs: 60_000,
    },
    issuedAtUnixMs: now,
    serverLeaseExpiresAtUnixMs: now + 90_000,
    grantExpiresAtUnixMs: now + 30_000,
    hardDeadlineUnixMs: now + 60_000,
  };
}

function renewal(
  initial: ExecutionCapabilityV1,
  previousDigest: string,
  serverHeartbeatSequence = 10,
) {
  return {
    renewalVersion: 1 as const,
    canonicalizationVersion: 1 as const,
    signatureAlgorithm: LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
    keyId: initial.keyId,
    audience: LOCAL_CAPABILITY_AUDIENCE,
    renewalId: hex("8"),
    capabilityId: initial.capabilityId,
    nonce: hex("9"),
    workerNodeId: initial.workerNodeId,
    workerInstanceId: initial.workerInstanceId,
    executorBootId: initial.executorBootId,
    sessionId: initial.sessionId,
    attemptCorrelationId: initial.attemptCorrelationId,
    runAttemptId: initial.runAttemptId,
    jobId: initial.jobId,
    leaseGeneration: initial.leaseGeneration,
    grantSequence: 2,
    previousGrantSequence: 1,
    serverHeartbeatSequence,
    initialCapabilitySha256: digestExecutionCapability(initial),
    previousGrantSha256: previousDigest,
    issuedAtUnixMs: now + 20_000,
    serverLeaseExpiresAtUnixMs: now + 120_000,
    grantExpiresAtUnixMs: now + 50_000,
    hardDeadlineUnixMs: initial.hardDeadlineUnixMs,
  };
}

function verifiedCapability(value = capability()): VerifiedExecutionCapability {
  return verifyExecutionCapability(
    signExecutionCapability(value, keys.privateKey),
    keys.publicKey,
    {
      expectedKeyId: keyId,
      expectedWorkerNodeId: value.workerNodeId,
      expectedWorkerInstanceId: value.workerInstanceId,
      expectedExecutorBootId: value.executorBootId,
      expectedSessionId: value.sessionId,
      nowUnixMs: now + 1_000,
    },
  );
}

function verifiedRenewal(
  initial: VerifiedExecutionCapability,
  value: ReturnType<typeof renewal>,
  expected: ReturnType<LocalAuthorityReplayGuard["expectedRenewal"]>,
) {
  return verifyRenewalGrant(signRenewalGrant(value, keys.privateKey), keys.publicKey, {
    expectedKeyId: keyId,
    expectedWorkerNodeId: initial.workerNodeId,
    expectedWorkerInstanceId: initial.workerInstanceId,
    expectedExecutorBootId: initial.executorBootId,
    expectedSessionId: initial.sessionId,
    nowUnixMs: now + 21_000,
    capability: initial,
    ...expected,
  });
}

describe("LocalAuthorityReplayGuard", () => {
  it("reserves each capability once and advances an exact renewal chain", () => {
    const initial = verifiedCapability();
    const guard = new LocalAuthorityReplayGuard();
    guard.reserveVerifiedCapability(initial);
    expect(() => guard.reserveVerifiedCapability(initial)).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_REPLAYED" }),
    );

    const expected = guard.expectedRenewal(initial.capabilityId);
    const next = verifiedRenewal(
      initial,
      renewal(initial, expected.expectedPreviousGrantSha256),
      expected,
    );
    guard.acceptVerifiedRenewal(next);
    expect(guard.expectedRenewal(initial.capabilityId)).toMatchObject({
      expectedPreviousGrantSequence: 2,
      expectedGrantSequence: 3,
      expectedPreviousServerHeartbeatSequence: 10,
    });
    expect(() => guard.acceptVerifiedRenewal(next)).toThrowError(
      expect.objectContaining({ code: "RENEWAL_CHAIN_INVALID" }),
    );
  });

  it("accepts the initial successful heartbeat sequence zero exactly once", () => {
    const initial = verifiedCapability();
    const guard = new LocalAuthorityReplayGuard();
    guard.reserveVerifiedCapability(initial);
    const expected = guard.expectedRenewal(initial.capabilityId);
    expect(expected.expectedPreviousServerHeartbeatSequence).toBe(-1);

    const first = verifiedRenewal(
      initial,
      renewal(initial, expected.expectedPreviousGrantSha256, 0),
      expected,
    );
    guard.acceptVerifiedRenewal(first);
    expect(
      guard.expectedRenewal(initial.capabilityId).expectedPreviousServerHeartbeatSequence,
    ).toBe(0);
    const nextExpected = guard.expectedRenewal(initial.capabilityId);
    const repeatedHeartbeat = verifiedRenewal(
      initial,
      {
        ...first,
        grantSequence: 3,
        previousGrantSequence: 2,
        previousGrantSha256: nextExpected.expectedPreviousGrantSha256,
        renewalId: hex("b"),
        nonce: hex("c"),
      },
      { ...nextExpected, expectedPreviousServerHeartbeatSequence: -1 },
    );
    expect(() => guard.acceptVerifiedRenewal(repeatedHeartbeat)).toThrowError(
      expect.objectContaining({ code: "RENEWAL_REPLAYED" }),
    );
  });

  it("never revives a terminal capability", () => {
    const initial = verifiedCapability();
    const guard = new LocalAuthorityReplayGuard();
    guard.reserveVerifiedCapability(initial);
    const expected = guard.expectedRenewal(initial.capabilityId);
    const next = verifiedRenewal(
      initial,
      renewal(initial, expected.expectedPreviousGrantSha256),
      expected,
    );
    guard.markTerminal(initial.capabilityId);
    expect(guard.isActive(initial.capabilityId)).toBe(false);
    expect(() => guard.expectedRenewal(initial.capabilityId)).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_TERMINAL" }),
    );
    expect(() => guard.acceptVerifiedRenewal(next)).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_TERMINAL" }),
    );
  });

  it("synchronously fences stale capabilities before cancellation completes", () => {
    const initial = verifiedCapability();
    const guard = new LocalAuthorityReplayGuard();
    guard.reserveVerifiedCapability(initial);
    const expected = guard.expectedRenewal(initial.capabilityId);
    const next = verifiedRenewal(
      initial,
      renewal(initial, expected.expectedPreviousGrantSha256, 11),
      expected,
    );
    guard.fence(initial.capabilityId, "stale_revision");

    expect(guard.isActive(initial.capabilityId)).toBe(false);
    expect(() => guard.expectedRenewal(initial.capabilityId)).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_TERMINAL" }),
    );
    expect(() => guard.acceptVerifiedRenewal(next)).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_TERMINAL" }),
    );
  });

  it("rejects a newly signed capability for an already reserved attempt identity", () => {
    const initial = verifiedCapability();
    const guard = new LocalAuthorityReplayGuard();
    guard.reserveVerifiedCapability(initial);

    expect(() =>
      guard.reserveVerifiedCapability(
        verifiedCapability({ ...capability(hex("f")), nonce: hex("e") }),
      ),
    ).toThrowError(expect.objectContaining({ code: "ATTEMPT_REPLAYED" }));
    expect(() =>
      guard.reserveVerifiedCapability(
        verifiedCapability({
          ...capability(hex("d")),
          nonce: hex("c"),
          runAttemptId: "attempt-2",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "ATTEMPT_REPLAYED" }));
  });

  it("fails closed instead of evicting replay history at its memory bound", () => {
    const guard = new LocalAuthorityReplayGuard(1);
    guard.reserveVerifiedCapability(verifiedCapability());
    expect(() => guard.reserveVerifiedCapability(verifiedCapability(capability(hex("f"))))).toThrow(
      LocalAuthorityReplayError,
    );
  });

  it("rejects structurally valid but runtime-unverified capabilities and renewals", () => {
    const guard = new LocalAuthorityReplayGuard();
    const initial = capability();
    expect(() =>
      guard.reserveVerifiedCapability(initial as unknown as VerifiedExecutionCapability),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_UNVERIFIED" }));
    expect(guard.isActive(initial.capabilityId)).toBe(false);

    const verified = verifiedCapability(initial);
    guard.reserveVerifiedCapability(verified);
    const unverifiedRenewal = renewal(verified, digestExecutionCapability(verified));
    expect(() =>
      guard.acceptVerifiedRenewal(
        unverifiedRenewal as unknown as Parameters<
          LocalAuthorityReplayGuard["acceptVerifiedRenewal"]
        >[0],
      ),
    ).toThrowError(expect.objectContaining({ code: "RENEWAL_UNVERIFIED" }));
  });

  it("cannot activate tampered or expired signed capabilities", () => {
    const guard = new LocalAuthorityReplayGuard();
    const value = capability();
    const signed = signExecutionCapability(value, keys.privateKey);

    expect(() =>
      verifyExecutionCapability(
        { ...signed, capability: { ...signed.capability, leaseGeneration: 2 } },
        keys.publicKey,
        {
          expectedKeyId: keyId,
          expectedWorkerNodeId: value.workerNodeId,
          expectedWorkerInstanceId: value.workerInstanceId,
          expectedExecutorBootId: value.executorBootId,
          expectedSessionId: value.sessionId,
          nowUnixMs: now + 1_000,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_SIGNATURE_INVALID" }));

    const expired = { ...value, grantExpiresAtUnixMs: now + 500 };
    expect(() =>
      verifyExecutionCapability(signExecutionCapability(expired, keys.privateKey), keys.publicKey, {
        expectedKeyId: keyId,
        expectedWorkerNodeId: value.workerNodeId,
        expectedWorkerInstanceId: value.workerInstanceId,
        expectedExecutorBootId: value.executorBootId,
        expectedSessionId: value.sessionId,
        nowUnixMs: now + 1_000,
      }),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_EXPIRED" }));
    expect(guard.isActive(value.capabilityId)).toBe(false);
  });
});
