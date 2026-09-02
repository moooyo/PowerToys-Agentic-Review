import { createHash } from "node:crypto";
import { Duplex } from "node:stream";
import {
  decodeLocalFrame,
  encodeLocalFrame,
  LOCAL_PROTOCOL_NIL_CORRELATION_ID,
  LocalMessageType,
  serializeCanonicalJson,
} from "@agentic-review/local-protocol";
import { describe, expect, it, vi } from "vitest";
import type { ArwxFinalFrameReceipt } from "./arwx-stdio-channel.js";
import {
  connectExecutorHostControl,
  ExecutorHostControlError,
  isExecutorHostControlSession,
} from "./executor-host-control-session.js";
import {
  parseServiceHostLaunchContract,
  SERVICE_HOST_CONTROL_PIPE_PREFIX,
} from "./launch-contract.js";
import {
  createTestBootstrapPreparation,
  drainedPayload,
  drainPayload,
  handleBootstrapTestWrite,
  installBootstrapTestHost,
  type TestBootstrapArwxContext,
} from "./runtime-bootstrap.test-helpers.js";

class FakeExecutorHostControl extends Duplex {
  public clientEnded = false;
  public endReadableOnClientEnd = true;
  public readonly writes: Buffer[] = [];

  public constructor() {
    super({ allowHalfOpen: false });
    installBootstrapTestHost(this, "executor", 5);
  }

  public override _read(): void {}

  public override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (handleBootstrapTestWrite(this, chunk, callback)) return;
    this.writes.push(Buffer.from(chunk));
    callback();
  }

  public respond(value: Record<string, unknown>, fragments = 1): void {
    const document = Buffer.from(serializeCanonicalJson(value), "utf8");
    const frame = Buffer.alloc(4 + document.byteLength);
    frame.writeUInt32LE(document.byteLength, 0);
    document.copy(frame, 4);
    const size = Math.max(1, Math.ceil(frame.byteLength / fragments));
    for (let offset = 0; offset < frame.byteLength; offset += size) {
      this.push(frame.subarray(offset, Math.min(frame.byteLength, offset + size)));
    }
  }

  public requests(): Array<Record<string, unknown>> {
    return this.writes.map((frame) => {
      const length = frame.readUInt32LE(0);
      return JSON.parse(frame.subarray(4, 4 + length).toString("utf8")) as Record<string, unknown>;
    });
  }

  public override _final(callback: (error?: Error | null) => void): void {
    this.clientEnded = true;
    callback();
    if (this.endReadableOnClientEnd) queueMicrotask(() => this.push(null));
  }
}

class DelayedFinalExecutorHostControl extends FakeExecutorHostControl {
  #finalCallback: ((error?: Error | null) => void) | undefined;

  public get finalPending(): boolean {
    return this.#finalCallback !== undefined;
  }

  public releaseFinal(error?: Error): void {
    const callback = this.#finalCallback;
    if (callback === undefined) {
      throw new Error("No Executor HostControl final callback is pending.");
    }
    this.#finalCallback = undefined;
    callback(error);
    if (error === undefined) queueMicrotask(() => this.push(null));
  }

  public override _final(callback: (error?: Error | null) => void): void {
    this.clientEnded = true;
    this.#finalCallback = callback;
  }

  public override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    setImmediate(() => callback(error));
  }
}

const selector = `${SERVICE_HOST_CONTROL_PIPE_PREFIX}${"b".repeat(64)}`;
const pipe = parseServiceHostLaunchContract(
  [
    "--service-role=executor",
    "--servicehost-arwx-stdio",
    `--servicehost-host-control-pipe=${selector}`,
  ],
  "executor",
).hostControlPipe;

