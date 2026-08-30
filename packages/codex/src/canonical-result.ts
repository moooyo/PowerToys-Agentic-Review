import { createHash } from "node:crypto";

export interface CanonicalResult {
  readonly json: string;
  readonly sha256: string;
}

const maximumCanonicalDepth = 128;

export function canonicalizeResult(value: unknown): string {
  return serializeCanonicalValue(value, new WeakSet<object>(), 0);
}

export function computeCanonicalResultDigest(value: unknown): string {
  return createHash("sha256").update(canonicalizeResult(value), "utf8").digest("hex");
}

export function createCanonicalResult(value: unknown): CanonicalResult {
  const json = canonicalizeResult(value);
  return {
    json,
    sha256: createHash("sha256").update(json, "utf8").digest("hex"),
  };
}

function serializeCanonicalValue(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): string {
  if (depth > maximumCanonicalDepth) {
    throw new RangeError(`Canonical JSON must not exceed ${maximumCanonicalDepth} nested levels`);
  }

  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON numbers must be finite");
    }
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
    return quoteJsonString(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Unsupported canonical JSON value type: ${typeof value}`);
  }

  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON values must not contain cycles");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const elements: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Canonical JSON arrays must not contain holes");
        }
        elements.push(serializeCanonicalValue(value[index], ancestors, depth + 1));
      }
      return `[${elements.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON objects must be plain objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Canonical JSON objects must not contain symbol properties");
    }

    const objectValue = value as Record<string, unknown>;
    const keys = Object.keys(objectValue).sort();
    const members = keys.map((key) => {
      assertWellFormedUnicode(key);
      return `${quoteJsonString(key)}:${serializeCanonicalValue(
        objectValue[key],
        ancestors,
        depth + 1,
      )}`;
    });
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function quoteJsonString(value: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Canonical JSON string serialization failed");
  }
  return serialized;
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Canonical JSON strings must contain valid Unicode scalar values");
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Canonical JSON strings must contain valid Unicode scalar values");
    }
  }
}
