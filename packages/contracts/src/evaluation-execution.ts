import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { DateTimeSchema, EntityIdSchema, GitHubNumericIdSchema, Sha256Schema } from "./common.js";
import type { JobExecutionTemplateV1Schema, PromptEnvelope } from "./job-envelope.js";
import {
  getModelRuntimeRegistrationIssues,
  type ModelRuntimeRegistrationV1,
  ModelRuntimeRegistrationV1Schema,
} from "./model-runtime-registry.js";
import { OperatorPrincipalSchema } from "./operator-access.js";
import {
  getValidationProfileConfigIssues,
  ValidationProfileVersionSchema,
  WorkflowOutputSchemaVersions,
} from "./platform-configuration.js";
import {
  maximumReviewRunPlanUtf8Bytes,
  ReviewRunExecutionPlanV1Schema,
  ReviewRunPlannedJobSchema,
  ReviewRunPromptSnapshotSchema,
  ReviewRunTestedSourceRevisionSchema,
} from "./review-run.js";
import {
  ValidationJobContextSchema,
  validationExecutorCapabilityLabels,
} from "./validation-job.js";

export const maximumEvaluationSourceSnapshotUtf8Bytes = 2 * 1024 * 1024;
export const evaluationExecutionCapabilityLabel = "validationEvaluation";
// This is a protocol requirement, not a claim that a deployed Worker supports evaluation.
export const evaluationExecutionRequiredCapabilityLabels = Object.freeze({
  validationEvaluation: "1",
});

const nullableId = Type.Union([EntityIdSchema, Type.Null()]);
const nullableDigest = Type.Union([Sha256Schema, Type.Null()]);
const nullableTestedSource = Type.Union([ReviewRunTestedSourceRevisionSchema, Type.Null()]);
const frozenSourceProperties = {
  repository: ReviewRunExecutionPlanV1Schema.properties.repository,
  workItemId: ReviewRunExecutionPlanV1Schema.properties.workItemId,
  workItem: ReviewRunExecutionPlanV1Schema.properties.workItem,
  revision: ReviewRunExecutionPlanV1Schema.properties.revision,
  testedSourceRevision: nullableTestedSource,
};

export const EvaluationSourceProvenanceV1Schema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("current_work_item"),
      capturedAt: DateTimeSchema,
      expectedRevisionKey: Sha256Schema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("review_run"),
      capturedAt: DateTimeSchema,
      reviewRunId: EntityIdSchema,
      planDigest: Sha256Schema,
      // Historical authorization is provenance only, never authority for this execution.
      requestEpochId: nullableId,
    },
    { additionalProperties: false },
  ),
]);
export type EvaluationSourceProvenanceV1 = Static<typeof EvaluationSourceProvenanceV1Schema>;

export const EvaluationSourceSnapshotV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationSourceSnapshotV1"),
    ...frozenSourceProperties,
    revisionId: EntityIdSchema,
    freshness: Type.Literal("frozen"),
    sourceDigest: Sha256Schema,
    provenance: EvaluationSourceProvenanceV1Schema,
  },
  { additionalProperties: false },
);
export type EvaluationSourceSnapshotV1 = Static<typeof EvaluationSourceSnapshotV1Schema>;

// Only the Server may stamp this object after checking the actor and the complete frozen matrix.
// A matching digest string is not proof of content, publication, permission, or matrix membership.
export const EvaluationExecutionAuthorizationV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationExecutionAuthorizationV1"),
    kind: Type.Literal("operator_evaluation"),
    id: EntityIdSchema,
    actor: OperatorPrincipalSchema,
    authorizedAt: DateTimeSchema,
    evaluationId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    githubRepositoryId: GitHubNumericIdSchema,
    sampleSetVersionId: EntityIdSchema,
    sourceManifestSha256: Sha256Schema,
    configurationManifestSha256: Sha256Schema,
    cellManifestSha256: Sha256Schema,
    executionManifestSha256: Sha256Schema,
  },
  { additionalProperties: false },
);
export type EvaluationExecutionAuthorizationV1 = Static<
  typeof EvaluationExecutionAuthorizationV1Schema
>;

