import { PassThrough } from "node:stream";
import type {
  WorkerHeartbeatRequest,
  WorkerHeartbeatResponse,
  WorkerRegistrationRequest,
  WorkerRegistrationResponse,
} from "@agentic-review/contracts";
import {
  type DecodedLocalFrame,
  encodeLocalFrame,
  type HelloAckMessage,
  type HelloMessage,
  IncrementalLocalFrameDecoder,
  LOCAL_PROTOCOL_NIL_CORRELATION_ID,
  LocalMessageType,
  type ReadyMessage,
} from "@agentic-review/local-protocol";
import { describe, expect, it, vi } from "vitest";
import { WorkerApiError } from "../server-client/errors.js";
import type { ArmArwxShutdownResultV1 } from "../service-host/arwx-shutdown.js";
import {
  type ArwxFinalFrameReceipt,
  ArwxStdioChannel,
  commitArwxFinalFrameReceipt,
  consumeArwxFinalFrameReceipt,
} from "../service-host/arwx-stdio-channel.js";
import type { ControlHostControlClient } from "../service-host/host-control-client.js";
import type { HostControlShutdownRequest } from "../service-host/host-control-session.js";
import { parseRuntimeBootstrap } from "../service-host/runtime-bootstrap.js";
import { bootstrapDocument } from "../service-host/runtime-bootstrap.test-helpers.js";
import {
  type ControlShadowServerApi,
  installControlZeroSlotShadowSupervisor,
} from "./shadow-supervisor.js";

const executorBootId = "20000000-0000-4000-8000-000000000002";
const executorNonce = "2".repeat(64);
const executorPreflightSha256 = "7".repeat(64);
const signature = (() => {
  const bytes = Buffer.alloc(64);
  bytes[31] = 1;
  bytes[63] = 1;
  return bytes.toString("base64url");
})();

class FakeServerApi implements ControlShadowServerApi {
  public readonly registrations: WorkerRegistrationRequest[] = [];
  public readonly heartbeats: WorkerHeartbeatRequest[] = [];
  public readonly signingDigests: string[] = [];
  public registrationHandler: (signal?: AbortSignal) => Promise<WorkerRegistrationResponse> =
    async () => registrationResponse();
  public heartbeatHandler: (signal?: AbortSignal) => Promise<WorkerHeartbeatResponse> = async () =>
    heartbeatResponse();
  public signingResult = signature;

  public async register(
    request: WorkerRegistrationRequest,
    signal?: AbortSignal,
  ): Promise<WorkerRegistrationResponse> {
    this.registrations.push(request);
    return await this.registrationHandler(signal);
  }

  public async heartbeat(
    workerInstanceId: string,
    request: WorkerHeartbeatRequest,
    signal?: AbortSignal,
  ): Promise<WorkerHeartbeatResponse> {
    expect(workerInstanceId).toBe(request.workerInstanceId);
    this.heartbeats.push(request);
    return await this.heartbeatHandler(signal);
  }

  public async signLocalDigest(digestSha256: string): Promise<string> {
    this.signingDigests.push(digestSha256);
    return this.signingResult;
  }
}

