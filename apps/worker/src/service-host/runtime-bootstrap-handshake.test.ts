import { Duplex, PassThrough } from "node:stream";
import {
  encodeLocalFrame,
  LOCAL_PROTOCOL_NIL_CORRELATION_ID,
  LocalMessageType,
  serializeCanonicalJson,
} from "@agentic-review/local-protocol";
import { describe, expect, it } from "vitest";
import { ArwxStdioChannel } from "./arwx-stdio-channel.js";
import { encodeHostControlOpaqueJson } from "./opaque-json.js";
import { parseRuntimeBootstrap } from "./runtime-bootstrap.js";
import {
  bootstrapDocument,
  bootstrapTestAck,
  commitDocument,
  createTestBootstrapPreparation,
  handleBootstrapTestWrite,
  installBootstrapTestHost,
  type TestBootstrapArwxContext,
} from "./runtime-bootstrap.test-helpers.js";
import {
  type CompletedRuntimeBootstrap,
  createRuntimeBootstrapReadyBoundary,
  isCompletedRuntimeBootstrap,
  performRuntimeBootstrapHandshake,
  prepareRuntimeBootstrapArwxDispatcher,
  type RuntimeBootstrapArwxDispatcherHandler,
  type RuntimeBootstrapArwxRuntimeOwner,
  type RuntimeBootstrapPreparation,
  type RuntimeBootstrapReadyBoundary,
  terminateRuntimeBootstrapArwxDispatcher,
} from "./runtime-bootstrap-handshake.js";

class HandshakeHost extends Duplex {
  public promoted = false;

  public constructor(
    role: "control" | "executor",
    options?: Parameters<typeof installBootstrapTestHost>[2],
  ) {
    super({ allowHalfOpen: false });
    installBootstrapTestHost(this, role, options ?? 11);
  }

  public override _read(): void {}

  public override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (handleBootstrapTestWrite(this, chunk, callback)) return;
    callback();
  }

  public installPromotedOwner(): this {
    this.on("data", () => undefined);
    this.once("error", () => undefined);
    this.once("end", () => undefined);
    this.once("close", () => undefined);
    this.promoted = true;
    return this;
  }
}

