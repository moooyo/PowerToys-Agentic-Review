import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const sha256Pattern = /^[a-f0-9]{64}$/u;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const maximumJsonDepth = 64;
const maximumJsonNumberCharacters = 64;

export interface HostControlOpaqueJsonDescriptor {
  readonly base64Url: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export class HostControlOpaqueJsonError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_JSON_VALUE"
      | "BYTE_LIMIT_EXCEEDED"
      | "INVALID_DESCRIPTOR"
      | "DIGEST_MISMATCH"
      | "INVALID_UTF8"
      | "INVALID_JSON",
    message: string,
  ) {
    super(message);
    this.name = "HostControlOpaqueJsonError";
  }
}

/** Encodes the exact JSON.stringify UTF-8 bytes without applying local canonical JSON rules. */
export function encodeHostControlOpaqueJson(
  value: unknown,
  maximumBytes: number,
): Readonly<HostControlOpaqueJsonDescriptor> {
  assertMaximumBytes(maximumBytes);
  let document: string | undefined;
  try {
    document = JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === "number" && !Number.isFinite(candidate)) {
        throw new TypeError("JSON numbers must be finite.");
      }
      if (
        candidate === undefined ||
        typeof candidate === "bigint" ||
        typeof candidate === "function" ||
        typeof candidate === "symbol"
      ) {
        throw new TypeError("The value is not losslessly representable as JSON.");
      }
      return candidate;
    });
  } catch {
    throw new HostControlOpaqueJsonError(
      "INVALID_JSON_VALUE",
      "HostControl opaque JSON input is not exactly JSON-serializable.",
    );
  }
  if (document === undefined) {
    throw new HostControlOpaqueJsonError(
      "INVALID_JSON_VALUE",
      "HostControl opaque JSON input is not exactly JSON-serializable.",
    );
  }
  try {
    validateWorkerApiJsonDocument(document);
  } catch {
    throw new HostControlOpaqueJsonError(
      "INVALID_JSON_VALUE",
      "HostControl opaque JSON input is not a valid bounded JSON object.",
    );
  }

  const bytes = Buffer.from(document, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new HostControlOpaqueJsonError(
      "BYTE_LIMIT_EXCEEDED",
      "HostControl opaque JSON input exceeds its decoded byte limit.",
    );
  }
  return Object.freeze({
    base64Url: bytes.toString("base64url"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

/** Validates and decodes one descriptor before parsing its exact UTF-8 JSON document. */
export function decodeHostControlOpaqueJson(value: unknown, maximumBytes: number): unknown {
  assertMaximumBytes(maximumBytes);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["base64Url", "byteLength", "sha256"]) ||
    typeof value.base64Url !== "string" ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 1 ||
    (value.byteLength as number) > maximumBytes ||
    typeof value.sha256 !== "string" ||
    !sha256Pattern.test(value.sha256)
  ) {
    throw new HostControlOpaqueJsonError(
      "INVALID_DESCRIPTOR",
      "HostControl opaque JSON descriptor is invalid.",
    );
  }

  const byteLength = value.byteLength as number;
  const base64Url = value.base64Url;
  if (base64Url.length !== base64UrlLength(byteLength) || !base64UrlPattern.test(base64Url)) {
    throw new HostControlOpaqueJsonError(
      "INVALID_DESCRIPTOR",
      "HostControl opaque JSON descriptor encoding is invalid.",
    );
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64Url, "base64url");
  } catch {
    throw new HostControlOpaqueJsonError(
      "INVALID_DESCRIPTOR",
      "HostControl opaque JSON descriptor encoding is invalid.",
    );
  }
  if (bytes.byteLength !== byteLength || bytes.toString("base64url") !== base64Url) {
    throw new HostControlOpaqueJsonError(
      "INVALID_DESCRIPTOR",
      "HostControl opaque JSON descriptor encoding is invalid.",
    );
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== value.sha256) {
    throw new HostControlOpaqueJsonError(
      "DIGEST_MISMATCH",
      "HostControl opaque JSON descriptor digest does not match its bytes.",
    );
  }

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new HostControlOpaqueJsonError(
      "INVALID_JSON",
      "HostControl opaque JSON descriptor must not contain a byte-order mark.",
    );
  }

  let document: string;
  try {
    document = utf8Decoder.decode(bytes);
  } catch {
    throw new HostControlOpaqueJsonError(
      "INVALID_UTF8",
      "HostControl opaque JSON descriptor is not valid UTF-8.",
    );
  }
  try {
    validateWorkerApiJsonDocument(document);
    return JSON.parse(document) as unknown;
  } catch {
    throw new HostControlOpaqueJsonError(
      "INVALID_JSON",
      "HostControl opaque JSON descriptor is not a valid bounded JSON object.",
    );
  }
}

class WorkerApiJsonValidator {
  #offset = 0;

  public constructor(private readonly document: string) {}

