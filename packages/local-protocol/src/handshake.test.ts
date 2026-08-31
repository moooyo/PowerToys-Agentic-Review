import { createHash, generateKeyPairSync, type KeyObject, sign as nodeSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { serializeCanonicalJson } from "./canonical.js";
import { deriveCapabilityKeyId, LOCAL_CAPABILITY_SIGNATURE_ALGORITHM } from "./capability.js";
import {
  decodeLocalFrame,
  encodeLocalFrame,
  LOCAL_PROTOCOL_NIL_CORRELATION_ID,
  LocalMessageType,
} from "./framing.js";
import {
  createControlProofMessageV1,
  createHandshakeTranscriptSigningBytes,
  createHandshakeTranscriptSigningDigest,
  createHandshakeTranscriptV1,
  createSignedHandshakeProofV1,
  LocalHandshakeProofError,
  type VerifiedHandshakeTranscriptV1,
  validateReadyAfterHandshakeProofV1,
  verifyControlProofMessageV1,
  verifySignedHandshakeProofV1,
} from "./handshake.js";
import {
  HANDSHAKE_TRANSCRIPT_VERSION,
  type HandshakeTranscriptV1,
  type HelloAckMessage,
  type HelloMessage,
  LOCAL_HANDSHAKE_AUDIENCE,
  validateLocalMessagePayload,
} from "./messages.js";

const p256Order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const p256HalfOrder = p256Order >> 1n;
const hex = (character: string): string => character.repeat(64);

const hello: HelloMessage = {
  protocolMajor: 1,
  minimumMinor: 0,
  maximumMinor: 0,
  workerNodeId: "powertoys-node-01",
  workerInstanceId: "worker-instance:restart-7",
  executorBootId: null,
  sessionId: "10000000-0000-4000-8000-000000000001",
  controlNonce: hex("1"),
  controlManifestSha256: hex("2"),
  controlPreflightSha256: hex("3"),
};

const helloAck: HelloAckMessage = {
  protocolMajor: 1,
  protocolMinor: 0,
  workerNodeId: hello.workerNodeId,
  workerInstanceId: hello.workerInstanceId,
  executorBootId: "20000000-0000-4000-8000-000000000002",
  sessionId: hello.sessionId,
  controlNonce: hello.controlNonce,
  executorNonce: hex("4"),
  executorManifestSha256: hello.controlManifestSha256,
  executorPolicySha256: hex("6"),
  executorPreflightSha256: hex("7"),
  maximumSlots: 4,
};

describe("handshake transcript proof", () => {
  it("constructs a strict canonical transcript and pins its signing domain", () => {
    const transcript = createHandshakeTranscriptV1(hello, helloAck, hex("8"));
    const signingBytes = createHandshakeTranscriptSigningBytes(transcript);
    const domain = Buffer.from(
      "AgenticReview.LocalAuthority/HandshakeTranscriptV1/ECDSA-P256-SHA256/P1363/1",
      "ascii",
    );
    const payload = Buffer.from(serializeCanonicalJson(transcript), "utf8");

    expect(transcript).toEqual({
      transcriptVersion: HANDSHAKE_TRANSCRIPT_VERSION,
      canonicalizationVersion: 1,
      signatureAlgorithm: LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
      keyId: hex("8"),
      audience: LOCAL_HANDSHAKE_AUDIENCE,
      hello,
      helloAck,
    });
    expect(signingBytes.readUInt32BE(0)).toBe(domain.byteLength);
    expect(signingBytes.readUInt32BE(4)).toBe(payload.byteLength);
    expect(signingBytes.subarray(8, 8 + domain.byteLength)).toEqual(domain);
    expect(signingBytes.subarray(8 + domain.byteLength)).toEqual(payload);
    expect(createHandshakeTranscriptSigningDigest(transcript)).toEqual(
      createHash("sha256").update(signingBytes).digest(),
    );
    expect(createHandshakeTranscriptSigningDigest(transcript).toString("hex")).toBe(
      "6e54a34c5ead5c0b8fd4dfb13d0f8351eda1bec16568af43490788011aaca5ba",
    );
    expect(Object.isFrozen(transcript)).toBe(true);
    expect(Object.isFrozen(transcript.hello)).toBe(true);
    expect(Object.isFrozen(transcript.helloAck)).toBe(true);
  });

  it("accepts a ServiceHost P1363 low-S signature and verifies the framed ControlProof", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const keyId = deriveCapabilityKeyId(publicKey);
    const transcript = createHandshakeTranscriptV1(hello, helloAck, keyId);
    const signature = signTranscript(transcript, privateKey);
    const signedProof = createSignedHandshakeProofV1(transcript, signature);
    const controlProof = createControlProofMessageV1(signedProof);
    const frame = encodeLocalFrame({
      correlationId: LOCAL_PROTOCOL_NIL_CORRELATION_ID,
      messageType: LocalMessageType.ControlProof,
      minorVersion: 0,
      payload: controlProof,
      sequence: 3,
    });
    const decoded = decodeLocalFrame(frame, 3);
    const validatedMessage = validateLocalMessagePayload(
      LocalMessageType.ControlProof,
      decoded.payload,
      decoded.correlationId,
    );
    const context = { expectedKeyId: keyId, expectedHello: hello, expectedHelloAck: helloAck };

    const verified = verifyControlProofMessageV1(validatedMessage, publicKey, context);
    expect(verified).toEqual(transcript);
    expect(Object.isFrozen(verified.hello)).toBe(true);

    const ready = readyMessage();
    expect(validateReadyAfterHandshakeProofV1(ready, verified)).toEqual(ready);
    expect(() =>
      validateReadyAfterHandshakeProofV1(ready, transcript as VerifiedHandshakeTranscriptV1),
    ).toThrowError(expect.objectContaining({ code: "HANDSHAKE_CONTEXT_MISMATCH" }));
  });

  it("rejects every transcript mutation, including all peer attestations and slot capacity", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const keyId = deriveCapabilityKeyId(publicKey);
    const transcript = createHandshakeTranscriptV1(hello, helloAck, keyId);
    const signedProof = createSignedHandshakeProofV1(
      transcript,
      signTranscript(transcript, privateKey),
    );
    const context = { expectedKeyId: keyId, expectedHello: hello, expectedHelloAck: helloAck };
    const otherSessionId = "30000000-0000-4000-8000-000000000003";
    const otherBootId = "40000000-0000-4000-8000-000000000004";
    const mutations: ReadonlyArray<readonly [string, (value: HandshakeTranscriptV1) => unknown]> = [
      ["transcriptVersion", (value) => ({ ...value, transcriptVersion: 2 })],
      ["canonicalizationVersion", (value) => ({ ...value, canonicalizationVersion: 2 })],
      ["signatureAlgorithm", (value) => ({ ...value, signatureAlgorithm: "ECDSA_OTHER" })],
      ["keyId", (value) => ({ ...value, keyId: hex("9") })],
      ["audience", (value) => ({ ...value, audience: "other-audience" })],
      ["hello.protocolMajor", (value) => mutateHello(value, { protocolMajor: 2 })],
      ["hello.minimumMinor", (value) => mutateHello(value, { minimumMinor: 1 })],
      ["hello.maximumMinor", (value) => mutateHello(value, { maximumMinor: 1 })],
      [
        "workerNodeId",
        (value) =>
          mutateBoth(value, { workerNodeId: "other-node" }, { workerNodeId: "other-node" }),
      ],
      [
        "workerInstanceId",
        (value) =>
          mutateBoth(
            value,
            { workerInstanceId: "other-instance" },
            { workerInstanceId: "other-instance" },
          ),
      ],
      ["hello.executorBootId", (value) => mutateHello(value, { executorBootId: otherBootId })],
      [
        "sessionId",
        (value) => mutateBoth(value, { sessionId: otherSessionId }, { sessionId: otherSessionId }),
      ],
      [
        "controlNonce",
        (value) => mutateBoth(value, { controlNonce: hex("a") }, { controlNonce: hex("a") }),
      ],
      ["controlManifestSha256", (value) => mutateHello(value, { controlManifestSha256: hex("b") })],
      [
        "controlPreflightSha256",
        (value) => mutateHello(value, { controlPreflightSha256: hex("c") }),
      ],
      ["helloAck.protocolMajor", (value) => mutateHelloAck(value, { protocolMajor: 2 })],
      ["helloAck.protocolMinor", (value) => mutateHelloAck(value, { protocolMinor: 1 })],
      ["executorBootId", (value) => mutateHelloAck(value, { executorBootId: otherBootId })],
      ["executorNonce", (value) => mutateHelloAck(value, { executorNonce: hex("d") })],
      [
        "executorManifestSha256",
        (value) => mutateHelloAck(value, { executorManifestSha256: hex("e") }),
      ],
      [
        "executorPolicySha256",
        (value) => mutateHelloAck(value, { executorPolicySha256: hex("f") }),
      ],
      [
        "executorPreflightSha256",
        (value) => mutateHelloAck(value, { executorPreflightSha256: hex("a") }),
      ],
      ["maximumSlots", (value) => mutateHelloAck(value, { maximumSlots: 5 })],
    ];

    for (const [name, mutate] of mutations) {
      expect(
        () =>
          verifySignedHandshakeProofV1(
            { ...signedProof, transcript: mutate(transcript) },
            publicKey,
            context,
          ),
        name,
      ).toThrow(LocalHandshakeProofError);
    }
  });

  it("rejects wrong keys, high-S signatures, extra fields, and a replayed session context", () => {
    const signer = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const keyId = deriveCapabilityKeyId(signer.publicKey);
    const transcript = createHandshakeTranscriptV1(hello, helloAck, keyId);
    const lowS = signTranscript(transcript, signer.privateKey);
    const signedProof = createSignedHandshakeProofV1(transcript, lowS);
    const context = { expectedKeyId: keyId, expectedHello: hello, expectedHelloAck: helloAck };

    expect(() => verifySignedHandshakeProofV1(signedProof, other.publicKey, context)).toThrowError(
      expect.objectContaining({ code: "HANDSHAKE_KEY_INVALID" }),
    );

    const highS = makeHighS(lowS);
    expect(() => createSignedHandshakeProofV1(transcript, highS)).toThrowError(
      expect.objectContaining({ code: "HANDSHAKE_SIGNATURE_INVALID" }),
    );
    expect(() =>
      verifySignedHandshakeProofV1(
        { ...signedProof, signature: highS.toString("base64url") },
        signer.publicKey,
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "HANDSHAKE_SIGNATURE_INVALID" }));

    expect(() =>
      verifySignedHandshakeProofV1(
        { ...signedProof, privateKey: "must-not-cross" },
        signer.publicKey,
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "HANDSHAKE_SCHEMA_INVALID" }));
    expect(() =>
      verifySignedHandshakeProofV1(
        {
          ...signedProof,
          transcript: { ...signedProof.transcript, unsignedMetadata: true },
        },
        signer.publicKey,
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "HANDSHAKE_SCHEMA_INVALID" }));

    const replayHello = {
      ...hello,
      sessionId: "50000000-0000-4000-8000-000000000005",
      controlNonce: hex("a"),
    } as const;
    const replayHelloAck = {
      ...helloAck,
      sessionId: replayHello.sessionId,
      controlNonce: replayHello.controlNonce,
      executorNonce: hex("b"),
    } as const;
    expect(() =>
      verifySignedHandshakeProofV1(signedProof, signer.publicKey, {
        expectedKeyId: keyId,
        expectedHello: replayHello,
        expectedHelloAck: replayHelloAck,
      }),
    ).toThrowError(expect.objectContaining({ code: "HANDSHAKE_CONTEXT_MISMATCH" }));
  });

  it("rejects inconsistent transcripts and Ready messages that exceed signed context", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const keyId = deriveCapabilityKeyId(publicKey);
    for (const invalidAck of [
      { ...helloAck, workerInstanceId: "other-instance" },
      { ...helloAck, controlNonce: hex("9") },
      { ...helloAck, executorManifestSha256: hex("9") },
      { ...helloAck, executorNonce: hello.controlNonce },
      { ...helloAck, executorNonce: "0".repeat(64) },
    ]) {
      expect(() => createHandshakeTranscriptV1(hello, invalidAck, keyId)).toThrowError(
        expect.objectContaining({ code: "HANDSHAKE_CONTEXT_MISMATCH" }),
      );
    }

    const transcript = createHandshakeTranscriptV1(hello, helloAck, keyId);
    const signedProof = createSignedHandshakeProofV1(
      transcript,
      signTranscript(transcript, privateKey),
    );
    const verified = verifySignedHandshakeProofV1(signedProof, publicKey, {
      expectedKeyId: keyId,
      expectedHello: hello,
      expectedHelloAck: helloAck,
    });
    for (const invalidReady of [
      { ...readyMessage(), sessionId: "60000000-0000-4000-8000-000000000006" },
      { ...readyMessage(), executorPolicySha256: hex("9") },
      { ...readyMessage(), availableSlots: helloAck.maximumSlots + 1 },
    ]) {
      expect(() => validateReadyAfterHandshakeProofV1(invalidReady, verified)).toThrowError(
        expect.objectContaining({ code: "HANDSHAKE_CONTEXT_MISMATCH" }),
      );
    }
  });
});

