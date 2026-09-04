import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  deriveWorkerProcessHostInstanceKey,
  type ProcessHostSpawn,
  type ProcessHostSpawnOptions,
  StdioProcessHostClient,
} from "./process-host-client.js";
import {
  type ProcessHostEvent,
  ProcessHostProtocolError,
  type ProcessHostRequest,
  type ProcessLaunchSpec,
  processHostMaximumFrameBytes,
  processHostProtocolVersion,
} from "./process-host-protocol.js";

class FakeProcessHost extends EventEmitter {
  public readonly pid = 4242;
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly requests: ProcessHostRequest[] = [];
  public readonly stdin: Writable;
  public killed = false;
  public blockWrites = false;
  #requestBuffer = "";
  #closed = false;

  public constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        if (this.blockWrites) {
          return;
        }
        this.#requestBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        let newline = this.#requestBuffer.indexOf("\n");
        while (newline !== -1) {
          const frame = this.#requestBuffer.slice(0, newline);
          this.#requestBuffer = this.#requestBuffer.slice(newline + 1);
          this.requests.push(JSON.parse(frame) as ProcessHostRequest);
          newline = this.#requestBuffer.indexOf("\n");
        }
        callback();
      },
    });
  }

  public asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  public writeEvent(event: ProcessHostEvent | Readonly<Record<string, unknown>>): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  public writeRaw(value: Buffer): void {
    this.stdout.write(value);
  }

  public closeHost(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", exitCode, signal);
  }

  public kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    queueMicrotask(() => this.closeHost(null, "SIGTERM"));
    return true;
  }

  public get closed(): boolean {
    return this.#closed;
  }
}

const launchSpec = (): ProcessLaunchSpec => ({
  executable: "C:\\Program Files\\Codex\\codex.exe",
  arguments: ["exec", "-"],
  workingDirectory: "C:\\AgenticReview\\jobs\\one",
  environmentMode: "replace",
  environment: { SystemRoot: "C:\\Windows" },
  standardInput: "Review this revision.",
  limits: {
    hardTimeoutMs: 60_000,
    maximumProcessCount: 16,
    maximumMemoryBytes: 1_073_741_824,
    maximumOutputBytes: 1_048_576,
  },
});

const readyEvent = (maximumConcurrentRequests = 4): ProcessHostEvent => ({
  protocolVersion: processHostProtocolVersion,
  type: "ready",
  processHostPid: 4242,
  capabilities: {
    concurrentRequests: true,
    maximumConcurrentRequests,
    maximumFrameBytes: processHostMaximumFrameBytes,
  },
});

const defaultInstanceKey = "a".repeat(64);

interface TestTimeoutOptions {
  readonly requestTimeoutMs?: number;
  readonly startTimeoutMs?: number;
}

async function connect(
  maximumConcurrentRequests = 4,
  timeouts: TestTimeoutOptions = {},
): Promise<{
  readonly child: FakeProcessHost;
  readonly client: StdioProcessHostClient;
  readonly spawn: {
    path: string;
    argumentsList: readonly string[];
    options: ProcessHostSpawnOptions;
  };
}> {
  const child = new FakeProcessHost();
  let captured:
    | {
        path: string;
        argumentsList: readonly string[];
        options: ProcessHostSpawnOptions;
      }
    | undefined;
  const spawnProcess: ProcessHostSpawn = (path, argumentsList, options) => {
    captured = { path, argumentsList: [...argumentsList], options };
    return child.asChild();
  };
  const connected = StdioProcessHostClient.create({
    processHostPath: "C:\\Program Files\\AgenticReview\\AgenticReview.ProcessHost.exe",
    instanceKey: defaultInstanceKey,
    maximumConcurrentRequests,
    hostEnvironment: {
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Windows\\Temp",
      SECRET_TOKEN: "must-not-be-inherited",
    },
    ...timeouts,
    spawnProcess,
  });
  child.writeEvent(readyEvent(maximumConcurrentRequests));
  const client = await connected;
  if (captured === undefined) throw new Error("The ProcessHost spawner was not called.");
  return { child, client, spawn: captured };
}

