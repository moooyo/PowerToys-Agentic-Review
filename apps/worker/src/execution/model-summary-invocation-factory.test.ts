import { createHash } from "node:crypto";
import {
  composeSummaryPrompt,
  createCanonicalResult,
  createValidationSummaryContext,
} from "@agentic-review/codex";
import type {
  FreezeValidationSummaryInputRequest,
  FreezeValidationSummaryInputResponse,
  FrozenValidationSummaryInputV1,
  ValidationSummaryContextV1,
} from "@agentic-review/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobExecutionContext } from "./job-executor.js";
import { modelArtifactEvaluationFixture } from "./model-output-artifact.testing.js";
import { describeModelResponseRelayPolicy } from "./model-response-relay.js";
import { createSummaryModelInvocationFactory } from "./model-summary-invocation-factory.js";

const coordinator = vi.hoisted(() => vi.fn());
vi.mock("./model-invocation-coordinator.js", () => ({ createModelInvocationSession: coordinator }));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const { envelope } = modelArtifactEvaluationFixture("issue");
  const registration = envelope.validation.modelRuntimeRegistration;
  if (!registration) throw new Error("Missing synthetic runtime.");
  const endpoint = "https://provider.invalid/v1/responses";
  registration.identity.endpointSha256 = hash(endpoint);
  registration.identity.relay.policySha256 = describeModelResponseRelayPolicy().sha256;
  registration.identitySha256 = createCanonicalResult(registration.identity).sha256;
  envelope.validation.modelRequirements.expectedModelIdentityDigest = registration.identitySha256;
  const runtimeReference = envelope.validation.modelRequirements.runtimeRegistration;
  if (!runtimeReference) throw new Error("Missing synthetic runtime reference.");
  runtimeReference.registrationSha256 = createCanonicalResult(registration).sha256;
  const { schemaVersion: _version, modelId: _model, ...runtime } = registration.identity;
  const value = createValidationSummaryContext({
    envelope,
    runnerReport: {
      schemaVersion: "ValidationReportV1",
      workItemKind: "issue",
      source: "worker",
      summary: "No synthetic checks were registered.",
      sourceState: "original",
      reproductionConclusion: "inconclusive",
      checks: [],
    },
    runnerExecution: { blockers: [], diagnostics: [], cleanupState: "completed" },
    evidenceContext: { assets: [], scenarios: [] },
  });
  const summaryContext = JSON.parse(value.json) as ValidationSummaryContextV1;
  const signal = new AbortController().signal;
  const context = { signal, attemptSignal: signal } as JobExecutionContext;
  function receipt(
    request: FreezeValidationSummaryInputRequest,
  ): FreezeValidationSummaryInputResponse {
    const frozenAt = "2026-09-08T00:00:11.000Z";
    const canonical = createCanonicalResult(request.context);
    const document: FrozenValidationSummaryInputV1 = {
      schemaVersion: "FrozenValidationSummaryInputV1",
      inputId: request.inputId,
      repositoryId: envelope.validation.repositoryId,
      evaluationId: envelope.validation.purpose.evaluationId,
      cellId: envelope.validation.purpose.cellId,
      authorizationId: envelope.validation.authorization.id,
      executionManifestSha256: envelope.validation.purpose.executionManifestSha256,
      workerNodeId: envelope.lease.workerNodeId,
      workerInstanceId: envelope.lease.workerInstanceId,
      leaseGeneration: envelope.lease.leaseGeneration,
      sourcePromptSha256: envelope.prompt.promptSha256,
      outputSchemaSha256: envelope.prompt.outputSchemaSha256,
      contextSha256: canonical.sha256,
      actualPromptSha256: hash(
        composeSummaryPrompt(envelope.prompt.renderedPrompt, canonical.json),
      ),
      context: structuredClone(request.context),
      frozenAt,
    };
    return {
      schemaVersion: "FreezeValidationSummaryInputResponseV1",
      frozenAt,
      reference: {
        schemaVersion: "ValidationSummaryInputReferenceV1",
        inputId: request.inputId,
        inputSha256: createCanonicalResult(document).sha256,
        sourcePromptSha256: document.sourcePromptSha256,
        outputSchemaSha256: document.outputSchemaSha256,
        contextSha256: document.contextSha256,
        actualPromptSha256: document.actualPromptSha256,
      },
    };
  }
  const freezeValidationSummaryInput = vi.fn(async (request: FreezeValidationSummaryInputRequest) =>
    receipt(request),
  );
  const api = {
    beginModelInvocation: vi.fn(),
    sealModelInvocation: vi.fn(),
    submitModelInvocationReceipts: vi.fn(),
  };
  const authorize = vi.fn();
  const factory = createSummaryModelInvocationFactory(
    { api, runtime, endpoint, authorize },
    { freezeValidationSummaryInput },
  );
  return {
    envelope,
    context,
    summaryContext,
    receipt,
    freezeValidationSummaryInput,
    api,
    authorize,
    factory,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T00:00:10.000Z"));
  coordinator.mockReset().mockResolvedValue({ syntheticSession: true });
});
afterEach(() => vi.useRealTimers());

