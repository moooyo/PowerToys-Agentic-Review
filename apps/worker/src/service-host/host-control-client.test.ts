import { createHash } from "node:crypto";
import { Duplex } from "node:stream";
import {
  decodeLocalFrame,
  encodeLocalFrame,
  LOCAL_PROTOCOL_NIL_CORRELATION_ID,
  LocalMessageType,
  serializeCanonicalJson,
} from "@agentic-review/local-protocol";
import { describe, expect, it } from "vitest";
import {
  type ControlHostControlClient,
  connectHostControl,
  HostControlClientError,
  HostControlRemoteError,
  isControlHostControlClient,
} from "./host-control-client.js";
import {
  HOST_CONTROL_MAXIMUM_BODY_BYTES,
  HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_BODY_BYTES,
  HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_FRAME_BYTES,
  HOST_CONTROL_MAXIMUM_REQUEST_FRAME_BYTES,
  HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES,
} from "./host-control-protocol.js";
import {
  parseServiceHostLaunchContract,
  SERVICE_HOST_CONTROL_PIPE_PREFIX,
} from "./launch-contract.js";
import {
  encodeHostControlOpaqueJson,
  type HostControlOpaqueJsonDescriptor,
} from "./opaque-json.js";
import {
  createTestBootstrapPreparation,
  drainedPayload,
  drainPayload,
  handleBootstrapTestWrite,
  installBootstrapTestHost,
  type TestBootstrapArwxContext,
} from "./runtime-bootstrap.test-helpers.js";
import type { RuntimeBootstrapPreparation } from "./runtime-bootstrap-handshake.js";

class FakeHostControl extends Duplex {
  public readonly writes: Buffer[] = [];
  public clientEnded = false;
  public endReadableOnClientEnd = true;

