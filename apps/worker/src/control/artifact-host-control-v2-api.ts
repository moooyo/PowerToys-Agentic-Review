import {
  type ArtifactRunCompletionSubmission,
  ArtifactRunCompletionSubmissionSchema,
  type CreateResultArtifactUploadRequest,
  CreateResultArtifactUploadRequestSchema,
  type CreateResultArtifactUploadResponse,
  CreateResultArtifactUploadResponseSchema,
  type FinalizeResultArtifactUploadRequest,
  FinalizeResultArtifactUploadRequestSchema,
  type FinalizeResultArtifactUploadResponse,
  FinalizeResultArtifactUploadResponseSchema,
  maximumResultArtifactChunkRequestBytes,
  maximumResultArtifactControlRequestBytes,
  type ResultArtifactChunkRequest,
  ResultArtifactChunkRequestSchema,
  type ResultArtifactChunkResponse,
  ResultArtifactChunkResponseSchema,
  type RunTerminalResponse,
  RunTerminalResponseSchema,
  type TerminateResultArtifactUploadRequest,
  TerminateResultArtifactUploadRequestSchema,
  type TerminateResultArtifactUploadResponse,
  TerminateResultArtifactUploadResponseSchema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import { snapshotArtifactHostControlV2RemoteError } from "../service-host/artifact-host-control-v2-protocol.js";
import {
  encodeHostControlOpaqueJson,
  type HostControlOpaqueJsonDescriptor,
} from "../service-host/opaque-json.js";

export type ArtifactHostControlV2FailureKind = "definitive" | "ambiguous" | "lease_revoked";

export interface ArtifactHostControlV2CallOptions {
  readonly signal?: AbortSignal;
}

export interface ArtifactHostControlV2Port {
  createArtifactUpload(
    runAttemptId: string,
    body: Readonly<HostControlOpaqueJsonDescriptor>,
    options?: Readonly<ArtifactHostControlV2CallOptions>,
  ): Promise<unknown>;
  putArtifactChunk(
    uploadId: string,
    chunkIndex: number,
    body: Readonly<HostControlOpaqueJsonDescriptor>,
    options?: Readonly<ArtifactHostControlV2CallOptions>,
  ): Promise<unknown>;
  finalizeArtifactUpload(
    uploadId: string,
    body: Readonly<HostControlOpaqueJsonDescriptor>,
    options?: Readonly<ArtifactHostControlV2CallOptions>,
  ): Promise<unknown>;
  terminateArtifactUpload(
    uploadId: string,
    body: Readonly<HostControlOpaqueJsonDescriptor>,
    options?: Readonly<ArtifactHostControlV2CallOptions>,
  ): Promise<unknown>;
  completeArtifactRun(
    runAttemptId: string,
    body: Readonly<HostControlOpaqueJsonDescriptor>,
    options?: Readonly<ArtifactHostControlV2CallOptions>,
  ): Promise<unknown>;
}

export class ArtifactHostControlV2ApiError extends Error {
  readonly #kind: ArtifactHostControlV2FailureKind;
  readonly #code: string;
  readonly #retryable: boolean;

  public constructor(kind: ArtifactHostControlV2FailureKind, code: string, retryable: boolean) {
    super("Artifact HostControl v2 API operation failed.");
    if (
      !isFailureKind(kind) ||
      !isErrorCode(code) ||
      typeof retryable !== "boolean" ||
      (kind === "lease_revoked" && retryable)
    ) {
      throw new TypeError("Artifact HostControl v2 API error classification is invalid.");
    }
    this.name = "ArtifactHostControlV2ApiError";
    this.#kind = kind;
    this.#code = code;
    this.#retryable = retryable;
    Object.freeze(this);
  }

  public get kind(): ArtifactHostControlV2FailureKind {
    return this.#kind;
  }

  public get code(): string {
    return this.#code;
  }

  public get retryable(): boolean {
    return this.#retryable;
  }
}
Object.freeze(ArtifactHostControlV2ApiError.prototype);

/**
 * Maps artifact contracts to the dormant five-operation HostControl v2 port. It owns no pipe,
 * origin, HTTP method, header, certificate selector, retry loop, or completion-mode decision.
 */
export class ArtifactHostControlV2Api {
  readonly #port: ArtifactHostControlV2Port;

  public constructor(port: ArtifactHostControlV2Port) {
    registerWorkerContractFormats();
    this.#port = snapshotPort(port);
  }

  public async create(
    runAttemptId: string,
    request: Readonly<CreateResultArtifactUploadRequest>,
    signal?: AbortSignal,
  ): Promise<CreateResultArtifactUploadResponse> {
    const input = validateRequest<CreateResultArtifactUploadRequest>(
      CreateResultArtifactUploadRequestSchema,
      request,
    );
    assertRouteIdentity(runAttemptId, input.runAttemptId);
    const body = encodeRequest(input, maximumResultArtifactControlRequestBytes);
    const response = await callPort(
      () => this.#port.createArtifactUpload(runAttemptId, body, callOptions(signal)),
      input.leaseToken,
    );
    return validateResponse(
      CreateResultArtifactUploadResponseSchema,
      response,
      "artifact create",
      input.leaseToken,
    ) as CreateResultArtifactUploadResponse;
  }

  public async put(
    uploadId: string,
    chunkIndex: number,
    request: Readonly<ResultArtifactChunkRequest>,
    signal?: AbortSignal,
  ): Promise<ResultArtifactChunkResponse> {
    assertEntityId(uploadId);
    const input = validateRequest<ResultArtifactChunkRequest>(
      ResultArtifactChunkRequestSchema,
      request,
    );
    if (chunkIndex !== input.chunkIndex) {
      throw requestError("artifact_chunk_index_mismatch");
    }
    const body = encodeRequest(input, maximumResultArtifactChunkRequestBytes);
    const response = validateResponse(
      ResultArtifactChunkResponseSchema,
      await callPort(
        () => this.#port.putArtifactChunk(uploadId, chunkIndex, body, callOptions(signal)),
        input.leaseToken,
      ),
      "artifact chunk",
      input.leaseToken,
    ) as ResultArtifactChunkResponse;
    if (response.uploadId !== uploadId || response.chunkIndex !== chunkIndex) {
      throw responseError();
    }
    return response;
  }

  public async finalize(
    uploadId: string,
    request: Readonly<FinalizeResultArtifactUploadRequest>,
    signal?: AbortSignal,
  ): Promise<FinalizeResultArtifactUploadResponse> {
    assertEntityId(uploadId);
    const input = validateRequest<FinalizeResultArtifactUploadRequest>(
      FinalizeResultArtifactUploadRequestSchema,
      request,
    );
    const body = encodeRequest(input, maximumResultArtifactControlRequestBytes);
    const response = validateResponse(
      FinalizeResultArtifactUploadResponseSchema,
      await callPort(
        () => this.#port.finalizeArtifactUpload(uploadId, body, callOptions(signal)),
        input.leaseToken,
      ),
      "artifact finalize",
      input.leaseToken,
    ) as FinalizeResultArtifactUploadResponse;
    if (
      response.artifact.uploadId !== uploadId ||
      response.artifact.jobId !== input.jobId ||
      response.artifact.runAttemptId !== input.runAttemptId ||
      response.artifact.totalBytes !== input.totalBytes ||
      response.artifact.sha256 !== input.sha256
    ) {
      throw responseError();
    }
    return response;
  }

  public async terminate(
    uploadId: string,
    request: Readonly<TerminateResultArtifactUploadRequest>,
    signal?: AbortSignal,
  ): Promise<TerminateResultArtifactUploadResponse> {
    assertEntityId(uploadId);
    const input = validateRequest<TerminateResultArtifactUploadRequest>(
      TerminateResultArtifactUploadRequestSchema,
      request,
    );
    const body = encodeRequest(input, maximumResultArtifactControlRequestBytes);
    const response = validateResponse(
      TerminateResultArtifactUploadResponseSchema,
      await callPort(
        () => this.#port.terminateArtifactUpload(uploadId, body, callOptions(signal)),
        input.leaseToken,
      ),
      "artifact terminate",
      input.leaseToken,
    ) as TerminateResultArtifactUploadResponse;
    if (response.uploadId !== uploadId) throw responseError();
    return response;
  }

  public async completeArtifactRun(
    runAttemptId: string,
    request: Readonly<ArtifactRunCompletionSubmission>,
    signal?: AbortSignal,
  ): Promise<RunTerminalResponse> {
    const input = validateRequest<ArtifactRunCompletionSubmission>(
      ArtifactRunCompletionSubmissionSchema,
      request,
    );
    assertRouteIdentity(runAttemptId, input.runAttemptId);
    const body = encodeRequest(input, maximumResultArtifactControlRequestBytes);
    const response = validateResponse(
      RunTerminalResponseSchema,
      await callPort(
        () => this.#port.completeArtifactRun(runAttemptId, body, callOptions(signal)),
        input.leaseToken,
      ),
      "artifact run completion",
      input.leaseToken,
    ) as RunTerminalResponse;
    if (response.jobId !== input.jobId || response.runAttemptId !== runAttemptId) {
      throw responseError();
    }
    return response;
  }
}

function snapshotPort(value: ArtifactHostControlV2Port): ArtifactHostControlV2Port {
  const methods = [
    "completeArtifactRun",
    "createArtifactUpload",
    "finalizeArtifactUpload",
    "putArtifactChunk",
    "terminateArtifactUpload",
  ] as const;
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("Artifact HostControl v2 port must be a plain object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).length !== methods.length ||
    methods.some((name) => {
      const descriptor = descriptors[name];
      return (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        !descriptor.enumerable ||
        typeof descriptor.value !== "function"
      );
    })
  ) {
    throw new TypeError("Artifact HostControl v2 port surface is invalid.");
  }
  const owner = value;
  const completeArtifactRun = descriptors.completeArtifactRun
    ?.value as ArtifactHostControlV2Port["completeArtifactRun"];
  const createArtifactUpload = descriptors.createArtifactUpload
    ?.value as ArtifactHostControlV2Port["createArtifactUpload"];
  const finalizeArtifactUpload = descriptors.finalizeArtifactUpload
    ?.value as ArtifactHostControlV2Port["finalizeArtifactUpload"];
  const putArtifactChunk = descriptors.putArtifactChunk
    ?.value as ArtifactHostControlV2Port["putArtifactChunk"];
  const terminateArtifactUpload = descriptors.terminateArtifactUpload
    ?.value as ArtifactHostControlV2Port["terminateArtifactUpload"];
  return Object.freeze({
    completeArtifactRun: (runAttemptId, body, options) =>
      Reflect.apply(completeArtifactRun, owner, [runAttemptId, body, options]) as Promise<unknown>,
    createArtifactUpload: (runAttemptId, body, options) =>
      Reflect.apply(createArtifactUpload, owner, [runAttemptId, body, options]) as Promise<unknown>,
    finalizeArtifactUpload: (uploadId, body, options) =>
      Reflect.apply(finalizeArtifactUpload, owner, [uploadId, body, options]) as Promise<unknown>,
    putArtifactChunk: (uploadId, chunkIndex, body, options) =>
      Reflect.apply(putArtifactChunk, owner, [
        uploadId,
        chunkIndex,
        body,
        options,
      ]) as Promise<unknown>,
    terminateArtifactUpload: (uploadId, body, options) =>
      Reflect.apply(terminateArtifactUpload, owner, [uploadId, body, options]) as Promise<unknown>,
  } satisfies ArtifactHostControlV2Port);
}

function validateRequest<T>(
  schema: Parameters<typeof Value.Check>[0],
  value: unknown,
): Readonly<T> {
  try {
    const snapshot = snapshotJson(value, { nodes: 0 }, 0);
    if (!Value.Check(schema, snapshot)) throw new Error("invalid contract");
    return snapshot as Readonly<T>;
  } catch {
    throw requestError("artifact_request_invalid");
  }
}

function encodeRequest(
  value: unknown,
  maximumBytes: number,
): Readonly<HostControlOpaqueJsonDescriptor> {
  try {
    return encodeHostControlOpaqueJson(value, maximumBytes);
  } catch {
    throw requestError("artifact_request_invalid");
  }
}

async function callPort(operation: () => Promise<unknown>, leaseToken: string): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const remote = snapshotArtifactHostControlV2RemoteError(error);
    if (remote !== undefined) {
      if (remote.code.includes(leaseToken)) {
        throw apiError("ambiguous", "artifact_error_code_invalid", false);
      }
      if (remote.code === "lease_lost") {
        throw apiError("lease_revoked", remote.code, false);
      }
      if (remote.code === "artifact_outcome_unknown") {
        throw apiError("ambiguous", remote.code, remote.retryable);
      }
      throw apiError("definitive", remote.code, remote.retryable);
    }
    throw apiError("ambiguous", "artifact_outcome_unknown", true);
  }
}

