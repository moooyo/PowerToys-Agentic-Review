import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  createCanonicalResult,
  IssueTriageV2ModelOutputSchema,
  PrReviewPlanV2ModelOutputSchema,
  type ValidationJobResultV2,
  type ValidationJobResultV2ModelResult,
  ValidationJobResultV2ModelResultSchema,
  type ValidationModelInvocationReferenceV1,
  ValidationModelInvocationReferenceV1Schema,
} from "@agentic-review/codex";
import {
  evaluationExecutionRequiredCapabilityLabels,
  getEvaluationValidationJobContextIssues,
  getModelInvocationScopeIssues,
  getModelInvocationSubmissionIssues,
  IssueValidationSummaryV1Schema,
  type JobExecutionEnvelopeV2,
  JobExecutionEnvelopeV2Schema,
  type ModelInvocationScope,
  type ModelInvocationScopeV1,
  type ModelInvocationScopeV2,
  maximumRenderedPromptUtf8Bytes,
  maximumRunCompletionResultUtf8Bytes,
  PullRequestValidationSummaryV1Schema,
  type ReviewExecutionEvidence,
  ReviewExecutionEvidenceSchema,
  type ValidationSummaryInputReferenceV1,
  validationExecutorCapabilityLabels,
} from "@agentic-review/contracts";
import { modelInvocationScopeDigest } from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import type { JobExecutionContext } from "./job-executor.js";
import type { ModelInvocationSessionResult } from "./model-invocation-coordinator.js";
import type { PreparedModelInvocation } from "./prepared-codex-output-runner.js";

export interface ModelOutputArtifact {
  readonly result: ValidationJobResultV2ModelResult;
  readonly canonicalResultJson: string;
  readonly modelOutputSha256: string;
  /** Retained for Worker boundary checks; only the thin reference enters the completion DTO. */
  readonly scope: ModelInvocationScope;
  readonly invocation: ValidationModelInvocationReferenceV1;
  readonly executionEvidence: ReviewExecutionEvidence;
}

export type CreateModelInvocation = (
  envelope: JobExecutionEnvelopeV2,
  context: JobExecutionContext,
  summaryInput?: ValidationSummaryInputReferenceV1,
) => PreparedModelInvocation;

interface ModelOutputSource {
  readonly outcome: "succeeded";
  readonly result: unknown;
  readonly canonicalResultJson: string;
  readonly resultDigest: string;
  readonly modelInvocation?: ModelInvocationSessionResult;
}

export class ModelOutputArtifactError extends Error {
  readonly code = "MODEL_OUTPUT_ARTIFACT_INVALID";
  constructor() {
    super("The original model output does not have a valid independent invocation binding.");
    this.name = "ModelOutputArtifactError";
  }
}

function own(input: unknown, key: string, optional = false): unknown {
  if (
    input === null ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined && optional) return undefined;
  if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error();
  return descriptor.value;
}

function copy(value: unknown, parents = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string" && value.isWellFormed()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value !== "object" ||
    value === null ||
    types.isProxy(value) ||
    parents.has(value) ||
    parents.size > 64 ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    (Array.isArray(value)
      ? Object.getPrototypeOf(value) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  )
    throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors).filter(
    ([key]) => !Array.isArray(value) || key !== "length",
  );
  if (
    Array.isArray(value) &&
    (entries.length !== descriptors.length?.value ||
      entries.some(([key], index) => key !== String(index)))
  )
    throw new Error();
  parents.add(value);
  const result = entries.map(([key, descriptor]) => {
    if (!key.isWellFormed() || !descriptor.enumerable || !("value" in descriptor))
      throw new Error();
    return [key, copy(descriptor.value, parents)] as const;
  });
  parents.delete(value);
  return Array.isArray(value) ? result.map(([, child]) => child) : Object.fromEntries(result);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const hashText = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
const same = (left: unknown, right: unknown): boolean =>
  createCanonicalResult(left).json === createCanonicalResult(right).json;
const modelOutputSchemas = {
  pr_static_build: PrReviewPlanV2ModelOutputSchema,
  issue_triage: IssueTriageV2ModelOutputSchema,
  pr_ui: PullRequestValidationSummaryV1Schema,
  issue_validation: IssueValidationSummaryV1Schema,
};

/** Rechecks data carried by the authenticated envelope; persisted manifests, current authority
 * and actual runtime acceptance remain independent Server responsibilities. */
