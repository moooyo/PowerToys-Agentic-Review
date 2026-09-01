import { Duplex, PassThrough, Writable } from "node:stream";
import {
  encodeLocalFrame,
  LOCAL_PROTOCOL_NIL_CORRELATION_ID,
  LocalMessageType,
  serializeCanonicalJson,
} from "@agentic-review/local-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  type ArmArwxShutdownResultV1,
  commitPreparedArmArwxShutdown,
  prepareArmArwxShutdown,
  readPreparedArmArwxShutdown,
} from "./arwx-shutdown.js";
import type { ArwxFinalFrameReceipt } from "./arwx-stdio-channel.js";
import type { HostControlSession } from "./host-control-session.js";
import {
  SERVICE_HOST_CONTROL_PIPE_PREFIX,
  type ServiceHostPayloadRole,
} from "./launch-contract.js";
import { openServiceHostRoleFoundation, runServiceHostRoleEntrypoint } from "./role-entrypoint.js";
import type { ParsedRuntimeBootstrapV1 } from "./runtime-bootstrap.js";
import {
  bootstrapDocument,
  drainedPayload,
  drainPayload,
  handleBootstrapTestWrite,
  installBootstrapTestHost,
} from "./runtime-bootstrap.test-helpers.js";
import {
  performRuntimeBootstrapHandshake,
  type CompletedRuntimeBootstrap,
  type RuntimeBootstrapArwxDispatcherHandler,
  type RuntimeBootstrapArwxRuntimeOwner,
  type RuntimeBootstrapPreparation,
} from "./runtime-bootstrap-handshake.js";

const pipe = `${SERVICE_HOST_CONTROL_PIPE_PREFIX}${"a".repeat(64)}`;
const argumentsFor = (role: "control" | "executor"): string[] => [
  `--service-role=${role}`,
  "--servicehost-arwx-stdio",
  `--servicehost-host-control-pipe=${pipe}`,
];

class FakeHostControlSession<TRole extends ServiceHostPayloadRole>
  implements HostControlSession<TRole>
{
  public closed = false;
  public closeCalls = 0;
  public drainCalls = 0;
  public readonly closeDeadlines: Array<number | undefined> = [];
  public readonly drainDeadlines: Array<number | undefined> = [];
  public closeError: Error | undefined;
  public drainError: Error | undefined;
  public drainRejectsUndefined = false;
  public drainHook: ((absoluteDeadline: number | undefined) => void) | undefined;
  public readonly done: Promise<void>;
  readonly #resolveDone: () => void;
  readonly #rejectDone: (error: unknown) => void;

  public constructor(
    public readonly role: TRole,
    public readonly bootstrap: Readonly<ParsedRuntimeBootstrapV1>,
  ) {
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;
    this.done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    this.done.catch(() => undefined);
    this.#resolveDone = resolveDone;
    this.#rejectDone = rejectDone;
  }

  public async drain(absoluteDeadline?: number): Promise<void> {
    this.drainCalls += 1;
    this.drainDeadlines.push(absoluteDeadline);
    if (this.drainRejectsUndefined) return await Promise.reject(undefined);
    if (this.drainError !== undefined) throw this.drainError;
    this.closed = true;
    this.#resolveDone();
    this.drainHook?.(absoluteDeadline);
  }

  public async close(absoluteDeadline?: number): Promise<void> {
    this.closeCalls += 1;
    this.closeDeadlines.push(absoluteDeadline);
    if (this.closeError !== undefined) throw this.closeError;
    this.closed = true;
    this.#resolveDone();
  }

  public fail(error: unknown): void {
    this.#rejectDone(error);
  }

  public async armArwxShutdown(
    _receipt: ArwxFinalFrameReceipt,
  ): Promise<Readonly<ArmArwxShutdownResultV1>> {
    throw new Error("Fake foundation does not arm ARWX shutdown.");
  }
}

class FakeControlHostControlSession extends FakeHostControlSession<"control"> {
  public readonly controlOnlyMarker = true;
}

class GracefulControlHostControlSession extends FakeHostControlSession<"control"> {
  public armCalls = 0;

  public constructor(private readonly completed: Readonly<CompletedRuntimeBootstrap<"control">>) {
    super("control", completed.parsed);
  }

  public override async armArwxShutdown(
    receipt: ArwxFinalFrameReceipt,
  ): Promise<Readonly<ArmArwxShutdownResultV1>> {
    this.armCalls += 1;
    const prepared = prepareArmArwxShutdown(this.completed, receipt);
    const { request } = readPreparedArmArwxShutdown(prepared);
    commitPreparedArmArwxShutdown(prepared);
    return Object.freeze({ armed: true, ...request });
  }
}

class GracefulExecutorHostControlSession extends FakeHostControlSession<"executor"> {
  public armCalls = 0;

  public constructor(private readonly completed: Readonly<CompletedRuntimeBootstrap<"executor">>) {
    super("executor", completed.parsed);
  }

  public override async armArwxShutdown(
    receipt: ArwxFinalFrameReceipt,
  ): Promise<Readonly<ArmArwxShutdownResultV1>> {
    this.armCalls += 1;
    const prepared = prepareArmArwxShutdown(this.completed, receipt);
    const { request } = readPreparedArmArwxShutdown(prepared);
    commitPreparedArmArwxShutdown(prepared);
    return Object.freeze({ armed: true, ...request });
  }
}

class DelayedGracefulArwxOutput extends Writable {
  #writeCallback: ((error?: Error | null) => void) | undefined;
  #finalCallback: ((error?: Error | null) => void) | undefined;
  #drainedWritten = false;

  public constructor(private readonly input: PassThrough) {
    super();
  }

  public get writePending(): boolean {
    return this.#writeCallback !== undefined;
  }

  public get finalPending(): boolean {
    return this.#finalCallback !== undefined;
  }

  public releaseWrite(): void {
    const callback = this.#writeCallback;
    if (callback === undefined) throw new Error("Expected a pending ARWX write callback.");
    this.#writeCallback = undefined;
    callback();
  }

  public writeDrained(): void {
    if (this.#drainedWritten) {
      throw new Error("Expected exactly one Drained write.");
    }
    this.#drainedWritten = true;
    this.input.write(drainedFrame(1n));
  }

