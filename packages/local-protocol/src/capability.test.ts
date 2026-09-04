import { describe, expect, it } from "vitest";
import {
  digestExecutionCapability,
  digestRenewalGrant,
  type ExecutionCapabilityV1,
  isValidatedExecutionCapability,
  isValidatedRenewalGrant,
  LOCAL_CAPABILITY_AUDIENCE,
  LocalCapabilityError,
  type RenewalGrantV1,
  serializeExecutionCapability,
  validateExecutionCapability,
  validateExecutionCapabilityForContext,
  validateRenewalGrantForContext,
} from "./capability.js";

const now = 1_800_000_000_000;
const hex = (character: string): string => character.repeat(64);

function capability(overrides: Partial<ExecutionCapabilityV1> = {}): ExecutionCapabilityV1 {
  return {
    capabilityVersion: 1,
    canonicalizationVersion: 1,
    audience: LOCAL_CAPABILITY_AUDIENCE,
    capabilityId: hex("1"),
    nonce: hex("2"),
    workerNodeId: "powertoys-node-01",
    workerInstanceId: "worker-instance:7",
    executorBootId: "10000000-0000-4000-8000-000000000001",
    sessionId: "20000000-0000-4000-8000-000000000002",
    attemptCorrelationId: "30000000-0000-4000-8000-000000000003",
    runAttemptId: "run-attempt-1",
    jobId: "job-1",
    leaseGeneration: 7,
    grantSequence: 1,
    repository: { githubRepositoryId: 184456251, fullName: "microsoft/PowerToys" },
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
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    expectedWorkerNodeId: "powertoys-node-01",
    expectedWorkerInstanceId: "worker-instance:7",
    expectedExecutorBootId: "10000000-0000-4000-8000-000000000001",
    expectedSessionId: "20000000-0000-4000-8000-000000000002",
    nowUnixMs: now + 1_000,
    ...overrides,
  };
}

function renewal(
  initial: ExecutionCapabilityV1,
  overrides: Partial<RenewalGrantV1> = {},
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
    serverHeartbeatSequence: 5,
    initialCapabilitySha256: digestExecutionCapability(initial),
    previousGrantSha256: digestExecutionCapability(initial),
    issuedAtUnixMs: now + 2_000,
    serverLeaseExpiresAtUnixMs: now + 90_000,
    grantExpiresAtUnixMs: now + 47_000,
    hardDeadlineUnixMs: initial.hardDeadlineUnixMs,
    ...overrides,
  };
}

describe("plain local execution authorization", () => {
  it("normalizes strict canonical data without signature metadata or wrappers", () => {
    const value = capability();
    const validated = validateExecutionCapability(value);

    expect(validated).toEqual(value);
    expect(isValidatedExecutionCapability(validated)).toBe(false);
    expect(serializeExecutionCapability(value)).not.toContain("signature");
    expect(() => validateExecutionCapability({ ...value, keyId: hex("a") })).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_SCHEMA_INVALID" }),
    );
    expect(() => validateExecutionCapability({ capability: value })).toThrow(LocalCapabilityError);
  });

  it("brands only capabilities validated against the active local session and time", () => {
    const value = capability();
    const validated = validateExecutionCapabilityForContext(value, context());

    expect(validated).toEqual(value);
    expect(isValidatedExecutionCapability(validated)).toBe(true);
    expect(Object.isFrozen(validated.resources)).toBe(true);

    for (const override of [
      { expectedWorkerNodeId: "other-node" },
      { expectedWorkerInstanceId: "other-instance" },
      { expectedExecutorBootId: "40000000-0000-4000-8000-000000000004" },
      { expectedSessionId: "50000000-0000-4000-8000-000000000005" },
    ]) {
      expect(() => validateExecutionCapabilityForContext(value, context(override))).toThrowError(
        expect.objectContaining({ code: "CAPABILITY_CONTEXT_MISMATCH" }),
      );
    }
  });

  it("enforces replay identifiers, resource ceilings, hard deadlines, and 45-second grants", () => {
    expect(() => validateExecutionCapability(capability({ nonce: hex("1") }))).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_CONTEXT_MISMATCH" }),
    );
    expect(() =>
      validateExecutionCapability(
        capability({ resources: { ...capability().resources, artifactBytes: "17179869185" } }),
      ),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_LIMIT_INVALID" }));
    expect(() =>
      validateExecutionCapability(capability({ grantExpiresAtUnixMs: now + 45_001 })),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_TIME_INVALID" }));
    expect(() =>
      validateExecutionCapabilityForContext(
        capability({ issuedAtUnixMs: now + 10_000, grantExpiresAtUnixMs: now + 20_000 }),
        context({ maximumClockSkewMs: 1_000 }),
      ),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_TIME_INVALID" }));
    expect(() =>
      validateExecutionCapabilityForContext(valueAt(now - 45_000, now - 1), context()),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_EXPIRED" }));
  });

  it("validates renewal context, chain, heartbeat sequence, and deadline", () => {
    const initialValue = capability();
    const initial = validateExecutionCapabilityForContext(initialValue, context());
    const grantValue = renewal(initialValue);
    const validated = validateRenewalGrantForContext(grantValue, {
      ...context({ nowUnixMs: now + 3_000 }),
      capability: initial,
      expectedPreviousGrantSha256: digestExecutionCapability(initial),
      expectedPreviousGrantSequence: 1,
      expectedGrantSequence: 2,
      expectedPreviousServerHeartbeatSequence: 4,
    });

    expect(validated).toEqual(grantValue);
    expect(isValidatedRenewalGrant(validated)).toBe(true);
    expect(digestRenewalGrant(validated)).toMatch(/^[a-f0-9]{64}$/u);

    expect(() =>
      validateRenewalGrantForContext(
        { ...grantValue, serverHeartbeatSequence: 4 },
        {
          ...context({ nowUnixMs: now + 3_000 }),
          capability: initial,
          expectedPreviousGrantSha256: digestExecutionCapability(initial),
          expectedPreviousGrantSequence: 1,
          expectedGrantSequence: 2,
          expectedPreviousServerHeartbeatSequence: 4,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "RENEWAL_SEQUENCE_INVALID" }));
  });

  it("changes digests when authorization data changes", () => {
    expect(digestExecutionCapability(capability())).not.toBe(
      digestExecutionCapability(capability({ jobId: "job-2" })),
    );
  });
});

function valueAt(issuedAtUnixMs: number, grantExpiresAtUnixMs: number): ExecutionCapabilityV1 {
  return capability({
    issuedAtUnixMs,
    grantExpiresAtUnixMs,
    hardDeadlineUnixMs: issuedAtUnixMs + 1_800_000,
  });
}
