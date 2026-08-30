import { type Static, Type } from "@sinclair/typebox";

import {
  DateTimeSchema,
  GitHubNumericIdSchema,
  GitHubRepositoryNameSchema,
  GitObjectIdSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";

export const GitHubAccountTypeValues = ["user", "bot", "app"] as const;
export const GitHubAccountTypeSchema = Type.Union(
  GitHubAccountTypeValues.map((value) => Type.Literal(value)),
);
export type GitHubAccountType = Static<typeof GitHubAccountTypeSchema>;

/**
 * A GitHub account snapshot. Authorization must use githubUserId; login is display-only.
 * The legacy field name is retained because GitHub represents users and bots through user IDs.
 */
export const GitHubActorSchema = Type.Object(
  {
    githubUserId: GitHubNumericIdSchema,
    login: Type.String({ minLength: 1, maxLength: 128 }),
    accountType: Type.Optional(GitHubAccountTypeSchema),
    githubNodeId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    avatarUrl: Type.Optional(Type.String({ format: "uri", maxLength: 2_048 })),
  },
  { additionalProperties: false },
);
export type GitHubActor = Static<typeof GitHubActorSchema>;

export const GitHubRepositorySchema = Type.Object(
  {
    githubRepositoryId: GitHubNumericIdSchema,
    githubNodeId: Type.String({ minLength: 1, maxLength: 256 }),
    ownerLogin: Type.String({ minLength: 1, maxLength: 128 }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    fullName: GitHubRepositoryNameSchema,
    htmlUrl: Type.String({ format: "uri", maxLength: 2_048 }),
    defaultBranch: Type.String({ minLength: 1, maxLength: 255 }),
    isPrivate: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type GitHubRepository = Static<typeof GitHubRepositorySchema>;

export const GitHubWorkItemKindValues = ["issue", "pull_request"] as const;
export const GitHubWorkItemKindSchema = Type.Union(
  GitHubWorkItemKindValues.map((value) => Type.Literal(value)),
);
export type GitHubWorkItemKind = Static<typeof GitHubWorkItemKindSchema>;

export const GitHubWorkItemOpenStateSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("closed"),
]);
export type GitHubWorkItemOpenState = Static<typeof GitHubWorkItemOpenStateSchema>;

const GitHubWorkItemBaseProperties = {
  githubWorkItemId: GitHubNumericIdSchema,
  githubNodeId: Type.String({ minLength: 1, maxLength: 256 }),
  githubRepositoryId: GitHubNumericIdSchema,
  number: PositiveIntegerSchema,
  title: Type.String({ minLength: 1, maxLength: 1_024 }),
  body: Type.Union([Type.String({ maxLength: 1_048_576 }), Type.Null()]),
  state: GitHubWorkItemOpenStateSchema,
  author: GitHubActorSchema,
  htmlUrl: Type.String({ format: "uri", maxLength: 2_048 }),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
  closedAt: Type.Union([DateTimeSchema, Type.Null()]),
};

export const GitHubIssueSchema = Type.Object(
  {
    ...GitHubWorkItemBaseProperties,
    kind: Type.Literal("issue"),
  },
  { additionalProperties: false },
);
export type GitHubIssue = Static<typeof GitHubIssueSchema>;

export const GitHubPullRequestSchema = Type.Object(
  {
    ...GitHubWorkItemBaseProperties,
    kind: Type.Literal("pull_request"),
    isDraft: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type GitHubPullRequest = Static<typeof GitHubPullRequestSchema>;

export const GitHubWorkItemSchema = Type.Union([GitHubIssueSchema, GitHubPullRequestSchema]);
export type GitHubWorkItem = Static<typeof GitHubWorkItemSchema>;

const GitHubRevisionBaseProperties = {
  githubRepositoryId: GitHubNumericIdSchema,
  githubWorkItemId: GitHubNumericIdSchema,
  observedAt: DateTimeSchema,
  sourceUpdatedAt: DateTimeSchema,
};

export const GitHubIssueRevisionSchema = Type.Object(
  {
    ...GitHubRevisionBaseProperties,
    kind: Type.Literal("issue"),
    revisionKey: Sha256Schema,
    contentDigest: Sha256Schema,
  },
  { additionalProperties: false },
);
export type GitHubIssueRevision = Static<typeof GitHubIssueRevisionSchema>;

export const GitHubPullRequestRevisionSchema = Type.Object(
  {
    ...GitHubRevisionBaseProperties,
    kind: Type.Literal("pull_request"),
    revisionKey: Sha256Schema,
    baseSha: GitObjectIdSchema,
    headSha: GitObjectIdSchema,
  },
  { additionalProperties: false },
);
export type GitHubPullRequestRevision = Static<typeof GitHubPullRequestRevisionSchema>;

export const GitHubWorkItemRevisionSchema = Type.Union([
  GitHubIssueRevisionSchema,
  GitHubPullRequestRevisionSchema,
]);
export type GitHubWorkItemRevision = Static<typeof GitHubWorkItemRevisionSchema>;