export const EvaluationExecutionPurposeV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationExecutionPurposeV1"),
    kind: Type.Literal("evaluation"),
    evaluationId: EntityIdSchema,
    cellId: EntityIdSchema,
    caseId: EntityIdSchema,
    arm: Type.Union([Type.Literal("baseline"), Type.Literal("candidate")]),
    sampleSetVersionId: EntityIdSchema,
    authorizationId: EntityIdSchema,
    executionManifestSha256: Sha256Schema,
    trial: Type.Literal(1),
    upstreamMutationPolicy: Type.Literal("forbidden"),
  },
  { additionalProperties: false },
);
export type EvaluationExecutionPurposeV1 = Static<typeof EvaluationExecutionPurposeV1Schema>;

export const EvaluationModelRequirementsV1Schema = Type.Object(
  {
    required: Type.Boolean(),
    // The owner must resolve this from verified runtime metadata; clients cannot attest it.
    expectedModelIdentityDigest: nullableDigest,
    runtimeRegistration: Type.Optional(
      Type.Object(
        {
          registrationId: Type.String({
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\\s\\S])",
          }),
          registrationSha256: Sha256Schema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type EvaluationModelRequirementsV1 = Static<typeof EvaluationModelRequirementsV1Schema>;

export const EvaluationReviewRunPlannedJobSchema = Type.Object(
  {
    ...ReviewRunPlannedJobSchema.properties,
    profileVersion: ValidationProfileVersionSchema,
    prompt: ReviewRunPromptSnapshotSchema,
  },
  { additionalProperties: false },
);
export type EvaluationReviewRunPlannedJob = Static<typeof EvaluationReviewRunPlannedJobSchema>;

export const ReviewRunExecutionPlanV2Schema = Type.Object(
  {
    ...Type.Omit(ReviewRunExecutionPlanV1Schema, [
      "schemaVersion",
      "authorization",
      "testedSourceAuthorization",
      "jobs",
    ]).properties,
    schemaVersion: Type.Literal("ReviewRunExecutionPlanV2"),
    requestEpochId: Type.Null(),
    // Legacy source authority is inapplicable. Evaluation authority is checked separately.
    testedSourceAuthorization: Type.Null(),
    purpose: EvaluationExecutionPurposeV1Schema,
    source: EvaluationSourceSnapshotV1Schema,
    authorization: EvaluationExecutionAuthorizationV1Schema,
    modelRequirements: EvaluationModelRequirementsV1Schema,
    modelRuntimeRegistration: Type.Optional(ModelRuntimeRegistrationV1Schema),
    jobs: Type.Array(EvaluationReviewRunPlannedJobSchema, { minItems: 1, maxItems: 1 }),
  },
  { additionalProperties: false },
);
export type ReviewRunExecutionPlanV2 = Static<typeof ReviewRunExecutionPlanV2Schema>;

export const ValidationJobContextV2Schema = Type.Object(
  {
    ...Type.Omit(ValidationJobContextSchema, [
      "schemaVersion",
      "requestEpochId",
      "testedSourceAuthorization",
      "jobActivation",
    ]).properties,
    schemaVersion: Type.Literal("ValidationJobContextV2"),
    requestEpochId: Type.Null(),
    testedSourceAuthorization: Type.Null(),
    // Infrastructure retries retain this activation; another trial needs another evaluation.
    jobActivation: Type.Literal(1),
    purpose: EvaluationExecutionPurposeV1Schema,
    source: EvaluationSourceSnapshotV1Schema,
    authorization: EvaluationExecutionAuthorizationV1Schema,
    modelRequirements: EvaluationModelRequirementsV1Schema,
    modelRuntimeRegistration: Type.Optional(ModelRuntimeRegistrationV1Schema),
  },
  { additionalProperties: false },
);
export type ValidationJobContextV2 = Static<typeof ValidationJobContextV2Schema>;

// This type-only import avoids a runtime cycle when the envelope module admits the V2 context.
export type EvaluationExecutionTemplate = Static<typeof JobExecutionTemplateV1Schema> & {
  validation: ValidationJobContextV2;
};
export interface EvaluationExecutionBinding {
  readonly plan: ReviewRunExecutionPlanV2;
  readonly runId: string;
  readonly planDigest: string;
}
export interface EvaluationExecutionTemplateBinding extends EvaluationExecutionBinding {
  readonly frozenPrompt: PromptEnvelope;
  readonly requiredCapabilityLabels: Readonly<Record<string, string>>;
}

function registerFormats(): void {
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set(
      "date-time",
      (value) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
        Number.isFinite(Date.parse(value)),
    );
  if (!FormatRegistry.Has("uri")) FormatRegistry.Set("uri", (value) => URL.canParse(value));
}

function jsonCompatible(value: unknown): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonCompatible);
  if (typeof value !== "object") return false;
  return Object.entries(value).every(([key, entry]) => key.isWellFormed() && jsonCompatible(entry));
}

function shapeIssues(
  schema: TSchema,
  value: unknown,
  label: string,
  maximumBytes?: number,
): string[] {
  registerFormats();
  if (!Value.Check(schema, value)) {
    const error = Value.Errors(schema, value).First();
    return [`${label} is invalid at ${error?.path || "/"}.`];
  }
  if (!jsonCompatible(value)) return [`${label} must contain well-formed JSON data.`];
  if (
    maximumBytes !== undefined &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes
  )
    return [`${label} exceeds its aggregate UTF-8 byte limit.`];
  return [];
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const exactCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export function getEvaluationSourceSnapshotIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationSourceSnapshotV1Schema,
    value,
    "Evaluation source snapshot",
    maximumEvaluationSourceSnapshotUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const source = value as EvaluationSourceSnapshotV1;
  const { repository, workItem, revision, testedSourceRevision: tested } = source;
  if (
    repository.githubRepositoryId !== workItem.githubRepositoryId ||
    repository.githubRepositoryId !== revision.githubRepositoryId ||
    workItem.githubWorkItemId !== revision.githubWorkItemId ||
    workItem.kind !== revision.kind
  )
    issues.push("Evaluation source repository, work item, and revision scope must match.");
  if (revision.kind === "pull_request") {
    if (
      !exactCommit.test(revision.baseSha) ||
      !exactCommit.test(revision.headSha) ||
      tested?.kind !== "pull_request" ||
      tested.baseSha !== revision.baseSha ||
      tested.headSha !== revision.headSha
    )
      issues.push("Evaluation PR source must retain its exact base and head commits.");
  } else if (tested !== null && tested.kind !== "commit") {
    issues.push("An evaluation Issue source can only select an explicit commit or no checkout.");
  }
  if (
    source.provenance.kind === "current_work_item" &&
    source.provenance.expectedRevisionKey !== revision.revisionKey
  )
    issues.push("Current capture must match its expected revision key.");
  return issues;
}

export function getEvaluationExecutionAuthorizationIssues(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationExecutionAuthorizationV1Schema,
    value,
    "Evaluation execution authorization",
  );
  if (issues.length > 0) return issues;
  const authorization = value as EvaluationExecutionAuthorizationV1;
  for (const field of ["issuer", "subject"] as const) {
    const identity = authorization.actor[field];
    if (identity.trim() !== identity || identity.includes("\0"))
      issues.push(`Evaluation actor ${field} must be an exact nonempty identity.`);
  }
  return issues;
}

