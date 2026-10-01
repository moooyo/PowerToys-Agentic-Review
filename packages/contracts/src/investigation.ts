import { type Static, type TProperties, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  DateTimeSchema,
  EntityIdSchema,
  GitObjectIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";
import {
  InvestigationE2eExecutionSchema,
  InvestigationE2eResultSchema,
  validateInvestigationE2eBindings,
} from "./investigation-e2e.js";
import {
  InvestigationInputSnapshotV1Schema,
  InvestigationPlanExecutionBindingSchema,
  InvestigationPlanStepStartedSchema,
} from "./investigation-execution.js";
import {
  InvestigationModelOutputRejectionIssueSchema,
  InvestigationModelOutputRejectionSchema,
} from "./investigation-model-output.js";
import { InvestigationNativePromptSnapshotSchema } from "./investigation-native-prompts.js";
import {
  getInvestigationRecipeStepIssues,
  InvestigationRecipeStepSchema,
} from "./investigation-recipes.js";
import {
  InvestigationPrDiffManifestV1Schema,
  InvestigationSourceCoverageSchema,
  validateInvestigationSourceCoverage,
} from "./investigation-source.js";
import { InvestigationUsageSummarySchema } from "./investigation-usage.js";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const text = Type.String({ minLength: 1, pattern: "\\S" });
const nullableId = Type.Union([EntityIdSchema, Type.Null()]);
const ids = Type.Array(EntityIdSchema, { uniqueItems: true });
const strings = Type.Array(text);
const idempotencyKey = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });

export const InvestigationTaskKindSchema = Type.Union([
  Type.Literal("pr-review"),
  Type.Literal("pr-e2e"),
  Type.Literal("issue-investigate"),
  Type.Literal("pr-verify"),
  Type.Literal("issue-verify"),
  Type.Literal("reproduction-setup"),
  Type.Literal("issue-fix"),
  Type.Literal("feature-implement"),
]);
export type InvestigationTaskKind = Static<typeof InvestigationTaskKindSchema>;
export const InvestigationOutcomeSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("interrupted"),
]);
export type InvestigationOutcome = Static<typeof InvestigationOutcomeSchema>;
export const InvestigationReportRefSchema = object({
  id: EntityIdSchema,
  version: PositiveIntegerSchema,
  digest: Sha256Schema,
});
export type InvestigationReportRef = Static<typeof InvestigationReportRefSchema>;
export const InvestigationVersionRefSchema = object({
  id: EntityIdSchema,
  version: PositiveIntegerSchema,
  digest: Sha256Schema,
});
export type InvestigationVersionRef = Static<typeof InvestigationVersionRefSchema>;
export const InvestigationRepositorySchema = object({
  id: EntityIdSchema,
  githubRepositoryId: PositiveIntegerSchema,
  fullName: text,
});
export type InvestigationRepository = Static<typeof InvestigationRepositorySchema>;
export const InvestigationWorkItemSchema = object({
  id: EntityIdSchema,
  kind: Type.Union([Type.Literal("pull_request"), Type.Literal("issue")]),
  number: PositiveIntegerSchema,
  title: text,
});
export type InvestigationWorkItem = Static<typeof InvestigationWorkItemSchema>;

/** The trusted Worker's explicit CLI selection; null means no model was explicitly selected. */
export const InvestigationModelIdentitySchema = object({
  engine: Type.Union([Type.Literal("codex"), Type.Literal("copilot")]),
  model: Type.Union([
    Type.String({
      minLength: 1,
      maxLength: 256,
      pattern: "^(?=.*\\S)[^\\u0000-\\u001f\\u007f-\\u009f]+$",
    }),
    Type.Null(),
  ]),
});
export type InvestigationModelIdentity = Static<typeof InvestigationModelIdentitySchema>;
export const InvestigationModelExecutionSchema = object({
  attemptId: EntityIdSchema,
  round: PositiveIntegerSchema,
  ...InvestigationModelIdentitySchema.properties,
});
export type InvestigationModelExecution = Static<typeof InvestigationModelExecutionSchema>;

const subjectProperties = {
  id: EntityIdSchema,
  repositoryId: EntityIdSchema,
  workItemId: EntityIdSchema,
  revisionKey: Sha256Schema,
};
export const InvestigationSubjectV1Schema = Type.Union([
  object({
    ...subjectProperties,
    kind: Type.Literal("original_pr"),
    baseSha: GitObjectIdSchema,
    headSha: GitObjectIdSchema,
  }),
  object({
    ...subjectProperties,
    kind: Type.Literal("issue_snapshot"),
    snapshotDigest: Sha256Schema,
  }),
  object({
    ...subjectProperties,
    kind: Type.Literal("source_commit"),
    commitSha: GitObjectIdSchema,
  }),
  object({
    ...subjectProperties,
    kind: Type.Literal("local_patch"),
    baseSubjectRef: EntityIdSchema,
    baseSha: GitObjectIdSchema,
    patchDigest: Sha256Schema,
    artifactRef: EntityIdSchema,
  }),
  object({
    ...subjectProperties,
    kind: Type.Literal("remote_branch"),
    baseSha: GitObjectIdSchema,
    headSha: GitObjectIdSchema,
    branch: text,
    verifiedEvidenceRef: EntityIdSchema,
  }),
]);
export type InvestigationSubjectV1 = Static<typeof InvestigationSubjectV1Schema>;

export const InvestigationReviewBaselineFindingRefSchema = object({
  id: EntityIdSchema,
  version: PositiveIntegerSchema,
});
export type InvestigationReviewBaselineFindingRef = Static<
  typeof InvestigationReviewBaselineFindingRefSchema
>;
/** A previous native review is comparison context, never an inherited execution source. */
export const InvestigationReviewBaselineDescriptorSchema = object({
  reportRef: InvestigationReportRefSchema,
  sourceTaskId: EntityIdSchema,
  subject: InvestigationSubjectV1Schema.anyOf[0],
  findings: Type.Array(
    object({ ...InvestigationReviewBaselineFindingRefSchema.properties, title: text }),
  ),
});
export type InvestigationReviewBaselineDescriptor = Static<
  typeof InvestigationReviewBaselineDescriptorSchema
>;
export const InvestigationReviewDispositionSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("fixed"),
  Type.Literal("still_present"),
  Type.Literal("not_confirmed"),
  Type.Literal("unverified"),
]);
export type InvestigationReviewDisposition = Static<typeof InvestigationReviewDispositionSchema>;

const sourceProvenanceCommit = Type.String({
  minLength: 40,
  maxLength: 40,
  pattern: "^[a-f0-9]{40}$",
});
const sourceProvenancePath = Type.String({ minLength: 1, maxLength: 4_096 });
/** Trusted materialization metadata; a dependency pin does not establish review coverage. */
export const InvestigationSourceProvenanceSchema = object({
  subjectRef: EntityIdSchema,
  sourceSha: sourceProvenanceCommit,
  submodules: Type.Array(
    object({
      path: sourceProvenancePath,
      repository: Type.String({
        minLength: 3,
        maxLength: 256,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*(?![\\s\\S])",
      }),
      commitSha: sourceProvenanceCommit,
      parentPath: Type.Union([sourceProvenancePath, Type.Null()]),
      parentCommitSha: sourceProvenanceCommit,
    }),
    { minItems: 1, maxItems: 128 },
  ),
});
export type InvestigationSourceProvenance = Static<typeof InvestigationSourceProvenanceSchema>;

export const InvestigationPrerequisiteSchema = object({
  id: EntityIdSchema,
  kind: Type.Union([
    Type.Literal("information"),
    Type.Literal("decision"),
    Type.Literal("environment"),
    Type.Literal("authorization"),
    Type.Literal("source"),
    Type.Literal("capability"),
  ]),
  description: text,
});
export type InvestigationPrerequisite = Static<typeof InvestigationPrerequisiteSchema>;
export const INVESTIGATION_EXECUTION_DURATION_LIMIT_MS = 7_200_000;

/** Legacy counters remain readable in sealed history but never limit execution. */
export const InvestigationBudgetSchema = object({
  maxRounds: Type.Optional(PositiveIntegerSchema),
  maxDurationMs: PositiveIntegerSchema,
  maxTokens: Type.Optional(PositiveIntegerSchema),
  maxReportBytes: PositiveIntegerSchema,
});
export type InvestigationBudget = Static<typeof InvestigationBudgetSchema>;

/** Every execution attempt shares the same total duration limit, including legacy tasks. */
export function getInvestigationExecutionDurationLimitMs(_budget?: InvestigationBudget): number {
  return INVESTIGATION_EXECUTION_DURATION_LIMIT_MS;
}

/** Use only for new or explicitly revised budgets; sealed history must retain its original shape. */
export function normalizeInvestigationBudget(budget: InvestigationBudget): InvestigationBudget {
  return {
    maxDurationMs: INVESTIGATION_EXECUTION_DURATION_LIMIT_MS,
    maxReportBytes: budget.maxReportBytes,
  };
}
export const InvestigationExecutionPolicySchema = object({
  mode: Type.Union([
    Type.Literal("snapshot_only"),
    Type.Literal("source_read"),
    Type.Literal("execute"),
  ]),
  allowedSubjectRefs: ids,
  allowRepositoryExecution: Type.Boolean(),
  authorizationRef: nullableId,
});
export type InvestigationExecutionPolicy = Static<typeof InvestigationExecutionPolicySchema>;

export const InvestigationCoverageUnitSchema = object({
  id: EntityIdSchema,
  subjectRef: EntityIdSchema,
  kind: text,
  paths: strings,
  requiredWork: text,
  status: Type.Union([Type.Literal("pending"), Type.Literal("completed"), Type.Literal("blocked")]),
  evidenceRefs: ids,
});
export type InvestigationCoverageUnit = Static<typeof InvestigationCoverageUnitSchema>;
export const InvestigationCoverageSchema = object({
  scopeManifest: InvestigationVersionRefSchema,
  includedUnits: Type.Array(InvestigationCoverageUnitSchema),
  exclusions: Type.Array(
    object({ id: EntityIdSchema, subjectRef: EntityIdSchema, description: text, reason: text }),
  ),
  completedUnitRefs: ids,
  unresolvedUnitRefs: ids,
});
export type InvestigationCoverage = Static<typeof InvestigationCoverageSchema>;

export const InvestigationArtifactV1Schema = object({
  id: EntityIdSchema,
  taskId: EntityIdSchema,
  attemptId: EntityIdSchema,
  subjectRef: EntityIdSchema,
  kind: Type.Union([
    Type.Literal("log"),
    Type.Literal("image"),
    Type.Literal("video"),
    Type.Literal("trace"),
    Type.Literal("patch"),
    Type.Literal("report"),
    Type.Literal("source"),
    Type.Literal("other"),
  ]),
  name: text,
  mediaType: text,
  digest: Sha256Schema,
  byteLength: NonNegativeIntegerSchema,
  availability: Type.Union([
    Type.Literal("available"),
    Type.Literal("expired"),
    Type.Literal("missing"),
  ]),
});
export type InvestigationArtifactV1 = Static<typeof InvestigationArtifactV1Schema>;

export const InvestigationTaskV1Schema = object({
  schemaVersion: Type.Literal("InvestigationTaskV1"),
  id: EntityIdSchema,
  kind: InvestigationTaskKindSchema,
  repository: InvestigationRepositorySchema,
  workItem: InvestigationWorkItemSchema,
  parentTaskId: nullableId,
  parentReportRef: Type.Union([InvestigationReportRefSchema, Type.Null()]),
  reviewBaseline: Type.Optional(InvestigationReviewBaselineDescriptorSchema),
  planRef: Type.Union([InvestigationVersionRefSchema, Type.Null()]),
  subjectRef: EntityIdSchema,
  subjects: Type.Array(InvestigationSubjectV1Schema, { minItems: 1 }),
  // Frozen parent patch metadata preserves the producing task and attempt identities.
  sourceArtifacts: Type.Optional(Type.Array(InvestigationArtifactV1Schema)),
  scope: InvestigationCoverageSchema,
  executionPolicy: InvestigationExecutionPolicySchema,
  budget: InvestigationBudgetSchema,
  profileRef: InvestigationVersionRefSchema,
  promptRef: InvestigationVersionRefSchema,
  promptSnapshot: Type.Optional(InvestigationNativePromptSnapshotSchema),
  state: Type.Union([Type.Literal("queued"), Type.Literal("running"), InvestigationOutcomeSchema]),
  latestReportRef: Type.Union([InvestigationReportRefSchema, Type.Null()]),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type InvestigationTaskV1 = Static<typeof InvestigationTaskV1Schema>;
export const InvestigationAttemptV1Schema = object({
  schemaVersion: Type.Literal("InvestigationAttemptV1"),
  id: EntityIdSchema,
  taskId: EntityIdSchema,
  number: PositiveIntegerSchema,
  workerId: nullableId,
  leaseVersion: NonNegativeIntegerSchema,
  state: Type.Union([
    Type.Literal("queued"),
    Type.Literal("leased"),
    Type.Literal("running"),
    InvestigationOutcomeSchema,
  ]),
  startedAt: Type.Union([DateTimeSchema, Type.Null()]),
  finishedAt: Type.Union([DateTimeSchema, Type.Null()]),
  terminationReason: Type.Union([text, Type.Null()]),
});
export type InvestigationAttemptV1 = Static<typeof InvestigationAttemptV1Schema>;

export const InvestigationEvidenceV1Schema = object({
  id: EntityIdSchema,
  subjectRef: EntityIdSchema,
  source: Type.Union([
    Type.Literal("static_analysis"),
    Type.Literal("reporter_statement"),
    Type.Literal("source_snapshot"),
    Type.Literal("executor_observation"),
    Type.Literal("visual_observation"),
    Type.Literal("upstream_reference"),
  ]),
  authority: Type.Union([Type.Literal("model"), Type.Literal("worker"), Type.Literal("server")]),
  summary: text,
  artifactRefs: ids,
  evidenceRefs: ids,
  provenance: object({
    taskId: EntityIdSchema,
    attemptId: EntityIdSchema,
    producer: text,
    recordedAt: DateTimeSchema,
  }),
});
export type InvestigationEvidenceV1 = Static<typeof InvestigationEvidenceV1Schema>;
export const InvestigationAnalysisEvidenceSchema = object({
  id: EntityIdSchema,
  subjectRef: EntityIdSchema,
  source: Type.Union([Type.Literal("static_analysis"), Type.Literal("reporter_statement")]),
  summary: text,
  evidenceRefs: ids,
});
export type InvestigationAnalysisEvidence = Static<typeof InvestigationAnalysisEvidenceSchema>;

export const InvestigationDiagnosticSchema = object({
  id: EntityIdSchema,
  code: text,
  category: Type.Union([
    Type.Literal("blocker"),
    Type.Literal("error"),
    Type.Literal("limitation"),
    Type.Literal("recovery"),
  ]),
  message: text,
  retryable: Type.Boolean(),
  evidenceRefs: ids,
  prerequisiteRefs: ids,
});
export type InvestigationDiagnostic = Static<typeof InvestigationDiagnosticSchema>;
export const InvestigationLimitationSchema = object({
  id: EntityIdSchema,
  description: text,
  impact: text,
  evidenceRefs: ids,
});

export const InvestigationLocationSchema = Type.Union([
  object({
    kind: Type.Literal("source"),
    subjectRef: EntityIdSchema,
    path: text,
    startLine: PositiveIntegerSchema,
    endLine: PositiveIntegerSchema,
  }),
  object({
    kind: Type.Union([Type.Literal("ui"), Type.Literal("issue"), Type.Literal("behavior")]),
    subjectRef: EntityIdSchema,
    description: text,
  }),
]);
export type InvestigationLocation = Static<typeof InvestigationLocationSchema>;
export const InvestigationCodeSuggestionSchema = object({
  subjectRef: EntityIdSchema,
  path: text,
  startLine: PositiveIntegerSchema,
  endLine: PositiveIntegerSchema,
  headSha: GitObjectIdSchema,
  originalContentDigest: Sha256Schema,
  replacement: Type.String(),
});
export type InvestigationCodeSuggestion = Static<typeof InvestigationCodeSuggestionSchema>;
export const InvestigationFeedbackDraftSchema = object({
  id: EntityIdSchema,
  body: text,
  suggestion: Type.Union([InvestigationCodeSuggestionSchema, Type.Null()]),
});
export type InvestigationFeedbackDraft = Static<typeof InvestigationFeedbackDraftSchema>;
export const InvestigationFindingV1Schema = object({
  id: EntityIdSchema,
  version: PositiveIntegerSchema,
  ordinal: NonNegativeIntegerSchema,
  priority: Type.Union([
    Type.Literal("P0"),
    Type.Literal("P1"),
    Type.Literal("P2"),
    Type.Literal("P3"),
  ]),
  title: text,
  trigger: object({ conditions: strings, inputs: strings, steps: strings }),
  impact: object({ description: text, affectedParties: strings }),
  rootCause: object({
    status: Type.Union([
      Type.Literal("established"),
      Type.Literal("hypothesis"),
      Type.Literal("unknown"),
    ]),
    explanation: text,
    evidenceRefs: ids,
  }),
  subjectRef: EntityIdSchema,
  locations: Type.Array(InvestigationLocationSchema),
  evidenceRefs: ids,
  confirmation: object({
    status: Type.Union([Type.Literal("confirmed"), Type.Literal("hypothesis")]),
    rationale: text,
    evidenceRefs: ids,
    recheckRef: nullableId,
  }),
  fixRecommendation: object({
    summary: text,
    constraints: strings,
    planRef: Type.Union([InvestigationVersionRefSchema, Type.Null()]),
  }),
  feedbackDraft: InvestigationFeedbackDraftSchema,
});
export type InvestigationFindingV1 = Static<typeof InvestigationFindingV1Schema>;
/** The complete saved findings remain outside the current evidence and subject ledgers. */
export const InvestigationReviewBaselineSnapshotSchema = object({
  descriptor: InvestigationReviewBaselineDescriptorSchema,
  findings: Type.Array(InvestigationFindingV1Schema),
});
export type InvestigationReviewBaselineSnapshot = Static<
  typeof InvestigationReviewBaselineSnapshotSchema
>;
export const InvestigationRecheckSchema = object({
  id: EntityIdSchema,
  findingId: EntityIdSchema,
  findingVersion: PositiveIntegerSchema,
  subjectRef: EntityIdSchema,
  round: PositiveIntegerSchema,
  evidenceRefs: ids,
  conclusion: text,
  unresolvedQuestions: strings,
});
export type InvestigationRecheck = Static<typeof InvestigationRecheckSchema>;
export const InvestigationCandidateSchema = object({
  id: EntityIdSchema,
  subjectRef: EntityIdSchema,
  title: text,
  discoveredRound: NonNegativeIntegerSchema,
  reviewBaselineFindingRef: Type.Optional(InvestigationReviewBaselineFindingRefSchema),
  reviewDisposition: Type.Optional(InvestigationReviewDispositionSchema),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("confirmed"),
    Type.Literal("withdrawn"),
    Type.Literal("merged"),
    Type.Literal("unresolved"),
  ]),
  findingId: nullableId,
  findingVersion: Type.Union([PositiveIntegerSchema, Type.Null()]),
  mergedIntoCandidateId: nullableId,
  rationale: text,
  evidenceRefs: ids,
});
export type InvestigationCandidate = Static<typeof InvestigationCandidateSchema>;

