import { generateKeyPairSync, type KeyObject, sign as nodeSign } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  type CancelAttemptMessage,
  type ControlProofMessage,
  createControlProofMessageV1,
  createHandshakeTranscriptSigningBytes,
  createHandshakeTranscriptV1,
  createSignedHandshakeProofV1,
  type DrainMessage,
  deriveCapabilityKeyId,
  encodeLocalFrame,
  type HelloAckMessage,
  type HelloMessage,
  IncrementalLocalFrameDecoder,
  LOCAL_PROTOCOL_NIL_CORRELATION_ID,
  LocalMessageType,
  serializeCanonicalJson,
  validateLocalMessagePayload,
} from "@agentic-review/local-protocol";
import { describe, expect, it } from "vitest";
import type { ArmArwxShutdownResultV1 } from "./arwx-shutdown.js";
import {
  type ArwxFinalFrameReceipt,
  type ArwxInboundMessage,
  ArwxStdioChannel,
  commitArwxFinalFrameReceipt,
  consumeArwxFinalFrameReceipt,
} from "./arwx-stdio-channel.js";
import type { ExecutorHostControlSession } from "./executor-host-control-session.js";
import { installExecutorShadowRuntime } from "./executor-shadow-runtime.js";
import {
  parseServiceHostLaunchContract,
  SERVICE_HOST_CONTROL_PIPE_PREFIX,
} from "./launch-contract.js";
import { encodeHostControlOpaqueJson } from "./opaque-json.js";
import {
  type ParsedRuntimeBootstrapV1,
  parseRuntimeBootstrap,
  RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES,
} from "./runtime-bootstrap.js";
import { bootstrapDocument, foundationRoleConfig } from "./runtime-bootstrap.test-helpers.js";
import type { RuntimeBootstrapArwxRuntimeOwner } from "./runtime-bootstrap-handshake.js";

const p256Order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const p256HalfOrder = p256Order >> 1n;
const authority = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const otherAuthority = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const authorityKeyId = deriveCapabilityKeyId(authority.publicKey);
const otherAuthorityKeyId = deriveCapabilityKeyId(otherAuthority.publicKey);
const fixedBootId = "20000000-0000-4000-8000-000000000002";
const secondBootId = "30000000-0000-4000-8000-000000000003";
const sessionId = "10000000-0000-4000-8000-000000000001";
const attemptCorrelationId = "40000000-0000-4000-8000-000000000004";
const controlNonce = "1".repeat(64);
const executorNonce = Buffer.alloc(32, 2);

