import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ServerBindingReceiptStatementV1 } from "@agentic-review/contracts/server-binding-authority-v1";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  loadProfile: async (): Promise<unknown> => {
    throw new Error("profile unavailable");
  },
  nextUuid: (): string => {
    throw new Error("UUID queue empty");
  },
  spawn: (..._argumentsList: unknown[]): unknown => {
    throw new Error("spawn unavailable");
  },
}));

vi.mock("node:child_process", () => ({
  spawn: (...argumentsList: unknown[]): unknown => harness.spawn(...argumentsList),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: (): string => harness.nextUuid() };
});

vi.mock("./server-binding-signer-host-profile-v1.js", () => ({
  loadProductionServerBindingSignerHostProfileV1: (): Promise<unknown> => harness.loadProfile(),
}));

import {
  createServerBindingSignerHostDirectClientV1,
  type ServerBindingSignerHostClientErrorV1,
} from "./server-binding-signer-host-client-v1.js";
import {
  frameServerBindingSignerHostPayloadV1,
  marshalServerBindingSignerHostChildMessageV1,
  parseServerBindingSignerHostParentMessageV1,
  SERVER_BINDING_SIGNER_HOST_FORCED_EXIT_TIMEOUT_MILLISECONDS,
  SERVER_BINDING_SIGNER_HOST_GRACEFUL_SHUTDOWN_TIMEOUT_MILLISECONDS,
  SERVER_BINDING_SIGNER_HOST_HANDSHAKE_TIMEOUT_MILLISECONDS,
  SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDERR_BYTES,
  SERVER_BINDING_SIGNER_HOST_SIGNING_TIMEOUT_MILLISECONDS,
  type ServerBindingSignerHostChildMessageV1,
  ServerBindingSignerHostFrameDecoderV1,
  type ServerBindingSignerHostParentMessageV1,
} from "./server-binding-signer-host-protocol-v1.js";

const instanceId = "a0000000-0000-4000-8000-000000000001";
const requestId = "b0000000-0000-4000-8000-000000000002";
const shutdownRequestId = "c0000000-0000-4000-8000-000000000003";
const issuerPublicKeySpki =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-v0lYTgE9BSFUPfyWOB4VptiDOX8QBdKpB90P_41slWTae5OaPqAyns6GVm8aAeOrfR09_g6AhFGmgT1LCM_nA";
const issuerKeyId = "e28eb43c3d5c64b80fe4f26d45e801d1cf45601cbc095fdab74689e760129930";
const validSignature =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ";
const receiptStatement: ServerBindingReceiptStatementV1 = Object.freeze({
  bindingId: "0f7d78fa-f002-4ede-9cd6-06951ee9b745",
  bindingRevision: 1,
  boundAt: "2026-09-03T01:02:03.004Z",
  certificateDerSha256: "11".repeat(32),
  enrollmentGeneration: 1,
  installationId: "worker.installation-1",
  statementType: "durable-binding-created",
  workerNodeId: "worker:node-1",
});

class FakeInput extends EventEmitter {
  readonly #pendingWriteCallbacks: Array<(error?: Error | null) => void> = [];
  public destroyed = false;
  public writableEnded = false;
  public readonly writes: Buffer[] = [];
  public deferWriteCallbacks = false;
  public writeCallbackError: Error | null = null;
  public writeThrows = false;

  public write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean {
    if (this.writeThrows) throw new Error("private write failure");
    this.writes.push(Buffer.from(chunk));
    if (callback !== undefined && this.deferWriteCallbacks) {
      this.#pendingWriteCallbacks.push(callback);
    } else {
      callback?.(this.writeCallbackError);
    }
    return true;
  }

  public settleNextWrite(error: Error | null = this.writeCallbackError): void {
    const callback = this.#pendingWriteCallbacks.shift();
    if (callback === undefined) throw new Error("Expected a deferred write callback.");
    callback(error);
  }

  public destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.writableEnded = true;
      this.emit("close");
    }
    return this;
  }

  public close(): void {
    this.destroy();
  }
}

class FakeOutput extends EventEmitter {
  #ended = false;
  #closed = false;

  public push(chunk: Uint8Array): void {
    this.emit("data", Buffer.from(chunk));
  }

  public end(): void {
    if (!this.#ended) {
      this.#ended = true;
      this.emit("end");
    }
  }

  public close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.emit("close");
    }
  }
}

class FakeChild extends EventEmitter {
  public pid: number | undefined;
  public readonly stdin = new FakeInput();
  public readonly stdout = new FakeOutput();
  public readonly stderr = new FakeOutput();
  public readonly killCalls: Array<string | number | undefined> = [];
  public killResult = true;
  public killThrows = false;

  public kill(signal?: string | number): boolean {
    this.killCalls.push(signal);
    if (this.killThrows) throw new Error("private kill failure");
    return this.killResult;
  }

  public spawn(pid = 1234): void {
    this.pid = pid;
    this.emit("spawn");
  }

  public errorBeforeSpawn(): void {
    this.emit("error", new Error("private spawn detail"));
    this.stdin.close();
    this.stdout.end();
    this.stdout.close();
    this.stderr.close();
    this.emit("close", -1, null);
  }

