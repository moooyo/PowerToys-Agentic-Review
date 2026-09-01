import { type Static, Type } from "@sinclair/typebox";

import { EntityIdSchema, Sha256Schema } from "./common.js";
import { LeaseIdentitySchema } from "./worker.js";

export const maximumResultArtifactBytes = 2 * 1024 * 1024;
export const maximumResultArtifactChunkBytes = 256 * 1024;
export const maximumResultArtifactChunks = 8;

const uuidV4Pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const artifactNamePattern = "^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$";
const canonicalBase64UrlPattern = "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$";
const canonicalBase64Url = new RegExp(canonicalBase64UrlPattern, "u");
const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const isCanonicalResultArtifactChunkData = (value: string): boolean => {
  if (
    value.length < 2 ||
    value.length > Math.ceil((maximumResultArtifactChunkBytes * 4) / 3) ||
    !canonicalBase64Url.test(value)
  ) {
    return false;
  }
  const remainder = value.length % 4;
  const finalSextet = base64UrlAlphabet.indexOf(value.at(-1) ?? "");
  return (
    finalSextet >= 0 &&
    (remainder === 0 ||
      (remainder === 2 && (finalSextet & 0x0f) === 0) ||
      (remainder === 3 && (finalSextet & 0x03) === 0))
  );
};

export const ClientArtifactIdSchema = Type.String({
  minLength: 36,
  maxLength: 36,
  pattern: uuidV4Pattern,
});
export type ClientArtifactId = Static<typeof ClientArtifactIdSchema>;

export const ResultArtifactPurposeSchema = Type.Literal("result");
export type ResultArtifactPurpose = Static<typeof ResultArtifactPurposeSchema>;

export const ResultArtifactUploadStateSchema = Type.Union([
  Type.Literal("receiving"),
  Type.Literal("finalizing"),
  Type.Literal("committed"),
  Type.Literal("abandoned"),
  Type.Literal("corrupt"),
]);
export type ResultArtifactUploadState = Static<typeof ResultArtifactUploadStateSchema>;

const ResultArtifactIdentitySchema = Type.Object(
  {
    clientArtifactId: ClientArtifactIdSchema,
    purpose: ResultArtifactPurposeSchema,
    name: Type.String({ minLength: 1, maxLength: 128, pattern: artifactNamePattern }),
    mediaType: Type.Literal("application/json"),
    totalBytes: Type.Integer({ minimum: 1, maximum: maximumResultArtifactBytes }),
    sha256: Sha256Schema,
  },
  { additionalProperties: false },
);

export const CreateResultArtifactUploadRequestSchema = Type.Composite(
  [LeaseIdentitySchema, ResultArtifactIdentitySchema],
  { additionalProperties: false },
);
export type CreateResultArtifactUploadRequest = Static<
  typeof CreateResultArtifactUploadRequestSchema
>;

export const CreateResultArtifactUploadResponseSchema = Type.Object(
  {
    uploadId: EntityIdSchema,
    state: ResultArtifactUploadStateSchema,
    replayed: Type.Boolean(),
    nextChunkIndex: Type.Integer({ minimum: 0, maximum: maximumResultArtifactChunks }),
    nextOffsetBytes: Type.Integer({ minimum: 0, maximum: maximumResultArtifactBytes }),
    maximumChunkBytes: Type.Literal(maximumResultArtifactChunkBytes),
    maximumChunkCount: Type.Literal(maximumResultArtifactChunks),
  },
  { additionalProperties: false },
);
export type CreateResultArtifactUploadResponse = Static<
  typeof CreateResultArtifactUploadResponseSchema
>;

export const ResultArtifactChunkRequestSchema = Type.Composite(
  [
    LeaseIdentitySchema,
    Type.Object(
      {
        chunkIndex: Type.Integer({ minimum: 0, maximum: maximumResultArtifactChunks - 1 }),
        offsetBytes: Type.Integer({ minimum: 0, maximum: maximumResultArtifactBytes - 1 }),
        chunkBytes: Type.Integer({ minimum: 1, maximum: maximumResultArtifactChunkBytes }),
        chunkSha256: Sha256Schema,
        data: Type.String({
          minLength: 2,
          maxLength: Math.ceil((maximumResultArtifactChunkBytes * 4) / 3),
          pattern: canonicalBase64UrlPattern,
        }),
      },
      { additionalProperties: false },
    ),
  ],
  { additionalProperties: false },
);
export type ResultArtifactChunkRequest = Static<typeof ResultArtifactChunkRequestSchema>;

export const ResultArtifactChunkResponseSchema = Type.Object(
  {
    uploadId: EntityIdSchema,
    state: Type.Literal("receiving"),
    chunkIndex: Type.Integer({ minimum: 0, maximum: maximumResultArtifactChunks - 1 }),
    outcome: Type.Union([Type.Literal("accepted"), Type.Literal("replayed")]),
    nextChunkIndex: Type.Integer({ minimum: 1, maximum: maximumResultArtifactChunks }),
    nextOffsetBytes: Type.Integer({ minimum: 1, maximum: maximumResultArtifactBytes }),
  },
  { additionalProperties: false },
);
export type ResultArtifactChunkResponse = Static<typeof ResultArtifactChunkResponseSchema>;

export const FinalizeResultArtifactUploadRequestSchema = Type.Composite(
  [
    LeaseIdentitySchema,
    Type.Object(
      {
        chunkCount: Type.Integer({ minimum: 1, maximum: maximumResultArtifactChunks }),
        totalBytes: Type.Integer({ minimum: 1, maximum: maximumResultArtifactBytes }),
        sha256: Sha256Schema,
      },
      { additionalProperties: false },
    ),
  ],
  { additionalProperties: false },
);
export type FinalizeResultArtifactUploadRequest = Static<
  typeof FinalizeResultArtifactUploadRequestSchema
>;

export const CommittedRunArtifactSchema = Type.Object(
  {
    artifactId: EntityIdSchema,
    uploadId: EntityIdSchema,
    clientArtifactId: ClientArtifactIdSchema,
    jobId: EntityIdSchema,
    runAttemptId: EntityIdSchema,
    purpose: ResultArtifactPurposeSchema,
    name: Type.String({ minLength: 1, maxLength: 128, pattern: artifactNamePattern }),
    mediaType: Type.Literal("application/json"),
    totalBytes: Type.Integer({ minimum: 1, maximum: maximumResultArtifactBytes }),
    sha256: Sha256Schema,
  },
  { additionalProperties: false },
);
export type CommittedRunArtifact = Static<typeof CommittedRunArtifactSchema>;

export const FinalizeResultArtifactUploadResponseSchema = Type.Object(
  {
    state: Type.Literal("committed"),
    replayed: Type.Boolean(),
    artifact: CommittedRunArtifactSchema,
  },
  { additionalProperties: false },
);
export type FinalizeResultArtifactUploadResponse = Static<
  typeof FinalizeResultArtifactUploadResponseSchema
>;