describe("RuntimeBootstrapV1 HostControl handshake", () => {
  it.each(["control", "executor"] as const)(
    "completes fragmented %s bootstrap, readiness ACK, commit, and synchronous promotion",
    async (role) => {
      const host = new HandshakeHost(role);
      const promoted = await performRuntimeBootstrapHandshake(
        host,
        role,
        createTestBootstrapPreparation(role),
        performance.now() + 1_000,
        () => host.installPromotedOwner(),
      );

      expect(promoted).toBe(host);
      expect(host.promoted).toBe(true);
      const ack = JSON.parse(bootstrapTestAck(host)?.toString("utf8") ?? "null") as Record<
        string,
        unknown
      >;
      expect(ack).toMatchObject({
        accepted: true,
        arwxReceiveLoopStarted: true,
        bootstrapVersion: 1,
        protocolVersion: "1.0",
        role,
        type: "runtimeBootstrapAck",
      });
      host.destroy();
    },
  );

  it("rejects staged roleConfig fields before emitting an ACK", async () => {
    const bootstrap = mutateBootstrap("control", (value) => {
      value.roleConfig = encodeHostControlOpaqueJson({ arbitrary: true }, 47 * 1_024);
    });
    const host = new HandshakeHost("control", {
      bootstrap,
      commit: commitDocument("control", bootstrap),
      fragments: 5,
    });

    await expect(
      performRuntimeBootstrapHandshake(
        host,
        "control",
        createTestBootstrapPreparation("control"),
        performance.now() + 1_000,
        () => host.installPromotedOwner(),
      ),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_INVALID" });
    expect(bootstrapTestAck(host)).toBeUndefined();
    expect(host.destroyed).toBe(true);
  });

  it("rejects a commit that is not bound to the accepted bootstrap", async () => {
    const bootstrap = bootstrapDocument("executor");
    const commitValue = JSON.parse(
      commitDocument("executor", bootstrap).toString("utf8"),
    ) as Record<string, unknown>;
    commitValue.bootstrapSha256 = "0".repeat(64);
    const host = new HandshakeHost("executor", {
      bootstrap,
      commit: Buffer.from(serializeCanonicalJson(commitValue), "utf8"),
      fragments: 3,
    });

    await expect(
      performRuntimeBootstrapHandshake(
        host,
        "executor",
        createTestBootstrapPreparation("executor"),
        performance.now() + 1_000,
        () => host.installPromotedOwner(),
      ),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_COMMIT_INVALID" });
    expect(host.promoted).toBe(false);
    expect(host.destroyed).toBe(true);
  });

  it("uses one absolute deadline across ACK and commit", async () => {
    const host = new HandshakeHost("control", { commit: null });
    await expect(
      performRuntimeBootstrapHandshake(
        host,
        "control",
        createTestBootstrapPreparation("control"),
        performance.now() + 20,
        () => host.installPromotedOwner(),
      ),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_TIMEOUT" });
    expect(host.destroyed).toBe(true);
  });

  it("destroys a connected stream when the absolute deadline already expired", async () => {
    const host = new HandshakeHost("control");
    await expect(
      performRuntimeBootstrapHandshake(
        host,
        "control",
        createTestBootstrapPreparation("control"),
        performance.now() - 1,
        () => host.installPromotedOwner(),
      ),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_TIMEOUT" });
    expect(host.destroyed).toBe(true);
  });

  it("does not commit a retained completion capability when promotion fails", async () => {
    const host = new HandshakeHost("executor");
    let retained: Readonly<CompletedRuntimeBootstrap<"executor">> | undefined;
    await expect(
      performRuntimeBootstrapHandshake(
        host,
        "executor",
        createTestBootstrapPreparation("executor"),
        performance.now() + 1_000,
        (completed) => {
          retained = completed;
          throw new Error("promotion failed");
        },
      ),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_TRANSPORT_FAILED" });
    expect(retained).toBeDefined();
    expect(
      isCompletedRuntimeBootstrap(retained as Readonly<CompletedRuntimeBootstrap<"executor">>),
    ).toBe(false);
    expect(host.destroyed).toBe(true);
  });

  it("rejects an asynchronous promotion before releasing bootstrap stream ownership", async () => {
    const host = new HandshakeHost("control");
    let retained: Readonly<CompletedRuntimeBootstrap<"control">> | undefined;
    await expect(
      performRuntimeBootstrapHandshake(
        host,
        "control",
        createTestBootstrapPreparation("control"),
        performance.now() + 1_000,
        async (completed) => {
          retained = completed;
          await Promise.resolve();
          throw new Error("asynchronous promotion failed");
        },
      ),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_TRANSPORT_FAILED" });
    expect(retained).toBeDefined();
    expect(
      isCompletedRuntimeBootstrap(retained as Readonly<CompletedRuntimeBootstrap<"control">>),
    ).toBe(false);
    expect(host.destroyed).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it.each([
    {
      name: "Promise",
      create: () => Promise.reject(new Error("async installer failed")),
    },
    {
      name: "thenable",
      create: () => ({
        then: (_resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
          reject(new Error("thenable installer failed"));
        },
      }),
    },
  ])("rejects and observes an asynchronous $name runtime installer", async ({ create }) => {
    const host = new HandshakeHost("control");
    await expect(
      performRuntimeBootstrapHandshake(
        host,
        "control",
        createTestBootstrapPreparation("control", {
          installer: () => create() as unknown as RuntimeBootstrapArwxRuntimeOwner,
        }),
        performance.now() + 1_000,
        () => host.installPromotedOwner(),
      ),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_TRANSPORT_FAILED" });
    expect(host.destroyed).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("best-effort closes an owner returned by a fulfilled asynchronous installer", async () => {
    const host = new HandshakeHost("control");
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let closeCalls = 0;
    let lifecycleSignal: AbortSignal | undefined;
    const owner: RuntimeBootstrapArwxRuntimeOwner = {
      handler: () => undefined,
      done,
      close: async () => {
        closeCalls += 1;
        resolveDone();
      },
    };
    await expect(
      performRuntimeBootstrapHandshake(
        host,
        "control",
        createTestBootstrapPreparation("control", {
          installer: (activation) => {
            lifecycleSignal = activation.signal;
            return Promise.resolve(owner) as unknown as RuntimeBootstrapArwxRuntimeOwner;
          },
        }),
        performance.now() + 1_000,
        () => host.installPromotedOwner(),
      ),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_TRANSPORT_FAILED" });

    await waitFor(() => closeCalls === 1);
    expect(lifecycleSignal?.aborted).toBe(true);
    await done;
  });

  it("rolls back an installed runtime owner when activation changes the HostControl stream", async () => {
    const host = new HandshakeHost("executor");
    let lifecycleSignal: AbortSignal | undefined;
    let closeCalls = 0;
    await expect(
      performRuntimeBootstrapHandshake(
        host,
        "executor",
        createTestBootstrapPreparation("executor", {
          installer: (activation) => {
            lifecycleSignal = activation.signal;
            (activation.promotedOwner as HandshakeHost).destroy();
            return {
              handler: () => undefined,
              done: Promise.resolve(),
              close: async () => {
                closeCalls += 1;
              },
            };
          },
        }),
        performance.now() + 1_000,
        () => host.installPromotedOwner(),
      ),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_TRANSPORT_FAILED" });

    await waitFor(() => closeCalls === 1);
    expect(lifecycleSignal?.aborted).toBe(true);
  });

  it("fails closed when an ARWX business frame arrives before bootstrap commit", async () => {
    const host = new HandshakeHost("control", { commit: null });
    let dispatches = 0;
    const preparation = createTestBootstrapPreparation("control", {
      handler: () => {
        dispatches += 1;
      },
      onStarted: ({ input }) => {
        input.write(pingFrame());
      },
    });

    await expect(
      performRuntimeBootstrapHandshake(
        host,
        "control",
        preparation,
        performance.now() + 1_000,
        () => host.installPromotedOwner(),
      ),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_TRANSPORT_FAILED" });
    expect(dispatches).toBe(0);
    expect(host.promoted).toBe(false);
  });

  it("activates before a promotion-time first ARWX frame can dispatch", async () => {
    const host = new HandshakeHost("executor");
    let runtime: TestBootstrapArwxContext | undefined;
    let dispatches = 0;
    const promoted = await performRuntimeBootstrapHandshake(
      host,
      "executor",
      createTestBootstrapPreparation("executor", {
        handler: () => {
          dispatches += 1;
        },
        onStarted: (value) => {
          runtime = value;
        },
      }),
      performance.now() + 1_000,
      () => {
        runtime?.input.write(pingFrame());
        return host.installPromotedOwner();
      },
    );

    await waitFor(() => dispatches === 1);
    expect(promoted).toBe(host);
    terminateRuntimeBootstrapArwxDispatcher(
      defined(runtime, "runtime context").receiveLoop,
    );
    defined(runtime, "runtime context").arwx.abort();
    await defined(runtime, "runtime context").receiveLoop.done.catch(() => undefined);
    host.destroy();
  });

  it("rejects a dispatcher gate bound to another parsed bootstrap", async () => {
    const first = parseRuntimeBootstrap(bootstrapDocument("control"), "control");
    const second = parseRuntimeBootstrap(bootstrapDocument("control"), "control");
    const arwx = new ArwxStdioChannel({
      localRole: "control",
      input: new PassThrough(),
      output: new PassThrough(),
      maximumQueuedWriteBytes: first.bootstrap.arwx.maximumQueuedBytesPerDirection,
      closeTimeoutMs:
        first.bootstrap.shutdown.gracefulTimeoutMs -
        first.bootstrap.shutdown.forceTerminationReserveMs,
    });
    expect(() =>
      prepareRuntimeBootstrapArwxDispatcher("executor", first, arwx, () => runtimeOwner()),
    ).toThrowError(expect.objectContaining({ code: "BOOTSTRAP_INVALID" }));
    const dispatcherGate = prepareRuntimeBootstrapArwxDispatcher(
      "control",
      first,
      arwx,
      () => runtimeOwner(),
    );

    expect(() =>
      createRuntimeBootstrapReadyBoundary("control", second, arwx, dispatcherGate),
    ).toThrowError(expect.objectContaining({ code: "BOOTSTRAP_INVALID" }));
    expect(() =>
      createRuntimeBootstrapReadyBoundary("control", first, arwx, dispatcherGate),
    ).toThrowError(expect.objectContaining({ code: "BOOTSTRAP_INVALID" }));
    arwx.abort();
    await dispatcherGate.done.catch(() => undefined);
  });

  it("never activates a consumed dispatcher boundary a second time", async () => {
    let runtime: TestBootstrapArwxContext | undefined;
    let boundary: RuntimeBootstrapReadyBoundary<"control"> | undefined;
    let installations = 0;
    const createPreparation = createTestBootstrapPreparation("control", {
      onInstalled: () => {
        installations += 1;
      },
      onStarted: (value) => {
        runtime = value;
      },
    });
    const preparation: RuntimeBootstrapPreparation<"control"> = (parsed) => {
      boundary ??= createPreparation(parsed);
      return boundary;
    };
    const firstHost = new HandshakeHost("control");
    await performRuntimeBootstrapHandshake(
      firstHost,
      "control",
      preparation,
      performance.now() + 1_000,
      () => firstHost.installPromotedOwner(),
    );
    expect(installations).toBe(1);

    const secondHost = new HandshakeHost("control");
    await expect(
      performRuntimeBootstrapHandshake(
        secondHost,
        "control",
        preparation,
        performance.now() + 1_000,
        () => secondHost.installPromotedOwner(),
      ),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_INVALID" });
    expect(installations).toBe(1);

    const context = defined(runtime, "runtime context");
    terminateRuntimeBootstrapArwxDispatcher(context.receiveLoop);
    context.arwx.abort();
    await context.receiveLoop.done.catch(() => undefined);
    firstHost.destroy();
  });

  it("requires a genuine single-use role dispatcher gate", async () => {
    const parsed = parseRuntimeBootstrap(bootstrapDocument("control"), "control");
    const arwx = new ArwxStdioChannel({
      localRole: "control",
      input: new PassThrough(),
      output: new PassThrough(),
      maximumQueuedWriteBytes: parsed.bootstrap.arwx.maximumQueuedBytesPerDirection,
      closeTimeoutMs:
        parsed.bootstrap.shutdown.gracefulTimeoutMs -
        parsed.bootstrap.shutdown.forceTerminationReserveMs,
    });
    const dispatcherGate = prepareRuntimeBootstrapArwxDispatcher(
      "control",
      parsed,
      arwx,
      () => runtimeOwner(),
    );
    const boundary = createRuntimeBootstrapReadyBoundary(
      "control",
      parsed,
      arwx,
      dispatcherGate,
    );
    expect(boundary.role).toBe("control");
    expect(() =>
      createRuntimeBootstrapReadyBoundary("control", parsed, arwx, dispatcherGate),
    ).toThrowError(expect.objectContaining({ code: "BOOTSTRAP_INVALID" }));
    terminateRuntimeBootstrapArwxDispatcher(dispatcherGate);
    arwx.abort();
    await dispatcherGate.done.catch(() => undefined);
  });

  it("settles runtime completion when a dispatcher is terminated before activation", async () => {
    const parsed = parseRuntimeBootstrap(bootstrapDocument("executor"), "executor");
    const arwx = new ArwxStdioChannel({
      localRole: "executor",
      input: new PassThrough(),
      output: new PassThrough(),
      maximumQueuedWriteBytes: parsed.bootstrap.arwx.maximumQueuedBytesPerDirection,
      closeTimeoutMs:
        parsed.bootstrap.shutdown.gracefulTimeoutMs -
        parsed.bootstrap.shutdown.forceTerminationReserveMs,
    });
    const dispatcherGate = prepareRuntimeBootstrapArwxDispatcher(
      "executor",
      parsed,
      arwx,
      () => runtimeOwner(),
    );

    terminateRuntimeBootstrapArwxDispatcher(dispatcherGate);

    await expect(dispatcherGate.runtimeDone).resolves.toBeUndefined();
    arwx.abort();
    await dispatcherGate.done.catch(() => undefined);
    await expect(dispatcherGate.quiesced).resolves.toBeUndefined();
  });
});

function mutateBootstrap(
  role: "control" | "executor",
  mutate: (value: Record<string, unknown>) => void,
): Buffer {
  const value = JSON.parse(bootstrapDocument(role).toString("utf8")) as Record<string, unknown>;
  mutate(value);
  return Buffer.from(serializeCanonicalJson(value), "utf8");
}

function pingFrame(): Buffer {
  return encodeLocalFrame({
    minorVersion: 0,
    messageType: LocalMessageType.Ping,
    sequence: 1n,
    correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
    payload: {
      protocolMajor: 1,
      protocolMinor: 0,
      workerNodeId: "powertoys-node:01",
      workerInstanceId: "worker-instance:01",
      executorBootId: "00112233-4455-4677-8899-aabbccddeeff",
      sessionId: "fedcba98-7654-4210-aedc-ba9876543210",
      probeId: "8".repeat(64),
      sentAtUnixMs: 1_700_000_000_000,
    },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for runtime bootstrap test state.");
}

function defined<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`${description} is unavailable.`);
  return value;
}

function runtimeOwner(
  handler: RuntimeBootstrapArwxDispatcherHandler = () => undefined,
): RuntimeBootstrapArwxRuntimeOwner {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let closePromise: Promise<void> | undefined;
  return {
    handler,
    done,
    close(): Promise<void> {
      closePromise ??= Promise.resolve().then(resolveDone);
      return closePromise;
    },
  };
}
