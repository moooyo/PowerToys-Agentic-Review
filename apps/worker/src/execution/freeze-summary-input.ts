import { createHash, randomUUID } from "node:crypto";
import {
  composeSummaryPrompt,
  createCanonicalResult,
  createValidationSummaryContext,
} from "@agentic-review/codex";
import {
  type FrozenValidationSummaryInputV1,
  getFreezeValidationSummaryInputResponseIssues,
  type JobExecutionEnvelopeV2,
  type ValidationSummaryContextV1,
  type ValidationSummaryInputReferenceV1,
} from "@agentic-review/contracts";
import type { ModelSummaryInputApi } from "../server-client/summary-input-api.js";

/** Stores the exact deterministic summary context without creating a model invocation service. */
export async function freezeSummaryInput(
  api: ModelSummaryInputApi,
  envelope: JobExecutionEnvelopeV2,
  context: ValidationSummaryContextV1,
  signal: AbortSignal,
): Promise<ValidationSummaryInputReferenceV1> {
  signal.throwIfAborted();
  envelope = structuredClone(envelope);
  context = structuredClone(context);
  if (envelope.validation.schemaVersion !== "ValidationJobContextV2")
    throw new Error("Summary input freezing requires an evaluation task.");
  const validation = envelope.validation;
  const canonical = createCanonicalResult(context);
  const reconstructed = createValidationSummaryContext({
    envelope,
    runnerReport: context.report,
    runnerExecution: context.execution,
    evidenceContext: context.evidence,
    ...(context.observationResults === undefined
      ? {}
      : { observationResults: context.observationResults }),
  });
  if (canonical.json !== reconstructed.json)
    throw new Error("The summary input is not the task's deterministic context.");
  const inputId = randomUUID();
  const prompt = composeSummaryPrompt(envelope.prompt.renderedPrompt, canonical.json);
  const actualPromptSha256 = createHash("sha256").update(prompt, "utf8").digest("hex");
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const receipt = await api.freezeValidationSummaryInput(
    { lease: structuredClone(envelope.lease), inputId, context: structuredClone(context) },
    requestSignal,
  );
  requestSignal.throwIfAborted();
  if (getFreezeValidationSummaryInputResponseIssues(receipt).length > 0)
    throw new Error("The summary input receipt is invalid.");
  const frozen: FrozenValidationSummaryInputV1 = {
    schemaVersion: "FrozenValidationSummaryInputV1",
    inputId,
    repositoryId: validation.repositoryId,
    evaluationId: validation.purpose.evaluationId,
    cellId: validation.purpose.cellId,
    authorizationId: validation.authorization.id,
    executionManifestSha256: validation.purpose.executionManifestSha256,
    workerNodeId: envelope.lease.workerNodeId,
    workerInstanceId: envelope.lease.workerInstanceId,
    leaseGeneration: envelope.lease.leaseGeneration,
    sourcePromptSha256: envelope.prompt.promptSha256,
    outputSchemaSha256: envelope.prompt.outputSchemaSha256,
    contextSha256: canonical.sha256,
    actualPromptSha256,
    context: structuredClone(context),
    frozenAt: receipt.frozenAt,
  };
  const reference: ValidationSummaryInputReferenceV1 = {
    schemaVersion: "ValidationSummaryInputReferenceV1",
    inputId,
    inputSha256: createCanonicalResult(frozen).sha256,
    sourcePromptSha256: envelope.prompt.promptSha256,
    outputSchemaSha256: envelope.prompt.outputSchemaSha256,
    contextSha256: canonical.sha256,
    actualPromptSha256,
  };
  if (createCanonicalResult(reference).json !== createCanonicalResult(receipt.reference).json)
    throw new Error("The summary input receipt does not match this task and context.");
  return structuredClone(reference);
}
