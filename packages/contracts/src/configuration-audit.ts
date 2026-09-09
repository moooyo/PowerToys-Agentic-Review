import { type Static, Type } from "@sinclair/typebox";
import {
  DateTimeSchema,
  EntityIdSchema,
  GitHubNumericIdSchema,
  PositiveIntegerSchema,
} from "./common.js";
import { OperatorPrincipalSchema } from "./operator-access.js";
import { SchedulingLimitsSchema, WorkflowKindSchema } from "./platform-configuration.js";
import { SelfOrAllowlistPolicySchema } from "./scheduling.js";

export const maximumConfigurationAuditPageSize = 20;
export const maximumConfigurationAuditResponseUtf8Bytes = 2 * 1024 * 1024;
export const maximumConfigurationAuditSnapshotUtf8Bytes = 2 * 1024 * 1024;
export const maximumPromptConfigurationAuditSnapshotUtf8Bytes = 16 * 1024;

// This exact pre-limits shape is historical evidence. Do not derive it from the evolving
// ManagedRepositorySchema or fill missing historical fields from current configuration.
export const RepositoryConfigurationSnapshotV1Schema = Type.Object(
  {
    id: EntityIdSchema,
    githubRepositoryId: GitHubNumericIdSchema,
    fullName: Type.String({
      minLength: 3,
      maxLength: 201,
      pattern:
        "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?/(?!\\.{1,2}$)[A-Za-z0-9._-]{1,100}(?![\\s\\S])",
    }),
    enabled: Type.Boolean(),
    version: PositiveIntegerSchema,
    reviewerGithubUserId: Type.Union([GitHubNumericIdSchema, Type.Null()]),
    reviewerGithubLogin: Type.Union([
      Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: "^(?=[\\s\\S]*\\S)[^\\u0000-\\u001F\\u007F]+(?![\\s\\S])",
      }),
      Type.Null(),
    ]),
    authorizationPolicy: Type.Union([SelfOrAllowlistPolicySchema, Type.Null()]),
    connectionStatus: Type.Union([
      Type.Literal("unknown"),
      Type.Literal("ready"),
      Type.Literal("error"),
    ]),
    connectionMessage: Type.Union([
      Type.String({ minLength: 1, maxLength: 2_048, pattern: "^[^\\u0000]*$" }),
      Type.Null(),
    ]),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type RepositoryConfigurationSnapshotV1 = Static<
  typeof RepositoryConfigurationSnapshotV1Schema
>;

export const RepositoryConfigurationSnapshotV2Schema = Type.Object(
  {
    ...RepositoryConfigurationSnapshotV1Schema.properties,
    schedulingLimits: SchedulingLimitsSchema,
  },
  { additionalProperties: false },
);
export type RepositoryConfigurationSnapshotV2 = Static<
  typeof RepositoryConfigurationSnapshotV2Schema
>;

// No discriminator is added to persisted snapshots: validation preserves the original bytes.
// Strict variants ensure malformed limit fields cannot fall through to the historical shape.
export const RepositoryConfigurationSnapshotSchema = Type.Union([
  RepositoryConfigurationSnapshotV1Schema,
  RepositoryConfigurationSnapshotV2Schema,
]);
export type RepositoryConfigurationSnapshot = Static<typeof RepositoryConfigurationSnapshotSchema>;

export const ConfigurationAuditSourceSchema = Type.Union([
  Type.Literal("repository"),
  Type.Literal("prompt"),
]);
export type ConfigurationAuditSource = Static<typeof ConfigurationAuditSourceSchema>;
const repositoryActions = Type.Union([
  Type.Literal("created"),
  Type.Literal("updated"),
  Type.Literal("bootstrapped"),
]);
const templateActions = Type.Union([
  Type.Literal("template_created"),
  Type.Literal("draft_saved"),
  Type.Literal("prompt_published"),
]);
const profileActions = Type.Union([
  Type.Literal("profile_published"),
  Type.Literal("profile_bound"),
]);
export const ConfigurationAuditActionSchema = Type.Union([
  repositoryActions,
  templateActions,
  profileActions,
  Type.Literal("prompt_bound"),
  Type.Literal("bootstrap_registered"),
]);
export type ConfigurationAuditAction = Static<typeof ConfigurationAuditActionSchema>;
const nullableId = Type.Union([EntityIdSchema, Type.Null()]);
const common = {
  id: EntityIdSchema,
  entityId: EntityIdSchema,
  actor: OperatorPrincipalSchema,
  createdAt: DateTimeSchema,
};
const repository = {
  ...common,
  source: Type.Literal("repository"),
  action: repositoryActions,
  repositoryId: EntityIdSchema,
  version: PositiveIntegerSchema,
};
const template = {
  ...common,
  source: Type.Literal("prompt"),
  action: templateActions,
  repositoryId: Type.Null(),
  version: PositiveIntegerSchema,
};
const profile = {
  ...common,
  source: Type.Literal("prompt"),
  action: profileActions,
  repositoryId: EntityIdSchema,
  version: PositiveIntegerSchema,
};
const binding = {
  ...common,
  source: Type.Literal("prompt"),
  action: Type.Literal("prompt_bound"),
  repositoryId: nullableId,
  version: PositiveIntegerSchema,
};
const bootstrap = {
  ...common,
  source: Type.Literal("prompt"),
  action: Type.Literal("bootstrap_registered"),
  repositoryId: Type.Null(),
  version: Type.Null(),
};

