import { createHash } from "node:crypto";
import type { InvestigationArtifactV1 } from "@agentic-review/contracts";
import type { InvestigationRepositoryRecord } from "./types.js";

export type InvestigationMediaUploadResult =
  | { readonly state: "uploaded"; readonly url: string }
  | {
      readonly state: "blocked" | "rejected" | "unknown";
      readonly code: string;
      readonly retryable: boolean;
    };

export interface InvestigationMediaUploadRequest {
  readonly repository: InvestigationRepositoryRecord;
  readonly artifact: InvestigationArtifactV1;
  readonly content: Uint8Array;
}

export interface InvestigationMediaUploader {
  upload(
    request: InvestigationMediaUploadRequest,
    beforeDispatch: () => void,
    signal?: AbortSignal,
  ): Promise<InvestigationMediaUploadResult>;
}

export const investigationMediaTypes = new Map([
  ["image/png", ".png"],
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"],
  ["video/quicktime", ".mov"],
]);

/** Only URLs returned by the authenticated upload transport may reach comment rendering. */
export function isGitHubMediaUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(
    value,
  );
}

/** Verify stored bytes again before sending them outside the evidence store. */
export function validateInvestigationMedia(
  artifact: InvestigationArtifactV1,
  content: Uint8Array,
): void {
  const extension = investigationMediaTypes.get(artifact.mediaType);
  const bytes = Buffer.from(content);
  if (
    extension === undefined ||
    !artifact.name.toLowerCase().endsWith(extension) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control bytes and separators in attachment filenames.
    /[\\/\x00-\x1f\x7f]/u.test(artifact.name) ||
    artifact.name.length > 255 ||
    artifact.kind !== (artifact.mediaType === "image/png" ? "image" : "video") ||
    bytes.byteLength === 0 ||
    bytes.byteLength !== artifact.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== artifact.digest ||
    artifact.availability !== "available" ||
    bytes.byteLength > (artifact.mediaType === "image/png" ? 10 : 100) * 1_024 * 1_024
  ) {
    throw new Error("media_identity_invalid");
  }
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const validContainer =
    artifact.mediaType === "image/png"
      ? bytes.length >= 24 &&
        bytes.subarray(0, 8).equals(png) &&
        bytes.toString("ascii", 12, 16) === "IHDR"
      : artifact.mediaType === "video/webm"
        ? bytes.length >= 8 &&
          bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
          bytes.subarray(0, 4096).includes(Buffer.from("webm"))
        : bytes.length >= 12 &&
          bytes.toString("ascii", 4, 8) === "ftyp" &&
          bytes.readUInt32BE(0) >= 12 &&
          bytes.readUInt32BE(0) <= bytes.length;
  if (!validContainer) throw new Error("media_container_invalid");
}

export interface GitHubMediaUploaderOptions {
  readonly token: string;
  readonly expectedGitHubUserId: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Uses the upload-only endpoint used by gh's internal/attachments/client.go.
 * It deliberately never runs gh pr comment or edits the account's last comment.
 */
export class GitHubMediaUploader implements InvestigationMediaUploader {
  readonly #fetch: typeof globalThis.fetch;

  constructor(private readonly options: GitHubMediaUploaderOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (
      !options.token ||
      !Number.isSafeInteger(options.expectedGitHubUserId) ||
      options.expectedGitHubUserId <= 0
    ) {
      throw new Error("media_publisher_configuration_invalid");
    }
  }

  async upload(
    request: InvestigationMediaUploadRequest,
    beforeDispatch: () => void,
    signal?: AbortSignal,
  ): Promise<InvestigationMediaUploadResult> {
    const { repository, artifact } = request;
    try {
      validateInvestigationMedia(artifact, request.content);
      if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.fullName) ||
        !Number.isSafeInteger(repository.githubRepositoryId) ||
        repository.githubRepositoryId <= 0
      ) {
        throw new Error("media_repository_invalid");
      }
    } catch {
      return { state: "blocked", code: "media_identity_invalid", retryable: false };
    }
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(this.options.requestTimeoutMs ?? 120_000),
      ...(signal === undefined ? [] : [signal]),
    ]);
    const headers = {
      authorization: `Bearer ${this.options.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "AgenticReview-E2E-Media",
    };
    try {
      // Use the exact configured repository; fork parent metadata is never a target.
      const userResponse = await this.#fetch("https://api.github.com/user", {
        headers,
        signal: requestSignal,
        redirect: "error",
      });
      if (!userResponse.ok)
        return {
          state: "blocked",
          code: "media_publisher_unavailable",
          retryable: userResponse.status === 429 || userResponse.status >= 500,
        };
      const user = record(await readJson(userResponse));
      if (user?.id !== this.options.expectedGitHubUserId)
        return { state: "blocked", code: "media_publisher_identity_changed", retryable: false };
      const repositoryResponse = await this.#fetch(
        `https://api.github.com/repos/${repository.fullName}`,
        { headers, signal: requestSignal, redirect: "error" },
      );
      if (!repositoryResponse.ok)
        return {
          state: "blocked",
          code: "media_repository_unavailable",
          retryable: repositoryResponse.status === 429 || repositoryResponse.status >= 500,
        };
      const remoteRepository = record(await readJson(repositoryResponse));
      const permissions = record(remoteRepository?.permissions);
      if (
        remoteRepository === undefined ||
        remoteRepository.id !== repository.githubRepositoryId ||
        typeof remoteRepository.full_name !== "string" ||
        remoteRepository.full_name.toLowerCase() !== repository.fullName.toLowerCase()
      ) {
        return { state: "blocked", code: "media_repository_identity_changed", retryable: false };
      }
      if (
        permissions?.push !== true &&
        permissions?.admin !== true &&
        permissions?.maintain !== true
      ) {
        return {
          state: "blocked",
          code: "media_repository_write_permission_required",
          retryable: false,
        };
      }
      requestSignal.throwIfAborted();
      beforeDispatch();
    } catch {
      return { state: "blocked", code: "media_preflight_failed", retryable: true };
    }
    // From this point onward, lack of a conclusive response is an unknown effect.
    try {
      const endpoint = new URL("https://uploads.github.com/user-attachments/assets");
      endpoint.searchParams.set("name", artifact.name);
      endpoint.searchParams.set("content_type", artifact.mediaType);
      endpoint.searchParams.set("repository_id", String(repository.githubRepositoryId));
      const response = await this.#fetch(endpoint, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/octet-stream",
          "content-length": String(request.content.byteLength),
        },
        body: Buffer.from(request.content),
        signal: requestSignal,
        redirect: "error",
      });
      if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        return {
          state: "rejected",
          code: `media_http_${response.status}`,
          retryable: response.status === 429,
        };
      }
      if (!response.ok)
        return { state: "unknown", code: "media_upload_effect_unknown", retryable: false };
      const result = record(await readJson(response));
      if (!isGitHubMediaUrl(result?.url))
        return { state: "unknown", code: "media_upload_receipt_invalid", retryable: false };
      return { state: "uploaded", url: result.url };
    } catch {
      return { state: "unknown", code: "media_upload_effect_unknown", retryable: false };
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > 1_048_576)
    throw new Error("media_response_too_large");
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("media_response_missing");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 1_048_576) throw new Error("media_response_too_large");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
