import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";

import { LOCAL_CAPABILITY_SIGNATURE_ALGORITHM } from "./capability.js";
import {
  decodeLocalFrame,
  encodeLocalFrame,
  IncrementalLocalFrameDecoder,
  LOCAL_PROTOCOL_HEADER_BYTES,
  LOCAL_PROTOCOL_MAX_FRAME_BYTES,
  LOCAL_PROTOCOL_MAX_PAYLOAD_BYTES,
  LOCAL_PROTOCOL_MINOR_VERSION,
  LOCAL_PROTOCOL_NIL_CORRELATION_ID,
  LocalMessageType,
  LocalProtocolError,
} from "./framing.js";
import {
  CompleteMessageSchema,
  ControlProofMessageSchema,
  HelloMessageSchema,
  LOCAL_HANDSHAKE_AUDIENCE,
  localMessageSchemas,
} from "./messages.js";
import {
  type CompleteMessageMinor1,
  CompleteMessageMinor1Schema,
  ControlProofMessageMinor1Schema,
  decodeLocalFrameMinor1,
  encodeLocalFrameMinor1,
  HelloMessageMinor1Schema,
  LOCAL_PROTOCOL_MINOR_1_VERSION,
  localMessageSchemasMinor1,
} from "./minor-1.js";

const nil = LOCAL_PROTOCOL_NIL_CORRELATION_ID;
const attemptCorrelationId = "10000000-0000-4000-8000-000000000001";
const workerInstanceId = "20000000-0000-4000-8000-000000000002";
const executorBootId = "30000000-0000-4000-8000-000000000003";
const sessionId = "40000000-0000-4000-8000-000000000004";
const artifactId = "50000000-0000-4000-8000-000000000005";
const digest = (character: string): string => character.repeat(64);

const session = {
  protocolMajor: 1 as const,
  protocolMinor: 1 as const,
  workerNodeId: "powertoys-node-01",
  workerInstanceId,
  executorBootId,
  sessionId,
};
const attempt = {
  ...session,
  attemptCorrelationId,
  runAttemptId: "run:1",
};

