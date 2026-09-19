import { describe, expect, it, vi } from "vitest";
import { createModelActivityObserver } from "./model-progress.js";

const line = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
const tool = (type = "command_execution", event = "item.started") => ({
  type: event,
  item: { type, command: "private command", path: "private/path", output: "private output" },
});

describe("model activity observations", () => {
  it("reports a real dispatch exactly once without synthesizing analysis progress", () => {
    const onActivity = vi.fn();
    const observer = createModelActivityObserver("codex", onActivity);
    observer.push(line({ type: "turn.started" }));
    expect(onActivity).not.toHaveBeenCalled();
    observer.dispatched();
    observer.dispatched();
    expect(onActivity.mock.calls).toEqual([[{ kind: "model", event: "model.dispatched" }]]);
    expect(Object.isFrozen(onActivity.mock.calls[0]![0])).toBe(true);
  });

  it("reports only whitelisted Codex tool item events and omits all payload fields", () => {
    const onActivity = vi.fn();
    const observer = createModelActivityObserver("codex", onActivity);
    for (const event of ["item.started", "item.updated", "item.completed"])
      for (const type of ["command_execution", "mcp_tool_call", "web_search", "file_change"])
        observer.push(line(tool(type, event)));
    expect(onActivity.mock.calls.map(([activity]) => activity)).toEqual(
      ["item.started", "item.updated", "item.completed"].flatMap((event) =>
        ["command_execution", "mcp_tool_call", "web_search", "file_change"].map((type) => ({
          kind: "tool",
          event: `${event}:${type}`,
        })),
      ),
    );
    expect(JSON.stringify(onActivity.mock.calls)).not.toContain("private");
  });

  it("handles byte boundaries inside JSON records and multibyte UTF-8 characters", () => {
    const onActivity = vi.fn();
    const observer = createModelActivityObserver("codex", onActivity);
    const bytes = line({
      type: "item.completed",
      item: { type: "command_execution", command: "Search Unicode \u5de5\u5177 \ud83c\udf0d" },
    });
    for (let index = 0; index < bytes.byteLength; index++)
      observer.push(bytes.subarray(index, index + 1));
    expect(onActivity).toHaveBeenCalledExactlyOnceWith({
      kind: "tool",
      event: "item.completed:command_execution",
    });
  });

  it("supports CRLF, a leading BOM, multiple records, and a final record without a newline", () => {
    const onActivity = vi.fn();
    const observer = createModelActivityObserver("codex", onActivity);
    observer.push(
      Buffer.from(`\uFEFF${JSON.stringify(tool())}\r\n\r\n${JSON.stringify(tool("web_search"))}`),
    );
    expect(onActivity).toHaveBeenCalledTimes(1);
    observer.finish();
    observer.finish();
    observer.push(line(tool()));
    observer.dispatched();
    expect(onActivity.mock.calls.map(([activity]) => activity.event)).toEqual([
      "item.started:command_execution",
      "item.started:web_search",
    ]);
  });

  it("ignores malformed, unrelated, and nested model-authored records", () => {
    const onActivity = vi.fn();
    const observer = createModelActivityObserver("codex", onActivity);
    observer.push(Buffer.from("not JSON\n\n"));
    for (const event of [
      null,
      [],
      true,
      { type: "item.started", item: [] },
      { type: "item.started", item: { type: "command_execution\nprivate" } },
      { type: "item.unknown", item: { type: "command_execution" } },
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(tool()) } },
      { type: "item.completed", item: { type: "reasoning", text: "Still thinking" } },
      { type: "tool.execution_start", data: { toolName: "shell" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
    ])
      observer.push(line(event));
    observer.push(Buffer.from('{"type":"item.started","item":'));
    observer.finish();
    expect(onActivity).not.toHaveBeenCalled();
  });

  it("discards invalid UTF-8 records and recovers at the next complete line", () => {
    const onActivity = vi.fn();
    const observer = createModelActivityObserver("codex", onActivity);
    observer.push(
      Buffer.concat([
        Buffer.from('{"type":"item.started","item":{"type":"command_execution","command":"'),
        Buffer.from([0xff]),
        Buffer.from('"}}\n'),
        line(tool()),
      ]),
    );
    expect(onActivity).toHaveBeenCalledExactlyOnceWith({
      kind: "tool",
      event: "item.started:command_execution",
    });
  });

  it("discards an oversized line across chunks without parsing its valid-looking suffix", () => {
    const onActivity = vi.fn();
    const observer = createModelActivityObserver("codex", onActivity, { maximumLineBytes: 256 });
    observer.push(Buffer.from("x".repeat(250)));
    observer.push(Buffer.from("x".repeat(1024 * 1024)));
    observer.push(line(tool()));
    expect(onActivity).not.toHaveBeenCalled();
    observer.push(line(tool()));
    expect(onActivity).toHaveBeenCalledExactlyOnceWith({
      kind: "tool",
      event: "item.started:command_execution",
    });
  });

  it("enforces its line bound when an oversized record and the next line share one chunk", () => {
    const onActivity = vi.fn();
    const observer = createModelActivityObserver("codex", onActivity, { maximumLineBytes: 256 });
    observer.push(
      Buffer.concat([
        line({
          type: "item.completed",
          item: { type: "command_execution", output: "x".repeat(4096) },
        }),
        line(tool("mcp_tool_call")),
      ]),
    );
    expect(onActivity).toHaveBeenCalledExactlyOnceWith({
      kind: "tool",
      event: "item.started:mcp_tool_call",
    });
  });

  it("reports actual Copilot tool lifecycle records without exposing tool names or data", () => {
    const onActivity = vi.fn();
    const observer = createModelActivityObserver("copilot", onActivity);
    const events = [
      "tool.execution_start",
      "tool.execution_progress",
      "tool.execution_partial_result",
      "tool.execution_complete",
    ];
    for (const type of events)
      observer.push(line({ type, data: { toolName: "private tool", command: "private command" } }));
    observer.push(line(tool()));
    observer.push(line({ type: "tool.execution_start", data: "invalid" }));
    observer.push(line({ type: "tool.execution_unknown", data: {} }));
    observer.push(line({ type: "assistant.message", data: { content: JSON.stringify(tool()) } }));
    expect(onActivity.mock.calls.map(([activity]) => activity)).toEqual(
      events.map((event) => ({ kind: "tool", event })),
    );
    expect(JSON.stringify(onActivity.mock.calls)).not.toContain("private");
  });

  it("isolates synchronous and asynchronous observer failures from collection", async () => {
    const onActivity = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("Observer failed");
      })
      .mockImplementationOnce(() => Promise.reject(new Error("Async observer failed")));
    const observer = createModelActivityObserver("codex", onActivity);
    expect(() => observer.dispatched()).not.toThrow();
    expect(() => observer.push(line(tool()))).not.toThrow();
    await Promise.resolve();
    observer.push(line(tool()));
    expect(onActivity).toHaveBeenCalledTimes(3);
  });

  it("remains optional and refuses an unbounded line-buffer configuration", () => {
    const observer = createModelActivityObserver("codex");
    observer.dispatched();
    observer.push(line(tool()));
    observer.finish();
    for (const maximumLineBytes of [0, -1, 0.5, Number.POSITIVE_INFINITY, 1024 * 1024 + 1])
      expect(() => createModelActivityObserver("codex", undefined, { maximumLineBytes })).toThrow(
        RangeError,
      );
  });
});
