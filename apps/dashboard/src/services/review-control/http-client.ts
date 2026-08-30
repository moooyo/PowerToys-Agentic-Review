import {
  ReviewControlError,
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlResponseTooLargeError,
  ReviewControlTimeoutError,
} from "./errors";

export const DASHBOARD_API_PREFIX = "/api/v1/dashboard/";
export const DEFAULT_DASHBOARD_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_DASHBOARD_RESPONSE_BYTES = 2 * 1_024 * 1_024;

export type DashboardFetch = typeof globalThis.fetch;

export interface DashboardHttpClientOptions {
  readonly fetch?: DashboardFetch;
  readonly timeoutMs?: number;
}

interface ServerErrorBody {
  readonly code?: string;
  readonly message?: string;
  readonly retryable?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseServerError = (body: string): ServerErrorBody => {
  if (body === "") {
    return {};
  }

  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value)) {
      return {};
    }
    return {
      ...(typeof value.code === "string" ? { code: value.code } : {}),
      ...(typeof value.message === "string" ? { message: value.message } : {}),
      ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
    };
  } catch {
    return {};
  }
};

const ensureDashboardPath = (path: string): void => {
  if (!path.startsWith(DASHBOARD_API_PREFIX) || path.includes("://")) {
    throw new Error(`Dashboard API paths must remain under ${DASHBOARD_API_PREFIX}.`);
  }
};

const decodeUtf8 = (value: ArrayBuffer | Uint8Array, operation: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response was not valid UTF-8.`,
      undefined,
      error,
    );
  }
};

const readBody = async (
  response: Response,
  operation: string,
  controller: AbortController,
): Promise<string> => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(length) && length > MAX_DASHBOARD_RESPONSE_BYTES) {
      controller.abort();
      throw new ReviewControlResponseTooLargeError(operation, MAX_DASHBOARD_RESPONSE_BYTES);
    }
  }

  if (response.body === null) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_DASHBOARD_RESPONSE_BYTES) {
      controller.abort();
      throw new ReviewControlResponseTooLargeError(operation, MAX_DASHBOARD_RESPONSE_BYTES);
    }
    return decodeUtf8(buffer, operation);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_DASHBOARD_RESPONSE_BYTES) {
        controller.abort();
        throw new ReviewControlResponseTooLargeError(operation, MAX_DASHBOARD_RESPONSE_BYTES);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return decodeUtf8(body, operation);
};

export class DashboardHttpClient {
  private readonly fetchImplementation: DashboardFetch;
  private readonly timeoutMs: number;

  constructor(options: DashboardHttpClientOptions = {}) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DASHBOARD_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Dashboard request timeout must be a positive integer.");
    }
  }

  async get(path: string, operation: string): Promise<unknown> {
    ensureDashboardPath(path);
    const controller = new AbortController();
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ReviewControlTimeoutError(operation, this.timeoutMs));
      }, this.timeoutMs);
    });

    const request = this.performGet(path, operation, controller);
    try {
      return await Promise.race([request, deadline]);
    } catch (error) {
      if (error instanceof ReviewControlError) {
        throw error;
      }
      if (timedOut || controller.signal.aborted) {
        throw new ReviewControlTimeoutError(operation, this.timeoutMs);
      }
      throw new ReviewControlNetworkError(operation, error);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async performGet(
    path: string,
    operation: string,
    controller: AbortController,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(path, {
        cache: "no-store",
        credentials: "include",
        headers: { Accept: "application/json" },
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw error;
      }
      throw new ReviewControlNetworkError(operation, error);
    }

    const body = await readBody(response, operation, controller);
    if (!response.ok) {
      const serverError = parseServerError(body);
      const requestId = response.headers.get("x-request-id") ?? undefined;
      const suffix = requestId === undefined ? "" : ` Request ID: ${requestId}.`;
      throw new ReviewControlHttpError(
        `${serverError.message ?? `The control plane returned HTTP ${response.status}.`}${suffix}`,
        {
          operation,
          requestId,
          retryable: serverError.retryable ?? (response.status >= 500 || response.status === 429),
          serverCode: serverError.code,
          status: response.status,
        },
      );
    }

    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (contentType === undefined || !contentType.includes("application/json")) {
      throw new ReviewControlProtocolError(
        operation,
        `The ${operation} response did not declare an application/json content type.`,
      );
    }

    try {
      return JSON.parse(body) as unknown;
    } catch (error) {
      throw new ReviewControlProtocolError(
        operation,
        `The ${operation} response did not contain valid JSON.`,
        undefined,
        error,
      );
    }
  }
}
