import type { CliEngine } from "@agentic-review/codex";
import { describe, expect, it, vi } from "vitest";
import {
  createModelOutputObserver,
  type ModelOutputObservation,
  sanitizeModelOutputText,
} from "./model-output-observer.js";

const line = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
const assistant = (text: string, id: unknown = "assistant-1", type = "item.completed") => ({
  type,
  item: { id, type: "agent_message", text },
});
const command = (
  id: unknown = "command-1",
  type = "item.completed",
  extra: Record<string, unknown> = {},
) => ({
  type,
  item: {
    id,
    type: "command_execution",
    command: "rg CleanupTempDir",
    aggregated_output: "src/module.ts:24: CleanupTempDir()",
    status: "completed",
    exit_code: 0,
    ...extra,
  },
});
const collect = (
  engine: CliEngine = "codex",
  options: Parameters<typeof createModelOutputObserver>[2] = {},
) => {
  const observations: ModelOutputObservation[] = [];
  const observer = createModelOutputObserver(
    engine,
    (output) => observations.push(output),
    options,
  );
  return { observations, observer };
};

describe("model output observations", () => {
  it("replaces completed Codex messages and command snapshots by opaque, stable item identities", () => {
    const { observations, observer } = collect();
    observer.push(line(assistant("Reading the source.", "private-message")));
    observer.push(line(assistant("Reading the source and checking callers.", "private-message")));
    observer.push(
      line(command("private-command", "item.started", { status: "in_progress", exit_code: null })),
    );
    observer.push(line(command("private-command", "item.updated")));
    observer.push(line(command("private-command")));
    expect(observations).toHaveLength(5);
    expect(observations[0]).toMatchObject({
      kind: "assistant",
      operation: "replace",
      text: "Reading the source.",
      status: "completed",
    });
    expect(observations[1]).toMatchObject({
      itemId: observations[0]!.itemId,
      text: "Reading the source and checking callers.",
      status: "completed",
    });
    expect(observations[2]).toMatchObject({
      kind: "tool",
      command: "rg CleanupTempDir",
      status: "started",
    });
    expect(observations[2]).not.toHaveProperty("result");
    expect(observations[3]).not.toHaveProperty("result");
    expect(observations[4]).toEqual({
      itemId: observations[2]!.itemId,
      kind: "tool",
      operation: "replace",
      text: "Command execution",
      command: "rg CleanupTempDir",
      result: "src/module.ts:24: CleanupTempDir()",
      status: "completed",
    });
    expect(observations.every(Object.isFrozen)).toBe(true);
    expect(observations.every((output) => output.itemId.length <= 64)).toBe(true);
    expect(JSON.stringify(observations)).not.toContain("private-message");
    expect(JSON.stringify(observations)).not.toContain("private-command");
  });

  it.each<[Record<string, unknown>, string]>([
    [{ status: "completed", exit_code: 0 }, "completed"],
    [{ status: "completed", exit_code: 7 }, "failed"],
    [{ status: "failed", exit_code: null }, "failed"],
    [{ status: "completed", exit_code: null }, "info"],
    [{ status: "future", exit_code: 0 }, "info"],
    [{ status: "completed", exit_code: 0.5 }, "info"],
    [{ status: "completed", exit_code: 4_294_967_296 }, "info"],
  ])(
    "does not infer successful command execution from unsupported outcomes: %j",
    (extra, status) => {
      const { observations, observer } = collect();
      observer.push(line(command("command-1", "item.completed", extra)));
      expect(observations[0]?.status).toBe(status);
    },
  );

  it("retains supported tool activity while omitting unverified Codex payload fields", () => {
    const { observations, observer } = collect();
    for (const type of ["mcp_tool_call", "file_change", "web_search"])
      observer.push(
        line({
          type: "item.completed",
          item: {
            id: type,
            type,
            arguments: "private arguments",
            result: "private result",
            stderr: "private stderr",
            output: "private output",
            path: "private path",
            environment: { PASSWORD: "private environment" },
            auth: "private auth",
          },
        }),
      );
    for (const type of ["constructor", "toString", "__proto__"])
      observer.push(line({ type: "item.completed", item: { id: type, type } }));
    expect(observations.map((output) => output.text)).toEqual([
      "MCP tool activity",
      "File change activity",
      "Web search activity",
    ]);
    expect(JSON.stringify(observations)).not.toContain("private");
    expect(observations.every((output) => output.status === "info")).toBe(true);
  });

  it("correlates fixture-supported Copilot tool lifecycle and completed textual results", () => {
    const { observations, observer } = collect("copilot");
    for (const type of [
      "tool.execution_start",
      "tool.execution_progress",
      "tool.execution_partial_result",
      "tool.execution_complete",
    ])
      observer.push(
        line({
          type,
          data: {
            toolCallId: "private-view-1",
            toolName: "private tool name",
            arguments: { command: "private command" },
            content: "private unsupported content",
            partialResult: "private partial output",
            result: { content: '{"message":"tool output"}', private: "private result envelope" },
          },
        }),
      );
    expect(observations).toHaveLength(4);
    expect(new Set(observations.map((output) => output.itemId)).size).toBe(1);
    expect(observations.every((output) => output.operation === "replace")).toBe(true);
    expect(observations.slice(0, 3).every((output) => output.result === undefined)).toBe(true);
    expect(observations[3]).toMatchObject({
      kind: "tool",
      text: "Tool execution completed (outcome unavailable)",
      result: '{"message":"tool output"}',
      status: "info",
    });
    expect(JSON.stringify(observations)).not.toContain("private");
  });

  it("uses full root Copilot messages without treating a pending tool request as a final answer", () => {
    const { observations, observer } = collect("copilot");
    observer.push(
      line({
        type: "assistant.message",
        data: {
          messageId: "message-1",
          content: "I will inspect the file.",
          toolRequests: [{ toolCallId: "view-1", name: "view" }],
        },
      }),
    );
    observer.push(
      line({
        type: "assistant.message",
        data: { messageId: "message-1", content: "The relevant code is in the module." },
      }),
    );
    expect(observations.map((output) => output.status)).toEqual(["started", "info", "completed"]);
    expect(observations[0]!.itemId).toBe(observations[2]!.itemId);
    expect(observations[1]).toMatchObject({ kind: "tool", text: "Tool requested: view" });
  });

  it("keeps a requested tool name through lifecycle replacement even when assistant content is empty", () => {
    const { observations, observer } = collect("copilot", { protectedValues: ["private-name"] });
    observer.push(
      line({
        type: "assistant.message",
        data: {
          content: "",
          toolRequests: [
            { toolCallId: "view-1", name: "view private-name", arguments: "private arguments" },
          ],
        },
      }),
    );
    observer.push(line({ type: "tool.execution_start", data: { toolCallId: "view-1" } }));
    observer.push(
      line({
        type: "tool.execution_complete",
        data: { toolCallId: "view-1", result: { content: "Visible tool result" } },
      }),
    );
    expect(observations.map((output) => output.text)).toEqual([
      "Tool requested: view [REDACTED]",
      "Tool execution: view [REDACTED]",
      "Tool execution completed: view [REDACTED] (outcome unavailable)",
    ]);
    expect(new Set(observations.map((output) => output.itemId)).size).toBe(1);
    expect(observations.every((output) => output.kind === "tool")).toBe(true);
    expect(JSON.stringify(observations)).not.toContain("private");
  });

  it("bounds tool request expansion and the retained name correlation cache", () => {
    const { observations, observer } = collect("copilot");
    for (let batch = 0; batch < 8; batch++)
      observer.push(
        line({
          type: "assistant.message",
          data: {
            content: "",
            toolRequests: Array.from({ length: 128 }, (_, index) => ({
              toolCallId: `call-${batch * 128 + index}`,
              name: `tool-${batch * 128 + index}`,
            })),
          },
        }),
      );
    observer.push(
      line({
        type: "assistant.message",
        data: {
          content: "",
          toolRequests: Array.from({ length: 129 }, (_, index) => ({
            toolCallId: `extra-${index}`,
            name: `uncached-${index}`,
          })),
        },
      }),
    );
    observer.push(line({ type: "tool.execution_start", data: { toolCallId: "call-0" } }));
    observer.push(line({ type: "tool.execution_start", data: { toolCallId: "extra-0" } }));
    expect(observations.filter((output) => output.kind === "gap")).toHaveLength(2);
    expect(observations.at(-2)?.text).toBe("Tool execution: tool-0");
    expect(observations.at(-1)?.text).toBe("Tool execution");
    expect(JSON.stringify(observations)).not.toContain("uncached-128");
  });

  it.each(["codex", "copilot"] as const)(
    "keeps model-authored event JSON as visible text without recursively normalizing it: %s",
    (engine) => {
      const { observations, observer } = collect(engine);
      const content = JSON.stringify(command("nested-command"));
      observer.push(
        line(
          engine === "codex"
            ? assistant(content)
            : { type: "assistant.message", data: { content } },
        ),
      );
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({ kind: "assistant", text: content });
      expect(observations[0]).not.toHaveProperty("command");
      expect(observations[0]).not.toHaveProperty("result");
    },
  );

  it("excludes private reasoning, child events, result envelopes, and unverified deltas", () => {
    const codex = collect();
    const copilot = collect("copilot", { protectedValues: ["split-private-value"] });
    for (const event of [
      { type: "item.completed", item: { type: "reasoning", text: "private reasoning" } },
      { type: "item.completed", item: { type: "unknown", text: "private future data" } },
      { type: "result", item: assistant("private nested data") },
      { ...assistant("private child"), agentId: "child" },
      { ...command(), parentToolCallId: false },
      { type: "item.completed", item: { ...command().item, agentId: [] } },
    ])
      codex.observer.push(line(event));
    for (const event of [
      { type: "assistant.reasoning", data: { content: "private reasoning" } },
      { type: "assistant.reasoning_delta", data: { deltaContent: "private reasoning delta" } },
      { type: "assistant.message_delta", data: { deltaContent: "split-private-" } },
      { type: "assistant.message_delta", data: { deltaContent: "value" } },
      { type: "assistant.message", agentId: "child", data: { content: "private child" } },
      {
        type: "assistant.message",
        data: { content: "private legacy child", parentToolCallId: "task-1" },
      },
      { type: "assistant.message", agentId: false, data: { content: "private invalid scope" } },
      { type: "assistant.message", data: { content: "private scope", parentToolCallId: [] } },
      {
        type: "tool.execution_complete",
        agentId: "child",
        data: { toolCallId: "view-1", result: { content: "private child tool" } },
      },
      {
        type: "tool.execution_complete",
        data: {
          parentToolCallId: 0,
          toolCallId: "view-1",
          result: { content: "private legacy child tool" },
        },
      },
      { type: "result", data: { type: "assistant.message", content: "private result" } },
      { type: "user.message", data: { content: "private user content" } },
    ])
      copilot.observer.push(line(event));
    expect(codex.observations).toEqual([]);
    expect(copilot.observations).toEqual([]);
    copilot.observer.push(
      line({ type: "assistant.message", data: { content: "Full split-private-value message." } }),
    );
    expect(copilot.observations[0]?.text).toBe("Full [REDACTED] message.");
  });

  it("assembles UTF-8 and protected values across chunks before notifying", () => {
    const secret = "private-credential-value";
    const { observations, observer } = collect("codex", { protectedValues: [secret] });
    const bytes = line(assistant(`Visible \u5de5\u5177 \ud83c\udf0d ${secret} text`));
    for (let index = 0; index < bytes.byteLength - 1; index++)
      observer.push(bytes.subarray(index, index + 1));
    expect(observations).toEqual([]);
    observer.push(bytes.subarray(-1));
    expect(observations[0]?.text).toBe("Visible \u5de5\u5177 \ud83c\udf0d [REDACTED] text");
    expect(JSON.stringify(observations)).not.toContain(secret);
  });

  it("withholds growing Codex messages so protected prefixes never enter retained history", () => {
    const { observations, observer } = collect("codex", {
      protectedValues: ["private-credential-value"],
    });
    observer.push(line(assistant("Value private-credential-", "message-1", "item.started")));
    observer.push(line(assistant("Value private-credential-valu", "message-1", "item.updated")));
    expect(observations).toEqual([]);
    observer.push(line(assistant("Value private-credential-value", "message-1")));
    expect(observations).toHaveLength(1);
    expect(observations[0]?.text).toBe("Value [REDACTED]");
    expect(JSON.stringify(observations)).not.toContain("private-credential");
  });

  it("accepts a BOM, CRLF, blank records, and one final record without a newline", () => {
    const { observations, observer } = collect();
    observer.push(
      Buffer.from(
        `\uFEFF${JSON.stringify(assistant("First"))}\r\n\r\n${JSON.stringify(assistant("Last"))}`,
      ),
    );
    expect(observations.map((output) => output.text)).toEqual(["First"]);
    observer.finish();
    observer.finish();
    observer.push(line(assistant("Too late")));
    expect(observations.map((output) => output.text)).toEqual(["First", "Last"]);
  });

  it("reports safe gaps for malformed JSON and invalid UTF-8 then resumes on the next line", () => {
    const { observations, observer } = collect();
    observer.push(
      Buffer.concat([
        Buffer.from("private broken JSON\n"),
        Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"'),
        Buffer.from([0xff]),
        Buffer.from('private invalid UTF-8"}}\n'),
        line(assistant("Recovered")),
      ]),
    );
    observer.push(Buffer.from('{"private":"unterminated'));
    observer.finish();
    expect(observations.map((output) => output.kind)).toEqual(["gap", "gap", "assistant", "gap"]);
    expect(observations[0]?.text).toContain("1 malformed JSON");
    expect(observations[1]?.text).toContain("1 invalid UTF-8");
    expect(observations[2]?.text).toBe("Recovered");
    expect(JSON.stringify(observations)).not.toContain("private");
  });

  it("discards one oversized record across chunks, including its valid-looking suffix", () => {
    const { observations, observer } = collect("codex", { maximumLineBytes: 256 });
    observer.push(Buffer.from("x".repeat(250)));
    observer.push(Buffer.from("x".repeat(1024 * 1024)));
    observer.push(line(assistant("Must not appear")));
    observer.push(line(assistant("Recovered")));
    expect(observations.map((output) => output.kind)).toEqual(["gap", "assistant"]);
    expect(observations[0]?.text).toContain("1 oversized stdout record");
    expect(observations[1]?.text).toBe("Recovered");
    expect(JSON.stringify(observations)).not.toContain("Must not appear");
  });

  it("enforces the line bound within one chunk and for an unterminated final record", () => {
    const { observations, observer } = collect("codex", { maximumLineBytes: 256 });
    observer.push(Buffer.concat([line(assistant("x".repeat(4096))), line(assistant("Next"))]));
    observer.push(Buffer.from("x".repeat(257)));
    observer.finish();
    observer.finish();
    expect(observations.map((output) => output.kind)).toEqual(["gap", "assistant", "gap"]);
    expect(observations[1]?.text).toBe("Next");
  });

  it("reports unsupported visible record shapes without copying their data", () => {
    const codex = collect();
    for (const event of [
      null,
      [],
      true,
      { private: "private envelope" },
      { type: "item.completed", item: [] },
      { type: "item.completed", item: { type: [] } },
      {
        type: "item.completed",
        item: { type: "agent_message", text: { private: "private text" } },
      },
    ])
      codex.observer.push(line(event));
    const copilot = collect("copilot");
    for (const event of [
      { type: "assistant.message", data: [] },
      { type: "assistant.message", data: { content: ["private"] } },
      { type: "assistant.message", data: { content: "private", toolRequests: {} } },
      { type: "tool.execution_complete", data: { result: { content: "private no identity" } } },
    ])
      copilot.observer.push(line(event));
    expect(codex.observations).toHaveLength(7);
    expect(copilot.observations).toHaveLength(4);
    const outputs = [...codex.observations, ...copilot.observations];
    expect(outputs.every((output) => output.kind === "gap")).toBe(true);
    expect(JSON.stringify(outputs)).not.toContain("private");
  });

  it("does not invent a result for an unsupported Copilot result envelope", () => {
    const { observations, observer } = collect("copilot");
    for (const result of [null, { content: [{ type: "text", text: "private unverified block" }] }])
      observer.push(
        line({ type: "tool.execution_complete", data: { toolCallId: "tool-1", result } }),
      );
    expect(observations).toHaveLength(2);
    expect(
      observations.every((output) => output.status === "info" && output.result === undefined),
    ).toBe(true);
    expect(JSON.stringify(observations)).not.toContain("private");
  });

  it("bounds identity inputs and never exposes raw provider IDs", () => {
    const { observations, observer } = collect();
    for (const id of ["", 4, {}, "x".repeat(513)]) observer.push(line(assistant("private", id)));
    expect(observations.every((output) => output.kind === "gap")).toBe(true);
    observer.push(line(assistant("Anonymous one", null)));
    observer.push(line(assistant("Anonymous two", null)));
    expect(observations[4]?.operation).toBe("append");
    expect(observations[4]?.itemId).not.toBe(observations[5]?.itemId);
    observer.push(line(assistant("Same raw identity", "shared-provider-id")));
    observer.push(line(command("shared-provider-id")));
    expect(observations[6]?.itemId).not.toBe(observations[7]?.itemId);
    expect(JSON.stringify(observations)).not.toContain("shared-provider-id");
    expect(JSON.stringify(observations)).not.toContain("private");
  });

  it("redacts before truncation, bounds total field bytes, and explicitly discloses truncation", () => {
    const secret = "credential-at-the-truncation-boundary";
    const { observations, observer } = collect("codex", { protectedValues: [secret] });
    observer.push(line(assistant(`${"a".repeat(8170)}${secret}${"\ud83c\udf0d".repeat(100)}`)));
    observer.push(
      line(
        command("large-command", "item.completed", {
          command: `echo ${"\u5de5".repeat(2000)}`,
          aggregated_output: "\ud83c\udf0d".repeat(4000),
        }),
      ),
    );
    expect(observations.map((output) => output.kind)).toEqual(["assistant", "gap", "tool", "gap"]);
    for (const output of observations) {
      expect(Buffer.byteLength(output.text, "utf8")).toBeLessThanOrEqual(8192);
      expect(Buffer.byteLength(output.command ?? "", "utf8")).toBeLessThanOrEqual(4096);
      expect(Buffer.byteLength(output.result ?? "", "utf8")).toBeLessThanOrEqual(8192);
      expect(
        Buffer.byteLength(output.text + (output.command ?? "") + (output.result ?? ""), "utf8"),
      ).toBeLessThanOrEqual(12 * 1024);
      expect(JSON.stringify(output)).not.toContain("\ufffd");
    }
    expect(observations[0]?.text).toContain("[Output truncated]");
    expect(observations[2]?.command).toContain("[Output truncated]");
    expect(observations[2]?.result).toContain("[Output truncated]");
    expect(JSON.stringify(observations)).not.toContain(secret.slice(0, 5));
  });

  it("omits commands and results that explicitly dump environment or authentication files", () => {
    const { observations, observer } = collect();
    for (const text of [
      "printenv",
      "Get-ChildItem Env:",
      "[Environment]::GetEnvironmentVariables()",
      "cmd.exe /c set",
      "Get-Content C:/Users/worker/.codex/auth.json",
    ])
      observer.push(
        line(command(text, "item.completed", { command: text, aggregated_output: "private dump" })),
      );
    expect(observations).toHaveLength(5);
    expect(observations.every((output) => output.text.includes("output omitted"))).toBe(true);
    expect(observations.every((output) => output.command === undefined)).toBe(true);
    expect(observations.every((output) => output.result === undefined)).toBe(true);
    expect(JSON.stringify(observations)).not.toContain("private dump");
    expect(JSON.stringify(observations)).not.toContain("auth.json");
  });

  it("does not reveal sensitive command output when its completion omits the command", () => {
    const { observations, observer } = collect();
    observer.push(
      line(command("sensitive-command", "item.started", { command: "Get-ChildItem Env:" })),
    );
    observer.push(
      line(
        command("sensitive-command", "item.completed", {
          command: undefined,
          aggregated_output: "private environment output",
        }),
      ),
    );
    expect(observations.map((output) => output.kind)).toEqual(["tool", "tool", "gap"]);
    expect(observations.every((output) => output.result === undefined)).toBe(true);
    expect(observations[0]?.itemId).toBe(observations[1]?.itemId);
    expect(observations[2]?.text).toContain("1 command result without a supported command");
    expect(JSON.stringify(observations)).not.toContain("private");
  });

  it("omits Windows environment tables in Copilot tool result content", () => {
    const { observations, observer } = collect("copilot");
    observer.push(
      line({
        type: "tool.execution_complete",
        data: {
          toolCallId: "environment-tool",
          result: {
            content:
              "Name                 Value\n----                 -----\nPATH                 private-path\nCUSTOM_TOKEN         private-value",
          },
        },
      }),
    );
    expect(observations[0]?.result).toBe("[Environment or authentication output omitted]");
    expect(JSON.stringify(observations)).not.toContain("private");
  });

  it("reports an incomplete drain once, including when cleanup fails after finish", () => {
    const { observations, observer } = collect();
    observer.push(line(assistant("Visible before failure")));
    observer.finish();
    observer.incomplete();
    observer.incomplete();
    observer.finish();
    expect(observations.map((output) => output.kind)).toEqual(["assistant", "gap"]);
    expect(observations[1]?.text).toBe("Output omitted: stdout capture did not finish completely.");
  });

  it("isolates synchronous and asynchronous callback failures without awaiting delivery", async () => {
    const onOutput = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("Observer failed");
      })
      .mockImplementationOnce(() => Promise.reject(new Error("Async observer failed")))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const observer = createModelOutputObserver("codex", onOutput);
    for (let index = 0; index < 4; index++)
      expect(observer.push(line(assistant(`Message ${index}`)))).toBeUndefined();
    expect(onOutput).toHaveBeenCalledTimes(4);
    observer.finish();
    await Promise.resolve();
  });

  it("remains optional and rejects an unbounded record buffer", () => {
    const observer = createModelOutputObserver("codex");
    observer.push(line(assistant("Ignored")));
    observer.finish();
    observer.incomplete();
    for (const maximumLineBytes of [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1024 * 1024 + 1,
    ])
      expect(() => createModelOutputObserver("codex", undefined, { maximumLineBytes })).toThrow(
        RangeError,
      );
  });
});

