import { describe, expect, it } from "vitest";

import { determineCodexExecutionResult } from "./execution-result.js";
import { CodexJsonlParser } from "./jsonl.js";
import { PrReviewPlanV1Schema } from "./review-results.js";

const validResult = {
  schemaVersion: "PrReviewPlanV1",
  summary: "No actionable correctness issues were found.",
  assessment: "approve",
  findings: [],
  requestedRecipeIds: [],
};

function parseEvents(lines: readonly string[]) {
  const parser = new CodexJsonlParser();
  return [...parser.push(`${lines.join("\n")}\n`), ...parser.finish()];
}

describe("determineCodexExecutionResult", () => {
  it("accepts a completed event stream and validates the final result", () => {
    const result = determineCodexExecutionResult(
      {
        processExit: { exitCode: 0, signal: null, outputTruncated: false },
        records: parseEvents([
          '{"type":"thread.started","thread_id":"thread-1"}',
          '{"type":"turn.started"}',
          '{"type":"item.completed","item":{"type":"agent_message"}}',
          '{"type":"future.event","data":true}',
          '{"type":"turn.completed","usage":{"input_tokens":1}}',
        ]),
        lastMessage: JSON.stringify(validResult),
      },
      PrReviewPlanV1Schema,
    );

    expect(result).toMatchObject({
      ok: true,
      threadId: "thread-1",
      result: validResult,
      canonicalResultJson:
        '{"assessment":"approve","findings":[],"requestedRecipeIds":[],"schemaVersion":"PrReviewPlanV1","summary":"No actionable correctness issues were found."}',
    });
    expect(result.ok && result.resultDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("prioritizes a structured Codex error over a non-zero exit", () => {
    const result = determineCodexExecutionResult(
      {
        processExit: { exitCode: 1, signal: null, outputTruncated: false },
        records: parseEvents([
          '{"type":"thread.started","thread_id":"thread-2"}',
          '{"type":"turn.started"}',
          '{"type":"error","message":"authentication expired"}',
        ]),
        lastMessage: null,
      },
      PrReviewPlanV1Schema,
    );

    expect(result).toEqual({
      ok: false,
      code: "codex_reported_error",
      message: "authentication expired",
      retryable: true,
      threadId: "thread-2",
    });
  });

  it("rejects a malformed event stream", () => {
    const result = determineCodexExecutionResult(
      {
        processExit: { exitCode: 0, signal: null, outputTruncated: false },
        records: parseEvents(["not json"]),
        lastMessage: JSON.stringify(validResult),
      },
      PrReviewPlanV1Schema,
    );

    expect(result).toMatchObject({ ok: false, code: "invalid_event_stream", retryable: false });
  });

  it("rejects successful exits without a complete event sequence", () => {
    const result = determineCodexExecutionResult(
      {
        processExit: { exitCode: 0, signal: null, outputTruncated: false },
        records: parseEvents([
          '{"type":"thread.started","thread_id":"thread-3"}',
          '{"type":"turn.started"}',
        ]),
        lastMessage: JSON.stringify(validResult),
      },
      PrReviewPlanV1Schema,
    );

    expect(result).toMatchObject({ ok: false, code: "incomplete_event_stream", retryable: true });
  });

  it("requires the terminal events to appear in protocol order", () => {
    const result = determineCodexExecutionResult(
      {
        processExit: { exitCode: 0, signal: null, outputTruncated: false },
        records: parseEvents([
          '{"type":"turn.completed"}',
          '{"type":"thread.started","thread_id":"thread-ordered"}',
          '{"type":"turn.started"}',
        ]),
        lastMessage: JSON.stringify(validResult),
      },
      PrReviewPlanV1Schema,
    );

    expect(result).toMatchObject({ ok: false, code: "incomplete_event_stream" });
  });

  it("rejects results that contain fields outside the strict schema", () => {
    const result = determineCodexExecutionResult(
      {
        processExit: { exitCode: 0, signal: null, outputTruncated: false },
        records: parseEvents([
          '{"type":"thread.started","thread_id":"thread-4"}',
          '{"type":"turn.started"}',
          '{"type":"turn.completed"}',
        ]),
        lastMessage: JSON.stringify({ ...validResult, command: "build.cmd" }),
      },
      PrReviewPlanV1Schema,
    );

    expect(result).toMatchObject({ ok: false, code: "invalid_result_schema", retryable: false });
  });

  it("rejects truncated output before trusting terminal events", () => {
    const result = determineCodexExecutionResult(
      {
        processExit: { exitCode: 0, signal: null, outputTruncated: true },
        records: parseEvents([
          '{"type":"thread.started","thread_id":"thread-5"}',
          '{"type":"turn.started"}',
          '{"type":"turn.completed"}',
        ]),
        lastMessage: JSON.stringify(validResult),
      },
      PrReviewPlanV1Schema,
    );

    expect(result).toMatchObject({ ok: false, code: "output_truncated", retryable: false });
  });
});