  public endInput(): void {
    if (!this.#drainedWritten || this.input.writableEnded) {
      throw new Error("Expected one input EOF after writing Drained.");
    }
    this.input.end();
  }

  public releaseFinal(): void {
    const callback = this.#finalCallback;
    if (callback === undefined) throw new Error("Expected a pending ARWX final callback.");
    this.#finalCallback = undefined;
    callback();
  }

  public override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#writeCallback = callback;
  }

  public override _final(callback: (error?: Error | null) => void): void {
    this.#finalCallback = callback;
  }
}

class PrivateFieldRuntimeOwner implements RuntimeBootstrapArwxRuntimeOwner {
  readonly #resolveDone: () => void;
  readonly done: Promise<void>;
  #dispatches = 0;

  public constructor() {
    let resolveDone!: () => void;
    this.done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.#resolveDone = resolveDone;
  }

  public get dispatches(): number {
    return this.#dispatches;
  }

  public handler(): void {
    this.#dispatches += 1;
  }

  public async close(): Promise<void> {
    this.#resolveDone();
  }
}

class FakeBootstrapTransport extends Duplex {
  public constructor(
    role: ServiceHostPayloadRole,
    options: Parameters<typeof installBootstrapTestHost>[2] = 7,
  ) {
    super({ allowHalfOpen: false });
    installBootstrapTestHost(this, role, options);
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
}

class DelayedDestroyInput extends PassThrough {
  public destroyCompleted = false;

  public override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    setImmediate(() => {
      this.destroyCompleted = true;
      callback(error);
    });
  }
}

