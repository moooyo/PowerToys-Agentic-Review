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
const sessionExpiredListeners = new Set<() => void>();

export function subscribeInvestigationSessionExpired(listener: () => void): () => void {
  sessionExpiredListeners.add(listener);
  return () => {
    sessionExpiredListeners.delete(listener);
  };
}

export function notifyInvestigationSessionExpired(): void {
  for (const listener of sessionExpiredListeners) listener();
}

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

async function requireSuccessfulResponse(response: Response): Promise<void> {
  if (response.ok) return;
  if (response.status === 401) notifyInvestigationSessionExpired();
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

export async function fetchInvestigationArtifactContent(
  id: string,
  requestSignal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Blob> {
  const signal = requestSignal
    ? AbortSignal.any([sessionRequests.signal, requestSignal])
    : sessionRequests.signal;
  signal.throwIfAborted();
  const response = await fetcher(`/api/artifacts/${encodeURIComponent(id)}/content`, {
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    signal,
  });
  signal.throwIfAborted();
  await requireSuccessfulResponse(response);
  const content = await response.blob();
  signal.throwIfAborted();
  return content;
}

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
    await requireSuccessfulResponse(response);
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
