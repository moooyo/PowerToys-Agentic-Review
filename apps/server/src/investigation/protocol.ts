import {
  DateTimeSchema,
  EntityIdSchema,
  InvestigationBudgetSchema,
  InvestigationGitHubUserSchema,
  InvestigationSubjectV1Schema,
} from "@agentic-review/contracts";
import { type Static, Type } from "@sinclair/typebox";

export const InvestigationRepositoryRecordSchema = Type.Object(
  {
    id: EntityIdSchema,
    githubRepositoryId: Type.Integer({ minimum: 1 }),
    fullName: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
  },
  { additionalProperties: false },
);

export const InvestigationWorkItemRecordSchema = Type.Object(
  {
    id: EntityIdSchema,
    repositoryId: EntityIdSchema,
    kind: Type.Union([Type.Literal("pull_request"), Type.Literal("issue")]),
    number: Type.Integer({ minimum: 1 }),
    title: Type.String({ minLength: 1 }),
    author: Type.Optional(InvestigationGitHubUserSchema),
    body: Type.String(),
    state: Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("merged")]),
    subject: InvestigationSubjectV1Schema,
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);

export const InvestigationResumeTaskRequestSchema = Type.Object(
  {
    idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
    budget: Type.Optional(InvestigationBudgetSchema),
  },
  { additionalProperties: false },
);
export type InvestigationResumeTaskRequest = Static<typeof InvestigationResumeTaskRequestSchema>;

export interface InvestigationDirectoryQuery {
  repositoryId?: string;
  kind?: string;
  workItemId?: string;
}
export interface InvestigationFindingsQuery {
  cursor?: string;
  limit?: number | string;
}
export interface InvestigationActionContextQuery {
  reportId?: string;
}
