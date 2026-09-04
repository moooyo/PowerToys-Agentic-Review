import type { JobExecutionEnvelope, RunTerminalResponse } from "@agentic-review/contracts";
import {
  ArtifactStreamVerifier,
  createCanonicalJsonDocument,
  type EstablishedLocalSession,
  type ExecutionCapabilityV1,
  establishLocalSession,
  type HelloAckMessage,
  type HelloMessage,
  LOCAL_CAPABILITY_AUDIENCE,
  LOCAL_GRANT_MAXIMUM_DURATION_MS,
  sha256Hex,
  type ValidatedExecutionCapability,
  validateExecutionCapabilityForContext,
} from "@agentic-review/local-protocol";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  type PreparedLocalExecutionStart,
  prepareLocalExecutionStart,
} from "./executor-envelope.js";
import {
  createLocalExecutionCancellation,
  type LocalExecutionBroker,
} from "./local-execution-broker.js";
import {
  createLocalExecutionMonotonicAuthority,
  type LocalExecutionAuthorityFenceReason,
  type LocalExecutionTerminalDecision,
  mapRunTerminalResponseOutcome,
  prepareLocalTerminalDecision,
} from "./local-execution-run.js";

const identity = { jobId: "job-1", runAttemptId: "run-1" } as const;
const startAuthorizationSha256 = "f".repeat(64);
const renewalAuthorizationSha256 = "d".repeat(64);
const authorityNow = 1_800_000_000_000;
const artifactSession = {
  protocolMajor: 1 as const,
  protocolMinor: 0 as const,
  workerNodeId: "worker-node-1",
  workerInstanceId: "worker-instance-1",
  executorBootId: "20000000-0000-4000-8000-000000000002",
  sessionId: "30000000-0000-4000-8000-000000000003",
  attemptCorrelationId: "40000000-0000-4000-8000-000000000004",
};
const artifactHandshake = createEstablishedArtifactSession();

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

