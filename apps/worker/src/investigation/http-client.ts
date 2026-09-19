import { createHash } from "node:crypto";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { createSecureContext, type SecureContext, type SecureContextOptions } from "node:tls";
import {
  EntityIdSchema,
  ErrorDetailsSchema,
  type InvestigationArtifactContentRequest,
  InvestigationArtifactContentRequestSchema,
  type InvestigationArtifactContentResponse,
  InvestigationArtifactContentResponseSchema,
  type InvestigationArtifactRequest,
  InvestigationArtifactRequestSchema,
  type InvestigationArtifactResponse,
  InvestigationArtifactResponseSchema,
  type InvestigationArtifactV1,
  type InvestigationCheckpointRequest,
  InvestigationCheckpointRequestSchema,
  type InvestigationCheckpointResponse,
  InvestigationCheckpointResponseSchema,
  type InvestigationClaimRequest,
  InvestigationClaimRequestSchema,
  type InvestigationClaimResponse,
  InvestigationClaimResponseSchema,
  type InvestigationCleanupRequest,
  InvestigationCleanupRequestSchema,
  type InvestigationCleanupResponse,
  InvestigationCleanupResponseSchema,
  type InvestigationFinalizeRequest,
  InvestigationFinalizeRequestSchema,
  type InvestigationFinalizeResponse,
  InvestigationFinalizeResponseSchema,
  type InvestigationHeartbeatRequest,
  InvestigationHeartbeatRequestSchema,
  type InvestigationHeartbeatResponse,
  InvestigationHeartbeatResponseSchema,
  InvestigationModelInvocationReceiptSchema,
  type InvestigationProgressRequest,
  InvestigationProgressRequestSchema,
  type InvestigationProgressResponse,
  InvestigationProgressResponseSchema,
  type InvestigationReportPartRequest,
  InvestigationReportPartRequestSchema,
  type InvestigationReportPartResponse,
  InvestigationReportPartResponseSchema,
  InvestigationUsageSummarySchema,
  InvestigationWorkerLeaseSchema,
  type InvestigationWorkerPolicy,
  type InvestigationWorkerPolicyRequest,
  InvestigationWorkerPolicyRequestSchema,
  InvestigationWorkerPolicySchema,
  isInvestigationStaticTaskKind,
  PositiveIntegerSchema,
  validateInvestigationTokenUsage,
} from "@agentic-review/contracts";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import { isPermanentWorkerClientError } from "../server-client/errors.js";

// Claims and checkpoints can carry a complete 64 MiB report plus protocol metadata.
const defaultMaximumResponseBytes = 96 * 1_024 * 1_024;
const defaultRequestTimeoutMs = 30_000;
const maximumArtifactBytes = 32 * 1_024 * 1_024;
const maximumArtifactBase64Characters = 4 * Math.ceil(maximumArtifactBytes / 3);

