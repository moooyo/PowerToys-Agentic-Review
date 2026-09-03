import { describe, expect, it } from "vitest";

import {
  createServerBindingSignerHostClientStateV1,
  reduceServerBindingSignerHostClientStateV1,
  SERVER_BINDING_SIGNER_HOST_MAXIMUM_ASSIGNED_REQUEST_IDS,
  type ServerBindingSignerHostClientEventV1,
  type ServerBindingSignerHostClientStateV1,
} from "./server-binding-signer-host-client-v1.js";

const instanceId = "d0000000-0000-4000-8000-000000000000";
const requestId = "a0000000-0000-4000-8000-000000000001";
const secondRequestId = "b0000000-0000-4000-8000-000000000002";
const shutdownRequestId = "c0000000-0000-4000-8000-000000000003";

const reduce = (
  state: Readonly<ServerBindingSignerHostClientStateV1>,
  event: Readonly<ServerBindingSignerHostClientEventV1>,
): Readonly<ServerBindingSignerHostClientStateV1> =>
  reduceServerBindingSignerHostClientStateV1(state, event);

const startLive = (): Readonly<ServerBindingSignerHostClientStateV1> =>
  reduce(reduce(createServerBindingSignerHostClientStateV1(), { type: "start", instanceId }), {
    type: "spawn_started",
  });

const ready = (): Readonly<ServerBindingSignerHostClientStateV1> =>
  reduce(startLive(), { type: "ready" });

