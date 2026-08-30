import { describe, expect, it } from "vitest";

import {
  canonicalizeResult,
  computeCanonicalResultDigest,
  createCanonicalResult,
} from "./canonical-result.js";

describe("canonical result serialization", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(
      canonicalizeResult({
        z: [{ second: true, first: false }, 2],
        a: "value",
      }),
    ).toBe('{"a":"value","z":[{"first":false,"second":true},2]}');
  });

  it("produces the same digest for different object insertion orders", () => {
    const first = computeCanonicalResultDigest({ b: 2, a: 1 });
    const second = computeCanonicalResultDigest({ a: 1, b: 2 });

    expect(first).toBe("43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
    expect(second).toBe(first);
    expect(createCanonicalResult({ b: 2, a: 1 })).toEqual({
      json: '{"a":1,"b":2}',
      sha256: first,
    });
  });

  it("rejects values outside the JSON data model", () => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = 1;

    expect(() => canonicalizeResult({ value: undefined })).toThrow(TypeError);
    expect(() => canonicalizeResult({ value: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalizeResult(new Date())).toThrow(TypeError);
    expect(() => canonicalizeResult(sparse)).toThrow(TypeError);
  });

  it("rejects cycles and unpaired UTF-16 surrogates", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => canonicalizeResult(cyclic)).toThrow(TypeError);
    expect(() => canonicalizeResult("\ud800")).toThrow(TypeError);
  });
});
