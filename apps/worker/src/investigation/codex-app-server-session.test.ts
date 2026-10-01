import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedProcessStandardInput } from "../execution/process-host-protocol.js";
import {
  type CodexAppServerSession,
  type CodexAppServerSessionOptions,
  createCodexAppServerSession,
} from "./codex-app-server-session.js";

type JsonObject = Record<string, unknown>;
type RpcRequest = { id?: number; method: string; params?: JsonObject };
type SessionConfiguration = Partial<
  Omit<CodexAppServerSessionOptions, "onUsage" | "onEvent" | "onStop">
>;
const sessions: CodexAppServerSession[] = [];
const threadId = "thread-1";
const turnId = "turn-1";

afterEach(() => {
  for (const session of sessions.splice(0)) session.finish();
});

function notification(method: string, params: JsonObject): JsonObject {
  return { method, params };
}

function counters(inputTokens = 60, outputTokens = 30, overrides: JsonObject = {}): JsonObject {
  return {
    inputTokens,
    cachedInputTokens: 10,
    outputTokens,
    reasoningOutputTokens: 5,
    cacheWriteInputTokens: 4,
    totalTokens: inputTokens + outputTokens,
    ...overrides,
  };
}

function usage(total: unknown = counters(), binding: JsonObject = {}): JsonObject {
  return notification("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: { total },
    ...binding,
  });
}

function item(value: JsonObject, method = "item/completed", binding: JsonObject = {}): JsonObject {
  return notification(method, { threadId, turnId, item: value, ...binding });
}

