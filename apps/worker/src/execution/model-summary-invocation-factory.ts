import { createHash, randomUUID } from "node:crypto";
import {
  composeSummaryPrompt,
  createCanonicalResult,
  createValidationSummaryContext,
} from "@agentic-review/codex";
import {
  type FrozenValidationSummaryInputV1,
  getFreezeValidationSummaryInputResponseIssues,
  getValidationSummaryContextIssues,
  type JobExecutionEnvelopeV2,
  type ValidationSummaryContextV1,
} from "@agentic-review/contracts";
import type { ModelSummaryInputApi } from "../server-client/model-invocation-api.js";
import type { JobExecutionContext } from "./job-executor.js";
import {
  createModelInvocationFactory,
  type ModelInvocationFactoryOptions,
} from "./model-invocation-factory.js";
import { createModelInvocationScope } from "./model-output-artifact.js";
import type { PreparedModelInvocation } from "./prepared-codex-output-runner.js";

export type CreateSummaryModelInvocation = (
  envelope: JobExecutionEnvelopeV2,
  context: JobExecutionContext,
  summaryContext: ValidationSummaryContextV1,
) => Promise<PreparedModelInvocation>;

export class ModelSummaryInvocationError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "ATTEMPT_CONTEXT_CHANGED"
      | "INPUT_FREEZE_FAILED"
      | "INPUT_RECEIPT_MISMATCH",
  ) {
    super("The summary invocation could not bind its complete frozen input.");
    this.name = "ModelSummaryInvocationError";
  }
}

