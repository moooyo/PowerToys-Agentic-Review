import {
  type CommittedRunArtifact,
  type CreateResultArtifactUploadRequest,
  type CreateResultArtifactUploadResponse,
  CreateResultArtifactUploadResponseSchema,
  type FinalizeResultArtifactUploadRequest,
  type FinalizeResultArtifactUploadResponse,
  FinalizeResultArtifactUploadResponseSchema,
  isCanonicalResultArtifactChunkData,
  type LeaseIdentity,
  maximumResultArtifactBytes,
  maximumResultArtifactChunkBytes,
  maximumResultArtifactChunks,
  type ResultArtifactChunkRequest,
  type ResultArtifactChunkResponse,
  ResultArtifactChunkResponseSchema,
  type TerminateResultArtifactUploadRequest,
  type TerminateResultArtifactUploadResponse,
  TerminateResultArtifactUploadResponseSchema,
} from "@agentic-review/contracts";
import {
  type ArtifactChunkMessage,
  type ArtifactEndMessage,
  type ArtifactStartMessage,
  type CompleteMessage,
  createCanonicalJsonDocument,
  type DeepReadonly,
  type FailedMessage,
  LocalMessageType,
  sha256Hex,
  validateLocalMessagePayload,
} from "@agentic-review/local-protocol";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";

export type ResultArtifactUploadPhase =
  | "created"
  | "receiving"
  | "finalizing"
  | "committed"
  | "closed";

export type ResultArtifactUploadFailureKind = "definitive" | "ambiguous" | "lease_revoked";
export type ResultArtifactUploadOperation = "create" | "put" | "finalize" | "terminate";
export type ResultArtifactUploadClosure =
  | "complete"
  | "executor_failed"
  | "shutdown"
  | "upload_failed";

export interface ResultArtifactUploadContext {
  readonly protocolMajor: ArtifactStartMessage["protocolMajor"];
  readonly protocolMinor: ArtifactStartMessage["protocolMinor"];
  readonly workerNodeId: string;
  readonly workerInstanceId: string;
  readonly executorBootId: string;
  readonly sessionId: string;
  readonly attemptCorrelationId: string;
  readonly runAttemptId: string;
}

export interface ResultArtifactUploadFailure {
  readonly kind: ResultArtifactUploadFailureKind;
  readonly operation: ResultArtifactUploadOperation;
  readonly code: string;
  readonly attempts: number;
}

export interface ResultArtifactUploadState {
  readonly phase: ResultArtifactUploadPhase;
  readonly clientArtifactId: string | null;
  readonly uploadId: string | null;
  readonly nextChunkIndex: number;
  readonly nextOffsetBytes: number;
  readonly committedArtifact: Readonly<CommittedRunArtifact> | null;
  readonly closure: ResultArtifactUploadClosure | null;
  readonly failure: Readonly<ResultArtifactUploadFailure> | null;
}

export type ResultArtifactUploadEvent =
  | Readonly<{ type: "ArtifactStart"; message: DeepReadonly<ArtifactStartMessage> }>
  | Readonly<{ type: "ArtifactChunk"; message: DeepReadonly<ArtifactChunkMessage> }>
  | Readonly<{ type: "ArtifactEnd"; message: DeepReadonly<ArtifactEndMessage> }>
  | Readonly<{ type: "Failed"; message: DeepReadonly<FailedMessage> }>
  | Readonly<{ type: "Complete"; message: DeepReadonly<CompleteMessage> }>;

export interface ResultArtifactUploadApi {
  create(
    runAttemptId: string,
    request: Readonly<CreateResultArtifactUploadRequest>,
    signal: AbortSignal,
  ): Promise<CreateResultArtifactUploadResponse>;
  put(
    uploadId: string,
    chunkIndex: number,
    request: Readonly<ResultArtifactChunkRequest>,
    signal: AbortSignal,
  ): Promise<ResultArtifactChunkResponse>;
  finalize(
    uploadId: string,
    request: Readonly<FinalizeResultArtifactUploadRequest>,
    signal: AbortSignal,
  ): Promise<FinalizeResultArtifactUploadResponse>;
  terminate(
    uploadId: string,
    request: Readonly<TerminateResultArtifactUploadRequest>,
    signal: AbortSignal,
  ): Promise<TerminateResultArtifactUploadResponse>;
}

export interface ResultArtifactUploadRetryPolicy {
  readonly maximumAttempts: number;
  readonly initialDelayMilliseconds: number;
  readonly maximumDelayMilliseconds: number;
}

