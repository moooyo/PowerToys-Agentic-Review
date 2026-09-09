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
import { afterEach, describe, expect, it, vi } from "vitest";
import { freezeSummaryInput } from "./freeze-summary-input.js";
import { modelArtifactEvaluationFixture } from "./model-output-artifact.testing.js";

const now = "2026-09-08T00:00:00.000Z";
const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
function fixture() {
  const envelope = modelArtifactEvaluationFixture("issue").envelope;
  const context = JSON.parse(
    createValidationSummaryContext({
      envelope,
      runnerReport: {
        schemaVersion: "ValidationReportV1",
        source: "worker",
        sourceState: "original",
        workItemKind: "issue",
        reproductionConclusion: "inconclusive",
        summary: "No deterministic checks were requested.",
        checks: [],
      },
      runnerExecution: { cleanupState: "not_needed", blockers: [], diagnostics: [] },
      evidenceContext: { assets: [], scenarios: [] },
    }).json,
  ) as ValidationSummaryContextV1;
  const receipt = (
    request: FreezeValidationSummaryInputRequest,
  ): FreezeValidationSummaryInputResponse => {
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
      frozenAt: now,
    };
    return {
      schemaVersion: "FreezeValidationSummaryInputResponseV1",
      frozenAt: now,
      reference: {
        schemaVersion: "ValidationSummaryInputReferenceV1",
        inputId: document.inputId,
        inputSha256: createCanonicalResult(document).sha256,
        sourcePromptSha256: document.sourcePromptSha256,
        outputSchemaSha256: document.outputSchemaSha256,
        contextSha256: document.contextSha256,
        actualPromptSha256: document.actualPromptSha256,
      },
    };
  };
  const freezeValidationSummaryInput = vi.fn(
    async (request: FreezeValidationSummaryInputRequest, _signal?: AbortSignal) => receipt(request),
  );
  const api = { freezeValidationSummaryInput };
  const controller = new AbortController();
  return { envelope, context, receipt, freezeValidationSummaryInput, api, controller };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("direct CLI summary input freezing", () => {
  it("retains the exact context digest and sends a detached request with the current lease", async () => {
    const f = fixture();
    const result = await freezeSummaryInput(f.api, f.envelope, f.context, f.controller.signal);
    const request = f.freezeValidationSummaryInput.mock.calls[0]?.[0];
    expect(request).toStrictEqual({
      inputId: result.inputId,
      lease: f.envelope.lease,
      context: f.context,
    });
    expect(request?.lease).not.toBe(f.envelope.lease);
    expect(request?.context).not.toBe(f.context);
    expect(result.contextSha256).toBe(createCanonicalResult(f.context).sha256);
    expect(result.actualPromptSha256).toBe(
      hash(
        composeSummaryPrompt(
          f.envelope.prompt.renderedPrompt,
          createCanonicalResult(f.context).json,
        ),
      ),
    );
    expect(f.freezeValidationSummaryInput).toHaveBeenCalledOnce();
  });

  it.each(["runId", "requestId", "jobId", "runAttemptId", "profileVersionId"] as const)(
    "rejects context from a different %s before storing it",
    async (field) => {
      const f = fixture();
      f.context[field] = "another-identity";
      await expect(
        freezeSummaryInput(f.api, f.envelope, f.context, f.controller.signal),
      ).rejects.toThrow("deterministic context");
      expect(f.freezeValidationSummaryInput).not.toHaveBeenCalled();
    },
  );

  it("does not start storage for an already cancelled attempt", async () => {
    const f = fixture();
    const cancelled = new Error("Synthetic cancellation.");
    f.controller.abort(cancelled);
    await expect(
      freezeSummaryInput(f.api, f.envelope, f.context, f.controller.signal),
    ).rejects.toBe(cancelled);
    expect(f.freezeValidationSummaryInput).not.toHaveBeenCalled();
  });

  it("uses the supplied context and task snapshot throughout an asynchronous storage request", async () => {
    const f = fixture();
    const pendingReceipt = Promise.withResolvers<FreezeValidationSummaryInputResponse>();
    f.freezeValidationSummaryInput.mockReturnValue(pendingReceipt.promise);
    const pending = freezeSummaryInput(f.api, f.envelope, f.context, f.controller.signal);
    const request = f.freezeValidationSummaryInput.mock.calls[0]?.[0];
    if (request === undefined) throw new Error("Expected the pending storage request.");
    const receipt = f.receipt(request);
    f.context.report.summary = "Changed by caller after dispatch.";
    f.envelope.validation.purpose.cellId = "changed-cell";
    f.envelope.lease.workerInstanceId = "changed-worker-instance";
    f.envelope.prompt.promptSha256 = "0".repeat(64);
    pendingReceipt.resolve(receipt);
    await expect(pending).resolves.toStrictEqual(receipt.reference);
  });

  it("bounds the storage request and leaves the parent attempt active", async () => {
    vi.useFakeTimers();
    const timeouts = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("Synthetic storage timeout.", "TimeoutError")),
        milliseconds,
      );
      return controller.signal;
    });
    const f = fixture();
    f.freezeValidationSummaryInput.mockImplementation(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const pending = freezeSummaryInput(f.api, f.envelope, f.context, f.controller.signal);
    const observed = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(10_000);
    await observed;
    expect(timeouts).toHaveBeenCalledWith(10_000);
    expect(f.controller.signal.aborted).toBe(false);
  });

  it("rejects malformed timestamps instead of deriving a reference from them", async () => {
    const f = fixture();
    f.freezeValidationSummaryInput.mockImplementation(async (request) => ({
      ...f.receipt(request),
      frozenAt: "not-a-time",
    }));
    await expect(
      freezeSummaryInput(f.api, f.envelope, f.context, f.controller.signal),
    ).rejects.toThrow("receipt is invalid");
  });
});