describe("ServiceHost role entrypoint", () => {
  it.each(["control", "executor"] as const)(
    "opens only the fixed %s transport foundation",
    async (role) => {
      let host: FakeHostControlSession<typeof role> | undefined;
      const input = new PassThrough();
      const output = new PassThrough();
      let connected = false;
      const foundation = await openServiceHostRoleFoundation(role, {
        platform: "win32",
        environment: { NODE_ENV: "production" },
        argumentsList: argumentsFor(role),
        input,
        output,
        connect: async (options) => {
          connected = true;
          expect(options.role).toBe(role);
          expect(options.pipe).toBe(pipe);
          expect(typeof options.prepareRuntimeBootstrap).toBe("function");
          host = await createFakeSession(
            options,
            undefined,
            (bootstrap) => new FakeHostControlSession(role, bootstrap),
          );
          return host;
        },
      });

      expect(connected).toBe(true);
      expect(foundation.launch.role).toBe(role);
      expect(foundation.arwx.localRole).toBe(role);
      await foundation.close();
      expect(host?.closed).toBe(true);
      expect(output.readableLength).toBe(0);
    },
  );

  it("preserves the concrete role-specific HostControl session type", async () => {
    let host: FakeControlHostControlSession | undefined;
    const foundation = await openServiceHostRoleFoundation("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      validateRuntimeSession: isFakeControlHostControlSession,
      installRuntime: (activation) => {
        expect(activation.hostControl.controlOnlyMarker).toBe(true);
        return runtimeOwner(() => undefined);
      },
      connect: async (options, signal) => {
        host = await createFakeSession(
          options,
          signal,
          (bootstrap) => new FakeControlHostControlSession("control", bootstrap),
        );
        return host;
      },
    });

    expect(foundation.hostControl.controlOnlyMarker).toBe(true);
    await foundation.close();
  });

  it("rejects runtime installation without an explicit promoted-session validator", async () => {
    let installCalls = 0;
    let promoted: FakeHostControlSession<"control"> | undefined;

    const failure = await openServiceHostRoleFoundation("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      installRuntime: () => {
        installCalls += 1;
        return runtimeOwner(() => undefined);
      },
      connect: async (options, signal) => {
        return await createFakeSession(options, signal, (bootstrap) => {
          promoted = new FakeHostControlSession("control", bootstrap);
          return promoted;
        });
      },
    }).catch((error: unknown) => error);

    expectPrimaryAndPriorAbort(failure, "BOOTSTRAP_TRANSPORT_FAILED");
    expect(installCalls).toBe(0);
    expect(promoted?.closeCalls).toBe(1);
  });

  it.each([
    {
      name: "rejected Promise",
      create: (failure: Error) => Promise.reject(failure),
    },
    {
      name: "rejected thenable",
      create: (failure: Error) => ({
        then: (_resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
          reject(failure);
        },
      }),
    },
    {
      name: "invalid object",
      create: (_failure: Error) => ({
        handler: () => undefined,
        done: {},
        close: async () => undefined,
      }),
    },
  ])("does not wrap a $name role runtime owner into valid activation", async ({ create }) => {
    const installerFailure = new Error("asynchronous installer failed");
    let activated: Promise<void> | undefined;
    let lifecycleSignal: AbortSignal | undefined;
    let promoted: FakeHostControlSession<"control"> | undefined;
    const failure = await openServiceHostRoleFoundation("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: (activation) => {
        activated = activation.activated;
        lifecycleSignal = activation.signal;
        return create(installerFailure) as unknown as RuntimeBootstrapArwxRuntimeOwner;
      },
      connect: async (options, signal) => {
        return await createFakeSession(options, signal, (bootstrap) => {
          promoted = new FakeHostControlSession("control", bootstrap);
          return promoted;
        });
      },
    }).catch((error: unknown) => error);

    const primary = failure instanceof AggregateError ? failure.errors[0] : failure;
    expect(primary).toMatchObject({ code: "BOOTSTRAP_TRANSPORT_FAILED" });
    if (activated === undefined) throw new Error("Runtime activation was not exposed.");
    await expect(activated).rejects.toMatchObject({ code: "BOOTSTRAP_TRANSPORT_FAILED" });
    expect(lifecycleSignal?.aborted).toBe(true);
    expect(promoted?.closeCalls).toBe(1);
  });

  it("installs one role-bound handler during promotion before dispatching the first frame", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let host: FakeHostControlSession<"executor"> | undefined;
    let installations = 0;
    let dispatches = 0;
    let lifecycleSignal: AbortSignal | undefined;
    let runtimeActivated: Promise<void> | undefined;
    const foundation = await openServiceHostRoleFoundation("executor", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("executor"),
      input,
      output,
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: (activation) => {
        installations += 1;
        expect(activation.role).toBe("executor");
        expect(activation.hostControl).toBe(host);
        expect(activation.bootstrap.bootstrap.role).toBe("executor");
        expect(activation.signal.aborted).toBe(false);
        runtimeActivated = activation.activated;
        return runtimeOwner((_message, _dispatch, signal) => {
          lifecycleSignal = signal;
          dispatches += 1;
        });
      },
      connect: async (options, signal) => {
        const transport = new FakeBootstrapTransport("executor");
        return await performRuntimeBootstrapHandshake(
          transport,
          "executor",
          options.prepareRuntimeBootstrap,
          performance.now() + 1_000,
          (completed) => {
            host = new FakeHostControlSession("executor", completed.parsed);
            input.write(pingFrame());
            return host;
          },
          signal,
        );
      },
    });

    await waitFor(() => dispatches === 1);
    expect(installations).toBe(1);
    expect(lifecycleSignal?.aborted).toBe(false);
    if (runtimeActivated === undefined) throw new Error("Runtime activation was not exposed.");
    await expect(runtimeActivated).resolves.toBeUndefined();
    await foundation.close();
    expect(lifecycleSignal?.aborted).toBe(true);
  });

  it("holds an early post-commit ARWX frame until full role activation", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const releaseConnector = createGate();
    let host: FakeHostControlSession<"control"> | undefined;
    let handshakeCompleted = false;
    let activated: Promise<void> | undefined;
    let dispatches = 0;
    const opening = openServiceHostRoleFoundation("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input,
      output,
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: (activation) => {
        activated = activation.activated;
        return runtimeOwner(() => {
          dispatches += 1;
        });
      },
      connect: async (options, signal) => {
        const transport = new FakeBootstrapTransport("control");
        const result = await performRuntimeBootstrapHandshake(
          transport,
          "control",
          options.prepareRuntimeBootstrap,
          performance.now() + 1_000,
          (completed) => {
            host = new FakeHostControlSession("control", completed.parsed);
            return host;
          },
          signal,
        );
        input.write(pingFrame());
        handshakeCompleted = true;
        await releaseConnector.promise;
        return result;
      },
    });

    await waitFor(() => handshakeCompleted && activated !== undefined);
    if (activated === undefined) throw new Error("Runtime activation was not exposed.");
    expect(await settlementByNextTurn(activated)).toBe("pending");
    expect(dispatches).toBe(0);

    releaseConnector.release();
    const foundation = await opening;
    await expect(activated).resolves.toBeUndefined();
    await waitFor(() => dispatches === 1);
    await foundation.close();
    expect(host?.closed).toBe(true);
  });

  it("preserves the runtime owner receiver for a private-field handler", async () => {
    const input = new PassThrough();
    const runtime = new PrivateFieldRuntimeOwner();
    const foundation = await openServiceHostRoleFoundation("executor", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("executor"),
      input,
      output: new PassThrough(),
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: () => runtime,
      connect: async (options, signal) =>
        await createFakeSession(
          options,
          signal,
          (bootstrap) => new FakeHostControlSession("executor", bootstrap),
        ),
    });

    input.write(pingFrame());
    await waitFor(() => runtime.dispatches === 1);
    await foundation.close();
  });

  it("lets a cooperative active handler return normally during cleanup", async () => {
    const input = new PassThrough();
    const bootstrap = bootstrapWithArwxCloseTimeout("control", 100);
    let handlerStarted = false;
    let lifecycleSignal: AbortSignal | undefined;
    const foundation = await openServiceHostRoleFoundation("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input,
      output: new PassThrough(),
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: () =>
        runtimeOwner((_message, _dispatch, signal) => {
          handlerStarted = true;
          lifecycleSignal = signal;
          return new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }),
      connect: async (options, signal) => {
        const transport = new FakeBootstrapTransport("control", { bootstrap });
        return await performRuntimeBootstrapHandshake(
          transport,
          "control",
          options.prepareRuntimeBootstrap,
          performance.now() + 1_000,
          (completed) => new FakeHostControlSession("control", completed.parsed),
          signal,
        );
      },
    });
    input.write(pingFrame());
    await waitFor(() => handlerStarted);

    await expect(foundation.close()).resolves.toBeUndefined();
    expect(lifecycleSignal?.aborted).toBe(true);
  });

  it("keeps the dispatcher live while the runtime performs graceful close choreography", async () => {
    const input = new PassThrough();
    let resolveRuntimeDone!: () => void;
    const runtimeDone = new Promise<void>((resolve) => {
      resolveRuntimeDone = resolve;
    });
    let resolveDispatch!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      resolveDispatch = resolve;
    });
    let dispatches = 0;
    let lifecycleSignal: AbortSignal | undefined;
    const foundation = await openServiceHostRoleFoundation("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input,
      output: new PassThrough(),
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: (activation) => {
        lifecycleSignal = activation.signal;
        return {
          handler: () => {
            dispatches += 1;
            resolveDispatch();
          },
          done: runtimeDone,
          close: async () => {
            expect(activation.signal.aborted).toBe(false);
            input.write(pingFrame());
            await dispatched;
            resolveRuntimeDone();
          },
        };
      },
      connect: async (options, signal) =>
        await createFakeSession(
          options,
          signal,
          (bootstrap) => new FakeHostControlSession("control", bootstrap),
        ),
    });

    await expect(foundation.close()).resolves.toBeUndefined();
    expect(dispatches).toBe(1);
    expect(lifecycleSignal?.aborted).toBe(true);
  });

  it("accepts early Drained and input EOF but waits for both raw output callbacks", async () => {
    const { foundation, input, output, readHost } = await openDelayedControlShutdownFixture();

    const closing = foundation.close();
    await waitFor(() => output.writePending);
    output.writeDrained();
    output.endInput();

    expect(input.writableEnded).toBe(true);
    expect(readHost().armCalls).toBe(0);
    expect(output.finalPending).toBe(false);
    expect(await settlementByNextTurn(closing)).toBe("pending");
    output.releaseWrite();
    await waitFor(() => readHost().armCalls === 1 && output.finalPending && input.readableEnded);
    expect(await settlementByNextTurn(closing)).toBe("pending");
    output.releaseFinal();

    await expect(closing).resolves.toBeUndefined();
    expect(input.readableEnded).toBe(true);
    expect(output.writableFinished).toBe(true);
    expect(readHost().drainCalls).toBe(1);
  });

  it("waits for Control input EOF after the output final callback completes", async () => {
    const { foundation, input, output, readHost } = await openDelayedControlShutdownFixture();

    const closing = foundation.close();
    await waitFor(() => output.writePending);
    output.releaseWrite();
    output.writeDrained();
    await waitFor(() => readHost().armCalls === 1 && output.finalPending);
    output.releaseFinal();
    await waitFor(() => output.writableFinished);

    expect(await settlementByNextTurn(closing)).toBe("pending");
    expect(input.readableEnded).toBe(false);
    output.endInput();

    await expect(closing).resolves.toBeUndefined();
    expect(input.readableEnded).toBe(true);
    expect(readHost().drainCalls).toBe(1);
  });

  it("supports crossed-ARWX shutdown compatibility between paired foundations", async () => {
    const controlToExecutor = new PassThrough();
    const executorToControl = new PassThrough();
    let controlHost: GracefulControlHostControlSession | undefined;
    let executorHost: GracefulExecutorHostControlSession | undefined;

    const controlOpening = openServiceHostRoleFoundation("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: executorToControl,
      output: controlToExecutor,
      validateRuntimeSession: isGracefulControlHostControlSession,
      installRuntime: (activation) => {
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        return {
          handler: (message, dispatch) => {
            expect(message.messageType).toBe(LocalMessageType.Drained);
            const receipt = dispatch.readFinalFrameReceipt();
            return dispatch.createPostDispatchFinalFrameEffect(receipt, async () => {
              await activation.hostControl.armArwxShutdown(receipt);
              resolveDone();
            });
          },
          done,
          close: async (absoluteDeadline) => {
            if (absoluteDeadline === undefined) {
              throw new Error("Expected the Control shutdown deadline.");
            }
            await activation.arwx.sendFinal(
              {
                messageType: LocalMessageType.Drain,
                correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
                payload: drainPayload(),
              },
              absoluteDeadline,
            );
          },
        };
      },
      connect: async (options, signal) => {
        const transport = new FakeBootstrapTransport("control");
        return await performRuntimeBootstrapHandshake(
          transport,
          "control",
          options.prepareRuntimeBootstrap,
          performance.now() + 1_000,
          (completed) => {
            controlHost = new GracefulControlHostControlSession(completed);
            return controlHost;
          },
          signal,
        );
      },
    });

    const executorOpening = openServiceHostRoleFoundation("executor", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("executor"),
      input: controlToExecutor,
      output: executorToControl,
      validateRuntimeSession: isGracefulExecutorHostControlSession,
      installRuntime: (activation) => {
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        return {
          handler: async (message, dispatch) => {
            expect(message.messageType).toBe(LocalMessageType.Drain);
            const receipt = await dispatch.sendFinal(
              {
                messageType: LocalMessageType.Drained,
                correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
                payload: drainedPayload(),
              },
              performance.now() + activation.arwx.configuredCloseTimeoutMs,
            );
            return dispatch.createPostDispatchFinalFrameEffect(receipt, async () => {
              await activation.hostControl.armArwxShutdown(receipt);
              resolveDone();
            });
          },
          done,
          close: async () => undefined,
        };
      },
      connect: async (options, signal) => {
        const transport = new FakeBootstrapTransport("executor");
        return await performRuntimeBootstrapHandshake(
          transport,
          "executor",
          options.prepareRuntimeBootstrap,
          performance.now() + 1_000,
          (completed) => {
            executorHost = new GracefulExecutorHostControlSession(completed);
            return executorHost;
          },
          signal,
        );
      },
    });

    const [controlFoundation, executorFoundation] = await Promise.all([
      controlOpening,
      executorOpening,
    ]);
    await expect(
      Promise.all([controlFoundation.close(), executorFoundation.close()]),
    ).resolves.toEqual([undefined, undefined]);

    expect(controlFoundation.arwx.state).toBe("closed");
    expect(executorFoundation.arwx.state).toBe("closed");
    expect(controlHost?.armCalls).toBe(1);
    expect(executorHost?.armCalls).toBe(1);
  });

  it("does not let a pending handler block ARWX terminal failure", async () => {
    const input = new PassThrough();
    const handlerGate = createGate();
    let handlerStarted = false;
    let lifecycleSignal: AbortSignal | undefined;
    const foundation = await openServiceHostRoleFoundation("executor", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("executor"),
      input,
      output: new PassThrough(),
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: () =>
        runtimeOwner((_message, _dispatch, signal) => {
          handlerStarted = true;
          lifecycleSignal = signal;
          return handlerGate.promise;
        }),
      connect: async (options, signal) =>
        await createFakeSession(
          options,
          signal,
          (bootstrap) => new FakeHostControlSession("executor", bootstrap),
        ),
    });
    input.write(pingFrame());
    await waitFor(() => handlerStarted);

    input.destroy(new Error("ARWX input failed"));
    await expect(foundation.done).resolves.toMatchObject({
      source: "arwx",
      outcome: "rejected",
      error: { code: "INPUT_FAILED" },
    });
    expect(lifecycleSignal?.aborted).toBe(true);
    const closing = foundation.close();
    expect(await settlementByNextTurn(closing)).toBe("pending");
    handlerGate.release();
    await expect(closing).rejects.toMatchObject({ code: "INPUT_FAILED" });
  });

  it("bounds cleanup when a zero-message runtime owner ignores close", async () => {
    const bootstrap = bootstrapWithArwxCloseTimeout("control", 10);
    let lifecycleSignal: AbortSignal | undefined;
    const never = new Promise<void>(() => undefined);
    const foundation = await openServiceHostRoleFoundation("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: (activation) => {
        lifecycleSignal = activation.signal;
        return { handler: () => undefined, done: never, close: () => never };
      },
      connect: async (options, signal) => {
        const transport = new FakeBootstrapTransport("control", { bootstrap });
        return await performRuntimeBootstrapHandshake(
          transport,
          "control",
          options.prepareRuntimeBootstrap,
          performance.now() + 1_000,
          (completed) => new FakeHostControlSession("control", completed.parsed),
          signal,
        );
      },
    });

    await expect(foundation.close()).rejects.toMatchObject({
      code: "ROLE_RUNTIME_SHUTDOWN_TIMEOUT",
    });
    expect(lifecycleSignal?.aborted).toBe(true);
  });

  it("revokes immediately on runtime close failure and still bounds pending completion", async () => {
    const closeFailure = new Error("runtime close failed");
    const never = new Promise<void>(() => undefined);
    const bootstrap = bootstrapWithArwxCloseTimeout("control", 50);
    let lifecycleSignal: AbortSignal | undefined;
    const foundation = await openServiceHostRoleFoundation("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: (activation) => {
        lifecycleSignal = activation.signal;
        return {
          handler: () => undefined,
          done: never,
          close: async () => {
            throw closeFailure;
          },
        };
      },
      connect: async (options, signal) => {
        const transport = new FakeBootstrapTransport("control", { bootstrap });
        return await performRuntimeBootstrapHandshake(
          transport,
          "control",
          options.prepareRuntimeBootstrap,
          performance.now() + 1_000,
          (completed) => new FakeHostControlSession("control", completed.parsed),
          signal,
        );
      },
    });

    const closing = foundation.close();
    await waitFor(() => lifecycleSignal?.aborted === true);
    expect(foundation.arwx.state).toBe("failed");
    expect(await settlementByNextTurn(closing)).toBe("pending");
    const failure = await closing.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(closeFailure);
    expect((failure as AggregateError).errors[1]).toMatchObject({
      code: "ROLE_RUNTIME_SHUTDOWN_TIMEOUT",
    });
    expect((failure as AggregateError).errors).toHaveLength(2);
  });

  it("publishes runtime failure but still joins its delayed close", async () => {
    const runtimeFailure = new Error("registration failed");
    let rejectRuntime!: (error: unknown) => void;
    const runtimeDone = new Promise<void>((_resolve, reject) => {
      rejectRuntime = reject;
    });
    let releaseClose!: () => void;
    const delayedClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeCalls = 0;
    const foundation = await openServiceHostRoleFoundation("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: () => ({
        handler: () => undefined,
        done: runtimeDone,
        close: () => {
          closeCalls += 1;
          return delayedClose;
        },
      }),
      connect: async (options, signal) =>
        await createFakeSession(
          options,
          signal,
          (bootstrap) => new FakeHostControlSession("control", bootstrap),
        ),
    });

    rejectRuntime(runtimeFailure);
    await expect(foundation.done).resolves.toEqual({
      source: "runtime",
      outcome: "rejected",
      error: runtimeFailure,
    });
    const closing = foundation.close();
    let closeSettled = false;
    void closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    await waitFor(() => closeCalls === 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);
    releaseClose();
    await expect(closing).rejects.toBe(runtimeFailure);
    expect(closeCalls).toBe(1);
  });

  it("preserves runtime failure when its close never settles before the bound", async () => {
    const runtimeFailure = new Error("runtime completion failed");
    let rejectRuntime!: (error: unknown) => void;
    const runtimeDone = new Promise<void>((_resolve, reject) => {
      rejectRuntime = reject;
    });
    const never = new Promise<void>(() => undefined);
    const bootstrap = bootstrapWithArwxCloseTimeout("control", 50);
    let runtimeInstalled = false;
    const running = runServiceHostRoleEntrypoint("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: () => {
        runtimeInstalled = true;
        return { handler: () => undefined, done: runtimeDone, close: () => never };
      },
      connect: async (options, signal) => {
        const transport = new FakeBootstrapTransport("control", { bootstrap });
        return await performRuntimeBootstrapHandshake(
          transport,
          "control",
          options.prepareRuntimeBootstrap,
          performance.now() + 1_000,
          (completed) => new FakeHostControlSession("control", completed.parsed),
          signal,
        );
      },
    });
    await waitFor(() => runtimeInstalled);

    rejectRuntime(runtimeFailure);
    const failure = await running.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(runtimeFailure);
    expect((failure as AggregateError).errors[1]).toMatchObject({
      code: "ROLE_RUNTIME_SHUTDOWN_TIMEOUT",
    });
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect((failure as AggregateError).cause).toBe(runtimeFailure);
  });

  it("passes one absolute graceful deadline through runtime and HostControl cleanup", async () => {
    const drainFailure = new Error("force close after drain");
    let runtimeDeadline: number | undefined;
    let host: FakeHostControlSession<"control"> | undefined;
    const foundation = await openServiceHostRoleFoundation("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: () => {
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        return {
          handler: () => undefined,
          done,
          close: async (absoluteDeadline) => {
            runtimeDeadline = absoluteDeadline;
            resolveDone();
          },
        };
      },
      connect: async (options, signal) => {
        host = await createFakeSession(
          options,
          signal,
          (bootstrap) => new FakeHostControlSession("control", bootstrap),
        );
        host.drainError = drainFailure;
        return host;
      },
    });

    await expect(foundation.close()).rejects.toBe(drainFailure);
    expect(runtimeDeadline).toBeDefined();
    expect(host?.drainDeadlines).toEqual([runtimeDeadline]);
    expect(host?.closeDeadlines).toEqual([runtimeDeadline]);
  });

  it("rejects fulfilled cleanup work resumed after the absolute deadline", async () => {
    let host: FakeHostControlSession<"control"> | undefined;
    const now = vi.spyOn(performance, "now");
    const foundation = await openServiceHostRoleFoundation("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      connect: async (options, signal) => {
        host = await createFakeSession(
          options,
          signal,
          (bootstrap) => new FakeHostControlSession("control", bootstrap),
        );
        host.drainHook = (absoluteDeadline) => {
          if (absoluteDeadline !== undefined) now.mockReturnValue(absoluteDeadline + 1);
        };
        return host;
      },
    });

    try {
      await expect(foundation.close()).rejects.toMatchObject({
        code: "ROLE_RUNTIME_SHUTDOWN_TIMEOUT",
      });
      expect(host?.closeCalls).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  it("rejects a connector that replaces the exact promoted HostControl owner", async () => {
    let promoted: FakeHostControlSession<"control"> | undefined;
    let replacement: FakeHostControlSession<"control"> | undefined;
    let activated: Promise<void> | undefined;
    let runtimeStarted = false;
    await expect(
      openServiceHostRoleFoundation("control", {
        platform: "win32",
        environment: { NODE_ENV: "production" },
        argumentsList: argumentsFor("control"),
        input: new PassThrough(),
        output: new PassThrough(),
        validateRuntimeSession: isFakeHostControlSession,
        installRuntime: (activation) => {
          activated = activation.activated;
          void activation.activated.then(
            () => {
              runtimeStarted = true;
            },
            () => undefined,
          );
          return runtimeOwner(() => undefined);
        },
        connect: async (options, signal) => {
          const exact = await createFakeSession(
            options,
            signal,
            (bootstrap) => new FakeHostControlSession("control", bootstrap),
          );
          promoted = exact;
          replacement = new FakeHostControlSession("control", exact.bootstrap);
          return replacement;
        },
      }),
    ).rejects.toMatchObject({ code: "ARWX_STDIO_INVALID" });

    if (activated === undefined) throw new Error("Runtime activation was not exposed.");
    await expect(activated).rejects.toMatchObject({ code: "ARWX_STDIO_INVALID" });
    expect(runtimeStarted).toBe(false);
    expect(promoted?.closeCalls).toBe(1);
    expect(replacement?.closeCalls).toBe(1);
  });

  it("revokes installer lifecycle and closes the promoted owner when installation throws", async () => {
    let lifecycleSignal: AbortSignal | undefined;
    let promoted: FakeHostControlSession<"executor"> | undefined;
    const failure = await openServiceHostRoleFoundation("executor", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("executor"),
      input: new PassThrough(),
      output: new PassThrough(),
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: (activation) => {
        lifecycleSignal = activation.signal;
        throw new Error("partial runtime installation failed");
      },
      connect: async (options, signal) => {
        const transport = new FakeBootstrapTransport("executor");
        return await performRuntimeBootstrapHandshake(
          transport,
          "executor",
          options.prepareRuntimeBootstrap,
          performance.now() + 1_000,
          (completed) => {
            promoted = new FakeHostControlSession("executor", completed.parsed);
            return promoted;
          },
          signal,
        );
      },
    }).catch((error: unknown) => error);

    expectPrimaryAndPriorAbort(failure, "BOOTSTRAP_TRANSPORT_FAILED");
    expect(lifecycleSignal?.aborted).toBe(true);
    expect(promoted?.closeCalls).toBe(1);
  });

  it("rejects full runtime activation when final HostControl promotion resume throws", async () => {
    let activated: Promise<void> | undefined;
    let runtimeStarted = false;
    let promoted: FakeHostControlSession<"control"> | undefined;
    const failure = await openServiceHostRoleFoundation("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: (activation) => {
        activated = activation.activated;
        void activation.activated.then(
          () => {
            runtimeStarted = true;
          },
          () => undefined,
        );
        return runtimeOwner(() => undefined);
      },
      connect: async (options, signal) => {
        const transport = new FakeBootstrapTransport("control");
        const resume = transport.resume.bind(transport);
        let resumeCalls = 0;
        transport.resume = (() => {
          resumeCalls += 1;
          if (resumeCalls === 2) throw new Error("final promotion resume failed");
          return resume();
        }) as typeof transport.resume;
        return await performRuntimeBootstrapHandshake(
          transport,
          "control",
          options.prepareRuntimeBootstrap,
          performance.now() + 1_000,
          (completed) => {
            promoted = new FakeHostControlSession("control", completed.parsed);
            return promoted;
          },
          signal,
        );
      },
    }).catch((error: unknown) => error);

    const primary = failure instanceof AggregateError ? failure.errors[0] : failure;
    expect(primary).toMatchObject({ code: "BOOTSTRAP_TRANSPORT_FAILED" });
    if (activated === undefined) throw new Error("Runtime activation was not exposed.");
    await expect(activated).rejects.toMatchObject({ code: "BOOTSTRAP_TRANSPORT_FAILED" });
    expect(runtimeStarted).toBe(false);
    expect(promoted?.closeCalls).toBe(1);
  });

  it.each([
    {
      name: "non-Windows platform",
      platform: "linux" as NodeJS.Platform,
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
    },
    {
      name: "non-production environment",
      platform: "win32" as NodeJS.Platform,
      environment: { NODE_ENV: "development" },
      argumentsList: argumentsFor("control"),
    },
    {
      name: "role mismatch",
      platform: "win32" as NodeJS.Platform,
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("executor"),
    },
  ])("fails before connection for $name", async ({ platform, environment, argumentsList }) => {
    let connected = false;
    await expect(
      openServiceHostRoleFoundation("control", {
        platform,
        environment,
        argumentsList,
        input: new PassThrough(),
        output: new PassThrough(),
        connect: async () => {
          connected = true;
          throw new Error("connection should not be reached");
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(connected).toBe(false);
  });

  it("holds a committed zero-execution foundation until cancellation", async () => {
    const controller = new AbortController();
    let host: FakeHostControlSession<"control"> | undefined;
    const running = runServiceHostRoleEntrypoint("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      signal: controller.signal,
      connect: async (options, signal) => {
        host = await createFakeSession(
          options,
          signal,
          (bootstrap) => new FakeHostControlSession("control", bootstrap),
        );
        return host;
      },
    });
    await waitFor(() => host !== undefined);
    let settled = false;
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    controller.abort();
    await expect(running).resolves.toBeUndefined();
    expect(host?.closed).toBe(true);
  });

  it("returns success for a pre-aborted external signal after a connector completes", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    let host: FakeHostControlSession<"control"> | undefined;
    const running = runServiceHostRoleEntrypoint("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      signal: controller.signal,
      connect: async (options) => {
        host = await createFakeSession(
          options,
          undefined,
          (bootstrap) => new FakeHostControlSession("control", bootstrap),
        );
        return host;
      },
    });

    await expect(running).resolves.toBeUndefined();
    expect(host?.closed).toBe(true);
  });

  it("returns success after an installed runtime completes orderly", async () => {
    let resolveRuntime!: () => void;
    const runtimeDone = new Promise<void>((resolve) => {
      resolveRuntime = resolve;
    });
    let runtimeInstalled = false;
    let runtimeCloseCalls = 0;
    let host: FakeHostControlSession<"executor"> | undefined;
    const running = runServiceHostRoleEntrypoint("executor", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("executor"),
      input: new PassThrough(),
      output: new PassThrough(),
      validateRuntimeSession: isFakeHostControlSession,
      installRuntime: () => {
        runtimeInstalled = true;
        return {
          handler: () => undefined,
          done: runtimeDone,
          close: async () => {
            runtimeCloseCalls += 1;
          },
        };
      },
      connect: async (options, signal) => {
        host = await createFakeSession(
          options,
          signal,
          (bootstrap) => new FakeHostControlSession("executor", bootstrap),
        );
        return host;
      },
    });
    await waitFor(() => runtimeInstalled);

    resolveRuntime();
    await expect(running).resolves.toBeUndefined();
    expect(runtimeCloseCalls).toBe(1);
    expect(host?.closed).toBe(true);
  });

  it("preserves the runtime primary error and aggregates every cleanup failure", async () => {
    const primary = Object.assign(new Error("runtime primary"), { code: "PROTOCOL_FAILURE" });
    const drainFailure = new Error("drain cleanup failed");
    const closeFailure = new Error("close cleanup failed");
    let host: FakeHostControlSession<"control"> | undefined;
    const running = runServiceHostRoleEntrypoint("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      connect: async (options, signal) => {
        host = await createFakeSession(
          options,
          signal,
          (bootstrap) => new FakeHostControlSession("control", bootstrap),
        );
        host.drainError = drainFailure;
        host.closeError = closeFailure;
        return host;
      },
    });
    await waitFor(() => host !== undefined);
    host?.fail(primary);

    const failure = await running.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([primary, drainFailure, closeFailure]);
    expect((failure as AggregateError).cause).toBe(primary);
    expect(host?.drainCalls).toBe(1);
    expect(host?.closeCalls).toBe(1);
  });

  it("preserves an undefined cleanup rejection instead of treating it as success", async () => {
    const controller = new AbortController();
    let host: FakeHostControlSession<"control"> | undefined;
    const running = runServiceHostRoleEntrypoint("control", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("control"),
      input: new PassThrough(),
      output: new PassThrough(),
      signal: controller.signal,
      connect: async (options, signal) => {
        host = await createFakeSession(
          options,
          signal,
          (bootstrap) => new FakeHostControlSession("control", bootstrap),
        );
        host.drainRejectsUndefined = true;
        return host;
      },
    });
    await waitFor(() => host !== undefined);
    controller.abort();

    const settled = await running.then(
      () => ({ outcome: "fulfilled" }) as const,
      (error: unknown) => ({ outcome: "rejected", error }) as const,
    );
    expect(settled).toEqual({ outcome: "rejected", error: undefined });
  });

  it("retains and settles the first ARWX owner when bootstrap preparation fails", async () => {
    const role = "control" as const;
    const input = new DelayedDestroyInput();
    let preparedBootstrap: Readonly<ParsedRuntimeBootstrapV1> | undefined;
    let secondPreparationFailure: unknown;

    await expect(
      openServiceHostRoleFoundation(role, {
        platform: "win32",
        environment: { NODE_ENV: "production" },
        argumentsList: argumentsFor(role),
        input,
        output: new PassThrough(),
        connect: async (options, signal) => {
          const transport = new FakeBootstrapTransport(role, {
            bootstrap: bootstrapDocument(role),
            commit: null,
            fragments: 5,
          });
          try {
            return await performRuntimeBootstrapHandshake(
              transport,
              role,
              (parsed) => {
                preparedBootstrap = parsed;
                options.prepareRuntimeBootstrap(parsed);
                throw new Error("Injected failure after ARWX owner preparation.");
              },
              performance.now() + 1_000,
              (completed) => new FakeHostControlSession(role, completed.parsed),
              signal,
            );
          } catch (error) {
            const prepared = preparedBootstrap;
            if (prepared !== undefined) {
              try {
                options.prepareRuntimeBootstrap(prepared);
              } catch (secondError) {
                secondPreparationFailure = secondError;
              }
            }
            throw error;
          }
        },
      }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_INVALID" });

    expect(secondPreparationFailure).toMatchObject({ code: "RUNTIME_BOOTSTRAP_UNAVAILABLE" });
    expect(input.destroyCompleted).toBe(true);
  });

  it("leaves HostControl cleanup with the foundation owner after the receive loop fails", async () => {
    const input = new PassThrough();
    let host: FakeHostControlSession<"executor"> | undefined;
    const foundation = await openServiceHostRoleFoundation("executor", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("executor"),
      input,
      output: new PassThrough(),
      connect: async (options, signal) => {
        host = await createFakeSession(
          options,
          signal,
          (bootstrap) => new FakeHostControlSession("executor", bootstrap),
        );
        return host;
      },
    });
    const drainOwner = vi.spyOn(foundation.arwx, "drain");

    input.end(Buffer.from([1, 0, 0]));
    await expect(foundation.done).resolves.toMatchObject({
      source: "arwx",
      outcome: "rejected",
      error: { code: "FRAME_INVALID" },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(host?.drainCalls).toBe(0);
    expect(host?.closeCalls).toBe(0);

    await expect(foundation.close()).rejects.toMatchObject({ code: "FRAME_INVALID" });
    expect(host?.drainCalls).toBe(1);
    expect(drainOwner).toHaveBeenCalledOnce();
  });

  it("preserves an ARWX abort that predates foundation cleanup by exact identity", async () => {
    const foundation = await openServiceHostRoleFoundation("executor", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("executor"),
      input: new PassThrough(),
      output: new PassThrough(),
      connect: async (options, signal) =>
        await createFakeSession(
          options,
          signal,
          (bootstrap) => new FakeHostControlSession("executor", bootstrap),
        ),
    });

    const priorAbort = foundation.arwx.abort();
    expect(priorAbort).toBeDefined();
    await expect(foundation.done).resolves.toMatchObject({
      source: "arwx",
      outcome: "rejected",
      error: priorAbort,
    });
    await expect(foundation.close()).rejects.toBe(priorAbort);
  });

  it("bridges startup cancellation without forwarding its original reason", async () => {
    const controller = new AbortController();
    let connectorSignal: AbortSignal | undefined;
    const opening = openServiceHostRoleFoundation("executor", {
      platform: "win32",
      environment: { NODE_ENV: "production" },
      argumentsList: argumentsFor("executor"),
      input: new PassThrough(),
      output: new PassThrough(),
      signal: controller.signal,
      connect: async (_options, signal) => {
        connectorSignal = signal;
        return await new Promise<HostControlSession<"executor">>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    });
    await waitFor(() => connectorSignal !== undefined);
    controller.abort(new Error("leaseToken=must-not-cross"));

    await expect(opening).rejects.toThrow("cancelled");
    expect(connectorSignal?.aborted).toBe(true);
    expect(String(connectorSignal?.reason)).not.toContain("must-not-cross");
  });

  it.each(["end", "close"] as const)(
    "cancels a pending HostControl connection when ARWX input emits %s",
    async (event) => {
      const input = new PassThrough();
      let connectorSignal: AbortSignal | undefined;
      const opening = openServiceHostRoleFoundation("executor", {
        platform: "win32",
        environment: { NODE_ENV: "production" },
        argumentsList: argumentsFor("executor"),
        input,
        output: new PassThrough(),
        connect: async (_options, signal) => {
          connectorSignal = signal;
          return await new Promise<HostControlSession<"executor">>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
              once: true,
            });
          });
        },
      });
      await waitFor(() => connectorSignal !== undefined);
      if (event === "end") input.end();
      else input.destroy();

      await expect(opening).rejects.toThrow("cancelled");
      expect(connectorSignal?.aborted).toBe(true);
    },
  );
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for startup state.");
}

