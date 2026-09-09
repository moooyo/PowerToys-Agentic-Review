import { FormatRegistry, type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  DateTimeSchema,
  EntityIdSchema,
  GitHubNumericIdSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";
import {
  GitHubIssueRevisionSchema,
  GitHubPullRequestRevisionSchema,
  GitHubWorkItemRevisionSchema,
  GitHubWorkItemSchema,
} from "./github.js";
import {
  FrozenIssueReproductionBindingSchema,
  IssueReproductionRequestV1Schema,
} from "./issue-reproduction.js";
import {
  ManagedRepositoryNameSchema,
  PromptVersionSchema,
  ValidationProfileVersionSchema,
  ValidationTargetSchema,
  WorkflowKindSchema,
} from "./platform-configuration.js";
import { ActiveAuthorizedRequestEpochSchema, SelfOrAllowlistPolicySchema } from "./scheduling.js";
import { QualifiedValidationCheckIdSchema } from "./validation-report.js";

export const maximumReviewRunRequestCount = 32;
export const maximumReviewRunPlanUtf8Bytes = 16 * 1024 * 1024;

const ExactCommitSchema = Type.String({
  minLength: 40,
  maxLength: 64,
  pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$",
});

export const ReviewRunRepositorySnapshotSchema = Type.Object(
  {
    id: EntityIdSchema,
    githubRepositoryId: GitHubNumericIdSchema,
    fullName: ManagedRepositoryNameSchema,
    configurationVersion: PositiveIntegerSchema,
  },
  { additionalProperties: false },
);

// Issue content identity and the source commit used for reproduction are separate dimensions.
export const ReviewRunTestedSourceRevisionSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("pull_request"), baseSha: ExactCommitSchema, headSha: ExactCommitSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("commit"), headSha: ExactCommitSchema },
    { additionalProperties: false },
  ),
]);
export type ReviewRunTestedSourceRevision = Static<typeof ReviewRunTestedSourceRevisionSchema>;

// The authenticated operator boundary creates this snapshot. It must never be accepted from an
// HTTP body or inferred from issue-triage authorization. New runs need fresh run authorization;
// retries and audited per-profile reruns within the same frozen plan may retain this snapshot.
export const ReviewRunTestedSourceAuthorizationSchema = Type.Object(
  {
    kind: Type.Literal("operator"),
    activationId: EntityIdSchema,
    issuer: Type.String({ minLength: 1, maxLength: 2_048 }),
    subject: Type.String({ minLength: 1, maxLength: 512 }),
    authorizedAt: DateTimeSchema,
    githubRepositoryId: GitHubNumericIdSchema,
    githubWorkItemId: GitHubNumericIdSchema,
    issueRevisionKey: Sha256Schema,
    headSha: ExactCommitSchema,
  },
  { additionalProperties: false },
);
export type ReviewRunTestedSourceAuthorization = Static<
  typeof ReviewRunTestedSourceAuthorizationSchema
>;

export const ReviewRunPromptSnapshotSchema = Type.Object(
  { workflowKind: WorkflowKindSchema, version: PromptVersionSchema },
  { additionalProperties: false },
);
export type ReviewRunPromptSnapshot = Static<typeof ReviewRunPromptSnapshotSchema>;

