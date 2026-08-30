import { describe, expect, it } from "vitest";

import {
  digestExecutionCapability,
  type ExecutionCapabilityV1,
  LOCAL_CAPABILITY_AUDIENCE,
  LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
} from "./capability.js";
import { LocalAuthorityReplayError, LocalAuthorityReplayGuard } from "./replay.js";

const hex = (value: string): string => value.repeat(64);
const now = 1_800_000_000_000;

function capability(capabilityId = hex("1")): ExecutionCapabilityV1 {
  return {
    capabilityVersion: 1,
    canonicalizationVersion: 1,
    signatureAlgorithm: LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
    keyId: hex("a"),
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

function renewal(initial: ExecutionCapabilityV1, previousDigest: string) {
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
    serverHeartbeatSequence: 10,
    initialCapabilitySha256: digestExecutionCapability(initial),
    previousGrantSha256: previousDigest,
    issuedAtUnixMs: now + 20_000,
    serverLeaseExpiresAtUnixMs: now + 120_000,
    grantExpiresAtUnixMs: now + 50_000,
    hardDeadlineUnixMs: initial.hardDeadlineUnixMs,
  };
}

describe("LocalAuthorityReplayGuard", () => {
  it("reserves each capability once and advances an exact renewal chain", () => {
    const initial = capability();
    const guard = new LocalAuthorityReplayGuard();
    guard.reserveVerifiedCapability(initial);
    expect(() => guard.reserveVerifiedCapability(initial)).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_REPLAYED" }),
    );

    const expected = guard.expectedRenewal(initial.capabilityId);
    const next = renewal(initial, expected.expectedPreviousGrantSha256);
    guard.acceptVerifiedRenewal(next);
    expect(guard.expectedRenewal(initial.capabilityId)).toMatchObject({
      expectedPreviousGrantSequence: 2,
      expectedGrantSequence: 3,
    });
    expect(() => guard.acceptVerifiedRenewal(next)).toThrowError(
      expect.objectContaining({ code: "RENEWAL_CHAIN_INVALID" }),
    );
  });

  it("never revives a terminal capability", () => {
    const initial = capability();
    const guard = new LocalAuthorityReplayGuard();
    guard.reserveVerifiedCapability(initial);
    guard.markTerminal(initial.capabilityId);
    expect(guard.isActive(initial.capabilityId)).toBe(false);
    expect(() => guard.expectedRenewal(initial.capabilityId)).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_TERMINAL" }),
    );
    expect(() =>
      guard.acceptVerifiedRenewal(renewal(initial, digestExecutionCapability(initial))),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_TERMINAL" }));
  });

  it("rejects a newly signed capability for an already reserved attempt identity", () => {
    const initial = capability();
    const guard = new LocalAuthorityReplayGuard();
    guard.reserveVerifiedCapability(initial);

    expect(() =>
      guard.reserveVerifiedCapability({
        ...initial,
        capabilityId: hex("f"),
        nonce: hex("e"),
      }),
    ).toThrowError(expect.objectContaining({ code: "ATTEMPT_REPLAYED" }));
    expect(() =>
      guard.reserveVerifiedCapability({
        ...initial,
        capabilityId: hex("d"),
        nonce: hex("c"),
        runAttemptId: "attempt-2",
      }),
    ).toThrowError(expect.objectContaining({ code: "ATTEMPT_REPLAYED" }));
  });

  it("fails closed instead of evicting replay history at its memory bound", () => {
    const guard = new LocalAuthorityReplayGuard(1);
    guard.reserveVerifiedCapability(capability());
    expect(() => guard.reserveVerifiedCapability(capability(hex("f")))).toThrow(
      LocalAuthorityReplayError,
    );
  });
});
