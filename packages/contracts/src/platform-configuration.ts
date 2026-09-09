import { type Static, Type } from "@sinclair/typebox";

import {
  DateTimeSchema,
  EntityIdSchema,
  GitHubNumericIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";
import { TestProbeOutputDeclarationV1Schema } from "./issue-reproduction.js";
import { SelfOrAllowlistPolicySchema } from "./scheduling.js";
import { getUiScenarioConfigurationIssues, UiScenarioConfigurationSchema } from "./ui-scenarios.js";

export const WorkflowKindValues = [
  "pr_static_build",
  "pr_ui",
  "issue_triage",
  "issue_validation",
] as const;
export const WorkflowKindSchema = Type.Union(
  WorkflowKindValues.map((value) => Type.Literal(value)),
);
export type WorkflowKind = Static<typeof WorkflowKindSchema>;

export const ValidationTargetValues = ["headless", "windows_desktop", "web"] as const;
export const ValidationTargetSchema = Type.Union(
  ValidationTargetValues.map((value) => Type.Literal(value)),
);
export type ValidationTarget = Static<typeof ValidationTargetSchema>;

export const SupportedOutputSchemaVersionValues = [
  "PrReviewPlanV2",
  "IssueTriageV2",
  "ValidationSummaryV1",
  "ValidationReportV1",
] as const;
export const SupportedOutputSchemaVersionSchema = Type.Union(
  SupportedOutputSchemaVersionValues.map((value) => Type.Literal(value)),
);
export type SupportedOutputSchemaVersion = Static<typeof SupportedOutputSchemaVersionSchema>;

export const PromptOutputSchemaVersionValues = [
  "PrReviewPlanV2",
  "IssueTriageV2",
  "ValidationSummaryV1",
] as const;
export const PromptOutputSchemaVersionSchema = Type.Union(
  PromptOutputSchemaVersionValues.map((value) => Type.Literal(value)),
);
export type PromptOutputSchemaVersion = Static<typeof PromptOutputSchemaVersionSchema>;

// Schema definitions remain deployed code. Prompt authors select a supported version only.
export const WorkflowOutputSchemaVersions = {
  pr_static_build: "PrReviewPlanV2",
  pr_ui: "ValidationSummaryV1",
  issue_triage: "IssueTriageV2",
  issue_validation: "ValidationSummaryV1",
} as const satisfies Record<WorkflowKind, PromptOutputSchemaVersion>;

export const RepositoryConnectionStatusSchema = Type.Union([
  Type.Literal("unknown"),
  Type.Literal("ready"),
  Type.Literal("error"),
]);
export type RepositoryConnectionStatus = Static<typeof RepositoryConnectionStatusSchema>;

export const ManagedRepositoryNameSchema = Type.String({
  minLength: 3,
  maxLength: 201,
  pattern:
    "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?/(?!\\.{1,2}$)[A-Za-z0-9._-]{1,100}(?![\\s\\S])",
});

const ConfigurationNameSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^(?=[\\s\\S]*\\S)[^\\u0000-\\u001F\\u007F]+(?![\\s\\S])",
});
const ConfigurationDescriptionSchema = Type.String({ maxLength: 2_048, pattern: "^[^\\u0000]*$" });
// Operator identities allow a 2,048-character issuer and a 512-character subject. Preserve both
// without truncation, including the worst-case expansion of their canonical JSON string encoding.
export const maximumConfigurationActorLength = 16_384;
const ConfigurationActorSchema = Type.String({
  minLength: 1,
  maxLength: maximumConfigurationActorLength,
  pattern: "^[^\\u0000-\\u001F\\u007F]+(?![\\s\\S])",
});
const NullableEntityIdSchema = Type.Union([EntityIdSchema, Type.Null()]);
const NullableReviewerIdSchema = Type.Union([GitHubNumericIdSchema, Type.Null()]);
const NullableReviewerLoginSchema = Type.Union([ConfigurationNameSchema, Type.Null()]);
const NullableAuthorizationPolicySchema = Type.Union([SelfOrAllowlistPolicySchema, Type.Null()]);

