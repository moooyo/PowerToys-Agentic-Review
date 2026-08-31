import { PassThrough, Writable } from "node:stream";
import {
  decodeLocalFrame,
  encodeLocalFrame,
  type HelloAckMessage,
  type HelloMessage,
  LOCAL_PROTOCOL_NIL_CORRELATION_ID,
  LocalMessageType,
} from "@agentic-review/local-protocol";
import { describe, expect, it } from "vitest";
import {
  ArwxStdioChannel,
  ArwxStdioChannelError,
  commitArwxFinalFrameReceipt,
  consumeArwxFinalFrameReceipt,
} from "./arwx-stdio-channel.js";
import { drainedPayload, drainPayload } from "./runtime-bootstrap.test-helpers.js";

const sessionId = "10000000-0000-4000-8000-000000000001";
const executorBootId = "20000000-0000-4000-8000-000000000002";
const hex = (character: string): string => character.repeat(64);

const hello: HelloMessage = {
  protocolMajor: 1,
  minimumMinor: 0,
  maximumMinor: 0,
  workerNodeId: "worker-node",
  workerInstanceId: "worker-instance",
  executorBootId: null,
  sessionId,
  controlNonce: hex("1"),
  controlManifestSha256: hex("2"),
  controlPreflightSha256: hex("3"),
};

const helloAck: HelloAckMessage = {
  protocolMajor: 1,
  protocolMinor: 0,
  workerNodeId: "worker-node",
  workerInstanceId: "worker-instance",
  executorBootId,
  sessionId,
  controlNonce: hex("1"),
  executorNonce: hex("4"),
  executorManifestSha256: hex("5"),
  executorPolicySha256: hex("6"),
  executorPreflightSha256: hex("7"),
  maximumSlots: 4,
};

