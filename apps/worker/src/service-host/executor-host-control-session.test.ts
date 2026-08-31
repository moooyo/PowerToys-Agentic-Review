import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
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
  handleBootstrapTestWrite,
  installBootstrapTestHost,
} from "./runtime-bootstrap.test-helpers.js";

class FakeExecutorHostControl extends Duplex {
  public clientEnded = false;
  public endReadableOnClientEnd = true;

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
    callback();
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
