import { Duplex, PassThrough } from "node:stream";
import { serializeCanonicalJson } from "@agentic-review/local-protocol";
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
} from "./runtime-bootstrap.test-helpers.js";
import {
  type CompletedRuntimeBootstrap,
  createRuntimeBootstrapReadyBoundary,
  isCompletedRuntimeBootstrap,
  performRuntimeBootstrapHandshake,
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

  it("requires a genuine single-use receive-loop token", async () => {
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
    const receiveLoop = arwx.startRuntimeBootstrapReceiveLoop(() => undefined);
    const boundary = createRuntimeBootstrapReadyBoundary(
      "control",
      parsed,
      arwx,
      receiveLoop.token,
    );
    expect(boundary.role).toBe("control");
    expect(() =>
      createRuntimeBootstrapReadyBoundary("control", parsed, arwx, receiveLoop.token),
    ).toThrowError(expect.objectContaining({ code: "BOOTSTRAP_INVALID" }));
    arwx.abort();
    await receiveLoop.done.catch(() => undefined);
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