function captureEvaluationEnvelope(value: unknown) {
  const envelope = copy(value);
  registerWorkerContractFormats();
  if (
    !Value.Check(JobExecutionEnvelopeV2Schema, envelope) ||
    envelope.validation.schemaVersion !== "ValidationJobContextV2" ||
    getEvaluationValidationJobContextIssues(envelope.validation).length > 0
  )
    throw new Error();
  const context = envelope.validation;
  const source = context.source;
  const item = source.workItem;
  const revision = source.revision;
  const registration = context.modelRuntimeRegistration;
  const reference = context.modelRequirements.runtimeRegistration;
  if (
    !context.modelRequirements.required ||
    registration === undefined ||
    reference === undefined ||
    createCanonicalResult(registration).sha256 !== reference.registrationSha256 ||
    createCanonicalResult(registration.identity).sha256 !== registration.identitySha256
  )
    throw new Error();
  const revisionKey = hashText(
    revision.kind === "pull_request"
      ? `${revision.baseSha}\0${revision.headSha}`
      : JSON.stringify([item.title, item.body, item.state, item.updatedAt]),
  );
  const common = {
    githubNodeId: item.githubNodeId,
    number: item.number,
    title: item.title,
    author: item.author,
    canonicalSnapshot: item,
  };
  const resource =
    item.kind === "pull_request" && revision.kind === "pull_request"
      ? {
          ...common,
          kind: "pull_request",
          baseSha: revision.baseSha,
          headSha: revision.headSha,
          isDraft: item.isDraft,
        }
      : { ...common, kind: "issue", revisionDigest: revision.revisionKey };
  const labels = envelope.executionPolicy.requiredCapabilityLabels;
  const requiredLabels: Record<string, string> = {
    ...evaluationExecutionRequiredCapabilityLabels,
    [validationExecutorCapabilityLabels.envelope]: "2",
    [validationExecutorCapabilityLabels[context.target]]: "1",
  };
  if (context.reproduction !== undefined)
    requiredLabels[validationExecutorCapabilityLabels.reproduction] = "1";
  if (context.profileVersion.config.test.some((step) => step.probeOutput !== undefined))
    requiredLabels[validationExecutorCapabilityLabels.probes] = "1";
  if (
    context.reproduction?.binding.cases.some((entry) => entry.target !== "headless") ||
    (context.profileVersion.config.ui?.target === "web" &&
      context.profileVersion.config.ui.evidence.trace === "off")
  )
    requiredLabels[validationExecutorCapabilityLabels.uiObservations] = "1";
  const schema = createCanonicalResult(
    JSON.parse(JSON.stringify(modelOutputSchemas[context.workflowKind])),
  );
  const tested = source.testedSourceRevision;
  const commits =
    tested === null
      ? []
      : tested.kind === "pull_request"
        ? [tested.baseSha, tested.headSha]
        : [tested.headSha];
  if (
    createCanonicalResult({
      repository: source.repository,
      workItemId: source.workItemId,
      workItem: item,
      revision,
      testedSourceRevision: source.testedSourceRevision,
      revisionId: source.revisionId,
    }).sha256 !== source.sourceDigest ||
    revisionKey !== revision.revisionKey ||
    (revision.kind === "issue" && revision.contentDigest !== revisionKey) ||
    commits.some((commit) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/u.test(commit)) ||
    !same(envelope.repository, {
      githubRepositoryId: source.repository.githubRepositoryId,
      fullName: source.repository.fullName,
    }) ||
    !same(envelope.resource, resource) ||
    envelope.job.jobId !== envelope.lease.jobId ||
    envelope.job.kind !== (item.kind === "pull_request" ? "pull_request_review" : "issue_triage") ||
    createCanonicalResult(context.profileVersion.config).sha256 !==
      context.profileVersion.configSha256 ||
    !same(envelope.executionPolicy, {
      hardTimeoutMs: context.profileVersion.config.hardTimeoutMs,
      noProgressTimeoutMs: context.profileVersion.config.noProgressTimeoutMs,
      allowedRecipeIds: [],
      requiredCapabilityLabels: labels,
    }) ||
    Object.entries(requiredLabels).some(([label, version]) => labels[label] !== version) ||
    envelope.prompt.name !== context.promptVersion.templateId ||
    envelope.prompt.version !== String(context.promptVersion.version) ||
    Buffer.byteLength(envelope.prompt.renderedPrompt, "utf8") > maximumRenderedPromptUtf8Bytes ||
    hashText(envelope.prompt.renderedPrompt) !== envelope.prompt.promptSha256 ||
    schema.json !== createCanonicalResult(envelope.prompt.outputSchema).json ||
    schema.sha256 !== envelope.prompt.outputSchemaSha256
  )
    throw new Error();
  return { envelope, context, registration };
}