function completion(
  status = "completed",
  items: JsonObject[] = [],
  binding: JsonObject = {},
): JsonObject {
  return notification("turn/completed", {
    threadId,
    turn: { id: turnId, status, items },
    ...binding,
  });
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fixture(
  configuration: SessionConfiguration = {},
  replies: { threadModel?: string; turn?: unknown; autoInterruptAck?: boolean } = {},
) {
  const requests: RpcRequest[] = [];
  const chunks: Buffer[] = [];
  const onUsage = vi.fn<CodexAppServerSessionOptions["onUsage"]>();
  const onEvent = vi.fn<CodexAppServerSessionOptions["onEvent"]>();
  const onStop = vi.fn<CodexAppServerSessionOptions["onStop"]>();
  const model = configuration.model ?? "gpt-6-luna";
  let pending = Buffer.alloc(0);
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const session = createCodexAppServerSession({
    model,
    cwd: "C:\\Attempts\\source",
    prompt: "Inspect the proposed change.",
    outputSchema: { type: "object", properties: { summary: { type: "string" } } },
    passiveProposal: false,
    maximumResultBytes: 16_384,
    ...configuration,
    onUsage,
    onEvent,
    onStop,
  });
  sessions.push(session);
  const push = (...messages: JsonObject[]): void => {
    session.push(Buffer.from(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`));
  };
  const stdin = {
    streamId: "stdin-1",
    write: vi.fn<ManagedProcessStandardInput["write"]>(async (bytes) => {
      activeWrites++;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      try {
        await Promise.resolve();
        const chunk = Buffer.from(bytes);
        chunks.push(chunk);
        pending = Buffer.concat([pending, chunk]);
        let boundary = pending.indexOf(10);
        while (boundary !== -1) {
          const request = JSON.parse(pending.subarray(0, boundary).toString("utf8")) as RpcRequest;
          pending = pending.subarray(boundary + 1);
          requests.push(request);
          if (request.id !== undefined) {
            const result =
              request.method === "thread/start"
                ? { thread: { id: threadId }, model: replies.threadModel ?? model }
                : request.method === "turn/start"
                  ? { turn: replies.turn ?? { id: turnId } }
                  : {};
            if (request.method !== "turn/interrupt" || replies.autoInterruptAck !== false)
              push({ id: request.id, result });
          }
          boundary = pending.indexOf(10);
        }
      } finally {
        activeWrites--;
      }
    }),
    close: vi.fn<ManagedProcessStandardInput["close"]>(async () => {}),
  } satisfies ManagedProcessStandardInput;
  return {
    session,
    stdin,
    requests,
    chunks,
    onUsage,
    onEvent,
    onStop,
    push,
    start: () => session.start(stdin),
    maximumActiveWrites: () => maximumActiveWrites,
    events: () =>
      onEvent.mock.calls.map(
        ([bytes]) => JSON.parse(Buffer.from(bytes).toString("utf8")) as JsonObject,
      ),
  };
}

describe("Codex app-server session protocol", () => {
  it.each([false, true])(
    "starts one ephemeral Luna turn with the requested schema and passive mode %s",
    async (passiveProposal) => {
      const outputSchema = {
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string" } },
      };
      const f = fixture({ passiveProposal, outputSchema });
      await f.start();
      expect(f.requests.map((request) => request.method)).toEqual([
        "initialize",
        "initialized",
        "thread/start",
        "turn/start",
      ]);
      expect(f.requests.find((request) => request.method === "thread/start")?.params).toMatchObject(
        {
          model: "gpt-6-luna",
          cwd: "C:\\Attempts\\source",
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: passiveProposal ? "read-only" : "danger-full-access",
        },
      );
      expect(f.requests.find((request) => request.method === "turn/start")?.params).toEqual({
        threadId,
        model: "gpt-6-luna",
        input: [{ type: "text", text: "Inspect the proposed change." }],
        outputSchema,
      });
      expect(f.onStop).not.toHaveBeenCalled();
    },
  );

  it("serializes writes into at most 64 KiB chunks without corrupting a large UTF-8 prompt", async () => {
    const prompt = "\u{1f680}".repeat(40_000);
    const f = fixture({ prompt });
    await f.start();
    expect(f.chunks.some((chunk) => chunk.byteLength === 65_536)).toBe(true);
    expect(f.chunks.every((chunk) => chunk.byteLength > 0 && chunk.byteLength <= 65_536)).toBe(
      true,
    );
    expect(f.maximumActiveWrites()).toBe(1);
    expect(f.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(f.requests.find((request) => request.method === "turn/start")?.params?.input).toEqual([
      { type: "text", text: prompt },
    ]);
  });

  it("ignores usage, items, completion, and rerouting for another thread or turn", async () => {
    const f = fixture();
    await f.start();
    const foreign = { id: "foreign", type: "agentMessage", text: "Foreign answer." };
    for (const binding of [{ threadId: "other-thread" }, { turnId: "other-turn" }]) {
      f.push(usage(counters(), binding), item(foreign, "item/completed", binding));
      f.push(
        notification("model/rerouted", { threadId, turnId, toModel: "gpt-6-sol", ...binding }),
      );
    }
    f.push(
      completion("completed", [foreign], { threadId: "other-thread" }),
      completion("completed", [foreign], {
        turn: { id: "other-turn", status: "completed", items: [foreign] },
      }),
      notification("thread/compacted", { threadId: "other-thread" }),
    );
    expect(f.onUsage).not.toHaveBeenCalled();
    expect(f.onEvent).not.toHaveBeenCalled();
    expect(f.onStop).not.toHaveBeenCalled();
    expect(f.stdin.close).not.toHaveBeenCalled();
    f.push(usage(), completion());
    expect(f.session.snapshot(true)).toMatchObject({
      completeness: "complete",
      completedTurns: 1,
      usage: { totalTokens: 90 },
    });
  });

  it("rejects a second turn identity on the same ephemeral thread", async () => {
    const f = fixture();
    await f.start();
    f.push(notification("turn/started", { threadId, turn: { id: "other-turn" } }));
    expect(f.onStop).toHaveBeenCalledExactlyOnceWith("protocol_error");
  });

  it("requires the turn/start response to identify its turn", async () => {
    const f = fixture({}, { turn: {} });
    await expect(f.start()).rejects.toThrow();
    expect(f.onStop).toHaveBeenCalledExactlyOnceWith("protocol_error");
  });

  it("deduplicates cumulative usage snapshots instead of adding them", async () => {
    const f = fixture();
    await f.start();
    f.push(usage(), usage(), usage(counters(70, 40)), usage(counters(70, 40)));
    expect(f.onUsage).toHaveBeenCalledTimes(2);
    expect(f.session.snapshot(false)).toMatchObject({
      completeness: "partial",
      completedTurns: 0,
      usage: { inputTokens: 70, outputTokens: 40, totalTokens: 110 },
    });
    f.push(completion());
    expect(f.session.snapshot(true)).toMatchObject({
      completeness: "complete",
      completedTurns: 1,
      usage: { totalTokens: 110 },
    });
  });

  it("preserves reasoning and cache details without duplicating them as provider counters", async () => {
    const f = fixture();
    await f.start();
    f.push(usage(), completion());
    expect(f.session.snapshot(true).usage).toEqual({
      inputTokens: 60,
      cachedReadTokens: 10,
      outputTokens: 30,
      reasoningTokens: 5,
      cacheWriteTokens: 4,
      totalTokens: 90,
      providerCounters: {},
    });
  });

  it("defaults omitted cache-write input tokens to zero", async () => {
    const f = fixture();
    await f.start();
    const total = counters();
    delete total.cacheWriteInputTokens;
    f.push(usage(total), completion());
    expect(f.onStop).not.toHaveBeenCalled();
    expect(f.session.snapshot(true)).toMatchObject({
      completeness: "complete",
      usage: { cacheWriteTokens: 0, totalTokens: 90, providerCounters: {} },
    });
  });

  it.each([
    counters(59, 31),
    counters(61, 29),
    counters(60, 30, { cachedInputTokens: 9 }),
    counters(60, 30, { reasoningOutputTokens: 4 }),
    counters(60, 30, { cacheWriteInputTokens: 3 }),
    counters(60, 30, { cachedInputTokens: null }),
  ])(
    "retains observed usage and completes when a counter decreases or disappears: %j",
    async (next) => {
      const f = fixture();
      await f.start();
      f.push(usage(), usage(next));
      expect(f.onStop).not.toHaveBeenCalled();
      expect(f.onUsage).toHaveBeenCalledTimes(1);
      expect(f.session.snapshot(true)).toMatchObject({
        completeness: "partial",
        usage: { inputTokens: 60, outputTokens: 30, totalTokens: 90 },
      });
      const answer = JSON.stringify({ summary: "The investigation completed." });
      f.push(
        usage(counters(70, 40)),
        completion("completed", [{ id: "answer", type: "agentMessage", text: answer }]),
      );
      await nextImmediate();
      expect(f.onStop).not.toHaveBeenCalled();
      expect(f.onUsage).toHaveBeenCalledTimes(2);
      expect(f.session.snapshot(true)).toMatchObject({
        completeness: "partial",
        completedTurns: 1,
        usage: { inputTokens: 70, outputTokens: 40, totalTokens: 110 },
      });
      expect(f.session.finalMessage()).toBe(answer);
      expect(f.stdin.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    null,
    {},
    counters(60, 30, { inputTokens: 60.5 }),
    counters(60, 30, { totalTokens: 89 }),
    counters(60, 30, { cachedInputTokens: 61 }),
    counters(60, 30, { reasoningOutputTokens: 31 }),
  ])(
    "completes with incomplete accounting when bound usage is unavailable or inconsistent: %j",
    async (total) => {
      const f = fixture();
      await f.start();
      const answer = JSON.stringify({ summary: "The result is independent of accounting." });
      f.push(
        usage(total),
        completion("completed", [{ id: "answer", type: "agentMessage", text: answer }]),
      );
      await nextImmediate();
      expect(f.onStop).not.toHaveBeenCalled();
      expect(f.session.snapshot(true).completedTurns).toBe(1);
      expect(f.session.snapshot(true).completeness).toBe(
        total === null || Object.keys(total).length === 0 ? "unavailable" : "partial",
      );
      if (total === null || Object.keys(total).length === 0)
        expect(f.session.snapshot(true).usage.totalTokens).toBeNull();
      expect(f.session.finalMessage()).toBe(answer);
      expect(f.stdin.close).toHaveBeenCalledTimes(1);
    },
  );

  it("returns a completed answer with unavailable accounting when no usage was emitted", async () => {
    const f = fixture();
    await f.start();
    const answer = JSON.stringify({ summary: "The completed result has no usage record." });
    f.push(completion("completed", [{ id: "answer", type: "agentMessage", text: answer }]));
    await nextImmediate();
    expect(f.onStop).not.toHaveBeenCalled();
    expect(f.onUsage).not.toHaveBeenCalled();
    expect(f.session.snapshot(true)).toMatchObject({
      completeness: "unavailable",
      completedTurns: 1,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    });
    expect(f.session.finalMessage()).toBe(answer);
    expect(f.stdin.close).toHaveBeenCalledTimes(1);
  });

  it("keeps accounting partial after usable counters follow a missing usage record", async () => {
    const f = fixture();
    await f.start();
    f.push(usage(null), usage(), completion());
    await nextImmediate();
    expect(f.onStop).not.toHaveBeenCalled();
    expect(f.onUsage).toHaveBeenCalledTimes(1);
    expect(f.session.snapshot(true)).toMatchObject({
      completeness: "partial",
      completedTurns: 1,
      usage: { totalTokens: 90 },
    });
  });

  it("keeps malformed protocol output fatal after accounting becomes incomplete", async () => {
    const f = fixture();
    await f.start();
    f.push(usage(null));
    f.session.push(Buffer.from("invalid JSON\n"));
    expect(f.onStop).toHaveBeenCalledExactlyOnceWith("protocol_error");
    f.push(completion("completed", [{ id: "answer", type: "agentMessage", text: "Done." }]));
    expect(f.session.finalMessage()).toBe("");
    expect(f.session.snapshot(true).completeness).toBe("unavailable");
  });

  it.each([
    notification("thread/compacted", { threadId }),
    item({ id: "compaction-1", type: "contextCompaction" }, "item/started"),
    item({ id: "compaction-1", type: "contextCompaction" }),
  ])(
    "continues through context compaction while retaining partial accounting: %j",
    async (event) => {
      const f = fixture();
      await f.start();
      const answer = JSON.stringify({ summary: "The investigation continued after compaction." });
      f.push(
        usage(),
        event,
        usage(counters(70, 40)),
        completion("completed", [{ id: "answer", type: "agentMessage", text: answer }]),
      );
      await nextImmediate();
      expect(f.onStop).not.toHaveBeenCalled();
      expect(f.session.snapshot(true)).toMatchObject({
        completeness: "partial",
        completedTurns: 1,
        usage: { inputTokens: 70, outputTokens: 40, totalTokens: 110 },
      });
      expect(f.session.finalMessage()).toBe(answer);
      expect(f.stdin.close).toHaveBeenCalledTimes(1);
    },
  );

  it("retains streamed usage above former token limits without stopping the turn", async () => {
    const f = fixture();
    await f.start();
    f.push(usage(counters(8_000_000, 5_000_000)), usage(counters(8_000_000, 5_000_000)));
    await nextImmediate();
    expect(f.onStop).not.toHaveBeenCalled();
    expect(f.onUsage).toHaveBeenCalledTimes(1);
    expect(f.stdin.close).not.toHaveBeenCalled();
    expect(f.session.snapshot(true)).toMatchObject({
      completeness: "partial",
      usage: { totalTokens: 13_000_000 },
    });
  });

  it("accepts completion with unrestricted token usage in the same stdout batch", async () => {
    const f = fixture();
    await f.start();
    f.push(
      usage(counters(16_000_000, 4_000_000)),
      completion("completed", [{ id: "answer", type: "agentMessage", text: "Done." }]),
    );
    await nextImmediate();
    expect(f.onStop).not.toHaveBeenCalled();
    expect(f.session.snapshot(true)).toMatchObject({
      completeness: "complete",
      usage: { totalTokens: 20_000_000 },
    });
    expect(f.session.finalMessage()).toBe("Done.");
    expect(f.stdin.close).toHaveBeenCalledTimes(1);
  });

  it("keeps an active turn running as token usage increases between stdout batches", async () => {
    const f = fixture();
    await f.start();
    f.push(usage(counters(10_000_000, 2_000_000)));
    expect(f.onStop).not.toHaveBeenCalled();
    await nextImmediate();
    f.push(usage(counters(12_000_000, 4_000_000)));
    await nextImmediate();
    expect(f.onStop).not.toHaveBeenCalled();
    expect(f.stdin.close).not.toHaveBeenCalled();
    expect(f.session.snapshot(true)).toMatchObject({
      completeness: "partial",
      usage: { totalTokens: 16_000_000 },
    });
    f.push(completion());
    await nextImmediate();
    expect(f.onStop).not.toHaveBeenCalled();
    expect(f.session.snapshot(true)).toMatchObject({
      completeness: "complete",
      usage: { totalTokens: 16_000_000 },
    });
    expect(f.stdin.close).toHaveBeenCalledTimes(1);
  });

  it("sends one interrupt and waits for the interrupted turn before closing stdin", async () => {
    const f = fixture();
    await f.start();
    f.push(usage());
    const first = f.session.interrupt();
    const second = f.session.interrupt();
    expect(second).toBe(first);
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await nextImmediate();
    expect(f.requests.filter((request) => request.method === "turn/interrupt")).toEqual([
      expect.objectContaining({ params: { threadId, turnId } }),
    ]);
    expect(settled).toBe(false);
    expect(f.stdin.close).not.toHaveBeenCalled();
    f.push(completion("interrupted"));
    await first;
    await f.session.interrupt();
    expect(f.stdin.close).toHaveBeenCalledTimes(1);
    expect(f.onStop).not.toHaveBeenCalled();
    expect(f.session.snapshot(true)).toMatchObject({ completeness: "partial", completedTurns: 0 });
    expect(f.session.finalMessage()).toBe("");
  });

  it("waits for the interrupt acknowledgement when turn completion arrives first", async () => {
    const f = fixture({}, { autoInterruptAck: false });
    await f.start();
    const interrupted = f.session.interrupt();
    let settled = false;
    void interrupted.then(() => {
      settled = true;
    });
    await nextImmediate();
    const request = f.requests.find((entry) => entry.method === "turn/interrupt")!;
    f.push(completion("interrupted"));
    await nextImmediate();
    expect(settled).toBe(false);
    f.push({ id: request.id, result: {} });
    await interrupted;
    expect(f.stdin.close).toHaveBeenCalledTimes(1);
    expect(f.onStop).not.toHaveBeenCalled();
  });

  it("retains partial usage when transport ends before turn completion", async () => {
    const f = fixture();
    await f.start();
    f.push(usage(), item({ id: "answer", type: "agentMessage", text: "Unconfirmed answer." }));
    f.session.finish();
    expect(f.onStop).toHaveBeenCalledExactlyOnceWith("protocol_error");
    expect(f.session.snapshot(true)).toMatchObject({
      completeness: "partial",
      completedTurns: 0,
      usage: { totalTokens: 90 },
    });
    expect(f.session.finalMessage()).toBe("");
  });

  it("does not claim complete accounting when the caller reports incomplete transport", async () => {
    const f = fixture();
    await f.start();
    f.push(usage(), completion());
    expect(f.session.snapshot(false)).toMatchObject({ completeness: "partial", completedTurns: 1 });
    expect(f.session.snapshot(true).completeness).toBe("complete");
  });

  it("rejects a handshake that selects a model other than the requested Luna model", async () => {
    const f = fixture({}, { threadModel: "gpt-6-sol" });
    await expect(f.start()).rejects.toThrow();
    expect(f.onStop).toHaveBeenCalledExactlyOnceWith("model_mismatch");
    expect(f.requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  it("rejects a bound reroute to another model", async () => {
    const f = fixture();
    await f.start();
    f.push(usage(null));
    f.push(notification("model/rerouted", { threadId, turnId, toModel: "gpt-6-luna" }));
    expect(f.onStop).not.toHaveBeenCalled();
    f.push(notification("model/rerouted", { threadId, turnId, toModel: "gpt-6-astra" }));
    expect(f.onStop).toHaveBeenCalledExactlyOnceWith("model_mismatch");
  });

  it.each([
    { text: "\u00e9\u00e9", accepted: true },
    { text: "\u00e9\u00e9\u00e9", accepted: false },
  ])("limits final output by UTF-8 bytes: %j", async ({ text, accepted }) => {
    const f = fixture({ maximumResultBytes: 4 });
    await f.start();
    f.push(
      usage(),
      completion("completed", [
        { id: "answer", type: "agentMessage", phase: "final_answer", text },
      ]),
    );
    if (accepted) {
      expect(f.onStop).not.toHaveBeenCalled();
      expect(f.session.finalMessage()).toBe(text);
    } else {
      expect(f.onStop).toHaveBeenCalledExactlyOnceWith("protocol_error");
      expect(f.session.finalMessage()).toBe("");
    }
  });

  it("normalizes ordinary message, command, and MCP events without treating commentary as final output", async () => {
    const f = fixture();
    await f.start();
    f.push(
      item({ id: "comment", type: "agentMessage", phase: "commentary", text: "Inspecting." }),
      item(
        {
          id: "command",
          type: "commandExecution",
          command: "git status --short",
          aggregatedOutput: "",
          exitCode: null,
          status: "inProgress",
        },
        "item/started",
      ),
      item({
        id: "command",
        type: "commandExecution",
        command: "git status --short",
        aggregatedOutput: "clean\n",
        exitCode: 0,
        status: "completed",
      }),
      item({ id: "tool", type: "mcpToolCall", server: "fixture", tool: "inspect" }),
    );
    expect(f.events()).toEqual([
      {
        type: "item.completed",
        item: { id: "comment", type: "agent_message", text: "Inspecting." },
      },
      {
        type: "item.started",
        item: {
          id: "command",
          type: "command_execution",
          command: "git status --short",
          aggregated_output: "",
          exit_code: null,
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "command",
          type: "command_execution",
          command: "git status --short",
          aggregated_output: "clean\n",
          exit_code: 0,
          status: "completed",
        },
      },
      { type: "item.completed", item: { id: "tool", type: "mcp_tool_call" } },
    ]);
    f.push(usage(), completion());
    expect(f.session.finalMessage()).toBe("");
  });
});
