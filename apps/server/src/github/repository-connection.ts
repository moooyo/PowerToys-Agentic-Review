import { type GitHubRepository, ManagedRepositoryNameSchema } from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";

const githubApiOrigin = "https://api.github.com";
const maximumResponseBytes = 2 * 1_024 * 1_024;
const maximumRedirects = 2;
const maximumTimeoutMs = 15_000;

const errorDefinitions = {
  repository_request_invalid: {
    statusCode: 400,
    message: "The repository name or expected identity is invalid.",
  },
  repository_configuration_invalid: {
    statusCode: 503,
    message: "The repository connection service is not configured correctly.",
  },
  repository_not_accessible: {
    statusCode: 404,
    message: "The repository was not found or is not accessible with the configured credentials.",
  },
  repository_identity_changed: {
    statusCode: 409,
    message: "The repository name now identifies a different GitHub repository.",
  },
  repository_response_invalid: {
    statusCode: 502,
    message: "GitHub returned an invalid repository response.",
  },
  repository_upstream_unavailable: {
    statusCode: 503,
    message: "GitHub could not complete the repository connection check. Try again later.",
  },
  repository_connection_timeout: {
    statusCode: 503,
    message: "The repository connection check exceeded its time limit.",
  },
  repository_connection_cancelled: {
    statusCode: 503,
    message: "The repository connection check was cancelled.",
  },
} as const;

export type RepositoryConnectionErrorCode = keyof typeof errorDefinitions;

export class RepositoryConnectionError extends Error {
  public readonly statusCode: number;

  public constructor(public readonly code: RepositoryConnectionErrorCode) {
    super(errorDefinitions[code].message);
    this.name = "RepositoryConnectionError";
    this.statusCode = errorDefinitions[code].statusCode;
  }
}

export interface RepositoryConnectionResolverOptions {
  readonly token?: string;
  readonly signal?: AbortSignal;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

export type RepositoryConnectionResolver = (
  fullName: string,
  expectedGithubRepositoryId?: number,
) => Promise<GitHubRepository>;

type InterruptionCode = "repository_connection_timeout" | "repository_connection_cancelled";

interface RequestBoundary {
  readonly signal: AbortSignal;
  check(): void;
  wait<T>(operation: Promise<T>): Promise<T>;
  close(): void;
}

const createRequestBoundary = (timeoutMs: number, callerSignal?: AbortSignal): RequestBoundary => {
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let interruption: InterruptionCode | undefined;
  const interrupt = (code: InterruptionCode): void => {
    if (controller.signal.aborted) return;
    interruption = code;
    // Never propagate a caller's arbitrary abort reason into an upstream request or an error.
    controller.abort();
  };
  const timer = setTimeout(() => interrupt("repository_connection_timeout"), timeoutMs);
  const onCallerAbort = (): void => interrupt("repository_connection_cancelled");
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal?.aborted) onCallerAbort();

  const check = (): void => {
    if (interruption !== undefined) throw new RepositoryConnectionError(interruption);
    if (performance.now() >= deadline) {
      interrupt("repository_connection_timeout");
      throw new RepositoryConnectionError("repository_connection_timeout");
    }
  };

  return {
    signal: controller.signal,
    check,
    wait: async <T>(operation: Promise<T>): Promise<T> => {
      let onAbort: () => void = () => undefined;
      const interrupted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(new RepositoryConnectionError(interruption ?? "repository_connection_cancelled"));
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      try {
        // Race explicitly: a transport or stream that ignores abort cannot extend the deadline.
        const result = await Promise.race([operation, interrupted]);
        check();
        return result;
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }
    },
    close: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      controller.abort();
    },
  };
};

const discardResponse = (response: Response): void => {
  // Cleanup is best effort and must not add an unbounded wait after a deadline or redirect.
  void response.body?.cancel().catch(() => undefined);
};

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isBoundedText = (value: unknown, maximumLength: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximumLength &&
  value.trim() === value &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls in upstream metadata.
  !/[\u0000-\u001f\u007f]/u.test(value);

const canonicalRedirect = (location: string | null, currentUrl: URL): URL => {
  if (
    location === null ||
    location.length === 0 ||
    location.length > 2_048 ||
    /[\s%\\?#@]/u.test(location)
  ) {
    throw new RepositoryConnectionError("repository_response_invalid");
  }
  let target: URL;
  try {
    target = new URL(location, currentUrl);
  } catch {
    throw new RepositoryConnectionError("repository_response_invalid");
  }
  const rawPath =
    location.startsWith("/") && !location.startsWith("//")
      ? location
      : /^https:\/\/[^/]+(\/.*)$/iu.exec(location)?.[1];
  if (
    target.origin !== githubApiOrigin ||
    target.username !== "" ||
    target.password !== "" ||
    target.search !== "" ||
    target.hash !== "" ||
    rawPath !== target.pathname
  ) {
    throw new RepositoryConnectionError("repository_response_invalid");
  }
  const namedRepository = target.pathname.startsWith("/repos/")
    ? target.pathname.slice("/repos/".length)
    : undefined;
  const numericRepository = /^\/repositories\/([1-9][0-9]*)$/u.exec(target.pathname)?.[1];
  const validNumericRepository =
    numericRepository !== undefined &&
    isPositiveSafeInteger(Number(numericRepository)) &&
    String(Number(numericRepository)) === numericRepository;
  if (!Value.Check(ManagedRepositoryNameSchema, namedRepository) && !validNumericRepository) {
    throw new RepositoryConnectionError("repository_response_invalid");
  }
  return target;
};

const readBoundedJson = async (response: Response, boundary: RequestBoundary): Promise<unknown> => {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json" && mediaType !== "application/vnd.github+json") {
    discardResponse(response);
    throw new RepositoryConnectionError("repository_response_invalid");
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > maximumResponseBytes)
  ) {
    discardResponse(response);
    throw new RepositoryConnectionError("repository_response_invalid");
  }
  if (response.body === null) throw new RepositoryConnectionError("repository_response_invalid");

  const reader = response.body.getReader();
  const bytes = new Uint8Array(maximumResponseBytes);
  let receivedBytes = 0;
  let complete = false;
  try {
    while (true) {
      boundary.check();
      const next = await boundary.wait(reader.read());
      if (next.done) {
        complete = true;
        break;
      }
      if (
        !(next.value instanceof Uint8Array) ||
        next.value.byteLength > maximumResponseBytes - receivedBytes
      ) {
        throw new RepositoryConnectionError("repository_response_invalid");
      }
      bytes.set(next.value, receivedBytes);
      receivedBytes += next.value.byteLength;
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  boundary.check();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, receivedBytes)),
    );
  } catch {
    throw new RepositoryConnectionError("repository_response_invalid");
  }
  boundary.check();
  return parsed;
};

