import { type Static, type TProperties, Type } from "@sinclair/typebox";
import {
  DateTimeSchema,
  EntityIdSchema,
  GitHubRepositoryNameSchema,
  GitObjectIdSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";
import { InvestigationReportRefSchema } from "./investigation.js";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const nullableText = Type.Union([Type.String(), Type.Null()]);
const nullableLine = Type.Union([PositiveIntegerSchema, Type.Null()]);

/** An upstream observation is separate from the retained publication confirmation. */
export const InvestigationCurrentCommentSchema = object({
  commentId: EntityIdSchema,
  repositoryId: EntityIdSchema,
  repositoryFullName: GitHubRepositoryNameSchema,
  workItemId: Type.Union([EntityIdSchema, Type.Null()]),
  workItemNumber: PositiveIntegerSchema,
  externalId: nullableText,
  checkedAt: DateTimeSchema,
  state: Type.Union([
    Type.Literal("present"),
    Type.Literal("edited"),
    Type.Literal("deleted"),
    Type.Literal("not_published"),
    Type.Literal("unavailable"),
  ]),
  comparison: Type.Union([
    Type.Literal("matches_confirmation"),
    Type.Literal("differs_from_confirmation"),
    Type.Literal("unknown"),
  ]),
  reasonCode: nullableText,
  body: Type.Union([Type.String({ maxLength: 120_000 }), Type.Null()]),
  commentUrl: nullableText,
  upstreamUpdatedAt: Type.Union([DateTimeSchema, Type.Null()]),
  lastConfirmedAt: Type.Union([DateTimeSchema, Type.Null()]),
  lastConfirmedBody: Type.Union([Type.String({ maxLength: 120_000 }), Type.Null()]),
});
export type InvestigationCurrentComment = Static<typeof InvestigationCurrentCommentSchema>;

/** All source coordinates originate from the selected immutable report and finding. */
export const InvestigationFindingSourceSchema = object({
  reportRef: InvestigationReportRefSchema,
  findingId: EntityIdSchema,
  findingVersion: PositiveIntegerSchema,
  locationIndex: Type.Integer({ minimum: 0 }),
  repositoryId: EntityIdSchema,
  repositoryFullName: GitHubRepositoryNameSchema,
  workItemId: EntityIdSchema,
  subjectRef: Type.Union([EntityIdSchema, Type.Null()]),
  revisionKey: Type.Union([Sha256Schema, Type.Null()]),
  commitSha: Type.Union([GitObjectIdSchema, Type.Null()]),
  blobSha: Type.Union([GitObjectIdSchema, Type.Null()]),
  contentDigest: Type.Union([Sha256Schema, Type.Null()]),
  path: nullableText,
  startLine: nullableLine,
  endLine: nullableLine,
  sourceRepositoryFullName: Type.Union([GitHubRepositoryNameSchema, Type.Null()]),
  sourcePath: nullableText,
  availability: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
  reasonCode: nullableText,
  sourceUrl: nullableText,
  checkedAt: DateTimeSchema,
  contextStartLine: nullableLine,
  contextEndLine: nullableLine,
  truncated: Type.Boolean(),
  lines: Type.Array(
    object({ number: PositiveIntegerSchema, text: Type.String(), inFinding: Type.Boolean() }),
    { maxItems: 200 },
  ),
});
export type InvestigationFindingSource = Static<typeof InvestigationFindingSourceSchema>;
