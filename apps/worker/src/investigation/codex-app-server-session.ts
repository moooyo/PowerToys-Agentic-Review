import type { InvestigationTokenUsage } from "@agentic-review/contracts";
import {
  type ManagedProcessStandardInput,
  processHostInteractiveStdinCapability,
} from "../execution/process-host-protocol.js";
import { type ParsedCliModelUsage, parseCliModelUsage } from "./model-usage-parser.js";

export type CodexAppServerStopReason =
  | "token_budget"
  | "usage_unavailable"
  | "protocol_error"
  | "model_mismatch";

export interface CodexAppServerSessionOptions {
  readonly model: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: unknown;
  readonly passiveProposal: boolean;
  readonly maximumTokens: number;
  readonly maximumResultBytes: number;
  readonly onUsage: (usage: ParsedCliModelUsage) => void;
  readonly onEvent: (event: Uint8Array) => void;
  readonly onStop: (reason: CodexAppServerStopReason) => void;
}

export interface CodexAppServerSession {
  start(stdin: ManagedProcessStandardInput): Promise<void>;
  push(chunk: Uint8Array): void;
  finish(): void;
  interrupt(): Promise<void>;
  snapshot(completeTransport: boolean): ParsedCliModelUsage;
  finalMessage(): string;
}

type JsonObject = Record<string, unknown>;
type PendingRequest = {
  readonly method: string;
  readonly resolve: (value: JsonObject) => void;
  readonly reject: (error: Error) => void;
};