function authorityIssues(
  source: EvaluationSourceSnapshotV1,
  purpose: EvaluationExecutionPurposeV1,
  authorization: EvaluationExecutionAuthorizationV1,
): string[] {
  const issues = [
    ...getEvaluationSourceSnapshotIssues(source),
    ...getEvaluationExecutionAuthorizationIssues(authorization),
  ];
  if (
    purpose.authorizationId !== authorization.id ||
    purpose.evaluationId !== authorization.evaluationId ||
    purpose.sampleSetVersionId !== authorization.sampleSetVersionId ||
    purpose.executionManifestSha256 !== authorization.executionManifestSha256 ||
    source.repository.id !== authorization.repositoryId ||
    source.repository.githubRepositoryId !== authorization.githubRepositoryId
  )
    issues.push("Evaluation purpose, source, and execution authorization scope must match.");
  if (Date.parse(source.provenance.capturedAt) > Date.parse(authorization.authorizedAt))
    issues.push("Evaluation execution authorization must follow source capture.");
  return issues;
}

function requestIssues(
  source: EvaluationSourceSnapshotV1,
  request: Pick<
    EvaluationReviewRunPlannedJob,
    "workflowKind" | "target" | "required" | "profileVersion" | "requiredCheckIds"
  >,
  model: EvaluationModelRequirementsV1,
): string[] {
  const issues: string[] = [];
  const profile = request.profileVersion;
  const pr = request.workflowKind === "pr_static_build" || request.workflowKind === "pr_ui";
  if ((source.workItem.kind === "pull_request") !== pr)
    issues.push("Evaluation workflow must match the frozen work item kind.");
  if (
    profile.repositoryId !== source.repository.id ||
    profile.workflowKind !== request.workflowKind ||
    profile.target !== request.target ||
    (profile.required && !request.required)
  )
    issues.push("Evaluation profile must match its repository, workflow, target, and requirement.");
  issues.push(
    ...getValidationProfileConfigIssues(profile.config, profile.workflowKind, profile.target),
  );
  if (request.workflowKind === "issue_triage" && source.testedSourceRevision !== null)
    issues.push("Issue triage evaluations must remain snapshot-only without a tested commit.");
  if (request.workflowKind === "issue_validation" && source.testedSourceRevision?.kind !== "commit")
    issues.push("Issue validation evaluations require an explicitly selected source commit.");
  if (
    (request.workflowKind === "pr_static_build" || request.workflowKind === "issue_triage") &&
    !model.required
  )
    issues.push("Static review and Issue triage evaluations require model execution.");
  const required = request.required
    ? [...profile.config.build, ...profile.config.test, ...(profile.config.ui?.scenarios ?? [])]
        .filter((step) => step.required)
        .map((step) => `${profile.id}:${step.id}`)
        .sort()
    : [];
  if (!same(required, [...request.requiredCheckIds].sort()))
    issues.push("Evaluation required checks must match the complete frozen profile.");
  return issues;
}

