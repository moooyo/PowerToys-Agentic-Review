import { Duplex, PassThrough } from "node:stream";
import {
  encodeLocalFrame,
  LOCAL_PROTOCOL_NIL_CORRELATION_ID,
  LocalMessageType,
  serializeCanonicalJson,
} from "@agentic-review/local-protocol";
import { describe, expect, it, vi } from "vitest";
import { commitPreparedArmArwxShutdown, prepareArmArwxShutdown } from "./arwx-shutdown.js";
import { ArwxStdioChannel } from "./arwx-stdio-channel.js";
import { encodeHostControlOpaqueJson } from "./opaque-json.js";
import { parseRuntimeBootstrap } from "./runtime-bootstrap.js";
import {
  bootstrapDocument,
  bootstrapTestAck,
  commitDocument,
  createTestBootstrapPreparation,
  drainedPayload,
  drainPayload,
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

  it("canonicalizes a stream failure during receive initialization", async () => {
    const host = new HandshakeHost("control");
    host.resume = (() => {
      throw new Error("initial resume failed");
    }) as typeof host.resume;
    const opening = performRuntimeBootstrapHandshake(
      host,
      "control",
      createTestBootstrapPreparation("control"),
      performance.now() + 1_000,
      () => host.installPromotedOwner(),
    );
    const observed = opening.then(
      () => ({ kind: "fulfilled" }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );

    const outcome = await observed;
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("Expected bootstrap rejection.");
    expect(outcome.error).toMatchObject({ code: "BOOTSTRAP_TRANSPORT_FAILED" });
    expect(host.destroyed).toBe(true);
  });

  it("preserves the canonical initialization failure across hostile cleanup hooks", async () => {
    const host = new HandshakeHost("control");
    const removals: string[] = [];
    let pauseCalls = 0;
    let destroyCalls = 0;
    let signalRemoveCalls = 0;
    host.on = ((eventName: string | symbol) => {
      if (eventName === "data") throw new Error("injected listener attachment failure");
      return host;
    }) as typeof host.on;
    host.pause = (() => {
      pauseCalls += 1;
      throw new Error("injected pause failure");
    }) as typeof host.pause;
    host.removeListener = ((eventName: string | symbol) => {
      removals.push(String(eventName));
      throw new Error("injected listener removal failure");
    }) as typeof host.removeListener;
    host.destroy = (() => {
      destroyCalls += 1;
      throw new Error("injected destroy failure");
    }) as typeof host.destroy;
    const signal = {
      aborted: false,
      addEventListener: () => undefined,
      dispatchEvent: () => false,
      onabort: null,
      reason: undefined,
      removeEventListener: () => {
        signalRemoveCalls += 1;
        throw new Error("injected signal removal failure");
      },
      throwIfAborted: () => undefined,
    } as AbortSignal;
    const opening = performRuntimeBootstrapHandshake(
      host,
      "control",
      createTestBootstrapPreparation("control"),
      performance.now() + 1_000,
      () => host.installPromotedOwner(),
      signal,
    );
    const observed = opening.then(
      () => ({ kind: "fulfilled" }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );

    const outcome = await observed;
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("Expected bootstrap rejection.");
    expect(outcome.error).toMatchObject({
      code: "BOOTSTRAP_TRANSPORT_FAILED",
      message: "Runtime bootstrap stream initialization failed.",
    });
    expect(pauseCalls).toBe(1);
    expect(signalRemoveCalls).toBe(1);
    expect(removals).toEqual(["data", "end", "error", "close"]);
    expect(destroyCalls).toBe(1);
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
        // biome-ignore lint/suspicious/noThenProperty: This fixture intentionally models a rejected thenable.
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
    terminateRuntimeBootstrapArwxDispatcher(defined(runtime, "runtime context").receiveLoop);
    defined(runtime, "runtime context").arwx.abort();
    await defined(runtime, "runtime context").receiveLoop.done.catch(() => undefined);
    host.destroy();
  });

  it("rolls back runtime activation when final stream promotion throws", async () => {
    const host = new HandshakeHost("control");
    const resume = host.resume.bind(host);
    host.resume = (() => {
      if (host.promoted) throw new Error("final promotion resume failed");
      return resume();
    }) as typeof host.resume;
    let lifecycleSignal: AbortSignal | undefined;
    let closeCalls = 0;

    await expect(
      performRuntimeBootstrapHandshake(
        host,
        "control",
        createTestBootstrapPreparation("control", {
          installer: (activation) => {
            lifecycleSignal = activation.signal;
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
    expect(host.destroyed).toBe(true);
  });

  it("rolls back runtime activation when final promotion synchronously ends the stream", async () => {
    const host = new HandshakeHost("control");
    const resume = host.resume.bind(host);
    host.resume = (() => {
      if (host.promoted) {
        host.destroy();
        return host;
      }
      return resume();
    }) as typeof host.resume;
    let lifecycleSignal: AbortSignal | undefined;
    let closeCalls = 0;

    await expect(
      performRuntimeBootstrapHandshake(
        host,
        "control",
        createTestBootstrapPreparation("control", {
          installer: (activation) => {
            lifecycleSignal = activation.signal;
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
    expect(host.destroyed).toBe(true);
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
    const dispatcherGate = prepareRuntimeBootstrapArwxDispatcher("control", first, arwx, () =>
      runtimeOwner(),
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
    const dispatcherGate = prepareRuntimeBootstrapArwxDispatcher("control", parsed, arwx, () =>
      runtimeOwner(),
    );
    const boundary = createRuntimeBootstrapReadyBoundary("control", parsed, arwx, dispatcherGate);
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
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const arwx = new ArwxStdioChannel({
      localRole: "executor",
      input,
      output,
      maximumQueuedWriteBytes: parsed.bootstrap.arwx.maximumQueuedBytesPerDirection,
      closeTimeoutMs:
        parsed.bootstrap.shutdown.gracefulTimeoutMs -
        parsed.bootstrap.shutdown.forceTerminationReserveMs,
    });
    const dispatcherGate = prepareRuntimeBootstrapArwxDispatcher("executor", parsed, arwx, () =>
      runtimeOwner(),
    );

    terminateRuntimeBootstrapArwxDispatcher(dispatcherGate);

    await expect(dispatcherGate.runtimeDone).resolves.toBeUndefined();
    await expect(dispatcherGate.terminal).resolves.toMatchObject({
      source: "arwx",
      outcome: "rejected",
      error: { code: "BOOTSTRAP_TRANSPORT_FAILED" },
    });
    arwx.abort();
    await dispatcherGate.done.catch(() => undefined);
    await expect(dispatcherGate.quiesced).resolves.toBeUndefined();
  });

  it("publishes clean ARWX completion for a prepared gate without a runtime", async () => {
    const parsed = parseRuntimeBootstrap(bootstrapDocument("control"), "control");
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const arwx = new ArwxStdioChannel({
      localRole: "control",
      input,
      output,
      maximumQueuedWriteBytes: parsed.bootstrap.arwx.maximumQueuedBytesPerDirection,
      closeTimeoutMs:
        parsed.bootstrap.shutdown.gracefulTimeoutMs -
        parsed.bootstrap.shutdown.forceTerminationReserveMs,
    });
    const dispatcherGate = prepareRuntimeBootstrapArwxDispatcher("control", parsed, arwx, () =>
      runtimeOwner(),
    );

    const draining = arwx.drain();
    input.end();

    await expect(dispatcherGate.done).resolves.toBeUndefined();
    await expect(draining).resolves.toBeUndefined();
    await expect(dispatcherGate.terminal).resolves.toEqual({
      source: "arwx",
      outcome: "fulfilled",
    });
  });

  it.each([
    { name: "Control rejection", role: "control" as const, outcome: "rejected" as const },
    { name: "Executor rejection", role: "executor" as const, outcome: "rejected" as const },
    { name: "pending runtime", role: "control" as const, outcome: "pending" as const },
    { name: "late runtime rejection", role: "control" as const, outcome: "late-rejected" as const },
    {
      name: "late runtime fulfillment",
      role: "executor" as const,
      outcome: "late-fulfilled" as const,
    },
  ])("keeps runtime authority after clean ARWX completion for $name", async ({ role, outcome }) => {
    const host = new HandshakeHost(role);
    const runtimeFailure = new Error(`${role} runtime failed after clean ARWX completion`);
    let resolveRuntime!: () => void;
    let rejectRuntime!: (error: unknown) => void;
    const runtimeDone = new Promise<void>((resolve, reject) => {
      resolveRuntime = resolve;
      rejectRuntime = reject;
    });
    runtimeDone.catch(() => undefined);
    let context: TestBootstrapArwxContext | undefined;
    let lifecycleSignal: AbortSignal | undefined;
    let shutdownDeadline = Number.NaN;
    await performRuntimeBootstrapHandshake(
      host,
      role,
      createTestBootstrapPreparation(role, {
        onStarted: (value) => {
          context = value;
        },
        installer: (activation) => {
          lifecycleSignal = activation.signal;
          return {
            done: runtimeDone,
            close: async () => undefined,
            handler: async (_message, dispatch) => {
              const receipt =
                role === "control"
                  ? dispatch.readFinalFrameReceipt()
                  : await dispatch.sendFinal(
                      {
                        messageType: LocalMessageType.Drained,
                        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
                        payload: drainedPayload(),
                      },
                      shutdownDeadline,
                    );
              return dispatch.createPostDispatchFinalFrameEffect(receipt, () => {
                const prepared = prepareArmArwxShutdown(
                  {
                    role: activation.role,
                    parsed: activation.parsed,
                    boundary: activation.boundary,
                  },
                  receipt,
                );
                commitPreparedArmArwxShutdown(prepared);
              });
            },
          };
        },
      }),
      performance.now() + 1_000,
      () => host.installPromotedOwner(),
    );
    const runtime = defined(context, "runtime context");
    runtime.output.resume();
    shutdownDeadline = performance.now() + (outcome === "pending" ? 500 : 1_000);
    if (role === "control") {
      await runtime.arwx.sendFinal(
        {
          messageType: LocalMessageType.Drain,
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          payload: drainPayload(),
        },
        shutdownDeadline,
      );
      runtime.input.end(shutdownFrame(LocalMessageType.Drained));
    } else {
      runtime.input.end(shutdownFrame(LocalMessageType.Drain));
    }

    await expect(runtime.receiveLoop.done).resolves.toBeUndefined();
    expect(lifecycleSignal?.aborted).toBe(false);
    if (outcome === "rejected") {
      let terminalSettled = false;
      void runtime.receiveLoop.terminal.then(() => {
        terminalSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(terminalSettled).toBe(false);
      rejectRuntime(runtimeFailure);
      await expect(runtime.receiveLoop.terminal).resolves.toEqual({
        source: "runtime",
        outcome: "rejected",
        error: runtimeFailure,
      });
    } else if (outcome === "pending") {
      await expect(runtime.receiveLoop.terminal).resolves.toMatchObject({
        source: "runtime",
        outcome: "rejected",
        error: {
          code: "BOOTSTRAP_TRANSPORT_FAILED",
          message: "Runtime did not settle before the ARWX shutdown deadline.",
        },
      });
      expect(lifecycleSignal?.aborted).toBe(true);
    } else {
      const now = vi.spyOn(performance, "now").mockReturnValue(shutdownDeadline);
      try {
        if (outcome === "late-rejected") rejectRuntime(runtimeFailure);
        else resolveRuntime();
        await expect(runtime.receiveLoop.terminal).resolves.toMatchObject({
          source: "runtime",
          outcome: "rejected",
          error: {
            code: "BOOTSTRAP_TRANSPORT_FAILED",
            message: "Runtime did not settle before the ARWX shutdown deadline.",
          },
        });
        expect(lifecycleSignal?.aborted).toBe(true);
      } finally {
        now.mockRestore();
      }
    }
    host.destroy();
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

function shutdownFrame(
  messageType: typeof LocalMessageType.Drain | typeof LocalMessageType.Drained,
): Buffer {
  return encodeLocalFrame({
    minorVersion: 0,
    messageType,
    sequence: 1n,
    correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
    payload: messageType === LocalMessageType.Drain ? drainPayload() : drainedPayload(),
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
