import type { CliEngine } from "@agentic-review/codex";

/** Transport activity is not evidence that the analysis made meaningful progress. */
export interface ModelActivityObservation {
  readonly kind: "model" | "tool";
  readonly event: string;
}

export interface ModelActivityObserver {
  dispatched(): void;
  push(chunk: Uint8Array): void;
  finish(): void;
}

const codexItemEvents = new Set(["item.started", "item.updated", "item.completed"]);
const codexToolItems = new Set(["command_execution", "mcp_tool_call", "web_search", "file_change"]);
const copilotToolEvents = new Set([
  "tool.execution_start",
  "tool.execution_complete",
  "tool.execution_progress",
  "tool.execution_partial_result",
]);
const defaultMaximumLineBytes = 256 * 1024;
const maximumAllowedLineBytes = 1024 * 1024;

/** Observe complete stdout records without retaining commands, paths, or tool output. */
export function createModelActivityObserver(
  engine: CliEngine,
  onActivity?: (activity: ModelActivityObservation) => void,
  options: { readonly maximumLineBytes?: number } = {},
): ModelActivityObserver {
  const maximumLineBytes = options.maximumLineBytes ?? defaultMaximumLineBytes;
  if (
    !Number.isSafeInteger(maximumLineBytes) ||
    maximumLineBytes < 1 ||
    maximumLineBytes > maximumAllowedLineBytes
  )
    throw new RangeError("maximumLineBytes must be from 1 through 1048576.");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let lineBuffer: Uint8Array | undefined;
  let lineBytes = 0;
  let discardingLine = false;
  let firstLine = true;
  let finished = false;
  let dispatched = false;
  const notify = (observation: ModelActivityObservation): void => {
    try {
      void Promise.resolve(onActivity?.(Object.freeze(observation))).catch(() => undefined);
    } catch {
      // Telemetry cannot affect process ownership, output acceptance, or cleanup.
    }
  };
  const flushLine = (): void => {
    const wasFirstLine = firstLine;
    firstLine = false;
    try {
      if (discardingLine || lineBytes === 0 || lineBuffer === undefined) return;
      let line = decoder.decode(lineBuffer.subarray(0, lineBytes));
      if (wasFirstLine && line.startsWith("\uFEFF")) line = line.slice(1);
      if (!line.trim()) return;
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || typeof value.type !== "string") return;
      if (engine === "codex") {
        if (
          codexItemEvents.has(value.type) &&
          isRecord(value.item) &&
          typeof value.item.type === "string" &&
          codexToolItems.has(value.item.type)
        )
          notify({ kind: "tool", event: `${value.type}:${value.item.type}` });
      } else if (copilotToolEvents.has(value.type) && isRecord(value.data)) {
        notify({ kind: "tool", event: value.type });
      }
    } catch {
      // Malformed or invalid UTF-8 records do not establish activity. Resume at the next line.
    } finally {
      lineBytes = 0;
      discardingLine = false;
    }
  };
  return {
    dispatched() {
      if (dispatched || finished) return;
      dispatched = true;
      notify({ kind: "model", event: "model.dispatched" });
    },
    push(chunk) {
      if (finished || onActivity === undefined) return;
      let offset = 0;
      while (offset < chunk.byteLength) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.byteLength : newline;
        const byteLength = end - offset;
        if (!discardingLine) {
          if (byteLength > maximumLineBytes - lineBytes) {
            lineBytes = 0;
            discardingLine = true;
          } else if (byteLength > 0) {
            lineBuffer ??= new Uint8Array(maximumLineBytes);
            lineBuffer.set(chunk.subarray(offset, end), lineBytes);
            lineBytes += byteLength;
          }
        }
        if (newline === -1) break;
        flushLine();
        offset = newline + 1;
      }
    },
    finish() {
      if (finished) return;
      finished = true;
      if (lineBytes > 0 || discardingLine) flushLine();
      lineBuffer = undefined;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
