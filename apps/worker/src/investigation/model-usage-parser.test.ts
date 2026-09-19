import { unavailableInvestigationTokenUsage } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { parseCliModelUsage } from "./model-usage-parser.js";

const jsonl = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
const complete = (usage: unknown, turnId?: string) => ({
  type: "turn.completed",
  usage,
  ...(turnId === undefined ? {} : { turn_id: turnId }),
});
const snapshot = (usage: unknown, lastUsage?: unknown) => ({
  type: "turn.completed",
  data: { info: { total_token_usage: usage, last_token_usage: lastUsage } },
});

describe("parseCliModelUsage", () => {
  it("adds Codex turn deltas without counting item metrics or token subdivisions twice", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        { type: "item.completed", item: { usage: { input_tokens: 900, output_tokens: 900 } } },
        complete({
          input_tokens: 31,
          cached_input_tokens: 7,
          output_tokens: 19,
          reasoning_output_tokens: 4,
          cache_write_tokens: 2,
          billable_requests: 1,
          note: "This is not a counter.",
        }),
        complete({
          input_tokens: 11,
          cached_input_tokens: 3,
          output_tokens: 9,
          reasoning_output_tokens: 2,
          cache_write_tokens: 1,
          billable_requests: 1,
        }),
      ),
    );
    expect(result).toEqual({
      usage: {
        inputTokens: 42,
        cachedReadTokens: 10,
        outputTokens: 28,
        reasoningTokens: 6,
        cacheWriteTokens: 3,
        totalTokens: 70,
        providerCounters: { billable_requests: 2 },
      },
      completeness: "complete",
      completedTurns: 2,
    });
  });

  it("counts identical usage from distinct turns and deduplicates only explicit turn identities", () => {
    const usage = { input_tokens: 31, output_tokens: 19 };
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        complete(usage, "turn-a"),
        complete(usage, "turn-a"),
        complete(usage, "turn-b"),
        complete(usage),
        complete(usage),
      ),
    );
    expect(result.usage.totalTokens).toBe(200);
    expect(result.completedTurns).toBe(4);
    expect(result.completeness).toBe("complete");
  });

  it("keeps missing per-turn details unknown while retaining a complete invocation total", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        complete({
          input_tokens: 10,
          output_tokens: 5,
          cached_input_tokens: 7,
          reasoning_tokens: 2,
          cache_write_tokens: 3,
          requests: 1,
        }),
        complete({ input_tokens: 10, output_tokens: 5 }),
      ),
    );
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      cachedReadTokens: null,
      reasoningTokens: null,
      cacheWriteTokens: null,
      providerCounters: { requests: null },
    });
    expect(result.completeness).toBe("complete");
  });

  it("retains the first receipt when a repeated turn identity reports conflicting usage", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        complete({ input_tokens: 10, output_tokens: 5 }, "turn-a"),
        complete({ input_tokens: 100, output_tokens: 50 }, "turn-a"),
      ),
    );
    expect(result.usage.totalTokens).toBe(15);
    expect(result.completedTurns).toBe(1);
    expect(result.completeness).toBe("partial");
  });

  it("ignores token events and model-authored content outside completed turn receipts", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        {
          type: "event_msg",
          payload: { type: "token_count", info: { total_token_usage: { total_tokens: 80 } } },
        },
        {
          type: "item.completed",
          usage: { total_tokens: 80 },
          item: { text: '{"total_tokens":80}' },
        },
      ),
    );
    expect(result).toEqual({
      usage: unavailableInvestigationTokenUsage(),
      completeness: "unavailable",
      completedTurns: 0,
    });
  });

  it("subtracts explicitly cumulative snapshots instead of summing their totals", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        snapshot({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }),
        snapshot({ input_tokens: 30, output_tokens: 20, total_tokens: 50 }),
        snapshot({ input_tokens: 30, output_tokens: 20, total_tokens: 50 }),
      ),
    );
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 20, totalTokens: 50 });
    expect(result.completeness).toBe("complete");
    expect(result.completedTurns).toBe(3);
  });

  it("uses a last-turn delta once when a cumulative snapshot is present in the same receipt", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        snapshot({ input_tokens: 10, output_tokens: 5 }, { input_tokens: 10, output_tokens: 5 }),
        snapshot({ input_tokens: 30, output_tokens: 20 }, { input_tokens: 20, output_tokens: 15 }),
      ),
    );
    expect(result.usage.totalTokens).toBe(50);
    expect(result.completeness).toBe("complete");
  });

  it("uses earlier direct deltas as the baseline for later cumulative snapshots", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        complete({ input_tokens: 10, output_tokens: 5 }),
        snapshot({ input_tokens: 30, output_tokens: 20 }),
      ),
    );
    expect(result.usage.totalTokens).toBe(50);
    expect(result.completeness).toBe("complete");
  });

  it("marks conflicting cumulative and per-turn metrics partial without adding the cumulative value", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        snapshot({ total_tokens: 50 }, { total_tokens: 50 }),
        snapshot({ total_tokens: 10 }, { total_tokens: 10 }),
      ),
    );
    expect(result.usage.totalTokens).toBe(50);
    expect(result.completeness).toBe("partial");
    const conflict = parseCliModelUsage(
      "codex",
      jsonl(snapshot({ total_tokens: 100 }, { total_tokens: 15 })),
    );
    expect(conflict.usage.totalTokens).toBe(15);
    expect(conflict.completeness).toBe("partial");
  });

  it("does not add a repeated cumulative snapshot merely because it repeats its last delta", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        snapshot({ input_tokens: 10, output_tokens: 5 }, { input_tokens: 10, output_tokens: 5 }),
        snapshot({ input_tokens: 10, output_tokens: 5 }, { input_tokens: 10, output_tokens: 5 }),
      ),
    );
    expect(result.usage.totalTokens).toBe(15);
    expect(result.completeness).toBe("partial");
  });

  it("handles provider counter names that also exist on the object prototype", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        snapshot({ total_tokens: 15, constructor: 1, toString: 2 }),
        snapshot({ total_tokens: 30, constructor: 3, toString: 4 }),
      ),
    );
    expect(result.usage.providerCounters).toEqual({ constructor: 3, toString: 4 });
    expect(result.completeness).toBe("complete");
  });

  it("does not restart a previously observed provider counter at zero after a missing snapshot", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        snapshot({ total_tokens: 15, requests: 10 }),
        snapshot({ total_tokens: 20 }),
        snapshot({ total_tokens: 25, requests: 20 }),
      ),
    );
    expect(result.usage.totalTokens).toBe(25);
    expect(result.usage.providerCounters.requests).toBeNull();
    expect(result.completeness).toBe("complete");
  });

  it("does not guess a missing cumulative baseline or add a reset snapshot as a new delta", () => {
    const missing = parseCliModelUsage(
      "codex",
      jsonl(complete(undefined), snapshot({ total_tokens: 50 })),
    );
    expect(missing.usage.totalTokens).toBeNull();
    expect(missing.completeness).not.toBe("complete");
    const reset = parseCliModelUsage(
      "codex",
      jsonl(
        snapshot({ total_tokens: 50 }),
        snapshot({ total_tokens: 10 }),
        snapshot({ total_tokens: 20 }),
      ),
    );
    expect(reset.usage.totalTokens).toBe(50);
    expect(reset.completeness).toBe("partial");
  });

  it.each(["error", "turn.failed", "turn.cancelled", "abort"])(
    "preserves completed usage after a %s event",
    (type) => {
      const result = parseCliModelUsage(
        "codex",
        jsonl(complete({ input_tokens: 10, output_tokens: 5 }), { type }),
      );
      expect(result.usage.totalTokens).toBe(15);
      expect(result.completeness).toBe("partial");
    },
  );

  it("preserves earlier usage when the stream has a truncated or non-object tail", () => {
    for (const tail of ['{"type":', "null", "[]", '{"usage":1}']) {
      const result = parseCliModelUsage(
        "codex",
        `${jsonl(complete({ total_tokens: 15 }))}\n${tail}`,
      );
      expect(result.usage.totalTokens).toBe(15);
      expect(result.completeness).toBe("partial");
    }
  });

  it("marks a later unfinished turn partial while retaining earlier completed usage", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        { type: "turn.started", turn_id: "turn-a" },
        complete({ total_tokens: 15 }, "turn-a"),
        { type: "turn.started", turn_id: "turn-b" },
        complete({ total_tokens: 15 }, "turn-a"),
      ),
    );
    expect(result.usage.totalTokens).toBe(15);
    expect(result.completeness).toBe("partial");
  });

  it("distinguishes unavailable usage from explicit zero counts and optional missing details", () => {
    expect(parseCliModelUsage("codex", jsonl(complete(undefined)))).toEqual({
      usage: unavailableInvestigationTokenUsage(),
      completeness: "unavailable",
      completedTurns: 1,
    });
    expect(
      parseCliModelUsage("codex", jsonl(complete({ input_tokens: 0, output_tokens: 0 }))),
    ).toEqual({
      usage: {
        ...unavailableInvestigationTokenUsage(),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      completeness: "complete",
      completedTurns: 1,
    });
  });

  it("accepts an explicit total without inventing its unavailable breakdown", () => {
    const result = parseCliModelUsage("codex", jsonl(complete({ total_tokens: 17 })));
    expect(result).toEqual({
      usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 17 },
      completeness: "complete",
      completedTurns: 1,
    });
  });

  it("keeps complete totals when only a later turn omits its input/output breakdown", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(complete({ input_tokens: 10, output_tokens: 5 }), complete({ total_tokens: 20 })),
    );
    expect(result.usage).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: 35 });
    expect(result.completeness).toBe("complete");
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "10", {}])(
    "rejects invalid token count %j while preserving other reported fields",
    (input_tokens) => {
      const result = parseCliModelUsage(
        "codex",
        jsonl(complete({ input_tokens, output_tokens: 5 })),
      );
      expect(result.usage.inputTokens).toBeNull();
      expect(result.usage.outputTokens).toBe(5);
      expect(result.usage.totalTokens).toBeNull();
      expect(result.completeness).toBe("partial");
    },
  );

  it("does not restore a counter after its accumulated sum overflows", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        complete({
          input_tokens: Number.MAX_SAFE_INTEGER,
          output_tokens: 0,
          requests: Number.MAX_SAFE_INTEGER,
        }),
        complete({ input_tokens: 1, output_tokens: 0, requests: 1 }),
        complete({ input_tokens: 1, output_tokens: 0, requests: 1 }),
      ),
    );
    expect(result.usage).toMatchObject({
      inputTokens: null,
      outputTokens: 0,
      totalTokens: null,
      providerCounters: { requests: null },
    });
    expect(result.completeness).toBe("partial");
  });

  it("keeps a safe known total when input plus output cannot be represented safely", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        complete({
          input_tokens: Number.MAX_SAFE_INTEGER,
          output_tokens: 1,
          total_tokens: 20,
        }),
      ),
    );
    expect(result.usage).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: 20 });
    expect(result.completeness).toBe("partial");
  });

  it("retains known subtotals without constructing a contradictory partial breakdown", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(complete({ input_tokens: 10, output_tokens: 5 }), complete({ input_tokens: 3 })),
    );
    expect(result.usage).toMatchObject({ inputTokens: 13, outputTokens: null, totalTokens: 15 });
    expect(result.completeness).toBe("partial");
  });

  it("drops contradictory aliases, totals, and subset counts without losing trustworthy values", () => {
    const result = parseCliModelUsage(
      "codex",
      jsonl(
        complete({
          input_tokens: 10,
          inputTokens: 11,
          output_tokens: 5,
          total_tokens: 15,
          cached_input_tokens: 3,
          reasoning_tokens: 6,
        }),
      ),
    );
    expect(result.usage).toMatchObject({
      inputTokens: null,
      outputTokens: 5,
      reasoningTokens: null,
      totalTokens: 15,
    });
    expect(result.completeness).toBe("partial");
    const totalConflict = parseCliModelUsage(
      "codex",
      jsonl(complete({ input_tokens: 10, output_tokens: 5, total_tokens: 100 })),
    );
    expect(totalConflict.usage.totalTokens).toBeNull();
    expect(totalConflict.completeness).toBe("partial");
    const cacheConflict = parseCliModelUsage(
      "codex",
      jsonl(complete({ input_tokens: 10, output_tokens: 5, cached_input_tokens: 11 })),
    );
    expect(cacheConflict.usage.cachedReadTokens).toBeNull();
    expect(cacheConflict.usage.totalTokens).toBe(15);
  });

  it("uses Copilot model metrics once and preserves only numeric provider counters", () => {
    const sidecar = JSON.stringify({
      modelMetrics: {
        primary: {
          usage: {
            inputTokens: 20,
            outputTokens: 10,
            cacheReadTokens: 8,
            cacheWriteTokens: 4,
            reasoningTokens: 6,
            requests: 1,
            provider: { audioTokens: 2, label: "private" },
          },
        },
        secondary: {
          usage: {
            prompt_tokens: 40,
            completion_tokens: 3,
            prompt_tokens_details: { cached_tokens: 2 },
            completion_tokens_details: { reasoning_tokens: 1 },
            cache_creation_input_tokens: 1,
            requests: 2,
            provider: { audioTokens: 3 },
          },
        },
      },
      agentMetrics: { primary: { usage: { inputTokens: 20, outputTokens: 10 } } },
      totalTokens: 9999,
    });
    const result = parseCliModelUsage(
      "copilot",
      jsonl({
        type: "result",
        exitCode: 0,
        usage: { inputTokens: 1000, outputTokens: 1000, premiumRequests: 1, requests: 99 },
      }),
      sidecar,
    );
    expect(result).toEqual({
      usage: {
        inputTokens: 60,
        outputTokens: 13,
        cachedReadTokens: 10,
        cacheWriteTokens: 5,
        reasoningTokens: 7,
        totalTokens: 73,
        providerCounters: { requests: 3, "provider.audioTokens": 5, premiumRequests: 1 },
      },
      completeness: "complete",
      completedTurns: 1,
    });
  });

  it("preserves valid sidecar models when another model has no reported usage", () => {
    const result = parseCliModelUsage(
      "copilot",
      jsonl({ type: "result", exitCode: 0 }),
      JSON.stringify({
        modelMetrics: { primary: { usage: { inputTokens: 10, outputTokens: 5 } }, secondary: {} },
      }),
    );
    expect(result.usage.totalTokens).toBe(15);
    expect(result.completeness).toBe("partial");
  });

  it("falls back to result usage for an invalid sidecar while marking it incomplete", () => {
    const result = parseCliModelUsage(
      "copilot",
      jsonl({
        type: "result",
        exitCode: 0,
        usage: { totalTokens: 15 },
      }),
      "{truncated",
    );
    expect(result.usage.totalTokens).toBe(15);
    expect(result.completeness).toBe("partial");
  });

  it("does not add repeated Copilot session results or child result events", () => {
    const result = parseCliModelUsage(
      "copilot",
      jsonl(
        { type: "result", agentId: "child", usage: { totalTokens: 1000 } },
        { type: "result", exitCode: 0, usage: { totalTokens: 15 } },
        { type: "result", exitCode: 0, usage: { totalTokens: 15 } },
      ),
    );
    expect(result.usage.totalTokens).toBe(15);
    expect(result.completedTurns).toBe(1);
    expect(result.completeness).toBe("partial");
  });

  it("keeps sidecar usage partial when there is no root completion or the root fails", () => {
    const sidecar = JSON.stringify({ modelMetrics: { primary: { usage: { totalTokens: 15 } } } });
    for (const text of ["", jsonl({ type: "result", exitCode: 1 }), jsonl({ type: "abort" })]) {
      const result = parseCliModelUsage("copilot", text, sidecar);
      expect(result.usage.totalTokens).toBe(15);
      expect(result.completeness).toBe("partial");
    }
  });
});
