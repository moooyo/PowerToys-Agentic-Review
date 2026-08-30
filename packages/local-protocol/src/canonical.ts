import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const LOCAL_CANONICAL_JSON_VERSION = 1 as const;
export const LOCAL_CANONICAL_JSON_MAXIMUM_DEPTH = 64;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class CanonicalJsonError extends Error {
  public constructor(
    public readonly code:
      | "CANONICAL_JSON_INVALID_UTF8"
      | "CANONICAL_JSON_INVALID_SYNTAX"
      | "CANONICAL_JSON_NOT_CANONICAL"
      | "CANONICAL_JSON_UNSUPPORTED_VALUE"
      | "CANONICAL_JSON_LIMIT_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

export interface CanonicalJsonDocument {
  readonly json: string;
  readonly sha256: string;
}

export function serializeCanonicalJson(value: unknown): string {
  return serializeValue(value, new WeakSet<object>(), 0);
}

export function createCanonicalJsonDocument(value: unknown): Readonly<CanonicalJsonDocument> {
  const json = serializeCanonicalJson(value);
  return Object.freeze({
    json,
    sha256: createHash("sha256").update(json, "utf8").digest("hex"),
  });
}

export function digestCanonicalJson(value: unknown): string {
  return createCanonicalJsonDocument(value).sha256;
}

export function parseCanonicalJson(bytes: Uint8Array, maximumBytes: number): unknown {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError("maximumBytes must be a positive safe integer");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_LIMIT_EXCEEDED",
      "Canonical JSON payload size is outside the supported range.",
    );
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_INVALID_UTF8",
      "Canonical JSON payload must not contain a byte-order mark.",
    );
  }

  let text: string;
  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_INVALID_UTF8",
      "Canonical JSON payload is not valid UTF-8.",
    );
  }

  if (text.charCodeAt(0) === 0xfeff) {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_INVALID_UTF8",
      "Canonical JSON payload must not contain a byte-order mark.",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_INVALID_SYNTAX",
      "Canonical JSON payload is not valid JSON.",
    );
  }

  let canonical: string;
  try {
    canonical = serializeCanonicalJson(value);
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw error;
    throw new CanonicalJsonError(
      "CANONICAL_JSON_UNSUPPORTED_VALUE",
      "Canonical JSON payload contains an unsupported value.",
    );
  }
  if (canonical !== text) {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_NOT_CANONICAL",
      "JSON payload is not in the required canonical representation.",
    );
  }
  return value;
}

function serializeValue(value: unknown, ancestors: WeakSet<object>, depth: number): string {
  if (depth > LOCAL_CANONICAL_JSON_MAXIMUM_DEPTH) {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_LIMIT_EXCEEDED",
      `Canonical JSON must not exceed ${LOCAL_CANONICAL_JSON_MAXIMUM_DEPTH} nested levels.`,
    );
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalJsonError(
        "CANONICAL_JSON_UNSUPPORTED_VALUE",
        "Canonical JSON numbers must be safe integers.",
      );
    }
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
    return quoteJsonString(value);
  }
  if (typeof value !== "object") {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_UNSUPPORTED_VALUE",
      `Canonical JSON does not support ${typeof value} values.`,
    );
  }
  if (ancestors.has(value)) {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_UNSUPPORTED_VALUE",
      "Canonical JSON values must not contain cycles.",
    );
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownNames = Object.getOwnPropertyNames(value);
      if (
        ownNames.length !== value.length + 1 ||
        ownNames.some((name) => name !== "length" && !isCanonicalArrayIndex(name, value.length))
      ) {
        throw new CanonicalJsonError(
          "CANONICAL_JSON_UNSUPPORTED_VALUE",
          "Canonical JSON arrays must not contain custom properties.",
        );
      }
      const elements: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new CanonicalJsonError(
            "CANONICAL_JSON_UNSUPPORTED_VALUE",
            "Canonical JSON arrays must contain only enumerable data elements.",
          );
        }
        elements.push(serializeValue(descriptor.value, ancestors, depth + 1));
      }
      return `[${elements.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(
        "CANONICAL_JSON_UNSUPPORTED_VALUE",
        "Canonical JSON objects must be plain objects.",
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalJsonError(
        "CANONICAL_JSON_UNSUPPORTED_VALUE",
        "Canonical JSON objects must not contain symbol properties.",
      );
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (Object.getOwnPropertyNames(value).length !== keys.length) {
      throw new CanonicalJsonError(
        "CANONICAL_JSON_UNSUPPORTED_VALUE",
        "Canonical JSON objects must not contain hidden properties.",
      );
    }
    const members: string[] = [];
    for (const key of keys) {
      assertWellFormedUnicode(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new CanonicalJsonError(
          "CANONICAL_JSON_UNSUPPORTED_VALUE",
          "Canonical JSON objects must contain only enumerable data properties.",
        );
      }
      members.push(
        `${quoteJsonString(key)}:${serializeValue(descriptor.value, ancestors, depth + 1)}`,
      );
    }
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function isCanonicalArrayIndex(name: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(name)) return false;
  const index = Number(name);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === name;
}

function quoteJsonString(value: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new CanonicalJsonError(
      "CANONICAL_JSON_UNSUPPORTED_VALUE",
      "Canonical JSON string serialization failed.",
    );
  }
  return serialized;
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalJsonError(
          "CANONICAL_JSON_UNSUPPORTED_VALUE",
          "Canonical JSON strings must contain valid Unicode scalar values.",
        );
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new CanonicalJsonError(
        "CANONICAL_JSON_UNSUPPORTED_VALUE",
        "Canonical JSON strings must contain valid Unicode scalar values.",
      );
    }
  }
}