export const InvestigationModelUsageRequestSchema = Type.Object(
  {
    lease: InvestigationWorkerLeaseSchema,
    receipt: InvestigationModelInvocationReceiptSchema,
  },
  { additionalProperties: false },
);
export type InvestigationModelUsageRequest = Static<typeof InvestigationModelUsageRequestSchema>;
export const InvestigationModelUsageResponseSchema = Type.Object(
  {
    invocationId: EntityIdSchema,
    revision: PositiveIntegerSchema,
    executionAllowed: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type InvestigationModelUsageResponse = Static<typeof InvestigationModelUsageResponseSchema>;
export const InvestigationReportUsageRequestSchema = Type.Object(
  {
    lease: InvestigationWorkerLeaseSchema,
  },
  { additionalProperties: false },
);
export type InvestigationReportUsageRequest = Static<typeof InvestigationReportUsageRequestSchema>;
export const InvestigationReportUsageResponseSchema = Type.Object(
  {
    summary: InvestigationUsageSummarySchema,
  },
  { additionalProperties: false },
);
export type InvestigationReportUsageResponse = Static<
  typeof InvestigationReportUsageResponseSchema
>;

type RequestFactory = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface InvestigationHttpClientOptions {
  readonly serverUrl: URL | string;
  readonly workerToken: string;
  readonly requestTimeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly allowInsecureHttp?: boolean;
  readonly tls?: {
    readonly ca?: string | Buffer;
    readonly serverName?: string;
  };
}

export interface InvestigationHttpClientDependencies {
  readonly httpRequest?: RequestFactory;
  readonly httpsRequest?: RequestFactory;
  readonly createSecureContext?: (options: SecureContextOptions) => SecureContext;
}

export interface InvestigationWorkerClient {
  /** Execution admission fails closed when an older embedded client lacks this operation. */
  workerPolicy?(
    request: InvestigationWorkerPolicyRequest,
    signal?: AbortSignal,
  ): Promise<InvestigationWorkerPolicy>;
  claim(
    request: InvestigationClaimRequest,
    signal?: AbortSignal,
  ): Promise<InvestigationClaimResponse["claim"]>;
  heartbeat(
    taskId: string,
    request: InvestigationHeartbeatRequest,
    signal?: AbortSignal,
  ): Promise<InvestigationHeartbeatResponse>;
  /** Optional for older embedded clients; production transports always report activity. */
  progress?(
    taskId: string,
    request: InvestigationProgressRequest,
    signal?: AbortSignal,
  ): Promise<InvestigationProgressResponse>;
  checkpoint(
    taskId: string,
    request: InvestigationCheckpointRequest,
    signal?: AbortSignal,
  ): Promise<InvestigationCheckpointResponse>;
  uploadArtifact(
    taskId: string,
    request: InvestigationArtifactRequest,
    signal?: AbortSignal,
  ): Promise<InvestigationArtifactResponse>;
  readArtifact(
    taskId: string,
    request: InvestigationArtifactContentRequest,
    signal?: AbortSignal,
  ): Promise<InvestigationArtifactContentResponse>;
  uploadReportPart(
    taskId: string,
    request: InvestigationReportPartRequest,
    signal?: AbortSignal,
  ): Promise<InvestigationReportPartResponse>;
  finalize(
    taskId: string,
    request: InvestigationFinalizeRequest,
    signal?: AbortSignal,
  ): Promise<InvestigationFinalizeResponse>;
  /** Optional for older embedded clients; production transports always provide cleanup. */
  cleanup?(
    taskId: string,
    request: InvestigationCleanupRequest,
    signal?: AbortSignal,
  ): Promise<InvestigationCleanupResponse>;
  /** Durable accounting transport; the original lease remains separate from the public receipt. */
  modelUsage?(
    taskId: string,
    request: InvestigationModelUsageRequest,
    signal?: AbortSignal,
  ): Promise<InvestigationModelUsageResponse>;
  /** Freeze the Server accounting snapshot before computing a report's content digest. */
  reportUsage?(
    taskId: string,
    request: InvestigationReportUsageRequest,
    signal?: AbortSignal,
  ): Promise<InvestigationReportUsageResponse>;
}

export function createInvestigationHttpClient(
  options: InvestigationHttpClientOptions,
  dependencies: InvestigationHttpClientDependencies = {},
): InvestigationWorkerClient {
  const transport = new InvestigationJsonTransport(options, dependencies);
  return {
    async workerPolicy(request, signal) {
      request = snapshotRequest(InvestigationWorkerPolicyRequestSchema, request, signal);
      const response = requireResponse(
        await transport.request(
          "/api/worker/policy",
          request,
          InvestigationWorkerPolicySchema,
          signal,
        ),
      );
      if (
        response.effectiveKinds.some(
          (kind) =>
            !request.supportedKinds.includes(kind) ||
            (!response.e2eEnabled && !isInvestigationStaticTaskKind(kind)),
        )
      )
        throw new InvestigationWorkerClientError("invalid_response", false, 200);
      return response;
    },
    async reportUsage(taskId, request, signal) {
      request = snapshotRequest(InvestigationReportUsageRequestSchema, request, signal);
      const response = requireResponse(
        await transport.request(
          taskPath(taskId, "report-usage"),
          request,
          InvestigationReportUsageResponseSchema,
          signal,
        ),
      );
      if (!validateInvestigationTokenUsage(response.summary.usage))
        throw new InvestigationWorkerClientError("invalid_response", false, 200);
      return response;
    },
    async modelUsage(taskId, request, signal) {
      request = snapshotRequest(InvestigationModelUsageRequestSchema, request, signal);
      if (
        request.receipt.taskId !== taskId ||
        request.receipt.attemptId !== request.lease.attemptId ||
        !validateInvestigationTokenUsage(request.receipt.usage)
      ) {
        throw new InvestigationWorkerClientError("invalid_request", false);
      }
      const response = requireResponse(
        await transport.request(
          taskPath(taskId, "model-usage"),
          request,
          InvestigationModelUsageResponseSchema,
          signal,
        ),
      );
      if (
        response.invocationId !== request.receipt.invocationId ||
        response.revision !== request.receipt.revision
      ) {
        throw new InvestigationWorkerClientError("invalid_response", false, 200);
      }
      return response;
    },
    async cleanup(taskId, request, signal) {
      request = snapshotRequest(InvestigationCleanupRequestSchema, request, signal);
      const response = requireResponse(
        await transport.request(
          taskPath(taskId, "cleanup"),
          request,
          InvestigationCleanupResponseSchema,
          signal,
        ),
      );
      if (response.attemptId !== request.lease.attemptId) {
        throw new InvestigationWorkerClientError("invalid_response", false, 200);
      }
      return response;
    },
    async claim(request, signal) {
      request = snapshotRequest(InvestigationClaimRequestSchema, request, signal);
      const response = await transport.request(
        "/api/worker/claims",
        request,
        InvestigationClaimResponseSchema,
        signal,
        true,
      );
      const claim = response?.claim ?? null;
      if (
        claim !== null &&
        (claim.task.id !== claim.attempt.taskId ||
          claim.attempt.id !== claim.lease.attemptId ||
          claim.attempt.leaseVersion !== claim.lease.fence ||
          !request.supportedKinds.includes(claim.task.kind) ||
          (claim.checkpoint !== null && claim.checkpoint.taskId !== claim.task.id))
      ) {
        throw new InvestigationWorkerClientError("invalid_response", false, 200);
      }
      return claim;
    },
    async heartbeat(taskId, request, signal) {
      request = snapshotRequest(InvestigationHeartbeatRequestSchema, request, signal);
      return requireResponse(
        await transport.request(
          taskPath(taskId, "heartbeat"),
          request,
          InvestigationHeartbeatResponseSchema,
          signal,
        ),
      );
    },
    async progress(taskId, request, signal) {
      request = snapshotRequest(InvestigationProgressRequestSchema, request, signal);
      return requireResponse(
        await transport.request(
          taskPath(taskId, "progress"),
          request,
          InvestigationProgressResponseSchema,
          signal,
        ),
      );
    },
    async checkpoint(taskId, request, signal) {
      request = snapshotRequest(InvestigationCheckpointRequestSchema, request, signal);
      if (
        request.kind === "analysis" &&
        (request.round.taskId !== taskId || request.round.attemptId !== request.lease.attemptId)
      ) {
        throw new InvestigationWorkerClientError("invalid_request", false);
      }
      const response = requireResponse(
        await transport.request(
          taskPath(taskId, "checkpoints"),
          request,
          InvestigationCheckpointResponseSchema,
          signal,
        ),
      );
      if (
        response.checkpoint.taskId !== taskId ||
        response.checkpoint.attemptId !== request.lease.attemptId ||
        response.checkpoint.leaseVersion !== request.lease.fence ||
        (request.kind === "analysis" && response.checkpoint.round !== request.round.round)
      ) {
        throw new InvestigationWorkerClientError("invalid_response", false, 200);
      }
      return response;
    },
    async uploadArtifact(taskId, request, signal) {
      request = snapshotRequest(InvestigationArtifactRequestSchema, request, signal);
      if (
        request.artifact.taskId !== taskId ||
        request.artifact.attemptId !== request.lease.attemptId
      ) {
        throw new InvestigationWorkerClientError("invalid_request", false);
      }
      decodeArtifactContent(request.artifact, request.contentBase64, "invalid_request");
      return requireResponse(
        await transport.request(
          taskPath(taskId, "artifacts"),
          request,
          InvestigationArtifactResponseSchema,
          signal,
        ),
      );
    },
    async readArtifact(taskId, request, signal) {
      request = snapshotRequest(InvestigationArtifactContentRequestSchema, request, signal);
      const response = requireResponse(
        await transport.request(
          taskPath(taskId, "artifact-content"),
          request,
          InvestigationArtifactContentResponseSchema,
          signal,
        ),
      );
      if (response.artifact.id !== request.artifactId) {
        throw new InvestigationWorkerClientError("invalid_response", false, 200);
      }
      const content = decodeArtifactContent(
        response.artifact,
        response.contentBase64,
        "invalid_response",
        200,
      );
      transport.assertResponseContentSafe(content, request.lease.leaseToken);
      return response;
    },
    async uploadReportPart(taskId, request, signal) {
      request = snapshotRequest(InvestigationReportPartRequestSchema, request, signal);
      if (request.part.taskId !== taskId || request.part.attemptId !== request.lease.attemptId) {
        throw new InvestigationWorkerClientError("invalid_request", false);
      }
      return requireResponse(
        await transport.request(
          taskPath(taskId, "report-parts"),
          request,
          InvestigationReportPartResponseSchema,
          signal,
        ),
      );
    },
    async finalize(taskId, request, signal) {
      request = snapshotRequest(InvestigationFinalizeRequestSchema, request, signal);
      if (
        request.header.context.task.id !== taskId ||
        request.header.context.attempt.id !== request.lease.attemptId ||
        request.header.report.id !== request.manifest.reportId ||
        request.header.report.version !== request.manifest.reportVersion ||
        request.header.report.logicalContentDigest !== request.manifest.logicalContentDigest
      ) {
        throw new InvestigationWorkerClientError("invalid_request", false);
      }
      const response = requireResponse(
        await transport.request(
          taskPath(taskId, "finalize"),
          request,
          InvestigationFinalizeResponseSchema,
          signal,
        ),
      );
      if (
        response.reportRef.id !== request.manifest.reportId ||
        response.reportRef.version !== request.manifest.reportVersion ||
        response.reportRef.digest !== request.manifest.logicalContentDigest
      ) {
        throw new InvestigationWorkerClientError("invalid_response", false, 200);
      }
      return response;
    },
  };
}

/** Error metadata is safe to log; remote messages and transport causes are never retained. */
export class InvestigationWorkerClientError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
  ) {
    super(`Investigation Worker request failed (${code}).`);
    this.name = code === "request_aborted" ? "AbortError" : "InvestigationWorkerClientError";
  }

  public get leaseLost(): boolean {
    return this.statusCode === 409 && this.code === "lease_lost";
  }
}