/** One ephemeral thread and one turn; ProcessHost remains responsible for native teardown. */
export function createCodexAppServerSession(
  options: CodexAppServerSessionOptions,
): CodexAppServerSession {
  if (
    !options.model.trim() ||
    !Number.isSafeInteger(options.maximumTokens) ||
    options.maximumTokens < 1 ||
    !Number.isSafeInteger(options.maximumResultBytes) ||
    options.maximumResultBytes < 1
  )
    throw new TypeError("The app-server model and execution budgets must be explicit.");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const maximumLineBytes = Math.max(1024 * 1024, options.maximumResultBytes + 65_536);
  const pending = new Map<number, PendingRequest>();
  const sentIds = new Set<number>();
  let nextId = 1;
  let stdin: ManagedProcessStandardInput | undefined;
  let writeTail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let interruptPromise: Promise<void> | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let buffer = "";
  let ended = false;
  let terminal = false;
  let completed = false;
  let interrupted = false;
  let interruptRequested = false;
  let stopReason: CodexAppServerStopReason | undefined;
  let latestUsage: ParsedCliModelUsage | undefined;
  let lastUsageFingerprint: string | undefined;
  let message = "";
  let equalityCheck: NodeJS.Immediate | undefined;
  let resolveTurnEnded: () => void = () => {};
  const turnEnded = new Promise<void>((resolve) => {
    resolveTurnEnded = resolve;
  });

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const stop = (reason: CodexAppServerStopReason): void => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    if (equalityCheck !== undefined) clearImmediate(equalityCheck);
    options.onStop(reason);
  };
  const protocolFailure = (): void => {
    rejectPending(new Error("The Codex app-server protocol could not continue."));
    stop("protocol_error");
  };
  const write = (value: unknown): Promise<void> => {
    if (stdin === undefined || closePromise !== undefined)
      return Promise.reject(new Error("The Codex app-server input is closed."));
    const destination = stdin;
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    const operation = writeTail.then(async () => {
      for (
        let offset = 0;
        offset < bytes.byteLength;
        offset += processHostInteractiveStdinCapability.maximumChunkBytes
      )
        await destination.write(
          bytes.subarray(offset, offset + processHostInteractiveStdinCapability.maximumChunkBytes),
        );
    });
    writeTail = operation.catch(() => {
      protocolFailure();
    });
    return operation;
  };
  const close = (): Promise<void> => {
    closePromise ??= writeTail
      .then(async () => {
        await stdin?.close();
      })
      .catch((error: unknown) => {
        protocolFailure();
        throw error;
      });
    return closePromise;
  };
  const request = (method: string, params: unknown): Promise<JsonObject> => {
    const id = nextId++;
    sentIds.add(id);
    return new Promise<JsonObject>((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      void write({ id, method, params }).catch(() => {
        pending.delete(id);
        reject(new Error(`The Codex app-server ${method} request could not be sent.`));
      });
    });
  };
  const emit = (type: string, item: JsonObject): void => {
    options.onEvent(Buffer.from(`${JSON.stringify({ type, item })}\n`, "utf8"));
  };
  const bindTurn = (value: unknown): boolean => {
    const turn = object(value);
    if (turn === null || typeof turn.id !== "string" || !turn.id) {
      protocolFailure();
      return false;
    }
    if (turnId !== undefined && turnId !== turn.id) {
      protocolFailure();
      return false;
    }
    turnId = turn.id;
    return true;
  };
  const bound = (params: JsonObject): boolean =>
    threadId !== undefined &&
    turnId !== undefined &&
    params.threadId === threadId &&
    params.turnId === turnId;

  const acceptUsage = (params: JsonObject): void => {
    if (!bound(params)) return;
    const total = object(object(params.tokenUsage)?.total);
    const counters =
      total === null
        ? null
        : {
            input_tokens: total.inputTokens,
            cached_input_tokens: total.cachedInputTokens,
            output_tokens: total.outputTokens,
            reasoning_tokens: total.reasoningOutputTokens,
            cache_write_tokens:
              total.cacheWriteInputTokens === undefined ? 0 : total.cacheWriteInputTokens,
            total_tokens: total.totalTokens,
          };
    const parsed = parseCliModelUsage(
      "codex",
      JSON.stringify({ type: "turn.completed", usage: counters }),
    );
    if (
      total === null ||
      parsed.completeness !== "complete" ||
      ![
        "cachedInputTokens",
        "inputTokens",
        "outputTokens",
        "reasoningOutputTokens",
        "totalTokens",
      ].every((key) => count(total[key])) ||
      (total.cacheWriteInputTokens !== undefined && !count(total.cacheWriteInputTokens)) ||
      parsed.usage.totalTokens === null ||
      parsed.usage.inputTokens === null ||
      parsed.usage.outputTokens === null
    ) {
      if (latestUsage === undefined && parsed.completeness !== "unavailable") {
        latestUsage = { ...parsed, completeness: "partial", completedTurns: 0 };
        options.onUsage(structuredClone(latestUsage));
      }
      stop("usage_unavailable");
      return;
    }
    if (latestUsage !== undefined) {
      for (const key of tokenFields) {
        const previous = latestUsage.usage[key];
        const current = parsed.usage[key];
        if (previous !== null && (current === null || current < previous)) {
          stop("usage_unavailable");
          return;
        }
      }
    }
    const fingerprint = JSON.stringify(parsed.usage);
    if (fingerprint !== lastUsageFingerprint) {
      latestUsage = { ...parsed, completeness: "partial", completedTurns: 0 };
      lastUsageFingerprint = fingerprint;
      options.onUsage(structuredClone(latestUsage));
    }
    if (parsed.usage.totalTokens > options.maximumTokens) stop("token_budget");
    else if (parsed.usage.totalTokens === options.maximumTokens && equalityCheck === undefined) {
      // A final completion already present in this stdout batch may finish exactly at the limit.
      equalityCheck = setImmediate(() => {
        equalityCheck = undefined;
        if (!completed && !ended) stop("token_budget");
      });
    }
  };
  const acceptItem = (itemValue: unknown, event: "item.started" | "item.completed"): void => {
    const item = object(itemValue);
    if (item === null || typeof item.id !== "string" || typeof item.type !== "string") {
      protocolFailure();
      return;
    }
    if (item.type === "contextCompaction") {
      stop("usage_unavailable");
      return;
    }
    if (item.type === "agentMessage") {
      if (typeof item.text !== "string") {
        protocolFailure();
        return;
      }
      if (event === "item.completed" && (item.phase == null || item.phase === "final_answer")) {
        if (Buffer.byteLength(item.text, "utf8") > options.maximumResultBytes) {
          protocolFailure();
          return;
        }
        message = item.text;
      }
      emit(event, { id: item.id, type: "agent_message", text: item.text });
    } else if (item.type === "commandExecution") {
      emit(event, {
        id: item.id,
        type: "command_execution",
        command: item.command,
        aggregated_output: item.aggregatedOutput,
        exit_code: item.exitCode,
        status: item.status === "inProgress" ? "in_progress" : item.status,
      });
    } else if (item.type === "mcpToolCall") emit(event, { id: item.id, type: "mcp_tool_call" });
  };
  const response = (value: JsonObject): void => {
    if (typeof value.id !== "number") {
      protocolFailure();
      return;
    }
    const entry = pending.get(value.id);
    if (entry === undefined) {
      if (!sentIds.has(value.id)) protocolFailure();
      return;
    }
    pending.delete(value.id);
    const result = object(value.result);
    if (value.error !== undefined || result === null) {
      entry.reject(new Error(`The Codex app-server rejected ${entry.method}.`));
      stop("protocol_error");
      return;
    }
    if (entry.method === "thread/start") {
      const thread = object(result.thread);
      if (result.model !== options.model) {
        entry.reject(new Error("The Codex app-server selected a different model."));
        stop("model_mismatch");
        return;
      }
      if (thread === null || typeof thread.id !== "string" || !thread.id) {
        entry.reject(new Error("The Codex app-server did not identify its thread."));
        protocolFailure();
        return;
      }
      threadId = thread.id;
    } else if (entry.method === "turn/start" && !bindTurn(result.turn)) {
      entry.reject(new Error("The Codex app-server did not identify its turn."));
      return;
    }
    entry.resolve(result);
  };
  const notification = (value: JsonObject): void => {
    const params = object(value.params);
    if (params === null) return;
    if (value.method === "turn/started" && params.threadId === threadId) {
      bindTurn(params.turn);
    } else if (value.method === "thread/tokenUsage/updated") acceptUsage(params);
    else if (value.method === "model/rerouted" && bound(params)) {
      if (params.toModel !== options.model) stop("model_mismatch");
    } else if (value.method === "thread/compacted" && params.threadId === threadId) {
      stop("usage_unavailable");
    } else if (
      (value.method === "item/started" || value.method === "item/completed") &&
      bound(params)
    ) {
      acceptItem(params.item, value.method === "item/started" ? "item.started" : "item.completed");
    } else if (value.method === "turn/completed" && params.threadId === threadId) {
      const turn = object(params.turn);
      if (turn === null || turn.id !== turnId || turnId === undefined) return;
      if (!Array.isArray(turn.items)) {
        protocolFailure();
        return;
      }
      for (const item of turn.items) acceptItem(item, "item.completed");
      terminal = true;
      completed = turn.status === "completed";
      if (!completed && turn.status !== "interrupted") stop("protocol_error");
      if (completed && latestUsage === undefined) stop("usage_unavailable");
      if (turn.status === "interrupted") interrupted = true;
      if (equalityCheck !== undefined) clearImmediate(equalityCheck);
      resolveTurnEnded();
      if (!interruptRequested) void close().catch(() => {});
    }
  };
  const line = (text: string): void => {
    if (!text.trim()) return;
    if (Buffer.byteLength(text, "utf8") > maximumLineBytes) {
      protocolFailure();
      return;
    }
    const value = object(JSON.parse(text));
    if (value === null) {
      protocolFailure();
      return;
    }
    if (typeof value.method === "string") {
      if (value.id !== undefined) {
        void write({
          id: value.id,
          error: {
            code: -32601,
            message: "Interactive server requests are not supported by this Worker.",
          },
        }).catch(() => {});
        stop("protocol_error");
      } else notification(value);
    } else response(value);
  };
  const consume = (text: string): void => {
    buffer += text;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const next = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        line(next);
      } catch {
        protocolFailure();
      }
      newline = buffer.indexOf("\n");
    }
    if (Buffer.byteLength(buffer, "utf8") > maximumLineBytes) {
      buffer = "";
      protocolFailure();
    }
  };

  return {
    async start(input) {
      if (stdin !== undefined || ended || interrupted)
        throw new Error("The Codex app-server session cannot be started twice.");
      stdin = input;
      try {
        await request("initialize", {
          clientInfo: { name: "agentic-review-worker", version: "1.0" },
        });
        if (interrupted || stopReason !== undefined) return;
        await write({ method: "initialized" });
        await request("thread/start", {
          model: options.model,
          cwd: options.cwd,
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: options.passiveProposal ? "read-only" : "danger-full-access",
        });
        if (interrupted || stopReason !== undefined) return;
        await request("turn/start", {
          threadId,
          model: options.model,
          input: [{ type: "text", text: options.prompt }],
          outputSchema: options.outputSchema,
        });
      } catch (error) {
        if (stopReason === undefined && !interrupted) stop("protocol_error");
        throw error;
      }
    },
    push(chunk) {
      if (ended) return;
      try {
        consume(decoder.decode(chunk, { stream: true }));
      } catch {
        protocolFailure();
      }
    },
    finish() {
      if (ended) return;
      ended = true;
      if (equalityCheck !== undefined) clearImmediate(equalityCheck);
      try {
        consume(decoder.decode());
        if (buffer.trim()) line(buffer);
        buffer = "";
      } catch {
        protocolFailure();
      }
      if (!terminal && !interrupted) stop("protocol_error");
      rejectPending(new Error("The Codex app-server output stream ended."));
      resolveTurnEnded();
    },
    interrupt() {
      interruptPromise ??= (async () => {
        if (terminal || ended) {
          await close();
          return;
        }
        interruptRequested = true;
        interrupted = true;
        if (!ended && !completed && threadId !== undefined && turnId !== undefined) {
          const acknowledgement = request("turn/interrupt", { threadId, turnId });
          await Promise.all([acknowledgement, turnEnded]);
        }
        await close();
      })();
      return interruptPromise;
    },
    snapshot(completeTransport) {
      const snapshot = structuredClone(latestUsage ?? parseCliModelUsage("codex", ""));
      snapshot.completeness =
        latestUsage === undefined
          ? "unavailable"
          : completeTransport && completed && !interrupted && stopReason === undefined
            ? "complete"
            : "partial";
      snapshot.completedTurns = completed ? 1 : 0;
      return snapshot;
    },
    finalMessage() {
      return completed && !interrupted && stopReason === undefined ? message : "";
    },
  };
}

const tokenFields = [
  "inputTokens",
  "cachedReadTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheWriteTokens",
  "totalTokens",
] as const satisfies readonly (keyof InvestigationTokenUsage)[];

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
