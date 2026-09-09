import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { inspect } from "node:util";
import { createCanonicalResult } from "@agentic-review/codex";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerTurnDriverError,
  createCodexAppServerTurnDriver,
} from "./codex-app-server-turn-driver.js";
import type {
  ManagedProcess,
  ProcessExitedEvent,
  ProcessTerminationReason,
} from "./process-host-protocol.js";

const threadId = "thread-driver-fixture";
const turnId = "turn-driver-fixture";
const finalItemId = "item-driver-final";
const originalPrompt = "Return the synthetic result using the supplied JSON schema.";
const model = { schemaVersion: "SyntheticDriverResultV1", answer: "Synthetic result." };
const protectedValue = "synthetic-driver-protected-value";
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function input() {
  const resultSchema = Type.Object(
    {
      schemaVersion: Type.Literal("SyntheticDriverResultV1"),
      answer: Type.String(),
    },
    { additionalProperties: false },
  );
  const json = JSON.stringify(resultSchema);
  return {
    threadId,
    prompt: originalPrompt,
    authoritativeSchema: { json, digest: hash(json), resultSchema },
    protectedValues: [protectedValue],
    outputLimits: { maximumResultBytes: 4096 },
  };
}

const turn = (status = "inProgress") => ({
  id: turnId,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: 10,
  completedAt: status === "inProgress" ? null : 11,
  durationMs: null,
});
type Message = { id?: string; method: string; params?: unknown };
type Request = Message & { id: string };
type Driver = ReturnType<typeof createCodexAppServerTurnDriver>;
type DriverOptions = Parameters<typeof createCodexAppServerTurnDriver>[0];

class Fixture {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exited = Promise.withResolvers<ProcessExitedEvent>();
  readonly turnRequested = Promise.withResolvers<Request>();
  readonly messages: Message[] = [];
  readonly requests: Request[] = [];
  readonly writeChunks: Buffer[] = [];
  driver!: Driver;
  turnEffect: ((request: Request) => void | Promise<void>) | undefined;
  closeEffect: (() => void | Promise<void>) | undefined;
  terminateEffect: (() => void | Promise<void>) | undefined;
  private inputBytes = Buffer.alloc(0);
  private processExited = false;

  readonly write = vi.fn(async (bytes: Uint8Array, _signal?: AbortSignal) => {
    const snapshot = Buffer.from(bytes);
    this.writeChunks.push(snapshot);
    this.inputBytes = Buffer.concat([this.inputBytes, snapshot]);
    for (;;) {
      const newline = this.inputBytes.indexOf(10);
      if (newline < 0) break;
      const message = JSON.parse(this.inputBytes.subarray(0, newline).toString("utf8")) as Message;
      this.inputBytes = this.inputBytes.subarray(newline + 1);
      this.messages.push(message);
      if (typeof message.id !== "string") continue;
      const request: Request = { ...message, id: message.id };
      this.requests.push(request);
      if (request.method === "turn/start") {
        this.turnRequested.resolve(request);
        if (this.turnEffect !== undefined) await this.turnEffect(request);
        else this.reply(request.id, { turn: turn() });
      } else {
        this.reply(
          request.id,
          request.method === "thread/start"
            ? { thread: { id: threadId } }
            : request.method === "config/read"
              ? { config: { model: "synthetic-driver-model" } }
              : { userAgent: "synthetic-driver-client" },
        );
      }
    }
  });
  readonly closeInput = vi.fn(async (_signal?: AbortSignal) => {
    if (this.closeEffect !== undefined) await this.closeEffect();
    else this.finish();
  });
  readonly terminate = vi.fn(async (_reason: ProcessTerminationReason) => {
    if (this.terminateEffect !== undefined) await this.terminateEffect();
    else this.finish();
  });
  readonly process: ManagedProcess = {
    requestId: "process:synthetic-turn-driver",
    processId: 73,
    stdin: {
      streamId: "b".repeat(64),
      write: this.write,
      close: this.closeInput,
    },
    stdout: this.stdout,
    stderr: this.stderr,
    completed: this.exited.promise,
    terminate: this.terminate,
  };