describe("LocalExecutionRenewalRegistrar", () => {
  const start = preparedAuthorityStart({
    observedAtMonotonicMilliseconds: 10,
    remainingLeaseMilliseconds: 45_000,
    remainingHardDeadlineMilliseconds: 50_000,
  });
  const { renewalRegistrar } = createLocalExecutionMonotonicAuthority(start);

  it("accepts heartbeat sequence zero and returns only lease-token-free timing evidence", () => {
    const prepared = renewalRegistrar.prepare({
      runAttemptId: "run-1",
      leaseGeneration: 7,
      serverHeartbeatSequence: 0,
      observedAtMonotonicMilliseconds: 12.1,
      remainingLeaseMilliseconds: 44_997.9,
      action: "continue",
    });

    expect(prepared).toEqual({
      attemptCorrelationId: artifactSession.attemptCorrelationId,
      runAttemptId: "run-1",
      leaseGeneration: 7,
      serverHeartbeatSequence: 0,
      observedAtMonotonicMilliseconds: 12,
      remainingLeaseMilliseconds: 44_997,
      remainingHardDeadlineMilliseconds: 49_998,
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
    [{ observedAtMonotonicMilliseconds: 9 }, "RENEWAL_TIMING_INVALID"],
    [{ observedAtMonotonicMilliseconds: 50_010 }, "RENEWAL_TIMING_INVALID"],
    [{ observedAtMonotonicMilliseconds: Number.NaN }, "RENEWAL_TIMING_INVALID"],
    [{ remainingLeaseMilliseconds: Number.POSITIVE_INFINITY }, "RENEWAL_TIMING_INVALID"],
  ] as const)("rejects invalid renewal evidence %#j", (change, code) => {
    expect(() =>
      renewalRegistrar.prepare({
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

describe("LocalExecutionMonotonicAuthority", () => {
  it("requires a runtime-branded prepared start and consumes start authority exactly once", () => {
    const start = preparedAuthorityStart({
      observedAtMonotonicMilliseconds: 100.9,
      remainingLeaseMilliseconds: 100.9,
      remainingHardDeadlineMilliseconds: 1_000.9,
    });
    expect(() =>
      createLocalExecutionMonotonicAuthority({ ...start } as PreparedLocalExecutionStart),
    ).toThrowError(expect.objectContaining({ code: "AUTHORITY_START_INVALID" }));

    const { authority } = createLocalExecutionMonotonicAuthority(start);
    expect(() => createLocalExecutionMonotonicAuthority(start)).toThrowError(
      expect.objectContaining({ code: "AUTHORITY_START_ALREADY_CONSUMED" }),
    );
    const use = authority.issueStart(startAuthorizationSha256, 100.1);
    expect(use).toMatchObject({
      kind: "start",
      generation: 1,
      attemptCorrelationId: start.attemptCorrelationId,
      runAttemptId: start.executorEnvelope.runAttemptId,
      leaseGeneration: start.authorityBasis.leaseGeneration,
      authorizationSha256: startAuthorizationSha256,
      deadlineMonotonicMilliseconds: 200,
      validForMilliseconds: 99,
      serverHeartbeatSequence: null,
    });
    const other = createLocalExecutionMonotonicAuthority(preparedAuthorityStart());
    expect(() => other.authority.consumeUse(use, startAuthorizationSha256, 100.1)).toThrowError(
      expect.objectContaining({ code: "AUTHORITY_USE_INVALID" }),
    );
    expect(() => authority.consumeUse(use, "0".repeat(64), 100.1)).toThrowError(
      expect.objectContaining({ code: "AUTHORITY_USE_INVALID" }),
    );
    authority.consumeUse(use, startAuthorizationSha256, 100.1);
    expect(() => authority.consumeUse(use, startAuthorizationSha256, 100.1)).toThrowError(
      expect.objectContaining({ code: "AUTHORITY_USE_INVALID" }),
    );
    expect(() => authority.issueStart(startAuthorizationSha256, 101)).toThrowError(
      expect.objectContaining({ code: "AUTHORITY_START_ALREADY_CONSUMED" }),
    );
  });

  it("rejects a queued start after its monotonic lease deadline", () => {
    const { authority } = createLocalExecutionMonotonicAuthority(
      preparedAuthorityStart({
        observedAtMonotonicMilliseconds: 100,
        remainingLeaseMilliseconds: 10,
        remainingHardDeadlineMilliseconds: 1_000,
      }),
    );
    expect(() => authority.issueStart(startAuthorizationSha256, 110)).toThrowError(
      expect.objectContaining({ code: "AUTHORITY_EXPIRED" }),
    );
    expect(() => authority.issueStart(startAuthorizationSha256, 109)).toThrowError(
      expect.objectContaining({ code: "AUTHORITY_FENCED" }),
    );
  });

  it("expires and fences issued start authority without ticket state", () => {
    const expiringStart = preparedAuthorityStart({
      observedAtMonotonicMilliseconds: 100,
      remainingLeaseMilliseconds: 10,
      remainingHardDeadlineMilliseconds: 1_000,
    });
    const { authority: expiring } = createLocalExecutionMonotonicAuthority(expiringStart);
    expect(() => expiring.issueStart(startAuthorizationSha256, 110)).toThrowError(
      expect.objectContaining({ code: "AUTHORITY_EXPIRED" }),
    );

    const expiringUseStart = preparedAuthorityStart({
      observedAtMonotonicMilliseconds: 100,
      remainingLeaseMilliseconds: 10,
      remainingHardDeadlineMilliseconds: 1_000,
    });
    const { authority: expiringUseAuthority } =
      createLocalExecutionMonotonicAuthority(expiringUseStart);
    const expiringUse = expiringUseAuthority.issueStart(startAuthorizationSha256, 100);
    expect(() =>
      expiringUseAuthority.consumeUse(expiringUse, startAuthorizationSha256, 110),
    ).toThrowError(expect.objectContaining({ code: "AUTHORITY_EXPIRED" }));

    const cancelledStart = preparedAuthorityStart();
    const { authority: cancelled } = createLocalExecutionMonotonicAuthority(cancelledStart);
    const cancelledUse = cancelled.issueStart(startAuthorizationSha256, 100);
    cancelled.fence("cancelled");
    expect(() => cancelled.consumeUse(cancelledUse, startAuthorizationSha256, 101)).toThrowError(
      expect.objectContaining({ code: "AUTHORITY_FENCED" }),
    );

    const forgedStart = preparedAuthorityStart();
    const { authority: forged } = createLocalExecutionMonotonicAuthority(forgedStart);
    forged.issueStart(startAuthorizationSha256, 100);
    expect(() =>
      forged.consumeUse({ generation: 1 } as never, startAuthorizationSha256, 101),
    ).toThrowError(expect.objectContaining({ code: "AUTHORITY_USE_INVALID" }));
  });

  it("deducts renewal age and clamps authorization to the hard deadline and 45 seconds", () => {
    const start = preparedAuthorityStart({
      observedAtMonotonicMilliseconds: 100.9,
      remainingLeaseMilliseconds: 45_000.9,
      remainingHardDeadlineMilliseconds: 50_000.9,
    });
    const { authority, renewalRegistrar } = createLocalExecutionMonotonicAuthority(start);
    authority.issueStart(startAuthorizationSha256, 100.1);
    const renewal = renewalRegistrar.prepare({
      runAttemptId: start.executorEnvelope.runAttemptId,
      leaseGeneration: start.authorityBasis.leaseGeneration,
      serverHeartbeatSequence: 1,
      observedAtMonotonicMilliseconds: 10_000.9,
      remainingLeaseMilliseconds: 100_000.9,
      action: "continue",
    });

    const issued = authority.issueRenewal(renewal, renewalAuthorizationSha256, 10_001.1);
    expect(issued).toMatchObject({
      kind: "renewal",
      generation: 2,
      serverHeartbeatSequence: 1,
      deadlineMonotonicMilliseconds: 50_100,
      validForMilliseconds: 40_098,
      authorizationSha256: renewalAuthorizationSha256,
    });
    authority.consumeUse(issued, renewalAuthorizationSha256, 10_002.1);
    expect(() => authority.consumeUse(issued, renewalAuthorizationSha256, 10_002.1)).toThrowError(
      expect.objectContaining({ code: "AUTHORITY_USE_INVALID" }),
    );
  });

  it("never revives authority after the current grant expires", () => {
    const start = preparedAuthorityStart({
      observedAtMonotonicMilliseconds: 100,
      remainingLeaseMilliseconds: 10,
      remainingHardDeadlineMilliseconds: 1_000,
    });
    const { authority, renewalRegistrar } = createLocalExecutionMonotonicAuthority(start);
    authority.issueStart(startAuthorizationSha256, 100);
    const renewal = renewalRegistrar.prepare({
      runAttemptId: start.executorEnvelope.runAttemptId,
      leaseGeneration: start.authorityBasis.leaseGeneration,
      serverHeartbeatSequence: 1,
      observedAtMonotonicMilliseconds: 105,
      remainingLeaseMilliseconds: 100,
      action: "continue",
    });

    expect(() => authority.issueRenewal(renewal, renewalAuthorizationSha256, 110)).toThrowError(
      expect.objectContaining({ code: "AUTHORITY_EXPIRED" }),
    );
    expect(() => authority.issueRenewal(renewal, renewalAuthorizationSha256, 111)).toThrowError(
      expect.objectContaining({ code: "AUTHORITY_FENCED" }),
    );
  });

  it("rejects reused heartbeats, superseded generations, and forged uses", () => {
    const start = preparedAuthorityStart();
    const { authority, renewalRegistrar } = createLocalExecutionMonotonicAuthority(start);
    authority.issueStart(startAuthorizationSha256, 100);
    const renewal = (sequence: number, observedAt: number) =>
      renewalRegistrar.prepare({
        runAttemptId: start.executorEnvelope.runAttemptId,
        leaseGeneration: start.authorityBasis.leaseGeneration,
        serverHeartbeatSequence: sequence,
        observedAtMonotonicMilliseconds: observedAt,
        remainingLeaseMilliseconds: 100_000,
        action: "continue",
      });
    const first = authority.issueRenewal(renewal(5, 200), renewalAuthorizationSha256, 200);
    expect(first.validForMilliseconds).toBe(LOCAL_GRANT_MAXIMUM_DURATION_MS);
    expect(() =>
      authority.issueRenewal(renewal(5, 201), renewalAuthorizationSha256, 201),
    ).toThrowError(expect.objectContaining({ code: "AUTHORITY_HEARTBEAT_REPLAYED" }));
    expect(() =>
      authority.issueRenewal(renewal(4, 201), renewalAuthorizationSha256, 201),
    ).toThrowError(expect.objectContaining({ code: "AUTHORITY_HEARTBEAT_REPLAYED" }));
    expect(() =>
      authority.issueRenewal(renewal(6, 199), renewalAuthorizationSha256, 201),
    ).toThrowError(expect.objectContaining({ code: "AUTHORITY_TIME_INVALID" }));
    expect(() =>
      authority.issueRenewal({ ...renewal(6, 202) } as never, renewalAuthorizationSha256, 202),
    ).toThrowError(expect.objectContaining({ code: "AUTHORITY_RENEWAL_INVALID" }));
    const otherStart = preparedAuthorityStart();
    const otherBinding = createLocalExecutionMonotonicAuthority(otherStart);
    expect(() =>
      authority.issueRenewal(
        otherBinding.renewalRegistrar.prepare({
          runAttemptId: otherStart.executorEnvelope.runAttemptId,
          leaseGeneration: otherStart.authorityBasis.leaseGeneration,
          serverHeartbeatSequence: 6,
          observedAtMonotonicMilliseconds: 202,
          remainingLeaseMilliseconds: 100_000,
          action: "continue",
        }),
        renewalAuthorizationSha256,
        202,
      ),
    ).toThrowError(expect.objectContaining({ code: "AUTHORITY_RENEWAL_INVALID" }));
    const second = authority.issueRenewal(renewal(6, 202), renewalAuthorizationSha256, 202);
    expect(() => authority.consumeUse(first, renewalAuthorizationSha256, 203)).toThrowError(
      expect.objectContaining({ code: "AUTHORITY_USE_INVALID" }),
    );
    expect(() =>
      authority.consumeUse(
        { generation: second.generation } as never,
        renewalAuthorizationSha256,
        203,
      ),
    ).toThrowError(expect.objectContaining({ code: "AUTHORITY_USE_INVALID" }));
    expect(second.serverHeartbeatSequence).toBe(6);
  });

  it.each([
    "cancelled",
    "stale_revision",
    "terminal",
    "close",
  ] as const satisfies readonly LocalExecutionAuthorityFenceReason[])(
    "synchronously invalidates issued authority when fenced as %s",
    (reason) => {
      const start = preparedAuthorityStart();
      const { authority, renewalRegistrar } = createLocalExecutionMonotonicAuthority(start);
      const currentUse = authority.issueStart(startAuthorizationSha256, 100);
      const renewalUse = authority.issueRenewal(
        renewalRegistrar.prepare({
          runAttemptId: start.executorEnvelope.runAttemptId,
          leaseGeneration: start.authorityBasis.leaseGeneration,
          serverHeartbeatSequence: 1,
          observedAtMonotonicMilliseconds: 200,
          remainingLeaseMilliseconds: 100_000,
          action: "drain",
        }),
        renewalAuthorizationSha256,
        200,
      );
      authority.fence(reason);

      expect(() => authority.consumeUse(currentUse, startAuthorizationSha256, 201)).toThrowError(
        expect.objectContaining({ code: "AUTHORITY_FENCED" }),
      );
      expect(() => authority.consumeUse(renewalUse, renewalAuthorizationSha256, 201)).toThrowError(
        expect.objectContaining({ code: "AUTHORITY_FENCED" }),
      );
    },
  );
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

function preparedAuthorityStart(
  timing: {
    readonly observedAtMonotonicMilliseconds: number;
    readonly remainingLeaseMilliseconds: number;
    readonly remainingHardDeadlineMilliseconds: number;
  } = {
    observedAtMonotonicMilliseconds: 100,
    remainingLeaseMilliseconds: 100_000,
    remainingHardDeadlineMilliseconds: 200_000,
  },
): PreparedLocalExecutionStart {
  return prepareLocalExecutionStart(
    authorityServerEnvelope(),
    artifactSession.attemptCorrelationId,
    timing,
  );
}

function authorityServerEnvelope(): JobExecutionEnvelope {
  const outputSchema = {
    additionalProperties: false,
    properties: { summary: { type: "string" } },
    required: ["summary"],
    type: "object",
  };
  const renderedPrompt = "Triage this issue.";
  const author = { githubUserId: 42, login: "contributor" };
  const canonicalSnapshot = {
    kind: "issue" as const,
    githubRepositoryId: 184456251,
    githubNodeId: "I_kwDOAv9ZBc5-test",
    number: 123,
    title: "PowerToys issue",
    body: "Issue body",
    state: "open",
    author,
  };
  return {
    protocolVersion: "1.0",
    envelopeVersion: 1,
    assignedAt: "2026-08-31T00:00:00.000Z",
    leaseExpiresAt: "2026-08-31T00:05:00.000Z",
    executionDeadlineAt: "2026-08-31T00:10:00.000Z",
    lease: {
      jobId: identity.jobId,
      runAttemptId: identity.runAttemptId,
      workerNodeId: artifactSession.workerNodeId,
      workerInstanceId: artifactSession.workerInstanceId,
      leaseToken: "server-lease-token".padEnd(32, "x"),
      leaseGeneration: 7,
    },
    job: {
      jobId: identity.jobId,
      kind: "issue_triage",
      priority: 100,
      attempt: 1,
      maxAttempts: 3,
      generation: 1,
      intentVersion: 1,
      semanticKey: "github:184456251:123:issue_triage",
    },
    repository: { githubRepositoryId: 184456251, fullName: "microsoft/PowerToys" },
    resource: {
      kind: "issue",
      githubNodeId: canonicalSnapshot.githubNodeId,
      number: canonicalSnapshot.number,
      title: canonicalSnapshot.title,
      author,
      canonicalSnapshot,
      revisionDigest: "e".repeat(64),
    },
    prompt: {
      name: "issue-triage",
      version: "1",
      renderedPrompt,
      promptSha256: sha256Hex(renderedPrompt),
      outputSchema,
      outputSchemaSha256: createCanonicalJsonDocument(outputSchema).sha256,
    },
    executionPolicy: {
      hardTimeoutMs: 600_000,
      noProgressTimeoutMs: 120_000,
      maxCodexTurns: 8,
      allowedRecipeIds: ["powertoys.static-check"],
      requiredCapabilityLabels: { architecture: "x64" },
    },
  };
}

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

function createVerifiedArtifactCapability(runAttemptId: string): ValidatedExecutionCapability {
  const capability: ExecutionCapabilityV1 = {
    capabilityVersion: 1,
    canonicalizationVersion: 1,
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
  return validateExecutionCapabilityForContext(capability, {
    expectedWorkerNodeId: capability.workerNodeId,
    expectedWorkerInstanceId: capability.workerInstanceId,
    expectedExecutorBootId: capability.executorBootId,
    expectedSessionId: capability.sessionId,
    nowUnixMs: authorityNow + 1_000,
  });
}

function createEstablishedArtifactSession(): EstablishedLocalSession {
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
  return establishLocalSession(hello, helloAck);
}