describe("dormant ARWX protocol minor 1 profile", () => {
  it("pins an exact minor-one schema for every message type", () => {
    expect(LOCAL_PROTOCOL_MINOR_VERSION).toBe(0);
    expect(LOCAL_PROTOCOL_MINOR_1_VERSION).toBe(1);
    expect(Object.keys(localMessageSchemasMinor1)).toHaveLength(20);

    for (const [messageType, schema] of Object.entries(localMessageSchemasMinor1)) {
      const properties = (schema as { readonly properties: Record<string, unknown> }).properties;
      const baseProperties = (
        localMessageSchemas[Number(messageType) as keyof typeof localMessageSchemas] as {
          readonly properties: Record<string, unknown>;
        }
      ).properties;
      const expectedKeys = new Set(Object.keys(baseProperties));
      if (Number(messageType) === LocalMessageType.Complete) expectedKeys.add("resultDigest");
      expect(new Set(Object.keys(properties))).toEqual(expectedKeys);

      if (Number(messageType) === LocalMessageType.Hello) {
        expect(constValue(properties.minimumMinor)).toBe(1);
        expect(constValue(properties.maximumMinor)).toBe(1);
      } else {
        expect(constValue(properties.protocolMinor)).toBe(1);
      }
      for (const [name, baseProperty] of Object.entries(baseProperties)) {
        if (
          name === "protocolMinor" ||
          (Number(messageType) === LocalMessageType.Hello &&
            (name === "minimumMinor" || name === "maximumMinor")) ||
          (Number(messageType) === LocalMessageType.ControlProof && name === "signedProof")
        ) {
          continue;
        }
        expectRecursivelyDetached(properties[name], baseProperty);
      }
    }

    const completeProperties = (
      CompleteMessageMinor1Schema as unknown as { readonly properties: Record<string, unknown> }
    ).properties;
    expect(completeProperties.resultDigest).toMatchObject({
      minLength: 64,
      maxLength: 64,
      pattern: "^[a-f0-9]{64}$",
    });
  });

  it("isolates and freezes dormant schema graphs in both mutation directions", () => {
    const minorZeroReason = schemaProperties(localMessageSchemas[LocalMessageType.CancelAttempt])
      .reason as { anyOf: unknown[] };
    const minorOneReason = schemaProperties(
      localMessageSchemasMinor1[LocalMessageType.CancelAttempt],
    ).reason as { readonly anyOf: readonly unknown[] };
    const originalLength = minorZeroReason.anyOf.length;
    try {
      minorZeroReason.anyOf.push({ const: "injected", type: "string" });
      expect(minorOneReason.anyOf).toHaveLength(originalLength);
    } finally {
      minorZeroReason.anyOf.length = originalLength;
    }
    expect(Object.isFrozen(minorOneReason)).toBe(true);
    expect(Object.isFrozen(minorOneReason.anyOf)).toBe(true);
    expect(Reflect.set(minorOneReason, "anyOf", [])).toBe(false);
    expect(minorZeroReason.anyOf).toHaveLength(originalLength);
  });

  it("accepts a generated witness and rejects the opposite profile for all 20 messages", () => {
    for (const [messageType, minorOneSchema] of Object.entries(localMessageSchemasMinor1)) {
      const minorZeroSchema =
        localMessageSchemas[Number(messageType) as keyof typeof localMessageSchemas];
      const minorZeroWitness = sampleForSchema(minorZeroSchema);
      const minorOneWitness = sampleForSchema(minorOneSchema);

      expect(Value.Check(minorZeroSchema, minorZeroWitness), `minor 0 message ${messageType}`).toBe(
        true,
      );
      expect(Value.Check(minorOneSchema, minorOneWitness), `minor 1 message ${messageType}`).toBe(
        true,
      );
      expect(Value.Check(minorZeroSchema, minorOneWitness), `1 -> 0 message ${messageType}`).toBe(
        false,
      );
      expect(Value.Check(minorOneSchema, minorZeroWitness), `0 -> 1 message ${messageType}`).toBe(
        false,
      );
    }
  });

  it("keeps minor-zero and minor-one Hello and ControlProof schemas disjoint", () => {
    const hello = helloMinor1();
    const helloAck = {
      ...session,
      controlNonce: hello.controlNonce,
      executorNonce: digest("4"),
      executorManifestSha256: hello.controlManifestSha256,
      executorPolicySha256: digest("6"),
      executorPreflightSha256: digest("7"),
      maximumSlots: 4,
    };
    const controlProof = {
      ...session,
      signedProof: {
        transcript: {
          transcriptVersion: 1,
          canonicalizationVersion: 1,
          signatureAlgorithm: LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
          keyId: digest("8"),
          audience: LOCAL_HANDSHAKE_AUDIENCE,
          hello,
          helloAck,
        },
        signature: "A".repeat(86),
      },
    };

    expect(Value.Check(HelloMessageMinor1Schema, hello)).toBe(true);
    expect(Value.Check(HelloMessageSchema, hello)).toBe(false);
    expect(Value.Check(ControlProofMessageMinor1Schema, controlProof)).toBe(true);
    expect(Value.Check(ControlProofMessageSchema, controlProof)).toBe(false);

    for (const [minimumMinor, maximumMinor] of [
      [0, 0],
      [0, 1],
      [2, 2],
    ]) {
      expect(
        Value.Check(HelloMessageMinor1Schema, {
          ...hello,
          minimumMinor,
          maximumMinor,
        }),
      ).toBe(false);
    }
  });

  it("requires independent raw-artifact and canonical-result digests on Complete", () => {
    const complete = completeMinor1();
    expect(Value.Check(CompleteMessageMinor1Schema, complete)).toBe(true);
    expect(Value.Check(CompleteMessageSchema, complete)).toBe(false);
    expectTypeOf(complete).toEqualTypeOf<CompleteMessageMinor1>();

    const withoutResultDigest = { ...complete } as Record<string, unknown>;
    delete withoutResultDigest.resultDigest;
    const withoutResultSha256 = { ...complete } as Record<string, unknown>;
    delete withoutResultSha256.resultSha256;
    for (const candidate of [
      withoutResultDigest,
      withoutResultSha256,
      { ...complete, protocolMinor: 0 },
      { ...complete, resultDigest: digest("A") },
      { ...complete, resultSha256: digest("B") },
      { ...complete, resultDigest: null },
      { ...complete, resultSha256: null },
      { ...complete, resultDigest: "a".repeat(63) },
      { ...complete, resultDigest: "a".repeat(65) },
      { ...complete, resultSha256: "b".repeat(63) },
      { ...complete, resultSha256: "b".repeat(65) },
      { ...complete, resultDigest: `${"a".repeat(63)}g` },
      { ...complete, resultSha256: `${"b".repeat(63)}g` },
      { ...complete, resultDigest: `${"a".repeat(63)}\n` },
      { ...complete, resultSha256: `${"b".repeat(63)}\u0000` },
      { ...complete, inlineResult: { summary: "forbidden" } },
    ]) {
      expect(Value.Check(CompleteMessageMinor1Schema, candidate)).toBe(false);
    }

    expect(
      Value.Check(CompleteMessageMinor1Schema, {
        ...complete,
        resultDigest: complete.resultSha256,
      }),
    ).toBe(true);
  });

  it("makes minor-zero and minor-one frames mutually undecodable", () => {
    const minorOne = encodeLocalFrameMinor1({
      correlationId: nil,
      messageType: LocalMessageType.Ping,
      payload: { profile: 1 },
      sequence: 1n,
    });
    expect(decodeLocalFrameMinor1(minorOne)).toMatchObject({ minorVersion: 1 });
    expect(() => decodeLocalFrame(minorOne)).toThrow(/minor version 1/u);

    const minorZero = encodeLocalFrame({
      correlationId: nil,
      messageType: LocalMessageType.Ping,
      minorVersion: 0,
      payload: { profile: 0 },
      sequence: 1n,
    });
    expect(() => decodeLocalFrameMinor1(minorZero)).toThrow(/minor version 0/u);
  });

  it("keeps an incremental minor-one decoder failed after the first wrong-version frame", () => {
    const minorZero = encodeLocalFrame({
      correlationId: nil,
      messageType: LocalMessageType.Ping,
      minorVersion: 0,
      payload: { profile: 0 },
      sequence: 1n,
    });
    const minorOne = encodeLocalFrameMinor1({
      correlationId: nil,
      messageType: LocalMessageType.Ping,
      payload: { profile: 1 },
      sequence: 1n,
    });
    const decoder = new IncrementalLocalFrameDecoder({ minorVersion: 1 });
    const first = thrownBy(() => decoder.push(minorZero));
    const second = thrownBy(() => decoder.push(minorOne));
    expect(first).toBeInstanceOf(LocalProtocolError);
    expect(second).toBe(first);
  });

  it("inherits canonical JSON, UTF-8, and physical frame ceilings", () => {
    const exactPayload = { value: "x".repeat(LOCAL_PROTOCOL_MAX_PAYLOAD_BYTES - 12) };
    const exactFrame = encodeLocalFrameMinor1({
      correlationId: nil,
      messageType: LocalMessageType.Ping,
      payload: exactPayload,
      sequence: 1n,
    });
    expect(exactFrame.byteLength).toBe(LOCAL_PROTOCOL_MAX_FRAME_BYTES);
    expect(decodeLocalFrameMinor1(exactFrame).payload).toEqual(exactPayload);

    expect(() =>
      encodeLocalFrameMinor1({
        correlationId: nil,
        messageType: LocalMessageType.Ping,
        payload: { value: `${exactPayload.value}x` },
        sequence: 1n,
      }),
    ).toThrow(LocalProtocolError);

    const ordinary = encodeLocalFrameMinor1({
      correlationId: nil,
      messageType: LocalMessageType.Ping,
      payload: { a: 1, z: 2 },
      sequence: 1n,
    });
    expect(() =>
      decodeLocalFrameMinor1(replacePayload(ordinary, Buffer.from('{"z":2,"a":1}', "utf8"))),
    ).toThrow(/canonical JSON/u);
    expect(() =>
      decodeLocalFrameMinor1(
        replacePayload(ordinary, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])),
      ),
    ).toThrow(/canonical JSON/u);
  });
});

