import { createHash } from "node:crypto";
import { types } from "node:util";
import { createCanonicalResult, redactExecutionText } from "@agentic-review/codex";
import type { ReviewExecutionEvidence } from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CodexAppServerNotification } from "./codex-app-server-transport.js";
import { parseModelProtocolJson } from "./model-response-observer.js";

export const codexAppServerMaximumProtectedValueCount = 512;

export const codexAppServerOutputLimits = Object.freeze({
  maximumNotificationBytes: 8 * 1024 * 1024,
  maximumTotalBytes: 32 * 1024 * 1024,
  maximumEvents: 4096,
  maximumEarlyEvents: 256,
  maximumEarlyBytes: 16 * 1024 * 1024,
  maximumItems: 512,
  maximumCommands: 128,
  maximumResultBytes: 2 * 1024 * 1024,
  maximumSchemaBytes: 2 * 1024 * 1024,
});
export type CodexAppServerOutputLimits = {
  -readonly [Key in keyof typeof codexAppServerOutputLimits]: number;
};
export type CodexAppServerOutputErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_NOTIFICATION"
  | "SCOPE_MISMATCH"
  | "TURN_STATE_INVALID"
  | "ITEM_STATE_INVALID"
  | "UNSUPPORTED_EVENT"
  | "UNSUPPORTED_ITEM"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "TEXT_MISMATCH"
  | "TURN_FAILED"
  | "TURN_INTERRUPTED"
  | "STREAM_ERROR"
  | "INCOMPLETE_STREAM"
  | "RESULT_MISSING"
  | "RESULT_AMBIGUOUS"
  | "RESULT_INVALID_JSON"
  | "RESULT_INVALID_SCHEMA"
  | "RESULT_PROTECTED";
export class CodexAppServerOutputError extends Error {
  constructor(readonly code: CodexAppServerOutputErrorCode) {
    super("The Codex app-server turn output could not be validated.");
    this.name = "CodexAppServerOutputError";
  }
}
export interface CodexAppServerOutputOptions<T extends TSchema> {
  readonly threadId: string;
  readonly authoritativeSchema: {
    readonly json: string;
    readonly digest: string;
    readonly resultSchema: T;
  };
  readonly protectedValues?: readonly string[];
  readonly limits?: Partial<CodexAppServerOutputLimits>;
}
export interface CodexAppServerOutput<TResult> {
  readonly threadId: string;
  readonly turnId: string;
  readonly finalItemId: string;
  readonly finalSelection: "explicit_final_answer" | "single_unphased_message";
  readonly result: TResult;
  readonly rawResultJson: string;
  readonly canonicalResultJson: string;
  readonly resultDigest: string;
  readonly commandEvidence: Pick<ReviewExecutionEvidence, "commands" | "commandCapture">;
  /** An observed fileChange lifecycle is not proof of successful mutation or Git cleanliness. */
  readonly observedFileChange: boolean;
}
export interface CodexAppServerOutputCollector<TResult> {
  readonly state: "awaiting_turn_id" | "receiving" | "terminal" | "finished" | "failed";
  /** Only turn-notification completeness; process/transport closure remains the caller's responsibility. */
  readonly terminal: Promise<void>;
  observe(notification: CodexAppServerNotification): void;
  bindTurnStart(response: unknown): string;
  /** Call after the parent has separately confirmed transport/process drain. */
  finish(): CodexAppServerOutput<TResult>;
}

type JsonObject = Record<string, unknown>;
type Item = {
  readonly id: string;
  readonly type: string;
  readonly ordinal: number;
  readonly start: JsonObject;
  completed?: JsonObject;
  readonly text: string[];
  textBytes: number;
  sawDelta: boolean;
  patch?: unknown;
};
const relevant = new Set([
  "turn/started",
  "turn/completed",
  "error",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/commandExecution/terminalInteraction",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "turn/plan/updated",
  "turn/diff/updated",
  "turn/moderationMetadata",
]);
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
function fail(code: CodexAppServerOutputErrorCode): never {
  throw new CodexAppServerOutputError(code);
}
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value: JsonObject, key: string) => Object.hasOwn(value, key);
const keys = (value: JsonObject, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function id(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  );
}
function text(value: unknown, maximum = 8 * 1024 * 1024): value is string {
  return (
    typeof value === "string" && value.isWellFormed() && Buffer.byteLength(value, "utf8") <= maximum
  );
}
function nullableString(value: unknown): boolean {
  return value === undefined || value === null || text(value);
}
function nullableInteger(value: unknown): boolean {
  return value === undefined || value === null || integer(value);
}
function freeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