export const ReviewRunRequestSchema = Type.Object(
  {
    requestId: EntityIdSchema,
    workflowKind: WorkflowKindSchema,
    target: ValidationTargetSchema,
    required: Type.Boolean(),
    profileVersion: Type.Union([ValidationProfileVersionSchema, Type.Null()]),
    prompt: Type.Union([ReviewRunPromptSnapshotSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ReviewRunRequest = Static<typeof ReviewRunRequestSchema>;

// This is an inventory of implemented executors, not a request to enable a future driver.
export const ReviewRunRunnerSupportSchema = Type.Object(
  {
    workflowKind: WorkflowKindSchema,
    target: ValidationTargetSchema,
    capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
    evidenceDelivery: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ReviewRunRunnerSupport = Static<typeof ReviewRunRunnerSupportSchema>;

export const ReviewRunPlanInputSchema = Type.Object(
  {
    activationId: EntityIdSchema,
    reproduction: Type.Optional(IssueReproductionRequestV1Schema),
    repository: ReviewRunRepositorySnapshotSchema,
    workItemId: EntityIdSchema,
    workItem: GitHubWorkItemSchema,
    revision: GitHubWorkItemRevisionSchema,
    testedSourceRevision: Type.Union([ReviewRunTestedSourceRevisionSchema, Type.Null()]),
    testedSourceAuthorization: Type.Union([ReviewRunTestedSourceAuthorizationSchema, Type.Null()]),
    authorization: ActiveAuthorizedRequestEpochSchema,
    authorizationPolicy: SelfOrAllowlistPolicySchema,
    // Resolve these from trusted repository bindings. Include every required request, retaining
    // null snapshots for missing versions; never let client selection silently omit a requirement.
    requests: Type.Array(ReviewRunRequestSchema, {
      minItems: 1,
      maxItems: maximumReviewRunRequestCount,
    }),
    runnerSupport: Type.Array(ReviewRunRunnerSupportSchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type ReviewRunPlanInput = Static<typeof ReviewRunPlanInputSchema>;

const FrozenRevisionSchema = Type.Union([
  Type.Omit(GitHubPullRequestRevisionSchema, ["observedAt", "sourceUpdatedAt"], {
    additionalProperties: false,
  }),
  Type.Omit(GitHubIssueRevisionSchema, ["observedAt", "sourceUpdatedAt"], {
    additionalProperties: false,
  }),
]);

export const ReviewRunPlannedJobSchema = Type.Object(
  {
    ...ReviewRunRequestSchema.properties,
    // Build/test steps and typed UI scenarios are checks. Setup/launch/cleanup stay in the profile.
    requiredCheckIds: Type.Array(QualifiedValidationCheckIdSchema, {
      maxItems: 96,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type ReviewRunPlannedJob = Static<typeof ReviewRunPlannedJobSchema>;

export const ReviewRunExecutionPlanV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("ReviewRunExecutionPlanV1"),
    activationId: EntityIdSchema,
    reproduction: Type.Optional(FrozenIssueReproductionBindingSchema),
    repository: ReviewRunRepositorySnapshotSchema,
    workItemId: EntityIdSchema,
    workItem: GitHubWorkItemSchema,
    revision: FrozenRevisionSchema,
    testedSourceRevision: Type.Union([ReviewRunTestedSourceRevisionSchema, Type.Null()]),
    testedSourceAuthorization: Type.Union([ReviewRunTestedSourceAuthorizationSchema, Type.Null()]),
    authorization: Type.Object(
      {
        requestEpochId: EntityIdSchema,
        sequence: PositiveIntegerSchema,
        basis: Type.Union([Type.Literal("self"), Type.Literal("allowlist")]),
        actorGithubUserId: GitHubNumericIdSchema,
        targetGithubUserId: GitHubNumericIdSchema,
        policy: SelfOrAllowlistPolicySchema,
      },
      { additionalProperties: false },
    ),
    jobs: Type.Array(ReviewRunPlannedJobSchema, {
      minItems: 1,
      maxItems: maximumReviewRunRequestCount,
    }),
    requiredCheckIds: Type.Array(QualifiedValidationCheckIdSchema, {
      maxItems: 3_072,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type ReviewRunExecutionPlanV1 = Static<typeof ReviewRunExecutionPlanV1Schema>;

export const ReviewRunBlockedReasonCodeSchema = Type.Union([
  Type.Literal("missing_profile"),
  Type.Literal("missing_prompt"),
  Type.Literal("unsupported_target"),
  Type.Literal("missing_capability"),
  Type.Literal("evidence_delivery_unavailable"),
  Type.Literal("missing_scenarios"),
  Type.Literal("missing_required_scenarios"),
  Type.Literal("missing_build"),
  Type.Literal("missing_launch"),
  Type.Literal("missing_validation_checks"),
  Type.Literal("missing_tested_source_revision"),
  Type.Literal("missing_source_authorization"),
  Type.Literal("reproduction_mapping_blocked"),
]);
export type ReviewRunBlockedReasonCode = Static<typeof ReviewRunBlockedReasonCodeSchema>;

export const ReviewRunBlockedReasonSchema = Type.Object(
  {
    code: ReviewRunBlockedReasonCodeSchema,
    capability: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type ReviewRunBlockedReason = Static<typeof ReviewRunBlockedReasonSchema>;

export const ReviewRunReadinessSchema = Type.Object(
  {
    requestId: EntityIdSchema,
    required: Type.Boolean(),
    state: Type.Union([Type.Literal("ready"), Type.Literal("blocked")]),
    reasons: Type.Array(ReviewRunBlockedReasonSchema, { maxItems: 140 }),
  },
  { additionalProperties: false },
);
export type ReviewRunReadiness = Static<typeof ReviewRunReadinessSchema>;

export const ReviewRunPlanResultSchema = Type.Object(
  {
    plan: ReviewRunExecutionPlanV1Schema,
    planDigest: Sha256Schema,
    readiness: Type.Array(ReviewRunReadinessSchema, {
      minItems: 1,
      maxItems: maximumReviewRunRequestCount,
    }),
    requiredRequestBlockers: Type.Array(
      Type.Object(
        { requestId: EntityIdSchema, reason: ReviewRunBlockedReasonCodeSchema },
        { additionalProperties: false },
      ),
      { maxItems: 4_480 },
    ),
  },
  { additionalProperties: false },
);
export type ReviewRunPlanResult = Static<typeof ReviewRunPlanResultSchema>;

function registerFormats(): void {
  if (!FormatRegistry.Has("date-time")) {
    FormatRegistry.Set(
      "date-time",
      (value) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
        Number.isFinite(Date.parse(value)),
    );
  }
  if (!FormatRegistry.Has("uri")) FormatRegistry.Set("uri", (value) => URL.canParse(value));
}

export function assertReviewRunPlanInput(value: unknown): asserts value is ReviewRunPlanInput {
  registerFormats();
  if (!Value.Check(ReviewRunPlanInputSchema, value)) {
    const error = Value.Errors(ReviewRunPlanInputSchema, value).First();
    throw new TypeError(`Review run input is invalid at ${error?.path || "/"}.`);
  }
}

export function assertReviewRunExecutionPlan(
  value: unknown,
): asserts value is ReviewRunExecutionPlanV1 {
  registerFormats();
  if (!Value.Check(ReviewRunExecutionPlanV1Schema, value)) {
    const error = Value.Errors(ReviewRunExecutionPlanV1Schema, value).First();
    throw new TypeError(`Review run execution plan is invalid at ${error?.path || "/"}.`);
  }
}
