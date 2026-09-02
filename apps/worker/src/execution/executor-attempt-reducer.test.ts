import { describe, expect, it } from "vitest";

import {
  createExecutorAttemptState,
  type ExecutorAttemptEvent,
  type ExecutorAttemptIdentity,
  type ExecutorAttemptState,
  reduceExecutorAttempt,
} from "./executor-attempt-reducer.js";

const terminalPayloadSha256 = "a".repeat(64);
const otherTerminalPayloadSha256 = "b".repeat(64);
const dispositionId = "c".repeat(64);
const otherDispositionId = "d".repeat(64);
const identity: ExecutorAttemptIdentity = {
  attemptCorrelationId: "10000000-0000-4000-8000-000000000001",
  capabilityId: "e".repeat(64),
  leaseGeneration: 7,
  runAttemptId: "run-attempt-1",
};

describe("executor attempt reducer", () => {
  it("snapshots identity and reduces a completed attempt through cleanup", () => {
    const identitySource = { ...identity };
    let state = createExecutorAttemptState(identitySource);
    identitySource.attemptCorrelationId = "20000000-0000-4000-8000-000000000002";
    identitySource.capabilityId = "f".repeat(64);
    identitySource.leaseGeneration = 8;
    identitySource.runAttemptId = "later-mutation";

    expect(state).toMatchObject({
      identity,
      phase: "reserved",
      launchRequested: false,
      launchConfirmed: false,
      processTreeZero: false,
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.identity)).toBe(true);

    state = reduceExecutorAttempt(state, event("launch_requested"));
    expect(state.phase).toBe("launching");
    state = reduceExecutorAttempt(state, event("launch_confirmed"));
    expect(state.phase).toBe("running");

    const terminalEvent = {
      ...event("terminal_verified"),
      outcome: "completed" as const,
      payloadSha256: terminalPayloadSha256,
    };
    state = reduceExecutorAttempt(state, terminalEvent);
    terminalEvent.payloadSha256 = otherTerminalPayloadSha256;
    expect(state.phase).toBe("settling");
    expect(state.terminal).toEqual({
      outcome: "completed",
      payloadSha256: terminalPayloadSha256,
    });
    expect(Object.isFrozen(state.terminal)).toBe(true);

    state = reduceExecutorAttempt(state, event("process_tree_zero"));
    expect(state.phase).toBe("awaiting_disposition");

    const dispositionEvent = committedDisposition();
    state = reduceExecutorAttempt(state, dispositionEvent);
    dispositionEvent.dispositionId = otherDispositionId;
    expect(state.phase).toBe("cleaning");
    expect(state.disposition?.dispositionId).toBe(dispositionId);
    expect(Object.isFrozen(state.disposition)).toBe(true);

    state = reduceExecutorAttempt(state, cleanupFinished());
    expect(state.phase).toBe("closed");
    expect(state.cleanup).toEqual({ dispositionId, outcome: "deleted" });
    expect(Object.isFrozen(state.cleanup)).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("joins terminal evidence and process-tree zero in either order", () => {
    let terminalFirst = launchedAttempt();
    terminalFirst = reduceExecutorAttempt(terminalFirst, verifiedTerminal());
    expect(terminalFirst.phase).toBe("settling");
    terminalFirst = reduceExecutorAttempt(terminalFirst, event("process_tree_zero"));
    expect(terminalFirst.phase).toBe("awaiting_disposition");

    let processFirst = launchedAttempt();
    processFirst = reduceExecutorAttempt(processFirst, event("process_tree_zero"));
    expect(processFirst.phase).toBe("settling");
    processFirst = reduceExecutorAttempt(processFirst, verifiedTerminal());
    expect(processFirst.phase).toBe("awaiting_disposition");
    expect(processFirst).toEqual(terminalFirst);
  });

  it("latches the first stop synchronously and never revives a stopped launch", () => {
    const initial = createExecutorAttemptState(identity);
    const stopped = reduceExecutorAttempt(initial, stopRequested("cancelled"));
    expect(stopped).toMatchObject({
      phase: "stopping",
      stop: { reason: "cancelled" },
      launchRequested: false,
    });
    expect(Object.isFrozen(stopped.stop)).toBe(true);
    expect(reduceExecutorAttempt(stopped, stopRequested("cancelled"))).toBe(stopped);
    expect(() => reduceExecutorAttempt(stopped, stopRequested("shutdown"))).toThrowError(
      expect.objectContaining({ code: "EVENT_CONFLICT" }),
    );
    expect(() => reduceExecutorAttempt(stopped, event("launch_requested"))).toThrowError(
      expect.objectContaining({ code: "TRANSITION_INVALID" }),
    );
    expect(() => reduceExecutorAttempt(stopped, verifiedTerminal())).toThrowError(
      expect.objectContaining({ code: "TRANSITION_INVALID" }),
    );

    const zero = reduceExecutorAttempt(stopped, event("process_tree_zero"));
    const terminal = reduceExecutorAttempt(zero, {
      ...verifiedTerminal(),
      outcome: "failed",
    });
    expect(terminal.phase).toBe("awaiting_disposition");
    expect(terminal.stop?.reason).toBe("cancelled");
    expect(reduceExecutorAttempt(terminal, stopRequested("cancelled"))).toBe(terminal);
    expect(() => reduceExecutorAttempt(terminal, stopRequested("shutdown"))).toThrowError(
      expect.objectContaining({ code: "EVENT_CONFLICT" }),
    );
  });

  it("rejects a late launch confirmation after the stop latch", () => {
    const launching = reduceExecutorAttempt(
      createExecutorAttemptState(identity),
      event("launch_requested"),
    );
    const stopped = reduceExecutorAttempt(launching, stopRequested("lease_lost"));
    expect(() => reduceExecutorAttempt(stopped, event("launch_confirmed"))).toThrowError(
      expect.objectContaining({ code: "TRANSITION_INVALID" }),
    );
    expect(stopped.launchConfirmed).toBe(false);
    expect(stopped.stop?.reason).toBe("lease_lost");
  });

  it.each(["close", "drain"] as const)(
    "latches %s while a confirmed launch is running",
    (reason) => {
      const running = launchedAttempt();
      const stopped = reduceExecutorAttempt(running, stopRequested(reason));
      expect(stopped).toMatchObject({
        phase: "stopping",
        launchRequested: true,
        launchConfirmed: true,
        stop: { reason },
      });
    },
  );

  it("makes exact lifecycle replays idempotent and changed replays conflicts", () => {
    const initial = createExecutorAttemptState(identity);
    const launchRequested = reduceExecutorAttempt(initial, event("launch_requested"));
    expect(reduceExecutorAttempt(launchRequested, event("launch_requested"))).toBe(launchRequested);
    const running = reduceExecutorAttempt(launchRequested, event("launch_confirmed"));
    expect(reduceExecutorAttempt(running, event("launch_confirmed"))).toBe(running);

    const terminal = reduceExecutorAttempt(running, verifiedTerminal());
    expect(reduceExecutorAttempt(terminal, verifiedTerminal())).toBe(terminal);
    expect(() =>
      reduceExecutorAttempt(terminal, {
        ...verifiedTerminal(),
        payloadSha256: otherTerminalPayloadSha256,
      }),
    ).toThrowError(expect.objectContaining({ code: "EVENT_CONFLICT" }));

    const zero = reduceExecutorAttempt(terminal, event("process_tree_zero"));
    expect(reduceExecutorAttempt(zero, event("process_tree_zero"))).toBe(zero);
    const disposition = reduceExecutorAttempt(zero, committedDisposition());
    expect(reduceExecutorAttempt(disposition, committedDisposition())).toBe(disposition);
    expect(() =>
      reduceExecutorAttempt(disposition, {
        ...committedDisposition(),
        outcome: "rejected",
      }),
    ).toThrowError(expect.objectContaining({ code: "EVENT_CONFLICT" }));

    const closed = reduceExecutorAttempt(disposition, cleanupFinished());
    expect(reduceExecutorAttempt(closed, cleanupFinished())).toBe(closed);
    expect(() =>
      reduceExecutorAttempt(closed, { ...cleanupFinished(), outcome: "janitor_required" }),
    ).toThrowError(expect.objectContaining({ code: "EVENT_CONFLICT" }));
  });

  it("requires terminal and zero-process evidence before one matching disposition", () => {
    const running = launchedAttempt();
    expect(() => reduceExecutorAttempt(running, committedDisposition())).toThrowError(
      expect.objectContaining({ code: "TRANSITION_INVALID" }),
    );

    const terminalOnly = reduceExecutorAttempt(running, verifiedTerminal());
    expect(() => reduceExecutorAttempt(terminalOnly, committedDisposition())).toThrowError(
      expect.objectContaining({ code: "TRANSITION_INVALID" }),
    );

    const settled = reduceExecutorAttempt(terminalOnly, event("process_tree_zero"));
    expect(() => reduceExecutorAttempt(settled, stopRequested("cancelled"))).toThrowError(
      expect.objectContaining({ code: "TRANSITION_INVALID" }),
    );
    expect(() =>
      reduceExecutorAttempt(settled, {
        ...committedDisposition(),
        terminalPayloadSha256: otherTerminalPayloadSha256,
      }),
    ).toThrowError(expect.objectContaining({ code: "EVENT_CONFLICT" }));

    const disposition = reduceExecutorAttempt(settled, committedDisposition());
    expect(() =>
      reduceExecutorAttempt(disposition, {
        ...cleanupFinished(),
        dispositionId: otherDispositionId,
      }),
    ).toThrowError(expect.objectContaining({ code: "EVENT_CONFLICT" }));
    expect(() =>
      reduceExecutorAttempt(disposition, { ...cleanupFinished(), outcome: "retained" }),
    ).toThrowError(expect.objectContaining({ code: "EVENT_CONFLICT" }));
    expect(
      reduceExecutorAttempt(disposition, {
        ...cleanupFinished(),
        outcome: "janitor_required",
      }).phase,
    ).toBe("closed");
  });

  it("permits retained cleanup only for a retained disposition", () => {
    const settled = settledAttempt();
    const retainedDisposition = reduceExecutorAttempt(settled, {
      ...committedDisposition(),
      workspaceDisposition: "retain_for_janitor",
    });
    expect(
      reduceExecutorAttempt(retainedDisposition, {
        ...cleanupFinished(),
        outcome: "retained",
      }).phase,
    ).toBe("closed");
    expect(() =>
      reduceExecutorAttempt(retainedDisposition, {
        ...cleanupFinished(),
        outcome: "deleted",
      }),
    ).toThrowError(expect.objectContaining({ code: "EVENT_CONFLICT" }));
  });

  it("rejects out-of-order and cross-attempt events", () => {
    const initial = createExecutorAttemptState(identity);
    expect(() => reduceExecutorAttempt(initial, event("launch_confirmed"))).toThrowError(
      expect.objectContaining({ code: "TRANSITION_INVALID" }),
    );
    expect(() => reduceExecutorAttempt(initial, verifiedTerminal())).toThrowError(
      expect.objectContaining({ code: "TRANSITION_INVALID" }),
    );
    expect(() => reduceExecutorAttempt(initial, event("process_tree_zero"))).toThrowError(
      expect.objectContaining({ code: "TRANSITION_INVALID" }),
    );
    const launching = reduceExecutorAttempt(initial, event("launch_requested"));
    expect(() => reduceExecutorAttempt(launching, verifiedTerminal())).toThrowError(
      expect.objectContaining({ code: "TRANSITION_INVALID" }),
    );
    expect(() => reduceExecutorAttempt(launching, event("process_tree_zero"))).toThrowError(
      expect.objectContaining({ code: "TRANSITION_INVALID" }),
    );
    expect(() => reduceExecutorAttempt(initial, cleanupFinished())).toThrowError(
      expect.objectContaining({ code: "TRANSITION_INVALID" }),
    );
    for (const changedIdentity of [
      {
        ...identity,
        attemptCorrelationId: "20000000-0000-4000-8000-000000000002",
      },
      { ...identity, capabilityId: "f".repeat(64) },
      { ...identity, leaseGeneration: 8 },
      { ...identity, runAttemptId: "another-run" },
    ]) {
      expect(() =>
        reduceExecutorAttempt(initial, {
          ...event("launch_requested"),
          identity: changedIdentity,
        }),
      ).toThrowError(expect.objectContaining({ code: "IDENTITY_MISMATCH" }));
    }
  });

  it("makes closed and faulted states absorbing", () => {
    const faulted = reduceExecutorAttempt(createExecutorAttemptState(identity), {
      ...event("fatal"),
      code: "PROCESS_HOST_CHANNEL_FAILED",
    });
    expect(faulted.phase).toBe("faulted");
    expect(Object.isFrozen(faulted.fault)).toBe(true);
    expect(
      reduceExecutorAttempt(faulted, {
        ...event("fatal"),
        code: "PROCESS_HOST_CHANNEL_FAILED",
      }),
    ).toBe(faulted);
    expect(() =>
      reduceExecutorAttempt(faulted, {
        ...event("fatal"),
        code: "ANOTHER_FAILURE",
      }),
    ).toThrowError(expect.objectContaining({ code: "EVENT_CONFLICT" }));
    expect(() => reduceExecutorAttempt(faulted, stopRequested("shutdown"))).toThrowError(
      expect.objectContaining({ code: "ABSORBING_STATE" }),
    );

    const closed = reduceExecutorAttempt(
      reduceExecutorAttempt(settledDisposition(), cleanupFinished()),
      cleanupFinished(),
    );
    expect(closed.phase).toBe("closed");
    expect(() => reduceExecutorAttempt(closed, event("process_tree_zero"))).toThrowError(
      expect.objectContaining({ code: "ABSORBING_STATE" }),
    );
    expect(() =>
      reduceExecutorAttempt(closed, {
        ...event("fatal"),
        code: "LATE_FAILURE",
      }),
    ).toThrowError(expect.objectContaining({ code: "ABSORBING_STATE" }));
  });

  it("permits every non-closed lifecycle phase to fail closed", () => {
    const running = launchedAttempt();
    const states = [
      createExecutorAttemptState(identity),
      reduceExecutorAttempt(createExecutorAttemptState(identity), event("launch_requested")),
      running,
      reduceExecutorAttempt(running, stopRequested("shutdown")),
      reduceExecutorAttempt(running, verifiedTerminal()),
      settledAttempt(),
      settledDisposition(),
    ];
    for (const state of states) {
      const faulted = reduceExecutorAttempt(state, {
        ...event("fatal"),
        code: "ATTEMPT_FAILED_CLOSED",
      });
      expect(faulted.phase).toBe("faulted");
    }
  });

  it("rejects malformed identities, event facts, and forged mutable state", () => {
    expect(() =>
      createExecutorAttemptState({ ...identity, capabilityId: "0".repeat(64) }),
    ).toThrowError(expect.objectContaining({ code: "IDENTITY_INVALID" }));
    expect(() =>
      reduceExecutorAttempt(createExecutorAttemptState(identity), {
        ...stopRequested("cancelled"),
        reason: "unknown" as never,
      }),
    ).toThrowError(expect.objectContaining({ code: "EVENT_INVALID" }));

    const running = launchedAttempt();
    expect(() =>
      reduceExecutorAttempt(running, {
        ...verifiedTerminal(),
        payloadSha256: "not-a-digest",
      }),
    ).toThrowError(expect.objectContaining({ code: "EVENT_INVALID" }));

    const forged = { ...running, phase: "reserved" as const } as ExecutorAttemptState;
    expect(() => reduceExecutorAttempt(forged, event("process_tree_zero"))).toThrowError(
      expect.objectContaining({ code: "STATE_INVALID" }),
    );
    const frozenForgery = Object.freeze({ ...running, phase: "reserved" as const });
    expect(() => reduceExecutorAttempt(frozenForgery, event("process_tree_zero"))).toThrowError(
      expect.objectContaining({ code: "STATE_INVALID" }),
    );
    const initial = createExecutorAttemptState(identity);
    const impossibleSettlingState = Object.freeze({
      ...initial,
      phase: "settling" as const,
      processTreeZero: true,
    });
    expect(() =>
      reduceExecutorAttempt(impossibleSettlingState, event("process_tree_zero")),
    ).toThrowError(expect.objectContaining({ code: "STATE_INVALID" }));
    const launching = reduceExecutorAttempt(initial, event("launch_requested"));
    const forgedLaunchingTerminal = Object.freeze({
      ...launching,
      phase: "settling" as const,
      terminal: Object.freeze({
        outcome: "completed" as const,
        payloadSha256: terminalPayloadSha256,
      }),
    });
    expect(() =>
      reduceExecutorAttempt(forgedLaunchingTerminal, event("process_tree_zero")),
    ).toThrowError(expect.objectContaining({ code: "STATE_INVALID" }));

    const undefinedStop = Object.freeze({
      ...initial,
      phase: "stopping" as const,
      stop: undefined,
    }) as unknown as Readonly<ExecutorAttemptState>;
    expect(() => reduceExecutorAttempt(undefinedStop, event("process_tree_zero"))).toThrowError(
      expect.objectContaining({ code: "STATE_INVALID" }),
    );
    const invalidStop = Object.freeze({
      ...initial,
      phase: "stopping" as const,
      stop: Object.freeze({ reason: "unknown" }),
    }) as unknown as Readonly<ExecutorAttemptState>;
    expect(() => reduceExecutorAttempt(invalidStop, event("process_tree_zero"))).toThrowError(
      expect.objectContaining({ code: "STATE_INVALID" }),
    );
    const stoppedBeforeLaunch = reduceExecutorAttempt(initial, stopRequested("cancelled"));
    const forgedPreLaunchSuccess = Object.freeze({
      ...stoppedBeforeLaunch,
      phase: "settling" as const,
      terminal: Object.freeze({
        outcome: "completed" as const,
        payloadSha256: terminalPayloadSha256,
      }),
    });
    expect(() =>
      reduceExecutorAttempt(forgedPreLaunchSuccess, event("process_tree_zero")),
    ).toThrowError(expect.objectContaining({ code: "STATE_INVALID" }));
  });

  it("is deterministic and does not mutate its prior state", () => {
    const initial = createExecutorAttemptState(identity);
    const first = reduceExecutorAttempt(initial, event("launch_requested"));
    const second = reduceExecutorAttempt(initial, event("launch_requested"));

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(initial).toMatchObject({
      phase: "reserved",
      launchRequested: false,
      launchConfirmed: false,
    });
  });

  it("accepts only exact plain enumerable data-property inputs", () => {
    let getterReads = 0;
    const accessorIdentity = Object.defineProperties(
      {},
      {
        attemptCorrelationId: { enumerable: true, value: identity.attemptCorrelationId },
        capabilityId: { enumerable: true, value: identity.capabilityId },
        leaseGeneration: { enumerable: true, value: identity.leaseGeneration },
        runAttemptId: {
          enumerable: true,
          get() {
            getterReads += 1;
            return identity.runAttemptId;
          },
        },
      },
    );
    expect(() =>
      createExecutorAttemptState(accessorIdentity as unknown as ExecutorAttemptIdentity),
    ).toThrowError(expect.objectContaining({ code: "IDENTITY_INVALID" }));
    expect(getterReads).toBe(0);

    expect(() => createExecutorAttemptState({ ...identity, extra: true } as never)).toThrowError(
      expect.objectContaining({ code: "IDENTITY_INVALID" }),
    );
    const symbolIdentity = { ...identity, [Symbol("extra")]: true };
    expect(() => createExecutorAttemptState(symbolIdentity)).toThrowError(
      expect.objectContaining({ code: "IDENTITY_INVALID" }),
    );
    const nullPrototypeIdentity = Object.assign(Object.create(null), identity);
    expect(() =>
      createExecutorAttemptState(nullPrototypeIdentity as ExecutorAttemptIdentity),
    ).toThrowError(expect.objectContaining({ code: "IDENTITY_INVALID" }));

    const state = createExecutorAttemptState(identity);
    const accessorEvent = Object.defineProperties(
      {},
      {
        identity: { enumerable: true, value: identity },
        type: {
          enumerable: true,
          get() {
            getterReads += 1;
            return "launch_requested";
          },
        },
      },
    );
    expect(() =>
      reduceExecutorAttempt(state, accessorEvent as unknown as ExecutorAttemptEvent),
    ).toThrowError(expect.objectContaining({ code: "EVENT_INVALID" }));
    expect(getterReads).toBe(0);
    expect(() =>
      reduceExecutorAttempt(state, { ...event("launch_requested"), extra: true } as never),
    ).toThrowError(expect.objectContaining({ code: "EVENT_INVALID" }));

    const hiddenTypeEvent = { identity } as Record<string, unknown>;
    Object.defineProperty(hiddenTypeEvent, "type", {
      enumerable: false,
      value: "launch_requested",
    });
    expect(() =>
      reduceExecutorAttempt(state, hiddenTypeEvent as unknown as ExecutorAttemptEvent),
    ).toThrowError(expect.objectContaining({ code: "EVENT_INVALID" }));
  });

  it("does not consult Object.prototype for absent descriptor fields", () => {
    const originalGet = Object.getOwnPropertyDescriptor(Object.prototype, "get");
    const originalSet = Object.getOwnPropertyDescriptor(Object.prototype, "set");
    const originalType = Object.getOwnPropertyDescriptor(Object.prototype, "type");
    let prototypeGetterReads = 0;
    let missingTypeError: unknown;
    let launched: Readonly<ExecutorAttemptState> | undefined;
    try {
      for (const key of ["get", "set", "type"] as const) {
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          enumerable: false,
          get() {
            prototypeGetterReads += 1;
            return undefined;
          },
          set(_value: unknown) {},
        });
      }
      const state = createExecutorAttemptState(identity);
      launched = reduceExecutorAttempt(state, event("launch_requested"));
      try {
        reduceExecutorAttempt(state, { identity } as unknown as ExecutorAttemptEvent);
      } catch (error) {
        missingTypeError = error;
      }
    } finally {
      restoreObjectPrototypeProperty("get", originalGet);
      restoreObjectPrototypeProperty("set", originalSet);
      restoreObjectPrototypeProperty("type", originalType);
    }

    expect(prototypeGetterReads).toBe(0);
    expect(launched?.phase).toBe("launching");
    expect(missingTypeError).toEqual(expect.objectContaining({ code: "EVENT_INVALID" }));
  });
});

