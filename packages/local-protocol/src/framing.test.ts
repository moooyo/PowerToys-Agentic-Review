import { describe, expect, it } from "vitest";

import {
  decodeLocalFrame,
  encodeLocalFrame,
  IncrementalLocalFrameDecoder,
  LOCAL_PROTOCOL_HEADER_BYTES,
  LOCAL_PROTOCOL_MAGIC,
  LOCAL_PROTOCOL_MAJOR_VERSION,
  LOCAL_PROTOCOL_MAX_ARTIFACT_CHUNK_BYTES,
  LOCAL_PROTOCOL_MAX_FRAME_BYTES,
  LOCAL_PROTOCOL_MAX_PAYLOAD_BYTES,
  LOCAL_PROTOCOL_MINOR_VERSION,
  LOCAL_PROTOCOL_NIL_CORRELATION_ID,
  LocalMessageType,
  type LocalMessageType as LocalMessageTypeValue,
  LocalProtocolError,
} from "./framing.js";

const ATTEMPT_CORRELATION_ID = "00112233-4455-4677-8899-aabbccddeeff";
const SECOND_ATTEMPT_CORRELATION_ID = "fedcba98-7654-4210-aedc-ba9876543210";

const sessionMessageTypes = new Set<LocalMessageTypeValue>([
  LocalMessageType.Hello,
  LocalMessageType.HelloAck,
  LocalMessageType.Ready,
  LocalMessageType.Drain,
  LocalMessageType.Drained,
  LocalMessageType.Ping,
  LocalMessageType.Pong,
  LocalMessageType.ControlProof,
]);

function correlationIdFor(messageType: LocalMessageTypeValue): string {
  return sessionMessageTypes.has(messageType)
    ? LOCAL_PROTOCOL_NIL_CORRELATION_ID
    : ATTEMPT_CORRELATION_ID;
}

function frameFor(
  messageType: LocalMessageTypeValue = LocalMessageType.Hello,
  sequence: bigint = 1n,
  payload: unknown = { protocolVersion: "1.0" },
  minorVersion = LOCAL_PROTOCOL_MINOR_VERSION,
): Buffer {
  return encodeLocalFrame({
    correlationId: correlationIdFor(messageType),
    messageType,
    minorVersion,
    payload,
    sequence,
  });
}

function replacePayload(frame: Uint8Array, payload: Uint8Array): Buffer {
  const replacement = Buffer.alloc(LOCAL_PROTOCOL_HEADER_BYTES + payload.byteLength);
  Buffer.from(frame).copy(replacement, 0, 0, LOCAL_PROTOCOL_HEADER_BYTES);
  replacement.writeUInt32LE(payload.byteLength, 16);
  Buffer.from(payload).copy(replacement, LOCAL_PROTOCOL_HEADER_BYTES);
  return replacement;
}

function copyAndMutate(frame: Uint8Array, mutate: (copy: Buffer) => void): Buffer {
  const copy = Buffer.from(frame);
  mutate(copy);
  return copy;
}

