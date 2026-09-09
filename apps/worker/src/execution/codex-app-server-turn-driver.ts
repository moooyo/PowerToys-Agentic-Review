import { createHash } from "node:crypto";
import { types } from "node:util";
import { createCanonicalResult } from "@agentic-review/codex";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  type CodexAppServerOutput,
  type CodexAppServerOutputCollector,
  CodexAppServerOutputError,
  type CodexAppServerOutputLimits,
  codexAppServerMaximumProtectedValueCount,
  codexAppServerOutputLimits,
  createCodexAppServerOutputCollector,
} from "./codex-app-server-output.js";
import {
  type CodexAppServerTransport,
  type CodexAppServerTransportCloseResult,
  CodexAppServerTransportError,
  type CodexAppServerTransportLimits,
  type CodexAppServerTransportOptions,
  createCodexAppServerTransport,
} from "./codex-app-server-transport.js";
import { parseModelProtocolJson } from "./model-response-observer.js";
import {
  type ManagedProcess,
  ProcessExitedEventSchema,
  type ProcessTerminationReason,
} from "./process-host-protocol.js";

const maximumPromptBytes = 512 * 1024;

export type CodexAppServerTurnDriverErrorCode =
  | "INVALID_CONFIGURATION"
  | "ALREADY_STARTED"
  | "TRANSPORT_FAILED"
  | "OUTPUT_INVALID"
  | "CANCELLED"
  | "PROCESS_CLOSURE_INVALID"
  | "CLEANUP_UNCONFIRMED";

export class CodexAppServerTurnDriverError extends Error {
  constructor(readonly code: CodexAppServerTurnDriverErrorCode) {
    super("The owned Codex app-server turn could not be completed safely.");
    this.name = "CodexAppServerTurnDriverError";
  }
}

export interface CodexAppServerTurnDriverOptions {
  readonly process: ManagedProcess;
  readonly signal?: AbortSignal;
  readonly onActivity?: () => void;
  /** Optional audit observer; transport retains delivery timeout and stream ownership. */
  readonly onNotification?: CodexAppServerTransportOptions["onNotification"];
  readonly transportLimits?: Partial<CodexAppServerTransportLimits>;
}

export interface CodexAppServerTurnInput<T extends TSchema> {
  readonly threadId: string;
  readonly prompt: string;
  readonly authoritativeSchema: {
    readonly json: string;
    readonly digest: string;
    readonly resultSchema: T;
  };
  readonly protectedValues?: readonly string[];
  readonly outputLimits?: Partial<CodexAppServerOutputLimits>;
}

export interface CodexAppServerTurnDriver {
  /** The parent validates initialization, runtime policy and the thread before runTurn. */
  readonly transport: CodexAppServerTransport;
  /** Actual process completion and both stream ends, independently of turn validity. */
  readonly drained: Promise<void>;
  runTurn<T extends TSchema>(
    input: CodexAppServerTurnInput<T>,
  ): Promise<CodexAppServerOutput<Static<T>>>;
  abort(reason?: ProcessTerminationReason): Promise<void>;
}

function failure(code: CodexAppServerTurnDriverErrorCode): CodexAppServerTurnDriverError {
  return new CodexAppServerTurnDriverError(code);
}

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw failure("INVALID_CONFIGURATION");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    )
      throw failure("INVALID_CONFIGURATION");
    result[key] = descriptor.value;
  }
  return result;
}

/** Copies TypeBox data without executing accessors, while retaining its schema symbols. */
function snapshotSchema<T extends TSchema>(value: unknown): T {
  const ancestors = new Set<object>();
  let nodes = 0;
  let stringBytes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 64) throw failure("INVALID_CONFIGURATION");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string" && item.isWellFormed()) {
      stringBytes += Buffer.byteLength(item, "utf8");
      if (stringBytes > codexAppServerOutputLimits.maximumSchemaBytes)
        throw failure("INVALID_CONFIGURATION");
      return item;
    }
    if (typeof item !== "object" || item === null || types.isProxy(item) || ancestors.has(item))
      throw failure("INVALID_CONFIGURATION");
    const array = Array.isArray(item);
    if (
      array
        ? Object.getPrototypeOf(item) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      throw failure("INVALID_CONFIGURATION");
    const keys = Reflect.ownKeys(item).filter((key) => !array || key !== "length");
    if (
      keys.length > 100_000 ||
      (array && (keys.length !== item.length || keys.some((key, index) => key !== String(index))))
    )
      throw failure("INVALID_CONFIGURATION");
    const copy = array ? [] : Object.create(Object.getPrototypeOf(item));
    ancestors.add(item);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        !descriptor?.enumerable ||
        !("value" in descriptor) ||
        (typeof key === "symbol" && typeof descriptor.value !== "string")
      )
        throw failure("INVALID_CONFIGURATION");
      if (typeof key === "string") {
        if (!key.isWellFormed()) throw failure("INVALID_CONFIGURATION");
        stringBytes += Buffer.byteLength(key, "utf8");
        if (stringBytes > codexAppServerOutputLimits.maximumSchemaBytes)
          throw failure("INVALID_CONFIGURATION");
      }
      Object.defineProperty(copy, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    ancestors.delete(item);
    return Object.freeze(copy);
  };
  return visit(value, 0) as T;
}

