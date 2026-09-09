import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StdioProcessHostClient,
  type StdioProcessHostClientOptions,
} from "./process-host-client.js";
import {
  type ManagedProcess,
  type ProcessHostEvent,
  ProcessHostProtocolError,
  type ProcessHostRequest,
  type ProcessHostStdinRequest,
  type ProcessLaunchSpec,
  type ProcessStdinResultEvent,
  processHostInteractiveStdinCapability,
  processHostMaximumFrameBytes,
} from "./process-host-protocol.js";

class Host extends EventEmitter {
  readonly pid = 100;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: ProcessHostRequest[] = [];
  readonly stdin: Writable;
  killed = false;
  closed = false;
  blocked = false;
  holdCallback = false;
  heldCallback?: (error?: Error | null) => void;
  constructor() {
    super();
    this.stdin = new Writable({
      write: (bytes, _encoding, callback) => {
        if (this.blocked) return;
        this.requests.push(JSON.parse(Buffer.from(bytes).toString("utf8")) as ProcessHostRequest);
        if (this.holdCallback) {
          this.heldCallback = callback;
          return;
        }
        callback();
      },
    });
  }
  event(value: ProcessHostEvent | Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
  releaseWrite(error?: Error): void {
    const callback = this.heldCallback;
    delete this.heldCallback;
    if (callback === undefined) throw new Error("No synthetic write callback is pending.");
    callback(error);
  }
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.stop(1));
    return true;
  }
  stop(code = 0): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, null);
  }
}
const hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) host.stop(1);
  await Promise.resolve();
  vi.useRealTimers();
});

const spec = (): ProcessLaunchSpec => ({
  executable: "C:\\Tools\\codex.exe",
  arguments: ["app-server"],
  workingDirectory: "C:\\Runs\\fixture",
  environmentMode: "replace",
  environment: { SystemRoot: "C:\\Windows" },
  interactiveStdin: true,
  limits: {
    hardTimeoutMs: 60_000,
    maximumProcessCount: 4,
    maximumMemoryBytes: 128 * 1024 * 1024,
    maximumOutputBytes: 4096,
  },
});
async function connect(options: Partial<StdioProcessHostClientOptions> = {}, capability = true) {
  const host = new Host();
  hosts.push(host);
  let argv: readonly string[] = [];
  const creating = StdioProcessHostClient.create({
    processHostPath: "C:\\Tools\\ProcessHost.exe",
    instanceKey: "a".repeat(64),
    maximumConcurrentRequests: 2,
    interactiveStdin: true,
    hostEnvironment: { SystemRoot: "C:\\Windows" },
    ...options,
    spawnProcess: (_executable, argumentsList) => {
      argv = argumentsList;
      return host as unknown as ChildProcessWithoutNullStreams;
    },
  });
  host.event({
    protocolVersion: "1.0",
    type: "ready",
    processHostPid: host.pid,
    capabilities: {
      concurrentRequests: true,
      maximumConcurrentRequests: options.maximumConcurrentRequests ?? 2,
      maximumFrameBytes: processHostMaximumFrameBytes,
      ...(capability ? { interactiveStdin: processHostInteractiveStdinCapability } : {}),
    },
  });
  return { host, client: await creating, argv };
}
async function request<T extends ProcessHostRequest["type"]>(
  host: Host,
  type: T,
  count = 1,
): Promise<Extract<ProcessHostRequest, { type: T }>> {
  for (let turn = 0; turn < 30; turn++) {
    const matches = host.requests.filter((entry) => entry.type === type);
    if (matches.length >= count)
      return matches[count - 1] as Extract<ProcessHostRequest, { type: T }>;
    await new Promise<void>((resolve) => process.nextTick(resolve));
  }
  throw new Error(`Missing synthetic ${type} request ${count}.`);
}
let nextIdentity = 1;
async function start(f: Awaited<ReturnType<typeof connect>>, pid = 200, launch = spec()) {
  const controller = new AbortController();
  const count = f.host.requests.filter((entry) => entry.type === "start").length + 1;
  const starting = f.client.start(launch, controller.signal);
  const sent = await request(f.host, "start", count);
  const streamId = (nextIdentity++).toString(16).padStart(64, "0");
  f.host.event({
    protocolVersion: "1.0",
    type: "started",
    requestId: sent.requestId,
    processId: pid,
    ...(launch.interactiveStdin ? { stdinStreamId: streamId } : {}),
  });
  const managed = await starting;
  return { managed, controller, requestId: sent.requestId, streamId };
}
function input(managed: ManagedProcess) {
  if (managed.stdin === undefined) throw new Error("The fixture requires interactive input.");
  return managed.stdin;
}
function ack(
  host: Host,
  operation: ProcessHostStdinRequest,
  overrides: Partial<ProcessStdinResultEvent> = {},
): void {
  host.event({
    protocolVersion: "1.0",
    type: "stdin_result",
    requestId: operation.requestId,
    stdinStreamId: operation.stdinStreamId,
    sequence: operation.sequence,
    operation: operation.type === "stdin_write" ? "write" : "close",
    status: "succeeded",
    bytesWritten:
      operation.type === "stdin_write" ? Buffer.from(operation.dataBase64, "base64").byteLength : 0,
    code: null,
    ...overrides,
  });
}
function exited(host: Host, process: { requestId: string }, code = 0): void {
  host.event({
    protocolVersion: "1.0",
    type: "exited",
    requestId: process.requestId,
    exitCode: code,
    signal: null,
    outputTruncated: false,
  });
}
async function terminated(host: Host, process: { requestId: string }): Promise<void> {
  const commands = host.requests.filter(
    (entry) => entry.type === "terminate" && entry.requestId === process.requestId,
  );
  if (commands.length === 0) await request(host, "terminate");
  host.event({
    protocolVersion: "1.0",
    type: "terminated",
    requestId: process.requestId,
    reason: "cancelled",
  });
}