describe("local protocol framing constants", () => {
  it("fixes the ARWX version 1 wire constants", () => {
    expect(LOCAL_PROTOCOL_MAGIC).toBe("ARWX");
    expect(LOCAL_PROTOCOL_HEADER_BYTES).toBe(48);
    expect(LOCAL_PROTOCOL_MAJOR_VERSION).toBe(1);
    expect(LOCAL_PROTOCOL_MINOR_VERSION).toBe(0);
    expect(LOCAL_PROTOCOL_MAX_FRAME_BYTES).toBe(1_048_576);
    expect(LOCAL_PROTOCOL_MAX_PAYLOAD_BYTES).toBe(1_048_528);
    expect(LOCAL_PROTOCOL_MAX_ARTIFACT_CHUNK_BYTES).toBe(262_144);
  });

  it("pins the ADR message IDs and appended protocol extensions", () => {
    expect(LocalMessageType).toEqual({
      Hello: 1,
      HelloAck: 2,
      Ready: 3,
      StartAttempt: 4,
      RenewGrant: 5,
      CancelAttempt: 6,
      CancelAck: 7,
      Progress: 8,
      ArtifactStart: 9,
      ArtifactChunk: 10,
      ArtifactEnd: 11,
      Complete: 12,
      Failed: 13,
      Drain: 14,
      Drained: 15,
      Ping: 16,
      Pong: 17,
      TerminalDisposition: 18,
      TerminalAck: 19,
      ControlProof: 20,
    });
    expect(Object.values(LocalMessageType)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });
});

describe("encodeLocalFrame", () => {
  it("writes the exact 48-byte little-endian header and canonical payload", () => {
    const sequence = 0x0102_0304_0506_0708n;
    const frame = encodeLocalFrame({
      correlationId: ATTEMPT_CORRELATION_ID,
      messageType: LocalMessageType.Progress,
      minorVersion: 7,
      payload: { z: 2, a: 1 },
      sequence,
    });
    const payload = Buffer.from('{"a":1,"z":2}', "utf8");

    expect(frame.subarray(0, 4).toString("ascii")).toBe("ARWX");
    expect(frame.readUInt16LE(4)).toBe(48);
    expect(frame.readUInt16LE(6)).toBe(1);
    expect(frame.readUInt16LE(8)).toBe(7);
    expect(frame.readUInt16LE(10)).toBe(LocalMessageType.Progress);
    expect(frame.readUInt32LE(12)).toBe(0);
    expect(frame.readUInt32LE(16)).toBe(payload.byteLength);
    expect(frame.readBigUInt64LE(20)).toBe(sequence);
    expect(frame.subarray(28, 44).toString("hex")).toBe("00112233445546778899aabbccddeeff");
    expect(frame.readUInt32LE(44)).toBe(0);
    expect(frame.subarray(48)).toEqual(payload);
    expect(frame.byteLength).toBe(LOCAL_PROTOCOL_HEADER_BYTES + payload.byteLength);
  });

  it("round-trips every fixed message type with its required correlation scope", () => {
    for (const [name, messageType] of Object.entries(LocalMessageType)) {
      const frame = frameFor(messageType, BigInt(messageType), { name });
      const decoded = decodeLocalFrame(frame, BigInt(messageType));

      expect(decoded).toEqual({
        correlationId: correlationIdFor(messageType),
        majorVersion: LOCAL_PROTOCOL_MAJOR_VERSION,
        messageType,
        minorVersion: LOCAL_PROTOCOL_MINOR_VERSION,
        payload: { name },
        sequence: BigInt(messageType),
      });
    }
  });

  it("accepts the full u64 sequence range without number precision loss", () => {
    const maximum = (1n << 64n) - 1n;
    const decoded = decodeLocalFrame(frameFor(LocalMessageType.Ping, maximum), maximum);
    expect(decoded.sequence).toBe(maximum);
  });

  it("requires canonical UUID strings and the correct correlation scope", () => {
    for (const correlationId of [
      "00112233-4455-4677-8899-AABBCCDDEEFF",
      "00112233445546778899aabbccddeeff",
      "{00112233-4455-4677-8899-aabbccddeeff}",
      "00112233-4455-1677-8899-aabbccddeeff",
      "00112233-4455-4677-7899-aabbccddeeff",
      "not-a-uuid",
    ]) {
      expect(() =>
        encodeLocalFrame({
          correlationId,
          messageType: LocalMessageType.Progress,
          minorVersion: 0,
          payload: {},
          sequence: 1n,
        }),
      ).toThrow(LocalProtocolError);
    }

    expect(() =>
      encodeLocalFrame({
        correlationId: ATTEMPT_CORRELATION_ID,
        messageType: LocalMessageType.Hello,
        minorVersion: 0,
        payload: {},
        sequence: 1n,
      }),
    ).toThrow(/nil correlationId/u);
    expect(() =>
      encodeLocalFrame({
        correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
        messageType: LocalMessageType.StartAttempt,
        minorVersion: 0,
        payload: {},
        sequence: 1n,
      }),
    ).toThrow(/non-nil correlationId/u);
  });

  it("rejects invalid versions, message IDs, and sequence values", () => {
    for (const minorVersion of [-1, 65_536, 1.5, Number.NaN]) {
      expect(() =>
        encodeLocalFrame({
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          messageType: LocalMessageType.Hello,
          minorVersion,
          payload: {},
          sequence: 1n,
        }),
      ).toThrow(LocalProtocolError);
    }

    for (const messageType of [0, 21, 65_535]) {
      expect(() =>
        encodeLocalFrame({
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          messageType: messageType as LocalMessageTypeValue,
          minorVersion: 0,
          payload: {},
          sequence: 1n,
        }),
      ).toThrow(/Unknown local protocol message type/u);
    }

    for (const sequence of [0n, -1n, 1n << 64n, 0, -1, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
      expect(() =>
        encodeLocalFrame({
          correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
          messageType: LocalMessageType.Hello,
          minorVersion: 0,
          payload: {},
          sequence,
        }),
      ).toThrow(LocalProtocolError);
    }
  });

  it("rejects non-object and non-canonicalizable payload values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const payload of [
      null,
      [],
      "payload",
      1,
      { missing: undefined },
      { fractional: 1.5 },
      { unsafe: Number.MAX_SAFE_INTEGER + 1 },
      { invalidUnicode: "\ud800" },
      { date: new Date(0) },
      cyclic,
    ]) {
      expect(() => frameFor(LocalMessageType.Hello, 1n, payload)).toThrow(LocalProtocolError);
    }
  });

  it("accepts the exact maximum frame size and rejects one additional payload byte", () => {
    const emptyPayloadBytes = Buffer.byteLength('{"data":""}', "utf8");
    const exact = { data: "x".repeat(LOCAL_PROTOCOL_MAX_PAYLOAD_BYTES - emptyPayloadBytes) };
    const tooLarge = {
      data: "x".repeat(LOCAL_PROTOCOL_MAX_PAYLOAD_BYTES - emptyPayloadBytes + 1),
    };

    expect(frameFor(LocalMessageType.Hello, 1n, exact).byteLength).toBe(
      LOCAL_PROTOCOL_MAX_FRAME_BYTES,
    );
    expect(() => frameFor(LocalMessageType.Hello, 1n, tooLarge)).toThrow(/payload exceeds/u);
  });
});