export const InvestigationPlanKindSchema = Type.Union([
  Type.Literal("investigation"),
  Type.Literal("verification"),
  Type.Literal("reproduction"),
  Type.Literal("fix"),
  Type.Literal("implementation"),
]);
const planProperties = {
  id: EntityIdSchema,
  version: PositiveIntegerSchema,
  kind: InvestigationPlanKindSchema,
  subjectRef: EntityIdSchema,
  title: text,
  rationale: text,
  prerequisites: Type.Array(InvestigationPrerequisiteSchema),
  steps: Type.Array(
    object({
      id: EntityIdSchema,
      description: text,
      expectedObservation: text,
      checkIds: ids,
      recipe: Type.Optional(InvestigationRecipeStepSchema),
    }),
    { minItems: 1 },
  ),
  acceptanceCriteria: Type.Array(text, { minItems: 1 }),
};
export const InvestigationPlanDraftSchema = object(planProperties);
export type InvestigationPlanDraft = Static<typeof InvestigationPlanDraftSchema>;
export const InvestigationPlanV1Schema = object({
  ...planProperties,
  digest: Sha256Schema,
  sourceReportRef: object({ id: EntityIdSchema, version: PositiveIntegerSchema }),
  state: Type.Literal("saved"),
});
export type InvestigationPlanV1 = Static<typeof InvestigationPlanV1Schema>;
export const InvestigationActionKindSchema = Type.Union([
  Type.Literal("comment"),
  Type.Literal("approve"),
  Type.Literal("suggestion-comment"),
  Type.Literal("request-changes"),
  Type.Literal("close"),
  Type.Literal("merge"),
  Type.Literal("trigger-ci"),
  Type.Literal("close-as-duplicate"),
  Type.Literal("start-task"),
  Type.Literal("reviews.verify"),
  Type.Literal("view-validation"),
  Type.Literal("view-changes"),
  Type.Literal("create-pr"),
  Type.Literal("view-evidence"),
  Type.Literal("resume"),
]);
export type InvestigationActionKind = Static<typeof InvestigationActionKindSchema>;
const nextActionProperties = {
  id: EntityIdSchema,
  action: InvestigationActionKindSchema,
  taskKind: Type.Union([InvestigationTaskKindSchema, Type.Null()]),
  label: text,
  reason: text,
  recommended: Type.Boolean(),
  subjectRef: EntityIdSchema,
  planRef: Type.Union([InvestigationVersionRefSchema, Type.Null()]),
  draftRef: nullableId,
  validationReportRef: Type.Union([InvestigationReportRefSchema, Type.Null()]),
  prerequisiteRefs: ids,
};
export const InvestigationNextActionDraftSchema = object(nextActionProperties);
export type InvestigationNextActionDraft = Static<typeof InvestigationNextActionDraftSchema>;
export const InvestigationNextActionV1Schema = object({
  ...nextActionProperties,
  state: Type.Literal("saved"),
  sourceReportRef: object({ id: EntityIdSchema, version: PositiveIntegerSchema }),
});
export type InvestigationNextActionV1 = Static<typeof InvestigationNextActionV1Schema>;

const referenceDetails = object({
  identifier: text,
  explanation: text,
  evidenceRefs: Type.Array(EntityIdSchema, { minItems: 1, uniqueItems: true }),
});
const assessmentProperties = { subjectRef: EntityIdSchema, summary: text, evidenceRefs: ids };
export const InvestigationAssessmentSchema = Type.Union([
  object({
    ...assessmentProperties,
    kind: Type.Literal("pr"),
    reviewConclusion: object({
      status: Type.Union([
        Type.Literal("no-blocking-findings"),
        Type.Literal("changes-requested"),
        Type.Literal("inconclusive"),
      ]),
      rationale: text,
    }),
    e2eAssessment: object({
      level: Type.Union([
        Type.Literal("not_needed"),
        Type.Literal("recommended"),
        Type.Literal("required"),
      ]),
      rationale: text,
      planRef: Type.Union([InvestigationVersionRefSchema, Type.Null()]),
      scenarioIds: ids,
      prerequisiteRefs: ids,
      linkedValidationReportRefs: Type.Array(InvestigationReportRefSchema),
    }),
  }),
  object({
    ...assessmentProperties,
    kind: Type.Literal("bug"),
    bugAssessment: object({
      status: Type.Union([
        Type.Literal("confirmed"),
        Type.Literal("needs_information"),
        Type.Literal("needs_verification"),
        Type.Literal("already_fixed"),
        Type.Literal("duplicate"),
        Type.Literal("not_a_bug"),
      ]),
      rationale: text,
      missingInformation: strings,
      hypotheses: strings,
      upstreamFix: Type.Union([referenceDetails, Type.Null()]),
      duplicateOf: Type.Union([referenceDetails, Type.Null()]),
      expectedBehavior: Type.Union([text, Type.Null()]),
    }),
    reproduction: object({
      status: Type.Union([
        Type.Literal("reproduced"),
        Type.Literal("not_reproduced"),
        Type.Literal("not_run"),
        Type.Literal("blocked"),
      ]),
      summary: text,
      evidenceRefs: ids,
      planRef: Type.Union([InvestigationVersionRefSchema, Type.Null()]),
    }),
  }),
  object({
    ...assessmentProperties,
    kind: Type.Literal("feature"),
    featureAssessment: object({
      status: Type.Union([
        Type.Literal("ready"),
        Type.Literal("needs_information"),
        Type.Literal("needs_decision"),
        Type.Literal("already_supported"),
        Type.Literal("duplicate"),
        Type.Literal("not_feasible"),
      ]),
      requirements: strings,
      feasibility: text,
      missingInformation: strings,
      decisions: Type.Array(
        object({
          question: text,
          options: Type.Array(object({ label: text, tradeoffs: text }), { minItems: 2 }),
        }),
      ),
      alternatives: strings,
      usage: Type.Union([text, Type.Null()]),
      duplicateOf: Type.Union([referenceDetails, Type.Null()]),
      implementationPlanRef: Type.Union([InvestigationVersionRefSchema, Type.Null()]),
      acceptanceCriteria: strings,
      prerequisiteRefs: ids,
    }),
  }),
  object({
    ...assessmentProperties,
    kind: Type.Literal("other_issue"),
    classification: text,
    explanation: text,
  }),
]);
export type InvestigationAssessment = Static<typeof InvestigationAssessmentSchema>;

export const InvestigationValidationCheckSchema = object({
  id: EntityIdSchema,
  scenarioId: EntityIdSchema,
  subjectRef: EntityIdSchema,
  planRef: Type.Union([InvestigationVersionRefSchema, Type.Null()]),
  required: Type.Boolean(),
  description: text,
  status: Type.Union([
    Type.Literal("passed"),
    Type.Literal("failed"),
    Type.Literal("not_run"),
    Type.Literal("blocked"),
  ]),
  executor: Type.Union([text, Type.Null()]),
  evidenceRefs: ids,
  authoritativeAttemptId: nullableId,
});
export type InvestigationValidationCheck = Static<typeof InvestigationValidationCheckSchema>;
export const InvestigationValidationSchema = object({
  checks: Type.Array(InvestigationValidationCheckSchema),
  summary: text,
});
export type InvestigationValidation = Static<typeof InvestigationValidationSchema>;
export const InvestigationConsumptionSchema = object({
  rounds: NonNegativeIntegerSchema,
  durationMs: NonNegativeIntegerSchema,
  tokens: NonNegativeIntegerSchema,
  reportBytes: NonNegativeIntegerSchema,
});
export type InvestigationConsumption = Static<typeof InvestigationConsumptionSchema>;
export const InvestigationLoopStopReasonSchema = Type.Union([
  Type.Literal("complete"),
  Type.Literal("continuing"),
  Type.Literal("blocked"),
  Type.Literal("error"),
  Type.Literal("cancelled"),
  Type.Literal("budget_exhausted"),
  Type.Literal("interrupted"),
]);
export type InvestigationLoopStopReason = Static<typeof InvestigationLoopStopReasonSchema>;
export const InvestigationLoopPhaseSchema = Type.Union([
  Type.Literal("discovery"),
  Type.Literal("investigation"),
  Type.Literal("recheck"),
  Type.Literal("finalize"),
]);
export type InvestigationLoopPhase = Static<typeof InvestigationLoopPhaseSchema>;
export const InvestigationLoopStateSchema = object({
  checkpointId: EntityIdSchema,
  checkpointVersion: PositiveIntegerSchema,
  completedRounds: NonNegativeIntegerSchema,
  candidates: Type.Array(InvestigationCandidateSchema),
  stopReason: InvestigationLoopStopReasonSchema,
  budget: InvestigationBudgetSchema,
  consumed: InvestigationConsumptionSchema,
});
export type InvestigationLoopState = Static<typeof InvestigationLoopStateSchema>;
export const InvestigationCollectionCountsSchema = object({
  findings: NonNegativeIntegerSchema,
  verificationEvidence: NonNegativeIntegerSchema,
  artifacts: NonNegativeIntegerSchema,
  plans: NonNegativeIntegerSchema,
  nextActions: NonNegativeIntegerSchema,
  candidates: NonNegativeIntegerSchema,
  rechecks: NonNegativeIntegerSchema,
});
export const InvestigationReportMetadataSchema = object({
  id: EntityIdSchema,
  version: PositiveIntegerSchema,
  delivery: Type.Union([Type.Literal("final"), Type.Literal("checkpoint")]),
  completeness: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
  summary: text,
  logicalContentDigest: Sha256Schema,
  usage: Type.Optional(InvestigationUsageSummarySchema),
  coverage: InvestigationCoverageSchema,
  recheck: object({
    finalFindingCount: NonNegativeIntegerSchema,
    validFinalVersionRecheckCount: NonNegativeIntegerSchema,
    pendingFindingIds: ids,
    records: Type.Array(InvestigationRecheckSchema),
  }),
  loop: InvestigationLoopStateSchema,
  limitations: Type.Array(InvestigationLimitationSchema),
  collections: InvestigationCollectionCountsSchema,
});
export type InvestigationReportMetadata = Static<typeof InvestigationReportMetadataSchema>;
export const InvestigationResultContextSchema = object({
  e2e: Type.Optional(InvestigationE2eResultSchema),
  sourceProvenance: Type.Optional(InvestigationSourceProvenanceSchema),
  repository: InvestigationRepositorySchema,
  workItem: InvestigationWorkItemSchema,
  task: object({
    id: EntityIdSchema,
    kind: InvestigationTaskKindSchema,
    parentTaskId: nullableId,
    subjectRef: EntityIdSchema,
  }),
  attempt: object({ id: EntityIdSchema, number: PositiveIntegerSchema }),
  adoptedAttemptIds: ids,
  modelExecutions: Type.Optional(Type.Array(InvestigationModelExecutionSchema)),
  subjects: Type.Array(InvestigationSubjectV1Schema, { minItems: 1 }),
  sourceArtifacts: Type.Optional(Type.Array(InvestigationArtifactV1Schema)),
  profileRef: InvestigationVersionRefSchema,
  promptRef: InvestigationVersionRefSchema,
  parentReportRef: Type.Union([InvestigationReportRefSchema, Type.Null()]),
  reviewBaseline: Type.Optional(InvestigationReviewBaselineDescriptorSchema),
});
export type InvestigationResultContext = Static<typeof InvestigationResultContextSchema>;
export const InvestigationResultV1Schema = object({
  schemaVersion: Type.Literal("InvestigationResultV1"),
  id: EntityIdSchema,
  version: PositiveIntegerSchema,
  context: InvestigationResultContextSchema,
  outcome: InvestigationOutcomeSchema,
  report: InvestigationReportMetadataSchema,
  findings: Type.Array(InvestigationFindingV1Schema),
  assessment: InvestigationAssessmentSchema,
  validation: InvestigationValidationSchema,
  verificationEvidence: Type.Array(InvestigationEvidenceV1Schema),
  diagnostics: Type.Array(InvestigationDiagnosticSchema),
  artifacts: Type.Array(InvestigationArtifactV1Schema),
  plans: Type.Array(InvestigationPlanV1Schema),
  nextActions: Type.Array(InvestigationNextActionV1Schema),
  feedbackDrafts: Type.Array(InvestigationFeedbackDraftSchema),
});
export type InvestigationResultV1 = Static<typeof InvestigationResultV1Schema>;

// Model output contains only proposed analysis. Observations, outcome, persisted state, and permissions are assembled by trusted services.
const analysisProperties = {
  summary: text,
  coverage: InvestigationCoverageSchema,
  findings: Type.Array(InvestigationFindingV1Schema),
  assessment: InvestigationAssessmentSchema,
  candidates: Type.Array(InvestigationCandidateSchema),
  rechecks: Type.Array(InvestigationRecheckSchema),
  evidence: Type.Array(InvestigationAnalysisEvidenceSchema),
  plans: Type.Array(InvestigationPlanDraftSchema),
  nextActions: Type.Array(InvestigationNextActionDraftSchema),
  feedbackDrafts: Type.Array(InvestigationFeedbackDraftSchema),
  diagnostics: Type.Array(InvestigationDiagnosticSchema),
  limitations: Type.Array(InvestigationLimitationSchema),
};
export const InvestigationAnalysisV1Schema = object({
  schemaVersion: Type.Literal("InvestigationAnalysisV1"),
  ...analysisProperties,
});
export type InvestigationAnalysisV1 = Static<typeof InvestigationAnalysisV1Schema>;
export const InvestigationLoopRoundV1Schema = object({
  schemaVersion: Type.Literal("InvestigationLoopRoundV1"),
  taskId: EntityIdSchema,
  attemptId: EntityIdSchema,
  inputCheckpointRef: Type.Union([InvestigationVersionRefSchema, Type.Null()]),
  round: PositiveIntegerSchema,
  phase: Type.Union([
    Type.Literal("discovery"),
    Type.Literal("investigation"),
    Type.Literal("recheck"),
    Type.Literal("finalize"),
  ]),
  analysis: InvestigationAnalysisV1Schema,
  continue: Type.Boolean(),
  continuationReason: text,
});
export type InvestigationLoopRoundV1 = Static<typeof InvestigationLoopRoundV1Schema>;
/** Trusted usage is retained even when a model proposal is not accepted as an analysis round. */
export const InvestigationUnacceptedModelUsageSchema = object({
  attemptId: EntityIdSchema,
  round: PositiveIntegerSchema,
  tokens: Type.Union([NonNegativeIntegerSchema, Type.Null()]),
});
export type InvestigationUnacceptedModelUsage = Static<
  typeof InvestigationUnacceptedModelUsageSchema
