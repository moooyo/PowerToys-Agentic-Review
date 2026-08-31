import type { KeyObject } from "node:crypto";
import { LOCAL_CANONICAL_JSON_VERSION, serializeCanonicalJson } from "./canonical.js";
import {
  assertLocalAuthorityKeyIdMatches,
  createLocalAuthoritySigningBytes,
  createLocalAuthoritySigningDigest,
  encodeLocalAuthoritySignature,
  LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
  LocalCapabilityError,
  verifyLocalAuthoritySignature,
} from "./capability.js";
import { LOCAL_PROTOCOL_NIL_CORRELATION_ID, LocalMessageType } from "./framing.js";
import {
  type ControlProofMessage,
  HANDSHAKE_TRANSCRIPT_VERSION,
  type HandshakeTranscriptV1,
  type HelloAckMessage,
  type HelloMessage,
  LOCAL_HANDSHAKE_AUDIENCE,
  LocalMessageValidationError,
  type ReadyMessage,
  type SignedHandshakeProofV1,
  validateHandshakeTranscriptV1,
  validateLocalMessagePayload,
  validateSignedHandshakeProofV1,
} from "./messages.js";

declare const verifiedHandshakeTranscriptBrand: unique symbol;

export type VerifiedHandshakeTranscriptV1 = Readonly<HandshakeTranscriptV1> & {
  readonly [verifiedHandshakeTranscriptBrand]: true;
};

export interface HandshakeProofVerificationContext {
  readonly expectedKeyId: string;
  readonly expectedHello: Readonly<HelloMessage>;
  readonly expectedHelloAck: Readonly<HelloAckMessage>;
}

export class LocalHandshakeProofError extends Error {
  public constructor(
    public readonly code:
      | "HANDSHAKE_SCHEMA_INVALID"
      | "HANDSHAKE_CONTEXT_MISMATCH"
      | "HANDSHAKE_KEY_INVALID"
      | "HANDSHAKE_SIGNATURE_INVALID",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalHandshakeProofError";
  }
}

const verifiedTranscripts = new WeakSet<object>();

export function createHandshakeTranscriptV1(
  helloValue: unknown,
  helloAckValue: unknown,
  keyId: string,
): Readonly<HandshakeTranscriptV1> {
  const hello = validatePeerMessage<HelloMessage>(LocalMessageType.Hello, helloValue);
  const helloAck = validatePeerMessage<HelloAckMessage>(LocalMessageType.HelloAck, helloAckValue);
  return normalizeTranscript({
    transcriptVersion: HANDSHAKE_TRANSCRIPT_VERSION,
    canonicalizationVersion: LOCAL_CANONICAL_JSON_VERSION,
    signatureAlgorithm: LOCAL_CAPABILITY_SIGNATURE_ALGORITHM,
    keyId,
    audience: LOCAL_HANDSHAKE_AUDIENCE,
    hello,
    helloAck,
  });
}

export function createHandshakeTranscriptSigningBytes(transcriptValue: unknown): Buffer {
  const transcript = normalizeTranscript(transcriptValue);
  try {
    return createLocalAuthoritySigningBytes("HandshakeTranscriptV1", transcript);
  } catch (error) {
    throw handshakeError(
      "HANDSHAKE_SCHEMA_INVALID",
      "Handshake transcript cannot be canonically signed.",
      error,
    );
  }
}

// ServiceHost signs this exact 32-byte prehash directly and must not hash it again.
export function createHandshakeTranscriptSigningDigest(transcriptValue: unknown): Buffer {
  const transcript = normalizeTranscript(transcriptValue);
  try {
    return createLocalAuthoritySigningDigest("HandshakeTranscriptV1", transcript);
  } catch (error) {
    throw handshakeError(
      "HANDSHAKE_SCHEMA_INVALID",
      "Handshake transcript signing digest could not be created.",
      error,
    );
  }
}

export function createSignedHandshakeProofV1(
  transcriptValue: unknown,
  serviceHostSignature: Uint8Array,
): Readonly<SignedHandshakeProofV1> {
  const transcript = normalizeTranscript(transcriptValue);
  let signature: string;
  try {
    signature = encodeLocalAuthoritySignature(serviceHostSignature);
  } catch (error) {
    throw handshakeError(
      "HANDSHAKE_SIGNATURE_INVALID",
      "ServiceHost returned a noncanonical handshake signature.",
      error,
    );
  }
  return normalizeSignedProof({ transcript, signature });
}

export function createControlProofMessageV1(
  signedProofValue: unknown,
): Readonly<ControlProofMessage> {
  const signedProof = normalizeSignedProof(signedProofValue);
  const helloAck = signedProof.transcript.helloAck;
  return validatePeerMessage<ControlProofMessage>(LocalMessageType.ControlProof, {
    protocolMajor: helloAck.protocolMajor,
    protocolMinor: helloAck.protocolMinor,
    workerNodeId: helloAck.workerNodeId,
    workerInstanceId: helloAck.workerInstanceId,
    executorBootId: helloAck.executorBootId,
    sessionId: helloAck.sessionId,
    signedProof,
  });
}