function checkedArtifact(value: unknown): ModelOutputArtifact {
  const artifact = copy(value) as ModelOutputArtifact;
  const keys = Object.keys(artifact).sort().join(",");
  if (
    keys !== "canonicalResultJson,executionEvidence,invocation,modelOutputSha256,result,scope" ||
    typeof artifact.canonicalResultJson !== "string" ||
    getModelInvocationScopeIssues(artifact.scope).length > 0 ||
    !Value.Check(ValidationJobResultV2ModelResultSchema, artifact.result) ||
    !Value.Check(ValidationModelInvocationReferenceV1Schema, artifact.invocation) ||
    !Value.Check(ReviewExecutionEvidenceSchema, artifact.executionEvidence) ||
    (artifact.executionEvidence.worktree.status === "unknown") !==
      (artifact.executionEvidence.worktree.source === "not_observed")
  )
    throw new Error();
  const canonical = createCanonicalResult(artifact.result);
  if (
    canonical.json !== artifact.canonicalResultJson ||
    canonical.sha256 !== artifact.modelOutputSha256 ||
    canonical.sha256 !== artifact.invocation.modelOutputSha256 ||
    artifact.invocation.invocationId !== artifact.scope.invocationId ||
    artifact.invocation.scopeSha256 !== modelInvocationScopeDigest(artifact.scope) ||
    Buffer.byteLength(createCanonicalResult(modelOutputReview(artifact)).json, "utf8") >
      maximumRunCompletionResultUtf8Bytes
  )
    throw new Error();
  return freeze(artifact);
}

export function modelOutputReview(artifact: ModelOutputArtifact) {
  return {
    state: "completed" as const,
    result: artifact.result,
    invocation: artifact.invocation,
    executionEvidence: artifact.executionEvidence,
  } as Extract<ValidationJobResultV2["modelReview"], { state: "completed" }>;
}

/** Derives invocation authority only from the complete authenticated frozen evaluation envelope. */
export function createModelInvocationScope(
  envelope: JobExecutionEnvelopeV2,
  invocationId: string,
): ModelInvocationScopeV1 {
  try {
    const captured = captureEvaluationEnvelope(envelope);
    const { context, registration } = captured;
    const frozen = captured.envelope;
    const scope: ModelInvocationScopeV1 = {
      schemaVersion: "ModelInvocationScopeV1",
      repositoryId: context.repositoryId,
      evaluationId: context.purpose.evaluationId,
      cellId: context.purpose.cellId,
      runId: context.runId,
      requestId: context.requestId,
      jobId: frozen.lease.jobId,
      attemptId: frozen.lease.runAttemptId,
      invocationId,
      authorizationId: context.authorization.id,
      executionManifestSha256: context.purpose.executionManifestSha256,
      promptSha256: frozen.prompt.promptSha256,
      outputSchemaSha256: frozen.prompt.outputSchemaSha256,
      expectedModelIdentitySha256: registration.identitySha256,
      requestedModel: registration.requestedModel,
      workerNodeId: frozen.lease.workerNodeId,
      workerInstanceId: frozen.lease.workerInstanceId,
      leaseGeneration: frozen.lease.leaseGeneration,
    };
    if (getModelInvocationScopeIssues(scope).length > 0) throw new Error();
    return freeze(scope);
  } catch {
    throw new ModelOutputArtifactError();
  }
}

export function createSummaryModelInvocationScope(
  envelope: JobExecutionEnvelopeV2,
  invocationId: string,
  inputRef: ValidationSummaryInputReferenceV1,
): ModelInvocationScopeV2 {
  try {
    const original = createModelInvocationScope(envelope, invocationId);
    if (!["pr_ui", "issue_validation"].includes(envelope.validation.workflowKind))
      throw new Error();
    const scope: ModelInvocationScopeV2 = {
      ...original,
      schemaVersion: "ModelInvocationScopeV2",
      purpose: "validation_summary",
      inputRef: copy(inputRef) as ValidationSummaryInputReferenceV1,
    };
    if (getModelInvocationScopeIssues(scope).length) throw new Error();
    return freeze(scope);
  } catch {
    throw new ModelOutputArtifactError();
  }
}

function containsSensitive(input: unknown, sensitive: readonly string[]): boolean {
  const pending: unknown[] = [input];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) pending.push(key, child);
    } else {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (
        text !== undefined &&
        sensitive.some((secret) => secret.length > 0 && text.includes(secret))
      )
        return true;
    }
  }
  return false;
}

