import { parseCanonicalJson, serializeCanonicalJson } from "@agentic-review/local-protocol";
import { describe, expect, it } from "vitest";
import {
  encodeHostControlCall,
  encodeHostControlCancel,
  HOST_CONTROL_MAXIMUM_BODY_BYTES,
  HOST_CONTROL_MAXIMUM_CANONICAL_FRAME_BYTES,
  HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_BODY_BYTES,
  HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_FRAME_BYTES,
  HOST_CONTROL_MAXIMUM_FRAME_BYTES,
  HOST_CONTROL_MAXIMUM_REQUEST_FRAME_BYTES,
  HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES,
  HOST_CONTROL_MAXIMUM_SHUTDOWN_NOTIFICATION_BYTES,
  HostControlFrameDecoder,
  HostControlProtocolError,
  parseHostControlInbound,
  parseHostControlResponse,
} from "./host-control-protocol.js";
import { decodeHostControlOpaqueJson, encodeHostControlOpaqueJson } from "./opaque-json.js";

describe("HostControl role-local RPC protocol", () => {
  it("pins the cross-language physical frame ceilings", () => {
    expect(HOST_CONTROL_MAXIMUM_CANONICAL_FRAME_BYTES).toBe(1_048_576);
    expect(HOST_CONTROL_MAXIMUM_BODY_BYTES).toBe(1_048_576);
    expect(HOST_CONTROL_MAXIMUM_FRAME_BYTES).toBe(1_398_599);
    expect(HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES).toBe(2_113_536);
    expect(HOST_CONTROL_MAXIMUM_REQUEST_FRAME_BYTES).toBe(2_818_535);
    expect(HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_BODY_BYTES).toBe(16_777_216);
    expect(HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_FRAME_BYTES).toBe(22_369_945);
    expect(HOST_CONTROL_MAXIMUM_SHUTDOWN_NOTIFICATION_BYTES).toBe(1_024);
  });

  it("encodes canonical calls and transport cancellation with exact shapes", () => {
    const body = encodeHostControlOpaqueJson(
      { heartbeatSequence: 7 },
      HOST_CONTROL_MAXIMUM_BODY_BYTES,
    );
    const call = decodeFrame(
      encodeHostControlCall("InstanceHeartbeat", "request:1", {
        body,
        workerInstanceId: "worker:1",
      }),
    );
    expect(call).toEqual({
      operation: "InstanceHeartbeat",
      payload: { body, workerInstanceId: "worker:1" },
      protocolVersion: "1.0",
      requestId: "request:1",
      type: "call",
    });

    const cancel = decodeFrame(encodeHostControlCancel("cancel:1", "request:1"));
    expect(cancel).toEqual({
      protocolVersion: "1.0",
      requestId: "cancel:1",
      targetRequestId: "request:1",
      type: "cancel",
    });
    expect(JSON.stringify(cancel)).not.toMatch(/reason|token|url|path/iu);
  });

  it("rejects operation payload widening before writing a frame", () => {
    expect(() =>
      encodeHostControlCall("Register", "request:1", {
        body: encodeHostControlOpaqueJson({}, HOST_CONTROL_MAXIMUM_BODY_BYTES),
        url: "https://arbitrary.invalid",
      }),
    ).toThrow(HostControlProtocolError);
    expect(() => encodeHostControlCall("SignLocalDigest" as never, "request:1", {})).toThrow(
      HostControlProtocolError,
    );
  });

  it("keeps finite fractional JSON opaque inside the canonical envelope", () => {
    const body = encodeHostControlOpaqueJson({ confidence: 0.8 }, HOST_CONTROL_MAXIMUM_BODY_BYTES);
    const call = decodeFrame(encodeHostControlCall("Register", "request:1", { body })) as {
      readonly payload: { readonly body: unknown };
    };
    expect(decodeHostControlOpaqueJson(call.payload.body, HOST_CONTROL_MAXIMUM_BODY_BYTES)).toEqual(
      {
        confidence: 0.8,
      },
    );
  });

  it("derives opaque request ceilings from decoded bodies and maximum identifiers", () => {
    const exactBody = encodeHostControlOpaqueJson(
      { value: "x".repeat(HOST_CONTROL_MAXIMUM_BODY_BYTES - 12) },
      HOST_CONTROL_MAXIMUM_BODY_BYTES,
    );
    expect(exactBody.byteLength).toBe(HOST_CONTROL_MAXIMUM_BODY_BYTES);
    const exactFrame = encodeHostControlCall("InstanceHeartbeat", "r".repeat(128), {
      body: exactBody,
      workerInstanceId: "w".repeat(128),
    });
    expect(exactFrame.readUInt32LE(0)).toBe(HOST_CONTROL_MAXIMUM_FRAME_BYTES);
    expect(exactFrame.byteLength).toBe(HOST_CONTROL_MAXIMUM_FRAME_BYTES + 4);

    const exactCompletionBody = encodeHostControlOpaqueJson(
      { value: "x".repeat(HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES - 12) },
      HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES,
    );
    const exactCompletionFrame = encodeHostControlCall("CompleteRun", "r".repeat(128), {
      body: exactCompletionBody,
      runAttemptId: "a".repeat(128),
    });
    expect(exactCompletionFrame.readUInt32LE(0)).toBe(HOST_CONTROL_MAXIMUM_REQUEST_FRAME_BYTES);
    expect(exactCompletionFrame.byteLength).toBe(HOST_CONTROL_MAXIMUM_REQUEST_FRAME_BYTES + 4);

    const oversizedBody = encodeHostControlOpaqueJson(
      { value: "x".repeat(HOST_CONTROL_MAXIMUM_BODY_BYTES - 11) },
      HOST_CONTROL_MAXIMUM_BODY_BYTES + 1,
    );
    expect(() => encodeHostControlCall("Register", "request:1", { body: oversizedBody })).toThrow(
      HostControlProtocolError,
    );
  });

  it("incrementally decodes fragmented and coalesced frames", () => {
    const first = successFrame("request:1", { first: true });
    const second = successFrame("request:2", { second: true });
    const combined = Buffer.concat([first, second]);
    const decoder = new HostControlFrameDecoder();
    const documents: Buffer[] = [];
    for (const byte of combined) documents.push(...decoder.push(Buffer.from([byte])));
    decoder.end();
    expect(documents).toHaveLength(2);
    expect(parseHostControlResponse(documents[0] ?? Buffer.alloc(0))).toMatchObject({
      requestId: "request:1",
      outcome: "ok",
    });
    expect(parseHostControlResponse(documents[1] ?? Buffer.alloc(0))).toMatchObject({
      requestId: "request:2",
      outcome: "ok",
    });
  });

  it("rejects zero, oversize, and partial frames without resynchronizing", () => {
    for (const prefixValue of [0, HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_FRAME_BYTES + 1]) {
      const decoder = new HostControlFrameDecoder();
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(prefixValue, 0);
      expect(() => decoder.push(prefix)).toThrow(HostControlProtocolError);
      expect(() => decoder.push(Buffer.from("ignored"))).toThrow(HostControlProtocolError);
    }

    const partial = new HostControlFrameDecoder();
    expect(partial.push(Buffer.from([10, 0, 0, 0, 0x7b]))).toEqual([]);
    expect(() => partial.end()).toThrow(HostControlProtocolError);
  });

  it("strictly parses success and sanitized error responses", () => {
    const success = parseHostControlResponse(
      documentFromFrame(successFrame("request:1", { ok: true })),
    );
    expect(success).toMatchObject({ requestId: "request:1", outcome: "ok", body: { ok: true } });
    expect(Object.isFrozen(success.outcome === "ok" ? success.body : {})).toBe(true);

    const error = parseHostControlResponse(
      documentFromFrame(
        responseFrame({
          error: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "The Worker API failed.",
            retryable: true,
          },
          outcome: "error",
          protocolVersion: "1.0",
          requestId: "request:2",
          type: "response",
        }),
      ),
    );
    expect(error).toMatchObject({
      requestId: "request:2",
      outcome: "error",
      error: { code: "UPSTREAM_UNAVAILABLE", retryable: true },
    });
  });

  it("parses only the exact one-way ShutdownRequestedV1 shape", () => {
    const notification = {
      bootstrapId: "123e4567-e89b-42d3-a456-426614174000",
      notification: "ShutdownRequested",
      protocolVersion: "1.0",
      reasonCode: "SERVICE_STOP",
      requestedAtUnixMs: 1_700_000_000_000,
      role: "control",
      shutdownDeadlineUnixMs: 1_700_000_015_000,
      type: "notification",
    };
    const document = documentFromFrame(responseFrame(notification));
    expect(document.toString("utf8")).toBe(
      '{"bootstrapId":"123e4567-e89b-42d3-a456-426614174000","notification":"ShutdownRequested","protocolVersion":"1.0","reasonCode":"SERVICE_STOP","requestedAtUnixMs":1700000000000,"role":"control","shutdownDeadlineUnixMs":1700000015000,"type":"notification"}',
    );
    expect(parseHostControlInbound(document)).toEqual(notification);
    expect(() => parseHostControlResponse(document)).toThrow(HostControlProtocolError);

    for (const invalid of [
      { ...notification, role: "executor", extra: true },
      { ...notification, protocolVersion: "1.1" },
      { ...notification, notification: "Terminate" },
      { ...notification, shutdownDeadlineUnixMs: notification.requestedAtUnixMs },
      { ...notification, bootstrapId: "00000000-0000-0000-0000-000000000000" },
    ]) {
      expect(() => parseHostControlInbound(documentFromFrame(responseFrame(invalid)))).toThrow(
        HostControlProtocolError,
      );
    }
  });
});

function successFrame(requestId: string, body: Record<string, unknown>): Buffer {
  return responseFrame({
    body,
    outcome: "ok",
    protocolVersion: "1.0",
    requestId,
    type: "response",
  });
}

function responseFrame(value: Record<string, unknown>): Buffer {
  const document = Buffer.from(serializeCanonicalJson(value), "utf8");
  const frame = Buffer.alloc(4 + document.byteLength);
  frame.writeUInt32LE(document.byteLength, 0);
  document.copy(frame, 4);
  return frame;
}

function documentFromFrame(frame: Buffer): Buffer {
  return frame.subarray(4);
}

function decodeFrame(frame: Buffer): unknown {
  const length = frame.readUInt32LE(0);
  return parseCanonicalJson(frame.subarray(4, 4 + length), length);
}
