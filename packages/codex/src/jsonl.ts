export const CodexKnownEventTypes = [
  "thread.started",
  "turn.started",
  "item.started",
  "item.completed",
  "turn.completed",
  "turn.failed",
  "error",
] as const;

export type CodexKnownEventType = (typeof CodexKnownEventTypes)[number];

export interface CodexKnownJsonlEvent {
  readonly kind: "event";
  readonly recognized: true;
  readonly type: CodexKnownEventType;
  readonly lineNumber: number;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface CodexUnknownJsonlEvent {
  readonly kind: "event";
  readonly recognized: false;
  readonly type: string;
  readonly lineNumber: number;
  readonly value: Readonly<Record<string, unknown>>;
}

export type CodexJsonlEvent = CodexKnownJsonlEvent | CodexUnknownJsonlEvent;

export type CodexJsonlParseIssueCode =
  | "invalid_json"
  | "non_object_event"
  | "missing_event_type"
  | "line_too_long";

export interface CodexJsonlParseIssue {
  readonly kind: "parse_issue";
  readonly code: CodexJsonlParseIssueCode;
  readonly lineNumber: number;
  readonly message: string;
  readonly linePreview: string;
}

export type CodexJsonlRecord = CodexJsonlEvent | CodexJsonlParseIssue;

export interface CodexJsonlParserOptions {
  readonly maximumLineCharacters?: number;
}

const defaultMaximumLineCharacters = 1_048_576;
const maximumPreviewCharacters = 512;

export class CodexJsonlParser {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maximumLineCharacters: number;
  #buffer = "";
  #discardingOversizedLine = false;
  #finished = false;
  #lineNumber = 1;

  public constructor(options: CodexJsonlParserOptions = {}) {
    const maximumLineCharacters = options.maximumLineCharacters ?? defaultMaximumLineCharacters;
    if (!Number.isSafeInteger(maximumLineCharacters) || maximumLineCharacters <= 0) {
      throw new RangeError("maximumLineCharacters must be a positive safe integer");
    }
    this.#maximumLineCharacters = maximumLineCharacters;
  }

  public push(chunk: string | Uint8Array): CodexJsonlRecord[] {
    if (this.#finished) {
      throw new Error("Cannot push data after the JSONL parser has finished");
    }

    const text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    return this.#consume(text);
  }

  public finish(): CodexJsonlRecord[] {
    if (this.#finished) {
      throw new Error("The JSONL parser has already finished");
    }
    this.#finished = true;

    const records = this.#consume(this.#decoder.decode());
    if (this.#discardingOversizedLine) {
      this.#discardingOversizedLine = false;
      this.#lineNumber += 1;
      return records;
    }

    if (this.#buffer.length > 0) {
      records.push(...this.#parseLine(this.#buffer));
      this.#buffer = "";
      this.#lineNumber += 1;
    }
    return records;
  }

  #consume(input: string): CodexJsonlRecord[] {
    const records: CodexJsonlRecord[] = [];
    let text = input;

    if (this.#discardingOversizedLine) {
      const newlineIndex = text.indexOf("\n");
      if (newlineIndex === -1) {
        return records;
      }
      text = text.slice(newlineIndex + 1);
      this.#discardingOversizedLine = false;
      this.#lineNumber += 1;
    }

    this.#buffer += text;
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      records.push(...this.#parseLine(line));
      this.#lineNumber += 1;
      newlineIndex = this.#buffer.indexOf("\n");
    }

    if (this.#buffer.length > this.#maximumLineCharacters) {
      records.push(this.#lineTooLongIssue(this.#buffer));
      this.#buffer = "";
      this.#discardingOversizedLine = true;
    }

    return records;
  }

  #parseLine(untrimmedLine: string): CodexJsonlRecord[] {
    const line = untrimmedLine.endsWith("\r") ? untrimmedLine.slice(0, -1) : untrimmedLine;
    const withoutBom = this.#lineNumber === 1 && line.startsWith("\uFEFF") ? line.slice(1) : line;
    if (withoutBom.trim().length === 0) {
      return [];
    }
    if (withoutBom.length > this.#maximumLineCharacters) {
      return [this.#lineTooLongIssue(withoutBom)];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(withoutBom) as unknown;
    } catch (error) {
      return [
        this.#issue(
          "invalid_json",
          error instanceof Error ? error.message : "JSON parsing failed",
          withoutBom,
        ),
      ];
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [this.#issue("non_object_event", "A JSONL event must be an object", withoutBom)];
    }

    const value = parsed as Record<string, unknown>;
    const eventType = value.type;
    if (typeof eventType !== "string" || eventType.length === 0) {
      return [
        this.#issue(
          "missing_event_type",
          "A JSONL event must have a non-empty string type",
          withoutBom,
        ),
      ];
    }

    if (isKnownEventType(eventType)) {
      return [
        {
          kind: "event",
          recognized: true,
          type: eventType,
          lineNumber: this.#lineNumber,
          value,
        },
      ];
    }

    return [
      {
        kind: "event",
        recognized: false,
        type: eventType,
        lineNumber: this.#lineNumber,
        value,
      },
    ];
  }

  #lineTooLongIssue(line: string): CodexJsonlParseIssue {
    return this.#issue(
      "line_too_long",
      `JSONL line exceeds ${this.#maximumLineCharacters} characters`,
      line,
    );
  }

  #issue(code: CodexJsonlParseIssueCode, message: string, line: string): CodexJsonlParseIssue {
    return {
      kind: "parse_issue",
      code,
      lineNumber: this.#lineNumber,
      message,
      linePreview: line.slice(0, maximumPreviewCharacters),
    };
  }
}

function isKnownEventType(value: string): value is CodexKnownEventType {
  return (CodexKnownEventTypes as readonly string[]).includes(value);
}