>;
export const InvestigationRuntimeStateSchema = object({
  reviewBaseline: Type.Optional(InvestigationReviewBaselineDescriptorSchema),
  e2eExecution: Type.Optional(InvestigationE2eExecutionSchema),
  e2e: Type.Optional(InvestigationE2eResultSchema),
  sourceProvenance: Type.Optional(InvestigationSourceProvenanceSchema),
  reviewMode: Type.Optional(
    Type.Union([Type.Literal("local_checkout"), Type.Literal("local_snapshot")]),
  ),
  sourceCoverage: Type.Optional(InvestigationSourceCoverageSchema),
  modelExecutions: Type.Optional(Type.Array(InvestigationModelExecutionSchema)),
  unacceptedModelUsage: Type.Optional(Type.Array(InvestigationUnacceptedModelUsageSchema)),
  modelOutputRejections: Type.Optional(Type.Array(InvestigationModelOutputRejectionSchema)),
  completedStepIds: ids,
  checks: Type.Array(InvestigationValidationCheckSchema),
  evidence: Type.Array(InvestigationEvidenceV1Schema),
  artifacts: Type.Array(InvestigationArtifactV1Schema),
  subjects: Type.Array(InvestigationSubjectV1Schema),
  startedSteps: Type.Array(InvestigationPlanStepStartedSchema),
  completedSteps: Type.Array(
    object({
      ...InvestigationPlanStepStartedSchema.properties,
      outcome: Type.Union([
        Type.Literal("completed"),
        Type.Literal("blocked"),
        Type.Literal("failed"),
      ]),
      validation: InvestigationValidationSchema,
      verificationEvidence: Type.Array(InvestigationEvidenceV1Schema),
      artifacts: Type.Array(InvestigationArtifactV1Schema),
      diagnostics: Type.Array(InvestigationDiagnosticSchema),
      subjects: Type.Array(InvestigationSubjectV1Schema),
      modelUsage: Type.Optional(
        object({
          tokens: Type.Union([NonNegativeIntegerSchema, Type.Null()]),
          durationMs: NonNegativeIntegerSchema,
        }),
      ),
    }),
  ),
});
export type InvestigationRuntimeState = Static<typeof InvestigationRuntimeStateSchema>;
export const InvestigationLoopCheckpointV1Schema = object({
  schemaVersion: Type.Literal("InvestigationLoopCheckpointV1"),
  id: EntityIdSchema,
  version: PositiveIntegerSchema,
  digest: Sha256Schema,
  taskId: EntityIdSchema,
  attemptId: EntityIdSchema,
  leaseVersion: NonNegativeIntegerSchema,
  subjectRevisionKey: Sha256Schema,
  profileRef: InvestigationVersionRefSchema,
  promptRef: InvestigationVersionRefSchema,
  previousCheckpointRef: Type.Union([InvestigationVersionRefSchema, Type.Null()]),
  round: NonNegativeIntegerSchema,
  analysis: InvestigationAnalysisV1Schema,
  adoptedAttemptIds: ids,
  recordedAt: DateTimeSchema,
  budget: InvestigationBudgetSchema,
  consumed: InvestigationConsumptionSchema,
  stopReason: InvestigationLoopStopReasonSchema,
  taskBindingDigest: Sha256Schema,
  lastPhase: Type.Union([InvestigationLoopPhaseSchema, Type.Null()]),
  runtime: InvestigationRuntimeStateSchema,
});
export type InvestigationLoopCheckpointV1 = Static<typeof InvestigationLoopCheckpointV1Schema>;

export const InvestigationActionGuardSchema = object({
  code: text,
  satisfied: Type.Boolean(),
  message: text,
});
export type InvestigationActionGuard = Static<typeof InvestigationActionGuardSchema>;
export const InvestigationActionAvailabilitySchema = object({
  action: InvestigationActionKindSchema,
  allowed: Type.Boolean(),
  reason: text,
  guards: Type.Array(InvestigationActionGuardSchema),
});
export type InvestigationActionAvailability = Static<typeof InvestigationActionAvailabilitySchema>;
export const InvestigationHardContentBlockerSchema = Type.Union([
  object({
    findingId: EntityIdSchema,
    reportRef: InvestigationReportRefSchema,
    checkpointRef: Type.Null(),
    reason: text,
  }),
  object({
    findingId: EntityIdSchema,
    reportRef: Type.Null(),
    checkpointRef: InvestigationVersionRefSchema,
    reason: text,
  }),
]);
export type InvestigationHardContentBlocker = Static<typeof InvestigationHardContentBlockerSchema>;
export const ActionContextV1Schema = object({
  schemaVersion: Type.Literal("ActionContextV1"),
  workItemId: EntityIdSchema,
  repositoryId: EntityIdSchema,
  actor: object({ id: EntityIdSchema, displayName: text }),
  target: object({
    kind: Type.Union([Type.Literal("pull_request"), Type.Literal("issue")]),
    state: Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("merged")]),
    headSha: Type.Union([GitObjectIdSchema, Type.Null()]),
    revisionKey: Sha256Schema,
  }),
  reportRef: Type.Union([InvestigationReportRefSchema, Type.Null()]),
  recommendedActionId: nullableId,
  recommendation: object({
    action: Type.Union([InvestigationActionKindSchema, Type.Null()]),
    reason: text,
  }),
  hardContentBlockers: Type.Array(InvestigationHardContentBlockerSchema),
  fixedActions: Type.Array(InvestigationActionAvailabilitySchema),
  suggestionSelectionDefaults: Type.Array(
    object({
      findingId: EntityIdSchema,
      draftId: EntityIdSchema,
      valid: Type.Boolean(),
      selectedByDefault: Type.Boolean(),
      reason: text,
    }),
  ),
  nextActions: Type.Array(
    object({
      ...InvestigationNextActionV1Schema.properties,
      allowed: Type.Boolean(),
      canPrepare: Type.Boolean(),
      readyToExecute: Type.Boolean(),
      guards: Type.Array(InvestigationActionGuardSchema),
    }),
  ),
  pendingSubmission: Type.Union([
    object({ intentId: EntityIdSchema, state: Type.Literal("unknown"), message: text }),
    Type.Null(),
  ]),
  generatedAt: DateTimeSchema,
});
export type ActionContextV1 = Static<typeof ActionContextV1Schema>;