function helloMinor1() {
  return {
    protocolMajor: 1 as const,
    minimumMinor: 1 as const,
    maximumMinor: 1 as const,
    workerNodeId: session.workerNodeId,
    workerInstanceId,
    executorBootId: null,
    sessionId,
    controlNonce: digest("1"),
    controlManifestSha256: digest("2"),
    controlPreflightSha256: digest("3"),
  };
}

function completeMinor1(): CompleteMessageMinor1 {
  return {
    ...attempt,
    resultArtifactId: artifactId,
    resultBytes: "2",
    resultSha256: digest("a"),
    resultDigest: digest("b"),
    outputSchemaSha256: digest("c"),
    completedAtUnixMs: 1_800_000_000_000,
  };
}

function constValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as { readonly const?: unknown }).const;
}

function schemaProperties(schema: TSchema): Record<string, unknown> {
  return (schema as TSchema & { readonly properties: Record<string, unknown> }).properties;
}

function expectRecursivelyDetached(left: unknown, right: unknown): void {
  expect(left).toEqual(right);
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return;
  }
  expect(left).not.toBe(right);
  for (const key of Reflect.ownKeys(right)) {
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, key);
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, key);
    if (
      leftDescriptor !== undefined &&
      rightDescriptor !== undefined &&
      Object.hasOwn(leftDescriptor, "value") &&
      Object.hasOwn(rightDescriptor, "value")
    ) {
      expectRecursivelyDetached(leftDescriptor.value, rightDescriptor.value);
    }
  }
}