export interface ResultArtifactUploadSessionDependencies {
  readonly now?: () => number;
  readonly wait?: (delayMilliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface ResultArtifactUploadSessionOptions {
  readonly api: ResultArtifactUploadApi;
  readonly context: Readonly<ResultArtifactUploadContext>;
  readonly lease: Readonly<LeaseIdentity>;
  readonly leaseDeadlineMonotonicMilliseconds: number;
  readonly hardDeadlineMonotonicMilliseconds: number;
  readonly retryPolicy?: Readonly<ResultArtifactUploadRetryPolicy>;
  readonly dependencies?: Readonly<ResultArtifactUploadSessionDependencies>;
}

interface SnapshottedResultArtifactUploadSessionOptions {
  readonly api: ResultArtifactUploadApi;
  readonly context: Readonly<ResultArtifactUploadContext>;
  readonly lease: Readonly<LeaseIdentity>;
  readonly leaseDeadlineMonotonicMilliseconds: number;
  readonly hardDeadlineMonotonicMilliseconds: number;
  readonly retryPolicy: Readonly<ResultArtifactUploadRetryPolicy> | undefined;
  readonly dependencies: Readonly<ResultArtifactUploadSessionDependencies>;
}

export class ResultArtifactUploadApiError extends Error {
  public constructor(
    public readonly kind: ResultArtifactUploadFailureKind,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super("Result artifact upload API operation failed.");
    this.name = "ResultArtifactUploadApiError";
    if (
      (kind !== "definitive" && kind !== "ambiguous" && kind !== "lease_revoked") ||
      typeof retryable !== "boolean"
    ) {
      throw new TypeError("Result artifact upload API failure classification is invalid.");
    }
    assertFailureCode(code);
    if (kind === "lease_revoked" && retryable) {
      throw new TypeError("A revoked lease cannot be marked retryable.");
    }
  }
}

export class ResultArtifactUploadSessionError extends Error {
  public constructor(
    public readonly code:
      | "DEADLINE_EXPIRED"
      | "EVENT_CONFLICT"
      | "EVENT_INVALID"
      | "RESPONSE_INVALID"
      | "SESSION_CLOSED"
      | "TRANSITION_INVALID"
      | "UPLOAD_FAILED",
    message: string,
    public readonly failure?: Readonly<ResultArtifactUploadFailure>,
  ) {
    super(message);
    this.name = "ResultArtifactUploadSessionError";
  }
}

interface ValidatedResultArtifactStartEvent {
  readonly type: "ArtifactStart";
  readonly message: DeepReadonly<ArtifactStartMessage>;
  readonly fingerprint: string;
}

interface ValidatedResultArtifactChunkEvent {
  readonly type: "ArtifactChunk";
  readonly message: DeepReadonly<ArtifactChunkMessage>;
  readonly fingerprint: string;
}

interface ValidatedResultArtifactEndEvent {
  readonly type: "ArtifactEnd";
  readonly message: DeepReadonly<ArtifactEndMessage>;
  readonly fingerprint: string;
}

interface ValidatedResultArtifactFailedEvent {
  readonly type: "Failed";
  readonly message: DeepReadonly<FailedMessage>;
  readonly fingerprint: string;
}

interface ValidatedResultArtifactCompleteEvent {
  readonly type: "Complete";
  readonly message: DeepReadonly<CompleteMessage>;
  readonly fingerprint: string;
}

type ValidatedResultArtifactUploadEvent =
  | ValidatedResultArtifactStartEvent
  | ValidatedResultArtifactChunkEvent
  | ValidatedResultArtifactEndEvent
  | ValidatedResultArtifactFailedEvent
  | ValidatedResultArtifactCompleteEvent;

interface ClassifiedFailure {
  readonly kind: ResultArtifactUploadFailureKind;
  readonly code: string;
  readonly retryable: boolean;
}

class OperationFailure extends Error {
  public constructor(
    public readonly kind: ResultArtifactUploadFailureKind,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super("Result artifact upload operation failed.");
    this.name = "OperationFailure";
  }
}

class DispatchInterrupted extends Error {
  public constructor(public readonly reason: "deadline" | "shutdown") {
    super("Result artifact upload dispatch was interrupted.");
    this.name = "DispatchInterrupted";
  }
}

const defaultRetryPolicy: Readonly<ResultArtifactUploadRetryPolicy> = Object.freeze({
  maximumAttempts: 3,
  initialDelayMilliseconds: 100,
  maximumDelayMilliseconds: 1_000,
});

/**
 * Owns one upload-only result-artifact application session. This class is deliberately dormant:
 * callers must provide the already authenticated Control context and the four-method transport.
 */
export class ResultArtifactUploadSession {
  readonly #api: ResultArtifactUploadApi;
  readonly #context: Readonly<ResultArtifactUploadContext>;
  readonly #lease: Readonly<LeaseIdentity>;
  readonly #leaseDeadline: number;
  readonly #hardDeadline: number;
  readonly #retryPolicy: Readonly<ResultArtifactUploadRetryPolicy>;
  readonly #nowSource: () => number;
  readonly #wait: (delayMilliseconds: number, signal: AbortSignal) => Promise<void>;
  #phase: ResultArtifactUploadPhase = "created";
  #clientArtifactId: string | null = null;
  #uploadId: string | null = null;
  #nextChunkIndex = 0;
  #nextOffsetBytes = 0;
  #start: DeepReadonly<ArtifactStartMessage> | null = null;
  #end: DeepReadonly<ArtifactEndMessage> | null = null;
  #committedArtifact: Readonly<CommittedRunArtifact> | null = null;
  #closure: ResultArtifactUploadClosure | null = null;
  #failure: Readonly<ResultArtifactUploadFailure> | null = null;
  #terminalFingerprint: string | null = null;
  #terminalType: "Complete" | "Failed" | null = null;
  #tail: Promise<void> = Promise.resolve();
  #shutdownRequested = false;
  #shutdownDeadline: number | undefined;
  #interruptActive: ((reason: "deadline" | "shutdown") => void) | undefined;
  #lastObservedMonotonicMilliseconds: number;

  public constructor(options: Readonly<ResultArtifactUploadSessionOptions>) {
    const snapshot = snapshotSessionOptions(options);
    registerWorkerContractFormats();
    this.#api = snapshotUploadApi(snapshot.api);
    this.#context = snapshotContext(snapshot.context);
    this.#lease = snapshotLease(snapshot.lease);
    assertContextMatchesLease(this.#context, this.#lease);
    this.#leaseDeadline = requireMonotonicDeadline(
      snapshot.leaseDeadlineMonotonicMilliseconds,
      "lease deadline",
    );
    this.#hardDeadline = requireMonotonicDeadline(
      snapshot.hardDeadlineMonotonicMilliseconds,
      "hard deadline",
    );
    this.#retryPolicy = snapshotRetryPolicy(snapshot.retryPolicy ?? defaultRetryPolicy);
    this.#nowSource = snapshot.dependencies.now ?? (() => performance.now());
    this.#lastObservedMonotonicMilliseconds = requireMonotonicObservation(this.#nowSource());
    this.#wait = snapshot.dependencies.wait ?? waitForDelay;
  }

  public get state(): Readonly<ResultArtifactUploadState> {
    return freezeState({
      phase: this.#phase,
      clientArtifactId: this.#clientArtifactId,
      uploadId: this.#uploadId,
      nextChunkIndex: this.#nextChunkIndex,
      nextOffsetBytes: this.#nextOffsetBytes,
      committedArtifact: this.#committedArtifact,
      closure: this.#closure,
      failure: this.#failure,
    });
  }

  public accept(
    event: Readonly<ResultArtifactUploadEvent>,
  ): Promise<Readonly<ResultArtifactUploadState>> {
    let validated: ValidatedResultArtifactUploadEvent;
    try {
      validated = this.#validateEvent(event);
    } catch {
      return Promise.reject(
        sessionError("EVENT_INVALID", "Result artifact upload event is invalid."),
      );
    }
    return this.#enqueue(async () => {
      await this.#acceptValidated(validated);
      return this.state;
    });
  }

  public shutdown(
    shutdownDeadlineMonotonicMilliseconds: number,
  ): Promise<Readonly<ResultArtifactUploadState>> {
    const deadline = requireMonotonicDeadline(
      shutdownDeadlineMonotonicMilliseconds,
      "shutdown deadline",
    );
    const previousDeadline = this.#shutdownDeadline;
    const firstRequest = !this.#shutdownRequested;
    this.#shutdownRequested = true;
    this.#shutdownDeadline = Math.min(previousDeadline ?? deadline, deadline);
    if (firstRequest || (previousDeadline !== undefined && deadline < previousDeadline)) {
      this.#interruptActive?.("shutdown");
    }
    return this.#enqueue(async () => {
      await this.#closeForShutdown();
      return this.state;
    });
  }

  async #acceptValidated(event: ValidatedResultArtifactUploadEvent): Promise<void> {
    if (this.#phase === "closed") {
      if (
        (event.type === "Complete" || event.type === "Failed") &&
        event.type === this.#terminalType &&
        event.fingerprint === this.#terminalFingerprint
      ) {
        return;
      }
      throw sessionError("SESSION_CLOSED", "Result artifact upload session is closed.");
    }
    if (this.#shutdownRequested) {
      this.#closeWithoutFailure("shutdown");
      throw sessionError("SESSION_CLOSED", "Result artifact upload session is shutting down.");
    }

    switch (event.type) {
      case "ArtifactStart":
        await this.#acceptStart(event);
        return;
      case "ArtifactChunk":
        await this.#acceptChunk(event);
        return;
      case "ArtifactEnd":
        await this.#acceptEnd(event);
        return;
      case "Failed":
        await this.#acceptFailed(event);
        return;
      case "Complete":
        this.#acceptComplete(event);
        return;
      default:
        throw this.#failEvent("EVENT_INVALID", "Result artifact upload event type is invalid.");
    }
  }

  async #acceptStart(event: ValidatedResultArtifactStartEvent): Promise<void> {
    if (this.#phase !== "created" || this.#start !== null) {
      throw this.#failEvent("TRANSITION_INVALID", "Result artifact upload can start only once.");
    }
    const message = event.message;
    let totalBytes: number;
    try {
      totalBytes = decimalBytes(message.totalBytes, maximumResultArtifactBytes);
    } catch {
      throw this.#failEvent("EVENT_INVALID", "Result artifact byte count is invalid.");
    }
    if (
      message.purpose !== "result" ||
      message.mediaType !== "application/json" ||
      totalBytes < 1
    ) {
      throw this.#failEvent(
        "EVENT_INVALID",
        "Only one bounded JSON result artifact can enter the upload session.",
      );
    }

    const request = Object.freeze({
      ...this.#lease,
      clientArtifactId: message.artifactId,
      purpose: "result" as const,
      name: message.name,
      mediaType: "application/json" as const,
      totalBytes,
      sha256: message.sha256,
    });
    const uploadId = await this.#perform(
      "create",
      (signal) => this.#api.create(this.#context.runAttemptId, request, signal),
      (response) => this.#acceptCreateResponse(response),
    );
    this.#uploadId = uploadId;
    this.#start = message;
    this.#clientArtifactId = message.artifactId;
    this.#phase = "receiving";
  }

  async #acceptChunk(event: ValidatedResultArtifactChunkEvent): Promise<void> {
    if (this.#phase !== "receiving" || this.#start === null || this.#uploadId === null) {
      throw this.#failEvent(
        "TRANSITION_INVALID",
        "Artifact chunks require one active receiving upload.",
      );
    }
    const message = event.message;
    let offsetBytes: number;
    try {
      offsetBytes = decimalBytes(message.offsetBytes, maximumResultArtifactBytes - 1);
    } catch {
      throw this.#failEvent("EVENT_INVALID", "Artifact chunk offset is invalid.");
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(message.data, "base64url");
    } catch {
      throw this.#failEvent("EVENT_INVALID", "Artifact chunk encoding is invalid.");
    }
    const expectedEnd = offsetBytes + message.chunkBytes;
    const declaredTotalBytes = decimalBytes(this.#start.totalBytes, maximumResultArtifactBytes);
    if (
      message.artifactId !== this.#start.artifactId ||
      message.chunkIndex !== this.#nextChunkIndex ||
      message.chunkIndex >= maximumResultArtifactChunks ||
      offsetBytes !== this.#nextOffsetBytes ||
      message.chunkBytes > maximumResultArtifactChunkBytes ||
      bytes.byteLength !== message.chunkBytes ||
      expectedEnd > declaredTotalBytes ||
      !isCanonicalResultArtifactChunkData(message.data) ||
      sha256Hex(bytes) !== message.chunkSha256
    ) {
      throw this.#failEvent(
        "EVENT_CONFLICT",
        "Artifact chunk does not extend the exact verified upload prefix.",
      );
    }

    const uploadId = this.#uploadId;
    const request = Object.freeze({
      ...this.#lease,
      chunkIndex: message.chunkIndex,
      offsetBytes,
      chunkBytes: message.chunkBytes,
      chunkSha256: message.chunkSha256,
      data: message.data,
    });
    await this.#perform(
      "put",
      (signal) => this.#api.put(uploadId, message.chunkIndex, request, signal),
      (response) => this.#acceptChunkResponse(response, uploadId, message.chunkIndex, expectedEnd),
    );
    this.#nextChunkIndex = message.chunkIndex + 1;
    this.#nextOffsetBytes = expectedEnd;
  }

  async #acceptEnd(event: ValidatedResultArtifactEndEvent): Promise<void> {
    if (this.#phase !== "receiving" || this.#start === null || this.#uploadId === null) {
      throw this.#failEvent(
        "TRANSITION_INVALID",
        "Artifact finalization requires one active receiving upload.",
      );
    }
    const message = event.message;
    let totalBytes: number;
    try {
      totalBytes = decimalBytes(message.totalBytes, maximumResultArtifactBytes);
    } catch {
      throw this.#failEvent("EVENT_INVALID", "Artifact final byte count is invalid.");
    }
    if (
      message.artifactId !== this.#start.artifactId ||
      message.chunkCount !== this.#nextChunkIndex ||
      message.chunkCount < 1 ||
      message.chunkCount > maximumResultArtifactChunks ||
      totalBytes !== this.#nextOffsetBytes ||
      message.totalBytes !== this.#start.totalBytes ||
      message.sha256 !== this.#start.sha256
    ) {
      throw this.#failEvent(
        "EVENT_CONFLICT",
        "Artifact end does not match the exact uploaded prefix and start identity.",
      );
    }

    this.#phase = "finalizing";
    const uploadId = this.#uploadId;
    const request = Object.freeze({
      ...this.#lease,
      chunkCount: message.chunkCount,
      totalBytes,
      sha256: message.sha256,
    });
    const artifact = await this.#perform(
      "finalize",
      (signal) => this.#api.finalize(uploadId, request, signal),
      (response) => this.#acceptFinalizeResponse(response, uploadId),
    );
    this.#end = message;
    this.#committedArtifact = artifact;
    this.#phase = "committed";
  }

  async #acceptFailed(event: ValidatedResultArtifactFailedEvent): Promise<void> {
    if (this.#phase === "receiving" || this.#phase === "finalizing") {
      if (this.#uploadId === null) {
        throw this.#failEvent("TRANSITION_INVALID", "Active upload identity is unavailable.");
      }
      const uploadId = this.#uploadId;
      const request = Object.freeze({
        ...this.#lease,
        state: "abandoned" as const,
        reason: "client_abandoned" as const,
      });
      await this.#perform(
        "terminate",
        (signal) => this.#api.terminate(uploadId, request, signal),
        (response) => this.#acceptTerminateResponse(response, uploadId),
      );
    }
    this.#terminalType = "Failed";
    this.#terminalFingerprint = event.fingerprint;
    this.#closeWithoutFailure("executor_failed");
  }

  #acceptComplete(event: ValidatedResultArtifactCompleteEvent): void {
    if (
      this.#phase !== "committed" ||
      this.#start === null ||
      this.#end === null ||
      this.#committedArtifact === null
    ) {
      throw this.#failEvent(
        "TRANSITION_INVALID",
        "Executor completion requires a committed result artifact.",
      );
    }
    const message = event.message;
    if (
      message.resultArtifactId !== this.#start.artifactId ||
      message.resultBytes !== this.#end.totalBytes ||
      message.resultSha256 !== this.#end.sha256
    ) {
      throw this.#failEvent(
        "EVENT_CONFLICT",
        "Executor completion does not bind the committed result artifact.",
      );
    }
    this.#terminalType = "Complete";
    this.#terminalFingerprint = event.fingerprint;
    this.#closeWithoutFailure("complete");
  }

  async #closeForShutdown(): Promise<void> {
    if (this.#phase === "closed") return;
    if ((this.#phase === "receiving" || this.#phase === "finalizing") && this.#uploadId !== null) {
      const uploadId = this.#uploadId;
      const request = Object.freeze({
        ...this.#lease,
        state: "abandoned" as const,
        reason: "client_abandoned" as const,
      });
      await this.#perform(
        "terminate",
        (signal) => this.#api.terminate(uploadId, request, signal),
        (response) => this.#acceptTerminateResponse(response, uploadId),
        true,
      );
    }
    this.#closeWithoutFailure("shutdown");
  }

  #acceptCreateResponse(value: CreateResultArtifactUploadResponse): string {
    const snapshot = snapshotResponse(value);
    this.#rejectLeaseTokenReflection(snapshot);
    if (!checkSchema(CreateResultArtifactUploadResponseSchema, snapshot)) {
      throw responseFailure();
    }
    const response = snapshot as CreateResultArtifactUploadResponse;
    if (response.state === "abandoned" || response.state === "corrupt") {
      throw new OperationFailure("definitive", "UPLOAD_IDENTITY_CONSUMED", false);
    }
    if (
      response.state !== "receiving" ||
      response.nextChunkIndex !== 0 ||
      response.nextOffsetBytes !== 0
    ) {
      throw new OperationFailure("definitive", "UPLOAD_RECOVERY_UNSUPPORTED", false);
    }
    return response.uploadId;
  }

  #acceptChunkResponse(
    value: ResultArtifactChunkResponse,
    uploadId: string,
    chunkIndex: number,
    nextOffsetBytes: number,
  ): void {
    const snapshot = snapshotResponse(value);
    this.#rejectLeaseTokenReflection(snapshot);
    if (
      !checkSchema(ResultArtifactChunkResponseSchema, snapshot) ||
      (snapshot as ResultArtifactChunkResponse).uploadId !== uploadId ||
      (snapshot as ResultArtifactChunkResponse).chunkIndex !== chunkIndex
    ) {
      throw responseFailure();
    }
    const response = snapshot as ResultArtifactChunkResponse;
    if (
      response.state !== "receiving" ||
      response.nextChunkIndex !== chunkIndex + 1 ||
      response.nextOffsetBytes !== nextOffsetBytes
    ) {
      throw new OperationFailure("definitive", "UPLOAD_RECOVERY_UNSUPPORTED", false);
    }
  }

  #acceptFinalizeResponse(
    value: FinalizeResultArtifactUploadResponse,
    uploadId: string,
  ): Readonly<CommittedRunArtifact> {
    const snapshot = snapshotResponse(value);
    this.#rejectLeaseTokenReflection(snapshot);
    if (!checkSchema(FinalizeResultArtifactUploadResponseSchema, snapshot)) {
      throw responseFailure();
    }
    const artifact = (snapshot as FinalizeResultArtifactUploadResponse).artifact;
    const start = this.#start;
    if (start === null) throw responseFailure();
    if (
      artifact.uploadId !== uploadId ||
      artifact.clientArtifactId !== this.#clientArtifactId ||
      artifact.jobId !== this.#lease.jobId ||
      artifact.runAttemptId !== this.#lease.runAttemptId ||
      artifact.purpose !== "result" ||
      artifact.name !== start.name ||
      artifact.mediaType !== "application/json" ||
      artifact.totalBytes !== this.#nextOffsetBytes ||
      artifact.sha256 !== start.sha256
    ) {
      throw responseFailure();
    }
    return Object.freeze({ ...artifact });
  }

  #acceptTerminateResponse(value: TerminateResultArtifactUploadResponse, uploadId: string): void {
    const snapshot = snapshotResponse(value);
    this.#rejectLeaseTokenReflection(snapshot);
    if (
      !checkSchema(TerminateResultArtifactUploadResponseSchema, snapshot) ||
      (snapshot as TerminateResultArtifactUploadResponse).uploadId !== uploadId ||
      (snapshot as TerminateResultArtifactUploadResponse).state !== "abandoned" ||
      (snapshot as TerminateResultArtifactUploadResponse).reason !== "client_abandoned"
    ) {
      throw responseFailure();
    }
  }

  #rejectLeaseTokenReflection(value: unknown): void {
    if (containsString(value, this.#lease.leaseToken)) {
      throw new OperationFailure("ambiguous", "RESPONSE_SECRET_REFLECTION", false);
    }
  }

  async #perform<TResponse, TResult = void>(
    operation: ResultArtifactUploadOperation,
    invoke: (signal: AbortSignal) => Promise<TResponse>,
    applyResponse: (response: TResponse) => TResult,
    allowDuringShutdown = false,
  ): Promise<TResult> {
    let lastFailure: ClassifiedFailure | undefined;
    let retainedAmbiguity: ClassifiedFailure | undefined;
    for (let attempt = 1; attempt <= this.#retryPolicy.maximumAttempts; attempt += 1) {
      const deadline = this.#effectiveDeadline(allowDuringShutdown);
      let now: number;
      try {
        now = this.#observeNow();
      } catch (error) {
        throw this.#closeFromOperationFailure(
          operation,
          retainedAmbiguity ?? classifyFailure(error),
          attempt - 1,
        );
      }
      if (now >= deadline) {
        if (lastFailure !== undefined) {
          throw this.#closeFromOperationFailure(
            operation,
            retainedAmbiguity ?? lastFailure,
            attempt - 1,
          );
        }
        throw this.#closeFromOperationFailure(
          operation,
          { kind: "lease_revoked", code: "DEADLINE_EXPIRED", retryable: false },
          0,
          "DEADLINE_EXPIRED",
        );
      }
      if (this.#shutdownRequested && !allowDuringShutdown) {
        const shutdownFailure: ClassifiedFailure = {
          kind: "ambiguous",
          code: "SHUTDOWN_INTERRUPTED",
          retryable: false,
        };
        throw this.#closeFromOperationFailure(
          operation,
          retainedAmbiguity ?? shutdownFailure,
          attempt - 1,
        );
      }

      try {
        const response = await this.#dispatch(invoke, deadline, now);
        let responseNow: number;
        try {
          responseNow = this.#observeNow();
        } catch {
          throw new OperationFailure("ambiguous", "MONOTONIC_CLOCK_INVALID_AFTER_DISPATCH", false);
        }
        if (
          responseNow >= Math.min(deadline, this.#effectiveDeadline(allowDuringShutdown)) ||
          (this.#shutdownRequested && !allowDuringShutdown)
        ) {
          throw new OperationFailure(
            "ambiguous",
            this.#shutdownRequested
              ? "SHUTDOWN_INTERRUPTED_AFTER_DISPATCH"
              : "AUTHORITY_EXPIRED_AFTER_DISPATCH",
            false,
          );
        }
        const result = applyResponse(response);
        let appliedAt: number;
        try {
          appliedAt = this.#observeNow();
        } catch {
          throw new OperationFailure("ambiguous", "MONOTONIC_CLOCK_INVALID_AFTER_RESPONSE", false);
        }
        if (
          appliedAt >= Math.min(deadline, this.#effectiveDeadline(allowDuringShutdown)) ||
          (this.#shutdownRequested && !allowDuringShutdown)
        ) {
          throw new OperationFailure(
            "ambiguous",
            this.#shutdownRequested
              ? "SHUTDOWN_INTERRUPTED_AFTER_RESPONSE"
              : "AUTHORITY_EXPIRED_AFTER_RESPONSE",
            false,
          );
        }
        return result;
      } catch (error) {
        const failure = classifyFailure(error);
        lastFailure = failure;
        if (failure.kind === "ambiguous" && retainedAmbiguity === undefined) {
          retainedAmbiguity = failure;
        }
        if (
          failure.kind === "lease_revoked" ||
          !failure.retryable ||
          attempt >= this.#retryPolicy.maximumAttempts ||
          (this.#shutdownRequested && !allowDuringShutdown)
        ) {
          throw this.#closeFromOperationFailure(operation, retainedAmbiguity ?? failure, attempt);
        }

        const delay = retryDelay(this.#retryPolicy, attempt);
        const currentDeadline = this.#effectiveDeadline(allowDuringShutdown);
        let retryNow: number;
        try {
          retryNow = this.#observeNow();
        } catch (clockError) {
          throw this.#closeFromOperationFailure(
            operation,
            retainedAmbiguity ?? classifyFailure(clockError),
            attempt,
          );
        }
        if (retryNow + delay >= currentDeadline) {
          throw this.#closeFromOperationFailure(operation, retainedAmbiguity ?? failure, attempt);
        }
        try {
          await this.#waitInterruptibly(delay, allowDuringShutdown);
        } catch {
          if (this.#shutdownRequested && !allowDuringShutdown && retainedAmbiguity === undefined) {
            throw sessionError(
              "SESSION_CLOSED",
              "Result artifact upload retry yielded to orderly shutdown.",
            );
          }
          throw this.#closeFromOperationFailure(operation, retainedAmbiguity ?? failure, attempt);
        }
      }
    }
    throw new Error("Unreachable result artifact upload retry state.");
  }

  async #dispatch<T>(
    invoke: (signal: AbortSignal) => Promise<T>,
    deadline: number,
    startedAt: number,
  ): Promise<T> {
    const controller = new AbortController();
    let interrupt: ((error: DispatchInterrupted) => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = reject;
    });
    const remaining = Math.max(1, Math.ceil(deadline - startedAt));
    const timer = setTimeout(() => {
      controller.abort();
      interrupt?.(new DispatchInterrupted("deadline"));
    }, remaining);
    timer.unref();
    this.#interruptActive = (reason) => {
      controller.abort();
      interrupt?.(new DispatchInterrupted(reason));
    };
    try {
      const operation = invoke(controller.signal);
      return await Promise.race([operation, interrupted]);
    } finally {
      clearTimeout(timer);
      this.#interruptActive = undefined;
    }
  }

  async #waitInterruptibly(delay: number, allowDuringShutdown: boolean): Promise<void> {
    const controller = new AbortController();
    let interrupt: ((error: DispatchInterrupted) => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = reject;
    });
    this.#interruptActive = (reason) => {
      controller.abort();
      interrupt?.(new DispatchInterrupted(reason));
    };
    if (this.#shutdownRequested && !allowDuringShutdown) {
      this.#interruptActive("shutdown");
    }
    try {
      await Promise.race([this.#wait(delay, controller.signal), interrupted]);
    } finally {
      this.#interruptActive = undefined;
    }
  }

  #effectiveDeadline(allowDuringShutdown: boolean): number {
    const authorityDeadline = Math.min(this.#leaseDeadline, this.#hardDeadline);
    return allowDuringShutdown && this.#shutdownDeadline !== undefined
      ? Math.min(authorityDeadline, this.#shutdownDeadline)
      : authorityDeadline;
  }

  #observeNow(): number {
    const observed = requireMonotonicObservation(this.#nowSource());
    if (observed < this.#lastObservedMonotonicMilliseconds) {
      throw new OperationFailure("definitive", "MONOTONIC_CLOCK_INVALID", false);
    }
    this.#lastObservedMonotonicMilliseconds = observed;
    return observed;
  }

  #closeFromOperationFailure(
    operation: ResultArtifactUploadOperation,
    classified: ClassifiedFailure,
    attempts: number,
    errorCode: ResultArtifactUploadSessionError["code"] = "UPLOAD_FAILED",
  ): ResultArtifactUploadSessionError {
    const reflectsLeaseToken = classified.code.includes(this.#lease.leaseToken);
    const failure = Object.freeze({
      kind: reflectsLeaseToken ? ("ambiguous" as const) : classified.kind,
      operation,
      code: reflectsLeaseToken ? "FAILURE_SECRET_REFLECTION" : classified.code,
      attempts,
    });
    this.#failure = failure;
    this.#closure = "upload_failed";
    this.#phase = "closed";
    return sessionError(errorCode, "Result artifact upload session failed closed.", failure);
  }

  #failEvent(
    code: "EVENT_CONFLICT" | "EVENT_INVALID" | "TRANSITION_INVALID",
    message: string,
  ): ResultArtifactUploadSessionError {
    this.#closure = "upload_failed";
    this.#phase = "closed";
    return sessionError(code, message);
  }

  #closeWithoutFailure(closure: Exclude<ResultArtifactUploadClosure, "upload_failed">): void {
    this.#closure = closure;
    this.#phase = "closed";
  }

  #validateEvent(event: Readonly<ResultArtifactUploadEvent>): ValidatedResultArtifactUploadEvent {
    assertPlainRecord(event, ["message", "type"]);
    let message: DeepReadonly<
      | ArtifactStartMessage
      | ArtifactChunkMessage
      | ArtifactEndMessage
      | FailedMessage
      | CompleteMessage
    >;
    switch (event.type) {
      case "ArtifactStart":
        message = validateLocalMessagePayload(
          LocalMessageType.ArtifactStart,
          event.message,
          this.#context.attemptCorrelationId,
        ) as DeepReadonly<ArtifactStartMessage>;
        break;
      case "ArtifactChunk":
        message = validateLocalMessagePayload(
          LocalMessageType.ArtifactChunk,
          event.message,
          this.#context.attemptCorrelationId,
        ) as DeepReadonly<ArtifactChunkMessage>;
        break;
      case "ArtifactEnd":
        message = validateLocalMessagePayload(
          LocalMessageType.ArtifactEnd,
          event.message,
          this.#context.attemptCorrelationId,
        ) as DeepReadonly<ArtifactEndMessage>;
        break;
      case "Failed":
        message = validateLocalMessagePayload(
          LocalMessageType.Failed,
          event.message,
          this.#context.attemptCorrelationId,
        ) as DeepReadonly<FailedMessage>;
        break;
      case "Complete":
        message = validateLocalMessagePayload(
          LocalMessageType.Complete,
          event.message,
          this.#context.attemptCorrelationId,
        ) as DeepReadonly<CompleteMessage>;
        break;
      default:
        throw new TypeError("Unknown result artifact upload event type.");
    }
    assertEventContext(message, this.#context);
    return Object.freeze({
      type: event.type,
      message,
      fingerprint: createCanonicalJsonDocument(message).sha256,
    }) as ValidatedResultArtifactUploadEvent;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function snapshotSessionOptions(
  value: Readonly<ResultArtifactUploadSessionOptions>,
): Readonly<SnapshottedResultArtifactUploadSessionOptions> {
  const record = snapshotPlainRecord(
    value,
    [
      "api",
      "context",
      "hardDeadlineMonotonicMilliseconds",
      "lease",
      "leaseDeadlineMonotonicMilliseconds",
    ],
    ["dependencies", "retryPolicy"],
  );
  const dependencies =
    record.dependencies === undefined
      ? Object.freeze({})
      : snapshotDependencies(record.dependencies);
  return Object.freeze({
    api: record.api as ResultArtifactUploadApi,
    context: record.context as Readonly<ResultArtifactUploadContext>,
    lease: record.lease as Readonly<LeaseIdentity>,
    leaseDeadlineMonotonicMilliseconds: record.leaseDeadlineMonotonicMilliseconds as number,
    hardDeadlineMonotonicMilliseconds: record.hardDeadlineMonotonicMilliseconds as number,
    retryPolicy: record.retryPolicy as Readonly<ResultArtifactUploadRetryPolicy> | undefined,
    dependencies,
  });
}

function snapshotDependencies(value: unknown): Readonly<ResultArtifactUploadSessionDependencies> {
  const record = snapshotPlainRecord(value, [], ["now", "wait"]);
  if (
    (record.now !== undefined && typeof record.now !== "function") ||
    (record.wait !== undefined && typeof record.wait !== "function")
  ) {
    throw new TypeError("Result artifact upload dependencies are invalid.");
  }
  return Object.freeze({
    ...(record.now === undefined ? {} : { now: record.now as () => number }),
    ...(record.wait === undefined
      ? {}
      : {
          wait: record.wait as (delayMilliseconds: number, signal: AbortSignal) => Promise<void>,
        }),
  });
}

function snapshotUploadApi(value: ResultArtifactUploadApi): ResultArtifactUploadApi {
  const record = snapshotPlainRecord(value, ["create", "finalize", "put", "terminate"]);
  const create = record.create;
  const put = record.put;
  const finalize = record.finalize;
  const terminate = record.terminate;
  if (
    typeof create !== "function" ||
    typeof put !== "function" ||
    typeof finalize !== "function" ||
    typeof terminate !== "function"
  ) {
    throw new TypeError("Result artifact upload API is invalid.");
  }
  const owner = value;
  return Object.freeze({
    create: (runAttemptId, request, signal) =>
      Reflect.apply(create, owner, [
        runAttemptId,
        request,
        signal,
      ]) as Promise<CreateResultArtifactUploadResponse>,
    put: (uploadId, chunkIndex, request, signal) =>
      Reflect.apply(put, owner, [
        uploadId,
        chunkIndex,
        request,
        signal,
      ]) as Promise<ResultArtifactChunkResponse>,
    finalize: (uploadId, request, signal) =>
      Reflect.apply(finalize, owner, [
        uploadId,
        request,
        signal,
      ]) as Promise<FinalizeResultArtifactUploadResponse>,
    terminate: (uploadId, request, signal) =>
      Reflect.apply(terminate, owner, [
        uploadId,
        request,
        signal,
      ]) as Promise<TerminateResultArtifactUploadResponse>,
  } satisfies ResultArtifactUploadApi);
}

function snapshotContext(
  value: Readonly<ResultArtifactUploadContext>,
): Readonly<ResultArtifactUploadContext> {
  const record = snapshotPlainRecord(value, [
    "attemptCorrelationId",
    "executorBootId",
    "protocolMajor",
    "protocolMinor",
    "runAttemptId",
    "sessionId",
    "workerInstanceId",
    "workerNodeId",
  ]);
  if (
    record.protocolMajor !== 1 ||
    record.protocolMinor !== 0 ||
    typeof record.workerNodeId !== "string" ||
    !isEntityId(record.workerNodeId) ||
    typeof record.workerInstanceId !== "string" ||
    !isEntityId(record.workerInstanceId) ||
    typeof record.executorBootId !== "string" ||
    !isUuidV4(record.executorBootId) ||
    typeof record.sessionId !== "string" ||
    !isUuidV4(record.sessionId) ||
    typeof record.attemptCorrelationId !== "string" ||
    !isUuidV4(record.attemptCorrelationId) ||
    typeof record.runAttemptId !== "string" ||
    !isEntityId(record.runAttemptId)
  ) {
    throw new TypeError("Result artifact upload context is invalid.");
  }
  return Object.freeze({
    protocolMajor: record.protocolMajor,
    protocolMinor: record.protocolMinor,
    workerNodeId: record.workerNodeId,
    workerInstanceId: record.workerInstanceId,
    executorBootId: record.executorBootId,
    sessionId: record.sessionId,
    attemptCorrelationId: record.attemptCorrelationId,
    runAttemptId: record.runAttemptId,
  });
}

function snapshotLease(value: Readonly<LeaseIdentity>): Readonly<LeaseIdentity> {
  const record = snapshotPlainRecord(value, [
    "jobId",
    "leaseGeneration",
    "leaseToken",
    "runAttemptId",
    "workerInstanceId",
    "workerNodeId",
  ]);
  if (
    typeof record.jobId !== "string" ||
    !isEntityId(record.jobId) ||
    typeof record.runAttemptId !== "string" ||
    !isEntityId(record.runAttemptId) ||
    typeof record.workerNodeId !== "string" ||
    !isEntityId(record.workerNodeId) ||
    typeof record.workerInstanceId !== "string" ||
    !isEntityId(record.workerInstanceId) ||
    typeof record.leaseToken !== "string" ||
    record.leaseToken.length < 32 ||
    record.leaseToken.length > 1_024 ||
    !Number.isSafeInteger(record.leaseGeneration) ||
    (record.leaseGeneration as number) < 1
  ) {
    throw new TypeError("Result artifact upload lease is invalid.");
  }
  return Object.freeze({
    jobId: record.jobId,
    runAttemptId: record.runAttemptId,
    workerNodeId: record.workerNodeId,
    workerInstanceId: record.workerInstanceId,
    leaseToken: record.leaseToken,
    leaseGeneration: record.leaseGeneration as number,
  });
}

function assertContextMatchesLease(
  context: Readonly<ResultArtifactUploadContext>,
  lease: Readonly<LeaseIdentity>,
): void {
  if (
    context.runAttemptId !== lease.runAttemptId ||
    context.workerNodeId !== lease.workerNodeId ||
    context.workerInstanceId !== lease.workerInstanceId
  ) {
    throw new TypeError("Result artifact upload context and lease identities do not match.");
  }
}

function snapshotRetryPolicy(
  value: Readonly<ResultArtifactUploadRetryPolicy>,
): Readonly<ResultArtifactUploadRetryPolicy> {
  const record = snapshotPlainRecord(value, [
    "initialDelayMilliseconds",
    "maximumAttempts",
    "maximumDelayMilliseconds",
  ]);
  if (
    !Number.isSafeInteger(record.maximumAttempts) ||
    (record.maximumAttempts as number) < 1 ||
    (record.maximumAttempts as number) > 8 ||
    !Number.isSafeInteger(record.initialDelayMilliseconds) ||
    (record.initialDelayMilliseconds as number) < 1 ||
    !Number.isSafeInteger(record.maximumDelayMilliseconds) ||
    (record.maximumDelayMilliseconds as number) < (record.initialDelayMilliseconds as number) ||
    (record.maximumDelayMilliseconds as number) > 30_000
  ) {
    throw new TypeError("Result artifact upload retry policy is invalid.");
  }
  return Object.freeze({
    maximumAttempts: record.maximumAttempts as number,
    initialDelayMilliseconds: record.initialDelayMilliseconds as number,
    maximumDelayMilliseconds: record.maximumDelayMilliseconds as number,
  });
}

function assertEventContext(
  message: DeepReadonly<
    | ArtifactStartMessage
    | ArtifactChunkMessage
    | ArtifactEndMessage
    | FailedMessage
    | CompleteMessage
  >,
  expected: Readonly<ResultArtifactUploadContext>,
): void {
  if (
    message.protocolMajor !== expected.protocolMajor ||
    message.protocolMinor !== expected.protocolMinor ||
    message.workerNodeId !== expected.workerNodeId ||
    message.workerInstanceId !== expected.workerInstanceId ||
    message.executorBootId !== expected.executorBootId ||
    message.sessionId !== expected.sessionId ||
    message.attemptCorrelationId !== expected.attemptCorrelationId ||
    message.runAttemptId !== expected.runAttemptId
  ) {
    throw new TypeError("Result artifact upload event belongs to another execution context.");
  }
}

function classifyFailure(error: unknown): ClassifiedFailure {
  if (error instanceof OperationFailure || error instanceof ResultArtifactUploadApiError) {
    return Object.freeze({ kind: error.kind, code: error.code, retryable: error.retryable });
  }
  if (error instanceof DispatchInterrupted) {
    return Object.freeze({
      kind: "ambiguous",
      code: error.reason === "shutdown" ? "SHUTDOWN_INTERRUPTED" : "DISPATCH_DEADLINE_EXPIRED",
      retryable: false,
    });
  }
  return Object.freeze({ kind: "ambiguous", code: "OUTCOME_UNKNOWN", retryable: true });
}

function responseFailure(): OperationFailure {
  return new OperationFailure("ambiguous", "RESPONSE_INVALID", true);
}

function retryDelay(
  policy: Readonly<ResultArtifactUploadRetryPolicy>,
  failedAttempt: number,
): number {
  const multiplier = 2 ** Math.min(failedAttempt - 1, 30);
  return Math.min(policy.maximumDelayMilliseconds, policy.initialDelayMilliseconds * multiplier);
}

function decimalBytes(value: string, maximum: number): number {
  if (!/^(?:0|[1-9][0-9]{0,20})$/u.test(value)) {
    throw sessionError("EVENT_INVALID", "Artifact byte count is invalid.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw sessionError("EVENT_INVALID", "Artifact byte count exceeds the supported range.");
  }
  return parsed;
}

function checkSchema(schema: Parameters<typeof Value.Check>[0], value: unknown): boolean {
  try {
    return Value.Check(schema, value);
  } catch {
    return false;
  }
}

function snapshotResponse(value: unknown): unknown {
  try {
    return snapshotResponseValue(value, { nodes: 0 }, 0);
  } catch {
    throw responseFailure();
  }
}

function containsString(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((nested) => containsString(nested, needle));
}

function snapshotResponseValue(value: unknown, budget: { nodes: number }, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Artifact upload response number is invalid.");
    return value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 16 * 1024) {
      throw new TypeError("Artifact upload response string is too large.");
    }
    return value;
  }
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    depth >= 8
  ) {
    throw new TypeError("Artifact upload response is not bounded plain JSON.");
  }
  budget.nodes += 1;
  if (budget.nodes > 128) throw new TypeError("Artifact upload response is too complex.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length > 64) throw new TypeError("Artifact upload response has too many fields.");
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      key.length > 256 ||
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      !descriptor.enumerable
    ) {
      throw new TypeError("Artifact upload response field is invalid.");
    }
    snapshot[key] = snapshotResponseValue(descriptor.value, budget, depth + 1);
  }
  return Object.freeze(snapshot);
}