export const InvestigationActionPayloadSchema = Type.Union([
  object({
    kind: Type.Literal("feedback"),
    body: Type.String(),
    findingIds: ids,
    drafts: Type.Array(InvestigationFeedbackDraftSchema),
  }),
  object({
    kind: Type.Literal("task"),
    taskKind: InvestigationTaskKindSchema,
    planRef: InvestigationVersionRefSchema,
    sourceCommit: Type.Optional(GitObjectIdSchema),
  }),
  object({
    kind: Type.Literal("close"),
    reason: Type.Union([
      Type.Literal("completed"),
      Type.Literal("not_planned"),
      Type.Literal("duplicate"),
    ]),
    duplicateNumber: Type.Union([PositiveIntegerSchema, Type.Null()]),
  }),
  object({
    kind: Type.Literal("merge"),
    method: Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")]),
    commitTitle: Type.String(),
  }),
  object({
    kind: Type.Literal("trigger-ci"),
    workflowId: text,
    ref: text,
    inputs: Type.Record(Type.String(), Type.String()),
  }),
  object({
    kind: Type.Literal("create-pr"),
    branchSubjectRef: EntityIdSchema,
    title: text,
    body: Type.String(),
    baseBranch: text,
    draft: Type.Boolean(),
  }),
  object({
    kind: Type.Literal("navigate"),
    reportRef: Type.Union([InvestigationReportRefSchema, Type.Null()]),
    artifactRef: nullableId,
  }),
]);
export type InvestigationActionPayload = Static<typeof InvestigationActionPayloadSchema>;
export const InvestigationActionIntentV1Schema = object({
  schemaVersion: Type.Literal("InvestigationActionIntentV1"),
  id: EntityIdSchema,
  version: PositiveIntegerSchema,
  idempotencyKey,
  action: InvestigationActionKindSchema,
  repositoryId: EntityIdSchema,
  workItemId: EntityIdSchema,
  actorId: EntityIdSchema,
  subjectRef: EntityIdSchema,
  expectedRevisionKey: Sha256Schema,
  expectedHeadSha: Type.Union([GitObjectIdSchema, Type.Null()]),
  reportRef: Type.Union([InvestigationReportRefSchema, Type.Null()]),
  payload: InvestigationActionPayloadSchema,
  payloadDigest: Sha256Schema,
  state: Type.Union([
    Type.Literal("prepared"),
    Type.Literal("confirmed"),
    Type.Literal("executing"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("unknown"),
    Type.Literal("cancelled"),
  ]),
  guards: Type.Array(InvestigationActionGuardSchema),
  createdAt: DateTimeSchema,
  confirmedAt: Type.Union([DateTimeSchema, Type.Null()]),
  result: Type.Union([
    object({ message: text, externalId: Type.Union([text, Type.Null()]), taskId: nullableId }),
    Type.Null(),
  ]),
});
export type InvestigationActionIntentV1 = Static<typeof InvestigationActionIntentV1Schema>;

// A header is deliberately a different protocol from a complete logical export.
export const InvestigationReportHeaderV1Schema = object({
  schemaVersion: Type.Literal("InvestigationReportHeaderV1"),
  id: EntityIdSchema,
  version: PositiveIntegerSchema,
  context: InvestigationResultContextSchema,
  outcome: InvestigationOutcomeSchema,
  assessment: InvestigationAssessmentSchema,
  validation: object({ summary: text }),
  report: object({
    id: EntityIdSchema,
    version: PositiveIntegerSchema,
    delivery: InvestigationReportMetadataSchema.properties.delivery,
    completeness: InvestigationReportMetadataSchema.properties.completeness,
    summary: text,
    logicalContentDigest: Sha256Schema,
    usage: Type.Optional(InvestigationUsageSummarySchema),
    coverage: object({
      scopeManifest: InvestigationVersionRefSchema,
      includedUnitCount: NonNegativeIntegerSchema,
      completedUnitCount: NonNegativeIntegerSchema,
      unresolvedUnitCount: NonNegativeIntegerSchema,
      exclusionCount: NonNegativeIntegerSchema,
    }),
    recheck: object({
      finalFindingCount: NonNegativeIntegerSchema,
      validFinalVersionRecheckCount: NonNegativeIntegerSchema,
      pendingFindingCount: NonNegativeIntegerSchema,
    }),
    loop: Type.Omit(InvestigationLoopStateSchema, ["candidates"]),
    collections: InvestigationCollectionCountsSchema,
  }),
});
export type InvestigationReportHeaderV1 = Static<typeof InvestigationReportHeaderV1Schema>;
export const InvestigationReportCollectionSchema = Type.Union([
  Type.Literal("findings"),
  Type.Literal("verificationEvidence"),
  Type.Literal("artifacts"),
  Type.Literal("plans"),
  Type.Literal("nextActions"),
  Type.Literal("feedbackDrafts"),
  Type.Literal("coverageUnits"),
  Type.Literal("coverageExclusions"),
  Type.Literal("candidates"),
  Type.Literal("rechecks"),
  Type.Literal("diagnostics"),
  Type.Literal("limitations"),
  Type.Literal("validationChecks"),
]);
export type InvestigationReportCollection = Static<typeof InvestigationReportCollectionSchema>;
const partProperties = {
  schemaVersion: Type.Literal("InvestigationReportPartV1"),
  id: EntityIdSchema,
  taskId: EntityIdSchema,
  attemptId: EntityIdSchema,
  reportId: EntityIdSchema,
  reportVersion: PositiveIntegerSchema,
  sequence: NonNegativeIntegerSchema,
  itemCount: NonNegativeIntegerSchema,
  previousPartDigest: Type.Union([Sha256Schema, Type.Null()]),
  digest: Sha256Schema,
};
export const InvestigationReportPartV1Schema = Type.Union([
  object({
    ...partProperties,
    collection: Type.Literal("findings"),
    items: Type.Array(InvestigationFindingV1Schema),
  }),
  object({
    ...partProperties,
    collection: Type.Literal("verificationEvidence"),
    items: Type.Array(InvestigationEvidenceV1Schema),
  }),
  object({
    ...partProperties,
    collection: Type.Literal("artifacts"),
    items: Type.Array(InvestigationArtifactV1Schema),
  }),
  object({
    ...partProperties,
    collection: Type.Literal("plans"),
    items: Type.Array(InvestigationPlanV1Schema),
  }),
  object({
    ...partProperties,
    collection: Type.Literal("nextActions"),
    items: Type.Array(InvestigationNextActionV1Schema),
  }),
  object({
    ...partProperties,
    collection: Type.Literal("feedbackDrafts"),
    items: Type.Array(InvestigationFeedbackDraftSchema),
  }),
  object({
    ...partProperties,
    collection: Type.Literal("coverageUnits"),
    items: Type.Array(InvestigationCoverageUnitSchema),
  }),
  object({
    ...partProperties,
    collection: Type.Literal("coverageExclusions"),
    items: InvestigationCoverageSchema.properties.exclusions,
  }),
  object({
    ...partProperties,
    collection: Type.Literal("candidates"),
    items: Type.Array(InvestigationCandidateSchema),
  }),
  object({
    ...partProperties,
    collection: Type.Literal("rechecks"),
    items: Type.Array(InvestigationRecheckSchema),
  }),
  object({
    ...partProperties,
    collection: Type.Literal("diagnostics"),
    items: Type.Array(InvestigationDiagnosticSchema),
  }),
  object({
    ...partProperties,
    collection: Type.Literal("limitations"),
    items: Type.Array(InvestigationLimitationSchema),
  }),
  object({
    ...partProperties,
    collection: Type.Literal("validationChecks"),
    items: Type.Array(InvestigationValidationCheckSchema),
  }),
]);
export type InvestigationReportPartV1 = Static<typeof InvestigationReportPartV1Schema>;
export const InvestigationReportManifestV1Schema = object({
  schemaVersion: Type.Literal("InvestigationReportManifestV1"),
  reportId: EntityIdSchema,
  reportVersion: PositiveIntegerSchema,
  parts: Type.Array(
    object({
      id: EntityIdSchema,
      collection: InvestigationReportCollectionSchema,
      sequence: NonNegativeIntegerSchema,
      itemCount: NonNegativeIntegerSchema,
      digest: Sha256Schema,
    }),
  ),
  collections: InvestigationCollectionCountsSchema,
  logicalContentDigest: Sha256Schema,
});
export type InvestigationReportManifestV1 = Static<typeof InvestigationReportManifestV1Schema>;
export const InvestigationFindingsPageV1Schema = object({
  schemaVersion: Type.Literal("InvestigationFindingsPageV1"),
  reportRef: InvestigationReportRefSchema,
  total: NonNegativeIntegerSchema,
  offset: NonNegativeIntegerSchema,
  nextCursor: Type.Union([text, Type.Null()]),
  items: Type.Array(InvestigationFindingV1Schema),
});
export type InvestigationFindingsPageV1 = Static<typeof InvestigationFindingsPageV1Schema>;

export const InvestigationWorkerLeaseSchema = object({
  attemptId: EntityIdSchema,
  fence: NonNegativeIntegerSchema,
  leaseToken: text,
});
export type InvestigationWorkerLease = Static<typeof InvestigationWorkerLeaseSchema>;
export const InvestigationClaimRequestSchema = object({
  supportedKinds: Type.Array(InvestigationTaskKindSchema, { minItems: 1, uniqueItems: true }),
});
export type InvestigationClaimRequest = Static<typeof InvestigationClaimRequestSchema>;
export const InvestigationClaimSchema = object({
  task: InvestigationTaskV1Schema,
  attempt: InvestigationAttemptV1Schema,
  lease: InvestigationWorkerLeaseSchema,
  checkpoint: Type.Union([InvestigationLoopCheckpointV1Schema, Type.Null()]),
  reportId: EntityIdSchema,
  inputSnapshot: InvestigationInputSnapshotV1Schema,
  plan: Type.Union([InvestigationPlanV1Schema, Type.Null()]),
  execution: Type.Union([InvestigationPlanExecutionBindingSchema, Type.Null()]),
  reviewBaseline: Type.Optional(InvestigationReviewBaselineSnapshotSchema),
});
export type InvestigationClaim = Static<typeof InvestigationClaimSchema>;
export const InvestigationClaimResponseSchema = object({
  claim: Type.Union([InvestigationClaimSchema, Type.Null()]),
});
export type InvestigationClaimResponse = Static<typeof InvestigationClaimResponseSchema>;
export const InvestigationHeartbeatRequestSchema = object({
  lease: InvestigationWorkerLeaseSchema,
});
export const InvestigationHeartbeatResponseSchema = object({
  cancelRequested: Type.Boolean(),
  leaseExpiresAt: DateTimeSchema,
  serverTime: DateTimeSchema,
});
export type InvestigationHeartbeatRequest = Static<typeof InvestigationHeartbeatRequestSchema>;
export type InvestigationHeartbeatResponse = Static<typeof InvestigationHeartbeatResponseSchema>;
export const InvestigationCheckpointRequestSchema = Type.Union([
  object({
    kind: Type.Literal("rejected_analysis"),
    lease: InvestigationWorkerLeaseSchema,
    inputCheckpointRef: InvestigationVersionRefSchema,
    round: PositiveIntegerSchema,
    invocationId: EntityIdSchema,
    issue: InvestigationModelOutputRejectionIssueSchema,
  }),
  object({
    kind: Type.Literal("analysis"),
    invocationId: Type.Optional(EntityIdSchema),
    lease: InvestigationWorkerLeaseSchema,
    round: InvestigationLoopRoundV1Schema,
    usage: object({
      durationMs: NonNegativeIntegerSchema,
      tokens: Type.Union([NonNegativeIntegerSchema, Type.Null()]),
      reportBytes: NonNegativeIntegerSchema,
    }),
    modelIdentity: Type.Optional(InvestigationModelIdentitySchema),
    sourceUnitIds: Type.Optional(ids),
  }),
  object({
    kind: Type.Literal("source"),
    lease: InvestigationWorkerLeaseSchema,
    manifest: InvestigationPrDiffManifestV1Schema,
  }),
  object({
    kind: Type.Literal("source_provenance"),
    lease: InvestigationWorkerLeaseSchema,
    provenance: InvestigationSourceProvenanceSchema,
  }),
  object({
    kind: Type.Literal("execution"),
    lease: InvestigationWorkerLeaseSchema,
    execution: InvestigationRuntimeStateSchema,
  }),
  object({
    kind: Type.Literal("interrupt"),
    /** Trusted Worker statement emitted only before source preparation returned a workspace. */
    modelInvocationState: Type.Optional(Type.Literal("not_started")),
    lease: InvestigationWorkerLeaseSchema,
    reason: Type.Union([
      Type.Literal("blocked"),
      Type.Literal("error"),
      Type.Literal("cancelled"),
      Type.Literal("budget_exhausted"),
      Type.Literal("interrupted"),
    ]),
    diagnostics: Type.Array(InvestigationDiagnosticSchema),
    modelUsage: Type.Optional(
      object({
        ...Type.Omit(InvestigationUnacceptedModelUsageSchema, ["attemptId"]).properties,
        invocationId: Type.Optional(EntityIdSchema),
      }),
    ),
  }),
]);
export const InvestigationCheckpointResponseSchema = object({
  checkpoint: InvestigationLoopCheckpointV1Schema,
});
export type InvestigationCheckpointRequest = Static<typeof InvestigationCheckpointRequestSchema>;
export type InvestigationCheckpointResponse = Static<typeof InvestigationCheckpointResponseSchema>;
export const InvestigationReportPartRequestSchema = object({
  lease: InvestigationWorkerLeaseSchema,
  part: InvestigationReportPartV1Schema,
});
export const InvestigationReportPartResponseSchema = object({ accepted: Type.Literal(true) });
export type InvestigationReportPartRequest = Static<typeof InvestigationReportPartRequestSchema>;
export type InvestigationReportPartResponse = Static<typeof InvestigationReportPartResponseSchema>;
export const InvestigationFinalizeRequestSchema = object({
  lease: InvestigationWorkerLeaseSchema,
  header: InvestigationReportHeaderV1Schema,
  manifest: InvestigationReportManifestV1Schema,
});
export const InvestigationFinalizeResponseSchema = object({
  reportRef: InvestigationReportRefSchema,
});
export type InvestigationFinalizeRequest = Static<typeof InvestigationFinalizeRequestSchema>;
export type InvestigationFinalizeResponse = Static<typeof InvestigationFinalizeResponseSchema>;
export const InvestigationCreateTaskRequestV1Schema = object({
  idempotencyKey,
  workItemId: EntityIdSchema,
  kind: InvestigationTaskKindSchema,
  scope: Type.Optional(InvestigationCoverageSchema),
  executionMode: Type.Optional(InvestigationExecutionPolicySchema.properties.mode),
  budget: Type.Optional(InvestigationBudgetSchema),
  profileRef: Type.Optional(InvestigationVersionRefSchema),
  promptRef: Type.Optional(InvestigationVersionRefSchema),
  parentReportRef: Type.Optional(InvestigationReportRefSchema),
  planRef: Type.Optional(InvestigationVersionRefSchema),
  sourceCommit: Type.Optional(GitObjectIdSchema),
  expectedSubjectRevisionKey: Type.Optional(Sha256Schema),
});
export type InvestigationCreateTaskRequestV1 = Static<
  typeof InvestigationCreateTaskRequestV1Schema
>;
export const InvestigationCreateActionIntentRequestSchema = object({
  idempotencyKey,
  workItemId: EntityIdSchema,
  action: InvestigationActionKindSchema,
  subjectRef: EntityIdSchema,
  expectedRevisionKey: Sha256Schema,
  expectedHeadSha: Type.Union([GitObjectIdSchema, Type.Null()]),
  reportRef: Type.Union([InvestigationReportRefSchema, Type.Null()]),
  payload: InvestigationActionPayloadSchema,
  nextActionId: Type.Optional(EntityIdSchema),
});
export type InvestigationCreateActionIntentRequest = Static<
  typeof InvestigationCreateActionIntentRequestSchema
>;
export const InvestigationConfirmActionIntentRequestSchema = object({
  version: PositiveIntegerSchema,
  payloadDigest: Sha256Schema,
});
export type InvestigationConfirmActionIntentRequest = Static<
  typeof InvestigationConfirmActionIntentRequestSchema
>;
export const InvestigationArtifactRequestSchema = object({
  lease: InvestigationWorkerLeaseSchema,
  artifact: InvestigationArtifactV1Schema,
  contentBase64: Type.String({ maxLength: 44_739_244, pattern: "^[A-Za-z0-9+/]*={0,2}$" }),
});
export const InvestigationArtifactResponseSchema = object({ accepted: Type.Literal(true) });
export type InvestigationArtifactRequest = Static<typeof InvestigationArtifactRequestSchema>;
export type InvestigationArtifactResponse = Static<typeof InvestigationArtifactResponseSchema>;
export const InvestigationArtifactContentRequestSchema = object({
  lease: InvestigationWorkerLeaseSchema,
  artifactId: EntityIdSchema,
});
export const InvestigationArtifactContentResponseSchema = object({
  artifact: InvestigationArtifactV1Schema,
  contentBase64: InvestigationArtifactRequestSchema.properties.contentBase64,
});
export type InvestigationArtifactContentRequest = Static<
  typeof InvestigationArtifactContentRequestSchema
>;
export type InvestigationArtifactContentResponse = Static<
  typeof InvestigationArtifactContentResponseSchema
>;

export interface InvestigationSemanticIssue {
  path: string;
  code: string;
  message: string;
}
export interface InvestigationSemanticValidation {
  valid: boolean;
  errors: InvestigationSemanticIssue[];
}

export function validateInvestigationReviewBaselineDescriptor(
  descriptor: InvestigationReviewBaselineDescriptor,
): InvestigationSemanticValidation {
  const errors: InvestigationSemanticIssue[] = [];
  if (!Value.Check(InvestigationReviewBaselineDescriptorSchema, descriptor))
    return {
      valid: false,
      errors: [
        {
          path: "",
          code: "INVALID_REVIEW_BASELINE",
          message:
            "A review baseline must preserve the complete immutable native review descriptor.",
        },
      ],
    };
  const ids = new Set<string>();
  for (const [index, finding] of descriptor.findings.entries()) {
    if (ids.has(finding.id))
      errors.push({
        path: `/findings/${index}/id`,
        code: "DUPLICATE_REVIEW_BASELINE_FINDING",
        message: "Every previous finding must appear exactly once in the review baseline.",
      });
    ids.add(finding.id);
  }
  return { valid: errors.length === 0, errors };
}

/** Structural identity checks do not replace the Server's exact sealed-report lookup. */
export function validateInvestigationReviewBaselineSnapshot(
  snapshot: InvestigationReviewBaselineSnapshot,
): InvestigationSemanticValidation {
  if (!Value.Check(InvestigationReviewBaselineSnapshotSchema, snapshot))
    return {
      valid: false,
      errors: [
        {
          path: "",
          code: "INVALID_REVIEW_BASELINE_SNAPSHOT",
          message: "The review baseline must contain every complete saved finding.",
        },
      ],
    };
  const errors = validateInvestigationReviewBaselineDescriptor(snapshot.descriptor).errors.map(
    (issue) => ({ ...issue, path: `/descriptor${issue.path}` }),
  );
  if (snapshot.findings.length !== snapshot.descriptor.findings.length)
    errors.push({
      path: "/findings",
      code: "REVIEW_BASELINE_FINDINGS_MISMATCH",
      message:
        "The complete baseline findings must match the descriptor without paging or truncation.",
    });
  for (const [index, finding] of snapshot.findings.entries()) {
    const ref = snapshot.descriptor.findings[index];
    if (
      ref === undefined ||
      finding.id !== ref.id ||
      finding.version !== ref.version ||
      finding.title !== ref.title ||
      finding.ordinal !== index ||
      finding.subjectRef !== snapshot.descriptor.subject.id ||
      finding.locations.some((location) => location.subjectRef !== finding.subjectRef) ||
      (finding.feedbackDraft.suggestion !== null &&
        (finding.feedbackDraft.suggestion.subjectRef !== finding.subjectRef ||
          finding.feedbackDraft.suggestion.headSha !== snapshot.descriptor.subject.headSha))
    )
      errors.push({
        path: `/findings/${index}`,
        code: "REVIEW_BASELINE_FINDING_MISMATCH",
        message:
          "A baseline finding must retain its exact saved identity, title, ordinal, and original PR subject.",
      });
  }
  return { valid: errors.length === 0, errors };
}

export interface InvestigationReviewBaselineCandidateInput {
  baseline?: InvestigationReviewBaselineDescriptor;
  subjectRef: string;
  headSha: string | null;
  candidates: readonly InvestigationCandidate[];
  findings: readonly InvestigationFindingV1[];
  evidence: readonly { id: string; subjectRef: string; source: string }[];
  limitations: readonly Static<typeof InvestigationLimitationSchema>[];
  complete?: boolean;
}

/** Baseline conclusions must come from the current source ledger, not the previous report. */
export function validateInvestigationReviewBaselineCandidates(
  input: InvestigationReviewBaselineCandidateInput,
): InvestigationSemanticValidation {
  const errors: InvestigationSemanticIssue[] = [];
  const add = (path: string, code: string, message: string) => errors.push({ path, code, message });
  const expected = new Map(input.baseline?.findings.map((finding) => [finding.id, finding]) ?? []);
  const seen = new Set<string>();
  const candidates = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const findings = new Map(input.findings.map((finding) => [finding.id, finding]));
  const evidence = new Map(input.evidence.map((entry) => [entry.id, entry]));
  for (const [index, candidate] of input.candidates.entries()) {
    const path = `/candidates/${index}`;
    const ref = candidate.reviewBaselineFindingRef;
    const disposition = candidate.reviewDisposition;
    if (ref === undefined && disposition === undefined) {
      if (candidate.discoveredRound === 0)
        add(
          path,
          "BASELINE_CANDIDATE_REQUIRED",
          "Only a frozen baseline candidate may originate at round zero.",
        );
      continue;
    }
    const previous = ref === undefined ? undefined : expected.get(ref.id);
    if (
      input.baseline === undefined ||
      ref === undefined ||
      disposition === undefined ||
      previous?.version !== ref.version ||
      candidate.subjectRef !== input.subjectRef ||
      candidate.discoveredRound !== 0 ||
      seen.has(ref.id)
    ) {
      add(
        path,
        "REVIEW_BASELINE_CANDIDATE_MISMATCH",
        "Each frozen previous finding requires exactly one round-zero candidate on the current PR source.",
      );
      continue;
    }
    seen.add(ref.id);
    if (disposition === "pending") {
      if (candidate.status !== "pending")
        add(
          path,
          "REVIEW_DISPOSITION_MISMATCH",
          "A pending review disposition must remain a pending candidate.",
        );
      if (input.complete)
        add(
          path,
          "PENDING_REVIEW_BASELINE_FINDING",
          "Every previous finding requires an explicit current-source conclusion before completion.",
        );
      continue;
    }
    if (
      candidate.evidenceRefs.length === 0 ||
      candidate.evidenceRefs.some((id) => evidence.get(id)?.subjectRef !== input.subjectRef) ||
      !candidate.evidenceRefs.some((id) => evidence.get(id)?.source === "static_analysis")
    )
      add(
        path,
        "REVIEW_BASELINE_EVIDENCE_REQUIRED",
        "A previous finding's disposition requires fresh static evidence on the current PR source.",
      );
    if (disposition === "still_present") {
      let current: InvestigationCandidate | undefined = candidate;
      const visited = new Set<string>();
      while (current?.status === "merged" && !visited.has(current.id)) {
        visited.add(current.id);
        current =
          current.mergedIntoCandidateId === null
            ? undefined
            : candidates.get(current.mergedIntoCandidateId);
      }
      const finding =
        current?.findingId === null || current?.findingId === undefined
          ? undefined
          : findings.get(current.findingId);
      if (
        current?.status !== "confirmed" ||
        current.subjectRef !== input.subjectRef ||
        finding?.subjectRef !== input.subjectRef ||
        finding.version !== current.findingVersion ||
        finding.confirmation.status !== "confirmed"
      )
        add(
          path,
          "REVIEW_DISPOSITION_MISMATCH",
          "A still-present baseline finding must bind to a current confirmed finding through a valid same-source candidate chain.",
        );
    } else if (disposition === "fixed" || disposition === "not_confirmed") {
      if (candidate.status !== "withdrawn")
        add(
          path,
          "REVIEW_DISPOSITION_MISMATCH",
          "Fixed and unconfirmed previous findings require a withdrawn current-source candidate.",
        );
      if (
        disposition === "fixed" &&
        (input.headSha === null || input.headSha === input.baseline.subject.headSha)
      )
        add(
          path,
          "REVIEW_FIX_REQUIRES_NEW_HEAD",
          "A fix conclusion requires a changed current PR head; the same revision may only reconfirm or reject the previous diagnosis.",
        );
    } else if (disposition === "unverified") {
      const finding = candidate.findingId === null ? undefined : findings.get(candidate.findingId);
      const retainedHypothesis =
        candidate.status === "unresolved" &&
        finding?.subjectRef === input.subjectRef &&
        finding.version === candidate.findingVersion &&
        finding.confirmation.status === "hypothesis";
      const statedMissingEvidence =
        candidate.status === "withdrawn" &&
        input.limitations.some((limitation) =>
          limitation.evidenceRefs.some((id) => candidate.evidenceRefs.includes(id)),
        );
      if (!retainedHypothesis && !statedMissingEvidence)
        add(
          path,
          "REVIEW_DISPOSITION_MISMATCH",
          "Unverified previous findings need a retained current hypothesis or an evidence-linked limitation explaining the missing proof.",
        );
    }
  }
  for (const finding of expected.values())
    if (!seen.has(finding.id))
      add(
        "/candidates",
        "MISSING_REVIEW_BASELINE_FINDING",
        "Every frozen baseline finding must retain its own review candidate.",
      );
  return { valid: errors.length === 0, errors };
}

function validateReviewBaselineBinding(input: {
  baseline: InvestigationReviewBaselineDescriptor;
  taskId: string;
  reportId?: string;
  taskKind: InvestigationTaskKind;
  repositoryId: string;
  workItemId: string;
  workItemKind: InvestigationWorkItem["kind"];
  parentTaskId: string | null;
  parentReportRef: InvestigationReportRef | null;
  primarySubject: InvestigationSubjectV1 | undefined;
  subjects: readonly InvestigationSubjectV1[];
}): InvestigationSemanticIssue[] {
  const errors = validateInvestigationReviewBaselineDescriptor(input.baseline).errors.map(
    (issue) => ({ ...issue, path: `/reviewBaseline${issue.path}` }),
  );
  if (
    input.taskKind !== "pr-review" ||
    input.workItemKind !== "pull_request" ||
    input.parentTaskId !== null ||
    input.parentReportRef !== null ||
    input.primarySubject?.kind !== "original_pr" ||
    input.baseline.sourceTaskId === input.taskId ||
    input.baseline.reportRef.id === input.reportId ||
    input.baseline.subject.repositoryId !== input.repositoryId ||
    input.baseline.subject.workItemId !== input.workItemId ||
    input.subjects.some((subject) => subject.id !== input.primarySubject?.id) ||
    (input.baseline.subject.id === input.primarySubject.id &&
      investigationCanonicalJson(input.baseline.subject) !==
        investigationCanonicalJson(input.primarySubject))
  )
    errors.push({
      path: "/reviewBaseline",
      code: "REVIEW_BASELINE_SCOPE_MISMATCH",
      message:
        "A review baseline is an earlier native review of the same PR, while the new root task retains only its current original PR source.",
    });
  return errors;
}

/** Rejects malformed or misbound trusted provenance, including corrupted persisted report data. */
export function validateInvestigationSourceProvenance(
  provenance: unknown,
  binding: { readonly subjectRef: string; readonly subjects: readonly InvestigationSubjectV1[] },
): InvestigationSemanticValidation {
  const errors: InvestigationSemanticIssue[] = [];
  const add = (path: string, code: string, message: string) => {
    errors.push({ path, code, message });
  };
  try {
    if (!Value.Check(InvestigationSourceProvenanceSchema, provenance)) {
      add(
        Value.Errors(InvestigationSourceProvenanceSchema, provenance).First()?.path ?? "",
        "INVALID_SOURCE_PROVENANCE",
        "Source provenance must contain a bounded dependency graph with complete immutable pins.",
      );
      return { valid: false, errors };
    }
    const subjects = binding.subjects.filter((subject) => subject.id === binding.subjectRef);
    const subject =
      subjects.length === 1 && Value.Check(InvestigationSubjectV1Schema, subjects[0])
        ? subjects[0]
        : undefined;
    if (provenance.subjectRef !== binding.subjectRef || subject === undefined)
      add(
        "/subjectRef",
        "SOURCE_PROVENANCE_SUBJECT_MISMATCH",
        "Source provenance must identify the task's unique primary subject.",
      );
    const expectedSha =
      subject?.kind === "source_commit"
        ? subject.commitSha
        : subject?.kind === "original_pr" || subject?.kind === "remote_branch"
          ? subject.headSha
          : subject?.kind === "local_patch"
            ? subject.baseSha
            : null;
    if (provenance.sourceSha !== expectedSha)
      add(
        "/sourceSha",
        "SOURCE_PROVENANCE_REVISION_MISMATCH",
        "Source provenance must preserve the primary subject's exact materialized source commit.",
      );
    if (subject?.kind === "local_patch") {
      const bases = binding.subjects.filter((entry) => entry.id === subject.baseSubjectRef);
      const base =
        bases.length === 1 && Value.Check(InvestigationSubjectV1Schema, bases[0])
          ? bases[0]
          : undefined;
      const baseSha =
        base?.kind === "source_commit"
          ? base.commitSha
          : base?.kind === "original_pr" || base?.kind === "remote_branch"
            ? base.headSha
            : null;
      if (
        base?.repositoryId !== subject.repositoryId ||
        base?.workItemId !== subject.workItemId ||
        baseSha !== subject.baseSha
      )
        add(
          "/sourceSha",
          "SOURCE_PROVENANCE_BASE_MISMATCH",
          "A local patch must preserve one frozen source base subject from the same repository and work item at its exact baseSha.",
        );
    }
    const modules = new Map<string, InvestigationSourceProvenance["submodules"][number]>();
    const paths: { components: string[]; folded: string[] }[] = [];
    for (const [index, entry] of provenance.submodules.entries()) {
      const path = `/submodules/${index}`;
      const validPath = isCanonicalSourceProvenancePath(entry.path);
      if (!validPath)
        add(
          `${path}/path`,
          "SOURCE_PROVENANCE_PATH_INVALID",
          "Dependency paths must be canonical relative Windows paths outside Git control metadata.",
        );
      if (entry.parentPath !== null && !isCanonicalSourceProvenancePath(entry.parentPath))
        add(
          `${path}/parentPath`,
          "SOURCE_PROVENANCE_PATH_INVALID",
          "Parent paths must use the same canonical source-relative representation.",
        );
      if (
        entry.repository
          .split("/")
          .some((part) => part.endsWith(".") || part.toLowerCase().endsWith(".git"))
      )
        add(
          `${path}/repository`,
          "SOURCE_PROVENANCE_REPOSITORY_INVALID",
          "Dependency repositories must use canonical owner/repository names without URL or Git suffixes.",
        );
      if (!validPath) continue;
      const key = entry.path.toLowerCase();
      if (modules.has(key))
        add(
          `${path}/path`,
          "SOURCE_PROVENANCE_DUPLICATE_PATH",
          "Each mounted dependency path must be unique, including case-insensitive aliases.",
        );
      modules.set(key, entry);
      const components = entry.path.split("/");
      const folded = components.map((component) => component.toLowerCase());
      // Compare bounded component lists without retaining every expanding path prefix.
      if (
        paths.some((prior) => {
          const length = Math.min(components.length, prior.components.length);
          for (let component = 0; component < length; component++) {
            if (folded[component] !== prior.folded[component]) break;
            if (components[component] !== prior.components[component]) return true;
          }
          return false;
        })
      )
        add(
          `${path}/path`,
          "SOURCE_PROVENANCE_PATH_ALIAS",
          "Dependency paths must preserve one exact spelling for every shared directory prefix.",
        );
      paths.push({ components, folded });
    }
    for (const [index, entry] of provenance.submodules.entries()) {
      if (!isCanonicalSourceProvenancePath(entry.path)) continue;
      const parent = [...modules.values()]
        .filter((candidate) =>
          entry.path.toLowerCase().startsWith(`${candidate.path.toLowerCase()}/`),
        )
        .sort((left, right) => right.path.length - left.path.length)[0];
      if (
        entry.parentPath !== (parent?.path ?? null) ||
        entry.parentCommitSha !== (parent?.commitSha ?? provenance.sourceSha)
      )
        add(
          `/submodules/${index}/parentPath`,
          "SOURCE_PROVENANCE_PARENT_MISMATCH",
          "Each dependency must name its nearest mounted parent and that parent's exact commit; root dependencies bind to sourceSha.",
        );
    }
  } catch {
    add(
      "",
      "INVALID_SOURCE_PROVENANCE",
      "Source provenance could not be safely read as an immutable dependency graph.",
    );
  }
  return { valid: errors.length === 0, errors };
}

function isCanonicalSourceProvenancePath(value: string): boolean {
  if (value.length === 0 || value.length > 4_096 || value.includes("\\")) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127 || '<>:"|?*'.includes(value[index]!)) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return value.split("/").every((part) => {
    if (
      part === "" ||
      part === "." ||
      part === ".." ||
      part.toLowerCase() === ".git" ||
      /[. ]$/u.test(part)
    )
      return false;
    return !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9]|LPT[1-9])$/u.test(
      part.split(".", 1)[0]!.toUpperCase(),
    );
  });
}