describe("server binding signer-host client lifecycle v1", () => {
  it("follows start, sign, orderly shutdown, exit proof, and close", () => {
    const initial = createServerBindingSignerHostClientStateV1();
    expect(initial).toEqual({
      logicalState: "new",
      cleanupState: "no_spawn_attempt",
      activeRequestId: null,
      shutdownRequestId: null,
      shutdownAcknowledged: false,
      terminalCode: null,
      instanceId: null,
      usedRequestIds: [],
    });
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.usedRequestIds)).toBe(true);

    const started = reduce(initial, { type: "start", instanceId });
    const spawned = reduce(started, { type: "spawn_started" });
    const idle = reduce(spawned, { type: "ready" });
    const signing = reduce(idle, { type: "begin_sign", requestId });
    const settled = reduce(signing, { type: "settle_local_sign_operation", requestId });
    const closing = reduce(settled, { type: "close" });
    const shutdown = reduce(closing, { type: "send_shutdown", requestId: shutdownRequestId });
    const acknowledged = reduce(shutdown, {
      type: "ack_shutdown",
      requestId: shutdownRequestId,
    });
    const closed = reduce(acknowledged, { type: "exit_proven" });

    expect(closed).toEqual({
      logicalState: "closed",
      cleanupState: "exit_proven",
      activeRequestId: null,
      shutdownRequestId: null,
      shutdownAcknowledged: false,
      terminalCode: null,
      instanceId,
      usedRequestIds: [requestId, shutdownRequestId],
    });
    expect(reduce(closed, { type: "close" })).toBe(closed);
  });

  it("closes without spawn and closes a fenced startup after no-spawn proof", () => {
    const initial = createServerBindingSignerHostClientStateV1();
    expect(reduce(initial, { type: "close" })).toMatchObject({
      logicalState: "closed",
      cleanupState: "no_spawn_attempt",
    });

    const starting = reduce(initial, { type: "start", instanceId });
    const closing = reduce(starting, { type: "close" });
    expect(closing).toMatchObject({
      logicalState: "closing",
      cleanupState: "no_spawn_attempt",
    });
    expect(reduce(closing, { type: "spawn_not_started" })).toMatchObject({
      logicalState: "closed",
      cleanupState: "spawn_not_started",
    });
  });

  it("turns startup spawn failure into a terminal no-child fact", () => {
    const failed = reduce(
      reduce(createServerBindingSignerHostClientStateV1(), { type: "start", instanceId }),
      { type: "spawn_not_started" },
    );
    expect(failed).toMatchObject({
      logicalState: "failed",
      cleanupState: "spawn_not_started",
      terminalCode: "SIGNER_HOST_UNAVAILABLE",
    });
    expect(reduce(failed, { type: "close" })).toBe(failed);
  });

  it("retains the first startup failure until delayed child-creation facts settle", () => {
    const starting = reduce(createServerBindingSignerHostClientStateV1(), {
      type: "start",
      instanceId,
    });
    const failed = reduce(starting, { type: "fail", code: "SIGNER_HOST_UNAVAILABLE" });
    expect(failed).toMatchObject({
      cleanupState: "no_spawn_attempt",
      logicalState: "failed",
      terminalCode: "SIGNER_HOST_UNAVAILABLE",
    });
    expect(reduce(failed, { type: "spawn_not_started" })).toMatchObject({
      cleanupState: "spawn_not_started",
      logicalState: "failed",
      terminalCode: "SIGNER_HOST_UNAVAILABLE",
    });

    const lateChild = reduce(
      reduce(starting, { type: "fail", code: "SIGNER_HOST_PROTOCOL_FAILURE" }),
      { type: "spawn_started" },
    );
    expect(lateChild).toMatchObject({
      cleanupState: "termination_requested",
      logicalState: "failed",
      terminalCode: "SIGNER_HOST_PROTOCOL_FAILURE",
    });
    expect(reduce(lateChild, { type: "exit_proven" })).toMatchObject({
      cleanupState: "exit_proven",
      logicalState: "failed",
      terminalCode: "SIGNER_HOST_PROTOCOL_FAILURE",
    });
  });

  it("classifies a proved pre-ready child exit as startup unavailable", () => {
    const exited = reduce(startLive(), { type: "exit_proven" });
    expect(exited).toEqual({
      logicalState: "failed",
      cleanupState: "exit_proven",
      activeRequestId: null,
      shutdownRequestId: null,
      shutdownAcknowledged: false,
      terminalCode: "SIGNER_HOST_UNAVAILABLE",
      instanceId,
      usedRequestIds: [],
    });
  });

  it("forces a child that appears after startup was fenced", () => {
    const closing = reduce(
      reduce(createServerBindingSignerHostClientStateV1(), { type: "start", instanceId }),
      { type: "close" },
    );
    const terminating = reduce(closing, { type: "spawn_started" });
    expect(terminating).toMatchObject({
      logicalState: "closing",
      cleanupState: "termination_requested",
    });
    expect(reduce(terminating, { type: "exit_proven" })).toMatchObject({
      logicalState: "closed",
      cleanupState: "exit_proven",
    });
  });

  it("fences active signing during close and accepts only its late settlement", () => {
    const signing = reduce(ready(), { type: "begin_sign", requestId });
    const closing = reduce(signing, { type: "close" });
    expect(closing).toMatchObject({
      logicalState: "closing",
      cleanupState: "termination_requested",
      activeRequestId: requestId,
    });
    expect(() =>
      reduce(closing, { type: "settle_local_sign_operation", requestId: secondRequestId }),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_MISMATCH" }));
    const settled = reduce(closing, { type: "settle_local_sign_operation", requestId });
    expect(settled.activeRequestId).toBeNull();
    expect(reduce(settled, { type: "exit_proven" })).toMatchObject({
      logicalState: "closed",
      cleanupState: "exit_proven",
    });
  });

  it("rejects a second local signing call without changing the active request", () => {
    const signing = reduce(ready(), { type: "begin_sign", requestId });
    expect(reduce(signing, { type: "reject_busy" })).toBe(signing);
    expect(() =>
      reduce(signing, { type: "reject_busy", requestId: secondRequestId } as never),
    ).toThrowError(expect.objectContaining({ code: "EVENT_INVALID" }));
  });

  it("never reassigns a request ID during one client lifetime", () => {
    const signing = reduce(ready(), { type: "begin_sign", requestId });
    const settled = reduce(signing, { type: "settle_local_sign_operation", requestId });
    expect(settled.usedRequestIds).toEqual([requestId]);
    expect(Object.isFrozen(settled.usedRequestIds)).toBe(true);
    expect(() => reduce(settled, { type: "begin_sign", requestId })).toThrowError(
      expect.objectContaining({ code: "REQUEST_MISMATCH" }),
    );
    expect(() => reduce(settled, { type: "begin_sign", requestId: instanceId })).toThrowError(
      expect.objectContaining({ code: "REQUEST_MISMATCH" }),
    );
    const closing = reduce(settled, { type: "close" });
    expect(() => reduce(closing, { type: "send_shutdown", requestId })).toThrowError(
      expect.objectContaining({ code: "REQUEST_MISMATCH" }),
    );

    const secondSigning = reduce(settled, {
      type: "begin_sign",
      requestId: shutdownRequestId,
    });
    const secondSettled = reduce(secondSigning, {
      type: "settle_local_sign_operation",
      requestId: shutdownRequestId,
    });
    expect(secondSettled.usedRequestIds).toEqual([requestId, shutdownRequestId]);
  });

  it("bounds request history and reserves the final ID for orderly shutdown", () => {
    let state = ready();
    for (
      let index = 0;
      index < SERVER_BINDING_SIGNER_HOST_MAXIMUM_ASSIGNED_REQUEST_IDS - 1;
      index += 1
    ) {
      const generatedRequestId = `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      state = reduce(state, { type: "begin_sign", requestId: generatedRequestId });
      state = reduce(state, {
        type: "settle_local_sign_operation",
        requestId: generatedRequestId,
      });
    }
    expect(state.usedRequestIds).toHaveLength(
      SERVER_BINDING_SIGNER_HOST_MAXIMUM_ASSIGNED_REQUEST_IDS - 1,
    );
    expect(state.logicalState).toBe("closing");
    expect(() =>
      reduce(state, {
        type: "begin_sign",
        requestId: "20000000-0000-4000-8000-000000000000",
      }),
    ).toThrowError(expect.objectContaining({ code: "TRANSITION_INVALID" }));

    const closing = reduce(state, { type: "close" });
    expect(closing).toBe(state);
    const shutdown = reduce(closing, {
      type: "send_shutdown",
      requestId: "20000000-0000-4000-8000-000000000000",
    });
    expect(shutdown.usedRequestIds).toHaveLength(
      SERVER_BINDING_SIGNER_HOST_MAXIMUM_ASSIGNED_REQUEST_IDS,
    );
  });

  it("latches the first terminal cause while cleanup continues independently", () => {
    const failed = reduce(ready(), {
      type: "fail",
      code: "SIGNER_HOST_PROTOCOL_FAILURE",
    });
    expect(failed).toMatchObject({
      logicalState: "failed",
      cleanupState: "termination_requested",
      terminalCode: "SIGNER_HOST_PROTOCOL_FAILURE",
    });
    expect(reduce(failed, { type: "fail", code: "SIGNER_HOST_OUTCOME_UNKNOWN" })).toBe(failed);
    expect(reduce(failed, { type: "request_termination" })).toBe(failed);
    const exited = reduce(failed, { type: "exit_proven" });
    expect(exited).toMatchObject({
      logicalState: "failed",
      cleanupState: "exit_proven",
      terminalCode: "SIGNER_HOST_PROTOCOL_FAILURE",
    });
  });

  it("records unproved exit without replacing an earlier terminal cause", () => {
    expect(() => reduce(ready(), { type: "exit_unproven" })).toThrowError(
      expect.objectContaining({ code: "TRANSITION_INVALID" }),
    );
    const failed = reduce(ready(), {
      type: "fail",
      code: "SIGNER_HOST_OUTCOME_UNKNOWN",
    });
    expect(reduce(failed, { type: "exit_unproven" })).toMatchObject({
      logicalState: "failed",
      cleanupState: "exit_unproven",
      terminalCode: "SIGNER_HOST_OUTCOME_UNKNOWN",
    });

    const closing = reduce(ready(), { type: "close" });
    const terminating = reduce(closing, { type: "request_termination" });
    expect(reduce(terminating, { type: "exit_unproven" })).toMatchObject({
      logicalState: "failed",
      cleanupState: "exit_unproven",
      terminalCode: "SIGNER_HOST_EXIT_UNPROVEN",
    });
  });

  it("requires shutdown acknowledgement for an orderly child exit", () => {
    const closing = reduce(ready(), { type: "close" });
    const shutdown = reduce(closing, { type: "send_shutdown", requestId });
    const failed = reduce(shutdown, { type: "exit_proven" });
    expect(failed).toMatchObject({
      logicalState: "failed",
      cleanupState: "exit_proven",
      terminalCode: "SIGNER_HOST_PROTOCOL_FAILURE",
    });
  });

  it("rejects changed, missing, and duplicate shutdown correlation", () => {
    const closing = reduce(ready(), { type: "close" });
    expect(() =>
      reduce(closing, { type: "ack_shutdown", requestId: shutdownRequestId }),
    ).toThrowError(expect.objectContaining({ code: "TRANSITION_INVALID" }));
    const shutdown = reduce(closing, { type: "send_shutdown", requestId });
    expect(() =>
      reduce(shutdown, { type: "ack_shutdown", requestId: secondRequestId }),
    ).toThrowError(expect.objectContaining({ code: "REQUEST_MISMATCH" }));
    const acknowledged = reduce(shutdown, {
      type: "ack_shutdown",
      requestId,
    });
    expect(() => reduce(acknowledged, { type: "ack_shutdown", requestId })).toThrowError(
      expect.objectContaining({ code: "TRANSITION_INVALID" }),
    );
    expect(() =>
      reduce(acknowledged, { type: "send_shutdown", requestId: secondRequestId }),
    ).toThrowError(expect.objectContaining({ code: "TRANSITION_INVALID" }));
  });

  it("clears active correlation only after actual exit proof", () => {
    const signing = reduce(ready(), { type: "begin_sign", requestId });
    const quarantined = reduce(
      reduce(signing, { type: "fail", code: "SIGNER_HOST_OUTCOME_UNKNOWN" }),
      { type: "exit_unproven" },
    );
    expect(quarantined).toMatchObject({
      activeRequestId: requestId,
      cleanupState: "exit_unproven",
      logicalState: "failed",
    });
    const exited = reduce(quarantined, { type: "exit_proven" });
    expect(exited).toMatchObject({
      activeRequestId: null,
      cleanupState: "exit_proven",
      logicalState: "failed",
    });

    const unexpectedExit = reduce(reduce(ready(), { type: "begin_sign", requestId }), {
      type: "exit_proven",
    });
    expect(unexpectedExit).toMatchObject({
      activeRequestId: null,
      cleanupState: "exit_proven",
      logicalState: "failed",
      terminalCode: "SIGNER_HOST_OUTCOME_UNKNOWN",
    });
  });

  it("rejects invalid transitions without mutating the prior state", () => {
    const initial = createServerBindingSignerHostClientStateV1();
    for (const event of [
      { type: "ready" },
      { type: "begin_sign", requestId },
      { type: "request_termination" },
      { type: "exit_proven" },
      { type: "exit_unproven" },
    ] as const) {
      expect(() => reduce(initial, event)).toThrowError(
        expect.objectContaining({ code: "TRANSITION_INVALID" }),
      );
      expect(initial.logicalState).toBe("new");
    }
  });

  it("requires strict UUIDs and exact plain event data", () => {
    const initial = createServerBindingSignerHostClientStateV1();
    expect(() => reduce(initial, { type: "start" } as never)).toThrowError(
      expect.objectContaining({ code: "EVENT_INVALID" }),
    );
    const idle = ready();
    for (const invalidRequestId of [
      requestId.toUpperCase(),
      `${requestId}\n`,
      "not-a-uuid",
      "10000000-0000-5000-8000-000000000001",
    ]) {
      expect(() => reduce(idle, { type: "begin_sign", requestId: invalidRequestId })).toThrowError(
        expect.objectContaining({ code: "EVENT_INVALID" }),
      );
      expect(() => reduce(initial, { type: "start", instanceId: invalidRequestId })).toThrowError(
        expect.objectContaining({ code: "EVENT_INVALID" }),
      );
    }
    expect(() =>
      reduce(idle, { type: "begin_sign", requestId, extra: true } as never),
    ).toThrowError(expect.objectContaining({ code: "EVENT_INVALID" }));

    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "type", { enumerable: true, get: () => "close" });
    expect(() => reduce(idle, accessor as never)).toThrowError(
      expect.objectContaining({ code: "EVENT_INVALID" }),
    );

    const symbolEvent = { type: "close", [Symbol("secret")]: true };
    expect(() => reduce(idle, symbolEvent as never)).toThrowError(
      expect.objectContaining({ code: "EVENT_INVALID" }),
    );
  });

  it("rejects forged lifecycle snapshots", () => {
    expect(() =>
      reduceServerBindingSignerHostClientStateV1(
        Object.freeze({
          logicalState: "new",
          cleanupState: "no_spawn_attempt",
          activeRequestId: null,
          shutdownRequestId: null,
          shutdownAcknowledged: false,
          terminalCode: null,
          instanceId: null,
          usedRequestIds: [],
        }),
        { type: "close" },
      ),
    ).toThrowError(expect.objectContaining({ code: "STATE_INVALID" }));
  });
});