function snapshotInput<T extends TSchema>(input: CodexAppServerTurnInput<T>) {
  const source = fields(input, [
    "threadId",
    "prompt",
    "authoritativeSchema",
    "protectedValues",
    "outputLimits",
  ]);
  const prompt = source.prompt;
  if (
    typeof prompt !== "string" ||
    !prompt.isWellFormed() ||
    !prompt.trim() ||
    Buffer.byteLength(prompt, "utf8") > maximumPromptBytes ||
    typeof source.threadId !== "string"
  )
    throw failure("INVALID_CONFIGURATION");
  const authority = fields(source.authoritativeSchema, ["json", "digest", "resultSchema"]);
  const json = authority.json;
  const digest = authority.digest;
  if (
    typeof json !== "string" ||
    Buffer.byteLength(json, "utf8") > codexAppServerOutputLimits.maximumSchemaBytes ||
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(digest) ||
    createHash("sha256").update(json, "utf8").digest("hex") !== digest
  )
    throw failure("INVALID_CONFIGURATION");
  const outputSchema = parseModelProtocolJson(json);
  if (outputSchema === null || typeof outputSchema !== "object" || Array.isArray(outputSchema))
    throw failure("INVALID_CONFIGURATION");
  const resultSchema = snapshotSchema<T>(authority.resultSchema);
  const schemaJson = parseModelProtocolJson(JSON.stringify(resultSchema));
  if (createCanonicalResult(schemaJson).json !== createCanonicalResult(outputSchema).json)
    throw failure("INVALID_CONFIGURATION");
  const protectedValues: string[] = [];
  if (source.protectedValues !== undefined) {
    const values = source.protectedValues;
    if (
      !Array.isArray(values) ||
      types.isProxy(values) ||
      Object.getPrototypeOf(values) !== Array.prototype ||
      values.length > codexAppServerMaximumProtectedValueCount ||
      Reflect.ownKeys(values).length !== values.length + 1
    )
      throw failure("INVALID_CONFIGURATION");
    for (let index = 0; index < values.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(values, index);
      if (
        !descriptor?.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        !descriptor.value.isWellFormed() ||
        Buffer.byteLength(descriptor.value, "utf8") > 32768
      )
        throw failure("INVALID_CONFIGURATION");
      protectedValues.push(descriptor.value);
    }
  }
  const limits =
    source.outputLimits === undefined
      ? undefined
      : (fields(
          source.outputLimits,
          Object.keys(codexAppServerOutputLimits),
        ) as Partial<CodexAppServerOutputLimits>);
  return {
    prompt,
    outputSchema,
    collector: createCodexAppServerOutputCollector({
      threadId: source.threadId,
      authoritativeSchema: { json, digest, resultSchema },
      protectedValues,
      ...(limits === undefined ? {} : { limits }),
    }),
    threadId: source.threadId,
  };
}

