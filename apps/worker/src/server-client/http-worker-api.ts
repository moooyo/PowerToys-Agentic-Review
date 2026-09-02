import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { createSecureContext, type SecureContext, type SecureContextOptions } from "node:tls";
import {
  type ClaimLeaseRequest,
  type ClaimLeaseResponse,
  ClaimLeaseResponseSchema,
  ErrorDetailsSchema,
  maximumClaimLeaseResponseUtf8Bytes,
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
import type { Logger } from "../logging/logger.js";
import { ProtocolError, WorkerApiError } from "./errors.js";
import type { WorkerApi } from "./worker-api.js";

// A claim can contain both a bounded 1 MiB GitHub snapshot and a rendered prompt whose JSON
// representation contains escaped untrusted data. Keep this aligned with ServiceHost transport.
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

registerWorkerContractFormats();

export class HttpWorkerApi implements WorkerApi {
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
        ...(tls.cert === undefined ? {} : { cert: tls.cert }),
        ...(tls.key === undefined ? {} : { key: tls.key }),
        ...(tls.pfx === undefined ? {} : { pfx: tls.pfx }),
        ...(tls.passphrase === undefined ? {} : { passphrase: tls.passphrase }),
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

  async #requestJson(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    timeoutMilliseconds = this.config.requestTimeoutSeconds * 1_000,
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw abortError(signal);
    }
    const url = new URL(path, this.config.serverUrl);
    const serializedBody = Buffer.from(JSON.stringify(body), "utf8");
    const options: RequestOptions = {
      method,
      headers: {
        accept: "application/json",
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
        request?.destroy();
      };
      onAbort = (): void => {
        destroyRequest(abortError(signal));
      };
      const handleResponse = (response: IncomingMessage): void => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        let ended = false;
        const rejectPrematureResponse = (event: string, cause?: Error): void => {
          rejectOnce(
            new WorkerApiError(
              `Worker API response ${event} before completion.`,
              undefined,
              undefined,
              cause === undefined ? undefined : { cause },
            ),
          );
          response.destroy();
          request?.destroy();
        };
        response.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.byteLength;
          if (receivedBytes > maximumResponseBytes) {
            rejectOnce(
              new ProtocolError(`Worker API response exceeded ${maximumResponseBytes} bytes.`),
            );
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
          const text = Buffer.concat(chunks).toString("utf8");
          const statusCode = response.statusCode ?? 0;
          let payload: unknown;
          try {
            payload = text === "" ? undefined : JSON.parse(text);
          } catch {
            rejectOnce(new ProtocolError("Worker API returned invalid JSON."));
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
        rejectOnce(error);
        return;
      }
      if (settled) {
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
      request.once("error", (error) => rejectOnce(error));
      request.once("close", () => {
        if (!settled) {
          rejectOnce(new WorkerApiError("Worker API request closed before receiving a response."));
        }
      });
      request.write(serializedBody);
      request.end();

      this.logger.debug("Worker API request started.", { method, path });
    });
  }
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