/** Validates descriptors before canonical serialization, then retains an independent JSON snapshot. */
function snapshot(value: unknown, maximum: number): { value: unknown; bytes: number } {
  const ancestors = new Set<object>();
  let nodes = 0;
  let stringBytes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 64) fail("INVALID_NOTIFICATION");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("INVALID_NOTIFICATION");
      return;
    }
    if (typeof item === "string") {
      if (!item.isWellFormed()) fail("INVALID_NOTIFICATION");
      stringBytes += Buffer.byteLength(item, "utf8");
      if (stringBytes > maximum) fail("OUTPUT_LIMIT_EXCEEDED");
      return;
    }
    if (typeof item !== "object" || item === null || ancestors.has(item) || types.isProxy(item))
      fail("INVALID_NOTIFICATION");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (
      (array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(item).length
    )
      fail("INVALID_NOTIFICATION");
    const entries = Object.entries(Object.getOwnPropertyDescriptors(item)).filter(
      ([key]) => !array || key !== "length",
    );
    if (
      entries.length > 100_000 ||
      (array &&
        (entries.length !== item.length || entries.some(([key], index) => key !== String(index))))
    )
      fail("INVALID_NOTIFICATION");
    ancestors.add(item);
    for (const [key, descriptor] of entries) {
      if (!descriptor.enumerable || !("value" in descriptor) || !key.isWellFormed())
        fail("INVALID_NOTIFICATION");
      stringBytes += Buffer.byteLength(key, "utf8");
      if (stringBytes > maximum) fail("OUTPUT_LIMIT_EXCEEDED");
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  const canonical = createCanonicalResult(value);
  const bytes = Buffer.byteLength(canonical.json, "utf8");
  if (bytes > maximum) fail("OUTPUT_LIMIT_EXCEEDED");
  return { value: parseModelProtocolJson(canonical.json), bytes };
}
function limits(
  overrides: Partial<CodexAppServerOutputLimits> | undefined,
): CodexAppServerOutputLimits {
  const result: CodexAppServerOutputLimits = { ...codexAppServerOutputLimits };
  if (overrides !== undefined) {
    if (!object(overrides) || types.isProxy(overrides)) fail("INVALID_CONFIGURATION");
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(overrides))) {
      if (!(key in result) || !("value" in descriptor)) fail("INVALID_CONFIGURATION");
      const value: unknown = descriptor.value;
      const name = key as keyof CodexAppServerOutputLimits;
      if (!integer(value) || (value as number) < 1 || (value as number) > result[name])
        fail("INVALID_CONFIGURATION");
      result[name] = value as number;
    }
  }
  return Object.freeze(result);
}
function phase(item: JsonObject): "commentary" | "final_answer" | null {
  return item.phase === undefined || item.phase === null
    ? null
    : (item.phase as "commentary" | "final_answer");
}
function containsProtectedResult(value: unknown, protectedValues: readonly string[]): boolean {
  if (!protectedValues.length) return false;
  const contains = (text: string) => protectedValues.some((secret) => text.includes(secret));
  const pending = [value];
  let visited = 0;
  while (pending.length) {
    if (++visited > 100_000) return true;
    const current = pending.pop();
    if (current !== null && typeof current === "object") {
      if (Array.isArray(current)) pending.push(...current);
      else {
        for (const [key, child] of Object.entries(current)) {
          if (contains(key)) return true;
          pending.push(child);
        }
      }
    } else {
      const text = typeof current === "string" ? current : JSON.stringify(current);
      if (text !== undefined && contains(text)) return true;
    }
  }
  return false;
}
function changes(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 512 &&
    value.every((change) => {
      if (
        !object(change) ||
        !keys(change, ["path", "kind", "diff"]) ||
        !text(change.path, 32767) ||
        !text(change.diff) ||
        !object(change.kind)
      )
        return false;
      return change.kind.type === "update"
        ? keys(change.kind, ["type", "move_path"]) && nullableString(change.kind.move_path)
        : keys(change.kind, ["type"]) && ["add", "delete"].includes(String(change.kind.type));
    })
  );
}
function validateItem(item: unknown): asserts item is JsonObject & { id: string; type: string } {
  if (!object(item) || !id(item.id) || typeof item.type !== "string") fail("INVALID_NOTIFICATION");
  switch (item.type) {
    case "agentMessage":
      if (
        !keys(item, ["id", "type", "text", "phase", "memoryCitation"]) ||
        !text(item.text) ||
        ![undefined, null, "commentary", "final_answer"].includes(item.phase as undefined) ||
        !(
          item.memoryCitation === undefined ||
          item.memoryCitation === null ||
          object(item.memoryCitation)
        )
      )
        fail("INVALID_NOTIFICATION");
      return;
    case "commandExecution":
      if (
        !keys(item, [
          "id",
          "type",
          "command",
          "commandActions",
          "cwd",
          "status",
          "aggregatedOutput",
          "exitCode",
          "durationMs",
          "processId",
          "source",
        ]) ||
        !text(item.command, 2048) ||
        !item.command ||
        !text(item.cwd, 32767) ||
        !item.cwd ||
        !Array.isArray(item.commandActions) ||
        item.commandActions.length > 128 ||
        !["inProgress", "completed", "failed", "declined"].includes(String(item.status)) ||
        !nullableString(item.aggregatedOutput) ||
        !nullableInteger(item.exitCode) ||
        (typeof item.exitCode === "number" &&
          (item.exitCode < -2_147_483_648 || item.exitCode > 2_147_483_647)) ||
        !nullableInteger(item.durationMs) ||
        !nullableString(item.processId) ||
        ![undefined, "agent", "userShell", "unifiedExecStartup", "unifiedExecInteraction"].includes(
          item.source as undefined,
        )
      )
        fail("INVALID_NOTIFICATION");
      for (const action of item.commandActions) {
        if (
          !object(action) ||
          !text(action.command) ||
          !["read", "listFiles", "search", "unknown"].includes(String(action.type))
        )
          fail("INVALID_NOTIFICATION");
        const allowed =
          action.type === "read"
            ? ["type", "command", "name", "path"]
            : action.type === "search"
              ? ["type", "command", "query", "path"]
              : action.type === "listFiles"
                ? ["type", "command", "path"]
                : ["type", "command"];
        if (
          !keys(action, allowed) ||
          (action.type === "read" && (!text(action.name) || !text(action.path))) ||
          !nullableString(action.path) ||
          !nullableString(action.query)
        )
          fail("INVALID_NOTIFICATION");
      }
      return;
    case "fileChange":
      if (
        !keys(item, ["id", "type", "status", "changes"]) ||
        !["inProgress", "completed", "failed", "declined"].includes(String(item.status)) ||
        !changes(item.changes)
      )
        fail("INVALID_NOTIFICATION");
      return;
    case "reasoning":
      if (
        !keys(item, ["id", "type", "content", "summary"]) ||
        ![item.content, item.summary].every(
          (part) =>
            part === undefined ||
            (Array.isArray(part) && part.length <= 512 && part.every((entry) => text(entry))),
        )
      )
        fail("INVALID_NOTIFICATION");
      return;
    case "plan":
      if (!keys(item, ["id", "type", "text"]) || !text(item.text)) fail("INVALID_NOTIFICATION");
      return;
    case "userMessage":
      if (
        !keys(item, ["id", "type", "content", "clientId"]) ||
        !Array.isArray(item.content) ||
        item.content.length > 512 ||
        !nullableString(item.clientId)
      )
        fail("INVALID_NOTIFICATION");
      return;
    case "contextCompaction":
      if (!keys(item, ["id", "type"])) fail("INVALID_NOTIFICATION");
      return;
    default:
      fail("UNSUPPORTED_ITEM");
  }
}
function turn(
  value: unknown,
): asserts value is JsonObject & { id: string; status: string; items: unknown[] } {
  if (
    !object(value) ||
    !keys(value, [
      "id",
      "items",
      "itemsView",
      "status",
      "startedAt",
      "completedAt",
      "durationMs",
      "error",
    ]) ||
    !id(value.id) ||
    !["inProgress", "completed", "failed", "interrupted"].includes(String(value.status)) ||
    !Array.isArray(value.items) ||
    value.items.length > 512 ||
    ![undefined, "notLoaded", "summary", "full"].includes(value.itemsView as undefined) ||
    !nullableInteger(value.startedAt) ||
    !nullableInteger(value.completedAt) ||
    !nullableInteger(value.durationMs)
  )
    fail("INVALID_NOTIFICATION");
  if (value.itemsView === "notLoaded" && value.items.length !== 0) fail("INVALID_NOTIFICATION");
  if (
    value.error !== undefined &&
    value.error !== null &&
    (!object(value.error) ||
      !keys(value.error, ["message", "additionalDetails", "codexErrorInfo"]) ||
      !text(value.error.message) ||
      !nullableString(value.error.additionalDetails))
  )
    fail("INVALID_NOTIFICATION");
  for (const item of value.items) validateItem(item);
}