const repositoryMetadata = (value: unknown, expectedId?: number): GitHubRepository => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RepositoryConnectionError("repository_response_invalid");
  }
  const payload = value as Record<string, unknown>;
  if (
    !isPositiveSafeInteger(payload.id) ||
    !isBoundedText(payload.node_id, 256) ||
    /\s/u.test(payload.node_id) ||
    !Value.Check(ManagedRepositoryNameSchema, payload.full_name) ||
    !isBoundedText(payload.default_branch, 255) ||
    typeof payload.private !== "boolean"
  ) {
    throw new RepositoryConnectionError("repository_response_invalid");
  }
  if (expectedId !== undefined && payload.id !== expectedId) {
    throw new RepositoryConnectionError("repository_identity_changed");
  }
  const [ownerLogin, name] = payload.full_name.split("/");
  if (ownerLogin === undefined || name === undefined) {
    throw new RepositoryConnectionError("repository_response_invalid");
  }
  return {
    githubRepositoryId: payload.id,
    githubNodeId: payload.node_id,
    ownerLogin,
    name,
    fullName: payload.full_name,
    htmlUrl: `https://github.com/${payload.full_name}`,
    defaultBranch: payload.default_branch,
    isPrivate: payload.private,
  };
};

export const createRepositoryConnectionResolver = (
  options: RepositoryConnectionResolverOptions = {},
): RepositoryConnectionResolver => {
  const timeoutMs = options.timeoutMs ?? maximumTimeoutMs;
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const token = options.token;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > maximumTimeoutMs ||
    typeof fetchImplementation !== "function" ||
    (token !== undefined && (typeof token !== "string" || !/^[\x21-\x7e]{1,16384}$/u.test(token)))
  ) {
    throw new RepositoryConnectionError("repository_configuration_invalid");
  }

  return async (fullName, expectedGithubRepositoryId) => {
    if (
      !Value.Check(ManagedRepositoryNameSchema, fullName) ||
      (expectedGithubRepositoryId !== undefined &&
        !isPositiveSafeInteger(expectedGithubRepositoryId))
    ) {
      throw new RepositoryConnectionError("repository_request_invalid");
    }
    const boundary = createRequestBoundary(timeoutMs, options.signal);
    let currentUrl = new URL(`/repos/${fullName}`, githubApiOrigin);
    const visited = new Set([currentUrl.href]);
    try {
      for (let redirects = 0; ; redirects += 1) {
        boundary.check();
        const headers: Record<string, string> = {
          Accept: "application/vnd.github+json",
          "User-Agent": "PowerToys-Agentic-Review/0.1.0",
          "X-GitHub-Api-Version": "2022-11-28",
        };
        if (token !== undefined) headers.Authorization = `Bearer ${token}`;
        const pendingResponse = fetchImplementation(currentUrl, {
          method: "GET",
          headers,
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          signal: boundary.signal,
        });
        let response: Response;
        try {
          response = await boundary.wait(pendingResponse);
        } catch (error) {
          // Also dispose a late response from a transport that did not honor abort.
          void pendingResponse.then(discardResponse, () => undefined);
          throw error;
        }
        if (response.redirected) {
          discardResponse(response);
          throw new RepositoryConnectionError("repository_response_invalid");
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          discardResponse(response);
          if (redirects >= maximumRedirects) {
            throw new RepositoryConnectionError("repository_response_invalid");
          }
          const target = canonicalRedirect(response.headers.get("location"), currentUrl);
          if (visited.has(target.href))
            throw new RepositoryConnectionError("repository_response_invalid");
          visited.add(target.href);
          currentUrl = target;
          continue;
        }
        if (response.status !== 200) {
          discardResponse(response);
          if (
            [401, 404, 410].includes(response.status) ||
            (response.status === 403 &&
              response.headers.get("x-ratelimit-remaining") !== "0" &&
              !response.headers.has("retry-after"))
          ) {
            throw new RepositoryConnectionError("repository_not_accessible");
          }
          throw new RepositoryConnectionError(
            response.status >= 200 && response.status < 400
              ? "repository_response_invalid"
              : "repository_upstream_unavailable",
          );
        }
        const metadata = repositoryMetadata(
          await readBoundedJson(response, boundary),
          expectedGithubRepositoryId,
        );
        boundary.check();
        return metadata;
      }
    } catch (error) {
      boundary.check();
      if (error instanceof RepositoryConnectionError) throw error;
      throw new RepositoryConnectionError("repository_upstream_unavailable");
    } finally {
      boundary.close();
    }
  };
};
