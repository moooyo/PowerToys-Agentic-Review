import { createHash, type Hash } from "node:crypto";

import { createCanonicalJsonDocument, type DeepReadonly, deepFreezeJson } from "./canonical.js";
import { isVerifiedExecutionCapability, type VerifiedExecutionCapability } from "./capability.js";
import { LocalMessageType } from "./framing.js";
import {
  isVerifiedHandshakeTranscriptV1,
  type VerifiedHandshakeTranscriptV1,
} from "./handshake.js";
import {
  type ArtifactChunkMessage,
  type ArtifactEndMessage,
  type ArtifactStartMessage,
  type CompleteMessage,
  type FailedMessage,
  LOCAL_ARTIFACT_MAXIMUM_BYTES,
  type LocalMessagePayload,
  LocalMessageValidationError,
  validateLocalMessagePayload,
} from "./messages.js";

declare const verifiedAttemptTerminalBrand: unique symbol;

export interface VerifiedArtifact {
  readonly artifactId: string;
  readonly purpose: ArtifactStartMessage["purpose"];
  readonly name: string;
  readonly mediaType: string;
  readonly totalBytes: bigint;
  readonly sha256: string;
  readonly chunkCount: number;
}

export interface VerifiedArtifactChunk {
  readonly artifactId: string;
  readonly chunkIndex: number;
  readonly offsetBytes: bigint;
  readonly bytes: Buffer;
}

export interface VerifiedAttemptCompletion {
  readonly terminal: DeepReadonly<CompleteMessage>;
  readonly terminalPayloadSha256: string;
  readonly resultArtifact: DeepReadonly<VerifiedArtifact>;
  readonly [verifiedAttemptTerminalBrand]: true;
}

export interface VerifiedAttemptFailure {
  readonly terminal: DeepReadonly<FailedMessage>;
  readonly terminalPayloadSha256: string;
  readonly [verifiedAttemptTerminalBrand]: true;
}

export type VerifiedAttemptTerminal = DeepReadonly<
  VerifiedAttemptCompletion | VerifiedAttemptFailure
>;

const verifiedAttemptTerminals = new WeakSet<object>();

export function isVerifiedAttemptTerminal(value: unknown): value is VerifiedAttemptTerminal {
  return typeof value === "object" && value !== null && verifiedAttemptTerminals.has(value);
}

interface ActiveArtifact {
  readonly start: ArtifactStartMessage;
  readonly expectedBytes: bigint;
  readonly digest: Hash;
  receivedBytes: bigint;
  nextChunkIndex: number;
}

type ArtifactStreamContext = Readonly<
  Pick<
    ArtifactStartMessage,
    | "protocolMajor"
    | "protocolMinor"
    | "workerNodeId"
    | "workerInstanceId"
    | "executorBootId"
    | "sessionId"
    | "attemptCorrelationId"
    | "runAttemptId"
  >
>;

export interface ArtifactStreamVerifierOptions {
  readonly maximumArtifactCount?: number;
  readonly maximumConcurrentArtifacts?: number;
}

export class ArtifactStreamProtocolError extends Error {
  public constructor(
    public readonly code:
      | "ARTIFACT_LIMIT_EXCEEDED"
      | "ARTIFACT_DUPLICATE"
      | "ARTIFACT_NOT_ACTIVE"
      | "ARTIFACT_CONTEXT_MISMATCH"
      | "ARTIFACT_SEQUENCE_INVALID"
      | "ARTIFACT_LENGTH_MISMATCH"
      | "ARTIFACT_DIGEST_MISMATCH"
      | "ARTIFACT_STREAM_INCOMPLETE"
      | "ARTIFACT_TERMINAL_MISMATCH"
      | "ARTIFACT_TERMINAL_REPLAYED"
      | "ARTIFACT_ABORTED"
      | "ARTIFACT_AUTHORITY_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactStreamProtocolError";
  }
}

