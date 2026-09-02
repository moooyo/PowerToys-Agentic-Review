import { createHash, timingSafeEqual } from "node:crypto";
import {
  isCanonicalResultArtifactChunkData,
  maximumResultArtifactBytes,
  maximumResultArtifactChunkBytes,
  type ResultArtifactChunkRequest,
  ResultArtifactChunkRequestSchema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";

const requestKeys = [
  "jobId",
  "runAttemptId",
  "workerNodeId",
  "workerInstanceId",
  "leaseToken",
  "leaseGeneration",
  "chunkIndex",
  "offsetBytes",
  "chunkBytes",
  "chunkSha256",
  "data",
] as const;
const requestKeySet: ReadonlySet<string> = new Set(requestKeys);

export type ArtifactChunkTransportValidationErrorCode =
  | "ARTIFACT_CHUNK_DIGEST_MISMATCH"
  | "ARTIFACT_CHUNK_ENCODING_INVALID"
  | "ARTIFACT_CHUNK_LENGTH_MISMATCH"
  | "ARTIFACT_CHUNK_RANGE_INVALID"
  | "ARTIFACT_CHUNK_REQUEST_INVALID";

const errorMessages: Readonly<Record<ArtifactChunkTransportValidationErrorCode, string>> =
  Object.freeze({
    ARTIFACT_CHUNK_DIGEST_MISMATCH: "Artifact chunk bytes do not match the declared SHA-256.",
    ARTIFACT_CHUNK_ENCODING_INVALID: "Artifact chunk data is not canonical unpadded base64url.",
    ARTIFACT_CHUNK_LENGTH_MISMATCH: "Artifact chunk bytes do not match the declared byte length.",
    ARTIFACT_CHUNK_RANGE_INVALID: "Artifact chunk range exceeds the result artifact byte limit.",
    ARTIFACT_CHUNK_REQUEST_INVALID: "Artifact chunk request is invalid.",
  });

export class ArtifactChunkTransportValidationError extends TypeError {
  readonly code: ArtifactChunkTransportValidationErrorCode;

  constructor(code: ArtifactChunkTransportValidationErrorCode) {
    super(errorMessages[code]);
    this.name = "ArtifactChunkTransportValidationError";
    this.code = code;
  }
}

export type ResultArtifactChunkTransportMetadata = Readonly<
  Omit<ResultArtifactChunkRequest, "data">
>;

export interface ValidatedResultArtifactChunkTransport {
  readonly metadata: Readonly<ResultArtifactChunkTransportMetadata>;
  /** A detached copy owned by the validated transport value. */
  readonly bytes: Uint8Array;
}

const fail = (code: ArtifactChunkTransportValidationErrorCode): never => {
  throw new ArtifactChunkTransportValidationError(code);
};

const snapshotExactRequest = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("ARTIFACT_CHUNK_REQUEST_INVALID");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return fail("ARTIFACT_CHUNK_REQUEST_INVALID");
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== requestKeys.length ||
    keys.some((key) => typeof key !== "string" || !requestKeySet.has(key))
  ) {
    return fail("ARTIFACT_CHUNK_REQUEST_INVALID");
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of requestKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return fail("ARTIFACT_CHUNK_REQUEST_INVALID");
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
};

export const snapshotResultArtifactChunkTransport = (
  value: unknown,
): ValidatedResultArtifactChunkTransport => {
  const snapshot = snapshotExactRequest(value);
  if (!Value.Check(ResultArtifactChunkRequestSchema, snapshot)) {
    return fail("ARTIFACT_CHUNK_REQUEST_INVALID");
  }
  const request = snapshot as unknown as ResultArtifactChunkRequest;
  if (!isCanonicalResultArtifactChunkData(request.data)) {
    return fail("ARTIFACT_CHUNK_ENCODING_INVALID");
  }

  const decoded = Buffer.from(request.data, "base64url");
  if (decoded.byteLength !== request.chunkBytes) {
    return fail("ARTIFACT_CHUNK_LENGTH_MISMATCH");
  }
  const actualDigest = createHash("sha256").update(decoded).digest();
  const expectedDigest = Buffer.from(request.chunkSha256, "hex");
  if (
    expectedDigest.byteLength !== actualDigest.byteLength ||
    !timingSafeEqual(actualDigest, expectedDigest)
  ) {
    return fail("ARTIFACT_CHUNK_DIGEST_MISMATCH");
  }

  const endOffsetBytes = request.offsetBytes + decoded.byteLength;
  if (
    !Number.isSafeInteger(endOffsetBytes) ||
    endOffsetBytes < 1 ||
    endOffsetBytes > maximumResultArtifactBytes
  ) {
    return fail("ARTIFACT_CHUNK_RANGE_INVALID");
  }
  if (decoded.byteLength > maximumResultArtifactChunkBytes) {
    return fail("ARTIFACT_CHUNK_REQUEST_INVALID");
  }

  const metadata = Object.freeze({
    jobId: request.jobId,
    runAttemptId: request.runAttemptId,
    workerNodeId: request.workerNodeId,
    workerInstanceId: request.workerInstanceId,
    leaseToken: request.leaseToken,
    leaseGeneration: request.leaseGeneration,
    chunkIndex: request.chunkIndex,
    offsetBytes: request.offsetBytes,
    chunkBytes: request.chunkBytes,
    chunkSha256: request.chunkSha256,
  });
  return Object.freeze({ metadata, bytes: new Uint8Array(decoded) });
};