/** A list row reports the recorded operation and revision, without loading a repository snapshot. */
export const ConfigurationAuditSummarySchema = Type.Union([
  Type.Object(repository, { additionalProperties: false }),
  Type.Object(template, { additionalProperties: false }),
  Type.Object(profile, { additionalProperties: false }),
  Type.Object(binding, { additionalProperties: false }),
  Type.Object(bootstrap, { additionalProperties: false }),
]);
export type ConfigurationAuditSummary = Static<typeof ConfigurationAuditSummarySchema>;

export const PromptConfigurationAuditSnapshots = {
  template_created: Type.Object(
    { workflowKind: WorkflowKindSchema, version: Type.Literal(1) },
    { additionalProperties: false },
  ),
  draft_saved: Type.Object(
    { version: PositiveIntegerSchema, draftRevision: PositiveIntegerSchema },
    { additionalProperties: false },
  ),
  prompt_published: Type.Object(
    {
      promptVersionId: EntityIdSchema,
      publishedVersion: PositiveIntegerSchema,
      version: PositiveIntegerSchema,
    },
    { additionalProperties: false },
  ),
  prompt_bound: Type.Object(
    {
      workflowKind: WorkflowKindSchema,
      promptVersionId: EntityIdSchema,
      previousVersionId: nullableId,
      version: PositiveIntegerSchema,
    },
    { additionalProperties: false },
  ),
  profile_published: Type.Object(
    { profileVersionId: EntityIdSchema, version: PositiveIntegerSchema },
    { additionalProperties: false },
  ),
  profile_bound: Type.Object(
    {
      profileId: EntityIdSchema,
      profileVersionId: EntityIdSchema,
      previousVersionId: nullableId,
      enabled: Type.Boolean(),
      version: PositiveIntegerSchema,
    },
    { additionalProperties: false },
  ),
  bootstrap_registered: Type.Object(
    { promptVersionId: EntityIdSchema },
    { additionalProperties: false },
  ),
} as const;

/** Only data retained at the event is represented; current draft text is never a historical snapshot. */
export const ConfigurationAuditEventSchema = Type.Union([
  Type.Object(
    { ...repository, snapshot: RepositoryConfigurationSnapshotSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...template,
      action: Type.Literal("template_created"),
      snapshot: PromptConfigurationAuditSnapshots.template_created,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...template,
      action: Type.Literal("draft_saved"),
      snapshot: PromptConfigurationAuditSnapshots.draft_saved,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...template,
      action: Type.Literal("prompt_published"),
      snapshot: PromptConfigurationAuditSnapshots.prompt_published,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...binding, snapshot: PromptConfigurationAuditSnapshots.prompt_bound },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...profile,
      action: Type.Literal("profile_published"),
      snapshot: PromptConfigurationAuditSnapshots.profile_published,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...profile,
      action: Type.Literal("profile_bound"),
      snapshot: PromptConfigurationAuditSnapshots.profile_bound,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...bootstrap, snapshot: PromptConfigurationAuditSnapshots.bootstrap_registered },
    { additionalProperties: false },
  ),
]);
export type ConfigurationAuditEvent = Static<typeof ConfigurationAuditEventSchema>;

const pagination = {
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000_000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: maximumConfigurationAuditPageSize })),
};
export const RepositoryConfigurationAuditListQuerySchema = Type.Object(
  { repositoryId: EntityIdSchema, ...pagination },
  { additionalProperties: false },
);
export type RepositoryConfigurationAuditListQuery = Static<
  typeof RepositoryConfigurationAuditListQuerySchema
>;
export const GlobalConfigurationAuditListQuerySchema = Type.Object(
  { ...pagination, templateId: Type.Optional(EntityIdSchema) },
  { additionalProperties: false },
);
export type GlobalConfigurationAuditListQuery = Static<
  typeof GlobalConfigurationAuditListQuerySchema
>;
export const RepositoryConfigurationAuditReadQuerySchema = Type.Object(
  { repositoryId: EntityIdSchema, source: ConfigurationAuditSourceSchema, eventId: EntityIdSchema },
  { additionalProperties: false },
);
export type RepositoryConfigurationAuditReadQuery = Static<
  typeof RepositoryConfigurationAuditReadQuerySchema
>;
export const GlobalConfigurationAuditReadQuerySchema = Type.Object(
  { eventId: EntityIdSchema },
  { additionalProperties: false },
);
export type GlobalConfigurationAuditReadQuery = Static<
  typeof GlobalConfigurationAuditReadQuerySchema
>;

const pageProperties = {
  items: Type.Array(ConfigurationAuditSummarySchema, {
    maxItems: maximumConfigurationAuditPageSize,
  }),
  total: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  page: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
  pageSize: Type.Integer({ minimum: 1, maximum: maximumConfigurationAuditPageSize }),
};
export const RepositoryConfigurationAuditListResponseSchema = Type.Object(
  { repositoryId: EntityIdSchema, ...pageProperties },
  { additionalProperties: false },
);
export type RepositoryConfigurationAuditListResponse = Static<
  typeof RepositoryConfigurationAuditListResponseSchema
>;
export const GlobalConfigurationAuditListResponseSchema = Type.Object(
  { templateId: Type.Optional(EntityIdSchema), ...pageProperties },
  { additionalProperties: false },
);
export type GlobalConfigurationAuditListResponse = Static<
  typeof GlobalConfigurationAuditListResponseSchema
>;