describe("Executor zero-slot shadow runtime", () => {
  it("defers supervisor construction until the full role activation barrier resolves", async () => {
    let bootIdRequested = false;
    let nonceRequested = false;
    let activate!: () => void;
    const activated = new Promise<void>((resolve) => {
      activate = resolve;
    });
    const harness = createHarness({
      activated,
      createBootId: () => {
        bootIdRequested = true;
        return fixedBootId;
      },
      createNonce: () => {
        nonceRequested = true;
        return executorNonce;
      },
    });
    try {
      sendControl(harness, LocalMessageType.Hello, createHello(harness.bootstrap), 1n);
      expect(bootIdRequested).toBe(false);
      expect(nonceRequested).toBe(false);

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(bootIdRequested).toBe(false);
      expect(nonceRequested).toBe(false);
      expect(harness.outputFrames).toHaveLength(0);
      activate();
      await harness.readOutput(1);

      expect(bootIdRequested).toBe(true);
      expect(nonceRequested).toBe(true);
    } finally {
      activate();
      await harness.stop();
    }
  });

  it("never creates a supervisor when full role activation rejects", async () => {
    let bootIdRequested = false;
    let nonceRequested = false;
    const activationFailure = new Error("activation rejected");
    const harness = createHarness({
      activated: Promise.reject(activationFailure),
      createBootId: () => {
        bootIdRequested = true;
        return fixedBootId;
      },
      createNonce: () => {
        nonceRequested = true;
        return executorNonce;
      },
    });

    sendControl(harness, LocalMessageType.Hello, createHello(harness.bootstrap), 1n);
    await expect(harness.runtime.done).rejects.toBe(activationFailure);
    await expect(harness.running).rejects.toBeDefined();
    expect(bootIdRequested).toBe(false);
    expect(nonceRequested).toBe(false);
    expect(harness.outputFrames).toHaveLength(0);
    await harness.stop();
  });

  it("publishes disabled Ready only after verifying the exact Control proof", async () => {
    const harness = createHarness();
    try {
      const hello = createHello(harness.bootstrap);
      sendControl(harness, LocalMessageType.Hello, hello, 1n);
      const helloAckFrame = await harness.readOutput(1);
      const helloAck = payload<HelloAckMessage>(helloAckFrame);

      expect(helloAckFrame.messageType).toBe(LocalMessageType.HelloAck);
      expect(harness.outputFrames).toHaveLength(1);
      expect(helloAck).toEqual({
        protocolMajor: 1,
        protocolMinor: 0,
        workerNodeId: harness.bootstrap.bootstrap.workerNodeId,
        workerInstanceId: hello.workerInstanceId,
        executorBootId: fixedBootId,
        sessionId: hello.sessionId,
        controlNonce: hello.controlNonce,
        executorNonce: executorNonce.toString("hex"),
        executorManifestSha256: harness.bootstrap.bootstrap.installationManifestSha256,
        executorPolicySha256: harness.bootstrap.roleConfig.executorPolicySha256,
        executorPreflightSha256: harness.bootstrap.bootstrap.preflightSha256,
        maximumSlots: 1,
      });

      sendControl(
        harness,
        LocalMessageType.ControlProof,
        createProof(hello, helloAck, authority.privateKey),
        2n,
      );
      const readyFrame = await harness.readOutput(2);
      expect(readyFrame.messageType).toBe(LocalMessageType.Ready);
      expect(readyFrame.payload).toEqual({
        protocolMajor: 1,
        protocolMinor: 0,
        workerNodeId: helloAck.workerNodeId,
        workerInstanceId: helloAck.workerInstanceId,
        executorBootId: helloAck.executorBootId,
        sessionId: helloAck.sessionId,
        controlNonce: helloAck.controlNonce,
        executorNonce: helloAck.executorNonce,
        executorManifestSha256: helloAck.executorManifestSha256,
        executorPolicySha256: helloAck.executorPolicySha256,
        executorPreflightSha256: helloAck.executorPreflightSha256,
        isolationMode: "split-service-v1",
        ready: false,
        availableSlots: 0,
        reasonCode: "EXECUTION_DISABLED",
      });
    } finally {
      await harness.stop();
    }
  });

  it.each([
    ["worker node", { workerNodeId: "other-node" }],
    ["package manifest", { controlManifestSha256: "9".repeat(64) }],
  ])("fails closed on a wrong Hello %s before emitting HelloAck", async (_name, mutation) => {
    const harness = createHarness();
    const hello = {
      ...createHello(harness.bootstrap),
      ...mutation,
    };

    sendControl(harness, LocalMessageType.Hello, hello, 1n);

    await expect(harness.runtime.done).rejects.toMatchObject({
      code: "HANDSHAKE_CONTEXT_INVALID",
    });
    await expect(harness.running).rejects.toBeDefined();
    expect(harness.outputFrames).toHaveLength(0);
  });

  it("fails closed at the ARWX schema boundary on an unsupported protocol version", async () => {
    const harness = createHarness();
    sendControl(
      harness,
      LocalMessageType.Hello,
      { ...createHello(harness.bootstrap), protocolMajor: 2 },
      1n,
    );

    await expect(harness.running).rejects.toMatchObject({ code: "MESSAGE_INVALID" });
    await expect(harness.runtime.done).rejects.toMatchObject({ code: "RUNTIME_CANCELLED" });
    expect(harness.outputFrames).toHaveLength(0);
  });

  it.each([
    {
      name: "wrong signing key",
      mutate: (hello: HelloMessage, ack: HelloAckMessage) => ({
        hello,
        ack,
        key: otherAuthority.privateKey,
        keyId: authorityKeyId,
      }),
    },
    {
      name: "wrong key ID",
      mutate: (hello: HelloMessage, ack: HelloAckMessage) => ({
        hello,
        ack,
        key: otherAuthority.privateKey,
        keyId: otherAuthorityKeyId,
      }),
    },
    {
      name: "replayed session",
      mutate: (hello: HelloMessage, ack: HelloAckMessage) => ({
        hello: { ...hello, sessionId: "50000000-0000-4000-8000-000000000005" },
        ack: { ...ack, sessionId: "50000000-0000-4000-8000-000000000005" },
        key: authority.privateKey,
        keyId: authorityKeyId,
      }),
    },
    {
      name: "wrong nonce",
      mutate: (hello: HelloMessage, ack: HelloAckMessage) => ({
        hello: { ...hello, controlNonce: "3".repeat(64) },
        ack: { ...ack, controlNonce: "3".repeat(64) },
        key: authority.privateKey,
        keyId: authorityKeyId,
      }),
    },
    {
      name: "wrong policy",
      mutate: (hello: HelloMessage, ack: HelloAckMessage) => ({
        hello,
        ack: { ...ack, executorPolicySha256: "4".repeat(64) },
        key: authority.privateKey,
        keyId: authorityKeyId,
      }),
    },
    {
      name: "wrong preflight",
      mutate: (hello: HelloMessage, ack: HelloAckMessage) => ({
        hello,
        ack: { ...ack, executorPreflightSha256: "5".repeat(64) },
        key: authority.privateKey,
        keyId: authorityKeyId,
      }),
    },
    {
      name: "wrong package manifest",
      mutate: (hello: HelloMessage, ack: HelloAckMessage) => ({
        hello: { ...hello, controlManifestSha256: "6".repeat(64) },
        ack: { ...ack, executorManifestSha256: "6".repeat(64) },
        key: authority.privateKey,
        keyId: authorityKeyId,
      }),
    },
  ])("rejects $name proof without publishing Ready", async ({ mutate }) => {
    const harness = createHarness();
    const hello = createHello(harness.bootstrap);
    sendControl(harness, LocalMessageType.Hello, hello, 1n);
    const helloAck = payload<HelloAckMessage>(await harness.readOutput(1));
    const changed = mutate(hello, helloAck);

    sendControl(
      harness,
      LocalMessageType.ControlProof,
      createProof(changed.hello, changed.ack, changed.key, changed.keyId),
      2n,
    );

    await expect(harness.runtime.done).rejects.toMatchObject({ code: "HANDSHAKE_PROOF_INVALID" });
    await expect(harness.running).rejects.toBeDefined();
    expect(harness.outputFrames).toHaveLength(1);
  });

  it("rejects a tampered Control proof signature without publishing Ready", async () => {
    const harness = createHarness();
    const hello = createHello(harness.bootstrap);
    sendControl(harness, LocalMessageType.Hello, hello, 1n);
    const helloAck = payload<HelloAckMessage>(await harness.readOutput(1));
    const proof = createProof(hello, helloAck, authority.privateKey);

    sendControl(
      harness,
      LocalMessageType.ControlProof,
      {
        ...proof,
        signedProof: { ...proof.signedProof, signature: "A".repeat(86) },
      },
      2n,
    );

    await expect(harness.runtime.done).rejects.toMatchObject({ code: "HANDSHAKE_PROOF_INVALID" });
    await expect(harness.running).rejects.toBeDefined();
    expect(harness.outputFrames).toHaveLength(1);
  });

  it("rejects out-of-order, duplicate, and zero-execution business messages", async () => {
    const outOfOrder = createHarness();
    sendControl(
      outOfOrder,
      LocalMessageType.ControlProof,
      createProof(
        createHello(outOfOrder.bootstrap),
        syntheticAck(outOfOrder.bootstrap),
        authority.privateKey,
      ),
      1n,
    );
    await expect(outOfOrder.runtime.done).rejects.toMatchObject({
      code: "HANDSHAKE_ORDER_INVALID",
    });
    await expect(outOfOrder.running).rejects.toBeDefined();

    const duplicate = createHarness();
    const duplicateHello = createHello(duplicate.bootstrap);
    sendControl(duplicate, LocalMessageType.Hello, duplicateHello, 1n);
    await duplicate.readOutput(1);
    sendControl(duplicate, LocalMessageType.Hello, duplicateHello, 2n);
    await expect(duplicate.runtime.done).rejects.toMatchObject({
      code: "HANDSHAKE_ORDER_INVALID",
    });
    await expect(duplicate.running).rejects.toBeDefined();

    const beforeHandshake = createHarness();
    sendControl(
      beforeHandshake,
      LocalMessageType.CancelAttempt,
      cancelAttemptMessage(syntheticAck(beforeHandshake.bootstrap)),
      1n,
      attemptCorrelationId,
    );
    await expect(beforeHandshake.runtime.done).rejects.toMatchObject({
      code: "HANDSHAKE_ORDER_INVALID",
    });
    await expect(beforeHandshake.running).rejects.toBeDefined();

    const business = createHarness();
    const context = await authenticate(business);
    sendControl(
      business,
      LocalMessageType.CancelAttempt,
      cancelAttemptMessage(context.helloAck),
      3n,
      attemptCorrelationId,
    );
    await expect(business.runtime.done).rejects.toMatchObject({ code: "EXECUTION_DISABLED" });
    await expect(business.running).rejects.toBeDefined();
    expect(business.host.armCalls).toBe(0);
  });

  it("never publishes Ready when external close wins before Control proof", async () => {
    const harness = createHarness();
    const hello = createHello(harness.bootstrap);
    sendControl(harness, LocalMessageType.Hello, hello, 1n);
    const helloAck = payload<HelloAckMessage>(await harness.readOutput(1));
    const closing = harness.runtime.close(performance.now() + 1_000);

    sendControl(
      harness,
      LocalMessageType.ControlProof,
      createProof(hello, helloAck, authority.privateKey),
      2n,
    );

    await expect(closing).rejects.toMatchObject({ code: "RUNTIME_CLOSING" });
    await expect(harness.running).rejects.toBeDefined();
    expect(harness.outputFrames).toHaveLength(1);
  });

  it("sends exact Drained and arms HostControl only from the post-dispatch effect", async () => {
    const events: string[] = [];
    const harness = createHarness({ events });
    const { helloAck } = await authenticate(harness);
    sendControl(harness, LocalMessageType.Drain, drainMessage(helloAck), 3n);
    const drainedFrame = await harness.readOutput(3);
    harness.input.end();

    expect(drainedFrame.messageType).toBe(LocalMessageType.Drained);
    expect(drainedFrame.payload).toEqual({
      protocolMajor: helloAck.protocolMajor,
      protocolMinor: helloAck.protocolMinor,
      workerNodeId: helloAck.workerNodeId,
      workerInstanceId: helloAck.workerInstanceId,
      executorBootId: helloAck.executorBootId,
      sessionId: helloAck.sessionId,
      activeAttemptCount: 0,
      drainedAtUnixMs: 1_700_000_000_001,
    });
    await expect(harness.runtime.done).resolves.toBeUndefined();
    await expect(harness.running).resolves.toBeUndefined();
    expect(harness.host.armCalls).toBe(1);
    expect(harness.host.receiptConsumed).toBe(true);
    expect(events).toEqual(["out:2", "out:3", "out:15", "arm"]);
  });

  it("rejects a mismatched Drain session and an expired external-close deadline", async () => {
    const wrongSession = createHarness();
    const first = await authenticate(wrongSession);
    sendControl(
      wrongSession,
      LocalMessageType.Drain,
      { ...drainMessage(first.helloAck), sessionId: "60000000-0000-4000-8000-000000000006" },
      3n,
    );
    await expect(wrongSession.runtime.done).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
    await expect(wrongSession.running).rejects.toBeDefined();
    expect(wrongSession.host.armCalls).toBe(0);

    const expired = createHarness();
    const second = await authenticate(expired);
    const closing = expired.runtime.close(performance.now() - 1);
    sendControl(expired, LocalMessageType.Drain, drainMessage(second.helloAck), 3n);
    await expect(closing).rejects.toMatchObject({ code: "SHUTDOWN_FAILED" });
    await expect(expired.running).rejects.toBeDefined();
    expect(expired.outputFrames).toHaveLength(2);
    expect(expired.host.armCalls).toBe(0);
  });

  it("fails closed when external close tightens an in-flight Drain deadline", async () => {
    let releaseArm!: () => void;
    const armGate = new Promise<void>((resolve) => {
      releaseArm = resolve;
    });
    const harness = createHarness({ beforeArm: () => armGate });
    try {
      const { helloAck } = await authenticate(harness);
      sendControl(harness, LocalMessageType.Drain, drainMessage(helloAck), 3n);
      await harness.readOutput(3);
      await waitFor(() => harness.host.armCalls === 1);

      const closing = harness.runtime.close(performance.now() + 10);

      await expect(closing).rejects.toMatchObject({ code: "SHUTDOWN_FAILED" });
      releaseArm();
      await expect(harness.running).rejects.toBeDefined();
      expect(harness.outputFrames).toHaveLength(3);
      expect(harness.host.closeCalls).toBe(1);
      expect(harness.host.receiptConsumed).toBe(false);
    } finally {
      releaseArm();
      await harness.stop();
    }
  });

  it("creates a fresh Executor boot ID for every runtime installation", async () => {
    const first = createHarness({ bootId: fixedBootId });
    const second = createHarness({ bootId: secondBootId });
    try {
      sendControl(first, LocalMessageType.Hello, createHello(first.bootstrap), 1n);
      sendControl(second, LocalMessageType.Hello, createHello(second.bootstrap), 1n);
      const firstAck = payload<HelloAckMessage>(await first.readOutput(1));
      const secondAck = payload<HelloAckMessage>(await second.readOutput(1));

      expect(firstAck.executorBootId).toBe(fixedBootId);
      expect(secondAck.executorBootId).toBe(secondBootId);
      expect(firstAck.executorBootId).not.toBe(secondAck.executorBootId);
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
  });

  it("rejects a proof replayed across a fresh Executor boot", async () => {
    const first = createHarness({ bootId: fixedBootId });
    const second = createHarness({ bootId: secondBootId });
    try {
      const firstHello = createHello(first.bootstrap);
      const secondHello = createHello(second.bootstrap);
      sendControl(first, LocalMessageType.Hello, firstHello, 1n);
      sendControl(second, LocalMessageType.Hello, secondHello, 1n);
      const firstAck = payload<HelloAckMessage>(await first.readOutput(1));
      await second.readOutput(1);

      sendControl(
        second,
        LocalMessageType.ControlProof,
        createProof(firstHello, firstAck, authority.privateKey),
        2n,
      );

      await expect(second.runtime.done).rejects.toMatchObject({
        code: "HANDSHAKE_PROOF_INVALID",
      });
      await expect(second.running).rejects.toBeDefined();
      expect(second.outputFrames).toHaveLength(1);
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
  });
});

interface HarnessOptions {
  readonly activated?: Promise<void>;
  readonly beforeArm?: () => Promise<void>;
  readonly bootId?: string;
  readonly createBootId?: () => string;
  readonly createNonce?: () => Uint8Array;
  readonly events?: string[];
}

interface Harness {
  readonly bootstrap: Readonly<ParsedRuntimeBootstrapV1>;
  readonly host: FakeExecutorHostControl;
  readonly input: PassThrough;
  readonly outputFrames: ArwxInboundMessage[];
  readonly runtime: RuntimeBootstrapArwxRuntimeOwner;
  readonly running: Promise<void>;
  readOutput(count: number): Promise<Readonly<ArwxInboundMessage>>;
  stop(): Promise<void>;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const bootstrap = createBootstrap(authority.publicKey);
  const input = new PassThrough();
  const output = new PassThrough();
  const arwx = new ArwxStdioChannel({
    localRole: "executor",
    input,
    output,
    maximumQueuedWriteBytes: bootstrap.bootstrap.arwx.maximumQueuedBytesPerDirection,
    closeTimeoutMs:
      bootstrap.bootstrap.shutdown.gracefulTimeoutMs -
      bootstrap.bootstrap.shutdown.forceTerminationReserveMs,
  });
  const controller = new AbortController();
  const outputFrames: ArwxInboundMessage[] = [];
  const outputDecoder = new IncrementalLocalFrameDecoder({ minorVersion: 0 });
  output.on("data", (chunk: Buffer) => {
    for (const frame of outputDecoder.push(chunk)) {
      outputFrames.push({
        sequence: frame.sequence,
        messageType: frame.messageType,
        correlationId: frame.correlationId,
        payload: validateLocalMessagePayload(frame.messageType, frame.payload, frame.correlationId),
      });
      options.events?.push(`out:${frame.messageType}`);
    }
  });
  const host = new FakeExecutorHostControl(bootstrap, arwx, options.events, options.beforeArm);
  const runtime = installExecutorShadowRuntime(
    {
      role: "executor",
      launch: parseServiceHostLaunchContract(
        [
          "--service-role=executor",
          "--servicehost-arwx-stdio",
          `--servicehost-host-control-pipe=${SERVICE_HOST_CONTROL_PIPE_PREFIX}${"e".repeat(64)}`,
        ],
        "executor",
      ),
      bootstrap,
      hostControl: host,
      arwx,
      activated: options.activated ?? Promise.resolve(),
      signal: controller.signal,
    },
    {
      createBootId: options.createBootId ?? (() => options.bootId ?? fixedBootId),
      createNonce: options.createNonce ?? (() => executorNonce),
      nowUnixMs: () => 1_700_000_000_001,
    },
  );
  const running = arwx.run(runtime.handler);
  running.catch(() => controller.abort());
  return {
    bootstrap,
    host,
    input,
    outputFrames,
    runtime,
    running,
    async readOutput(count: number): Promise<Readonly<ArwxInboundMessage>> {
      await waitFor(() => outputFrames.length >= count);
      const frame = outputFrames[count - 1];
      if (frame === undefined) throw new Error(`Missing Executor output frame ${count}.`);
      return frame;
    },
    async stop(): Promise<void> {
      controller.abort();
      arwx.abort();
      input.destroy();
      output.destroy();
      await Promise.allSettled([runtime.done, running, arwx.waitForQuiescence()]);
    },
  };
}

class FakeExecutorHostControl implements ExecutorHostControlSession {
  public readonly role = "executor" as const;
  public readonly done = new Promise<void>(() => undefined);
  public armCalls = 0;
  public closeCalls = 0;
  public receiptConsumed = false;
  #closed = false;

  public constructor(
    public readonly bootstrap: Readonly<ParsedRuntimeBootstrapV1>,
    private readonly arwx: ArwxStdioChannel,
    private readonly events: string[] | undefined,
    private readonly beforeArm: (() => Promise<void>) | undefined,
  ) {}

  public async armArwxShutdown(
    receipt: ArwxFinalFrameReceipt,
  ): Promise<Readonly<ArmArwxShutdownResultV1>> {
    this.armCalls += 1;
    this.events?.push("arm");
    await this.beforeArm?.();
    if (this.#closed) throw new Error("Executor HostControl was closed before Arm completed.");
    const binding = consumeArwxFinalFrameReceipt(receipt, this.arwx, "executor");
    if (binding === undefined || !commitArwxFinalFrameReceipt(receipt)) {
      throw new Error("Expected a post-dispatch Executor shutdown receipt.");
    }
    this.receiptConsumed = true;
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

  public async drain(): Promise<void> {}

  public async close(): Promise<void> {
    this.closeCalls += 1;
    this.#closed = true;
  }
}

async function authenticate(harness: Harness): Promise<{
  readonly hello: HelloMessage;
  readonly helloAck: HelloAckMessage;
}> {
  const hello = createHello(harness.bootstrap);
  sendControl(harness, LocalMessageType.Hello, hello, 1n);
  const helloAck = payload<HelloAckMessage>(await harness.readOutput(1));
  sendControl(
    harness,
    LocalMessageType.ControlProof,
    createProof(hello, helloAck, authority.privateKey),
    2n,
  );
  const ready = await harness.readOutput(2);
  if (ready.messageType !== LocalMessageType.Ready) {
    throw new Error("Expected disabled Executor Ready.");
  }
  return { hello, helloAck };
}

function createBootstrap(publicKey: KeyObject): Readonly<ParsedRuntimeBootstrapV1> {
  const document = JSON.parse(bootstrapDocument("executor").toString("utf8")) as Record<
    string,
    unknown
  >;
  const spki = Buffer.from(publicKey.export({ type: "spki", format: "der" }));
  document.roleConfig = encodeHostControlOpaqueJson(
    {
      ...foundationRoleConfig("executor"),
      localAuthorityKeyId: authorityKeyId,
      localAuthorityPublicKeySpki: {
        base64Url: spki.toString("base64url"),
        byteLength: spki.byteLength,
        sha256: authorityKeyId,
      },
    },
    RUNTIME_BOOTSTRAP_ROLE_CONFIG_MAXIMUM_BYTES,
  );
  return parseRuntimeBootstrap(Buffer.from(serializeCanonicalJson(document), "utf8"), "executor");
}

function createHello(bootstrap: Readonly<ParsedRuntimeBootstrapV1>): HelloMessage {
  return {
    protocolMajor: 1,
    minimumMinor: 0,
    maximumMinor: 0,
    workerNodeId: bootstrap.bootstrap.workerNodeId,
    workerInstanceId: "worker-instance:shadow",
    executorBootId: null,
    sessionId,
    controlNonce,
    controlManifestSha256: bootstrap.bootstrap.installationManifestSha256,
    controlPreflightSha256: "7".repeat(64),
  };
}

function syntheticAck(bootstrap: Readonly<ParsedRuntimeBootstrapV1>): HelloAckMessage {
  const hello = createHello(bootstrap);
  return {
    protocolMajor: 1,
    protocolMinor: 0,
    workerNodeId: hello.workerNodeId,
    workerInstanceId: hello.workerInstanceId,
    executorBootId: fixedBootId,
    sessionId: hello.sessionId,
    controlNonce: hello.controlNonce,
    executorNonce: executorNonce.toString("hex"),
    executorManifestSha256: bootstrap.bootstrap.installationManifestSha256,
    executorPolicySha256: bootstrap.roleConfig.executorPolicySha256,
    executorPreflightSha256: bootstrap.bootstrap.preflightSha256,
    maximumSlots: 1,
  };
}

function createProof(
  hello: HelloMessage,
  helloAck: HelloAckMessage,
  privateKey: KeyObject,
  keyId = authorityKeyId,
): Readonly<ControlProofMessage> {
  const transcript = createHandshakeTranscriptV1(hello, helloAck, keyId);
  const signature = makeLowS(
    nodeSign("sha256", createHandshakeTranscriptSigningBytes(transcript), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }),
  );
  return createControlProofMessageV1(createSignedHandshakeProofV1(transcript, signature));
}

function drainMessage(helloAck: HelloAckMessage): DrainMessage {
  return {
    protocolMajor: helloAck.protocolMajor,
    protocolMinor: helloAck.protocolMinor,
    workerNodeId: helloAck.workerNodeId,
    workerInstanceId: helloAck.workerInstanceId,
    executorBootId: helloAck.executorBootId,
    sessionId: helloAck.sessionId,
    reasonCode: "SERVICE_STOP",
    requestedAtUnixMs: 1_700_000_000_000,
  };
}

function cancelAttemptMessage(helloAck: HelloAckMessage): CancelAttemptMessage {
  return {
    protocolMajor: helloAck.protocolMajor,
    protocolMinor: helloAck.protocolMinor,
    workerNodeId: helloAck.workerNodeId,
    workerInstanceId: helloAck.workerInstanceId,
    executorBootId: helloAck.executorBootId,
    sessionId: helloAck.sessionId,
    attemptCorrelationId,
    runAttemptId: "run-attempt:disabled",
    reason: "shutdown",
    requestedAtUnixMs: 1_700_000_000_000,
  };
}

function sendControl(
  harness: Harness,
  messageType: Parameters<typeof encodeLocalFrame>[0]["messageType"],
  value: unknown,
  sequence: bigint,
  correlationId = LOCAL_PROTOCOL_NIL_CORRELATION_ID,
): void {
  harness.input.write(
    encodeLocalFrame({
      minorVersion: 0,
      messageType,
      sequence,
      correlationId,
      payload: value,
    }),
  );
}

function payload<T>(message: Readonly<ArwxInboundMessage>): T {
  return message.payload as unknown as T;
}

function makeLowS(signature: Uint8Array): Buffer {
  const result = Buffer.from(signature);
  const s = readUnsigned(result.subarray(32));
  if (s > p256HalfOrder) writeUnsigned(p256Order - s, result, 32);
  return result;
}

function readUnsigned(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function writeUnsigned(value: bigint, target: Uint8Array, offset: number): void {
  let remaining = value;
  for (let index = offset + 31; index >= offset; index -= 1) {
    target[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for Executor shadow state.");
}