  public exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
    this.closeAfterExit(code, signal);
  }

  public closeAfterExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.stdin.close();
    this.stdout.end();
    this.stdout.close();
    this.stderr.close();
    this.emit("close", code, signal);
  }
}

beforeEach(() => {
  vi.useRealTimers();
  harness.loadProfile = async () => ({
    arguments: ["--server-binding-signer-host-v1"],
    executablePath: process.execPath,
    workingDirectory: process.cwd(),
  });
  resetUuidQueue();
  harness.spawn = () => {
    throw new Error("spawn not configured");
  };
});

describe("dormant Server binding signer-host direct client v1", () => {
  it("keeps the production profile unavailable and exposes one stable startup failure", async () => {
    harness.loadProfile = async () => {
      throw new Error("private profile detail");
    };
    const client = createServerBindingSignerHostDirectClientV1();

    const readyError = await rejection(client.ready);
    const terminalError = await client.terminalFailure;
    expect(readyError).toBe(terminalError);
    expect(client.readTerminalError()).toBe(terminalError);
    expect(terminalError).toMatchObject({ code: "SIGNER_HOST_UNAVAILABLE" });
    expect(JSON.stringify(terminalError)).not.toContain("private profile detail");
    await expect(client.close()).rejects.toBe(terminalError);
  });

  it("closes before a delayed profile resolves without spawning or resolving terminal failure", async () => {
    const profile = Promise.withResolvers<unknown>();
    let spawnCalls = 0;
    harness.loadProfile = () => profile.promise;
    harness.spawn = () => {
      spawnCalls += 1;
      return new FakeChild();
    };
    const client = createServerBindingSignerHostDirectClientV1();

    const firstClose = client.close();
    expect(client.close()).toBe(firstClose);
    await firstClose;
    await expect(client.ready).rejects.toMatchObject({ code: "SIGNER_HOST_CLOSED" });
    await expect(
      client.signReceiptStatementV1(
        Buffer.from(JSON.stringify(receiptStatement)),
        null as unknown as AbortSignal,
      ),
    ).rejects.toMatchObject({ code: "SIGNER_HOST_CLOSED" });
    expect(client.readTerminalError()).toBeNull();

    profile.resolve({
      arguments: ["--server-binding-signer-host-v1"],
      executablePath: process.execPath,
      workingDirectory: process.cwd(),
    });
    await tick();
    expect(spawnCalls).toBe(0);
    let terminalSettled = false;
    void client.terminalFailure.then(() => {
      terminalSettled = true;
    });
    await tick();
    expect(terminalSettled).toBe(false);
  });

  it("does not inspect an invalid signal before a delayed profile becomes ready", async () => {
    const profile = Promise.withResolvers<unknown>();
    const child = new FakeChild();
    child.pid = 1234;
    harness.loadProfile = () => profile.promise;
    harness.spawn = () => child as unknown as ChildProcessWithoutNullStreams;
    const client = createServerBindingSignerHostDirectClientV1();

    await expect(
      client.signReceiptStatementV1(
        Buffer.from(JSON.stringify(receiptStatement)),
        null as unknown as AbortSignal,
      ),
    ).rejects.toMatchObject({ code: "SIGNER_HOST_UNAVAILABLE" });
    expect(client.readTerminalError()).toBeNull();

    profile.resolve({
      arguments: ["--server-binding-signer-host-v1"],
      executablePath: process.execPath,
      workingDirectory: process.cwd(),
    });
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(1));
    sendChildMessage(child, readyMessage(instanceId));
    await client.ready;
    const close = client.close();
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(2));
    const shutdown = readParentMessages(child)[1];
    if (shutdown?.type !== "shutdown") throw new Error("Expected shutdown.");
    sendChildMessage(child, {
      protocolVersion: "1.0",
      requestId: shutdown.requestId,
      type: "shutdown_ack",
    });
    child.exit();
    await close;
    expect(client.readTerminalError()).toBeNull();
  });

  it("rejects malformed profile data before any spawn attempt", async () => {
    let spawnCalls = 0;
    harness.loadProfile = async () => ({
      arguments: [process.execPath, "--fixture-scenario=normal", "--server-binding-signer-host-v1"],
      executablePath: process.execPath,
      workingDirectory: process.cwd(),
    });
    harness.spawn = () => {
      spawnCalls += 1;
      return new FakeChild();
    };
    const client = createServerBindingSignerHostDirectClientV1();
    const error = await rejection(client.ready);
    expect(error).toMatchObject({ code: "SIGNER_HOST_UNAVAILABLE" });
    expect(spawnCalls).toBe(0);
    await expect(client.close()).rejects.toBe(error);
  });

  it("classifies a synchronous spawn throw and error-before-spawn without requiring exit", async () => {
    harness.spawn = () => {
      throw new Error("private spawn detail");
    };
    const syncFailure = createServerBindingSignerHostDirectClientV1();
    const syncError = await rejection(syncFailure.ready);
    expect(syncError).toBe(await syncFailure.terminalFailure);
    expect(syncError).toMatchObject({ code: "SIGNER_HOST_UNAVAILABLE" });
    await expect(syncFailure.close()).rejects.toBe(syncError);

    const child = new FakeChild();
    harness.spawn = () => child;
    const asyncFailure = createServerBindingSignerHostDirectClientV1();
    await tick();
    child.errorBeforeSpawn();
    const asyncError = await rejection(asyncFailure.ready);
    expect(asyncError).toBe(await asyncFailure.terminalFailure);
    expect(asyncError).toMatchObject({ code: "SIGNER_HOST_UNAVAILABLE" });
    await expect(asyncFailure.close()).rejects.toBe(asyncError);
    expect(child.killCalls).toEqual([]);
  });

  it("quarantines error-before-spawn until every no-child close fact is observed", async () => {
    const child = new FakeChild();
    harness.spawn = () => child as unknown as ChildProcessWithoutNullStreams;
    const client = createServerBindingSignerHostDirectClientV1();
    await tick();
    child.emit("error", new Error("private spawn detail"));
    const error = await rejection(client.ready);
    expect(error).toMatchObject({ code: "SIGNER_HOST_UNAVAILABLE" });
    await expectReplacementBlocked();

    const closeRejection = rejection(client.close());
    child.stdin.close();
    child.stdout.end();
    child.stdout.close();
    child.stderr.close();
    child.emit("close", -1, null);
    expect(await closeRejection).toBe(error);
    await flushPromiseJobs();
    await expectReplacementCanStart();
  });

  it("closes after spawn but before ready without sending cancel or shutdown", async () => {
    const { child, client } = await startingClient();
    const writesBeforeClose = child.stdin.writes.length;
    const close = client.close();
    await expect(client.ready).rejects.toMatchObject({ code: "SIGNER_HOST_CLOSED" });
    await vi.waitFor(() => expect(child.killCalls).toEqual(["SIGKILL"]));
    expect(child.stdin.writes).toHaveLength(writesBeforeClose);
    child.exit(null, "SIGKILL");
    await close;
    expect(client.readTerminalError()).toBeNull();
  });

  it("keeps a deferred hello write owned without failing after startup close proof", async () => {
    resetUuidQueue();
    const child = new FakeChild();
    child.pid = 1234;
    child.stdin.deferWriteCallbacks = true;
    harness.spawn = () => child as unknown as ChildProcessWithoutNullStreams;
    const client = createServerBindingSignerHostDirectClientV1();
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(1));

    const close = client.close();
    await expect(client.ready).rejects.toMatchObject({ code: "SIGNER_HOST_CLOSED" });
    await vi.waitFor(() => expect(child.killCalls).toEqual(["SIGKILL"]));
    child.exit(null, "SIGKILL");
    await close;
    expect(client.readTerminalError()).toBeNull();

    await expectReplacementBlocked();
    child.stdin.settleNextWrite(new Error("late private hello write failure"));
    await flushPromiseJobs();
    expect(client.readTerminalError()).toBeNull();
    await expectReplacementCanStart();
  });

  it("accepts error-before-spawn as an orderly no-child proof after startup was closed", async () => {
    const child = new FakeChild();
    harness.spawn = () => child as unknown as ChildProcessWithoutNullStreams;
    const client = createServerBindingSignerHostDirectClientV1();
    await tick();
    const close = client.close();
    await expect(client.ready).rejects.toMatchObject({ code: "SIGNER_HOST_CLOSED" });
    child.errorBeforeSpawn();
    await close;
    expect(client.readTerminalError()).toBeNull();
    expect(child.killCalls).toEqual([]);
  });

  it("performs handshake, statement signing, immutable SPKI reads, and orderly shutdown", async () => {
    const child = new FakeChild();
    child.pid = 1234;
    const spawnCalls: unknown[][] = [];
    harness.spawn = (...argumentsList) => {
      spawnCalls.push(argumentsList);
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const client = createServerBindingSignerHostDirectClientV1();
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(1));

    const [hello] = readParentMessages(child);
    expect(hello).toEqual({ instanceId, protocolVersion: "1.0", type: "hello" });
    sendChildMessage(child, readyMessage(instanceId));
    await client.ready;

    const firstSpki = client.readIssuerPublicKeySpki();
    expect(firstSpki === null ? null : Buffer.from(firstSpki)).toEqual(
      Buffer.from(issuerPublicKeySpki, "base64url"),
    );
    if (firstSpki === null) throw new Error("Expected signer-host SPKI.");
    firstSpki[0] = 0;
    const secondSpki = client.readIssuerPublicKeySpki();
    expect(secondSpki === null ? null : Buffer.from(secondSpki)).toEqual(
      Buffer.from(issuerPublicKeySpki, "base64url"),
    );

    const controller = new AbortController();
    const signaturePromise = client.signReceiptStatementV1(
      Buffer.from(JSON.stringify(receiptStatement)),
      controller.signal,
    );
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(2));
    expect(readParentMessages(child)[1]).toMatchObject({
      protocolVersion: "1.0",
      requestId,
      type: "sign_receipt_statement_v1",
    });
    sendChildMessage(child, {
      operation: "receipt_statement_v1",
      protocolVersion: "1.0",
      requestId,
      signature: validSignature,
      type: "signature",
    });
    expect(Buffer.from(await signaturePromise)).toEqual(Buffer.from(validSignature, "base64url"));

    const closePromise = client.close();
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(3));
    expect(readParentMessages(child)[2]).toEqual({
      protocolVersion: "1.0",
      requestId: shutdownRequestId,
      type: "shutdown",
    });
    sendChildMessage(child, {
      protocolVersion: "1.0",
      requestId: shutdownRequestId,
      type: "shutdown_ack",
    });
    child.exit();
    await closePromise;
    expect(client.readTerminalError()).toBeNull();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.[0]).toBe(process.execPath);
    expect(spawnCalls[0]?.[1]).toEqual(["--server-binding-signer-host-v1"]);
    expect(spawnCalls[0]?.[2]).toMatchObject({
      cwd: process.cwd(),
      detached: false,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const environment = (spawnCalls[0]?.[2] as { readonly env?: object } | undefined)?.env;
    expect(environment).toBeDefined();
    expect(Object.getPrototypeOf(environment)).toBeNull();
    expect(Object.keys(environment ?? {})).toEqual([]);
  });

  it("returns recoverable busy without allocating an ID or writing a frame", async () => {
    const { child, client } = await readyClient();
    const first = client.signReceiptStatementV1(
      Buffer.from(JSON.stringify(receiptStatement)),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(2));
    const writeCount = child.stdin.writes.length;

    await expect(
      client.signReceiptStatementV1(
        Buffer.from(JSON.stringify(receiptStatement)),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "SIGNER_HOST_BUSY" });
    expect(child.stdin.writes).toHaveLength(writeCount);
    expect(client.readTerminalError()).toBeNull();

    sendChildMessage(child, {
      operation: "receipt_statement_v1",
      protocolVersion: "1.0",
      requestId,
      signature: validSignature,
      type: "signature",
    });
    await first;
    const close = client.close();
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(3));
    sendChildMessage(child, {
      protocolVersion: "1.0",
      requestId: shutdownRequestId,
      type: "shutdown_ack",
    });
    child.exit();
    await close;
  });

  it("terminalizes throwing abort registration without sending a signing frame", async () => {
    const { child, client } = await readyClient();
    const signal = {
      aborted: false,
      addEventListener: () => {
        throw new Error("private add-listener failure");
      },
      removeEventListener: () => {
        throw new Error("private remove-listener failure");
      },
    } as unknown as AbortSignal;
    const error = await rejection(
      client.signReceiptStatementV1(Buffer.from(JSON.stringify(receiptStatement)), signal),
    );
    expect(error).toBe(await client.terminalFailure);
    expect(error).toMatchObject({ code: "SIGNER_HOST_PROTOCOL_FAILURE" });
    expect(child.stdin.writes).toHaveLength(1);
    await vi.waitFor(() => expect(child.killCalls).toEqual(["SIGKILL"]));
    child.exit(null, "SIGKILL");
    await expect(client.close()).rejects.toBe(error);
  });

  it("contains a throwing abort-listener removal after a valid signature", async () => {
    const { child, client } = await readyClient();
    const signal = {
      aborted: false,
      addEventListener: () => undefined,
      removeEventListener: () => {
        throw new Error("private remove-listener failure");
      },
    } as unknown as AbortSignal;
    const signing = client.signReceiptStatementV1(
      Buffer.from(JSON.stringify(receiptStatement)),
      signal,
    );
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(2));
    sendChildMessage(child, {
      operation: "receipt_statement_v1",
      protocolVersion: "1.0",
      requestId,
      signature: validSignature,
      type: "signature",
    });
    expect(Buffer.from(await signing)).toEqual(Buffer.from(validSignature, "base64url"));
    expect(client.readTerminalError()).toBeNull();

    const close = client.close();
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(3));
    sendChildMessage(child, {
      protocolVersion: "1.0",
      requestId: shutdownRequestId,
      type: "shutdown_ack",
    });
    child.exit();
    await close;
  });

  it("retries UUID collisions and terminalizes a broken request-ID generator", async () => {
    const first = await readyClient();
    const values = [instanceId, requestId, shutdownRequestId];
    harness.nextUuid = () => {
      const value = values.shift();
      if (value === undefined) throw new Error("UUID queue empty");
      return value;
    };
    const signing = first.client.signReceiptStatementV1(
      Buffer.from(JSON.stringify(receiptStatement)),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(first.child.stdin.writes).toHaveLength(2));
    expect(readParentMessages(first.child)[1]).toMatchObject({ requestId });
    sendChildMessage(first.child, {
      operation: "receipt_statement_v1",
      protocolVersion: "1.0",
      requestId,
      signature: validSignature,
      type: "signature",
    });
    await signing;
    const firstClose = first.client.close();
    await vi.waitFor(() => expect(first.child.stdin.writes).toHaveLength(3));
    sendChildMessage(first.child, {
      protocolVersion: "1.0",
      requestId: shutdownRequestId,
      type: "shutdown_ack",
    });
    first.child.exit();
    await firstClose;

    const second = await readyClient();
    harness.nextUuid = () => instanceId;
    const error = await rejection(
      second.client.signReceiptStatementV1(
        Buffer.from(JSON.stringify(receiptStatement)),
        new AbortController().signal,
      ),
    );
    expect(error).toMatchObject({ code: "SIGNER_HOST_PROTOCOL_FAILURE" });
    expect(second.child.stdin.writes).toHaveLength(1);
    expect(second.child.killCalls).toEqual(["SIGKILL"]);
    second.child.exit(null, "SIGKILL");
    await expect(second.client.close()).rejects.toBe(error);
  });

  it("maps a throwing request-ID generator to one stable terminal failure", async () => {
    const signing = await readyClient();
    harness.nextUuid = () => {
      throw new Error("private request RNG failure");
    };
    const signError = await rejection(
      signing.client.signReceiptStatementV1(
        Buffer.from(JSON.stringify(receiptStatement)),
        new AbortController().signal,
      ),
    );
    expect(signError).toBe(await signing.client.terminalFailure);
    expect(signError).toMatchObject({ code: "SIGNER_HOST_PROTOCOL_FAILURE" });
    expect(JSON.stringify(signError)).not.toContain("private request RNG failure");
    await vi.waitFor(() => expect(signing.child.killCalls).toEqual(["SIGKILL"]));
    signing.child.exit(null, "SIGKILL");
    await expect(signing.client.close()).rejects.toBe(signError);

    const closing = await readyClient();
    harness.nextUuid = () => {
      throw new Error("private shutdown RNG failure");
    };
    const closeRejection = rejection(closing.client.close());
    await vi.waitFor(() => expect(closing.child.killCalls).toEqual(["SIGKILL"]));
    closing.child.exit(null, "SIGKILL");
    const closeError = await closeRejection;
    expect(closeError).toBe(await closing.client.terminalFailure);
    expect(closeError).toMatchObject({ code: "SIGNER_HOST_PROTOCOL_FAILURE" });
    expect(JSON.stringify(closeError)).not.toContain("private shutdown RNG failure");
  });

  it("terminalizes a duplicate response without replacing the first valid result", async () => {
    const { child, client } = await readyClient();
    const signing = client.signReceiptStatementV1(
      Buffer.from(JSON.stringify(receiptStatement)),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(2));
    const response: ServerBindingSignerHostChildMessageV1 = {
      operation: "receipt_statement_v1",
      protocolVersion: "1.0",
      requestId,
      signature: validSignature,
      type: "signature",
    };
    sendChildMessage(child, response);
    await signing;
    sendChildMessage(child, response);
    const error = await client.terminalFailure;
    expect(error).toMatchObject({ code: "SIGNER_HOST_PROTOCOL_FAILURE" });
    expect(child.killCalls).toEqual(["SIGKILL"]);
    child.exit(null, "SIGKILL");
    await expect(client.close()).rejects.toBe(error);
  });

  it("maps hello, signing, and shutdown write failures by lifecycle phase", async () => {
    const helloChild = new FakeChild();
    helloChild.pid = 1234;
    helloChild.stdin.writeCallbackError = new Error("private hello write detail");
    harness.spawn = () => helloChild as unknown as ChildProcessWithoutNullStreams;
    const helloClient = createServerBindingSignerHostDirectClientV1();
    const helloError = await rejection(helloClient.ready);
    expect(helloError).toMatchObject({ code: "SIGNER_HOST_UNAVAILABLE" });
    helloChild.exit(null, "SIGKILL");
    await expect(helloClient.close()).rejects.toBe(helloError);

    const signing = await readyClient();
    signing.child.stdin.writeCallbackError = new Error("private sign write detail");
    const signError = await rejection(
      signing.client.signReceiptStatementV1(
        Buffer.from(JSON.stringify(receiptStatement)),
        new AbortController().signal,
      ),
    );
    expect(signError).toMatchObject({ code: "SIGNER_HOST_OUTCOME_UNKNOWN" });
    signing.child.exit(null, "SIGKILL");
    await expect(signing.client.close()).rejects.toBe(signError);

    const shutdown = await readyClient();
    shutdown.child.stdin.writeCallbackError = new Error("private shutdown write detail");
    const close = shutdown.client.close();
    const closeRejection = rejection(close);
    await vi.waitFor(() => expect(shutdown.child.killCalls).toEqual(["SIGKILL"]));
    shutdown.child.exit(null, "SIGKILL");
    expect(await closeRejection).toMatchObject({ code: "SIGNER_HOST_OUTCOME_UNKNOWN" });
  });

  it("keeps a settled signature stable when its write callback fails after forced close", async () => {
    vi.useFakeTimers();
    const { child, client } = await readyClient();
    child.stdin.deferWriteCallbacks = true;
    const signing = client.signReceiptStatementV1(
      Buffer.from(JSON.stringify(receiptStatement)),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(2));
    sendChildMessage(child, {
      operation: "receipt_statement_v1",
      protocolVersion: "1.0",
      requestId,
      signature: validSignature,
      type: "signature",
    });

    const close = client.close();
    await vi.advanceTimersByTimeAsync(
      SERVER_BINDING_SIGNER_HOST_GRACEFUL_SHUTDOWN_TIMEOUT_MILLISECONDS,
    );
    expect(child.killCalls).toEqual(["SIGKILL"]);
    child.exit(null, "SIGKILL");
    await close;
    await expectReplacementBlocked();

    child.stdin.settleNextWrite(new Error("late private sign write failure"));
    expect(Buffer.from(await signing)).toEqual(Buffer.from(validSignature, "base64url"));
    await flushPromiseJobs();
    expect(client.readTerminalError()).toBeNull();
    await expectReplacementCanStart();
  });

  it("terminalizes abort, sends best-effort cancel, rejects late signature, and proves exit", async () => {
    const { child, client } = await readyClient();
    const controller = new AbortController();
    const signing = client.signReceiptStatementV1(
      Buffer.from(JSON.stringify(receiptStatement)),
      controller.signal,
    );
    const signingRejection = rejection(signing);
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(2));
    controller.abort(new Error("private abort reason"));
    const signError = await signingRejection;
    expect(signError).toBe(await client.terminalFailure);
    expect(signError).toMatchObject({ code: "SIGNER_HOST_OUTCOME_UNKNOWN" });
    await vi.waitFor(() => expect(child.killCalls).toEqual(["SIGKILL"]));
    expect(readParentMessages(child)).toContainEqual({
      protocolVersion: "1.0",
      reason: "caller_abort",
      requestId,
      type: "cancel",
    });

    sendChildMessage(child, {
      operation: "receipt_statement_v1",
      protocolVersion: "1.0",
      requestId,
      signature: validSignature,
      type: "signature",
    });
    expect(client.readTerminalError()).toBe(signError);
    child.exit(null, "SIGKILL");
    await expect(client.close()).rejects.toBe(signError);
    expect(JSON.stringify(signError)).not.toContain("private abort reason");
  });

  it("maps invalid readiness identity and malformed output to stable mismatch", async () => {
    const first = await startingClient();
    sendChildMessage(first.child, readyMessage(instanceId, 9999));
    const identityError = await rejection(first.client.ready);
    expect(identityError).toMatchObject({ code: "SIGNER_HOST_MISMATCH" });
    expect(first.child.killCalls).toEqual(["SIGKILL"]);
    first.child.exit(null, "SIGKILL");
    await expect(first.client.close()).rejects.toBe(identityError);

    const second = await startingClient();
    second.child.stdout.push(Buffer.from([0, 0, 0, 0]));
    const protocolError = await rejection(second.client.ready);
    expect(protocolError).toMatchObject({ code: "SIGNER_HOST_MISMATCH" });
    second.child.exit(null, "SIGKILL");
    await expect(second.client.close()).rejects.toBe(protocolError);
  });

  it("rejects startup and operation errors with invalid request correlation", async () => {
    const startup = await startingClient();
    sendChildMessage(startup.child, {
      code: "HANDSHAKE_REJECTED",
      protocolVersion: "1.0",
      requestId,
      type: "error",
    });
    const startupError = await rejection(startup.client.ready);
    expect(startupError).toMatchObject({ code: "SIGNER_HOST_MISMATCH" });
    startup.child.exit(null, "SIGKILL");
    await expect(startup.client.close()).rejects.toBe(startupError);

    const operation = await readyClient();
    sendChildMessage(operation.child, {
      code: "SIGNING_FAILED",
      protocolVersion: "1.0",
      requestId: shutdownRequestId,
      type: "error",
    });
    const operationError = await operation.client.terminalFailure;
    expect(operationError).toMatchObject({ code: "SIGNER_HOST_PROTOCOL_FAILURE" });
    operation.child.exit(null, "SIGKILL");
    await expect(operation.client.close()).rejects.toBe(operationError);
  });

  it("times out handshake and signing without relying on child progress", async () => {
    vi.useFakeTimers();
    const handshake = await startingClient();
    await vi.advanceTimersByTimeAsync(SERVER_BINDING_SIGNER_HOST_HANDSHAKE_TIMEOUT_MILLISECONDS);
    const handshakeError = await rejection(handshake.client.ready);
    expect(handshakeError).toMatchObject({ code: "SIGNER_HOST_UNAVAILABLE" });
    expect(handshake.child.killCalls).toEqual(["SIGKILL"]);
    handshake.child.exit(null, "SIGKILL");
    await expect(handshake.client.close()).rejects.toBe(handshakeError);

    const signing = await readyClient();
    const pending = signing.client.signReceiptStatementV1(
      Buffer.from(JSON.stringify(receiptStatement)),
      new AbortController().signal,
    );
    const pendingRejection = rejection(pending);
    await vi.advanceTimersByTimeAsync(SERVER_BINDING_SIGNER_HOST_SIGNING_TIMEOUT_MILLISECONDS);
    const signingError = await pendingRejection;
    expect(signingError).toMatchObject({ code: "SIGNER_HOST_OUTCOME_UNKNOWN" });
    expect(readParentMessages(signing.child)).toContainEqual({
      protocolVersion: "1.0",
      reason: "deadline",
      requestId,
      type: "cancel",
    });
    signing.child.exit(null, "SIGKILL");
    await expect(signing.client.close()).rejects.toBe(signingError);
  });

  it("forces a missing orderly exit and rejects when forced exit remains unproved", async () => {
    vi.useFakeTimers();
    const first = await readyClient();
    const firstClose = first.client.close();
    await vi.runAllTicks();
    sendChildMessage(first.child, {
      protocolVersion: "1.0",
      requestId,
      type: "shutdown_ack",
    });
    await vi.advanceTimersByTimeAsync(
      SERVER_BINDING_SIGNER_HOST_GRACEFUL_SHUTDOWN_TIMEOUT_MILLISECONDS,
    );
    expect(first.child.killCalls).toEqual(["SIGKILL"]);
    first.child.exit(null, "SIGKILL");
    await firstClose;

    const second = await readyClient();
    second.child.killThrows = true;
    const secondClose = second.client.close();
    const secondCloseRejection = rejection(secondClose);
    await vi.advanceTimersByTimeAsync(
      SERVER_BINDING_SIGNER_HOST_GRACEFUL_SHUTDOWN_TIMEOUT_MILLISECONDS +
        SERVER_BINDING_SIGNER_HOST_FORCED_EXIT_TIMEOUT_MILLISECONDS,
    );
    const closeError = await secondCloseRejection;
    expect(closeError).toBe(await second.client.terminalFailure);
    expect(closeError).toMatchObject({ code: "SIGNER_HOST_EXIT_UNPROVEN" });

    let replacementSpawnCalls = 0;
    harness.spawn = () => {
      replacementSpawnCalls += 1;
      return new FakeChild() as unknown as ChildProcessWithoutNullStreams;
    };
    const blocked = createServerBindingSignerHostDirectClientV1();
    const blockedError = await rejection(blocked.ready);
    expect(blockedError).toMatchObject({ code: "SIGNER_HOST_EXIT_UNPROVEN" });
    expect(replacementSpawnCalls).toBe(0);
    await expect(blocked.close()).rejects.toBe(blockedError);

    second.child.exit(null, "SIGKILL");
    expect(second.client.readTerminalError()).toBe(closeError);
    await vi.runAllTicks();

    resetUuidQueue();
    const replacementChild = new FakeChild();
    replacementChild.pid = 1234;
    harness.spawn = () => {
      replacementSpawnCalls += 1;
      return replacementChild as unknown as ChildProcessWithoutNullStreams;
    };
    const replacement = createServerBindingSignerHostDirectClientV1();
    await vi.waitFor(() => expect(replacementChild.stdin.writes).toHaveLength(1));
    expect(replacementSpawnCalls).toBe(1);
    const replacementClose = replacement.close();
    replacementChild.exit(null, "SIGKILL");
    await replacementClose;
  });

  it("starts the graceful deadline before a shutdown write callback and waits for exit proof", async () => {
    vi.useFakeTimers();
    const active = await readyClient();
    active.child.stdin.deferWriteCallbacks = true;
    const close = active.client.close();
    await vi.waitFor(() => expect(active.child.stdin.writes).toHaveLength(2));

    await vi.advanceTimersByTimeAsync(
      SERVER_BINDING_SIGNER_HOST_GRACEFUL_SHUTDOWN_TIMEOUT_MILLISECONDS,
    );
    expect(active.child.killCalls).toEqual(["SIGKILL"]);
    active.child.stdin.settleNextWrite(new Error("late private shutdown write failure"));
    await flushPromiseJobs();
    expect(active.client.readTerminalError()).toBeNull();

    await expectReplacementBlocked();
    active.child.exit(null, "SIGKILL");
    await close;
    await flushPromiseJobs();
    expect(active.client.readTerminalError()).toBeNull();
    await expectReplacementCanStart();
  });

  it("retains quarantine after exit proof until a late shutdown write callback settles", async () => {
    vi.useFakeTimers();
    const active = await readyClient();
    active.child.stdin.deferWriteCallbacks = true;
    const close = active.client.close();
    await vi.waitFor(() => expect(active.child.stdin.writes).toHaveLength(2));

    await vi.advanceTimersByTimeAsync(
      SERVER_BINDING_SIGNER_HOST_GRACEFUL_SHUTDOWN_TIMEOUT_MILLISECONDS,
    );
    expect(active.child.killCalls).toEqual(["SIGKILL"]);
    active.child.exit(null, "SIGKILL");
    await close;
    expect(active.client.readTerminalError()).toBeNull();

    await expectReplacementBlocked();
    active.child.stdin.settleNextWrite(new Error("late private shutdown write failure"));
    await flushPromiseJobs();
    expect(active.client.readTerminalError()).toBeNull();
    await expectReplacementCanStart();
  });

  it("requires child exit, all three stdio closes, and child close before proving cleanup", async () => {
    const { child, client } = await readyClient();
    const close = client.close();
    await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(2));
    sendChildMessage(child, {
      protocolVersion: "1.0",
      requestId,
      type: "shutdown_ack",
    });
    let closed = false;
    void close.then(() => {
      closed = true;
    });
    child.emit("exit", 0, null);
    await tick();
    expect(closed).toBe(false);
    child.closeAfterExit();
    await close;
    expect(closed).toBe(true);
  });

  it("quarantines an unexpected exit until child close and all stdio closes are proved", async () => {
    const active = await readyClient();
    active.child.emit("exit", 17, null);
    const error = await active.client.terminalFailure;
    expect(error).toMatchObject({ code: "SIGNER_HOST_OUTCOME_UNKNOWN" });
    await expectReplacementBlocked();

    active.child.closeAfterExit(17, null);
    await expect(active.client.close()).rejects.toBe(error);
    await flushPromiseJobs();
    await expectReplacementCanStart();
  });

  it("drains stderr without disclosure and terminalizes its lifetime byte ceiling", async () => {
    const { child, client } = await startingClient();
    const secret = Buffer.from("fixture-secret-marker");
    const repeats = Math.ceil(
      (SERVER_BINDING_SIGNER_HOST_MAXIMUM_BUFFERED_STDERR_BYTES + 1) / secret.byteLength,
    );
    for (let index = 0; index < repeats; index += 1) child.stderr.push(secret);
    const error = await rejection(client.ready);
    expect(error).toMatchObject({ code: "SIGNER_HOST_UNAVAILABLE" });
    expect(JSON.stringify(error)).not.toContain("fixture-secret-marker");
    child.exit(null, "SIGKILL");
    await expect(client.close()).rejects.toBe(error);
  });
});