function replacePayload(frame: Uint8Array, payload: Uint8Array): Buffer {
  const replacement = Buffer.alloc(LOCAL_PROTOCOL_HEADER_BYTES + payload.byteLength);
  Buffer.from(frame).copy(replacement, 0, 0, LOCAL_PROTOCOL_HEADER_BYTES);
  replacement.writeUInt32LE(payload.byteLength, 16);
  Buffer.from(payload).copy(replacement, LOCAL_PROTOCOL_HEADER_BYTES);
  return replacement;
}

function sampleForSchema(schema: TSchema): unknown {
  const value = schema as TSchema & {
    readonly anyOf?: readonly TSchema[];
    readonly const?: unknown;
    readonly maxLength?: number;
    readonly minLength?: number;
    readonly minimum?: number;
    readonly pattern?: string;
    readonly properties?: Readonly<Record<string, TSchema>>;
    readonly required?: readonly string[];
    readonly type?: string;
  };
  if (Object.hasOwn(value, "const")) return value.const;
  if (value.anyOf !== undefined) return sampleForSchema(required(value.anyOf[0]));
  switch (value.type) {
    case "null":
      return null;
    case "boolean":
      return false;
    case "integer":
    case "number":
      return Math.max(0, value.minimum ?? 0);
    case "array":
      return [];
    case "object": {
      const result: Record<string, unknown> = {};
      const properties = value.properties ?? {};
      for (const name of value.required ?? Object.keys(properties)) {
        result[name] = sampleForSchema(required(properties[name]));
      }
      return result;
    }
    case "string":
      return sampleString(value.pattern, value.minLength ?? 0, value.maxLength);
    default:
      return {};
  }
}

function sampleString(pattern: string | undefined, minimum: number, maximum: number | undefined) {
  if (pattern?.includes("[0-9a-f]{8}-[0-9a-f]{4}-4")) {
    return "10000000-0000-4000-8000-000000000001";
  }
  if (pattern === "^[a-f0-9]{64}$") return "a".repeat(64);
  if (pattern?.includes("{40,64}")) return "a".repeat(40);
  if (pattern?.includes("[^/\\s]+/")) return "owner/repository";
  if (minimum === 86 && maximum === 86) return "A".repeat(86);
  if (pattern?.startsWith("^[A-Z]")) return "CODE";
  if (pattern?.includes("/")) return "application/json";
  if (pattern?.includes("(?:0|[1-9]")) return "0";
  return "a".repeat(Math.max(1, minimum));
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Schema witness generation reached a missing value.");
  return value;
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw.");
}