function validateResponse(
  schema: Parameters<typeof Value.Check>[0],
  value: unknown,
  _description: string,
  leaseToken: string,
): unknown {
  let snapshot: unknown;
  try {
    snapshot = snapshotJson(value, { nodes: 0 }, 0);
    if (containsString(snapshot, leaseToken)) throw new Error("secret reflection");
    if (!Value.Check(schema, snapshot)) throw new Error("invalid response");
  } catch {
    throw responseError();
  }
  return snapshot;
}

function containsString(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((nested) => containsString(nested, needle));
}

function snapshotJson(value: unknown, budget: { nodes: number }, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("nonfinite response number");
    return value;
  }
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    depth >= 8
  ) {
    throw new TypeError("response is not bounded plain JSON");
  }
  budget.nodes += 1;
  if (budget.nodes > 128) throw new TypeError("response is too complex");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 64) throw new TypeError("response has too many fields");
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !Object.hasOwn(descriptor, "value") ||
      !descriptor.enumerable ||
      Buffer.byteLength(key, "utf8") > 256
    ) {
      throw new TypeError("response field is invalid");
    }
    result[key] = snapshotJson(descriptor.value, budget, depth + 1);
  }
  return Object.freeze(result);
}

function callOptions(
  signal: AbortSignal | undefined,
): Readonly<ArtifactHostControlV2CallOptions> | undefined {
  return signal === undefined ? undefined : Object.freeze({ signal });
}

function assertRouteIdentity(routeId: string, bodyId: string): void {
  assertEntityId(routeId);
  if (routeId !== bodyId) throw requestError("run_attempt_mismatch");
}

function assertEntityId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw requestError("artifact_route_identity_invalid");
  }
}

function requestError(code: string): ArtifactHostControlV2ApiError {
  return apiError("definitive", code, false);
}

function responseError(): ArtifactHostControlV2ApiError {
  return apiError("ambiguous", "artifact_response_invalid", true);
}

function apiError(
  kind: ArtifactHostControlV2FailureKind,
  code: string,
  retryable: boolean,
): ArtifactHostControlV2ApiError {
  return new ArtifactHostControlV2ApiError(kind, code, retryable);
}

function isFailureKind(value: unknown): value is ArtifactHostControlV2FailureKind {
  return value === "definitive" || value === "ambiguous" || value === "lease_revoked";
}

function isErrorCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value);
}
