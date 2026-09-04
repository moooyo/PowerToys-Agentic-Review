import { type DeepReadonly, deepFreezeJson } from "./canonical.js";
import { LOCAL_PROTOCOL_NIL_CORRELATION_ID, LocalMessageType } from "./framing.js";
import {
  type HelloAckMessage,
  type HelloMessage,
  LocalMessageValidationError,
  type ReadyMessage,
  validateLocalMessagePayload,
} from "./messages.js";

declare const establishedLocalSessionBrand: unique symbol;

export type EstablishedLocalSession = DeepReadonly<{
  readonly hello: HelloMessage;
  readonly helloAck: HelloAckMessage;
}> & {
  readonly [establishedLocalSessionBrand]: true;
};

export class LocalHandshakeError extends Error {
  public constructor(
    public readonly code: "HANDSHAKE_SCHEMA_INVALID" | "HANDSHAKE_CONTEXT_MISMATCH",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalHandshakeError";
  }
}

const establishedSessions = new WeakSet<object>();

export function isEstablishedLocalSession(value: unknown): value is EstablishedLocalSession {
  return typeof value === "object" && value !== null && establishedSessions.has(value);
}

export function establishLocalSession(
  helloValue: unknown,
  helloAckValue: unknown,
): EstablishedLocalSession {
  const hello = validatePeerMessage<HelloMessage>(LocalMessageType.Hello, helloValue);
  const helloAck = validatePeerMessage<HelloAckMessage>(LocalMessageType.HelloAck, helloAckValue);
  if (
    helloAck.protocolMajor !== hello.protocolMajor ||
    helloAck.protocolMinor < hello.minimumMinor ||
    helloAck.protocolMinor > hello.maximumMinor ||
    helloAck.workerNodeId !== hello.workerNodeId ||
    helloAck.workerInstanceId !== hello.workerInstanceId ||
    helloAck.sessionId !== hello.sessionId ||
    helloAck.controlNonce !== hello.controlNonce ||
    helloAck.executorManifestSha256 !== hello.controlManifestSha256 ||
    hello.controlNonce === helloAck.executorNonce ||
    isZeroDigest(hello.controlNonce) ||
    isZeroDigest(helloAck.executorNonce) ||
    isZeroDigest(hello.controlManifestSha256) ||
    isZeroDigest(hello.controlPreflightSha256) ||
    isZeroDigest(helloAck.executorManifestSha256) ||
    isZeroDigest(helloAck.executorPolicySha256) ||
    isZeroDigest(helloAck.executorPreflightSha256)
  ) {
    throw handshakeError(
      "HANDSHAKE_CONTEXT_MISMATCH",
      "HelloAck does not bind the negotiated local session context.",
    );
  }
  const session = deepFreezeJson({ hello, helloAck }) as EstablishedLocalSession;
  establishedSessions.add(session);
  return session;
}

export function validateReadyForEstablishedSession(
  readyValue: unknown,
  session: EstablishedLocalSession,
): Readonly<ReadyMessage> {
  if (!isEstablishedLocalSession(session)) {
    throw handshakeError(
      "HANDSHAKE_CONTEXT_MISMATCH",
      "Ready validation requires a locally established session.",
    );
  }
  const ready = validatePeerMessage<ReadyMessage>(LocalMessageType.Ready, readyValue);
  const helloAck = session.helloAck;
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
      "Ready message does not match the established local session.",
    );
  }
  return deepFreezeJson(ready);
}

function validatePeerMessage<T>(messageType: LocalMessageType, value: unknown): DeepReadonly<T> {
  try {
    return deepFreezeJson(
      validateLocalMessagePayload(
        messageType,
        value,
        LOCAL_PROTOCOL_NIL_CORRELATION_ID,
      ) as unknown as T,
    );
  } catch (error) {
    const code =
      error instanceof LocalMessageValidationError && error.code === "MESSAGE_CONTEXT_MISMATCH"
        ? "HANDSHAKE_CONTEXT_MISMATCH"
        : "HANDSHAKE_SCHEMA_INVALID";
    throw handshakeError(code, "Handshake data is invalid.", error);
  }
}

function isZeroDigest(value: string): boolean {
  return value === "0".repeat(64);
}

function handshakeError(
  code: LocalHandshakeError["code"],
  message: string,
  cause?: unknown,
): LocalHandshakeError {
  return new LocalHandshakeError(code, message, cause === undefined ? undefined : { cause });
}