async function openDelayedControlShutdownFixture() {
  const input = new PassThrough();
  const output = new DelayedGracefulArwxOutput(input);
  let host: GracefulControlHostControlSession | undefined;
  const foundation = await openServiceHostRoleFoundation("control", {
    platform: "win32",
    environment: { NODE_ENV: "production" },
    argumentsList: argumentsFor("control"),
    input,
    output,
    validateRuntimeSession: isGracefulControlHostControlSession,
    installRuntime: (activation) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      return {
        handler: (message, dispatch) => {
          expect(message.messageType).toBe(LocalMessageType.Drained);
          const receipt = dispatch.readFinalFrameReceipt();
          return dispatch.createPostDispatchFinalFrameEffect(receipt, async () => {
            await activation.hostControl.armArwxShutdown(receipt);
            resolveDone();
          });
        },
        done,
        close: async (absoluteDeadline) => {
          if (absoluteDeadline === undefined) {
            throw new Error("Expected the shared graceful shutdown deadline.");
          }
          await activation.arwx.sendFinal(
            {
              messageType: LocalMessageType.Drain,
              correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
              payload: drainPayload(),
            },
            absoluteDeadline,
          );
        },
      };
    },
    connect: async (options, signal) => {
      const transport = new FakeBootstrapTransport("control");
      return await performRuntimeBootstrapHandshake(
        transport,
        "control",
        options.prepareRuntimeBootstrap,
        performance.now() + 1_000,
        (completed) => {
          host = new GracefulControlHostControlSession(completed);
          return host;
        },
        signal,
      );
    },
  });
  return {
    foundation,
    input,
    output,
    readHost(): GracefulControlHostControlSession {
      if (host === undefined) throw new Error("Expected a promoted Control session.");
      return host;
    },
  };
}