async function startingClient(): Promise<{
  child: FakeChild;
  client: ReturnType<typeof createServerBindingSignerHostDirectClientV1>;
}> {
  resetUuidQueue();
  const child = new FakeChild();
  child.pid = 1234;
  harness.spawn = () => child as unknown as ChildProcessWithoutNullStreams;
  const client = createServerBindingSignerHostDirectClientV1();
  await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(1));
  return { child, client };
}

function resetUuidQueue(): void {
  const values = [instanceId, requestId, shutdownRequestId];
  harness.nextUuid = () => {
    const value = values.shift();
    if (value === undefined) throw new Error("UUID queue empty");
    return value;
  };
}

async function readyClient(): Promise<{
  child: FakeChild;
  client: ReturnType<typeof createServerBindingSignerHostDirectClientV1>;
}> {
  const result = await startingClient();
  const hello = readParentMessages(result.child)[0];
  if (hello?.type !== "hello") throw new Error("Expected hello.");
  sendChildMessage(result.child, readyMessage(hello.instanceId));
  await result.client.ready;
  return result;
}

async function expectReplacementBlocked(): Promise<void> {
  let spawnCalls = 0;
  harness.spawn = () => {
    spawnCalls += 1;
    return new FakeChild() as unknown as ChildProcessWithoutNullStreams;
  };
  const blocked = createServerBindingSignerHostDirectClientV1();
  const error = await rejection(blocked.ready);
  expect(error).toMatchObject({ code: "SIGNER_HOST_EXIT_UNPROVEN" });
  expect(spawnCalls).toBe(0);
  await expect(blocked.close()).rejects.toBe(error);
}

