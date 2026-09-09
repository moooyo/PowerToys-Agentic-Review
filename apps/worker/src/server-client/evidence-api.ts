import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { createSecureContext, type SecureContext } from "node:tls";
import {
  type AppendEvidenceChunkRequest,
  AppendEvidenceChunkRequestSchema,
  type BeginEvidenceUploadRequest,
  BeginEvidenceUploadRequestSchema,
  ErrorDetailsSchema,
  type EvidenceAssetManifest,
  EvidenceAssetManifestSchema,
  type EvidenceUploadResponse,
  EvidenceUploadResponseSchema,
  type FinalizeEvidenceUploadRequest,
  FinalizeEvidenceUploadRequestSchema,
  getEvidenceChunkDecodedBytes,
  maximumEvidenceAssetBytes,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { WorkerConfig } from "../config.js";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import type { Logger } from "../logging/logger.js";
import { isPermanentWorkerClientError, ProtocolError, WorkerApiError } from "./errors.js";
import type { HttpWorkerApiDependencies } from "./http-worker-api.js";

export interface EvidenceApi {
  beginUpload(
    request: BeginEvidenceUploadRequest,
    signal?: AbortSignal,
  ): Promise<EvidenceUploadResponse>;
  appendChunk(
    request: AppendEvidenceChunkRequest,
    signal?: AbortSignal,
  ): Promise<EvidenceUploadResponse>;
  finalizeUpload(
    request: FinalizeEvidenceUploadRequest,
    signal?: AbortSignal,
  ): Promise<EvidenceAssetManifest>;
}
export type WorkerEvidenceApiConfig = Pick<
  WorkerConfig,
  | "serverUrl"
  | "workerToken"
  | "workerVersion"
  | "requestTimeoutSeconds"
  | "allowInsecureHttp"
  | "tls"
>;
export const maximumEvidenceApiRequestBytes = 1024 * 1024;
export const maximumEvidenceApiResponseBytes = 64 * 1024;
registerWorkerContractFormats();

// Shares the authenticated Worker transport policy and error taxonomy, while keeping upload
// bodies out of the registration/lease client's larger response allowance and log surface.
export class HttpWorkerEvidenceApi implements EvidenceApi {
  readonly #secureContext: SecureContext | undefined;
  readonly #httpRequest: NonNullable<HttpWorkerApiDependencies["httpRequest"]>;
  readonly #httpsRequest: NonNullable<HttpWorkerApiDependencies["httpsRequest"]>;

  public constructor(
    private readonly config: WorkerEvidenceApiConfig,
    private readonly logger: Logger,
    dependencies: HttpWorkerApiDependencies = {},
  ) {
    if (
      (config.serverUrl.protocol !== "https:" &&
        (config.serverUrl.protocol !== "http:" || !config.allowInsecureHttp)) ||
      config.serverUrl.username !== "" ||
      config.serverUrl.password !== ""
    ) {
      throw new ProtocolError(
        "Evidence API requires an authenticated HTTPS endpoint or explicit development HTTP.",
      );
    }
    if (
      !Number.isFinite(config.requestTimeoutSeconds) ||
      config.requestTimeoutSeconds <= 0 ||
      config.requestTimeoutSeconds > 300
    )
      throw new ProtocolError("Evidence API timeout is invalid.");
    this.#httpRequest = dependencies.httpRequest ?? httpRequest;
    this.#httpsRequest = dependencies.httpsRequest ?? httpsRequest;
    if (config.serverUrl.protocol === "https:") {
      if (config.tls === undefined || config.tls.rejectUnauthorized !== true)
        throw new ProtocolError("Evidence HTTPS access requires trusted Server TLS configuration.");
      try {
        this.#secureContext = (dependencies.createSecureContext ?? createSecureContext)({
          ...(config.tls.ca === undefined ? {} : { ca: config.tls.ca }),
        });
      } catch {
        throw new WorkerApiError(
          "Evidence API TLS trust configuration is invalid.",
          undefined,
          "tls_configuration_invalid",
          { retryable: false },
        );
      }
    }
  }

  public async beginUpload(
    request: BeginEvidenceUploadRequest,
    signal?: AbortSignal,
  ): Promise<EvidenceUploadResponse> {
    if (!Value.Check(BeginEvidenceUploadRequestSchema, request))
      throw new ProtocolError("Evidence begin request is invalid.");
    const value = await this.#request(
      "begin",
      "/api/v1/worker/evidence/uploads",
      request,
      request.lease.leaseToken,
      signal,
    );
    if (
      !Value.Check(EvidenceUploadResponseSchema, value) ||
      value.offset > request.metadata.sizeBytes ||
      (value.state === "finalized" && value.offset !== request.metadata.sizeBytes)
    )
      throw new ProtocolError("Evidence API returned an invalid begin response.");
    return value;
  }

  public async appendChunk(
    request: AppendEvidenceChunkRequest,
    signal?: AbortSignal,
  ): Promise<EvidenceUploadResponse> {
    if (!Value.Check(AppendEvidenceChunkRequestSchema, request))
      throw new ProtocolError("Evidence chunk request is invalid.");
    const length = getEvidenceChunkDecodedBytes(request.base64);
    if (length === null || request.offset + length > maximumEvidenceAssetBytes)
      throw new ProtocolError("Evidence chunk exceeds the supported byte range.");
    const value = await this.#request(
      "append",
      `/api/v1/worker/evidence/${encodeURIComponent(request.assetId)}/chunks`,
      request,
      request.lease.leaseToken,
      signal,
    );
    if (
      !Value.Check(EvidenceUploadResponseSchema, value) ||
      value.assetId !== request.assetId ||
      value.offset !== request.offset + length ||
      value.state !== "uploading"
    )
      throw new ProtocolError("Evidence API returned an invalid chunk acknowledgement.");
    return value;
  }

  public async finalizeUpload(
    request: FinalizeEvidenceUploadRequest,
    signal?: AbortSignal,
  ): Promise<EvidenceAssetManifest> {
    if (!Value.Check(FinalizeEvidenceUploadRequestSchema, request))
      throw new ProtocolError("Evidence finalize request is invalid.");
    const value = await this.#request(
      "finalize",
      `/api/v1/worker/evidence/${encodeURIComponent(request.assetId)}/finalize`,
      request,
      request.lease.leaseToken,
      signal,
    );
    if (
      !Value.Check(EvidenceAssetManifestSchema, value) ||
      value.id !== request.assetId ||
      value.jobId !== request.lease.jobId ||
      value.runAttemptId !== request.lease.runAttemptId ||
      value.state !== "finalized" ||
      value.retiredAt !== null
    )
      throw new ProtocolError("Evidence API returned an invalid finalized manifest.");
    return value;
  }

  async #request(
    operation: "begin" | "append" | "finalize",
    path: string,
    body: unknown,
    leaseToken: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw abortedError();
    const serialized = Buffer.from(JSON.stringify(body), "utf8");
    if (serialized.byteLength > maximumEvidenceApiRequestBytes)
      throw new ProtocolError("Evidence API request exceeded its byte limit.");
    const url = new URL(path, this.config.serverUrl);
    const options: RequestOptions = {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.config.workerToken}`,
        "content-type": "application/json",
        "content-length": serialized.byteLength,
        "user-agent": `agentic-review-worker/${this.config.workerVersion}`,
      },
      ...(url.protocol === "https:"
        ? {
            secureContext: this.#secureContext,
            rejectUnauthorized: true,
            ...(this.config.tls?.serverName === undefined
              ? {}
              : { servername: this.config.tls.serverName }),
          }
        : {}),
    };
    return new Promise<unknown>((resolve, reject) => {
      let request: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (error: Error | null, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error === null) resolve(value);
        else {
          reject(error);
          response?.destroy();
          request?.destroy();
        }
      };
      const onAbort = (): void => finish(abortedError());
      const receive = (incoming: IncomingMessage): void => {
        response = incoming;
        if (settled) {
          incoming.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        let ended = false;
        incoming.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.byteLength;
          if (bytes > maximumEvidenceApiResponseBytes) {
            finish(new ProtocolError("Evidence API response exceeded its byte limit."));
            return;
          }
          chunks.push(data);
        });
        incoming.once("aborted", () =>
          finish(new WorkerApiError("Evidence API response was interrupted.")),
        );
        incoming.once("error", () => finish(new WorkerApiError("Evidence API response failed.")));
        incoming.once("close", () => {
          if (!ended && !settled)
            finish(new WorkerApiError("Evidence API response closed before completion."));
        });
        incoming.once("end", () => {
          ended = true;
          if (settled) return;
          let payload: unknown;
          try {
            payload = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)),
            );
          } catch {
            finish(new ProtocolError("Evidence API returned invalid UTF-8 JSON."));
            return;
          }
          if (containsConfidentialData(payload, [this.config.workerToken, leaseToken])) {
            finish(
              new ProtocolError(
                "Evidence API response contained confidential authentication data.",
              ),
            );
            return;
          }
          const status = incoming.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const details = readErrorDetails(payload);
            finish(
              new WorkerApiError(
                `Evidence API returned HTTP ${status}.`,
                status,
                details?.code,
                details === undefined ? undefined : { retryable: details.retryable },
              ),
            );
            return;
          }
          finish(null, payload);
        });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutMs = this.config.requestTimeoutSeconds * 1000;
      timer = setTimeout(
        () =>
          finish(new WorkerApiError("Evidence API request exceeded its absolute deadline.", 408)),
        timeoutMs,
      );
      timer.unref();
      try {
        request = (url.protocol === "https:" ? this.#httpsRequest : this.#httpRequest)(
          url,
          options,
          receive,
        );
        if (settled || signal?.aborted) {
          onAbort();
          request.destroy();
          return;
        }
        request.once("error", (error) =>
          finish(
            new WorkerApiError("Evidence API transport failed.", undefined, undefined, {
              retryable: !isPermanentWorkerClientError(error),
            }),
          ),
        );
        request.once("close", () => {
          if (!settled)
            finish(new WorkerApiError("Evidence API request closed before completion."));
        });
        request.setTimeout(timeoutMs, () =>
          finish(new WorkerApiError("Evidence API request timed out.", 408)),
        );
        request.end(serialized);
        this.logger.debug("Evidence API request started.", { operation });
      } catch (error) {
        finish(
          new WorkerApiError("Evidence API request could not start.", undefined, undefined, {
            retryable: !isPermanentWorkerClientError(error),
          }),
        );
      }
    });
  }
}

function abortedError(): WorkerApiError {
  return new WorkerApiError("Evidence API request was aborted.", undefined, "request_aborted", {
    retryable: false,
  });
}
function containsConfidentialData(value: unknown, secrets: readonly string[]): boolean {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      typeof current === "string" &&
      secrets.some((secret) => secret !== "" && current.includes(secret))
    )
      return true;
    if (current === null || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (secrets.some((secret) => secret !== "" && key.includes(secret))) return true;
      pending.push(child);
    }
  }
  return false;
}
function readErrorDetails(value: unknown): { code: string; retryable: boolean } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = "error" in value ? value.error : value;
  if (
    !Value.Check(ErrorDetailsSchema, candidate) ||
    !/^[a-z][a-z0-9_]{0,127}$/u.test(candidate.code)
  )
    return undefined;
  return { code: candidate.code, retryable: candidate.retryable };
}