/** Registration digests and current enablement are independently checked by the owner. */
export function getEvaluationModelRuntimeRegistrationIssues(
  requirements: unknown,
  registration?: unknown,
): string[] {
  const issues = shapeIssues(
    EvaluationModelRequirementsV1Schema,
    requirements,
    "Evaluation model requirements",
  );
  if (issues.length) return issues;
  const model = requirements as EvaluationModelRequirementsV1;
  const reference = model.runtimeRegistration;
  if ((reference === undefined) !== (registration === undefined))
    return [
      "Evaluation model registration reference and frozen snapshot must be present together.",
    ];
  if (reference === undefined) return [];
  issues.push(...getModelRuntimeRegistrationIssues(registration));
  if (issues.length) return issues;
  const snapshot = registration as ModelRuntimeRegistrationV1;
  if (
    reference.registrationId !== snapshot.id ||
    model.expectedModelIdentityDigest !== snapshot.identitySha256
  )
    issues.push(
      "Evaluation model requirements must match their frozen registration and identity digest.",
    );
  return issues;
}

function reproductionIssues(value: ReviewRunExecutionPlanV2 | ValidationJobContextV2): string[] {
  if (value.reproduction === undefined) return [];
  const { binding } = value.reproduction;
  const request = "jobs" in value ? value.jobs[0] : value;
  if (request === undefined) return ["Evaluation reproduction requires a frozen request."];
  const { source, authorization } = value;
  if (
    request.workflowKind !== "issue_validation" ||
    source.testedSourceRevision?.kind !== "commit" ||
    binding.activationId !== value.activationId ||
    binding.repositoryId !== source.repository.id ||
    binding.githubRepositoryId !== source.repository.githubRepositoryId ||
    binding.workItemId !== source.workItemId ||
    binding.githubWorkItemId !== source.workItem.githubWorkItemId ||
    binding.issueRevisionKey !== source.revision.revisionKey ||
    binding.testedSourceCommit !== source.testedSourceRevision.headSha ||
    binding.authorizedBy.issuer !== authorization.actor.issuer ||
    binding.authorizedBy.subject !== authorization.actor.subject ||
    binding.authorizedBy.authorizedAt !== authorization.authorizedAt ||
    binding.cases.some(
      (entry) =>
        entry.requestId !== request.requestId ||
        entry.profileVersionId !== request.profileVersion.id ||
        entry.profileConfigSha256 !== request.profileVersion.configSha256 ||
        entry.target !== request.target,
    )
  )
    return [
      "Evaluation reproduction must use its own source, request, profile, and evaluation authorization.",
    ];
  return [];
}

