import { createHash } from "node:crypto";
import {
  maximumResultArtifactBytes,
  maximumResultArtifactChunkBytes,
  type ResultArtifactChunkRequest,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactChunkTransportValidationError,
  snapshotResultArtifactChunkTransport,
} from "../../dist/artifacts/artifact-chunk-transport.js";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const captureValidationError = (
  operation: () => unknown,
): ArtifactChunkTransportValidationError => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactChunkTransportValidationError);
    return error as ArtifactChunkTransportValidationError;
  }
  throw new Error("Expected artifact chunk transport validation to fail.");
};

const requestFor = (
  bytes: Uint8Array = Buffer.from('{"ok":true}', "utf8"),
  overrides: Partial<ResultArtifactChunkRequest> = {},
): ResultArtifactChunkRequest => ({
  jobId: "job-id",
  runAttemptId: "run-attempt-id",
  workerNodeId: "worker-node",
  workerInstanceId: "worker-instance",
  leaseToken: "x".repeat(32),
  leaseGeneration: 1,
  chunkIndex: 0,
  offsetBytes: 0,
  chunkBytes: bytes.byteLength,
  chunkSha256: sha256(bytes),
  data: Buffer.from(bytes).toString("base64url"),
  ...overrides,
});

describe("result artifact chunk transport validation", () => {
  it("returns frozen metadata and a detached byte copy", () => {
    const bytes = Buffer.from('{"ok":true}', "utf8");
    const input = requestFor(bytes);
    const first = snapshotResultArtifactChunkTransport(input);

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.metadata)).toBe(true);
    expect(first.metadata).toEqual({
      jobId: input.jobId,
      runAttemptId: input.runAttemptId,
      workerNodeId: input.workerNodeId,
      workerInstanceId: input.workerInstanceId,
      leaseToken: input.leaseToken,
      leaseGeneration: input.leaseGeneration,
      chunkIndex: input.chunkIndex,
      offsetBytes: input.offsetBytes,
      chunkBytes: input.chunkBytes,
      chunkSha256: input.chunkSha256,
    });
    expect(first.bytes).toEqual(new Uint8Array(bytes));

    first.bytes[0] = 0;
    expect(snapshotResultArtifactChunkTransport(input).bytes).toEqual(new Uint8Array(bytes));
  });

  it("decodes canonical base64url exactly once", () => {
    const input = requestFor();
    const from = vi.spyOn(Buffer, "from");
    try {
      snapshotResultArtifactChunkTransport(input);
      expect(from.mock.calls.filter((call) => call[1] === "base64url")).toHaveLength(1);
    } finally {
      from.mockRestore();
    }
  });

  it.each([
    { data: "Zh", code: "ARTIFACT_CHUNK_ENCODING_INVALID" },
    { data: "Zm9", code: "ARTIFACT_CHUNK_ENCODING_INVALID" },
    { data: "Zg==", code: "ARTIFACT_CHUNK_REQUEST_INVALID" },
    { data: "Zg\n", code: "ARTIFACT_CHUNK_REQUEST_INVALID" },
  ] as const)("rejects noncanonical base64url before decoding: $data", ({ data, code }) => {
    const input = requestFor(Buffer.from("f"), { data });
    const from = vi.spyOn(Buffer, "from");
    try {
      expect(
        captureValidationError(() => snapshotResultArtifactChunkTransport(input)),
      ).toMatchObject({
        code,
      });
      expect(from.mock.calls.filter((call) => call[1] === "base64url")).toHaveLength(0);
    } finally {
      from.mockRestore();
    }
  });

  it("rejects decoded-length, digest, and bounded-range mismatches distinctly", () => {
    const twoBytes = Buffer.from("ok", "utf8");
    expect(
      captureValidationError(() =>
        snapshotResultArtifactChunkTransport(requestFor(twoBytes, { chunkBytes: 1 })),
      ),
    ).toMatchObject({ code: "ARTIFACT_CHUNK_LENGTH_MISMATCH" });
    expect(
      captureValidationError(() =>
        snapshotResultArtifactChunkTransport(requestFor(twoBytes, { chunkSha256: "0".repeat(64) })),
      ),
    ).toMatchObject({ code: "ARTIFACT_CHUNK_DIGEST_MISMATCH" });
    expect(
      captureValidationError(() =>
        snapshotResultArtifactChunkTransport(
          requestFor(twoBytes, { offsetBytes: maximumResultArtifactBytes - 1 }),
        ),
      ),
    ).toMatchObject({ code: "ARTIFACT_CHUNK_RANGE_INVALID" });
  });

  it("accepts the maximum chunk at the final valid artifact range", () => {
    const bytes = Buffer.alloc(maximumResultArtifactChunkBytes, 0xa5);
    const result = snapshotResultArtifactChunkTransport(
      requestFor(bytes, {
        chunkIndex: 7,
        offsetBytes: maximumResultArtifactBytes - maximumResultArtifactChunkBytes,
      }),
    );

    expect(result.metadata.offsetBytes + result.bytes.byteLength).toBe(maximumResultArtifactBytes);
    expect(result.bytes.byteLength).toBe(maximumResultArtifactChunkBytes);
    expect(sha256(result.bytes)).toBe(sha256(bytes));
  });

  it("rejects missing, extra, symbolic, non-enumerable, and accessor fields", () => {
    const valid = requestFor();
    const { data: _data, ...missing } = valid;
    expect(
      captureValidationError(() => snapshotResultArtifactChunkTransport(missing)),
    ).toMatchObject({ code: "ARTIFACT_CHUNK_REQUEST_INVALID" });
    expect(
      captureValidationError(() => snapshotResultArtifactChunkTransport({ ...valid, extra: true })),
    ).toMatchObject({ code: "ARTIFACT_CHUNK_REQUEST_INVALID" });

    const symbolic = { ...valid, [Symbol("extra")]: true };
    expect(
      captureValidationError(() => snapshotResultArtifactChunkTransport(symbolic)),
    ).toMatchObject({ code: "ARTIFACT_CHUNK_REQUEST_INVALID" });

    const nonEnumerable = { ...valid };
    Object.defineProperty(nonEnumerable, "data", { enumerable: false, value: valid.data });
    expect(
      captureValidationError(() => snapshotResultArtifactChunkTransport(nonEnumerable)),
    ).toMatchObject({ code: "ARTIFACT_CHUNK_REQUEST_INVALID" });

    let reads = 0;
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, "data", {
      enumerable: true,
      get() {
        reads += 1;
        return valid.data;
      },
    });
    expect(
      captureValidationError(() => snapshotResultArtifactChunkTransport(accessor)),
    ).toMatchObject({ code: "ARTIFACT_CHUNK_REQUEST_INVALID" });
    expect(reads).toBe(0);
  });

  it("rejects contract-invalid primitive metadata before decoding", () => {
    const input = { ...requestFor(), leaseGeneration: 0 };
    const from = vi.spyOn(Buffer, "from");
    try {
      expect(
        captureValidationError(() => snapshotResultArtifactChunkTransport(input)),
      ).toMatchObject({ code: "ARTIFACT_CHUNK_REQUEST_INVALID" });
      expect(from.mock.calls.filter((call) => call[1] === "base64url")).toHaveLength(0);
    } finally {
      from.mockRestore();
    }
  });
});
