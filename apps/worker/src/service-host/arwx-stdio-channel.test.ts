import { PassThrough, Readable, Writable } from "node:stream";
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
  type ArwxDispatchScope,
  type ArwxFinalFrameReceipt,
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

  it.each(["control", "executor"] as const)(
    "rejects %s drain when the output final callback reports an error",
    async (role) => {
      const input = new PassThrough();
      const output = new DelayedFinalFailingWritable();
      const channel = new ArwxStdioChannel({ localRole: role, input, output });
      const running = channel.run(async (_message, dispatch) => {
        const receipt =
          role === "control"
            ? dispatch.readFinalFrameReceipt()
            : await dispatch.sendFinal(
                {
                  messageType: LocalMessageType.Drained,
                  correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
                  payload: drainedPayload(),
                },
                performance.now() + 1_000,
              );
        return dispatch.createPostDispatchFinalFrameEffect(receipt, () => {
          expect(consumeArwxFinalFrameReceipt(receipt, channel, role)).toBeDefined();
          expect(commitArwxFinalFrameReceipt(receipt)).toBe(true);
        });
      });
      const runningFailure = expect(running).rejects.toMatchObject({
        code: "OUTPUT_FAILED",
        message: "ARWX standard output finalization failed.",
      });

      if (role === "control") {
        await channel.sendFinal(
          {
            messageType: LocalMessageType.Drain,
            correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
            payload: drainPayload(),
          },
          performance.now() + 1_000,
        );
        input.end(drainedFrame(1n));
      } else {
        input.end(drainFrame(1n));
      }
      await waitFor(() => output.finalPending);
      const draining = channel.drain();
      const drainFailure = expect(draining).rejects.toMatchObject({
        code: "OUTPUT_FAILED",
        message: "ARWX standard output finalization failed.",
      });
      expect(await settlementByNextTurn(running)).toBe("pending");
      expect(await settlementByNextTurn(draining)).toBe("pending");

      output.failFinal();
      expect(channel.state).toBe("failed");

      await Promise.all([runningFailure, drainFailure]);
      await expect(channel.waitForQuiescence()).resolves.toBeUndefined();
      expect(channel.state).toBe("failed");
      expect(output.writableFinished).toBe(false);
    },
  );

  it("commits OUTPUT_FAILED when output.end throws synchronously", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.end = (() => {
      throw new Error("injected synchronous output finalization failure");
    }) as typeof output.end;
    const channel = new ArwxStdioChannel({ localRole: "control", input, output });
    const running = channel.run(() => undefined);
    const runningFailure = expect(running).rejects.toMatchObject({
      code: "OUTPUT_FAILED",
      message: "ARWX standard output finalization failed.",
    });
    const draining = channel.drain();
    const drainFailure = expect(draining).rejects.toMatchObject({
      code: "OUTPUT_FAILED",
      message: "ARWX standard output finalization failed.",
    });

    input.end();

    await Promise.all([runningFailure, drainFailure]);
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

  it("binds an early Drained frame only after the Control final write completes", async () => {
    const input = new PassThrough();
    const output = new DelayedCallbackWritable();
    const channel = new ArwxStdioChannel({ localRole: "control", input, output });
    let handlerStarted = false;
    let scopedReceipt: ArwxFinalFrameReceipt | undefined;
    let receiptConsumed = false;
    const running = channel.run((_message, dispatch) => {
      handlerStarted = true;
      const receipt = dispatch.readFinalFrameReceipt();
      scopedReceipt = receipt;
      return dispatch.createPostDispatchFinalFrameEffect(receipt, () => {
        receiptConsumed = consumeArwxFinalFrameReceipt(receipt, channel, "control") !== undefined;
        expect(commitArwxFinalFrameReceipt(receipt)).toBe(true);
      });
    });
    const sending = channel.sendFinal(
      {
        messageType: LocalMessageType.Drain,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: drainPayload(),
      },
      performance.now() + 5_000,
    );
    await waitFor(() => output.pendingWrites === 1);
    input.end(drainedFrame(1n));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handlerStarted).toBe(false);

    output.releaseNextWrite();
    const publicReceipt = await sending;
    await running;
    await channel.drain();
    expect(scopedReceipt).toBe(publicReceipt);
    expect(receiptConsumed).toBe(true);
    expect(channel.state).toBe("closed");
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

  it("runs a final-frame effect exactly once after dispatch is inactive", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "executor", input, output });
    const events: string[] = [];
    let effectCalls = 0;
    let receiptConsumed = false;
    const running = channel.run(async (message, dispatch) => {
      expect(message.messageType).toBe(LocalMessageType.Drain);
      events.push("handler:start");
      const receipt = await dispatch.sendFinal(
        {
          messageType: LocalMessageType.Drained,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainedPayload(),
        },
        performance.now() + 1_000,
      );
      const effect = dispatch.createPostDispatchFinalFrameEffect(receipt, () => {
        effectCalls += 1;
        events.push("effect:start");
        receiptConsumed = consumeArwxFinalFrameReceipt(receipt, channel, "executor") !== undefined;
        expect(commitArwxFinalFrameReceipt(receipt)).toBe(true);
        events.push("effect:end");
      });
      events.push("handler:end");
      return effect;
    });

    input.write(drainFrame(1n));
    await waitFor(() => channel.state === "draining");
    input.end();
    await Promise.all([running, channel.drain()]);

    expect(events).toEqual(["handler:start", "handler:end", "effect:start", "effect:end"]);
    expect(effectCalls).toBe(1);
    expect(receiptConsumed).toBe(true);
    expect(channel.state).toBe("closed");
  });

  it("fails closed when one dispatch attempts to register a second effect", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "executor", input, output });
    let effectCalls = 0;
    const running = channel.run(async (_message, dispatch) => {
      const receipt = await dispatch.sendFinal(
        {
          messageType: LocalMessageType.Drained,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainedPayload(),
        },
        performance.now() + 1_000,
      );
      dispatch.createPostDispatchFinalFrameEffect(receipt, () => {
        effectCalls += 1;
      });
      return dispatch.createPostDispatchFinalFrameEffect(receipt, () => {
        effectCalls += 1;
      });
    });

    input.write(drainFrame(1n));
    await expect(running).rejects.toMatchObject({ code: "DISPATCH_FAILED" });
    expect(effectCalls).toBe(0);
    expect(channel.state).toBe("failed");
  });

  it("fails closed when a handler does not return its issued effect", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "executor", input, output });
    let effectCalls = 0;
    const running = channel.run(async (_message, dispatch) => {
      const receipt = await dispatch.sendFinal(
        {
          messageType: LocalMessageType.Drained,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainedPayload(),
        },
        performance.now() + 1_000,
      );
      dispatch.createPostDispatchFinalFrameEffect(receipt, () => {
        effectCalls += 1;
      });
    });
    input.write(drainFrame(1n));

    await expect(running).rejects.toMatchObject({ code: "DISPATCH_FAILED" });
    expect(effectCalls).toBe(0);
    expect(channel.state).toBe("failed");
  });

  it("fails immediately when Executor Drain does not send Drained and return its effect", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "executor", input, output });
    const running = channel.run(() => undefined);

    input.write(drainFrame(1n));

    await expect(running).rejects.toMatchObject({ code: "DISPATCH_FAILED" });
    await expect(channel.waitForQuiescence()).resolves.toBeUndefined();
    expect(channel.state).toBe("failed");
  });

  it("observes a final write started before a synchronous handler failure", async () => {
    const input = new PassThrough();
    const output = new DelayedCallbackWritable();
    const channel = new ArwxStdioChannel({ localRole: "executor", input, output });
    let finalWrite: Promise<ArwxFinalFrameReceipt> | undefined;
    const running = channel.run((_message, dispatch) => {
      finalWrite = dispatch.sendFinal(
        {
          messageType: LocalMessageType.Drained,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainedPayload(),
        },
        performance.now() + 1_000,
      );
      void finalWrite.catch(() => undefined);
      throw new Error("injected synchronous dispatch failure");
    });
    const runningFailure = expect(running).rejects.toMatchObject({ code: "DISPATCH_FAILED" });

    input.write(drainFrame(1n));
    await waitFor(() => finalWrite !== undefined);

    await runningFailure;
    await expect(definedPromise(finalWrite)).rejects.toMatchObject({ code: "DISPATCH_FAILED" });
    expect(await settlementByNextTurn(channel.waitForQuiescence())).toBe("pending");
    output.releaseNextWrite();
    await expect(channel.waitForQuiescence()).resolves.toBeUndefined();
    expect(channel.state).toBe("failed");
  });

  it("does not grant final-frame effects to an ordinary business handler", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "control", input, output });
    let effectCalls = 0;
    const running = channel.run(async (_message, dispatch) => {
      const receipt = await dispatch.sendFinal(
        {
          messageType: LocalMessageType.Drain,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainPayload(),
        },
        performance.now() + 1_000,
      );
      return dispatch.createPostDispatchFinalFrameEffect(receipt, () => {
        effectCalls += 1;
      });
    });
    input.write(helloAckFrame(1n));

    await expect(running).rejects.toMatchObject({ code: "SHUTDOWN_STATE_INVALID" });
    expect(effectCalls).toBe(0);
    expect(channel.state).toBe("failed");
  });

  it("rejects Control final output before writing when a handler is active", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputBytes = 0;
    output.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
    });
    const channel = new ArwxStdioChannel({ localRole: "control", input, output });
    const gate = createGate();
    let handlerStarted = false;
    const running = channel.run(async () => {
      handlerStarted = true;
      await gate.promise;
    });
    input.write(helloAckFrame(1n));
    await waitFor(() => handlerStarted);

    await expect(
      channel.sendFinal(
        {
          messageType: LocalMessageType.Drain,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainPayload(),
        },
        performance.now() + 1_000,
      ),
    ).rejects.toMatchObject({ code: "SHUTDOWN_STATE_INVALID" });
    expect(await settlementByNextTurn(running)).toBe("rejected");
    expect(outputBytes).toBe(0);
    gate.release();
  });

  it("rejects stale dispatch authority before Executor final output", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputBytes = 0;
    output.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
    });
    const channel = new ArwxStdioChannel({ localRole: "executor", input, output });
    let capturedScope: Readonly<ArwxDispatchScope> | undefined;
    const running = channel.run((_message, dispatch) => {
      capturedScope = dispatch;
    });
    const runningFailure = expect(running).rejects.toMatchObject({ code: "DISPATCH_FAILED" });
    input.write(drainFrame(1n));
    await waitFor(() => capturedScope !== undefined);

    await expect(
      requireDispatchScope(capturedScope).sendFinal(
        {
          messageType: LocalMessageType.Drained,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainedPayload(),
        },
        performance.now() + 1_000,
      ),
    ).rejects.toMatchObject({ code: "SHUTDOWN_STATE_INVALID" });
    await runningFailure;
    expect(outputBytes).toBe(0);
  });

  it("revokes the dispatch scope before its effect begins", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "executor", input, output });
    let effectCalls = 0;
    let nestedEffectCalls = 0;
    const running = channel.run(async (_message, dispatch) => {
      const receipt = await dispatch.sendFinal(
        {
          messageType: LocalMessageType.Drained,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainedPayload(),
        },
        performance.now() + 1_000,
      );
      return dispatch.createPostDispatchFinalFrameEffect(receipt, () => {
        effectCalls += 1;
        dispatch.createPostDispatchFinalFrameEffect(receipt, () => {
          nestedEffectCalls += 1;
        });
      });
    });
    input.write(drainFrame(1n));

    await expect(running).rejects.toMatchObject({ code: "DISPATCH_FAILED" });
    expect(effectCalls).toBe(1);
    expect(nestedEffectCalls).toBe(0);
    expect(channel.state).toBe("failed");
  });

  it("fails closed when a post-dispatch effect rejects", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "executor", input, output });
    const dispatched: bigint[] = [];
    let effectCalls = 0;
    const running = channel.run(async (message, dispatch) => {
      dispatched.push(message.sequence);
      const receipt = await dispatch.sendFinal(
        {
          messageType: LocalMessageType.Drained,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainedPayload(),
        },
        performance.now() + 1_000,
      );
      return dispatch.createPostDispatchFinalFrameEffect(receipt, async () => {
        effectCalls += 1;
        throw new Error("injected post-dispatch failure");
      });
    });
    input.write(Buffer.concat([drainFrame(1n), helloFrame(2n)]));

    await expect(running).rejects.toMatchObject({ code: "DISPATCH_FAILED" });
    expect(effectCalls).toBe(1);
    expect(dispatched).toEqual([1n]);
    expect(channel.state).toBe("failed");
    expect(input.destroyed).toBe(true);
    expect(output.destroyed).toBe(true);
  });

  it("awaits the post-dispatch effect before inspecting the next decoded frame", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "executor", input, output });
    const gate = createGate();
    const events: string[] = [];
    const dispatched: bigint[] = [];
    let effectStarted = false;
    const running = channel.run(async (message, dispatch) => {
      dispatched.push(message.sequence);
      events.push(`handler:${message.sequence}`);
      const receipt = await dispatch.sendFinal(
        {
          messageType: LocalMessageType.Drained,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainedPayload(),
        },
        performance.now() + 1_000,
      );
      return dispatch.createPostDispatchFinalFrameEffect(receipt, async () => {
        events.push("effect:start");
        effectStarted = true;
        await gate.promise;
        events.push("effect:end");
      });
    });
    input.write(Buffer.concat([drainFrame(1n), helloFrame(2n)]));

    const runningFailure = expect(running).rejects.toMatchObject({
      code: "DISPATCH_FAILED",
    });
    try {
      await waitFor(() => effectStarted);
      expect(events).toEqual(["handler:1", "effect:start"]);
      expect(dispatched).toEqual([1n]);
      expect(channel.state).toBe("open");
    } finally {
      gate.release();
      await runningFailure;
    }
    expect(events).toEqual(["handler:1", "effect:start", "effect:end"]);
    expect(dispatched).toEqual([1n]);
    expect(channel.state).toBe("failed");
  });

  it("rejects a post-dispatch effect bound to another channel's receipt", async () => {
    const foreignInput = new PassThrough();
    const foreignOutput = new PassThrough();
    foreignOutput.resume();
    const foreignChannel = new ArwxStdioChannel({
      localRole: "executor",
      input: foreignInput,
      output: foreignOutput,
    });
    const foreignGate = createGate();
    let foreignReceipt: ArwxFinalFrameReceipt | undefined;
    let foreignEffectStarted = false;
    let foreignReceiptConsumed = false;
    const foreignRunning = foreignChannel.run(async (_message, dispatch) => {
      const receipt = await dispatch.sendFinal(
        {
          messageType: LocalMessageType.Drained,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainedPayload(),
        },
        performance.now() + 1_000,
      );
      foreignReceipt = receipt;
      return dispatch.createPostDispatchFinalFrameEffect(receipt, async () => {
        foreignEffectStarted = true;
        await foreignGate.promise;
        const receipt = requireReceipt(foreignReceipt);
        foreignReceiptConsumed =
          consumeArwxFinalFrameReceipt(receipt, foreignChannel, "executor") !== undefined;
        expect(commitArwxFinalFrameReceipt(receipt)).toBe(true);
      });
    });
    foreignInput.write(drainFrame(1n));
    await waitFor(() => foreignReceipt !== undefined && foreignEffectStarted);
    const receipt = requireReceipt(foreignReceipt);

    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "executor", input, output });
    let effectCalls = 0;
    const running = channel.run((_message, dispatch) =>
      dispatch.createPostDispatchFinalFrameEffect(receipt, () => {
        effectCalls += 1;
      }),
    );
    input.write(drainFrame(1n));

    await expect(running).rejects.toMatchObject({ code: "DISPATCH_FAILED" });
    expect(effectCalls).toBe(0);
    expect(channel.state).toBe("failed");
    expect(foreignChannel.state).toBe("open");
    expect(foreignReceiptConsumed).toBe(false);
    foreignGate.release();
    await waitFor(() => foreignReceiptConsumed && foreignChannel.state === "draining");
    foreignInput.end();
    await Promise.all([foreignRunning, foreignChannel.drain()]);
    expect(foreignChannel.state).toBe("closed");
  });

  it.each(["abort", "close"] as const)(
    "settles a pending post-dispatch effect when the channel receives %s",
    async (action) => {
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();
      const channel = new ArwxStdioChannel({ localRole: "executor", input, output });
      let effectCalls = 0;
      let effectCompletions = 0;
      let cancellationObserved = false;
      const running = channel.run(async (_message, dispatch) => {
        const receipt = await dispatch.sendFinal(
          {
            messageType: LocalMessageType.Drained,
            correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
            payload: drainedPayload(),
          },
          performance.now() + 1_000,
        );
        return dispatch.createPostDispatchFinalFrameEffect(receipt, async (signal) => {
          effectCalls += 1;
          await waitForAbort(signal);
          cancellationObserved = signal.aborted;
          effectCompletions += 1;
        });
      });
      input.write(drainFrame(1n));
      await waitFor(() => effectCalls === 1);

      if (action === "abort") {
        channel.abort();
        await expect(running).rejects.toMatchObject({ code: "ABORTED" });
      } else {
        const closing = channel.close();
        await Promise.all([
          expect(closing).rejects.toMatchObject({ code: "SHUTDOWN_STATE_INVALID" }),
          expect(running).rejects.toMatchObject({ code: "SHUTDOWN_STATE_INVALID" }),
        ]);
      }
      expect(channel.state).toBe("failed");
      expect(effectCalls).toBe(1);
      expect(effectCompletions).toBe(1);
      expect(cancellationObserved).toBe(true);
    },
  );

  it("settles immediately when a post-dispatch effect ignores cancellation", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "executor", input, output });
    const gate = createGate();
    let effectStarted = false;
    let effectFinished = false;
    const running = channel.run(async (_message, dispatch) => {
      const receipt = await dispatch.sendFinal(
        {
          messageType: LocalMessageType.Drained,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainedPayload(),
        },
        performance.now() + 5_000,
      );
      return dispatch.createPostDispatchFinalFrameEffect(receipt, async () => {
        effectStarted = true;
        await gate.promise;
        effectFinished = true;
      });
    });
    input.write(drainFrame(1n));
    await waitFor(() => effectStarted);

    channel.abort();
    expect(await settlementByNextTurn(running)).toBe("rejected");
    expect(await settlementByNextTurn(channel.waitForQuiescence())).toBe("pending");
    expect(effectFinished).toBe(false);
    gate.release();
    await waitFor(() => effectFinished);
    await expect(channel.waitForQuiescence()).resolves.toBeUndefined();
  });

  it("settles immediately when an active handler ignores channel cancellation", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "control", input, output });
    const gate = createGate();
    let handlerStarted = false;
    let cancellationObserved = false;
    const running = channel.run(async (_message, _dispatch, signal) => {
      handlerStarted = true;
      await gate.promise;
      cancellationObserved = signal.aborted;
    });
    input.write(helloAckFrame(1n));
    await waitFor(() => handlerStarted);

    channel.abort();
    expect(await settlementByNextTurn(running)).toBe("rejected");
    expect(await settlementByNextTurn(channel.waitForQuiescence())).toBe("pending");
    gate.release();
    await waitFor(() => cancellationObserved);
    await expect(channel.waitForQuiescence()).resolves.toBeUndefined();
  });

  it("settles bootstrap done from definitive failure before a stuck input iterator exits", async () => {
    const input = new NonTerminatingDestroyReadable();
    const output = new PassThrough();
    let terminalObservations = 0;
    const channel = new ArwxStdioChannel({ localRole: "control", input, output });
    const receiveLoop = channel.startRuntimeBootstrapReceiveLoop(
      () => undefined,
      () => {
        terminalObservations += 1;
      },
    );
    const doneFailure = expect(receiveLoop.done).rejects.toMatchObject({ code: "ABORTED" });

    channel.abort();

    await doneFailure;
    expect(terminalObservations).toBe(1);
    expect(input.destroyCalls).toBe(1);
    expect(await settlementByNextTurn(channel.waitForQuiescence())).toBe("pending");
    input.finish();
    await expect(channel.waitForQuiescence()).resolves.toBeUndefined();
  });

  it("lets an active business dispatch settle before entering drain", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const channel = new ArwxStdioChannel({ localRole: "control", input, output });
    const gate = createGate();
    let handlerStarted = false;
    const running = channel.run(async () => {
      handlerStarted = true;
      await gate.promise;
    });
    input.write(helloAckFrame(1n));
    await waitFor(() => handlerStarted);

    const draining = channel.drain(performance.now() + 1_000);
    expect(channel.state).toBe("open");
    expect(await settlementByNextTurn(draining)).toBe("pending");
    gate.release();
    await waitFor(() => channel.state === "draining");
    input.end();

    await Promise.all([running, draining, channel.waitForQuiescence()]);
    expect(channel.state).toBe("closed");
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

    await expect(running).rejects.toMatchObject({ code: "DISPATCH_FAILED" });
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
    const running = channel.run((_message, dispatch) => {
      const receipt = dispatch.readFinalFrameReceipt();
      return dispatch.createPostDispatchFinalFrameEffect(receipt, () => {
        expect(consumeArwxFinalFrameReceipt(receipt, channel, "control")).toBeDefined();
        expect(commitArwxFinalFrameReceipt(receipt)).toBe(true);
      });
    });
    const receipt = await channel.sendFinal(
      {
        messageType: LocalMessageType.Drain,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: drainPayload(),
      },
      performance.now() + 50,
    );
    input.write(drainedFrame(1n));
    expect(receipt.localRole).toBe("control");

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

class DelayedCallbackWritable extends Writable {
  readonly #callbacks: Array<(error?: Error | null) => void> = [];

  public get pendingWrites(): number {
    return this.#callbacks.length;
  }

  public releaseNextWrite(): void {
    const callback = this.#callbacks.shift();
    if (callback === undefined) throw new Error("Expected a pending output write.");
    callback();
  }

  public override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#callbacks.push(callback);
  }
}

