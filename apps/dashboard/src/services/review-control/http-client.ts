import {
  ReviewControlError,
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlResponseTooLargeError,
  ReviewControlTimeoutError,
} from "./errors";

export const DASHBOARD_API_PREFIX = "/api/v1/dashboard/";
export const OPERATOR_WORKER_NODES_PATH = "/api/v1/operator/worker-nodes";
export const DEFAULT_DASHBOARD_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_DASHBOARD_RESPONSE_BYTES = 2 * 1_024 * 1_024;

const workerCredentialMutationPathPattern =
  /^\/api\/v1\/operator\/worker-nodes\/worker:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:token\/rotate|revoke)$/u;
const workerTokenExposurePattern = /arw1_[A-Za-z0-9_-]{43}/u;
const canonicalDiagnosticPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const canonicalRawPathPattern = /^[\x21-\x7e]+$/u;
const dashboardReadPathnames = new Set([
  "/api/v1/dashboard/jobs",
  "/api/v1/dashboard/system",
  "/api/v1/dashboard/work-items",
  "/api/v1/dashboard/workers",
]);

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

const safeDiagnostic = (value: unknown): string | undefined =>
  typeof value === "string" &&
  canonicalDiagnosticPattern.test(value) &&
  !workerTokenExposurePattern.test(value)
    ? value
    : undefined;

const safeServerMessage = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 2_048 &&
  ![...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  }) &&
  !workerTokenExposurePattern.test(value)
    ? value
    : undefined;

const parseServerError = (body: string): ServerErrorBody => {
  if (body === "") {
    return {};
  }

  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value)) {
      return {};
    }
    const code = safeDiagnostic(value.code);
    const message = safeServerMessage(value.message);
    return {
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message }),
      ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
    };
  } catch {
    return {};
  }
};

const isCanonicalDashboardRead = (path: string): boolean => {
  const queryIndex = path.indexOf("?");
  if (queryIndex !== -1 && path.indexOf("?", queryIndex + 1) !== -1) {
    return false;
  }
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  if (!dashboardReadPathnames.has(pathname)) {
    return false;
  }
  if (queryIndex === -1) {
    return true;
  }
  const query = path.slice(queryIndex + 1);
  return query.length > 0 && new URLSearchParams(query).toString() === query;
};

const isCanonicalWorkerCredentialList = (path: string): boolean => {
  const prefix = `${OPERATOR_WORKER_NODES_PATH}?`;
  if (!path.startsWith(prefix)) {
    return false;
  }
  const query = path.slice(prefix.length);
  const parameters = new URLSearchParams(query);
  if (
    parameters.toString() !== query ||
    [...parameters.keys()].join(",") !== "page,pageSize,sort"
  ) {
    return false;
  }
  const page = parameters.get("page");
  const pageSize = parameters.get("pageSize");
  const sort = parameters.get("sort");
  if (page === null || pageSize === null || sort !== "identity" || !/^[1-9][0-9]*$/u.test(page)) {
    return false;
  }
  const pageNumber = Number(page);
  const pageSizeNumber = Number(pageSize);
  return (
    Number.isSafeInteger(pageNumber) &&
    pageNumber >= 1 &&
    Number.isSafeInteger(pageSizeNumber) &&
    pageSizeNumber >= 1 &&
    pageSizeNumber <= 200 &&
    String(pageNumber) === page &&
    String(pageSizeNumber) === pageSize
  );
};

const ensureControlPath = (path: string, method: "GET" | "POST"): void => {
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const hasUnsafeSyntax =
    !canonicalRawPathPattern.test(path) ||
    path.includes("\\") ||
    path.includes("#") ||
    pathname.includes("%") ||
    pathname.split("/").some((segment) => segment === "." || segment === "..");
  if (hasUnsafeSyntax) {
    throw new Error("The dashboard request path is outside its allowlisted control-plane API.");
  }

  const isDashboardRead = method === "GET" && isCanonicalDashboardRead(path);
  const isWorkerCredentialList = method === "GET" && isCanonicalWorkerCredentialList(path);
  const isWorkerCredentialCreate = method === "POST" && path === OPERATOR_WORKER_NODES_PATH;
  const isWorkerCredentialMutation =
    method === "POST" && workerCredentialMutationPathPattern.test(path);

  if (
    !isDashboardRead &&
    !isWorkerCredentialList &&
    !isWorkerCredentialCreate &&
    !isWorkerCredentialMutation
  ) {
    throw new Error("The dashboard request path is outside its allowlisted control-plane API.");
  }
};

const decodeUtf8 = (value: ArrayBuffer | Uint8Array, operation: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new ReviewControlProtocolError(
      operation,
      `The ${operation} response was not valid UTF-8.`,
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
    return this.request(path, operation, "GET");
  }

  async post(
    path: string,
    operation: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return this.request(path, operation, "POST", JSON.stringify(body));
  }

  private async request(
    path: string,
    operation: string,
    method: "GET" | "POST",
    body?: string,
  ): Promise<unknown> {
    ensureControlPath(path, method);
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

    const request = this.performRequest(path, operation, method, controller, body);
    try {
      return await Promise.race([request, deadline]);
    } catch (error) {
      if (error instanceof ReviewControlError) {
        throw error;
      }
      if (timedOut || controller.signal.aborted) {
        throw new ReviewControlTimeoutError(operation, this.timeoutMs);
      }
      throw new ReviewControlNetworkError(operation);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async performRequest(
    path: string,
    operation: string,
    method: "GET" | "POST",
    controller: AbortController,
    requestBody?: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(path, {
        ...(requestBody === undefined ? {} : { body: requestBody }),
        cache: "no-store",
        credentials: "include",
        headers: {
          Accept: "application/json",
          ...(requestBody === undefined ? {} : { "Content-Type": "application/json" }),
        },
        method,
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw error;
      }
      throw new ReviewControlNetworkError(operation);
    }

    const body = await readBody(response, operation, controller);
    if (!response.ok) {
      const serverError = parseServerError(body);
      const requestId = safeDiagnostic(response.headers.get("x-request-id"));
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
    } catch {
      throw new ReviewControlProtocolError(
        operation,
        `The ${operation} response did not contain valid JSON.`,
      );
    }
  }
}
