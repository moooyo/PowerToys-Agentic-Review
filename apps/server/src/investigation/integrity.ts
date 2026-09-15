import { createHash, timingSafeEqual } from "node:crypto";
import { requireCondition } from "./errors.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    requireCondition(encoded !== undefined, 400, "invalid_json", "The payload must be JSON.");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export function contentDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function parseCursor(cursor: string | undefined, reportId: string, digest: string): number {
  if (cursor === undefined) return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    requireCondition(
      typeof parsed === "object" &&
        parsed !== null &&
        "reportId" in parsed &&
        "digest" in parsed &&
        "offset" in parsed &&
        parsed.reportId === reportId &&
        parsed.digest === digest &&
        Number.isSafeInteger(parsed.offset) &&
        Number(parsed.offset) >= 0,
      400,
      "invalid_cursor",
      "The findings cursor does not match this sealed report.",
    );
    return Number(parsed.offset);
  } catch {
    requireCondition(false, 400, "invalid_cursor", "The findings cursor is invalid.");
  }
}

export function encodeCursor(reportId: string, digest: string, offset: number): string {
  return Buffer.from(JSON.stringify({ reportId, digest, offset })).toString("base64url");
}