describe("decodeLocalFrame", () => {
  it("rejects each invalid fixed header field", () => {
    const valid = frameFor();
    const invalidFrames = [
      copyAndMutate(valid, (frame) => {
        frame[0] = 0x42;
      }),
      copyAndMutate(valid, (frame) => {
        frame.writeUInt16LE(47, 4);
      }),
      copyAndMutate(valid, (frame) => {
        frame.writeUInt16LE(2, 6);
      }),
      copyAndMutate(valid, (frame) => {
        frame.writeUInt16LE(1, 8);
      }),
      copyAndMutate(valid, (frame) => {
        frame.writeUInt16LE(21, 10);
      }),
      copyAndMutate(valid, (frame) => {
        frame.writeUInt32LE(1, 12);
      }),
      copyAndMutate(valid, (frame) => {
        frame.writeBigUInt64LE(0n, 20);
      }),
      copyAndMutate(valid, (frame) => {
        frame.writeUInt32LE(1, 44);
      }),
    ];

    for (const invalid of invalidFrames) {
      expect(() => decodeLocalFrame(invalid)).toThrow(LocalProtocolError);
    }
  });

  it("rejects wrong correlation scope encoded in the header", () => {
    const sessionWithAttemptId = copyAndMutate(frameFor(LocalMessageType.Hello), (frame) => {
      Buffer.from(ATTEMPT_CORRELATION_ID.replaceAll("-", ""), "hex").copy(frame, 28);
    });
    const attemptWithNilId = copyAndMutate(frameFor(LocalMessageType.Progress), (frame) => {
      frame.fill(0, 28, 44);
    });

    expect(() => decodeLocalFrame(sessionWithAttemptId)).toThrow(/nil correlationId/u);
    expect(() => decodeLocalFrame(attemptWithNilId)).toThrow(/non-nil correlationId/u);
  });

  it("rejects non-v4 or non-RFC-variant attempt correlation bytes", () => {
    const invalidVersion = copyAndMutate(frameFor(LocalMessageType.Progress), (frame) => {
      Buffer.from("00112233445516778899aabbccddeeff", "hex").copy(frame, 28);
    });
    const invalidVariant = copyAndMutate(frameFor(LocalMessageType.Progress), (frame) => {
      Buffer.from("00112233445546777899aabbccddeeff", "hex").copy(frame, 28);
    });

    expect(() => decodeLocalFrame(invalidVersion)).toThrow(/version 4 UUID/u);
    expect(() => decodeLocalFrame(invalidVariant)).toThrow(/version 4 UUID/u);
  });

  it("rejects incomplete frames, trailing bytes, and declared oversized payloads", () => {
    const valid = frameFor();
    expect(() => decodeLocalFrame(valid.subarray(0, 47))).toThrow(/shorter/u);
    expect(() => decodeLocalFrame(valid.subarray(0, valid.byteLength - 1))).toThrow(/incomplete/u);
    expect(() => decodeLocalFrame(Buffer.concat([valid, Buffer.from([0])]))).toThrow(
      /trailing bytes/u,
    );

    const oversized = Buffer.from(valid.subarray(0, LOCAL_PROTOCOL_HEADER_BYTES));
    oversized.writeUInt32LE(LOCAL_PROTOCOL_MAX_PAYLOAD_BYTES + 1, 16);
    expect(() => decodeLocalFrame(oversized)).toThrow(/frame exceeds/u);
  });

  it("checks an explicitly expected sequence exactly", () => {
    const frame = frameFor(LocalMessageType.Ping, 9n);
    expect(decodeLocalFrame(frame).sequence).toBe(9n);
    expect(decodeLocalFrame(frame, 9).sequence).toBe(9n);
    expect(() => decodeLocalFrame(frame, 8n)).toThrow(/does not match expected sequence/u);
  });

  it("requires strict UTF-8 canonical JSON objects", () => {
    const base = frameFor();
    const invalidPayloads: Uint8Array[] = [
      Buffer.alloc(0),
      Buffer.from([0xc3, 0x28]),
      Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
      Buffer.from("{", "utf8"),
      Buffer.from("[]", "utf8"),
      Buffer.from("null", "utf8"),
      Buffer.from('{"b":2,"a":1}', "utf8"),
      Buffer.from('{ "a":1}', "utf8"),
      Buffer.from('{"a":1,"a":2}', "utf8"),
      Buffer.from('{"a":1,"\\u0061":2}', "utf8"),
      Buffer.from('{"a":1e0}', "utf8"),
      Buffer.from('{"a":-0}', "utf8"),
      Buffer.from('{"a":1.5}', "utf8"),
      Buffer.from('{"a":9007199254740992}', "utf8"),
      Buffer.from('{"a":"\\ud800"}', "utf8"),
      Buffer.from("{}\n", "utf8"),
      Buffer.from("{}{}", "utf8"),
    ];

    for (const payload of invalidPayloads) {
      expect(() => decodeLocalFrame(replacePayload(base, payload))).toThrow(LocalProtocolError);
    }
  });

  it("decodes a Uint8Array view without consuming adjacent bytes", () => {
    const frame = frameFor(LocalMessageType.Pong, 12n);
    const container = Buffer.alloc(frame.byteLength + 10, 0xaa);
    frame.copy(container, 5);
    const view = new Uint8Array(container.buffer, container.byteOffset + 5, frame.byteLength);
    expect(decodeLocalFrame(view, 12n).messageType).toBe(LocalMessageType.Pong);
  });
});

