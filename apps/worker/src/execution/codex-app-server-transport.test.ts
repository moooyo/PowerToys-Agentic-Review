import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CodexAppServerNotification,
  type CodexAppServerTransport,
  type CodexAppServerTransportOptions,
  codexAppServerMethods,
  createCodexAppServerTransport,
} from "./codex-app-server-transport.js";
import type { ManagedProcess, ProcessExitedEvent } from "./process-host-protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Message = { id?: string; method: string; params?: unknown };
class Fixture {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exited = deferred<ProcessExitedEvent>();
  readonly chunks: Buffer[] = [];
  readonly messages: Message[] = [];
  readonly requests: Message[] = [];
  autoReply = true;
  finished = false;
  inFlightWrites = 0;
  peakWrites = 0;
  writeEffect: (() => Promise<void>) | undefined;
  closeEffect: (() => Promise<void>) | undefined;
  terminateEffect: (() => Promise<void>) | undefined;
  private input = Buffer.alloc(0);
  readonly write = vi.fn(async (bytes: Uint8Array, _signal?: AbortSignal) => {
    this.inFlightWrites += 1;
    this.peakWrites = Math.max(this.peakWrites, this.inFlightWrites);
    try {
      this.chunks.push(Buffer.from(bytes));
      this.input = Buffer.concat([this.input, bytes]);
      for (;;) {
        const newline = this.input.indexOf(10);
        if (newline < 0) break;
        const message = JSON.parse(this.input.subarray(0, newline).toString("utf8")) as Message;
        this.input = this.input.subarray(newline + 1);
        this.messages.push(message);
        if (message.id) {
          this.requests.push(message);
          if (this.autoReply) this.reply(message.id, { ok: true });
        }
      }
      await this.writeEffect?.();
    } finally {
      this.inFlightWrites -= 1;
    }
  });
  readonly closeInput = vi.fn(async (_signal?: AbortSignal) => {
    if (this.closeEffect) await this.closeEffect();
    else this.finish();
  });
  readonly terminate = vi.fn(async (_reason: string) => {
    if (this.terminateEffect) await this.terminateEffect();
    else this.finish();
  });
  readonly process: ManagedProcess = {
    requestId: "process:synthetic-app-server",
    processId: 42,
    stdin: { streamId: "a".repeat(64), write: this.write, close: this.closeInput },
    stdout: this.stdout,
    stderr: this.stderr,
    completed: this.exited.promise,
    terminate: this.terminate,
  };
  transport!: CodexAppServerTransport;
  finish(changes: Partial<ProcessExitedEvent> = {}) {
    if (this.finished) return;
    this.finished = true;
    this.stdout.end();
    this.stderr.end();
    this.exited.resolve({
      protocolVersion: "1.0",
      type: "exited",
      requestId: this.process.requestId,
      exitCode: 0,
      signal: null,
      outputTruncated: false,
      ...changes,
    });
  }
  raw(value: string | Uint8Array) {
    this.stdout.write(value);
  }
  reply(id: string, result: unknown) {
    this.raw(`${JSON.stringify({ id, result })}\n`);
  }
  requestAt(index = -1): Message & { id: string } {
    const request = this.requests.at(index);
    if (!request?.id) throw new Error("The synthetic request has not been written.");
    return { ...request, id: request.id };
  }
  notify(method = "thread/started", params: unknown = {}) {
    this.raw(`${JSON.stringify({ method, params })}\n`);
  }
  async ready() {
    await expect(
      this.transport.request("initialize", { clientInfo: { name: "fixture", version: "1" } }),
    ).resolves.toEqual({ ok: true });
    await this.transport.notifyInitialized();
    return this;
  }
}
const fixtures: Fixture[] = [];
const sparseArray = ["hole"];
Reflect.deleteProperty(sparseArray, "0");
function fixture(options: Omit<CodexAppServerTransportOptions, "process"> = {}) {
  const f = new Fixture();
  fixtures.push(f);
  f.transport = createCodexAppServerTransport({ process: f.process, ...options });
  return f;
}
async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.finish();
    await Promise.allSettled([f.transport.abort()]);
  }
  vi.useRealTimers();
});