/** Owns one process's streams and one turn; policy acceptance belongs to the parent. */
export function createCodexAppServerTurnDriver(
  options: CodexAppServerTurnDriverOptions,
): CodexAppServerTurnDriver {
  let requestId: string;
  let processId: number;
  let streamId: string | undefined;
  let signal: AbortSignal | undefined;
  let activeCollector: CodexAppServerOutputCollector<unknown> | undefined;
  let collectorFailure: CodexAppServerOutputError | undefined;
  let claimed = false;
  let aborted = false;
  let cleanup: Promise<void> | undefined;
  let transport: CodexAppServerTransport;
  try {
    const captured = fields(options, [
      "process",
      "signal",
      "onActivity",
      "onNotification",
      "transportLimits",
    ]);
    if (captured.onNotification !== undefined && typeof captured.onNotification !== "function")
      throw failure("INVALID_CONFIGURATION");
    const observer = captured.onNotification as CodexAppServerTransportOptions["onNotification"];
    const managed = captured.process as ManagedProcess;
    requestId = managed.requestId;
    processId = managed.processId;
    streamId = managed.stdin?.streamId;
    signal = captured.signal as AbortSignal | undefined;
    transport = createCodexAppServerTransport({
      process: managed,
      ...(signal === undefined ? {} : { signal }),
      ...(captured.onActivity === undefined
        ? {}
        : { onActivity: captured.onActivity as () => void }),
      ...(captured.transportLimits === undefined
        ? {}
        : { limits: captured.transportLimits as Partial<CodexAppServerTransportLimits> }),
      onNotification: (notification, notificationSignal) => {
        if (activeCollector !== undefined) {
          try {
            activeCollector.observe(notification);
          } catch (cause) {
            // An early notification can fail before turn/start's write acknowledgement.
            // Retain its semantic classification when transport rejects the pending RPC.
            if (cause instanceof CodexAppServerOutputError) collectorFailure ??= cause;
            throw cause;
          }
        } else if (
          notification.method.startsWith("turn/") ||
          notification.method.startsWith("item/") ||
          notification.method === "error"
        )
          throw failure("OUTPUT_INVALID");
        return observer?.(notification, notificationSignal);
      },
    });
  } catch {
    throw failure("INVALID_CONFIGURATION");
  }

  const assertDrained = (result: CodexAppServerTransportCloseResult): void => {
    if (
      result.processRequestId !== requestId ||
      result.processId !== processId ||
      result.stdinStreamId !== streamId ||
      !Value.Check(ProcessExitedEventSchema, result.exit) ||
      result.exit.requestId !== requestId ||
      !result.stdoutEnded ||
      !result.stderrEnded
    )
      throw failure("CLEANUP_UNCONFIRMED");
  };
  const drained = transport.completed.then(assertDrained, () => {
    throw failure("CLEANUP_UNCONFIRMED");
  });
  void drained.catch(() => undefined);
  const abortAndDrain = (reason?: ProcessTerminationReason): Promise<void> => {
    cleanup ??= Promise.allSettled([transport.abort(reason), drained]).then((results) => {
      if (results.some((result) => result.status === "rejected"))
        throw failure("CLEANUP_UNCONFIRMED");
    });
    return cleanup;
  };
  const sanitized = (cause: unknown): CodexAppServerTurnDriverError => {
    if (aborted || signal?.aborted) return failure("CANCELLED");
    if (collectorFailure !== undefined) return failure("OUTPUT_INVALID");
    if (cause instanceof CodexAppServerTurnDriverError) return cause;
    if (cause instanceof CodexAppServerOutputError) return failure("OUTPUT_INVALID");
    if (
      cause instanceof CodexAppServerTransportError &&
      ["CANCELLED", "REQUEST_CANCELLED"].includes(cause.code)
    )
      return failure("CANCELLED");
    return failure("TRANSPORT_FAILED");
  };
  const execute = async <T extends TSchema>(
    prepared: ReturnType<typeof snapshotInput<T>>,
  ): Promise<CodexAppServerOutput<Static<T>>> => {
    try {
      if (aborted || signal?.aborted) throw failure("CANCELLED");
      const response = await transport.request("turn/start", {
        threadId: prepared.threadId,
        input: [{ type: "text", text: prepared.prompt }],
        outputSchema: prepared.outputSchema,
      });
      prepared.collector.bindTurnStart(response);
      await Promise.race([
        prepared.collector.terminal,
        transport.completed.then(() => {
          throw failure("TRANSPORT_FAILED");
        }),
      ]);
      const closed = await transport.close();
      await drained;
      if (aborted || signal?.aborted) throw failure("CANCELLED");
      if (
        closed.outcome !== "closed" ||
        closed.failureCode !== null ||
        closed.exit.exitCode !== 0 ||
        closed.exit.signal !== null ||
        closed.exit.outputTruncated ||
        !closed.notificationDeliveryComplete
      )
        throw failure("PROCESS_CLOSURE_INVALID");
      return prepared.collector.finish();
    } catch (cause) {
      await abortAndDrain();
      throw sanitized(cause);
    }
  };
  return Object.freeze({
    transport,
    drained,
    runTurn<T extends TSchema>(
      input: CodexAppServerTurnInput<T>,
    ): Promise<CodexAppServerOutput<Static<T>>> {
      if (claimed) return Promise.reject(failure("ALREADY_STARTED"));
      claimed = true;
      try {
        const prepared = snapshotInput(input);
        activeCollector = prepared.collector;
        return execute(prepared);
      } catch {
        return abortAndDrain().then(() => {
          throw failure("INVALID_CONFIGURATION");
        });
      }
    },
    abort(reason?: ProcessTerminationReason): Promise<void> {
      claimed = true;
      aborted = true;
      return abortAndDrain(reason);
    },
  });
}
