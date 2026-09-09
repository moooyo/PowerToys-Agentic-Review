import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  AppendEvidenceChunkRequestSchema,
  type EvidenceAssetManifest,
  EvidenceAssetManifestSchema,
  getEvidenceChunkDecodedBytes,
  maximumEvidenceChunkBytes,
} from "@agentic-review/contracts";
import { type TSchema, Type } from "@sinclair/typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ConfigurationHttpError, validateConfigurationResponse } from "./configuration-support.js";
import { mapEvidenceHttpError } from "./evidence-http-errors.js";

export class EvidenceHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "EvidenceHttpError";
  }
}

export function evidenceError(error: unknown): EvidenceHttpError {
  if (error instanceof EvidenceHttpError) return error;
  const mapped = mapEvidenceHttpError(error);
  if (mapped !== undefined)
    return new EvidenceHttpError(mapped.statusCode, mapped.code, mapped.message, mapped.retryable);
  if (error instanceof ConfigurationHttpError) {
    return error.statusCode === 502
      ? new EvidenceHttpError(
          502,
          "evidence_response_invalid",
          "The evidence response could not be validated.",
        )
      : new EvidenceHttpError(400, "evidence_invalid", "The evidence request is invalid.");
  }
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  if (code === "PLATFORM_FORBIDDEN")
    return new EvidenceHttpError(
      403,
      "platform_forbidden",
      "This operator is not authorized to access the requested evidence.",
    );
  if (code === "PLATFORM_NOT_FOUND")
    return new EvidenceHttpError(
      404,
      "platform_not_found",
      "The requested evidence was not found.",
    );
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE")
    return new EvidenceHttpError(
      413,
      "evidence_request_too_large",
      "Evidence requests must not exceed one MiB.",
    );
  if (code === "FST_ERR_CTP_INVALID_JSON_BODY" || code === "FST_ERR_CTP_EMPTY_JSON_BODY")
    return new EvidenceHttpError(400, "evidence_invalid", "The evidence request is invalid.");
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE")
    return new EvidenceHttpError(
      415,
      "evidence_invalid",
      "Evidence uploads require application/json.",
    );
  return new EvidenceHttpError(
    500,
    "evidence_operation_failed",
    "The evidence operation could not be completed.",
  );
}

export function sendEvidenceError(reply: FastifyReply, failure: unknown): FastifyReply {
  const error = evidenceError(failure);
  if (reply.raw.headersSent) {
    reply.raw.destroy();
    return reply;
  }
  reply
    .removeHeader("content-length")
    .removeHeader("content-disposition")
    .removeHeader("accept-ranges")
    .type("application/json");
  if (error.statusCode === 503 && error.retryable) reply.header("retry-after", "1");
  return reply
    .code(error.statusCode)
    .send({ code: error.code, message: error.message, retryable: error.retryable });
}

export function unavailableDuringShutdown(signal: AbortSignal): void {
  if (signal.aborted)
    throw new EvidenceHttpError(
      503,
      "evidence_unavailable",
      "Evidence requests are unavailable during server shutdown.",
      true,
    );
}

export interface EvidenceDownloadChunk {
  readonly manifest: EvidenceAssetManifest;
  readonly bytes: Buffer;
  readonly eof: boolean;
}