function event<TType extends ExecutorAttemptEvent["type"]>(
  type: TType,
): Readonly<{ readonly type: TType; readonly identity: ExecutorAttemptIdentity }> {
  return { type, identity };
}

function stopRequested(
  reason: Extract<ExecutorAttemptEvent, { readonly type: "stop_requested" }>["reason"],
): Extract<ExecutorAttemptEvent, { readonly type: "stop_requested" }> {
  return { ...event("stop_requested"), reason };
}

function verifiedTerminal(): Extract<ExecutorAttemptEvent, { readonly type: "terminal_verified" }> {
  return {
    ...event("terminal_verified"),
    outcome: "completed",
    payloadSha256: terminalPayloadSha256,
  };
}

function committedDisposition() {
  return {
    ...event("disposition_committed"),
    dispositionId,
    outcome: "committed" as const,
    terminalPayloadSha256,
    workspaceDisposition: "delete" as const,
  };
}

function cleanupFinished(): Extract<ExecutorAttemptEvent, { readonly type: "cleanup_finished" }> {
  return {
    ...event("cleanup_finished"),
    dispositionId,
    outcome: "deleted",
  };
}

function launchedAttempt(): Readonly<ExecutorAttemptState> {
  const launching = reduceExecutorAttempt(
    createExecutorAttemptState(identity),
    event("launch_requested"),
  );
  return reduceExecutorAttempt(launching, event("launch_confirmed"));
}

function settledAttempt(): Readonly<ExecutorAttemptState> {
  const terminal = reduceExecutorAttempt(launchedAttempt(), verifiedTerminal());
  return reduceExecutorAttempt(terminal, event("process_tree_zero"));
}

function settledDisposition(): Readonly<ExecutorAttemptState> {
  return reduceExecutorAttempt(settledAttempt(), committedDisposition());
}

function restoreObjectPrototypeProperty(
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(Object.prototype, key);
    return;
  }
  Object.defineProperty(Object.prototype, key, descriptor);
}
