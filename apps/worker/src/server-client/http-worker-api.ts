import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { createSecureContext, type SecureContext, type SecureContextOptions } from "node:tls";
import {
  type ClaimLeaseRequest,
  type ClaimLeaseResponse,
  ClaimLeaseResponseSchema,
  ErrorDetailsSchema,
  type FreezeValidationSummaryInputRequest,
  type FreezeValidationSummaryInputResponse,
  type ModelInvocationBeginRequest,
  type ModelInvocationOpening,
  type ModelInvocationSealRequest,
  type ModelInvocationSealV1,
  type ModelInvocationSubmissionV1,
  type ModelInvocationSubmitRequest,
  maximumClaimLeaseResponseUtf8Bytes,
  maximumModelInvocationControlRequestUtf8Bytes,
  type RunCompletionSubmission,
  type RunFailureSubmission,
  type RunTerminalResponse,
  RunTerminalResponseSchema,
  type WorkerHeartbeatRequest,
  type WorkerHeartbeatResponse,
  WorkerHeartbeatResponseSchema,
  type WorkerRegistrationRequest,
  type WorkerRegistrationResponse,
  WorkerRegistrationResponseSchema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { WorkerConfig } from "../config.js";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import { parseModelProtocolJson } from "../execution/model-response-observer.js";
import type { Logger } from "../logging/logger.js";
import { isPermanentWorkerClientError, ProtocolError, WorkerApiError } from "./errors.js";
import {
  type ModelInvocationApi,
  type ModelSummaryInputApi,
  parseFreezeValidationSummaryInputResponse,
  parseModelInvocationOpening,
  parseModelInvocationSeal,
  parseModelInvocationSubmission,
  snapshotFreezeValidationSummaryInputRequest,
  snapshotModelInvocationBeginRequest,
  snapshotModelInvocationSealRequest,
  snapshotModelInvocationSubmitRequest,
} from "./model-invocation-api.js";
import type { WorkerApi } from "./worker-api.js";

// A claim can contain both a bounded 1 MiB GitHub snapshot and a rendered prompt whose JSON
// representation contains escaped repository data.
const maximumResponseBytes = maximumClaimLeaseResponseUtf8Bytes;

type RequestFactory = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface HttpWorkerApiDependencies {
  readonly createSecureContext?: (options: SecureContextOptions) => SecureContext;
  readonly httpRequest?: RequestFactory;
  readonly httpsRequest?: RequestFactory;
}

interface ModelInvocationTransport {
  readonly serialized: Buffer;
  readonly leaseToken: string;
  readonly operation: "open" | "seal" | "receipts" | "summary_input";
}

registerWorkerContractFormats();

export class HttpWorkerApi implements WorkerApi, ModelInvocationApi, ModelSummaryInputApi {
  readonly #secureContext: SecureContext | undefined;
  readonly #httpRequest: RequestFactory;
  readonly #httpsRequest: RequestFactory;

  public constructor(
    private readonly config: WorkerConfig,
    private readonly logger: Logger,
    dependencies: HttpWorkerApiDependencies = {},
  ) {
    this.#httpRequest = dependencies.httpRequest ?? httpRequest;
    this.#httpsRequest = dependencies.httpsRequest ?? httpsRequest;
    if (config.serverUrl.protocol === "https:") {
      const tls = config.tls;
      if (tls === undefined) {
        throw new TypeError("HTTPS Worker API access requires TLS client configuration.");
      }
      const createContext = dependencies.createSecureContext ?? createSecureContext;
      this.#secureContext = createContext({
        ...(tls.ca === undefined ? {} : { ca: tls.ca }),
      });
    }
  }

  public async register(
    request: WorkerRegistrationRequest,
    signal?: AbortSignal,
  ): Promise<WorkerRegistrationResponse> {
    const response = await this.#requestJson("POST", "/api/v1/worker/instances", request, signal);
    return parseRegistrationResponse(response);
  }

  public async claimLease(
    request: ClaimLeaseRequest,
    signal?: AbortSignal,
  ): Promise<ClaimLeaseResponse> {
    const timeoutMilliseconds =
      (request.waitSeconds ?? 0) * 1_000 + this.config.requestTimeoutSeconds * 1_000;
    const response = await this.#requestJson(
      "POST",
      "/api/v1/worker/leases/claim",
      request,
      signal,
      timeoutMilliseconds,
    );
    return parseClaimResponse(response);
  }

  public async heartbeat(
    workerInstanceId: string,
    request: WorkerHeartbeatRequest,
    signal?: AbortSignal,
  ): Promise<WorkerHeartbeatResponse> {
    const response = await this.#requestJson(
      "PUT",
      `/api/v1/worker/instances/${encodeURIComponent(workerInstanceId)}/heartbeat`,
      request,
      signal,
    );
    return parseHeartbeatResponse(response);
  }

  public async completeRun(
    runAttemptId: string,
    submission: RunCompletionSubmission,
    signal?: AbortSignal,
  ): Promise<RunTerminalResponse> {
    assertTerminalRouteIdentity(runAttemptId, submission.runAttemptId);
    const response = await this.#requestJson(
      "POST",
      `/api/v1/worker/runs/${encodeURIComponent(runAttemptId)}/complete`,
      submission,
      signal,
    );
    return parseRunTerminalResponse(response, submission.jobId, runAttemptId);
  }

  public async failRun(
    runAttemptId: string,
    submission: RunFailureSubmission,
    signal?: AbortSignal,
  ): Promise<RunTerminalResponse> {
    assertTerminalRouteIdentity(runAttemptId, submission.runAttemptId);
    const response = await this.#requestJson(
      "POST",
      `/api/v1/worker/runs/${encodeURIComponent(runAttemptId)}/fail`,
      submission,
      signal,
    );
    return parseRunTerminalResponse(response, submission.jobId, runAttemptId);
  }

  public async beginModelInvocation(
    request: ModelInvocationBeginRequest,
    signal?: AbortSignal,
  ): Promise<ModelInvocationOpening> {
    const copy = snapshotModelInvocationBeginRequest(request);
    this.#assertModelInvocationConfiguration(copy.value.lease.workerNodeId);
    const response = await this.#requestJson(
      "POST",
      `/api/v1/worker/runs/${encodeURIComponent(copy.value.lease.runAttemptId)}/model-invocations/open`,
      undefined,
      signal,
      undefined,
      { serialized: copy.serialized, leaseToken: copy.value.lease.leaseToken, operation: "open" },
    );
    return parseModelInvocationOpening(response, copy.value);
  }

  public async freezeValidationSummaryInput(
    request: FreezeValidationSummaryInputRequest,
    signal?: AbortSignal,
  ): Promise<FreezeValidationSummaryInputResponse> {
    const copy = snapshotFreezeValidationSummaryInputRequest(request);
    this.#assertModelInvocationConfiguration(copy.value.lease.workerNodeId);
    if (JSON.stringify(copy.value.context).includes(this.config.workerToken))
      throw new ProtocolError("Summary input cannot contain the Worker credential.");
    const response = await this.#requestJson(
      "POST",
      "/api/v1/worker/model-summary-inputs",
      undefined,
      signal,
      undefined,
      {
        serialized: copy.serialized,
        leaseToken: copy.value.lease.leaseToken,
        operation: "summary_input",
      },
    );
    return parseFreezeValidationSummaryInputResponse(response, copy.value);
  }

  public async sealModelInvocation(
    request: ModelInvocationSealRequest,
    signal?: AbortSignal,
  ): Promise<ModelInvocationSealV1> {
    const copy = snapshotModelInvocationSealRequest(request);
    this.#assertModelInvocationConfiguration(copy.value.lease.workerNodeId);
    const response = await this.#requestJson(
      "POST",
      `/api/v1/worker/runs/${encodeURIComponent(copy.value.lease.runAttemptId)}/model-invocations/${encodeURIComponent(copy.value.invocationId)}/seal`,
      undefined,
      signal,
      undefined,
      { serialized: copy.serialized, leaseToken: copy.value.lease.leaseToken, operation: "seal" },
    );
    return parseModelInvocationSeal(response, copy.value);
  }

  public async submitModelInvocationReceipts(
    request: ModelInvocationSubmitRequest,
    signal?: AbortSignal,
  ): Promise<ModelInvocationSubmissionV1> {
    const copy = snapshotModelInvocationSubmitRequest(request);
    this.#assertModelInvocationConfiguration(copy.value.lease.workerNodeId);
    const response = await this.#requestJson(
      "POST",
      `/api/v1/worker/runs/${encodeURIComponent(copy.value.lease.runAttemptId)}/model-invocations/${encodeURIComponent(copy.value.invocationId)}/receipts`,
      undefined,
      signal,
      undefined,
      {
        serialized: copy.serialized,
        leaseToken: copy.value.lease.leaseToken,
        operation: "receipts",
      },
    );
    return parseModelInvocationSubmission(response, copy.value);
  }

  #assertModelInvocationConfiguration(workerNodeId: string): void {
    if (
      workerNodeId !== this.config.workerNodeId ||
      this.config.serverUrl.username !== "" ||
      this.config.serverUrl.password !== "" ||
      (this.config.serverUrl.protocol !== "https:" &&
        (this.config.serverUrl.protocol !== "http:" || !this.config.allowInsecureHttp)) ||
      (this.config.serverUrl.protocol === "https:" &&
        this.config.tls?.rejectUnauthorized !== true) ||
      !Number.isFinite(this.config.requestTimeoutSeconds) ||
      this.config.requestTimeoutSeconds <= 0 ||
      this.config.requestTimeoutSeconds > 300
    )
      throw new ProtocolError(
        "Model invocation transport configuration or Worker identity is invalid.",
      );
  }

  async #requestJson(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    timeoutMilliseconds = this.config.requestTimeoutSeconds * 1_000,
    invocation?: ModelInvocationTransport,
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw invocation === undefined ? abortError(signal) : invocationAbortError();
    }
    const url = new URL(path, this.config.serverUrl);
    const serializedBody = invocation?.serialized ?? Buffer.from(JSON.stringify(body), "utf8");
    const responseLimit =
      invocation === undefined
        ? maximumResponseBytes
        : maximumModelInvocationControlRequestUtf8Bytes;
    const options: RequestOptions = {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.config.workerToken}`,
        "content-type": "application/json",
        "content-length": serializedBody.byteLength,
        "user-agent": `agentic-review-worker/${this.config.workerVersion}`,
      },
      ...(url.protocol === "https:"
        ? {
            secureContext: this.#secureContext,
            ...(this.config.tls?.serverName === undefined
              ? {}
              : { servername: this.config.tls.serverName }),
            rejectUnauthorized: true,
          }
        : {}),
    };

    return await new Promise<unknown>((resolve, reject) => {
      let request: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      let absoluteTimeout: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      let settled = false;
      const cleanup = (): void => {
        if (absoluteTimeout !== undefined) {
          clearTimeout(absoluteTimeout);
        }
        if (onAbort !== undefined) {
          signal?.removeEventListener("abort", onAbort);
        }
      };
      const resolveOnce = (value: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const destroyRequest = (error: Error): void => {
        rejectOnce(error);
        if (invocation !== undefined) incoming?.destroy();
        request?.destroy();
      };
      onAbort = (): void => {
        destroyRequest(invocation === undefined ? abortError(signal) : invocationAbortError());
      };
      const handleResponse = (response: IncomingMessage): void => {
        incoming = response;
        if (settled) {
          response.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        let ended = false;
        const rejectPrematureResponse = (event: string, cause?: Error): void => {
          rejectOnce(
            new WorkerApiError(
              `Worker API response ${event} before completion.`,
              undefined,
              undefined,
              cause === undefined || invocation !== undefined ? undefined : { cause },
            ),
          );
          response.destroy();
          request?.destroy();
        };
        response.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.byteLength;
          if (receivedBytes > responseLimit) {
            rejectOnce(new ProtocolError(`Worker API response exceeded ${responseLimit} bytes.`));
            response.destroy();
            request?.destroy();
            return;
          }
          chunks.push(buffer);
        });
        response.once("aborted", () => rejectPrematureResponse("was aborted"));
        response.once("error", (error: Error) => rejectPrematureResponse("failed", error));
        response.once("close", () => {
          if (!ended && !settled) {
            rejectPrematureResponse("closed");
          }
        });
        response.once("end", () => {
          ended = true;
          if (settled) return;
          const statusCode = response.statusCode ?? 0;
          let payload: unknown;
          try {
            const bytes = Buffer.concat(chunks);
            if (invocation === undefined) {
              const text = bytes.toString("utf8");
              payload = text === "" ? undefined : JSON.parse(text);
            } else {
              payload = parseModelProtocolJson(
                new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              );
            }
          } catch {
            rejectOnce(new ProtocolError("Worker API returned invalid JSON."));
            return;
          }
          if (
            responseContainsWorkerToken(payload, this.config.workerToken) ||
            (invocation !== undefined &&
              responseContainsWorkerToken(payload, invocation.leaseToken))
          ) {
            rejectOnce(
              new ProtocolError("Worker API response contained confidential authentication data."),
            );
            return;
          }

          if (statusCode < 200 || statusCode >= 300) {
            const details = readApiError(payload);
            rejectOnce(
              new WorkerApiError(
                `Worker API returned HTTP ${statusCode}.`,
                statusCode,
                details.code,
                details.retryable === undefined ? undefined : { retryable: details.retryable },
              ),
            );
            return;
          }
          resolveOnce(payload);
        });
      };
      try {
        request =
          url.protocol === "https:"
            ? this.#httpsRequest(url, options, handleResponse)
            : this.#httpRequest(url, options, handleResponse);
      } catch (error) {
        rejectOnce(invocation === undefined ? error : invocationTransportError(error));
        return;
      }
      if (settled || signal?.aborted) {
        if (!settled) onAbort();
        request.destroy();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      absoluteTimeout = setTimeout(() => {
        destroyRequest(
          new WorkerApiError(
            `Worker API request exceeded its absolute ${timeoutMilliseconds} ms deadline.`,
            408,
          ),
        );
      }, timeoutMilliseconds);
      absoluteTimeout.unref();
      request.setTimeout(timeoutMilliseconds, () => {
        destroyRequest(
          new WorkerApiError(`Worker API request timed out after ${timeoutMilliseconds} ms.`, 408),
        );
      });
      request.once("error", (error) => {
        if (invocation === undefined) rejectOnce(error);
        else destroyRequest(invocationTransportError(error));
      });
      request.once("close", () => {
        if (!settled) {
          rejectOnce(new WorkerApiError("Worker API request closed before receiving a response."));
        }
      });
      try {
        request.write(serializedBody);
        request.end();
        this.logger.debug(
          "Worker API request started.",
          invocation === undefined ? { method, path } : { operation: invocation.operation },
        );
      } catch (error) {
        if (invocation === undefined) rejectOnce(error);
        else destroyRequest(invocationTransportError(error));
      }
    });
  }
}

function responseContainsWorkerToken(value: unknown, workerToken: string): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (current.includes(workerToken)) {
        return true;
      }
      continue;
    }
    if (typeof current !== "object" || current === null) {
      continue;
    }
    if (Array.isArray(current)) {
      for (const nested of current) {
        pending.push(nested);
      }
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      if (key.includes(workerToken)) {
        return true;
      }
      pending.push(nested);
    }
  }
  return false;
}

function parseRegistrationResponse(value: unknown): WorkerRegistrationResponse {
  if (!Value.Check(WorkerRegistrationResponseSchema, value)) {
    throw new ProtocolError("Worker API returned an invalid registration response.");
  }
  return value;
}

function parseClaimResponse(value: unknown): ClaimLeaseResponse {
  if (!Value.Check(ClaimLeaseResponseSchema, value)) {
    throw new ProtocolError("Worker API returned an invalid claim response.");
  }
  return value;
}

function parseHeartbeatResponse(value: unknown): WorkerHeartbeatResponse {
  if (!Value.Check(WorkerHeartbeatResponseSchema, value)) {
    throw new ProtocolError("Worker API returned an invalid heartbeat response.");
  }
  return value;
}

function assertTerminalRouteIdentity(routeRunAttemptId: string, bodyRunAttemptId: string): void {
  if (routeRunAttemptId !== bodyRunAttemptId) {
    throw new ProtocolError("Terminal route and body attempt identities do not match.");
  }
}

function parseRunTerminalResponse(
  value: unknown,
  expectedJobId: string,
  expectedRunAttemptId: string,
): RunTerminalResponse {
  if (!Value.Check(RunTerminalResponseSchema, value)) {
    throw new ProtocolError("Worker API returned an invalid terminal response.");
  }
  if (value.jobId !== expectedJobId || value.runAttemptId !== expectedRunAttemptId) {
    throw new ProtocolError("Worker API returned a terminal response for another run.");
  }
  return value;
}

function readApiError(value: unknown): {
  code?: string;
  retryable?: boolean;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const object = value as Record<string, unknown>;
  const nested =
    typeof object.error === "object" && object.error !== null && !Array.isArray(object.error)
      ? (object.error as Record<string, unknown>)
      : object;
  if (!Value.Check(ErrorDetailsSchema, nested) || !/^[a-z][a-z0-9_]{0,127}$/u.test(nested.code)) {
    return {};
  }
  return {
    code: nested.code,
    retryable: nested.retryable,
  };
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Worker API request aborted.");
}

function invocationAbortError(): WorkerApiError {
  return new WorkerApiError("Model invocation request was aborted.", undefined, "request_aborted", {
    retryable: false,
  });
}

function invocationTransportError(error: unknown): WorkerApiError {
  return new WorkerApiError("Model invocation transport failed.", undefined, undefined, {
    retryable: !isPermanentWorkerClientError(error),
  });
}