/** Callers provide the real purpose-specific identity schema; byte validation is shared. */
export function validateEvidenceDownloadChunk(
  value: unknown,
  offset: number,
  manifestSchema: TSchema,
  extraProperties: Record<string, TSchema> = {},
): EvidenceDownloadChunk {
  const checked = validateConfigurationResponse(
    Type.Object(
      {
        ...extraProperties,
        manifest: manifestSchema,
        offset: Type.Literal(offset),
        base64: AppendEvidenceChunkRequestSchema.properties.base64,
        eof: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    value,
  );
  const manifest = validateConfigurationResponse(EvidenceAssetManifestSchema, checked.manifest);
  const length = getEvidenceChunkDecodedBytes(checked.base64);
  if (
    length === null ||
    length !== Math.min(maximumEvidenceChunkBytes, manifest.metadata.sizeBytes - offset) ||
    checked.eof !== (offset + length === manifest.metadata.sizeBytes)
  )
    throw new EvidenceHttpError(
      502,
      "evidence_response_invalid",
      "The evidence download chunk is invalid.",
    );
  return { manifest, bytes: Buffer.from(checked.base64, "base64"), eof: checked.eof };
}

type ReadChunk = (
  offset: number,
  signal: AbortSignal,
  expectedManifest?: EvidenceAssetManifest,
) => Promise<EvidenceDownloadChunk>;

async function cancellableChunk(
  read: () => Promise<EvidenceDownloadChunk>,
  signal: AbortSignal,
): Promise<EvidenceDownloadChunk> {
  unavailableDuringShutdown(signal);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      read().then((value) => {
        unavailableDuringShutdown(signal);
        return value;
      }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          try {
            unavailableDuringShutdown(signal);
          } catch (error) {
            reject(error);
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Streams only caller-validated chunks. It has no knowledge of ordinary or evaluation authority. */
export async function sendEvidenceContent(
  request: FastifyRequest,
  reply: FastifyReply,
  shutdownSignal: AbortSignal,
  assetId: string,
  readChunk: ReadChunk,
): Promise<FastifyReply> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const cleanup = () => {
    shutdownSignal.removeEventListener("abort", cancel);
    request.raw.removeListener("aborted", cancel);
    reply.raw.removeListener("close", cancel);
  };
  shutdownSignal.addEventListener("abort", cancel, { once: true });
  request.raw.once("aborted", cancel);
  reply.raw.once("close", cancel);
  const assertAvailable = () => {
    // Destruction can precede the close event; do not read or emit in that interval.
    if (shutdownSignal.aborted || request.raw.aborted || reply.raw.destroyed) cancel();
    unavailableDuringShutdown(abort.signal);
  };
  const nextChunk = async (offset: number, expectedManifest?: EvidenceAssetManifest) => {
    assertAvailable();
    const value = await cancellableChunk(
      () => readChunk(offset, abort.signal, expectedManifest),
      abort.signal,
    );
    assertAvailable();
    return value;
  };
  try {
    // The first chunk is checked before headers so an unavailable asset retains its JSON error.
    const first = await nextChunk(0);
    const manifest = structuredClone(first.manifest);
    const digest = createHash("sha256");
    const checkDigest = (chunk: EvidenceDownloadChunk) => {
      digest.update(chunk.bytes);
      if (chunk.eof && digest.digest("hex") !== manifest.metadata.sha256)
        throw new EvidenceHttpError(
          502,
          "evidence_response_invalid",
          "The evidence content digest is invalid.",
        );
    };
    checkDigest(first);
    async function* chunks() {
      try {
        let current = first;
        let offset = 0;
        while (true) {
          assertAvailable();
          yield current.bytes;
          offset += current.bytes.length;
          if (current.eof) return;
          current = await nextChunk(offset, manifest);
          checkDigest(current);
        }
      } catch (error) {
        throw evidenceError(error);
      }
    }
    const stream = Readable.from(chunks(), {
      objectMode: false,
      highWaterMark: maximumEvidenceChunkBytes,
      signal: abort.signal,
    });
    stream.once("close", cleanup);
    const mediaType = manifest.metadata.mediaType;
    const extensions = {
      "image/png": "png",
      "application/json": "json",
      "application/zip": "zip",
      "text/plain": "txt",
    };
    const fileName = `${assetId.replace(/[^A-Za-z0-9._-]/gu, "_")}.${extensions[mediaType]}`;
    reply
      .type(mediaType)
      .header("content-length", manifest.metadata.sizeBytes)
      .header(
        "content-disposition",
        `${mediaType === "image/png" ? "inline" : "attachment"}; filename="${fileName}"`,
      )
      .header("x-content-type-options", "nosniff")
      .header("accept-ranges", "none");
    return reply.send(stream);
  } catch (error) {
    cleanup();
    throw error;
  }
}