export function createCodexAppServerOutputCollector<T extends TSchema>(
  options: CodexAppServerOutputOptions<T>,
): CodexAppServerOutputCollector<Static<T>> {
  return new OutputCollector(options);
}

class OutputCollector<T extends TSchema> implements CodexAppServerOutputCollector<Static<T>> {
  readonly terminal: Promise<void>;
  readonly #threadId: string;
  readonly #schema: T;
  readonly #protected: readonly string[];
  readonly #limits: CodexAppServerOutputLimits;
  readonly #items = new Map<string, Item>();
  readonly #early: JsonObject[] = [];
  #resolveTerminal!: () => void;
  #rejectTerminal!: (error: unknown) => void;
  #state: CodexAppServerOutputCollector<unknown>["state"] = "awaiting_turn_id";
  #turnId: string | undefined;
  #earlyTurnId: string | undefined;
  #started = false;
  #terminalTurn: JsonObject | undefined;
  #failure: CodexAppServerOutputError | undefined;
  #output: CodexAppServerOutput<Static<T>> | undefined;
  #totalBytes = 0;
  #eventCount = 0;
  #earlyBytes = 0;
  #commandCount = 0;

  constructor(options: CodexAppServerOutputOptions<T>) {
    try {
      this.#limits = limits(options.limits);
      if (!id(options.threadId)) fail("INVALID_CONFIGURATION");
      this.#threadId = options.threadId;
      const authority = options.authoritativeSchema;
      if (
        !text(authority.json, this.#limits.maximumSchemaBytes) ||
        !/^[a-f0-9]{64}$/u.test(authority.digest) ||
        hash(authority.json) !== authority.digest
      )
        fail("INVALID_CONFIGURATION");
      const schemaJson = parseModelProtocolJson(authority.json);
      this.#schema = Value.Clone(authority.resultSchema);
      // TypeBox symbol annotations belong to the typed validator, not the wire JSON schema.
      const typedSchemaJson = parseModelProtocolJson(JSON.stringify(this.#schema));
      if (createCanonicalResult(schemaJson).json !== createCanonicalResult(typedSchemaJson).json)
        fail("INVALID_CONFIGURATION");
      const secrets = options.protectedValues ?? [];
      if (
        !Array.isArray(secrets) ||
        secrets.length > codexAppServerMaximumProtectedValueCount ||
        !secrets.every((entry) => text(entry, 32768))
      )
        fail("INVALID_CONFIGURATION");
      this.#protected = Object.freeze([...secrets].filter(Boolean));
    } catch {
      throw new CodexAppServerOutputError("INVALID_CONFIGURATION");
    }
    this.terminal = new Promise<void>((resolve, reject) => {
      this.#resolveTerminal = resolve;
      this.#rejectTerminal = reject;
    });
    void this.terminal.catch(() => undefined);
  }
  get state() {
    return this.#state;
  }

  observe(notification: CodexAppServerNotification): void {
    this.#guard(() => {
      const copy = snapshot(notification, this.#limits.maximumNotificationBytes);
      const value = copy.value;
      if (
        !object(value) ||
        !keys(value, ["method", "params", "emittedAtMs"]) ||
        !text(value.method, 128) ||
        (has(value, "emittedAtMs") &&
          (!integer(value.emittedAtMs) || (value.emittedAtMs as number) < 0))
      )
        fail("INVALID_NOTIFICATION");
      this.#eventCount += 1;
      this.#totalBytes += copy.bytes;
      if (
        this.#eventCount > this.#limits.maximumEvents ||
        this.#totalBytes > this.#limits.maximumTotalBytes
      )
        fail("OUTPUT_LIMIT_EXCEEDED");
      const params = value.params;
      if (object(params) && has(params, "threadId") && params.threadId !== this.#threadId)
        fail("SCOPE_MISMATCH");
      if (!relevant.has(value.method as string)) {
        if (
          (value.method as string).startsWith("item/") ||
          (value.method as string).startsWith("turn/")
        )
          fail("UNSUPPORTED_EVENT");
        return;
      }
      if (!object(params) || params.threadId !== this.#threadId) fail("SCOPE_MISMATCH");
      const eventTurnId =
        value.method === "turn/started" || value.method === "turn/completed"
          ? object(params.turn)
            ? params.turn.id
            : undefined
          : params.turnId;
      if (!id(eventTurnId)) fail("INVALID_NOTIFICATION");
      if (this.#turnId === undefined) {
        if (this.#earlyTurnId !== undefined && eventTurnId !== this.#earlyTurnId)
          fail("SCOPE_MISMATCH");
        this.#earlyTurnId = eventTurnId;
        this.#earlyBytes += copy.bytes;
        if (
          this.#early.length >= this.#limits.maximumEarlyEvents ||
          this.#earlyBytes > this.#limits.maximumEarlyBytes
        )
          fail("OUTPUT_LIMIT_EXCEEDED");
        this.#early.push(value);
        return;
      }
      if (eventTurnId !== this.#turnId) fail("SCOPE_MISMATCH");
      this.#consume(value);
    });
  }
  bindTurnStart(response: unknown): string {
    return this.#guard(() => {
      if (this.#turnId !== undefined) fail("TURN_STATE_INVALID");
      const value = snapshot(response, this.#limits.maximumNotificationBytes).value;
      if (!object(value) || !keys(value, ["turn"])) fail("INVALID_NOTIFICATION");
      turn(value.turn);
      if (this.#earlyTurnId !== undefined && value.turn.id !== this.#earlyTurnId)
        fail("SCOPE_MISMATCH");
      this.#turnId = value.turn.id;
      this.#state = "receiving";
      for (const event of this.#early.splice(0)) this.#consume(event);
      this.#earlyBytes = 0;
      if (value.turn.status !== "inProgress" && this.#terminalTurn?.status !== value.turn.status)
        fail("TURN_STATE_INVALID");
      this.#checkSnapshot(value.turn, false);
      return this.#turnId;
    });
  }
  finish(): CodexAppServerOutput<Static<T>> {
    return this.#guard(() => {
      if (this.#output) return this.#output;
      if (!this.#turnId || !this.#terminalTurn || this.#state !== "terminal")
        fail("INCOMPLETE_STREAM");
      const selection = this.#selectFinal();
      const rawResultJson = selection.item.completed?.text;
      if (!text(rawResultJson, this.#limits.maximumResultBytes) || rawResultJson.trim() === "")
        fail("RESULT_MISSING");
      if (this.#protected.some((secret) => rawResultJson.includes(secret)))
        fail("RESULT_PROTECTED");
      let result: unknown;
      try {
        result = parseModelProtocolJson(rawResultJson);
      } catch {
        fail("RESULT_INVALID_JSON");
      }
      if (containsProtectedResult(result, this.#protected)) fail("RESULT_PROTECTED");
      if (!Value.Check(this.#schema, result)) fail("RESULT_INVALID_SCHEMA");
      const canonical = createCanonicalResult(result);
      if (Buffer.byteLength(canonical.json, "utf8") > this.#limits.maximumResultBytes)
        fail("OUTPUT_LIMIT_EXCEEDED");
      const commandEvidence = this.#commandEvidence();
      const output: CodexAppServerOutput<Static<T>> = {
        threadId: this.#threadId,
        turnId: this.#turnId,
        finalItemId: selection.item.id,
        finalSelection: selection.kind,
        result: result as Static<T>,
        rawResultJson,
        canonicalResultJson: canonical.json,
        resultDigest: canonical.sha256,
        commandEvidence,
        observedFileChange: [...this.#items.values()].some((item) => item.type === "fileChange"),
      };
      freeze(output);
      this.#output = output;
      this.#state = "finished";
      return output;
    });
  }
  #guard<R>(operation: () => R): R {
    if (this.#failure) throw this.#failure;
    try {
      return operation();
    } catch (cause) {
      this.#failure =
        cause instanceof CodexAppServerOutputError
          ? cause
          : new CodexAppServerOutputError("INVALID_NOTIFICATION");
      this.#state = "failed";
      this.#early.length = 0;
      this.#rejectTerminal(this.#failure);
      throw this.#failure;
    }
  }
  #consume(event: JsonObject): void {
    if (this.#state === "terminal" || this.#state === "finished") fail("TURN_STATE_INVALID");
    const params = event.params as JsonObject;
    const method = event.method as string;
    if (method === "turn/started") {
      if (this.#started || !keys(params, ["threadId", "turn"])) fail("TURN_STATE_INVALID");
      turn(params.turn);
      if (
        params.turn.status !== "inProgress" ||
        params.turn.error != null ||
        params.turn.items.length
      )
        fail("TURN_STATE_INVALID");
      this.#started = true;
      return;
    }
    if (!this.#started) fail("TURN_STATE_INVALID");
    if (method === "error") {
      if (
        !keys(params, ["threadId", "turnId", "error", "willRetry"]) ||
        typeof params.willRetry !== "boolean" ||
        !object(params.error) ||
        !text(params.error.message)
      )
        fail("INVALID_NOTIFICATION");
      fail("STREAM_ERROR");
    }
    if (method === "turn/completed") {
      if (!keys(params, ["threadId", "turn"])) fail("INVALID_NOTIFICATION");
      turn(params.turn);
      if (params.turn.status === "failed") fail("TURN_FAILED");
      if (params.turn.status === "interrupted") fail("TURN_INTERRUPTED");
      if (params.turn.status !== "completed" || params.turn.error != null)
        fail("TURN_STATE_INVALID");
      if ([...this.#items.values()].some((item) => !item.completed)) fail("INCOMPLETE_STREAM");
      this.#checkSnapshot(params.turn, true);
      this.#selectFinal();
      this.#terminalTurn = params.turn;
      this.#state = "terminal";
      this.#resolveTerminal();
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      this.#item(method, params);
      return;
    }
    if (method.startsWith("item/")) {
      this.#itemDelta(method, params);
      return;
    }
    if (method === "turn/diff/updated") {
      if (!keys(params, ["threadId", "turnId", "diff"]) || !text(params.diff))
        fail("INVALID_NOTIFICATION");
    } else if (method === "turn/plan/updated") {
      if (
        !keys(params, ["threadId", "turnId", "plan", "explanation"]) ||
        !nullableString(params.explanation) ||
        !Array.isArray(params.plan) ||
        params.plan.length > 512 ||
        !params.plan.every(
          (step) =>
            object(step) &&
            keys(step, ["step", "status"]) &&
            text(step.step) &&
            ["pending", "inProgress", "completed"].includes(String(step.status)),
        )
      )
        fail("INVALID_NOTIFICATION");
    } else if (method === "turn/moderationMetadata") {
      if (!keys(params, ["threadId", "turnId", "metadata"])) fail("INVALID_NOTIFICATION");
    }
  }
  #item(method: string, params: JsonObject): void {
    const starting = method === "item/started";
    const timestamp = starting ? "startedAtMs" : "completedAtMs";
    if (!keys(params, ["threadId", "turnId", "item", timestamp]) || !integer(params[timestamp]))
      fail("INVALID_NOTIFICATION");
    const value = params.item;
    validateItem(value);
    if (starting) {
      if (this.#items.has(value.id)) fail("ITEM_STATE_INVALID");
      if (this.#items.size >= this.#limits.maximumItems) fail("OUTPUT_LIMIT_EXCEEDED");
      if (["commandExecution", "fileChange"].includes(value.type) && value.status !== "inProgress")
        fail("ITEM_STATE_INVALID");
      if (value.type === "commandExecution" && ++this.#commandCount > this.#limits.maximumCommands)
        fail("OUTPUT_LIMIT_EXCEEDED");
      const initialText = value.type === "agentMessage" ? (value.text as string) : "";
      const textBytes = Buffer.byteLength(initialText, "utf8");
      if (textBytes > this.#limits.maximumResultBytes) fail("OUTPUT_LIMIT_EXCEEDED");
      this.#items.set(value.id, {
        id: value.id,
        type: value.type,
        ordinal: this.#items.size,
        start: value,
        text: [initialText],
        textBytes,
        sawDelta: false,
      });
      return;
    }
    const item = this.#items.get(value.id);
    if (!item || item.completed || item.type !== value.type) fail("ITEM_STATE_INVALID");
    if (value.type === "agentMessage") {
      if (!text(value.text, this.#limits.maximumResultBytes)) fail("OUTPUT_LIMIT_EXCEEDED");
      if (
        (phase(item.start) !== null && phase(item.start) !== phase(value)) ||
        (item.sawDelta
          ? value.text !== item.text.join("")
          : !value.text.startsWith(item.start.text as string))
      )
        fail("TEXT_MISMATCH");
    } else if (value.type === "commandExecution") {
      if (
        value.status === "inProgress" ||
        value.command !== item.start.command ||
        value.cwd !== item.start.cwd ||
        (value.source ?? "agent") !== (item.start.source ?? "agent")
      )
        fail("ITEM_STATE_INVALID");
    } else if (value.type === "fileChange") {
      if (
        value.status === "inProgress" ||
        (item.patch &&
          createCanonicalResult(item.patch).json !== createCanonicalResult(value.changes).json)
      )
        fail("ITEM_STATE_INVALID");
    }
    item.completed = value;
    item.text.length = 0;
  }
  #itemDelta(method: string, params: JsonObject): void {
    if (!id(params.itemId)) fail("INVALID_NOTIFICATION");
    const item = this.#items.get(params.itemId);
    if (!item || item.completed) fail("ITEM_STATE_INVALID");
    const prefix = ["threadId", "turnId", "itemId"];
    if (method === "item/fileChange/patchUpdated") {
      if (
        item.type !== "fileChange" ||
        !keys(params, [...prefix, "changes"]) ||
        !changes(params.changes)
      )
        fail("INVALID_NOTIFICATION");
      item.patch = params.changes;
      return;
    }
    if (method === "item/commandExecution/terminalInteraction") {
      if (
        item.type !== "commandExecution" ||
        !keys(params, [...prefix, "processId", "stdin"]) ||
        !text(params.processId, 128) ||
        !text(params.stdin)
      )
        fail("INVALID_NOTIFICATION");
      return;
    }
    if (method === "item/reasoning/summaryPartAdded") {
      if (
        item.type !== "reasoning" ||
        !keys(params, [...prefix, "summaryIndex"]) ||
        !integer(params.summaryIndex) ||
        (params.summaryIndex as number) < 0
      )
        fail("INVALID_NOTIFICATION");
      return;
    }
    const expected =
      method === "item/agentMessage/delta"
        ? "agentMessage"
        : method === "item/commandExecution/outputDelta"
          ? "commandExecution"
          : method === "item/fileChange/outputDelta"
            ? "fileChange"
            : method === "item/plan/delta"
              ? "plan"
              : "reasoning";
    const index =
      method === "item/reasoning/textDelta"
        ? "contentIndex"
        : method === "item/reasoning/summaryTextDelta"
          ? "summaryIndex"
          : undefined;
    if (
      item.type !== expected ||
      !keys(params, [...prefix, "delta", ...(index ? [index] : [])]) ||
      !text(params.delta) ||
      (index && (!integer(params[index]) || (params[index] as number) < 0))
    )
      fail("INVALID_NOTIFICATION");
    if (item.type === "agentMessage") {
      item.textBytes += Buffer.byteLength(params.delta, "utf8");
      if (item.textBytes > this.#limits.maximumResultBytes) fail("OUTPUT_LIMIT_EXCEEDED");
      item.sawDelta = true;
      item.text.push(params.delta);
    }
    // Plan completion is authoritative in 0.145 and may differ from its display deltas.
    // Command output is bounded and observed, but does not establish validation sufficiency.
  }
  #checkSnapshot(value: JsonObject, requireComplete: boolean): void {
    const entries = value.items as JsonObject[];
    if (!entries.length) return; // 0.145 deliberately emits itemsView:notLoaded lifecycle snapshots.
    const seen = new Set<string>();
    for (const entry of entries) {
      const item = this.#items.get(entry.id as string);
      if (
        !item ||
        seen.has(item.id) ||
        (requireComplete && !item.completed) ||
        createCanonicalResult(entry).json !==
          createCanonicalResult(item.completed ?? item.start).json
      )
        fail("ITEM_STATE_INVALID");
      seen.add(item.id);
    }
    if (value.itemsView !== "summary" && requireComplete && seen.size !== this.#items.size)
      fail("INCOMPLETE_STREAM");
  }
  #selectFinal(): { item: Item; kind: CodexAppServerOutput<unknown>["finalSelection"] } {
    const agents = [...this.#items.values()].filter(
      (item) => item.type === "agentMessage" && item.completed,
    );
    const explicit = agents.filter(
      (item) => phase(item.completed as JsonObject) === "final_answer",
    );
    if (explicit.length > 1) fail("RESULT_AMBIGUOUS");
    const selected = explicit[0];
    if (selected) return { item: selected, kind: "explicit_final_answer" };
    const unknown = agents.filter((item) => phase(item.completed as JsonObject) === null);
    if (unknown.length > 1) fail("RESULT_AMBIGUOUS");
    const fallback = unknown[0];
    if (!fallback) fail("RESULT_MISSING");
    if ([...this.#items.values()].some((item) => item.ordinal > fallback.ordinal))
      fail("RESULT_AMBIGUOUS");
    return { item: fallback, kind: "single_unphased_message" };
  }
  #commandEvidence(): Pick<ReviewExecutionEvidence, "commands" | "commandCapture"> {
    const commands: ReviewExecutionEvidence["commands"] = [];
    let incomplete = false;
    for (const item of this.#items.values()) {
      if (item.type !== "commandExecution") continue;
      const value = item.completed as JsonObject;
      const exitCode = typeof value.exitCode === "number" ? value.exitCode : null;
      const completed = ["completed", "failed"].includes(String(value.status)) && exitCode !== null;
      if (!completed) incomplete = true;
      commands.push({
        itemId: redactExecutionText(item.id, this.#protected).slice(0, 128),
        command: redactExecutionText(value.command as string, this.#protected),
        status: completed
          ? value.status === "failed" || exitCode !== 0
            ? "failed"
            : "completed"
          : "unknown",
        exitCode,
      });
    }
    return { commands, commandCapture: incomplete ? "incomplete" : "complete" };
  }
}
