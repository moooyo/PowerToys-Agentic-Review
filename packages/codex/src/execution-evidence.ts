import type { ReviewExecutionEvidence } from "@agentic-review/contracts";
import type { CodexJsonlRecord } from "./jsonl.js";

const maximumCommands = 128;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Diagnostics must strip non-printing control characters.
const diagnosticControlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const credentialHeader =
  /(["'])((?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)(?:\\.|(?!\1)[^\r\n])*\1|(\b(?:authorization|proxy-authorization|cookie|set-cookie)(?:["'])?\s*[:=]\s*)[^\r\n]*/giu;

/** Retains CLI observations, not a claim that the commands sufficiently tested the revision. */
export function collectCommandEvidence(
  records: readonly CodexJsonlRecord[],
  redact: (text: string) => string,
): Pick<ReviewExecutionEvidence, "commands" | "commandCapture"> {
  const commands = new Map<string, ReviewExecutionEvidence["commands"][number]>();
  let incomplete = false;
  for (const record of records) {
    if (record.kind === "parse_issue") {
      incomplete = true;
      continue;
    }
    if (!record.type.startsWith("item.")) continue;
    const item = record.value.item;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      incomplete = true;
      continue;
    }
    const value = item as Record<string, unknown>;
    if (value.type !== "command_execution") {
      if (
        ![
          "agent_message",
          "reasoning",
          "file_change",
          "mcp_tool_call",
          "web_search",
          "plan",
          "todo_list",
          "error",
        ].includes(String(value.type))
      )
        incomplete = true;
      continue;
    }
    const id = value.id;
    const command = value.command;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 128 ||
      typeof command !== "string" ||
      command.length === 0
    ) {
      incomplete = true;
      continue;
    }
    if (!commands.has(id) && commands.size >= maximumCommands) {
      incomplete = true;
      continue;
    }
    const prior = commands.get(id);
    if (command.length > 2_048) incomplete = true;
    const sanitizedCommand = redact(command);
    if (prior !== undefined && prior.command !== sanitizedCommand) incomplete = true;
    const exitCode =
      record.type === "item.completed" &&
      typeof value.exit_code === "number" &&
      Number.isInteger(value.exit_code) &&
      value.exit_code >= -2_147_483_648 &&
      value.exit_code <= 4_294_967_295
        ? value.exit_code
        : null;
    const completed =
      record.type === "item.completed" &&
      (value.status === "completed" || value.status === "failed");
    if (record.type === "item.completed" && (!completed || exitCode === null)) incomplete = true;
    commands.set(id, {
      itemId: redact(id).slice(0, 128),
      command: sanitizedCommand,
      status:
        completed && exitCode !== null
          ? value.status === "failed" || exitCode !== 0
            ? "failed"
            : "completed"
          : "unknown",
      exitCode,
    });
  }
  if ([...commands.values()].some((command) => command.status === "unknown")) incomplete = true;
  return {
    commands: [...commands.values()],
    commandCapture: incomplete ? "incomplete" : "complete",
  };
}

/** Redacts known credentials before bounding, then common secret forms without retaining output. */
export function redactExecutionText(text: string, secrets: readonly string[] = []): string {
  let redacted = text;
  for (const secret of [...secrets]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return (
    redacted
      .replace(
        credentialHeader,
        (
          _match,
          quote: string | undefined,
          quotedPrefix: string | undefined,
          rawPrefix: string | undefined,
        ) =>
          quote === undefined
            ? `${rawPrefix}[REDACTED]`
            : `${quote}${quotedPrefix}[REDACTED]${quote}`,
      )
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu,
        "[REDACTED PRIVATE KEY]",
      )
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|arw1_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gu,
        "[REDACTED]",
      )
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/giu, "[REDACTED AUTHORIZATION]")
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[REDACTED]@")
      .replace(
        /((?:["']?)(?:[A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|authorization|credential)[A-Za-z0-9_-]*)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
        "$1[REDACTED]",
      )
      .replace(
        /(--?(?:token|secret|password|passwd|api[_-]?key|authorization|credential)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
        "$1[REDACTED]",
      )
      .replace(diagnosticControlCharacters, " ")
      .slice(0, 2_048) || "[empty diagnostic]"
  );
}