class FakeControlClient implements ControlHostControlClient {
  public readonly role = "control" as const;
  public readonly done = new Promise<void>(() => undefined);
  public readonly shutdownRequested: Promise<Readonly<HostControlShutdownRequest<"control">>>;
  readonly #resolveShutdownRequested: (
    value: Readonly<HostControlShutdownRequest<"control">>,
  ) => void;
  public claimCalls = 0;
  public completeCalls = 0;
  public failCalls = 0;
  public armCalls = 0;
  public idleWaits = 0;
  public waitForIdleHandler: () => Promise<void> = async () => undefined;

  public constructor(
    public readonly bootstrap: ReturnType<typeof parseRuntimeBootstrap>,
    private readonly arwx: ArwxStdioChannel,
  ) {
    let resolveShutdownRequested!: (value: Readonly<HostControlShutdownRequest<"control">>) => void;
    this.shutdownRequested = new Promise((resolve) => {
      resolveShutdownRequested = resolve;
    });
    this.#resolveShutdownRequested = resolveShutdownRequested;
  }

  public requestShutdown(value: Readonly<HostControlShutdownRequest<"control">>): void {
    this.#resolveShutdownRequested(value);
  }

  public async register(): Promise<never> {
    throw new Error("Raw HostControl registration should be behind the server facade.");
  }

  public async claim(): Promise<never> {
    this.claimCalls += 1;
    throw new Error("Claim is forbidden in zero-slot shadow mode.");
  }

  public async instanceHeartbeat(): Promise<never> {
    throw new Error("Raw HostControl heartbeat should be behind the server facade.");
  }

  public async completeRun(): Promise<never> {
    this.completeCalls += 1;
    throw new Error("Completion is forbidden in zero-slot shadow mode.");
  }

  public async failRun(): Promise<never> {
    this.failCalls += 1;
    throw new Error("Failure submission is forbidden in zero-slot shadow mode.");
  }

  public async signLocalDigest(): Promise<never> {
    throw new Error("Raw HostControl signing should be behind the server facade.");
  }

  public async armArwxShutdown(
    receipt: ArwxFinalFrameReceipt,
  ): Promise<Readonly<ArmArwxShutdownResultV1>> {
    this.armCalls += 1;
    const binding = consumeArwxFinalFrameReceipt(receipt, this.arwx, "control");
    if (binding === undefined || !commitArwxFinalFrameReceipt(receipt)) {
      throw new Error("Expected exact Control shutdown authority.");
    }
    return Object.freeze({
      armed: true,
      bootstrapId: this.bootstrap.bootstrap.bootstrapId,
      shutdownId: binding.shutdownId,
      remainingShutdownMs: Math.max(1, Math.floor(binding.absoluteDeadline - performance.now())),
      finalMessageType: binding.finalMessageType,
      finalSequence: binding.finalSequence.toString(10),
      finalCorrelationId: binding.finalCorrelationId,
      finalFrameBytes: binding.finalFrameBytes,
      finalFrameSha256: binding.finalFrameSha256,
    });
  }

  public async waitForIdle(): Promise<void> {
    this.idleWaits += 1;
    await this.waitForIdleHandler();
  }

  public async drain(): Promise<void> {}

  public async close(): Promise<void> {}
}

interface Harness {
  readonly api: FakeServerApi;
  readonly arwx: ArwxStdioChannel;
  readonly cancellation: AbortController;
  readonly client: FakeControlClient;
  readonly frames: DecodedLocalFrame[];
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly owner: ReturnType<typeof installControlZeroSlotShadowSupervisor>;
  readonly running: Promise<void>;
  readonly startupCalls: {
    randomNonce: number;
    randomUuid: number;
    serverApi: number;
  };
  send(messageType: LocalMessageType, payload: unknown): void;
}