registerWorkerContractFormats();

class InvestigationJsonTransport {
  readonly #serverUrl: URL;
  readonly #workerToken: string;
  readonly #requestTimeoutMs: number;
  readonly #maximumResponseBytes: number;
  readonly #secureContext: SecureContext | undefined;
  readonly #serverName: string | undefined;
  readonly #httpRequest: RequestFactory;
  readonly #httpsRequest: RequestFactory;

  public constructor(
    options: InvestigationHttpClientOptions,
    dependencies: InvestigationHttpClientDependencies,
  ) {
    try {
      this.#serverUrl = new URL(options.serverUrl);
    } catch {
      throw new InvestigationWorkerClientError("invalid_configuration", false);
    }
    this.#requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? defaultMaximumResponseBytes;
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(this.#serverUrl.hostname);
    if (
      this.#serverUrl.username !== "" ||
      this.#serverUrl.password !== "" ||
      this.#serverUrl.pathname !== "/" ||
      this.#serverUrl.search !== "" ||
      this.#serverUrl.hash !== "" ||
      (this.#serverUrl.protocol !== "https:" &&
        !(
          this.#serverUrl.protocol === "http:" &&
          options.allowInsecureHttp === true &&
          loopback
        )) ||
      typeof options.workerToken !== "string" ||
      !/^[A-Za-z0-9._~+/-]+=*$/u.test(options.workerToken) ||
      options.workerToken.length > 4_096 ||
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs <= 0 ||
      this.#requestTimeoutMs > 300_000 ||
      !Number.isSafeInteger(this.#maximumResponseBytes) ||
      this.#maximumResponseBytes <= 0
    ) {
      throw new InvestigationWorkerClientError("invalid_configuration", false);
    }
    this.#workerToken = options.workerToken;
    this.#serverName = options.tls?.serverName;
    this.#httpRequest = dependencies.httpRequest ?? httpRequest;
    this.#httpsRequest = dependencies.httpsRequest ?? httpsRequest;
    try {
      this.#secureContext =
        this.#serverUrl.protocol === "https:"
          ? (dependencies.createSecureContext ?? createSecureContext)({
              ...(options.tls?.ca === undefined ? {} : { ca: options.tls.ca }),
            })
          : undefined;
    } catch {
      throw new InvestigationWorkerClientError("invalid_configuration", false);
    }
  }

  public async request<TResponse extends TSchema>(
    path: string,
    body: unknown,
    responseSchema: TResponse,
    signal?: AbortSignal,
    allowNoContent = false,
  ): Promise<Static<TResponse> | null> {
    if (signal?.aborted) throw new InvestigationWorkerClientError("request_aborted", false);
    const json = JSON.stringify(body);
    if (json === undefined) throw new InvestigationWorkerClientError("invalid_request", false);
    const serialized = Buffer.from(json, "utf8");
    const credentials = [this.#workerToken, ...requestCredentials(body)];
    const url = new URL(path, this.#serverUrl);
    const options: RequestOptions = {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.#workerToken}`,
        "content-type": "application/json",
        "content-length": serialized.byteLength,
      },
      ...(url.protocol === "https:"
        ? {
            secureContext: this.#secureContext,
            rejectUnauthorized: true,
            ...(this.#serverName === undefined ? {} : { servername: this.#serverName }),
          }
        : {}),
    };

    return await new Promise<Static<TResponse> | null>((resolve, reject) => {
      let request: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const rejectOnce = (error: InvestigationWorkerClientError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const resolveOnce = (value: Static<TResponse> | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const fail = (error: InvestigationWorkerClientError): void => {
        if (settled) return;
        rejectOnce(error);
        incoming?.destroy();
        request?.destroy();
      };
      const onAbort = (): void =>
        fail(new InvestigationWorkerClientError("request_aborted", false));
      const onResponse = (response: IncomingMessage): void => {
        incoming = response;
        if (settled) {
          response.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let byteLength = 0;
        let ended = false;
        response.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
          byteLength += bytes.byteLength;
          if (byteLength > this.#maximumResponseBytes) {
            fail(new InvestigationWorkerClientError("response_too_large", false));
            return;
          }
          chunks.push(bytes);
        });
        response.once("aborted", () =>
          fail(new InvestigationWorkerClientError("transport_error", true)),
        );
        response.once("error", (error: Error) => fail(transportError(error)));
        response.once("close", () => {
          if (!ended && !settled) fail(new InvestigationWorkerClientError("transport_error", true));
        });
        response.once("end", () => {
          ended = true;
          if (settled) return;
          const statusCode = response.statusCode ?? 0;
          if (statusCode === 204 && allowNoContent && byteLength === 0) {
            resolveOnce(null);
            return;
          }
          let payload: unknown;
          try {
            const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
            payload = JSON.parse(json);
          } catch {
            rejectOnce(
              statusCode >= 400
                ? httpError(statusCode)
                : new InvestigationWorkerClientError("invalid_response", false, statusCode),
            );
            return;
          }
          if (credentials.some((credential) => containsCredential(payload, credential))) {
            rejectOnce(
              new InvestigationWorkerClientError("confidential_response", false, statusCode),
            );
            return;
          }
          if (statusCode < 200 || statusCode >= 300) {
            rejectOnce(httpError(statusCode, payload));
            return;
          }
          if (statusCode !== 200 || !Value.Check(responseSchema, payload)) {
            rejectOnce(new InvestigationWorkerClientError("invalid_response", false, statusCode));
            return;
          }
          resolveOnce(payload);
        });
      };
      try {
        request =
          url.protocol === "https:"
            ? this.#httpsRequest(url, options, onResponse)
            : this.#httpRequest(url, options, onResponse);
        request.once("error", (error: Error) => fail(transportError(error)));
        request.once("close", () => {
          if (!settled) fail(new InvestigationWorkerClientError("transport_error", true));
        });
        if (settled) {
          request.destroy();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        timer = setTimeout(
          () => fail(new InvestigationWorkerClientError("request_timeout", true, 408)),
          this.#requestTimeoutMs,
        );
        timer.unref();
        request.write(serialized);
        request.end();
      } catch (error) {
        fail(transportError(error));
      }
    });
  }

  public assertResponseContentSafe(content: Buffer, leaseToken: string): void {
    if (content.includes(this.#workerToken) || content.includes(leaseToken)) {
      throw new InvestigationWorkerClientError("confidential_response", false, 200);
    }
  }
}

function decodeArtifactContent(
  artifact: InvestigationArtifactV1,
  contentBase64: string,
  code: "invalid_request" | "invalid_response",
  statusCode?: number,
): Buffer {
  if (contentBase64.length > maximumArtifactBase64Characters) {
    throw new InvestigationWorkerClientError(code, false, statusCode);
  }
  const content = Buffer.from(contentBase64, "base64");
  if (
    content.byteLength > maximumArtifactBytes ||
    content.toString("base64") !== contentBase64 ||
    content.byteLength !== artifact.byteLength ||
    createHash("sha256").update(content).digest("hex") !== artifact.digest
  ) {
    throw new InvestigationWorkerClientError(code, false, statusCode);
  }
  return content;
}

function transportError(error: unknown): InvestigationWorkerClientError {
  let retryable = true;
  try {
    retryable = !isPermanentWorkerClientError(error);
  } catch {
    // Transport exception properties can be untrusted; no original exception may escape.
  }
  return new InvestigationWorkerClientError("transport_error", retryable);
}

function snapshotRequest<T extends TSchema>(
  schema: T,
  request: unknown,
  signal?: AbortSignal,
): Static<T> {
  if (signal?.aborted) throw new InvestigationWorkerClientError("request_aborted", false);
  try {
    const json = JSON.stringify(request);
    if (json !== undefined) {
      const value: unknown = JSON.parse(json);
      if (Value.Check(schema, value)) return value;
    }
  } catch {
    // A malformed request must not expose values from user-defined serialization hooks.
  }
  throw new InvestigationWorkerClientError("invalid_request", false);
}

function requestCredentials(body: unknown): string[] {
  if (typeof body !== "object" || body === null || !("lease" in body)) return [];
  const lease = body.lease;
  if (typeof lease !== "object" || lease === null || !("leaseToken" in lease)) return [];
  return typeof lease.leaseToken === "string" && lease.leaseToken.length > 0
    ? [lease.leaseToken]
    : [];
}

function taskPath(taskId: string, operation: string): string {
  if (!Value.Check(EntityIdSchema, taskId)) {
    throw new InvestigationWorkerClientError("invalid_request", false);
  }
  return `/api/worker/tasks/${encodeURIComponent(taskId)}/${operation}`;
}

function requireResponse<T>(value: T | null): T {
  if (value === null) throw new InvestigationWorkerClientError("invalid_response", false);
  return value;
}

function httpError(statusCode: number, payload?: unknown): InvestigationWorkerClientError {
  const details = Value.Check(ErrorDetailsSchema, payload) ? payload : undefined;
  const code =
    details !== undefined && /^[a-z][a-z0-9_]{0,127}$/u.test(details.code)
      ? details.code
      : "http_error";
  const retryableStatus =
    statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
  return new InvestigationWorkerClientError(
    code,
    retryableStatus && details?.retryable !== false,
    statusCode,
  );
}

function containsCredential(payload: unknown, credential: string): boolean {
  const pending: unknown[] = [payload];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string" && value.includes(credential)) return true;
    if (typeof value !== "object" || value === null) continue;
    for (const [key, nested] of Object.entries(value)) {
      if (key.includes(credential)) return true;
      pending.push(nested);
    }
  }
  return false;
}