class DelayedFinalFailingWritable extends Writable {
  #finalCallback: ((error?: Error | null) => void) | undefined;

  public get finalPending(): boolean {
    return this.#finalCallback !== undefined;
  }

  public failFinal(): void {
    const callback = this.#finalCallback;
    if (callback === undefined) throw new Error("Expected a pending output final callback.");
    this.#finalCallback = undefined;
    callback(new Error("injected output final failure"));
  }

  public override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }

  public override _final(callback: (error?: Error | null) => void): void {
    this.#finalCallback = callback;
  }
}

class ThrowingDestroyPassThrough extends PassThrough {
  public destroyCalls = 0;

  public override destroy(_error?: Error): this {
    this.destroyCalls += 1;
    throw new Error("injected destroy failure");
  }
}

class NonTerminatingDestroyReadable extends Readable {
  public destroyCalls = 0;

  public override _read(): void {}

  public override destroy(_error?: Error): this {
    this.destroyCalls += 1;
    return this;
  }

  public finish(): void {
    super.destroy();
  }
}

function drainFrame(sequence: bigint): Buffer {
  return encodeLocalFrame({
    minorVersion: 0,
    messageType: LocalMessageType.Drain,
    sequence,
    correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
    payload: drainPayload(),
  });
}

function helloFrame(sequence: bigint): Buffer {
  return encodeLocalFrame({
    minorVersion: 0,
    messageType: LocalMessageType.Hello,
    sequence,
    correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
    payload: hello,
  });
}

