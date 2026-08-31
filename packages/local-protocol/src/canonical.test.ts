import { describe, expect, it } from "vitest";

import {
  CanonicalJsonError,
  createCanonicalJsonDocument,
  deepFreezeJson,
  parseCanonicalJson,
  serializeCanonicalJson,
} from "./canonical.js";

describe("canonical JSON", () => {
  it("sorts object keys and produces a stable digest", () => {
    const value = { z: [true, null, 7], a: { two: 2, one: 1 } };
    expect(serializeCanonicalJson(value)).toBe('{"a":{"one":1,"two":2},"z":[true,null,7]}');
    expect(createCanonicalJsonDocument(value)).toEqual({
      json: '{"a":{"one":1,"two":2},"z":[true,null,7]}',
      sha256: "3e1bff36b8409f2053561f066de744d96e635d1f73d52534c1cd97e77987e5f2",
    });
  });

  it("deeply freezes descendants even when the parent was already frozen", () => {
    const child = { values: [1, 2, 3] };
    const parent = Object.freeze({ child });
    const frozen = deepFreezeJson(parent);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.child)).toBe(true);
    expect(Object.isFrozen(frozen.child.values)).toBe(true);
    expect(() => {
      (frozen.child.values as unknown as number[]).push(4);
    }).toThrow();
  });

  it("parses only exact canonical UTF-8", () => {
    const canonical = Buffer.from('{"a":1,"b":2}', "utf8");
    expect(parseCanonicalJson(canonical, 100)).toEqual({ a: 1, b: 2 });

    for (const text of [
      '{"b":2,"a":1}',
      '{ "a":1,"b":2}',
      '{"a":1,"a":1,"b":2}',
      '{"a":1e0,"b":2}',
      '{"a":-0,"b":2}',
      '{"a":1,"b":2}\n',
    ]) {
      expect(() => parseCanonicalJson(Buffer.from(text, "utf8"), 100)).toThrow(CanonicalJsonError);
    }
  });

  it("rejects invalid UTF-8, BOM, unsafe numbers, invalid Unicode, and excess depth", () => {
    expect(() => parseCanonicalJson(Buffer.from([0xc3, 0x28]), 100)).toThrowError(
      expect.objectContaining({ code: "CANONICAL_JSON_INVALID_UTF8" }),
    );
    expect(() => parseCanonicalJson(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), 100)).toThrowError(
      expect.objectContaining({ code: "CANONICAL_JSON_INVALID_UTF8" }),
    );
    expect(() => serializeCanonicalJson(Number.MAX_SAFE_INTEGER + 1)).toThrow(CanonicalJsonError);
    expect(() => serializeCanonicalJson("\ud800")).toThrow(CanonicalJsonError);

    let nested: unknown = null;
    for (let index = 0; index < 66; index += 1) nested = [nested];
    expect(() => serializeCanonicalJson(nested)).toThrowError(
      expect.objectContaining({ code: "CANONICAL_JSON_LIMIT_EXCEEDED" }),
    );
  });

  it("rejects unsupported JavaScript values and byte-size violations", () => {
    expect(() => serializeCanonicalJson({ missing: undefined })).toThrow(CanonicalJsonError);
    expect(() => serializeCanonicalJson(new Date())).toThrow(CanonicalJsonError);
    expect(() => parseCanonicalJson(Buffer.from("{}"), 1)).toThrowError(
      expect.objectContaining({ code: "CANONICAL_JSON_LIMIT_EXCEEDED" }),
    );
    expect(() => parseCanonicalJson(Buffer.alloc(0), 1)).toThrowError(
      expect.objectContaining({ code: "CANONICAL_JSON_LIMIT_EXCEEDED" }),
    );

    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "secret", { enumerable: true, get: () => "value" });
    expect(() => serializeCanonicalJson(accessor)).toThrow(CanonicalJsonError);
    const hidden = { visible: true } as Record<string, unknown>;
    Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
    expect(() => serializeCanonicalJson(hidden)).toThrow(CanonicalJsonError);
    const decoratedArray = [1] as number[] & { marker?: string };
    decoratedArray.marker = "not-json";
    expect(() => serializeCanonicalJson(decoratedArray)).toThrow(CanonicalJsonError);
  });
});