describe("interactive ProcessHost stdin", () => {
  it("opts in explicitly and omits stdin on a legacy start", async () => {
    const f = await connect();
    expect(f.argv).toContain("--interactive-stdin");
    const { interactiveStdin: _unused, ...base } = spec();
    const old = await start(f, 201, { ...base, standardInput: "once" });
    expect(old.managed).not.toHaveProperty("stdin");
    exited(f.host, old);
    await old.managed.completed;
    const process = await start(f);
    expect(input(process.managed).streamId).toBe(process.streamId);
    exited(f.host, process);
    await process.managed.completed;
  });

  it.each(["missing capability", "missing opt-in"])(
    "rejects interactive launch before start on %s",
    async (kind) => {
      const options = kind === "missing opt-in" ? { interactiveStdin: undefined } : {};
      const f = await connect(
        options as Partial<StdioProcessHostClientOptions>,
        kind !== "missing capability",
      );
      await expect(f.client.start(spec(), new AbortController().signal)).rejects.toMatchObject({
        code: "STDIN_NOT_ENABLED",
      });
      expect(f.host.requests).toEqual([]);
      if (kind === "missing opt-in") expect(f.argv).not.toContain("--interactive-stdin");
      expect(f.host.killed).toBe(false);
    },
  );

  it("copies mutable input before yielding and waits for an exact acknowledgement", async () => {
    const f = await connect();
    const process = await start(f);
    const bytes = new Uint8Array([1, 2, 3]);
    let settled = false;
    const writing = input(process.managed)
      .write(bytes)
      .then(() => {
        settled = true;
      });
    bytes.fill(9);
    const sent = await request(f.host, "stdin_write");
    expect(Buffer.from(sent.dataBase64, "base64")).toEqual(Buffer.from([1, 2, 3]));
    expect(sent.sequence).toBe(1);
    expect(settled).toBe(false);
    ack(f.host, sent);
    await writing;
    exited(f.host, process);
    await process.managed.completed;
  });

  it("accepts an ACK before the control write callback succeeds", async () => {
    const f = await connect();
    const process = await start(f);
    f.host.holdCallback = true;
    const writing = input(process.managed).write(Buffer.from("first"));
    ack(f.host, await request(f.host, "stdin_write"));
    await writing;
    expect(f.host.heldCallback).toBeDefined();
    f.host.holdCallback = false;
    f.host.releaseWrite();
    const next = input(process.managed).write(Buffer.from("next"));
    ack(f.host, await request(f.host, "stdin_write", 2));
    await next;
    exited(f.host, process);
    await process.managed.completed;
    expect(f.host.killed).toBe(false);
  });

  it("fails the Host when the control write callback fails after a successful ACK", async () => {
    const f = await connect();
    const process = await start(f);
    f.host.holdCallback = true;
    const writing = input(process.managed).write(Buffer.from("first"));
    ack(f.host, await request(f.host, "stdin_write"));
    await writing;
    expect(f.host.heldCallback).toBeDefined();
    const completion = expect(process.managed.completed).rejects.toBeInstanceOf(
      ProcessHostProtocolError,
    );
    f.host.holdCallback = false;
    f.host.releaseWrite(new Error("Synthetic control pipe failure."));
    await completion;
    expect(f.host.killed).toBe(true);
  });

  it("requires the requested stdin stream before exposing a handle and drains a rejected start", async () => {
    const f = await connect();
    const sibling = await start(f, 201);
    const starting = f.client.start(spec(), new AbortController().signal);
    const sent = await request(f.host, "start", 2);
    let settled = false;
    void starting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    f.host.event({
      protocolVersion: "1.0",
      type: "started",
      requestId: sent.requestId,
      processId: 200,
    });
    await terminated(f.host, sent);
    expect(settled).toBe(false);
    exited(f.host, sent, 1);
    await expect(starting).rejects.toMatchObject({ code: "STDIN_NOT_ENABLED" });
    exited(f.host, sibling);
    await sibling.managed.completed;
    expect(f.host.killed).toBe(false);
  });

  it("rejects a stream ID on a noninteractive start", async () => {
    const f = await connect();
    const { interactiveStdin: _unused, ...ordinary } = spec();
    const starting = f.client.start(ordinary, new AbortController().signal);
    const sent = await request(f.host, "start");
    f.host.event({
      protocolVersion: "1.0",
      type: "started",
      requestId: sent.requestId,
      processId: 200,
      stdinStreamId: "a".repeat(64),
    });
    await expect(starting).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(f.host.killed).toBe(true);
  });

  it("does not invoke typed-array metadata getters or accept shared memory", async () => {
    const f = await connect();
    const process = await start(f);
    const bytes = new Uint8Array([1]);
    const getter = vi.fn(() => {
      throw new Error("private byte metadata");
    });
    Object.defineProperty(bytes, "byteLength", { get: getter });
    Object.defineProperty(bytes, "buffer", { get: getter });
    const writing = input(process.managed).write(bytes);
    ack(f.host, await request(f.host, "stdin_write"));
    await writing;
    expect(getter).not.toHaveBeenCalled();
    await expect(
      input(process.managed).write(new Uint8Array(new SharedArrayBuffer(1))),
    ).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(f.host.requests.filter((entry) => entry.type === "stdin_write")).toHaveLength(1);
  });

  it("rejects concurrent write and close without queueing or consuming sequence", async () => {
    const f = await connect();
    const process = await start(f);
    const stream = input(process.managed);
    const first = stream.write(Buffer.from("first"));
    await expect(stream.write(Buffer.from("second"))).rejects.toMatchObject({ code: "STDIN_BUSY" });
    await expect(stream.close()).rejects.toMatchObject({ code: "STDIN_BUSY" });
    ack(f.host, await request(f.host, "stdin_write"));
    await first;
    const second = stream.write(Buffer.from("last"));
    const sent = await request(f.host, "stdin_write", 2);
    expect(sent.sequence).toBe(2);
    ack(f.host, sent);
    await second;
    expect(f.host.requests.filter((entry) => entry.type === "stdin_close")).toHaveLength(0);
  });

  it("shares one close promise and never writes or resends after EOF admission", async () => {
    const f = await connect();
    const process = await start(f);
    const stream = input(process.managed);
    const closing = stream.close();
    expect(stream.close()).toBe(closing);
    await expect(stream.write(Buffer.from("late"))).rejects.toMatchObject({ code: "STDIN_CLOSED" });
    const sent = await request(f.host, "stdin_close");
    ack(f.host, sent);
    await closing;
    expect(stream.close()).toBe(closing);
    exited(f.host, process);
    await process.managed.completed;
    expect(stream.close()).toBe(closing);
    expect(f.host.requests.filter((entry) => entry.type === "stdin_close")).toHaveLength(1);
  });

  it.each([0, 65537])("rejects a %s-byte chunk before writing", async (size) => {
    const f = await connect();
    const process = await start(f);
    await expect(input(process.managed).write(new Uint8Array(size))).rejects.toMatchObject({
      code: "STDIN_LIMIT_EXCEEDED",
    });
    expect(f.host.requests.filter((entry) => entry.type === "stdin_write")).toHaveLength(0);
    const closing = input(process.managed).close();
    const sent = await request(f.host, "stdin_close");
    expect(sent.sequence).toBe(1);
    ack(f.host, sent);
    await closing;
  });

  it("bounds accepted bytes to 8 MiB while retaining a close operation", async () => {
    const f = await connect();
    const process = await start(f);
    const stream = input(process.managed);
    for (let index = 1; index <= 128; index++) {
      const writing = stream.write(new Uint8Array(65536));
      ack(f.host, await request(f.host, "stdin_write", index));
      await writing;
    }
    await expect(stream.write(new Uint8Array(1))).rejects.toMatchObject({
      code: "STDIN_LIMIT_EXCEEDED",
    });
    const closing = stream.close();
    const sent = await request(f.host, "stdin_close");
    expect(sent.sequence).toBe(129);
    ack(f.host, sent);
    await closing;
    expect(f.host.requests.filter((entry) => entry.type === "stdin_write")).toHaveLength(128);
  });

  it("counts close inside the 1024-operation budget", async () => {
    const f = await connect();
    const process = await start(f);
    const stream = input(process.managed);
    for (let index = 1; index <= 1023; index++) {
      const writing = stream.write(new Uint8Array([1]));
      ack(f.host, await request(f.host, "stdin_write", index));
      await writing;
    }
    const closing = stream.close();
    const sent = await request(f.host, "stdin_close");
    expect(sent.sequence).toBe(1024);
    ack(f.host, sent);
    await closing;
  });

  it("rejects further write or close admission after all 1024 operations were used", async () => {
    const f = await connect();
    const process = await start(f);
    const stream = input(process.managed);
    for (let index = 1; index <= 1024; index++) {
      const writing = stream.write(new Uint8Array([1]));
      ack(f.host, await request(f.host, "stdin_write", index));
      await writing;
    }
    await expect(stream.write(new Uint8Array([2]))).rejects.toMatchObject({
      code: "STDIN_LIMIT_EXCEEDED",
    });
    await expect(stream.close()).rejects.toMatchObject({ code: "STDIN_LIMIT_EXCEEDED" });
    expect(f.host.requests.filter((entry) => entry.type === "stdin_write")).toHaveLength(1024);
    expect(f.host.requests.filter((entry) => entry.type === "stdin_close")).toHaveLength(0);
  });

  it("keeps stdout and stdin sequences independent", async () => {
    const f = await connect();
    const process = await start(f);
    const chunks: string[] = [];
    process.managed.stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    const writing = input(process.managed).write(Buffer.from("request"));
    const sent = await request(f.host, "stdin_write");
    f.host.event({
      protocolVersion: "1.0",
      type: "stdout",
      requestId: process.requestId,
      sequence: 0,
      dataBase64: Buffer.from("response").toString("base64"),
    });
    ack(f.host, sent);
    await writing;
    expect(chunks).toEqual(["response"]);
    exited(f.host, process);
    await process.managed.completed;
  });

  it.each(["requestId", "stdinStreamId", "sequence", "operation", "bytesWritten"] as const)(
    "fails the Host for a mismatched ACK %s",
    async (key) => {
      const f = await connect();
      const process = await start(f);
      const writing = input(process.managed).write(Buffer.from("data"));
      const sent = await request(f.host, "stdin_write");
      const overrides =
        key === "requestId"
          ? { requestId: "foreign" }
          : key === "stdinStreamId"
            ? { stdinStreamId: "f".repeat(64) }
            : key === "sequence"
              ? { sequence: 2 }
              : key === "operation"
                ? { operation: "close" as const, bytesWritten: 0 }
                : { bytesWritten: 3 };
      ack(f.host, sent, overrides);
      await expect(writing).rejects.toBeInstanceOf(ProcessHostProtocolError);
      await expect(process.managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);
      expect(f.host.killed).toBe(true);
    },
  );

  it("terminates only the failed input process and continues draining both output streams", async () => {
    const f = await connect();
    const process = await start(f);
    const sibling = await start(f, 201);
    const chunks: string[] = [];
    process.managed.stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    process.managed.stderr.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    const writing = input(process.managed).write(Buffer.from("request"));
    const sent = await request(f.host, "stdin_write");
    ack(f.host, sent, { status: "failed", code: "STDIN_WRITE_FAILED", bytesWritten: 2 });
    await expect(writing).rejects.toMatchObject({ code: "STDIN_WRITE_FAILED" });
    await terminated(f.host, process);
    f.host.event({
      protocolVersion: "1.0",
      type: "stdout",
      requestId: process.requestId,
      sequence: 0,
      dataBase64: Buffer.from("out").toString("base64"),
    });
    f.host.event({
      protocolVersion: "1.0",
      type: "stderr",
      requestId: process.requestId,
      sequence: 1,
      dataBase64: Buffer.from("err").toString("base64"),
    });
    exited(f.host, process, 1);
    await expect(process.managed.completed).rejects.toMatchObject({ code: "STDIN_WRITE_FAILED" });
    exited(f.host, sibling);
    await expect(sibling.managed.completed).resolves.toMatchObject({ exitCode: 0 });
    expect(chunks).toEqual(["out", "err"]);
    expect(f.host.killed).toBe(false);
    expect(
      f.host.requests.filter((entry) => entry.type === "terminate").map((entry) => entry.requestId),
    ).toEqual([process.requestId]);
  });

  it("waits for a rejected stdin ACK after exit instead of completing successfully", async () => {
    const f = await connect();
    const process = await start(f);
    let completed = false;
    void process.managed.completed.then(
      () => {
        completed = true;
      },
      () => undefined,
    );
    const writing = input(process.managed).write(Buffer.from("request"));
    const sent = await request(f.host, "stdin_write");
    exited(f.host, process);
    await Promise.resolve();
    expect(completed).toBe(false);
    ack(f.host, sent, { status: "failed", code: "STDIN_PROCESS_NOT_RUNNING", bytesWritten: 0 });
    await expect(writing).rejects.toMatchObject({ code: "STDIN_PROCESS_NOT_RUNNING" });
    await expect(process.managed.completed).rejects.toMatchObject({
      code: "STDIN_PROCESS_NOT_RUNNING",
    });
    expect(f.host.requests.some((entry) => entry.type === "terminate")).toBe(false);
    expect(f.host.killed).toBe(false);
  });

  it("releases an exited PID before ACK and never removes the new owner's PID registration", async () => {
    const f = await connect({ maximumConcurrentRequests: 3 });
    const first = await start(f, 200);
    const writing = input(first.managed).write(Buffer.from("request"));
    const sent = await request(f.host, "stdin_write");
    exited(f.host, first);
    const replacement = await start(f, 200);
    ack(f.host, sent);
    await writing;
    await first.managed.completed;
    const thirdStart = f.client.start(spec(), new AbortController().signal);
    const third = await request(f.host, "start", 3);
    f.host.event({
      protocolVersion: "1.0",
      type: "started",
      requestId: third.requestId,
      processId: 200,
      stdinStreamId: "f".repeat(64),
    });
    await expect(thirdStart).rejects.toBeInstanceOf(ProcessHostProtocolError);
    await expect(replacement.managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(f.host.killed).toBe(true);
  });

  it("rejects cancellation safely, sends no queued payload, and terminates its process", async () => {
    const f = await connect();
    const process = await start(f);
    const controller = new AbortController();
    const writing = input(process.managed).write(
      Buffer.from("private RPC bytes"),
      controller.signal,
    );
    controller.abort(new Error("private cancellation reason"));
    const failure = await writing.catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "STDIN_CANCELLED" });
    expect(inspect(failure)).not.toContain("private");
    await terminated(f.host, process);
    expect(f.host.requests.filter((entry) => entry.type === "stdin_write")).toHaveLength(0);
    exited(f.host, process, 1);
    await expect(process.managed.completed).rejects.toMatchObject({ code: "STDIN_CANCELLED" });
    expect(f.host.killed).toBe(false);
  });

  it("does not turn a cancelled in-flight write into success when its ACK arrives before exit", async () => {
    const f = await connect();
    const process = await start(f);
    const controller = new AbortController();
    const writing = input(process.managed).write(Buffer.from("request"), controller.signal);
    const sent = await request(f.host, "stdin_write");
    controller.abort();
    await expect(writing).rejects.toMatchObject({ code: "STDIN_CANCELLED" });
    ack(f.host, sent);
    await terminated(f.host, process);
    exited(f.host, process, 1);
    await expect(process.managed.completed).rejects.toMatchObject({ code: "STDIN_CANCELLED" });
    expect(f.host.requests.filter((entry) => entry.type === "stdin_write")).toHaveLength(1);
    expect(f.host.killed).toBe(false);
  });

  it("settles pending input on process cancellation while preserving the original completion reason", async () => {
    const f = await connect();
    const process = await start(f);
    const writing = input(process.managed).write(Buffer.from("request"));
    const sent = await request(f.host, "stdin_write");
    const reason = new Error("Parent attempt cancelled.");
    process.controller.abort(reason);
    await expect(writing).rejects.toMatchObject({ code: "STDIN_CANCELLED" });
    ack(f.host, sent, { status: "failed", code: "STDIN_CANCELLED", bytesWritten: 0 });
    await terminated(f.host, process);
    exited(f.host, process, 1);
    await expect(process.managed.completed).rejects.toBe(reason);
    expect(f.host.killed).toBe(false);
  });

  it("keeps a failed EOF close idempotent and terminates only its process", async () => {
    const f = await connect();
    const process = await start(f);
    const stream = input(process.managed);
    const closing = stream.close();
    const sent = await request(f.host, "stdin_close");
    ack(f.host, sent, { status: "failed", code: "STDIN_CLOSE_FAILED", bytesWritten: 0 });
    await expect(closing).rejects.toMatchObject({ code: "STDIN_CLOSE_FAILED" });
    expect(stream.close()).toBe(closing);
    await terminated(f.host, process);
    exited(f.host, process, 1);
    await expect(process.managed.completed).rejects.toMatchObject({ code: "STDIN_CLOSE_FAILED" });
    expect(f.host.requests.filter((entry) => entry.type === "stdin_close")).toHaveLength(1);
  });

  it("closes the Host after pending input has failed and both process lifecycles have drained", async () => {
    const f = await connect();
    const process = await start(f);
    const sibling = await start(f, 201);
    const writing = input(process.managed).write(Buffer.from("request"));
    const sent = await request(f.host, "stdin_write");
    const closing = f.client.close();
    await request(f.host, "terminate", 2);
    ack(f.host, sent, { status: "failed", code: "STDIN_CANCELLED", bytesWritten: 0 });
    await expect(writing).rejects.toMatchObject({ code: "STDIN_CANCELLED" });
    for (const entry of [process, sibling]) {
      f.host.event({
        protocolVersion: "1.0",
        type: "terminated",
        requestId: entry.requestId,
        reason: "worker_shutdown",
      });
      exited(f.host, entry, 1);
    }
    await expect(process.managed.completed).rejects.toMatchObject({ code: "STDIN_CANCELLED" });
    await sibling.managed.completed;
    const shutdown = await request(f.host, "shutdown");
    f.host.event({
      protocolVersion: "1.0",
      type: "shutdown_complete",
      requestId: shutdown.requestId,
    });
    f.host.stop();
    await closing;
    expect(f.host.killed).toBe(false);
  });

  it("consumes one matching late ACK after cancelled process exit without resurrecting success", async () => {
    const f = await connect();
    const process = await start(f);
    const controller = new AbortController();
    const writing = input(process.managed).write(Buffer.from("request"), controller.signal);
    const sent = await request(f.host, "stdin_write");
    controller.abort();
    await expect(writing).rejects.toMatchObject({ code: "STDIN_CANCELLED" });
    await terminated(f.host, process);
    exited(f.host, process, 1);
    await expect(process.managed.completed).rejects.toMatchObject({ code: "STDIN_CANCELLED" });
    const sibling = await start(f, 201);
    ack(f.host, sent, { status: "failed", code: "STDIN_CANCELLED", bytesWritten: 0 });
    expect(f.host.killed).toBe(false);
    ack(f.host, sent, { status: "failed", code: "STDIN_CANCELLED", bytesWritten: 0 });
    await expect(sibling.managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(f.host.killed).toBe(true);
  });

  it("times out an unsettled ACK locally while preserving the sibling process", async () => {
    vi.useFakeTimers();
    const f = await connect({ requestTimeoutMs: 100, shutdownTimeoutMs: 1000 });
    const process = await start(f);
    const sibling = await start(f, 201);
    const writing = input(process.managed).write(Buffer.from("request"));
    await request(f.host, "stdin_write");
    const rejected = expect(writing).rejects.toMatchObject({ code: "STDIN_WRITE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10100);
    await rejected;
    await terminated(f.host, process);
    exited(f.host, process, 1);
    await expect(process.managed.completed).rejects.toMatchObject({ code: "STDIN_WRITE_TIMEOUT" });
    exited(f.host, sibling);
    await expect(sibling.managed.completed).resolves.toMatchObject({ exitCode: 0 });
    expect(f.host.killed).toBe(false);
  });

  it("bounds exit-before-ACK waiting and expires late-result state", async () => {
    vi.useFakeTimers();
    const f = await connect({ requestTimeoutMs: 100 });
    const process = await start(f);
    const writing = input(process.managed).write(Buffer.from("request"));
    const sent = await request(f.host, "stdin_write");
    exited(f.host, process);
    const rejected = expect(writing).rejects.toMatchObject({ code: "STDIN_WRITE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10100);
    await rejected;
    await expect(process.managed.completed).rejects.toMatchObject({ code: "STDIN_WRITE_TIMEOUT" });
    expect(f.host.requests.some((entry) => entry.type === "terminate")).toBe(false);
    await vi.advanceTimersByTimeAsync(10100);
    const sibling = await start(f, 201);
    ack(f.host, sent, { status: "failed", code: "STDIN_PROCESS_NOT_RUNNING", bytesWritten: 0 });
    await expect(sibling.managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);
  });

  it("bounds late ACK capacity to twice the configured request capacity", async () => {
    const f = await connect({ maximumConcurrentRequests: 1 });
    const sent: ProcessHostStdinRequest[] = [];
    for (let index = 1; index <= 3; index++) {
      const process = await start(f);
      const controller = new AbortController();
      const writing = input(process.managed).write(Buffer.from("request"), controller.signal);
      sent.push(await request(f.host, "stdin_write", index));
      controller.abort();
      await expect(writing).rejects.toMatchObject({ code: "STDIN_CANCELLED" });
      await request(f.host, "terminate", index);
      f.host.event({
        protocolVersion: "1.0",
        type: "terminated",
        requestId: process.requestId,
        reason: "cancelled",
      });
      exited(f.host, process, 1);
      await expect(process.managed.completed).rejects.toMatchObject({ code: "STDIN_CANCELLED" });
    }
    const sibling = await start(f);
    const first = sent[0];
    if (!first) throw new Error("The fixture requires a prior input operation.");
    ack(f.host, first, { status: "failed", code: "STDIN_CANCELLED", bytesWritten: 0 });
    await expect(sibling.managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);
  });

  it("escalates when the Host cannot drain a terminated input process", async () => {
    vi.useFakeTimers();
    const f = await connect({ requestTimeoutMs: 100, shutdownTimeoutMs: 500 });
    const process = await start(f);
    const writing = input(process.managed).write(Buffer.from("request"));
    ack(f.host, await request(f.host, "stdin_write"), {
      status: "failed",
      code: "STDIN_WRITE_FAILED",
      bytesWritten: 0,
    });
    await expect(writing).rejects.toMatchObject({ code: "STDIN_WRITE_FAILED" });
    await terminated(f.host, process);
    await vi.advanceTimersByTimeAsync(500);
    await expect(process.managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(f.host.killed).toBe(true);
  });

  it("escalates a stalled shared Host control pipe", async () => {
    vi.useFakeTimers();
    const f = await connect({ requestTimeoutMs: 100 });
    const process = await start(f);
    f.host.blocked = true;
    const writing = input(process.managed).write(Buffer.from("request"));
    const rejected = expect(writing).rejects.toBeInstanceOf(ProcessHostProtocolError);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(f.host.killed).toBe(true);
  });
});