/** Validates accepted model history without inventing identities for unrecorded rounds. */
export function validateInvestigationModelExecutions(
  executions: readonly InvestigationModelExecution[],
  adoptedAttemptIds: readonly string[],
  completedRounds: number,
): InvestigationSemanticValidation {
  const errors: InvestigationSemanticIssue[] = [];
  const add = (path: string, code: string, message: string) => {
    errors.push({ path, code, message });
  };
  if (executions.length > completedRounds)
    add(
      "/modelExecutions",
      "MODEL_EXECUTION_COUNT_EXCEEDED",
      "Model execution records cannot outnumber accepted analysis rounds.",
    );
  const rounds = new Set<number>();
  for (const [index, execution] of executions.entries()) {
    const path = `/modelExecutions/${index}`;
    if (!adoptedAttemptIds.includes(execution.attemptId))
      add(
        `${path}/attemptId`,
        "MODEL_EXECUTION_ATTEMPT_MISMATCH",
        "Model execution must belong to an adopted task attempt.",
      );
    if (
      !Number.isSafeInteger(execution.round) ||
      execution.round < 1 ||
      execution.round > completedRounds
    )
      add(
        `${path}/round`,
        "MODEL_EXECUTION_ROUND_MISMATCH",
        "Model execution must identify an accepted analysis round.",
      );
    if (rounds.has(execution.round))
      add(
        `${path}/round`,
        "DUPLICATE_MODEL_EXECUTION_ROUND",
        "Each accepted analysis round can have only one model execution record.",
      );
    rounds.add(execution.round);
    if (
      (execution.engine !== "codex" && execution.engine !== "copilot") ||
      (execution.model !== null &&
        (typeof execution.model !== "string" ||
          execution.model.length > 256 ||
          !/\S/u.test(execution.model) ||
          [...execution.model].some((character) => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
          })))
    )
      add(
        path,
        "INVALID_MODEL_IDENTITY",
        "Model identity must preserve a supported CLI engine and its explicit nonempty model selection, or null.",
      );
  }
  return { valid: errors.length === 0, errors };
}

