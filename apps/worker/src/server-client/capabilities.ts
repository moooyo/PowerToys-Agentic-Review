import { createHash } from "node:crypto";
import type { WorkerCapabilities } from "@agentic-review/contracts";

export function digestCapabilities(capabilities: WorkerCapabilities): string {
  return createHash("sha256").update(stableStringify(capabilities), "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key] ?? null)}`)
    .join(",")}}`;
}
