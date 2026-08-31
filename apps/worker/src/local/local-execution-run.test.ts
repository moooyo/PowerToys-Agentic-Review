import type { RunTerminalResponse } from "@agentic-review/contracts";
import {
  ArtifactStreamVerifier,
  createCanonicalJsonDocument,
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
    protocolMajor: 1 as const,
    protocolMinor: 0 as const,
    workerNodeId: "worker-node-1",
    workerInstanceId: "worker-instance-1",
    executorBootId: "20000000-0000-4000-8000-000000000002",
    sessionId: "30000000-0000-4000-8000-000000000003",
    attemptCorrelationId: "40000000-0000-4000-8000-000000000004",
    runAttemptId,
  };
  const terminal = {
    ...context,
    code: "CODEX_FAILED",
    message: "Codex failed.",
    retryable: true,
    failedAtUnixMs: 1_800_000_000_000,
  };
  const verifier = new ArtifactStreamVerifier({
    ...context,
    maximumArtifactBytes: 64n,
    expectedOutputSchemaSha256: "a".repeat(64),
  });
  const verified = verifier.acceptFailed(terminal);
  expect(verified.terminalPayloadSha256).toBe(createCanonicalJsonDocument(terminal).sha256);
  return verified;
}
