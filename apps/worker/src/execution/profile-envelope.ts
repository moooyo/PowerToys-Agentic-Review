import { createHash } from "node:crypto";
import {
  createCanonicalResult,
  IssueTriageV2ModelOutputSchema,
  PrReviewPlanV2ModelOutputSchema,
} from "@agentic-review/codex";
import {
  GitHubWorkItemSchema,
  getEvaluationValidationJobContextIssues,
  getValidationProfileConfigIssues,
  IssueValidationSummaryV1Schema,
  type JobExecutionEnvelopeV2,
  JobExecutionEnvelopeV2Schema,
  maximumRenderedPromptUtf8Bytes,
  PullRequestValidationSummaryV1Schema,
} from "@agentic-review/contracts";
import {
  assertEvaluationModelRuntimeRegistrationIntegrity,
  getReviewRunExecutorCapabilityLabels,
} from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import { validateReproductionEnvelope } from "./issue-reproduction-results.js";

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const modelSchemas = {
  pr_static_build: PrReviewPlanV2ModelOutputSchema,
  issue_triage: IssueTriageV2ModelOutputSchema,
  pr_ui: PullRequestValidationSummaryV1Schema,
  issue_validation: IssueValidationSummaryV1Schema,
};
const modelSchemaDigests = Object.fromEntries(
  Object.entries(modelSchemas).map(([workflow, schema]) => [
    workflow,
    createCanonicalResult(JSON.parse(JSON.stringify(schema))).sha256,
  ]),
);

export function isEvaluationContext(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  const purpose = context.purpose;
  return (
    context.schemaVersion === "ValidationJobContextV2" ||
    (purpose !== null &&
      typeof purpose === "object" &&
      !Array.isArray(purpose) &&
      (purpose as Record<string, unknown>).kind === "evaluation")
  );
}

export function validateProfileEnvelope(envelope: JobExecutionEnvelopeV2): void {
  registerWorkerContractFormats();
  if (!Value.Check(JobExecutionEnvelopeV2Schema, envelope)) throw new Error("Invalid V2 envelope.");
  const evaluation = envelope.validation.schemaVersion === "ValidationJobContextV2";
  if (evaluation) validateEvaluationProfileBinding(envelope);
  validateReproductionEnvelope(envelope);
  if (Buffer.byteLength(envelope.prompt.renderedPrompt, "utf8") > maximumRenderedPromptUtf8Bytes)
    throw new Error("Rendered prompt exceeded its byte limit.");
  const context = envelope.validation;
  const profile = context.profileVersion;
  const snapshot = envelope.resource.canonicalSnapshot;
  if (
    !Value.Check(GitHubWorkItemSchema, snapshot) ||
    snapshot.kind !== envelope.resource.kind ||
    snapshot.githubRepositoryId !== envelope.repository.githubRepositoryId ||
    snapshot.githubNodeId !== envelope.resource.githubNodeId ||
    snapshot.number !== envelope.resource.number ||
    envelope.job.jobId !== envelope.lease.jobId ||
    profile.repositoryId !== context.repositoryId ||
    profile.workflowKind !== context.workflowKind ||
    profile.target !== context.target ||
    (profile.required && !context.required) ||
    getValidationProfileConfigIssues(profile.config, profile.workflowKind, profile.target).length >
      0 ||
    createCanonicalResult(profile.config).sha256 !== profile.configSha256 ||
    envelope.executionPolicy.hardTimeoutMs !== profile.config.hardTimeoutMs ||
    envelope.executionPolicy.noProgressTimeoutMs !== profile.config.noProgressTimeoutMs ||
    envelope.prompt.name !== context.promptVersion.templateId ||
    envelope.prompt.version !== String(context.promptVersion.version) ||
    hash(envelope.prompt.renderedPrompt) !== envelope.prompt.promptSha256 ||
    createCanonicalResult(envelope.prompt.outputSchema).sha256 !==
      envelope.prompt.outputSchemaSha256 ||
    modelSchemaDigests[context.workflowKind] !== envelope.prompt.outputSchemaSha256
  )
    throw new Error("Invalid frozen validation identity.");
  const pr = envelope.resource.kind === "pull_request";
  if (
    envelope.job.kind !== (pr ? "pull_request_review" : "issue_triage") ||
    (context.workflowKind === "pr_ui" || context.workflowKind === "pr_static_build") !== pr
  )
    throw new Error("Workflow kind mismatch.");
  const expected = context.required
    ? [...profile.config.build, ...profile.config.test, ...(profile.config.ui?.scenarios ?? [])]
        .filter((step) => step.required)
        .map((step) => `${profile.id}:${step.id}`)
        .sort()
    : [];
  if (JSON.stringify(expected) !== JSON.stringify([...context.requiredCheckIds].sort()))
    throw new Error("Required check identities changed.");
  const tested = context.testedSourceRevision;
  if (envelope.resource.kind === "pull_request") {
    if (
      tested?.kind !== "pull_request" ||
      tested.baseSha !== envelope.resource.baseSha ||
      tested.headSha !== envelope.resource.headSha ||
      context.revisionKey !== hash(`${tested.baseSha}\0${tested.headSha}`)
    )
      throw new Error("PR revision mismatch.");
  } else {
    if (context.revisionKey !== envelope.resource.revisionDigest)
      throw new Error("Issue revision mismatch.");
    if (context.workflowKind === "issue_validation" && !evaluation) {
      const authorization = context.testedSourceAuthorization;
      if (
        tested?.kind !== "commit" ||
        authorization === null ||
        authorization.headSha !== tested.headSha ||
        authorization.activationId !== context.activationId ||
        authorization.githubRepositoryId !== snapshot.githubRepositoryId ||
        authorization.githubWorkItemId !== snapshot.githubWorkItemId ||
        authorization.issueRevisionKey !== context.revisionKey
      )
        throw new Error("Issue source authorization mismatch.");
    }
  }
}