export function verifySignedHandshakeProofV1(
  signedProofValue: unknown,
  publicKey: KeyObject,
  context: HandshakeProofVerificationContext,
): VerifiedHandshakeTranscriptV1 {
  const signedProof = normalizeSignedProof(signedProofValue);
  const transcript = signedProof.transcript;

  if (transcript.keyId !== context.expectedKeyId) {
    throw handshakeError(
      "HANDSHAKE_CONTEXT_MISMATCH",
      "Handshake proof keyId does not match the expected local authority.",
    );
  }
  try {
    assertLocalAuthorityKeyIdMatches(transcript.keyId, publicKey);
  } catch (error) {
    throw handshakeError(
      "HANDSHAKE_KEY_INVALID",
      "Handshake proof does not match the pinned P-256 public key.",
      error,
    );
  }
  try {
    verifyLocalAuthoritySignature(
      "HandshakeTranscriptV1",
      transcript,
      signedProof.signature,
      publicKey,
    );
  } catch (error) {
    const code =
      error instanceof LocalCapabilityError && error.code === "CAPABILITY_KEY_INVALID"
        ? "HANDSHAKE_KEY_INVALID"
        : "HANDSHAKE_SIGNATURE_INVALID";
    throw handshakeError(code, "Handshake proof signature is invalid.", error);
  }

  const expected = createHandshakeTranscriptV1(
    context.expectedHello,
    context.expectedHelloAck,
    context.expectedKeyId,
  );
  if (serializeCanonicalJson(transcript) !== serializeCanonicalJson(expected)) {
    throw handshakeError(
      "HANDSHAKE_CONTEXT_MISMATCH",
      "Handshake proof was created for a different peer transcript.",
    );
  }

  const verified = deepFreeze(transcript) as VerifiedHandshakeTranscriptV1;
  verifiedTranscripts.add(verified);
  return verified;
}

export function verifyControlProofMessageV1(
  messageValue: unknown,
  publicKey: KeyObject,
  context: HandshakeProofVerificationContext,
): VerifiedHandshakeTranscriptV1 {
  const message = validatePeerMessage<ControlProofMessage>(
    LocalMessageType.ControlProof,
    messageValue,
  );
  return verifySignedHandshakeProofV1(message.signedProof, publicKey, context);
}

export function validateReadyAfterHandshakeProofV1(
  readyValue: unknown,
  verifiedTranscript: VerifiedHandshakeTranscriptV1,
): Readonly<ReadyMessage> {
  if (
    typeof verifiedTranscript !== "object" ||
    verifiedTranscript === null ||
    !verifiedTranscripts.has(verifiedTranscript)
  ) {
    throw handshakeError(
      "HANDSHAKE_CONTEXT_MISMATCH",
      "Ready validation requires a cryptographically verified handshake proof.",
    );
  }
  const ready = validatePeerMessage<ReadyMessage>(LocalMessageType.Ready, readyValue);
  const helloAck = verifiedTranscript.helloAck;
  if (
    ready.protocolMajor !== helloAck.protocolMajor ||
    ready.protocolMinor !== helloAck.protocolMinor ||
    ready.workerNodeId !== helloAck.workerNodeId ||
    ready.workerInstanceId !== helloAck.workerInstanceId ||
    ready.executorBootId !== helloAck.executorBootId ||
    ready.sessionId !== helloAck.sessionId ||
    ready.controlNonce !== helloAck.controlNonce ||
    ready.executorNonce !== helloAck.executorNonce ||
    ready.executorManifestSha256 !== helloAck.executorManifestSha256 ||
    ready.executorPolicySha256 !== helloAck.executorPolicySha256 ||
    ready.executorPreflightSha256 !== helloAck.executorPreflightSha256 ||
    ready.availableSlots > helloAck.maximumSlots
  ) {
    throw handshakeError(
      "HANDSHAKE_CONTEXT_MISMATCH",
      "Ready message does not match the verified handshake transcript.",
    );
  }
  return deepFreeze(ready);
}

function validatePeerMessage<T>(messageType: LocalMessageType, value: unknown): Readonly<T> {
  try {
    return deepFreeze(
      validateLocalMessagePayload(
        messageType,
        value,
        LOCAL_PROTOCOL_NIL_CORRELATION_ID,
      ) as unknown as T,
    );
  } catch (error) {
    throw mapMessageError(error);
  }
}

function normalizeTranscript(value: unknown): Readonly<HandshakeTranscriptV1> {
  try {
    return deepFreeze(validateHandshakeTranscriptV1(value));
  } catch (error) {
    throw mapMessageError(error);
  }
}

function normalizeSignedProof(value: unknown): Readonly<SignedHandshakeProofV1> {
  try {
    return deepFreeze(validateSignedHandshakeProofV1(value));
  } catch (error) {
    throw mapMessageError(error);
  }
}

function mapMessageError(error: unknown): LocalHandshakeProofError {
  const code =
    error instanceof LocalMessageValidationError && error.code === "MESSAGE_CONTEXT_MISMATCH"
      ? "HANDSHAKE_CONTEXT_MISMATCH"
      : "HANDSHAKE_SCHEMA_INVALID";
  return handshakeError(code, "Handshake data is invalid.", error);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function handshakeError(
  code: LocalHandshakeProofError["code"],
  message: string,
  cause?: unknown,
): LocalHandshakeProofError {
  return new LocalHandshakeProofError(code, message, cause === undefined ? undefined : { cause });
}
