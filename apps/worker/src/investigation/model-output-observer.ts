import { createHmac, randomBytes } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { CliEngine } from "@agentic-review/codex";

/** Visible CLI output is an observation, never accepted analysis or execution evidence. */
export interface ModelOutputObservation {
  readonly itemId: string;
  readonly kind: "assistant" | "tool" | "system" | "gap";
  readonly operation: "append" | "replace";
  readonly text: string;
  readonly command?: string;
  readonly result?: string;
  readonly status?: "started" | "completed" | "failed" | "cancelled" | "info";
}

export interface ModelOutputObserver {
  push(chunk: Uint8Array): void;
  finish(): void;
  incomplete(): void;
}

const codexItemEvents = new Set(["item.started", "item.updated", "item.completed"]);
const copilotToolEvents = new Set([
  "tool.execution_start",
  "tool.execution_complete",
  "tool.execution_progress",
  "tool.execution_partial_result",
]);
const codexActivityLabels: Readonly<Record<string, string>> = {
  mcp_tool_call: "MCP tool activity",
  file_change: "File change activity",
  web_search: "Web search activity",
};
const defaultMaximumLineBytes = 256 * 1024;
const maximumAllowedLineBytes = 1024 * 1024;
const maximumIdentityBytes = 512;
const maximumToolLabels = 1024;
const maximumToolRequests = 128;
const maximumTextBytes = 8 * 1024;
const maximumCommandBytes = 4 * 1024;
const maximumObservationBytes = 12 * 1024;
const truncationMarker = "\n[Output truncated]";
const sensitiveOutputMarker = "[Environment or authentication output omitted]";
const unsafeControlCharacters =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip unsafe terminal and bidirectional controls from visible output.
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const credentialHeader =
  /(\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)[^\r\n]*/giu;

