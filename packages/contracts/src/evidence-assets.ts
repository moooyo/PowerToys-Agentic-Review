import { type Static, Type } from "@sinclair/typebox";

import { DateTimeSchema, EntityIdSchema, Sha256Schema } from "./common.js";
import { QualifiedValidationCheckIdSchema } from "./validation-report.js";
import { LeaseIdentitySchema } from "./worker.js";

export const maximumEvidenceChunkBytes = 512 * 1024;
export const maximumEvidenceAssetBytes = 64 * 1024 * 1024;
export const maximumScreenshotBytes = 16 * 1024 * 1024;
export const maximumAttemptEvidenceBytes = 128 * 1024 * 1024;
export const maximumAttemptEvidenceAssets = 256;
export const maximumEvidenceChunkBase64Characters = Math.ceil(maximumEvidenceChunkBytes / 3) * 4;

export const EvidenceAssetKindSchema = Type.Union([
  Type.Literal("screenshot"),
  Type.Literal("trace"),
  Type.Literal("steps"),
  Type.Literal("log"),
]);
export type EvidenceAssetKind = Static<typeof EvidenceAssetKindSchema>;

export const EvidenceMediaTypeSchema = Type.Union([
  Type.Literal("image/png"),
  Type.Literal("application/json"),
  Type.Literal("text/plain"),
  Type.Literal("application/zip"),
]);
export type EvidenceMediaType = Static<typeof EvidenceMediaTypeSchema>;

const EvidenceMetadataProperties = {
  sizeBytes: Type.Integer({ minimum: 1, maximum: maximumEvidenceAssetBytes }),
  sha256: Sha256Schema,
  capturedAt: DateTimeSchema,
  checkId: Type.Optional(QualifiedValidationCheckIdSchema),
};

// The Worker supplies content facts only. The Server derives ownership and storage locations.
export const EvidenceAssetMetadataSchema = Type.Union([
  Type.Object(
    {
      ...EvidenceMetadataProperties,
      kind: Type.Literal("screenshot"),
      mediaType: Type.Literal("image/png"),
      sizeBytes: Type.Integer({ minimum: 1, maximum: maximumScreenshotBytes }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...EvidenceMetadataProperties,
      kind: Type.Literal("trace"),
      mediaType: Type.Union([Type.Literal("application/zip"), Type.Literal("application/json")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...EvidenceMetadataProperties,
      kind: Type.Literal("steps"),
      mediaType: Type.Literal("application/json"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...EvidenceMetadataProperties,
      kind: Type.Literal("log"),
      mediaType: Type.Literal("text/plain"),
    },
    { additionalProperties: false },
  ),
]);
export type EvidenceAssetMetadata = Static<typeof EvidenceAssetMetadataSchema>;

export const BeginEvidenceUploadRequestSchema = Type.Object(
  {
    lease: LeaseIdentitySchema,
    clientAssetId: EntityIdSchema,
    metadata: EvidenceAssetMetadataSchema,
  },
  { additionalProperties: false },
);
export type BeginEvidenceUploadRequest = Static<typeof BeginEvidenceUploadRequestSchema>;

// Batching complete quartets bounds regex stack usage at the maximum chunk size. The final
// alphabet subsets require unused padding bits to be zero, making the encoding canonical.
const canonicalEvidenceBase64Pattern =
  "^(?:[A-Za-z0-9+/]{1024})*(?:[A-Za-z0-9+/]{4}){0,255}(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?(?![\\s\\S])";
const canonicalEvidenceBase64 = new RegExp(canonicalEvidenceBase64Pattern);

export const AppendEvidenceChunkRequestSchema = Type.Object(
  {
    lease: LeaseIdentitySchema,
    assetId: EntityIdSchema,
    offset: Type.Integer({ minimum: 0, maximum: maximumEvidenceAssetBytes }),
    base64: Type.String({
      minLength: 4,
      maxLength: maximumEvidenceChunkBase64Characters,
      pattern: canonicalEvidenceBase64Pattern,
    }),
    chunkSha256: Sha256Schema,
  },
  { additionalProperties: false },
);
export type AppendEvidenceChunkRequest = Static<typeof AppendEvidenceChunkRequestSchema>;

// A base64 character ceiling alone permits one excess decoded byte for this chunk limit.
// Call this before decoding or allocating content; no Node-specific APIs are required.
export function getEvidenceChunkDecodedBytes(base64: string): number | null {
  if (
    base64.length < 4 ||
    base64.length > maximumEvidenceChunkBase64Characters ||
    base64.length % 4 !== 0 ||
    !canonicalEvidenceBase64.test(base64)
  ) {
    return null;
  }
  const paddingBytes = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const decodedBytes = (base64.length / 4) * 3 - paddingBytes;
  return decodedBytes <= maximumEvidenceChunkBytes ? decodedBytes : null;
}

export const FinalizeEvidenceUploadRequestSchema = Type.Object(
  {
    lease: LeaseIdentitySchema,
    assetId: EntityIdSchema,
  },
  { additionalProperties: false },
);
export type FinalizeEvidenceUploadRequest = Static<typeof FinalizeEvidenceUploadRequestSchema>;

export const EvidenceUploadResponseSchema = Type.Object(
  {
    assetId: EntityIdSchema,
    offset: Type.Integer({ minimum: 0, maximum: maximumEvidenceAssetBytes }),
    state: Type.Union([Type.Literal("uploading"), Type.Literal("finalized")]),
  },
  { additionalProperties: false },
);
export type EvidenceUploadResponse = Static<typeof EvidenceUploadResponseSchema>;

export const BeginEvidenceUploadResponseSchema = EvidenceUploadResponseSchema;
export type BeginEvidenceUploadResponse = EvidenceUploadResponse;
export const AppendEvidenceChunkResponseSchema = EvidenceUploadResponseSchema;
export type AppendEvidenceChunkResponse = EvidenceUploadResponse;

export const EvidenceAssetManifestSchema = Type.Object(
  {
    id: EntityIdSchema,
    repositoryId: EntityIdSchema,
    runId: EntityIdSchema,
    jobId: EntityIdSchema,
    runAttemptId: EntityIdSchema,
    requestId: EntityIdSchema,
    profileVersionId: EntityIdSchema,
    revisionKey: Sha256Schema,
    planDigest: Sha256Schema,
    metadata: EvidenceAssetMetadataSchema,
    state: Type.Union([Type.Literal("finalized"), Type.Literal("retired")]),
    createdAt: DateTimeSchema,
    finalizedAt: DateTimeSchema,
    retiredAt: Type.Union([DateTimeSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type EvidenceAssetManifest = Static<typeof EvidenceAssetManifestSchema>;