/** Captures the original validated result before any display redaction or enrichment. */
export function createModelOutputArtifact(input: {
  readonly output: ModelOutputSource;
  readonly executionEvidence: ReviewExecutionEvidence;
  readonly expectedScope: ModelInvocationScope;
  readonly sensitiveValues?: readonly string[];
}): ModelOutputArtifact {
  try {
    const source = own(input, "output");
    if (own(source, "outcome") !== "succeeded") throw new Error();
    const result = copy(own(source, "result"));
    const canonicalResultJson = own(source, "canonicalResultJson");
    const modelOutputSha256 = own(source, "resultDigest");
    const recording = copy(own(source, "modelInvocation")) as ModelInvocationSessionResult;
    const scope = copy(own(input, "expectedScope")) as ModelInvocationScope;
    const sensitive = copy(own(input, "sensitiveValues", true) ?? []) as string[];
    if (
      !Array.isArray(sensitive) ||
      sensitive.some((secret) => typeof secret !== "string") ||
      recording.executionAccepted !== false ||
      recording.modelOutputBound !== true ||
      getModelInvocationSubmissionIssues(recording.submission).length > 0 ||
      recording.submission.consistency.state !== "matched" ||
      recording.submission.consistency.observedIdentitySha256 !== scope.expectedModelIdentitySha256
    )
      throw new Error();
    const artifact = checkedArtifact({
      result,
      canonicalResultJson,
      modelOutputSha256,
      scope,
      executionEvidence: own(input, "executionEvidence"),
      invocation: {
        invocationId: recording.submission.invocationId,
        scopeSha256: recording.submission.scopeSha256,
        receiptSetSha256: recording.submission.receiptSetSha256,
        modelOutputSha256,
      },
    });
    if (containsSensitive(modelOutputReview(artifact), sensitive)) throw new Error();
    return artifact;
  } catch {
    throw new ModelOutputArtifactError();
  }
}

/** Binds a parent configuration to its active envelope before opening a collector. */
export function captureModelInvocationScope(
  value: unknown,
  envelope: JobExecutionEnvelopeV2,
  actualPromptSha256?: string,
  summaryContextSha256?: string,
): ModelInvocationScope {
  try {
    const scope = copy(value) as ModelInvocationScope;
    const captured = captureEvaluationEnvelope(envelope);
    envelope = captured.envelope;
    const { context, registration } = captured;
    const promptSha256 = actualPromptSha256 ?? envelope.prompt.promptSha256;
    if (
      getModelInvocationScopeIssues(scope).length > 0 ||
      (scope.schemaVersion === "ModelInvocationScopeV2"
        ? !["pr_ui", "issue_validation"].includes(context.workflowKind) ||
          actualPromptSha256 === undefined ||
          summaryContextSha256 === undefined ||
          scope.inputRef.actualPromptSha256 !== promptSha256 ||
          scope.inputRef.contextSha256 !== summaryContextSha256
        : promptSha256 !== envelope.prompt.promptSha256 || summaryContextSha256 !== undefined) ||
      scope.evaluationId !== context.purpose.evaluationId ||
      scope.cellId !== context.purpose.cellId ||
      scope.authorizationId !== context.authorization.id ||
      scope.executionManifestSha256 !== context.purpose.executionManifestSha256 ||
      scope.expectedModelIdentitySha256 !== registration.identitySha256 ||
      scope.requestedModel !== registration.requestedModel ||
      scope.repositoryId !== envelope.validation.repositoryId ||
      scope.runId !== envelope.validation.runId ||
      scope.requestId !== envelope.validation.requestId ||
      scope.jobId !== envelope.lease.jobId ||
      scope.attemptId !== envelope.lease.runAttemptId ||
      scope.workerNodeId !== envelope.lease.workerNodeId ||
      scope.workerInstanceId !== envelope.lease.workerInstanceId ||
      scope.leaseGeneration !== envelope.lease.leaseGeneration ||
      scope.promptSha256 !== envelope.prompt.promptSha256 ||
      scope.outputSchemaSha256 !== envelope.prompt.outputSchemaSha256
    )
      throw new Error();
    return freeze(scope);
  } catch {
    throw new ModelOutputArtifactError();
  }
}

/** Checks Worker handoffs; the Server independently resolves the sealed invocation reference. */
export function assertModelOutputArtifact(
  value: unknown,
  envelope: JobExecutionEnvelopeV2,
  actualPromptSha256?: string,
  summaryContextSha256?: string,
): ModelOutputArtifact {
  try {
    const artifact = checkedArtifact(value);
    envelope = copy(envelope) as JobExecutionEnvelopeV2;
    if (containsSensitive(modelOutputReview(artifact), [envelope.lease.leaseToken]))
      throw new Error();
    captureModelInvocationScope(artifact.scope, envelope, actualPromptSha256, summaryContextSha256);
    const workflow = envelope.validation.workflowKind;
    const raw = artifact.result;
    if (
      (workflow === "pr_static_build" && raw.schemaVersion !== "PrReviewPlanV2") ||
      (workflow === "issue_triage" && raw.schemaVersion !== "IssueTriageV2") ||
      ((workflow === "pr_ui" || workflow === "issue_validation") &&
        (raw.schemaVersion !== "ValidationSummaryV1" ||
          raw.workItemKind !== envelope.resource.kind))
    )
      throw new Error();
    return artifact;
  } catch {
    throw new ModelOutputArtifactError();
  }
}
