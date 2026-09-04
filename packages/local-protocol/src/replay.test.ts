import { describe, expect, it } from "vitest";
import {
  digestExecutionCapability,
  type ExecutionCapabilityV1,
  LOCAL_CAPABILITY_AUDIENCE,
  type RenewalGrantV1,
  type ValidatedExecutionCapability,
  validateExecutionCapabilityForContext,
  validateRenewalGrantForContext,
} from "./capability.js";
import { LocalAuthorityReplayError, LocalAuthorityReplayGuard } from "./replay.js";

const hex = (value: string): string => value.repeat(64);
const now = 1_800_000_000_000;

function capability(capabilityId = hex("1")): ExecutionCapabilityV1 {
  return {
    capabilityVersion: 1,
    canonicalizationVersion: 1,
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
): RenewalGrantV1 {
  return {
    renewalVersion: 1,
    canonicalizationVersion: 1,
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

function validatedCapability(value = capability()): ValidatedExecutionCapability {
  return validateExecutionCapabilityForContext(value, {
    expectedWorkerNodeId: value.workerNodeId,
    expectedWorkerInstanceId: value.workerInstanceId,
    expectedExecutorBootId: value.executorBootId,
    expectedSessionId: value.sessionId,
    nowUnixMs: now + 1_000,
  });
}

function validatedRenewal(
  initial: ValidatedExecutionCapability,
  value: RenewalGrantV1,
  expected: ReturnType<LocalAuthorityReplayGuard["expectedRenewal"]>,
) {
  return validateRenewalGrantForContext(value, {
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
    const initial = validatedCapability();
    const guard = new LocalAuthorityReplayGuard();
    guard.reserveValidatedCapability(initial);
    expect(() => guard.reserveValidatedCapability(initial)).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_REPLAYED" }),
    );

    const expected = guard.expectedRenewal(initial.capabilityId);
    const next = validatedRenewal(
      initial,
      renewal(initial, expected.expectedPreviousGrantSha256),
      expected,
    );
    guard.acceptValidatedRenewal(next);
    expect(guard.expectedRenewal(initial.capabilityId)).toMatchObject({
      expectedPreviousGrantSequence: 2,
      expectedGrantSequence: 3,
      expectedPreviousServerHeartbeatSequence: 10,
    });
    expect(() => guard.acceptValidatedRenewal(next)).toThrowError(
      expect.objectContaining({ code: "RENEWAL_CHAIN_INVALID" }),
    );
  });

  it("accepts heartbeat sequence zero once and rejects replay", () => {
    const initial = validatedCapability();
    const guard = new LocalAuthorityReplayGuard();
    guard.reserveValidatedCapability(initial);
    const expected = guard.expectedRenewal(initial.capabilityId);
    const first = validatedRenewal(
      initial,
      renewal(initial, expected.expectedPreviousGrantSha256, 0),
      expected,
    );
    guard.acceptValidatedRenewal(first);

    const nextExpected = guard.expectedRenewal(initial.capabilityId);
    const repeated = validatedRenewal(
      initial,
      {
        ...first,
        renewalId: hex("b"),
        nonce: hex("c"),
        grantSequence: 3,
        previousGrantSequence: 2,
        previousGrantSha256: nextExpected.expectedPreviousGrantSha256,
      },
      { ...nextExpected, expectedPreviousServerHeartbeatSequence: -1 },
    );
    expect(() => guard.acceptValidatedRenewal(repeated)).toThrowError(
      expect.objectContaining({ code: "RENEWAL_REPLAYED" }),
    );
  });

  it("never revives a fenced or terminal capability", () => {
    for (const reason of ["terminal", "stale_revision"] as const) {
      const initial = validatedCapability();
      const guard = new LocalAuthorityReplayGuard();
      guard.reserveValidatedCapability(initial);
      reason === "terminal"
        ? guard.markTerminal(initial.capabilityId)
        : guard.fence(initial.capabilityId, reason);

      expect(guard.isActive(initial.capabilityId)).toBe(false);
      expect(() => guard.expectedRenewal(initial.capabilityId)).toThrowError(
        expect.objectContaining({ code: "CAPABILITY_TERMINAL" }),
      );
    }
  });

  it("retains attempt and correlation tombstones for the Executor boot", () => {
    const initial = validatedCapability();
    const guard = new LocalAuthorityReplayGuard();
    guard.reserveValidatedCapability(initial);

    expect(() =>
      guard.reserveValidatedCapability(
        validatedCapability({ ...capability(hex("f")), nonce: hex("e") }),
      ),
    ).toThrowError(expect.objectContaining({ code: "ATTEMPT_REPLAYED" }));
  });

  it("fails closed at capacity and rejects unvalidated data", () => {
    const guard = new LocalAuthorityReplayGuard(1);
    const initial = validatedCapability();
    guard.reserveValidatedCapability(initial);
    expect(() =>
      guard.reserveValidatedCapability(
        validatedCapability({
          ...capability(hex("f")),
          nonce: hex("e"),
          runAttemptId: "attempt-2",
          attemptCorrelationId: "40000000-0000-4000-8000-000000000004",
        }),
      ),
    ).toThrow(LocalAuthorityReplayError);

    expect(() =>
      new LocalAuthorityReplayGuard().reserveValidatedCapability(
        capability() as unknown as ValidatedExecutionCapability,
      ),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_UNVALIDATED" }));
  });
});