async function waitForRequests(
  child: FakeProcessHost,
  type: ProcessHostRequest["type"],
  count = 1,
): Promise<ProcessHostRequest[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const requests = child.requests.filter((request) => request.type === type);
    if (requests.length >= count) return requests;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${count} ${type} request(s).`);
}

async function startOne(client: StdioProcessHostClient, child: FakeProcessHost, processId = 5001) {
  const previousStartCount = child.requests.filter((request) => request.type === "start").length;
  const starting = client.start(launchSpec(), new AbortController().signal);
  const request = (await waitForRequests(child, "start", previousStartCount + 1)).at(-1);
  if (request === undefined) throw new Error("Missing start request.");
  child.writeEvent({
    protocolVersion: processHostProtocolVersion,
    type: "started",
    requestId: request.requestId,
    processId,
  });
  return { managed: await starting, requestId: request.requestId };
}

async function closeNormally(
  client: StdioProcessHostClient,
  child: FakeProcessHost,
): Promise<void> {
  const closing = client.close();
  const request = (await waitForRequests(child, "shutdown")).at(-1);
  if (request === undefined) throw new Error("Missing shutdown request.");
  child.writeEvent({
    protocolVersion: processHostProtocolVersion,
    type: "shutdown_complete",
    requestId: request.requestId,
  });
  child.closeHost(0, null);
  await closing;
}

describe("StdioProcessHostClient", () => {
  it("derives a deterministic instance key from worker identity roots", () => {
    const first = deriveWorkerProcessHostInstanceKey({
      dataDirectory: "D:/AgenticReview/Data/",
    });
    const second = deriveWorkerProcessHostInstanceKey({
      dataDirectory: "d:\\agenticreview\\data",
    });
    const different = deriveWorkerProcessHostInstanceKey({
      dataDirectory: "E:\\AgenticReview\\Data",
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toBe(first);
    expect(different).not.toBe(first);
  });

  it.each([
    "C:\\AgenticReview\\..\\Other\\ProcessHost.exe",
    "C:\\AgenticReview\\ProcessHost.exe:payload",
    "C:\\CON.exe",
    "C:\\AgenticReview.\\ProcessHost.exe",
  ])("rejects unsafe ProcessHost path before spawn: %s", async (processHostPath) => {
    const child = new FakeProcessHost();
    let spawned = false;

    await expect(
      StdioProcessHostClient.create({
        processHostPath,
        instanceKey: defaultInstanceKey,
        maximumConcurrentRequests: 1,
        spawnProcess: () => {
          spawned = true;
          return child.asChild();
        },
      }),
    ).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(spawned).toBe(false);
  });

  it.each(["", "A".repeat(64), `${"a".repeat(63)}g`])(
    "rejects invalid instance keys before spawn: %s",
    async (instanceKey) => {
      const child = new FakeProcessHost();
      let spawned = false;

      await expect(
        StdioProcessHostClient.create({
          processHostPath: "C:\\AgenticReview\\AgenticReview.ProcessHost.exe",
          instanceKey,
          maximumConcurrentRequests: 1,
          spawnProcess: () => {
            spawned = true;
            return child.asChild();
          },
        }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(spawned).toBe(false);
    },
  );

  it("uses a minimal spawn boundary and multiplexes sequenced output", async () => {
    const { child, client, spawn } = await connect();
    expect(spawn.path).toMatch(/ProcessHost\.exe$/u);
    expect(spawn.argumentsList).toEqual([
      "--stdio",
      "--max-concurrent-requests",
      "4",
      "--instance-key",
      defaultInstanceKey,
    ]);
    expect(spawn.options).toMatchObject({ shell: false, windowsHide: true, detached: false });
    expect(spawn.options.env.SECRET_TOKEN).toBeUndefined();

    const firstStart = client.start(launchSpec(), new AbortController().signal);
    const secondStart = client.start(launchSpec(), new AbortController().signal);
    const starts = await waitForRequests(child, "start", 2);
    const firstId = starts[0]?.requestId;
    const secondId = starts[1]?.requestId;
    if (firstId === undefined || secondId === undefined) throw new Error("Missing request IDs.");
    child.writeEvent({
      protocolVersion: "1.0",
      type: "started",
      requestId: firstId,
      processId: 5001,
    });
    child.writeEvent({
      protocolVersion: "1.0",
      type: "started",
      requestId: secondId,
      processId: 5002,
    });
    const [first, second] = await Promise.all([firstStart, secondStart]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    first.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    first.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.writeEvent({
      protocolVersion: "1.0",
      type: "stdout",
      requestId: firstId,
      sequence: 0,
      dataBase64: Buffer.from("one").toString("base64"),
    });
    child.writeEvent({
      protocolVersion: "1.0",
      type: "stderr",
      requestId: firstId,
      sequence: 1,
      dataBase64: Buffer.from("two").toString("base64"),
    });
    child.writeEvent({
      protocolVersion: "1.0",
      type: "output_truncated",
      requestId: firstId,
      sequence: 2,
      stream: "combined",
      discardedBytes: 3,
    });
    child.writeEvent({
      protocolVersion: "1.0",
      type: "exited",
      requestId: firstId,
      exitCode: 0,
      signal: null,
      outputTruncated: true,
    });
    child.writeEvent({
      protocolVersion: "1.0",
      type: "exited",
      requestId: secondId,
      exitCode: 0,
      signal: null,
      outputTruncated: false,
    });

    await Promise.all([first.completed, second.completed]);
    expect(Buffer.concat(stdout).toString("utf8")).toBe("one");
    expect(Buffer.concat(stderr).toString("utf8")).toBe("two");
    await closeNormally(client, child);
  });

  it("rejects unsafe launch paths before writing a start frame", async () => {
    const { child, client } = await connect();
    await expect(
      client.start(
        { ...launchSpec(), executable: "C:\\Jobs\\CON.exe" },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ProcessHostProtocolError);
    await expect(
      client.start(
        { ...launchSpec(), workingDirectory: "C:\\Jobs\\..\\Secrets" },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(child.requests.filter((request) => request.type === "start")).toHaveLength(0);
    await closeNormally(client, child);
  });

  it("binds configured concurrency to spawn, handshake, and local admission", async () => {
    for (const maximumConcurrentRequests of [0, 65]) {
      const child = new FakeProcessHost();
      let spawned = false;
      await expect(
        StdioProcessHostClient.create({
          processHostPath: "C:\\AgenticReview\\AgenticReview.ProcessHost.exe",
          instanceKey: defaultInstanceKey,
          maximumConcurrentRequests,
          spawnProcess: () => {
            spawned = true;
            return child.asChild();
          },
        }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(spawned).toBe(false);
    }

    const limited = await connect(1);
    const firstStart = limited.client.start(launchSpec(), new AbortController().signal);
    const request = (await waitForRequests(limited.child, "start")).at(-1);
    if (request === undefined) throw new Error("Missing start request.");
    await expect(limited.client.start(launchSpec(), new AbortController().signal)).rejects.toThrow(
      /at most 1 active request/u,
    );
    limited.child.writeEvent({
      protocolVersion: "1.0",
      type: "started",
      requestId: request.requestId,
      processId: 5001,
    });
    const managed = await firstStart;
    limited.child.writeEvent({
      protocolVersion: "1.0",
      type: "exited",
      requestId: request.requestId,
      exitCode: 0,
      signal: null,
      outputTruncated: false,
    });
    await managed.completed;
    await closeNormally(limited.client, limited.child);

    const mismatched = new FakeProcessHost();
    const connecting = StdioProcessHostClient.create({
      processHostPath: "C:\\AgenticReview\\AgenticReview.ProcessHost.exe",
      instanceKey: defaultInstanceKey,
      maximumConcurrentRequests: 4,
      spawnProcess: () => mismatched.asChild(),
    });
    mismatched.writeEvent(readyEvent(3));
    await expect(connecting).rejects.toThrow(/unexpected concurrent request capacity/u);
    expect(mismatched.killed).toBe(true);
  });

  it("fails the host when a control write or start acknowledgement stalls", async () => {
    const writeStalled = await connect(4, { requestTimeoutMs: 10, startTimeoutMs: 100 });
    writeStalled.child.blockWrites = true;
    await expect(
      writeStalled.client.start(launchSpec(), new AbortController().signal),
    ).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(writeStalled.child.killed).toBe(true);

    const startStalled = await connect(4, { requestTimeoutMs: 100, startTimeoutMs: 10 });
    const starting = startStalled.client.start(launchSpec(), new AbortController().signal);
    await waitForRequests(startStalled.child, "start");
    await expect(starting).rejects.toThrow(/did not acknowledge start/u);
    expect(startStalled.child.killed).toBe(true);
  });

  it("fails the host when a pending start is aborted", async () => {
    const { child, client } = await connect();
    const controller = new AbortController();
    const starting = client.start(launchSpec(), controller.signal);
    await waitForRequests(child, "start");
    controller.abort(new Error("lease lost before start"));

    await expect(starting).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(child.killed).toBe(true);
  });

  it("fails active work when protocol stdout ends after a complete frame", async () => {
    const { child, client } = await connect();
    const { managed } = await startOne(client, child);
    child.stdout.end();

    await expect(managed.completed).rejects.toThrow(/stdout ended before shutdown/u);
    expect(child.killed).toBe(true);
  });

  it.each(["stdin", "stdout", "stderr"] as const)(
    "handles a ProcessHost %s stream error by failing active work",
    async (streamName) => {
      const { child, client } = await connect();
      const { managed } = await startOne(client, child);
      child[streamName].emit("error", new Error(`${streamName} failed`));

      await expect(managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);
      expect(child.killed).toBe(true);
    },
  );

  it("requires a terminate acknowledgement before accepting exit", async () => {
    const { child, client } = await connect();
    const { managed, requestId } = await startOne(client, child);
    const terminating = managed.terminate("lease_lost");
    await waitForRequests(child, "terminate");
    child.writeEvent({
      protocolVersion: "1.0",
      type: "terminated",
      requestId,
      reason: "lease_lost",
    });
    await terminating;
    child.writeEvent({
      protocolVersion: "1.0",
      type: "exited",
      requestId,
      exitCode: 1,
      signal: null,
      outputTruncated: false,
    });
    await managed.completed;
    await closeNormally(client, child);
  });

  it("treats a natural exit racing with terminate as the terminal acknowledgement", async () => {
    const { child, client } = await connect();
    const { managed, requestId } = await startOne(client, child);
    const terminating = managed.terminate("cancelled");
    await waitForRequests(child, "terminate");
    child.writeEvent({
      protocolVersion: "1.0",
      type: "error",
      requestId,
      code: "PROCESS_NOT_RUNNING",
      message: "The process exited before termination was handled.",
    });
    child.writeEvent({
      protocolVersion: "1.0",
      type: "exited",
      requestId,
      exitCode: 0,
      signal: null,
      outputTruncated: false,
    });

    await terminating;
    await expect(managed.completed).resolves.toMatchObject({ exitCode: 0 });
    await closeNormally(client, child);
  });

  it("consumes one late not-found error for a settled client termination", async () => {
    const { child, client } = await connect(2);
    const terminated = await startOne(client, child, 5001);
    const shared = await startOne(client, child, 5002);
    const terminating = terminated.managed.terminate("cancelled");
    await waitForRequests(child, "terminate");
    child.writeEvent({
      protocolVersion: "1.0",
      type: "exited",
      requestId: terminated.requestId,
      exitCode: 0,
      signal: null,
      outputTruncated: false,
    });
    await Promise.all([terminating, terminated.managed.completed]);

    const lateError = {
      protocolVersion: "1.0",
      type: "error",
      requestId: terminated.requestId,
      code: "PROCESS_NOT_FOUND",
      message: "The terminate request arrived after process exit.",
    } as const;
    child.writeEvent(lateError);
    expect(child.killed).toBe(false);
    child.writeEvent({
      protocolVersion: "1.0",
      type: "exited",
      requestId: shared.requestId,
      exitCode: 0,
      signal: null,
      outputTruncated: false,
    });
    await shared.managed.completed;

    child.writeEvent(lateError);
    expect(child.killed).toBe(true);
  });

  it("fails the shared host for an unknown request without a termination tombstone", async () => {
    const { child, client } = await connect(2);
    const completed = await startOne(client, child, 5001);
    const shared = await startOne(client, child, 5002);
    child.writeEvent({
      protocolVersion: "1.0",
      type: "exited",
      requestId: completed.requestId,
      exitCode: 0,
      signal: null,
      outputTruncated: false,
    });
    await completed.managed.completed;
    child.writeEvent({
      protocolVersion: "1.0",
      type: "error",
      requestId: completed.requestId,
      code: "PROCESS_NOT_RUNNING",
      message: "Unknown completed request.",
    });

    await expect(shared.managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(child.killed).toBe(true);
  });

  it("does not retain a tombstone after an explicit termination acknowledgement", async () => {
    const { child, client } = await connect(2);
    const terminated = await startOne(client, child, 5001);
    const shared = await startOne(client, child, 5002);
    const terminating = terminated.managed.terminate("cancelled");
    await waitForRequests(child, "terminate");
    child.writeEvent({
      protocolVersion: "1.0",
      type: "terminated",
      requestId: terminated.requestId,
      reason: "cancelled",
    });
    await terminating;
    child.writeEvent({
      protocolVersion: "1.0",
      type: "exited",
      requestId: terminated.requestId,
      exitCode: 0,
      signal: null,
      outputTruncated: false,
    });
    await terminated.managed.completed;
    child.writeEvent({
      protocolVersion: "1.0",
      type: "error",
      requestId: terminated.requestId,
      code: "PROCESS_NOT_FOUND",
      message: "An acknowledged termination must not leave a tombstone.",
    });

    await expect(shared.managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(child.killed).toBe(true);
  });

  it("fails the shared host immediately when kernel termination cannot be enforced", async () => {
    const { child, client } = await connect(2);
    const terminated = await startOne(client, child, 5001);
    const shared = await startOne(client, child, 5002);
    const terminating = terminated.managed.terminate("lease_lost");
    await waitForRequests(child, "terminate");
    child.writeEvent({
      protocolVersion: "1.0",
      type: "error",
      requestId: terminated.requestId,
      code: "PROCESS_TERMINATION_FAILED",
      message: "The Job Object could not be terminated.",
    });

    await expect(terminating).rejects.toBeInstanceOf(ProcessHostProtocolError);
    await expect(shared.managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(child.killed).toBe(true);
  });

  it("bounds settled termination tombstones to twice the configured capacity", async () => {
    const { child, client } = await connect(1);
    const settledRequestIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const process = await startOne(client, child);
      const terminating = process.managed.terminate("cancelled");
      await waitForRequests(child, "terminate", index + 1);
      child.writeEvent({
        protocolVersion: "1.0",
        type: "exited",
        requestId: process.requestId,
        exitCode: 0,
        signal: null,
        outputTruncated: false,
      });
      await Promise.all([terminating, process.managed.completed]);
      settledRequestIds.push(process.requestId);
    }

    const observer = await startOne(client, child);
    const oldestRequestId = settledRequestIds[0];
    if (oldestRequestId === undefined) throw new Error("Missing settled request ID.");
    child.writeEvent({
      protocolVersion: "1.0",
      type: "error",
      requestId: oldestRequestId,
      code: "PROCESS_NOT_FOUND",
      message: "The oldest tombstone must have been evicted.",
    });
    await expect(observer.managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(child.killed).toBe(true);
  });

  it("fails every active process on an out-of-order output sequence", async () => {
    const { child, client } = await connect();
    const { managed, requestId } = await startOne(client, child);
    child.writeEvent({
      protocolVersion: "1.0",
      type: "stdout",
      requestId,
      sequence: 1,
      dataBase64: Buffer.from("bad").toString("base64"),
    });
    await expect(managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(child.killed).toBe(true);
  });

  it("rejects active work when the host exits or the process signal aborts", async () => {
    const hostExit = await connect();
    const first = await startOne(hostExit.client, hostExit.child);
    hostExit.child.closeHost(9, null);
    await expect(first.managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);

    const aborted = await connect();
    const controller = new AbortController();
    const starting = aborted.client.start(launchSpec(), controller.signal);
    const request = (await waitForRequests(aborted.child, "start")).at(-1);
    if (request === undefined) throw new Error("Missing start request.");
    aborted.child.writeEvent({
      protocolVersion: "1.0",
      type: "started",
      requestId: request.requestId,
      processId: 5001,
    });
    const managed = await starting;
    controller.abort(new Error("lease lost"));
    await waitForRequests(aborted.child, "terminate");
    aborted.child.writeEvent({
      protocolVersion: "1.0",
      type: "terminated",
      requestId: request.requestId,
      reason: "cancelled",
    });
    aborted.child.writeEvent({
      protocolVersion: "1.0",
      type: "exited",
      requestId: request.requestId,
      exitCode: 1,
      signal: null,
      outputTruncated: false,
    });
    await expect(managed.completed).rejects.toThrow("lease lost");
    await closeNormally(aborted.client, aborted.child);
  });

  it("accepts a host-enforced timeout and bounds unread process output", async () => {
    const timedOut = await connect();
    const timeoutProcess = await startOne(timedOut.client, timedOut.child);
    timedOut.child.writeEvent({
      protocolVersion: "1.0",
      type: "terminated",
      requestId: timeoutProcess.requestId,
      reason: "timeout",
    });
    timedOut.child.writeEvent({
      protocolVersion: "1.0",
      type: "exited",
      requestId: timeoutProcess.requestId,
      exitCode: 1,
      signal: null,
      outputTruncated: false,
    });
    await expect(timeoutProcess.managed.completed).rejects.toMatchObject({
      code: "PROCESS_HARD_TIMEOUT",
    });
    await closeNormally(timedOut.client, timedOut.child);

    const overflow = await connect();
    const outputProcess = await startOne(overflow.client, overflow.child);
    const chunk = Buffer.alloc(600_000, 0x61).toString("base64");
    overflow.child.writeEvent({
      protocolVersion: "1.0",
      type: "stdout",
      requestId: outputProcess.requestId,
      sequence: 0,
      dataBase64: chunk,
    });
    overflow.child.writeEvent({
      protocolVersion: "1.0",
      type: "stdout",
      requestId: outputProcess.requestId,
      sequence: 1,
      dataBase64: chunk,
    });
    await waitForRequests(overflow.child, "terminate");
    overflow.child.writeEvent({
      protocolVersion: "1.0",
      type: "terminated",
      requestId: outputProcess.requestId,
      reason: "cancelled",
    });
    overflow.child.writeEvent({
      protocolVersion: "1.0",
      type: "exited",
      requestId: outputProcess.requestId,
      exitCode: 1,
      signal: null,
      outputTruncated: false,
    });
    await expect(outputProcess.managed.completed).rejects.toThrow("Buffered output");
    await closeNormally(overflow.client, overflow.child);
  });

  it("accepts a host timeout winning a pending client termination", async () => {
    const aborted = await connect();
    const controller = new AbortController();
    const starting = aborted.client.start(launchSpec(), controller.signal);
    const startRequest = (await waitForRequests(aborted.child, "start")).at(-1);
    if (startRequest === undefined) throw new Error("Missing start request.");
    aborted.child.writeEvent({
      protocolVersion: "1.0",
      type: "started",
      requestId: startRequest.requestId,
      processId: 5001,
    });
    const abortedProcess = await starting;
    const abortFailure = new Error("lease was lost");
    controller.abort(abortFailure);
    const abortTerminate = (await waitForRequests(aborted.child, "terminate")).at(-1);
    expect(abortTerminate).toMatchObject({ reason: "cancelled" });
    aborted.child.writeEvent({
      protocolVersion: "1.0",
      type: "terminated",
      requestId: startRequest.requestId,
      reason: "timeout",
    });
    aborted.child.writeEvent({
      protocolVersion: "1.0",
      type: "exited",
      requestId: startRequest.requestId,
      exitCode: 1,
      signal: null,
      outputTruncated: false,
    });
    await expect(abortedProcess.completed).rejects.toBe(abortFailure);
    expect(aborted.child.killed).toBe(false);
    await closeNormally(aborted.client, aborted.child);

    const timedOut = await connect();
    const timeoutProcess = await startOne(timedOut.client, timedOut.child);
    const terminating = timeoutProcess.managed.terminate("lease_lost");
    await waitForRequests(timedOut.child, "terminate");
    timedOut.child.writeEvent({
      protocolVersion: "1.0",
      type: "terminated",
      requestId: timeoutProcess.requestId,
      reason: "timeout",
    });
    await terminating;
    timedOut.child.writeEvent({
      protocolVersion: "1.0",
      type: "exited",
      requestId: timeoutProcess.requestId,
      exitCode: 1,
      signal: null,
      outputTruncated: false,
    });
    await expect(timeoutProcess.managed.completed).rejects.toMatchObject({
      code: "PROCESS_HARD_TIMEOUT",
    });
    expect(timedOut.child.killed).toBe(false);
    await closeNormally(timedOut.client, timedOut.child);
  });

  it("kills and reaps the host before rejecting a failed handshake", async () => {
    const child = new FakeProcessHost();
    const connecting = StdioProcessHostClient.create({
      processHostPath: "C:\\AgenticReview\\AgenticReview.ProcessHost.exe",
      instanceKey: defaultInstanceKey,
      maximumConcurrentRequests: 4,
      spawnProcess: () => child.asChild(),
    });
    child.writeEvent({
      protocolVersion: "2.0",
      type: "ready",
      processHostPid: 4242,
      capabilities: {
        concurrentRequests: true,
        maximumConcurrentRequests: 4,
        maximumFrameBytes: processHostMaximumFrameBytes,
      },
    });

    await expect(connecting).rejects.toBeInstanceOf(ProcessHostProtocolError);
    expect(child.killed).toBe(true);
    expect(child.closed).toBe(true);
  });

  it("fails closed on malformed, unknown, duplicate, and oversized events", async () => {
    for (const frame of [
      Buffer.from("not-json\n"),
      Buffer.from(`${JSON.stringify({ protocolVersion: "1.0", type: "unknown" })}\n`),
      Buffer.alloc(processHostMaximumFrameBytes + 1, 0x20),
    ]) {
      const { child, client } = await connect();
      const { managed } = await startOne(client, child);
      child.writeRaw(frame);
      await expect(managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);
      expect(child.killed).toBe(true);
    }

    const duplicate = await connect();
    const started = await startOne(duplicate.client, duplicate.child);
    duplicate.child.writeEvent({
      protocolVersion: "1.0",
      type: "started",
      requestId: started.requestId,
      processId: 5001,
    });
    await expect(started.managed.completed).rejects.toBeInstanceOf(ProcessHostProtocolError);
  });
});
