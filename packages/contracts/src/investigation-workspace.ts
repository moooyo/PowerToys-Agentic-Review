import { type Static, Type } from "@sinclair/typebox";
import { DateTimeSchema, EntityIdSchema, Sha256Schema } from "./common.js";
import {
  InvestigationBudgetSchema,
  InvestigationReportHeaderV1Schema,
  InvestigationTaskKindSchema,
} from "./investigation.js";
import { InvestigationArtifactMetadataV1Schema } from "./investigation-artifact-metadata.js";
import {
  InvestigationCommentDeliveryModeSchema,
  InvestigationCommentPublicationStateSchema,
  InvestigationCommentPublicationSummarySchema,
} from "./investigation-comments.js";
import { InvestigationInputSnapshotV1Schema } from "./investigation-execution.js";

const cursor = Type.String({ minLength: 1, maxLength: 2_048 });
const paging = {
  cursor: Type.Optional(cursor),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
};
const scope = {
  repositoryId: Type.Optional(EntityIdSchema),
  workItemId: Type.Optional(EntityIdSchema),
  taskId: Type.Optional(EntityIdSchema),
};
const nextCursor = Type.Union([cursor, Type.Null()]);
export const InvestigationTaskDefaultsSchema = Type.Object(
  { budget: InvestigationBudgetSchema },
  { additionalProperties: false },
);
export type InvestigationTaskDefaults = Static<typeof InvestigationTaskDefaultsSchema>;
export const InvestigationTaskArtifactsQuerySchema = Type.Object(
  { ...paging, attemptId: Type.Optional(EntityIdSchema) },
  { additionalProperties: false },
);
export type InvestigationTaskArtifactsQuery = Static<typeof InvestigationTaskArtifactsQuerySchema>;
export const InvestigationTaskArtifactsPageSchema = Type.Object(
  {
    taskId: EntityIdSchema,
    items: Type.Array(InvestigationArtifactMetadataV1Schema, { maxItems: 50 }),
    nextCursor,
  },
  { additionalProperties: false },
);
export type InvestigationTaskArtifactsPage = Static<typeof InvestigationTaskArtifactsPageSchema>;

export const InvestigationReportDirectoryQuerySchema = Type.Object(
  {
    ...paging,
    ...scope,
    kind: Type.Optional(InvestigationTaskKindSchema),
    search: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    delivery: Type.Optional(
      InvestigationReportHeaderV1Schema.properties.report.properties.delivery,
    ),
    completeness: Type.Optional(
      InvestigationReportHeaderV1Schema.properties.report.properties.completeness,
    ),
  },
  { additionalProperties: false },
);
export type InvestigationReportDirectoryQuery = Static<
  typeof InvestigationReportDirectoryQuerySchema
>;
export const InvestigationReportDirectoryPageSchema = Type.Object(
  { items: Type.Array(InvestigationReportHeaderV1Schema, { maxItems: 50 }), nextCursor },
  { additionalProperties: false },
);
export type InvestigationReportDirectoryPage = Static<
  typeof InvestigationReportDirectoryPageSchema
>;

export const InvestigationPublicationDirectoryQuerySchema = Type.Object(
  {
    ...paging,
    ...scope,
    mode: Type.Optional(InvestigationCommentDeliveryModeSchema),
    state: Type.Optional(InvestigationCommentPublicationStateSchema),
    taskKind: Type.Optional(InvestigationTaskKindSchema),
    search: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    workItemNumber: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  },
  { additionalProperties: false },
);
export type InvestigationPublicationDirectoryQuery = Static<
  typeof InvestigationPublicationDirectoryQuerySchema
>;
export const InvestigationPublicationDirectoryPageSchema = Type.Object(
  { items: Type.Array(InvestigationCommentPublicationSummarySchema, { maxItems: 50 }), nextCursor },
  { additionalProperties: false },
);
export type InvestigationPublicationDirectoryPage = Static<
  typeof InvestigationPublicationDirectoryPageSchema
>;

export const InvestigationWorkItemDiscussionQuerySchema = Type.Object(
  { revisionKey: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })) },
  { additionalProperties: false },
);
export type InvestigationWorkItemDiscussionQuery = Static<
  typeof InvestigationWorkItemDiscussionQuerySchema
>;
export const InvestigationWorkItemDiscussionSchema = Type.Object(
  {
    workItemId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    revisionKey: Type.String({ minLength: 1, maxLength: 1_024 }),
    availability: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
    snapshotRef: Type.Union([
      Type.Object({ id: EntityIdSchema, digest: Sha256Schema }, { additionalProperties: false }),
      Type.Null(),
    ]),
    inputSnapshot: Type.Union([InvestigationInputSnapshotV1Schema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type InvestigationWorkItemDiscussion = Static<typeof InvestigationWorkItemDiscussionSchema>;

export const InvestigationWorkspaceSearchQuerySchema = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 200 }),
    repositoryId: Type.Optional(EntityIdSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
  },
  { additionalProperties: false },
);
export type InvestigationWorkspaceSearchQuery = Static<
  typeof InvestigationWorkspaceSearchQuerySchema
>;
export const InvestigationWorkspaceSearchResultSchema = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          id: EntityIdSchema,
          kind: Type.Union([
            Type.Literal("repository"),
            Type.Literal("work_item"),
            Type.Literal("task"),
            Type.Literal("report"),
          ]),
          repositoryId: EntityIdSchema,
          title: Type.String(),
          description: Type.String(),
          workItemId: Type.Union([EntityIdSchema, Type.Null()]),
          workItemKind: Type.Union([
            Type.Literal("pull_request"),
            Type.Literal("issue"),
            Type.Null(),
          ]),
          taskId: Type.Union([EntityIdSchema, Type.Null()]),
          updatedAt: Type.Union([DateTimeSchema, Type.Null()]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 30 },
    ),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type InvestigationWorkspaceSearchResult = Static<
  typeof InvestigationWorkspaceSearchResultSchema
>;

export const InvestigationMediaPublicationSchema = Type.Object(
  {
    reportId: EntityIdSchema,
    state: Type.Union([
      Type.Literal("ready"),
      Type.Literal("pending"),
      Type.Literal("blocked"),
      Type.Literal("unknown"),
    ]),
    retryable: Type.Boolean(),
    uploadedCount: Type.Integer({ minimum: 0 }),
    totalCount: Type.Integer({ minimum: 0 }),
    blockers: Type.Array(Type.String()),
    uploads: Type.Array(
      Type.Object(
        {
          artifactId: EntityIdSchema,
          name: Type.String(),
          mediaType: Type.String(),
          digest: Sha256Schema,
          state: Type.Union([
            Type.Literal("prepared"),
            Type.Literal("uploading"),
            Type.Literal("uploaded"),
            Type.Literal("blocked"),
            Type.Literal("rejected"),
            Type.Literal("unknown"),
          ]),
          url: Type.Union([Type.String(), Type.Null()]),
          reason: Type.Union([Type.String(), Type.Null()]),
          featureIds: Type.Array(EntityIdSchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type InvestigationMediaPublication = Static<typeof InvestigationMediaPublicationSchema>;