  public validateRootObject(): void {
    this.#skipWhitespace();
    if (this.document[this.#offset] !== "{") throw new SyntaxError("JSON root is not an object.");
    this.#parseObject(0);
    this.#skipWhitespace();
    if (this.#offset !== this.document.length) throw new SyntaxError("JSON has trailing data.");
  }

  #parseValue(depth: number): void {
    if (depth > maximumJsonDepth) throw new SyntaxError("JSON nesting is too deep.");
    this.#skipWhitespace();
    switch (this.document[this.#offset]) {
      case "{":
        this.#parseObject(depth);
        return;
      case "[":
        this.#parseArray(depth);
        return;
      case '"':
        this.#parseString();
        return;
      case "t":
        this.#consumeLiteral("true");
        return;
      case "f":
        this.#consumeLiteral("false");
        return;
      case "n":
        this.#consumeLiteral("null");
        return;
      default:
        this.#parseNumber();
    }
  }

  #parseObject(depth: number): void {
    this.#consume("{");
    this.#skipWhitespace();
    if (this.document[this.#offset] === "}") {
      this.#offset += 1;
      return;
    }

    const keys = new Set<string>();
    while (true) {
      const key = this.#parseString();
      if (keys.has(key)) throw new SyntaxError("JSON object contains a duplicate key.");
      keys.add(key);
      this.#skipWhitespace();
      this.#consume(":");
      this.#parseValue(depth + 1);
      this.#skipWhitespace();
      const delimiter = this.document[this.#offset];
      if (delimiter === "}") {
        this.#offset += 1;
        return;
      }
      this.#consume(",");
      this.#skipWhitespace();
    }
  }

  #parseArray(depth: number): void {
    this.#consume("[");
    this.#skipWhitespace();
    if (this.document[this.#offset] === "]") {
      this.#offset += 1;
      return;
    }
    while (true) {
      this.#parseValue(depth + 1);
      this.#skipWhitespace();
      const delimiter = this.document[this.#offset];
      if (delimiter === "]") {
        this.#offset += 1;
        return;
      }
      this.#consume(",");
      this.#skipWhitespace();
    }
  }

  #parseString(): string {
    const start = this.#offset;
    this.#consume('"');
    while (this.#offset < this.document.length) {
      const codeUnit = this.document.charCodeAt(this.#offset);
      if (codeUnit === 0x22) {
        this.#offset += 1;
        return JSON.parse(this.document.slice(start, this.#offset)) as string;
      }
      if (codeUnit < 0x20) throw new SyntaxError("JSON string contains a control character.");
      if (codeUnit === 0x5c) {
        this.#parseEscape();
        continue;
      }
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const low = this.document.charCodeAt(this.#offset + 1);
        if (low < 0xdc00 || low > 0xdfff) {
          throw new SyntaxError("JSON string contains a lone surrogate.");
        }
        this.#offset += 2;
        continue;
      }
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        throw new SyntaxError("JSON string contains a lone surrogate.");
      }
      this.#offset += 1;
    }
    throw new SyntaxError("JSON string is incomplete.");
  }

  #parseEscape(): void {
    const escaped = this.document[this.#offset + 1];
    if (escaped === undefined) throw new SyntaxError("JSON escape is incomplete.");
    if ('"\\/bfnrt'.includes(escaped)) {
      this.#offset += 2;
      return;
    }
    if (escaped !== "u") throw new SyntaxError("JSON escape is invalid.");

    const codeUnit = this.#readHexCodeUnit(this.#offset + 2);
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new SyntaxError("JSON string contains a lone surrogate escape.");
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (this.document[this.#offset + 6] !== "\\" || this.document[this.#offset + 7] !== "u") {
        throw new SyntaxError("JSON string contains a lone surrogate escape.");
      }
      const low = this.#readHexCodeUnit(this.#offset + 8);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new SyntaxError("JSON string contains a lone surrogate escape.");
      }
      this.#offset += 12;
      return;
    }
    this.#offset += 6;
  }

  #readHexCodeUnit(offset: number): number {
    const value = this.document.slice(offset, offset + 4);
    if (!/^[0-9A-Fa-f]{4}$/u.test(value)) throw new SyntaxError("JSON Unicode escape is invalid.");
    return Number.parseInt(value, 16);
  }

  #parseNumber(): void {
    const start = this.#offset;
    if (this.document[this.#offset] === "-") this.#offset += 1;
    if (this.document[this.#offset] === "0") {
      this.#offset += 1;
    } else {
      this.#consumeDigits();
    }
    if (this.document[this.#offset] === ".") {
      this.#offset += 1;
      this.#consumeDigits();
    }
    const exponent = this.document[this.#offset];
    if (exponent === "e" || exponent === "E") {
      this.#offset += 1;
      const sign = this.document[this.#offset];
      if (sign === "+" || sign === "-") this.#offset += 1;
      this.#consumeDigits();
    }
    const lexeme = this.document.slice(start, this.#offset);
    if (
      lexeme.length === 0 ||
      lexeme.length > maximumJsonNumberCharacters ||
      !Number.isFinite(Number(lexeme))
    ) {
      throw new SyntaxError("JSON number is invalid.");
    }
  }

  #consumeDigits(): void {
    const start = this.#offset;
    while (/[0-9]/u.test(this.document[this.#offset] ?? "")) this.#offset += 1;
    if (start === this.#offset) throw new SyntaxError("JSON number requires a digit.");
  }

  #consumeLiteral(expected: string): void {
    if (!this.document.startsWith(expected, this.#offset)) {
      throw new SyntaxError("JSON literal is invalid.");
    }
    this.#offset += expected.length;
  }

  #consume(expected: string): void {
    if (this.document[this.#offset] !== expected) throw new SyntaxError("JSON syntax is invalid.");
    this.#offset += 1;
  }

  #skipWhitespace(): void {
    while (true) {
      const codeUnit = this.document.charCodeAt(this.#offset);
      if (codeUnit !== 0x09 && codeUnit !== 0x0a && codeUnit !== 0x0d && codeUnit !== 0x20) {
        return;
      }
      this.#offset += 1;
    }
  }
}

function validateWorkerApiJsonDocument(document: string): void {
  new WorkerApiJsonValidator(document).validateRootObject();
}

function base64UrlLength(byteLength: number): number {
  const completeTriples = Math.floor(byteLength / 3);
  const remainder = byteLength % 3;
  return completeTriples * 4 + (remainder === 0 ? 0 : remainder + 1);
}

function assertMaximumBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("HostControl opaque JSON maximum must be a positive safe integer.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
