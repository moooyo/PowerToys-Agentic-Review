import {
  IssueTriageV2ModelOutputSchema,
  PrReviewPlanV2ModelOutputSchema,
} from "@agentic-review/codex";
import {
  assertEvaluationReviewRunPlan,
  type EvaluationExecutionTemplate,
  type EvaluationSourceSnapshotV1,
  evaluationExecutionRequiredCapabilityLabels,
  getEvaluationExecutionTemplateIssues,
  IssueValidationSummaryV1Schema,
  JobExecutionTemplateV1Schema,
  type JobExecutionTemplateV2,
  JobExecutionTemplateV2Schema,
  type PromptEnvelope,
  PromptEnvelopeSchema,
  PullRequestValidationSummaryV1Schema,
  type ReviewRunExecutionPlanV1,
  type ReviewRunExecutionPlanV2,
  type ReviewRunPlannedJob,
  type ReviewRunPromptSnapshot,
  ReviewRunPromptSnapshotSchema,
  ValidationJobContextV2Schema,
  WorkflowOutputSchemaVersions,
} from "@agentic-review/contracts";
import {
  assertEvaluationModelRuntimeRegistrationIntegrity,
  getReviewRunExecutorCapabilityLabels,
  validateFrozenIssueReproductionBinding,
} from "@agentic-review/domain";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, sha256 } from "./canonical-json.js";
import { renderEvaluationSourcePrompt, renderReviewRunPrompt } from "./job-factory.js";

const outputSchemas = {
  pr_static_build: PrReviewPlanV2ModelOutputSchema,
  issue_triage: IssueTriageV2ModelOutputSchema,
  pr_ui: PullRequestValidationSummaryV1Schema,
  issue_validation: IssueValidationSummaryV1Schema,
} as const;

const evaluationTemplateSchema = Type.Object(
  {
    ...JobExecutionTemplateV1Schema.properties,
    validation: ValidationJobContextV2Schema,
  },
  { additionalProperties: false },
);

/** Requires a persisted, sealed cell binding; the caller owns admission and runtime checks. */
export function createEvaluationExecutionTemplate(input: {
  runId: string;
  plan: ReviewRunExecutionPlanV2;
  planDigest: string;
  frozenPrompt: PromptEnvelope;
}): EvaluationExecutionTemplate {
  const { plan, frozenPrompt: prompt } = input;
  assertEvaluationReviewRunPlan(plan);
  assertEvaluationModelRuntimeRegistrationIntegrity(
    plan.modelRequirements,
    plan.modelRuntimeRegistration,
  );
  const request = plan.jobs[0];
  if (
    !request ||
    sha256(canonicalJson(plan)) !== input.planDigest ||
    !Value.Check(PromptEnvelopeSchema, prompt) ||
    prompt.promptSha256 !== sha256(prompt.renderedPrompt) ||
    prompt.outputSchemaSha256 !== sha256(canonicalJson(prompt.outputSchema))
  ) {
    throw new TypeError(
      "The evaluation execution requires the exact stored plan and prompt envelope.",
    );
  }
  const labels = {
    ...getReviewRunExecutorCapabilityLabels(plan, request),
    ...evaluationExecutionRequiredCapabilityLabels,
  };
  const version = request.prompt.version,
    profile = request.profileVersion;
  const common = {
    githubNodeId: plan.workItem.githubNodeId,
    number: plan.workItem.number,
    title: plan.workItem.title,
    author: plan.workItem.author,
    canonicalSnapshot: plan.workItem,
  };
  const template: EvaluationExecutionTemplate = {
    repository: {
      githubRepositoryId: plan.repository.githubRepositoryId,
      fullName: plan.repository.fullName,
    },
    resource:
      plan.workItem.kind === "pull_request" && plan.revision.kind === "pull_request"
        ? {
            ...common,
            kind: "pull_request",
            baseSha: plan.revision.baseSha,
            headSha: plan.revision.headSha,
            isDraft: plan.workItem.isDraft,
          }
        : { ...common, kind: "issue", revisionDigest: plan.revision.revisionKey },
    prompt,
    executionPolicy: {
      hardTimeoutMs: profile.config.hardTimeoutMs,
      noProgressTimeoutMs: profile.config.noProgressTimeoutMs,
      allowedRecipeIds: [],
      requiredCapabilityLabels: labels,
    },
    validation: {
      schemaVersion: "ValidationJobContextV2",
      runId: input.runId,
      planDigest: input.planDigest,
      activationId: plan.activationId,
      requestId: request.requestId,
      jobActivation: 1,
      repositoryId: plan.repository.id,
      workItemId: plan.workItemId,
      revisionKey: plan.revision.revisionKey,
      requestEpochId: null,
      workflowKind: request.workflowKind,
      target: request.target,
      required: request.required,
      profileVersion: profile,
      promptVersion: {
        id: version.id,
        templateId: version.templateId,
        version: version.version,
        contentSha256: version.contentSha256,
      },
      requiredCheckIds: request.requiredCheckIds,
      testedSourceRevision: plan.testedSourceRevision,
      testedSourceAuthorization: null,
      purpose: plan.purpose,
      source: plan.source,
      authorization: plan.authorization,
      modelRequirements: plan.modelRequirements,
      ...(plan.modelRuntimeRegistration === undefined
        ? {}
        : { modelRuntimeRegistration: plan.modelRuntimeRegistration }),
      ...(plan.reproduction === undefined ? {} : { reproduction: plan.reproduction }),
    },
  };
  if (!Value.Check(evaluationTemplateSchema, template))
    throw new TypeError("The derived evaluation execution template is invalid.");
  const issues = getEvaluationExecutionTemplateIssues(template, {
    ...input,
    requiredCapabilityLabels: labels,
  });
  if (issues.length) throw new TypeError(issues[0]);
  return JSON.parse(canonicalJson(template)) as EvaluationExecutionTemplate;
}