async function expectReplacementCanStart(): Promise<void> {
  resetUuidQueue();
  let spawnCalls = 0;
  const child = new FakeChild();
  child.pid = 1234;
  harness.spawn = () => {
    spawnCalls += 1;
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  const replacement = createServerBindingSignerHostDirectClientV1();
  await vi.waitFor(() => expect(child.stdin.writes).toHaveLength(1));
  expect(spawnCalls).toBe(1);
  const close = replacement.close();
  child.exit(null, "SIGKILL");
  await close;
}

function readyMessage(
  echoedInstanceId: string,
  hostPid = 1234,
): Extract<ServerBindingSignerHostChildMessageV1, { readonly type: "ready" }> {
  return {
    capabilities: {
      maximumConcurrentRequests: 1,
      operations: ["active_status_statement_v1", "receipt_statement_v1"],
    },
    hostPid,
    instanceId: echoedInstanceId,
    issuerKeyId,
    issuerPublicKeySpki,
    protocolVersion: "1.0",
    type: "ready",
  };
}

function sendChildMessage(child: FakeChild, message: ServerBindingSignerHostChildMessageV1): void {
  child.stdout.push(
    frameServerBindingSignerHostPayloadV1(marshalServerBindingSignerHostChildMessageV1(message)),
  );
}

function readParentMessages(child: FakeChild): ServerBindingSignerHostParentMessageV1[] {
  const decoder = new ServerBindingSignerHostFrameDecoderV1();
  const messages: ServerBindingSignerHostParentMessageV1[] = [];
  for (const write of child.stdin.writes) {
    for (const payload of decoder.push(write)) {
      messages.push(parseServerBindingSignerHostParentMessageV1(payload));
    }
  }
  return messages;
}

async function rejection(promise: Promise<unknown>): Promise<ServerBindingSignerHostClientErrorV1> {
  try {
    await promise;
  } catch (error) {
    return error as ServerBindingSignerHostClientErrorV1;
  }
  throw new Error("Expected rejection.");
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function flushPromiseJobs(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
