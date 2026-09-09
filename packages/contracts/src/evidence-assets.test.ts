import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AppendEvidenceChunkRequestSchema,
  BeginEvidenceUploadRequestSchema,
  type EvidenceAssetManifest,
  EvidenceAssetManifestSchema,
  type EvidenceAssetMetadata,
  EvidenceAssetMetadataSchema,
  EvidenceUploadResponseSchema,
  FinalizeEvidenceUploadRequestSchema,
  getEvidenceChunkDecodedBytes,
  maximumAttemptEvidenceAssets,
  maximumAttemptEvidenceBytes,
  maximumEvidenceAssetBytes,
  maximumEvidenceChunkBase64Characters,
  maximumEvidenceChunkBytes,
  maximumScreenshotBytes,
} from "./evidence-assets.js";
import type { LeaseIdentity } from "./worker.js";

const existingDateTimeFormat = FormatRegistry.Get("date-time");
beforeAll(() => {
  if (existingDateTimeFormat === undefined) {
    FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  }
});
afterAll(() => {
  if (existingDateTimeFormat === undefined) FormatRegistry.Delete("date-time");
});

const sha256 = "a".repeat(64);
const capturedAt = "2026-09-07T08:00:00.000Z";
const lease: LeaseIdentity = {
  jobId: "job:1",
  runAttemptId: "attempt:1",
  workerNodeId: "node:1",
  workerInstanceId: "instance:1",
  leaseToken: "t".repeat(32),
  leaseGeneration: 1,
};
const metadata: EvidenceAssetMetadata = {
  kind: "screenshot",
  mediaType: "image/png",
  sizeBytes: 1_024,
  sha256,
  capturedAt,
  checkId: "desktop:launch",
};
const begin = { lease, clientAssetId: "client:1", metadata };
const append = { lease, assetId: "asset:1", offset: 0, base64: "AQID", chunkSha256: sha256 };
const finalize = { lease, assetId: "asset:1" };
const manifest: EvidenceAssetManifest = {
  id: "asset:1",
  repositoryId: "repository:1",
  runId: "run:1",
  jobId: lease.jobId,
  runAttemptId: lease.runAttemptId,
  requestId: "request:1",
  profileVersionId: "profile:1",
  revisionKey: sha256,
  planDigest: sha256,
  metadata,
  state: "finalized",
  createdAt: capturedAt,
  finalizedAt: capturedAt,
  retiredAt: null,
};

describe("evidence asset contracts", () => {
  it("publishes consistent content and attempt limits", () => {
    expect(maximumEvidenceChunkBytes).toBe(512 * 1024);
    expect(maximumEvidenceAssetBytes).toBe(64 * 1024 * 1024);
    expect(maximumScreenshotBytes).toBe(16 * 1024 * 1024);
    expect(maximumAttemptEvidenceBytes).toBe(128 * 1024 * 1024);
    expect(maximumAttemptEvidenceAssets).toBe(256);
  });

  it.each([
    ["screenshot", "image/png"],
    ["trace", "application/zip"],
    ["trace", "application/json"],
    ["steps", "application/json"],
    ["log", "text/plain"],
  ])("accepts the %s media type %s", (kind, mediaType) => {
    expect(Value.Check(EvidenceAssetMetadataSchema, { ...metadata, kind, mediaType })).toBe(true);
  });

  it.each([
    { kind: "screenshot", mediaType: "image/jpeg" },
    { kind: "screenshot", mediaType: "application/json" },
    { kind: "trace", mediaType: "image/png" },
    { kind: "steps", mediaType: "text/plain" },
    { kind: "log", mediaType: "application/zip" },
    { kind: "video", mediaType: "video/mp4" },
    { mediaType: "IMAGE/PNG" },
    { mediaType: "image/png; charset=utf-8" },
    { sizeBytes: 0 },
    { sizeBytes: -1 },
    { sizeBytes: 1.5 },
    { sizeBytes: maximumScreenshotBytes + 1 },
    { sha256: "A".repeat(64) },
    { sha256: "a".repeat(63) },
    { capturedAt: "yesterday" },
    { checkId: "launch" },
    { checkId: "profile:../launch" },
    { path: "C:\\evidence\\capture.png" },
    { url: "file:///capture.png" },
    { repositoryId: "repository:other" },
  ])("rejects unsupported or unbounded metadata: %j", (overrides) => {
    expect(Value.Check(EvidenceAssetMetadataSchema, { ...metadata, ...overrides })).toBe(false);
  });

  it("accepts the exact per-kind limits and an omitted check association", () => {
    const { checkId: _checkId, ...unassociated } = metadata;
    expect(Value.Check(EvidenceAssetMetadataSchema, unassociated)).toBe(true);
    expect(
      Value.Check(EvidenceAssetMetadataSchema, { ...metadata, sizeBytes: maximumScreenshotBytes }),
    ).toBe(true);
    const trace = { ...metadata, kind: "trace", mediaType: "application/zip" };
    expect(
      Value.Check(EvidenceAssetMetadataSchema, { ...trace, sizeBytes: maximumEvidenceAssetBytes }),
    ).toBe(true);
    expect(
      Value.Check(EvidenceAssetMetadataSchema, {
        ...trace,
        sizeBytes: maximumEvidenceAssetBytes + 1,
      }),
    ).toBe(false);
  });

  it("requires a complete strict lease for every upload operation", () => {
    for (const [schema, request] of [
      [BeginEvidenceUploadRequestSchema, begin],
      [AppendEvidenceChunkRequestSchema, append],
      [FinalizeEvidenceUploadRequestSchema, finalize],
    ] as const) {
      expect(Value.Check(schema, request)).toBe(true);
      expect(Value.Check(schema, { ...request, lease: undefined })).toBe(false);
      expect(Value.Check(schema, { ...request, lease: { ...lease, leaseToken: "short" } })).toBe(
        false,
      );
      expect(Value.Check(schema, { ...request, lease: { ...lease, leaseGeneration: 0 } })).toBe(
        false,
      );
      expect(
        Value.Check(schema, { ...request, lease: { ...lease, repositoryId: "repository:other" } }),
      ).toBe(false);
    }
  });

  it.each([
    "repositoryId",
    "runId",
    "jobId",
    "runAttemptId",
    "requestId",
    "profileVersionId",
    "path",
  ])("rejects client-supplied ownership or location field %s", (field) => {
    expect(Value.Check(BeginEvidenceUploadRequestSchema, { ...begin, [field]: "injected" })).toBe(
      false,
    );
    expect(Value.Check(AppendEvidenceChunkRequestSchema, { ...append, [field]: "injected" })).toBe(
      false,
    );
    expect(
      Value.Check(FinalizeEvidenceUploadRequestSchema, { ...finalize, [field]: "injected" }),
    ).toBe(false);
  });

  it.each([-1, 0.5, maximumEvidenceAssetBytes + 1])("rejects invalid byte offset %s", (offset) => {
    expect(Value.Check(AppendEvidenceChunkRequestSchema, { ...append, offset })).toBe(false);
    expect(
      Value.Check(EvidenceUploadResponseSchema, { assetId: "asset:1", offset, state: "uploading" }),
    ).toBe(false);
  });

  it("accepts bounded upload progress and finalized replay responses", () => {
    for (const state of ["uploading", "finalized"]) {
      expect(
        Value.Check(EvidenceUploadResponseSchema, {
          assetId: "asset:1",
          offset: maximumEvidenceAssetBytes,
          state,
        }),
      ).toBe(true);
    }
    expect(
      Value.Check(EvidenceUploadResponseSchema, {
        assetId: "asset:1",
        offset: 0,
        state: "retired",
      }),
    ).toBe(false);
  });

  it("accepts server manifests only after finalization", () => {
    expect(Value.Check(EvidenceAssetManifestSchema, manifest)).toBe(true);
    expect(
      Value.Check(EvidenceAssetManifestSchema, {
        ...manifest,
        state: "retired",
        retiredAt: capturedAt,
      }),
    ).toBe(true);
    for (const overrides of [
      { state: "uploading" },
      { finalizedAt: null },
      { runAttemptId: undefined },
      { planDigest: "invalid" },
      { revisionKey: "invalid" },
      { storagePath: "C:\\assets\\asset.bin" },
      { leaseToken: lease.leaseToken },
    ]) {
      expect(Value.Check(EvidenceAssetManifestSchema, { ...manifest, ...overrides })).toBe(false);
    }
  });
});

