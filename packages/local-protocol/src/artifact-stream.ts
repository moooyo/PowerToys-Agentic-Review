import { createHash, type Hash } from "node:crypto";

import { LocalMessageType } from "./framing.js";
import {
  type ArtifactChunkMessage,
  type ArtifactEndMessage,
  type ArtifactStartMessage,
  LOCAL_ARTIFACT_MAXIMUM_BYTES,
  type LocalMessagePayload,
  LocalMessageValidationError,
  validateLocalMessagePayload,
} from "./messages.js";

export interface VerifiedArtifact {
  readonly artifactId: string;
  readonly purpose: ArtifactStartMessage["purpose"];
  readonly name: string;
  readonly mediaType: string;
  readonly totalBytes: bigint;
  readonly sha256: string;
  readonly chunkCount: number;
}

interface ActiveArtifact {
  readonly start: ArtifactStartMessage;
  readonly expectedBytes: bigint;
  readonly digest: Hash;
  receivedBytes: bigint;
  nextChunkIndex: number;
}

export type ArtifactStreamContext = Readonly<
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

export type ArtifactStreamVerifierOptions = ArtifactStreamContext & {
  readonly maximumArtifactBytes: bigint;
  readonly maximumArtifactCount?: number;
  readonly maximumConcurrentArtifacts?: number;
};

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
      | "ARTIFACT_STREAM_INCOMPLETE",
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
  readonly #seenArtifactIds = new Set<string>();
  readonly #active = new Map<string, ActiveArtifact>();
  #reservedArtifactBytes = 0n;

  public constructor(options: ArtifactStreamVerifierOptions) {
    if (
      options.maximumArtifactBytes < 1n ||
      options.maximumArtifactBytes > LOCAL_ARTIFACT_MAXIMUM_BYTES
    ) {
      throw new RangeError("maximumArtifactBytes is outside the local protocol range");
    }
    this.#maximumArtifactBytes = options.maximumArtifactBytes;
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
      protocolMajor: options.protocolMajor,
      protocolMinor: options.protocolMinor,
      workerNodeId: options.workerNodeId,
      workerInstanceId: options.workerInstanceId,
      executorBootId: options.executorBootId,
      sessionId: options.sessionId,
      attemptCorrelationId: options.attemptCorrelationId,
      runAttemptId: options.runAttemptId,
    });
  }

  public start(value: unknown): Readonly<ArtifactStartMessage> {
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

  public acceptChunk(value: unknown): Buffer {
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
    return bytes;
  }

  public end(value: unknown): Readonly<VerifiedArtifact> {
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
    return Object.freeze({
      artifactId: message.artifactId,
      purpose: active.start.purpose,
      name: active.start.name,
      mediaType: active.start.mediaType,
      totalBytes: active.receivedBytes,
      sha256: digest,
      chunkCount: active.nextChunkIndex,
    });
  }

  public assertComplete(): void {
    if (this.#active.size !== 0) {
      throw artifactError(
        "ARTIFACT_STREAM_INCOMPLETE",
        "One or more artifact streams are incomplete.",
      );
    }
  }

  public abort(): void {
    this.#active.clear();
  }

  #validate(messageType: LocalMessageType, value: unknown): Readonly<LocalMessagePayload> {
    let message: Readonly<LocalMessagePayload>;
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