/** Freeze source-dependent prompt bytes before generating authorization and plan digests. */
export function createEvaluationPromptEnvelope(
  source: EvaluationSourceSnapshotV1,
  prompt: ReviewRunPromptSnapshot,
): PromptEnvelope {
  if (
    !Value.Check(ReviewRunPromptSnapshotSchema, prompt) ||
    prompt.version.outputSchemaVersion !== WorkflowOutputSchemaVersions[prompt.workflowKind] ||
    sha256(prompt.version.content) !== prompt.version.contentSha256
  ) {
    throw new TypeError("The evaluation requires a valid published prompt for its workflow.");
  }
  const version = prompt.version;
  const renderedPrompt = renderEvaluationSourcePrompt(version.content, source, prompt.workflowKind);
  const outputSchema: unknown = JSON.parse(canonicalJson(outputSchemas[prompt.workflowKind]));
  const result: PromptEnvelope = {
    name: version.templateId,
    version: String(version.version),
    renderedPrompt,
    promptSha256: sha256(renderedPrompt),
    outputSchema,
    outputSchemaSha256: sha256(canonicalJson(outputSchema)),
  };
  if (!Value.Check(PromptEnvelopeSchema, result)) {
    throw new TypeError("The derived evaluation prompt envelope is invalid.");
  }
  return result;
}

/** Call once when persisting the plan; future activations use the stored envelope verbatim. */
export function createValidationPromptEnvelope(
  plan: ReviewRunExecutionPlanV1,
  request: ReviewRunPlannedJob,
): PromptEnvelope {
  if (
    request.prompt === null ||
    !plan.jobs.some((job) => canonicalJson(job) === canonicalJson(request))
  ) {
    throw new TypeError("A published prompt from this plan is required.");
  }
  const version = request.prompt.version;
  if (sha256(version.content) !== version.contentSha256) {
    throw new TypeError("The published prompt digest is invalid.");
  }
  const renderedPrompt = renderReviewRunPrompt(version.content, plan, request.workflowKind);
  const outputSchema: unknown = JSON.parse(canonicalJson(outputSchemas[request.workflowKind]));
  const result: PromptEnvelope = {
    name: version.templateId,
    version: String(version.version),
    renderedPrompt,
    promptSha256: sha256(renderedPrompt),
    outputSchema,
    outputSchemaSha256: sha256(canonicalJson(outputSchema)),
  };
  if (!Value.Check(PromptEnvelopeSchema, result))
    throw new TypeError("The derived prompt envelope is invalid.");
  return result;
}