describe("ARWX standard-I/O channel", () => {
  it("serializes concurrent sends with strict sequence and keeps stdout frame-only", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const bytes: Buffer[] = [];
    output.on("data", (chunk: Buffer) => bytes.push(chunk));
    const channel = new ArwxStdioChannel({ localRole: "control", input, output });

    const first = channel.send({
      messageType: LocalMessageType.Hello,
      correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
      payload: hello,
    });
    const ping = {
      protocolMajor: 1 as const,
      protocolMinor: 0 as const,
      workerNodeId: "worker-node",
      workerInstanceId: "worker-instance",
      executorBootId,
      sessionId,
      probeId: hex("8"),
      sentAtUnixMs: 1_800_000_000_000,
    };
    const second = channel.send({
      messageType: LocalMessageType.Ping,
      correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
      payload: ping,
    });
    await Promise.all([first, second]);

    const combined = Buffer.concat(bytes);
    const firstLength = 48 + combined.readUInt32LE(16);
    const firstFrame = decodeLocalFrame(combined.subarray(0, firstLength), 1n);
    const secondFrame = decodeLocalFrame(combined.subarray(firstLength), 2n);
    expect(firstFrame.messageType).toBe(LocalMessageType.Hello);
    expect(secondFrame.messageType).toBe(LocalMessageType.Ping);
    channel.abort();
  });

  it("incrementally validates inbound direction and deeply frozen payloads", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "control", input, output });
    const received: unknown[] = [];
    const running = channel.run((message) => {
      received.push(message);
      expect(message.messageType).toBe(LocalMessageType.HelloAck);
      expect(Object.isFrozen(message.payload)).toBe(true);
    });
    const frame = encodeLocalFrame({
      minorVersion: 0,
      messageType: LocalMessageType.HelloAck,
      sequence: 1n,
      correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
      payload: helloAck,
    });
    for (const byte of frame) input.write(Buffer.from([byte]));
    await waitFor(() => received.length === 1);

    const draining = channel.drain();
    input.end();
    await Promise.all([running, draining]);
    expect(channel.state).toBe("closed");
  });

  it("fails closed when a role sends a message in the wrong direction", () => {
    const channel = new ArwxStdioChannel({
      localRole: "executor",
      input: new PassThrough(),
      output: new PassThrough(),
    });
    expect(() =>
      channel.send({
        messageType: LocalMessageType.Hello,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: hello,
      }),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_DIRECTION_INVALID" }));
    expect(channel.state).toBe("failed");
  });

  it("rejects the active send when the write callback reports failure", async () => {
    const channel = new ArwxStdioChannel({
      localRole: "control",
      input: new PassThrough(),
      output: new CallbackFailingWritable(),
    });

    const sending = channel.send({
      messageType: LocalMessageType.Hello,
      correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
      payload: hello,
    });

    await expect(sending).rejects.toMatchObject({ code: "OUTPUT_FAILED" });
    expect(channel.state).toBe("failed");
  });

  it("issues a final receipt only after the write and rejects every later send", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "control", input, output });
    const receipt = await channel.sendFinal(
      {
        messageType: LocalMessageType.Drain,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: drainPayload(),
      },
      performance.now() + 1_000,
    );
    expect(receipt.localRole).toBe("control");
    expect(() =>
      channel.send({
        messageType: LocalMessageType.Ping,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: {},
      }),
    ).toThrowError(expect.objectContaining({ code: "SHUTDOWN_STATE_INVALID" }));
    expect(channel.state).toBe("failed");
  });

  it("fails closed on the wrong final type or an expired final-write deadline", async () => {
    const wrongType = new ArwxStdioChannel({
      localRole: "control",
      input: new PassThrough(),
      output: new PassThrough(),
    });
    await expect(
      wrongType.sendFinal(
        {
          messageType: LocalMessageType.Ping,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: {},
        },
        performance.now() + 1_000,
      ),
    ).rejects.toMatchObject({ code: "SHUTDOWN_STATE_INVALID" });

    const expired = new ArwxStdioChannel({
      localRole: "control",
      input: new PassThrough(),
      output: new PassThrough(),
    });
    await expect(
      expired.sendFinal(
        {
          messageType: LocalMessageType.Drain,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainPayload(),
        },
        performance.now() - 1,
      ),
    ).rejects.toMatchObject({ code: "SHUTDOWN_STATE_INVALID" });
  });

  it("requires Executor to observe Drain before sending Drained", async () => {
    const channel = new ArwxStdioChannel({
      localRole: "executor",
      input: new PassThrough(),
      output: new PassThrough(),
    });

    await expect(
      channel.sendFinal(
        {
          messageType: LocalMessageType.Drained,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainedPayload(),
        },
        performance.now() + 1_000,
      ),
    ).rejects.toMatchObject({ code: "SHUTDOWN_STATE_INVALID" });
    expect(channel.state).toBe("failed");
  });

  it("rejects a business frame decoded in the same batch after peer Drain", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "executor", input, output });
    let dispatched = 0;
    const running = channel.run(() => {
      dispatched += 1;
    });
    input.write(
      Buffer.concat([
        encodeLocalFrame({
          minorVersion: 0,
          messageType: LocalMessageType.Drain,
          sequence: 1n,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainPayload(),
        }),
        encodeLocalFrame({
          minorVersion: 0,
          messageType: LocalMessageType.Hello,
          sequence: 2n,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: hello,
        }),
      ]),
    );

    await expect(running).rejects.toMatchObject({ code: "SHUTDOWN_STATE_INVALID" });
    expect(dispatched).toBe(1);
  });

  it("starts the absolute drain deadline as part of the Arm commit", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({
      localRole: "control",
      input,
      output,
      closeTimeoutMs: 100,
    });
    const running = channel.run(() => undefined);
    const receipt = await channel.sendFinal(
      {
        messageType: LocalMessageType.Drain,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: drainPayload(),
      },
      performance.now() + 50,
    );
    expect(consumeArwxFinalFrameReceipt(receipt, channel, "control")).toBeDefined();
    expect(commitArwxFinalFrameReceipt(receipt)).toBe(true);

    await expect(running).rejects.toMatchObject({ code: "OUTPUT_FAILED" });
    expect(channel.state).toBe("failed");
  });

  it("treats clean or partial EOF before drain as terminal", async () => {
    for (const partial of [false, true]) {
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();
      const channel = new ArwxStdioChannel({ localRole: "control", input, output });
      const running = channel.run(() => undefined);
      if (partial) input.write(Buffer.from("ARWX", "ascii"));
      input.end();
      await expect(running).rejects.toBeInstanceOf(ArwxStdioChannelError);
      expect(channel.state).toBe("failed");
    }
  });

  it("rejects a sequence gap and never dispatches the later frame", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "control", input, output });
    let dispatched = 0;
    const running = channel.run(() => {
      dispatched += 1;
    });
    input.write(
      encodeLocalFrame({
        minorVersion: 0,
        messageType: LocalMessageType.HelloAck,
        sequence: 2n,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: helloAck,
      }),
    );
    await expect(running).rejects.toMatchObject({ code: "FRAME_INVALID" });
    expect(dispatched).toBe(0);
  });

  it("stops dispatching a decoded batch after the channel becomes terminal", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "control", input, output });
    let dispatched = 0;
    const running = channel.run(() => {
      dispatched += 1;
      channel.abort();
    });
    const frame = (sequence: bigint): Buffer =>
      encodeLocalFrame({
        minorVersion: 0,
        messageType: LocalMessageType.HelloAck,
        sequence,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: helloAck,
      });
    input.write(Buffer.concat([frame(1n), frame(2n)]));

    await expect(running).rejects.toMatchObject({ code: "ABORTED" });
    expect(dispatched).toBe(1);
  });

  it("attempts to destroy both stream directions when one destroy throws", () => {
    const input = new ThrowingDestroyPassThrough();
    const output = new ThrowingDestroyPassThrough();
    const channel = new ArwxStdioChannel({ localRole: "control", input, output });

    expect(() => channel.abort()).not.toThrow();
    expect(input.destroyCalls).toBe(1);
    expect(output.destroyCalls).toBe(1);
  });
});

class CallbackFailingWritable extends Writable {
  public override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback(new Error("injected write failure"));
  }
}

class ThrowingDestroyPassThrough extends PassThrough {
  public destroyCalls = 0;

  public override destroy(_error?: Error): this {
    this.destroyCalls += 1;
    throw new Error("injected destroy failure");
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for ARWX message dispatch.");
}