/** Checks relationships after structural schema validation. Persistence and external-state checks remain server responsibilities. */
export function validateInvestigationResult(
  result: InvestigationResultV1,
): InvestigationSemanticValidation {
  const errors: InvestigationSemanticIssue[] = [];
  const add = (path: string, code: string, message: string) => {
    errors.push({ path, code, message });
  };
  const unique = <T extends { id: string }>(values: T[], path: string): Map<string, T> => {
    const map = new Map<string, T>();
    values.forEach((value, index) => {
      if (map.has(value.id))
        add(`${path}/${index}/id`, "DUPLICATE_ID", `Duplicate ID ${value.id}.`);
      map.set(value.id, value);
    });
    return map;
  };
  const sameIds = (actual: string[], expected: string[]) => {
    const entries = new Set(actual);
    return (
      actual.length === expected.length &&
      entries.size === actual.length &&
      expected.every((id) => entries.has(id))
    );
  };
  const subjects = unique(result.context.subjects, "/context/subjects");
  if (result.context.reviewBaseline !== undefined)
    errors.push(
      ...validateReviewBaselineBinding({
        baseline: result.context.reviewBaseline,
        taskId: result.context.task.id,
        reportId: result.id,
        taskKind: result.context.task.kind,
        repositoryId: result.context.repository.id,
        workItemId: result.context.workItem.id,
        workItemKind: result.context.workItem.kind,
        parentTaskId: result.context.task.parentTaskId,
        parentReportRef: result.context.parentReportRef,
        primarySubject: subjects.get(result.context.task.subjectRef),
        subjects: result.context.subjects,
      }).map((issue) => ({ ...issue, path: `/context${issue.path}` })),
    );
  if (result.context.sourceProvenance !== undefined)
    errors.push(
      ...validateInvestigationSourceProvenance(result.context.sourceProvenance, {
        subjectRef: result.context.task.subjectRef,
        subjects: result.context.subjects,
      }).errors.map((issue) => ({ ...issue, path: `/context/sourceProvenance${issue.path}` })),
    );
  const findings = unique(result.findings, "/findings");
  const evidence = unique(result.verificationEvidence, "/verificationEvidence");
  const artifacts = unique(result.artifacts, "/artifacts");
  const e2e = result.context.e2e;
  const e2eSubject = subjects.get(result.context.task.subjectRef);
  if (e2e !== undefined) {
    for (const message of validateInvestigationE2eBindings({
      e2e,
      taskId: result.context.task.id,
      taskKind: result.context.task.kind,
      subjectRef: result.context.task.subjectRef,
      headSha: e2eSubject?.kind === "original_pr" ? e2eSubject.headSha : null,
      completed: result.outcome === "completed",
      artifacts: result.artifacts,
      evidence: result.verificationEvidence,
    }))
      add("/context/e2e", "INVALID_E2E_EVIDENCE", message);
  } else if (result.context.task.kind === "pr-e2e" && result.outcome === "completed")
    add(
      "/context/e2e",
      "E2E_RESULT_REQUIRED",
      "Completed E2E tasks require their feature assertions and media evidence.",
    );
  const sourceArtifacts = unique(result.context.sourceArtifacts ?? [], "/context/sourceArtifacts");
  errors.push(
    ...validateSourceArtifactBindings({
      taskId: result.context.task.id,
      parentTaskId: result.context.task.parentTaskId,
      parentReportRef: result.context.parentReportRef,
      subjects: result.context.subjects,
      sourceArtifacts: result.context.sourceArtifacts ?? [],
      path: "/context/sourceArtifacts",
    }),
  );
  for (const id of sourceArtifacts.keys())
    if (artifacts.has(id))
      add(
        "/artifacts",
        "SOURCE_ARTIFACT_ID_CONFLICT",
        "An inherited source artifact cannot be republished as current task evidence.",
      );
  const plans = unique(result.plans, "/plans");
  const actions = unique(result.nextActions, "/nextActions");
  const candidates = unique(result.report.loop.candidates, "/report/loop/candidates");
  const rechecks = unique(result.report.recheck.records, "/report/recheck/records");
  const units = unique(result.report.coverage.includedUnits, "/report/coverage/includedUnits");
  unique(result.report.coverage.exclusions, "/report/coverage/exclusions");
  unique(result.diagnostics, "/diagnostics");
  unique(result.report.limitations, "/report/limitations");
  unique(result.validation.checks, "/validation/checks");
  const drafts = unique(result.feedbackDrafts, "/feedbackDrafts");
  for (const finding of result.findings) {
    const previous = drafts.get(finding.feedbackDraft.id);
    if (
      previous &&
      investigationCanonicalJson(previous) !== investigationCanonicalJson(finding.feedbackDraft)
    )
      add(
        `/findings/${finding.id}/feedbackDraft`,
        "DRAFT_CONTENT_CONFLICT",
        "A reused feedback draft ID must have exactly the same content.",
      );
    drafts.set(finding.feedbackDraft.id, finding.feedbackDraft);
  }
  const prerequisites = new Set(
    result.plans.flatMap((plan) => plan.prerequisites.map((prerequisite) => prerequisite.id)),
  );
  const adoptedAttempts = new Set(result.context.adoptedAttemptIds);
  errors.push(
    ...validateInvestigationModelExecutions(
      result.context.modelExecutions ?? [],
      result.context.adoptedAttemptIds,
      result.report.loop.completedRounds,
    ).errors.map((issue) => ({ ...issue, path: `/context${issue.path}` })),
  );
  const subject = (id: string, path: string) => {
    const value = subjects.get(id);
    if (!value) add(path, "UNKNOWN_SUBJECT", `Subject ${id} is not part of this result.`);
    return value;
  };
  const evidenceRefs = (refs: string[], subjectRef: string | null, path: string) => {
    refs.forEach((id, index) => {
      const item = evidence.get(id);
      if (!item)
        add(`${path}/${index}`, "UNKNOWN_EVIDENCE", `Evidence ${id} has not been registered.`);
      else if (subjectRef !== null && item.subjectRef !== subjectRef)
        add(
          `${path}/${index}`,
          "EVIDENCE_SUBJECT_MISMATCH",
          "Evidence belongs to a different subject; local patch and original results cannot be combined.",
        );
    });
  };
  const planRef = (
    ref: Static<typeof InvestigationVersionRefSchema> | null,
    subjectRef: string,
    path: string,
  ) => {
    if (ref === null) return undefined;
    const plan = plans.get(ref.id);
    if (!plan || plan.version !== ref.version || plan.digest !== ref.digest)
      add(
        path,
        "INVALID_PLAN_REFERENCE",
        "The referenced exact plan version and digest have not been saved in this report.",
      );
    else if (plan.subjectRef !== subjectRef) {
      const target = subjects.get(subjectRef);
      const planned = subjects.get(plan.subjectRef);
      const parent = result.context.parentReportRef;
      const explicitIssueVerificationSource =
        ["issue-verify", "reproduction-setup", "issue-fix", "feature-implement"].includes(
          result.context.task.kind,
        ) &&
        result.context.task.subjectRef === subjectRef &&
        target?.kind === "source_commit" &&
        planned?.kind === "issue_snapshot" &&
        parent !== null &&
        plan.sourceReportRef.id === parent.id &&
        plan.sourceReportRef.version === parent.version;
      if (!explicitIssueVerificationSource)
        add(
          path,
          "PLAN_SUBJECT_MISMATCH",
          "The saved plan belongs to a different subject without an explicit Issue verification source binding.",
        );
    }
    return plan;
  };
  const prerequisiteRefs = (refs: string[], path: string) =>
    refs.forEach((id, index) => {
      if (!prerequisites.has(id))
        add(
          `${path}/${index}`,
          "UNKNOWN_PREREQUISITE",
          `Prerequisite ${id} is not declared by a saved plan.`,
        );
    });
  const reportSource = (ref: { id: string; version: number }, path: string) => {
    if (ref.id !== result.report.id || ref.version !== result.report.version)
      add(
        path,
        "REPORT_SOURCE_MISMATCH",
        "Saved content must bind to the containing report ID and version.",
      );
  };

  if (result.id !== result.report.id || result.version !== result.report.version)
    add("/report", "REPORT_IDENTITY_MISMATCH", "The result and report identities must match.");
  if (!adoptedAttempts.has(result.context.attempt.id))
    add(
      "/context/adoptedAttemptIds",
      "CURRENT_ATTEMPT_NOT_ADOPTED",
      "The result must include its current attempt among its adopted evidence sources.",
    );
  subject(result.context.task.subjectRef, "/context/task/subjectRef");
  for (const [id, item] of subjects) {
    if (
      item.repositoryId !== result.context.repository.id ||
      item.workItemId !== result.context.workItem.id
    )
      add(
        `/context/subjects/${id}`,
        "SUBJECT_SCOPE_MISMATCH",
        "Subject ownership must match the result repository and work item.",
      );
    if (item.kind === "local_patch") {
      const base = subject(item.baseSubjectRef, `/context/subjects/${id}/baseSubjectRef`);
      if (
        base?.kind === "issue_snapshot" ||
        base?.kind === "local_patch" ||
        item.baseSubjectRef === id
      )
        add(
          `/context/subjects/${id}`,
          "INVALID_PATCH_BASE",
          "A local patch must reference a distinct, immutable source subject.",
        );
      const baseSha =
        base?.kind === "original_pr" || base?.kind === "remote_branch"
          ? base.headSha
          : base?.kind === "source_commit"
            ? base.commitSha
            : undefined;
      if (baseSha !== item.baseSha)
        add(
          `/context/subjects/${id}/baseSha`,
          "PATCH_BASE_SHA_MISMATCH",
          "The patch base SHA must match the referenced source subject.",
        );
      const artifact = artifacts.get(item.artifactRef) ?? sourceArtifacts.get(item.artifactRef);
      if (
        !artifact ||
        artifact.kind !== "patch" ||
        artifact.subjectRef !== id ||
        artifact.digest !== item.patchDigest
      )
        add(
          `/context/subjects/${id}/artifactRef`,
          "INVALID_PATCH_ARTIFACT",
          "The patch must bind to an existing patch artifact with the same subject and digest.",
        );
    }
    if (item.kind === "remote_branch") {
      const record = evidence.get(item.verifiedEvidenceRef);
      if (
        !record ||
        record.authority === "model" ||
        record.subjectRef !== id ||
        record.source !== "upstream_reference"
      )
        add(
          `/context/subjects/${id}/verifiedEvidenceRef`,
          "UNVERIFIED_REMOTE_BRANCH",
          "An existing branch needs trusted upstream evidence for this subject.",
        );
    }
  }
  result.artifacts.forEach((artifact, index) => {
    subject(artifact.subjectRef, `/artifacts/${index}/subjectRef`);
    if (artifact.taskId !== result.context.task.id || !adoptedAttempts.has(artifact.attemptId))
      add(
        `/artifacts/${index}`,
        "ARTIFACT_SCOPE_MISMATCH",
        "Artifacts must originate in this task and an adopted attempt.",
      );
  });
  result.verificationEvidence.forEach((item, index) => {
    const path = `/verificationEvidence/${index}`;
    subject(item.subjectRef, `${path}/subjectRef`);
    evidenceRefs(item.evidenceRefs, item.subjectRef, `${path}/evidenceRefs`);
    if (item.evidenceRefs.includes(item.id))
      add(
        `${path}/evidenceRefs`,
        "EVIDENCE_SELF_REFERENCE",
        "Evidence cannot substantiate itself.",
      );
    if (
      item.provenance.taskId !== result.context.task.id ||
      !adoptedAttempts.has(item.provenance.attemptId)
    )
      add(
        `${path}/provenance`,
        "EVIDENCE_SCOPE_MISMATCH",
        "Evidence provenance must belong to this task and an adopted attempt.",
      );
    if (
      item.authority === "model" &&
      item.source !== "static_analysis" &&
      item.source !== "reporter_statement"
    )
      add(
        `${path}/authority`,
        "MODEL_AUTHORITY_FORGERY",
        "Model evidence cannot claim an executor, visual, source, or upstream observation.",
      );
    if (
      (item.source === "executor_observation" || item.source === "visual_observation") &&
      item.artifactRefs.length === 0
    )
      add(
        `${path}/artifactRefs`,
        "OBSERVATION_ARTIFACT_REQUIRED",
        "Runtime observations must retain an evidence artifact.",
      );
    item.artifactRefs.forEach((ref) => {
      const artifact = artifacts.get(ref);
      if (!artifact || artifact.subjectRef !== item.subjectRef)
        add(
          `${path}/artifactRefs`,
          "INVALID_EVIDENCE_ARTIFACT",
          "Referenced artifacts must exist and belong to the observed subject.",
        );
    });
  });
  const incomingEvidenceRefs = new Map([...evidence.keys()].map((id) => [id, 0]));
  for (const item of evidence.values())
    for (const ref of item.evidenceRefs) {
      if (incomingEvidenceRefs.has(ref))
        incomingEvidenceRefs.set(ref, (incomingEvidenceRefs.get(ref) ?? 0) + 1);
    }
  const evidenceQueue = [...incomingEvidenceRefs]
    .filter(([, count]) => count === 0)
    .map(([id]) => id);
  for (let index = 0; index < evidenceQueue.length; index += 1) {
    for (const ref of evidence.get(evidenceQueue[index]!)?.evidenceRefs ?? []) {
      const count = incomingEvidenceRefs.get(ref);
      if (count === undefined) continue;
      incomingEvidenceRefs.set(ref, count - 1);
      if (count === 1) evidenceQueue.push(ref);
    }
  }
  if (evidenceQueue.length !== evidence.size)
    add(
      "/verificationEvidence",
      "EVIDENCE_REFERENCE_CYCLE",
      "Evidence provenance must not contain a circular justification.",
    );
  result.plans.forEach((plan, index) => {
    subject(plan.subjectRef, `/plans/${index}/subjectRef`);
    const parent = result.context.parentReportRef;
    if (
      !parent ||
      plan.sourceReportRef.id !== parent.id ||
      plan.sourceReportRef.version !== parent.version
    )
      reportSource(plan.sourceReportRef, `/plans/${index}/sourceReportRef`);
    unique(plan.steps, `/plans/${index}/steps`);
    unique(plan.prerequisites, `/plans/${index}/prerequisites`);
    plan.steps.forEach((step, stepIndex) => {
      if (step.recipe === undefined) return;
      const path = `/plans/${index}/steps/${stepIndex}/recipe`;
      if (plan.kind !== "verification")
        add(path, "RECIPE_PLAN_KIND_INVALID", "Bundled UI recipes require a verification plan.");
      for (const message of getInvestigationRecipeStepIssues(step.recipe, step.checkIds))
        add(path, "RECIPE_CHECK_BINDING_INVALID", message);
    });
  });
  for (const [id, unit] of units) {
    subject(unit.subjectRef, `/report/coverage/includedUnits/${id}/subjectRef`);
    evidenceRefs(
      unit.evidenceRefs,
      unit.subjectRef,
      `/report/coverage/includedUnits/${id}/evidenceRefs`,
    );
  }
  result.report.coverage.exclusions.forEach((exclusion, index) => {
    subject(exclusion.subjectRef, `/report/coverage/exclusions/${index}/subjectRef`);
  });
  const completedUnitRefs = [...units.values()]
    .filter((unit) => unit.status === "completed")
    .map((unit) => unit.id);
  const unresolvedUnitRefs = [...units.values()]
    .filter((unit) => unit.status !== "completed")
    .map((unit) => unit.id);
  if (
    !sameIds(result.report.coverage.completedUnitRefs, completedUnitRefs) ||
    !sameIds(result.report.coverage.unresolvedUnitRefs, unresolvedUnitRefs)
  )
    add(
      "/report/coverage",
      "COVERAGE_PARTITION_MISMATCH",
      "Completed and unresolved references must exactly partition all included coverage units.",
    );

  result.findings.forEach((finding, index) => {
    const path = `/findings/${index}`;
    subject(finding.subjectRef, `${path}/subjectRef`);
    if (finding.trigger.conditions.length === 0 && finding.trigger.steps.length === 0)
      add(
        `${path}/trigger`,
        "FINDING_TRIGGER_REQUIRED",
        "A finding must describe its triggering conditions or reproduction steps.",
      );
    if (finding.ordinal !== index)
      add(
        `${path}/ordinal`,
        "FINDING_ORDER_MISMATCH",
        "Finding ordinals must be contiguous and match the full logical result order.",
      );
    evidenceRefs(finding.evidenceRefs, finding.subjectRef, `${path}/evidenceRefs`);
    evidenceRefs(
      finding.rootCause.evidenceRefs,
      finding.subjectRef,
      `${path}/rootCause/evidenceRefs`,
    );
    evidenceRefs(
      finding.confirmation.evidenceRefs,
      finding.subjectRef,
      `${path}/confirmation/evidenceRefs`,
    );
    if (finding.evidenceRefs.length === 0 || finding.confirmation.evidenceRefs.length === 0)
      add(
        path,
        "FINDING_EVIDENCE_REQUIRED",
        "Every retained finding needs evidence supporting its stated confirmation status.",
      );
    if (finding.rootCause.status === "established" && finding.rootCause.evidenceRefs.length === 0)
      add(
        `${path}/rootCause`,
        "ROOT_CAUSE_EVIDENCE_REQUIRED",
        "An established root cause requires evidence.",
      );
    planRef(
      finding.fixRecommendation.planRef,
      finding.subjectRef,
      `${path}/fixRecommendation/planRef`,
    );
    finding.locations.forEach((location, locationIndex) => {
      if (location.subjectRef !== finding.subjectRef)
        add(
          `${path}/locations/${locationIndex}`,
          "LOCATION_SUBJECT_MISMATCH",
          "A finding location must describe the finding subject.",
        );
      if (
        location.kind === "source" &&
        (location.startLine > location.endLine ||
          /^(?:[A-Za-z]:|[/\\])|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(location.path))
      )
        add(
          `${path}/locations/${locationIndex}`,
          "INVALID_SOURCE_LOCATION",
          "Source ranges must be ordered and paths must remain repository-relative.",
        );
    });
    const suggestion = finding.feedbackDraft.suggestion;
    if (suggestion !== null) {
      const target = subjects.get(suggestion.subjectRef);
      const sha =
        target?.kind === "original_pr" || target?.kind === "remote_branch"
          ? target.headSha
          : target?.kind === "source_commit"
            ? target.commitSha
            : target?.kind === "local_patch"
              ? target.baseSha
              : undefined;
      if (
        suggestion.subjectRef !== finding.subjectRef ||
        sha !== suggestion.headSha ||
        suggestion.startLine > suggestion.endLine ||
        /^(?:[A-Za-z]:|[/\\])|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(suggestion.path)
      )
        add(
          `${path}/feedbackDraft/suggestion`,
          "INVALID_SUGGESTION_BINDING",
          "Suggestions need an exact source subject, head SHA, repository-relative path, and ordered range.",
        );
    }
  });
  result.report.recheck.records.forEach((record, index) => {
    const finding = findings.get(record.findingId);
    if (
      !finding ||
      finding.subjectRef !== record.subjectRef ||
      record.findingVersion > finding.version
    )
      add(
        `/report/recheck/records/${index}`,
        "INVALID_RECHECK_BINDING",
        "A recheck must bind to an existing finding version and subject.",
      );
    if (record.round > result.report.loop.completedRounds)
      add(
        `/report/recheck/records/${index}/round`,
        "FUTURE_RECHECK",
        "A recheck cannot originate in a round that has not completed.",
      );
    evidenceRefs(
      record.evidenceRefs,
      record.subjectRef,
      `/report/recheck/records/${index}/evidenceRefs`,
    );
  });
  const pendingFindings: string[] = [];
  for (const finding of result.findings) {
    const record = finding.confirmation.recheckRef
      ? rechecks.get(finding.confirmation.recheckRef)
      : undefined;
    if (
      !record ||
      record.findingId !== finding.id ||
      record.findingVersion !== finding.version ||
      record.subjectRef !== finding.subjectRef ||
      record.evidenceRefs.length === 0
    )
      pendingFindings.push(finding.id);
  }
  if (
    result.report.recheck.finalFindingCount !== findings.size ||
    result.report.recheck.validFinalVersionRecheckCount !==
      findings.size - pendingFindings.length ||
    !sameIds(result.report.recheck.pendingFindingIds, pendingFindings)
  )
    add(
      "/report/recheck",
      "RECHECK_COUNT_MISMATCH",
      "Final finding counts and pending IDs must reflect valid rechecks for the current finding versions.",
    );
  result.report.loop.candidates.forEach((candidate, index) => {
    const path = `/report/loop/candidates/${index}`;
    subject(candidate.subjectRef, `${path}/subjectRef`);
    evidenceRefs(candidate.evidenceRefs, candidate.subjectRef, `${path}/evidenceRefs`);
    if (
      (candidate.status === "withdrawn" || candidate.status === "merged") &&
      candidate.evidenceRefs.length === 0
    )
      add(
        `${path}/evidenceRefs`,
        "CANDIDATE_DISPOSITION_EVIDENCE_REQUIRED",
        "Withdrawing or merging a candidate requires recorded evidence for its disposition.",
      );
    if (candidate.discoveredRound > result.report.loop.completedRounds)
      add(
        `${path}/discoveredRound`,
        "FUTURE_CANDIDATE",
        "A candidate cannot originate after the accepted rounds.",
      );
    if (candidate.status === "confirmed" || candidate.status === "unresolved") {
      const finding = candidate.findingId ? findings.get(candidate.findingId) : undefined;
      if (
        !finding ||
        candidate.findingVersion !== finding.version ||
        candidate.subjectRef !== finding.subjectRef ||
        finding.confirmation.status !==
          (candidate.status === "confirmed" ? "confirmed" : "hypothesis")
      )
        add(
          path,
          "CANDIDATE_FINDING_MISMATCH",
          "Retained candidates must bind to the corresponding final finding version and confirmation status.",
        );
      if (finding?.confirmation.recheckRef) {
        const record = rechecks.get(finding.confirmation.recheckRef);
        if (record && record.round < candidate.discoveredRound)
          add(
            path,
            "RECHECK_BEFORE_DISCOVERY",
            "A finding cannot be rechecked before its candidate was discovered.",
          );
      }
    } else if (candidate.findingId !== null || candidate.findingVersion !== null)
      add(
        path,
        "UNRETAINED_CANDIDATE_HAS_FINDING",
        "Pending, withdrawn, and merged candidates must not masquerade as retained findings.",
      );
    if (candidate.status === "merged") {
      if (!candidate.mergedIntoCandidateId || !candidates.has(candidate.mergedIntoCandidateId))
        add(
          `${path}/mergedIntoCandidateId`,
          "INVALID_MERGE_TARGET",
          "A merged candidate must identify an existing candidate.",
        );
    } else if (candidate.mergedIntoCandidateId !== null)
      add(path, "UNEXPECTED_MERGE_TARGET", "Only merged candidates may declare a merge target.");
  });
  const currentReviewSubject = subjects.get(result.context.task.subjectRef);
  errors.push(
    ...validateInvestigationReviewBaselineCandidates({
      ...(result.context.reviewBaseline === undefined
        ? {}
        : { baseline: result.context.reviewBaseline }),
      subjectRef: result.context.task.subjectRef,
      headSha: currentReviewSubject?.kind === "original_pr" ? currentReviewSubject.headSha : null,
      candidates: result.report.loop.candidates,
      findings: result.findings,
      evidence: result.verificationEvidence,
      limitations: result.report.limitations,
      complete: result.report.completeness === "complete",
    }).errors.map((issue) => ({ ...issue, path: `/report/loop${issue.path}` })),
  );
  const incomingMerges = new Map([...candidates.keys()].map((id) => [id, 0]));
  for (const candidate of candidates.values()) {
    const ref = candidate.status === "merged" ? candidate.mergedIntoCandidateId : null;
    if (ref !== null && incomingMerges.has(ref))
      incomingMerges.set(ref, (incomingMerges.get(ref) ?? 0) + 1);
  }
  const mergeQueue = [...incomingMerges].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < mergeQueue.length; index += 1) {
    const candidate = candidates.get(mergeQueue[index]!);
    const ref = candidate?.status === "merged" ? candidate.mergedIntoCandidateId : null;
    if (ref === null) continue;
    const count = incomingMerges.get(ref);
    if (count === undefined) continue;
    incomingMerges.set(ref, count - 1);
    if (count === 1) mergeQueue.push(ref);
  }
  if (mergeQueue.length !== candidates.size)
    add(
      "/report/loop/candidates",
      "CANDIDATE_MERGE_CYCLE",
      "Merged candidate references must not contain a cycle.",
    );
  const retainedCandidateFindings = new Set(
    result.report.loop.candidates
      .filter((candidate) => candidate.status === "confirmed" || candidate.status === "unresolved")
      .map((candidate) => candidate.findingId),
  );
  for (const finding of result.findings) {
    if (!retainedCandidateFindings.has(finding.id))
      add(
        `/findings/${finding.id}`,
        "FINDING_CANDIDATE_MISSING",
        "Every retained finding must preserve its candidate history.",
      );
  }
  const counts = result.report.collections;
  const actualCounts = {
    findings: result.findings.length,
    verificationEvidence: result.verificationEvidence.length,
    artifacts: result.artifacts.length,
    plans: result.plans.length,
    nextActions: result.nextActions.length,
    candidates: result.report.loop.candidates.length,
    rechecks: result.report.recheck.records.length,
  };
  for (const key of Object.keys(actualCounts) as (keyof typeof actualCounts)[]) {
    if (counts[key] !== actualCounts[key])
      add(
        `/report/collections/${key}`,
        "COLLECTION_COUNT_MISMATCH",
        "Collection counts must represent every persisted item.",
      );
  }
  if (result.report.loop.completedRounds !== result.report.loop.consumed.rounds)
    add("/report/loop", "ROUND_COUNT_MISMATCH", "Consumed and completed round counts must agree.");
  result.nextActions.forEach((action, index) => {
    const path = `/nextActions/${index}`;
    subject(action.subjectRef, `${path}/subjectRef`);
    reportSource(action.sourceReportRef, `${path}/sourceReportRef`);
    const savedPlan = planRef(action.planRef, action.subjectRef, `${path}/planRef`);
    prerequisiteRefs(action.prerequisiteRefs, `${path}/prerequisiteRefs`);
    if (action.draftRef !== null && !drafts.has(action.draftRef))
      add(
        `${path}/draftRef`,
        "UNKNOWN_DRAFT",
        "The feedback draft must exist in the saved report.",
      );
    if (action.action === "start-task" || action.action === "reviews.verify") {
      if (!savedPlan || action.taskKind === null)
        add(
          path,
          "TASK_ACTION_PLAN_REQUIRED",
          "Task actions need an exact saved plan and a task kind.",
        );
      const expectedKind =
        action.taskKind === "pr-verify" || action.taskKind === "issue-verify"
          ? "verification"
          : action.taskKind === "reproduction-setup"
            ? "reproduction"
            : action.taskKind === "issue-fix"
              ? "fix"
              : action.taskKind === "feature-implement"
                ? "implementation"
                : "investigation";
      if (savedPlan && savedPlan.kind !== expectedKind)
        add(
          path,
          "ACTION_PLAN_KIND_MISMATCH",
          "The saved plan kind must match the requested task.",
        );
      if (
        action.action === "reviews.verify" &&
        (action.taskKind !== "pr-verify" || subjects.get(action.subjectRef)?.kind !== "original_pr")
      )
        add(
          path,
          "INVALID_LINKED_PR_VERIFICATION",
          "Linked PR verification must preserve the original PR subject and use pr-verify.",
        );
    } else if (action.taskKind !== null)
      add(`${path}/taskKind`, "UNEXPECTED_TASK_KIND", "Only task actions may propose a task kind.");
    if (
      (action.action === "comment" ||
        action.action === "suggestion-comment" ||
        action.action === "request-changes") &&
      action.draftRef === null
    )
      add(path, "FEEDBACK_DRAFT_REQUIRED", "Saved feedback actions must reference a saved draft.");
    if (
      action.action === "suggestion-comment" &&
      action.draftRef !== null &&
      !drafts.get(action.draftRef)?.suggestion
    )
      add(
        path,
        "SUGGESTION_REQUIRED",
        "A suggestion action requires a saved replacement suggestion.",
      );
    if (action.action === "view-validation" && action.validationReportRef === null)
      add(
        path,
        "VALIDATION_REPORT_REQUIRED",
        "Viewing validation requires an exact linked validation report.",
      );
    if (action.action === "create-pr" && subjects.get(action.subjectRef)?.kind !== "remote_branch")
      add(
        path,
        "REMOTE_BRANCH_REQUIRED",
        "Creating a PR requires a trusted existing remote branch subject.",
      );
  });
  result.diagnostics.forEach((diagnostic, index) => {
    evidenceRefs(diagnostic.evidenceRefs, null, `/diagnostics/${index}/evidenceRefs`);
    prerequisiteRefs(diagnostic.prerequisiteRefs, `/diagnostics/${index}/prerequisiteRefs`);
  });
  result.report.limitations.forEach((limitation, index) => {
    evidenceRefs(limitation.evidenceRefs, null, `/report/limitations/${index}/evidenceRefs`);
  });
  result.validation.checks.forEach((check, index) => {
    const path = `/validation/checks/${index}`;
    subject(check.subjectRef, `${path}/subjectRef`);
    const target = subjects.get(check.subjectRef);
    const referencedPlan = check.planRef === null ? undefined : plans.get(check.planRef.id);
    const parent = result.context.parentReportRef;
    const issuePlanWithExplicitSource =
      target?.kind === "local_patch" &&
      target.baseSubjectRef === result.context.task.subjectRef &&
      subjects.get(target.baseSubjectRef)?.kind === "source_commit" &&
      referencedPlan !== undefined &&
      subjects.get(referencedPlan.subjectRef)?.kind === "issue_snapshot" &&
      parent !== null &&
      referencedPlan.sourceReportRef.id === parent.id &&
      referencedPlan.sourceReportRef.version === parent.version;
    const implementationPatch =
      target?.kind === "local_patch" &&
      referencedPlan !== undefined &&
      (referencedPlan.subjectRef === target.baseSubjectRef || issuePlanWithExplicitSource) &&
      ((result.context.task.kind === "issue-fix" && referencedPlan.kind === "fix") ||
        (result.context.task.kind === "feature-implement" &&
          referencedPlan.kind === "implementation"));
    const savedPlan = planRef(
      check.planRef,
      implementationPatch ? target.baseSubjectRef : check.subjectRef,
      `${path}/planRef`,
    );
    if (savedPlan && !savedPlan.steps.some((step) => step.checkIds.includes(check.id)))
      add(`${path}/id`, "CHECK_OUTSIDE_PLAN", "The check must belong to the exact saved plan.");
    evidenceRefs(check.evidenceRefs, check.subjectRef, `${path}/evidenceRefs`);
    if (check.status === "passed" || check.status === "failed") {
      if (
        !check.executor ||
        !check.authoritativeAttemptId ||
        !adoptedAttempts.has(check.authoritativeAttemptId)
      )
        add(
          path,
          "CHECK_EXECUTOR_REQUIRED",
          "Executed checks require an executor and an adopted authoritative attempt.",
        );
      if (
        !check.evidenceRefs.some((id) => {
          const item = evidence.get(id);
          return (
            item &&
            item.authority !== "model" &&
            (item.source === "executor_observation" || item.source === "visual_observation") &&
            item.provenance.attemptId === check.authoritativeAttemptId
          );
        })
      )
        add(
          path,
          "TRUSTED_CHECK_EVIDENCE_REQUIRED",
          "Executed check results need matching trusted runtime observations.",
        );
    }
  });
  const assessment = result.assessment;
  subject(assessment.subjectRef, "/assessment/subjectRef");
  evidenceRefs(assessment.evidenceRefs, assessment.subjectRef, "/assessment/evidenceRefs");
  if ((assessment.kind === "pr") !== (result.context.workItem.kind === "pull_request"))
    add(
      "/assessment/kind",
      "ASSESSMENT_WORK_ITEM_MISMATCH",
      "PR and Issue assessments must match the work item kind.",
    );
  if (assessment.subjectRef !== result.context.task.subjectRef)
    add(
      "/assessment/subjectRef",
      "ASSESSMENT_TASK_SUBJECT_MISMATCH",
      "The primary assessment must bind to the task subject.",
    );
  if (assessment.kind === "pr") {
    const savedPlan = planRef(
      assessment.e2eAssessment.planRef,
      assessment.subjectRef,
      "/assessment/e2eAssessment/planRef",
    );
    prerequisiteRefs(
      assessment.e2eAssessment.prerequisiteRefs,
      "/assessment/e2eAssessment/prerequisiteRefs",
    );
    if (savedPlan?.steps.some((step) => step.recipe !== undefined)) {
      const scenarios = new Set(
        savedPlan.steps.flatMap(
          (step) => step.recipe?.checks.map((check) => check.scenarioId) ?? [],
        ),
      );
      if (assessment.e2eAssessment.scenarioIds.some((id) => !scenarios.has(id)))
        add(
          "/assessment/e2eAssessment/scenarioIds",
          "RECIPE_SCENARIO_BINDING_INVALID",
          "Every assessed recipe scenario must be represented by saved checks.",
        );
    }
    if (
      result.report.completeness === "complete" &&
      assessment.e2eAssessment.level !== "not_needed" &&
      (!savedPlan || savedPlan.kind !== "verification")
    )
      add(
        "/assessment/e2eAssessment",
        "E2E_PLAN_REQUIRED",
        "Recommended or required E2E work in a completed investigation needs a saved verification plan.",
      );
    if (
      assessment.reviewConclusion.status === "no-blocking-findings" &&
      result.findings.some(
        (finding) =>
          finding.subjectRef === assessment.subjectRef &&
          finding.confirmation.status === "confirmed" &&
          (finding.priority === "P0" || finding.priority === "P1"),
      )
    )
      add(
        "/assessment/reviewConclusion",
        "REVIEW_CONCLUSION_CONFLICT",
        "A no-blocking-findings conclusion conflicts with confirmed P0/P1 findings on its subject.",
      );
  } else if (assessment.kind === "bug") {
    const detail = assessment.bugAssessment;
    const savedPlan = planRef(
      assessment.reproduction.planRef,
      assessment.subjectRef,
      "/assessment/reproduction/planRef",
    );
    evidenceRefs(
      assessment.reproduction.evidenceRefs,
      assessment.subjectRef,
      "/assessment/reproduction/evidenceRefs",
    );
    if (
      detail.status === "needs_verification" &&
      (detail.hypotheses.length === 0 ||
        !savedPlan ||
        !["verification", "reproduction"].includes(savedPlan.kind))
    )
      add(
        "/assessment/bugAssessment",
        "BUG_VERIFICATION_PLAN_REQUIRED",
        "A bug awaiting verification needs hypotheses and a saved experiment plan.",
      );
    if (
      detail.status === "needs_information" &&
      (detail.missingInformation.length === 0 || drafts.size === 0)
    )
      add(
        "/assessment/bugAssessment",
        "BUG_INFORMATION_REQUIRED",
        "Missing reporter facts and a saved inquiry draft must be explicit.",
      );
    if (
      detail.status === "confirmed" &&
      !result.findings.some(
        (finding) =>
          finding.subjectRef === assessment.subjectRef &&
          finding.confirmation.status === "confirmed",
      )
    )
      add(
        "/assessment/bugAssessment",
        "CONFIRMED_BUG_FINDING_REQUIRED",
        "A confirmed bug requires an evidence-backed confirmed finding.",
      );
    if (detail.status === "already_fixed") {
      if (
        !detail.upstreamFix ||
        !detail.upstreamFix.evidenceRefs.some((id) => {
          const item = evidence.get(id);
          return (
            item?.source === "upstream_reference" &&
            item.authority !== "model" &&
            subjects.get(item.subjectRef)?.kind !== "local_patch"
          );
        })
      )
        add(
          "/assessment/bugAssessment/upstreamFix",
          "UPSTREAM_FIX_EVIDENCE_REQUIRED",
          "Already fixed requires trusted upstream evidence; a local patch does not qualify.",
        );
      if (detail.upstreamFix)
        evidenceRefs(
          detail.upstreamFix.evidenceRefs,
          assessment.subjectRef,
          "/assessment/bugAssessment/upstreamFix/evidenceRefs",
        );
    }
    if (detail.status === "duplicate" && !detail.duplicateOf)
      add(
        "/assessment/bugAssessment/duplicateOf",
        "DUPLICATE_REFERENCE_REQUIRED",
        "Duplicate classification requires the original Issue and overlap evidence.",
      );
    if (detail.duplicateOf)
      evidenceRefs(
        detail.duplicateOf.evidenceRefs,
        assessment.subjectRef,
        "/assessment/bugAssessment/duplicateOf/evidenceRefs",
      );
    if (
      detail.status === "not_a_bug" &&
      (!detail.expectedBehavior || assessment.evidenceRefs.length === 0)
    )
      add(
        "/assessment/bugAssessment",
        "EXPECTED_BEHAVIOR_EVIDENCE_REQUIRED",
        "Expected behavior needs an explanation and evidence; failure to reproduce is insufficient.",
      );
    if (
      assessment.reproduction.status === "reproduced" ||
      assessment.reproduction.status === "not_reproduced"
    ) {
      if (
        !assessment.reproduction.evidenceRefs.some((id) => {
          const item = evidence.get(id);
          return (
            item &&
            item.authority !== "model" &&
            (item.source === "executor_observation" || item.source === "visual_observation")
          );
        })
      )
        add(
          "/assessment/reproduction",
          "REPRODUCTION_EVIDENCE_REQUIRED",
          "Reproduction outcomes require trusted runtime observations.",
        );
    }
  } else if (assessment.kind === "feature") {
    const detail = assessment.featureAssessment;
    const savedPlan = planRef(
      detail.implementationPlanRef,
      assessment.subjectRef,
      "/assessment/featureAssessment/implementationPlanRef",
    );
    prerequisiteRefs(detail.prerequisiteRefs, "/assessment/featureAssessment/prerequisiteRefs");
    if (
      detail.status === "ready" &&
      (!savedPlan ||
        savedPlan.kind !== "implementation" ||
        detail.requirements.length === 0 ||
        detail.acceptanceCriteria.length === 0 ||
        assessment.evidenceRefs.length === 0)
    )
      add(
        "/assessment/featureAssessment",
        "FEATURE_IMPLEMENTATION_PLAN_REQUIRED",
        "Ready features require requirements, evidence, an implementation plan, and acceptance criteria.",
      );
    if (
      detail.status === "needs_information" &&
      (detail.missingInformation.length === 0 || drafts.size === 0)
    )
      add(
        "/assessment/featureAssessment",
        "FEATURE_INFORMATION_REQUIRED",
        "Missing information and an inquiry draft must be explicit.",
      );
    if (detail.status === "needs_decision" && detail.decisions.length === 0)
      add(
        "/assessment/featureAssessment/decisions",
        "FEATURE_DECISION_REQUIRED",
        "An unresolved decision needs alternatives and tradeoffs.",
      );
    if (
      detail.status === "already_supported" &&
      (!detail.usage || assessment.evidenceRefs.length === 0)
    )
      add(
        "/assessment/featureAssessment",
        "FEATURE_USAGE_REQUIRED",
        "Existing support requires usage guidance and evidence.",
      );
    if (detail.status === "duplicate" && !detail.duplicateOf)
      add(
        "/assessment/featureAssessment/duplicateOf",
        "DUPLICATE_REFERENCE_REQUIRED",
        "Duplicate classification requires an original Issue and evidence.",
      );
    if (detail.duplicateOf)
      evidenceRefs(
        detail.duplicateOf.evidenceRefs,
        assessment.subjectRef,
        "/assessment/featureAssessment/duplicateOf/evidenceRefs",
      );
    if (
      detail.status === "not_feasible" &&
      (detail.alternatives.length === 0 || assessment.evidenceRefs.length === 0)
    )
      add(
        "/assessment/featureAssessment",
        "FEATURE_ALTERNATIVES_REQUIRED",
        "An infeasible request requires supporting evidence and alternatives.",
      );
  }
  const complete = result.report.completeness === "complete";
  if (
    result.outcome === "completed" &&
    (result.report.delivery !== "final" ||
      !complete ||
      result.report.loop.stopReason !== "complete")
  )
    add(
      "/outcome",
      "INCOMPLETE_COMPLETION",
      "Completed requires a final complete report with a completed investigation loop.",
    );
  if (complete) {
    const budget = result.report.loop.budget;
    const consumed = result.report.loop.consumed;
    // Previously sealed reports may carry an explicitly larger historical duration allowance.
    const durationLimitMs =
      budget.maxRounds !== undefined || budget.maxTokens !== undefined
        ? Math.max(budget.maxDurationMs, INVESTIGATION_EXECUTION_DURATION_LIMIT_MS)
        : INVESTIGATION_EXECUTION_DURATION_LIMIT_MS;
    if (consumed.durationMs > durationLimitMs || consumed.reportBytes > budget.maxReportBytes)
      add(
        "/report/loop/consumed",
        "COMPLETION_EXCEEDS_BUDGET",
        "Exhausted execution or storage budgets must preserve a partial result rather than claim completion.",
      );
    if (unresolvedUnitRefs.length > 0 || units.size === 0)
      add(
        "/report/coverage",
        "INCOMPLETE_COVERAGE",
        "A complete report must finish every declared investigation unit.",
      );
    if (pendingFindings.length > 0)
      add(
        "/report/recheck",
        "PENDING_FINAL_RECHECK",
        "Every final finding version must be rechecked before completion.",
      );
    if (result.report.loop.candidates.some((candidate) => candidate.status === "pending"))
      add(
        "/report/loop/candidates",
        "UNHANDLED_CANDIDATES",
        "Every known candidate needs an explicit disposition before completion.",
      );
    const unresolved = result.report.loop.candidates.filter(
      (candidate) => candidate.status === "unresolved",
    );
    for (const candidate of unresolved) {
      const hasNextStep = [...actions.values()].some(
        (action) =>
          action.subjectRef === candidate.subjectRef &&
          action.planRef !== null &&
          plans.has(action.planRef.id),
      );
      // Saving continuation work is independent of publishing an executable action proposal.
      const hasSavedContinuationPlan = [...plans.values()].some((plan) => {
        const source = plan.sourceReportRef;
        const parent = result.context.parentReportRef;
        return (
          plan.subjectRef === candidate.subjectRef &&
          plan.state === "saved" &&
          ["investigation", "verification", "reproduction"].includes(plan.kind) &&
          plan.steps.length > 0 &&
          plan.acceptanceCriteria.length > 0 &&
          ((source.id === result.report.id && source.version === result.report.version) ||
            (parent !== null &&
              result.context.task.parentTaskId !== null &&
              source.id === parent.id &&
              source.version === parent.version))
        );
      });
      if ((!hasNextStep && !hasSavedContinuationPlan) || result.report.limitations.length === 0)
        add(
          `/report/loop/candidates/${candidate.id}`,
          "UNRESOLVED_CANDIDATE_FOLLOWUP_REQUIRED",
          "Retained hypotheses need an explicit limitation and an applicable saved continuation plan or action.",
        );
    }
  }
  return { valid: errors.length === 0, errors };
}

