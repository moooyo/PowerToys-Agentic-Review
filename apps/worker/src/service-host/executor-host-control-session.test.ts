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
    expect("register" in session).toBe(false);
    expect("signLocalDigest" in session).toBe(false);
    await session.drain();
    expect(host.clientEnded).toBe(true);
  });

  it("arms an actual Drained frame and resolves early ARWX EOF only after the exact echo", async () => {
    const host = new FakeExecutorHostControl();
    let arwxContext: TestBootstrapArwxContext | undefined;
    let receipt: ArwxFinalFrameReceipt | undefined;
    const session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor", {
        onStarted: (value) => {
          arwxContext = value;
        },
        handler: async () => {
          receipt = await defined(arwxContext, "ARWX context").arwx.sendFinal(
            {
              messageType: LocalMessageType.Drained,
              correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
              payload: drainedPayload(),
            },
            performance.now() + 1_000,
          );
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

    const arming = session.armArwxShutdown(defined(receipt, "final frame receipt"));
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

    await expect(arming).resolves.toEqual({ armed: true, ...payload });
    await expect(runtime.receiveLoop.done).resolves.toBeUndefined();
    expect(runtime.output.writableEnded).toBe(true);
    expect(host.clientEnded).toBe(true);
    await session.drain();
  });

  it("rejects close-only HostControl termination after Executor Arm acknowledgement", async () => {
    const host = new FakeExecutorHostControl();
    host.endReadableOnClientEnd = false;
    let arwxContext: TestBootstrapArwxContext | undefined;
    let receipt: ArwxFinalFrameReceipt | undefined;
    const session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor", {
        onStarted: (value) => {
          arwxContext = value;
        },
        handler: async () => {
          receipt = await defined(arwxContext, "ARWX context").arwx.sendFinal(
            {
              messageType: LocalMessageType.Drained,
              correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
              payload: drainedPayload(),
            },
            performance.now() + 1_000,
          );
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
    const arming = session.armArwxShutdown(defined(receipt, "final frame receipt"));
    await waitFor(() => host.writes.length === 1);
    const request = defined(host.requests()[0], "Arm request");
    const payload = request.payload as Record<string, unknown>;
    host.respond(success(request.requestId as string, { armed: true, ...payload }));
    await expect(arming).resolves.toBeDefined();
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
    const absoluteDeadline = performance.now() + 1_000;
    const session = await connectExecutorHostControl({
      role: "executor",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("executor", {
        onStarted: (value) => {
          arwxContext = value;
        },
        handler: async () => {
          receipt = await defined(arwxContext, "ARWX context").arwx.sendFinal(
            {
              messageType: LocalMessageType.Drained,
              correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
              payload: drainedPayload(),
            },
            absoluteDeadline,
          );
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
    const arming = session.armArwxShutdown(defined(receipt, "final frame receipt"));
    await waitFor(() => host.writes.length === 1);
    const request = defined(host.requests()[0], "Arm request");
    const payload = request.payload as Record<string, unknown>;
    const now = vi.spyOn(performance, "now");
    for (let call = 0; call < 4; call += 1) now.mockReturnValueOnce(absoluteDeadline - 2);
    now.mockReturnValue(absoluteDeadline - 0.5);
    host.respond(success(request.requestId as string, { armed: true, ...payload }));

    const outcome = await Promise.race([
      arming.then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    now.mockRestore();
    expect(outcome).toBe("rejected");
    await runtime.receiveLoop.done.catch(() => undefined);
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
        handler: async () => {
          receipt = await defined(arwxContext, "ARWX context").arwx.sendFinal(
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
    await waitFor(() => connectorCancellation !== undefined);
    controller.abort(new Error("credential=must-not-cross"));

    await expect(connecting).rejects.toEqual(
      expect.objectContaining({
        code: "CONNECT_CANCELLED",
        message: expect.not.stringContaining("must-not-cross"),
      }),
    );
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
