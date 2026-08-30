import { describe, expect, it } from "vitest";

import { CodexJsonlParser } from "./jsonl.js";

describe("CodexJsonlParser", () => {
  it("parses recognized events across arbitrary chunk boundaries", () => {
    const parser = new CodexJsonlParser();
    const records = [
      ...parser.push('{"type":"thread.started","thread_id":"thread-1"}\r'),
      ...parser.push('\n{"type":"turn.started"}\n{"type":"item.star'),
      ...parser.push('ted","item":{"id":"item-1"}}\n'),
      ...parser.finish(),
    ];

    expect(records.map((record) => record.kind === "event" && record.type)).toEqual([
      "thread.started",
      "turn.started",
      "item.started",
    ]);
    expect(records.every((record) => record.kind === "event" && record.recognized)).toBe(true);
  });

  it("parses byte chunks and the final unterminated line", () => {
    const parser = new CodexJsonlParser();
    const encoder = new TextEncoder();
    const encoded = encoder.encode('{"type":"turn.completed","usage":{"input_tokens":4}}');

    const records = [
      ...parser.push(encoded.slice(0, 7)),
      ...parser.push(encoded.slice(7)),
      ...parser.finish(),
    ];

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "event",
      recognized: true,
      type: "turn.completed",
      lineNumber: 1,
    });
  });

  it("preserves unknown event types without treating them as parse failures", () => {
    const parser = new CodexJsonlParser();
    const records = [
      ...parser.push('{"type":"item.updated","item":{"id":"item-1"}}\n'),
      ...parser.finish(),
    ];

    expect(records).toEqual([
      {
        kind: "event",
        recognized: false,
        type: "item.updated",
        lineNumber: 1,
        value: { type: "item.updated", item: { id: "item-1" } },
      },
    ]);
  });

  it("reports malformed lines and continues with later events", () => {
    const parser = new CodexJsonlParser();
    const records = [
      ...parser.push('not json\n{"type":"error","message":"failed"}\n'),
      ...parser.finish(),
    ];

    expect(records[0]).toMatchObject({
      kind: "parse_issue",
      code: "invalid_json",
      lineNumber: 1,
    });
    expect(records[1]).toMatchObject({
      kind: "event",
      recognized: true,
      type: "error",
      lineNumber: 2,
    });
  });

  it("bounds an oversized unterminated line and resumes at the next line", () => {
    const parser = new CodexJsonlParser({ maximumLineCharacters: 16 });
    const first = parser.push("x".repeat(17));
    const second = parser.push('\n{"type":"error"}\n');
    const final = parser.finish();

    expect(first).toEqual([
      expect.objectContaining({ kind: "parse_issue", code: "line_too_long", lineNumber: 1 }),
    ]);
    expect(second).toEqual([
      expect.objectContaining({ kind: "event", type: "error", lineNumber: 2 }),
    ]);
    expect(final).toEqual([]);
  });
});