function freezeState(value: ResultArtifactUploadState): Readonly<ResultArtifactUploadState> {
  return Object.freeze({ ...value });
}

function requireMonotonicDeadline(value: number, description: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`Result artifact upload ${description} is invalid.`);
  }
  return value;
}

function requireMonotonicObservation(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new OperationFailure("definitive", "MONOTONIC_CLOCK_INVALID", false);
  }
  return value;
}

function assertFailureCode(value: string): void {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value)) {
    throw new TypeError("Result artifact upload failure code is invalid.");
  }
}

function assertPlainRecord(value: object, expectedKeys: readonly string[]): void {
  snapshotPlainRecord(value, expectedKeys);
}

function snapshotPlainRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError("Result artifact upload input must be a plain object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  const required = new Set(requiredKeys);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some((key) => !allowed.has(key)) ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return (
        descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable
      );
    })
  ) {
    throw new TypeError("Result artifact upload input shape is invalid.");
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("Result artifact upload input shape is invalid.");
    }
    snapshot[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(snapshot, key)) {
      throw new TypeError("Result artifact upload input shape is invalid.");
    }
  }
  return Object.freeze(snapshot);
}

function isEntityId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function sessionError(
  code: ResultArtifactUploadSessionError["code"],
  message: string,
  failure?: Readonly<ResultArtifactUploadFailure>,
): ResultArtifactUploadSessionError {
  return new ResultArtifactUploadSessionError(code, message, failure);
}

async function waitForDelay(delayMilliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DispatchInterrupted("shutdown");
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMilliseconds);
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new DispatchInterrupted("shutdown"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