export class ArtifactStreamVerifier {
  readonly #context: ArtifactStreamContext;
  readonly #maximumArtifactBytes: bigint;
  readonly #maximumArtifactCount: number;
  readonly #maximumConcurrentArtifacts: number;
  readonly #expectedOutputSchemaSha256: string;
  readonly #seenArtifactIds = new Set<string>();
  readonly #active = new Map<string, ActiveArtifact>();
  readonly #completed = new Map<string, DeepReadonly<VerifiedArtifact>>();
  #reservedArtifactBytes = 0n;
  #terminalAccepted = false;
  #aborted = false;

  public constructor(
    capability: VerifiedExecutionCapability,
    handshake: VerifiedHandshakeTranscriptV1,
    options: ArtifactStreamVerifierOptions = {},
  ) {
    if (!isVerifiedExecutionCapability(capability)) {
      throw artifactError(
        "ARTIFACT_AUTHORITY_INVALID",
        "Artifact verification requires a cryptographically verified execution capability.",
      );
    }
    if (!isVerifiedHandshakeTranscriptV1(handshake)) {
      throw artifactError(
        "ARTIFACT_AUTHORITY_INVALID",
        "Artifact verification requires a cryptographically verified handshake transcript.",
      );
    }
    const session = handshake.helloAck;
    if (
      capability.keyId !== handshake.keyId ||
      capability.workerNodeId !== session.workerNodeId ||
      capability.workerInstanceId !== session.workerInstanceId ||
      capability.executorBootId !== session.executorBootId ||
      capability.sessionId !== session.sessionId
    ) {
      throw artifactError(
        "ARTIFACT_CONTEXT_MISMATCH",
        "Verified execution capability and handshake transcript identify different sessions.",
      );
    }
    const maximumArtifactBytes = BigInt(capability.resources.artifactBytes);
    if (maximumArtifactBytes < 1n || maximumArtifactBytes > LOCAL_ARTIFACT_MAXIMUM_BYTES) {
      throw artifactError(
        "ARTIFACT_AUTHORITY_INVALID",
        "Verified execution capability has an invalid artifact byte ceiling.",
      );
    }
    this.#maximumArtifactBytes = maximumArtifactBytes;
    this.#expectedOutputSchemaSha256 = capability.digests.outputSchemaSha256;
    this.#maximumArtifactCount = requireBoundedInteger(
      options.maximumArtifactCount ?? 64,
      1,
      1_024,
      "maximumArtifactCount",
    );
    this.#maximumConcurrentArtifacts = requireBoundedInteger(
      options.maximumConcurrentArtifacts ?? 4,
      1,
      64,
      "maximumConcurrentArtifacts",
    );
    if (this.#maximumConcurrentArtifacts > this.#maximumArtifactCount) {
      throw new RangeError("maximumConcurrentArtifacts cannot exceed maximumArtifactCount");
    }
    this.#context = Object.freeze({
      protocolMajor: session.protocolMajor,
      protocolMinor: session.protocolMinor,
      workerNodeId: capability.workerNodeId,
      workerInstanceId: capability.workerInstanceId,
      executorBootId: capability.executorBootId,
      sessionId: capability.sessionId,
      attemptCorrelationId: capability.attemptCorrelationId,
      runAttemptId: capability.runAttemptId,
    });
  }

  public start(value: unknown): Readonly<ArtifactStartMessage> {
    this.#assertNotTerminal();
    const message = this.#validate(LocalMessageType.ArtifactStart, value) as ArtifactStartMessage;
    if (this.#seenArtifactIds.has(message.artifactId)) {
      throw artifactError("ARTIFACT_DUPLICATE", "Artifact identifier was already used.");
    }
    if (
      this.#seenArtifactIds.size >= this.#maximumArtifactCount ||
      this.#active.size >= this.#maximumConcurrentArtifacts
    ) {
      throw artifactError("ARTIFACT_LIMIT_EXCEEDED", "Artifact stream count limit was reached.");
    }
    const expectedBytes = BigInt(message.totalBytes);
    if (
      expectedBytes < 1n ||
      expectedBytes > this.#maximumArtifactBytes ||
      this.#reservedArtifactBytes + expectedBytes > this.#maximumArtifactBytes
    ) {
      throw artifactError(
        "ARTIFACT_LIMIT_EXCEEDED",
        "Attempt artifacts exceed their signed aggregate byte ceiling.",
      );
    }
    this.#reservedArtifactBytes += expectedBytes;
    this.#seenArtifactIds.add(message.artifactId);
    this.#active.set(message.artifactId, {
      start: message,
      expectedBytes,
      digest: createHash("sha256"),
      receivedBytes: 0n,
      nextChunkIndex: 0,
    });
    return message;
  }

  public acceptChunk(value: unknown): Readonly<VerifiedArtifactChunk> {
    this.#assertNotTerminal();
    const message = this.#validate(LocalMessageType.ArtifactChunk, value) as ArtifactChunkMessage;
    const active = this.#requireActive(message.artifactId);
    if (
      message.chunkIndex !== active.nextChunkIndex ||
      BigInt(message.offsetBytes) !== active.receivedBytes
    ) {
      throw artifactError(
        "ARTIFACT_SEQUENCE_INVALID",
        "Artifact chunks must be contiguous and exactly ordered.",
      );
    }
    const bytes = Buffer.from(message.data, "base64url");
    const nextBytes = active.receivedBytes + BigInt(bytes.byteLength);
    if (nextBytes > active.expectedBytes || nextBytes > this.#maximumArtifactBytes) {
      throw artifactError("ARTIFACT_LIMIT_EXCEEDED", "Artifact chunk exceeds its declared size.");
    }
    active.digest.update(bytes);
    active.receivedBytes = nextBytes;
    active.nextChunkIndex += 1;
    return Object.freeze({
      artifactId: message.artifactId,
      chunkIndex: message.chunkIndex,
      offsetBytes: BigInt(message.offsetBytes),
      bytes: Buffer.from(bytes),
    });
  }

  public end(value: unknown): Readonly<VerifiedArtifact> {
    this.#assertNotTerminal();
    const message = this.#validate(LocalMessageType.ArtifactEnd, value) as ArtifactEndMessage;
    const active = this.#requireActive(message.artifactId);
    if (
      message.chunkCount !== active.nextChunkIndex ||
      BigInt(message.totalBytes) !== active.receivedBytes ||
      active.receivedBytes !== active.expectedBytes
    ) {
      throw artifactError(
        "ARTIFACT_LENGTH_MISMATCH",
        "Artifact end metadata does not match the streamed bytes.",
      );
    }
    // Digest a copy so malformed terminal metadata cannot corrupt verifier state or expose a
    // runtime ERR_CRYPTO_HASH_FINALIZED error if the caller reports another protocol frame.
    const digest = active.digest.copy().digest("hex");
    if (message.sha256 !== active.start.sha256 || digest !== active.start.sha256) {
      throw artifactError(
        "ARTIFACT_DIGEST_MISMATCH",
        "Artifact digest does not match the declared content.",
      );
    }
    this.#active.delete(message.artifactId);
    const verified = deepFreezeJson({
      artifactId: message.artifactId,
      purpose: active.start.purpose,
      name: active.start.name,
      mediaType: active.start.mediaType,
      totalBytes: active.receivedBytes,
      sha256: digest,
      chunkCount: active.nextChunkIndex,
    });
    this.#completed.set(message.artifactId, verified);
    return verified;
  }

  public acceptComplete(value: unknown): DeepReadonly<VerifiedAttemptCompletion> {
    this.#assertNotTerminal();
    this.assertComplete();
    const terminal = this.#validate(
      LocalMessageType.Complete,
      value,
    ) as DeepReadonly<CompleteMessage>;
    const resultArtifacts = [...this.#completed.values()].filter(
      (artifact) => artifact.purpose === "result",
    );
    const result = this.#completed.get(terminal.resultArtifactId);
    if (
      resultArtifacts.length !== 1 ||
      result === undefined ||
      result.purpose !== "result" ||
      result.totalBytes !== BigInt(terminal.resultBytes) ||
      result.sha256 !== terminal.resultSha256 ||
      terminal.outputSchemaSha256 !== this.#expectedOutputSchemaSha256
    ) {
      throw artifactError(
        "ARTIFACT_TERMINAL_MISMATCH",
        "Completion does not bind the unique verified result artifact and output schema.",
      );
    }
    const verified = deepFreezeJson({
      terminal,
      terminalPayloadSha256: createCanonicalJsonDocument(terminal).sha256,
      resultArtifact: result,
    }) as DeepReadonly<VerifiedAttemptCompletion>;
    this.#terminalAccepted = true;
    verifiedAttemptTerminals.add(verified);
    return verified;
  }

  public acceptFailed(value: unknown): DeepReadonly<VerifiedAttemptFailure> {
    this.#assertNotTerminal();
    const terminal = this.#validate(LocalMessageType.Failed, value) as DeepReadonly<FailedMessage>;
    this.#active.clear();
    const verified = deepFreezeJson({
      terminal,
      terminalPayloadSha256: createCanonicalJsonDocument(terminal).sha256,
    }) as DeepReadonly<VerifiedAttemptFailure>;
    this.#terminalAccepted = true;
    verifiedAttemptTerminals.add(verified);
    return verified;
  }

  public assertComplete(): void {
    this.#assertNotAborted();
    if (this.#active.size !== 0) {
      throw artifactError(
        "ARTIFACT_STREAM_INCOMPLETE",
        "One or more artifact streams are incomplete.",
      );
    }
  }

  public abort(): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#active.clear();
    this.#completed.clear();
  }

  #assertNotTerminal(): void {
    this.#assertNotAborted();
    if (this.#terminalAccepted) {
      throw artifactError(
        "ARTIFACT_TERMINAL_REPLAYED",
        "Attempt output cannot change after a terminal message is accepted.",
      );
    }
  }

  #assertNotAborted(): void {
    if (this.#aborted) {
      throw artifactError("ARTIFACT_ABORTED", "Attempt output is permanently fenced after abort.");
    }
  }

  #validate(messageType: LocalMessageType, value: unknown): DeepReadonly<LocalMessagePayload> {
    let message: DeepReadonly<LocalMessagePayload>;
    try {
      message = validateLocalMessagePayload(messageType, value, this.#context.attemptCorrelationId);
    } catch (error) {
      if (error instanceof LocalMessageValidationError) throw error;
      throw artifactError("ARTIFACT_CONTEXT_MISMATCH", "Artifact message is invalid.");
    }
    const attempt = message as ArtifactStreamContext;
    if (
      attempt.protocolMajor !== this.#context.protocolMajor ||
      attempt.protocolMinor !== this.#context.protocolMinor ||
      attempt.workerNodeId !== this.#context.workerNodeId ||
      attempt.workerInstanceId !== this.#context.workerInstanceId ||
      attempt.executorBootId !== this.#context.executorBootId ||
      attempt.sessionId !== this.#context.sessionId ||
      attempt.attemptCorrelationId !== this.#context.attemptCorrelationId ||
      attempt.runAttemptId !== this.#context.runAttemptId
    ) {
      throw artifactError("ARTIFACT_CONTEXT_MISMATCH", "Artifact belongs to another attempt.");
    }
    return message;
  }

  #requireActive(artifactId: string): ActiveArtifact {
    const active = this.#active.get(artifactId);
    if (active === undefined) {
      throw artifactError("ARTIFACT_NOT_ACTIVE", "Artifact stream is not active.");
    }
    return active;
  }
}

function requireBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} is outside the supported range`);
  }
  return value;
}

function artifactError(
  code: ArtifactStreamProtocolError["code"],
  message: string,
): ArtifactStreamProtocolError {
  return new ArtifactStreamProtocolError(code, message);
}
