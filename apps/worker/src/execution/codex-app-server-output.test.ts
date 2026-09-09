import { createHash } from "node:crypto";
import { createCanonicalResult } from "@agentic-review/codex";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import {
  type CodexAppServerOutputErrorCode,
  type CodexAppServerOutputLimits,
  createCodexAppServerOutputCollector,
} from "./codex-app-server-output.js";
import { capturedCodexAppServerTurn } from "./codex-app-server-output.testing.js";

const schema = Type.Object(
  { schemaVersion: Type.Literal("SyntheticOutputV1"), answer: Type.String() },
  { additionalProperties: false },
);
const schemaJson = JSON.stringify(schema);
const authority = {
  json: schemaJson,
  digest: createHash("sha256").update(schemaJson).digest("hex"),
  resultSchema: schema,
};
const model = { schemaVersion: "SyntheticOutputV1", answer: "Synthetic result." };
const modelJson = JSON.stringify(model);
const threadId = "thread-synthetic";
const turnId = "turn-synthetic";
const turn = (status = "inProgress", overrides = {}) => ({
  id: turnId,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: 10,
  completedAt: status === "inProgress" ? null : 11,
  durationMs: null,
  ...overrides,
});
function fixture(
  options: {
    early?: boolean;
    protectedValues?: string[];
    limits?: Partial<CodexAppServerOutputLimits>;
  } = {},
) {
  const collector = createCodexAppServerOutputCollector({
    threadId,
    authoritativeSchema: authority,
    ...options,
  });
  const event = (method: string, params: Record<string, unknown>) =>
    collector.observe({ method, params, emittedAtMs: 100 });
  const started = () => event("turn/started", { threadId, turn: turn() });
  const completed = (status = "completed", overrides = {}) =>
    event("turn/completed", { threadId, turn: turn(status, overrides) });
  const itemStart = (item: Record<string, unknown>) =>
    event("item/started", { threadId, turnId, item, startedAtMs: 100 });
  const itemComplete = (item: Record<string, unknown>) =>
    event("item/completed", { threadId, turnId, item, completedAtMs: 101 });
  const agent = (id = "final", text = modelJson, phase: string | null = "final_answer") => {
    itemStart({ id, type: "agentMessage", text: "", phase });
    event("item/agentMessage/delta", { threadId, turnId, itemId: id, delta: text });
    itemComplete({ id, type: "agentMessage", text, phase });
  };
  if (!options.early) {
    collector.bindTurnStart({ turn: turn() });
    started();
  }
  return { collector, event, started, completed, itemStart, itemComplete, agent };
}
function throws(code: CodexAppServerOutputErrorCode, action: () => unknown) {
  expect(action).toThrowError(expect.objectContaining({ code }));
}
const command = (overrides: Record<string, unknown> = {}) => ({
  id: "command-1",
  type: "commandExecution",
  command: "node --version",
  commandActions: [],
  cwd: "C:\\synthetic\\checkout",
  source: "agent",
  status: "inProgress",
  processId: null,
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
  ...overrides,
});