describe("bounded Codex app-server stdio transport", () => {
  it("reports RPC response and stderr activity without requiring a notification", async () => {
    const onActivity = vi.fn();
    const f = fixture({ onActivity });
    await f.ready();
    const responsePulses = onActivity.mock.calls.length;
    expect(responsePulses).toBeGreaterThan(0);
    f.stderr.write(Buffer.from("synthetic diagnostic"));
    await flush();
    expect(onActivity.mock.calls.length).toBeGreaterThan(responsePulses);
    const closed = await f.transport.close();
    expect(closed).toMatchObject({ outcome: "closed", notificationCount: 0 });
  });

  it.each(["throw", "async"])(
    "drains its owned process after an %s activity observer failure",
    async (kind) => {
      const onActivity =
        kind === "throw"
          ? () => {
              throw new Error("Synthetic protected observer detail");
            }
          : async () => {
              throw new Error("Synthetic protected observer detail");
            };
      const f = fixture({ onActivity });
      await expect(f.transport.request("initialize", {})).rejects.toMatchObject({
        code: "ACTIVITY_OBSERVER_FAILED",
      });
      await expect(f.transport.completed).resolves.toMatchObject({
        outcome: "failed",
        failureCode: "ACTIVITY_OBSERVER_FAILED",
        stdoutEnded: true,
        stderrEnded: true,
      });
      expect(f.terminate).toHaveBeenCalledOnce();
    },
  );

  it("requires a verified interactive process without launching or terminating another process", () => {
    const f = new Fixture();
    const { stdin: _stdin, ...ordinary } = f.process;
    expect(() => createCodexAppServerTransport({ process: ordinary })).toThrowError(
      expect.objectContaining({ code: "INVALID_OPTIONS" }),
    );
    expect(f.terminate).not.toHaveBeenCalled();
    f.finish();
  });

  it("gates initialization, returns result values, and closes idempotently after immediate replies", async () => {
    const f = fixture();
    await expect(f.transport.request("config/read", {})).rejects.toMatchObject({
      code: "INVALID_PHASE",
    });
    await expect(f.transport.notifyInitialized()).rejects.toMatchObject({ code: "INVALID_PHASE" });
    await f.ready();
    await expect(f.transport.request("initialize", {})).rejects.toMatchObject({
      code: "INVALID_PHASE",
    });
    await expect(f.transport.notifyInitialized()).rejects.toMatchObject({ code: "INVALID_PHASE" });
    await expect(f.transport.request("configRequirements/read")).resolves.toEqual({ ok: true });
    expect(f.requests.at(-1)).not.toHaveProperty("params");
    const close = f.transport.close();
    expect(f.transport.close()).toBe(close);
    await expect(close).resolves.toMatchObject({
      outcome: "closed",
      failureCode: null,
      processId: 42,
      processRequestId: f.process.requestId,
      stdinStreamId: "a".repeat(64),
      stdoutEnded: true,
      stderrEnded: true,
    });
    expect(f.closeInput).toHaveBeenCalledOnce();
    expect(f.terminate).not.toHaveBeenCalled();
    await expect(f.transport.request("config/read", {})).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("sends the first RPC immediately after consecutive initialize and initialized awaits", async () => {
    const f = fixture({ limits: { requestTimeoutMs: 20 } });
    const exchange = (async () => {
      await f.transport.request("initialize", { clientInfo: { name: "fixture", version: "1" } });
      await f.transport.notifyInitialized();
      return await f.transport.request("config/read", { includeLayers: true });
    })();
    void exchange.catch(() => undefined);
    await vi.runAllTimersAsync();
    await expect(exchange).resolves.toEqual({ ok: true });
    expect(f.messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "config/read",
    ]);
    await expect(f.transport.close()).resolves.toMatchObject({
      outcome: "closed",
      failureCode: null,
    });
  });

  it.each(codexAppServerMethods.filter((method) => method !== "initialize"))(
    "permits only the reviewed outbound method %s",
    async (method) => {
      const f = await fixture().ready();
      await expect(f.transport.request(method, {})).resolves.toEqual({ ok: true });
      expect(f.requests.at(-1)?.method).toBe(method);
    },
  );

  it.each([
    "config/value/write",
    "config/batchWrite",
    "windowsSandbox/setupStart",
    "command/exec",
    "thread/settings/update",
    "process/spawn",
  ])("rejects forbidden method %s before writing", async (method) => {
    const f = await fixture().ready();
    const writes = f.write.mock.calls.length;
    await expect(f.transport.request(method as "config/read", {})).rejects.toMatchObject({
      code: "UNSUPPORTED_METHOD",
    });
    expect(f.write).toHaveBeenCalledTimes(writes);
    expect(f.terminate).not.toHaveBeenCalled();
  });

  it("snapshots JSON descriptor values and never invokes getters or inherited toJSON", async () => {
    const f = await fixture().ready();
    const params = { items: ["original"], cwd: "initial" };
    const pending = f.transport.request("config/read", params);
    params.items[0] = "mutated";
    params.cwd = "mutated";
    await pending;
    expect(f.requests.at(-1)?.params).toEqual({ items: ["original"], cwd: "initial" });
    const getter = vi.fn(() => "secret");
    const hostile = Object.defineProperty({}, "cwd", { enumerable: true, get: getter });
    await expect(f.transport.request("config/read", hostile)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(getter).not.toHaveBeenCalled();
    const original = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    Object.defineProperty(Array.prototype, "toJSON", { configurable: true, get: getter });
    try {
      await f.transport.request("config/read", { items: ["safe"] });
    } finally {
      if (original) Object.defineProperty(Array.prototype, "toJSON", original);
      else Reflect.deleteProperty(Array.prototype, "toJSON");
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    { value: Number.NaN },
    { value: undefined },
    { value: "\ud800" },
    { value: new Date() },
    { value: sparseArray },
  ])("rejects non-JSON input without sending it: %j", async (params) => {
    const f = await fixture().ready();
    await expect(f.transport.request("config/read", params)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(f.requests).toHaveLength(1);
  });

  it("rejects proxy parameters before invoking reflection traps", async () => {
    const f = await fixture().ready();
    const trap = vi.fn(() => {
      throw new Error("A proxy trap must not execute.");
    });
    const proxy = new Proxy(
      {},
      { getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap },
    );
    await expect(f.transport.request("config/read", proxy)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(trap).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(1);
  });

  it("writes at most 64 KiB at once and preserves complete JSONL frame order under backpressure", async () => {
    const f = await fixture().ready();
    const gate = deferred<void>();
    f.writeEffect = () => gate.promise;
    const first = f.transport.request("config/read", { text: "a".repeat(140_000) });
    const second = f.transport.request("permissionProfile/list", { cwd: "second" });
    await flush();
    expect(f.inFlightWrites).toBe(1);
    expect(f.requests).toHaveLength(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(f.peakWrites).toBe(1);
    expect(f.chunks.every((chunk) => chunk.length <= 65_536)).toBe(true);
    expect(f.requests.slice(1).map((request) => request.method)).toEqual([
      "config/read",
      "permissionProfile/list",
    ]);
    expect((f.requestAt(1).params as { text: string }).text).toHaveLength(140_000);
  });

  it("does not resolve an early response until the final input write acknowledgement succeeds", async () => {
    const f = await fixture().ready();
    const ack = deferred<void>();
    f.writeEffect = () => (f.requests.length === 2 ? ack.promise : Promise.resolve());
    let resolved = false;
    const pending = f.transport
      .request("config/read", { text: "a".repeat(140_000) })
      .then((value) => {
        resolved = true;
        return value;
      });
    await flush();
    expect(f.requests).toHaveLength(2);
    expect(resolved).toBe(false);
    ack.resolve();
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("rejects a response for a queued frame while the preceding frame's write ACK is blocked", async () => {
    const f = await fixture().ready();
    const ack = deferred<void>();
    f.autoReply = false;
    f.writeEffect = () => ack.promise;
    const first = f.transport.request("config/read", {});
    const second = f.transport.request("permissionProfile/list", {});
    await flush();
    expect(f.requests).toHaveLength(2);
    expect(f.requestAt().id).toBe("rpc:2");
    f.reply("rpc:3", { premature: true });
    await expect(first).rejects.toMatchObject({ code: "UNKNOWN_RESPONSE" });
    await expect(second).rejects.toMatchObject({ code: "UNKNOWN_RESPONSE" });
    ack.resolve();
    await expect(f.transport.completed).resolves.toMatchObject({ failureCode: "UNKNOWN_RESPONSE" });
    expect(f.requests).toHaveLength(2);
  });

  it("rejects a response before the final chunk of a multi-chunk frame has been submitted", async () => {
    const f = await fixture().ready();
    const ack = deferred<void>();
    f.autoReply = false;
    f.writeEffect = () => ack.promise;
    const pending = f.transport.request("config/read", { text: "a".repeat(140_000) });
    await flush();
    expect(f.requests).toHaveLength(1);
    f.reply("rpc:2", { premature: true });
    await expect(pending).rejects.toMatchObject({ code: "UNKNOWN_RESPONSE" });
    ack.resolve();
    await expect(f.transport.completed).resolves.toMatchObject({ failureCode: "UNKNOWN_RESPONSE" });
    expect(f.requests).toHaveLength(1);
  });

  it("rejects an early response when the corresponding pipe write fails and never retries bytes", async () => {
    const f = await fixture().ready();
    const ack = deferred<void>();
    f.writeEffect = () => ack.promise;
    const before = f.write.mock.calls.length;
    const pending = f.transport.request("config/read", {});
    await flush();
    ack.reject(new Error("Private pipe details."));
    await expect(pending).rejects.toMatchObject({ code: "WRITE_FAILED" });
    await expect(f.transport.completed).resolves.toMatchObject({
      outcome: "failed",
      failureCode: "WRITE_FAILED",
    });
    expect(f.write).toHaveBeenCalledTimes(before + 1);
    expect(f.terminate).toHaveBeenCalledOnce();
  });

  it("matches concurrent responses by exact ID rather than arrival order", async () => {
    const f = await fixture().ready();
    f.autoReply = false;
    const first = f.transport.request("config/read", {});
    const second = f.transport.request("permissionProfile/list", {});
    await flush();
    f.reply(f.requestAt(2).id, { value: "second" });
    f.reply(f.requestAt(1).id, { value: "first" });
    await expect(first).resolves.toEqual({ value: "first" });
    await expect(second).resolves.toEqual({ value: "second" });
  });

  it("exposes only a generic RPC error and numeric code while preserving a healthy connection", async () => {
    const f = await fixture().ready();
    f.autoReply = false;
    const pending = f.transport.request("config/read", {});
    await flush();
    f.raw(
      `${JSON.stringify({ id: f.requestAt().id, error: { code: -32000, message: "private credential detail", data: { secret: "never return this" } } })}\n`,
    );
    const failure = await pending.catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: "REMOTE_ERROR", remoteCode: -32000 });
    expect(String(failure)).not.toContain("private");
    expect(JSON.stringify(failure)).not.toContain("secret");
    expect(f.terminate).not.toHaveBeenCalled();
  });

  it("decodes split UTF-8 and CRLF without changing JSON values", async () => {
    const f = await fixture().ready();
    f.autoReply = false;
    const pending = f.transport.request("config/read", {});
    await flush();
    const bytes = Buffer.from(
      `${JSON.stringify({ jsonrpc: "2.0", id: f.requestAt().id, result: { value: "雪🌲" } })}\r\n`,
    );
    for (const byte of bytes) f.raw(Buffer.from([byte]));
    await expect(pending).resolves.toEqual({ value: "雪🌲" });
  });

  it("allows a near-2-MiB JSON output string whose escaped response frame exceeds 2 MiB", async () => {
    const f = await fixture().ready();
    f.autoReply = false;
    const pending = f.transport.request("turn/start", {});
    await flush();
    const output = "\\".repeat(2 * 1024 * 1024 - 100);
    f.reply(f.requestAt().id, { output });
    await expect(pending).resolves.toEqual({ output });
  });

  it.each([
    ["[]\n", "INVALID_FRAME"],
    ["{\n", "INVALID_FRAME"],
    ['{"id":"rpc:2","id":"rpc:2","result":{}}\n', "INVALID_FRAME"],
    ['{"id":"rpc:2","result":{},"error":{}}\n', "INVALID_FRAME"],
    ['{"jsonrpc":"1.0","id":"rpc:2","result":{}}\n', "INVALID_FRAME"],
    ['{"id":"rpc:2","result":{},"extra":true}\n', "INVALID_FRAME"],
    ['{"id":"rpc:2","error":{"code":-1}}\n', "INVALID_FRAME"],
    ['{"id":"other","result":{}}\n', "UNKNOWN_RESPONSE"],
    ['{"id":"server:1","method":"item/tool/call","params":{}}\n', "SERVER_REQUEST_UNSUPPORTED"],
    ["\n", "INVALID_FRAME"],
  ])("fails malformed or uncorrelated incoming frame %s", async (raw, code) => {
    const f = await fixture().ready();
    f.autoReply = false;
    const pending = f.transport.request("config/read", {});
    await flush();
    f.raw(raw);
    await expect(pending).rejects.toMatchObject({ code });
    await expect(f.transport.completed).resolves.toMatchObject({
      outcome: "failed",
      failureCode: code,
      stdoutEnded: true,
      stderrEnded: true,
    });
    expect(f.terminate).toHaveBeenCalledOnce();
  });

  it("rejects malformed UTF-8 before JSON parsing", async () => {
    const f = await fixture().ready();
    f.raw(Buffer.from([0xc3, 0x28, 0x0a]));
    await expect(f.transport.completed).resolves.toMatchObject({ failureCode: "INVALID_UTF8" });
  });

  it("rejects a duplicate response even while its write acknowledgement is pending", async () => {
    const f = await fixture().ready();
    const ack = deferred<void>();
    f.writeEffect = () => ack.promise;
    const pending = f.transport.request("config/read", {});
    await flush();
    f.reply(f.requestAt().id, { duplicate: true });
    await expect(pending).rejects.toMatchObject({ code: "UNKNOWN_RESPONSE" });
    ack.resolve();
    await expect(f.transport.completed).resolves.toMatchObject({ failureCode: "UNKNOWN_RESPONSE" });
  });

  it("rejects a duplicate response after settlement instead of reusing its result", async () => {
    const f = await fixture().ready();
    await f.transport.request("config/read", {});
    f.reply(f.requestAt().id, {});
    await expect(f.transport.completed).resolves.toMatchObject({ failureCode: "UNKNOWN_RESPONSE" });
  });

  it("serializes asynchronous notification delivery while continuing to handle responses", async () => {
    const first = deferred<void>();
    const delivered: string[] = [];
    const callback = vi.fn(async (notification: CodexAppServerNotification) => {
      delivered.push(notification.method);
      if (notification.method === "thread/started") await first.promise;
    });
    const f = await fixture({ onNotification: callback }).ready();
    f.notify("thread/started");
    f.notify("thread/status/changed");
    await expect(f.transport.request("config/read", {})).resolves.toEqual({ ok: true });
    expect(delivered).toEqual(["thread/started"]);
    first.resolve();
    await flush();
    expect(delivered).toEqual(["thread/started", "thread/status/changed"]);
    await expect(f.transport.close()).resolves.toMatchObject({
      notificationCount: 2,
      notificationDeliveryComplete: true,
    });
  });

  it("does not lose notifications arriving around the asynchronous consumer handoff", async () => {
    for (let delay = 0; delay <= 8; delay += 1) {
      const delivered: string[] = [];
      const f = fixture({
        onNotification: (notification) => {
          delivered.push(notification.method);
          if (notification.method === "first") {
            const enqueue = (remaining: number): void => {
              if (remaining === 0) f.notify("second");
              else queueMicrotask(() => enqueue(remaining - 1));
            };
            enqueue(delay);
          }
        },
      });
      f.notify("first");
      await flush();
      expect(delivered, `notification microtask delay ${delay}`).toEqual(["first", "second"]);
      await expect(f.transport.close()).resolves.toMatchObject({
        outcome: "closed",
        notificationCount: 2,
        notificationDeliveryComplete: true,
      });
    }
  });

  it("accepts the captured 0.145 notification envelope before initialization and preserves emittedAtMs", async () => {
    const callback = vi.fn();
    const f = fixture({ onNotification: callback });
    // Shape captured in session-policy-fd0472ea/notifications.json; identifiers are synthetic.
    const raw =
      '{"method":"remoteControl/status/changed","params":{"status":"disabled","serverName":"synthetic-host","installationId":"synthetic-installation","environmentId":null},"emittedAtMs":1788868488930}\n';
    f.raw(raw);
    await f.ready();
    expect(callback).toHaveBeenCalledWith(
      {
        method: "remoteControl/status/changed",
        params: {
          status: "disabled",
          serverName: "synthetic-host",
          installationId: "synthetic-installation",
          environmentId: null,
        },
        emittedAtMs: 1788868488930,
      },
      expect.any(AbortSignal),
    );
    await expect(f.transport.close()).resolves.toMatchObject({
      outcome: "closed",
      failureCode: null,
    });
  });

  it.each([0, Number.MAX_SAFE_INTEGER])(
    "retains bounded emittedAtMs %s without interpreting its clock",
    async (emittedAtMs) => {
      const callback = vi.fn();
      const f = await fixture({ onNotification: callback }).ready();
      f.raw(`${JSON.stringify({ method: "thread/started", params: {}, emittedAtMs })}\n`);
      await flush();
      expect(callback.mock.calls[0]?.[0]).toEqual({
        method: "thread/started",
        params: {},
        emittedAtMs,
      });
    },
  );

  it.each([null, false, "1788868488930", -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid emittedAtMs %j",
    async (emittedAtMs) => {
      const f = await fixture().ready();
      f.raw(`${JSON.stringify({ method: "thread/started", params: {}, emittedAtMs })}\n`);
      await expect(f.transport.completed).resolves.toMatchObject({
        outcome: "failed",
        failureCode: "INVALID_FRAME",
      });
    },
  );

  it("bounds notification queue count including the active asynchronous callback", async () => {
    const blocked = deferred<void>();
    const callback = vi.fn(
      (_notification: CodexAppServerNotification, _signal: AbortSignal) => blocked.promise,
    );
    const f = await fixture({
      onNotification: callback,
      limits: { maximumQueuedNotifications: 2 },
    }).ready();
    f.notify();
    await flush();
    f.notify();
    f.notify();
    await expect(f.transport.completed).resolves.toMatchObject({
      failureCode: "LIMIT_EXCEEDED",
      notificationDeliveryComplete: false,
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[1].aborted).toBe(true);
    blocked.resolve();
  });

  it("bounds notification bytes independently of queue length", async () => {
    const f = await fixture({
      onNotification: () => undefined,
      limits: { maximumQueuedNotificationBytes: 80 },
    }).ready();
    f.notify("thread/started", { large: "x".repeat(100) });
    await expect(f.transport.completed).resolves.toMatchObject({ failureCode: "LIMIT_EXCEEDED" });
  });

  it("bounds total notifications even without a callback", async () => {
    const f = await fixture({ limits: { maximumNotifications: 2 } }).ready();
    f.notify();
    f.notify();
    f.notify();
    await expect(f.transport.completed).resolves.toMatchObject({
      failureCode: "LIMIT_EXCEEDED",
      notificationCount: 3,
    });
  });

  it.each(["throw", "timeout"])(
    "terminates and drains on notification %s without exposing message content",
    async (mode) => {
      const blocked = deferred<void>();
      const f = await fixture({
        limits: { notificationTimeoutMs: 20 },
        onNotification: async () => {
          if (mode === "throw") throw new Error("private event");
          await blocked.promise;
        },
      }).ready();
      f.notify();
      await vi.advanceTimersByTimeAsync(21);
      await expect(f.transport.completed).resolves.toMatchObject({
        failureCode: mode === "throw" ? "NOTIFICATION_FAILED" : "NOTIFICATION_TIMEOUT",
      });
      blocked.resolve();
    },
  );

  it.each(["stdout", "stderr"] as const)(
    "bounds cumulative %s bytes while retaining drain after failure",
    async (which) => {
      const f = await fixture({
        limits: { maximumStdoutBytes: 160, maximumStderrBytes: 160 },
      }).ready();
      f.terminateEffect = async () => undefined;
      f[which].write(Buffer.alloc(161, 65));
      await flush();
      f[which].write(Buffer.alloc(7, 66));
      f.finish();
      const closed = await f.transport.completed;
      expect(closed.failureCode).toBe("LIMIT_EXCEEDED");
      expect(closed[which === "stdout" ? "stdoutBytes" : "stderrBytes"]).toBeGreaterThanOrEqual(
        168,
      );
      expect(closed.stdoutEnded && closed.stderrEnded).toBe(true);
    },
  );

  it("rejects an oversized frame without requiring its delimiter", async () => {
    const f = await fixture({ limits: { maximumFrameBytes: 256 } }).ready();
    f.raw(" ".repeat(257));
    await expect(f.transport.completed).resolves.toMatchObject({ failureCode: "LIMIT_EXCEEDED" });
  });

  it("bounds pending requests and input reservations without poisoning existing requests", async () => {
    const f = await fixture({
      limits: { maximumPendingRequests: 1, maximumWriteOperations: 3 },
    }).ready();
    f.autoReply = false;
    const pending = f.transport.request("config/read", {});
    await expect(f.transport.request("config/read", {})).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
    await flush();
    f.reply(f.requestAt().id, {});
    await pending;
    await expect(f.transport.request("config/read", {})).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
    expect(f.terminate).not.toHaveBeenCalled();
    await f.transport.close();
  });

  it("enforces input byte and frame budgets before the first write", async () => {
    const f = await fixture({ limits: { maximumInputBytes: 256, maximumFrameBytes: 256 } }).ready();
    const count = f.write.mock.calls.length;
    await expect(
      f.transport.request("config/read", { large: "x".repeat(257) }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(f.write).toHaveBeenCalledTimes(count);
  });

  it("rejects all pending requests on RPC timeout and discards late replies while draining", async () => {
    const f = await fixture({ limits: { requestTimeoutMs: 20 } }).ready();
    f.autoReply = false;
    f.terminateEffect = async () => undefined;
    const first = f.transport.request("config/read", {});
    const second = f.transport.request("permissionProfile/list", {});
    await vi.advanceTimersByTimeAsync(21);
    await expect(first).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await expect(second).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    f.reply(f.requestAt().id, { late: true });
    f.finish();
    await expect(f.transport.completed).resolves.toMatchObject({ failureCode: "REQUEST_TIMEOUT" });
    expect(f.terminate).toHaveBeenCalledOnce();
  });

  it("bounds an uncertain pipe write independently of RPC timeouts", async () => {
    const f = await fixture({ limits: { pipeTimeoutMs: 20 } }).ready();
    const ack = deferred<void>();
    f.writeEffect = () => ack.promise;
    const pending = f.transport.request("config/read", {});
    await vi.advanceTimersByTimeAsync(21);
    await expect(pending).rejects.toMatchObject({ code: "WRITE_TIMEOUT" });
    await expect(f.transport.completed).resolves.toMatchObject({ failureCode: "WRITE_TIMEOUT" });
    ack.resolve();
  });

  it("distinguishes pre-admission cancellation from cancellation after sending", async () => {
    const f = await fixture().ready();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      f.transport.request("config/read", {}, { signal: cancelled.signal }),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(f.terminate).not.toHaveBeenCalled();
    f.autoReply = false;
    const active = new AbortController();
    const one = f.transport.request("config/read", {}, { signal: active.signal });
    const two = f.transport.request("permissionProfile/list", {});
    await flush();
    active.abort();
    await expect(one).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await expect(two).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await expect(f.transport.completed).resolves.toMatchObject({ outcome: "aborted" });
    expect(f.terminate).toHaveBeenCalledExactlyOnceWith("cancelled");
  });

  it("honors parent cancellation and never calls Host-wide termination", async () => {
    const parent = new AbortController();
    const f = await fixture({ signal: parent.signal }).ready();
    parent.abort();
    await expect(f.transport.completed).resolves.toMatchObject({
      outcome: "aborted",
      failureCode: "CANCELLED",
    });
    expect(f.terminate).toHaveBeenCalledExactlyOnceWith("cancelled");
  });

  it("pins the original process and input methods before callers can replace handle fields", async () => {
    const f = await fixture().ready();
    const replacementTerminate = vi.fn(async () => undefined);
    const replacementWrite = vi.fn(async () => undefined);
    const replacementClose = vi.fn(async () => undefined);
    Object.assign(f.process, {
      requestId: "different-process",
      processId: 99,
      terminate: replacementTerminate,
      stdin: { streamId: "b".repeat(64), write: replacementWrite, close: replacementClose },
    });
    await f.transport.request("config/read", {});
    // The synthetic fixture's exit constructor reads its handle; retain the real captured id.
    f.terminateEffect = async () => f.finish({ requestId: "process:synthetic-app-server" });
    const closed = await f.transport.abort("lease_lost");
    expect(closed).toMatchObject({
      processId: 42,
      processRequestId: "process:synthetic-app-server",
      stdinStreamId: "a".repeat(64),
    });
    expect(f.terminate).toHaveBeenCalledExactlyOnceWith("lease_lost");
    expect(replacementTerminate).not.toHaveBeenCalled();
    expect(replacementWrite).not.toHaveBeenCalled();
    expect(replacementClose).not.toHaveBeenCalled();
  });

  it.each(["partial", "empty"])(
    "rejects unexpected %s EOF and still drains stderr",
    async (mode) => {
      const f = await fixture().ready();
      f.autoReply = false;
      f.terminateEffect = async () => undefined;
      const pending = f.transport.request("config/read", {});
      await flush();
      f.stdout.end(mode === "partial" ? '{"id":"rpc:2"' : undefined);
      await expect(pending).rejects.toMatchObject({
        code: mode === "partial" ? "INVALID_FRAME" : "UNEXPECTED_EOF",
      });
      f.stderr.write("private stderr must only be counted");
      f.finish();
      const closed = await f.transport.completed;
      expect(closed.stderrBytes).toBeGreaterThan(0);
      expect(JSON.stringify(closed)).not.toContain("private stderr");
    },
  );

  it("does not accept process exit before a response or pending write acknowledgement", async () => {
    const f = await fixture().ready();
    const ack = deferred<void>();
    f.writeEffect = () => ack.promise;
    const pending = f.transport.request("config/read", {});
    await flush();
    f.finish();
    await expect(pending).rejects.toMatchObject({
      code: expect.stringMatching(/PROCESS_EXITED|UNEXPECTED_EOF/u),
    });
    ack.resolve();
    await expect(f.transport.completed).resolves.toMatchObject({ outcome: "failed" });
  });

  it("fails only the affected transport on a stream error and retains actual close facts", async () => {
    const f = await fixture().ready();
    f.stderr.destroy(new Error("private stream detail"));
    await expect(f.transport.completed).resolves.toMatchObject({
      outcome: "failed",
      failureCode: "STREAM_FAILED",
      stderrEnded: false,
    });
  });

  it("refuses to report confirmed cleanup when ManagedProcess completion rejects", async () => {
    const f = await fixture().ready();
    f.exited.reject(new Error("private Host failure"));
    await expect(f.transport.completed).rejects.toMatchObject({ code: "CLEANUP_UNCONFIRMED" });
  });

  it("rejects outstanding RPCs when close is requested and does not interleave EOF", async () => {
    const f = await fixture().ready();
    f.autoReply = false;
    const pending = f.transport.request("config/read", {});
    const closing = f.transport.close();
    await expect(pending).rejects.toMatchObject({ code: "CLOSED" });
    await expect(closing).resolves.toMatchObject({ outcome: "aborted" });
    expect(f.closeInput).not.toHaveBeenCalled();
  });

  it("requires EOF acknowledgement as well as actual process and stream completion", async () => {
    const f = await fixture().ready();
    const ack = deferred<void>();
    f.closeEffect = async () => {
      f.finish();
      await ack.promise;
    };
    let settled = false;
    const closing = f.transport.close().then((result) => {
      settled = true;
      return result;
    });
    await flush();
    expect(settled).toBe(false);
    ack.resolve();
    await expect(closing).resolves.toMatchObject({ outcome: "closed" });
  });

  it("terminates an EOF-ignoring process after bounded grace and confirms its drain", async () => {
    const f = await fixture({ limits: { closeGraceMs: 5 } }).ready();
    f.closeEffect = async () => undefined;
    const closing = f.transport.close();
    await vi.advanceTimersByTimeAsync(6);
    await expect(closing).resolves.toMatchObject({
      outcome: "failed",
      failureCode: "PROCESS_EXITED",
      stdoutEnded: true,
      stderrEnded: true,
    });
    expect(f.terminate).toHaveBeenCalledOnce();
  });

  it.each(["before_eof_ack", "after_eof_ack"] as const)(
    "does not apply process exit grace to slow notification delivery when exit is %s",
    async (ordering) => {
      const delivered: string[] = [];
      const f = await fixture({
        limits: { closeGraceMs: 5, notificationTimeoutMs: 5 },
        onNotification: async (notification) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 3));
          delivered.push(notification.method);
        },
      }).ready();
      f.notify("thread/started");
      f.notify("thread/status/changed");
      if (ordering === "after_eof_ack") f.closeEffect = async () => undefined;
      let settled = false;
      const closing = f.transport.close().then((result) => {
        settled = true;
        return result;
      });
      await flush();
      if (ordering === "after_eof_ack") {
        f.finish();
        await flush();
      }
      await vi.advanceTimersByTimeAsync(5);
      expect(settled).toBe(false);
      expect(delivered).toEqual(["thread/started"]);
      expect(f.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      await expect(closing).resolves.toMatchObject({
        outcome: "closed",
        failureCode: null,
        stdoutEnded: true,
        stderrEnded: true,
        notificationCount: 2,
        notificationDeliveryComplete: true,
      });
      expect(delivered).toEqual(["thread/started", "thread/status/changed"]);
      expect(f.terminate).not.toHaveBeenCalled();
    },
  );

  it("still bounds output-stream drain after confirmed process exit independently of notifications", async () => {
    const f = await fixture({ limits: { closeGraceMs: 5, forceDrainTimeoutMs: 20 } }).ready();
    f.closeEffect = async () => {
      f.exited.resolve({
        protocolVersion: "1.0",
        type: "exited",
        requestId: f.process.requestId,
        exitCode: 0,
        signal: null,
        outputTruncated: false,
      });
    };
    f.terminateEffect = async () => undefined;
    const closing = f.transport.close();
    await vi.advanceTimersByTimeAsync(6);
    expect(f.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15);
    await expect(closing).rejects.toMatchObject({ code: "CLEANUP_UNCONFIRMED" });
    f.finish();
  });

  it("bounds forced drain and never labels unconfirmed cleanup successful", async () => {
    const f = await fixture({ limits: { closeGraceMs: 5, forceDrainTimeoutMs: 20 } }).ready();
    f.closeEffect = async () => undefined;
    f.terminateEffect = async () => undefined;
    const closing = f.transport.close();
    await vi.advanceTimersByTimeAsync(26);
    await expect(closing).rejects.toMatchObject({ code: "CLEANUP_UNCONFIRMED" });
    expect(f.terminate).toHaveBeenCalledOnce();
    f.stderr.write("late drain");
    f.finish();
  });

  it("bounds a blocked EOF operation and preserves its failure after process cleanup", async () => {
    const f = await fixture({ limits: { pipeTimeoutMs: 20 } }).ready();
    const ack = deferred<void>();
    f.closeEffect = () => ack.promise;
    const closing = f.transport.close();
    await vi.advanceTimersByTimeAsync(21);
    await expect(closing).resolves.toMatchObject({
      outcome: "failed",
      failureCode: "WRITE_TIMEOUT",
    });
    ack.resolve();
  });
});