describe("visible output sanitization", () => {
  it("strips ANSI, OSC links, controls, and bidi controls before protecting text", () => {
    const secret = "private-credential";
    const text =
      `\u001b[31mVisible\u001b[0m \u001b]8;;https://example.invalid/mcp/private\u0007link\u001b]8;;\u0007 ` +
      `private-\u0000credential\u202e\r\nnext\rline\tend`;
    const result = sanitizeModelOutputText(text, [secret]);
    expect(result).toBe("Visible link [REDACTED]\nnext\nline\tend");
  });

  it.each([
    'curl -H "Authorization: Token opaque-session" --head https://example.com',
    "curl -H 'Proxy-Authorization: Negotiate opaque-session' https://example.com",
    "Cookie: session_id=opaque-session; extra=secondary-cookie",
    '{"Authorization":"Token opaque-session"}',
    'password="opaque-session" --token "secondary-cookie"',
    '{"api_key":"opaque-session", "refresh_token":"secondary-cookie"}',
    "Bearer opaque-session",
    "https://user:opaque-session@example.com/path",
    "https://example.com/path?signature=opaque-session",
    "http://127.0.0.1:1234/mcp/opaque-session",
    "https://example.com/path#opaque-session",
    "-----BEGIN PRIVATE KEY-----\nopaque-session\n-----END PRIVATE KEY-----",
  ])("redacts credential and capability forms in complete fields: %s", (text) => {
    const sanitized = sanitizeModelOutputText(text);
    expect(sanitized).not.toContain("opaque-session");
    expect(sanitized).not.toContain("secondary-cookie");
    expect(sanitized).toContain("[REDACTED");
  });

  it("redacts common provider tokens and exact protected values without silently truncating", () => {
    const secrets = [
      "sk-proj-123456789",
      "ghp_123456789",
      "github_pat_123456789",
      `arw1_${"a".repeat(43)}`,
      "eyJabc.def.ghi",
      "configured-private-value",
    ];
    const sanitized = sanitizeModelOutputText(secrets.join("\n"), [secrets[5]!]);
    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitizeModelOutputText("visible ".repeat(1000))).toBe("visible ".repeat(1000));
    expect(sanitizeModelOutputText(sanitized)).toBe(sanitized);
  });

  it("omits credential envelopes and environment dumps instead of relaying their structure", () => {
    for (const text of [
      '{"leaseToken":"private", "attemptId":"private-attempt", "fence":1}',
      '{"tokens":{"access_token":"private", "refresh_token":"private"}}',
      '{"environment":{"CUSTOM_NAME":"private"}}',
      '{"PATH":"private-path", "USERPROFILE":"private-profile"}',
      "PATH=private-path\nHOME=private-home\nUSER=private-user",
      "Name        Value\n----        -----\nHOME        private-home",
      "Name : USERPROFILE\nValue : private-profile",
      "Name : CUSTOM_TOKEN\nValue : private-token",
    ]) {
      const sanitized = sanitizeModelOutputText(text);
      expect(sanitized).toBe("[Environment or authentication output omitted]");
      expect(sanitized).not.toContain("private");
    }
    expect(sanitizeModelOutputText("See https://example.com/docs/output for details.")).toBe(
      "See https://example.com/docs/output for details.",
    );
  });
});
