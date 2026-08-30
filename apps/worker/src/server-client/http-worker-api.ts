import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { createSecureContext, type SecureContext, type SecureContextOptions } from "node:tls";
import {
  type ClaimLeaseRequest,
  type ClaimLeaseResponse,
  ClaimLeaseResponseSchema,
  type RunCompletionSubmission,
  type RunFailureSubmission,
  type WorkerHeartbeatRequest,
  type WorkerHeartbeatResponse,
  WorkerHeartbeatResponseSchema,
  type WorkerRegistrationRequest,
  type WorkerRegistrationResponse,
  WorkerRegistrationResponseSchema,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { WorkerConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { ProtocolError, WorkerApiError } from "./errors.js";
import type { WorkerApi } from "./worker-api.js";

const maximumResponseBytes = 2 * 1024 * 1024;

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

if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
}

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
  ): Promise<void> {
    await this.#requestJson(
      "POST",
      `/api/v1/worker/runs/${encodeURIComponent(runAttemptId)}/complete`,
      submission,
      signal,
    );
  }

  public async failRun(
    runAttemptId: string,
    submission: RunFailureSubmission,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#requestJson(
      "POST",
      `/api/v1/worker/runs/${encodeURIComponent(runAttemptId)}/fail`,
      submission,
      signal,
    );
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
      let request: ClientRequest;
      const handleResponse = (response: IncomingMessage): void => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.byteLength;
          if (receivedBytes > maximumResponseBytes) {
            request.destroy(
              new ProtocolError(`Worker API response exceeded ${maximumResponseBytes} bytes.`),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const statusCode = response.statusCode ?? 0;
          let payload: unknown;
          try {
            payload = text === "" ? undefined : JSON.parse(text);
          } catch (error) {
            reject(new ProtocolError("Worker API returned invalid JSON.", { cause: error }));
            return;
          }

          if (statusCode < 200 || statusCode >= 300) {
            const details = readApiError(payload);
            reject(
              new WorkerApiError(
                details.message ?? `Worker API returned HTTP ${statusCode}.`,
                statusCode,
                details.code,
              ),
            );
            return;
          }
          resolve(payload);
        });
      };
      request =
        url.protocol === "https:"
          ? this.#httpsRequest(url, options, handleResponse)
          : this.#httpRequest(url, options, handleResponse);

      const onAbort = (): void => {
        request.destroy(abortError(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const absoluteTimeout = setTimeout(() => {
        request.destroy(
          new WorkerApiError(
            `Worker API request exceeded its absolute ${timeoutMilliseconds} ms deadline.`,
            408,
          ),
        );
      }, timeoutMilliseconds);
      absoluteTimeout.unref();
      request.setTimeout(timeoutMilliseconds, () => {
        request.destroy(
          new WorkerApiError(`Worker API request timed out after ${timeoutMilliseconds} ms.`, 408),
        );
      });
      request.once("error", (error) => reject(error));
      request.once("close", () => {
        clearTimeout(absoluteTimeout);
        signal?.removeEventListener("abort", onAbort);
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

function readApiError(value: unknown): { code?: string; message?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const object = value as Record<string, unknown>;
  const nested =
    typeof object.error === "object" && object.error !== null && !Array.isArray(object.error)
      ? (object.error as Record<string, unknown>)
      : object;
  return {
    ...(typeof nested.code === "string" ? { code: nested.code } : {}),
    ...(typeof nested.message === "string" ? { message: nested.message } : {}),
  };
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Worker API request aborted.");
}