export function createValidationExecutionTemplate(input: {
  runId: string;
  plan: ReviewRunExecutionPlanV1;
  planDigest: string;
  requestId: string;
  jobActivation: number;
  frozenPrompt: PromptEnvelope;
}): JobExecutionTemplateV2 {
  const { plan, frozenPrompt: prompt } = input;
  const request = plan.jobs.find((job) => job.requestId === input.requestId);
  if (
    !request?.profileVersion ||
    !request.prompt ||
    sha256(canonicalJson(plan)) !== input.planDigest
  ) {
    throw new TypeError("The validation job requires a complete immutable plan request.");
  }
  const profile = request.profileVersion;
  const reproduction = plan.reproduction?.binding.cases.some(
    (entry) => entry.requestId === request.requestId,
  )
    ? plan.reproduction
    : undefined;
  if (plan.reproduction !== undefined) {
    validateFrozenIssueReproductionBinding(plan.reproduction, plan.jobs, {
      activationId: plan.activationId,
      repositoryId: plan.repository.id,
      githubRepositoryId: plan.repository.githubRepositoryId,
      workItemId: plan.workItemId,
      githubWorkItemId: plan.workItem.githubWorkItemId,
      workItemKind: plan.workItem.kind,
      issueRevisionKey: plan.revision.revisionKey,
      testedSourceRevision: plan.testedSourceRevision,
      testedSourceAuthorization: plan.testedSourceAuthorization,
    });
  }
  const promptVersion = request.prompt.version;
  if (
    !Value.Check(PromptEnvelopeSchema, prompt) ||
    prompt.promptSha256 !== sha256(prompt.renderedPrompt) ||
    prompt.outputSchemaSha256 !== sha256(canonicalJson(prompt.outputSchema))
  ) {
    throw new TypeError("The stored prompt envelope is invalid.");
  }
  const commonResource = {
    githubNodeId: plan.workItem.githubNodeId,
    number: plan.workItem.number,
    title: plan.workItem.title,
    author: plan.workItem.author,
    canonicalSnapshot: plan.workItem,
  };
  const resource: JobExecutionTemplateV2["resource"] =
    plan.workItem.kind === "pull_request" && plan.revision.kind === "pull_request"
      ? {
          ...commonResource,
          kind: "pull_request",
          baseSha: plan.revision.baseSha,
          headSha: plan.revision.headSha,
          isDraft: plan.workItem.isDraft,
        }
      : { ...commonResource, kind: "issue", revisionDigest: plan.revision.revisionKey };
  const template = {
    repository: {
      githubRepositoryId: plan.repository.githubRepositoryId,
      fullName: plan.repository.fullName,
    },
    resource,
    prompt,
    executionPolicy: {
      hardTimeoutMs: profile.config.hardTimeoutMs,
      noProgressTimeoutMs: profile.config.noProgressTimeoutMs,
      allowedRecipeIds: [],
      requiredCapabilityLabels: getReviewRunExecutorCapabilityLabels(plan, request),
    },
    validation: {
      schemaVersion: "ValidationJobContextV1",
      runId: input.runId,
      planDigest: input.planDigest,
      activationId: plan.activationId,
      requestId: request.requestId,
      jobActivation: input.jobActivation,
      repositoryId: plan.repository.id,
      workItemId: plan.workItemId,
      revisionKey: plan.revision.revisionKey,
      requestEpochId: plan.authorization.requestEpochId,
      workflowKind: request.workflowKind,
      target: request.target,
      required: request.required,
      profileVersion: profile,
      promptVersion: {
        id: promptVersion.id,
        templateId: promptVersion.templateId,
        version: promptVersion.version,
        contentSha256: promptVersion.contentSha256,
      },
      requiredCheckIds: request.requiredCheckIds,
      testedSourceRevision: plan.testedSourceRevision,
      testedSourceAuthorization: plan.testedSourceAuthorization,
      ...(reproduction === undefined ? {} : { reproduction }),
    },
  };
  if (!Value.Check(JobExecutionTemplateV2Schema, template))
    throw new TypeError("The validation execution template is invalid.");
  return JSON.parse(canonicalJson(template)) as JobExecutionTemplateV2;
}
