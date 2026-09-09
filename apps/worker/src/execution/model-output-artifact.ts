import {
  createCanonicalResult,
  type ValidationJobResultV2,
  type ValidationJobResultV2ModelResult,
  ValidationJobResultV2ModelResultSchema,
} from "@agentic-review/codex";
import {
  type CliModelExecutionV1,
  CliModelExecutionV1Schema,
  type JobExecutionEnvelopeV2,
  maximumRunCompletionResultUtf8Bytes,
  type ReviewExecutionEvidence,
  ReviewExecutionEvidenceSchema,
  type ValidationSummaryInputReferenceV1,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import type { CliExecutionObservation } from "./prepared-cli-output-runner.js";
import { validateProfileEnvelope } from "./profile-envelope.js";

export interface ModelOutputArtifact {
  readonly result: ValidationJobResultV2ModelResult;
  readonly canonicalResultJson: string;
  readonly modelOutputSha256: string;
  readonly execution: CliModelExecutionV1;
  readonly executionEvidence: ReviewExecutionEvidence;
}
interface ModelOutputSource {
  readonly outcome: "succeeded";
  readonly result: unknown;
  readonly canonicalResultJson: string;
  readonly resultDigest: string;
  readonly cliExecution: CliExecutionObservation;
}
export class ModelOutputArtifactError extends Error {
  readonly code = "MODEL_OUTPUT_ARTIFACT_INVALID";
  constructor() {
    super("The CLI output does not match its task, prompt, schema, or output digest.");
    this.name = "ModelOutputArtifactError";
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function checkedArtifact(input: unknown): ModelOutputArtifact {
  registerWorkerContractFormats();
  const artifact = structuredClone(input) as ModelOutputArtifact;
  if (
    artifact === null ||
    typeof artifact !== "object" ||
    Object.keys(artifact).sort().join(",") !==
      "canonicalResultJson,execution,executionEvidence,modelOutputSha256,result" ||
    !Value.Check(ValidationJobResultV2ModelResultSchema, artifact.result) ||
    !Value.Check(CliModelExecutionV1Schema, artifact.execution) ||
    !Value.Check(ReviewExecutionEvidenceSchema, artifact.executionEvidence)
  )
    throw new Error();
  const canonical = createCanonicalResult(artifact.result);
  if (
    canonical.json !== artifact.canonicalResultJson ||
    canonical.sha256 !== artifact.modelOutputSha256 ||
    canonical.sha256 !== artifact.execution.outputSha256 ||
    (artifact.executionEvidence.worktree.status === "unknown") !==
      (artifact.executionEvidence.worktree.source === "not_observed") ||
    Buffer.byteLength(createCanonicalResult(modelOutputReview(artifact)).json, "utf8") >
      maximumRunCompletionResultUtf8Bytes
  )
    throw new Error();
  return freeze(artifact);
}
export function modelOutputReview(
  artifact: ModelOutputArtifact,
): Extract<ValidationJobResultV2["modelReview"], { state: "completed" }> {
  return {
    state: "completed",
    result: artifact.result,
    execution: artifact.execution,
    executionEvidence: artifact.executionEvidence,
  } as Extract<ValidationJobResultV2["modelReview"], { state: "completed" }>;
}
/** Retains ordinary CLI output attribution without a separate provider or receipt service. */
export function createModelOutputArtifact(input: {
  readonly output: ModelOutputSource;
  readonly executionEvidence: ReviewExecutionEvidence;
  readonly envelope: JobExecutionEnvelopeV2;
  readonly summaryInputRef?: ValidationSummaryInputReferenceV1;
  readonly sensitiveValues?: readonly string[];
}): ModelOutputArtifact {
  try {
    const output = structuredClone(input.output);
    if (
      output.outcome !== "succeeded" ||
      output.cliExecution.modelOutputSha256 !== output.resultDigest ||
      output.cliExecution.outputSchemaSha256 !== input.envelope.prompt.outputSchemaSha256
    )
      throw new Error();
    const artifact = checkedArtifact({
      result: output.result,
      canonicalResultJson: output.canonicalResultJson,
      modelOutputSha256: output.resultDigest,
      executionEvidence: input.executionEvidence,
      execution: {
        schemaVersion: "CliModelExecutionV1",
        jobId: input.envelope.job.jobId,
        runAttemptId: input.envelope.lease.runAttemptId,
        cli: {
          kind: output.cliExecution.engine,
          version: output.cliExecution.cliVersion,
          requestedModel: output.cliExecution.requestedModel,
        },
        promptSha256: output.cliExecution.promptSha256,
        outputSchemaSha256: output.cliExecution.outputSchemaSha256,
        outputSha256: output.resultDigest,
        exitCode: 0,
        ...(input.summaryInputRef === undefined ? {} : { summaryInputRef: input.summaryInputRef }),
      },
    });
    if (containsSensitive(artifact.result, input.sensitiveValues ?? [])) throw new Error();
    return assertModelOutputArtifact(
      artifact,
      input.envelope,
      input.summaryInputRef?.actualPromptSha256,
      input.summaryInputRef?.contextSha256,
    );
  } catch {
    throw new ModelOutputArtifactError();
  }
}
/** Checks in-process handoffs; the Server checks the same task and digest association. */
export function assertModelOutputArtifact(
  value: unknown,
  envelope: JobExecutionEnvelopeV2,
  actualPromptSha256?: string,
  summaryContextSha256?: string,
): ModelOutputArtifact {
  try {
    validateProfileEnvelope(envelope);
    const artifact = checkedArtifact(value);
    const execution = artifact.execution;
    const summary = ["pr_ui", "issue_validation"].includes(envelope.validation.workflowKind);
    if (
      execution.jobId !== envelope.job.jobId ||
      execution.jobId !== envelope.lease.jobId ||
      execution.runAttemptId !== envelope.lease.runAttemptId ||
      execution.outputSchemaSha256 !== envelope.prompt.outputSchemaSha256 ||
      execution.promptSha256 !== (actualPromptSha256 ?? envelope.prompt.promptSha256) ||
      containsSensitive(modelOutputReview(artifact), [envelope.lease.leaseToken])
    )
      throw new Error();
    if (summary) {
      const reference = execution.summaryInputRef;
      if (
        reference === undefined ||
        reference.sourcePromptSha256 !== envelope.prompt.promptSha256 ||
        reference.outputSchemaSha256 !== envelope.prompt.outputSchemaSha256 ||
        reference.actualPromptSha256 !== actualPromptSha256 ||
        reference.contextSha256 !== summaryContextSha256
      )
        throw new Error();
    } else if (
      execution.summaryInputRef !== undefined ||
      actualPromptSha256 !== undefined ||
      summaryContextSha256 !== undefined
    )
      throw new Error();
    const workflow = envelope.validation.workflowKind;
    const raw = artifact.result;
    if (
      (workflow === "pr_static_build" && raw.schemaVersion !== "PrReviewPlanV2") ||
      (workflow === "issue_triage" && raw.schemaVersion !== "IssueTriageV2") ||
      (summary &&
        (raw.schemaVersion !== "ValidationSummaryV1" ||
          raw.workItemKind !== envelope.resource.kind))
    )
      throw new Error();
    return artifact;
  } catch {
    throw new ModelOutputArtifactError();
  }
}
function containsSensitive(value: unknown, sensitive: readonly string[]): boolean {
  const values: unknown[] = [value];
  while (values.length > 0) {
    const current = values.pop();
    if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) values.push(key, child);
    } else if (sensitive.some((secret) => secret.length > 0 && String(current).includes(secret)))
      return true;
  }
  return false;
}
