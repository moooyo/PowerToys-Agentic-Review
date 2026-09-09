import { createHash } from "node:crypto";
import { createCanonicalResult } from "@agentic-review/codex";
import type {
  ModelResponseObservationV1,
  ModelResponseReasonCode,
} from "@agentic-review/contracts";

export interface ModelResponseObserverOptions {
  readonly format: "sse" | "json";
  readonly maximumBodyBytes: number;
  readonly maximumEventBytes: number;
  readonly maximumEvents: number;
  readonly maximumOutputTextBytes: number;
}
export interface ModelResponseObserver {
  /** False means parsing is invalid and the caller should stop its transport immediately. */
  push(chunk: Uint8Array): boolean;
  finish(input: { readonly complete: boolean }): ModelResponseObservationV1;
}

const maximumBytes = 64 * 1024 * 1024;
const maximumEvents = 1_000_000;
const maximumJsonDepth = 64;
const maximumJsonNodes = 100_000;

export class ModelProtocolJsonError extends Error {
  constructor(readonly code: ModelResponseReasonCode) {
    super("The model protocol JSON could not be validated.");
    this.name = "ModelProtocolJsonError";
  }
}

/** Strict request/response JSON parsing; callers bound the original UTF-8 body before calling. */
export function parseModelProtocolJson(text: string): unknown {
  function fail(code: ModelResponseReasonCode = "INVALID_JSON"): never {
    throw new ModelProtocolJsonError(code);
  }
  if (typeof text !== "string" || !text.isWellFormed()) fail();
  let position = 0;
  let nodes = 0;
  const whitespace = () => {
    while (position < text.length && /[\x20\t\r\n]/u.test(text[position] as string)) position++;
  };
  const string = (): string => {
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === '"') {
        let value: unknown;
        try {
          value = JSON.parse(text.slice(start, position));
        } catch {
          return fail();
        }
        if (typeof value !== "string" || !value.isWellFormed()) fail();
        return value;
      }
      if (character === "\\") {
        if (position >= text.length) fail();
        position++;
      } else if ((character?.charCodeAt(0) ?? 0) < 0x20) fail();
    }
    return fail();
  };
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const value = (depth: number): unknown => {
    if (depth > maximumJsonDepth || ++nodes > maximumJsonNodes) fail("JSON_COMPLEXITY_EXCEEDED");
    whitespace();
    const character = text[position];
    if (character === '"') return string();
    if (character === "{") {
      position++;
      const object: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      whitespace();
      if (text[position] === "}") {
        position++;
        return object;
      }
      while (true) {
        if (text[position] !== '"') fail();
        const key = string();
        if (keys.has(key)) fail("AMBIGUOUS_JSON");
        keys.add(key);
        whitespace();
        if (text[position++] !== ":") fail();
        object[key] = value(depth + 1);
        whitespace();
        const separator = text[position++];
        if (separator === "}") return object;
        if (separator !== ",") fail();
        whitespace();
      }
    }
    if (character === "[") {
      position++;
      const array: unknown[] = [];
      whitespace();
      if (text[position] === "]") {
        position++;
        return array;
      }
      while (true) {
        array.push(value(depth + 1));
        whitespace();
        const separator = text[position++];
        if (separator === "]") return array;
        if (separator !== ",") fail();
      }
    }
    for (const [literal, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, position)) {
        position += literal.length;
        return result;
      }
    }
    number.lastIndex = position;
    const matched = number.exec(text);
    if (matched === null) fail();
    position = number.lastIndex;
    const result = Number(matched[0]);
    if (!Number.isFinite(result)) fail();
    return result;
  };
  const result = value(0);
  whitespace();
  if (position !== text.length) fail();
  return result;
}