  reply(id: string, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }
  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }
  startTurn(): void {
    this.notify("turn/started", { threadId, turn: turn() });
  }
  finalMessage(text = JSON.stringify(model)): void {
    this.notify("item/started", {
      threadId,
      turnId,
      item: { id: finalItemId, type: "agentMessage", text: "", phase: "final_answer" },
      startedAtMs: 100,
    });
    this.notify("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId: finalItemId,
      delta: text,
    });
    this.notify("item/completed", {
      threadId,
      turnId,
      item: { id: finalItemId, type: "agentMessage", text, phase: "final_answer" },
      completedAtMs: 101,
    });
  }
  completeTurn(text = JSON.stringify(model)): void {
    this.startTurn();
    this.finalMessage(text);
    this.notify("turn/completed", { threadId, turn: turn("completed") });
  }
  exit(changes: Partial<ProcessExitedEvent> = {}): void {
    if (this.processExited) return;
    this.processExited = true;
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
  finish(changes: Partial<ProcessExitedEvent> = {}): void {
    this.stdout.end();
    this.stderr.end();
    this.exit(changes);
  }
  turnRequests(): Request[] {
    return this.requests.filter((request) => request.method === "turn/start");
  }
  async ready(): Promise<this> {
    await this.driver.transport.request("initialize", {
      clientInfo: { name: "synthetic-turn-driver", version: "1" },
    });
    await this.driver.transport.notifyInitialized();
    await this.driver.transport.request("config/read", { includeLayers: true });
    await this.driver.transport.request("thread/start", { ephemeral: true });
    return this;
  }
}

const fixtures: Fixture[] = [];
function fixture(options: Omit<DriverOptions, "process"> = {}): Fixture {
  const f = new Fixture();
  fixtures.push(f);
  f.driver = createCodexAppServerTurnDriver({ process: f.process, ...options });
  return f;
}
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
function observeSettlement(promise: Promise<unknown>) {
  const observation = { settled: false };
  void promise.then(
    () => {
      observation.settled = true;
    },
    () => {
      observation.settled = true;
    },
  );
  return observation;
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.finish();
    await Promise.allSettled([f.driver.abort(), f.driver.drained]);
  }
  vi.useRealTimers();
});

