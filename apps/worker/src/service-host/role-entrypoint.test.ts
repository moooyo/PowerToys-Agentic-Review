import { Duplex, PassThrough } from "node:stream";
import { serializeCanonicalJson } from "@agentic-review/local-protocol";
import { describe, expect, it, vi } from "vitest";
import type { HostControlSession } from "./host-control-session.js";
import {
  SERVICE_HOST_CONTROL_PIPE_PREFIX,
  type ServiceHostPayloadRole,
} from "./launch-contract.js";
import { encodeHostControlOpaqueJson } from "./opaque-json.js";
import { openServiceHostRoleFoundation, runServiceHostRoleEntrypoint } from "./role-entrypoint.js";
import { type ParsedRuntimeBootstrapV1, parseRuntimeBootstrap } from "./runtime-bootstrap.js";
import {
  bootstrapDocument,
  handleBootstrapTestWrite,
  installBootstrapTestHost,
} from "./runtime-bootstrap.test-helpers.js";
import {
  performRuntimeBootstrapHandshake,
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
  public closeError: Error | undefined;
  public drainError: Error | undefined;
  public drainRejectsUndefined = false;
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

  public async drain(): Promise<void> {
    this.drainCalls += 1;
    if (this.drainRejectsUndefined) return await Promise.reject(undefined);
    if (this.drainError !== undefined) throw this.drainError;
    this.closed = true;
    this.#resolveDone();
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError !== undefined) throw this.closeError;
    this.closed = true;
    this.#resolveDone();
  }

  public fail(error: unknown): void {
    this.#rejectDone(error);
  }

  public async armArwxShutdown(): Promise<never> {
    throw new Error("Fake foundation does not arm ARWX shutdown.");
  }
}

class FakeControlHostControlSession extends FakeHostControlSession<"control"> {
  public readonly controlOnlyMarker = true;
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
    await expect(running).rejects.toEqual(
      expect.objectContaining({ code: "ROLE_RUNTIME_UNAVAILABLE" }),
    );
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

    const failure = await running.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ code: "ROLE_RUNTIME_UNAVAILABLE" }),
      undefined,
    ]);
  });

  it("retains and settles the first ARWX owner when bootstrap preparation fails", async () => {
    const role = "control" as const;
    const invalidValue = JSON.parse(bootstrapDocument(role).toString("utf8")) as Record<
      string,
      unknown
    >;
    invalidValue.roleConfig = encodeHostControlOpaqueJson({ unsupported: true }, 47 * 1_024);
    const invalidBootstrap = Buffer.from(serializeCanonicalJson(invalidValue), "utf8");
    const input = new DelayedDestroyInput();
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
            bootstrap: invalidBootstrap,
            commit: null,
            fragments: 5,
          });
          try {
            return await performRuntimeBootstrapHandshake(
              transport,
              role,
              options.prepareRuntimeBootstrap,
              performance.now() + 1_000,
              (completed) => new FakeHostControlSession(role, completed.parsed),
              signal,
            );
          } catch (error) {
            try {
              options.prepareRuntimeBootstrap(parseRuntimeBootstrap(invalidBootstrap, role));
            } catch (secondError) {
              secondPreparationFailure = secondError;
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
    await expect(foundation.done).rejects.toMatchObject({ code: "FRAME_INVALID" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(host?.drainCalls).toBe(0);
    expect(host?.closeCalls).toBe(0);

    await expect(foundation.close()).rejects.toMatchObject({ code: "FRAME_INVALID" });
    expect(host?.drainCalls).toBe(1);
    expect(drainOwner).toHaveBeenCalledOnce();
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
