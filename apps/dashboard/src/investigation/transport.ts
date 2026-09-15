import { FormatRegistry, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

FormatRegistry.Set(
  "date-time",
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value)),
);
FormatRegistry.Set("uri", (value) => URL.canParse(value));

let sessionRequests = new AbortController();

export function suspendInvestigationRequests(): void {
  sessionRequests.abort();
}

export function resumeInvestigationRequests(): void {
  if (sessionRequests.signal.aborted) sessionRequests = new AbortController();
}

export class InvestigationHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "InvestigationHttpError";
  }
}

export function decodeResponse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    throw new Error(
      "The investigation service returned an invalid structured response. Refresh or inspect the task logs.",
    );
  }
  return value as Static<T>;
}

export type InvestigationTransport = <T extends TSchema>(
  path: string,
  schema: T,
  options?: { method?: "POST"; body?: unknown; signal?: AbortSignal },
) => Promise<Static<T>>;

export function createHttpTransport(fetcher: typeof fetch = fetch): InvestigationTransport {
  return async (path, schema, options) => {
    const signal = options?.signal
      ? AbortSignal.any([sessionRequests.signal, options.signal])
      : sessionRequests.signal;
    signal.throwIfAborted();
    const response = await fetcher(path, {
      method: options?.method ?? "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: {
        Accept: "application/json",
        ...(options?.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    signal.throwIfAborted();
    if (!response.ok) {
      let message =
        response.status === 401
          ? "Your session expired. Sign in again."
          : response.status === 403
            ? "Your account does not have permission for this operation."
            : response.status === 409
              ? "The source or action context changed. Refresh and prepare the operation again."
              : `The investigation request failed (${response.status}). No success was recorded.`;
      const detail: unknown = await response.json().catch(() => null);
      if (
        typeof detail === "object" &&
        detail !== null &&
        "code" in detail &&
        typeof detail.code === "string" &&
        "message" in detail &&
        typeof detail.message === "string"
      ) {
        message = `${detail.message} (${detail.code})`;
      }
      throw new InvestigationHttpError(response.status, message);
    }
    const value: unknown = await response.json();
    signal.throwIfAborted();
    return decodeResponse(schema, value);
  };
}

export function queryString(values: Record<string, string | number | undefined>): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) parameters.set(key, String(value));
  }
  return parameters.size > 0 ? `?${parameters.toString()}` : "";
}