export const maximumSchedulingActiveLeases = 65_535;
export const maximumSchedulingQueuedJobs = 1_000_000;

// Null removes the additional limit at this scope. A repository still obeys platform limits.
// Both fields are required whenever a replacement limit object is supplied.
export const SchedulingLimitsSchema = Type.Object(
  {
    maxActiveLeases: Type.Union([
      Type.Integer({ minimum: 1, maximum: maximumSchedulingActiveLeases }),
      Type.Null(),
    ]),
    maxQueuedJobs: Type.Union([
      Type.Integer({ minimum: 1, maximum: maximumSchedulingQueuedJobs }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type SchedulingLimits = Static<typeof SchedulingLimitsSchema>;

export const ManagedRepositorySchema = Type.Object(
  {
    id: EntityIdSchema,
    githubRepositoryId: GitHubNumericIdSchema,
    fullName: ManagedRepositoryNameSchema,
    enabled: Type.Boolean(),
    version: PositiveIntegerSchema,
    reviewerGithubUserId: NullableReviewerIdSchema,
    reviewerGithubLogin: NullableReviewerLoginSchema,
    authorizationPolicy: NullableAuthorizationPolicySchema,
    schedulingLimits: SchedulingLimitsSchema,
    connectionStatus: RepositoryConnectionStatusSchema,
    connectionMessage: Type.Union([
      Type.String({ minLength: 1, maxLength: 2_048, pattern: "^[^\\u0000]*$" }),
      Type.Null(),
    ]),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type ManagedRepository = Static<typeof ManagedRepositorySchema>;

export const ManagedRepositorySummarySchema = Type.Omit(
  ManagedRepositorySchema,
  ["authorizationPolicy"],
  { additionalProperties: false },
);
export type ManagedRepositorySummary = Static<typeof ManagedRepositorySummarySchema>;

// The server resolves GitHub metadata and verifies that the numeric ID matches the name.
export const RepositoryCreateRequestSchema = Type.Object(
  {
    githubRepositoryId: GitHubNumericIdSchema,
    fullName: ManagedRepositoryNameSchema,
    enabled: Type.Optional(Type.Boolean()),
    schedulingLimits: Type.Optional(SchedulingLimitsSchema),
  },
  { additionalProperties: false },
);
export type RepositoryCreateRequest = Static<typeof RepositoryCreateRequestSchema>;

// Repository identity and connection health are server-owned and cannot be edited here.
export const RepositoryUpdateRequestSchema = Type.Object(
  {
    expectedVersion: PositiveIntegerSchema,
    enabled: Type.Optional(Type.Boolean()),
    reviewerGithubUserId: Type.Optional(NullableReviewerIdSchema),
    reviewerGithubLogin: Type.Optional(NullableReviewerLoginSchema),
    authorizationPolicy: Type.Optional(NullableAuthorizationPolicySchema),
    schedulingLimits: Type.Optional(SchedulingLimitsSchema),
  },
  { additionalProperties: false, minProperties: 2 },
);
export type RepositoryUpdateRequest = Static<typeof RepositoryUpdateRequestSchema>;

// HTTP handlers must additionally enforce this limit against the encoded UTF-8 byte length.
export const maximumPromptContentUtf8Bytes = 262_144;
export const PromptContentSchema = Type.String({
  minLength: 1,
  maxLength: maximumPromptContentUtf8Bytes,
  pattern: "^(?=[\\s\\S]*\\S)[^\\u0000]+$",
});

const PromptTemplateProperties = {
  id: EntityIdSchema,
  name: ConfigurationNameSchema,
  description: ConfigurationDescriptionSchema,
  version: PositiveIntegerSchema,
  draftRevision: PositiveIntegerSchema,
  draftContent: PromptContentSchema,
  latestPublishedVersionId: NullableEntityIdSchema,
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
};

export const PromptTemplateSchema = Type.Union(
  WorkflowKindValues.map((workflowKind) =>
    Type.Object(
      {
        ...PromptTemplateProperties,
        workflowKind: Type.Literal(workflowKind),
        draftOutputSchemaVersion: Type.Literal(WorkflowOutputSchemaVersions[workflowKind]),
      },
      { additionalProperties: false },
    ),
  ),
);
export type PromptTemplate = Static<typeof PromptTemplateSchema>;

const PromptTemplateSummaryProperties = Type.Omit(Type.Object(PromptTemplateProperties), [
  "draftContent",
]).properties;
export const PromptTemplateSummarySchema = Type.Union(
  WorkflowKindValues.map((workflowKind) =>
    Type.Object(
      {
        ...PromptTemplateSummaryProperties,
        workflowKind: Type.Literal(workflowKind),
        draftOutputSchemaVersion: Type.Literal(WorkflowOutputSchemaVersions[workflowKind]),
      },
      { additionalProperties: false },
    ),
  ),
);
export type PromptTemplateSummary = Static<typeof PromptTemplateSummarySchema>;

// Published rows are append-only. No request accepts their author, digest, or timestamps.
export const PromptVersionSchema = Type.Object(
  {
    id: EntityIdSchema,
    templateId: EntityIdSchema,
    version: PositiveIntegerSchema,
    content: PromptContentSchema,
    contentSha256: Sha256Schema,
    outputSchemaVersion: PromptOutputSchemaVersionSchema,
    createdAt: DateTimeSchema,
    publishedAt: DateTimeSchema,
    createdBy: ConfigurationActorSchema,
  },
  { additionalProperties: false },
);
export type PromptVersion = Static<typeof PromptVersionSchema>;

export const PromptVersionSummarySchema = Type.Omit(PromptVersionSchema, ["content"], {
  additionalProperties: false,
});
export type PromptVersionSummary = Static<typeof PromptVersionSummarySchema>;

export const PromptTemplateCreateRequestSchema = Type.Union(
  WorkflowKindValues.map((workflowKind) =>
    Type.Object(
      {
        name: ConfigurationNameSchema,
        workflowKind: Type.Literal(workflowKind),
        description: Type.Optional(ConfigurationDescriptionSchema),
        content: PromptContentSchema,
        outputSchemaVersion: Type.Literal(WorkflowOutputSchemaVersions[workflowKind]),
      },
      { additionalProperties: false },
    ),
  ),
);
export type PromptTemplateCreateRequest = Static<typeof PromptTemplateCreateRequestSchema>;

// The server also checks the schema against the stored template's immutable workflow kind.
export const PromptDraftSaveRequestSchema = Type.Object(
  {
    expectedVersion: PositiveIntegerSchema,
    content: PromptContentSchema,
    outputSchemaVersion: PromptOutputSchemaVersionSchema,
  },
  { additionalProperties: false },
);
export type PromptDraftSaveRequest = Static<typeof PromptDraftSaveRequestSchema>;

export const PromptDraftPublishRequestSchema = Type.Object(
  { expectedVersion: PositiveIntegerSchema },
  { additionalProperties: false },
);
export type PromptDraftPublishRequest = Static<typeof PromptDraftPublishRequestSchema>;

export const PromptPreviewRequestSchema = Type.Object(
  {
    content: PromptContentSchema,
    workItemId: Type.Optional(EntityIdSchema),
    workflowKind: Type.Optional(WorkflowKindSchema),
  },
  { additionalProperties: false },
);
export type PromptPreviewRequest = Static<typeof PromptPreviewRequestSchema>;

export const PromptPreviewResponseSchema = Type.Object(
  {
    renderedContent: Type.String({
      minLength: 1,
      maxLength: 524_288,
      pattern: "^[^\\u0000]*$",
    }),
    contentSha256: Sha256Schema,
    workItemId: NullableEntityIdSchema,
    repositoryId: NullableEntityIdSchema,
  },
  { additionalProperties: false },
);
export type PromptPreviewResponse = Static<typeof PromptPreviewResponseSchema>;

export const RepositoryPromptBindingSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    workflowKind: WorkflowKindSchema,
    promptVersionId: EntityIdSchema,
    version: PositiveIntegerSchema,
  },
  { additionalProperties: false },
);
export type RepositoryPromptBinding = Static<typeof RepositoryPromptBindingSchema>;

// A null repository selects an explicit global default. Repository bindings override that default.
export const PromptBindingSchema = Type.Object(
  {
    ...RepositoryPromptBindingSchema.properties,
    repositoryId: NullableEntityIdSchema,
  },
  { additionalProperties: false },
);
export type PromptBinding = Static<typeof PromptBindingSchema>;

export const RepositoryPromptBindingSaveRequestSchema = Type.Object(
  {
    expectedVersion: NonNegativeIntegerSchema,
    promptVersionId: EntityIdSchema,
  },
  { additionalProperties: false },
);
export type RepositoryPromptBindingSaveRequest = Static<
  typeof RepositoryPromptBindingSaveRequestSchema
>;

export const PromptBindingSaveRequestSchema = RepositoryPromptBindingSaveRequestSchema;
export type PromptBindingSaveRequest = Static<typeof PromptBindingSaveRequestSchema>;

export const maximumValidationStepCount = 32;
export const maximumValidationTimeoutMs = 86_400_000;
export const maximumValidationProfileConfigUtf8Bytes = 262_144;
const ValidationTimeoutSchema = Type.Integer({
  minimum: 1_000,
  maximum: maximumValidationTimeoutMs,
});
const EnvironmentVariableNameSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z_][A-Za-z0-9_]*(?![\\s\\S])",
});

export const ValidationEnvironmentVariableSchema = Type.Union([
  Type.Object(
    {
      name: EnvironmentVariableNameSchema,
      value: Type.String({ maxLength: 8_192, pattern: "^[^\\u0000]*$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { name: EnvironmentVariableNameSchema, secretRef: EntityIdSchema },
    { additionalProperties: false },
  ),
]);
export type ValidationEnvironmentVariable = Static<typeof ValidationEnvironmentVariableSchema>;

// Commands are trusted operator configuration, executed as an executable plus arguments.
// The Worker must resolve workingDirectory inside the original revision workspace and reject links
// escaping it. Secret values must use references resolved only at execution time.
export const TrustedValidationCommandSchema = Type.Object(
  {
    executable: Type.String({
      minLength: 1,
      maxLength: 2_048,
      pattern: "^[^\\u0000-\\u001F\\u007F]+(?![\\s\\S])",
    }),
    args: Type.Array(Type.String({ maxLength: 8_192, pattern: "^[^\\u0000]*$" }), {
      maxItems: 128,
    }),
    workingDirectory: Type.String({
      minLength: 1,
      maxLength: 1_024,
      pattern:
        "^(?!/)(?!\\.\\.(?:/|$))(?!.*?/\\.\\.(?:/|$))[^\\u0000-\\u001F\\u007F\\\\:]+(?![\\s\\S])",
    }),
    environment: Type.Array(ValidationEnvironmentVariableSchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type TrustedValidationCommand = Static<typeof TrustedValidationCommandSchema>;

export const ValidationCommandStepSchema = Type.Object(
  {
    id: EntityIdSchema,
    name: ConfigurationNameSchema,
    command: TrustedValidationCommandSchema,
    timeoutMs: ValidationTimeoutSchema,
    required: Type.Boolean(),
    probeOutput: Type.Optional(TestProbeOutputDeclarationV1Schema),
  },
  { additionalProperties: false },
);
export type ValidationCommandStep = Static<typeof ValidationCommandStepSchema>;

export const ValidationProfileConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal("ValidationProfileV1"),
    setup: Type.Array(ValidationCommandStepSchema, { maxItems: maximumValidationStepCount }),
    build: Type.Array(ValidationCommandStepSchema, { maxItems: maximumValidationStepCount }),
    test: Type.Array(ValidationCommandStepSchema, { maxItems: maximumValidationStepCount }),
    launch: Type.Array(ValidationCommandStepSchema, { maxItems: maximumValidationStepCount }),
    cleanup: Type.Array(ValidationCommandStepSchema, { maxItems: maximumValidationStepCount }),
    requiredCapabilities: Type.Array(
      Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._:+-]*(?![\\s\\S])",
      }),
      { maxItems: 128, uniqueItems: true },
    ),
    hardTimeoutMs: ValidationTimeoutSchema,
    noProgressTimeoutMs: ValidationTimeoutSchema,
    // An absent field preserves the exact serialized configuration and hash of published V1 rows.
    // Legacy UI profiles without scenarios remain readable but cannot become execution-ready.
    ui: Type.Optional(UiScenarioConfigurationSchema),
  },
  { additionalProperties: false },
);
export type ValidationProfileConfig = Static<typeof ValidationProfileConfigSchema>;

// Call this after schema validation and before publication. Cross-field and encoded-size checks
// cannot be expressed by the JSON Schema subset shared by the API and Worker validators.
export function getValidationProfileConfigIssues(
  config: ValidationProfileConfig,
  workflowKind?: WorkflowKind,
  target?: ValidationTarget,
): string[] {
  const issues: string[] = [];
  if (
    new TextEncoder().encode(JSON.stringify(config)).byteLength >
    maximumValidationProfileConfigUtf8Bytes
  ) {
    issues.push(
      `Profile configuration exceeds ${maximumValidationProfileConfigUtf8Bytes} UTF-8 bytes.`,
    );
  }
  if (config.noProgressTimeoutMs > config.hardTimeoutMs) {
    issues.push("The no-progress timeout must not exceed the hard timeout.");
  }
  const stepIds = new Set<string>();
  for (const stage of ["setup", "build", "test", "launch", "cleanup"] as const) {
    if (workflowKind === "issue_triage" && config[stage].length > 0) {
      issues.push(`Issue triage must not execute ${stage} steps.`);
    }
    for (const step of config[stage]) {
      if (stepIds.has(step.id)) {
        issues.push(`Step ID ${step.id} is duplicated.`);
      }
      stepIds.add(step.id);
      if (step.probeOutput !== undefined) {
        if (stage !== "test") {
          issues.push(`Step ${step.id} may declare probe output only in the test phase.`);
        }
        const fieldIds = new Set<string>();
        for (const field of step.probeOutput.fields) {
          if (fieldIds.has(field.id)) {
            issues.push(`Step ${step.id} repeats probe field ID ${field.id}.`);
          }
          fieldIds.add(field.id);
        }
      }
      if (step.timeoutMs > config.hardTimeoutMs) {
        issues.push(`Step ${step.id} timeout exceeds the profile hard timeout.`);
      }
      const environmentNames = new Set<string>();
      for (const variable of step.command.environment) {
        const normalizedName = variable.name.toUpperCase();
        if (environmentNames.has(normalizedName)) {
          issues.push(`Step ${step.id} repeats environment variable ${variable.name}.`);
        }
        environmentNames.add(normalizedName);
        if (
          "value" in variable &&
          /(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIALS?|COOKIE|AUTHORIZATION|API_KEY|PRIVATE_KEY)(?:_|$)/u.test(
            normalizedName,
          )
        ) {
          issues.push(
            `Step ${step.id} environment variable ${variable.name} must use a secret reference.`,
          );
        }
      }
    }
  }
  if (config.ui !== undefined) {
    if (workflowKind === "issue_triage" || workflowKind === "pr_static_build") {
      issues.push(`Workflow ${workflowKind} must not contain UI scenarios.`);
    }
    if (target !== undefined && config.ui.target !== target) {
      issues.push("UI configuration target must match the validation profile target.");
    }
    issues.push(
      ...getUiScenarioConfigurationIssues(config.ui, {
        launchStepIds: config.launch.map((step) => step.id),
        launchTimeoutMs:
          config.launch.find((step) => step.id === config.ui?.launch.stepId)?.timeoutMs ??
          config.hardTimeoutMs,
        resetStepIds: [...config.setup, ...config.cleanup].map((step) => step.id),
        reservedIds: [...stepIds],
        hardTimeoutMs: config.hardTimeoutMs,
      }),
    );
    if (config.ui.target === "web") {
      const portVariable = config.ui.service.portEnvironmentVariable.toUpperCase();
      for (const step of config.launch) {
        if (
          step.command.environment.some((variable) => variable.name.toUpperCase() === portVariable)
        ) {
          issues.push(
            "The managed Web port environment variable must not be overridden by the launch command.",
          );
        }
      }
    }
  }
  return issues;
}

const WorkflowTargetSchemas = [
  {
    workflowKind: Type.Literal("pr_static_build"),
    target: Type.Literal("headless"),
    outputSchemaVersion: Type.Literal("PrReviewPlanV2"),
  },
  {
    workflowKind: Type.Literal("pr_ui"),
    target: Type.Union([Type.Literal("windows_desktop"), Type.Literal("web")]),
    outputSchemaVersion: Type.Literal("ValidationReportV1"),
  },
  {
    workflowKind: Type.Literal("issue_triage"),
    target: Type.Literal("headless"),
    outputSchemaVersion: Type.Literal("IssueTriageV2"),
  },
  {
    workflowKind: Type.Literal("issue_validation"),
    target: ValidationTargetSchema,
    outputSchemaVersion: Type.Literal("ValidationReportV1"),
  },
] as const;

const ValidationProfileProperties = {
  name: ConfigurationNameSchema,
  config: ValidationProfileConfigSchema,
  required: Type.Boolean(),
};

const ValidationProfileVersionProperties = {
  ...ValidationProfileProperties,
  id: EntityIdSchema,
  profileId: EntityIdSchema,
  repositoryId: EntityIdSchema,
  version: PositiveIntegerSchema,
  configSha256: Sha256Schema,
  createdAt: DateTimeSchema,
  publishedAt: DateTimeSchema,
  createdBy: ConfigurationActorSchema,
};

export const ValidationProfileVersionSchema = Type.Union(
  WorkflowTargetSchemas.map((workflowTarget) =>
    Type.Object(
      {
        ...ValidationProfileVersionProperties,
        ...workflowTarget,
      },
      { additionalProperties: false },
    ),
  ),
);
export type ValidationProfileVersion = Static<typeof ValidationProfileVersionSchema>;

const ValidationProfileVersionSummaryProperties = Type.Omit(
  Type.Object(ValidationProfileVersionProperties),
  ["config"],
).properties;
export const ValidationProfileVersionSummarySchema = Type.Union(
  WorkflowTargetSchemas.map((workflowTarget) =>
    Type.Object(
      {
        ...ValidationProfileVersionSummaryProperties,
        ...workflowTarget,
      },
      { additionalProperties: false },
    ),
  ),
);
export type ValidationProfileVersionSummary = Static<typeof ValidationProfileVersionSummarySchema>;

export const ValidationProfileCreateRequestSchema = Type.Union(
  WorkflowTargetSchemas.flatMap((workflowTarget) => [
    Type.Object(
      {
        ...ValidationProfileProperties,
        ...workflowTarget,
        expectedVersion: Type.Optional(Type.Literal(0)),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...ValidationProfileProperties,
        ...workflowTarget,
        profileId: EntityIdSchema,
        expectedVersion: PositiveIntegerSchema,
      },
      { additionalProperties: false },
    ),
  ]),
);
export type ValidationProfileCreateRequest = Static<typeof ValidationProfileCreateRequestSchema>;

export const RepositoryValidationProfileBindingSchema = Type.Object(
  {
    repositoryId: EntityIdSchema,
    profileId: EntityIdSchema,
    profileVersionId: EntityIdSchema,
    enabled: Type.Boolean(),
    version: PositiveIntegerSchema,
  },
  { additionalProperties: false },
);
export type RepositoryValidationProfileBinding = Static<
  typeof RepositoryValidationProfileBindingSchema
>;

export const RepositoryValidationProfileBindingSaveRequestSchema = Type.Object(
  {
    expectedVersion: NonNegativeIntegerSchema,
    profileVersionId: EntityIdSchema,
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type RepositoryValidationProfileBindingSaveRequest = Static<
  typeof RepositoryValidationProfileBindingSaveRequestSchema
>;