describe("IncrementalLocalFrameDecoder", () => {
  it("decodes a frame fragmented at every byte boundary", () => {
    const frame = frameFor(LocalMessageType.Progress, 40n, { phase: "reviewing" });
    const decoder = new IncrementalLocalFrameDecoder({
      expectedSequence: 40n,
      minorVersion: 0,
    });
    const decoded: ReturnType<typeof decodeLocalFrame>[] = [];

    for (let index = 0; index < frame.byteLength; index += 1) {
      decoded.push(...decoder.push(frame.subarray(index, index + 1)));
    }

    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(decodeLocalFrame(frame, 40n));
    expect(decoder.nextExpectedSequence).toBe(41n);
    decoder.end();
    decoder.end();
  });

  it("decodes coalesced frames and preserves exact directional sequence", () => {
    const frames = [
      frameFor(LocalMessageType.Hello, 5n, { order: 1 }),
      frameFor(LocalMessageType.Progress, 6n, { order: 2 }),
      encodeLocalFrame({
        correlationId: SECOND_ATTEMPT_CORRELATION_ID,
        messageType: LocalMessageType.Complete,
        minorVersion: 0,
        payload: { order: 3 },
        sequence: 7n,
      }),
    ];
    const decoder = new IncrementalLocalFrameDecoder({ expectedSequence: 5n, minorVersion: 0 });

    const decoded = decoder.push(Buffer.concat(frames));

    expect(decoded.map((frame) => frame.sequence)).toEqual([5n, 6n, 7n]);
    expect(decoded.map((frame) => frame.payload.order)).toEqual([1, 2, 3]);
    expect(decoder.nextExpectedSequence).toBe(8n);
  });

  it("supports a negotiated nonzero minor version", () => {
    const frame = frameFor(LocalMessageType.Ready, 1n, { ready: true }, 3);
    const decoder = new IncrementalLocalFrameDecoder({ minorVersion: 3 });
    expect(decoder.push(frame)).toHaveLength(1);
    expect(() => decodeLocalFrame(frame)).toThrow(/minor version/u);
  });

  it("rejects an out-of-order frame and remains fatally failed", () => {
    const decoder = new IncrementalLocalFrameDecoder({ minorVersion: 0 });
    expect(decoder.push(frameFor(LocalMessageType.Hello, 1n))).toHaveLength(1);

    let firstError: unknown;
    try {
      decoder.push(frameFor(LocalMessageType.Ping, 3n));
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(LocalProtocolError);
    expect(decoder.nextExpectedSequence).toBe(2n);

    let repeatedError: unknown;
    try {
      decoder.push(frameFor(LocalMessageType.Ping, 2n));
    } catch (error) {
      repeatedError = error;
    }
    expect(repeatedError).toBe(firstError);
  });

  it("fails from the header before buffering an oversized declared payload", () => {
    const oversizedHeader = frameFor().subarray(0, LOCAL_PROTOCOL_HEADER_BYTES);
    oversizedHeader.writeUInt32LE(LOCAL_PROTOCOL_MAX_PAYLOAD_BYTES + 1, 16);
    const decoder = new IncrementalLocalFrameDecoder({ minorVersion: 0 });

    expect(() => decoder.push(oversizedHeader)).toThrow(/frame exceeds/u);
  });

  it("enforces a configured per-frame buffering limit", () => {
    const frame = frameFor(LocalMessageType.Hello, 1n, { data: "bounded" });
    const decoder = new IncrementalLocalFrameDecoder({
      maximumBufferedBytes: frame.byteLength - 1,
      minorVersion: 0,
    });

    expect(() => decoder.push(frame.subarray(0, LOCAL_PROTOCOL_HEADER_BYTES))).toThrow(
      /configured/u,
    );
    expect(
      () => new IncrementalLocalFrameDecoder({ maximumBufferedBytes: 47, minorVersion: 0 }),
    ).toThrow(LocalProtocolError);
    expect(
      () =>
        new IncrementalLocalFrameDecoder({
          maximumBufferedBytes: LOCAL_PROTOCOL_MAX_FRAME_BYTES + 1,
          minorVersion: 0,
        }),
    ).toThrow(LocalProtocolError);
  });

  it("treats a partial frame at EOF as fatal", () => {
    const frame = frameFor();
    const decoder = new IncrementalLocalFrameDecoder({ minorVersion: 0 });
    expect(decoder.push(frame.subarray(0, 20))).toEqual([]);
    expect(() => decoder.end()).toThrow(/partial frame/u);
    expect(() => decoder.end()).toThrow(LocalProtocolError);
  });

  it("rejects pushes after clean EOF and can be explicitly reset", () => {
    const decoder = new IncrementalLocalFrameDecoder({ minorVersion: 0 });
    expect(decoder.push(frameFor(LocalMessageType.Hello, 1n))).toHaveLength(1);
    decoder.end();
    expect(() => decoder.push(frameFor(LocalMessageType.Ping, 1n))).toThrow(/already ended/u);

    decoder.reset(10n);
    expect(decoder.push(frameFor(LocalMessageType.Ping, 10n))).toHaveLength(1);
    expect(decoder.nextExpectedSequence).toBe(11n);
  });

  it("reset clears a fatal framing error and validates the new sequence", () => {
    const decoder = new IncrementalLocalFrameDecoder({ minorVersion: 0 });
    const invalid = copyAndMutate(frameFor(), (frame) => {
      frame[0] = 0;
    });
    expect(() => decoder.push(invalid)).toThrow(LocalProtocolError);

    decoder.reset(4);
    expect(decoder.push(frameFor(LocalMessageType.Pong, 4n))).toHaveLength(1);
    expect(() => decoder.reset(1n << 64n)).toThrow(LocalProtocolError);
  });

  it("advances beyond the maximum u64 only to mark the direction exhausted", () => {
    const maximum = (1n << 64n) - 1n;
    const decoder = new IncrementalLocalFrameDecoder({
      expectedSequence: maximum,
      minorVersion: 0,
    });
    expect(decoder.push(frameFor(LocalMessageType.Ping, maximum))).toHaveLength(1);
    expect(decoder.nextExpectedSequence).toBe(1n << 64n);
    expect(decoder.sequenceExhausted).toBe(true);
    expect(() => decoder.push(frameFor(LocalMessageType.Pong, 1n))).toThrow(
      /sequence space is exhausted/u,
    );
  });
});