/** Validates frozen data only; execution readiness and current lease authority remain separate. */
function validateEvaluationProfileBinding(envelope: JobExecutionEnvelopeV2): void {
  const context = envelope.validation;
  if (context.schemaVersion !== "ValidationJobContextV2")
    throw new Error("Invalid evaluation validation context.");
  if (getEvaluationValidationJobContextIssues(context).length > 0)
    throw new Error("Invalid frozen evaluation authority or context.");
  assertEvaluationModelRuntimeRegistrationIntegrity(
    context.modelRequirements,
    context.modelRuntimeRegistration,
  );
  const source = context.source;
  const item = source.workItem;
  const revision = source.revision;
  const revisionKey = hash(
    revision.kind === "pull_request"
      ? `${revision.baseSha}\0${revision.headSha}`
      : JSON.stringify([item.title, item.body, item.state, item.updatedAt]),
  );
  const commonResource = {
    githubNodeId: item.githubNodeId,
    number: item.number,
    title: item.title,
    author: item.author,
    canonicalSnapshot: item,
  };
  const resource =
    item.kind === "pull_request" && revision.kind === "pull_request"
      ? {
          ...commonResource,
          kind: "pull_request",
          baseSha: revision.baseSha,
          headSha: revision.headSha,
          isDraft: item.isDraft,
        }
      : { ...commonResource, kind: "issue", revisionDigest: revision.revisionKey };
  const sourceDigest = createCanonicalResult({
    repository: source.repository,
    workItemId: source.workItemId,
    workItem: item,
    revision,
    testedSourceRevision: source.testedSourceRevision,
    revisionId: source.revisionId,
  }).sha256;
  const tested = source.testedSourceRevision;
  const commits =
    tested === null
      ? []
      : tested.kind === "pull_request"
        ? [tested.baseSha, tested.headSha]
        : [tested.headSha];
  const labels = envelope.executionPolicy.requiredCapabilityLabels;
  const requiredLabels = getReviewRunExecutorCapabilityLabels(context, context);
  if (
    sourceDigest !== source.sourceDigest ||
    revisionKey !== revision.revisionKey ||
    (revision.kind === "issue" && revision.contentDigest !== revisionKey) ||
    commits.some((commit) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/u.test(commit)) ||
    createCanonicalResult(envelope.repository).json !==
      createCanonicalResult({
        githubRepositoryId: source.repository.githubRepositoryId,
        fullName: source.repository.fullName,
      }).json ||
    createCanonicalResult(envelope.resource).json !== createCanonicalResult(resource).json ||
    envelope.executionPolicy.allowedRecipeIds.length !== 0 ||
    Object.entries(requiredLabels).some(([name, version]) => labels[name] !== version) ||
    !envelope.prompt.renderedPrompt.isWellFormed()
  )
    throw new Error(
      "The evaluation envelope differs from its frozen source or protocol requirements.",
    );
}