export function getEvaluationReviewRunPlanIssues(value: unknown): string[] {
  const issues = shapeIssues(
    ReviewRunExecutionPlanV2Schema,
    value,
    "Evaluation review run plan",
    maximumReviewRunPlanUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const plan = value as ReviewRunExecutionPlanV2;
  issues.push(...authorityIssues(plan.source, plan.purpose, plan.authorization));
  issues.push(
    ...getEvaluationModelRuntimeRegistrationIssues(
      plan.modelRequirements,
      plan.modelRuntimeRegistration,
    ),
  );
  if (
    plan.modelRuntimeRegistration !== undefined &&
    Date.parse(plan.modelRuntimeRegistration.createdAt) >
      Date.parse(plan.authorization.authorizedAt)
  )
    issues.push("Evaluation authorization cannot precede its frozen model registration.");
  for (const field of [
    "repository",
    "workItemId",
    "workItem",
    "revision",
    "testedSourceRevision",
  ] as const)
    if (!same(plan[field], plan.source[field]))
      issues.push(`Evaluation plan ${field} must match its frozen source snapshot.`);
  const request = plan.jobs[0];
  if (request === undefined) return [...issues, "An evaluation run requires exactly one request."];
  issues.push(...requestIssues(plan.source, request, plan.modelRequirements));
  if (
    request.prompt.workflowKind !== request.workflowKind ||
    request.prompt.version.outputSchemaVersion !==
      WorkflowOutputSchemaVersions[request.workflowKind]
  )
    issues.push("Evaluation prompt must match its workflow and supported output schema.");
  if (!same([...plan.requiredCheckIds].sort(), [...request.requiredCheckIds].sort()))
    issues.push("Evaluation plan and request required checks must match.");
  issues.push(...reproductionIssues(plan));
  return issues;
}

/** This checks consistency only; the owner must recompute digests and verify all persisted links. */
export function getEvaluationValidationJobContextIssues(
  value: unknown,
  expected?: EvaluationExecutionBinding,
): string[] {
  const issues = shapeIssues(
    ValidationJobContextV2Schema,
    value,
    "Evaluation validation context",
    maximumReviewRunPlanUtf8Bytes,
  );
  if (issues.length > 0) return issues;
  const context = value as ValidationJobContextV2;
  issues.push(...authorityIssues(context.source, context.purpose, context.authorization));
  issues.push(
    ...getEvaluationModelRuntimeRegistrationIssues(
      context.modelRequirements,
      context.modelRuntimeRegistration,
    ),
  );
  if (
    context.modelRuntimeRegistration !== undefined &&
    Date.parse(context.modelRuntimeRegistration.createdAt) >
      Date.parse(context.authorization.authorizedAt)
  )
    issues.push("Evaluation authorization cannot precede its frozen model registration.");
  if (
    context.repositoryId !== context.source.repository.id ||
    context.workItemId !== context.source.workItemId ||
    context.revisionKey !== context.source.revision.revisionKey ||
    !same(context.testedSourceRevision, context.source.testedSourceRevision)
  )
    issues.push("Evaluation context must retain its frozen source identity.");
  issues.push(...requestIssues(context.source, context, context.modelRequirements));
  issues.push(...reproductionIssues(context));
  if (expected !== undefined) {
    const planIssues = getEvaluationReviewRunPlanIssues(expected.plan);
    if (planIssues.length > 0) return [...issues, ...planIssues];
    const plan = expected.plan;
    const request = plan.jobs[0];
    if (!request) return issues;
    const prompt = request.prompt.version;
    if (
      context.runId !== expected.runId ||
      context.planDigest !== expected.planDigest ||
      context.activationId !== plan.activationId ||
      context.requestId !== request.requestId ||
      context.workflowKind !== request.workflowKind ||
      context.target !== request.target ||
      context.required !== request.required ||
      !same(context.profileVersion, request.profileVersion) ||
      !same(context.requiredCheckIds, request.requiredCheckIds) ||
      !same(context.purpose, plan.purpose) ||
      !same(context.source, plan.source) ||
      !same(context.authorization, plan.authorization) ||
      !same(context.modelRequirements, plan.modelRequirements) ||
      !same(context.modelRuntimeRegistration ?? null, plan.modelRuntimeRegistration ?? null) ||
      !same(context.reproduction ?? null, plan.reproduction ?? null) ||
      !same(context.promptVersion, {
        id: prompt.id,
        templateId: prompt.templateId,
        version: prompt.version,
        contentSha256: prompt.contentSha256,
      })
    )
      issues.push(
        "Evaluation context must match the exact run, plan, cell, arm, and frozen request.",
      );
  }
  return issues;
}

/** The caller first validates the outer template schema and resolves this binding from storage. */
export function getEvaluationExecutionTemplateIssues(
  template: EvaluationExecutionTemplate,
  expected: EvaluationExecutionTemplateBinding,
): string[] {
  const issues = getEvaluationValidationJobContextIssues(template.validation, expected);
  if (issues.length > 0) return issues;
  const context = template.validation;
  const source = context.source;
  const workItem = source.workItem;
  const common = {
    githubNodeId: workItem.githubNodeId,
    number: workItem.number,
    title: workItem.title,
    author: workItem.author,
    canonicalSnapshot: workItem,
  };
  const resource =
    workItem.kind === "pull_request" && source.revision.kind === "pull_request"
      ? {
          ...common,
          kind: "pull_request",
          baseSha: source.revision.baseSha,
          headSha: source.revision.headSha,
          isDraft: workItem.isDraft,
        }
      : { ...common, kind: "issue", revisionDigest: source.revision.revisionKey };
  const profile = context.profileVersion;
  const labels = expected.requiredCapabilityLabels;
  const requiredProtocols: Record<string, string> = {
    ...evaluationExecutionRequiredCapabilityLabels,
    [validationExecutorCapabilityLabels.envelope]: "2",
    [validationExecutorCapabilityLabels[context.target]]: "1",
  };
  if (context.reproduction !== undefined)
    requiredProtocols[validationExecutorCapabilityLabels.reproduction] = "1";
  if (profile.config.test.some((step) => step.probeOutput !== undefined))
    requiredProtocols[validationExecutorCapabilityLabels.probes] = "1";
  if (
    context.reproduction?.binding.cases.some((entry) => entry.target !== "headless") ||
    (profile.config.ui?.target === "web" && profile.config.ui.evidence.trace === "off")
  )
    requiredProtocols[validationExecutorCapabilityLabels.uiObservations] = "1";
  if (Object.entries(requiredProtocols).some(([label, version]) => labels[label] !== version))
    issues.push(
      "Evaluation templates require implemented evaluation and target protocol capabilities.",
    );
  if (
    !same(template.repository, {
      githubRepositoryId: source.repository.githubRepositoryId,
      fullName: source.repository.fullName,
    }) ||
    !same(template.resource, resource) ||
    !same(template.prompt, expected.frozenPrompt) ||
    template.prompt.name !== context.promptVersion.templateId ||
    template.prompt.version !== String(context.promptVersion.version) ||
    !same(template.executionPolicy, {
      hardTimeoutMs: profile.config.hardTimeoutMs,
      noProgressTimeoutMs: profile.config.noProgressTimeoutMs,
      allowedRecipeIds: [],
      requiredCapabilityLabels: labels,
    })
  )
    issues.push(
      "Evaluation template must match its frozen source, prompt, profile, and execution policy.",
    );
  return issues;
}

// No empty result from this helper attests runtime model metadata, capability, or confinement.
export function getEvaluationModelReadinessBlockers(value: unknown): string[] {
  const issues = shapeIssues(
    EvaluationModelRequirementsV1Schema,
    value,
    "Evaluation model requirements",
  );
  if (issues.length > 0) return issues;
  const model = value as EvaluationModelRequirementsV1;
  return model.required && model.expectedModelIdentityDigest === null
    ? ["expected_model_identity_missing"]
    : [];
}

function assertNoIssues(issues: string[]): void {
  if (issues.length > 0) throw new TypeError(issues[0]);
}
export function assertEvaluationSourceSnapshot(
  value: unknown,
): asserts value is EvaluationSourceSnapshotV1 {
  assertNoIssues(getEvaluationSourceSnapshotIssues(value));
}
export function assertEvaluationExecutionAuthorization(
  value: unknown,
): asserts value is EvaluationExecutionAuthorizationV1 {
  assertNoIssues(getEvaluationExecutionAuthorizationIssues(value));
}
export function assertEvaluationReviewRunPlan(
  value: unknown,
): asserts value is ReviewRunExecutionPlanV2 {
  assertNoIssues(getEvaluationReviewRunPlanIssues(value));
}
export function assertEvaluationValidationJobContext(
  value: unknown,
  expected?: EvaluationExecutionBinding,
): asserts value is ValidationJobContextV2 {
  assertNoIssues(getEvaluationValidationJobContextIssues(value, expected));
}