describe("single-process Codex app-server turn driver", () => {
  it("accepts the shared 512-value protection boundary", async () => {
    const f = await fixture().ready();
    const running = f.driver.runTurn({
      ...input(),
      protectedValues: Array.from({ length: 512 }, (_, index) => `synthetic-protected-${index}`),
    });
    await Promise.race([f.turnRequested.promise, running]);
    f.completeTurn();
    await expect(running).resolves.toMatchObject({ result: model });
    await expect(f.driver.drained).resolves.toBeUndefined();
  });

  it("rejects 513 protected values before dispatch and still drains its process", async () => {
    const f = await fixture().ready();
    await expect(
      f.driver.runTurn({
        ...input(),
        protectedValues: Array.from({ length: 513 }, (_, index) => `synthetic-protected-${index}`),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(f.turnRequests()).toEqual([]);
    await expect(f.driver.drained).resolves.toBeUndefined();
  });

  it("snapshots the notification observer instead of following later options mutation", async () => {
    const f = new Fixture();
    const observer = vi.fn<NonNullable<DriverOptions["onNotification"]>>();
    const replacement = vi.fn<NonNullable<DriverOptions["onNotification"]>>();
    const options = { process: f.process, onNotification: observer };
    f.driver = createCodexAppServerTurnDriver(options);
    fixtures.push(f);
    options.onNotification = replacement;
    await f.ready();
    const running = f.driver.runTurn(input());
    await f.turnRequested.promise;
    f.completeTurn();
    await expect(running).resolves.toMatchObject({ result: model });
    await expect(f.driver.drained).resolves.toBeUndefined();
    expect(observer.mock.calls.map(([notification]) => notification.method)).toEqual([
      "turn/started",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed",
    ]);
    expect(replacement).not.toHaveBeenCalled();
  });

  it.each(["synchronous", "asynchronous"])(
    "rejects a %s observer failure without leaking its error or abandoning process cleanup",
    async (mode) => {
      const observer = vi.fn<NonNullable<DriverOptions["onNotification"]>>(() => {
        if (mode === "asynchronous") return Promise.reject(new Error(protectedValue));
        throw new Error(protectedValue);
      });
      const f = await fixture({ onNotification: observer }).ready();
      const running = f.driver.runTurn(input());
      await f.turnRequested.promise;
      f.startTurn();
      const error = await running.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(CodexAppServerTurnDriverError);
      expect(error).not.toHaveProperty("cause");
      expect(inspect(error, { depth: null, showHidden: true })).not.toContain(protectedValue);
      await expect(f.driver.drained).resolves.toBeUndefined();
      expect(observer).toHaveBeenCalledOnce();
      expect(observer.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
      expect(f.terminate).toHaveBeenCalledOnce();
      expect(f.turnRequests()).toHaveLength(1);
      await expect(f.driver.runTurn(input())).rejects.toMatchObject({ code: "ALREADY_STARTED" });
    },
  );

  it("waits for an asynchronous terminal observer before resolving output or drain", async () => {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const observer = vi.fn<NonNullable<DriverOptions["onNotification"]>>((notification) => {
      if (notification.method === "turn/completed") {
        entered.resolve();
        return released.promise;
      }
    });
    const f = await fixture({ onNotification: observer }).ready();
    const running = f.driver.runTurn(input());
    const resultState = observeSettlement(running);
    const drainState = observeSettlement(f.driver.drained);
    await f.turnRequested.promise;
    f.completeTurn();
    await entered.promise;
    await flush();
    expect(resultState.settled).toBe(false);
    expect(drainState.settled).toBe(false);
    released.resolve();
    await expect(running).resolves.toMatchObject({ result: model });
    await expect(f.driver.drained).resolves.toBeUndefined();
    expect(f.closeInput).toHaveBeenCalledOnce();
    expect(f.terminate).not.toHaveBeenCalled();
  });

  it.each([null, true, "observer", {}])(
    "rejects a nonfunction notification observer %j",
    (value) => {
      const f = new Fixture();
      try {
        expect(() =>
          createCodexAppServerTurnDriver({
            process: f.process,
            onNotification: value,
          } as unknown as DriverOptions),
        ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
        expect(f.write).not.toHaveBeenCalled();
        expect(f.terminate).not.toHaveBeenCalled();
      } finally {
        f.finish();
      }
    },
  );

  it("rejects a notification observer getter without executing it", () => {
    const f = new Fixture();
    const getter = vi.fn(() => {
      throw new Error(protectedValue);
    });
    const options = Object.defineProperty({ process: f.process }, "onNotification", {
      enumerable: true,
      get: getter,
    });
    try {
      expect(() => createCodexAppServerTurnDriver(options)).toThrowError(
        expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
      );
      expect(getter).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
      expect(f.terminate).not.toHaveBeenCalled();
    } finally {
      f.finish();
    }
  });

  it("owns the streams synchronously and leaves all setup RPCs to the parent", async () => {
    const onActivity = vi.fn();
    const f = fixture({ onActivity });
    expect(f.messages).toEqual([]);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.closeInput).not.toHaveBeenCalled();
    expect(f.terminate).not.toHaveBeenCalled();
    f.stderr.write(Buffer.from("Synthetic setup diagnostic."));
    await flush();
    expect(onActivity).toHaveBeenCalled();
    expect(f.messages).toEqual([]);
    await f.ready();
    expect(f.messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "config/read",
      "thread/start",
    ]);
  });

  it("sends exactly one turn with the original prompt and strict output schema", async () => {
    const f = await fixture().ready();
    const requestInput = input();
    const running = f.driver.runTurn(requestInput);
    const request = await f.turnRequested.promise;
    expect(request.params).toEqual({
      threadId,
      input: [{ type: "text", text: originalPrompt }],
      outputSchema: JSON.parse(requestInput.authoritativeSchema.json),
    });
    const raw = ' { "answer": "Synthetic result.", "schemaVersion": "SyntheticDriverResultV1" } ';
    f.completeTurn(raw);
    await expect(running).resolves.toMatchObject({
      threadId,
      turnId,
      finalItemId,
      finalSelection: "explicit_final_answer",
      result: model,
      rawResultJson: raw,
      canonicalResultJson: createCanonicalResult(model).json,
      resultDigest: createCanonicalResult(model).sha256,
      commandEvidence: { commands: [], commandCapture: "complete" },
      observedFileChange: false,
    });
    await expect(f.driver.drained).resolves.toBeUndefined();
    expect(f.turnRequests()).toHaveLength(1);
    expect(f.closeInput).toHaveBeenCalledOnce();
    expect(f.terminate).not.toHaveBeenCalled();
  });

  it("retains a complete fast turn delivered before the turn/start response", async () => {
    const f = await fixture().ready();
    f.turnEffect = async (request) => {
      f.completeTurn();
      await flush();
      f.reply(request.id, { turn: turn() });
    };
    await expect(f.driver.runTurn(input())).resolves.toMatchObject({ result: model, turnId });
    await expect(f.driver.drained).resolves.toBeUndefined();
    expect(f.turnRequests()).toHaveLength(1);
  });

  it("rejects concurrent and subsequent turns without redispatching or aborting the first turn", async () => {
    const f = await fixture().ready();
    f.turnEffect = () => undefined;
    const first = f.driver.runTurn(input());
    const request = await f.turnRequested.promise;
    await expect(f.driver.runTurn(input())).rejects.toMatchObject({ code: "ALREADY_STARTED" });
    expect(f.terminate).not.toHaveBeenCalled();
    f.reply(request.id, { turn: turn() });
    f.completeTurn();
    await expect(first).resolves.toMatchObject({ result: model });
    await expect(f.driver.runTurn(input())).rejects.toMatchObject({ code: "ALREADY_STARTED" });
    expect(f.turnRequests()).toHaveLength(1);
  });

  it("snapshots prompt, schema, protected values and output bounds before its first await", async () => {
    const f = await fixture().ready();
    const requestInput = input();
    const schemaBefore = JSON.parse(requestInput.authoritativeSchema.json);
    const running = f.driver.runTurn(requestInput);
    requestInput.prompt = "Changed caller prompt.";
    requestInput.authoritativeSchema.json = "{}";
    requestInput.authoritativeSchema.digest = "f".repeat(64);
    requestInput.authoritativeSchema.resultSchema.properties.answer.maxLength = 1;
    requestInput.protectedValues.push(model.answer);
    requestInput.outputLimits.maximumResultBytes = 1;
    const request = await f.turnRequested.promise;
    expect(request.params).toEqual({
      threadId,
      input: [{ type: "text", text: originalPrompt }],
      outputSchema: schemaBefore,
    });
    f.completeTurn();
    await expect(running).resolves.toMatchObject({ result: model });
  });

  it.each(["digest", "malformed schema", "ambiguous schema", "oversized prompt"])(
    "rejects invalid %s before turn dispatch and still drains the process",
    async (kind) => {
      const f = await fixture().ready();
      const requestInput = input();
      if (kind === "digest") requestInput.authoritativeSchema.digest = "f".repeat(64);
      if (kind === "malformed schema") {
        requestInput.authoritativeSchema.json = "{";
        requestInput.authoritativeSchema.digest = hash("{");
      }
      if (kind === "ambiguous schema") {
        requestInput.authoritativeSchema.json = '{"type":"string","type":"object"}';
        requestInput.authoritativeSchema.digest = hash(requestInput.authoritativeSchema.json);
      }
      if (kind === "oversized prompt") requestInput.prompt = "x".repeat(512 * 1024 + 1);
      await expect(f.driver.runTurn(requestInput)).rejects.toMatchObject({
        code: "INVALID_CONFIGURATION",
      });
      await expect(f.driver.drained).resolves.toBeUndefined();
      expect(f.turnRequests()).toEqual([]);
      expect(f.terminate).toHaveBeenCalledOnce();
      await expect(f.driver.runTurn(input())).rejects.toMatchObject({ code: "ALREADY_STARTED" });
      expect(f.turnRequests()).toEqual([]);
    },
  );

  it.each(["prompt", "authoritativeSchema", "json"])(
    "rejects an input %s getter without executing it or retaining its private error",
    async (key) => {
      const f = await fixture().ready();
      const requestInput = input();
      const getter = vi.fn(() => {
        throw new Error(protectedValue);
      });
      Object.defineProperty(key === "json" ? requestInput.authoritativeSchema : requestInput, key, {
        enumerable: true,
        get: getter,
      });
      const error = await f.driver.runTurn(requestInput).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(CodexAppServerTurnDriverError);
      expect(error).toMatchObject({ code: "INVALID_CONFIGURATION" });
      expect(error).not.toHaveProperty("cause");
      expect(inspect(error, { depth: null, showHidden: true })).not.toContain(protectedValue);
      expect(getter).not.toHaveBeenCalled();
      await expect(f.driver.drained).resolves.toBeUndefined();
      expect(f.turnRequests()).toEqual([]);
    },
  );

  it("rejects Proxy input without invoking its reflection traps or dispatching a turn", async () => {
    const f = await fixture().ready();
    const trap = vi.fn(() => {
      throw new Error(protectedValue);
    });
    const requestInput = new Proxy(input(), {
      get: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
      getOwnPropertyDescriptor: trap,
    });
    await expect(f.driver.runTurn(requestInput)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
    expect(trap).not.toHaveBeenCalled();
    await expect(f.driver.drained).resolves.toBeUndefined();
    expect(f.turnRequests()).toEqual([]);
  });

  it("does not resolve a completed turn before process exit and both output streams end", async () => {
    const f = await fixture().ready();
    f.closeEffect = () => undefined;
    const running = f.driver.runTurn(input());
    const turnSettled = observeSettlement(running);
    const drainSettled = observeSettlement(f.driver.drained);
    await f.turnRequested.promise;
    f.completeTurn();
    await flush();
    expect(f.closeInput).toHaveBeenCalledOnce();
    expect(turnSettled.settled).toBe(false);
    expect(drainSettled.settled).toBe(false);
    f.exit();
    await flush();
    expect(turnSettled.settled).toBe(false);
    expect(drainSettled.settled).toBe(false);
    f.stdout.end();
    await flush();
    expect(turnSettled.settled).toBe(false);
    f.stderr.end();
    await expect(running).resolves.toMatchObject({ result: model });
    await expect(f.driver.drained).resolves.toBeUndefined();
  });

  it("settles an early process exit without waiting forever for a terminal turn notification", async () => {
    const f = await fixture().ready();
    const running = f.driver.runTurn(input());
    await f.turnRequested.promise;
    f.finish();
    await expect(running).rejects.toMatchObject({ code: "TRANSPORT_FAILED" });
    await expect(f.driver.drained).resolves.toBeUndefined();
    expect(f.turnRequests()).toHaveLength(1);
  });

  it("cancels the active child, drains it, and never restarts or leaks the cancellation reason", async () => {
    const child = new AbortController();
    const f = await fixture({ signal: child.signal }).ready();
    const running = f.driver.runTurn(input());
    await f.turnRequested.promise;
    child.abort(new Error(protectedValue));
    const error = await running.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CodexAppServerTurnDriverError);
    expect(error).toMatchObject({ code: "CANCELLED" });
    expect(error).not.toHaveProperty("cause");
    expect(inspect(error, { depth: null, showHidden: true })).not.toContain(protectedValue);
    await expect(f.driver.drained).resolves.toBeUndefined();
    expect(f.terminate).toHaveBeenCalledExactlyOnceWith("cancelled");
    await expect(f.driver.runTurn(input())).rejects.toMatchObject({ code: "ALREADY_STARTED" });
    expect(f.turnRequests()).toHaveLength(1);
  });

  it.each(["malformed notification", "result schema", "protected result"])(
    "keeps a %s business failure separate from confirmed physical drain",
    async (kind) => {
      const f = await fixture().ready();
      const running = f.driver.runTurn(input());
      await f.turnRequested.promise;
      if (kind === "malformed notification") {
        f.notify("turn/started", { threadId: "foreign-thread", turn: turn() });
      } else {
        f.completeTurn(
          JSON.stringify({
            ...model,
            answer: kind === "result schema" ? 42 : protectedValue,
          }),
        );
      }
      const error = await running.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(CodexAppServerTurnDriverError);
      expect(error).toMatchObject({ code: "OUTPUT_INVALID" });
      expect(error).not.toHaveProperty("cause");
      expect(inspect(error, { depth: null, showHidden: true })).not.toContain(protectedValue);
      await expect(f.driver.drained).resolves.toBeUndefined();
      await expect(f.driver.runTurn(input())).rejects.toMatchObject({ code: "ALREADY_STARTED" });
      expect(f.turnRequests()).toHaveLength(1);
    },
  );

  it("rejects a successful model turn when its process exits unsuccessfully", async () => {
    const f = await fixture().ready();
    f.closeEffect = () => f.finish({ exitCode: 17 });
    const running = f.driver.runTurn(input());
    await f.turnRequested.promise;
    f.completeTurn();
    await expect(running).rejects.toMatchObject({ code: "PROCESS_CLOSURE_INVALID" });
    await expect(f.driver.drained).resolves.toBeUndefined();
    expect(f.turnRequests()).toHaveLength(1);
  });

  it("bounds a missing drain and never treats termination acknowledgement as process closure", async () => {
    const f = await fixture({
      transportLimits: {
        requestTimeoutMs: 100,
        pipeTimeoutMs: 20,
        notificationTimeoutMs: 20,
        closeGraceMs: 10,
        forceDrainTimeoutMs: 20,
      },
    }).ready();
    f.closeEffect = () => undefined;
    f.terminateEffect = () => undefined;
    const running = f.driver.runTurn(input());
    const failed = expect(running).rejects.toMatchObject({ code: "CLEANUP_UNCONFIRMED" });
    const notDrained = expect(f.driver.drained).rejects.toMatchObject({
      code: "CLEANUP_UNCONFIRMED",
    });
    await f.turnRequested.promise;
    f.completeTurn();
    await vi.advanceTimersByTimeAsync(200);
    await failed;
    await notDrained;
    expect(f.terminate).toHaveBeenCalledOnce();
    expect(f.turnRequests()).toHaveLength(1);
  });
});