export function assertInvestigationResult(result: InvestigationResultV1): void {
  const validation = validateInvestigationResult(result);
  if (!validation.valid)
    throw new Error(
      validation.errors
        .map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`)
        .join("\n"),
    );
}

function validateSourceArtifactBindings(input: {
  taskId: string;
  parentTaskId: string | null;
  parentReportRef: InvestigationTaskV1["parentReportRef"];
  subjects: readonly InvestigationSubjectV1[];
  sourceArtifacts: readonly InvestigationArtifactV1[];
  path: string;
}): InvestigationSemanticIssue[] {
  const errors: InvestigationSemanticIssue[] = [];
  const subjects = new Map(input.subjects.map((subject) => [subject.id, subject]));
  const ids = new Set<string>();
  for (const [index, artifact] of input.sourceArtifacts.entries()) {
    const subject = subjects.get(artifact.subjectRef);
    if (
      input.parentTaskId === null ||
      input.parentReportRef === null ||
      artifact.taskId === input.taskId ||
      artifact.kind !== "patch" ||
      subject?.kind !== "local_patch" ||
      subject.artifactRef !== artifact.id ||
      subject.patchDigest !== artifact.digest ||
      ids.has(artifact.id)
    )
      errors.push({
        path: `${input.path}/${index}`,
        code: "INVALID_SOURCE_ARTIFACT",
        message:
          "Inherited patch metadata requires an exact parent report binding, its frozen patch subject, and the original producing task identity.",
      });
    ids.add(artifact.id);
  }
  return errors;
}

export function validateInvestigationTask(
  task: InvestigationTaskV1,
): InvestigationSemanticValidation {
  const errors: InvestigationSemanticIssue[] = [];
  const add = (path: string, code: string, message: string) => {
    errors.push({ path, code, message });
  };
  errors.push(
    ...validateSourceArtifactBindings({
      taskId: task.id,
      parentTaskId: task.parentTaskId,
      parentReportRef: task.parentReportRef,
      subjects: task.subjects,
      sourceArtifacts: task.sourceArtifacts ?? [],
      path: "/sourceArtifacts",
    }),
  );
  const subjects = new Map(task.subjects.map((subject) => [subject.id, subject]));
  if (subjects.size !== task.subjects.length)
    add("/subjects", "DUPLICATE_ID", "Task subject IDs must be unique.");
  const primary = subjects.get(task.subjectRef);
  if (task.reviewBaseline !== undefined) {
    errors.push(
      ...validateReviewBaselineBinding({
        baseline: task.reviewBaseline,
        taskId: task.id,
        taskKind: task.kind,
        repositoryId: task.repository.id,
        workItemId: task.workItem.id,
        workItemKind: task.workItem.kind,
        parentTaskId: task.parentTaskId,
        parentReportRef: task.parentReportRef,
        primarySubject: primary,
        subjects: task.subjects,
      }),
    );
    if (task.planRef !== null || task.executionPolicy.mode !== "source_read")
      add(
        "/reviewBaseline",
        "REVIEW_BASELINE_SCOPE_MISMATCH",
        "Review comparisons require a root source-reading PR review without an execution plan.",
      );
  }
  if (!primary)
    add("/subjectRef", "UNKNOWN_SUBJECT", "The primary subject must be frozen in the task.");
  for (const subject of task.subjects) {
    if (subject.repositoryId !== task.repository.id || subject.workItemId !== task.workItem.id)
      add(
        "/subjects",
        "SUBJECT_SCOPE_MISMATCH",
        "Task subjects must belong to its repository and work item.",
      );
  }
  if (task.kind.startsWith("pr-") !== (task.workItem.kind === "pull_request"))
    add("/kind", "TASK_WORK_ITEM_MISMATCH", "PR and Issue task kinds must match their work item.");
  if ((task.kind === "pr-review" || task.kind === "pr-e2e") && primary?.kind !== "original_pr")
    add(
      "/subjectRef",
      "ORIGINAL_PR_REQUIRED",
      "A PR review must freeze the original base/head source pair.",
    );
  if (
    task.kind === "pr-e2e" &&
    (task.executionPolicy.mode !== "execute" ||
      task.parentTaskId !== null ||
      task.parentReportRef !== null ||
      task.planRef !== null)
  )
    add(
      "/kind",
      "E2E_ROOT_EXECUTION_REQUIRED",
      "E2E is an authorized root execution task and does not require a parent report or saved plan.",
    );
  for (const ref of task.executionPolicy.allowedSubjectRefs)
    if (!subjects.has(ref))
      add(
        "/executionPolicy/allowedSubjectRefs",
        "UNKNOWN_SUBJECT",
        "Execution policy can only reference frozen subjects.",
      );
  if (!task.executionPolicy.allowedSubjectRefs.includes(task.subjectRef))
    add(
      "/executionPolicy/allowedSubjectRefs",
      "PRIMARY_SUBJECT_NOT_ALLOWED",
      "The task subject must be inside its execution scope.",
    );
  if (task.executionPolicy.mode === "execute") {
    if (task.kind === "pr-review" || task.kind === "issue-investigate")
      add(
        "/executionPolicy/mode",
        "STATIC_TASK_EXECUTION_FORBIDDEN",
        "Static investigation task kinds cannot execute repository code.",
      );
    if (!task.executionPolicy.authorizationRef || !task.executionPolicy.allowRepositoryExecution)
      add(
        "/executionPolicy",
        "EXECUTION_AUTHORIZATION_REQUIRED",
        "Code execution requires a frozen authorization and explicit execution permission.",
      );
    if (primary?.kind === "issue_snapshot")
      add(
        "/subjectRef",
        "EXECUTION_SOURCE_REQUIRED",
        "Issue text alone cannot identify executable source.",
      );
  } else if (
    task.executionPolicy.allowRepositoryExecution ||
    task.executionPolicy.authorizationRef !== null
  )
    add(
      "/executionPolicy",
      "UNAUTHORIZED_EXECUTION_SCOPE",
      "Read-only policies must not grant repository execution.",
    );
  if (task.executionPolicy.mode === "snapshot_only" && task.kind !== "issue-investigate")
    add(
      "/executionPolicy/mode",
      "SNAPSHOT_TASK_KIND_MISMATCH",
      "Snapshot-only investigation is reserved for Issue analysis.",
    );
  for (const unit of task.scope.includedUnits)
    if (
      !subjects.has(unit.subjectRef) ||
      !task.executionPolicy.allowedSubjectRefs.includes(unit.subjectRef)
    )
      add(
        "/scope/includedUnits",
        "COVERAGE_OUTSIDE_AUTHORIZATION",
        "Coverage must remain within the frozen subject authorization.",
      );
  if (
    (task.kind === "pr-verify" ||
      task.kind === "issue-verify" ||
      task.kind === "reproduction-setup" ||
      task.kind === "issue-fix" ||
      task.kind === "feature-implement") &&
    (!task.planRef || !task.parentReportRef || !task.parentTaskId)
  )
    add(
      "/planRef",
      "FOLLOWUP_BINDING_REQUIRED",
      "Follow-up tasks require an exact saved plan and parent task/report binding.",
    );
  return { valid: errors.length === 0, errors };
}

/** Encodes JSON data deterministically; collection order is meaningful and is never sorted or truncated. */
export function investigationCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical investigation data cannot contain non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(investigationCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const properties = value as Record<string, unknown>;
    return `{${Object.keys(properties)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${investigationCanonicalJson(properties[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical investigation data must be JSON data without undefined values.");
}

export function investigationPlanDigestPayload(plan: InvestigationPlanV1): InvestigationPlanDraft {
  const { digest: _digest, state: _state, sourceReportRef: _sourceReportRef, ...payload } = plan;
  return payload;
}

export function investigationSourceDigestPayload(
  source: NonNullable<Static<typeof InvestigationInputSnapshotV1Schema>["source"]>,
): Omit<
  NonNullable<Static<typeof InvestigationInputSnapshotV1Schema>["source"]>,
  "artifactDigest"
> {
  const { artifactDigest: _artifactDigest, ...payload } = source;
  return payload;
}

/** Enforces the model proposal boundary against frozen task authorization and registered worker observations. */
export function validateInvestigationAnalysisForTask(
  task: InvestigationTaskV1,
  analysis: InvestigationAnalysisV1,
  runtime: InvestigationRuntimeState = {
    completedStepIds: [],
    checks: [],
    evidence: [],
    artifacts: [],
    subjects: [],
    startedSteps: [],
    completedSteps: [],
  },
): InvestigationSemanticValidation {
  const errors: InvestigationSemanticIssue[] = [];
  const add = (path: string, code: string, message: string) => {
    errors.push({ path, code, message });
  };
  if (
    runtime.reviewMode === "local_checkout" &&
    (task.executionPolicy.mode !== "source_read" ||
      (task.kind !== "pr-review" && task.kind !== "issue-investigate"))
  )
    add(
      "/runtime/reviewMode",
      "REVIEW_MODE_TASK_MISMATCH",
      "Local checkout review mode belongs to source-reading static investigation tasks.",
    );
  if (
    runtime.reviewMode === "local_snapshot" &&
    (task.executionPolicy.mode !== "snapshot_only" || task.kind !== "issue-investigate")
  )
    add(
      "/runtime/reviewMode",
      "REVIEW_MODE_TASK_MISMATCH",
      "Local snapshot review mode belongs to snapshot-only issue investigation tasks.",
    );
  const subjects = new Map([...task.subjects, ...runtime.subjects].map((item) => [item.id, item]));
  const currentReviewSubject = subjects.get(task.subjectRef);
  errors.push(
    ...validateInvestigationReviewBaselineCandidates({
      ...(task.reviewBaseline === undefined ? {} : { baseline: task.reviewBaseline }),
      subjectRef: task.subjectRef,
      headSha: currentReviewSubject?.kind === "original_pr" ? currentReviewSubject.headSha : null,
      candidates: analysis.candidates,
      findings: analysis.findings,
      evidence: [...runtime.evidence, ...analysis.evidence],
      limitations: analysis.limitations,
    }).errors,
  );
  const allowed = new Set(task.executionPolicy.allowedSubjectRefs);
  // Derived patches are authorized only through a trusted runtime record linked to an allowed immutable base.
  for (const item of runtime.subjects) {
    if (item.kind === "local_patch" && allowed.has(item.baseSubjectRef)) allowed.add(item.id);
    else if (
      item.kind === "remote_branch" &&
      task.executionPolicy.mode === "execute" &&
      runtime.evidence.some(
        (evidence) =>
          evidence.id === item.verifiedEvidenceRef &&
          evidence.authority !== "model" &&
          evidence.source === "upstream_reference" &&
          evidence.subjectRef === item.id,
      )
    )
      allowed.add(item.id);
    else if (
      !task.subjects.some(
        (frozen) =>
          frozen.id === item.id &&
          investigationCanonicalJson(frozen) === investigationCanonicalJson(item),
      )
    )
      add(
        "/runtime/subjects",
        "UNAUTHORIZED_DERIVED_SUBJECT",
        "Trusted runtime subjects must be a permitted derived patch or verified remote branch.",
      );
  }
  for (const item of runtime.subjects) {
    const frozen = task.subjects.find((candidate) => candidate.id === item.id);
    if (frozen && investigationCanonicalJson(frozen) !== investigationCanonicalJson(item))
      add(
        "/runtime/subjects",
        "FROZEN_SUBJECT_CHANGED",
        "Runtime output cannot redefine a frozen subject ID.",
      );
    if (item.repositoryId !== task.repository.id || item.workItemId !== task.workItem.id)
      add(
        "/runtime/subjects",
        "SUBJECT_SCOPE_MISMATCH",
        "Runtime subjects must preserve the task repository and work item.",
      );
  }
  const checkSubject = (id: string, path: string) => {
    if (!subjects.has(id) || !allowed.has(id))
      add(
        path,
        "SUBJECT_OUTSIDE_AUTHORIZATION",
        "Model analysis must remain within frozen or explicitly trusted derived subjects.",
      );
  };
  if (runtime.sourceCoverage !== undefined) {
    const sourceValidation = validateInvestigationSourceCoverage(
      runtime.sourceCoverage,
      subjects.get(task.subjectRef),
    );
    errors.push(
      ...sourceValidation.errors.map((issue) => ({
        ...issue,
        path: `/runtime/sourceCoverage${issue.path}`,
      })),
    );
    const coverageUnits = new Map(analysis.coverage.includedUnits.map((unit) => [unit.id, unit]));
    if (runtime.reviewMode === "local_checkout") {
      for (const file of runtime.sourceCoverage.manifest.files) {
        if (
          !analysis.coverage.includedUnits.some(
            (unit) =>
              unit.kind === "source_file" &&
              unit.subjectRef === task.subjectRef &&
              unit.paths.length === 1 &&
              unit.paths[0] === file.path,
          )
        )
          add(
            "/coverage/includedUnits",
            "SOURCE_COVERAGE_UNIT_MISSING",
            "Every registered changed file must remain an explicit coverage unit for its exact path and subject.",
          );
      }
    } else {
      for (const chunk of runtime.sourceCoverage.manifest.chunks) {
        const unit = coverageUnits.get(chunk.id);
        if (
          !unit ||
          unit.kind !== "pr_diff_chunk" ||
          unit.subjectRef !== task.subjectRef ||
          unit.paths.length !== 1 ||
          unit.paths[0] !== chunk.path
        )
          add(
            "/coverage/includedUnits",
            "SOURCE_COVERAGE_UNIT_MISSING",
            "Every registered PR source chunk must remain an explicit coverage unit for its exact path and subject.",
          );
      }
    }
  }
  const records: { subjectRef: string; path: string }[] = [
    { subjectRef: analysis.assessment.subjectRef, path: "/assessment/subjectRef" },
    ...analysis.coverage.includedUnits.map((item, index) => ({
      subjectRef: item.subjectRef,
      path: `/coverage/includedUnits/${index}/subjectRef`,
    })),
    ...analysis.coverage.exclusions.map((item, index) => ({
      subjectRef: item.subjectRef,
      path: `/coverage/exclusions/${index}/subjectRef`,
    })),
    ...analysis.findings.map((item, index) => ({
      subjectRef: item.subjectRef,
      path: `/findings/${index}/subjectRef`,
    })),
    ...analysis.candidates.map((item, index) => ({
      subjectRef: item.subjectRef,
      path: `/candidates/${index}/subjectRef`,
    })),
    ...analysis.rechecks.map((item, index) => ({
      subjectRef: item.subjectRef,
      path: `/rechecks/${index}/subjectRef`,
    })),
    ...analysis.evidence.map((item, index) => ({
      subjectRef: item.subjectRef,
      path: `/evidence/${index}/subjectRef`,
    })),
    ...analysis.plans.map((item, index) => ({
      subjectRef: item.subjectRef,
      path: `/plans/${index}/subjectRef`,
    })),
    ...analysis.nextActions.map((item, index) => ({
      subjectRef: item.subjectRef,
      path: `/nextActions/${index}/subjectRef`,
    })),
  ];
  records.forEach(({ subjectRef, path }) => {
    checkSubject(subjectRef, path);
  });
  const trustedIds = new Set(runtime.evidence.map((item) => item.id));
  for (const item of analysis.evidence)
    if (trustedIds.has(item.id))
      add(
        "/evidence",
        "TRUSTED_EVIDENCE_REDEFINITION",
        "Model output cannot redefine a registered worker evidence ID.",
      );
  if (analysis.assessment.subjectRef !== task.subjectRef)
    add(
      "/assessment/subjectRef",
      "ASSESSMENT_TASK_SUBJECT_MISMATCH",
      "The primary assessment must preserve the frozen task subject.",
    );
  if ((analysis.assessment.kind === "pr") !== (task.workItem.kind === "pull_request"))
    add(
      "/assessment/kind",
      "ASSESSMENT_WORK_ITEM_MISMATCH",
      "Assessment classification must match the task work item.",
    );
  for (const unit of task.scope.includedUnits) {
    const current = analysis.coverage.includedUnits.find((candidate) => candidate.id === unit.id);
    if (
      !current ||
      current.subjectRef !== unit.subjectRef ||
      current.requiredWork !== unit.requiredWork ||
      current.kind !== unit.kind ||
      investigationCanonicalJson(current.paths) !== investigationCanonicalJson(unit.paths)
    )
      add(
        "/coverage/includedUnits",
        "FROZEN_COVERAGE_CHANGED",
        "Every initial scope unit must remain present with its frozen work definition.",
      );
  }
  const exclusions = new Map(analysis.coverage.exclusions.map((item) => [item.id, item]));
  for (const exclusion of task.scope.exclusions) {
    const current = exclusions.get(exclusion.id);
    if (!current || investigationCanonicalJson(current) !== investigationCanonicalJson(exclusion))
      add(
        "/coverage/exclusions",
        "FROZEN_EXCLUSION_CHANGED",
        "Every explicitly excluded input and its reason must remain visible in the investigation scope.",
      );
  }
  if (
    task.executionPolicy.mode !== "execute" &&
    (runtime.checks.some((check) => check.status === "passed" || check.status === "failed") ||
      runtime.completedSteps.length > 0 ||
      runtime.startedSteps.length > 0)
  )
    add(
      "/runtime",
      "UNAUTHORIZED_EXECUTION",
      "Read-only analysis cannot incorporate repository execution performed outside its policy.",
    );
  if (runtime.e2e !== undefined) {
    const primary = task.subjects.find((subject) => subject.id === task.subjectRef);
    for (const message of validateInvestigationE2eBindings({
      e2e: runtime.e2e,
      taskId: task.id,
      taskKind: task.kind,
      subjectRef: task.subjectRef,
      headSha: primary?.kind === "original_pr" ? primary.headSha : null,
      completed: false,
      artifacts: runtime.artifacts,
      evidence: runtime.evidence,
    }))
      add("/runtime/e2e", "INVALID_E2E_EVIDENCE", message);
  }
  return { valid: errors.length === 0, errors };
}