describe("single-turn Codex app-server output collector", () => {
  it("accepts 512 protected values without dropping the bounded result", () => {
    const f = fixture({
      protectedValues: Array.from({ length: 512 }, (_, index) => `synthetic-protected-${index}`),
    });
    f.agent();
    f.completed();
    expect(f.collector.finish().result).toEqual(model);
  });

  it("rejects 513 protected values at configuration admission", () => {
    throws("INVALID_CONFIGURATION", () =>
      fixture({
        protectedValues: Array.from({ length: 513 }, (_, index) => `synthetic-protected-${index}`),
      }),
    );
  });

  it.each(["before_notifications", "after_notifications"] as const)(
    "replays all 19 fixed-0.145 controlled synthetic notifications with binding %s",
    async (binding) => {
      // Real CLI/ProcessHost capture, but the only Responses payload was supplied by the fixture.
      // This is a deterministic capture replay, not real model or isolation acceptance.
      const captured = capturedCodexAppServerTurn;
      const wireSchema = JSON.stringify(captured.schema);
      const typedSchema = Type.Object(
        {
          schemaVersion: Type.Literal("SyntheticAppServerTurnV1"),
          probeId: Type.Literal("04757ef4-c558-41a2-9304-fbd7ce8d2fa3"),
          synthetic: Type.Literal(true),
          toolCallsIssued: { ...Type.Literal(0), type: "integer" as const },
        },
        { additionalProperties: false },
      );
      const digest = createHash("sha256").update(wireSchema).digest("hex");
      expect(digest).toBe(captured.final.outputSchemaSha256);
      const c = createCodexAppServerOutputCollector({
        threadId: captured.final.threadId,
        authoritativeSchema: { json: wireSchema, digest, resultSchema: typedSchema },
      });
      expect(captured.notifications).toHaveLength(19);
      if (binding === "before_notifications") c.bindTurnStart(captured.turnStartResponse);
      for (const notification of captured.notifications) c.observe(notification);
      if (binding === "after_notifications") c.bindTurnStart(captured.turnStartResponse);
      await c.terminal;
      const output = c.finish();
      expect(output).toMatchObject({
        threadId: captured.final.threadId,
        turnId: captured.final.turnId,
        finalItemId: captured.final.itemId,
        finalSelection: "single_unphased_message",
        rawResultJson: captured.final.text,
        result: captured.final.value,
        resultDigest: "1e992dd057d6561c27f1b3df801834197a979b4b8d4906912195aacf5c415e30",
        commandEvidence: { commands: [], commandCapture: "complete" },
        observedFileChange: false,
      });
      expect(createHash("sha256").update(output.rawResultJson).digest("hex")).toBe(
        captured.final.sha256,
      );
      expect(output.resultDigest).not.toBe(captured.final.sha256);
      expect(
        captured.notifications.filter(
          (notification) =>
            notification.method === "item/started" &&
            "item" in notification.params &&
            notification.params.item.type === "userMessage",
        ),
      ).toHaveLength(1);
      expect(
        captured.notifications.filter(
          (notification) =>
            notification.method === "item/completed" &&
            "item" in notification.params &&
            notification.params.item.type === "userMessage",
        ),
      ).toHaveLength(1);
    },
  );

  it("never replaces a missing typed agent completion with the captured raw Responses duplicate", () => {
    const captured = capturedCodexAppServerTurn;
    const typedSchema = Type.Object(
      {
        schemaVersion: Type.Literal("SyntheticAppServerTurnV1"),
        probeId: Type.Literal("04757ef4-c558-41a2-9304-fbd7ce8d2fa3"),
        synthetic: Type.Literal(true),
        toolCallsIssued: { ...Type.Literal(0), type: "integer" as const },
      },
      { additionalProperties: false },
    );
    const json = JSON.stringify(captured.schema);
    const c = createCodexAppServerOutputCollector({
      threadId: captured.final.threadId,
      authoritativeSchema: {
        json,
        digest: createHash("sha256").update(json).digest("hex"),
        resultSchema: typedSchema,
      },
    });
    c.bindTurnStart(captured.turnStartResponse);
    throws("INCOMPLETE_STREAM", () => {
      for (const notification of captured.notifications) {
        if (
          notification.method === "item/completed" &&
          notification.params.item.type === "agentMessage"
        )
          continue;
        c.observe(notification);
      }
    });
  });

  it("retains raw and canonical model JSON from actual item events without legacy success records", async () => {
    const f = fixture();
    const raw = ' { "answer": "Synthetic result.", "schemaVersion": "SyntheticOutputV1" } ';
    f.agent("final", raw);
    f.completed();
    await f.collector.terminal;
    const output = f.collector.finish();
    expect(output).toMatchObject({
      threadId,
      turnId,
      finalItemId: "final",
      finalSelection: "explicit_final_answer",
      result: model,
      rawResultJson: raw,
      canonicalResultJson: createCanonicalResult(model).json,
      resultDigest: createCanonicalResult(model).sha256,
      commandEvidence: { commands: [], commandCapture: "complete" },
      observedFileChange: false,
    });
    expect(output).not.toHaveProperty("processExit");
    expect(output).not.toHaveProperty("executionAccepted");
    expect(Object.isFrozen(output.result)).toBe(true);
    expect(f.collector.finish()).toBe(output);
    expect(f.collector.state).toBe("finished");
  });

  it("buffers a complete fast turn before turn/start responds, then binds the exact response ID", async () => {
    const f = fixture({ early: true });
    f.started();
    f.agent();
    f.completed();
    expect(f.collector.state).toBe("awaiting_turn_id");
    expect(f.collector.bindTurnStart({ turn: turn() })).toBe(turnId);
    await f.collector.terminal;
    expect(f.collector.finish().result).toEqual(model);
  });

  it("rejects a response that binds a different early turn and never recovers the failed collector", async () => {
    const f = fixture({ early: true });
    f.started();
    throws("SCOPE_MISMATCH", () =>
      f.collector.bindTurnStart({ turn: turn("inProgress", { id: "foreign" }) }),
    );
    await expect(f.collector.terminal).rejects.toMatchObject({ code: "SCOPE_MISMATCH" });
    throws("SCOPE_MISMATCH", () => f.collector.finish());
    expect(f.collector.state).toBe("failed");
  });

  it.each(["early", "bound"])("rejects foreign thread IDs in %s events", (mode) => {
    const f = fixture({ early: mode === "early" });
    throws("SCOPE_MISMATCH", () =>
      f.event("item/started", {
        threadId: "foreign",
        turnId,
        item: { id: "a", type: "agentMessage", text: "" },
        startedAtMs: 1,
      }),
    );
  });

  it("rejects foreign turn IDs and conflicting IDs in the early buffer", () => {
    const f = fixture({ early: true });
    f.started();
    throws("SCOPE_MISMATCH", () =>
      f.event("item/started", {
        threadId,
        turnId: "other",
        item: { id: "a", type: "agentMessage", text: "" },
        startedAtMs: 1,
      }),
    );
    const bound = fixture();
    throws("SCOPE_MISMATCH", () =>
      bound.event("turn/completed", { threadId, turn: turn("completed", { id: "other" }) }),
    );
  });

  it("does not repair missing lifecycle events from turn.items snapshots", () => {
    const f = fixture();
    throws("ITEM_STATE_INVALID", () =>
      f.completed("completed", {
        itemsView: "full",
        items: [{ id: "final", type: "agentMessage", text: modelJson, phase: "final_answer" }],
      }),
    );
  });

  it("accepts the fixed-version deliberately empty notLoaded completion snapshot", () => {
    const f = fixture();
    f.agent();
    f.completed();
    expect(f.collector.finish().finalItemId).toBe("final");
  });

  it("accepts a matching full snapshot and rejects conflicting repeated item content", () => {
    const f = fixture();
    f.agent();
    f.completed("completed", {
      itemsView: "full",
      items: [{ id: "final", type: "agentMessage", text: modelJson, phase: "final_answer" }],
    });
    expect(f.collector.finish().result).toEqual(model);
    const other = fixture();
    other.agent();
    throws("ITEM_STATE_INVALID", () =>
      other.completed("completed", {
        itemsView: "full",
        items: [{ id: "final", type: "agentMessage", text: "changed", phase: "final_answer" }],
      }),
    );
  });

  it("selects one unphased message only when all other messages are commentary and no item follows", () => {
    const f = fixture();
    f.agent("preamble", "A short preamble.", "commentary");
    f.agent("answer", modelJson, null);
    f.completed();
    expect(f.collector.finish()).toMatchObject({
      finalItemId: "answer",
      finalSelection: "single_unphased_message",
    });
  });

  it("supports omitted phases and a completed message without optional deltas", () => {
    const f = fixture();
    f.itemStart({ id: "answer", type: "agentMessage", text: "" });
    f.itemComplete({ id: "answer", type: "agentMessage", text: modelJson });
    f.completed();
    expect(f.collector.finish().finalSelection).toBe("single_unphased_message");
  });

  it("prefers the single explicit final over earlier unphased messages", () => {
    const f = fixture();
    f.agent("preamble", "Unphased progress.", null);
    f.agent();
    f.completed();
    expect(f.collector.finish().finalSelection).toBe("explicit_final_answer");
  });

  it.each([null, "final_answer"])("rejects multiple final candidates with phase %s", (phase) => {
    const f = fixture();
    f.agent("one", modelJson, phase);
    f.agent("two", modelJson, phase);
    throws("RESULT_AMBIGUOUS", () => f.completed());
  });

  it("does not guess a valid JSON final from multiple unknown-phase messages", () => {
    const f = fixture();
    f.agent("preamble", "not JSON", null);
    f.agent("answer", modelJson, null);
    throws("RESULT_AMBIGUOUS", () => f.completed());
  });

  it("rejects an unphased candidate followed by a new tool item", () => {
    const f = fixture();
    f.agent("answer", modelJson, null);
    f.itemStart(command());
    f.itemComplete(command({ status: "completed", exitCode: 0 }));
    throws("RESULT_AMBIGUOUS", () => f.completed());
  });

  it("does not treat commentary containing valid JSON as the final answer", () => {
    const f = fixture();
    f.agent("comment", modelJson, "commentary");
    throws("RESULT_MISSING", () => f.completed());
  });

  it("rejects conflicting agent deltas or phase changes", () => {
    const f = fixture();
    f.itemStart({ id: "a", type: "agentMessage", text: "", phase: null });
    f.event("item/agentMessage/delta", { threadId, turnId, itemId: "a", delta: "original" });
    throws("TEXT_MISMATCH", () =>
      f.itemComplete({ id: "a", type: "agentMessage", text: "different", phase: "final_answer" }),
    );
    const other = fixture();
    other.itemStart({ id: "a", type: "agentMessage", text: "", phase: "commentary" });
    throws("TEXT_MISMATCH", () =>
      other.itemComplete({ id: "a", type: "agentMessage", text: modelJson, phase: "final_answer" }),
    );
  });

  it.each([
    "duplicate_start",
    "duplicate_complete",
    "delta_after_complete",
    "missing_start",
    "changed_type",
  ])("rejects %s item lifecycle", (mode) => {
    const f = fixture();
    const initial = { id: "a", type: "agentMessage", text: "", phase: "final_answer" };
    const final = { ...initial, text: modelJson };
    if (mode !== "missing_start") f.itemStart(initial);
    if (mode === "duplicate_start") throws("ITEM_STATE_INVALID", () => f.itemStart(initial));
    else if (mode === "missing_start") throws("ITEM_STATE_INVALID", () => f.itemComplete(final));
    else if (mode === "changed_type")
      throws("ITEM_STATE_INVALID", () =>
        f.itemComplete({ id: "a", type: "plan", text: modelJson }),
      );
    else {
      f.itemComplete(final);
      throws("ITEM_STATE_INVALID", () =>
        mode === "duplicate_complete"
          ? f.itemComplete(final)
          : f.event("item/agentMessage/delta", { threadId, turnId, itemId: "a", delta: "extra" }),
      );
    }
  });

  it("requires a started turn, one completion, and completion of every item", () => {
    const early = fixture({ early: true });
    early.collector.bindTurnStart({ turn: turn() });
    throws("TURN_STATE_INVALID", () => early.agent());
    const missing = fixture();
    missing.itemStart(command());
    missing.agent();
    throws("INCOMPLETE_STREAM", () => missing.completed());
    const duplicate = fixture();
    duplicate.agent();
    duplicate.completed();
    throws("TURN_STATE_INVALID", () => duplicate.completed());
  });

  it.each(["failed", "interrupted"])(
    "rejects terminal status %s even with a valid final JSON message",
    async (status) => {
      const f = fixture();
      f.agent();
      const code = status === "failed" ? "TURN_FAILED" : "TURN_INTERRUPTED";
      throws(code, () => f.completed(status));
      await expect(f.collector.terminal).rejects.toMatchObject({ code });
    },
  );

  it("does not treat retryable error notifications as eventual success", () => {
    const f = fixture();
    throws("STREAM_ERROR", () =>
      f.event("error", {
        threadId,
        turnId,
        willRetry: true,
        error: { message: "private upstream error" },
      }),
    );
    throws("STREAM_ERROR", () => f.collector.finish());
  });

  it("collects actual command statuses and ignores model claims that tests ran", () => {
    const f = fixture();
    f.itemStart(command());
    f.event("item/commandExecution/outputDelta", {
      threadId,
      turnId,
      itemId: "command-1",
      delta: "private command output",
    });
    f.itemComplete(
      command({ status: "failed", exitCode: 1, aggregatedOutput: "A bounded display summary." }),
    );
    f.agent("answer", JSON.stringify({ ...model, answer: "I claim every test passed." }));
    f.completed();
    const output = f.collector.finish();
    expect(output.commandEvidence).toEqual({
      commands: [{ itemId: "command-1", command: "node --version", status: "failed", exitCode: 1 }],
      commandCapture: "complete",
    });
    expect(JSON.stringify(output.commandEvidence)).not.toContain("private command output");
  });

  it.each(["declined", "completed"])(
    "marks missing exit evidence %s unknown rather than successful",
    (status) => {
      const f = fixture();
      f.itemStart(command());
      f.itemComplete(command({ status, exitCode: null }));
      f.agent();
      f.completed();
      expect(f.collector.finish().commandEvidence).toMatchObject({
        commands: [{ status: "unknown", exitCode: null }],
        commandCapture: "incomplete",
      });
    },
  );

  it("redacts known credentials in command evidence without modifying raw model output", () => {
    const f = fixture({ protectedValues: ["fixture-secret"] });
    const value = command({ command: "tool fixture-secret" });
    f.itemStart(value);
    f.itemComplete({ ...value, status: "completed", exitCode: 0 });
    f.agent();
    f.completed();
    const output = f.collector.finish();
    expect(output.commandEvidence.commands[0]?.command).toBe("tool [REDACTED]");
    expect(output.resultDigest).toBe(createCanonicalResult(model).sha256);
  });

  it("rejects changed command identity or scope during its lifecycle", () => {
    const f = fixture();
    f.itemStart(command());
    throws("ITEM_STATE_INVALID", () =>
      f.itemComplete(command({ status: "completed", exitCode: 0, command: "another command" })),
    );
    const other = fixture();
    other.itemStart(command());
    throws("ITEM_STATE_INVALID", () =>
      other.itemComplete(command({ status: "completed", exitCode: 0, cwd: "C:\\elsewhere" })),
    );
  });

  it("tracks real fileChange events without inventing clean or modified Git status", () => {
    const f = fixture();
    const change = {
      path: "src/file.ts",
      kind: { type: "update", move_path: null },
      diff: "synthetic diff",
    };
    f.itemStart({ id: "patch", type: "fileChange", status: "inProgress", changes: [] });
    f.event("item/fileChange/patchUpdated", {
      threadId,
      turnId,
      itemId: "patch",
      changes: [change],
    });
    f.itemComplete({ id: "patch", type: "fileChange", status: "completed", changes: [change] });
    f.agent();
    f.completed();
    const output = f.collector.finish();
    expect(output.observedFileChange).toBe(true);
    expect(output).not.toHaveProperty("worktree");
  });

  it("rejects fileChange completion that conflicts with the last patch update", () => {
    const f = fixture();
    f.itemStart({ id: "patch", type: "fileChange", status: "inProgress", changes: [] });
    f.event("item/fileChange/patchUpdated", {
      threadId,
      turnId,
      itemId: "patch",
      changes: [{ path: "a", kind: { type: "add" }, diff: "+a" }],
    });
    throws("ITEM_STATE_INVALID", () =>
      f.itemComplete({ id: "patch", type: "fileChange", status: "completed", changes: [] }),
    );
  });

  it("accepts reasoning and plan lifecycles but never selects their text as model output", () => {
    const f = fixture();
    f.itemStart({ id: "r", type: "reasoning", content: [], summary: [] });
    f.event("item/reasoning/summaryPartAdded", { threadId, turnId, itemId: "r", summaryIndex: 0 });
    f.event("item/reasoning/summaryTextDelta", {
      threadId,
      turnId,
      itemId: "r",
      summaryIndex: 0,
      delta: "thinking",
    });
    f.itemComplete({ id: "r", type: "reasoning", content: [], summary: ["thinking"] });
    f.itemStart({ id: "p", type: "plan", text: "" });
    f.event("item/plan/delta", { threadId, turnId, itemId: "p", delta: "tentative" });
    f.itemComplete({ id: "p", type: "plan", text: "authoritative revised plan" });
    f.agent();
    f.completed();
    expect(f.collector.finish().finalItemId).toBe("final");
  });

  it.each(["mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "unknownTool"])(
    "fails closed for unsupported item type %s",
    (type) => {
      const f = fixture();
      throws("UNSUPPORTED_ITEM", () => f.itemStart({ id: "tool", type }));
    },
  );

  it.each([
    ["not JSON", "RESULT_INVALID_JSON"],
    ['{"schemaVersion":"SyntheticOutputV1","answer":"one","answer":"two"}', "RESULT_INVALID_JSON"],
    ['{"schemaVersion":"SyntheticOutputV1","answer":42}', "RESULT_INVALID_SCHEMA"],
    [
      '{"schemaVersion":"SyntheticOutputV1","answer":"x","executionEvidence":{}}',
      "RESULT_INVALID_SCHEMA",
    ],
  ] as const)("rejects raw final %s", (raw, code) => {
    const f = fixture();
    f.agent("answer", raw);
    f.completed();
    throws(code, () => f.collector.finish());
  });

  it("rejects protected raw result values rather than changing their canonical digest", () => {
    const f = fixture({ protectedValues: ["fixture-secret"] });
    f.agent("answer", JSON.stringify({ ...model, answer: "fixture-secret" }));
    f.completed();
    throws("RESULT_PROTECTED", () => f.collector.finish());
  });

  it.each([
    ['{"schemaVersion":"SyntheticOutputV1","answer":"to\\u006ben"}', "token"],
    ['{"schemaVersion":"SyntheticOutputV1","answ\\u0065r":"value"}', "answer"],
  ])("detects protected decoded JSON content in %s", (raw, secret) => {
    const f = fixture({ protectedValues: [secret] });
    expect(raw).not.toContain(secret);
    f.agent("answer", raw);
    f.completed();
    throws("RESULT_PROTECTED", () => f.collector.finish());
  });

  it("checks decoded numeric scalar values without relying on their original spelling", () => {
    const numberSchema = Type.Number();
    const json = JSON.stringify(numberSchema);
    const c = createCodexAppServerOutputCollector({
      threadId,
      authoritativeSchema: {
        json,
        digest: createHash("sha256").update(json).digest("hex"),
        resultSchema: numberSchema,
      },
      protectedValues: ["12345"],
    });
    c.bindTurnStart({ turn: turn() });
    c.observe({ method: "turn/started", params: { threadId, turn: turn() } });
    c.observe({
      method: "item/started",
      params: {
        threadId,
        turnId,
        item: { id: "a", type: "agentMessage", text: "", phase: "final_answer" },
        startedAtMs: 1,
      },
    });
    c.observe({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: "a", type: "agentMessage", text: "1.2345e4", phase: "final_answer" },
        completedAtMs: 2,
      },
    });
    c.observe({ method: "turn/completed", params: { threadId, turn: turn("completed") } });
    throws("RESULT_PROTECTED", () => c.finish());
  });

  it("pins the schema and protected values before subsequent caller mutation", () => {
    const mutable = Type.Object({ answer: Type.String() }, { additionalProperties: false });
    const json = JSON.stringify(mutable);
    const protectedValues = ["secret"];
    const c = createCodexAppServerOutputCollector({
      threadId,
      authoritativeSchema: {
        json,
        digest: createHash("sha256").update(json).digest("hex"),
        resultSchema: mutable,
      },
      protectedValues,
    });
    Object.assign(mutable.properties.answer, { type: "number" });
    protectedValues[0] = "different";
    c.bindTurnStart({ turn: turn() });
    c.observe({ method: "turn/started", params: { threadId, turn: turn() } });
    c.observe({
      method: "item/started",
      params: {
        threadId,
        turnId,
        item: { id: "a", type: "agentMessage", text: "" },
        startedAtMs: 1,
      },
    });
    c.observe({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: "a", type: "agentMessage", text: '{"answer":"value"}' },
        completedAtMs: 2,
      },
    });
    c.observe({ method: "turn/completed", params: { threadId, turn: turn("completed") } });
    expect(c.finish().result).toEqual({ answer: "value" });
  });

  it("rejects an authority whose schema bytes and typed schema disagree", () => {
    throws("INVALID_CONFIGURATION", () =>
      createCodexAppServerOutputCollector({
        threadId,
        authoritativeSchema: { ...authority, digest: "0".repeat(64) },
      }),
    );
    throws("INVALID_CONFIGURATION", () =>
      createCodexAppServerOutputCollector({
        threadId,
        authoritativeSchema: { ...authority, resultSchema: Type.String() },
      }),
    );
  });

  it.each(["early_events", "early_bytes", "events", "bytes", "items", "commands", "result"])(
    "bounds %s without truncating into success",
    (kind) => {
      const limited =
        kind === "early_events"
          ? { maximumEarlyEvents: 1 }
          : kind === "early_bytes"
            ? { maximumEarlyBytes: 32 }
            : kind === "events"
              ? { maximumEvents: 1 }
              : kind === "bytes"
                ? { maximumTotalBytes: 200 }
                : kind === "items"
                  ? { maximumItems: 1 }
                  : kind === "commands"
                    ? { maximumCommands: 1 }
                    : { maximumResultBytes: 20 };
      const f = fixture({ early: true, limits: limited });
      throws("OUTPUT_LIMIT_EXCEEDED", () => {
        if (!kind.startsWith("early")) f.collector.bindTurnStart({ turn: turn() });
        f.started();
        if (kind === "items") {
          f.agent("one");
          f.agent("two");
        } else if (kind === "commands") {
          f.itemStart(command());
          f.itemComplete(command({ status: "completed", exitCode: 0 }));
          f.itemStart(command({ id: "two" }));
        } else f.agent();
      });
    },
  );

  it("keeps early notifications as immutable snapshots", () => {
    const f = fixture({ early: true });
    const first = { threadId, turn: turn() };
    f.event("turn/started", first);
    first.turn.id = "changed";
    f.agent();
    f.completed();
    f.collector.bindTurnStart({ turn: turn() });
    expect(f.collector.finish().turnId).toBe(turnId);
  });

  it("rejects getters and proxies without executing their traps", () => {
    const getter = vi.fn(() => "private");
    const f = fixture();
    const params = Object.defineProperty({}, "threadId", { get: getter, enumerable: true });
    throws("INVALID_NOTIFICATION", () => f.event("turn/started", params));
    expect(getter).not.toHaveBeenCalled();
    const other = fixture();
    const trap = vi.fn(() => {
      throw new Error("private trap");
    });
    const proxy = new Proxy({}, { getPrototypeOf: trap, ownKeys: trap });
    throws("INVALID_NOTIFICATION", () => other.event("turn/started", proxy));
    expect(trap).not.toHaveBeenCalled();
  });

  it("requires binding and terminal evidence before finish, and rejects duplicate binding", () => {
    const early = fixture({ early: true });
    throws("INCOMPLETE_STREAM", () => early.collector.finish());
    const f = fixture();
    throws("TURN_STATE_INVALID", () => f.collector.bindTurnStart({ turn: turn() }));
    const unfinished = fixture();
    unfinished.agent();
    throws("INCOMPLETE_STREAM", () => unfinished.collector.finish());
  });

  it("retains valid timestamps without inferring local time or rejecting clock rollback", () => {
    const f = fixture();
    f.itemStart({ id: "a", type: "agentMessage", text: "", phase: null });
    f.event("item/completed", {
      threadId,
      turnId,
      item: { id: "a", type: "agentMessage", text: modelJson, phase: null },
      completedAtMs: 0,
    });
    f.completed("completed", { completedAt: 0 });
    expect(f.collector.finish().result).toEqual(model);
  });
});