describe("frozen summary invocation factory", () => {
  it("freezes one input, binds both Prompt identities, and defers model opening until requested", async () => {
    const f = fixture();
    const pending = f.factory(f.envelope, f.context, f.summaryContext);
    expect(f.factory(f.envelope, f.context, f.summaryContext)).toBe(pending);
    const prepared = await pending;
    expect(f.freezeValidationSummaryInput).toHaveBeenCalledTimes(1);
    expect(prepared.expectedScope.schemaVersion).toBe("ModelInvocationScopeV2");
    if (prepared.expectedScope.schemaVersion !== "ModelInvocationScopeV2")
      throw new Error("Expected V2.");
    expect(prepared.expectedScope.promptSha256).toBe(f.envelope.prompt.promptSha256);
    expect(prepared.expectedScope.inputRef.actualPromptSha256).toBe(
      hash(
        composeSummaryPrompt(
          f.envelope.prompt.renderedPrompt,
          createCanonicalResult(f.summaryContext).json,
        ),
      ),
    );
    expect(prepared.expectedScope.inputRef.actualPromptSha256).not.toBe(
      prepared.expectedScope.promptSha256,
    );
    expect(coordinator).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
    await prepared.open();
    await prepared.open();
    expect(coordinator).toHaveBeenCalledTimes(1);
    expect(coordinator.mock.calls[0]?.[0].expectedScope).toEqual(prepared.expectedScope);
  });
  it.each([
    "inputSha256",
    "sourcePromptSha256",
    "outputSchemaSha256",
    "contextSha256",
    "actualPromptSha256",
  ] as const)("rejects a changed %s before opening", async (field) => {
    const f = fixture();
    f.freezeValidationSummaryInput.mockImplementation(async (request) => {
      const value = f.receipt(request);
      value.reference[field] = "0".repeat(64);
      return value;
    });
    await expect(f.factory(f.envelope, f.context, f.summaryContext)).rejects.toMatchObject({
      code: "INPUT_RECEIPT_MISMATCH",
    });
    expect(coordinator).not.toHaveBeenCalled();
  });
  it("retains an uncertain freeze failure and never silently creates another input", async () => {
    const f = fixture();
    f.freezeValidationSummaryInput.mockRejectedValue(new Error("Synthetic response loss."));
    const first = f.factory(f.envelope, f.context, f.summaryContext);
    await expect(first).rejects.toMatchObject({ code: "INPUT_FREEZE_FAILED" });
    expect(f.factory(f.envelope, f.context, f.summaryContext)).toBe(first);
    expect(f.freezeValidationSummaryInput).toHaveBeenCalledTimes(1);
    const changed = structuredClone(f.summaryContext);
    changed.report.summary = "Changed facts.";
    await expect(f.factory(f.envelope, f.context, changed)).rejects.toMatchObject({
      code: "ATTEMPT_CONTEXT_CHANGED",
    });
  });
  it("rejects a foreign context, missing model authorization and expired time before freezing", async () => {
    const f = fixture();
    const context = structuredClone(f.summaryContext);
    context.planDigest = "0".repeat(64);
    await expect(f.factory(f.envelope, f.context, context)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const noModel = structuredClone(f.envelope);
    noModel.validation.modelRequirements.required = false;
    await expect(f.factory(noModel, f.context, f.summaryContext)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    vi.setSystemTime(new Date("2026-09-08T02:00:00.000Z"));
    await expect(f.factory(f.envelope, f.context, f.summaryContext)).rejects.toMatchObject({
      code: "INPUT_FREEZE_FAILED",
    });
    expect(f.freezeValidationSummaryInput).not.toHaveBeenCalled();
  });
  it("snapshots the caller and API request before asynchronous mutation", async () => {
    const f = fixture();
    f.freezeValidationSummaryInput.mockImplementation(async (request) => {
      const response = f.receipt(request);
      request.context.report.summary = "API mutated its own request.";
      request.lease.jobId = "api-other-job";
      return response;
    });
    const pending = f.factory(f.envelope, f.context, f.summaryContext);
    f.summaryContext.report.summary = "Caller mutated its context.";
    const prepared = await pending;
    expect(prepared.expectedScope.jobId).toBe(f.envelope.job.jobId);
    expect(f.freezeValidationSummaryInput).toHaveBeenCalledTimes(1);
  });
});