/** Persists one complete input before creating the corresponding ScopeV2 invocation. */
export function createSummaryModelInvocationFactory(
  options: ModelInvocationFactoryOptions,
  inputApi: ModelSummaryInputApi,
): CreateSummaryModelInvocation {
  const createInvocation = createModelInvocationFactory(options);
  const expectedRuntimeJson = createCanonicalResult(options.runtime).json;
  if (typeof inputApi?.freezeValidationSummaryInput !== "function")
    throw new TypeError("Summary input freezing requires its parent API.");
  const freezeInput = inputApi.freezeValidationSummaryInput.bind(inputApi);
  const attempts = new WeakMap<
    AbortSignal,
    Map<
      string,
      {
        fingerprint: string;
        executionSignal: AbortSignal;
        prepared: Promise<PreparedModelInvocation>;
      }
    >
  >();
  return (input, context, suppliedContext) => {
    try {
      const executionSignal = context.signal,
        owner = context.attemptSignal ?? executionSignal;
      if (
        !(executionSignal instanceof AbortSignal) ||
        !(owner instanceof AbortSignal) ||
        executionSignal.aborted ||
        owner.aborted
      )
        throw new ModelSummaryInvocationError("INVALID_INPUT");
      const executionContext: JobExecutionContext = {
        ...context,
        signal: executionSignal,
        attemptSignal: owner,
      };
      const inputId = randomUUID();
      const base = createModelInvocationScope(input, inputId);
      const envelope = structuredClone(input);
      if (
        envelope.validation.schemaVersion !== "ValidationJobContextV2" ||
        !["pr_ui", "issue_validation"].includes(envelope.validation.workflowKind) ||
        getValidationSummaryContextIssues(suppliedContext).length
      )
        throw new ModelSummaryInvocationError("INVALID_INPUT");
      const registration = envelope.validation.modelRuntimeRegistration;
      if (registration === undefined) throw new ModelSummaryInvocationError("INVALID_INPUT");
      const {
        schemaVersion: _version,
        modelId: _model,
        ...registeredRuntime
      } = registration.identity;
      if (createCanonicalResult(registeredRuntime).json !== expectedRuntimeJson)
        throw new ModelSummaryInvocationError("INVALID_INPUT");
      const canonical = createCanonicalResult(suppliedContext);
      const summaryContext = JSON.parse(canonical.json) as ValidationSummaryContextV1;
      const reconstructed = createValidationSummaryContext({
        envelope,
        runnerReport: summaryContext.report,
        runnerExecution: summaryContext.execution,
        evidenceContext: summaryContext.evidence,
        ...(summaryContext.observationResults === undefined
          ? {}
          : { observationResults: summaryContext.observationResults }),
      });
      if (reconstructed.json !== canonical.json)
        throw new ModelSummaryInvocationError("INVALID_INPUT");
      const prompt = composeSummaryPrompt(envelope.prompt.renderedPrompt, canonical.json);
      if (Buffer.byteLength(prompt, "utf8") > 512 * 1024)
        throw new ModelSummaryInvocationError("INVALID_INPUT");
      const actualPromptSha256 = createHash("sha256").update(prompt, "utf8").digest("hex");
      const fingerprint = createCanonicalResult({ envelope, context: summaryContext }).sha256;
      const key = JSON.stringify([base.jobId, base.attemptId]);
      const owned = attempts.get(owner) ?? new Map();
      const previous = owned.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.executionSignal !== executionSignal)
          throw new ModelSummaryInvocationError("ATTEMPT_CONTEXT_CHANGED");
        return previous.prepared;
      }
      const prepared = Promise.resolve().then(async () => {
        const deadline = Math.min(
          Date.parse(envelope.executionDeadlineAt),
          Date.parse(envelope.assignedAt) + envelope.executionPolicy.hardTimeoutMs,
        );
        const remaining = deadline - Date.now();
        if (
          executionSignal.aborted ||
          owner.aborted ||
          !Number.isSafeInteger(remaining) ||
          remaining <= 0 ||
          remaining > 2 * 60 * 60 * 1000
        )
          throw new ModelSummaryInvocationError("INPUT_FREEZE_FAILED");
        const signal = AbortSignal.any([
          executionSignal,
          owner,
          AbortSignal.timeout(Math.min(10000, remaining)),
        ]);
        let receipt: Awaited<ReturnType<typeof freezeInput>>;
        try {
          receipt = await freezeInput(
            {
              lease: structuredClone(envelope.lease),
              inputId,
              context: structuredClone(summaryContext),
            },
            signal,
          );
        } catch {
          throw new ModelSummaryInvocationError("INPUT_FREEZE_FAILED");
        }
        if (signal.aborted || getFreezeValidationSummaryInputResponseIssues(receipt).length)
          throw new ModelSummaryInvocationError("INPUT_RECEIPT_MISMATCH");
        const expected: FrozenValidationSummaryInputV1 = {
          schemaVersion: "FrozenValidationSummaryInputV1",
          inputId,
          repositoryId: base.repositoryId,
          evaluationId: base.evaluationId,
          cellId: base.cellId,
          authorizationId: base.authorizationId,
          executionManifestSha256: base.executionManifestSha256,
          workerNodeId: base.workerNodeId,
          workerInstanceId: base.workerInstanceId,
          leaseGeneration: base.leaseGeneration,
          sourcePromptSha256: base.promptSha256,
          outputSchemaSha256: base.outputSchemaSha256,
          contextSha256: canonical.sha256,
          actualPromptSha256,
          context: summaryContext,
          frozenAt: receipt.frozenAt,
        };
        const reference = {
          schemaVersion: "ValidationSummaryInputReferenceV1",
          inputId,
          inputSha256: createCanonicalResult(expected).sha256,
          sourcePromptSha256: base.promptSha256,
          outputSchemaSha256: base.outputSchemaSha256,
          contextSha256: canonical.sha256,
          actualPromptSha256,
        };
        if (createCanonicalResult(receipt.reference).json !== createCanonicalResult(reference).json)
          throw new ModelSummaryInvocationError("INPUT_RECEIPT_MISMATCH");
        return createInvocation(envelope, executionContext, receipt.reference);
      });
      owned.set(key, { fingerprint, executionSignal, prepared });
      attempts.set(owner, owned);
      return prepared;
    } catch (error) {
      return Promise.reject(
        error instanceof ModelSummaryInvocationError
          ? error
          : new ModelSummaryInvocationError("INVALID_INPUT"),
      );
    }
  };
}
