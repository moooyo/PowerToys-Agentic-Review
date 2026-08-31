import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeHostControlOpaqueJson,
  encodeHostControlOpaqueJson,
  type HostControlOpaqueJsonDescriptor,
  HostControlOpaqueJsonError,
} from "./opaque-json.js";

describe("HostControl opaque JSON", () => {
  it("pins the cross-language exact JSON.stringify descriptor golden", () => {
    const value = {
      confidence: 0.8,
      maximum: Number.MAX_VALUE,
      minimum: Number.MIN_VALUE,
    };
    const descriptor = encodeHostControlOpaqueJson(value, 1_048_576);

    expect(JSON.stringify(value)).toBe(
      '{"confidence":0.8,"maximum":1.7976931348623157e+308,"minimum":5e-324}',
    );
    expect(descriptor).toEqual({
      base64Url:
        "eyJjb25maWRlbmNlIjowLjgsIm1heGltdW0iOjEuNzk3NjkzMTM0ODYyMzE1N2UrMzA4LCJtaW5pbXVtIjo1ZS0zMjR9",
      byteLength: 69,
      sha256: "75740ca3678e2efea5c080c5950accbe75f3eeb673facefc373b9eb0ee802dba",
    });
    expect(decodeHostControlOpaqueJson(descriptor, 1_048_576)).toEqual(value);
  });

  it.each([
    ["NaN", { value: Number.NaN }],
    ["positive infinity", { value: Number.POSITIVE_INFINITY }],
    ["negative infinity", { value: Number.NEGATIVE_INFINITY }],
    ["BigInt", { value: 1n }],
  ])("rejects %s instead of allowing JSON.stringify coercion", (_name, value) => {
    expect(() => encodeHostControlOpaqueJson(value, 1_048_576)).toThrowError(
      expect.objectContaining({ code: "INVALID_JSON_VALUE" }),
    );
  });

  it("rejects cyclic input", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => encodeHostControlOpaqueJson(value, 1_048_576)).toThrowError(
      expect.objectContaining({ code: "INVALID_JSON_VALUE" }),
    );
  });

  it.each([
    ["non-object root", [1, 2, 3]],
    ["escaped lone high surrogate", { value: "\ud800" }],
    ["escaped lone low surrogate", { value: "\udc00" }],
  ])("rejects cross-language-incompatible input: %s", (_name, value) => {
    expect(() => encodeHostControlOpaqueJson(value, 1_048_576)).toThrowError(
      expect.objectContaining({ code: "INVALID_JSON_VALUE" }),
    );
  });

  it("rejects encoded and decoded values outside their byte limits", () => {
    const descriptor = encodeHostControlOpaqueJson({ value: "bounded" }, 1_024);
    expect(() => encodeHostControlOpaqueJson({ value: "too large" }, 4)).toThrowError(
      expect.objectContaining({ code: "BYTE_LIMIT_EXCEEDED" }),
    );
    expect(() => decodeHostControlOpaqueJson(descriptor, descriptor.byteLength - 1)).toThrowError(
      expect.objectContaining({ code: "INVALID_DESCRIPTOR" }),
    );
  });

  it.each([
    ["additional key", (value: HostControlOpaqueJsonDescriptor) => ({ ...value, extra: true })],
    ["wrong length", (value: HostControlOpaqueJsonDescriptor) => ({ ...value, byteLength: 1 })],
    [
      "noncanonical base64url",
      (value: HostControlOpaqueJsonDescriptor) => ({
        ...value,
        base64Url: `${value.base64Url}=`,
      }),
    ],
    [
      "wrong digest",
      (value: HostControlOpaqueJsonDescriptor) => ({
        ...value,
        sha256: "0".repeat(64),
      }),
    ],
  ])("rejects descriptor tampering: %s", (_name, mutate) => {
    const descriptor = encodeHostControlOpaqueJson({ ok: true }, 1_024);
    expect(() => decodeHostControlOpaqueJson(mutate(descriptor), 1_024)).toThrow(
      HostControlOpaqueJsonError,
    );
  });

  it("accepts noncanonical JSON bytes without reserializing them", () => {
    const bytes = Buffer.from(' { "z" : -0, "a" : 1e0, "escaped" : "\\u0061" } \n', "utf8");
    const descriptor = descriptorFor(bytes);

    expect(decodeHostControlOpaqueJson(descriptor, bytes.byteLength)).toEqual({
      z: -0,
      a: 1,
      escaped: "a",
    });
    expect(Buffer.from(descriptor.base64Url, "base64url")).toEqual(bytes);
  });

  it.each([
    ["non-object root", "[]"],
    ["duplicate key", '{"value":1,"value":2}'],
    ["escaped duplicate key", '{"a":1,"\\u0061":2}'],
    ["overflowing number", '{"value":1e309}'],
    ["overlong number", `{"value":1.${"0".repeat(63)}}`],
    ["byte-order mark", "\ufeff{}"],
    ["lone high surrogate", '{"value":"\\ud800"}'],
    ["lone low surrogate", '{"value":"\\udc00"}'],
  ])("rejects cross-language-incompatible decoded JSON: %s", (_name, document) => {
    const bytes = Buffer.from(document, "utf8");
    expect(() => decodeHostControlOpaqueJson(descriptorFor(bytes), bytes.byteLength)).toThrowError(
      expect.objectContaining({ code: "INVALID_JSON" }),
    );
  });

  it("enforces the shared JSON depth limit", () => {
    const atLimit = Buffer.from(`{"value":${"[".repeat(63)}0${"]".repeat(63)}}`, "utf8");
    const overLimit = Buffer.from(`{"value":${"[".repeat(64)}0${"]".repeat(64)}}`, "utf8");

    expect(decodeHostControlOpaqueJson(descriptorFor(atLimit), atLimit.byteLength)).toBeDefined();
    expect(() =>
      decodeHostControlOpaqueJson(descriptorFor(overLimit), overLimit.byteLength),
    ).toThrowError(expect.objectContaining({ code: "INVALID_JSON" }));
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0xff]), "INVALID_UTF8"],
    ["invalid JSON", Buffer.from("not-json", "utf8"), "INVALID_JSON"],
  ])("rejects %s after descriptor integrity checks", (_name, bytes, code) => {
    const descriptor = descriptorFor(bytes);
    expect(() => decodeHostControlOpaqueJson(descriptor, 1_024)).toThrowError(
      expect.objectContaining({ code }),
    );
  });
});

function descriptorFor(bytes: Buffer): HostControlOpaqueJsonDescriptor {
  return {
    base64Url: bytes.toString("base64url"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