  public constructor() {
    super({ allowHalfOpen: false });
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

  public pushRaw(bytes: Buffer): void {
    this.push(bytes);
  }

  public requests(): Array<Record<string, unknown>> {
    return this.writes.map((frame) => {
      const length = frame.readUInt32LE(0);
      return JSON.parse(frame.subarray(4, 4 + length).toString("utf8")) as Record<string, unknown>;
    });
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

  public override _final(callback: (error?: Error | null) => void): void {
    this.clientEnded = true;
    callback();
    if (this.endReadableOnClientEnd) queueMicrotask(() => this.push(null));
  }
}

class SlowHostControl extends FakeHostControl {
  readonly #callbacks: Array<(error?: Error | null) => void> = [];

  public override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (handleBootstrapTestWrite(this, chunk, callback)) return;
    this.writes.push(Buffer.from(chunk));
    this.#callbacks.push(callback);
  }

  public releaseNextWrite(): void {
    const callback = this.#callbacks.shift();
    if (callback === undefined) throw new Error("No HostControl write is pending.");
    callback();
  }
}

const selector = `${SERVICE_HOST_CONTROL_PIPE_PREFIX}${"a".repeat(64)}`;
const pipe = parseServiceHostLaunchContract(
  [
    "--service-role=control",
    "--servicehost-arwx-stdio",
    `--servicehost-host-control-pipe=${selector}`,
  ],
  "control",
).hostControlPipe;

async function connect(
  options: {
    readonly maximumConcurrentRequests?: number;
    readonly maximumRequestIds?: number;
    readonly maximumQueuedWriteBytes?: number;
    readonly requestTimeoutMs?: number;
    readonly host?: FakeHostControl;
    readonly prepareRuntimeBootstrap?: RuntimeBootstrapPreparation<"control">;
  } = {},
): Promise<{ readonly client: ControlHostControlClient; readonly host: FakeHostControl }> {
  const host = options.host ?? new FakeHostControl();
  let sequence = 0;
  const client = await connectHostControl({
    role: "control",
    pipe,
    prepareRuntimeBootstrap:
      options.prepareRuntimeBootstrap ?? createTestBootstrapPreparation("control"),
    ...(options.maximumConcurrentRequests === undefined
      ? {}
      : { maximumConcurrentRequests: options.maximumConcurrentRequests }),
    ...(options.maximumRequestIds === undefined
      ? {}
      : { maximumRequestIds: options.maximumRequestIds }),
    ...(options.maximumQueuedWriteBytes === undefined
      ? {}
      : { maximumQueuedWriteBytes: options.maximumQueuedWriteBytes }),
    connector: async (selected) => {
      expect(selected).toBe(selector);
      installBootstrapTestHost(host, "control", 5);
      return host;
    },
    requestIdFactory: (kind) => `${kind}:${++sequence}`,
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
    claimTimeoutMs: 1_000,
    cancellationGraceMs: 1_000,
    closeTimeoutMs: 1_000,
  });
  return { client, host };
}

describe("HostControl client", () => {
  it("nominally validates only clients created by the reviewed connector", async () => {
    const { client } = await connect();

    expect(isControlHostControlClient(client)).toBe(true);
    expect(
      isControlHostControlClient(Object.create(client) as ControlHostControlClient),
    ).toBe(false);

    await client.close();
  });

  it("multiplexes concurrent requests and correlates out-of-order fragmented responses", async () => {
    const { client, host } = await connect();
    expect(client.bootstrap.bootstrap.role).toBe("control");
    const registration = client.register(opaque({ workerNodeId: "node:1" }));
    const claim = client.claim(opaque({ availableSlots: 1 }));
    await waitForWrites(host, 2);

    const requests = host.requests();
    expect(requests.map((request) => request.operation)).toEqual(["Register", "Claim"]);
    host.respond(successOpaque("call:2", { outcome: "no_work" }), 7);
    host.respond(successOpaque("call:1", { registered: true }), 5);

    await expect(registration).resolves.toEqual({ registered: true });
    await expect(claim).resolves.toEqual({ outcome: "no_work" });
    await client.close();
  });

  it("arms the exact final Drain frame and commits ARWX output only after the exact echo", async () => {
    let arwxContext: TestBootstrapArwxContext | undefined;
    let arming: Promise<unknown> | undefined;
    let client!: ControlHostControlClient;
    const connected = await connect({
      prepareRuntimeBootstrap: createTestBootstrapPreparation("control", {
        handler: (_message, dispatch) => {
          const receipt = dispatch.readFinalFrameReceipt();
          return dispatch.createPostDispatchFinalFrameEffect(receipt, async () => {
            arming = client.armArwxShutdown(receipt);
            await arming;
          });
        },
        onStarted: (value) => {
          arwxContext = value;
        },
      }),
    });
    client = connected.client;
    const { host } = connected;
    const runtime = defined(arwxContext, "ARWX context");
    const receipt = await runtime.arwx.sendFinal(
      {
        messageType: LocalMessageType.Drain,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: drainPayload(),
      },
      performance.now() + 1_000,
    );
    const finalFrame = runtime.output.read() as Buffer;
    expect(decodeLocalFrame(finalFrame)).toMatchObject({
      messageType: LocalMessageType.Drain,
      sequence: 1n,
    });

    runtime.input.end(drainedFrame(1n));
    await waitForWrites(host, 1);
    const request = defined(host.requests()[0], "Arm request");
    const payload = request.payload as Record<string, unknown>;
    expect(request.operation).toBe("ArmArwxShutdown");
    expect(payload).toMatchObject({
      bootstrapId: client.bootstrap.bootstrap.bootstrapId,
      finalMessageType: LocalMessageType.Drain,
      finalSequence: "1",
      finalCorrelationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
      finalFrameBytes: finalFrame.byteLength,
      finalFrameSha256: createHash("sha256").update(finalFrame).digest("hex"),
    });
    expect(runtime.output.writableEnded).toBe(false);
    host.respond(success(request.requestId as string, { armed: true, ...payload }), 3);

    await expect(defined(arming, "Arm operation")).resolves.toEqual({
      armed: true,
      ...payload,
    });
    expect(runtime.output.writableEnded).toBe(true);
    await waitFor(() => host.clientEnded);
    expect(() => client.register(opaque({ workerNodeId: "node:1" }))).toThrowError(
      expect.objectContaining({ code: "CLIENT_CLOSED" }),
    );
    expect(() =>
      runtime.arwx.send({
        messageType: LocalMessageType.Ping,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: {},
      }),
    ).toThrowError(expect.objectContaining({ code: "CHANNEL_STATE_INVALID" }));

    await expect(runtime.receiveLoop.done).resolves.toBeUndefined();
    await client.drain();
  });

  it("rejects close-only HostControl termination after Arm acknowledgement", async () => {
    let arwxContext: TestBootstrapArwxContext | undefined;
    let client!: ControlHostControlClient;
    const connected = await connect({
      prepareRuntimeBootstrap: createTestBootstrapPreparation("control", {
        handler: (_message, dispatch) => {
          const receipt = dispatch.readFinalFrameReceipt();
          return dispatch.createPostDispatchFinalFrameEffect(receipt, async () => {
            await client.armArwxShutdown(receipt);
          });
        },
        onStarted: (value) => {
          arwxContext = value;
        },
      }),
    });
    client = connected.client;
    const { host } = connected;
    host.endReadableOnClientEnd = false;
    const runtime = defined(arwxContext, "ARWX context");
    const receipt = await runtime.arwx.sendFinal(
      {
        messageType: LocalMessageType.Drain,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: drainPayload(),
      },
      performance.now() + 1_000,
    );
    runtime.input.end(drainedFrame(1n));
    await waitForWrites(host, 1);
    const request = defined(host.requests()[0], "Arm request");
    const payload = request.payload as Record<string, unknown>;
    host.respond(success(request.requestId as string, { armed: true, ...payload }));
    await waitFor(() => host.clientEnded);
    host.destroy();

    await expect(client.done).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
    await expect(client.drain()).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
    runtime.arwx.abort();
    await runtime.receiveLoop.done.catch(() => undefined);
  });

  it("retains a genuine expired receipt deadline for failed Arm cleanup", async () => {
    let arwxContext: TestBootstrapArwxContext | undefined;
    const { client } = await connect({
      prepareRuntimeBootstrap: createTestBootstrapPreparation("control", {
        handler: () => undefined,
        onStarted: (value) => {
          arwxContext = value;
        },
      }),
    });
    const runtime = defined(arwxContext, "ARWX context");
    const receipt = await runtime.arwx.sendFinal(
      {
        messageType: LocalMessageType.Drain,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: drainPayload(),
      },
      performance.now() + 30,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    await expect(client.armArwxShutdown(receipt)).rejects.toMatchObject({
      code: "LIFECYCLE_STATE_INVALID",
    });
    await expect(client.close()).rejects.toMatchObject({ code: "CLOSE_TIMEOUT" });
    await runtime.receiveLoop.done.catch(() => undefined);
  });

  it("fails closed without sending Arm while a business RPC is active", async () => {
    let arwxContext: TestBootstrapArwxContext | undefined;
    let arming: Promise<unknown> | undefined;
    let client!: ControlHostControlClient;
    const connected = await connect({
      prepareRuntimeBootstrap: createTestBootstrapPreparation("control", {
        handler: (_message, dispatch) => {
          const receipt = dispatch.readFinalFrameReceipt();
          return dispatch.createPostDispatchFinalFrameEffect(receipt, async () => {
            arming = client.armArwxShutdown(receipt);
            await arming;
          });
        },
        onStarted: (value) => {
          arwxContext = value;
        },
      }),
    });
    client = connected.client;
    const { host } = connected;
    const registration = client.register(opaque({ workerNodeId: "node:1" }));
    await waitForWrites(host, 1);
    const runtime = defined(arwxContext, "ARWX context");
    const receipt = await runtime.arwx.sendFinal(
      {
        messageType: LocalMessageType.Drain,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: drainPayload(),
      },
      performance.now() + 1_000,
    );
    expect(receipt.localRole).toBe("control");
    runtime.input.end(drainedFrame(1n));
    await waitFor(() => arming !== undefined);

    await expect(defined(arming, "Arm operation")).rejects.toMatchObject({
      code: "LIFECYCLE_STATE_INVALID",
    });
    await expect(registration).rejects.toMatchObject({ code: "LIFECYCLE_STATE_INVALID" });
    expect(host.requests()).toHaveLength(1);
    await client.close();
    await runtime.receiveLoop.done.catch(() => undefined);
  });

  it("uses the final-frame deadline for Arm timeout and never sends a Cancel", async () => {
    let arwxContext: TestBootstrapArwxContext | undefined;
    let arming: Promise<unknown> | undefined;
    let client!: ControlHostControlClient;
    const connected = await connect({
      prepareRuntimeBootstrap: createTestBootstrapPreparation("control", {
        handler: (_message, dispatch) => {
          const receipt = dispatch.readFinalFrameReceipt();
          return dispatch.createPostDispatchFinalFrameEffect(receipt, async () => {
            arming = client.armArwxShutdown(receipt);
            await arming;
          });
        },
        onStarted: (value) => {
          arwxContext = value;
        },
      }),
    });
    client = connected.client;
    const { host } = connected;
    const runtime = defined(arwxContext, "ARWX context");
    const receipt = await runtime.arwx.sendFinal(
      {
        messageType: LocalMessageType.Drain,
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        payload: drainPayload(),
      },
      performance.now() + 100,
    );
    expect(receipt.localRole).toBe("control");
    runtime.input.end(drainedFrame(1n));
    await waitFor(() => arming !== undefined);

    await expect(defined(arming, "Arm operation")).rejects.toMatchObject({
      code: "LIFECYCLE_TIMEOUT",
    });
    expect(host.requests().map((request) => request.operation)).toEqual(["ArmArwxShutdown"]);
    await expect(client.close()).rejects.toMatchObject({ code: "CLOSE_TIMEOUT" });
    await runtime.receiveLoop.done.catch(() => undefined);
  });

  it("sends cancellation with a fresh correlation and never serializes AbortSignal reason", async () => {
    const { client, host } = await connect();
    const controller = new AbortController();
    const request = client.register(opaque({ workerNodeId: "node:1" }), {
      signal: controller.signal,
    });
    await waitForWrites(host, 1);
    controller.abort(new Error("leaseToken=must-not-cross url=https://private.invalid"));

    await expect(request).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await waitForWrites(host, 2);
    const cancel = host.requests()[1];
    expect(cancel).toEqual({
      protocolVersion: "1.0",
      requestId: "cancel:2",
      targetRequestId: "call:1",
      type: "cancel",
    });
    const wire = Buffer.concat(host.writes).toString("utf8");
    expect(wire).not.toMatch(/must-not-cross|private\.invalid|leaseToken|reason/u);

    host.respond(success("cancel:2", { cancelled: true }));
    host.respond(failure("call:1", "REQUEST_CANCELLED", true));
    await waitForMicrotasks();
    await client.close();
  });

  it("turns a request deadline into a correlated transport cancellation", async () => {
    const { client, host } = await connect({ requestTimeoutMs: 20 });
    const request = client.register(opaque({ workerNodeId: "node:1" }));
    await waitForWrites(host, 1);

    await expect(request).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await waitForWrites(host, 2);
    expect(host.requests()[1]).toEqual({
      protocolVersion: "1.0",
      requestId: "cancel:2",
      targetRequestId: "call:1",
      type: "cancel",
    });
    host.respond(success("cancel:2", { cancelled: true }));
    host.respond(failure("call:1", "REQUEST_CANCELLED", true));
    await waitForMicrotasks();
    await client.close();
  });

  it("enforces local concurrency before writing another request", async () => {
    const { client, host } = await connect({ maximumConcurrentRequests: 1 });
    const first = client.register(opaque({ workerNodeId: "node:1" }));
    await waitForWrites(host, 1);
    expect(() => client.claim(opaque({ availableSlots: 1 }))).toThrowError(
      expect.objectContaining({ code: "CONCURRENCY_LIMIT" }),
    );
    expect(host.writes).toHaveLength(1);
    host.respond(successOpaque("call:1", { registered: true }));
    await first;
    await client.close();
  });

  it("bounds queued and in-flight frames and releases reservations after writes", async () => {
    const host = new SlowHostControl();
    const { client } = await connect({
      host,
      maximumQueuedWriteBytes: HOST_CONTROL_MAXIMUM_REQUEST_FRAME_BYTES + 4,
    });
    const bodyOverhead = Buffer.byteLength('{"value":""}', "utf8");
    const body = opaque(
      { value: "x".repeat(HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES - bodyOverhead) },
      HOST_CONTROL_MAXIMUM_RUN_COMPLETION_BODY_BYTES,
    );

    const first = client.completeRun("run:1", body);
    await waitForWrites(host, 1);
    expect(() => client.completeRun("run:2", body)).toThrowError(
      expect.objectContaining({ code: "OUTPUT_QUEUE_LIMIT_EXCEEDED" }),
    );

    host.releaseNextWrite();
    host.respond(successOpaque("call:1", { committed: true }));
    await expect(first).resolves.toEqual({ committed: true });

    const afterRelease = client.completeRun("run:3", body);
    await waitForWrites(host, 2);
    host.releaseNextWrite();
    host.respond(successOpaque("call:3", { committed: true }));
    await expect(afterRelease).resolves.toEqual({ committed: true });
    await client.close();
  });

  it("keeps nonfatal remote errors request-local", async () => {
    const { client, host } = await connect();
    const first = client.register(opaque({ workerNodeId: "node:1" }));
    await waitForWrites(host, 1);
    host.respond(failure("call:1", "UPSTREAM_UNAVAILABLE", true));
    await expect(first).rejects.toBeInstanceOf(HostControlRemoteError);

    const second = client.register(opaque({ workerNodeId: "node:1" }));
    await waitForWrites(host, 2);
    host.respond(successOpaque("call:2", { registered: true }));
    await expect(second).resolves.toEqual({ registered: true });
    await client.close();
  });

  it("turns a fatal remote code into a session failure for the triggering request", async () => {
    const { client, host } = await connect();
    const request = client.register(opaque({ workerNodeId: "node:1" }));
    await waitForWrites(host, 1);
    host.respond(failure("call:1", "INVALID_MESSAGE", false));

    await expect(request).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
    await waitFor(() => host.destroyed);
    await client.close();
  });

  it("enforces the Claim response body ceiling independently of the physical frame ceiling", async () => {
    const { client, host } = await connect();
    const claim = client.claim(opaque({ availableSlots: 1 }));
    await waitForWrites(host, 1);
    const body = { value: "x".repeat(HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_BODY_BYTES) };
    const response = success(
      "call:1",
      opaque(body, HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_BODY_BYTES + 1_024),
    );
    const physicalBytes = 4 + Buffer.byteLength(serializeCanonicalJson(response), "utf8");
    expect(physicalBytes).toBeLessThanOrEqual(HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_FRAME_BYTES);
    host.respond(response);

    await expect(claim).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
    await client.close();
  });

  it.each(["unknown correlation", "oversized prefix", "partial EOF"])(
    "fails every pending request on %s",
    async (scenario) => {
      const { client, host } = await connect();
      const request = client.register(opaque({ workerNodeId: "node:1" }));
      await waitForWrites(host, 1);
      if (scenario === "unknown correlation") {
        host.respond(successOpaque("other:1", { registered: true }));
      } else if (scenario === "oversized prefix") {
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32LE(HOST_CONTROL_MAXIMUM_CLAIM_RESPONSE_FRAME_BYTES + 1, 0);
        host.pushRaw(prefix);
      } else {
        host.pushRaw(Buffer.from([10, 0, 0, 0, 0x7b]));
        host.push(null);
      }
      await expect(request).rejects.toBeInstanceOf(HostControlClientError);
      await expect(client.done).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
      expect(host.destroyed).toBe(true);
      await client.close();
    },
  );

  it("exposes a HostControl transport error through the session done promise", async () => {
    const { client, host } = await connect();
    host.destroy(new Error("transport failed"));

    await expect(client.done).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
    await client.close();
  });

  it.each(["digest", "length", "base64url"])(
    "fails the session when an opaque response has a tampered %s",
    async (field) => {
      const { client, host } = await connect();
      const request = client.register(opaque({ workerNodeId: "node:1" }));
      await waitForWrites(host, 1);
      const descriptor = opaque({ registered: true });
      const tampered =
        field === "digest"
          ? { ...descriptor, sha256: "0".repeat(64) }
          : field === "length"
            ? { ...descriptor, byteLength: descriptor.byteLength + 1 }
            : { ...descriptor, base64Url: `${descriptor.base64Url}=` };
      host.respond(success("call:1", tampered));

      await expect(request).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
      expect(host.destroyed).toBe(true);
      await client.close();
    },
  );

  it("drains accepted requests before closing the request stream", async () => {
    const { client, host } = await connect();
    const request = client.register(opaque({ workerNodeId: "node:1" }));
    await waitForWrites(host, 1);
    const draining = client.drain();
    expect(() => client.claim(opaque({ availableSlots: 1 }))).toThrow();
    expect(host.clientEnded).toBe(false);
    host.respond(successOpaque("call:1", { registered: true }));
    await request;
    await draining;
    expect(host.clientEnded).toBe(true);
  });

  it("does not restart the graceful budget when an absolute drain deadline expired", async () => {
    const { client, host } = await connect({ closeTimeoutMs: 1_000 });

    await expect(client.drain(performance.now() - 1)).rejects.toMatchObject({
      code: "DRAIN_TIMEOUT",
    });
    expect(host.destroyed).toBe(true);
  });

  it("fails drain and pending work when the peer closes early", async () => {
    const { client, host } = await connect();
    const request = client.register(opaque({ workerNodeId: "node:1" }));
    await waitForWrites(host, 1);
    const draining = client.drain();
    host.destroy();

    await expect(request).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
    await expect(draining).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
  });

  it("rejects a close-only truncated response during drain", async () => {
    const { client, host } = await connect();
    host.endReadableOnClientEnd = false;
    const draining = client.drain();
    await waitFor(() => host.clientEnded);
    host.pushRaw(Buffer.from([10, 0, 0, 0, 0x7b]));
    host.destroy();

    await expect(draining).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
  });

  it("rejects close-before-end during drain even when the decoder is empty", async () => {
    const { client, host } = await connect();
    host.endReadableOnClientEnd = false;
    const draining = client.drain();
    await waitFor(() => host.clientEnded);
    host.destroy();

    await expect(draining).rejects.toMatchObject({ code: "PROTOCOL_FAILURE" });
  });

  it("keeps close authoritative when drain is requested concurrently", async () => {
    const { client } = await connect();

    const closing = client.close();
    const draining = client.drain();
    await expect(Promise.all([closing, draining])).resolves.toEqual([undefined, undefined]);
  });

  it("makes an existing drain fail explicitly when close preempts it", async () => {
    const { client, host } = await connect();
    host.endReadableOnClientEnd = false;

    const draining = client.drain();
    await waitFor(() => host.clientEnded);
    await client.close();
    await expect(draining).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });

  it("cancels an in-flight connector and destroys a late stream without leaking the reason", async () => {
    const controller = new AbortController();
    const lateHost = new FakeHostControl();
    let connectorCancellation: AbortSignal | undefined;
    let resolveConnection: ((stream: Duplex) => void) | undefined;
    const connecting = connectHostControl(
      {
        role: "control",
        pipe,
        prepareRuntimeBootstrap: createTestBootstrapPreparation("control"),
        connector: async (_selected, cancellation) => {
          connectorCancellation = cancellation;
          return await new Promise<Duplex>((resolve) => {
            resolveConnection = resolve;
          });
        },
        connectTimeoutMs: 1_000,
      },
      controller.signal,
    );
    await waitFor(() => connectorCancellation !== undefined);
    controller.abort(new Error("leaseToken=must-not-cross"));

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
    const connecting = connectHostControl({
      role: "control",
      pipe,
      prepareRuntimeBootstrap: createTestBootstrapPreparation("control"),
      connector: async (_selected, cancellation) => {
        connectorCancellation = cancellation;
        return await new Promise<Duplex>(() => undefined);
      },
      connectTimeoutMs: 20,
    });
    await waitFor(() => connectorCancellation !== undefined);

    await expect(connecting).rejects.toMatchObject({ code: "CONNECT_TIMEOUT" });
    expect(connectorCancellation?.aborted).toBe(true);
  });

  it("validates the signing digest and low-S response", async () => {
    const { client, host } = await connect();
    await expect(client.signLocalDigest("A".repeat(64))).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
    const signing = client.signLocalDigest("a".repeat(64));
    await waitForWrites(host, 1);
    host.respond(success("call:1", { signatureP1363: Buffer.alloc(64, 1).toString("base64url") }));
    await expect(signing).resolves.toHaveLength(86);
    await client.close();
  });
});

function success(requestId: string, body: object): Record<string, unknown> {
  return { body, outcome: "ok", protocolVersion: "1.0", requestId, type: "response" };
}

function successOpaque(requestId: string, value: unknown): Record<string, unknown> {
  return success(requestId, opaque(value));
}

function opaque(
  value: unknown,
  maximumBytes = HOST_CONTROL_MAXIMUM_BODY_BYTES,
): HostControlOpaqueJsonDescriptor {
  return encodeHostControlOpaqueJson(value, maximumBytes);
}

function failure(requestId: string, code: string, retryable: boolean): Record<string, unknown> {
  return {
    error: { code, message: "The operation failed.", retryable },
    outcome: "error",
    protocolVersion: "1.0",
    requestId,
    type: "response",
  };
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

async function waitForWrites(host: FakeHostControl, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (host.writes.length >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${count} HostControl write(s).`);
}

async function waitForMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for HostControl state.");
}

function defined<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} was not initialized.`);
  return value;
}