// Pinned supported event names from the official Responses streaming reference:
// https://developers.openai.com/api/reference/resources/responses/streaming-events
const supportedEvents = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.output_text.annotation.added",
  "response.refusal.delta",
  "response.refusal.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.file_search_call.in_progress",
  "response.file_search_call.searching",
  "response.file_search_call.completed",
  "response.web_search_call.in_progress",
  "response.web_search_call.searching",
  "response.web_search_call.completed",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.image_generation_call.completed",
  "response.image_generation_call.generating",
  "response.image_generation_call.in_progress",
  "response.image_generation_call.partial_image",
  "response.mcp_call_arguments.delta",
  "response.mcp_call_arguments.done",
  "response.mcp_call.completed",
  "response.mcp_call.failed",
  "response.mcp_call.in_progress",
  "response.mcp_list_tools.completed",
  "response.mcp_list_tools.failed",
  "response.mcp_list_tools.in_progress",
  "response.code_interpreter_call.in_progress",
  "response.code_interpreter_call.interpreting",
  "response.code_interpreter_call.completed",
  "response.code_interpreter_call_code.delta",
  "response.code_interpreter_call_code.done",
  "response.custom_tool_call_input.delta",
  "response.custom_tool_call_input.done",
  "response.audio.delta",
  "response.audio.done",
  "response.audio.transcript.delta",
  "response.audio.transcript.done",
  "response.shell_call_command.added",
  "response.shell_call_command.delta",
  "response.shell_call_command.done",
  "response.shell_call_output_content.delta",
  "response.shell_call_output_content.done",
  "error",
]);
const terminalTypes: ReadonlyMap<string, TerminalOutcome> = new Map([
  ["response.completed", "completed"],
  ["response.failed", "failed"],
  ["response.incomplete", "incomplete"],
] as const);
type TerminalOutcome = "completed" | "failed" | "incomplete";
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.trim() === value &&
    value.isWellFormed() &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  );
}
function bound(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

/** Observes identity bytes only; provider authority and transport policy remain the broker's job. */
export function createModelResponseObserver(
  options: ModelResponseObserverOptions,
): ModelResponseObserver {
  if (
    !options ||
    !["sse", "json"].includes(options.format) ||
    !bound(options.maximumBodyBytes, maximumBytes) ||
    !bound(options.maximumEventBytes, options.maximumBodyBytes) ||
    !bound(options.maximumEvents, maximumEvents) ||
    !bound(options.maximumOutputTextBytes, options.maximumBodyBytes)
  )
    throw new TypeError("Model response observer limits are invalid.");
  const limits = { ...options };
  const digest = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let bodyBytes = 0,
    eventCount = 0,
    nextSequence = 0;
  let reason: ModelResponseReasonCode | null = null;
  let line = "",
    data: string[] = [],
    eventName: string | null = null,
    eventBytes = 0;
  let jsonBody = "",
    beginning = true,
    done = false;
  let pendingCarriageReturn = false;
  let responseId: string | null = null,
    modelId: string | null = null;
  let terminal: { outcome: TerminalOutcome; outputJsonSha256: string | null } | null = null;
  let finished: ModelResponseObservationV1 | undefined;
  const lifecycle = new Set<string>();
  const invalid = (code: ModelResponseReasonCode): void => {
    reason ??= code;
    line = "";
    data = [];
    eventName = null;
    jsonBody = "";
    responseId = null;
    modelId = null;
    terminal = null;
  };
  function fail(code: ModelResponseReasonCode): never {
    throw new ModelProtocolJsonError(code);
  }
  const pin = (value: unknown, field: "id" | "model") => {
    if (!identity(value)) fail("INVALID_METADATA");
    const previous = field === "id" ? responseId : modelId;
    if (previous !== null && previous !== value) fail("CONFLICTING_METADATA");
    if (field === "id") responseId = value;
    else modelId = value;
  };
  const metadata = (response: unknown, status: readonly string[]) => {
    if (
      !object(response) ||
      response.object !== "response" ||
      typeof response.status !== "string" ||
      !status.includes(response.status)
    )
      fail("INVALID_METADATA");
    pin(response.id, "id");
    pin(response.model, "model");
    return response;
  };
  const outputDigest = (response: Record<string, unknown>): string | null => {
    if (!Array.isArray(response.output) || response.output.length === 0) return null;
    const last = response.output.at(-1);
    if (
      !object(last) ||
      last.type !== "message" ||
      last.role !== "assistant" ||
      last.status !== "completed" ||
      !Array.isArray(last.content) ||
      last.content.length === 0
    )
      return null;
    const pieces: string[] = [];
    let bytes = 0;
    for (const content of last.content) {
      if (
        !object(content) ||
        content.type !== "output_text" ||
        typeof content.text !== "string" ||
        !content.text.isWellFormed()
      )
        return null;
      bytes += Buffer.byteLength(content.text, "utf8");
      if (bytes > limits.maximumOutputTextBytes) fail("OUTPUT_LIMIT_EXCEEDED");
      pieces.push(content.text);
    }
    try {
      return createCanonicalResult(parseModelProtocolJson(pieces.join(""))).sha256;
    } catch {
      return null;
    }
  };
  const acceptTerminal = (response: unknown, outcome: TerminalOutcome) => {
    if (terminal !== null) fail("INVALID_TERMINAL");
    const checked = metadata(response, [outcome]);
    terminal = {
      outcome,
      outputJsonSha256: outcome === "completed" ? outputDigest(checked) : null,
    };
  };
  const event = (text: string, name: string | null) => {
    if (text === "[DONE]") {
      if (terminal === null || done || (name !== null && name !== "")) fail("INVALID_TERMINAL");
      done = true;
      return;
    }
    eventCount++;
    if (eventCount > limits.maximumEvents) fail("EVENT_LIMIT_EXCEEDED");
    if (terminal !== null || done) fail("INVALID_TERMINAL");
    const parsed = parseModelProtocolJson(text);
    if (!object(parsed) || typeof parsed.type !== "string" || !supportedEvents.has(parsed.type))
      fail("INVALID_METADATA");
    if (name !== null && name !== "" && name !== parsed.type) fail("INVALID_SSE");
    if (!Number.isSafeInteger(parsed.sequence_number) || parsed.sequence_number !== nextSequence)
      fail("INVALID_SEQUENCE");
    nextSequence++;
    if (parsed.type === "error") fail("INVALID_METADATA");
    if (Object.hasOwn(parsed, "response_id")) pin(parsed.response_id, "id");
    const outcome = terminalTypes.get(parsed.type);
    if (outcome !== undefined) {
      acceptTerminal(parsed.response, outcome);
      return;
    }
    if (["response.created", "response.in_progress", "response.queued"].includes(parsed.type)) {
      if (
        lifecycle.has(parsed.type) ||
        (parsed.type === "response.created" && parsed.sequence_number !== 0) ||
        (parsed.type === "response.queued" && lifecycle.has("response.in_progress"))
      )
        fail("INVALID_SEQUENCE");
      lifecycle.add(parsed.type);
      metadata(
        parsed.response,
        parsed.type === "response.created"
          ? ["queued", "in_progress"]
          : [parsed.type === "response.queued" ? "queued" : "in_progress"],
      );
    } else if (Object.hasOwn(parsed, "response")) {
      // Unknown response-shaped metadata on an unrelated event cannot become identity authority.
      fail("INVALID_METADATA");
    }
  };
  const completeLine = () => {
    const value = line.endsWith("\r") ? line.slice(0, -1) : line;
    line = "";
    if (value.includes("\r")) fail("INVALID_SSE");
    if (value === "") {
      if (data.length > 0) event(data.join("\n"), eventName);
      data = [];
      eventName = null;
      eventBytes = 0;
      return;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") data.push(content);
    else if (field === "event") {
      if (eventName !== null) fail("INVALID_SSE");
      eventName = content;
    } else if (field === "id") {
      if (content.includes("\0")) fail("INVALID_SSE");
    } else if (field === "retry") {
      if (!/^[0-9]+$/u.test(content)) fail("INVALID_SSE");
    } else fail("INVALID_SSE");
  };
  const consume = (text: string) => {
    if (limits.format === "json") {
      jsonBody += text;
      return;
    }
    for (const character of text) {
      if (beginning) {
        beginning = false;
        if (character === "\uFEFF") continue;
      }
      if (pendingCarriageReturn && character !== "\n") completeLine();
      pendingCarriageReturn = false;
      eventBytes += Buffer.byteLength(character, "utf8");
      if (eventBytes > limits.maximumEventBytes) fail("EVENT_LIMIT_EXCEEDED");
      if (character === "\n") completeLine();
      else {
        line += character;
        pendingCarriageReturn = character === "\r";
      }
    }
  };
  return Object.freeze({
    push(chunk: Uint8Array): boolean {
      if (finished !== undefined)
        throw new Error("The model response observer is already finished.");
      if (!(chunk instanceof Uint8Array))
        throw new TypeError("Model response chunks must be byte arrays.");
      if (!Number.isSafeInteger(bodyBytes + chunk.byteLength))
        throw new RangeError("Observed model response bytes exceed the safe integer range.");
      bodyBytes += chunk.byteLength;
      if (reason !== null || bodyBytes > limits.maximumBodyBytes) {
        digest.update(chunk);
        if (reason === null) invalid("BODY_LIMIT_EXCEEDED");
        return false;
      }
      const owned = Uint8Array.from(chunk);
      digest.update(owned);
      try {
        consume(decoder.decode(owned, { stream: true }));
      } catch (error) {
        invalid(error instanceof ModelProtocolJsonError ? error.code : "INVALID_UTF8");
      }
      return reason === null;
    },
    finish(input: { readonly complete: boolean }): ModelResponseObservationV1 {
      if (typeof input?.complete !== "boolean")
        throw new TypeError("Transport completion must be explicit.");
      if (finished !== undefined) {
        if (input.complete !== finished.transportComplete)
          throw new Error("Transport completion cannot change after observation.");
        return finished;
      }
      if (!input.complete) invalid("TRANSPORT_INCOMPLETE");
      if (reason === null) {
        try {
          consume(decoder.decode());
          if (limits.format === "json") {
            if (bodyBytes > 0) eventCount = 1;
            const response = parseModelProtocolJson(jsonBody);
            if (
              !object(response) ||
              !["completed", "failed", "incomplete"].includes(String(response.status))
            )
              fail("INVALID_METADATA");
            acceptTerminal(response, response.status as TerminalOutcome);
          } else {
            if (line.length > 0) completeLine();
            if (data.length > 0 || eventName !== null) fail("INVALID_SSE");
          }
          if (terminal === null) fail("MISSING_TERMINAL");
        } catch (error) {
          invalid(error instanceof ModelProtocolJsonError ? error.code : "INVALID_UTF8");
        }
      }
      const accepted = terminal as {
        outcome: TerminalOutcome;
        outputJsonSha256: string | null;
      } | null;
      finished = Object.freeze({
        schemaVersion: "ModelResponseObservationV1",
        bodySha256: digest.digest("hex"),
        bodyBytes,
        eventCount,
        transportComplete: input.complete,
        outcome: reason === null && accepted ? accepted.outcome : "invalid",
        responseId: reason === null ? responseId : null,
        modelId: reason === null ? modelId : null,
        outputJsonSha256: reason === null && accepted ? accepted.outputJsonSha256 : null,
        reasonCode:
          reason ??
          (accepted?.outcome === "failed"
            ? "RESPONSE_FAILED"
            : accepted?.outcome === "incomplete"
              ? "RESPONSE_INCOMPLETE"
              : null),
      });
      line = "";
      data = [];
      jsonBody = "";
      terminal = null;
      return finished;
    },
  });
}