async function createHarness(
  configure: (api: FakeServerApi) => void = () => undefined,
  overrides: {
    readonly architecture?: string;
    readonly activated?: Promise<void>;
    readonly operationTimeoutMs?: number;
    readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<Harness> {
  const parsed = parseRuntimeBootstrap(bootstrapDocument("control"), "control");
  const input = new PassThrough();
  const output = new PassThrough();
  const arwx = new ArwxStdioChannel({
    localRole: "control",
    input,
    output,
    maximumQueuedWriteBytes: parsed.bootstrap.arwx.maximumQueuedBytesPerDirection,
    closeTimeoutMs:
      parsed.bootstrap.shutdown.gracefulTimeoutMs -
      parsed.bootstrap.shutdown.forceTerminationReserveMs,
  });
  const frames: DecodedLocalFrame[] = [];
  const decoder = new IncrementalLocalFrameDecoder({ minorVersion: 0, expectedSequence: 1n });
  output.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
  const api = new FakeServerApi();
  configure(api);
  const client = new FakeControlClient(parsed, arwx);
  const cancellation = new AbortController();
  const startupCalls = { randomNonce: 0, randomUuid: 0, serverApi: 0 };
  const uuids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
  const owner = installControlZeroSlotShadowSupervisor(
    {
      arwx,
      bootstrap: parsed,
      activated: overrides.activated ?? Promise.resolve(),
      hostControl: client,
      signal: cancellation.signal,
    },
    {
      architecture: overrides.architecture ?? "x64",
      get serverApi() {
        startupCalls.serverApi += 1;
        return api;
      },
      nowUnixMs: () => 1_700_000_000_000,
      operationTimeoutMs: overrides.operationTimeoutMs ?? 100,
      randomNonce: () => {
        startupCalls.randomNonce += 1;
        return "1".repeat(64);
      },
      randomUuid: () => {
        startupCalls.randomUuid += 1;
        const value = uuids.shift();
        if (value === undefined) throw new Error("Unexpected UUID request.");
        return value;
      },
      sleep: overrides.sleep ?? ((_milliseconds, signal) => waitForAbort(signal)),
    },
  );
  owner.done.catch(() => undefined);
  const running = arwx.run(owner.handler);
  running.catch(() => undefined);
  let inboundSequence = 1n;
  return {
    api,
    arwx,
    cancellation,
    client,
    frames,
    input,
    output,
    owner,
    running,
    startupCalls,
    send(messageType, payload): void {
      input.write(
        encodeLocalFrame({
          minorVersion: 0,
          messageType,
          sequence: inboundSequence,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload,
        }),
      );
      inboundSequence += 1n;
    },
  };
}

describe("Control zero-slot shadow supervisor", () => {
  it("authenticates before registration and advertises only zero execution", async () => {
    const harness = await createHarness();
    const hello = await readHello(harness);
    expect(harness.api.registrations).toHaveLength(0);

    harness.send(LocalMessageType.HelloAck, helloAck(harness, hello));
    await waitFor(() => harness.frames.length === 2);
    expect(harness.frames[1]?.messageType).toBe(LocalMessageType.ControlProof);
    expect(harness.api.signingDigests).toHaveLength(1);
    expect(harness.api.registrations).toHaveLength(0);

    harness.send(LocalMessageType.Ready, readyMessage(harness, hello));
    await waitFor(
      () => harness.api.registrations.length === 1 && harness.api.heartbeats.length === 1,
    );

    const registration = harness.api.registrations[0];
    if (registration === undefined) throw new Error("Expected one shadow registration request.");
    expect(registration).toMatchObject({
      protocolVersion: "1.0",
      workerNodeId: hello.workerNodeId,
      workerInstanceId: hello.workerInstanceId,
      displayName: hello.workerNodeId,
      maxSlots: 1,
      capabilities: {
        operatingSystem: "windows",
        architecture: "x64",
        headless: true,
        interactiveDesktop: false,
        codexVersion: "disabled-zero-execution",
        recipeIds: [],
        labels: {
          "execution-enabled": "false",
          "execution-mode": "zero-slot-shadow",
          "isolation-mode": "split-service-v1",
        },
      },
    });
    expect(harness.api.heartbeats[0]).toMatchObject({
      workerNodeId: hello.workerNodeId,
      workerInstanceId: hello.workerInstanceId,
      heartbeatSequence: 0,
      availableSlots: 0,
      activeLeases: [],
      health: { state: "online", freeDiskBytes: 0 },
    });
    expect(harness.client.claimCalls).toBe(0);
    expect(harness.client.completeCalls).toBe(0);
    expect(harness.client.failCalls).toBe(0);

    await closeHarness(harness);
  });

  it("creates no runtime identity or protocol output before full role activation", async () => {
    const activated = deferred<void>();
    const harness = await createHarness(() => undefined, { activated: activated.promise });

    await nextTurn();
    expect(harness.frames).toHaveLength(0);
    expect(harness.api.signingDigests).toHaveLength(0);
    expect(harness.api.registrations).toHaveLength(0);
    expect(harness.startupCalls).toEqual({
      randomNonce: 0,
      randomUuid: 0,
      serverApi: 0,
    });

    activated.resolve(undefined);
    await completeHandshake(harness);
    expect(harness.startupCalls).toEqual({
      randomNonce: 1,
      randomUuid: 2,
      serverApi: 1,
    });
    await closeHarness(harness);
  });

  it("rejects Ready before HelloAck and never registers", async () => {
    const harness = await createHarness();
    const hello = await readHello(harness);

    harness.send(LocalMessageType.Ready, readyMessage(harness, hello));

    await expect(harness.running).rejects.toMatchObject({ code: "DISPATCH_FAILED" });
    await expect(harness.owner.done).rejects.toBeInstanceOf(Error);
    expect(harness.api.registrations).toHaveLength(0);
  });

  it.each([
    {
      name: "control nonce",
      mutate: (value: HelloAckMessage) => ({ ...value, controlNonce: "3".repeat(64) }),
    },
    {
      name: "session",
      mutate: (value: HelloAckMessage) => ({
        ...value,
        sessionId: "30000000-0000-4000-8000-000000000003",
      }),
    },
    {
      name: "worker instance",
      mutate: (value: HelloAckMessage) => ({ ...value, workerInstanceId: "control:replay" }),
    },
    {
      name: "manifest digest",
      mutate: (value: HelloAckMessage) => ({
        ...value,
        executorManifestSha256: "3".repeat(64),
      }),
    },
    {
      name: "policy digest",
      mutate: (value: HelloAckMessage) => ({
        ...value,
        executorPolicySha256: "3".repeat(64),
      }),
    },
    {
      name: "maximum slots",
      mutate: (value: HelloAckMessage) => ({ ...value, maximumSlots: 2 }),
    },
  ])("rejects HelloAck with mismatched $name", async ({ mutate }) => {
    const harness = await createHarness();
    const hello = await readHello(harness);

    harness.send(LocalMessageType.HelloAck, mutate(helloAck(harness, hello)));

    await expect(harness.running).rejects.toMatchObject({ code: "DISPATCH_FAILED" });
    expect(harness.api.registrations).toHaveLength(0);
  });

  it("rejects a malformed HostControl proof response", async () => {
    const harness = await createHarness((api) => {
      api.signingResult = "not-a-signature";
    });
    const hello = await readHello(harness);

    harness.send(LocalMessageType.HelloAck, helloAck(harness, hello));

    await expect(harness.running).rejects.toMatchObject({ code: "DISPATCH_FAILED" });
    expect(harness.api.registrations).toHaveLength(0);
  });

  it.each([
    {
      name: "ready execution",
      mutate: (value: ReadyMessage) => ({
        ...value,
        ready: true,
        availableSlots: 1,
        reasonCode: null,
      }),
    },
    {
      name: "nonzero disabled slots",
      mutate: (value: ReadyMessage) => ({ ...value, availableSlots: 1 }),
    },
    {
      name: "wrong reason",
      mutate: (value: ReadyMessage) => ({ ...value, reasonCode: "PREFLIGHT_FAILED" }),
    },
    {
      name: "replayed nonce",
      mutate: (value: ReadyMessage) => ({ ...value, executorNonce: "3".repeat(64) }),
    },
    {
      name: "changed preflight digest",
      mutate: (value: ReadyMessage) => ({
        ...value,
        executorPreflightSha256: "3".repeat(64),
      }),
    },
  ])("rejects Ready with $name", async ({ mutate }) => {
    const harness = await createHarness();
    const hello = await advanceToProof(harness);

    harness.send(LocalMessageType.Ready, mutate(readyMessage(harness, hello)));

    await expect(harness.running).rejects.toBeInstanceOf(Error);
    expect(harness.api.registrations).toHaveLength(0);
  });

  it("rejects replayed HelloAck after sending ControlProof", async () => {
    const harness = await createHarness();
    const hello = await advanceToProof(harness);

    harness.send(LocalMessageType.HelloAck, helloAck(harness, hello));

    await expect(harness.running).rejects.toMatchObject({ code: "DISPATCH_FAILED" });
    expect(harness.api.registrations).toHaveLength(0);
  });

  it("re-registers the same instance without resetting heartbeat sequence", async () => {
    let heartbeatCalls = 0;
    const harness = await createHarness(
      (api) => {
        api.heartbeatHandler = async () => {
          heartbeatCalls += 1;
          if (heartbeatCalls === 1) {
            throw new WorkerApiError("registration lost", 409, "worker_unavailable");
          }
          return heartbeatResponse();
        };
      },
      { sleep: allowSleeps(1) },
    );
    await completeHandshake(harness);
    await waitFor(
      () => harness.api.registrations.length === 2 && harness.api.heartbeats.length === 2,
    );

    expect(harness.api.registrations[1]?.workerInstanceId).toBe(
      harness.api.registrations[0]?.workerInstanceId,
    );
    expect(harness.api.heartbeats.map((request) => request.heartbeatSequence)).toEqual([0, 1]);
    expect(harness.api.heartbeats.every((request) => request.availableSlots === 0)).toBe(true);
    expect(harness.client.claimCalls).toBe(0);

    await closeHarness(harness);
  });

  it.each(["draining", "disabled"] as const)(
    "keeps the same zero-slot instance reporting after the Server enters %s state",
    async (workerState) => {
      const harness = await createHarness(
        (api) => {
          api.heartbeatHandler = async () => heartbeatResponse({ workerState });
        },
        { sleep: allowSleeps(1) },
      );
      await completeHandshake(harness);
      await waitFor(() => harness.api.heartbeats.length === 2);

      expect(harness.api.heartbeats[1]).toMatchObject({
        workerInstanceId: harness.api.heartbeats[0]?.workerInstanceId,
        availableSlots: 0,
        activeLeases: [],
        health: { state: workerState },
      });
      expect(hasOutbound(harness, LocalMessageType.Drain)).toBe(false);
      expect(harness.client.claimCalls).toBe(0);

      await closeHarness(harness);
    },
  );

  it("waits for HostControl and raw heartbeat ownership before sending Drain", async () => {
    const idle = deferred<void>();
    const harness = await createHarness((api) => {
      api.heartbeatHandler = async (signal) => {
        if (signal === undefined) throw new Error("Expected heartbeat cancellation signal.");
        await waitForAbort(signal);
        return heartbeatResponse();
      };
    });
    harness.client.waitForIdleHandler = () => idle.promise;
    await completeHandshake(harness);

    const closing = harness.owner.close(performance.now() + 1_000);
    await waitFor(() => harness.client.idleWaits === 1);
    expect(hasOutbound(harness, LocalMessageType.Drain)).toBe(false);

    idle.resolve(undefined);
    await waitFor(() => hasOutbound(harness, LocalMessageType.Drain));
    harness.send(LocalMessageType.Drained, drainedMessage(harness));
    harness.input.end();

    await expect(closing).resolves.toBeUndefined();
    await expect(harness.running).resolves.toBeUndefined();
  });

  it("copies the original ServiceHost Unix deadline into Control Drain", async () => {
    const harness = await createHarness();
    await completeHandshake(harness);
    const requestedAtUnixMs = 1_700_000_000_000;
    const shutdownDeadlineUnixMs = 1_700_000_001_000;
    const absoluteDeadline = performance.now() + 1_000;
    harness.client.requestShutdown(
      Object.freeze({
        protocolVersion: "1.0",
        type: "notification",
        notification: "ShutdownRequested",
        bootstrapId: harness.client.bootstrap.bootstrap.bootstrapId,
        role: "control",
        reasonCode: "SERVICE_STOP",
        requestedAtUnixMs,
        shutdownDeadlineUnixMs,
        absoluteDeadline,
      }),
    );

    const closing = harness.owner.close(absoluteDeadline);
    await waitFor(() => hasOutbound(harness, LocalMessageType.Drain));
    const drain = harness.frames.find((frame) => frame.messageType === LocalMessageType.Drain);
    expect(drain?.payload).toMatchObject({ requestedAtUnixMs, shutdownDeadlineUnixMs });
    harness.send(LocalMessageType.Drained, drainedMessage(harness));
    harness.input.end();
    await expect(closing).resolves.toBeUndefined();
    await expect(harness.running).resolves.toBeUndefined();
  });

  it("does not start a shutdown phase after its deadline has expired", async () => {
    const harness = await createHarness();
    await completeHandshake(harness);
    harness.client.waitForIdleHandler = async () => {
      throw new Error("late idle rejection must remain unreachable");
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(0);
    now.mockReturnValue(10);
    process.on("unhandledRejection", onUnhandled);
    try {
      const closing = harness.owner.close(10);
      const closeFailure = expect(closing).rejects.toBeInstanceOf(Error);

      await closeFailure;
      await nextTurn();
      expect(harness.client.idleWaits).toBe(0);
      expect(hasOutbound(harness, LocalMessageType.Drain)).toBe(false);
      expect(unhandled).toEqual([]);
    } finally {
      now.mockRestore();
      process.removeListener("unhandledRejection", onUnhandled);
      harness.arwx.abort();
      await harness.running.catch(() => undefined);
    }
  });

  it("fails closed on upgrade-required server rejection", async () => {
    const harness = await createHarness((api) => {
      api.heartbeatHandler = async () => {
        throw new WorkerApiError("protocol upgrade required", 409, "protocol_version_unsupported");
      };
    });
    await completeHandshake(harness);

    await expect(harness.owner.done).rejects.toBeInstanceOf(WorkerApiError);
    await expect(harness.running).rejects.toBeInstanceOf(Error);
    expect(harness.arwx.state).toBe("failed");
    expect(harness.client.claimCalls).toBe(0);
  });

  it("fails closed if the Server returns any lease command", async () => {
    const harness = await createHarness((api) => {
      api.heartbeatHandler = async () =>
        heartbeatResponse({
          commands: [
            {
              runAttemptId: "run:forbidden",
              leaseGeneration: 1,
              action: "drain",
              leaseExpiresAt: null,
            },
          ],
        });
    });
    await completeHandshake(harness);

    await expect(harness.owner.done).rejects.toMatchObject({
      code: "CONTROL_SHADOW_SERVER_INVALID",
    });
    await expect(harness.running).rejects.toBeInstanceOf(Error);
    expect(harness.client.claimCalls).toBe(0);
  });

  it("bounds a registration call that never settles", async () => {
    const harness = await createHarness(
      (api) => {
        api.registrationHandler = async () => await new Promise(() => undefined);
      },
      { operationTimeoutMs: 5 },
    );
    await completeHandshake(harness, false);

    await expect(harness.owner.done).rejects.toMatchObject({ code: "CONTROL_SHADOW_TIMEOUT" });
    await expect(harness.running).rejects.toBeInstanceOf(Error);
    expect(harness.client.claimCalls).toBe(0);
  });

  it("rejects an unsupported architecture before registration", async () => {
    const harness = await createHarness(() => undefined, { architecture: "ia32" });

    await expect(harness.owner.done).rejects.toMatchObject({
      code: "CONTROL_SHADOW_ARCHITECTURE_INVALID",
    });
    expect(harness.api.registrations).toHaveLength(0);
    harness.arwx.abort();
    await harness.running.catch(() => undefined);
  });

  it("bounds shutdown when Executor never returns Drained", async () => {
    const harness = await createHarness();
    await completeHandshake(harness);
    const closing = harness.owner.close(performance.now() + 250);
    await waitFor(() => hasOutbound(harness, LocalMessageType.Drain));

    await expect(closing).rejects.toMatchObject({ code: "CONTROL_SHADOW_TIMEOUT" });
    harness.arwx.abort();
    await harness.running.catch(() => undefined);
  });
});

function registrationResponse(
  overrides: Partial<WorkerRegistrationResponse> = {},
): WorkerRegistrationResponse {
  return {
    protocolVersion: "1.0",
    workerId: "worker:id",
    state: "online",
    heartbeatIntervalMs: 5_000,
    leaseTtlMs: 30_000,
    serverTime: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function heartbeatResponse(
  overrides: Partial<WorkerHeartbeatResponse> = {},
): WorkerHeartbeatResponse {
  return {
    serverTime: "2026-09-01T00:00:00.000Z",
    nextHeartbeatInMs: 5_000,
    workerState: "online",
    commands: [],
    ...overrides,
  };
}

async function readHello(harness: Harness): Promise<HelloMessage> {
  await waitFor(() => harness.frames.length >= 1);
  const frame = harness.frames[0];
  if (frame?.messageType !== LocalMessageType.Hello) {
    throw new Error("Expected Control Hello as the first outbound frame.");
  }
  return frame.payload as unknown as HelloMessage;
}

function helloAck(harness: Harness, hello: Readonly<HelloMessage>): HelloAckMessage {
  return {
    protocolMajor: hello.protocolMajor,
    protocolMinor: hello.minimumMinor,
    workerNodeId: hello.workerNodeId,
    workerInstanceId: hello.workerInstanceId,
    executorBootId,
    sessionId: hello.sessionId,
    controlNonce: hello.controlNonce,
    executorNonce,
    executorManifestSha256: harness.client.bootstrap.bootstrap.installationManifestSha256,
    executorPolicySha256: harness.client.bootstrap.roleConfig.executorPolicySha256,
    executorPreflightSha256,
    maximumSlots: 1,
  };
}

function readyMessage(harness: Harness, hello: Readonly<HelloMessage>): ReadyMessage {
  const ack = helloAck(harness, hello);
  return {
    protocolMajor: ack.protocolMajor,
    protocolMinor: ack.protocolMinor,
    workerNodeId: ack.workerNodeId,
    workerInstanceId: ack.workerInstanceId,
    executorBootId: ack.executorBootId,
    sessionId: ack.sessionId,
    controlNonce: ack.controlNonce,
    executorNonce: ack.executorNonce,
    executorManifestSha256: ack.executorManifestSha256,
    executorPolicySha256: ack.executorPolicySha256,
    executorPreflightSha256: ack.executorPreflightSha256,
    isolationMode: "split-service-v1",
    ready: false,
    availableSlots: 0,
    reasonCode: "EXECUTION_DISABLED",
  };
}

function drainedMessage(harness: Harness) {
  const frame = harness.frames[0];
  if (frame?.messageType !== LocalMessageType.Hello) {
    throw new Error("Expected an established Control Hello.");
  }
  const ready = readyMessage(harness, frame.payload as unknown as HelloMessage);
  return {
    protocolMajor: ready.protocolMajor,
    protocolMinor: ready.protocolMinor,
    workerNodeId: ready.workerNodeId,
    workerInstanceId: ready.workerInstanceId,
    executorBootId: ready.executorBootId,
    sessionId: ready.sessionId,
    activeAttemptCount: 0 as const,
    drainedAtUnixMs: 1_700_000_000_000,
  };
}

async function advanceToProof(harness: Harness): Promise<HelloMessage> {
  const hello = await readHello(harness);
  harness.send(LocalMessageType.HelloAck, helloAck(harness, hello));
  await waitFor(() => hasOutbound(harness, LocalMessageType.ControlProof));
  return hello;
}

async function completeHandshake(
  harness: Harness,
  waitForRegistration = true,
): Promise<HelloMessage> {
  const hello = await advanceToProof(harness);
  harness.send(LocalMessageType.Ready, readyMessage(harness, hello));
  if (waitForRegistration) {
    await waitFor(
      () => harness.api.registrations.length >= 1 && harness.api.heartbeats.length >= 1,
    );
  }
  return hello;
}

async function closeHarness(harness: Harness): Promise<void> {
  const closing = harness.owner.close(performance.now() + 1_000);
  await waitFor(() => hasOutbound(harness, LocalMessageType.Drain));
  harness.send(LocalMessageType.Drained, drainedMessage(harness));
  harness.input.end();
  await expect(closing).resolves.toBeUndefined();
  await expect(harness.owner.done).resolves.toBeUndefined();
  await expect(harness.running).resolves.toBeUndefined();
}

function hasOutbound(harness: Harness, messageType: LocalMessageType): boolean {
  return harness.frames.some((frame) => frame.messageType === messageType);
}

function allowSleeps(count: number): (milliseconds: number, signal: AbortSignal) => Promise<void> {
  let remaining = count;
  return async (_milliseconds, signal) => {
    if (signal.aborted) throw signal.reason;
    if (remaining > 0) {
      remaining -= 1;
      return;
    }
    await waitForAbort(signal);
  };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error("Timed out waiting for Control shadow test state.");
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