function readyMessage() {
  return {
    protocolMajor: helloAck.protocolMajor,
    protocolMinor: helloAck.protocolMinor,
    workerNodeId: helloAck.workerNodeId,
    workerInstanceId: helloAck.workerInstanceId,
    executorBootId: helloAck.executorBootId,
    sessionId: helloAck.sessionId,
    controlNonce: helloAck.controlNonce,
    executorNonce: helloAck.executorNonce,
    executorManifestSha256: helloAck.executorManifestSha256,
    executorPolicySha256: helloAck.executorPolicySha256,
    executorPreflightSha256: helloAck.executorPreflightSha256,
    isolationMode: "split-service-v1" as const,
    ready: true,
    availableSlots: helloAck.maximumSlots,
    reasonCode: null,
  };
}

function mutateHello(
  transcript: HandshakeTranscriptV1,
  mutation: Record<string, unknown>,
): unknown {
  return { ...transcript, hello: { ...transcript.hello, ...mutation } };
}

function mutateHelloAck(
  transcript: HandshakeTranscriptV1,
  mutation: Record<string, unknown>,
): unknown {
  return { ...transcript, helloAck: { ...transcript.helloAck, ...mutation } };
}

function mutateBoth(
  transcript: HandshakeTranscriptV1,
  helloMutation: Record<string, unknown>,
  helloAckMutation: Record<string, unknown>,
): unknown {
  return {
    ...transcript,
    hello: { ...transcript.hello, ...helloMutation },
    helloAck: { ...transcript.helloAck, ...helloAckMutation },
  };
}

function signTranscript(transcript: HandshakeTranscriptV1, privateKey: KeyObject): Buffer {
  const signature = nodeSign("sha256", createHandshakeTranscriptSigningBytes(transcript), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return makeLowS(signature);
}

function makeLowS(signature: Uint8Array): Buffer {
  const result = Buffer.from(signature);
  const s = readUnsigned(result.subarray(32));
  if (s > p256HalfOrder) writeUnsigned(p256Order - s, result, 32);
  return result;
}

function makeHighS(signature: Uint8Array): Buffer {
  const result = Buffer.from(signature);
  const lowS = readUnsigned(result.subarray(32));
  writeUnsigned(p256Order - lowS, result, 32);
  return result;
}

function readUnsigned(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function writeUnsigned(value: bigint, target: Uint8Array, offset: number): void {
  let remaining = value;
  for (let index = offset + 31; index >= offset; index -= 1) {
    target[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}