async function createFakeSession<
  TRole extends ServiceHostPayloadRole,
  TSession extends HostControlSession<TRole>,
>(
  options: {
    readonly role: TRole;
    readonly prepareRuntimeBootstrap: RuntimeBootstrapPreparation<TRole>;
  },
  signal: AbortSignal | undefined,
  factory: (bootstrap: Readonly<ParsedRuntimeBootstrapV1>) => TSession,
): Promise<TSession> {
  const transport = new FakeBootstrapTransport(options.role);
  return await performRuntimeBootstrapHandshake(
    transport,
    options.role,
    options.prepareRuntimeBootstrap,
    performance.now() + 1_000,
    (completed) => factory(completed.parsed),
    signal,
  );
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

function drainedFrame(sequence: bigint): Buffer {
  return encodeLocalFrame({
    minorVersion: 0,
    messageType: LocalMessageType.Drained,
    sequence,
    correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
    payload: drainedPayload(),
  });
}

function bootstrapWithArwxCloseTimeout(
  role: ServiceHostPayloadRole,
  closeTimeoutMs: number,
): Buffer {
  const value = JSON.parse(bootstrapDocument(role).toString("utf8")) as Record<string, unknown>;
  const shutdown = value.shutdown as Record<string, unknown>;
  shutdown.gracefulTimeoutMs = 1_000;
  shutdown.forceTerminationReserveMs = 1_000 - closeTimeoutMs;
  return Buffer.from(serializeCanonicalJson(value), "utf8");
}

function runtimeOwner(
  handler: RuntimeBootstrapArwxDispatcherHandler,
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

function isFakeHostControlSession<TRole extends ServiceHostPayloadRole>(
  session: HostControlSession<TRole>,
): session is FakeHostControlSession<TRole> {
  return session instanceof FakeHostControlSession;
}

function isFakeControlHostControlSession(
  session: HostControlSession<"control">,
): session is FakeControlHostControlSession {
  return session instanceof FakeControlHostControlSession;
}

function isGracefulControlHostControlSession(
  session: HostControlSession<"control">,
): session is GracefulControlHostControlSession {
  return session instanceof GracefulControlHostControlSession;
}

function isGracefulExecutorHostControlSession(
  session: HostControlSession<"executor">,
): session is GracefulExecutorHostControlSession {
  return session instanceof GracefulExecutorHostControlSession;
}

function expectPrimaryAndPriorAbort(failure: unknown, primaryCode: string): void {
  expect(failure).toBeInstanceOf(AggregateError);
  const errors = (failure as AggregateError).errors;
  expect(errors).toHaveLength(2);
  expect(errors[0]).toMatchObject({ code: primaryCode });
  expect(errors[1]).toMatchObject({ code: "ABORTED" });
}

function createGate(): { readonly promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return Object.freeze({ promise, release });
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
