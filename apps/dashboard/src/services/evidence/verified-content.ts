import {
  type EvidenceAssetMetadata,
  maximumEvidenceAssetBytes,
  maximumScreenshotBytes,
} from "@agentic-review/contracts";
import {
  ReviewControlError,
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlTimeoutError,
} from "../review-control/errors";

/** Callers supply an already allowlisted scoped content path and a freshly matched manifest.
 * No Blob is returned until the complete byte stream matches that immutable metadata. */
export async function readVerifiedEvidenceContent({
  path,
  metadata,
  fetch,
  timeoutMs,
  operation,
  signal,
  requireFullResponse = false,
}: {
  path: string;
  metadata: EvidenceAssetMetadata;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  operation: string;
  signal?: AbortSignal;
  requireFullResponse?: boolean;
}): Promise<Blob> {
  signal?.throwIfAborted();
  const maximum =
    metadata.mediaType === "image/png" ? maximumScreenshotBytes : maximumEvidenceAssetBytes;
  if (
    !Number.isSafeInteger(metadata.sizeBytes) ||
    metadata.sizeBytes < 1 ||
    metadata.sizeBytes > maximum
  )
    throw new ReviewControlRequestError(
      operation,
      "sizeBytes",
      "The evidence file exceeds its supported byte limit.",
    );
  const protocol = (message: string): never => {
    throw new ReviewControlProtocolError(operation, message);
  };
  const controller = new AbortController();
  let timedOut = false,
    externalAbort: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    externalAbort = () => {
      controller.abort(signal.reason);
      reject(signal.reason);
    };
    signal.addEventListener("abort", externalAbort, { once: true });
  });
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ReviewControlTimeoutError(operation, timeoutMs));
    }, timeoutMs);
  });
  const read = async () => {
    const response = await fetch(path, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Accept: metadata.mediaType },
      signal: controller.signal,
    });
    try {
      controller.signal.throwIfAborted();
      if (response.redirected) protocol("The evidence download was redirected.");
      if (!response.ok)
        throw new ReviewControlHttpError(
          "The evidence content is unavailable. Refresh its status before trying again.",
          { operation, status: response.status, retryable: response.status >= 500 },
        );
      if (requireFullResponse && response.status !== 200)
        protocol("The evidence response must contain the complete selected file.");
      const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (
        mediaType !== metadata.mediaType ||
        response.headers.get("content-length") !== String(metadata.sizeBytes)
      )
        protocol("The evidence content headers do not match the selected manifest.");
      if (!response.body) protocol("The evidence response did not include a content stream.");
    } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    const bytes = new Uint8Array(metadata.sizeBytes);
    let offset = 0,
      completed = false;
    const reader = response.body?.getReader();
    if (!reader) return protocol("The evidence response did not include a content stream.");
    const cancelReader = () => {
      void reader.cancel(controller.signal.reason).catch(() => undefined);
    };
    controller.signal.addEventListener("abort", cancelReader, { once: true });
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const chunk = await reader.read();
        controller.signal.throwIfAborted();
        if (chunk.done) {
          completed = true;
          break;
        }
        if (offset + chunk.value.byteLength > bytes.byteLength)
          protocol("The evidence response exceeds its declared size.");
        bytes.set(chunk.value, offset);
        offset += chunk.value.byteLength;
      }
    } finally {
      controller.signal.removeEventListener("abort", cancelReader);
      if (!completed || offset !== bytes.byteLength) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
      }
      reader.releaseLock();
    }
    if (offset !== bytes.byteLength)
      protocol("The evidence response ended before all bytes arrived.");
    const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    controller.signal.throwIfAborted();
    const digest = [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (digest !== metadata.sha256) protocol("The evidence content failed its integrity check.");
    return new Blob([bytes], { type: metadata.mediaType });
  };
  try {
    return await Promise.race([read(), deadline, cancellation]);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timedOut) throw new ReviewControlTimeoutError(operation, timeoutMs);
    if (error instanceof ReviewControlError) throw error;
    throw new ReviewControlNetworkError(operation);
  } finally {
    clearTimeout(timeout);
    if (externalAbort) signal?.removeEventListener("abort", externalAbort);
    controller.abort();
  }
}