function helloAckFrame(sequence: bigint): Buffer {
  return encodeLocalFrame({
    minorVersion: 0,
    messageType: LocalMessageType.HelloAck,
    sequence,
    correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
    payload: helloAck,
  });
}

function drainedFrame(sequence: bigint): Buffer {
  return encodeLocalFrame({
    minorVersion: 0,
    messageType: LocalMessageType.Drained,
    sequence,
    correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
    payload: drainedPayload(),
  });
}

function createGate(): { readonly promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return Object.freeze({ promise, release });
}

function requireReceipt(receipt: ArwxFinalFrameReceipt | undefined): ArwxFinalFrameReceipt {
  if (receipt === undefined) throw new Error("Expected an ARWX final-frame receipt.");
  return receipt;
}

function requireDispatchScope(
  scope: Readonly<ArwxDispatchScope> | undefined,
): Readonly<ArwxDispatchScope> {
  if (scope === undefined) throw new Error("Expected an ARWX dispatch scope.");
  return scope;
}

function definedPromise<T>(promise: Promise<T> | undefined): Promise<T> {
  if (promise === undefined) throw new Error("Expected a started promise.");
  return promise;
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function settlementByNextTurn(
  promise: Promise<unknown>,
): Promise<"pending" | "rejected" | "resolved"> {
  return await Promise.race([
    promise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for ARWX message dispatch.");
}