describe("bounded canonical evidence chunks", () => {
  it.each([
    ["AA==", 1],
    ["/w==", 1],
    ["AAA=", 2],
    ["//8=", 2],
    ["AQID", 3],
    ["////", 3],
  ])("accepts canonical base64 %s", (base64, bytes) => {
    expect(Value.Check(AppendEvidenceChunkRequestSchema, { ...append, base64 })).toBe(true);
    expect(getEvidenceChunkDecodedBytes(base64)).toBe(bytes);
  });

  it.each([
    "",
    "A",
    "AA",
    "AAA",
    "A===",
    "====",
    "AA=A",
    "AB==",
    "AAB=",
    "_w==",
    "-w==",
    "AQID\n",
    "AQID\r\n",
    "AQ ID",
    "data:image/png;base64,AA==",
  ])("rejects malformed or noncanonical base64 %j", (base64) => {
    expect(Value.Check(AppendEvidenceChunkRequestSchema, { ...append, base64 })).toBe(false);
    expect(getEvidenceChunkDecodedBytes(base64)).toBeNull();
  });

  it("accepts a full chunk without recursive regex exhaustion", () => {
    const base64 = Buffer.alloc(maximumEvidenceChunkBytes).toString("base64");
    expect(base64).toHaveLength(maximumEvidenceChunkBase64Characters);
    expect(Value.Check(AppendEvidenceChunkRequestSchema, { ...append, base64 })).toBe(true);
    expect(getEvidenceChunkDecodedBytes(base64)).toBe(maximumEvidenceChunkBytes);
  });

  it("checks decoded bytes when base64 character ceilings cannot distinguish one extra byte", () => {
    const base64 = Buffer.alloc(maximumEvidenceChunkBytes + 1).toString("base64");
    expect(base64).toHaveLength(maximumEvidenceChunkBase64Characters);
    expect(getEvidenceChunkDecodedBytes(base64)).toBeNull();
  });

  it("rejects oversized or malformed chunks at the maximum boundary", () => {
    const oversized = Buffer.alloc(maximumEvidenceChunkBytes + 2).toString("base64");
    const malformed = `${"A".repeat(maximumEvidenceChunkBase64Characters - 1)}!`;
    for (const base64 of [oversized, malformed]) {
      expect(Value.Check(AppendEvidenceChunkRequestSchema, { ...append, base64 })).toBe(false);
      expect(getEvidenceChunkDecodedBytes(base64)).toBeNull();
    }
  });
});