/** Sanitize complete allowlisted fields before either truncation or persistence. */
export function sanitizeModelOutputText(
  text: string,
  protectedValues: readonly string[] = [],
): string {
  const secrets = [...new Set(protectedValues.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  const replaceSecrets = (value: string): string => {
    let result = value;
    for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
    return result;
  };
  // Strip controls before the second pass so they cannot split a known credential.
  let redacted = replaceSecrets(
    stripVTControlCharacters(replaceSecrets(text))
      .replace(unsafeControlCharacters, "")
      .replace(/\r\n?/gu, "\n"),
  );
  if (isSensitiveEnvelope(redacted)) return sensitiveOutputMarker;
  redacted = redacted
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(credentialHeader, "$1[REDACTED]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|arw1_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gu,
      "[REDACTED]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/giu, "[REDACTED AUTHORIZATION]")
    .replace(/\bhttps?:\/\/[^\s<>"'`]+/giu, redactCapabilityUrl)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(
      /(["']?\b[A-Za-z0-9_-]{0,128}(?:token|secret|password|passwd|api[_-]?key|authorization|credential)[A-Za-z0-9_-]{0,128}["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(
      /(--?(?:token|secret|password|passwd|api[_-]?key|authorization|credential)\s+)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    );
  return redacted;
}

/** Parse bounded stdout records synchronously; observers cannot interrupt stdout draining. */
export function createModelOutputObserver(
  engine: CliEngine,
  onOutput?: (output: ModelOutputObservation) => void,
  options: {
    readonly maximumLineBytes?: number;
    readonly protectedValues?: readonly string[];
  } = {},
): ModelOutputObserver {
  const maximumLineBytes = options.maximumLineBytes ?? defaultMaximumLineBytes;
  if (
    !Number.isSafeInteger(maximumLineBytes) ||
    maximumLineBytes < 1 ||
    maximumLineBytes > maximumAllowedLineBytes
  )
    throw new RangeError("maximumLineBytes must be from 1 through 1048576.");
  const protectedValues = [...(options.protectedValues ?? [])];
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  // A keyed identity avoids retaining raw provider IDs or an unbounded correlation map.
  const identityKey = randomBytes(32);
  const identityPrefix = createHmac("sha256", identityKey)
    .update("anonymous-output")
    .digest("hex")
    .slice(0, 16);
  const toolLabels = new Map<string, string>();
  let nextAnonymousId = 0;
  let lineBuffer: Uint8Array | undefined;
  let lineBytes = 0;
  let discardingLine = false;
  let firstLine = true;
  let finished = false;
  let incompleteReported = false;
  let toolLabelLimitReported = false;

  const notify = (observation: ModelOutputObservation): void => {
    try {
      void Promise.resolve(onOutput?.(Object.freeze(observation))).catch(() => undefined);
    } catch {
      // Output observers cannot affect process ownership, accepted results, or cleanup.
    }
  };
  const gap = (reason: string): void => {
    notify({
      itemId: `output-gap-${identityPrefix}-${++nextAnonymousId}`,
      kind: "gap",
      operation: "append",
      text: `Output omitted: ${reason}.`,
      status: "info",
    });
  };
  const identity = (
    family: string,
    providerId: unknown,
  ): Pick<ModelOutputObservation, "itemId" | "operation"> | undefined => {
    if (providerId === undefined || providerId === null)
      return { itemId: `output-item-${identityPrefix}-${++nextAnonymousId}`, operation: "append" };
    if (
      typeof providerId !== "string" ||
      providerId.length === 0 ||
      Buffer.byteLength(providerId, "utf8") > maximumIdentityBytes
    ) {
      gap("1 record with an invalid item identity");
      return undefined;
    }
    return {
      itemId: `output-${createHmac("sha256", identityKey)
        .update(`${engine}:${family}:`)
        .update(providerId)
        .digest("hex")
        .slice(0, 32)}`,
      operation: "replace",
    };
  };
  const emit = (observation: ModelOutputObservation): void => {
    let remainingBytes = maximumObservationBytes;
    let truncated = false;
    const field = (value: string, maximumBytes: number): string => {
      const sanitized = sanitizeModelOutputText(value, protectedValues);
      const bounded = boundText(sanitized, Math.min(maximumBytes, remainingBytes));
      remainingBytes -= Buffer.byteLength(bounded.text, "utf8");
      truncated ||= bounded.truncated;
      return bounded.text;
    };
    const text = field(observation.text, maximumTextBytes);
    const command =
      observation.command === undefined
        ? undefined
        : field(observation.command, maximumCommandBytes);
    const result =
      observation.result === undefined ? undefined : field(observation.result, maximumTextBytes);
    notify({
      itemId: observation.itemId,
      kind: observation.kind,
      operation: observation.operation,
      text,
      ...(command === undefined ? {} : { command }),
      ...(result === undefined ? {} : { result }),
      ...(observation.status === undefined ? {} : { status: observation.status }),
    });
    if (truncated) gap("part of 1 record exceeded the visible output limit");
  };
  const codex = (event: Record<string, unknown>): void => {
    if (!codexItemEvents.has(String(event.type))) return;
    if (!isRecord(event.item)) {
      gap("1 malformed visible item record");
      return;
    }
    const item = event.item;
    const itemType = item.type;
    if (typeof itemType !== "string") {
      gap("1 malformed visible item record");
      return;
    }
    if (item.agentId != null || item.parentToolCallId != null) return;
    if (itemType === "agent_message") {
      // Growing snapshots can expose a protected value's prefix before it is complete.
      if (event.type !== "item.completed") return;
      if (typeof item.text !== "string") {
        gap("1 assistant record without supported text");
        return;
      }
      if (!item.text.trim()) return;
      const itemIdentity = identity("assistant", item.id);
      if (itemIdentity === undefined) return;
      emit({
        ...itemIdentity,
        kind: "assistant",
        text: item.text,
        status: "completed",
      });
      return;
    }
    if (itemType === "command_execution") {
      const itemIdentity = identity("command", item.id);
      if (itemIdentity === undefined) return;
      const command =
        typeof item.command === "string" && item.command.trim() ? item.command : undefined;
      const sensitive = command !== undefined && isSensitiveCommand(command);
      const result =
        command !== undefined &&
        event.type === "item.completed" &&
        typeof item.aggregated_output === "string"
          ? item.aggregated_output
          : undefined;
      emit({
        ...itemIdentity,
        kind: "tool",
        text: sensitive ? sensitiveOutputMarker : "Command execution",
        ...(!sensitive && command !== undefined ? { command } : {}),
        ...(!sensitive && result !== undefined ? { result } : {}),
        status: codexCommandStatus(event.type, item),
      });
      if (
        command === undefined &&
        event.type === "item.completed" &&
        typeof item.aggregated_output === "string"
      )
        gap("1 command result without a supported command");
      return;
    }
    // These item families prove activity; their unverified payload schemas stay private.
    const label = Object.hasOwn(codexActivityLabels, itemType)
      ? codexActivityLabels[itemType]
      : undefined;
    if (label === undefined) return;
    const itemIdentity = identity(itemType, item.id);
    if (itemIdentity === undefined) return;
    emit({
      ...itemIdentity,
      kind: "tool",
      text: label,
      status: event.type === "item.completed" ? "info" : "started",
    });
  };
  const copilot = (event: Record<string, unknown>): void => {
    if (event.type !== "assistant.message" && !copilotToolEvents.has(String(event.type))) return;
    if (!isRecord(event.data)) {
      gap("1 malformed visible event record");
      return;
    }
    const data = event.data;
    if (data.agentId != null || data.parentToolCallId != null) return;
    if (event.type === "assistant.message") {
      if (
        typeof data.content !== "string" ||
        (data.toolRequests !== undefined && !Array.isArray(data.toolRequests))
      ) {
        gap("1 assistant record without supported text");
        return;
      }
      if (data.content.trim()) {
        const itemIdentity = identity("assistant", data.messageId ?? event.id);
        if (itemIdentity !== undefined)
          emit({
            ...itemIdentity,
            kind: "assistant",
            text: data.content,
            status:
              Array.isArray(data.toolRequests) && data.toolRequests.length > 0
                ? "started"
                : "completed",
          });
      }
      if (Array.isArray(data.toolRequests)) {
        for (const request of data.toolRequests.slice(0, maximumToolRequests)) {
          if (
            !isRecord(request) ||
            typeof request.name !== "string" ||
            !request.name.trim() ||
            request.toolCallId == null
          )
            continue;
          const toolIdentity = identity("tool", request.toolCallId);
          if (toolIdentity === undefined) continue;
          const label = boundText(sanitizeModelOutputText(request.name, protectedValues), 128);
          if (label.truncated) gap("part of 1 tool name exceeded the visible output limit");
          if (toolLabels.has(toolIdentity.itemId) || toolLabels.size < maximumToolLabels)
            toolLabels.set(toolIdentity.itemId, label.text);
          else if (!toolLabelLimitReported) {
            toolLabelLimitReported = true;
            gap("additional tool names exceeded the correlation limit");
          }
          emit({
            ...toolIdentity,
            kind: "tool",
            text: `Tool requested: ${label.text}`,
            status: "info",
          });
        }
        if (data.toolRequests.length > maximumToolRequests)
          gap("part of 1 tool request collection exceeded the visible output limit");
      }
      return;
    }
    if (data.toolCallId == null) {
      gap("1 tool record without a correlation identity");
      return;
    }
    const itemIdentity = identity("tool", data.toolCallId);
    if (itemIdentity === undefined) return;
    const completed = event.type === "tool.execution_complete";
    const toolLabel = toolLabels.get(itemIdentity.itemId);
    const result =
      completed && isRecord(data.result) && typeof data.result.content === "string"
        ? data.result.content
        : undefined;
    emit({
      ...itemIdentity,
      kind: "tool",
      text: completed
        ? `Tool execution completed${toolLabel === undefined ? "" : `: ${toolLabel}`} (outcome unavailable)`
        : `Tool execution${toolLabel === undefined ? "" : `: ${toolLabel}`}`,
      ...(result === undefined ? {} : { result }),
      // Completion alone does not establish success; no unverified status fields are inferred.
      status: completed ? "info" : "started",
    });
  };
  const flushLine = (): void => {
    const wasFirstLine = firstLine;
    firstLine = false;
    try {
      if (discardingLine) {
        gap("1 oversized stdout record");
        return;
      }
      if (lineBytes === 0 || lineBuffer === undefined) return;
      let line: string;
      try {
        line = decoder.decode(lineBuffer.subarray(0, lineBytes));
      } catch {
        gap("1 invalid UTF-8 stdout record");
        return;
      }
      if (wasFirstLine && line.startsWith("\uFEFF")) line = line.slice(1);
      if (!line.trim()) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        gap("1 malformed JSON stdout record");
        return;
      }
      if (!isRecord(value) || typeof value.type !== "string") {
        gap("1 malformed provider event record");
        return;
      }
      if (value.agentId != null || value.parentToolCallId != null) return;
      if (engine === "codex") codex(value);
      else copilot(value);
    } catch {
      gap("1 unsupported visible output record");
    } finally {
      lineBytes = 0;
      discardingLine = false;
    }
  };
  return {
    push(chunk) {
      if (finished || onOutput === undefined) return;
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
      toolLabels.clear();
      identityKey.fill(0);
    },
    incomplete() {
      if (incompleteReported) return;
      incompleteReported = true;
      gap("stdout capture did not finish completely");
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function codexCommandStatus(
  eventType: unknown,
  item: Record<string, unknown>,
): NonNullable<ModelOutputObservation["status"]> {
  if (eventType !== "item.completed") return "started";
  if (item.status === "failed") return "failed";
  if (
    item.status !== "completed" ||
    typeof item.exit_code !== "number" ||
    !Number.isInteger(item.exit_code) ||
    item.exit_code < -2_147_483_648 ||
    item.exit_code > 4_294_967_295
  )
    return "info";
  return item.exit_code === 0 ? "completed" : "failed";
}

function boundText(text: string, maximumBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maximumBytes) return { text, truncated: false };
  const marker = maximumBytes >= Buffer.byteLength(truncationMarker) ? truncationMarker : "";
  let end = maximumBytes - Buffer.byteLength(marker);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8") + marker, truncated: true };
}

function redactCapabilityUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /\/(?:mcp|tools?|capabilit(?:y|ies))(?:\/|$)|\/api\/worker(?:\/|$)/iu.test(url.pathname)
    )
      return "[REDACTED URL]";
  } catch {
    return "[REDACTED URL]";
  }
  return value;
}

function isSensitiveCommand(command: string): boolean {
  const plain = stripVTControlCharacters(command).replace(unsafeControlCharacters, "");
  return /(?:^|[;&|]\s*)(?:printenv|env)(?:\s|$)|\b(?:Get-ChildItem|Get-Item|gci|gi|dir|ls)\s+(?:-Path\s+)?env:|\[Environment\]::GetEnvironmentVariables\s*\(|\bcmd(?:\.exe)?\s+\/c\s+["']?set\b|\b(?:Get-Content|cat|type)\b[^\r\n]*(?:auth\.json|credentials(?:\.json)?|\.npmrc|id_(?:rsa|ed25519))/iu.test(
    plain,
  );
}

function isSensitiveEnvelope(text: string): boolean {
  if (
    /["'](?:leaseToken|lease_token)["']\s*:/iu.test(text) ||
    /["']tokens["']\s*:\s*\{[^}]*["'](?:access_token|refresh_token)["']\s*:/iu.test(text) ||
    /["'](?:env|environment)["']\s*:\s*\{/iu.test(text) ||
    /^\s*Name\s+Value\s*$/imu.test(text) ||
    /^\s*Name\s*:\s*(?:PATH|HOME|USERPROFILE|APPDATA|[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY))\s*$/imu.test(
      text,
    )
  )
    return true;
  const environmentKeys =
    /["'](?:PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT)["']\s*:/giu;
  let environmentKeyCount = 0;
  while (environmentKeys.exec(text) !== null) {
    if (++environmentKeyCount >= 2) return true;
  }
  const assignments = /^\s*(?:export\s+)?[A-Z][A-Z0-9_]{1,127}=/gmu;
  let count = 0;
  while (assignments.exec(text) !== null) {
    if (++count >= 3) return true;
  }
  return false;
}
