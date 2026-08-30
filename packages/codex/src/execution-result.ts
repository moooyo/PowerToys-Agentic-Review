import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { createCanonicalResult } from "./canonical-result.js";
import type { CodexJsonlEvent, CodexJsonlRecord } from "./jsonl.js";

export interface CodexProcessExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly outputTruncated: boolean;
}

export interface CodexExecutionEvidence {
  readonly processExit: CodexProcessExit;
  readonly records: readonly CodexJsonlRecord[];
  readonly lastMessage: string | null;
}

export type CodexExecutionFailureCode =
  | "output_truncated"
  | "process_terminated"
  | "invalid_event_stream"
  | "codex_reported_error"
  | "codex_turn_failed"
  | "non_zero_exit"
  | "incomplete_event_stream"
  | "missing_result"
  | "invalid_result_json"
  | "invalid_result_schema";

export interface CodexExecutionSuccess<TResult> {
  readonly ok: true;
  readonly threadId: string;
  readonly result: TResult;
  readonly canonicalResultJson: string;
  readonly resultDigest: string;
}

export interface CodexExecutionFailure {
  readonly ok: false;
  readonly code: CodexExecutionFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly threadId?: string;
}

export type CodexExecutionResult<TResult> = CodexExecutionSuccess<TResult> | CodexExecutionFailure;

export function determineCodexExecutionResult<TOutputSchema extends TSchema>(
  evidence: CodexExecutionEvidence,
  outputSchema: TOutputSchema,
): CodexExecutionResult<Static<TOutputSchema>> {
  const events = evidence.records.filter(
    (record): record is CodexJsonlEvent => record.kind === "event",
  );
  const threadId = findThreadId(events);

  if (evidence.processExit.outputTruncated) {
    return failure(
      "output_truncated",
      "Codex output exceeded the configured process output limit",
      false,
      threadId,
    );
  }
  if (evidence.processExit.signal !== null || evidence.processExit.exitCode === null) {
    return failure(
      "process_terminated",
      evidence.processExit.signal === null
        ? "The Codex process terminated without an exit code"
        : `The Codex process was terminated by ${evidence.processExit.signal}`,
      true,
      threadId,
    );
  }

  const parseIssue = evidence.records.find((record) => record.kind === "parse_issue");
  if (parseIssue !== undefined && parseIssue.kind === "parse_issue") {
    return failure(
      "invalid_event_stream",
      `Invalid Codex JSONL at line ${parseIssue.lineNumber}: ${parseIssue.message}`,
      false,
      threadId,
    );
  }

  const errorEvent = events.find((event) => event.recognized && event.type === "error");
  if (errorEvent !== undefined) {
    return failure(
      "codex_reported_error",
      extractEventMessage(errorEvent, "Codex reported an error"),
      true,
      threadId,
    );
  }

  const failedTurn = events.find((event) => event.recognized && event.type === "turn.failed");
  if (failedTurn !== undefined) {
    return failure(
      "codex_turn_failed",
      extractEventMessage(failedTurn, "The Codex turn failed"),
      true,
      threadId,
    );
  }

  if (evidence.processExit.exitCode !== 0) {
    return failure(
      "non_zero_exit",
      `The Codex process exited with code ${evidence.processExit.exitCode}`,
      true,
      threadId,
    );
  }

  if (threadId === undefined || !hasCompleteEventSequence(events)) {
    return failure(
      "incomplete_event_stream",
      "Codex exited successfully without a complete thread and turn event sequence",
      true,
      threadId,
    );
  }

  if (evidence.lastMessage === null || evidence.lastMessage.trim().length === 0) {
    return failure("missing_result", "Codex did not write a final result", true, threadId);
  }

  let parsedResult: unknown;
  try {
    parsedResult = JSON.parse(evidence.lastMessage) as unknown;
  } catch (error) {
    return failure(
      "invalid_result_json",
      error instanceof Error ? error.message : "The final result is not valid JSON",
      false,
      threadId,
    );
  }

  if (!Value.Check(outputSchema, parsedResult)) {
    const firstError = Value.Errors(outputSchema, parsedResult).First();
    const detail =
      firstError === undefined
        ? "The final result does not match the output schema"
        : `${firstError.path || "/"}: ${firstError.message}`;
    return failure("invalid_result_schema", detail, false, threadId);
  }

  const canonical = createCanonicalResult(parsedResult);
  return {
    ok: true,
    threadId,
    result: parsedResult,
    canonicalResultJson: canonical.json,
    resultDigest: canonical.sha256,
  };
}

function hasCompleteEventSequence(events: readonly CodexJsonlEvent[]): boolean {
  let threadStarted = false;
  let turnStarted = false;

  for (const event of events) {
    if (!event.recognized) {
      continue;
    }
    if (event.type === "thread.started") {
      const threadId = event.value.thread_id;
      threadStarted = typeof threadId === "string" && threadId.length > 0;
      turnStarted = false;
      continue;
    }
    if (event.type === "turn.started" && threadStarted) {
      turnStarted = true;
      continue;
    }
    if (event.type === "turn.completed" && turnStarted) {
      return true;
    }
  }
  return false;
}

function findThreadId(events: readonly CodexJsonlEvent[]): string | undefined {
  for (const event of events) {
    if (event.recognized && event.type === "thread.started") {
      const threadId = event.value.thread_id;
      if (typeof threadId === "string" && threadId.length > 0) {
        return threadId;
      }
    }
  }
  return undefined;
}

function extractEventMessage(event: CodexJsonlEvent, fallback: string): string {
  const directMessage = event.value.message;
  if (typeof directMessage === "string" && directMessage.length > 0) {
    return directMessage;
  }

  const error = event.value.error;
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const nestedMessage = (error as Record<string, unknown>).message;
    if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
      return nestedMessage;
    }
  }
  return fallback;
}

function failure(
  code: CodexExecutionFailureCode,
  message: string,
  retryable: boolean,
  threadId: string | undefined,
): CodexExecutionFailure {
  return {
    ok: false,
    code,
    message,
    retryable,
    ...(threadId === undefined ? {} : { threadId }),
  };
}
