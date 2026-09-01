import { type Static, Type } from "@sinclair/typebox";

import { DateTimeSchema, EntityIdSchema, Sha256Schema } from "./common.js";
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

const createResultArtifactUploadResponseProperties = {
  uploadId: EntityIdSchema,
  maximumChunkBytes: Type.Literal(maximumResultArtifactChunkBytes),
  maximumChunkCount: Type.Literal(maximumResultArtifactChunks),
};

const replayedResultArtifactUploadCursorProperties = {
  ...createResultArtifactUploadResponseProperties,
  nextChunkIndex: Type.Integer({ minimum: 0, maximum: maximumResultArtifactChunks }),
  nextOffsetBytes: Type.Integer({ minimum: 0, maximum: maximumResultArtifactBytes }),
};

export const CreateResultArtifactUploadResponseSchema = Type.Union([
  Type.Object(
    {
      ...createResultArtifactUploadResponseProperties,
      state: Type.Literal("receiving"),
      replayed: Type.Literal(false),
      nextChunkIndex: Type.Literal(0),
      nextOffsetBytes: Type.Literal(0),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...replayedResultArtifactUploadCursorProperties,
      state: Type.Union([
        Type.Literal("receiving"),
        Type.Literal("finalizing"),
        Type.Literal("committed"),
      ]),
      replayed: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...replayedResultArtifactUploadCursorProperties,
      state: Type.Union([Type.Literal("abandoned"), Type.Literal("corrupt")]),
      replayed: Type.Literal(true),
      reason: Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: "^[a-z][a-z0-9_]{0,127}$",
      }),
      terminatedAt: DateTimeSchema,
    },
    { additionalProperties: false },
  ),
]);
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

const resultArtifactChunkResponseProperties = {
  uploadId: EntityIdSchema,
  chunkIndex: Type.Integer({ minimum: 0, maximum: maximumResultArtifactChunks - 1 }),
  nextChunkIndex: Type.Integer({ minimum: 1, maximum: maximumResultArtifactChunks }),
  nextOffsetBytes: Type.Integer({ minimum: 1, maximum: maximumResultArtifactBytes }),
};

export const ResultArtifactChunkResponseSchema = Type.Union([
  Type.Object(
    {
      ...resultArtifactChunkResponseProperties,
      state: Type.Literal("receiving"),
      outcome: Type.Literal("accepted"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...resultArtifactChunkResponseProperties,
      state: Type.Union([
        Type.Literal("receiving"),
        Type.Literal("finalizing"),
        Type.Literal("committed"),
      ]),
      outcome: Type.Literal("replayed"),
    },
    { additionalProperties: false },
  ),
]);
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

export const TerminateResultArtifactUploadRequestSchema = Type.Composite(
  [
    LeaseIdentitySchema,
    Type.Object(
      {
        state: Type.Literal("abandoned"),
        reason: Type.Literal("client_abandoned"),
      },
      { additionalProperties: false },
    ),
  ],
  { additionalProperties: false },
);
export type TerminateResultArtifactUploadRequest = Static<
  typeof TerminateResultArtifactUploadRequestSchema
>;

export const TerminateResultArtifactUploadResponseSchema = Type.Object(
  {
    uploadId: EntityIdSchema,
    state: Type.Literal("abandoned"),
    reason: Type.Literal("client_abandoned"),
    terminatedAt: DateTimeSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type TerminateResultArtifactUploadResponse = Static<
  typeof TerminateResultArtifactUploadResponseSchema
>;