describe("Executor HostControl session", () => {
  it("connects without exposing a privileged RPC surface and drains cleanly", async () => {
    const host = new FakeExecutorHostControl();
    const session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor"),
      connector: async () => host,
      closeTimeoutMs: 1_000,
    });

    expect(session.role).toBe("executor");
    expect(session.bootstrap.bootstrap.role).toBe("executor");
    expect(isExecutorHostControlSession(session)).toBe(true);
    expect(isExecutorHostControlSession(Object.create(session))).toBe(false);
    expect("register" in session).toBe(false);
    expect("signLocalDigest" in session).toBe(false);
    await session.drain();
    expect(host.clientEnded).toBe(true);
  });

  it("arms an actual Drained frame and resolves early ARWX EOF only after the exact echo", async () => {
    const host = new FakeExecutorHostControl();
    let arwxContext: TestBootstrapArwxContext | undefined;
    let receipt: ArwxFinalFrameReceipt | undefined;
    let armResult: unknown;
    let session!: Awaited<ReturnType<typeof connectExecutorHostControl>>;
    session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor", {
        onStarted: (value) => {
          arwxContext = value;
        },
        handler: async (_message, dispatch) => {
          receipt = await dispatch.sendFinal(
            {
              messageType: LocalMessageType.Drained,
              correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
              payload: drainedPayload(),
            },
            performance.now() + 1_000,
          );
          const finalReceipt = receipt;
          return dispatch.createPostDispatchFinalFrameEffect(finalReceipt, async () => {
            armResult = await session.armArwxShutdown(finalReceipt);
          });
        },
      }),
      connector: async () => host,
      closeTimeoutMs: 1_000,
    });
    const runtime = defined(arwxContext, "ARWX context");
    runtime.input.end(
      encodeLocalFrame({
        minorVersion: 0,
        messageType: LocalMessageType.Drain,
        sequence: 1n,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: drainPayload(),
      }),
    );
    await waitFor(() => receipt !== undefined);
    const finalFrame = runtime.output.read() as Buffer;
    expect(decodeLocalFrame(finalFrame)).toMatchObject({
      messageType: LocalMessageType.Drained,
      sequence: 1n,
    });

    await waitFor(() => host.writes.length === 1);
    const request = defined(host.requests()[0], "Arm request");
    const payload = request.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      finalMessageType: LocalMessageType.Drained,
      finalSequence: "1",
      finalFrameBytes: finalFrame.byteLength,
      finalFrameSha256: createHash("sha256").update(finalFrame).digest("hex"),
    });
    host.respond(success(request.requestId as string, { armed: true, ...payload }), 4);

    await expect(runtime.receiveLoop.done).resolves.toBeUndefined();
    expect(armResult).toEqual({ armed: true, ...payload });
    expect(runtime.output.writableEnded).toBe(true);
    expect(host.clientEnded).toBe(true);
    await session.drain();
  });

  it("rejects Arm when the Executor HostControl writable half-close callback fails", async () => {
    const host = new DelayedFinalExecutorHostControl();
    let arwxContext: TestBootstrapArwxContext | undefined;
    let receipt: ArwxFinalFrameReceipt | undefined;
    let arming: Promise<unknown> | undefined;
    let session!: Awaited<ReturnType<typeof connectExecutorHostControl>>;
    session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor", {
        onStarted: (value) => {
          arwxContext = value;
        },
        handler: async (_message, dispatch) => {
          receipt = await dispatch.sendFinal(
            {
              messageType: LocalMessageType.Drained,
              correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
              payload: drainedPayload(),
            },
            performance.now() + 1_000,
          );
          const finalReceipt = receipt;
          return dispatch.createPostDispatchFinalFrameEffect(finalReceipt, async () => {
            arming = session.armArwxShutdown(finalReceipt);
            await arming;
          });
        },
      }),
      connector: async () => host,
      closeTimeoutMs: 1_000,
    });
    const runtime = defined(arwxContext, "ARWX context");
    runtime.input.end(
      encodeLocalFrame({
        minorVersion: 0,
        messageType: LocalMessageType.Drain,
        sequence: 1n,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: drainPayload(),
      }),
    );
    await waitFor(() => receipt !== undefined);
    await waitFor(() => host.writes.length === 1);
    const request = defined(host.requests()[0], "Arm request");
    const payload = request.payload as Record<string, unknown>;
    host.respond(success(request.requestId as string, { armed: true, ...payload }));

    await waitFor(() => host.finalPending);
    const armFailure = expect(defined(arming, "Arm operation")).rejects.toMatchObject({
      code: "PROTOCOL_FAILURE",
    });
    const sessionFailure = expect(session.done).rejects.toMatchObject({
      code: "PROTOCOL_FAILURE",
    });
    const receiveFailure = expect(runtime.receiveLoop.done).rejects.toBeInstanceOf(Error);
    const hostClosed = new Promise<void>((resolve) => host.once("close", () => resolve()));
    host.releaseFinal(new Error("Executor HostControl final callback failed"));

    await Promise.all([armFailure, sessionFailure, receiveFailure, hostClosed]);
  });

  it("accepts EOF before a successful writable callback and settles before close", async () => {
    const host = new DelayedFinalExecutorHostControl();
    const session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor"),
      connector: async () => host,
      closeTimeoutMs: 1_000,
    });
    const settlements: string[] = [];
    const draining = session.drain().then(() => settlements.push("drain"));
    const done = session.done.then(() => settlements.push("done"));
    await waitFor(() => host.finalPending);
    host.push(null);
    await waitFor(() => host.readableEnded);
    host.once("finish", () => host.emit("close"));

    host.releaseFinal();

    await Promise.all([draining, done]);
    expect([...settlements].sort()).toEqual(["done", "drain"]);
  });

  it.each(["success", "error"] as const)(
    "rejects drain when EOF and close precede a late Executor final callback %s",
    async (lateOutcome) => {
      const host = new DelayedFinalExecutorHostControl();
      const session = await connectExecutorHostControl({
        role: "executor",
        pipe,
        prepareRuntimeBootstrap: createTestBootstrapPreparation("executor"),
        connector: async () => host,
        closeTimeoutMs: 1_000,
      });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        const draining = session.drain();
        const drainFailure = expect(draining).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
        const doneFailure = expect(session.done).rejects.toMatchObject({
          code: "PROTOCOL_FAILURE",
        });
        await waitFor(() => host.finalPending);
        host.push(null);
        await waitFor(() => host.readableEnded);

        host.emit("close");

        await Promise.all([drainFailure, doneFailure]);
        expect(host.finalPending).toBe(true);
        host.releaseFinal(
          lateOutcome === "error" ? new Error("late Executor final failure") : undefined,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.removeListener("unhandledRejection", onUnhandled);
        host.destroy();
      }
    },
  );

  it("rejects close-only HostControl termination after Executor Arm acknowledgement", async () => {
    const host = new FakeExecutorHostControl();
    host.endReadableOnClientEnd = false;
    let arwxContext: TestBootstrapArwxContext | undefined;
    let receipt: ArwxFinalFrameReceipt | undefined;
    let session!: Awaited<ReturnType<typeof connectExecutorHostControl>>;
    session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor", {
        onStarted: (value) => {
          arwxContext = value;
        },
        handler: async (_message, dispatch) => {
          receipt = await dispatch.sendFinal(
            {
              messageType: LocalMessageType.Drained,
              correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
              payload: drainedPayload(),
            },
            performance.now() + 1_000,
          );
          const finalReceipt = receipt;
          return dispatch.createPostDispatchFinalFrameEffect(finalReceipt, async () => {
            await session.armArwxShutdown(finalReceipt);
          });
        },
      }),
      connector: async () => host,
      closeTimeoutMs: 1_000,
    });
    const runtime = defined(arwxContext, "ARWX context");
    runtime.input.end(
      encodeLocalFrame({
        minorVersion: 0,
        messageType: LocalMessageType.Drain,
        sequence: 1n,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: drainPayload(),
      }),
    );
    await waitFor(() => receipt !== undefined);
    await waitFor(() => host.writes.length === 1);
    const request = defined(host.requests()[0], "Arm request");
    const payload = request.payload as Record<string, unknown>;
    host.respond(success(request.requestId as string, { armed: true, ...payload }));
    await waitFor(() => host.clientEnded);
    host.destroy();

    await expect(session.done).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
    await expect(session.drain()).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
    runtime.arwx.abort();
    await runtime.receiveLoop.done.catch(() => undefined);
  });

  it("rejects Arm when HostControl drain fails synchronously after a valid acknowledgement", async () => {
    const host = new FakeExecutorHostControl();
    let arwxContext: TestBootstrapArwxContext | undefined;
    let receipt: ArwxFinalFrameReceipt | undefined;
    let arming: Promise<unknown> | undefined;
    const absoluteDeadline = performance.now() + 1_000;
    let session!: Awaited<ReturnType<typeof connectExecutorHostControl>>;
    session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor", {
        onStarted: (value) => {
          arwxContext = value;
        },
        handler: async (_message, dispatch) => {
          receipt = await dispatch.sendFinal(
            {
              messageType: LocalMessageType.Drained,
              correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
              payload: drainedPayload(),
            },
            absoluteDeadline,
          );
          const finalReceipt = receipt;
          return dispatch.createPostDispatchFinalFrameEffect(finalReceipt, async () => {
            arming = session.armArwxShutdown(finalReceipt);
            await arming;
          });
        },
      }),
      connector: async () => host,
      closeTimeoutMs: 1_000,
    });
    const runtime = defined(arwxContext, "ARWX context");
    runtime.input.write(
      encodeLocalFrame({
        minorVersion: 0,
        messageType: LocalMessageType.Drain,
        sequence: 1n,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: drainPayload(),
      }),
    );
    await waitFor(() => receipt !== undefined);
    await waitFor(() => host.writes.length === 1);
    const request = defined(host.requests()[0], "Arm request");
    const payload = request.payload as Record<string, unknown>;
    const now = vi.spyOn(performance, "now");
    for (let call = 0; call < 4; call += 1) now.mockReturnValueOnce(absoluteDeadline - 2);
    now.mockReturnValue(absoluteDeadline - 0.5);
    const armOutcome = defined(arming, "Arm operation").then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    const doneFailure = expect(session.done).rejects.toMatchObject({ code: "CLOSE_TIMEOUT" });
    const receiveLoopSettlement = runtime.receiveLoop.done.catch(() => undefined);
    host.respond(success(request.requestId as string, { armed: true, ...payload }));
    const drainFailure = expect(session.drain()).rejects.toMatchObject({ code: "CLOSE_TIMEOUT" });

    const outcome = await Promise.race([
      armOutcome,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    now.mockRestore();
    expect(outcome).toBe("rejected");
    await Promise.all([doneFailure, drainFailure, receiveLoopSettlement]);
    await session.close().catch(() => undefined);
  });

  it("rejects Arm while the peer-final dispatch is still active", async () => {
    const host = new FakeExecutorHostControl();
    let arwxContext: TestBootstrapArwxContext | undefined;
    let receipt: ArwxFinalFrameReceipt | undefined;
    let releaseHandler!: () => void;
    const handlerBlocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor", {
        onStarted: (value) => {
          arwxContext = value;
        },
        handler: async (_message, dispatch) => {
          receipt = await dispatch.sendFinal(
            {
              messageType: LocalMessageType.Drained,
              correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
              payload: drainedPayload(),
            },
            performance.now() + 1_000,
          );
          await handlerBlocked;
        },
      }),
      connector: async () => host,
      closeTimeoutMs: 1_000,
    });
    const runtime = defined(arwxContext, "ARWX context");
    runtime.input.write(
      encodeLocalFrame({
        minorVersion: 0,
        messageType: LocalMessageType.Drain,
        sequence: 1n,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: drainPayload(),
      }),
    );
    await waitFor(() => receipt !== undefined);

    await expect(
      session.armArwxShutdown(defined(receipt, "final frame receipt")),
    ).rejects.toMatchObject({
      code: "LIFECYCLE_STATE_INVALID",
    });
    expect(host.writes).toHaveLength(0);
    releaseHandler();
    await session.close();
    await runtime.receiveLoop.done.catch(() => undefined);
  });

  it("fails closed if the Executor receives any HostControl response bytes", async () => {
    const host = new FakeExecutorHostControl();
    const session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor"),
      connector: async () => host,
      closeTimeoutMs: 1_000,
    });
    host.push(Buffer.from([1]));
    await waitFor(() => host.destroyed);
    await expect(session.done).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
    await session.close();
    expect(host.destroyed).toBe(true);
  });

  it("exposes unexpected readable EOF through the session done promise", async () => {
    const host = new FakeExecutorHostControl();
    const session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor"),
      connector: async () => host,
      closeTimeoutMs: 1_000,
    });
    host.push(null);

    await expect(session.done).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
    await session.close();
  });

  it("rejects a close-only peer shutdown while draining", async () => {
    const host = new FakeExecutorHostControl();
    host.endReadableOnClientEnd = false;
    const session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor"),
      connector: async () => host,
      closeTimeoutMs: 1_000,
    });
    const draining = session.drain();
    await waitFor(() => host.clientEnded);
    host.destroy();

    await expect(draining).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
  });

  it("does not restart the graceful budget when an absolute drain deadline expired", async () => {
    const host = new FakeExecutorHostControl();
    const session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor"),
      connector: async () => host,
      closeTimeoutMs: 1_000,
    });

    const doneFailure = expect(session.done).rejects.toMatchObject({ code: "CLOSE_TIMEOUT" });
    const drainFailure = expect(session.drain(performance.now() - 1)).rejects.toMatchObject({
      code: "CLOSE_TIMEOUT",
    });
    await Promise.all([doneFailure, drainFailure]);
    expect(host.destroyed).toBe(true);
  });

  it("does not start a rejectable writable phase after the drain deadline expired", async () => {
    const host = new DelayedFinalExecutorHostControl();
    const session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor"),
      connector: async () => host,
      closeTimeoutMs: 1_000,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const doneFailure = expect(session.done).rejects.toMatchObject({ code: "CLOSE_TIMEOUT" });
      const drainFailure = expect(session.drain(performance.now() - 1)).rejects.toMatchObject({
        code: "CLOSE_TIMEOUT",
      });

      await Promise.all([doneFailure, drainFailure]);
      if (host.finalPending) {
        host.releaseFinal(new Error("late final callback after expired deadline"));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(host.clientEnded).toBe(false);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      host.destroy();
    }
  });

  it("keeps close authoritative when drain is requested concurrently", async () => {
    const host = new FakeExecutorHostControl();
    const session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor"),
      connector: async () => host,
      closeTimeoutMs: 1_000,
    });

    const closing = session.close();
    const draining = session.drain();
    await expect(Promise.all([closing, draining])).resolves.toEqual([undefined, undefined]);
  });

  it("makes an existing drain fail explicitly when close preempts it", async () => {
    const host = new FakeExecutorHostControl();
    host.endReadableOnClientEnd = false;
    const session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor"),
      connector: async () => host,
      closeTimeoutMs: 1_000,
    });

    const draining = session.drain();
    await waitFor(() => host.clientEnded);
    await session.close();
    await expect(draining).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });

  it("rejects connection cancellation without exposing its reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("credential=must-not-cross"));
    await expect(
      connectExecutorHostControl(
        {
          role: "executor",
          pipe,
          prepareRuntimeBootstrap: createTestBootstrapPreparation("executor"),
          connector: async () => new FakeExecutorHostControl(),
        },
        controller.signal,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: ExecutorHostControlError.name,
        code: "CONNECT_CANCELLED",
        message: expect.not.stringContaining("must-not-cross"),
      }),
    );
  });

  it("cancels an in-flight connector and destroys a late stream", async () => {
    const controller = new AbortController();
    const lateHost = new FakeExecutorHostControl();
    let connectorCancellation: AbortSignal | undefined;
    let resolveConnection: ((stream: Duplex) => void) | undefined;
    const connecting = connectExecutorHostControl(
      {
        role: "executor",
        pipe,
        prepareRuntimeBootstrap: createTestBootstrapPreparation("executor"),
        connectTimeoutMs: 1_000,
        connector: async (_selected, cancellation) => {
          connectorCancellation = cancellation;
          return await new Promise<Duplex>((resolve) => {
            resolveConnection = resolve;
          });
        },
      },
      controller.signal,
    );
    const connectionFailure = expect(connecting).rejects.toEqual(
      expect.objectContaining({
        code: "CONNECT_CANCELLED",
        message: expect.not.stringContaining("must-not-cross"),
      }),
    );
    await waitFor(() => connectorCancellation !== undefined);
    controller.abort(new Error("credential=must-not-cross"));

    await connectionFailure;
    expect(connectorCancellation?.aborted).toBe(true);
    resolveConnection?.(lateHost);
    await waitFor(() => lateHost.destroyed);
  });

  it("aborts an in-flight connector when its connection deadline expires", async () => {
    let connectorCancellation: AbortSignal | undefined;
    const connecting = connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor"),
      connectTimeoutMs: 20,
      connector: async (_selected, cancellation) => {
        connectorCancellation = cancellation;
        return await new Promise<Duplex>(() => undefined);
      },
    });
    await waitFor(() => connectorCancellation !== undefined);

    await expect(connecting).rejects.toMatchObject({ code: "CONNECT_TIMEOUT" });
    expect(connectorCancellation?.aborted).toBe(true);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for Executor HostControl state.");
}

function success(requestId: string, body: object): Record<string, unknown> {
  return { body, outcome: "ok", protocolVersion: "1.0", requestId, type: "response" };
}

function defined<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} was not initialized.`);
  return value;
}
